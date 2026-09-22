"""
Task email actions + scheduled recurrence (Sept 2026).

  - task_mail_actions: signed tokens, the fallback buttons, the Outlook card.
  - routers/mail_actions: acting on a task from an email (card + fallback page),
    through the same update/comment code the app uses.
  - spawn_scheduled_occurrences: a calendar recurrence gets its next occurrence
    ON its date, once, whether or not the current one was completed.

Uses a throwaway sqlite file and NEXUS_SKIP_AUTH (the card endpoint then takes
the clicker from the signed token instead of Outlook's JWT). No network, no
mail is sent.

Run with: python -m unittest test_task_mail_actions -v
"""
import json
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ["NEXUS_DEV_EMAIL"] = "sagar@greensglobal.com"

from fastapi import BackgroundTasks, FastAPI, HTTPException   # noqa: E402
from fastapi.testclient import TestClient               # noqa: E402

import database                                          # noqa: E402
import models                                            # noqa: E402
import task_mail_actions as tma                          # noqa: E402
from routers import mail_actions                         # noqa: E402
from routers.task_util import gen_id, now_iso            # noqa: E402
from routers.tasks import (spawn_scheduled_occurrences, update_task,  # noqa: E402
                           TaskUpdate)

ME = "sagar@greensglobal.com"
USER = {"email": ME, "role": "manager", "level": 3}


class TokenTests(unittest.TestCase):
    def test_round_trip(self):
        tok = tma.sign_token("task-1", "Sagar@GreensGlobal.com")
        self.assertEqual(tma.verify_token(tok), {"task_id": "task-1", "recipient": ME})

    def test_tampered_and_expired_tokens_are_refused(self):
        tok = tma.sign_token("task-1", ME)
        p, s = tok.split(".")
        forged = tma._b64(json.dumps({"t": "task-2", "r": ME, "e": 9999999999}).encode())
        self.assertIsNone(tma.verify_token(f"{forged}.{s}"))
        self.assertIsNone(tma.verify_token("garbage"))
        old = tma.sign_token("task-1", ME, now=1_000_000)
        self.assertIsNone(tma.verify_token(old))


class DecorateTests(unittest.TestCase):
    CTX = {"id": "t1", "title": "Fix the gate", "status": "in_progress", "projectName": "Ops",
           "assigneeName": "Sagar", "priority": "high", "dueDateDisplay": "Sep 20, 2026",
           "taskUrl": "https://nexus/tasks/mine?task=t1"}
    OPTS = tma.BUILTIN_STATUSES
    HTML = "<div>before" + tma.ACTIONS_SLOT + "after</div>"

    def test_action_events_get_fallback_buttons(self):
        out = tma.decorate(self.HTML, event_type="overdue", t=self.CTX, recipient=ME, options=self.OPTS)
        for label in ("Add Comment", "Change Status", "Mark Complete"):
            self.assertIn(label, out)
        self.assertIn("/mail-actions/page?token=", out)
        self.assertNotIn(tma.ACTIONS_SLOT, out)

    def test_mention_offers_reply_not_add_comment(self):
        out = tma.decorate(self.HTML, event_type="mentioned", t=self.CTX, recipient=ME, options=self.OPTS)
        self.assertIn("Reply", out)
        self.assertNotIn("Add Comment", out)

    def test_completed_and_deleted_mails_get_no_actions(self):
        for ev in ("completed", "deleted"):
            out = tma.decorate(self.HTML, event_type=ev, t=self.CTX, recipient=ME, options=self.OPTS)
            self.assertEqual(out, "<div>beforeafter</div>")

    def test_card_only_with_a_registered_originator(self):
        out = tma.decorate(self.HTML, event_type="assigned", t=self.CTX, recipient=ME, options=self.OPTS)
        self.assertNotIn("adaptivecard", out)
        old = tma.AM_ORIGINATOR
        tma.AM_ORIGINATOR = "originator-guid"
        try:
            out = tma.decorate(self.HTML, event_type="assigned", t=self.CTX, recipient=ME, options=self.OPTS)
        finally:
            tma.AM_ORIGINATOR = old
        self.assertIn("application/adaptivecard+json", out)
        card = json.loads(out.split("adaptivecard+json'>", 1)[1].split("</script>", 1)[0])
        self.assertEqual(card["originator"], "originator-guid")
        titles = [a["title"] for a in card["actions"]]
        self.assertEqual(titles, ["Add Comment", "Change Status", "Mark Complete", "Open in Nexus"])
        status_card = card["actions"][1]["card"]
        self.assertEqual([c["value"] for c in status_card["body"][0]["choices"]],
                         ["not_started", "in_progress", "completed"])

    def test_mention_card_previews_the_comment_with_a_reply_box(self):
        card = tma.build_card(t=self.CTX, event_type="mentioned", token="tok", options=self.OPTS,
                              comment_body="<p>Can you check <b>this</b>?</p>", comment_author="Neil")
        texts = [b.get("text") for b in card["body"]]
        self.assertIn("Neil wrote:", texts)
        self.assertEqual(card["body"][3]["items"][0]["text"], "Can you check this?")
        self.assertEqual(card["body"][4]["id"], "reply")
        self.assertEqual(card["actions"][0]["title"], "Send Reply")
        self.assertEqual(card["actions"][0]["body"], "{{reply.value}}")

    def test_script_close_in_a_title_cannot_break_out_of_the_card(self):
        old = tma.AM_ORIGINATOR
        tma.AM_ORIGINATOR = "o"
        try:
            ctx = {**self.CTX, "title": "x</script><img src=x>"}
            out = tma.decorate(self.HTML, event_type="assigned", t=ctx, recipient=ME, options=self.OPTS)
        finally:
            tma.AM_ORIGINATOR = old
        self.assertEqual(out.count("</script>"), 1)


