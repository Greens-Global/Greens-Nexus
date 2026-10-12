"""Cubby Operator API client (Site Models, Oct 2026). Read-only.

Cubby is the storage FMS; its Operator API is a JSON HTTP API of POST
"search" endpoints (docs: https://cubbystorage.github.io/docs/api/). This
module pulls one facility's unit inventory so the site model can show live
occupancy and pick up units that were added or renamed since the model was
built. Every call is synchronous (httpx); the site-models endpoints are plain
`def` routes, so FastAPI already runs them off the event loop (CLAUDE.md).

Access: an API key with the "Search" role (read-only: facilities, units,
pricing groups, leases...) issued by support@cubbystorage.com. The key goes in
`Authorization: Bearer <key>`. Keys with PII access return customer names and
contacts on lease expansions - this module never asks for those.

Environment:
  CUBBY_API_KEY         the key; unset = live link off, models show their snapshot
  CUBBY_API_BASE        default https://api.cubbystorage.com/v1
  CUBBY_CACHE_SECONDS   per-facility cache, default 300

Endpoints used, per the docs:
  POST /units/search            {"where": {"facilityId": ...}, "expansions": ["pricingGroup"]}
      -> data.units[{unitId, name, width, depth, height, floorName, leaseId,
                     rentability{rentable, unrentableReason, unrentableReasonNote},
                     pricingGroupId, overlocked, insurable, walkthroughOrder}]
         data.pricingGroups[{pricingGroupId, name, features[], parking, vehicleStorage}]
"""
from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx

_TIMEOUT = 8          # a slow Cubby must not hold a worker thread for long: the routes are sync
_FAIL_BACKOFF = 60    # seconds before a failed facility is tried again
_cache: Dict[str, Tuple[float, List[Dict[str, Any]]]] = {}
_failed: Dict[str, float] = {}
_locks: Dict[str, threading.Lock] = {}
_lock = threading.Lock()


class CubbyError(Exception):
    pass


def enabled() -> bool:
    return bool((os.getenv("CUBBY_API_KEY") or "").strip())


def _base() -> str:
    return (os.getenv("CUBBY_API_BASE") or "https://api.cubbystorage.com/v1").rstrip("/")


def _ttl() -> int:
    try:
        return max(30, int(os.getenv("CUBBY_CACHE_SECONDS") or "300"))
    except ValueError:
        return 300


def _post(path: str, body: Dict[str, Any]) -> Dict[str, Any]:
    key = (os.getenv("CUBBY_API_KEY") or "").strip()
    if not key:
        raise CubbyError("CUBBY_API_KEY is not set")
    try:
        r = httpx.post(f"{_base()}{path}", json=body, timeout=_TIMEOUT,
                       headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "Accept": "application/json"})
    except httpx.HTTPError as e:
        raise CubbyError(f"Cubby unreachable: {e.__class__.__name__}") from e
    if r.status_code != 200:
        detail = ""
        try:
            detail = (r.json().get("error") or {}).get("message") or ""
        except Exception:
            pass
        raise CubbyError(f"Cubby answered {r.status_code}{(': ' + detail) if detail else ''}")
    try:
        data = r.json()
    except ValueError as e:
        raise CubbyError("Cubby answered with something that is not JSON") from e
    return data.get("data") or {}


def _num(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _floor(v) -> int:
    s = str(v or "").strip()
    return int(s) if s.isdigit() and 0 < int(s) < 20 else 1


def normalize(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """units/search payload -> the slim unit records the site model works with."""
    groups = {g.get("pricingGroupId"): g for g in (data.get("pricingGroups") or [])}
    out = []
    for u in data.get("units") or []:
        name = str(u.get("name") or "").strip().upper()
        if not name:
            continue
        g = groups.get(u.get("pricingGroupId")) or {}
        feats = " ".join(str(f) for f in (g.get("features") or [])).lower()
        rent = u.get("rentability") or {}
        park = bool(g.get("parking") or g.get("vehicleStorage"))
        out.append({
            "n": name, "id": u.get("unitId") or "", "w": _num(u.get("width")), "d": _num(u.get("depth")),
            "t": "P" if park else "S",
            "l": 1 if u.get("leaseId") else 0,
            "r": 0 if rent.get("rentable") is False else 1,
            "why": str(rent.get("unrentableReason") or "") if rent.get("rentable") is False else "",
            "note": str(rent.get("unrentableReasonNote") or "")[:160] if rent.get("rentable") is False else "",
            "floor": _floor(u.get("floorName")),
            # None = the pricing group said nothing about power; the model's own classification then stands
            "pw": 1 if ("power" in feats or "electric" in feats) else None,
            "cc": 1 if ("climate" in feats and "not climate" not in feats) else 0,
            "du": 1 if "drive" in feats else 0,
            "group": g.get("name") or "",
            "overlocked": 1 if u.get("overlocked") else 0,
        })
    return out


def fetch_units(facility_id: str) -> List[Dict[str, Any]]:
    data = _post("/units/search", {"where": {"facilityId": facility_id}, "expansions": ["pricingGroup"]})
    return normalize(data)


def _facility_lock(facility_id: str) -> threading.Lock:
    with _lock:
        return _locks.setdefault(facility_id, threading.Lock())


def units_for(facility_id: str, max_age: Optional[int] = None) -> Tuple[Optional[List[Dict[str, Any]]], str, str]:
    """(units, as_of ISO time, error). A failed refresh falls back to the last
    good answer for this facility (with the error alongside) so a Cubby blip
    never blanks the owner's screen; with nothing cached it returns (None, '', error).
    One Cubby call per facility at a time, and a failure is not retried for
    _FAIL_BACKOFF seconds, so an outage costs one short call a minute instead
    of one per request."""
    ttl = _ttl() if max_age is None else max_age
    with _facility_lock(facility_id):
        now = time.time()
        with _lock:
            hit = _cache.get(facility_id); failed_at = _failed.get(facility_id)
        if hit and now - hit[0] < ttl:
            return hit[1], _iso(hit[0]), ""
        if failed_at and now - failed_at < _FAIL_BACKOFF:
            return (hit[1], _iso(hit[0]), "Cubby is not responding") if hit else (None, "", "Cubby is not responding")
        try:
            units = fetch_units(facility_id)
        except CubbyError as e:
            with _lock:
                _failed[facility_id] = now
            if hit:
                return hit[1], _iso(hit[0]), str(e)
            return None, "", str(e)
        with _lock:
            _cache[facility_id] = (now, units); _failed.pop(facility_id, None)
        return units, _iso(now), ""


def forget(facility_id: Optional[str] = None) -> None:
    with _lock:
        if facility_id:
            _cache.pop(facility_id, None); _failed.pop(facility_id, None)
        else:
            _cache.clear(); _failed.clear()


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
