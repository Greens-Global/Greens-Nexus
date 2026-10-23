"""Markdown bold typed as plain text prints bold, not as asterisks.

Neil, Oct 22: hiring-packet documents were "coming in with ****** formatting" -
a template whose text came from an AI draft or a .txt kept "**Term**" as
literal characters, and the PDF / Word export printed them.

    python -m pytest test_doc_export_md_bold.py
"""
import io
import unittest

from pypdf import PdfReader

from services.doc_export import render_docx, render_pdf, split_md_bold, tiptap_to_blocks


def _doc(*texts, marks=None):
    return {"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": t, **({"marks": marks} if marks else {})} for t in texts]}]}


def _runs(doc, merge=None):
    return [(r["text"], r["bold"]) for r in tiptap_to_blocks(doc, merge or {})[0]["runs"]]


class MarkdownBoldTests(unittest.TestCase):
    def test_a_pair_on_one_text_node_is_bold(self):
        self.assertEqual(_runs(_doc("a **b** c")), [("a ", False), ("b", True), (" c", False)])
        self.assertEqual(_runs(_doc("**Term:** one and **two**")),
                         [("Term:", True), (" one and ", False), ("two", True)])

    def test_lone_or_spaced_asterisks_stay_as_written(self):
        for text in ("5 * 3", "a ** b", "** not bold **", "end **", "****", "Note*"):
            self.assertEqual(_runs(_doc(text)), [(text, False)], text)

    def test_already_bold_text_stays_bold(self):
        self.assertEqual(_runs(_doc("x **y** z", marks=[{"type": "bold"}])),
                         [("x ", True), ("y", True), (" z", True)])

    def test_a_filled_token_inside_the_pair_is_bold(self):
        self.assertEqual(_runs(_doc("Dear **{{full_name}}**,"), {"full_name": "Jane Doe"}),
                         [("Dear ", False), ("Jane Doe", True), (",", False)])

    def test_split_keeps_every_character_but_the_markers(self):
        self.assertEqual(split_md_bold("no markers"), [("no markers", False)])
        self.assertEqual("".join(s for s, _ in split_md_bold("a **b** c **d**")), "a b c d")

    def test_the_pdf_and_docx_print_no_asterisks(self):
        blocks = tiptap_to_blocks(_doc("This **Agreement** binds."), {})
        pdf = render_pdf("T", [], [blocks], [], None, {})
        text = PdfReader(io.BytesIO(pdf)).pages[0].extract_text()
        self.assertIn("Agreement", text)
        self.assertNotIn("**", text)
        from docx import Document
        d = Document(io.BytesIO(render_docx("T", [], [blocks], [], None, {})))
        runs = [(r.text, bool(r.bold)) for p in d.paragraphs for r in p.runs if r.text]
        self.assertIn(("Agreement", True), runs)
        self.assertFalse(any("**" in t for t, _ in runs))


if __name__ == "__main__":
    unittest.main()
