"""
Act As (Jul 2026) - lets a Manager/IT Admin/Global Admin temporarily operate
Nexus as another, always lower-role, employee: same screens, same data, same
permissions - approvals/submissions/uploads made while acting are attributed
to the employee, exactly as if they'd done it themselves.

Real identity is always the verified Entra ID token - auth.py never changes
that. Act As is a pure OVERLAY on top of it: once a session is active,
get_current_user returns the TARGET's {email, role, level} to every router,
so all existing permission checks, notification targeting, and ownership
fields apply completely unchanged, just scoped to whatever the target could
do. start_session only ever allows acting as someone strictly below the real
actor's own role, so the overlay can narrow what they can do, never grant
anything extra.

The real actor is never lost: audit.py reads the raw bearer token independently
of get_current_user, so every audit-log row still shows who was really at the
keyboard; it additionally records who they were acting as (see
resolve_target's use in audit.py) so the trail reads as e.g.
"pranshu@x.com (acting as jane@x.com) approved requisition REQ-12".

Permission gate reuses the existing Access-Group grant system rather than a
bespoke one: require_level_or_module admits Manager/IT Admin/Global Admin by
role today; adding 'act-as' to the frontend's MODULES list later lets a Global
Admin grant it to specific other employees via an Access Group, no backend
change needed.
"""
import time
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from auth import get_current_user, require_level_or_module, _role_for, _LEVELS
from models import ActAsSession, NexusRole

router = APIRouter(prefix="/act-as", tags=["Act As"])

SESSION_TTL_HOURS = 4
# Mirrors auth.py's _role_cache pattern: an impersonating admin's every request
# carries the session header, so without a short cache this would add a DB
# round trip to every single request for the whole time they're acting.
_SESSION_CACHE_TTL = 20.0
_session_cache: dict[str, tuple[Optional[dict], float]] = {}

_act_as_gate = require_level_or_module(_LEVELS["manager"], "act-as", "viewer")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _client_meta(request: Request) -> tuple[str, str]:
    ip = (request.headers.get("x-forwarded-for", "").split(",")[0].strip()
          or (request.client.host if request.client else ""))
    return ip[:60], (request.headers.get("user-agent", "") or "")[:300]


def _display_name(email: str, display_name: str = "") -> str:
    if display_name:
        return display_name
    return " ".join(p.capitalize() for p in email.split("@")[0].replace("_", ".").split(".") if p)


def invalidate_session_cache(session_id: str) -> None:
    prefix = f"{session_id}:"
    for key in [k for k in _session_cache if k.startswith(prefix)]:
        _session_cache.pop(key, None)


def resolve_target(session_id: str, real_email: str, db: Session) -> Optional[dict]:
    """Return the impersonated identity dict for an active, unexpired session
    bound to `real_email`, or None. Cached briefly so an impersonating admin's
    every request doesn't hit the DB - a stale cache means /act-as/stop can
    take up to _SESSION_CACHE_TTL to fully apply, the same trade-off auth.py's
    role cache already makes for role changes. Cache key includes real_email
    (not just session_id): a session only ever proves ownership together with
    the caller's own verified identity, so a cache keyed on session_id alone
    would let a second caller who guesses/reuses the id skip that check
    entirely on a cache hit within the TTL window."""
    if not session_id:
        return None
    cache_key = f"{session_id}:{real_email.lower()}"
    cached = _session_cache.get(cache_key)
    if cached and time.time() - cached[1] < _SESSION_CACHE_TTL:
        return cached[0]

    row = db.query(ActAsSession).filter(ActAsSession.id == session_id).first()
    result = None
    if row and not row.ended_at and row.real_email == real_email.lower() and row.expires_at > _iso(_now()):
        role, level = _role_for(row.target_email, db)
        result = {
            "email": row.target_email, "role": role, "level": level,
            "acting_as": True, "real_email": row.real_email,
        }
    _session_cache[cache_key] = (result, time.time())
    return result


class StartIn(BaseModel):
    target_email: str


class StopIn(BaseModel):
    session_id: str


@router.get("/eligible-targets")
def eligible_targets(user: dict = Depends(_act_as_gate), db: Session = Depends(get_db)):
    """People this caller is allowed to act as - anyone whose role is strictly
    below the caller's own (a Manager cannot act as another Manager or an
    admin; a Global Admin can act as anyone else). Same underlying data as
    /roles/directory, filtered to valid targets so the picker can't offer an
    invalid choice."""
    rows = db.query(NexusRole).order_by(NexusRole.email).all()
    out = []
    for r in rows:
        if r.email == user["email"]:
            continue
        if _LEVELS.get(r.role, 1) < user["level"]:
            out.append({"email": r.email, "name": _display_name(r.email, r.display_name or "")})
    return out


@router.post("/start")
def start_session(body: StartIn, request: Request,
                   user: dict = Depends(_act_as_gate), db: Session = Depends(get_db)):
    if user.get("acting_as"):
        raise HTTPException(status_code=409, detail="Exit your current Act As session before starting another.")

    target_email = body.target_email.lower().strip()
    if not target_email:
        raise HTTPException(status_code=400, detail="target_email is required")
    if target_email == user["email"]:
        raise HTTPException(status_code=400, detail="You can't Act As yourself")

    target_row = db.query(NexusRole).filter(NexusRole.email == target_email).first()
    target_role = target_row.role if target_row else "employee"
    target_level = _LEVELS.get(target_role, 1)
    if target_level >= user["level"]:
        raise HTTPException(status_code=403, detail="You can only Act As someone with a role strictly below your own")

    ip, ua = _client_meta(request)
    now = _now()
    row = ActAsSession(
        id=str(uuid.uuid4()), real_email=user["email"], target_email=target_email,
        started_at=_iso(now), expires_at=_iso(now + timedelta(hours=SESSION_TTL_HOURS)),
        ip=ip, user_agent=ua,
    )
    db.add(row)
    db.commit()

    return {
        "session_id": row.id,
        "target_email": target_email,
        "target_name": _display_name(target_email, target_row.display_name if target_row else ""),
        "expires_at": row.expires_at,
    }


@router.post("/stop")
def stop_session(body: StopIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Ends a session. Callable while still 'in' it - the frontend keeps the
    X-Act-As-Session header attached until Exit is clicked, so `user` here is
    the TARGET's overlaid identity; real_email on the row (not user['email'])
    is who must match to end it."""
    row = db.query(ActAsSession).filter(ActAsSession.id == body.session_id).first()
    if not row:
        return {"ok": True}
    real_email = (user.get("real_email") or user["email"]).lower()
    if row.real_email != real_email:
        raise HTTPException(status_code=403, detail="Not your Act As session")
    if not row.ended_at:
        row.ended_at = _iso(_now())
        db.commit()
    invalidate_session_cache(row.id)
    return {"ok": True}
