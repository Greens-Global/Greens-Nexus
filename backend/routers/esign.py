"""Native E-Sign (HR Section C) - templates, ordered multi-party signing,
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
import pathlib
import re
import secrets
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File, Form, Header, Response
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List
import httpx

from database import get_db
from auth import get_current_user
from models import (HrSignTemplate, HrSignRequest, HrSignParty, HrSignEvent,
                    HrDocument, HrEntity, HrCandidate, NexusEmployee,
                    HrDocumentClass, HrSignConsent, HrSignRetentionHold,
                    HrSignDocument, HrSignSeal)
# Reuse the HR module's storage/Graph/notification plumbing - same bucket, same
# service key, same bell. hr.py owns those constants; do not duplicate them.
from services.seal import seal_pdf, describe_seals, policy_sentence as seal_policy_sentence
from services.certificate import (build_snapshot as build_certificate_snapshot,
                                  render_html as render_certificate_html)
from routers.hr import (require_hr_read, require_hr_write, require_hr_delete,
                        _storage_headers, _graph_token, _hr_notify,
                        _SUPABASE_URL, _DOC_BUCKET, _SUPABASE_SERVICE_KEY)

router = APIRouter(prefix="/esign", tags=["esign"])

# NEXUS_APP_URL override, else derived per environment (see app_url.py) - the
# old hardcoded dev default made PROD e-sign emails link to dev.nexus. Called
# fresh at each use rather than cached at import - a worker that first
# resolves this during Azure's staging-slot warm-up (see app_url.py) would
# otherwise bake in the wrong URL for its whole process lifetime.
from app_url import app_url as _app_url_fn

# ── Local-dev storage fallback (E-Sign only) ──────────────────────────────────
# Every real deployment (Azure) always has SUPABASE_URL/SUPABASE_SERVICE_KEY
# set, so this branch never executes outside a local machine missing those two
# env vars - it self-disables the moment real credentials exist, same category
# as the NEXUS_SKIP_AUTH local-only bypass this codebase already has elsewhere.
# Scoped deliberately to e-sign's own storage calls only (not hr.py's HR
# document uploads, which are untouched) - see the E-Sign compliance plan.
_LOCAL_STORAGE_ROOT = pathlib.Path("Generated File")


def _storage_configured() -> bool:
    return bool(_SUPABASE_URL and _SUPABASE_SERVICE_KEY)


def _local_storage_path(bucket: str, path: str) -> pathlib.Path:
    """Resolves a bucket+path to a file under Generated File/, rejecting any
    attempt to escape that directory (defense in depth - `path` values are
    normally server-generated, e.g. f"esign/{req.id}/final.pdf", but the local
    file-serving endpoint below accepts `path` from the URL, so this check is
    load-bearing there, not just decorative)."""
    root = (_LOCAL_STORAGE_ROOT / bucket).resolve()
    candidate = (root / path).resolve()
    if not candidate.is_relative_to(root):
        raise HTTPException(400, "Invalid path")
    return candidate


class _StorageResult:
    """Minimal stand-in for the bits of an httpx.Response the 9 call sites in
    this file actually use (.is_success/.text/.content/.json()) - lets the
    Supabase and local-file code paths share the exact same call-site shape
    below, so each site's existing error-handling needed almost no changes."""
    def __init__(self, is_success: bool, content: bytes = b"", text: str = "", json_data=None):
        self.is_success = is_success
        self.content = content
        self.text = text
        self._json = json_data or {}

    def json(self):
        return self._json


def _storage_put(bucket: str, path: str, content: bytes, content_type: str, upsert: bool = False) -> _StorageResult:
    if _storage_configured():
        headers = {**_storage_headers(), "Content-Type": content_type}
        if upsert:
            headers["x-upsert"] = "true"
        r = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/{bucket}/{path}",
                       headers=headers, content=content, timeout=60)
        return _StorageResult(r.is_success, content=r.content, text=r.text)
    # Local filesystem writes are inherently upsert (always overwrite) - no
    # separate flag needed for this branch.
    p = _local_storage_path(bucket, path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(content)
    return _StorageResult(True)


def _storage_fetch(bucket: str, path: str, timeout: int = 60) -> _StorageResult:
    if _storage_configured():
        r = httpx.get(f"{_SUPABASE_URL}/storage/v1/object/{bucket}/{path}",
                      headers=_storage_headers(), timeout=timeout)
        return _StorageResult(r.is_success, content=r.content, text=r.text)
    p = _local_storage_path(bucket, path)
    if not p.exists():
        return _StorageResult(False, text="Local file not found")
    return _StorageResult(True, content=p.read_bytes())


def _storage_signed_url(bucket: str, path: str, expires_in: int = 300) -> _StorageResult:
    if _storage_configured():
        r = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/sign/{bucket}/{path}",
                       headers=_storage_headers(), json={"expiresIn": expires_in}, timeout=20)
        if not r.is_success:
            return _StorageResult(False, text=r.text)
        return _StorageResult(True, json_data={
            "url": f"{_SUPABASE_URL}/storage/v1{r.json()['signedURL']}", "expiresIn": expires_in})
    p = _local_storage_path(bucket, path)
    if not p.exists():
        return _StorageResult(False, text="Local file not found")
    # _app_url_fn() is the FRONTEND's origin (used for /sign, /verify links) and
    # defaults to the production domain when NEXUS_APP_URL isn't set locally
    # - using it here would produce an unreachable link. This is the BACKEND
    # API's own origin instead, matching this project's documented local-dev
    # convention (CLAUDE.md: "frontend talks to localhost:8000 by default").
    # Override with NEXUS_LOCAL_API_URL if the backend runs on a different port.
    api_base = os.getenv("NEXUS_LOCAL_API_URL", "http://localhost:8000")
    return _StorageResult(True, json_data={
        "url": f"{api_base}/esign/local-file/{bucket}/{path}", "expiresIn": expires_in})


@router.get("/local-file/{bucket}/{path:path}")
def local_file(bucket: str, path: str):
    """Serves files from Generated File/ - the local-dev stand-in for a
    Supabase signed URL (see _storage_signed_url above). Immediately 404s if
    real storage IS configured, so this can never become a live path in any
    environment that has actual credentials - not just "unused," structurally
    unreachable. No auth (matches a Supabase signed URL's own bearer-in-URL
    posture) but strictly sandboxed to Generated File/ via _local_storage_path,
    which rejects any path that would resolve outside it."""
    if _storage_configured():
        raise HTTPException(404, "Not found")
    p = _local_storage_path(bucket, path)
    if not p.exists():
        raise HTTPException(404, "Not found")
    media_type = "application/pdf" if p.suffix.lower() == ".pdf" else "application/octet-stream"
    return Response(content=p.read_bytes(), media_type=media_type)


_TEMPLATE_KINDS = ("offer", "nda", "direct_deposit", "handbook_ack", "w9",
                   "contractor_agreement", "sow", "custom")
_MAX_PDF_BYTES = 15 * 1024 * 1024
_MAX_SIG_BYTES = 200 * 1024          # decoded PNG cap for drawn signatures

# ESIGN/UETA consent - shown verbatim to every signer; version stamped per party
# so we can prove exactly what they agreed to even if the wording evolves.
# v2.0 carries the full ESIGN 15 U.S.C. 7001(c) disclosure set, not just the
# one-line agreement v1.0 had. 7001(c) is the one part of US e-signature law
# that actually PRESCRIBES content: before a consumer consents, they must be
# told they may have the record on paper, how to withdraw consent and what it
# costs them, what the consent covers, how to get a paper copy, and what
# hardware/software they need. A certificate can only certify what was really
# shown, so the disclosures live here (served to the signing UI by
# GET /esign/public/{token} and the internal sign payload) and the version
# stamped on each party is what the Certificate of Completion cites.
# Bump the version whenever any wording below changes - old envelopes keep
# citing the version their signers actually saw.
_CONSENT_VERSION = "2.0-2026-09"
_CONSENT_TEXT = (
    "I agree to use electronic records and signatures for this document, and I "
    "confirm that I can access and retain a copy of it. My electronic signature "
    "is the legal equivalent of my handwritten signature."
)
# (heading, body) - rendered in the signing UI above the consent checkbox and
# reproduced verbatim on the Certificate of Completion.
_ESIGN_DISCLOSURES = [
    ("Right to a paper copy",
     "You may request a paper copy of any record provided or made available to you "
     "electronically. We do not charge a fee for a paper copy. Contact the sender "
     "of this document, or {support}, to request one."),
    ("Withdrawing your consent",
     "You may withdraw your consent to use electronic records and signatures at any "
     "time before you sign, at no cost, by declining this document or by contacting "
     "{support}. If you withdraw consent, this document cannot be completed "
     "electronically and the sender will have to make other arrangements with you; "
     "withdrawal does not affect the validity of records you signed electronically "
     "before you withdrew."),
    ("Scope of your consent",
     "Your consent applies to this document and its attachments, and to the notices "
     "and copies we send you about it. It is not a consent to receive other, "
     "unrelated records electronically."),
    ("Getting copies and updating your contact details",
     "When signing finishes, every party is emailed the completed document with "
     "this certificate attached - or, if it is too large to attach, a link to "
     "download it. It also stays available at the verification link printed on "
     "the certificate. To update the email address we use for you, contact the "
     "sender of the document."),
    ("Hardware and software you need",
     "A current version of a web browser that supports HTTPS and JavaScript "
     "(Chrome, Edge, Safari or Firefox), a device that can display and print PDF "
     "files, an active email account, and enough storage to save a PDF. If these "
     "requirements change in a way that creates a material risk that you could not "
     "access or retain your records, we will tell you."),
]


def _disclosure_text(support_email: str = "") -> str:
    """The exact bytes presented to the signer, in a fixed order. The digest of
    THIS is the consent evidence - a version label alone proves nothing if the
    text behind the label ever changed."""
    parts = [f"Electronic Records and Signatures Disclosure (version {_CONSENT_VERSION})"]
    for head, body in _disclosures(support_email):
        parts.append(head + "\n" + body)
    parts.append(_CONSENT_TEXT)
    return "\n\n".join(parts)


def _disclosure_digest(support_email: str = "") -> str:
    return hashlib.sha256(_disclosure_text(support_email).encode("utf-8")).hexdigest()


def _disclosures(support_email: str = "") -> list:
    """The 7001(c) disclosure set with the support contact filled in."""
    who = support_email or _SUPPORT_CONTACT
    return [(head, body.replace("{support}", who)) for head, body in _ESIGN_DISCLOSURES]


# ── Records an electronic signature cannot be used for ───────────────────────
# ESIGN 15 U.S.C. 7003 and Cal. Civ. Code 1633.3 carve these out entirely: an
# electronic signature has NO legal effect on them, so a Nexus envelope is the
# wrong tool and no amount of audit trail fixes it. The sender acknowledges
# the list at send time (enforced in _create_request, not just in the UI) and
# the acknowledgment is hash-chained into the audit log.
# This is a checklist, not legal advice - the categories are summarized.
_EXCLUDED_RECORD_CATEGORIES = [
    ("Wills, codicils and testamentary trusts", "15 U.S.C. 7003(a)(1) - Cal. Civ. Code 1633.3(b)(1)"),
    ("Adoption, divorce and other family law matters", "15 U.S.C. 7003(a)(2)"),
    ("Court orders, notices and filings, or documents for a court proceeding", "15 U.S.C. 7003(b)(1)"),
    ("Notices of default, foreclosure, eviction, or repossession on a primary residence",
     "15 U.S.C. 7003(b)(2)(B)"),
    ("Notices cancelling utility service", "15 U.S.C. 7003(b)(2)(A)"),
    ("Notices cancelling or terminating health or life insurance benefits", "15 U.S.C. 7003(b)(2)(C)"),
    ("Product recalls, or notices of a material failure affecting health or safety",
     "15 U.S.C. 7003(b)(2)(D)"),
    ("Documents accompanying the transport of hazardous or dangerous materials",
     "15 U.S.C. 7003(b)(3)"),
    ("Anything requiring a notary, or a California public entity's digital signature",
     "Cal. Civ. Code 1633.11 - Cal. Gov. Code 16.5"),
]


# ── System-of-record identity, printed on the certificate ────────────────────
# Deployment facts, not code constants - a different tenant signs under a
# different legal entity and a different governing law. Env-overridable so no
# redeploy is needed to correct them.
_SOR_NAME = os.getenv("NEXUS_ESIGN_SOR_NAME", "Nexus Docs & Sign")
_SOR_OPERATOR = os.getenv("NEXUS_ESIGN_OPERATOR", "Greens Global")
_SUPPORT_CONTACT = os.getenv("NEXUS_ESIGN_SUPPORT", "it@greensglobal.com")
_GOVERNING_LAW = os.getenv("NEXUS_ESIGN_GOVERNING_LAW", "California")
_DEFAULT_GOVERNING_LAW = os.getenv("NEXUS_ESIGN_DEFAULT_LAW", "CA")
_RETENTION_POLICY = os.getenv(
    "NEXUS_ESIGN_RETENTION",
    "Retained for the life of the record in Nexus document storage, with a copy "
    "in the sending team's Egnyte folder where one is configured.")

_MERGE_RE = re.compile(r"\{\{([a-z0-9_]+)\}\}")
_FIELD_RE = re.compile(r"\[\[(sign|initials|date|text|check):([a-z0-9_]+)(?::([^\]]*))?\]\]")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pesc(s) -> str:
    """Escape a user string for reportlab Paragraph markup. reportlab's paraparser
    treats <...> and & as XML - an unescaped name/title/typed-signature (e.g.
    'Ben & Co', 'a<b') otherwise CRASHES sealing and permanently bricks the
    envelope (nothing is committed, so every retry re-crashes)."""
    from xml.sax.saxutils import escape
    return escape(str(s or ""))


def _strip_port(addr: str) -> str:
    """Azure's x-forwarded-for carries the client port ('1.2.3.4:56789',
    '[::1]:443') - an audit trail wants the address only."""
    addr = (addr or "").strip()
    if addr.startswith("["):                      # bracketed IPv6
        return addr.split("]")[0].lstrip("[")
    if addr.count(":") == 1:                      # IPv4:port (bare IPv6 has 2+)
        return addr.split(":")[0]
    return addr


def _client_meta(request: Optional[Request]) -> tuple:
    """(ip, user_agent) - x-forwarded-for first (Azure sits behind a proxy)."""
    if request is None:
        return "", ""
    fwd = request.headers.get("x-forwarded-for", "")
    ip = _strip_port(fwd.split(",")[0] if fwd else (request.client.host if request.client else ""))
    return ip, request.headers.get("user-agent", "")[:300]


# ── Audit chain hashing ──────────────────────────────────────────────────────
# Two versions, and BOTH stay in the code forever.
#
# v1 was a pipe-joined string. It is unambiguous for our data but it is not a
# standard, and it breaks if a field ever contains a pipe. v2 canonicalizes the
# entry with RFC 8785 (JSON Canonicalization Scheme) before hashing, so the
# digest depends on the DATA, not on how a dict happened to be ordered or a
# string happened to be escaped.
#
# The old function is not deleted and not "fixed". Every hash already written
# was computed under v1; recomputing them under v2 would fail every historical
# chain at once and the nightly sweep would alert on the entire table. Each row
# records the version that produced it and is verified under that version, so a
# chain that spans the change verifies end to end.
_HASH_VERSION = 2          # what new entries are written with

_GENESIS = b"\x00" * 32    # RFC 8785 chain start (build note section 4)


