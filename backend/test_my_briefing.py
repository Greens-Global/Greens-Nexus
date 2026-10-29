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
import json
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

# What Outlook on iOS / Android / Mac can render: Adaptive Card 1.0 only.
_V1_0_TYPES = {"AdaptiveCard", "TextBlock", "Image", "Container", "ColumnSet", "Column", "FactSet", "ImageSet",
               "Input.Text", "Input.Number", "Input.Date", "Input.Time", "Input.Toggle", "Input.ChoiceSet",
               "Action.OpenUrl", "Action.Submit", "Action.ShowCard", "Action.Http"}
_V1_2_ONLY_KEYS = {"selectAction", "isVisible", "style", "targetElements", "bleed", "minHeight",
                   "verticalContentAlignment"}


def _assert_card_v1_0(test, card):
    test.assertEqual(card["version"], "1.0")
    for node in _walk(card):
        if "type" in node:
            test.assertIn(node["type"], _V1_0_TYPES, node)
        test.assertFalse(_V1_2_ONLY_KEYS & set(node), node)


def _walk(node):
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from _walk(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk(v)


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
        # The time sheet reminder reads the real date (routers.timeclock); a
        # mid-period day keeps it out, as it would be on most days.
        with mock.patch("routers.timeclock._employee_today", lambda db, email: "2026-09-10"):
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
        self.assertEqual(daily_briefing.get_settings(self.db)["outlook_card"], "off")
        html = self._send()
        self.assertNotIn("adaptivecard", html)
        self.assertIn("/briefing", html)          # the email links to My Briefing

    def test_card_is_embedded_when_switched_on(self):
        for value in (True, "full"):      # True = the earlier on/off switch
            html = self._send(outlook_card=value)
            self.assertIn("application/adaptivecard+json", html)
            self.assertIn('"hideOriginalBody": true', html)
            self.db.query(models.Task).delete()
            self.db.commit()

    def test_quick_card_sits_on_top_of_the_designed_email(self):
        html = self._send(outlook_card="quick")
        card = json.loads(html.split("adaptivecard+json'>", 1)[1].split("</script>", 1)[0])
        self.assertFalse(card["hideOriginalBody"])
        self.assertIn("GREENS GLOBAL", html)                 # the designed email is still the body
        texts = [n.get("text") for n in _walk(card)]
        self.assertIn("1 decision waiting on you", texts)
        # Collapsed on arrival: the decision is a ShowCard button, and its
        # Approve / Reject only appear once it is opened.
        self.assertEqual([a["type"] for a in card["actions"]], ["Action.ShowCard"])
        self.assertEqual(card["actions"][0]["title"], "Budget")
        inner = [a["title"] for a in card["actions"][0]["card"]["actions"]]
        self.assertEqual(inner, ["Approve", "Reject"])
        urls = [n["url"] for n in _walk(card) if n.get("type") == "Action.Http"]
        self.assertTrue(urls and all("v=quick" in u for u in urls))
        _assert_card_v1_0(self, card)

    def test_quick_card_is_skipped_when_nothing_needs_a_decision(self):
        t = self._task(title="Plain task")
        self.db.add(models.TaskActivity(id=gen_id(), entity_kind="task", entity_id=t.id, entity_title=t.title,
                                        type="commented", detail="added a comment", actor_email="neil@greensglobal.com",
                                        at=now_iso()))
        self.db.commit()
        emp = self.db.query(models.NexusEmployee).first()
        sent = {}
        with mock.patch.object(tma, "am_enabled", return_value=True),              mock.patch.object(daily_briefing.graph_mail, "send_mail", side_effect=lambda **kw: sent.update(kw)):
            daily_briefing._send_one(self.db, emp, {"mode": "live", "outlook_card": "quick"}, "2026-09-26")
        self.assertNotIn("adaptivecard", sent.get("html", ""))

    def test_admin_can_switch_it(self):
        from auth import require_administrator
        self.client.app.dependency_overrides[require_administrator] = lambda: {"email": ME, "role": "administrator", "level": 4}
        for sent, saved in ((True, "full"), ("quick", "quick"), ("nonsense", "off"), (False, "off")):
            r = self.client.put("/daily-briefing/config", json={"outlook_card": sent})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["outlook_card"], saved)


