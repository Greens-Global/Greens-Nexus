"""Construction Round Two item 9 - Drawings, the current set (Neil,
11/06/2026, register only, no pins).

Pins:
  * a job manager adds a sheet; its file is a construction_media row of
    kind 'drawing' (the one upload and Egnyte path); the crew reads, never adds;
  * a new revision of a sheet number supersedes the current one (kept) and
    bells the crew and the managers - one bell per sheet per person, rewritten
    in place by the next revision - and emits drawing.revised;
  * the same revision twice is refused; remove is a soft delete and puts the
    replaced revision back as current;
  * walls: another company's job is a 404.

Run: python -m pytest test_construction_drawings.py -q
"""
import os
import tempfile

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("SUPABASE_URL", None)

import models                                   # noqa: E402
from construction_jobs_testkit import CREW, CREW2, MGR_A, MGR_B, JobsBase  # noqa: E402

PDF = {"url": "data:application/pdf;base64,JVBERi0xLjQK", "mime_type": "application/pdf", "size_bytes": 9,
       "original_name": "A-201.pdf"}


class Base(JobsBase):
    tmp_db = _tmp.name

    def setUp(self):
        super().setUp()
        self.db.query(models.ConstructionDrawing).delete()
        self.db.commit()

    def add(self, sheet="A-201", rev="1", who=MGR_A, job="pa", **kw):
        self.as_(who)
        body = {"sheet_number": sheet, "revision": rev, "title": "First Floor Plan", "discipline": "Architectural",
                "revision_on": "2026-11-02", "file": PDF, **kw}
        return self.client.post(f"/construction/projects/{job}/drawings", json=body)

    def bells(self, em):
        N = models.NexusNotification
        self.db.expire_all()
        return self.db.query(N).filter(N.recipient == em, N.type == "construction_drawing_revised").all()


class Register(Base):
    def test_a_manager_adds_a_sheet_and_the_crew_reads_it(self):
        r = self.add(sheet=" a-201 ")
        self.assertEqual(r.status_code, 201, r.text)
        d = r.json()["drawings"][0]
        self.assertEqual((d["sheetNumber"], d["revision"], d["status"], d["fileName"]), ("A-201", "1", "current", "A-201.pdf"))
        m = self.db.get(models.ConstructionMedia, self.db.get(models.ConstructionDrawing, d["id"]).media_id)
        self.assertEqual((m.kind, m.project_id, m.daily_log_id), ("drawing", "pa", ""))
        self.assertEqual(self.bells(CREW), [])      # a first sheet is not a revision
        self.as_(CREW)
        r = self.client.get("/construction/projects/pa/drawings")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["canEdit"])
        self.assertEqual(len(r.json()["drawings"]), 1)
        self.as_(MGR_B)
        self.assertEqual(self.client.get("/construction/projects/pa/drawings").status_code, 404)

    def test_the_crew_cannot_add_and_a_sheet_needs_its_number_revision_and_file(self):
        self.assertEqual(self.add(who=CREW).status_code, 403)
        self.assertEqual(self.add(sheet="").status_code, 422)
        self.assertEqual(self.add(rev=" ").status_code, 422)
        self.assertEqual(self.add(revision_on="11/02/2026").status_code, 422)
        self.assertEqual(self.add(file={**PDF, "url": ""}).status_code, 422)
        self.assertEqual(self.add(file={**PDF, "mime_type": "application/zip"}).status_code, 422)
        self.assertEqual(self.db.query(models.ConstructionDrawing).count(), 0)

    def test_a_new_revision_supersedes_the_old_and_bells_the_crew_and_managers_once_per_sheet(self):
        first = self.add().json()["drawings"][0]["id"]
        r = self.add(rev="2", title="")
        self.assertEqual(r.status_code, 201, r.text)
        rows = {d["revision"]: d for d in r.json()["drawings"]}
        self.assertEqual((rows["2"]["status"], rows["1"]["status"]), ("current", "superseded"))
        self.assertEqual(rows["1"]["supersededBy"], rows["2"]["id"])
        self.assertEqual(rows["2"]["title"], "First Floor Plan")      # kept from the sheet it replaced
        self.assertEqual(self.db.get(models.ConstructionDrawing, first).deleted_at, "")
        for em in (CREW, CREW2):
            b = self.bells(em)
            self.assertEqual(len(b), 1)
            self.assertEqual(b[0].title, "Drawing Revised")
            self.assertTrue(b[0].body.startswith("A-201 is now Rev 2 - First Floor Plan on Job A."), b[0].body)
        self.assertEqual(self.bells(MGR_A), [])                      # the uploader is not told
        self.assertEqual(self.add(rev="2").status_code, 409)          # the current revision again
        self.add(rev="3")
        b = self.bells(CREW)
        self.assertEqual(len(b), 1)                                   # rewritten in place
        self.assertIn("Rev 3", b[0].body)
        self.assertEqual(b[0].read_by, "")
        W = models.WorkflowEvent
        self.assertEqual(self.db.query(W).filter(W.key == "drawing.revised").count(), 2)

    def test_remove_is_a_soft_delete_and_the_replaced_revision_comes_back(self):
        self.add()
        rev2 = self.add(rev="2").json()["drawings"]
        current = next(d for d in rev2 if d["status"] == "current")
        self.as_(CREW)
        self.assertEqual(self.client.delete(f"/construction/drawings/{current['id']}").status_code, 403)
        self.as_(MGR_A)
        self.assertEqual(self.client.delete(f"/construction/drawings/{current['id']}").status_code, 204)
        self.assertTrue(self.db.get(models.ConstructionDrawing, current["id"]).deleted_at)
        left = self.client.get("/construction/projects/pa/drawings").json()["drawings"]
        self.assertEqual([(d["revision"], d["status"]) for d in left], [("1", "current")])
        self.assertEqual(self.client.delete(f"/construction/drawings/{current['id']}").status_code, 404)

    def test_a_drawing_never_goes_on_a_daily_log_or_the_photo_timeline(self):
        self.as_(MGR_A)
        r = self.client.post("/construction/projects/pa/media", json={**PDF, "kind": "drawing"})
        self.assertEqual(r.status_code, 422)
