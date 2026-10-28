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
     in late - "Came In Late: ..." when someone only clocked in after the
     window had closed, "Missed Shift: ..." when someone never did (a closed
     bell is retitled when they turn up later). A weather-cancelled shift,
     a removal waiting to be published, someone who is not an active
     person, or exempt from time tracking is never a no-show. A LIVE
     published placement on a company holiday or over approved time off
     is NOT excused by the clock (hardening pass, Oct 15 2026): the review
     warned and the manager shared anyway, so the scan alerts and the
     actuals judge it (the bell line and the cell say it was scheduled over
     time off / a holiday). A punch whose job category classes as leave
     (timeclock._leave_class: sick / vacation / personal) is NOT a clock-
     in: the scan treats the person as on leave (excused, never "came in").
     A person is judged ONCE per day, on the earliest live placement
     (shift_expect.pick_start - the rule the timecard, My Team and the
     scorecard share), under that placement's group; its own zone clock
     (placement zone -> preset zone -> the company's team zone) and the
     grace of its preset, else the company's `defaultGraceMin`. With the
     company's `noShowOnUsualHours` on, a person with NO placement but a
     usual-hours preset on one of its working days is a candidate too (the
     preset path of pick_start; time off and holidays DO excuse those, as
     nobody scheduled them). `noShowAlertMin` is clamped at scan time so
     start + grace + alert never passes the six-hour window. Recipients
     are the person's manager, their Backup Manager when one is set on
     their profile, and the group's schedulers (never the person); the
     company's HR contact only when there is nobody else. `shift_noshow_
     alerts` is the scan's memory and the record: a group-day that empties
     and fills again (a later start missed after the morning's "All In")
     reopens its own row, so the one email per recipient per group-day
     holds. The bell rides notify_rollup (one notice per recipient per
     team-day, type custom_alert with action.kind "shift_noshow", priority
     1 while open): refreshed quietly (stays read) while only the minutes
     change, made unread again only when a new name joins it, resolved in
     place.
     No Teams message: Nexus posts to Teams as a signed-in person
     (weather_watch._post_teams rides a live session), which a minute-by-
     minute attendance scan must not depend on.

  2. ACTUALS (`actuals`): scheduled vs. punched for a range of days, the
     payload behind GET /timeclock/schedule/actuals - one cell per person
     and day with a status (upcoming / in_progress / on_time / late /
     left_early / no_show / excused / exempt), the first in, last out and
     worked minutes from timeclock._day_summaries, the shift's zone (`tz`,
     the one the scan judges in - the screen shows the punches on THAT
     clock, not the viewer's), and totals per person and overall. Late is
     shift_expect.is_late_at; left early is a clock-out more than the
     company's `leftEarlyMin` before the end once the shift is over. A shift
     that crosses midnight is judged by its own end (wall clock in the
     shift's zone, so a 10 PM - 6 AM shift across a DST change ends when
     the clock on the wall says 6:00 - shift_expect.end_utc), never by the
     calendar date turning. A judged cell over approved time off or a
     holiday says so (`over`); a day with a leave punch is `excused` with
     the leave class as its excuse. No pay figure appears anywhere in it.
     `for_viewer` strips the stamps and minutes from everyone else's cells
     for a reader who is not a manager (a group scheduler below manager, a
     People viewer): status words only.

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
from notify_rollup import resolve_rollup, retitle_resolved, upsert_rollup

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


def _expect_day(day_rows: list, presets: dict, cfg: dict, dd: date) -> Optional[dict]:
    """One person's expectation for one day from their placed rows: the ONE
    rule (shift_expect.pick_start) - the earliest live placement, its preset's
    grace else the company default, its zone (placement -> preset -> the
    company's team zone). None when the day was called off."""
    return shift_expect.pick_start(day_rows, presets, "", dd, str(cfg.get("timeZone") or ""),
                                   _int_setting(cfg, "defaultGraceMin", shift_expect.DEFAULT_GRACE_MIN))


def _company_tz(cfg: dict) -> str:
    return str(cfg.get("timeZone") or "").strip() or shift_expect.DEFAULT_TEAM_TZ


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
    """The shift's end in UTC from its wall-clock end in its own zone - a
    10 PM - 6 AM shift across spring-forward is seven real hours, across
    fall-back nine (shift_expect.end_utc), never start + a fixed length."""
    return shift_expect.end_utc(dd, exp)


def _leave_class(category: str) -> str:
    """'' for worked time, else sick / vacation / personal (the timecard's
    _leave_class - one rule for the pay class and the clock)."""
    from routers.timeclock import _leave_class as lc
    return lc(category or "")


OVER_TEXT = {"time_off": "scheduled over approved time off", "holiday": "scheduled over a company holiday"}


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
    """{email: [(at_utc, local_date, leave_class)]} of live clock-ins dated
    in `dates` or stamped inside [since, until]. `leave_class` is '' for a
    real clock-in, else sick / vacation / personal - a leave punch."""
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
            out.setdefault((p.employee_email or "").lower(), []).append((t, p.local_date or "", _leave_class(p.category)))
    return out


def _first_in_for(punches: list, work_date: str, start: datetime, now: datetime) -> Optional[datetime]:
    """The clock-in that counts for a shift: the earliest live 'in' dated
    the work date, or stamped between two hours before the start and now.
    A leave punch (sick / vacation / personal) is not a clock-in."""
    best = None
    for t, local_date, leave in punches or []:
        if leave:
            continue
        if local_date == work_date or (start - timedelta(hours=_PUNCH_BEFORE_HOURS) <= t <= now):
            if best is None or t < best:
                best = t
    return best


def _leave_on(punches: list, work_date: str) -> str:
    """The leave class of a leave punch dated `work_date`, else ''."""
    for _t, local_date, leave in punches or []:
        if leave and local_date == work_date:
            return leave
    return ""


def _recipients_for(group_id: str, person, people: dict, groups: dict, hr_contacts: dict) -> list:
    """The person's manager, their Backup Manager when one is set on their
    profile (Neil, Oct 13: the backup has the manager's rights - and the
    manager's news), plus the group's schedulers (active People rows only,
    never the person, no duplicates); the company's HR contact when nobody
    else."""
    me = (getattr(person, "work_email", "") or "").lower()
    out = []
    for attr in ("manager_email", "backup_manager_email"):
        em = (getattr(person, attr, "") or "").strip().lower()
        if em:
            out.append(em)
    g = groups.get(group_id or "")
    if g is not None:
        out.extend(_schedulers(g))
    out = [e for e in dict.fromkeys(out) if e and e != me and _active(people.get(e))]
    if not out:
        hr = (hr_contacts.get(person.company or "") or "").strip().lower()
        if hr and hr != me and _active(people.get(hr)):
            out = [hr]
    return out


def _alert_window_min(cfg: dict, grace: int) -> int:
    """`noShowAlertMin` as the scan uses it: 0 = off, else clamped so the
    alert line (start + grace + alert) always lands inside the six-hour
    window - a setting of 240 with a 150-minute grace still alerts, one
    minute before the window closes."""
    alert = _int_setting(cfg, "noShowAlertMin", 0)
    if alert <= 0:
        return 0
    return max(1, min(alert, NOSHOW_WINDOW_HOURS * 60 - int(grace or 0) - 1))


def _bell(db: Session, recipient: str, ref_id: str, title: str, body: str, *, action: dict, company: str,
          priority: int, fresh: bool = True) -> None:
    """One bell per (person, ref_id) through notify_rollup - refreshed in
    place while it is still open. `fresh` = the story changed (a new name):
    the bell is unread and at the top again, and comes back if its reader
    had closed it. Not fresh = only the minutes moved: the words are updated
    and the bell stays where the reader left it (a scan every minute must
    not flip a read bell unread every minute). A resolved bell is history:
    the same team-day opening again gets a new one (open_only)."""
    upsert_rollup(db, recipient=recipient, key=ref_id, title=title, line=body, action=action, company=company or "",
                  replace=True, quiet=not fresh, priority=priority, open_only=True)


def _close_bell(db: Session, recipient: str, ref_id: str, title: str, body: str) -> bool:
    return resolve_rollup(db, recipient=recipient, key=ref_id, title=title, line=body)


def _ref_id(group_id: str, work_date: str) -> str:
    return f"noshow:{group_id or NO_GROUP}:{work_date}"


def _action(group_id: str, work_date: str) -> dict:
    """The bell's action: the schedule on that day and team. `kind` names
    the flow for the bell (the type stays custom_alert - the main bell's
    scope rules know that one; NotificationBell.jsx is Visesh's)."""
    return {"view": "shifts", "sub": f"schedule:{work_date}:{group_id if group_id != NO_GROUP else ''}",
            "kind": "shift_noshow"}


def _subject_of(people_lines: list, group_name: str) -> str:
    """'3 On Austin Crew', 'Amy Lee' (one person, no group), '2 People'."""
    n = len(people_lines)
    if group_name:
        return f"{n} On {group_name}"
    if n == 1:
        return people_lines[0]["name"]
    return f"{n} People"


def _line(p: dict) -> str:
    over = OVER_TEXT.get(p.get("over") or "", "")
    return (f"{p['name']} - scheduled {_t12(p['start'])}, {int(p['lateMin'])} min late"
            + (f" ({over})" if over else ""))


def _email_html(subject: str, work_date: str, lines: list, link: str) -> str:
    """The no-show email, in the saved email theme (header band, logo,
    footer) like shift_notify's publish email - every Nexus email wears it."""
    import email_theme
    theme = email_theme.current()
    band = theme.color("#0f3d2e")
    td = "padding:10px 12px;border-top:1px solid #e5e7eb;font-size:13.5px;color:#111827"
    rows = "".join(f"<tr><td style='{td}'>{escape(ln)}</td></tr>" for ln in lines)
    return f"""<div style="background:#f3f4f6;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-collapse:collapse">
    <tr><td style="background:{band};padding:16px 28px">{theme.logo_block()}</td></tr>
    <tr><td style="padding:24px 28px 0">
      <div style="font-size:20px;font-weight:600;color:#111827">{escape(subject)}</div>
      <div style="font-size:14px;line-height:1.55;color:#374151;margin-top:8px">Not clocked in for {escape(_us(work_date))}:</div>
    </td></tr>
    <tr><td style="padding:18px 28px 0">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-collapse:collapse">{rows}</table>
    </td></tr>
    <tr><td style="padding:24px 28px 28px">
      <a href="{escape(link)}" style="display:inline-block;padding:10px 22px;border-radius:4px;background:{band};color:#ffffff;text-decoration:none;font-weight:600;font-size:13px">Open The Schedule</a>
    </td></tr>
    <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-size:11.5px;line-height:1.6;color:#6b7280">
      You will not be emailed again for this team and day; the bell in Nexus keeps up as people come in.{theme.footer_lines()}
    </td></tr>
  </table>
</div>"""


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


def _alert_rows(db: Session, dates: list) -> list:
    """The scan's memory: every OPEN alert whatever its date (a stale one,
    left by a scan that was down, is closed on the next tick) plus this
    window's resolved ones, so a group-day that empties and fills again
    reopens its own row - and is never emailed twice."""
    return (db.query(models.ShiftNoShowAlert)
            .filter((models.ShiftNoShowAlert.resolved_at == "") | (models.ShiftNoShowAlert.resolved_at.is_(None))
                    | models.ShiftNoShowAlert.work_date.in_(dates)).all())


def _told(a) -> list:
    try:
        v = json.loads(a.people_json or "[]")
    except (TypeError, ValueError):
        return []
    return [p for p in v if isinstance(p, dict)]


def _recipient_people(db: Session, people: dict, groups: dict, hr_contacts: dict) -> None:
    """Add the possible recipients - the candidates' managers and backup
    managers, their groups' schedulers, the companies' HR contacts - to
    `people`, in one bounded query (never the whole People table every
    minute)."""
    want = {(getattr(p, "manager_email", "") or "").strip().lower() for p in people.values()}
    want |= {(getattr(p, "backup_manager_email", "") or "").strip().lower() for p in people.values()}
    for g in groups.values():
        want |= set(_schedulers(g))
    want |= {(e or "").strip().lower() for e in hr_contacts.values()}
    want = {e for e in want if e and e not in people}
    if want:
        people.update(_people(db, want))


def _usual_hours_candidates(db: Session, dates: list, settings, exclude: set) -> dict:
    """Shifts Phase 1 hardening (Oct 15): for every company whose
    `noShowOnUsualHours` is on, {(email, date): exp} for each active person
    with no placement that day but a usual-hours preset that works it
    (pick_start's preset path). Nothing for a company with it off - the
    usual tick reads no People table at all."""
    from routers.shift_requests import _DEFAULTS
    company_ids = [""] + [e.id for e in db.query(models.HrEntity.id).all()]
    on = [cid for cid in company_ids if bool(settings(cid).get("noShowOnUsualHours", _DEFAULTS.get("noShowOnUsualHours")))]
    if not on:
        return {}
    q = db.query(models.NexusEmployee.work_email, models.NexusEmployee.company).filter(models.NexusEmployee.work_email != "")
    emails = [(em or "").lower() for em, company in q.all()
              if em and ((company or "") in on) and (em or "").lower() not in exclude]
    if not emails:
        return {}
    out = {}
    for iso in dates:
        dd = date.fromisoformat(iso)
        for em, exp in shift_expect.expected_starts(db, emails, dd).items():
            if exp and exp.get("source") == "preset":
                out[(em, iso)] = exp
    return out


def noshow_scan(db: Session, now_utc: datetime = None) -> dict:
    """One pass: who should be in and is not, told to whom; what opened and
    what closed. Returns a summary {candidates, noShows, alerts, reopened,
    updated, resolved, retitled, emails}. Every query is bound to the day's
    candidates and the open alerts' people - an idle tick is two small
    reads (plus the usual-hours roster of a company that asked for it)."""
    now = now_utc or _utcnow()
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    dates = _scan_dates(now)
    rows = _candidate_rows(db, dates)
    alerts = _alert_rows(db, dates)
    open_alerts = [a for a in alerts if not (a.resolved_at or "")]
    # A closed bell whose story may still change: someone it said missed
    # the shift (no clock-in by the window's end) is re-checked while the
    # day is in the scan's window - they may have come in late after all.
    unsettled = [a for a in alerts if (a.resolved_at or "") and a.work_date in dates
                 and any(p.get("missed") and not p.get("came") for p in _told(a))]
    summary = {"candidates": len(rows), "noShows": 0, "alerts": 0, "reopened": 0, "updated": 0, "resolved": 0,
               "retitled": 0, "emails": 0}
    settings = _settings_by_company(db)
    by_day: dict = {}       # (email, date) -> that person's live placements that day
    for r in rows:
        by_day.setdefault(((r.employee_email or "").lower(), r.work_date), []).append(r)
    usual = _usual_hours_candidates(db, dates, settings, {em for em, _d in by_day})
    summary["candidates"] += len(usual)
    if not rows and not open_alerts and not unsettled and not usual:
        return summary
    alert_people = {str(p.get("email") or "").lower() for a in open_alerts + unsettled for p in _told(a)}
    emails = _lower([r.employee_email for r in rows] + [em for em, _d in usual] + list(alert_people))
    people = _people(db, emails)
    exempt = _exempt(db)
    presets = _presets(db, rows)
    group_ids = sorted({r.group_id for r in rows if r.group_id}
                       | {a.group_id for a in alerts if a.group_id and a.group_id != NO_GROUP})
    groups = ({g.id: g for g in db.query(models.ShiftGroup).filter(models.ShiftGroup.id.in_(group_ids)).all()}
              if group_ids else {})
    company_ids = sorted({p.company for p in people.values() if p.company})
    hr_contacts = ({e.id: (e.hr_contact_email or "") for e in
                    db.query(models.HrEntity).filter(models.HrEntity.id.in_(company_ids)).all()}
                   if company_ids else {})
    _recipient_people(db, people, groups, hr_contacts)
    leave = _leave_dates(db, emails, dates[0], dates[-1])
    holidays = _holiday_dates(db, {em: people[em] for em in emails if em in people}, dates[0], dates[-1])
    punch_dates = sorted(set(dates) | {a.work_date for a in open_alerts + unsettled if a.work_date})
    punches = _in_punches(db, emails, punch_dates,
                          now - timedelta(hours=NOSHOW_WINDOW_HOURS + _PUNCH_BEFORE_HOURS + 24), now)

    # Who is a no-show right now, per (recipient, group-day). One judgment
    # per person and day: the earliest live start, under its group - or the
    # usual hours, under no group.
    wanted: dict = {}       # (recipient, group_key, date) -> {email: person line}
    companies: dict = {}    # (group_key, date) -> company for the bell
    judged = [(em, work_date, day_rows, None) for (em, work_date), day_rows in by_day.items()]
    judged += [(em, work_date, [], exp) for (em, work_date), exp in usual.items()]
    for em, work_date, day_rows, usual_exp in judged:
        person = people.get(em)
        if not _active(person) or em in exempt:
            continue
        on_leave = (em, work_date) in leave
        on_holiday = (em, work_date) in holidays
        if usual_exp is not None and (on_leave or on_holiday):
            continue    # nobody scheduled them: time off and holidays excuse the usual hours
        cfg = settings(person.company or "")
        dd = date.fromisoformat(work_date)
        exp = usual_exp if usual_exp is not None else _expect_day(day_rows, presets, cfg, dd)
        start = shift_expect.start_utc(dd, exp) if exp else None
        if start is None:
            continue
        alert_min = _alert_window_min(cfg, int(exp["grace"]))
        if alert_min <= 0:
            continue
        threshold = start + timedelta(minutes=int(exp["grace"]) + alert_min)
        if now < threshold or now >= start + timedelta(hours=NOSHOW_WINDOW_HOURS):
            continue
        if _leave_on(punches.get(em), work_date):
            continue    # a leave punch: on leave, not a clock-in and not a no-show
        if _first_in_for(punches.get(em), work_date, start, now) is not None:
            continue
        if day_rows:
            r = next((x for x in day_rows if x.id == exp["rowId"]), day_rows[0])
            gkey = r.group_id or NO_GROUP
        else:
            gkey = NO_GROUP
        g = groups.get(gkey) if gkey != NO_GROUP else None
        group_company = (getattr(g, "company_id", "") or "") if g is not None else ""
        companies.setdefault((gkey, work_date), group_company or (person.company or ""))
        late_min = int((now - start).total_seconds() // 60)
        line = {"email": em, "name": _name(person), "start": exp["start"], "lateMin": late_min,
                "startUtc": _iso(start), "over": "time_off" if on_leave else "holiday" if on_holiday else ""}
        if not line["over"]:
            del line["over"]
        for rcpt in _recipients_for(gkey if gkey != NO_GROUP else "", person, people, groups, hr_contacts):
            wanted.setdefault((rcpt, gkey, work_date), {})[em] = line
    summary["noShows"] = len({em for b in wanted.values() for em in b})

    now_iso = _iso(now)
    by_key = {(a.recipient, a.group_id or NO_GROUP, a.work_date): a for a in alerts}
    to_email = []
    # Open, reopen or refresh.
    for (rcpt, gkey, work_date), bucket in wanted.items():
        lines = sorted(bucket.values(), key=lambda p: (p["start"], p["name"].lower()))
        g = groups.get(gkey) if gkey != NO_GROUP else None
        gname = (g.name or "") if g is not None else ""
        subject = _subject_of(lines, gname)
        title = f"Not In Yet: {subject}"
        body = "\n".join(_line(p) for p in lines)
        company = companies.get((gkey, work_date), "")
        a = by_key.get((rcpt, gkey, work_date))
        # Keep everyone this recipient was ever told about (someone who came
        # in is still part of the day's story at resolution).
        known = {} if a is None else {str(p.get("email") or "").lower(): p for p in _told(a)}
        fresh = a is None or any(em not in known for em in bucket)
        _bell(db, rcpt, _ref_id(gkey, work_date), title, body,
              action=_action(gkey, work_date), company=company, priority=1, fresh=fresh)
        if a is None:
            a = models.ShiftNoShowAlert(id=str(uuid.uuid4()), group_id=gkey, work_date=work_date, recipient=rcpt,
                                        people_json=json.dumps(lines), first_at=now_iso, last_at=now_iso,
                                        emailed_at="", resolved_at="")
            db.add(a)
            by_key[(rcpt, gkey, work_date)] = a
            summary["alerts"] += 1
            # Workflows (Oct 28 2026): a NEW alert is the event; a refresh is not.
            import workflows
            workflows.emit(db, "shift.no_show", subject=a, company_id=company,
                           extra={"team": gname, "title": title, "people": lines})
        else:
            if a.resolved_at or "":
                # The group-day filled again after it emptied (a later start
                # missed after the morning's All In): the same record, no
                # second email - the first one promised there would be none.
                a.resolved_at = ""
                summary["reopened"] += 1
            else:
                summary["updated"] += 1
            for p in lines:
                old = known.get(p["email"]) or {}
                known[p["email"]] = {**{k: v for k, v in old.items() if k in ("came", "missed")}, **p}
            a.people_json = json.dumps(sorted(known.values(), key=lambda p: (p["start"], p["name"].lower())))
            a.last_at = now_iso
        if not (a.emailed_at or ""):
            a.emailed_at = now_iso
            to_email.append((rcpt, f"Not In Yet: {subject} ({_us(work_date)})",
                             _email_html(title, work_date, [_line(p) for p in lines], _link(work_date, gkey))))

    def story(a, told: list) -> tuple:
        """(title, body, told) of a group-day at or after its resolution:
        who came in (and when), who is on leave, who never clocked in."""
        gkey, work_date = a.group_id or NO_GROUP, a.work_date
        g = groups.get(gkey) if gkey != NO_GROUP else None
        gname = (g.name or "") if g is not None else ""
        came, missed, after_window = [], [], False
        for p in told:
            em = str(p.get("email") or "").lower()
            start = _parse(p.get("startUtc") or "")
            first = _first_in_for(punches.get(em), work_date, start, now) if start is not None else None
            leave_cls = _leave_on(punches.get(em), work_date)
            p.pop("missed", None)
            if first is not None:
                zone = shift_expect.zone(_zone_of(by_day.get((em, work_date), []), em, presets, settings, people))
                late = max(0, int((first - start).total_seconds() // 60))
                p["came"] = _iso(first)
                if first >= start + timedelta(hours=NOSHOW_WINDOW_HOURS):
                    after_window = True
                came.append(f"{p.get('name') or em} came in at {_clock12(first.astimezone(zone))}"
                            + (f", {late} min late" if late > 0 else ""))
            elif leave_cls:
                p["leave"] = leave_cls
                came.append(f"{p.get('name') or em} - {leave_cls} leave (not a clock-in)")
            else:
                p["missed"] = True
                missed.append(f"{p.get('name') or em} did not clock in")
        subject = _subject_of(told, gname) if told else (gname or "Shift")
        if missed:
            title = f"Missed Shift: {subject}"
        elif after_window:
            title = f"Came In Late: {subject}"
        else:
            title = f"All In: {gname or (told[0].get('name') if len(told) == 1 else subject)}"
        return title, "\n".join(came + missed) or "Nobody is still expected.", told

    # Resolve what emptied.
    for key, a in list(by_key.items()):
        if key in wanted or (a.resolved_at or ""):
            continue
        rcpt, gkey, work_date = key
        title, body, told = story(a, _told(a))
        _close_bell(db, rcpt, _ref_id(gkey, work_date), title, body)
        a.people_json = json.dumps(told)
        a.resolved_at = now_iso
        summary["resolved"] += 1
    # Re-check what closed with someone still out: a late arrival after the
    # window retitles the closed bell ("Came In Late"), once.
    for a in unsettled:
        key = (a.recipient, a.group_id or NO_GROUP, a.work_date)
        if key in wanted or not (a.resolved_at or ""):
            continue
        before = {str(p.get("email") or ""): bool(p.get("missed")) for p in _told(a)}
        title, body, told = story(a, _told(a))
        if {str(p.get("email") or ""): bool(p.get("missed")) for p in told} == before:
            continue
        retitle_resolved(db, recipient=a.recipient, key=_ref_id(a.group_id or NO_GROUP, a.work_date), title=title, line=body)
        a.people_json = json.dumps(told)
        summary["retitled"] += 1
    # The record is committed BEFORE anything is sent (weather_watch's rule).
    db.commit()
    for rcpt, subject, html in to_email:
        if _send_email(rcpt, subject, html):
            summary["emails"] += 1
    return summary


def _zone_of(day_rows: list, em: str, presets: dict, settings, people: dict) -> str:
    """The zone of a person's shift on a day (for the 'came in at' clock):
    the judged placement's, else the company's team zone."""
    person = people.get(em)
    cfg = settings((person.company or "") if person else "")
    if day_rows:
        exp = _expect_day(day_rows, presets, cfg, date.fromisoformat(day_rows[0].work_date))
        if exp:
            return exp["tz"]
    return _company_tz(cfg)


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
        # The California meal reminder at 4.5 hours (Oct 20 2026) rides the
        # same minute - see meal_watch.py; its tick() never raises.
        import meal_watch
        m = await asyncio.to_thread(meal_watch.tick)
        if m and m.get("reminded"):
            print(f"[meal-watch] {m}")
        await asyncio.sleep(SCAN_SEC)


# ── Actuals ──────────────────────────────────────────────────────────────

STATUSES = ("upcoming", "in_progress", "on_time", "late", "left_early", "no_show", "excused", "exempt")


def _empty_totals() -> dict:
    return {"scheduledMin": 0, "workedMin": 0, "late": 0, "noShow": 0, "leftEarly": 0, "onTime": 0, "judged": 0}


def _last_out_for(punches: list, work_date: str) -> str:
    """The clock-out that closed the work date's last segment, wherever it is
    dated: a night shift's out lands on the NEXT calendar date, which
    _day_summaries keys under that date, not the shift's."""
    seg_in, out = False, ""
    for p in punches or []:
        if p.kind == "in":
            seg_in = (p.local_date or "") == work_date
        elif p.kind == "out" and seg_in:
            out, seg_in = p.at or "", False
    return out


def _open_on(punches: list, now: datetime, work_date: str) -> bool:
    """An open shift right now that belongs to `work_date`: the last live
    punch is a clock-in or a break inside the pairing guard (my_team.
    _open_shifts' rule) and its segment's clock-in is dated that day - so a
    split shift's second half still reads running, and yesterday's forgotten
    clock-out never does once today's shift is open."""
    if not punches:
        return False
    last = punches[-1]
    if last.kind == "out":
        return False
    t = _parse(last.at)
    if t is None or not (0 <= (now - t).total_seconds() <= _MAX_SHIFT_MIN * 60):
        return False
    seg_in = next((p for p in reversed(punches) if p.kind == "in"), None)
    return seg_in is not None and (seg_in.local_date or "") == work_date


def _leave_class_on(punches: list, work_date: str) -> str:
    """The leave class of the day's first clock-in (TimePunch rows), else ''."""
    for p in punches or []:
        if p.kind == "in" and (p.local_date or "") == work_date:
            return _leave_class(getattr(p, "category", "") or "")
    return ""


_PRIVATE_CELL = ("firstIn", "lastOut", "workedMin", "lateMin", "earlyMin")
_PRIVATE_TOTALS = ("scheduledMin", "workedMin")


def for_viewer(out: dict, me: str, full: bool) -> dict:
    """The actuals payload a reader may see. A manager (`full`) sees it all;
    anyone else - a group scheduler below manager, a People viewer - gets
    status words only for everyone but themself: no clock stamps, no
    minutes, and no minute totals for other people or overall."""
    if full:
        return out
    me = (me or "").strip().lower()
    cells = {}
    for key, cell in (out.get("cells") or {}).items():
        if key.split("|")[0] == me:
            cells[key] = cell
        else:
            cells[key] = {**{k: v for k, v in cell.items() if k not in _PRIVATE_CELL}, "private": True}
    people = {}
    for em, tot in (out.get("people") or {}).items():
        people[em] = tot if em == me else {k: v for k, v in tot.items() if k not in _PRIVATE_TOTALS}
    totals = {k: v for k, v in (out.get("totals") or {}).items() if k not in _PRIVATE_TOTALS}
    return {**out, "cells": cells, "people": people, "totals": totals, "private": True}


def actuals(db: Session, emails: Iterable[str], start: str, end: str, now_utc: datetime = None) -> dict:
    """Scheduled vs. punched for `emails` over [start, end] (YYYY-MM-DD).

    {"cells": {"<email>|<date>": {shiftId, shifts, status, firstIn, lastOut,
    workedMin, scheduledMin, lateMin, earlyMin, excuse, over, tz}},
     "people": {email: {scheduledMin, workedMin, late, noShow, leftEarly,
    onTime, judged}}, "totals": {the same}}.
    A person with two live shifts on a day is judged on the earliest start
    (pick_start's rule) and the latest end; scheduledMin sums them all.
    `over` is 'time_off' / 'holiday' when the placement was shared over
    approved time off or a company holiday (judged all the same); `excuse`
    is weather, or the leave class of a leave punch (sick / vacation /
    personal). Someone who is not an active person has no cells."""
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
        if not _active(person):
            continue
        cfg = settings(person.company or "")
        cell = {"shiftId": "", "shifts": len(day_rows), "status": "upcoming", "firstIn": "", "lastOut": "",
                "workedMin": 0, "scheduledMin": sum(_paid_minutes(r) for r in day_rows),
                "lateMin": 0, "earlyMin": 0, "excuse": "", "over": "", "tz": _company_tz(cfg)}
        if (em, work_date) in leave:
            cell["over"] = "time_off"
        elif (em, work_date) in holidays:
            cell["over"] = "holiday"
        s = summaries.get(em, {}).get(work_date) or {}
        cell["firstIn"], cell["lastOut"], cell["workedMin"] = s.get("firstIn", ""), s.get("lastOut", ""), int(s.get("workedMin", 0) or 0)
        if cell["firstIn"] and not cell["lastOut"]:
            cell["lastOut"] = _last_out_for(punches.get(em), work_date)   # an out past midnight
        elif not cell["firstIn"]:
            cell["lastOut"] = ""   # last night's clock-out is not this day's attendance
        dd = date.fromisoformat(work_date)
        exp = _expect_day(day_rows, presets, cfg, dd)
        live = [r for r in day_rows if _is_live(r)]
        if exp is not None:
            cell["shiftId"], cell["tz"] = exp["rowId"], exp["tz"]
            # The latest end among the live placements is the one to stay for.
            exp["end"] = max(live, key=lambda r: _shift_minutes(exp["start"], r.end_hhmm or "")).end_hhmm or ""
        judged = False
        leave_cls = _leave_class_on(punches.get(em), work_date)
        if em in exempt:
            cell["status"] = "exempt"
        elif exp is None:
            cell["status"], cell["excuse"] = "excused", "weather"
        elif leave_cls:
            # A sick / vacation / personal punch is leave, not a clock-in.
            cell["status"], cell["excuse"] = "excused", leave_cls
            cell["firstIn"], cell["lastOut"], cell["workedMin"] = "", "", 0
        else:
            tz = shift_expect.zone(exp["tz"])
            today = now.astimezone(tz).date()
            start_utc = shift_expect.start_utc(dd, exp)
            end_utc = _end_utc(dd, exp)
            threshold = start_utc + timedelta(minutes=int(exp["grace"]) + _int_setting(cfg, "noShowAlertMin", 0))
            # Still running: the shift's own end is ahead (a night shift ends
            # on the next calendar date - the date turning does not end it),
            # or the day's clock-in is still open with no clock-out.
            running = now < end_utc or _open_on(punches.get(em), now, work_date)
            late = shift_expect.is_late_at(cell["firstIn"], dd, exp)
            if cell["firstIn"]:
                first = _parse(cell["firstIn"])
                if late and first is not None:
                    cell["lateMin"] = max(0, int((first - start_utc).total_seconds() // 60))
            if dd > today:
                cell["status"] = "upcoming"
            elif not cell["firstIn"]:
                if now >= threshold:
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
