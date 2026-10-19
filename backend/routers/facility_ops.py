"""Operations (storage facilities): the figures behind the Operations screen,
read from Cubby through `cubby.py`, plus the Market Rates tab's own records
(`ops_market.py`) and the reader that finds nearby facilities and reads their
public pricing pages (`ops_market_engine.py`).

Same door as the sidebar: supervisors and above, or anyone whose Access Group
grants the Operations module. The payload names tenants who owe money, so it
is never open to everyone signed in. Nothing here writes to Cubby.
"""
import asyncio
import time
import uuid
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import cubby
import cubby_sync
import models
import ops_market
import ops_market_engine
import ops_unit_classes
from auth import get_current_user, require_level_or_module
from database import get_db

router = APIRouter(
    prefix="/facility-ops",
    tags=["Operations"],
    dependencies=[Depends(require_level_or_module(2, "operations", "viewer"))],
)


def _require_cubby() -> None:
    """Only what talks to Cubby needs the key (starting a sync). Reads come
    from the database the sync fills, whether or not this server has it."""
    if not cubby.configured():
        raise HTTPException(status_code=503, detail=cubby_sync.NOT_CONFIGURED)


async def _from_cubby(fn, *args):
    """Run a blocking cubby.py read in a thread; 424 (never 502 - Cloudflare
    replaces a 502 body and hides the reason) when Cubby is unhappy. No key
    gate: a server without CUBBY_API_KEY still serves the synced tables, and
    with empty tables the summary says `not_configured` instead of failing."""
    try:
        return await asyncio.to_thread(fn, *args)
    except cubby.CubbyError as e:
        if e.status == 404:
            raise HTTPException(status_code=404, detail=e.message) from e
        raise HTTPException(status_code=424, detail=f"Cubby did not answer: {e.message}") from e


@router.get("/summary")
async def summary(fresh: bool = False):
    return await _from_cubby(cubby.summary, fresh)


@router.get("/lookup")
async def lookup(q: str = ""):
    """Find a unit or tenant across every facility."""
    return {"results": await _from_cubby(cubby.lookup, q)}


@router.get("/report/{kind}")
async def report(kind: str, facility_id: str = ""):
    """A Cubby report (rent-roll, aged-receivables) as columns and rows."""
    if kind not in cubby.REPORTS:
        raise HTTPException(status_code=404, detail="No such report")
    return await _from_cubby(cubby.report, kind, facility_id)


# ── Cubby sync (Oct 15 2026): the screen reads the database; Refresh asks for a sync ──

@router.get("/sync")
async def sync_status():
    """Is a Cubby sync running, how did the last one go. The screen polls this
    after Refresh, then re-reads the summary."""
    return await asyncio.to_thread(cubby_sync.status)


@router.post("/sync")
async def sync_start(user: dict = Depends(get_current_user)):
    """Start a Cubby -> database sync in the background. Same door as the rest
    of the screen (the old Refresh pulled Cubby for anyone who could open it);
    one at a time across every worker, and at most one per few minutes."""
    _require_cubby()
    run_id, why = await asyncio.to_thread(cubby_sync.start_manual, user.get("email") or "")
    if why == "running":
        raise HTTPException(status_code=409, detail="A Cubby sync is already running. The figures will update when it finishes.")
    if why == "too-soon":
        raise HTTPException(status_code=429, detail="Cubby was synced moments ago. Try again in a few minutes.")
    cubby_sync.run_in_background(run_id)
    return {"started": True, "runId": run_id}


# ── Market Rates ──────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class CompetitorBody(BaseModel):
    facility_id: Optional[str] = None
    name: Optional[str] = Field(default=None, max_length=120)
    address: Optional[str] = Field(default=None, max_length=240)
    distance_miles: Optional[float] = Field(default=None, ge=0, le=500)
    website: Optional[str] = Field(default=None, max_length=300)
    notes: Optional[str] = Field(default=None, max_length=2000)
    # Set when a competitor is added from the nearby list (OpenStreetMap).
    lat: Optional[float] = Field(default=None, ge=-90, le=90)
    lng: Optional[float] = Field(default=None, ge=-180, le=180)
    osm_id: Optional[str] = Field(default=None, max_length=40)
    rates_url: Optional[str] = Field(default=None, max_length=300)   # the page their prices are read from
    watch: Optional[bool] = None


