"""The branding config carries the company's default for the left
navigation's motion (Neil, 11/01/2026): `navMotion` is one of off / subtle /
lively / bold, Lively when nothing was ever saved, an invalid stored value
reads as Lively, and the PUT refuses anything else.

Run on its own: `python -m pytest test_branding_nav_motion.py` (one file
per process - see CLAUDE.md)."""
import json
import os
import unittest

import _testdb  # noqa: F401,E402  - a throwaway database whatever runner imports this file

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import branding  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

ADMIN = "navmotion.admin@greensglobal.com"
EMP = "navmotion.emp@greensglobal.com"


class NavMotionTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusRole(email=ADMIN, role="administrator"))
            db.add(models.NexusRole(email=EMP, role="employee"))
            db.commit()
        finally:
            db.close()
        self._as(ADMIN)

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusSetting).filter(models.NexusSetting.key == branding._SETTINGS_KEY).delete(
                synchronize_session=False)
            db.query(models.NexusRole).filter(models.NexusRole.email.like("navmotion.%")).delete(
                synchronize_session=False)
            db.query(models.AuditLog).filter(models.AuditLog.user_email.like("navmotion.%")).delete(
                synchronize_session=False)
            db.commit()
        finally:
            db.close()
        for e in (ADMIN, EMP):
            auth.invalidate_role_cache(e)
        cache.settings_config.invalidate()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache(email)

    def test_lively_until_something_is_saved(self):
        r = self.client.get("/branding/config")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["navMotion"], "lively")

    def test_save_keeps_it_and_audits_it(self):
        r = self.client.put("/branding/config", json={"accent": "green", "navMotion": "subtle"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["navMotion"], "subtle")
        cache.settings_config.invalidate()
        self.assertEqual(self.client.get("/branding/config").json()["navMotion"], "subtle")
        db = database.SessionLocal()
        try:
            row = db.query(models.AuditLog).filter(models.AuditLog.user_email == ADMIN,
                                                   models.AuditLog.resource_type == "branding").first()
            self.assertIsNotNone(row)
            self.assertIn("subtle", row.action)
        finally:
            db.close()

    def test_a_first_save_without_the_field_reads_lively(self):
        r = self.client.put("/branding/config", json={"accent": "blue"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["navMotion"], "lively")

    def test_a_save_without_the_field_keeps_the_stored_strength(self):
        # An older client (a deploy window) or a color-only save must not
        # reset a company's choice.
        self.assertEqual(self.client.put("/branding/config", json={"accent": "green", "navMotion": "subtle"}).status_code, 200)
        r = self.client.put("/branding/config", json={"accent": "blue"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["navMotion"], "subtle")
        self.assertEqual(self.client.get("/branding/config").json()["navMotion"], "subtle")

    def test_refuses_an_unknown_strength(self):
        r = self.client.put("/branding/config", json={"accent": "green", "navMotion": "wild"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("Navigation motion", r.json()["detail"])

    def test_a_broken_stored_value_reads_as_lively(self):
        db = database.SessionLocal()
        try:
            db.add(models.NexusSetting(key=branding._SETTINGS_KEY,
                                       value=json.dumps({"accent": "green", "navMotion": "bouncy"})))
            db.commit()
        finally:
            db.close()
        cache.settings_config.invalidate()
        self.assertEqual(self.client.get("/branding/config").json()["navMotion"], "lively")

    def test_only_an_administrator_saves(self):
        self._as(EMP)
        r = self.client.put("/branding/config", json={"accent": "green", "navMotion": "off"})
        self.assertIn(r.status_code, (401, 403))


if __name__ == "__main__":
    unittest.main()
