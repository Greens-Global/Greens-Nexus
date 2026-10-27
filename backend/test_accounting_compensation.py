"""Accounting > Reporting > Employee Compensation (Neil, 10/15; rebuilt from
the ledger after the 10/27 call with Charmi, items 11-17): Time Clock hours
per person, the ledger's compensation lines per employee (Intacct's Employee
Compensation Report - Valinda Cranfill's 2026 figures from Charmi's screen),
workers' comp from the rate in force each year, the drill-down lines, and the
gate (Full level on Accounting, no entity limit).

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_accounting_compensation.py -q
"""
import os
import tempfile
import unittest
import uuid

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import accounting_assumptions as A  # noqa: E402
import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import accounting, accounting_allocations  # noqa: E402
from routers.accounting_compensation import (build_report, comp_line, employee_code, ledger_people, month_end, month_list,  # noqa: E402
                                              rate_in_force, summarize, with_totals, year_slices)

models.Base.metadata.create_all(bind=database.engine)

FULL = "full.comp.test@greensglobal.com"        # accounting:full
VIEWER = "viewer.comp.test@greensglobal.com"    # accounting:viewer - not enough
LIMITED = "limited.comp.test@greensglobal.com"  # accounting:full but limited to one entity
NOBODY = "nobody.comp.test@greensglobal.com"
ADMIN = "admin.comp.test@greensglobal.com"      # administrator role, no group
GROUP_F, GROUP_V = "grp-comp-test-full", "grp-comp-test-viewer"
VALINDA, ENTITY = "emp-comp-test-valinda", "ent-comp-test-oversite"

PEOPLE = [
    {"email": "pat@x.com", "name": "Pat Hourly", "payType": "hourly", "company": "c1", "companyName": "Greens Global", "department": "Maintenance", "employeeId": "GG-001", "currency": "USD"},
    {"email": "sal@x.com", "name": "Sal Fixed", "payType": "fixed", "company": "c2", "companyName": "Greens India", "department": "Accounts", "employeeId": "GI-001", "currency": "INR"},
    {"email": "none@x.com", "name": "No Hours", "payType": "hourly", "company": "c1", "companyName": "Greens Global", "department": "", "employeeId": "", "currency": "USD"},
]


def cards(month):
    sep = month == "2026-09"
    return {
        "pat@x.com": {"rate": 25.0 if sep else 26.0, "totals": {"regMin": 4800, "otMin": 120, "dtMin": 30, "sickMin": 480, "vacationMin": 0, "personalMin": 600, "totalPay": 2500.0}},
        "sal@x.com": {"currency": "INR", "monthlySalary": 90000, "totals": {"regMin": 9000, "otMin": 60, "dtMin": 0, "sickMin": 0, "vacationMin": 540, "personalMin": 0, "totalPay": 88000.0}},
        "none@x.com": {"rate": 20, "totals": {"totalPay": 0}},
    }


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


class MathTests(unittest.TestCase):
    def test_months(self):
        self.assertEqual(month_list("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"])
        self.assertEqual(month_end("2028-02"), "2028-02-29")
        with self.assertRaises(HTTPException):
            month_list("2025-01", "2026-02")   # 14 months
        with self.assertRaises(HTTPException):
            month_list("2026-03", "2026-02")
        with self.assertRaises(HTTPException):
            month_list("2026-13", "2026-12")

    def test_summarize_adds_months_and_keeps_currencies_apart(self):
        out = summarize([(m, PEOPLE, cards(m)) for m in ("2026-09", "2026-10")], {"pat@x.com": "Technician"})
        names = [p["name"] for p in out["people"]]
        self.assertEqual(names, ["Pat Hourly", "Sal Fixed"], "nobody with no wages and no hours")
        pat, sal = out["people"]
        self.assertEqual((pat["title"], pat["payType"], pat["rate"], pat["rateChanged"]), ("Technician", "hourly", 26.0, True))
        self.assertEqual((pat["regMin"], pat["otMin"], pat["dtMin"], pat["overtimeMin"], pat["sickMin"], pat["wages"]), (9600, 240, 60, 300, 960, 5000.0))
        self.assertEqual((sal["payType"], sal["rate"], sal["currency"]), ("salary", 90000.0, "INR"))
        self.assertEqual((sal["regMin"], sal["otMin"]), (18120, 0), "a salaried person's worked time is all regular")
        self.assertEqual([(g["label"], g["currency"], g["wages"]) for g in out["totals"]], [("Total", "INR", 176000.0), ("Total", "USD", 5000.0)])
        self.assertEqual([g["label"] for g in out["byCompany"]], ["Greens Global", "Greens India"])
        self.assertEqual([g["label"] for g in out["byDepartment"]], ["Accounts", "Maintenance"])

    def test_no_personal_hours(self):
        """10/27 item 15: "we don't do personal hours. Either it is sick or vacation." """
        out = summarize([("2026-09", PEOPLE, cards("2026-09"))], {})
        pat = out["people"][0]
        self.assertNotIn("personalMin", pat)
        self.assertEqual(pat["leaveMin"], 480, "sick + vacation only")
        self.assertNotIn("personalMin", out["totals"][0])


