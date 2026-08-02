"""Credential Vault - company + personal password vault (ported from the
standalone credential-vault-dev app, Jul 2026).

Security model:
- Whole router sits behind the "credvault" module grant (admins bypass).
- Secrets are Fernet-encrypted at rest with NEXUS_VAULT_KEY (falls back to a
  clearly-marked dev-only derived key when unset - set the env var on Azure).
- List endpoints NEVER return secrets; only the explicit per-item reveal
  endpoints do, and every reveal/copy is written to vault_access_logs.
- Critical-tier credentials: non-admin reveal creates an approval request for
  Global Admins instead of returning the secret.
- Company credentials are edited/deleted only by their owner or backup owner.
- Personal credentials are strictly owner-scoped - no admin bypass.
- Secret values are never logged (only names/metadata reach logs/notifications).
"""
import base64
import hashlib
import os
import re
import uuid
from datetime import datetime, timezone, timedelta

from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
from database import get_db
from auth import get_current_user, require_module_grant, _module_level, _MODULE_LEVEL_RANK
from routers.stepup import require_stepup

router = APIRouter(
    prefix="/credvault",
    tags=["Credential Vault"],
    dependencies=[Depends(require_module_grant("credvault"))],
)

TIERS = ("Standard", "High", "Critical")
TYPES = ("Password", "API key", "Access key", "Certificate")

# ── Encryption at rest ────────────────────────────────────────────────────────
# Fail-closed on Azure (Aug 1, 2026): the derived dev fallback key is a known
# constant, so on a deployed API it provides zero protection - anyone with the
# repo can decrypt what it "encrypts". A deployed worker without NEXUS_VAULT_KEY
# now DISABLES the vault (503 on every operation) instead of silently running
# fake crypto. Same posture as NEXUS_SKIP_AUTH being refused on Azure. The
# whole app deliberately does NOT crash - only the vault locks.
_VAULT_KEY = os.getenv("NEXUS_VAULT_KEY", "").strip()
_ON_AZURE = bool(os.getenv("WEBSITE_SITE_NAME"))
if _VAULT_KEY:
    _fernet = Fernet(_VAULT_KEY.encode())
elif _ON_AZURE:
    _fernet = None
    print("[credvault] NEXUS_VAULT_KEY not set on a DEPLOYED API - vault DISABLED (fail-closed)")
else:
    # DEV-ONLY fallback so local SQLite dev works out of the box.
    _fernet = Fernet(base64.urlsafe_b64encode(
        hashlib.sha256(b"nexus-credvault-DEV-ONLY-key-set-NEXUS_VAULT_KEY").digest()
    ))
    print("[credvault] WARNING: NEXUS_VAULT_KEY not set - using dev-only fallback key")


def _require_key():
    if _fernet is None:
        raise HTTPException(503, "Vault is locked: NEXUS_VAULT_KEY is not configured "
                                 "on this deployment. Set it in App Service configuration.")
    return _fernet


def _enc(secret: str) -> str:
    return _require_key().encrypt(secret.encode()).decode()


def _dec(ciphertext: str) -> str:
    try:
        return _require_key().decrypt(ciphertext.encode()).decode()
    except InvalidToken:
        raise HTTPException(500, "Credential cannot be decrypted (vault key mismatch)")


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def _eval_strength(pwd: str) -> str:
    """Mirror of the frontend evalStrength()."""
    if not pwd:
        return "weak"
    s = (1 if len(pwd) >= 12 else 0)
    s += 1 if re.search(r"[A-Z]", pwd) else 0
    s += 1 if re.search(r"[0-9]", pwd) else 0
    s += 1 if re.search(r"[^A-Za-z0-9]", pwd) else 0
    return "strong" if s >= 3 else "fair" if s >= 2 else "weak"


# ── Helpers ───────────────────────────────────────────────────────────────────
def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ms(iso: str) -> int:
    if not iso:
        return 0
    try:
        return int(datetime.fromisoformat(iso).timestamp() * 1000)
    except ValueError:
        return 0


def _days_since(iso: str) -> int:
    if not iso:
        return 0
    try:
        return max(0, (datetime.now(timezone.utc) - datetime.fromisoformat(iso)).days)
    except ValueError:
        return 0


def _days_until(iso: str):
    if not iso:
        return None
    try:
        return (datetime.fromisoformat(iso) - datetime.now(timezone.utc)).days
    except ValueError:
        return None


def _is_admin(user: dict) -> bool:
    return user["level"] >= 4


