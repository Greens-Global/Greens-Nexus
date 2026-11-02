"""Announcements reach (Neil, 11/02/2026): a picture or file on a post,
publish later, the notify choice and the acknowledged-by names.

- A scheduled post (publish_at in the future) is hidden from staff and shown
  to administrators flagged `scheduled`; when it comes due the publish pass
  writes its bells and fans out ONCE (a second pass sends nothing).
- Fan-out per notify mode: quiet = bells only; push_teams = bells + push
  queue + one Teams DM row per recipient; email = bells + one mail per
  recipient. The author is never a recipient.
- An image or file URL outside our storage is refused; a bad notify word is
  refused; a published post's publish time cannot be moved.
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

    def test_push_teams_mode_queues_push_and_one_teams_dm_per_recipient(self):
        queued = []
        fake_push = mock.MagicMock()
        fake_push.configured.return_value = True
        fake_push.queue_push.side_effect = lambda db, recipients, title, body, url, tag: queued.append((sorted(recipients), title, tag))
        with mock.patch.dict("sys.modules", {"push": fake_push}), mock.patch("graph_mail.send_mail") as send:
            r = self._post(notify="push_teams", audience="department", department="Operations")
            self.assertEqual(r.status_code, 201, r.text)
            a = r.json()
            self.assertEqual(announcements_publish.run_due(), 1)
            send.assert_not_called()
        self.assertEqual(queued, [([OPS], "Parking lot repaved", f"announcement:{a['id']}")])
        rows = self._teams_rows(a["id"])
        self.assertEqual(sorted(x.requester_email for x in rows), [OPS])
        self.assertEqual({x.agent_email for x in rows}, {ADMIN})
        self.assertEqual({x.kind for x in rows}, {"announcement"})
        self.assertIn("Parking lot repaved", rows[0].html)
        self.assertEqual({x.sent for x in rows}, {0})                 # the Teams sweep delivers

    def test_push_teams_mode_without_push_module_still_queues_teams(self):
        with mock.patch.dict("sys.modules", {"push": None}):
            r = self._post(notify="push_teams")
            self.assertEqual(r.status_code, 201, r.text)
            self.assertEqual(announcements_publish.run_due(), 1)
        self.assertEqual(sorted(x.requester_email for x in self._teams_rows(r.json()["id"])), sorted([OPS, FIN]))

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
