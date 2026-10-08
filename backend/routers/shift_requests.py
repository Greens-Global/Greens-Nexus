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
from routers.timeclock import (require_schedule_write, require_shift_manage, SHIFT_MANAGE_LEVEL, _visible_emails,
                               _team_alert_recipients, _require_unscoped_team, _sched_dict, _hm12, _shift_local_now,
                               _shift_conflicts, _timeoff_dict, _availability, _company_holidays_for_employee,
                               _TimeoffPrivacy, _DEFAULT_TEAM_TZ)

router = APIRouter(prefix="/timeclock/shift-requests", tags=["Shift Requests"])

KINDS = ("open", "swap", "offer")
PENDING = ("pending_peer", "pending_manager")
WEEK_STARTS = ("monday", "sunday")
_SETTINGS_KEY = "shift_requests_config"
_DEFAULTS = {"openShifts": True, "swaps": True, "offers": True, "teamSchedules": True,
             # Shift reminders (shift_notify.py): on/off and minutes before start.
             "reminders": True, "reminderLeadMinutes": 60,
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
             "weekStart": "monday"}
_TEXT_SETTINGS = ("timeZone", "weekStart")
REMINDER_LEAD_MIN, REMINDER_LEAD_MAX = 15, 240
_KIND_SETTING = {"open": "openShifts", "swap": "swaps", "offer": "offers"}
_EMPLOYEE_ACTION = {"view": "shifts", "sub": "mine"}
_APPROVER_ACTION = {"view": "shifts", "sub": "schedule"}   # the Shifts module (Sep 29)
_KIND_LABEL = {"open": "open shift", "swap": "swap", "offer": "offer"}
FILLED_NOTE = "Another request filled this shift"
CHANGED_NOTE = "Shift changed before a decision"


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


def _us(iso: str) -> str:
    try:
        return datetime.strptime(iso[:10], "%Y-%m-%d").strftime("%m/%d/%Y")
    except ValueError:
        return iso or ""


def _when(date: str, start: str, end: str) -> str:
    return f"{_us(date)} {_hm12(start)} - {_hm12(end)}"


# ── Settings ──────────────────────────────────────────────────────────────

def get_settings(db: Session) -> dict:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    cfg = dict(_DEFAULTS)
    if row and row.value:
        try:
            saved = json.loads(row.value)
            if isinstance(saved, dict):
                for k in _DEFAULTS:
                    if k not in saved:
                        continue
                    if k == "reminderLeadMinutes":
                        try:
                            cfg[k] = max(REMINDER_LEAD_MIN, min(REMINDER_LEAD_MAX, int(saved[k])))
                        except (TypeError, ValueError):
                            pass
                    elif k == "weekStart":
                        if str(saved[k] or "").lower() in WEEK_STARTS:
                            cfg[k] = str(saved[k]).lower()
                    elif k in _TEXT_SETTINGS:
                        if _zone_ok(saved[k]):
                            cfg[k] = str(saved[k])
                    else:
                        cfg[k] = bool(saved[k])
        except (TypeError, ValueError):
            pass
    return cfg


class SettingsIn(BaseModel):
    openShifts: Optional[bool] = None
    swaps: Optional[bool] = None
    offers: Optional[bool] = None
    teamSchedules: Optional[bool] = None   # staff see teammates' shifts in My Shifts
    reminders: Optional[bool] = None
    reminderLeadMinutes: Optional[int] = None
    timeOffRequests: Optional[bool] = None
    teamTimeOffReasons: Optional[bool] = None   # staff see why a teammate is off
    teamShiftDetails: Optional[bool] = None     # staff see teammates' notes, activities and breaks
    timeZone: Optional[str] = None
    weekStart: Optional[str] = None             # monday | sunday


