"""Passwordless authentication for EXTERNAL users (Aug 18, approved by Visesh).

Replaces the Microsoft B2B redemption as the primary external flow. Two paths,
both PUBLIC (no bearer - the emailed link / the code IS the credential), both
ending in the exact same BFF session cookie employees get:

1. Activation (first time): enrolling an external emails them a branded Nexus
   invitation with a single-use 7-day activation link. The page validates the
   token (proof of inbox ownership), optionally verifies a phone by 6-digit
   SMS code via sent.dm (doubles as a second factor and enables SMS login
   later), or falls back to an emailed 6-digit code, then mints the session.
2. Returning sign-in ("Partner Sign-In" on the login page): email -> 6-digit
   code (SMS to the verified phone via sent.dm, else email) -> session.

AUTHORIZATION IS UNCHANGED: this module only authenticates. Every request
still passes auth.apply_external_policy (active allowlist row, employee-level
cap, grant-derived path gate), so a deactivated guest with a live cookie is
still shut out - and deactivate/remove also calls revoke_credentials() here to
kill outstanding codes AND server sessions immediately.

Security posture (enforced via the external_login_codes table, because
in-memory counters do not cross gunicorn's worker processes):
- codes/tokens hashed at rest, single-use, short-lived; never logged
- new code invalidates prior ones; 5 failed verifies kills the code and locks
  the email for 15 minutes; max 5 code requests per email AND per IP per hour;
  30s resend throttle
- request-code always answers the same generic 200 (no account enumeration)
- audit rows for invite sent / activated / login success / lockout

All endpoints are sync `def`s - FastAPI runs them on the threadpool, so the
outbound sent.dm / Graph HTTP never sits on the async event loop.
"""
import hashlib
import os
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional
from sqlalchemy import func

import bff_session as bff
import graph_mail
import sentdm
from app_url import app_url
from database import SessionLocal
from models import AuditLog, ExternalLoginCode, NexusEmployee

router = APIRouter(prefix="/external-auth", tags=["External Auth"])

_EXTERNAL_TYPES = ("guest", "external")

CODE_TTL_MIN = 10
INVITE_TTL_DAYS = 7
MAX_ATTEMPTS = 5           # failed verifies per code, then lockout
LOCKOUT_MIN = 15
MAX_REQUESTS_PER_HOUR = 5  # per email AND per IP
RESEND_THROTTLE_S = 30

# The one answer /request-code ever gives - identical for unknown emails,
# deactivated rows, rate-limited callers, and delivery failures alike.
GENERIC_MSG = "If this account exists, a sign-in code was sent to the contact on file."


def _now_dt() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None = None) -> str:
    return (dt or _now_dt()).isoformat()


def _client_ip(request: Request) -> str:
    fwd = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    return fwd or (request.client.host if request.client else "")


def _audit(db, email: str, action: str, details: str, ip: str) -> None:
    """Best-effort audit row. NEVER receives a code or token - callers pass
    only event facts."""
    try:
        db.add(AuditLog(timestamp=_iso(), user_email=email, user_role="external",
                        action=action, resource_type="external_auth",
                        resource_id=email, details=details, ip_address=ip))
        db.commit()
    except Exception:
        db.rollback()


# ── hashing ──────────────────────────────────────────────────────────────────

def _hash_token(token: str) -> str:
    """Invite tokens carry 48 random bytes - plain sha256 is fine and lets the
    lookup be a direct hash-equality query."""
    return hashlib.sha256(token.encode()).hexdigest()


def _hash_code(code: str, salt: str | None = None) -> str:
    """6-digit codes are low-entropy, so each gets its own salt: 'salt$hex'."""
    salt = salt or secrets.token_hex(16)
    return f"{salt}${hashlib.sha256((salt + code).encode()).hexdigest()}"


def _code_matches(code: str, stored: str) -> bool:
    salt, _, digest = (stored or "").partition("$")
    if not digest:
        return False
    return secrets.compare_digest(
        hashlib.sha256((salt + code).encode()).hexdigest(), digest)


# ── row helpers ──────────────────────────────────────────────────────────────

