"""Operations > Rate Management as a CMA (Miranda, Oct 21 2026) - the comp
set, manual surveys, website price overrides, CSV / XLS import, Rate History
and Review & Push. The overview table is GET /facility-ops/rates
(routers/ops_rates.py); the calculations are ops_cma.py.

  GET    /facility-ops/cma/compset                 competitors (active + closed), latest survey, rates by size
  POST   /facility-ops/cma/competitors             add one (name, address, phone, website, distance, type)
  PATCH  /facility-ops/cma/competitors/{id}        details and the price source (website | manual only)
  POST   /facility-ops/cma/competitors/{id}/close  closed (struck through, out of every average) or reopened
  POST   /facility-ops/cma/surveys                 a manual survey and its rates by unit
  POST   /facility-ops/cma/overrides               use this rate instead of the website's, with a 30-day lock
  POST   /facility-ops/cma/import                  manual rates from a CSV / XLS sheet: preview, then save
  GET    /facility-ops/cma/history                 one unit type: chart points, side cards, change log
  GET    /facility-ops/cma/review                  proposed rate changes + promotions, and what was decided
  POST   /facility-ops/cma/promos                  propose a promotion (Cubby: discount) or the end of one
  DELETE /facility-ops/cma/promos/{id}             withdraw a proposed promotion
  POST   /facility-ops/cma/review/apply            approve: push (switch on) or mark Entered in Cubby
  POST   /facility-ops/cma/review/reject           return proposals to the proposer
  POST   /facility-ops/cma/changes/{id}/entered    an approved change was entered in Cubby by hand
  POST   /facility-ops/cma/changes/{id}/retry      push a failed / queued rate change again (switch on)
  POST   /facility-ops/cma/changes/{id}/revert     one-click revert to the previous rates

Doors: looking = the rest of Operations (level 2 or an Operations grant).
Surveys, overrides, imports, closing a competitor and proposing promotions =
a manager or an Operations Editor grant (the Proposed-rate door). Approving
or rejecting = an Ops Manager (level 3, or Operations Full); a change over
10% or below the market low needs the Owner (level 4 administrator, or the
Operations Owner grant). Pushing also needs the Push to Cubby switch on
(ops_cubby_push.py) - while it is off nothing here writes to Cubby and the
screen ends in Mark Entered in Cubby.

Cubby has NO API to create, change or end a discount program (checked
against https://cubbystorage.github.io/docs/api/, Oct 21 2026: only
discounts/search, read-only), so promotions are recorded, approved and then
entered in Cubby by hand - never pushed.
"""
import asyncio
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import auth
import cubby
import hb_history
import models
import ops_cma
import ops_cubby_push
import ops_market
import ops_rate_mgmt
from auth import get_current_user, require_level_or_module
from database import get_db
from routers import facility_ops, ops_rates
import job_switch

router = APIRouter(
    prefix="/facility-ops/cma",
    tags=["Operations"],
    dependencies=[Depends(require_level_or_module(2, "operations", "viewer"))],
)

require_editor = require_level_or_module(3, "operations", "editor")
require_approver = require_level_or_module(3, "operations", "full")

ROLES = {"ops_manager": "Ops Manager", "owner": "Owner"}
NO_DISCOUNT_API = ("Cubby's API cannot create or end a discount, so enter this promotion in Cubby "
                   "(Pricing > Discounts), then mark it Entered in Cubby here.")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _us(day: str) -> str:
    """YYYY-MM-DD -> MM/DD/YYYY."""
    try:
        return date.fromisoformat(day[:10]).strftime("%m/%d/%Y")
    except (TypeError, ValueError):
        return day or ""


def _usd(c) -> str:
    return "-" if c is None else f"${c / 100:,.2f}"


def _role_ok(user: dict, role: str, db: Session) -> bool:
    lvl = user.get("level", 0)
    try:
        grant = auth._module_level(user["email"], "operations", db)
    except Exception:  # noqa: BLE001
        grant = 0
    if role == "owner":
        return lvl >= 4 or grant >= auth._MODULE_LEVEL_RANK["owner"]
    if role == "ops_manager":
        return lvl >= 3 or grant >= auth._MODULE_LEVEL_RANK["full"]
    return False


def _event(db: Session, fid: str, kind: str, text: str, by: str, unit_type: str = "") -> None:
    db.add(models.OpsCmaEvent(id=str(uuid.uuid4()), facility_id=fid, at=_now(), kind=kind,
                              unit_type=unit_type, text=text[:500], by=by))


def _competitor(db: Session, cid: str, active_only: bool = False) -> models.OpsCompetitor:
    c = db.get(models.OpsCompetitor, cid)
    if not c or (not c.active and not c.closed) or (active_only and not c.active):
        raise HTTPException(status_code=404, detail="Competitor not found")
    return c


async def _facility_today(fid: str) -> tuple[dict, date]:
    facility = await facility_ops._facility(fid)
    return facility, date.fromisoformat(facility["asOf"])


# ── Comp set ─────────────────────────────────────────────────────────────────

def _compset(db: Session, facility: dict) -> dict:
    fid = facility["id"]
    today = date.fromisoformat(facility["asOf"])
    origin = (facility.get("lat"), facility.get("lng"))
    comps = (db.query(models.OpsCompetitor).filter(models.OpsCompetitor.facility_id == fid)
             .filter((models.OpsCompetitor.active == True) | (models.OpsCompetitor.closed == True))  # noqa: E712
             .all())
    surveys = ops_rates._latest_surveys(db, fid)
    rates = (db.query(models.OpsCompetitorRate).filter(models.OpsCompetitorRate.facility_id == fid)
             .order_by(models.OpsCompetitorRate.observed_on.desc(), models.OpsCompetitorRate.created_at.desc()).all())
    by_comp: dict[str, list] = {}
    for r in rates:
        by_comp.setdefault(r.competitor_id, []).append(r)
    out = []
    for c in comps:
        mine = by_comp.get(c.id, [])
        synced = max((r.observed_on for r in mine if r.source in ("web", "stortrack")), default="")
        locks = sum(1 for r in mine if r.source == "override" and (r.locked_until or "") >= today.isoformat())
        latest: dict[str, models.OpsCompetitorRate] = {}
        for r in mine:          # newest first: the first per size wins
            k = ops_market.size_key(r.width, r.depth, bool(r.parking)) + "|" + (r.space_type or "")
            latest.setdefault(k, r)
        if c.closed:
            badge = "closed"
        elif (c.price_source or "") == "manual" or not synced:
            badge = "manual"
        else:
            badge = "website"
        sv = surveys.get(c.id)
        out.append({
            "id": c.id, "name": c.name, "address": c.address or "", "phone": c.phone or "", "website": c.website or "",
            "distanceMiles": ops_rate_mgmt.distance_miles(c.distance_miles, origin, c.lat, c.lng),
            "propertyType": c.property_type or "", "closed": bool(c.closed), "closedNote": c.closed_note or "",
            "priceSource": c.price_source or "website", "badge": badge, "syncedOn": synced, "lockedOverrides": locks,
            "lastSurvey": {"id": sv.id, "date": sv.survey_date, "method": sv.method, "by": sv.surveyed_by,
                           "special": sv.special or "", "adminFee": sv.admin_fee_cents, "insurance": sv.insurance or ""}
            if sv else None,
            "rates": [{"id": r.id, "theirSize": r.their_size or ops_cma.size_label(r.width, r.depth),
                       "width": r.width, "depth": r.depth, "parking": bool(r.parking), "access": r.space_type or "",
                       "street": r.rate_cents, "online": r.online_cents, "promo": r.promo or "",
                       "source": r.source or "manual", "observedOn": r.observed_on,
                       "matchedUnitType": r.matched_unit_type or "", "note": r.size_note or "",
                       "lockedUntil": r.locked_until or "", "overrideReason": r.override_reason or ""}
                      for r in sorted(latest.values(), key=lambda x: (bool(x.parking), (x.width or 0) * (x.depth or 0)))],
        })
    out.sort(key=lambda c: (c["closed"], c["distanceMiles"] is None, c["distanceMiles"] or 0, c["name"]))
    types = [{"name": t["name"], "width": t.get("width") or 0, "depth": t.get("depth") or 0,
              "parking": bool(t.get("parking")), "category": ops_rate_mgmt.category(t)} for t in facility["unitTypes"]]
    return {"facilityId": fid, "facility": facility["shortName"], "name": facility["name"], "asOf": facility["asOf"],
            "competitors": out, "unitTypes": types, "methods": ops_cma.METHODS,
            "storageAccess": list(ops_cma.STORAGE_ACCESS), "parkingAccess": list(ops_cma.PARKING_ACCESS),
            "lockDays": ops_cma.LOCK_DAYS,
            "counts": {"active": sum(1 for c in out if not c["closed"]),
                       "website": sum(1 for c in out if c["badge"] == "website"),
                       "manual": sum(1 for c in out if c["badge"] == "manual"),
                       "closed": sum(1 for c in out if c["closed"])}}


