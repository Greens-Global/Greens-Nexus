"""Shifts Phase 1 - the schedule meets the clock (Neil, Oct 14 2026).

Two things live here, both built on the one expected-start rule in
shift_expect.py so they agree with the timecard's Late status, the My Team
tile and the Workforce Scorecard:

  1. The NO-SHOW scan (`noshow_scan`, run every minute by `noshow_loop`).
     A published, assigned shift whose person has not clocked in by
     start + grace + the company's `noShowAlertMin` (Shifts settings, 10 by
     default, 0 = that company is off) raises ONE bell per recipient per
     group and day ("Not In Yet: 3 On Austin Crew"), refreshed in place as
     more people miss their start or come in, and ONE email per recipient
     per group-day at the first alert. Recipients are the person's manager
     and the group's schedulers (never the person; the company's HR contact
     only when there is nobody else). When the group-day's set empties -
     everyone clocked in, or the six-hour window after the start passed -
     the bell is closed (actioned) and retitled "All In: ..." with who came
     in late. A person on approved time off, a company holiday, a weather-
     cancelled shift, a removal waiting to be published, or exempt from time
     tracking is never a no-show. Each shift is judged on its OWN zone clock
     (placement zone -> preset zone -> the company's team zone) with the
     grace of its preset, else the company's `defaultGraceMin`.
     `shift_noshow_alerts` is the scan's memory and the record.
     No Teams message: Nexus posts to Teams as a signed-in person
     (weather_watch._post_teams rides a live session), which a minute-by-
     minute attendance scan must not depend on.

  2. ACTUALS (`actuals`): scheduled vs. punched for a range of days, the
     payload behind GET /timeclock/schedule/actuals - one cell per person
     and day with a status (upcoming / in_progress / on_time / late /
     left_early / no_show / excused / exempt), the first in, last out and
     worked minutes from timeclock._day_summaries, and totals per person
     and overall. Late is shift_expect.is_late_at; left early is a clock-out
     more than the company's `leftEarlyMin` before the end once the day is
     over. No pay figure appears anywhere in it.

All DB work is synchronous: the loop runs it in a thread (CLAUDE.md: never
block the event loop), the route is a plain `def`. Never imports
routers.timeclock at module level (timeclock imports this module).
"""
import asyncio
import json
import uuid
from datetime import date, datetime, timedelta, timezone
from html import escape
from typing import Iterable, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

import models
import shift_expect
from app_url import app_url
from database import SessionLocal

SCAN_SEC = 60
NOSHOW_WINDOW_HOURS = 6     # a start older than this is no longer watched
_PUNCH_BEFORE_HOURS = 2     # a clock-in this long before the start still counts for it
_MAX_SHIFT_MIN = 16 * 60    # timeclock's pairing guard: an older open punch is not an open shift
NO_GROUP = "-"


# ── Small helpers ────────────────────────────────────────────────────────