# Valinda Cranfill (E-0084), 2026, as Charmi's Intacct Employee Compensation
# Report shows it (10/27 call, change-11-a / change-13-a): Bonus 850.00,
# Salaried Payroll 52,123.06, 401(k) (Company) 2,520.31, Health Insurance
# (Company) 3,249.75, FUTA 42.00, Medicare 665.40, Social Security 2,845.15,
# SUTA 217.00, CA ETT 7.00, Other Benefits 1,087.16 (the 20.00 Pala Vista Gas
# on the MCD Ramp Card among them, change-12-a), Health Insurance (Employee)
# 5,854.22 and the taxes withheld. Accounts are the payroll file's (61908 Bonus,
# 61910 Salary ...); 61950 and 63410 are made up to show the title rules.
def valinda_rows(bucket="E-0084"):
    def row(acct, title, section, debit=0.0, credit=0.0, b=bucket):
        return {"bucket": b, "section": section, "account_no": acct, "title": title, "debit": debit, "credit": credit}
    return [
        row("61908", "Bonus", "expense", 850.00),
        row("61910", "Salary", "expense", 52123.06),
        row("61950", "401(K) Contribution (Company)", "expense", 2520.31),
        row("61903", "Health Insurance", "expense", 3249.75, 5854.22),
        row("62101", "Federal Unemployment", "expense", 42.00),
        row("62102", "Medicare Company", "expense", 665.40),
        row("62104", "Social Security Company", "expense", 2845.15),
        row("62105", "CA - Unemployment Company", "expense", 217.00),
        row("62106", "CA - Employment Training Tax", "expense", 7.00),
        row("63203", "Fuel", "expense", 20.00),
        row("63410", "Cell Phone", "expense", 1067.16),
        row("23801", "Federal Withholding", "liability", 0, 2693.00),
        row("23804", "Medicare Employee Payable", "liability", 0, 665.40),
        row("23807", "Social Security Employee Payable", "liability", 0, 2845.15),
        row("23806", "SDI Payable", "liability", 0, 596.57),
        row("23811", "State Withholding", "liability", 0, 563.02),
        # Not compensation: net pay owed, the employer-tax liability, the bank, income, a line with no employee.
        row("23700", "Payroll Liability (Net Pay)", "liability", 0, 39755.70),
        row("23802", "FUTA Payable", "liability", 0, 42.00),
        row("10100", "Chase Checking", "asset", 0, 39755.70),
        row("40100", "Rental Income", "income", 0, 500.00),
        row("61910", "Salary", "expense", 9999.00, b=""),
    ]


