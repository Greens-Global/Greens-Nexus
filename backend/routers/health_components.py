"""GET /health/components - Nexus reporting on its own parts, for the status
page (Oct 27 2026, `status/` at the repo root: a Cloudflare Worker that checks
Nexus every minute from OUTSIDE it, so the page and its alerts survive a Nexus
outage).

/health says the API answers and /health/ready that the database is reachable;
neither says whether file storage, Microsoft 365 or the background jobs work.
This answers that, one entry per component:

    {"status": "operational" | "degraded" | "down" | "unknown",
     "latencyMs": 12, "note": "short, safe text"}

Public and unauthenticated like the other /health probes (and rate-limit
exempt through the "/health" prefix), so it says WHAT is wrong, never why in
detail: no error strings, hostnames or keys - a note is one of a few fixed
phrases. The whole answer is cached for CACHE_SECONDS, and the outbound checks
(storage, Microsoft 365) for SLOW_CACHE_SECONDS, so a flood of probes cannot
turn into a flood of database queries or Microsoft sign-ins.

`def` (not `async def`): FastAPI runs it in a worker thread, so the blocking
database and HTTP calls never sit on the event loop (CLAUDE.md).
"""
import os
import sys
import threading
import time

import httpx
from fastapi import APIRouter
from sqlalchemy import text

router = APIRouter(tags=["Health"])

CACHE_SECONDS = 20
SLOW_CACHE_SECONDS = 300
DB_SLOW_MS = 2000
HEARTBEAT_DEGRADED_S = 30
HEARTBEAT_DOWN_S = 45            # leader.py: over 45s another instance takes over

_lock = threading.Lock()
_cache: dict = {"at": 0.0, "body": None}
_slow: dict = {}                 # name -> (at, result)

_RANK = {"operational": 0, "unknown": 1, "degraded": 2, "down": 3}


def _result(status: str, note: str = "", latency_ms: int | None = None) -> dict:
    out = {"status": status, "note": note}
    if latency_ms is not None:
        out["latencyMs"] = latency_ms
    return out


def _ms(start: float) -> int:
    return int((time.perf_counter() - start) * 1000)


def _check_database() -> dict:
    from database import SessionLocal
    start = time.perf_counter()
    db = SessionLocal()
    try:
        db.execute(text("SELECT 1"))
        ms = _ms(start)
        return _result("degraded" if ms > DB_SLOW_MS else "operational",
                       "Slow to answer" if ms > DB_SLOW_MS else "", ms)
    except Exception:  # noqa: BLE001 - a probe reports, never raises
        return _result("down", "Not reachable")
    finally:
        db.close()


def _check_background_jobs() -> dict:
    """The leader lease heartbeat (leader.py): the one instance running the
    reminder, digest, no-show and email loops beats every 15 seconds."""
    import leader
    if leader._IS_SQLITE:
        return _result("operational", "Single process")
    from database import SessionLocal
    db = SessionLocal()
    try:
        row = db.execute(text(
            "SELECT round(extract(epoch FROM (now() - heartbeat_at))) FROM nexus_leader WHERE id = 1"
        )).first()
        if not row or row[0] is None:
            return _result("down", "No job runner")
        age = int(row[0])
        if age > HEARTBEAT_DOWN_S:
            return _result("down", "Job runner silent")
        if age > HEARTBEAT_DEGRADED_S:
            return _result("degraded", "Job runner late")
        return _result("operational")
    except Exception:  # noqa: BLE001
        return _result("unknown", "Could not read")
    finally:
        db.close()


def _check_schema() -> dict:
    """Model columns missing from the live database (main.SCHEMA_GAPS): one
    module's screens fail while everything else is fine - degraded, not down."""
    main = sys.modules.get("main")
    gaps = getattr(main, "SCHEMA_GAPS", None) if main else None
    if gaps is None:
        return _result("unknown")
    return _result("degraded", "Some screens may fail") if gaps else _result("operational")


def _check_storage() -> dict:
    base = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_KEY", "").strip()
    if not base or not key:
        return _result("unknown", "Not configured")
    start = time.perf_counter()
    try:
        r = httpx.get(f"{base}/storage/v1/bucket", timeout=8,
                      headers={"apikey": key, "Authorization": f"Bearer {key}"})
        ms = _ms(start)
        if r.status_code == 200:
            return _result("operational", "", ms)
        return _result("down" if r.status_code >= 500 else "degraded", "Unexpected answer", ms)
    except Exception:  # noqa: BLE001
        return _result("down", "Not reachable")


def _check_microsoft() -> dict:
    """Sign-in, email and Teams all ride the Entra app: a fresh app-only token
    proves Microsoft is reachable and our app's credentials still work.
    Deliberately NOT graph_mail.access_token(), whose 45-minute cache would
    hide an outage."""
    import graph_mail
    if not graph_mail.graph_configured():
        return _result("unknown", "Not configured")
    start = time.perf_counter()
    try:
        graph_mail._graph_token()
        return _result("operational", "", _ms(start))
    except httpx.HTTPStatusError as e:
        code = e.response.status_code if e.response is not None else 0
        # 4xx = our credentials (expired secret, revoked consent): a real
        # problem for every email, but not Microsoft being down.
        return _result("down" if code >= 500 else "degraded",
                       "Microsoft unavailable" if code >= 500 else "Credentials rejected")
    except Exception:  # noqa: BLE001
        return _result("down", "Not reachable")


def _slow_cached(name: str, fn) -> dict:
    at, res = _slow.get(name, (0.0, None))
    if res is None or time.time() - at > SLOW_CACHE_SECONDS:
        res = fn()
        _slow[name] = (time.time(), res)
    return res


def build() -> dict:
    components = {
        "database": _check_database(),
        "backgroundJobs": _check_background_jobs(),
        "schema": _check_schema(),
        "storage": _slow_cached("storage", _check_storage),
        "microsoft365": _slow_cached("microsoft365", _check_microsoft),
    }
    worst = max((c["status"] for c in components.values()), key=lambda s: _RANK.get(s, 1))
    return {"overall": worst, "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "components": components}


@router.get("/health/components")
def health_components():
    with _lock:
        if _cache["body"] is None or time.time() - _cache["at"] > CACHE_SECONDS:
            _cache["body"] = build()
            _cache["at"] = time.time()
        return _cache["body"]
