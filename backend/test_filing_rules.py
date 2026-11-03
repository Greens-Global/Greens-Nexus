"""Filing & Sorting rules (filing_rules.py) - grammar + classifier + propose.

Driven by the four naming SOPs' own examples, so a rule change that breaks an
SOP example fails here. No network, no DB: filing_rules is pure.
Run alone, like every backend test file: python -m pytest test_filing_rules.py
"""
import unittest

import filing_rules as fr


def _maps():
    return fr.Maps(
        entities=["Greens Global, Inc", "Greens Global India, LLC", "MCD Service Inc"],
        facilities={"Escondido": "/Shared/--Operations/04 - Escondido",
                    "Temecula": "/Shared/--Operations/01 - Temecula",
                    "Murrieta": "/Shared/--Operations/03 - Murrieta"},
        projects={"Menifee": "/Shared/--Development/Projects/Menifee"},
    )


class TestParse(unittest.TestCase):
    def test_final_approved_plans(self):
        p = fr.parse_name("#2023-12-10 Architectural Plans Final Approved.pdf")
        self.assertTrue(p.final)
        self.assertEqual(p.date_str(), "2023-12-10")
        self.assertEqual(p.warnings, [])   # sanctioned 'Final Approved' phrase

    def test_type_prefix_dropped(self):
        p = fr.parse_name("Statement - 2023-01-15 - XYZ BOA - Loan Statement.pdf")
        self.assertEqual(p.date_str(), "2023-01-15")
        self.assertEqual(p.rest, "XYZ BOA - Loan Statement")
        self.assertTrue(any("prefix" in w for w in p.warnings))

    def test_auction_trailing_date(self):
        p = fr.parse_name("D001 - Tenant Name A - Auction - 2024-01-20.pdf")
        self.assertEqual(p.date_str(), "2024-01-20")
        self.assertEqual(fr.classify(p)[1], "auction")

    def test_month_only_vendor(self):
        p = fr.parse_name("January - Vendor A.pdf")
        self.assertEqual(p.date_precision, "none")   # month without year is not a date
        self.assertTrue(any("month name" in w for w in p.warnings))

    def test_banned_word_removed(self):
        p = fr.parse_name("2023-05-01 - Site Plans Current.pdf")
        self.assertTrue(any("banned" in w for w in p.warnings))
        self.assertNotIn("Current", p.rest)

    def test_final_without_hash_warns(self):
        p = fr.parse_name("2024-08-01 - Final Permit Approval.pdf")
        self.assertTrue(any("# prefix" in w for w in p.warnings))

    def test_uhaul_not_split(self):
        p = fr.parse_name("2024-01-02 - U-Haul Contract - John Doe.pdf")
        self.assertEqual(fr.classify(p)[1], "uhaul")
        self.assertIn("U-Haul", p.rest)

    def test_date_variants(self):
        for name, expected in [("2023.01.14 - ST.pdf", "2023-01-14"),
                               ("2023_01_14 - ST.pdf", "2023-01-14"),
                               ("2023-1-5 - ST.pdf", "2023-01-05")]:
            self.assertEqual(fr.parse_name(name).date_str(), expected, name)


class TestClassify(unittest.TestCase):
    def test_sop_examples(self):
        cases = [
            ("2023-01-14 - ST.pdf", "bank_statement"),
            ("2024-01-05 - Incident Report - Broken Pipe.pdf", "incident"),
            ("2024-01-01 - Certificate of Mailing - Tenant A.pdf", "cert_mailing"),
            ("2024-01-01 - Daily Close Report.pdf", "daily_close"),
            ("2023-07-10 - Grant Deed - John Doe.pdf", "general_project"),
            ("2023-01-15 - GS Escondido - Merchant Statement.pdf", "merchant_statement"),
            ("#2023 - Final Tax Return.pdf", "tax_return"),
            ("2024-12-01 - Lien Release Contractor.pdf", "closeout"),
            ("2022-11-12 - Architectural Plans.pdf", "plans"),
            ("2024-02-01 - Bio Report.pdf", "project_report"),
        ]
        for name, route in cases:
            hit = fr.classify(fr.parse_name(name))
            self.assertIsNotNone(hit, name)
            self.assertEqual(hit[1], route, name)

    def test_unmatched(self):
        self.assertIsNone(fr.classify(fr.parse_name("2019-09-07 - Sterling Ethanol Dividend.pdf")))