def _canonical_entry(request_id: str, type: str, detail: str, party_id: str,
                     ip: str, user_agent: str, at: str, seq: int) -> bytes:
    """The JCS serialization of one audit entry.

    Field names follow the build note's canonical body, mapped onto the columns
    this table actually has: `party_id` stands in for the note's actor triple,
    and `detail` for its free-form payload. Every value is included exactly as
    stored - no trimming, no normalizing - so a replay can always reproduce the
    digest from the row.
    """
    import rfc8785
    return rfc8785.dumps({
        "envelope_id": request_id,
        "seq": int(seq),
        "event_type": type or "",
        "party_id": party_id or None,
        "detail": detail or "",
        "ip": ip or None,
        "user_agent": user_agent or None,
        "occurred_at": at or "",
    })


def _event_hash_v1(prev_hash: str, request_id: str, type: str, detail: str,
                   ip: str, user_agent: str, at: str, seq: int) -> str:
    """FROZEN. The original digest, kept verbatim so pre-existing chains keep
    verifying. Do not change this function for any reason - if the format needs
    to change, add v3."""
    payload = f"{prev_hash}|{request_id}|{type}|{detail[:500]}|{ip}|{user_agent}|{at}|{seq}"
    return hashlib.sha256(payload.encode()).hexdigest()


def _event_hash_v2(prev_hash: str, request_id: str, type: str, detail: str,
                   party_id: str, ip: str, user_agent: str, at: str, seq: int) -> str:
    """sha256(previous digest bytes || JCS(entry)). The genesis link is 32 zero
    bytes; the envelope id is inside the canonical body, so two envelopes' first
    entries can never collide despite sharing a genesis."""
    prev = _GENESIS
    if prev_hash and len(prev_hash) == 64:
        try:
            prev = bytes.fromhex(prev_hash)
        except ValueError:
            prev = prev_hash.encode()
    elif prev_hash:
        prev = prev_hash.encode()      # a v1 chain's genesis was the request id
    h = hashlib.sha256()
    h.update(prev)
    h.update(_canonical_entry(request_id, type, detail, party_id, ip, user_agent, at, seq))
    return h.hexdigest()


def _event_hash(prev_hash: str, request_id: str, type: str, detail: str,
                ip: str, user_agent: str, at: str, seq: int,
                party_id: str = "", version: int = _HASH_VERSION) -> str:
    """Dispatch on the version an entry was (or will be) written under."""
    if int(version or 1) >= 2:
        return _event_hash_v2(prev_hash, request_id, type, detail, party_id,
                              ip, user_agent, at, seq)
    return _event_hash_v1(prev_hash, request_id, type, detail, ip, user_agent, at, seq)


def _log(db: Session, request_id: str, type: str, detail: str = "",
         party_id: str = "", ip: str = "", user_agent: str = "") -> None:
    # autoflush=False (this codebase's own established gotcha - see _finalize's
    # own comment on the same issue) means a _log() call later in the SAME
    # request wouldn't see an earlier, uncommitted _log() call's row here,
    # silently breaking the hash chain (two events computing the same "prior"
    # state instead of actually chaining). The explicit flush at the end of
    # this function makes every _log() call see all of its own request's
    # prior events, regardless of call count before the eventual commit.
    # Serialize appends per envelope. Without this, two concurrent events read
    # the same max(seq) and the same prev_hash, then both insert: duplicate seq,
    # a forked chain, and a verification failure nobody can explain. The lock is
    # on the envelope row (the chain's natural mutex); SQLite ignores it, which
    # is fine because it serializes writes anyway. The unique index on
    # (request_id, seq) is the backstop if a path ever skips this.
    db.query(HrSignRequest).filter(HrSignRequest.id == request_id).with_for_update().first()
    prev = (db.query(HrSignEvent.event_hash, HrSignEvent.seq)
            .filter(HrSignEvent.request_id == request_id)
            .order_by(HrSignEvent.seq.desc()).first())
    seq = (prev.seq if prev else 0) + 1
    prev_hash = prev.event_hash if prev and prev.event_hash else request_id
    at = _now_iso()
    detail = detail[:500]
    db.add(HrSignEvent(
        id=str(uuid.uuid4()), request_id=request_id, party_id=party_id, type=type,
        detail=detail, ip=ip, user_agent=user_agent, at=at, seq=seq,
        hash_version=_HASH_VERSION,
        event_hash=_event_hash(prev_hash, request_id, type, detail, ip, user_agent, at, seq,
                               party_id=party_id, version=_HASH_VERSION)))
    db.flush()


def _verify_chain(events: List[HrSignEvent]) -> dict:
    """Tamper-evidence check for the audit trail itself (distinct from the
    final-PDF byte hash in verify_final): replays the hash chain over the
    stored rows and confirms every event_hash matches what _log() would have
    computed. Events created before this feature shipped have seq=0/no hash -
    reported as "chain not available", never as a false pass or fail."""
    if not events:
        return {"chainAvailable": False, "valid": None, "eventCount": 0}
    if events[0].seq == 0 and not events[0].event_hash:
        return {"chainAvailable": False, "valid": None, "eventCount": len(events)}
    ordered = sorted(events, key=lambda e: e.seq)
    # A chain may SPAN the v1 -> v2 change: entries before it were written with
    # the pipe digest, entries after it with JCS, and the link between them is
    # still just "the previous entry's hash". Replaying each entry under the
    # version recorded on it is what lets one envelope verify end to end
    # across the switch.
    prev_hash = ordered[0].request_id
    versions = set()
    for e in ordered:
        version = int(getattr(e, "hash_version", 1) or 1)
        versions.add(version)
        expected = _event_hash(prev_hash, e.request_id, e.type, e.detail or "",
                               e.ip or "", e.user_agent or "", e.at, e.seq,
                               party_id=e.party_id or "", version=version)
        if expected != e.event_hash:
            return {"chainAvailable": True, "valid": False, "eventCount": len(events),
                    "hashVersions": sorted(versions)}
        prev_hash = e.event_hash
    return {"chainAvailable": True, "valid": True, "eventCount": len(events),
            "hashVersions": sorted(versions)}


# ── Serializers (camelCase, matching the hr.py idiom) ─────────────────────────

def _ser_template(t: HrSignTemplate) -> dict:
    return {"id": t.id, "name": t.name, "kind": t.kind, "entityId": t.entity_id,
            "body": t.body or [], "roles": t.roles or [],
            "attachments": t.attachments or [], "status": t.status,
            "egnyteFolder": t.egnyte_folder or "",
            "createdBy": t.created_by, "createdAt": t.created_at, "updatedAt": t.updated_at}


