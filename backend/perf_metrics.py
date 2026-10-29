"""My Numbers - the Performance scorecard (Neil, Oct 29 2026: "it needs to
provide some real metrics from Nexus").

ONE function every Performance screen, Nexus-measured goal and review reads:

    scorecard(db, email, start, end) -> {"period": {...}, "metrics": [...]}

Every number is what Nexus already records, through the module's OWN
calculation - never a second rule (CLAUDE.md):

  on_time / no_shows   shift_attendance.actuals (the one On Time / Late /
                       No-Show rule, shift_expect underneath)
  hours                workforce_scorecard.build_report (punched vs expected,
                       the Workforce Scorecard's own roster and expectation)
  timesheets           timesheet_review: a manager-approved period, signed by
                       the employee within UNSIGNED_WAIT_DAYS of the approval
  tasks_*              task_due's rule (completed on or before the due day),
                       task_util.task_assignees for who a task is on
  tickets_resolved /   ticket_reports._Fact (the Ticket Reports facts:
  ticket_sla           resolved, first response met)
  training             kb_core.training_status / signoff_state (the
                       Knowledge Base compliance cells)

A metric that does not apply to the person (no published shifts, not on the
scorecard roster, no tickets, nothing assigned) comes back `available:
False` and the screens hide it - never a guessed zero. Time off, sick days,
leave, pay and HR tickets are never metrics (confidential tickets are
invisible to every query here anyway - database.py's hook).

Who may read a person's numbers is performance.can_see_person: the person,
their reporting chain and HR for their company. The routes check it; this
module only computes. Results are remembered for ten minutes per
(email, metric, start, end) - the screens and the goal list read the same
numbers many times in a minute.
"""
from __future__ import annotations

import threading
import time
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import String, cast, func, or_
from sqlalchemy.orm import Session

import models

CACHE_SEC = 600

# key -> (label, unit, good, kind, short description)
#   good  high = more is better; low = less is better
#   kind  rate = a percentage over the period; count = adds up over the
#         period; now = a point in time (today)
METRICS = {
    "on_time":          ("On-Time Arrival", "%", "high", "rate", "Shifts started on time"),
    "no_shows":         ("No-Shows", "", "low", "count", "Shifts missed with no clock-in"),
    "hours":            ("Hours vs Expected", "%", "high", "rate", "Hours worked against the hours expected"),
    "timesheets":       ("Time Sheets Signed On Time", "%", "high", "rate", "Approved time sheets signed within 3 days"),
    "tasks_done":       ("Tasks Completed", "", "high", "count", "Tasks finished in the period"),
    "tasks_on_time":    ("Tasks On Time", "%", "high", "rate", "Finished on or before the due date"),
    "tasks_overdue":    ("Overdue Tasks Now", "", "low", "now", "Open tasks past their due date today"),
    "tickets_resolved": ("Tickets Resolved", "", "high", "count", "Tickets assigned to them resolved in the period"),
    "ticket_sla":       ("Replies Within Target", "%", "high", "rate", "First replies within the ticket target"),
    "training":         ("Required Training Done", "%", "high", "now", "Assigned courses and policies complete"),
}
ORDER = list(METRICS)

_cache: dict = {}
_lock = threading.Lock()


def _low(s) -> str:
    return (s or "").strip().lower()


def local_today() -> date:
    from performance import zone, DEFAULT_TZ
    return datetime.now(timezone.utc).astimezone(zone(DEFAULT_TZ)).date()


def _out(key: str, value=None, *, detail: str = "", available: bool = True) -> dict:
    label, unit, good, kind, desc = METRICS[key]
    if value is None:
        available = False
    display = "" if not available else (f"{int(round(value))}%" if unit == "%" else f"{int(round(value))}")
    return {"key": key, "label": label, "value": (round(float(value), 1) if available else None),
            "display": display, "unit": unit, "good": good, "kind": kind, "description": desc,
            "detail": detail if available else "", "available": bool(available)}


def _pct(num: int, den: int):
    return (100.0 * num / den) if den else None


# ── The sources ──────────────────────────────────────────────────────────────

def _attendance(db: Session, email: str, start: str, end: str) -> dict:
    import shift_attendance
    out = shift_attendance.actuals(db, [email], start, end)
    t = (out.get("people") or {}).get(email) or {}
    judged = int(t.get("judged") or 0)
    if not judged:
        return {"on_time": _out("on_time"), "no_shows": _out("no_shows")}
    late, missed = int(t.get("late") or 0), int(t.get("noShow") or 0)
    on = max(0, judged - late - missed)
    return {
        "on_time": _out("on_time", _pct(on, judged), detail=f"{on} of {judged} shifts on time"),
        "no_shows": _out("no_shows", missed, detail=f"{missed} of {judged} shifts"),
    }


