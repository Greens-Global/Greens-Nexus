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
# Every source takes the WHOLE set of people at once (a manager's team, the
# owners on a goal list) and answers {email: {metric key: metric}} - the
# engines underneath already take email sets, so a team of 20 is one pass,
# not 20. One person is the same call with one email: the numbers are
# identical by construction.

_JUDGED = ("on_time", "left_early", "late", "no_show")


def _attendance(db: Session, emails: list, start: str, end: str, today: str) -> dict:
    """From the Shifts engine's own per-day cells (shift_attendance.actuals).
    Arrived on time = On Time or Left Early (both started on time); judged =
    those plus Late and No-Show. A day still running, upcoming, exempt or
    excused is not judged, and neither is a shift sitting over approved time
    off - time off is never a metric (Neil, spec)."""
    import shift_attendance
    out = shift_attendance.actuals(db, emails, start, end)
    tally = {e: {"on": 0, "judged": 0, "missed": 0} for e in emails}
    for key, cell in (out.get("cells") or {}).items():
        em = key.split("|")[0]
        t = tally.get(em)
        if t is None or cell.get("over") == "time_off" or cell.get("status") not in _JUDGED:
            continue
        t["judged"] += 1
        t["on"] += cell["status"] in ("on_time", "left_early")
        t["missed"] += cell["status"] == "no_show"
    res = {}
    for em, t in tally.items():
        if not t["judged"]:
            res[em] = {"on_time": _out("on_time"), "no_shows": _out("no_shows")}
            continue
        res[em] = {
            "on_time": _out("on_time", _pct(t["on"], t["judged"]), detail=f"{t['on']} of {t['judged']} shifts on time"),
            "no_shows": _out("no_shows", t["missed"], detail=f"{t['missed']} of {t['judged']} shifts"),
        }
    return res


def _hours(db: Session, emails: list, start: str, end: str, today: str) -> dict:
    import workforce_scorecard as ws
    cfg = ws.get_settings(db)
    d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    tot = {e: [0, 0] for e in emails}
    wk = ws.week_start_for(d0, cfg)
    while wk <= d1:
        rep = ws.build_report(db, set(emails), cfg, wk)
        for row in rep.get("people") or []:
            t = tot.get((row.get("email") or "").lower())
            if t is None and len(emails) == 1:
                t = tot[emails[0]]
            if t is None:
                continue
            for d in row.get("days") or []:
                if d.get("scored") and start <= d["date"] <= end:
                    t[0] += int(d.get("expectedMin") or 0)
                    t[1] += int(d.get("workedMin") or 0) + int(d.get("leaveMin") or 0)
        wk += timedelta(days=7)
    res = {}
    for em, (expected, covered) in tot.items():
        res[em] = {"hours": _out("hours", _pct(covered, expected), detail=f"{covered / 60:.0f} of {expected / 60:.0f} hours")
                   if expected else _out("hours")}
    return res


def _timesheets(db: Session, emails: list, start: str, end: str, today: str) -> dict:
    """Signed within UNSIGNED_WAIT_DAYS of when the card last went out to
    sign (timesheet_review._waiting_since - the newest approval, HR change or
    re-sign round), for periods ending in the range. Counted: every signed
    (completed) period, plus a card still unsigned past the wait - that one
    is late. A card that went out yesterday is not counted yet."""
    import timesheet_review as tr
    wait = timedelta(days=tr.UNSIGNED_WAIT_DAYS)
    now = datetime.now(timezone.utc)
    rows = (db.query(models.TimesheetReview)
            .filter(func.lower(models.TimesheetReview.employee_email).in_(emails),
                    models.TimesheetReview.period_end >= start, models.TimesheetReview.period_end <= end).all())
    signs = (db.query(models.TimeApproval)
             .filter(func.lower(models.TimeApproval.employee_email).in_(emails),
                     models.TimeApproval.kind == "employee_sign", models.TimeApproval.revoked == 0).all())
    signed: dict = {}
    for s in signs:
        k = ((s.employee_email or "").lower(), s.period_start, s.period_end)
        at = _parse(s.approved_at)
        if at is not None and (k not in signed or at > signed[k]):
            signed[k] = at
    tally = {e: [0, 0] for e in emails}
    for r in rows:
        em = (r.employee_email or "").lower()
        out_at = _parse(tr._waiting_since(r))
        if out_at is None or em not in tally:
            continue
        if r.status == "completed":
            at = signed.get((em, r.period_start, r.period_end))
            tally[em][1] += 1
            tally[em][0] += bool(at is not None and at >= out_at - timedelta(minutes=1) and at - out_at <= wait)
        elif r.status in ("approved", "signing", "correcting") and now - out_at > wait:
            tally[em][1] += 1      # still unsigned past the wait: late
    return {em: {"timesheets": _out("timesheets", _pct(ok, n), detail=f"{ok} of {n} signed on time") if n else _out("timesheets")}
            for em, (ok, n) in tally.items()}


