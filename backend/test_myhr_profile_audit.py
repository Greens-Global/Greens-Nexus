"""My HR self-service profile edits are audited (11/11/2026).

An HR edit to a person's record writes one "Changed employee fields" Audit
Log row with old -> new per field (hr.apply_profile_update, Sep 22). The
employee's own save in My HR (phone, personal email, emergency contact)
wrote none, so a changed phone or emergency contact could not be traced.
It now writes the same row, marked as self-service, and only when
something actually changed.

    python -m pytest test_myhr_profile_audit.py
"""
import json
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_RATE_LIMIT", "off")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

EMP = "erin.emp@greensglobal.com"


class MyHrProfileAuditTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        os.environ["NEXUS_DEV_EMAIL"] = EMP
        db = database.SessionLocal()
        for m in (models.NexusEmployee, models.AuditLog):
            db.query(m).execution_options(include_deleted=True).delete()
        db.add(models.NexusEmployee(id="e1", first_name="Erin", last_name="Emp", work_email=EMP,
                                    phone="555-0100", personal_email="erin@home.com", status="active",
                                    personal={"emergency": {"name": "Sam", "relationship": "Brother", "phone": "555-0199"}},
                                    deleted_at=""))
        db.commit()
        db.close()

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    def _rows(self):
        db = database.SessionLocal()
        try:
            return db.query(models.AuditLog).filter(models.AuditLog.action == "Changed employee fields").all()
        finally:
            db.close()

    def test_a_self_service_change_writes_old_and_new(self):
        r = self.client.put("/myhr/profile", json={"phone": "555-0111", "emergency_phone": "555-0122"})
        self.assertEqual(r.status_code, 200, r.text)
        rows = self._rows()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual((row.user_email, row.resource_type, row.resource_id), (EMP, "employee", "e1"))
        details = json.loads(row.details)
        self.assertEqual(details["changes"], {"phone": ["555-0100", "555-0111"],
                                              "emergency_phone": ["555-0199", "555-0122"]})
        self.assertEqual(details["source"], "My HR (self-service)")

    def test_a_save_that_changes_nothing_writes_nothing(self):
        r = self.client.put("/myhr/profile", json={"phone": "555-0100", "emergency_name": "Sam"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._rows(), [])


if __name__ == "__main__":
    unittest.main()