def _ser_party(p: HrSignParty, include_email: bool = True) -> dict:
    out = {"id": p.id, "roleKey": p.role_key, "name": p.name, "kind": p.kind,
           "ordinal": p.ordinal, "status": p.status, "signedAt": p.signed_at,
           "viewedAt": p.viewed_at, "declineReason": p.decline_reason,
           "signatureKind": p.signature_kind,
           "partyRole": p.party_role or "signer",
           "org": p.org or "", "title": p.title or "",
           "failedAuthCount": p.failed_auth_count or 0}
    if include_email:
        out["email"] = p.email
        out["hasAccessCode"] = bool((p.access_code or "").strip())
        out["authMethod"] = p.auth_method or ""
        out["authenticatedAt"] = p.authenticated_at or ""
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
    (overrides win - e.g. salary is typed by the sender, never read from the
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
    """Lazy expiry - flip a stale pending envelope to expired on any access."""
    if req.status == "pending" and req.expires_on:
        exp = str(req.expires_on)[:10]
        # Compare dates, not raw strings: a non-ISO value (e.g. '12/31/2026')
        # would lose a lexicographic compare and instantly expire the envelope.
        # If it isn't a clean ISO date, don't expire on a guess.
        try:
            datetime.strptime(exp, "%Y-%m-%d")
        except ValueError:
            return
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if today > exp:
            req.status = "expired"
            _log(db, req.id, "expired", f"expired on {exp}")
            db.commit()


def _parties(db: Session, request_id: str) -> List[HrSignParty]:
    return (db.query(HrSignParty).filter(HrSignParty.request_id == request_id)
            .order_by(HrSignParty.ordinal).all())


# ── Recipient roles ──────────────────────────────────────────────────────────
# Build note section 3. Each role here has DIFFERENT behaviour in the engine -
# a role that behaved identically to `signer` would be a label pretending to be
# a control, and worse than not having it.
#
#   signer            signs
#   countersigner     signs, on the other side of the agreement. Ordering does
#                     the "counter" part; the label is what the certificate and
#                     the audit trail need to say who signed in what capacity.
#   witness           signs, attesting to another party's execution. Ordered
#                     after the party witnessed.
#   approver          APPROVES without signing. Blocks the envelope until they
#                     do. No signature is captured and none is claimed.
#   certified_delivery  must ACKNOWLEDGE RECEIPT. Never signs. Proves delivery
#                     rather than agreement - the point of the role.
#   cc                receives the sealed copy, never acts.
#
# `notary` is deliberately absent: notarial documents are blocked outright by
# the excluded-record class, because Nexus performs no notarial act and
# California remote online notarization is not operational.
_SIGNING_ROLES = ("signer", "countersigner", "witness")
_APPROVAL_ROLES = ("approver",)
_ACK_ROLES = ("certified_delivery",)
# Everyone whose turn the envelope waits on.
_ACTING_ROLES = _SIGNING_ROLES + _APPROVAL_ROLES + _ACK_ROLES
_PARTY_ROLES = _ACTING_ROLES + ("cc",)

_ROLE_LABELS = {
    "signer": "Signer",
    "countersigner": "Countersigner",
    "witness": "Witness",
    "approver": "Approver",
    "certified_delivery": "Certified delivery",
    "cc": "Copy",
}

# What each acting role's finished state is called. The status a party lands in
# says what they actually DID - an approver is never recorded as having signed.
_ROLE_DONE_STATUS = {
    "signer": "signed", "countersigner": "signed", "witness": "signed",
    "approver": "approved", "certified_delivery": "acknowledged",
}


def _role_of(p) -> str:
    return (p.party_role or "signer") if (p.party_role or "signer") in _PARTY_ROLES else "signer"


def _is_done(p) -> bool:
    """Has this party finished whatever their role requires?"""
    role = _role_of(p)
    if role == "cc":
        return True
    return p.status == _ROLE_DONE_STATUS.get(role, "signed")


def _signs(p) -> bool:
    return _role_of(p) in _SIGNING_ROLES


def _its_their_turn(req: HrSignRequest, party: HrSignParty) -> bool:
    """Whether this party may act NOW - sign, approve or acknowledge, whichever
    their role calls for. An approver holds the envelope up exactly as a signer
    does; that is precisely what separates an approver from a CC."""
    if req.status != "pending" or _role_of(party) not in _ACTING_ROLES:
        return False
    if party.status not in ("waiting", "notified", "viewed"):
        return False
    # Parallel envelopes have no order - everyone outstanding may act now.
    if (req.routing or "sequential") == "parallel":
        return True
    return party.ordinal == req.current_order


# ── Notifications (bell + branded Graph email) ────────────────────────────────

def _sign_email_html(party: HrSignParty, req: HrSignRequest, sender_name: str, link: str) -> str:
    from html import escape
    return f"""<div style="font-family:Inter,Segoe UI,Arial,sans-serif;background:#f3f4f6;padding:28px 12px">
  <table style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border-collapse:collapse;width:100%">
    <tr><td style="background:#14532d;padding:26px 36px">
      <div style="color:#ffffff;font-size:19px;font-weight:800">Nexus</div>
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
        The link is unique to you - please don't forward it.</p>
    </td></tr>
    <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 36px;font-size:11.5px;color:#6b7280;line-height:1.5">
      Sent via Nexus e-sign. This mailbox isn't monitored.
    </td></tr>
  </table>
</div>"""


def _send_sign_email(party: HrSignParty, req: HrSignRequest, sender_name: str) -> tuple:
    sender = os.getenv("NEXUS_FROM_EMAIL", "")
    if not (party.email and sender):
        return False, "no recipient email" if not party.email else "NEXUS_FROM_EMAIL not set"
    link = (f"{_app_url_fn()}/sign/{party.token}" if party.kind == "external"
            else f"{_app_url_fn()}/documents/documents-esign")
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


_ATTACH_MAX = 3_000_000  # Graph simple sendMail caps the whole message at ~4 MB


def _send_sealed_email(to_name: str, to_email: str, req: HrSignRequest, pdf: bytes,
                       link: str, link_label: str, note: str = "") -> tuple:
    """Everyone-signed email - sender, signers and CC alike get the sealed PDF
    ATTACHED (their retained copy, ESIGN retention), plus a link. Oversized
    documents fall back to link-only."""
    from html import escape
    sender = os.getenv("NEXUS_FROM_EMAIL", "")
    if not (to_email and sender):
        return False, "no recipient email" if not to_email else "NEXUS_FROM_EMAIL not set"
    attach = len(pdf) <= _ATTACH_MAX
    doc_line = ("The sealed document, with its Certificate of Completion, is attached to this email."
                if attach else
                "The sealed document (with its Certificate of Completion) is too large to attach - "
                "use the button below to download your copy.")
    html = f"""<div style="font-family:Inter,Segoe UI,Arial,sans-serif;background:#f3f4f6;padding:28px 12px">
  <table style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border-collapse:collapse;width:100%">
    <tr><td style="background:#14532d;padding:26px 36px">
      <div style="color:#ffffff;font-size:19px;font-weight:800">Nexus</div>
      <div style="color:#bbf7d0;font-size:12.5px;margin-top:4px">Document completed</div>
    </td></tr>
    <tr><td style="padding:28px 36px">
      <p style="margin:0 0 14px;font-size:14.5px;color:#111827">Hi {escape(to_name or 'there')},</p>
      <p style="margin:0 0 14px;font-size:14px;color:#374151;line-height:1.6">
        Everyone has signed <strong>{escape(req.title)}</strong>. {doc_line}</p>
      {f'<p style="margin:0 0 14px;font-size:13px;color:#374151;line-height:1.6">{escape(note)}</p>' if note else ''}
      <p style="margin:22px 0"><a href="{link}"
        style="background:#15803d;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 26px;border-radius:9px;display:inline-block">
        {escape(link_label)}</a></p>
      <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.6">
        SHA-256 fingerprint of the sealed file: {escape((req.final_sha256 or '')[:32])}…</p>
    </td></tr>
    <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 36px;font-size:11.5px;color:#6b7280;line-height:1.5">
      Sent via Nexus e-sign. This mailbox isn't monitored.
    </td></tr>
  </table>
</div>"""
    message = {
        "subject": f"Completed: {req.title}",
        "body": {"contentType": "HTML", "content": html},
        "toRecipients": [{"emailAddress": {"address": to_email}}],
    }
    if attach:
        safe = re.sub(r'[\\/:*?"<>|]+', " ", req.title or "Document").strip()[:80] or "Document"
        message["attachments"] = [{
            "@odata.type": "#microsoft.graph.fileAttachment",
            "name": f"{safe} (signed).pdf",
            "contentType": "application/pdf",
            "contentBytes": base64.b64encode(pdf).decode(),
        }]
    try:
        resp = httpx.post(f"https://graph.microsoft.com/v1.0/users/{sender}/sendMail",
                          headers={"Authorization": f"Bearer {_graph_token()}"},
                          json={"message": message, "saveToSentItems": False}, timeout=30)
        return resp.is_success, ("" if resp.is_success else resp.text[:300])
    except Exception as e:
        return False, str(getattr(e, "detail", e))[:300]


def _notify_party(db: Session, party: HrSignParty, req: HrSignRequest, sender_name: str) -> None:
    """Tell a party it's their turn. Bell for internal, email for both (best-effort -
    an email hiccup must never lose the envelope; the event log records it)."""
    if party.kind == "internal":
        _hr_notify(db, party.email, f"Signature required: {req.title}",
                   f"{sender_name} sent you \"{req.title}\" to sign. Open Documents → E-Sign.",
                   ref_id=req.id, requested_by=sender_name,
                   action={"view": "documents", "sub": "documents-esign"})
    ok, detail = _send_sign_email(party, req, sender_name)
    _log(db, req.id, "sent",
         f"notified {party.name} ({party.kind})" + ("" if ok else f" - email failed: {detail}"),
         party_id=party.id)
    party.status = "notified"


_FIELD_TYPES = ("sign", "initials", "date", "text", "check", "dropdown", "radio", "name")


def _clean_fields(fields: list) -> list:
    """Normalize/validate placed field boxes - shared by PDF sends AND template
    attachments. _stamp_pdf at finalize must never meet garbage: a crash there
    permanently wedges a fully-signed envelope, so reject/coerce at save time."""
    for f in fields:
        if not isinstance(f, dict) or f.get("type") not in _FIELD_TYPES:
            raise HTTPException(400, f"Unknown field type: {f.get('type') if isinstance(f, dict) else f!r}")
        if f.get("type") in ("dropdown", "radio"):
            raw = f.get("options") if isinstance(f.get("options"), list) else []
            # Deduped: twin values make the chosen radio ambiguous at seal time
            opts = list(dict.fromkeys(str(o).strip()[:100] for o in raw if str(o).strip()))[:30]
            if len(opts) < 2:
                raise HTTPException(400, "Dropdown and radio fields need at least two options")
            f["options"] = opts
        # Freeze CLEAN geometry - _stamp_pdf does int(page)/float(x,y,w,h) at
        # finalize; a null/non-numeric coord there crashes sealing.
        try:
            f["page"] = max(0, int(f.get("page") or 0))
            for k in ("x", "y", "w", "h"):
                if f.get(k) is not None:
                    f[k] = min(1.0, max(0.0, float(f[k])))
        except (TypeError, ValueError):
            raise HTTPException(400, "A field has an invalid position - please replace it and re-send.")
    return fields


def _clean_attachments(attachments: Optional[list]) -> list:
    """Template attachments carry field boxes that are frozen verbatim onto
    envelopes at send - validate them with the same rules as PDF sends."""
    out = []
    for a in attachments or []:
        if not isinstance(a, dict) or not a.get("path"):
            continue
        a["fields"] = _clean_fields(a.get("fields") or [])
        out.append(a)
    return out


# ── Templates CRUD ────────────────────────────────────────────────────────────

class TemplateIn(BaseModel):
    name:        str
    kind:        Optional[str] = "custom"
    entity_id:   Optional[str] = ""
    body:        Optional[list] = None
    roles:       Optional[list] = None
    attachments: Optional[list] = None   # [{name, path, pages, fields:[...]}]
    status:      Optional[str] = "active"
    egnyte_folder: Optional[str] = None  # e.g. /Shared/Human Resources/Signed ('' = off)


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
    # Blank folder falls back to the wired default (Egnyte module - Wiring tab,
    # slot esign.default-folder), so templates archive somewhere sane without
    # every author retyping the path.
    from egnyte_wiring import effective as _wired
    row = HrSignTemplate(id=str(uuid.uuid4()), name=body.name.strip(), kind=body.kind or "custom",
                         entity_id=body.entity_id or "", body=body.body or [], roles=body.roles or [],
                         attachments=_clean_attachments(body.attachments),
                         egnyte_folder=(body.egnyte_folder or "").strip() or _wired("esign.default-folder")[0],
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
        # N7: statutory forms (CA lien waivers, TX releases) carry prescribed
        # text. Editing the body would produce a document that looks statutory
        # and is not - so the lock refuses the edit rather than warning about
        # it. Roles, name and attachments stay editable.
        if row.body_locked and body.body != (row.body or []):
            raise HTTPException(
                422, "This is a statutory form - its body text is fixed by statute and "
                     "cannot be edited. Duplicate it as a custom template if you need "
                     "different wording.")
        row.body = body.body
    if body.roles is not None:
        row.roles = body.roles
    if body.attachments is not None:
        row.attachments = _clean_attachments(body.attachments)
    if body.egnyte_folder is not None:
        row.egnyte_folder = body.egnyte_folder.strip()
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
         "We are excited to have you join the team - please confirm your acceptance by signing below.",
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
        raise HTTPException(400, "This PDF can't be processed - it may be corrupt or password-protected.")
    safe = re.sub(r"[^a-zA-Z0-9._-]", "_", file.filename or "document.pdf")
    path = f"esign/templates/{uuid.uuid4()}-{safe}"
    up = _storage_put(_DOC_BUCKET, path, blob, "application/pdf")
    if not up.is_success:
        raise HTTPException(502, f"Storage upload failed: {up.text[:200]}")
    return {"name": (file.filename or "document.pdf"), "path": path, "pages": pages, "fields": []}


@router.get("/templates/attachment-url")
def template_attachment_url(path: str, user: dict = Depends(require_hr_read)):
    """Short-lived signed URL to render an attached PDF in the field placer."""
    if not path.startswith("esign/"):
        raise HTTPException(400, "Invalid attachment path")
    resp = _storage_signed_url(_DOC_BUCKET, path)
    if not resp.is_success:
        raise HTTPException(502, "Could not create the preview link")
    return resp.json()


# ── Create + send an envelope ─────────────────────────────────────────────────

class PartyIn(BaseModel):
    role_key:    str
    name:        str
    email:       str
    kind:        Optional[str] = "internal"  # internal|external
    ordinal:     Optional[int] = 1
    party_role:  Optional[str] = "signer"    # signer | cc (gets the sealed copy, never signs)
    access_code: Optional[str] = ""          # external signers only - code the link asks for
    # Capacity to bind: who they signed for and in what role. Optional, because
    # plenty of envelopes are one employee signing for themselves, but on a
    # subcontract it is the difference between a signature and an authorized one.
    org:         Optional[str] = ""
    title:       Optional[str] = ""


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
    excluded_ack: Optional[bool] = False     # sender confirmed this is not an excluded record
    document_class: Optional[str] = ""       # hr_document_classes.code - hard-blocked if not permitted
    governing_law: Optional[str] = ""        # 'CA' routes the standalone consent step


def _validate_parties(parties: List[PartyIn], needed_roles: set) -> None:
    signers = [p for p in parties if (p.party_role or "signer") in _SIGNING_ROLES]
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
        if (p.party_role or "signer") not in _PARTY_ROLES:
            raise HTTPException(400, f"party_role must be one of {', '.join(_PARTY_ROLES)}")
        if (p.access_code or "").strip() and len(p.access_code.strip()) > 40:
            raise HTTPException(400, "Access codes are limited to 40 characters")
        if (p.party_role or "signer") in _SIGNING_ROLES:
            seen_roles.add(p.role_key)
    missing = needed_roles - seen_roles
    if missing:
        raise HTTPException(400, f"No party assigned for role(s): {', '.join(sorted(missing))}")


def _validate_routing(routing: str) -> str:
    r = (routing or "sequential").strip()
    if r not in ("sequential", "parallel"):
        raise HTTPException(400, "routing must be sequential or parallel")
    return r


def _record_packet_at_send(db: Session, req: HrSignRequest) -> None:
    """Freeze each packet file's digest AS SENT.

    Computed here, at send, from the bytes in storage right now - not at
    completion, where "the file as sent" would really mean "the file as it
    stands at the end", and a swap in between would go unnoticed and be printed
    on the certificate as unaltered. An authored template has no file yet (it
    is rendered from the frozen body_snapshot at completion), so it gets a row
    with an empty send digest rather than a fabricated one.
    """
    now = _now_iso()
    entries = []
    if req.source == "template":
        entries.append((req.title or "Document", "", b""))
    elif req.pdf_storage_path:
        blob = _storage_fetch(_DOC_BUCKET, req.pdf_storage_path)
        entries.append((req.pdf_storage_path.rsplit("/", 1)[-1] or req.title,
                        req.pdf_storage_path, blob.content if blob.is_success else b""))
    for d in (req.documents or []):
        path = d.get("path", "")
        blob = _storage_fetch(_DOC_BUCKET, path) if path else None
        entries.append((d.get("name") or path.rsplit("/", 1)[-1], path,
                        blob.content if (blob is not None and blob.is_success) else b""))
    for i, (name, path, content) in enumerate(entries, 1):
        db.add(HrSignDocument(
            id=str(uuid.uuid4()), request_id=req.id, ordinal=i, name=name or "Document",
            storage_path=path, page_count=0, created_at=now,
            digest_at_send=hashlib.sha256(content).hexdigest() if content else ""))
    db.flush()


def _create_request(db: Session, user: dict, *, title: str, source: str, template_id: str,
                    employee_id: str, candidate_id: str, entity_id: str, body_snapshot: list,
                    pdf_storage_path: str, fields: list, message: str, expires_on: str,
                    parties: List[PartyIn], ip: str, user_agent: str,
                    documents: Optional[list] = None, routing: str = "sequential",
                    egnyte_folder: str = "", excluded_ack: bool = False,
                    document_class: str = "", governing_law: str = "") -> dict:
    # Server-side, at the one point BOTH send paths reach: a guardrail that
    # lives only in the wizard is not a guardrail - the API is reachable
    # without it, and this is the check that keeps a will or an eviction
    # notice out of a system whose signature would have no legal effect on it.
    if not excluded_ack:
        raise HTTPException(422, "The sender must confirm this document is not an excluded record "
                                 "type before it can be sent for signature.")
    # Hard block on the declared class (ESIGN 7003 / Cal. Civ. Code 1633.3).
    # The acknowledgment above is the sender's word; this is the system's.
    if document_class:
        _ensure_document_classes(db)
        cls = db.query(HrDocumentClass).filter(HrDocumentClass.code == document_class).first()
        if not cls:
            raise HTTPException(400, f"Unknown document class '{document_class}'")
        if not cls.electronic_permitted:
            raise HTTPException(
                422, f"{cls.label} cannot be signed electronically ({cls.citation}). "
                     f"{cls.note}".strip())
    now = _now_iso()
    ordered = sorted(parties, key=lambda p: p.ordinal or 1)
    signer_ordinals = [p.ordinal or 1 for p in ordered
                       if (p.party_role or "signer") in _ACTING_ROLES]
    req = HrSignRequest(id=str(uuid.uuid4()), title=title, source=source, template_id=template_id,
                        employee_id=employee_id or "", candidate_id=candidate_id or "",
                        entity_id=entity_id or "", body_snapshot=body_snapshot,
                        pdf_storage_path=pdf_storage_path, fields=fields, status="pending",
                        documents=documents or [], routing=routing,
                        egnyte_folder=(egnyte_folder or "").strip(),
                        current_order=min(signer_ordinals), message=message or "",
                        expires_on=expires_on or "", created_by=user["email"],
                        created_at=now, excluded_ack_at=now, excluded_ack_by=user["email"],
                        document_class=document_class or "",
                        governing_law=(governing_law or _DEFAULT_GOVERNING_LAW).upper()[:2])
    db.add(req)
    rows = []
    for p in ordered:
        rows.append(HrSignParty(id=str(uuid.uuid4()), request_id=req.id, role_key=p.role_key,
                                name=p.name.strip(), email=p.email.strip().lower(),
                                kind=p.kind or "internal", ordinal=p.ordinal or 1,
                                party_role=p.party_role or "signer",
                                access_code=(p.access_code or "").strip(),
                                org=(p.org or "").strip()[:200],
                                title=(p.title or "").strip()[:200],
                                status="waiting", token=secrets.token_urlsafe(32)))
        db.add(rows[-1])
    _record_packet_at_send(db, req)
    _log(db, req.id, "created",
         f"by {user['email']} - {len(rows)} parties ({routing})", ip=ip, user_agent=user_agent)
    _log(db, req.id, "acknowledged",
         f"{user['email']} confirmed this is not a record excluded from electronic signature "
         f"(15 U.S.C. 7003 / Cal. Civ. Code 1633.3)", ip=ip, user_agent=user_agent)
    sender_name = user["email"].split("@")[0].replace(".", " ").title()
    # Sequential: only the first signer hears about it now. Parallel: every
    # signer is invited at once. CC parties hear at completion, not at send.
    # Everyone who must act is invited, not only signers - an approver first
    # in the order is who the envelope is waiting on.
    actors = [r for r in rows if _role_of(r) in _ACTING_ROLES]
    to_notify = actors if routing == "parallel" else actors[:1]
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
                           documents=attachments, routing=routing,
                           egnyte_folder=tpl.egnyte_folder or "",
                           excluded_ack=bool(body.excluded_ack),
                           document_class=body.document_class or "",
                           governing_law=body.governing_law or "")


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
    # Validate NOW with the same parser finalize uses - a corrupt PDF must be
    # rejected at send time, not when the last signer hits Finish.
    try:
        from pypdf import PdfReader
        page_count = len(PdfReader(io.BytesIO(blob)).pages)
        if page_count == 0:
            raise ValueError("no pages")
    except Exception:
        raise HTTPException(400, "This PDF can't be processed - it may be corrupt or password-protected. "
                                 "Re-export it (e.g. print to PDF) and try again.")
    fields = data.get("fields") or []
    if not fields:
        raise HTTPException(400, "Place at least one field on the document")
    fields = _clean_fields(fields)
    parties = [PartyIn(role_key=p.get("roleKey", ""), name=p.get("name", ""),
                       email=p.get("email", ""), kind=p.get("kind", "internal"),
                       ordinal=int(p.get("ordinal") or 1),
                       party_role=p.get("partyRole", "signer"),
                       access_code=p.get("accessCode", "")) for p in (data.get("parties") or [])]
    _validate_parties(parties, {f.get("role", "") for f in fields})
    routing = _validate_routing(data.get("routing", "sequential"))

    path = f"esign/{uuid.uuid4()}/source.pdf"
    up = _storage_put(_DOC_BUCKET, path, blob, "application/pdf")
    if not up.is_success:
        raise HTTPException(502, f"Storage upload failed: {up.text[:200]}")
    ip, ua = _client_meta(request)
    return _create_request(db, user, title=(data.get("title") or file.filename or "Document").strip(),
                           source="pdf", template_id="", employee_id=data.get("employeeId") or "",
                           candidate_id=data.get("candidateId") or "", entity_id=data.get("entityId") or "",
                           body_snapshot=[], pdf_storage_path=path, fields=fields,
                           message=data.get("message") or "", expires_on=data.get("expiresOn") or "",
                           parties=parties, ip=ip, user_agent=ua, routing=routing,
                           egnyte_folder=str(data.get("egnyteFolder") or ""),
                           excluded_ack=bool(data.get("excludedAck")),
                           document_class=str(data.get("documentClass") or ""),
                           governing_law=str(data.get("governingLaw") or ""))


# ── Document classes: what may be signed electronically at all ───────────────
# The sender picks a class at send time and the server refuses the send if that
# class is not permitted. This is the hard block ESIGN 7003 / Cal. Civ. Code
# 1633.3 require; the sender's acknowledgment (excluded_ack) stays as the
# second control, because a class list only covers what someone thought to
# enumerate and the acknowledgment covers the rest.
#
# `electronic_permitted = False` rows exist on purpose: the sender sees them,
# picks the honest one, and is stopped with the citation and what to do
# instead - which is far more useful than an absent option they work around by
# picking "Other".
_DOCUMENT_CLASS_SEED = [
    # code, label, permitted, citation, note, sort
    ("subcontract", "Subcontract or construction agreement", True, "", "", 10),
    ("vendor_agreement", "Vendor or service agreement", True, "", "", 20),
    ("nda", "NDA or confidentiality agreement", True, "", "", 30),
    ("employment", "Employment or HR document", True, "", "", 40),
    ("lease_commercial", "Commercial lease or amendment", True, "", "", 50),
    ("purchase_order", "Purchase order or change order", True, "", "", 60),
    ("lien_waiver", "Lien waiver or release (statutory form)", True, "", "", 70),
    ("insurance_cert", "Insurance certificate or endorsement", True, "", "", 80),
    ("other_permitted", "Other business record", True, "", "", 90),

    ("will", "Will, codicil or testamentary trust", False,
     "15 U.S.C. 7003(a)(1); Cal. Civ. Code 1633.3(b)(1)",
     "Must be executed on paper with the statutory witnessing formalities.", 200),
    ("family_law", "Adoption, divorce or other family law matter", False,
     "15 U.S.C. 7003(a)(2)",
     "Handle on paper through counsel.", 210),
    ("court_document", "Court order, notice or filing", False,
     "15 U.S.C. 7003(b)(1)",
     "File through the court's own system.", 220),
    ("residential_default", "Notice of default, foreclosure or repossession on a residence", False,
     "15 U.S.C. 7003(b)(2)(B)",
     "Serve on paper by the method the statute requires. This applies to Greens Residential.", 230),
    ("eviction_notice", "Eviction or termination-of-tenancy notice", False,
     "15 U.S.C. 7003(b)(2)(B)",
     "Serve on paper by the method the statute requires.", 240),
    ("utility_cancellation", "Notice cancelling utility service", False,
     "15 U.S.C. 7003(b)(2)(A)", "Send on paper.", 250),
    ("insurance_termination", "Cancellation of health or life insurance benefits", False,
     "15 U.S.C. 7003(b)(2)(C)", "Send on paper.", 260),
    ("product_recall", "Product recall or material failure notice affecting health or safety", False,
     "15 U.S.C. 7003(b)(2)(D)", "Send on paper.", 270),
    ("hazmat", "Document accompanying transport of hazardous materials", False,
     "15 U.S.C. 7003(b)(3)", "Must travel with the shipment on paper.", 280),
    ("notarial", "Anything requiring a notary", False,
     "Cal. Civ. Code 1633.11; Cal. Gov. Code 16.5",
     "Use a notary. California remote online notarization is not operational yet.", 290),
]


def _ensure_document_classes(db: Session) -> None:
    """Seed the class table once per install, and keep the legal facts current.

    Permitted-ness, citation and note are REFRESHED from the seed on every
    boot: they are statements of law, and a stale row in the database is how a
    category silently stays open after counsel closes it. The code and label
    are left alone once created so existing envelopes keep their reference."""
    existing = {c.code: c for c in db.query(HrDocumentClass).all()}
    changed = False
    for code, label, permitted, citation, note, sort in _DOCUMENT_CLASS_SEED:
        row = existing.get(code)
        if row is None:
            db.add(HrDocumentClass(code=code, label=label, electronic_permitted=permitted,
                                   citation=citation, note=note, sort_order=sort))
            changed = True
        elif (row.electronic_permitted != permitted or (row.citation or "") != citation
              or (row.note or "") != note):
            row.electronic_permitted = permitted
            row.citation = citation
            row.note = note
            changed = True
    if changed:
        db.commit()


# ── Legal holds and retention (N10) ──────────────────────────────────────────
# A hold always beats a schedule. Purging a record that is under hold is
# spoliation, and "the retention job ran" is not a defense - so the hold check
# is in the purge function itself, not in whatever calls it.
#
# Note what this deliberately does NOT do: nothing schedules the purge. Signed
# agreements are not the kind of thing to start deleting on a timer because a
# default was set once; switching it on is a policy decision with a retention
# period attached, and it should be made explicitly, per document class. The
# machinery is here and tested so that decision is a configuration change
# rather than a project.

class HoldIn(BaseModel):
    reason: str


@router.post("/requests/{rid}/holds")
def place_hold(rid: str, body: HoldIn, user: dict = Depends(require_hr_write),
               db: Session = Depends(get_db)):
    """Put an envelope under legal hold. Audited on the envelope's own chain."""
    req = db.query(HrSignRequest).filter(HrSignRequest.id == rid).first()
    if not req:
        raise HTTPException(404, "Request not found")
    if not body.reason.strip():
        raise HTTPException(400, "A hold needs a reason")
    hold = HrSignRetentionHold(id=str(uuid.uuid4()), request_id=rid,
                               reason=body.reason.strip()[:500], placed_by=user["email"],
                               placed_at=_now_iso())
    db.add(hold)
    _log(db, rid, "hold_placed", f"legal hold by {user['email']}: {hold.reason}")
    db.commit()
    return {"id": hold.id, "requestId": rid, "reason": hold.reason,
            "placedBy": hold.placed_by, "placedAt": hold.placed_at, "active": True}


@router.post("/requests/{rid}/holds/{hid}/release")
def release_hold(rid: str, hid: str, user: dict = Depends(require_hr_write),
                 db: Session = Depends(get_db)):
    hold = (db.query(HrSignRetentionHold)
            .filter(HrSignRetentionHold.id == hid, HrSignRetentionHold.request_id == rid).first())
    if not hold:
        raise HTTPException(404, "Hold not found")
    if hold.released_at:
        raise HTTPException(409, "This hold is already released")
    hold.released_at = _now_iso()
    hold.released_by = user["email"]
    _log(db, rid, "hold_released", f"legal hold released by {user['email']}")
    db.commit()
    return {"id": hold.id, "requestId": rid, "active": False,
            "releasedBy": hold.released_by, "releasedAt": hold.released_at}


@router.get("/requests/{rid}/holds")
def list_holds(rid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    rows = (db.query(HrSignRetentionHold).filter(HrSignRetentionHold.request_id == rid)
            .order_by(HrSignRetentionHold.placed_at).all())
    return [{"id": h.id, "reason": h.reason, "placedBy": h.placed_by, "placedAt": h.placed_at,
             "releasedBy": h.released_by, "releasedAt": h.released_at,
             "active": not h.released_at} for h in rows]


def is_on_hold(db: Session, request_id: str) -> bool:
    """True while ANY hold on this envelope is unreleased."""
    return (db.query(HrSignRetentionHold)
            .filter(HrSignRetentionHold.request_id == request_id,
                    HrSignRetentionHold.released_at == "").first() is not None)


def run_retention_sweep(db: Session, dry_run: bool = True) -> dict:
    """Per-document-class retention, holds always winning.

    Runs from the nightly scan but does NOTHING until a class is given a
    retention period: every seeded class is 0 = keep indefinitely. Deleting an
    executed agreement is a decision someone has to make per class, with a
    number attached - it must never be something that starts happening because
    a migration shipped.

    dry_run stays the default here too. The scheduled call passes
    dry_run=False only when NEXUS_ESIGN_RETENTION_ENFORCE is set, so switching
    real deletion on is one deliberate environment change, visible in config
    rather than buried in code.
    """
    from models import HrDocumentClass as _Cls
    classes = [c for c in db.query(_Cls).all() if (c.retention_months or 0) > 0]
    if not classes:
        return {"classes": 0, "eligible": [], "held": [], "purged": [], "dryRun": dry_run}
    eligible, held, purged = [], [], []
    for cls in classes:
        days = int(cls.retention_months) * 31          # deliberately generous
        out = purge_expired_envelopes(db, retain_days=days, dry_run=dry_run,
                                      document_class=cls.code)
        eligible += out["eligible"]
        held += out["held"]
        purged += out["purged"]
    if purged or held:
        print(f"[reminders] e-sign retention: purged {len(purged)}, "
              f"{len(held)} under legal hold, dry_run={dry_run}")
    return {"classes": len(classes), "eligible": eligible, "held": held,
            "purged": purged, "dryRun": dry_run}


def purge_expired_envelopes(db: Session, retain_days: int, dry_run: bool = True,
                            document_class: str = "") -> dict:
    """Purge completed envelopes older than `retain_days`, EXCEPT any under a
    legal hold. Returns what it did (or would do, when dry_run).

    Dry run is the default on purpose: the caller has to say, in so many words,
    that it means to destroy signed agreements.
    """
    if retain_days <= 0:
        return {"eligible": [], "held": [], "purged": [], "dryRun": dry_run}
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retain_days)).isoformat()
    q = (db.query(HrSignRequest)
         .filter(HrSignRequest.status == "completed",
                 HrSignRequest.completed_at != "",
                 HrSignRequest.completed_at < cutoff))
    if document_class:
        q = q.filter(HrSignRequest.document_class == document_class)
    candidates = q.all()
    eligible, held = [], []
    for req in candidates:
        (held if is_on_hold(db, req.id) else eligible).append(req.id)
    purged = []
    if not dry_run:
        for rid in eligible:
            req = db.query(HrSignRequest).filter(HrSignRequest.id == rid).first()
            if not req or is_on_hold(db, rid):     # re-check: a hold may have landed since
                continue
            # The stored PDF is left in place deliberately: object storage is
            # where the WORM/retention-lock control will live (open decision 3
            # in the build note), and deleting the bytes from here would
            # quietly defeat it. This purges the database record only.
            db.query(HrSignParty).filter(HrSignParty.request_id == rid).delete()
            db.query(HrSignConsent).filter(HrSignConsent.request_id == rid).delete()
            db.delete(req)
            purged.append(rid)
        db.commit()
    return {"eligible": eligible, "held": held, "purged": purged, "dryRun": dry_run}


