"""A break that never ended (Neil's Time Clock audit, Oct 20 2026).

Someone who punched Start Break and never punched back in heard nothing: the
long-session nudge (timeclock_watch.py) waits 12 hours, and the timecard only
flags the break (long_break / missing_break_end) after the fact. Every five
minutes, inside overtime_watch's loop (in a thread), this looks at the people
whose newest punch in a running shift is a break_start:

  - EMPLOYEE: once the break has been open `breakNudgeMin` minutes (Shifts
    settings, per company, 60 by default, 0 = off) - one bell, "Still on
    Break?", keyed on the break punch (`break_open:<punch id>`), so a second
    tick or a restart never repeats it. Resolved in place when the break
    ends (punched back in, punched out, or the break fixed / voided).
  - MANAGER: at twice that - one rollup per recipient per work day
    (`break_long:<date>`, the no-show bell's pattern: the person's manager
    and Backup Manager, the company's HR contact only when nobody else),
    listing everyone still out, refreshed in place (quietly while the names
    are the same) and resolved when everyone is back.

Who, consistent with overtime_watch.py: active people only, never anyone on
fixed (monthly) pay, never anyone exempt from time tracking. Times are on
the employee's own clock (the break punch's offset), 12-hour.

Never imports routers.timeclock at module level (it is a large router).
"""
from datetime import datetime, timedelta, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

import models
from database import SessionLocal
from notify_rollup import resolve_rollup, upsert_rollup

