"""More Details: HR-defined custom fields on employee records (Neil, Oct 27 2026).

  /hr/custom-fields                    the definitions (Settings > People & Access)
  /hr/employees/{eid}/custom-fields    one person's More Details in People
  /myhr/custom-fields                  the caller's own, in My HR

The rules (who sees which value, validation, the audit row) live in
hr_custom_fields.py; this file is the HTTP face. The /hr routes sit behind
the People grant and the company scope like every other People route; the
manager tier reaches only the two GETs (auth.TEAM_ALLOWED_HR_ROUTES) and never
sees an HR Only field or value.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

import hr_custom_fields as cf
from auth import get_current_user, hr_scope, is_team_scope
from database import get_db
from models import EmployeeCustomField, NexusEmployee
from routers.hr import _assert_scope, require_hr_read, require_hr_write

router = APIRouter(prefix="/hr", tags=["hr"])
my_router = APIRouter(prefix="/myhr", tags=["My HR"], dependencies=[Depends(get_current_user)])


class FieldIn(BaseModel):
    label: str
    field_type: Optional[str] = "text"
    options: Optional[list] = None
    company_id: Optional[str] = ""
    required: Optional[bool] = False
    visibility: Optional[str] = "hr_only"
    field_key: Optional[str] = ""


class FieldUpdate(BaseModel):
    label: Optional[str] = None
    field_type: Optional[str] = None
    options: Optional[list] = None
    company_id: Optional[str] = None
    required: Optional[bool] = None
    visibility: Optional[str] = None
    archived: Optional[bool] = None


class ReorderIn(BaseModel):
    ids: list


class ValuesIn(BaseModel):
    values: dict


def _bad(e: Exception):
    raise HTTPException(400, str(e))


def _check_write_scope(scope, company_id: str) -> None:
    """Every-company fields need company-wide People access; a company's own
    fields need that company in the caller's scope."""
    if scope is None:
        return
    if not company_id:
        raise HTTPException(403, "Fields for every company need company-wide People access - pick one of your companies")
    if company_id not in scope:
        raise HTTPException(403, "That company is outside your People access")


def _in_read_scope(f: EmployeeCustomField, scope) -> bool:
    return scope is None or not (f.company_id or "") or (f.company_id in scope)


def _team_companies(db: Session, scope) -> set:
    emails = sorted(scope.emails)
    if not emails:
        return set()
    rows = db.query(NexusEmployee.company).filter(func.lower(NexusEmployee.work_email).in_(emails)).all()
    return {c for (c,) in rows if c}


def _clean_type(raw: str) -> str:
    t = (raw or "text").strip().lower()
    if t not in cf.FIELD_TYPES:
        raise HTTPException(400, "Type must be Text, Number, Date, Dropdown or Checkbox")
    return t


def _clean_visibility(raw: str) -> str:
    v = (raw or "hr_only").strip().lower()
    if v not in cf.VISIBILITIES:
        raise HTTPException(400, "Visibility must be HR Only, Employee Can See or Employee Can Edit")
    return v


def _clean_label(raw: str) -> str:
    label = (raw or "").strip()[:cf.MAX_LABEL]
    if not label:
        raise HTTPException(400, "Give the field a label")
    return label


def _clean_company(db: Session, raw: str) -> str:
    cid = (raw or "").strip()
    if cid:
        from models import HrEntity
        if not db.query(HrEntity.id).filter(HrEntity.id == cid).first():
            raise HTTPException(400, "That company does not exist")
    return cid


# ── Definitions ──────────────────────────────────────────────────────────────

