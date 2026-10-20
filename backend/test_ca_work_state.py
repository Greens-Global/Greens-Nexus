"""California scope by WORK STATE (Charmi, Oct 20 2026) - work_state.py and
the California Review's plain-words queue (ca_review.py).

  * a state is read from a work-site address, never from a street name;
  * California work site -> checked; Texas work site -> not checked and off
    the CA meal check; an overtime rule HR picked by hand wins; unknown ->
    not flagged, listed for HR, pay left on the California rule;
  * the company-default overtime rule follows the work state;
  * the queue groups by kind, explains each flag with the math done, and a
    premium already on the time sheet reads as handled;
  * a split shift whose pay already covers the premium is not flagged;
  * employees and managers never read the review.

Runs on test_timesheet_review's throwaway database.
    python -m pytest test_ca_work_state.py -q
"""
import os
import unittest

from test_timesheet_review import ReviewCase, EMP, MGR, HR, ENTITY, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import auth  # noqa: E402
import ca_breaks  # noqa: E402
import ca_review as cr  # noqa: E402
import models  # noqa: E402
import payroll_readiness as pr  # noqa: E402
import work_state as ws  # noqa: E402
from routers import hr as hr_router  # noqa: E402

CA_SITE, TX_SITE, OTHER = "ws-t-temecula", "ws-t-austin", "ws-t-sachse"


class AddressTests(unittest.TestCase):
    def test_state_from_address(self):
        cases = {
            "47355, Rainbow Canyon Road, Riverside County, California, 92592, United States": "CA",
            "11318 California 67, Lakeside, CA 92040": "CA",
            # "Via California" is a street in Dana Point - the state is read from the end.
            "26132, Via California, Capistrano Beach, Dana Point, Orange County, California, 92624, United States": "CA",
            "1100 Congress Ave, Austin, TX 78701": "TX",
            "Georgetown, Texas": "TX",
            "469 Bohemian Highway Sebastopol": "",
            "Thakurpukur, Kolkata, West Bengal, 700063, India": "",
            "": "",
        }
        for addr, want in cases.items():
            self.assertEqual(ws.state_from_address(addr), want, addr)

    def test_default_rule(self):
        self.assertEqual(ws.default_rule("US", "CA"), "ca")
        self.assertEqual(ws.default_rule("US", "TX"), "federal")
        self.assertEqual(ws.default_rule("US", ""), "ca")        # unknown: pay never drops on a guess
        self.assertEqual(ws.default_rule("IN", ""), "none")
        self.assertEqual(ws.default_rule("GB", ""), "federal")


