"""Loan terms typed in Asset Management, offered to Accounting > Loans - as tests.

The rules only (loan_term_suggest.py has no database and no network): which
property's typed debt is which loan (the loan number, then the lender, then
the entity's only loan), inside the property's own ledger entity; which typed
values read as one term; what is never offered (a term the loan already has,
a closed loan, two properties that disagree, an index plus a spread, a year
alone, a property with no ledger entity).

    python -m pytest test_loan_term_suggest.py -q
"""
import unittest

from loan_term_suggest import parse_day, parse_rate, parse_rate_type, property_row, snapshot_value, suggest

REACH = {"63000": {"63000", "63001"}, "15000": {"15000"}, "64000": {"64000", "64001"}}


def loan(id, lender, entity, **kw):
    return {"id": id, "lender": lender, "glTitle": kw.pop("glTitle", lender), "loanNo": kw.pop("loanNo", ""), "loanNumber": kw.pop("loanNumber", ""),
            "entityCode": entity, "ratePct": kw.pop("ratePct", None), "maturity": kw.pop("maturity", None), "closed": kw.pop("closed", False)}


def prop(id, name, entity, **kw):
    return {"id": id, "name": name, "entityCode": entity, "lender": kw.get("lender", ""), "loanNumber": kw.get("loanNumber", ""),
            "maturity": kw.get("maturity", ""), "rate": kw.get("rate", ""), "rateType": kw.get("rateType", "")}


class Parsing(unittest.TestCase):
    def test_a_whole_date_in_the_ways_people_type_it(self):
        self.assertEqual(parse_day("06/01/2031"), "2031-06-01")
        self.assertEqual(parse_day("6/1/31"), "2031-06-01")
        self.assertEqual(parse_day("2031-06-01"), "2031-06-01")
        self.assertEqual(parse_day("June 1, 2031"), "2031-06-01")
        self.assertEqual(parse_day("Sept 15 2030"), "2030-09-15")

    def test_not_a_whole_date_is_not_guessed(self):
        for text in ("", "2031", "June 2031", "TBD", "13/45/2031", "02/30/2031", "5 years"):
            self.assertIsNone(parse_day(text), text)

    def test_one_plain_rate(self):
        self.assertEqual(parse_rate("6.25%"), 6.25)
        self.assertEqual(parse_rate("4.5"), 4.5)
        self.assertEqual(parse_rate("Fixed 5.125 %"), 5.125)

    def test_a_spread_a_range_or_nonsense_is_not_a_rate(self):
        for text in ("", "SOFR + 2.5", "Prime+1", "4.5 - 5.0", "4 to 5", "0", "45", "variable"):
            self.assertIsNone(parse_rate(text), text)

    def test_rate_type_words(self):
        self.assertEqual(parse_rate_type("Fixed", "6.25%"), "fixed")
        self.assertEqual(parse_rate_type("", "Floating 6%"), "variable")
        self.assertEqual(parse_rate_type("", "6.25%"), "")

    def test_snapshot_value_reads_the_grouped_sheet(self):
        payload = {"snapshot": [{"group": "Debt", "fields": [{"label": "Lender", "value": " Harbor Bank "}, {"label": "Maturity Date", "value": "06/01/2031"}, {"label": "Loan Number", "value": ""}]}]}
        self.assertEqual(snapshot_value(payload, "Lender"), "Harbor Bank")
        self.assertEqual(snapshot_value(payload, "Maturity Date", "Maturity"), "06/01/2031")
        self.assertEqual(snapshot_value(payload, "Loan Number"), "")
        self.assertEqual(snapshot_value({}, "Lender"), "")
        row = property_row("p1", {"name": "Oak Street", "entityCode": " 63000 ", **payload})
        self.assertEqual((row["id"], row["name"], row["entityCode"], row["lender"], row["maturity"]), ("p1", "Oak Street", "63000", "Harbor Bank", "06/01/2031"))


