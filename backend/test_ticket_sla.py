"""
SLA due date derived from priority, and the "needs a comment" staleness clock
(Sep 2026, Pranshu: "NEXUS should keep the SLA due date per the priority
level" - low=7d, medium=3d, high=2d, urgent=1d from creation, automatically).

Two things pinned here:
  - create_ticket / update_ticket compute sla_due_on server-side from
    created_at + the priority's target hours - never trusted from the client,
    and recomputed FROM CREATION (not "now") whenever priority changes, unless
    the same request also sets sla_due_on explicitly (manual override).
  - add_ticket_comment stamps last_comment_at, the signal the frontend's
    commentStale() uses independently of SLA breach.

Uses a throwaway sqlite file. No network.
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks

import database
import models
from routers import tickets as T

REQUESTER = {"email": "requester@greensglobal.com", "level": 1}


def _iso(dt):
    return dt.isoformat()


class SlaFromPriorityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.TaskComment, models.TaskActivity):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _create(self, priority):
        body = T.TicketBody(subject="s", priority=priority)
        return T.create_ticket(body, BackgroundTasks(), user=REQUESTER, db=self.db)

    def test_urgent_is_due_one_day_out(self):
        out = self._create("urgent")
        expected = (datetime.now(timezone.utc) + timedelta(hours=24)).date().isoformat()
        self.assertEqual(out["slaDueOn"], expected)

    def test_high_is_due_two_days_out(self):
        out = self._create("high")
        expected = (datetime.now(timezone.utc) + timedelta(hours=48)).date().isoformat()
        self.assertEqual(out["slaDueOn"], expected)

    def test_medium_is_due_three_days_out(self):
        out = self._create("medium")
        expected = (datetime.now(timezone.utc) + timedelta(hours=72)).date().isoformat()
        self.assertEqual(out["slaDueOn"], expected)

    def test_low_is_due_seven_days_out(self):
        out = self._create("low")
        expected = (datetime.now(timezone.utc) + timedelta(hours=168)).date().isoformat()
        self.assertEqual(out["slaDueOn"], expected)

    def test_a_client_sent_sla_due_on_is_ignored_at_creation(self):
        """The server is authoritative - see _sla_due_from_priority."""
        body = T.TicketBody(subject="s", priority="low", sla_due_on="2099-01-01")
        out = T.create_ticket(body, BackgroundTasks(), user=REQUESTER, db=self.db)
        self.assertNotEqual(out["slaDueOn"], "2099-01-01")

    def test_bumping_priority_recomputes_from_creation_not_now(self):
        """A ticket raised several days ago as low, bumped to urgent, is due
        one day from when it was CREATED - which may already be in the past
        (correctly reading as immediately breached), not one day from now."""
        created = datetime.now(timezone.utc) - timedelta(days=5)
        t = models.TaskTicket(id="t1", code="TIC-1", subject="s", status="open",
                              priority="low", requester_email=REQUESTER["email"],
                              created_at=_iso(created), modified_at=_iso(created),
                              sla_due_on=(created + timedelta(hours=168)).date().isoformat())
        self.db.add(t)
        self.db.commit()

        out = T.update_ticket("t1", T.TicketUpdate(priority="urgent"), BackgroundTasks(),
                              user=REQUESTER, db=self.db)

        expected = (created + timedelta(hours=24)).date().isoformat()
        self.assertEqual(out["slaDueOn"], expected)
        self.assertLess(out["slaDueOn"], datetime.now(timezone.utc).date().isoformat())

    def test_an_explicit_sla_due_on_in_the_same_patch_is_respected(self):
        """A manual override (the drawer's DateField) wins over the automatic
        recompute when both are sent together."""
        created = datetime.now(timezone.utc) - timedelta(days=1)
        t = models.TaskTicket(id="t2", code="TIC-2", subject="s", status="open",
                              priority="low", requester_email=REQUESTER["email"],
                              created_at=_iso(created), modified_at=_iso(created),
                              sla_due_on=(created + timedelta(hours=168)).date().isoformat())
        self.db.add(t)
        self.db.commit()

        out = T.update_ticket("t2", T.TicketUpdate(priority="urgent", sla_due_on="2099-01-01"),
                              BackgroundTasks(), user=REQUESTER, db=self.db)

        self.assertEqual(out["slaDueOn"], "2099-01-01")

    def test_updating_something_other_than_priority_leaves_sla_alone(self):
        created = datetime.now(timezone.utc) - timedelta(days=2)
        original_due = (created + timedelta(hours=168)).date().isoformat()
        t = models.TaskTicket(id="t3", code="TIC-3", subject="s", status="open",
                              priority="low", requester_email=REQUESTER["email"],
                              created_at=_iso(created), modified_at=_iso(created),
                              sla_due_on=original_due)
        self.db.add(t)
        self.db.commit()

        out = T.update_ticket("t3", T.TicketUpdate(subject="renamed"), BackgroundTasks(),
                              user=REQUESTER, db=self.db)

        self.assertEqual(out["slaDueOn"], original_due)


class CommentStalenessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.TaskComment, models.TaskActivity):
            self.db.query(m).delete()
        self.db.commit()
        self.t = models.TaskTicket(id="c1", code="TIC-C1", subject="s", status="open",
                                   priority="medium", requester_email=REQUESTER["email"],
                                   created_at="2026-01-01T00:00:00+00:00",
                                   modified_at="2026-01-01T00:00:00+00:00", last_comment_at="")
        self.db.add(self.t)
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_a_fresh_ticket_has_no_last_comment_at(self):
        out = T.ticket_to_dict(self.t)
        self.assertEqual(out["lastCommentAt"], None)

    def test_a_comment_stamps_last_comment_at(self):
        body = T.TicketCommentBody(body="hello")
        T.add_ticket_comment("c1", body, BackgroundTasks(), user=REQUESTER, db=self.db)

        self.db.refresh(self.t)
        self.assertTrue(self.t.last_comment_at)
        self.assertGreater(self.t.last_comment_at, "2026-01-01")

    def test_an_internal_note_stamps_it_too(self):
        admin = {"email": "admin@greensglobal.com", "level": 4}
        body = T.TicketCommentBody(body="internal note", internal=True)
        T.add_ticket_comment("c1", body, BackgroundTasks(), user=admin, db=self.db)

        self.db.refresh(self.t)
        comment = self.db.query(models.TaskComment).filter_by(task_id="c1").one()
        self.assertTrue(comment.internal)
        self.assertTrue(self.t.last_comment_at)


if __name__ == "__main__":
    unittest.main()
