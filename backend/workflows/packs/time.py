"""Time pack (Task 11): the Time Sheet under review (`timesheet`), the punch
(`punch`) and the events the Time Clock emits about a person.

Events and where they come from:
  * `timesheet.review_changed` - `timesheet_review._round`, every round of a
    review (submitted, sent_back, agreed, reopened, hr_edited, ...): the
    status from / to and the round's action, author and note in `extra`.
    Three rounds (agreed, employee_approved, correction_sent) put the card
    out for signature right after the round is logged, so their "to" reads
    `signing` (`review_status_change`).
  * `period.closed` - `timesheet_alerts.scan`, the first time an approver is
    told a person's closed pay period waits on them (one per person and
    period; the subject is the Person, `extra` carries the period).
  * `time.add_time_batch` - a manager's Add Time (`routers/timeclock.add_time`)
    or HR's Add Time From Record (`duplicate_day`): one event per batch, the
    Person as subject, the dates and minutes in `extra`.
  * `punch.in` / `punch.out` - a TimePunch row is ONE punch (kind in | out |
    break_start | break_end), so a pair is two inserts. The record observer
    emits `<entity>.created` only; this pack's own after_flush listener
    (`_punch_flush`, wired on SessionLocal when the pack loads) maps an
    inserted in / out punch to its event. Both are `volume="high"`: nothing
    is written unless a workflow subscribes.

`may_use`: the HR grant, the Workforce Analytics (employee-tracking) grant
or an administrator - what `timeclock.require_tracking` admits, plus HR.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import event as sa_event
from sqlalchemy import inspect as sa_inspect

import database
import models
from workflows.catalog import F, P, entity, event, list_source
from workflows.context import us_date
from workflows.emit import emit
from workflows.packs import core as _core   # the Person entity: period.closed and time.add_time_batch are about one
from workflows.packs._people import (attach_property, company_hr_contacts, emails, employee_row, has_grant,
                                     is_admin, parse_dt, person_company, person_manager, stored_value)

MODULE = "time"

REVIEW_STATUSES = [
    ("with_manager", "With Manager"), ("with_employee", "With Employee"), ("approved", "Approved"),
    ("signing", "Out for Signature"), ("correcting", "Correcting"), ("completed", "Completed"),
    ("unlocked", "Unlocked"), ("retired", "Retired"),
]
# The round actions `extra.action` may carry (timesheet_review._round callers).
ROUND_ACTIONS = ("submitted", "resubmitted", "sent_back", "agreed", "employee_approved", "reopened", "hr_edited",
                 "finalized_unsigned", "unlocked", "relocked", "correction_sent", "auto_accepted", "completed",
                 "declined", "returned", "recalled", "cancelled", "retired", "totals_changed", "break_attested",
                 "break_not_collected", "signed_employee")
# Rounds after which the review goes out for the employee's signature (the
# caller sets `signing` right after the round is logged).
_SIGNING_NEXT = ("agreed", "employee_approved", "correction_sent")


# ── derived attributes ───────────────────────────────────────────────────────
def _worked_min(r) -> int:
    for e in reversed(list(r.rounds or [])):
        if isinstance(e, dict) and e.get("workedMin") is not None:
            try:
                return int(e.get("workedMin") or 0)
            except (TypeError, ValueError):
                return 0
    return 0


attach_property(models.TimesheetReview, "wf_worked_min", _worked_min)


# ── access ───────────────────────────────────────────────────────────────────
def may_use(db, user) -> bool:
    """HR grant, Workforce Analytics grant or an administrator."""
    if not user:
        return False
    return is_admin(user) or has_grant(db, user, "hr") or has_grant(db, user, "employee-tracking")


def _person_visible(db, user, email: str) -> bool:
    if not user:
        return False
    me = (user.get("email") or "").lower()
    em = (email or "").lower()
    if me and em and (me == em or me in person_manager(db, em)):
        return True
    return may_use(db, user)


# ── people ───────────────────────────────────────────────────────────────────
def _ts_self(db, row) -> list[str]:
    return emails(row.employee_email)


def _ts_manager(db, row) -> list[str]:
    return emails(row.manager_email) or person_manager(db, row.employee_email)


def _ts_hr_contact(db, row) -> list[str]:
    return company_hr_contacts(db, person_company(db, row.employee_email))


def _punch_self(db, row) -> list[str]:
    return emails(row.employee_email)


def _punch_manager(db, row) -> list[str]:
    return person_manager(db, row.employee_email)


# ── entities ─────────────────────────────────────────────────────────────────
entity("timesheet", label="Time Sheet", model=models.TimesheetReview, module=MODULE,
       company=lambda row: person_company(row, row.employee_email),
       link=lambda row: {"view": "hr", "sub": "hr-time", "timecard": row.employee_email,
                         "start": row.period_start, "payType": row.pay_type or "hourly"},
       people={"self": _ts_self, "manager": _ts_manager, "hr_contact": _ts_hr_contact},
       fields=[
           F("employee", "Person", "person", path="employee_email"),
           F("status", "Status", "select", options=REVIEW_STATUSES),
           F("period_start", "Period Start", "date"),
           F("period_end", "Period End", "date"),
           F("pay_type", "Pay Type", "select", options=[("hourly", "Hourly"), ("fixed", "Fixed")]),
           F("worked_min", "Worked Minutes", "number", path="wf_worked_min"),
           F("reviewer", "Reviewer", "person", path="manager_email"),
           F("hr_contact", "HR Contact", "person", path="hr_email"),
       ],
       dates=["period_start", "period_end"],
       label_of=lambda row: f"Time Sheet {us_date(row.period_start)} - {us_date(row.period_end)} ({row.employee_email})",
       visible_to=lambda db, user, row: _person_visible(db, user, row.employee_email))

entity("punch", label="Punch", model=models.TimePunch, module=MODULE,
       company=lambda row: person_company(row, row.employee_email),
       link=lambda row: {"view": "timeclock", "sub": "timecard", "email": row.employee_email,
                         "start": row.local_date or ""},
       people={"self": _punch_self, "manager": _punch_manager},
       fields=[
           F("employee", "Person", "person", path="employee_email"),
           F("kind", "Kind", "select", options=[("in", "In"), ("out", "Out"), ("break_start", "Break Start"),
                                                 ("break_end", "Break End")]),
           F("at", "Time", "datetime"),
           F("local_date", "Day", "date"),
           F("category", "Job Category", "text"),
           F("work_site_name", "Site", "text"),
           F("geo_status", "Location Check", "select",
             options=[("in_fence", "At the Site"), ("out_of_fence", "Away From the Site"),
                      ("no_location", "No Location")]),
           F("source", "Source", "select",
             options=[("web", "Clock"), ("self_manual", "Missed Punch Fix"), ("manual", "Manager")]),
           F("note", "Note", "text"),
       ],
       dates=["local_date"],
       label_of=lambda row: f"Punch {row.kind} {row.employee_email} {us_date(row.local_date or row.at)}",
       visible_to=lambda db, user, row: _person_visible(db, user, row.employee_email))

SAMPLE_TIMESHEET = {
    "employee": "priya.shah@greensglobal.com", "status": "signing", "period_start": "2026-10-04",
    "period_end": "2026-10-17", "pay_type": "hourly", "worked_min": 4800,
    "reviewer": "max.miller@greensglobal.com", "hr_contact": "hana.hr@greensglobal.com",
}
SAMPLE_PUNCH = {
    "employee": "priya.shah@greensglobal.com", "kind": "in", "at": "2026-10-28T15:02:00+00:00",
    "local_date": "2026-10-28", "category": "Site Work", "work_site_name": "Escondido", "geo_status": "in_fence",
    "source": "web", "note": "",
}

# ── events ───────────────────────────────────────────────────────────────────
event("timesheet.review_changed", entity="timesheet", label="Time Sheet Review Changes", module=MODULE,
      group="Time Sheets", changes=("status",), may_use=may_use,
      sample={"subject": SAMPLE_TIMESHEET,
              "changes": {"status": {"from": "with_manager", "to": "signing"}},
              "extra": {"action": "agreed", "by": "max.miller@greensglobal.com", "note": "Looks right.", "for": ""},
              "actor": "max.miller@greensglobal.com"})
event("period.closed", entity="employee", label="Pay Period Closes", module=MODULE, group="Time Sheets",
      may_use=may_use,
      sample={"subject": dict(_core.SAMPLE_EMPLOYEE),
              "extra": {"start": "2026-10-04", "end": "2026-10-17", "payType": "hourly",
                        "approver": "max.miller@greensglobal.com"},
              "actor": ""})
event("time.add_time_batch", entity="employee", label="Time Is Added in a Batch", module=MODULE,
      group="Time Clock", may_use=may_use,
      sample={"subject": dict(_core.SAMPLE_EMPLOYEE),
              "extra": {"batchId": "6f1c2d7e-0000-4000-8000-000000000001", "source": "manager",
                        "dates": ["2026-10-05", "2026-10-06"], "minutes": 960, "replaced": 0,
                        "reason": "Paper time sheet from the Escondido site"},
              "actor": "max.miller@greensglobal.com"})
event("punch.in", entity="punch", label="Person Punches In", module=MODULE, group="Time Clock",
      volume="high", may_use=may_use, sample=SAMPLE_PUNCH)
event("punch.out", entity="punch", label="Person Punches Out", module=MODULE, group="Time Clock",
      volume="high", may_use=may_use,
      sample=dict(SAMPLE_PUNCH, kind="out", at="2026-10-28T23:31:00+00:00"))


# ── emit helpers (called from the module choke points) ───────────────────────
def review_status_change(r, action: str) -> tuple:
    """(from, to) of a review's status for the round `action` being logged:
    from = the status the database holds (the attribute history when it is
    loaded, else a read - the caller may have set the status after the row
    expired); to = the row's status, or `signing` for the rounds whose
    caller sends the envelope right after."""
    old = None
    try:
        hist = sa_inspect(r).attrs["status"].history
        if hist.deleted:
            old = hist.deleted[0]
        elif hist.added:
            old = stored_value(r, "status")
        else:
            old = r.status
    except Exception:   # noqa: BLE001 - the from stays blank rather than losing the event
        old = None
    new = "signing" if action in _SIGNING_NEXT else (r.status or "")
    return (old or "", new or "")


def person_subject(db, email: str):
    """The Person row an event about `email` is emitted on (None = the emit
    logs a skip)."""
    return employee_row(db, email)


# ── the punch listener ───────────────────────────────────────────────────────
_PUNCH_EVENTS = {"in": "punch.in", "out": "punch.out"}


def _punch_flush(session, _flush_ctx) -> None:
    """after_flush: an inserted in / out punch is its event (voided rows and
    break punches are not). `emit` writes nothing unless a workflow
    subscribes (both events are high volume) and never raises."""
    for obj in list(session.new):
        if not isinstance(obj, models.TimePunch) or int(obj.voided or 0):
            continue
        key = _PUNCH_EVENTS.get((obj.kind or "").lower())
        if key:
            emit(session, key, subject=obj, actor=obj.created_by or obj.employee_email or "",
                 extra={"source": obj.source or "", "batchId": getattr(obj, "batch_id", "") or ""})


def _wire_punches() -> None:
    if not getattr(database, "_wf_punch_wired", False):
        sa_event.listen(database.SessionLocal, "after_flush", _punch_flush)
        database._wf_punch_wired = True


_wire_punches()


# ── list sources ─────────────────────────────────────────────────────────────
def _scoped(db, rows, ctx, email_of):
    """Keep the rows whose person is in the run's company (when it has one)."""
    cid = (getattr(ctx, "company_id", "") or "")
    if not cid:
        return rows
    memo: dict = {}
    out = []
    for r in rows:
        em = (email_of(r) or "").lower()
        if em not in memo:
            memo[em] = person_company(db, em)
        if memo[em] == cid:
            out.append(r)
    return out


