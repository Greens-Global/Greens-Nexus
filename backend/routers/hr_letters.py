"""HR letters API (Neil, Oct 27 2026) - permissions and shapes only; the
engine is hr_letters.py.

Not under /hr on purpose: the company's HR contact handles its letters
whatever their role tier, and /hr routes are closed to the manager tier
(auth.team_people_gate). Every HR route checks hr_letters.is_hr_for itself.

    employee   GET  /letter-requests/types | /mine     POST /letter-requests
    HR         GET  /letter-requests/queue | /{id}/review
               POST /letter-requests/{id}/start-review | /preview | /issue | /decline
               PUT  /letter-requests/{id}/values
    Settings   GET / PUT /letter-requests/settings?company_id=
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

import hr_letters as hl
from auth import get_current_user, hr_scope, is_team_scope
from database import get_db
from models import DocLetterhead, DocTemplate, HrEntity, HrLetterRequest, NexusEmployee
from routers.hr import require_hr_read, require_hr_write

router = APIRouter(prefix="/letter-requests", tags=["hr-letters"], dependencies=[Depends(get_current_user)])


def _raise(e: hl.LetterError):
    raise HTTPException(e.status, str(e))


def _seed(db: Session) -> None:
    """The default templates exist before anything reads them (idempotent)."""
    if hl.ensure_templates(db):
        db.commit()


def _me(db: Session, user: dict) -> NexusEmployee:
    email = (user.get("email") or "").strip().lower()
    emp = db.query(NexusEmployee).filter(func.lower(NexusEmployee.work_email) == email).first() if email else None
    if emp is None:
        raise HTTPException(404, "No HR record is linked to your account yet - ask HR to add you.")
    return emp


# ── the employee ─────────────────────────────────────────────────────────────

@router.get("/types")
def letter_types(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The letters the caller's company offers."""
    emp = _me(db, user)
    return [{"key": t["key"], "label": t["label"], "desc": t["desc"], "printsPay": t["pay"]}
            for t in hl.enabled_types(db, emp.company or "")]


