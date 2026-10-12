"""Workforce Scorecard (Neil, Oct 10 2026) - Workforce Analytics > Scorecard,
plus the weekly manager email.

"A real scoring on who worked and who didn't": every hourly employee has an
expected number of hours each day, and the scorecard holds what they actually
punched against it. Nothing is guessed from monitoring - it is hours on the
time clock, the same pairing payroll uses - and every exclusion a manager
would ask about (holiday, approved time off, not scheduled, not started yet)
is written on the day so the number is defensible.

Expected minutes for one person on one day, in priority order:
  1. a PUBLISHED scheduled shift on that date (its paid minutes - length minus
     the unpaid break; several shifts add up);
  2. else the person's assigned Shift preset, on its working days;
  3. else, for full-time staff, the country standard from the settings
     (US 8h, India 9h by default, Mon-Fri) - the employee's own country, else
     their company's. Part-time / contractor / intern staff with no shift are
     reported as "No Schedule" rather than scored against a guess.
Then: a company holiday (mandatory or optional) makes the day 0, a half-day
holiday halves it; approved time off covering the day makes it 0 ("1/2 Day"
halves it, a partial-day request subtracts its hours), except types the
settings list as working ("Work From Home"). Someone whose start date is after
the day is not expected.

Actual minutes come from the punches through routers.timeclock._day_summaries
(the payroll pairing: an overnight shift is one segment on the day it started,
forgotten clock-outs are flagged and not counted). Punches tagged with a
Sick / PTO job category (_leave_class) are PAID LEAVE, not work: they cover the
expectation but are shown as leave. Late = first clock-in after the shift start
plus its grace, in the shift's own zone - only when the day has a shift time.

Only days BEFORE the employee's own local today are scored (a day still in
progress is shown, not judged). Weekly coverage = covered / expected, the
score is that capped at 100, and the band is On Track / Below Expected / Well
Below / Absent / Not Expected / No Schedule (thresholds in the settings).

Who sees it: the `workforce-scorecard` module grant (Roles & Access). Viewer =
their DIRECT reports only (Neil, 10/10: "managers should only get this on
their direct reports by default"); Editor = their whole reporting line, all
the way down (auth.team_emails); Full (or IT / Global Admin) = the whole
company. The weekly email goes to every grant holder with people in scope,
plus the settings' companyRecipients, on the send day at the send time in
each manager's own zone, for the last COMPLETE week - one email per manager
per week (NexusWorkforceScorecardLog). Off by default, with the same off /
test / live modes as the Weekly Digest.
"""
import asyncio
import json
import re
import uuid
from datetime import datetime, timezone, timedelta, date, time as dtime
from html import escape
from zoneinfo import ZoneInfo

from sqlalchemy import func, or_, text
from sqlalchemy.orm import Session

import models
from database import SessionLocal
import graph_mail
import daily_briefing as daily
import shift_day
from app_url import app_url
from routers.timeclock import (_day_summaries, _shift_minutes, time_tracking_exempt_emails,
                               _breakpolicy_cfg, _team_tz, _leave_class)

MODULE_ID = "workforce-scorecard"
_SETTINGS_KEY = "workforce_scorecard_config"
_DEFAULT_SETTINGS = {
    "mode": "off",                  # off|test|live
    "test_recipients": [],
    "sendDay": 1,                   # ISO weekday: 1 = Monday .. 7 = Sunday
    "sendTime": "08:00",            # local 24h HH:MM, in each manager's own zone
    # Two jobs: the zone of a manager with no shift preset, AND the latest
    # zone anyone in the company works in - the email waits until the scored
    # week has ended there, so no employee's last day is still in progress.
    "defaultTimeZone": "America/Los_Angeles",
    "weekStart": "monday",          # monday|sunday - the scored week
    "payTypes": ["hourly"],         # hourly and/or fixed (monthly salaried staff who punch)
    # Country standard day when nobody scheduled the person: ISO weekdays.
    "standards": {
        "US": {"hours": 8, "days": [1, 2, 3, 4, 5]},
        "IN": {"hours": 9, "days": [1, 2, 3, 4, 5]},
        "default": {"hours": 8, "days": [1, 2, 3, 4, 5]},
    },
    "shortToleranceMin": 15,        # under expected by no more than this still counts as a full day
    "onTrackPct": 95,               # score >= this: On Track
    "belowPct": 70,                 # score >= this (and < onTrackPct): Below Expected; under: Well Below
    "workingTimeOffTypes": ["Work From Home"],   # time-off types that do NOT excuse the hours
    "companyRecipients": [],        # always get the whole-company scorecard, grant or not
}
DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
BANDS = {
    # key: (label, color) - the order here is the order the email lists them in
    "absent":       ("Absent",         "#b91c1c"),
    "well_below":   ("Well Below",     "#c2410c"),
    "below":        ("Below Expected", "#b45309"),
    "on_track":     ("On Track",       "#15803d"),
    "not_expected": ("Not Expected",   "#6b7280"),
    "no_schedule":  ("No Schedule",    "#6b7280"),
}
DAY_REASONS = {
    "not_started": "Not started yet", "holiday": "Holiday", "holiday_half": "Half-day holiday",
    "time_off": "Time off", "time_off_half": "Half day off", "time_off_partial": "Partial day off",
    "not_scheduled": "Not scheduled", "no_schedule": "No schedule",
}
SCAN_EVERY_SEC = 15 * 60
# No catch-up cut-off: a week's scorecard is still worth having at 3 PM if the
# API was down at 8 AM - due from sendTime until the end of the send day.
EMAIL_ROW_CAP = 40                 # per band in the email; the rest is counted with a link
_LOCK_NS = 918273647               # its own advisory-lock keyspace (weekly_digest uses 918273646)
_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


# ── Settings ───────────────────────────────────────────────────────────────

def get_settings(db: Session) -> dict:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    merged = json.loads(json.dumps(_DEFAULT_SETTINGS))
    if row and row.value:
        try:
            cfg = json.loads(row.value)
        except (TypeError, ValueError):
            cfg = {}
        if isinstance(cfg, dict):
            # standards merge per country so a saved {"IN": ...} keeps the US/default rows
            std = cfg.pop("standards", None)
            merged.update(cfg)
            if isinstance(std, dict):
                merged["standards"].update({k: v for k, v in std.items() if isinstance(v, dict)})
    return merged


