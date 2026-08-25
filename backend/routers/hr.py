import json
import re
import time
import uuid
import httpx
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, BackgroundTasks
from sqlalchemy import or_
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from database import get_db
from auth import require_module_grant
from routers.stepup import require_stepup
from models import NexusEmployee, PayrollRate, HrRemovedIdentity

# HR data is the most sensitive in the app. Access is grant-driven (Jun 17): a
# supervisor/manager role no longer auto-opens HR - they need an explicit "hr"
# Access Group grant. Reads need viewer; writes editor; hard deletes owner-grant
# (or Global Admin). IT Admin+ bypass reads/writes; deletes stay owner-only.
require_hr_read   = require_module_grant("hr", "viewer")
require_hr_write  = require_module_grant("hr", "editor")
require_hr_delete = require_module_grant("hr", "owner", bypass_level="owner")
# Compensation + bank are salary-sensitive (Section B): only Global Admins (owner)
# bypass; everyone else needs an explicit "hr_comp" Access Group grant.
require_hr_comp_read  = require_module_grant("hr_comp", "viewer", bypass_level="owner")
require_hr_comp_write = require_module_grant("hr_comp", "editor", bypass_level="owner")

router = APIRouter(prefix="/hr", tags=["hr"])

_EMPLOYMENT_TYPES = ("full_time", "part_time", "contractor", "intern")
# 'staged' = an external/guest created for testing, not yet released (Neil,
# Aug 25) - set/cleared only by the external-users staging flow, accepted here
# so HR edits to a staged person's profile don't bounce on validation.
_STATUSES         = ("onboarding", "active", "inactive", "offboarded", "staged")
_IDENTITY_TYPES   = ("internal", "guest", "external")


class EmployeeIn(BaseModel):
    first_name:      str
    last_name:       Optional[str] = ""
    work_email:      Optional[str] = ""
    personal_email:  Optional[str] = ""
    phone:           Optional[str] = ""
    job_title:       Optional[str] = ""
    designation:     Optional[str] = ""
    department:      Optional[str] = ""
    employment_type: Optional[str] = "full_time"
    start_date:      Optional[str] = ""
    manager_email:   Optional[str] = ""
    status:          Optional[str] = "active"
    location:        Optional[str] = ""
    company:         Optional[str] = ""
    identity_type:   Optional[str] = "internal"
    contractor:      Optional[dict] = None
    personal:        Optional[dict] = None
    compliance:      Optional[dict] = None
    notes:           Optional[str] = ""


class EmployeeUpdate(BaseModel):
    first_name:      Optional[str] = None
    last_name:       Optional[str] = None
    work_email:      Optional[str] = None
    personal_email:  Optional[str] = None
    phone:           Optional[str] = None
    job_title:       Optional[str] = None
    designation:     Optional[str] = None
    department:      Optional[str] = None
    employment_type: Optional[str] = None
    start_date:      Optional[str] = None
    manager_email:   Optional[str] = None
    status:          Optional[str] = None
    location:        Optional[str] = None
    company:         Optional[str] = None
    division:        Optional[str] = None
    identity_type:   Optional[str] = None
    contractor:      Optional[dict] = None
    personal:        Optional[dict] = None
    compliance:      Optional[dict] = None
    notes:           Optional[str] = None


def _validate(employment_type: Optional[str], status: Optional[str], identity_type: Optional[str] = None) -> None:
    if employment_type is not None and employment_type not in _EMPLOYMENT_TYPES:
        raise HTTPException(400, f"employment_type must be one of {_EMPLOYMENT_TYPES}")
    if status is not None and status not in _STATUSES:
        raise HTTPException(400, f"status must be one of {_STATUSES}")
    if identity_type is not None and identity_type not in _IDENTITY_TYPES:
        raise HTTPException(400, f"identity_type must be one of {_IDENTITY_TYPES}")


def _next_code(db: Session) -> str:
    """GG-001, GG-002, … - next number after the highest existing code."""
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
        "designation":    e.designation or "",
        "department":     e.department,
        "employmentType": e.employment_type,
        "startDate":      e.start_date,
        "managerEmail":   e.manager_email,
        "photoUrl":       e.photo_url,
        "status":         e.status,
        "location":       e.location,
        "company":        e.company,
        "division":       e.division or "",
        "identityType":   e.identity_type or "internal",
        "contractor":     e.contractor or {},
        "personal":       e.personal or {},
        "compliance":     e.compliance or {},
        "statusLog":      e.status_log or [],
        "notes":          e.notes,
        "m365Id":         e.m365_id,
        "asanaId":        e.asana_id,
        "createdAt":      e.created_at,
        "updatedAt":      e.updated_at,
        "deletedAt":      e.deleted_at or "",
        "deletedBy":      e.deleted_by or "",
    }


@router.get("/employees")
def list_employees(deleted: bool = False, user: dict = Depends(require_hr_read),
                   db: Session = Depends(get_db)):
    """`deleted=true` returns the removed people INSTEAD of the live ones - the
    Deleted filter in the directory. Live listings need no filtering of their
    own: the session hides removed rows globally (database.py)."""
    q = db.query(NexusEmployee)
    if deleted:
        q = (q.execution_options(include_deleted=True)
              .filter(NexusEmployee.deleted_at != "", NexusEmployee.deleted_at.isnot(None)))
    rows = q.order_by(NexusEmployee.first_name, NexusEmployee.last_name).all()
    return [_serialize(e) for e in rows]


