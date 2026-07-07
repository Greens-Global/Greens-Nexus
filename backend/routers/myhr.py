"""My HR — employee self-service (baseline: every signed-in employee).

Shows ONLY the caller's own record. The HR module stays the admin console for
the HR team; this router is the scoped-to-self counterpart:
  - my profile (safe fields — never compensation/bank/notes/status_log)
  - self-service edits to contact + emergency-contact fields
  - my signed documents (sealed e-sign PDFs where I was a party)
Leave (time off) reuses the existing /timeclock/timeoff endpoints.
"""
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from database import get_db
from auth import get_current_user
from models import NexusEmployee, HrSignRequest, HrSignParty, HrDocument
from routers.hr import _SUPABASE_URL, _storage_headers, _DOC_BUCKET
from routers.esign import _log

router = APIRouter(prefix="/myhr", tags=["My HR"], dependencies=[Depends(get_current_user)])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _me(db: Session, email: str) -> NexusEmployee:
    row = (db.query(NexusEmployee)
           .filter(func.lower(NexusEmployee.work_email) == email.lower()).first())
    if not row:
        raise HTTPException(404, "No HR record is linked to your account yet — ask HR to add you.")
    return row


def _profile_dict(e: NexusEmployee, db: Session) -> dict:
    """Own-record view: everything about *me* except restricted HR-side data."""
    manager = None
    if e.manager_email:
        m = (db.query(NexusEmployee)
             .filter(func.lower(NexusEmployee.work_email) == e.manager_email.lower()).first())
        if m:
            manager = f"{m.first_name} {m.last_name}".strip()
    personal = dict(e.personal or {})
    personal.pop("nationalId", None)          # masked IDs stay HR-side
    return {
        "employeeCode": e.employee_code, "firstName": e.first_name, "lastName": e.last_name,
        "workEmail": e.work_email, "personalEmail": e.personal_email, "phone": e.phone,
        "jobTitle": e.job_title, "department": e.department, "employmentType": e.employment_type,
        "startDate": e.start_date, "manager": manager or "", "photoUrl": e.photo_url,
        "location": e.location, "status": e.status, "personal": personal,
    }


@router.get("/profile")
def my_profile(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _profile_dict(_me(db, user["email"]), db)


class ProfileIn(BaseModel):
    personal_email: Optional[str] = None
    phone: Optional[str] = None
    emergency_name: Optional[str] = None
    emergency_relationship: Optional[str] = None
    emergency_phone: Optional[str] = None


@router.put("/profile")
def save_profile(body: ProfileIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Self-service subset only: contact details + emergency contact. Anything
    else (name, job, department, bank, …) goes through HR."""
    e = _me(db, user["email"])
    if body.personal_email is not None:
        e.personal_email = body.personal_email.strip()[:200]
    if body.phone is not None:
        e.phone = body.phone.strip()[:50]
    if any(v is not None for v in (body.emergency_name, body.emergency_relationship, body.emergency_phone)):
        personal = dict(e.personal or {})
        emergency = dict(personal.get("emergency") or {})
        if body.emergency_name is not None:
            emergency["name"] = body.emergency_name.strip()[:120]
        if body.emergency_relationship is not None:
            emergency["relationship"] = body.emergency_relationship.strip()[:60]
        if body.emergency_phone is not None:
            emergency["phone"] = body.emergency_phone.strip()[:50]
        personal["emergency"] = emergency
        e.personal = personal
    e.updated_at = _now()
    db.commit()
    return _profile_dict(e, db)


# ── My documents — sealed e-sign PDFs where I was a party ─────────────────────

@router.get("/documents")
def my_documents(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = user["email"].lower()
    parties = db.query(HrSignParty).filter(HrSignParty.email == email).all()
    out, seen = [], set()
    for p in parties:
        if p.request_id in seen:
            continue
        seen.add(p.request_id)
        req = db.query(HrSignRequest).filter(HrSignRequest.id == p.request_id).first()
        if not req or req.status != "completed" or not req.final_pdf_path:
            continue
        out.append({"requestId": req.id, "title": req.title, "from": req.created_by,
                    "completedAt": req.completed_at, "signedByMe": p.status == "signed"})
    return sorted(out, key=lambda x: x["completedAt"] or "", reverse=True)


# ── My paystubs — comp documents HR uploaded for me (kind="paystub") ─────────

@router.get("/paystubs")
def my_paystubs(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    e = _me(db, user["email"])
    rows = (db.query(HrDocument)
            .filter(HrDocument.employee_id == e.id, HrDocument.kind == "paystub")
            .order_by(HrDocument.created_at.desc()).all())
    return [{"id": d.id, "name": d.file_name, "createdAt": d.created_at} for d in rows]


@router.get("/paystubs/{did}/download")
def download_my_paystub(did: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    e = _me(db, user["email"])
    row = (db.query(HrDocument)
           .filter(HrDocument.id == did, HrDocument.employee_id == e.id,
                   HrDocument.kind == "paystub").first())
    if not row:
        raise HTTPException(404, "Paystub not found")
    resp = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/sign/{_DOC_BUCKET}/{row.storage_path}",
                      headers=_storage_headers(), json={"expiresIn": 300}, timeout=20)
    if not resp.is_success:
        raise HTTPException(502, "Could not create download link")
    return {"url": f"{_SUPABASE_URL}/storage/v1{resp.json()['signedURL']}", "expiresIn": 300}


@router.get("/documents/{rid}/download")
def download_my_document(rid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Party-scoped download: you get the sealed PDF only for envelopes you were
    part of — no hr grant needed (it's your own document)."""
    email = user["email"].lower()
    party = (db.query(HrSignParty)
             .filter(HrSignParty.request_id == rid, HrSignParty.email == email).first())
    if not party:
        raise HTTPException(403, "This document isn't yours")
    req = db.query(HrSignRequest).filter(HrSignRequest.id == rid).first()
    if not req or req.status != "completed" or not req.final_pdf_path:
        raise HTTPException(404, "No completed document")
    resp = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/sign/{_DOC_BUCKET}/{req.final_pdf_path}",
                      headers=_storage_headers(), json={"expiresIn": 300}, timeout=20)
    if not resp.is_success:
        raise HTTPException(502, "Could not create download link")
    _log(db, rid, "downloaded", f"by {user['email']} (self-service)")
    db.commit()
    return {"url": f"{_SUPABASE_URL}/storage/v1{resp.json()['signedURL']}", "expiresIn": 300}