@router.get("/compset")
async def compset(facility_id: str, db: Session = Depends(get_db)):
    facility = await facility_ops._facility(facility_id)
    return await asyncio.to_thread(_compset, db, facility)


class CompetitorIn(BaseModel):
    facility_id: Optional[str] = None
    name: Optional[str] = Field(default=None, max_length=120)
    address: Optional[str] = Field(default=None, max_length=240)
    phone: Optional[str] = Field(default=None, max_length=40)
    website: Optional[str] = Field(default=None, max_length=300)
    distance_miles: Optional[float] = Field(default=None, ge=0, le=500)
    property_type: Optional[str] = Field(default=None, max_length=80)
    price_source: Optional[Literal["website", "manual"]] = None


@router.post("/competitors", status_code=201)
async def add_competitor(body: CompetitorIn, user: dict = Depends(require_editor), db: Session = Depends(get_db)):
    if not (body.name or "").strip():
        raise HTTPException(status_code=422, detail="A competitor needs a name")
    facility = await facility_ops._facility(body.facility_id or "")

    def _save():
        c = models.OpsCompetitor(id=str(uuid.uuid4()), facility_id=facility["id"], name=body.name.strip(),
                                 address=(body.address or "").strip(), phone=(body.phone or "").strip(),
                                 website=(body.website or "").strip(), distance_miles=body.distance_miles or 0,
                                 property_type=(body.property_type or "").strip(),
                                 price_source="manual" if body.price_source == "manual" else "",
                                 rates_url="", watch=False, active=True, closed=False,
                                 created_by=user["email"], created_at=_now())
        db.add(c)
        _event(db, facility["id"], "comp_set", f"{c.name} added to the competitive set", user["email"])
        db.commit()
        return _compset(db, facility)
    return await asyncio.to_thread(_save)


@router.patch("/competitors/{cid}")
async def update_competitor(cid: str, body: CompetitorIn, user: dict = Depends(require_editor), db: Session = Depends(get_db)):
    c = await asyncio.to_thread(_competitor, db, cid)
    facility = await facility_ops._facility(c.facility_id)

    def _save():
        data = body.model_dump(exclude_unset=True, exclude={"facility_id"})
        if "name" in data and not (data["name"] or "").strip():
            raise HTTPException(status_code=422, detail="A competitor needs a name")
        if "price_source" in data:
            new = "manual" if data.pop("price_source") == "manual" else ""
            if new != (c.price_source or ""):
                _event(db, c.facility_id, "comp_set",
                       f"{c.name}: price source set to {'Manual only' if new else 'Website'}", user["email"])
            c.price_source = new
        for k, v in data.items():
            setattr(c, k, (v.strip() if isinstance(v, str) else v) if v is not None else (0 if k == "distance_miles" else ""))
        db.commit()
        return _compset(db, facility)
    return await asyncio.to_thread(_save)


class CloseIn(BaseModel):
    closed: bool
    note: Optional[str] = Field(default="", max_length=300)


@router.post("/competitors/{cid}/close")
async def close_competitor(cid: str, body: CloseIn, user: dict = Depends(require_editor), db: Session = Depends(get_db)):
    """Closed: kept for history, struck through, out of every average (it
    becomes inactive, so the Market screen and StorTrack leave it out too)."""
    c = await asyncio.to_thread(_competitor, db, cid)
    facility = await facility_ops._facility(c.facility_id)

    def _save():
        c.closed, c.active = body.closed, not body.closed
        c.closed_note = (body.note or "").strip() if body.closed else ""
        _event(db, c.facility_id, "comp_set",
               f"{c.name} marked closed - removed from averages{f' ({c.closed_note})' if c.closed_note else ''}"
               if body.closed else f"{c.name} reopened - counted in averages again", user["email"])
        db.commit()
        return _compset(db, facility)
    return await asyncio.to_thread(_save)


# ── Surveys, overrides, import ───────────────────────────────────────────────

class SurveyRate(BaseModel):
    their_size: str = Field(min_length=1, max_length=40)
    kind: Literal["storage", "parking"] = "storage"
    access: Optional[str] = Field(default="", max_length=60)
    street: Optional[float] = Field(default=None, gt=0, le=100000)   # dollars
    online: Optional[float] = Field(default=None, gt=0, le=100000)
    matched_unit_type: Optional[str] = Field(default="", max_length=200)
    note: Optional[str] = Field(default="", max_length=200)


class SurveyIn(BaseModel):
    facility_id: str
    competitor_id: str
    survey_date: str
    method: Literal["phone", "drive_by", "walk_in", "flyer"]
    surveyed_by: str = Field(min_length=1, max_length=80)
    special: Optional[str] = Field(default="", max_length=200)
    admin_fee: Optional[float] = Field(default=None, ge=0, le=10000)
    insurance: Optional[str] = Field(default="", max_length=120)
    rates: list[SurveyRate] = Field(default_factory=list, max_length=60)


def _check_day(day: str, today: date) -> str:
    try:
        d = date.fromisoformat((day or "")[:10])
    except ValueError:
        raise HTTPException(status_code=422, detail="The survey date must be a real calendar date") from None
    if d > today:
        raise HTTPException(status_code=422, detail="The survey date cannot be in the future")
    return d.isoformat()


