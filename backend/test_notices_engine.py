"""
Workplace Notices rules engine (Neil, Oct 21 2026): who gets which notice,
which version is live, which posters a site needs.

Throwaway sqlite, no network. Run with: python -m unittest test_notices_engine -v
"""
import os
import tempfile
import unittest
import uuid
from datetime import date, timedelta

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import atexit  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

import notices  # noqa: E402


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


GREENS, MCD, INDIA, BARE = "co-greens", "co-mcd", "co-india", "co-bare"
S_SD, S_ESC, S_TX = "site-sd", "site-esc", "site-tx"


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.WorkplaceNotice, models.WorkplaceNoticeVersion, models.WorkplaceNoticeSite,
                  models.WorkplaceNoticeSource, models.WorkplaceNoticePerson, models.WorkplaceNoticeEvent,
                  models.NexusSetting, models.NexusEmployee, models.HrEntity, models.HrWorkSite,
                  models.HrCompanyWorkSite, models.PayrollRate, models.TimePunch):
            self.db.query(m).delete()
        self.db.add_all([
            models.HrEntity(id=GREENS, name="Greens", country="US", registered_address="25260 N Centre City Pkwy, Escondido, CA 92026"),
            models.HrEntity(id=MCD, name="MCD", country="US"),
            models.HrEntity(id=INDIA, name="Greens India", country="IN"),
            models.HrEntity(id=BARE, name="Bare Co", country="US"),
            models.HrWorkSite(id=S_SD, name="Downtown Job", address="1 Main St, San Diego, CA 92101"),
            models.HrWorkSite(id=S_ESC, name="Escondido (GSE)", address="25260 N Centre City Pkwy, Escondido, CA 92026"),
            models.HrWorkSite(id=S_TX, name="Houston Store", address="100 Main St, Houston, Texas, 77002, United States"),
            models.HrCompanyWorkSite(id=f"{GREENS}:{S_SD}", company_id=GREENS, site_id=S_SD),
            models.HrCompanyWorkSite(id=f"{GREENS}:{S_ESC}", company_id=GREENS, site_id=S_ESC),
            models.HrCompanyWorkSite(id=f"{MCD}:{S_TX}", company_id=MCD, site_id=S_TX),
            models.WorkplaceNoticeSite(site_id=S_SD, kind="jobsite"),
            models.WorkplaceNoticeSite(site_id=S_ESC, kind="office"),
            models.WorkplaceNoticeSite(site_id=S_TX, kind="storage"),
        ])
        self.sd = self._emp("sd@x.com", GREENS, S_SD)
        self.esc = self._emp("esc@x.com", GREENS, S_ESC, hourly=False)
        self.tx = self._emp("tx@x.com", MCD, S_TX)
        self.inc = self._emp("in@x.com", INDIA, "", etype="contractor")
        self.lost = self._emp("lost@x.com", BARE, "")
        self.db.commit()
        notices.ensure_catalog(self.db)
        self.db.commit()

    def _emp(self, email, company, site, hourly=True, etype="full_time"):
        e = models.NexusEmployee(id=str(uuid.uuid4()), first_name=email.split("@")[0], work_email=email,
                                 company=company, work_site_id=site, employment_type=etype, status="active",
                                 deleted_at="")
        self.db.add(e)
        self.db.add(models.PayrollRate(employee_email=email, pay_type="hourly" if hourly else "salary"))
        return e

    def ids(self, emp):
        return {n.id for n in notices.notices_for(self.db, emp)[1]}

    # ── places ────────────────────────────────────────────────────────────
    def test_city_from_address(self):
        self.assertEqual(notices.city_from_address("25260 N Centre City Pkwy, Escondido, CA 92026"), "ESCONDIDO")
        self.assertEqual(notices.city_from_address("41000 Main St, Temecula, California, 92590, United States"), "TEMECULA")
        self.assertEqual(notices.city_from_address("1 Main St, San Diego, CA 92101, USA"), "SAN DIEGO")
        self.assertEqual(notices.city_from_address("Escondido"), "")
        self.assertEqual(notices.city_from_address(""), "")

    # ── who gets what ─────────────────────────────────────────────────────
    def test_san_diego_job_site_worker(self):
        got = self.ids(self.sd)
        for want in ("manual-core", "manual-ca", "fed-flsa", "ca-mw", "ca-wo16", "ca-emergency", "sd-mw",
                     "ca-sb294", "ca-lc2810", "fed-everify"):
            self.assertIn(want, got)
        for not_want in ("fed-osha", "ca-wo4", "ca-wo5", "manual-tx", "tx-ui-payday", "in-code"):
            self.assertNotIn(not_want, got)

    def test_escondido_office_worker(self):
        got = self.ids(self.esc)
        self.assertIn("ca-wo4", got)
        self.assertNotIn("ca-wo16", got)
        self.assertNotIn("sd-mw", got)            # Escondido has no local wage notice
        self.assertNotIn("ca-lc2810", got)        # the wage notice is for hourly staff
        self.assertNotIn("ca-heat", got)          # office only

    def test_texas_worker(self):
        got = self.ids(self.tx)
        for want in ("manual-core", "manual-tx", "fed-osha", "tx-ui-payday", "tx-wpv", "tx-notice6"):
            self.assertIn(want, got)
        for not_want in ("tx-notice5", "ca-mw", "manual-ca", "sd-mw"):
            self.assertNotIn(not_want, got)

    def test_texas_non_subscriber_setting(self):
        notices.save_settings(self.db, "hr@x.com", {"txWorkersComp": "non_subscriber"})
        got = self.ids(self.tx)
        self.assertIn("tx-notice5", got)
        self.assertNotIn("tx-notice6", got)

    def test_india_contractor_gets_only_india_items(self):
        got = self.ids(self.inc)
        self.assertEqual(got, {"in-code", "in-closures", "in-posh", "in-privacy"})

    def test_us_contractor_gets_nothing(self):
        c = self._emp("uscon@x.com", GREENS, S_ESC, etype="contractor")
        self.db.commit()
        self.assertEqual(self.ids(c), set())

    def test_unknown_location_gets_federal_and_is_listed(self):
        got = self.ids(self.lost)
        self.assertIn("fed-flsa", got)
        self.assertIn("manual-core", got)
        self.assertFalse({i for i in got if i.startswith(("ca-", "tx-", "sd-"))})
        self.assertIn("lost@x.com", {p["email"] for p in notices.unplaced(self.db)})
        self.assertNotIn("sd@x.com", {p["email"] for p in notices.unplaced(self.db)})

    def test_hr_notice_location_wins(self):
        self.db.add(models.WorkplaceNoticePerson(email="lost@x.com", notice_state="CA", notice_city="San Diego"))
        self.db.commit()
        got = self.ids(self.lost)
        self.assertIn("ca-mw", got)
        self.assertIn("sd-mw", got)
        self.assertNotIn("lost@x.com", {p["email"] for p in notices.unplaced(self.db)})

    def test_site_without_kind_gets_every_wage_order(self):
        self.db.query(models.WorkplaceNoticeSite).filter(models.WorkplaceNoticeSite.site_id == S_ESC).delete()
        self.db.commit()
        got = self.ids(self.esc)
        self.assertTrue({"ca-wo4", "ca-wo5", "ca-wo16"} <= got)

    def test_headcount_thresholds_count_companies_together(self):
        self.assertNotIn("fed-eeoc", self.ids(self.sd))           # 4 US employees
        for i in range(12):
            self._emp(f"mcd{i}@x.com", MCD, S_TX)
        self.db.commit()
        self.assertIn("fed-eeoc", self.ids(self.sd))              # 16 together (Neil: count them together)
        notices.save_settings(self.db, "hr@x.com", {"countCompaniesTogether": False})
        self.assertNotIn("fed-eeoc", self.ids(self.sd))           # Greens alone has 3
        self.assertNotIn("fed-eeoc", self.ids(self.tx))           # MCD alone has 13, under 15
        self.assertEqual(notices.headcounts(self.db)[MCD], 13)
        self._emp("mcd12@x.com", MCD, S_TX)
        self._emp("mcd13@x.com", MCD, S_TX)
        self.db.commit()
        self.assertIn("fed-eeoc", self.ids(self.tx))              # 15 at MCD

    def test_e_verify_setting(self):
        self.assertIn("fed-everify", self.ids(self.sd))
        notices.save_settings(self.db, "hr@x.com", {"eVerify": False})
        self.assertNotIn("fed-everify", self.ids(self.sd))

    # ── versions ──────────────────────────────────────────────────────────
    def _ver(self, nid, number, status="approved", eff=None, major=True):
        v = models.WorkplaceNoticeVersion(id=str(uuid.uuid4()), notice_id=nid, number=number, status=status,
                                          effective_date=(eff or date.today()).isoformat(), major=major)
        self.db.add(v)
        self.db.commit()
        return v

    def test_live_and_scheduled_version(self):
        v1 = self._ver("ca-mw", 1, eff=date.today() - timedelta(days=300))
        v2 = self._ver("ca-mw", 2, eff=date.today() + timedelta(days=30))
        self._ver("ca-mw", 3, status="in_review")
        self.assertEqual(notices.live_version(self.db, "ca-mw").id, v1.id)
        self.assertEqual(notices.scheduled_version(self.db, "ca-mw").id, v2.id)
        self.assertEqual(notices.live_version(self.db, "ca-mw", on=date.today() + timedelta(days=31)).id, v2.id)

    def test_ack_baseline_skips_minor_versions(self):
        v1 = self._ver("manual-core", 1, eff=date.today() - timedelta(days=60))
        self._ver("manual-core", 2, eff=date.today() - timedelta(days=5), major=False)
        self.assertEqual(notices.ack_baseline(self.db, "manual-core").id, v1.id)
        v3 = self._ver("manual-core", 3, eff=date.today() - timedelta(days=1))
        self.assertEqual(notices.ack_baseline(self.db, "manual-core").id, v3.id)

    def test_no_version_means_none(self):
        self.assertIsNone(notices.live_version(self.db, "manual-core"))
        self.assertIsNone(notices.ack_baseline(self.db, "manual-core"))

    # ── sites, seasons ────────────────────────────────────────────────────
    def test_site_notices(self):
        sd = {n.id for n in notices.site_notices(self.db, S_SD)}
        self.assertTrue({"ca-mw", "ca-wo16", "ca-emergency", "sd-mw", "fed-flsa"} <= sd)
        self.assertFalse(sd & {"manual-core", "ca-sb294", "ca-wo4", "fed-osha", "ca-lc90"})
        tx = {n.id for n in notices.site_notices(self.db, S_TX)}
        self.assertTrue({"fed-osha", "tx-ui-payday", "tx-notice6"} <= tx)
        self.assertNotIn("ca-mw", tx)

    def test_window_and_election(self):
        self.assertTrue(notices.in_window(["02-01", "04-30"], date(2027, 3, 15)))
        self.assertFalse(notices.in_window(["02-01", "04-30"], date(2027, 5, 1)))
        self.assertTrue(notices.election_active(["2026-11-03"], date(2026, 10, 24)))
        self.assertTrue(notices.election_active(["2026-11-03"], date(2026, 11, 3)))
        self.assertFalse(notices.election_active(["2026-11-03"], date(2026, 10, 23)))
        self.assertFalse(notices.election_active(["2026-11-03"], date(2026, 11, 4)))

    # ── catalog ───────────────────────────────────────────────────────────
    def test_catalog_never_overwrites_hr_edits(self):
        n = self.db.get(models.WorkplaceNotice, "ca-mw")
        n.title = "HR renamed this"
        self.db.commit()
        self.assertEqual(notices.ensure_catalog(self.db), 0)
        self.assertEqual(self.db.get(models.WorkplaceNotice, "ca-mw").title, "HR renamed this")
        self.assertTrue(notices.settings(self.db)["hireSince"])
        self.assertEqual(self.db.get(models.WorkplaceNoticeSource, "ca-mw").url, "https://www.dir.ca.gov/iwc/MW-2026.pdf")


if __name__ == "__main__":
    unittest.main()
