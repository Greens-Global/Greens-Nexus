"""Federal forms package (Neil, 11/02/2026): the bundled W-4 2026, I-9
01/20/25 and our direct deposit authorization prepare into flat PDFs plus
Nexus Sign fields; formats, per-form rules and the edition watch.
    python -m pytest test_federal_forms.py
"""
import hashlib
import io
import os
import tempfile
import unittest
from datetime import date
# A throwaway sqlite of its own, so `python -m unittest test_federal_forms`
# never ALTERs or clears a local greens_nexus.db (CLAUDE.md: one file per
# process). This package needs no database; the header keeps the file safe
# beside the ones that do.
_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from pypdf import PdfReader  # noqa: E402

import federal_forms  # noqa: E402
from federal_forms import FORMS, check_map, prepare, registry  # noqa: E402
from federal_forms.editions import status  # noqa: E402
from federal_forms.formats import check, mask  # noqa: E402
from federal_forms.rules import validate  # noqa: E402

FIELD_KEYS = {"id", "role", "type", "page", "x", "y", "w", "h", "required", "label", "source"}
TYPES = {"text", "check", "radio", "date", "sign"}


def _by_id(fields):
    return {f["id"]: f for f in fields}


class PrepareTests(unittest.TestCase):
    def test_every_form_prepares_with_all_mapped_widgets_found(self):
        self.assertEqual(set(FORMS), {"w4", "i9", "direct_deposit"})
        for kind in FORMS:
            report = check_map(kind)
            self.assertEqual(report["missing"], [], f"{kind}: map entries with no widget")
            out = prepare(kind)
            self.assertGreaterEqual(out["pages"], 1)
            fields = out["fields"]
            self.assertTrue(fields, kind)
            ids = [f["id"] for f in fields]
            self.assertEqual(len(ids), len(set(ids)), f"{kind}: duplicate field ids")
            for f in fields:
                self.assertTrue(FIELD_KEYS <= set(f), f"{kind}: {f}")
                self.assertIn(f["type"], TYPES)
                self.assertIn(f["role"], ("employee", "hr", ""))
                self.assertIn(f["source"], ("person", "hr", "merge"))
                self.assertTrue(0 <= f["page"] < out["pages"])
                for k in ("x", "y", "w", "h"):
                    self.assertTrue(0.0 <= f[k] <= 1.0, f"{kind}:{f['id']}:{k}={f[k]}")
                self.assertLessEqual(f["x"] + f["w"], 1.0001)
                self.assertLessEqual(f["y"] + f["h"], 1.0001)
                if f["source"] == "merge":
                    self.assertIn(f["mergeKey"], registry.MERGE_KEYS)
                    self.assertFalse(f["required"])
                if f.get("format"):
                    self.assertEqual(check(f["format"], ""), "")
        # The W-4: Step 1(a)-(c), 2(c), 3, 4(a)-(c), Step 5 and the Employers
        # Only block, every one on page 1.
        w4 = _by_id(prepare("w4")["fields"])
        for fid in ("first_name_mi", "last_name", "ssn", "address", "city_state_zip",
                    "filing_single", "filing_joint", "filing_head", "step2c_two_jobs",
                    "step3_children", "step3_other_dependents", "step3_total",
                    "step4a_other_income", "step4b_deductions", "step4c_extra_withholding",
                    "exempt", "step5_signature", "step5_date",
                    "employer_name_address", "employer_first_date", "employer_ein"):
            self.assertIn(fid, w4)
            self.assertEqual(w4[fid]["page"], 0, fid)
        self.assertEqual(w4["ssn"]["format"], "ssn")
        self.assertTrue(w4["ssn"]["sensitive"])
        self.assertEqual(w4["step5_signature"]["type"], "sign")
        self.assertEqual(w4["step5_signature"]["role"], "employee")
        self.assertEqual(w4["step5_date"]["type"], "date")
        # The signature sits below Step 4(c) and above the Employers Only block.
        self.assertGreater(w4["step5_signature"]["y"], w4["step4c_extra_withholding"]["y"])
        self.assertLess(w4["step5_signature"]["y"], w4["employer_ein"]["y"])
        for fid, key in (("employer_name_address", "employer.name_address"),
                         ("employer_first_date", "person.first_day"),
                         ("employer_ein", "employer.ein")):
            self.assertEqual(w4[fid]["source"], "merge")
            self.assertEqual(w4[fid]["mergeKey"], key)
        self.assertEqual(w4["employer_ein"]["format"], "ein")
        # The I-9: Section 1 is the employee's, Section 2 is HR's, both on page 1.
        i9 = _by_id(prepare("i9")["fields"])
        for fid in ("last_name", "first_name", "ssn", "date_of_birth", "citizen_us",
                    "citizen_national", "citizen_lpr", "citizen_alien", "lpr_a_number",
                    "alien_a_number", "alien_i94", "alien_passport",
                    "employee_signature", "employee_date"):
            self.assertEqual(i9[fid]["role"], "employee", fid)
            self.assertEqual(i9[fid]["page"], 0, fid)
        for fid in ("a1_title", "a1_authority", "a1_number", "a1_expiry",
                    "b_title", "b_authority", "b_number", "b_expiry",
                    "c_title", "c_authority", "c_number", "c_expiry",
                    "additional_info", "first_day", "employer_rep_name_title",
                    "employer_signature", "employer_date", "business_name", "business_address"):
            self.assertEqual(i9[fid]["role"], "hr", fid)
            self.assertEqual(i9[fid]["page"], 0, fid)
        self.assertTrue(i9["ssn"]["sensitive"])
        # The identity numbers and the date of birth are sensitive too
        # (11/02/2026): encrypted at rest, masked to HR's screen, printed
        # only into the sealed PDF - the mask never shows a value.
        for fid in ("date_of_birth", "lpr_a_number", "alien_a_number", "alien_i94", "alien_passport"):
            self.assertTrue(i9[fid]["sensitive"], fid)
        for fid in ("last_name", "first_name", "city", "zip", "citizen_us", "employee_signature"):
            self.assertFalse(i9[fid].get("sensitive"), fid)
        self.assertEqual(i9["employee_signature"]["type"], "sign")
        self.assertEqual(i9["employer_signature"]["type"], "sign")
        self.assertEqual(i9["first_day"]["mergeKey"], "person.first_day")
        self.assertEqual(i9["business_name"]["mergeKey"], "employer.legal_name")
        # Supplements A and B are not mapped: nothing lands on pages 3-4.
        self.assertEqual({f["page"] for f in i9.values()}, {0})
        self.assertTrue(check_map("i9")["dropped"])
        # Direct deposit: ours, so every box is placed and every number sensitive.
        dd = _by_id(prepare("direct_deposit")["fields"])
        for fid in ("employee_name", "dd1_bank", "dd1_routing", "dd1_account",
                    "dd1_type_checking", "dd1_type_savings", "dd2_bank", "dd2_routing",
                    "dd2_account", "dd2_amount", "dd2_percent", "signature", "date"):
            self.assertIn(fid, dd)
        for fid in ("dd1_routing", "dd1_account", "dd2_routing", "dd2_account"):
            self.assertTrue(dd[fid]["sensitive"], fid)
        self.assertEqual(dd["dd1_routing"]["format"], "routing")
        self.assertEqual(dd["dd1_account"]["format"], "account")
        self.assertEqual(dd["signature"]["type"], "sign")
        self.assertEqual(check_map("direct_deposit"), {"missing": [], "dropped": []})

    def test_prepared_pdf_has_no_widgets(self):
        for kind in FORMS:
            out = prepare(kind)
            reader = PdfReader(io.BytesIO(out["pdf"]))
            self.assertEqual(len(reader.pages), out["pages"], kind)
            for page in reader.pages:
                for a in page.get("/Annots") or []:
                    self.assertNotEqual(a.get_object().get("/Subtype"), "/Widget", kind)
            self.assertFalse(reader.get_fields(), f"{kind}: AcroForm fields survived")
            self.assertNotIn("/AcroForm", reader.trailer["/Root"], kind)

    def test_bundled_pdfs_match_registry(self):
        for kind, spec in FORMS.items():
            raw = registry.pdf_bytes(kind)
            self.assertEqual(hashlib.sha256(raw).hexdigest(), spec["sha256"], kind)
            self.assertTrue(spec["source_url"].startswith("https://") or kind == "direct_deposit")
            self.assertIn("employee", spec["roles"])
            self.assertTrue(spec["us_only"])
            self.assertEqual(spec["worker_types"], ["employee"])
        self.assertEqual(FORMS["i9"]["roles"], ["employee", "hr"])
        self.assertEqual(FORMS["w4"]["roles"], ["employee"])
        self.assertEqual(FORMS["w4"]["editionLabel"], "2026")
        self.assertEqual(FORMS["i9"]["editionLabel"], "01/20/25")
        self.assertIs(federal_forms.prepare, prepare)