def _hours(db: Session, email: str, start: str, end: str) -> dict:
    import workforce_scorecard as ws
    cfg = ws.get_settings(db)
    d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    expected = covered = 0
    wk = ws.week_start_for(d0, cfg)
    while wk <= d1:
        rep = ws.build_report(db, {email}, cfg, wk)
        for row in rep.get("people") or []:
            for d in row.get("days") or []:
                if d.get("scored") and start <= d["date"] <= end:
                    expected += int(d.get("expectedMin") or 0)
                    covered += int(d.get("workedMin") or 0) + int(d.get("leaveMin") or 0)
        wk += timedelta(days=7)
    if not expected:
        return {"hours": _out("hours")}
    return {"hours": _out("hours", _pct(covered, expected),
                          detail=f"{covered / 60:.0f} of {expected / 60:.0f} hours")}


def _timesheets(db: Session, email: str, start: str, end: str) -> dict:
    import timesheet_review as tr
    rows = (db.query(models.TimesheetReview)
            .filter(func.lower(models.TimesheetReview.employee_email) == email,
                    models.TimesheetReview.period_end >= start, models.TimesheetReview.period_end <= end,
                    models.TimesheetReview.agreed_at != "").all())
    if not rows:
        return {"timesheets": _out("timesheets")}
    signs = (db.query(models.TimeApproval)
             .filter(func.lower(models.TimeApproval.employee_email) == email,
                     models.TimeApproval.kind == "employee_sign", models.TimeApproval.revoked == 0).all())
    by_period: dict = {}
    for s in signs:
        by_period.setdefault((s.period_start, s.period_end), []).append(s)
    ok = 0
    for r in rows:
        agreed = _parse(r.agreed_at)
        signed = [_parse(s.approved_at) for s in by_period.get((r.period_start, r.period_end), [])]
        signed = [s for s in signed if s is not None]
        if agreed is not None and signed and min(signed) - agreed <= timedelta(days=tr.UNSIGNED_WAIT_DAYS):
            ok += 1
    return {"timesheets": _out("timesheets", _pct(ok, len(rows)), detail=f"{ok} of {len(rows)} signed on time")}


def _tasks(db: Session, email: str, start: str, end: str, today: str) -> dict:
    from routers.task_util import task_assignees
    from task_due import _completed_day
    T = models.Task
    like = f'%"{email}"%'
    rows = (db.query(T)
            .filter(or_(func.lower(T.assignee_email) == email, cast(T.assignee_emails, String).ilike(like)),
                    T.type != "section", or_(T.deleted_at == "", T.deleted_at.is_(None))).all())
    mine = [t for t in rows if email in task_assignees(t)]
    done = [t for t in mine if t.completed and start <= _completed_day(t) <= end]
    open_ = [t for t in mine if not t.completed]
    if not done and not open_:
        return {"tasks_done": _out("tasks_done"), "tasks_on_time": _out("tasks_on_time"),
                "tasks_overdue": _out("tasks_overdue")}
    dated = [t for t in done if (t.due_on or "")[:10]]
    on_time = [t for t in dated if _completed_day(t) <= t.due_on[:10]]
    overdue = [t for t in open_ if (t.due_on or "")[:10] and t.due_on[:10] < today]
    return {
        "tasks_done": _out("tasks_done", len(done), detail=f"{len(done)} finished"),
        "tasks_on_time": (_out("tasks_on_time", _pct(len(on_time), len(dated)),
                               detail=f"{len(on_time)} of {len(dated)} with a due date")
                          if dated else _out("tasks_on_time")),
        "tasks_overdue": _out("tasks_overdue", len(overdue), detail=f"{len(overdue)} of {len(open_)} open"),
    }


def _tickets(db: Session, email: str, start: str, end: str) -> dict:
    from ticket_reports import _Fact
    T = models.TaskTicket
    rows = (db.query(T).filter(func.lower(T.assignee_email) == email,
                               or_(T.deleted_at == "", T.deleted_at.is_(None))).all())
    now = datetime.now(timezone.utc)
    facts = [_Fact(r, now) for r in rows]

    def day(dt) -> str:
        return dt.date().isoformat() if dt is not None else ""

    resolved = [f for f in facts if f.resolved is not None and start <= day(f.resolved) <= end]
    created = [f for f in facts if start <= day(f.created) <= end]
    if not resolved and not created:
        return {"tickets_resolved": _out("tickets_resolved"), "ticket_sla": _out("ticket_sla")}
    judged = [m for m in (f.fr_met(now) for f in created) if m is not None]
    met = sum(1 for m in judged if m)
    return {
        "tickets_resolved": _out("tickets_resolved", len(resolved), detail=f"{len(resolved)} resolved"),
        "ticket_sla": (_out("ticket_sla", _pct(met, len(judged)), detail=f"{met} of {len(judged)} on target")
                       if judged else _out("ticket_sla")),
    }


