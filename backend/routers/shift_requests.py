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
  - Nothing on the schedule moves until a manager approves, and approval
    re-checks that every shift is still there, still belongs to the same
    people and is not in the past - otherwise it refuses and says why.
  - Approving one request cancels every other open request on the same
    shifts, since they no longer describe the schedule.
  - The manager inbox is scoped like every other team screen
    (routers.timeclock._visible_emails): you decide requests for people you
    manage, never anyone else's.
  - Each kind can be turned off (Settings on the Requests inbox); turning
    one off stops new requests of that kind.

Everyone involved gets a bell at each step (targeted, never a broadcast):
approvers are the employee's manager plus the Global Admins, the same set
time-off and timecard alerts use (_team_alert_recipients).
"""
import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

import models
from auth import get_current_user
from database import get_db
from routers.timeclock import (require_team_write, _visible_emails, _team_alert_recipients,
                               _require_unscoped_team, _sched_dict, _hm12)

router = APIRouter(prefix="/timeclock/shift-requests", tags=["Shift Requests"])

KINDS = ("open", "swap", "offer")
PENDING = ("pending_peer", "pending_manager")
_SETTINGS_KEY = "shift_requests_config"
_DEFAULTS = {"openShifts": True, "swaps": True, "offers": True}
_KIND_SETTING = {"open": "openShifts", "swap": "swaps", "offer": "offers"}
_EMPLOYEE_ACTION = {"view": "timeclock", "sub": "shifts"}
_APPROVER_ACTION = {"view": "hr", "sub": "hr-time"}
_KIND_LABEL = {"open": "open shift", "swap": "swap", "offer": "offer"}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def _today() -> str:
    # UTC date; a shift "today or later" anywhere in the world is still
    # askable, and yesterday's cannot be.
    return (datetime.now(timezone.utc)).date().isoformat()


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
                cfg.update({k: bool(saved[k]) for k in _DEFAULTS if k in saved})
        except (TypeError, ValueError):
            pass
    return cfg


class SettingsIn(BaseModel):
    openShifts: Optional[bool] = None
    swaps: Optional[bool] = None
    offers: Optional[bool] = None


@router.get("/settings")
def read_settings(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return get_settings(db)


@router.put("/settings")
def save_settings(body: SettingsIn, user: dict = Depends(require_team_write), db: Session = Depends(get_db)):
    _require_unscoped_team(user, db)   # company-wide switches, like shift groups
    cfg = get_settings(db)
    cfg.update({k: v for k, v in body.model_dump().items() if v is not None})
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

def _teammates(db: Session, email: str) -> set:
    groups = [m.group_id for m in db.query(models.ShiftGroupMember)
              .filter(func.lower(models.ShiftGroupMember.employee_email) == email).all()]
    if not groups:
        return set()
    return {(m.employee_email or "").lower() for m in db.query(models.ShiftGroupMember)
            .filter(models.ShiftGroupMember.group_id.in_(groups)).all()} - {email, ""}


def _names(db: Session) -> dict:
    return {(e.work_email or "").lower(): (f"{e.first_name or ''} {e.last_name or ''}".strip() or e.work_email)
            for e in db.query(models.NexusEmployee).all() if e.work_email}


def _live_shift(db: Session, shift_id: str):
    """A published, not-being-removed shift today or later, else None."""
    r = db.query(models.ScheduledShift).filter(models.ScheduledShift.id == shift_id).first()
    if not r or not r.published or r.pending_delete or (r.work_date or "") < _today():
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


def _to_dict(r: models.ShiftRequest, names: dict) -> dict:
    return {
        "id": r.id, "kind": r.kind, "status": r.status, "summary": _describe(r, names),
        "requester": {"email": r.requester_email, "name": names.get(r.requester_email, r.requester_email)},
        "target": ({"email": r.target_email, "name": names.get(r.target_email, r.target_email)}
                   if r.target_email else None),
        "shift": {"id": r.shift_id, "date": r.shift_date, "start": r.shift_start, "end": r.shift_end},
        "targetShift": ({"id": r.target_shift_id, "date": r.target_date, "start": r.target_start, "end": r.target_end}
                        if r.target_shift_id else None),
        "note": r.note, "peerNote": r.peer_note, "decisionNote": r.decision_note,
        "decidedBy": r.decided_by, "createdAt": r.created_at, "decidedAt": r.decided_at,
    }


def _notify_approvers(db: Session, r: models.ShiftRequest, names: dict, actor: str) -> None:
    people = {r.requester_email} | ({r.target_email} if r.target_email else set())
    sent = set()
    for p in people:
        for rec in _team_alert_recipients(db, p, actor):
            if rec not in sent and rec not in people:
                sent.add(rec)
                _bell(db, rec, "Shift request to approve", _describe(r, names) + ".", r.id, actor, _APPROVER_ACTION)


# ── Employee side ─────────────────────────────────────────────────────────

@router.get("/mine")
def my_requests(start: str = "", end: str = "", user: dict = Depends(get_current_user),
                db: Session = Depends(get_db)):
    """What My Shifts needs: my requests, the swaps/offers waiting on me, the
    published open shifts I could ask for in [start, end], and the settings."""
    me = (user.get("email") or "").lower()
    names = _names(db)
    mine = (db.query(models.ShiftRequest).filter(models.ShiftRequest.requester_email == me)
            .order_by(models.ShiftRequest.created_at.desc()).limit(30).all())
    incoming = (db.query(models.ShiftRequest)
                .filter(models.ShiftRequest.target_email == me, models.ShiftRequest.status == "pending_peer")
                .order_by(models.ShiftRequest.created_at.desc()).all())
    cfg = get_settings(db)
    open_shifts = []
    if cfg["openShifts"] and start and end:
        lo = max(start[:10], _today())
        presets = {s.id: s for s in db.query(models.Shift).all()}
        asked = {r.shift_id for r in mine if r.kind == "open" and r.status in PENDING}
        for r in (db.query(models.ScheduledShift)
                  .filter(models.ScheduledShift.employee_email == "", models.ScheduledShift.published == 1,
                          models.ScheduledShift.work_date >= lo, models.ScheduledShift.work_date <= end[:10])
                  .order_by(models.ScheduledShift.work_date, models.ScheduledShift.start_hhmm).all()):
            if r.pending_delete or int(r.open_slots or 0) < 1:
                continue
            d = _sched_dict(r, presets)
            d["requested"] = r.id in asked
            open_shifts.append(d)
    return {"mine": [_to_dict(r, names) for r in mine], "incoming": [_to_dict(r, names) for r in incoming],
            "openShifts": open_shifts, "settings": cfg,
            "teammates": sorted(({"email": e, "name": names.get(e, e)} for e in _teammates(db, me)),
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
    return _to_dict(r, names)


def _own(db: Session, req_id: str):
    r = db.query(models.ShiftRequest).filter(models.ShiftRequest.id == req_id).first()
    if not r:
        raise HTTPException(404, "Request not found.")
    return r


@router.post("/{req_id}/cancel")
def cancel_request(req_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = (user.get("email") or "").lower()
    r = _own(db, req_id)
    if r.requester_email != me:
        raise HTTPException(403, "Only the person who asked can cancel this request.")
    if r.status not in PENDING:
        raise HTTPException(409, "This request has already been decided.")
    r.status, r.decided_at, r.decided_by = "cancelled", _now(), me
    db.commit()
    return _to_dict(r, _names(db))


class RespondIn(BaseModel):
    accept: bool
    note: Optional[str] = ""


@router.post("/{req_id}/respond")
def respond(req_id: str, body: RespondIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The teammate's answer to a swap or offer. Accepting sends it on to the
    manager; declining ends it."""
    me = (user.get("email") or "").lower()
    r = _own(db, req_id)
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
    return _to_dict(r, names)


