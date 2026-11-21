"""The guarantee record on a loan (Neil, 11/21/2026) - the one shape, as tests.

    python -m pytest test_loan_guarantees.py -q
"""
import unittest

import loan_guarantees as lg


class TestLoanGuarantees(unittest.TestCase):
    def test_recourse_is_one_of_three_or_not_recorded(self):
        self.assertEqual([lg.clean_recourse(v) for v in ("full", "limited", "non_recourse", "", None, "  full ")],
                         ["full", "limited", "non_recourse", "", "", "full"])
        with self.assertRaises(lg.GuaranteeError):
            lg.clean_recourse("partial")

    def test_guarantors_are_kept_in_one_shape(self):
        got = lg.clean_guarantors([
            {"name": "  Asha   Greene ", "kind": "full", "amount": 500000, "burnOff": " Falls away at\n1.25x DSCR "},
            {"name": "Greene Family Trust", "kind": "limited", "amount": "2500000.456"},
            {"name": "Greens Holdings LLC", "kind": "carve_out", "amount": 1},
            {"name": "No Kind Given"},
        ])
        self.assertEqual(got, [
            {"name": "Asha Greene", "kind": "full", "amount": None, "burnOff": "Falls away at 1.25x DSCR"},      # a full guarantee has no amount
            {"name": "Greene Family Trust", "kind": "limited", "amount": 2500000.46, "burnOff": ""},
            {"name": "Greens Holdings LLC", "kind": "carve_out", "amount": None, "burnOff": ""},
            {"name": "No Kind Given", "kind": "full", "amount": None, "burnOff": ""},
        ])
        self.assertEqual((lg.clean_guarantors(None), lg.clean_guarantors([])), ([], []))
        long = lg.clean_guarantors([{"name": "N" * 500, "burnOff": "b" * 900}])[0]
        self.assertEqual((len(long["name"]), len(long["burnOff"])), (lg.NAME_MAX, lg.BURN_OFF_MAX))

    def test_what_cannot_be_kept_is_refused_in_plain_words(self):
        bad = [
            ({"not": "a list"}, "The guarantors are a list."),
            ([{"name": " "}], "Each guarantor needs a name."),
            (["Asha Greene"], "Each guarantor needs a name."),
            ([{"name": "Asha", "kind": "partial"}], "A guarantee is Full, Limited or Carve-Outs Only."),
            ([{"name": "Asha", "kind": "limited"}], "Asha: a limited guarantee needs its amount."),
            ([{"name": "Asha", "kind": "limited", "amount": 0}], "Asha: a limited guarantee needs its amount."),
            ([{"name": "Asha", "kind": "limited", "amount": "lots"}], "Asha: a limited guarantee needs its amount."),
            ([{"name": "Asha", "kind": "limited", "amount": float("nan")}], "Asha: a limited guarantee needs its amount."),
            ([{"name": f"G{i}"} for i in range(lg.MAX_GUARANTORS + 1)], f"A loan keeps {lg.MAX_GUARANTORS} guarantors at most."),
        ]
        for value, words in bad:
            with self.assertRaises(lg.GuaranteeError) as e:
                lg.clean_guarantors(value)
            self.assertEqual(str(e.exception), words)

    def test_a_row_reads_not_recorded_rather_than_breaking(self):
        self.assertEqual(lg.view({}), {"recourse": "", "guarantors": []})
        self.assertEqual(lg.view(None), {"recourse": "", "guarantors": []})
        # A stored value that no longer reads is left out; the good rows stay.
        got = lg.view({"recourse": "sideways", "guarantors": [{"name": ""}, {"name": "Asha Greene", "kind": "limited", "amount": 100}, "junk"]})
        self.assertEqual(got, {"recourse": "", "guarantors": [{"name": "Asha Greene", "kind": "limited", "amount": 100.0, "burnOff": ""}]})
        self.assertEqual(lg.view({"recourse": "non_recourse", "guarantors": None}), {"recourse": "non_recourse", "guarantors": []})


if __name__ == "__main__":
    unittest.main()