def _active_external(db, email: str) -> NexusEmployee | None:
    """The ACTIVE, unexpired guest/external row for this email - the only
    identities this whole module will mint credentials for."""
    email = (email or "").lower().strip()
    if not email:
        return None
    emp = (db.query(NexusEmployee)
           .filter(func.lower(NexusEmployee.work_email) == email,
                   NexusEmployee.identity_type.in_(_EXTERNAL_TYPES)).first())
    if not emp or (emp.status or "active") != "active":
        return None
    exp = (getattr(emp, "expires_at", "") or "").strip()
    if exp and exp[:10] < _now_dt().date().isoformat():
        return None
    return emp


def _invalidate_codes(db, email: str, purposes: tuple = ("activate", "login")) -> None:
    (db.query(ExternalLoginCode)
     .filter(ExternalLoginCode.email == email,
             ExternalLoginCode.purpose.in_(purposes),
             ExternalLoginCode.consumed_at == "")
     .update({"consumed_at": _iso()}, synchronize_session=False))


def _locked_out(db, email: str) -> bool:
    """True while a code that hit MAX_ATTEMPTS was killed within LOCKOUT_MIN."""
    cutoff = _iso(_now_dt() - timedelta(minutes=LOCKOUT_MIN))
    return bool(db.query(ExternalLoginCode)
                .filter(ExternalLoginCode.email == email,
                        ExternalLoginCode.attempts >= MAX_ATTEMPTS,
                        ExternalLoginCode.consumed_at > cutoff).first())


def _rate_limited(db, email: str, ip: str) -> bool:
    """DB-count limits (cross-worker): per-email and per-IP hourly caps plus
    the 30s resend throttle. Invite TOKENS are excluded - those are minted by
    admin actions, not by the anonymous endpoints this protects."""
    hour_ago = _iso(_now_dt() - timedelta(hours=1))
    q = db.query(ExternalLoginCode).filter(
        ExternalLoginCode.purpose.in_(("activate", "login")),
        ExternalLoginCode.created_at > hour_ago)
    if q.filter(ExternalLoginCode.email == email).count() >= MAX_REQUESTS_PER_HOUR:
        return True
    if ip and q.filter(ExternalLoginCode.created_ip == ip).count() >= MAX_REQUESTS_PER_HOUR:
        return True
    throttle = _iso(_now_dt() - timedelta(seconds=RESEND_THROTTLE_S))
    recent = (db.query(ExternalLoginCode)
              .filter(ExternalLoginCode.email == email,
                      ExternalLoginCode.purpose.in_(("activate", "login")),
                      ExternalLoginCode.created_at > throttle).first())
    return bool(recent)


def _issue_code(db, email: str, purpose: str, channel: str, ip: str) -> str:
    """Mint a fresh 6-digit code, invalidating any prior live ones. Returns the
    PLAINTEXT once, for delivery only - it is never stored or logged."""
    code = f"{secrets.randbelow(1_000_000):06d}"
    _invalidate_codes(db, email)
    db.add(ExternalLoginCode(
        id=str(uuid.uuid4()), email=email, code_hash=_hash_code(code),
        purpose=purpose, channel=channel,
        expires_at=_iso(_now_dt() + timedelta(minutes=CODE_TTL_MIN)),
        attempts=0, created_ip=ip, consumed_at="", created_at=_iso()))
    db.commit()
    return code


def _live_code_row(db, email: str, purpose: str):
    row = (db.query(ExternalLoginCode)
           .filter(ExternalLoginCode.email == email,
                   ExternalLoginCode.purpose == purpose,
                   ExternalLoginCode.consumed_at == "")
           .order_by(ExternalLoginCode.created_at.desc()).first())
    if not row or (row.expires_at and row.expires_at < _iso()):
        return None
    return row


# ── delivery (patched in tests - nothing here may log the code) ──────────────

_BRAND_HEADER = """<div style="background:#f4f5f7;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:14px;border:1px solid #e5e7eb;border-collapse:separate;overflow:hidden">
    <tr><td style="background:#0f3d2e;padding:18px 28px">
      <span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:3px">GREENS GLOBAL</span>
    </td></tr>"""

_BRAND_FOOTER = """<tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-size:11.5px;color:#6b7280;line-height:1.5">
      Sent via Nexus, the Greens Global company portal. If you weren't expecting this email, you can ignore it.
    </td></tr></table></div>"""


