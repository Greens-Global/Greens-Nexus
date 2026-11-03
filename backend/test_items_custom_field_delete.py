"""DELETE /items/custom-fields/{id}: who gets 401, 403 and 200 (11/02/2026).

A signed-in caller without the right must get 403, never 401: the frontend
(api.js) reads a 401 as a dead session - it force-refreshes the token and then
sends the person through a full sign-in - so a manager or inventory editor who
clicked Delete was bounced as if signed out. 401 stays for a missing session.

Allowed: a Super Administrator (level 5) or an Access Group grant of
Inventory at Full. A Manager, an Administrator or an Inventory Editor is
refused with 403.

Run on its own: python -m pytest test_items_custom_field_delete.py -q
"""
import _testdb  # noqa: F401 - FIRST import: throwaway DATABASE_URL (unittest skips conftest)

import os
import unittest
import uuid

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models

PROBE = "cfdeleteprobe@greensglobal.com"
GROUP = "GRPCFDELETE01"
REFUSAL = "Only a Super Administrator or someone with Full Inventory access can delete a custom field."


class CustomFieldDeleteCase(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        auth.SKIP_AUTH = True
        os.environ["NEXUS_DEV_EMAIL"] = PROBE
        self._cleanup()
        self.field_id = str(uuid.uuid4())
        db = database.SessionLocal()
        try:
            db.add(models.ItemCustomField(id=self.field_id, field_key=f"k_{self.field_id[:8]}",
                                          label="Probe Field", field_type="text"))
            db.commit()
        finally:
            db.close()

    def tearDown(self):
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.query(models.ItemCustomField).filter(
                models.ItemCustomField.id == self.field_id).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusRole).filter(models.NexusRole.email == PROBE).delete()
            db.query(models.NexusGroupMember).filter(
                models.NexusGroupMember.group_id == GROUP).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()
        auth.invalidate_role_cache()
        cache.module_grants.invalidate()

    def _role(self, role):
        db = database.SessionLocal()
        try:
            db.add(models.NexusRole(email=PROBE, role=role, assigned_by="test"))
            db.commit()
        finally:
            db.close()
        auth.invalidate_role_cache(PROBE)

    def _grant(self, level):
        db = database.SessionLocal()
        try:
            db.merge(models.NexusGroup(id=GROUP, name="Custom Field Delete Probe",
                                       allowed_modules=f"inventory:{level}", created_by="test",
                                       created_at="2026-11-02T00:00:00Z"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=PROBE,
                                           added_by="test", added_at="2026-11-02T00:00:00Z"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()

    def _delete(self):
        return self.client.delete(f"/items/custom-fields/{self.field_id}")

    def _still_there(self):
        db = database.SessionLocal()
        try:
            return db.get(models.ItemCustomField, self.field_id) is not None
        finally:
            db.close()

    def test_no_session_is_401(self):
        auth.SKIP_AUTH = False
        r = self._delete()
        self.assertEqual(r.status_code, 401, r.text)
        self.assertTrue(self._still_there())

    def test_manager_is_403_not_401(self):
        self._role("manager")
        r = self._delete()
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(r.json()["detail"], REFUSAL)
        self.assertTrue(self._still_there())

    def test_administrator_is_403(self):
        self._role("administrator")
        r = self._delete()
        self.assertEqual(r.status_code, 403, r.text)
        self.assertTrue(self._still_there())

    def test_inventory_editor_is_403(self):
        self._grant("editor")
        r = self._delete()
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(r.json()["detail"], REFUSAL)
        self.assertTrue(self._still_there())

    def test_super_administrator_deletes(self):
        self._role("owner")
        r = self._delete()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(self._still_there())

    def test_full_inventory_grant_deletes(self):
        self._grant("full")
        r = self._delete()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(self._still_there())


if __name__ == "__main__":
    unittest.main()
