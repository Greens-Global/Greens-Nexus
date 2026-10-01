"""Accounting > Budget (Charmi and Neil, 10/01: "add a budget - open and
edit"). A budget is one entity, one year: every P&L account by month. The
rows live in the accounting app's `fin_budgets` table and are read and
written through its /api/internal/budgets (contract B1 / B2) - Nexus never
touches the accounting database. Same proxy shape as routers/accounting.py:
outbound HTTP in a thread, 424 when the upstream is unhappy, and every read
checked against the caller's entity limit (`entity_scope` + `_limit`): the
entity always travels as `location`.

Until the accounting app ships the route it answers 404; that is passed on
as 501 so the screen can say "not available yet" instead of "failed".
Budget vs Actual (contract B3) is computed on the screen from this budget and
the ledger's by-month buckets, so there is nothing more here.
"""
import asyncio
import time
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_module_grant
from routers import accounting as acct
from routers.accounting import _limit, entity_scope

router = APIRouter(
    prefix="/accounting/budgets",
    tags=["Accounting"],
    dependencies=[Depends(require_module_grant("accounting", "viewer"))],
)

_PATH = "/api/internal/budgets"
_NOT_READY = "Not available yet - the accounting app needs its update."
_CACHE: dict[str, tuple[float, dict]] = {}
_TTL = 60.0
_MAX_ROWS = 2000


def _configured() -> None:
    if not acct._ACCT_BASE or not acct._ACCT_KEY:
        raise HTTPException(status_code=503, detail="Accounting service is not configured (ACCOUNTING_BASE_URL / ACCOUNTING_INTERNAL_KEY)")


def _answer(r) -> dict:
    if r.status_code == 404:
        raise HTTPException(status_code=501, detail=_NOT_READY)
    if r.status_code != 200:
        raise HTTPException(status_code=424, detail=acct._upstream_detail(r))
    data = r.json()
    if not data.get("ok"):
        raise HTTPException(status_code=424, detail=data.get("error") or "Accounting service error")
    return data


def _get_sync(params: dict) -> dict:
    r = httpx.get(f"{acct._ACCT_BASE}{_PATH}", params=params, headers={"x-internal-api-key": acct._ACCT_KEY}, timeout=30)
    return _answer(r)


def _put_sync(payload: dict) -> dict:
    r = httpx.put(f"{acct._ACCT_BASE}{_PATH}", json=payload, headers={"x-internal-api-key": acct._ACCT_KEY}, timeout=60)
    return _answer(r)


async def _get(params: dict) -> dict:
    """Tests replace this; the screen's reads go through the short cache."""
    _configured()
    clean = {k: v for k, v in params.items() if v not in (None, "")}
    key = "&".join(f"{k}={v}" for k, v in sorted(clean.items()))
    hit = _CACHE.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < _TTL:
        return hit[1]
    data = await asyncio.to_thread(_get_sync, clean)
    _CACHE[key] = (now, data)
    return data


async def _put(payload: dict) -> dict:
    _configured()
    data = await asyncio.to_thread(_put_sync, payload)
    _CACHE.clear()
    return data


def _year(v: int) -> int:
    if not 2000 <= int(v) <= 2100:
        raise HTTPException(status_code=400, detail="year must be between 2000 and 2100")
    return int(v)


def _shape(data: dict) -> dict:
    """The accounting app may keep snake_case; the screen reads camelCase."""
    rows = []
    for r in data.get("rows") or []:
        months = list(r.get("months") or [])[:12]
        months += [0] * (12 - len(months))
        rows.append({"accountNo": r.get("accountNo") or r.get("account_no") or "", "title": r.get("title") or "",
                     "months": [round(float(m or 0), 2) for m in months]})
    return {"location": data.get("location") or "", "year": data.get("year"), "source": data.get("source") or "none",
            "updatedAt": data.get("updatedAt") or data.get("updated_at") or "", "updatedBy": data.get("updatedBy") or data.get("updated_by") or "",
            "rows": rows}


@router.get("")
async def get_budget(location: str, year: int, source: Optional[str] = None, scope: dict = Depends(entity_scope)):
    """The budget grid for one entity and year (B1). `source=intacct` asks for
    the Intacct budget as pulled, for "copy from the Intacct budget"; the
    accounting app may answer with whatever it holds, and the screen reads
    `source` on the way back."""
    if not (location or "").strip():
        raise HTTPException(status_code=400, detail="Pick an entity.")
    loc, _ = await _limit(scope, location.strip(), None)
    params = {"location": loc, "year": _year(year)}
    if source == "intacct":
        params["source"] = "intacct"
    return _shape(await _get(params))


class BudgetRow(BaseModel):
    accountNo: str
    months: list[float]


class BudgetBody(BaseModel):
    location: str
    year: int
    rows: list[BudgetRow]


@router.put("")
async def put_budget(body: BudgetBody, scope: dict = Depends(entity_scope), user: dict = Depends(require_module_grant("accounting", "editor"))):
    """Save the grid (B2): upserts every row sent, stamped with the editor."""
    if not (body.location or "").strip():
        raise HTTPException(status_code=400, detail="Pick an entity.")
    loc, _ = await _limit(scope, body.location.strip(), None)
    if len(body.rows) > _MAX_ROWS:
        raise HTTPException(status_code=400, detail=f"At most {_MAX_ROWS} accounts in one save.")
    rows = []
    for r in body.rows:
        code = (r.accountNo or "").strip()
        if not code:
            continue
        months = [round(float(m or 0), 2) for m in list(r.months)[:12]]
        months += [0.0] * (12 - len(months))
        rows.append({"accountNo": code, "months": months})
    data = await _put({"location": loc, "year": _year(body.year), "rows": rows, "by": user["email"]})
    return _shape(data)
