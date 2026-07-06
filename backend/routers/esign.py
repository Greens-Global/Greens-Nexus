"""Native E-Sign (HR Section C) — templates, ordered multi-party signing,
tokenized external links, and a tamper-evident certificate of completion.

Design notes:
- Two document sources: authored templates ({{merge}} tokens + [[field:role]]
  slots, resolved and FROZEN into body_snapshot at send time) and uploaded PDFs
  (fields placed at normalized page coordinates, stamped via a reportlab overlay
  merged with pypdf).
- Signing order: only the party whose ordinal == request.current_order may sign.
  Each completed signature advances current_order and notifies the next party
  (bell + Graph email for internal, Graph email with a public link for external).
- Legal-grade (ESIGN/UETA): explicit consent checkbox (versioned text), IP,
  user-agent and timestamps captured per party, immutable HrSignEvent audit
  trail, and a Certificate of Completion page sealed into the final PDF whose
  SHA-256 is stored for tamper evidence.
- Public endpoints are token-authenticated only (secrets.token_urlsafe(32));
  they never expose other parties' emails.
"""
import base64
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File, Form
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List
import httpx

from database import get_db
from auth import get_current_user
from models import (HrSignTemplate, HrSignRequest, HrSignParty, HrSignEvent,
                    HrDocument, HrEntity, HrCandidate, NexusEmployee)
# Reuse the HR module's storage/Graph/notification plumbing — same bucket, same
# service key, same bell. hr.py owns those constants; do not duplicate them.
from routers.hr import (require_hr_read, require_hr_write, require_hr_delete,
                        _storage_headers, _graph_token, _hr_notify,
                        _SUPABASE_URL, _DOC_BUCKET)

router = APIRouter(prefix="/esign", tags=["esign"])

_APP_URL = os.getenv("NEXUS_APP_URL", "https://dev.nexus.greensglobal.com")

_TEMPLATE_KINDS = ("offer", "nda", "direct_deposit", "handbook_ack", "w9",
                   "contractor_agreement", "sow", "custom")
_MAX_PDF_BYTES = 15 * 1024 * 1024
_MAX_SIG_BYTES = 200 * 1024          # decoded PNG cap for drawn signatures

# ESIGN/UETA consent — shown verbatim to every signer; version stamped per party
# so we can prove exactly what they agreed to even if the wording evolves.
_CONSENT_VERSION = "1.0-2026-07"
_CONSENT_TEXT = (
    "I agree to use electronic records and signatures for this document, and I "
    "confirm that I can access and retain a copy of it. My electronic signature "
    "is the legal equivalent of my handwritten signature."
)

_MERGE_RE = re.compile(r"\{\{([a-z0-9_]+)\}\}")
_FIELD_RE = re.compile(r"\[\[(sign|initials|date|text|check):([a-z0-9_]+)(?::([^\]]*))?\]\]")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pesc(s) -> str:
    """Escape a user string for reportlab Paragraph markup. reportlab's paraparser
    treats <...> and & as XML — an unescaped name/title/typed-signature (e.g.
    'Ben & Co', 'a<b') otherwise CRASHES sealing and permanently bricks the
    envelope (nothing is committed, so every retry re-crashes)."""
    from xml.sax.saxutils import escape
    return escape(str(s or ""))


def _strip_port(addr: str) -> str:
    """Azure's x-forwarded-for carries the client port ('1.2.3.4:56789',
    '[::1]:443') — an audit trail wants the address only."""
    addr = (addr or "").strip()
    if addr.startswith("["):                      # bracketed IPv6
        return addr.split("]")[0].lstrip("[")
    if addr.count(":") == 1:                      # IPv4:port (bare IPv6 has 2+)
        return addr.split(":")[0]
    return addr


def _client_meta(request: Optional[Request]) -> tuple:
    """(ip, user_agent) — x-forwarded-for first (Azure sits behind a proxy)."""
    if request is None:
        return "", ""
    fwd = request.headers.get("x-forwarded-for", "")
    ip = _strip_port(fwd.split(",")[0] if fwd else (request.client.host if request.client else ""))
    return ip, request.headers.get("user-agent", "")[:300]


def _log(db: Session, request_id: str, type: str, detail: str = "",
         party_id: str = "", ip: str = "", user_agent: str = "") -> None:
    db.add(HrSignEvent(id=str(uuid.uuid4()), request_id=request_id, party_id=party_id,
                       type=type, detail=detail[:500], ip=ip, user_agent=user_agent,
                       at=_now_iso()))


# ── Serializers (camelCase, matching the hr.py idiom) ─────────────────────────

def _ser_template(t: HrSignTemplate) -> dict:
    return {"id": t.id, "name": t.name, "kind": t.kind, "entityId": t.entity_id,
            "body": t.body or [], "roles": t.roles or [],
            "attachments": t.attachments or [], "status": t.status,
            "createdBy": t.created_by, "createdAt": t.created_at, "updatedAt": t.updated_at}


def _ser_party(p: HrSignParty, include_email: bool = True) -> dict:
    out = {"id": p.id, "roleKey": p.role_key, "name": p.name, "kind": p.kind,
           "ordinal": p.ordinal, "status": p.status, "signedAt": p.signed_at,
           "viewedAt": p.viewed_at, "declineReason": p.decline_reason,
           "signatureKind": p.signature_kind,
           "partyRole": p.party_role or "signer"}
    if include_email:
        out["email"] = p.email
        out["hasAccessCode"] = bool((p.access_code or "").strip())
    return out


def _ser_request(r: HrSignRequest, parties: Optional[List[HrSignParty]] = None,
                 events: Optional[List[HrSignEvent]] = None) -> dict:
    out = {"id": r.id, "title": r.title, "source": r.source, "templateId": r.template_id,
           "employeeId": r.employee_id, "candidateId": r.candidate_id, "entityId": r.entity_id,
           "status": r.status, "currentOrder": r.current_order, "message": r.message,
           "routing": r.routing or "sequential",
           "expiresOn": r.expires_on, "createdBy": r.created_by, "createdAt": r.created_at,
           "completedAt": r.completed_at, "finalSha256": r.final_sha256,
           "hasFinalPdf": bool(r.final_pdf_path)}
    if parties is not None:
        out["parties"] = [_ser_party(p) for p in sorted(parties, key=lambda x: x.ordinal)]
    if events is not None:
        out["events"] = [{"id": e.id, "partyId": e.party_id, "type": e.type,
                          "detail": e.detail, "ip": e.ip, "at": e.at} for e in events]
    return out


# ── Merge-field resolution ────────────────────────────────────────────────────

def _merge_data(db: Session, employee_id: str, candidate_id: str, entity_id: str,
                overrides: dict) -> dict:
    """Merge dict for {{token}} resolution. Subject person + company + overrides
    (overrides win — e.g. salary is typed by the sender, never read from the
    hr_comp-restricted compensation column)."""
    data = {"today": datetime.now(timezone.utc).strftime("%B %d, %Y")}
    if employee_id:
        e = db.query(NexusEmployee).filter(NexusEmployee.id == employee_id).first()
        if e:
            data.update({
                "first_name": e.first_name, "last_name": e.last_name,
                "full_name": f"{e.first_name} {e.last_name}".strip(),
                "email": e.work_email or e.personal_email, "work_email": e.work_email,
                "personal_email": e.personal_email, "phone": e.phone,
                "job_title": e.job_title, "department": e.department,
                "start_date": e.start_date, "location": e.location,
                "employee_code": e.employee_code, "manager": e.manager_email,
            })
    if candidate_id:
        c = db.query(HrCandidate).filter(HrCandidate.id == candidate_id).first()
        if c:
            data.update({
                "first_name": c.first_name, "last_name": c.last_name,
                "full_name": f"{c.first_name} {c.last_name}".strip(),
                "email": c.email, "phone": c.phone, "job_title": c.role_title,
                "department": c.department, "start_date": c.expected_start,
            })
    if entity_id:
        en = db.query(HrEntity).filter(HrEntity.id == entity_id).first()
        if en:
            data.update({"company": en.name, "company_legal": en.legal_name or en.name,
                         "company_address": en.registered_address, "signatory": en.signatory})
    for k, v in (overrides or {}).items():
        if isinstance(v, (str, int, float)) and re.fullmatch(r"[a-z0-9_]+", str(k)):
            data[str(k)] = str(v)
    return {k: str(v) for k, v in data.items() if v}


def _resolve_body(body: list, merge: dict) -> tuple:
    """Replace {{tokens}}; keep [[field]] tokens verbatim (resolved at sign/finalize).
    Returns (resolved_paragraphs, unresolved_token_names)."""
    unresolved, out = set(), []
    for para in body or []:
        def sub(m):
            key = m.group(1)
            if key in merge:
                return merge[key]
            unresolved.add(key)
            return m.group(0)
        out.append(_MERGE_RE.sub(sub, str(para)))
    return out, sorted(unresolved)


def _fields_in_body(body: list) -> List[dict]:
    """Extract [[field:role(:label)]] tokens → [{type, role, label}]."""
    found = []
    for para in body or []:
        for m in _FIELD_RE.finditer(str(para)):
            found.append({"type": m.group(1), "role": m.group(2), "label": m.group(3) or ""})
    return found


