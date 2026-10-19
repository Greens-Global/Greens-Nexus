"""Site Models - to-scale 3D models of a property (Neil, Oct 11 2026).

A site model is a JSON file in backend/site_models/<property-id>.json built by
site_models/build/build_site_model.py from the county parcel, building
footprints digitized against imagery, and the Cubby unit inventory. Every unit
is a rectangle in a local meter frame (u along the site axis, v toward the
northeast) so the frontend viewer (frontend/src/sitemodel/) can draw it to
scale, let a customer find a unit, and let an owner pin markup on the exact
spot. Unit positions are SCHEMATIC until an as-built plan replaces them - the
file carries `layout.flags` saying so.

Two faces of the same file:
  * GET /site-models/{id}            - owners (property-asset grant): everything,
                                       including occupancy and out-of-service flags.
  * GET /site-models/public/{id}     - customers, no login: geometry + unit numbers,
                                       sizes and types only. Never occupancy, never
                                       tenant data, never the layout notes.

Live Cubby link: when CUBBY_API_KEY is set, every read merges the facility's
current inventory from the Cubby Operator API (cubby_client.py) onto the
model: occupancy and out-of-service flags come from Cubby, units Cubby has
that the model does not are listed as `live.unplaced` (not on the map yet),
and model units Cubby no longer has are marked `gone`. Without a key the model
shows the snapshot it was built from and says so in `live`.

Markup pins live in site_model_markups (create_all builds it; ENABLE ROW LEVEL
SECURITY on dev and prod as part of the release - see docs/Site-Models.md).
"""
import json
import math
import os
import re
import uuid
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import cubby_client
from auth import require_module_grant
from database import get_db
from models import SiteModelMarkup

router = APIRouter(tags=["Site Models"])

require_asset_read = require_module_grant("property-asset", "viewer")
require_asset_write = require_module_grant("property-asset", "editor")

MODEL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "site_models")
_SLUG = re.compile(r"[a-z0-9][a-z0-9-]{1,80}")   # always fullmatch: `$` would let a trailing newline through
_TICKET_ID = re.compile(r"[A-Za-z0-9-]{0,40}")
_COORD_MAX = 5000.0   # meters from the frame origin; every site fits well inside
_cache: Dict[str, tuple] = {}

# What a customer may see of a unit: where it is and what it is.
# rot (an angled stall's turn) and tr (traced from the plans) are geometry,
# not occupancy - the customer view needs them to draw a stall where it is.
PUBLIC_UNIT_KEYS = ("n", "b", "f", "u", "v", "wu", "dv", "door", "k", "veh", "pw", "w", "d", "rot", "tr")
PUBLIC_PROPERTY_KEYS = ("id", "name", "address")
PUBLIC_BUILDING_KEYS = ("id", "letters", "name", "kind", "u", "v", "height", "floors", "roof")
PUBLIC_UNPLACED_KEYS = ("n", "w", "d", "k")
CATEGORIES = ("maintenance", "inspection", "note")
STATUSES = ("open", "done")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _path(pid: str) -> str:
    if not _SLUG.fullmatch(pid or ""):
        raise HTTPException(status_code=404, detail="No site model for this property")
    return os.path.join(MODEL_DIR, pid + ".json")


def load_model(pid: str) -> Dict[str, Any]:
    path = _path(pid)
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        raise HTTPException(status_code=404, detail="No site model for this property")
    hit = _cache.get(pid)
    if hit and hit[0] == mtime:
        return hit[1]
    with open(path, encoding="utf-8") as f:
        model = json.load(f)
    _cache[pid] = (mtime, model)
    return model


def _snapshot_live(model: Dict[str, Any], **extra) -> Dict[str, Any]:
    prop = model.get("property") or {}
    out = {"source": "snapshot", "asOf": (model.get("layout") or {}).get("generated", ""), "unplaced": [], "missing": [], **extra}
    if not prop.get("cubbyFacilityId") and prop.get("unitSource"):
        # A store run on another operator's system (Austin: CubeSmart) - say where the units came from
        out.update({"source": "file", "system": prop["unitSource"]})
    return out


def _kind(x: Dict[str, Any]) -> str:
    if x.get("t") == "P":
        return "park"
    if x.get("cc") and x.get("du"):
        return "ccdu"
    if x.get("cc"):
        return "cc"
    if x.get("du"):
        return "du"
    return "in"


def _days_since_build(model: Dict[str, Any]) -> int:
    """Days from the model's build date to today, so a snapshot days-vacant figure keeps counting."""
    try:
        built = datetime.strptime((model.get("layout") or {}).get("generated", ""), "%b %d, %Y").date()
    except ValueError:
        return 0
    return max(0, (date.today() - built).days)