class LedgerReportTests(unittest.TestCase):
    def test_comp_line(self):
        # The payroll file's accounts by number, whatever their title says.
        self.assertEqual(comp_line("expense", "61908", "Anything"), "bonus")
        self.assertEqual(comp_line("expense", "61905", "Hourly Wages"), "payroll")
        self.assertEqual(comp_line("liability", "23101", "401k Payable"), "ded401k")
        self.assertIsNone(comp_line("liability", "23700", "Net Pay"))
        # Others by title: taxes first, then bonus, 401(k), health, wages; any other cost is Other Benefits.
        self.assertEqual(comp_line("expense", "70001", "Payroll Taxes - FUTA"), "futa")
        self.assertEqual(comp_line("expense", "70002", "FICA - Employer"), "socsec")
        self.assertEqual(comp_line("cogs", "70003", "State Unemployment (SUI)"), "suta")
        self.assertEqual(comp_line("expense", "70004", "Employment Training Tax"), "ett")
        self.assertEqual(comp_line("expense", "70005", "Payroll Taxes"), "otherTaxes")
        self.assertEqual(comp_line("expense", "70006", "Annual Bonus"), "bonus")
        self.assertEqual(comp_line("expense", "70007", "401(k) Match"), "k401")
        self.assertEqual(comp_line("expense", "70008", "Dental Insurance"), "health")
        self.assertEqual(comp_line("cogs", "70009", "Direct Labor Wages"), "payroll")
        self.assertEqual(comp_line("expense", "63203", "Fuel"), "otherBenefits")
        self.assertEqual(comp_line("expense", "70010", "Contract Labor"), "otherBenefits", "tagged to an employee, so it counts - by account")
        # The employee's side on the balance sheet; the employer's side and the rest are not compensation.
        self.assertEqual(comp_line("liability", "29001", "Federal Income Tax Withheld"), "fedWh")
        self.assertEqual(comp_line("liability", "29002", "Medicare Employee Payable"), "medicareWh")
        self.assertEqual(comp_line("liability", "29003", "CA - Disability Employee"), "sdi")
        self.assertEqual(comp_line("liability", "29004", "CA - Withholding"), "stateWh")
        self.assertEqual(comp_line("liability", "29005", "Wage Garnishment Payable"), "dedOther")
        self.assertIsNone(comp_line("liability", "29006", "Medicare Company Payable"))
        self.assertIsNone(comp_line("liability", "29007", "MCD Ramp Card"))
        self.assertIsNone(comp_line("asset", "10100", "Chase Checking"))
        self.assertIsNone(comp_line("income", "40100", "Rental Income"))

    def test_employee_code(self):
        self.assertEqual(employee_code("E-0084--Valinda Cranfill"), "E-0084")
        self.assertEqual(employee_code(" E-0084 "), "E-0084")
        self.assertEqual(employee_code(None), "")

    def test_valinda_matches_intacct(self):
        """10/27 item 11: Valinda Cranfill's 2026 Salaried Payroll 52,123.06 and
        Bonus 850.00, as on Intacct's report - not Time Clock's 3,540.23."""
        got = ledger_people(valinda_rows(), {"E-0084": "Valinda Cranfill"})
        self.assertEqual(list(got), ["E-0084"], "the line with no employee is left out")
        v = with_totals(got["E-0084"]["lines"])
        self.assertEqual((v["bonus"], v["payroll"], v["totalPayroll"]), (850.00, 52123.06, 52973.06))
        self.assertEqual((v["k401"], v["health"], v["otherBenefits"], v["totalBenefits"]), (2520.31, 3249.75, 1087.16, 6857.22))
        self.assertEqual((v["futa"], v["medicare"], v["socsec"], v["suta"], v["ett"], v["totalTaxes"]), (42.0, 665.40, 2845.15, 217.0, 7.0, 3776.55))
        self.assertEqual(v["totalEmployer"], 63606.83, "Intacct's Total Employer Expenses")
        self.assertEqual((v["dedHealth"], v["totalDeductions"]), (-5854.22, -5854.22))
        self.assertEqual((v["fedWh"], v["medicareWh"], v["socsecWh"], v["sdi"], v["stateWh"], v["totalWithheld"]),
                         (-2693.0, -665.40, -2845.15, -596.57, -563.02, -7363.14))
        self.assertEqual(v["netPay"], 39755.70, "gross less the deduction less the taxes withheld")
        # Each figure knows its accounts (the drill-down): Other Benefits by account, health by side.
        acc = got["E-0084"]["accounts"]
        self.assertEqual([(a["account"], a["amount"]) for a in acc["otherBenefits"]], [("63203", 20.0), ("63410", 1067.16)])
        self.assertEqual([(a["account"], a["side"]) for a in acc["health"]], [("61903", "d")])
        self.assertEqual([(a["account"], a["side"], a["amount"]) for a in acc["dedHealth"]], [("61903", "c", -5854.22)])

    def test_rate_in_force_and_year_slices(self):
        entries = [(2025, 3.0, "2025-01-05T00:00:00"), (2026, 4.0, "2026-01-02T00:00:00"), (2026, 3.5, "2026-02-01T00:00:00")]
        self.assertEqual(rate_in_force(entries, 2026), (3.5, 2026), "the newest entry for the year wins")
        self.assertEqual(rate_in_force(entries, 2027), (3.5, 2026), "in force until a later year has its own")
        self.assertEqual(rate_in_force(entries, 2025), (3.0, 2025))
        self.assertIsNone(rate_in_force(entries, 2024))
        self.assertEqual(year_slices(["2025-11", "2025-12", "2026-01", "2026-02"]),
                         [(2025, "2025-11-01", "2025-12-31"), (2026, "2026-01-01", "2026-02-28")])

    def test_build_report_workers_comp_per_year_and_people(self):
        rates = {"E-0084": [(2025, 3.0, "2025-01-05"), (2026, 3.5, "2026-02-01")]}
        people = {"E-0084": {"name": "Valinda Cranfill", "email": "valinda@x.com", "companyName": "Oversite Management, Inc", "department": "Operations"}}
        slices = [
            ("cur", 2026, {"rows": valinda_rows(), "labels": {"E-0084": "Valinda C."}}),
            ("prior", 2025, {"rows": [{"bucket": "E-0084", "section": "expense", "account_no": "61910", "title": "Salary", "debit": 57176.84, "credit": 0},
                                      {"bucket": "E-0084", "section": "expense", "account_no": "61908", "title": "Bonus", "debit": 3500.0, "credit": 0}]}),
            # Someone only in last year's ledger is not a row; someone not in People still is, by the ledger's name.
            ("prior", 2025, {"rows": [{"bucket": "E-0001", "section": "expense", "account_no": "61910", "title": "Salary", "debit": 100, "credit": 0}]}),
            ("cur", 2026, {"rows": [{"bucket": "E-0099", "section": "expense", "account_no": "61905", "title": "Hourly", "debit": 400, "credit": 0}],
                           "labels": {"E-0099": "Pat Ledger"}}),
        ]
        rows = build_report(slices, rates, people)
        self.assertEqual([(r["code"], r["name"], r["inPeople"]) for r in rows], [("E-0099", "Pat Ledger", False), ("E-0084", "Valinda Cranfill", True)])
        v = rows[1]
        self.assertEqual(v["workersComp"]["cur"], [{"year": 2026, "ratePct": 3.5, "rateYear": 2026, "gross": 52973.06, "amount": 1854.06}])
        self.assertEqual(v["cur"]["workersComp"], 1854.06)
        self.assertEqual(v["cur"]["totalEmployer"], 65460.89)
        self.assertEqual((v["prior"]["totalPayroll"], v["prior"]["workersComp"]), (60676.84, 1820.31))
        self.assertTrue(v["hasRate"])
        self.assertFalse(rows[0]["hasRate"])
        self.assertEqual(rows[0]["cur"]["workersComp"], 0.0, "no rate set, no workers' comp")


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP_F, name="Comp Test Full", allowed_modules="accounting:full"))
            db.add(models.NexusGroup(id=GROUP_V, name="Comp Test Viewers", allowed_modules="accounting:viewer"))
            db.add(models.NexusGroupMember(group_id=GROUP_F, email=FULL))
            db.add(models.NexusGroupMember(group_id=GROUP_F, email=LIMITED))
            db.add(models.NexusGroupMember(group_id=GROUP_V, email=VIEWER))
            db.add(models.NexusAccessScope(id=str(uuid.uuid4()), email=LIMITED, module_id="accounting", scope_type="ledger", scope_id="15000"))
            db.add(models.NexusRole(email=ADMIN, role="administrator"))
            # Valinda in People (her Intacct employee ID is her employee code) with a workers' comp rate.
            db.add(models.HrEntity(id=ENTITY, name="Oversite Management, Inc"))
            db.add(models.NexusEmployee(id=VALINDA, employee_code="E-0084", first_name="Valinda", last_name="Cranfill", work_email="Valinda@X.com",
                                        company=ENTITY, department="Operations", job_title="Area Manager III", status="active"))
            db.add(models.WorkersCompRate(id=str(uuid.uuid4()), employee_id=VALINDA, effective_year=2026, rate_pct=3.5, set_by=FULL, set_at="2026-10-28T00:00:00"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()

        def fake_people(db, month):
            return PEOPLE, cards(month)

        self.calls = []

        async def fake_get(path, params):
            self.calls.append((path, dict(params)))
            if path.endswith("/reports/buckets"):
                self.assertEqual(params["by"], "employee")
                return {"ok": True, "rows": valinda_rows() if params["from"].startswith("2026") else [], "labels": {"E-0084": "Valinda Cranfill"}}
            self.assertTrue(path.endswith("/search"))
            line = {"line_id": f"l-{params['account']}", "entry_id": "e1", "entry_no": "PYRJ-12", "entry_date": "2026-03-15" if params["account"] == "61908" else "2026-01-05",
                    "gl_code": params["account"], "account_name": "Bonus", "vendor_name": "", "memo": "Bonus", "debit": 850.0, "credit": 0.0}
            return {"rows": [line], "total": 1}

        self._people, accounting_allocations._people_and_cards = accounting_allocations._people_and_cards, fake_people
        self._get, accounting._acct_get = accounting._acct_get, fake_get

    def tearDown(self):
        accounting_allocations._people_and_cards, accounting._acct_get = self._people, self._get
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
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_((GROUP_F, GROUP_V))).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id.in_((GROUP_F, GROUP_V))).delete(synchronize_session=False)
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email == LIMITED).delete(synchronize_session=False)
            db.query(models.NexusRole).filter(models.NexusRole.email == ADMIN).delete(synchronize_session=False)
            db.query(models.WorkersCompRate).filter(models.WorkersCompRate.employee_id == VALINDA).delete(synchronize_session=False)
            db.query(models.NexusEmployee).filter(models.NexusEmployee.id == VALINDA).delete(synchronize_session=False)
            db.query(models.HrEntity).filter(models.HrEntity.id == ENTITY).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def test_viewer_and_nobody_are_refused(self):
        for who in (VIEWER, NOBODY):
            _as(who)
            self.assertEqual(self.client.get("/accounting/compensation/people?from=2026-09&to=2026-10").status_code, 403, who)
            self.assertEqual(self.client.get("/accounting/compensation/report?from=2026-09&to=2026-10").status_code, 403, who)
            self.assertEqual(self.client.get("/accounting/compensation/lines?from=2026-01-01&to=2026-12-31&employees=E-0084&accounts=61908").status_code, 403, who)

    def test_limited_full_person_is_refused(self):
        _as(LIMITED)
        r = self.client.get("/accounting/compensation/people?from=2026-09&to=2026-10")
        self.assertEqual(r.status_code, 403)
        self.assertIn("limited to certain entities", r.json()["detail"])

    def test_scoped_policy_all_lets_a_limited_full_person_read(self):
        _as(LIMITED)
        was, A.COMP_ENTITY_SCOPED_POLICY = A.COMP_ENTITY_SCOPED_POLICY, "all"
        try:
            self.assertEqual(self.client.get("/accounting/compensation/people?from=2026-09&to=2026-10").status_code, 200)
        finally:
            A.COMP_ENTITY_SCOPED_POLICY = was

    def test_controller_sees_what_a_global_admin_sees(self):
        """CR-02: Charmi (Controller - Full on Accounting, not an administrator,
        no entity rows) and Visesh (administrator) get the same report."""
        out = {}
        for who in (FULL, ADMIN):
            _as(who)
            r = self.client.get("/accounting/compensation/people?from=2026-01&to=2026-09")
            self.assertEqual(r.status_code, 200, (who, r.text))
            out[who] = r.json()
        self.assertEqual(out[FULL], out[ADMIN])
        self.assertEqual(len(out[FULL]["months"]), 9)

    def test_too_large_and_too_slow_answer_422_with_a_reason(self):
        _as(FULL)
        was = (A.COMP_MAX_PERSON_MONTHS, A.COMP_TIME_BUDGET_SEC)
        try:
            A.COMP_MAX_PERSON_MONTHS = -1
            r = self.client.get("/accounting/compensation/people?from=2026-01&to=2026-09")
            self.assertEqual((r.status_code, r.json()["detail"]["code"]), (422, "too_large"), r.text)
            A.COMP_MAX_PERSON_MONTHS, A.COMP_TIME_BUDGET_SEC = was[0], -1
            r = self.client.get("/accounting/compensation/people?from=2026-01&to=2026-09")
            self.assertEqual((r.status_code, r.json()["detail"]["code"]), (422, "too_slow"), r.text)
            self.assertIn("Pick fewer months", r.json()["detail"]["message"])
        finally:
            A.COMP_MAX_PERSON_MONTHS, A.COMP_TIME_BUDGET_SEC = was

    def test_full_level_reads_people(self):
        _as(FULL)
        r = self.client.get("/accounting/compensation/people?from=2026-09&to=2026-10")
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual((d["from"], d["to"], d["months"]), ("2026-09-01", "2026-10-31", ["2026-09", "2026-10"]))
        self.assertEqual(len(d["people"]), 2)
        self.assertNotIn("personalMin", d["people"][0])
        self.assertEqual(self.client.get("/accounting/compensation/ledger?from=2026-09&to=2026-10").status_code, 404, "the lower box's read is gone (item 16)")

    def test_report_is_the_ledger_with_people_and_workers_comp(self):
        """Items 11-14: Valinda's 2026 from the ledger, with her People record and
        workers' comp at the 2026 rate; the prior-year column is read too."""
        _as(FULL)
        r = self.client.get("/accounting/compensation/report?from=2026-01&to=2026-12")
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual((d["from"], d["to"], d["prior"]), ("2026-01-01", "2026-12-31", {"from": "2025-01-01", "to": "2025-12-31"}))
        buckets = sorted((p["from"], p["to"]) for path, p in self.calls if path.endswith("/reports/buckets"))
        self.assertEqual(buckets, [("2025-01-01", "2025-12-31"), ("2026-01-01", "2026-12-31")])
        (v,) = d["people"]
        self.assertEqual((v["code"], v["name"], v["email"], v["companyName"], v["department"], v["title"]),
                         ("E-0084", "Valinda Cranfill", "valinda@x.com", "Oversite Management, Inc", "Operations", "Area Manager III"))
        self.assertEqual((v["cur"]["payroll"], v["cur"]["bonus"]), (52123.06, 850.0))
        self.assertEqual((v["cur"]["workersComp"], v["prior"]["totalPayroll"]), (1854.06, 0.0))
        self.assertEqual(d["notInPeople"], 0)
        self.assertEqual(self.client.get("/accounting/compensation/report?from=2026-12&to=2026-01").status_code, 400)

    def test_lines_drill_down(self):
        """Item 17: the lines behind a figure - one search per account, the health
        split by side, sorted by date, the amount as on the report."""
        _as(FULL)
        r = self.client.get("/accounting/compensation/lines?from=2026-01-01&to=2026-12-31&employees=E-0084&accounts=61908,61903:c")
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        searches = {p["account"]: p for path, p in self.calls if path.endswith("/search")}
        self.assertEqual(set(searches), {"61908", "61903"})
        self.assertEqual(searches["61908"]["employee"], "E-0084")
        self.assertNotIn("credit_op", searches["61908"])
        self.assertEqual((searches["61903"]["credit_op"], searches["61903"]["credit_v"]), ("gt", 0))
        self.assertEqual([(x["date"], x["account"], x["amount"]) for x in d["lines"]], [("2026-01-05", "61903", 0.0), ("2026-03-15", "61908", 850.0)])
        self.assertFalse(d["truncated"])
        for q in ("employees=E-0084&accounts=61908;drop", "employees=E-0084&accounts=", "employees=&accounts=61908"):
            self.assertEqual(self.client.get(f"/accounting/compensation/lines?from=2026-01-01&to=2026-12-31&{q}").status_code, 400, q)
        self.assertEqual(self.client.get("/accounting/compensation/lines?from=2026-01&to=2026-12-31&employees=E-0084&accounts=61908").status_code, 400)


if __name__ == "__main__":
    unittest.main()
