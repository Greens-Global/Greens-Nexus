"""
The ONE rule for "when was this person expected to start on this day" and
"are they late against it" (Shifts Phase 0, Oct 2026).

Before this module three screens answered that question three ways for the
same person on the same day: the live Late status on the timecard
(routers/timeclock._shift_start_for - first placement, unordered, grace 10
when no preset, zone from the preset only), the My Team tile
(routers/my_team - its own lookup with a fixed 15-minute grace) and the
Workforce Scorecard (workforce_scorecard.expected_for_day / _is_late -
earliest placement, zone placement -> preset -> team). They now all read
`pick_start` here; the timecard and the Daily Briefing go through
`expected_start`, My Team and the no-show scans through `expected_starts`
(bulk, one query per table for a whole team), the scorecard feeds
`pick_start` the rows it already prefetched for the week.

The rule (`pick_start`):
  1. PUBLISHED placements (scheduled_shifts) on that exact date win. A day a
     weather call cancelled is not a shift: when placements exist but every
     one is cancelled the answer is None, and the preset below never stands
     in for it (Weather Call, Oct 12). Among several live placements the
     EARLIEST start is the one to be on time for. Grace = the placement's
     preset grace_min when it has a preset, else the company default
     (`default_grace_min`). Zone = the placement's own timezone column, else
     its preset's, else the team zone.
  2. Else the person's assigned Shift preset, on its working days
     (`days` = ISO weekday numbers "1,2,3,4,5", Mon=1): start/end/grace/zone
     from the preset, zone falling back to the team zone.
  3. Else None - nothing to be late for.

Late (`is_late_at` for a day with a clock-in, `late_now` for a day with
none yet) is judged on the SHIFT'S OWN zone clock: a 9:00 IST shift is read
on an IST clock wherever the person last punched from. `is_late_at` is the
scorecard's math (clock-in strictly after start + grace, None when there is
nothing to judge); `late_now` is the timecard's (start + grace reached, to
the minute, with no clock-in).

Company defaults come from the Shifts settings (`routers.shift_requests.
get_settings`): `timeZone` for the team zone and `defaultGraceMin` for a
placement with no preset - both read per call with safe fallbacks, so this
works whether or not the settings row carries them. They are read PER
COMPANY (Phase 0 review, Oct 14): a person's defaults are their company's
(`nexus_employees.company`, its override layered on the tenant row), an
untagged person's the tenant's - `defaults_for` / `defaults_by_company`.

Never imports routers.timeclock at module import time (timeclock will
import this module); the settings reader is imported inside the functions.
"""
from datetime import date, datetime, time as dtime, timedelta, timezone
from typing import Iterable, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func
from sqlalchemy.orm import Session

import models

DEFAULT_TEAM_TZ = "America/Los_Angeles"
DEFAULT_GRACE_MIN = 10
_FALLBACK_START = "09:00"


# ── Company defaults ──────────────────────────────────────────────────────

def _settings(db: Session, company_id: str = "") -> dict:
    try:
        from routers.shift_requests import get_settings
        return get_settings(db, company_id or "") or {}
    except Exception:
        return {}


def team_tz(db: Session, company_id: str = "") -> str:
    """The team time zone (Shifts settings, Teams "Team time zone") - what a
    shift with no zone of its own and no preset runs on. With `company_id`,
    that company's (its override, else the tenant's)."""
    return str(_settings(db, company_id).get("timeZone") or "").strip() or DEFAULT_TEAM_TZ


def default_grace_min(db: Session, company_id: str = "") -> int:
    """Grace minutes for a placement that has no preset to take them from:
    the Shifts setting `defaultGraceMin` (that company's when `company_id`
    names one), else 10."""
    try:
        v = int(_settings(db, company_id).get("defaultGraceMin", DEFAULT_GRACE_MIN))
    except (TypeError, ValueError):
        return DEFAULT_GRACE_MIN
    return v if v >= 0 else DEFAULT_GRACE_MIN


def companies_of(db: Session, emails: Iterable[str]) -> dict:
    """{email(lower): HrEntity company id or ''} from nexus_employees for the
    emails given; an email with no People row is simply absent ('' = tenant)."""
    emails_l = _lower(emails)
    if not emails_l:
        return {}
    return {(em or "").lower(): (c or "").strip() for em, c in
            db.query(models.NexusEmployee.work_email, models.NexusEmployee.company)
            .filter(func.lower(models.NexusEmployee.work_email).in_(emails_l)).all() if em}


def defaults_by_company(db: Session, company_ids: Iterable[str]) -> dict:
    """{company id: (team_tz, default_grace)} - one settings read per
    company, the tenant ('') always included as the fallback."""
    return {c: (team_tz(db, c), default_grace_min(db, c)) for c in ({""} | {(c or "").strip() for c in company_ids})}


def defaults_for(db: Session, email: str) -> tuple:
    """(team_tz, default_grace) that apply to one person: their company's."""
    cid = companies_of(db, [email]).get((email or "").strip().lower(), "")
    return team_tz(db, cid), default_grace_min(db, cid)


