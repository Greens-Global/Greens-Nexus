"""The job description under the offer letter (Neil, 11/03/2026).

One offer letter per kind of hire; the role brings its job description - its
typed duties, or its own file (a PDF, or a Word file converted to one) - and
it goes out INSIDE the offer letter's PDF, after the letter, followed by a
page with a required "I have read the job description" tick box. The hiring
packet that follows no longer carries it; offers made before keep the old way.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_offer_job_description.py -q
"""
import io
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402
from pypdf import PdfReader  # noqa: E402
from reportlab.pdfgen import canvas  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import hr_life_events as hle  # noqa: E402
import hr_packet_docs as hpd  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import esign  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)
ADMIN = "admin.offerjd.test@greensglobal.com"


def pdf_of(pages: int, text: str = "page") -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for i in range(pages):
        c.drawString(72, 720, f"{text} {i + 1}")
        c.showPage()
    c.save()
    return buf.getvalue()


class AttachTests(unittest.TestCase):
    def test_letter_then_jd_then_ack_page_with_required_tick(self):
        letter = [{"id": "sb1", "role": "p1", "type": "sign", "page": 1, "x": .1, "y": .8, "w": .3, "h": .05}]
        jd = [{"id": "sb1", "role": "p1", "type": "initials", "page": 0, "x": .1, "y": .9, "w": .1, "h": .04}]
        pdf, fields = hpd.attach_jd(pdf_of(2, "letter"), letter, pdf_of(3, "duties"), jd,
                                    signer="p1", job_title="Site Supervisor")
        pages = PdfReader(io.BytesIO(pdf)).pages
        self.assertEqual(len(pages), 6)
        self.assertIn("letter 1", pages[0].extract_text())
        self.assertIn("duties 1", pages[2].extract_text())
        self.assertIn("Job Description Acknowledgment", pages[5].extract_text())
        self.assertIn("Site Supervisor", pages[5].extract_text())
        self.assertEqual(fields[0], letter[0])                       # the letter's boxes stay put
        self.assertEqual((fields[1]["id"], fields[1]["page"]), ("jd-sb1", 2))   # the JD's move with its pages
        ack = fields[-1]
        self.assertEqual((ack["type"], ack["role"], ack["page"], ack["required"]), ("check", "p1", 5, True))
        # Nexus Sign accepts the boxes as they are.
        esign._clean_fields([dict(f) for f in fields])


class DocumentListTests(unittest.TestCase):
    packet = models.HrPacketSetting(id="p", event="offer", doc_template_ids=["t-letter"])

    def ids(self, kind, **d):
        return hpd.template_ids_for(self.packet, {"jd_template_id": "t-jd", **d}, kind)

    def test_new_offers_carry_the_typed_jd_and_the_packet_does_not(self):
        self.assertEqual(self.ids("offer", jd_in_offer=True), ["t-letter", "t-jd"])
        self.assertEqual(self.ids("hire", jd_in_offer=True), ["t-letter"])

    def test_a_role_file_replaces_the_jd_document_on_the_offer(self):
        self.assertEqual(self.ids("offer", jd_in_offer=True, role_jd_file={"path": "x"}), ["t-letter"])

    def test_offers_made_before_keep_the_jd_in_the_packet(self):
        self.assertEqual(self.ids("offer"), ["t-letter"])
        self.assertEqual(self.ids("hire"), ["t-letter", "t-jd"])
        self.assertEqual(self.ids("hire", role_jd_file={"path": "x"}), ["t-letter", "t-jd"])