# ── Turn / expiry helpers ─────────────────────────────────────────────────────

def _check_expiry(db: Session, req: HrSignRequest) -> None:
    """Lazy expiry — flip a stale pending envelope to expired on any access."""
    if req.status == "pending" and req.expires_on:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if today > req.expires_on:
            req.status = "expired"
            _log(db, req.id, "expired", f"expired on {req.expires_on}")
            db.commit()


def _parties(db: Session, request_id: str) -> List[HrSignParty]:
    return (db.query(HrSignParty).filter(HrSignParty.request_id == request_id)
            .order_by(HrSignParty.ordinal).all())


def _its_their_turn(req: HrSignRequest, party: HrSignParty) -> bool:
    if req.status != "pending" or (party.party_role or "signer") != "signer" \
            or party.status not in ("waiting", "notified", "viewed"):
        return False
    # Parallel envelopes have no order — every unsigned signer may sign now.
    if (req.routing or "sequential") == "parallel":
        return True
    return party.ordinal == req.current_order


# ── Notifications (bell + branded Graph email) ────────────────────────────────

def _sign_email_html(party: HrSignParty, req: HrSignRequest, sender_name: str, link: str) -> str:
    from html import escape
    return f"""<div style="font-family:Inter,Segoe UI,Arial,sans-serif;background:#f3f4f6;padding:28px 12px">
  <table style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border-collapse:collapse;width:100%">
    <tr><td style="background:#14532d;padding:26px 36px">
      <div style="color:#ffffff;font-size:19px;font-weight:800">Greens Global</div>
      <div style="color:#bbf7d0;font-size:12.5px;margin-top:4px">Signature requested</div>
    </td></tr>
    <tr><td style="padding:28px 36px">
      <p style="margin:0 0 14px;font-size:14.5px;color:#111827">Hi {escape(party.name or 'there')},</p>
      <p style="margin:0 0 14px;font-size:14px;color:#374151;line-height:1.6">
        {escape(sender_name)} has requested your signature on
        <strong>{escape(req.title)}</strong>.
        {('<br/><em>' + escape(req.message) + '</em>') if req.message else ''}
      </p>
      <p style="margin:22px 0"><a href="{link}"
        style="background:#15803d;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 26px;border-radius:9px;display:inline-block">
        Review &amp; sign</a></p>
      <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.6">
        {('This request expires on ' + escape(req.expires_on) + '. ') if req.expires_on else ''}
        The link is unique to you — please don't forward it.</p>
    </td></tr>
    <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 36px;font-size:11.5px;color:#6b7280;line-height:1.5">
      Sent via Greens Nexus e-sign. This mailbox isn't monitored.
    </td></tr>
  </table>
</div>"""


def _send_sign_email(party: HrSignParty, req: HrSignRequest, sender_name: str) -> tuple:
    sender = os.getenv("NEXUS_FROM_EMAIL", "")
    if not (party.email and sender):
        return False, "no recipient email" if not party.email else "NEXUS_FROM_EMAIL not set"
    link = (f"{_APP_URL}/sign/{party.token}" if party.kind == "external"
            else f"{_APP_URL}/hr/hr-esign")
    try:
        resp = httpx.post(f"https://graph.microsoft.com/v1.0/users/{sender}/sendMail",
                          headers={"Authorization": f"Bearer {_graph_token()}"}, json={
            "message": {
                "subject": f"Signature requested: {req.title}",
                "body": {"contentType": "HTML", "content": _sign_email_html(party, req, sender_name, link)},
                "toRecipients": [{"emailAddress": {"address": party.email}}],
            }, "saveToSentItems": False}, timeout=20)
        return resp.is_success, ("" if resp.is_success else resp.text[:300])
    except Exception as e:
        return False, str(getattr(e, "detail", e))[:300]


def _send_completed_email(party: HrSignParty, req: HrSignRequest) -> tuple:
    """Everyone-signed email for external parties (signers and CC) — their link
    now serves the sealed copy, which is how they retain it (ESIGN retention)."""
    from html import escape
    sender = os.getenv("NEXUS_FROM_EMAIL", "")
    if not (party.email and sender):
        return False, "no recipient email" if not party.email else "NEXUS_FROM_EMAIL not set"
    link = f"{_APP_URL}/sign/{party.token}"
    html = f"""<div style="font-family:Inter,Segoe UI,Arial,sans-serif;background:#f3f4f6;padding:28px 12px">
  <table style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border-collapse:collapse;width:100%">
    <tr><td style="background:#14532d;padding:26px 36px">
      <div style="color:#ffffff;font-size:19px;font-weight:800">Greens Global</div>
      <div style="color:#bbf7d0;font-size:12.5px;margin-top:4px">Document completed</div>
    </td></tr>
    <tr><td style="padding:28px 36px">
      <p style="margin:0 0 14px;font-size:14.5px;color:#111827">Hi {escape(party.name or 'there')},</p>
      <p style="margin:0 0 14px;font-size:14px;color:#374151;line-height:1.6">
        Everyone has signed <strong>{escape(req.title)}</strong>. Your copy of the sealed
        document (with its Certificate of Completion) is ready.</p>
      <p style="margin:22px 0"><a href="{link}"
        style="background:#15803d;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 26px;border-radius:9px;display:inline-block">
        View &amp; download</a></p>
      <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.6">
        The link is unique to you — please don't forward it.</p>
    </td></tr>
    <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 36px;font-size:11.5px;color:#6b7280;line-height:1.5">
      Sent via Greens Nexus e-sign. This mailbox isn't monitored.
    </td></tr>
  </table>
</div>"""
    try:
        resp = httpx.post(f"https://graph.microsoft.com/v1.0/users/{sender}/sendMail",
                          headers={"Authorization": f"Bearer {_graph_token()}"}, json={
            "message": {
                "subject": f"Completed: {req.title}",
                "body": {"contentType": "HTML", "content": html},
                "toRecipients": [{"emailAddress": {"address": party.email}}],
            }, "saveToSentItems": False}, timeout=20)
        return resp.is_success, ("" if resp.is_success else resp.text[:300])
    except Exception as e:
        return False, str(getattr(e, "detail", e))[:300]


def _notify_party(db: Session, party: HrSignParty, req: HrSignRequest, sender_name: str) -> None:
    """Tell a party it's their turn. Bell for internal, email for both (best-effort —
    an email hiccup must never lose the envelope; the event log records it)."""
    if party.kind == "internal":
        _hr_notify(db, party.email, f"Signature required: {req.title}",
                   f"{sender_name} sent you \"{req.title}\" to sign. Open HR → E-Sign.",
                   ref_id=req.id, requested_by=sender_name,
                   action={"view": "hr", "sub": "hr-esign"})
    ok, detail = _send_sign_email(party, req, sender_name)
    _log(db, req.id, "sent",
         f"notified {party.name} ({party.kind})" + ("" if ok else f" — email failed: {detail}"),
         party_id=party.id)
    party.status = "notified"


# ── Templates CRUD ────────────────────────────────────────────────────────────

class TemplateIn(BaseModel):
    name:        str
    kind:        Optional[str] = "custom"
    entity_id:   Optional[str] = ""
    body:        Optional[list] = None
    roles:       Optional[list] = None
    attachments: Optional[list] = None   # [{name, path, pages, fields:[...]}]
    status:      Optional[str] = "active"