def _from_email() -> str:
    return os.getenv("NEXUS_FROM_EMAIL", "")


def _send_invite_email(to_email: str, display_name: str, inviter_name: str,
                       company: str, token: str) -> None:
    """The branded invitation. Raises GraphMailError on failure (caller records
    invite_status='failed'). The activation link is the only secret inside."""
    link = f"{app_url()}/activate/{token}"
    first = (display_name or "").split(" ")[0] or "there"
    html = f"""{_BRAND_HEADER}
    <tr><td style="padding:26px 28px 8px">
      <h2 style="margin:0 0 14px;font-size:19px;color:#111827;line-height:1.35">Greens Global invited you to Nexus</h2>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#1f2937">Hi {first},</p>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#1f2937">
        {inviter_name} invited you{f" ({company})" if company else ""} to collaborate on Greens Global Nexus,
        our company portal - tasks, tickets, and documents shared with you, in one place.</p>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#1f2937">
        Press the button to set up your access. The link works once and expires in {INVITE_TTL_DAYS} days.</p>
      <table cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr><td style="border-radius:9px;background:#0f3d2e">
        <a href="{link}" style="display:inline-block;padding:12px 26px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none">Accept Invitation</a>
      </td></tr></table>
      <p style="margin:0 0 16px;font-size:12px;line-height:1.6;color:#6b7280">
        Button not working? Paste this link into your browser:<br>{link}</p>
    </td></tr>
    {_BRAND_FOOTER}"""
    graph_mail.send_mail(from_email=_from_email(), to=[to_email], cc=None,
                         subject="Greens Global invited you to Nexus", html=html)


def _send_email_code(to_email: str, code: str) -> None:
    """The 6-digit code by email. Raises GraphMailError on failure."""
    html = f"""{_BRAND_HEADER}
    <tr><td style="padding:26px 28px 8px">
      <h2 style="margin:0 0 14px;font-size:19px;color:#111827;line-height:1.35">Your Nexus sign-in code</h2>
      <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#1f2937">Enter this code to continue. It expires in {CODE_TTL_MIN} minutes.</p>
      <div style="margin:0 0 18px;font-size:30px;font-weight:800;letter-spacing:8px;color:#0f3d2e">{code}</div>
      <p style="margin:0 0 16px;font-size:12px;line-height:1.6;color:#6b7280">Never share this code. Greens Global will never ask you for it.</p>
    </td></tr>
    {_BRAND_FOOTER}"""
    graph_mail.send_mail(from_email=_from_email(), to=[to_email], cc=None,
                         subject="Your Nexus sign-in code", html=html)


def _deliver_code(db, emp: NexusEmployee, purpose: str, ip: str,
                  phone_override: str = "", force_email: bool = False) -> tuple[str, bool]:
    """Issue + deliver one code. Returns (channel_used, delivered). SMS via
    sent.dm when a phone is available (override during activation, else the
    VERIFIED phone); any SMS failure degrades automatically to email."""
    email = (emp.work_email or "").lower()
    phone = (phone_override or "").strip()
    if not phone and not force_email:
        if (emp.phone or "").strip() and (getattr(emp, "phone_verified_at", "") or "").strip():
            phone = emp.phone.strip()

    if phone and not force_email:
        code = _issue_code(db, email, purpose, "sms", ip)
        ok, err = sentdm.send_code(phone, code)
        if ok:
            return "sms", True
        print(f"[external-auth] SMS delivery degraded to email for {email}: {err}")

    code = _issue_code(db, email, purpose, "email", ip)
    try:
        _send_email_code(email, code)
        return "email", True
    except Exception as exc:
        print(f"[external-auth] email code delivery failed for {email}: {type(exc).__name__}")
        _audit(db, email, "external_code_delivery_failed", "all delivery channels failed", ip)
        return "email", False


# ── invite issuance (called by routers/external_users.py) ────────────────────

