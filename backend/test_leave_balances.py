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

# The extras that used to ship on the US policies (removed 11/02/2026 -
# Neil: the US leave card carries no Bereavement / Floating Holiday / Jury
# Duty). The machinery stays, so the tests that exercise it save these onto
# the policy explicitly, the way HR would.
US_EXTRAS = [
    {"id": "bereavement", "name": "Bereavement", "paid": True, "method": "lump",
     "waitingDays": 0, "annualHours": 24, "balanceCapHours": 24,
     "carryoverMax": 0, "payoutOnTerm": False, "eligibleTypes": [],
     "drawFromReasons": ["bereavement", "funeral"]},
    {"id": "floating_holiday", "name": "Floating Holiday", "paid": True, "method": "lump",
     "waitingDays": 90, "annualHours": 16, "balanceCapHours": 16,
     "carryoverMax": 0, "payoutOnTerm": False, "eligibleTypes": [],
     "drawFromReasons": ["floating holiday", "floater"]},
    {"id": "jury_duty", "name": "Jury Duty", "paid": True, "method": "tracked_only",
     "waitingDays": 0, "annualHours": 0, "balanceCapHours": 0,
     "carryoverMax": 0, "payoutOnTerm": False, "eligibleTypes": [],
     "drawFromReasons": ["jury", "jury duty"]},
]


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

    def _with_us_extras(self, extra=None):
        pols = lb.policies(self.db)
        extras = US_EXTRAS + ([extra] if extra else [])
        lb.save_policies(self.db, {"us-ca": {**pols["us-ca"], "extraTypes": extras}}, HR_EMAIL)
        self.db.commit()

    # ── policy and buckets ──
    def test_us_contractors_are_benefit_exempt(self):
        """Visesh (Teams, 11/02/2026): a US-based contractor never accrues or
        holds paid leave, even when a policy's eligible types say contractor.
        A full-time person on the same policy is untouched, and so is a
        contractor with no US country tag."""
        self._cutover()
        pols = lb.policies(self.db)
        us_ca = {**pols["us-ca"], "eligibleTypes": ["full_time", "part_time", "contractor", "intern"]}
        lb.save_policies(self.db, {"us-ca": us_ca}, HR_EMAIL)
        self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == A).update(
            {"employment_type": "contractor"})
        self.db.commit()
        b = lb.balances(self.db, A, today=TODAY)
        self.assertTrue(b["benefitExempt"])
        self.assertFalse(b["vacation"]["eligible"])
        self.assertFalse(b["sick"]["eligible"])
        self.assertEqual(b["vacation"]["accrualPerHour"], 0)
        self.assertIsNone(b["sick"]["grant"])
        # Same policy, full time: accrues as before.
        b2 = lb.balances(self.db, C, today=TODAY)
        self.assertFalse(b2["benefitExempt"])
        self.assertTrue(b2["sick"]["eligible"])

    def test_nothing_shows_before_the_start_date(self):
        b = lb.balances(self.db, A, today=TODAY)
        self.assertFalse(b["live"])
        self.assertNotIn("vacation", b)
        self.assertIsNone(lb.available(self.db, A, "sick"))

    def test_us_policies_carry_no_extra_types_by_default(self):
        """Neil, 11/02/2026: Bereavement, Floating Holiday and Jury Duty are
        off the US leave card. The machinery stays - IN still ships
        bereavement, and HR can add types to any policy."""
        pols = lb.policies(self.db)
        for pid in ("us-ca", "us-other", "in", "none"):
            self.assertIn("extraTypes", pols[pid])
        self.assertEqual(pols["us-ca"]["extraTypes"], [])
        self.assertEqual(pols["us-other"]["extraTypes"], [])
        self.assertEqual([t["id"] for t in pols["in"]["extraTypes"]], ["bereavement"])
        self.assertEqual(pols["none"]["extraTypes"], [])
        bereav = pols["in"]["extraTypes"][0]
        for k in ("paid", "method", "waitingDays", "annualHours", "balanceCapHours",
                  "carryoverMax", "payoutOnTerm", "eligibleTypes", "drawFromReasons"):
            self.assertIn(k, bereav)

    def test_bucket_of_reads_extra_types_from_policy(self):
        """Phase 1B: with a policy that carries extra types (HR added them -
        they no longer ship on US), a request's `type` matches any extra
        type's drawFromReasons slug. Without a policy, keyword matching
        is the fallback (unchanged)."""
        self._with_us_extras()
        pol = lb.policy_for(self.db, A)
        self.assertEqual(lb.bucket_of("Bereavement", pol), "bereavement")
        self.assertEqual(lb.bucket_of("funeral leave", pol), "bereavement")
        self.assertEqual(lb.bucket_of("Floating Holiday", pol), "floating_holiday")
        self.assertEqual(lb.bucket_of("Jury Duty", pol), "jury_duty")
        self.assertEqual(lb.bucket_of("Vacation", pol), "vacation")
        self.assertEqual(lb.bucket_of("Vacation"), "vacation")
        self.assertEqual(lb.bucket_of("Bereavement"), "")

    def test_extra_type_opening_balance_imports_and_shows(self):
        """Phase 1B: set_opening accepts `extras`, add_entry allows extra
        bucket names, and balances() surfaces them in `extraTypes`."""
        self._cutover()
        self._with_us_extras()
        lb.set_opening(self.db, A, None, None, HR_EMAIL, extras={"bereavement": 16, "floating_holiday": 8})
        self.db.commit()
        b = lb.balances(self.db, A, today=TODAY)
        extras = {t["id"]: t for t in b["extraTypes"]}
        self.assertIn("bereavement", extras)
        self.assertIn("floating_holiday", extras)
        self.assertEqual(extras["bereavement"]["available"], 16.0)
        self.assertEqual(lb.available(self.db, A, "bereavement"), 16.0)
        self.assertEqual(lb.available(self.db, A, "floating_holiday"), 8.0)
        with self.assertRaises(ValueError):
            lb.add_entry(self.db, A, "wat_is_this", 1, "adjust", "2026-10-01")

    def test_extra_types_round_trip_through_save(self):
        """HR edits a policy and adds a comp_time type - it is persisted and
        validated. Fields outside the schema are dropped; bad ids are refused."""
        pols = lb.policies(self.db)
        us_ca = {**pols["us-ca"]}
        us_ca["extraTypes"] = us_ca["extraTypes"] + [{
            "id": "comp_time", "name": "Comp Time", "paid": True, "method": "per_hour",
            "waitingDays": 0, "annualHours": 0, "balanceCapHours": 80,
            "carryoverMax": -1, "payoutOnTerm": True, "eligibleTypes": ["full_time"],
            "drawFromReasons": ["comp", "comp time"], "junk": "ignored"}]
        lb.save_policies(self.db, {"us-ca": us_ca}, HR_EMAIL)
        self.db.commit()
        after = lb.policies(self.db)["us-ca"]["extraTypes"]
        self.assertIn("comp_time", {t["id"] for t in after})
        ct = next(t for t in after if t["id"] == "comp_time")
        self.assertNotIn("junk", ct)
        self.assertEqual(ct["drawFromReasons"], ["comp", "comp time"])
        self.assertEqual(ct["carryoverMax"], -1)
        with self.assertRaises(ValueError):
            lb.save_policies(self.db, {"us-ca": {**us_ca, "extraTypes": [{"id": "vacation", "method": "lump"}]}}, HR_EMAIL)
        with self.assertRaises(ValueError):
            lb.save_policies(self.db, {"us-ca": {**us_ca, "extraTypes": [{"id": "BAD ID", "method": "lump"}]}}, HR_EMAIL)

    def test_extra_type_requests_count_once_and_carry_reasons(self):
        """Phase 1D: balances() is policy-aware for upcoming / pending - a
        request that draws from an extra type is counted on that type only,
        even when its name also keyword-matches sick / vacation. The payload
        carries drawFromReasons so the request form mirrors bucket_of()."""
        self._cutover()
        self._with_us_extras(extra={
            "id": "medical_leave", "name": "Medical Leave", "paid": True, "method": "lump",
            "waitingDays": 0, "annualHours": 40, "balanceCapHours": 40,
            "carryoverMax": 0, "payoutOnTerm": False, "eligibleTypes": [],
            "drawFromReasons": ["medical"]})
        self.db.add(models.TimeOffRequest(id="to-1d-1", employee_email=A, type="Medical Appointment",
                                          start_date="2026-10-26", end_date="2026-10-26", status="approved",
                                          created_at="2026-10-19T00:00:00"))
        self.db.add(models.TimeOffRequest(id="to-1d-2", employee_email=A, type="Bereavement",
                                          start_date="2026-10-27", end_date="2026-10-27", status="pending",
                                          created_at="2026-10-19T00:00:00"))
        self.db.commit()
        b = lb.balances(self.db, A, today=TODAY)
        extras = {t["id"]: t for t in b["extraTypes"]}
        # "Medical Appointment" keyword-matches sick, but the policy routes it
        # to medical_leave - once, there.
        self.assertEqual(b["sick"]["upcoming"], 0)
        self.assertEqual(extras["medical_leave"]["upcoming"], 8)
        self.assertEqual(extras["bereavement"]["pending"], 8)
        self.assertEqual(extras["bereavement"]["drawFromReasons"], ["bereavement", "funeral"])

    def test_adjust_an_extra_type_bucket(self):
        """Phase 1D: HR's Adjust accepts an extra type's bucket; an unknown
        bucket stays refused."""
        self._cutover()
        self._with_us_extras()
        resp = self.client.post("/leave-balances/adjust",
                                json={"email": A, "bucket": "bereavement", "hours": -8,
                                      "note": "Took a day before the opening import"})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["bucket"], "bereavement")
        # The adjust row is dated the person's today, so read the balance there.
        extras = {t["id"]: t for t in lb.balances(self.db, A)["extraTypes"]}
        self.assertEqual(extras["bereavement"]["available"], 24 - 8)   # the annual grant minus the day
        self.assertEqual(self.client.post("/leave-balances/adjust",
                                          json={"email": A, "bucket": "wat_is_this", "hours": 4,
                                                "note": "No such type"}).status_code, 400)

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

    # ── Charmi, 11/17/2026 ──
    def test_a_zero_sick_import_is_zero_not_a_fresh_grant(self):
        """QuickBooks said 0 h sick left (all 40 used). The import skipped the
        zero, so the yearly 40 h came back as unused. A 0 opening holds."""
        self._cutover()
        lb.set_opening(self.db, A, 10, 0, HR_EMAIL)
        self.db.commit()
        b = lb.balances(self.db, A, today=TODAY)
        self.assertEqual(b["sick"]["available"], 0)
        self.assertIsNone(b["sick"]["grant"])

    def test_the_period_ending_on_the_start_date_is_inside_the_opening(self):
        """Amy: the 10/04 - 10/17 accrual was added on top of the QuickBooks
        balance that already had it. Rows from a period dated on the start
        date are not counted again; the next period's are, and an HR
        adjustment dated on that day still counts."""
        self._cutover()
        lb.set_opening(self.db, A, 50, 40, HR_EMAIL)
        lb.add_entry(self.db, A, "vacation", 0.31, "accrual", CUT, "Earned in pay period", HR_EMAIL, "r1")
        lb.add_entry(self.db, A, "vacation", 2.78, "accrual", "2026-09-26", "Earned in pay period", HR_EMAIL, "r2")
        lb.add_entry(self.db, A, "vacation", 1, "adjust", CUT, "HR fix", HR_EMAIL)
        self.db.commit()
        self.assertEqual(lb.balances(self.db, A, today=TODAY)["vacation"]["available"], 53.78)

    def test_hr_reads_balances_as_of_a_day(self):
        self._cutover()
        lb.set_opening(self.db, A, 50, 40, HR_EMAIL)
        lb.add_entry(self.db, A, "vacation", 2, "accrual", "2026-09-26", "Earned", HR_EMAIL, "r1")
        lb.add_entry(self.db, A, "vacation", 3, "accrual", "2026-10-10", "Earned", HR_EMAIL, "r2")
        self.db.commit()

        def vac(q=""):
            r = self.client.get("/leave-balances/admin" + q)
            self.assertEqual(r.status_code, 200, r.text)
            return next(p for p in r.json()["people"] if p["email"] == A)["vacation"]["available"]
        self.assertEqual(vac(), 55)
        self.assertEqual(vac("?as_of=2026-09-30"), 52)
        self.assertEqual(self.client.get("/leave-balances/admin?as_of=09/30/2026").status_code, 400)


    def test_guests_on_payroll_are_staff(self):
        """Charmi, 11/20/2026: Nayeli, Alana and Sophia sign in with gmail
        (Entra guests) yet are paid hourly - they were missing from Leave
        Balances. A guest with a pay rate is staff; one without is not, and
        an external never is (payroll_staff.py)."""
        import leave_year_end
        import payroll_staff
        G, G2, X = "lb.guest@gmail.com", "lb.family@gmail.com", "lb.vendor@example.com"
        for em, kind in ((G, "guest"), (G2, "guest"), (X, "external")):
            self.db.add(models.NexusEmployee(id=f"emp-{em}", first_name=em[:6], last_name="Test", work_email=em,
                                             company="", status="active", deleted_at="", start_date="2025-01-01",
                                             employment_type="full_time", country="US", identity_type=kind))
        for em in (G, X):
            self.db.add(models.PayrollRate(employee_email=em, pay_type="hourly", hourly_rate=20.0,
                                           overtime_rule="ca", currency="USD"))
        self.db.commit()
        self._cutover()
        r = self.client.get("/leave-balances/admin")
        self.assertEqual(r.status_code, 200, r.text)
        shown = {p["email"] for p in r.json()["people"]}
        self.assertIn(G, shown)
        self.assertIn(A, shown)
        self.assertNotIn(G2, shown)
        self.assertNotIn(X, shown)
        self.assertIn(G, {e.work_email for e in leave_year_end.people(self.db)})
        emp = lambda em: lb.employee(self.db, em)  # noqa: E731
        self.assertTrue(payroll_staff.is_staff(self.db, emp(G)))
        self.assertTrue(payroll_staff.is_staff(self.db, emp(A)))
        self.assertFalse(payroll_staff.is_staff(self.db, emp(G2)))
        self.assertFalse(payroll_staff.is_staff(self.db, emp(X)))


