"""The Word file says what the page says (Neil, 11/11/2026: "Make sure it's
fully word compatible"). What the PDF drew and the .docx used to drop is now
written as Word's own markup: PAGE / NUMPAGES fields, the watermark, text
columns, line numbers, the page border and color, the table of contents
field, tables sized to the page, tracked changes, comments, footnotes and -
for a template - variables as MERGEFIELDs.

Run: python -m unittest test_doc_export_word
"""
import io
import re
import unittest
import zipfile

from services.doc_export import render_docx, render_pdf, tiptap_to_blocks


def _p(*content, attrs=None):
    return {"type": "paragraph", "attrs": attrs or {}, "content": list(content)}


def _t(text, *marks):
    node = {"type": "text", "text": text}
    if marks:
        node["marks"] = list(marks)
    return node


def _docx(body, page_setup=None, **kw):
    out = render_docx("T", [], [tiptap_to_blocks(body, {})], [], None, page_setup, **kw)
    z = zipfile.ZipFile(io.BytesIO(out))
    return {n: z.read(n).decode("utf-8", "replace") for n in z.namelist() if n.endswith(".xml") or n.endswith(".rels")}


DOC = {"type": "doc", "content": [_p(_t("Hello"))]}


class SectionTests(unittest.TestCase):
    def test_page_numbers_are_word_fields(self):
        parts = _docx(DOC, {"pageNumbers": "bottom-center"})
        footer = next(v for k, v in parts.items() if re.match(r"word/footer\d*\.xml", k))
        self.assertIn(" PAGE ", footer)
        self.assertIn(" NUMPAGES ", footer)
        self.assertIn('w:val="center"', footer)

    def test_no_page_numbers_when_removed(self):
        parts = _docx(DOC, {"pageNumbers": "none"})
        self.assertFalse(any(" PAGE " in v for v in parts.values()))

    def test_watermark_columns_line_numbers_border_and_color(self):
        parts = _docx(DOC, {"watermark": "DRAFT", "columns": 2, "lineNumbers": True, "pageColor": "#fff7ed",
                            "pageBorder": {"style": "double", "width": 2, "color": "#1f2937"}})
        header = next(v for k, v in parts.items() if re.match(r"word/header\d*\.xml", k))
        self.assertIn('string="DRAFT"', header)
        body = parts["word/document.xml"]
        self.assertRegex(body, r'<w:cols [^>]*w:num="2"')
        self.assertIn("<w:lnNumType", body)
        self.assertRegex(body, r'<w:pgBorders[^>]*>.*w:val="double"')
        self.assertIn('<w:background w:color="FFF7ED"', body)
        self.assertIn("displayBackgroundShape", parts["word/settings.xml"])
        # Schema order inside sectPr: borders, line numbers, then columns.
        self.assertLess(body.index("<w:pgBorders"), body.index("<w:lnNumType"))
        self.assertLess(body.index("<w:lnNumType"), body.index("<w:cols"))

    def test_tables_take_the_pages_text_width(self):
        table = {"type": "table", "content": [{"type": "tableRow", "content": [
            {"type": "tableCell", "attrs": {}, "content": [_p(_t("a"))]}, {"type": "tableCell", "attrs": {}, "content": [_p(_t("b"))]}]}]}
        parts = _docx({"type": "doc", "content": [table]}, {"orientation": "landscape", "margins": "normal"})
        widths = [int(w) for w in re.findall(r'<w:gridCol w:w="(\d+)"', parts["word/document.xml"])]
        self.assertAlmostEqual(sum(widths) / 1440, 9.0, delta=0.05)   # 11" landscape less two 1" margins