def _emails(v, what: str) -> list:
    if not isinstance(v, list):
        raise ValueError(f"{what} must be a list of email addresses.")
    return sorted({str(e).strip().lower() for e in v if str(e).strip()})


def _int(v, what: str, lo: int, hi: int) -> int:
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise ValueError(f"{what} must be a whole number from {lo} to {hi}.")
    return v


def validate(patch: dict) -> dict:
    """Checks and normalizes a config patch; raises ValueError with a readable
    message. Keys not present are left alone."""
    out = dict(patch)
    if "mode" in out and out["mode"] not in ("off", "test", "live"):
        raise ValueError("Mode must be off, test or live.")
    if "test_recipients" in out:
        out["test_recipients"] = _emails(out["test_recipients"], "Test recipients")
    if "companyRecipients" in out:
        out["companyRecipients"] = _emails(out["companyRecipients"], "Company recipients")
    if "sendDay" in out:
        out["sendDay"] = _int(out["sendDay"], "Send day", 1, 7)
    if "sendTime" in out:
        v = str(out["sendTime"] or "").strip()
        if not _HHMM.match(v):
            raise ValueError("Send time must be HH:MM (24-hour), for example 08:00.")
        out["sendTime"] = v
    if "defaultTimeZone" in out:
        if not daily._valid_zone(out["defaultTimeZone"]):
            raise ValueError("Default time zone must be a valid IANA name, for example America/Los_Angeles.")
        out["defaultTimeZone"] = out["defaultTimeZone"].strip()
    if "weekStart" in out and out["weekStart"] not in ("monday", "sunday"):
        raise ValueError("Week start must be monday or sunday.")
    if "payTypes" in out:
        v = out["payTypes"]
        if not isinstance(v, list) or not v or any(p not in ("hourly", "fixed") for p in v):
            raise ValueError("Pay types must list hourly and/or fixed.")
        out["payTypes"] = sorted(set(v))
    if "standards" in out:
        v = out["standards"]
        if not isinstance(v, dict) or "default" not in v:
            raise ValueError("Standards must map country codes (and 'default') to {hours, days}.")
        std = {}
        for code, s in v.items():
            if not isinstance(s, dict):
                raise ValueError(f"Standard for {code} must be an object with hours and days.")
            hours = s.get("hours")
            if isinstance(hours, bool) or not isinstance(hours, (int, float)) or not 0 < hours <= 16:
                raise ValueError(f"Standard hours for {code} must be between 0 and 16.")
            days = s.get("days")
            if not isinstance(days, list) or any(isinstance(d, bool) or not isinstance(d, int) or not 1 <= d <= 7 for d in days):
                raise ValueError(f"Standard days for {code} must be ISO weekdays 1 (Monday) to 7 (Sunday).")
            std[str(code).strip().upper() if code != "default" else "default"] = {"hours": float(hours), "days": sorted(set(days))}
        out["standards"] = std
    if "shortToleranceMin" in out:
        out["shortToleranceMin"] = _int(out["shortToleranceMin"], "Short tolerance", 0, 120)
    if "onTrackPct" in out:
        out["onTrackPct"] = _int(out["onTrackPct"], "On Track threshold", 1, 100)
    if "belowPct" in out:
        out["belowPct"] = _int(out["belowPct"], "Below Expected threshold", 0, 100)
    on_track = out.get("onTrackPct")
    below = out.get("belowPct")
    if on_track is not None and below is not None and below >= on_track:
        raise ValueError("The Below Expected threshold must be lower than the On Track threshold.")
    if "workingTimeOffTypes" in out:
        v = out["workingTimeOffTypes"]
        if not isinstance(v, list):
            raise ValueError("Working time-off types must be a list.")
        out["workingTimeOffTypes"] = sorted({str(t).strip() for t in v if str(t).strip()})
    return out


def save_settings(db: Session, patch: dict, actor_email: str) -> dict:
    merged = get_settings(db)
    patch = dict(patch)
    if "standards" in patch:
        # The patch is the whole map, but the built-in rows (US, IN, default)
        # always exist - an admin changes them, never loses them.
        merged["standards"] = {**json.loads(json.dumps(_DEFAULT_SETTINGS["standards"])), **patch.pop("standards")}
    merged.update(patch)
    if "onTrackPct" in merged and "belowPct" in merged and merged["belowPct"] >= merged["onTrackPct"]:
        raise ValueError("The Below Expected threshold must be lower than the On Track threshold.")
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    if not row:
        row = models.NexusSetting(key=_SETTINGS_KEY)
        db.add(row)
    row.value = json.dumps(merged)
    row.updated_by = actor_email
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    return merged


# ── Weeks ──────────────────────────────────────────────────────────────────

def week_start_for(d: date, cfg: dict) -> date:
    """The first day of the scored week `d` falls in (Monday, or Sunday when
    weekStart is sunday)."""
    back = d.weekday() if cfg.get("weekStart", "monday") != "sunday" else (d.weekday() + 1) % 7
    return d - timedelta(days=back)


def last_complete_week(today: date, cfg: dict) -> date:
    """The start of the most recent week that has fully ended before `today` -
    what the weekly email reports on."""
    return week_start_for(today, cfg) - timedelta(days=7)


def default_week(db: Session, email: str, cfg: dict) -> date:
    """The week a manager opens the screen on: the last complete one as of
    their own local today (the same zone the email trigger uses)."""
    return last_complete_week(daily._shift_local_now(daily._person_zone(db, email, cfg)).date(), cfg)


def _days(ws: date) -> list:
    return [ws + timedelta(days=i) for i in range(7)]


# ── Scope + recipients ────────────────────────────────────────────────────

def _level_of(db: Session, email: str) -> int:
    from auth import _LEVELS
    row = db.query(models.NexusRole).filter(models.NexusRole.email == email.lower()).first()
    return _LEVELS.get((row.role if row else "employee") or "employee", 1)


SCOPE_LABEL = {"direct": "your direct reports", "line": "your whole reporting line", "all": "the whole company"}


def direct_reports(db: Session, email: str) -> set:
    return {(e.work_email or "").lower() for e in db.query(models.NexusEmployee)
            .filter(func.lower(models.NexusEmployee.manager_email) == email.lower()).all() if e.work_email}


