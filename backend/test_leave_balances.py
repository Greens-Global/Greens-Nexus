"""Paid leave balances (Neil / Charmi call, Oct 19 2026) - leave_balances.py
and routers/leave_balances.py.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_leave_balances.py -q
"""
import os
import tempfile
import unittest
from datetime import date, datetime, timedelta

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import leave_balances as lb  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import timeclock as tc  # noqa: E402

A = "lb.alice@greensglobal.com"     # CA hourly, 2+ years, full time
C = "lb.carl@greensglobal.com"      # CA hourly, joined Jan 2026
N = "lb.nina@greensglobal.com"      # CA hourly, joined Sep 2026 - not 90 days yet
IN = "lb.isha@greensglobal.com"     # India
HR_EMAIL = "lb.hr@greensglobal.com"
HR = {"email": HR_EMAIL, "level": 5, "role": "administrator"}
GROUP = "grp-lb-hr"
PS, PE = "2026-09-13", "2026-09-26"
CUT = "2026-09-01"
TODAY = date(2026, 10, 19)
PDT = 420


def _utc(local: str) -> str:
    t = datetime.strptime(local, "%Y-%m-%dT%H:%M") + timedelta(minutes=PDT)
    return t.strftime("%Y-%m-%dT%H:%M:%S")


_SEQ = [0]


def _p(db, em, kind, local, cat=""):
    _SEQ[0] += 1
    at = _utc(local)
    db.add(models.TimePunch(id=f"lb-{_SEQ[0]:04d}", employee_email=em, kind=kind, at=at, local_date=local[:10],
                            tz_offset_min=PDT, voided=0, created_at=at, source="web", geo_status="",
                            category=cat))


