"""Licenses & Certifications (Neil, 11/11/2026, Deputy parity) - the HTTP face.

  /hr/credential-types              the types (Settings > People & Access)
  /hr/employees/{eid}/credentials   one person's, on their Documents tab
  /hr/credentials                   everyone's in the caller's reach (People > Reports)
  /myhr/credentials                 the caller's own, read only, in My HR

The rules (state words, the shift warnings, what is stored) live in
hr_credentials.py. The /hr routes sit behind the People grant and the
company scope like every other People route; the manager tier reaches only
the GETs for their own team (auth.TEAM_ALLOWED_HR_ROUTES) - they schedule
those people, so they need to know who holds what.
"""
import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

import hr_credentials as hc
from auth import get_current_user, hr_scope, is_team_scope
from database import get_db
from models import AuditLog, HrCredential, HrCredentialType, HrDocument, HrEntity, NexusEmployee
from routers.hr import _assert_scope, _scoped, require_hr_read, require_hr_write

router = APIRouter(prefix="/hr", tags=["hr"])
my_router = APIRouter(prefix="/myhr", tags=["My HR"], dependencies=[Depends(get_current_user)])


class TypeIn(BaseModel):
    name: str
    description: Optional[str] = ""
    companyId: Optional[str] = ""
    expires: Optional[bool] = True
    validityMonths: Optional[int] = 0


class TypeUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    companyId: Optional[str] = None
    expires: Optional[bool] = None
    validityMonths: Optional[int] = None
    archived: Optional[bool] = None


class CredentialIn(BaseModel):
    typeId: str
    issuer: Optional[str] = ""
    number: Optional[str] = ""           # only the last four are kept
    issuedOn: Optional[str] = ""
    expiresOn: Optional[str] = None      # None = from the type's length
    documentId: Optional[str] = ""
    note: Optional[str] = ""
    verified: Optional[bool] = False


class CredentialUpdate(BaseModel):
    issuer: Optional[str] = None
    number: Optional[str] = None
    issuedOn: Optional[str] = None
    expiresOn: Optional[str] = None
    documentId: Optional[str] = None
    note: Optional[str] = None
    verified: Optional[bool] = None


def _bad(e: Exception):
    raise HTTPException(400, str(e))


def _audit(db: Session, user: dict, action: str, emp: NexusEmployee, details: dict) -> None:
    db.add(AuditLog(timestamp=hc.now_iso(), user_email=user["email"], user_role=str(user.get("role") or ""),
                    action=action, resource_type="employee", resource_id=emp.id,
                    details=json.dumps({"employee": emp.work_email or "", **details})[:4000]))


def _team_companies(db: Session, scope) -> set:
    emails = sorted(scope.emails)
    if not emails:
        return set()
    return {c for (c,) in db.query(NexusEmployee.company)
            .filter(func.lower(NexusEmployee.work_email).in_(emails)).all() if c}


def _type_readable(t: HrCredentialType, scope, team_companies: set = None) -> bool:
    if not (t.company_id or ""):
        return True
    if is_team_scope(scope):
        return t.company_id in (team_companies or set())
    return scope is None or t.company_id in scope


def _check_write_scope(scope, company_id: str) -> None:
    """Every-company types need company-wide People access; a company's own
    types need that company in the caller's scope."""
    if scope is None:
        return
    if not company_id:
        raise HTTPException(403, "Types for every company need company-wide People access - pick one of your companies")
    if company_id not in scope:
        raise HTTPException(403, "That company is outside your People access")


def _clean_company(db: Session, raw: str) -> str:
    cid = (raw or "").strip()
    if cid and not db.query(HrEntity.id).filter(HrEntity.id == cid).first():
        raise HTTPException(400, "That company does not exist")
    return cid


def _counts(db: Session) -> dict:
    return dict(db.query(HrCredential.type_id, func.count(HrCredential.id))
                .filter(HrCredential.removed_at == "").group_by(HrCredential.type_id).all())


# ── Types ────────────────────────────────────────────────────────────────

