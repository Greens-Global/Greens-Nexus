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

# ── External users (Entra B2B guests, Aug 17) ────────────────────────────────
# Company domains. A signed-in identity on one of these domains is an employee
# and keeps today's behavior exactly. Any OTHER domain is an external candidate
# and must exist as an ACTIVE guest/external row in nexus_employees (allowlist,
# default-deny) - being invited as an Entra tenant guest alone never grants
# Nexus access. Comma-separated env override for future company domains.
INTERNAL_DOMAINS = tuple(
    d.strip().lower()
    for d in os.getenv("NEXUS_INTERNAL_DOMAINS",
                       "greensglobal.com,greensg.onmicrosoft.com").split(",")
    if d.strip()
)

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


def level_for(email: str, db: Session) -> int:
    """This email's role level, for code acting on someone's behalf outside a
    request - the inbound-email ingester has an address, not a signed-in user,
    and still has to apply the same manager bypass every endpoint does. Reads
    through the same cache as get_current_user."""
    return _role_for((email or "").lower(), db)[1]


def invalidate_role_cache(email: str | None = None) -> None:
    """Call after assigning/changing a role so the new value takes effect immediately."""
    if email:
        _role_cache.pop(email.lower(), None)
    else:
        _role_cache.clear()


def email_from_claims(claims: dict) -> str:
    """Resolve the canonical Nexus identity email from Entra ID token claims.
    Shared by the Bearer path here and the BFF cookie path
    (bff_session.normalize_email) so both resolve identically.

    Employees: Azure AD puts the UPN in several possible claims - same priority
    order as always, so existing identities never shift.

    Entra B2B guests: their UPN in OUR tenant is a mangled form like
    "jane_gmail.com#EXT#@greensg.onmicrosoft.com", and which claim carries the
    real invited address varies by account type. Resolve deterministically to
    the INVITED email (the address the admin allowlisted): prefer a plain
    email/unique_name claim, else un-mangle the #EXT# UPN (the last "_" in the
    local part was the "@" of the original address)."""
    email = (
        claims.get("preferred_username")
        or claims.get("upn")
        or claims.get("unique_name")
        or claims.get("email")
        or ""
    ).lower().strip()

    if "#ext#" in email:
        for key in ("email", "unique_name", "preferred_username"):
            v = (claims.get(key) or "").lower().strip()
            if v and "@" in v and "#ext#" not in v:
                email = v
                break
        else:
            local = email.split("#ext#", 1)[0]
            if "_" in local:
                user, _, domain = local.rpartition("_")
                email = f"{user}@{domain}"

    # Canonical identity: some accounts sign in with the tenant-default
    # @greensg.onmicrosoft.com UPN, but Nexus People (and every module's
    # actor/notification records) key on the primary @greensglobal.com address of
    # the SAME account. Without this rewrite those users split into two identities
    # (Jul 24).
    if email.endswith("@greensg.onmicrosoft.com"):
        email = email.split("@")[0] + "@greensglobal.com"
    return email


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

    email = email_from_claims(claims)
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


# ── External-user policy (Entra B2B guest allowlist) ─────────────────────────
# get_current_user runs on every request, so the external lookup is cached the
# same way the role is. The cache stores one of:
#   None              → no nexus_employees row for this email at all
#   {"external": False}   → an internal employee row (normal user)
#   {"external": True, ...} → a guest/external allowlist row + its status/expiry
_EXT_CACHE_TTL = 60.0
_ext_cache: dict[str, tuple] = {}


def _external_record(email: str):
    key = email.lower()
    cached = _ext_cache.get(key)
    if cached and time.time() - cached[1] < _EXT_CACHE_TTL:
        return cached[0]
    from sqlalchemy import func
    from models import NexusEmployee
    db = SessionLocal()
    try:
        emp = (db.query(NexusEmployee)
               .filter(func.lower(NexusEmployee.work_email) == key).first())
    finally:
        db.close()
    if not emp:
        rec = None
    elif (emp.identity_type or "internal") in ("guest", "external"):
        rec = {"external": True, "status": emp.status or "active",
               "expires_at": (getattr(emp, "expires_at", "") or "").strip()}
    else:
        rec = {"external": False}
    _ext_cache[key] = (rec, time.time())
    return rec


def invalidate_external_cache(email: str | None = None) -> None:
    """Call after enrolling/deactivating an external user so it takes effect
    immediately instead of after the cache TTL."""
    if email:
        _ext_cache.pop(email.lower(), None)
    else:
        _ext_cache.clear()


# API surface every signed-in external user needs just for the app shell to
# function (identity, bell, own group memberships for sidebar gating, the
# people directory for name resolution - externals are EXCLUDED from its rows).
_EXTERNAL_BASE_PREFIXES = (
    "/roles/me", "/notifications", "/groups", "/myhr/directory",
    "/branding", "/help", "/client-errors", "/policy", "/stepup", "/auth/",
    "/version", "/health",
)