def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    """Punch-table shape: UTC, second precision, no zone marker."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def _parse(s: str) -> Optional[datetime]:
    try:
        return datetime.strptime((s or "")[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _lower(emails: Iterable[str]) -> list:
    return sorted({(e or "").strip().lower() for e in (emails or []) if (e or "").strip()})


def _name(e) -> str:
    if e is None:
        return ""
    return ((getattr(e, "display_name", "") or "").strip()
            or f"{e.first_name or ''} {e.last_name or ''}".strip()
            or (e.work_email or ""))


def _t12(hhmm: str) -> str:
    try:
        h, m = (int(x) for x in (hhmm or "")[:5].split(":"))
    except ValueError:
        return hhmm or ""
    return f"{(h % 12) or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"


def _us(iso: str) -> str:
    try:
        return datetime.strptime((iso or "")[:10], "%Y-%m-%d").strftime("%m/%d/%Y")
    except ValueError:
        return iso or ""


def _clock12(dt_local: datetime) -> str:
    return f"{(dt_local.hour % 12) or 12}:{dt_local.minute:02d} {'AM' if dt_local.hour < 12 else 'PM'}"


def _people(db: Session, emails: Iterable[str] = None) -> dict:
    """{email(lower): NexusEmployee} - everyone (deleted rows are hidden by
    the ORM hook), or just `emails`."""
    q = db.query(models.NexusEmployee)
    if emails is not None:
        emails_l = _lower(emails)
        if not emails_l:
            return {}
        q = q.filter(func.lower(models.NexusEmployee.work_email).in_(emails_l))
    return {(e.work_email or "").lower(): e for e in q.all() if e.work_email}


def _active(e) -> bool:
    return e is not None and (e.status or "active").lower() == "active" and not (e.deleted_at or "")


def _on_books(e) -> bool:
    """Someone who can still be expected at work: not deleted, not offboarded."""
    return e is not None and not (e.deleted_at or "") and (e.status or "active").lower() != "offboarded"


def _is_live(row) -> bool:
    return (getattr(row, "weather_status", "") or "") != "cancelled"


def _is_removing(row) -> bool:
    return bool(getattr(row, "pending_delete", 0) or 0)


def _settings_by_company(db: Session) -> dict:
    """A per-company settings cache: company id -> effective Shifts settings."""
    from routers.shift_requests import get_settings
    cache: dict = {}

    def get(company_id: str) -> dict:
        cid = company_id or ""
        if cid not in cache:
            try:
                cache[cid] = get_settings(db, cid) or {}
            except Exception:   # noqa: BLE001 - settings must never stop a scan
                cache[cid] = {}
        return cache[cid]
    return get


def _int_setting(cfg: dict, key: str, default: int) -> int:
    try:
        return max(0, int(cfg.get(key, default)))
    except (TypeError, ValueError):
        return default


def _presets(db: Session, rows: list) -> dict:
    ids = sorted({r.shift_id for r in rows if r.shift_id})
    if not ids:
        return {}
    return {p.id: p for p in db.query(models.Shift).filter(models.Shift.id.in_(ids)).all()}


def _expect_for(row, presets: dict, cfg: dict) -> dict:
    """The shift_expect-shaped expectation for ONE placed row: its own start,
    end and the grace / zone rule of pick_start (preset grace else the
    company default; placement zone -> preset zone -> company team zone)."""
    preset = presets.get(row.shift_id or "") if row.shift_id else None
    tz = ((getattr(row, "timezone", "") or "").strip()
          or ((preset.timezone or "").strip() if preset is not None else "")
          or str(cfg.get("timeZone") or "").strip() or shift_expect.DEFAULT_TEAM_TZ)
    grace = shift_expect._grace_of(preset, _int_setting(cfg, "defaultGraceMin", shift_expect.DEFAULT_GRACE_MIN))
    return {"start": row.start_hhmm or "09:00", "end": row.end_hhmm or "", "grace": grace, "tz": tz,
            "source": "scheduled", "shiftId": row.shift_id or "", "rowId": row.id or ""}


def _shift_minutes(start: str, end: str) -> int:
    """timeclock._shift_minutes: an end at or before the start runs past midnight."""
    try:
        s = int(start[:2]) * 60 + int(start[3:5])
        e = int(end[:2]) * 60 + int(end[3:5])
    except (TypeError, ValueError, IndexError):
        return 0
    if e == s:
        return 0
    return e - s if e > s else e + 24 * 60 - s


def _paid_minutes(row) -> int:
    """The placement's paid minutes (timeclock._sched_dict's paidMin rule):
    its length less its unpaid break, nothing for a cancelled day."""
    if not _is_live(row):
        return 0
    from routers.timeclock import _acts, _break_for
    brk = _break_for(_acts(row), int(getattr(row, "break_min", 0) or 0))
    return max(0, _shift_minutes(row.start_hhmm or "", row.end_hhmm or "") - brk)


def _end_utc(dd: date, exp: dict) -> Optional[datetime]:
    start = shift_expect.start_utc(dd, exp)
    if start is None:
        return None
    return start + timedelta(minutes=_shift_minutes(exp.get("start") or "", exp.get("end") or ""))


def _leave_dates(db: Session, emails: list, start: str, end: str) -> set:
    """{(email, date)} covered by approved time off inside [start, end]."""
    if not emails:
        return set()
    out = set()
    d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    for r in (db.query(models.TimeOffRequest)
              .filter(func.lower(models.TimeOffRequest.employee_email).in_(emails),
                      models.TimeOffRequest.status == "approved",
                      models.TimeOffRequest.start_date <= end,
                      models.TimeOffRequest.end_date >= start).all()):
        try:
            a, b = date.fromisoformat((r.start_date or "")[:10]), date.fromisoformat((r.end_date or "")[:10])
        except ValueError:
            continue
        a, b = max(a, d0), min(b, d1)
        em = (r.employee_email or "").lower()
        d = a
        while d <= b:
            out.add((em, d.isoformat()))
            d += timedelta(days=1)
    return out


def _holiday_dates(db: Session, people: dict, start: str, end: str) -> dict:
    """{(email, date): holiday name} - the company + country rule, optional
    holidays excluded (the My Team rule)."""
    from routers.timeclock import _company_holidays_for_many
    out = {}
    for em, days in _company_holidays_for_many(db, people, start, end).items():
        for d, h in days.items():
            if (h.get("type") or "mandatory") != "optional":
                out[(em, d)] = h.get("name") or "Company holiday"
    return out


def _exempt(db: Session) -> set:
    from routers.timeclock import time_tracking_exempt_emails
    return time_tracking_exempt_emails(db)


def _schedulers(g) -> list:
    from routers.timeclock import _schedulers as sched
    return sched(g)


# ── No-show scan ─────────────────────────────────────────────────────────

def _scan_dates(now: datetime) -> list:
    d = now.date()
    return [(d - timedelta(days=1)).isoformat(), d.isoformat(), (d + timedelta(days=1)).isoformat()]


def _candidate_rows(db: Session, dates: list) -> list:
    rows = (db.query(models.ScheduledShift)
            .filter(models.ScheduledShift.work_date.in_(dates),
                    models.ScheduledShift.published == 1,
                    models.ScheduledShift.employee_email != "").all())
    return [r for r in rows if _is_live(r) and not _is_removing(r) and (r.employee_email or "").strip()]


def _in_punches(db: Session, emails: list, dates: list, since: datetime, until: datetime) -> dict:
    """{email: [(at_utc, local_date)]} of live clock-ins dated in `dates` or
    stamped inside [since, until]."""
    if not emails:
        return {}
    rows = (db.query(models.TimePunch)
            .filter(func.lower(models.TimePunch.employee_email).in_(emails),
                    models.TimePunch.kind == "in", models.TimePunch.voided == 0,
                    (models.TimePunch.local_date.in_(dates))
                    | ((models.TimePunch.at >= _iso(since)) & (models.TimePunch.at <= _iso(until))))
            .order_by(models.TimePunch.at).all())
    out: dict = {}
    for p in rows:
        t = _parse(p.at)
        if t is not None:
            out.setdefault((p.employee_email or "").lower(), []).append((t, p.local_date or ""))
    return out


def _first_in_for(punches: list, work_date: str, start: datetime, now: datetime) -> Optional[datetime]:
    """The clock-in that counts for a shift: the earliest live 'in' dated
    the work date, or stamped between two hours before the start and now."""
    best = None
    for t, local_date in punches or []:
        if local_date == work_date or (start - timedelta(hours=_PUNCH_BEFORE_HOURS) <= t <= now):
            if best is None or t < best:
                best = t
    return best


def _recipients_for(row, person, people: dict, groups: dict, hr_contacts: dict) -> list:
    """The person's manager plus the group's schedulers (active People rows
    only, never the person); the company's HR contact when nobody else."""
    me = (row.employee_email or "").lower()
    out = []
    mgr = (getattr(person, "manager_email", "") or "").strip().lower()
    if mgr:
        out.append(mgr)
    g = groups.get(row.group_id or "")
    if g is not None:
        out.extend(_schedulers(g))
    out = [e for e in dict.fromkeys(out) if e and e != me and _active(people.get(e))]
    if not out:
        hr = (hr_contacts.get(person.company or "") or "").strip().lower()
        if hr and hr != me and _active(people.get(hr)):
            out = [hr]
    return out


