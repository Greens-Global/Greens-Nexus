"""
Workplace Notices acknowledgments (Neil, Oct 21 2026; yearly round - Neil,
Oct 22): what I owe, acknowledging the live version with my typed name, a
minor version not asking again, the January round, reminders every 7 days,
the Monday manager note, and the announce pass.

Throwaway sqlite, no network (mail is stubbed). Run with:
python -m unittest test_notices_acks -v
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

from fastapi import HTTPException  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

import notices  # noqa: E402
import notices_daily  # noqa: E402
from routers import notices as rn  # noqa: E402

MAILS = []
notices_daily.mail = lambda to, subject, lines, **kw: MAILS.append((to, subject)) or ""


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


AMY, BOSS, INDIA = "amy@x.com", "boss@x.com", "ravi@x.com"
U_AMY = {"email": AMY, "level": 1}
U_RAVI = {"email": INDIA, "level": 1}


class AckTests(unittest.TestCase):
    def setUp(self):
        MAILS.clear()
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.WorkplaceNotice, models.WorkplaceNoticeVersion, models.WorkplaceNoticeDelivery,
                  models.WorkplaceNoticeEvent, models.WorkplaceNoticeSite, models.NexusSetting,
                  models.NexusNotification, models.NexusEmployee, models.HrEntity, models.HrWorkSite,
                  models.HrCompanyWorkSite, models.PayrollRate, models.HrCompanyHoliday):
            self.db.query(m).delete()
        self.db.add_all([
            models.HrEntity(id="co", name="Greens", country="US"),
            models.HrEntity(id="in", name="Greens India", country="IN"),
            models.HrWorkSite(id="s", name="Escondido (GSE)", address="25260 N Centre City Pkwy, Escondido, CA 92026"),
            models.WorkplaceNoticeSite(site_id="s", kind="office"),
            models.HrCompanyHoliday(id="h1", company_id="in", date=(date.today() + timedelta(days=5)).isoformat(), name="Diwali"),
        ])
        self.amy = models.NexusEmployee(id=str(uuid.uuid4()), first_name="Amy", last_name="Test", work_email=AMY,
                                        company="co", work_site_id="s", manager_email=BOSS, status="active",
                                        start_date="2024-01-02", deleted_at="")
        self.ravi = models.NexusEmployee(id=str(uuid.uuid4()), first_name="Ravi", last_name="Kumar", work_email=INDIA,
                                         company="in", employment_type="contractor", status="active", deleted_at="")
        self.db.add_all([self.amy, self.ravi])
        self.db.commit()
        notices.ensure_catalog(self.db)
        self.db.commit()

    def ver(self, nid, number, eff, major=True):
        v = models.WorkplaceNoticeVersion(id=f"{nid}-v{number}", notice_id=nid, number=number, status="approved",
                                          effective_date=eff.isoformat(), major=major, label=f"v{number}",
                                          files=[{"lang": "en", "path": "p", "name": "m.pdf", "sha256": f"hash{number}"}])
        self.db.add(v)
        self.db.commit()
        return v

    def owed_ids(self, emp, on=None):
        cfg = notices.settings(self.db)
        pc, ns = notices.notices_for(self.db, emp)
        acks = notices.my_acks(self.db, emp.work_email)
        nums = notices.version_numbers(self.db)
        out = {}
        for n in ns:
            st = notices.ack_state(self.db, n, pc, cfg, notices.versions_of(self.db, n.id), acks.get(n.id, []), nums, on=on)
            if st["required"] and not st["done"]:
                out[n.id] = st
        return out

    def ack(self, nid, vid, name="Amy Test", user=U_AMY):
        return rn.acknowledge(nid, rn.AckIn(version_id=vid, typed_name=name), request=None, user=user, db=self.db)

    def test_nothing_owed_until_a_version_is_live(self):
        self.assertEqual(self.owed_ids(self.amy), {})
        self.assertEqual(rn.owed_count(self.db, AMY), 0)

    def test_manual_owed_then_acknowledged(self):
        v1 = self.ver("manual-core", 1, date.today() - timedelta(days=3))
        owed = self.owed_ids(self.amy)
        self.assertIn("manual-core", owed)
        self.assertEqual(owed["manual-core"]["due"], (date.today() + timedelta(days=11)).isoformat())
        self.assertEqual(rn.owed_count(self.db, AMY), 1)
        with self.assertRaises(HTTPException) as c:        # the typed name must be theirs
            self.ack("manual-core", v1.id, name="Somebody Else")
        self.assertEqual(c.exception.status_code, 422)
        self.ack("manual-core", v1.id)
        self.assertEqual(self.owed_ids(self.amy), {})
        row = self.db.query(models.WorkplaceNoticeDelivery).filter_by(email=AMY, reason="acknowledge").one()
        self.assertEqual(row.content_hash, "hash1")
        self.assertEqual(row.typed_name, "Amy Test")

    def test_only_the_live_version_can_be_acknowledged(self):
        v1 = self.ver("manual-core", 1, date.today() - timedelta(days=30))
        self.ver("manual-core", 2, date.today() - timedelta(days=1))
        with self.assertRaises(HTTPException) as c:
            self.ack("manual-core", v1.id)
        self.assertEqual(c.exception.status_code, 409)

    def test_minor_version_does_not_ask_again_major_does(self):
        v1 = self.ver("manual-core", 1, date.today() - timedelta(days=30))
        self.ack("manual-core", v1.id)
        self.ver("manual-core", 2, date.today() - timedelta(days=1), major=False)
        self.assertNotIn("manual-core", self.owed_ids(self.amy))
        self.ver("manual-core", 3, date.today())
        self.assertEqual(self.owed_ids(self.amy)["manual-core"]["reason"], "new_version")

    def test_january_round(self):
        last_year = date(date.today().year - 1, 11, 1)
        v1 = self.ver("manual-core", 1, last_year)
        self.db.add(models.WorkplaceNoticeDelivery(id="old", notice_id="manual-core", version_id=v1.id, email=AMY,
                                                   reason="acknowledge", acknowledged_at=f"{last_year.isoformat()}T10:00:00+00:00"))
        self.db.commit()
        owed = self.owed_ids(self.amy)
        self.assertEqual(owed["manual-core"]["reason"], "yearly")
        self.assertEqual(owed["manual-core"]["due"], date(date.today().year, 2, 1).isoformat())   # Jan 1 + 31 days
        notices.save_settings(self.db, "hr@x.com", {"yearlyAck": False})
        self.assertEqual(self.owed_ids(self.amy), {})

    def test_india_contractor_owes_the_code_not_the_manual(self):
        self.ver("manual-core", 1, date.today() - timedelta(days=3))
        self.ver("in-code", 1, date.today() - timedelta(days=3))
        self.assertEqual(set(self.owed_ids(self.ravi)), {"in-code"})
        with self.assertRaises(HTTPException):          # not one of Ravi's documents
            self.ack("manual-core", "manual-core-v1", name="Ravi Kumar", user=U_RAVI)
        self.ack("in-code", "in-code-v1", name="Ravi Kumar", user=U_RAVI)
        self.assertEqual(self.owed_ids(self.ravi), {})

    def test_my_view(self):
        self.ver("manual-core", 1, date.today() - timedelta(days=3))
        self.ver("ca-mw", 1, date.today() - timedelta(days=3))
        out = rn.my_notices(user=U_AMY, db=self.db)
        self.assertTrue(out["placed"])
        self.assertEqual(out["context"]["state"], "CA")
        docs = {d["id"]: d for d in out["documents"]}
        self.assertTrue(docs["manual-core"]["ack"]["required"])
        self.assertIsNone(docs["manual-ca"]["live"])           # coming soon
        posted = {p["id"] for p in out["posted"]}
        self.assertIn("ca-mw", posted)
        self.assertNotIn("ca-sb294", posted)                   # deliver-only, not on the wall
        self.assertNotIn("ca-lc90", posted)                    # event notices stay hidden
        india = rn.my_notices(user=U_RAVI, db=self.db)
        self.assertEqual(india["posted"], [])
        self.assertEqual(rn.my_closures(user=U_RAVI, db=self.db)["days"][0]["name"], "Diwali")

    def test_view_is_recorded_once(self):
        v1 = self.ver("ca-mw", 1, date.today() - timedelta(days=3))
        rn.record_view(v1.id, user=U_AMY, db=self.db)
        rn.record_view(v1.id, user=U_AMY, db=self.db)
        self.assertEqual(self.db.query(models.WorkplaceNoticeDelivery).filter_by(email=AMY, reason="portal").count(), 1)

    # ── the daily pass ────────────────────────────────────────────────────
    def test_announce_once(self):
        self.ver("manual-core", 1, date.today())
        self.ver("ca-mw", 1, date.today())
        self.ver("ca-wo4", 1, date.today())
        notices_daily.announce(self.db)
        bells = self.db.query(models.NexusNotification).filter_by(recipient=AMY).all()
        self.assertEqual(sorted(b.type for b in bells), ["workplace_notice", "workplace_notice_ack"])   # one doc, one poster digest
        self.assertIn((AMY, "Please read and acknowledge: Greens Employee Manual"), MAILS)
        notices_daily.announce(self.db)
        self.assertEqual(self.db.query(models.NexusNotification).filter_by(recipient=AMY).count(), 2)

    def test_scheduled_version_is_not_announced_early(self):
        self.ver("ca-mw", 1, date.today() + timedelta(days=10))
        self.assertEqual(notices_daily.announce(self.db), 0)
        self.assertEqual(notices_daily.announce(self.db, on=date.today() + timedelta(days=10)), 1)

    def test_reminders_every_seven_days_while_urgent(self):
        self.ver("manual-core", 1, date.today() - timedelta(days=20))      # overdue
        self.assertEqual(notices_daily.remind(self.db), 1)
        self.assertEqual(notices_daily.remind(self.db), 0)                 # not again this week
        b = self.db.query(models.NexusNotification).filter_by(recipient=AMY, type="workplace_notice_ack").one()
        b.created_at = "2000-01-01T00:00:00+00:00"
        self.db.commit()
        self.assertEqual(notices_daily.remind(self.db), 1)

    def test_manager_hears_on_monday(self):
        self.ver("manual-core", 1, date.today() - timedelta(days=40))
        monday = date.today() + timedelta(days=(7 - date.today().weekday()) % 7)
        self.assertEqual(notices_daily.escalate(self.db, on=monday), 1)
        self.assertEqual(self.db.query(models.NexusNotification).filter_by(recipient=BOSS).count(), 1)
        self.assertEqual(notices_daily.escalate(self.db, on=monday + timedelta(days=1)), 0)   # Tuesday


if __name__ == "__main__":
    unittest.main()
