"""Documents (DMS) - Phase 1: folders, drafts, and a document library that sits
next to (not inside) the e-sign envelope pipeline in esign.py.

Design notes:
- A Document only becomes an e-sign envelope at the moment the user sends it for
  signature (future phase: export to PDF, hand to esign.py's existing PDF-send
  path). This file never touches HrSignRequest/HrSignParty/HrSignEvent.
- System folders (HR, Finance, Legal, Sales, Operations, Personal, Archived) are
  lazily seeded on first `GET /documents/folders` per install - no lifespan hook
  needed, mirrors the "Add starter templates" idiom in esign.py but automatic
  since every user needs folders to exist, not just the first person to click a
  button. Personal is per-user (owner_email-scoped); the rest are shared.
- No rich content editor yet (Document Builder lands Phase 2) - `content` is
  just opaque JSON round-tripped as-is; a save always appends a DocumentVersion
  row so version history is real data before any UI reads it.
- Visibility: documents in shared system folders are readable by any
  authenticated Documents-module user (same org-wide visibility as e-sign
  templates); a Personal-folder document is only visible to its owner. Only the
  owner or an administrator (level >= 4) may edit/archive/delete a document.
"""
import copy
import os
import re
import uuid
from datetime import datetime, timezone
from urllib.parse import quote
import httpx
from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List

from sqlalchemy import or_, cast, String as SqlString

from database import get_db
from auth import get_current_user
from models import (DocFolder, Document, DocumentVersion, DocTemplate, DocTemplateVersion,
                    DocLetterhead, HrSignRequest, HrSignParty)
from services.merge_fields import resolve_merge_data
from services.doc_export import tiptap_to_blocks, render_pdf, render_docx
from routers.hr import require_hr_read

router = APIRouter(prefix="/documents", tags=["documents"])

_ADMIN_LEVEL = 4  # auth._LEVELS["administrator"]

_SYSTEM_FOLDERS = [
    ("HR", "hr"), ("Finance", "finance"), ("Legal", "legal"), ("Sales", "sales"),
    ("Operations", "operations"), ("Engineering", "engineering"),
    ("Personal", "personal"), ("Archived", "archived"),
]

_TEMPLATE_CATEGORIES = ("letterhead", "hr", "legal", "finance", "operations", "sales", "engineering", "general")

# Template Builder (Phase 13) - merge-field type registry. "Reserved" types
# never get a value out of the Generate-Document fill form (signature/initials
# are placed later by the separate E-Sign field-placement step; image/file
# upload-at-fill-time is a documented fast-follow) - see _reserved_placeholder.
_FIELD_TYPES = ("text", "multiline", "number", "currency", "date", "time",
                "dropdown", "radio", "checkbox", "signature", "initials", "image", "file")
_RESERVED_FIELD_TYPES = ("signature", "initials", "image", "file")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_system_folders(db: Session, user: dict) -> None:
    existing_keys = {f.key for f in db.query(DocFolder).filter(DocFolder.key != "").all()}
    now = _now_iso()
    added = False
    for name, key in _SYSTEM_FOLDERS:
        if key == "personal":
            # One Personal folder per user, keyed the same but owner-scoped.
            mine = db.query(DocFolder).filter(DocFolder.key == "personal", DocFolder.owner_email == user["email"]).first()
            if mine:
                continue
            db.add(DocFolder(id=str(uuid.uuid4()), name=name, key=key, is_system=True,
                              owner_email=user["email"], created_by=user["email"], created_at=now))
            added = True
            continue
        if key in existing_keys:
            continue
        db.add(DocFolder(id=str(uuid.uuid4()), name=name, key=key, is_system=True,
                          owner_email="", created_by=user["email"], created_at=now))
        added = True
    if added:
        db.commit()


def _ser_folder(f: DocFolder) -> dict:
    return {"id": f.id, "name": f.name, "key": f.key, "isSystem": f.is_system,
            "ownerEmail": f.owner_email, "createdBy": f.created_by, "createdAt": f.created_at}


def _ser_document(d: Document, sign_status: str = "") -> dict:
    return {"id": d.id, "title": d.title, "folderId": d.folder_id, "templateId": d.template_id,
            "content": d.content, "letterheadId": d.letterhead_id, "status": d.status,
            "employeeId": d.employee_id, "entityId": d.entity_id, "mergeOverrides": d.merge_overrides or {},
            "ownerEmail": d.owner_email, "tags": d.tags or [], "currentVersion": d.current_version,
            "signRequestId": d.sign_request_id, "signStatus": sign_status,
            "createdBy": d.created_by, "createdAt": d.created_at,
            "updatedBy": d.updated_by, "updatedAt": d.updated_at, "archivedAt": d.archived_at}


def _sign_statuses(db: Session, docs: list) -> dict:
    """Read-only batch lookup of HrSignRequest.status for whichever documents
    have a sign_request_id - no polling/webhook sync needed, always accurate
    at read time. Never touches HrSignRequest beyond this SELECT."""
    ids = [d.sign_request_id for d in docs if d.sign_request_id]
    if not ids:
        return {}
    rows = db.query(HrSignRequest.id, HrSignRequest.status).filter(HrSignRequest.id.in_(ids)).all()
    return {rid: status for rid, status in rows}


def _visible(q, user: dict):
    """Shared-folder documents are org-visible; documents whose folder is the
    caller's own Personal folder are the only ones scoped to just them. Admins
    see everything regardless."""
    if user["level"] >= _ADMIN_LEVEL:
        return q
    personal_ids = {f.id for f in q.session.query(DocFolder).filter(
        DocFolder.key == "personal", DocFolder.owner_email == user["email"]).all()}
    other_personal_ids = {f.id for f in q.session.query(DocFolder).filter(
        DocFolder.key == "personal", DocFolder.owner_email != user["email"]).all()}
    if not other_personal_ids:
        return q
    return q.filter(~Document.folder_id.in_(other_personal_ids))


