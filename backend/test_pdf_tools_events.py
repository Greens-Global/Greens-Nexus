"""PDF Tools: who did what (Neil, 11/02/2026) - routers/pdf_tools.py.

  - One action = one audit_logs row: the router writes it and AuditMiddleware,
    which runs for real here, adds no second one.
  - Only the listed actions are taken; a name, a path and a page count are
    kept, cut to their caps, and nothing else a client sends is stored.
  - The row shows on the Audit Log: the legacy /audit-logs list and the unified
    /audit/events feed, under Documents & E-Sign, with its own title.
  - Signed out = no row.

Uses a throwaway sqlite file.

Run with: python -m pytest test_pdf_tools_events.py   (one file per process - CLAUDE.md)
"""
import json
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
OWNER = "pdfprobe.owner@greensglobal.com"
EMPLOYEE = "pdfprobe.emp@greensglobal.com"
os.environ["NEXUS_DEV_EMAIL"] = EMPLOYEE

from fastapi import HTTPException                       # noqa: E402
from fastapi.testclient import TestClient               # noqa: E402

import audit_modules                                    # noqa: E402
import auth                                             # noqa: E402
import database                                         # noqa: E402
import main                                             # noqa: E402
import models                                           # noqa: E402
from routers import audit_events                        # noqa: E402
from routers import pdf_tools                           # noqa: E402

models.Base.metadata.create_all(bind=database.engine)
main._run_migrations()

SECRET = "PATIENT NAME: Jane Secret, SSN 000-00-0000"