@router.get("/settings")
def read_settings(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return get_settings(db)


@router.put("/settings")
def save_settings(body: SettingsIn, user: dict = Depends(require_shift_manage), db: Session = Depends(get_db)):
    _require_unscoped_team(user, db, "Changing shift settings")   # company-wide switches, like shift groups
    if body.timeZone is not None and not _zone_ok(body.timeZone):
        raise HTTPException(400, "Pick a time zone from the list.")
    if body.weekStart is not None and str(body.weekStart).lower() not in WEEK_STARTS:
        raise HTTPException(400, "The week starts on Monday or Sunday.")
    lead = body.reminderLeadMinutes
    if lead is not None and not REMINDER_LEAD_MIN <= lead <= REMINDER_LEAD_MAX:
        raise HTTPException(400, f"Remind between {REMINDER_LEAD_MIN} and {REMINDER_LEAD_MAX} minutes before a shift.")
    cfg = get_settings(db)
    cfg.update({k: v for k, v in body.model_dump().items() if v is not None})
    if body.weekStart is not None:
        cfg["weekStart"] = str(body.weekStart).lower()
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    if not row:
        row = models.NexusSetting(key=_SETTINGS_KEY)
        db.add(row)
    row.value = json.dumps(cfg)
    row.updated_by = user["email"]
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    return cfg


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
    if not _upcoming(r, {preset.id: preset} if preset else {}, get_settings(db)):
        return None
    return r


def _bell(db: Session, recipient: str, title: str, body: str, ref: str, actor: str, action: dict) -> None:
    if not recipient:
        return
    db.add(models.NexusNotification(
        id=str(uuid.uuid4()), type="custom_alert", recipient=recipient.lower(), title=title, body=body,
        ref_id=f"shift-request:{ref}", item_name="", requested_by=actor, action=json.dumps(action),
        actioned=False, read_by="", created_at=datetime.now(timezone.utc).isoformat()))


def _describe(r: models.ShiftRequest, names: dict) -> str:
    who = names.get(r.requester_email, r.requester_email)
    mine = _when(r.shift_date, r.shift_start, r.shift_end)
    if r.kind == "open":
        return f"{who} asked for the open shift {mine}"
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


def _to_dict(r: models.ShiftRequest, names: dict, live: dict = None) -> dict:
    live = live or {}
    return {
        "id": r.id, "kind": r.kind, "status": r.status, "summary": _describe(r, names),
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
    return [_to_dict(r, names, live) for r in rows]


def _notify_approvers(db: Session, r: models.ShiftRequest, names: dict, actor: str) -> None:
    from auth import level_for
    people = {r.requester_email} | ({r.target_email} if r.target_email else set())
    sent = set()
    for p in people:
        # The manager, else the HR contact, else the Global Admins (Oct 2) -
        # and only people who can actually decide it (managers and above,
        # Sep 29): an HR contact below manager would get a request they are
        # refused on.
        for rec in _team_alert_recipients(db, p, actor, owners_as_fallback=True):
            if rec not in sent and rec not in people and level_for(rec, db) >= SHIFT_MANAGE_LEVEL:
                sent.add(rec)
                _bell(db, rec, "Shift request to approve", _describe(r, names) + ".", r.id, actor, _APPROVER_ACTION)


def _open_visible(row, my_groups) -> bool:
    """An open shift is offered to the people on its team; a legacy slot with
    no team (before Oct 2) still shows to everyone."""
    gid = getattr(row, "group_id", "") or ""
    return not gid or gid in my_groups


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
    cfg = get_settings(db)
    tz = cfg.get("timeZone") or _DEFAULT_TEAM_TZ
    my_groups = set(_my_groups(db, me))
    open_shifts = []
    if cfg["openShifts"] and start and end:
        lo = max(start[:10], _earliest_today())
        presets = {s.id: s for s in db.query(models.Shift).all()}
        asked = {r.shift_id for r in mine if r.kind == "open" and r.status in PENDING}
        for r in (db.query(models.ScheduledShift)
                  .filter(models.ScheduledShift.employee_email == "", models.ScheduledShift.published == 1,
                          models.ScheduledShift.work_date >= lo, models.ScheduledShift.work_date <= end[:10])
                  .order_by(models.ScheduledShift.work_date, models.ScheduledShift.start_hhmm).all()):
            if (r.pending_delete or int(r.open_slots or 0) < 1 or not _open_visible(r, my_groups)
                    or not _upcoming(r, presets, cfg)):
                continue
            d = _sched_dict(r, presets, team_tz=tz)
            d["requested"] = r.id in asked
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
    if not get_settings(db)[_KIND_SETTING[kind]]:
        raise HTTPException(403, f"{_KIND_LABEL[kind].capitalize()} requests are turned off.")
    shift = _live_shift(db, body.shift_id)
    if not shift:
        raise HTTPException(409, "That shift is no longer available - it may have changed or already passed.")
    target_email = (body.target_email or "").strip().lower()
    target = None
    if kind == "open":
        if shift.employee_email or int(shift.open_slots or 0) < 1:
            raise HTTPException(409, "That open shift has already been filled.")
        if not _open_visible(shift, set(_my_groups(db, me))):
            raise HTTPException(403, "That open shift belongs to another team.")
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
        id=str(uuid.uuid4()), kind=kind, status="pending_manager" if kind == "open" else "pending_peer",
        requester_email=me, shift_id=shift.id, target_email=target_email,
        target_shift_id=target.id if target else "",
        shift_date=shift.work_date, shift_start=shift.start_hhmm, shift_end=shift.end_hhmm,
        target_date=target.work_date if target else "", target_start=target.start_hhmm if target else "",
        target_end=target.end_hhmm if target else "",
        note=(body.note or "").strip()[:300], created_at=_now())
    db.add(r)
    names = _names(db)
    if kind == "open":
        _notify_approvers(db, r, names, me)
    else:
        _bell(db, target_email, f"Shift {_KIND_LABEL[kind]} request", _describe(r, names) + ". Accept or decline it in My Shifts.",
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
        _bell(db, r.requester_email, "Shift request accepted",
              f"{names.get(me, me)} accepted your {_KIND_LABEL[r.kind]}. It now needs a manager's approval.",
              r.id, me, _EMPLOYEE_ACTION)
        _notify_approvers(db, r, names, me)
    else:
        r.status, r.decided_at, r.decided_by = "declined", _now(), me
        _bell(db, r.requester_email, "Shift request declined",
              f"{names.get(me, me)} declined your {_KIND_LABEL[r.kind]}" + (f": {r.peer_note}" if r.peer_note else "."),
              r.id, me, _EMPLOYEE_ACTION)
    db.commit()
    return _dicts(db, [r], names)[0]


# ── Manager side ──────────────────────────────────────────────────────────

def _in_scope(r: models.ShiftRequest, scope) -> bool:
    if scope is None:
        return True
    return r.requester_email in scope and (not r.target_email or r.target_email in scope)


@router.get("")
def inbox(user: dict = Depends(require_schedule_write), db: Session = Depends(get_db)):
    """Requests waiting on a manager, for people the caller manages, the
    swaps / offers still waiting on the teammate (visible, not decidable),
    plus the last few decided ones for context."""
    scope = _visible_emails(db, user)
    names = _names(db)
    me = user["email"].lower()
    # A manager's own swap/offer/pickup waits on ANOTHER manager (Sep 29).
    pending_rows = [r for r in db.query(models.ShiftRequest).filter(models.ShiftRequest.status.in_(PENDING))
                    .order_by(models.ShiftRequest.created_at).all()
                    if _in_scope(r, scope) and me not in (r.requester_email, r.target_email)]
    waiting = [r for r in pending_rows if r.status == "pending_manager"]
    on_peer = [r for r in pending_rows if r.status == "pending_peer"]
    recent = [r for r in db.query(models.ShiftRequest)
              .filter(models.ShiftRequest.status.in_(["approved", "declined"]), models.ShiftRequest.decided_by != "")
              .order_by(models.ShiftRequest.decided_at.desc()).limit(40).all() if _in_scope(r, scope)][:10]
    # Faces for the inbox cards (Visesh, 09/30: "no pictures here").
    photos = {(e.work_email or "").lower(): (e.photo_url or "") for e in db.query(models.NexusEmployee).all() if e.work_email and getattr(e, "photo_url", "")}
    live = _live_dicts(db, waiting + on_peer + recent)
    return {"pending": [_to_dict(r, names, live) for r in waiting],
            "waitingOnPeer": [_to_dict(r, names, live) for r in on_peer],
            "recent": [_to_dict(r, names, live) for r in recent],
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
    if r.kind == "open":
        if not shift or shift.employee_email or int(shift.open_slots or 0) < 1:
            raise stale
        _check_new_owner(db, r.requester_email, shift, {shift.id}, force)
        db.add(models.ScheduledShift(
            id=str(uuid.uuid4()), employee_email=r.requester_email, work_date=shift.work_date,
            shift_id=shift.shift_id, start_hhmm=shift.start_hhmm, end_hhmm=shift.end_hhmm, label=shift.label,
            note=shift.note, open_slots=0, break_min=int(shift.break_min or 0),
            activities_json=shift.activities_json or "", color=shift.color or "",
            group_id=getattr(shift, "group_id", "") or "", timezone=getattr(shift, "timezone", "") or "",
            published=1,   # the manager just approved it - it is shared as of now
            created_by=actor, created_at=_now()))
        shift.open_slots = int(shift.open_slots or 1) - 1
        if shift.open_slots <= 0:
            db.delete(shift)
            return [shift.id]    # filled: other asks for it can no longer be met
        return []                # slots left: other people's asks still stand
    if not shift or (shift.employee_email or "").lower() != r.requester_email:
        raise stale
    if r.kind == "swap":
        other = _live_shift(db, r.target_shift_id, lock=True)
        if not other or (other.employee_email or "").lower() != r.target_email:
            raise stale
        _check_new_owner(db, r.target_email, shift, {shift.id, other.id}, force)
        _check_new_owner(db, r.requester_email, other, {shift.id, other.id}, force)
        shift.employee_email, other.employee_email = r.target_email, r.requester_email
        # An unshared edit was the OLD owner's; it must not publish onto the
        # new one (Oct 2, B2-9).
        shift.pending_json = other.pending_json = ""
        return [shift.id, other.id]
    _check_new_owner(db, r.target_email, shift, {shift.id}, force)
    shift.employee_email = r.target_email   # offer
    shift.pending_json = ""
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
    return _end_others(db, list(shift_ids), "", actor, "cancelled", CHANGED_NOTE, "Shift request cancelled",
                       "A shift in your request was changed or removed before it was decided, so the request was cancelled.")


@router.post("/{req_id}/decide")
def decide(req_id: str, body: DecideIn, user: dict = Depends(require_schedule_write), db: Session = Depends(get_db)):
    actor = user["email"].lower()
    r = _own(db, req_id, lock=True)
    if not _in_scope(r, _visible_emails(db, user)):
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
        _end_others(db, moved, r.id, actor, "declined", FILLED_NOTE, "Shift request declined",
                    "Another request filled a shift in your request, so it could not go ahead.")
        title, verb = "Shift request approved", "approved"
    else:
        r.decision_note, r.decided_by, r.decided_at = note, actor, now
        r.status = "declined"
        title, verb = "Shift request declined", "declined"
    for p in people:
        body_text = f"Your manager {verb}: {_describe(r, names)}" + (f". Note: {r.decision_note}" if r.decision_note else ".")
        _bell(db, p, title, body_text, r.id, actor, _EMPLOYEE_ACTION)
    db.commit()
    return _dicts(db, [r], names)[0]
