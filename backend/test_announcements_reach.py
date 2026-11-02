"""Announcements reach (Neil, 11/02/2026): a picture or file on a post,
publish later, the notify choice and the acknowledged-by names.

- A scheduled post (publish_at in the future) is hidden from staff and shown
  to administrators flagged `scheduled`; when it comes due the publish pass
  writes its bells and fans out ONCE (a second pass sends nothing).
- Fan-out per notify mode: quiet = bells only; push_teams = bells + one
  Teams DM row per recipient (as the author - no live session = no rows and
  one bell to the author instead); email = bells + one mail per recipient.
  The author is never a recipient. The push is the BELL's (push.py's
  after_insert listener): exactly one outbox row per subscribed recipient in
  push_teams mode, never a second one from the publish pass.
- An image or file URL outside our storage is refused; a bad notify word is
  refused; a published post's publish time cannot be moved; an immediate
  post cannot be pulled into the future after its bells went out.
- Release safety: a post from before the reach columns (notified_at '' from
  the migration default, bells sent at create) is stamped by the migration
  and, even unstamped, never re-published by the pass.
- A publish that raises gives the claim back and the next pass retries;
  after five failures the row is stamped failed, hidden from staff, and an
  administrator may give it a new time.
- Administrators see the first acknowledgers' names on each post.

Throwaway sqlite, NEXUS_SKIP_AUTH identity, every sender mocked. No network.

Run alone: python -m pytest test_announcements_reach.py
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ["SUPABASE_URL"] = "https://example.supabase.co"

import atexit

from fastapi.testclient import TestClient

import announcements_publish
import auth
import cache
import database
import main
import models

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


ADMIN = "reach.admin@greensglobal.com"
OPS = "reach.ops@greensglobal.com"
FIN = "reach.fin@greensglobal.com"
PEOPLE = {ADMIN: ("Ada", "Admin", "Operations"),
          OPS: ("Oscar", "Ops", "Operations"),
          FIN: ("Fiona", "Fin", "Finance")}
STORAGE = "https://example.supabase.co/storage/v1/object/public/announcements/new/pic.png"


def _iso(delta_minutes: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(minutes=delta_minutes)).isoformat()


class AnnouncementsReachTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._cleanup()
        db = database.SessionLocal()
        try:
            for email, (first, last, dept) in PEOPLE.items():
                db.add(models.NexusEmployee(id=f"e-{email}", first_name=first, last_name=last,
                                            work_email=email, department=dept, status="active", deleted_at=""))
            db.add(models.NexusRole(email=ADMIN, role="administrator"))
            db.add(models.NexusRole(email=OPS, role="employee"))
            db.add(models.NexusRole(email=FIN, role="employee"))
            db.commit()
        finally:
            db.close()
        self._flush()

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)
        self._flush()

    def _flush(self):
        auth.invalidate_role_cache()
        cache.settings_config.invalidate()
        cache.people_directory.invalidate()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email.like("reach.%")).delete(synchronize_session=False))
            db.query(models.NexusRole).filter(models.NexusRole.email.like("reach.%")).delete(synchronize_session=False)
            db.query(models.Announcement).delete(synchronize_session=False)
            db.query(models.AnnouncementRead).delete(synchronize_session=False)
            db.query(models.NexusNotification).filter(models.NexusNotification.type == "announcement").delete(synchronize_session=False)
            db.query(models.TicketTeamsMessage).filter(models.TicketTeamsMessage.kind == "announcement").delete(synchronize_session=False)
            db.query(models.NexusPushOutbox).delete(synchronize_session=False)
            db.query(models.NexusPushSubscription).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache()

    def _post(self, as_email=ADMIN, **body):
        self._as(as_email)
        payload = {"title": "Parking lot repaved", "body": "Use the side entrance.\nThanks.", "audience": "company"}
        payload.update(body)
        return self.client.post("/announcements", json=payload)

    def _list(self, as_email):
        self._as(as_email)
        r = self.client.get("/announcements")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _bells(self, aid):
        db = database.SessionLocal()
        try:
            return sorted(n.recipient for n in db.query(models.NexusNotification)
                          .filter(models.NexusNotification.type == "announcement",
                                  models.NexusNotification.ref_id == aid).all())
        finally:
            db.close()

    def _teams_rows(self, aid):
        db = database.SessionLocal()
        try:
            return db.query(models.TicketTeamsMessage).filter(models.TicketTeamsMessage.ticket_id == aid).all()
        finally:
            db.close()

    # ── Scheduling ───────────────────────────────────────────────────────────

    def test_scheduled_post_hidden_from_staff_until_due_then_published_once(self):
        r = self._post(publish_at=_iso(+60))
        self.assertEqual(r.status_code, 201, r.text)
        a = r.json()
        self.assertTrue(a["scheduled"])
        self.assertEqual(a["notified_at"], "")
        self.assertEqual(self._bells(a["id"]), [])            # nothing goes out yet

        self.assertEqual([x["id"] for x in self._list(OPS)], [])
        admin_rows = self._list(ADMIN)
        self.assertEqual([x["id"] for x in admin_rows], [a["id"]])
        self.assertTrue(admin_rows[0]["scheduled"])

        # Staff cannot read or acknowledge a post they cannot see.
        self._as(OPS)
        self.assertEqual(self.client.post(f"/announcements/{a['id']}/read").status_code, 404)

        # Not due: the pass does nothing.
        self.assertEqual(announcements_publish.run_due(), 0)

        # Move it into the past (as the administrator) - due now.
        self._as(ADMIN)
        r = self.client.patch(f"/announcements/{a['id']}", json={"publish_at": _iso(-1)})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(announcements_publish.run_due(), 1)
        self.assertEqual(self._bells(a["id"]), sorted([OPS, FIN]))   # author skipped
        self.assertEqual(announcements_publish.run_due(), 0)         # never twice
        self.assertEqual(self._bells(a["id"]), sorted([OPS, FIN]))

        rows = self._list(OPS)
        self.assertEqual([x["id"] for x in rows], [a["id"]])
        self.assertFalse(rows[0]["scheduled"])
        self.assertTrue(rows[0]["notified_at"])

        # Published: the publish time is fixed.
        self._as(ADMIN)
        r = self.client.patch(f"/announcements/{a['id']}", json={"publish_at": _iso(+30)})
        self.assertEqual(r.status_code, 422, r.text)

    def test_immediate_post_bells_at_create_and_quiet_fanout_stamps_only(self):
        with mock.patch("graph_mail.send_mail") as send:
            r = self._post()
            self.assertEqual(r.status_code, 201, r.text)
            a = r.json()
            self.assertFalse(a["scheduled"])
            self.assertEqual(a["notify"], "quiet")
            self.assertEqual(self._bells(a["id"]), sorted([OPS, FIN]))   # bells are instant
            self.assertEqual(announcements_publish.run_due(), 1)
            self.assertEqual(self._bells(a["id"]), sorted([OPS, FIN]))   # no second bell
            self.assertEqual(self._teams_rows(a["id"]), [])
            send.assert_not_called()
            self.assertTrue(self._list(ADMIN)[0]["notified_at"])

    # ── Fan-out per mode ─────────────────────────────────────────────────────

    def _author_bells(self):
        db = database.SessionLocal()
        try:
            return [(n.title, n.body) for n in db.query(models.NexusNotification)
                    .filter(models.NexusNotification.recipient == ADMIN,
                            models.NexusNotification.type == "announcement").all()]
        finally:
            db.close()

    def _outbox(self):
        db = database.SessionLocal()
        try:
            return sorted((r.email, r.title, r.tag) for r in db.query(models.NexusPushOutbox).all())
        finally:
            db.close()

    def _subscribe(self, email):
        db = database.SessionLocal()
        try:
            db.add(models.NexusPushSubscription(id=f"ps_{email}", email=email, endpoint=f"https://fcm.googleapis.com/fcm/send/{email}",
                                                p256dh="p", auth="a", user_agent="", created_at=_iso(0), last_ok_at="",
                                                failures=0, disabled=False))
            db.commit()
        finally:
            db.close()

    VAPID = {"NEXUS_VAPID_PRIVATE_KEY": "test-private", "NEXUS_VAPID_PUBLIC_KEY": "BPublicKeyForTests",
             "NEXUS_VAPID_SUBJECT": "mailto:it@greensglobal.com"}

    def test_push_teams_mode_pushes_once_per_recipient_and_queues_one_teams_dm_each(self):
        """The bell is the push: a subscribed recipient gets exactly ONE
        outbox row for the post (from the bell's after_insert hook), the
        publish pass adds none; and one Teams DM row per recipient, as the
        author, who has a live session."""
        self._subscribe(OPS)
        with mock.patch.dict(os.environ, self.VAPID), \
             mock.patch("bff_session.graph_token_for_email", return_value="tok"), \
             mock.patch("graph_mail.send_mail") as send:
            r = self._post(notify="push_teams", audience="department", department="Operations")
            self.assertEqual(r.status_code, 201, r.text)
            a = r.json()
            self.assertEqual(self._bells(a["id"]), [OPS])
            self.assertEqual(announcements_publish.run_due(), 1)
            send.assert_not_called()
        self.assertEqual(self._outbox(), [(OPS, "Announcement: Parking lot repaved", f"announcement:{a['id']}")])
        rows = self._teams_rows(a["id"])
        self.assertEqual(sorted(x.requester_email for x in rows), [OPS])
        self.assertEqual({x.agent_email for x in rows}, {ADMIN})
        self.assertEqual({x.kind for x in rows}, {"announcement"})
        self.assertIn("Parking lot repaved", rows[0].html)
        self.assertEqual({x.sent for x in rows}, {0})                 # the Teams sweep delivers
        self.assertEqual(self._author_bells(), [])
        self.assertNotIn("queue_push", open(announcements_publish.__file__).read().split("def _fan_out")[1].split("def publish")[0])

    def test_quiet_mode_pushes_once_too_because_the_bell_pushes(self):
        self._subscribe(OPS)
        with mock.patch.dict(os.environ, self.VAPID):
            a = self._post(audience="department", department="Operations").json()
            self.assertEqual(announcements_publish.run_due(), 1)
        self.assertEqual(len(self._outbox()), 1)

    def test_push_teams_mode_with_no_author_session_tells_the_author_instead_of_dead_rows(self):
        with mock.patch("bff_session.graph_token_for_email", return_value=""):
            r = self._post(notify="push_teams")
            self.assertEqual(r.status_code, 201, r.text)
            self.assertEqual(announcements_publish.run_due(), 1)
        self.assertEqual(self._teams_rows(r.json()["id"]), [])
        self.assertEqual(self._author_bells(), [("Teams Messages Not Sent",
                                                 "Sign in to Nexus and republish 'Parking lot repaved' to send the Teams messages.")])
        self.assertTrue(self._list(ADMIN)[0]["notified_at"])

    # ── Release safety and failure ───────────────────────────────────────────

    def _old_post(self, days_ago=40, **kw):
        db = database.SessionLocal()
        try:
            made = (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()
            a = models.Announcement(id=f"old-{days_ago}", title="Holiday hours", body="Closed Friday.", audience="company",
                                    author_email=ADMIN, created_at=made, updated_at=made, deleted_at="",
                                    department="", pinned_until="", requires_ack=False,
                                    image_url="", file_url="", file_name="", publish_at="", notify="quiet", notified_at="", **kw)
            db.add(a)
            db.commit()
            return a.id, made
        finally:
            db.close()

    def test_a_post_from_before_the_release_is_never_published_again(self):
        """Its bells went out at create (and were purged since); notified_at is
        '' only because the column arrived with a default."""
        aid, made = self._old_post()
        self.assertEqual(self._bells(aid), [])
        self.assertEqual(announcements_publish.run_due(), 0)
        self.assertEqual(self._bells(aid), [])
        # The migration line (both lists in main.py) stamps it published.
        from sqlalchemy import text
        with database.engine.connect() as c:
            c.execute(text("UPDATE nexus_announcements SET notified_at = created_at WHERE notified_at = '' AND publish_at = ''"))
            c.commit()
        db = database.SessionLocal()
        try:
            self.assertEqual(db.get(models.Announcement, aid).notified_at, made)
        finally:
            db.close()
        self.assertEqual(announcements_publish.run_due(), 0)
        self.assertFalse(self._list(OPS)[0]["scheduled"])          # staff still see it, as before

    def test_a_publish_that_raises_gives_the_claim_back_then_gives_up_after_five(self):
        a = self._post(publish_at=_iso(-1), notify="email").json()
        self._as(OPS)
        with mock.patch("announcements_publish.publish", side_effect=RuntimeError("Graph down")):
            self.assertEqual(announcements_publish.run_due(), 0)
        self.assertEqual(self._list(ADMIN)[0]["notified_at"], "")     # claim released
        with mock.patch("graph_mail.send_mail"), mock.patch("graph_mail.DEFAULT_FROM_EMAIL", "nexus@greensglobal.com"):
            self.assertEqual(announcements_publish.run_due(), 1)       # the next pass publishes
        self.assertEqual(self._bells(a["id"]), sorted([OPS, FIN]))

        b = self._post(publish_at=_iso(-1)).json()
        with mock.patch("announcements_publish.publish", side_effect=RuntimeError("still down")):
            for _ in range(announcements_publish.MAX_ATTEMPTS):
                self.assertEqual(announcements_publish.run_due(), 0)
        row = next(x for x in self._list(ADMIN) if x["id"] == b["id"])
        self.assertTrue(row["notified_at"].startswith("failed:"))
        self.assertTrue(row["failed"])
        self.assertTrue(row["scheduled"])                              # not published: hidden from staff
        self.assertNotIn(b["id"], [x["id"] for x in self._list(OPS)])
        self.assertEqual(announcements_publish.run_due(), 0)           # left alone
        # The administrator gives it a new time: it is tried again.
        self._as(ADMIN)
        r = self.client.patch(f"/announcements/{b['id']}", json={"publish_at": _iso(-1)})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["notified_at"], "")
        self.assertEqual(announcements_publish.run_due(), 1)
        self.assertEqual(self._bells(b["id"]), sorted([OPS, FIN]))

    def test_an_immediate_post_cannot_be_pulled_into_the_future(self):
        a = self._post().json()                                        # bells went out at create
        self.assertEqual(self._bells(a["id"]), sorted([OPS, FIN]))
        r = self.client.patch(f"/announcements/{a['id']}", json={"publish_at": _iso(+30)})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(r.json()["detail"], "This post is already published")
        self.assertEqual([x["id"] for x in self._list(OPS)], [a["id"]])

    def test_a_scope_lookup_failure_publishes_to_nobody(self):
        with mock.patch("auth.company_scope", side_effect=RuntimeError("walls table away")):
            self.assertEqual(announcements_publish._scope_for(database.SessionLocal(), ADMIN), set())

    def test_due_is_compared_as_a_time_not_a_string(self):
        a = models.Announcement(publish_at="2026-01-01T00:00:00Z")
        self.assertTrue(announcements_publish.is_due(a, "2026-01-01T00:00:00.000001+00:00"))
        self.assertTrue(announcements_publish.is_due(a, "2026-01-01T05:30:00+05:30"))   # same instant
        self.assertFalse(announcements_publish.is_due(a, "2025-12-31T23:59:59+00:00"))
        self.assertTrue(announcements_publish.is_due(models.Announcement(publish_at=""), "2020-01-01T00:00:00+00:00"))

    def test_list_shows_and_sorts_by_the_publish_date(self):
        early = self._post(title="Written first, out last", publish_at=_iso(+120)).json()
        later = self._post(title="Written second").json()
        rows = self._list(ADMIN)
        self.assertEqual([x["id"] for x in rows], [early["id"], later["id"]])   # the scheduled one sorts by its publish time
        self.assertEqual(rows[0]["shown_at"], early["publish_at"])
        self.assertEqual(rows[1]["shown_at"], later["created_at"])

    def test_email_mode_sends_one_mail_per_recipient(self):
        with mock.patch("graph_mail.send_mail") as send, \
             mock.patch("graph_mail.DEFAULT_FROM_EMAIL", "nexus@greensglobal.com"):
            r = self._post(notify="email", file_url=STORAGE.replace("pic.png", "memo.pdf"), file_name="memo.pdf")
            self.assertEqual(r.status_code, 201, r.text)
            a = r.json()
            self.assertEqual(announcements_publish.run_due(), 1)
            self.assertEqual(send.call_count, 2)
            tos = sorted(c.kwargs["to"][0] for c in send.call_args_list)
            self.assertEqual(tos, sorted([OPS, FIN]))
            html = send.call_args_list[0].kwargs["html"]
            self.assertIn("Parking lot repaved", html)
            self.assertIn("memo.pdf", html)
            self.assertNotIn(STORAGE.replace("pic.png", "memo.pdf"), html)   # private bucket: link to Nexus, not the file
            self.assertEqual(send.call_args_list[0].kwargs["from_email"], "nexus@greensglobal.com")
            self.assertEqual(self._teams_rows(a["id"]), [])
            # A second pass sends nothing more.
            self.assertEqual(announcements_publish.run_due(), 0)
            self.assertEqual(send.call_count, 2)

    def test_email_mode_one_failed_recipient_does_not_stop_the_rest(self):
        import graph_mail

        def flaky(**kw):
            if kw["to"][0] == OPS:
                raise graph_mail.GraphMailError("mailbox away")
        with mock.patch("graph_mail.send_mail", side_effect=flaky) as send, \
             mock.patch("graph_mail.DEFAULT_FROM_EMAIL", "nexus@greensglobal.com"):
            r = self._post(notify="email")
            self.assertEqual(announcements_publish.run_due(), 1)
            self.assertEqual(send.call_count, 2)
        self.assertTrue(self._list(ADMIN)[0]["notified_at"])

    # ── Validation ───────────────────────────────────────────────────────────

    def test_image_and_file_must_live_in_our_storage(self):
        r = self._post(image_url="https://evil.example.com/x.png")
        self.assertEqual(r.status_code, 400, r.text)
        r = self._post(file_url="https://evil.example.com/x.pdf", file_name="x.pdf")
        self.assertEqual(r.status_code, 400, r.text)
        r = self._post(image_url=STORAGE)
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["image_url"], STORAGE)

    def test_bad_notify_and_bad_publish_time_refused(self):
        self.assertEqual(self._post(notify="carrier_pigeon").status_code, 422)
        self.assertEqual(self._post(publish_at="tomorrow-ish").status_code, 422)
        r = self._post(notify="EMAIL")
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["notify"], "email")

    # ── Acknowledged by ──────────────────────────────────────────────────────

    def test_admin_sees_first_acknowledger_names(self):
        a = self._post(requires_ack=True).json()
        self._as(OPS)
        self.assertEqual(self.client.post(f"/announcements/{a['id']}/ack").status_code, 200)
        self._as(FIN)
        self.assertEqual(self.client.post(f"/announcements/{a['id']}/ack").status_code, 200)
        row = self._list(ADMIN)[0]
        self.assertEqual(row["ack_count"], 2)
        self.assertEqual(sorted(row["ack_names"]), ["Fiona Fin", "Oscar Ops"])
        self.assertNotIn("ack_names", self._list(OPS)[0])


if __name__ == "__main__":
    unittest.main()
