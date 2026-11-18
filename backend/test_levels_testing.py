"""Testing grant levels (11/12/2026, routers/qa.py): Viewer reads and records
results, Editor keeps the case library and bug reports, Full deletes a run.

    python -m pytest test_levels_testing.py
"""
import os
import unittest

import levels_testkit as kit

kit.bind_db()
os.environ["NEXUS_QA_MODULE"] = "true"

from fastapi.testclient import TestClient  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
VIEWER, EDITOR, FULL = "qa.viewer" + D, "qa.editor" + D, "qa.full" + D
CASE = {"module": "Tasks", "title": "Create a task", "steps": ["Open Tasks", "Add"], "expected": "A task"}


class TestingLevelTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        db = database.SessionLocal()
        try:
            kit.reset(db, models.QaRun, models.QaTestCase, models.QaResult, models.QaAssignment)
            for em in (VIEWER, EDITOR, FULL):
                kit.person(db, em)
            kit.grant(db, VIEWER, "testing:viewer")
            kit.grant(db, EDITOR, "testing:editor")
            kit.grant(db, FULL, "testing:full")
            db.add(models.QaRun(id="run1", name="Sprint", status="open", created_by=FULL))
            db.commit()
        finally:
            db.close()
        kit.refresh()

    def test_viewer_reads_and_records_but_does_not_edit_cases(self):
        kit.as_(VIEWER)
        self.assertEqual(self.client.get("/qa/runs").status_code, 200)
        self.assertEqual(self.client.post("/qa/cases", json=CASE).status_code, 403)
        self.assertEqual(self.client.delete("/qa/runs/run1").status_code, 403)

    def test_editor_edits_cases_but_does_not_delete_runs(self):
        kit.as_(EDITOR)
        self.assertEqual(self.client.post("/qa/cases", json=CASE).status_code, 201)
        self.assertEqual(self.client.delete("/qa/runs/run1").status_code, 403)

    def test_full_deletes_a_run(self):
        kit.as_(FULL)
        self.assertEqual(self.client.delete("/qa/runs/run1").status_code, 204)


if __name__ == "__main__":
    unittest.main()
