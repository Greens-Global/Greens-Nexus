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


# ── Hiring pipeline (Phase 2) ─────────────────────────────────────────────────

from models import HrCandidate, HrStageEvent, HrLeaveRequest, HrLeaveBalance, NexusNotification

_STAGES = ("applied", "screening", "interview", "offer", "hired", "rejected")


class CandidateIn(BaseModel):
    first_name:     str
    last_name:      Optional[str] = ""
    email:          Optional[str] = ""
    phone:          Optional[str] = ""
    role_title:     Optional[str] = ""
    department:     Optional[str] = ""
    expected_start: Optional[str] = ""
    source:         Optional[str] = ""
    notes:          Optional[str] = ""


class CandidateUpdate(BaseModel):
    first_name:     Optional[str] = None
    last_name:      Optional[str] = None
    email:          Optional[str] = None
    phone:          Optional[str] = None
    role_title:     Optional[str] = None
    department:     Optional[str] = None
    expected_start: Optional[str] = None
    source:         Optional[str] = None
    notes:          Optional[str] = None
    stage:          Optional[str] = None
    stage_note:     Optional[str] = None


def _ser_candidate(c: HrCandidate) -> dict:
    return {
        "id": c.id, "firstName": c.first_name, "lastName": c.last_name,
        "email": c.email, "phone": c.phone, "roleTitle": c.role_title,
        "department": c.department, "stage": c.stage,
        "expectedStart": c.expected_start, "source": c.source,
        "resumeUrl": c.resume_url, "notes": c.notes, "employeeId": c.employee_id,
        "createdAt": c.created_at, "updatedAt": c.updated_at,
    }