def _tasks(db: Session, emails: list, start: str, end: str, today: str) -> dict:
    from routers.task_util import task_assignees
    from task_due import _completed_day
    T = models.Task
    want = set(emails)
    q = db.query(T).filter(T.type != "section", or_(T.deleted_at == "", T.deleted_at.is_(None)),
                           or_(T.completed == False, T.completed_at >= start))   # noqa: E712
    if len(emails) == 1:
        q = q.filter(or_(func.lower(T.assignee_email) == emails[0], cast(T.assignee_emails, String).ilike(f'%"{emails[0]}"%')))
    by: dict = {e: [] for e in emails}
    for t in q.all():
        for em in set(task_assignees(t)) & want:
            by[em].append(t)
    res = {}
    for em, mine in by.items():
        done = [t for t in mine if t.completed and start <= _completed_day(t) <= end]
        open_ = [t for t in mine if not t.completed]
        if not done and not open_:
            res[em] = {"tasks_done": _out("tasks_done"), "tasks_on_time": _out("tasks_on_time"),
                       "tasks_overdue": _out("tasks_overdue")}
            continue
        dated = [t for t in done if (t.due_on or "")[:10]]
        on_time = [t for t in dated if _completed_day(t) <= t.due_on[:10]]
        overdue = [t for t in open_ if (t.due_on or "")[:10] and t.due_on[:10] < today]
        res[em] = {
            "tasks_done": _out("tasks_done", len(done), detail=f"{len(done)} finished"),
            "tasks_on_time": (_out("tasks_on_time", _pct(len(on_time), len(dated)),
                                   detail=f"{len(on_time)} of {len(dated)} with a due date")
                              if dated else _out("tasks_on_time")),
            "tasks_overdue": _out("tasks_overdue", len(overdue), detail=f"{len(overdue)} of {len(open_)} open"),
        }
    return res


def _tickets(db: Session, emails: list, start: str, end: str, today: str) -> dict:
    from ticket_reports import _Fact
    T = models.TaskTicket
    rows = (db.query(T).filter(func.lower(T.assignee_email).in_(emails),
                               or_(T.deleted_at == "", T.deleted_at.is_(None))).all())
    now = datetime.now(timezone.utc)
    by: dict = {e: [] for e in emails}
    for r in rows:
        em = (r.assignee_email or "").lower()
        if em in by:
            by[em].append(_Fact(r, now))

    def day(dt) -> str:
        return dt.date().isoformat() if dt is not None else ""

    res = {}
    for em, facts in by.items():
        resolved = [f for f in facts if f.resolved is not None and start <= day(f.resolved) <= end]
        created = [f for f in facts if start <= day(f.created) <= end]
        if not resolved and not created:
            res[em] = {"tickets_resolved": _out("tickets_resolved"), "ticket_sla": _out("ticket_sla")}
            continue
        judged = [m for m in (f.fr_met(now) for f in created) if m is not None]
        met = sum(1 for m in judged if m)
        res[em] = {
            "tickets_resolved": _out("tickets_resolved", len(resolved), detail=f"{len(resolved)} resolved"),
            "ticket_sla": (_out("ticket_sla", _pct(met, len(judged)), detail=f"{met} of {len(judged)} on target")
                           if judged else _out("ticket_sla")),
        }
    return res