# Module id -> the API prefixes that module's grant opens for an EXTERNAL
# user. Covers the FULL module catalog (RoleContext.jsx MODULES): externals are
# granted access through the normal Roles & Access machinery - job roles and
# groups, same as any employee (Visesh, Aug 18) - and whatever their grants
# resolve to is what opens here. Every endpoint's own grant/level gate still
# applies on top, exactly as it does for employees; this path gate only keeps
# an external OUT of API surface none of their grants cover (fail-closed: no
# grants = app shell only). A module with no API surface maps to ().
MODULE_API_PREFIXES = {
    "dashboard":          ("/dashboards", "/dashboard"),
    "timeclock":          ("/timeclock",),
    "employee-tracking":  ("/timeclock",),   # its endpoints self-gate on the tracking grant
    "myhr":               ("/myhr",),
    "manager-dashboard":  ("/dashboard",),
    "tasks":              ("/task",),        # /tasks, /task-tickets, /task-projects, /task-* family
    "tickets":            ("/task",),
    "support":            ("/task",),        # Support raises/reads the caller's own tickets
    "sop":                ("/knowledge-base", "/sop-updates", "/lms-"),
    "it":                 ("/unifi",),
    "ops":                ("/construction",),
    "operations":         ("/ops-projects", "/dev-projects"),
    "development":        ("/ops-projects", "/dev-projects"),
    "property-asset":     ("/property-assets",),
    "accounting":         ("/accounting",),
    "investor-relations": ("/investor-relations",),
    "hr":                 ("/hr",),
    "hr_comp":            ("/hr",),          # compensation reveal self-gates on the hr_comp grant
    "documents":          ("/documents", "/esign"),
    "marketing":          ("/marketing-campaigns",),
    "external-links":     ("/external-links", "/link-layout"),
    "inventory":          ("/items",),
    "admin":              (),                # administrator-only; externals are capped at employee
    "testing":            ("/qa",),
    "credvault":          ("/credvault",),
    "egnyte":             ("/egnyte",),
}


def apply_external_policy(request: Request, user: dict) -> dict:
    """Default-deny gate for non-employee identities, applied to EVERY resolved
    request identity (Bearer, BFF cookie, and Act As targets):

    - Internal-domain emails and enrolled employee rows pass through unchanged -
      employees keep working exactly as today.
    - An email on a non-company domain with NO allowlist row is rejected: being
      an Entra tenant guest alone must never grant Nexus access.
    - An allowlisted guest/external must be active and unexpired, is hard-capped
      at employee level (so manager-only broadcasts and bypasses can never reach
      them, even if a nexus_roles row slips in), and may only touch the API
      surface their module grants map to (fail-closed path allowlist)."""
    email = user["email"]
    rec = _external_record(email)

    if rec is None:
        domain = email.rpartition("@")[2]
        if domain in INTERNAL_DOMAINS or SKIP_AUTH:
            return user
        raise HTTPException(
            status_code=403,
            detail="This account is not set up for Nexus. Ask your Greens Global contact to add you as an external user.")

    if not rec["external"]:
        return user

    # 'staged' (Neil, Aug 25: test accounts fully before releasing) is treated
    # like active for AUTHORIZATION - so Act As overlays and admin test-code
    # sessions resolve grants exactly as the released user will - while every
    # AUTHENTICATION entry point (invite send, activation, request-code)
    # refuses staged rows in external_auth/external_users.
    if (rec["status"] or "active") not in ("active", "staged"):
        raise HTTPException(
            status_code=403,
            detail="Your external access has been deactivated. Contact your Greens Global contact.")
    exp = rec["expires_at"]
    if exp:
        from datetime import datetime, timezone as _tz
        if exp[:10] < datetime.now(_tz.utc).date().isoformat():
            raise HTTPException(
                status_code=403,
                detail="Your external access has expired. Contact your Greens Global contact.")

    # Never elevated, regardless of any nexus_roles row.
    user = {**user, "role": "employee", "level": 1, "external": True}

    path = request.url.path if request is not None else ""
    if path.startswith(_EXTERNAL_BASE_PREFIXES):
        return user
    db = SessionLocal()
    try:
        grants = _grants_for(email, db)
    finally:
        db.close()
    allowed = any(
        path.startswith(prefix)
        for module_id in grants
        for prefix in MODULE_API_PREFIXES.get(module_id, ())
    )
    if not allowed:
        raise HTTPException(status_code=403, detail="External accounts don't have access to this area.")
    return user


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
            return apply_external_policy(request, target)

    # External-user gate (Aug 17): default-deny for non-employee identities.
    # Employees resolve to a pass-through here (cached), so this adds no DB
    # round trip to the hot path within the cache TTL.
    return apply_external_policy(request, {"email": email, "role": role, "level": level})


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


def require_level_or_modules(min_level: int, module_grants):
    """Admit users at/above `min_level` globally, OR anyone whose Access Group
    grants at least the given level for ANY entry in `module_grants` (a list of
    (module_id, min_module_level) tuples). Purely additive - a superset of what
    `min_level` alone allows. Use when a read surface is shared between audiences,
    e.g. the manager team-read audience PLUS an Employee-Tracking grant holder."""
    checks = [(mid, _MODULE_LEVEL_RANK[lvl]) for mid, lvl in module_grants]

    def _check(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
        if user["level"] >= min_level:
            return user
        g = _grants_for(user["email"], db)
        if any(g.get(mid, 0) >= th for mid, th in checks):
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


def require_any_module_grant(*module_ids: str, min_module_level: str = "viewer", bypass_level: str = "administrator"):
    """Like require_module_grant, but admits a grant on ANY of `module_ids`.

    Exists for the Tasks/Tickets family: both screens share one data provider
    (TasksContext loads tasks, tickets, teams, views, components together), so
    the API boundary is drawn at the family - either grant opens the shared
    endpoints, and which SCREEN the user can open stays per-module in the UI
    (Sidebar NAV + App's VIEW_MIN_ROLES). A user with neither grant is blocked
    here too, so UI hiding is still not the only boundary."""
    threshold = _MODULE_LEVEL_RANK[min_module_level]
    blevel = _LEVELS[bypass_level]

    def _check(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
        if user["level"] >= blevel:
            return user
        grants = _grants_for(user["email"], db)
        if any(grants.get(mid, 0) >= threshold for mid in module_ids):
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