def _bell(db: Session, recipient: str, ref_id: str, title: str, body: str, *, action: dict, company: str,
          priority: int) -> None:
    """One bell per (person, ref_id), refreshed in place while it is still
    open - weather_watch._bell."""
    now = datetime.now(timezone.utc).isoformat()
    row = (db.query(models.NexusNotification)
           .filter(models.NexusNotification.recipient == recipient, models.NexusNotification.ref_id == ref_id,
                   models.NexusNotification.actioned == False)   # noqa: E712 - SQLAlchemy expression
           .order_by(models.NexusNotification.created_at.desc()).first())
    if row is not None:
        row.title, row.body, row.created_at, row.read_by, row.priority = title, body, now, "", priority
        row.action = json.dumps(action)
        return
    db.add(models.NexusNotification(
        id=str(uuid.uuid4()), type="custom_alert", recipient=recipient, title=title, body=body,
        ref_id=ref_id, item_name="", requested_by="", action=json.dumps(action), actioned=False, read_by="",
        company=company or "", created_at=now, priority=priority))


def _close_bell(db: Session, recipient: str, ref_id: str, title: str, body: str) -> bool:
    row = (db.query(models.NexusNotification)
           .filter(models.NexusNotification.recipient == recipient, models.NexusNotification.ref_id == ref_id,
                   models.NexusNotification.actioned == False)   # noqa: E712 - SQLAlchemy expression
           .order_by(models.NexusNotification.created_at.desc()).first())
    if row is None:
        return False
    row.title, row.body, row.actioned, row.priority = title, body, True, 0
    return True