if __name__ == "__main__":
    unittest.main()

    # ── Compare With QuickBooks and the reasons (11/20/2026) ──
    def test_paid_basis_counts_the_leave_hours(self):
        """A policy may earn on every paid hour, as QuickBooks does: Alice's
        40 h worked + 8 h vacation earn on 48 h, and the note says so."""
        self._cutover()
        pols = lb.policies(self.db)
        lb.save_policies(self.db, {"us-ca": {**pols["us-ca"], "vacation": {**pols["us-ca"]["vacation"], "basis": "paid"}}},
                         HR_EMAIL)
        lb.set_opening(self.db, A, vacation=20, sick=16, by=HR_EMAIL)
        self.db.commit()
        self._alice_period()
        tc.finalize_timecard(tc.FinalizeIn(email=A, start=PS, end=PE, allow_exceptions=True), user=HR, db=self.db)
        acc = (self.db.query(models.LeaveLedgerEntry)
               .filter(models.LeaveLedgerEntry.employee_email == A, models.LeaveLedgerEntry.kind == "accrual").one())
        self.assertAlmostEqual(acc.hours, 48 * 40 / 2080, places=3)
        self.assertIn("on 48.00 h paid", acc.note)
        self.assertEqual(lb.balances(self.db, A, today=TODAY)["vacation"]["basis"], "paid")

    def test_the_rate_and_the_day_it_began(self):
        self._cutover()
        v = lb.balances(self.db, A, today=TODAY)["vacation"]       # started 06/01/2024
        self.assertEqual((v["hoursPerYear"], v["tierSince"], v["basis"]), (40, "2025-06-01", "worked"))
        v = lb.balances(self.db, A, today=date(2027, 6, 2))["vacation"]
        self.assertEqual((v["hoursPerYear"], v["tierSince"]), (80, "2027-06-01"))

    def test_a_closed_period_not_finalized_is_named(self):
        """11/20/2026: a pay period never finalized left a vacation day off
        the balance. The balance says so."""
        self._cutover()
        self._alice_period()
        op = lb.open_periods(self.db, A, CUT, TODAY, preview=True)
        self.assertEqual([(p["start"], p["end"], p["hasLeave"]) for p in op], [(PS, PE, True)])
        self.assertIn(-8, [round(e["hours"], 2) for e in op[0]["entries"] if e["kind"] == "used"])
        tc.finalize_timecard(tc.FinalizeIn(email=A, start=PS, end=PE, allow_exceptions=True), user=HR, db=self.db)
        self.assertEqual(lb.open_periods(self.db, A, CUT, TODAY), [])

    def _qb_report(self, blocks):
        import io

        import openpyxl
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Time Off"
        for name, rows in blocks:
            ws.append([name])
            ws.append(["Date", "Chk Num", "Period Start", "Period End", "Hours", "Vac Accrued", "Vac Used",
                       "Vac Balance", "Sick Accrued", "Sick Used", "Sick Balance"])
            for r in rows:
                ws.append([datetime.strptime(r[1], "%Y-%m-%d") + timedelta(days=6), 100,
                           datetime.strptime(r[0], "%Y-%m-%d"), datetime.strptime(r[1], "%Y-%m-%d"), *r[2:]])
            ws.append([None, None, None, None, 999, 9, 9, 9, 9, 9, 9])          # the total line
        buf = io.BytesIO()
        wb.save(buf)
        return buf.getvalue()

    def test_compare_with_quickbooks_names_every_difference(self):
        """Charmi, 11/20/2026: three balances did not match QuickBooks.
        Each difference comes back with its cause and the parts add up:
        a rate QuickBooks never moved, paid vs worked hours, a period not
        finalized in Nexus."""
        import base64
        self._cutover()
        self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == A).update(
            {"employee_code": "E-0001"})
        lb.set_opening(self.db, A, vacation=20, sick=16, by=HR_EMAIL)
        self.db.commit()
        self._alice_period()                                          # 40 h worked + 8 h vacation
        tc.finalize_timecard(tc.FinalizeIn(email=A, start=PS, end=PE, allow_exceptions=True), user=HR, db=self.db)
        q1 = 48 * 20 / 2080                                           # QuickBooks: 20 h a year, on paid hours
        data = self._qb_report([
            ("Alice  Test(E-0001)", [("2026-08-16", "2026-08-29", 80, 0.77, 0, 20, 0, 0, 16),
                                     (PS, PE, 48, q1, 8, 20 + q1 - 8, 0, 0, 16),
                                     ("2026-09-27", "2026-10-10", 80, 0.77, 0, 20 + q1 - 8 + 0.77, 0, 0, 16)]),
            ("Ghost Person(E-0999)", [(PS, PE, 80, 0, 0, 0, 0, 0, 0)]),
        ])
        r = self.client.post("/leave-balances/compare-quickbooks",
                             json={"file": base64.b64encode(data).decode(), "name": "qb.xlsx"})
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual(out["unmatched"], [{"name": "Ghost Person", "code": "E-0999"}])
        alice = next(p for p in out["people"] if p["email"] == A)
        self.assertEqual(alice["state"], "differs")
        self.assertEqual(alice["asOf"], "2026-10-10")
        kinds = {x["kind"] for x in alice["lines"] if x["bucket"] == "vacation"}
        self.assertEqual(kinds, {"rate", "hours", "not_final"})
        rate = next(x for x in alice["lines"] if x["kind"] == "rate")
        self.assertAlmostEqual(rate["hours"], 40 * 20 / 2080, places=2)
        self.assertIn("QuickBooks earns 20h a year, the policy 40h a year", rate["text"])
        self.assertAlmostEqual(sum(x["hours"] for x in alice["lines"] if x["bucket"] == "vacation"),
                               alice["vacation"]["difference"], places=1)
        self.assertEqual(alice["sick"]["difference"], 0)
        self.assertEqual(self.client.post("/leave-balances/compare-quickbooks",
                                          json={"file": base64.b64encode(b"not excel").decode()}).status_code, 400)