@router.get("/disclosures")
def current_disclosures(user: dict = Depends(get_current_user)):
    """The disclosure text behind the version the certificate cites, with its
    digest. The one-page certificate names a version and a digest instead of
    reprinting five paragraphs; this is where the text itself lives, so the
    digest on the certificate is something a reader can actually recompute."""
    text = _disclosure_text()
    return {"version": _CONSENT_VERSION, "digest": _disclosure_digest(),
            "consentText": _CONSENT_TEXT, "text": text,
            "sections": [{"heading": h, "body": b} for h, b in _disclosures()]}


@router.get("/requests/{rid}/certificate")
def certificate_of_record(rid: str, user: dict = Depends(require_hr_read),
                          db: Session = Depends(get_db)):
    """The certificate of record as issued, plus its digest and the frozen
    snapshot it was rendered from.

    `regenerates` is the point of the whole exercise: re-render the stored
    snapshot and compare bytes with what was issued. True means the certificate
    attached to a filing is exactly what this system produced and has not been
    edited by hand."""
    req = db.query(HrSignRequest).filter(HrSignRequest.id == rid).first()
    if not req:
        raise HTTPException(404, "Request not found")
    import auth
    auth.assert_company(auth.company_of(req.created_by or "", db), user, db)
    if not req.certificate_html:
        raise HTTPException(409, "No certificate yet - this envelope is not completed")
    snapshot = req.certificate_snapshot or {}
    regenerated = render_certificate_html(snapshot) if snapshot else ""
    return {
        "requestId": req.id,
        "html": req.certificate_html,
        "sha256": req.certificate_sha256,
        "snapshot": snapshot,
        "regenerates": bool(regenerated) and regenerated == req.certificate_html,
    }