def issue_invite(db, emp: NexusEmployee, inviter_name: str) -> tuple[str, str]:
    """Mint a fresh single-use activation token (killing prior ones) and email
    the branded invitation. Returns (invite_status, message) matching the
    existing invite_status semantics: 'sent' = OUR email went out."""
    email = (emp.work_email or "").lower()
    token = secrets.token_urlsafe(48)
    (db.query(ExternalLoginCode)
     .filter(ExternalLoginCode.email == email,
             ExternalLoginCode.purpose == "invite",
             ExternalLoginCode.consumed_at == "")
     .update({"consumed_at": _iso()}, synchronize_session=False))
    db.add(ExternalLoginCode(
        id=str(uuid.uuid4()), email=email, code_hash=_hash_token(token),
        purpose="invite", channel="email",
        expires_at=_iso(_now_dt() + timedelta(days=INVITE_TTL_DAYS)),
        attempts=0, created_ip="", consumed_at="", created_at=_iso()))
    db.commit()
    try:
        _send_invite_email(email, f"{emp.first_name} {emp.last_name}".strip(),
                           inviter_name, getattr(emp, "external_company", "") or "", token)
    except Exception as exc:
        return "failed", (f"The invitation email could not be sent ({type(exc).__name__}) - "
                          "check the mail configuration (NEXUS_FROM_EMAIL / AZURE_CLIENT_SECRET "
                          "with the Mail.Send permission), then use Resend Invite.")
    _audit(db, email, "external_invite_sent", f"invited by {inviter_name}", "")
    return "sent", "Invitation email sent."


def revoke_credentials(db, email: str) -> None:
    """Deactivate/Remove hook: kill every outstanding code/token AND every
    server session for this email, immediately."""
    email = (email or "").lower()
    (db.query(ExternalLoginCode)
     .filter(ExternalLoginCode.email == email, ExternalLoginCode.consumed_at == "")
     .update({"consumed_at": _iso()}, synchronize_session=False))
    db.commit()
    bff.revoke_sessions(db, email)


# ── shared responses ─────────────────────────────────────────────────────────

def _session_response(db, email: str, payload: dict) -> JSONResponse:
    """Mint the BFF session and set the SAME cookies /auth/callback sets."""
    from routers.auth_bff import _set_cookie, _SESSION_MAX_AGE
    sid, csrf = bff.create_passwordless_session(db, email)
    resp = JSONResponse(content=payload)
    _set_cookie(resp, bff.SESSION_COOKIE, sid, http_only=True, max_age=_SESSION_MAX_AGE)
    _set_cookie(resp, bff.CSRF_COOKIE, csrf, http_only=False, max_age=_SESSION_MAX_AGE)
    return resp


def _invite_row(db, token: str):
    """The live invite row for a presented token, or None."""
    if not token or len(token) < 32:
        return None
    row = (db.query(ExternalLoginCode)
           .filter(ExternalLoginCode.code_hash == _hash_token(token),
                   ExternalLoginCode.purpose == "invite",
                   ExternalLoginCode.consumed_at == "").first())
    if not row or (row.expires_at and row.expires_at < _iso()):
        return None
    return row


def _inviter_name(db, invited_by: str) -> str:
    emp = (db.query(NexusEmployee)
           .filter(func.lower(NexusEmployee.work_email) == (invited_by or "").lower()).first())
    if emp:
        return (emp.display_name or "").strip() or f"{emp.first_name} {emp.last_name}".strip()
    local = (invited_by or "").split("@")[0]
    return " ".join(p.capitalize() for p in local.replace("_", ".").split(".") if p) or "Greens Global"


def _mask_phone(phone: str) -> str:
    digits = re.sub(r"\D", "", phone or "")
    return f"***{digits[-4:]}" if len(digits) >= 4 else ""


def _display_name(db, email: str) -> str:
    emp = (db.query(NexusEmployee)
           .filter(func.lower(NexusEmployee.work_email) == (email or "").lower()).first())
    if emp:
        name = (emp.display_name or "").strip() or f"{emp.first_name} {emp.last_name}".strip()
        if name:
            return name
    local = (email or "").split("@")[0]
    return " ".join(p.capitalize() for p in local.replace("_", ".").split(".") if p) or email


def _signed_in_identity(request: Request, db) -> dict | None:
    """Who (if anyone) this browser is ALREADY signed in as - a plain READ of
    the session cookie (Aug 18, Visesh: activating a guest silently replaced
    his admin session). These pre-auth endpoints never REQUIRE the cookie
    (CSRF-exempt for exactly that reason), but reading it lets the frontend
    warn before a Continue replaces the session. A light lookup on purpose -
    no token refresh, no last_seen write."""
    sid = request.cookies.get(bff.SESSION_COOKIE, "") if request is not None else ""
    if not sid:
        return None
    from models import ServerSession
    row = db.query(ServerSession).filter(ServerSession.id == sid).first()
    if not row or not (row.user_email or "").strip():
        return None
    email = row.user_email.lower()
    return {"email": email, "name": _display_name(db, email)}


