from fastapi import APIRouter, Depends, HTTPException, Query
from auth import require_module_grant

# Grant-driven (Jun 17): a manager role no longer opens Accounting by itself -
# it needs an "accounting" Access Group grant (or IT Admin+). The router has no
# per-endpoint read/write split, so a grant = full accounting access; grant it
# only to finance people.
router = APIRouter(prefix="/accounting", tags=["Accounting"], dependencies=[Depends(require_module_grant("accounting", "viewer"))])

# The old mock endpoints (/transactions, /ramp, /ama - seeded demo rows, never
# real data) were removed Sep 8. Only ledger-backed reports live here now.

# ── Reports from Greens Accounting (Supabase mirror of the Intacct ledger) ──
# Nexus never talks to Intacct or to the accounting database directly: the
# accounting app exposes read-only /api/internal/reports/* behind a hashed
# x-internal-api-key, and this proxy calls it over HTTP (Egnyte/Ramp shape,
# NOT a second DB engine). Outbound HTTP runs in a thread so the event loop
# never blocks (see the Aug 2 freeze note in CLAUDE.md). 5-minute cache keyed
# by the query so a dashboard full of widgets costs one upstream call.
import asyncio
import os
import time

import httpx

_ACCT_BASE = os.environ.get("ACCOUNTING_BASE_URL", "").rstrip("/")
_ACCT_KEY = os.environ.get("ACCOUNTING_INTERNAL_KEY", "")
_ACCT_CACHE: dict[str, tuple[float, dict]] = {}
_ACCT_TTL = 300.0


def _acct_get_sync(path: str, params: dict) -> dict:
    r = httpx.get(
        f"{_ACCT_BASE}{path}",
        params=params,
        headers={"x-internal-api-key": _ACCT_KEY},
        timeout=30,
    )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Accounting service returned {r.status_code}")
    data = r.json()
    if not data.get("ok"):
        raise HTTPException(status_code=502, detail=data.get("error") or "Accounting service error")
    return data


async def _acct_get(path: str, params: dict) -> dict:
    if not _ACCT_BASE or not _ACCT_KEY:
        raise HTTPException(status_code=503, detail="Accounting service is not configured (ACCOUNTING_BASE_URL / ACCOUNTING_INTERNAL_KEY)")
    key = path + "?" + "&".join(f"{k}={v}" for k, v in sorted(params.items()) if v is not None)
    hit = _ACCT_CACHE.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < _ACCT_TTL:
        return hit[1]
    data = await asyncio.to_thread(_acct_get_sync, path, {k: v for k, v in params.items() if v is not None})
    _ACCT_CACHE[key] = (now, data)
    return data


@router.get("/reports/pnl")
async def report_pnl(from_: str = Query(alias="from"), to: str = Query(...), location: str | None = None):
    """Profit and loss between two ISO dates, optionally for one Intacct location."""
    return await _acct_get("/api/internal/reports/pnl", {"from": from_, "to": to, "location": location})