class RateBody(BaseModel):
    competitor_id: str
    width: float = Field(gt=0, le=200)
    depth: float = Field(gt=0, le=400)
    parking: bool = False
    rate: float = Field(gt=0, le=100000)          # dollars per month, as a person types it
    promo: Optional[str] = Field(default="", max_length=200)
    observed_on: Optional[str] = None             # YYYY-MM-DD; today when left out


def _rates_url(value: Optional[str]) -> str:
    """A rates page as typed: empty, or an http(s) address."""
    v = (value or "").strip()
    if v and not (v.lower().startswith(("http://", "https://")) and ops_market_engine.as_url(v)):
        raise HTTPException(status_code=422, detail="The rates page must be a web address starting with http:// or https://")
    return v


def _competitor_dict(c: models.OpsCompetitor, rates: list) -> dict:
    return {"id": c.id, "facilityId": c.facility_id, "name": c.name, "address": c.address or "",
            "distanceMiles": c.distance_miles or 0, "website": c.website or "", "notes": c.notes or "",
            "ratesUrl": ops_market_engine.rates_url_of(c), "watch": c.watch is not False,
            "lastCheckedAt": c.last_checked_at or "", "lastStatus": c.last_status or "",
            "lastDetail": c.last_detail or "", "rates": rates}


def _rate_dict(r: models.OpsCompetitorRate) -> dict:
    return {"id": r.id, "competitorId": r.competitor_id, "width": r.width, "depth": r.depth,
            "parking": bool(r.parking), "rate": r.rate_cents, "promo": r.promo or "",
            "observedOn": r.observed_on, "enteredBy": r.entered_by or "", "source": r.source or "manual"}


def _obs(r: models.OpsCompetitorRate) -> dict:
    return {"competitor_id": r.competitor_id, "width": r.width, "depth": r.depth, "parking": bool(r.parking),
            "rate_cents": r.rate_cents, "observed_on": r.observed_on, "created_at": r.created_at}


def _market(db: Session, facility: dict) -> dict:
    fid = facility["id"]
    comps = (db.query(models.OpsCompetitor)
             .filter(models.OpsCompetitor.facility_id == fid, models.OpsCompetitor.active == True)  # noqa: E712
             .order_by(models.OpsCompetitor.distance_miles, models.OpsCompetitor.name).all())
    rates = (db.query(models.OpsCompetitorRate).filter(models.OpsCompetitorRate.facility_id == fid)
             .order_by(models.OpsCompetitorRate.observed_on.desc(), models.OpsCompetitorRate.created_at.desc()).all())
    by_comp: dict[str, list] = {}
    for r in rates:
        by_comp.setdefault(r.competitor_id, []).append(_rate_dict(r))
    today = date.fromisoformat(facility["asOf"])
    rows = ops_market.compare(facility["unitTypes"], [_obs(r) for r in rates], {c.id: c.name for c in comps}, today)
    return {
        "facilityId": fid, "facility": facility["shortName"], "asOf": facility["asOf"],
        "freshDays": ops_market.FRESH_DAYS, "minCompetitors": ops_market.MIN_COMPETITORS,
        "competitors": [_competitor_dict(c, by_comp.get(c.id, [])[:40]) for c in comps],
        "rows": rows,
        "moves": ops_market_engine.rate_moves(db, fid, today),
        "engine": {"connected": _engine_connected(), "everyHours": ops_market_engine.watch_hours()},
    }


def _engine_connected() -> bool:
    import construction_ai
    return construction_ai.configured()


async def _facility(facility_id: str) -> dict:
    data = await _from_cubby(cubby.summary, False)
    hit = next((f for f in data["facilities"] if f["id"] == facility_id), None)
    if not hit:
        raise HTTPException(status_code=404, detail="Facility not found")
    return hit


@router.get("/market")
async def market(facility_id: str, db: Session = Depends(get_db)):
    facility = await _facility(facility_id)
    return await asyncio.to_thread(_market, db, facility)


