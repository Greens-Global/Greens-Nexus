"""Operations: what is open at each unit of a store, for the map layer
(Neil, Ops review Oct 20 2026).

GET /facility-ops/maintenance-map?facility_id=<cubby facility id>

    {"units":    {"<unit label>": [item, ...]},
     "property": [item, ...]}            # items with no unit (common areas)

    item = {"id", "title", "status", "priority", "kind": "ticket"|"maintenance", "opened_at"}

Only open / active items:
  * tickets linked to the facility's property (or one of its parcels) that are
    not Resolved / Closed - unit from the ticket's Unit field;
  * hand-logged Maintenance Log entries (property_records, collection
    "maintenance") whose status is Scheduled / In Progress / Needs Attention;
  * open "maintenance" pins on the property's site model that are not just a
    ticket's pin (the ticket is already listed).

The facility is mapped to its Asset Management property by
ticket_property_link.property_for_facility. A facility with no property
answers empty lists. Same door as the rest of /facility-ops: Operations read.
A private property stays private: someone who could not open it in Asset
Management gets empty lists, and the company wall applies to tickets.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

import models
import property_links
import ticket_property_link as L
from auth import get_current_user, require_level_or_module
from database import get_db

router = APIRouter(
    prefix="/facility-ops",
    tags=["Operations"],
    dependencies=[Depends(require_level_or_module(2, "operations", "viewer"))],
)

ACTIVE_MANUAL = {"scheduled", "in progress", "needs attention"}


def _place(out: dict, unit: str, item: dict) -> None:
    unit = (unit or "").strip()
    if unit and unit != L.COMMON_AREA:
        out["units"].setdefault(unit, []).append(item)
    else:
        out["property"].append(item)


def build_map(db: Session, facility_id: str, user: dict) -> dict:
    out = {"units": {}, "property": []}
    prop = L.property_for_facility(db, facility_id)
    if prop is None or not property_links.viewable(prop, user):
        return out
    ids = property_links.group_ids(db, prop, user)
    unit_names = {u.lower(): u for u in L.cubby_units(db, (facility_id or "").strip())}

    def canon(u) -> str:
        u = " ".join(str(u or "").split())
        return unit_names.get(u.lower(), u)

    import auth
    scope = auth.company_scope(user, db)
    tickets = (db.query(models.TaskTicket)
               .filter(models.TaskTicket.property_asset_id.in_(ids))
               .filter(models.TaskTicket.status.notin_(property_links.CLOSED_STATES)).all())
    for t in tickets:
        if scope is not None and (t.company_id or "") not in scope:
            continue
        status = t.status if (t.status and t.status != "new") else "open"
        _place(out, canon(t.property_unit), {
            "id": t.id, "title": t.subject or "", "status": status, "priority": t.priority or "medium",
            "kind": "ticket", "opened_at": t.created_at or ""})
    for r in (db.query(models.PropertyRecord)
              .filter(models.PropertyRecord.collection == "maintenance",
                      models.PropertyRecord.property_id.in_(ids)).all()):
        pl = r.payload or {}
        if str(pl.get("status") or "").strip().lower() not in ACTIVE_MANUAL:
            continue
        _place(out, canon(pl.get("unit")), {
            "id": r.id, "title": str(pl.get("description") or pl.get("system") or "Maintenance"),
            "status": str(pl.get("status") or ""), "priority": "medium" if pl.get("status") != "Needs Attention" else "high",
            "kind": "maintenance", "opened_at": str(pl.get("date") or r.updated_at or "")})
    # Site model pins: the model's id is not always the property's (see
    # ticket_property_link._match_model), so match through the facility.
    model_ids = [m["id"] for m in L._site_models() if (m.get("cubbyFacilityId") or "") == (facility_id or "").strip()]
    if model_ids:
        for pin in (db.query(models.SiteModelMarkup)
                    .filter(models.SiteModelMarkup.property_id.in_(model_ids),
                            models.SiteModelMarkup.category == "maintenance",
                            models.SiteModelMarkup.status == "open").all()):
            if pin.ticket_id:
                continue   # a ticket's pin - the ticket is the item (or it is closed / walled off)
            _place(out, canon(pin.unit), {
                "id": pin.id, "title": pin.title or "Maintenance", "status": pin.status or "open",
                "priority": "medium", "kind": "maintenance", "opened_at": pin.created_at or ""})
    for items in [*out["units"].values(), out["property"]]:
        items.sort(key=lambda i: i["opened_at"] or "", reverse=True)
    return out


@router.get("/maintenance-map")
def maintenance_map(facility_id: str = "", user: dict = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    # A plain `def`: FastAPI runs it in its thread pool, never on the loop.
    return build_map(db, facility_id, user)