@router.post("/employees")
def create_employee(body: EmployeeIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    if not body.first_name.strip():
        raise HTTPException(400, "first_name is required")
    _validate(body.employment_type, body.status, body.identity_type)
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
        designation=(body.designation or "").strip(),
        department=(body.department or "").strip(),
        employment_type=body.employment_type or "full_time",
        start_date=(body.start_date or "").strip(),
        manager_email=(body.manager_email or "").strip().lower(),
        status=body.status or "active",
        location=(body.location or "").strip(),
        company=(body.company or "").strip(),
        identity_type=body.identity_type or "internal",
        contractor=body.contractor or {},
        personal=body.personal or {},
        compliance=body.compliance or {},
        notes=body.notes or "",
        created_by=user["email"],
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    # If this person was previously removed from Nexus, clear the tombstone so a
    # deliberate re-add is honored and future M365 syncs treat them normally.
    _wemail = (body.work_email or "").strip().lower()
    if _wemail:
        db.query(HrRemovedIdentity).filter(HrRemovedIdentity.work_email == _wemail).delete()
    db.commit()
    db.refresh(row)
    return _serialize(row)


@router.patch("/employees/{eid}")
def update_employee(eid: str, body: EmployeeUpdate, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    row = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
    if not row:
        raise HTTPException(404, "Employee not found")
    _validate(body.employment_type, body.status, body.identity_type)
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
    out = _serialize(row)
    # Nexus is the source of truth for profile edits - mirror them onto the
    # linked Entra account automatically (best-effort: a Graph hiccup must never
    # fail the save; the response says whether Entra took the change).
    if row.m365_id and (set(fields) & ENTRA_MAPPED_FIELDS):
        try:
            token = _graph_token()
            written = _graph_writeback(token, row, db)
            manager = _graph_set_manager(token, row) if "manager_email" in fields else None
            out["entra"] = {"synced": True, "written": written, "manager": manager}
        except Exception as e:
            out["entra"] = {"synced": False, "error": str(e)[:200]}
    return out


@router.delete("/employees/{eid}")
def delete_employee(eid: str, user: dict = Depends(require_hr_delete), db: Session = Depends(get_db)):
    """Remove from Nexus - REVERSIBLE.

    This used to DROP the row, which took pay, compliance, personal details and
    the entire status history with it: "remove" and "destroy every record we
    hold about this person" were the same button, and a misclick was
    unrecoverable. The row is now marked instead, disappears from every screen
    (the session hides it globally - database.py), and comes back intact through
    /employees/{eid}/restore.

    Still Nexus-only: NO Graph call, the Microsoft 365 account is untouched.
    """
    row = (db.query(NexusEmployee).execution_options(include_deleted=True)
             .filter(NexusEmployee.id == eid).first())
    if not row:
        return {"ok": True}
    if row.deleted_at:
        return {"ok": True, "alreadyRemoved": True}

    now = datetime.now(timezone.utc).isoformat()
    # Tombstone the identity so the M365 sync won't re-create this person from
    # Entra while they are removed. Restore deletes it again.
    if row.work_email or row.m365_id:
        db.add(HrRemovedIdentity(
            id=str(uuid.uuid4()),
            work_email=(row.work_email or "").lower(),
            m365_id=row.m365_id or "",
            removed_by=user["email"],
            removed_at=now,
        ))
    row.deleted_at = now
    row.deleted_by = user["email"]
    row.updated_at = now
    db.commit()
    return {"ok": True}


@router.post("/employees/{eid}/restore")
def restore_employee(eid: str, user: dict = Depends(require_hr_delete), db: Session = Depends(get_db)):
    """Put a removed person back, exactly as they were.

    Clearing the tombstone matters as much as clearing the mark: leaving it
    would let the M365 sync keep treating this person as deliberately removed
    and skip them forever, so they would be back in the directory but silently
    frozen out of every future Entra refresh.
    """
    row = (db.query(NexusEmployee).execution_options(include_deleted=True)
             .filter(NexusEmployee.id == eid).first())
    if not row:
        raise HTTPException(404, "That person no longer exists in Nexus")
    if not row.deleted_at:
        return {"ok": True, **_serialize(row)}

    q = db.query(HrRemovedIdentity)
    conds = []
    if row.work_email:
        conds.append(HrRemovedIdentity.work_email == row.work_email.lower())
    if row.m365_id:
        conds.append(HrRemovedIdentity.m365_id == row.m365_id)
    if conds:
        q.filter(or_(*conds)).delete(synchronize_session=False)

    row.deleted_at = ""
    row.deleted_by = ""
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    db.refresh(row)
    return {"ok": True, **_serialize(row)}


# ── Hiring pipeline (Phase 2) ─────────────────────────────────────────────────

from models import HrCandidate, HrStageEvent, HrLeaveRequest, HrLeaveBalance, NexusNotification

_STAGES = ("applied", "screening", "interview", "offer", "hired", "rejected")


def _hr_notify(db: Session, recipient: str, title: str, body: str, ref_id: str = "", requested_by: str = "",
               action: Optional[dict] = None) -> None:
    """Server-side bell notification (items.py pattern). Empty recipient = noop -
    HR events must always target a person, never broadcast to all managers.
    `action` = {"view": ..., "sub": ...} makes the bell/toast click navigate there."""
    if not (recipient or "").strip():
        return
    db.add(NexusNotification(
        id=str(uuid.uuid4()), type="custom_alert", recipient=recipient.strip().lower(),
        title=title, body=body, ref_id=ref_id, item_name="", requested_by=requested_by,
        action=json.dumps(action) if action else "", actioned=False, read_by="",
        created_at=datetime.now(timezone.utc).isoformat(),
    ))


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
    interview_at:   Optional[str] = None   # ISO datetime; '' clears


def _ser_candidate(c: HrCandidate) -> dict:
    return {
        "id": c.id, "firstName": c.first_name, "lastName": c.last_name,
        "email": c.email, "phone": c.phone, "roleTitle": c.role_title,
        "department": c.department, "stage": c.stage,
        "expectedStart": c.expected_start, "source": c.source,
        "interviewAt": c.interview_at or "",
        "resumeUrl": c.resume_url, "notes": c.notes, "employeeId": c.employee_id,
        "createdAt": c.created_at, "updatedAt": c.updated_at,
    }


@router.get("/candidates")
def list_candidates(user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    rows = db.query(HrCandidate).order_by(HrCandidate.created_at.desc()).all()
    # Best calibrated interview score per candidate (chip on the kanban card)
    from models import HrInterview
    best: dict = {}
    for iv in db.query(HrInterview).filter(HrInterview.status == "scored").all():
        if (iv.total_score or 0) >= best.get(iv.candidate_id, -1):
            best[iv.candidate_id] = iv.total_score or 0
    out = []
    for c in rows:
        d = _ser_candidate(c)
        d["interviewScore"] = round(best[c.id]) if c.id in best else None
        out.append(d)
    return out


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

        # One notification per stage move, to the candidate's owner (unless
        # they made the move themselves) - mirrors the items.py convention
        if row.created_by and row.created_by.lower() != user["email"].lower():
            cand_name = f"{row.first_name} {row.last_name}".strip()
            _hr_notify(db, row.created_by,
                       f"Candidate {('hired' if body.stage == 'hired' else ('rejected' if body.stage == 'rejected' else 'moved'))}: {cand_name}",
                       f"{cand_name} ({row.role_title or row.department or 'candidate'}) is now in {body.stage.replace('_', ' ')}."
                       + (f"\nNote: {body.stage_note.strip()}" if (body.stage_note or '').strip() else ''),
                       ref_id=row.id, requested_by=user["email"],
                       action={"view": "hr", "sub": "hr-hiring"})

    # Interview scheduling: record + notify the candidate owner (the daily
    # reminder job pings again on the day itself).
    if body.interview_at is not None and body.interview_at != (row.interview_at or ""):
        row.interview_at = body.interview_at.strip()
        if row.interview_at and row.created_by:
            cand_name = f"{row.first_name} {row.last_name}".strip()
            try:
                pretty = datetime.fromisoformat(row.interview_at).strftime("%a, %b %d at %H:%M")
            except ValueError:
                pretty = row.interview_at
            _hr_notify(db, row.created_by, f"Interview scheduled - {cand_name}",
                       f"{cand_name} ({row.role_title or 'candidate'}) is booked for {pretty}.",
                       ref_id=row.id, requested_by=user["email"],
                       action={"view": "hr", "sub": "hr-hiring"})

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


@router.post("/candidates/{cid}/resume")
async def upload_resume(cid: str, file: UploadFile = File(...),
                        user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Resume / any candidate doc - private hr-docs bucket, path on the record."""
    row = db.query(HrCandidate).filter(HrCandidate.id == cid).first()
    if not row:
        raise HTTPException(404, "Candidate not found")
    data = await file.read()
    if len(data) > _MAX_DOC_BYTES:
        raise HTTPException(400, "File too large (max 15 MB)")
    safe = re.sub(r"[^a-zA-Z0-9._-]", "_", file.filename or "resume.pdf")
    path = f"candidates/{cid}/{uuid.uuid4()}-{safe}"
    resp = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/{_DOC_BUCKET}/{path}",
                      headers={**_storage_headers(), "Content-Type": file.content_type or "application/octet-stream"},
                      content=data, timeout=60)
    if not resp.is_success:
        raise HTTPException(502, f"Storage upload failed: {resp.text[:200]}")
    row.resume_url = path
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    return _ser_candidate(row)


@router.get("/candidates/{cid}/resume-url")
def candidate_resume_url(cid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    row = db.query(HrCandidate).filter(HrCandidate.id == cid).first()
    if not row or not row.resume_url:
        raise HTTPException(404, "No resume on file")
    # Legacy rows may hold a full external URL rather than a storage path.
    if row.resume_url.startswith("http"):
        return {"url": row.resume_url, "expiresIn": 0}
    resp = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/sign/{_DOC_BUCKET}/{row.resume_url}",
                      headers=_storage_headers(), json={"expiresIn": 300}, timeout=15)
    if not resp.is_success:
        raise HTTPException(502, "Could not sign URL")
    return {"url": f"{_SUPABASE_URL}/storage/v1{resp.json()['signedURL']}", "expiresIn": 300}


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
    # New request -> the employee's manager gets the approval ask in their bell
    # (unless the manager is the one recording it)
    emp_name = f"{emp.first_name} {emp.last_name}".strip()
    if emp.manager_email and emp.manager_email.lower() != user["email"].lower():
        _hr_notify(db, emp.manager_email,
                   f"Leave request: {emp_name}",
                   f"{emp_name} requested {body.days} day{'s' if body.days != 1 else ''} of {body.leave_type} leave"
                   f" starting {body.start_date}." + (f"\nReason: {body.reason.strip()}" if (body.reason or '').strip() else ''),
                   ref_id=row.id, requested_by=user["email"])
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


# ── Employee documents (Phase 3) - PRIVATE bucket, signed URLs only ──────────

import os
import secrets
from fastapi import UploadFile, File
from models import HrDocument, HrProvisionRun, HrProvisionStep

_SUPABASE_URL         = os.getenv("SUPABASE_URL", "")
_SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
_DOC_BUCKET    = "hr-docs"
# Work-monitoring screenshots live in their OWN private bucket, not with HR
# paperwork - different data class, retention, access, egress, and blast radius.
_SHOT_BUCKET   = "time-monitoring"
_DOC_KINDS     = ("resume", "id", "contract", "certificate", "other")
_MAX_DOC_BYTES = 15 * 1024 * 1024


def _storage_headers():
    if not (_SUPABASE_URL and _SUPABASE_SERVICE_KEY):
        raise HTTPException(503, "Storage not configured - set SUPABASE_URL and SUPABASE_SERVICE_KEY")
    return {"Authorization": f"Bearer {_SUPABASE_SERVICE_KEY}", "apikey": _SUPABASE_SERVICE_KEY}


def _ser_doc(d: HrDocument) -> dict:
    return {"id": d.id, "employeeId": d.employee_id, "kind": d.kind, "fileName": d.file_name,
            "sizeBytes": d.size_bytes, "expiresOn": d.expires_on, "uploadedBy": d.uploaded_by,
            "createdAt": d.created_at}


def _has_comp(user: dict, db: Session) -> bool:
    """Inline hr_comp check (paystubs are salary documents). Mirrors
    require_hr_comp_read: Global Admin bypass OR an explicit hr_comp grant."""
    from auth import _module_level, _LEVELS
    return user["level"] >= _LEVELS["owner"] or _module_level(user["email"], "hr_comp", db) >= 1


@router.get("/employees/{eid}/documents")
def list_documents(eid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    rows = (db.query(HrDocument).filter(HrDocument.employee_id == eid)
            .order_by(HrDocument.created_at.desc()).all())
    # Paystubs are comp-restricted - hidden from plain hr viewers/editors.
    if not _has_comp(user, db):
        rows = [d for d in rows if d.kind != "paystub"]
    return [_ser_doc(d) for d in rows]


@router.post("/employees/{eid}/documents")
async def upload_document(eid: str, file: UploadFile = File(...), kind: str = Form("other"),
                           expires_on: str = Form(""),
                           user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
    if not emp:
        raise HTTPException(404, "Employee not found")
    if kind not in _DOC_KINDS:
        raise HTTPException(400, f"kind must be one of {_DOC_KINDS}")
    data = await file.read()
    if len(data) > _MAX_DOC_BYTES:
        raise HTTPException(400, "File too large (max 15 MB)")
    safe_name = re.sub(r"[^a-zA-Z0-9._-]", "_", file.filename or "document")
    path = f"{eid}/{uuid.uuid4()}-{safe_name}"
    resp = httpx.post(
        f"{_SUPABASE_URL}/storage/v1/object/{_DOC_BUCKET}/{path}",
        headers={**_storage_headers(), "Content-Type": file.content_type or "application/octet-stream"},
        content=data, timeout=60,
    )
    if not resp.is_success:
        raise HTTPException(502, f"Storage upload failed: {resp.text[:200]}")
    row = HrDocument(id=str(uuid.uuid4()), employee_id=eid, kind=kind,
                     file_name=file.filename or safe_name, storage_path=path,
                     size_bytes=len(data), expires_on=expires_on.strip(),
                     uploaded_by=user["email"], created_at=datetime.now(timezone.utc).isoformat())
    db.add(row)
    db.commit()
    return _ser_doc(row)


@router.get("/documents/{did}/url")
def document_url(did: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    """Mint a short-lived signed URL - the bucket itself is private."""
    row = db.query(HrDocument).filter(HrDocument.id == did).first()
    if not row:
        raise HTTPException(404, "Document not found")
    if row.kind == "paystub" and not _has_comp(user, db):
        raise HTTPException(403, "Paystubs require the compensation grant")
    resp = httpx.post(
        f"{_SUPABASE_URL}/storage/v1/object/sign/{_DOC_BUCKET}/{row.storage_path}",
        headers=_storage_headers(), json={"expiresIn": 300}, timeout=15,
    )
    if not resp.is_success:
        raise HTTPException(502, f"Could not sign URL: {resp.text[:200]}")
    return {"url": f"{_SUPABASE_URL}/storage/v1{resp.json()['signedURL']}", "expiresIn": 300}


@router.delete("/documents/{did}")
def delete_document(did: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    row = db.query(HrDocument).filter(HrDocument.id == did).first()
    if not row:
        return {"ok": True}
    if row.kind == "paystub" and not _has_comp(user, db):
        raise HTTPException(403, "Paystubs require the compensation grant")
    httpx.request("DELETE", f"{_SUPABASE_URL}/storage/v1/object/{_DOC_BUCKET}/{row.storage_path}",
                  headers=_storage_headers(), timeout=30)
    db.delete(row)
    db.commit()
    return {"ok": True}


# ── Paystubs - HrDocument rows with kind="paystub", hr_comp-gated ────────────
# Employees see/download their own via /myhr/paystubs (routers/myhr.py).

@router.get("/employees/{eid}/paystubs")
def list_paystubs(eid: str, user: dict = Depends(require_hr_comp_read),
                  _su: dict = Depends(require_stepup), db: Session = Depends(get_db)):
    rows = (db.query(HrDocument)
            .filter(HrDocument.employee_id == eid, HrDocument.kind == "paystub")
            .order_by(HrDocument.created_at.desc()).all())
    return [_ser_doc(d) for d in rows]


@router.post("/employees/{eid}/paystubs")
async def upload_paystub(eid: str, file: UploadFile = File(...), period: str = Form(""),
                         user: dict = Depends(require_hr_comp_write), db: Session = Depends(get_db)):
    """One paystub PDF per pay period; `period` becomes the display name
    (e.g. "Jun 16 – Jun 30, 2026")."""
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
    if not emp:
        raise HTTPException(404, "Employee not found")
    data = await file.read()
    if len(data) > _MAX_DOC_BYTES:
        raise HTTPException(400, "File too large (max 15 MB)")
    safe_name = re.sub(r"[^a-zA-Z0-9._-]", "_", file.filename or "paystub.pdf")
    path = f"paystubs/{eid}/{uuid.uuid4()}-{safe_name}"
    resp = httpx.post(
        f"{_SUPABASE_URL}/storage/v1/object/{_DOC_BUCKET}/{path}",
        headers={**_storage_headers(), "Content-Type": file.content_type or "application/pdf"},
        content=data, timeout=60,
    )
    if not resp.is_success:
        raise HTTPException(502, f"Storage upload failed: {resp.text[:200]}")
    display = f"Paystub - {period.strip()}" if period.strip() else (file.filename or "Paystub")
    row = HrDocument(id=str(uuid.uuid4()), employee_id=eid, kind="paystub",
                     file_name=display[:200], storage_path=path,
                     size_bytes=len(data), expires_on="",
                     uploaded_by=user["email"], created_at=datetime.now(timezone.utc).isoformat())
    db.add(row)
    db.commit()
    return _ser_doc(row)


# ── Employee requests ("Ask HR" on My HR) - list + resolve ───────────────────
from models import HrSelfRequest


@router.get("/requests")
def list_self_requests(status: str = "", user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    q = db.query(HrSelfRequest)
    if status:
        q = q.filter(HrSelfRequest.status == status)
    rows = q.order_by(HrSelfRequest.created_at.desc()).limit(200).all()
    return [{"id": r.id, "email": r.employee_email, "name": r.employee_name,
             "type": r.type, "message": r.message, "status": r.status,
             "attachmentName": r.attachment_name or "",
             "response": r.response or "", "resolvedBy": r.resolved_by or "",
             "resolvedAt": r.resolved_at or "", "createdAt": r.created_at} for r in rows]


@router.get("/requests/{rid}/attachment-url")
def self_request_attachment_url(rid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    r = db.query(HrSelfRequest).filter(HrSelfRequest.id == rid).first()
    if not r or not r.attachment_path:
        raise HTTPException(404, "No attachment")
    resp = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/sign/{_DOC_BUCKET}/{r.attachment_path}",
                      headers=_storage_headers(), json={"expiresIn": 300}, timeout=15)
    if not resp.is_success:
        raise HTTPException(502, "Could not sign URL")
    return {"url": f"{_SUPABASE_URL}/storage/v1{resp.json()['signedURL']}", "expiresIn": 300}


class AttachToEmployeeIn(BaseModel):
    kind: str = "other"


@router.post("/requests/{rid}/attach-to-employee")
def attach_request_to_employee(rid: str, body: AttachToEmployeeIn,
                               user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """One click: copy the employee's attached file into their official HR
    document set (storage copy + HrDocument row) - nothing to re-upload."""
    r = db.query(HrSelfRequest).filter(HrSelfRequest.id == rid).first()
    if not r or not r.attachment_path:
        raise HTTPException(404, "No attachment on this request")
    emp = (db.query(NexusEmployee)
           .filter(func.lower(NexusEmployee.work_email) == r.employee_email.lower()).first())
    if not emp:
        raise HTTPException(404, "No employee record for this request")
    kind = body.kind if body.kind in _DOC_KINDS else "other"
    fname = r.attachment_name or "document"
    dest = f"{emp.id}/{uuid.uuid4()}-{re.sub(r'[^a-zA-Z0-9._-]', '_', fname)}"
    resp = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/copy",
                      headers={**_storage_headers(), "Content-Type": "application/json"},
                      json={"bucketId": _DOC_BUCKET, "sourceKey": r.attachment_path,
                            "destinationKey": dest}, timeout=30)
    if not resp.is_success:
        raise HTTPException(502, f"Storage copy failed: {resp.text[:200]}")
    row = HrDocument(id=str(uuid.uuid4()), employee_id=emp.id, kind=kind,
                     file_name=fname, storage_path=dest, size_bytes=0, expires_on="",
                     uploaded_by=user["email"], created_at=datetime.now(timezone.utc).isoformat())
    db.add(row)
    db.commit()
    return _ser_doc(row)


class ResolveRequestIn(BaseModel):
    response: str = ""


@router.patch("/requests/{rid}")
def resolve_self_request(rid: str, body: ResolveRequestIn,
                         user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    r = db.query(HrSelfRequest).filter(HrSelfRequest.id == rid).first()
    if not r:
        raise HTTPException(404, "Request not found")
    r.status = "resolved"
    r.response = (body.response or "").strip()[:2000]
    r.resolved_by = user["email"]
    r.resolved_at = datetime.now(timezone.utc).isoformat()
    # Tell the employee (server-side notification; shows on their bell + My HR).
    db.add(NexusNotification(
        id=str(uuid.uuid4()), type="hr_request_resolved", recipient=r.employee_email,
        title="HR resolved your request",
        body=(r.response or "Your request to HR has been handled.")[:300],
        ref_id=r.id, action="", actioned=False, read_by="",
        created_at=datetime.now(timezone.utc).isoformat()))
    db.commit()
    return {"ok": True}


# ── Provisioning engine (Phase 4): one click -> M365 account ─────────────────

_AZ_TENANT = os.getenv("AZURE_TENANT_ID", "")
_AZ_CLIENT = os.getenv("AZURE_CLIENT_ID", "")
_AZ_SECRET = os.getenv("AZURE_CLIENT_SECRET", "")
_GRAPH = "https://graph.microsoft.com/v1.0"


def _graph_token() -> str:
    if not all([_AZ_TENANT, _AZ_CLIENT, _AZ_SECRET]):
        raise HTTPException(503, "Provisioning not configured - set AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET")
    resp = httpx.post(
        f"https://login.microsoftonline.com/{_AZ_TENANT}/oauth2/v2.0/token",
        data={"grant_type": "client_credentials", "client_id": _AZ_CLIENT,
              "client_secret": _AZ_SECRET, "scope": "https://graph.microsoft.com/.default"},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


# Human labels Entra admins expect in the freeform employeeType attribute
_EMPLOYEE_TYPE_LABEL = {"full_time": "Full-time", "part_time": "Part-time",
                        "contractor": "Contractor", "intern": "Intern"}

# Nexus employee fields whose edit means the linked Entra user is now stale
ENTRA_MAPPED_FIELDS = {"first_name", "last_name", "job_title", "department", "phone",
                       "location", "employee_code", "employment_type", "start_date",
                       "company", "personal", "manager_email"}


def _m365_job_title(title: str) -> str:
    """Level markers stay in Nexus, never in Entra. Nexus job titles carry a
    trailing level ('Site Manager I', 'IT Development Associate 1') that maps
    pay/roles internally - but pushed to M365 verbatim, each variant reads as a
    DIFFERENT job title and splits one role into fake hierarchy tiers in org
    views. Strip a trailing arabic or roman marker (separator required, so
    'MIX' or 'Level 2 Technician' are untouched; roman is uppercase-only).
    A title that IS only a marker is sent as-is rather than blanked."""
    t = " ".join((title or "").split())
    out = re.sub(r"[\s\-#]+(?:\d{1,3}|[IVX]{1,4})$", "", t).strip(" -")
    return out or t


def _graph_writeback(token: str, emp, db: Optional[Session] = None) -> list:
    """Push the editable profile attributes from Nexus back onto the linked Entra
    user (the reverse of Sync-from-M365). Only sends fields that have a value, so
    an empty Nexus field never wipes an existing Entra one. Returns the attribute
    names written. Needs User.ReadWrite.All (already consented for provisioning)."""
    first = (emp.first_name or "").strip()
    last  = (emp.last_name or "").strip()
    # Same rule as every other attribute below: only send names that have a
    # value, so a blank Nexus first/last never WIPES the existing Entra name.
    payload = {}
    if first:
        payload["givenName"] = first
    if last:
        payload["surname"] = last
    if first or last:
        payload["displayName"] = f"{first} {last}".strip()
    company_name = ""
    if db is not None and (emp.company or "").strip():
        from models import HrEntity
        ent = db.query(HrEntity).filter(HrEntity.id == emp.company).first()
        company_name = (ent.name if ent else "") or ""
    street = " ".join(str((emp.personal or {}).get("currentAddress", "")).split())[:1024]
    for attr, value in (("jobTitle", _m365_job_title(emp.job_title)), ("department", emp.department),
                        ("mobilePhone", emp.phone), ("officeLocation", emp.location),
                        ("employeeId", emp.employee_code),
                        ("employeeType", _EMPLOYEE_TYPE_LABEL.get(emp.employment_type or "", "")),
                        ("companyName", company_name),
                        ("streetAddress", street)):
        v = (value or "").strip()
        if v:
            payload[attr] = v
    # Graph wants a full DateTimeOffset for hire date, not a bare ISO date
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", (emp.start_date or "").strip()):
        payload["employeeHireDate"] = f"{emp.start_date.strip()}T00:00:00Z"
    resp = httpx.patch(f"{_GRAPH}/users/{emp.m365_id}",
                       headers={"Authorization": f"Bearer {token}"},
                       json=payload, timeout=20)
    if not resp.is_success:
        raise RuntimeError(f"Entra write-back failed: {resp.text[:200]}")
    return list(payload.keys())


def _graph_set_manager(token: str, emp) -> Optional[bool]:
    """Point the Entra manager edge at emp.manager_email. Best-effort: None = no
    manager set on the profile, True/False = the $ref write's result."""
    if not (emp.manager_email or "").strip():
        return None
    try:
        mgr = httpx.get(f"{_GRAPH}/users/{emp.manager_email}",
                        headers={"Authorization": f"Bearer {token}"}, timeout=20)
        mid = mgr.json().get("id") if mgr.is_success else None
        if not mid:
            return False
        ref = httpx.put(f"{_GRAPH}/users/{emp.m365_id}/manager/$ref",
                        headers={"Authorization": f"Bearer {token}"},
                        json={"@odata.id": f"{_GRAPH}/users/{mid}"}, timeout=20)
        return ref.is_success
    except Exception:
        return False


# Graph only returns internal SKU part numbers - map the ones in our tenant to
# the names the M365 admin center shows (Microsoft's product-identifier list)
_SKU_NAMES = {
    "O365_BUSINESS_ESSENTIALS":   "Microsoft 365 Business Basic",
    "O365_BUSINESS_PREMIUM":      "Microsoft 365 Business Standard",
    "SPB":                        "Microsoft 365 Business Premium",
    "EXCHANGESTANDARD":           "Exchange Online (Plan 1)",
    "EXCHANGEENTERPRISE":         "Exchange Online (Plan 2)",
    "POWER_BI_PRO":               "Power BI Pro",
    "POWER_BI_STANDARD":          "Power BI (free)",
    "FLOW_FREE":                  "Power Automate Free",
    "POWERAPPS_DEV":              "Power Apps for Developer",
    "Microsoft_Teams_Rooms_Basic": "Microsoft Teams Rooms Basic",
    "CCIBOTS_PRIVPREV_VIRAL":     "Copilot Studio Viral Trial",
    "ENTERPRISEPACK":             "Office 365 E3",
    "SPE_E3":                     "Microsoft 365 E3",
    "SPE_E5":                     "Microsoft 365 E5",
    "Microsoft_Fabric_(Free)":    "Microsoft Fabric (Free)",
}
# The license every new employee gets by default (Visesh, Jun 13)
_DEFAULT_SKU_PART = "O365_BUSINESS_ESSENTIALS"


@router.get("/provision/skus")
def list_skus(user: dict = Depends(require_hr_write)):
    token = _graph_token()
    resp = httpx.get(f"{_GRAPH}/subscribedSkus", headers={"Authorization": f"Bearer {token}"}, timeout=20)
    if not resp.is_success:
        raise HTTPException(502, f"Graph error: {resp.text[:200]}")
    out = []
    for s in resp.json().get("value", []):
        total = s.get("prepaidUnits", {}).get("enabled", 0)
        used  = s.get("consumedUnits", 0)
        part  = s.get("skuPartNumber") or ""
        out.append({"skuId": s.get("skuId"), "skuPartNumber": part,
                    "displayName": _SKU_NAMES.get(part, part.replace("_", " ").title()),
                    "isDefault": part == _DEFAULT_SKU_PART,
                    "available": max(0, total - used), "total": total})
    # Default first, then named products, then the rest - all alphabetical
    out.sort(key=lambda s: (not s["isDefault"], s["skuPartNumber"] not in _SKU_NAMES, s["displayName"].lower()))
    return out


from typing import List


class ProvisionIn(BaseModel):
    work_email:      str
    license_sku_id:  Optional[str] = ""          # legacy single-select
    license_sku_ids: Optional[List[str]] = None  # multi-select (admin-center style)
    usage_location:  Optional[str] = "US"        # ISO 3166 alpha-2 - license compliance keys off this


@router.post("/employees/{eid}/provision")
def provision_employee(eid: str, body: ProvisionIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
    if not emp:
        raise HTTPException(404, "Employee not found")
    if emp.m365_id:
        raise HTTPException(400, "Employee already has an M365 account - provisioning is one-time")
    upn = body.work_email.strip().lower()
    if not re.fullmatch(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}", upn):
        raise HTTPException(400, "work_email must be a valid address in your tenant domain")
    usage_location = (body.usage_location or "US").strip().upper()
    if not re.fullmatch(r"[A-Z]{2}", usage_location):
        raise HTTPException(400, "usage_location must be a 2-letter country code")

    now = datetime.now(timezone.utc).isoformat()
    run = HrProvisionRun(id=str(uuid.uuid4()), employee_id=eid, status="running",
                         started_by=user["email"], started_at=now)
    db.add(run)
    steps = {}
    for i, name in enumerate(["m365_user", "m365_license", "m365_manager", "asana", "ignite", "welcome_email"]):
        s = HrProvisionStep(id=str(uuid.uuid4()), run_id=run.id, step=name, status="pending", ordinal=i)
        db.add(s)
        steps[name] = s
    db.commit()

    temp_password = "Gn-" + secrets.token_urlsafe(9)
    token = None
    user_id = None
    failed = False

    # 1) Create the account
    try:
        token = _graph_token()
        resp = httpx.post(f"{_GRAPH}/users", headers={"Authorization": f"Bearer {token}"}, json={
            "accountEnabled": True,
            "displayName": f"{emp.first_name} {emp.last_name}".strip(),
            "givenName": emp.first_name, "surname": emp.last_name or "",
            "mailNickname": upn.split("@", 1)[0].replace(".", ""),
            "userPrincipalName": upn,
            "usageLocation": usage_location,
            "jobTitle": _m365_job_title(emp.job_title) or None,
            "department": emp.department or None,
            "mobilePhone": emp.phone or None,
            "officeLocation": emp.location or None,
            "passwordProfile": {"password": temp_password, "forceChangePasswordNextSignIn": True},
        }, timeout=30)
        if resp.is_success:
            user_id = resp.json()["id"]
            emp.m365_id = user_id
            emp.work_email = upn
            steps["m365_user"].status = "ok"
            steps["m365_user"].detail = f"Account {upn} created"
        else:
            raise RuntimeError(resp.text[:300])
    except Exception as e:
        steps["m365_user"].status = "failed"
        steps["m365_user"].detail = str(e)[:400]
        failed = True

    # 2) Licenses - one assignLicense call for the whole set (a mailbox-bearing
    #    SKU like Business Basic is what creates the Outlook mailbox)
    sku_ids = [s for s in (body.license_sku_ids or []) if s] or ([body.license_sku_id] if body.license_sku_id else [])
    if user_id and sku_ids:
        try:
            resp = httpx.post(f"{_GRAPH}/users/{user_id}/assignLicense",
                              headers={"Authorization": f"Bearer {token}"},
                              json={"addLicenses": [{"skuId": s, "disabledPlans": []} for s in sku_ids],
                                    "removeLicenses": []}, timeout=30)
            if resp.is_success:
                steps["m365_license"].status = "ok"
                steps["m365_license"].detail = f"{len(sku_ids)} license{'s' if len(sku_ids) != 1 else ''} assigned - mailbox provisioning"
            else:
                raise RuntimeError(resp.text[:300])
        except Exception as e:
            steps["m365_license"].status = "failed"
            steps["m365_license"].detail = str(e)[:400]
    else:
        steps["m365_license"].status = "skipped"
        steps["m365_license"].detail = "" if user_id else "user creation failed"

    # 3) Reporting line into Entra -> Teams/Outlook org charts match Nexus
    if user_id and emp.manager_email:
        try:
            mgr = httpx.get(f"{_GRAPH}/users/{emp.manager_email}", headers={"Authorization": f"Bearer {token}"}, timeout=20)
            if mgr.is_success:
                resp = httpx.put(f"{_GRAPH}/users/{user_id}/manager/$ref",
                                 headers={"Authorization": f"Bearer {token}"},
                                 json={"@odata.id": f"{_GRAPH}/users/{mgr.json()['id']}"}, timeout=20)
                if resp.is_success:
                    steps["m365_manager"].status = "ok"
                    steps["m365_manager"].detail = f"Reports to {emp.manager_email}"
                else:
                    raise RuntimeError(resp.text[:300])
            else:
                raise RuntimeError(f"manager {emp.manager_email} not found in tenant")
        except Exception as e:
            steps["m365_manager"].status = "failed"
            steps["m365_manager"].detail = str(e)[:400]
    else:
        steps["m365_manager"].status = "skipped"

    # 4/5) Asana + Ignite - manual until tier/API access is confirmed
    steps["asana"].status = "manual"
    steps["asana"].detail = "Invite to the Asana workspace by email"
    steps["ignite"].status = "manual"
    steps["ignite"].detail = "Create the Ignite account per role template"

    # 6) Welcome notification to the personal email (no password in the mail -
    #    the temp password is returned ONCE to the HR user who clicked)
    if user_id and emp.personal_email and os.getenv("NEXUS_FROM_EMAIL"):
        try:
            ok, detail = _send_welcome(emp, upn, token)
            steps["welcome_email"].status = "ok" if ok else "failed"
            steps["welcome_email"].detail = f"Sent to {emp.personal_email}" if ok else detail
        except Exception as e:
            steps["welcome_email"].status = "failed"
            steps["welcome_email"].detail = str(e)[:400]
    else:
        steps["welcome_email"].status = "skipped"

    statuses = {s.status for s in steps.values()}
    run.status = "failed" if failed else ("done" if "failed" not in statuses else "partial")
    run.finished_at = datetime.now(timezone.utc).isoformat()
    if emp.status == "onboarding" and user_id:
        emp.status = "active"
    db.commit()

    return {
        "runId": run.id, "status": run.status,
        "steps": [{"step": s.step, "status": s.status, "detail": s.detail}
                  for s in sorted(steps.values(), key=lambda x: x.ordinal)],
        "tempPassword": temp_password if user_id else None,
        "employee": _serialize(emp),
    }


@router.get("/employees/{eid}/provision/runs")
def provision_runs(eid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    runs = (db.query(HrProvisionRun).filter(HrProvisionRun.employee_id == eid)
            .order_by(HrProvisionRun.started_at.desc()).all())
    out = []
    for r in runs:
        steps = (db.query(HrProvisionStep).filter(HrProvisionStep.run_id == r.id)
                 .order_by(HrProvisionStep.ordinal).all())
        out.append({"id": r.id, "status": r.status, "startedBy": r.started_by,
                    "startedAt": r.started_at, "finishedAt": r.finished_at,
                    "steps": [{"step": s.step, "status": s.status, "detail": s.detail} for s in steps]})
    return out


@router.post("/employees/{eid}/push-to-entra")
def push_to_entra(eid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Push this person's name / title / department / phone / office (and manager,
    best-effort) from Nexus back to their linked Entra account. The mirror of
    Sync-from-M365, for when Nexus is the source of a profile change."""
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
    if not emp:
        raise HTTPException(404, "Employee not found")
    if not emp.m365_id:
        raise HTTPException(400, "This person has no linked M365 account to push to.")
    # A Graph/token failure must surface as a clean error, not an unhandled 500 -
    # a raw 500 bypasses CORSMiddleware and the browser only sees "Failed to fetch".
    try:
        token = _graph_token()
        written = _graph_writeback(token, emp, db)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Couldn't update Entra: {str(e)[:200]}")
    # Manager relationship is a separate Graph edge - best-effort, never blocks
    # the attribute push.
    try:
        manager = _graph_set_manager(token, emp)
    except Exception:
        manager = None
    return {"written": written, "manager": manager}


# ── Profile photos - public-read avatars bucket, WRITES ONLY via this endpoint
#    (no anon storage policies; the service key uploads on behalf of HR users)

_AVATAR_BUCKET = "avatars"
_IMAGE_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}
_MAX_AVATAR_BYTES = 5 * 1024 * 1024


@router.post("/employees/{eid}/photo")
async def upload_photo(eid: str, file: UploadFile = File(...),
                       user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
    if not emp:
        raise HTTPException(404, "Employee not found")
    ext = _IMAGE_TYPES.get(file.content_type or "")
    if not ext:
        raise HTTPException(400, "Photo must be JPEG, PNG, WebP or GIF")
    data = await file.read()
    if len(data) > _MAX_AVATAR_BYTES:
        raise HTTPException(400, "Photo must be under 5 MB")
    path = f"{eid}/{uuid.uuid4()}.{ext}"
    resp = httpx.post(
        f"{_SUPABASE_URL}/storage/v1/object/{_AVATAR_BUCKET}/{path}",
        headers={**_storage_headers(), "Content-Type": file.content_type,
                 "cache-control": "max-age=31536000"},
        content=data, timeout=60,
    )
    if not resp.is_success:
        raise HTTPException(502, f"Storage upload failed: {resp.text[:200]}")
    emp.photo_url = f"{_SUPABASE_URL}/storage/v1/object/public/{_AVATAR_BUCKET}/{path}"
    emp.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    db.refresh(emp)
    return _serialize(emp)


# The M365 directory import is scoped to the company's own domains only. Guests
# (#EXT# accounts) and every other vanity/partner domain (e.g. Z#Incentives)
# stay out of HR entirely. (Neil, Jun 27)
# aaravconstruction.com added Jul 16 (Visesh) - their staff are part of Nexus.
# scmedicenter.com added Aug 12 (Visesh) - SC Medi Center staff are part of Nexus.
_COMPANY_DOMAINS = ("greensglobal.com", "greensstorage.com", "aaravconstruction.com",
                    "scmedicenter.com")


def _primary_addr(g: dict) -> str:
    """The address we key an employee off: prefer mail, fall back to the UPN."""
    return (g.get("mail") or g.get("userPrincipalName") or "").strip().lower()


def _in_company_domain(addr: str, extra=()) -> bool:
    addr = (addr or "").strip().lower()
    if not addr or "#ext#" in addr:        # guests carry #EXT# in the UPN
        return False
    return any(addr.endswith("@" + d) for d in (*_COMPANY_DOMAINS, *extra))


def _norm_domains(s: str) -> str:
    """Normalize a comma-separated domain list: lowercase, no @, no blanks/dupes."""
    out = []
    for part in (s or "").replace(";", ",").split(","):
        d = part.strip().lstrip("@").lower()
        if d and d not in out:
            out.append(d)
    return ",".join(out)


def _entity_domain_map(db: Session) -> dict:
    """email domain → HrEntity.id, from the domain tags in Company setup."""
    m = {}
    for ent in db.query(HrEntity).all():
        for d in (ent.domains or "").split(","):
            d = d.strip()
            if d:
                m[d] = ent.id
    return m


def _assign_company_by_domain(db: Session, ent: "HrEntity") -> int:  # imported lower down
    """Tag company-less employees whose work-email domain matches this entity's
    domain tags. Never overwrites a company already set on a profile."""
    doms = {d for d in (ent.domains or "").split(",") if d}
    if not doms:
        return 0
    n = 0
    rows = db.query(NexusEmployee).filter(
        (NexusEmployee.company == "") | (NexusEmployee.company.is_(None))).all()
    for e in rows:
        if (e.work_email or "").lower().split("@")[-1] in doms:
            e.company = ent.id
            n += 1
    return n


def _split_name(g: dict) -> tuple:
    """Best-effort first/last from Entra (givenName/surname, else displayName)."""
    first = (g.get("givenName") or "").strip()
    last  = (g.get("surname") or "").strip()
    if not first and not last:
        parts = (g.get("displayName") or "").strip().split()
        first = parts[0] if parts else _primary_addr(g).split("@")[0] or "Unknown"
        last  = " ".join(parts[1:]) if len(parts) > 1 else ""
    return first, last


# Words in a display name that mark an account as a non-person (shared/site
# mailbox, room or resource) even when it somehow has a first/last name.
_RESOURCE_HINTS = (
    "conference room", "meeting room", "boardroom", "mailbox", "reception",
    "front desk", "service account", "shared", " room",
)


def _is_non_person(g: dict) -> bool:
    """Keep real people, drop everything that isn't one. M365 returns departed
    staff (the '#Inactive' naming convention) and shared/site/room mailboxes
    alongside real users; none of those belong in the HR people list.

    Real people are provisioned with givenName + surname (see provision_employee);
    shared mailboxes and rooms are created in Exchange with only a displayName.
    So the absence of BOTH name parts is the reliable 'not a person' signal."""
    name  = (g.get("displayName") or "").strip().lower()
    first = (g.get("givenName") or "").strip()
    last  = (g.get("surname") or "").strip()
    if "#inactive" in name:                # departed-staff convention (Z #Inactive ...)
        return True
    if not first and not last:             # shared / site / room / resource mailbox
        return True
    if any(h in name for h in _RESOURCE_HINTS):
        return True
    return False


def _emp_is_non_person(e: NexusEmployee) -> bool:
    """Same test against a stored row (we only keep the marker in the name)."""
    return "#inactive" in f"{e.first_name} {e.last_name}".strip().lower()


def _graph_directory(token: str) -> list:
    """Every user object in the tenant, following @odata.nextLink paging. The
    caller filters down to company domains."""
    users, url = [], (
        f"{_GRAPH}/users?$select=id,displayName,givenName,surname,userPrincipalName,"
        "mail,jobTitle,department,mobilePhone,officeLocation,accountEnabled&$top=999"
    )
    while url:
        resp = httpx.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=30)
        if not resp.is_success:
            raise HTTPException(502, f"Graph error: {resp.text[:200]}")
        data = resp.json()
        users.extend(data.get("value", []))
        url = data.get("@odata.nextLink")
    return users


@router.post("/employees/sync-m365")
def sync_m365(user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Pull the M365 directory into HR (see _pull_from_m365)."""
    return _pull_from_m365(db, user["email"])


def _pull_from_m365(db: Session, actor_email: str) -> dict:
    """Pull the M365 directory into HR. Only the company's own domains come in -
    _COMPANY_DOMAINS plus every domain tagged on a company in Company setup -
    guests and other partner domains are skipped, and so are non-people: departed
    staff (#Inactive convention) and shared/site/room mailboxes. People not in HR
    yet are created (tagged to the company owning their email domain); existing
    profiles are linked by Entra id / work email and have empty fields backfilled
    (never overwrites values already set in Nexus). Accounts deleted in Entra get
    their M365 link dropped; non-people that were imported earlier are removed."""
    token = _graph_token()
    domain_map = _entity_domain_map(db)    # Company-setup domain tags
    extra_domains = tuple(domain_map)
    company = [g for g in _graph_directory(token) if _in_company_domain(_primary_addr(g), extra_domains)]
    # Every company account we saw (people or not) - used to detect truly-deleted
    # accounts. Real importable people are that set minus the non-people.
    seen_ids     = {(g.get("id") or "").lower() for g in company if g.get("id")}
    nonperson_ids = {(g.get("id") or "").lower() for g in company if _is_non_person(g)}
    directory    = [g for g in company if not _is_non_person(g)]

    # Index existing rows so a directory user matches by Entra id or work email.
    existing = db.query(NexusEmployee).all()
    by_m365  = {e.m365_id.lower(): e for e in existing if e.m365_id}
    by_email = {e.work_email.lower(): e for e in existing if e.work_email}
    # Identities intentionally removed from Nexus - the sync must NOT resurrect them
    # from Entra even though their Microsoft account still exists.
    _tomb = db.query(HrRemovedIdentity).all()
    tomb_ids    = {t.m365_id.lower() for t in _tomb if t.m365_id}
    tomb_emails = {t.work_email.lower() for t in _tomb if t.work_email}

    now = datetime.now(timezone.utc).isoformat()
    # Compute the next code once and increment locally - _next_code re-reads the
    # DB and uncommitted rows aren't flushed, so calling it per-create repeats.
    next_num = int(_next_code(db).split("-")[1])

    created = linked = updated = 0
    for g in directory:
        gid  = (g.get("id") or "").lower()
        addr = _primary_addr(g)
        if gid in tomb_ids or (addr and addr in tomb_emails):
            continue   # removed from Nexus on purpose - don't re-create or re-link
        emp = by_m365.get(gid) or by_email.get(addr)
        if emp:
            changed = False
            if not emp.m365_id and g.get("id"):
                emp.m365_id = g["id"]; linked += 1; changed = True
            if not emp.work_email and addr:
                emp.work_email = addr; changed = True
            for local, remote in (("phone", "mobilePhone"), ("job_title", "jobTitle"),
                                  ("location", "officeLocation"), ("department", "department")):
                if not getattr(emp, local) and (g.get(remote) or "").strip():
                    setattr(emp, local, g[remote].strip()); changed = True
            # Entra owns this one, so it tracks rather than backfills: it is the
            # name Teams/Outlook show, and a stale copy makes Nexus look like it
            # means a different person.
            entra_name = (g.get("displayName") or "").strip()
            if entra_name and emp.display_name != entra_name:
                emp.display_name = entra_name; changed = True
            if not emp.company and domain_map.get(addr.split("@")[-1]):
                emp.company = domain_map[addr.split("@")[-1]]; changed = True
            if changed:
                emp.updated_at = now; updated += 1
        else:
            first, last = _split_name(g)
            emp = NexusEmployee(
                id=str(uuid.uuid4()),
                employee_code=f"GG-{next_num:03d}",
                first_name=first, last_name=last,
                display_name=(g.get("displayName") or "").strip(),
                work_email=addr,
                job_title=(g.get("jobTitle") or "").strip(),
                department=(g.get("department") or "").strip(),
                phone=(g.get("mobilePhone") or "").strip(),
                location=(g.get("officeLocation") or "").strip(),
                company=domain_map.get(addr.split("@")[-1], ""),
                status="active" if g.get("accountEnabled", True) else "inactive",
                m365_id=g.get("id") or "",
                created_by=actor_email, created_at=now, updated_at=now,
            )
            db.add(emp)
            if gid:
                by_m365[gid] = emp
            if addr:
                by_email[addr] = emp
            next_num += 1; created += 1

    # Clean up existing rows. Only ever touch M365-sourced rows (have an m365_id)
    # so manually-added people are never disturbed:
    #   • non-people that slipped in on an earlier sync (shared mailboxes, rooms,
    #     #Inactive accounts) are deleted outright;
    #   • people whose Entra account is gone get their stale M365 link dropped so
    #     the profile stops claiming M365 ✓ and can be re-provisioned.
    removed, unlinked = [], []
    for e in existing:
        if not e.m365_id:
            continue
        name = f"{e.first_name} {e.last_name}".strip()
        if e.m365_id.lower() in nonperson_ids or _emp_is_non_person(e):
            db.delete(e); removed.append(name); continue
        if e.m365_id.lower() not in seen_ids and _in_company_domain(e.work_email, extra_domains):
            e.m365_id = ""; e.updated_at = now
            unlinked.append(name)

    db.commit()
    return {"created": created, "linked": linked, "updated": updated,
            "removed": removed, "unlinked": unlinked, "checked": len(directory)}


# ── Two-way M365 sync (one button: pull directory, then push every profile) ──

def _serialize_sync_run(r) -> dict:
    return {"id": r.id, "phase": r.phase, "startedBy": r.started_by,
            "startedAt": r.started_at, "finishedAt": r.finished_at,
            "total": r.total, "done": r.done, "pushedOk": r.pushed_ok,
            "pushFailed": r.push_failed,
            "pull": json.loads(r.pull_summary) if r.pull_summary else None,
            "errors": json.loads(r.errors) if r.errors else []}


def _two_way_sync_task(run_id: str, actor_email: str):
    """Background body of the two-way sync. Own DB session (the request's is
    gone by the time this runs); commits progress every few people so the
    status endpoint always has something fresh to report. Sync function on
    purpose - FastAPI runs it in the threadpool, so blocking Graph calls are
    fine here (never on the event loop)."""
    from database import SessionLocal
    from models import M365SyncRun
    db = SessionLocal()
    try:
        run = db.query(M365SyncRun).filter(M365SyncRun.id == run_id).first()
        if not run:
            return
        now = lambda: datetime.now(timezone.utc).isoformat()  # noqa: E731
        try:
            pull = _pull_from_m365(db, actor_email)
        except Exception as e:
            run.phase = "failed"
            run.errors = json.dumps([{"email": "(pull phase)", "error": str(e)[:200]}])
            run.finished_at = now()
            db.commit()
            return
        run.pull_summary = json.dumps(pull)
        emps = [e for e in db.query(NexusEmployee).filter(NexusEmployee.m365_id != "").all()
                if not _emp_is_non_person(e)]
        run.phase, run.total = "push", len(emps)
        db.commit()
        token = _graph_token()
        errors = []
        for i, emp in enumerate(emps):
            try:
                _graph_writeback(token, emp, db)
                _graph_set_manager(token, emp)
                run.pushed_ok += 1
            except Exception as e:
                run.push_failed += 1
                if len(errors) < 40:
                    errors.append({"email": emp.work_email or emp.id, "error": str(e)[:160]})
            run.done = i + 1
            if run.done % 5 == 0:
                run.errors = json.dumps(errors)
                db.commit()
            time.sleep(0.12)   # throttle-polite pacing for Graph
        run.errors = json.dumps(errors)
        run.phase, run.finished_at = "done", now()
        db.commit()
    finally:
        db.close()


@router.post("/employees/sync-m365-two-way")
def sync_m365_two_way(background_tasks: BackgroundTasks,
                      user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Start a full two-way sync: pull the directory (link/backfill, exactly the
    single-direction sync), then push EVERY linked profile back to Entra -
    titles level-stripped, Nexus values winning wherever Nexus has one. Returns
    immediately; poll .../status for progress. One run at a time."""
    from models import M365SyncRun
    latest = db.query(M365SyncRun).order_by(M365SyncRun.started_at.desc()).first()
    if latest and latest.phase in ("pull", "push"):
        try:
            age = (datetime.now(timezone.utc)
                   - datetime.fromisoformat(latest.started_at)).total_seconds()
        except Exception:
            age = 0
        if age < 1800:   # a genuinely-running sync; older = crashed run, allow restart
            raise HTTPException(409, "A sync is already running - watch its progress instead.")
    run = M365SyncRun(id=str(uuid.uuid4()), started_by=user["email"],
                      started_at=datetime.now(timezone.utc).isoformat())
    db.add(run)
    db.commit()
    background_tasks.add_task(_two_way_sync_task, run.id, user["email"])
    return {"started": run.id}


@router.get("/employees/sync-m365-two-way/status")
def sync_m365_two_way_status(user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    from models import M365SyncRun
    run = db.query(M365SyncRun).order_by(M365SyncRun.started_at.desc()).first()
    return _serialize_sync_run(run) if run else {"phase": "none"}


@router.post("/employees/sync-photos")
def sync_photos(user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Pull every linked person's Entra profile photo into the avatars bucket and
    point their profile at it. Only touches M365-linked rows (need a Graph id);
    accounts with no photo in Entra are left as-is. Graph returns the largest
    available render at /users/{id}/photo/$value (404 = no photo set)."""
    token = _graph_token()
    headers = {"Authorization": f"Bearer {token}"}
    emps = db.query(NexusEmployee).filter(NexusEmployee.m365_id != "").all()
    now = datetime.now(timezone.utc).isoformat()
    updated, no_photo, failed = 0, 0, []
    for emp in emps:
        name = f"{emp.first_name} {emp.last_name}".strip()
        try:
            r = httpx.get(f"{_GRAPH}/users/{emp.m365_id}/photo/$value", headers=headers, timeout=30)
        except Exception:
            failed.append(name); continue
        if r.status_code == 404:        # ImageNotFound - person has no Entra photo
            no_photo += 1; continue
        if not r.is_success:
            failed.append(name); continue
        data = r.content
        if not data or len(data) > _MAX_AVATAR_BYTES:
            failed.append(name); continue
        ctype = (r.headers.get("content-type") or "image/jpeg").split(";")[0].strip()
        ext = _IMAGE_TYPES.get(ctype, "jpg")
        path = f"{emp.id}/{uuid.uuid4()}.{ext}"
        up = httpx.post(
            f"{_SUPABASE_URL}/storage/v1/object/{_AVATAR_BUCKET}/{path}",
            headers={**_storage_headers(), "Content-Type": ctype, "cache-control": "max-age=31536000"},
            content=data, timeout=60,
        )
        if not up.is_success:
            failed.append(name); continue
        emp.photo_url = f"{_SUPABASE_URL}/storage/v1/object/public/{_AVATAR_BUCKET}/{path}"
        emp.updated_at = now
        updated += 1
    db.commit()
    return {"updated": updated, "noPhoto": no_photo, "failed": failed, "checked": len(emps)}


# ── Welcome email - branded, warm, role-aware (not the old two-liner) ────────

def _welcome_html(emp: NexusEmployee, upn: str) -> str:
    from html import escape
    first = escape(emp.first_name)
    role_line = " · ".join(x for x in (emp.job_title, emp.department) if x)
    detail_rows = "".join(
        f"<tr><td style='padding:7px 0;font-size:12px;color:#6b7280;width:140px;text-transform:uppercase;letter-spacing:.05em;font-weight:700'>{label}</td>"
        f"<td style='padding:7px 0;font-size:14px;color:#111827;font-weight:600'>{escape(value)}</td></tr>"
        for label, value in (
            ("Your name", f"{emp.first_name} {emp.last_name}".strip()),
            ("Role", role_line),
            ("Work email", upn),
            ("Start date", emp.start_date or "We'll confirm shortly"),
            ("Location", emp.location or ""),
        ) if value
    )
    return f"""<div style="background:#f4f5f7;padding:32px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;border:1px solid #e5e7eb;border-collapse:separate;overflow:hidden">
    <tr>
      <td style="background:#0f3d2e;padding:34px 36px 30px;text-align:center">
        <div style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:4px">GREENS GLOBAL</div>
        <div style="color:#ffffff;font-size:26px;font-weight:800;margin-top:22px;line-height:1.3">Welcome aboard, {first}! 🎉</div>
        <div style="color:#cde9d9;font-size:14px;margin-top:8px">We're genuinely glad you're here.</div>
      </td>
    </tr>
    <tr>
      <td style="padding:30px 36px 6px">
        <p style="margin:0 0 14px;font-size:14.5px;line-height:1.7;color:#1f2937">
          On behalf of the whole team, welcome aboard{f" as our new <strong>{escape(emp.job_title)}</strong>" if emp.job_title else ""}!
          We've been looking forward to this, and your tools are already set up and waiting for you.
        </p>
        <p style="margin:0 0 18px;font-size:14.5px;line-height:1.7;color:#1f2937">
          Your company account gives you email, Teams, and the Nexus portal, the home for
          everything from equipment requests to time off. Here's everything you need for day one:
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f7f3;border:1px solid #cde9d9;border-radius:12px;border-collapse:separate;margin-bottom:20px">
          <tr><td style="padding:16px 20px 8px">
            <div style="font-size:11px;font-weight:800;letter-spacing:.08em;color:#0f3d2e;margin-bottom:4px">YOUR DETAILS</div>
            <table cellpadding="0" cellspacing="0" width="100%">{detail_rows}</table>
          </td></tr>
        </table>
        <div style="font-size:11px;font-weight:800;letter-spacing:.08em;color:#0f3d2e;margin-bottom:10px">YOUR FIRST STEPS</div>
        <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:6px">
          <tr><td style="padding:6px 0;font-size:14px;line-height:1.65;color:#1f2937"><strong>1.</strong>&nbsp; Go to <a href="https://office.com" style="color:#15803d;font-weight:600">office.com</a> and sign in with <strong>{upn}</strong>.</td></tr>
          <tr><td style="padding:6px 0;font-size:14px;line-height:1.65;color:#1f2937"><strong>2.</strong>&nbsp; Use the temporary password HR shares with you directly. You'll be asked to set your own right away. (We never email passwords.)</td></tr>
          <tr><td style="padding:6px 0;font-size:14px;line-height:1.65;color:#1f2937"><strong>3.</strong>&nbsp; Open <strong>Outlook</strong> for email and <strong>Teams</strong> to say hi. Your team is expecting you.</td></tr>
          <tr><td style="padding:6px 0;font-size:14px;line-height:1.65;color:#1f2937"><strong>4.</strong>&nbsp; Keep an eye on your inbox. Your manager will reach out with your first-week plan, and anything you need (laptop, tools, access) gets arranged through Nexus.</td></tr>
        </table>
        <p style="margin:18px 0 6px;font-size:14.5px;line-height:1.7;color:#1f2937">
          Questions before your first day? Just reply to HR or reach out to your manager. There's no such
          thing as a silly question in week one.
        </p>
        <p style="margin:14px 0 24px;font-size:14.5px;line-height:1.7;color:#1f2937">
          We can't wait to see what you'll do here. Once again, <strong>welcome aboard!</strong><br>
          <span style="color:#6b7280">The People Team</span>
        </p>
      </td>
    </tr>
    <tr>
      <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 36px;font-size:11.5px;color:#6b7280;line-height:1.5">
        Sent via Nexus. This mailbox isn't monitored. For help, contact HR or your manager directly.
      </td>
    </tr>
  </table>
</div>"""


def _send_welcome(emp: NexusEmployee, upn: str, token: str) -> tuple:
    """Send the branded welcome to the personal email. Returns (ok, detail)."""
    sender = os.getenv("NEXUS_FROM_EMAIL", "")
    if not (emp.personal_email and sender):
        return False, "no personal email on file" if not emp.personal_email else "NEXUS_FROM_EMAIL not set"
    resp = httpx.post(f"{_GRAPH}/users/{sender}/sendMail",
                      headers={"Authorization": f"Bearer {token}"}, json={
        "message": {
            "subject": f"Welcome aboard, {emp.first_name}!",
            "body": {"contentType": "HTML", "content": _welcome_html(emp, upn)},
            "toRecipients": [{"emailAddress": {"address": emp.personal_email}}],
        }, "saveToSentItems": False}, timeout=20)
    return resp.is_success, ("" if resp.is_success else resp.text[:300])


@router.post("/employees/{eid}/welcome-email")
def resend_welcome(eid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
    if not emp:
        raise HTTPException(404, "Employee not found")
    if not emp.work_email:
        raise HTTPException(400, "Employee has no work email yet - provision first")
    if not emp.personal_email:
        raise HTTPException(400, "Employee has no personal email on file")
    ok, detail = _send_welcome(emp, emp.work_email, _graph_token())
    if not ok:
        raise HTTPException(502, f"Send failed: {detail}")
    return {"ok": True, "sentTo": emp.personal_email}


# ---------------------------------------------------------------------------
# HR Section A - Companies/Entities + Work Sites (structural foundation)
# ---------------------------------------------------------------------------
from models import HrEntity, HrWorkSite, HrDepartment, NexusSetting


class EntityIn(BaseModel):
    name:               str
    legal_name:         Optional[str] = ""
    country:            Optional[str] = ""
    tax_id:             Optional[str] = ""
    registered_address: Optional[str] = ""
    signatory:          Optional[str] = ""
    logo_url:           Optional[str] = ""
    notes:              Optional[str] = ""
    domains:            Optional[str] = ""   # comma-separated email domains
    manager_email:      Optional[str] = ""   # company manager (a Nexus person)


class EntityUpdate(BaseModel):
    name:               Optional[str] = None
    legal_name:         Optional[str] = None
    country:            Optional[str] = None
    tax_id:             Optional[str] = None
    registered_address: Optional[str] = None
    signatory:          Optional[str] = None
    logo_url:           Optional[str] = None
    notes:              Optional[str] = None
    domains:            Optional[str] = None
    manager_email:      Optional[str] = None


def _serialize_entity(e: HrEntity) -> dict:
    return {
        "id": e.id, "name": e.name, "legalName": e.legal_name, "country": e.country,
        "taxId": e.tax_id, "registeredAddress": e.registered_address, "signatory": e.signatory,
        "logoUrl": e.logo_url, "notes": e.notes, "domains": e.domains or "",
        "managerEmail": e.manager_email or "",
        "createdAt": e.created_at, "updatedAt": e.updated_at,
    }


@router.get("/entities")
def list_entities(user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    rows = db.query(HrEntity).order_by(HrEntity.name).all()
    return [_serialize_entity(e) for e in rows]


@router.post("/entities")
def create_entity(body: EntityIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    if not body.name.strip():
        raise HTTPException(400, "name is required")
    now = datetime.now(timezone.utc).isoformat()
    row = HrEntity(
        id=str(uuid.uuid4()), name=body.name.strip(), legal_name=(body.legal_name or "").strip(),
        country=(body.country or "").strip(), tax_id=(body.tax_id or "").strip(),
        registered_address=(body.registered_address or "").strip(), signatory=(body.signatory or "").strip(),
        logo_url=(body.logo_url or "").strip(), notes=body.notes or "",
        domains=_norm_domains(body.domains or ""),
        manager_email=(body.manager_email or "").strip().lower(),
        created_by=user["email"], created_at=now, updated_at=now,
    )
    db.add(row)
    _assign_company_by_domain(db, row)
    db.commit(); db.refresh(row)
    return _serialize_entity(row)


@router.patch("/entities/{entity_id}")
def update_entity(entity_id: str, body: EntityUpdate, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    row = db.query(HrEntity).filter(HrEntity.id == entity_id).first()
    if not row:
        raise HTTPException(404, "Entity not found")
    if body.name is not None and not body.name.strip():
        raise HTTPException(400, "name cannot be empty")
    for key, value in body.model_dump(exclude_unset=True).items():
        if value is None:
            continue
        if key == "domains":
            value = _norm_domains(value)
        elif key == "manager_email":
            value = value.strip().lower()
        setattr(row, {"legal_name": "legal_name", "tax_id": "tax_id", "registered_address": "registered_address"}.get(key, key),
                value.strip() if isinstance(value, str) and key != "notes" else value)
    row.updated_at = datetime.now(timezone.utc).isoformat()
    _assign_company_by_domain(db, row)
    db.commit(); db.refresh(row)
    return _serialize_entity(row)


@router.delete("/entities/{entity_id}")
def delete_entity(entity_id: str, user: dict = Depends(require_hr_delete), db: Session = Depends(get_db)):
    row = db.query(HrEntity).filter(HrEntity.id == entity_id).first()
    if row:
        db.delete(row); db.commit()
    return {"ok": True}


# ── Group manager - one person overseeing ALL companies (the escalation step
# above each company's manager). A singleton, stored in nexus_settings.

_GROUP_MANAGER_KEY = "hr.group_manager_email"


class GroupManagerIn(BaseModel):
    email: Optional[str] = ""


@router.get("/group-manager")
def get_group_manager(user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    row = db.query(NexusSetting).filter(NexusSetting.key == _GROUP_MANAGER_KEY).first()
    return {"email": (row.value if row else "") or ""}


@router.put("/group-manager")
def set_group_manager(body: GroupManagerIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    row = db.query(NexusSetting).filter(NexusSetting.key == _GROUP_MANAGER_KEY).first()
    if not row:
        row = NexusSetting(key=_GROUP_MANAGER_KEY)
        db.add(row)
    row.value = (body.email or "").strip().lower()
    row.updated_by = user["email"]
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    return {"email": row.value}


# ── Departments - scoped to a company, NOT a Nexus-wide hardcoded list ──────────
# Companies are global (HrEntity); each one owns its own editable department set.
# Greens Global is seeded from the legacy hardcoded list the first time its
# departments are read; every other company starts empty. Whatever departments
# already exist as free-text on employee rows are backfilled non-destructively so
# nothing breaks the day we switch the form to this dropdown.
_DEFAULT_DEPTS = ["Operations", "Accounting", "IT", "Construction", "Facilities", "Marketing", "Real Estate", "Administration", "HR"]


def _dept_key(s: str) -> str:
    return (s or "").strip().lower()


def _is_primary_greens(e: HrEntity) -> bool:
    # Tolerate legal suffixes/punctuation: "Greens Global, Inc." must still match
    # (an exact-string check here once left the primary entity unseeded - the Add
    # Employee department dropdown came up empty and blocked the whole form).
    key = re.sub(r"[^a-z ]", "", _dept_key(e.name)).strip()
    return key == "greens" or key.startswith("greens global")


def _ensure_departments(db: Session, entity: HrEntity) -> None:
    """Seed + backfill this company's department list, idempotently."""
    existing = db.query(HrDepartment).filter(HrDepartment.company_id == entity.id).all()
    have = {_dept_key(d.name) for d in existing}
    now = datetime.now(timezone.utc).isoformat()
    nxt = max([d.sort_order for d in existing], default=-1) + 1
    to_add = []
    # 1) seed the standard list onto the primary Greens entity if it has none yet
    if not existing and _is_primary_greens(entity):
        to_add = list(_DEFAULT_DEPTS)
    # 2) backfill any department strings already sitting on this company's employees
    used = db.query(NexusEmployee.department).filter(NexusEmployee.company == entity.id).distinct().all()
    entity_key = _dept_key(entity.name or "")   # never let the company's OWN name become a department
    for (name,) in used:
        name = (name or "").strip()
        if not name or _dept_key(name) == entity_key:
            continue
        if _dept_key(name) not in have and name not in to_add:
            to_add.append(name)
    for name in to_add:
        if _dept_key(name) in have:
            continue
        db.add(HrDepartment(id=str(uuid.uuid4()), company_id=entity.id, name=name, sort_order=nxt, created_by="system", created_at=now))
        have.add(_dept_key(name)); nxt += 1
    if to_add:
        db.commit()


def _serialize_dept(d: HrDepartment) -> dict:
    return {"id": d.id, "name": d.name, "sortOrder": d.sort_order,
            "leadEmail": d.lead_email or "", "backupEmail": d.backup_email or ""}


@router.get("/entities/{entity_id}/departments")
def list_departments(entity_id: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    entity = db.query(HrEntity).filter(HrEntity.id == entity_id).first()
    if not entity:
        raise HTTPException(404, "Company not found")
    _ensure_departments(db, entity)
    rows = db.query(HrDepartment).filter(HrDepartment.company_id == entity_id).order_by(HrDepartment.sort_order, HrDepartment.name).all()
    return [_serialize_dept(d) for d in rows]


class DepartmentIn(BaseModel):
    name: str


@router.post("/entities/{entity_id}/departments", status_code=201)
def add_department(entity_id: str, body: DepartmentIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    entity = db.query(HrEntity).filter(HrEntity.id == entity_id).first()
    if not entity:
        raise HTTPException(404, "Company not found")
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "Department name cannot be empty")
    if len(name) > 40:
        raise HTTPException(400, "Department name is too long (40 characters max)")
    if _dept_key(name) == _dept_key(entity.name or ""):
        raise HTTPException(400, "A department can't have the same name as the company")
    _ensure_departments(db, entity)
    rows = db.query(HrDepartment).filter(HrDepartment.company_id == entity_id).all()
    if any(_dept_key(r.name) == _dept_key(name) for r in rows):
        return [_serialize_dept(d) for d in sorted(rows, key=lambda d: (d.sort_order, d.name))]
    nxt = max([r.sort_order for r in rows], default=-1) + 1
    db.add(HrDepartment(id=str(uuid.uuid4()), company_id=entity_id, name=name, sort_order=nxt, created_by=user["email"], created_at=datetime.now(timezone.utc).isoformat()))
    db.commit()
    rows = db.query(HrDepartment).filter(HrDepartment.company_id == entity_id).order_by(HrDepartment.sort_order, HrDepartment.name).all()
    return [_serialize_dept(d) for d in rows]


class DepartmentUpdate(BaseModel):
    name:         Optional[str] = None
    lead_email:   Optional[str] = None
    backup_email: Optional[str] = None


@router.patch("/entities/{entity_id}/departments/{dept_id}")
def update_department(entity_id: str, dept_id: str, body: DepartmentUpdate,
                      user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Rename a department and/or set its triage lead / backup. Tickets raised
    against it are left unassigned and these two are notified to assign an
    employee."""
    row = db.query(HrDepartment).filter(HrDepartment.id == dept_id, HrDepartment.company_id == entity_id).first()
    if not row:
        raise HTTPException(404, "Department not found")
    if body.name is not None:
        new_name = (body.name or "").strip()
        if not new_name:
            raise HTTPException(400, "Department name cannot be empty")
        if len(new_name) > 40:
            raise HTTPException(400, "Department name is too long (40 characters max)")
        siblings = db.query(HrDepartment).filter(HrDepartment.company_id == entity_id,
                                                 HrDepartment.id != dept_id).all()
        if any(_dept_key(s.name) == _dept_key(new_name) for s in siblings):
            raise HTTPException(409, f"“{new_name}” already exists for this company")
        if new_name != row.name:
            # Employees carry the department as a NAME string, not an id - follow
            # the rename so nobody is left in a no-longer-pickable department.
            old_key = _dept_key(row.name)
            for e in db.query(NexusEmployee).filter(NexusEmployee.company == entity_id).all():
                if _dept_key(e.department or "") == old_key:
                    e.department = new_name
            row.name = new_name
    if body.lead_email is not None:
        row.lead_email = (body.lead_email or "").strip().lower()
    if body.backup_email is not None:
        row.backup_email = (body.backup_email or "").strip().lower()
    db.commit()
    rows = db.query(HrDepartment).filter(HrDepartment.company_id == entity_id).order_by(HrDepartment.sort_order, HrDepartment.name).all()
    return [_serialize_dept(d) for d in rows]


@router.delete("/entities/{entity_id}/departments/{dept_id}")
def delete_department(entity_id: str, dept_id: str, reassign_to: Optional[str] = None,
                      user: dict = Depends(require_hr_delete), db: Session = Depends(get_db)):
    row = db.query(HrDepartment).filter(HrDepartment.id == dept_id, HrDepartment.company_id == entity_id).first()
    if row:
        # Move (or clear) anyone still tagged with this department FIRST - otherwise
        # _ensure_departments backfills it straight back from those employee records
        # on the next load, which is why a deleted department "came back on refresh".
        # reassign_to = another department name to merge people into, else blank
        # leaves them with no department.
        target = (reassign_to or "").strip()
        dept_key = _dept_key(row.name)
        for e in db.query(NexusEmployee).filter(NexusEmployee.company == entity_id).all():
            if _dept_key(e.department or "") == dept_key:
                e.department = target
        db.delete(row); db.commit()
    rows = db.query(HrDepartment).filter(HrDepartment.company_id == entity_id).order_by(HrDepartment.sort_order, HrDepartment.name).all()
    return [_serialize_dept(d) for d in rows]


class WorkSiteIn(BaseModel):
    name:     str
    address:  Optional[str] = ""
    latitude: Optional[str] = ""
    longitude: Optional[str] = ""
    radius_m: Optional[int] = 150
    company:  Optional[str] = ""
    notes:    Optional[str] = ""


class WorkSiteUpdate(BaseModel):
    name:     Optional[str] = None
    address:  Optional[str] = None
    latitude: Optional[str] = None
    longitude: Optional[str] = None
    radius_m: Optional[int] = None
    company:  Optional[str] = None
    notes:    Optional[str] = None


def _serialize_site(s: HrWorkSite) -> dict:
    return {
        "id": s.id, "name": s.name, "address": s.address, "latitude": s.latitude,
        "longitude": s.longitude, "radiusM": s.radius_m, "company": s.company,
        "notes": s.notes, "createdAt": s.created_at, "updatedAt": s.updated_at,
    }


@router.get("/work-sites")
def list_work_sites(user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    rows = db.query(HrWorkSite).order_by(HrWorkSite.name).all()
    return [_serialize_site(s) for s in rows]


@router.post("/work-sites")
def create_work_site(body: WorkSiteIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    if not body.name.strip():
        raise HTTPException(400, "name is required")
    now = datetime.now(timezone.utc).isoformat()
    row = HrWorkSite(
        id=str(uuid.uuid4()), name=body.name.strip(), address=(body.address or "").strip(),
        latitude=(body.latitude or "").strip(), longitude=(body.longitude or "").strip(),
        radius_m=body.radius_m if body.radius_m is not None else 150,
        company=(body.company or "").strip(), notes=body.notes or "",
        created_by=user["email"], created_at=now, updated_at=now,
    )
    db.add(row); db.commit(); db.refresh(row)
    return _serialize_site(row)


@router.patch("/work-sites/{site_id}")
def update_work_site(site_id: str, body: WorkSiteUpdate, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    row = db.query(HrWorkSite).filter(HrWorkSite.id == site_id).first()
    if not row:
        raise HTTPException(404, "Work site not found")
    if body.name is not None and not body.name.strip():
        raise HTTPException(400, "name cannot be empty")
    for key, value in body.model_dump(exclude_unset=True).items():
        if value is None:
            continue
        setattr(row, key, value.strip() if isinstance(value, str) and key != "notes" else value)
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit(); db.refresh(row)
    return _serialize_site(row)


@router.delete("/work-sites/{site_id}")
def delete_work_site(site_id: str, user: dict = Depends(require_hr_delete), db: Session = Depends(get_db)):
    row = db.query(HrWorkSite).filter(HrWorkSite.id == site_id).first()
    if row:
        db.delete(row); db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# HR Section B - Compensation + Bank (salary-restricted: hr_comp grant / owner)
# ---------------------------------------------------------------------------
class CompensationIn(BaseModel):
    compensation: Optional[dict] = None   # {base, payBasis, frequency, currency, effectiveDate, history[]}
    bank:         Optional[list] = None   # [{holder, number, routingOrIfsc, type, bankName}]


@router.get("/employees/{eid}/compensation")
def get_compensation(eid: str, user: dict = Depends(require_hr_comp_read),
                     _su: dict = Depends(require_stepup), db: Session = Depends(get_db)):
    row = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
    if not row:
        raise HTTPException(404, "Employee not found")
    return {"compensation": row.compensation or {}, "bank": row.bank or []}


# ── Pay-record link: the inline "Payroll wage" (PayrollRate, drives the timecard)
#    and the "Pay & Benefits" compensation record mirror each other's pay amount /
#    basis / currency, so the two never disagree. Benefits + bank stay only on comp;
#    weekend OT stays only on the rate. Each syncs the OTHER table directly (no loop).
def sync_comp_from_rate(db: Session, email: str) -> None:
    """Inline Payroll wage saved → reflect it in the Pay & Benefits record."""
    emp = db.query(NexusEmployee).filter(NexusEmployee.work_email == (email or "").lower()).first()
    rate = db.query(PayrollRate).filter(PayrollRate.employee_email == (email or "").lower()).first()
    if not emp or not rate:
        return
    comp = dict(emp.compensation or {})
    if (getattr(rate, "pay_type", "hourly") or "hourly") == "fixed":
        comp["payBasis"], comp["frequency"] = "salary", "monthly"
        comp["base"] = getattr(rate, "monthly_salary", 0) or 0
    else:
        comp["payBasis"] = "hourly"
        comp["base"] = getattr(rate, "hourly_rate", 0) or 0
    comp["currency"] = getattr(rate, "currency", "USD") or "USD"
    emp.compensation = comp


def sync_rate_from_comp(db: Session, emp: NexusEmployee) -> None:
    """Pay & Benefits saved → reflect base/basis/currency in the timecard rate."""
    if not emp or not emp.work_email:
        return
    comp = emp.compensation or {}
    basis = comp.get("payBasis", "")
    base = float(comp.get("base") or 0)
    row = db.query(PayrollRate).filter(PayrollRate.employee_email == emp.work_email.lower()).first()
    if not row:
        row = PayrollRate(employee_email=emp.work_email.lower())
        db.add(row)
    cur = comp.get("currency") or ""
    if cur in ("USD", "INR"):
        row.currency = cur
    if basis == "hourly":
        row.pay_type, row.hourly_rate, row.monthly_salary = "hourly", base, 0.0
    elif basis == "salary":
        # base is per the pay frequency - normalize to a MONTHLY figure for the timecard.
        mult = {"monthly": 1.0, "semimonthly": 2.0, "biweekly": 26 / 12, "weekly": 52 / 12}.get(
            comp.get("frequency", "monthly"), 1.0)
        row.pay_type, row.monthly_salary, row.hourly_rate = "fixed", round(base * mult, 2), 0.0
    else:
        # daily / fixed_fee have NO timecard pay model - zero the timecard pay so it
        # can't keep silently paying the previous (hourly/salary) model.
        row.pay_type, row.hourly_rate, row.monthly_salary = "hourly", 0.0, 0.0


@router.put("/employees/{eid}/compensation")
def save_compensation(eid: str, body: CompensationIn, user: dict = Depends(require_hr_comp_write),
                      _su: dict = Depends(require_stepup), db: Session = Depends(get_db)):
    row = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
    if not row:
        raise HTTPException(404, "Employee not found")
    if body.compensation is not None:
        incoming = dict(body.compensation or {})
        current = dict(row.compensation or {})
        # Auto-snapshot the prior base into history when the base pay changes.
        old_base, new_base = str(current.get("base", "")), str(incoming.get("base", ""))
        history = list(incoming.get("history") or current.get("history") or [])
        if old_base and old_base != new_base:
            history.insert(0, {
                "base": current.get("base", ""), "currency": current.get("currency", ""),
                "payBasis": current.get("payBasis", ""), "effectiveDate": current.get("effectiveDate", ""),
                "changedAt": datetime.now(timezone.utc).isoformat(), "changedBy": user["email"],
            })
        incoming["history"] = history
        row.compensation = incoming
    if body.bank is not None:
        row.bank = body.bank
    row.updated_at = datetime.now(timezone.utc).isoformat()
    sync_rate_from_comp(db, row)   # keep the timecard pay rate in step with this record
    db.commit()
    return {"compensation": row.compensation or {}, "bank": row.bank or []}


# ---------------------------------------------------------------------------
# HR Section B5 - Assets tab: LIVE read from Item Management (no duplication).
# HR-gated so an HR user without an inventory grant can still see what a person
# holds. Source of truth stays in items.py; this only reads.
# ---------------------------------------------------------------------------
from sqlalchemy import func
from models import Item, ItemCheckout


@router.get("/employees/{eid}/assets")
def employee_assets(eid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
    if not emp:
        raise HTTPException(404, "Employee not found")
    email = (emp.work_email or "").strip().lower()
    if not email:
        return {"assignments": [], "checkouts": []}
    assignments = db.query(Item).filter(
        func.lower(Item.assigned_to_email) == email, Item.deleted_at == ""
    ).all()
    checkouts = db.query(ItemCheckout).filter(
        func.lower(ItemCheckout.requested_by_email) == email,
        ItemCheckout.status.in_(["allocated", "pending_receipt"]),
    ).all()
    return {
        "assignments": [{
            "id": i.id, "name": i.name, "serial": i.serial_number, "type": i.item_type,
            "status": i.status, "assignedAt": i.assigned_at, "photoUrl": i.photo_url,
        } for i in assignments],
        "checkouts": [{
            "id": c.id, "itemName": c.item_name, "itemType": c.item_type, "status": c.status,
            "days": c.days, "allocatedAt": c.allocated_at, "handedOverAt": c.handed_over_at,
        } for c in checkouts],
    }


# ---------------------------------------------------------------------------
# HR Section: Work Logs (Beginning/End-of-day) on the People profile. HR-gated
# so an HR user can see it without a Time-module grant. Source of truth stays
# in timeclock.py (TimeBod/TimePunch); this only reads.
# ---------------------------------------------------------------------------
from models import TimeBod, TimePunch
from datetime import timedelta


@router.get("/employees/{eid}/bod")
def employee_bod_log(eid: str, start: str = "", end: str = "",
                     user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    """Defaults to the trailing 7 days (today inclusive); pass start/end
    (YYYY-MM-DD) to page back through older history."""
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
    if not emp:
        raise HTTPException(404, "Employee not found")
    email = (emp.work_email or "").strip().lower()
    if not email:
        return {"start": start, "end": end, "logs": []}
    today = datetime.now(timezone.utc).date()
    end_d = end or today.strftime("%Y-%m-%d")
    start_d = start or (today - timedelta(days=6)).strftime("%Y-%m-%d")
    rows = (db.query(TimeBod)
            .filter(TimeBod.employee_email == email, TimeBod.kind.in_(("bod", "eod")),
                    TimeBod.message != "(sent outside Nexus)",
                    TimeBod.local_date >= start_d, TimeBod.local_date <= end_d)
            .order_by(TimeBod.created_at.desc()).limit(200).all())

    # The actual clock-in/out time (from TimePunch, the punch of record) beside
    # each BOD/EOD post - "in" backs a BOD, "out" backs an EOD. A day can hold
    # more than one of each (corrections, multiple sessions): the first in-punch
    # and the last out-punch are the ones that bracket the work day.
    dates = sorted({r.local_date for r in rows})
    punch_in_at, punch_out_at = {}, {}
    if dates:
        punches = (db.query(TimePunch)
                   .filter(TimePunch.employee_email == email, TimePunch.local_date.in_(dates),
                           TimePunch.voided == 0, TimePunch.kind.in_(("in", "out")))
                   .order_by(TimePunch.at.asc()).all())
        for p in punches:
            if p.kind == "in" and p.local_date not in punch_in_at:
                punch_in_at[p.local_date] = p.at
            elif p.kind == "out":
                punch_out_at[p.local_date] = p.at   # keep overwriting - last one wins

    return {"start": start_d, "end": end_d, "logs": [{
        "id": r.id, "kind": r.kind, "date": r.local_date,
        "message": r.message or "", "tasks": r.tasks or "", "at": r.created_at,
        "punchAt": (punch_in_at if r.kind == "bod" else punch_out_at).get(r.local_date, ""),
    } for r in rows]}


# ---------------------------------------------------------------------------
# HR Section B6 - inline status change with reason + effective date (audited)
# ---------------------------------------------------------------------------
class StatusChangeIn(BaseModel):
    status:        str
    reason:        Optional[str] = ""
    effectiveDate: Optional[str] = ""
    # Offboarding decisions captured on the status change (inactive/offboarded).
    # Nexus records the intent; the mailbox-permission / shared-conversion steps
    # themselves are done in the Exchange admin center (Graph has no coverage).
    #   {mailboxAction: 'delegate'|'share'|'remove'|'',
    #    delegateTo: ['a@x.com', …], exportRequested: bool, freeUpLicense: bool,
    #    handoverTo: 'b@x.com', handoverIncludeCompleted: bool}
    offboarding:   Optional[dict] = None


def _graph_set_signin(token: str, m365_id: str, enabled: bool) -> None:
    resp = httpx.patch(f"{_GRAPH}/users/{m365_id}",
                       headers={"Authorization": f"Bearer {token}"},
                       json={"accountEnabled": enabled}, timeout=20)
    if not resp.is_success:
        raise RuntimeError(f"sign-in toggle failed: {resp.text[:200]}")


def _graph_remove_all_licenses(token: str, m365_id: str) -> str:
    """Release the person's licenses back to the pool. Only DIRECTLY-assigned
    licenses can be removed per-user; a license that arrives via group
    membership (assignedByGroup) is refused by Graph's assignLicense and must
    be removed by taking the person out of the licensing group. We remove what
    we can and report the group-assigned ones clearly rather than erroring, so
    the toast tells the admin exactly what's left to do."""
    hdr = {"Authorization": f"Bearer {token}"}
    resp = httpx.get(f"{_GRAPH}/users/{m365_id}?$select=licenseAssignmentStates",
                     headers=hdr, timeout=20)
    if not resp.is_success:
        raise RuntimeError(f"license lookup failed: {resp.text[:200]}")
    states = resp.json().get("licenseAssignmentStates", []) or []
    direct = sorted({s["skuId"] for s in states if s.get("skuId") and not s.get("assignedByGroup")})
    group  = sorted({s["skuId"] for s in states if s.get("skuId") and s.get("assignedByGroup")})
    removed = 0
    if direct:
        up = httpx.post(f"{_GRAPH}/users/{m365_id}/assignLicense", headers=hdr,
                        json={"addLicenses": [], "removeLicenses": direct}, timeout=30)
        if not up.is_success:
            raise RuntimeError(f"license removal failed: {up.text[:200]}")
        removed = len(direct)
    if group:
        return (f"{removed} released" if removed else "0 released") + \
               f" · {len(group)} assigned via a group - remove them from the licensing group in M365"
    return f"{removed} released" if removed else "none to release"


@router.post("/employees/{eid}/status")
def change_status(eid: str, body: StatusChangeIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    row = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
    if not row:
        raise HTTPException(404, "Employee not found")
    if body.status not in _STATUSES:
        raise HTTPException(400, f"status must be one of {_STATUSES}")
    now = datetime.now(timezone.utc).isoformat()
    did_change = body.status != row.status
    log = list(row.status_log or [])
    entry = None
    # Normalise the offboarding block independently of the status change so the
    # M365 actions can be (re-)run on someone already inactive/left - e.g. to
    # free a license that didn't release the first time.
    off = body.offboarding or {}
    off_block = None
    if (off.get("mailboxAction") or off.get("delegateTo") or off.get("exportRequested")
            or off.get("freeUpLicense") or off.get("handoverTo")):
        off_block = {
            "mailboxAction":   (off.get("mailboxAction") or "").strip(),
            "delegateTo":      [e.strip().lower() for e in (off.get("delegateTo") or []) if e and e.strip()],
            "exportRequested": bool(off.get("exportRequested")),
            "freeUpLicense":   bool(off.get("freeUpLicense")),
            # Who inherits the person's task work, and whether their finished
            # tasks come along. Recorded on the log entry as the audit trail for
            # a bulk reassignment nobody gets a notification about.
            "handoverTo":      (off.get("handoverTo") or "").strip().lower(),
            "handoverIncludeCompleted": bool(off.get("handoverIncludeCompleted")),
            "done":            False,   # flips true once an admin completes the M365 steps
        }
    if did_change:
        entry = {
            "from": row.status, "to": body.status, "reason": (body.reason or "").strip(),
            "effectiveDate": (body.effectiveDate or "").strip(), "by": user["email"], "at": now,
        }
        if off_block:
            entry["offboarding"] = off_block
        log.insert(0, entry)
    # Offboarding (-> Left) force-returns everything the person still holds in Item
    # Management. Items owns the transition; we stamp the counts on the log entry.
    items_returned = None
    handover = None
    if did_change and body.status == "offboarded" and row.work_email:
        from routers.items import force_return_person
        items_returned = force_return_person(db, row.work_email, user["email"])
        if entry is not None and (items_returned["checkouts"] or items_returned["assignments"]):
            entry["itemsReturned"] = items_returned
        # Task work moves at the same moment equipment does, in this same
        # session, so a half-completed offboarding can't leave tasks assigned to
        # someone who no longer exists.
        if off_block and off_block.get("handoverTo"):
            from routers.task_projects import handover_person
            handover = handover_person(db, row.work_email, off_block["handoverTo"],
                                       include_completed=off_block["handoverIncludeCompleted"],
                                       actor=user["email"])
            if entry is not None and (handover["reassigned"] or handover["projectsTransferred"]):
                entry["taskHandover"] = handover
    row.status = body.status
    row.status_log = log
    row.updated_at = now
    db.commit()
    db.refresh(row)

    # Perform the M365 actions Graph *can* do. Mailbox delegation / shared-mailbox
    # conversion are NOT here - Graph has no coverage (Exchange PowerShell only);
    # the UI surfaces those as guided admin-center steps.
    m365 = None
    # Run the mailbox/license actions whenever an offboarding block is present
    # and the person is inactive/left - not only on the transition - so an admin
    # can re-open a Left employee and (re-)free their license.
    if row.m365_id and off_block and body.status in ("inactive", "offboarded"):
        m365 = {}
        try:
            token = _graph_token()
            if off_block["mailboxAction"] in ("remove", "share"):
                _graph_set_signin(token, row.m365_id, False)
                m365["signIn"] = "blocked"
            if off_block.get("freeUpLicense"):
                m365["licenses"] = _graph_remove_all_licenses(token, row.m365_id)
            if off_block.get("exportRequested"):
                job = HrMailboxExport(id=str(uuid.uuid4()), employee_id=row.id, requested_by=user["email"],
                                      status="pending", created_at=now, updated_at=now)
                db.add(job); db.commit()
                threading.Thread(target=_run_mailbox_export, args=(job.id, row.m365_id), daemon=True).start()
                m365["export"] = job.id
        except Exception as e:
            m365["error"] = str(getattr(e, "detail", e))[:200]
    elif not row.m365_id and off_block and body.status in ("inactive", "offboarded"):
        m365 = {"error": "No linked M365 account - nothing to block or free."}
    elif did_change and row.m365_id and body.status in ("active", "onboarding"):
        # Coming back from inactive/left - restore sign-in (best-effort).
        try:
            _graph_set_signin(_graph_token(), row.m365_id, True)
            m365 = {"signIn": "re-enabled"}
        except Exception:
            pass

    return {**_serialize(row), "m365": m365, "items": items_returned, "handover": handover}


# ---------------------------------------------------------------------------
# Mailbox export - zip every message (.eml) from a person's Entra mailbox.
# Needs the tenant-wide Mail.Read application permission (admin consent); without
# it Graph returns 401/403 and the job is marked with a clear message. Runs in a
# background thread so a large mailbox doesn't block the request.
# ---------------------------------------------------------------------------
import threading
import tempfile
import zipfile
from database import SessionLocal
from models import HrMailboxExport

_EXPORT_BUCKET  = _DOC_BUCKET       # private hr-docs bucket, signed-URL download
_EXPORT_MSG_CAP = 20000             # safety ceiling for very large mailboxes


def _ser_export(j: HrMailboxExport) -> dict:
    return {
        "id": j.id, "employeeId": j.employee_id, "status": j.status, "message": j.message,
        "count": j.count, "total": j.total, "hasFile": bool(j.storage_path),
        "createdAt": j.created_at, "updatedAt": j.updated_at,
    }


def _clean_part(s: str, n: int) -> str:
    """Filesystem-safe but human-readable: keep spaces, drop only illegal chars."""
    s = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", s or "")
    s = re.sub(r"\s+", " ", s).strip()
    return s[:n].strip()


def _export_filename(m: dict, used: set) -> str:
    """`<date> - <sender> - <subject>.eml`, deduped. Uses the sender's display
    name (falls back to their address, then to the first recipient for sent mail)."""
    ts = (m.get("receivedDateTime") or "")[:10] or "nodate"
    frm = ((m.get("from") or {}).get("emailAddress")) or {}
    who = frm.get("name") or frm.get("address")
    if not who:
        rcpts = m.get("toRecipients") or []
        first = (rcpts[0].get("emailAddress") if rcpts else {}) or {}
        who = ("to " + (first.get("name") or first.get("address"))) if (first.get("name") or first.get("address")) else "unknown"
    who = _clean_part(who, 40) or "unknown"
    subj = _clean_part(m.get("subject") or "no subject", 70) or "no subject"
    base = f"{ts} - {who} - {subj}"
    name = f"{base}.eml"
    i = 2
    while name in used:
        name = f"{base} ({i}).eml"
        i += 1
    used.add(name)
    return name


def _run_mailbox_export(job_id: str, m365_id: str) -> None:
    db = SessionLocal()
    tmp_path = None
    try:
        job = db.query(HrMailboxExport).filter(HrMailboxExport.id == job_id).first()
        if not job:
            return
        job.status = "running"; job.updated_at = datetime.now(timezone.utc).isoformat(); db.commit()
        headers = {"Authorization": f"Bearer {_graph_token()}"}
        # Total up front so the UI can show a real progress bar (best-effort - a
        # 401/403 here means Mail.Read isn't consented; the message loop reports it).
        try:
            cr = httpx.get(f"{_GRAPH}/users/{m365_id}/messages/$count",
                           headers={**headers, "ConsistencyLevel": "eventual"}, timeout=30)
            if cr.is_success and cr.text.strip().isdigit():
                job.total = min(int(cr.text.strip()), _EXPORT_MSG_CAP)
                job.updated_at = datetime.now(timezone.utc).isoformat(); db.commit()
        except Exception:
            pass
        tf = tempfile.NamedTemporaryFile(suffix=".zip", delete=False); tf.close(); tmp_path = tf.name
        count = 0
        used = set()   # keep zip entry names unique + readable
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            url = f"{_GRAPH}/users/{m365_id}/messages?$select=id,subject,receivedDateTime,from,toRecipients&$top=100"
            while url and count < _EXPORT_MSG_CAP:
                r = httpx.get(url, headers=headers, timeout=60)
                if r.status_code in (401, 403):
                    raise RuntimeError("Graph denied mailbox read - grant the Mail.Read application permission and admin consent.")
                if not r.is_success:
                    raise RuntimeError(f"Graph error: {r.text[:200]}")
                data = r.json()
                for m in data.get("value", []):
                    mid = m.get("id")
                    if not mid:
                        continue
                    mime = httpx.get(f"{_GRAPH}/users/{m365_id}/messages/{mid}/$value", headers=headers, timeout=60)
                    if not mime.is_success:
                        continue
                    zf.writestr(_export_filename(m, used), mime.content)
                    count += 1
                    # Publish progress every 25 messages so pollers see live movement.
                    if count % 25 == 0:
                        job.count = count; job.updated_at = datetime.now(timezone.utc).isoformat(); db.commit()
                    if count >= _EXPORT_MSG_CAP:
                        break
                url = data.get("@odata.nextLink")
        with open(tmp_path, "rb") as fh:
            content = fh.read()
        path = f"exports/{job.employee_id}/{job_id}.zip"
        up = httpx.post(
            f"{_SUPABASE_URL}/storage/v1/object/{_EXPORT_BUCKET}/{path}",
            headers={**_storage_headers(), "Content-Type": "application/zip", "x-upsert": "true"},
            content=content, timeout=300,
        )
        if not up.is_success:
            raise RuntimeError(f"Upload failed: {up.text[:200]}")
        job.storage_path = path; job.count = count; job.status = "done"
        job.message = f"{count} message{'s' if count != 1 else ''} exported"
        job.updated_at = datetime.now(timezone.utc).isoformat(); db.commit()
    except Exception as e:
        try:
            job = db.query(HrMailboxExport).filter(HrMailboxExport.id == job_id).first()
            if job:
                job.status = "error"; job.message = str(e)[:300]
                job.updated_at = datetime.now(timezone.utc).isoformat(); db.commit()
        except Exception:
            pass
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
        db.close()


@router.post("/employees/{eid}/mailbox-export")
def start_mailbox_export(eid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
    if not emp:
        raise HTTPException(404, "Employee not found")
    if not emp.m365_id:
        raise HTTPException(400, "No linked M365 account to export from")
    now = datetime.now(timezone.utc).isoformat()
    job = HrMailboxExport(id=str(uuid.uuid4()), employee_id=eid, requested_by=user["email"],
                          status="pending", created_at=now, updated_at=now)
    db.add(job); db.commit(); db.refresh(job)
    threading.Thread(target=_run_mailbox_export, args=(job.id, emp.m365_id), daemon=True).start()
    return _ser_export(job)


@router.get("/employees/{eid}/mailbox-export")
def latest_mailbox_export(eid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    job = (db.query(HrMailboxExport).filter(HrMailboxExport.employee_id == eid)
           .order_by(HrMailboxExport.created_at.desc()).first())
    return _ser_export(job) if job else None


@router.get("/mailbox-exports/{job_id}")
def mailbox_export_status(job_id: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    job = db.query(HrMailboxExport).filter(HrMailboxExport.id == job_id).first()
    if not job:
        raise HTTPException(404, "Export not found")
    return _ser_export(job)


@router.get("/mailbox-exports/{job_id}/url")
def mailbox_export_url(job_id: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    job = db.query(HrMailboxExport).filter(HrMailboxExport.id == job_id).first()
    if not job or not job.storage_path:
        raise HTTPException(404, "No export file yet")
    resp = httpx.post(
        f"{_SUPABASE_URL}/storage/v1/object/sign/{_EXPORT_BUCKET}/{job.storage_path}",
        headers=_storage_headers(), json={"expiresIn": 300}, timeout=15,
    )
    if not resp.is_success:
        raise HTTPException(502, f"Could not sign URL: {resp.text[:200]}")
    return {"url": f"{_SUPABASE_URL}/storage/v1{resp.json()['signedURL']}", "expiresIn": 300}
