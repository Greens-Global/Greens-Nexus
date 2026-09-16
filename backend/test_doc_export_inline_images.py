"""A picture exports where the document put it, not on a line of its own.

Sagar, Sep 16: "pictures should be next to the names, not only in this doc
only in docs also make the picture placement exactly where it's in the
importing doc".

Word keeps a meeting transcript's speaker avatar and the speaker's name in ONE
paragraph, the drawing first (checked against the source document.xml: the
paragraph holds 3 runs - drawing, then two text runs). The editor's image node
is inline for that reason, so a picture arrives inside the paragraph's runs -
and both renderers have to draw it there:

  * PDF  - reportlab Paragraph markup, <img/> inline in the text;
  * DOCX - python-docx, a picture added to a run inside the same paragraph,
           which OOXML writes as wp:inline.

Block-level pictures still export too: documents saved before the image node
became inline have them, and repairDocJson only migrates a document when the
EDITOR opens it.

    python -m unittest test_doc_export_inline_images
"""
import base64
import io
import re
import unittest
import zipfile

from services.doc_export import (_fetch_image_bytes, _image_mime, render_docx,
                                 render_pdf, tiptap_to_blocks)

# A real 8x8 PNG. It has to satisfy BOTH readers: reportlab/PIL, and
# python-docx's own PNG chunk parser, which raises UnexpectedEndOfFileError
# on a hand-trimmed minimal file that PIL is happy to open.
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGOUrwhgwAaYsIoO"
    "WgkAuYEA9zepg3IAAAAASUVORK5CYII=")
PNG_URI = "data:image/png;base64," + base64.b64encode(PNG_BYTES).decode()


def _img_node(**attrs):
    return {"type": "image", "attrs": {"src": PNG_URI, "width": 22, "height": 22, **attrs}}


def _speaker_turn():
    """The transcript's own shape: avatar, then the name, one paragraph."""
    return {"type": "doc", "content": [{"type": "paragraph", "content": [
        _img_node(),
        {"type": "text", "text": "Neil Kadakia   0:03"},
    ]}]}


def _pdf_image_count(pdf_bytes):
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(pdf_bytes))
    return sum(len(list(((p.get("/Resources") or {}).get("/XObject") or {}).keys()))
               for p in reader.pages)


def _docx_parts(docx_bytes):
    z = zipfile.ZipFile(io.BytesIO(docx_bytes))
    xml = z.read("word/document.xml").decode("utf-8", "replace")
    media = [n for n in z.namelist() if n.startswith("word/media/")]
    return xml, media


class InlineImageBlockModelTests(unittest.TestCase):
    def test_an_inline_picture_becomes_a_run_not_a_block(self):
        blocks = tiptap_to_blocks(_speaker_turn(), {})
        self.assertEqual([b["type"] for b in blocks], ["paragraph"])
        runs = blocks[0]["runs"]
        self.assertTrue(runs[0].get("image"), "the picture should lead the paragraph, as in Word")
        self.assertEqual(runs[1]["text"], "Neil Kadakia   0:03")

    def test_the_picture_keeps_its_place_among_the_words(self):
        body = {"type": "doc", "content": [{"type": "paragraph", "content": [
            {"type": "text", "text": "before "}, _img_node(), {"type": "text", "text": " after"}]}]}
        runs = tiptap_to_blocks(body, {})[0]["runs"]
        self.assertEqual([bool(r.get("image")) for r in runs], [False, True, False])

    def test_a_picture_with_no_src_is_skipped(self):
        body = {"type": "doc", "content": [{"type": "paragraph", "content": [
            {"type": "image", "attrs": {"src": ""}}, {"type": "text", "text": "text"}]}]}
        runs = tiptap_to_blocks(body, {})[0]["runs"]
        self.assertEqual(len(runs), 1)