class FormatTests(unittest.TestCase):
    def test_ssn_rules(self):
        self.assertEqual(check("ssn", "123-45-6789"), "")
        self.assertEqual(check("ssn", "123456789"), "")
        self.assertEqual(check("ssn", "899-99-9999"), "")
        self.assertEqual(check("ssn", ""), "")          # required-ness is not the format's job
        # Review Focus 4
        for bad in ("000-12-3456", "666-12-3456", "900-12-3456", "999-12-3456",
                    "123-00-4567", "123-45-0000", "12-345-6789", "123-45-678",
                    "1234567890", "abc-de-fghi"):
            self.assertNotEqual(check("ssn", bad), "", bad)
            self.assertTrue(check("ssn", bad).endswith("."), bad)

    def test_routing_checksum(self):
        self.assertEqual(check("routing", "021000021"), "")
        self.assertEqual(check("routing", "011000015"), "")
        self.assertEqual(check("routing", "021 000 021"), "")
        for bad in ("123456789", "021000022", "12345678", "0210000211", "abcdefghi"):
            self.assertNotEqual(check("routing", bad), "", bad)

    def test_other_formats(self):
        self.assertEqual(check("account", "1234"), "")
        self.assertEqual(check("account", "1" * 17), "")
        self.assertNotEqual(check("account", "123"), "")
        self.assertNotEqual(check("account", "1" * 18), "")
        self.assertEqual(check("ein", "12-3456789"), "")
        self.assertNotEqual(check("ein", "00-3456789"), "")
        self.assertNotEqual(check("ein", "1234567"), "")
        self.assertEqual(check("zip", "92562"), "")
        self.assertEqual(check("zip", "92562-1234"), "")
        self.assertNotEqual(check("zip", "9256"), "")
        self.assertEqual(check("date_mmddyyyy", "11/02/2026"), "")
        self.assertNotEqual(check("date_mmddyyyy", "2026-11-02"), "")
        self.assertNotEqual(check("date_mmddyyyy", "13/02/2026"), "")
        self.assertNotEqual(check("date_mmddyyyy", "N/A"), "")
        self.assertEqual(check("date_or_na", "N/A"), "")
        self.assertEqual(check("date_or_na", "05/31/2027"), "")
        self.assertNotEqual(check("date_or_na", "soon"), "")
        self.assertEqual(check("alien_number", "A123456789"), "")
        self.assertEqual(check("alien_number", "1234567"), "")
        self.assertNotEqual(check("alien_number", "123"), "")
        self.assertEqual(check("i94", "12345678901"), "")
        self.assertEqual(check("i94", "123456789A1"), "")
        self.assertNotEqual(check("i94", "1234"), "")
        self.assertEqual(check("passport", "X1234567 Mexico"), "")
        self.assertNotEqual(check("passport", "ab"), "")
        self.assertEqual(check("money", "1,250.00"), "")
        self.assertNotEqual(check("money", "lots"), "")
        self.assertEqual(check("percent", "40"), "")
        self.assertNotEqual(check("percent", "140"), "")
        self.assertEqual(check("nothing_like_this", "whatever"), "")

    def test_mask_never_returns_the_value(self):
        # The sensitive mask: digits of a known number format, the blank
        # shape for everything else - a passport or a box with no format
        # included (11/02/2026).
        self.assertEqual(mask("ssn", "123-45-6789"), "***-**-6789")
        self.assertEqual(mask("routing", "021000021"), "••••0021")
        self.assertEqual(mask("account", "000123456789"), "••••6789")
        self.assertEqual(mask("ein", "12-3456789"), "••89")
        self.assertEqual(mask("alien_number", "A123456789"), "••89")
        self.assertEqual(mask("i94", "123456789A1"), "••91")
        self.assertEqual(mask("passport", "X1234567 Mexico"), "•••••")
        self.assertEqual(mask("", "a plain secret"), "•••••")
        self.assertEqual(mask("nothing_like_this", "a plain secret"), "•••••")
        self.assertEqual(mask("date_mmddyyyy", "01/02/1990"), "•••••")
        for fmt in ("", "passport", "ssn", "ein", "account"):
            self.assertTrue(mask(fmt, ""), fmt)
            self.assertNotIn("secret", mask(fmt, "secret 42"))


