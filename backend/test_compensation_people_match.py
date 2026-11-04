"""Compensation: who a ledger employee is, and overtime as its own line
(Teams "Nexus - Accounting", 11/05/2026).

Intacct's E-0047 (Nishita Shah) carried Charmi's work email, so the employee
code sync gave Charmi the code and the report showed Nishita's pay under
Charmi's name and photo. A code whose People name is somebody else is not
trusted; a person whose People record has no code is found by an exact,
unique name.

Run alone: python -m pytest test_compensation_people_match.py
"""
import unittest

from routers.accounting_compensation import build_report, comp_line, match_person, with_totals


def _people():
    charmi = {"name": "Charmi Desai", "email": "charmi@x.com", "active": True}
    amy = {"name": "Amy Lee", "email": "amy@x.com", "active": False}
    return {"E-0047": charmi, "__by_name__": {"amy lee": [amy], "sam roe": [{"name": "Sam Roe"}, {"name": "Sam Roe"}]}}


class MatchPersonTests(unittest.TestCase):
    def test_code_naming_somebody_else_is_not_trusted(self):
        got = match_person(_people(), "E-0047", "E-0047--Nishita Shah")
        self.assertEqual(got, {"mismatch": "Charmi Desai"})

    def test_code_with_the_same_person_is_used(self):
        self.assertEqual(match_person(_people(), "E-0047", "Desai, Charmi")["email"], "charmi@x.com")
        self.assertEqual(match_person(_people(), "E-0047", "")["email"], "charmi@x.com")

    def test_no_code_falls_back_to_a_unique_name(self):
        self.assertEqual(match_person(_people(), "E-0099", "E-0099--Amy Lee")["email"], "amy@x.com")
        self.assertEqual(match_person(_people(), "E-0098", "Sam Roe"), {})   # two Sam Roes: no guess
        self.assertEqual(match_person(_people(), "E-0097", "Nobody Here"), {})

    def test_report_row_says_why_and_keeps_the_ledger_name(self):
        data = {"rows": [{"bucket": "E-0047--Nishita Shah", "section": "expense", "account_no": "61904",
                          "title": "Salaries", "debit": 7700, "credit": 0}], "labels": {"E-0047--Nishita Shah": "Nishita Shah"}}
        rows = build_report([("cur", 2026, data)], {}, _people())
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["name"], "Nishita Shah")
        self.assertEqual(rows[0]["email"], "")
        self.assertEqual(rows[0]["nameMismatch"], "Charmi Desai")

    def test_inactive_flag_travels(self):
        data = {"rows": [{"bucket": "E-0099--Amy Lee", "section": "expense", "account_no": "61904",
                          "title": "Salaries", "debit": 100, "credit": 0}], "labels": {}}
        rows = build_report([("cur", 2026, data)], {}, _people())
        self.assertFalse(rows[0]["active"])


class OvertimeLineTests(unittest.TestCase):
    def test_overtime_account_is_its_own_line(self):
        self.assertEqual(comp_line("expense", "61909", "Overtime"), "overtime")
        self.assertEqual(comp_line("expense", "", "Double Time Wages"), "overtime")
        self.assertEqual(comp_line("expense", "61904", "Salaries"), "payroll")

    def test_overtime_counts_in_payroll_and_net_pay(self):
        v = with_totals({"payroll": 1000, "overtime": 150})
        self.assertEqual(v["totalPayroll"], 1150)
        self.assertEqual(v["netPay"], 1150)


if __name__ == "__main__":
    unittest.main()
