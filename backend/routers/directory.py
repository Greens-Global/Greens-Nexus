"""Contact Directory (Support > Contact Directory, Oct 2026).

Every internal person in the company, with just enough to reach them: name,
title, department, company, office, phones, manager, photo - and whether they
are reachable TODAY (time off, leave, company holiday, clocked in / on break /
clocked out, scheduled shift). Open to every signed-in internal user; the
Support tile used to point at a view that no longer existed, so nobody below
the HR grant could look anyone up.

What this deliberately is NOT: the HR People record. No personal email, home
address, pay, compliance, start date or status history ever leaves here - the
payload is built from an allowlist of contact fields, never from
hr._serialize. Externals and guests are neither listed nor allowed to call it
(a partner must not be able to pull the whole company's phone list).

Reach-me-first (Neil, 10/09): the screen leads with Teams chat / call / video;
the mobile number is shown to everyone but sits under the Teams actions.

Two halves, cached differently:
  * the roster (people, departments, companies) changes on HR edits and the
    M365 sync - cached per company-wall key in cache.contact_directory and
    dropped on any NexusEmployee / HrEntity / HrDepartment commit;
  * availability changes every time someone punches or a request is approved -
    computed on every call from a handful of date-bounded queries (today's
    punches, today's time off, today's leave, today's holidays, today's
    shifts), never per person, so the cost stays flat as the roster grows.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

import auth
import cache
from database import get_db
from models import (HrCompanyHoliday, HrDepartment, HrEntity, HrLeaveRequest, NexusEmployee,
                    ScheduledShift, TimeOffRequest, TimePunch)
from auth import get_current_user

router = APIRouter(prefix="/directory", tags=["directory"])

# A person's clock, best effort, for "local time" and for which calendar day
# is "today" for them. A recent punch carries the exact UTC offset the browser
# reported and wins; otherwise the US state, then the country. Unknown = the
# company's home zone.
_DEFAULT_TZ = "America/Los_Angeles"
_COUNTRY_TZ = {
    "US": "America/Los_Angeles", "IN": "Asia/Kolkata", "CA": "America/Toronto", "GB": "Europe/London",
    "MX": "America/Mexico_City", "PH": "Asia/Manila", "AE": "Asia/Dubai", "AU": "Australia/Sydney",
    "DE": "Europe/Berlin", "FR": "Europe/Paris", "SG": "Asia/Singapore", "PK": "Asia/Karachi",
    "BD": "Asia/Dhaka", "NP": "Asia/Kathmandu", "LK": "Asia/Colombo", "JP": "Asia/Tokyo",
    "BR": "America/Sao_Paulo", "CO": "America/Bogota", "AR": "America/Argentina/Buenos_Aires",
    "ZA": "Africa/Johannesburg", "NG": "Africa/Lagos", "KE": "Africa/Nairobi", "EG": "Africa/Cairo",
}
_US_STATE_TZ = {
    "CA": "America/Los_Angeles", "WA": "America/Los_Angeles", "OR": "America/Los_Angeles", "NV": "America/Los_Angeles",
    "AZ": "America/Phoenix", "UT": "America/Denver", "CO": "America/Denver", "NM": "America/Denver",
    "MT": "America/Denver", "WY": "America/Denver", "ID": "America/Boise",
    "TX": "America/Chicago", "IL": "America/Chicago", "MN": "America/Chicago", "WI": "America/Chicago",
    "MO": "America/Chicago", "OK": "America/Chicago", "KS": "America/Chicago", "NE": "America/Chicago",
    "IA": "America/Chicago", "AR": "America/Chicago", "LA": "America/Chicago", "MS": "America/Chicago",
    "AL": "America/Chicago", "TN": "America/Chicago", "SD": "America/Chicago", "ND": "America/Chicago",
    "NY": "America/New_York", "NJ": "America/New_York", "FL": "America/New_York", "GA": "America/New_York",
    "NC": "America/New_York", "SC": "America/New_York", "VA": "America/New_York", "MD": "America/New_York",
    "PA": "America/New_York", "MA": "America/New_York", "CT": "America/New_York", "OH": "America/New_York",
    "MI": "America/New_York", "IN": "America/New_York", "KY": "America/New_York", "WV": "America/New_York",
    "DE": "America/New_York", "DC": "America/New_York", "VT": "America/New_York", "NH": "America/New_York",
    "ME": "America/New_York", "RI": "America/New_York",
    "HI": "Pacific/Honolulu", "AK": "America/Anchorage",
}
_STATE_NAMES = {   # the M365 sync stores whatever the admin typed - names as well as codes
    "california": "CA", "washington": "WA", "oregon": "OR", "nevada": "NV", "arizona": "AZ", "utah": "UT",
    "colorado": "CO", "new mexico": "NM", "texas": "TX", "illinois": "IL", "new york": "NY", "new jersey": "NJ",
    "florida": "FL", "georgia": "GA", "north carolina": "NC", "virginia": "VA", "pennsylvania": "PA",
    "massachusetts": "MA", "ohio": "OH", "michigan": "MI", "minnesota": "MN", "hawaii": "HI", "alaska": "AK",
}
# How a punch state and a shift read in the UI. The label is the whole story
# on the card; the detail (a time) sits beside it on the profile.
_PUNCH_STATE = {"in": "in", "break_end": "in", "break_start": "break", "out": "out"}
_PUNCH_LABEL = {"in": "Clocked In", "break": "On Break", "out": "Clocked Out"}
_RECENT_PUNCH_DAYS = 30


def _tz_name(emp, punch_offset_min) -> str:
    """IANA zone for a person. The punch offset is exact but has no name;
    the map gives a name whose offset agrees with it when one is known."""
    state = (emp.state or "").strip()
    code = state.upper() if len(state) == 2 else _STATE_NAMES.get(state.lower(), "")
    country = (emp.country or "").strip().upper()
    guess = (_US_STATE_TZ.get(code) if country in ("US", "") else None) or _COUNTRY_TZ.get(country) or _DEFAULT_TZ
    if punch_offset_min is None:
        return guess
    # JS getTimezoneOffset() is minutes BEHIND UTC (PDT = 420). Prefer the
    # guessed zone when it agrees; otherwise find any mapped zone that does.
    want = -int(punch_offset_min)
    now = datetime.now(timezone.utc)
    for name in [guess, *_US_STATE_TZ.values(), *_COUNTRY_TZ.values()]:
        try:
            off = now.astimezone(ZoneInfo(name)).utcoffset()
        except Exception:   # noqa: BLE001 - a zone the host lacks
            continue
        if off is not None and int(off.total_seconds() // 60) == want:
            return name
    return guess


def _local_now(tz: str) -> datetime:
    try:
        return datetime.now(ZoneInfo(tz))
    except Exception:   # noqa: BLE001
        return datetime.now(ZoneInfo(_DEFAULT_TZ))


def _hhmm_label(hhmm: str) -> str:
    """'17:30' -> '5:30 PM' (US time format, CLAUDE.md)."""
    try:
        h, m = (hhmm or "").split(":")[:2]
        h, m = int(h), int(m)
    except (ValueError, AttributeError):
        return hhmm or ""
    suffix = "AM" if h < 12 else "PM"
    h12 = h % 12 or 12
    return f"{h12}:{m:02d} {suffix}"


def _mmdd(iso: str) -> str:
    try:
        y, m, d = iso.split("-")
        return f"{int(m):02d}/{int(d):02d}/{y}"
    except (ValueError, AttributeError):
        return iso or ""


def _is_lead(dept, email) -> str:
    if not dept:
        return ""
    if email == (dept.lead_email or "").lower():
        return "lead"
    if email == (dept.backup_email or "").lower():
        return "backup"
    return ""


def _roster(db: Session, scope) -> dict:
    """The cacheable half: everyone the caller may see, contact fields only."""
    q = (db.query(NexusEmployee)
           .filter(NexusEmployee.status != "offboarded")
           .filter(NexusEmployee.work_email != "")
           .filter(or_(NexusEmployee.identity_type.is_(None),
                       NexusEmployee.identity_type.notin_(("guest", "external")))))
    if scope is not None:
        q = q.filter(NexusEmployee.company.in_(list(scope))) if scope else q.filter(NexusEmployee.id == "")
    rows = q.order_by(NexusEmployee.first_name, NexusEmployee.last_name).all()
    entities = {e.id: e for e in db.query(HrEntity).all()}
    depts = db.query(HrDepartment).order_by(HrDepartment.sort_order, HrDepartment.name).all()
    by_company_dept = {((d.company_id or ""), (d.name or "").strip().lower()): d for d in depts}
    by_email = {(e.work_email or "").lower(): e for e in rows}

    from routers.myhr import _person_name

    people = []
    for e in rows:
        email = (e.work_email or "").lower()
        dept = by_company_dept.get((e.company or "", (e.department or "").strip().lower()))
        mgr = by_email.get((e.manager_email or "").lower())
        people.append({
            "email": email,
            "name": _person_name(e),
            "firstName": e.first_name or "",
            "lastName": e.last_name or "",
            "jobTitle": e.job_title or "",
            "designation": e.designation or "",
            "department": e.department or "",
            "departmentRole": _is_lead(dept, email),          # lead | backup | ''
            "division": e.division or "",
            "company": e.company or "",
            "companyName": entities[e.company].name if e.company in entities else "",
            "location": e.location or "",
            "city": e.city or "",
            "state": e.state or "",
            "country": (e.country or "").upper(),
            "officePhone": e.office_phone or "",
            "mobile": e.phone or "",
            "managerEmail": (e.manager_email or "").lower(),
            "managerName": _person_name(mgr) if mgr else "",
            "photoUrl": e.photo_url or "",
            "linkedinUrl": e.linkedin_url or "",
            "status": e.status or "active",                    # onboarding | active | inactive
            "employmentType": e.employment_type or "",
            "_id": e.id,                                       # for the leave join; stripped before send
        })
    companies = sorted({p["company"] for p in people if p["company"]})
    return {
        "people": people,
        "departments": [{"id": d.id, "name": d.name, "companyId": d.company_id,
                         "leadEmail": (d.lead_email or "").lower(), "backupEmail": (d.backup_email or "").lower()}
                        for d in depts if d.company_id in companies or scope is None],
        "companies": [{"id": cid, "name": entities[cid].name if cid in entities else cid} for cid in companies],
    }


def _availability(db: Session, people: list) -> None:
    """Stamp each person with today's state, in THEIR day. One query per
    source, bounded to a three-day window around UTC today (every zone's
    'today' falls inside it), then matched per person in memory."""
    utc_today = datetime.now(timezone.utc).date()
    window = [(utc_today + timedelta(days=d)).isoformat() for d in (-1, 0, 1)]
    emails = [p["email"] for p in people]
    if not emails:
        return
    by_email = {p["email"]: p for p in people}
    by_id = {p["_id"]: p for p in people}

    # Latest punch per person in the last month: its offset is the person's
    # real clock, and today's last punch is their clock state.
    since = (datetime.now(timezone.utc) - timedelta(days=_RECENT_PUNCH_DAYS)).isoformat()
    punches = (db.query(TimePunch)
                 .filter(TimePunch.at >= since, TimePunch.voided == 0)
                 .filter(func.lower(TimePunch.employee_email).in_(emails))
                 .order_by(TimePunch.at.asc()).all())
    last_punch = {}
    for pu in punches:
        last_punch[(pu.employee_email or "").lower()] = pu     # ascending order -> the last one wins

    for p in people:
        pu = last_punch.get(p["email"])
        p["timeZone"] = _tz_name(_Emp(p), pu.tz_offset_min if pu else None)
        p["today"] = _local_now(p["timeZone"]).date().isoformat()
        p["availability"] = None

    # Clock state - only when the last punch is from the person's today.
    for p in people:
        pu = last_punch.get(p["email"])
        if not pu or (pu.local_date or pu.at[:10]) != p["today"]:
            continue
        state = _PUNCH_STATE.get(pu.kind)
        if not state:
            continue
        at = _in_zone(pu.at, p["timeZone"])
        p["availability"] = {"state": state, "label": _PUNCH_LABEL[state],
                             "detail": f"since {at}" if state != "out" else f"at {at}"}

    # Scheduled shift today (published only) - fills in when there is no punch yet.
    shifts = (db.query(ScheduledShift)
                .filter(ScheduledShift.work_date.in_(window), ScheduledShift.published == 1)
                .filter(func.lower(ScheduledShift.employee_email).in_(emails)).all())
    for s in shifts:
        p = by_email.get((s.employee_email or "").lower())
        if p and s.work_date == p["today"] and p["availability"] is None:
            p["availability"] = {"state": "scheduled", "label": "Scheduled",
                                 "detail": f"{_hhmm_label(s.start_hhmm)} - {_hhmm_label(s.end_hhmm)}"}

    # Time off (Time module), approved, covering today. Confidential or not,
    # the directory only ever says "Time Off" - never the type or the note.
    offs = (db.query(TimeOffRequest)
              .filter(TimeOffRequest.status == "approved")
              .filter(TimeOffRequest.start_date <= window[-1], TimeOffRequest.end_date >= window[0])
              .filter(func.lower(TimeOffRequest.employee_email).in_(emails)).all())
    for r in offs:
        p = by_email.get((r.employee_email or "").lower())
        if not p or not (r.start_date <= p["today"] <= r.end_date):
            continue
        if r.start_time and r.end_time and r.start_date == r.end_date:
            av = {"state": "partial", "label": "Out Part of Today",
                  "detail": f"{_hhmm_label(r.start_time)} - {_hhmm_label(r.end_time)}"}
            if p["availability"] is None or p["availability"]["state"] == "scheduled":
                p["availability"] = av
            continue
        back = r.end_date > p["today"]
        p["availability"] = {"state": "off", "label": "Off Today",
                             "detail": f"through {_mmdd(r.end_date)}" if back else ""}

    # Leave (HR module), approved, covering today - keyed by employee id.
    leaves = (db.query(HrLeaveRequest)
                .filter(HrLeaveRequest.status == "approved")
                .filter(HrLeaveRequest.start_date <= window[-1], HrLeaveRequest.end_date >= window[0])
                .filter(HrLeaveRequest.employee_id.in_(list(by_id))).all())
    for r in leaves:
        p = by_id.get(r.employee_id)
        if p and r.start_date <= p["today"] <= r.end_date:
            p["availability"] = {"state": "off", "label": "On Leave",
                                 "detail": f"through {_mmdd(r.end_date)}" if r.end_date > p["today"] else ""}

    # Company holiday today - unless the person is working anyway (a punch or
    # a published shift on the day says so).
    hols = db.query(HrCompanyHoliday).filter(HrCompanyHoliday.date.in_(window)).all()
    hol_by = {}
    for h in hols:
        hol_by.setdefault((h.company_id, h.date), h.name)
    for p in people:
        name = hol_by.get((p["company"], p["today"]))
        if name and (p["availability"] is None or p["availability"]["state"] == "out"):
            p["availability"] = {"state": "holiday", "label": "Company Holiday", "detail": name}


class _Emp:
    """Duck-typed view of a roster dict for _tz_name (state / country)."""
    __slots__ = ("state", "country")

    def __init__(self, p: dict):
        self.state = p.get("state", "")
        self.country = p.get("country", "")


def _in_zone(iso: str, tz: str) -> str:
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return _hhmm_label(dt.astimezone(ZoneInfo(tz)).strftime("%H:%M"))
    except Exception:   # noqa: BLE001
        return ""


def _gaps(people: list, departments: list) -> dict:
    """What HR has to fill in for the directory to be complete. Emails, not
    counts, so each row links straight into the person's People profile."""
    def missing(key):
        return sorted(p["email"] for p in people if not p[key])
    return {
        "manager": missing("managerEmail"),
        "department": missing("department"),
        "jobTitle": missing("jobTitle"),
        "photo": missing("photoUrl"),
        "officePhone": sorted(p["email"] for p in people if not p["officePhone"] and not p["mobile"]),
        "departmentLead": sorted(d["name"] for d in departments if not d["leadEmail"]),
    }


def _can_see_gaps(user: dict, db: Session) -> bool:
    return (int(user.get("level") or 0) >= auth._LEVELS["administrator"]
            or auth._module_level(user["email"], "hr", db) > 0)


@router.get("")
def contact_directory(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if user.get("external"):
        raise HTTPException(403, "The contact directory is for company staff.")
    scope = auth.company_scope(user, db)
    key = "all" if scope is None else ("co:" + ",".join(sorted(scope)) if scope else "co:none")
    roster = cache.contact_directory.get_or_load(key, lambda: _roster(db, scope))
    # Availability mutates the dicts; work on copies so the cached roster stays pure.
    people = [dict(p) for p in roster["people"]]
    _availability(db, people)
    for p in people:
        p.pop("_id", None)
    out = {
        "people": people,
        "departments": roster["departments"],
        "companies": roster["companies"],
        "me": (user.get("email") or "").lower(),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }
    if _can_see_gaps(user, db):
        out["gaps"] = _gaps(people, roster["departments"])
    return out
