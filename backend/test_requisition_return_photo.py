"""A requisition's return photo has to come from our own storage.

confirm_return stored whatever URL it was sent. Photo URLs from clients pass
items.py's _validate_photo_url everywhere else; this is the same check here,
made before the requisition or its asset is touched.

Run with: python -m unittest test_requisition_return_photo -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException

import database
import models
from routers import items
from routers.requisitions import RequisitionConfirmReturn, confirm_return


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(
            f"{__name__} deletes rows and is pointed at {actual!r}, not its own "
            f"temp database. Another test module imported `database` first. "
            f"Run it on its own: python -m unittest {__name__}"
        )


_assert_isolated()

STORAGE = "https://nexus-test.supabase.co/storage/v1/object/public/"
SUPERVISOR = {"email": "sam@greensglobal.com", "level": 2}


class RequisitionReturnPhotoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.ApprovalHistory, models.Requisition, models.HardwareAsset):
            self.db.query(m).delete()
        self.db.add(models.HardwareAsset(id="hw-1", name="Dell Latitude", category="Laptop",
                                         status="Return Pending", assigned_to="Erin Test",
                                         assigned_req_id="req-1"))
        self.db.add(models.Requisition(id="req-1", employee_name="Erin Test", employee_dept="IT",
                                       item="Laptop", status="return_initiated", asset_id="hw-1",
                                       created_at="2026-10-01T10:00:00", updated_at="2026-10-01T10:00:00"))
        self.db.commit()
        self._real = items._STORAGE_PREFIX
        items._STORAGE_PREFIX = STORAGE

    def tearDown(self):
        items._STORAGE_PREFIX = self._real
        self.db.close()

    def _confirm(self, url):
        return confirm_return("req-1", RequisitionConfirmReturn(supervisor_name="Sam", return_photo_url=url),
                              user=SUPERVISOR, db=self.db)

    def test_a_photo_from_somewhere_else_is_refused_and_nothing_changes(self):
        with self.assertRaises(HTTPException) as e:
            self._confirm("https://example.com/fake.jpg")
        self.assertEqual((e.exception.status_code, e.exception.detail),
                         (400, "return_photo_url must be a Supabase storage URL"))
        self.db.rollback()
        req = self.db.get(models.Requisition, "req-1")
        self.assertEqual((req.status, req.return_photo_url or ""), ("return_initiated", ""))
        self.assertEqual(self.db.get(models.HardwareAsset, "hw-1").status, "Return Pending")

    def test_a_photo_from_our_storage_is_stored(self):
        url = STORAGE + "return-photos/req-1/1.jpg"
        req = self._confirm(url)
        self.assertEqual((req.status, req.return_photo_url), ("returned", url))
        self.assertEqual(self.db.get(models.HardwareAsset, "hw-1").status, "Available")

    def test_no_photo_is_still_allowed(self):
        # The check is about where a photo comes from; this legacy flow never
        # required one.
        self.assertEqual(self._confirm("").status, "returned")


if __name__ == "__main__":
    unittest.main()
