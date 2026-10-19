"""Shift self-service requests (Sep 29 2026 - Shifts QA gap list, item 5).

Teams Shifts lets staff act on their own schedule: ask for an open shift,
swap a shift with a teammate, or offer one away, with the manager approving.
Nexus Shifts was read-only for staff (My Workday > Shifts). This adds:

  open   employee -> manager approves -> an assigned, published copy of the
         open shift is theirs and the open count drops by one
  swap   employee -> teammate accepts -> manager approves -> the two shifts
         trade owners
  offer  employee -> teammate accepts -> manager approves -> the shift moves
         to the teammate
  release (Shifts Phase 3b, Neil, Oct 14 2026) employee -> manager approves
         -> their own shared shift becomes an open slot IN PLACE (same row,
         same team, still shared) for anyone on the team to ask for. With
         releaseNeedsApproval off it goes to the pool at once and the
         approvers get one FYI bell. A shift on no team cannot be released
         (409) - the pool is per team.

Cross-team open shifts (Phase 3b, openShiftsAcrossTeams, off by default):
when the REQUESTER's company turns it on, the open slots of every team in
their company (or a team on no company) are offered to them too, marked
crossTeam with the team's name. A slot of another company is never shown.
The slot's OWN team decides a cross-team claim - its schedulers (manager
level or above), else its company's managers (People > Companies) - not the
requester's manager, who cannot judge another team's staffing; a Global
Admin / unscoped scheduler can always decide. When the team has nobody to
decide, the requester's usual approvers hear and decide as before.

Rules that keep it safe:
  - A teammate is someone in one of your shift groups - the same "team" My
    Shifts already shows (People > Shifts > Groups). Only published shifts
    today or later can be asked for; drafts and shifts being removed cannot.
    An open shift can be asked for only by the people on ITS team (Oct 2).
  - Nothing on the schedule moves until a manager approves, and approval
    re-checks that every shift is still there, still belongs to the same
    people and is not in the past - otherwise it refuses and says why. It
    also runs the schedule's conflict check for the NEW owner and refuses
    (409) unless the manager forces it.
  - Approving one request declines every other open request on the same
    shifts, since they no longer describe the schedule; publishing an edit
    or a removal of a shift cancels the requests about it
    (cancel_requests_for_shifts, called from publish_schedule).
  - The request row and the shifts it changes are locked (FOR UPDATE) while
    a decision is applied, so two approvals of the last open slot cannot
    both pass (Oct 2).
  - The manager inbox is scoped like every other team screen
    (routers.timeclock._visible_emails): you decide requests for people you
    manage, never anyone else's.
  - Each kind can be turned off (Settings > Shifts); turning one off stops
    new requests of that kind.

Everyone involved gets a bell at each step (targeted, never a broadcast):
approvers are the employee's manager, else their company's HR contact, else
the Global Admins (_team_alert_recipients with owners_as_fallback).
"""
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

import models
from auth import get_current_user
from database import get_db
from notify_company import notification_company
from routers.timeclock import (require_schedule_write, require_shift_manage, SHIFT_MANAGE_LEVEL, _visible_emails,
                               _team_alert_recipients, _sched_dict, _hm12, _shift_local_now,
                               _shift_conflicts, _timeoff_dict, _availability, _company_holidays_for_employee,
                               _TimeoffPrivacy, _DEFAULT_TEAM_TZ, _require_company_manage, _company_choices,
                               _schedulers)

router = APIRouter(prefix="/timeclock/shift-requests", tags=["Shift Requests"])

KINDS = ("open", "swap", "offer", "release")
PENDING = ("pending_peer", "pending_manager")
WEEK_STARTS = ("monday", "sunday")
# Settings live in one nexus_settings row per tenant (_SETTINGS_KEY) and,
# since Shifts Phase 0 (Oct 14 2026), an optional override row per company
# ("shift_requests_config:<HrEntity id>") holding only the keys that company
# changed. get_settings(db, company_id) layers defaults <- tenant <- company.
_SETTINGS_KEY = "shift_requests_config"
# Trading (open shifts, swaps, offers) stays a Global Settings switch but is
# OFF by default (Neil, Oct 14 2026).
_DEFAULTS = {"openShifts": False, "swaps": False, "offers": False, "teamSchedules": True,
             # Staff can request time off themselves (routers/timeclock.py).
             "timeOffRequests": True,
             # What staff see of their TEAMMATES in My Shifts (Teams "Visibility").
             # Reasons stay hidden unless turned on, and a confidential request
             # never shows its reason to a teammate either way.
             "teamTimeOffReasons": False, "teamShiftDetails": True,
             # The zone a shift with no preset runs on, and a new preset starts
             # with (Teams "Team time zone"). A preset keeps its own zone.
             "timeZone": _DEFAULT_TEAM_TZ,
             # The first day of the week on every shifts grid (Oct 2).
             "weekStart": "monday",
             # Grace window, in minutes, for a shift with no shift type
             # (shift_expect.py); a shift type carries its own grace_min.
             "defaultGraceMin": 10,
             # Shifts Phase 1 (Neil, Oct 14 2026, shift_attendance.py): minutes
             # after start + grace before a missing person is a no-show alert
             # (0 = no alerts for this company), and how many minutes before
             # the end a clock-out counts as leaving early.
             "noShowAlertMin": 10, "leftEarlyMin": 15,
             # Hardening pass (Oct 15 2026): with this on, a person with no
             # placement but a usual-hours preset on one of its working days
             # is a no-show candidate too (office staff on usual hours).
             "noShowOnUsualHours": False,
             # Shifts Phase 2 (Neil, Oct 14 2026, shift_rules.py): the schedule
             # rules, in hours; 0 turns one off. They warn, never block - and
             # sharing a schedule over a warning needs a reason when
             # publishReasonRequired is on. Daily overtime applies only to
             # people whose overtime rule is 'ca'; weekly to 'ca' and
             # 'federal'; the week cap to everyone.
             "ruleMinRestHours": 10, "ruleMaxDaysInRow": 6, "ruleDailyOtHours": 8,
             "ruleWeeklyOtHours": 40, "ruleMaxWeekHours": 0, "publishReasonRequired": True,
             # Shifts Phase 3a: shared shifts go onto people's Outlook
             # calendars (shift_calendar.py), per company; a person can still
             # opt out. OFF by default (Neil, Oct 15 2026: a shift event
             # filled the whole working day on everyone's calendar). The key
             # was renamed from outlookCalendar, which every settings save
             # since the merge had stored as true - that old key is ignored.
             # outlookShowAs is how the event blocks their time ('free' | 'busy').
             "outlookCalendarOn": False, "outlookShowAs": "free",
             # Ask each person to confirm they have seen a shared schedule
             # (shift_confirm.py): the publish bell and email say so, and a
             # manager sees who has not.
             "confirmRequests": True,
             # Shifts Phase 3b (Neil, Oct 14 2026) - built, OFF by default:
             # a person may ask to release their own shared shift to the
             # team's open pool; a manager approves it unless
             # releaseNeedsApproval is off; and open shifts of every team
             # in the company are offered to everyone, not only that team.
             "releaseShifts": False, "releaseNeedsApproval": True, "openShiftsAcrossTeams": False,
             # Live overtime alert (Neil, Oct 17 2026, overtime_watch.py): a
             # quiet bell to the manager when someone clocked in is this many
             # minutes from daily overtime (people on the 'ca' rule) or from
             # weekly overtime on the payroll week. OFF by default - a CA
             # team on 8-hour days would hear about every person every day;
             # 0 turns one threshold off.
             "otAlertOn": False, "otAlertDailyLeadMin": 30, "otAlertWeeklyLeadMin": 120,
             # Require Location to Punch (Neil's checklist, Oct 19 2026,
             # routers/timeclock.py punch()): with this on, a live clock in /
             # out / break punch that carries no coordinates is refused and the
             # person is told to turn location on. OFF by default so nobody is
             # locked out of punching the day it ships; with it off, a punch
             # with no location still lands and shows "No Location" on the
             # Time Sheet.
             "requireLocationToPunch": False,
             # Pay period close alerts (Oct 19 2026, timesheet_alerts.py): a
             # Time Sheet still waiting on its approver this many days after
             # the period ended is escalated to the approver's own manager,
             # else the company's HR contact; 0 = no escalation.
             "timesheetEscalateDays": 2,
             # Location Trail While Clocked In (Neil's checklist, Oct 20 2026,
             # routers/location_trail.py): the web app shares the person's
             # location about every 5 minutes while they are clocked in (not
             # on break) and their browser already allows location. OFF by
             # default - nothing is collected until a company turns it on.
             "locationTrailOn": False}