@router.get("/credential-types")
def list_types(include_archived: bool = False, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    scope = hr_scope(user, db)
    team = _team_companies(db, scope) if is_team_scope(scope) else None
    counts = _counts(db)
    rows = db.query(HrCredentialType).order_by(func.lower(HrCredentialType.name)).all()
    return [hc.serialize_type(t, counts.get(t.id, 0)) for t in rows
            if _type_readable(t, scope, team) and (include_archived or not t.archived)]


@router.post("/credential-types", status_code=201)
def create_type(body: TypeIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    scope = hr_scope(user, db)
    cid = _clean_company(db, body.companyId)
    _check_write_scope(scope, cid)
    if db.query(HrCredentialType).count() >= hc.MAX_TYPES:
        raise HTTPException(400, f"There can be at most {hc.MAX_TYPES} types - archive or reuse one")
    try:
        f = hc.clean_type_fields(body.name, body.description, body.expires, body.validityMonths)
    except hc.CredentialError as e:
        _bad(e)
    dupe = db.query(HrCredentialType.id).filter(func.lower(HrCredentialType.name) == f["name"].lower(),
                                                 HrCredentialType.company_id == cid,
                                                 HrCredentialType.archived == 0).first()
    if dupe:
        raise HTTPException(409, f"{f['name']} is already set up.")
    now = hc.now_iso()
    t = HrCredentialType(id=hc.new_id(), company_id=cid, archived=0, created_by=user["email"], created_at=now,
                         updated_by=user["email"], updated_at=now,
                         **{**f, "validity_months": f["validity_months"] if f["expires"] else 0})
    db.add(t)
    db.commit()
    return hc.serialize_type(t)


@router.patch("/credential-types/{tid}")
def update_type(tid: str, body: TypeUpdate, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Name, description, length, company and Archive. Records already
    saved keep their dates; a new length fills only new records."""
    scope = hr_scope(user, db)
    t = db.query(HrCredentialType).filter(HrCredentialType.id == tid).first()
    if t is None or not _type_readable(t, scope):
        raise HTTPException(404, "Type not found")
    _check_write_scope(scope, t.company_id or "")
    if body.companyId is not None:
        cid = _clean_company(db, body.companyId)
        _check_write_scope(scope, cid)
        t.company_id = cid
    try:
        f = hc.clean_type_fields(body.name, body.description, body.expires, body.validityMonths)
    except hc.CredentialError as e:
        _bad(e)
    for k, v in f.items():
        setattr(t, k, v)
    if not t.expires:
        t.validity_months = 0
    if body.archived is not None:
        t.archived = 1 if body.archived else 0
    t.updated_by, t.updated_at = user["email"], hc.now_iso()
    db.commit()
    return hc.serialize_type(t, _counts(db).get(t.id, 0))


# ── One person's records ─────────────────────────────────────────────────

def _employee(db: Session, eid: str, user: dict) -> NexusEmployee:
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
    if emp is None:
        raise HTTPException(404, "Employee not found")
    _assert_scope(emp, hr_scope(user, db))
    return emp


def _can_write(user: dict, db: Session) -> bool:
    from auth import _LEVELS, _MODULE_LEVEL_RANK, _module_level, hr_team_limited
    if hr_team_limited(user):
        return False
    return (user.get("level", 0) >= _LEVELS["administrator"]
            or _module_level(user.get("email") or "", "hr", db) >= _MODULE_LEVEL_RANK["editor"])


def _docs(db: Session, ids) -> dict:
    ids = [i for i in ids if i]
    return {d.id: d for d in db.query(HrDocument).filter(HrDocument.id.in_(ids)).all()} if ids else {}


def _person_payload(db: Session, emp: NexusEmployee, user: dict) -> dict:
    rows = hc.live_for(db, [emp.id]).get(emp.id, [])
    types = hc.types_by_id(db)
    docs = _docs(db, [c.document_id for c in rows])
    scope = hr_scope(user, db)
    team = _team_companies(db, scope) if is_team_scope(scope) else None
    return {
        "credentials": [hc.serialize(c, types.get(c.type_id), docs.get(c.document_id)) for c in rows],
        # The types this person can be given: live, and shared or their company's.
        "types": [hc.serialize_type(t) for t in sorted(types.values(), key=lambda t: (t.name or "").lower())
                  if not t.archived and hc.type_in_company(t, emp.company or "") and _type_readable(t, scope, team)],
        "canEdit": _can_write(user, db) and not emp.deleted_at,
        "expiringDays": hc.EXPIRING_DAYS,
    }


@router.get("/employees/{eid}/credentials")
def person_credentials(eid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    return _person_payload(db, _employee(db, eid, user), user)


def _check_document(db: Session, emp: NexusEmployee, doc_id: str) -> str:
    doc_id = (doc_id or "").strip()
    if not doc_id:
        return ""
    d = db.query(HrDocument).filter(HrDocument.id == doc_id).first()
    if d is None or d.employee_id != emp.id:
        raise HTTPException(400, "Pick one of this person's documents as the proof.")
    if d.kind in ("paystub", "settlement"):
        raise HTTPException(400, "A pay document cannot be the proof.")
    return doc_id


@router.post("/employees/{eid}/credentials", status_code=201)
def add_credential(eid: str, body: CredentialIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    emp = _employee(db, eid, user)
    if emp.deleted_at:
        raise HTTPException(409, "This person was removed from Nexus - restore them to edit their record")
    t = db.query(HrCredentialType).filter(HrCredentialType.id == (body.typeId or "").strip()).first()
    if t is None or t.archived or not hc.type_in_company(t, emp.company or ""):
        raise HTTPException(400, "Pick a license or certification type.")
    try:
        issued = hc.clean_date(body.issuedOn, "Issued")
        expires = hc.clean_date(body.expiresOn, "Expires") if body.expiresOn is not None else hc.default_expiry(t, issued)
    except hc.CredentialError as e:
        _bad(e)
    if not t.expires:
        expires = ""
    elif not expires:
        raise HTTPException(400, f"{t.name} expires - give its expiry date.")
    if issued and expires and expires < issued:
        raise HTTPException(400, "Expires is before Issued.")
    now = hc.now_iso()
    c = HrCredential(id=hc.new_id(), employee_id=emp.id, type_id=t.id, name=t.name,
                     issuer=(body.issuer or "").strip()[:hc.MAX_NAME], number_last4=hc.last4(body.number),
                     issued_on=issued, expires_on=expires, document_id=_check_document(db, emp, body.documentId),
                     note=(body.note or "").strip()[:hc.MAX_TEXT],
                     verified_by=user["email"] if body.verified else "", verified_at=now if body.verified else "",
                     created_by=user["email"], created_at=now, updated_by=user["email"], updated_at=now,
                     removed_by="", removed_at="")
    db.add(c)
    _audit(db, user, "Added a license or certification", emp,
           {"type": t.name, "issuedOn": issued, "expiresOn": expires})
    db.commit()
    return _person_payload(db, emp, user)


def _credential(db: Session, cid: str, user: dict):
    c = db.query(HrCredential).filter(HrCredential.id == cid, HrCredential.removed_at == "").first()
    if c is None:
        raise HTTPException(404, "Record not found")
    emp = _employee(db, c.employee_id, user)
    if emp.deleted_at:
        raise HTTPException(409, "This person was removed from Nexus - restore them to edit their record")
    return c, emp


@router.patch("/credentials/{cid}")
def update_credential(cid: str, body: CredentialUpdate, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    c, emp = _credential(db, cid, user)
    t = db.query(HrCredentialType).filter(HrCredentialType.id == c.type_id).first()
    before = {"issuedOn": c.issued_on, "expiresOn": c.expires_on}
    try:
        if body.issuedOn is not None:
            c.issued_on = hc.clean_date(body.issuedOn, "Issued")
        if body.expiresOn is not None:
            c.expires_on = hc.clean_date(body.expiresOn, "Expires")
    except hc.CredentialError as e:
        _bad(e)
    if t is not None and not t.expires:
        c.expires_on = ""
    elif t is not None and t.expires and not c.expires_on:
        raise HTTPException(400, f"{t.name} expires - give its expiry date.")
    if c.issued_on and c.expires_on and c.expires_on < c.issued_on:
        raise HTTPException(400, "Expires is before Issued.")
    if body.issuer is not None:
        c.issuer = body.issuer.strip()[:hc.MAX_NAME]
    if body.number is not None:
        c.number_last4 = hc.last4(body.number)
    if body.documentId is not None:
        c.document_id = _check_document(db, emp, body.documentId)
    if body.note is not None:
        c.note = body.note.strip()[:hc.MAX_TEXT]
    if body.verified is not None:
        c.verified_by, c.verified_at = (user["email"], hc.now_iso()) if body.verified else ("", "")
    c.updated_by, c.updated_at = user["email"], hc.now_iso()
    after = {"issuedOn": c.issued_on, "expiresOn": c.expires_on}
    _audit(db, user, "Changed a license or certification", emp,
           {"type": c.name, "before": before, "after": after, "verified": bool(c.verified_at)})
    db.commit()
    return _person_payload(db, emp, user)


@router.delete("/credentials/{cid}")
def remove_credential(cid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Takes a record off the person. The row is kept (`removed_at`), the
    proof document stays on their Documents tab."""
    c, emp = _credential(db, cid, user)
    c.removed_by, c.removed_at = user["email"], hc.now_iso()
    _audit(db, user, "Removed a license or certification", emp, {"type": c.name, "expiresOn": c.expires_on})
    db.commit()
    return _person_payload(db, emp, user)


# ── Everyone's, for the report ───────────────────────────────────────────

@router.get("/credentials")
def credentials_report(state: str = "", type_id: str = "", user: dict = Depends(require_hr_read),
                       db: Session = Depends(get_db)):
    """Every live record of the active and onboarding people in the caller's
    reach, with the person - People > Reports > Licenses & Certifications.
    `state` narrows to valid / expiring / expired / no_expiry; `type_id` to
    one type. Not for the manager tier (auth.team_people_gate)."""
    scope = hr_scope(user, db)
    people = {e.id: e for e in _scoped(db.query(NexusEmployee).filter(
        NexusEmployee.status.in_(["active", "onboarding"])), scope).all()}
    held = hc.live_for(db, list(people))
    types = hc.types_by_id(db)
    out = []
    for eid, lst in held.items():
        e = people[eid]
        for c in lst:
            if type_id and c.type_id != type_id:
                continue
            row = hc.serialize(c, types.get(c.type_id))
            if state and row["state"] != state:
                continue
            out.append({**row, "person": f"{e.first_name or ''} {e.last_name or ''}".strip(),
                        "workEmail": e.work_email or "", "company": e.company or "",
                        "department": e.department or "", "jobTitle": e.job_title or ""})
    out.sort(key=lambda r: (r["expiresOn"] or "9999-99-99", r["person"].lower()))
    return {"credentials": out, "expiringDays": hc.EXPIRING_DAYS,
            "types": [hc.serialize_type(t) for t in sorted(types.values(), key=lambda t: (t.name or "").lower())
                      if _type_readable(t, scope)]}


# ── My HR ────────────────────────────────────────────────────────────────

@my_router.get("/credentials")
def my_credentials(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The caller's own licenses and certifications, read only. HR adds and
    changes them; the person sees what is on file and when it expires."""
    emp = db.query(NexusEmployee).filter(func.lower(NexusEmployee.work_email) == (user.get("email") or "").lower()).first()
    if emp is None:
        return {"credentials": [], "expiringDays": hc.EXPIRING_DAYS}
    types = hc.types_by_id(db)
    rows = hc.live_for(db, [emp.id]).get(emp.id, [])
    out = []
    for c in rows:
        r = hc.serialize(c, types.get(c.type_id))
        r.pop("documentId", None)
        r.pop("note", None)
        out.append(r)
    return {"credentials": out, "expiringDays": hc.EXPIRING_DAYS}
