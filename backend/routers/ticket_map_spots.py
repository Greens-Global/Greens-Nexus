"""Mark an Issue on the Map - the reads (ticket_map_spot.py has the rules).

GET /ticket-map-spots?model_id=<site model id>
    The open tickets marked on that site map, for Operations > Site Map and
    Asset Management > Site Model, plus the property a new mark files under.
    Staff only: the Operations read or the Asset Management read (either
    screen shows the map). The customer pages never call this.

GET /ticket-map-spots/ticket/{ticket_id}
    One ticket's spot, for its drawer's Location on Map card. Whoever may
    open the ticket may read it (the ticket's own participant check).

Plain `def`s: FastAPI runs them in its thread pool, never on the event loop.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

import ticket_map_spot
from auth import get_current_user, require_level_or_modules
from database import get_db

router = APIRouter(tags=["Tickets"])

_staff_map = require_level_or_modules(2, [("operations", "viewer"), ("property-asset", "viewer")])


@router.get("/ticket-map-spots")
def map_spots(model_id: str = "", user: dict = Depends(_staff_map), db: Session = Depends(get_db)):
    return ticket_map_spot.spots_for_model(db, model_id, user)


@router.get("/ticket-map-spots/ticket/{ticket_id}")
def ticket_spot(ticket_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    from routers.tickets import _require_ticket_participant, _ticket_or_404
    t = _ticket_or_404(db, ticket_id)
    _require_ticket_participant(db, user, t)
    return {"spot": ticket_map_spot.spot_for_ticket(db, t)}