def _require_write(user: dict, db: Session) -> None:
    """Create/import need at least an editor-level module grant (admins bypass)."""
    if _is_admin(user):
        return
    if _module_level(user["email"], "credvault", db) >= _MODULE_LEVEL_RANK["editor"]:
        return
    raise HTTPException(403, "You need editor access to the Credential Vault to do this")


def _display_name(email: str, db: Session) -> str:
    row = db.query(models.NexusRole).filter(models.NexusRole.email == (email or "").lower()).first()
    if row and (row.display_name or "").strip():
        return row.display_name.strip()
    local = (email or "").split("@")[0].replace("_", ".")
    return " ".join(p.capitalize() for p in local.split(".") if p) or email


def _log(db: Session, user: dict, action: str, cred_name: str, dept: str = "",
         cred_id: str = "", detail=None) -> None:
    db.add(models.VaultAccessLog(
        id=str(uuid.uuid4()),
        actor_email=user["email"],
        actor_name=_display_name(user["email"], db),
        action=action,
        cred_id=cred_id,
        cred_name=cred_name,
        dept=dept,
        detail=detail,
        loc="",
        created_at=_now(),
    ))


def _notify(db: Session, *, type: str, recipient: str, title: str, body: str,
            ref_id: str = "") -> None:
    """Server-side bell notification (mirrors items.py). Empty recipient
    broadcasts to all managers - used for credential-change announcements."""
    db.add(models.NexusNotification(
        id=str(uuid.uuid4()),
        type=type,
        recipient=recipient.lower() if recipient else "",
        title=title,
        body=body,
        ref_id=ref_id,
        item_name="",
        requested_by="",
        action="",
        actioned=False,
        read_by="",
        created_at=_now(),
    ))


def _get_cred(cred_id: str, db: Session) -> models.VaultCredential:
    row = db.get(models.VaultCredential, cred_id)
    if not row:
        raise HTTPException(404, "Credential not found")
    return row


def _can_modify(cred: models.VaultCredential, user: dict) -> bool:
    email = user["email"]
    return email == (cred.owner_email or "").lower() or email == (cred.backup_owner_email or "").lower()


def _active_grant(cred_id: str, email: str, db: Session):
    now = _now()
    return (db.query(models.VaultAccessGrant)
            .filter(models.VaultAccessGrant.cred_id == cred_id,
                    models.VaultAccessGrant.granted_to == email,
                    models.VaultAccessGrant.expires_at > now)
            .first())


def _cred_dict(c: models.VaultCredential, reused: bool, shared_with: int) -> dict:
    return {
        "id": c.id, "name": c.name, "dept": c.dept or "", "type": c.type or "Password",
        "username": c.username or "", "url": c.url or "", "tier": c.tier or "Standard",
        "owner": c.owner_email or "", "backupOwner": c.backup_owner_email or "",
        "strength": c.strength or "strong", "breached": bool(c.breached), "reused": reused,
        "rotatedDays": _days_since(c.rotated_at), "rotationMax": c.rotation_max or 90,
        "customExpiry": bool(c.custom_expiry), "expiresInDays": _days_until(c.expires_at),
        "sharedWith": shared_with, "deletedAt": _ms(c.deleted_at) or None,
        "createdAt": _ms(c.created_at),
    }


# ── Company credentials ───────────────────────────────────────────────────────
class CredentialIn(BaseModel):
    name: str = ""
    dept: str = ""
    type: str = "Password"
    username: str = ""
    secret: str = ""
    tier: str = "Standard"
    url: str = ""
    backupOwner: str = ""
    rotationMax: int = 90
    customExpiry: bool = False


