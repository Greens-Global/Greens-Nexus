"""Property Tickets (Neil, 10/05/2026): the property picker the ticket forms
use, and (Asset Management side) the tickets at a property.

READ-ONLY against Asset Management: nothing here touches the workspace blob -
see property_links.py for why.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

import models
import property_links
from auth import get_current_user
from database import get_db

router = APIRouter(tags=["Asset Management"], dependencies=[Depends(get_current_user)])


@router.get("/ticket-properties")
def list_ticket_properties(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Properties a ticket may be linked to - for every ticket form, so open to
    anyone signed in (like /ticket-sites). Names, parcel parent, city/state and
    tenant-unit labels only: no financials, no contacts. Deleted, vehicle and
    equipment assets are left out, and private ones for anyone Asset
    Management would hide them from."""
    rows = db.query(models.PropertyAsset).all()
    by_id = {p.id: p for p in rows}
    out = []
    for p in rows:
        if not property_links.is_listed(p, user):
            continue
        parent = by_id.get(p.parent_id) if p.parent_id else None
        parent = parent if parent is not None and property_links.is_listed(parent, user) else None
        pl = p.payload or {}
        units = [u.get("label") for u in (pl.get("tenantUnits") or [])
                 if isinstance(u, dict) and u.get("label")]
        out.append({"id": p.id, "name": property_links.display_name(p),
                    "parentId": parent.id if parent else None,
                    "parentName": property_links.display_name(parent) if parent else None,
                    "city": str(pl.get("city") or ""), "state": str(pl.get("state") or ""), "units": units})
    # Lead properties alphabetically, each followed by its parcels.
    out.sort(key=lambda x: ((x["parentName"] or x["name"]).lower(), x["parentId"] is not None, x["name"].lower()))
    return {"properties": out, "canWalkthrough": property_links.may_walkthrough(db, user)}
