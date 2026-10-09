"""Unsecured Promissory Note starter (Sep 29) - pinned.

The note is the first starter that ships typed field definitions and signer
roles, so this checks the three things that would silently break a generated
note: every merge field in the body has a definition (an undefined token
renders as an empty gap in a loan document), the money and date fields are
typed so the fill form validates them, and the seeder stays add-if-missing.

    python -m unittest test_documents_promissory_note
"""
import os
import tempfile
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

# Throwaway database - see test_document_module_requirements.py for why.
_TEST_DB = os.path.join(tempfile.gettempdir(), "nexus_doc_promissory_test.db")
if os.path.exists(_TEST_DB):
    os.remove(_TEST_DB)
os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DB}"

from routers import documents as docs  # noqa: E402
from services.merge_fields import BUILTIN_VARIABLES  # noqa: E402

NOTE = "Unsecured Promissory Note"


def _tokens(node, out=None):
    """Every mergeField token in a TipTap tree, in document order."""
    out = [] if out is None else out
    if isinstance(node, dict):
        if node.get("type") == "mergeField":
            out.append(node["attrs"]["token"])
        for child in node.get("content") or []:
            _tokens(child, out)
    return out


def _text(node):
    if isinstance(node, dict):
        return (node.get("text") or "") + "".join(_text(c) for c in node.get("content") or [])
    return ""


class PromissoryNoteContentTests(unittest.TestCase):
    def setUp(self):
        self.body = docs._promissory_note_content()
        self.defs = {d["token"]: d for d in docs._clean_field_defs(docs._PROMISSORY_NOTE_FIELDS)}

    def test_every_merge_field_in_the_body_is_defined(self):
        builtin = {t for t, _, _ in BUILTIN_VARIABLES}
        missing = sorted({t for t in _tokens(self.body) if t not in self.defs and t not in builtin})
        self.assertEqual(missing, [])

    def test_every_definition_is_used_in_the_body(self):
        used = set(_tokens(self.body))
        self.assertEqual(sorted(set(self.defs) - used), [])

    def test_the_figures_are_typed_so_the_fill_form_validates_them(self):
        self.assertEqual(self.defs["loan.principal"]["type"], "currency")
        self.assertEqual(self.defs["loan.installment_amount"]["type"], "currency")
        self.assertEqual(self.defs["loan.interest_rate"]["type"], "number")
        for token in ("note.date", "loan.first_payment_date", "loan.maturity_date"):
            self.assertEqual(self.defs[token]["type"], "date", token)
        self.assertEqual(self.defs["loan.payment_frequency"]["options"], ["monthly", "quarterly", "annual"])
        self.assertEqual(self.defs["loan.purpose"]["options"], ["business or commercial", "personal, family or household"])
        # The policy figures carry defaults; the deal terms do not.
        self.assertEqual(self.defs["loan.late_grace_days"]["default"], "10")
        self.assertEqual(self.defs["loan.late_fee_percent"]["default"], "5")
        self.assertEqual(self.defs["loan.cure_days"]["default"], "10")
        self.assertEqual(self.defs["loan.principal"]["default"], "")

    def test_the_validator_rejects_a_bad_figure(self):
        bad = docs._invalid_values(list(self.defs.values()),
                                   {"loan.principal": "ten grand", "loan.maturity_date": "next spring"})
        self.assertEqual(len(bad), 2)
        self.assertEqual(docs._invalid_values(list(self.defs.values()),
                                              {"loan.principal": "$10,000.00", "loan.maturity_date": "2027-09-30"}), [])

    def test_the_clauses_a_us_note_needs_are_present(self):
        text = _text(self.body)
        for phrase in ("FOR VALUE RECEIVED", "promises to pay to the order of", "Maturity Date",
                       "without penalty or premium", "Event of Default", "immediately due and payable",
                       "This Note is unsecured", "waive presentment, demand for payment, notice of dishonor",
                       "maximum permitted by applicable law", "governed by the laws of the State of",
                       "jointly and severally liable", "Time is of the essence", "signed electronically"):
            self.assertIn(phrase, text, phrase)
        # No em dashes in user-facing copy (Visesh, Jul 28).
        self.assertNotIn("\u2014", text)
        # Negotiable under UCC Article 3, and none of the clauses a number of
        # states refuse to enforce (per-state language would be needed).
        self.assertIn("promises to pay to the order of", text)
        for phrase in ("confess", "arbitration", "jury"):
            self.assertNotIn(phrase, text.lower(), phrase)


class PromissoryNoteSeedingTests(unittest.TestCase):
    def test_seeder_adds_the_note_once_with_fields_and_signer_roles(self):
        from database import SessionLocal, engine
        from models import Base, DocTemplate
        Base.metadata.create_all(engine)
        admin = {"email": "admin@test.local", "level": docs._ADMIN_LEVEL}
        db = SessionLocal()
        try:
            docs.seed_starter_templates(user=admin, db=db)
            first = db.query(DocTemplate).filter(DocTemplate.name == NOTE).all()
            self.assertEqual(len(first), 1)
            row = first[0]
            self.assertEqual(row.category, "finance")
            self.assertFalse(row.requires_letterhead)
            self.assertEqual([r["key"] for r in row.signer_roles], ["borrower", "lender"])
            self.assertEqual({d["token"] for d in row.field_defs},
                             {d["token"] for d in docs._PROMISSORY_NOTE_FIELDS})
            self.assertEqual(_tokens(row.content["pages"][0]["json"])[0], "loan.principal")
            # Add-if-missing: a second run leaves the library alone.
            self.assertEqual(docs.seed_starter_templates(user=admin, db=db)["added"], 0)
            self.assertEqual(db.query(DocTemplate).filter(DocTemplate.name == NOTE).count(), 1)
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