@router.get("/document-classes")
def document_classes(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Every class, permitted or not, with the citation for the ones that are
    not. The send wizard shows all of them - see the seed's own comment."""
    _ensure_document_classes(db)
    rows = db.query(HrDocumentClass).order_by(HrDocumentClass.sort_order).all()
    return [{"code": c.code, "label": c.label, "electronicPermitted": bool(c.electronic_permitted),
             "citation": c.citation or "", "note": c.note or ""} for c in rows]


@router.get("/excluded-categories")
def excluded_categories(user: dict = Depends(get_current_user)):
    """The record types an electronic signature has no legal effect on. Served
    (rather than duplicated in the frontend) so the wizard's checklist and the
    server's guardrail can never drift apart."""
    return [{"label": label, "citation": cite} for label, cite in _EXCLUDED_RECORD_CATEGORIES]


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
    # Lock + re-read so a void can't race a concurrent final signature (else the
    # envelope could seal 'completed' after the sender thought they'd voided it).
    db.query(HrSignRequest).filter(HrSignRequest.id == rid).with_for_update().first()
    db.expire_all()
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
        raise HTTPException(409, f"{party.name} has already {party.status} - correction is impossible")
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
    _log(db, rid, "corrected", f"{'; '.join(changes)} - by {user['email']}",
         party_id=party.id, ip=ip, user_agent=ua)
    if credential_changed:   # only a fresh credential clears the lockout, not a name typo fix
        _log(db, rid, "code_reset", "credential changed - access-code lockout reset",
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
    (email fallback). Write grant + audit trail - this link signs as them."""
    req = db.query(HrSignRequest).filter(HrSignRequest.id == rid).first()
    party = db.query(HrSignParty).filter(HrSignParty.id == pid,
                                         HrSignParty.request_id == rid).first()
    if not req or not party:
        raise HTTPException(404, "Not found")
    if party.kind != "external":
        raise HTTPException(400, "Teammates sign inside Nexus - there is no external link")
    if req.status != "pending":
        raise HTTPException(409, f"Request is {req.status}")
    _log(db, rid, "link_copied", f"{party.name}'s signing link copied by {user['email']}",
         party_id=party.id)
    db.commit()
    return {"url": f"{_app_url_fn()}/sign/{party.token}",
            "hasAccessCode": bool((party.access_code or "").strip()),
            "accessCode": (party.access_code or "").strip()}


@router.get("/requests/{rid}/download")
def download_final(rid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    req = db.query(HrSignRequest).filter(HrSignRequest.id == rid).first()
    if not req or not req.final_pdf_path:
        raise HTTPException(404, "No completed document")
    resp = _storage_signed_url(_DOC_BUCKET, req.final_pdf_path)
    if not resp.is_success:
        raise HTTPException(502, "Could not create download link")
    _log(db, rid, "downloaded", f"by {user['email']}")
    db.commit()
    return resp.json()


def _check_final_integrity(req: HrSignRequest) -> dict:
    """Live re-hash of the stored final PDF vs. the sealed hash - shared by the
    internal /verify endpoint and the public /verify/{token} page so the two
    never drift out of sync with each other."""
    resp = _storage_fetch(_DOC_BUCKET, req.final_pdf_path)
    if not resp.is_success:
        raise HTTPException(502, "Could not fetch the stored document")
    actual = hashlib.sha256(resp.content).hexdigest()
    return {"valid": actual == req.final_sha256, "expected": req.final_sha256, "actual": actual}


@router.get("/requests/{rid}/verify")
def verify_final(rid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    """Tamper check: re-hash the stored final PDF and compare with the sealed
    hash, plus the audit-trail hash-chain status. Also lazily backfills
    verify_token for envelopes completed before the QR/public-verify feature
    shipped, so every completed envelope ends up with a working /verify/{token}
    link to share - even though only newly-sealed PDFs get the QR printed on
    the certificate page itself (an already-sealed PDF can't be edited to add
    one without invalidating its own hash)."""
    req = db.query(HrSignRequest).filter(HrSignRequest.id == rid).first()
    if not req or not req.final_pdf_path:
        raise HTTPException(404, "No completed document")
    integrity = _check_final_integrity(req)
    events = (db.query(HrSignEvent).filter(HrSignEvent.request_id == rid)
              .order_by(HrSignEvent.seq).all())
    chain = _verify_chain(events)
    if not req.verify_token:
        req.verify_token = secrets.token_urlsafe(24)
        db.commit()
    return {**integrity, "chainValid": chain["valid"], "chainAvailable": chain["chainAvailable"],
            "eventCount": chain["eventCount"], "verifyToken": req.verify_token}


# ── My signatures (any logged-in employee) ────────────────────────────────────

@router.get("/mine")
def my_signatures(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Inbox: everything awaiting me (my turn) + queued behind others."""
    email = user["email"].lower()
    parties = (db.query(HrSignParty).filter(HrSignParty.email == email,
               HrSignParty.status.in_(["waiting", "notified", "viewed"])).all())
    out = []
    for p in parties:
        if _role_of(p) not in _ACTING_ROLES:
            continue                       # CC recipients never have anything to do
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
               "myPartyRole": party.party_role or "signer",
               "myName": party.name, "myStatus": party.status, "parties": others,
               "consentText": _CONSENT_TEXT, "consentVersion": _CONSENT_VERSION,
               # 15 U.S.C. 7001(c) requires these to be given BEFORE consent,
               # so they ship with the payload the signing screen renders -
               # the certificate cites this same version as "shown to each
               # signer before consent", which is only true if it really was.
               "disclosures": [{"heading": h, "body": b} for h, b in _disclosures()],
               "disclosureDigest": _disclosure_digest(),
               "supportContact": _SUPPORT_CONTACT,
               # UETA section 8 retention: where this signer downloads their own
               # copy of the document while deciding. Public link only - an
               # internal signer already has the document in Nexus.
               "copyUrl": (f"{_api_base()}/esign/public/{party.token}/copy"
                           if party.kind == "external" and party.token else ""),
               # Cal. Civ. Code 1633.5(b): in California the agreement to
               # transact electronically may not be bundled into the deal, so
               # the UI renders consent as its own screen BEFORE the document.
               "governingLaw": (req.governing_law or _DEFAULT_GOVERNING_LAW).upper(),
               "standaloneConsent": (req.governing_law or _DEFAULT_GOVERNING_LAW).upper() == "CA",
               "expiresOn": req.expires_on}
    def sign_url(path):
        resp = _storage_signed_url(_DOC_BUCKET, path)
        return resp.json().get("url", "") if resp.is_success else ""

    if req.source == "template":
        payload["body"] = req.body_snapshot or []
        payload["myFields"] = [f for f in _fields_in_body(req.body_snapshot or [])
                               if f["role"] == party.role_key]
    else:
        payload["pdfUrl"] = sign_url(req.pdf_storage_path)
        payload["fields"] = req.fields or []
        payload["myFields"] = [f for f in (req.fields or []) if f.get("role") == party.role_key]
    # Attached packet documents (template attachments) - signed as one envelope
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
    # ESIGN 7001(c)(1)(C)(ii): consent must be given in a manner that reasonably
    # demonstrates the signer can access the form the record will be in. The
    # signing screen reports what it actually rendered; the server records it
    # verbatim and never invents a value.
    format_demonstrated: Optional[str] = ""  # 'pdf_rendered_in_session' | 'html_rendered_in_session' | ''
    session_id:          Optional[str] = ""
    # Reported by the signing screen: how many of the packet's pages it
    # actually displayed to this signer. Recorded verbatim - the server never
    # assumes a page was seen because a signature arrived.
    pages_viewed:        Optional[int] = 0
    pages_total:         Optional[int] = 0


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


class ActIn(BaseModel):
    """An approval or a delivery acknowledgment. No signature: these roles do
    not sign, and capturing one would misdescribe what they did."""
    consent:     bool = True             # approvers still consent to transact electronically
    note:        Optional[str] = ""
    access_code: Optional[str] = ""
    format_demonstrated: Optional[str] = ""
    session_id:  Optional[str] = ""


def _apply_act(db: Session, req: HrSignRequest, party: HrSignParty, body: ActIn,
               ip: str, ua: str) -> dict:
    """Record an approval or an acknowledgment, then advance exactly as a
    signature does.

    Serialized on the request row for the same reason _apply_signature is: the
    last outstanding party might be an approver, and two concurrent actions
    must not both decide the envelope is finished (or both decide it is not).
    """
    db.query(HrSignRequest).filter(HrSignRequest.id == req.id).with_for_update().first()
    db.expire_all()
    req = db.query(HrSignRequest).filter(HrSignRequest.id == req.id).first()
    party = db.query(HrSignParty).filter(HrSignParty.id == party.id).first()
    if not req or not party:
        raise HTTPException(404, "Not found")
    _check_expiry(db, req)
    if req.status != "pending":
        raise HTTPException(409, f"This document is {req.status}")

    role = _role_of(party)
    if role not in _APPROVAL_ROLES + _ACK_ROLES:
        raise HTTPException(400, "This party signs - use the signing endpoint, not this one")
    if not _its_their_turn(req, party):
        raise HTTPException(409, "It is not your turn yet" if not _is_done(party)
                            else "You have already responded")

    now = _now_iso()
    party.ip, party.user_agent = ip, ua
    party.status = _ROLE_DONE_STATUS[role]
    if role in _APPROVAL_ROLES:
        # An approver is agreeing to the record electronically too, so the
        # consent evidence is captured the same way a signer's is.
        party.consent_at = now
        party.consent_text_version = _CONSENT_VERSION
        db.add(HrSignConsent(
            id=str(uuid.uuid4()), party_id=party.id, request_id=req.id,
            disclosure_version=_CONSENT_VERSION, disclosure_digest=_disclosure_digest(),
            scope="transaction", format_demonstrated=(body.format_demonstrated or "")[:64],
            accepted_at=now, accepted_ip=ip, session_id=(body.session_id or "")[:64],
            standing_basis=("Employment agreement - enterprise electronic records consent"
                            if party.kind == "internal" else "")))
        _log(db, req.id, "approved",
             f"{party.name} approved" + (f": {body.note.strip()[:200]}" if body.note else ""),
             party_id=party.id, ip=ip, user_agent=ua)
    else:
        party.acknowledged_at = now
        _log(db, req.id, "acknowledged",
             f"{party.name} acknowledged receipt"
             + (f": {body.note.strip()[:200]}" if body.note else ""),
             party_id=party.id, ip=ip, user_agent=ua)

    _advance_or_finalize(db, req)
    db.commit()
    return {"ok": True, "status": req.status, "role": role, "recorded": party.status}


def _advance_or_finalize(db: Session, req: HrSignRequest) -> list:
    """Move to the next party, or seal when everyone has done their part.

    "Everyone" means every ACTING party, by their own role's definition of
    done: signers signed, approvers approved, certified-delivery recipients
    acknowledged. An envelope that finalized once its signatures were in while
    an approver was still outstanding would be exactly the bug the role is
    there to prevent.
    """
    remaining = [p for p in _parties(db, req.id)
                 if _role_of(p) in _ACTING_ROLES and not _is_done(p)]
    if remaining:
        if (req.routing or "sequential") == "sequential":
            nxt = min(remaining, key=lambda p: p.ordinal)
            req.current_order = nxt.ordinal
            sender_name = req.created_by.split("@")[0].replace(".", " ").title()
            _notify_party(db, nxt, req, sender_name)
        # parallel: everyone was invited at send - nothing to advance
        return remaining
    try:
        _finalize(db, req)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"The sealed PDF could not be generated ({str(e)[:150]}). "
                                 f"Your response was not saved - please try again or contact HR.")
    return []


def _apply_signature(db: Session, req: HrSignRequest, party: HrSignParty, body: SignIn,
                     ip: str, ua: str) -> dict:
    """The shared engine: record the signature, advance the order, finalize when done.

    Serialized on the request row: two signers of the SAME envelope (parallel
    routing, or a double-submit of the last signer) must not both read sibling
    statuses before the other commits - otherwise each sees the other unsigned,
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
    if not _signs(party):
        raise HTTPException(400, f"A {_ROLE_LABELS[_role_of(party)].lower()} does not sign this "
                                 f"document - use the approve or acknowledge action instead")
    if not _its_their_turn(req, party):
        raise HTTPException(409, "It is not your turn to sign yet" if party.status != "signed"
                            else "You have already signed")
    _validate_signature(body)
    now = _now_iso()
    party.signature_kind = body.signature_kind
    party.signature_data = body.signature_data
    # Frozen now, over the bytes actually submitted, rather than recomputed from
    # signature_data whenever a certificate is rendered.
    party.signature_digest = hashlib.sha256((body.signature_data or "").encode()).hexdigest()
    party.pages_viewed = max(0, int(body.pages_viewed or 0))
    party.pages_total = max(0, int(body.pages_total or 0))
    party.consent_at = now
    party.consent_text_version = _CONSENT_VERSION
    party.field_values = body.field_values or {}
    party.ip, party.user_agent = ip, ua
    party.signed_at = now
    party.status = "signed"
    db.add(HrSignConsent(
        id=str(uuid.uuid4()), party_id=party.id, request_id=req.id,
        disclosure_version=_CONSENT_VERSION, disclosure_digest=_disclosure_digest(),
        scope="transaction",
        format_demonstrated=(body.format_demonstrated or "")[:64],
        accepted_at=now, accepted_ip=ip, session_id=(body.session_id or "")[:64],
        standing_basis=("Employment agreement - enterprise electronic records consent"
                        if party.kind == "internal" else ""),
    ))
    _log(db, req.id, "consented",
         f"{party.name} consented ({_CONSENT_VERSION}"
         + (f", {body.format_demonstrated}" if body.format_demonstrated else "")
         + ")", party_id=party.id, ip=ip, user_agent=ua)
    _log(db, req.id, "signed", f"{party.name} signed ({body.signature_kind})",
         party_id=party.id, ip=ip, user_agent=ua)

    remaining = _advance_or_finalize(db, req)
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
    # Criterion 9: authentication is stamped BEFORE anything renders. On this
    # path the credential has already been checked above (Nexus session for an
    # internal party, the emailed token plus any access code for an external
    # one) and the payload is built below - so a party whose authenticated_at
    # is empty has, by construction, never been shown the document.
    if not party.authenticated_at:
        party.authenticated_at = _now_iso()
        party.auth_method, party.auth_factors = _auth_record(party)
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
    # CC recipients receive a copy, they never sign - so they can't decline the
    # whole envelope out from under the real signers.
    if (party.party_role or "signer") != "signer":
        raise HTTPException(403, "You are on this document for a copy only - there is nothing to decline.")
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
               action={"view": "documents", "sub": "documents-esign-requests"})
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


# ── Public signing (token is the credential - NO auth) ────────────────────────

_CODE_LOCKOUT_ATTEMPTS = 10

# Token-guessing throttle (SECURITY-TODO item 7a). The 43-char token's entropy
# is the real defense; this stops an attacker from probing at network speed and
# makes probing visible in the logs. In-process per gunicorn worker (no Redis
# in this stack), so the effective ceiling is 8x these numbers - still collapses
# guessing from "unbounded" to "a few hundred tries an hour, loudly".
_GUESS_WINDOW_SEC = 900
_GUESS_MAX_MISSES = 20          # unknown-token 404s per IP per window
_guess_lock = threading.Lock()
_guess_misses: dict = {}        # ip -> [timestamps of unknown-token misses]


def _note_token_miss(request: Optional[Request]) -> None:
    """Record an unknown-token 404 for this IP; 429 once it exceeds the cap.
    Wrong tokens only - legit signers re-opening their link never hit this."""
    ip, _ = _client_meta(request)
    now = time.time()
    with _guess_lock:
        hits = [t for t in _guess_misses.get(ip, []) if now - t < _GUESS_WINDOW_SEC]
        hits.append(now)
        _guess_misses[ip] = hits
        if len(_guess_misses) > 10000:      # bound memory under spoofed-IP floods
            _guess_misses.clear()
        blocked = len(hits) > _GUESS_MAX_MISSES
        just_tripped = len(hits) == _GUESS_MAX_MISSES + 1   # log the crossing, not every hit
    if blocked:
        if just_tripped:
            from middleware_hardening import security_log
            security_log("esign_token_guessing", f"{len(hits)} unknown-token misses in "
                         f"{_GUESS_WINDOW_SEC}s", ip=ip)
        raise HTTPException(429, "Too many attempts - try again later.")


def _party_by_token(db: Session, token: str, request: Optional[Request] = None) -> tuple:
    if not token or len(token) < 20:
        _note_token_miss(request)
        raise HTTPException(404, "Not found")
    party = db.query(HrSignParty).filter(HrSignParty.token == token).first()
    if not party:
        _note_token_miss(request)
        raise HTTPException(404, "Not found")
    req = db.query(HrSignRequest).filter(HrSignRequest.id == party.request_id).first()
    if not req:
        _note_token_miss(request)
        raise HTTPException(404, "Not found")
    return req, party


def _auth_record(party: HrSignParty) -> tuple:
    """What authenticated this party, as stored fact rather than later
    inference. No assurance level is recorded: Nexus proofs nobody's identity,
    so an IAL/AAL here would be a claim no one assessed."""
    if (party.kind or "") == "internal":
        return "entra_sso", ["session"]
    if (party.access_code or "").strip():
        return "emailed_token+access_code", ["token", "access_code"]
    return "emailed_token", ["token"]


def _check_access_code(db: Session, req: HrSignRequest, party: HrSignParty,
                       code: str, request: Request) -> bool:
    """True = unlocked. Wrong attempts are audited and locked out after
    _CODE_LOCKOUT_ATTEMPTS - the code is the second factor on top of the token."""
    expected = (party.access_code or "").strip()
    if not expected:
        return True
    # A NEW code or a rotated token (email change) makes old brute-force attempts
    # moot, so it resets the lockout. A cosmetic fix (name-only) must NOT - it
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
        raise HTTPException(429, "Too many wrong access-code attempts - ask the sender "
                                 "to resend the document with a fresh link.")
    if hmac.compare_digest(expected.encode(), (code or "").strip().encode()):
        return True
    if (code or "").strip():                   # typed something wrong - audit it
        party.failed_auth_count = (party.failed_auth_count or 0) + 1
        ip, ua = _client_meta(request)
        _log(db, req.id, "code_failed", f"{party.name} entered a wrong access code",
             party_id=party.id, ip=ip, user_agent=ua)
        db.commit()
    return False


@router.get("/public/{token}")
def public_render(token: str, request: Request, code: str = "",
                  x_access_code: str = Header(""), db: Session = Depends(get_db)):
    req, party = _party_by_token(db, token, request)
    _check_expiry(db, req)
    code = code or x_access_code   # prefer the header - a query param leaks into logs/history
    if not _check_access_code(db, req, party, code, request):
        # Locked teaser: enough to render the code prompt, nothing signable.
        return {"locked": True, "title": req.title, "requiresCode": True,
                "wrongCode": bool((code or "").strip())}
    # Criterion 9: authentication is stamped BEFORE anything renders. On this
    # path the credential has already been checked above (Nexus session for an
    # internal party, the emailed token plus any access code for an external
    # one) and the payload is built below - so a party whose authenticated_at
    # is empty has, by construction, never been shown the document.
    if not party.authenticated_at:
        party.authenticated_at = _now_iso()
        party.auth_method, party.auth_factors = _auth_record(party)
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
    req, party = _party_by_token(db, token, request)
    if not _check_access_code(db, req, party, body.access_code or "", request):
        raise HTTPException(403, "Wrong access code")
    ip, ua = _client_meta(request)
    return _apply_signature(db, req, party, body, ip, ua)


@router.post("/mine/{party_id}/act")
def my_act(party_id: str, body: ActIn, request: Request,
           user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Approve, or acknowledge delivery - whichever this party's role calls for."""
    party = db.query(HrSignParty).filter(HrSignParty.id == party_id).first()
    if not party or party.email != user["email"].lower():
        raise HTTPException(404, "Not found")
    req = db.query(HrSignRequest).filter(HrSignRequest.id == party.request_id).first()
    ip, ua = _client_meta(request)
    return _apply_act(db, req, party, body, ip, ua)


