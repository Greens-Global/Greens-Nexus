"""Mark an Issue on the Map (Charmi Desai, Oct 20 2026): "if anyone wants to
create a ticket ... go to the map and physically mark it out saying fix right
here ... so when a maintenance guy gets the ticket, he knows exactly what
they're talking about with picture and a location."

The ticket is a normal ticket in OUR Tickets module, filed through
routers/tickets.file_ticket (same checks, routing, default assignee, the
property's asset manager's bell, emails). This module only adds its SPOT:

  * clean()  - the `map_spot` a create sends, checked before anything is
               written: a real site model, of the ticket's own property (or
               its lead property / one of its parcels), finite coordinates
               inside the site frame, a radius, an optional free-hand outline.
  * attach() - stores it as a site_model_markups row with ticket_id set (the
               table Asset Management's pins already live in), lat / lng from
               the model's geo frame computed HERE, never taken from the client.
  * spots_for_model() / spot_for_ticket() - what the Site Map and the ticket
               drawer show. Staff reads only: the customer /find and /map
               pages never read this table.

Closed tickets drop off the map (the spot stays as the record). A private
property stays private and the company wall applies, as on the maintenance
layer (facility_maintenance_map.build_map).
"""
import json
import math
import re
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy.orm import Session

import models
import property_links

COORD_MAX = 5000.0      # meters from the frame origin (routers/site_models._COORD_MAX)
RADIUS_MAX = 250.0      # a circle bigger than this is the whole site - say so in words
OUTLINE_MAX = 200       # points in a free-hand outline
PLACE_MAX = 120
_UNIT = re.compile(r"^[A-Z0-9-]{0,12}$")
_MODEL = re.compile(r"[a-z0-9][a-z0-9-]{1,80}")   # routers/site_models._SLUG, always fullmatch


def _num(x, what: str) -> float:
    try:
        f = float(x)
    except (TypeError, ValueError):
        raise HTTPException(400, f"The map spot's {what} must be a number.")
    if not math.isfinite(f):
        raise HTTPException(400, f"The map spot's {what} must be a number.")
    return f


def _coord(x, what: str) -> float:
    f = _num(x, what)
    if abs(f) > COORD_MAX:
        raise HTTPException(400, "That spot is outside the site.")
    return round(f, 2)


def _model(model_id: str) -> dict:
    from routers import site_models
    mid = (model_id or "").strip()
    if not _MODEL.fullmatch(mid):
        raise HTTPException(400, "Mark the spot on a property's site map.")
    try:
        return site_models.load_model(mid)
    except HTTPException:
        raise HTTPException(400, "That site map is not available - mark the spot again.")


def property_for_model(db: Session, model_id: str, model: dict | None = None):
    """The Asset Management property a site model is about: through its Cubby
    facility (ticket_property_link.property_for_facility, admin overrides
    included), else matched by id / APN / name."""
    import ticket_property_link as L
    model = model if model is not None else _model(model_id)
    fid = ((model.get("property") or {}).get("cubbyFacilityId") or "").strip()
    hit = L.property_for_facility(db, fid) if fid else None
    if hit is None:
        meta = {"id": model_id, "apn": (model.get("property") or {}).get("apn") or model.get("apn"),
                "name": (model.get("property") or {}).get("name") or model.get("name")}
        hit = L._match_model(meta, L._listed(db))
    return hit


def _same_place(db: Session, prop, model_prop) -> bool:
    if prop is None or model_prop is None:
        return False
    ids = {model_prop.id, model_prop.parent_id or ""}
    ids |= {k.id for k in db.query(models.PropertyAsset).filter(models.PropertyAsset.parent_id == model_prop.id).all()}
    return prop.id in ids or (prop.parent_id or "") == model_prop.id


def clean(db: Session, raw, prop) -> dict | None:
    """The create's `map_spot`, checked. None when none was sent. Raises 400."""
    if raw in (None, {}, ""):
        return None
    if not isinstance(raw, dict):
        raise HTTPException(400, "The map spot has the wrong shape.")
    if prop is None:
        raise HTTPException(400, "Pick the property before marking the spot on its map.")
    mid = str(raw.get("modelId") or "").strip()
    model = _model(mid)
    if not _same_place(db, prop, property_for_model(db, mid, model)):
        raise HTTPException(400, f"That map is not {property_links.display_name(prop)}'s - mark the spot on its own map.")
    r = _num(raw.get("r") or 0, "radius")
    if r < 0 or r > RADIUS_MAX:
        raise HTTPException(400, f"Circle a smaller spot (up to {int(RADIUS_MAX)} m across the site).")
    outline = []
    pts = raw.get("outline") or []
    if not isinstance(pts, list):
        raise HTTPException(400, "The outline has the wrong shape.")
    if len(pts) > OUTLINE_MAX:
        raise HTTPException(400, "The outline has too many points - draw it again.")
    for p in pts:
        if not isinstance(p, (list, tuple)) or len(p) != 2:
            raise HTTPException(400, "The outline has the wrong shape.")
        outline.append([_coord(p[0], "outline"), _coord(p[1], "outline")])
    if len(outline) and len(outline) < 3:
        outline = []
    unit = str(raw.get("unit") or "").strip().upper()
    if not _UNIT.fullmatch(unit):
        unit = ""
    building = re.sub(r"[^A-Za-z0-9 _-]", "", str(raw.get("building") or ""))[:40]
    place = " ".join(str(raw.get("place") or "").split())[:PLACE_MAX]
    return {"modelId": mid, "model": model, "u": _coord(raw.get("u"), "position"), "v": _coord(raw.get("v"), "position"),
            "y": max(-50.0, min(300.0, round(_num(raw.get("y") or 0, "height"), 2))), "r": round(r, 2),
            "outline": outline, "unit": unit, "building": building, "place": place}


