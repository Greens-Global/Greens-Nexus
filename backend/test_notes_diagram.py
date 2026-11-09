"""Diagram From a Sentence stays OFF (Neil, 11/08/2026): the route answers
403 ai_off and never reaches the AI call unless AI is on for Nexus AND a
Super Administrator turned the setting on; the setting refuses true while AI
is off; only a Super Administrator changes it; GET says aiAvailable false.

Run on its own: `python -m pytest test_notes_diagram.py` (one file per
process - see CLAUDE.md)."""
import json
import os
import unittest
from unittest import mock

import _testdb  # noqa: F401,E402  - a throwaway database whatever runner imports this file

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import kb_ai  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import notes_diagram  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

SUPER = "dgai.super@greensglobal.com"
ADMIN4 = "dgai.admin4@greensglobal.com"
EMP = "dgai.emp@greensglobal.com"


class DiagramAiOffTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusRole(email=SUPER, role="owner"))
            db.add(models.NexusRole(email=ADMIN4, role="administrator"))
            db.add(models.NexusRole(email=EMP, role="employee"))
            db.commit()
        finally:
            db.close()
        self._as(SUPER)

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
            db.query(models.NexusSetting).filter(models.NexusSetting.key == notes_diagram.SETTING_KEY).delete(synchronize_session=False)
            db.query(models.NexusRole).filter(models.NexusRole.email.like("dgai.%")).delete(synchronize_session=False)
            db.query(models.AuditLog).filter(models.AuditLog.user_email.like("dgai.%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()
        for e in (SUPER, ADMIN4, EMP):
            auth.invalidate_role_cache(e)

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache(email)

    def _store(self, enabled):
        # Straight into the row, as if someone had gone round the PUT.
        db = database.SessionLocal()
        try:
            db.add(models.NexusSetting(key=notes_diagram.SETTING_KEY, value=json.dumps({"enabled": enabled})))
            db.commit()
        finally:
            db.close()

    def test_the_process_has_ai_off(self):
        # main.py ran ai_switch.apply(): no NEXUS_AI_ENABLED here, so no key either.
        self.assertNotEqual((os.environ.get("NEXUS_AI_ENABLED") or "").strip().lower(), "true")
        self.assertEqual(os.environ.get("ANTHROPIC_API_KEY", ""), "")
        self.assertFalse(notes_diagram.ai_available())

    def test_get_says_ai_is_not_available(self):
        self._as(EMP)
        r = self.client.get("/notes/diagram/settings")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"diagramAiEnabled": False, "aiAvailable": False})

    def test_route_is_off_and_never_calls_the_ai(self):
        with mock.patch.object(kb_ai, "_call", side_effect=AssertionError("the AI was called")) as call:
            r = self.client.post("/notes/diagram/from-sentence", json={"sentence": "A gate and an office"})
            self.assertEqual(r.status_code, 403, r.text)
            self.assertEqual(r.json()["detail"]["code"], "ai_off")
            # A stored true (someone went round the PUT) changes nothing while AI is off.
            self._store(True)
            r = self.client.post("/notes/diagram/from-sentence", json={"sentence": "A gate and an office"})
            self.assertEqual(r.status_code, 403, r.text)
            self.assertEqual(self.client.get("/notes/diagram/settings").json()["diagramAiEnabled"], False)
            call.assert_not_called()

    def test_with_ai_on_but_the_setting_off_it_still_never_calls(self):
        with mock.patch.object(notes_diagram, "ai_available", return_value=True), \
                mock.patch.object(kb_ai, "_call", side_effect=AssertionError("the AI was called")) as call:
            r = self.client.post("/notes/diagram/from-sentence", json={"sentence": "A gate and an office"})
            self.assertEqual(r.status_code, 403, r.text)
            self.assertEqual(r.json()["detail"]["code"], "ai_off")
            call.assert_not_called()

    def test_both_on_uses_the_house_call(self):
        with mock.patch.object(notes_diagram, "ai_available", return_value=True), \
                mock.patch.object(kb_ai, "_call", return_value="```\nOffice -> Gate | lock\n```") as call:
            self._store(True)
            r = self.client.post("/notes/diagram/from-sentence", json={"sentence": "An office opens the gate"})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["text"], "Office -> Gate | lock")
            call.assert_called_once()

    def test_the_setting_refuses_true_while_ai_is_off(self):
        r = self.client.put("/notes/diagram/settings", json={"diagramAiEnabled": True})
        self.assertEqual(r.status_code, 409, r.text)
        self.assertIn("Super Administrator", r.json()["detail"])
        self.assertFalse(notes_diagram._stored(database.SessionLocal()))
        # Off is always allowed.
        r = self.client.put("/notes/diagram/settings", json={"diagramAiEnabled": False})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"diagramAiEnabled": False, "aiAvailable": False})

    def test_only_a_super_administrator_changes_it(self):
        for who in (ADMIN4, EMP):
            self._as(who)
            r = self.client.put("/notes/diagram/settings", json={"diagramAiEnabled": False})
            self.assertEqual(r.status_code, 403, who)
        self._as(SUPER)
        with mock.patch.object(notes_diagram, "ai_available", return_value=True):
            r = self.client.put("/notes/diagram/settings", json={"diagramAiEnabled": True})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json(), {"diagramAiEnabled": True, "aiAvailable": True})


if __name__ == "__main__":
    unittest.main()