# ── Pieces ────────────────────────────────────────────────────────────────

def zone(tz: str) -> ZoneInfo:
    """An IANA zone, America/Los_Angeles for an unset or invalid name (the
    timecard's _shift_local_now rule)."""
    try:
        return ZoneInfo(tz or DEFAULT_TEAM_TZ)
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        return ZoneInfo(DEFAULT_TEAM_TZ)


def _hhmm_minutes(hhmm: str) -> Optional[int]:
    try:
        hh, mm = (int(x) for x in str(hhmm or "").split(":")[:2])
    except (TypeError, ValueError):
        return None
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        return None
    return hh * 60 + mm


def preset_days(preset) -> set:
    """The ISO weekday numbers a preset works (Mon=1 .. Sun=7)."""
    return {int(x) for x in str(getattr(preset, "days", "") or "").split(",") if x.strip().isdigit()}


def _grace_of(preset, default_grace: int) -> int:
    g = getattr(preset, "grace_min", None) if preset is not None else None
    if g is None:
        return int(default_grace)
    try:
        return max(0, int(g))
    except (TypeError, ValueError):
        return int(default_grace)


def _is_live(row) -> bool:
    return (getattr(row, "weather_status", "") or "") != "cancelled"


def pick_start(placed_rows: Iterable, presets_by_id: dict, assigned_shift_id: str, dd: date,
               team_tz: str, default_grace: int) -> Optional[dict]:
    """The expected shift for one person on `dd`, or None. Pure: works on
    rows already in hand (see the module docstring for the rule).

    Returns {start, end, grace, tz, source: 'scheduled'|'preset', shiftId,
    rowId}; start/end are HH:MM wall-clock in `tz`."""
    iso = dd.isoformat()
    fallback_tz = (team_tz or "").strip() or DEFAULT_TEAM_TZ
    presets = presets_by_id or {}
    todays = [r for r in (placed_rows or [])
              if int(getattr(r, "published", 0) or 0) == 1 and (getattr(r, "work_date", "") or "") == iso]
    if todays:
        live = [r for r in todays if _is_live(r)]
        if not live:
            return None    # the day was called off - never late, no preset fallback
        first = min(live, key=lambda r: (_hhmm_minutes(r.start_hhmm) if _hhmm_minutes(r.start_hhmm) is not None
                                         else _hhmm_minutes(_FALLBACK_START), r.id or ""))
        preset = presets.get(first.shift_id or "") if first.shift_id else None
        tz = ((getattr(first, "timezone", "") or "").strip()
              or ((preset.timezone or "").strip() if preset is not None else "")
              or fallback_tz)
        return {"start": first.start_hhmm or _FALLBACK_START, "end": first.end_hhmm or "",
                "grace": _grace_of(preset, default_grace), "tz": tz, "source": "scheduled",
                "shiftId": first.shift_id or "", "rowId": first.id or ""}
    preset = presets.get(assigned_shift_id or "") if assigned_shift_id else None
    if preset is None or dd.isoweekday() not in preset_days(preset):
        return None
    return {"start": preset.start_hhmm or _FALLBACK_START, "end": preset.end_hhmm or "",
            "grace": _grace_of(preset, default_grace),
            "tz": (preset.timezone or "").strip() or fallback_tz, "source": "preset",
            "shiftId": preset.id or "", "rowId": ""}


# ── Database forms ────────────────────────────────────────────────────────

def _lower(emails: Iterable[str]) -> list:
    return sorted({(e or "").strip().lower() for e in (emails or []) if (e or "").strip()})


def expected_starts(db: Session, emails: Iterable[str], dd: date) -> dict:
    """{email(lower): pick_start result or None} for a whole team on one day -
    one query each for that day's placements, the assignments and the
    presets involved. Every requested email is a key."""
    emails_l = _lower(emails)
    if not emails_l:
        return {}
    iso = dd.isoformat()
    by_email: dict = {}
    for r in (db.query(models.ScheduledShift)
              .filter(func.lower(models.ScheduledShift.employee_email).in_(emails_l),
                      models.ScheduledShift.work_date == iso,
                      models.ScheduledShift.published == 1).all()):
        by_email.setdefault((r.employee_email or "").lower(), []).append(r)
    assigned: dict = {}
    for a in (db.query(models.ShiftAssignment)
              .filter(func.lower(models.ShiftAssignment.employee_email).in_(emails_l))
              .order_by(models.ShiftAssignment.assigned_at.desc(), models.ShiftAssignment.id).all()):
        if a.shift_id:
            assigned.setdefault((a.employee_email or "").lower(), a.shift_id)
    preset_ids = {r.shift_id for rows in by_email.values() for r in rows if r.shift_id} | set(assigned.values())
    presets = ({p.id: p for p in db.query(models.Shift).filter(models.Shift.id.in_(sorted(preset_ids))).all()}
               if preset_ids else {})
    company = companies_of(db, emails_l)
    defaults = defaults_by_company(db, company.values())
    return {em: pick_start(by_email.get(em, []), presets, assigned.get(em, ""), dd, *defaults[company.get(em, "")])
            for em in emails_l}