class EditionTests(unittest.TestCase):
    def test_w4_edition_status_dates(self):
        self.assertEqual(status("w4", date(2026, 11, 30))["state"], "ok")
        # Review Focus 5: HR hears about the January update from 12/01 ...
        s = status("w4", date(2026, 12, 1))
        self.assertEqual(s["state"], "expiring")
        self.assertIn("January", s["message"])
        self.assertEqual(s["message"], "The 2027 Form W-4 is due in January. The 2026 edition in Nexus "
                                       "can be sent through 01/31/2027.")
        self.assertEqual(s["expires"], "01/31/2027")
        # ... January is the grace month (Neil, 11/02/2026): a 2026 W-4 registered
        # on 01/15/2027 still goes out, and from 02/01/2027 it is refused.
        s = status("w4", date(2027, 1, 15))
        self.assertEqual(s["state"], "expiring")
        self.assertEqual(status("w4", date(2027, 1, 31))["state"], "expiring")
        s = status("w4", date(2027, 2, 1))
        self.assertEqual(s["state"], "expired")
        self.assertIn("2026", s["message"])
        self.assertIn("01/31/2027", s["message"])
        self.assertIn("expired", s["message"])
        self.assertIn("administrator", s["message"])
        self.assertNotRegex(s["message"], r"\d{4}-\d{2}-\d{2}")   # MM/DD/YYYY, never ISO
        self.assertEqual(status("w4", date(2027, 6, 1))["state"], "expired")

    def test_i9_edition_expires_05_31_2027(self):
        self.assertEqual(FORMS["i9"]["expires"], "2027-05-31")
        self.assertEqual(status("i9", date(2027, 3, 31))["state"], "ok")
        s = status("i9", date(2027, 4, 1))
        self.assertEqual(s["state"], "expiring")
        self.assertIn("05/31/2027", s["message"])
        self.assertEqual(status("i9", date(2027, 5, 31))["state"], "expiring")
        s = status("i9", date(2027, 6, 1))
        self.assertEqual(s["state"], "expired")
        self.assertIn("05/31/2027", s["message"])
        self.assertIn("01/20/25", s["message"])
        # Our own form never lapses.
        self.assertEqual(status("direct_deposit", date(2040, 1, 1))["state"], "ok")
        self.assertEqual(status("w4")["state"], status("w4", date.today())["state"])


