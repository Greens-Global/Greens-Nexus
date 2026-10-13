"""Operations (storage facilities): the figures behind the Operations screen,
read from Cubby through `cubby.py`, plus the Market Rates tab's own records
(`ops_market.py`).

Same door as the sidebar: supervisors and above, or anyone whose Access Group
grants the Operations module. The payload names tenants who owe money, so it
is never open to everyone signed in. Nothing here writes to Cubby.
"""
import asyncio
import uuid
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import cubby
import models
import ops_market
from auth import get_current_user, require_level_or_module
from database import get_db

router = APIRouter(
    prefix="/facility-ops",
    tags=["Operations"],
    dependencies=[Depends(require_level_or_module(2, "operations", "viewer"))],
)


def _require_cubby() -> None:
    if not cubby.configured():
        raise HTTPException(status_code=503, detail="Cubby is not connected (CUBBY_API_KEY is not set)")


async def _from_cubby(fn, *args):
    """Run a blocking cubby.py read in a thread; 424 (never 502 - Cloudflare
    replaces a 502 body and hides the reason) when Cubby is unhappy."""
    _require_cubby()
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


class RateBody(BaseModel):
    competitor_id: str
    width: float = Field(gt=0, le=200)
    depth: float = Field(gt=0, le=400)
    parking: bool = False
    rate: float = Field(gt=0, le=100000)          # dollars per month, as a person types it
    promo: Optional[str] = Field(default="", max_length=200)
    observed_on: Optional[str] = None             # YYYY-MM-DD; today when left out


def _competitor_dict(c: models.OpsCompetitor, rates: list) -> dict:
    return {"id": c.id, "facilityId": c.facility_id, "name": c.name, "address": c.address or "",
            "distanceMiles": c.distance_miles or 0, "website": c.website or "", "notes": c.notes or "",
            "rates": rates}


def _rate_dict(r: models.OpsCompetitorRate) -> dict:
    return {"id": r.id, "competitorId": r.competitor_id, "width": r.width, "depth": r.depth,
            "parking": bool(r.parking), "rate": r.rate_cents, "promo": r.promo or "",
            "observedOn": r.observed_on, "enteredBy": r.entered_by or ""}


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
    }


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
    facility = await _facility(body.facility_id or "")

    def _save():
        c = models.OpsCompetitor(id=str(uuid.uuid4()), facility_id=facility["id"], name=body.name.strip(),
                                 address=(body.address or "").strip(), distance_miles=body.distance_miles or 0,
                                 website=(body.website or "").strip(), notes=(body.notes or "").strip(),
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
        for k, v in data.items():
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
