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


def _hr_notify(db: Session, recipient: str, title: str, body: str, ref_id: str = "", requested_by: str = "") -> None:
    """Server-side bell notification (items.py pattern). Empty recipient = noop —
    HR events must always target a person, never broadcast to all managers."""
    if not (recipient or "").strip():
        return
    db.add(NexusNotification(
        id=str(uuid.uuid4()), type="custom_alert", recipient=recipient.strip().lower(),
        title=title, body=body, ref_id=ref_id, item_name="", requested_by=requested_by,
        action="", actioned=False, read_by="", created_at=datetime.now(timezone.utc).isoformat(),
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

        # One notification per stage move, to the candidate's owner (unless
        # they made the move themselves) — mirrors the items.py convention
        if row.created_by and row.created_by.lower() != user["email"].lower():
            cand_name = f"{row.first_name} {row.last_name}".strip()
            _hr_notify(db, row.created_by,
                       f"Candidate {('hired' if body.stage == 'hired' else ('rejected' if body.stage == 'rejected' else 'moved'))}: {cand_name}",
                       f"{cand_name} ({row.role_title or row.department or 'candidate'}) is now in {body.stage.replace('_', ' ')}."
                       + (f"\nNote: {body.stage_note.strip()}" if (body.stage_note or '').strip() else ''),
                       ref_id=row.id, requested_by=user["email"])

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


# ── Employee documents (Phase 3) — PRIVATE bucket, signed URLs only ──────────

import os
import secrets
import httpx
from fastapi import UploadFile, File, Form
from models import HrDocument, HrProvisionRun, HrProvisionStep

_SUPABASE_URL         = os.getenv("SUPABASE_URL", "")
_SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
_DOC_BUCKET    = "hr-docs"
_DOC_KINDS     = ("resume", "id", "contract", "certificate", "other")
_MAX_DOC_BYTES = 15 * 1024 * 1024


def _storage_headers():
    if not (_SUPABASE_URL and _SUPABASE_SERVICE_KEY):
        raise HTTPException(503, "Storage not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY")
    return {"Authorization": f"Bearer {_SUPABASE_SERVICE_KEY}", "apikey": _SUPABASE_SERVICE_KEY}


def _ser_doc(d: HrDocument) -> dict:
    return {"id": d.id, "employeeId": d.employee_id, "kind": d.kind, "fileName": d.file_name,
            "sizeBytes": d.size_bytes, "expiresOn": d.expires_on, "uploadedBy": d.uploaded_by,
            "createdAt": d.created_at}


@router.get("/employees/{eid}/documents")
def list_documents(eid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    rows = (db.query(HrDocument).filter(HrDocument.employee_id == eid)
            .order_by(HrDocument.created_at.desc()).all())
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
    """Mint a short-lived signed URL — the bucket itself is private."""
    row = db.query(HrDocument).filter(HrDocument.id == did).first()
    if not row:
        raise HTTPException(404, "Document not found")
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
    httpx.request("DELETE", f"{_SUPABASE_URL}/storage/v1/object/{_DOC_BUCKET}/{row.storage_path}",
                  headers=_storage_headers(), timeout=30)
    db.delete(row)
    db.commit()
    return {"ok": True}


# ── Provisioning engine (Phase 4): one click -> M365 account ─────────────────

_AZ_TENANT = os.getenv("AZURE_TENANT_ID", "")
_AZ_CLIENT = os.getenv("AZURE_CLIENT_ID", "")
_AZ_SECRET = os.getenv("AZURE_CLIENT_SECRET", "")
_GRAPH = "https://graph.microsoft.com/v1.0"


def _graph_token() -> str:
    if not all([_AZ_TENANT, _AZ_CLIENT, _AZ_SECRET]):
        raise HTTPException(503, "Provisioning not configured — set AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET")
    resp = httpx.post(
        f"https://login.microsoftonline.com/{_AZ_TENANT}/oauth2/v2.0/token",
        data={"grant_type": "client_credentials", "client_id": _AZ_CLIENT,
              "client_secret": _AZ_SECRET, "scope": "https://graph.microsoft.com/.default"},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


# Graph only returns internal SKU part numbers — map the ones in our tenant to
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
    # Default first, then named products, then the rest — all alphabetical
    out.sort(key=lambda s: (not s["isDefault"], s["skuPartNumber"] not in _SKU_NAMES, s["displayName"].lower()))
    return out


from typing import List


class ProvisionIn(BaseModel):
    work_email:      str
    license_sku_id:  Optional[str] = ""          # legacy single-select
    license_sku_ids: Optional[List[str]] = None  # multi-select (admin-center style)
    usage_location:  Optional[str] = "US"        # ISO 3166 alpha-2 — license compliance keys off this


@router.post("/employees/{eid}/provision")
def provision_employee(eid: str, body: ProvisionIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
    if not emp:
        raise HTTPException(404, "Employee not found")
    if emp.m365_id:
        raise HTTPException(400, "Employee already has an M365 account — provisioning is one-time")
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
            "jobTitle": emp.job_title or None,
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

    # 2) Licenses — one assignLicense call for the whole set (a mailbox-bearing
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
                steps["m365_license"].detail = f"{len(sku_ids)} license{'s' if len(sku_ids) != 1 else ''} assigned — mailbox provisioning"
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

    # 4/5) Asana + Ignite — manual until tier/API access is confirmed
    steps["asana"].status = "manual"
    steps["asana"].detail = "Invite to the Asana workspace by email"
    steps["ignite"].status = "manual"
    steps["ignite"].detail = "Create the Ignite account per role template"

    # 6) Welcome notification to the personal email (no password in the mail —
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


# ── Profile photos — public-read avatars bucket, WRITES ONLY via this endpoint
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


@router.post("/employees/sync-m365")
def sync_m365(user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Link existing M365 accounts to employee records by work email, and
    backfill empty profile fields (phone/title/office) from Entra. Never
    overwrites values already set in Nexus."""
    token = _graph_token()
    rows = db.query(NexusEmployee).filter(NexusEmployee.work_email != "").all()
    linked = updated = missing = 0
    for emp in rows:
        resp = httpx.get(
            f"{_GRAPH}/users/{emp.work_email}?$select=id,jobTitle,department,mobilePhone,officeLocation",
            headers={"Authorization": f"Bearer {token}"}, timeout=20,
        )
        if not resp.is_success:
            missing += 1
            continue
        g = resp.json()
        changed = False
        if not emp.m365_id and g.get("id"):
            emp.m365_id = g["id"]; linked += 1; changed = True
        for local, remote in (("phone", "mobilePhone"), ("job_title", "jobTitle"), ("location", "officeLocation")):
            if not getattr(emp, local) and (g.get(remote) or "").strip():
                setattr(emp, local, g[remote].strip()); changed = True
        if changed:
            emp.updated_at = datetime.now(timezone.utc).isoformat()
            updated += 1
    db.commit()
    return {"linked": linked, "updated": updated, "notInTenant": missing, "checked": len(rows)}


# ── Welcome email — branded, warm, role-aware (not the old two-liner) ────────

def _welcome_html(emp: NexusEmployee, upn: str) -> str:
    from html import escape
    first = escape(emp.first_name)
    role_line = " · ".join(x for x in (emp.job_title, emp.department) if x)
    detail_rows = "".join(
        f"<tr><td style='padding:7px 0;font-size:12px;color:#6b7280;width:140px;text-transform:uppercase;letter-spacing:.05em;font-weight:700'>{label}</td>"
        f"<td style='padding:7px 0;font-size:14px;color:#111827;font-weight:600'>{escape(value)}</td></tr>"
        for label, value in (
            ("Your name", f"{emp.first_name} {emp.last_name}".strip()),
            ("Role", role_line or "—"),
            ("Work email", upn),
            ("Start date", emp.start_date or "We'll confirm shortly"),
            ("Location", emp.location or ""),
        ) if value
    )
    return f"""<div style="background:#f4f5f7;padding:32px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;border:1px solid #e5e7eb;border-collapse:separate;overflow:hidden">
    <tr>
      <td style="background:#0f3d2e;padding:34px 36px 30px;text-align:center">
        <div style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:6px">NEXUS</div>
        <div style="color:#9fd6b8;font-size:11px;letter-spacing:2px;margin-top:4px">GREENS GLOBAL</div>
        <div style="color:#ffffff;font-size:26px;font-weight:800;margin-top:22px;line-height:1.3">Welcome aboard, {first}! 🎉</div>
        <div style="color:#cde9d9;font-size:14px;margin-top:8px">We're genuinely glad you're here.</div>
      </td>
    </tr>
    <tr>
      <td style="padding:30px 36px 6px">
        <p style="margin:0 0 14px;font-size:14.5px;line-height:1.7;color:#1f2937">
          On behalf of everyone at <strong>Greens Global</strong> — welcome to the team{f" as our new <strong>{escape(emp.job_title)}</strong>" if emp.job_title else ""}!
          We've been looking forward to this, and your tools are already set up and waiting for you.
        </p>
        <p style="margin:0 0 18px;font-size:14.5px;line-height:1.7;color:#1f2937">
          Your company account gives you email, Teams, and the Greens&nbsp;Nexus portal — the home for
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
          <tr><td style="padding:6px 0;font-size:14px;line-height:1.65;color:#1f2937"><strong>2.</strong>&nbsp; Use the temporary password HR shares with you directly — you'll be asked to set your own right away. (We never email passwords.)</td></tr>
          <tr><td style="padding:6px 0;font-size:14px;line-height:1.65;color:#1f2937"><strong>3.</strong>&nbsp; Open <strong>Outlook</strong> for email and <strong>Teams</strong> to say hi — your team is expecting you.</td></tr>
          <tr><td style="padding:6px 0;font-size:14px;line-height:1.65;color:#1f2937"><strong>4.</strong>&nbsp; Keep an eye on your inbox — your manager will reach out with your first-week plan, and anything you need (laptop, tools, access) gets arranged through Greens&nbsp;Nexus.</td></tr>
        </table>
        <p style="margin:18px 0 6px;font-size:14.5px;line-height:1.7;color:#1f2937">
          Questions before your first day? Just reply to HR or reach out to your manager — there's no such
          thing as a silly question in week one.
        </p>
        <p style="margin:14px 0 24px;font-size:14.5px;line-height:1.7;color:#1f2937">
          We can't wait to see what you'll do here. Once again — <strong>welcome to Greens Global!</strong><br>
          <span style="color:#6b7280">— The Greens Global Team</span>
        </p>
      </td>
    </tr>
    <tr>
      <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 36px;font-size:11.5px;color:#6b7280;line-height:1.5">
        Sent via Greens Nexus. This mailbox isn't monitored — for help, contact HR or your manager directly.
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
            "subject": f"Welcome to Greens Global, {emp.first_name} — we're glad you're here!",
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
        raise HTTPException(400, "Employee has no work email yet — provision first")
    if not emp.personal_email:
        raise HTTPException(400, "Employee has no personal email on file")
    ok, detail = _send_welcome(emp, emp.work_email, _graph_token())
    if not ok:
        raise HTTPException(502, f"Send failed: {detail}")
    return {"ok": True, "sentTo": emp.personal_email}
