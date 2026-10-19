"""QuickBooks IIF time export (Oct 19 2026 audit):

  * a paid company holiday is its own Holiday Pay line (the hours its credit
    pays for: full_day_hours, half on a half-day holiday), renamed per
    company like every other pay class, never billed to a job;
  * the export takes FINALIZED time sheets only unless the caller asks for
    the draft explicitly (finalized_only=false), and that file is named
    -DRAFT;
  * the header's COMPANYNAME is the export's company - HR's saved
    QuickBooks Company Name, else the company's own name - and "Greens
    Global" only for a file that spans several companies.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_iif_export.py -q
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

ADMIN = "iif.admin@greensglobal.com"
PAT = "iif.pat@greensglobal.com"        # company A, hourly, 8 h days
QUINN = "iif.quinn@greensglobal.com"    # company B, hourly
GROUP = "grp-iif-test"
SITE = "site-iif-test"
CO_A, CO_B = "co-iif-a", "co-iif-b"
START, END = "2026-09-13", "2026-09-26"
HEADER_A = "TIMERHDR\t8\t0\tIIF Alpha Builders\tN\tY\t0"


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


def _shift(db, em, pid, day, hours):
    t0 = datetime.strptime(f"{day}T15:00:00", "%Y-%m-%dT%H:%M:%S")
    for n, kind, at in ((1, "in", t0), (2, "out", t0 + timedelta(hours=hours))):
        db.add(models.TimePunch(id=f"{pid}-{n}", employee_email=em, kind=kind, at=at.strftime("%Y-%m-%dT%H:%M:%S"),
                                local_date=day, tz_offset_min=0, lat="33.6846", lng="-117.8265",
                                work_site_id=SITE, work_site_name="Rental A",
                                geo_status="in_fence", voided=0,
                                created_at=at.strftime("%Y-%m-%dT%H:%M:%S")))


class IifExportTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        _as(ADMIN)
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.HrEntity(id=CO_A, name="IIF Alpha Builders"))
            db.add(models.HrEntity(id=CO_B, name="IIF Bravo Homes"))
            for em, fn, co in ((ADMIN, "Admin", CO_A), (PAT, "Pat", CO_A), (QUINN, "Quinn", CO_B)):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=fn, last_name="Test", work_email=em, company=co,
                                            employee_code="", department="Ops", status="active", deleted_at=""))
            db.add(models.NexusGroup(id=GROUP, name="IIF Test", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=ADMIN))
            db.add(models.NexusRole(email=ADMIN, role="administrator", assigned_by="test"))
            for em in (PAT, QUINN):
                db.add(models.PayrollRate(employee_email=em, hourly_rate=20.0, pay_type="hourly",
                                          overtime_rule="ca", full_day_hours=8))
            db.add(models.HrWorkSite(id=SITE, name="Rental A", latitude="33.6846", longitude="-117.8265", radius_m=150))
            _shift(db, PAT, "ip1", "2026-09-16", 8)
            _shift(db, PAT, "ip2", "2026-09-17", 4)       # worked the half-day holiday's half
            _shift(db, QUINN, "iq1", "2026-09-16", 8)
            # Company A: a full holiday not worked, and a half-day holiday worked.
            db.add(models.HrCompanyHoliday(id="hol-iif-1", company_id=CO_A, date="2026-09-14", name="Founders Day",
                                           type="mandatory"))
            db.add(models.HrCompanyHoliday(id="hol-iif-2", company_id=CO_A, date="2026-09-17", name="Half Day",
                                           type="half_day"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email.like("iif.%")).delete(synchronize_session=False))
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GROUP).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).delete(synchronize_session=False)
            db.query(models.NexusRole).filter(models.NexusRole.email == ADMIN).delete(synchronize_session=False)
            db.query(models.PayrollRate).filter(models.PayrollRate.employee_email.in_((PAT, QUINN))).delete(synchronize_session=False)
            db.query(models.TimePunch).filter(models.TimePunch.employee_email.in_((PAT, QUINN))).delete(synchronize_session=False)
            db.query(models.TimeApproval).filter(models.TimeApproval.employee_email.in_((PAT, QUINN))).delete(synchronize_session=False)
            db.query(models.HrCompanyHoliday).filter(models.HrCompanyHoliday.id.like("hol-iif-%")).delete(synchronize_session=False)
            db.query(models.HrWorkSite).filter(models.HrWorkSite.id == SITE).delete(synchronize_session=False)
            db.query(models.HrEntity).filter(models.HrEntity.id.in_((CO_A, CO_B))).delete(synchronize_session=False)
            db.query(models.NexusSetting).filter(models.NexusSetting.key.in_(
                ("payroll_earnings_codes", "quickbooks_company_names"))).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _finalize(self, email, kind="final"):
        db = database.SessionLocal()
        try:
            db.add(models.TimeApproval(id=f"{kind}-{email}", employee_email=email, period_start=START, period_end=END,
                                       approved_by=ADMIN, approved_at="2026-09-27T00:00:00", kind=kind))
            db.commit()
        finally:
            db.close()

    def _get(self, query):
        r = self.client.get(f"/timeclock/export.iif?start={START}&end={END}{query}")
        self.assertEqual(r.status_code, 200, r.text)
        return r

    def _lines(self, query):
        return self._get(query).text.split("\r\n")

    # ── Holiday ─────────────────────────────────────────────────────────────
    def test_holiday_is_its_own_payroll_item(self):
        lines = self._lines(f"&company={CO_A}&finalized_only=false")
        pat = [ln for ln in lines if "Pat Test" in ln]
        self.assertEqual(pat, [
            # A full holiday not worked: full_day_hours at Holiday Pay, no job, not billable.
            "TIMEACT\t9/14/2026\t\tPat Test\t\tHoliday Pay\t8.00\t\t\tY\t0",
            "TIMEACT\t9/16/2026\tRental A\tPat Test\t\tRegular Pay\t8.00\t\t\tY\t1",
            # The half-day holiday: the worked half at Regular, the other half at Holiday.
            "TIMEACT\t9/17/2026\tRental A\tPat Test\t\tRegular Pay\t4.00\t\t\tY\t1",
            "TIMEACT\t9/17/2026\t\tPat Test\t\tHoliday Pay\t4.00\t\t\tY\t0",
        ])
        # Renamed per company like every other pay class.
        r = self.client.put("/timeclock/payroll/export-codes", json={"company": CO_A, "codes": {"holiday": "HOL"}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("TIMEACT\t9/14/2026\t\tPat Test\t\tHOL\t8.00\t\t\tY\t0",
                      self._lines(f"&company={CO_A}&finalized_only=false"))
        # The Import Hub preview carries the same hours.
        hours = self.client.get(f"/timeclock/export-hours?start={START}&end={END}&company={CO_A}").json()["rows"]
        self.assertEqual(next(x for x in hours if x["email"] == PAT)["hours"]["holiday"], 12.0)
        # Company B has no holiday: no Holiday line, no holiday key.
        self.assertFalse([ln for ln in self._lines("&finalized_only=false") if "Quinn" in ln and "Holiday" in ln])
        hours = self.client.get(f"/timeclock/export-hours?start={START}&end={END}&company={CO_B}").json()["rows"]
        self.assertNotIn("holiday", hours[0]["hours"])

    # ── Finalized only ──────────────────────────────────────────────────────
    def test_finalized_only_by_default(self):
        r = self._get(f"&company={CO_A}")
        self.assertNotIn("Pat Test", r.text)                      # nothing finalized yet
        self.assertIn("filename=timeclock-2026-09-13-to-2026-09-26.iif", r.headers["content-disposition"])
        # A manager approval alone is not finalization.
        self._finalize(PAT, kind="manager")
        self.assertNotIn("Pat Test", self._get(f"&company={CO_A}").text)
        self._finalize(PAT)
        self.assertIn("TIMEACT\t9/16/2026\tRental A\tPat Test\t\tRegular Pay\t8.00\t\t\tY\t1",
                      self._lines(f"&company={CO_A}"))
        # Without a company: only the finalized person, Quinn stays out.
        lines = self._lines("")
        self.assertTrue(any("Pat Test" in ln for ln in lines))
        self.assertFalse(any("Quinn Test" in ln for ln in lines))

    def test_draft_is_explicit_and_named_draft(self):
        r = self._get("&finalized_only=false")
        self.assertIn("Quinn Test", r.text)
        self.assertIn("Pat Test", r.text)
        self.assertIn("filename=timeclock-2026-09-13-to-2026-09-26-DRAFT.iif", r.headers["content-disposition"])
        # The preview list honors the same filter when asked.
        rows = self.client.get(f"/timeclock/export-hours?start={START}&end={END}&finalized_only=true").json()["rows"]
        self.assertEqual(rows, [])
        self._finalize(QUINN)
        rows = self.client.get(f"/timeclock/export-hours?start={START}&end={END}&finalized_only=true").json()["rows"]
        self.assertEqual([x["email"] for x in rows], [QUINN])

    # ── Company name ────────────────────────────────────────────────────────
    def test_company_name_is_the_exports_company(self):
        self.assertEqual(self._lines(f"&company={CO_A}&finalized_only=false")[1], HEADER_A)
        self.assertEqual(self._lines(f"&company={CO_B}&finalized_only=false")[1],
                         "TIMERHDR\t8\t0\tIIF Bravo Homes\tN\tY\t0")
        # Several companies in one file: the old name, as a fallback.
        self.assertEqual(self._lines("&finalized_only=false")[1], "TIMERHDR\t8\t0\tGreens Global\tN\tY\t0")
        # Only one company's people in the file (the finalized one): that company.
        self._finalize(QUINN)
        self.assertEqual(self._lines("")[1], "TIMERHDR\t8\t0\tIIF Bravo Homes\tN\tY\t0")

    def test_quickbooks_company_name_override(self):
        r = self.client.get(f"/timeclock/payroll/export-codes?company={CO_A}")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["quickbooksCompanyName"], r.json()["quickbooksCompanyDefault"]),
                         ("", "IIF Alpha Builders"))
        r = self.client.put("/timeclock/payroll/export-codes",
                            json={"company": CO_A, "codes": {}, "quickbooksCompanyName": "Alpha\tBuilders, Inc."})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["quickbooksCompanyName"], "Alpha Builders, Inc.")      # no tab reaches the IIF
        self.assertEqual(self._lines(f"&company={CO_A}&finalized_only=false")[1],
                         "TIMERHDR\t8\t0\tAlpha Builders, Inc.\tN\tY\t0")
        # Saving codes without the field leaves the name alone; blank clears it.
        self.client.put("/timeclock/payroll/export-codes", json={"company": CO_A, "codes": {"regular": "REG"}})
        self.assertEqual(self._lines(f"&company={CO_A}&finalized_only=false")[1],
                         "TIMERHDR\t8\t0\tAlpha Builders, Inc.\tN\tY\t0")
        self.client.put("/timeclock/payroll/export-codes", json={"company": CO_A, "codes": {}, "quickbooksCompanyName": ""})
        self.assertEqual(self._lines(f"&company={CO_A}&finalized_only=false")[1], HEADER_A)
        # Company B is untouched throughout.
        self.assertEqual(self._lines(f"&company={CO_B}&finalized_only=false")[1],
                         "TIMERHDR\t8\t0\tIIF Bravo Homes\tN\tY\t0")


if __name__ == "__main__":
    unittest.main()