def _today(ctx):
    t = getattr(ctx, "today", None)
    return t if t is not None else datetime.now(timezone.utc).date()


def unsigned_timesheets(db, ctx, params) -> list:
    """Approved cards (out for the employee's signature) the employee has not
    signed in `days` days - the clock timesheet_review's Finalize Without
    Employee Signature uses (`_waiting_since`)."""
    import timesheet_review as tr
    raw = (params or {}).get("days")
    try:
        days = tr.UNSIGNED_WAIT_DAYS if raw in (None, "") else int(raw)
    except (TypeError, ValueError):
        days = tr.UNSIGNED_WAIT_DAYS
    cutoff = datetime.now(timezone.utc) - timedelta(days=max(0, days))
    rows = (db.query(models.TimesheetReview)
            .filter(models.TimesheetReview.status.in_(("approved", "signing")))
            .order_by(models.TimesheetReview.period_start, models.TimesheetReview.employee_email).all())
    out = []
    for r in rows:
        since = parse_dt(tr._waiting_since(r))
        if since is None:
            continue
        if since.tzinfo is None:
            since = since.replace(tzinfo=timezone.utc)
        if since <= cutoff:
            out.append(r)
    return _scoped(db, out, ctx, lambda r: r.employee_email)


def not_reviewed_timesheets(db, ctx, params) -> list:
    """Reviews still with the manager after the period's last day."""
    today = _today(ctx).isoformat()
    rows = (db.query(models.TimesheetReview)
            .filter(models.TimesheetReview.status == "with_manager", models.TimesheetReview.period_end < today)
            .order_by(models.TimesheetReview.period_start, models.TimesheetReview.employee_email).all())
    return _scoped(db, rows, ctx, lambda r: r.employee_email)


list_source("timesheets.unsigned", label="Time Sheets Waiting on a Signature", entity="timesheet", module=MODULE,
            params=[P("days", "Days waiting", "number", required=False, default=3,
                      hint="Approved cards the employee has not signed in this many days")],
            fn=unsigned_timesheets)
list_source("timesheets.not_reviewed", label="Time Sheets Not Yet Reviewed", entity="timesheet", module=MODULE,
            fn=not_reviewed_timesheets)
