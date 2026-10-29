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
import hmac
import json
import os
import re
import secrets as _secrets
import uuid
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace

from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

import graph_mail
import models
from database import get_db
from auth import (get_current_user, require_module_grant, _module_level, _MODULE_LEVEL_RANK,
                  company_scope, company_ok, company_of_email_map)
from notify_company import notification_company
import job_switch
import vault_access as VA

router = APIRouter(
    prefix="/credvault",
    tags=["Credential Vault"],
    dependencies=[Depends(require_module_grant("credvault"))],
)

TIERS = ("Standard", "High", "Critical")
TYPES = ("Password", "API key", "Access key", "Certificate")
PERSONAL_DEPT = "Personal"      # vault_access_logs.dept for Personal Vault rows - actor-only in list_logs

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


# Reuse detection compares hashes of the plaintext (Fernet output differs on
# every call, so the ciphertext cannot be compared). Oct 14 2026 review: an
# unsalted SHA-256 of the password let anyone holding a database dump
# brute-force the weaker entries WITHOUT the vault key. The hash is now an HMAC
# keyed with that same key - worthless without it. rehash_secret_hashes() moves
# the existing rows over once (main._startup_seeds).
_HASH_KEY = (_VAULT_KEY or "nexus-credvault-DEV-ONLY-hash-key").encode()
REHASH_MARK = "vault_secret_hash_hmac"      # nexus_settings key: the one-time rehash ran


def _hash(secret: str) -> str:
    return hmac.new(_HASH_KEY, secret.encode(), hashlib.sha256).hexdigest()


def rehash_secret_hashes(db: Session) -> int:
    """One-time: recompute every company credential's reuse hash with the keyed
    scheme. Runs from main._startup_seeds (one process per deploy); the
    nexus_settings marker makes every later boot a no-op. Not run - and not
    marked - while the vault key is missing, so it happens on the first start
    that has it. Returns how many rows were rehashed."""
    if _fernet is None or db.get(models.NexusSetting, REHASH_MARK):
        return 0
    n = 0
    for c in db.query(models.VaultCredential).all():
        if not c.secret_enc:
            continue
        try:
            c.secret_hash = _hash(_fernet.decrypt(c.secret_enc.encode()).decode())
            n += 1
        except InvalidToken:
            continue            # written under another key - leave its hash alone
    db.add(models.NexusSetting(key=REHASH_MARK, value=_now(), updated_by="startup", updated_at=_now()))
    db.commit()
    return n


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


def _aware(iso: str) -> datetime:
    """ISO text -> aware UTC datetime. A plain date (the hard expiry, "2027-03-01")
    and a naive timestamp are both read as UTC."""
    d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _days_since(iso: str) -> int:
    if not iso:
        return 0
    try:
        return max(0, (datetime.now(timezone.utc) - _aware(iso)).days)
    except ValueError:
        return 0


def _days_until(iso: str):
    """Calendar days until `iso` (negative once past); None when unset."""
    if not iso:
        return None
    try:
        return (_aware(iso).date() - datetime.now(timezone.utc).date()).days
    except ValueError:
        return None


def _seconds_since(iso: str) -> float:
    try:
        return (datetime.now(timezone.utc) - datetime.fromisoformat(iso)).total_seconds()
    except (ValueError, TypeError):
        return 999999


# ── SMS / Email OTP (Aug 2026) ──────────────────────────────────────────────
# Replaces step-up MFA for company-vault reveal/share: instead of forcing a
# fresh Entra re-login, the user picks SMS or Email and types the 6-digit code
# they receive. A verified code opens a VaultOtpSession (short burst, mirrors
# StepUpSession) that require_vault_otp checks.
# The two unlock windows are Settings > Global > Security values (Sep 2026,
# security_config.py `vaultOtpUnlockSec` / `vaultPersonalUnlockSec`, 1-30 min):
# saved value > env (NEXUS_VAULT_OTP_TTL_SEC, default 300 - how long a verified
# code unlocks reveal/share; NEXUS_VAULT_PERSONAL_TTL_SEC, default 600 - the
# personal-vault server ceiling, the UI auto-locks sooner at 2 min idle).
# Read per request via _otp_ttl() / _personal_ttl().
OTP_CODE_TTL_SEC    = 600     # 10 minutes to type the code in
OTP_MAX_ATTEMPTS    = 5
OTP_RESEND_COOLDOWN_SEC = 30


def _otp_ttl(db) -> int:
    import security_config
    return int(security_config.get("vaultOtpUnlockSec", db))


def _personal_ttl(db) -> int:
    import security_config
    return int(security_config.get("vaultPersonalUnlockSec", db))

# sent.dm SMS goes through the ONE shared client (backend/sentdm.py) - same
# x-api-key auth and the same NEXUS_SENTDM_KEY as external login. This file
# used to carry its own copy with a different env var (SENTDM_API_KEY), so
# the two SMS surfaces could never both be configured at once. Until the key
# is set, SMS is STUBBED off Azure (code logged + returned as `devCode`) and
# fail-closed on a deployed API ("use Email").
import sentdm as _sentdm


def _gen_otp_code() -> str:
    return f"{_secrets.randbelow(1000000):06d}"


def _hash_otp_code(challenge_id: str, code: str) -> str:
    # Salted with the (unguessable) challenge id - a leaked hash alone isn't
    # brute-forceable offline without also knowing which challenge it pairs with.
    return hashlib.sha256(f"{challenge_id}:{code}".encode()).hexdigest()


def _mask_email(email: str) -> str:
    if "@" not in (email or ""):
        return "••••"
    user, dom = email.split("@", 1)
    return (user[:1] + "•" * max(2, len(user) - 1)) + "@" + dom


def _mask_phone(phone: str) -> str:
    digits = re.sub(r"\D", "", phone or "")
    return "•••• " + digits[-4:] if len(digits) >= 4 else "••••"


def _hash_password(password: str) -> str:
    salt = _secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 100_000)
    return f"{salt}${dk.hex()}"


def _verify_password(password: str, stored: str) -> bool:
    try:
        salt, hexhash = (stored or "").split("$", 1)
    except ValueError:
        return False
    dk = hashlib.pbkdf2_hmac("sha256", (password or "").encode(), bytes.fromhex(salt), 100_000)
    return _secrets.compare_digest(dk.hex(), hexhash)


def _send_sms_or_stub(phone: str, code: str) -> str:
    """Sends via sent.dm when configured. Returns the code when it instead ran
    the dev stub (so local testing works without a live SMS account) - the
    caller surfaces that as `devCode`; empty string means a real send happened."""
    if _sentdm.configured():
        ok, err = _sentdm.send_vault_code(phone, code)
        if not ok:
            print(f"[credvault] sent.dm SMS failed: {err}")
            raise HTTPException(502, "Could not send the SMS code - please try Email instead.")
        return ""
    if _ON_AZURE:
        print("[credvault] NEXUS_SENTDM_KEY not set on a DEPLOYED API - SMS code NOT sent (fail-closed)")
        raise HTTPException(503, "SMS verification isn't configured on this deployment yet - use Email instead.")
    print(f"[credvault] SMS STUB (NEXUS_SENTDM_KEY not set) - code for {phone}: {code}")
    return code