def with_live(model: Dict[str, Any]) -> Dict[str, Any]:
    """The model with Cubby's current inventory merged on (see the module doc).
    Pure given the Cubby answer; the Cubby call itself is cached per facility."""
    fac = (model.get("property") or {}).get("cubbyFacilityId") or ""
    if not fac and (model.get("property") or {}).get("unitSource"):
        # Another operator's store (CubeSmart): the newest uploaded rent roll, else the built snapshot
        import third_party
        uploaded = third_party.rent_roll_live(model)
        if uploaded:
            return uploaded
    if not fac or not cubby_client.enabled():
        return {**model, "live": _snapshot_live(model, enabled=False, reason="CUBBY_API_KEY is not set" if fac else "No Cubby facility on this model")}
    live, as_of, err = cubby_client.units_for(fac)
    if live is None:
        return {**model, "live": _snapshot_live(model, enabled=True, ok=False, error=err)}
    by = {x["n"]: x for x in live}
    aged = _days_since_build(model)
    units = []
    for u in model.get("units", []):
        x = by.get(u["n"])
        if x is None:
            units.append({**u, "gone": 1})
            continue
        still_vacant = (not u.get("l")) and (not x["l"])
        # The Operator API has no days-vacant figure: a unit vacant at the build and
        # still vacant keeps counting from the build date; anything else is unknown (None).
        units.append({**u, "l": x["l"], "r": x["r"], "why": x["why"], "note": x["note"],
                      "w": x["w"] or u.get("w"), "d": x["d"] or u.get("d"),
                      "pw": u.get("pw") if x.get("pw") is None else max(int(u.get("pw") or 0), int(x["pw"])),
                      "dvac": int(u.get("dvac") or 0) + aged if still_vacant else (0 if x["l"] else None)})
    placed = {u["n"] for u in model.get("units", [])}
    unplaced = [{"n": x["n"], "w": x["w"], "d": x["d"], "k": _kind(x), "l": x["l"], "r": x["r"], "why": x["why"], "note": x["note"], "group": x.get("group", "")}
                for x in live if x["n"] not in placed]
    missing = [u["n"] for u in units if u.get("gone")]
    live_info = {"source": "cubby", "enabled": True, "ok": bool(not err), "asOf": as_of, "matched": len(units) - len(missing),
                 "unplaced": unplaced, "missing": missing}
    if err:
        live_info["error"] = err   # stale answer served; the screen says when it is from
    return {**model, "units": units, "live": live_info}


def list_models() -> List[Dict[str, Any]]:
    out = []
    if not os.path.isdir(MODEL_DIR):
        return out
    for name in sorted(os.listdir(MODEL_DIR)):
        if not name.endswith(".json"):
            continue
        pid = name[:-5]
        if not _SLUG.fullmatch(pid):
            continue
        try:
            prop = load_model(pid).get("property") or {}
        except HTTPException:
            continue
        out.append({"id": pid, "name": prop.get("name", ""), "address": prop.get("address", ""),
                    "apn": prop.get("apn", ""), "cubbyFacilityId": prop.get("cubbyFacilityId", ""),
                    "units": len(load_model(pid).get("units", [])), "live": cubby_client.enabled() and bool(prop.get("cubbyFacilityId"))})
    return out


def public_view(model: Dict[str, Any]) -> Dict[str, Any]:
    """Customer-safe copy: the site and where each unit is, nothing about who rents it."""
    pick = lambda d, keys: {k: d.get(k) for k in keys if k in d}  # noqa: E731
    units = [pick(u, PUBLIC_UNIT_KEYS) for u in model.get("units", []) if not u.get("gone")]
    live = model.get("live") or {}
    return {
        "live": {"source": live.get("source", "snapshot"), "unplaced": [pick(x, PUBLIC_UNPLACED_KEYS) for x in live.get("unplaced", [])]},
        "property": pick(model.get("property") or {}, PUBLIC_PROPERTY_KEYS), "frame": model.get("frame"), "image": model.get("image"),
        "imageWide": model.get("imageWide"), "parcel": model.get("parcel"), "pad": model.get("pad"),
        "gates": model.get("gates"), "buildings": [pick(b, PUBLIC_BUILDING_KEYS) for b in model.get("buildings", [])], "zones": model.get("zones"),
        "units": units, "sources": model.get("sources"),
        "layout": {"schematic": bool((model.get("layout") or {}).get("schematic", True))},
    }


@router.get("/site-models")
def get_site_models(user=Depends(require_asset_read)):
    return list_models()


@router.get("/site-models/public/{pid}")
def get_public_site_model(pid: str):
    return public_view(with_live(load_model(pid)))


@router.get("/site-models/{pid}")
def get_site_model(pid: str, user=Depends(require_asset_read)):
    return with_live(load_model(pid))


@router.post("/site-models/{pid}/refresh")
def refresh_site_model(pid: str, user=Depends(require_asset_read)):
    """Drop the cached Cubby answer for this facility and read it again."""
    model = load_model(pid)
    cubby_client.forget((model.get("property") or {}).get("cubbyFacilityId") or None)
    return with_live(model).get("live")


