"""Editable sign-in policy (Sep 26, 2026).

Proves the defaults are the text and version everyone already accepted (so a
deploy re-prompts nobody), that saving a draft never changes the version, that
publishing does and re-prompts, that an acceptance is always of the version on
screen, the acceptance report, and that only Administrators can edit.

    python -m pytest test_policy_config.py
"""
import os
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models
from routers import policy

models.Base.metadata.create_all(bind=database.engine)

ADMIN = "pcfg.admin@greensglobal.com"
EMP = "pcfg.emp@greensglobal.com"
EMP2 = "pcfg.emp2@greensglobal.com"
GUEST = "pcfg.guest@partner.example"


class PolicyConfigTests(unittest.TestCase):
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
            for email, first, itype in ((ADMIN, "Ada", "internal"), (EMP, "Eve", "internal"),
                                        (EMP2, "Zed", "internal"), (GUEST, "Gus", "guest")):
                db.add(models.NexusEmployee(id=f"e-{email}", first_name=first, last_name="Pcfg",
                                            work_email=email, status="active", deleted_at="",
                                            identity_type=itype))
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
            db.query(models.NexusSetting).filter(models.NexusSetting.key == policy.SETTINGS_KEY).delete()
            db.query(models.PolicyAcknowledgment).filter(
                models.PolicyAcknowledgment.email.like("pcfg.%")).delete(synchronize_session=False)
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email.like("pcfg.%")).delete(synchronize_session=False))
            db.query(models.NexusRole).filter(models.NexusRole.email.like("pcfg.%")).delete(
                synchronize_session=False)
            db.query(models.AuditLog).filter(models.AuditLog.user_email.like("pcfg.%")).delete(
                synchronize_session=False)
            db.commit()
        finally:
            db.close()
        for e in (ADMIN, EMP, EMP2, GUEST):
            auth.invalidate_role_cache(e)
        cache.settings_config.invalidate()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache(email)

    def _status(self):
        r = self.client.get("/policy/status")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_defaults_are_the_text_and_version_already_accepted(self):
        s = self._status()
        self.assertEqual(s["version"], "2026-07-21")
        self.assertEqual(s["title"], "Company Policies & Monitoring")
        self.assertIn("Employee monitoring", s["body"])
        self.assertIn("does NOT capture your keystrokes", s["body"])
        # Someone who accepted before this change is not asked again.
        db = database.SessionLocal()
        try:
            db.add(models.PolicyAcknowledgment(id="pcfg-old", email=ADMIN, version="2026-07-21",
                                               accepted_at="2026-07-22T00:00:00+00:00"))
            db.commit()
        finally:
            db.close()
        self.assertTrue(self._status()["accepted"])

    def test_draft_does_not_change_the_version(self):
        self.client.post("/policy/accept", json={"version": "2026-07-21"})
        r = self.client.put("/policy/draft", json={"title": "New", "body": "## Rules\nBe kind."})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["draft"]["body"], "## Rules\nBe kind.")
        s = self._status()
        self.assertEqual(s["version"], "2026-07-21")
        self.assertTrue(s["accepted"])
        self.assertEqual(s["title"], "Company Policies & Monitoring")
        self.assertEqual(self.client.delete("/policy/draft").json()["draft"], None)

    def test_publish_bumps_the_version_and_reprompts(self):
        self.client.post("/policy/accept", json={"version": "2026-07-21"})
        self.client.put("/policy/draft", json={"title": "New", "body": "Draft"})
        r = self.client.post("/policy/publish", json={"title": "Rules v2", "body": "## Rules\n- One\n- Two"})
        self.assertEqual(r.status_code, 200, r.text)
        v = r.json()["published"]["version"]
        self.assertNotEqual(v, "2026-07-21")
        self.assertIsNone(r.json()["draft"])
        s = self._status()
        self.assertEqual((s["version"], s["title"], s["accepted"]), (v, "Rules v2", False))
        # A second publish the same day is still a new version.
        v2 = self.client.post("/policy/publish", json={"title": "Rules v3", "body": "x"}).json()["published"]["version"]
        self.assertNotEqual(v2, v)
        self.assertTrue(v2.startswith(v.split(".")[0]))
        db = database.SessionLocal()
        try:
            actions = [a.action for a in db.query(models.AuditLog).filter(
                models.AuditLog.user_email == ADMIN, models.AuditLog.resource_type == "policy")]
            self.assertTrue(any(v in a for a in actions), actions)
        finally:
            db.close()

    def test_accepting_a_stale_version_is_refused(self):
        self.client.post("/policy/publish", json={"title": "T", "body": "B"})
        self.assertEqual(self.client.post("/policy/accept", json={"version": "2026-07-21"}).status_code, 409)
        self.assertEqual(self.client.post("/policy/accept", json={"version": self._status()["version"]}).status_code, 200)
        self.assertTrue(self._status()["accepted"])
        # An older client that sends no version still records the current one.
        self._as(EMP)
        self.assertEqual(self.client.post("/policy/accept").status_code, 200)
        self.assertTrue(self._status()["accepted"])

    def test_next_version(self):
        self.assertEqual(policy._next_version("2026-07-21", "2026-09-26"), "2026-09-26")
        self.assertEqual(policy._next_version("2026-09-26", "2026-09-26"), "2026-09-26.2")
        self.assertEqual(policy._next_version("2026-09-26.2", "2026-09-26"), "2026-09-26.3")

    def test_report_lists_internal_people_who_have_not_accepted(self):
        self._as(EMP)
        self.client.post("/policy/accept")
        self._as(ADMIN)
        rep = self.client.get("/policy/report").json()
        pending = {p["email"] for p in rep["pending"]}
        self.assertIn(EMP2, pending)
        self.assertIn(ADMIN, pending)
        self.assertNotIn(EMP, pending)
        self.assertNotIn(GUEST, pending)   # external identities are not in the report
        r = self.client.get("/policy/report.csv")
        self.assertEqual(r.status_code, 200)
        self.assertIn("text/csv", r.headers["content-type"])
        self.assertIn(EMP2, r.text)
        self.assertNotIn(EMP + ",", r.text)

    def test_validation(self):
        self.assertEqual(self.client.put("/policy/draft", json={"title": "", "body": "x"}).status_code, 400)
        self.assertEqual(self.client.post("/policy/publish", json={"title": "x", "body": " "}).status_code, 400)

    def test_employees_cannot_edit_or_see_the_report(self):
        self._as(EMP)
        for method, path, body in (("get", "/policy/config", None), ("put", "/policy/draft", {"title": "a", "body": "b"}),
                                   ("post", "/policy/publish", {"title": "a", "body": "b"}),
                                   ("delete", "/policy/draft", None), ("get", "/policy/report", None),
                                   ("get", "/policy/report.csv", None)):
            kw = {"json": body} if body is not None else {}
            r = getattr(self.client, method)(path, **kw)
            self.assertIn(r.status_code, (401, 403), path)
        self.assertEqual(self._status()["version"], "2026-07-21")


if __name__ == "__main__":
    unittest.main()
