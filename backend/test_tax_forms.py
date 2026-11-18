"""Accounting > Reports > Tax (Charmi, 11/19/2026: "We need Sch C, Sch E,
1040, 1065, form 568, 1120") - as tests. The forms live in one data file
each (frontend/src/components/accounting/taxForms/*.json); the API keeps the
lines it may store in tax_forms.py. These tests hold the two together and
check each file is a well-formed form.

    python -m pytest test_tax_forms.py -q      (one file per process)
"""
import json
import pathlib
import unittest

import tax_forms
from routers import accounting_tax_lines

DIR = pathlib.Path(__file__).resolve().parent.parent / "frontend" / "src" / "components" / "accounting" / "taxForms"
FILES = {"schedule_c", "schedule_e", "form_1065", "form_1120", "ca_568", "form_1040"}


def load(name):
    return json.loads((DIR / f"{name}.json").read_text(encoding="utf-8"))


def mappable(form):
    lines = {r["line"] for rep in form["reports"] for r in rep["rows"] if "sign" in r}
    lines |= {r["line"] for r in form.get("returns", [])}
    return lines | {"skip"}


class TaxFormFiles(unittest.TestCase):
    def test_every_form_has_its_file_and_the_api_stores_exactly_its_lines(self):
        self.assertEqual({p.stem for p in DIR.glob("*.json")}, FILES)
        self.assertEqual(set(tax_forms.FORMS), FILES)
        for name in FILES:
            with self.subTest(form=name):
                self.assertEqual(mappable(load(name)), tax_forms.FORMS[name])
        self.assertIs(accounting_tax_lines.FORMS, tax_forms.FORMS)

    def test_each_file_is_a_well_formed_form(self):
        for name in FILES:
            form = load(name)
            with self.subTest(form=name):
                self.assertEqual(form["form"], name)
                self.assertEqual(form["taxYear"], 2025)
                self.assertIn(2026, form["years"])
                for rep in form["reports"]:
                    ids = [r["line"] for r in rep["rows"] if "line" in r]
                    self.assertEqual(len(ids), len(set(ids)), f"{rep['key']}: a line id twice")
                    known = set(ids)
                    groups = {r.get("group") for r in rep["rows"] if "sign" in r}
                    for r in rep["rows"]:
                        if "heading" in r:
                            continue
                        kinds = [k for k in ("sign", "calc", "manual", "fee", "fixed", "from") if k in r]
                        self.assertEqual(len(kinds), 1, f"{rep['key']} line {r['line']}: one kind only, got {kinds}")
                        self.assertTrue(r["label"] and "—" not in r["label"], f"{rep['key']} line {r['line']}: plain hyphens")
                        for tok in r.get("calc", []):
                            t = tok.lstrip("-")
                            if t.startswith("@group:"):
                                self.assertIn(t[7:], groups, f"{rep['key']}: no group {t}")
                            elif t.startswith(("@pos:", "@neg:")):
                                self.assertIn(t[5:], known)
                            elif t.startswith("@"):
                                self.assertIn(t, {"@net", "@skipnet", "@unmappednet", "@income"})
                            else:
                                self.assertIn(t, known, f"{rep['key']} line {r['line']}: unknown line {t}")
                        if "fee" in r:
                            self.assertIn(r["fee"], known)
                            self.assertTrue(rep.get("feeTiers"))
                    for label, line, *_ in rep.get("summary", []):
                        self.assertIn(line, known, f"{rep['key']} summary {label}")
                # Every suggested line is a line the form can store.
                for section, rules in (form.get("suggest") or {}).items():
                    if section in ("never",):
                        continue
                    sets = rules.items() if isinstance(rules, dict) else [(section, rules)]
                    for _sec, rr in sets:
                        for _rx, line in rr:
                            if line:    # '' = deliberately no suggestion - the account waits for review
                                self.assertIn(line, tax_forms.FORMS[name], f"{name} suggests {line}")

    def test_the_california_llc_fee_tiers(self):
        rep = load("ca_568")["reports"][0]
        self.assertEqual(rep["feeTiers"], [[250000, 0], [500000, 900], [1000000, 2500], [5000000, 6000], [None, 11790]])
        annual = next(r for r in rep["rows"] if r.get("line") == "s3")
        self.assertEqual(annual["fixed"], 800)


if __name__ == "__main__":
    unittest.main()
