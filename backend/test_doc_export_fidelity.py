"""What the editor shows, the PDF and the Word file show too.

Pranshu, Nov 4 2026: an imported Word document must keep its formatting, and
the export must carry the same formatting back out - custom margins, line
spacing and indents, a lettered list, merged table cells, a borderless table,
a header and footer with real paragraphs, and a clickable Word hyperlink.

    python -m pytest test_doc_export_fidelity.py
"""
import base64
import io
import re
import unittest
import zipfile

from services.doc_export import _resolve_page_setup, render_docx, render_pdf, tiptap_to_blocks


def _p(text, attrs=None, marks=None):
    node = {"type": "text", "text": text}
    if marks:
        node["marks"] = marks
    return {"type": "paragraph", "attrs": attrs or {}, "content": [node]}


def _cell(text, **attrs):
    return {"type": "tableCell", "attrs": attrs, "content": [_p(text)]}


MERGED_TABLE = {"type": "table", "attrs": {"borders": "none"}, "content": [
    {"type": "tableRow", "content": [_cell("wide", colspan=2, colwidth=[192, 192]), _cell("tall", rowspan=2)]},
    {"type": "tableRow", "content": [_cell("a"), _cell("b")]},
]}

BODY = {"type": "doc", "content": [
    _p("Indented and spaced", {"lineHeight": "1.3", "indentLeft": 36, "indentFirst": -18, "spacingAfter": 8}),
    {"type": "orderedList", "attrs": {"start": 3, "type": "a"}, "content": [
        {"type": "listItem", "content": [_p("c")]}, {"type": "listItem", "content": [_p("d")]}]},
    MERGED_TABLE,
    _p("Nexus", marks=[{"type": "link", "attrs": {"href": "https://example.test/nexus"}}]),
]}
HEADER = {"type": "doc", "content": [_p("Greens Global", {"textAlign": "right"})]}
FOOTER = {"type": "doc", "content": [_p("Confidential")]}
CUSTOM = {"size": "letter", "orientation": "portrait", "margins": "custom",
          "marginIn": {"top": 0.75, "right": 0.75, "bottom": 0.75, "left": 1}}


def _pdf_text(pdf_bytes):
    from pypdf import PdfReader
    return "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(pdf_bytes)).pages)


class PageSetupTests(unittest.TestCase):
    def test_custom_margins_are_per_side(self):
        _w, _h, margins = _resolve_page_setup(CUSTOM)
        self.assertEqual(margins, {"top": 0.75, "right": 0.75, "bottom": 0.75, "left": 1})

    def test_presets_and_junk_still_resolve(self):
        self.assertEqual(_resolve_page_setup({"margins": "narrow"})[2]["left"], 0.5)
        bad = {"margins": "custom", "marginIn": {"top": "x", "left": 9}}
        self.assertEqual(_resolve_page_setup(bad)[2], {"top": 1.0, "right": 1.0, "bottom": 1.0, "left": 1.0})


class BlockModelTests(unittest.TestCase):
    def test_blocks_carry_the_new_formatting(self):
        blocks = tiptap_to_blocks(BODY, {})
        para, lst, table = blocks[0], blocks[1], blocks[2]
        self.assertEqual((para["lineHeight"], para["indentLeft"], para["indentFirst"]), ("1.3", 36, -18))
        self.assertEqual((lst["listType"], lst["start"]), ("a", 3))
        self.assertFalse(table["borders"])
        self.assertEqual(table["rows"][0][0]["colspan"], 2)
        self.assertEqual(table["rows"][0][1]["rowspan"], 2)
        self.assertEqual(table["rows"][0][0]["widths"], [192, 192])