class FoldTests(unittest.TestCase):
    def setUp(self):
        self.store = {"esign/role-jd/r/1.pdf": pdf_of(2, "file duties")}
        self._fetch = esign._storage_fetch
        esign._storage_fetch = lambda bucket, path, timeout=60: esign._StorageResult(
            path in self.store, content=self.store.get(path, b""))

    def tearDown(self):
        esign._storage_fetch = self._fetch

    def ev(self, **d):
        return models.HrLifeEvent(id="e", kind="offer", inputs={"jd_in_offer": True, "job_title": "Analyst",
                                                                 "jd_template_id": "t-jd", **d})

    def test_typed_jd_document_is_folded_into_the_letter(self):
        rendered = [(None, {"templateId": "t-letter"}, pdf_of(1), []), (None, {"templateId": "t-nda"}, pdf_of(1), []),
                    (None, {"templateId": "t-jd"}, pdf_of(1, "typed duties"), [])]
        out = hpd.offer_with_jd(self.ev(), rendered, signer="p1")
        self.assertEqual([e["templateId"] for _, e, _, _ in out], ["t-letter", "t-nda"])
        pages = PdfReader(io.BytesIO(out[0][2])).pages
        self.assertEqual(len(pages), 3)
        self.assertIn("typed duties", pages[1].extract_text())

    def test_role_file_is_folded_into_the_letter(self):
        rendered = [(None, {"templateId": "t-letter"}, pdf_of(1), [])]
        out = hpd.offer_with_jd(self.ev(role_jd_file={"path": "esign/role-jd/r/1.pdf", "name": "jd.pdf"}),
                                rendered, signer="p1")
        pages = PdfReader(io.BytesIO(out[0][2])).pages
        self.assertEqual(len(pages), 4)
        self.assertIn("file duties 2", pages[2].extract_text())
        self.assertEqual(out[0][3][-1]["page"], 3)

    def test_missing_jd_refuses_rather_than_sending_without_one(self):
        with self.assertRaises(hle.PacketError):
            hpd.offer_with_jd(self.ev(), [(None, {"templateId": "t-letter"}, pdf_of(1), [])], signer="p1")
        with self.assertRaises(hle.PacketError):
            hpd.offer_with_jd(self.ev(role_jd_file={"path": "esign/role-jd/r/gone.pdf"}),
                              [(None, {"templateId": "t-letter"}, pdf_of(1), [])], signer="p1")


class RoleFileTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        os.environ["NEXUS_DEV_EMAIL"] = ADMIN
        self.store = {}
        self._put, self._fetch = esign._storage_put, esign._storage_fetch
        esign._storage_put = lambda bucket, path, content, ct, upsert=False: (
            self.store.__setitem__(path, content) or esign._StorageResult(True))
        esign._storage_fetch = lambda bucket, path, timeout=60: esign._StorageResult(
            path in self.store, content=self.store.get(path, b""))
        db = database.SessionLocal()
        for m in (models.NexusGroup, models.NexusRole):
            db.query(m).delete()
        db.add(models.NexusRole(email=ADMIN, role="owner"))
        db.add(models.NexusGroup(id="jr-sup", name="Site Supervisor", is_job_role=1, tier="employee",
                                 job_description="Runs the site."))
        db.commit()
        db.close()

    def tearDown(self):
        esign._storage_put, esign._storage_fetch = self._put, self._fetch
        auth.SKIP_AUTH = self._skip

    def test_upload_view_remove(self):
        r = self.client.post("/jobroles/jr-sup/jd-file",
                             files={"file": ("Supervisor JD.pdf", pdf_of(2), "application/pdf")})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["jd_file"]["name"], r.json()["jd_file"]["pages"]), ("Supervisor JD.pdf", 2))
        self.assertNotIn("path", r.json()["jd_file"])                # the path never leaves the server
        view = self.client.get("/jobroles/jr-sup/jd-file")
        self.assertEqual((view.status_code, view.headers["content-type"]), (200, "application/pdf"))
        db = database.SessionLocal()
        frozen = hle.role_paperwork(db.get(models.NexusGroup, "jr-sup"))["role_jd_file"]
        db.close()
        self.assertTrue(frozen["path"].startswith("esign/role-jd/jr-sup/"))
        r = self.client.delete("/jobroles/jr-sup/jd-file")
        self.assertEqual(r.json()["jd_file"], {})
        self.assertIn(frozen["path"], self.store)                    # a replaced file is kept for offers made with it

    def test_refuses_what_is_not_a_job_description_file(self):
        for name, blob in (("jd.doc", b"x"), ("jd.png", b"x"), ("jd.pdf", b"not a pdf"), ("jd.pdf", b"")):
            r = self.client.post("/jobroles/jr-sup/jd-file", files={"file": (name, blob, "application/octet-stream")})
            self.assertEqual(r.status_code, 400, (name, r.text))


if __name__ == "__main__":
    unittest.main()