_TEXT_SETTINGS = ("timeZone", "weekStart")
SHOW_AS = ("free", "busy")
# key -> (min, max), clamped on read and save
_INT_SETTINGS = {"defaultGraceMin": (0, 120), "noShowAlertMin": (0, 240), "leftEarlyMin": (0, 240),
                 "ruleMinRestHours": (0, 24), "ruleMaxDaysInRow": (0, 14), "ruleDailyOtHours": (0, 24),
                 "ruleWeeklyOtHours": (0, 80), "ruleMaxWeekHours": (0, 100),
                 "otAlertDailyLeadMin": (0, 240), "otAlertWeeklyLeadMin": (0, 480),
                 "timesheetEscalateDays": (0, 30)}
_KIND_SETTING = {"open": "openShifts", "swap": "swaps", "offer": "offers", "release": "releaseShifts"}
_EMPLOYEE_ACTION = {"view": "shifts", "sub": "mine"}
_APPROVER_ACTION = {"view": "shifts", "sub": "schedule"}   # the Shifts module (Sep 29)
_KIND_LABEL = {"open": "open shift", "swap": "swap", "offer": "offer", "release": "release"}
FILLED_NOTE = "Another request filled this shift"
CHANGED_NOTE = "Shift changed before a decision"
RELEASED_NOTE = "Shift released to the open pool"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def _earliest_today() -> str:
    """The calendar date in the zone furthest behind UTC - the lower bound a
    query can use before each shift is judged in its own zone (_upcoming)."""
    return (datetime.now(timezone.utc) - timedelta(hours=12)).date().isoformat()


def _zone_ok(tz) -> bool:
    try:
        ZoneInfo(str(tz or ""))
        return bool(tz)
    except (ZoneInfoNotFoundError, ValueError):
        return False


def shift_zone(row, presets: dict, cfg: dict) -> str:
    """The zone a placed shift runs on: its own, else its preset's, else the
    team's."""
    own = (getattr(row, "timezone", "") or "").strip()
    if own:
        return own
    p = presets.get(row.shift_id)
    return (p.timezone if p is not None and p.timezone else "") or cfg.get("timeZone") or _DEFAULTS["timeZone"]


def _upcoming(row, presets: dict, cfg: dict) -> bool:
    """Today or later IN THE SHIFT'S OWN ZONE. The UTC date used to decide
    this, so after 5:00 PM Pacific the rest of today's shifts could not be
    swapped, offered or asked for."""
    return (row.work_date or "") >= _shift_local_now(shift_zone(row, presets, cfg)).date().isoformat()


def _started(row, presets: dict, cfg: dict) -> bool:
    """The shift's start has passed IN ITS OWN ZONE. A release (Phase 3b)
    must come before the shift begins: a slot for a shift already under way
    has nobody to turn up for it, and the person may be punched in on it -
    so today's shift is released only until it starts, overnight or not
    (_upcoming alone still allows the rest of the day)."""
    try:
        start = datetime.strptime(f"{(row.work_date or '')[:10]} {(row.start_hhmm or '')[:5]}", "%Y-%m-%d %H:%M")
    except ValueError:
        return False
    return _shift_local_now(shift_zone(row, presets, cfg)) >= start


def _release_blocked(db: Session, shift, cfg: dict) -> str:
    """Why this shift cannot go to the open pool, or '' when it can: it is
    on no team (the pool is per team), or it has already started."""
    if not (getattr(shift, "group_id", "") or ""):
        return "This shift is not on a team, so it cannot go to the open pool."
    preset = db.query(models.Shift).filter(models.Shift.id == shift.shift_id).first() if shift.shift_id else None
    if _started(shift, {preset.id: preset} if preset else {}, cfg):
        return "This shift has already started, so it cannot go to the open pool."
    return ""


def _us(iso: str) -> str:
    try:
        return datetime.strptime(iso[:10], "%Y-%m-%d").strftime("%m/%d/%Y")
    except ValueError:
        return iso or ""


def _when(date: str, start: str, end: str) -> str:
    return f"{_us(date)} {_hm12(start)} - {_hm12(end)}"


# ── Settings ──────────────────────────────────────────────────────────────

def _settings_key(company_id: str = "") -> str:
    return f"{_SETTINGS_KEY}:{company_id}" if company_id else _SETTINGS_KEY


def _clean_value(k: str, v):
    """The stored form of one setting, or None when the value is not usable."""
    if k == "weekStart":
        return str(v).lower() if str(v or "").lower() in WEEK_STARTS else None
    if k == "outlookShowAs":
        return str(v).lower() if str(v or "").lower() in SHOW_AS else None
    if k in _TEXT_SETTINGS:
        return str(v) if _zone_ok(v) else None
    if k in _INT_SETTINGS:
        lo, hi = _INT_SETTINGS[k]
        try:
            return max(lo, min(hi, int(v)))
        except (TypeError, ValueError):
            return None
    return bool(v)


