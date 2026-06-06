import os
import time
import json
import httpx
import jwt as pyjwt
from jwt.algorithms import RSAAlgorithm
from fastapi import Header, HTTPException, Depends
from sqlalchemy.orm import Session
from database import SessionLocal

TENANT_ID = os.getenv("AZURE_TENANT_ID", "40966012-b88e-45c8-941a-341f87b9dc60")
CLIENT_ID = os.getenv("AZURE_CLIENT_ID",  "be6f1e37-83a8-4a29-8b46-96d20beb32f9")
JWKS_URI  = f"https://login.microsoftonline.com/{TENANT_ID}/discovery/v2.0/keys"
ISSUER    = f"https://login.microsoftonline.com/{TENANT_ID}/v2.0"

# Set NEXUS_SKIP_AUTH=true in local .env to bypass token checks during development
SKIP_AUTH = os.getenv("NEXUS_SKIP_AUTH", "").lower() in ("1", "true", "yes")

_jwks_cache: dict = {"keys": None, "at": 0.0}


def _fetch_jwks() -> dict:
    """Fetch Azure AD public keys, cached for 1 hour."""
    now = time.time()
    if _jwks_cache["keys"] and now - _jwks_cache["at"] < 3600:
        return _jwks_cache["keys"]
    r = httpx.get(JWKS_URI, timeout=10, verify=True)
    r.raise_for_status()
    _jwks_cache.update({"keys": r.json(), "at": now})
    return _jwks_cache["keys"]


def _get_public_key(token: str):
    """Find the RSA public key matching the token's kid."""
    header = pyjwt.get_unverified_header(token)
    kid = header.get("kid")
    jwks = _fetch_jwks()
    key_data = next((k for k in jwks["keys"] if k.get("kid") == kid), None)
    if not key_data:
        # Bust cache and retry once (handles key rotation)
        _jwks_cache["keys"] = None
        jwks = _fetch_jwks()
        key_data = next((k for k in jwks["keys"] if k.get("kid") == kid), None)
    if not key_data:
        raise HTTPException(status_code=401, detail="Token signing key not found")
    return RSAAlgorithm.from_jwk(json.dumps(key_data))


def _role_for(email: str, db: Session) -> tuple[str, int]:
    from models import NexusRole
    row = db.query(NexusRole).filter(NexusRole.email == email.lower()).first()
    role = row.role if row else "employee"
    levels = {"employee": 1, "supervisor": 2, "manager": 3, "administrator": 4, "owner": 5}
    return role, levels.get(role, 1)


def get_current_user(
    authorization: str = Header(default=None),
) -> dict:
    """
    FastAPI dependency. Validates the Azure AD ID token from the Authorization
    header, returns {email, role, level}. Set NEXUS_SKIP_AUTH=true to bypass
    in local development (never set in production).

    Deliberately does NOT take `db: Session = Depends(get_db)` — that would
    check out a pooled connection for every request, including ones rejected
    for a missing/expired/malformed token before any DB access is needed. Under
    load, that turned auth rejections into pool-contention bottlenecks too. A
    session is opened directly, only once the token has actually validated.
    """
    if not SKIP_AUTH:
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

        token = authorization.removeprefix("Bearer ").strip()

        try:
            public_key = _get_public_key(token)
            claims = pyjwt.decode(
                token,
                public_key,
                algorithms=["RS256"],
                audience=CLIENT_ID,
                issuer=ISSUER,
            )
        except pyjwt.PyJWTError as exc:
            raise HTTPException(status_code=401, detail=f"Invalid token: {exc}")

        # Azure AD puts the UPN in several possible claims
        email = (
            claims.get("preferred_username")
            or claims.get("upn")
            or claims.get("unique_name")
            or claims.get("email")
            or ""
        ).lower().strip()

        if not email:
            raise HTTPException(status_code=401, detail="Token contains no identifiable email claim")
    else:
        email = os.getenv("NEXUS_DEV_EMAIL", "dev@localhost").lower()

    db = SessionLocal()
    try:
        role, level = _role_for(email, db)
    finally:
        db.close()
    return {"email": email, "role": role, "level": level}


def require_level(min_level: int):
    """Returns a dependency that enforces a minimum role level."""
    def _check(user: dict = Depends(get_current_user)):
        if user["level"] < min_level:
            raise HTTPException(status_code=401, detail="Insufficient permissions")
        return user
    return _check


# Convenience shortcuts
require_manager       = require_level(3)
require_administrator = require_level(4)
require_owner         = require_level(5)
