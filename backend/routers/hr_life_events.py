"""HR life events API - packet settings per company, the hiring packet send,
and the event list each person/candidate shows. The engine is
hr_life_events.py; this file is permissions and shapes only."""
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

import hr_life_events as hle
from auth import hr_scope
from database import get_db
from models import HrCandidate, HrLifeEvent, HrPacketSetting, HrSignTemplate, NexusEmployee
from routers.hr import _has_comp, require_hr_read, require_hr_write

router = APIRouter(prefix="/hr", tags=["hr-life-events"])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _client_meta(request: Request) -> tuple:
    from routers.esign import _client_meta as cm
    return cm(request)


def _raise(e: hle.PacketError):
    raise HTTPException(e.status, str(e))


# ── packet settings ──────────────────────────────────────────────────────────

class PacketSettingIn(BaseModel):
    entity_id:        Optional[str] = ""
    event:            str
    worker_type:      Optional[str] = "any"
    template_id:      str
    subject_role:     Optional[str] = "employee"
    email_message:    Optional[str] = ""
    egnyte_subfolder: Optional[str] = ""


def _setting_in_scope(entity_id: str, scope, write: bool) -> None:
    # The default row ('' = every company) is shared - only someone who sees
    # every company may change it; a company-scoped HR admin reads it.
    if scope is None:
        return
    if not entity_id:
        if write:
            raise HTTPException(403, "Only HR with access to every company can change the default packet.")
        return
    if entity_id not in scope:
        raise HTTPException(404, "Company not found")


