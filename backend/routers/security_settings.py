"""Settings > Global > Security > Sign-In & Sessions (Sep 2026).

GET  /security-settings  administrator+ : every setting with its effective
                         value, where it comes from, bounds and lock state.
PUT  /security-settings  Global Admin (owner) only : save overrides. A value
                         of null clears the saved override (Reset to Default:
                         the env var, else the built-in default, applies).

The store, precedence and bounds live in security_config.py. Every change
writes one audit row carrying the old and new effective values. Act As cannot
reach PUT with a borrowed identity: get_current_user overlays the (strictly
lower-role) target, so an impersonating owner is not an owner here.
"""
import json
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

import security_config as sec
from auth import require_administrator, require_owner
from database import get_db
from models import AuditLog, NexusSetting

router = APIRouter(prefix="/security-settings", tags=["Security Settings"])


def _payload(db: Session, user: dict) -> dict:
    return {"settings": sec.describe(db), "canEdit": user.get("level", 0) >= 5}


@router.get("")
def get_security_settings(user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    return _payload(db, user)


class SecurityIn(BaseModel):
    values: dict[str, Any] = {}
    # Required (true) when the change turns step-up enforcement or
    # MFA-required OFF - the UI sends it only after an explicit confirm.
    confirmWeaken: Optional[bool] = False


def _client_ip(request: Request) -> str:
    fwd = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    return (fwd or (request.client.host if request.client else ""))[:60]


@router.put("")
def put_security_settings(body: SecurityIn, request: Request,
                          user: dict = Depends(require_owner), db: Session = Depends(get_db)):
    unknown = [k for k in body.values if k not in sec.SETTINGS]
    if unknown:
        raise HTTPException(400, f"Unknown setting: {', '.join(sorted(unknown))}")

    row = db.query(NexusSetting).filter(NexusSetting.key == sec.SETTINGS_KEY).first()
    try:
        current = json.loads(row.value) if row and row.value else {}
        if not isinstance(current, dict):
            current = {}
    except (TypeError, ValueError):
        current = {}
    # Drop anything no longer valid so a stale key never lingers in the blob.
    current = {k: v for k, v in current.items() if k in sec.SETTINGS and sec.in_bounds(k, v)}
    before = {k: sec.resolve(k, current)[0] for k in sec.SETTINGS}

    updated = dict(current)
    for key, raw in body.values.items():
        d = sec.SETTINGS[key]
        if raw is None:
            updated.pop(key, None)
            continue
        if d["type"] == "bool":
            if not isinstance(raw, bool):
                raise HTTPException(400, f"{key} must be true or false")
            if raw is False and sec.env_locked(key):
                raise HTTPException(400, f"{key} is turned on by the server configuration and cannot be turned off here")
            updated[key] = raw
        else:
            # Accept 300 or 300.0 from JSON, never a fraction, string or bool.
            if isinstance(raw, float) and raw.is_integer():
                raw = int(raw)
            if isinstance(raw, bool) or not isinstance(raw, int):
                raise HTTPException(400, f"{key} must be a whole number")
            if not sec.in_bounds(key, raw):
                raise HTTPException(400, f"{key} must be between {d['min']} and {d['max']} {d['unit']}")
            updated[key] = raw

    after = {k: sec.resolve(k, updated)[0] for k in sec.SETTINGS}
    weakened = [k for k in sec.SAFETY_TOGGLES if before[k] and not after[k]]
    if weakened and not body.confirmWeaken:
        raise HTTPException(400, {
            "code": "confirm_required",
            "message": "Turning this off weakens sign-in security. Confirm the change to continue.",
            "settings": weakened,
        })

    changes = {k: {"old": before[k], "new": after[k]} for k in sec.SETTINGS if before[k] != after[k]}
    saved_changes = sorted(k for k in sec.SETTINGS if current.get(k, None) != updated.get(k, None))
    if not saved_changes:
        return _payload(db, user)

    now = datetime.now(timezone.utc).isoformat()
    if not row:
        row = NexusSetting(key=sec.SETTINGS_KEY)
        db.add(row)
    row.value = json.dumps(updated, sort_keys=True)
    row.updated_by = user["email"]
    row.updated_at = now
    db.add(AuditLog(
        timestamp=now, user_email=user["email"], user_role=user.get("role", ""),
        action="security_settings_updated", resource_type="security_settings",
        resource_id=sec.SETTINGS_KEY, ip_address=_client_ip(request),
        details=json.dumps({"changes": changes, "savedKeys": saved_changes,
                            "weakened": weakened}, sort_keys=True),
    ))
    db.commit()           # cache.wire drops settings_config on this worker at commit
    return _payload(db, user)
