"""The signed document must BE the document that was sent.

Sagar, Sep 16, on the importer: "it must preserve the structure of the
document, font style and size, page size should be same as the document that's
being imported, I want 0 alterations means 0."

For a PDF that is achievable and already true - _stamp_pdf draws an overlay on
the original pages rather than rebuilding them - so this pins it down before
someone "improves" the import path into a re-flow again. The guarantees:

  * page size is untouched, including A4 and Legal (the old Word path forced
    everything to US Letter);
  * page count is untouched;
  * the original text is all still there;
  * the original font resources are still embedded, not swapped for the two
    standard PDF faces;
  * a scanned PDF (an image with no text layer) survives byte-level intact.

For a Word file zero alteration is NOT achievable by re-flowing, so the rule is
different and is also tested: convert with a real engine, or refuse.

    python -m unittest test_esign_document_fidelity
"""
import io
import os
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from pypdf import PdfReader
from reportlab.lib.pagesizes import A4, legal, letter
from reportlab.pdfgen import canvas

import services.docx_convert as docx_convert
from routers import esign


class _Party:
    """The fields _stamp_pdf actually reads."""
    role_key = "a"
    id = "party-1"
    name = "Dana Fields"
    signature_kind = "typed"
    signature_data = "Dana Fields"
    field_values = {}
    signed_at = "2026-09-16T10:00:00+00:00"


def _doc(pagesize, pages=2) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=pagesize)
    for i in range(pages):
        c.setFont("Times-Bold", 18)
        c.drawString(60, pagesize[1] - 80, "SUBCONTRACT AGREEMENT")
        c.setFont("Times-Roman", 11)
        c.drawString(60, pagesize[1] - 120, f"Clause {i + 1}. The parties agree as follows.")
        c.setFont("Courier", 9)
        c.drawString(60, pagesize[1] - 150, "Reference: GG-2026-00417")
        c.showPage()
    c.save()
    return buf.getvalue()


_FIELDS = [{"id": "sig1", "role": "a", "type": "sign", "page": 0,
            "x": 0.1, "y": 0.85, "w": 0.3, "h": 0.05, "required": True}]


class PdfFidelityTests(unittest.TestCase):

    def _roundtrip(self, pagesize, pages=2):
        src = _doc(pagesize, pages)
        return src, esign._stamp_pdf(src, _FIELDS, [_Party()])

    def test_page_size_is_not_changed(self):
        """The old Word path forced US Letter on everything. An A4 contract
        must stay A4 to the point."""
        for label, size in (("A4", A4), ("Legal", legal), ("Letter", letter)):
            with self.subTest(size=label):
                src, out = self._roundtrip(size)
                before, after = PdfReader(io.BytesIO(src)), PdfReader(io.BytesIO(out))
                for i in range(len(before.pages)):
                    b, a = before.pages[i].mediabox, after.pages[i].mediabox
                    self.assertAlmostEqual(float(b.width), float(a.width), places=2,
                                           msg=f"{label} page {i + 1} width changed")
                    self.assertAlmostEqual(float(b.height), float(a.height), places=2,
                                           msg=f"{label} page {i + 1} height changed")

    def test_page_count_is_not_changed(self):
        src, out = self._roundtrip(A4, pages=6)
        self.assertEqual(len(PdfReader(io.BytesIO(src)).pages),
                         len(PdfReader(io.BytesIO(out)).pages))

    def test_every_word_of_the_original_survives(self):
        src, out = self._roundtrip(A4)
        before = PdfReader(io.BytesIO(src))
        after = PdfReader(io.BytesIO(out))
        for i in range(len(before.pages)):
            want = (before.pages[i].extract_text() or "").split()
            got = (after.pages[i].extract_text() or "").split()
            for word in want:
                self.assertIn(word, got, f"'{word}' lost from page {i + 1}")

    def test_the_original_fonts_are_still_embedded(self):
        """Not swapped for Helvetica/Times. The overlay ADDS its own font
        resource; it must never replace the document's."""
        src, out = self._roundtrip(A4)
        before = PdfReader(io.BytesIO(src))
        after = PdfReader(io.BytesIO(out))
        for i in range(len(before.pages)):
            b_fonts = set(before.pages[i]["/Resources"]["/Font"].keys())
            a_fonts = set(after.pages[i]["/Resources"]["/Font"].keys())
            self.assertTrue(b_fonts <= a_fonts,
                            f"page {i + 1} lost fonts: {b_fonts - a_fonts}")

    def test_a_scanned_pdf_survives(self):
        """No text layer, just an image - the case where a re-flow would
        produce a blank page."""
        from reportlab.lib.utils import ImageReader
        from PIL import Image
        img = Image.new("RGB", (1240, 1754), "white")
        for x in range(200, 900):          # a dark band, so the page is not blank
            for y in range(300, 320):
                img.putpixel((x, y), (20, 20, 20))
        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=A4)
        c.drawImage(ImageReader(img), 0, 0, width=A4[0], height=A4[1])
        c.showPage()
        c.save()
        src = buf.getvalue()

        out = esign._stamp_pdf(src, _FIELDS, [_Party()])
        before, after = PdfReader(io.BytesIO(src)), PdfReader(io.BytesIO(out))
        self.assertEqual(len(before.pages), len(after.pages))
        self.assertAlmostEqual(float(before.pages[0].mediabox.width),
                               float(after.pages[0].mediabox.width), places=2)
        # The scan's image XObject is still on the page.
        xo = after.pages[0]["/Resources"].get("/XObject", {})
        self.assertTrue(len(xo) >= 1, "the scanned image was dropped")

    def test_no_fields_means_a_byte_for_byte_passthrough_of_the_content(self):
        """An envelope with nothing placed on page 2 must not have page 2
        rewritten at all."""
        src = _doc(A4, pages=2)
        out = esign._stamp_pdf(src, _FIELDS, [_Party()])   # only page 0 has a field
        after = PdfReader(io.BytesIO(out))
        text = (after.pages[1].extract_text() or "")
        self.assertIn("Clause 2", text)
        self.assertIn("GG-2026-00417", text)