def _saved_settings(db: Session, company_id: str = "") -> dict:
    """What is stored for the tenant ('' company) or a company's override,
    cleaned per key; {} when nothing is."""
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _settings_key(company_id)).first()
    if not row or not row.value:
        return {}
    try:
        saved = json.loads(row.value)
    except (TypeError, ValueError):
        return {}
    if not isinstance(saved, dict):
        return {}
    out = {}
    for k in _DEFAULTS:
        if k in saved:
            v = _clean_value(k, saved[k])
            if v is not None:
                out[k] = v
    return out


def get_settings(db: Session, company_id: str = "") -> dict:
    """The effective settings: defaults <- the tenant row <- that company's
    override (when `company_id` names one)."""
    cfg = dict(_DEFAULTS)
    cfg.update(_saved_settings(db))
    if company_id:
        cfg.update(_saved_settings(db, company_id))
    return cfg


def settings_for(db: Session, email: str) -> dict:
    """The settings that apply to one person: their company's (nexus_employees
    .company), falling back to the tenant row when they are untagged. Use
    this wherever a request KIND is allowed for a requester, or a time zone /
    week start is read for a specific person."""
    from auth import company_of
    return get_settings(db, company_of(email or "", db))


def _store_settings(db: Session, user: dict, key: str, cfg: dict) -> None:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == key).first()
    if not row:
        row = models.NexusSetting(key=key)
        db.add(row)
    row.value = json.dumps(cfg)
    row.updated_by = user["email"]
    row.updated_at = datetime.now(timezone.utc).isoformat()


def _company_param(db: Session, company: str) -> str:
    cid = (company or "").strip()
    if cid and not db.query(models.HrEntity.id).filter(models.HrEntity.id == cid).first():
        raise HTTPException(404, "Company not found.")
    return cid


def _settings_payload(db: Session, user: dict, company_id: str = "") -> dict:
    """The effective settings plus which company they are for, whether that
    company has its own override, and the companies the caller may pick."""
    companies, can_pick = _company_choices(db, user)
    return {**get_settings(db, company_id), "companyId": company_id,
            "hasOverride": bool(company_id and _saved_settings(db, company_id)),
            "companies": companies, "canPickCompany": can_pick}


class SettingsIn(BaseModel):
    openShifts: Optional[bool] = None
    swaps: Optional[bool] = None
    offers: Optional[bool] = None
    teamSchedules: Optional[bool] = None   # staff see teammates' shifts in My Shifts
    timeOffRequests: Optional[bool] = None
    teamTimeOffReasons: Optional[bool] = None   # staff see why a teammate is off
    teamShiftDetails: Optional[bool] = None     # staff see teammates' notes, activities and breaks
    timeZone: Optional[str] = None
    weekStart: Optional[str] = None             # monday | sunday
    defaultGraceMin: Optional[int] = None       # 0-120, clamped
    noShowAlertMin: Optional[int] = None        # 0-240, clamped; 0 = off (Phase 1)
    leftEarlyMin: Optional[int] = None          # 0-240, clamped (Phase 1)
    noShowOnUsualHours: Optional[bool] = None   # usual-hours presets are no-show candidates too (Oct 15)
    ruleMinRestHours: Optional[int] = None      # 0-24; 0 = off (Phase 2)
    ruleMaxDaysInRow: Optional[int] = None      # 0-14; 0 = off
    ruleDailyOtHours: Optional[int] = None      # 0-24; 0 = off; 'ca' overtime rule only
    ruleWeeklyOtHours: Optional[int] = None     # 0-80; 0 = off; 'ca' and 'federal'
    ruleMaxWeekHours: Optional[int] = None      # 0-100; 0 = off; everyone
    publishReasonRequired: Optional[bool] = None   # sharing over a warning needs a reason
    outlookCalendarOn: Optional[bool] = None    # shared shifts onto Outlook calendars (Phase 3a; off by default)
    outlookShowAs: Optional[str] = None         # free | busy
    confirmRequests: Optional[bool] = None      # ask people to confirm a shared schedule
    releaseShifts: Optional[bool] = None        # staff may release a shared shift to the open pool (Phase 3b)
    releaseNeedsApproval: Optional[bool] = None # a manager approves a release; off = at once
    openShiftsAcrossTeams: Optional[bool] = None   # open shifts of every team in the company, for everyone
    otAlertOn: Optional[bool] = None            # live overtime alert to the manager (Oct 17; off by default)
    otAlertDailyLeadMin: Optional[int] = None   # 0-240; minutes before daily overtime ('ca' rule); 0 = off
    otAlertWeeklyLeadMin: Optional[int] = None  # 0-480; minutes before weekly overtime; 0 = off
    requireLocationToPunch: Optional[bool] = None   # refuse a live punch with no coordinates (Oct 19; off by default)
    timesheetEscalateDays: Optional[int] = None # 0-30; days after a pay period before an unapproved sheet escalates; 0 = off
    locationTrailOn: Optional[bool] = None      # web location trail while clocked in (Oct 20; off by default)


@router.get("/settings")
def read_settings(company: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The tenant settings, or with `?company=<id>` the settings in force
    for that company (its override layered on the tenant row). A company
    outside the caller's reach (the walls, or a People grant limited to
    other companies) is not theirs to read: 404, as across every wall."""
    cid = _company_param(db, company)
    if cid:
        from routers.timeclock import _visible_companies
        admit = _visible_companies(db, user)
        if admit is not None and cid not in admit:
            raise HTTPException(404, "Company not found.")
    return _settings_payload(db, user, cid)


@router.put("/settings")
def save_settings(body: SettingsIn, company: str = "", user: dict = Depends(require_shift_manage),
                  db: Session = Depends(get_db)):
    """No company: the tenant defaults (company-wide access, like shared
    groups). `?company=<id>`: that company's override - of the keys sent,
    only those that DIFFER from the tenant's effective value are stored, and
    a stored key that now equals the tenant's is dropped, so the override
    stays sparse (a client that sends the whole form pins nothing extra) and
    the rest keeps following the tenant row. An override left with nothing
    in it is removed (hasOverride false)."""
    cid = _company_param(db, company)
    if body.timeZone is not None and not _zone_ok(body.timeZone):
        raise HTTPException(400, "Pick a time zone from the list.")
    if body.weekStart is not None and str(body.weekStart).lower() not in WEEK_STARTS:
        raise HTTPException(400, "The week starts on Monday or Sunday.")
    if body.outlookShowAs is not None and str(body.outlookShowAs).lower() not in SHOW_AS:
        raise HTTPException(400, "Outlook events show as Free or Busy.")
    sent = {k: _clean_value(k, v) for k, v in body.model_dump().items() if v is not None and k in _DEFAULTS}
    sent = {k: v for k, v in sent.items() if v is not None}
    if cid:
        _require_company_manage(user, db, cid, "Changing this company's shift settings")
        tenant = get_settings(db)
        cfg = _saved_settings(db, cid)
        cfg.update(sent)
        cfg = {k: v for k, v in cfg.items() if v != tenant.get(k)}
        if cfg:
            _store_settings(db, user, _settings_key(cid), cfg)
        else:
            (db.query(models.NexusSetting).filter(models.NexusSetting.key == _settings_key(cid))
               .delete(synchronize_session=False))
    else:
        # Company-wide only - a company-limited administrator changes their
        # company's override, never every company's defaults.
        _require_company_manage(user, db, "", "Changing shift settings")
        cfg = get_settings(db)
        cfg.update(sent)
        _store_settings(db, user, _SETTINGS_KEY, cfg)
    db.commit()
    return _settings_payload(db, user, cid)


@router.delete("/settings")
def clear_settings(company: str = "", user: dict = Depends(require_shift_manage), db: Session = Depends(get_db)):
    """Remove a company's override so it follows the tenant row again."""
    cid = _company_param(db, company)
    if not cid:
        raise HTTPException(400, "Pick a company - the tenant settings cannot be removed.")
    _require_company_manage(user, db, cid, "Changing this company's shift settings")
    db.query(models.NexusSetting).filter(models.NexusSetting.key == _settings_key(cid)).delete(synchronize_session=False)
    db.commit()
    return _settings_payload(db, user, cid)