class RuleTests(unittest.TestCase):
    def test_w4_single_filing_status(self):
        base = {"first_name_mi": "Ana", "last_name": "Diaz"}
        errs = validate("w4", "employee", base)
        self.assertEqual([e["field"] for e in errs], ["filing_single"])
        self.assertIn("one filing status", errs[0]["message"])
        two = dict(base, filing_single=True, filing_head="true")
        self.assertEqual(len(validate("w4", "employee", two)), 1)
        one = dict(base, filing_joint="on")
        self.assertEqual(validate("w4", "employee", one), [])
        # Nobody else signs a W-4; the rule set is the employee's.
        self.assertEqual(validate("w4", "hr", {}), [])

    def test_i9_section1_citizenship(self):
        self.assertTrue(validate("i9", "employee", {}))
        two = {"citizen_us": True, "citizen_lpr": True}
        self.assertEqual([e["field"] for e in validate("i9", "employee", two)], ["citizen_us"])
        lpr = {"citizen_lpr": True}
        errs = validate("i9", "employee", lpr)
        self.assertEqual([e["field"] for e in errs], ["lpr_a_number"])
        self.assertEqual(validate("i9", "employee", dict(lpr, lpr_a_number="A12345678")), [])
        alien = {"citizen_alien": "1"}
        self.assertEqual([e["field"] for e in validate("i9", "employee", alien)], ["alien_a_number"])
        self.assertEqual(validate("i9", "employee", dict(alien, alien_i94="12345678901")), [])
        self.assertEqual(validate("i9", "employee", {"citizen_us": "x"}), [])

    def test_i9_section2_list_rules(self):
        list_a = {"a1_title": "U.S. Passport", "a1_authority": "U.S. Department of State",
                  "a1_number": "123456789", "a1_expiry": "05/31/2030"}
        list_b = {"b_title": "Driver's License", "b_authority": "California DMV",
                  "b_number": "D1234567", "b_expiry": "01/01/2030"}
        list_c = {"c_title": "Social Security Card", "c_authority": "SSA",
                  "c_number": "123-45-6789", "c_expiry": "N/A"}
        day = {"first_day": "11/09/2026"}
        self.assertEqual(validate("i9", "hr", {**list_a, **day}), [])
        self.assertEqual(validate("i9", "hr", {**list_b, **list_c, **day}), [])
        # Nothing presented
        errs = validate("i9", "hr", day)
        self.assertTrue(errs)
        self.assertEqual(errs[0]["field"], "a1_title")
        # List B alone
        errs = validate("i9", "hr", {**list_b, **day})
        self.assertIn("c_title", [e["field"] for e in errs])
        # List C alone
        errs = validate("i9", "hr", {**list_c, **day})
        self.assertIn("b_title", [e["field"] for e in errs])
        # List A and List B together
        errs = validate("i9", "hr", {**list_a, **list_b, **list_c, **day})
        self.assertEqual([e["field"] for e in errs], ["b_title"])
        # A List A document with a missing part
        partial = dict(list_a); partial.pop("a1_authority")
        errs = validate("i9", "hr", {**partial, **day})
        self.assertEqual([e["field"] for e in errs], ["a1_authority"])
        # The expiry may be N/A but not a blank
        no_exp = dict(list_a, a1_expiry="")
        self.assertEqual([e["field"] for e in validate("i9", "hr", {**no_exp, **day})], ["a1_expiry"])
        # First day of employment is required
        errs = validate("i9", "hr", list_a)
        self.assertEqual([e["field"] for e in errs], ["first_day"])
        # Section 2 rules never run for the employee
        self.assertNotIn("first_day", [e["field"] for e in validate("i9", "employee", {"citizen_us": True})])

    def test_direct_deposit_split(self):
        one = {"employee_name": "Ana Diaz", "dd1_bank": "Chase", "dd1_routing": "021000021",
               "dd1_account": "12345678", "dd1_type_checking": True}
        self.assertEqual(validate("direct_deposit", "employee", one), [])
        # Account type is one of the two
        both = dict(one, dd1_type_savings=True)
        self.assertEqual([e["field"] for e in validate("direct_deposit", "employee", both)],
                         ["dd1_type_checking"])
        none = dict(one); none.pop("dd1_type_checking")
        self.assertEqual([e["field"] for e in validate("direct_deposit", "employee", none)],
                         ["dd1_type_checking"])
        # A second account needs its own bank, routing, account, type and a split
        two = dict(one, dd2_bank="Wells Fargo", dd2_routing="121000248", dd2_account="98765432",
                   dd2_type_savings="on")
        errs = validate("direct_deposit", "employee", two)
        self.assertEqual([e["field"] for e in errs], ["dd2_amount"])
        self.assertEqual(validate("direct_deposit", "employee", dict(two, dd2_amount="250")), [])
        self.assertEqual(validate("direct_deposit", "employee",
                                  dict(two, dd1_percent="60", dd2_percent="40")), [])
        errs = validate("direct_deposit", "employee", dict(two, dd1_percent="60", dd2_percent="50"))
        self.assertEqual([e["field"] for e in errs], ["dd2_percent"])
        self.assertIn("100", errs[0]["message"])
        # Half a second account is an error, not ignored
        half = dict(one, dd2_routing="121000248")
        self.assertIn("dd2_bank", [e["field"] for e in validate("direct_deposit", "employee", half)])


if __name__ == "__main__":
    unittest.main()