def scope_kind(rank: int, level: int = 1, company: bool = False) -> str:
    """direct | line | all from a grant rank (auth._MODULE_LEVEL_RANK) and tier."""
    from auth import _MODULE_LEVEL_RANK
    if company or level >= 4 or rank >= _MODULE_LEVEL_RANK["full"]:
        return "all"
    return "line" if rank >= _MODULE_LEVEL_RANK["editor"] else "direct"


def scope_emails(db: Session, email: str, kind: str):
    """The emails a scope kind covers for `email`: None = everyone."""
    from auth import team_emails
    if kind == "all":
        return None
    return team_emails(db, email) if kind == "line" else direct_reports(db, email)


def scope_for(db: Session, user: dict) -> tuple:
    """(emails, kind) - who the caller may score: direct reports by default,
    the whole reporting line with an Editor grant, everyone (None) with a
    Full grant or as IT / Global Admin."""
    from auth import _module_level
    email = (user.get("email") or "").lower()
    kind = scope_kind(_module_level(email, MODULE_ID, db), int(user.get("level", 0)))
    return scope_emails(db, email, kind), kind


def grant_holders(db: Session) -> dict:
    """{email: best rank} for everyone a role or access group grants the
    scorecard module - the reverse of auth._grants_for, for the weekly send."""
    from auth import _MODULE_LEVEL_RANK
    groups = (db.query(models.NexusGroup)
              .filter(models.NexusGroup.allowed_modules.like(f"%{MODULE_ID}%")).all())
    rank_by_group = {}
    for g in groups:
        for part in (g.allowed_modules or "").split(","):
            mid, _, level = part.strip().partition(":")
            if mid == MODULE_ID:
                rank_by_group[g.id] = max(rank_by_group.get(g.id, 0),
                                          _MODULE_LEVEL_RANK.get(level, _MODULE_LEVEL_RANK["viewer"]))
    if not rank_by_group:
        return {}
    out = {}
    for m in db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_(list(rank_by_group))).all():
        em = (m.email or "").strip().lower()
        if em:
            out[em] = max(out.get(em, 0), rank_by_group[m.group_id])
    return out


def recipients(db: Session, cfg: dict) -> list:
    """[(NexusEmployee, scope emails, kind)] - every active internal grant
    holder, with the scope their grant (or tier) gives them, plus the
    settings' company recipients with the whole company. A manager whose
    scope is empty is still listed; send_one logs them with nothing to send."""
    holders = grant_holders(db)
    company = set(cfg.get("companyRecipients") or [])
    out = []
    for em in sorted(set(holders) | company):
        emp = (db.query(models.NexusEmployee)
               .filter(func.lower(models.NexusEmployee.work_email) == em).first())
        if not emp or not daily._no_shift_eligible(emp):
            continue
        kind = scope_kind(holders.get(em, 0), _level_of(db, em), company=em in company)
        out.append((emp, scope_emails(db, em, kind), kind))
    return out


# ── Roster ────────────────────────────────────────────────────────────────

def roster(db: Session, scope, cfg: dict, week_end: str) -> list:
    """Who is scored: active internal staff with a work email, inside `scope`
    (None = everyone), not time-tracking exempt, on one of the configured pay
    types (no payroll row = hourly), and already started by the week's end."""
    # NULL status / identity_type are pre-column rows: active internal staff
    # (the same reading daily_briefing._no_shift_eligible gives them).
    q = (db.query(models.NexusEmployee)
         .filter(models.NexusEmployee.work_email != "",
                 or_(models.NexusEmployee.status == "active", models.NexusEmployee.status.is_(None)),
                 or_(models.NexusEmployee.identity_type.in_(("internal", "")),
                     models.NexusEmployee.identity_type.is_(None))))
    if scope is not None:
        if not scope:
            return []
        q = q.filter(func.lower(models.NexusEmployee.work_email).in_(list(scope)))
    exempt = time_tracking_exempt_emails(db)
    pay_types = set(cfg.get("payTypes") or ["hourly"])
    candidates = q.all()
    rates = {(r.employee_email or "").lower(): r for r in db.query(models.PayrollRate)
             .filter(func.lower(models.PayrollRate.employee_email).in_([e.work_email.lower() for e in candidates])).all()
             } if candidates else {}
    out = []
    for e in candidates:
        em = e.work_email.lower()
        if em in exempt:
            continue
        rr = rates.get(em)
        if ((rr.pay_type if rr else None) or "hourly") not in pay_types:
            continue
        if (e.start_date or "")[:10] > week_end:
            continue
        out.append(e)
    out.sort(key=lambda e: ((e.first_name or "").lower(), (e.last_name or "").lower(), e.work_email.lower()))
    return out


# ── Expectation ───────────────────────────────────────────────────────────

def _standard_for(emp, ctx: dict, cfg: dict) -> dict:
    std = cfg.get("standards") or {}
    country = _effective_country(emp, ctx)
    return std.get(country) or std.get("default") or {"hours": 8, "days": [1, 2, 3, 4, 5]}


def _off_minutes(r) -> int:
    """A partial-day time-off request's length; 0 when it is a whole day."""
    if r.start_date != r.end_date or not (r.start_time and r.end_time):
        return 0
    try:
        s = int(r.start_time[:2]) * 60 + int(r.start_time[3:5])
        e = int(r.end_time[:2]) * 60 + int(r.end_time[3:5])
    except (TypeError, ValueError, IndexError):
        return 0
    return max(0, e - s)


