"""Operations: the "Push to Cubby" switch and the ONLY Cubby write client.

History: Nexus pushed rate and rent changes to Cubby until Oct 20 2026, when
Visesh asked for nothing to be pushed (commit 09581600 removed it). Oct 21:
"we will keep the feature of pushing but keep it locked and we add a switch
somewhere under settings to turn it on". So the push paths are back, and every
one of them is behind ONE server-side setting:

  NexusSetting `ops_cubby_push` = {"on": bool}     default OFF

  Settings > Global Settings > Operations > Push to Cubby. Administrators
  (level 4+) or an Operations grant at Full flip it (routers/ops_settings.py,
  the same gate Equipment Reminders uses for saving); every flip is an
  AuditLog row (action "ops_cubby_push_switched", who / when / from -> to).

OFF (the default): Nexus only reads from Cubby; staff enter changes in Cubby by
hand and mark them "Entered in Cubby". Every push route refuses (403, PUSH_OFF)
and `_write` below refuses BEFORE any HTTP is attempted, so no Cubby write can
leave the server even if a route forgot its own check.

ON: pushes use a Cubby key with the Manager role (CUBBY_MANAGER_API_KEY - the
sync's key is Search-only). ON with no key = a clear 503 (WRITE_MISSING), no
crash. Reads stay on ops_rate_mgmt._call, which still refuses anything that is
not a `*/search`; this module is the separate write path.

Blocking I/O - call the write helpers in a thread.
"""
from __future__ import annotations

import copy
import json
import os
from datetime import datetime, timezone

import httpx

import cubby

SETTINGS_KEY = "ops_cubby_push"
WRITE_KEY_ENV = "CUBBY_MANAGER_API_KEY"
AUDIT_ACTION = "ops_cubby_push_switched"
DEFAULTS = {"on": False}

PUSH_OFF = ("Pushing to Cubby is turned off. Nexus only reads from Cubby: enter the change in Cubby by hand, "
            "then mark it Entered in Cubby here. An administrator can turn pushing on under Settings > "
            "Global Settings > Operations.")
WRITE_MISSING = (f"Pushing to Cubby is turned on, but this server has no Cubby key with the Manager role "
                 f"({WRITE_KEY_ENV}). An administrator needs to add it; until then, enter the change in Cubby "
                 f"and mark it Entered in Cubby here.")


class PushOff(Exception):
    """A Cubby write was attempted while the switch is off. Nothing was sent."""


# ── The switch ───────────────────────────────────────────────────────────────

def _load(db) -> dict:
    import models
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTINGS_KEY).first()
    cfg = copy.deepcopy(DEFAULTS)
    meta = {"updatedBy": "", "updatedAt": ""}
    if row and row.value:
        try:
            saved = json.loads(row.value)
        except (TypeError, ValueError):
            saved = {}
        if isinstance(saved, dict) and isinstance(saved.get("on"), bool):
            cfg["on"] = saved["on"]
        meta = {"updatedBy": row.updated_by or "", "updatedAt": row.updated_at or ""}
    return {**cfg, **meta}


def get_state(db) -> dict:
    """{on, updatedBy, updatedAt}. Read fresh every time: a push decision must
    never come from a stale cache after someone turned the switch off."""
    return _load(db)


def is_on(db) -> bool:
    try:
        return bool(_load(db)["on"])
    except Exception:  # noqa: BLE001 - when in doubt, the switch is off
        return False


def write_configured() -> bool:
    """A Manager-role Cubby key is set on this server."""
    return bool(os.environ.get(WRITE_KEY_ENV, "").strip())


def status(db) -> dict:
    """What a screen needs: whether pushing is on and whether it can work."""
    on = is_on(db)
    return {"pushOn": on, "writeConfigured": write_configured(), "pushReady": on and write_configured()}


