"""
Live tickets (11/13/2026, ticket_events.py): a committed ticket change by any
path sends ONE ping into task_events marked `kind = "ticket"` - and nothing
else in the row - so open ticket lists refetch within a second. A task write
never sends that ping (the ticket fetch is the whole list), a rolled-back
write sends none, and the ping never goes out before the commit.

The ping function is mocked; a throwaway sqlite file; no network.
"""
import os
import tempfile
import unittest
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks

import database
import models
import ticket_events
from routers import task_util
from routers import tasks as TASKS
from routers import tickets as T
from routers.task_util import gen_id, now_iso

ADMIN = {"email": "admin@greensglobal.com", "level": 5}
REQ = "req@greensglobal.com"
AGENT = "agent@greensglobal.com"


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        patcher = mock.patch.object(task_util, "fire_task_event")
        self.ping = patcher.start()
        self.addCleanup(patcher.stop)
        # No ping "just sent": nothing here is ever held back by the burst
        # gap, so no late ping from one test can land in the next.
        ticket_events._last_sent = 0.0
        ticket_events._late_waiting = False
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.TaskComment, models.TaskActivity, models.Task):
            self.db.query(m).execution_options(include_deleted=True, include_confidential=True).delete()
        self.db.commit()
        self.fresh()

    def tearDown(self):
        self.db.close()

    def fresh(self):
        """Forget the pings so far and let the next change ping at once."""
        self.ping.reset_mock()
        ticket_events._last_sent = 0.0

    def ticket(self, **over):
        fields = dict(id=gen_id(), code=f"{gen_id()[:6]}", subject="Printer jam", status="open",
                      priority="medium", requester_email=REQ, assignee_email=AGENT,
                      created_at=now_iso(), modified_at=now_iso())
        fields.update(over)
        t = models.TaskTicket(**fields)
        self.db.add(t)
        self.db.commit()
        self.fresh()
        return t


class TicketWritesPing(Base):
    def test_a_new_ticket_pings_once_marked_ticket_and_names_nothing(self):
        self.db.add(models.TaskTicket(id=gen_id(), code="000001", subject="Laptop will not start",
                                      requester_email=REQ, created_at=now_iso(), modified_at=now_iso()))
        self.ping.assert_not_called()                     # nothing before the commit
        self.db.flush()
        self.ping.assert_not_called()                     # ...nor at the flush
        self.db.commit()
        self.ping.assert_called_once_with("", ticket_events.PING_KIND)
        self.assertEqual(ticket_events.PING_KIND, "ticket")

    def test_an_update_through_the_desk_route_pings(self):
        t = self.ticket()
        T.update_ticket(t.id, T.TicketUpdate(priority="high"), BackgroundTasks(), user=ADMIN, db=self.db)
        self.ping.assert_called_once_with("", "ticket")

    def test_a_reply_pings(self):
        t = self.ticket()
        T.add_ticket_comment(t.id, T.TicketCommentBody(body="<p>On it.</p>"), BackgroundTasks(),
                             user=ADMIN, db=self.db)
        self.ping.assert_called_once_with("", "ticket")

    def test_deleting_a_reply_pings_though_the_ticket_row_is_untouched(self):
        t = self.ticket()
        c = models.TaskComment(id=gen_id(), task_id=t.id, author_email=ADMIN["email"], body="x", created_at=now_iso())
        self.db.add(c)
        self.db.commit()
        self.fresh()
        T.delete_ticket_comment(c.id, user=ADMIN, db=self.db)
        self.ping.assert_called_once_with("", "ticket")

    def test_delete_and_restore_each_ping(self):
        t = self.ticket()
        T.delete_ticket(t.id, user=ADMIN, db=self.db)
        self.ping.assert_called_once_with("", "ticket")
        self.fresh()
        T.restore_ticket(t.id, user=ADMIN, db=self.db)
        self.ping.assert_called_once_with("", "ticket")

    def test_a_confidential_ticket_pings_the_same_bare_row(self):
        t = self.ticket(confidential_desk="hr")
        row = (self.db.query(models.TaskTicket).execution_options(include_confidential=True)
               .filter(models.TaskTicket.id == t.id).first())
        row.status = "in_progress"
        self.db.commit()
        self.ping.assert_called_once_with("", "ticket")   # no id, no person, no company

    def test_the_requester_opening_their_ticket_does_not_ping(self):
        t = self.ticket()
        T.mark_ticket_seen(t.id, user={"email": REQ, "level": 1}, db=self.db)
        self.assertTrue(self.db.get(models.TaskTicket, t.id).requester_seen_at)
        self.ping.assert_not_called()

    def test_a_save_that_changes_nothing_does_not_ping(self):
        t = self.ticket()
        t.priority = t.priority
        self.db.commit()
        self.ping.assert_not_called()