@router.get("/templates")
def list_templates(user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    rows = db.query(HrSignTemplate).order_by(HrSignTemplate.name).all()
    return [_ser_template(t) for t in rows]


@router.post("/templates")
def create_template(body: TemplateIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    if not body.name.strip():
        raise HTTPException(400, "name is required")
    if body.kind not in _TEMPLATE_KINDS:
        raise HTTPException(400, f"kind must be one of {_TEMPLATE_KINDS}")
    now = _now_iso()
    row = HrSignTemplate(id=str(uuid.uuid4()), name=body.name.strip(), kind=body.kind or "custom",
                         entity_id=body.entity_id or "", body=body.body or [], roles=body.roles or [],
                         attachments=body.attachments or [],
                         status=body.status or "active", created_by=user["email"],
                         created_at=now, updated_at=now)
    db.add(row); db.commit(); db.refresh(row)
    return _ser_template(row)


@router.patch("/templates/{tid}")
def update_template(tid: str, body: TemplateIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    row = db.query(HrSignTemplate).filter(HrSignTemplate.id == tid).first()
    if not row:
        raise HTTPException(404, "Template not found")
    if body.kind and body.kind not in _TEMPLATE_KINDS:
        raise HTTPException(400, f"kind must be one of {_TEMPLATE_KINDS}")
    row.name = body.name.strip() or row.name
    row.kind = body.kind or row.kind
    row.entity_id = body.entity_id if body.entity_id is not None else row.entity_id
    if body.body is not None:
        row.body = body.body
    if body.roles is not None:
        row.roles = body.roles
    if body.attachments is not None:
        row.attachments = body.attachments
    row.status = body.status or row.status
    row.updated_at = _now_iso()
    db.commit(); db.refresh(row)
    return _ser_template(row)


@router.delete("/templates/{tid}")
def delete_template(tid: str, user: dict = Depends(require_hr_delete), db: Session = Depends(get_db)):
    row = db.query(HrSignTemplate).filter(HrSignTemplate.id == tid).first()
    if row:
        db.delete(row); db.commit()
    return {"ok": True}


_STARTER_TEMPLATES = [
    {"name": "Offer Letter", "kind": "offer",
     "roles": [{"key": "company", "label": "Company representative", "order": 1},
               {"key": "employee", "label": "Employee / candidate", "order": 2}],
     "body": [
         "{{today}}",
         "Dear {{first_name}},",
         "We are delighted to offer you the position of {{job_title}} at {{company}}. Your anticipated start date is {{start_date}}, and your starting compensation will be {{salary}}.",
         "This offer is contingent on the successful completion of our standard background verification and your continued eligibility to work. Your employment will be governed by the policies of {{company_legal}}.",
         "We are excited to have you join the team — please confirm your acceptance by signing below.",
         "For {{company}}:",
         "[[sign:company]]",
         "[[date:company]]",
         "Accepted and agreed:",
         "[[sign:employee]]",
         "[[date:employee]]",
     ]},
    {"name": "Non-Disclosure Agreement", "kind": "nda",
     "roles": [{"key": "employee", "label": "Recipient", "order": 1}],
     "body": [
         "NON-DISCLOSURE AGREEMENT",
         "This Agreement is made on {{today}} between {{company_legal}} (the \"Company\") and {{full_name}} (the \"Recipient\").",
         "The Recipient agrees to hold in strict confidence all non-public business, financial, technical and personnel information of the Company and its affiliates, to use it solely for the performance of their duties, and not to disclose it to any third party without prior written consent.",
         "This obligation survives the end of the Recipient's engagement with the Company.",
         "[[check:employee:I have read and understood this agreement]]",
         "[[sign:employee]]",
         "[[date:employee]]",
     ]},
    {"name": "Handbook Acknowledgment", "kind": "handbook_ack",
     "roles": [{"key": "employee", "label": "Employee", "order": 1}],
     "body": [
         "EMPLOYEE HANDBOOK ACKNOWLEDGMENT",
         "I, {{full_name}}, acknowledge that I have received access to the {{company}} Employee Handbook, and that I have read, understood, and agree to abide by the policies it contains.",
         "I understand the handbook is not an employment contract and that the Company may revise its policies at any time.",
         "[[check:employee:I acknowledge the above]]",
         "[[sign:employee]]",
         "[[date:employee]]",
     ]},
]


@router.post("/templates/starters")
def seed_starter_templates(user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Add the three standard templates if missing (EntitiesModal seedDefaults idiom)."""
    existing = {t.name for t in db.query(HrSignTemplate).all()}
    now = _now_iso(); added = []
    for t in _STARTER_TEMPLATES:
        if t["name"] in existing:
            continue
        db.add(HrSignTemplate(id=str(uuid.uuid4()), name=t["name"], kind=t["kind"],
                              entity_id="", body=t["body"], roles=t["roles"], status="active",
                              created_by=user["email"], created_at=now, updated_at=now))
        added.append(t["name"])
    db.commit()
    return {"added": added}


@router.post("/templates/attachments")
def upload_template_attachment(file: UploadFile = File(...), user: dict = Depends(require_hr_write)):
    """Upload a PDF to be attached to a template (multi-document packet). Returns
    {name, path, pages}; the frontend adds it to the template's attachments list."""
    if (file.content_type or "") not in ("application/pdf", "application/octet-stream"):
        raise HTTPException(400, "Only PDF files can be attached")
    blob = file.file.read()
    if not blob or len(blob) > _MAX_PDF_BYTES:
        raise HTTPException(400, "PDF is empty or larger than 15 MB")
    try:
        from pypdf import PdfReader
        pages = len(PdfReader(io.BytesIO(blob)).pages)
        if pages == 0:
            raise ValueError("no pages")
    except Exception:
        raise HTTPException(400, "This PDF can't be processed — it may be corrupt or password-protected.")
    safe = re.sub(r"[^a-zA-Z0-9._-]", "_", file.filename or "document.pdf")
    path = f"esign/templates/{uuid.uuid4()}-{safe}"
    up = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/{_DOC_BUCKET}/{path}",
                    headers={**_storage_headers(), "Content-Type": "application/pdf"},
                    content=blob, timeout=60)
    if not up.is_success:
        raise HTTPException(502, f"Storage upload failed: {up.text[:200]}")
    return {"name": (file.filename or "document.pdf"), "path": path, "pages": pages, "fields": []}


@router.get("/templates/attachment-url")
def template_attachment_url(path: str, user: dict = Depends(require_hr_read)):
    """Short-lived signed URL to render an attached PDF in the field placer."""
    if not path.startswith("esign/"):
        raise HTTPException(400, "Invalid attachment path")
    resp = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/sign/{_DOC_BUCKET}/{path}",
                      headers=_storage_headers(), json={"expiresIn": 300}, timeout=20)
    if not resp.is_success:
        raise HTTPException(502, "Could not create the preview link")
    return {"url": f"{_SUPABASE_URL}/storage/v1{resp.json()['signedURL']}", "expiresIn": 300}


# ── Create + send an envelope ─────────────────────────────────────────────────

class PartyIn(BaseModel):
    role_key:    str
    name:        str
    email:       str
    kind:        Optional[str] = "internal"  # internal|external
    ordinal:     Optional[int] = 1
    party_role:  Optional[str] = "signer"    # signer | cc (gets the sealed copy, never signs)
    access_code: Optional[str] = ""          # external signers only — code the link asks for


class SendIn(BaseModel):
    template_id:  str
    title:        Optional[str] = ""
    employee_id:  Optional[str] = ""
    candidate_id: Optional[str] = ""
    entity_id:    Optional[str] = ""
    message:      Optional[str] = ""
    expires_on:   Optional[str] = ""
    routing:      Optional[str] = "sequential"   # sequential | parallel
    merge:        Optional[dict] = None      # sender-typed overrides (e.g. salary)
    parties:      List[PartyIn]


def _validate_parties(parties: List[PartyIn], needed_roles: set) -> None:
    signers = [p for p in parties if (p.party_role or "signer") == "signer"]
    if not signers:
        raise HTTPException(400, "At least one signing party is required")
    seen_roles = set()
    for p in parties:
        if not (p.email or "").strip() or "@" not in p.email:
            raise HTTPException(400, f"Party \"{p.name}\" needs a valid email")
        if not (p.name or "").strip():
            raise HTTPException(400, "Every party needs a name")
        if p.kind not in ("internal", "external"):
            raise HTTPException(400, "party kind must be internal or external")
        if (p.party_role or "signer") not in ("signer", "cc"):
            raise HTTPException(400, "party_role must be signer or cc")
        if (p.access_code or "").strip() and len(p.access_code.strip()) > 40:
            raise HTTPException(400, "Access codes are limited to 40 characters")
        if (p.party_role or "signer") == "signer":
            seen_roles.add(p.role_key)
    missing = needed_roles - seen_roles
    if missing:
        raise HTTPException(400, f"No party assigned for role(s): {', '.join(sorted(missing))}")


def _validate_routing(routing: str) -> str:
    r = (routing or "sequential").strip()
    if r not in ("sequential", "parallel"):
        raise HTTPException(400, "routing must be sequential or parallel")
    return r


def _create_request(db: Session, user: dict, *, title: str, source: str, template_id: str,
                    employee_id: str, candidate_id: str, entity_id: str, body_snapshot: list,
                    pdf_storage_path: str, fields: list, message: str, expires_on: str,
                    parties: List[PartyIn], ip: str, user_agent: str,
                    documents: Optional[list] = None, routing: str = "sequential") -> dict:
    now = _now_iso()
    ordered = sorted(parties, key=lambda p: p.ordinal or 1)
    signer_ordinals = [p.ordinal or 1 for p in ordered if (p.party_role or "signer") == "signer"]
    req = HrSignRequest(id=str(uuid.uuid4()), title=title, source=source, template_id=template_id,
                        employee_id=employee_id or "", candidate_id=candidate_id or "",
                        entity_id=entity_id or "", body_snapshot=body_snapshot,
                        pdf_storage_path=pdf_storage_path, fields=fields, status="pending",
                        documents=documents or [], routing=routing,
                        current_order=min(signer_ordinals), message=message or "",
                        expires_on=expires_on or "", created_by=user["email"],
                        created_at=now)
    db.add(req)
    rows = []
    for p in ordered:
        rows.append(HrSignParty(id=str(uuid.uuid4()), request_id=req.id, role_key=p.role_key,
                                name=p.name.strip(), email=p.email.strip().lower(),
                                kind=p.kind or "internal", ordinal=p.ordinal or 1,
                                party_role=p.party_role or "signer",
                                access_code=(p.access_code or "").strip(),
                                status="waiting", token=secrets.token_urlsafe(32)))
        db.add(rows[-1])
    _log(db, req.id, "created",
         f"by {user['email']} — {len(rows)} parties ({routing})", ip=ip, user_agent=user_agent)
    sender_name = user["email"].split("@")[0].replace(".", " ").title()
    # Sequential: only the first signer hears about it now. Parallel: every
    # signer is invited at once. CC parties hear at completion, not at send.
    signers = [r for r in rows if r.party_role == "signer"]
    to_notify = signers if routing == "parallel" else signers[:1]
    for r in to_notify:
        _notify_party(db, r, req, sender_name)
    db.commit()
    return _ser_request(req, parties=_parties(db, req.id))


@router.post("/requests")
def send_request(body: SendIn, request: Request, user: dict = Depends(require_hr_write),
                 db: Session = Depends(get_db)):
    """Template-sourced envelope: resolve merges, freeze the snapshot, create the
    ordered parties, notify the first."""
    tpl = db.query(HrSignTemplate).filter(HrSignTemplate.id == body.template_id).first()
    if not tpl:
        raise HTTPException(404, "Template not found")
    merge = _merge_data(db, body.employee_id or "", body.candidate_id or "",
                        body.entity_id or tpl.entity_id or "", body.merge or {})
    snapshot, unresolved = _resolve_body(tpl.body or [], merge)
    if unresolved:
        raise HTTPException(400, f"Unresolved merge fields: {', '.join('{{' + u + '}}' for u in unresolved)}. "
                                 f"Fill them in the send form or pick a person with that data.")
    # Roles must cover the body's tokens AND every field placed on attached PDFs;
    # the whole packet travels as one envelope, frozen at send time.
    attachments = [{"name": a.get("name", "document.pdf"), "path": a.get("path", ""),
                    "fields": a.get("fields") or []}
                   for a in (tpl.attachments or []) if a.get("path")]
    needed_roles = {f["role"] for f in _fields_in_body(snapshot)}
    for a in attachments:
        needed_roles |= {f.get("role", "") for f in a["fields"]}
    needed_roles.discard("")
    _validate_parties(body.parties, needed_roles)
    routing = _validate_routing(body.routing)
    ip, ua = _client_meta(request)
    return _create_request(db, user, title=(body.title or tpl.name).strip(), source="template",
                           template_id=tpl.id, employee_id=body.employee_id or "",
                           candidate_id=body.candidate_id or "",
                           entity_id=body.entity_id or tpl.entity_id or "",
                           body_snapshot=snapshot, pdf_storage_path="", fields=[],
                           message=body.message or "", expires_on=body.expires_on or "",
                           parties=body.parties, ip=ip, user_agent=ua,
                           documents=attachments, routing=routing)


@router.post("/requests/pdf")
def send_pdf_request(request: Request, file: UploadFile = File(...), payload: str = Form(...),
                     user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """PDF-sourced envelope: upload the source, store field boxes (normalized page
    coords), create parties. payload = JSON {title, employeeId?, candidateId?,
    entityId?, message?, expiresOn?, fields:[{id,role,type,page,x,y,w,h,required}],
    parties:[{roleKey,name,email,kind,ordinal}]}."""
    try:
        data = json.loads(payload)
    except Exception:
        raise HTTPException(400, "payload must be valid JSON")
    if (file.content_type or "") not in ("application/pdf", "application/octet-stream"):
        raise HTTPException(400, "Only PDF files can be sent for signature")
    blob = file.file.read()
    if not blob or len(blob) > _MAX_PDF_BYTES:
        raise HTTPException(400, "PDF is empty or larger than 15 MB")
    # Validate NOW with the same parser finalize uses — a corrupt PDF must be
    # rejected at send time, not when the last signer hits Finish.
    try:
        from pypdf import PdfReader
        page_count = len(PdfReader(io.BytesIO(blob)).pages)
        if page_count == 0:
            raise ValueError("no pages")
    except Exception:
        raise HTTPException(400, "This PDF can't be processed — it may be corrupt or password-protected. "
                                 "Re-export it (e.g. print to PDF) and try again.")
    fields = data.get("fields") or []
    if not fields:
        raise HTTPException(400, "Place at least one field on the document")
    for f in fields:
        if f.get("type") not in ("sign", "initials", "date", "text", "check"):
            raise HTTPException(400, f"Unknown field type: {f.get('type')}")
    parties = [PartyIn(role_key=p.get("roleKey", ""), name=p.get("name", ""),
                       email=p.get("email", ""), kind=p.get("kind", "internal"),
                       ordinal=int(p.get("ordinal") or 1),
                       party_role=p.get("partyRole", "signer"),
                       access_code=p.get("accessCode", "")) for p in (data.get("parties") or [])]
    _validate_parties(parties, {f.get("role", "") for f in fields})
    routing = _validate_routing(data.get("routing", "sequential"))

    path = f"esign/{uuid.uuid4()}/source.pdf"
    up = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/{_DOC_BUCKET}/{path}",
                    headers={**_storage_headers(), "Content-Type": "application/pdf"},
                    content=blob, timeout=60)
    if not up.is_success:
        raise HTTPException(502, f"Storage upload failed: {up.text[:200]}")
    ip, ua = _client_meta(request)
    return _create_request(db, user, title=(data.get("title") or file.filename or "Document").strip(),
                           source="pdf", template_id="", employee_id=data.get("employeeId") or "",
                           candidate_id=data.get("candidateId") or "", entity_id=data.get("entityId") or "",
                           body_snapshot=[], pdf_storage_path=path, fields=fields,
                           message=data.get("message") or "", expires_on=data.get("expiresOn") or "",
                           parties=parties, ip=ip, user_agent=ua, routing=routing)


# ── Envelope management (HR) ──────────────────────────────────────────────────

@router.get("/requests")
def list_requests(status: str = "", user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    q = db.query(HrSignRequest)
    if status:
        q = q.filter(HrSignRequest.status == status)
    rows = q.order_by(HrSignRequest.created_at.desc()).all()
    for r in rows:
        _check_expiry(db, r)
    all_parties = db.query(HrSignParty).all()
    by_req = {}
    for p in all_parties:
        by_req.setdefault(p.request_id, []).append(p)
    return [_ser_request(r, parties=by_req.get(r.id, [])) for r in rows]


@router.get("/requests/{rid}")
def get_request(rid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    req = db.query(HrSignRequest).filter(HrSignRequest.id == rid).first()
    if not req:
        raise HTTPException(404, "Request not found")
    _check_expiry(db, req)
    events = (db.query(HrSignEvent).filter(HrSignEvent.request_id == rid)
              .order_by(HrSignEvent.at).all())
    return _ser_request(req, parties=_parties(db, rid), events=events)


@router.post("/requests/{rid}/remind")
def remind(rid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    req = db.query(HrSignRequest).filter(HrSignRequest.id == rid).first()
    if not req:
        raise HTTPException(404, "Request not found")
    _check_expiry(db, req)
    if req.status != "pending":
        raise HTTPException(409, f"Request is {req.status}")
    pending = [p for p in _parties(db, rid) if _its_their_turn(req, p)]
    if not pending:
        raise HTTPException(409, "No party is awaiting signature")
    sender_name = user["email"].split("@")[0].replace(".", " ").title()
    for p in pending:                          # sequential: 1 party; parallel: all unsigned
        _notify_party(db, p, req, sender_name)
        _log(db, rid, "reminded", f"{p.name} reminded by {user['email']}", party_id=p.id)
    db.commit()
    return {"ok": True, "reminded": ", ".join(p.name for p in pending)}


@router.post("/requests/{rid}/void")
def void_request(rid: str, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    req = db.query(HrSignRequest).filter(HrSignRequest.id == rid).first()
    if not req:
        raise HTTPException(404, "Request not found")
    if req.status not in ("pending",):
        raise HTTPException(409, f"Request is already {req.status}")
    req.status = "voided"
    _log(db, rid, "voided", f"by {user['email']}")
    db.commit()
    return _ser_request(req, parties=_parties(db, rid))


class PartyFix(BaseModel):
    name:        Optional[str] = None
    email:       Optional[str] = None
    access_code: Optional[str] = None


@router.patch("/requests/{rid}/parties/{pid}")
def correct_party(rid: str, pid: str, body: PartyFix, request: Request,
                  user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Fix a recipient's name/email/access code on a live envelope (typo'd email
    is THE support case). Email change rotates the token so the old link dies,
    and re-notifies if it was already their turn."""
    req = db.query(HrSignRequest).filter(HrSignRequest.id == rid).first()
    party = db.query(HrSignParty).filter(HrSignParty.id == pid,
                                         HrSignParty.request_id == rid).first()
    if not req or not party:
        raise HTTPException(404, "Not found")
    _check_expiry(db, req)
    if req.status != "pending":
        raise HTTPException(409, f"Request is {req.status}")
    if party.status in ("signed", "declined"):
        raise HTTPException(409, f"{party.name} has already {party.status} — correction is impossible")
    changes = []
    credential_changed = False   # token rotation or new code → resets brute-force lockout
    if body.name is not None and body.name.strip() and body.name.strip() != party.name:
        changes.append(f"name '{party.name}' → '{body.name.strip()}'")
        party.name = body.name.strip()
    email_changed = False
    if body.email is not None:
        new_email = body.email.strip().lower()
        if "@" not in new_email:
            raise HTTPException(400, "A valid email is required")
        if new_email != party.email:
            changes.append(f"email {party.email} → {new_email}")
            party.email = new_email
            party.token = secrets.token_urlsafe(32)   # old link must stop working
            party.viewed_at = ""
            email_changed = credential_changed = True
            if party.status == "viewed":
                party.status = "notified"
    if body.access_code is not None and body.access_code.strip() != (party.access_code or ""):
        if len(body.access_code.strip()) > 40:
            raise HTTPException(400, "Access codes are limited to 40 characters")
        party.access_code = body.access_code.strip()
        changes.append("access code changed")
        credential_changed = True
    if not changes:
        return _ser_request(req, parties=_parties(db, rid))
    ip, ua = _client_meta(request)
    _log(db, rid, "corrected", f"{'; '.join(changes)} — by {user['email']}",
         party_id=party.id, ip=ip, user_agent=ua)
    if credential_changed:   # only a fresh credential clears the lockout, not a name typo fix
        _log(db, rid, "code_reset", "credential changed — access-code lockout reset",
             party_id=party.id)
    if email_changed and _its_their_turn(req, party):
        sender_name = user["email"].split("@")[0].replace(".", " ").title()
        _notify_party(db, party, req, sender_name)
    db.commit()
    return _ser_request(req, parties=_parties(db, rid))


@router.get("/requests/{rid}/parties/{pid}/link")
def party_link(rid: str, pid: str, user: dict = Depends(require_hr_write),
               db: Session = Depends(get_db)):
    """The external recipient's signing link, for the sender to copy into a chat
    (email fallback). Write grant + audit trail — this link signs as them."""
    req = db.query(HrSignRequest).filter(HrSignRequest.id == rid).first()
    party = db.query(HrSignParty).filter(HrSignParty.id == pid,
                                         HrSignParty.request_id == rid).first()
    if not req or not party:
        raise HTTPException(404, "Not found")
    if party.kind != "external":
        raise HTTPException(400, "Teammates sign inside Nexus — there is no external link")
    if req.status != "pending":
        raise HTTPException(409, f"Request is {req.status}")
    _log(db, rid, "link_copied", f"{party.name}'s signing link copied by {user['email']}",
         party_id=party.id)
    db.commit()
    return {"url": f"{_APP_URL}/sign/{party.token}",
            "hasAccessCode": bool((party.access_code or "").strip()),
            "accessCode": (party.access_code or "").strip()}


@router.get("/requests/{rid}/download")
def download_final(rid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    req = db.query(HrSignRequest).filter(HrSignRequest.id == rid).first()
    if not req or not req.final_pdf_path:
        raise HTTPException(404, "No completed document")
    resp = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/sign/{_DOC_BUCKET}/{req.final_pdf_path}",
                      headers=_storage_headers(), json={"expiresIn": 300}, timeout=20)
    if not resp.is_success:
        raise HTTPException(502, "Could not create download link")
    _log(db, rid, "downloaded", f"by {user['email']}")
    db.commit()
    return {"url": f"{_SUPABASE_URL}/storage/v1{resp.json()['signedURL']}", "expiresIn": 300}


@router.get("/requests/{rid}/verify")
def verify_final(rid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    """Tamper check: re-hash the stored final PDF and compare with the sealed hash."""
    req = db.query(HrSignRequest).filter(HrSignRequest.id == rid).first()
    if not req or not req.final_pdf_path:
        raise HTTPException(404, "No completed document")
    resp = httpx.get(f"{_SUPABASE_URL}/storage/v1/object/{_DOC_BUCKET}/{req.final_pdf_path}",
                     headers=_storage_headers(), timeout=60)
    if not resp.is_success:
        raise HTTPException(502, "Could not fetch the stored document")
    actual = hashlib.sha256(resp.content).hexdigest()
    return {"valid": actual == req.final_sha256, "expected": req.final_sha256, "actual": actual}


# ── My signatures (any logged-in employee) ────────────────────────────────────

@router.get("/mine")
def my_signatures(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Inbox: everything awaiting me (my turn) + queued behind others."""
    email = user["email"].lower()
    parties = (db.query(HrSignParty).filter(HrSignParty.email == email,
               HrSignParty.status.in_(["waiting", "notified", "viewed"])).all())
    out = []
    for p in parties:
        if (p.party_role or "signer") != "signer":
            continue                       # CC recipients never have anything to sign
        req = db.query(HrSignRequest).filter(HrSignRequest.id == p.request_id).first()
        if not req:
            continue
        _check_expiry(db, req)
        if req.status != "pending":
            continue
        out.append({"partyId": p.id, "requestId": req.id, "title": req.title,
                    "message": req.message, "from": req.created_by, "createdAt": req.created_at,
                    "expiresOn": req.expires_on, "myTurn": _its_their_turn(req, p)})
    return sorted(out, key=lambda x: (not x["myTurn"], x["createdAt"]))


def _render_payload(db: Session, req: HrSignRequest, party: HrSignParty) -> dict:
    """What a signer needs to render + sign. Never exposes other parties' emails."""
    others = [_ser_party(p, include_email=False) for p in _parties(db, req.id)]
    payload = {"partyId": party.id, "requestId": req.id, "title": req.title,
               "message": req.message, "status": req.status, "source": req.source,
               "myTurn": _its_their_turn(req, party), "myRole": party.role_key,
               "myName": party.name, "myStatus": party.status, "parties": others,
               "consentText": _CONSENT_TEXT, "consentVersion": _CONSENT_VERSION,
               "expiresOn": req.expires_on}
    def sign_url(path):
        resp = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/sign/{_DOC_BUCKET}/{path}",
                          headers=_storage_headers(), json={"expiresIn": 300}, timeout=20)
        return f"{_SUPABASE_URL}/storage/v1{resp.json()['signedURL']}" if resp.is_success else ""

    if req.source == "template":
        payload["body"] = req.body_snapshot or []
        payload["myFields"] = [f for f in _fields_in_body(req.body_snapshot or [])
                               if f["role"] == party.role_key]
    else:
        payload["pdfUrl"] = sign_url(req.pdf_storage_path)
        payload["fields"] = req.fields or []
        payload["myFields"] = [f for f in (req.fields or []) if f.get("role") == party.role_key]
    # Attached packet documents (template attachments) — signed as one envelope
    docs = []
    for d in (req.documents or []):
        docs.append({"name": d.get("name", "document.pdf"), "pdfUrl": sign_url(d.get("path", "")),
                     "fields": d.get("fields") or []})
        payload["myFields"] = payload.get("myFields", []) + \
            [f for f in (d.get("fields") or []) if f.get("role") == party.role_key]
    payload["documents"] = docs
    return payload


class SignIn(BaseModel):
    consent:        bool
    signature_kind: str                      # drawn|typed
    signature_data: str                      # PNG data-URL or typed name
    field_values:   Optional[dict] = None    # {fieldKey: value} for text/check fields
    access_code:    Optional[str] = ""       # public links guarded by a code carry it here


def _validate_signature(body: SignIn) -> None:
    if not body.consent:
        raise HTTPException(400, "You must agree to sign electronically")
    if body.signature_kind not in ("drawn", "typed"):
        raise HTTPException(400, "signature_kind must be drawn or typed")
    if body.signature_kind == "drawn":
        if not body.signature_data.startswith("data:image/png;base64,"):
            raise HTTPException(400, "Drawn signature must be a PNG data-URL")
        try:
            raw = base64.b64decode(body.signature_data.split(",", 1)[1])
        except Exception:
            raise HTTPException(400, "Invalid signature image")
        if not raw or len(raw) > _MAX_SIG_BYTES:
            raise HTTPException(400, "Signature image is empty or too large")
    elif not body.signature_data.strip():
        raise HTTPException(400, "Type your full name to sign")


def _apply_signature(db: Session, req: HrSignRequest, party: HrSignParty, body: SignIn,
                     ip: str, ua: str) -> dict:
    """The shared engine: record the signature, advance the order, finalize when done.

    Serialized on the request row: two signers of the SAME envelope (parallel
    routing, or a double-submit of the last signer) must not both read sibling
    statuses before the other commits — otherwise each sees the other unsigned,
    both skip finalize (envelope stuck pending forever) or both finalize (double
    HrDocument + double notifications). This is the batch-notification race
    CLAUDE.md warns needs with_for_update(). SQLite ignores the lock but
    serializes writes anyway; Postgres (dev/prod) takes a real row lock."""
    db.query(HrSignRequest).filter(HrSignRequest.id == req.id).with_for_update().first()
    # Drop any party/request rows cached before we held the lock, so the turn
    # check and the finalize decision read state committed by whoever just
    # released it (autoflush=False + READ COMMITTED would otherwise show stale).
    db.expire_all()
    req = db.query(HrSignRequest).filter(HrSignRequest.id == req.id).first()
    party = db.query(HrSignParty).filter(HrSignParty.id == party.id).first()
    if not req or not party:
        raise HTTPException(404, "Not found")
    _check_expiry(db, req)
    if req.status != "pending":
        raise HTTPException(409, f"This document is {req.status}")
    if not _its_their_turn(req, party):
        raise HTTPException(409, "It is not your turn to sign yet" if party.status != "signed"
                            else "You have already signed")
    _validate_signature(body)
    now = _now_iso()
    party.signature_kind = body.signature_kind
    party.signature_data = body.signature_data
    party.consent_at = now
    party.consent_text_version = _CONSENT_VERSION
    party.field_values = body.field_values or {}
    party.ip, party.user_agent = ip, ua
    party.signed_at = now
    party.status = "signed"
    _log(db, req.id, "consented", f"{party.name} consented ({_CONSENT_VERSION})",
         party_id=party.id, ip=ip, user_agent=ua)
    _log(db, req.id, "signed", f"{party.name} signed ({body.signature_kind})",
         party_id=party.id, ip=ip, user_agent=ua)

    remaining = [p for p in _parties(db, req.id)
                 if (p.party_role or "signer") == "signer" and p.status != "signed"]
    if remaining:
        if (req.routing or "sequential") == "sequential":
            nxt = min(remaining, key=lambda p: p.ordinal)
            req.current_order = nxt.ordinal
            sender_name = req.created_by.split("@")[0].replace(".", " ").title()
            _notify_party(db, nxt, req, sender_name)
        # parallel: every signer was invited at send — nothing to advance
    else:
        # Sealing must never surface as a raw 500 — an unhandled exception here
        # bypasses CORSMiddleware and the browser reports a bare "Failed to
        # fetch". Convert to a real error response; nothing is committed, so
        # the signer can simply retry once the cause is fixed.
        try:
            _finalize(db, req)
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(502, f"The sealed PDF could not be generated ({str(e)[:150]}). "
                                     f"Your signature was not saved — please try again or contact HR.")
    db.commit()
    return {"ok": True, "status": req.status,
            "next": remaining[0].name if remaining else None}


@router.get("/mine/{party_id}")
def my_render(party_id: str, request: Request, user: dict = Depends(get_current_user),
              db: Session = Depends(get_db)):
    party = db.query(HrSignParty).filter(HrSignParty.id == party_id).first()
    if not party or party.email != user["email"].lower():
        raise HTTPException(404, "Not found")
    req = db.query(HrSignRequest).filter(HrSignRequest.id == party.request_id).first()
    _check_expiry(db, req)
    if not party.viewed_at:
        party.viewed_at = _now_iso()
        if party.status == "notified":
            party.status = "viewed"
        ip, ua = _client_meta(request)
        _log(db, req.id, "viewed", f"{party.name} opened the document",
             party_id=party.id, ip=ip, user_agent=ua)
        db.commit()
    return _render_payload(db, req, party)


@router.post("/mine/{party_id}/sign")
def my_sign(party_id: str, body: SignIn, request: Request,
            user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    party = db.query(HrSignParty).filter(HrSignParty.id == party_id).first()
    if not party or party.email != user["email"].lower():
        raise HTTPException(404, "Not found")
    req = db.query(HrSignRequest).filter(HrSignRequest.id == party.request_id).first()
    ip, ua = _client_meta(request)
    return _apply_signature(db, req, party, body, ip, ua)


class DeclineIn(BaseModel):
    reason:      Optional[str] = ""
    access_code: Optional[str] = ""          # public links guarded by a code carry it here


def _apply_decline(db: Session, req: HrSignRequest, party: HrSignParty, reason: str,
                   ip: str, ua: str) -> dict:
    # Same row lock as signing: a decline must not race a concurrent finalize
    # (else it flips a just-completed envelope back to 'declined').
    db.query(HrSignRequest).filter(HrSignRequest.id == req.id).with_for_update().first()
    db.expire_all()
    req = db.query(HrSignRequest).filter(HrSignRequest.id == req.id).first()
    party = db.query(HrSignParty).filter(HrSignParty.id == party.id).first()
    if not req or not party:
        raise HTTPException(404, "Not found")
    # CC recipients receive a copy, they never sign — so they can't decline the
    # whole envelope out from under the real signers.
    if (party.party_role or "signer") != "signer":
        raise HTTPException(403, "You are on this document for a copy only — there is nothing to decline.")
    _check_expiry(db, req)
    if req.status != "pending":
        raise HTTPException(409, f"This document is {req.status}")
    if party.status == "signed":
        raise HTTPException(409, "You have already signed")
    party.status = "declined"
    party.decline_reason = (reason or "").strip()[:400]
    req.status = "declined"
    _log(db, req.id, "declined", f"{party.name}: {party.decline_reason or 'no reason given'}",
         party_id=party.id, ip=ip, user_agent=ua)
    _hr_notify(db, req.created_by, f"Signature declined: {req.title}",
               f"{party.name} declined to sign. {party.decline_reason}".strip(),
               ref_id=req.id, requested_by=party.name,
               action={"view": "hr", "sub": "hr-esign-requests"})
    db.commit()
    return {"ok": True, "status": "declined"}


@router.post("/mine/{party_id}/decline")
def my_decline(party_id: str, body: DeclineIn, request: Request,
               user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    party = db.query(HrSignParty).filter(HrSignParty.id == party_id).first()
    if not party or party.email != user["email"].lower():
        raise HTTPException(404, "Not found")
    req = db.query(HrSignRequest).filter(HrSignRequest.id == party.request_id).first()
    ip, ua = _client_meta(request)
    return _apply_decline(db, req, party, body.reason or "", ip, ua)


# ── Public signing (token is the credential — NO auth) ────────────────────────

_CODE_LOCKOUT_ATTEMPTS = 10


def _party_by_token(db: Session, token: str) -> tuple:
    if not token or len(token) < 20:
        raise HTTPException(404, "Not found")
    party = db.query(HrSignParty).filter(HrSignParty.token == token).first()
    if not party:
        raise HTTPException(404, "Not found")
    req = db.query(HrSignRequest).filter(HrSignRequest.id == party.request_id).first()
    if not req:
        raise HTTPException(404, "Not found")
    return req, party


def _check_access_code(db: Session, req: HrSignRequest, party: HrSignParty,
                       code: str, request: Request) -> bool:
    """True = unlocked. Wrong attempts are audited and locked out after
    _CODE_LOCKOUT_ATTEMPTS — the code is the second factor on top of the token."""
    expected = (party.access_code or "").strip()
    if not expected:
        return True
    # A NEW code or a rotated token (email change) makes old brute-force attempts
    # moot, so it resets the lockout. A cosmetic fix (name-only) must NOT — it
    # leaves the credential unchanged. correct_party logs 'code_reset' only when
    # the code/token actually changed.
    last_fix = (db.query(HrSignEvent)
                .filter(HrSignEvent.request_id == req.id, HrSignEvent.party_id == party.id,
                        HrSignEvent.type == "code_reset")
                .order_by(HrSignEvent.at.desc()).first())
    fq = (db.query(HrSignEvent)
          .filter(HrSignEvent.request_id == req.id, HrSignEvent.party_id == party.id,
                  HrSignEvent.type == "code_failed"))
    if last_fix:
        fq = fq.filter(HrSignEvent.at > last_fix.at)
    failed = fq.count()
    if failed >= _CODE_LOCKOUT_ATTEMPTS:
        raise HTTPException(429, "Too many wrong access-code attempts — ask the sender "
                                 "to resend the document with a fresh link.")
    if hmac.compare_digest(expected.encode(), (code or "").strip().encode()):
        return True
    if (code or "").strip():                   # typed something wrong → audit it
        ip, ua = _client_meta(request)
        _log(db, req.id, "code_failed", f"{party.name} entered a wrong access code",
             party_id=party.id, ip=ip, user_agent=ua)
        db.commit()
    return False


@router.get("/public/{token}")
def public_render(token: str, request: Request, code: str = "", db: Session = Depends(get_db)):
    req, party = _party_by_token(db, token)
    _check_expiry(db, req)
    if not _check_access_code(db, req, party, code, request):
        # Locked teaser: enough to render the code prompt, nothing signable.
        return {"locked": True, "title": req.title, "requiresCode": True,
                "wrongCode": bool((code or "").strip())}
    if not party.viewed_at:
        party.viewed_at = _now_iso()
        if party.status == "notified":
            party.status = "viewed"
        ip, ua = _client_meta(request)
        _log(db, req.id, "viewed", f"{party.name} opened the public link",
             party_id=party.id, ip=ip, user_agent=ua)
        db.commit()
    return _render_payload(db, req, party)


@router.post("/public/{token}/sign")
def public_sign(token: str, body: SignIn, request: Request, db: Session = Depends(get_db)):
    req, party = _party_by_token(db, token)
    if not _check_access_code(db, req, party, body.access_code or "", request):
        raise HTTPException(403, "Wrong access code")
    ip, ua = _client_meta(request)
    return _apply_signature(db, req, party, body, ip, ua)


@router.post("/public/{token}/decline")
def public_decline(token: str, body: DeclineIn, request: Request, db: Session = Depends(get_db)):
    req, party = _party_by_token(db, token)
    if not _check_access_code(db, req, party, body.access_code or "", request):
        raise HTTPException(403, "Wrong access code")
    ip, ua = _client_meta(request)
    return _apply_decline(db, req, party, body.reason or "", ip, ua)


@router.get("/public/{token}/download")
def public_download(token: str, request: Request, code: str = "", db: Session = Depends(get_db)):
    """A party's own copy of the SEALED document — only once completed. Externals
    have no Nexus login; this is how they retain their copy (ESIGN retention)."""
    req, party = _party_by_token(db, token)
    if not _check_access_code(db, req, party, code, request):
        raise HTTPException(403, "Wrong access code")
    if req.status != "completed" or not req.final_pdf_path:
        raise HTTPException(409, "This document is not completed yet")
    resp = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/sign/{_DOC_BUCKET}/{req.final_pdf_path}",
                      headers=_storage_headers(), json={"expiresIn": 300}, timeout=20)
    if not resp.is_success:
        raise HTTPException(502, "Could not create download link")
    ip, ua = _client_meta(request)
    _log(db, req.id, "downloaded", f"by {party.name} (public link)", party_id=party.id,
         ip=ip, user_agent=ua)
    db.commit()
    return {"url": f"{_SUPABASE_URL}/storage/v1{resp.json()['signedURL']}", "expiresIn": 300}


# ── Finalize: sealed PDF + Certificate of Completion ──────────────────────────

def _sig_flowable(party: HrSignParty, width_mm: float = 58):
    """A signature rendering: the drawn PNG or the typed name in oblique."""
    from reportlab.lib.units import mm
    from reportlab.platypus import Image, Paragraph
    from reportlab.lib.styles import ParagraphStyle
    if party.signature_kind == "drawn" and party.signature_data.startswith("data:image/png;base64,"):
        raw = base64.b64decode(party.signature_data.split(",", 1)[1])
        img = Image(io.BytesIO(raw))
        ratio = img.imageHeight / float(img.imageWidth or 1)
        img.drawWidth = width_mm * mm
        img.drawHeight = max(10, min(30, width_mm * ratio)) * mm
        return img
    style = ParagraphStyle("sig", fontName="Helvetica-Oblique", fontSize=18, leading=22)
    return Paragraph(_pesc(party.signature_data or party.name), style)


def _initials(name: str) -> str:
    return "".join(w[0].upper() for w in (name or "").split()[:3]) or "—"


def _build_template_pdf(req: HrSignRequest, parties: List[HrSignParty]) -> bytes:
    """Render the frozen body_snapshot with every field token resolved."""
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle)
    from reportlab.lib import colors
    by_role = {p.role_key: p for p in parties}
    styles = getSampleStyleSheet()
    body_style = ParagraphStyle("body", parent=styles["Normal"], fontName="Helvetica",
                                fontSize=10.5, leading=15, spaceAfter=8)
    cap_style = ParagraphStyle("cap", parent=styles["Normal"], fontName="Helvetica",
                               fontSize=8, leading=10, textColor=colors.HexColor("#6b7280"))
    flow = [Paragraph(_pesc(req.title), ParagraphStyle("t", parent=styles["Title"], fontSize=15)),
            Spacer(1, 6 * mm)]

    def resolve_inline(m):
        ftype, role, label = m.group(1), m.group(2), m.group(3) or ""
        p = by_role.get(role)
        if not p:
            return "____________"
        if ftype == "date":
            return (p.signed_at or "")[:10]
        if ftype == "initials":
            return _initials(p.name)
        if ftype == "check":
            checked = (p.field_values or {}).get(f"check:{label}", True)
            return f"[{'x' if checked else ' '}] {label}"
        if ftype == "text":
            return str((p.field_values or {}).get(f"text:{label}", "")) or "____________"
        return m.group(0)   # sign handled as a block below

    for para in req.body_snapshot or []:
        para = str(para)
        sig_tokens = [m for m in _FIELD_RE.finditer(para) if m.group(1) == "sign"]
        text = _FIELD_RE.sub(resolve_inline, _FIELD_RE.sub(
            lambda m: "" if m.group(1) == "sign" else m.group(0), para)).strip()
        if text:
            flow.append(Paragraph(_pesc(text), body_style))
        for m in sig_tokens:
            p = by_role.get(m.group(2))
            if not p:
                continue
            sig = _sig_flowable(p)
            t = Table([[sig], [Paragraph(f"{_pesc(p.name)} — signed {(p.signed_at or '')[:19].replace('T', ' ')} UTC",
                                         cap_style)]], colWidths=[75 * mm])
            t.setStyle(TableStyle([("LINEBELOW", (0, 0), (0, 0), 0.7, colors.black),
                                   ("TOPPADDING", (0, 1), (0, 1), 2),
                                   ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
            flow.extend([Spacer(1, 4 * mm), t, Spacer(1, 3 * mm)])

    buf = io.BytesIO()
    SimpleDocTemplate(buf, pagesize=LETTER, topMargin=22 * mm, bottomMargin=20 * mm,
                      leftMargin=22 * mm, rightMargin=22 * mm,
                      title=req.title).build(flow)
    return buf.getvalue()


def _stamp_pdf(source: bytes, fields: list, parties: List[HrSignParty]) -> bytes:
    """Overlay signatures/values onto an uploaded PDF at normalized coords."""
    from reportlab.pdfgen import canvas as rl_canvas
    from pypdf import PdfReader, PdfWriter
    by_role = {p.role_key: p for p in parties}
    reader = PdfReader(io.BytesIO(source))
    writer = PdfWriter()
    for idx, page in enumerate(reader.pages):
        # A /Rotate 90/270 page (common from scanners/phones) renders upright in
        # viewers, so the field coords were placed against the VISUAL size — but
        # merge_page ignores /Rotate and works in mediabox space. Bake the
        # rotation into the content first so mediabox == what the placer saw.
        if getattr(page, "rotation", 0):
            try:
                page.transfer_rotation_to_content()
            except Exception:
                pass
        pw, ph = float(page.mediabox.width), float(page.mediabox.height)
        page_fields = [f for f in (fields or []) if int(f.get("page", 0)) == idx]
        if page_fields:
            obuf = io.BytesIO()
            c = rl_canvas.Canvas(obuf, pagesize=(pw, ph))
            for f in page_fields:
                p = by_role.get(f.get("role", ""))
                if not p:
                    continue
                # normalized coords: x/y from top-left, w/h fractions of the page
                x, w = float(f.get("x", 0)) * pw, max(0.02, float(f.get("w", 0.2))) * pw
                h = max(0.015, float(f.get("h", 0.05))) * ph
                y = ph - float(f.get("y", 0)) * ph - h
                ftype = f.get("type")
                if ftype == "sign" and p.signature_kind == "drawn" and \
                        p.signature_data.startswith("data:image/png;base64,"):
                    from reportlab.lib.utils import ImageReader
                    raw = base64.b64decode(p.signature_data.split(",", 1)[1])
                    c.drawImage(ImageReader(io.BytesIO(raw)), x, y, width=w, height=h,
                                preserveAspectRatio=True, mask="auto")
                elif ftype == "sign":
                    c.setFont("Helvetica-Oblique", min(16, h * 0.7))
                    c.drawString(x, y + h * 0.25, p.signature_data or p.name)
                elif ftype == "date":
                    c.setFont("Helvetica", min(10, h * 0.6))
                    c.drawString(x, y + h * 0.25, (p.signed_at or "")[:10])
                elif ftype == "initials":
                    c.setFont("Helvetica-Oblique", min(12, h * 0.7))
                    c.drawString(x, y + h * 0.25, _initials(p.name))
                elif ftype in ("text", "check"):
                    val = (p.field_values or {}).get(f.get("id", ""), "")
                    if ftype == "check":
                        val = "[x]" if val else "[ ]"
                    c.setFont("Helvetica", min(10, h * 0.6))
                    c.drawString(x, y + h * 0.25, str(val))
            c.save()
            obuf.seek(0)
            page.merge_page(PdfReader(obuf).pages[0])
        writer.add_page(page)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def _certificate_pdf(req: HrSignRequest, parties: List[HrSignParty],
                     events: List[HrSignEvent], content_sha: str) -> bytes:
    """The Certificate of Completion — signer identity, consent, IP/UA, timeline,
    and the content hash. Appended as the final page(s) of the sealed PDF.
    Every cell is a Paragraph so long values WRAP instead of clipping; column
    widths sum to the printable width (LETTER 216mm − 2×17mm margins = 182mm)."""
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
    from reportlab.lib import colors
    from xml.sax.saxutils import escape

    INK, MUTED, LINE, MIST, PINE = (colors.HexColor(c) for c in
                                    ("#111827", "#6b7280", "#e5e7eb", "#f6f7f9", "#166534"))
    styles = getSampleStyleSheet()
    title = ParagraphStyle("t", parent=styles["Title"], fontSize=19, spaceAfter=1, textColor=INK)
    brand = ParagraphStyle("b", parent=styles["Normal"], fontSize=7.5, textColor=PINE,
                           spaceAfter=2, alignment=1)
    sub = ParagraphStyle("sb", parent=styles["Normal"], fontSize=8.5, leading=12,
                         textColor=MUTED, alignment=1)
    h = ParagraphStyle("h", parent=styles["Heading2"], fontSize=11, spaceBefore=10,
                       spaceAfter=3, textColor=INK)
    small = ParagraphStyle("s", parent=styles["Normal"], fontSize=8.5, leading=12, textColor=INK)
    tiny = ParagraphStyle("y", parent=styles["Normal"], fontSize=7, leading=9.5, textColor=MUTED)
    cell = ParagraphStyle("c", parent=styles["Normal"], fontSize=7.5, leading=9.5, textColor=INK)
    cellm = ParagraphStyle("cm", parent=cell, textColor=MUTED)
    head = ParagraphStyle("hd", parent=styles["Normal"], fontSize=7.5, leading=9,
                          fontName="Helvetica-Bold", textColor=INK)

    ts = lambda v: escape((v or "")[:19].replace("T", "  "))          # '2026-07-04  06:39:17'
    P, PM, PH = (lambda s: Paragraph(s, cell)), (lambda s: Paragraph(s, cellm)), (lambda s: Paragraph(s, head))
    grid = lambda: TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("BACKGROUND", (0, 0), (-1, 0), MIST),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#fbfcfd")]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ])

    signers = [p for p in parties if (p.party_role or "signer") == "signer"]
    ccs = [p for p in parties if (p.party_role or "signer") == "cc"]
    n_signed = sum(1 for p in signers if p.status == "signed")
    flow = [Paragraph("GREENS NEXUS · ELECTRONIC SIGNATURE", brand),
            Paragraph("Certificate of Completion", ParagraphStyle("tc", parent=title, alignment=1)),
            Paragraph(f"{escape(req.title)}", ParagraphStyle("st", parent=sub, fontSize=10,
                                                             textColor=INK, spaceBefore=2)),
            Paragraph(f"Envelope {req.id} · {n_signed} of {len(signers)} signed · "
                      f"Completed {ts(req.completed_at)} UTC", sub),
            Spacer(1, 3 * mm),
            HRFlowable(width="100%", thickness=0.6, color=LINE),
            Paragraph("Document integrity", h),
            Paragraph(f"SHA-256 of the signed content pages:", small),
            Paragraph(f"<font face='Courier' size='8'>{content_sha}</font>", small),
            Paragraph("Any modification to the signed pages after completion changes this hash. "
                      "Verify anytime under HR → E-Sign → Verify integrity.", tiny),
            Paragraph("Signers", h)]

    rows = [[PH("#"), PH("Signer"), PH("Consented"), PH("Viewed"), PH("Signed"), PH("IP address")]]
    for p in sorted(signers, key=lambda x: x.ordinal):
        who = (f"<b>{escape(p.name or '—')}</b><br/>{escape(p.email or '')}"
               f"<br/><font color='#6b7280'>{escape(p.kind or '')}</font>")
        rows.append([PM(str(p.ordinal)), P(who),
                     P(f"{ts(p.consent_at)}<br/><font color='#6b7280'>consent v{escape(str(p.consent_text_version or ''))}</font>"),
                     P(ts(p.viewed_at) or "—"), P(ts(p.signed_at) or "—"),
                     P(escape(_strip_port(p.ip)) or "—")])
    t = Table(rows, colWidths=[8 * mm, 58 * mm, 32 * mm, 28 * mm, 28 * mm, 28 * mm],
              repeatRows=1)
    t.setStyle(grid())
    flow.append(t)
    if ccs:
        flow.append(Paragraph("Copies to: " + " · ".join(
            f"{escape(p.name)} ({escape(p.email)})" for p in ccs), tiny))
    flow.append(Paragraph("Event log", h))

    erows = [[PH("Time (UTC)"), PH("Event"), PH("Detail"), PH("IP address")]]
    for e in events:
        erows.append([P(ts(e.at)), P(escape(e.type or "")),
                      P(escape((e.detail or "")[:300])), P(escape(_strip_port(e.ip)) or "—")])
    et = Table(erows, colWidths=[30 * mm, 20 * mm, 104 * mm, 28 * mm], repeatRows=1)
    et.setStyle(grid())
    flow.append(et)
    flow.append(Spacer(1, 4 * mm))
    flow.append(Paragraph(f"Consent text (v{_CONSENT_VERSION}): “{escape(_CONSENT_TEXT)}”", tiny))
    flow.append(Spacer(1, 1.5 * mm))
    flow.append(Paragraph("Generated by Greens Nexus E-Sign. This certificate is part of the sealed "
                          "document and covers all preceding pages.", tiny))
    buf = io.BytesIO()
    SimpleDocTemplate(buf, pagesize=LETTER, topMargin=16 * mm, bottomMargin=14 * mm,
                      leftMargin=17 * mm, rightMargin=17 * mm,
                      title=f"Certificate — {req.title}").build(flow)
    return buf.getvalue()


def _finalize(db: Session, req: HrSignRequest) -> None:
    """All parties signed: render content, append certificate, hash, store, notify."""
    from pypdf import PdfReader, PdfWriter
    req.completed_at = _now_iso()
    parties = _parties(db, req.id)

    def fetch(path):
        src = httpx.get(f"{_SUPABASE_URL}/storage/v1/object/{_DOC_BUCKET}/{path}",
                        headers=_storage_headers(), timeout=60)
        if not src.is_success:
            raise HTTPException(502, f"Could not fetch {path} to finalize")
        return src.content

    # Content = the authored letter (or uploaded PDF) + every packet document,
    # each stamped with its own fields, merged in order into ONE sealed PDF.
    parts = []
    if req.source == "template":
        parts.append(_build_template_pdf(req, parties))
    else:
        parts.append(_stamp_pdf(fetch(req.pdf_storage_path), req.fields or [], parties))
    for d in (req.documents or []):
        parts.append(_stamp_pdf(fetch(d.get("path", "")), d.get("fields") or [], parties))
    if len(parts) == 1:
        content = parts[0]
    else:
        from pypdf import PdfReader as _PR, PdfWriter as _PW
        w = _PW()
        for part in parts:
            for page in _PR(io.BytesIO(part)).pages:
                w.add_page(page)
        buf = io.BytesIO()
        w.write(buf)
        content = buf.getvalue()

    content_sha = hashlib.sha256(content).hexdigest()
    events = (db.query(HrSignEvent).filter(HrSignEvent.request_id == req.id)
              .order_by(HrSignEvent.at).all())
    cert = _certificate_pdf(req, parties, events, content_sha)

    # Merge content + certificate into the sealed final document
    writer = PdfWriter()
    for page in PdfReader(io.BytesIO(content)).pages:
        writer.add_page(page)
    for page in PdfReader(io.BytesIO(cert)).pages:
        writer.add_page(page)
    out = io.BytesIO()
    writer.write(out)
    final = out.getvalue()

    path = f"esign/{req.id}/final.pdf"
    up = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/{_DOC_BUCKET}/{path}",
                    headers={**_storage_headers(), "Content-Type": "application/pdf",
                             "x-upsert": "true"},
                    content=final, timeout=60)
    if not up.is_success:
        raise HTTPException(502, f"Could not store the final document: {up.text[:200]}")
    req.final_pdf_path = path
    req.final_sha256 = hashlib.sha256(final).hexdigest()
    req.status = "completed"
    _log(db, req.id, "completed", f"sealed · sha256 {req.final_sha256[:16]}…")

    # Attach to the subject employee's profile Documents tab
    if req.employee_id:
        db.add(HrDocument(id=str(uuid.uuid4()), employee_id=req.employee_id, kind="contract",
                          file_name=f"{req.title}.pdf", storage_path=path,
                          size_bytes=len(final), uploaded_by="e-sign",
                          created_at=req.completed_at))

    # Tell the sender + every internal party; email externals a copy link
    n_signers = sum(1 for p in parties if (p.party_role or "signer") == "signer")
    _hr_notify(db, req.created_by, f"Completed: {req.title}",
               f"All {n_signers} signer{'s' if n_signers != 1 else ''} have signed \"{req.title}\". "
               f"The sealed document is in HR → E-Sign.", ref_id=req.id,
               action={"view": "hr", "sub": "hr-esign-requests"})
    for p in parties:
        if p.kind == "internal" and p.email != req.created_by:
            _hr_notify(db, p.email, f"Fully signed: {req.title}",
                       "Everyone has signed. The sealed copy is available in HR → E-Sign.",
                       ref_id=req.id,
                       action={"view": "hr", "sub": "hr-esign"})
        elif p.kind == "external":
            # Externals have no Nexus login — their link now serves the sealed
            # copy (public download). Best-effort, audited either way.
            ok, detail = _send_completed_email(p, req)
            _log(db, req.id, "sent", f"completion copy emailed to {p.name}"
                 + ("" if ok else f" — email failed: {detail}"), party_id=p.id)
