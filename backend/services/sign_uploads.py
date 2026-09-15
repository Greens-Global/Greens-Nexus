"""Nexus Sign upload fields - files a SIGNER attaches while signing.

A real packet asks for more than marks on a page: a certificate of insurance,
a voided check, a scanned license. The review called those out as mandatory
fields the signer must satisfy before Finish, and asked that nothing about
where the file goes be left ambiguous. So, stated once, here:

  * WHERE it is stored - the same private Supabase bucket as the envelope's
    own PDFs, under `esign/{request_id}/uploads/{party_id}/{upload_id}-{name}`.
    Never a public bucket, never the local disk on a deployed API.
  * HOW it is associated - an `HrSignUpload` row carrying request, party and
    the field id it satisfies. The file is reachable only through that row.
  * WHO can access it - the sender and anyone with HR read on the envelope,
    plus the signer who uploaded it (through their own signing token, and only
    for their own rows). Never another signer: one party's insurance
    certificate is not the other party's business.
  * WHERE it appears afterwards - on the envelope's detail screen, in the
    certificate's evidence table with its digest, and beside the sealed PDF in
    the requester's Egnyte work folder.
  * WHETHER it is part of the final package - yes. It is listed and hashed on
    the certificate, so the record states exactly which bytes were submitted,
    and it is filed with the sealed document rather than living only in a
    database nobody looks in.

What it deliberately does NOT do is merge the file into the sealed PDF. The
upload can be a multi-page scan or a photo of any dimension, and rasterizing
arbitrary input into someone's contract at seal time is how sealing starts
failing on documents that are already fully signed. The digest on the
certificate is what binds the file to the envelope; the bytes stay beside it.

Storage access is INJECTED rather than imported: routers/esign.py owns the
bucket, the service key and the local-disk fallback, and there must not be a
second copy of that decision here.
"""
import hashlib
import io
import os
import re
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy.orm import Session

from models import HrSignUpload

# 15 MB. Big enough for a scanned multi-page certificate of insurance at a
# sane DPI, small enough that a signer on a phone connection is not uploading
# for ten minutes and that a packet of eight fields cannot become a gigabyte.
MAX_BYTES = 15 * 1024 * 1024