@router.post("/surveys", status_code=201)
async def save_survey(body: SurveyIn, user: dict = Depends(require_editor), db: Session = Depends(get_db)):
    """A manual survey: who / when / how, the special, admin fee and
    insurance, and their rates by unit - each size matched to one of our unit
    types (the nearest size when no exact one, said in the note)."""
    facility, today = await _facility_today(body.facility_id)
    day = _check_day(body.survey_date, today)
    types = {t["name"]: t for t in facility["unitTypes"]}
    rows = []
    for i, r in enumerate(body.rates, start=1):
        size = ops_cma.parse_size(r.their_size)
        if not size:
            raise HTTPException(status_code=422, detail=f"Row {i}: enter their size like 10 x 20")
        if r.street is None and r.online is None:
            raise HTTPException(status_code=422, detail=f"Row {i}: enter a street or online rate")
        if r.matched_unit_type and r.matched_unit_type not in types:
            raise HTTPException(status_code=422, detail=f"Row {i}: {r.matched_unit_type} is not one of our unit types")
        rows.append((r, size))

    def _save():
        c = _competitor(db, body.competitor_id, active_only=True)
        if c.facility_id != body.facility_id:
            raise HTTPException(status_code=404, detail="Competitor not found")
        sv = models.OpsCmaSurvey(id=str(uuid.uuid4()), facility_id=c.facility_id, competitor_id=c.id, survey_date=day,
                                 method=body.method, surveyed_by=body.surveyed_by.strip(), special=(body.special or "").strip(),
                                 admin_fee_cents=int(round(body.admin_fee * 100)) if body.admin_fee is not None else None,
                                 insurance=(body.insurance or "").strip(), created_by=user["email"], created_at=_now())
        db.add(sv)
        for r, (w, d) in rows:
            parking = r.kind == "parking"
            auto = ops_cma.nearest_type(w, d, parking, list(types.values()))
            matched = r.matched_unit_type or auto["name"]
            note = (r.note or "").strip() or ("" if auto["exact"] or r.matched_unit_type else auto["note"])
            street = int(round(r.street * 100)) if r.street is not None else int(round(r.online * 100))
            db.add(models.OpsCompetitorRate(
                id=str(uuid.uuid4()), competitor_id=c.id, facility_id=c.facility_id, width=w, depth=d, parking=parking,
                rate_cents=street, online_cents=int(round(r.online * 100)) if r.online is not None else None,
                promo=sv.special, observed_on=day, source="manual", entered_by=user["email"], created_at=_now(),
                space_type=(r.access or "").strip(), survey_id=sv.id, their_size=r.their_size.strip(),
                matched_unit_type=matched if (r.matched_unit_type or not auto["exact"]) else "", size_note=note))
        priced = ", ".join(f"{r.their_size.strip()} {_usd(int(round((r.street or r.online) * 100)))}" for r, _ in rows[:4])
        _event(db, c.facility_id, "manual",
               f"Manual survey saved - {c.name} ({ops_cma.METHODS[body.method]}){': ' + priced if priced else ''}",
               body.surveyed_by.strip() or user["email"])
        db.commit()
        return _compset(db, facility)
    return await asyncio.to_thread(_save)


class OverrideIn(BaseModel):
    competitor_id: str
    width: float = Field(gt=0, le=200)
    depth: float = Field(gt=0, le=400)
    parking: bool = False
    rate: float = Field(gt=0, le=100000)
    reason: str = Field(min_length=1, max_length=200)
    lock: bool = True


@router.post("/overrides", status_code=201)
async def save_override(body: OverrideIn, user: dict = Depends(require_editor), db: Session = Depends(get_db)):
    """Use this rate instead of the website's for one size. Locked = it beats
    newer website / StorTrack reads for 30 days, then unlocks by itself."""
    c = await asyncio.to_thread(_competitor, db, body.competitor_id, True)
    facility, today = await _facility_today(c.facility_id)

    def _save():
        until = (today + timedelta(days=ops_cma.LOCK_DAYS)).isoformat() if body.lock else ""
        db.add(models.OpsCompetitorRate(
            id=str(uuid.uuid4()), competitor_id=c.id, facility_id=c.facility_id, width=body.width, depth=body.depth,
            parking=body.parking, rate_cents=int(round(body.rate * 100)), observed_on=today.isoformat(),
            source="override", entered_by=user["email"], created_at=_now(), locked_until=until,
            override_reason=body.reason.strip(), their_size=ops_cma.size_label(body.width, body.depth)))
        _event(db, c.facility_id, "manual",
               f"{c.name} {ops_cma.size_label(body.width, body.depth)}{' parking' if body.parking else ''}: "
               f"using {_usd(int(round(body.rate * 100)))} instead of the website price ({body.reason.strip()})"
               f"{', locked until ' + _us(until) if until else ''}",
               user["email"])
        db.commit()
        return _compset(db, facility)
    return await asyncio.to_thread(_save)


class ImportIn(BaseModel):
    facility_id: str
    rows: list[dict] = Field(max_length=2000)
    commit: bool = False


@router.post("/import")
async def import_rates(body: ImportIn, user: dict = Depends(require_editor), db: Session = Depends(get_db)):
    """Manual competitor rates from a CSV / XLS sheet (columns: ops_cma.
    IMPORT_COLUMNS). commit=false previews every row with its errors and
    saves nothing; commit=true saves the rows without errors as manual
    observations (one survey per competitor and date, method "Flyer /
    Signage" unless known) and reports the ones it skipped."""
    facility, today = await _facility_today(body.facility_id)

    def _run():
        comps = {c.name.strip().lower(): c.id for c in db.query(models.OpsCompetitor)
                 .filter(models.OpsCompetitor.facility_id == facility["id"], models.OpsCompetitor.active == True).all()}  # noqa: E712
        checked = ops_cma.read_import(body.rows, comps, facility["unitTypes"], today)
        good = [r for r in checked if r["ok"]]
        out = {"rows": checked, "ok": len(good), "errors": len(checked) - len(good), "saved": 0,
               "columns": ops_cma.IMPORT_COLUMNS}
        if not body.commit or not good:
            return out
        surveys: dict[tuple, models.OpsCmaSurvey] = {}
        for r in good:
            k = (r["competitorId"], r["observedOn"])
            if k not in surveys:
                surveys[k] = models.OpsCmaSurvey(
                    id=str(uuid.uuid4()), facility_id=facility["id"], competitor_id=r["competitorId"],
                    survey_date=r["observedOn"], method="flyer", surveyed_by=user["email"], special=r["special"],
                    admin_fee_cents=r["adminFee"], insurance="", created_by=user["email"], created_at=_now())
                db.add(surveys[k])
            db.add(models.OpsCompetitorRate(
                id=str(uuid.uuid4()), competitor_id=r["competitorId"], facility_id=facility["id"], width=r["width"],
                depth=r["depth"], parking=r["parking"], rate_cents=r["street"] or r["online"], online_cents=r["online"],
                promo=r["special"], observed_on=r["observedOn"], source="manual", entered_by=user["email"],
                created_at=_now(), space_type=r["access"], survey_id=surveys[k].id,
                their_size=ops_cma.size_label(r["width"], r["depth"]), matched_unit_type=r["matchedUnitType"]))
        _event(db, facility["id"], "import", f"Imported {len(good)} manual competitor rates from a sheet"
               f"{f' ({len(checked) - len(good)} rows skipped)' if len(checked) > len(good) else ''}", user["email"])
        db.commit()
        out["saved"] = len(good)
        return out
    return await asyncio.to_thread(_run)