class _DBCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskActivity, models.TaskComment):
            self.db.query(m).delete()
        self.db.commit()

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


class EntraTokenClaimTests(unittest.TestCase):
    """Who a click is attributed to, from a verified Entra ID token's claims.

    Microsoft retired the legacy (EAT) token on June 8 2026; action requests
    now carry an Entra token, where the user is `preferred_username` and `sub`
    is an opaque pairwise id - reading `sub` as an address (the EAT rule) would
    attribute every click to nobody.
    """
    SENDERS = {"nexus@greensglobal.com"}
    BASE = {"azp": mail_actions.AM_APP_ID, "tid": __import__("auth").TENANT_ID,
            "preferred_username": "Sagar@GreensGlobal.com",
            "sub": "AUCeKGQXBnSqpWfTYEk0li8TyNul1QSuSxcPplBAwaQ"}

    def _who(self, **over):
        return mail_actions.performer_from_claims({**self.BASE, **over}, self.SENDERS)

    def test_the_user_comes_from_preferred_username_not_sub(self):
        self.assertEqual(self._who(), "sagar@greensglobal.com")

    def test_it_falls_back_through_the_other_address_claims(self):
        for claim in ("upn", "email", "unique_name"):
            with self.subTest(claim=claim):
                c = {k: v for k, v in self.BASE.items() if k != "preferred_username"}
                c[claim] = "neil@greensglobal.com"
                self.assertEqual(mail_actions.performer_from_claims(c, self.SENDERS),
                                 "neil@greensglobal.com")

    def test_a_token_naming_no_address_is_refused(self):
        c = {k: v for k, v in self.BASE.items() if k != "preferred_username"}
        with self.assertRaises(HTTPException) as e:
            mail_actions.performer_from_claims(c, self.SENDERS)
        self.assertEqual(e.exception.status_code, 401)

    def test_only_the_actions_app_may_call(self):
        with self.assertRaises(HTTPException):
            self._who(azp="some-other-app")
        # The EAT-era spelling still passes, for a token that carries it.
        c = {k: v for k, v in self.BASE.items() if k != "azp"}
        c["appid"] = mail_actions.AM_APP_ID
        self.assertEqual(mail_actions.performer_from_claims(c, self.SENDERS), "sagar@greensglobal.com")

    def test_another_tenant_is_refused(self):
        with self.assertRaises(HTTPException):
            self._who(tid="00000000-0000-0000-0000-000000000000")

    def test_a_sender_claim_must_be_one_of_our_mailboxes(self):
        self.assertEqual(self._who(sender="Nexus@greensglobal.com"), "sagar@greensglobal.com")
        with self.assertRaises(HTTPException):
            self._who(sender="attacker@example.com")

    def test_no_sender_claim_is_fine(self):
        """Entra tokens do not carry `sender`; the signed per-task token in the
        URL is what ties the call to an email we sent."""
        self.assertEqual(self._who(), "sagar@greensglobal.com")