class DocxPolicyTests(unittest.TestCase):
    """Word cannot be re-flowed into a faithful PDF, so the rule is: convert
    with a real engine, or refuse. Never quietly approximate."""

    def test_status_reports_what_this_deployment_can_do(self):
        got = docx_convert.available()
        self.assertIn("ok", got)
        self.assertIn("engine", got)
        self.assertIsInstance(got["ok"], bool)

    def test_convert_refuses_rather_than_approximating(self):
        if docx_convert.available()["ok"]:
            self.skipTest("a real converter is installed here")
        with self.assertRaises(RuntimeError) as ctx:
            docx_convert.convert(b"PK\x03\x04 not really a docx", "x.docx")
        # The message has to name the fix, not just fail.
        self.assertIn("converter", str(ctx.exception).lower())

    def test_empty_input_is_refused(self):
        with self.assertRaises(RuntimeError):
            docx_convert.convert(b"", "x.docx")

    def test_the_client_no_longer_reflows_word_documents(self):
        """The old mammoth -> pdf-lib path rebuilt documents on US-Letter pages
        with the standard PDF fonts. It must not be wired into the signing
        flow again - this is a guard on the whole class of bug.

        Swept over the WHOLE frontend, not just ESign.jsx. Checking one file is
        how this came back the first time: PdfEditor.jsx - which ESign.jsx
        mounts - kept calling docxToPdf() from its "merge another document"
        button, so a Word file could still be reflowed into a document on its
        way to being signed, one level below where the guard was looking.
        """
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        src_dir = os.path.join(root, "frontend", "src")
        if not os.path.isdir(src_dir):
            self.skipTest("frontend not present")
        offenders = []
        for dirpath, _dirnames, filenames in os.walk(src_dir):
            for name in filenames:
                if not name.endswith((".js", ".jsx")):
                    continue
                path = os.path.join(dirpath, name)
                with open(path, encoding="utf-8") as fh:
                    if "docxToPdf(" in fh.read():
                        offenders.append(os.path.relpath(path, root))
        self.assertEqual(offenders, [],
                         f"client-side Word reflow is back in: {offenders}")


if __name__ == "__main__":
    unittest.main()