# ── Rate History ─────────────────────────────────────────────────────────────

def _history(db: Session, facility: dict, unit_type: str, groups: list, start: str = "", end: str = "") -> dict:
    fid = facility["id"]
    today = date.fromisoformat(facility["asOf"])
    t = next((x for x in facility["unitTypes"] if x["name"] == unit_type), None)
    if not t:
        raise HTTPException(status_code=404, detail="That unit type is not at this facility")
    g = ops_rate_mgmt.group_index(groups).get(unit_type) or {}
    gid = g.get("pricingGroupId") or ""
    sell_now = ops_rate_mgmt.sell_of(g) if g else (t.get("street") or 0)
    obs, active = ops_rates._observations(db, fid, (facility.get("lat"), facility.get("lng")))
    snaps = (db.query(models.OpsCmaSnapshot).filter(models.OpsCmaSnapshot.facility_id == fid,
                                                    models.OpsCmaSnapshot.unit_type == unit_type)
             .order_by(models.OpsCmaSnapshot.day).all())
    changes = []
    if gid:
        changes = (db.query(models.CubbyRateHistory)
                   .filter(models.CubbyRateHistory.facility_id == fid, models.CubbyRateHistory.pricing_group_id == gid)
                   .order_by(models.CubbyRateHistory.changed_at).all())
    web = [c for c in changes if c.field == "webRate"]
    std = [c for c in changes if c.field == "standardRate"]

    def at(seq, day, now):
        """A rate on `day` from its change rows (step function)."""
        before = [c for c in seq if (c.changed_on or c.changed_at[:10]) <= day]
        if before:
            return before[-1].new_value
        after = [c for c in seq if (c.changed_on or c.changed_at[:10]) > day]
        return after[0].old_value if after else now
    # The market on each day a competitor rate was seen (last 12 months), from
    # what was known by that day - the same ops_cma set the table uses.
    since = (today - timedelta(days=365)).isoformat()
    obs_days = sorted({o["observed_on"] for o in obs if (o.get("observed_on") or "") >= since})
    days = sorted(set(obs_days[-26:]) | {s.day for s in snaps} | {(c.changed_on or c.changed_at[:10]) for c in web}
                  | {today.isoformat()})
    snap = {s.day: s for s in snaps}
    points = []
    for d in days:
        if d < since:
            continue
        m = ops_cma.pick_comps(t, [o for o in obs if o["observed_on"] <= d], active, date.fromisoformat(d))
        s = snap.get(d)
        points.append({"date": d, "sell": at(web, d, sell_now) if web else (s.sell_cents if s else sell_now),
                       "standard": at(std, d, g.get("standardRate") if g else None),
                       "avgRent": s.avg_rent_cents if s else None, "occupied": s.occupied if s else None,
                       "total": s.total if s else None,
                       "marketAvg": m["avg"], "marketLow": m["low"], "marketHigh": m["high"], "comps": m["count"]})
    # Hummingbird (before Cubby, Sep 2026): a point per month-end with our
    # sell rate, in-place rent and occupancy (no market - surveys came later).
    # A market reading dated before Cubby takes our rates from that HB month,
    # not from Cubby's first-known rate.
    hb = hb_history.rate_history(db, facility.get("shortName") or "", unit_type)
    hb_month = {p["date"][:7]: p for p in hb["points"]}
    for p in points:
        h = hb_month.get(p["date"][:7]) if p["date"][:7] < hb_history.ob.CUBBY_FROM else None
        if h:
            p["sell"] = h["sell"]
            for k in ("avgRent", "occupied", "total"):
                if p.get(k) is None:
                    p[k] = h[k]
            p["source"] = "hummingbird"
    taken = {p["date"] for p in points}
    hb_points = [p for p in hb["points"] if p["date"] not in taken]
    points = sorted(hb_points + points, key=lambda p: p["date"])
    # The whole span on record, then the period asked for (Visesh, Oct 21: a
    # date filter to see the Hummingbird years). Both ends optional, inclusive.
    span = {"first": points[0]["date"] if points else "", "last": points[-1]["date"] if points else ""}
    if start or end:
        points = [p for p in points if (not start or p["date"] >= start) and (not end or p["date"] <= end)]
    cur = ops_cma.pick_comps(t, obs, active, today)
    rented = t.get("rented") or 0
    avg_rent = round((t.get("rentSum") or 0) / rented) if rented else None
    first = next((p for p in points if p["occupied"] is not None), None)
    # The trend card follows the period: with an end date it ends at the last
    # month in it, not today (Visesh, Oct 21).
    last = next((p for p in reversed(points) if p["occupied"] is not None), None) if end else None
    cards = {
        "gap": (sell_now - cur["avg"]) if cur["avg"] else None,
        "gapPct": round((sell_now - cur["avg"]) / cur["avg"], 4) if cur["avg"] else None,
        "comps": cur["count"], "asOf": facility["asOf"],
        "avgRent": avg_rent, "sell": sell_now, "rentVsSell": (avg_rent - sell_now) if avg_rent is not None else None,
        "occupiedThen": first["occupied"] if first else None, "occupiedFrom": first["date"] if first else "",
        "occupiedNow": last["occupied"] if last else rented,
        "occupiedTo": last["date"] if last else facility["asOf"],
        "total": (last.get("total") if last else None) or t.get("total") or 0,
    }
    log = []
    for e in (db.query(models.OpsCmaEvent).filter(models.OpsCmaEvent.facility_id == fid)
              .filter((models.OpsCmaEvent.unit_type == "") | (models.OpsCmaEvent.unit_type == unit_type))
              .order_by(models.OpsCmaEvent.at.desc()).limit(150).all()):
        log.append({"at": e.at, "date": e.at[:10], "text": e.text, "source": e.kind, "by": e.by})
    labels = {"webRate": "web (sell) rate", "standardRate": "standard rate", "walkInRate": "walk-in rate",
              "strikethroughRate": "strikethrough rate"}
    for c in changes:
        if c.field in labels:
            log.append({"at": c.changed_at, "date": c.changed_on or c.changed_at[:10], "source": "cubby", "by": "",
                        "text": f"Our {labels[c.field]} {_usd(c.old_value)} -> {_usd(c.new_value)}"})
    key = ops_market.size_key(t.get("width"), t.get("depth"), bool(t.get("parking"))) if t.get("width") else ""
    synced: dict[str, int] = {}
    for o in obs:
        if o["source"] in ("web", "stortrack") and key and ops_market.size_key(o["width"], o["depth"], o["parking"]) == key:
            synced[o["observed_on"]] = synced.get(o["observed_on"], 0) + 1
    for d, n in synced.items():
        log.append({"at": d, "date": d, "source": "website", "by": "Nexus",
                    "text": f"Website sync - {n} competitor {'price' if n == 1 else 'prices'} for this size"})
    log += hb["log"]
    if start or end:
        log = [e for e in log if (not start or (e["date"] or "") >= start) and (not end or (e["date"] or "") <= end)]
    log.sort(key=lambda x: x["at"] or "", reverse=True)
    return {"unitType": unit_type, "asOf": facility["asOf"], "points": points, "cards": cards,
            "comps": cur["comps"], "log": log[:500], "groupId": gid, "span": span,
            "range": {"start": start, "end": end},
            "hummingbird": {"first": hb_points[0]["date"][:7] if hb_points else "",
                            "last": hb_points[-1]["date"][:7] if hb_points else ""}}


