import os
import time
import json
import httpx
import jwt as pyjwt
from jwt.algorithms import RSAAlgorithm
from fastapi import Header, HTTPException, Depends, Request
from sqlalchemy.exc import OperationalError, TimeoutError as SATimeoutError
from sqlalchemy.orm import Session
from database import SessionLocal, get_db

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


_LEVELS = {"employee": 1, "supervisor": 2, "manager": 3, "administrator": 4, "owner": 5}

# get_current_user runs on every single API request (it's a dependency of every
# router), so an uncached _role_for meant every request - regardless of which
# endpoint it hit - did a DB round trip just to resolve the caller's role.
# Under load that was a huge multiplier on connection-pool pressure for data
# that changes only via rare admin actions. Cache it for a short, safe TTL.
_ROLE_CACHE_TTL = 120.0
_role_cache: dict[str, tuple[str, int, float]] = {}


def _role_for(email: str, db: Session) -> tuple[str, int]:
    from models import NexusRole

    cached = _role_cache.get(email)
    if cached and time.time() - cached[2] < _ROLE_CACHE_TTL:
        return cached[0], cached[1]

    row = db.query(NexusRole).filter(NexusRole.email == email.lower()).first()
    role = row.role if row else "employee"
    level = _LEVELS.get(role, 1)
    _role_cache[email] = (role, level, time.time())
    return role, level


def invalidate_role_cache(email: str | None = None) -> None:
    """Call after assigning/changing a role so the new value takes effect immediately."""
    if email:
        _role_cache.pop(email.lower(), None)
    else:
        _role_cache.clear()