class MailActionEndpointTests(_DBCase):
    def setUp(self):
        super().setUp()
        app = FastAPI()
        app.include_router(mail_actions.router)
        self.client = TestClient(app)

    def _reload(self, tid):
        self.db.expire_all()
        return self.db.query(models.Task).filter(models.Task.id == tid).first()

    def test_card_mark_complete_updates_the_task_and_returns_a_fresh_card(self):
        t = self._task()
        r = self.client.post(f"/mail-actions/card?token={tma.sign_token(t.id, ME)}&action=complete")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.headers["CARD-UPDATE-IN-BODY"], "true")
        self.assertEqual(r.json()["body"][0]["text"], "Marked complete by you.")
        self.assertTrue(self._reload(t.id).completed)

    def test_card_status_change_and_bad_status(self):
        t = self._task()
        tok = tma.sign_token(t.id, ME)
        r = self.client.post(f"/mail-actions/card?token={tok}&action=status", content="in_progress")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._reload(t.id).status, "in_progress")
        r = self.client.post(f"/mail-actions/card?token={tok}&action=status", content="nonsense")
        self.assertEqual(r.status_code, 422)
        self.assertIn("Pick a status", r.headers["CARD-ACTION-STATUS"])

    def test_card_comment_keeps_quotes_and_markup_as_text(self):
        t = self._task()
        r = self.client.post(f"/mail-actions/card?token={tma.sign_token(t.id, ME)}&action=comment",
                             content='Done - see "v2"\n<b>not bold</b>')
        self.assertEqual(r.status_code, 200, r.text)
        c = self.db.query(models.TaskComment).filter(models.TaskComment.task_id == t.id).one()
        self.assertEqual(c.body, "<p>Done - see &quot;v2&quot;</p><p>&lt;b&gt;not bold&lt;/b&gt;</p>")
        self.assertEqual(c.author_email, ME)

    def test_reply_mentions_whoever_mentioned_you(self):
        t = self._task()
        self.db.add(models.TaskComment(id=gen_id(), task_id=t.id, author_email="neil@greensglobal.com",
                                       body=f'<p><a href="mailto:{ME}">@Sagar</a> check this</p>',
                                       created_at=now_iso()))
        self.db.commit()
        r = self.client.post(f"/mail-actions/card?token={tma.sign_token(t.id, ME)}&action=reply", content="On it")
        self.assertEqual(r.status_code, 200, r.text)
        mine = (self.db.query(models.TaskComment)
                .filter(models.TaskComment.task_id == t.id, models.TaskComment.author_email == ME).one())
        self.assertIn('href="mailto:neil@greensglobal.com"', mine.body)
        self.assertIn("On it", mine.body)

    def test_expired_token_is_refused(self):
        t = self._task()
        r = self.client.post(f"/mail-actions/card?token={tma.sign_token(t.id, ME, now=1)}&action=complete")
        self.assertEqual(r.status_code, 400)
        self.assertFalse(self._reload(t.id).completed)

    def test_fallback_page_get_never_changes_anything(self):
        t = self._task()
        r = self.client.get(f"/mail-actions/page?token={tma.sign_token(t.id, ME)}&do=complete")
        self.assertEqual(r.status_code, 200)
        self.assertIn("Mark this task as complete?", r.text)
        self.assertFalse(self._reload(t.id).completed)

    def test_fallback_page_post_acts(self):
        t = self._task()
        tok = tma.sign_token(t.id, ME)
        r = self.client.post("/mail-actions/page", data={"token": tok, "action": "status", "text": "in_progress"})
        self.assertEqual(r.status_code, 200)
        self.assertIn("Status changed to In Progress", r.text)
        self.assertEqual(self._reload(t.id).status, "in_progress")