# ── Helpers ───────────────────────────────────────────────────────────────

def _my_groups(db: Session, email: str) -> list:
    return [m.group_id for m in db.query(models.ShiftGroupMember)
            .filter(func.lower(models.ShiftGroupMember.employee_email) == email).all()]


def _teammates(db: Session, email: str) -> set:
    groups = _my_groups(db, email)
    if not groups:
        return set()
    return {(m.employee_email or "").lower() for m in db.query(models.ShiftGroupMember)
            .filter(models.ShiftGroupMember.group_id.in_(groups)).all()} - {email, ""}


def _names(db: Session) -> dict:
    return {(e.work_email or "").lower(): (f"{e.first_name or ''} {e.last_name or ''}".strip() or e.work_email)
            for e in db.query(models.NexusEmployee).all() if e.work_email}


def _live_shift(db: Session, shift_id: str, lock: bool = False):
    """A published, not-being-removed shift today or later, else None.
    `lock` takes the row FOR UPDATE (a decision is about to change it)."""
    if not shift_id:
        return None
    q = db.query(models.ScheduledShift).filter(models.ScheduledShift.id == shift_id)
    if lock:
        q = q.with_for_update()
    r = q.first()
    if not r or not r.published or r.pending_delete:
        return None
    preset = db.query(models.Shift).filter(models.Shift.id == r.shift_id).first() if r.shift_id else None
    cfg = settings_for(db, r.employee_email) if r.employee_email else get_settings(db)
    if not _upcoming(r, {preset.id: preset} if preset else {}, cfg):
        return None
    return r


def _bell(db: Session, recipient: str, title: str, body: str, ref: str, actor: str, action: dict) -> None:
    if not recipient:
        return
    db.add(models.NexusNotification(
        id=str(uuid.uuid4()), type="custom_alert", recipient=recipient.lower(), title=title, body=body,
        ref_id=f"shift-request:{ref}", item_name="", requested_by=actor, action=json.dumps(action),
        actioned=False, read_by="", company=notification_company(db, actor, recipient),
        created_at=datetime.now(timezone.utc).isoformat()))


def _describe(r: models.ShiftRequest, names: dict) -> str:
    who = names.get(r.requester_email, r.requester_email)
    mine = _when(r.shift_date, r.shift_start, r.shift_end)
    if r.kind == "open":
        return f"{who} asked for the open shift {mine}"
    if r.kind == "release":
        return f"{who} asked to release {mine} to the open pool"
    other = names.get(r.target_email, r.target_email)
    if r.kind == "swap":
        return f"{who} wants to swap {mine} for {other}'s {_when(r.target_date, r.target_start, r.target_end)}"
    return f"{who} offered {mine} to {other}"


def _live_dicts(db: Session, rows: list) -> dict:
    """{shift id: _sched_dict} for every shift the requests point at - the
    live blocks the UI draws; a shift that is gone is simply missing."""
    ids = {x for r in rows for x in (r.shift_id, r.target_shift_id) if x}
    if not ids:
        return {}
    presets = {s.id: s for s in db.query(models.Shift).all()}
    tz = get_settings(db).get("timeZone") or _DEFAULT_TEAM_TZ
    return {s.id: _sched_dict(s, presets, team_tz=tz)
            for s in db.query(models.ScheduledShift).filter(models.ScheduledShift.id.in_(list(ids))).all()}


def _team_names(db: Session) -> dict:
    return {g.id: g.name or "" for g in db.query(models.ShiftGroup).all()}


def _to_dict(r: models.ShiftRequest, names: dict, live: dict = None, teams: dict = None) -> dict:
    live = live or {}
    shift = live.get(r.shift_id) or {}
    return {
        "id": r.id, "kind": r.kind, "status": r.status, "summary": _describe(r, names),
        # The team the (live) shift is on - what a cross-team claim or a
        # release shows in the inbox (Phase 3b); '' when the shift is gone.
        "team": (teams or {}).get(shift.get("groupId") or "", ""),
        "requester": {"email": r.requester_email, "name": names.get(r.requester_email, r.requester_email)},
        "target": ({"email": r.target_email, "name": names.get(r.target_email, r.target_email)}
                   if r.target_email else None),
        # The LIVE shifts (null when gone) plus what was asked for, as copied
        # when the request was made - so a decided request still reads right.
        "shift": live.get(r.shift_id),
        "targetShift": live.get(r.target_shift_id) if r.target_shift_id else None,
        "asked": {"id": r.shift_id, "date": r.shift_date, "start": r.shift_start, "end": r.shift_end},
        "targetAsked": ({"id": r.target_shift_id, "date": r.target_date, "start": r.target_start, "end": r.target_end}
                        if r.target_shift_id else None),
        "note": r.note, "peerNote": r.peer_note, "decisionNote": r.decision_note,
        "decidedBy": r.decided_by, "createdAt": r.created_at, "decidedAt": r.decided_at,
    }


def _dicts(db: Session, rows: list, names: dict) -> list:
    live = _live_dicts(db, rows)
    teams = _team_names(db)
    return [_to_dict(r, names, live, teams) for r in rows]


