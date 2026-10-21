"""Operations > Customer Map (Neil, Oct 21 2026): current customers plotted
around each Greens facility, with distance rings. The points are placed by
ops_customer_geo.py's loop; this only reads them.

Managers and above, or an Operations grant at Full - the ECRI Management
door (routers/ops_revenue.py). Everyone else gets 403.

The payload carries no customer id, name or address: customers are grouped
by rounded coordinate (about 100 m), facility, unit kind, tenure bucket and
rent band, and each group carries only a count and a rent sum. The trade area
figures (radii, distance distribution, competitors, overlap) are computed on
the server for the filtered set (ops_customer_geo.build_map).
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

import ops_customer_geo as geo
from auth import _MODULE_LEVEL_RANK, _module_level, get_current_user
from database import get_db


def _managers_or_ops_full(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if user["level"] >= 3 or _module_level(user["email"], "operations", db) >= _MODULE_LEVEL_RANK["full"]:
        return user
    raise HTTPException(status_code=403, detail="The Customer Map is for managers and administrators")


router = APIRouter(
    prefix="/facility-ops/customer-map",
    tags=["Operations"],
    dependencies=[Depends(_managers_or_ops_full)],
)


@router.get("")
def customer_map(facility: str = "all", state: str = "", kind: str = "all", since: str = "all",
                 band: str = "all", db: Session = Depends(get_db)):
    """Sync def: FastAPI runs it in its threadpool, never on the event loop.
    kind: all | storage | vehicle; since: all | 90 | 365; band: all | 0-3.
    Anything else reads as "all"."""
    out = geo.build_map(db, facility=facility or "all", state=(state or "").strip()[:2],
                        kind=(kind or "all")[:10], since=(since or "all")[:5], band=(band or "all")[:5])
    if out is None:
        raise HTTPException(status_code=404, detail="Facility not found")
    return out