@router.get("/packets")
def list_packets(user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    scope = hr_scope(user, db)
    rows = db.query(HrPacketSetting).all()
    rows = [r for r in rows if scope is None or not r.entity_id or r.entity_id in scope]
    tpls = (db.query(HrSignTemplate).filter(HrSignTemplate.status == "active")
            .order_by(HrSignTemplate.name).all())
    tpls = [t for t in tpls if scope is None or not t.entity_id or t.entity_id in scope]
    return {
        "settings": [hle.ser_setting(db, r) for r in rows],
        "templates": [{"id": t.id, "name": t.name, "kind": t.kind, "entityId": t.entity_id or "",
                       "roles": hle.template_roles(t),
                       "documents": 1 + len([a for a in (t.attachments or []) if a.get("path")])}
                      for t in tpls],
        "events": [{"key": k, "label": hle.EVENT_TITLES[k], "defaultSubfolder": hle.DEFAULT_SUBFOLDERS[k]}
                   for k in hle.EVENTS],
        "workerTypes": list(hle.WORKER_TYPES),
    }


@router.put("/packets")
def save_packet(body: PacketSettingIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    entity_id = (body.entity_id or "").strip()
    _setting_in_scope(entity_id, hr_scope(user, db), write=True)
    wt = (body.worker_type or "any").strip()
    row = (db.query(HrPacketSetting)
           .filter(HrPacketSetting.entity_id == entity_id, HrPacketSetting.event == body.event,
                   HrPacketSetting.worker_type == wt).with_for_update().first())
    now = _now()
    if row is None:
        row = HrPacketSetting(id=str(uuid.uuid4()), entity_id=entity_id, event=body.event,
                              worker_type=wt, created_at=now)
        db.add(row)
    row.template_id = (body.template_id or "").strip()
    row.subject_role = (body.subject_role or "employee").strip()
    row.email_message = (body.email_message or "").strip()[:4000]
    row.egnyte_subfolder = hle._safe_name(body.egnyte_subfolder, 60) if (body.egnyte_subfolder or "").strip() else ""
    row.updated_by, row.updated_at = user["email"], now
    problems = hle.setting_problems(db, row)
    if problems:
        db.rollback()
        raise HTTPException(400, problems[0])
    db.commit()
    return hle.ser_setting(db, row)


@router.delete("/packets/{sid}")
def delete_packet(sid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    row = db.query(HrPacketSetting).filter(HrPacketSetting.id == sid).first()
    if not row:
        raise HTTPException(404, "Packet setting not found")
    _setting_in_scope(row.entity_id or "", hr_scope(user, db), write=True)
    db.delete(row)
    db.commit()
    return {"ok": True}


@router.get("/packets/email-preview")
def packet_email_preview(event: str, entity_id: str = "", template_id: str = "", note: str = "",
                         role: str = "subject", stage: str = "invite",
                         user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    """The email a packet sends, rendered with a sample person - so HR sees
    exactly what a new hire / promoted employee / leaver receives."""
    import hr_life_email
    if event not in hle.EVENTS:
        raise HTTPException(400, "Unknown event")
    _setting_in_scope(entity_id, hr_scope(user, db), write=False)
    tpl = db.query(HrSignTemplate).filter(HrSignTemplate.id == template_id).first() if template_id else None
    docs = [a.get("name", "document.pdf") for a in ((tpl.attachments or []) if tpl else []) if a.get("path")]
    subject, html = hr_life_email.preview(db, user, event, entity_id, tpl.name if tpl else hle.EVENT_TITLES[event],
                                          note, docs, role="manager" if role == "manager" else "subject",
                                          stage="completed" if stage == "completed" else "invite")
    return {"subject": subject, "html": html}


# ── hiring packet ────────────────────────────────────────────────────────────

class HirePacketIn(BaseModel):
    inputs:       Optional[dict] = None   # job_title, department, start_date, manager_email, employment_type, salary_text, merge{}
    pay:          Optional[dict] = None   # {base, payBasis, frequency, currency} - hr_comp holders only
    excluded_ack: Optional[bool] = False


def _pay_allowed(body: HirePacketIn, user: dict, db: Session) -> Optional[dict]:
    if body.pay and body.pay.get("base") not in (None, ""):
        if not _has_comp(user, db):
            raise HTTPException(403, "Entering pay needs the Pay & Benefits (hr_comp) access - "
                                     "type the pay as text in the offer instead.")
        return body.pay
    return None


@router.post("/candidates/{cid}/hiring-packet/preview")
def preview_hiring_packet(cid: str, body: HirePacketIn, user: dict = Depends(require_hr_write),
                          db: Session = Depends(get_db)):
    try:
        plan = hle.plan_hire(db, user, cid, body.inputs or {}, _pay_allowed(body, user, db),
                             hr_scope(user, db))
    except hle.PacketError as e:
        _raise(e)
    return hle.preview_out(plan)


@router.post("/candidates/{cid}/hiring-packet")
def send_hiring_packet(cid: str, body: HirePacketIn, request: Request,
                       user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    if not body.excluded_ack:
        raise HTTPException(422, "Confirm the packet is not a record excluded from electronic signature.")
    ip, ua = _client_meta(request)
    try:
        ev = hle.send_hire(db, user, cid, body.inputs or {}, _pay_allowed(body, user, db),
                           hr_scope(user, db), excluded_ack=True, ip=ip, user_agent=ua)
    except hle.PacketError as e:
        db.rollback()
        _raise(e)
    out = hle.ser_event(db, ev, show_pay=_has_comp(user, db))
    out["senderPartyId"] = hle.sender_party_id(db, ev, user["email"])
    return out


# ── promotion / role change ──────────────────────────────────────────────────

@router.post("/employees/{eid}/promotion/preview")
def preview_promotion(eid: str, body: HirePacketIn, user: dict = Depends(require_hr_write),
                      db: Session = Depends(get_db)):
    try:
        plan = hle.plan_promotion(db, user, eid, body.inputs or {}, _pay_allowed(body, user, db),
                                  hr_scope(user, db))
    except hle.PacketError as e:
        _raise(e)
    return hle.promotion_preview_out(plan)


@router.post("/employees/{eid}/promotion")
def send_promotion(eid: str, body: HirePacketIn, request: Request,
                   user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    if not body.excluded_ack:
        raise HTTPException(422, "Confirm the letter is not a record excluded from electronic signature.")
    ip, ua = _client_meta(request)
    try:
        ev = hle.send_promotion(db, user, eid, body.inputs or {}, _pay_allowed(body, user, db),
                                hr_scope(user, db), excluded_ack=True, ip=ip, user_agent=ua)
    except hle.PacketError as e:
        db.rollback()
        _raise(e)
    out = hle.ser_event(db, ev, show_pay=_has_comp(user, db))
    out["senderPartyId"] = hle.sender_party_id(db, ev, user["email"])
    return out


# ── offboarding ──────────────────────────────────────────────────────────────

class SeparationIn(BaseModel):
    inputs:       Optional[dict] = None   # last_day, exit_type, reason, send_package, start_checklist, offboarding{}, merge{}
    excluded_ack: Optional[bool] = False


@router.post("/employees/{eid}/offboard/preview")
def preview_offboard(eid: str, body: SeparationIn, user: dict = Depends(require_hr_write),
                     db: Session = Depends(get_db)):
    try:
        plan = hle.plan_separation(db, user, eid, body.inputs or {}, hr_scope(user, db))
    except hle.PacketError as e:
        _raise(e)
    return hle.separation_preview_out(plan)


@router.post("/employees/{eid}/offboard")
def offboard(eid: str, body: SeparationIn, request: Request,
             user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    if (body.inputs or {}).get("send_package", True) and not body.excluded_ack:
        raise HTTPException(422, "Confirm the package is not a record excluded from electronic signature.")
    ip, ua = _client_meta(request)
    try:
        ev, result = hle.send_separation(db, user, eid, body.inputs or {}, hr_scope(user, db),
                                         excluded_ack=bool(body.excluded_ack), ip=ip, user_agent=ua)
    except hle.PacketError as e:
        db.rollback()
        _raise(e)
    out = hle.ser_event(db, ev, show_pay=False)
    out["senderPartyId"] = hle.sender_party_id(db, ev, user["email"])
    out["result"] = {k: v for k, v in (result or {}).items() if k in ("m365", "items", "handover")}
    return out


@router.post("/life-events/{eid}/cancel-offboarding")
def cancel_offboarding(eid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    ev = db.query(HrLifeEvent).filter(HrLifeEvent.id == eid).with_for_update().first()
    if not ev:
        raise HTTPException(404, "Not found")
    _event_in_scope(db, ev, hr_scope(user, db))
    try:
        hle.cancel_separation(db, ev, user["email"])
    except hle.PacketError as e:
        _raise(e)
    db.refresh(ev)
    return hle.ser_event(db, ev, show_pay=False)


# ── events ───────────────────────────────────────────────────────────────────

def _event_in_scope(db: Session, ev: HrLifeEvent, scope) -> None:
    if scope is not None and (ev.entity_id or "") not in scope:
        raise HTTPException(404, "Not found")


@router.get("/life-events")
def list_events(candidate_id: Optional[str] = "", employee_id: Optional[str] = "",
                user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    if not (candidate_id or employee_id):
        raise HTTPException(400, "Pass candidate_id or employee_id")
    scope = hr_scope(user, db)
    q = db.query(HrLifeEvent)
    if candidate_id:
        cand = db.query(HrCandidate).filter(HrCandidate.id == candidate_id).first()
        if not cand or (scope is not None and (cand.company or "") not in scope):
            raise HTTPException(404, "Candidate not found")
        q = q.filter(HrLifeEvent.candidate_id == candidate_id)
    else:
        emp = db.query(NexusEmployee).filter(NexusEmployee.id == employee_id).first()
        if not emp or (scope is not None and (emp.company or "") not in scope):
            raise HTTPException(404, "Employee not found")
        q = q.filter(HrLifeEvent.employee_id == employee_id)
    show_pay = _has_comp(user, db)
    rows = q.order_by(HrLifeEvent.created_at.desc()).all()
    return [hle.ser_event(db, ev, show_pay=show_pay)
            | {"senderPartyId": hle.sender_party_id(db, ev, user["email"])} for ev in rows]


@router.post("/life-events/{eid}/retry-filing")
def retry_filing(eid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    ev = db.query(HrLifeEvent).filter(HrLifeEvent.id == eid).with_for_update().first()
    if not ev:
        raise HTTPException(404, "Not found")
    _event_in_scope(db, ev, hr_scope(user, db))
    if ev.status != "completed":
        raise HTTPException(409, "Only a fully signed packet can be filed.")
    if ev.filing_status == "filed":
        raise HTTPException(409, "Already filed in Egnyte.")
    ev.filing_attempts = 0
    hle.run_filing(db, ev)
    return hle.ser_event(db, ev, show_pay=_has_comp(user, db))


@router.post("/life-events/{eid}/retry-apply")
def retry_apply(eid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """The packet is fully signed but Nexus could not apply it (safe() flagged
    `apply_failed`): run the completion again, and show the error if it
    still fails."""
    ev = db.query(HrLifeEvent).filter(HrLifeEvent.id == eid).with_for_update().first()
    if not ev:
        raise HTTPException(404, "Not found")
    _event_in_scope(db, ev, hr_scope(user, db))
    try:
        hle.retry_apply(db, ev)
    except hle.PacketError as e:
        db.rollback()
        _raise(e)
    except Exception as e:
        db.rollback()
        raise HTTPException(500, f"Still failing: {type(e).__name__}: {str(e)[:300]}")
    db.refresh(ev)
    return hle.ser_event(db, ev, show_pay=_has_comp(user, db))


@router.post("/life-events/{eid}/void")
def void_event(eid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    ev = db.query(HrLifeEvent).filter(HrLifeEvent.id == eid).first()
    if not ev:
        raise HTTPException(404, "Not found")
    _event_in_scope(db, ev, hr_scope(user, db))
    if ev.status not in hle.ACTIVE:
        raise HTTPException(409, f"This packet is already {ev.status}.")
    from routers.esign import void_request
    void_request(ev.sign_request_id, user=user, db=db)   # moves the event via the hook
    db.refresh(ev)
    return hle.ser_event(db, ev, show_pay=_has_comp(user, db))
