"""Leave year end (Neil, Oct 27 2026) - leave_year_end.py and the
/leave-balances/year-end routes.

Use It Or Lose It by default; a company may carry everything or up to a cap
(hours or days); California vacation never expires (the law). Year end is
ledger rows only (expire, and carryover for sick), idempotent, self-correcting
when a late pay period lands, previewed by HR before it applies.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_leave_year_end.py -q
"""
import os
import tempfile
import unittest
from datetime import date

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import leave_balances as lb  # noqa: E402
import leave_year_end as lye  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import scoped_settings  # noqa: E402

A = "ye.alice@greensglobal.com"   # California rule (hourly, 'ca' overtime)
O = "ye.omar@greensglobal.com"    # US other state ('federal' overtime)
IN = "ye.isha@greensglobal.com"   # India - vacation granted on the work anniversary
HR_EMAIL = "ye.hr@greensglobal.com"   # Full HR grant
EMP_ONLY = "ye.emp@greensglobal.com"  # nobody's HR
CO, GROUP = "co-ye", "grp-ye-hr"
CUT = "2026-09-01"
JAN5 = date(2027, 1, 5)


class YearEndTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        actual = database.engine.url.database or ""
        assert os.path.abspath(actual) == os.path.abspath(_tmp_db.name), actual
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = HR_EMAIL
        self.db = database.SessionLocal()
        db = self.db
        for m in (models.PayrollRate, models.LeaveLedgerEntry, models.NexusSetting, models.TimeOffRequest,
                  models.NexusGroupMember, models.NexusGroup, models.HrEntity, models.TimePunch):
            db.query(m).delete(synchronize_session=False)
        db.query(models.NexusEmployee).execution_options(include_deleted=True).delete(synchronize_session=False)
        db.add(models.HrEntity(id=CO, name="YE Co", hr_contact_email=""))
        for em, fn, start, country in ((A, "Alice", "2022-06-01", "US"), (O, "Omar", "2022-06-01", "US"),
                                       (IN, "Isha", "2023-10-01", "IN"), (HR_EMAIL, "Hana", "2020-01-01", "US"),
                                       (EMP_ONLY, "Eve", "2020-01-01", "US")):
            db.add(models.NexusEmployee(id=f"emp-{em}", first_name=fn, last_name="Test", work_email=em,
                                        company=CO, status="active", deleted_at="", start_date=start,
                                        employment_type="full_time", country=country))
        db.add(models.PayrollRate(employee_email=A, pay_type="hourly", hourly_rate=20.0, overtime_rule="ca", currency="USD"))
        db.add(models.PayrollRate(employee_email=O, pay_type="hourly", hourly_rate=20.0, overtime_rule="federal", currency="USD"))
        db.add(models.NexusGroup(id=GROUP, name="YE HR", allowed_modules="hr:full"))
        db.add(models.NexusGroupMember(group_id=GROUP, email=HR_EMAIL))
        lb.set_cutover(db, CUT, HR_EMAIL)
        db.commit()                     # autoflush is off: set_opening reads it back
        # What each person had left on the start date.
        lb.set_opening(db, A, 30, None, HR_EMAIL)
        lb.set_opening(db, O, 30, 20, HR_EMAIL)
        db.commit()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def tearDown(self):
        self.db.close()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    # ── helpers ──
    def _rule(self, **cfg):
        scoped_settings.save(self.db, lye.SETTING_KEY, CO, lye.clean({**lye.DEFAULTS, **cfg}), HR_EMAIL)
        self.db.commit()

    def _bal(self, email, bucket, day=JAN5):
        return lb.balances(self.db, email, today=day)[bucket]["available"]

    def _settle(self, email, day=JAN5, window=None):
        emp = lb.employee(self.db, email)
        return lye.apply_people(self.db, [emp], HR_EMAIL, window_days=window, today=day)

    def _rows(self, email, kind=None):
        q = self.db.query(models.LeaveLedgerEntry).filter(models.LeaveLedgerEntry.employee_email == email,
                                                         models.LeaveLedgerEntry.ref_id.like("yearend:%"))
        if kind:
            q = q.filter(models.LeaveLedgerEntry.kind == kind)
        return q.all()

    # ── the default: use it or lose it ──
    def test_default_is_use_it_or_lose_it(self):
        self.assertEqual(lye.config(self.db, CO)["vacationMode"], "reset")
        self.assertEqual(lye.config(self.db, CO)["sickMode"], "reset")
        self.assertEqual(lye.MODE_LABEL["reset"], "Use It Or Lose It")
        self.assertEqual(self._bal(O, "vacation"), 30)
        self.assertEqual(self._settle(O)["rows"], 2)          # vacation expire + sick expire
        self.assertEqual(self._bal(O, "vacation"), 0)
        rows = self._rows(O, "expire")
        self.assertEqual(sorted((r.bucket, r.hours, r.effective_date) for r in rows),
                         [("sick", -20.0, "2026-12-31"), ("vacation", -30.0, "2026-12-31")])
        self.assertIn("12/31/2026", rows[0].note)
        self.assertFalse(self._rows(O, "carryover"))         # nothing carried

    def test_idempotent(self):
        self._settle(O)
        before = [(r.id, r.hours) for r in self._rows(O)]
        for _ in range(3):
            self.assertEqual(self._settle(O)["rows"], 0)
        self.assertEqual([(r.id, r.hours) for r in self._rows(O)], before)

    # ── the law ──
    def test_california_vacation_never_expires(self):
        p = lye.plan(self.db, A, "last", today=JAN5)
        v = p["buckets"]["vacation"]
        self.assertTrue(v["exempt"])
        self.assertEqual(v["effectiveMode"], "carry_all")
        self.assertIn("California vacation does not expire", v["note"])
        self._settle(A)
        self.assertEqual(self._bal(A, "vacation"), 30)
        self.assertFalse([r for r in self._rows(A) if r.bucket == "vacation"])
        # CA sick is still a fresh 40-hour lump in the new year.
        self.assertEqual(self._bal(A, "sick"), 40)

    def test_exempt_list_is_per_state(self):
        self.assertIn("CA", lye.NO_FORFEIT_VACATION)
        self.assertEqual(lye.legal_state(self.db, O), "")
        self.assertEqual(lye.legal_state(self.db, A), "CA")

    # ── carry modes and the cap ──
    def test_carry_everything(self):
        self._rule(vacationMode="carry_all", sickMode="carry_all")
        self._settle(O)
        self.assertEqual(self._bal(O, "vacation"), 30)
        self.assertEqual(self._bal(O, "sick"), 20)          # carried into 2027
        self.assertEqual([(r.kind, r.hours, r.effective_date) for r in self._rows(O)],
                         [("carryover", 20.0, "2027-01-01")])

    def test_carry_up_to_a_cap_in_days(self):
        self._rule(vacationMode="carry_cap", vacationCap=2, vacationCapUnit="days",
                   sickMode="carry_cap", sickCap=5, sickCapUnit="hours")
        p = lye.plan(self.db, O, "last", today=JAN5)
        self.assertEqual(p["buckets"]["vacation"]["capHours"], 16)
        self._settle(O)
        self.assertEqual(self._bal(O, "vacation"), 16)
        self.assertEqual(self._bal(O, "sick"), 5)
        self.assertEqual(self._bal(O, "sick", date(2026, 12, 31)), 5)   # what was left of 2026 that carried
        exp = {r.bucket: r.hours for r in self._rows(O, "expire")}
        self.assertEqual(exp, {"vacation": -14.0, "sick": -15.0})

    def test_cap_validation(self):
        with self.assertRaises(ValueError):
            lye.clean({"vacationCap": "lots"})
        with self.assertRaises(ValueError):
            lye.clean({"vacationCap": 5000})
        self.assertEqual(lye.clean({"vacationMode": "bogus"})["vacationMode"], "reset")

    # ── a late pay period settles as a correction ──
    def test_late_rows_settle_as_corrections_never_edits(self):
        self._settle(O)
        first = {r.id: r.hours for r in self._rows(O)}
        # A December period finalized in January: 8 h of vacation used on 12/30.
        lb.add_entry(self.db, O, "vacation", -8, "used", "2026-12-30", "Paid vacation", "system", "fin-late")
        self.db.commit()
        self.assertEqual(self._bal(O, "vacation"), -8)
        out = self._settle(O)
        self.assertEqual(out["rows"], 1)
        self.assertEqual(self._bal(O, "vacation"), 0)
        rows = self._rows(O, "expire")
        fix = [r for r in rows if r.id not in first]
        self.assertEqual([(r.bucket, r.hours) for r in fix], [("vacation", 8.0)])
        self.assertIn("Correction", fix[0].note)
        self.assertEqual({r.id: r.hours for r in self._rows(O) if r.id in first}, first)   # untouched
        self.assertEqual(self._settle(O)["rows"], 0)

    def test_daily_window(self):
        self.assertEqual(self._settle(O, day=date(2027, 3, 1), window=lye.WINDOW_DAYS)["rows"], 0)
        self.assertEqual(self._settle(O, day=date(2027, 1, 20), window=lye.WINDOW_DAYS)["rows"], 2)

    def test_nothing_before_the_start_date(self):
        # The closing before balances started writes nothing.
        p = lye.plan(self.db, O, "last", today=date(2026, 10, 1))
        self.assertEqual(p["buckets"]["vacation"]["skip"], "Before balances started")
        self.assertEqual(self._settle(O, day=date(2026, 10, 1))["rows"], 0)

    # ── the leave year ──
    def test_anniversary_year_for_anniversary_vacation(self):
        self._rule(vacationYear="anniversary")
        # Isha: 80 h granted on her 3rd anniversary, 10/01/2026.
        self.assertEqual(self._bal(IN, "vacation"), 80)
        p = lye.plan(self.db, IN, "last", today=JAN5)
        self.assertEqual(p["buckets"]["vacation"]["yearBasis"], "anniversary")
        self.assertEqual(p["buckets"]["vacation"]["closesOn"], "2026-09-30")   # nothing left then
        self._settle(IN)
        self.assertEqual(self._bal(IN, "vacation"), 80)      # not the calendar year end
        # Her year closes the day before the 4th anniversary.
        day = date(2027, 10, 5)
        self._settle(IN, day=day)
        exp = [(r.bucket, r.hours, r.effective_date) for r in self._rows(IN, "expire")]
        self.assertIn(("vacation", -80.0, "2027-09-30"), exp)
        self.assertEqual(self._bal(IN, "vacation", day), 80)   # the new year's grant
        # Omar earns per hour: the calendar year, whatever the setting.
        self.assertEqual(lye.plan(self.db, O, "last", today=JAN5)["buckets"]["vacation"]["yearBasis"], "calendar")

    # ── preview and the routes ──
    def test_preview_next_is_projected(self):
        r = self.client.get(f"/leave-balances/year-end/preview?company={CO}&period=next")
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        omar = next(p for p in d["people"] if p["email"] == O)
        self.assertTrue(omar["buckets"]["vacation"]["projected"])
        self.assertEqual(omar["buckets"]["vacation"]["closesOn"], f"{date.today().year}-12-31")
        alice = next(p for p in d["people"] if p["email"] == A)
        self.assertTrue(alice["buckets"]["vacation"]["exempt"])
        self.assertEqual(d["settings"]["vacationMode"], "reset")

    def test_routes_permissions_and_apply(self):
        os.environ["NEXUS_DEV_EMAIL"] = EMP_ONLY
        self.assertEqual(self.client.get(f"/leave-balances/year-end/preview?company={CO}").status_code, 403)
        self.assertEqual(self.client.put(f"/leave-balances/year-end/settings?company={CO}",
                                         json={"vacationMode": "carry_all"}).status_code, 403)
        self.assertEqual(self.client.post("/leave-balances/year-end/apply", json={"company": CO}).status_code, 403)
        os.environ["NEXUS_DEV_EMAIL"] = HR_EMAIL
        r = self.client.put(f"/leave-balances/year-end/settings?company={CO}",
                            json={"vacationMode": "carry_cap", "vacationCap": 10, "vacationCapUnit": "hours"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["hasOverride"])
        self.assertEqual(r.json()["legal"][0]["state"], "CA")
        self.assertEqual(self.client.get("/leave-balances/year-end/settings").json()["vacationMode"], "reset")
        r = self.client.put(f"/leave-balances/year-end/settings?company={CO}", json={"vacationCap": "x"})
        self.assertEqual(r.status_code, 422)
        # Apply settles the year that ended (today's real date: 12/31 of
        # last year is before the start date, so nothing is written yet).
        r = self.client.post("/leave-balances/year-end/apply", json={"company": CO})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["rows"], 0)
        r = self.client.put(f"/leave-balances/year-end/settings?company={CO}", json={"reset": True})
        self.assertFalse(r.json()["hasOverride"])

    def test_year_end_is_scoped_to_the_hr_reach(self):
        # Release review (Oct 27): Full HR scoped to ANOTHER company cannot
        # preview or apply this company's year end, and no scoped caller runs
        # every company at once (company '').
        other = "co-ye-other"
        self.db.add(models.HrEntity(id=other, name="YE Other", hr_contact_email=""))
        self.db.add(models.NexusAccessScope(id="sc-ye", email=HR_EMAIL, module_id="hr", scope_type="entity",
                                            scope_id=other))
        self.db.commit()
        try:
            os.environ["NEXUS_DEV_EMAIL"] = HR_EMAIL
            self.assertEqual(self.client.get(f"/leave-balances/year-end/preview?company={CO}").status_code, 403)
            self.assertEqual(self.client.post("/leave-balances/year-end/apply", json={"company": CO}).status_code, 403)
            self.assertEqual(self.client.post("/leave-balances/year-end/apply", json={"company": ""}).status_code, 403)
            r = self.client.get(f"/leave-balances/year-end/preview?company={other}")
            self.assertEqual(r.status_code, 200, r.text)
            self.assertFalse(r.json()["canAll"])
            self.assertEqual([c["id"] for c in r.json()["companies"]], [other])
        finally:
            self.db.query(models.NexusAccessScope).delete()
            self.db.commit()

    def test_employee_balance_says_what_year_end_does(self):
        os.environ["NEXUS_DEV_EMAIL"] = O
        d = self.client.get("/leave-balances/me").json()
        self.assertEqual(d["yearEnd"]["vacation"]["mode"], "reset")
        os.environ["NEXUS_DEV_EMAIL"] = A
        d = self.client.get("/leave-balances/me").json()
        self.assertTrue(d["yearEnd"]["vacation"]["exempt"])


if __name__ == "__main__":
    unittest.main()