@router.post("/public/{token}/act")
def public_act(token: str, body: ActIn, request: Request, db: Session = Depends(get_db)):
    req, party = _party_by_token(db, token, request)
    if not _check_access_code(db, req, party, body.access_code or "", request):
        raise HTTPException(403, "Wrong access code")
    ip, ua = _client_meta(request)
    return _apply_act(db, req, party, body, ip, ua)


@router.post("/public/{token}/decline")
def public_decline(token: str, body: DeclineIn, request: Request, db: Session = Depends(get_db)):
    req, party = _party_by_token(db, token, request)
    if not _check_access_code(db, req, party, body.access_code or "", request):
        raise HTTPException(403, "Wrong access code")
    ip, ua = _client_meta(request)
    return _apply_decline(db, req, party, body.reason or "", ip, ua)


@router.get("/public/{token}/download")
def public_download(token: str, request: Request, code: str = "",
                    x_access_code: str = Header(""), db: Session = Depends(get_db)):
    """A party's own copy of the SEALED document - only once completed. Externals
    have no Nexus login; this is how they retain their copy (ESIGN retention)."""
    req, party = _party_by_token(db, token, request)
    code = code or x_access_code   # prefer the header - a query param leaks into logs/history
    if not _check_access_code(db, req, party, code, request):
        raise HTTPException(403, "Wrong access code")
    if req.status != "completed" or not req.final_pdf_path:
        raise HTTPException(409, "This document is not completed yet")
    resp = _storage_signed_url(_DOC_BUCKET, req.final_pdf_path)
    if not resp.is_success:
        raise HTTPException(502, "Could not create download link")
    ip, ua = _client_meta(request)
    _log(db, req.id, "downloaded", f"by {party.name} (public link)", party_id=party.id,
         ip=ip, user_agent=ua)
    db.commit()
    return resp.json()


@router.get("/public/{token}/copy")
def public_copy(token: str, request: Request, code: str = "",
                x_access_code: str = Header(""), db: Session = Depends(get_db)):
    """The signer's own copy of what they are being asked to sign, available
    BEFORE they sign it (UETA section 8 / Cal. Civ. Code 1633.8).

    The retention right is not "you get a copy once everyone has signed" - the
    person deciding whether to sign has to be able to keep and read the terms
    while deciding. For a PDF envelope this is the source document; for an
    authored template it is the frozen body_snapshot rendered to PDF, which is
    exactly the text they are looking at on screen. Nothing here inhibits
    printing or saving, and this endpoint is what the download button calls.
    """
    req, party = _party_by_token(db, token, request)
    code = code or x_access_code
    if not _check_access_code(db, req, party, code, request):
        raise HTTPException(403, "This document is protected by an access code")
    ip, ua = _client_meta(request)
    _log(db, req.id, "copy_retained", f"{party.name} downloaded a copy before signing",
         party_id=party.id, ip=ip, user_agent=ua)
    db.commit()
    if req.status == "completed" and req.final_pdf_path:
        resp = _storage_signed_url(_DOC_BUCKET, req.final_pdf_path)
        if not resp.is_success:
            raise HTTPException(502, "Could not create download link")
        return resp.json()
    if req.source == "template":
        pdf = _build_template_pdf(req, _parties(db, req.id))
        return Response(content=pdf, media_type="application/pdf", headers={
            "Content-Disposition": f'attachment; filename="{_safe_filename(req.title)}.pdf"'})
    resp = _storage_signed_url(_DOC_BUCKET, req.pdf_storage_path)
    if not resp.is_success:
        raise HTTPException(502, "Could not create download link")
    return resp.json()


def _ser_seal(db: Session, request_id: str) -> dict:
    """The applied seal, or an honest statement that there is none."""
    row = (db.query(HrSignSeal).filter(HrSignSeal.request_id == request_id)
           .order_by(HrSignSeal.created_at.desc()).first())
    if row is None or row.status != "applied":
        return {"applied": False,
                "detail": (row.detail if row else "") or "No cryptographic seal was applied."}
    return {"applied": True, "profile": row.profile,
            "algorithm": row.signature_algorithm,
            "certSubject": row.cert_subject, "certIssuer": row.cert_issuer,
            "publiclyTrusted": bool(row.publicly_trusted),
            "keyCustody": row.key_custody,
            "timestampAuthority": row.timestamp_authority or "",
            "sealedSha256": row.sealed_sha256 or ""}