@router.get("/candidates")
def list_candidates(user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    rows = db.query(HrCandidate).order_by(HrCandidate.created_at.desc()).all()
    return [_ser_candidate(c) for c in rows]


@router.get("/candidates/{cid}/history")
def candidate_history(cid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    rows = (db.query(HrStageEvent).filter(HrStageEvent.candidate_id == cid)
            .order_by(HrStageEvent.created_at).all())
    return [{"fromStage": e.from_stage, "toStage": e.to_stage, "note": e.note,
             "byEmail": e.by_email, "createdAt": e.created_at} for e in rows]


@router.post("/candidates")
def create_candidate(body: CandidateIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    if not body.first_name.strip():
        raise HTTPException(400, "first_name is required")
    now = datetime.now(timezone.utc).isoformat()
    row = HrCandidate(
        id=str(uuid.uuid4()),
        first_name=body.first_name.strip(), last_name=(body.last_name or "").strip(),
        email=(body.email or "").strip().lower(), phone=(body.phone or "").strip(),
        role_title=(body.role_title or "").strip(), department=(body.department or "").strip(),
        expected_start=(body.expected_start or "").strip(), source=(body.source or "").strip(),
        notes=body.notes or "", created_by=user["email"], created_at=now, updated_at=now,
    )
    db.add(row)
    db.add(HrStageEvent(id=str(uuid.uuid4()), candidate_id=row.id, from_stage="",
                        to_stage="applied", note="Candidate added", by_email=user["email"], created_at=now))
    db.commit()
    db.refresh(row)
    return _ser_candidate(row)


@router.patch("/candidates/{cid}")
def update_candidate(cid: str, body: CandidateUpdate, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    row = db.query(HrCandidate).filter(HrCandidate.id == cid).first()
    if not row:
        raise HTTPException(404, "Candidate not found")
    now = datetime.now(timezone.utc).isoformat()
    created_employee = None

    if body.stage is not None and body.stage != row.stage:
        if body.stage not in _STAGES:
            raise HTTPException(400, f"stage must be one of {_STAGES}")
        db.add(HrStageEvent(id=str(uuid.uuid4()), candidate_id=row.id, from_stage=row.stage,
                            to_stage=body.stage, note=(body.stage_note or "").strip(),
                            by_email=user["email"], created_at=now))
        row.stage = body.stage
        # Hired -> the candidate becomes an employee master record (onboarding)
        if body.stage == "hired" and not row.employee_id:
            emp = NexusEmployee(
                id=str(uuid.uuid4()), employee_code=_next_code(db),
                first_name=row.first_name, last_name=row.last_name,
                personal_email=row.email, phone=row.phone,
                job_title=row.role_title, department=row.department,
                start_date=row.expected_start, status="onboarding",
                created_by=user["email"], created_at=now, updated_at=now,
            )
            db.add(emp)
            row.employee_id = emp.id
            created_employee = emp

    for key in ("first_name", "last_name", "email", "phone", "role_title",
                "department", "expected_start", "source", "notes"):
        value = getattr(body, key)
        if value is not None:
            setattr(row, key, value.strip().lower() if key == "email" else (value if key == "notes" else value.strip()))
    row.updated_at = now
    db.commit()
    db.refresh(row)
    out = _ser_candidate(row)
    if created_employee:
        db.refresh(created_employee)
        out["createdEmployee"] = _serialize(created_employee)
    return out


@router.delete("/candidates/{cid}")
def delete_candidate(cid: str, user: dict = Depends(require_hr_delete), db: Session = Depends(get_db)):
    db.query(HrStageEvent).filter(HrStageEvent.candidate_id == cid).delete()
    db.query(HrCandidate).filter(HrCandidate.id == cid).delete()
    db.commit()
    return {"ok": True}


# ── Leave tracker (Phase 6) ───────────────────────────────────────────────────

_LEAVE_TYPES = ("annual", "sick", "unpaid")
_DEFAULT_ALLOCATION = {"annual": 20.0, "sick": 10.0, "unpaid": 0.0}


class LeaveIn(BaseModel):
    employee_id: str
    leave_type:  str
    start_date:  str
    end_date:    Optional[str] = ""
    days:        float
    reason:      Optional[str] = ""


class LeaveDecision(BaseModel):
    action: str                       # approve | reject
    note:   Optional[str] = ""


class BalanceIn(BaseModel):
    employee_id: str
    year:        int
    leave_type:  str
    allocated:   float


def _ser_leave(r: HrLeaveRequest) -> dict:
    return {
        "id": r.id, "employeeId": r.employee_id, "leaveType": r.leave_type,
        "startDate": r.start_date, "endDate": r.end_date, "days": r.days,
        "reason": r.reason, "status": r.status, "decidedBy": r.decided_by,
        "decidedAt": r.decided_at, "decisionNote": r.decision_note,
        "createdAt": r.created_at,
    }


@router.get("/leave")
def list_leave(user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    rows = db.query(HrLeaveRequest).order_by(HrLeaveRequest.created_at.desc()).all()
    return [_ser_leave(r) for r in rows]


@router.get("/leave/balances/{employee_id}")
def leave_balances(employee_id: str, year: int, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    """Allocated comes from balance rows (defaults if absent); used is computed
    from approved requests in that year so the two can never disagree."""
    alloc = dict(_DEFAULT_ALLOCATION)
    for b in db.query(HrLeaveBalance).filter(HrLeaveBalance.employee_id == employee_id,
                                             HrLeaveBalance.year == year).all():
        alloc[b.leave_type] = b.allocated
    used = {t: 0.0 for t in _LEAVE_TYPES}
    for r in db.query(HrLeaveRequest).filter(HrLeaveRequest.employee_id == employee_id,
                                             HrLeaveRequest.status == "approved").all():
        if (r.start_date or "").startswith(str(year)) and r.leave_type in used:
            used[r.leave_type] += r.days or 0
    return [{"leaveType": t, "allocated": alloc.get(t, 0), "used": used[t]} for t in _LEAVE_TYPES]


@router.put("/leave/balances")
def set_balance(body: BalanceIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    if body.leave_type not in _LEAVE_TYPES:
        raise HTTPException(400, f"leave_type must be one of {_LEAVE_TYPES}")
    row = db.query(HrLeaveBalance).filter(HrLeaveBalance.employee_id == body.employee_id,
                                          HrLeaveBalance.year == body.year,
                                          HrLeaveBalance.leave_type == body.leave_type).first()
    if row:
        row.allocated = body.allocated
    else:
        db.add(HrLeaveBalance(id=str(uuid.uuid4()), employee_id=body.employee_id,
                              year=body.year, leave_type=body.leave_type, allocated=body.allocated))
    db.commit()
    return {"ok": True}


@router.post("/leave")
def create_leave(body: LeaveIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    if body.leave_type not in _LEAVE_TYPES:
        raise HTTPException(400, f"leave_type must be one of {_LEAVE_TYPES}")
    if body.days <= 0:
        raise HTTPException(400, "days must be positive")
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == body.employee_id).first()
    if not emp:
        raise HTTPException(404, "Employee not found")
    now = datetime.now(timezone.utc).isoformat()
    row = HrLeaveRequest(
        id=str(uuid.uuid4()), employee_id=body.employee_id, leave_type=body.leave_type,
        start_date=body.start_date, end_date=body.end_date or body.start_date,
        days=body.days, reason=body.reason or "", created_by=user["email"], created_at=now,
    )
    db.add(row)
    db.commit()
    return _ser_leave(row)


@router.patch("/leave/{lid}")
def decide_leave(lid: str, body: LeaveDecision, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    if body.action not in ("approve", "reject"):
        raise HTTPException(400, "action must be approve or reject")
    row = db.query(HrLeaveRequest).filter(HrLeaveRequest.id == lid).with_for_update().first()
    if not row:
        raise HTTPException(404, "Leave request not found")
    if row.status != "pending":
        raise HTTPException(400, "Request already decided")
    now = datetime.now(timezone.utc).isoformat()
    row.status = "approved" if body.action == "approve" else "rejected"
    row.decided_by = user["email"]
    row.decided_at = now
    row.decision_note = (body.note or "").strip()
    # Bell notification to the employee if they have a Nexus identity
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == row.employee_id).first()
    if emp and emp.work_email:
        db.add(NexusNotification(
            id=str(uuid.uuid4()), type="custom_alert", recipient=emp.work_email.lower(),
            title=f"Leave {row.status}",
            body=f"Your {row.leave_type} leave ({row.start_date}, {row.days} day{'s' if row.days != 1 else ''}) was {row.status}."
                 + (f"\n\nNote: {row.decision_note}" if row.decision_note else ""),
            ref_id=row.id, item_name="", requested_by=user["email"],
            action="", actioned=False, read_by="", created_at=now,
        ))
    db.commit()
    return _ser_leave(row)
