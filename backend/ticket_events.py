"""Live tickets (11/13/2026): a committed ticket change pings open ticket lists.

Tasks have always done this (routers.task_util.fire_task_event): a row goes
into `task_events`, the one task table the browser's anon key may read, and
every open Tasks screen refetches. Tickets never pinged, so a desk agent's
list - the Needs Reply queue above all - was up to a minute behind.

This rides the session instead of the routes, like the hooks beside it in
database.py: a ticket is written from the desk, Support, the mail-in poller,
approvals, auto-close, the SLA scans, Construction, preventive maintenance...
and the next writer would not know to ping. A flush that touches a ticket is
noted on the session and ONE ping goes out once that transaction has really
committed - a ping before the commit would make the browser refetch the old
rows; a rollback forgets it.

What counts as a ticket change:
  - a `TaskTicket` row added, deleted, or changed in any column but the ones
    in `_QUIET` (the requester's own "seen" stamp - opening a ticket would
    otherwise make every desk screen download the list again);
  - a `TaskActivity` row for a ticket: every ticket write logs one, which
    covers the writes that leave the ticket row alone (a deleted comment, a
    file added or removed).

What the ping carries: `kind = "ticket"` and NOTHING else - no ticket id, no
person, no company. `task_events` is anon-readable, so the row says only
"some ticket changed"; an Ask HR (confidential) ticket's ping is the same row
as any other and names nothing. `kind` is the existing column the browser
reads to tell a ticket ping from a task ping (TasksContext.jsx): a ticket
ping refetches the ticket list, a task ping never does.

Fire and forget, exactly like the task ping: `fire_task_event` posts from a
daemon thread, so nothing here blocks the event loop or can fail the save.
A burst (a batch create, a scan closing fifty tickets one commit each) is
folded: at most one ping per `MIN_GAP_S` per worker, the last change always
followed by one.
"""
import threading
import time

from sqlalchemy import event, inspect

PING_KIND = "ticket"
MIN_GAP_S = 1.0

_PENDING = "_ticket_ping"
# Columns whose change alone is not worth a refetch for everyone.
_QUIET = frozenset({"requester_seen_at"})

_lock = threading.Lock()
_last_sent = 0.0
_late_waiting = False


def _send() -> None:
    try:
        from routers import task_util
        task_util.fire_task_event("", PING_KIND)
    except Exception as e:   # noqa: BLE001 - a ping must never fail the save behind it
        print(f"[ticket-events] ping: {e}")


def _send_late() -> None:
    global _last_sent, _late_waiting
    with _lock:
        _late_waiting = False
        _last_sent = time.monotonic()
    _send()


def ping() -> None:
    """Tell open ticket lists to refetch. Straight away when the last ping
    is older than MIN_GAP_S; otherwise one ping when the gap is up, however
    many changes land before it."""
    global _last_sent, _late_waiting
    with _lock:
        wait = _last_sent + MIN_GAP_S - time.monotonic()
        if wait > 0:
            if _late_waiting:
                return
            _late_waiting = True
        else:
            _last_sent = time.monotonic()
    if wait > 0:
        timer = threading.Timer(wait, _send_late)
        timer.daemon = True
        timer.start()
    else:
        _send()


def _row_changed(obj) -> bool:
    return any(a.history.has_changes() for a in inspect(obj).attrs if a.key not in _QUIET)


def _touches_ticket(session) -> bool:
    import models
    for obj in session.new:
        if isinstance(obj, models.TaskTicket):
            return True
        if isinstance(obj, models.TaskActivity) and (obj.entity_kind or "") == "ticket":
            return True
    for obj in session.deleted:
        if isinstance(obj, models.TaskTicket):
            return True
    for obj in session.dirty:
        if isinstance(obj, models.TaskTicket) and _row_changed(obj):
            return True
    return False


def wire(session_factory) -> None:
    """Attach the listeners to SessionLocal (called once from database.py)."""

    @event.listens_for(session_factory, "after_flush")
    def _note(session, _ctx):
        if session.info.get(_PENDING):
            return
        try:
            if _touches_ticket(session):
                session.info[_PENDING] = True
        except Exception as e:   # noqa: BLE001 - never fail the flush
            print(f"[ticket-events] note: {e}")

    def _note_bulk(ctx):
        try:
            import models
            if ctx.mapper is not None and ctx.mapper.class_ is models.TaskTicket:
                ctx.session.info[_PENDING] = True
        except Exception as e:   # noqa: BLE001
            print(f"[ticket-events] note: {e}")

    event.listen(session_factory, "after_bulk_update", _note_bulk)
    event.listen(session_factory, "after_bulk_delete", _note_bulk)

    @event.listens_for(session_factory, "after_commit")
    def _ping_after_commit(session):
        # after_commit also fires when a SAVEPOINT is released; the rows are
        # only there for other readers once the outer transaction commits.
        if session.in_nested_transaction():
            return
        if session.info.pop(_PENDING, False):
            ping()

    @event.listens_for(session_factory, "after_rollback")
    def _forget(session):
        session.info.pop(_PENDING, None)
