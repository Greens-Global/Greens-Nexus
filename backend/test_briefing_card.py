"""
Outlook card version of the Daily Briefing (Sep 2026, briefing_card.py).

  - The card is well-formed: every show/hide button points at an element that
    exists, ids are unique, sections start collapsed, the card replaces the
    HTML body in Outlook, and every button posts to /briefing-actions/card.
  - /briefing-actions/card runs the click through the same code as the app
    and answers with the whole briefing redrawn.

Uses a throwaway sqlite file and NEXUS_SKIP_AUTH (the endpoint then takes the
clicker from the signed token instead of Outlook's JWT). No network, no mail.

Run with: python -m unittest test_briefing_card -v
"""
import json
import os
import tempfile
import unittest
from urllib.parse import parse_qs, urlparse

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ["NEXUS_DEV_EMAIL"] = "sagar@greensglobal.com"

from fastapi import FastAPI                              # noqa: E402
from fastapi.testclient import TestClient               # noqa: E402

import briefing_card                                     # noqa: E402
import briefing_mail_actions                             # noqa: E402
import daily_briefing                                    # noqa: E402
import database                                          # noqa: E402
import models                                            # noqa: E402
import task_mail_actions as tma                          # noqa: E402
from routers import briefing_actions                     # noqa: E402
from routers.task_util import gen_id, now_iso            # noqa: E402

ME = "sagar@greensglobal.com"
SINCE = "2026-09-24T00:00:00"
DATE = "2026-09-25"


