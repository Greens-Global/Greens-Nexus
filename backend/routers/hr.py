import re
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from database import get_db
from auth import require_level_or_module
from models import NexusEmployee

_ROLE_LEVEL = {"employee": 1, "supervisor": 2, "manager": 3, "administrator": 4, "owner": 5}

# HR data is the most sensitive in the app. Reads need supervisor+ (matches the
# sidebar gate) or an "hr" module grant; writes need manager+/editor; hard
# deletes are owner-only — prefer status changes (offboarded) over deletion.
require_hr_read   = require_level_or_module(_ROLE_LEVEL["supervisor"], "hr", "viewer")
require_hr_write  = require_level_or_module(_ROLE_LEVEL["manager"],    "hr", "editor")
require_hr_delete = require_level_or_module(_ROLE_LEVEL["owner"],      "hr", "owner")

router = APIRouter(prefix="/hr", tags=["hr"])

_EMPLOYMENT_TYPES = ("full_time", "part_time", "contractor", "intern")
_STATUSES         = ("onboarding", "active", "inactive", "offboarded")


class EmployeeIn(BaseModel):
    first_name:      str
    last_name:       Optional[str] = ""
    work_email:      Optional[str] = ""
    personal_email:  Optional[str] = ""
    phone:           Optional[str] = ""
    job_title:       Optional[str] = ""
    department:      Optional[str] = ""
    employment_type: Optional[str] = "full_time"
    start_date:      Optional[str] = ""
    manager_email:   Optional[str] = ""
    status:          Optional[str] = "active"
    location:        Optional[str] = ""
    notes:           Optional[str] = ""


class EmployeeUpdate(BaseModel):
    first_name:      Optional[str] = None
    last_name:       Optional[str] = None
    work_email:      Optional[str] = None
    personal_email:  Optional[str] = None
    phone:           Optional[str] = None
    job_title:       Optional[str] = None
    department:      Optional[str] = None
    employment_type: Optional[str] = None
    start_date:      Optional[str] = None
    manager_email:   Optional[str] = None
    status:          Optional[str] = None
    location:        Optional[str] = None
    notes:           Optional[str] = None


def _validate(employment_type: Optional[str], status: Optional[str]) -> None:
    if employment_type is not None and employment_type not in _EMPLOYMENT_TYPES:
        raise HTTPException(400, f"employment_type must be one of {_EMPLOYMENT_TYPES}")
    if status is not None and status not in _STATUSES:
        raise HTTPException(400, f"status must be one of {_STATUSES}")


def _next_code(db: Session) -> str:
    """GG-001, GG-002, … — next number after the highest existing code."""
    best = 0
    for (code,) in db.query(NexusEmployee.employee_code).all():
        m = re.fullmatch(r"GG-(\d+)", code or "")
        if m:
            best = max(best, int(m.group(1)))
    return f"GG-{best + 1:03d}"


def _serialize(e: NexusEmployee) -> dict:
    return {
        "id": e.id,
        "employeeCode":   e.employee_code,
        "firstName":      e.first_name,
        "lastName":       e.last_name,
        "workEmail":      e.work_email,
        "personalEmail":  e.personal_email,
        "phone":          e.phone,
        "jobTitle":       e.job_title,
        "department":     e.department,
        "employmentType": e.employment_type,
        "startDate":      e.start_date,
        "managerEmail":   e.manager_email,
        "photoUrl":       e.photo_url,
        "status":         e.status,
        "location":       e.location,
        "notes":          e.notes,
        "m365Id":         e.m365_id,
        "asanaId":        e.asana_id,
        "createdAt":      e.created_at,
        "updatedAt":      e.updated_at,
    }


@router.get("/employees")
def list_employees(user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    rows = db.query(NexusEmployee).order_by(NexusEmployee.first_name, NexusEmployee.last_name).all()
    return [_serialize(e) for e in rows]


@router.post("/employees")
def create_employee(body: EmployeeIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    if not body.first_name.strip():
        raise HTTPException(400, "first_name is required")
    _validate(body.employment_type, body.status)
    now = datetime.now(timezone.utc).isoformat()
    row = NexusEmployee(
        id=str(uuid.uuid4()),
        employee_code=_next_code(db),
        first_name=body.first_name.strip(),
        last_name=(body.last_name or "").strip(),
        work_email=(body.work_email or "").strip().lower(),
        personal_email=(body.personal_email or "").strip().lower(),
        phone=(body.phone or "").strip(),
        job_title=(body.job_title or "").strip(),
        department=(body.department or "").strip(),
        employment_type=body.employment_type or "full_time",
        start_date=(body.start_date or "").strip(),
        manager_email=(body.manager_email or "").strip().lower(),
        status=body.status or "active",
        location=(body.location or "").strip(),
        notes=body.notes or "",
        created_by=user["email"],
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _serialize(row)


@router.patch("/employees/{eid}")
def update_employee(eid: str, body: EmployeeUpdate, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    row = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
    if not row:
        raise HTTPException(404, "Employee not found")
    _validate(body.employment_type, body.status)
    if body.first_name is not None and not body.first_name.strip():
        raise HTTPException(400, "first_name cannot be empty")
    fields = body.model_dump(exclude_unset=True)
    for key, value in fields.items():
        if value is None:
            continue
        if key in ("work_email", "personal_email", "manager_email"):
            value = value.strip().lower()
        elif isinstance(value, str) and key != "notes":
            value = value.strip()
        setattr(row, key, value)
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    db.refresh(row)
    return _serialize(row)


@router.delete("/employees/{eid}")
def delete_employee(eid: str, user: dict = Depends(require_hr_delete), db: Session = Depends(get_db)):
    row = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
    if not row:
        return {"ok": True}
    db.delete(row)
    db.commit()
    return {"ok": True}
