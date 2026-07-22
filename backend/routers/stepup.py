"""Step-up authentication (Jul 2026).

Real, server-enforced re-authentication before sensitive data is shown —
credential-vault secrets, cross-employee payroll ($), and confidential HR
(compensation/bank/paystubs). Replaces the old client-side "MFA theater"
(browser-generated codes shown as a demo hint, never checked by the server).

How it works (Entra-native, no Twilio):
  1. The frontend asks MSAL for an ACCESS token for our API scope WITH a claims
     challenge requesting an Entra "authentication context" (e.g. c1). A
     Conditional Access policy bound to that context forces a FRESH MFA — the
     live Microsoft Authenticator push, or SMS if the user registered it.
  2. That access token carries the `acrs` claim proving the context was
     satisfied. The frontend POSTs it to /stepup/verify.
  3. We validate the token (signature via Azure JWKS, issuer, audience, that
     `acrs` contains the configured value, and freshness), then open a
     short-lived StepUpSession (default 5 min) for that user.
  4. require_stepup guards the sensitive endpoints: it admits the request only
     while the caller has an unexpired StepUpSession. One step-up unlocks a
     short burst, so users aren't re-prompted per item.

The StepUpSession row is also the audit trail: who stepped up, when, by which
method, from where.
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
from auth import get_current_user, _get_public_key, CLIENT_ID, TENANT_ID, ISSUER, SKIP_AUTH
from models import StepUpSession

router = APIRouter(prefix="/stepup", tags=["Step-up auth"])

# ── Config (env-overridable; the frontend reads these via /stepup/config so the
# Entra authentication-context id / scope can change without a rebuild) ────────
STEPUP_ACR       = os.getenv("NEXUS_STEPUP_ACR", "c1")                 # Entra authentication-context value
STEPUP_SCOPE     = os.getenv("NEXUS_STEPUP_SCOPE", f"api://{CLIENT_ID}/access_as_user")
STEPUP_TTL_SEC   = int(os.getenv("NEXUS_STEPUP_TTL_SEC", "300"))       # how long one step-up unlocks (5 min)
STEPUP_MAX_AGE   = int(os.getenv("NEXUS_STEPUP_TOKEN_MAX_AGE", "300")) # reject a step-up token older than this
# Whether step-up is enforced at all. Off by default so the feature can ship and
# be wired end-to-end BEFORE the Entra authentication context exists — flip
# NEXUS_STEPUP_ENFORCE=true once Entra is configured. When off, require_stepup
# is a no-op (endpoints behave exactly as before) so nothing breaks pre-config.
STEPUP_ENFORCE   = os.getenv("NEXUS_STEPUP_ENFORCE", "").lower() in ("1", "true", "yes")

# v2 access tokens carry aud = client GUID + iss = .../v2.0; v1 (App ID URI
# audience) carry aud = api://{clientId} + iss = sts.windows.net. Accept both so
# the app's token-version setting doesn't matter.
_AUD = [CLIENT_ID, f"api://{CLIENT_ID}"]
_ISS = [ISSUER, f"https://sts.windows.net/{TENANT_ID}/"]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _client_meta(request: Request) -> tuple[str, str]:
    ip = (request.headers.get("x-forwarded-for", "").split(",")[0].strip()
          or (request.client.host if request.client else ""))
    return ip[:60], (request.headers.get("user-agent", "") or "")[:300]


def _validate_stepup_token(token: str, email: str) -> dict:
    """Decode + verify an Entra step-up access token. Raises 400/401 on any
    problem; returns the claims. Verifies signature, issuer, audience, that the
    token belongs to the SAME user, that it satisfies the required
    authentication context (acrs), and that it is fresh."""
    try:
        public_key = _get_public_key(token)
        claims = pyjwt.decode(
            token, public_key, algorithms=["RS256"],
            audience=_AUD, issuer=_ISS,
            options={"verify_aud": True, "verify_iss": True},
        )
    except pyjwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail=f"Invalid step-up token: {exc}")

    # Must be the same person as the caller (the token identifies the subject).
    tok_email = (claims.get("preferred_username") or claims.get("upn")
                 or claims.get("unique_name") or claims.get("email") or "").lower().strip()
    if tok_email and email and tok_email != email:
        raise HTTPException(status_code=401, detail="Step-up token belongs to a different user")

    # Must satisfy the required Entra authentication context.
    acrs = claims.get("acrs") or []
    if isinstance(acrs, str):
        acrs = [acrs]
    if STEPUP_ACR not in acrs:
        raise HTTPException(status_code=401, detail={
            "code": "stepup_context_missing",
            "message": "Multi-factor verification was not completed for this action.",
        })

    # Must be fresh — a replayed old token can't establish a session.
    iat = int(claims.get("iat", 0))
    if iat and (int(time.time()) - iat) > STEPUP_MAX_AGE:
        raise HTTPException(status_code=401, detail="Step-up verification expired — please try again.")

    return claims


def _method_from_claims(claims: dict) -> str:
    amr = claims.get("amr") or []
    if isinstance(amr, str):
        amr = [amr]
    amr = [a.lower() for a in amr]
    if "sms" in amr or "otp" in amr:
        return "sms"
    if "mfa" in amr or "ngcmfa" in amr:
        return "authenticator"
    return "mfa"


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
    miss, 403 with a machine code the frontend catches to launch the challenge."""
    if not STEPUP_ENFORCE or SKIP_AUTH:
        return user
    if has_active_stepup(db, user["email"]):
        return user
    raise HTTPException(status_code=403, detail={
        "code": "stepup_required",
        "message": "This needs a quick identity check. Approve the Microsoft "
                   "prompt (or enter the SMS code) to continue.",
    })


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/config")
def stepup_config():
    """Frontend reads the authentication-context value + scope to request, so
    Entra config can change without a frontend rebuild."""
    return {"acr": STEPUP_ACR, "scope": STEPUP_SCOPE,
            "ttlSec": STEPUP_TTL_SEC, "enforced": STEPUP_ENFORCE}


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
    token: Optional[str] = ""   # Entra step-up ACCESS token (with acrs); omitted only in dev bypass


@router.post("/verify")
def stepup_verify(body: VerifyIn, request: Request,
                  user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Establish a step-up session after a fresh Entra MFA. Validates the
    supplied access token (real deployments) or opens a session directly when
    running under the local NEXUS_SKIP_AUTH dev bypass (no Entra available)."""
    ip, ua = _client_meta(request)
    if SKIP_AUTH:
        method, acr = "dev", STEPUP_ACR
    else:
        if not (body.token or "").strip():
            raise HTTPException(status_code=400, detail="Step-up token is required")
        claims = _validate_stepup_token(body.token.strip(), user["email"])
        method, acr = _method_from_claims(claims), STEPUP_ACR

    now = _now()
    row = StepUpSession(
        id=str(uuid.uuid4()), email=user["email"].lower(), method=method, acr=acr,
        granted_at=_iso(now), expires_at=_iso(now + timedelta(seconds=STEPUP_TTL_SEC)),
        ip=ip, user_agent=ua,
    )
    db.add(row)
    db.commit()
    return {"ok": True, "method": method, "expiresAt": row.expires_at,
            "secondsRemaining": STEPUP_TTL_SEC}