def _walk(node):
    """Every dict in the card, depth first (actions and ShowCard bodies too)."""
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from _walk(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk(v)


def _sample_sections():
    task = {"title": "Fix the gate", "detail": "Changed status", "url": "https://nexus/t", "module": "tasks",
            "task_id": "t1", "action_email": ME, "task_open": True, "project_id": "", "task_status": "in_progress",
            "comments": [{"author": "Neil Kadakia", "body": "Any update?"}]}
    return {
        "action_required": [
            {"title": "Approve: Budget", "detail": "Waiting on your decision", "url": "https://nexus/t",
             "module": "tasks", "task_id": "t2", "action_kind": "task_approval", "action_id": "t2", "action_email": ME},
            {"ref": "TCK-1", "title": "Access request", "detail": "Waiting", "url": "https://nexus/k",
             "module": "tickets", "action_kind": "ticket_approval", "action_id": "k1", "action_email": ME},
            {"title": "Approve: Aarav's time off (2 requests)", "detail": "2 pending", "url": "https://nexus/tc",
             "module": "time_off", "sub_actions": [
                 {"detail": "10/02/2026 - 10/03/2026", "action_kind": "timeoff_approval", "action_id": "r1", "action_email": ME},
                 {"detail": "10/20/2026 - 10/21/2026", "action_kind": "timeoff_approval", "action_id": "r2", "action_email": ME}]},
        ],
        # 12 rows: 3 shown, 7 behind "Show 7 More", then a link to Nexus.
        "needs_to_know": [dict(task, task_id=f"t{i}", title=f"Task {i}") for i in range(12)],
        "completed": [{"title": "Done thing", "detail": "Completed", "url": "https://nexus/t", "module": "tasks"}],
    }


def _build(sections=None, outcome=""):
    return briefing_card.build_card(
        sections=sections or _sample_sections(), first_name="Sagar", greeting="Good afternoon",
        weekday_date="Friday, 09/25/2026", briefing_date=DATE, since_iso=SINCE, logo_url="",
        app_url="https://nexus", view_urls={"tasks": "https://nexus/tasks/mine"},
        status_options=lambda _pid: tma.BUILTIN_STATUSES, outcome=outcome)


class CardShapeTests(unittest.TestCase):
    def setUp(self):
        self.card = _build()
        self.nodes = list(_walk(self.card))

    def test_card_replaces_the_html_body_in_outlook(self):
        self.assertEqual(self.card["type"], "AdaptiveCard")
        self.assertTrue(self.card["hideOriginalBody"])
        self.assertEqual(self.card["version"], "1.2")

    def test_ids_are_unique_and_every_toggle_target_exists(self):
        ids = [n["id"] for n in self.nodes if "id" in n and n.get("type") != "Input.Text"
               and not n.get("type", "").startswith("Input.")]
        self.assertEqual(len(ids), len(set(ids)))
        all_ids = {n["id"] for n in self.nodes if "id" in n}
        toggles = [n for n in self.nodes if n.get("type") == "Action.ToggleVisibility"]
        self.assertTrue(toggles)
        for t in toggles:
            for target in t["targetElements"]:
                self.assertIn(target, all_ids)

    def test_sections_start_collapsed_with_a_clickable_header(self):
        headers = [n for n in self.nodes if n.get("selectAction", {}).get("type") == "Action.ToggleVisibility"]
        self.assertEqual(len(headers), 3)
        by_id = {n["id"]: n for n in self.nodes if "id" in n}
        for h in headers:
            body_id, show_id, hide_id = h["selectAction"]["targetElements"]
            self.assertFalse(by_id[body_id]["isVisible"])
            self.assertNotIn("isVisible", by_id[show_id])       # "Show" visible while closed
            self.assertFalse(by_id[hide_id]["isVisible"])

    def test_long_module_shows_three_then_more_then_a_link(self):
        titles = [n.get("title") for n in self.nodes if n.get("type") in ("Action.ToggleVisibility", "Action.OpenUrl")]
        self.assertIn("Show 7 More", titles)
        self.assertIn("View All 12 in Nexus", titles)

    def test_every_post_goes_to_the_briefing_card_endpoint_with_its_window(self):
        posts = [n for n in self.nodes if n.get("type") == "Action.Http"]
        self.assertTrue(posts)
        for p in posts:
            u = urlparse(p["url"])
            self.assertTrue(u.path.endswith("/briefing-actions/card"), p["url"])
            q = parse_qs(u.query)
            self.assertIn(q["kind"][0], ("decision", "task"))
            self.assertEqual(q["d"][0], DATE)
            self.assertEqual(q["s"][0], SINCE)
            if q["kind"][0] == "task":
                self.assertIn(q["action"][0], ("comment", "react", "status", "complete"))

    def test_decisions_and_task_actions_are_all_offered(self):
        titles = {n.get("title") for n in self.nodes}
        for label in ("Approve", "Reject", "Confirm Reject", "Comment", "React", "Change Status",
                      "Mark Complete", "Open in Nexus", "Open Nexus"):
            self.assertIn(label, titles)
        # One Approve per decision: task approval, ticket approval, two time-off requests.
        self.assertEqual(sum(1 for n in self.nodes if n.get("title") == "Approve"), 4)

    def test_no_em_dashes(self):
        self.assertNotIn("—", json.dumps(self.card, ensure_ascii=False))

    def test_script_close_cannot_break_out_of_the_embedded_card(self):
        sections = {"completed": [{"title": "</script><b>x", "detail": "", "url": "", "module": "tasks"}]}
        html = daily_briefing.with_card("<p>body</p>", _build(sections))
        self.assertEqual(html.count("</script>"), 1)
        card = json.loads(html.split("adaptivecard+json'>", 1)[1].split("</script>", 1)[0])
        self.assertIn("</script><b>x", json.dumps(card))


class CardEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskActivity, models.TaskComment):
            self.db.query(m).delete()
        self.db.commit()
        app = FastAPI()
        app.include_router(briefing_actions.router)
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

    def _post(self, **params):
        params.setdefault("d", DATE)
        params.setdefault("s", SINCE)
        body = params.pop("body", "")
        return self.client.post("/briefing-actions/card", params=params, content=body)

    def test_approve_from_the_card_decides_and_redraws_the_whole_briefing(self):
        t = self._task(title="Budget", type="approval", approval_status="pending")
        tok = briefing_mail_actions.sign_token("task_approval", t.id, "approve", ME)
        r = self._post(kind="decision", token=tok)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.headers["CARD-UPDATE-IN-BODY"], "true")
        self.assertEqual(self._reload(t.id).approval_status, "approved")
        card = r.json()
        self.assertTrue(card["hideOriginalBody"])
        texts = [n.get("text") for n in _walk(card)]
        self.assertIn("Budget approved. Done by you.", texts)
        self.assertIn("Daily Briefing", texts)

    def test_second_click_on_a_decided_item_says_so(self):
        t = self._task(title="Budget", type="approval", approval_status="approved")
        tok = briefing_mail_actions.sign_token("task_approval", t.id, "approve", ME)
        r = self._post(kind="decision", token=tok)
        self.assertEqual(r.status_code, 409)
        self.assertIn("Already approved", r.headers["CARD-ACTION-STATUS"])

    def test_task_actions_run_through_the_task_code(self):
        t = self._task()
        tok = tma.sign_token(t.id, ME)
        r = self._post(kind="task", token=tok, action="status", body="in_progress")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._reload(t.id).status, "in_progress")
        r = self._post(kind="task", token=tok, action="complete")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(self._reload(t.id).completed)
        r = self._post(kind="task", token=tok, action="comment", body='He said "ship it" <b>now</b>')
        self.assertEqual(r.status_code, 200, r.text)
        c = self.db.query(models.TaskComment).filter(models.TaskComment.task_id == t.id).first()
        self.assertIn("&quot;ship it&quot;", c.body)

    def test_bad_or_mixed_up_tokens_are_refused(self):
        task_tok = tma.sign_token("t1", ME)
        for params in ({"kind": "decision", "token": task_tok}, {"kind": "task", "token": "garbage"},
                       {"kind": "other", "token": task_tok}):
            r = self._post(**params)
            self.assertEqual(r.status_code, 400)
            self.assertIn("expired", r.headers["CARD-ACTION-STATUS"])

    def test_missing_window_does_not_pull_every_row_ever(self):
        old = self._task(title="Ancient", type="approval", approval_status="pending")
        tok = briefing_mail_actions.sign_token("task_approval", old.id, "reject", ME)
        r = self._post(kind="decision", token=tok, d="", s="")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._reload(old.id).approval_status, "rejected")


if __name__ == "__main__":
    unittest.main()