def _email_from_bearer(authorization: str) -> str:
    """Existing SPA/Bearer path: validate a client-supplied Entra ID token and
    return the caller's canonical email. Raises 401 if missing/invalid."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    token = authorization.removeprefix("Bearer ").strip()
    try:
        public_key = _get_public_key(token)
        claims = pyjwt.decode(
            token, public_key, algorithms=["RS256"], audience=CLIENT_ID, issuer=ISSUER,
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

    # Canonical identity: some accounts sign in with the tenant-default
    # @greensg.onmicrosoft.com UPN, but Nexus People (and every module's
    # actor/notification records) key on the primary @greensglobal.com address of
    # the SAME account. Without this rewrite those users split into two identities
    # (Jul 24). The BFF path applies the same rule in bff_session.normalize_email.
    if email.endswith("@greensg.onmicrosoft.com"):
        email = email.split("@")[0] + "@greensglobal.com"

    if not email:
        raise HTTPException(status_code=401, detail="Token contains no identifiable email claim")
    return email


def _email_from_session(request: Request) -> str:
    """BFF path: resolve identity from the HttpOnly session cookie (server-side
    session, server-refreshed tokens). Returns '' when there's no usable session so
    the caller falls through to Bearer. Never raises for a COOKIE problem - that
    must not break auth for Bearer clients during the dual-mode migration. A DB
    problem is different: the caller presented a valid-looking cookie we simply
    could not check, and falling through turns into a 401, which the frontend
    treats as a real logout (Aug 5: pooler connection exhaustion mass-logged-out
    everyone into a login loop). Those raise 503 so api.js retries instead."""
    try:
        import bff_session
        if not bff_session.configured():
            return ""
        sid = request.cookies.get(bff_session.SESSION_COOKIE, "")
        if not sid:
            return ""
        db = SessionLocal()
        try:
            row = bff_session.get_session(db, sid)
            return row.user_email if row else ""
        finally:
            db.close()
    except (OperationalError, SATimeoutError):
        # Connection refused/exhausted or pool_timeout exceeded - only reachable
        # with a session cookie present, so Bearer clients are unaffected.
        raise HTTPException(status_code=503, detail="Session store unavailable, retry shortly")
    except Exception:
        return ""


def get_current_user(
    request: Request,
    authorization: str = Header(default=None),
    x_act_as_session: str = Header(default=None, alias="X-Act-As-Session"),
) -> dict:
    """
    FastAPI dependency. Resolves the caller to {email, role, level}. Identity comes
    from, in order: the BFF session cookie, then the Bearer ID token - dual-mode,
    so the app works on either during the migration. Set NEXUS_SKIP_AUTH=true to
    bypass in local development (never set in production).

    Deliberately does NOT take `db: Session = Depends(get_db)` - that would check
    out a pooled connection for every request, including ones rejected before any
    DB access is needed. A session is opened directly, only once identity resolves.
    """
    if SKIP_AUTH:
        email = os.getenv("NEXUS_DEV_EMAIL", "dev@localhost").lower()
    else:
        email = _email_from_session(request)          # BFF cookie path ('' if none)
        if not email:
            email = _email_from_bearer(authorization)  # existing Bearer path (raises 401 if none)

    # Cache hit → skip the DB connection checkout entirely (the common case:
    # the same ~180 employees re-authenticate on every request they make).
    cached = _role_cache.get(email)
    if cached and time.time() - cached[2] < _ROLE_CACHE_TTL:
        role, level = cached[0], cached[1]
    else:
        db = SessionLocal()
        try:
            role, level = _role_for(email, db)
        finally:
            db.close()

    # Act As overlay (Jul 2026): a Manager/IT Admin/Global Admin running an
    # active impersonation session sees business logic run as the TARGET -
    # same permission checks, notifications, and ownership fields, scoped to
    # whatever the target could do (act_as.start_session only ever allows
    # acting as someone strictly below the real actor's role, so this can
    # narrow access here, never grant anything extra). Only opens a second DB
    # connection when the header is actually present - i.e. only while someone
    # is actively acting as someone else, not on every request.
    if x_act_as_session:
        from act_as import resolve_target
        db2 = SessionLocal()
        try:
            target = resolve_target(x_act_as_session, email, db2)
        finally:
            db2.close()
        if target:
            return target

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


# Per-module permission levels an Access Group can grant (mirrors the
# folder-permission pattern: each grant carries both visibility AND a level of
# capability, decided together in one place - Viewer/Editor/Full/Owner).
# Rank order matters: a higher level always implies everything lower grants.
MODULE_LEVELS = ("viewer", "editor", "full", "owner")
_MODULE_LEVEL_RANK = {lvl: i + 1 for i, lvl in enumerate(MODULE_LEVELS)}


def _grants_for(email: str, db: Session) -> dict:
    """All module grants for `email` as {module_id: best rank}, cached (see
    cache.py). One request usually checks one module, but the query cost is the
    same either way, and caching the whole map means every grant-gated
    dependency in the same TTL window is a dict lookup instead of a JOIN."""
    from models import NexusGroup, NexusGroupMember
    import cache

    key = email.lower()
    grants = cache.module_grants.get(key)
    if grants is not None:
        return grants

    rows = (
        db.query(NexusGroup.allowed_modules)
        .join(NexusGroupMember, NexusGroupMember.group_id == NexusGroup.id)
        .filter(NexusGroupMember.email == key)
        .all()
    )
    grants = {}
    for (modules,) in rows:
        for part in (modules or "").split(","):
            mid, _, level = part.strip().partition(":")
            if mid:
                rank = _MODULE_LEVEL_RANK.get(level, _MODULE_LEVEL_RANK["viewer"])
                grants[mid] = max(grants.get(mid, 0), rank)
    cache.module_grants.set(key, grants)
    return grants


def _module_level(email: str, module_id: str, db: Session) -> int:
    """Highest permission-level rank any Access Group grants this user for
    `module_id` (0 if none) - mirrors the frontend's myGrantedModules
    (RoleContext.jsx), which stores the same per-module level per group."""
    return _grants_for(email, db).get(module_id, 0)


def require_level_or_module(min_level: int, module_id: str, min_module_level: str):
    """Returns a dependency admitting users at/above `min_level` globally, OR
    anyone whose Access Group grants at least `min_module_level` for
    `module_id` - lets a group's scoped grant raise someone's capability for
    that module specifically, without elevating their role anywhere else.
    Purely additive: never narrows what `min_level` alone would already allow."""
    threshold = _MODULE_LEVEL_RANK[min_module_level]

    def _check(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
        if user["level"] >= min_level or _module_level(user["email"], module_id, db) >= threshold:
            return user
        raise HTTPException(status_code=401, detail="Insufficient permissions")
    return _check


def require_module_grant(module_id: str, min_module_level: str = "viewer", bypass_level: str = "administrator"):
    """Grant-driven access (Jun 17): admits admins at/above `bypass_level`
    (administrator by default - they manage every screen), OR anyone whose Access
    Group grants at least `min_module_level` for `module_id`.

    Unlike require_level_or_module, a supervisor/manager role does NOT by itself
    open the module - only an explicit Access Group grant does. This mirrors the
    frontend's grant-driven sidebar/route visibility so a screen hidden in the UI
    is also blocked at the API (UI hiding alone is not a security boundary)."""
    threshold = _MODULE_LEVEL_RANK[min_module_level]
    blevel = _LEVELS[bypass_level]

    def _check(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
        if user["level"] >= blevel or _module_level(user["email"], module_id, db) >= threshold:
            return user
        raise HTTPException(status_code=403, detail="You don't have access to this screen")
    return _check


def scoped_ids(email: str, module_id: str, db: Session):
    """Row-level scope for `email` within `module_id`. Returns one of:
      - None   → unrestricted (see everything the module grant allows)
      - set()  → see NOTHING (fail-closed): an external user with no scope rows
      - {ids}  → restricted to exactly these scope_ids

    Any user WITH scope rows for the module is restricted to them. A user with
    none is unrestricted UNLESS they are identity_type='external', who then see
    nothing - least-privilege by default so a misconfigured external can never
    see every row. Callers apply the returned set as a WHERE scope_id IN (...)
    filter; a None result means apply no filter. Example:

        allowed = scoped_ids(user["email"], "property-asset", db)
        if allowed is not None:
            q = q.filter(Property.id.in_(allowed))   # empty set → no rows
    """
    from sqlalchemy import func
    from models import NexusAccessScope, NexusEmployee
    rows = (db.query(NexusAccessScope)
            .filter(NexusAccessScope.email == email.lower(),
                    NexusAccessScope.module_id == module_id).all())
    if rows:
        return {r.scope_id for r in rows}
    emp = (db.query(NexusEmployee)
           .filter(func.lower(NexusEmployee.work_email) == email.lower()).first())
    if emp and (emp.identity_type or "internal") == "external":
        return set()   # fail-closed: external with no explicit scope sees nothing
    return None
