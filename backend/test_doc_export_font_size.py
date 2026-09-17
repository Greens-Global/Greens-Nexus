"""Export must read a font SIZE, not the digits in it.

Sagar, Sep 16, on the Preview tab: "again the preview page is not working
fine" - a transcript previewing as a 498-page document with text inches tall.

_font_size_num kept every digit character and int()'d the result, so it only
ever worked for whole numbers:

    '12.2pt' -> '122' -> 122pt      (body text, ~10x too big)
    '8.5pt'  -> '85'  -> 85pt

Fractional sizes are ordinary - CSS allows them, Word's own size box shows
10.5, and a .docx that states its sizes in millimetres (a Teams transcript
does: <w:sz w:val="4.3mm"/>) imports as 12.2pt. Both exporters take floats, so
the parse was the only thing in the way.

    python -m unittest test_doc_export_font_size
"""
import io
import unittest

from services.doc_export import _font_size_num, render_pdf, tiptap_to_blocks


def _para(text, size):
    return {"type": "paragraph",
            "content": [{"type": "text", "text": text,
                         "marks": [{"type": "textStyle", "attrs": {"fontSize": size}}]}]}


class FontSizeParsingTests(unittest.TestCase):
    def test_reads_a_fractional_point_size(self):
        self.assertAlmostEqual(_font_size_num("12.2pt"), 12.2)
        self.assertAlmostEqual(_font_size_num("8.5pt"), 8.5)
        self.assertAlmostEqual(_font_size_num("10.5pt"), 10.5)

    def test_still_reads_the_shapes_it_always_did(self):
        self.assertEqual(_font_size_num("18px"), 18)
        self.assertEqual(_font_size_num("17pt"), 17)
        self.assertEqual(_font_size_num("11"), 11)

    def test_does_not_multiply_by_dropping_the_decimal_point(self):
        # The actual bug: every digit kept, then int()'d.
        self.assertNotEqual(_font_size_num("12.2pt"), 122)
        self.assertNotEqual(_font_size_num("8.5pt"), 85)

    def test_nothing_sensible_means_no_size(self):
        for junk in (None, "", "auto", "inherit", "0pt", "-3pt"):
            self.assertIsNone(_font_size_num(junk), junk)

    def test_clamps_at_words_own_ceiling(self):
        # A size past what Word itself permits is a parse gone wrong, and
        # rendering it literally is what produced a 498-page preview.
        self.assertEqual(_font_size_num("99999pt"), 1638)


class ExportedDocumentLengthTests(unittest.TestCase):
    """The symptom, end to end: the same content must not explode into
    hundreds of pages because of how its size was written."""

    def _page_count(self, pdf_bytes):
        from pypdf import PdfReader
        return len(PdfReader(io.BytesIO(pdf_bytes)).pages)

    def test_a_fractional_size_renders_like_the_whole_number_beside_it(self):
        def pages_for(size):
            body = {"type": "doc", "content": [_para("The quick brown fox. " * 40, size)]}
            return self._page_count(render_pdf("T", [], [tiptap_to_blocks(body, {})], []))
        fractional = pages_for("12.2pt")
        whole = pages_for("12pt")
        # 12.2pt and 12pt are the same text at practically the same size.
        self.assertLessEqual(abs(fractional - whole), 1)
        self.assertLessEqual(fractional, 3)

    def test_a_transcript_sized_document_stays_a_few_pages(self):
        content = [_para("Neil Kadakia   0:0%d" % (i % 10), "12.2pt") for i in range(120)]
        blocks = tiptap_to_blocks({"type": "doc", "content": content}, {})
        pdf = render_pdf("Call", [], [blocks], [])
        pages = self._page_count(pdf)
        self.assertLess(pages, 20, f"120 short lines rendered as {pages} pages")

    def test_a_block_image_still_reaches_the_pdf(self):
        # The repaired import puts pictures at block level, which is the only
        # place _walk_blocks looks for one - if that ever changed, the avatars
        # would silently vanish from the document people sign.
        png = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAf"
               "FcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
        body = {"type": "doc", "content": [
            {"type": "image", "attrs": {"src": png, "width": 22, "height": 22}},
            _para("Neil Kadakia", "12.2pt"),
        ]}
        blocks = tiptap_to_blocks(body, {})
        self.assertIn("image", [b.get("type") for b in blocks])


if __name__ == "__main__":
    unittest.main()