def _send_email_otp(to_email: str, code: str) -> str:
    """Sends via Microsoft Graph when configured. Returns the code when it
    instead ran the dev stub (Graph app-only creds absent locally); empty
    string means a real send happened."""
    if graph_mail.graph_configured():
        try:
            graph_mail.send_mail(
                from_email=graph_mail.DEFAULT_FROM_EMAIL, to=[to_email], cc=None,
                subject="Your Credential Vault Verification Code",
                html=(f"<p>Your Greens Nexus Credential Vault verification code is:</p>"
                      f"<p style='font-size:28px;font-weight:700;letter-spacing:6px'>{code}</p>"
                      f"<p>This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>"),
            )
        except graph_mail.GraphMailError as e:
            print(f"[credvault] OTP email failed: {e}")
            raise HTTPException(502, "Could not send the email code - please try SMS instead.")
        return ""
    if _ON_AZURE:
        print("[credvault] Graph mail not configured on a DEPLOYED API - OTP email NOT sent (fail-closed)")
        raise HTTPException(503, "Email verification isn't configured on this deployment yet - use SMS instead.")
    print(f"[credvault] EMAIL STUB (Graph not configured) - code for {to_email}: {code}")
    return code


def _create_otp_challenge(db: Session, email: str, purpose: str, channel: str) -> dict:
    """Shared by /otp/request and /personal/lock/forgot. Raises on send failure
    (nothing is persisted in that case) or if a resend is requested too soon."""
    recent = (db.query(models.VaultOtpChallenge)
              .filter(models.VaultOtpChallenge.email == email, models.VaultOtpChallenge.purpose == purpose,
                      models.VaultOtpChallenge.consumed_at == "")
              .order_by(models.VaultOtpChallenge.created_at.desc()).first())
    if recent and _seconds_since(recent.created_at) < OTP_RESEND_COOLDOWN_SEC:
        wait = int(OTP_RESEND_COOLDOWN_SEC - _seconds_since(recent.created_at))
        raise HTTPException(429, f"Please wait {max(1, wait)}s before requesting another code.")

    code = _gen_otp_code()
    cid = str(uuid.uuid4())
    phone = ""
    if channel == "sms":
        emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == email).first()
        phone = (emp.phone if emp else "").strip()
        if not phone:
            raise HTTPException(400, "No phone number on file for SMS - use Email instead, or ask HR to add one.")
        dev_code = _send_sms_or_stub(phone, code)
        target, masked = phone, _mask_phone(phone)
    else:
        channel = "email"
        dev_code = _send_email_otp(email, code)
        target, masked = email, _mask_email(email)

    db.add(models.VaultOtpChallenge(
        id=cid, email=email, purpose=purpose, channel=channel, target=target,
        code_hash=_hash_otp_code(cid, code), attempts=0, consumed_at="",
        expires_at=(datetime.now(timezone.utc) + timedelta(seconds=OTP_CODE_TTL_SEC)).isoformat(),
        created_at=_now(),
    ))
    db.commit()
    resp = {"challengeId": cid, "channel": channel, "target": masked, "expiresInSec": OTP_CODE_TTL_SEC}
    if dev_code:
        resp["devCode"] = dev_code
    return resp


def _consume_otp_challenge(db: Session, challenge_id: str, email: str, purpose: str, code: str) -> models.VaultOtpChallenge:
    """Validates + marks a challenge consumed. Raises with a user-facing message
    on any failure; never returns a still-usable challenge."""
    ch = db.get(models.VaultOtpChallenge, challenge_id)
    if not ch or ch.email != email or ch.purpose != purpose:
        raise HTTPException(404, "Verification code not found - request a new one.")
    if ch.consumed_at:
        raise HTTPException(400, "This code was already used - request a new one.")
    if ch.expires_at <= _now():
        raise HTTPException(400, "This code has expired - request a new one.")
    if ch.attempts >= OTP_MAX_ATTEMPTS:
        raise HTTPException(429, "Too many incorrect attempts - request a new one.")
    if _hash_otp_code(ch.id, (code or "").strip()) != ch.code_hash:
        ch.attempts += 1
        db.commit()
        left = OTP_MAX_ATTEMPTS - ch.attempts
        raise HTTPException(400, f"Incorrect code ({left} attempt{'s' if left != 1 else ''} left).")
    ch.consumed_at = _now()
    return ch


