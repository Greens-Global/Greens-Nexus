"""Ops Site Map + the customer unit map (Neil, Ops review Oct 20 2026).

Two routers over the same site models (routers/site_models.py, Neil's, read-only
from here):

  ops     /facility-ops/site-map...   Operations grant. The Site Map tab: the
          owner model for the facility picked in Operations plus, per unit, the
          facts behind the layers (occupancy, days vacant, our rate against the
          market median for that size), the facility's Customer Entrance, and
          the customer links.
  public  /unit-map/...               No login. ONE customer's unit on the map:
          the site geometry, the gates, the path steps and that unit - never
          another unit's number, never occupancy, never tenant data.

The customer link is `/find/<token>`. The token is `<payload><hmac>` (urlsafe
base64) over {model id, unit} with the server's signing secret
(secret_box.signing_secret, same as the iCal feed and the task links) under its
own context, so editing the unit or the facility in the URL breaks the
signature. No expiry: a customer keeps their unit for months.

Cubby's message templates can only fill in variables (`${...}`), so Cubby
cannot sign a token. For the rental confirmation email there is a template
link instead: `/find/u?f=<model id>&k=<facility key>&unit=<unit>`. The facility
key is an HMAC of the model id - it proves the link came from us for THAT
facility, and the server turns it into the signed token. Someone holding the
key can ask for another unit number at that facility; what they get back is
that unit's place on the map, which is what the old /map page already shows
for every unit, and still no occupancy or tenant data. See
docs/Customer-Unit-Map.md.

Both public routes are in RequestRateLimit.SENSITIVE_PREFIXES (30 / minute
per IP) and TOKEN_PATH_PREFIXES (the trip log never records a token).
"""
import asyncio
import base64
import hashlib
import hmac
import json
import math
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
import ops_market
import secret_box
from app_url import app_url
from auth import require_level_or_module
from database import get_db
from routers import site_models

_SECRET = secret_box.signing_secret("nexus-unit-map-DEV-ONLY-key-set-NEXUS_VAULT_KEY")
_CONTEXT = b"unit-map:v1:"
_KEY_CONTEXT = b"unit-map-facility:v1:"
_SIG_LEN = 16
_KEY_LEN = 9          # bytes -> 12 url-safe characters
_UNIT_MAX = 12
SETTING_PREFIX = "unit_map:entrance:"
MARKET_BAND = 0.05    # within 5% of the market median counts as "at market"

ops_router = APIRouter(
    prefix="/facility-ops/site-map",
    tags=["Operations"],
    dependencies=[Depends(require_level_or_module(2, "operations", "viewer"))],
)
public_router = APIRouter(prefix="/unit-map", tags=["Customer Unit Map"])
require_ops_edit = require_level_or_module(2, "operations", "editor")


# ── Tokens ────────────────────────────────────────────────────────────────

def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def clean_unit(unit: str) -> str:
    """Same short forms as the map's search box: `c14` and `C 214` -> C014 / C214."""
    s = "".join((unit or "").split()).upper()
    if len(s) > _UNIT_MAX or not all(ch.isalnum() or ch == "-" for ch in s):
        return ""
    if len(s) >= 2 and s[0].isalpha() and s[1:].isdigit() and len(s) <= 4:
        return s[0] + s[1:].zfill(3)
    if len(s) >= 3 and s[0].isalpha() and s[-1].isalpha() and s[1:-1].isdigit() and len(s) <= 5:
        return s[0] + s[1:-1].zfill(3) + s[-1]
    return s


def make_token(pid: str, unit: str) -> str:
    payload = json.dumps({"p": pid, "u": unit}, separators=(",", ":")).encode()
    sig = hmac.new(_SECRET, _CONTEXT + payload, hashlib.sha256).digest()[:_SIG_LEN]
    return _b64(payload + sig)


def parse_token(token: str) -> Optional[Dict[str, str]]:
    """{"pid", "unit"} for a well-signed token, else None."""
    try:
        raw = _unb64(token or "")
        if len(raw) <= _SIG_LEN:
            return None
        payload, sig = raw[:-_SIG_LEN], raw[-_SIG_LEN:]
        want = hmac.new(_SECRET, _CONTEXT + payload, hashlib.sha256).digest()[:_SIG_LEN]
        if not hmac.compare_digest(want, sig):
            return None
        data = json.loads(payload)
        pid, unit = str(data.get("p") or ""), str(data.get("u") or "")
        if not pid or not unit:
            return None
        return {"pid": pid, "unit": unit}
    except Exception:
        return None