def expected_start(db: Session, email: str, dd: date) -> Optional[dict]:
    """One person's expected shift on `dd` (see pick_start), or None."""
    return expected_starts(db, [email], dd).get((email or "").strip().lower())


def schedule_exists(db: Session, emails: Iterable[str], dd: date) -> bool:
    """Whether anyone in `emails` has a schedule at all on `dd`: a published
    placement that day (even one a weather call cancelled) or an assigned
    preset that still exists (even on one of its days off). What a tile uses
    to decide whether a Late count means anything."""
    emails_l = _lower(emails)
    if not emails_l:
        return False
    if (db.query(models.ScheduledShift.id)
            .filter(func.lower(models.ScheduledShift.employee_email).in_(emails_l),
                    models.ScheduledShift.work_date == dd.isoformat(),
                    models.ScheduledShift.published == 1).first()):
        return True
    return bool(db.query(models.ShiftAssignment.id)
                .join(models.Shift, models.Shift.id == models.ShiftAssignment.shift_id)
                .filter(func.lower(models.ShiftAssignment.employee_email).in_(emails_l)).first())


# ── Late ──────────────────────────────────────────────────────────────────

def start_local(dd: date, exp: Optional[dict]) -> Optional[datetime]:
    """The shift start as a naive wall-clock datetime in the shift's zone."""
    if not exp or not exp.get("start"):
        return None
    m = _hhmm_minutes(exp["start"])
    if m is None:
        return None
    return datetime.combine(dd, dtime(m // 60, m % 60))


def start_utc(dd: date, exp: Optional[dict]) -> Optional[datetime]:
    """The shift start as an aware UTC datetime (for stamps the browser shows)."""
    local = start_local(dd, exp)
    if local is None:
        return None
    return local.replace(tzinfo=zone(exp.get("tz", ""))).astimezone(timezone.utc)


def end_local(dd: date, start_hhmm: str, end_hhmm: str) -> Optional[datetime]:
    """The shift's end as a naive wall-clock datetime: `dd` at end_hhmm,
    the NEXT day when the end is at or before the start (a 10 PM - 6 AM
    shift ends on the morning after). None when either time is unusable
    or the shift has no length."""
    s, e = _hhmm_minutes(start_hhmm), _hhmm_minutes(end_hhmm)
    if s is None or e is None or s == e:
        return None
    day = dd if e > s else dd + timedelta(days=1)
    return datetime.combine(day, dtime(e // 60, e % 60))


def to_utc(local: Optional[datetime], tz: str) -> Optional[datetime]:
    """A naive wall-clock datetime in zone `tz` -> aware UTC. Wall time is
    what the schedule says ("6:00 AM"), so a shift across a DST change
    is one hour shorter or longer in real time, as it is on the ground -
    never computed as start + a fixed length."""
    if local is None:
        return None
    return local.replace(tzinfo=zone(tz)).astimezone(timezone.utc)


def end_utc(dd: date, exp: Optional[dict]) -> Optional[datetime]:
    """The shift end as an aware UTC datetime, from its wall-clock end in
    the shift's own zone (DST-safe: see to_utc)."""
    if not exp:
        return None
    return to_utc(end_local(dd, exp.get("start") or "", exp.get("end") or ""), exp.get("tz", ""))


def span_utc(dd: date, start_hhmm: str, end_hhmm: str, tz: str) -> Optional[tuple]:
    """(start, end) as aware UTC datetimes for a shift on `dd` in `tz`, or
    None when the times do not parse or the shift has no length."""
    s = _hhmm_minutes(start_hhmm)
    e = end_local(dd, start_hhmm, end_hhmm)
    if s is None or e is None:
        return None
    return to_utc(datetime.combine(dd, dtime(s // 60, s % 60)), tz), to_utc(e, tz)


def is_late_at(first_in_utc_iso: str, dd: date, exp: Optional[dict]):
    """True when the first clock-in (UTC stamp, punch-table shape) is after
    shift start + grace on the shift's own clock, False when it is not, None
    when there is nothing to judge (no clock-in or no shift)."""
    if not first_in_utc_iso or not exp:
        return None
    deadline = start_local(dd, exp)
    if deadline is None or not exp.get("tz"):
        return None
    try:
        t = datetime.strptime(str(first_in_utc_iso)[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None
    local = t.astimezone(zone(exp.get("tz", ""))).replace(tzinfo=None)
    return local > deadline + timedelta(minutes=int(exp.get("grace") or 0))


def late_now(dd: date, exp: Optional[dict], now_utc: Optional[datetime] = None) -> bool:
    """Whether a person with NO clock-in yet is late right now: shift start +
    grace has been reached (to the minute) on the shift's own zone clock.
    False when there is no shift to be late for."""
    deadline = start_local(dd, exp)
    if deadline is None:
        return False
    now = now_utc or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    local = now.astimezone(zone(exp.get("tz", ""))).replace(tzinfo=None, second=0, microsecond=0)
    return local >= deadline + timedelta(minutes=int(exp.get("grace") or 0))