class FolderIn(BaseModel):
    name: str


class DocumentIn(BaseModel):
    title: str
    folderId: Optional[str] = ""
    templateId: Optional[str] = ""
    content: Optional[dict] = None
    tags: Optional[List[str]] = None
    fillValues: Optional[dict] = None   # Template Builder (Phase 13) - Generate Document fill-form values, keyed by token


class DocumentUpdate(BaseModel):
    title: Optional[str] = None
    folderId: Optional[str] = None
    content: Optional[dict] = None
    tags: Optional[List[str]] = None
    letterheadId: Optional[str] = None
    employeeId: Optional[str] = None
    entityId: Optional[str] = None
    mergeOverrides: Optional[dict] = None
    status: Optional[str] = None
    signRequestId: Optional[str] = None
    note: Optional[str] = ""


@router.get("/folders")
def list_folders(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _ensure_system_folders(db, user)
    rows = db.query(DocFolder).filter(
        (DocFolder.key != "personal") | (DocFolder.owner_email == user["email"])
    ).order_by(DocFolder.name).all()
    return [_ser_folder(f) for f in rows]


@router.post("/folders")
def create_folder(body: FolderIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if user["level"] < _ADMIN_LEVEL:
        raise HTTPException(403, "Only administrators can add folders")
    if not body.name.strip():
        raise HTTPException(400, "name is required")
    row = DocFolder(id=str(uuid.uuid4()), name=body.name.strip(), key="", is_system=False,
                     owner_email="", created_by=user["email"], created_at=_now_iso())
    db.add(row); db.commit(); db.refresh(row)
    return _ser_folder(row)


@router.get("")
def list_documents(folder_id: str = "", status: str = "", q: str = "", mine: bool = False,
                    limit: int = 0, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    query = db.query(Document)
    if folder_id:
        query = query.filter(Document.folder_id == folder_id)
    if status:
        query = query.filter(Document.status == status)
    if mine:
        query = query.filter(Document.owner_email == user["email"].lower())
    if q:
        like = f"%{q.strip()}%"
        query = query.filter(Document.title.ilike(like))
    query = _visible(query, user).order_by(Document.updated_at.desc())
    if limit:
        query = query.limit(limit)
    rows = query.all()
    statuses = _sign_statuses(db, rows)
    return [_ser_document(d, statuses.get(d.sign_request_id, "")) for d in rows]


@router.post("")
def create_document(body: DocumentIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if not body.title.strip():
        raise HTTPException(400, "title is required")
    now = _now_iso()
    content = body.content if body.content is not None else {}
    letterhead_id = ""
    merge_overrides = {}
    # Starting from a template clones its content (and, if the template
    # requires one, its letterhead - falling back to the org default) rather
    # than just recording template_id as a label. It also seeds the template's
    # default merge-field values/custom variables (Phase 12) onto the new
    # document, so common defaults only need to be entered once, on the
    # template, not re-typed on every document created from it.
    if body.templateId:
        tpl = db.query(DocTemplate).filter(DocTemplate.id == body.templateId).first()
        if tpl:
            if body.content is None:
                content = copy.deepcopy(tpl.content) if tpl.content else {}
            if tpl.requires_letterhead:
                letterhead_id = tpl.letterhead_id or ""
                if not letterhead_id:
                    default_lh = db.query(DocLetterhead).filter(DocLetterhead.is_default == True).first()  # noqa: E712
                    letterhead_id = default_lh.id if default_lh else ""
            merge_overrides = dict(tpl.merge_overrides or {})
            # Template Builder (Phase 13) - Generate Document: fill-form values
            # win over the template's own defaults (same "last writer wins"
            # convention resolve_merge_data already uses for its overrides).
            if body.fillValues:
                merge_overrides.update(body.fillValues)
            merge_overrides = _clean_merge_overrides(merge_overrides)
            # Required-field guard: the fill-form blocks this client-side, but a
            # direct API call must not be able to create a blank required field
            # silently. Reserved types (signature/initials/image/file) are
            # legitimately empty at generation time - see _FIELD_TYPES.
            missing = [
                fd.get("label") or fd.get("token") for fd in (tpl.field_defs or [])
                if fd.get("required") and fd.get("type") not in _RESERVED_FIELD_TYPES
                and not (merge_overrides.get(fd.get("token")) or "").strip()
            ]
            if missing:
                raise HTTPException(422, f"Missing required field(s): {', '.join(missing)}")
    row = Document(id=str(uuid.uuid4()), title=body.title.strip(), folder_id=body.folderId or "",
                    template_id=body.templateId or "", content=content, letterhead_id=letterhead_id,
                    merge_overrides=merge_overrides,
                    status="draft", owner_email=user["email"].lower(), tags=body.tags or [], current_version=1,
                    created_by=user["email"], created_at=now, updated_by=user["email"], updated_at=now)
    db.add(row); db.flush()
    db.add(DocumentVersion(id=str(uuid.uuid4()), document_id=row.id, version_no=1, content=content,
                            edited_by=user["email"], edited_at=now, note="Created"))
    db.commit(); db.refresh(row)
    return _ser_document(row)


def _ser_template(t: DocTemplate) -> dict:
    return {"id": t.id, "name": t.name, "category": t.category, "tags": t.tags or [],
            "content": t.content, "requiresLetterhead": t.requires_letterhead,
            "letterheadId": t.letterhead_id, "mergeOverrides": t.merge_overrides or {},
            "fieldDefs": t.field_defs or [],
            "status": t.status, "version": t.version,
            "createdBy": t.created_by, "createdAt": t.created_at,
            "updatedBy": t.updated_by, "updatedAt": t.updated_at}


def _ser_letterhead(l: DocLetterhead) -> dict:  # noqa: E741
    return {"id": l.id, "name": l.name, "logoPath": l.logo_path, "headerJson": l.header_json,
            "footerJson": l.footer_json, "address": l.address, "isDefault": l.is_default,
            "createdBy": l.created_by, "createdAt": l.created_at}


class TemplateIn(BaseModel):
    name: str
    category: Optional[str] = "general"
    tags: Optional[List[str]] = None
    content: Optional[dict] = None
    requiresLetterhead: Optional[bool] = False
    letterheadId: Optional[str] = ""
    fieldDefs: Optional[List[dict]] = None


class TemplateUpdate(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    tags: Optional[List[str]] = None
    content: Optional[dict] = None
    requiresLetterhead: Optional[bool] = None
    letterheadId: Optional[str] = None
    mergeOverrides: Optional[dict] = None
    fieldDefs: Optional[List[dict]] = None
    status: Optional[str] = None
    note: Optional[str] = ""


class LetterheadIn(BaseModel):
    name: str
    logoPath: Optional[str] = ""
    headerJson: Optional[dict] = None
    footerJson: Optional[dict] = None
    address: Optional[str] = ""
    isDefault: Optional[bool] = False


class LetterheadUpdate(BaseModel):
    name: Optional[str] = None
    logoPath: Optional[str] = None
    headerJson: Optional[dict] = None
    footerJson: Optional[dict] = None
    address: Optional[str] = None
    isDefault: Optional[bool] = None


def _get_template_owned_or_admin(db: Session, tid: str, user: dict) -> DocTemplate:
    row = db.query(DocTemplate).filter(DocTemplate.id == tid).first()
    if not row:
        raise HTTPException(404, "Template not found")
    if user["level"] < _ADMIN_LEVEL and row.created_by != user["email"]:
        raise HTTPException(403, "You don't own this template")
    return row


@router.get("/templates")
def list_templates(category: str = "", status: str = "", q: str = "",
                    user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    query = db.query(DocTemplate)
    if category:
        query = query.filter(DocTemplate.category == category)
    if status:
        query = query.filter(DocTemplate.status == status)
    if q:
        query = query.filter(DocTemplate.name.ilike(f"%{q.strip()}%"))
    rows = query.order_by(DocTemplate.name).all()
    return [_ser_template(t) for t in rows]


@router.post("/templates")
def create_template(body: TemplateIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if not body.name.strip():
        raise HTTPException(400, "name is required")
    category = body.category or "general"
    if category not in _TEMPLATE_CATEGORIES:
        raise HTTPException(400, f"category must be one of {_TEMPLATE_CATEGORIES}")
    now = _now_iso()
    content = body.content if body.content is not None else {}
    row = DocTemplate(id=str(uuid.uuid4()), name=body.name.strip(), category=category,
                       tags=body.tags or [], content=content,
                       requires_letterhead=bool(body.requiresLetterhead), letterhead_id=body.letterheadId or "",
                       field_defs=_clean_field_defs(body.fieldDefs or []),
                       status="active", version=1, created_by=user["email"], created_at=now,
                       updated_by=user["email"], updated_at=now)
    db.add(row); db.flush()
    db.add(DocTemplateVersion(id=str(uuid.uuid4()), template_id=row.id, version_no=1, content=content,
                              edited_by=user["email"], edited_at=now, note="Created"))
    db.commit(); db.refresh(row)
    return _ser_template(row)


def _mf(token: str) -> dict:
    return {"type": "mergeField", "attrs": {"token": token}}


def _t(text: str, bold: bool = False) -> dict:
    node = {"type": "text", "text": text}
    if bold:
        node["marks"] = [{"type": "bold"}]
    return node


def _p(*parts, align=None) -> dict:
    node = {"type": "paragraph", "attrs": {"textAlign": align}}
    if parts:
        node["content"] = list(parts)
    return node


def _h(text: str, level: int = 1, align=None) -> dict:
    return {"type": "heading", "attrs": {"textAlign": align, "level": level}, "content": [_t(text)]}


def _li(*parts) -> dict:
    return {"type": "listItem", "content": [_p(*parts)]}


def _ul(*items) -> dict:
    return {"type": "bulletList", "content": list(items)}


# Real starter content for the common HR letters (Phase 12) - real, editable
# body content (headings/paragraphs/merge-field chips/bullet lists), not the
# blank single-paragraph shell the original 8 category starters use. Built as
# plain TipTap JSON dicts directly (no HTML/generateJSON - that's a frontend
# @tiptap/core helper, not available server-side); the frontend's schema
# normalizes any attrs left implicit, same as any hand-crafted TipTap doc.
def _offer_letter_content() -> dict:
    return {"type": "doc", "content": [
        _h("Offer of Employment"),
        _p(_mf("today")),
        _p(_t("Dear "), _mf("full_name"), _t(",")),
        _p(_t("We are pleased to offer you the position of "), _mf("job_title"),
           _t(" in the "), _mf("department"), _t(" department at "), _mf("company"),
           _t(". This letter outlines the key terms of your offer.")),
        _ul(
            _li(_t("Position: ", bold=True), _mf("job_title")),
            _li(_t("Department: ", bold=True), _mf("department")),
            _li(_t("Start Date: ", bold=True), _mf("start_date")),
            _li(_t("Annual Salary: ", bold=True), _mf("salary")),
            _li(_t("Reporting Manager: ", bold=True), _mf("manager")),
        ),
        _p(_t("This offer is contingent upon successful completion of any applicable background and reference checks, and your acceptance of the Company's standard employment terms and policies.")),
        _p(_t("Please sign and return a copy of this letter to confirm your acceptance.")),
        _p(_t("We look forward to welcoming you to "), _mf("company_legal"), _t(".")),
        _p(_t("Sincerely,")),
        _p(_mf("signatory")),
        _p(_mf("company_legal")),
    ]}


def _joining_letter_content() -> dict:
    return {"type": "doc", "content": [
        _h("Appointment Letter"),
        _p(_mf("today")),
        _p(_t("Dear "), _mf("full_name"), _t(",")),
        _p(_t("Further to your acceptance of our offer, we are pleased to confirm your appointment as "),
           _mf("job_title"), _t(" in the "), _mf("department"), _t(" department, effective "),
           _mf("start_date"), _t(".")),
        _ul(
            _li(_t("Position: ", bold=True), _mf("job_title")),
            _li(_t("Department: ", bold=True), _mf("department")),
            _li(_t("Date of Joining: ", bold=True), _mf("start_date")),
            _li(_t("Reporting Manager: ", bold=True), _mf("manager")),
            _li(_t("Work Location: ", bold=True), _mf("company_address")),
        ),
        _p(_t("Your employment will be governed by the terms and conditions outlined in your offer letter and the Company's policies, as amended from time to time.")),
        _p(_t("Please report to "), _mf("manager"), _t(" on your date of joining with the required documents for onboarding.")),
        _p(_t("We are excited to have you join "), _mf("company_legal"), _t(" and look forward to a successful association.")),
        _p(_t("Sincerely,")),
        _p(_mf("signatory")),
        _p(_mf("company_legal")),
    ]}


def _nda_content() -> dict:
    return {"type": "doc", "content": [
        _h("Non-Disclosure Agreement"),
        _p(_t("This Non-Disclosure Agreement (“Agreement”) is entered into on "), _mf("today"),
           _t(" between "), _mf("company_legal"), _t(", located at "), _mf("company_address"),
           _t(" (“Company”), and "), _mf("full_name"), _t(" (“Recipient”).")),
        _h("1. Purpose", level=2),
        _p(_t("The Company and Recipient wish to explore a business or working relationship in connection with which the Company may disclose certain confidential and proprietary information to the Recipient.")),
        _h("2. Confidential Information", level=2),
        _p(_t("“Confidential Information” means any non-public information disclosed by the Company to the Recipient, whether oral, written, or in any other form, that is designated as confidential or that would reasonably be understood to be confidential.")),
        _h("3. Obligations", level=2),
        _p(_t("The Recipient agrees to:")),
        _ul(
            _li(_t("Hold the Confidential Information in strict confidence")),
            _li(_t("Not disclose the Confidential Information to any third party without the Company's prior written consent")),
            _li(_t("Use the Confidential Information solely in connection with the purpose above")),
            _li(_t("Return or destroy all Confidential Information upon the Company's request")),
        ),
        _h("4. Term", level=2),
        _p(_t("This Agreement shall remain in effect for two (2) years from the date first written above, unless terminated earlier by mutual written consent.")),
        _h("5. Governing Law", level=2),
        _p(_t("This Agreement shall be governed by the laws applicable at "), _mf("company_address"), _t(".")),
        _p(_t("Recipient: "), _mf("full_name")),
        _p(_t("Signature: ______________________     Date: ______________")),
        _p(_t("For "), _mf("company_legal"), _t(":")),
        _p(_mf("signatory")),
    ]}


def _relieving_letter_content() -> dict:
    return {"type": "doc", "content": [
        _h("Relieving Letter"),
        _p(_mf("today")),
        _p(_t("Dear "), _mf("full_name"), _t(",")),
        _p(_t("This is to confirm that your resignation from the position of "), _mf("job_title"),
           _t(" in the "), _mf("department"), _t(" department has been accepted, and you are relieved from your duties at "),
           _mf("company_legal"), _t(", effective your last working day.")),
        _p(_t("We appreciate your contributions during your tenure with us and wish you success in your future endeavors.")),
        _p(_t("Please note that you continue to be bound by the confidentiality and other post-employment obligations outlined in your employment agreement.")),
        _p(_t("We wish you all the best.")),
        _p(_t("Sincerely,")),
        _p(_mf("signatory")),
        _p(_mf("company_legal")),
    ]}


def _experience_letter_content() -> dict:
    return {"type": "doc", "content": [
        _h("Experience Letter"),
        _p(_mf("today")),
        _p(_t("To Whom It May Concern,")),
        _p(_t("This is to certify that "), _mf("full_name"), _t(" was employed with "), _mf("company_legal"),
           _t(" as "), _mf("job_title"), _t(" in the "), _mf("department"), _t(" department.")),
        _p(_t("During this period, we found them to be sincere, hardworking, and professional in their conduct. We wish them success in all future endeavors.")),
        _p(_t("This letter is issued upon the employee's request for whatever purpose it may serve.")),
        _p(_t("Sincerely,")),
        _p(_mf("signatory")),
        _p(_mf("company_legal")),
    ]}


@router.post("/templates/starters")
def seed_starter_templates(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Add-if-missing-by-name, mirrors esign.py's POST /esign/templates/starters.
    Seeds a default letterhead (if none exists) + one starter template per
    category, so the auto-attach-letterhead behavior has something real to
    demonstrate immediately. Phase 12 added 5 real HR-letter starters (Offer,
    Appointment/Joining, NDA, Relieving, Experience) with actual merge-field
    content, not just an empty shell."""
    if user["level"] < _ADMIN_LEVEL:
        raise HTTPException(403, "Only administrators can seed starters")
    now = _now_iso()
    default_lh = db.query(DocLetterhead).filter(DocLetterhead.is_default == True).first()  # noqa: E712
    if not default_lh:
        default_lh = DocLetterhead(id=str(uuid.uuid4()), name="Standard",
                                    logo_path="", header_json={}, footer_json={},
                                    address="123 Placeholder Ave, Suite 100, Anytown, ST 00000",
                                    is_default=True, created_by=user["email"], created_at=now)
        db.add(default_lh); db.flush()

    starters = [
        ("Company Letterhead", "letterhead", False, "", None),
        ("Company Memo", "hr", True, default_lh.id, None),
        ("Legal Notice", "legal", False, "", None),
        ("Invoice Template", "finance", False, "", None),
        ("SOP Cover Sheet", "operations", False, "", None),
        ("Sales Proposal", "sales", False, "", None),
        ("Engineering Spec", "engineering", False, "", None),
        ("General Letter", "general", False, "", None),
        ("Offer Letter", "hr", True, default_lh.id, _offer_letter_content),
        ("Joining Letter", "hr", True, default_lh.id, _joining_letter_content),
        ("NDA (Non-Disclosure Agreement)", "legal", True, default_lh.id, _nda_content),
        ("Relieving Letter", "hr", True, default_lh.id, _relieving_letter_content),
        ("Experience Letter", "hr", True, default_lh.id, _experience_letter_content),
    ]
    existing = {t.name for t in db.query(DocTemplate).all()}
    added = 0
    for name, category, requires_lh, lh_id, content_fn in starters:
        if name in existing:
            continue
        body = content_fn() if content_fn else {"type": "doc", "content": [{"type": "paragraph"}]}
        db.add(DocTemplate(id=str(uuid.uuid4()), name=name, category=category, tags=[],
                            content={"body": body, "header": None, "footer": None},
                            requires_letterhead=requires_lh, letterhead_id=lh_id,
                            status="active", version=1, created_by=user["email"], created_at=now,
                            updated_by=user["email"], updated_at=now))
        added += 1
    db.commit()
    return {"added": added}


@router.get("/templates/{tid}")
def get_template(tid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.query(DocTemplate).filter(DocTemplate.id == tid).first()
    if not row:
        raise HTTPException(404, "Template not found")
    return _ser_template(row)


@router.patch("/templates/{tid}")
def update_template(tid: str, body: TemplateUpdate, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = _get_template_owned_or_admin(db, tid, user)
    if body.name is not None:
        if not body.name.strip():
            raise HTTPException(400, "name cannot be blank")
        row.name = body.name.strip()
    if body.category is not None:
        if body.category not in _TEMPLATE_CATEGORIES:
            raise HTTPException(400, f"category must be one of {_TEMPLATE_CATEGORIES}")
        row.category = body.category
    if body.tags is not None:
        row.tags = body.tags
    if body.requiresLetterhead is not None:
        row.requires_letterhead = body.requiresLetterhead
    if body.letterheadId is not None:
        row.letterhead_id = body.letterheadId
    if body.mergeOverrides is not None:
        row.merge_overrides = _clean_merge_overrides(body.mergeOverrides)
    if body.fieldDefs is not None:
        row.field_defs = _clean_field_defs(body.fieldDefs)
    if body.status is not None:
        row.status = body.status
    if body.content is not None:
        row.content = body.content
        row.version += 1
        db.add(DocTemplateVersion(id=str(uuid.uuid4()), template_id=row.id, version_no=row.version,
                                  content=body.content, edited_by=user["email"], edited_at=_now_iso(),
                                  note=(body.note or "").strip()))
    row.updated_by = user["email"]
    row.updated_at = _now_iso()
    db.commit(); db.refresh(row)
    return _ser_template(row)


@router.get("/templates/{tid}/versions")
def list_template_versions(tid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (db.query(DocTemplateVersion).filter(DocTemplateVersion.template_id == tid)
            .order_by(DocTemplateVersion.version_no.desc()).all())
    return [{"id": v.id, "versionNo": v.version_no, "editedBy": v.edited_by, "editedAt": v.edited_at, "note": v.note}
            for v in rows]


@router.get("/templates/{tid}/versions/{vid}")
def get_template_version(tid: str, vid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    v = db.query(DocTemplateVersion).filter(DocTemplateVersion.id == vid, DocTemplateVersion.template_id == tid).first()
    if not v:
        raise HTTPException(404, "Version not found")
    return {"id": v.id, "versionNo": v.version_no, "editedBy": v.edited_by, "editedAt": v.edited_at,
            "note": v.note, "content": v.content}


@router.delete("/templates/{tid}")
def delete_template(tid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = _get_template_owned_or_admin(db, tid, user)
    # A template can be deleted out from under documents already generated
    # from it (Document.template_id is a plain string, no FK constraint) -
    # block it instead of silently orphaning those documents.
    if db.query(Document).filter(Document.template_id == tid).first():
        raise HTTPException(409, "Cannot delete a template that has generated documents - archive it instead")
    db.delete(row); db.commit()
    return {"ok": True}


@router.post("/templates/{tid}/duplicate")
def duplicate_template(tid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    src = db.query(DocTemplate).filter(DocTemplate.id == tid).first()
    if not src:
        raise HTTPException(404, "Template not found")
    now = _now_iso()
    row = DocTemplate(id=str(uuid.uuid4()), name=f"{src.name} (Copy)", category=src.category,
                       tags=src.tags or [], content=copy.deepcopy(src.content) if src.content else {},
                       requires_letterhead=src.requires_letterhead, letterhead_id=src.letterhead_id,
                       merge_overrides=src.merge_overrides or {},
                       field_defs=copy.deepcopy(src.field_defs) if src.field_defs else [],
                       status="active", version=1, created_by=user["email"], created_at=now,
                       updated_by=user["email"], updated_at=now)
    db.add(row); db.commit(); db.refresh(row)
    return _ser_template(row)


@router.get("/letterheads")
def list_letterheads(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.query(DocLetterhead).order_by(DocLetterhead.name).all()
    return [_ser_letterhead(l) for l in rows]


@router.post("/letterheads")
def create_letterhead(body: LetterheadIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if user["level"] < _ADMIN_LEVEL:
        raise HTTPException(403, "Only administrators can manage letterheads")
    if not body.name.strip():
        raise HTTPException(400, "name is required")
    now = _now_iso()
    if body.isDefault:
        db.query(DocLetterhead).update({DocLetterhead.is_default: False}, synchronize_session=False)
    row = DocLetterhead(id=str(uuid.uuid4()), name=body.name.strip(), logo_path=body.logoPath or "",
                         header_json=body.headerJson or {}, footer_json=body.footerJson or {},
                         address=body.address or "", is_default=bool(body.isDefault),
                         created_by=user["email"], created_at=now)
    db.add(row); db.commit(); db.refresh(row)
    return _ser_letterhead(row)


@router.patch("/letterheads/{lid}")
def update_letterhead(lid: str, body: LetterheadUpdate, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if user["level"] < _ADMIN_LEVEL:
        raise HTTPException(403, "Only administrators can manage letterheads")
    row = db.query(DocLetterhead).filter(DocLetterhead.id == lid).first()
    if not row:
        raise HTTPException(404, "Letterhead not found")
    if body.name is not None:
        if not body.name.strip():
            raise HTTPException(400, "name cannot be blank")
        row.name = body.name.strip()
    if body.logoPath is not None:
        row.logo_path = body.logoPath
    if body.headerJson is not None:
        row.header_json = body.headerJson
    if body.footerJson is not None:
        row.footer_json = body.footerJson
    if body.address is not None:
        row.address = body.address
    if body.isDefault is not None and body.isDefault:
        db.query(DocLetterhead).update({DocLetterhead.is_default: False}, synchronize_session=False)
        row.is_default = True
    elif body.isDefault is not None:
        row.is_default = False
    db.commit(); db.refresh(row)
    return _ser_letterhead(row)


@router.delete("/letterheads/{lid}")
def delete_letterhead(lid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if user["level"] < _ADMIN_LEVEL:
        raise HTTPException(403, "Only administrators can manage letterheads")
    row = db.query(DocLetterhead).filter(DocLetterhead.id == lid).first()
    if row:
        db.delete(row); db.commit()
    return {"ok": True}


@router.get("/search")
def search_documents(q: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Unified cross-module search (Phase 6) - documents + templates always,
    e-sign envelopes only if the caller actually has HR read access (esign.py's
    own listing endpoints are gated behind require_hr_read; this must not leak
    envelope data around that gate). Read-only everywhere - never writes to
    hr_sign_* tables, matches the precedent set by Phase 5's signStatus join."""
    q = q.strip()
    if len(q) < 2:
        return []
    like = f"%{q}%"
    results = []

    # Tags are a JSON column - casting to text and ILIKE-ing the serialized
    # form (e.g. '["hr", "urgent"]') matches tag content without needing a
    # JSON-specific operator, and works identically on SQLite and Postgres.
    doc_query = db.query(Document).filter(
        or_(Document.title.ilike(like), cast(Document.tags, SqlString).ilike(like)))
    for d in _visible(doc_query, user).order_by(Document.updated_at.desc()).limit(20).all():
        results.append({"type": "document", "id": d.id, "title": d.title,
                        "subtitle": d.status, "updatedAt": d.updated_at})

    tpl_query = db.query(DocTemplate).filter(
        or_(DocTemplate.name.ilike(like), DocTemplate.category.ilike(like), cast(DocTemplate.tags, SqlString).ilike(like)))
    for t in tpl_query.order_by(DocTemplate.updated_at.desc()).limit(20).all():
        results.append({"type": "template", "id": t.id, "title": t.name,
                        "subtitle": t.category, "updatedAt": t.updated_at})

    try:
        require_hr_read(user=user, db=db)
        party_matches = db.query(HrSignParty.request_id).filter(
            or_(HrSignParty.name.ilike(like), HrSignParty.email.ilike(like)))
        esign_query = db.query(HrSignRequest).filter(
            or_(HrSignRequest.title.ilike(like), HrSignRequest.id.in_(party_matches)))
        for r in esign_query.order_by(HrSignRequest.created_at.desc()).limit(20).all():
            results.append({"type": "esign", "id": r.id, "title": r.title,
                            "subtitle": f"sent by {r.created_by}" if r.created_by else "", "updatedAt": r.created_at})
    except HTTPException:
        pass  # no HR/e-sign access - omit those results, don't fail the whole search

    results.sort(key=lambda r: r.get("updatedAt") or "", reverse=True)
    return results


def _get_owned_or_admin(db: Session, did: str, user: dict) -> Document:
    row = db.query(Document).filter(Document.id == did).first()
    if not row:
        raise HTTPException(404, "Document not found")
    if user["level"] < _ADMIN_LEVEL and row.owner_email != user["email"].lower():
        raise HTTPException(403, "You don't own this document")
    return row


@router.get("/{did}")
def get_document(did: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.query(Document).filter(Document.id == did).first()
    if not row:
        raise HTTPException(404, "Document not found")
    statuses = _sign_statuses(db, [row])
    return _ser_document(row, statuses.get(row.sign_request_id, ""))


def _clean_field_defs(defs: list) -> list:
    """Template Builder (Phase 13) - validate/normalize field_defs before
    persisting: dedupe by token (last one wins), enforce the token shape
    _clean_merge_overrides already requires for the values themselves, drop
    entries with an unknown type, strip unknown keys, coerce `required` to
    bool. Options only kept for dropdown/radio."""
    by_token = {}
    for d in defs or []:
        if not isinstance(d, dict):
            continue
        token = str(d.get("token") or "")
        if not re.fullmatch(r"[a-z0-9_]+", token):
            continue
        ftype = d.get("type")
        if ftype not in _FIELD_TYPES:
            continue
        validation = d.get("validation") if isinstance(d.get("validation"), dict) else {}
        clean = {
            "token": token,
            "label": str(d.get("label") or token)[:200],
            "type": ftype,
            "required": bool(d.get("required")),
            "default": str(d.get("default") or "")[:2000],
            "validation": {k: v for k, v in validation.items()
                          if k in ("maxLength", "regex", "min", "max", "minDate", "maxDate")},
        }
        if ftype in ("dropdown", "radio"):
            clean["options"] = [str(o)[:200] for o in (d.get("options") or []) if str(o).strip()][:50]
        by_token[token] = clean
    return list(by_token.values())


def _clean_merge_overrides(overrides: dict) -> dict:
    """Same key-shape rule resolve_merge_data() already enforces at resolve
    time (services/merge_fields.py) - filtered again here defensively so a
    malformed key never gets stored in the first place, not just silently
    ignored later. Shared by Document and DocTemplate updates (Phase 11/12)."""
    return {
        k: str(v) for k, v in (overrides or {}).items()
        if re.fullmatch(r"[a-z0-9_]+", str(k)) and isinstance(v, (str, int, float)) and str(v) != ""
    }


@router.patch("/{did}")
def update_document(did: str, body: DocumentUpdate, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = _get_owned_or_admin(db, did, user)
    if body.title is not None:
        if not body.title.strip():
            raise HTTPException(400, "title cannot be blank")
        row.title = body.title.strip()
    if body.folderId is not None:
        row.folder_id = body.folderId
    if body.tags is not None:
        row.tags = body.tags
    if body.letterheadId is not None:
        row.letterhead_id = body.letterheadId
    if body.employeeId is not None:
        row.employee_id = body.employeeId
    if body.entityId is not None:
        row.entity_id = body.entityId
    if body.mergeOverrides is not None:
        row.merge_overrides = _clean_merge_overrides(body.mergeOverrides)
    if body.status is not None:
        if body.status not in ("draft", "final", "archived"):
            raise HTTPException(400, "status must be one of draft, final, archived")
        row.status = body.status
    if body.signRequestId is not None:
        row.sign_request_id = body.signRequestId
    if body.content is not None:
        row.content = body.content
        row.current_version += 1
        db.add(DocumentVersion(id=str(uuid.uuid4()), document_id=row.id, version_no=row.current_version,
                                content=body.content, edited_by=user["email"], edited_at=_now_iso(),
                                note=(body.note or "").strip()))
    row.updated_by = user["email"]
    row.updated_at = _now_iso()
    db.commit(); db.refresh(row)
    return _ser_document(row)


@router.delete("/{did}")
def delete_document(did: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = _get_owned_or_admin(db, did, user)
    if row.status != "draft":
        raise HTTPException(400, "Only drafts can be permanently deleted - archive it instead")
    db.query(DocumentVersion).filter(DocumentVersion.document_id == did).delete()
    db.delete(row); db.commit()
    return {"ok": True}


@router.post("/{did}/archive")
def archive_document(did: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = _get_owned_or_admin(db, did, user)
    row.status = "archived"
    row.archived_at = _now_iso()
    row.updated_by = user["email"]; row.updated_at = _now_iso()
    db.commit(); db.refresh(row)
    return _ser_document(row)


@router.post("/{did}/restore")
def restore_document(did: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = _get_owned_or_admin(db, did, user)
    if row.status != "archived":
        raise HTTPException(400, "Document is not archived")
    row.status = "draft"
    row.archived_at = ""
    row.updated_by = user["email"]; row.updated_at = _now_iso()
    db.commit(); db.refresh(row)
    return _ser_document(row)


@router.post("/{did}/duplicate")
def duplicate_document(did: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    src = db.query(Document).filter(Document.id == did).first()
    if not src:
        raise HTTPException(404, "Document not found")
    now = _now_iso()
    row = Document(id=str(uuid.uuid4()), title=f"{src.title} (Copy)", folder_id=src.folder_id,
                    template_id=src.template_id, content=src.content, letterhead_id=src.letterhead_id,
                    employee_id=src.employee_id, entity_id=src.entity_id, merge_overrides=src.merge_overrides or {},
                    status="draft", owner_email=user["email"].lower(), tags=src.tags or [],
                    current_version=1, created_by=user["email"], created_at=now,
                    updated_by=user["email"], updated_at=now)
    db.add(row); db.flush()
    db.add(DocumentVersion(id=str(uuid.uuid4()), document_id=row.id, version_no=1, content=src.content,
                            edited_by=user["email"], edited_at=now, note=f"Duplicated from {src.id}"))
    db.commit(); db.refresh(row)
    return _ser_document(row)


@router.get("/{did}/versions")
def list_versions(did: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.query(DocumentVersion).filter(DocumentVersion.document_id == did).order_by(DocumentVersion.version_no.desc()).all()
    return [{"id": v.id, "versionNo": v.version_no, "editedBy": v.edited_by, "editedAt": v.edited_at, "note": v.note}
            for v in rows]


@router.get("/{did}/versions/{vid}")
def get_version(did: str, vid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Full content snapshot for one version - kept out of the list endpoint
    above so browsing history stays cheap; only fetched when a user opens it."""
    v = db.query(DocumentVersion).filter(DocumentVersion.id == vid, DocumentVersion.document_id == did).first()
    if not v:
        raise HTTPException(404, "Version not found")
    return {"id": v.id, "versionNo": v.version_no, "editedBy": v.edited_by, "editedAt": v.edited_at,
            "note": v.note, "content": v.content}


def _content_disposition(title: str, ext: str) -> str:
    """HTTP header values must be Latin-1 - a title with a smart/typographic
    character (en dash, curly quotes, ...) crashed export entirely (a real
    bug: Starlette raises UnicodeEncodeError while sending the response,
    which surfaces to the browser as a bare "Failed to fetch", not a JSON
    error). filename= gets an ASCII-safe fallback (non-Latin-1 chars dropped);
    filename*=UTF-8'' (RFC 6266) carries the real title for browsers that
    support it, so the download still gets the user's actual filename."""
    name = (title or "document").strip().replace('"', "")[:80] or "document"
    ascii_name = name.encode("ascii", "ignore").decode("ascii").strip() or "document"
    return f'attachment; filename="{ascii_name}.{ext}"; filename*=UTF-8\'\'{quote(f"{name}.{ext}")}'


def _export_prep(db: Session, did: str, user: dict):
    """Shared setup for both export endpoints: load the document (same
    visibility as GET /{did} - no ownership check, matches read access),
    resolve its merge data, walk header/body/footer to blocks, and fetch its
    letterhead (if any) serialized for the renderers."""
    row = db.query(Document).filter(Document.id == did).first()
    if not row:
        raise HTTPException(404, "Document not found")
    merge = resolve_merge_data(db, employee_id=row.employee_id, entity_id=row.entity_id,
                               overrides=row.merge_overrides or {})
    # Template Builder (Phase 13) - a signature/initials/image/file field is
    # never filled through the Generate-Document form (reserved for E-Sign /
    # a fast-follow upload path); render its label as a visible placeholder
    # instead of a raw "{{token}}" or a silent blank so whoever reviews the
    # export knows exactly what's still missing.
    if row.template_id:
        tpl = db.query(DocTemplate).filter(DocTemplate.id == row.template_id).first()
        if tpl and tpl.field_defs:
            kind_label = {"signature": "Signature", "initials": "Initials", "image": "Image", "file": "Attachment"}
            for fd in tpl.field_defs:
                token, ftype = fd.get("token"), fd.get("type")
                if ftype in _RESERVED_FIELD_TYPES and not merge.get(token):
                    merge[token] = f"[{kind_label.get(ftype, 'Field')}: {fd.get('label') or token}]"
    content = row.content if isinstance(row.content, dict) else {}
    header_blocks = tiptap_to_blocks(content.get("header"), merge)
    body_blocks = tiptap_to_blocks(content.get("body"), merge)
    footer_blocks = tiptap_to_blocks(content.get("footer"), merge)
    # Page Setup (Phase 14) - a sibling of body/header/footer in the same
    # content JSON, no schema change needed. Missing/unknown values fall back
    # to US Letter (_resolve_page_setup's own default).
    page_setup = content.get("pageSetup") if isinstance(content.get("pageSetup"), dict) else {}
    letterhead = None
    if row.letterhead_id:
        lh = db.query(DocLetterhead).filter(DocLetterhead.id == row.letterhead_id).first()
        if lh:
            letterhead = _ser_letterhead(lh)
    return row, header_blocks, body_blocks, footer_blocks, letterhead, page_setup


@router.get("/{did}/export/pdf")
def export_document_pdf(did: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row, header_blocks, body_blocks, footer_blocks, letterhead, page_setup = _export_prep(db, did, user)
    pdf_bytes = render_pdf(row.title, header_blocks, body_blocks, footer_blocks, letterhead, page_setup)
    return Response(content=pdf_bytes, media_type="application/pdf",
                    headers={"Content-Disposition": _content_disposition(row.title, "pdf")})


@router.get("/{did}/export/docx")
def export_document_docx(did: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row, header_blocks, body_blocks, footer_blocks, letterhead, page_setup = _export_prep(db, did, user)
    docx_bytes = render_docx(row.title, header_blocks, body_blocks, footer_blocks, letterhead, page_setup)
    return Response(content=docx_bytes, media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    headers={"Content-Disposition": _content_disposition(row.title, "docx")})


# ── Import from Egnyte ────────────────────────────────────────────────────────
# Browse + fetch only (never writes) - the write side is esign.py's separate,
# already-existing _egnyte_push() (sealed-document archival), untouched here.
# Reads the same EGNYTE_DOMAIN/EGNYTE_TOKEN env vars that feature uses; not
# imported from esign.py (which doesn't export them as reusable constants) -
# two os.getenv calls duplicated locally is simpler and lower-risk than adding
# a new shared export to that compliance-flagged file for this.
_EGNYTE_IMPORT_EXTS = (".docx", ".doc", ".pdf", ".txt")


# Auth, path handling and the HTTP verbs now live in services/egnyte.py so the
# Asset module's Documents tab and this importer share ONE implementation. Adding
# a second client is the exact mistake CLAUDE.md records for Asana.
from services import egnyte as egnyte_svc


def _egnyte_configured() -> bool:
    return egnyte_svc.configured()


@router.get("/egnyte/browse")
def egnyte_browse(path: str = "", user: dict = Depends(get_current_user)):
    if not _egnyte_configured():
        raise HTTPException(503, "Egnyte not configured - set EGNYTE_DOMAIN and EGNYTE_TOKEN")
    try:
        data = egnyte_svc.list_folder(path)
    except egnyte_svc.EgnyteError as exc:
        raise HTTPException(exc.status, str(exc))
    # `supported` is this importer's OWN policy (it can only convert these
    # types), not a property of the folder - so it is applied here rather than in
    # the shared client, which other callers need unfiltered.
    for f in data["files"]:
        f["supported"] = f["name"].lower().endswith(_EGNYTE_IMPORT_EXTS)
    return data


@router.get("/egnyte/file")
def egnyte_file(path: str, user: dict = Depends(get_current_user)):
    if not _egnyte_configured():
        raise HTTPException(503, "Egnyte not configured - set EGNYTE_DOMAIN and EGNYTE_TOKEN")
    if not path.lower().endswith(_EGNYTE_IMPORT_EXTS):
        raise HTTPException(400, "Unsupported file type")
    try:
        content = egnyte_svc.read_file(path)
    except egnyte_svc.EgnyteError as exc:
        raise HTTPException(exc.status, str(exc))
    name = egnyte_svc.norm(path).rsplit("/", 1)[-1] or "document"
    return Response(content=content, media_type="application/octet-stream",
                    headers={"Content-Disposition": _content_disposition(name.rsplit(".", 1)[0], name.rsplit(".", 1)[-1])})