@router.get("/public/verify/{verify_token}")
def public_verify(verify_token: str, request: Request, db: Session = Depends(get_db)):
    """Public, unauthenticated certificate verification - what the QR code on
    the Certificate of Completion links to. Anyone holding a copy of the
    document (an auditor, opposing counsel, the other party) can confirm it's
    unaltered and see the signer timeline WITHOUT a Nexus login - same posture
    as DocuSign/Adobe Sign's own public certificate-ID lookups.

    Discloses NO party identity and no document content - not names, not
    emails, not IP addresses, not the event log. The caller already holds the
    certificate; they are here to COMPARE what it prints against what the
    system stores (digests, chain head, counts), not to fetch data. Anything
    beyond that turns an anti-fraud endpoint into a leak: the token travels on
    a QR code, printed on a document that gets photocopied and filed.

    Full detail stays behind require_hr_read (verify_final above) and the
    certificate sealed into the PDF, which only ever reaches actual parties."""
    req = db.query(HrSignRequest).filter(HrSignRequest.verify_token == verify_token).first()
    if not req or req.status != "completed" or not req.final_pdf_path:
        _note_token_miss(request)   # same guessing throttle as the signing links
        raise HTTPException(404, "Verification record not found")
    # A storage hiccup must not turn a verification lookup into an opaque 502.
    # The caller is checking numbers printed on a certificate; the chain head,
    # the sealed digest and the counts are all in the database and answerable
    # without touching object storage. Report the re-hash as UNKNOWN (null)
    # rather than claiming a pass or a failure we did not actually compute.
    try:
        integrity = _check_final_integrity(req)
    except HTTPException:
        integrity = {"valid": None}
    events = (db.query(HrSignEvent).filter(HrSignEvent.request_id == req.id)
              .order_by(HrSignEvent.seq).all())
    chain = _verify_chain(events)
    signers = [p for p in _parties(db, req.id) if (p.party_role or "signer") == "signer"]
    chain_head = next((e.event_hash for e in sorted(events, key=lambda x: x.seq, reverse=True)
                       if e.event_hash), "")
    # Every verification attempt is itself an event on the envelope: who looked,
    # and when. A verification service that keeps no record of being asked is
    # one more thing nobody can testify about.
    ip, ua = _client_meta(request)
    _log(db, req.id, "verified", "public verification lookup", ip=ip, user_agent=ua)
    db.commit()
    return {
        "envelopeIdShort": req.id[:8],
        "completedAt": req.completed_at,
        "signerCount": len(signers),
        "signedCount": sum(1 for p in signers if p.status == "signed"),
        # The comparison values: what the certificate prints must match these.
        "documentDigest": req.final_sha256 or "",
        # What was ACTUALLY sealed, read off the stored record. A self-signed
        # development seal reports publiclyTrusted false - the endpoint never
        # describes a seal as trusted that a reader would not.
        "seal": _ser_seal(db, req.id),
        "documentIntegrity": {"valid": integrity["valid"]},
        "auditChain": {"valid": chain["valid"], "eventCount": chain["eventCount"],
                       "chainAvailable": chain["chainAvailable"], "head": chain_head},
    }


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
    return "".join(w[0].upper() for w in (name or "").split()[:3]) or "-"


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
            # Default UNCHECKED: a checkbox the signer never affirmatively ticked
            # must never seal as [x] - that would fabricate an acknowledgment on a
            # legal document. The signing UI starts these unchecked too.
            checked = bool((p.field_values or {}).get(f"check:{label}", False))
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
            # The template editor allows in-paragraph line breaks (Enter) and
            # shows them to the author - Paragraph collapses \n, so <br/> them.
            flow.append(Paragraph(_pesc(text).replace("\n", "<br/>"), body_style))
        for m in sig_tokens:
            p = by_role.get(m.group(2))
            if not p:
                continue
            sig = _sig_flowable(p)
            t = Table([[sig], [Paragraph(f"{_pesc(p.name)} - signed {(p.signed_at or '')[:19].replace('T', ' ')} UTC",
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
        # viewers, so the field coords were placed against the VISUAL size - but
        # merge_page ignores /Rotate and works in mediabox space. Bake the
        # rotation into the content first so mediabox == what the placer saw.
        if getattr(page, "rotation", 0):
            try:
                page.transfer_rotation_to_content()
            except Exception:
                pass
        pw, ph = float(page.mediabox.width), float(page.mediabox.height)

        def _pg(f):
            try:
                return int(f.get("page") or 0)
            except (TypeError, ValueError):
                return 0
        page_fields = [f for f in (fields or []) if isinstance(f, dict) and _pg(f) == idx]
        if page_fields:
            obuf = io.BytesIO()
            c = rl_canvas.Canvas(obuf, pagesize=(pw, ph))
            for f in page_fields:
              # One malformed field (legacy template data predating _clean_fields)
              # must never sink sealing - a _finalize crash bricks the envelope.
              try:
                p = by_role.get(f.get("role", ""))
                if not p:
                    continue
                # normalized coords: x/y from top-left, w/h fractions of the page
                x, w = float(f.get("x") or 0) * pw, max(0.02, float(f.get("w") or 0.2)) * pw
                h = max(0.015, float(f.get("h") or 0.05)) * ph
                y = ph - float(f.get("y") or 0) * ph - h
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
                elif ftype == "name":
                    c.setFont("Helvetica", min(10, h * 0.6))
                    c.drawString(x, y + h * 0.25, p.name or "")
                elif ftype == "radio":
                    # The chosen option only counts if it's still in the frozen list
                    opts = [str(o) for o in (f.get("options") or [])]
                    val = str((p.field_values or {}).get(f.get("id", ""), ""))
                    if val not in opts:
                        val = ""
                    n = max(1, len(opts))
                    rh = h / n
                    fs = min(9, rh * 0.55)
                    c.setFont("Helvetica", fs)
                    for oi, opt in enumerate(opts):
                        cy = y + h - (oi + 0.5) * rh
                        r = min(3.2, rh * 0.3)
                        c.circle(x + r + 1, cy, r, stroke=1, fill=0)
                        if opt == val:
                            c.circle(x + r + 1, cy, r * 0.5, stroke=0, fill=1)
                        c.drawString(x + r * 2 + 5, cy - fs * 0.35, opt)
                elif ftype in ("text", "check", "dropdown"):
                    val = (p.field_values or {}).get(f.get("id", ""), "")
                    if ftype == "check":
                        val = "[x]" if val else "[ ]"
                    elif ftype == "dropdown" and str(val) not in [str(o) for o in (f.get("options") or [])]:
                        val = ""
                    c.setFont("Helvetica", min(10, h * 0.6))
                    c.drawString(x, y + h * 0.25, str(val))
              except Exception:
                continue
            c.save()
            obuf.seek(0)
            page.merge_page(PdfReader(obuf).pages[0])
        writer.add_page(page)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


_OS_PATTERNS = [   # order matters - see the iPhone note below
    ("Windows NT 10.0", "Windows 10/11"), ("Windows NT 11", "Windows 11"),
    # iOS/iPadOS agents say "like Mac OS X", so they MUST be matched before
    # the desktop token or every iPhone signature is certified as a Mac.
    ("iPhone", "iOS"), ("iPad", "iPadOS"), ("Android", "Android"),
    ("Mac OS X", "macOS"), ("CrOS", "ChromeOS"), ("Linux", "Linux"),
]
_BROWSER_PATTERNS = [   # order matters - Edge/Chrome both say "Chrome"
    ("Edg/", "Edge"), ("OPR/", "Opera"), ("Chrome/", "Chrome"),
    ("Firefox/", "Firefox"), ("Safari/", "Safari"),
]


def _ua_summary(ua: str) -> str:
    """'Windows 10/11 - Chrome' from a User-Agent string. Best effort and
    deliberately coarse: the raw UA is preserved verbatim in the event log, so
    this is only the human-readable gloss on the certificate. Never guesses -
    an unrecognized agent is reported as such rather than mislabeled."""
    ua = (ua or "").strip()
    if not ua:
        return ""
    os_name = next((label for token, label in _OS_PATTERNS if token in ua), "")
    browser = next((label for token, label in _BROWSER_PATTERNS if token in ua), "")
    if os_name and browser:
        return f"{os_name} - {browser}"
    return os_name or browser or "Unrecognized user agent"


def _auth_method(party: HrSignParty) -> str:
    """How this signer proved who they were - stated as what the system
    ACTUALLY did, with no assurance-level claim attached. Nexus does not run
    an identity-proofing process, so nothing here may be described in NIST
    SP 800-63 IAL/AAL terms; that would assert a level nobody assessed."""
    if party.kind == "internal":
        return ("Microsoft Entra ID single sign-on. Signed from an authenticated "
                "Nexus session bound to this work account.")
    base = ("Single-use link sent to the signer's email address, carrying a "
            "43-character random token (secrets.token_urlsafe(32)). Possession "
            "of the emailed link is the credential.")
    if (party.access_code or "").strip():
        base += " An additional access code, shared with the signer out of band, was required to open it."
    return base


def _signature_binding(req: HrSignRequest, party: HrSignParty) -> str:
    """Which field the signature landed in, and a digest of the signature
    itself, so the mark on the page can be tied back to this record."""
    from xml.sax.saxutils import escape
    kinds = {"drawn": "Drawn on canvas", "typed": "Typed"}
    label = kinds.get(party.signature_kind or "", party.signature_kind or "Not signed")
    fields = list(req.fields or [])
    for d in (req.documents or []):
        fields.extend(d.get("fields") or [])
    mine = [f for f in fields
            if isinstance(f, dict) and f.get("type") in ("sign", "initials")
            and (f.get("role") or "") == (party.role_key or "")]
    where = ""
    if mine:
        ids = ", ".join(str(f.get("id") or "-") for f in mine[:3])
        pages = sorted({int(f.get("page") or 0) + 1 for f in mine})
        where = (f"<br/>Field {escape(ids)} - "
                 f"p. {', '.join(str(n) for n in pages[:4])}")
    digest = ""
    if party.signature_data:
        digest = ("<br/><font face='Courier' size='6.5'>"
                  f"{hashlib.sha256(party.signature_data.encode()).hexdigest()[:32]}</font>")
    return f"{label}{where}{digest}"


def _document_digests_from_rows(db: Session, req: HrSignRequest, parts: list) -> list:
    """[(name, pages, digest_as_sent, digest_at_completion)] for the certificate.

    The completion digest is computed now, from the stamped bytes. The SEND
    digest is READ BACK from the row frozen at send - not recomputed - so a
    source file swapped after the envelope went out shows two different digests
    instead of two matching ones. Rows are matched by ordinal, which is the
    order the packet was assembled in at both ends.
    """
    from pypdf import PdfReader
    rows = (db.query(HrSignDocument).filter(HrSignDocument.request_id == req.id)
            .order_by(HrSignDocument.ordinal).all())
    by_ordinal = {r.ordinal: r for r in rows}
    out = []
    for i, (name, source_bytes, stamped_bytes) in enumerate(parts, 1):
        try:
            pages = len(PdfReader(io.BytesIO(stamped_bytes)).pages)
        except Exception:   # noqa: BLE001 - a page count must never break sealing
            pages = 0
        done = hashlib.sha256(stamped_bytes).hexdigest()
        row = by_ordinal.get(i)
        if row is not None:
            row.page_count = pages
            row.digest_at_completion = done
            sent = row.digest_at_send
        else:
            # Envelope sent before packet rows existed: fall back to hashing the
            # source we still hold, and say so by leaving it blank if there is
            # none, rather than presenting the completion digest as both.
            sent = hashlib.sha256(source_bytes).hexdigest() if source_bytes else ""
        out.append((name, pages, sent, done))
    return out


def _document_digests(req: HrSignRequest, parts: list) -> list:
    """[(name, pages, digest_as_sent, digest_at_completion)] for the packet.

    Both digests are computed at finalize from bytes we still hold: the source
    file as it was uploaded/attached, and the same file after this envelope's
    field values were stamped into it. An exhibit nobody signed therefore shows
    two IDENTICAL digests - which is exactly the useful claim: it went out and
    came back unaltered.
    """
    from pypdf import PdfReader
    out = []
    for name, source_bytes, stamped_bytes in parts:
        try:
            pages = len(PdfReader(io.BytesIO(stamped_bytes)).pages)
        except Exception:   # noqa: BLE001 - a page count must never break sealing
            pages = 0
        out.append((
            name, pages,
            hashlib.sha256(source_bytes).hexdigest() if source_bytes else "",
            hashlib.sha256(stamped_bytes).hexdigest(),
        ))
    return out

_LAW_NAMES = {"CA": "California", "TX": "Texas", "NV": "Nevada", "AZ": "Arizona",
              "WA": "Washington", "OR": "Oregon", "NY": "New York", "FL": "Florida"}

_FORMAT_LABELS = {
    "pdf_rendered_in_session": "PDF rendered in the signing session",
    "html_rendered_in_session": "Document rendered in the signing session",
}


def _api_base() -> str:
    """This API's own public origin (NOT the frontend origin _app_url_fn
    returns) - the signing page fetches the retention copy straight from
    the API, the same base the page was served its payload from."""
    return os.getenv("NEXUS_API_URL", "").rstrip("/")


def _safe_filename(title: str) -> str:
    """A filename a browser will accept, from a document title."""
    cleaned = re.sub(r"[^A-Za-z0-9 _.-]", "", (title or "document")).strip()
    return (cleaned or "document")[:80]


def _wrap_hash(digest: str, width: int = 32) -> str:
    """Break a hex digest so it wraps inside a narrow table cell instead of
    overflowing it (Courier at 6.8pt fits ~32 chars in the digest columns)."""
    d = (digest or "").strip()
    return "<br/>".join(d[i:i + width] for i in range(0, len(d), width))


def _certificate_qr_flowable(verify_url: str):
    """QR image linking to the public, unauthenticated /verify/{token} page -
    generated in-memory (never touches disk), same idiom as every other
    generated-bytes helper in this codebase. Returns None (caller skips the QR
    block entirely) when there's no verify_token yet, which should not happen
    in practice since _finalize() always sets one before calling
    _certificate_pdf(), but this stays defensive rather than crashing
    certificate generation over a missing QR."""
    if not verify_url:
        return None
    # Genuinely defensive, as the docstring says: a QR is a convenience, and
    # nothing about it is worth failing a completion over. Anything that goes
    # wrong here (missing wheel, encoder error) drops the QR - the verification
    # URL is printed as text on the certificate either way.
    try:
        import qrcode
        from reportlab.platypus import Image as RLImage
        from reportlab.lib.units import mm
        img = qrcode.make(verify_url)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        return RLImage(buf, width=22 * mm, height=22 * mm)
    except Exception as e:  # noqa: BLE001 - never block sealing on the QR
        print(f"[esign] certificate QR skipped: {type(e).__name__}: {e}")
        return None


def _certificate_pdf(snapshot: dict) -> bytes:
    """The sealed packet's copy of the Certificate of Completion.

    Renders THE SAME SNAPSHOT the HTML certificate of record is rendered from
    (services/certificate.py). Two presentations, one set of facts - a PDF that
    derived its own values would eventually disagree with the HTML about
    something, and a certificate that contradicts itself is worse than no
    certificate.

    Every cell is a Paragraph so long values wrap instead of clipping; column
    widths sum to the printable width (LETTER 216mm - 2x17mm margins = 182mm).
    """
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                     TableStyle, HRFlowable, KeepTogether)
    from reportlab.lib import colors
    from xml.sax.saxutils import escape

    env, sysd, integ = snapshot["envelope"], snapshot["system"], snapshot["integrity"]
    signers, docs = snapshot["signers"], snapshot["documents"]

    INK, MUTED, LINE, MIST, PINE = (colors.HexColor(c) for c in
                                    ("#111827", "#6b7280", "#e5e7eb", "#f6f7f9", "#166534"))
    styles = getSampleStyleSheet()
    title = ParagraphStyle("t", parent=styles["Title"], fontSize=19, spaceAfter=1, textColor=INK)
    sub = ParagraphStyle("sb", parent=styles["Normal"], fontSize=8.5, leading=12, textColor=MUTED)
    h = ParagraphStyle("h", parent=styles["Heading2"], fontSize=11, spaceBefore=11,
                       spaceAfter=3, textColor=INK)
    small = ParagraphStyle("s", parent=styles["Normal"], fontSize=8.5, leading=12, textColor=INK)
    tiny = ParagraphStyle("y", parent=styles["Normal"], fontSize=7, leading=9.5, textColor=MUTED)
    cell = ParagraphStyle("c", parent=styles["Normal"], fontSize=7.5, leading=9.5, textColor=INK)
    cellm = ParagraphStyle("cm", parent=cell, textColor=MUTED)
    head = ParagraphStyle("hd", parent=styles["Normal"], fontSize=7.5, leading=9,
                          fontName="Helvetica-Bold", textColor=INK)

    def ts(v):
        v = (v or "").strip()
        return escape(v[:19].replace("T", "  ")) + " UTC" if v else "-"

    P, PM, PH = (lambda s: Paragraph(s, cell)), (lambda s: Paragraph(s, cellm)), (lambda s: Paragraph(s, head))

    def grid():
        return TableStyle([
            ("GRID", (0, 0), (-1, -1), 0.4, LINE),
            ("BACKGROUND", (0, 0), (-1, 0), MIST),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#fbfcfd")]),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 3.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
            ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ])

    def facts(rows, label_w=32 * mm, value_w=59 * mm):
        t = Table([[PM(k), P(v)] for k, v in rows], colWidths=[label_w, value_w])
        t.setStyle(TableStyle([
            ("GRID", (0, 0), (-1, -1), 0.4, LINE),
            ("BACKGROUND", (0, 0), (0, -1), MIST),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ]))
        return t

    signed = [s for s in signers if s["status"] == "signed"]
    signing_parties = [s for s in signers if s.get("signs", True)]
    declined = [s for s in signers if s["status"] == "declined"]
    chain_state = ("Verified" if integ["chain_valid"] else
                   "BROKEN" if integ["chain_valid"] is False else "Not available")

    ident = [Paragraph(f"<b>{escape(sysd['name'])}</b>", ParagraphStyle(
                 "sor", parent=styles["Normal"], fontSize=13, leading=16, textColor=INK)),
             Paragraph("Electronic signature system of record", sub),
             Paragraph(f"Operated by {escape(sysd['operator'])}", sub)]
    qr_flowable = _certificate_qr_flowable(snapshot["verify_url"])
    band = Table([[ident, qr_flowable if qr_flowable is not None else ""]],
                 colWidths=[140 * mm, 42 * mm])
    band.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.6, LINE), ("VALIGN", (0, 0), (0, 0), "TOP"),
        ("VALIGN", (1, 0), (1, 0), "MIDDLE"), ("ALIGN", (1, 0), (1, 0), "RIGHT"),
        ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 9), ("RIGHTPADDING", (0, 0), (-1, -1), 9),
    ]))

    flow = [band, Spacer(1, 5 * mm),
            Paragraph("Certificate of Completion", title),
            Paragraph(f"Envelope {escape(env['id'])} &middot; {escape(env['short_code'])}", tiny),
            Spacer(1, 2 * mm), HRFlowable(width="100%", thickness=1.1, color=INK), Spacer(1, 3 * mm)]

    strip = Table([[PH("Status"), PH("Signatures"), PH("Declined"), PH("Integrity"),
                    PH("Governing law"), PH("Issued")],
                   [P(f"<b>{escape(env['status'] or '-')}</b>"),
                    P(f"{len(signed)} of {len(signing_parties)}"),
                    P(str(len(declined)) if declined else "None"),
                    P(escape(chain_state)),
                    P(escape(env["governing_law_label"] or "-")),
                    P(escape((env["completed_at"] or "")[:10] or "-"))]],
                  colWidths=[30 * mm, 26 * mm, 24 * mm, 40 * mm, 32 * mm, 30 * mm])
    strip.setStyle(grid())
    flow.append(strip)

    flow.append(Paragraph("1&nbsp;&nbsp;Envelope", h))
    left = [("Name", escape(env["name"] or "-")),
            ("Sending entity", escape(env["entity"] or "-")),
            ("Document type", escape(env.get("document_class_label") or env["document_class"] or "Not classified")),
            ("Initiated by", escape(env["initiated_by"] or "-"))]
    right = [("Routing", f"{escape(env['routing'])} - {len(signers)} signer(s)"),
             ("Sent", ts(env["sent_at"])),
             ("Completed", ts(env["completed_at"])),
             ("Eligibility", (f"Confirmed by {escape(env['eligibility_by'])}<br/>{ts(env['eligibility_at'])}"
                              if env["eligibility_at"] else "Not recorded"))]
    pair = Table([[facts(left), facts(right)]], colWidths=[91 * mm, 91 * mm])
    pair.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"),
                              ("LEFTPADDING", (0, 0), (0, 0), 0),
                              ("RIGHTPADDING", (-1, 0), (-1, 0), 0)]))
    flow.append(pair)

    flow.append(Paragraph("2&nbsp;&nbsp;Signers, authentication and consent", h))
    flow.append(Paragraph("Attribution evidence under UETA &sect; 9 and 15 U.S.C. &sect; 7001(c). "
                          "Times are UTC as recorded by the application clock.", tiny))
    rows = [[PH("Signer"), PH("Authentication"), PH("Consent to transact"),
             PH("Executed"), PH("Signature")]]
    for s in signers:
        capacity = " - ".join(x for x in (s.get("title"), s.get("org")) if x)
        who = (f"<b>{escape(s['name'] or '-')}</b>"
               + (f"<br/><font color='#6b7280'>{escape(capacity)}</font>" if capacity else "")
               + f"<br/>{escape(s['email'])}"
                 f"<br/><font color='#6b7280'>{escape(s.get('role_label', 'Signer'))}"
                 f" - {escape(s['kind'].title())} - order {s['ordinal']}</font>")
        c = s["consent"]
        if c["accepted_at"]:
            pv, pt = s.get("pages_viewed", 0), s.get("pages_total", 0)
            pages = (f"all {pt} pages viewed" if pt and pv >= pt
                     else f"{pv} of {pt} pages viewed" if pt else "")
            extra = " - ".join(x for x in (c["format"], pages, c["standing_basis"]) if x)
            lines = [f"v{escape(c['version'] or '-')} accepted {ts(c['accepted_at'])}"]
            if c["digest"]:
                lines.append(f"<font face='Courier' size='6'>{escape(c['digest'][:32])}</font>")
            if extra:
                lines.append(f"<font color='#6b7280'>{escape(extra)}</font>")
            lines.append("<font color='#6b7280'>"
                         + (f"Withdrawn {ts(c['withdrawn_at'])}" if c["withdrawn_at"]
                            else "No withdrawal recorded") + "</font>")
            consent_cell = "<br/>".join(lines)
        else:
            consent_cell = "<font color='#6b7280'>No consent recorded</font>"
        if s["status"] == "declined":
            executed = (f"<b>Declined</b><br/>{ts(s['executed_at'])}"
                        f"<br/><font color='#6b7280'>{escape(s['decline_reason'])}</font>")
        else:
            executed = (f"{ts(s['executed_at'])}<br/>{escape(s['ip'] or 'IP not recorded')}"
                        f"<br/><font color='#6b7280'>{escape(s['client'])}</font>")
        if not s.get("signs", True):
            sig = ("<font color='#6b7280'>Approved - no signature</font>"
                   if s.get("role") == "approver"
                   else "<font color='#6b7280'>Receipt acknowledged - no signature</font>")
        else:
            sig = escape((s["signature_kind"] or "-").title())
            if s.get("signature_field"):
                sig += f"<br/><font color='#6b7280'>{escape(s['signature_field'])}</font>"
            if s["signature_digest"]:
                sig += f"<br/><font face='Courier' size='6'>{escape(s['signature_digest'][:32])}</font>"
        auth = escape(s["auth_method"])
        if s.get("failed_auth_count"):
            n = s["failed_auth_count"]
            auth += (f"<br/><font color='#6b7280'>{n} failed access-code "
                     f"attempt{'s' if n != 1 else ''}</font>")
        else:
            auth += "<br/><font color='#6b7280'>No failed attempts</font>"
        rows.append([P(who), P(auth), P(consent_cell), P(executed), P(sig)])
    t = Table(rows, colWidths=[42 * mm, 42 * mm, 34 * mm, 34 * mm, 30 * mm], repeatRows=1)
    t.setStyle(grid())
    flow.append(t)
    if snapshot["ccs"]:
        flow.append(Paragraph("Copies to: " + escape(", ".join(
            f"{c['name']} ({c['email']})" for c in snapshot["ccs"])), tiny))

    if docs:
        flow.append(Paragraph("3&nbsp;&nbsp;Documents and digests", h))
        flow.append(Paragraph("SHA-256 of each file as it was sent, and of the same file with this "
                              "envelope's field values stamped in. Identical digests mean the file "
                              "came back byte-for-byte unaltered.", tiny))
        drows = [[PH("Document"), PH("Pages"), PH("Digest at send"), PH("Digest at completion")]]
        for d in docs:
            drows.append([P(escape(d["name"])), PM(str(d["pages"] or "-")),
                          Paragraph(_wrap_hash(d["digest_at_send"]) or "-",
                                    ParagraphStyle("m1", parent=cell, fontName="Courier",
                                                   fontSize=6.8, leading=8.5)),
                          Paragraph(_wrap_hash(d["digest_at_completion"]) or "-",
                                    ParagraphStyle("m2", parent=cell, fontName="Courier",
                                                   fontSize=6.8, leading=8.5))])
        dt = Table(drows, colWidths=[52 * mm, 14 * mm, 58 * mm, 58 * mm], repeatRows=1)
        dt.setStyle(grid())
        flow.append(dt)

    flow.append(Paragraph("4&nbsp;&nbsp;Integrity, audit chain and retention", h))
    chain_note = {
        True: "Each entry commits to every entry before it, so inserting, editing, deleting or "
              "reordering an entry is detectable. Replayed at generation: verified.",
        False: "REPLAY FAILED - the stored entries do not match their hash chain. Treat this "
               "record as suspect and investigate before relying on it.",
        None: "This envelope predates the hash-chained log, so the chain cannot be replayed. "
              "Its entries are still append-only in the database.",
    }[integ["chain_valid"]]
    flow.append(facts([
        ("Composite digest", f"<font face='Courier' size='6.8'>{_wrap_hash(integ['content_digest'])}</font>"
                             "<br/>SHA-256 of the signed pages this certificate is appended to."),
        ("Audit chain head", (f"<font face='Courier' size='6.8'>{_wrap_hash(integ['chain_head'])}</font>"
                              if integ["chain_head"] else "Not available")),
        ("Audit log", f"{integ['event_count']} entries, append-only - update and delete privileges "
                      f"withheld at the database level. {escape(chain_note)}"),
        ("Timestamps", "Recorded by the Nexus application clock in UTC at the moment of each act. "
                       "Not a third-party RFC 3161 timestamp."),
        ("Sealing", escape(snapshot.get("seal_policy") or "")),
        ("Retention", escape(snapshot["retention"] or "-")
                      + " Every party may retrieve the completed record from the verification "
                        "link for as long as it is retained (15 U.S.C. &sect; 7001(d))."),
    ], label_w=38 * mm, value_w=144 * mm))

    custodian = (
        "The record described above was generated by an electronic process and system that "
        "produces an accurate result. Each entry was recorded by the system at or near the time "
        "of the act, in the course of regularly conducted business activity, and it is the "
        "regular practice of that activity to make such records. Each document was hashed with "
        "SHA-256 on receipt; each audit entry was appended to a hash-linked, append-only store "
        "from which update and delete privileges are withheld at the database level; each signer "
        "was authenticated by the method stated in section 2 before any document was displayed; "
        "and each signature was bound to the identified field and to that authenticated session. "
        "The digests stated in sections 3 and 4 match those computed from the record as archived.")
    sig_rows = [[P("<br/><br/>"), P("<br/><br/>"), P("<br/><br/>")],
                [PM("Name and title of custodian"), PM("Signature"), PM("Date and place of execution")]]
    sig = Table(sig_rows, colWidths=[70 * mm, 56 * mm, 56 * mm])
    sig.setStyle(TableStyle([
        ("LINEBELOW", (0, 0), (-1, 0), 0.5, INK), ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
        ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ]))
    law_clause = (f", and of the State of {escape(env['governing_law_label'])}"
                  if env["governing_law_label"] else "")
    flow.append(KeepTogether([
        Paragraph("5&nbsp;&nbsp;Certification of records custodian", h),
        Paragraph("To be completed by the custodian when this record is offered. "
                  "Fed. R. Evid. 902(11), (13), (14) and 803(6).", tiny),
        Spacer(1, 2 * mm),
        Paragraph(f"I certify that I am the custodian of records for {escape(sysd['name'])}, the "
                  f"electronic signature system of record operated by {escape(sysd['operator'])} - or "
                  "another qualified person able to make this certification - and that the "
                  "following is true:", small),
        Spacer(1, 1.5 * mm), Paragraph(custodian, small), Spacer(1, 1.5 * mm),
        Paragraph("I declare under penalty of perjury under the laws of the United States of "
                  f"America{law_clause}, that the foregoing is true and correct.", small),
        Spacer(1, 8 * mm), sig]))

    flow.append(Spacer(1, 4 * mm))
    flow.append(HRFlowable(width="100%", thickness=0.6, color=LINE))
    flow.append(Paragraph(
        f"<b>Verification.</b> Scan the code above, or open "
        f"<font face='Courier' size='7'>{escape(snapshot['verify_url'])}</font>, to compare the "
        "digests and counts printed here against the stored record. Verification requires no "
        "account and discloses no signer identity or document content.", tiny))
    flow.append(Paragraph(
        "<b>Authority.</b> Issued under the Electronic Signatures in Global and National Commerce "
        "Act, 15 U.S.C. &sect;&sect; 7001-7031, and the Uniform Electronic Transactions Act as "
        f"enacted in {escape(env['governing_law_label'] or 'the governing state')}. An electronic "
        "signature may be attributed to a person if it was the act of that person, which may be "
        "shown in any manner, including by the efficacy of the security procedure described here. "
        "An electronic record may not be denied admissibility solely because it is in electronic "
        "form. This certificate is not legal advice and is not itself the agreement between the "
        f"parties. Generated {escape((snapshot['generated_at'] or '')[:19].replace('T', ' '))} UTC.",
        tiny))

    def _page_furniture(canvas, doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 6.5)
        canvas.setFillColor(MUTED)
        canvas.drawString(17 * mm, 9 * mm, f"{sysd['name']} - Certificate of Completion")
        canvas.drawCentredString(108 * mm, 9 * mm, f"Envelope {env['id']}")
        canvas.drawRightString(199 * mm, 9 * mm, f"Page {canvas.getPageNumber()}")
        canvas.restoreState()

    buf = io.BytesIO()
    SimpleDocTemplate(buf, pagesize=LETTER, topMargin=16 * mm, bottomMargin=16 * mm,
                      leftMargin=17 * mm, rightMargin=17 * mm,
                      title=f"Certificate of Completion - {env['name']}",
                      author=sysd["operator"], subject=f"Envelope {env['id']}").build(
        flow, onFirstPage=_page_furniture, onLaterPages=_page_furniture)
    return buf.getvalue()


