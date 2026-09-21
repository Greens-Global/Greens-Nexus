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
import re
import uuid
from datetime import datetime, timezone
from urllib.parse import quote
from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List

from sqlalchemy import or_, cast, func, String as SqlString

from database import get_db
from auth import get_current_user
from models import (DocFolder, Document, DocumentVersion, DocTemplate, DocTemplateVersion,
                    DocLetterhead, HrSignRequest, HrSignParty, NexusEmployee)
from services.merge_fields import (BUILTIN_VARIABLES, group_label, is_auto_token,
                                   is_valid_token, resolve_merge_data, token_group)
from services.doc_export import tiptap_to_blocks, render_pdf, render_docx
from routers.hr import require_hr_read, _hr_notify

router = APIRouter(prefix="/documents", tags=["documents"])

_ADMIN_LEVEL = 4  # auth._LEVELS["administrator"]

_SYSTEM_FOLDERS = [
    ("HR", "hr"), ("Finance", "finance"), ("Legal", "legal"), ("Sales", "sales"),
    ("Operations", "operations"), ("Engineering", "engineering"),
    ("Personal", "personal"), ("Archived", "archived"),
]

_TEMPLATE_CATEGORIES = ("letterhead", "hr", "legal", "finance", "operations", "sales", "engineering", "general")

# Requirement 3. A template is DRAFT while it is being written, ACTIVE once it
# is the company's approved language, ARCHIVED when it is retired. Only an
# active template may be generated from - that is what "company-approved"
# buys you, and requirement 20 asks for a plain "template inactive" error
# rather than a document quietly produced from unfinished language.
_TEMPLATE_STATUSES = ("draft", "active", "archived")
_TEMPLATE_TYPES = ("document", "email")