class QuickCardShapeTests(unittest.TestCase):
    def _rows(self, n):
        return [{"title": f"Approve: Item {i}", "detail": "Waiting on your decision", "module": "tasks",
                 "action_kind": "task_approval", "action_id": f"t{i}", "action_email": ME} for i in range(n)]

    def _card(self, rows, **kw):
        import briefing_card
        return briefing_card.build_quick_card(action_rows=rows, briefing_date="2026-09-26",
                                              since_iso="2026-09-25T00:00:00",
                                              briefing_url="https://nexus/briefing", **kw)

    def test_nothing_to_decide_means_no_card(self):
        self.assertIsNone(self._card([{"title": "Hand over: Drill", "detail": "", "module": "items"}]))

    def test_each_time_off_request_gets_its_own_button(self):
        rows = [{"title": "Approve: Aarav Shah's time off (2 requests)", "detail": "2 pending", "module": "time_off",
                 "sub_actions": [{"detail": "10/02/2026 - 10/03/2026 (PTO)", "action_kind": "timeoff_approval",
                                  "action_id": "r1", "action_email": ME},
                                 {"detail": "10/20/2026 - 10/21/2026", "action_kind": "timeoff_approval",
                                  "action_id": "r2", "action_email": ME}]}]
        card = self._card(rows)
        self.assertEqual(len(card["actions"]), 2)
        self.assertTrue(card["actions"][0]["title"].startswith("Aarav Shah's time off - 10/02/2026"))
        _assert_card_v1_0(self, card)

    def test_long_lists_cap_and_link_to_my_briefing(self):
        card = self._card(self._rows(9))
        self.assertEqual(sum(a["type"] == "Action.ShowCard" for a in card["actions"]), 6)
        self.assertEqual(card["actions"][-1], {"type": "Action.OpenUrl", "title": "Open My Briefing",
                                               "url": "https://nexus/briefing"})
        self.assertIn("3 more in the briefing below.", [n.get("text") for n in _walk(card)])

    def test_ticket_reject_still_asks_for_a_reason(self):
        rows = [{"title": "Access request", "detail": "TCK-1", "module": "tickets", "action_kind": "ticket_approval",
                 "action_id": "k1", "action_email": ME}]
        inner = self._card(rows)["actions"][0]["card"]["actions"]
        self.assertEqual(inner[1]["type"], "Action.ShowCard")
        self.assertEqual(inner[1]["card"]["body"][0]["type"], "Input.Text")
        self.assertEqual(inner[1]["card"]["actions"][0]["title"], "Confirm Reject")


class QuickCardEndpointTests(_DBCase):
    def test_click_on_the_quick_card_redraws_the_quick_card(self):
        import briefing_mail_actions
        from routers import briefing_actions
        app = FastAPI()
        app.include_router(briefing_actions.router)
        client = TestClient(app)
        a = self._task(title="Budget", type="approval", approval_status="pending")
        b = self._task(title="Hiring plan", type="approval", approval_status="pending")
        tok = briefing_mail_actions.sign_token("task_approval", a.id, "approve", ME)
        r = client.post("/briefing-actions/card", params={"kind": "decision", "token": tok, "v": "quick",
                                                           "d": "2026-09-26", "s": "2026-09-25T00:00:00"})
        self.assertEqual(r.status_code, 200, r.text)
        card = r.json()
        self.assertFalse(card["hideOriginalBody"])
        texts = [n.get("text") for n in _walk(card)]
        self.assertIn("Budget approved. Done by you.", texts)
        self.assertIn("1 decision waiting on you", texts)
        self.assertEqual([a["title"] for a in card["actions"]], ["Hiring plan"])
        _assert_card_v1_0(self, card)
        self.assertEqual(self._reload(a.id).approval_status, "approved")
        self.assertEqual(self._reload(b.id).approval_status, "pending")


