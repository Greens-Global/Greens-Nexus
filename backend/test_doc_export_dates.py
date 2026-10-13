"""A generated document prints dates the way the app shows them.

Every date merge field came out of an export as the stored ISO string
("2027-09-30"). CLAUDE.md: user-facing dates are MM/DD/YYYY and times 12-hour
AM/PM. What is stored and validated stays ISO - only the render changes, and
only for a field the template declares as a date / time (plus the built-in
date variables). Words a person typed into a text field are left alone.

Uses a throwaway sqlite file. No network.

    python -m unittest test_doc_export_dates
"""
import io
import os
import tempfile
import unittest
import uuid

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database  # noqa: E402
import models  # noqa: E402
from routers import documents  # noqa: E402
from routers.documents import _display_value  # noqa: E402

ADMIN = {"email": "sagar@greensglobal.com", "level": 4}
FIELDS = [
    {"token": "loan.maturity_date", "label": "Maturity Date", "type": "date"},
    {"token": "meeting.time", "label": "Meeting Time", "type": "time"},
    {"token": "loan.terms", "label": "Terms", "type": "text"},
    {"token": "loan.review", "label": "Review", "type": "date"},
]
BODY = {"type": "doc", "content": [
    {"type": "paragraph", "content": [{"type": "text", "text": "Matures "}, {"type": "mergeField", "attrs": {"token": "loan.maturity_date"}},
                                      {"type": "text", "text": " at {{meeting.time}}. Started {{start_date}}."}]},
    {"type": "paragraph", "content": [{"type": "text", "text": "Terms: {{loan.terms}}. Review: {{loan.review}}."}]},
]}


class DisplayValueTests(unittest.TestCase):
    def test_a_clean_iso_date_becomes_us(self):
        self.assertEqual(_display_value("date", "2027-09-30"), "09/30/2027")
        self.assertEqual(_display_value("date", " 2026-10-01 "), "10/01/2026")

    def test_a_clock_becomes_twelve_hour(self):
        self.assertEqual(_display_value("time", "14:30"), "2:30 PM")
        self.assertEqual(_display_value("time", "00:05"), "12:05 AM")
        self.assertEqual(_display_value("time", "12:00:00"), "12:00 PM")
        self.assertEqual(_display_value("time", "09:15"), "9:15 AM")

    def test_anything_else_is_left_as_it_was(self):
        for ftype, raw in (("date", "September 30, 2027"), ("date", "2027-09-30 or sooner"), ("date", "2027-13-45"), ("date", "09/30/2027"),
                           ("date", ""), ("time", "half past two"), ("time", "25:00"), ("time", "2:30 PM"),
                           ("text", "2027-09-30"), ("number", "14:30")):
            self.assertEqual(_display_value(ftype, raw), raw, (ftype, raw))


class ExportedDatesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        cls.did = str(uuid.uuid4())
        with database.SessionLocal() as db:
            emp, tpl = str(uuid.uuid4()), str(uuid.uuid4())
            db.add(models.NexusEmployee(id=emp, first_name="Asha", last_name="Rao", work_email="asha.rao@greensglobal.com", start_date="2026-10-01"))
            db.add(models.DocTemplate(id=tpl, name="Promissory Note", field_defs=FIELDS))
            db.add(models.Document(id=cls.did, title="Note", template_id=tpl, employee_id=emp, owner_email=ADMIN["email"], content={"body": BODY},
                                   merge_overrides={"loan.maturity_date": "2027-09-30", "meeting.time": "14:30",
                                                    "loan.terms": "Net 30 from 2027-01-15", "loan.review": "Every spring"}))
            db.commit()

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.unlink(_tmp_db.name)
        except OSError:
            pass

    def _pdf_text(self):
        from pypdf import PdfReader
        with database.SessionLocal() as db:
            pdf = documents.export_document_pdf(self.did, user=ADMIN, db=db).body
        return " ".join("".join(p.extract_text() for p in PdfReader(io.BytesIO(pdf)).pages).split())

    def test_the_pdf_prints_us_dates_and_twelve_hour_times(self):
        text = self._pdf_text()
        self.assertIn("09/30/2027", text)
        self.assertNotIn("2027-09-30", text)
        self.assertIn("2:30 PM", text)
        self.assertIn("Started 10/01/2026", text)          # the built-in start_date
        self.assertNotIn("2026-10-01", text)

    def test_typed_words_are_not_touched(self):
        text = self._pdf_text()
        self.assertIn("Net 30 from 2027-01-15", text)      # a text field keeps what was typed
        self.assertIn("Every spring", text)                # a date field holding words, too

    def test_the_word_file_matches(self):
        from docx import Document as Docx
        with database.SessionLocal() as db:
            data = documents.export_document_docx(self.did, user=ADMIN, db=db).body
        text = " ".join(p.text for p in Docx(io.BytesIO(data)).paragraphs)
        self.assertIn("09/30/2027", text)
        self.assertNotIn("2027-09-30", text)

    def test_what_is_stored_stays_iso(self):
        with database.SessionLocal() as db:
            row = db.query(models.Document).filter(models.Document.id == self.did).first()
            self.assertEqual(row.merge_overrides["loan.maturity_date"], "2027-09-30")


if __name__ == "__main__":
    unittest.main()
