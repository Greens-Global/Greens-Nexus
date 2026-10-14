"""Signature blocks (Oct 14): where a signer signs is part of the template, and
the PDF render reports where each box actually landed so Nexus Sign puts the
field exactly on the line - for a block at the top level, in a two-column
table, pushed to page 2, and on a landscape page. No coordinates are stored:
they are measured on every render because the text reflows per person.

    python -m pytest test_doc_signature_anchors.py
"""
import io
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from pypdf import PdfReader  # noqa: E402

from services import doc_export  # noqa: E402


def _p(text):
    return {"type": "paragraph", "content": [{"type": "text", "text": text}]}


def _sig(role, label="", **kw):
    return {"type": "signatureBlock", "attrs": {"role": role, "label": label, **kw}}


def _render(nodes, page_setup=None, merge=None):
    blocks = doc_export.tiptap_to_blocks({"type": "doc", "content": nodes}, merge or {})
    anchors = []
    pdf = doc_export.render_pdf("t", [], [blocks], [], page_setup=page_setup, anchors=anchors)
    return pdf, anchors


def _in_page(test, a):
    for k in ("x", "y", "w", "h"):
        test.assertGreaterEqual(a[k], 0.0, a)
        test.assertLessEqual(a[k], 1.0, a)
    test.assertLessEqual(a["x"] + a["w"], 1.0, a)
    test.assertLessEqual(a["y"] + a["h"], 1.0, a)


class SignatureAnchorTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def test_one_block_gives_sign_name_and_date_boxes_for_its_role(self):
        _, anchors = _render([_p("Dear Jane,"), _sig("employee", "Accepted")])
        self.assertEqual([(a["role"], a["type"]) for a in anchors],
                         [("employee", "sign"), ("employee", "name"), ("employee", "date")])
        for a in anchors:
            self.assertEqual(a["page"], 0)
            _in_page(self, a)
        sign, name, date = anchors
        self.assertLess(sign["y"], name["y"])          # top-down: signature, then name, then date
        self.assertLess(name["y"], date["y"])

    def test_name_and_date_lines_are_optional(self):
        _, anchors = _render([_sig("company", withName=False, withDate=False)])
        self.assertEqual([a["type"] for a in anchors], ["sign"])

    def test_two_blocks_side_by_side_in_a_table(self):
        row = {"type": "tableRow", "content": [
            {"type": "tableCell", "content": [_sig("company", "For the Company")]},
            {"type": "tableCell", "content": [_sig("employee", "Employee")]}]}
        _, anchors = _render([_p("Agreed:"), {"type": "table", "content": [row]}])
        company = next(a for a in anchors if a["role"] == "company" and a["type"] == "sign")
        employee = next(a for a in anchors if a["role"] == "employee" and a["type"] == "sign")
        self.assertLess(company["x"] + company["w"], employee["x"] + 0.001)   # left column, then right
        self.assertAlmostEqual(company["y"], employee["y"], places=3)           # same row
        for a in anchors:
            _in_page(self, a)

    def test_a_block_pushed_to_page_two_reports_page_two(self):
        filler = [_p("Clause text that fills the page. " * 12) for _ in range(14)]
        pdf, anchors = _render(filler + [_sig("employee")])
        self.assertGreaterEqual(len(PdfReader(io.BytesIO(pdf)).pages), 2)
        self.assertTrue(all(a["page"] >= 1 for a in anchors), anchors)
        self.assertEqual(len({a["page"] for a in anchors}), 1)    # a block never splits across pages

    def test_landscape_page(self):
        _, anchors = _render([_p("Wide"), _sig("employee")], page_setup={"orientation": "landscape"})
        for a in anchors:
            _in_page(self, a)

    def test_the_caption_takes_variables(self):
        pdf, _ = _render([_sig("company", "For {{company_legal}}")], merge={"company_legal": "Greens Test Co, LLC"})
        self.assertIn("For Greens Test Co, LLC", PdfReader(io.BytesIO(pdf)).pages[0].extract_text())

    def test_nexus_sign_stamps_on_the_anchor(self):
        from routers import esign

        class Party:
            role_key, signature_kind, signature_data = "employee", "typed", "Jane Q Doe"
            name, signed_at, id = "Jane Q Doe", "2026-10-14T10:00:00", "p1"

        pdf, anchors = _render([_p("Dear Jane,"), _sig("employee")])
        fields = [{"id": f"f{i}", **a} for i, a in enumerate(anchors) if a["type"] == "sign"]
        stamped = esign._stamp_pdf(pdf, fields, [Party()])
        self.assertIn("Jane Q Doe", PdfReader(io.BytesIO(stamped)).pages[0].extract_text())

    def test_without_blocks_nothing_changes(self):
        nodes = [_p("No signature here.")]
        blocks = doc_export.tiptap_to_blocks({"type": "doc", "content": nodes}, {})
        plain = doc_export.render_pdf("t", [], [blocks], [])
        anchors = []
        with_sink = doc_export.render_pdf("t", [], [blocks], [], anchors=anchors)
        self.assertEqual(anchors, [])
        self.assertEqual(PdfReader(io.BytesIO(plain)).pages[0].extract_text(),
                         PdfReader(io.BytesIO(with_sink)).pages[0].extract_text())

    def test_docx_export_still_works(self):
        blocks = doc_export.tiptap_to_blocks({"type": "doc", "content": [_p("Hi"), _sig("employee", "Employee")]}, {})
        data = doc_export.render_docx("t", [], [blocks], [])
        self.assertTrue(data.startswith(b"PK"))


if __name__ == "__main__":
    unittest.main()