class ReadsDoNot(Base):
    """A ping makes every open list refetch - a read that pinged would have
    the screens refetching each other forever."""

    def test_reading_the_list_the_thread_and_the_activity_never_pings(self):
        t = self.ticket(first_response_at="", sla_due_on="", status="new")
        self.db.add(models.TaskComment(id=gen_id(), task_id=t.id, author_email=REQ, body="x", created_at=now_iso()))
        self.db.commit()
        self.fresh()
        self.assertEqual(len(T.list_tickets(mine=False, user=ADMIN, db=self.db)), 1)
        self.assertEqual(len(T.list_tickets(mine=True, user={"email": REQ, "level": 1}, db=self.db)), 1)
        T.list_ticket_comments(t.id, user=ADMIN, db=self.db)
        T.list_ticket_activity(t.id, user=ADMIN, db=self.db)
        T.list_ticket_attachments(t.id, user=ADMIN, db=self.db)
        self.db.commit()
        self.ping.assert_not_called()


class NotBeforeTheCommit(Base):
    def test_a_rolled_back_change_never_pings(self):
        t = self.ticket()
        t.priority = "urgent"
        self.db.flush()
        self.db.rollback()
        self.db.commit()
        self.ping.assert_not_called()

    def test_a_released_savepoint_waits_for_the_outer_commit(self):
        t = self.ticket()
        with self.db.begin_nested():
            t.priority = "urgent"
        self.ping.assert_not_called()
        self.db.commit()
        self.ping.assert_called_once_with("", "ticket")

    def test_one_ping_per_commit_however_many_tickets(self):
        a, b = self.ticket(), self.ticket()
        a.priority = "high"
        b.priority = "low"
        self.db.flush()
        self.db.add(models.TaskActivity(id=gen_id(), entity_kind="ticket", entity_id=a.id, type="updated", at=now_iso()))
        self.db.commit()
        self.ping.assert_called_once_with("", "ticket")


class Bursts(Base):
    def test_changes_inside_the_gap_fold_into_one_late_ping(self):
        t = self.ticket()
        timers = []

        class FakeTimer:
            def __init__(self, wait, fn):
                self.wait, self.fn, self.daemon = wait, fn, False

            def start(self):
                timers.append(self)

        with mock.patch.object(ticket_events.threading, "Timer", FakeTimer):
            for p in ("high", "low", "urgent"):
                t.priority = p
                self.db.commit()
            self.assertEqual(self.ping.call_count, 1)         # the first, at once
            self.assertEqual(len(timers), 1)                  # ONE late ping waiting for the other two
            self.assertTrue(0 < timers[0].wait <= ticket_events.MIN_GAP_S)
            timers[0].fn()                                    # the gap is up
            self.assertEqual(self.ping.call_args_list, [mock.call("", "ticket")] * 2)
            # The late ping counts as "just sent": the next change waits its turn again.
            t.priority = "medium"
            self.db.commit()
            self.assertEqual(self.ping.call_count, 2)
            self.assertEqual(len(timers), 2)


class TaskWritesDoNot(Base):
    def test_a_task_write_sends_its_own_ping_and_never_a_ticket_one(self):
        with mock.patch.object(TASKS, "fire_task_event") as task_ping:
            out = TASKS.create_task(TASKS.TaskCreate(title="Order toner"), BackgroundTasks(), user=ADMIN, db=self.db)
            TASKS.update_task(out["id"], TASKS.TaskUpdate(priority="high"), BackgroundTasks(), user=ADMIN, db=self.db)
        self.assertTrue(task_ping.called)
        for call in task_ping.call_args_list:
            self.assertFalse(str(call.args[1]).startswith("ticket"), call)
        self.ping.assert_not_called()                     # the ticket ping stayed silent

    def test_task_activity_alone_is_not_a_ticket_change(self):
        self.db.add(models.TaskActivity(id=gen_id(), entity_kind="task", entity_id="x", type="updated", at=now_iso()))
        self.db.add(models.TaskComment(id=gen_id(), task_id="x", author_email=AGENT, body="x", created_at=now_iso()))
        self.db.commit()
        self.ping.assert_not_called()


if __name__ == "__main__":
    unittest.main()
