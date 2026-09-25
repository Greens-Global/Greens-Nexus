"""Batched task emails (Neil, Sep 24) - task_notify.flush_batches.

"Wait to send the email until after one hour - if 5 tasks get assigned it can
batch it. Relevance is key." Pinned here: what waits and what never does, that
the hour starts at the FIRST event, that five assignments become one email,
that anything no longer true is dropped before sending (and nothing at all is
sent when nothing is left), that a batch of one is the ordinary email, and that
a second flush never re-sends.

Run with: python -m unittest test_task_batch_mail -v
"""
import os
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database  # noqa: E402
import models  # noqa: E402
import task_notify  # noqa: E402
from routers.task_util import gen_id, now_iso  # noqa: E402

NEIL = "neil@greensglobal.com"
SAGAR = "sagar@greensglobal.com"
OTHER = "other@greensglobal.com"
LATER = date.today() + timedelta(days=10)


class BatchCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        actual = database.engine.url.database or ""
        assert os.path.abspath(actual) == os.path.abspath(_tmp_db.name), actual
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except FileNotFoundError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskEmailLog, models.TaskEmailQueue, models.NexusSetting,
                  models.TaskActivity, models.TaskNotifyPref):
            self.db.query(m).delete()
        self.db.commit()
        self.sent = []
        self._real_send = task_notify._send_one
        task_notify._send_one = lambda db, **kw: self.sent.append(kw)

    def tearDown(self):
        task_notify._send_one = self._real_send
        self.db.close()

    def _task(self, title="Review pump quote", assignee=SAGAR, **kw):
        kw.setdefault("due_on", LATER.isoformat())
        t = models.Task(id=gen_id(), title=title, code="TASK-1", assignee_email=assignee,
                        assignee_emails=[assignee], follower_emails=[NEIL], created_by=NEIL,
                        priority=kw.pop("priority", "medium"), completed=False,
                        created_at=now_iso(), modified_at=now_iso(), **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def _event(self, t, event, actor=NEIL, **kw):
        task_notify.notify_task_event(t.id, event, actor, **kw)
        self.db.expire_all()

    def _pending(self):
        return self.db.query(models.TaskEmailQueue).filter_by(status="pending").all()

    def _flush(self, minutes_later=61):
        n = task_notify.flush_batches(self.db, now=datetime.now(timezone.utc) + timedelta(minutes=minutes_later))
        self.db.expire_all()
        return n


class WhatWaitsTests(BatchCase):
    def test_an_assignment_waits_instead_of_mailing(self):
        self._event(self._task(), "assigned")
        self.assertEqual(self.sent, [])
        self.assertEqual([(q.recipient, q.event_type) for q in self._pending()], [(SAGAR, "assigned")])

    def test_a_mention_never_waits(self):
        self._event(self._task(), "mentioned", mentioned=[SAGAR], comment_body="<p>@Sagar look</p>")
        self.assertEqual([s["event_type"] for s in self.sent], ["mentioned"])
        self.assertEqual(self._pending(), [])

    def test_urgent_and_due_soon_never_wait(self):
        self._event(self._task(priority="urgent"), "assigned")
        self._event(self._task(due_on=(date.today() + timedelta(days=1)).isoformat()), "assigned")
        self.assertEqual(len(self.sent), 2)
        self.assertEqual(self._pending(), [])

    def test_window_zero_is_the_old_instant_behavior(self):
        task_notify.save_settings(self.db, {"batchWindowMinutes": 0}, "test")
        self._event(self._task(), "assigned")
        self.assertEqual(len(self.sent), 1)


class FlushTests(BatchCase):
    def test_nothing_goes_out_before_the_hour(self):
        self._event(self._task(), "assigned")
        self.assertEqual(self._flush(minutes_later=30), 0)
        self.assertEqual(self.sent, [])

    def test_five_assignments_become_one_email(self):
        for i in range(5):
            self._event(self._task(title=f"Task {i}"), "assigned")
        self.assertEqual(self._flush(), 1)
        self.assertEqual(len(self.sent), 1)
        mail = self.sent[0]
        self.assertEqual(mail["event_type"], "batch")
        self.assertEqual(mail["recipient"], SAGAR)
        self.assertIn("assigned you 5 tasks", mail["subject"])
        for i in range(5):
            self.assertIn(f"Task {i}", mail["html"])

    def test_a_batch_of_one_is_the_ordinary_email(self):
        self._event(self._task(), "assigned")
        self._flush()
        self.assertEqual([s["event_type"] for s in self.sent], ["assigned"])

    def test_the_hour_starts_at_the_first_event(self):
        """A steady trickle must not push the email back forever."""
        self._event(self._task(), "assigned")
        first = self.db.query(models.TaskEmailQueue).one()
        first.created_at = (datetime.now(timezone.utc) - timedelta(minutes=70)).isoformat()
        self.db.commit()
        self._event(self._task(title="Just now"), "assigned")
        self.assertEqual(self._flush(minutes_later=0), 1)
        self.assertIn("Just now", self.sent[0]["html"])   # the newer one rides along

    def test_a_second_flush_never_resends(self):
        self._event(self._task(), "assigned")
        self._flush()
        self._flush()
        self.assertEqual(len(self.sent), 1)

    def test_changes_to_one_task_collapse_to_one_entry(self):
        t = self._task(title="Pump")
        self._event(t, "assigned")
        self._event(t, "modified", update_kind="Due date changed")
        self._event(t, "modified", update_kind="Priority changed")
        self._event(self._task(title="Other"), "assigned")
        self._flush()
        html = self.sent[0]["html"]
        self.assertEqual(html.count(">Pump</a>"), 1)
        self.assertIn("Changed: Due date changed, Priority changed", html)


class RelevanceTests(BatchCase):
    def test_reassigned_away_is_dropped(self):
        t = self._task()
        self._event(t, "assigned")
        t.assignee_email, t.assignee_emails = OTHER, [OTHER]
        self.db.commit()
        self.assertEqual(self._flush(), 0)
        self.assertEqual(self.sent, [])
        self.assertEqual(self.db.query(models.TaskEmailQueue).one().drop_reason, "no longer assigned")

    def test_completed_before_sending_is_dropped(self):
        t = self._task()
        self._event(t, "assigned")
        t.completed, t.status = True, "completed"
        self.db.commit()
        self._flush()
        self.assertEqual(self.sent, [])

    def test_deleted_task_is_dropped_and_the_rest_still_sends(self):
        gone, kept = self._task(title="Gone"), self._task(title="Kept")
        self._event(gone, "assigned")
        self._event(kept, "assigned")
        self.db.delete(self.db.get(models.Task, gone.id))
        self.db.commit()
        self._flush()
        self.assertEqual([s["event_type"] for s in self.sent], ["assigned"])   # single, ordinary email
        reasons = {q.drop_reason for q in self.db.query(models.TaskEmailQueue).all()}
        self.assertIn("task deleted", reasons)


class BulkTests(BatchCase):
    def test_a_bulk_assignment_is_one_email(self):
        tasks = [self._task(title=f"Bulk {i}") for i in range(4)]
        task_notify.queue_bulk_assignments(self.db, NEIL, {SAGAR: tasks})
        self.assertEqual(self.sent, [])
        self._flush()
        self.assertEqual(len(self.sent), 1)
        self.assertIn("assigned you 4 tasks", self.sent[0]["subject"])

    def test_an_urgent_task_in_a_bulk_assignment_sends_the_batch_now(self):
        tasks = [self._task(title="Normal"), self._task(title="Hot", priority="urgent")]
        task_notify.queue_bulk_assignments(self.db, NEIL, {SAGAR: tasks})
        self.assertEqual(self._flush(minutes_later=0), 1)

    def test_bulk_stays_silent_when_batching_is_off(self):
        task_notify.save_settings(self.db, {"batchWindowMinutes": 0}, "test")
        task_notify.queue_bulk_assignments(self.db, NEIL, {SAGAR: [self._task()]})
        self.assertEqual(self._pending(), [])


if __name__ == "__main__":
    unittest.main()