def expected_for_day(emp, dd: date, ctx: dict, cfg: dict) -> dict:
    """{expectedMin, source, start, grace, tz, reason} for one person on one
    day - see the module docstring for the order of precedence."""
    em = emp.work_email.lower()
    iso = dd.isoformat()
    out = {"expectedMin": 0, "source": "", "start": "", "grace": 0, "tz": "", "reason": ""}
    if (emp.start_date or "")[:10] > iso:
        out["reason"] = "not_started"
        return out
    base = 0
    placed = ctx["scheduled"].get(em, {}).get(iso) or []
    if placed:
        out["source"] = "scheduled"
        for r in placed:
            base += max(0, _shift_minutes(r.start_hhmm, r.end_hhmm) - int(r.break_min or 0))
        first = min(placed, key=lambda r: r.start_hhmm or "")
        preset = ctx["presets"].get(first.shift_id or "")
        out.update(start=first.start_hhmm or "", grace=(preset.grace_min if preset else 10) or 0,
                   tz=(first.timezone or "").strip() or ((preset.timezone or "") if preset else "") or ctx["team_tz"])
    else:
        preset = ctx["presets"].get(ctx["assigned"].get(em, ""))
        if preset:
            days = {int(x) for x in (preset.days or "").split(",") if x.strip().isdigit()}
            out["source"] = "preset"
            if dd.isoweekday() in days:
                base = max(0, _shift_minutes(preset.start_hhmm, preset.end_hhmm) - int(preset.break_min or 0))
                out.update(start=preset.start_hhmm or "", grace=preset.grace_min or 0,
                           tz=preset.timezone or ctx["team_tz"])
        elif (emp.employment_type or "full_time") == "full_time":
            std = _standard_for(emp, ctx, cfg)
            out["source"] = "standard"
            if dd.isoweekday() in (std.get("days") or []):
                base = int(round(float(std.get("hours") or 0) * 60))
        else:
            out["reason"] = "no_schedule"
            return out
    if base == 0:
        out["reason"] = "not_scheduled"
    factor, minus = 1.0, 0
    h = ctx["holidays"].get(em, {}).get(iso)
    if h:
        if (h.get("type") or "mandatory") == "half_day":
            factor, out["reason"] = 0.5, "holiday_half"
        else:
            base, out["reason"] = 0, "holiday"
    working = set(cfg.get("workingTimeOffTypes") or [])
    for r in ctx["time_off"].get(em, []):
        if not (r.start_date <= iso <= (r.end_date or r.start_date)) or (r.type or "") in working:
            continue
        part = _off_minutes(r)
        if part:
            minus += part
            out["reason"] = out["reason"] or "time_off_partial"
        elif (r.type or "").strip().lower() in ("1/2 day", "half day"):
            factor, out["reason"] = 0.5, "time_off_half"
        else:
            base, out["reason"] = 0, "time_off"
    out["expectedMin"] = max(0, int(round(base * factor)) - minus)
    if out["expectedMin"] > 0 and out["reason"] in ("not_scheduled",):
        out["reason"] = ""
    return out


# ── Actuals ───────────────────────────────────────────────────────────────

def _split_leave(punches: list) -> tuple:
    """(worked, leave) punch lists: each clock-in..clock-out segment goes whole
    to the list its in-punch's job category says (a Sick / PTO category is
    paid leave, timeclock._leave_class). Orphan clock-outs stay with worked so
    the pairing flags them."""
    seg_class = {}
    for s in shift_day.shifts(punches):
        if s["in_id"]:
            seg_class[s["in_id"]] = None
    by_id = {p.id: p for p in punches}
    for in_id in seg_class:
        seg_class[in_id] = _leave_class(getattr(by_id.get(in_id), "category", "") or "")
    worked, leave, current = [], [], ""
    for p in punches:
        if p.kind == "in":
            current = seg_class.get(p.id, "")
        (leave if current else worked).append(p)
        if p.kind == "out":
            current = ""
    return worked, leave


def _local_today(emp, punches: list, ctx: dict) -> date:
    """The employee's own calendar date now: the UTC offset of their latest
    punch in the window (same source as timeclock._employee_today), else the
    zone of their shift preset, else the team zone."""
    if punches:
        off = punches[-1].tz_offset_min or 0
        return (datetime.now(timezone.utc) - timedelta(minutes=off)).date()
    preset = ctx["presets"].get(ctx["assigned"].get(emp.work_email.lower(), ""))
    tz = (preset.timezone if preset else "") or ctx["team_tz"]
    return daily._shift_local_now(tz).date()


