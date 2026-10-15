"""When People offboards someone, their FUTURE shifts leave the schedule
(hardening pass, Oct 15 2026): published placements after today are marked
for removal (pending_delete - the team sees them go at the next share, like
any removal), drafts after today are deleted outright, and each is logged
as 'removed' with the reason "offboarded" (shift_log). Today's and earlier
shifts stay as the record of what was scheduled. Called from
routers/hr.apply_status_change in the same session as the items force-
return and the task handover; it never commits and never raises.
"""
from datetime import date

from sqlalchemy import func

import models
import shift_log


def remove_future_shifts(db, email: str, actor: str, today: date = None) -> dict:
    """{pendingDelete, deleted} - what left the schedule for `email`."""
    em = (email or "").strip().lower()
    out = {"pendingDelete": 0, "deleted": 0}
    if not em:
        return out
    cutoff = (today or date.today()).isoformat()
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
