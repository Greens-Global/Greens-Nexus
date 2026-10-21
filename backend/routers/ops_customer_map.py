"""Operations > Customer Map (Neil, Oct 21 2026): current customers plotted
around each Greens facility, with distance rings. The points are placed by
ops_customer_geo.py's loop; this only reads them.

Managers and above, or an Operations grant at Full - the ECRI Management
door (routers/ops_revenue.py). Everyone else gets 403.

The payload carries no customer id, name or address: points are grouped by
identical rounded coordinate (about 100 m) and carry only a count.
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
def customer_map(facility: str = "all", state: str = "", db: Session = Depends(get_db)):
    """Sync def: FastAPI runs it in its threadpool, never on the event loop."""
    out = geo.build_map(db, facility=facility or "all", state=(state or "").strip()[:2])
    if out is None:
        raise HTTPException(status_code=404, detail="Facility not found")
    return out