class LeaveBalanceTests(unittest.TestCase):
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
        for m in (models.TimePunch, models.PayrollRate, models.TimeApproval, models.LeaveLedgerEntry,
                  models.NexusSetting, models.TimeOffRequest, models.PunchRequest, models.NexusNotification,
                  models.NexusGroupMember, models.NexusGroup):
            db.query(m).delete(synchronize_session=False)
        db.query(models.NexusEmployee).execution_options(include_deleted=True).delete(synchronize_session=False)
        for em, fn, start, country in ((A, "Alice", "2024-06-01", "US"), (C, "Carl", "2026-01-01", "US"),
                                       (N, "Nina", "2026-09-01", "US"), (IN, "Isha", "2023-10-01", "IN"),
                                       (HR_EMAIL, "Hana", "2020-01-01", "US")):
            db.add(models.NexusEmployee(id=f"emp-{em}", first_name=fn, last_name="Test", work_email=em,
                                        company="", status="active", deleted_at="", start_date=start,
                                        employment_type="full_time", country=country))
        for em in (A, C, N):
            db.add(models.PayrollRate(employee_email=em, pay_type="hourly", hourly_rate=20.0,
                                      overtime_rule="ca", currency="USD"))
        db.add(models.NexusGroup(id=GROUP, name="LB HR", allowed_modules="hr:full"))
        db.add(models.NexusGroupMember(group_id=GROUP, email=HR_EMAIL))
        db.commit()
        cache.module_grants.invalidate()

    def tearDown(self):
        self.db.close()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()

    def _cutover(self):
        lb.set_cutover(self.db, CUT, HR_EMAIL)
        self.db.commit()

    # ── policy and buckets ──
    def test_nothing_shows_before_the_start_date(self):
        b = lb.balances(self.db, A, today=TODAY)
        self.assertFalse(b["live"])
        self.assertNotIn("vacation", b)
        self.assertIsNone(lb.available(self.db, A, "sick"))

    def test_policy_by_country_and_rule(self):
        self.assertEqual(lb.policy_for(self.db, A)["id"], "us-ca")
        self.assertEqual(lb.policy_for(self.db, IN)["id"], "in")
        self.db.query(models.PayrollRate).filter(models.PayrollRate.employee_email == C).update(
            {"overtime_rule": "federal"})
        self.assertEqual(lb.policy_for(self.db, C)["id"], "us-other")

    def test_bucket_mapping(self):
        for name, b in (("Vacation", "vacation"), ("PTO", "vacation"), ("Annual Leave", "vacation"),
                        ("Sick Day", "sick"), ("personal", "sick"), ("Medical Appointment", "sick"),
                        ("1/2 Day", ""), ("other", ""), ("", "")):
            self.assertEqual(lb.bucket_of(name), b, name)

    # ── sick ──
    def test_california_sick_grant_and_the_90_days(self):
        self._cutover()
        self.assertEqual(lb.balances(self.db, C, today=TODAY)["sick"]["available"], 40)
        nina = lb.balances(self.db, N, today=TODAY)["sick"]
        self.assertEqual(nina["available"], 0)
        self.assertFalse(nina["eligible"])
        self.assertEqual(nina["eligibleOn"], "2026-11-30")
        # Once past 90 days, still this calendar year: the full 5 days.
        self.assertEqual(lb.balances(self.db, N, today=date(2026, 12, 1))["sick"]["available"], 40)

    def test_imported_sick_replaces_the_year_grant_and_expires(self):
        self._cutover()
        lb.set_opening(self.db, A, vacation=20, sick=16, by=HR_EMAIL)
        self.db.commit()
        self.assertEqual(lb.balances(self.db, A, today=TODAY)["sick"]["available"], 16)
        # Next year: last year's sick is gone, a fresh grant.
        self.assertEqual(lb.balances(self.db, A, today=date(2027, 1, 5))["sick"]["available"], 40)

    def test_india_sick_and_anniversary_vacation(self):
        self._cutover()
        b = lb.balances(self.db, IN, today=TODAY)
        self.assertEqual(b["sick"]["available"], 24)
        self.assertEqual(b["vacation"]["available"], 80)    # 3rd anniversary on 10/01/2026
        self.assertEqual(b["policy"]["unit"], "days")

    # ── finalize ──
    def _alice_period(self):
        for d in ("2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"):
            _p(self.db, A, "in", f"{d}T08:00")
            _p(self.db, A, "out", f"{d}T16:00")
        _p(self.db, A, "in", "2026-09-21T08:00", cat="Vacation")
        _p(self.db, A, "out", "2026-09-21T16:00", cat="Vacation")
        self.db.commit()

    def test_finalize_earns_vacation_and_records_leave_used(self):
        self._cutover()
        lb.set_opening(self.db, A, vacation=20, sick=16, by=HR_EMAIL)
        self.db.commit()
        self._alice_period()
        tc.finalize_timecard(tc.FinalizeIn(email=A, start=PS, end=PE, allow_exceptions=True), user=HR, db=self.db)
        rows = {r.kind: r for r in self.db.query(models.LeaveLedgerEntry)
                .filter(models.LeaveLedgerEntry.employee_email == A, models.LeaveLedgerEntry.kind != "opening")}
        self.assertAlmostEqual(rows["accrual"].hours, 40 * 40 / 2080, places=3)   # 40 h worked, 1 week a year
        self.assertAlmostEqual(rows["used"].hours, -8, places=3)
        b = lb.balances(self.db, A, today=TODAY)
        self.assertAlmostEqual(b["vacation"]["available"], 20 + 40 * 40 / 2080 - 8, places=2)
        # Unfinalize takes the period's rows back out.
        tc.unfinalize_timecard(tc.FinalizeIn(email=A, start=PS, end=PE, reason="Wrong lunch on Monday"), user=HR, db=self.db)
        self.assertEqual(self.db.query(models.LeaveLedgerEntry)
                         .filter(models.LeaveLedgerEntry.kind != "opening").count(), 0)

    def test_no_accrual_in_the_first_year(self):
        self._cutover()
        for d in ("2026-09-14", "2026-09-15"):
            _p(self.db, C, "in", f"{d}T08:00")
            _p(self.db, C, "out", f"{d}T16:00")
        self.db.commit()
        self.assertEqual(lb.period_entries(self.db, C, PS, PE), [])

    # ── API ──
    def test_import_in_days_adjust_and_recalculate(self):
        self._cutover()
        resp = self.client.post("/leave-balances/import", json={"unit": "days", "rows": [
            {"email": IN, "vacation": 2, "sick": 1}, {"email": "nobody@greensglobal.com", "vacation": 1}]})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["imported"], 1)
        self.assertEqual(len(resp.json()["errors"]), 1)
        self.assertEqual(self.client.post("/leave-balances/adjust",
                                          json={"email": IN, "bucket": "vacation", "hours": 4, "note": ""}).status_code, 400)
        self.assertEqual(self.client.post("/leave-balances/adjust",
                                          json={"email": IN, "bucket": "vacation", "hours": 4,
                                                "note": "Comp day"}).status_code, 200)
        b = self.client.get(f"/leave-balances/person/{IN}").json()
        self.assertEqual(b["vacation"]["available"], 16 + 4 + 80)
        admin = self.client.get("/leave-balances/admin").json()
        self.assertTrue(admin["canSetup"])
        self.assertIn(IN, [p["email"] for p in admin["people"]])
        self._alice_period()
        tc.finalize_timecard(tc.FinalizeIn(email=A, start=PS, end=PE, allow_exceptions=True), user=HR, db=self.db)
        self.db.query(models.LeaveLedgerEntry).filter(models.LeaveLedgerEntry.kind == "accrual").delete()
        self.db.commit()
        out = self.client.post("/leave-balances/recalculate").json()
        self.assertEqual(out["periods"], 1)
        self.assertEqual(self.db.query(models.LeaveLedgerEntry)
                         .filter(models.LeaveLedgerEntry.kind == "accrual").count(), 1)

    def test_employee_sees_only_their_own(self):
        self._cutover()
        os.environ["NEXUS_DEV_EMAIL"] = C
        self.assertEqual(self.client.get("/leave-balances/me").json()["sick"]["available"], 40)
        self.assertEqual(self.client.get(f"/leave-balances/person/{A}").status_code, 403)
        self.assertEqual(self.client.put("/leave-balances/cutover", json={"date": "2026-01-01"}).status_code, 403)

    def test_no_paid_sick_punch_before_90_days(self):
        self._cutover()
        os.environ["NEXUS_DEV_EMAIL"] = N
        at = _utc("2026-10-13T08:00")
        resp = self.client.post("/timeclock/punch-requests", json={
            "action": "add", "punch_kind": "in", "at": at, "reason": "Sick", "tz_offset_min": PDT,
            "category": "Sick"})
        self.assertEqual(resp.status_code, 400, resp.text)
        self.assertIn("no paid sick time", resp.json()["detail"])
        os.environ["NEXUS_DEV_EMAIL"] = C
        resp = self.client.post("/timeclock/punch-requests", json={
            "action": "add", "punch_kind": "in", "at": at, "reason": "Sick", "tz_offset_min": PDT,
            "category": "Sick"})
        self.assertEqual(resp.status_code, 200, resp.text)


if __name__ == "__main__":
    unittest.main()