def _session_conflict(request: Request, db, target_email: str) -> tuple[dict | None, bool]:
    """(signedInAs, conflict): conflict only when the live session belongs to a
    DIFFERENT identity than the invite/login target - same email just means
    they are re-signing-in and needs no warning."""
    who = _signed_in_identity(request, db)
    return who, bool(who and who["email"] != (target_email or "").lower())


# ── schemas ──────────────────────────────────────────────────────────────────

class TokenIn(BaseModel):
    token: str

class ActivateSendIn(BaseModel):
    token: str
    phone: Optional[str] = ""       # optional add-and-verify during activation
    channel: Optional[str] = ""     # 'email' forces the email fallback

class ActivateVerifyIn(BaseModel):
    token: str
    code: str

class RequestCodeIn(BaseModel):
    email: str
    channel: Optional[str] = ""     # 'email' = "Send to my email instead"

class LoginVerifyIn(BaseModel):
    email: str
    code: str


# ── activation (invite link) ─────────────────────────────────────────────────

@router.post("/activate/lookup")
def activate_lookup(body: TokenIn, request: Request):
    """Validate an invite token and return what the activation page shows.
    The link arriving in their inbox is the proof of address ownership.
    Also reports whether this browser already holds a DIFFERENT identity's
    session, so the page can confirm the account switch instead of silently
    replacing it."""
    db = SessionLocal()
    try:
        row = _invite_row(db, (body.token or "").strip())
        emp = _active_external(db, row.email) if row else None
        if not emp:
            return JSONResponse(status_code=404, content={
                "detail": "This invitation link is invalid, already used, or expired - ask your Greens Global contact to send a new one."})
        target = (emp.work_email or "").lower()
        signed_in_as, conflict = _session_conflict(request, db, target)
        return {
            "email": target,
            "firstName": emp.first_name or "",
            "lastName": emp.last_name or "",
            "name": (emp.display_name or "").strip() or f"{emp.first_name} {emp.last_name}".strip(),
            "company": getattr(emp, "external_company", "") or "",
            "invitedBy": _inviter_name(db, getattr(emp, "invited_by", "") or ""),
            "hasPhone": bool((emp.phone or "").strip()),
            "phoneMasked": _mask_phone(emp.phone or ""),
            "signedInAs": signed_in_as,
            "sessionConflict": conflict,
        }
    finally:
        db.close()


@router.post("/activate/send-code")
def activate_send_code(body: ActivateSendIn, request: Request):
    """Send the activation 6-digit code - SMS to the on-file or just-provided
    phone via sent.dm, or email on request/degradation. A phone provided here
    is saved (unverified) and only stamped verified when its code verifies."""
    ip = _client_ip(request)
    db = SessionLocal()
    try:
        row = _invite_row(db, (body.token or "").strip())
        emp = _active_external(db, row.email) if row else None
        if not emp:
            return JSONResponse(status_code=404, content={"detail": "Invalid or expired invitation."})
        email = (emp.work_email or "").lower()
        if _locked_out(db, email) or _rate_limited(db, email, ip):
            return JSONResponse(status_code=429, content={"detail": "Too many attempts - wait a bit and try again."})
        phone = re.sub(r"[^\d+]", "", body.phone or "")
        if phone:
            emp.phone = phone
            emp.phone_verified_at = ""      # a NEW number is unverified until its code lands
            db.commit()
        force_email = (body.channel or "").lower() == "email"
        use_phone = "" if force_email else (phone or (emp.phone or "").strip())
        channel, delivered = _deliver_code(db, emp, "activate", ip,
                                           phone_override=use_phone, force_email=force_email)
        return {"ok": True, "channel": channel, "delivered": delivered,
                "hint": _mask_phone(use_phone) if channel == "sms" else email}
    finally:
        db.close()


