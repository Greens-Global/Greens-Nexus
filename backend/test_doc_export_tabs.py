"""Word's tabs and tab stops in the exports (Neil, 11/11/2026: "Make sure
it's fully word compatible").

A paragraph's `tabStops` are points from the left margin, as Word measures
w:tab w:pos; a `tab` node is a real tab. The .docx carries both as Word's own
markup; the PDF places the text after each tab at its stop.

Run: python -m unittest test_doc_export_tabs
"""
import io
import unittest
import zipfile

from services.doc_export import _clean_tab_stops, render_docx, render_pdf, tiptap_to_blocks


def _sig_line():
    return {"type": "paragraph", "attrs": {"tabStops": [{"pos": 432, "align": "right"}, {"pos": 216, "align": "center"}]},
            "content": [{"type": "text", "text": "Employee"}, {"type": "tab"}, {"type": "text", "text": "Witness"},
                        {"type": "tab"}, {"type": "text", "text": "Date"}]}


BODY = {"type": "doc", "content": [_sig_line()]}


class TabStopTests(unittest.TestCase):
    def test_stops_are_cleaned(self):
        self.assertEqual(_clean_tab_stops([{"pos": 432, "align": "right"}, {"pos": "72", "align": "x"}, {"pos": 72.2}, {"pos": -1}, "no"]),
                         [{"pos": 72.0, "align": "left"}, {"pos": 432.0, "align": "right"}])
        self.assertEqual(_clean_tab_stops(None), [])

    def test_blocks_carry_the_stops_and_the_tabs(self):
        para = tiptap_to_blocks(BODY, {})[0]
        self.assertEqual(para["tabStops"], [{"pos": 216.0, "align": "center"}, {"pos": 432.0, "align": "right"}])
        self.assertEqual([r.get("tab", False) for r in para["runs"]], [False, True, False, True, False])

    def test_docx_writes_words_own_tabs_and_stops(self):
        out = render_docx("T", [], [tiptap_to_blocks(BODY, {})], [], None, None)
        xml = zipfile.ZipFile(io.BytesIO(out)).read("word/document.xml").decode()
        self.assertRegex(xml, r'<w:tab w:pos="4320" w:val="center"/>|<w:tab w:val="center" w:pos="4320"/>')
        self.assertRegex(xml, r'<w:tab w:pos="8640" w:val="right"/>|<w:tab w:val="right" w:pos="8640"/>')
        self.assertEqual(xml.count("<w:tab/>"), 2)

    def test_pdf_places_the_text_at_the_stops(self):
        from pypdf import PdfReader
        pdf = render_pdf("T", [], [tiptap_to_blocks(BODY, {})], [], None, {"size": "letter", "margins": "normal"})
        xs = {}

        def visit(text, cm, tm, _font, _size):
            if text.strip():
                xs[text.strip()] = cm[0] * tm[4] + cm[4]   # the cell's own translation is in cm
        PdfReader(io.BytesIO(pdf)).pages[0].extract_text(visitor_text=visit)
        left = xs["Employee"]
        # The center stop at 3", the right stop at 6" (points from the margin).
        self.assertGreater(xs["Witness"], left + 180)
        self.assertLess(xs["Witness"], left + 216)
        self.assertGreater(xs["Date"], left + 380)
        self.assertLess(xs["Date"], left + 432)

    def test_a_tab_in_a_list_item_is_a_gap_not_lost_text(self):
        body = {"type": "doc", "content": [{"type": "bulletList", "content": [{"type": "listItem", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "A"}, {"type": "tab"}, {"type": "text", "text": "B"}]}]}]}]}
        pdf = render_pdf("T", [], [tiptap_to_blocks(body, {})], [], None, None)
        from pypdf import PdfReader
        text = PdfReader(io.BytesIO(pdf)).pages[0].extract_text()
        self.assertIn("A", text)
        self.assertIn("B", text)


if __name__ == "__main__":
    unittest.main()