def _slot_deciders(db: Session, group_id: str) -> list:
    """Who decides a claim on an open slot of THIS team when the requester is
    not on it (a cross-team claim, Phase 3b): the team's schedulers who hold
    Manage access to Shifts (manager and above), else the managers of the
    team's company (People > Companies). [] when nobody fits - the
    requester's usual approvers then decide."""
    from auth import level_for
    g = db.query(models.ShiftGroup).filter(models.ShiftGroup.id == group_id).first() if group_id else None
    if g is None:
        return []
    named = [e for e in _schedulers(g) if level_for(e, db) >= SHIFT_MANAGE_LEVEL]
    if named:
        return list(dict.fromkeys(named))
    cid = getattr(g, "company_id", "") or ""
    ent = db.query(models.HrEntity).filter(models.HrEntity.id == cid).first() if cid else None
    if ent is None:
        return []
    mgrs = [str(e).strip().lower() for e in (ent.manager_emails or []) if str(e).strip()]
    if not mgrs and (ent.manager_email or "").strip():
        mgrs = [ent.manager_email.strip().lower()]
    return [e for e in dict.fromkeys(mgrs) if level_for(e, db) >= SHIFT_MANAGE_LEVEL]


def _slot_group_id(db: Session, r: models.ShiftRequest) -> str:
    """The team of the shift an OPEN request points at; '' for any other
    kind or once the shift is gone (the last slot was filled)."""
    if r.kind != "open" or not r.shift_id:
        return ""
    row = db.query(models.ScheduledShift.group_id).filter(models.ScheduledShift.id == r.shift_id).first()
    return (row.group_id or "") if row else ""


def _claim_deciders(db: Session, r: models.ShiftRequest, cache: dict = None) -> list:
    """The slot's own deciders for a CROSS-TEAM open claim (the requester is
    not on the slot's team); [] for a claim on the requester's own team, any
    other kind, or a team with nobody to decide. `cache` memoizes per team
    across one inbox read."""
    gid = _slot_group_id(db, r)
    if not gid or gid in set(_my_groups(db, r.requester_email)):
        return []
    cache = cache if cache is not None else {}
    if gid not in cache:
        cache[gid] = _slot_deciders(db, gid)
    return cache[gid]


def _approver_emails(db: Session, r: models.ShiftRequest, actor: str) -> list:
    """Who decides this request, in bell order. A cross-team open claim goes
    to the slot's own team (_slot_deciders); everything else to the
    requester's (and the teammate's) manager, else the HR contact, else the
    Global Admins (Oct 2) - and only people who can actually decide it
    (managers and above, Sep 29): an HR contact below manager would get a
    request they are refused on."""
    from auth import level_for
    people = {r.requester_email} | ({r.target_email} if r.target_email else set())
    out = [e for e in _claim_deciders(db, r) if e not in people and e != actor]
    if out:
        return out
    for p in people:
        for rec in _team_alert_recipients(db, p, actor, owners_as_fallback=True):
            if rec not in out and rec not in people and level_for(rec, db) >= SHIFT_MANAGE_LEVEL:
                out.append(rec)
    return out


def _notify_approvers(db: Session, r: models.ShiftRequest, names: dict, actor: str) -> None:
    for rec in _approver_emails(db, r, actor):
        _bell(db, rec, "Shift Request to Approve", _describe(r, names) + ".", r.id, actor, _APPROVER_ACTION)


def _open_visible(row, my_groups, cfg: dict = None, groups: dict = None, company: str = "") -> bool:
    """An open shift is offered to the people on its team; a legacy slot with
    no team (before Oct 2) still shows to everyone. With openShiftsAcrossTeams
    on in `cfg` (the REQUESTER's company settings, Phase 3b) it is also
    offered to anyone in the company: a slot whose team (`groups`, {id:
    ShiftGroup}) is on no company or on the requester's `company`. A team on
    another company, or an archived one, never shows."""
    gid = getattr(row, "group_id", "") or ""
    if not gid or gid in my_groups:
        return True
    if not (cfg or {}).get("openShiftsAcrossTeams"):
        return False
    g = (groups or {}).get(gid)
    if g is None or int(getattr(g, "archived", 0) or 0):
        return False
    gc = getattr(g, "company_id", "") or ""
    return not gc or gc == (company or "")


# ── Employee side ─────────────────────────────────────────────────────────

@router.get("/mine")
def my_requests(start: str = "", end: str = "", user: dict = Depends(get_current_user),
                db: Session = Depends(get_db)):
    """What My Shifts needs: my requests, the swaps/offers waiting on me, the
    published open shifts of MY teams I could ask for in [start, end], and
    the settings."""
    me = (user.get("email") or "").lower()
    names = _names(db)
    mine = (db.query(models.ShiftRequest).filter(models.ShiftRequest.requester_email == me)
            .order_by(models.ShiftRequest.created_at.desc()).limit(30).all())
    incoming = (db.query(models.ShiftRequest)
                .filter(models.ShiftRequest.target_email == me, models.ShiftRequest.status == "pending_peer")
                .order_by(models.ShiftRequest.created_at.desc()).all())
    cfg = settings_for(db, me)   # the requester's own company's switches and zone
    tz = cfg.get("timeZone") or _DEFAULT_TEAM_TZ
    my_groups = set(_my_groups(db, me))
    open_shifts = []
    if cfg["openShifts"] and start and end:
        from auth import company_of
        lo = max(start[:10], _earliest_today())
        presets = {s.id: s for s in db.query(models.Shift).all()}
        groups = {g.id: g for g in db.query(models.ShiftGroup).all()}
        my_company = company_of(me, db)
        asked = {r.shift_id for r in mine if r.kind == "open" and r.status in PENDING}
        for r in (db.query(models.ScheduledShift)
                  .filter(models.ScheduledShift.employee_email == "", models.ScheduledShift.published == 1,
                          models.ScheduledShift.work_date >= lo, models.ScheduledShift.work_date <= end[:10])
                  .order_by(models.ScheduledShift.work_date, models.ScheduledShift.start_hhmm).all()):
            if (r.pending_delete or int(r.open_slots or 0) < 1
                    or not _open_visible(r, my_groups, cfg, groups, my_company) or not _upcoming(r, presets, cfg)):
                continue
            d = _sched_dict(r, presets, team_tz=tz)
            d["requested"] = r.id in asked
            gid = getattr(r, "group_id", "") or ""
            g = groups.get(gid)
            # Phase 3b: which team, and whether it is one the person is not on.
            d["team"] = (g.name or "") if g is not None else ""
            d["crossTeam"] = bool(gid) and gid not in my_groups
            open_shifts.append(d)
    # What the swap dialog can offer: teammates' published, upcoming shifts
    # in the range - and nothing else, so it works even when admins hide the
    # full team schedule ("teamSchedules" off).
    swap_shifts = {}
    mates = _teammates(db, me)
    if cfg["swaps"] and start and end and mates:
        presets = {s.id: s for s in db.query(models.Shift).all()}
        for r in (db.query(models.ScheduledShift)
                  .filter(models.ScheduledShift.employee_email.in_(list(mates)), models.ScheduledShift.published == 1,
                          models.ScheduledShift.work_date >= max(start[:10], _earliest_today()),
                          models.ScheduledShift.work_date <= end[:10])
                  .order_by(models.ScheduledShift.work_date, models.ScheduledShift.start_hhmm).all()):
            if not r.pending_delete and _upcoming(r, presets, cfg):
                swap_shifts.setdefault((r.employee_email or "").lower(), []).append(_sched_dict(r, presets, team_tz=tz))
    return {"mine": _dicts(db, mine, names), "incoming": _dicts(db, incoming, names),
            "openShifts": open_shifts, "settings": cfg, "swapShifts": swap_shifts,
            "groups": sorted(my_groups),
            "teammates": sorted(({"email": e, "name": names.get(e, e)} for e in mates),
                                key=lambda p: p["name"].lower())}


