"""Step-up authentication (Jul 2026).

Real, server-enforced re-authentication before sensitive data is shown —
credential-vault secrets, cross-employee payroll ($), and confidential HR
(compensation/bank/paystubs). Replaces the old client-side "MFA theater"
(browser-generated codes shown as a demo hint, never checked by the server).

FREE-TIER design (works on Entra ID Free — no Conditional Access / P1 needed):
  1. The frontend forces a FRESH interactive Microsoft sign-in (MSAL popup with
     prompt=login). If the tenant enforces MFA (Security Defaults or per-user
     MFA — both free), that re-login includes the Authenticator/SMS challenge.
  2. The resulting ID token carries `auth_time` = when the user actually
     authenticated. The frontend POSTs it to /stepup/verify.
  3. We validate the ID token (signature via Azure JWKS, issuer, audience, same
     user) and require `auth_time` to be FRESH — proving a just-now re-auth, not
     a silently-refreshed token from a login hours ago. Optionally require the
     `amr` claim to show an MFA factor (NEXUS_STEPUP_REQUIRE_MFA).
  4. On success we open a short-lived StepUpSession (default 5 min); the
     require_stepup dependency guards the sensitive endpoints. One step-up
     unlocks a short burst, so users aren't re-prompted per item.

The StepUpSession row is also the audit trail: who stepped up, when, by which
method, from where.

Setup to activate (all FREE, no Premium):
  • App registration → Token configuration → Add optional claim → ID → auth_time
    (so the freshness check has a value to read).
  • Enable Security Defaults (or per-user MFA) so the re-login challenges MFA.
  • Set NEXUS_STEPUP_ENFORCE=true (and optionally NEXUS_STEPUP_REQUIRE_MFA=true).
"""
import os
import time
import uuid
import jwt as pyjwt
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import Optional

from database import get_db
from auth import get_current_user, _get_public_key, CLIENT_ID, ISSUER, SKIP_AUTH
from models import StepUpSession

router = APIRouter(prefix="/stepup", tags=["Step-up auth"])

# ── Config (env-overridable; the frontend reads /stepup/config) ────────────────
STEPUP_TTL_SEC   = int(os.getenv("NEXUS_STEPUP_TTL_SEC", "300"))       # how long one step-up unlocks (5 min)
STEPUP_MAX_AGE   = int(os.getenv("NEXUS_STEPUP_MAX_AGE", "120"))       # re-auth must be this fresh (auth_time)
# Require the re-login to have used an MFA factor (amr shows mfa/otp/sms/...).
# Off by default so the feature works before MFA is enabled tenant-wide; turn on
# once Security Defaults / per-user MFA is active to hard-enforce MFA.
STEPUP_REQUIRE_MFA = os.getenv("NEXUS_STEPUP_REQUIRE_MFA", "").lower() in ("1", "true", "yes")
# Master switch. Off by default so the feature ships + wires end-to-end BEFORE
# any Entra changes — require_stepup is a no-op until this is true, so nothing
# breaks pre-config. Flip NEXUS_STEPUP_ENFORCE=true to activate.
STEPUP_ENFORCE   = os.getenv("NEXUS_STEPUP_ENFORCE", "").lower() in ("1", "true", "yes")

_MFA_AMR = {"mfa", "ngcmfa", "otp", "sms", "phone", "fido", "wia", "swk"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _client_meta(request: Request) -> tuple[str, str]:
    ip = (request.headers.get("x-forwarded-for", "").split(",")[0].strip()
          or (request.client.host if request.client else ""))
    return ip[:60], (request.headers.get("user-agent", "") or "")[:300]


def _amr_list(claims: dict) -> list[str]:
    amr = claims.get("amr") or []
    if isinstance(amr, str):
        amr = [amr]
    return [str(a).lower() for a in amr]


def _validate_reauth_token(token: str, email: str) -> dict:
    """Decode + verify a FRESH-login ID token. Raises 400/401 on any problem;
    returns the claims. Verifies signature, issuer, audience, same user, and that
    the authentication just happened (auth_time freshness)."""
    try:
        public_key = _get_public_key(token)
        claims = pyjwt.decode(
            token, public_key, algorithms=["RS256"],
            audience=CLIENT_ID, issuer=ISSUER,
        )
    except pyjwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail=f"Invalid verification token: {exc}")

    tok_email = (claims.get("preferred_username") or claims.get("upn")
                 or claims.get("unique_name") or claims.get("email") or "").lower().strip()
    if tok_email and email and tok_email != email:
        raise HTTPException(status_code=401, detail="Verification token belongs to a different user")

    # The crux: auth_time proves a JUST-NOW interactive re-auth. A silently
    # refreshed token would carry an old auth_time (the original login), so this
    # cleanly distinguishes a real step-up from a normal token replay.
    auth_time = claims.get("auth_time")
    if auth_time is None:
        raise HTTPException(status_code=401, detail={
            "code": "auth_time_missing",
            "message": "Sign-in time is unavailable. An admin must add the "
                       "'auth_time' optional claim to the app registration.",
        })
    if (int(time.time()) - int(auth_time)) > STEPUP_MAX_AGE:
        raise HTTPException(status_code=401, detail="Sign-in wasn’t recent enough — please verify again.")

    if STEPUP_REQUIRE_MFA and not (_MFA_AMR & set(_amr_list(claims))):
        raise HTTPException(status_code=401, detail={
            "code": "mfa_required",
            "message": "Multi-factor verification is required for this action.",
        })

    return claims


