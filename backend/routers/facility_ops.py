"""Operations (storage facilities): the figures behind the Operations screen,
read from Cubby through `cubby.py`. One read endpoint - the screen filters by
facility and tab on its own, so switching either is instant.

Same door as the sidebar: supervisors and above, or anyone whose Access Group
grants the Operations module. The payload names tenants who owe money, so it
is never open to everyone signed in.
"""
import asyncio

from fastapi import APIRouter, Depends, HTTPException

import cubby
from auth import require_level_or_module

router = APIRouter(
    prefix="/facility-ops",
    tags=["Operations"],
    dependencies=[Depends(require_level_or_module(2, "operations", "viewer"))],
)


@router.get("/summary")
async def summary(fresh: bool = False):
    if not cubby.configured():
        raise HTTPException(status_code=503, detail="Cubby is not connected (CUBBY_API_KEY is not set)")
    try:
        return await asyncio.to_thread(cubby.summary, fresh)
    except cubby.CubbyError as e:
        # 424, never 502: Cloudflare replaces a 502 body and hides the reason.
        raise HTTPException(status_code=424, detail=f"Cubby did not answer: {e.message}") from e
