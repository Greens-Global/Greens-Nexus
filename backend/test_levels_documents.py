"""Files (documents) grant levels on Nexus Sign (11/12/2026, routers/esign.py
_hr_or_documents): Viewer opens the screen and signs what is sent to them,
Editor also keeps sign templates and sends envelopes (and opens the ones they
sent), Full also voids, corrects and deletes; the HR lists stay People's.

    python -m pytest test_levels_documents.py
"""
import unittest

import levels_testkit as kit

kit.bind_db()

from fastapi.testclient import TestClient  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
VIEWER, EDITOR, FULL, HR = "dc.viewer" + D, "dc.editor" + D, "dc.full" + D, "dc.hr" + D
TPL = {"name": "Vendor NDA", "kind": "custom", "body": ["Keep it quiet. [[sign:party]]"],
       "roles": [{"key": "party", "label": "Party", "order": 1}]}


class DocumentsLevelTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        db = database.SessionLocal()
        try:
            kit.reset(db, models.HrSignTemplate, models.HrSignRequest, models.HrSignParty, models.HrSignEvent)
            for em in (VIEWER, EDITOR, FULL, HR):
                kit.person(db, em)
            kit.grant(db, VIEWER, "documents:viewer")
            kit.grant(db, EDITOR, "documents:editor")
            kit.grant(db, FULL, "documents:full")
            kit.grant(db, HR, "hr:editor")
            db.add(models.HrSignTemplate(id="t1", name="Old", created_by=HR))
            db.add(models.HrSignRequest(id="r-mine", title="Mine", created_by=EDITOR, status="pending"))
            db.add(models.HrSignRequest(id="r-hr", title="HR's", created_by=HR, status="pending"))
            db.commit()
        finally:
            db.close()
        kit.refresh()

    def test_viewer_cannot_send_or_keep_templates(self):
        kit.as_(VIEWER)
        self.assertEqual(self.client.get("/esign/templates").status_code, 403)
        self.assertEqual(self.client.post("/esign/templates", json=TPL).status_code, 403)
        self.assertEqual(self.client.get("/esign/requests/r-mine").status_code, 403)

    def test_editor_sends_and_opens_own_envelopes_only(self):
        kit.as_(EDITOR)
        self.assertEqual(self.client.get("/esign/templates").status_code, 200)
        self.assertEqual(self.client.post("/esign/templates", json=TPL).status_code, 200)
        self.assertEqual(self.client.get("/esign/requests/r-mine").status_code, 200)
        self.assertEqual(self.client.get("/esign/requests/r-hr").status_code, 404)
        self.assertEqual(self.client.get("/esign/requests").status_code, 403)       # the HR list
        self.assertEqual(self.client.post("/esign/requests/r-mine/void").status_code, 403)
        self.assertIn(self.client.delete("/esign/templates/t1").status_code, (401, 403))

    def test_full_voids_and_deletes_but_hr_lists_stay_peoples(self):
        kit.as_(FULL)
        self.assertEqual(self.client.post("/esign/requests/r-hr/void").status_code, 200)
        self.assertEqual(self.client.delete("/esign/templates/t1").status_code, 200)
        self.assertEqual(self.client.get("/esign/requests").status_code, 403)

    def test_people_editor_keeps_everything_it_had(self):
        kit.as_(HR)
        self.assertEqual(self.client.get("/esign/requests").status_code, 200)
        self.assertEqual(self.client.get("/esign/requests/r-mine").status_code, 200)
        self.assertEqual(self.client.post("/esign/templates", json=TPL).status_code, 200)


if __name__ == "__main__":
    unittest.main()
