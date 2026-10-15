"""One bell notice that grows instead of many that stack (Neil, Oct 14 2026:
"it feels pretty spammy").

A flow that can fire many times about the same person and day - a manager
fixing ten punches, a run of out-of-fence punches, a report's beginning and
end of day - calls upsert_rollup with a stable key. The first call writes the
notice; later ones put their line on top of the same notice, mark it unread
again and move it to the top of the bell. The newest lines are kept, with a
count of the rest.

Sessions run autoflush=False (CLAUDE.md), so a notice added earlier in the
same request is not visible to a query yet - those are found in session.new.
The lookup takes a row lock (with_for_update), as the batching rule asks, so
two requests GROWING the same notice serialize. Two requests that both find
no notice yet can still both insert (there is no unique key); that rare race
costs a duplicate notice, never a lost one.
"""
import json
import uuid
from datetime import datetime, timezone

from models import NexusNotification

MAX_LINES = 6


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pending(db, recipient: str, key: str):
    for obj in db.new:
        if isinstance(obj, NexusNotification) and obj.recipient == recipient and obj.ref_id == key:
            return obj
    return None


def _find(db, recipient: str, key: str, ntype: str, open_only: bool):
    row = _pending(db, recipient, key)
    if row is not None and (not open_only or not row.actioned):
        return row
    q = (db.query(NexusNotification)
         .filter(NexusNotification.recipient == recipient, NexusNotification.ref_id == key,
                 NexusNotification.type == ntype))
    if open_only:
        q = q.filter(NexusNotification.actioned == False)   # noqa: E712 - SQLAlchemy expression
    return q.order_by(NexusNotification.created_at.desc()).with_for_update().first()


def upsert_rollup(db, *, recipient: str, key: str, title: str, line: str, action: dict | None = None,
                  company: str = "", requested_by: str = "", replace: bool = False,
                  ntype: str = "custom_alert", quiet: bool = False, priority: int | None = None,
                  open_only: bool = False) -> bool:
    """Write or grow the notice `key` for `recipient`. `replace` swaps the
    whole body for `line` (a report that is rewritten, not appended to).
    `quiet` (Oct 15) rewrites the words but leaves the notice where its
    reader left it - read stays read, closed stays closed, no move to the
    top - for a scan that refreshes a count every minute. `priority` sets
    the notice's priority (1 = the yellow bar) when given. `open_only`
    grows only a notice that is still open (not actioned): a resolved one
    is history, and the key gets a new notice (the no-show bell's
    team-day that empties and fills again).
    Returns True when a new notice was written (the first of its kind)."""
    recipient = (recipient or "").strip().lower()
    if not recipient or not key:
        return False
    row = _find(db, recipient, key, ntype, open_only)
    if row is None:
        db.add(NexusNotification(
            id=str(uuid.uuid4()), type=ntype, recipient=recipient, title=title, body=line,
            ref_id=key, item_name="", requested_by=requested_by,
            action=json.dumps(action) if action else "", actioned=False, read_by="",
            company=company, created_at=_now(), priority=int(priority or 0)))
        return True
    if priority is not None:
        row.priority = int(priority)
    if replace:
        row.body = line
    else:
        lines = [x for x in (row.body or "").split("\n") if x and not x.startswith("+ ")]
        more = 0
        tail = [x for x in (row.body or "").split("\n") if x.startswith("+ ")]
        if tail:
            try:
                more = int(tail[0].split()[1])
            except (IndexError, ValueError):
                more = 0
        lines = [line] + lines
        if len(lines) > MAX_LINES:
            more += len(lines) - MAX_LINES
            lines = lines[:MAX_LINES]
        row.body = "\n".join(lines + ([f"+ {more} earlier"] if more else []))
    row.title = title
    if not quiet:
        row.read_by = ""          # new information: unread again
        row.closed_by = ""        # and back in the bell if it had been cleared
        row.created_at = _now()   # to the top
    if action:
        row.action = json.dumps(action)
    return False


def resolve_rollup(db, *, recipient: str, key: str, title: str, line: str, ntype: str = "custom_alert") -> bool:
    """Close the OPEN notice `key` for `recipient` in place: its last words
    (`title`, `line`), actioned, priority back to 0 - it moves to the bell's
    Closed list rather than vanishing. Returns False when there is none."""
    recipient = (recipient or "").strip().lower()
    if not recipient or not key:
        return False
    row = _find(db, recipient, key, ntype, True)
    if row is None:
        return False
    row.title, row.body, row.actioned, row.priority = title, line, True, 0
    return True


def retitle_resolved(db, *, recipient: str, key: str, title: str, line: str, ntype: str = "custom_alert") -> bool:
    """Rewrite the words of the newest RESOLVED notice `key` (a closed
    no-show bell whose story changed after it closed - the person came in
    late after all). Stays closed; returns False when there is none."""
    recipient = (recipient or "").strip().lower()
    if not recipient or not key:
        return False
    row = (db.query(NexusNotification)
           .filter(NexusNotification.recipient == recipient, NexusNotification.ref_id == key,
                   NexusNotification.type == ntype, NexusNotification.actioned == True)   # noqa: E712
           .order_by(NexusNotification.created_at.desc()).first())
    if row is None:
        return False
    row.title, row.body = title, line
    return True