class TestPropose(unittest.TestCase):
    def test_not_confirmed_is_review(self):
        out = fr.propose("2024-01-05 - Incident Report - Escondido Broken Pipe.pdf",
                         "/Shared/#Unsorted", {}, _maps(), {})
        self.assertEqual(out["status"], "review")
        self.assertIn("04 - Escondido", out["destFolder"])   # proposal still built
        self.assertTrue(any("auto-filing" in r for r in out["reasons"]))

    def test_confirmed_goes_auto(self):
        out = fr.propose("2024-01-05 - Incident Report - Escondido Broken Pipe.pdf",
                         "/Shared/#Unsorted", {}, _maps(), {"incident": True})
        self.assertEqual(out["status"], "auto")
        self.assertEqual(out["destFolder"],
                         "/Shared/--Operations/04 - Escondido/01 - Daily Operations/"
                         "Incidents/2024/01 - January")
        self.assertEqual(out["newName"], "2024-01-05 - Incident Report - Escondido Broken Pipe.pdf")

    def test_missing_context_is_review(self):
        out = fr.propose("2024-01-05 - Incident Report - Broken Pipe.pdf",
                         "/Shared/#Unsorted", {}, _maps(), {"incident": True})
        self.assertEqual(out["status"], "review")
        self.assertTrue(any("facility" in r for r in out["reasons"]))

    def test_entity_from_root_context(self):
        out = fr.propose("2023-01-14 - ST.pdf",
                         "/Shared/#Entities/Greens Global, Inc/#Unsorted",
                         {"entity": "Greens Global, Inc"}, _maps(),
                         {"bank_statement": True})
        self.assertEqual(out["status"], "auto")
        self.assertEqual(out["destFolder"],
                         "/Shared/#Entities/Greens Global, Inc/Financials/"
                         "Bank Statements/2023/01 - January")
        self.assertEqual(out["newName"], "2023-01-14 - ST.pdf")

    def test_ambiguous_entity_is_review(self):
        # "Greens Global" appears in two entity names - never guess.
        out = fr.propose("2023-01-14 - Greens Global - ST.pdf",
                         "/Shared/#Unsorted", {}, _maps(), {"bank_statement": True})
        self.assertEqual(out["status"], "review")
        self.assertTrue(any("ambiguous" in r for r in out["reasons"]))

    def test_private_route_always_review(self):
        out = fr.propose("2024-01-10 - Contract General Contractor - Menifee.pdf",
                         "/Shared/#Unsorted", {}, _maps(), {"legal_financial": True})
        self.assertEqual(out["status"], "review")

    def test_review_always_cannot_be_confirmed_past(self):
        # Even a (bad) confirmed flag cannot push a review_always class to auto.
        out = fr.propose("2024-03-01 - Invoice - MCD Service Inc.pdf",
                         "/Shared/#Unsorted", {}, _maps(), {"invoice": True})
        self.assertEqual(out["status"], "review")

    def test_zip_parked(self):
        out = fr.propose("wetransfer_renderings.zip", "/Shared/#Unsorted", {}, _maps(), {})
        self.assertEqual(out["status"], "review")
        self.assertTrue(any("archive" in r for r in out["reasons"]))

    def test_facility_sop_spelling(self):
        out = fr.propose("2024-01-05 - Incident Report - Murietta Gate.pdf",
                         "/Shared/#Unsorted", {}, _maps(), {"incident": True})
        self.assertEqual(out["status"], "auto")
        self.assertIn("03 - Murrieta", out["destFolder"])


if __name__ == "__main__":
    unittest.main()