# What a signer may attach. Evidence the sender can actually open, and nothing
# that executes: an envelope's attachments are downloaded by the counterparty,
# by counsel and by whoever audits the file years later, and an archive or a
# macro-enabled document turns a signing record into a delivery mechanism.
# Keyed by extension because browsers disagree about the type they report for
# the same file (HEIC especially); the extension is what we store and serve.
ALLOWED = {
    "pdf":  "application/pdf",
    "png":  "image/png",
    "jpg":  "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
    "heic": "image/heic",
    "heif": "image/heif",
    "tif":  "image/tiff",
    "tiff": "image/tiff",
}
ALLOWED_HINT = "PDF, PNG, JPG, WEBP, HEIC or TIFF"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_name(name: str) -> str:
    """The signer's filename, reduced to something safe to put in a storage key
    and an email attachment name. Keeps the extension - it decides the content
    type we serve the file back as."""
    base = (name or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    base = re.sub(r'[^A-Za-z0-9._ -]+', "_", base)[:120].strip(" .") or "attachment"
    return base


def ext_of(name: str) -> str:
    return (name or "").rsplit(".", 1)[-1].lower() if "." in (name or "") else ""


def check(name: str, blob: bytes) -> tuple:
    """Validate one incoming file. Returns (safe_name, content_type); raises
    with a message written for the SIGNER, who is an external person with no
    idea what our storage rules are."""
    if not blob:
        raise HTTPException(400, "That file was empty - please choose it again.")
    if len(blob) > MAX_BYTES:
        mb = len(blob) / (1024 * 1024)
        raise HTTPException(413, f"That file is {mb:.1f} MB. Please upload something under "
                                 f"{MAX_BYTES // (1024 * 1024)} MB.")
    clean = safe_name(name)
    ext = ext_of(clean)
    if ext not in ALLOWED:
        raise HTTPException(400, f"That file type isn't accepted here. Please upload a "
                                 f"{ALLOWED_HINT} file.")
    # A PDF that is not a PDF is the one case worth checking by content: the
    # rest are images we only ever hand back as a download, but a PDF gets
    # OPENED, and the whole point of the field is that the sender can read it.
    if ext == "pdf" and not blob[:5].startswith(b"%PDF-"):
        raise HTTPException(400, "That doesn't look like a valid PDF - please re-export it "
                                 "and try again.")
    return clean, ALLOWED[ext]


def fields_for(req, party) -> list:
    """Every upload field addressed to this party, across the envelope's own
    fields and each packet document. Same traversal order the signing screen
    and `_missing_required` use, so the three always agree on what exists."""
    out = []
    for f in (getattr(req, "fields", None) or []):
        if f.get("type") == "upload" and f.get("role") == party.role_key:
            out.append(f)
    for d in (getattr(req, "documents", None) or []):
        for f in (d.get("fields") or []):
            if f.get("type") == "upload" and f.get("role") == party.role_key:
                out.append(f)
    return out


def current(db: Session, party_id: str) -> list:
    """This party's live uploads - superseded rows excluded. Ordered oldest
    first so a certificate lists them in the order they were provided."""
    return (db.query(HrSignUpload)
            .filter(HrSignUpload.party_id == party_id, HrSignUpload.superseded_at == "")
            .order_by(HrSignUpload.uploaded_at).all())


def current_by_field(db: Session, party_id: str) -> dict:
    return {u.field_id: u for u in current(db, party_id)}


def missing(db: Session, req, party) -> list:
    """Names of the REQUIRED upload fields this party has not satisfied.

    Called from the same server-side guard as every other required field, so a
    POST straight at /sign cannot skip an upload the screen would have blocked.
    """
    have = current_by_field(db, party.id)
    out = []
    for f in fields_for(req, party):
        if f.get("required", True) is False:
            continue
        if not have.get(f.get("id")):
            out.append(f.get("label") or "File upload")
    return out


def store(db: Session, req, party, field_id: str, name: str, blob: bytes,
          put, ip: str = "") -> HrSignUpload:
    """Validate, upload to object storage, and record the row.

    `put(path, blob, content_type) -> bool` is routers/esign.py's storage
    writer. Nothing is recorded when the write fails: a row pointing at bytes
    that are not there would satisfy a required field with nothing behind it,
    which is worse than making the signer press the button again.
    """
    field = next((f for f in fields_for(req, party) if f.get("id") == field_id), None)
    if field is None:
        raise HTTPException(400, "There is no upload field here for you to fill.")
    clean, ctype = check(name, blob)

    uid = str(uuid.uuid4())
    path = f"esign/{req.id}/uploads/{party.id}/{uid}-{clean}"
    if not put(path, blob, ctype):
        raise HTTPException(502, "We couldn't store that file. Please try again in a moment.")

    now = _now()
    # Supersede rather than delete: the signer replacing a wrong scan is
    # ordinary, and the envelope should still be able to show that an earlier
    # file was submitted and swapped. Only the live row satisfies the field.
    (db.query(HrSignUpload)
     .filter(HrSignUpload.party_id == party.id, HrSignUpload.field_id == field_id,
             HrSignUpload.superseded_at == "")
     .update({HrSignUpload.superseded_at: now}, synchronize_session=False))
    row = HrSignUpload(
        id=uid, request_id=req.id, party_id=party.id, field_id=field_id,
        field_label=(field.get("label") or "File upload")[:200],
        name=clean, storage_path=path, content_type=ctype, size_bytes=len(blob),
        sha256=hashlib.sha256(blob).hexdigest(), uploaded_at=now,
        uploaded_ip=(ip or "")[:64], superseded_at="")
    db.add(row)
    db.flush()      # autoflush=False: the same request's missing() must see it
    return row


def serialize(u: HrSignUpload) -> dict:
    """What the signing screen and the envelope detail show. No storage path -
    the file is reached through an endpoint that re-checks who is asking."""
    return {"id": u.id, "fieldId": u.field_id, "label": u.field_label, "name": u.name,
            "size": int(u.size_bytes or 0), "contentType": u.content_type or "",
            "sha256": u.sha256 or "", "uploadedAt": u.uploaded_at or ""}


def evidence_rows(db: Session, request_id: str) -> list:
    """The certificate's line per submitted file: who provided it, what it is
    called, how big it is, and the digest of the bytes as received. Live rows
    only - a superseded scan is not what was submitted."""
    rows = (db.query(HrSignUpload)
            .filter(HrSignUpload.request_id == request_id, HrSignUpload.superseded_at == "")
            .order_by(HrSignUpload.uploaded_at).all())
    return [{"party_id": u.party_id, "label": u.field_label or "File upload",
             "name": u.name or "", "size": int(u.size_bytes or 0),
             "sha256": u.sha256 or "", "uploaded_at": u.uploaded_at or ""}
            for u in rows]