class Matching(unittest.TestCase):
    def test_the_loan_number_ties_a_property_to_its_loan(self):
        loans = [loan("L1", "F&M Loan #6870", "63001"), loan("L2", "F&M Loan #9912", "63001")]
        props = [prop("p1", "Oak Street", "63000", lender="Farmers & Merchants", loanNumber="100-446870", maturity="06/01/2031", rate="6.25%", rateType="Fixed")]
        self.assertEqual(suggest(loans, props, REACH), [
            {"loanId": "L1", "propertyId": "p1", "propertyName": "Oak Street", "why": "number", "maturity": "2031-06-01", "ratePct": 6.25, "rateType": "fixed"}])

    def test_the_loans_own_number_wins_over_its_name(self):
        loans = [loan("L1", "Harbor Bank", "15000", loanNumber="77-1234"), loan("L2", "Harbor Bank", "15000", loanNumber="77-5678")]
        props = [prop("p1", "Canyon Store", "15000", lender="Harbor Bank", loanNumber="77 5678", maturity="01/15/2030")]
        self.assertEqual([(o["loanId"], o["why"]) for o in suggest(loans, props, REACH)], [("L2", "number")])

    def test_the_lender_ties_it_when_only_one_loan_is_that_lenders(self):
        loans = [loan("L1", "N/P Pacific Crest Bank", "15000"), loan("L2", "Golden Credit Union LOC", "15000")]
        props = [prop("p1", "Canyon Store", "15000", lender="Pacific Crest", rate="5.5")]
        self.assertEqual(suggest(loans, props, REACH), [{"loanId": "L1", "propertyId": "p1", "propertyName": "Canyon Store", "why": "lender", "ratePct": 5.5}])

    def test_two_loans_from_one_lender_and_no_number_offers_nothing(self):
        loans = [loan("L1", "Harbor Bank Loan A", "15000"), loan("L2", "Harbor Bank Loan B", "15000")]
        props = [prop("p1", "Canyon Store", "15000", lender="Harbor Bank", maturity="01/15/2030")]
        self.assertEqual(suggest(loans, props, REACH), [])

    def test_lenders_that_only_share_a_word_are_different_lenders(self):
        loans = [loan("L1", "First Citizens", "15000")]
        props = [prop("p1", "Canyon Store", "15000", lender="First Republic", maturity="01/15/2030")]
        self.assertEqual(suggest(loans, props, REACH), [])

    def test_the_only_loan_of_the_entity_when_its_name_says_no_lender(self):
        loans = [loan("L1", "Note Payable", "64001", glTitle="Mortgage Loan")]
        props = [prop("p1", "Rainbow Lot", "64000", lender="Harbor Bank", maturity="03/01/2029")]
        self.assertEqual([(o["loanId"], o["why"], o["maturity"]) for o in suggest(loans, props, REACH)], [("L1", "only", "2029-03-01")])
        # A named loan that is not this lender's is never taken as "the only one".
        named = [loan("L1", "Golden Credit Union", "64001")]
        self.assertEqual(suggest(named, props, REACH), [])

    def test_only_inside_the_propertys_own_entity(self):
        loans = [loan("L1", "Harbor Bank", "15000")]
        props = [prop("p1", "Oak Street", "63000", lender="Harbor Bank", maturity="06/01/2031"),
                 prop("p2", "Not Linked", "", lender="Harbor Bank", maturity="06/01/2031")]
        self.assertEqual(suggest(loans, props, REACH), [])


class Offers(unittest.TestCase):
    def test_a_term_the_loan_has_is_left_alone(self):
        loans = [loan("L1", "Harbor Bank", "15000", maturity="2032-01-01")]
        props = [prop("p1", "Canyon Store", "15000", lender="Harbor Bank", maturity="06/01/2031", rate="6%")]
        self.assertEqual(suggest(loans, props, REACH), [{"loanId": "L1", "propertyId": "p1", "propertyName": "Canyon Store", "why": "lender", "ratePct": 6.0}])
        full = [loan("L1", "Harbor Bank", "15000", maturity="2032-01-01", ratePct=5.0)]
        self.assertEqual(suggest(full, props, REACH), [])

    def test_a_rate_of_zero_on_the_loan_is_a_rate(self):
        loans = [loan("L1", "Harbor Bank", "15000", ratePct=0, maturity="2032-01-01")]
        props = [prop("p1", "Canyon Store", "15000", lender="Harbor Bank", rate="6%")]
        self.assertEqual(suggest(loans, props, REACH), [])

    def test_a_closed_loan_is_never_offered(self):
        loans = [loan("L1", "Harbor Bank", "15000", closed=True)]
        props = [prop("p1", "Canyon Store", "15000", lender="Harbor Bank", maturity="06/01/2031")]
        self.assertEqual(suggest(loans, props, REACH), [])

    def test_parcels_that_agree_are_one_offer_and_parcels_that_disagree_offer_nothing_for_that_term(self):
        loans = [loan("L1", "Harbor Bank", "63001")]
        agree = [prop("p1", "Lot 1", "63000", lender="Harbor Bank", maturity="06/01/2031", rate="6.25%"),
                 prop("p2", "Lot 2", "63000", lender="Harbor Bank", maturity="6/1/31")]
        self.assertEqual(suggest(loans, agree, REACH), [{"loanId": "L1", "propertyId": "p1", "propertyName": "Lot 1", "why": "lender", "maturity": "2031-06-01", "ratePct": 6.25}])
        differ = [prop("p1", "Lot 1", "63000", lender="Harbor Bank", maturity="06/01/2031", rate="6.25%"),
                  prop("p2", "Lot 2", "63000", lender="Harbor Bank", maturity="06/01/2032")]
        self.assertEqual(suggest(loans, differ, REACH), [{"loanId": "L1", "propertyId": "p1", "propertyName": "Lot 1", "why": "lender", "ratePct": 6.25}])

    def test_a_value_that_does_not_read_as_one_term_is_not_offered(self):
        loans = [loan("L1", "Harbor Bank", "15000")]
        props = [prop("p1", "Canyon Store", "15000", lender="Harbor Bank", maturity="2031", rate="SOFR + 2.5")]
        self.assertEqual(suggest(loans, props, REACH), [])


if __name__ == "__main__":
    unittest.main()