@router.get("/mine")
def my_letters(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    emp = _me(db, user)
    rows = (db.query(HrLetterRequest).filter(HrLetterRequest.employee_id == emp.id)
            .order_by(HrLetterRequest.created_at.desc()).limit(50).all())
    return [hl.ser(db, r) for r in rows]


class LetterIn(BaseModel):
    letter_type:  str
    purpose:      str
    addressed_to: Optional[str] = ""
    needed_by:    Optional[str] = ""
    notes:        Optional[str] = ""


@router.post("")
def request_letter(body: LetterIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    emp = _me(db, user)
    try:
        req = hl.create(db, emp, body.model_dump())
    except hl.LetterError as e:
        db.rollback()
        _raise(e)
    db.commit()
    return hl.ser(db, req)


# ── HR ───────────────────────────────────────────────────────────────────────

def _load(db: Session, rid: str, user: dict, lock: bool = False) -> HrLetterRequest:
    q = db.query(HrLetterRequest).filter(HrLetterRequest.id == rid)
    req = (q.with_for_update() if lock else q).first()
    # 404, not 403, for a request outside the caller's companies - its
    # existence does not leak.
    if req is None or not hl.is_hr_for(db, user, req):
        raise HTTPException(404, "Letter request not found")
    return req


@router.get("/queue")
def queue(status: str = "open", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The requests of every company the caller is HR for. `status`: open
    (Requested, In Review, Awaiting Signature - the default), done (Issued,
    Declined) or all."""
    comps = hl.hr_companies(db, user)
    if comps is not None and not comps:
        return {"canReview": False, "requests": []}
    q = db.query(HrLetterRequest)
    if comps is not None:
        q = q.filter(HrLetterRequest.company_id.in_(sorted(comps)))
    if status == "open":
        q = q.filter(HrLetterRequest.status.in_(hl.OPEN))
    elif status == "done":
        q = q.filter(HrLetterRequest.status.in_(("issued", "declined")))
    me = (user.get("email") or "").lower()
    rows = [r for r in q.order_by(HrLetterRequest.created_at.desc()).limit(200).all()
            if (r.employee_email or "").lower() != me]
    return {"canReview": True, "requests": [hl.ser(db, r, for_hr=True) for r in rows]}


@router.get("/{rid}/review")
def review(rid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The review screen: values, signer, problems. A read (api.js may retry)."""
    _seed(db)
    return hl.review_out(db, _load(db, rid, user), user)


@router.post("/{rid}/start-review")
def start_review(rid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    req = _load(db, rid, user, lock=True)
    try:
        hl.start_review(db, req, user)
    except hl.LetterError as e:
        db.rollback()
        _raise(e)
    db.commit()
    return hl.ser(db, req, for_hr=True)


class ValuesIn(BaseModel):
    values:     Optional[dict] = None
    pay_values: Optional[dict] = None


@router.put("/{rid}/values")
def save_values(rid: str, body: ValuesIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _seed(db)
    req = _load(db, rid, user, lock=True)
    try:
        hl.save_values(db, req, user, body.values, body.pay_values)
    except hl.LetterError as e:
        db.rollback()
        _raise(e)
    db.commit()
    return hl.review_out(db, req, user)


@router.post("/{rid}/preview")
def preview(rid: str, body: ValuesIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The letter as it would be issued with these values - nothing saved."""
    _seed(db)
    req = _load(db, rid, user)
    try:
        pdf = hl.preview(db, req, user, body.values, body.pay_values)
    except hl.LetterError as e:
        _raise(e)
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="{hl.type_label(req.letter_type)} - Preview.pdf"'})


class IssueIn(ValuesIn):
    excluded_ack: Optional[bool] = False


@router.post("/{rid}/issue")
def issue(rid: str, body: IssueIn, request: Request, user: dict = Depends(get_current_user),
          db: Session = Depends(get_db)):
    from routers.esign import _client_meta
    _seed(db)
    req = _load(db, rid, user, lock=True)
    ip, ua = _client_meta(request)
    try:
        out = hl.issue(db, req, user, values=body.values, pay_values=body.pay_values,
                       excluded_ack=bool(body.excluded_ack), ip=ip, user_agent=ua)
    except hl.LetterError as e:
        db.rollback()
        _raise(e)
    req = db.query(HrLetterRequest).filter(HrLetterRequest.id == rid).first()
    return {**hl.ser(db, req, for_hr=True), **out}


class DeclineIn(BaseModel):
    reason: str


@router.post("/{rid}/decline")
def decline(rid: str, body: DeclineIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    req = _load(db, rid, user, lock=True)
    try:
        hl.decline(db, req, user, body.reason)
    except hl.LetterError as e:
        db.rollback()
        _raise(e)
    db.commit()
    return hl.ser(db, req, for_hr=True)


# ── Settings > Hiring & Onboarding > HR Letters ──────────────────────────────

def _settings_scope(db: Session, user: dict, company_id: str, write: bool) -> None:
    """The organization row is for HR who sees every company; a company's
    own copy for HR whose People scope includes it. The manager tier (whose
    People scope is their team) changes neither."""
    scope = hr_scope(user, db)
    if is_team_scope(scope):
        raise HTTPException(403, "As a manager, People shows your own team - HR letter settings aren't included")
    if not company_id:
        if write and scope is not None:
            raise HTTPException(403, "Only HR with access to every company can change the default for every company.")
        return
    if (scope is not None and company_id not in scope) or not db.query(HrEntity).filter(HrEntity.id == company_id).first():
        raise HTTPException(404, "Company not found")


def _settings_out(db: Session, company_id: str) -> dict:
    cfg = hl.settings_for(db, company_id)
    tpls = (db.query(DocTemplate).filter(DocTemplate.status == "active", DocTemplate.doc_type != "email")
            .order_by(DocTemplate.name).all())
    names = {t.id: t.name for t in tpls}
    return {
        "companyId": company_id or "",
        "hasOverride": hl.has_override(db, company_id) if company_id else False,
        "letterheadId": cfg["letterheadId"],
        "types": [{"key": t["key"], "label": t["label"], "desc": t["desc"], "printsPay": t["pay"],
                   "on": cfg[t["key"]]["on"], "templateId": cfg[t["key"]]["templateId"],
                   "defaultTemplateId": hl.default_template_id(t["key"]),
                   "templateName": names.get(cfg[t["key"]]["templateId"] or hl.default_template_id(t["key"]), "")}
                  for t in hl.LETTER_TYPES],
        "templates": [{"id": t.id, "name": t.name, "published": bool(t.published_version)} for t in tpls],
        "letterheads": [{"id": lh.id, "name": lh.name, "isDefault": bool(lh.is_default)}
                        for lh in db.query(DocLetterhead).order_by(DocLetterhead.name).all()],
    }


@router.get("/settings")
def get_settings(company_id: str = "", user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    company_id = (company_id or "").strip()
    _settings_scope(db, user, company_id, write=False)
    _seed(db)
    return _settings_out(db, company_id)


class SettingsIn(BaseModel):
    types:        Optional[dict] = None     # {key: {on, templateId}}
    letterhead_id: Optional[str] = ""
    reset:        Optional[bool] = False     # a company: back to the default for every company


@router.put("/settings")
def put_settings(body: SettingsIn, company_id: str = "", user: dict = Depends(require_hr_write),
                 db: Session = Depends(get_db)):
    import scoped_settings as sc
    company_id = (company_id or "").strip()
    _settings_scope(db, user, company_id, write=True)
    if body.reset:
        if company_id:
            sc.reset(db, hl.SETTINGS_BASE, company_id)
            db.commit()
        return _settings_out(db, company_id)
    cfg = {**(body.types or {}), "letterheadId": body.letterhead_id or ""}
    try:
        hl.save_settings(db, company_id, cfg, user["email"])
    except hl.LetterError as e:
        db.rollback()
        _raise(e)
    db.commit()
    return _settings_out(db, company_id)
