"""Accounting -> Dashboard (Overview / Cash / Performance / Close): the Nexus
face of the Finance Dashboard that lives in Nexus Accounting.

Nexus never touches the accounting database. The accounting app exposes
/api/internal/dashboard behind the hashed x-internal-api-key (reads by `op`,
writes by JSON action) and this router proxies it, same shape as
routers/accounting.py: outbound HTTP in a thread so the event loop never
blocks, 424 (never 502) when the upstream is unhappy so Cloudflare cannot
mask the reason. Reads are cached briefly per query; any write clears the
cache so a ticked close task shows for the next reader at once. The caller's
name rides along on writes ("Completed by Charmi Desai") - the accounting
app has no signed-in user on this path.
"""
import asyncio
import os
import time
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
from auth import get_current_user, require_module_grant
from database import get_db

router = APIRouter(
    prefix="/accounting/dashboard",
    tags=["Accounting"],
    dependencies=[Depends(require_module_grant("accounting", "viewer"))],
)

_BASE = os.environ.get("ACCOUNTING_BASE_URL", "").rstrip("/")
_KEY = os.environ.get("ACCOUNTING_INTERNAL_KEY", "")
_PATH = "/api/internal/dashboard"
_CACHE: dict[str, tuple[float, dict]] = {}
# Ledger aggregates change only when the sync runs; the shared tables change
# whenever a teammate clicks, so they are cached for seconds, not minutes.
_TTL = {"monthly": 120.0, "cash-entities": 120.0, "budget": 300.0, "noi": 120.0, "entities": 300.0, "tables": 10.0}


def _require_configured() -> None:
    if not _BASE or not _KEY:
        raise HTTPException(status_code=503, detail="Accounting service is not configured (ACCOUNTING_BASE_URL / ACCOUNTING_INTERNAL_KEY)")


def _get_sync(params: dict) -> dict:
    r = httpx.get(f"{_BASE}{_PATH}", params=params, headers={"x-internal-api-key": _KEY}, timeout=60)
    if r.status_code != 200:
        try:
            detail = r.json().get("error") or f"Accounting service returned {r.status_code}"
        except Exception:  # noqa: BLE001 - upstream body may not be JSON
            detail = f"Accounting service returned {r.status_code}"
        raise HTTPException(status_code=424, detail=detail)
    data = r.json()
    if not data.get("ok"):
        raise HTTPException(status_code=424, detail=data.get("error") or "Accounting service error")
    return data


def _post_sync(body: dict) -> dict:
    r = httpx.post(f"{_BASE}{_PATH}", json=body, headers={"x-internal-api-key": _KEY}, timeout=60)
    try:
        data = r.json()
    except Exception:  # noqa: BLE001
        data = {}
    if r.status_code != 200 or not data.get("ok"):
        raise HTTPException(status_code=424, detail=data.get("error") or f"Accounting service returned {r.status_code}")
    return data


async def _get(op: str, params: dict) -> dict:
    _require_configured()
    clean = {"op": op, **{k: v for k, v in params.items() if v not in (None, "")}}
    key = "&".join(f"{k}={v}" for k, v in sorted(clean.items()))
    hit = _CACHE.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < _TTL.get(op, 60.0):
        return hit[1]
    data = await asyncio.to_thread(_get_sync, clean)
    _CACHE[key] = (now, data)
    return data


def _display_name(db: Session, email: str) -> str:
    emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == email).first()
    if emp and (emp.first_name or emp.last_name):
        return f"{emp.first_name or ''} {emp.last_name or ''}".strip()
    return email.split("@")[0].replace(".", " ").title()


@router.get("/ledger")
async def ledger(scope: str = "ALL", from_: str = Query(alias="from"), to: str = Query(...), book: str = "accrual"):
    """Per account per month activity plus opening balances - the one aggregate every widget derives from."""
    return await _get("monthly", {"scope": scope, "from": from_, "to": to, "book": book})


@router.get("/cash-entities")
async def cash_entities(scope: str = "ALL", asof: str = Query(...), book: str = "accrual"):
    """Cash on hand per top-level entity with the partner flag."""
    return await _get("cash-entities", {"scope": scope, "asof": asof, "book": book})


@router.get("/recon-accounts")
async def recon_accounts(scope: str = "ALL", asof: str = Query(...), book: str = "accrual"):
    """Bank and card GL accounts per entity with their balance as of a date -
    the bookkeeper's reconciliation list (Charmi, Sep 23)."""
    return await _get("recon-accounts", {"scope": scope, "asof": asof, "book": book})


@router.get("/budget")
async def budget(from_: str = Query(alias="from"), to: str = Query(...), book: str = "accrual"):
    """Budget per account per month, prorated from posted budget journals."""
    return await _get("budget", {"from": from_, "to": to, "book": book})


@router.get("/noi")
async def noi(from_: str = Query(alias="from"), to: str = Query(...), book: str = "accrual"):
    """Revenue and operating cost per top-level entity for a window."""
    return await _get("noi", {"from": from_, "to": to, "book": book})


@router.get("/entities")
async def entities():
    """Entities with the dashboard flags (partner, investors, currency, asset type)."""
    return await _get("entities", {})


@router.get("/tables")
async def tables(period: str = Query(...)):
    """Reference and team tables for one month: loans, intercompany, holdings, close plan and ticks, marks, notes, views, packages, bank recs, feed lines."""
    return await _get("tables", {"period": period})


class Action(BaseModel):
    op: str
    payload: dict[str, Any] = {}


# Writes the accounting app accepts on this path. Anything else is rejected
# here so a typo can never reach it.
_WRITE_OPS = {"close-task", "recon-mark", "note", "close-day", "view-save", "view-delete", "package-save", "package-delete", "seed"}
_EDIT_OPS = {"row-save", "row-delete"}


@router.post("/action")
async def action(body: Action, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """One write: tick a close task, mark a reconciliation, save a note or a view. Reference-data edits need the editor level."""
    if body.op in _EDIT_OPS:
        # Setup-style edits (loans, holdings, close plan...) are for editors and up.
        require_module_grant("accounting", "editor")(user=user, db=db)
    elif body.op not in _WRITE_OPS:
        raise HTTPException(status_code=400, detail="Unknown dashboard action")
    _require_configured()
    payload = {**body.payload, "op": body.op, "by": _display_name(db, user["email"])}
    data = await asyncio.to_thread(_post_sync, payload)
    # The next read must see this write.
    for k in [k for k in _CACHE if k.startswith("op=tables") or k.startswith("op=entities")]:
        _CACHE.pop(k, None)
    return data