class PdfTests(unittest.TestCase):
    def test_renders_with_everything_on_and_numbers_the_pages(self):
        pdf = render_pdf("T", tiptap_to_blocks(HEADER, {}), [tiptap_to_blocks(BODY, {})],
                         tiptap_to_blocks(FOOTER, {}), None, CUSTOM)
        text = _pdf_text(pdf)
        self.assertIn("Greens Global", text)
        self.assertIn("Confidential", text)
        self.assertIn("Page 1 of 1", text)
        self.assertIn("wide", text)
        self.assertIn("Nexus", text)

    def test_a_table_of_contents_link_prints_as_text(self):
        # "#toc:<page>:<slug>" is the editor's own anchor; reportlab treated it
        # as an undefined PDF destination and the whole export was a 500.
        body = {"type": "doc", "content": [
            _p("Quarterly Vendor Agreement", marks=[{"type": "link", "attrs": {"href": "#toc:pg_1:quarterly"}}])]}
        text = _pdf_text(render_pdf("T", [], [tiptap_to_blocks(body, {})], [], None, None))
        self.assertIn("Quarterly Vendor Agreement", text)

    def test_picture_format_prints(self):
        # Picture Format (crop, flip, rotate, border, frame) is baked into the
        # picture's pixels on export, so PDF and DOCX show what the page shows.
        from PIL import Image
        from services.doc_export import _image_style, _styled_image_bytes
        src = Image.new("RGBA", (20, 10), (255, 0, 0, 255))
        src.paste((0, 0, 255, 255), (0, 0, 10, 10))         # left half blue, right half red
        buf = io.BytesIO()
        src.save(buf, format="PNG")
        raw = buf.getvalue()
        self.assertIsNone(_image_style({"rotation": 0, "frame": "none", "crop": {"top": 0}}))
        flipped = Image.open(io.BytesIO(_styled_image_bytes(raw, _image_style({"flipH": True}))))
        self.assertEqual(flipped.getpixel((0, 0))[:3], (255, 0, 0))          # blue moved to the right
        rotated = Image.open(io.BytesIO(_styled_image_bytes(raw, _image_style({"rotation": 90}))))
        self.assertEqual(rotated.size, (10, 20))
        bordered = Image.open(io.BytesIO(_styled_image_bytes(raw, _image_style({"borderColor": "#00ff00"}))))
        self.assertEqual(bordered.getpixel((0, 0))[:3], (0, 255, 0))
        framed = Image.open(io.BytesIO(_styled_image_bytes(raw, _image_style({"frame": "simple"}))))
        self.assertGreater(framed.width, 20)
        cropped = Image.open(io.BytesIO(_styled_image_bytes(raw, _image_style({"crop": {"left": 50}}))))
        self.assertEqual(cropped.size, (10, 10))
        self.assertEqual(cropped.getpixel((0, 0))[:3], (255, 0, 0))          # only the red half is left
        # The DOCX keeps crop, rotation, flip and border as Word's own elements
        # (editable in Word, read back by the importer); only a frame is baked.
        body = {"type": "doc", "content": [{"type": "paragraph", "content": [
            {"type": "image", "attrs": {"src": "data:image/png;base64," + base64.b64encode(raw).decode(), "rotation": 90,
                                        "flipH": True, "borderColor": "#00ff00", "crop": {"left": 10, "top": 5, "right": 0, "bottom": 0}}}]}]}
        with zipfile.ZipFile(io.BytesIO(render_docx("T", [], [tiptap_to_blocks(body, {})], [], None, None))) as z:
            xml = z.read("word/document.xml").decode("utf-8")
            media = [n for n in z.namelist() if n.startswith("word/media/")]
            self.assertTrue(media)
            self.assertEqual(Image.open(io.BytesIO(z.read(media[0]))).size, (20, 10))   # pixels untouched
        self.assertRegex(xml, r'<a:srcRect[^>]*l="10000"')
        self.assertRegex(xml, r'<a:srcRect[^>]*t="5000"')
        self.assertRegex(xml, r'<a:xfrm[^>]*rot="5400000"')
        self.assertRegex(xml, r'<a:xfrm[^>]*flipH="1"')
        self.assertIn('<a:srgbClr val="00FF00"/>', xml)

    def test_tracked_changes_print_as_accepted(self):
        # Review > Track Changes: the PDF shows the final wording - an insertion
        # as plain text, a deletion not at all.
        body = {"type": "doc", "content": [{"type": "paragraph", "content": [
            {"type": "text", "text": "Net "},
            {"type": "text", "text": "30", "marks": [{"type": "deletion", "attrs": {"author": "a@x", "name": "A", "at": ""}}]},
            {"type": "text", "text": "45", "marks": [{"type": "insertion", "attrs": {"author": "a@x", "name": "A", "at": ""}}]},
            {"type": "text", "text": " days"}]}]}
        text = _pdf_text(render_pdf("T", [], [tiptap_to_blocks(body, {})], [], None, None))
        self.assertIn("Net 45 days", text)
        self.assertNotIn("30", text)

    def test_signature_anchors_come_from_the_real_pass(self):
        body = {"type": "doc", "content": [_p("Sign below"), {"type": "signatureBlock", "attrs": {"role": "employee"}}]}
        anchors = []
        render_pdf("T", [], [tiptap_to_blocks(body, {})], [], None, None, anchors)
        self.assertEqual(sorted(a["type"] for a in anchors), ["date", "name", "sign"])


class DocxTests(unittest.TestCase):
    def _parts(self, docx_bytes):
        with zipfile.ZipFile(io.BytesIO(docx_bytes)) as z:
            return {name: z.read(name).decode("utf-8", "replace") for name in z.namelist()}

    def test_margins_header_footer_merges_and_links_land_in_the_file(self):
        parts = self._parts(render_docx("T", tiptap_to_blocks(HEADER, {}), [tiptap_to_blocks(BODY, {})],
                                        tiptap_to_blocks(FOOTER, {}), None, CUSTOM))
        document = parts["word/document.xml"]
        self.assertRegex(document, r'w:pgMar[^>]*w:top="1080"')      # 0.75in in twips
        self.assertRegex(document, r'w:pgMar[^>]*w:left="1440"')
        self.assertIn("w:gridSpan", document)
        self.assertIn("w:vMerge", document)
        self.assertIn("w:hyperlink", document)
        self.assertNotIn("Table Grid", document)                    # a borderless table stays borderless
        rels = parts["word/_rels/document.xml.rels"]
        self.assertIn("https://example.test/nexus", rels)
        header = next(v for k, v in parts.items() if re.match(r"word/header\d*\.xml", k))
        footer = next(v for k, v in parts.items() if re.match(r"word/footer\d*\.xml", k))
        self.assertIn("Greens Global", header)
        self.assertIn('w:jc w:val="right"', header)
        self.assertIn("Confidential", footer)

    def test_line_spacing_and_indents(self):
        parts = self._parts(render_docx("T", [], [tiptap_to_blocks(BODY, {})], [], None, None))
        document = parts["word/document.xml"]
        self.assertRegex(document, r'w:spacing[^>]*w:line="(259|260)"')   # 1.3 / 1.2 = 1.08 x 240
        self.assertRegex(document, r'w:ind[^>]*w:left="720"')
        self.assertRegex(document, r'w:ind[^>]*w:hanging="360"')


if __name__ == "__main__":
    unittest.main()
