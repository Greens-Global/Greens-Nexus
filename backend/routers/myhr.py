"""My HR - employee self-service (baseline: every signed-in employee).

Shows ONLY the caller's own record. The HR module stays the admin console for
the HR team; this router is the scoped-to-self counterpart:
  - my profile (safe fields - never compensation/bank/notes/status_log)
  - self-service edits to contact + emergency-contact fields
  - my signed documents (sealed e-sign PDFs where I was a party)
Leave (time off) reuses the existing /timeclock/timeoff endpoints.
"""
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from database import get_db
from auth import get_current_user
from models import (NexusEmployee, HrEntity, HrSignRequest, HrSignParty, HrDocument,
                    HrSelfRequest, ItemAssignment, ItemCheckout,
                    NexusGroup, NexusGroupMember, NexusNotification)
from routers.hr import (_SUPABASE_URL, _storage_headers, _DOC_BUCKET,
                        _AVATAR_BUCKET, _IMAGE_TYPES, _MAX_AVATAR_BYTES)
from routers.esign import _log

router = APIRouter(prefix="/myhr", tags=["My HR"], dependencies=[Depends(get_current_user)])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _me(db: Session, email: str) -> NexusEmployee:
    row = (db.query(NexusEmployee)
           .filter(func.lower(NexusEmployee.work_email) == email.lower()).first())
    if not row:
        raise HTTPException(404, "No HR record is linked to your account yet - ask HR to add you.")
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


# ── My profile photo - every employee can add/change/remove their own,
#    without the "hr" Access Group grant hr.py's admin upload_photo needs
#    (Neil: "My Profile" in the header dropdown was a dead button - no
#    self-service path to a photo existed at all). ─────────────────────────