class ContentTests(unittest.TestCase):
    def test_table_of_contents_is_a_toc_field(self):
        toc = {"type": "bulletList", "content": [
            {"type": "listItem", "content": [_p(_t("Offer - p.1", {"type": "link", "attrs": {"href": "#toc:p1:offer"}}))]},
            {"type": "listItem", "content": [_p(_t("Benefits - p.2", {"type": "link", "attrs": {"href": "#toc:p1:benefits"}}), attrs={"indent": 1})]},
        ]}
        body = _docx({"type": "doc", "content": [toc]})["word/document.xml"]
        self.assertIn('TOC \\o "1-3" \\h \\z \\u', body)
        self.assertIn(">Offer<", body)
        self.assertIn(">Benefits<", body)
        self.assertEqual(body.count('w:fldCharType="begin"'), 1)
        self.assertEqual(body.count('w:fldCharType="end"'), 1)

    def test_tracked_changes_stay_tracked_in_word_and_accepted_in_the_pdf(self):
        ins = {"type": "insertion", "attrs": {"author": "a@x.test", "name": "Ana Diaz", "at": "2026-11-11T10:00:00"}}
        dele = {"type": "deletion", "attrs": {"author": "b@x.test", "name": "Ben Ode", "at": "2026-11-11T10:05:00Z"}}
        body = {"type": "doc", "content": [_p(_t("Keep "), _t("added ", ins), _t("removed", dele))]}
        xml = _docx(body)["word/document.xml"]
        self.assertRegex(xml, r'<w:ins [^>]*w:author="Ana Diaz"[^>]*>.*added')
        self.assertRegex(xml, r'<w:del [^>]*w:author="Ben Ode"[^>]*>.*<w:delText[^>]*>removed</w:delText>')
        from pypdf import PdfReader
        pdf = render_pdf("T", [], [tiptap_to_blocks(body, {})], [], None, None)
        text = PdfReader(io.BytesIO(pdf)).pages[0].extract_text()
        self.assertIn("added", text)
        self.assertNotIn("removed", text)

    def test_comments_are_word_comments_on_their_words(self):
        mark = {"type": "comment", "attrs": {"id": "c1"}}
        body = {"type": "doc", "content": [_p(_t("Pay "), _t("is 80,000", mark), _t(" a year"))]}
        parts = _docx(body, comments={"c1": {"author": "Charmi Shah", "initials": "CS", "text": "Check the figure"}})
        self.assertIn("Check the figure", parts["word/comments.xml"])
        self.assertIn('w:author="Charmi Shah"', parts["word/comments.xml"])
        doc = parts["word/document.xml"]
        self.assertLess(doc.index("commentRangeStart"), doc.index("is 80,000"))
        self.assertLess(doc.index("is 80,000"), doc.index("commentRangeEnd"))

    def test_footnotes_are_word_footnotes_and_pdf_notes(self):
        body = {"type": "doc", "content": [_p(_t("Salary"), {"type": "footnote", "attrs": {"text": "Before taxes."}}, _t(" is paid monthly."))]}
        parts = _docx(body)
        self.assertIn('<w:footnoteReference w:id="1"/>', parts["word/document.xml"])
        self.assertIn("Before taxes.", parts["word/footnotes.xml"])
        self.assertIn('w:type="separator"', parts["word/footnotes.xml"])
        self.assertIn("footnotes.xml", parts["word/_rels/document.xml.rels"])
        self.assertIn("footnotes+xml", parts["[Content_Types].xml"])
        from pypdf import PdfReader
        pdf = render_pdf("T", [], [tiptap_to_blocks(body, {})], [], None, None)
        self.assertIn("Before taxes.", PdfReader(io.BytesIO(pdf)).pages[0].extract_text())

    def test_a_templates_variables_are_merge_fields(self):
        body = {"type": "doc", "content": [_p(_t("Dear "), {"type": "mergeField", "attrs": {"token": "full_name"}})]}
        xml = _docx(body, merge_fields=True)["word/document.xml"]
        self.assertIn("MERGEFIELD full_name", xml)
        self.assertIn("«full_name»", xml)
        plain = _docx(body)["word/document.xml"]
        self.assertNotIn("MERGEFIELD", plain)


if __name__ == "__main__":
    unittest.main()