DEFAULT_NUDGE_MIN = 60
EMP_PREFIX = "break_open:"
MGR_PREFIX = "break_long:"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _parse(s: str):
    try:
        return datetime.strptime((s or "")[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _hm(minutes: int) -> str:
    m = max(0, int(minutes or 0))
    return f"{m // 60}h {m % 60}m" if m >= 60 else f"{m}m"


def nudge_min(cfg: dict) -> int:
    try:
        return min(240, max(0, int(cfg.get("breakNudgeMin", DEFAULT_NUDGE_MIN))))
    except (TypeError, ValueError):
        return DEFAULT_NUDGE_MIN


def _local_clock(at: datetime, tz_offset_min: int) -> str:
    from shift_attendance import _clock12
    return _clock12(at.replace(tzinfo=None) - timedelta(minutes=tz_offset_min or 0))


def _open_rows(db: Session, prefix: str) -> dict:
    """{(recipient, ref key): notice} for every OPEN notice of this kind."""
    return {((n.recipient or "").lower(), n.ref_id): n for n in
            db.query(models.NexusNotification)
            .filter(models.NexusNotification.ref_id.like(f"{prefix}%"),
                    models.NexusNotification.type == "custom_alert",
                    models.NexusNotification.actioned == False).all()}   # noqa: E712


def _written(db: Session, keys: list) -> set:
    """{(recipient, key)} already written for these keys - any state."""
    if not keys:
        return set()
    return {((n.recipient or "").lower(), n.ref_id) for n in
            db.query(models.NexusNotification.recipient, models.NexusNotification.ref_id)
            .filter(models.NexusNotification.ref_id.in_(keys)).all()}


def _names(body: str) -> set:
    return {ln.split(" - ")[0] for ln in (body or "").split("\n") if ln and not ln.startswith("+ ")}


def break_scan(db: Session, now_utc: datetime = None) -> dict:
    """One pass. Returns {onBreak, nudged, escalated, resolved}."""
    from overtime_watch import open_shifts
    from routers.timeclock import _timecard_action, time_tracking_exempt_emails
    from shift_attendance import _active, _name, _people, _recipient_people, _recipients_for
    from shift_rules import config_for

    now = now_utc or _utcnow()
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    summary = {"onBreak": 0, "nudged": 0, "escalated": 0, "resolved": 0}
    on_break = {em: last for em, (last, _opened) in open_shifts(db, now).items() if last.kind == "break_start"}
    summary["onBreak"] = len(on_break)

    due_emp, groups, people = {}, {}, {}   # email -> (punch, minutes, threshold); (recipient, key) -> rows
    if on_break:
        conf = config_for(db, list(on_break))
        exempt = time_tracking_exempt_emails(db)
        fixed = {(r.employee_email or "").lower() for r in
                 db.query(models.PayrollRate.employee_email)
                 .filter(func.lower(models.PayrollRate.employee_email).in_(list(on_break)),
                         models.PayrollRate.pay_type == "fixed").all()}
        people = _people(db, list(on_break))
        for em, p in on_break.items():
            if em in exempt or em in fixed or not _active(people.get(em)):
                continue
            limit = nudge_min((conf.get(em) or ({}, ""))[0])
            t = _parse(p.at)
            if not limit or t is None:
                continue
            mins = int((now - t).total_seconds() // 60)
            if mins >= limit:
                due_emp[em] = (p, mins, limit)
        late = {em: v for em, v in due_emp.items() if v[1] >= 2 * v[2]}
        if late:
            company_ids = sorted({people[em].company for em in late if people[em].company})
            hr_contacts = ({e.id: (e.hr_contact_email or "") for e in
                            db.query(models.HrEntity).filter(models.HrEntity.id.in_(company_ids)).all()}
                           if company_ids else {})
            _recipient_people(db, people, {}, hr_contacts)
            for em, (p, mins, _limit) in sorted(late.items(), key=lambda kv: -kv[1][1]):
                name = _name(people[em]) or em
                line = (f"{name} - on break since {_local_clock(_parse(p.at), p.tz_offset_min)} "
                        f"({_hm(mins)})")
                for r in _recipients_for("", people[em], people, {}, hr_contacts):
                    groups.setdefault((r, f"{MGR_PREFIX}{p.local_date or ''}"), []).append((em, p, line))

    # Employee: one bell per open break, never repeated.
    keys = {em: f"{EMP_PREFIX}{v[0].id}" for em, v in due_emp.items()}
    written = _written(db, list(keys.values()))
    for em, (p, _mins, _limit) in due_emp.items():
        if (em, keys[em]) in written:
            continue
        upsert_rollup(db, recipient=em, key=keys[em], title="Still on Break?",
                      line=(f"Your break started at {_local_clock(_parse(p.at), p.tz_offset_min)}. "
                            "Still on break? Punch back in, or fix it on your Time Sheet."),
                      action={"view": "timeclock", "kind": "break_open"},
                      company=getattr(people.get(em), "company", "") or "", priority=0)
        summary["nudged"] += 1
    open_ids = {p.id for p in on_break.values()}
    for (rcpt, key) in _open_rows(db, EMP_PREFIX):
        if key[len(EMP_PREFIX):] not in open_ids:
            resolve_rollup(db, recipient=rcpt, key=key, title="Back From Break", line="Your break has ended.")
            summary["resolved"] += 1

    # Manager: one rollup per recipient per work day, rewritten in place.
    open_mgr = _open_rows(db, MGR_PREFIX)
    for (rcpt, key), rows in groups.items():
        lines = [ln for _em, _p, ln in rows]
        names = {ln.split(" - ")[0] for ln in lines}
        row = open_mgr.get((rcpt, key))
        fresh = row is None or _names(row.body) != names
        first_em, first_p, _ = rows[0]
        title = (f"Long Break - {lines[0].split(' - ')[0]}" if len(rows) == 1
                 else f"Long Breaks - {len(rows)} People")
        upsert_rollup(db, recipient=rcpt, key=key, title=title, line="\n".join(lines),
                      action={**_timecard_action(db, first_em, first_p.local_date or ""), "kind": "break_long"},
                      company=getattr(people.get(first_em), "company", "") or "", replace=True,
                      quiet=not fresh, priority=0, open_only=True)
        if fresh:
            summary["escalated"] += 1
    for (rcpt, key) in open_mgr:
        if (rcpt, key) not in groups:
            resolve_rollup(db, recipient=rcpt, key=key, title="Back From Break",
                           line="Everyone on this list is back from break.")
            summary["resolved"] += 1
    db.commit()
    return summary


def tick() -> dict:
    db = SessionLocal()
    try:
        return break_scan(db)
    except Exception as e:   # noqa: BLE001 - a bad row must not kill the loop
        db.rollback()
        print(f"[break-watch] scan failed: {e}")
        return {}
    finally:
        db.close()