def _ref_id(group_id: str, work_date: str) -> str:
    return f"noshow:{group_id or NO_GROUP}:{work_date}"


def _action(group_id: str, work_date: str) -> dict:
    return {"view": "shifts", "sub": f"schedule:{work_date}:{group_id if group_id != NO_GROUP else ''}"}


def _subject_of(people_lines: list, group_name: str) -> str:
    """'3 On Austin Crew', 'Amy Lee' (one person, no group), '2 People'."""
    n = len(people_lines)
    if group_name:
        return f"{n} On {group_name}"
    if n == 1:
        return people_lines[0]["name"]
    return f"{n} People"


def _line(p: dict) -> str:
    return f"{p['name']} - scheduled {_t12(p['start'])}, {int(p['lateMin'])} min late"


def _email_html(subject: str, work_date: str, lines: list, link: str) -> str:
    items = "".join(f"<li>{escape(ln)}</li>" for ln in lines)
    return (f"<div style=\"font-family:Inter,Segoe UI,Arial,sans-serif;font-size:14px;color:#0f172a\">"
            f"<p style=\"font-size:16px;font-weight:600;margin:0 0 8px\">{escape(subject)}</p>"
            f"<p style=\"margin:0 0 8px\">Not clocked in for {escape(_us(work_date))}:</p>"
            f"<ul style=\"margin:0 0 12px 18px;padding:0\">{items}</ul>"
            f"<p style=\"margin:0 0 12px\">You will not be emailed again for this team and day; the bell in "
            f"Nexus keeps up as people come in.</p>"
            f"<p style=\"margin:0\"><a href=\"{escape(link)}\" style=\"color:#2563eb\">Open the schedule</a></p>"
            f"</div>")


