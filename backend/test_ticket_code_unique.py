"""Ticket numbers and task codes can never repeat (Oct 2026, code_sequence.py).

Before: tickets took "highest code on a row + 1" with no lock, so two tickets
filed at once got the same number, and deleting the newest ticket handed its
number straight back out. Tasks took count() + 1, so deleting - or trashing,
which hides the row from the count - any task reused a live code (Sep 30
review #5). Both now come from a counter row bumped atomically in the
caller's transaction.

Pinned here: sequential creates count up in today's format, a number is never
issued twice after a delete or trash, concurrent allocation (real threads on a
file-backed SQLite) gives every caller its own number, the counter seeds from
what was already issued, and the duplicate checker reports and renumbers.

Throwaway SQLite file. No network. ONE FILE PER PROCESS:
    python -m pytest test_ticket_code_unique.py
"""
import os
import tempfile
import threading
import time
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks  # noqa: E402

import check_code_duplicates  # noqa: E402
import code_sequence  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
import task_notify  # noqa: E402
from routers import tickets as T  # noqa: E402
from routers.task_util import gen_id, now_iso  # noqa: E402
from routers.tasks import TaskCreate, _next_code, create_task  # noqa: E402


def _assert_isolated():
    """These tests delete rows - prove they are on their own database first
    (see test_task_start_date.py for why)."""
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} is pointed at {actual!r}, not its own temp database. "
                           f"Run it on its own: python -m pytest {__name__}.py")


_assert_isolated()
models.Base.metadata.create_all(bind=database.engine)

USER = {"email": "requester@greensglobal.com", "level": 1}
THREADS = 8


def tearDownModule():
    database.engine.dispose()
    try:
        os.remove(_tmp_db.name)
    except OSError:
        pass


