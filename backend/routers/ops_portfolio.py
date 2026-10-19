"""Operations > Portfolio: the Daily Flash for any set of properties (Neil,
Oct 20 2026). Figures from `ops_portfolio.py`, which reads the same Cubby rows
as the rest of Operations. Same door as Operations (it names tenants in its
drill-down lists). Read-only."""
import asyncio
import re

from fastapi import APIRouter, Depends, HTTPException

import cubby
import ops_portfolio
from auth import require_level_or_module

router = APIRouter(
    prefix="/facility-ops",
    tags=["Operations"],
    dependencies=[Depends(require_level_or_module(2, "operations", "viewer"))],
)


@router.get("/portfolio")
async def portfolio(ids: str = "", month: str = ""):
    """`ids` = comma-separated property ids (empty = every connected one);
    `month` = YYYY-MM (empty = the current month)."""
    if month and not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month):
        raise HTTPException(status_code=422, detail="The month must look like 2026-10")
    wanted = [i.strip() for i in ids.split(",") if i.strip()][:200]
    try:
        return await asyncio.to_thread(ops_portfolio.portfolio, wanted or None, month or None)
    except cubby.CubbyError as e:
        raise HTTPException(status_code=424, detail=f"Cubby did not answer: {e.message}") from e