def _egnyte_push(req: HrSignRequest, blob: bytes) -> tuple:
    """Copy the sealed PDF into the request's Egnyte folder (like Egnyte Sign's
    'Signed document location'). Best-effort and env-gated: needs EGNYTE_DOMAIN
    (e.g. greensglobal.egnyte.com) + EGNYTE_TOKEN on the app service. Returns
    (ok, note) for the audit log; note '' = not configured / no folder.
    NOTE: runs inside the sealing transaction (like the completion emails), so
    the timeout stays short - a slow Egnyte must not hold the envelope lock."""
    import os as _os
    from urllib.parse import quote as _q
    dom = (_os.getenv("EGNYTE_DOMAIN") or "").strip().rstrip("/")
    tok = (_os.getenv("EGNYTE_TOKEN") or "").strip()
    # The folder is client-supplied config - strip empty/'.'/'..' segments so it
    # can't traverse outside the intended tree with the service-wide token.
    folder = "/".join(s.strip() for s in (req.egnyte_folder or "").split("/")
                      if s.strip() and s.strip() not in (".", ".."))[:400]
    if not (dom and tok and folder):
        return True, ""
    if "." not in dom:
        dom = f"{dom}.egnyte.com"
    safe_title = re.sub(r'[\\/:*?"<>|]+', " ", req.title or "Document").strip()[:80] or "Document"
    path = f"{folder}/{safe_title} - {req.id[:8]} (signed).pdf"
    try:
        r = httpx.post(f"https://{dom}/pubapi/v1/fs-content/{_q(path)}",
                       headers={"Authorization": f"Bearer {tok}",
                                "Content-Type": "application/pdf"},
                       content=blob, timeout=20)
        if r.is_success:
            return True, f"copied to Egnyte /{path}"
        return False, f"Egnyte copy failed ({r.status_code})"
    except Exception as e:  # a broken Egnyte copy must never block sealing
        return False, f"Egnyte copy failed ({type(e).__name__})"


def _finalize(db: Session, req: HrSignRequest) -> None:
    """All parties signed: render content, append certificate, hash, store, notify."""
    from pypdf import PdfReader, PdfWriter
    req.completed_at = _now_iso()
    parties = _parties(db, req.id)

    def fetch(path):
        src = _storage_fetch(_DOC_BUCKET, path)
        if not src.is_success:
            raise HTTPException(502, f"Could not fetch {path} to finalize")
        return src.content

    # Content = the authored letter (or uploaded PDF) + every packet document,
    # each stamped with its own fields, merged in order into ONE sealed PDF.
    parts = []
    packet = []          # (display name, bytes as sent, bytes as sealed)
    if req.source == "template":
        built = _build_template_pdf(req, parties)
        parts.append(built)
        # An authored template has no "as sent" file - it is rendered from the
        # frozen body_snapshot at completion, so only one digest is meaningful.
        packet.append((f"{req.title} (authored)", b"", built))
    else:
        source = fetch(req.pdf_storage_path)
        stamped = _stamp_pdf(source, req.fields or [], parties)
        parts.append(stamped)
        packet.append((req.pdf_storage_path.rsplit("/", 1)[-1] or req.title, source, stamped))
    for d in (req.documents or []):
        source = fetch(d.get("path", ""))
        stamped = _stamp_pdf(source, d.get("fields") or [], parties)
        parts.append(stamped)
        packet.append((d.get("name") or d.get("path", "").rsplit("/", 1)[-1], source, stamped))
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
    # Flush first: the caller (_apply_signature) just _log()'d the final signer's
    # 'consented' + 'signed' events but hasn't committed. autoflush=False means
    # this query wouldn't see them, so the certificate's audit trail would omit
    # the very signature that triggered completion.
    db.flush()
    events = (db.query(HrSignEvent).filter(HrSignEvent.request_id == req.id)
              .order_by(HrSignEvent.seq).all())
    if not req.verify_token:
        req.verify_token = secrets.token_urlsafe(24)
    entity_name = ""
    if req.entity_id:
        ent = db.query(HrEntity).filter(HrEntity.id == req.entity_id).first()
        entity_name = (ent.name if ent else "") or ""
    consent_rows = {c.party_id: c for c in
                    db.query(HrSignConsent).filter(HrSignConsent.request_id == req.id).all()}
    class_label = ""
    if req.document_class:
        cls = db.query(HrDocumentClass).filter(
            HrDocumentClass.code == req.document_class).first()
        class_label = cls.label if cls else ""
    # ONE snapshot, rendered twice. The HTML is the certificate of record
    # (deterministic - regenerating it from this snapshot reproduces it byte for
    # byte); the PDF is the copy sealed into the packet. Both read the same
    # frozen dict, so they can never state different facts.
    snapshot = build_certificate_snapshot(
        req=req, parties=parties, events=events, consents=consent_rows,
        doc_digests=_document_digests_from_rows(db, req, packet), content_sha=content_sha,
        entity_name=entity_name, generated_at=req.completed_at,
        system={"name": _SOR_NAME, "operator": _SOR_OPERATOR, "support": _SUPPORT_CONTACT,
                "seal_policy": seal_policy_sentence(),
                "verify_url": f"{_app_url_fn()}/verify/{req.verify_token}",
                "retention": _RETENTION_POLICY},
        chain=_verify_chain(events))
    snapshot["envelope"]["document_class_label"] = class_label
    req.certificate_snapshot = snapshot
    req.certificate_html = render_certificate_html(snapshot)
    req.certificate_sha256 = hashlib.sha256(req.certificate_html.encode("utf-8")).hexdigest()
    cert = _certificate_pdf(snapshot)

    # Merge content + certificate into the sealed final document
    writer = PdfWriter()
    for page in PdfReader(io.BytesIO(content)).pages:
        writer.add_page(page)
    for page in PdfReader(io.BytesIO(cert)).pages:
        writer.add_page(page)
    out = io.BytesIO()
    writer.write(out)
    final = out.getvalue()

    # Seal LAST, over content + certificate, by incremental update. A seal
    # failure never loses the document: seal_pdf returns the unsealed bytes and
    # a record saying what happened, and that record is stored either way -
    # silence about a seal that did not apply is the thing to avoid.
    final, seal_record = seal_pdf(final, field_name="NexusSeal",
                                  reason=f"Certified complete - envelope {req.id}")
    db.add(HrSignSeal(id=str(uuid.uuid4()), request_id=req.id,
                      status=seal_record.get("status", "skipped"),
                      detail=seal_record.get("detail", "")[:500],
                      profile=seal_record.get("profile", ""),
                      signature_algorithm=seal_record.get("signature_algorithm", ""),
                      cert_subject=seal_record.get("cert_subject", "")[:500],
                      cert_issuer=seal_record.get("cert_issuer", "")[:500],
                      cert_serial=seal_record.get("cert_serial", ""),
                      cert_not_after=seal_record.get("cert_not_after", ""),
                      publicly_trusted=bool(seal_record.get("publicly_trusted", False)),
                      key_custody=seal_record.get("key_custody", ""),
                      timestamp_authority=seal_record.get("timestamp_authority", ""),
                      timestamped_at=seal_record.get("timestamped_at", ""),
                      sealed_sha256=seal_record.get("sealed_sha256", ""),
                      created_at=seal_record.get("created_at", "")))
    if seal_record.get("status") == "applied":
        _log(db, req.id, "sealed",
             f"{seal_record.get('profile', 'seal')} - {seal_record.get('cert_subject', '')[:120]}")
    elif seal_record.get("status") == "failed":
        _log(db, req.id, "seal_failed", seal_record.get("detail", "")[:300])

    path = f"esign/{req.id}/final.pdf"
    up = _storage_put(_DOC_BUCKET, path, final, "application/pdf", upsert=True)
    if not up.is_success:
        raise HTTPException(502, f"Could not store the final document: {up.text[:200]}")
    req.final_pdf_path = path
    req.final_sha256 = hashlib.sha256(final).hexdigest()
    req.status = "completed"
    _log(db, req.id, "completed", f"sealed · sha256 {req.final_sha256[:16]}…")
    egnyte_ok, egnyte_note = _egnyte_push(req, final)
    if egnyte_note:  # 'archived' only when the copy actually landed
        _log(db, req.id, "archived" if egnyte_ok else "archive_failed", egnyte_note)

    # Attach to the subject employee's profile Documents tab
    if req.employee_id:
        db.add(HrDocument(id=str(uuid.uuid4()), employee_id=req.employee_id, kind="contract",
                          file_name=f"{req.title}.pdf", storage_path=path,
                          size_bytes=len(final), uploaded_by="e-sign",
                          created_at=req.completed_at))

    # Completion fan-out: bell notification for the sender and every internal
    # party, and an EMAIL WITH THE SEALED PDF ATTACHED for everyone involved -
    # sender, signers and CC, internal or external (link fallback when the
    # document is too big to attach). Best-effort and audited per recipient.
    n_signers = sum(1 for p in parties if (p.party_role or "signer") == "signer")
    _hr_notify(db, req.created_by, f"Completed: {req.title}",
               f"All {n_signers} signer{'s' if n_signers != 1 else ''} have signed \"{req.title}\". "
               f"The sealed document is in Documents → E-Sign and in your email.", ref_id=req.id,
               action={"view": "documents", "sub": "documents-esign-requests"})
    emailed = set()

    def _mail_copy(name, email, link, label, party_id=""):
        key = (email or "").strip().lower()
        if not key or key in emailed:
            return
        emailed.add(key)
        ok, detail = _send_sealed_email(name, email, req, final, link, label)
        _log(db, req.id, "sent", f"sealed copy emailed to {name or email}"
             + ("" if ok else f" - email failed: {detail}"), party_id=party_id)

    sender_name = req.created_by.split("@")[0].replace(".", " ").title()
    _mail_copy(sender_name, req.created_by, f"{_app_url_fn()}/documents/documents-esign", "Open in Nexus")
    for p in parties:
        if p.kind == "internal":
            if p.email != req.created_by:
                _hr_notify(db, p.email, f"Fully signed: {req.title}",
                           "Everyone has signed. The sealed copy is in Documents → E-Sign and in your email.",
                           ref_id=req.id,
                           action={"view": "documents", "sub": "documents-esign"})
            _mail_copy(p.name, p.email, f"{_app_url_fn()}/documents/documents-esign", "Open in Nexus", party_id=p.id)
        else:
            # Externals have no Nexus login - their unique link also serves the
            # sealed copy (public download).
            _mail_copy(p.name, p.email, f"{_app_url_fn()}/sign/{p.token}", "View & download", party_id=p.id)