def _send_email(to: str, subject: str, html: str) -> bool:
    """One email, soft-fail (shift_notify._send_emails' shape)."""
    import graph_mail
    if not to or not graph_mail.graph_configured():
        return False
    try:
        graph_mail.send_mail(from_email=graph_mail.DEFAULT_FROM_EMAIL, to=[to], cc=None, subject=subject, html=html)
        return True
    except Exception as e:   # noqa: BLE001 - never fail the scan for one address
        print(f"[shift-attendance] email to {to} failed: {e}")
        return False


def _link(work_date: str, group_id: str) -> str:
    return f"{app_url()}/shifts/schedule:{work_date}:{group_id if group_id != NO_GROUP else ''}"


def noshow_scan(db: Session, now_utc: datetime = None) -> dict:
    """One pass: who should be in and is not, told to whom; what opened and
    what closed. Returns a summary {candidates, noShows, alerts, updated,
    resolved, emails}."""
    now = now_utc or _utcnow()
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    dates = _scan_dates(now)
    rows = _candidate_rows(db, dates)
    open_alerts = (db.query(models.ShiftNoShowAlert)
                   .filter((models.ShiftNoShowAlert.resolved_at == "") | (models.ShiftNoShowAlert.resolved_at.is_(None)))
                   .all())
    summary = {"candidates": len(rows), "noShows": 0, "alerts": 0, "updated": 0, "resolved": 0, "emails": 0}
    if not rows and not open_alerts:
        return summary
    alert_people = set()
    for a in open_alerts:
        try:
            alert_people |= {str(p.get("email") or "").lower() for p in json.loads(a.people_json or "[]")}
        except (TypeError, ValueError):
            pass
    emails = _lower([r.employee_email for r in rows] + list(alert_people))
    people = _people(db)
    exempt = _exempt(db)
    settings = _settings_by_company(db)
    presets = _presets(db, rows)
    groups = {g.id: g for g in db.query(models.ShiftGroup).all()}
    hr_contacts = {e.id: (e.hr_contact_email or "") for e in db.query(models.HrEntity).all()}
    leave = _leave_dates(db, emails, dates[0], dates[-1])
    holidays = _holiday_dates(db, {em: people[em] for em in emails if em in people}, dates[0], dates[-1])
    punches = _in_punches(db, emails, dates, now - timedelta(hours=NOSHOW_WINDOW_HOURS + _PUNCH_BEFORE_HOURS + 24), now)

    # Who is a no-show right now, per (recipient, group-day).
    wanted: dict = {}       # (recipient, group_key, date) -> {email: person line}
    companies: dict = {}    # (group_key, date) -> company for the bell
    for r in rows:
        em = (r.employee_email or "").lower()
        person = people.get(em)
        if not _on_books(person) or em in exempt:
            continue
        if (em, r.work_date) in leave or (em, r.work_date) in holidays:
            continue
        cfg = settings(person.company or "")
        alert_min = _int_setting(cfg, "noShowAlertMin", 0)
        if alert_min <= 0:
            continue
        exp = _expect_for(r, presets, cfg)
        dd = date.fromisoformat(r.work_date)
        start = shift_expect.start_utc(dd, exp)
        if start is None:
            continue
        threshold = start + timedelta(minutes=int(exp["grace"]) + alert_min)
        if now < threshold or now >= start + timedelta(hours=NOSHOW_WINDOW_HOURS):
            continue
        if _first_in_for(punches.get(em), r.work_date, start, now) is not None:
            continue
        gkey = r.group_id or NO_GROUP
        g = groups.get(r.group_id or "")
        group_company = (getattr(g, "company_id", "") or "") if g is not None else ""
        companies.setdefault((gkey, r.work_date), group_company or (person.company or ""))
        late_min = int((now - start).total_seconds() // 60)
        line = {"email": em, "name": _name(person), "start": exp["start"], "lateMin": late_min,
                "startUtc": _iso(start)}
        for rcpt in _recipients_for(r, person, people, groups, hr_contacts):
            bucket = wanted.setdefault((rcpt, gkey, r.work_date), {})
            if em not in bucket or late_min > bucket[em]["lateMin"]:
                bucket[em] = line
    summary["noShows"] = len({em for b in wanted.values() for em in b})

    now_iso = _iso(now)
    by_key = {(a.recipient, a.group_id or NO_GROUP, a.work_date): a for a in open_alerts}
    to_email = []
    # Open or refresh.
    for (rcpt, gkey, work_date), bucket in wanted.items():
        lines = sorted(bucket.values(), key=lambda p: (p["start"], p["name"].lower()))
        g = groups.get(gkey) if gkey != NO_GROUP else None
        gname = (g.name or "") if g is not None else ""
        subject = _subject_of(lines, gname)
        title = f"Not In Yet: {subject}"
        body = "\n".join(_line(p) for p in lines)
        company = companies.get((gkey, work_date), "")
        _bell(db, rcpt, _ref_id(gkey, work_date), title, body,
              action=_action(gkey, work_date), company=company, priority=1)
        a = by_key.get((rcpt, gkey, work_date))
        if a is None:
            a = models.ShiftNoShowAlert(id=str(uuid.uuid4()), group_id=gkey, work_date=work_date, recipient=rcpt,
                                        people_json=json.dumps(lines), first_at=now_iso, last_at=now_iso,
                                        emailed_at="", resolved_at="")
            db.add(a)
            by_key[(rcpt, gkey, work_date)] = a
            summary["alerts"] += 1
        else:
            # Keep everyone this recipient was ever told about (someone who
            # came in is still part of the day's story at resolution).
            try:
                known = {p["email"]: p for p in json.loads(a.people_json or "[]")}
            except (TypeError, ValueError, KeyError):
                known = {}
            for p in lines:
                known[p["email"]] = p
            a.people_json = json.dumps(sorted(known.values(), key=lambda p: (p["start"], p["name"].lower())))
            a.last_at = now_iso
            summary["updated"] += 1
        if not (a.emailed_at or ""):
            a.emailed_at = now_iso
            to_email.append((rcpt, f"Not in yet: {subject} ({_us(work_date)})",
                             _email_html(title, work_date, [_line(p) for p in lines], _link(work_date, gkey))))
    # Resolve what emptied.
    for key, a in list(by_key.items()):
        if key in wanted or (a.resolved_at or ""):
            continue
        rcpt, gkey, work_date = key
        try:
            told = json.loads(a.people_json or "[]")
        except (TypeError, ValueError):
            told = []
        g = groups.get(gkey) if gkey != NO_GROUP else None
        gname = (g.name or "") if g is not None else ""
        came, missed = [], []
        for p in told:
            em = str(p.get("email") or "").lower()
            start = _parse(p.get("startUtc") or "")
            first = _first_in_for(punches.get(em), work_date, start, now) if start is not None else None
            if first is not None:
                zone = shift_expect.zone(_zone_of(rows, em, work_date, presets, settings, people))
                late = max(0, int((first - start).total_seconds() // 60))
                came.append(f"{p.get('name') or em} came in at {_clock12(first.astimezone(zone))}"
                            + (f", {late} min late" if late > 0 else ""))
            else:
                missed.append(f"{p.get('name') or em} did not clock in")
        subject = _subject_of(told, gname) if told else (gname or "Shift")
        if missed:
            title = f"Missed Shift: {subject}"
        else:
            title = f"All In: {gname or (told[0].get('name') if len(told) == 1 else subject)}"
        body = "\n".join(came + missed) or "Nobody is still expected."
        _close_bell(db, rcpt, _ref_id(gkey, work_date), title, body)
        a.resolved_at = now_iso
        summary["resolved"] += 1
    # The record is committed BEFORE anything is sent (weather_watch's rule).
    db.commit()
    for rcpt, subject, html in to_email:
        if _send_email(rcpt, subject, html):
            summary["emails"] += 1
    return summary


def _zone_of(rows: list, em: str, work_date: str, presets: dict, settings, people: dict) -> str:
    """The zone of a person's shift on a day (for the 'came in at' clock)."""
    for r in rows:
        if (r.employee_email or "").lower() == em and r.work_date == work_date:
            person = people.get(em)
            return _expect_for(r, presets, settings((person.company or "") if person else ""))["tz"]
    person = people.get(em)
    return str(settings((person.company or "") if person else "").get("timeZone") or "") or shift_expect.DEFAULT_TEAM_TZ


def _tick() -> dict:
    db = SessionLocal()
    try:
        return noshow_scan(db)
    except Exception as e:   # noqa: BLE001 - a bad row must not kill the loop
        db.rollback()
        print(f"[shift-attendance] no-show scan failed: {e}")
        return {}
    finally:
        db.close()


async def noshow_loop():
    """Started from main.py's lifespan on the elected leader, beside
    weather_watch_loop. The scan is synchronous DB work, so it runs in a
    thread; nothing here touches the event loop."""
    await asyncio.sleep(120)
    while True:
        s = await asyncio.to_thread(_tick)
        if s and (s.get("alerts") or s.get("resolved")):
            print(f"[shift-attendance] {s}")
        await asyncio.sleep(SCAN_SEC)


# ── Actuals ──────────────────────────────────────────────────────────────

STATUSES = ("upcoming", "in_progress", "on_time", "late", "left_early", "no_show", "excused", "exempt")


def _empty_totals() -> dict:
    return {"scheduledMin": 0, "workedMin": 0, "late": 0, "noShow": 0, "leftEarly": 0, "onTime": 0, "judged": 0}


def _open_now(punches: list, now: datetime) -> bool:
    """An open shift right now: the last live punch is a clock-in or a break
    inside the pairing guard (my_team._open_shifts' rule)."""
    if not punches:
        return False
    last = punches[-1]
    if last.kind == "out":
        return False
    t = _parse(last.at)
    return t is not None and 0 <= (now - t).total_seconds() <= _MAX_SHIFT_MIN * 60


def actuals(db: Session, emails: Iterable[str], start: str, end: str, now_utc: datetime = None) -> dict:
    """Scheduled vs. punched for `emails` over [start, end] (YYYY-MM-DD).

    {"cells": {"<email>|<date>": {shiftId, shifts, status, firstIn, lastOut,
    workedMin, scheduledMin, lateMin, earlyMin, excuse}},
     "people": {email: {scheduledMin, workedMin, late, noShow, leftEarly,
    onTime, judged}}, "totals": {the same}}.
    A person with two live shifts on a day is judged on the earliest start
    (pick_start's rule) and the latest end; scheduledMin sums them all."""
    from routers.timeclock import _day_summaries
    now = now_utc or _utcnow()
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    emails_l = _lower(emails)
    out = {"cells": {}, "people": {}, "totals": _empty_totals()}
    if not emails_l:
        return out
    d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    rows = [r for r in (db.query(models.ScheduledShift)
                        .filter(func.lower(models.ScheduledShift.employee_email).in_(emails_l),
                                models.ScheduledShift.work_date >= start,
                                models.ScheduledShift.work_date <= end,
                                models.ScheduledShift.published == 1).all())
            if not _is_removing(r)]
    if not rows:
        return out
    people = _people(db, emails_l)
    exempt = _exempt(db)
    settings = _settings_by_company(db)
    presets = _presets(db, rows)
    leave = _leave_dates(db, emails_l, start, end)
    holidays = _holiday_dates(db, people, start, end)
    by_day: dict = {}
    for r in rows:
        by_day.setdefault(((r.employee_email or "").lower(), r.work_date), []).append(r)
    punch_rows = (db.query(models.TimePunch)
                  .filter(func.lower(models.TimePunch.employee_email).in_(emails_l),
                          models.TimePunch.voided == 0,
                          models.TimePunch.local_date >= (d0 - timedelta(days=1)).isoformat(),
                          models.TimePunch.local_date <= (d1 + timedelta(days=1)).isoformat())
                  .order_by(models.TimePunch.at, models.TimePunch.created_at).all())
    punches: dict = {}
    for p in punch_rows:
        punches.setdefault((p.employee_email or "").lower(), []).append(p)
    summaries = {em: _day_summaries(ps) for em, ps in punches.items()}

    for (em, work_date), day_rows in sorted(by_day.items()):
        person = people.get(em)
        cfg = settings((person.company or "") if person else "")
        cell = {"shiftId": "", "shifts": len(day_rows), "status": "upcoming", "firstIn": "", "lastOut": "",
                "workedMin": 0, "scheduledMin": sum(_paid_minutes(r) for r in day_rows),
                "lateMin": 0, "earlyMin": 0, "excuse": ""}
        s = summaries.get(em, {}).get(work_date) or {}
        cell["firstIn"], cell["lastOut"], cell["workedMin"] = s.get("firstIn", ""), s.get("lastOut", ""), int(s.get("workedMin", 0) or 0)
        dd = date.fromisoformat(work_date)
        exp = shift_expect.pick_start(day_rows, presets, "", dd, str(cfg.get("timeZone") or ""),
                                      _int_setting(cfg, "defaultGraceMin", shift_expect.DEFAULT_GRACE_MIN))
        live = [r for r in day_rows if _is_live(r)]
        if exp is not None:
            cell["shiftId"] = exp["rowId"]
            # The latest end among the live placements is the one to stay for.
            exp["end"] = max(live, key=lambda r: _shift_minutes(exp["start"], r.end_hhmm or "")).end_hhmm or ""
        judged = False
        if em in exempt:
            cell["status"] = "exempt"
        elif exp is None:
            cell["status"], cell["excuse"] = "excused", "weather"
        elif (em, work_date) in leave:
            cell["status"], cell["excuse"] = "excused", "time_off"
        elif (em, work_date) in holidays:
            cell["status"], cell["excuse"] = "excused", "holiday"
        else:
            tz = shift_expect.zone(exp["tz"])
            today = now.astimezone(tz).date()
            start_utc = shift_expect.start_utc(dd, exp)
            end_utc = _end_utc(dd, exp)
            threshold = start_utc + timedelta(minutes=int(exp["grace"]) + _int_setting(cfg, "noShowAlertMin", 0))
            open_now = _open_now(punches.get(em), now)
            running = dd == today and (now < end_utc or open_now)
            late = shift_expect.is_late_at(cell["firstIn"], dd, exp)
            if cell["firstIn"]:
                first = _parse(cell["firstIn"])
                if late and first is not None:
                    cell["lateMin"] = max(0, int((first - start_utc).total_seconds() // 60))
            if dd > today:
                cell["status"] = "upcoming"
            elif not s:
                if dd < today or now >= threshold:
                    cell["status"], judged = "no_show", True
                elif now >= start_utc:
                    cell["status"] = "in_progress"
                else:
                    cell["status"] = "upcoming"
            elif running:
                cell["status"] = "in_progress"
            else:
                judged = True
                last = _parse(cell["lastOut"]) if cell["lastOut"] else None
                early_min = _int_setting(cfg, "leftEarlyMin", 15)
                if last is not None and end_utc is not None and last < end_utc - timedelta(minutes=early_min):
                    cell["earlyMin"] = int((end_utc - last).total_seconds() // 60)
                cell["status"] = "late" if late else "left_early" if cell["earlyMin"] else "on_time"
        out["cells"][f"{em}|{work_date}"] = cell
        tot = out["people"].setdefault(em, _empty_totals())
        if cell["status"] in ("upcoming", "exempt", "excused"):
            continue
        for t in (tot, out["totals"]):
            t["scheduledMin"] += cell["scheduledMin"]
            t["workedMin"] += cell["workedMin"]
            if cell["status"] == "no_show":
                t["noShow"] += 1
            if cell["lateMin"] > 0:
                t["late"] += 1
            if cell["earlyMin"] > 0:
                t["leftEarly"] += 1
            if cell["status"] == "on_time":
                t["onTime"] += 1
            if judged:
                t["judged"] += 1
    return out
