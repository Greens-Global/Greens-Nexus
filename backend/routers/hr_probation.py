"""Probation routes (Neil, Oct 27 2026) - the rules live in hr_probation.py.

    GET  /hr/employees/{eid}/probation                the profile card (HR readers in scope, the manager)
    POST /hr/employees/{eid}/probation/decision       Confirm / Extend / End - HR++ finalizes, a manager recommends
    POST /hr/employees/{eid}/probation/approve        HR++ approves the manager's recommendation
    POST /hr/employees/{eid}/probation/decline        HR++ declines it, with a note for the manager
    POST /hr/employees/{eid}/probation/start          HR++ starts tracking (someone Not Tracked), or a new
                                                      probation from a day HR picks (start_date)
    PATCH /hr/employees/{eid}/probation               HR++ edits the length or the end date
    POST /hr/employees/{eid}/probation/remove         HR++ Remove From Probation (reason required)
    POST /hr/employees/{eid}/probation/stop           the old Stop Tracking - an alias of remove
    POST /hr/employees/{eid}/probation/send-letter    HR++ sends the letter again
    POST /hr/employees/{eid}/probation/letter-preview HR++ sees the PDF a decision would send
    GET/PUT /hr/probation/settings                    Settings > Hiring & Onboarding > Probation

The two a manager uses are on auth.TEAM_ALLOWED_HR_ROUTES; every route
checks the record itself (404 when the caller may not see the person).
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

import hr_probation as hp
import models
from auth import get_current_user, require_module_grant
from database import get_db

router = APIRouter(prefix="/hr", tags=["hr-probation"])
require_hr_read = require_module_grant("hr", "viewer")


def _employee(db: Session, eid: str, user: dict, lock: bool = False) -> models.NexusEmployee:
    q = db.query(models.NexusEmployee).filter(models.NexusEmployee.id == eid)
    emp = (q.with_for_update() if lock else q).first()
    if emp is None or not hp.can_read(db, user, emp):
        raise HTTPException(404, "Employee not found")
    return emp


def _run(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except hp.ProbationError as e:
        raise HTTPException(e.status, str(e))


@router.get("/employees/{eid}/probation")
def get_probation(eid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return hp.ser(db, _employee(db, eid, user), user)


class DecisionIn(BaseModel):
    decision: str
    new_end_date: Optional[str] = ""
    reason: Optional[str] = ""


@router.post("/employees/{eid}/probation/decision")
def decide(eid: str, body: DecisionIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    emp = _employee(db, eid, user, lock=True)
    out = _run(hp.decide, db, user, emp, (body.decision or "").strip().lower(),
               new_end=body.new_end_date or "", reason=body.reason or "")
    emp = _employee(db, eid, user)
    return {**out, "probation": hp.ser(db, emp, user)}


class ApproveIn(BaseModel):
    new_end_date: Optional[str] = None
    reason: Optional[str] = None


@router.post("/employees/{eid}/probation/approve")
def approve(eid: str, body: ApproveIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    emp = _employee(db, eid, user, lock=True)
    out = _run(hp.approve_pending, db, user, emp, new_end=body.new_end_date, reason=body.reason)
    return {**out, "probation": hp.ser(db, _employee(db, eid, user), user)}


class NoteIn(BaseModel):
    note: Optional[str] = ""


@router.post("/employees/{eid}/probation/decline")
def decline(eid: str, body: NoteIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    emp = _employee(db, eid, user, lock=True)
    _run(hp.decline_pending, db, user, emp, body.note or "")
    return {"probation": hp.ser(db, _employee(db, eid, user), user)}


class StartIn(BaseModel):
    months: Optional[int] = None
    reason: Optional[str] = ""
    start_date: Optional[str] = ""


@router.post("/employees/{eid}/probation/start")
def start(eid: str, body: StartIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    emp = _employee(db, eid, user, lock=True)
    _run(hp.begin, db, user, emp, months=body.months, reason=body.reason or "", start=body.start_date or "")
    return {"probation": hp.ser(db, _employee(db, eid, user), user)}


class EditIn(BaseModel):
    months: Optional[int] = None
    use_company_length: Optional[bool] = False
    end_date: Optional[str] = None
    reason: Optional[str] = ""


@router.patch("/employees/{eid}/probation")
def edit(eid: str, body: EditIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    emp = _employee(db, eid, user, lock=True)
    _run(hp.edit, db, user, emp, months=body.months, end_date=body.end_date,
         clear_months=bool(body.use_company_length), reason=body.reason or "")
    return {"probation": hp.ser(db, _employee(db, eid, user), user)}


class StopIn(BaseModel):
    reason: Optional[str] = ""


@router.post("/employees/{eid}/probation/remove")
def remove(eid: str, body: StopIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    emp = _employee(db, eid, user, lock=True)
    _run(hp.remove, db, user, emp, body.reason or "")
    return {"probation": hp.ser(db, _employee(db, eid, user), user)}


@router.post("/employees/{eid}/probation/stop")
def stop(eid: str, body: StopIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    emp = _employee(db, eid, user, lock=True)
    _run(hp.stop_tracking, db, user, emp, body.reason or "")
    return {"probation": hp.ser(db, _employee(db, eid, user), user)}


@router.post("/employees/{eid}/probation/send-letter")
def send_letter(eid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    emp = _employee(db, eid, user, lock=True)
    out = _run(hp.resend_letter, db, user, emp)
    return {"letter": out, "probation": hp.ser(db, _employee(db, eid, user), user)}


@router.post("/employees/{eid}/probation/letter-preview")
def letter_preview(eid: str, body: DecisionIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    emp = _employee(db, eid, user)
    pdf, title = _run(hp.preview, db, user, emp, (body.decision or "").strip().lower(),
                      body.new_end_date or "", body.reason or "")
    import hr_life_events as hle
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="{hle._safe_name(title)}.pdf"'})


# ── Settings > Hiring & Onboarding > Probation ───────────────────────────────

def _can_edit(db: Session, user: dict) -> bool:
    from routers.hr_checklists import _is_hr_editor
    return _is_hr_editor(user, db)


def _editable_companies(db: Session, user: dict):
    """None = the default and every company; else the companies this HR
    person's People access is limited to."""
    from auth import hr_scope, is_team_scope
    scope = hr_scope(user, db)
    if scope is None:
        return None
    return set() if is_team_scope(scope) else set(scope)