@router.post("/market/competitors", status_code=201)
async def add_competitor(body: CompetitorBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if not (body.name or "").strip():
        raise HTTPException(status_code=422, detail="A competitor needs a name")
    rates_url = _rates_url(body.rates_url)
    facility = await _facility(body.facility_id or "")

    def _save():
        website = (body.website or "").strip()
        c = models.OpsCompetitor(id=str(uuid.uuid4()), facility_id=facility["id"], name=body.name.strip(),
                                 address=(body.address or "").strip(), distance_miles=body.distance_miles or 0,
                                 website=website, notes=(body.notes or "").strip(),
                                 lat=body.lat, lng=body.lng, osm_id=(body.osm_id or "").strip(),
                                 rates_url=rates_url or ops_market_engine.as_url(website),
                                 watch=body.watch is not False,
                                 active=True, created_by=user["email"], created_at=_now())
        db.add(c)
        db.commit()
        return _market(db, facility)
    return await asyncio.to_thread(_save)


@router.patch("/market/competitors/{competitor_id}")
async def update_competitor(competitor_id: str, body: CompetitorBody, db: Session = Depends(get_db)):
    c = await asyncio.to_thread(lambda: db.get(models.OpsCompetitor, competitor_id))
    if not c or not c.active:
        raise HTTPException(status_code=404, detail="Competitor not found")
    facility = await _facility(c.facility_id)

    def _save():
        data = body.model_dump(exclude_unset=True, exclude={"facility_id"})   # a competitor does not change facility
        if "name" in data and not (data["name"] or "").strip():
            raise HTTPException(status_code=422, detail="A competitor needs a name")
        if "rates_url" in data:
            data["rates_url"] = _rates_url(data["rates_url"])
        if data.get("watch", True) is None:
            del data["watch"]
        for k, v in data.items():
            if k in ("lat", "lng", "watch"):
                setattr(c, k, v)
            else:
                setattr(c, k, v.strip() if isinstance(v, str) else (v if v is not None else 0 if k == "distance_miles" else ""))
        db.commit()
        return _market(db, facility)
    return await asyncio.to_thread(_save)


@router.delete("/market/competitors/{competitor_id}")
async def remove_competitor(competitor_id: str, db: Session = Depends(get_db)):
    """Stops counting this competitor. Its recorded rates are kept."""
    c = await asyncio.to_thread(lambda: db.get(models.OpsCompetitor, competitor_id))
    if not c or not c.active:
        raise HTTPException(status_code=404, detail="Competitor not found")
    facility = await _facility(c.facility_id)

    def _save():
        c.active = False
        db.commit()
        return _market(db, facility)
    return await asyncio.to_thread(_save)


_CHECK_EVERY_SEC = 600
_check_started: dict[str, float] = {}   # competitor id -> when its last manual check began (this worker)


@router.post("/market/competitors/{competitor_id}/check")
async def check_competitor(competitor_id: str, db: Session = Depends(get_db)):
    """Read this competitor's rates page now. At most once per competitor per
    10 minutes, whoever asks - the daily run counts too."""
    c = await asyncio.to_thread(lambda: db.get(models.OpsCompetitor, competitor_id))
    if not c or not c.active:
        raise HTTPException(status_code=404, detail="Competitor not found")
    facility = await _facility(c.facility_id)
    try:
        since = (datetime.now(timezone.utc) - datetime.fromisoformat(c.last_checked_at)).total_seconds()
    except (TypeError, ValueError):
        since = _CHECK_EVERY_SEC
    if since < _CHECK_EVERY_SEC or time.monotonic() - _check_started.get(c.id, -_CHECK_EVERY_SEC) < _CHECK_EVERY_SEC:
        raise HTTPException(status_code=409, detail="This competitor was checked in the last 10 minutes. Try again a little later.")
    _check_started[c.id] = time.monotonic()

    def _run():
        ops_market_engine.check_competitor(db, c, date.fromisoformat(facility["asOf"]))
        return _market(db, facility)
    return await asyncio.to_thread(_run)


@router.get("/market/nearby")
async def market_nearby(facility_id: str, radius_km: float = ops_market_engine.DEFAULT_RADIUS_KM, db: Session = Depends(get_db)):
    """Storage facilities around one of ours, from OpenStreetMap, minus our own
    and the ones already tracked. 424 (never 502) when OpenStreetMap is unhappy."""
    data = await _from_cubby(cubby.summary, False)
    facility = next((f for f in data["facilities"] if f["id"] == facility_id), None)
    if not facility:
        raise HTTPException(status_code=404, detail="Facility not found")
    radius = min(max(radius_km, 1.0), ops_market_engine.MAX_RADIUS_KM)
    out = {"facilityId": facility_id, "radiusKm": radius, "radiusMiles": round(radius / 1.609344),
           "attribution": ops_market_engine.ATTRIBUTION, "facilities": [], "detail": ""}
    if facility.get("lat") is None or facility.get("lng") is None:
        return {**out, "detail": "Cubby has no map location for this facility, so nearby facilities cannot be looked up."}

    def _find():
        elements = ops_market_engine.nearby_elements(facility_id, facility["lat"], facility["lng"], radius)
        existing = (db.query(models.OpsCompetitor)
                    .filter(models.OpsCompetitor.facility_id == facility_id, models.OpsCompetitor.active == True).all())  # noqa: E712
        ours = [(f["lat"], f["lng"]) for f in data["facilities"] if f.get("lat") is not None and f.get("lng") is not None]
        return ops_market_engine.nearby_from_elements(elements, (facility["lat"], facility["lng"]), ours,
                                                      data.get("organization") or "", existing)
    try:
        out["facilities"] = await asyncio.to_thread(_find)
    except ops_market_engine.NearbyUnavailable as e:
        raise HTTPException(status_code=424, detail=str(e)) from e
    return out


@router.post("/market/rates", status_code=201)
async def record_rate(body: RateBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    c = await asyncio.to_thread(lambda: db.get(models.OpsCompetitor, body.competitor_id))
    if not c or not c.active:
        raise HTTPException(status_code=404, detail="Competitor not found")
    facility = await _facility(c.facility_id)
    seen = body.observed_on or facility["asOf"]
    try:
        if date.fromisoformat(seen) > date.fromisoformat(facility["asOf"]):
            raise HTTPException(status_code=422, detail="The date a rate was seen cannot be in the future")
    except ValueError:
        raise HTTPException(status_code=422, detail="The date must be a real calendar date") from None

    def _save():
        db.add(models.OpsCompetitorRate(
            id=str(uuid.uuid4()), competitor_id=c.id, facility_id=c.facility_id, width=body.width, depth=body.depth,
            parking=body.parking, rate_cents=int(round(body.rate * 100)), promo=(body.promo or "").strip(),
            observed_on=seen, source="manual", entered_by=user["email"], created_at=_now()))
        db.commit()
        return _market(db, facility)
    return await asyncio.to_thread(_save)


@router.post("/market/analysis")
async def market_analysis(facility_id: str, db: Session = Depends(get_db)):
    """Claude's reading of the comparison table. It explains and prioritizes;
    every number in it comes from the table, which the rule produced."""
    import construction_ai
    if not construction_ai.configured():
        raise HTTPException(status_code=503, detail="The written analysis is not connected (ANTHROPIC_API_KEY is not set)")
    facility = await _facility(facility_id)
    data = await asyncio.to_thread(_market, db, facility)
    rows = [r for r in data["rows"] if r["competitors"]]
    if not rows:
        raise HTTPException(status_code=409, detail="Record at least one competitor rate before asking for an analysis")
    try:
        out = await asyncio.to_thread(ops_market.analyze, facility["name"], rows, [c["name"] for c in data["competitors"]])
    except Exception as e:  # noqa: BLE001 - the model call can fail many ways; none should 500 the screen
        print(f"[ops-market] analysis failed: {type(e).__name__}")
        raise HTTPException(status_code=424, detail="The analysis could not be written just now. Try again in a minute.") from e
    return {**out, "writtenAt": _now(), "sizesCompared": len(rows)}


# ── Unit classes (Neil, Oct 20 2026): which Cubby unit types are mailboxes ────
# Cubby has no mailbox flag; ops_unit_classes matches words in the pricing
# group name. Anyone on the screen can read the words; a manager (or an
# Operations editor) changes them, and the next read uses them. Plain `def`
# endpoints: FastAPI runs them in its thread pool, off the event loop.

class UnitClassesBody(BaseModel):
    mailbox: list[str] = Field(default_factory=list, max_length=ops_unit_classes.MAX_WORDS)
    excluded: list[str] = Field(default_factory=list, max_length=ops_unit_classes.MAX_WORDS)


@router.get("/unit-classes")
def unit_classes(db: Session = Depends(get_db)):
    return {**ops_unit_classes.load(db), "defaults": ops_unit_classes.DEFAULTS}


@router.put("/unit-classes")
def save_unit_classes(body: UnitClassesBody, db: Session = Depends(get_db),
                      user: dict = Depends(require_level_or_module(3, "operations", "editor"))):
    saved = ops_unit_classes.save(db, body.model_dump(), user.get("email") or "")
    cubby.forget()   # this worker re-reads now; the others within a minute (cubby.READ_TTL)
    return {**saved, "defaults": ops_unit_classes.DEFAULTS}