# ── Manager side ──────────────────────────────────────────────────────────

def _in_scope(r: models.ShiftRequest, scope) -> bool:
    if scope is None:
        return True
    return r.requester_email in scope and (not r.target_email or r.target_email in scope)


@router.get("")
def inbox(user: dict = Depends(require_team_write), db: Session = Depends(get_db)):
    """Requests waiting on a manager, for people the caller manages, plus
    the last few decided ones for context."""
    scope = _visible_emails(db, user)
    names = _names(db)
    waiting = [r for r in db.query(models.ShiftRequest).filter(models.ShiftRequest.status == "pending_manager")
               .order_by(models.ShiftRequest.created_at).all() if _in_scope(r, scope)]
    recent = [r for r in db.query(models.ShiftRequest)
              .filter(models.ShiftRequest.status.in_(["approved", "declined"]), models.ShiftRequest.decided_by != "")
              .order_by(models.ShiftRequest.decided_at.desc()).limit(40).all() if _in_scope(r, scope)][:10]
    return {"pending": [_to_dict(r, names) for r in waiting], "recent": [_to_dict(r, names) for r in recent],
            "settings": get_settings(db)}


class DecideIn(BaseModel):
    approve: bool
    note: Optional[str] = ""


def _apply(db: Session, r: models.ShiftRequest, actor: str) -> list:
    """Make the approved change on the schedule. Returns the shift ids that
    changed hands, so other open requests on them can be cancelled. Raises
    409 (and changes nothing) if the schedule moved on since the request."""
    shift = _live_shift(db, r.shift_id)
    stale = HTTPException(409, "The schedule changed since this was asked - the shift is gone, "
                               "was reassigned or has passed. Decline it instead.")
    if r.kind == "open":
        if not shift or shift.employee_email or int(shift.open_slots or 0) < 1:
            raise stale
        db.add(models.ScheduledShift(
            id=str(uuid.uuid4()), employee_email=r.requester_email, work_date=shift.work_date,
            shift_id=shift.shift_id, start_hhmm=shift.start_hhmm, end_hhmm=shift.end_hhmm, label=shift.label,
            note=shift.note, open_slots=0, break_min=int(shift.break_min or 0),
            activities_json=shift.activities_json or "",
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
        other = _live_shift(db, r.target_shift_id)
        if not other or (other.employee_email or "").lower() != r.target_email:
            raise stale
        shift.employee_email, other.employee_email = r.target_email, r.requester_email
        return [shift.id, other.id]
    shift.employee_email = r.target_email   # offer
    return [shift.id]


@router.post("/{req_id}/decide")
def decide(req_id: str, body: DecideIn, user: dict = Depends(require_team_write), db: Session = Depends(get_db)):
    actor = user["email"].lower()
    r = _own(db, req_id)
    if not _in_scope(r, _visible_emails(db, user)):
        raise HTTPException(403, "This request is for people outside your team.")
    if r.status != "pending_manager":
        raise HTTPException(409, "This request is not waiting on a manager.")
    names = _names(db)
    r.decision_note, r.decided_by, r.decided_at = (body.note or "").strip()[:300], actor, _now()
    people = [r.requester_email] + ([r.target_email] if r.target_email else [])
    if body.approve:
        moved = _apply(db, r, actor)
        r.status = "approved"
        # Other open requests on these shifts no longer describe the schedule.
        for o in (db.query(models.ShiftRequest)
                  .filter(models.ShiftRequest.id != r.id, models.ShiftRequest.status.in_(PENDING),
                          (models.ShiftRequest.shift_id.in_(moved)) | (models.ShiftRequest.target_shift_id.in_(moved)))
                  .all()):
            o.status, o.decided_at, o.decided_by = "cancelled", _now(), actor
            o.decision_note = "Cancelled: the shift changed hands through another request."
            _bell(db, o.requester_email, "Shift request cancelled",
                  "A shift in your request changed hands through another request, so it was cancelled.",
                  o.id, actor, _EMPLOYEE_ACTION)
        title, verb = "Shift request approved", "approved"
    else:
        r.status = "declined"
        title, verb = "Shift request declined", "declined"
    for p in people:
        body_text = f"Your manager {verb}: {_describe(r, names)}" + (f". Note: {r.decision_note}" if r.decision_note else ".")
        _bell(db, p, title, body_text, r.id, actor, _EMPLOYEE_ACTION)
    db.commit()
    return _to_dict(r, names)
