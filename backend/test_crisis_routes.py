"""Crisis support on the routes that would generate an AI answer (11/02/2026):
Ask Nexus (/help-center/ask), the Knowledge Base ask (/kb/ask) and the
assistant (/assistant/ask) return the crisis resources INSTEAD of an answer -
whether AI is on or off, never calling the model, never storing the message;
the resources follow the person's country (their own, else their company's);
/policy/status carries that country for the browser's card.

Run on its own: `python -m pytest test_crisis_routes.py` (one file per
process - see CLAUDE.md)."""
import os
import unittest
import uuid

import _testdb  # noqa: F401  - a throwaway database whatever runner imports this file

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import kb_ai  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

IN_EMP = "crisis.india@greensglobal.com"
US_EMP = "crisis.us@greensglobal.com"
NOBODY = "crisis.nobody@greensglobal.com"   # not on the People list
CRISIS = "honestly I want to end my life"


class CrisisRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            self.ent = str(uuid.uuid4())
            db.add(models.HrEntity(id=self.ent, name="Crisis India Co", country="IN"))
            # India by the company (no country of their own); US by their own.
            db.add(models.NexusEmployee(id=str(uuid.uuid4()), work_email=IN_EMP, first_name="In",
                                        last_name="Person", company=self.ent, country=""))
            db.add(models.NexusEmployee(id=str(uuid.uuid4()), work_email=US_EMP, first_name="Us",
                                        last_name="Person", company=self.ent, country="US"))
            for e in (IN_EMP, US_EMP, NOBODY):
                db.add(models.NexusRole(email=e, role="employee"))
            db.commit()
        finally:
            db.close()
        # The model must never be called for a crisis message.
        self._orig = (kb_ai.answer_help, kb_ai.answer, kb_ai.available)

        def boom(*a, **k):
            raise AssertionError("the model was called for a crisis message")
        kb_ai.answer_help = boom
        kb_ai.answer = boom

    def tearDown(self):
        kb_ai.answer_help, kb_ai.answer, kb_ai.available = self._orig
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email.like("crisis.%")).delete(
                synchronize_session=False)
            db.query(models.NexusRole).filter(models.NexusRole.email.like("crisis.%")).delete(
                synchronize_session=False)
            db.query(models.HrEntity).filter(models.HrEntity.name == "Crisis India Co").delete(
                synchronize_session=False)
            db.query(models.AiConversation).filter(models.AiConversation.user_email.like("crisis.%")).delete(
                synchronize_session=False)
            db.commit()
        finally:
            db.close()
        for e in (IN_EMP, US_EMP, NOBODY):
            auth.invalidate_role_cache(e)

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache(email)

    def _countries(self, body):
        return [b["country"] for b in body["crisis"]["resources"]]

    def test_help_center_ask_returns_resources_not_an_answer(self):
        for online in (False, True):
            with self.subTest(online=online):
                kb_ai.available = lambda online=online: online
                self._as(IN_EMP)
                r = self.client.post("/help-center/ask", json={"question": CRISIS, "guide": []})
                self.assertEqual(r.status_code, 200, r.text)
                body = r.json()
                self.assertEqual(body["answer"], "")
                self.assertEqual(self._countries(body), ["IN"])
                self.assertEqual(body["crisis"]["title"], "You Are Not Alone")

    def test_kb_ask_returns_resources(self):
        kb_ai.available = lambda: True
        self._as(US_EMP)
        r = self.client.post("/kb/ask", json={"question": CRISIS})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["answer"], "")
        self.assertEqual(self._countries(r.json()), ["US"])

    def test_assistant_returns_resources_even_with_ai_off_and_stores_nothing(self):
        self._as(NOBODY)
        r = self.client.post("/assistant/ask", json={"message": CRISIS})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["reply"], "")
        self.assertEqual(self._countries(r.json()), ["US", "IN"])   # unknown: both
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.AiConversation)
                             .filter(models.AiConversation.user_email == NOBODY).count(), 0)
        finally:
            db.close()

    def test_an_ordinary_question_is_unchanged(self):
        kb_ai.available = lambda: False
        self._as(US_EMP)
        r = self.client.post("/help-center/ask", json={"question": "How do I request time off?", "guide": []})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("crisis", r.json())
        self.assertTrue(r.json()["offline"])

    def test_search_logs_never_keep_crisis_words(self):
        import kb_search
        self._as(US_EMP)
        db = database.SessionLocal()
        try:
            before = db.query(models.KbSearchLog).count()
            kb_search.log_miss(db, CRISIS, 0, US_EMP, source="help", floor=10 ** 6)
            r = self.client.post("/help-center/search-log", json={"q": "i want to kill myself", "results": 0, "source": "help"})
            self.assertIn(r.status_code, (200, 204), r.text)
            r = self.client.get("/kb/search", params={"q": "thinking about suicide"})
            self.assertEqual(r.status_code, 200, r.text)
            db.expire_all()
            self.assertEqual(db.query(models.KbSearchLog).count(), before)
            # An ordinary miss is still logged.
            kb_search.log_miss(db, "payroll calendar", 0, US_EMP, source="help", floor=10 ** 6)
            db.commit()
            self.assertEqual(db.query(models.KbSearchLog).count(), before + 1)
            db.query(models.KbSearchLog).filter(models.KbSearchLog.query == "payroll calendar").delete()
            db.commit()
        finally:
            db.close()

    def test_policy_status_carries_the_country(self):
        self._as(IN_EMP)
        self.assertEqual(self.client.get("/policy/status").json()["country"], "IN")
        self._as(US_EMP)
        self.assertEqual(self.client.get("/policy/status").json()["country"], "US")
        self._as(NOBODY)
        self.assertEqual(self.client.get("/policy/status").json()["country"], "")


if __name__ == "__main__":
    unittest.main()