# Template Builder (Phase 13) - merge-field type registry. "Reserved" types
# never get a value out of the Generate-Document fill form (signature/initials
# are placed later by the separate E-Sign field-placement step; image/file
# upload-at-fill-time is a documented fast-follow) - see _reserved_placeholder.
# Requirement 5 asks for text, number, currency, date, email, address and
# person/name at minimum - and requirement 19 for the validation that goes with
# them ("Email -> valid email"). email/address/person are their own types
# rather than "text with a regex someone remembers to set", so a template
# author picks the meaning and gets the checking for free.
_FIELD_TYPES = ("text", "multiline", "number", "currency", "date", "time",
                "email", "address", "person",
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
            "templateVersion": d.template_version or 0,
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


_MAX_TAGS = 20
_MAX_TAG_LEN = 40


def _clean_tags(tags) -> list:
    """Normalize a tag list before persisting: trimmed, lowercased, de-duped,
    order preserved. Lowercasing is what makes tag search predictable - the
    search endpoint ILIKEs the serialized JSON, so "HR" and "hr" would
    otherwise be two tags that both match and neither groups by."""
    if not isinstance(tags, list):
        return []
    out = []
    for t in tags:
        if not isinstance(t, str):
            continue
        t = t.strip().lower()[:_MAX_TAG_LEN]
        if t and t not in out:
            out.append(t)
        if len(out) >= _MAX_TAGS:
            break
    return out


def _assert_folder_ok(db: Session, folder_id: str, user: dict) -> None:
    """A document may live in any shared folder, or in the caller's OWN
    Personal folder - never in someone else's (that would file it where only
    they can see it, which _get_readable then honors)."""
    if not folder_id:
        return
    folder = db.query(DocFolder).filter(DocFolder.id == folder_id).first()
    if not folder:
        raise HTTPException(400, "Folder not found")
    if folder.key == "personal" and folder.owner_email != user["email"]:
        raise HTTPException(403, "That is someone else's Personal folder")


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
    # Merge-field subject + company, same two ids DocumentUpdate already
    # carries. Without them a document generated straight from a template
    # (Nexus Sign's "start from a template") had no person and no company to
    # resolve {{full_name}} / {{company_address}} against, so the export kept
    # the raw tokens (Sagar, Sep 21).
    employeeId: Optional[str] = None
    entityId: Optional[str] = None


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
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "name is required")
    # Folders are picked from a flat <select>; two same-named entries are
    # indistinguishable there, so reject the twin rather than create it.
    clash = db.query(DocFolder).filter(DocFolder.name.ilike(name), DocFolder.owner_email == "").first()
    if clash:
        raise HTTPException(400, f'A folder named "{clash.name}" already exists')
    row = DocFolder(id=str(uuid.uuid4()), name=name, key="", is_system=False,
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
    # Company wall: once armed, a document owned by a company's person is private
    # to that company (untagged -> Global-Admin-only). Off = unchanged.
    import auth
    _scope = auth.company_scope(user, db)
    if _scope is not None:
        _emp = auth.company_of_email_map(db)
        rows = [d for d in rows if auth.company_ok(_emp.get((d.owner_email or "").lower(), ""), _scope)]
    statuses = _sign_statuses(db, rows)
    return [_ser_document(d, statuses.get(d.sign_request_id, "")) for d in rows]


@router.post("")
def create_document(body: DocumentIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if not body.title.strip():
        raise HTTPException(400, "title is required")
    _assert_folder_ok(db, body.folderId or "", user)
    now = _now_iso()
    content = body.content if body.content is not None else {}
    letterhead_id = ""
    merge_overrides = {}
    tpl = None
    # Starting from a template clones its content (and, if the template
    # requires one, its letterhead - falling back to the org default) rather
    # than just recording template_id as a label. It also seeds the template's
    # default merge-field values/custom variables (Phase 12) onto the new
    # document, so common defaults only need to be entered once, on the
    # template, not re-typed on every document created from it.
    if body.templateId:
        tpl = db.query(DocTemplate).filter(DocTemplate.id == body.templateId).first()
        if not tpl:
            raise HTTPException(404, "That template no longer exists. Pick another from the library.")
        if tpl.status != "active":
            # Requirement 3/20 - a draft is unfinished language and an archived
            # template is retired; neither is something to generate from.
            raise HTTPException(409, f'The template "{tpl.name}" is {tpl.status}, so it cannot be '
                                     f'used to create a document. Ask its department to activate it.')
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
                and not is_auto_token(fd.get("token"))
                and not (merge_overrides.get(fd.get("token")) or "").strip()
            ]
            if missing:
                raise HTTPException(422, f"Missing required field(s): {', '.join(missing)}")
            bad = _invalid_values(tpl.field_defs or [], merge_overrides)
            if bad:
                raise HTTPException(422, "; ".join(bad))
    # Requirement 7: "The generated output should be non-editable. The user
    # should not be able to freely modify the final generated document after
    # the template values have been populated."
    #
    # A document GENERATED from a template is therefore born final - the lock
    # is not something someone has to remember to apply afterwards, or the
    # guarantee is only as good as the person clicking. A document authored
    # from scratch is not generated output and starts as a draft, as before.
    # Unlock (POST /{did}/unlock) is the recorded way back for a typo.
    generated = bool(body.templateId)
    status = "final" if generated else "draft"
    row = Document(id=str(uuid.uuid4()), title=body.title.strip(), folder_id=body.folderId or "",
                    template_id=body.templateId or "",
                    employee_id=body.employeeId or "", entity_id=body.entityId or "",
                    template_version=(tpl.version or 1) if (generated and tpl) else 0,
                    content=content, letterhead_id=letterhead_id,
                    merge_overrides=merge_overrides,
                    status=status, owner_email=user["email"].lower(), tags=_clean_tags(body.tags or []), current_version=1,
                    created_by=user["email"], created_at=now, updated_by=user["email"], updated_at=now)
    db.add(row); db.flush()
    db.add(DocumentVersion(id=str(uuid.uuid4()), document_id=row.id, version_no=1, content=content,
                            edited_by=user["email"], edited_at=now,
                            note="Generated from template" if generated else "Created"))
    db.commit(); db.refresh(row)
    return _ser_document(row)


# ── Template ownership ───────────────────────────────────────────────────────
# Requirement 12: "Department heads should be able to manage the templates
# belonging to their respective departments." Templates carry the company's
# APPROVED language, so who may rewrite them is the whole point - before this,
# every template endpoint was guarded by get_current_user alone and any signed-in
# person could rewrite or delete the legal team's NDA.
#
#   administrator+  - every template, including company-wide ones
#   manager         - templates of their own department only
#   below manager   - read only
#
# Reading stays open to the whole company: a template nobody can find is a
# template nobody reuses, which is the behavior this module exists to fix.
_MANAGER_LEVEL = 3  # auth._LEVELS["manager"]


def _caller_department(db: Session, user: dict) -> str:
    row = (db.query(NexusEmployee.department)
           .filter(func.lower(NexusEmployee.work_email) == (user.get("email") or "").lower())
           .first())
    return (row[0] or "").strip() if row else ""


def _same_department(a: str, b: str) -> bool:
    return (a or "").strip().lower() == (b or "").strip().lower()


def _require_template_manager(db: Session, user: dict, department: str) -> None:
    """May this caller create or change a template owned by `department`?"""
    if user.get("level", 0) >= _ADMIN_LEVEL:
        return
    if user.get("level", 0) < _MANAGER_LEVEL:
        raise HTTPException(403, "Only department heads can manage templates")
    if not (department or "").strip():
        # Company-wide language is not any one department's to rewrite.
        raise HTTPException(403, "Only an administrator can manage a company-wide template")
    mine = _caller_department(db, user)
    if not mine or not _same_department(mine, department):
        raise HTTPException(403, f"This template belongs to {department}, not your department")


_CONTENT_TOKEN_RE = re.compile(r"\{\{\s*([a-z0-9_]+(?:\.[a-z0-9_]+)*)\s*\}\}")


def _template_tokens(t: DocTemplate) -> list:
    """Every {{variable}} the template actually uses, however it was written -
    the editor's mergeField nodes AND plain text (typed by hand, pasted, or
    imported from Word). `template.*` and `today` fill themselves, so they are
    never asked of anyone. Sorted, so the fill form's order is stable.

    Nexus Sign asks for these when a template is picked, which is why it is
    computed here rather than re-derived from the editor JSON in two clients."""
    found = set()

    def walk(node):
        if isinstance(node, dict):
            if node.get("type") == "mergeField":
                token = (node.get("attrs") or {}).get("token") or ""
                if token:
                    found.add(token)
            text = node.get("text")
            if isinstance(text, str):
                found.update(_CONTENT_TOKEN_RE.findall(text))
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(t.content if isinstance(t.content, dict) else {})
    return sorted(tk for tk in found if tk != "today" and not is_auto_token(tk))


def _ser_template(t: DocTemplate) -> dict:
    return {"id": t.id, "name": t.name, "category": t.category, "tags": t.tags or [],
            "content": t.content, "requiresLetterhead": t.requires_letterhead,
            "letterheadId": t.letterhead_id, "mergeOverrides": t.merge_overrides or {},
            "fieldDefs": t.field_defs or [],
            "tokens": _template_tokens(t),
            "department": t.department or "",
            "docType": t.doc_type or "document",
            "signerRoles": t.signer_roles or [],
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
    department: Optional[str] = None
    docType: Optional[str] = None
    signerRoles: Optional[List[dict]] = None
    status: Optional[str] = None


class TemplateUpdate(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    department: Optional[str] = None
    docType: Optional[str] = None
    signerRoles: Optional[List[dict]] = None
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


def _get_template(db: Session, tid: str) -> DocTemplate:
    row = db.query(DocTemplate).filter(DocTemplate.id == tid).first()
    if not row:
        raise HTTPException(404, "Template not found")
    return row


def _get_template_owned_or_admin(db: Session, tid: str, user: dict) -> DocTemplate:
    row = db.query(DocTemplate).filter(DocTemplate.id == tid).first()
    if not row:
        raise HTTPException(404, "Template not found")
    if user["level"] < _ADMIN_LEVEL and row.created_by != user["email"]:
        raise HTTPException(403, "You don't own this template")
    return row


@router.get("/variables")
def list_variables(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The variable library (requirements 5.1/5.2): everything a template author
    can insert, grouped, so nobody has to remember or hand-type a curly-brace
    token.

    Two sources, one list. The BUILT-INS this server resolves by itself from
    the subject person and company, and every CUSTOM variable the company's own
    templates already define - which is what makes the library grow with the
    library rather than needing a separate registry to maintain. A custom
    variable groups by the part before its first dot (`principal.amount` ->
    "principal"), which is the whole point of the dotted taxonomy.
    """
    seen = {}
    for token, label, group in BUILTIN_VARIABLES:
        seen[token] = {"token": token, "label": label, "group": group,
                       "description": "", "source": "builtin", "usedBy": []}
    for t in db.query(DocTemplate).filter(DocTemplate.status == "active").all():
        # A template declares its variables two ways: typed fields the wizard
        # asks for, and plain default values set on the template itself.
        tokens = {str(fd.get("token") or ""): (str(fd.get("label") or ""), str(fd.get("description") or ""))
                  for fd in (t.field_defs or []) if isinstance(fd, dict)}
        for key in (t.merge_overrides or {}):
            tokens.setdefault(str(key), ("", ""))
        for token, (label, description) in tokens.items():
            if not is_valid_token(token):
                continue
            entry = seen.get(token)
            if entry is None:
                entry = seen[token] = {
                    "token": token,
                    "label": label or token.split(".")[-1].replace("_", " ").title(),
                    "description": description,
                    "group": group_label(token_group(token)),
                    "source": "template", "usedBy": []}
            else:
                if label and entry["source"] == "template" and not entry["label"]:
                    entry["label"] = label
                if description and not entry.get("description"):
                    entry["description"] = description
            if t.name not in entry["usedBy"]:
                entry["usedBy"].append(t.name)
    # Built-ins first, then the company's own groups alphabetically - a browser
    # opens on the variables that always resolve.
    order = {"Person": 0, "Company": 1, "Document": 2}
    return sorted(seen.values(),
                  key=lambda v: (0 if v["source"] == "builtin" else 1,
                                 order.get(v["group"], 3), v["group"], v["token"]))


@router.post("/templates/migrate-sign-templates")
def migrate_sign_templates(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Bring the separate Nexus Sign templates into the one library.

    Two template systems existed because hr_sign_templates carried signer roles
    and the Documents library did not. It does now (signer_roles), so an e-sign
    template has nothing left that this library cannot hold, and requirement
    10/25 - "Nexus Sign is for signing, not template management" - can actually
    be met.

    What moves: the body (a list of plain strings) becomes real paragraphs,
    {{tokens}} in it become merge fields with typed definitions, and the signing
    roles become the template's default signers. The [[sign:role]] markers are
    dropped from the body - they are field PLACEHOLDERS, and fields are placed
    on the rendered PDF at send time.

    Idempotent, and non-destructive: the e-sign templates are left exactly as
    they are. Run it again after adding one and only the new one is copied.
    """
    if user.get("level", 0) < _ADMIN_LEVEL:
        raise HTTPException(403, "Only an administrator can migrate the signing templates")
    from models import HrSignTemplate
    existing = {(t.name or "").strip().lower() for t in db.query(DocTemplate).all()}
    now = _now_iso()
    moved, skipped = [], []
    for src in db.query(HrSignTemplate).filter(HrSignTemplate.status == "active").all():
        if (src.name or "").strip().lower() in existing:
            skipped.append(src.name)
            continue
        content, field_defs = _sign_body_to_content(src.body or [])
        row = DocTemplate(
            id=str(uuid.uuid4()), name=src.name, category="hr" if src.kind == "offer" else "legal",
            tags=["migrated-from-nexus-sign"], content=content, field_defs=field_defs,
            department="", doc_type="document",
            signer_roles=_clean_signer_roles(src.roles or []),
            # Draft, not active: migrated language is reviewed before anyone
            # generates from it. Requirement 3.
            status="draft", version=1, created_by=user["email"], created_at=now,
            updated_by=user["email"], updated_at=now)
        db.add(row); db.flush()
        db.add(DocTemplateVersion(id=str(uuid.uuid4()), template_id=row.id, version_no=1,
                                  content=content, edited_by=user["email"], edited_at=now,
                                  note=f"Migrated from the Nexus Sign template \"{src.name}\""))
        moved.append(src.name)
    db.commit()
    return {"migrated": moved, "skipped": skipped}


# [[sign:role]] / [[date:role]] / [[check:role:label]] - field placeholders in an
# e-sign body. They are not content: fields are placed on the rendered PDF at
# send time, so they are dropped rather than carried across as literal text.
_SIGN_MARKER_RE = re.compile(r"^\[\[(sign|date|initials|check|text)[^\]]*\]\]$")
_BODY_TOKEN_RE = re.compile(r"\{\{\s*([a-z0-9_.]+)\s*\}\}", re.I)


def _sign_body_to_content(body: list):
    """A list of plain paragraph strings -> Document Builder content, with
    {{tokens}} turned into real merge fields and typed definitions for them."""
    paragraphs, tokens = [], []
    for raw in body or []:
        line = str(raw or "")
        if _SIGN_MARKER_RE.match(line.strip()):
            continue
        inline, last = [], 0
        for m in _BODY_TOKEN_RE.finditer(line):
            token = m.group(1).lower()
            if not is_valid_token(token):
                continue
            if m.start() > last:
                inline.append({"type": "text", "text": line[last:m.start()]})
            inline.append({"type": "mergeField", "attrs": {"token": token}})
            if token not in tokens:
                tokens.append(token)
            last = m.end()
        if last < len(line):
            inline.append({"type": "text", "text": line[last:]})
        paragraphs.append({"type": "paragraph", **({"content": inline} if inline else {})})
    if not paragraphs:
        paragraphs = [{"type": "paragraph"}]
    content = {"pages": [{"id": "pg_migrated", "json": {"type": "doc", "content": paragraphs}}]}
    field_defs = _clean_field_defs([{
        "token": t,
        "label": t.split(".")[-1].replace("_", " ").title(),
        "type": "date" if t.endswith("date") or t == "today" else "text",
        "required": True,
    } for t in tokens])
    return content, field_defs


@router.get("/templates")
def list_templates(category: str = "", status: str = "", q: str = "", sort: str = "",
                    user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The template library. `sort=usage` puts the most-used first, which is
    what a picker wants: with 15-60 templates, the handful people actually send
    should be the ones at the top rather than whatever starts with "A"."""
    query = db.query(DocTemplate)
    if category:
        query = query.filter(DocTemplate.category == category)
    if status:
        query = query.filter(DocTemplate.status == status)
    if q:
        query = query.filter(DocTemplate.name.ilike(f"%{q.strip()}%"))
    rows = query.order_by(DocTemplate.name).all()
    # How many documents have actually been generated from each one. Counted in
    # a single grouped query, not per template.
    counts = dict(db.query(Document.template_id, func.count(Document.id))
                  .filter(Document.template_id != "")
                  .group_by(Document.template_id).all())
    out = [{**_ser_template(t), "usageCount": int(counts.get(t.id, 0))} for t in rows]
    if sort == "usage":
        out.sort(key=lambda t: (-t["usageCount"], t["name"].lower()))
    return out


@router.post("/templates")
def create_template(body: TemplateIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if not body.name.strip():
        raise HTTPException(400, "name is required")
    department = (body.department or "").strip()
    _require_template_manager(db, user, department)
    doc_type = body.docType or "document"
    if doc_type not in _TEMPLATE_TYPES:
        raise HTTPException(400, f"docType must be one of {', '.join(_TEMPLATE_TYPES)}")
    status = body.status or "active"
    if status not in _TEMPLATE_STATUSES:
        raise HTTPException(400, f"status must be one of {', '.join(_TEMPLATE_STATUSES)}")
    category = body.category or "general"
    if category not in _TEMPLATE_CATEGORIES:
        raise HTTPException(400, f"category must be one of {_TEMPLATE_CATEGORIES}")
    now = _now_iso()
    content = body.content if body.content is not None else {}
    row = DocTemplate(id=str(uuid.uuid4()), name=body.name.strip(), category=category,
                       tags=body.tags or [], content=content,
                       requires_letterhead=bool(body.requiresLetterhead), letterhead_id=body.letterheadId or "",
                       field_defs=_clean_field_defs(body.fieldDefs or []),
                       department=department, doc_type=doc_type,
                       signer_roles=_clean_signer_roles(body.signerRoles or []),
                       status=status, version=1, created_by=user["email"], created_at=now,
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
                            content={"pages": [{"id": str(uuid.uuid4()), "json": body}], "header": None, "footer": None},
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
    row = _get_template(db, tid)
    _require_template_manager(db, user, row.department)
    if body.department is not None and not _same_department(body.department, row.department):
        # Moving approved language between departments needs rights over BOTH
        # ends, or a department head could annex another department's template.
        _require_template_manager(db, user, (body.department or "").strip())
        row.department = (body.department or "").strip()
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
        # Was unvalidated - any string at all became the template's status,
        # so a typo could silently take a template out of the library.
        if body.status not in _TEMPLATE_STATUSES:
            raise HTTPException(400, f"status must be one of {', '.join(_TEMPLATE_STATUSES)}")
        row.status = body.status
    if body.signerRoles is not None:
        row.signer_roles = _clean_signer_roles(body.signerRoles)
    if body.docType is not None:
        if body.docType not in _TEMPLATE_TYPES:
            raise HTTPException(400, f"docType must be one of {', '.join(_TEMPLATE_TYPES)}")
        row.doc_type = body.docType
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
    row = _get_template(db, tid)
    _require_template_manager(db, user, row.department)
    # A template can be deleted out from under documents already generated
    # from it (Document.template_id is a plain string, no FK constraint) -
    # block it instead of silently orphaning those documents.
    if db.query(Document).filter(Document.template_id == tid).first():
        raise HTTPException(409, "Cannot delete a template that has generated documents - archive it instead")
    db.delete(row); db.commit()
    return {"ok": True}


@router.post("/templates/{tid}/duplicate")
def duplicate_template(tid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    src = _get_template(db, tid)
    _require_template_manager(db, user, src.department)
    now = _now_iso()
    row = DocTemplate(id=str(uuid.uuid4()), name=f"{src.name} (Copy)", category=src.category,
                       department=src.department or "", doc_type=src.doc_type or "document",
                       signer_roles=list(src.signer_roles or []),
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
    # Any employee can add their own letterhead (e.g. from the Document
    # Builder's letterhead picker) - only setting the org-wide DEFAULT is
    # admin-gated below, since that changes what every other document falls
    # back to.
    if not body.name.strip():
        raise HTTPException(400, "name is required")
    now = _now_iso()
    make_default = bool(body.isDefault) and user["level"] >= _ADMIN_LEVEL
    if make_default:
        db.query(DocLetterhead).update({DocLetterhead.is_default: False}, synchronize_session=False)
    row = DocLetterhead(id=str(uuid.uuid4()), name=body.name.strip(), logo_path=body.logoPath or "",
                         header_json=body.headerJson or {}, footer_json=body.footerJson or {},
                         address=body.address or "", is_default=make_default,
                         created_by=user["email"], created_at=now)
    db.add(row); db.commit(); db.refresh(row)
    return _ser_letterhead(row)


@router.patch("/letterheads/{lid}")
def update_letterhead(lid: str, body: LetterheadUpdate, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.query(DocLetterhead).filter(DocLetterhead.id == lid).first()
    if not row:
        raise HTTPException(404, "Letterhead not found")
    is_admin = user["level"] >= _ADMIN_LEVEL
    if not is_admin and row.created_by != user["email"]:
        raise HTTPException(403, "You can only edit letterheads you created")
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
    if body.isDefault is not None and body.isDefault and is_admin:
        db.query(DocLetterhead).update({DocLetterhead.is_default: False}, synchronize_session=False)
        row.is_default = True
    elif body.isDefault is not None and is_admin:
        row.is_default = False
    db.commit(); db.refresh(row)
    return _ser_letterhead(row)


@router.delete("/letterheads/{lid}")
def delete_letterhead(lid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.query(DocLetterhead).filter(DocLetterhead.id == lid).first()
    if row:
        if user["level"] < _ADMIN_LEVEL and row.created_by != user["email"]:
            raise HTTPException(403, "You can only delete letterheads you created")
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


def _get_readable(db: Session, did: str, user: dict) -> Document:
    """Fetch one document by id through the same walls _visible() puts on the
    list endpoints: the company wall (another company's document is 404,
    owner-derived) and the Personal-folder rule this module's header promises.

    Every by-id READ path goes through here. A document you cannot list must
    not be readable, version-browsable, exportable or copyable through its id
    either - the list filter alone only made personal drafts unenumerable, not
    private, and the ids travel (links, search results, an old bookmark).
    """
    row = db.query(Document).filter(Document.id == did).first()
    if not row:
        raise HTTPException(404, "Document not found")
    import auth
    auth.assert_company(auth.company_of(row.owner_email or "", db), user, db)
    if user["level"] >= _ADMIN_LEVEL or (row.owner_email or "") == user["email"].lower():
        return row
    # Mirrors _visible(): a shared system folder is org-visible, and only a
    # Personal folder is scoped - to its owner alone. 404 (not 403) so the
    # existence of someone else's personal draft stays unconfirmed.
    folder = db.query(DocFolder).filter(DocFolder.id == row.folder_id).first() if row.folder_id else None
    if folder is not None and folder.key == "personal" and folder.owner_email != user["email"]:
        raise HTTPException(404, "Document not found")
    return row


def _notify_owner(db: Session, row: Document, user: dict, title: str, body: str) -> None:
    """Bell the owner when SOMEONE ELSE (an administrator - nobody else gets
    through the write gate) archives or deletes their document. Server-side
    only, targeted at one recipient, never a broadcast - the items.py contract.
    Acting on your own document notifies nobody."""
    owner = (row.owner_email or "").strip().lower()
    if not owner or owner == user["email"].lower():
        return
    _hr_notify(db, owner, title, body, ref_id=row.id,
               requested_by=user["email"], action={"view": "documents", "sub": "documents-browse"})


def _get_owned_or_admin(db: Session, did: str, user: dict) -> Document:
    """Write gate - readable first (so another company's row is 404 rather than
    a 403 that confirms it exists), then ownership."""
    row = _get_readable(db, did, user)
    if user["level"] < _ADMIN_LEVEL and row.owner_email != user["email"].lower():
        raise HTTPException(403, "You don't own this document")
    return row


@router.get("/{did}")
def get_document(did: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = _get_readable(db, did, user)
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
        # The dotted taxonomy (principal.amount) as well as the undotted
        # built-ins - one shared validator, so a name the template editor
        # accepts is never silently dropped here.
        if not is_valid_token(token):
            continue
        ftype = d.get("type")
        if ftype not in _FIELD_TYPES:
            continue
        validation = d.get("validation") if isinstance(d.get("validation"), dict) else {}
        clean = {
            "token": token,
            "label": str(d.get("label") or token)[:200],
            "type": ftype,
            # Requirement 5's variable metadata: a description the library can
            # show, so someone browsing knows what a variable MEANS rather than
            # guessing from its name. Category defaults to the token's own
            # group, which is what the dotted taxonomy is for.
            "description": str(d.get("description") or "")[:500],
            "category": str(d.get("category") or token_group(token))[:80],
            "required": bool(d.get("required")),
            "default": str(d.get("default") or "")[:2000],
            "validation": {k: v for k, v in validation.items()
                          if k in ("maxLength", "regex", "min", "max", "minDate", "maxDate")},
        }
        if ftype in ("dropdown", "radio"):
            clean["options"] = [str(o)[:200] for o in (d.get("options") or []) if str(o).strip()][:50]
        by_token[token] = clean
    return list(by_token.values())


# Requirement 19: "Validate variable values before generation." The fill form
# checks these too, but a direct API call must not be able to put "not-an-email"
# into a document someone then signs. Deliberately the SAME small set the
# requirement lists - date, email, number, currency - rather than a validation
# framework nobody asked for.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s.]+\.[^@\s]+$")
_NON_NUMERIC_RE = re.compile(r"[^0-9.,\-]")


def _invalid_values(field_defs: list, values: dict) -> list:
    """Human-readable complaints about the supplied values, or []."""
    out = []
    for fd in field_defs or []:
        if not isinstance(fd, dict):
            continue
        token, ftype = fd.get("token"), fd.get("type")
        raw = (values.get(token) or "").strip()
        if not raw:
            continue                      # absent is the required guard's business, not ours
        label = fd.get("label") or token
        if ftype == "email" and not _EMAIL_RE.match(raw):
            out.append(f'"{label}" needs a valid email address')
        elif ftype in ("number", "currency"):
            # People write money the way people write money: "$1,000",
            # "INR 50,000", "₹12,00,000", "1 200,50". Strip the symbols, the
            # grouping and a currency code, then insist on a number - rather
            # than rejecting a figure that is perfectly clear to a reader.
            # Keep the digits and separators, drop everything else: a symbol,
            # a currency code, a stray space, whatever the browser's locale
            # formatter produced ("US$12,00,000.00" is a real value from an
            # en-IN browser). Anything with no number left in it still fails.
            cleaned = _NON_NUMERIC_RE.sub("", raw).replace(",", "")
            try:
                float(cleaned)
            except ValueError:
                out.append(f'"{label}" needs to be a number')
        elif ftype == "date":
            try:
                datetime.fromisoformat(raw)
            except ValueError:
                out.append(f'"{label}" needs to be a valid date')
    return out


_MAX_SIGNER_ROLES = 10


def _clean_signer_roles(roles) -> list:
    """[{key,label,order}] - who normally signs, in what order. Same shape the
    e-sign envelope already speaks, so the send step can use it as-is."""
    if not isinstance(roles, list):
        return []
    out, seen = [], set()
    for i, r in enumerate(roles):
        if not isinstance(r, dict):
            continue
        key = str(r.get("key") or "").strip().lower()[:40]
        if not key or key in seen or not re.fullmatch(r"[a-z0-9_]+", key):
            continue
        seen.add(key)
        out.append({"key": key,
                    "label": str(r.get("label") or key.replace("_", " ").title())[:80],
                    "order": int(r.get("order") or (i + 1))})
        if len(out) >= _MAX_SIGNER_ROLES:
            break
    return sorted(out, key=lambda r: r["order"])


def _clean_merge_overrides(overrides: dict) -> dict:
    """Same key-shape rule resolve_merge_data() already enforces at resolve
    time (services/merge_fields.py) - filtered again here defensively so a
    malformed key never gets stored in the first place, not just silently
    ignored later. Shared by Document and DocTemplate updates (Phase 11/12)."""
    return {
        k: str(v) for k, v in (overrides or {}).items()
        if is_valid_token(str(k)) and isinstance(v, (str, int, float)) and str(v) != ""
    }


def _touches_document_body(body: "DocumentUpdate") -> bool:
    """Does this update change what the document SAYS?

    Content and the merge values it was populated from are the document; the
    title, its folder, tags and the e-sign link are filing, and a final
    document still has to be movable, taggable and sendable. `status` is
    excluded on purpose - that is how a document gets archived, and how unlock
    sets it back to draft.
    """
    return (body.content is not None
            or body.mergeOverrides is not None
            or body.employeeId is not None
            or body.entityId is not None
            or body.letterheadId is not None)


@router.post("/{did}/unlock")
def unlock_document(did: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Take a final document back to draft so it can be amended.

    Deliberately its own endpoint rather than a PATCH of status: unlocking an
    approved output is a decision, and this way it leaves a mark. The version
    history gets an entry naming who unlocked it, so "why does this differ from
    the template" is always answerable from the document itself.
    """
    row = _get_owned_or_admin(db, did, user)
    if row.status != "final":
        raise HTTPException(409, "This document is not locked")
    row.status = "draft"
    row.current_version += 1
    db.add(DocumentVersion(id=str(uuid.uuid4()), document_id=row.id, version_no=row.current_version,
                            content=row.content, edited_by=user["email"], edited_at=_now_iso(),
                            note=f"Unlocked for editing by {user['email']}"))
    row.updated_by = user["email"]
    row.updated_at = _now_iso()
    db.commit(); db.refresh(row)
    return _ser_document(row)


@router.patch("/{did}")
def update_document(did: str, body: DocumentUpdate, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = _get_owned_or_admin(db, did, user)
    # A generated document is FINAL: the whole point of the module is that the
    # output carries the approved template language with the supplied values,
    # so it cannot be quietly reworded afterwards. Enforced here rather than
    # only in the editor - a read-only screen is a suggestion, and any other
    # client (or a tab left open before it was finalized) would walk straight
    # past it. Unlock is a deliberate, recorded act: POST /{did}/unlock.
    if row.status == "final" and _touches_document_body(body):
        raise HTTPException(409, "This document is final. Unlock it before editing.")
    if body.title is not None:
        if not body.title.strip():
            raise HTTPException(400, "title cannot be blank")
        row.title = body.title.strip()
    if body.folderId is not None:
        _assert_folder_ok(db, body.folderId, user)
        row.folder_id = body.folderId
    if body.tags is not None:
        row.tags = _clean_tags(body.tags)
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
    # Notify before the delete: after it there is no row left to read a title
    # or an owner off, and a permanent delete is exactly the event an owner
    # most needs to hear about.
    _notify_owner(db, row, user, "A draft of yours was deleted",
                  f'"{row.title}" was permanently deleted by {user["email"]}.')
    db.query(DocumentVersion).filter(DocumentVersion.document_id == did).delete()
    db.delete(row); db.commit()
    return {"ok": True}


@router.post("/{did}/archive")
def archive_document(did: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = _get_owned_or_admin(db, did, user)
    row.status = "archived"
    row.archived_at = _now_iso()
    row.updated_by = user["email"]; row.updated_at = _now_iso()
    _notify_owner(db, row, user, "A document of yours was archived",
                  f'"{row.title}" was archived by {user["email"]}. '
                  "You can restore it from My Documents -> Archived.")
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
    src = _get_readable(db, did, user)
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
    _get_readable(db, did, user)
    rows = db.query(DocumentVersion).filter(DocumentVersion.document_id == did).order_by(DocumentVersion.version_no.desc()).all()
    return [{"id": v.id, "versionNo": v.version_no, "editedBy": v.edited_by, "editedAt": v.edited_at, "note": v.note}
            for v in rows]


@router.get("/{did}/versions/{vid}")
def get_version(did: str, vid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Full content snapshot for one version - kept out of the list endpoint
    above so browsing history stays cheap; only fetched when a user opens it."""
    _get_readable(db, did, user)
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
    visibility as GET /{did} - read access, not ownership: anyone who may open
    the document may export it), resolve its merge data, walk header/body/footer
    to blocks, and fetch its letterhead (if any) serialized for the renderers."""
    row = _get_readable(db, did, user)
    # The template the document came from, so `template.*` resolves to what the
    # template actually says rather than whatever someone typed months ago.
    source_tpl = (db.query(DocTemplate).filter(DocTemplate.id == row.template_id).first()
                  if row.template_id else None)
    merge = resolve_merge_data(db, employee_id=row.employee_id, entity_id=row.entity_id,
                               overrides=row.merge_overrides or {}, template=source_tpl)
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
    footer_blocks = tiptap_to_blocks(content.get("footer"), merge)
    # Pages (each a real, independent unit - Document Builder's Pages panel).
    # Backward compat: a document saved before that rewrite has content.body
    # (one continuous doc) instead - treat it as a single page.
    raw_pages = content.get("pages")
    if isinstance(raw_pages, list) and raw_pages:
        pages_blocks = [tiptap_to_blocks(p.get("json") if isinstance(p, dict) else None, merge) for p in raw_pages]
    else:
        pages_blocks = [tiptap_to_blocks(content.get("body"), merge)]
    # Page Setup (Phase 14) - a sibling of body/header/footer in the same
    # content JSON, no schema change needed. Missing/unknown values fall back
    # to US Letter (_resolve_page_setup's own default).
    page_setup = content.get("pageSetup") if isinstance(content.get("pageSetup"), dict) else {}
    letterhead = None
    if row.letterhead_id:
        lh = db.query(DocLetterhead).filter(DocLetterhead.id == row.letterhead_id).first()
        if lh:
            letterhead = _ser_letterhead(lh)
    return row, header_blocks, pages_blocks, footer_blocks, letterhead, page_setup


@router.get("/{did}/export/pdf")
def export_document_pdf(did: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row, header_blocks, pages_blocks, footer_blocks, letterhead, page_setup = _export_prep(db, did, user)
    pdf_bytes = render_pdf(row.title, header_blocks, pages_blocks, footer_blocks, letterhead, page_setup)
    return Response(content=pdf_bytes, media_type="application/pdf",
                    headers={"Content-Disposition": _content_disposition(row.title, "pdf")})


@router.get("/{did}/export/docx")
def export_document_docx(did: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row, header_blocks, pages_blocks, footer_blocks, letterhead, page_setup = _export_prep(db, did, user)
    docx_bytes = render_docx(row.title, header_blocks, pages_blocks, footer_blocks, letterhead, page_setup)
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