def require_vault_otp(user: dict = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """Dependency: admit the request only if the caller holds an unexpired,
    verified SMS/Email OTP session. Gates company credential reveal/share -
    the CredVault-native replacement for step-up MFA on those actions."""
    row = (db.query(models.VaultOtpSession)
           .filter(models.VaultOtpSession.email == user["email"], models.VaultOtpSession.purpose == "reveal_share",
                   models.VaultOtpSession.expires_at > _now())
           .order_by(models.VaultOtpSession.expires_at.desc()).first())
    if row:
        return user
    raise HTTPException(status_code=403, detail={
        "code": "vault_otp_required",
        "message": "Please verify via SMS or Email to continue.",
    })


def require_personal_unlock(user: dict = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """Dependency: admit the request only if the caller's Personal Vault is
    currently unlocked (correct password entered recently)."""
    row = (db.query(models.VaultPersonalUnlockSession)
           .filter(models.VaultPersonalUnlockSession.email == user["email"],
                   models.VaultPersonalUnlockSession.expires_at > _now())
           .order_by(models.VaultPersonalUnlockSession.expires_at.desc()).first())
    if row:
        return user
    raise HTTPException(status_code=403, detail={
        "code": "personal_vault_locked",
        "message": "Unlock your Personal Vault with your password to continue.",
    })


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


PERSONAL_LOG_MARK = "personal"     # vault_access_logs.loc on a Personal Vault row


def _log(db: Session, user: dict, action: str, cred_name: str, dept: str = "",
         cred_id: str = "", detail=None, loc: str = "") -> None:
    db.add(models.VaultAccessLog(
        id=str(uuid.uuid4()),
        actor_email=user["email"],
        actor_name=_display_name(user["email"], db),
        action=action,
        cred_id=cred_id,
        cred_name=cred_name,
        dept=dept,
        detail=detail,
        loc=loc,
        created_at=_now(),
    ))


def _notify(db: Session, *, type: str, recipient: str, title: str, body: str,
            ref_id: str = "", actor: str = "", action: dict | None = None) -> None:
    """Server-side bell notification (mirrors items.py). Empty recipient
    broadcasts to all managers - used for credential-change announcements.
    `actor` = who did it: their company is stamped on the row, so a broadcast
    obeys the company wall (unstamped = Global Admins only once it is armed).
    `action` = where the bell card opens ({view, sub}); the vault's subs are
    "approvals", "personal", "activity" and "cred-<id>" (the drawer)."""
    db.add(models.NexusNotification(
        id=str(uuid.uuid4()),
        type=type,
        recipient=recipient.lower() if recipient else "",
        title=title,
        body=body,
        ref_id=ref_id,
        item_name="",
        requested_by="",
        action=json.dumps(action) if action else "",
        actioned=False,
        read_by="",
        company=notification_company(db, actor, recipient),
        created_at=_now(),
    ))


def _get_cred(cred_id: str, db: Session, user: dict | None = None) -> models.VaultCredential:
    """With `user`, a credential on the other side of the company wall answers
    404 - existence must not leak across it (auth.assert_company)."""
    row = db.get(models.VaultCredential, cred_id)
    if not row:
        raise HTTPException(404, "Credential not found")
    if user is not None:
        scope, cmap = _owner_company_map(db, user)
        if not _in_company(row, scope, cmap):
            raise HTTPException(404, "Credential not found")
    return row


def _can_modify(cred: models.VaultCredential, user: dict, db: Session | None = None) -> bool:
    """The owner, the backup owner, the head or backup head of its department
    (Oct 29 2026, with `db`) - or an admin. Until Oct 14 2026 an admin could
    purge a credential from the trash but not edit, delete, recover or re-own
    it, so an entry whose owner had left could never be touched again."""
    email = user["email"]
    if (_is_admin(user)
            or email == (cred.owner_email or "").lower()
            or email == (cred.backup_owner_email or "").lower()):
        return True
    return db is not None and email in VA.heads_for(db, cred)


# Multi-company walls (auth.company_scope): a company credential belongs to its
# OWNER's company, derived from nexus_employees like Documents and the KB do
# rather than stamped - ownership can move (transfer, offboarding) and the
# credential must move with it. scope None = walls off or a Global Admin.
def _owner_company_map(db: Session, user: dict):
    scope = company_scope(user, db)
    return scope, (company_of_email_map(db) if scope is not None else {})


def _in_company(cred: models.VaultCredential, scope, cmap: dict) -> bool:
    return company_ok(cmap.get((cred.owner_email or "").lower(), ""), scope)


def _active_grant(cred_id: str, email: str, db: Session):
    now = _now()
    return (db.query(models.VaultAccessGrant)
            .filter(models.VaultAccessGrant.cred_id == cred_id,
                    models.VaultAccessGrant.granted_to == email,
                    models.VaultAccessGrant.expires_at > now)
            .first())


# ── Who may see a password (Neil, Oct 14 2026: department scope) ─────────────
# Everyone with the vault grant sees that a credential EXISTS (name, department,
# owner - enough to ask for it). The password itself is for: admins; the owner
# and backup owner; whoever holds a live grant; and, unless the tier is
# Critical, anyone in the credential's department. Everyone else sees
# "Request Access". Before this every grant holder could reveal everything that
# was not Critical, which made Request Access and Share mostly meaningless.
def _my_department(user: dict, db: Session) -> str:
    row = (db.query(models.NexusEmployee.department)
           .filter(func.lower(models.NexusEmployee.work_email) == user["email"]).first())
    return ((row.department if row else "") or "").strip().lower()


def _my_grants(user: dict, db: Session) -> dict:
    """{cred_id: expires_at} for the caller's live grants."""
    now = _now()
    rows = (db.query(models.VaultAccessGrant)
            .filter(models.VaultAccessGrant.granted_to == user["email"],
                    models.VaultAccessGrant.expires_at > now).all())
    return {g.cred_id: g.expires_at for g in rows}


MANAGE = ("admin", "owner", "backup", "head")
# What a row reports in `access`: the manage roles, then a live grant, then the
# audience that admits the person (vault_access.audience_access), else
# "view" (sees it, never the password) or "request".


def _access_for(c: models.VaultCredential, user: dict, ctx: dict, grants: dict,
                heads: set | None = None, rows: list | None = None) -> str:
    email = user["email"]
    if _is_admin(user):
        return "admin"
    if email == (c.owner_email or "").lower():
        return "owner"
    if email == (c.backup_owner_email or "").lower():
        return "backup"
    if heads and email in heads:
        return "head"
    if c.id in grants:
        return "shared"
    return VA.audience_access(c, rows or [], ctx) or "request"


def _access_ctx(user: dict, db: Session) -> tuple:
    return VA.person_ctx(db, user["email"]), _my_grants(user, db)


def _access_one(c: models.VaultCredential, user: dict, db: Session) -> str:
    ctx, grants = _access_ctx(user, db)
    return _access_for(c, user, ctx, grants, VA.heads_for(db, c), VA.rows_for(db, [c.id]).get(c.id, []))


def _can_reveal(c: models.VaultCredential, user: dict, db: Session) -> bool:
    return _access_one(c, user, db) not in ("request", "view")


def _cred_dict(c: models.VaultCredential, reused: bool, shared_with: int,
               access: str = "owner", grant_until: str = "", audiences: list | None = None) -> dict:
    can_reveal = access not in ("request", "view")
    # "view" (Oct 29 2026): the row, username, link and notes - never the password.
    can_see = access != "request"
    return {
        "id": c.id, "name": c.name, "dept": c.dept or "", "type": c.type or "Password",
        # The username is half of a login: only for people who can see the other half.
        "username": (c.username or "") if can_see else "",
        "url": c.url or "", "tier": c.tier or "Standard",
        "note": (c.note or "") if can_see else "",
        "owner": c.owner_email or "", "backupOwner": c.backup_owner_email or "",
        # Health and rotation facts say which passwords are weak, reused or
        # stale - exactly the list an attacker wants - so they stay with the
        # people who can open the credential.
        "strength": (c.strength or "strong") if can_reveal else "",
        "reused": reused if can_reveal else False,
        "rotatedAt": (c.rotated_at or "") if can_reveal else "",
        "rotatedDays": _days_since(c.rotated_at) if can_reveal else 0,
        "rotationMax": c.rotation_max or 90, "customExpiry": bool(c.custom_expiry),
        "expiresAt": (c.expires_at or "") if can_reveal else "",
        "expiresInDays": _days_until(c.expires_at) if can_reveal else None,
        "hasPrevious": bool(c.prev_secret_enc) if can_reveal else False,
        "prevRotatedAt": (c.prev_rotated_at or "") if can_reveal else "",
        "sharedWith": shared_with, "deletedAt": _ms(c.deleted_at) or None,
        "createdAt": _ms(c.created_at),
        "access": access, "canReveal": can_reveal, "canEdit": access in MANAGE,
        "grantUntil": _ms(grant_until) if grant_until else None,
        "audiences": audiences or [],
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
    note: str = ""
    expiresAt: str = ""          # YYYY-MM-DD hard expiry (API keys, certificates), "" = none
    # Who may open it (vault_access): [{kind, value, level}]. Omitted on an
    # edit = unchanged; omitted on a create = the credential's own department.
    audiences: list[dict] | None = None


def _clean_url(v: str) -> str:
    """A link is http(s) or nothing - a javascript: URL saved here would run in
    every colleague's browser from the drawer (review, Oct 14 2026)."""
    v = (v or "").strip()
    if not v:
        return ""
    if not re.match(r"^https?://", v, re.I):
        raise HTTPException(400, "The link must start with http:// or https://")
    return v


def _clean_date(v: str) -> str:
    v = (v or "").strip()[:10]
    if not v:
        return ""
    try:
        datetime.strptime(v, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "Expiry date must be a calendar date")
    return v


@router.get("/credentials")
def list_credentials(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Every credential on my side of the company wall, metadata only - secrets
    never leave the reveal endpoints. Each row says what access I have
    (_access_for); a row I can only ask for carries no username or notes.
    Trashed rows come only to the people who may recover them."""
    rows = db.query(models.VaultCredential).all()
    hash_counts: dict = {}
    for c in rows:
        if not c.deleted_at and c.secret_hash:
            hash_counts[c.secret_hash] = hash_counts.get(c.secret_hash, 0) + 1
    scope, cmap = _owner_company_map(db, user)
    if scope is not None:
        rows = [c for c in rows if _in_company(c, scope, cmap)]
    now = _now()
    grants = db.query(models.VaultAccessGrant).filter(models.VaultAccessGrant.expires_at > now).all()
    grant_counts: dict = {}
    for g in grants:
        grant_counts[g.cred_id] = grant_counts.get(g.cred_id, 0) + 1
    ctx, mine = _access_ctx(user, db)
    heads = VA.heads_map(db, rows)
    auds = VA.rows_for(db, [c.id for c in rows])
    out = []
    for c in rows:
        access = _access_for(c, user, ctx, mine, heads.get(c.id), auds.get(c.id))
        if c.deleted_at and access not in MANAGE:
            continue
        out.append(_cred_dict(
            c,
            reused=bool(not c.deleted_at and c.secret_hash and hash_counts.get(c.secret_hash, 0) > 1),
            shared_with=1 + grant_counts.get(c.id, 0),
            access=access, grant_until=mine.get(c.id, ""),
            audiences=VA.labels(db, auds.get(c.id, [])),
        ))
    return out


@router.get("/audience-options")
def audience_options(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Companies, departments and Access Groups the form can give a credential to."""
    return VA.options(db, company_scope(user, db))


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
        url=_clean_url(body.url),
        note=(body.note or "").strip(),
        expires_at=_clean_date(body.expiresAt),
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
    auds = VA.clean(body.audiences) if body.audiences is not None else ([{"kind": "department", "value": row.dept, "level": "open"}] if row.dept else [])
    VA.replace(db, row.id, auds, user["email"])
    _log(db, user, "Created", row.name, row.dept, row.id)
    # Only the backup owner is told (Oct 14 2026). Every add used to broadcast
    # to every manager's bell - noise nobody acted on; the activity log has it.
    if row.backup_owner_email and row.backup_owner_email != user["email"]:
        _notify(db, type="vault_change", recipient=row.backup_owner_email,
                title="Credentials - You Are a Backup Owner",
                body=f"{_display_name(user['email'], db)} added {row.name} ({row.dept}) and named you its backup owner.",
                ref_id=row.id, actor=user["email"], action={"view": "credvault", "sub": f"cred-{row.id}"})
    db.commit()
    return {"id": row.id, "ok": True}


@router.patch("/credentials/{cred_id}")
def update_credential(cred_id: str, body: CredentialIn,
                      user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    c = _get_cred(cred_id, db, user)
    if not _can_modify(c, user, db):
        raise HTTPException(403, "Only the owner, backup owner or an admin can edit this credential")
    changed = []
    if body.tier in TIERS and body.tier != (c.tier or "Standard"):
        changed.append({"field": "Tier", "from": c.tier or "Standard", "to": body.tier})
        c.tier = body.tier
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
    c.url = _clean_url(body.url)
    c.note = (body.note or "").strip()
    new_exp = _clean_date(body.expiresAt)
    if new_exp != (c.expires_at or ""):
        changed.append({"field": "Expires", "from": c.expires_at or "-", "to": new_exp or "-"})
        c.expires_at = new_exp
    c.rotation_max = body.rotationMax or c.rotation_max or 90
    c.custom_expiry = bool(body.customExpiry)
    # Empty secret = keep current password (never echoed back to the client).
    # A new one is a rotation: the old password is kept for one rotation so a
    # change that did not take on the other system can still be read back.
    if body.secret and _hash(body.secret) != c.secret_hash:
        changed.append({"field": "Password", "from": "••••••", "to": "••••••"})
        c.prev_secret_enc = c.secret_enc
        c.prev_rotated_at = _now()
        c.secret_enc = _enc(body.secret)
        c.secret_hash = _hash(body.secret)
        c.strength = _eval_strength(body.secret)
        c.breached = False
        c.rotated_at = _now()
    if body.audiences is not None:
        before = VA.labels(db, VA.rows_for(db, [c.id]).get(c.id, []))
        new = VA.clean(body.audiences)
        if [(a["kind"], a["value"], a["level"]) for a in before] != [(a["kind"], a["value"], a["level"]) for a in new]:
            VA.replace(db, c.id, new, user["email"])
            # autoflush is off: label the cleaned rows, not a re-query that cannot see them yet.
            after = VA.labels(db, [SimpleNamespace(**r) for r in new])
            changed.append({"field": "Who can open", "from": ", ".join(a["label"] for a in before) or "-",
                            "to": ", ".join(a["label"] for a in after) or "-"})
    _log(db, user, "Edited", c.name, c.dept, c.id, detail=changed or None)
    if any(d["field"] == "Password" for d in changed):
        # Everyone who can open it hears the password changed (Oct 29 2026) -
        # the bell says so and opens the credential; the password itself never
        # travels in a notification.
        rows = VA.rows_for(db, [c.id]).get(c.id, [])
        for who in VA.openers(db, c, rows) - {user["email"]}:
            _notify(db, type="vault_change", recipient=who,
                    title="Credentials - Password Changed",
                    body=f"{_display_name(user['email'], db)} changed the password for {c.name} ({c.dept}). Open it to copy the new one.",
                    ref_id=c.id, actor=user["email"], action={"view": "credvault", "sub": f"cred-{c.id}"})
    db.commit()
    return {"ok": True}


@router.delete("/credentials/{cred_id}")
def delete_credential(cred_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Soft delete → Trash."""
    c = _get_cred(cred_id, db, user)
    if not _can_modify(c, user, db):
        raise HTTPException(403, "Only the owner, backup owner or an admin can remove this credential")
    c.deleted_at = _now()
    c.deleted_by = user["email"]
    _log(db, user, "Removed", c.name, c.dept, c.id)
    for who in {(c.owner_email or "").lower(), (c.backup_owner_email or "").lower()} - {"", user["email"]}:
        _notify(db, type="vault_change", recipient=who,
                title="Credentials - Moved to the Trash",
                body=f"{_display_name(user['email'], db)} moved {c.name} ({c.dept}) to the trash. It can be recovered from there.",
                ref_id=c.id, actor=user["email"], action={"view": "credvault", "sub": "trash"})
    db.commit()
    return {"ok": True}


class BulkIds(BaseModel):
    ids: list[str] = []


@router.post("/credentials/bulk-delete")
def bulk_delete(body: BulkIds, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.query(models.VaultCredential).filter(models.VaultCredential.id.in_(body.ids or [])).all()
    scope, cmap = _owner_company_map(db, user)
    count = 0
    for c in rows:
        if _can_modify(c, user, db) and not c.deleted_at and _in_company(c, scope, cmap):
            c.deleted_at = _now()
            c.deleted_by = user["email"]
            count += 1
    if count:
        label = f"{count} credential{'' if count == 1 else 's'}"
        _log(db, user, "Removed", label, "-")
    db.commit()
    return {"deleted": count}


@router.post("/credentials/{cred_id}/restore")
def restore_credential(cred_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    c = _get_cred(cred_id, db, user)
    if not _can_modify(c, user, db):      # Oct 14 2026: anyone with the grant could recover anything
        raise HTTPException(403, "Only the owner, backup owner or an admin can recover this credential")
    if not c.deleted_at:
        raise HTTPException(400, "Credential is not in the trash")
    c.deleted_at = ""
    c.deleted_by = ""
    _log(db, user, "Recovered", c.name, c.dept, c.id)
    db.commit()
    return {"ok": True}


@router.delete("/credentials/{cred_id}/permanent")
def purge_credential(cred_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    c = _get_cred(cred_id, db, user)
    if not _can_modify(c, user, db):
        raise HTTPException(403, "Only the owner, backup owner or an admin can permanently delete this")
    if not c.deleted_at:
        raise HTTPException(400, "Move the credential to the trash first")
    db.delete(c)
    db.commit()
    return {"ok": True}


@router.post("/credentials/{cred_id}/reveal")
def reveal_credential(cred_id: str, user: dict = Depends(get_current_user),
                      _otp: dict = Depends(require_vault_otp), db: Session = Depends(get_db)):
    """The ONLY way a company secret leaves the server (besides grant reveal).
    Requires a fresh SMS/Email OTP verification (require_vault_otp). Critical
    tier: the owner, backup owner and admins read it; anyone else (without a
    live grant) gets an approval request instead, routed to the OWNER - who
    decides it, or an admin does (Neil, Oct 14 2026: "either"). Before this
    the request went to a Global Admin queue and the owner of a Critical entry
    could not read their own credential."""
    c = _get_cred(cred_id, db, user)
    if c.deleted_at:
        raise HTTPException(400, "Credential is in the trash")
    access = _access_one(c, user, db)
    if access in ("request", "view"):
        # The screen never calls reveal for a row it cannot read - it offers
        # Request Access (POST .../request) instead. Keep the gate anyway.
        raise HTTPException(403, {"code": "vault_access_required",
                                  "message": "Ask the owner for access to this credential."})
    out = {"secret": _dec(c.secret_enc)}
    if c.prev_secret_enc and access in MANAGE:
        try:
            out["previousSecret"] = _dec(c.prev_secret_enc)
            out["prevRotatedAt"] = c.prev_rotated_at or ""
        except HTTPException:
            pass            # an old row from another key: the current one still shows
    _log(db, user, "Revealed", c.name, c.dept, c.id)
    db.commit()
    return out


class RequestIn(BaseModel):
    durationMs: int = 14400000
    durationLabel: str = "4 Hours"


@router.post("/credentials/{cred_id}/request")
def request_access(cred_id: str, body: RequestIn,
                   user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Ask for a credential I cannot read. The owner (or an admin) decides on
    the Approvals tab; approval becomes a timed grant. One open request per
    person per credential - asking again just says it is still waiting."""
    c = _get_cred(cred_id, db, user)
    if c.deleted_at:
        raise HTTPException(400, "Credential is in the trash")
    if _can_reveal(c, user, db):
        raise HTTPException(400, "You can already open this credential")
    open_req = (db.query(models.VaultShareRequest)
                .filter(models.VaultShareRequest.cred_id == c.id,
                        models.VaultShareRequest.requested_by_email == user["email"],
                        models.VaultShareRequest.shared_to_email == user["email"],
                        models.VaultShareRequest.status == "pending").first())
    if open_req:
        return {"requested": True, "pending": True}
    owner = (c.owner_email or "").lower()
    duration_ms = max(60000, min(body.durationMs or 14400000, 7 * 86400000))
    db.add(models.VaultShareRequest(
        id=str(uuid.uuid4()), cred_id=c.id,
        requested_by_email=user["email"], shared_to_email=user["email"],
        owner_email=owner, duration_ms=duration_ms, duration_label=body.durationLabel or "4 Hours",
        status="pending", created_at=_now(),
    ))
    _log(db, user, "Requested", c.name, c.dept, c.id)
    for who in {owner, (c.backup_owner_email or "").lower()} - {""}:
        _notify(db, type="vault_access", recipient=who,
                title="Credentials - Access Request",
                body=f"{_display_name(user['email'], db)} asked for {body.durationLabel or '4 Hours'} of access to "
                     f"{c.name} ({c.dept}). Approve or deny it on the Approvals tab.",
                ref_id=c.id, actor=user["email"], action={"view": "credvault", "sub": "approvals"})
    db.commit()
    return {"requested": True}


@router.post("/credentials/{cred_id}/copied")
def log_copied(cred_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    c = _get_cred(cred_id, db, user)
    _log(db, user, "Copied", c.name, c.dept, c.id)
    db.commit()
    return {"ok": True}


class ImportIn(BaseModel):
    rows: list[dict] = []


@router.post("/import")
def import_credentials(body: ImportIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Rows from the import wizard (Oct 29 2026: an Excel sheet, mapped on
    screen). Each row may carry `backupOwner` and `audiences`; a row the vault
    already holds (same name and username, live) is skipped, not doubled. The
    importer owns every row. Returns what was imported and what was skipped."""
    _require_write(user, db)
    live = {(c.name.strip().lower(), (c.username or "").strip().lower()) for c in db.query(models.VaultCredential)
            .filter(models.VaultCredential.deleted_at == "").all()}
    known = {e for (e,) in db.query(models.NexusEmployee.work_email).all() if e}
    known = {e.lower() for e in known}
    created, skipped = [], []
    for r in body.rows or []:
        name = (r.get("name") or "").strip()
        secret = r.get("secret") or ""
        username = (r.get("username") or "").strip()
        if not name or not secret:
            continue
        if (name.lower(), username.lower() if username else "") in live:
            skipped.append(name)
            continue
        backup = (r.get("backupOwner") or "").lower().strip()
        row = models.VaultCredential(
            id=str(uuid.uuid4()),
            name=name,
            dept=(r.get("department") or "").strip(),
            type=r.get("type") if r.get("type") in TYPES else "Password",
            username=username or "-",
            url=(r.get("url") or "").strip() if re.match(r"^https?://", (r.get("url") or "").strip(), re.I) else "",
            note=(r.get("note") or r.get("notes") or "").strip(),
            secret_enc=_enc(secret),
            secret_hash=_hash(secret),
            tier=r.get("tier") if r.get("tier") in TIERS else "Standard",
            owner_email=user["email"],
            backup_owner_email=backup if backup in known and backup != user["email"] else "",
            strength=_eval_strength(secret),
            rotated_at=_now(),
            created_at=_now(),
            created_by=user["email"],
        )
        db.add(row)
        auds = VA.clean(r.get("audiences")) if r.get("audiences") is not None else ([{"kind": "department", "value": row.dept, "level": "open"}] if row.dept else [])
        VA.replace(db, row.id, auds, user["email"])
        live.add((name.lower(), username.lower() if username else ""))
        created.append(name)
    if created:
        _log(db, user, "Imported", f"{len(created)} credentials", "-", detail=[{"field": "Names", "from": "", "to": ", ".join(created[:20]) + (" …" if len(created) > 20 else "")}])
    db.commit()
    return {"imported": len(created), "skipped": len(skipped), "skippedNames": skipped}


# ── Ownership ────────────────────────────────────────────────────────────────
def _transfer(db: Session, user: dict, c: models.VaultCredential, new_owner: str, note: str = "") -> None:
    """Move a credential to `new_owner`: logged with the from/to, the new owner
    is told, and they stop being the backup owner if they were."""
    old = (c.owner_email or "").lower()
    detail = [{"field": "Owner", "from": old or "-", "to": new_owner}]
    if (c.backup_owner_email or "").lower() == new_owner:
        detail.append({"field": "Backup owner", "from": new_owner, "to": "-"})
        c.backup_owner_email = ""
    c.owner_email = new_owner
    _log(db, user, "Transferred", c.name, c.dept, c.id, detail=detail)
    _notify(db, type="vault_change", recipient=new_owner,
            title="Credentials - You Are Now the Owner",
            body=f"{c.name} ({c.dept}) is now yours{note}. You approve its access requests and keep it rotated.",
            ref_id=c.id, actor=user["email"], action={"view": "credvault", "sub": f"cred-{c.id}"})


class TransferIn(BaseModel):
    ownerEmail: str = ""


@router.post("/credentials/{cred_id}/transfer")
def transfer_credential(cred_id: str, body: TransferIn,
                        user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Hand a credential to a new owner - by the owner, backup owner or an admin.
    The new owner must be someone in Nexus People (the curated list every
    people picker uses)."""
    c = _get_cred(cred_id, db, user)
    if not _can_modify(c, user, db):
        raise HTTPException(403, "Only the owner, backup owner or an admin can transfer this credential")
    new_owner = (body.ownerEmail or "").lower().strip()
    if "@" not in new_owner or "." not in new_owner:
        raise HTTPException(400, "Pick who the new owner is")
    if new_owner == (c.owner_email or "").lower():
        raise HTTPException(400, "That person already owns this credential")
    known = (db.query(models.NexusEmployee.id)
             .filter(func.lower(models.NexusEmployee.work_email) == new_owner).first())
    if not known:
        raise HTTPException(400, "The new owner must be someone in Nexus People")
    _transfer(db, user, c, new_owner)
    db.commit()
    return {"ok": True, "owner": new_owner}


def handover_person(db: Session, email: str, to_email: str, actor: str = "") -> dict:
    """HR offboarding (hr.apply_status_change, Oct 14 2026): the leaver's company
    credentials move to `to_email` - the same person their tasks went to - they
    stop being anyone's backup owner, the shared access they held ends now, and
    their pending requests are closed. Their Personal Vault is left alone:
    nobody else may read it, so there is nothing to hand over. Runs inside the
    status change's session and does not commit."""
    leaver = (email or "").strip().lower()
    heir = (to_email or "").strip().lower()
    user = {"email": (actor or "system").lower(), "level": 4}
    out = {"credentials": 0, "backups": 0, "grants": 0, "requests": 0, "to": heir}
    if not leaver:
        return out
    if heir and heir != leaver:
        for c in (db.query(models.VaultCredential)
                  .filter(func.lower(models.VaultCredential.owner_email) == leaver).all()):
            _transfer(db, user, c, heir, note=" - its previous owner has left")
            out["credentials"] += 1
    for c in (db.query(models.VaultCredential)
              .filter(func.lower(models.VaultCredential.backup_owner_email) == leaver).all()):
        c.backup_owner_email = ""
        out["backups"] += 1
    now = _now()
    for g in (db.query(models.VaultAccessGrant)
              .filter(models.VaultAccessGrant.granted_to == leaver,
                      models.VaultAccessGrant.expires_at > now).all()):
        g.expires_at = now
        out["grants"] += 1
    db.query(models.VaultCredentialAudience).filter(models.VaultCredentialAudience.kind == "person",
                                                     func.lower(models.VaultCredentialAudience.value) == leaver).delete(synchronize_session=False)
    for r in (db.query(models.VaultShareRequest)
              .filter(models.VaultShareRequest.status == "pending",
                      (models.VaultShareRequest.requested_by_email == leaver)
                      | (models.VaultShareRequest.shared_to_email == leaver)).all()):
        r.status, r.decided_at, r.decided_by = "denied", now, user["email"]
        out["requests"] += 1
    if any(out[k] for k in ("credentials", "backups", "grants", "requests")):
        _log(db, user, "Offboarded", leaver, "-", detail=[
            {"field": k, "from": "", "to": str(out[k])} for k in ("credentials", "backups", "grants", "requests") if out[k]])
    return out


# ── Sharing / approvals / grants ─────────────────────────────────────────────
class ShareIn(BaseModel):
    recipientEmail: str = ""
    durationMs: int = 14400000
    durationLabel: str = "4 Hours"


@router.post("/credentials/{cred_id}/share")
def share_credential(cred_id: str, body: ShareIn, user: dict = Depends(get_current_user),
                     _otp: dict = Depends(require_vault_otp), db: Session = Depends(get_db)):
    """Owner, backup owner or admin gives someone timed access (Neil, Oct 14
    2026: Share is for owners; anyone else asks with .../request). Requires a
    fresh SMS/Email OTP verification (require_vault_otp), same as reveal -
    sharing a secret is as sensitive as viewing it. The recipient still needs
    the vault grant to open the screen."""
    c = _get_cred(cred_id, db, user)
    if c.deleted_at:
        raise HTTPException(400, "Credential is in the trash")
    if not _can_modify(c, user, db):
        raise HTTPException(403, "Only the owner, backup owner or an admin can share this credential")
    recipient = (body.recipientEmail or "").lower().strip()
    if "@" not in recipient or "." not in recipient:
        raise HTTPException(400, "A valid recipient email address is required")
    if not (db.query(models.NexusEmployee.id)
            .filter(func.lower(models.NexusEmployee.work_email) == recipient).first()):
        raise HTTPException(400, "Share with someone in Nexus People")
    duration_ms = max(60000, min(body.durationMs or 3600000, 7 * 86400000))
    expires = (datetime.now(timezone.utc) + timedelta(milliseconds=duration_ms)).isoformat()
    db.add(models.VaultAccessGrant(
        id=str(uuid.uuid4()), cred_id=c.id, granted_to=recipient,
        granted_by=user["email"], granted_at=_now(), expires_at=expires,
    ))
    _log(db, user, "Shared", c.name, c.dept, c.id, detail=[{"field": "With", "from": "", "to": recipient},
                                                            {"field": "For", "from": "", "to": body.durationLabel or ""}])
    _notify(db, type="vault_access", recipient=recipient,
            title="Credentials - Access Granted",
            body=f"{_display_name(user['email'], db)} shared {c.name} with you for {body.durationLabel}. Open Credentials to view it.",
            ref_id=c.id, actor=user["email"], action={"view": "credvault", "sub": f"cred-{c.id}"})
    db.commit()
    return {"granted": True}


@router.get("/requests")
def list_requests(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Pending requests I may decide: those addressed to me as the owner, and
    every one of them when I'm an admin (owner or admin - either - decides;
    the legacy admin-only queue has owner_email empty)."""
    q = db.query(models.VaultShareRequest).filter(models.VaultShareRequest.status == "pending")
    rows = q.all()
    out = []
    creds = {c.id: c for c in db.query(models.VaultCredential).all()}
    scope, cmap = _owner_company_map(db, user)
    for r in rows:
        c = creds.get(r.cred_id)
        if not _may_decide(r, c, user, db):
            continue
        if c and not _in_company(c, scope, cmap):
            continue
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


def _may_decide(r: models.VaultShareRequest, c, user: dict, db: Session) -> bool:
    """Owner or admin (Neil: "either") - and the backup owner, who stands in for
    the owner everywhere else in this file. Legacy admin-queue rows (no owner)
    and rows whose credential is gone: owner_email match or admin."""
    if _is_admin(user) or r.owner_email == user["email"]:
        return True
    return bool(c) and _can_modify(c, user, db)


def _decide_request(req_id: str, user: dict, db: Session) -> models.VaultShareRequest:
    r = db.get(models.VaultShareRequest, req_id)
    if not r or r.status != "pending":
        raise HTTPException(404, "Request not found or already decided")
    c = db.get(models.VaultCredential, r.cred_id)
    if c is not None:
        _get_cred(c.id, db, user)       # 404 across the company wall
    if not _may_decide(r, c, user, db):
        raise HTTPException(403, "Only the credential's owner, backup owner or an admin can decide this")
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
    _log(db, user, "Shared", c.name, c.dept, c.id, detail=[{"field": "With", "from": "", "to": recipient},
                                                            {"field": "For", "from": "", "to": r.duration_label or ""}])
    _notify(db, type="vault_access", recipient=recipient,
            title="Credentials - Access Approved",
            body=f"{_display_name(user['email'], db)} approved {r.duration_label or 'temporary'} access to {c.name}. Open Credentials to view it.",
            ref_id=c.id, actor=user["email"], action={"view": "credvault", "sub": f"cred-{c.id}"})
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
    if c and r.requested_by_email:
        _notify(db, type="vault_access", recipient=r.requested_by_email,
                title="Credentials - Access Declined",
                body=f"{_display_name(user['email'], db)} declined your request for {c.name} ({c.dept}).",
                ref_id=c.id, actor=user["email"], action={"view": "credvault", "sub": f"cred-{c.id}"})
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
        "dept": creds[g.cred_id].dept if g.cred_id in creds else "",
        "grantedBy": _display_name(g.granted_by, db), "grantedByEmail": g.granted_by,
        "grantedAt": _ms(g.granted_at), "expiresAt": _ms(g.expires_at),
    } for g in rows]


@router.get("/credentials/{cred_id}/access")
def credential_access(cred_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Who can open this credential right now - for the drawer's Access
    section. Owners, backup owners and admins see the live grants with their
    expiry; everyone else just gets the owners."""
    c = _get_cred(cred_id, db, user)
    out = {"owner": c.owner_email or "", "backupOwner": c.backup_owner_email or "",
           "dept": c.dept or "", "tier": c.tier or "Standard", "grants": [], "pending": [],
           "heads": sorted(VA.heads_for(db, c)), "audiences": VA.labels(db, VA.rows_for(db, [c.id]).get(c.id, []))}
    if not _can_modify(c, user, db):
        return out
    now = _now()
    for g in (db.query(models.VaultAccessGrant)
              .filter(models.VaultAccessGrant.cred_id == c.id, models.VaultAccessGrant.expires_at > now)
              .order_by(models.VaultAccessGrant.expires_at).all()):
        out["grants"].append({"id": g.id, "email": g.granted_to, "name": _display_name(g.granted_to, db),
                              "grantedBy": _display_name(g.granted_by, db),
                              "grantedAt": _ms(g.granted_at), "expiresAt": _ms(g.expires_at)})
    for r in (db.query(models.VaultShareRequest)
              .filter(models.VaultShareRequest.cred_id == c.id, models.VaultShareRequest.status == "pending").all()):
        out["pending"].append({"id": r.id, "email": r.shared_to_email or r.requested_by_email,
                               "name": _display_name(r.shared_to_email or r.requested_by_email, db),
                               "duration": r.duration_label or "", "ts": _ms(r.created_at)})
    return out


@router.delete("/grants/{grant_id}")
def revoke_grant(grant_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """End someone's shared access early - owner, backup owner or admin."""
    g = db.get(models.VaultAccessGrant, grant_id)
    if not g:
        raise HTTPException(404, "Grant not found")
    c = _get_cred(g.cred_id, db, user)
    if not _can_modify(c, user, db):
        raise HTTPException(403, "Only the owner, backup owner or an admin can end this access")
    g.expires_at = _now()
    _log(db, user, "Revoked", c.name, c.dept, c.id, detail=[{"field": "Person", "from": "", "to": g.granted_to}])
    db.commit()
    return {"ok": True}


@router.post("/grants/{grant_id}/reveal")
def reveal_grant(grant_id: str, user: dict = Depends(get_current_user),
                 _otp: dict = Depends(require_vault_otp), db: Session = Depends(get_db)):
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
    """The activity log, newest first. A Personal Vault row (loc PERSONAL_LOG_MARK)
    is shown to its actor only - the names of someone's private credentials
    are nobody else's business, admins included (Oct 14 2026: they used to be
    listed for every grant holder). Company walls: a row follows its
    credential's owner, or the actor when it has no credential."""
    rows = (db.query(models.VaultAccessLog)
            .order_by(models.VaultAccessLog.created_at.desc())
            .limit(500).all())
    scope, cmap = _owner_company_map(db, user)
    creds = db.query(models.VaultCredential).all()
    owners = {c.id: (c.owner_email or "").lower() for c in creds} if scope is not None else {}
    # Oct 29 2026: an employee used to see every reveal in the company - who
    # opened the bank portal, and when. Now: admins see everything; everyone
    # else sees their own actions and every action on a credential they
    # manage (owner, backup owner, department head).
    if _is_admin(user):
        managed = None
    else:
        heads = VA.heads_map(db, creds)
        managed = {c.id for c in creds if _can_modify(c, user) or user["email"] in heads.get(c.id, set())}
    out = []
    for r in rows:
        if r.loc == PERSONAL_LOG_MARK and r.actor_email != user["email"]:
            continue
        if managed is not None and r.actor_email != user["email"] and r.cred_id not in managed:
            continue
        if scope is not None:
            who = owners.get(r.cred_id) if r.cred_id and r.cred_id in owners else (r.actor_email or "").lower()
            if not company_ok(cmap.get(who, ""), scope):
                continue
        out.append({
            "id": r.id, "actor": r.actor_name or r.actor_email, "actorEmail": r.actor_email,
            "action": r.action, "cred": r.cred_name, "credId": r.cred_id,
            "dept": r.dept or "-", "loc": r.loc or "", "detail": r.detail,
            "ts": _ms(r.created_at),
        })
    return out


# ── SMS / Email OTP - gates company reveal/share (see require_vault_otp) ─────
class OtpRequestIn(BaseModel):
    channel: str = "email"   # sms | email


class OtpVerifyIn(BaseModel):
    challengeId: str = ""
    code: str = ""


@router.get("/otp/targets")
def otp_targets(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Which channels are available for THIS user, with masked destinations,
    so the frontend can show "Text •••• 4821" instead of asking blind."""
    emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == user["email"]).first()
    phone = (emp.phone if emp else "").strip()
    return {
        "email": {"available": True, "masked": _mask_email(user["email"])},
        "sms": {"available": bool(phone), "masked": _mask_phone(phone) if phone else ""},
    }


@router.get("/otp/status")
def otp_status(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Is my identity check still good, and until when - the header's
    "Verified until 2:45 PM" chip, so nobody wonders whether the next reveal
    will ask for a code."""
    row = (db.query(models.VaultOtpSession)
           .filter(models.VaultOtpSession.email == user["email"], models.VaultOtpSession.purpose == "reveal_share",
                   models.VaultOtpSession.expires_at > _now())
           .order_by(models.VaultOtpSession.expires_at.desc()).first())
    return {"verified": bool(row), "until": _ms(row.expires_at) if row else None,
            "windowSec": _otp_ttl(db)}


@router.post("/otp/request")
def otp_request(body: OtpRequestIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    channel = body.channel if body.channel in ("sms", "email") else "email"
    return _create_otp_challenge(db, user["email"], "reveal_share", channel)


@router.post("/otp/verify")
def otp_verify(body: OtpVerifyIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    ch = _consume_otp_challenge(db, body.challengeId, user["email"], "reveal_share", body.code)
    ttl = _otp_ttl(db)
    sess = models.VaultOtpSession(
        id=str(uuid.uuid4()), email=user["email"], purpose=ch.purpose, channel=ch.channel,
        expires_at=(datetime.now(timezone.utc) + timedelta(seconds=ttl)).isoformat(),
        created_at=_now(),
    )
    db.add(sess)
    db.commit()
    return {"ok": True, "expiresInSec": ttl}


# ── Personal vault (strictly owner-scoped - no admin bypass) ─────────────────
# 10 characters (Oct 29 2026, was 6): the password is tried online, and the
# lock routes now sit on the tight per-IP limit (middleware_hardening
# SENSITIVE_PREFIXES) - an existing shorter password keeps working.
PERSONAL_MIN_LEN = 10
class PersonalAuthIn(BaseModel):
    password: str = ""


class PersonalResetIn(BaseModel):
    challengeId: str = ""
    code: str = ""
    newPassword: str = ""


def _open_personal_unlock(db: Session, email: str) -> int:
    """Opens the unlock window and returns its length in seconds."""
    ttl = _personal_ttl(db)
    db.add(models.VaultPersonalUnlockSession(
        id=str(uuid.uuid4()), email=email,
        expires_at=(datetime.now(timezone.utc) + timedelta(seconds=ttl)).isoformat(),
        created_at=_now(),
    ))
    return ttl


@router.get("/personal/lock/status")
def personal_lock_status(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.get(models.VaultPersonalAuth, user["email"])
    return {"hasPassword": bool(row and row.password_hash)}


@router.post("/personal/lock/setup")
def personal_lock_setup(body: PersonalAuthIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """First-time setup only - no OTP needed, the user is already signed into
    Nexus. Resetting a forgotten password goes through /personal/lock/reset
    instead (OTP-verified)."""
    if len((body.password or "").strip()) < PERSONAL_MIN_LEN:
        raise HTTPException(400, f"Password must be at least {PERSONAL_MIN_LEN} characters")
    row = db.get(models.VaultPersonalAuth, user["email"])
    if row and row.password_hash:
        raise HTTPException(400, "A Personal Vault password is already set - use Forgot password to reset it.")
    if not row:
        row = models.VaultPersonalAuth(email=user["email"])
        db.add(row)
    row.password_hash = _hash_password(body.password.strip())
    row.updated_at = _now()
    ttl = _open_personal_unlock(db, user["email"])
    db.commit()
    return {"ok": True, "expiresInSec": ttl}


@router.post("/personal/lock/verify")
def personal_lock_verify(body: PersonalAuthIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.get(models.VaultPersonalAuth, user["email"])
    if not row or not row.password_hash:
        raise HTTPException(400, "No Personal Vault password set yet")
    if not _verify_password(body.password or "", row.password_hash):
        raise HTTPException(401, "Incorrect password")
    ttl = _open_personal_unlock(db, user["email"])
    db.commit()
    return {"ok": True, "expiresInSec": ttl}


@router.post("/personal/lock/forgot")
def personal_lock_forgot(body: OtpRequestIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.get(models.VaultPersonalAuth, user["email"])
    if not row or not row.password_hash:
        raise HTTPException(400, "No Personal Vault password set yet - nothing to reset")
    channel = body.channel if body.channel in ("sms", "email") else "email"
    return _create_otp_challenge(db, user["email"], "personal_reset", channel)


@router.post("/personal/lock/reset")
def personal_lock_reset(body: PersonalResetIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if len((body.newPassword or "").strip()) < PERSONAL_MIN_LEN:
        raise HTTPException(400, f"Password must be at least {PERSONAL_MIN_LEN} characters")
    _consume_otp_challenge(db, body.challengeId, user["email"], "personal_reset", body.code)
    row = db.get(models.VaultPersonalAuth, user["email"])
    if not row:
        row = models.VaultPersonalAuth(email=user["email"])
        db.add(row)
    row.password_hash = _hash_password(body.newPassword.strip())
    row.updated_at = _now()
    ttl = _open_personal_unlock(db, user["email"])
    db.commit()
    return {"ok": True, "expiresInSec": ttl}


class PersonalIn(BaseModel):
    name: str = ""
    username: str = ""
    secret: str = ""
    type: str = "Password"
    note: str = ""
    url: str = ""


@router.get("/personal")
def list_personal(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (db.query(models.VaultPersonalCredential)
            .filter(models.VaultPersonalCredential.owner_email == user["email"])
            .order_by(models.VaultPersonalCredential.created_at.desc())
            .all())
    return [{
        "id": r.id, "name": r.name, "username": r.username or "-",
        "type": r.type or "Password", "note": r.note or "", "url": r.url or "",
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
        url=_clean_url(body.url),
        secret_enc=_enc(body.secret),
        strength=_eval_strength(body.secret),
        created_at=_now(),
    )
    db.add(row)
    db.commit()
    return {"id": row.id, "ok": True}


@router.patch("/personal/{pid}")
def update_personal(pid: str, body: PersonalIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Owner-only edit; an empty secret keeps the current one."""
    row = db.get(models.VaultPersonalCredential, pid)
    if not row or row.owner_email != user["email"]:
        raise HTTPException(404, "Not found")
    if not body.name.strip():
        raise HTTPException(400, "Name is required")
    row.name = body.name.strip()
    row.username = body.username.strip() or "-"
    row.type = body.type if body.type in TYPES else row.type
    row.note = body.note.strip()
    row.url = _clean_url(body.url)
    if body.secret:
        row.secret_enc = _enc(body.secret)
        row.strength = _eval_strength(body.secret)
    db.commit()
    return {"ok": True}


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
                    _pu: dict = Depends(require_personal_unlock), db: Session = Depends(get_db)):
    row = db.get(models.VaultPersonalCredential, pid)
    if not row or row.owner_email != user["email"]:
        raise HTTPException(404, "Not found")
    # Audited like company reveals, but list_logs shows the row to its actor only.
    _log(db, user, "Revealed", row.name, PERSONAL_DEPT, pid, loc=PERSONAL_LOG_MARK)
    db.commit()
    return {"secret": _dec(row.secret_enc)}


# ── Daily rotation / expiry reminders (reminders.reminders_loop) ──────────────
ROTATION_WARN_DAYS = 10
EXPIRY_WARN_DAYS = 30


def _reminded_today(db: Session, ntype: str, ref_id: str, recipient: str) -> bool:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return (db.query(models.NexusNotification.id)
            .filter(models.NexusNotification.type == ntype, models.NexusNotification.ref_id == ref_id,
                    models.NexusNotification.recipient == recipient,
                    models.NexusNotification.created_at.like(f"{today}%")).first()) is not None


def rotation_reminders(db: Session) -> int:
    """One bell per owner (and backup owner) per day for every live credential
    whose rotation is due within ROTATION_WARN_DAYS or overdue, and for a hard
    expiry within EXPIRY_WARN_DAYS. Opens the credential's drawer. Commits."""
    sent = 0
    for c in db.query(models.VaultCredential).filter(models.VaultCredential.deleted_at == "").all():
        left = (c.rotation_max or 90) - _days_since(c.rotated_at) if c.rotated_at else None
        exp = _days_until(c.expires_at)
        lines = []
        if left is not None and left <= ROTATION_WARN_DAYS:
            lines.append("its password rotation is overdue" if left < 0 else
                         "its password rotation is due today" if left == 0 else
                         f"its password rotation is due in {left} day{'s' if left != 1 else ''}")
        if exp is not None and exp <= EXPIRY_WARN_DAYS:
            lines.append("it has expired" if exp < 0 else "it expires today" if exp == 0 else
                         f"it expires in {exp} day{'s' if exp != 1 else ''}")
        if not lines:
            continue
        for who in {(c.owner_email or "").lower(), (c.backup_owner_email or "").lower()} - {""}:
            if _reminded_today(db, "vault_rotation", c.id, who):
                continue
            _notify(db, type="vault_rotation", recipient=who,
                    title="Credentials - Rotation Due" if "rotation" in lines[0] else "Credential Vault - Expiring",
                    body=f"{c.name} ({c.dept}): " + " and ".join(lines) + ". Open it to rotate the password.",
                    ref_id=c.id, actor=c.owner_email or who, action={"view": "credvault", "sub": f"cred-{c.id}"})
            sent += 1
    if sent:
        db.commit()
    return sent


def run_daily_rotation_reminders() -> int:
    """Own session + commit, called from reminders_loop in a thread."""
    if job_switch.off("credvault_rotation"):   # Workflows > Automations switch
        return 0
    from database import SessionLocal
    db = SessionLocal()
    try:
        n = rotation_reminders(db)
        if n:
            print(f"[reminders] credential vault: {n} rotation/expiry reminder(s)")
        return n
    finally:
        db.close()