@router.post("/activate/verify")
def activate_verify(body: ActivateVerifyIn, request: Request):
    """Verify the activation code; on success consume BOTH the code and the
    invite token, stamp phone_verified_at for an SMS code, and mint the same
    BFF session cookie an employee login gets."""
    ip = _client_ip(request)
    db = SessionLocal()
    try:
        token_row = _invite_row(db, (body.token or "").strip())
        emp = _active_external(db, token_row.email) if token_row else None
        if not emp:
            return JSONResponse(status_code=404, content={"detail": "Invalid or expired invitation."})
        email = (emp.work_email or "").lower()
        outcome = _verify_code(db, email, "activate", (body.code or "").strip(), ip)
        if outcome is not True:
            return outcome
        token_row.consumed_at = _iso()
        emp.invite_status = "accepted"   # feeds the People > External list badge
        db.commit()
        _audit(db, email, "external_activated", "invite redeemed, account activated", ip)
        return _session_response(db, email, {"ok": True, "next": "/"})
    finally:
        db.close()


# ── returning sign-in ────────────────────────────────────────────────────────

@router.post("/request-code")
def request_code(body: RequestCodeIn, request: Request):
    """Partner Sign-In step 1. ALWAYS the same generic 200 - unknown emails,
    deactivated rows, lockouts, and rate limits are indistinguishable from a
    successful send (no account enumeration). The session-conflict fields
    describe only the CALLER'S OWN cookie (who this browser is already signed
    in as) - they reveal nothing about the submitted email, so the generic
    posture holds; the frontend uses them to confirm the account switch."""
    ip = _client_ip(request)
    email = (body.email or "").lower().strip()
    db = SessionLocal()
    try:
        emp = _active_external(db, email)
        if emp and not _locked_out(db, email) and not _rate_limited(db, email, ip):
            force_email = (body.channel or "").lower() == "email"
            _deliver_code(db, emp, "login", ip, force_email=force_email)
        signed_in_as, conflict = _session_conflict(request, db, email)
        return {"ok": True, "message": GENERIC_MSG,
                "signedInAs": signed_in_as, "sessionConflict": conflict}
    finally:
        db.close()


@router.post("/login-verify")
def login_verify(body: LoginVerifyIn, request: Request):
    """Partner Sign-In step 2: verify the code, mint the session cookie."""
    ip = _client_ip(request)
    email = (body.email or "").lower().strip()
    db = SessionLocal()
    try:
        emp = _active_external(db, email)
        if not emp:
            return JSONResponse(status_code=400, content={"detail": "Invalid or expired code."})
        outcome = _verify_code(db, email, "login", (body.code or "").strip(), ip)
        if outcome is not True:
            return outcome
        _audit(db, email, "external_login", "passwordless sign-in", ip)
        return _session_response(db, email, {"ok": True, "next": "/"})
    finally:
        db.close()


def _verify_code(db, email: str, purpose: str, code: str, ip: str):
    """Shared verify: True on success (code consumed, phone stamped for SMS),
    else a JSONResponse error. Counts attempts on the ROW (cross-worker) and
    kills it at MAX_ATTEMPTS, which starts the 15-minute lockout."""
    if _locked_out(db, email):
        return JSONResponse(status_code=429, content={
            "detail": "Too many incorrect codes - wait 15 minutes and request a new one."})
    row = _live_code_row(db, email, purpose)
    if not row or not re.fullmatch(r"\d{6}", code or ""):
        return JSONResponse(status_code=400, content={"detail": "Invalid or expired code."})
    if not _code_matches(code, row.code_hash):
        row.attempts = (row.attempts or 0) + 1
        if row.attempts >= MAX_ATTEMPTS:
            row.consumed_at = _iso()     # dead + timestamps the lockout window
            db.commit()
            _audit(db, email, "external_login_lockout",
                   f"{MAX_ATTEMPTS} failed code attempts", ip)
            return JSONResponse(status_code=429, content={
                "detail": "Too many incorrect codes - wait 15 minutes and request a new one."})
        db.commit()
        return JSONResponse(status_code=400, content={"detail": "Invalid or expired code."})
    row.consumed_at = _iso()
    if row.channel == "sms":
        emp = (db.query(NexusEmployee)
               .filter(func.lower(NexusEmployee.work_email) == email).first())
        if emp:
            emp.phone_verified_at = _iso()
    db.commit()
    return True
