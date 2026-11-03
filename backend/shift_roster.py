"""Who is on the schedule (Neil, 11/03/2026).

ONE rule for every scheduling reader: a person is on the schedule when they
are active in People (status 'active', not in the recycle bin), have a work
email, and their "On the Schedule" switch is on (`nexus_employees.on_schedule`;
NULL counts as on - rows from before the column). Off = they never appear in
scheduling: no planner row, no fills or copies, no Late, no no-show, no
Workforce Scorecard line, no trading. Their team memberships are KEPT while
off, only hidden, so switching them back on puts them exactly where they were.

Schedulers and weather deciders are NOT read through this rule: an
off-schedule manager can still run schedules (timeclock._is_active_emp).
"""


def is_switched_on(e) -> bool:
    """The switch alone: NULL / anything but 0 is on."""
    v = getattr(e, "on_schedule", 1)
    try:
        return v is None or int(v) != 0
    except (TypeError, ValueError):
        return True


def is_active(e) -> bool:
    """Active in People and not deleted - the plain People rule."""
    return (e is not None and (getattr(e, "status", "") or "active").lower() == "active"
            and not (getattr(e, "deleted_at", "") or ""))


def on_schedule(e) -> bool:
    """Active, not deleted, has a work email, and the switch is on."""
    return is_active(e) and bool(getattr(e, "work_email", "") or "") and is_switched_on(e)


def off_emails(db) -> set:
    """Lower-cased work emails of everyone switched off (any status)."""
    import models
    return {(e.work_email or "").lower() for e in
            db.query(models.NexusEmployee).filter(models.NexusEmployee.on_schedule == 0).all()
            if e.work_email}