def attach(db: Session, t, spot: dict | None, actor: str):
    """The cleaned spot as the ticket's markup row. Does not commit."""
    if not spot:
        return None
    from routers.unit_map import gate_latlng
    ll = gate_latlng(spot["model"], (spot["u"], spot["v"])) or {}
    now = datetime.now(timezone.utc).isoformat()
    row = models.SiteModelMarkup(
        id=str(uuid.uuid4()), property_id=spot["modelId"], unit=spot["unit"], building=spot["building"],
        u=spot["u"], v=spot["v"], y=spot["y"], title=(t.subject or "")[:120], category="maintenance",
        status="open", ticket_id=t.id, created_by=(actor or "").lower(), created_at=now, updated_at=now,
        radius=spot["r"], outline=json.dumps(spot["outline"]) if spot["outline"] else "",
        lat=ll.get("lat"), lng=ll.get("lng"), place=spot["place"])
    db.add(row)
    return row


# ── Reads ─────────────────────────────────────────────────────────────────────

def _photos(db: Session, ticket_ids: list) -> dict:
    """ticket id -> {"photo", "map"}: the first photo someone took, and the
    map picture the form attached ("Map Location ...")."""
    out: dict = {}
    if not ticket_ids:
        return out
    rows = (db.query(models.TaskAttachment)
            .filter(models.TaskAttachment.task_id.in_(ticket_ids), models.TaskAttachment.kind == "image")
            .order_by(models.TaskAttachment.added_at.asc()).all())
    for a in rows:
        if not (a.url or "").strip():
            continue
        slot = out.setdefault(a.task_id, {"photo": "", "map": ""})
        key = "map" if (a.name or "").lower().startswith("map location") else "photo"
        if not slot[key]:
            slot[key] = a.url
    return out


def _outline(raw) -> list:
    try:
        pts = json.loads(raw) if raw else []
        return pts if isinstance(pts, list) else []
    except (TypeError, ValueError):
        return []


def serialize(m, t, pics: dict | None = None) -> dict:
    pics = pics or {}
    return {"id": m.id, "ticketId": t.id, "code": t.code or "", "title": t.subject or m.title or "",
            "status": t.status if (t.status and t.status != "new") else "open", "priority": t.priority or "medium",
            "modelId": m.property_id, "u": m.u, "v": m.v, "y": m.y or 0.0, "r": m.radius or 0.0,
            "outline": _outline(m.outline), "unit": m.unit or "", "building": m.building or "",
            "place": m.place or "", "lat": m.lat, "lng": m.lng,
            "photo": pics.get("photo", ""), "mapImage": pics.get("map", ""),
            "propertyId": t.property_asset_id or "", "propertyName": t.property_name or "",
            "createdAt": m.created_at or t.created_at or ""}


def _visible(db: Session, t, user: dict, scope) -> bool:
    if t is None or (t.deleted_at or ""):
        return False
    if scope is not None and (t.company_id or "") not in scope:
        return False
    prop = db.get(models.PropertyAsset, t.property_asset_id) if t.property_asset_id else None
    return prop is None or property_links.viewable(prop, user)


def spots_for_model(db: Session, model_id: str, user: dict) -> dict:
    """{"property": {id, name} | None, "spots": [...open tickets' spots]}."""
    import auth
    model = _model(model_id)
    prop = property_for_model(db, model_id, model)
    if prop is not None and not property_links.viewable(prop, user):
        return {"property": None, "spots": []}
    rows = (db.query(models.SiteModelMarkup)
            .filter(models.SiteModelMarkup.property_id == model_id, models.SiteModelMarkup.ticket_id != "").all())
    tickets = {t.id: t for t in db.query(models.TaskTicket)
               .filter(models.TaskTicket.id.in_([r.ticket_id for r in rows]))
               .filter(models.TaskTicket.status.notin_(property_links.CLOSED_STATES)).all()} if rows else {}
    scope = auth.company_scope(user, db)
    keep = [(m, tickets.get(m.ticket_id)) for m in rows]
    keep = [(m, t) for m, t in keep if _visible(db, t, user, scope)]
    pics = _photos(db, [t.id for _, t in keep])
    spots = [serialize(m, t, pics.get(t.id)) for m, t in keep]
    spots.sort(key=lambda s: s["createdAt"], reverse=True)
    return {"property": {"id": prop.id, "name": property_links.display_name(prop)} if prop is not None else None,
            "spots": spots}


def spot_for_ticket(db: Session, t) -> dict | None:
    """The ticket's spot for its drawer (the caller already passed the ticket's
    own participant check), with the facility for Open on Map."""
    m = (db.query(models.SiteModelMarkup)
         .filter(models.SiteModelMarkup.ticket_id == t.id).order_by(models.SiteModelMarkup.created_at.asc()).first())
    if m is None:
        return None
    out = serialize(m, t, _photos(db, [t.id]).get(t.id))
    try:
        from routers import site_models
        model = site_models.load_model(m.property_id)
        out["facilityId"] = ((model.get("property") or {}).get("cubbyFacilityId") or "")
        out["modelName"] = model.get("name") or (model.get("property") or {}).get("name") or ""
    except HTTPException:
        out["facilityId"] = ""
        out["modelName"] = ""
    return out