@router.get("/probation/settings")
def get_settings(company: str = "", user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    cid = (company or "").strip()
    can = _can_edit(db, user)
    allowed = _editable_companies(db, user) if can else set()
    ents = db.query(models.HrEntity.id, models.HrEntity.name).order_by(models.HrEntity.name).all()
    templates = (db.query(models.DocTemplate)
                 .filter(models.DocTemplate.status == "active", models.DocTemplate.doc_type != "email")
                 .order_by(models.DocTemplate.name).all())
    letterheads = db.query(models.DocLetterhead).order_by(models.DocLetterhead.name).all()
    return {
        "company": cid, "settings": hp.settings(db, cid), "tenant": hp.settings(db),
        "defaults": dict(hp.DEFAULTS), "limits": {k: list(v) for k, v in hp.LIMITS.items()},
        "override": hp.has_override(db, cid),
        "canEdit": can and (allowed is None or (bool(cid) and cid in allowed)),
        "canEditDefault": can and allowed is None,
        "companies": [{"id": i, "name": n or i} for i, n in ents if can and (allowed is None or i in allowed)],
        "templates": [{"id": t.id, "name": t.name, "published": bool(t.published_version), "category": t.category or ""}
                      for t in templates],
        "letterheads": [{"id": lh.id, "name": lh.name, "isDefault": bool(lh.is_default)} for lh in letterheads],
    }


class SettingsIn(BaseModel):
    company: Optional[str] = ""
    settings: dict = {}
    reset: Optional[bool] = False


@router.put("/probation/settings")
def put_settings(body: SettingsIn, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    if not _can_edit(db, user):
        raise HTTPException(403, "Only HR editors and administrators change the probation settings")
    cid = (body.company or "").strip()
    allowed = _editable_companies(db, user)
    if allowed is not None and (not cid or cid not in allowed):
        raise HTTPException(403, "Outside your companies")
    if cid and not db.query(models.HrEntity.id).filter(models.HrEntity.id == cid).first():
        raise HTTPException(404, "Company not found")
    saved = _run(hp.save_settings, db, cid, body.settings or {}, user["email"], reset=bool(body.reset))
    return {"company": cid, "settings": saved, "override": hp.has_override(db, cid)}