@router.get("/history")
async def history(facility_id: str, unit_type: str, start: str = "", end: str = "", db: Session = Depends(get_db)):
    for v in (start, end):
        if v and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
            raise HTTPException(status_code=400, detail="Dates must be YYYY-MM-DD")
    if start and end and start > end:
        raise HTTPException(status_code=400, detail="The start date is after the end date")
    facility = await facility_ops._facility(facility_id)
    groups, _fac, _err = await ops_rates._groups(facility_id)
    return await asyncio.to_thread(_history, db, facility, unit_type, groups, start, end)


# ── Review & Push ────────────────────────────────────────────────────────────

def _last_change_on(db: Session, fid: str, unit_type: str) -> str:
    """When this pricing group last changed through Nexus (pushed or entered)."""
    a = (db.query(models.OpsRatePush.pushed_at)
         .filter(models.OpsRatePush.facility_id == fid, models.OpsRatePush.unit_type == unit_type,
                 models.OpsRatePush.status.in_(("ok", "entered")))
         .order_by(models.OpsRatePush.pushed_at.desc()).first())
    b = (db.query(models.OpsCmaChange.done_at)
         .filter(models.OpsCmaChange.facility_id == fid, models.OpsCmaChange.unit_type == unit_type,
                 models.OpsCmaChange.kind == "rate", models.OpsCmaChange.status.in_(("pushed", "entered")))
         .order_by(models.OpsCmaChange.done_at.desc()).first())
    return max((a[0] if a else "") or "", (b[0] if b else "") or "")[:10]


def _first_of_next_month(today: date) -> str:
    return (today.replace(day=1) + timedelta(days=32)).replace(day=1).isoformat()


def _rate_item(db: Session, r: dict, fid: str, today: date) -> dict:
    occ = round(r["occupancy"] * 100)
    if r["variancePct"] is not None and r["marketAvg"]:
        why = (f"{occ}% occupied, {abs(r['variancePct']) * 100:.1f}% {'below' if r['variancePct'] < 0 else 'above'} "
               f"market avg ({_usd(r['marketAvg'])})")
    else:
        why = f"{occ}% occupied, no market average yet"
    note = (r.get("draft") or {}).get("note") or ""
    g = ops_cma.guard(r["sell"], r["proposed"], r["set"], r["proposedSet"], r["marketLow"],
                      _last_change_on(db, fid, r["name"]), today)
    return {"type": "rate", "key": f"rate:{r['name']}", "unitType": r["name"], "groupId": r["groupId"],
            "category": r["category"], "nowWeb": r["sell"], "newWeb": r["proposed"], "nowStandard": r["set"],
            "newStandard": r["proposedSet"], "why": note or why, "reason": r["why"],
            "change": "Rate Increase" if r["proposed"] > r["sell"] else "Rate Decrease" if r["proposed"] < r["sell"] else "Rate Change",
            "effective": _first_of_next_month(today),
            "affects": f"New move-ins - {r['vacant']} vacant {'space' if r['vacant'] == 1 else 'spaces'}",
            "revDelta": r["revDelta"], "marketLow": r["marketLow"],
            "proposedBy": (r.get("draft") or {}).get("updatedBy") or "", "proposedAt": (r.get("draft") or {}).get("updatedAt") or "",
            **g}


def _change_dict(c: models.OpsCmaChange) -> dict:
    return {"id": c.id, "requestId": c.request_id, "kind": c.kind, "unitType": c.unit_type, "groupId": c.pricing_group_id,
            "oldWeb": c.old_web_cents, "newWeb": c.new_web_cents, "oldStandard": c.old_standard_cents,
            "newStandard": c.new_standard_cents, "promo": c.promo or {}, "promoText": ops_cma.promo_text(c.promo or {}) if c.kind != "rate" else "",
            "reason": c.reason or "", "effective": c.effective_date or "", "affects": c.affects or "",
            "status": c.status, "needsOwner": bool(c.needs_owner), "guardNotes": c.guard_notes or [],
            "proposedBy": c.proposed_by or "", "proposedAt": c.proposed_at or "",
            "approverRole": c.approver_role or "", "approvedBy": c.approved_by or "", "approvedAt": c.approved_at or "",
            "sendMode": c.send_mode or "", "note": c.note or "", "detail": c.cubby_detail or "",
            "readbackWeb": c.readback_web_cents, "readbackStandard": c.readback_standard_cents,
            "doneBy": c.done_by or "", "doneAt": c.done_at or "", "revertOf": c.revert_of or "",
            "revertedBy": c.reverted_by or "", "revertedAt": c.reverted_at or ""}


def _review(db: Session, facility: dict, groups: list, fac: dict, err: str, user: dict) -> dict:
    view = ops_rates._view(db, facility, groups, fac, err, user)
    today = date.fromisoformat(facility["asOf"])
    fid = facility["id"]
    rates = [_rate_item(db, r, fid, today) for r in view["rows"] if r["ready"]]
    promos = (db.query(models.OpsCmaChange)
              .filter(models.OpsCmaChange.facility_id == fid, models.OpsCmaChange.kind != "rate",
                      models.OpsCmaChange.status == "proposed")
              .order_by(models.OpsCmaChange.proposed_at).all())
    decided = (db.query(models.OpsCmaChange)
               .filter(models.OpsCmaChange.facility_id == fid, models.OpsCmaChange.status != "proposed")
               .order_by(models.OpsCmaChange.approved_at.desc(), models.OpsCmaChange.done_at.desc()).limit(60).all())
    return {"facilityId": fid, "facility": view["facility"], "name": view["name"], "asOf": view["asOf"],
            "rates": rates, "promos": [_change_dict(p) for p in promos], "decided": [_change_dict(c) for c in decided],
            "unitTypes": [{"name": r["name"], "category": r["category"], "vacant": r["vacant"], "occupancy": r["occupancy"],
                           "variancePct": r["variancePct"]} for r in view["rows"]],
            "roles": {k: _role_ok(user, k, db) for k in ROLES}, "roleLabels": ROLES,
            "canPropose": view["canEdit"], "calculations": ops_cma.CALCULATIONS,
            **ops_cubby_push.status(db)}