def facility_key(pid: str) -> str:
    return _b64(hmac.new(_SECRET, _KEY_CONTEXT + pid.encode(), hashlib.sha256).digest()[:_KEY_LEN])


def check_facility_key(pid: str, key: str) -> bool:
    return bool(key) and hmac.compare_digest(facility_key(pid), key)


def customer_url(pid: str, unit: str) -> str:
    return f"{app_url()}/find/{make_token(pid, unit)}"


def template_url(pid: str, unit_placeholder: str = "${unit.name}") -> str:
    return f"{app_url()}/find/u?f={pid}&k={facility_key(pid)}&unit={unit_placeholder}"


# ── Entrance ──────────────────────────────────────────────────────────────

def gate_latlng(model: Dict[str, Any], uv) -> Optional[Dict[str, float]]:
    """A point of the model's local frame (u, v meters) as lat / lng. The frame
    stores the bearing of +u and the north direction in (u, v): north meters =
    u*n0 + v*n1, east meters = u*n1 - v*n0."""
    f = model.get("frame") or {}
    n = f.get("north")
    if not n or uv is None or not f.get("mPerDegLat") or not f.get("mPerDegLon"):
        return None
    u, v = float(uv[0]), float(uv[1])
    north = u * n[0] + v * n[1]
    east = u * n[1] - v * n[0]
    return {"lat": round(f["lat0"] + north / f["mPerDegLat"], 6), "lng": round(f["lon0"] + east / f["mPerDegLon"], 6)}


def _read_setting(db: Session, pid: str) -> Dict[str, Any]:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTING_PREFIX + pid).first()
    if not row or not row.value:
        return {}
    try:
        data = json.loads(row.value)
        return data if isinstance(data, dict) else {}
    except ValueError:
        return {}


def entrance_for(db: Session, model: Dict[str, Any], staff: bool = False) -> Dict[str, Any]:
    """The Customer Entrance: the facility's setting when there is one, else the
    model's main gate. Never the street address pin (Fairfield: that pin lands
    in the landscape yard next door)."""
    pid = (model.get("property") or {}).get("id") or ""
    s = _read_setting(db, pid)
    gates = model.get("gates") or []
    gate = gates[0] if gates else {}
    if isinstance(s.get("lat"), (int, float)) and isinstance(s.get("lng"), (int, float)):
        out = {"lat": s["lat"], "lng": s["lng"], "note": s.get("note") or "", "source": "setting", "name": gate.get("name") or "Entrance"}
    else:
        at = gate_latlng(model, gate.get("uv"))
        out = {**(at or {"lat": None, "lng": None}), "note": "", "source": "gate" if at else "none", "name": gate.get("name") or "Entrance"}
    if out.get("lat") is not None:
        out["mapsUrl"] = f"https://www.google.com/maps/dir/?api=1&destination={out['lat']},{out['lng']}"
    if staff:
        out["updatedBy"] = s.get("updatedBy") or ""
        out["updatedAt"] = s.get("updatedAt") or ""
    return out


# ── Customer view ─────────────────────────────────────────────────────────

def customer_view(db: Session, pid: str, unit: str) -> Dict[str, Any]:
    """The site with ONE unit on it. Built from the snapshot geometry only, so a
    customer's page load never calls Cubby and carries no occupancy at all."""
    model = site_models.load_model(pid)   # 404s for an unknown id
    pub = site_models.public_view(model)
    hit = next((u for u in pub["units"] if u.get("n") == unit), None)
    if hit is None:
        raise HTTPException(status_code=404, detail="This unit is not on the map yet - the office can point you to it.")
    building = next((b for b in pub["buildings"] if b.get("id") == hit.get("b")), None)
    zone = next((z for z in (pub.get("zones") or []) if z.get("id") == hit.get("b")), None)
    return {
        "property": pub["property"], "frame": pub["frame"], "image": pub["image"], "imageWide": pub["imageWide"],
        "parcel": pub["parcel"], "pad": pub["pad"], "gates": pub["gates"], "buildings": pub["buildings"],
        "zones": pub["zones"], "units": [hit], "sources": [], "layout": pub["layout"],
        "live": {"source": "snapshot", "unplaced": []},
        "unit": hit, "building": (building or {}).get("name") or (zone or {}).get("name") or "",
        "entrance": entrance_for(db, model),
    }


def _customer(db: Session, pid: str, unit: str) -> Dict[str, Any]:
    return customer_view(db, pid, unit)


@public_router.get("/t/{token}")
async def public_unit_map(token: str, db: Session = Depends(get_db)):
    data = parse_token(token)
    if not data:
        raise HTTPException(status_code=404, detail="This link is not valid. Ask the office for a new one.")
    return await asyncio.to_thread(_customer, db, data["pid"], data["unit"])