class CreateIn(BaseModel):
    kind: str
    shift_id: str
    target_email: Optional[str] = ""
    target_shift_id: Optional[str] = ""
    note: Optional[str] = ""


@router.post("")
def create_request(body: CreateIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = (user.get("email") or "").lower()
    kind = (body.kind or "").strip()
    if kind not in KINDS:
        raise HTTPException(400, "Unknown request type.")
    cfg = settings_for(db, me)
    if not cfg[_KIND_SETTING[kind]]:
        raise HTTPException(403, f"{_KIND_LABEL[kind].capitalize()} requests are turned off.")
    shift = _live_shift(db, body.shift_id)
    if not shift:
        raise HTTPException(409, "That shift is no longer available - it may have changed or already passed.")
    target_email = (body.target_email or "").strip().lower()
    target = None
    if kind == "open":
        from auth import company_of
        if shift.employee_email or int(shift.open_slots or 0) < 1:
            raise HTTPException(409, "That open shift has already been filled.")
        groups = {g.id: g for g in db.query(models.ShiftGroup).all()}
        if not _open_visible(shift, set(_my_groups(db, me)), cfg, groups, company_of(me, db)):
            raise HTTPException(403, "That open shift belongs to another team.")
        target_email = ""
    elif kind == "release":
        # Only my own shared, upcoming shift (_live_shift: published, not
        # being removed, today or later) - and it must be on a team, since
        # the open pool is per team.
        if (shift.employee_email or "").lower() != me:
            raise HTTPException(403, "You can only release your own shifts.")
        why = _release_blocked(db, shift, cfg)
        if why:
            raise HTTPException(409, why)
        target_email = ""
    else:
        if (shift.employee_email or "").lower() != me:
            raise HTTPException(403, "You can only swap or offer your own shifts.")
        if not target_email or target_email == me:
            raise HTTPException(400, "Pick a teammate.")
        if target_email not in _teammates(db, me):
            raise HTTPException(403, "You can only swap or offer shifts with people on your team.")
        if kind == "swap":
            target = _live_shift(db, body.target_shift_id or "")
            if not target or (target.employee_email or "").lower() != target_email:
                raise HTTPException(409, "That teammate's shift is no longer available.")
    dup = (db.query(models.ShiftRequest)
           .filter(models.ShiftRequest.requester_email == me, models.ShiftRequest.shift_id == shift.id,
                   models.ShiftRequest.status.in_(PENDING)).first())
    if dup:
        raise HTTPException(409, "You already have a request open for this shift.")
    r = models.ShiftRequest(
        id=str(uuid.uuid4()), kind=kind, status="pending_manager" if kind in ("open", "release") else "pending_peer",
        requester_email=me, shift_id=shift.id, target_email=target_email,
        target_shift_id=target.id if target else "",
        shift_date=shift.work_date, shift_start=shift.start_hhmm, shift_end=shift.end_hhmm,
        target_date=target.work_date if target else "", target_start=target.start_hhmm if target else "",
        target_end=target.end_hhmm if target else "",
        note=(body.note or "").strip()[:300], created_at=_now())
    db.add(r)
    names = _names(db)
    if kind == "release" and not cfg["releaseNeedsApproval"]:
        # No approval needed (releaseNeedsApproval off): the shift goes to
        # the pool now, decided by the requester, and the people who would
        # have approved it get one FYI bell each (named, never a broadcast).
        had_edit = bool(shift.pending_json)
        _apply(db, r, me)
        r.status, r.decided_by, r.decided_at = "approved", me, _now()
        who = names.get(me, me)
        for rec in _approver_emails(db, r, me):
            _bell(db, rec, "Shift Released to the Open Pool",
                  f"{who} released {_when(r.shift_date, r.shift_start, r.shift_end)} to the open pool"
                  + (f": {r.note}" if r.note else ".") + " No approval was needed."
                  + (" The unshared edit to this shift was dropped - the shared times went to the pool." if had_edit else ""),
                  r.id, me, _APPROVER_ACTION)
    elif kind in ("open", "release"):
        _notify_approvers(db, r, names, me)
    else:
        _bell(db, target_email, f"Shift {_KIND_LABEL[kind].title()} Request", _describe(r, names) + ". Accept or decline it in My Shifts.",
              r.id, me, _EMPLOYEE_ACTION)
    db.commit()
    return _dicts(db, [r], names)[0]


def _own(db: Session, req_id: str, lock: bool = False):
    q = db.query(models.ShiftRequest).filter(models.ShiftRequest.id == req_id)
    if lock:
        q = q.with_for_update()
    r = q.first()
    if not r:
        raise HTTPException(404, "Request not found.")
    return r


@router.post("/{req_id}/cancel")
def cancel_request(req_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = (user.get("email") or "").lower()
    r = _own(db, req_id, lock=True)
    if r.requester_email != me:
        raise HTTPException(403, "Only the person who asked can cancel this request.")
    if r.status not in PENDING:
        raise HTTPException(409, "This request has already been decided.")
    r.status, r.decided_at, r.decided_by = "cancelled", _now(), me
    db.commit()
    return _dicts(db, [r], _names(db))[0]


class RespondIn(BaseModel):
    accept: bool
    note: Optional[str] = ""


@router.post("/{req_id}/respond")
def respond(req_id: str, body: RespondIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The teammate's answer to a swap or offer. Accepting sends it on to the
    manager; declining ends it."""
    me = (user.get("email") or "").lower()
    r = _own(db, req_id, lock=True)
    if r.target_email != me:
        raise HTTPException(403, "This request was not sent to you.")
    if r.status != "pending_peer":
        raise HTTPException(409, "This request is no longer waiting on you.")
    r.peer_note, r.peer_decided_at = (body.note or "").strip()[:300], _now()
    names = _names(db)
    if body.accept:
        r.status = "pending_manager"
        _bell(db, r.requester_email, "Shift Request Accepted",
              f"{names.get(me, me)} accepted your {_KIND_LABEL[r.kind]}. It now needs a manager's approval.",
              r.id, me, _EMPLOYEE_ACTION)
        _notify_approvers(db, r, names, me)
    else:
        r.status, r.decided_at, r.decided_by = "declined", _now(), me
        _bell(db, r.requester_email, "Shift Request Declined",
              f"{names.get(me, me)} declined your {_KIND_LABEL[r.kind]}" + (f": {r.peer_note}" if r.peer_note else "."),
              r.id, me, _EMPLOYEE_ACTION)
    db.commit()
    return _dicts(db, [r], names)[0]


# ── Manager side ──────────────────────────────────────────────────────────

def _in_scope(r: models.ShiftRequest, scope) -> bool:
    if scope is None:
        return True
    return r.requester_email in scope and (not r.target_email or r.target_email in scope)


def _decidable(db: Session, r: models.ShiftRequest, scope, me: str, cache: dict = None) -> bool:
    """May this manager see and decide the request? The usual team scope
    (_in_scope) - except a CROSS-TEAM open claim (Phase 3b), which the
    slot's own team decides: its deciders, or an unscoped scheduler (a
    Global Admin), never the requester's own scoped manager. When the slot's
    team has nobody to decide, the usual scope applies."""
    if scope is None:
        return True
    deciders = _claim_deciders(db, r, cache) if r.kind == "open" and r.status in PENDING else []
    if deciders:
        return me in deciders
    return _in_scope(r, scope)


@router.get("")
def inbox(user: dict = Depends(require_schedule_write), db: Session = Depends(get_db)):
    """Requests waiting on a manager, for people the caller manages, the
    swaps / offers still waiting on the teammate (visible, not decidable),
    plus the last few decided ones for context."""
    scope = _visible_emails(db, user)
    names = _names(db)
    me = user["email"].lower()
    cache = {}
    # A manager's own swap/offer/pickup waits on ANOTHER manager (Sep 29).
    pending_rows = [r for r in db.query(models.ShiftRequest).filter(models.ShiftRequest.status.in_(PENDING))
                    .order_by(models.ShiftRequest.created_at).all()
                    if _decidable(db, r, scope, me, cache) and me not in (r.requester_email, r.target_email)]
    waiting = [r for r in pending_rows if r.status == "pending_manager"]
    on_peer = [r for r in pending_rows if r.status == "pending_peer"]
    recent = [r for r in db.query(models.ShiftRequest)
              .filter(models.ShiftRequest.status.in_(["approved", "declined"]), models.ShiftRequest.decided_by != "")
              .order_by(models.ShiftRequest.decided_at.desc()).limit(40).all() if _in_scope(r, scope)][:10]
    # Faces for the inbox cards (Visesh, 09/30: "no pictures here").
    photos = {(e.work_email or "").lower(): (e.photo_url or "") for e in db.query(models.NexusEmployee).all() if e.work_email and getattr(e, "photo_url", "")}
    live = _live_dicts(db, waiting + on_peer + recent)
    teams = _team_names(db)
    return {"pending": [_to_dict(r, names, live, teams) for r in waiting],
            "waitingOnPeer": [_to_dict(r, names, live, teams) for r in on_peer],
            "recent": [_to_dict(r, names, live, teams) for r in recent],
            "photos": photos,
            "settings": get_settings(db),
            # The settings are company-wide switches (save_settings).
            "canConfigure": scope is None}


class DecideIn(BaseModel):
    approve: bool
    note: Optional[str] = ""
    force: bool = False     # approve over the new owner's conflict warnings


def _owner_conflicts(db: Session, email: str, shift, skip_ids: set) -> list:
    """The schedule's own warnings for `shift` landing on `email` (an
    overlap, time off, a holiday, availability) - the same sentences the
    Add Shift dialog shows (timeclock._shift_conflicts)."""
    em = (email or "").lower()
    day = shift.work_date
    try:
        d = datetime.strptime(day[:10], "%Y-%m-%d").date()
    except ValueError:
        return []
    lo, hi = (d - timedelta(days=1)).isoformat(), (d + timedelta(days=1)).isoformat()
    presets = {s.id: s for s in db.query(models.Shift).all()}
    others = [_sched_dict(r, presets, effective=True) for r in
              db.query(models.ScheduledShift).filter(func.lower(models.ScheduledShift.employee_email) == em,
                                                     models.ScheduledShift.work_date >= lo,
                                                     models.ScheduledShift.work_date <= hi).all()
              if r.id not in skip_ids]
    priv = _TimeoffPrivacy(db, "")
    off = [_timeoff_dict(t, priv) for t in db.query(models.TimeOffRequest)
           .filter(models.TimeOffRequest.employee_email == em,
                   models.TimeOffRequest.status.in_(["approved", "pending"]),
                   models.TimeOffRequest.start_date <= day, models.TimeOffRequest.end_date >= day).all()]
    item = {"id": shift.id, "date": day, "start": shift.start_hhmm, "end": shift.end_hhmm}
    return _shift_conflicts(item, others, off, _company_holidays_for_employee(db, em, day, day) or {},
                            _availability(db, [em]).get(em))


def _check_new_owner(db: Session, email: str, shift, skip_ids: set, force: bool) -> None:
    if force:
        return
    why = _owner_conflicts(db, email, shift, skip_ids)
    if why:
        raise HTTPException(409, "This would conflict with the new owner's schedule: " + " ".join(why)
                            + " Approve anyway to go ahead.")


def _apply(db: Session, r: models.ShiftRequest, actor: str, force: bool = False) -> list:
    """Make the approved change on the schedule. Returns the shift ids that
    changed hands, so other open requests on them can be declined. Raises
    409 (and changes nothing) if the schedule moved on since the request, or
    the new owner's schedule conflicts and the manager did not force it.
    Every shift it changes is locked first."""
    shift = _live_shift(db, r.shift_id, lock=True)
    stale = HTTPException(409, "The schedule changed since this was asked - the shift is gone, "
                               "was reassigned or has passed. Decline it instead.")
    import shift_log
    if r.kind == "open":
        if not shift or shift.employee_email or int(shift.open_slots or 0) < 1:
            raise stale
        _check_new_owner(db, r.requester_email, shift, {shift.id}, force)
        claimed = models.ScheduledShift(
            id=str(uuid.uuid4()), employee_email=r.requester_email, work_date=shift.work_date,
            shift_id=shift.shift_id, start_hhmm=shift.start_hhmm, end_hhmm=shift.end_hhmm, label=shift.label,
            note=shift.note, open_slots=0, break_min=int(shift.break_min or 0),
            activities_json=shift.activities_json or "", color=shift.color or "",
            group_id=getattr(shift, "group_id", "") or "", timezone=getattr(shift, "timezone", "") or "",
            published=1,   # the manager just approved it - it is shared as of now
            created_by=actor, created_at=_now())
        db.add(claimed)
        was_open = shift_log.snapshot(shift)
        shift.open_slots = int(shift.open_slots or 1) - 1
        shift_log.record(db, "claimed", claimed, actor, before=was_open, after=shift_log.snapshot(claimed),
                         reason=f"Open shift request by {r.requester_email}")
        shift_log.record(db, "claimed", shift, actor, before=was_open, after=shift_log.snapshot(shift),
                         reason=f"Open shift request by {r.requester_email}")
        import shift_calendar
        shift_calendar.enqueue(db, [claimed.id])   # onto the new owner's Outlook calendar (Phase 3a)
        if shift.open_slots <= 0:
            db.delete(shift)
            return [shift.id]    # filled: other asks for it can no longer be met
        return []                # slots left: other people's asks still stand
    if not shift or (shift.employee_email or "").lower() != r.requester_email:
        raise stale
    if r.kind == "release":
        # The SAME row becomes an open slot of its team: still shared, one
        # slot, no owner, the owner's unshared edit dropped. The log row
        # stays on the person who released it; their Outlook event goes.
        # Not once the shift has started (_started) - the request may have
        # waited past it.
        why = _release_blocked(db, shift, settings_for(db, r.requester_email))
        if why:
            raise HTTPException(409, why + " Decline it instead.")
        old = (shift.employee_email or "").lower()
        had_edit = bool(shift.pending_json)
        before = shift_log.snapshot(shift)
        shift.employee_email, shift.open_slots, shift.pending_json = "", 1, ""
        if actor != r.requester_email:
            # The manager who sent it to the pool owns the slot: a scoped
            # scheduler may edit or remove only the open shifts they
            # created (_open_row_mine), and the original creator may be
            # long gone. An instant release keeps the creator.
            shift.created_by = actor
        shift_log.record(db, "released", {"id": shift.id, "email": old, "date": shift.work_date}, actor,
                         before=before, after=shift_log.snapshot(shift),
                         reason=f"Released by {r.requester_email}" + (" (an unshared edit was dropped)" if had_edit else ""))
        import shift_calendar
        shift_calendar.enqueue_delete(db, shift.id, old)
        # Every other pending request about this shift (an offer, a swap)
        # describes a shift that no longer has an owner: cancelled, the same
        # way a publish cancels them (cancel_requests_for_shifts), with this
        # request itself left alone.
        _end_others(db, [shift.id], r.id, actor, "cancelled", RELEASED_NOTE, "Shift Request Canceled",
                    "A shift in your request was released to the open pool before it was decided, so the request was canceled.")
        return []
    if r.kind == "swap":
        other = _live_shift(db, r.target_shift_id, lock=True)
        if not other or (other.employee_email or "").lower() != r.target_email:
            raise stale
        _check_new_owner(db, r.target_email, shift, {shift.id, other.id}, force)
        _check_new_owner(db, r.requester_email, other, {shift.id, other.id}, force)
        b1, b2 = shift_log.snapshot(shift), shift_log.snapshot(other)
        shift.employee_email, other.employee_email = r.target_email, r.requester_email
        # An unshared edit was the OLD owner's; it must not publish onto the
        # new one (Oct 2, B2-9).
        shift.pending_json = other.pending_json = ""
        why = f"Swap between {r.requester_email} and {r.target_email}"
        shift_log.record(db, "swapped", shift, actor, before=b1, after=shift_log.snapshot(shift), reason=why)
        shift_log.record(db, "swapped", other, actor, before=b2, after=shift_log.snapshot(other), reason=why)
        import shift_calendar
        shift_calendar.enqueue(db, [shift.id, other.id])   # each event moves to its new owner (Phase 3a)
        return [shift.id, other.id]
    _check_new_owner(db, r.target_email, shift, {shift.id}, force)
    before = shift_log.snapshot(shift)
    shift.employee_email = r.target_email   # offer
    shift.pending_json = ""
    shift_log.record(db, "offered", shift, actor, before=before, after=shift_log.snapshot(shift),
                     reason=f"Offered by {r.requester_email} to {r.target_email}")
    import shift_calendar
    shift_calendar.enqueue(db, [shift.id])   # off the old owner's calendar, onto the new one's (Phase 3a)
    return [shift.id]


def _end_others(db: Session, ids: list, except_id: str, actor: str, status: str, note: str, title: str,
                body: str) -> int:
    """Close every other pending request about these shifts and tell the
    person who asked. Does not commit."""
    if not ids:
        return 0
    n = 0
    for o in (db.query(models.ShiftRequest)
              .filter(models.ShiftRequest.id != except_id, models.ShiftRequest.status.in_(PENDING),
                      (models.ShiftRequest.shift_id.in_(ids)) | (models.ShiftRequest.target_shift_id.in_(ids)))
              .with_for_update().all()):
        o.status, o.decided_at, o.decided_by = status, _now(), actor
        o.decision_note = note
        _bell(db, o.requester_email, title, body, o.id, actor, _EMPLOYEE_ACTION)
        n += 1
    return n


def cancel_requests_for_shifts(db: Session, shift_ids: list, actor: str) -> int:
    """Publishing an edit or a removal of a shift (routers/timeclock.
    publish_schedule) cancels the pending swap / offer / open requests
    about it and bells the requester. Returns how many."""
    return _end_others(db, list(shift_ids), "", actor, "cancelled", CHANGED_NOTE, "Shift Request Canceled",
                       "A shift in your request was changed or removed before it was decided, so the request was canceled.")


@router.post("/{req_id}/decide")
def decide(req_id: str, body: DecideIn, user: dict = Depends(require_schedule_write), db: Session = Depends(get_db)):
    actor = user["email"].lower()
    r = _own(db, req_id, lock=True)
    if not _decidable(db, r, _visible_emails(db, user), actor):
        raise HTTPException(403, "This request is for people outside your team.")
    # Nobody decides a request they are part of - not even a manager on
    # their own shift (Sep 29). Another manager (theirs) approves it.
    if actor in (r.requester_email, r.target_email):
        raise HTTPException(403, "You can't decide a shift request you're part of - another manager reviews it.")
    if r.status != "pending_manager":
        raise HTTPException(409, "This request is not waiting on a manager.")
    names = _names(db)
    note, now = (body.note or "").strip()[:300], _now()
    people = [r.requester_email] + ([r.target_email] if r.target_email else [])
    if body.approve:
        moved = _apply(db, r, actor, force=bool(body.force))
        r.decision_note, r.decided_by, r.decided_at = note, actor, now
        r.status = "approved"
        # Other requests on these shifts no longer describe the schedule:
        # they are DECLINED with the reason, not "cancelled" as if withdrawn.
        _end_others(db, moved, r.id, actor, "declined", FILLED_NOTE, "Shift Request Declined",
                    "Another request filled a shift in your request, so it could not go ahead.")
        title, verb = "Shift Request Approved", "approved"
    else:
        r.decision_note, r.decided_by, r.decided_at = note, actor, now
        r.status = "declined"
        title, verb = "Shift Request Declined", "declined"
    for p in people:
        body_text = f"Your manager {verb}: {_describe(r, names)}" + (f". Note: {r.decision_note}" if r.decision_note else ".")
        _bell(db, p, title, body_text, r.id, actor, _EMPLOYEE_ACTION)
    db.commit()
    return _dicts(db, [r], names)[0]