def _method_from_claims(claims: dict) -> str:
    amr = set(_amr_list(claims))
    if amr & {"otp", "sms", "phone"}:
        return "sms"
    if amr & {"mfa", "ngcmfa", "fido"}:
        return "authenticator"
    return "reauth"


# ── Core helpers used by the require_stepup dependency ────────────────────────

def has_active_stepup(db: Session, email: str) -> Optional[StepUpSession]:
    row = (db.query(StepUpSession)
           .filter(StepUpSession.email == email.lower(),
                   StepUpSession.expires_at > _iso(_now()))
           .order_by(StepUpSession.expires_at.desc())
           .first())
    return row


def require_stepup(user: dict = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """Dependency: admit the request only if step-up enforcement is off (feature
    not yet enabled), OR the caller holds an unexpired step-up session. On a
    miss, 403 with a machine code the frontend catches to launch the re-auth."""
    if not STEPUP_ENFORCE or SKIP_AUTH:
        return user
    if has_active_stepup(db, user["email"]):
        return user
    raise HTTPException(status_code=403, detail={
        "code": "stepup_required",
        "message": "This needs a quick identity check — please re-confirm your "
                   "Microsoft sign-in to continue.",
    })


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/config")
def stepup_config():
    """Frontend reads these so behaviour can change without a rebuild."""
    return {"enforced": STEPUP_ENFORCE, "ttlSec": STEPUP_TTL_SEC,
            "requireMfa": STEPUP_REQUIRE_MFA, "mode": "reauth"}


@router.get("/status")
def stepup_status(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = has_active_stepup(db, user["email"])
    if not row:
        return {"active": False, "secondsRemaining": 0}
    try:
        remaining = int((datetime.strptime(row.expires_at, "%Y-%m-%dT%H:%M:%SZ")
                         .replace(tzinfo=timezone.utc) - _now()).total_seconds())
    except ValueError:
        remaining = 0
    return {"active": remaining > 0, "secondsRemaining": max(0, remaining),
            "method": row.method, "expiresAt": row.expires_at}


class VerifyIn(BaseModel):
    token: Optional[str] = ""   # fresh-login ID token; omitted only in dev bypass


@router.post("/verify")
def stepup_verify(body: VerifyIn, request: Request,
                  user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Establish a step-up session after a fresh Microsoft re-login. Validates
    the supplied ID token (real deployments) or opens a session directly when
    running under the local NEXUS_SKIP_AUTH dev bypass (no Entra available)."""
    ip, ua = _client_meta(request)
    if SKIP_AUTH:
        method = "dev"
    else:
        if not (body.token or "").strip():
            raise HTTPException(status_code=400, detail="Verification token is required")
        claims = _validate_reauth_token(body.token.strip(), user["email"])
        method = _method_from_claims(claims)

    now = _now()
    row = StepUpSession(
        id=str(uuid.uuid4()), email=user["email"].lower(), method=method, acr="reauth",
        granted_at=_iso(now), expires_at=_iso(now + timedelta(seconds=STEPUP_TTL_SEC)),
        ip=ip, user_agent=ua,
    )
    db.add(row)
    db.commit()
    return {"ok": True, "method": method, "expiresAt": row.expires_at,
            "secondsRemaining": STEPUP_TTL_SEC}
