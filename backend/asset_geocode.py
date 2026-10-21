"""Asset Management geocoding, on the server (Oct 21 2026).

The portfolio map used to geocode every address from the browser, one call a
second to nominatim.openstreetmap.org, on every open - against Nominatim's
usage policy, a leak of the portfolio's addresses from every viewer's machine,
and a map that opened on all of North America and filled at a pin a second.

Now a loop here (main.py lifespan, in a thread, never on the event loop) looks
up each asset's address ONCE through the same Nominatim endpoint the location
setup already uses (site_address.py), paced at one request a second with a
User-Agent, and keeps the point on the asset's payload:

    payload["geo"] = {"lat": 33.1, "lng": -117.1, "for": "<the address it stands for>", "at": "<iso>"}

A miss is kept too (lat/lng None) so an address Nominatim cannot place is not
asked again for a month; a changed address is looked up again because `for`
no longer matches. Private assets (officers' residences) are never sent out.
The workspace ts is bumped whenever a point lands so open tabs pull it.
"""
import asyncio
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

from database import SessionLocal
from models import PropertyAsset, PropertyWorkspaceMeta

PACE_SECONDS = 1.1          # Nominatim: at most one request a second
BATCH = 25                  # assets per pass
RETRY_MISS_DAYS = 30
_UA = "GreensNexus/1.0 (asset portfolio map; one lookup per address)"


def address_of(payload: dict) -> str:
    """The address string the map pins - street, city, state, country - or ''."""
    if not payload or not (payload.get("address") or payload.get("city")):
        return ""
    parts = [str(payload.get(k) or "").strip() for k in ("address", "city", "state", "country")]
    return ", ".join(p for p in parts if p)


def needs_lookup(payload: dict, now: Optional[datetime] = None) -> bool:
    if payload.get("private") or payload.get("deleted"):
        return False
    addr = address_of(payload)
    if not addr:
        return False
    geo = payload.get("geo") or {}
    if geo.get("for") != addr:
        return True
    if geo.get("lat") is None:                      # a miss: ask again after a month
        try:
            at = datetime.fromisoformat(str(geo.get("at") or "").replace("Z", "+00:00"))
        except ValueError:
            return True
        return (now or datetime.now(timezone.utc)) - at > timedelta(days=RETRY_MISS_DAYS)
    return False


def _nominatim_search(query: str) -> Optional[tuple]:
    import httpx
    with httpx.Client(timeout=8.0, headers={"User-Agent": _UA, "Accept": "application/json"}) as c:
        r = c.get("https://nominatim.openstreetmap.org/search",
                  params={"format": "json", "limit": 1, "q": query})
    if r.status_code != 200:
        raise RuntimeError(f"nominatim {r.status_code}")
    rows = r.json() or []
    if not rows:
        return None
    return float(rows[0]["lat"]), float(rows[0]["lon"])


def geocode_pending(db, fetch=None, limit: int = BATCH, pace=None) -> int:
    """Looks up assets whose address has no point yet; how many it wrote.
    `fetch(query) -> (lat, lng) | None` and `pace()` are injectable for tests."""
    fetch = fetch or _nominatim_search
    pace = pace if pace is not None else (lambda: time.sleep(PACE_SECONDS))
    now = datetime.now(timezone.utc)
    done = 0
    for p in db.query(PropertyAsset).all():
        if done >= limit:
            break
        payload = dict(p.payload or {})
        if not needs_lookup(payload, now):
            continue
        addr = address_of(payload)
        try:
            hit = fetch(addr)
        except Exception as e:  # noqa: BLE001 - one bad lookup must not stop the pass
            print(f"[asset-geocode] {p.id}: {e}")
            break                                   # the service is unhappy; try again next pass
        # The lookup took a second or more; someone may have saved this asset
        # meanwhile. Write the point onto the row as it is NOW, and only if the
        # address is still the one looked up.
        db.refresh(p)
        payload = dict(p.payload or {})
        if address_of(payload) != addr:
            pace()
            continue
        payload["geo"] = {"lat": hit[0] if hit else None, "lng": hit[1] if hit else None,
                          "for": addr, "at": now.isoformat()}
        p.payload = payload
        meta = db.get(PropertyWorkspaceMeta, 1)
        if meta is not None:
            meta.ts = int(time.time() * 1000)
        db.commit()
        done += 1
        pace()
    return done


def run_pass() -> int:
    db = SessionLocal()
    try:
        return geocode_pending(db)
    finally:
        db.close()


async def geocode_loop():
    await asyncio.sleep(45)                         # let startup settle
    while True:
        try:
            n = await asyncio.to_thread(run_pass)
            if n:
                print(f"[asset-geocode] placed {n} asset{'s' if n != 1 else ''}")
        except Exception as e:  # noqa: BLE001
            print(f"[asset-geocode] loop error: {e}")
        await asyncio.sleep(600)