def _is_late(first_in_utc: str, dd: date, start: str, grace: int, tz: str):
    """True when the first clock-in is after shift start + grace on the
    shift's own clock; None when there is nothing to judge against."""
    if not (first_in_utc and start and tz):
        return None
    try:
        t = datetime.strptime(first_in_utc[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
        local = t.astimezone(ZoneInfo(tz)).replace(tzinfo=None)
        hh, mm = int(start[:2]), int(start[3:5])
    except (ValueError, TypeError, KeyError, Exception):
        return None
    return local > datetime.combine(dd, dtime(hh, mm)) + timedelta(minutes=int(grace or 0))


# ── Build ─────────────────────────────────────────────────────────────────

def _effective_country(emp, ctx: dict) -> str:
    """The employee's own country, else their company's - one rule for the
    standard day AND the holiday calendar, so a person with no country on
    their record still gets their company's country holidays."""
    return (emp.country or "").strip().upper() or ctx["company_country"].get(emp.company or "", "")


def _holidays(db: Session, people: list, ctx: dict, start: str, end: str) -> dict:
    """{email: {date: {name, type}}} - timeclock._company_holidays_for_many's
    company + country rule (a public holiday applies only to the countries it
    was picked for; a typed-in one to everyone at the company), judged on the
    effective country."""
    companies = {e.company for e in people if e.company}
    if not companies:
        return {}
    by_company = {}
    for r in (db.query(models.HrCompanyHoliday)
              .filter(models.HrCompanyHoliday.company_id.in_(list(companies)),
                      models.HrCompanyHoliday.date >= start, models.HrCompanyHoliday.date <= end).all()):
        by_company.setdefault(r.company_id, []).append(r)
    out = {}
    for e in people:
        country = _effective_country(e, ctx)
        h = {r.date: {"name": r.name, "type": r.type or "mandatory"} for r in by_company.get(e.company or "", [])
             if not r.country_code or country in [c.strip().upper() for c in r.country_code.split(",")]}
        if h:
            out[e.work_email.lower()] = h
    return out


def _context(db: Session, people: list, ws: date, cfg: dict) -> dict:
    """Every table the scorecard reads, loaded once for the whole roster."""
    emails = [e.work_email.lower() for e in people]
    start, end = ws.isoformat(), (ws + timedelta(days=6)).isoformat()
    ctx = {"team_tz": _team_tz(db), "break_cfg": _breakpolicy_cfg(db),
           "scheduled": {}, "assigned": {}, "presets": {}, "time_off": {}, "holidays": {},
           "punches": {}, "activity": {}, "rates": {}, "company_country": {}, "managers": {}}
    if not emails:
        return ctx
    ctx["company_country"] = {r.id: (r.country or "").strip().upper()
                              for r in db.query(models.HrEntity.id, models.HrEntity.country).all()}
    ctx["holidays"] = _holidays(db, people, ctx, start, end)
    for r in (db.query(models.ScheduledShift)
              .filter(func.lower(models.ScheduledShift.employee_email).in_(emails),
                      models.ScheduledShift.work_date >= start, models.ScheduledShift.work_date <= end,
                      models.ScheduledShift.published == 1, models.ScheduledShift.pending_delete == 0).all()):
        ctx["scheduled"].setdefault(r.employee_email.lower(), {}).setdefault(r.work_date, []).append(r)
    for a in db.query(models.ShiftAssignment).filter(func.lower(models.ShiftAssignment.employee_email).in_(emails)).all():
        if a.shift_id:
            ctx["assigned"][a.employee_email.lower()] = a.shift_id
    ctx["presets"] = {p.id: p for p in db.query(models.Shift).all()}
    for r in (db.query(models.TimeOffRequest)
              .filter(func.lower(models.TimeOffRequest.employee_email).in_(emails),
                      models.TimeOffRequest.status == "approved",
                      models.TimeOffRequest.start_date <= end,
                      or_(models.TimeOffRequest.end_date >= start,
                          models.TimeOffRequest.end_date == "", models.TimeOffRequest.end_date.is_(None))).all()):
        ctx["time_off"].setdefault(r.employee_email.lower(), []).append(r)
    # One day either side: a shift that started the day before the week ends
    # inside it (and is NOT ours), one that starts on the last day may end after it.
    p_start, p_end = (ws - timedelta(days=1)).isoformat(), (ws + timedelta(days=7)).isoformat()
    for p in (db.query(models.TimePunch)
              .filter(func.lower(models.TimePunch.employee_email).in_(emails), models.TimePunch.voided == 0,
                      models.TimePunch.local_date >= p_start, models.TimePunch.local_date <= p_end)
              .order_by(models.TimePunch.at).all()):
        ctx["punches"].setdefault(p.employee_email.lower(), []).append(p)
    for em, total, active in (db.query(models.AgentActivity.employee_email,
                                       func.sum(models.AgentActivity.seconds),
                                       func.sum(models.AgentActivity.seconds * models.AgentActivity.active_pct))
                              .filter(func.lower(models.AgentActivity.employee_email).in_(emails),
                                      models.AgentActivity.local_date >= start, models.AgentActivity.local_date <= end)
                              .group_by(models.AgentActivity.employee_email).all()):
        if total:
            ctx["activity"][(em or "").lower()] = int(round((active or 0) / total))
    ctx["rates"] = {(r.employee_email or "").lower(): r for r in
                    db.query(models.PayrollRate).filter(func.lower(models.PayrollRate.employee_email).in_(emails)).all()}
    mgr_emails = {(e.manager_email or "").lower() for e in people if e.manager_email}
    if mgr_emails:
        ctx["managers"] = {m.work_email.lower(): m for m in
                           db.query(models.NexusEmployee).filter(func.lower(models.NexusEmployee.work_email).in_(list(mgr_emails))).all()}
    return ctx


def _name(e) -> str:
    return (f"{e.first_name or ''} {e.last_name or ''}".strip() if e else "") or (e.work_email if e else "")


def _band(expected: int, covered: int, scored_days: list, cfg: dict) -> str:
    if expected == 0:
        reasons = {d["reason"] for d in scored_days}
        return "no_schedule" if reasons and reasons <= {"no_schedule"} else "not_expected"
    if covered == 0:
        return "absent"
    pct = min(100, int(round(100.0 * covered / expected)))
    if pct >= int(cfg.get("onTrackPct") or 95):
        return "on_track"
    if pct >= int(cfg.get("belowPct") or 70):
        return "below"
    return "well_below"


def score_person(emp, ws: date, ctx: dict, cfg: dict, complete: bool = False) -> dict:
    """`complete` scores all seven days (the email: the week has ended
    everywhere by the time it is built); otherwise only the days before the
    employee's own local today (the screen, which may show a week in progress)."""
    em = emp.work_email.lower()
    punches = ctx["punches"].get(em, [])
    rate = ctx["rates"].get(em)
    # The paid rest-break credit only exists under California law (timeclock._break_cfg_for).
    rule = (getattr(rate, "overtime_rule", None) or "ca") if rate else "ca"
    break_cfg = {**ctx["break_cfg"], "enabled": ctx["break_cfg"]["enabled"] and rule == "ca"}
    worked_p, leave_p = _split_leave(punches)
    worked = _day_summaries(worked_p, 0, break_cfg) if worked_p else {}
    leave = _day_summaries(leave_p, 0, break_cfg) if leave_p else {}
    today = ws + timedelta(days=7) if complete else _local_today(emp, punches, ctx)
    tol = int(cfg.get("shortToleranceMin") or 0)
    days, totals = [], {"expectedMin": 0, "workedMin": 0, "leaveMin": 0, "coveredMin": 0, "daysExpected": 0,
                        "daysFull": 0, "daysShort": 0, "daysAbsent": 0, "daysLate": 0, "daysExtra": 0,
                        "missingPunches": 0, "pendingEdits": 0}
    for dd in _days(ws):
        iso = dd.isoformat()
        exp = expected_for_day(emp, dd, ctx, cfg)
        w, lv = worked.get(iso) or {}, leave.get(iso) or {}
        wmin, lmin = int(w.get("workedMin") or 0), int(lv.get("workedMin") or 0)
        covered = wmin + lmin
        flags = sorted(set(w.get("flags") or []) | set(lv.get("flags") or []))
        late = _is_late(w.get("firstIn", ""), dd, exp["start"], exp["grace"], exp["tz"]) if wmin else None
        scored = dd < today
        if not scored:
            status = "today" if dd == today else "upcoming"
        elif exp["expectedMin"] == 0:
            status = "extra" if covered else "off"
        elif covered == 0:
            status = "absent"
        elif covered < exp["expectedMin"] - tol:
            status = "short"
        else:
            status = "full"
        day = {"date": iso, "weekday": DAY_NAMES[dd.weekday()], "status": status, "scored": scored,
               "expectedMin": exp["expectedMin"], "workedMin": wmin, "leaveMin": lmin,
               "source": exp["source"], "reason": exp["reason"], "reasonLabel": DAY_REASONS.get(exp["reason"], ""),
               "shiftStart": exp["start"], "firstIn": w.get("firstIn", ""), "lastOut": w.get("lastOut", ""),
               "late": bool(late), "flags": flags}
        days.append(day)
        if not scored:
            continue
        totals["expectedMin"] += exp["expectedMin"]
        totals["workedMin"] += wmin
        totals["leaveMin"] += lmin
        totals["coveredMin"] += covered
        if exp["expectedMin"]:
            totals["daysExpected"] += 1
        totals["daysFull"] += status == "full"
        totals["daysShort"] += status == "short"
        totals["daysAbsent"] += status == "absent"
        totals["daysExtra"] += status == "extra"
        totals["daysLate"] += bool(late)
        totals["missingPunches"] += any(f in ("missing_out", "out_without_in") for f in flags)
        totals["pendingEdits"] += "edit_pending" in flags
    scored_days = [d for d in days if d["scored"]]
    exp_total, cov_total = totals["expectedMin"], totals["coveredMin"]
    coverage = round(100.0 * cov_total / exp_total, 1) if exp_total else None
    band = _band(exp_total, cov_total, scored_days, cfg)
    mgr = ctx["managers"].get((emp.manager_email or "").lower())
    return {
        "email": em, "name": _name(emp), "jobTitle": emp.job_title or "", "department": emp.department or "",
        "company": emp.company or "", "country": (emp.country or "").upper(),
        "managerEmail": (emp.manager_email or "").lower(), "managerName": _name(mgr) if mgr else "",
        "payType": (getattr(rate, "pay_type", None) or "hourly") if rate else "hourly",
        "employmentType": emp.employment_type or "full_time",
        "coveragePct": coverage,
        "score": min(100, int(round(coverage))) if coverage is not None else None,
        "band": band, "bandLabel": BANDS[band][0],
        "activePct": ctx["activity"].get(em),
        **totals, "days": days,
    }


def build_report(db: Session, scope, cfg: dict, ws: date, kind: str = "", complete: bool = False) -> dict:
    """The scorecard for one week and one scope (None = everyone); `kind` is
    the scope's name (direct | line | all) for the reader; `complete` scores
    every day (see score_person)."""
    people = roster(db, scope, cfg, (ws + timedelta(days=6)).isoformat())
    ctx = _context(db, people, ws, cfg)
    rows = [score_person(e, ws, ctx, cfg, complete) for e in people]
    # Worst first: absent, then lowest coverage; the unscored bands last.
    order = {k: i for i, k in enumerate(BANDS)}
    rows.sort(key=lambda r: (order[r["band"]], r["coveragePct"] if r["coveragePct"] is not None else 999, r["name"].lower()))
    counts = {k: 0 for k in BANDS}
    for r in rows:
        counts[r["band"]] += 1
    scored = [r for r in rows if r["expectedMin"]]
    return {
        "weekStart": ws.isoformat(), "weekEnd": (ws + timedelta(days=6)).isoformat(),
        "scope": kind or ("all" if scope is None else "direct"),
        "generatedAt": _now_iso(),
        "people": rows,
        "summary": {
            "people": len(rows), "scored": len(scored), **counts,
            "expectedMin": sum(r["expectedMin"] for r in rows),
            "workedMin": sum(r["workedMin"] for r in rows),
            "leaveMin": sum(r["leaveMin"] for r in rows),
            "daysAbsent": sum(r["daysAbsent"] for r in rows),
            "daysLate": sum(r["daysLate"] for r in rows),
            "missingPunches": sum(r["missingPunches"] for r in rows),
        },
        "thresholds": {"onTrackPct": cfg.get("onTrackPct"), "belowPct": cfg.get("belowPct"),
                       "shortToleranceMin": cfg.get("shortToleranceMin")},
        "standards": cfg.get("standards"), "payTypes": cfg.get("payTypes"),
    }


# ── Email ─────────────────────────────────────────────────────────────────

def _hrs(minutes: int) -> str:
    return f"{minutes / 60:.1f}h"


def _fmt(d: str) -> str:
    return datetime.strptime(d, "%Y-%m-%d").strftime("%m/%d/%Y")


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _rows_html(rows: list, color: str) -> str:
    th = (f"padding:7px 10px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;"
          f"color:{daily._BODY};text-align:left;background:{daily._SOFT};border-bottom:1px solid {daily._LINE}")
    td = f"padding:8px 10px;font-size:12.5px;color:{daily._INK};border-top:1px solid {daily._LINE};vertical-align:top"
    num = td + ";text-align:right;white-space:nowrap"
    head = "".join(f"<th style='{th}{';text-align:right' if i else ''}'>{escape(h)}</th>"
                   for i, h in enumerate(("Person", "Expected", "Worked", "Leave", "Score", "Absent", "Short", "Late")))
    body = []
    for r in rows:
        who = f"<div style='font-weight:600'>{escape(r['name'])}</div>"
        sub = " - ".join(x for x in (r.get("jobTitle"), r.get("managerName") and f"reports to {r['managerName']}") if x)
        if sub:
            who += f"<div style='font-size:11.5px;color:{daily._MUTED}'>{escape(sub)}</div>"
        notes = []
        if r["missingPunches"]:
            notes.append(_plural(r["missingPunches"], "missing punch"))
        if r.get("activePct") is not None:
            notes.append(f"{r['activePct']}% active at the computer")
        if notes:
            who += f"<div style='font-size:11.5px;color:{daily._MUTED}'>{escape('; '.join(notes))}</div>"
        score = f"{r['score']}%" if r["score"] is not None else "-"
        body.append(f"<tr><td style='{td}'>{who}</td><td style='{num}'>{_hrs(r['expectedMin'])}</td>"
                    f"<td style='{num}'>{_hrs(r['workedMin'])}</td><td style='{num}'>{_hrs(r['leaveMin']) if r['leaveMin'] else '-'}</td>"
                    f"<td style='{num};font-weight:700;color:{color}'>{score}</td>"
                    f"<td style='{num}'>{r['daysAbsent'] or '-'}</td><td style='{num}'>{r['daysShort'] or '-'}</td>"
                    f"<td style='{num}'>{r['daysLate'] or '-'}</td></tr>")
    return (f"<table width='100%' cellpadding='0' cellspacing='0' style='border-collapse:collapse;border:1px solid {daily._LINE}'>"
            f"<tr>{head}</tr>{''.join(body)}</table>")


def _unscored_html(rows: list) -> str:
    items = []
    for r in rows:
        reasons = sorted({d["reasonLabel"] for d in r["days"] if d["scored"] and d["reasonLabel"]})
        why = ", ".join(reasons) if reasons else ("No schedule" if r["band"] == "no_schedule" else "Not expected this week")
        items.append(f"<li style='margin:3px 0'><b>{escape(r['name'])}</b> - {escape(why)}"
                     + (f" (worked {_hrs(r['workedMin'])})" if r["workedMin"] else "") + "</li>")
    return f"<ul style='margin:8px 0 0;padding-left:18px;font-size:12.5px;color:{daily._BODY}'>{''.join(items)}</ul>"


def render(first_name: str, report: dict, scope_label: str, logo_url: str, cfg: dict) -> tuple:
    """(subject, html) - the manager's weekly scorecard email."""
    brand, s = daily._brand(), report["summary"]
    week = f"{_fmt(report['weekStart'])} - {_fmt(report['weekEnd'])}"
    subject = f"Workforce Scorecard - Week of {_fmt(report['weekStart'])}"
    logo = (f"<img src='{escape(logo_url)}' alt='Greens Global' height='26' style='display:block;border:0'>" if logo_url
            else "<span style='color:#ffffff;font-size:14px;font-weight:700;letter-spacing:.18em'>GREENS GLOBAL</span>")
    salutation = f"Hello, {escape(first_name)}." if first_name else "Hello."
    flagged = s["absent"] + s["well_below"] + s["below"]
    intro = (f"{_plural(s['scored'], 'person')} on {scope_label} had expected hours last week: "
             f"{s['on_track']} on track, {flagged} below expected ({s['absent']} absent all week)."
             if s["scored"] else f"Nobody on {scope_label} had expected hours last week.")
    # KPI tiles, solid section color with white text (the briefing's style).
    tiles = [("Scored", s["scored"], daily._BRAND), ("On Track", s["on_track"], BANDS["on_track"][1]),
             ("Below", s["well_below"] + s["below"], BANDS["below"][1]), ("Absent", s["absent"], BANDS["absent"][1])]
    kpi = "".join(f"<td class='nx-kpi' width='25%' bgcolor='{c}' style='{'border-left:6px solid #ffffff;' if i else ''}"
                  f"background:{c};padding:14px 18px;vertical-align:top'>"
                  f"<div style='font-size:24px;font-weight:600;color:#ffffff;line-height:1'>{n}</div>"
                  f"<div style='font-size:12px;color:#ffffff;margin-top:6px'>{escape(lab)}</div></td>"
                  for i, (lab, n, c) in enumerate(tiles))
    sections = []
    by_band = {k: [r for r in report["people"] if r["band"] == k] for k in BANDS}
    url = f"{app_url()}/employee-tracking/scorecard?week={report['weekStart']}"
    for key in ("absent", "well_below", "below", "on_track"):
        rows = by_band[key]
        if not rows:
            continue
        label, color = BANDS[key]
        shown, hidden = rows[:EMAIL_ROW_CAP], rows[EMAIL_ROW_CAP:]
        more = (f"<div style='font-size:12px;color:{daily._MUTED};margin-top:6px'>and {_plural(len(hidden), 'more')} - "
                f"<a href='{escape(url)}' style='color:{daily._LINK}'>open the Scorecard</a></div>" if hidden else "")
        sections.append(f"<tr><td class='nx-pad' style='padding:24px 32px 0'>"
                        f"<div style='font-size:15px;font-weight:600;color:{daily._INK};border-bottom:2px solid {color};padding-bottom:6px;margin-bottom:10px'>"
                        f"{escape(label)} <span style='font-weight:400;color:{daily._MUTED}'>({len(rows)})</span></div>"
                        f"{_rows_html(shown, color)}{more}</td></tr>")
    unscored = by_band["not_expected"] + by_band["no_schedule"]
    if unscored:
        sections.append(f"<tr><td class='nx-pad' style='padding:24px 32px 0'>"
                        f"<div style='font-size:15px;font-weight:600;color:{daily._INK};border-bottom:2px solid {BANDS['not_expected'][1]};padding-bottom:6px'>"
                        f"Not Scored <span style='font-weight:400;color:{daily._MUTED}'>({len(unscored)})</span></div>"
                        f"{_unscored_html(unscored)}</td></tr>")
    std = cfg.get("standards") or {}
    std_text = ", ".join(f"{k} {float(v.get('hours') or 0):g}h" for k, v in std.items() if k != "default")
    rule = (f"Expected hours come from each person's published shifts or shift preset, else the standard day "
            f"({std_text}). Holidays and approved "
            f"time off are excused; Sick / PTO punches count as leave. Score = hours covered / hours expected. "
            f"On Track is {cfg.get('onTrackPct')}% and up, Below Expected {cfg.get('belowPct')}% and up.")
    footer = (f"You receive the Workforce Scorecard every {DAY_NAMES[int(cfg.get('sendDay', 1)) - 1]} for {scope_label}, "
              "covering the last full week. " + rule)
    html = f"""<div style="background:#f3f4f6;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <style>
    @media (max-width:560px) {{
      .nx-wrap {{ border-left:0 !important; border-right:0 !important; }}
      .nx-pad {{ padding-left:16px !important; padding-right:16px !important; }}
      .nx-kpi {{ padding:12px !important; }}
    }}
  </style>
  <table class="nx-wrap" align="center" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:#ffffff;border:1px solid {daily._LINE};border-collapse:collapse">
    <tr><td class="nx-pad" bgcolor="{brand}" style="background:{brand};padding:16px 32px">
      <table width="100%" cellpadding="0" cellspacing="0"><tr><td>{logo}</td>
        <td align="right" style="font-size:12.5px;color:#e8f5ec">{escape(week)}</td></tr></table></td></tr>
    <tr><td class="nx-pad" style="padding:28px 32px 0">
      <div style="font-size:21px;font-weight:600;color:{daily._INK}">Workforce Scorecard</div>
      <div style="font-size:14px;line-height:1.55;color:{daily._BODY};margin-top:6px">{salutation} {escape(intro)}</div></td></tr>
    <tr><td class="nx-pad" style="padding:20px 32px 0"><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>{kpi}</tr></table></td></tr>
    <tr><td class="nx-pad" style="padding:12px 32px 0;font-size:13px">
      <a href="{escape(url)}" style="color:{daily._LINK};font-weight:600;text-decoration:none">Open the Scorecard in Nexus &rarr;</a></td></tr>
    {''.join(sections)}
    <tr><td class="nx-pad" style="padding:32px 32px 28px">
      {daily._button_bar([daily._button("Open the Scorecard", url, brand, pad="10px 22px", size="13px")])}</td></tr>
    <tr><td class="nx-pad" style="background:{daily._SOFT};border-top:1px solid {daily._LINE};padding:16px 32px;font-size:11.5px;line-height:1.6;color:{daily._MUTED}">
      {escape(footer)}</td></tr>
  </table>
</div>"""
    return subject, html


# ── Trigger + send ────────────────────────────────────────────────────────

def _already_logged(db: Session, email: str, week: str) -> bool:
    return (db.query(models.NexusWorkforceScorecardLog)
            .filter(models.NexusWorkforceScorecardLog.manager_email == email.lower(),
                    models.NexusWorkforceScorecardLog.week_start == week).first()) is not None


def send_time(cfg: dict) -> dtime:
    m = _HHMM.match(str(cfg.get("sendTime") or ""))
    return dtime(int(m.group(1)), int(m.group(2))) if m else dtime(8, 0)


def week_over_everywhere(ws: date, cfg: dict) -> bool:
    """True once the scored week's last day has ended in the default zone -
    the latest zone the company works in (America/Los_Angeles by default).
    A manager in India at Monday 8 AM is still Sunday evening in California;
    an email built then would catch a US employee's Sunday mid-shift, score
    it short, and the week's log row would then block a correct resend."""
    return daily._shift_local_now(daily._default_zone(cfg)).date() > ws + timedelta(days=6)


def trigger_due(db: Session, email: str, cfg: dict) -> tuple:
    """(due, week_start, local_now): due from sendTime to the end of the send
    day, in the manager's own zone (their shift preset's, else the default),
    for the last complete week - once that week is over everywhere
    (week_over_everywhere) and unless it is already logged."""
    local_now = daily._shift_local_now(daily._person_zone(db, email, cfg))
    today = local_now.date()
    if today.isoweekday() != int(cfg.get("sendDay") or 1):
        return False, None, local_now
    if local_now < datetime.combine(today, send_time(cfg)):
        return False, None, local_now
    ws = last_complete_week(today, cfg)
    if not week_over_everywhere(ws, cfg) or _already_logged(db, email, ws.isoformat()):
        return False, None, local_now
    return True, ws, local_now


def compose(db: Session, emp, scope, cfg: dict, ws: date, kind: str) -> tuple:
    """(report, subject, html) for one manager - the week scored as complete."""
    report = build_report(db, scope, cfg, ws, kind, complete=True)
    subject, html = render((emp.first_name or "").strip(), report, SCOPE_LABEL.get(kind, SCOPE_LABEL["direct"]),
                           daily._logo_url(db), cfg)
    return report, subject, html


def send_test(db: Session, emp, scope, cfg: dict, to: list, ws: date, kind: str, test: bool = True) -> dict:
    """Builds this manager's real scorecard now and mails it ONLY to `to`,
    whatever the mode or day. Writes no log row. `test` marks the subject
    "[TEST -> manager]" - an admin's test send; a manager mailing themselves
    (Email Me This Report) gets the plain subject."""
    report, subject, html = compose(db, emp, scope, cfg, ws, kind)
    counts = {"peopleCount": report["summary"]["people"], "absentCount": report["summary"]["absent"],
              "belowCount": report["summary"]["below"] + report["summary"]["well_below"]}
    if not report["people"]:
        return {"sent": False, **counts}
    graph_mail.send_mail(from_email=graph_mail.DEFAULT_FROM_EMAIL, to=to, cc=None,
                         subject=f"[TEST -> {emp.work_email}] {subject}" if test else subject, html=html)
    return {"sent": True, **counts}


def send_one(db: Session, emp, scope, cfg: dict, ws: date, kind: str) -> dict:
    """Builds, sends (per mode) and logs one manager's scorecard. Commits."""
    mode = cfg.get("mode", "off")
    report, subject, html = compose(db, emp, scope, cfg, ws, kind)
    s = report["summary"]
    sent_at = ""
    if mode in ("test", "live") and report["people"]:
        to = [emp.work_email] if mode == "live" else list(cfg.get("test_recipients") or [])
        if mode == "test":
            subject = f"[TEST -> {emp.work_email}] {subject}"
        if to:
            try:
                graph_mail.send_mail(from_email=graph_mail.DEFAULT_FROM_EMAIL, to=to, cc=None, subject=subject, html=html)
                sent_at = _now_iso()
            except graph_mail.GraphMailError as e:
                print(f"[workforce-scorecard] send failed for {emp.work_email}: {e}")
    db.add(models.NexusWorkforceScorecardLog(
        id=str(uuid.uuid4()), manager_email=emp.work_email.lower(), week_start=ws.isoformat(),
        scope=report["scope"], sent_at=sent_at, mode=mode,
        people_count=s["people"], absent_count=s["absent"], below_count=s["below"] + s["well_below"],
        created_at=_now_iso()))
    db.commit()
    return {"sent": bool(sent_at), "mode": mode, "hadContent": bool(report["people"])}


def acquire_lock(db: Session, email: str) -> None:
    """Per-manager transaction-scoped advisory lock, so two workers scanning
    at once cannot both send (see daily_briefing._acquire_employee_lock)."""
    if db.bind.dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(CAST(:ns AS integer), hashtext(:email))"),
                   {"ns": _LOCK_NS, "email": email})


def _scan_once() -> int:
    db = SessionLocal()
    sent = 0
    try:
        cfg = get_settings(db)
        for emp, scope, kind in recipients(db, cfg):
            try:
                acquire_lock(db, emp.work_email)
                due, ws, _ = trigger_due(db, emp.work_email, cfg)
                if not due:
                    db.rollback()
                    continue
                send_one(db, emp, scope, cfg, ws, kind)
                sent += 1
            except Exception as e:
                db.rollback()
                print(f"[workforce-scorecard] scan failed for {emp.work_email}: {e}")
        return sent
    finally:
        db.close()


async def scorecard_loop():
    await asyncio.sleep(120)
    while True:
        try:
            n = await asyncio.to_thread(_scan_once)
            if n:
                print(f"[workforce-scorecard] scan complete - {n} scorecard(s) logged")
        except Exception as e:
            print(f"[workforce-scorecard] loop error: {e}")
        await asyncio.sleep(SCAN_EVERY_SEC)