class _Case(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.Task, models.TaskActivity, models.TaskComment,
                  models.TaskNotification, models.TicketEmailLog, models.TaskEmailLog,
                  models.NexusCounter):
            self.db.query(m).delete()
        self.db.commit()
        self._notify = task_notify.notify_task_event
        task_notify.notify_task_event = lambda *a, **kw: None

    def tearDown(self):
        task_notify.notify_task_event = self._notify
        self.db.close()

    # ── helpers ──────────────────────────────────────────────────────────
    def _ticket(self, **kw):
        body = T.TicketBody(subject=kw.pop("subject", "VPN access"), **kw)
        return T.create_ticket(body, BackgroundTasks(), user=USER, db=self.db)["code"]

    def _add_ticket(self, code, db=None):
        db = db or self.db
        db.add(models.TaskTicket(id=gen_id(), code=code, subject="S", type="request",
                                 status="open", created_at=now_iso(), modified_at=now_iso()))
        db.commit()

    def _task(self, **kw):
        kw.setdefault("title", "Reconcile QuickBooks")
        return create_task(TaskCreate(**kw), BackgroundTasks(), user=USER, db=self.db)["code"]

    def _add_task(self, code, db=None, **kw):
        db = db or self.db
        db.add(models.Task(id=gen_id(), code=code, title="T", status="not_started",
                           activity_ids=[], created_at=now_iso(), modified_at=now_iso(), **kw))
        db.commit()

    def _concurrently(self, allocate, add):
        """THREADS callers, each in its own session, released together. Each
        allocates, holds its transaction open a moment (the window the old
        read-the-highest scheme raced in), then writes its row and commits."""
        barrier = threading.Barrier(THREADS)
        codes, errors = [], []
        lock = threading.Lock()

        def worker():
            db = database.SessionLocal()
            try:
                barrier.wait()
                code = allocate(db)
                time.sleep(0.02)
                add(code, db)
                with lock:
                    codes.append(code)
            except Exception as e:      # noqa: BLE001 - reported below
                with lock:
                    errors.append(repr(e))
            finally:
                db.close()

        threads = [threading.Thread(target=worker) for _ in range(THREADS)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(60)
        self.assertEqual(errors, [])
        return codes


class TicketCodeTests(_Case):
    def test_sequential_creates_count_up_in_todays_format(self):
        self.assertEqual([self._ticket() for _ in range(3)], ["000001", "000002", "000003"])

    def test_deleting_the_newest_ticket_does_not_hand_its_number_back(self):
        """The old "highest + 1" reissued 000003 here - the number someone may
        already have quoted in an email."""
        for _ in range(3):
            self._ticket()
        self.db.query(models.TaskTicket).filter(models.TaskTicket.code == "000003").delete()
        self.db.commit()
        self.assertEqual(self._ticket(), "000004")

    def test_a_client_supplied_code_is_ignored(self):
        self._ticket()
        self.assertEqual(self._ticket(code="000001"), "000002")

    def test_the_counter_seeds_past_everything_already_issued(self):
        """Live rows (legacy TKT- codes too) and the email log, which outlives a
        hard-deleted ticket."""
        self._add_ticket("TKT-004")
        self._add_ticket("000006")
        self.db.add(models.TicketEmailLog(id=gen_id(), ticket_id="gone", ticket_code="000009",
                                          idempotency_key="gone:created:0:x"))
        self.db.commit()
        self.assertEqual(self._ticket(), "000010")

    def test_a_number_already_on_a_row_is_skipped(self):
        """A counter that is somehow behind never issues a code in use."""
        self._ticket()                      # counter row now at 1
        self._add_ticket("000002")          # written around the counter
        self._add_ticket("TKT-003")         # legacy form of the same number 3
        self.assertEqual(self._ticket(), "000004")

    def test_concurrent_allocation_gives_every_caller_its_own_number(self):
        self._ticket()                      # seed the counter at 1
        codes = self._concurrently(T._next_ticket_code, self._add_ticket)
        self.assertEqual(len(codes), THREADS)
        self.assertEqual(len(set(codes)), THREADS, f"duplicate ticket codes: {sorted(codes)}")
        self.assertEqual(sorted(codes), [f"{n:06d}" for n in range(2, THREADS + 2)])

    def test_concurrent_first_use_agrees_on_one_counter(self):
        """No counter row yet: every caller seeds at once, INSERT ... ON
        CONFLICT DO NOTHING keeps one row, and the numbers stay distinct."""
        self._add_ticket("000005")
        codes = self._concurrently(T._next_ticket_code, self._add_ticket)
        self.assertEqual(len(set(codes)), THREADS, f"duplicate ticket codes: {sorted(codes)}")
        self.assertEqual(self.db.query(models.NexusCounter).count(), 1)
        self.assertEqual(min(codes), "000006")

    def test_a_rolled_back_create_does_not_burn_or_duplicate_a_number(self):
        db = database.SessionLocal()
        self.assertEqual(T._next_ticket_code(db), "000001")
        db.rollback()
        db.close()
        self.assertEqual(self._ticket(), "000001")
        self.assertEqual(self._ticket(), "000002")


class TaskCodeTests(_Case):
    def test_sequential_creates_count_up_in_todays_format(self):
        self.assertEqual([self._task() for _ in range(3)], ["TASK-001", "TASK-002", "TASK-003"])

    def test_deleting_a_task_never_reuses_a_code(self):
        """count() + 1 with 3 tasks, one deleted, gave TASK-003 again."""
        for _ in range(3):
            self._task()
        self.db.query(models.Task).filter(models.Task.code == "TASK-002").delete()
        self.db.commit()
        self.assertEqual(self._task(), "TASK-004")
        self.db.query(models.Task).filter(models.Task.code == "TASK-004").delete()
        self.db.commit()
        self.assertEqual(self._task(), "TASK-005")

    def test_trashing_a_task_never_reuses_its_code(self):
        """Trash hides the row from every query, count() included - and a
        trashed task can be restored, so its code is still taken."""
        for _ in range(2):
            self._task()
        t = (self.db.query(models.Task).filter(models.Task.code == "TASK-002").one())
        t.deleted_at = now_iso()
        self.db.commit()
        self.assertEqual(self._task(), "TASK-003")

    def test_the_counter_seeds_past_trashed_tasks_and_the_logs(self):
        self._add_task("TASK-004")
        self._add_task("TASK-007", deleted_at=now_iso())
        self.db.add(models.TaskEmailLog(id=gen_id(), task_id="gone", task_code="TASK-011",
                                        idempotency_key="gone:created:0:x"))
        self.db.add(models.TaskActivity(id=gen_id(), entity_kind="task", entity_id="gone",
                                        entity_code="TASK-012"))
        self.db.commit()
        self.assertEqual(self._task(), "TASK-013")

    def test_a_client_supplied_code_is_ignored(self):
        self._task()
        self.assertEqual(self._task(code="TASK-001"), "TASK-002")

    def test_codes_within_one_unflushed_session_are_distinct(self):
        """The project-template path makes many tasks before committing; under
        autoflush=False none of them is visible to a query, which is why the
        old code read the count once and incremented by hand."""
        codes = [_next_code(self.db) for _ in range(5)]
        self.db.commit()
        self.assertEqual(codes, [f"TASK-{n:03d}" for n in range(1, 6)])

    def test_concurrent_allocation_gives_every_caller_its_own_code(self):
        self._task()
        codes = self._concurrently(_next_code, self._add_task)
        self.assertEqual(len(set(codes)), THREADS, f"duplicate task codes: {sorted(codes)}")
        self.assertEqual(sorted(codes), [f"TASK-{n:03d}" for n in range(2, THREADS + 2)])

    def test_ticket_and_task_sequences_are_independent(self):
        self._ticket()
        self._ticket()
        self.assertEqual(self._task(), "TASK-001")
        rows = {c.name: c.value for c in self.db.query(models.NexusCounter).all()}
        self.assertEqual(rows, {code_sequence.TICKET_SEQUENCE: 2, code_sequence.TASK_SEQUENCE: 1})


class DuplicateCheckTests(_Case):
    """check_code_duplicates.py - the release step before the unique indexes."""

    def _seed_duplicates(self):
        self._add_task("TASK-001")
        self._add_task("TASK-001", deleted_at=now_iso())     # trashed still counts
        self._add_task("TASK-002")
        self._add_ticket("000003")
        self._add_ticket("TKT-003")                         # same number, legacy form
        self._add_ticket("000004")

    def _codes(self):
        self.db.expire_all()
        tasks = [t.code for t in self.db.query(models.Task)
                 .execution_options(include_deleted=True).all()]
        tickets = [t.code for t in self.db.query(models.TaskTicket).all()]
        return sorted(tasks), sorted(tickets)

    def test_dry_run_reports_and_changes_nothing(self):
        self._seed_duplicates()
        before = self._codes()
        self.assertEqual(check_code_duplicates.main([]), 1)
        self.assertEqual(self._codes(), before)
        self.assertEqual(len(check_code_duplicates.task_duplicates(self.db)), 1)
        self.assertEqual(len(check_code_duplicates.ticket_duplicates(self.db)), 1)

    def test_fix_renumbers_the_newer_rows_and_leaves_it_clean(self):
        self._seed_duplicates()
        self.assertEqual(check_code_duplicates.main(["--fix"]), 0)
        tasks, tickets = self._codes()
        self.assertEqual(len(set(tasks)), len(tasks))
        self.assertIn("TASK-003", tasks)        # past the highest in use
        self.assertIn("000005", tickets)
        self.assertEqual(check_code_duplicates.main([]), 0)

    def test_a_clean_database_passes(self):
        self._task()
        self._ticket()
        self.assertEqual(check_code_duplicates.main([]), 0)


if __name__ == "__main__":
    unittest.main()
