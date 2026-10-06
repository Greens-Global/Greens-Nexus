"""Ticket numbers and task codes that can never repeat (Oct 2026).

THE PROBLEM. Both numbers were worked out from the rows already there:
  - tickets read every existing code and took the highest + 1. Two tickets
    filed at the same moment both read the same highest and both got the next
    number (nothing locked it, and task_tickets.code has no unique index).
  - tasks took count() + 1 under an advisory lock. The lock fixed the race,
    but a count is "how many", not "what comes next": delete or trash a task
    and the next one reuses a number that is still on a live (or restorable)
    task. Trashed tasks are hidden from the count by the soft-delete hook in
    database.py, so moving one task to Trash was enough (Sep 30 review #5).

THE FIX. One row per sequence in `nexus_counters`, bumped with a single
atomic `UPDATE ... SET value = value + 1 ... RETURNING value`:
  - Postgres: the UPDATE takes a row lock that is held until the caller's
    transaction ends, so a second caller waits and then reads the committed
    value - never the same one. It is a plain row lock inside the caller's
    own transaction, so it is safe behind the PgBouncer/Supavisor transaction
    pooler (no session state, no advisory lock that could outlive a borrowed
    connection). If the caller rolls back, the bump rolls back with it and
    the next caller gets that number instead - nothing was issued.
  - SQLite (local/tests): the UPDATE takes the database write lock and the
    connection's busy_timeout makes a second writer wait for it.
The number is allocated in the CALLER's session so it commits together with
the row that carries it.

SEEDING. The first time a sequence is used the row is created at the highest
number ever seen - live rows (trashed tasks included) AND the denormalized
codes in the email/activity logs, which outlive a hard-deleted row - so the
sequence continues past everything already issued instead of restarting.
`INSERT ... ON CONFLICT DO NOTHING` makes two first-time callers agree on one
row.

BELT AND BRACES. A number that is somehow already on a row (a counter seeded
before an older row was restored, a legacy import) is skipped, never reused.

The visible format is unchanged: tickets "000123" (shown "Ticket #123"),
tasks "TASK-123" (at least three digits).
"""
import re
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.orm import Session

import models
from ticket_code import TICKET_CODE_DIGITS, digits_of

TICKET_SEQUENCE = "ticket_code"
TASK_SEQUENCE = "task_code"

_TASK_CODE_RE = re.compile(r"^\s*TASK-(\d+)\s*$", re.IGNORECASE)
# A runaway guard for the skip-in-use loop: each pass consumes one number, so
# this only stops if that many consecutive numbers are already taken - which
# means the counter is badly behind and someone should look.
_MAX_SKIPS = 10000


def _bump(db: Session, name: str):
    row = db.execute(
        text("UPDATE nexus_counters SET value = value + 1, updated_at = :at "
             "WHERE name = :n RETURNING value"),
        {"n": name, "at": _now()},
    ).first()
    return int(row[0]) if row else None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def next_number(db: Session, name: str, seed_fn) -> int:
    """The next number of sequence `name`, never handed out before.

    `seed_fn(db) -> int` is the highest number already in use; it runs only
    when the sequence has no row yet. The UPDATE goes first, so on SQLite the
    transaction asks for the write lock before it reads anything."""
    n = _bump(db, name)
    if n is not None:
        return n
    db.execute(
        text("INSERT INTO nexus_counters (name, value, updated_at) VALUES (:n, :v, :at) "
             "ON CONFLICT (name) DO NOTHING"),
        {"n": name, "v": int(seed_fn(db) or 0), "at": _now()},
    )
    n = _bump(db, name)
    if n is None:   # pragma: no cover - the row was inserted a line above
        raise RuntimeError(f"counter {name!r} could not be created")
    return n


# ── tickets ──────────────────────────────────────────────────────────────────

def _ticket_seed(db: Session) -> int:
    highest = 0
    # include_deleted: once tickets are soft-deleted (fix/ticket-safe-deletes),
    # a deleted ticket keeps its row and its number - it can be restored - so
    # it must count here. Ignored while tickets are not on the soft-delete hook.
    for (code,) in (db.query(models.TaskTicket.code)
                    .execution_options(include_deleted=True).all()):
        highest = max(highest, digits_of(code))
    for (code,) in db.query(models.TicketEmailLog.ticket_code).distinct().all():
        highest = max(highest, digits_of(code))
    return highest


def _ticket_code_taken(db: Session, n: int) -> bool:
    forms = {f"{n:0{TICKET_CODE_DIGITS}d}", f"TKT-{n:03d}", str(n)}
    return (db.query(models.TaskTicket.id).filter(models.TaskTicket.code.in_(forms))
            .execution_options(include_deleted=True).first()) is not None


def next_ticket_code(db: Session) -> str:
    """The next ticket code, e.g. "000124"."""
    for _ in range(_MAX_SKIPS):
        n = next_number(db, TICKET_SEQUENCE, _ticket_seed)
        if not _ticket_code_taken(db, n):
            return f"{n:0{TICKET_CODE_DIGITS}d}"
    raise RuntimeError("ticket counter is far behind the codes in use - run check_code_duplicates.py")


# ── tasks ────────────────────────────────────────────────────────────────────

def _task_number(code) -> int:
    m = _TASK_CODE_RE.match(code or "")
    return int(m.group(1)) if m else 0


def _task_seed(db: Session) -> int:
    highest = 0
    # Trashed tasks still own their code (they can be restored), so read past
    # the soft-delete filter in database.py.
    for (code,) in (db.query(models.Task.code)
                    .execution_options(include_deleted=True).all()):
        highest = max(highest, _task_number(code))
    for (code,) in db.query(models.TaskEmailLog.task_code).distinct().all():
        highest = max(highest, _task_number(code))
    for (code,) in (db.query(models.TaskActivity.entity_code)
                    .filter(models.TaskActivity.entity_code.like("TASK-%")).distinct().all()):
        highest = max(highest, _task_number(code))
    return highest


def _task_code_taken(db: Session, code: str) -> bool:
    return (db.query(models.Task.id).filter(models.Task.code == code)
            .execution_options(include_deleted=True).first()) is not None


def next_task_code(db: Session) -> str:
    """The next task code, e.g. "TASK-124"."""
    for _ in range(_MAX_SKIPS):
        code = f"TASK-{next_number(db, TASK_SEQUENCE, _task_seed):03d}"
        if not _task_code_taken(db, code):
            return code
    raise RuntimeError("task counter is far behind the codes in use - run check_code_duplicates.py")