@public_router.get("/u")
async def public_unit_map_template(f: str = "", k: str = "", unit: str = "", db: Session = Depends(get_db)):
    """The Cubby template link: a facility key + a unit number -> the signed token
    and the same customer view, so the page can swap its address to /find/<token>."""
    pid = (f or "").strip()
    if not site_models._SLUG.fullmatch(pid) or not check_facility_key(pid, (k or "").strip()):
        raise HTTPException(status_code=404, detail="This link is not valid. Ask the office for a new one.")
    name = clean_unit(unit)
    if not name:
        raise HTTPException(status_code=404, detail="This link has no unit number. Ask the office for a new one.")
    view = await asyncio.to_thread(_customer, db, pid, name)
    return {**view, "token": make_token(pid, name)}


# ── Ops: model + layer facts ──────────────────────────────────────────────

def model_for_facility(facility_id: str) -> Optional[str]:
    for m in site_models.list_models():
        if m.get("cubbyFacilityId") and m["cubbyFacilityId"] == facility_id:
            return m["id"]
    return None


def _days_between(a: str, b: date) -> Optional[int]:
    try:
        return max(0, (b - date.fromisoformat((a or "")[:10])).days)
    except ValueError:
        return None


def market_verdict(rate: int, median: Optional[int]) -> Optional[str]:
    if not rate or not median:
        return None
    if rate < median * (1 - MARKET_BAND):
        return "under"
    if rate > median * (1 + MARKET_BAND):
        return "over"
    return "at"