@router.get("/review")
async def review(facility_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    facility = await facility_ops._facility(facility_id)
    groups, fac, err = await ops_rates._groups(facility_id)
    return await asyncio.to_thread(_review, db, facility, groups, fac, err, user)


class PromoIn(BaseModel):
    facility_id: str
    kind: Literal["promo_add", "promo_end"] = "promo_add"
    name: str = Field(min_length=1, max_length=120)
    calculation: Optional[Literal["percent", "fixed", "first_month_1"]] = "percent"
    amount: Optional[float] = Field(default=None, ge=0, le=100000)
    periods: Optional[int] = Field(default=1, ge=1, le=24)
    start: Optional[str] = ""
    end: Optional[str] = ""
    unit_types: list[str] = Field(default_factory=list, max_length=200)
    reason: Optional[str] = Field(default="", max_length=300)
    cubby_discount_id: Optional[str] = Field(default="", max_length=80)   # promo_end: the discount in Cubby


@router.post("/promos", status_code=201)
async def propose_promo(body: PromoIn, user: dict = Depends(require_editor), db: Session = Depends(get_db)):
    """Propose a new promotion (Cubby: discount) on some pricing groups, or
    the end of one. Goes into Review & Push like a rate change."""
    facility, today = await _facility_today(body.facility_id)
    names = {t["name"] for t in facility["unitTypes"]}
    promo = {"name": body.name.strip(), "calculation": body.calculation, "amount": body.amount, "periods": body.periods or 1,
             "start": body.start or "", "end": body.end or "", "unitTypes": [u for u in body.unit_types if u in names],
             "cubbyDiscountId": body.cubby_discount_id or ""}
    errs = ops_cma.validate_promo(promo) if body.kind == "promo_add" else (
        [] if promo["unitTypes"] and promo["end"] else ["Pick the pricing groups and the end date"])
    if errs:
        raise HTTPException(status_code=422, detail="; ".join(errs))

    def _save():
        vac = {t["name"]: t.get("vacant") or 0 for t in facility["unitTypes"]}
        n = sum(vac.get(u, 0) for u in promo["unitTypes"])
        c = models.OpsCmaChange(id=str(uuid.uuid4()), facility_id=facility["id"], kind=body.kind,
                                unit_type=", ".join(promo["unitTypes"])[:500], promo=promo,
                                reason=(body.reason or "").strip(), effective_date=promo["start"] or promo["end"] or today.isoformat(),
                                affects=f"New move-ins only - {n} vacant {'space' if n == 1 else 'spaces'}",
                                status="proposed", proposed_by=user["email"], proposed_at=_now())
        db.add(c)
        db.commit()
        return _change_dict(c)
    return await asyncio.to_thread(_save)


@router.delete("/promos/{pid}")
def withdraw_promo(pid: str, user: dict = Depends(require_editor), db: Session = Depends(get_db)):
    c = db.get(models.OpsCmaChange, pid)
    if not c or c.kind == "rate" or c.status != "proposed":
        raise HTTPException(status_code=404, detail="Proposed promotion not found")
    db.delete(c)
    db.commit()
    return {"ok": True}


def _readback(fid: str, gid: str) -> dict | None:
    ops_rate_mgmt.forget(fid)
    groups, _fac = ops_rate_mgmt.pricing_groups(fid, fresh=True)
    return next((g for g in groups if g.get("pricingGroupId") == gid), None)


def _push(db: Session, ch: models.OpsCmaChange, email: str, vacant: int = 0) -> None:
    """Send one approved rate change to Cubby, read it back, record the
    result on the change and in ops_rate_pushes. Blocking. Never raises for a
    Cubby problem - the change says what happened (partial failure stays per
    change)."""
    rec = models.OpsRatePush(id=str(uuid.uuid4()), batch_id=ch.request_id, facility_id=ch.facility_id, unit_type=ch.unit_type,
                             pricing_group_id=ch.pricing_group_id, old_set_cents=ch.old_standard_cents,
                             old_sell_cents=ch.old_web_cents, new_set_cents=ch.new_standard_cents,
                             new_sell_cents=ch.new_web_cents, vacant=vacant,
                             monthly_delta_cents=((ch.new_web_cents or 0) - (ch.old_web_cents or 0)) * vacant,
                             pushed_by=email, pushed_at=_now())
    try:
        ops_cubby_push.change_rate(db, ch.pricing_group_id, ch.new_standard_cents, ch.new_web_cents)
        try:
            g = _readback(ch.facility_id, ch.pricing_group_id)
        except cubby.CubbyError as e:
            g = None
            print(f"[ops-cma] read-back failed: {e.status}")
        ch.readback_web_cents = (g or {}).get("webRate")
        ch.readback_standard_cents = (g or {}).get("standardRate")
        if g and g.get("webRate") == ch.new_web_cents and g.get("standardRate") == ch.new_standard_cents:
            ch.status, ch.cubby_detail = "pushed", "Cubby shows the new rates (read back)"
            rec.status, rec.detail = "ok", "Updated in Cubby, confirmed by read-back"
        else:
            ch.status = "failed"
            ch.cubby_detail = ("Cubby took the change but its rates did not read back as sent - check Cubby, then retry"
                               if g else "Cubby took the change but it could not be read back - check Cubby, then retry")
            rec.status, rec.detail = "failed", ch.cubby_detail
    except ops_cubby_push.PushOff as e:
        ch.status, ch.cubby_detail = "approved", str(e)[:500]
        rec = None
    except cubby.CubbyError as e:
        ch.status, ch.cubby_detail = "failed", (e.message or "Cubby refused the change")[:500]
        rec.status, rec.detail = "failed", ch.cubby_detail
    ch.done_by, ch.done_at = email, _now()
    if rec is not None:
        db.add(rec)
    _event(db, ch.facility_id, "cubby",
           f"{ch.unit_type}: web {_usd(ch.old_web_cents)} -> {_usd(ch.new_web_cents)}, standard "
           f"{_usd(ch.old_standard_cents)} -> {_usd(ch.new_standard_cents)} - "
           f"{'pushed to Cubby' if ch.status == 'pushed' else 'push ' + ch.status}", email, ch.unit_type)


class ApplyIn(BaseModel):
    facility_id: str
    request_id: str = Field(min_length=8, max_length=80)
    rates: list[str] = Field(default_factory=list, max_length=200)
    promos: list[str] = Field(default_factory=list, max_length=200)
    approver_role: Literal["ops_manager", "owner"]
    send: Literal["effective", "immediate"] = "effective"
    effective_date: Optional[str] = ""
    note: Optional[str] = Field(default="", max_length=500)
    mode: Literal["push", "entered"] = "entered"


@router.post("/review/apply")
async def apply(body: ApplyIn, user: dict = Depends(require_approver), db: Session = Depends(get_db)):
    """Approve the ticked changes. Guardrails per change: over 10% or below
    the market low needs the Owner; .50 endings kept; no pricing group twice
    in 7 days. mode "entered" (the switch off, or by choice): staff entered
    them in Cubby by hand - recorded as entered. mode "push": the switch must
    be on; rate changes go to Cubby now (Immediately, or the effective date is
    today or past) or on their effective date, each read back; promotions are
    approved and wait for Mark Entered (Cubby has no discount API).
    Idempotent: the same request_id returns the first answer."""
    if not body.rates and not body.promos:
        raise HTTPException(status_code=422, detail="Tick at least one change")
    if not _role_ok(user, body.approver_role, db):
        raise HTTPException(status_code=403, detail=f"You can't approve as {ROLES[body.approver_role]}")
    if body.mode == "push":
        await asyncio.to_thread(ops_cubby_push.require_push, db)
    facility, today = await _facility_today(body.facility_id)
    groups, fac, err = await ops_rates._groups(body.facility_id, fresh=body.mode == "push")
    if body.mode == "push" and err:
        raise HTTPException(status_code=424, detail=f"Cubby's pricing groups could not be read: {err}")
    eff = ""
    if body.effective_date:
        try:
            eff = date.fromisoformat(body.effective_date).isoformat()
        except ValueError:
            raise HTTPException(status_code=422, detail="The effective date must be a real calendar date") from None
    email = user["email"]

    def _run():
        seen = db.query(models.OpsCmaChange).filter(models.OpsCmaChange.request_id == body.request_id).all()
        if seen:
            return {"requestId": body.request_id, "replayed": True,
                    "results": [{"key": f"rate:{c.unit_type}" if c.kind == "rate" else f"promo:{c.id}", **_change_dict(c)} for c in seen]}
        view = ops_rates._view(db, facility, groups, fac, err, user)
        rows = {r["name"]: r for r in view["rows"]}
        results = []
        stamp = _now()
        for name in dict.fromkeys(body.rates):
            r = rows.get(name)
            d = (db.query(models.OpsRateDraft)
                 .filter(models.OpsRateDraft.facility_id == facility["id"], models.OpsRateDraft.unit_type == name)
                 .with_for_update().first())
            if not r or not d or not r["ready"]:
                results.append({"key": f"rate:{name}", "unitType": name, "status": "skipped",
                                "detail": "No proposed rate ready for this pricing group (someone may have changed it)"})
                continue
            item = _rate_item(db, r, facility["id"], today)
            if item["blocks"]:
                results.append({"key": f"rate:{name}", "unitType": name, "status": "blocked", "detail": "; ".join(item["blocks"])})
                continue
            if item["needsOwner"] and body.approver_role != "owner":
                results.append({"key": f"rate:{name}", "unitType": name, "status": "blocked",
                                "detail": "; ".join(item["notes"]) + ". Pick Owner as the approver."})
                continue
            ch = models.OpsCmaChange(
                id=str(uuid.uuid4()), request_id=body.request_id, facility_id=facility["id"], kind="rate", unit_type=name,
                pricing_group_id=r["groupId"], old_web_cents=r["sell"], new_web_cents=r["proposed"],
                old_standard_cents=r["set"], new_standard_cents=r["proposedSet"], reason=item["why"],
                effective_date=eff or item["effective"], affects=item["affects"], needs_owner=item["needsOwner"],
                guard_notes=item["notes"], proposed_by=item["proposedBy"], proposed_at=item["proposedAt"],
                approver_role=body.approver_role, approved_by=email, approved_at=stamp, send_mode=body.send,
                note=(body.note or "").strip(), status="approved")
            db.add(ch)
            db.delete(d)
            if body.mode == "entered":
                ch.status, ch.cubby_detail, ch.done_by, ch.done_at = "entered", "Entered in Cubby by hand", email, stamp
                db.add(models.OpsRatePush(
                    id=str(uuid.uuid4()), batch_id=body.request_id, facility_id=facility["id"], unit_type=name,
                    pricing_group_id=r["groupId"], old_set_cents=r["set"], old_sell_cents=r["sell"],
                    new_set_cents=r["proposedSet"], new_sell_cents=r["proposed"], vacant=r["vacant"],
                    monthly_delta_cents=(r["proposed"] - r["sell"]) * r["vacant"], status="entered",
                    detail=ops_rates.ENTERED_DETAIL, pushed_by=email, pushed_at=stamp))
                _event(db, facility["id"], "cubby", f"{name}: web {_usd(r['sell'])} -> {_usd(r['proposed'])} approved "
                       f"({ROLES[body.approver_role]}) and entered in Cubby by hand", email, name)
            elif body.send == "immediate" or ch.effective_date <= today.isoformat():
                db.flush()
                _push(db, ch, email, r["vacant"])
            else:
                ch.cubby_detail = f"Queued: goes to Cubby on {_us(ch.effective_date)}"
                _event(db, facility["id"], "cubby", f"{name}: web {_usd(r['sell'])} -> {_usd(r['proposed'])} approved, "
                       f"queued for {_us(ch.effective_date)}", email, name)
            results.append({"key": f"rate:{name}", **_change_dict(ch)})
        for pid in dict.fromkeys(body.promos):
            c = (db.query(models.OpsCmaChange)
                 .filter(models.OpsCmaChange.id == pid, models.OpsCmaChange.facility_id == facility["id"])
                 .with_for_update().first())
            if not c or c.kind == "rate" or c.status != "proposed":
                results.append({"key": f"promo:{pid}", "status": "skipped", "detail": "This promotion is no longer awaiting approval"})
                continue
            c.request_id, c.approver_role, c.approved_by, c.approved_at = body.request_id, body.approver_role, email, stamp
            c.send_mode, c.note = body.send, (body.note or "").strip()
            if body.mode == "entered":
                c.status, c.cubby_detail, c.done_by, c.done_at = "entered", "Entered in Cubby by hand", email, stamp
            else:
                c.status, c.cubby_detail = "approved", NO_DISCOUNT_API
            _event(db, facility["id"], "cubby", f"Promotion {c.promo.get('name', '')} ({ops_cma.promo_text(c.promo or {})}) "
                   f"{'approved and entered in Cubby by hand' if c.status == 'entered' else 'approved - to enter in Cubby'}", email)
            results.append({"key": f"promo:{pid}", **_change_dict(c)})
        db.commit()
        return {"requestId": body.request_id, "replayed": False, "results": results}

    out = await asyncio.to_thread(_run)
    groups, fac, err = await ops_rates._groups(body.facility_id)
    out["review"] = await asyncio.to_thread(_review, db, facility, groups, fac, err, user)
    print(f"[ops-cma] apply {body.request_id} ({body.mode}): "
          + ", ".join(f"{r.get('unitType') or r.get('key')}={r.get('status')}" for r in out["results"]))
    return out


class RejectIn(BaseModel):
    facility_id: str
    rates: list[str] = Field(default_factory=list, max_length=200)
    promos: list[str] = Field(default_factory=list, max_length=200)
    note: Optional[str] = Field(default="", max_length=500)


@router.post("/review/reject")
async def reject(body: RejectIn, user: dict = Depends(require_approver), db: Session = Depends(get_db)):
    """Return proposals to the proposer: the rate drafts are cleared (the
    rejection, with the note, stays in the log) and promotions are rejected."""
    facility, today = await _facility_today(body.facility_id)
    groups, fac, err = await ops_rates._groups(body.facility_id)

    def _run():
        view = ops_rates._view(db, facility, groups, fac, err, user)
        rows = {r["name"]: r for r in view["rows"]}
        stamp, note = _now(), (body.note or "").strip()
        for name in dict.fromkeys(body.rates):
            d = (db.query(models.OpsRateDraft)
                 .filter(models.OpsRateDraft.facility_id == facility["id"], models.OpsRateDraft.unit_type == name)
                 .with_for_update().first())
            r = rows.get(name)
            if not d or not r:
                continue
            db.add(models.OpsCmaChange(
                id=str(uuid.uuid4()), facility_id=facility["id"], kind="rate", unit_type=name, pricing_group_id=r["groupId"],
                old_web_cents=r["sell"], new_web_cents=r["proposed"], old_standard_cents=r["set"],
                new_standard_cents=r["proposedSet"], status="rejected", proposed_by=d.updated_by or "",
                proposed_at=d.updated_at or "", approved_by=user["email"], approved_at=stamp, note=note))
            db.delete(d)
            _event(db, facility["id"], "cubby", f"{name}: proposed web {_usd(r['proposed'])} returned to "
                   f"{d.updated_by or 'the proposer'}{f' - {note}' if note else ''}", user["email"], name)
        for pid in dict.fromkeys(body.promos):
            c = db.get(models.OpsCmaChange, pid)
            if c and c.kind != "rate" and c.status == "proposed" and c.facility_id == facility["id"]:
                c.status, c.approved_by, c.approved_at, c.note = "rejected", user["email"], stamp, note
        db.commit()
        return _review(db, facility, groups, fac, err, user)
    return await asyncio.to_thread(_run)


def _change(db: Session, cid: str) -> models.OpsCmaChange:
    c = db.query(models.OpsCmaChange).filter(models.OpsCmaChange.id == cid).with_for_update().first()
    if not c:
        raise HTTPException(status_code=404, detail="Change not found")
    return c


async def _after(db: Session, fid: str, user: dict) -> dict:
    facility = await facility_ops._facility(fid)
    groups, fac, err = await ops_rates._groups(fid)
    return await asyncio.to_thread(_review, db, facility, groups, fac, err, user)


@router.post("/changes/{cid}/entered")
async def change_entered(cid: str, user: dict = Depends(require_editor), db: Session = Depends(get_db)):
    """An approved (or failed) change was entered in Cubby by hand."""
    def _run():
        c = _change(db, cid)
        if c.status not in ("approved", "failed"):
            raise HTTPException(status_code=409, detail="Only an approved change can be marked entered")
        stamp = _now()
        c.status, c.cubby_detail, c.done_by, c.done_at = "entered", "Entered in Cubby by hand", user["email"], stamp
        if c.kind == "rate":
            db.add(models.OpsRatePush(
                id=str(uuid.uuid4()), batch_id=c.request_id, facility_id=c.facility_id, unit_type=c.unit_type,
                pricing_group_id=c.pricing_group_id, old_set_cents=c.old_standard_cents, old_sell_cents=c.old_web_cents,
                new_set_cents=c.new_standard_cents, new_sell_cents=c.new_web_cents, status="entered",
                detail=ops_rates.ENTERED_DETAIL, pushed_by=user["email"], pushed_at=stamp))
        _event(db, c.facility_id, "cubby", f"{c.unit_type if c.kind == 'rate' else 'Promotion ' + (c.promo or {}).get('name', '')} "
               f"entered in Cubby by hand", user["email"], c.unit_type if c.kind == "rate" else "")
        db.commit()
        return c.facility_id
    fid = await asyncio.to_thread(_run)
    return await _after(db, fid, user)


@router.post("/changes/{cid}/retry")
async def change_retry(cid: str, user: dict = Depends(require_approver), db: Session = Depends(get_db)):
    """Push a failed or queued rate change again, now (switch on)."""
    await asyncio.to_thread(ops_cubby_push.require_push, db)

    def _run():
        c = _change(db, cid)
        if c.kind != "rate" or c.status not in ("approved", "failed"):
            raise HTTPException(status_code=409, detail="Only a queued or failed rate change can be pushed again")
        _push(db, c, user["email"])
        db.commit()
        return c.facility_id
    fid = await asyncio.to_thread(_run)
    return await _after(db, fid, user)


@router.post("/changes/{cid}/revert")
async def change_revert(cid: str, user: dict = Depends(require_approver), db: Session = Depends(get_db)):
    """One-click revert to the rates before this change. With Push to Cubby
    on (and a key): the old rates are pushed now and read back. Off: the old
    rates become a proposed rate in Review & Push, to enter in Cubby."""
    status = await asyncio.to_thread(ops_cubby_push.status, db)

    def _run():
        c = _change(db, cid)
        if c.kind != "rate" or c.status not in ("pushed", "entered") or c.reverted_at:
            raise HTTPException(status_code=409, detail="Only a rate change that reached Cubby can be reverted, once")
        stamp = _now()
        c.reverted_by, c.reverted_at = user["email"], stamp
        if status["pushReady"]:
            r = models.OpsCmaChange(
                id=str(uuid.uuid4()), request_id=str(uuid.uuid4()), facility_id=c.facility_id, kind="rate",
                unit_type=c.unit_type, pricing_group_id=c.pricing_group_id, old_web_cents=c.new_web_cents,
                new_web_cents=c.old_web_cents, old_standard_cents=c.new_standard_cents, new_standard_cents=c.old_standard_cents,
                reason="Revert", effective_date=stamp[:10], status="approved", proposed_by=user["email"], proposed_at=stamp,
                approver_role="ops_manager", approved_by=user["email"], approved_at=stamp, send_mode="immediate",
                revert_of=c.id)
            db.add(r)
            db.flush()
            _push(db, r, user["email"])
            if r.status == "pushed":
                c.status = "reverted"
            else:
                c.reverted_by, c.reverted_at = "", ""
        else:
            d = (db.query(models.OpsRateDraft)
                 .filter(models.OpsRateDraft.facility_id == c.facility_id, models.OpsRateDraft.unit_type == c.unit_type)
                 .with_for_update().first())
            if not d:
                d = models.OpsRateDraft(id=str(uuid.uuid4()), facility_id=c.facility_id, unit_type=c.unit_type, created_at=stamp)
                db.add(d)
            d.pricing_group_id = c.pricing_group_id
            d.proposed_cents, d.proposed_set_cents = c.old_web_cents, c.old_standard_cents
            d.note, d.updated_by, d.updated_at = f"Revert to the rates before {_us(stamp)}", user["email"], stamp
            c.status = "reverted"
            _event(db, c.facility_id, "cubby", f"{c.unit_type}: revert to web {_usd(c.old_web_cents)} proposed", user["email"], c.unit_type)
        db.commit()
        return c.facility_id
    fid = await asyncio.to_thread(_run)
    return await _after(db, fid, user)


# ── Queued pushes (the effective date came) ──────────────────────────────────

def run_due(db: Session, today: Optional[date] = None) -> int:
    """Push every approved rate change whose effective date has come. Only
    with the switch on and a key - otherwise nothing is sent. Blocking."""
    if not ops_cubby_push.status(db)["pushReady"]:
        return 0
    day = (today or datetime.now(timezone.utc).date()).isoformat()
    due = (db.query(models.OpsCmaChange)
           .filter(models.OpsCmaChange.kind == "rate", models.OpsCmaChange.status == "approved",
                   models.OpsCmaChange.send_mode == "effective", models.OpsCmaChange.effective_date <= day)
           .with_for_update().all())
    for c in due:
        _push(db, c, c.approved_by or "nexus")
        db.commit()
    return len(due)


async def cma_push_loop():
    """Hourly: queued CMA rate changes whose effective date came (Push to
    Cubby on only). The scan and the pushes run in a thread."""
    from database import SessionLocal

    def _tick():
        if job_switch.off("cma_push"):   # Workflows > Automations switch
            return
        db = SessionLocal()
        try:
            n = run_due(db)
            if n:
                print(f"[ops-cma] pushed {n} queued rate change(s)")
        finally:
            db.close()
    while True:
        try:
            await asyncio.to_thread(_tick)
        except Exception as e:  # noqa: BLE001 - the loop must survive one bad tick
            print(f"[ops-cma] queued push tick failed: {type(e).__name__}")
        await asyncio.sleep(3600)
