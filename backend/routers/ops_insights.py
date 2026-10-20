"""Operations > Pricing Insights (Visesh, Oct 20 2026).

  GET /facility-ops/insights?facility_id=   ranked insights, the per-facility
      Overview, and (for one facility) Competitive Pricing, Trends, Standard
      Rates, ECRI and Revenue at Risk. ops_insights.py builds it from the rows
      the Cubby sync keeps (cubby_sync.py + cubby_pricing.py) and the
      competitor rates Market Rates keeps.

Same door as the rest of Operations (supervisors and above, or an Operations
grant): the payload names tenants (name, unit, money - never contact
details), like the summary and Revenue Management. Read only: nothing here
writes to Cubby or anywhere else. The work is blocking database reads, so it
runs in a thread (CLAUDE.md: never on the event loop).
"""
import asyncio

from fastapi import APIRouter, Depends, HTTPException

import cubby
import ops_insights
from auth import require_level_or_module

router = APIRouter(
    prefix="/facility-ops/insights",
    tags=["Operations"],
    dependencies=[Depends(require_level_or_module(2, "operations", "viewer"))],
)


@router.get("")
async def insights(facility_id: str = ""):
    try:
        return await asyncio.to_thread(ops_insights.payload, facility_id)
    except cubby.CubbyError as e:
        # 424, never 502 (Cloudflare replaces a 502 body and hides the reason).
        raise HTTPException(status_code=424, detail=f"Cubby did not answer: {e.message}") from e