def unit_facts(rent_roll: List[dict], leases: List[dict], market: Dict[str, dict], today: date) -> Dict[str, dict]:
    """Per unit name: status, rent, street rate, days vacant (from the last
    move-out Cubby has for the unit) and our rate against the market median for
    its size. `market` is ops_market.latest_rates output. Pure."""
    last_out: Dict[str, str] = {}
    for le in leases:
        uid, out = le.get("unitId") or "", (le.get("moveOutDate") or "")[:10]
        if uid and out and out <= today.isoformat() and out > last_out.get(uid, ""):
            last_out[uid] = out
    facts: Dict[str, dict] = {}
    for r in rent_roll:
        name = (r.get("unitName") or "").strip().upper()
        if not name:
            continue
        status = r.get("status") or ""
        rented = status == "RENTED"
        rent = int(r.get("monthlyRentalAmount") or 0) if rented else 0
        street = int(r.get("standardRate") or 0)
        group = (r.get("pricingGroupName") or "").strip()
        parking = "parking" in group.lower()
        seen = market.get(ops_market.size_key(r.get("width"), r.get("depth"), parking), {}) if r.get("width") and r.get("depth") else {}
        rates = sorted(o["rate_cents"] for o in seen.values())
        median = int(round(sorted(rates)[len(rates) // 2] if len(rates) % 2 else (rates[len(rates) // 2 - 1] + rates[len(rates) // 2]) / 2)) if rates else None
        ours = rent if rented else street
        vacant_since = last_out.get(r.get("unitId") or "") if status == "VACANT" else ""
        facts[name] = {
            "status": "rented" if rented else "vacant" if status == "VACANT" else "off-market",
            "type": group, "rent": rent, "street": street, "rate": ours,
            "vacantSince": vacant_since, "daysVacant": _days_between(vacant_since, today) if vacant_since else None,
            "marketMedian": median, "marketCount": len(rates),
            "market": market_verdict(ours, median) if len(rates) >= ops_market.MIN_COMPETITORS else None,
            "marketPct": round(100 * (ours - median) / median) if median and ours and len(rates) >= ops_market.MIN_COMPETITORS else None,
        }
    return facts


def _cubby_rows(facility_id: str):
    import cubby
    for fac, raw in cubby._rows():
        if fac.get("facilityId") == facility_id:
            return fac, raw
    return None, None


def _site_map(db: Session, facility_id: str) -> Dict[str, Any]:
    pid = model_for_facility(facility_id)
    if not pid:
        raise HTTPException(status_code=404, detail="No site model for this facility yet")
    model = site_models.with_live(site_models.load_model(pid))
    fac, raw = None, None
    try:
        fac, raw = _cubby_rows(facility_id)
    except Exception as e:  # noqa: BLE001 - the map still draws from the model's own Cubby link
        print(f"[unit_map] cubby rows unavailable: {type(e).__name__}")
    today = date.today()
    facts: Dict[str, dict] = {}
    if raw:
        try:
            today = date.fromisoformat(raw["today"].isoformat() if hasattr(raw.get("today"), "isoformat") else str(raw.get("today")))
        except (ValueError, TypeError):
            pass
        rates = db.query(models.OpsCompetitorRate).filter(models.OpsCompetitorRate.facility_id == facility_id).all()
        active = {c.id for c in db.query(models.OpsCompetitor).filter(models.OpsCompetitor.facility_id == facility_id,
                                                                   models.OpsCompetitor.active == True).all()}  # noqa: E712
        obs = [{"competitor_id": r.competitor_id, "width": r.width, "depth": r.depth, "parking": bool(r.parking),
                "rate_cents": r.rate_cents, "observed_on": r.observed_on, "created_at": r.created_at}
               for r in rates if r.competitor_id in active]
        market = ops_market.latest_rates(obs, today)
        facts = unit_facts(raw.get("rent_roll") or [], raw.get("leases") or [], market, today)
    return {
        "facilityId": facility_id, "modelId": pid, "facility": (fac or {}).get("name") or (model.get("property") or {}).get("name") or "",
        "model": model, "facts": facts, "asOf": today.isoformat(),
        "marketBand": MARKET_BAND, "minCompetitors": ops_market.MIN_COMPETITORS,
        "entrance": entrance_for(db, model, staff=True),
        "cubbyTemplate": template_url(pid),
    }


@ops_router.get("/facilities")
async def site_map_facilities():
    """Which Operations facilities have a site model, keyed by Cubby facility id."""
    rows = await asyncio.to_thread(site_models.list_models)
    return [{"facilityId": m["cubbyFacilityId"], "modelId": m["id"], "name": m["name"]} for m in rows if m.get("cubbyFacilityId")]


@ops_router.get("")
async def site_map(facility_id: str, db: Session = Depends(get_db)):
    return await asyncio.to_thread(_site_map, db, facility_id)


class LinkIn(BaseModel):
    facility_id: str
    unit: str


@ops_router.post("/customer-link")
async def customer_link(body: LinkIn):
    pid = await asyncio.to_thread(model_for_facility, body.facility_id)
    if not pid:
        raise HTTPException(status_code=404, detail="No site model for this facility yet")
    name = clean_unit(body.unit)
    units = {u.get("n") for u in (await asyncio.to_thread(site_models.load_model, pid)).get("units", [])}
    if not name or name not in units:
        raise HTTPException(status_code=400, detail=f"Unit {name or body.unit} is not on this facility's map")
    return {"url": customer_url(pid, name), "unit": name}


class EntranceIn(BaseModel):
    facility_id: str
    lat: Optional[float] = None
    lng: Optional[float] = None
    note: Optional[str] = ""


def _save_entrance(db: Session, body: EntranceIn, email: str) -> Dict[str, Any]:
    pid = model_for_facility(body.facility_id)
    if not pid:
        raise HTTPException(status_code=404, detail="No site model for this facility yet")
    model = site_models.load_model(pid)
    key = SETTING_PREFIX + pid
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == key).first()
    now = datetime.now(timezone.utc).isoformat()
    if body.lat is None and body.lng is None:
        if row:
            db.delete(row)          # back to the model's main gate
            db.commit()
        return entrance_for(db, model, staff=True)
    if body.lat is None or body.lng is None or not (math.isfinite(body.lat) and math.isfinite(body.lng)) \
            or not (-90 <= body.lat <= 90 and -180 <= body.lng <= 180):
        raise HTTPException(status_code=400, detail="Enter both a latitude and a longitude")
    # A pin far from the site is a typo (a dropped minus sign, swapped fields)
    gate = gate_latlng(model, ((model.get("gates") or [{}])[0]).get("uv")) or {}
    if gate and (abs(gate["lat"] - body.lat) > 0.02 or abs(gate["lng"] - body.lng) > 0.02):
        raise HTTPException(status_code=400, detail="That point is more than a mile from this facility - check the numbers")
    value = json.dumps({"lat": round(body.lat, 6), "lng": round(body.lng, 6), "note": (body.note or "").strip()[:300],
                        "updatedBy": email, "updatedAt": now})
    if row is None:
        row = models.NexusSetting(key=key)
        db.add(row)
    row.value, row.updated_by, row.updated_at = value, email, now
    db.commit()
    return entrance_for(db, model, staff=True)


@ops_router.put("/entrance")
async def save_entrance(body: EntranceIn, db: Session = Depends(get_db), user: dict = Depends(require_ops_edit)):
    return await asyncio.to_thread(_save_entrance, db, body, (user or {}).get("email") or "")
