"""
My Briefing page API + the Outlook card switch (Sep 2026).

  - GET /daily-briefing/me returns the signed-in person's own briefing, with
    in-app paths and the ids the page acts on (no email tokens).
  - POST /daily-briefing/me/act runs decisions and task actions through the
    same code the email links use.
  - The Outlook card is only embedded when the admin switch is on.

Uses a throwaway sqlite file and NEXUS_SKIP_AUTH (the signed-in user is
NEXUS_DEV_EMAIL). No network, no mail is sent.

Run with: python -m unittest test_my_briefing -v
"""
import os
import tempfile
import unittest
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ["NEXUS_DEV_EMAIL"] = "sagar@greensglobal.com"

from fastapi import FastAPI                              # noqa: E402
from fastapi.testclient import TestClient               # noqa: E402

import daily_briefing                                    # noqa: E402
import database                                          # noqa: E402
import models                                            # noqa: E402
import task_mail_actions as tma                          # noqa: E402
from routers import daily_briefing as briefing_router    # noqa: E402
from routers.task_util import gen_id, now_iso            # noqa: E402

ME = "sagar@greensglobal.com"


class _DBCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskActivity, models.TaskComment, models.NexusDailyBriefingLog,
                  models.NexusSetting, models.NexusEmployee):
            self.db.query(m).delete()
        self.db.add(models.NexusEmployee(id=gen_id(), first_name="Sagar", last_name="Kumar", work_email=ME))
        self.db.commit()
        app = FastAPI()
        app.include_router(briefing_router.router)
        self.client = TestClient(app)

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _task(self, **kw):
        now = now_iso()
        t = models.Task(id=gen_id(), title=kw.pop("title", "Fix the gate"), status=kw.pop("status", "not_started"),
                        assignee_email=ME, assignee_emails=[ME], owner_email=ME,
                        created_at=now, modified_at=now, created_by=ME, **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def _reload(self, tid):
        self.db.expire_all()
        return self.db.query(models.Task).filter(models.Task.id == tid).first()


class MyBriefingApiTests(_DBCase):
    def test_me_returns_my_own_briefing_with_ids_not_tokens(self):
        t = self._task(title="Budget", type="approval", approval_status="pending")
        r = self.client.get("/daily-briefing/me")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["firstName"], "Sagar")
        self.assertIn(body["greeting"], ("Good morning", "Good afternoon", "Good evening"))
        action = next(s for s in body["sections"] if s["key"] == "action_required")
        row = next(x for x in action["rows"] if x.get("taskId") == t.id)
        self.assertEqual(row["decision"], {"kind": "task_approval", "id": t.id})
        self.assertTrue(row["path"].startswith("/tasks/mine"), row["path"])
        self.assertNotIn("token", r.text)
        self.assertNotIn("action_email", r.text)

    def test_nothing_new_is_an_empty_list(self):
        r = self.client.get("/daily-briefing/me")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["sections"], [])

    def test_approve_and_reject_from_the_page(self):
        a = self._task(title="Budget", type="approval", approval_status="pending")
        r = self.client.post("/daily-briefing/me/act", json={
            "kind": "decision", "decision_kind": "task_approval", "id": a.id, "action": "approve"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["message"], "Budget approved.")
        self.assertEqual(self._reload(a.id).approval_status, "approved")
        r = self.client.post("/daily-briefing/me/act", json={
            "kind": "decision", "decision_kind": "task_approval", "id": a.id, "action": "reject"})
        self.assertEqual(r.status_code, 409)
        self.assertIn("Already approved", r.json()["detail"])

    def test_task_actions_from_the_page(self):
        t = self._task()
        post = lambda action, text="": self.client.post(  # noqa: E731
            "/daily-briefing/me/act", json={"kind": "task", "id": t.id, "action": action, "text": text})
        self.assertEqual(post("status", "in_progress").status_code, 200)
        self.assertEqual(self._reload(t.id).status, "in_progress")
        self.assertEqual(post("comment", "Looks good").status_code, 200)
        self.assertEqual(self.db.query(models.TaskComment).filter(models.TaskComment.task_id == t.id).count(), 1)
        self.assertEqual(post("react", tma.REACTION_EMOJIS[0]).status_code, 200)
        self.assertEqual(post("complete").status_code, 200)
        self.assertTrue(self._reload(t.id).completed)

    def test_unknown_actions_are_refused(self):
        t = self._task()
        for body in ({"kind": "task", "id": t.id, "action": "delete"},
                     {"kind": "decision", "decision_kind": "task_approval", "id": t.id, "action": "maybe"},
                     {"kind": "other", "id": t.id, "action": "approve"}):
            self.assertEqual(self.client.post("/daily-briefing/me/act", json=body).status_code, 400)


class OutlookCardSwitchTests(_DBCase):
    def _send(self, **cfg):
        self._task(title="Budget", type="approval", approval_status="pending")
        emp = self.db.query(models.NexusEmployee).first()
        sent = {}
        with mock.patch.object(tma, "am_enabled", return_value=True), \
             mock.patch.object(daily_briefing.graph_mail, "send_mail",
                               side_effect=lambda **kw: sent.update(kw)):
            daily_briefing._send_one(self.db, emp, {"mode": "live", **cfg}, "2026-09-26")
        return sent["html"]

    def test_card_is_off_by_default(self):
        self.assertFalse(daily_briefing.get_settings(self.db)["outlook_card"])
        html = self._send()
        self.assertNotIn("adaptivecard", html)
        self.assertIn("/briefing", html)          # the email links to My Briefing

    def test_card_is_embedded_when_switched_on(self):
        html = self._send(outlook_card=True)
        self.assertIn("application/adaptivecard+json", html)

    def test_admin_can_switch_it(self):
        from auth import require_administrator
        self.client.app.dependency_overrides[require_administrator] = lambda: {"email": ME, "role": "administrator", "level": 4}
        r = self.client.put("/daily-briefing/config", json={"outlook_card": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["outlook_card"])


if __name__ == "__main__":
    unittest.main()
