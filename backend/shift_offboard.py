"""When People offboards someone, their shifts AFTER THEIR LAST DAY leave
the schedule (hardening pass, Oct 15 2026; the cutoff is the last day, not
the server's date - 11/14/2026): published placements after it are marked
for removal (pending_delete - the team sees them go at the next share, like
any removal), drafts after it are deleted outright, and each is logged as
'removed' with the reason "offboarded" (shift_log). The last day and earlier
stay as the record of what was scheduled. Offboarding applies the morning
AFTER the last day, so cutting at "today" kept that morning's shift. Called from
routers/hr.apply_status_change in the same session as the items force-
return and the task handover; it never commits and never raises.
"""
from datetime import date

from sqlalchemy import func

import models
import shift_log


def remove_future_shifts(db, email: str, actor: str, today: date = None, last_day: str = "") -> dict:
    """{pendingDelete, deleted} - what left the schedule for `email`: every
    shift after `last_day` (YYYY-MM-DD), else after `today`."""
    em = (email or "").strip().lower()
    out = {"pendingDelete": 0, "deleted": 0}
    if not em:
        return out
    cutoff = (last_day or "")[:10] if len(last_day or "") >= 10 else (today or date.today()).isoformat()
    rows = (db.query(models.ScheduledShift)
            .filter(func.lower(models.ScheduledShift.employee_email) == em,
                    models.ScheduledShift.work_date > cutoff).all())
    for r in rows:
        if r.published:
            if r.pending_delete:
                continue
            r.pending_delete = 1
            shift_log.record(db, "removed", r, actor, before=shift_log.snapshot(r), reason="offboarded")
            out["pendingDelete"] += 1
        else:
            shift_log.record(db, "removed", r, actor, before=shift_log.snapshot(r), reason="offboarded")
            db.delete(r)
            out["deleted"] += 1
    return out
