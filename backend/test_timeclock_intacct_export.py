"""Payroll exports from the team timecard (Neil, 10/01: "Payroll Export
Nexus to IIF is not working and payroll export from QB to Intacct").

The QuickBooks IIF route answers a TIMEACT row per employee per day per pay
class off the timecard engine; the new Intacct export writes the same
wages as a GL import in the accounting app's bank-import layout: a debit
per employee per pay class to the wage expense account (department and
entity as dimensions, employee code in GLENTRY_EMPLOYEEID) and one credit
per employee to the payroll clearing account.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_timeclock_intacct_export.py -q
"""
import csv
import io
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
import intacct_gl  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers.timeclock import payroll_intacct_entries  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

ADMIN = "intacct.admin@greensglobal.com"
PAT = "intacct.pat@greensglobal.com"       # hourly, $20, one 8 h day
SAL = "intacct.sal@greensglobal.com"       # salaried
GROUP = "grp-intacct-test"
SITE = "site-intacct-test"
# A Wednesday well in the past, so no "today" rule touches the day.
DAY = "2026-09-16"
START, END = "2026-09-13", "2026-09-26"


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


class PureTests(unittest.TestCase):
    def test_entries_per_pay_class_with_one_credit_per_person(self):
        cards = [
            {"email": PAT, "name": "Pat Test", "department": "Maintenance", "employeeId": "GG-001", "payType": "hourly",
             "totals": {"regPay": 160.0, "otPay": 30.0, "dtPay": 0, "holidayPay": 0, "sickPay": 40.0, "vacationPay": 0, "regMin": 480, "otMin": 60, "sickMin": 120}},
            {"email": SAL, "name": "Sal Fixed", "department": "Office", "employeeId": "GG-002", "payType": "fixed", "totals": {"totalPay": 3000.0}},
            {"email": "zero@x.com", "name": "Nobody", "payType": "hourly", "totals": {"regPay": 0}},
        ]
        entries = payroll_intacct_entries(cards, start=START, end=END, journal="PYRJ", expense="60100", clearing="21500", location="12000")
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertEqual((e["journal"], e["date"], e["description"]), ("PYRJ", END, "Payroll 09/13/2026 to 09/26/2026"))
        rows = [(line["line_no"], line["acct_no"], line["location_id"], line["dept_id"], line["memo"], line["debit"], line["credit"], line["employee_id"]) for line in e["lines"]]
        self.assertEqual(rows, [
            (1, "60100", "12000", "Maintenance", "Pat Test - Regular Pay - 8.00 h", 160.0, None, "GG-001"),
            (2, "60100", "12000", "Maintenance", "Pat Test - Overtime Pay - 1.00 h", 30.0, None, "GG-001"),
            (3, "60100", "12000", "Maintenance", "Pat Test - Sick Pay - 2.00 h", 40.0, None, "GG-001"),
            (4, "21500", "12000", "Maintenance", "Pat Test - Payroll 09/13/2026 to 09/26/2026", None, 230.0, "GG-001"),
            (5, "60100", "12000", "Office", "Sal Fixed - Salary", 3000.0, None, "GG-002"),
            (6, "21500", "12000", "Office", "Sal Fixed - Payroll 09/13/2026 to 09/26/2026", None, 3000.0, "GG-002"),
        ])
        self.assertTrue(intacct_gl.balanced(entries))
        self.assertEqual(payroll_intacct_entries([], start=START, end=END, journal="PYRJ", expense="", clearing="", location=""), [])
        # A docked salaried month below zero flips sides, never a negative cell.
        neg = payroll_intacct_entries([{"name": "Sal", "payType": "fixed", "totals": {"totalPay": -34.48}}], start=START, end=END, journal="PYRJ", expense="60100", clearing="21500", location="")
        self.assertEqual([(line["debit"], line["credit"]) for line in neg[0]["lines"]], [(None, 34.48), (34.48, None)])
        self.assertTrue(intacct_gl.balanced(neg))


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        _as(ADMIN)
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.HrEntity(id="co-intacct", name="Greens Global"))
            for em, fn, code, dept in ((ADMIN, "Admin", "", ""), (PAT, "Pat", "GG-001", "Maintenance"), (SAL, "Sal", "GG-002", "Office")):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=fn, last_name="Test", work_email=em, company="co-intacct",
                                            employee_code=code, department=dept, status="active", deleted_at=""))
            db.add(models.NexusGroup(id=GROUP, name="Intacct Test", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=ADMIN))
            db.add(models.PayrollRate(employee_email=PAT, hourly_rate=20.0, pay_type="hourly", overtime_rule="ca"))
            db.add(models.PayrollRate(employee_email=SAL, pay_type="fixed", monthly_salary=3000.0, time_tracking_exempt=0))
            db.add(models.HrWorkSite(id=SITE, name="Rental A", latitude="33.6846", longitude="-117.8265", radius_m=150))
            t0 = datetime.strptime(f"{DAY}T15:00:00", "%Y-%m-%dT%H:%M:%S")
            for pid, kind, at in (("ip1", "in", t0), ("ip2", "out", t0 + timedelta(hours=8))):
                db.add(models.TimePunch(id=pid, employee_email=PAT, kind=kind, at=at.strftime("%Y-%m-%dT%H:%M:%S"), local_date=DAY, tz_offset_min=0,
                                        lat="33.6846", lng="-117.8265", work_site_id=SITE, work_site_name="Rental A", geo_status="in_fence",
                                        voided=0, created_at=at.strftime("%Y-%m-%dT%H:%M:%S")))
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
               .filter(models.NexusEmployee.work_email.like("intacct.%")).delete(synchronize_session=False))
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GROUP).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).delete(synchronize_session=False)
            db.query(models.PayrollRate).filter(models.PayrollRate.employee_email.in_((PAT, SAL))).delete(synchronize_session=False)
            db.query(models.TimePunch).filter(models.TimePunch.employee_email == PAT).delete(synchronize_session=False)
            db.query(models.HrWorkSite).filter(models.HrWorkSite.id == SITE).delete(synchronize_session=False)
            db.query(models.HrEntity).filter(models.HrEntity.id == "co-intacct").delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def test_iif_route_answers_a_file(self):
        r = self.client.get(f"/timeclock/export.iif?start={START}&end={END}")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("attachment; filename=timeclock-2026-09-13-to-2026-09-26.iif", r.headers["content-disposition"])
        lines = r.text.split("\r\n")
        self.assertEqual(lines[0], "!TIMERHDR\tVER\tREL\tCOMPANYNAME\tIMPORTEDBEFORE\tFROMTIMER\tCOMPANYCREATETIME")
        self.assertEqual(lines[2], "!TIMEACT\tDATE\tJOB\tEMP\tITEM\tPITEM\tDURATION\tPROJ\tNOTE\tXFERTOPAYROLL\tBILLINGSTATUS")
        self.assertIn("TIMEACT\t9/16/2026\tRental A\tPat Test\t\tRegular Pay\t8.00\t\t\tY\t1", lines)

    def test_intacct_export_writes_the_period_in_the_shared_layout(self):
        r = self.client.get(f"/timeclock/export-intacct.csv?start={START}&end={END}&journal=PYRJ&expense=60100&clearing=21500&location=12000")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn('filename="Intacct GL Import - Payroll - 2026-09-13 to 2026-09-26.csv"', r.headers["content-disposition"])
        rows = list(csv.reader(io.StringIO(r.text)))
        self.assertEqual(rows[0], list(intacct_gl.INTACCT_GL_COLUMNS))
        pat = [x for x in rows[1:] if x[11].startswith("Pat Test")]
        self.assertEqual([x[11] for x in pat], ["Pat Test - Regular Pay - 8.00 h", "Pat Test - Payroll 09/13/2026 to 09/26/2026"])
        self.assertEqual(pat[0][7:10], ["60100", "12000", "Maintenance"])
        self.assertEqual(pat[0][12:15], ["160.00", "", "12000"])
        self.assertEqual(pat[0][27], "GG-001")
        self.assertEqual(pat[1][7], "21500")
        self.assertEqual(pat[1][12:14], ["", "160.00"])
        # The entry's header fields sit on the first line only; the date is MM-DD-YYYY.
        self.assertEqual(rows[1][1:3], ["PYRJ", "09-26-2026"])
        self.assertEqual(rows[1][4], "Payroll 09/13/2026 to 09/26/2026")
        self.assertEqual(rows[2][1:6], ["", "", "", "", ""])
        # The salaried person is on the file too: one Salary line and the
        # clearing line. With no punches all month the engine docks every
        # weekday (3,000 - 22 x 137.93 = -34.48), and a negative figure flips
        # sides instead of printing a minus Intacct would refuse.
        sal = [x for x in rows[1:] if x[11].startswith("Sal Test")]
        self.assertEqual([x[11][:17] for x in sal], ["Sal Test - Salary", "Sal Test - Payrol"])
        self.assertEqual(sal[0][9], "Office")
        self.assertEqual(sal[0][12:14], ["", "34.48"])
        self.assertEqual(sal[1][12:14], ["34.48", ""])
        debits = sum(float(x[12] or 0) for x in rows[1:])
        credits = sum(float(x[13] or 0) for x in rows[1:])
        self.assertAlmostEqual(debits, credits, places=2)
        self.assertEqual(self.client.get("/timeclock/export-intacct.csv").status_code, 400)


if __name__ == "__main__":
    unittest.main()