class RefreshOnOpenTests(_DBCase):
    """Both Daily Briefing cards refresh themselves when the email is opened
    (Neil, Oct 26)."""

    def test_quick_card_refreshes_to_what_is_still_pending(self):
        import briefing_mail_actions
        from routers import briefing_actions
        app = FastAPI()
        app.include_router(briefing_actions.router)
        client = TestClient(app)
        a = self._task(title="Budget", type="approval", approval_status="pending")
        self._task(title="Hiring plan", type="approval", approval_status="pending")
        sections = daily_briefing.build_sections(self.db, ME, "2026-09-25T00:00:00", "2026-09-26")
        card = daily_briefing.quick_card(sections, "2026-09-26", "2026-09-25T00:00:00", email=ME)
        _assert_card_v1_0(self, card)
        self.assertIn("kind=refresh", card["autoInvokeAction"]["url"])
        a.approval_status = "approved"
        self.db.commit()
        tok = briefing_mail_actions.refresh_token(ME)
        r = client.post("/briefing-actions/card", params={"kind": "refresh", "token": tok, "v": "quick",
                                                           "d": "2026-09-26", "s": "2026-09-25T00:00:00"})
        self.assertEqual(r.status_code, 200, r.text)
        fresh = r.json()
        self.assertEqual([x["title"] for x in fresh["actions"]], ["Hiring plan"])
        self.assertNotIn("CARD-ACTION-STATUS", r.headers)   # opening the email is not an action
        _assert_card_v1_0(self, fresh)

    def test_full_card_carries_the_refresh_too(self):
        sections = daily_briefing.build_sections(self.db, ME, "2026-09-25T00:00:00", "2026-09-26")
        card = daily_briefing.outlook_card(self.db, ME, "Sagar", sections, "2026-09-26", "2026-09-25T00:00:00",
                                           greeting="Good morning", logo_url="")
        self.assertIn("kind=refresh", card["autoInvokeAction"]["url"])


