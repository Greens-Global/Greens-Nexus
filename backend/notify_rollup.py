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
two requests at once cannot both decide to insert.
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


def upsert_rollup(db, *, recipient: str, key: str, title: str, line: str, action: dict | None = None,
                  company: str = "", requested_by: str = "", replace: bool = False,
                  ntype: str = "custom_alert") -> bool:
    """Write or grow the notice `key` for `recipient`. `replace` swaps the
    whole body for `line` (a report that is rewritten, not appended to).
    Returns True when a new notice was written (the first of its kind)."""
    recipient = (recipient or "").strip().lower()
    if not recipient or not key:
        return False
    row = _pending(db, recipient, key)
    if row is None:
        row = (db.query(NexusNotification)
               .filter(NexusNotification.recipient == recipient, NexusNotification.ref_id == key,
                       NexusNotification.type == ntype)
               .with_for_update().first())
    if row is None:
        db.add(NexusNotification(
            id=str(uuid.uuid4()), type=ntype, recipient=recipient, title=title, body=line,
            ref_id=key, item_name="", requested_by=requested_by,
            action=json.dumps(action) if action else "", actioned=False, read_by="",
            company=company, created_at=_now(), priority=0))
        return True
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
    row.read_by = ""          # new information: unread again
    row.closed_by = ""        # and back in the bell if it had been cleared
    row.created_at = _now()   # to the top
    if action:
        row.action = json.dumps(action)
    return False