@router.get("/custom-fields")
def list_fields(include_archived: bool = False, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    """The fields this caller may see the definitions of: within their company
    scope; the manager tier gets no HR Only field and no archived one."""
    scope = hr_scope(user, db)
    rows = cf.all_fields(db, include_archived=include_archived)
    if is_team_scope(scope):
        companies = _team_companies(db, scope)
        rows = [f for f in rows if not f.archived and cf.visible_to(f, "team")
                and (not (f.company_id or "") or f.company_id in companies)]
    else:
        rows = [f for f in rows if _in_read_scope(f, scope)]
    return [cf.serialize_field(f) for f in rows]


@router.post("/custom-fields", status_code=201)
def create_field(body: FieldIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    scope = hr_scope(user, db)
    company_id = _clean_company(db, body.company_id)
    _check_write_scope(scope, company_id)
    if db.query(EmployeeCustomField).count() >= cf.MAX_FIELDS:
        raise HTTPException(400, f"There can be at most {cf.MAX_FIELDS} fields - archive or reuse one")
    label = _clean_label(body.label)
    ftype = _clean_type(body.field_type)
    try:
        options = cf.clean_options(body.options) if ftype == "dropdown" else []
    except cf.FieldError as e:
        _bad(e)
    if ftype == "dropdown" and not options:
        raise HTTPException(400, "A dropdown needs at least one option")
    last = db.query(func.max(EmployeeCustomField.sort_order)).scalar() or 0
    now = cf._now()
    f = EmployeeCustomField(
        id=cf.new_field_id(), field_key=cf.unique_key(db, body.field_key or label), label=label,
        field_type=ftype, options=options, company_id=company_id,
        # A checkbox always has a value (checked or not), so it is never "required".
        required=1 if (body.required and ftype != "checkbox") else 0,
        sort_order=last + 1, visibility=_clean_visibility(body.visibility), archived=0,
        created_by=user["email"], created_at=now, updated_by=user["email"], updated_at=now)
    db.add(f)
    db.commit()
    return cf.serialize_field(f)


def _field_or_404(db: Session, fid: str, scope) -> EmployeeCustomField:
    f = db.query(EmployeeCustomField).filter(EmployeeCustomField.id == fid).first()
    if f is None or not _in_read_scope(f, scope):
        raise HTTPException(404, "Field not found")
    return f


@router.patch("/custom-fields/{fid}")
def update_field(fid: str, body: FieldUpdate, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Everything but the key can change. Values are never touched: a value
    that no longer fits a new type or a removed option stays stored and shows
    as it was until someone edits that field."""
    scope = hr_scope(user, db)
    f = _field_or_404(db, fid, scope)
    _check_write_scope(scope, f.company_id or "")
    if body.company_id is not None:
        cid = _clean_company(db, body.company_id)
        _check_write_scope(scope, cid)
        f.company_id = cid
    if body.label is not None:
        f.label = _clean_label(body.label)
    if body.field_type is not None:
        f.field_type = _clean_type(body.field_type)
    if body.options is not None or body.field_type is not None:
        try:
            raw = body.options if body.options is not None else (f.options or [])
            f.options = cf.clean_options(raw) if f.field_type == "dropdown" else []
        except cf.FieldError as e:
            _bad(e)
        if f.field_type == "dropdown" and not f.options:
            raise HTTPException(400, "A dropdown needs at least one option")
    if body.visibility is not None:
        f.visibility = _clean_visibility(body.visibility)
    if body.required is not None:
        f.required = 1 if body.required else 0
    if f.field_type == "checkbox":
        f.required = 0
    if body.archived is not None:
        f.archived = 1 if body.archived else 0     # values stay in custom_fields either way
    f.updated_by = user["email"]
    f.updated_at = cf._now()
    db.commit()
    return cf.serialize_field(f)


@router.post("/custom-fields/reorder")
def reorder_fields(body: ReorderIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Puts the listed fields in this order, keeping the slots they held, so
    fields the caller does not see keep their places."""
    scope = hr_scope(user, db)
    ids = [str(i) for i in (body.ids or [])][:cf.MAX_FIELDS]
    rows = {f.id: f for f in db.query(EmployeeCustomField).filter(EmployeeCustomField.id.in_(ids)).all()}
    picked = [rows[i] for i in ids if i in rows]
    for f in picked:
        if not _in_read_scope(f, scope):
            raise HTTPException(404, "Field not found")
        _check_write_scope(scope, f.company_id or "")
    slots = sorted(f.sort_order or 0 for f in picked)
    # Equal slots (fields made before ordering mattered) would not move.
    if len(set(slots)) < len(slots):
        base = slots[0] if slots else 0
        slots = list(range(base, base + len(picked)))
    for f, slot in zip(picked, slots):
        f.sort_order = slot
    db.commit()
    return [cf.serialize_field(f) for f in cf.all_fields(db, include_archived=True) if _in_read_scope(f, scope)]


# ── One person's values in People ────────────────────────────────────────────

def _employee_in_scope(db: Session, eid: str, user: dict, lock: bool = False) -> NexusEmployee:
    q = db.query(NexusEmployee).filter(NexusEmployee.id == eid)
    # A save re-reads the row locked: two people saving different fields at
    # once must not each write back the other's old values.
    emp = (q.with_for_update() if lock else q).first()
    if emp is None:
        raise HTTPException(404, "Employee not found")
    _assert_scope(emp, hr_scope(user, db))
    return emp


def _can_write(user: dict, db: Session) -> bool:
    from auth import _LEVELS, _MODULE_LEVEL_RANK, _module_level
    return (user.get("level", 0) >= _LEVELS["administrator"]
            or _module_level(user.get("email") or "", "hr", db) >= _MODULE_LEVEL_RANK["editor"])


@router.get("/employees/{eid}/custom-fields")
def get_employee_fields(eid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    emp = _employee_in_scope(db, eid, user)
    return cf.record_view(db, emp, cf.audience_for(user, emp), can_write=_can_write(user, db))


@router.put("/employees/{eid}/custom-fields")
def save_employee_fields(eid: str, body: ValuesIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Saves only the fields sent. A removed person is read-only."""
    emp = _employee_in_scope(db, eid, user, lock=True)
    if emp.deleted_at:
        raise HTTPException(409, "This person was removed from Nexus - restore them to edit their record")
    audience = cf.audience_for(user, emp)
    try:
        cf.apply_changes(db, emp, body.values, audience, user)
    except cf.FieldError as e:
        _bad(e)
    except PermissionError as e:
        raise HTTPException(403, str(e)) from None
    db.commit()
    db.refresh(emp)
    return cf.record_view(db, emp, audience)


# ── My HR ────────────────────────────────────────────────────────────────────

def _me(db: Session, email: str, lock: bool = False) -> NexusEmployee:
    q = db.query(NexusEmployee).filter(func.lower(NexusEmployee.work_email) == (email or "").lower())
    row = (q.with_for_update() if lock else q).first()
    if not row:
        raise HTTPException(404, "No HR record is linked to your account yet - ask HR to add you.")
    return row


@my_router.get("/custom-fields")
def my_fields(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The caller's own Employee Can See / Employee Can Edit fields."""
    return cf.record_view(db, _me(db, user["email"]), "self")


@my_router.put("/custom-fields")
def save_my_fields(body: ValuesIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    emp = _me(db, user["email"], lock=True)
    try:
        cf.apply_changes(db, emp, body.values, "self", user)
    except cf.FieldError as e:
        _bad(e)
    except PermissionError as e:
        raise HTTPException(403, str(e)) from None
    db.commit()
    db.refresh(emp)
    return cf.record_view(db, emp, "self")

