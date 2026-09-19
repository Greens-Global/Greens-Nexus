"""The document NAME is not part of the document, and the letterhead lives in
the first page's header.

Sagar, Sep 18: "the Document Name is getting posted to the doc header, and the
Letterhead is in body. Document name should not be posted in the document and
the letterhead should be in the first page Header of the document."

Both exports used to open with a Title paragraph carrying the file's name, and
then render the letterhead as ordinary body flow underneath it - so every
document began with a heading nobody wrote, above a company letterhead that
read as its subheading.
"""
import io
import unittest
import zipfile

from pypdf import PdfReader

from services.doc_export import render_pdf, render_docx

TITLE = "Company Offer Letter"
LETTERHEAD = {
    "name": "Greens Global - Standard",
    "address": "123 Placeholder Ave, Suite 100, Anytown, ST 00000",
}


def _para(text):
    return {"type": "paragraph", "align": "left", "runs": [{"text": text}]}


def _long_body(n):
    return [_para(f"Body line {i}") for i in range(n)]


def _pdf_pages(title=TITLE, blocks=None, letterhead=LETTERHEAD):
    pdf = render_pdf(title, [], [blocks or _long_body(5)], [], letterhead=letterhead)
    reader = PdfReader(io.BytesIO(pdf))
    return reader, [(p.extract_text() or "") for p in reader.pages]


class TitleIsNotContent(unittest.TestCase):
    def test_pdf_does_not_print_the_document_name(self):
        _, pages = _pdf_pages()
        self.assertNotIn(TITLE, "".join(pages))

    def test_pdf_still_carries_the_name_as_metadata(self):
        # A file name belongs in the file's properties, not on the paper.
        reader, _ = _pdf_pages()
        self.assertEqual(reader.metadata.title, TITLE)

    def test_pdf_without_a_letterhead_also_omits_the_name(self):
        _, pages = _pdf_pages(letterhead=None)
        self.assertNotIn(TITLE, "".join(pages))
        self.assertIn("Body line 0", pages[0])

    def test_docx_does_not_print_the_document_name(self):
        docx = render_docx(TITLE, [], [_long_body(5)], [], letterhead=LETTERHEAD)
        body = zipfile.ZipFile(io.BytesIO(docx)).read("word/document.xml").decode("utf8", "ignore")
        self.assertNotIn(TITLE, body)


class LetterheadIsAHeader(unittest.TestCase):
    def test_pdf_renders_the_letterhead_on_page_one(self):
        _, pages = _pdf_pages()
        self.assertIn("Greens Global", pages[0])

    def test_pdf_letterhead_does_not_repeat_on_later_pages(self):
        # A letterhead is the first page's header, not a running one - it used
        # to be body flow, so this is the property that pins it down.
        _, pages = _pdf_pages(blocks=_long_body(220))
        self.assertGreater(len(pages), 1, "need a multi-page document for this")
        for i, text in enumerate(pages[1:], start=2):
            self.assertNotIn("Greens Global", text, f"letterhead repeated on page {i}")

    def test_pdf_body_still_starts_on_page_one_beneath_it(self):
        _, pages = _pdf_pages()
        self.assertIn("Body line 0", pages[0])

    def test_docx_letterhead_is_in_a_header_part_not_the_body(self):
        docx = render_docx(TITLE, [], [_long_body(5)], [], letterhead=LETTERHEAD)
        z = zipfile.ZipFile(io.BytesIO(docx))
        body = z.read("word/document.xml").decode("utf8", "ignore")
        headers = [z.read(n).decode("utf8", "ignore") for n in z.namelist() if "header" in n]
        self.assertNotIn("Greens Global", body)
        self.assertTrue(any("Greens Global" in h for h in headers))

    def test_docx_marks_the_first_page_header_as_distinct(self):
        # <w:titlePg/> is what makes Word show it on page 1 only.
        docx = render_docx(TITLE, [], [_long_body(5)], [], letterhead=LETTERHEAD)
        body = zipfile.ZipFile(io.BytesIO(docx)).read("word/document.xml").decode("utf8", "ignore")
        self.assertIn("titlePg", body)

    def test_no_letterhead_means_no_stray_header(self):
        docx = render_docx(TITLE, [], [_long_body(3)], [], letterhead=None)
        body = zipfile.ZipFile(io.BytesIO(docx)).read("word/document.xml").decode("utf8", "ignore")
        self.assertNotIn("titlePg", body)

    def test_letterhead_with_a_logo_url_that_cannot_be_fetched_still_renders(self):
        lh = dict(LETTERHEAD, logoPath="https://example.invalid/nope.png")
        _, pages = _pdf_pages(letterhead=lh)
        self.assertIn("Greens Global", pages[0])
        self.assertIn("Body line 0", pages[0])


if __name__ == "__main__":
    unittest.main()