class PdfToolsEvents(unittest.TestCase):
    def setUp(self):
        db = database.SessionLocal()
        try:
            db.query(models.AuditLog).delete(synchronize_session=False)
            db.query(models.NexusRole).filter(models.NexusRole.email.in_([OWNER, EMPLOYEE])).delete(
                synchronize_session=False)
            db.add(models.NexusRole(email=OWNER, role="owner", assigned_by="test"))
            db.add(models.NexusRole(email=EMPLOYEE, role="employee", assigned_by="test"))
            db.commit()
        finally:
            db.close()
        auth.invalidate_role_cache()
        os.environ["NEXUS_DEV_EMAIL"] = EMPLOYEE
        audit_events._FACETS.clear()
        audit_events._CUTOFF.update(at=0.0, value=None)
        self.client = TestClient(main.app)

    def tearDown(self):
        main.app.dependency_overrides.pop(auth.get_current_user, None)

    def _rows(self):
        db = database.SessionLocal()
        try:
            return db.query(models.AuditLog).order_by(models.AuditLog.id).all()
        finally:
            db.close()

    def _post(self, **body):
        return self.client.post("/pdf-tools/events", json=body)

    def test_one_action_is_one_row(self):
        r = self._post(action="save_egnyte", fileName="Lease.pdf", pages=12,
                       source="/Shared/Leases/Lease.pdf", destination="/Shared/Leases/Lease.pdf")
        self.assertEqual(r.status_code, 200, r.text)
        rows = self._rows()
        self.assertEqual(len(rows), 1, [(x.action, x.resource_type) for x in rows])
        row = rows[0]
        self.assertEqual(row.resource_type, "pdf_tools")
        self.assertEqual(row.action, "Saved a PDF to Egnyte from PDF Tools")
        self.assertEqual(row.user_email, EMPLOYEE)
        self.assertEqual(row.module, "documents")
        self.assertEqual(row.kind, "create")
        details = json.loads(row.details)
        self.assertEqual(details["file_name"], "Lease.pdf")
        self.assertEqual(details["pages"], 12)
        self.assertEqual(details["source"], "/Shared/Leases/Lease.pdf")
        self.assertEqual(details["destination"], "/Shared/Leases/Lease.pdf")
        self.assertEqual(details["event"], "save_egnyte")

    def test_every_listed_action_has_a_title_and_a_real_kind(self):
        self.assertEqual(set(pdf_tools.ACTIONS),
                         {"open", "download", "export", "redact", "protect", "save_egnyte", "send_sign"})
        for action, (title, kind) in pdf_tools.ACTIONS.items():
            self.assertIn(kind, audit_modules.KINDS, action)
            r = self._post(action=action, fileName="a.pdf")
            self.assertEqual(r.status_code, 200, action)
            self.assertEqual(self._rows()[-1].action, title)
        self.assertEqual(len(self._rows()), len(pdf_tools.ACTIONS))

    def test_an_unlisted_action_writes_nothing_of_ours(self):
        for action in ("delete", "", "OPEN", "open; drop"):
            r = self._post(action=action, fileName="a.pdf")
            self.assertIn(r.status_code, (400, 422), action)
        self.assertFalse([x for x in self._rows() if x.resource_type == "pdf_tools"])

    def test_a_missing_action_is_refused(self):
        self.assertEqual(self._post(fileName="a.pdf").status_code, 422)

    def test_values_are_cut_to_their_caps(self):
        r = self._post(action="open", fileName="n" * 4000 + ".pdf", pages=10 ** 12,
                       source="s" * 4000, destination="d" * 4000)
        self.assertEqual(r.status_code, 200, r.text)
        details = json.loads(self._rows()[-1].details)
        self.assertEqual(len(details["file_name"]), pdf_tools.NAME_CAP)
        self.assertEqual(len(details["source"]), pdf_tools.PLACE_CAP)
        self.assertEqual(len(details["destination"]), pdf_tools.PLACE_CAP)
        self.assertEqual(details["pages"], pdf_tools.MAX_PAGES)

    def test_a_body_past_any_real_name_is_refused(self):
        r = self._post(action="open", fileName="n" * (pdf_tools.BODY_CAP + 1))
        self.assertEqual(r.status_code, 422)
        self.assertFalse([x for x in self._rows() if x.resource_type == "pdf_tools"])

    def test_control_characters_and_a_negative_count_are_cleaned(self):
        self._post(action="open", fileName="a\r\n\tb\x00.pdf", pages=-4)
        details = json.loads(self._rows()[-1].details)
        self.assertEqual(details["file_name"], "a b .pdf")
        self.assertNotIn("pages", details)

    def test_nothing_else_a_client_sends_is_stored(self):
        r = self._post(action="redact", fileName="a.pdf", text=SECRET, content=SECRET, bytes=SECRET,
                       details={"text": SECRET})
        self.assertEqual(r.status_code, 200, r.text)
        rows = self._rows()
        self.assertEqual(len(rows), 1)
        for field in (rows[0].details, rows[0].action, rows[0].resource_id):
            self.assertNotIn("Jane", field or "")
        self.assertEqual(set(json.loads(rows[0].details)),
                         {"path", "method", "status", "file_name", "event"})

    def test_signed_out_writes_no_row(self):
        def refuse():
            raise HTTPException(status_code=401, detail="Not signed in")
        main.app.dependency_overrides[auth.get_current_user] = refuse
        self.assertEqual(self._post(action="open", fileName="a.pdf").status_code, 401)
        self.assertFalse([x for x in self._rows() if x.resource_type == "pdf_tools"])

    def test_it_shows_on_the_audit_screens(self):
        self._post(action="redact", fileName="Lease.pdf", pages=3, source="/Shared/Lease.pdf")
        os.environ["NEXUS_DEV_EMAIL"] = OWNER
        auth.invalidate_role_cache()

        legacy = self.client.get("/audit-logs", params={"resource_type": "pdf_tools"})
        self.assertEqual(legacy.status_code, 200, legacy.text)
        self.assertEqual([x["action"] for x in legacy.json()["rows"]], ["Redacted a PDF in PDF Tools"])

        feed = self.client.get("/audit/events", params={"module": "documents"})
        self.assertEqual(feed.status_code, 200, feed.text)
        all_events = feed.json()["events"]
        events = [e for e in all_events if e["title"] == "Redacted a PDF in PDF Tools"]
        self.assertEqual(len(events), 1, all_events)
        event = events[0]
        self.assertEqual(event["module"], "documents")
        self.assertEqual(event["action"], "update")
        self.assertEqual(event["actor"]["email"], EMPLOYEE)
        self.assertIn("File Name: Lease.pdf", event["summary"])
        self.assertIn("Pages: 3", event["summary"])
        self.assertIn("Source: /Shared/Lease.pdf", event["summary"])

    def test_module_map_and_external_prefix(self):
        self.assertEqual(audit_modules.module_for_resource("pdf_tools", ""), "documents")
        self.assertEqual(audit_modules.module_for_resource("pdf-tools", ""), "documents")
        self.assertIn("/pdf-tools", auth.MODULE_API_PREFIXES["documents"])


if __name__ == "__main__":
    unittest.main()