def _training(db: Session, emails: list, start: str, end: str, today: str) -> dict:
    """Assigned published courses complete, and required policies signed -
    the courses, the policies and their audiences read ONCE for everyone."""
    import kb_core
    tally = {e: [0, 0] for e in emails}
    courses = {c.id: c for c in db.query(models.KbCourse).filter(models.KbCourse.status == "published").all()}
    assigns = (db.query(models.KbCourseAssignment)
               .filter(func.lower(models.KbCourseAssignment.user_email).in_(emails)).all())
    progress = {((p.user_email or "").lower(), p.course_id): p for p in db.query(models.KbCourseProgress)
                .filter(func.lower(models.KbCourseProgress.user_email).in_(emails)).all()}
    for a in assigns:
        em, c = (a.user_email or "").lower(), courses.get(a.course_id)
        if c is None or em not in tally:
            continue
        tally[em][1] += 1
        tally[em][0] += kb_core.training_status(db, c, progress.get((em, c.id)), a.due_date or "").get("status") == "Completed"
    for d in (db.query(models.KbDocument)
              .filter(models.KbDocument.status == "approved", models.KbDocument.require_ack.is_(True)).all()):
        audience = kb_core.policy_audience_emails(db, d)
        for em in emails:
            if em in audience:
                tally[em][1] += 1
                tally[em][0] += bool(kb_core.signoff_state(db, d, em).get("signed"))
    return {em: {"training": _out("training", _pct(ok, n), detail=f"{ok} of {n} complete") if n else _out("training")}
            for em, (ok, n) in tally.items()}


# Which source computes which keys.
# (By name, read at call time - so a test can stand one in.)
_SOURCES = (
    (("on_time", "no_shows"), "_attendance"),
    (("hours",), "_hours"),
    (("timesheets",), "_timesheets"),
    (("tasks_done", "tasks_on_time", "tasks_overdue"), "_tasks"),
    (("tickets_resolved", "ticket_sla"), "_tickets"),
    (("training",), "_training"),
)
_KEY_SOURCE = {k: name for keys, name in _SOURCES for k in keys}
_SOURCE_KEYS = {name: keys for keys, name in _SOURCES}


def _many(db: Session, name: str, emails: list, start: str, end: str, today: str) -> dict:
    """{email: values} for one source, from the 10-minute memory where it
    has them and ONE batched call for everyone else."""
    fn = globals()[name]
    now = time.monotonic()
    out, missing = {}, []
    with _lock:
        for em in emails:
            hit = _cache.get((name, em, start, end, today))
            if hit and now - hit[0] < CACHE_SEC:
                out[em] = hit[1]
            else:
                missing.append(em)
    if not missing:
        return out
    try:
        got = fn(db, missing, start, end, today)
    except Exception as e:   # noqa: BLE001 - one source failing never blanks the card
        print(f"[perf_metrics] {name} failed for {len(missing)}: {type(e).__name__}: {e}")
        blank = {k: _out(k) for k in _SOURCE_KEYS[name]}
        return {**out, **{em: blank for em in missing}}
    with _lock:
        for em in missing:
            _cache[(name, em, start, end, today)] = (now, got[em])
        if len(_cache) > 5000:
            for k in sorted(_cache, key=lambda k: _cache[k][0])[:1000]:
                _cache.pop(k, None)
    out.update({em: got[em] for em in missing})
    return out


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


def _emails(emails) -> list:
    return sorted({_low(e) for e in emails if _low(e)})


def metric(db: Session, email: str, key: str, start: str, end: str, today: Optional[date] = None) -> dict:
    """One metric (a Nexus-measured goal reads only its own)."""
    if key not in METRICS:
        raise KeyError(key)
    today = today or local_today()
    email = _low(email)
    s, e = _clamp(start, end, today)
    return _many(db, _KEY_SOURCE[key], [email], s, e, today.isoformat())[email][key]


def prefetch(db: Session, emails, keys, start: str, end: str, today: Optional[date] = None) -> None:
    """Warm the memory for several people's `keys` over one period in one
    pass per source (a goal list, before each goal reads its own number)."""
    today = today or local_today()
    ems = _emails(emails)
    if not ems:
        return
    s, e = _clamp(start, end, today)
    for name in {_KEY_SOURCE[k] for k in keys if k in _KEY_SOURCE}:
        _many(db, name, ems, s, e, today.isoformat())


def scorecards(db: Session, emails, start: str, end: str, today: Optional[date] = None) -> dict:
    """{email: scorecard} for several people over one period - one batched
    pass per source."""
    today = today or local_today()
    ems = _emails(emails)
    s, e = _clamp(start, end, today)
    vals = {em: {} for em in ems}
    if ems:
        for _keys, name in _SOURCES:
            for em, v in _many(db, name, ems, s, e, today.isoformat()).items():
                vals[em].update(v)
    return {em: {"period": {"start": start, "end": end, "readTo": e},
                 "metrics": [vals[em][k] for k in ORDER if k in vals[em]]} for em in ems}


def scorecard(db: Session, email: str, start: str, end: str, today: Optional[date] = None) -> dict:
    """The person's numbers for [start, end] (inclusive, ISO dates; a period
    running past today is read up to today)."""
    return scorecards(db, [email], start, end, today)[_low(email)]


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
