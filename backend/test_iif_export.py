"""QuickBooks IIF time export (Oct 19 2026 audit):

  * an hourly company holiday is an unpaid day off (Neil, 11/04/2026): no
    Holiday Pay line (the Oct 19 credit is gone), a half-day holiday worked
    writes only the hours worked at Regular Pay;
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
            # A Super Administrator: this payroll reaches every company; an
            # Administrator is walled to their own (Neil, 11/02/2026).
            db.add(models.NexusRole(email=ADMIN, role="owner", assigned_by="test"))
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
                ("payroll_earnings_codes", "quickbooks_company_names",
                 "quickbooks_company_create_times"))).delete(synchronize_session=False)
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
    def _unpaid_from(self, day):
        # These fixtures are September holidays; move the unpaid-from date
        # before them to test the rule (the real one is 11/01/2026).
        from routers import timeclock
        old, timeclock._HOURLY_HOLIDAYS_UNPAID_FROM = timeclock._HOURLY_HOLIDAYS_UNPAID_FROM, day
        self.addCleanup(setattr, timeclock, "_HOURLY_HOLIDAYS_UNPAID_FROM", old)

    def test_hourly_holiday_is_an_unpaid_day_off(self):
        # Neil, 11/04/2026: hourly company holidays are unpaid days off - the
        # old Holiday Pay credit (Pranshu, Oct 19) is gone. A full holiday not
        # worked writes nothing; a half-day holiday writes only the hours worked.
        self._unpaid_from("2026-09-01")
        lines = self._lines(f"&company={CO_A}&finalized_only=false")
        pat = [ln for ln in lines if "Pat Test" in ln]
        self.assertEqual(pat, [
            "TIMEACT\t9/16/2026\tRental A\tPat Test\t\tRegular Pay\t8.00\t\t\tY\t1",
            "TIMEACT\t9/17/2026\tRental A\tPat Test\t\tRegular Pay\t4.00\t\t\tY\t1",
        ])
        # A renamed holiday code still saves, and still writes no line for hourly.
        r = self.client.put("/timeclock/payroll/export-codes", json={"company": CO_A, "codes": {"holiday": "HOL"}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse([ln for ln in self._lines(f"&company={CO_A}&finalized_only=false") if "\tHOL\t" in ln])
        # The Import Hub preview carries the same hours: no holiday key.
        hours = self.client.get(f"/timeclock/export-hours?start={START}&end={END}&company={CO_A}").json()["rows"]
        self.assertNotIn("holiday", next(x for x in hours if x["email"] == PAT)["hours"])
        self.assertFalse([ln for ln in self._lines("&finalized_only=false") if "Quinn" in ln and "Holiday" in ln])
        hours = self.client.get(f"/timeclock/export-hours?start={START}&end={END}&company={CO_B}").json()["rows"]
        self.assertNotIn("holiday", hours[0]["hours"])

    def test_hourly_card_keeps_the_holiday_but_pays_nothing(self):
        from routers import timeclock
        self._unpaid_from("2026-09-01")
        db = database.SessionLocal()
        try:
            card = timeclock._compute_timecard(db, PAT, START, END)
        finally:
            db.close()
        days = {d["date"]: d for d in card["days"]}
        off = days["2026-09-14"]          # not worked: still a day entry, office closed
        self.assertTrue(off["isHoliday"])
        self.assertEqual((off["holidayName"], off["holidayType"], off["workedMin"]), ("Founders Day", "mandatory", 0))
        half = days["2026-09-17"]         # worked: tagged, paid as the hours worked only
        self.assertEqual((half["holidayName"], half["holidayType"], half["workedMin"]), ("Half Day", "half_day", 240))
        for d in (off, half):
            self.assertFalse(d.get("holidayPay"))
            self.assertFalse(d.get("holidayMin"))
        t = card["totals"]
        # holidayDays counts the days off (the worked half day is not one).
        self.assertEqual((t["holidayPay"], t["holidayDays"]), (0, 1))
        self.assertTrue(half["holidayWorked"])
        self.assertFalse(off.get("holidayWorked"))
        self.assertEqual(t["totalPay"], 12 * 20.0)

    def test_veterans_day_2026_is_an_unpaid_day_off(self):
        # The real unpaid-from date: a holiday on 11/11/2026 pays an hourly person nothing.
        from routers import timeclock
        db = database.SessionLocal()
        try:
            db.add(models.HrCompanyHoliday(id="hol-iif-3", company_id=CO_A, date="2026-11-11", name="Veterans Day",
                                           type="mandatory"))
            db.commit()
            card = timeclock._compute_timecard(db, PAT, "2026-11-08", "2026-11-21")
        finally:
            db.close()
        day = {d["date"]: d for d in card["days"]}["2026-11-11"]
        self.assertTrue(day["isHoliday"])
        self.assertFalse(day.get("holidayPay"))
        self.assertEqual((card["totals"]["holidayPay"], card["totals"]["holidayDays"]), (0, 1))

    def test_a_holiday_before_the_unpaid_date_keeps_its_credit(self):
        # Holidays before 11/01/2026 keep the credit they were paid with, so a
        # finalized period re-exports exactly as it was paid (review 11/04/2026).
        lines = self._lines(f"&company={CO_A}&finalized_only=false")
        pat = [ln for ln in lines if "Pat Test" in ln]
        self.assertEqual(pat, [
            "TIMEACT\t9/14/2026\t\tPat Test\t\tHoliday Pay\t8.00\t\t\tY\t0",
            "TIMEACT\t9/16/2026\tRental A\tPat Test\t\tRegular Pay\t8.00\t\t\tY\t1",
            "TIMEACT\t9/17/2026\tRental A\tPat Test\t\tRegular Pay\t4.00\t\t\tY\t1",
            "TIMEACT\t9/17/2026\t\tPat Test\t\tHoliday Pay\t4.00\t\t\tY\t0",
        ])
        hours = self.client.get(f"/timeclock/export-hours?start={START}&end={END}&company={CO_A}").json()["rows"]
        self.assertEqual(next(x for x in hours if x["email"] == PAT)["hours"]["holiday"], 12.0)

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

    def test_preview_rows_say_who_is_finalized(self):
        # Charmi, 10/27 call item 02: the Import Hub loads everyone and names who
        # is not finalized, instead of an empty list (and an empty IIF).
        rows = self.client.get(f"/timeclock/export-hours?start={START}&end={END}").json()["rows"]
        self.assertEqual({x["email"]: x["finalized"] for x in rows if x["email"] in (PAT, QUINN)}, {PAT: False, QUINN: False})
        self._finalize(QUINN)
        rows = self.client.get(f"/timeclock/export-hours?start={START}&end={END}").json()["rows"]
        self.assertEqual({x["email"]: x["finalized"] for x in rows if x["email"] in (PAT, QUINN)}, {PAT: False, QUINN: True})

    def test_company_create_time_on_the_header(self):
        # The TIMERHDR number from her QuickBooks Timer Lists export; digits only.
        self.assertEqual(self._lines(f"&company={CO_A}&finalized_only=false&create_time=1234567890")[1],
                         "TIMERHDR\t8\t0\tIIF Alpha Builders\tN\tY\t1234567890")
        for bad in ("12ab", "1%0A2", "1234567890123", ""):
            self.assertEqual(self._lines(f"&company={CO_A}&finalized_only=false&create_time={bad}")[1], HEADER_A, bad)

    def test_saved_create_time_fills_the_header(self):
        """Charmi, 11/03/2026: her import failed every row - the Payroll
        screen's download carried COMPANYCREATETIME 0. The number saved on
        Payroll Export Codes now fills it; an explicit create_time still
        wins; digits only at save; blank clears; per company."""
        r = self.client.put("/timeclock/payroll/export-codes",
                            json={"company": CO_A, "codes": {}, "quickbooksCreateTime": "1361233702"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["quickbooksCreateTime"], "1361233702")
        self.assertEqual(self._lines(f"&company={CO_A}&finalized_only=false")[1],
                         "TIMERHDR\t8\t0\tIIF Alpha Builders\tN\tY\t1361233702")
        # An explicit number (the Import Hub field) still overrides the saved one.
        self.assertEqual(self._lines(f"&company={CO_A}&finalized_only=false&create_time=42")[1],
                         "TIMERHDR\t8\t0\tIIF Alpha Builders\tN\tY\t42")
        # Another company, and a file spanning several, keep the 0.
        self.assertEqual(self._lines(f"&company={CO_B}&finalized_only=false")[1],
                         "TIMERHDR\t8\t0\tIIF Bravo Homes\tN\tY\t0")
        self.assertEqual(self._lines("&finalized_only=false")[1], "TIMERHDR\t8\t0\tGreens Global\tN\tY\t0")
        # Digits only; saving codes without the field leaves it; blank clears.
        self.assertEqual(self.client.put("/timeclock/payroll/export-codes",
                                         json={"company": CO_A, "codes": {}, "quickbooksCreateTime": "12ab"}).status_code, 400)
        self.client.put("/timeclock/payroll/export-codes", json={"company": CO_A, "codes": {"regular": "REG"}})
        self.assertEqual(self.client.get(f"/timeclock/payroll/export-codes?company={CO_A}").json()["quickbooksCreateTime"],
                         "1361233702")
        self.client.put("/timeclock/payroll/export-codes", json={"company": CO_A, "codes": {}, "quickbooksCreateTime": ""})
        self.assertEqual(self._lines(f"&company={CO_A}&finalized_only=false")[1], HEADER_A)

    def test_one_persons_iif(self):
        """Charmi, Teams 11/03/2026: the download should also work on one
        employee. `email` keeps that person's card, the file is named after
        them, and the header is their company's."""
        r = self._get(f"&email={PAT}&finalized_only=false")
        self.assertIn("Pat Test", r.text)
        self.assertNotIn("Quinn Test", r.text)
        self.assertEqual(r.text.split("\r\n")[1], HEADER_A)          # Pat's company, no company param needed
        self.assertIn("filename=timeclock-2026-09-13-to-2026-09-26-iif.pat-DRAFT.iif",
                      r.headers["content-disposition"])
        # Finalized-only still rules the per-person file.
        self.assertNotIn("Pat Test", self._get(f"&email={PAT}").text)
        self._finalize(PAT)
        self.assertIn("Pat Test", self._get(f"&email={PAT}").text)
        # The company filter and the person must agree.
        self.assertEqual(self.client.get(
            f"/timeclock/export.iif?start={START}&end={END}&company={CO_B}&email={PAT}").status_code, 404)

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