def _training(db: Session, email: str) -> dict:
    import kb_core
    done = total = 0
    courses = {c.id: c for c in db.query(models.KbCourse).filter(models.KbCourse.status == "published").all()}
    for a in (db.query(models.KbCourseAssignment)
              .filter(func.lower(models.KbCourseAssignment.user_email) == email).all()):
        c = courses.get(a.course_id)
        if c is None:
            continue
        total += 1
        st = kb_core.training_status(db, c, kb_core.progress_of(db, c, email), a.due_date or "")
        done += st.get("status") == "Completed"
    for d in (db.query(models.KbDocument)
              .filter(models.KbDocument.status == "approved", models.KbDocument.require_ack.is_(True)).all()):
        if email not in kb_core.policy_audience_emails(db, d):
            continue
        total += 1
        done += bool(kb_core.signoff_state(db, d, email).get("signed"))
    if not total:
        return {"training": _out("training")}
    return {"training": _out("training", _pct(done, total), detail=f"{done} of {total} complete")}


# Which source computes which keys.
_SOURCES = (
    (("on_time", "no_shows"), "attendance"),
    (("hours",), "hours"),
    (("timesheets",), "timesheets"),
    (("tasks_done", "tasks_on_time", "tasks_overdue"), "tasks"),
    (("tickets_resolved", "ticket_sla"), "tickets"),
    (("training",), "training"),
)
_KEY_SOURCE = {k: s for keys, s in _SOURCES for k in keys}


def _compute(db: Session, source: str, email: str, start: str, end: str, today: str) -> dict:
    if source == "attendance":
        return _attendance(db, email, start, end)
    if source == "hours":
        return _hours(db, email, start, end)
    if source == "timesheets":
        return _timesheets(db, email, start, end)
    if source == "tasks":
        return _tasks(db, email, start, end, today)
    if source == "tickets":
        return _tickets(db, email, start, end)
    return _training(db, email)


def _source(db: Session, source: str, email: str, start: str, end: str, today: str) -> dict:
    key = (source, email, start, end, today)
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_SEC:
            return hit[1]
    try:
        val = _compute(db, source, email, start, end, today)
    except Exception as e:   # noqa: BLE001 - one source failing never blanks the card
        print(f"[perf_metrics] {source} failed for {email}: {type(e).__name__}: {e}")
        keys = [k for k, s in _KEY_SOURCE.items() if s == source]
        return {k: _out(k) for k in keys}
    with _lock:
        _cache[key] = (now, val)
        if len(_cache) > 5000:
            for k in sorted(_cache, key=lambda k: _cache[k][0])[:1000]:
                _cache.pop(k, None)
    return val


def clear_cache() -> None:
    with _lock:
        _cache.clear()


def _clamp(start: str, end: str, today: date) -> tuple:
    d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    if d1 > today:
        d1 = today
    if d0 > d1:
        d0 = d1
    return d0.isoformat(), d1.isoformat()


def metric(db: Session, email: str, key: str, start: str, end: str, today: Optional[date] = None) -> dict:
    """One metric (a Nexus-measured goal reads only its own)."""
    if key not in METRICS:
        raise KeyError(key)
    today = today or local_today()
    email = _low(email)
    s, e = _clamp(start, end, today)
    return _source(db, _KEY_SOURCE[key], email, s, e, today.isoformat())[key]


def scorecard(db: Session, email: str, start: str, end: str, today: Optional[date] = None) -> dict:
    """The person's numbers for [start, end] (inclusive, ISO dates; a period
    running past today is read up to today)."""
    today = today or local_today()
    email = _low(email)
    s, e = _clamp(start, end, today)
    vals: dict = {}
    for _keys, source in _SOURCES:
        vals.update(_source(db, source, email, s, e, today.isoformat()))
    return {"period": {"start": start, "end": end, "readTo": e},
            "metrics": [vals[k] for k in ORDER if k in vals]}


# ── Periods ──────────────────────────────────────────────────────────────────

def month_period(today: date) -> tuple:
    return today.replace(day=1).isoformat(), today.isoformat()


def quarter_period(today: date) -> tuple:
    m = ((today.month - 1) // 3) * 3 + 1
    return today.replace(month=m, day=1).isoformat(), today.isoformat()


def catalog() -> list:
    """What a Nexus-measured goal can be measured by (the goal form)."""
    return [{"key": k, "label": v[0], "unit": v[1], "good": v[2], "kind": v[3], "description": v[4]}
            for k, v in METRICS.items()]


def _parse(s: str) -> Optional[datetime]:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