@router.get("/credentials")
def list_credentials(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """All credentials, metadata only - secrets never leave the reveal endpoints.
    Includes soft-deleted rows (the frontend splits them into the Trash tab)."""
    rows = db.query(models.VaultCredential).all()
    hash_counts: dict = {}
    for c in rows:
        if not c.deleted_at and c.secret_hash:
            hash_counts[c.secret_hash] = hash_counts.get(c.secret_hash, 0) + 1
    now = _now()
    grants = db.query(models.VaultAccessGrant).filter(models.VaultAccessGrant.expires_at > now).all()
    grant_counts: dict = {}
    for g in grants:
        grant_counts[g.cred_id] = grant_counts.get(g.cred_id, 0) + 1
    return [
        _cred_dict(
            c,
            reused=bool(not c.deleted_at and c.secret_hash and hash_counts.get(c.secret_hash, 0) > 1),
            shared_with=1 + grant_counts.get(c.id, 0),
        )
        for c in rows
    ]


@router.post("/credentials")
def create_credential(body: CredentialIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_write(user, db)
    if not body.name.strip():
        raise HTTPException(400, "Name is required")
    if not body.secret:
        raise HTTPException(400, "Password/secret is required")
    row = models.VaultCredential(
        id=str(uuid.uuid4()),
        name=body.name.strip(),
        dept=body.dept.strip(),
        type=body.type if body.type in TYPES else "Password",
        username=body.username.strip() or "-",
        url=body.url.strip(),
        secret_enc=_enc(body.secret),
        secret_hash=_hash(body.secret),
        tier=body.tier if body.tier in TIERS else "Standard",
        owner_email=user["email"],
        backup_owner_email=(body.backupOwner or "").lower().strip(),
        strength=_eval_strength(body.secret),
        breached=False,
        rotation_max=body.rotationMax or 90,
        custom_expiry=bool(body.customExpiry),
        rotated_at=_now(),
        created_at=_now(),
        created_by=user["email"],
    )
    db.add(row)
    _log(db, user, "Created", row.name, row.dept, row.id)
    _notify(db, type="vault_change", recipient="",
            title="Credential Vault",
            body=f"{row.name} ({row.dept}) was added by {_display_name(user['email'], db)}.",
            ref_id=row.id)
    db.commit()
    return {"id": row.id, "ok": True}


@router.patch("/credentials/{cred_id}")
def update_credential(cred_id: str, body: CredentialIn,
                      user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    c = _get_cred(cred_id, db)
    if not _can_modify(c, user):
        raise HTTPException(403, "Only the owner or backup owner can edit this credential")
    changed = []
    if body.name and body.name != c.name:
        changed.append({"field": "Name", "from": c.name, "to": body.name})
        c.name = body.name
    if body.dept and body.dept != c.dept:
        changed.append({"field": "Department", "from": c.dept or "-", "to": body.dept})
        c.dept = body.dept
    if body.type != c.type and body.type in TYPES:
        changed.append({"field": "Type", "from": c.type, "to": body.type})
        c.type = body.type
    if body.username and body.username != c.username:
        changed.append({"field": "Username", "from": c.username, "to": body.username})
        c.username = body.username
    new_backup = (body.backupOwner or "").lower().strip()
    if new_backup != (c.backup_owner_email or ""):
        changed.append({"field": "Backup owner", "from": c.backup_owner_email or "-", "to": new_backup or "-"})
        c.backup_owner_email = new_backup
    c.url = (body.url or "").strip()
    c.rotation_max = body.rotationMax or c.rotation_max or 90
    c.custom_expiry = bool(body.customExpiry)
    # Empty secret = keep current password (never echoed back to the client)
    if body.secret and _hash(body.secret) != c.secret_hash:
        changed.append({"field": "Password", "from": "••••••", "to": "••••••"})
        c.secret_enc = _enc(body.secret)
        c.secret_hash = _hash(body.secret)
        c.strength = _eval_strength(body.secret)
        c.breached = False
        c.rotated_at = _now()
    _log(db, user, "Edited", c.name, c.dept, c.id, detail=changed or None)
    _notify(db, type="vault_change", recipient="",
            title="Credential Vault",
            body=f"{c.name} ({c.dept}) was edited by {_display_name(user['email'], db)}.",
            ref_id=c.id)
    db.commit()
    return {"ok": True}


@router.delete("/credentials/{cred_id}")
def delete_credential(cred_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Soft delete → Trash."""
    c = _get_cred(cred_id, db)
    if not _can_modify(c, user):
        raise HTTPException(403, "Only the owner or backup owner can remove this credential")
    c.deleted_at = _now()
    c.deleted_by = user["email"]
    _log(db, user, "Removed", c.name, c.dept, c.id)
    _notify(db, type="vault_change", recipient="",
            title="Credential Vault",
            body=f"{c.name} ({c.dept}) was removed by {_display_name(user['email'], db)}.",
            ref_id=c.id)
    db.commit()
    return {"ok": True}


class BulkIds(BaseModel):
    ids: list[str] = []


@router.post("/credentials/bulk-delete")
def bulk_delete(body: BulkIds, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.query(models.VaultCredential).filter(models.VaultCredential.id.in_(body.ids or [])).all()
    count = 0
    for c in rows:
        if _can_modify(c, user) and not c.deleted_at:
            c.deleted_at = _now()
            c.deleted_by = user["email"]
            count += 1
    if count:
        label = f"{count} credential{'' if count == 1 else 's'}"
        _log(db, user, "Removed", label, "-")
        _notify(db, type="vault_change", recipient="",
                title="Credential Vault",
                body=f"{label} removed by {_display_name(user['email'], db)}.")
    db.commit()
    return {"deleted": count}


@router.post("/credentials/{cred_id}/restore")
def restore_credential(cred_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    c = _get_cred(cred_id, db)
    if not c.deleted_at:
        raise HTTPException(400, "Credential is not in the trash")
    c.deleted_at = ""
    c.deleted_by = ""
    _log(db, user, "Recovered", c.name, c.dept, c.id)
    db.commit()
    return {"ok": True}


@router.delete("/credentials/{cred_id}/permanent")
def purge_credential(cred_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    c = _get_cred(cred_id, db)
    if not (_can_modify(c, user) or _is_admin(user)):
        raise HTTPException(403, "Only the owner, backup owner or an admin can permanently delete this")
    if not c.deleted_at:
        raise HTTPException(400, "Move the credential to the trash first")
    db.delete(c)
    db.commit()
    return {"ok": True}


@router.post("/credentials/{cred_id}/reveal")
def reveal_credential(cred_id: str, user: dict = Depends(get_current_user),
                      _su: dict = Depends(require_stepup), db: Session = Depends(get_db)):
    """The ONLY way a company secret leaves the server (besides grant reveal).
    Requires a fresh step-up MFA (require_stepup). Critical tier + non-admin →
    creates an approval request instead."""
    c = _get_cred(cred_id, db)
    if c.deleted_at:
        raise HTTPException(400, "Credential is in the trash")
    if c.tier == "Critical" and not _is_admin(user) and not _active_grant(c.id, user["email"], db):
        req = models.VaultShareRequest(
            id=str(uuid.uuid4()),
            cred_id=c.id,
            requested_by_email=user["email"],
            shared_to_email=user["email"],
            owner_email="",           # Global Admin approval queue
            duration_ms=3600000,
            duration_label="1 Hour",
            status="pending",
            created_at=_now(),
        )
        db.add(req)
        _log(db, user, "Requested", c.name, c.dept, c.id)
        _notify(db, type="vault_access", recipient="",
                title="Credential Vault - access request",
                body=f"{_display_name(user['email'], db)} requested access to {c.name} ({c.dept}).",
                ref_id=c.id)
        db.commit()
        return {"approvalRequired": True}
    secret = _dec(c.secret_enc)
    _log(db, user, "Revealed", c.name, c.dept, c.id)
    db.commit()
    return {"secret": secret}


@router.post("/credentials/{cred_id}/copied")
def log_copied(cred_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    c = _get_cred(cred_id, db)
    _log(db, user, "Copied", c.name, c.dept, c.id)
    db.commit()
    return {"ok": True}


class ImportIn(BaseModel):
    rows: list[dict] = []


@router.post("/import")
def import_credentials(body: ImportIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_write(user, db)
    created = 0
    for r in body.rows or []:
        name = (r.get("name") or "").strip()
        secret = r.get("secret") or ""
        if not name or not secret:
            continue
        db.add(models.VaultCredential(
            id=str(uuid.uuid4()),
            name=name,
            dept=(r.get("department") or "").strip(),
            type=r.get("type") if r.get("type") in TYPES else "Password",
            username=(r.get("username") or "-").strip(),
            secret_enc=_enc(secret),
            secret_hash=_hash(secret),
            tier=r.get("tier") if r.get("tier") in TIERS else "Standard",
            owner_email=user["email"],
            strength=_eval_strength(secret),
            rotated_at=_now(),
            created_at=_now(),
            created_by=user["email"],
        ))
        created += 1
    if created:
        _log(db, user, "Imported", f"{created} credentials", "-")
        _notify(db, type="vault_change", recipient="",
                title="Credential Vault",
                body=f"{created} credentials were imported by {_display_name(user['email'], db)}.")
    db.commit()
    return {"imported": created}


# ── Sharing / approvals / grants ─────────────────────────────────────────────
class ShareIn(BaseModel):
    recipientEmail: str = ""
    durationMs: int = 14400000
    durationLabel: str = "4 Hours"


@router.post("/credentials/{cred_id}/share")
def share_credential(cred_id: str, body: ShareIn,
                     user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    c = _get_cred(cred_id, db)
    if c.deleted_at:
        raise HTTPException(400, "Credential is in the trash")
    recipient = (body.recipientEmail or "").lower().strip()
    if "@" not in recipient or "." not in recipient:
        raise HTTPException(400, "A valid recipient email address is required")
    duration_ms = max(60000, min(body.durationMs or 3600000, 7 * 86400000))
    if user["email"] == (c.owner_email or "").lower():
        expires = (datetime.now(timezone.utc) + timedelta(milliseconds=duration_ms)).isoformat()
        db.add(models.VaultAccessGrant(
            id=str(uuid.uuid4()), cred_id=c.id, granted_to=recipient,
            granted_by=user["email"], granted_at=_now(), expires_at=expires,
        ))
        _log(db, user, "Shared", c.name, c.dept, c.id)
        _notify(db, type="vault_access", recipient=recipient,
                title="Credential Vault - access granted",
                body=f"{_display_name(user['email'], db)} shared {c.name} with you for {body.durationLabel}. Open the Credential Vault to view it.",
                ref_id=c.id)
        db.commit()
        return {"granted": True}
    db.add(models.VaultShareRequest(
        id=str(uuid.uuid4()), cred_id=c.id,
        requested_by_email=user["email"], shared_to_email=recipient,
        owner_email=(c.owner_email or "").lower(),
        duration_ms=duration_ms, duration_label=body.durationLabel or "",
        status="pending", created_at=_now(),
    ))
    _notify(db, type="vault_access", recipient=(c.owner_email or "").lower(),
            title="Credential Vault - share request",
            body=f"{_display_name(user['email'], db)} wants to share {c.name} with {recipient} ({body.durationLabel}).",
            ref_id=c.id)
    db.commit()
    return {"requested": True}


@router.get("/requests")
def list_requests(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Pending requests visible to me: those addressed to me as owner, plus the
    admin queue (owner_email empty) when I'm an admin."""
    q = db.query(models.VaultShareRequest).filter(models.VaultShareRequest.status == "pending")
    rows = q.all()
    out = []
    creds = {c.id: c for c in db.query(models.VaultCredential).all()}
    for r in rows:
        mine = (r.owner_email == user["email"]) or (not r.owner_email and _is_admin(user))
        if not mine:
            continue
        c = creds.get(r.cred_id)
        out.append({
            "id": r.id, "credId": r.cred_id, "cred": c.name if c else "(deleted)",
            "dept": c.dept if c else "-",
            "requestedBy": _display_name(r.requested_by_email, db),
            "requestedByEmail": r.requested_by_email,
            "sharedToEmail": r.shared_to_email,
            "ownerEmail": r.owner_email,
            "duration": r.duration_label or "1 Hour",
            "durationMs": r.duration_ms or 3600000,
            "ts": _ms(r.created_at),
        })
    out.sort(key=lambda x: -x["ts"])
    return out


def _decide_request(req_id: str, user: dict, db: Session) -> models.VaultShareRequest:
    r = db.get(models.VaultShareRequest, req_id)
    if not r or r.status != "pending":
        raise HTTPException(404, "Request not found or already decided")
    if not ((r.owner_email == user["email"]) or (not r.owner_email and _is_admin(user))):
        raise HTTPException(403, "Only the credential owner (or an admin for admin-queue requests) can decide this")
    return r


@router.post("/requests/{req_id}/approve")
def approve_request(req_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    r = _decide_request(req_id, user, db)
    c = _get_cred(r.cred_id, db)
    recipient = (r.shared_to_email or r.requested_by_email or "").lower()
    duration_ms = r.duration_ms or 3600000
    expires = (datetime.now(timezone.utc) + timedelta(milliseconds=duration_ms)).isoformat()
    db.add(models.VaultAccessGrant(
        id=str(uuid.uuid4()), cred_id=c.id, granted_to=recipient,
        granted_by=user["email"], granted_at=_now(), expires_at=expires,
    ))
    r.status = "approved"
    r.decided_at = _now()
    r.decided_by = user["email"]
    _log(db, user, "Shared", c.name, c.dept, c.id)
    _notify(db, type="vault_access", recipient=recipient,
            title="Credential Vault - access approved",
            body=f"{_display_name(user['email'], db)} approved {r.duration_label or 'temporary'} access to {c.name}. Open the Credential Vault to view it.",
            ref_id=c.id)
    db.commit()
    return {"ok": True}


@router.post("/requests/{req_id}/deny")
def deny_request(req_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    r = _decide_request(req_id, user, db)
    c = db.get(models.VaultCredential, r.cred_id)
    r.status = "denied"
    r.decided_at = _now()
    r.decided_by = user["email"]
    _log(db, user, "Denied", c.name if c else "(deleted)", c.dept if c else "-", r.cred_id)
    db.commit()
    return {"ok": True}


@router.get("/grants")
def list_grants(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Active grants shared TO me - metadata only; reveal is a separate call."""
    now = _now()
    rows = (db.query(models.VaultAccessGrant)
            .filter(models.VaultAccessGrant.granted_to == user["email"],
                    models.VaultAccessGrant.expires_at > now)
            .all())
    creds = {c.id: c for c in db.query(models.VaultCredential)
             .filter(models.VaultCredential.id.in_([g.cred_id for g in rows] or [""])).all()}
    return [{
        "id": g.id, "credId": g.cred_id,
        "credName": creds[g.cred_id].name if g.cred_id in creds else "(deleted)",
        "grantedBy": _display_name(g.granted_by, db),
        "grantedAt": _ms(g.granted_at), "expiresAt": _ms(g.expires_at),
    } for g in rows]


@router.post("/grants/{grant_id}/reveal")
def reveal_grant(grant_id: str, user: dict = Depends(get_current_user),
                 _su: dict = Depends(require_stepup), db: Session = Depends(get_db)):
    g = db.get(models.VaultAccessGrant, grant_id)
    if not g or g.granted_to != user["email"]:
        raise HTTPException(404, "Grant not found")
    if g.expires_at <= _now():
        raise HTTPException(403, "This shared access has expired")
    c = _get_cred(g.cred_id, db)
    secret = _dec(c.secret_enc)
    _log(db, user, "Revealed", c.name, c.dept, c.id)
    db.commit()
    return {"secret": secret}


# ── Activity log ──────────────────────────────────────────────────────────────
@router.get("/logs")
def list_logs(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (db.query(models.VaultAccessLog)
            .order_by(models.VaultAccessLog.created_at.desc())
            .limit(500).all())
    return [{
        "id": r.id, "actor": r.actor_name or r.actor_email, "actorEmail": r.actor_email,
        "action": r.action, "cred": r.cred_name, "credId": r.cred_id,
        "dept": r.dept or "-", "loc": r.loc or "", "detail": r.detail,
        "ts": _ms(r.created_at),
    } for r in rows]


# ── Personal vault (strictly owner-scoped - no admin bypass) ─────────────────
class PersonalIn(BaseModel):
    name: str = ""
    username: str = ""
    secret: str = ""
    type: str = "Password"
    note: str = ""


@router.get("/personal")
def list_personal(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (db.query(models.VaultPersonalCredential)
            .filter(models.VaultPersonalCredential.owner_email == user["email"])
            .order_by(models.VaultPersonalCredential.created_at.desc())
            .all())
    return [{
        "id": r.id, "name": r.name, "username": r.username or "-",
        "type": r.type or "Password", "note": r.note or "",
        "strength": r.strength or "strong", "createdAt": _ms(r.created_at),
    } for r in rows]


@router.post("/personal")
def create_personal(body: PersonalIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if not body.name.strip() or not body.secret:
        raise HTTPException(400, "Name and password are required")
    row = models.VaultPersonalCredential(
        id=str(uuid.uuid4()),
        owner_email=user["email"],
        name=body.name.strip(),
        username=body.username.strip() or "-",
        type=body.type if body.type in TYPES else "Password",
        note=body.note.strip(),
        secret_enc=_enc(body.secret),
        strength=_eval_strength(body.secret),
        created_at=_now(),
    )
    db.add(row)
    db.commit()
    return {"id": row.id, "ok": True}


@router.delete("/personal/{pid}")
def delete_personal(pid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.get(models.VaultPersonalCredential, pid)
    if not row or row.owner_email != user["email"]:
        raise HTTPException(404, "Not found")
    db.delete(row)
    db.commit()
    return {"ok": True}


@router.post("/personal/{pid}/reveal")
def reveal_personal(pid: str, user: dict = Depends(get_current_user),
                    _su: dict = Depends(require_stepup), db: Session = Depends(get_db)):
    row = db.get(models.VaultPersonalCredential, pid)
    if not row or row.owner_email != user["email"]:
        raise HTTPException(404, "Not found")
    # Personal reveals were previously unaudited - record them like company reveals.
    _log(db, user, "Revealed", row.name, "Personal", pid)
    db.commit()
    return {"secret": _dec(row.secret_enc)}