class BundledTimeOffPageTests(_DBCase):
    """One Approve / Reject for an employee's several time-off requests,
    opening a page that decides the ticked ones together (Neil, Oct 26)."""

    def setUp(self):
        super().setUp()
        import briefing_mail_actions
        from routers import briefing_actions
        self.bma = briefing_mail_actions
        self.db.query(models.TimeOffRequest).delete()
        # A manager (level 3) - the time-off decision's own gate.
        patcher = mock.patch("auth._role_for", return_value=("manager", 3))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.db.add(models.NexusEmployee(id=gen_id(), first_name="Charmi", last_name="Desai",
                                         work_email="charmi@greensglobal.com", manager_email=ME))
        self.reqs = []
        for d, kind in (("2026-11-09", "sick"), ("2026-11-02", "personal"), ("2026-11-16", "vacation")):
            r = models.TimeOffRequest(id=gen_id(), employee_email="charmi@greensglobal.com", type=kind,
                                      start_date=d, end_date=d, status="pending", created_at=now_iso())
            self.db.add(r)
            self.reqs.append(r)
        self.db.commit()
        app = FastAPI()
        app.include_router(briefing_actions.router)
        self.client = TestClient(app)

    def _token(self, action="approve", ids=None):
        ids = ids or [r.id for r in self.reqs]
        return self.bma.sign_token("timeoff_approval", ",".join(ids), action, ME)

    def _status(self, rid):
        self.db.expire_all()
        return self.db.query(models.TimeOffRequest).filter(models.TimeOffRequest.id == rid).one().status

    def test_email_row_has_a_pair_per_request_and_an_all_pair(self):
        row = {"title": "Approve: Charmi Desai's Time Off (3 requests)", "detail": "3 pending requests",
               "url": "https://x/timeclock", "module": "time_off",
               "sub_actions": [{"detail": f"{r.start_date}", "action_kind": "timeoff_approval",
                                "action_id": r.id, "action_email": ME} for r in self.reqs]}
        html = daily_briefing._item_row_html(row, False, ("#000", "#111", "#222"))
        self.assertEqual(html.count("briefing-actions/page"), 8)
        ids = [self.bma.verify_token(t.split("'")[0])["id"] for t in html.split("token=")[1:]]
        self.assertEqual(sorted(i for i in ids if "," not in i), sorted(r.id for r in self.reqs * 2))
        self.assertEqual([i.split(",") for i in ids if "," in i], [[r.id for r in self.reqs]] * 2)
        self.assertIn("Approve All", html)

    def test_page_lists_every_pending_request_ticked_in_date_order(self):
        self.reqs[2].status = "approved"
        self.db.commit()
        r = self.client.get("/briefing-actions/page", params={"token": self._token("reject")})
        self.assertEqual(r.status_code, 200)
        page = r.text
        self.assertIn("Charmi Desai", page)
        self.assertEqual(page.count("type='checkbox'"), 2)
        self.assertLess(page.index("11/02/2026"), page.index("11/09/2026"))
        # Decided since the email went out: listed with its decision, not pickable.
        self.assertIn("11/16/2026", page)
        self.assertIn("Already approved", page)
        # The button clicked in the email comes first.
        self.assertLess(page.index("Reject Selected"), page.index("Approve Selected"))

    def test_submit_decides_only_the_ticked_requests(self):
        a, b, c = self.reqs
        r = self.client.post("/briefing-actions/page",
                             data={"token": self._token(), "decision": "approve", "ids": [a.id, c.id]})
        self.assertEqual(r.status_code, 200)
        self.assertIn("2 requests approved", r.text)
        self.assertEqual([self._status(x.id) for x in (a, b, c)], ["approved", "pending", "approved"])

    def test_either_decision_from_one_link_and_foreign_ids_ignored(self):
        a, b, _ = self.reqs
        r = self.client.post("/briefing-actions/page",
                             data={"token": self._token("approve", [a.id, b.id]), "decision": "reject",
                                   "ids": [a.id, b.id, self.reqs[2].id]})
        self.assertIn("2 requests rejected", r.text)
        self.assertEqual(self._status(self.reqs[2].id), "pending")

    def test_one_already_decided_does_not_stop_the_rest(self):
        a, b, _ = self.reqs
        a.status = "rejected"
        self.db.commit()
        r = self.client.post("/briefing-actions/page",
                             data={"token": self._token(), "decision": "approve", "ids": [a.id, b.id]})
        self.assertIn("1 request approved", r.text)
        self.assertIn("Already rejected", r.text)
        self.assertEqual(self._status(b.id), "approved")

    def test_link_to_an_already_decided_request_offers_no_button(self):
        a = self.reqs[0]
        a.status, a.approver, a.decided_at = "approved", ME, "2026-10-26T14:00:00"
        self.db.commit()
        r = self.client.get("/briefing-actions/page", params={"token": self._token("reject", [a.id])})
        self.assertIn("Already approved by Sagar Kumar on 10/26/2026.", r.text)
        self.assertNotIn("<button", r.text)
        # Still pending: the usual confirm.
        r = self.client.get("/briefing-actions/page", params={"token": self._token("reject", [self.reqs[1].id])})
        self.assertIn("Reject this time off request?", r.text)

    def test_bundle_with_everything_decided_says_so(self):
        for x in self.reqs:
            x.status = "rejected"
        self.db.commit()
        r = self.client.get("/briefing-actions/page", params={"token": self._token()})
        self.assertIn("All 3 requests have already been decided.", r.text)
        self.assertNotIn("<button", r.text)

    def test_nothing_ticked_saves_nothing(self):
        r = self.client.post("/briefing-actions/page", data={"token": self._token(), "decision": "approve"})
        self.assertIn("Nothing Selected", r.text)
        self.assertTrue(all(self._status(x.id) == "pending" for x in self.reqs))


if __name__ == "__main__":
    unittest.main()