class ScheduledRecurrenceTests(_DBCase):
    WEEKLY_MON = {"freq": "weekly", "daysOfWeek": [1]}   # 2026-09-14 and 2026-09-21 are Mondays

    def _occurrences(self, title="Fix the gate"):
        return (self.db.query(models.Task).filter(models.Task.title == title)
                .order_by(models.Task.due_on).all())

    def test_next_occurrence_appears_on_its_date_even_if_this_one_is_open(self):
        self._task(due_on="2026-09-14", recurrence=dict(self.WEEKLY_MON))
        self.assertEqual(spawn_scheduled_occurrences(self.db, "2026-09-20"), [])   # not yet
        made = spawn_scheduled_occurrences(self.db, "2026-09-21")
        self.assertEqual([m.due_on for m in made], ["2026-09-21"])
        self.assertEqual([o.due_on for o in self._occurrences()], ["2026-09-14", "2026-09-21"])

    def test_running_twice_the_same_day_creates_nothing_more(self):
        self._task(due_on="2026-09-14", recurrence=dict(self.WEEKLY_MON))
        spawn_scheduled_occurrences(self.db, "2026-09-21")
        spawn_scheduled_occurrences(self.db, "2026-09-21")
        self.assertEqual(len(self._occurrences()), 2)

    def test_completing_after_the_schedule_rolled_does_not_duplicate(self):
        t = self._task(due_on="2026-09-14", recurrence=dict(self.WEEKLY_MON))
        spawn_scheduled_occurrences(self.db, "2026-09-21")
        update_task(t.id, TaskUpdate(completed=True), BackgroundTasks(), user=USER, db=self.db)
        self.assertEqual(len(self._occurrences()), 2)

    def test_editing_the_rule_keeps_the_roll_forward_marker(self):
        t = self._task(due_on="2026-09-14", recurrence=dict(self.WEEKLY_MON))
        spawn_scheduled_occurrences(self.db, "2026-09-21")
        # The editor sends the rule back without the server-only marker.
        update_task(t.id, TaskUpdate(recurrence=dict(self.WEEKLY_MON)), BackgroundTasks(), user=USER, db=self.db)
        spawn_scheduled_occurrences(self.db, "2026-09-21")
        self.assertEqual(len(self._occurrences()), 2)

    def test_a_stalled_series_jumps_to_its_latest_date_instead_of_backfilling(self):
        self._task(due_on="2026-08-03", recurrence=dict(self.WEEKLY_MON))
        made = spawn_scheduled_occurrences(self.db, "2026-09-23")
        self.assertEqual([m.due_on for m in made], ["2026-09-21"])

    def test_periodic_series_are_left_to_completion(self):
        self._task(due_on="2026-09-01", recurrence={"freq": "periodic", "daysAfterCompletion": 3})
        self.assertEqual(spawn_scheduled_occurrences(self.db, "2026-12-01"), [])

    def test_until_ends_the_schedule(self):
        self._task(due_on="2026-09-14", recurrence={**self.WEEKLY_MON, "until": "2026-09-20"})
        self.assertEqual(spawn_scheduled_occurrences(self.db, "2026-09-21"), [])

    def test_the_new_occurrence_starts_clean(self):
        self._task(due_on="2026-09-14", recurrence={**self.WEEKLY_MON, "count": 3})
        made = spawn_scheduled_occurrences(self.db, "2026-09-21")[0]
        self.assertEqual(made.recurrence, {**self.WEEKLY_MON, "count": 2})
        self.assertFalse(made.completed)


if __name__ == "__main__":
    unittest.main()