class InlineImagePdfTests(unittest.TestCase):
    def test_the_picture_reaches_the_pdf(self):
        pdf = render_pdf("T", [], [tiptap_to_blocks(_speaker_turn(), {})], [])
        self.assertEqual(_pdf_image_count(pdf), 1)

    def test_the_text_is_still_there_beside_it(self):
        from pypdf import PdfReader
        pdf = render_pdf("T", [], [tiptap_to_blocks(_speaker_turn(), {})], [])
        text = PdfReader(io.BytesIO(pdf)).pages[0].extract_text() or ""
        self.assertIn("Neil Kadakia", text)

    def test_a_block_level_picture_still_exports(self):
        # A document saved before the image node became inline.
        body = {"type": "doc", "content": [_img_node(),
                                           {"type": "paragraph", "content": [{"type": "text", "text": "after"}]}]}
        pdf = render_pdf("T", [], [tiptap_to_blocks(body, {})], [])
        self.assertEqual(_pdf_image_count(pdf), 1)

    def test_an_unreadable_picture_does_not_sink_the_export(self):
        body = {"type": "doc", "content": [{"type": "paragraph", "content": [
            _img_node(src="data:image/png;base64,bm90YXBuZw=="),
            {"type": "text", "text": "Neil Kadakia"}]}]}
        from pypdf import PdfReader
        pdf = render_pdf("T", [], [tiptap_to_blocks(body, {})], [])
        self.assertIn("Neil Kadakia", PdfReader(io.BytesIO(pdf)).pages[0].extract_text() or "")


class InlineImageDocxTests(unittest.TestCase):
    def test_the_picture_lands_in_the_same_paragraph_as_the_name(self):
        xml, media = _docx_parts(render_docx("T", [], [tiptap_to_blocks(_speaker_turn(), {})], []))
        self.assertEqual(len(media), 1)
        paras = re.findall(r"<w:p[ >].*?</w:p>", xml, re.S)
        named = [p for p in paras if "Neil Kadakia" in p]
        self.assertEqual(len(named), 1)
        self.assertIn("<w:drawing>", named[0])

    def test_the_drawing_comes_before_the_name_as_word_wrote_it(self):
        xml, _ = _docx_parts(render_docx("T", [], [tiptap_to_blocks(_speaker_turn(), {})], []))
        para = next(p for p in re.findall(r"<w:p[ >].*?</w:p>", xml, re.S) if "Neil Kadakia" in p)
        order = [m.group(1) for m in re.finditer(r"<w:(drawing|t)[ >]", para)]
        self.assertEqual(order[:2], ["drawing", "t"])

    def test_the_picture_is_inline_not_floating(self):
        xml, _ = _docx_parts(render_docx("T", [], [tiptap_to_blocks(_speaker_turn(), {})], []))
        self.assertIn("wp:inline", xml)

    def test_the_width_the_document_asked_for_is_honored(self):
        xml, _ = _docx_parts(render_docx("T", [], [tiptap_to_blocks(_speaker_turn(), {})], []))
        m = re.search(r'<wp:extent cx="(\d+)" cy="(\d+)"', xml)
        self.assertIsNotNone(m)
        # 22pt, in EMU (12700 per point).
        self.assertAlmostEqual(int(m.group(1)) / 12700, 22.0, places=1)

    def test_an_unreadable_picture_does_not_sink_the_export(self):
        body = {"type": "doc", "content": [{"type": "paragraph", "content": [
            _img_node(src="data:image/png;base64,bm90YXBuZw=="),
            {"type": "text", "text": "Neil Kadakia"}]}]}
        xml, _ = _docx_parts(render_docx("T", [], [tiptap_to_blocks(body, {})], []))
        self.assertIn("Neil Kadakia", xml)


class ImageSourceTests(unittest.TestCase):
    def test_reads_a_base64_data_uri(self):
        self.assertEqual(_fetch_image_bytes(PNG_URI), PNG_BYTES)

    def test_reads_a_percent_encoded_data_uri(self):
        self.assertEqual(_fetch_image_bytes("data:image/svg+xml,%3Csvg%3E%3C/svg%3E"), b"<svg></svg>")

    def test_a_malformed_data_uri_is_no_picture_rather_than_a_crash(self):
        self.assertIsNone(_fetch_image_bytes("data:image/png;base64,"))

    def test_sniffs_the_type_from_the_bytes(self):
        self.assertEqual(_image_mime(PNG_BYTES), "image/png")
        self.assertEqual(_image_mime(b"\xff\xd8\xff\xe0rest"), "image/jpeg")
        self.assertEqual(_image_mime(b"GIF89a..."), "image/gif")
        self.assertEqual(_image_mime(b"RIFF1234WEBPVP8 "), "image/webp")


if __name__ == "__main__":
    unittest.main()