def save(db, on: bool, user: dict) -> dict:
    """Flip the switch, audit it (who, when, from -> to) and commit."""
    import models
    if not isinstance(on, bool):
        raise ValueError("on must be true or false")
    before = _load(db)["on"]
    now = datetime.now(timezone.utc).isoformat()
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTINGS_KEY).with_for_update().first()
    if not row:
        row = models.NexusSetting(key=SETTINGS_KEY)
        db.add(row)
    row.value = json.dumps({"on": on})
    row.updated_by = user["email"]
    row.updated_at = now
    db.add(models.AuditLog(
        timestamp=now, user_email=user["email"], user_role=user.get("role", ""),
        action=AUDIT_ACTION, resource_type="settings", resource_id=SETTINGS_KEY,
        details=json.dumps({"from": before, "to": on})))
    db.commit()
    try:
        import cache
        cache.settings_config.invalidate(SETTINGS_KEY)
    except Exception:  # noqa: BLE001 - nothing caches this key today; never fail a save on it
        pass
    return get_state(db)


def history(db, limit: int = 20) -> list[dict]:
    """The latest flips, newest first."""
    import models
    rows = (db.query(models.AuditLog)
            .filter(models.AuditLog.action == AUDIT_ACTION, models.AuditLog.resource_id == SETTINGS_KEY)
            .order_by(models.AuditLog.timestamp.desc()).limit(limit).all())
    out = []
    for r in rows:
        try:
            d = json.loads(r.details or "{}")
        except (TypeError, ValueError):
            d = {}
        out.append({"by": r.user_email or "", "at": r.timestamp or "", "from": d.get("from"), "to": d.get("to")})
    return out


def require_push(db) -> None:
    """Raise the HTTP answer a push route gives when it cannot push: 403 when
    the switch is off, 503 when it is on but the write key is missing."""
    from fastapi import HTTPException
    if not is_on(db):
        raise HTTPException(status_code=403, detail=PUSH_OFF)
    if not write_configured():
        raise HTTPException(status_code=503, detail=WRITE_MISSING)


# ── The write client (blocking; only reachable with the switch on) ───────────

def _write(db, path: str, body: dict) -> dict:
    """POST one Cubby write with the Manager-role key. Checks the switch
    FIRST, so with it off nothing leaves the server. Writes are flat bodies
    (no {"where"}), unlike searches."""
    if not is_on(db):
        raise PushOff(PUSH_OFF)
    key = os.environ.get(WRITE_KEY_ENV, "").strip()
    if not key:
        raise cubby.CubbyError(503, WRITE_MISSING)
    try:
        r = httpx.post(f"{cubby.BASE}/{path}", json=body, headers={"Authorization": f"Bearer {key}"}, timeout=60)
    except httpx.HTTPError as e:
        raise cubby.CubbyError(0, f"Cubby could not be reached ({type(e).__name__})") from e
    try:
        data = r.json()
    except Exception:  # noqa: BLE001 - upstream body may not be JSON
        data = {}
    if r.status_code != 200:
        errors = (data.get("errors") if isinstance(data, dict) else None) or [f"Cubby returned {r.status_code}"]
        msg = "; ".join(str(e) for e in errors)
        if r.status_code in (401, 403):
            msg += " - the API key may be a read-only (Search) key; changing Cubby needs a Manager-role key"
        raise cubby.CubbyError(r.status_code, msg)
    return (data.get("data") if isinstance(data, dict) else None) or {}


def change_rate(db, pricing_group_id: str, standard_rate: int, web_rate: int) -> dict:
    """One pricing group's new Set (standardRate) and Sell (webRate), in cents.
    https://cubbystorage.github.io/docs/api/#pricing-groups-change-rates"""
    return _write(db, "pricing-groups/change-rates", {"pricingGroups": [
        {"pricingGroupId": pricing_group_id, "standardRate": int(standard_rate), "webRate": int(web_rate)}]})


def rent_change_schedule(db, lease_id: str) -> dict | None:
    """Cubby's next possible rent change date and notice date for a lease.
    (A POST under the Manager key, so it sits behind the switch too.)"""
    got = _write(db, "leases/get-rent-change-schedules", {"leaseIds": [lease_id]})
    for s in got.get("rentChangeSchedules") or []:
        if s.get("leaseId") == lease_id:
            return s
    return None


def change_rent(db, lease_id: str, new_cents: int, change_date: str, notice: str) -> dict:
    return _write(db, "leases/change-rents", {"leases": [
        {"leaseId": lease_id, "newRentAmount": int(new_cents), "rentChangeDate": change_date, "noticeDate": notice}]})
