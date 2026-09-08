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


# ── Single sign-on into the accounting app (Nexus is the access authority) ──
# Nobody gets a password on accounting.greensglobal.com. Holding the Nexus
# "accounting" grant (or an administrator+ role, which bypasses grants app-wide)
# is the only way in: this endpoint asks the accounting app to provision the
# caller and mint a one-time handoff link, and the browser opens it. Losing the
# grant is enforced by accounting_sso.accounting_sso_sync_loop, which posts the
# full list of grant holders every few minutes so the accounting app can
# deactivate anyone who dropped off it. The grant is its own module,
# "accounting-app" ("Nexus Accounting App" in Roles & Access), separate from
# the read-only Accounting screen in Nexus. Full/owner level -> accounting
# "admin"; viewer/editor -> "member".
from sqlalchemy.orm import Session
from auth import _module_level, _LEVELS, _MODULE_LEVEL_RANK
from database import get_db
import models


def _acct_post_sync(path: str, payload: dict) -> dict:
    r = httpx.post(
        f"{_ACCT_BASE}{path}",
        json=payload,
        headers={"x-internal-api-key": _ACCT_KEY},
        timeout=30,
    )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Accounting service returned {r.status_code}")
    data = r.json()
    if not data.get("ok"):
        raise HTTPException(status_code=502, detail=data.get("error") or "Accounting service error")
    return data


def _display_name(email: str, db: Session) -> str:
    key = (email or "").lower()
    e = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == key).first()
    if e:
        name = (e.display_name or "").strip() or f"{e.first_name} {e.last_name}".strip()
        if name:
            return name
    r = db.query(models.NexusRole).filter(models.NexusRole.email == key).first()
    if r and (r.display_name or "").strip():
        return r.display_name.strip()
    return email


def accounting_role_for(user: dict, db: Session) -> str:
    """Map the caller's Nexus standing onto the accounting app's role."""
    if user["level"] >= _LEVELS["administrator"] or _module_level(user["email"], "accounting-app", db) >= _MODULE_LEVEL_RANK["full"]:
        return "admin"
    return "member"


@router.post("/launch")
async def launch_accounting(next: str | None = None, user: dict = Depends(require_module_grant("accounting-app", "viewer")), db: Session = Depends(get_db)):
    """Provision the caller in the accounting app and return a one-time URL that
    signs them in there. The URL is single-use and short-lived; the browser
    must open it immediately."""
    if not _ACCT_BASE or not _ACCT_KEY:
        raise HTTPException(status_code=503, detail="Accounting service is not configured (ACCOUNTING_BASE_URL / ACCOUNTING_INTERNAL_KEY)")
    payload = {
        "email": user["email"],
        "full_name": _display_name(user["email"], db),
        "role": accounting_role_for(user, db),
    }
    if next and next.startswith("/") and not next.startswith("//"):
        payload["next"] = next
    data = await asyncio.to_thread(_acct_post_sync, "/api/internal/sso/launch", payload)
    return {"url": data["url"], "role": payload["role"]}