class ScopeTests(ReviewCase):
    def setUp(self):
        super().setUp()
        for mdl in (models.CaReviewResolution, models.TimeBreakPremium, models.CaMealWaiver,
                    models.HrWorkSite, models.HrCompanyWorkSite):
            self.db.query(mdl).delete()
        self.db.query(models.NexusSetting).filter_by(key=cr.SETTINGS_KEY).delete()
        self.db.query(models.NexusRole).filter(models.NexusRole.email.in_([MGR, HR])).delete(synchronize_session=False)
        self.db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
        self.db.add(models.NexusRole(email=HR, role="administrator", assigned_by="test"))
        self.db.add(models.HrWorkSite(id=CA_SITE, name="GS Temecula",
                                      address="47355, Rainbow Canyon Road, Riverside County, California, 92592, United States"))
        self.db.add(models.HrWorkSite(id=TX_SITE, name="Austin", address="1100 Congress Ave, Austin, TX 78701"))
        self.db.add(models.HrWorkSite(id=OTHER, name="Sachse", address="Sachse, TX 75048"))
        self.db.add(models.PayrollRate(employee_email=EMP, pay_type="hourly", currency="USD", hourly_rate=22.0,
                                       full_day_hours=8, overtime_rule="ca"))
        self.db.commit()
        auth.invalidate_role_cache()
        pr.clear_cache()
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")
        self._switch = ws.CA_SCOPE_BY_WORK_STATE
        ws.CA_SCOPE_BY_WORK_STATE = True

    def tearDown(self):
        ws.CA_SCOPE_BY_WORK_STATE = self._switch
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        auth.invalidate_role_cache()
        super().tearDown()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _emp(self):
        self.db.expire_all()
        return self.db.query(models.NexusEmployee).filter_by(work_email=EMP).first()

    def _site(self, *ids):
        self._emp().work_site_ids = "[" + ", ".join(f'"{i}"' for i in ids) + "]" if ids else ""
        self.db.commit()

    def _explicit(self, rule):
        e = self._emp()
        e.compensation = {**(e.compensation or {}), "overtimeRule": rule}
        self.db.commit()

    def _report(self):
        self.db.expire_all()
        return cr.build(self.db, None, self.start)

    def test_california_site_is_checked(self):
        self._site(CA_SITE)
        st = ws.resolve(self.db, self._emp())
        self.assertEqual((st["state"], st["source"]), ("CA", "site"))
        self.assertEqual(st["label"], "Work site: GS Temecula, CA")
        rep = self._report()
        self.assertEqual(rep["people"], 1)
        self.assertEqual({r["rule"] for r in rep["rows"]}, {"meal"})
        self.assertEqual(rep["unknownState"], [])
        self.assertTrue(ca_breaks.in_scope(self.db, EMP))

    def test_texas_site_is_not_checked(self):
        self._site(TX_SITE)
        rep = self._report()
        self.assertEqual((rep["people"], rep["rows"], rep["unknownState"]), (0, [], []))
        self.assertEqual([(x["name"], x["state"]) for x in rep["outsideCa"]], [("Erin Test", "TX")])
        # Off the CA meal check on the time sheet too, and the default rule is federal.
        self.assertFalse(ca_breaks.in_scope(self.db, EMP))
        self.assertEqual(hr_router.default_overtime_rule(self.db, self._emp()), "federal")
        # Payroll Readiness carries no California flags for them either.
        rows = {r["email"]: r for r in pr.build(self.db, None, self.start)["rows"]}
        self.assertFalse([x for x in rows[EMP]["exceptions"] if x["type"].startswith("ca_")])

    def test_mixed_sites_with_california_count_as_california(self):
        self._site(TX_SITE, CA_SITE)
        self.assertEqual(ws.resolve(self.db, self._emp())["state"], "CA")

    def test_explicit_rule_wins(self):
        self._site(TX_SITE)
        self._explicit("ca")
        rep = self._report()
        self.assertEqual(rep["people"], 1)
        self.assertIn("meal", {r["rule"] for r in rep["rows"]})
        self.assertTrue(ca_breaks.in_scope(self.db, EMP))
        # A default-rule change never touches a rule picked by hand.
        self.assertEqual(ws.default_rule_changes(self.db), [])

    def test_unknown_is_listed_not_flagged(self):
        rep = self._report()
        self.assertEqual((rep["people"], rep["rows"]), (0, []))
        self.assertEqual([x["email"] for x in rep["unknownState"]], [EMP])
        # Pay stays on the California rule (and the time sheet's meal check)
        # until HR sets the state - never a guess that lowers pay.
        self.assertEqual(hr_router.default_overtime_rule(self.db, self._emp()), "ca")
        self.assertTrue(ca_breaks.in_scope(self.db, EMP))
        self.assertEqual(cr.flags_for(self.db, EMP, self.start, self.end), [])

    def test_company_sites_and_punches_give_the_state(self):
        # Every site on the company's list is in California -> California.
        self.db.add(models.HrCompanyWorkSite(id=f"{ENTITY}:{CA_SITE}", company_id=ENTITY, site_id=CA_SITE))
        self.db.commit()
        st = ws.resolve(self.db, self._emp())
        self.assertEqual((st["state"], st["source"]), ("CA", "company_sites"))
        # Where they punched comes before the company's list.
        self.db.query(models.TimePunch).filter_by(employee_email=EMP).update({"work_site_id": TX_SITE})
        self.db.commit()
        st = ws.resolve(self.db, self._emp())
        self.assertEqual((st["state"], st["source"]), ("TX", "punches"))

    def test_pay_and_benefits_shows_the_work_state(self):
        self._site(TX_SITE)
        out = hr_router.payroll_fields(self.db, self._emp())
        self.assertEqual(out["defaultOvertimeRule"], "federal")
        self.assertEqual(out["workState"]["state"], "TX")
        self.assertEqual(out["workState"]["label"], "Work site: Austin, TX")

    def test_default_rule_changes_dry_run_and_apply(self):
        self._site(TX_SITE)
        ch = ws.default_rule_changes(self.db)
        self.assertEqual([(c["name"], c["from"], c["to"]) for c in ch], [("Erin Test", "ca", "federal")])
        # Dry run: nothing written.
        self.db.expire_all()
        self.assertEqual(self.db.query(models.PayrollRate).filter_by(employee_email=EMP).first().overtime_rule, "ca")
        ws.apply_default_rule_changes(self.db, "visesh@x")
        self.db.expire_all()
        self.assertEqual(self.db.query(models.PayrollRate).filter_by(employee_email=EMP).first().overtime_rule, "federal")

    def test_switch_off_is_the_old_rule(self):
        ws.CA_SCOPE_BY_WORK_STATE = False
        self._site(TX_SITE)
        self.assertEqual(hr_router.default_overtime_rule(self.db, self._emp()), "ca")
        self.assertEqual(self._report()["people"], 1)

    def test_queue_in_plain_words(self):
        self._site(CA_SITE)
        rep = self._report()
        meal = next(r for r in rep["rows"] if r["rule"] == "meal")
        self.assertEqual(meal["kind"], "meal_missed")
        self.assertIn("Worked 7 hours on ", meal["what"])
        self.assertIn("with no break", meal["what"])
        self.assertEqual(meal["means"], "1 hour of meal premium is owed at their regular rate ($22.00).")
        self.assertEqual((meal["owed"], meal["premiumKind"]), (22.0, "meal"))
        self.assertEqual(rep["summary"], [{"kind": "meal_missed", "label": "Meal Missed", "count": 1}])
        # The premium on the time sheet answers it: handled, no longer open.
        ca_breaks.add_premium(self.db, EMP, self.start, "meal", HR, source="manager")
        self.db.commit()
        rep = self._report()
        meal = next(r for r in rep["rows"] if r["rule"] == "meal")
        self.assertEqual((meal["status"], meal.get("premiumAdded")), ("resolved", True))
        self.assertEqual((rep["openCount"], rep["summary"]), (0, []))

    def test_split_shift_math(self):
        def day(rate, reg=480):
            seg = lambda a, b: {"in": f"2026-09-16T{a}:00", "out": f"2026-09-16T{b}:00", "flags": [],  # noqa: E731
                                "payClass": "", "deductedMin": 0, "breaks": []}
            return {"date": "2026-09-16", "regMin": reg, "otMin": 0, "dtMin": 0, "rate": rate,
                    "segments": [seg("08:00", "12:00"), seg("13:30", "17:30")]}
        # $22/hr for 8 h covers one extra hour at $16.90: nothing owed, no flag.
        self.assertEqual(cr.split_shift_flags([day(22.0)], 16.90), [])
        # $17/hr: 16.90 x 9 - 17 x 8 = $16.10 owed.
        f = cr.split_shift_flags([day(17.0)], 16.90)
        self.assertEqual([(x["rule"], x["owed"]) for x in f], [("split_shift", 16.10)])
        self.assertIn("1 hour 30 minutes", f[0]["what"])

    def test_employee_and_manager_cannot_read_the_review(self):
        self._site(CA_SITE)
        for who in (EMP, MGR):
            self._as(who)
            self.assertIn(self.client.get(f"/ca-review/report?start={self.start}").status_code, (401, 403), who)
            self.assertIn(self.client.get("/ca-review/settings").status_code, (401, 403), who)
        # (The employee's signing screen carries no flagged days:
        # test_ca_breaks.test_signing_confirms_the_statement.)


if __name__ == "__main__":
    unittest.main()