# ---- markup pins ----------------------------------------------------------

def _ser(m: SiteModelMarkup) -> Dict[str, Any]:
    return {"id": m.id, "propertyId": m.property_id, "unit": m.unit or "", "building": m.building or "",
            "u": m.u, "v": m.v, "y": m.y, "title": m.title or "", "category": m.category or "maintenance",
            "status": m.status or "open", "ticketId": m.ticket_id or "", "createdBy": m.created_by or "",
            "createdAt": m.created_at or "", "updatedAt": m.updated_at or ""}


class MarkupIn(BaseModel):
    title: str
    category: str = "maintenance"
    unit: Optional[str] = ""
    building: Optional[str] = ""
    u: float = 0.0
    v: float = 0.0
    y: float = 0.0
    ticketId: Optional[str] = ""


class MarkupPatch(BaseModel):
    title: Optional[str] = None
    category: Optional[str] = None
    status: Optional[str] = None
    ticketId: Optional[str] = None


def _clean_title(t: str) -> str:
    t = (t or "").strip()
    if not t:
        raise HTTPException(status_code=400, detail="A pin needs a title")
    return t[:120]


def _coord(x: float) -> float:
    """A pin coordinate: finite (JSON NaN / Infinity would be stored, then fail every
    response that serializes it) and inside the site frame."""
    if not math.isfinite(x):
        raise HTTPException(status_code=400, detail="Pin position must be a number")
    return max(-_COORD_MAX, min(_COORD_MAX, float(x)))


def _clean_ticket(t: Optional[str]) -> str:
    t = (t or "").strip()
    if not _TICKET_ID.fullmatch(t):
        raise HTTPException(status_code=400, detail="Ticket ids are letters, digits and hyphens")
    return t


@router.get("/site-models/{pid}/markups")
def get_markups(pid: str, db: Session = Depends(get_db), user=Depends(require_asset_read)):
    load_model(pid)
    rows = db.query(SiteModelMarkup).filter(SiteModelMarkup.property_id == pid).order_by(SiteModelMarkup.created_at.desc()).all()
    return [_ser(m) for m in rows]


@router.post("/site-models/{pid}/markups")
def add_markup(pid: str, body: MarkupIn, db: Session = Depends(get_db), user=Depends(require_asset_write)):
    model = load_model(pid)
    unit = (body.unit or "").strip().upper()
    if not re.match(r"^[A-Z0-9-]{0,12}$", unit):
        raise HTTPException(status_code=400, detail="Unit numbers are letters and digits")
    if unit:
        # A pin may sit on a placed unit or on one Cubby lists that the map does not place yet.
        live = with_live(model)
        known = {u.get("n") for u in live.get("units", [])} | {x["n"] for x in (live.get("live") or {}).get("unplaced", [])}
        if unit not in known:
            raise HTTPException(status_code=400, detail=f"No unit {unit} at this property")
    if body.category not in CATEGORIES:
        raise HTTPException(status_code=400, detail="Unknown pin category")
    now = _now()
    m = SiteModelMarkup(id=str(uuid.uuid4()), property_id=pid, unit=unit, building=(body.building or "")[:40],
                        u=_coord(body.u), v=_coord(body.v), y=_coord(body.y), title=_clean_title(body.title),
                        category=body.category, status="open", ticket_id=_clean_ticket(body.ticketId),
                        created_by=(user or {}).get("email", ""), created_at=now, updated_at=now)
    db.add(m)
    db.commit()
    return _ser(m)


@router.patch("/site-models/{pid}/markups/{mid}")
def patch_markup(pid: str, mid: str, body: MarkupPatch, db: Session = Depends(get_db), user=Depends(require_asset_write)):
    m = db.get(SiteModelMarkup, mid)
    if not m or m.property_id != pid:
        raise HTTPException(status_code=404, detail="Pin not found")
    if body.title is not None:
        m.title = _clean_title(body.title)
    if body.category is not None:
        if body.category not in CATEGORIES:
            raise HTTPException(status_code=400, detail="Unknown pin category")
        m.category = body.category
    if body.status is not None:
        if body.status not in STATUSES:
            raise HTTPException(status_code=400, detail="Unknown pin status")
        m.status = body.status
    if body.ticketId is not None:
        m.ticket_id = _clean_ticket(body.ticketId)
    m.updated_at = _now()
    db.commit()
    return _ser(m)


@router.delete("/site-models/{pid}/markups/{mid}")
def delete_markup(pid: str, mid: str, db: Session = Depends(get_db), user=Depends(require_asset_write)):
    m = db.get(SiteModelMarkup, mid)
    if not m or m.property_id != pid:
        raise HTTPException(status_code=404, detail="Pin not found")
    db.delete(m)
    db.commit()
    return {"ok": True}