@router.post("/profile/photo")
async def upload_my_photo(file: UploadFile = File(...),
                          user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    e = _me(db, user["email"])
    ext = _IMAGE_TYPES.get(file.content_type or "")
    if not ext:
        raise HTTPException(400, "Photo must be JPEG, PNG, WebP or GIF")
    data = await file.read()
    if len(data) > _MAX_AVATAR_BYTES:
        raise HTTPException(400, "Photo must be under 5 MB")
    path = f"{e.id}/{uuid.uuid4()}.{ext}"
    resp = httpx.post(
        f"{_SUPABASE_URL}/storage/v1/object/{_AVATAR_BUCKET}/{path}",
        headers={**_storage_headers(), "Content-Type": file.content_type,
                 "cache-control": "max-age=31536000"},
        content=data, timeout=60,
    )
    if not resp.is_success:
        raise HTTPException(502, f"Storage upload failed: {resp.text[:200]}")
    e.photo_url = f"{_SUPABASE_URL}/storage/v1/object/public/{_AVATAR_BUCKET}/{path}"
    e.updated_at = _now()
    db.commit()
    return _profile_dict(e, db)


@router.delete("/profile/photo")
def remove_my_photo(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    e = _me(db, user["email"])
    e.photo_url = ""
    e.updated_at = _now()
    db.commit()
    return _profile_dict(e, db)


# ── My documents - sealed e-sign PDFs where I was a party ─────────────────────

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


# ── Directory card (hover profiles) - safe subset, any signed-in user ────────

def _person_name(e) -> str:
    """How a person is named across the app. Prefers the Entra/Teams
    displayName, which is what colleagues recognize - first+last silently drops
    middle names, so "Sagar Kumar Shoundik" in Teams read as "Sagar Shoundik"
    here. Empty until an M365 sync has run, hence the fallback."""
    return (e.display_name or "").strip() or f"{e.first_name} {e.last_name}".strip() or e.work_email


@router.get("/directory")
def people_directory(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The curated Nexus People list (nexus_employees) as a name+email picker -
    NOT the ~150-account M365 GAL. Any signed-in user can call it (same shape as
    /roles/directory), so modules like Item Management can assign to real Nexus
    people. Only people with a work email are included (assignment/notification
    needs a mailbox); offboarded staff are excluded.

    Cached (cache.py): every picker app-wide loads this list on mount, and it
    only changes on HR edits/M365 sync - the single hottest read for its rate
    of change. Same payload for every caller, so one cache entry serves all."""
    import cache
    cached = cache.people_directory.get("all")
    if cached is not None:
        return cached
    rows = (db.query(NexusEmployee)
              .filter(NexusEmployee.status != "offboarded")
              .filter(NexusEmployee.work_email != "")
              .order_by(NexusEmployee.first_name, NexusEmployee.last_name).all())
    # company is the ENTITY ID on the employee row; resolve the display name once
    # so pickers can offer company/department filters without an HR-gated call.
    ent_names = {en.id: en.name for en in db.query(HrEntity).all()}
    out = [{"email": e.work_email, "name": _person_name(e), "photoUrl": e.photo_url or "",
            "company": e.company or "", "companyName": ent_names.get(e.company or "", ""),
            "department": e.department or ""}
           for e in rows]
    cache.people_directory.set("all", out)
    return out


@router.get("/person")
def person_card(q: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Outlook-style contact card by name or email: name, title, department,
    photo - never personal/comp data. Powers hover cards on notifications etc."""
    q = (q or "").strip().lower()
    if len(q) < 2:
        raise HTTPException(400, "q too short")
    match = None
    for e in db.query(NexusEmployee).filter(NexusEmployee.status != "offboarded").all():
        # Both spellings are searchable: people type the Teams name they see,
        # but older links and emails still carry the first+last form.
        names = {f"{e.first_name} {e.last_name}".strip().lower(), _person_name(e).lower()} - {""}
        if q == (e.work_email or "").lower() or q in names:
            match = e
            break
        if match is None and (any(q in n for n in names) or q in (e.work_email or "").lower()):
            match = e
    if not match:
        raise HTTPException(404, "No matching person")
    return {"name": _person_name(match),
            "jobTitle": match.job_title, "department": match.department,
            "photoUrl": match.photo_url, "workEmail": match.work_email,
            "location": match.location, "status": match.status}


# ── My equipment - items assigned / checked out to me ────────────────────────

@router.get("/assets")
def my_assets(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = user["email"].lower()
    assignments = (db.query(ItemAssignment)
                   .filter(func.lower(ItemAssignment.assignee_email) == email,
                           ItemAssignment.status == "active")
                   .order_by(ItemAssignment.accepted_at.desc()).all())
    checkouts = (db.query(ItemCheckout)
                 .filter(func.lower(ItemCheckout.requested_by_email) == email,
                         ItemCheckout.status.in_(["approved", "allocated", "pending_receipt"]))
                 .order_by(ItemCheckout.created_at.desc()).all())
    def due_of(c):
        start = c.allocated_at or c.created_at
        if not start or c.status != "allocated":
            return ""
        try:
            return (datetime.fromisoformat(start.replace("Z", "+00:00"))
                    + timedelta(days=c.days or 1)).strftime("%Y-%m-%d")
        except Exception:
            return ""
    return {
        "assignments": [{"item": a.item_name, "since": (a.accepted_at or "")[:10]} for a in assignments],
        "checkouts": [{"item": c.item_name, "status": c.status, "due": due_of(c)} for c in checkouts],
    }


# ── Ask HR - employee requests (document updates, profile changes, questions) ─

_REQ_TYPES = ("document", "profile", "question", "other")
_REQ_LABEL = {"document": "Document update", "profile": "Profile change",
              "question": "Question", "other": "Request"}


def _hr_team_emails(db: Session) -> list:
    """Everyone in an Access Group that grants the hr module - the audience for
    'Ask HR' notifications. Falls back to empty (request still lands in the HR
    module's Requests panel)."""
    out = set()
    for g in db.query(NexusGroup).all():
        if "hr:" in (g.allowed_modules or ""):
            for m in db.query(NexusGroupMember).filter(NexusGroupMember.group_id == g.id).all():
                out.add(m.email.lower())
    return sorted(out)


def _ser_req(r: HrSelfRequest) -> dict:
    return {"id": r.id, "email": r.employee_email, "name": r.employee_name,
            "type": r.type, "message": r.message, "status": r.status,
            "attachmentName": r.attachment_name or "",
            "response": r.response or "", "resolvedBy": r.resolved_by or "",
            "resolvedAt": r.resolved_at or "", "createdAt": r.created_at}


class AskHrIn(BaseModel):
    type: str = "document"
    message: str
    attachment_path: Optional[str] = ""
    attachment_name: Optional[str] = ""


@router.post("/requests/attachment")
async def upload_request_attachment(file: UploadFile = File(...),
                                    user: dict = Depends(get_current_user)):
    """Stage the document an employee wants HR to file - uploaded to the private
    hr-docs bucket, referenced by the request created right after."""
    data = await file.read()
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(400, "File too large (max 15 MB)")
    import re as _re
    safe = _re.sub(r"[^a-zA-Z0-9._-]", "_", file.filename or "document")
    path = f"self-requests/{user['email'].lower()}/{uuid.uuid4()}-{safe}"
    resp = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/{_DOC_BUCKET}/{path}",
                      headers={**_storage_headers(), "Content-Type": file.content_type or "application/octet-stream"},
                      content=data, timeout=60)
    if not resp.is_success:
        raise HTTPException(502, f"Storage upload failed: {resp.text[:200]}")
    return {"path": path, "name": file.filename or safe}


@router.post("/requests")
def create_request(body: AskHrIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if body.type not in _REQ_TYPES:
        raise HTTPException(400, f"type must be one of {_REQ_TYPES}")
    msg = (body.message or "").strip()
    if not msg:
        raise HTTPException(400, "Say what you need from HR")
    # Only accept attachment paths this user staged themselves.
    apath = (body.attachment_path or "").strip()
    if apath and not apath.startswith(f"self-requests/{user['email'].lower()}/"):
        raise HTTPException(400, "Bad attachment")
    e = _me(db, user["email"])
    name = f"{e.first_name} {e.last_name}".strip() or user["email"]
    row = HrSelfRequest(id=str(uuid.uuid4()), employee_email=user["email"].lower(),
                        employee_name=name, type=body.type, message=msg[:2000],
                        attachment_path=apath, attachment_name=(body.attachment_name or "")[:200],
                        status="open", created_at=_now())
    db.add(row)
    # One targeted notification per HR-team member (server-side only).
    for email in _hr_team_emails(db):
        db.add(NexusNotification(
            id=str(uuid.uuid4()), type="hr_request", recipient=email,
            title=f"{_REQ_LABEL[body.type]} - {name}",
            body=msg[:300], ref_id=row.id, requested_by=name,
            action="", actioned=False, read_by="", created_at=_now()))
    db.commit()
    return _ser_req(row)


@router.get("/requests")
def my_requests(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (db.query(HrSelfRequest)
            .filter(HrSelfRequest.employee_email == user["email"].lower())
            .order_by(HrSelfRequest.created_at.desc()).limit(30).all())
    return [_ser_req(r) for r in rows]


# ── My paystubs - comp documents HR uploaded for me (kind="paystub") ─────────

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
    part of - no hr grant needed (it's your own document)."""
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


# ── my Egnyte documents (Aug 10 - Neil's "wire Contractor Documents to their
# My Documents"). Read-only: the employee sees and downloads what HR filed in
# their WIRED subfolder (people.my-documents), never the person folder root -
# the Confidential folder beside it (Aadhaar/PAN) must stay HR-only. Download
# goes through here rather than /egnyte/file so the server checks the path is
# inside the caller's own resolved folder.

@router.get("/egnyte-documents")
def my_egnyte_documents(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    import egnyte_wiring as wiring
    from services import egnyte as svc
    if not svc.configured():
        return {"available": False}
    try:
        emp = _me(db, user["email"])
    except HTTPException:
        return {"available": False}
    res = wiring.resolve_person_folder("people.my-documents", emp, db)
    if not res["folder"]:
        return {"available": False}
    try:
        listing = svc.list_folder(res["folder"])
    except svc.EgnyteError:
        return {"available": False}     # wired folder not created yet - show nothing
    return {
        "available": True,
        "folder": res["folder"],
        "files": [
            {"name": f["name"], "path": f["path"], "size": f.get("size"),
             "lastModified": f.get("last_modified") or f.get("lastModified")}
            for f in listing["files"]
        ],
    }


@router.get("/egnyte-documents/file")
def my_egnyte_document_file(path: str, user: dict = Depends(get_current_user),
                            db: Session = Depends(get_db)):
    import egnyte_wiring as wiring
    from services import egnyte as svc
    from fastapi import Response
    if not svc.configured():
        raise HTTPException(503, "Egnyte is not connected")
    emp = _me(db, user["email"])
    res = wiring.resolve_person_folder("people.my-documents", emp, db)
    folder = res["folder"]
    want = svc.norm(path)
    if not folder or not want.startswith(svc.norm(folder) + "/"):
        raise HTTPException(403, "That file is not in your documents folder")
    content = svc.read_file(want)
    name = want.rsplit("/", 1)[-1] or "download"
    return Response(
        content=content,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{name}"',
                 "X-Content-Type-Options": "nosniff"},
    )
