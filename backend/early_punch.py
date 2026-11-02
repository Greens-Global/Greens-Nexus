"""Early punch alert (Neil, 11/02/2026 - a Homebase lift).

A clock-in more than `earlyPunchAlertMin` minutes (Settings > Shifts &
Scheduling > Attendance, per company, 0 = off) before the person's expected
start tells their manager. The punch is ALWAYS recorded - this module only
reports; it never refuses, trims or moves a punch (Neil: never block a
punch), and the three punch writers in routers/timeclock.py call it inside a
try/except so nothing here can fail a request.

The expected start is the ONE rule in shift_expect.py (the earliest live
placement that day, else the usual-hours preset); a person with no expected
start (no shift, no preset, a weather-cancelled day) never alerts. A leave
punch (Sick / PTO category) is not a clock-in.

One rollup bell per team and day (`earlyin:<group id or ->:<date>`) to the
same people the no-show bell goes to (shift_attendance._recipients_for: the
manager, the backup manager, the group's schedulers; the company's HR
contact only when there is nobody else), rewritten in place as a second
person punches early - never one bell per punch. The body is recomputed from
the day's punches so it always reads whole: "Amy Lee punched in 25 min before
their 7:00 AM shift." / "2 people punched in early: Amy Lee (25 min), Bob X
(20 min).". A shift with no group (usual hours) tells each recipient about
their own reports who punched early that day.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

import models
import shift_expect
from notify_rollup import upsert_rollup
from shift_attendance import _leave_class, _name, _people, _recipients_for, _settings_by_company, _t12

SETTING = "earlyPunchAlertMin"
NO_GROUP = "-"


def _parse(s: str) -> Optional[datetime]:
    try:
        return datetime.strptime((s or "")[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _threshold(cfg: dict) -> int:
    try:
        return max(0, int(cfg.get(SETTING, 0) or 0))
    except (TypeError, ValueError):
        return 0


def _minutes_early(dd: date, exp: Optional[dict], at: Optional[datetime]) -> Optional[int]:
    start = shift_expect.start_utc(dd, exp)
    if start is None or at is None:
        return None
    return int((start - at).total_seconds() // 60)


def _group_of(db: Session, exp: Optional[dict]) -> str:
    """The team the expected shift belongs to ('' for a preset / usual hours)."""
    rid = (exp or {}).get("rowId") or ""
    if not rid:
        return ""
    row = db.query(models.ScheduledShift.group_id).filter(models.ScheduledShift.id == rid).first()
    return (row[0] if row else "") or ""


def _first_in_punches(db: Session, emails: list, work_date: str) -> dict:
    """{email: earliest live clock-in that day that is not a leave punch}."""
    out: dict = {}
    if not emails:
        return out
    rows = (db.query(models.TimePunch)
            .filter(func.lower(models.TimePunch.employee_email).in_(emails),
                    models.TimePunch.local_date == work_date, models.TimePunch.kind == "in",
                    models.TimePunch.voided == 0)
            .order_by(models.TimePunch.at.asc()).all())
    for p in rows:
        em = (p.employee_email or "").lower()
        if em in out or _leave_class(p.category or ""):
            continue
        out[em] = p
    return out


def _early_people(db: Session, emails: list, dd: date, settings) -> list:
    """[{email, name, minutes, start}] - everyone in `emails` whose first
    clock-in on `dd` came more than their company's window before their
    expected start, most minutes first."""
    emails = sorted({(e or "").strip().lower() for e in emails if (e or "").strip()})
    if not emails:
        return []
    exps = shift_expect.expected_starts(db, emails, dd)
    punches = _first_in_punches(db, emails, dd.isoformat())
    people = _people(db, emails)
    out = []
    for em in emails:
        p, exp, person = punches.get(em), exps.get(em), people.get(em)
        if p is None or not exp or person is None:
            continue
        thr = _threshold(settings(person.company or ""))
        if thr <= 0:
            continue
        mins = _minutes_early(dd, exp, _parse(p.at))
        if mins is None or mins <= thr:
            continue
        out.append({"email": em, "name": _name(person), "minutes": mins, "start": exp.get("start") or ""})
    out.sort(key=lambda x: (-x["minutes"], x["name"]))
    return out


def _words(early: list) -> tuple:
    """(title, body) for the bell."""
    if len(early) == 1:
        p = early[0]
        return ("Early Punch Today",
                f"{p['name']} punched in {p['minutes']} min before their {_t12(p['start'])} shift.")
    names = ", ".join(f"{p['name']} ({p['minutes']} min)" for p in early)
    return "Early Punches Today", f"{len(early)} people punched in early: {names}."


def _reports_of(db: Session, recipient: str) -> list:
    """The people whose manager or backup manager is `recipient` (the scope of
    a usual-hours bell, which has no team to list)."""
    r = (recipient or "").lower()
    rows = (db.query(models.NexusEmployee.work_email)
            .filter((func.lower(models.NexusEmployee.manager_email) == r) |
                    (func.lower(models.NexusEmployee.backup_manager_email) == r)).all())
    return [(e[0] or "").lower() for e in rows if e[0]]


def check(db: Session, row, emp) -> Optional[dict]:
    """Judge the just-added clock-in `row` (flushed, so it is in the day's
    punches) for `emp`. Returns {"minutesEarly", "expectedStart"} and
    writes the bell when it is early past the company's window; None
    otherwise (off, not a clock-in, a leave punch, no expected start,
    inside the window). Never raises for want of data."""
    if row is None or emp is None or (row.kind or "") != "in":
        return None
    if _leave_class(getattr(row, "category", "") or ""):
        return None
    settings = _settings_by_company(db)
    thr = _threshold(settings(emp.company or ""))
    if thr <= 0:
        return None
    try:
        dd = date.fromisoformat((row.local_date or "")[:10])
    except ValueError:
        return None
    email = (emp.work_email or row.employee_email or "").lower()
    exp = shift_expect.expected_start(db, email, dd)
    mins = _minutes_early(dd, exp, _parse(row.at))
    if mins is None or mins <= thr:
        return None
    gid = _group_of(db, exp)
    _alert(db, emp, dd, gid, settings)
    return {"minutesEarly": mins, "expectedStart": exp.get("start") or ""}


def _alert(db: Session, emp, dd: date, gid: str, settings) -> None:
    me = (emp.work_email or "").lower()
    group = db.query(models.ShiftGroup).filter(models.ShiftGroup.id == gid).first() if gid else None
    groups = {gid: group} if group is not None else {}
    hr_contacts = {}
    if emp.company:
        ent = db.query(models.HrEntity).filter(models.HrEntity.id == emp.company).first()
        hr_contacts[emp.company] = (getattr(ent, "hr_contact_email", "") or "") if ent else ""
    candidates = [emp.manager_email or "", getattr(emp, "backup_manager_email", "") or ""]
    if group is not None:
        from routers.timeclock import _schedulers
        candidates += _schedulers(group)
    candidates += [e.strip() for e in (hr_contacts.get(emp.company or "") or "").split(",") if e.strip()]
    people = _people(db, [c for c in candidates if c])
    recipients = _recipients_for(gid, emp, people, groups, hr_contacts)
    if not recipients:
        return
    members = []
    if gid:
        members = [(m.employee_email or "").lower() for m in
                   db.query(models.ShiftGroupMember).filter(models.ShiftGroupMember.group_id == gid).all()
                   if m.employee_email]
    work_date = dd.isoformat()
    key = f"earlyin:{gid or NO_GROUP}:{work_date}"
    action = {"view": "shifts", "sub": f"schedule:{work_date}:{gid}", "kind": "early_punch"}
    for recipient in recipients:
        scope = list(members) if gid else _reports_of(db, recipient)
        if me not in scope:
            scope.append(me)

        def _say(scope=scope):
            # Built once the notice row is locked (notify_rollup `words`),
            # so a second early punch that landed while we waited is in
            # the body too - two requests racing never lose each other.
            early = _early_people(db, scope, dd, settings)
            if not any(p["email"] == me for p in early):
                return None   # the window moved under us - nothing to say for this reader
            return _words(early)

        upsert_rollup(db, recipient=recipient, key=key, words=_say, action=action,
                      company=emp.company or "", requested_by=me, replace=True, open_only=True)


__all__ = ["check", "SETTING"]
