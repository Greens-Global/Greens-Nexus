"""Operations -> Rate Management (Oct 20 2026): the CMA screen's own records.

  GET  /facility-ops/rates            the table, the cards, the drafts
  PUT  /facility-ops/rates/draft      propose (or clear) a unit type's new rate
  POST /facility-ops/rates/entered    Mark Entered in Cubby: record rates staff typed into Cubby by hand
  POST /facility-ops/rates/push       Push to Cubby - ONLY when the Operations switch is on (ops_cubby_push.py)
  GET  /facility-ops/rates/history    our recorded rate changes + competitors' rates for one unit type
  GET  /facility-ops/rates/comps      one unit type, competitor by competitor (the rates the market figures use)

Pushing is locked behind ONE switch (Visesh, Oct 21 2026: "keep the feature of
pushing but keep it locked"): Settings > Global Settings > Operations > Push to
Cubby, OFF by default. While it is off the push route refuses (403) and no
Cubby write is ever made: staff enter the new rates in Cubby themselves, from
the review or the printable checklist, then mark them entered here, which
records who and when in `ops_rate_pushes` (status "entered" - the table keeps
its old name), clears the draft, and is the rate history.

Same door as the rest of Operations to look. Proposing a rate and marking it
entered take a manager or an Operations editor grant; pushing takes a manager
(level 3) or above with the switch on. Market math:
routers.facility_ops._market -> ops_market.
"""
import asyncio
import uuid
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import auth
import cubby
import models
import ops_cma
import ops_cubby_push
import ops_market
import ops_rate_mgmt
from auth import get_current_user, require_level_or_module, require_manager
from database import get_db
from routers import facility_ops

router = APIRouter(
    prefix="/facility-ops/rates",
    tags=["Operations"],
    dependencies=[Depends(require_level_or_module(2, "operations", "viewer"))],
)

require_editor = require_level_or_module(3, "operations", "editor")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _can_edit(user: dict, db: Session) -> bool:
    if user.get("level", 0) >= 3:
        return True
    try:
        return auth._module_level(user["email"], "operations", db) >= auth._MODULE_LEVEL_RANK["editor"]
    except Exception:  # noqa: BLE001 - a flag on the screen must not 500 it
        return False


def _draft_dict(d: models.OpsRateDraft) -> dict:
    return {"proposed": d.proposed_cents, "proposedSet": d.proposed_set_cents, "note": d.note or "",
            "updatedBy": d.updated_by or "", "updatedAt": d.updated_at or ""}


def _push_dict(p: models.OpsRatePush) -> dict:
    return {"id": p.id, "batchId": p.batch_id, "unitType": p.unit_type, "oldSet": p.old_set_cents,
            "oldSell": p.old_sell_cents, "newSet": p.new_set_cents, "newSell": p.new_sell_cents,
            "vacant": p.vacant, "monthlyDelta": p.monthly_delta_cents, "status": p.status,
            "detail": p.detail or "", "pushedBy": p.pushed_by or "", "pushedAt": p.pushed_at or ""}


async def _groups(facility_id: str, fresh: bool = False) -> tuple[list, dict, str]:
    """(pricing groups, facility details, error). The screen still opens when
    Cubby cannot be read; Sell and Set then fall back to the rent roll."""
    try:
        groups, fac = await asyncio.to_thread(ops_rate_mgmt.pricing_groups, facility_id, fresh)
        return groups, fac, ""
    except cubby.CubbyError as e:
        print(f"[ops-rates] pricing groups unavailable: {e.status}")
        return [], {}, e.message


def _latest_surveys(db: Session, fid: str) -> dict[str, models.OpsCmaSurvey]:
    """{competitor id: its newest manual survey} - the special, admin fee and
    insurance staff last heard."""
    out: dict[str, models.OpsCmaSurvey] = {}
    for sv in (db.query(models.OpsCmaSurvey).filter(models.OpsCmaSurvey.facility_id == fid)
               .order_by(models.OpsCmaSurvey.survey_date, models.OpsCmaSurvey.created_at).all()):
        out[sv.competitor_id] = sv
    return out


def _obs_dict(r: models.OpsCompetitorRate) -> dict:
    return {"competitor_id": r.competitor_id, "width": r.width, "depth": r.depth, "parking": bool(r.parking),
            "rate_cents": r.rate_cents, "observed_on": r.observed_on, "created_at": r.created_at,
            "climate": r.climate, "source": r.source or "manual", "online_cents": r.online_cents,
            "promo_cents": r.promo_cents, "promo": r.promo or "", "space_type": r.space_type or "",
            "matched_unit_type": r.matched_unit_type or "", "locked_until": r.locked_until or "",
            "size_note": r.size_note or ""}


def _observations(db: Session, fid: str, origin: tuple | None = None) -> tuple[list[dict], dict[str, dict]]:
    """(every competitor rate observation for the facility with the detail the
    comparison list shows, {ACTIVE competitor id: name, distance, price
    source and the newest survey's special / admin fee / insurance}). Closed
    and removed competitors are not in it, so they count nowhere.
    `origin` is our facility's (lat, lng): a competitor with no recorded
    distance gets the straight-line one; None = not known."""
    surveys = _latest_surveys(db, fid)
    comps = {}
    for c in (db.query(models.OpsCompetitor)
              .filter(models.OpsCompetitor.facility_id == fid, models.OpsCompetitor.active == True).all()):  # noqa: E712
        sv = surveys.get(c.id)
        comps[c.id] = {"name": c.name, "distanceMiles": ops_rate_mgmt.distance_miles(c.distance_miles, origin, c.lat, c.lng),
                       "priceSource": c.price_source or "", "special": (sv.special if sv else "") or "",
                       "adminFee": sv.admin_fee_cents if sv else None, "insurance": (sv.insurance if sv else "") or "",
                       "surveyDate": (sv.survey_date if sv else "") or ""}
    obs = [_obs_dict(r) for r in db.query(models.OpsCompetitorRate).filter(models.OpsCompetitorRate.facility_id == fid).all()]
    return obs, comps


def _raw_rows(fid: str) -> tuple[list, list]:
    """(rent roll, leases) for one facility from the synced Cubby copy, for
    days vacant. Blocking. Empty when the copy cannot be read."""
    try:
        for fac, raw in cubby._rows():
            if fac.get("facilityId") == fid:
                return raw.get("rent_roll") or [], raw.get("leases") or []
    except Exception as e:  # noqa: BLE001 - days vacant is a nice-to-have column, never a 500
        print(f"[ops-rates] rent roll unavailable for days vacant: {type(e).__name__}")
    return [], []


def _snapshot(db: Session, fid: str, day: str, rows: list[dict]) -> None:
    """Today's CMA figures per unit type, written once a day by the first view
    (Rate History's trend lines). Never fails the screen."""
    try:
        have = {s.unit_type for s in db.query(models.OpsCmaSnapshot.unit_type)
                .filter(models.OpsCmaSnapshot.facility_id == fid, models.OpsCmaSnapshot.day == day).all()}
        added = 0
        for r in rows:
            if r["name"] in have or not r["total"]:
                continue
            db.add(models.OpsCmaSnapshot(
                id=f"{fid}:{day}:{r['name']}"[:250], facility_id=fid, day=day, unit_type=r["name"],
                sell_cents=r["sell"], standard_cents=r["set"], avg_rent_cents=r["avgRent"], total=r["total"],
                occupied=r["rented"], market_low_cents=r["marketLow"], market_high_cents=r["marketHigh"],
                market_avg_cents=r["marketAvg"], comps=r["competitors"]))
            added += 1
        if added:
            db.commit()
    except Exception as e:  # noqa: BLE001 - a second viewer racing the same insert, or a read-only replica
        db.rollback()
        print(f"[ops-rates] snapshot skipped: {type(e).__name__}")


def _view(db: Session, facility: dict, groups: list, fac: dict, groups_error: str, user: dict) -> dict:
    fid = facility["id"]
    idx = ops_rate_mgmt.group_index(groups)
    types = ops_rate_mgmt.priced_types(facility["unitTypes"], idx)
    market = facility_ops._market(db, {**facility, "unitTypes": types})
    drafts = {d.unit_type: _draft_dict(d) for d in
              db.query(models.OpsRateDraft).filter(models.OpsRateDraft.facility_id == fid).all()}
    obs, active = _observations(db, fid, (facility.get("lat"), facility.get("lng")))
    today = date.fromisoformat(facility["asOf"])
    cma = {t["name"]: ops_cma.pick_comps(t, obs, active, today) for t in types}
    rent_roll, leases = _raw_rows(fid)
    rows = ops_rate_mgmt.build_rows(types, market["rows"], idx, drafts, cma, ops_cma.days_vacant(rent_roll, leases, today))
    comps = market["competitors"]
    closed = (db.query(models.OpsCompetitor)
              .filter(models.OpsCompetitor.facility_id == fid, models.OpsCompetitor.closed == True).count())  # noqa: E712

    def kind(c):
        if (active.get(c["id"]) or {}).get("priceSource") == "manual":
            return "manual"
        if c["ratesUrl"] and c["watch"] and c["lastStatus"] == "ok":
            return "web"
        if any(r.get("source") == "stortrack" for r in c["rates"]):
            return "stortrack"
        return "manual"
    kinds = [kind(c) for c in comps]
    pushes = (db.query(models.OpsRatePush).filter(models.OpsRatePush.facility_id == fid)
              .order_by(models.OpsRatePush.pushed_at.desc()).limit(25).all())
    survey = max((r["newestObservation"] for r in rows if r["newestObservation"]), default="")
    surveys = _latest_surveys(db, fid)
    last_survey = max(surveys.values(), key=lambda x: (x.survey_date or "", x.created_at or ""), default=None)
    by_type = {t["name"]: t for t in types}
    comps_by_name = {r["name"]: ops_rate_mgmt.size_comps(by_type.get(r["name"]) or {}, obs, active, today) for r in rows}
    for r in rows:
        r["staleComps"] = sum(1 for c in comps_by_name[r["name"]] if c["stale"])
        r["comps"] = cma[r["name"]]["comps"]

    def last_seen(c):
        return max((x.get("observedOn") or "" for x in c["rates"]), default="")
    competitors = [{"id": c["id"], "name": c["name"], "ratesUrl": c["ratesUrl"], "watch": c["watch"],
                    "address": c["address"], "distanceMiles": (active.get(c["id"]) or {}).get("distanceMiles"),
                    "source": k, "lastUpdated": last_seen(c),
                    "sizes": sum(1 for x in cma.values() if any(y["competitorId"] == c["id"] for y in x["comps"]))}
                   for c, k in zip(comps, kinds)]
    competitors.sort(key=lambda c: (c["distanceMiles"] is None, c["distanceMiles"] or 0, c["name"]))
    _snapshot(db, fid, facility["asOf"], rows)
    open_changes = (db.query(models.OpsCmaChange)
                    .filter(models.OpsCmaChange.facility_id == fid, models.OpsCmaChange.status == "proposed").count())
    return {
        "facilityId": fid, "facility": facility["shortName"], "name": facility["name"], "asOf": facility["asOf"],
        "address": ops_rate_mgmt.address_of(fac), "billingCycle": (fac or {}).get("billingCycle") or "",
        "lastSurvey": (last_survey.survey_date if last_survey else "") or survey,
        "lastSurveyBy": (last_survey.surveyed_by if last_survey else "") or "",
        "cubbyGroups": {"ok": not groups_error, "count": len(groups), "error": groups_error},
        "compSet": {"active": len(comps), "web": kinds.count("web"), "stortrack": kinds.count("stortrack"),
                    "manual": kinds.count("manual"), "closed": closed},
        "kpis": ops_rate_mgmt.kpis(rows),
        "attention": ops_rate_mgmt.attention(rows, groups_error),
        "headline": ops_rate_mgmt.headline(rows),
        "gaps": ops_rate_mgmt.gaps(rows, comps_by_name, not groups_error, competitors),
        "staleDays": ops_rate_mgmt.STALE_DAYS,
        "rows": rows,
        "competitors": competitors,
        "freshDays": market["freshDays"], "minCompetitors": ops_cma.MIN_COMPS,
        "pushes": [_push_dict(p) for p in pushes],
        "proposedPromos": open_changes,
        "canEdit": _can_edit(user, db), "canMark": _can_edit(user, db),
        # Push to Cubby (Oct 21 2026): only with the Operations switch on.
        **ops_cubby_push.status(db), "canPush": user.get("level", 0) >= 3,
    }


@router.get("")
async def rates(facility_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    facility = await facility_ops._facility(facility_id)
    groups, fac, err = await _groups(facility_id)
    return await asyncio.to_thread(_view, db, facility, groups, fac, err, user)


class DraftBody(BaseModel):
    facility_id: str
    unit_type: str = Field(min_length=1, max_length=200)
    proposed: Optional[float] = Field(default=None, gt=0, le=100000)      # dollars; None clears the draft
    proposed_set: Optional[float] = Field(default=None, gt=0, le=100000)  # dollars; None = moves with the sell rate
    note: Optional[str] = Field(default="", max_length=500)


@router.put("/draft")
async def save_draft(body: DraftBody, user: dict = Depends(require_editor), db: Session = Depends(get_db)):
    facility = await facility_ops._facility(body.facility_id)
    if not any(t["name"] == body.unit_type for t in facility["unitTypes"]):
        raise HTTPException(status_code=404, detail="That unit type is not at this facility")
    groups, fac, err = await _groups(body.facility_id)
    gid = ((ops_rate_mgmt.group_index(groups).get(body.unit_type)) or {}).get("pricingGroupId") or ""

    def _save():
        d = (db.query(models.OpsRateDraft)
             .filter(models.OpsRateDraft.facility_id == body.facility_id, models.OpsRateDraft.unit_type == body.unit_type)
             .with_for_update().first())
        if body.proposed is None:
            if d:
                db.delete(d)
        else:
            if not d:
                d = models.OpsRateDraft(id=str(uuid.uuid4()), facility_id=body.facility_id, unit_type=body.unit_type,
                                        created_at=_now())
                db.add(d)
            d.pricing_group_id = gid
            d.proposed_cents = int(round(body.proposed * 100))
            d.proposed_set_cents = int(round(body.proposed_set * 100)) if body.proposed_set is not None else None
            d.note = (body.note or "").strip()
            d.updated_by = user.get("email") or ""
            d.updated_at = _now()
        db.commit()
        return _view(db, facility, groups, fac, err, user)
    return await asyncio.to_thread(_save)


ENTERED_DETAIL = "Entered in Cubby by hand"


class SeenRates(BaseModel):
    set: Optional[int] = Field(default=None, ge=0, le=10_000_000)    # cents, as the review showed them
    sell: Optional[int] = Field(default=None, ge=0, le=10_000_000)


class EnteredBody(BaseModel):
    facility_id: str
    unit_types: list[str] = Field(min_length=1, max_length=200)
    # What the review showed as today's rates, per unit type. Once staff have
    # typed the new rate into Cubby, a fresh read already shows it, so the
    # "from" side of the record comes from what the person reviewed.
    seen: dict[str, SeenRates] = Field(default_factory=dict)


@router.post("/entered")
async def mark_entered(body: EnteredBody, user: dict = Depends(require_editor), db: Session = Depends(get_db)):
    """Staff entered these drafts in Cubby by hand. Records each one (who,
    when, old -> new) in `ops_rate_pushes` with status "entered" and clears
    its draft. Never calls Cubby to change anything."""
    facility = await facility_ops._facility(body.facility_id)
    groups, fac, err = await _groups(body.facility_id)
    idx = ops_rate_mgmt.group_index(groups)
    types = {t["name"]: t for t in facility["unitTypes"]}
    batch = str(uuid.uuid4())
    email = user.get("email") or ""

    def _one(name: str) -> dict:
        d = (db.query(models.OpsRateDraft)
             .filter(models.OpsRateDraft.facility_id == body.facility_id, models.OpsRateDraft.unit_type == name)
             .with_for_update().first())
        g = idx.get(name) or {}
        t = types.get(name) or {}
        rec = models.OpsRatePush(id=str(uuid.uuid4()), batch_id=batch, facility_id=body.facility_id, unit_type=name,
                                 vacant=t.get("vacant") or 0, pushed_by=email, pushed_at=_now())
        if not d:
            rec.status, rec.detail = "skipped", "No proposed rate (someone may have marked or cleared it)"
        else:
            seen = body.seen.get(name)
            old_set = seen.set if seen and seen.set is not None else g.get("standardRate")
            if seen and seen.sell is not None:
                old_sell = seen.sell
            else:
                old_sell = ops_rate_mgmt.sell_of(g) if g else t.get("street")
            p = ops_rate_mgmt.plan(old_set, old_sell or 0, d.proposed_cents, d.proposed_set_cents)
            rec.pricing_group_id = d.pricing_group_id or g.get("pricingGroupId") or ""
            rec.old_set_cents, rec.old_sell_cents = old_set, old_sell
            rec.new_set_cents, rec.new_sell_cents = p["newSet"], p["newSell"]
            rec.monthly_delta_cents = (p["newSell"] - old_sell) * rec.vacant if old_sell is not None else 0
            rec.status, rec.detail = "entered", ENTERED_DETAIL
            db.delete(d)
        db.add(rec)
        db.commit()
        return _push_dict(rec)

    results = await asyncio.to_thread(lambda: [_one(n) for n in dict.fromkeys(body.unit_types)])
    ops_rate_mgmt.forget(body.facility_id)
    groups, fac, err = await _groups(body.facility_id, fresh=True)
    view = await asyncio.to_thread(_view, db, facility, groups, fac, err, user)
    print(f"[ops-rates] entered {batch}: {sum(r['status'] == 'entered' for r in results)} marked entered in Cubby")
    return {"batchId": batch, "results": results, "view": view}


class PushBody(BaseModel):
    facility_id: str
    unit_types: list[str] = Field(min_length=1, max_length=200)
    confirm: bool = False


@router.post("/push")
async def push(body: PushBody, user: dict = Depends(require_manager), db: Session = Depends(get_db)):
    """Send the chosen drafts to Cubby, one pricing group per call, and record
    each result. Refused (403) while the Operations switch is off - nothing is
    sent. A failed row keeps its draft so it can be tried again."""
    await asyncio.to_thread(ops_cubby_push.require_push, db)
    if not body.confirm:
        raise HTTPException(status_code=422, detail="Confirm the push in the review first")
    facility = await facility_ops._facility(body.facility_id)
    groups, fac, err = await _groups(body.facility_id, fresh=True)   # never push against a stale read
    if err:
        raise HTTPException(status_code=424, detail=f"Cubby's pricing groups could not be read: {err}")
    idx = ops_rate_mgmt.group_index(groups)
    types = {t["name"]: t for t in facility["unitTypes"]}
    batch = str(uuid.uuid4())
    email = user.get("email") or ""

    def _one(name: str) -> dict:
        d = (db.query(models.OpsRateDraft)
             .filter(models.OpsRateDraft.facility_id == body.facility_id, models.OpsRateDraft.unit_type == name)
             .with_for_update().first())
        g = idx.get(name)
        t = types.get(name) or {}
        rec = models.OpsRatePush(id=str(uuid.uuid4()), batch_id=batch, facility_id=body.facility_id, unit_type=name,
                                 vacant=t.get("vacant") or 0, pushed_by=email, pushed_at=_now())
        if not d:
            rec.status, rec.detail = "skipped", "No proposed rate (someone may have pushed or cleared it)"
        elif not g:
            rec.status = "skipped"
            rec.detail = ("Two Cubby pricing groups share this name" if name in idx
                          else "No Cubby pricing group with this name")
        else:
            old_sell = ops_rate_mgmt.sell_of(g) or 0
            p = ops_rate_mgmt.plan(g.get("standardRate"), old_sell, d.proposed_cents, d.proposed_set_cents)
            rec.pricing_group_id = g.get("pricingGroupId") or ""
            rec.old_set_cents, rec.old_sell_cents = g.get("standardRate"), old_sell
            rec.new_set_cents, rec.new_sell_cents = p["newSet"], p["newSell"]
            rec.monthly_delta_cents = (p["newSell"] - old_sell) * rec.vacant
            if p["newSell"] == old_sell and p["newSet"] == g.get("standardRate"):
                rec.status, rec.detail = "skipped", "Already at this rate in Cubby"
                db.delete(d)
            elif p["newSet"] <= 0:
                rec.status, rec.detail = "failed", "The Set rate would be $0 or less; enter a Set rate"
            else:
                try:
                    ops_cubby_push.change_rate(db, rec.pricing_group_id, p["newSet"], p["newSell"])
                    rec.status, rec.detail = "ok", "Updated in Cubby"
                    db.delete(d)
                except ops_cubby_push.PushOff as e:      # switched off mid-batch: stop, nothing sent
                    rec.status, rec.detail = "skipped", str(e)[:500]
                except cubby.CubbyError as e:
                    rec.status, rec.detail = "failed", (e.message or "Cubby refused the change")[:500]
        db.add(rec)
        db.commit()
        return _push_dict(rec)

    results = await asyncio.to_thread(lambda: [_one(n) for n in dict.fromkeys(body.unit_types)])
    ops_rate_mgmt.forget(body.facility_id)
    groups, fac, err = await _groups(body.facility_id, fresh=True)
    view = await asyncio.to_thread(_view, db, facility, groups, fac, err, user)
    print(f"[ops-rates] push {batch}: {sum(r['status'] == 'ok' for r in results)} ok, "
          f"{sum(r['status'] == 'failed' for r in results)} failed")
    return {"batchId": batch, "results": results, "view": view}


@router.get("/history")
async def history(facility_id: str, unit_type: str, db: Session = Depends(get_db)):
    """Our rate changes for one unit type (the entered log) and every competitor
    observation for its size, newest first."""
    facility = await facility_ops._facility(facility_id)
    t = next((x for x in facility["unitTypes"] if x["name"] == unit_type), None)
    if not t:
        raise HTTPException(status_code=404, detail="That unit type is not at this facility")

    def _read():
        ours = (db.query(models.OpsRatePush)
                .filter(models.OpsRatePush.facility_id == facility_id, models.OpsRatePush.unit_type == unit_type)
                .order_by(models.OpsRatePush.pushed_at.desc()).limit(200).all())
        comps = {c.id: c.name for c in db.query(models.OpsCompetitor).filter(models.OpsCompetitor.facility_id == facility_id).all()}
        key = ops_market.size_key(t.get("width"), t.get("depth"), bool(t.get("parking")))
        theirs = []
        if t.get("width") and t.get("depth"):
            for r in (db.query(models.OpsCompetitorRate).filter(models.OpsCompetitorRate.facility_id == facility_id)
                      .order_by(models.OpsCompetitorRate.observed_on.desc()).limit(2000).all()):
                if ops_market.size_key(r.width, r.depth, bool(r.parking)) == key:
                    theirs.append({"competitor": comps.get(r.competitor_id, ""), "competitorId": r.competitor_id,
                                   "rate": r.rate_cents, "observedOn": r.observed_on, "source": r.source or "manual",
                                   "promo": r.promo or ""})
        return {"unitType": unit_type, "ours": [_push_dict(p) for p in ours], "competitors": theirs[:300]}
    return await asyncio.to_thread(_read)


@router.get("/comps")
async def comps(facility_id: str, unit_type: str, db: Session = Depends(get_db)):
    """One unit type, competitor by competitor: each active competitor's newest
    rate for the size inside the market window (the same rates the low /
    median / high come from), cheapest first, with distance, online price,
    promotion, date and source."""
    facility = await facility_ops._facility(facility_id)
    t = next((x for x in facility["unitTypes"] if x["name"] == unit_type), None)
    if not t:
        raise HTTPException(status_code=404, detail="That unit type is not at this facility")

    def _read():
        obs, active = _observations(db, facility_id, (facility.get("lat"), facility.get("lng")))
        today = date.fromisoformat(facility["asOf"])
        rows = ops_rate_mgmt.size_comps(t, obs, active, today)
        return {"unitType": unit_type, "asOf": facility["asOf"], "freshDays": ops_market.FRESH_DAYS,
                "staleDays": ops_rate_mgmt.STALE_DAYS,
                "sizeKey": ops_market.size_key(t.get("width"), t.get("depth"), bool(t.get("parking")))
                if t.get("width") and t.get("depth") else "",
                "competitors": rows}
    return await asyncio.to_thread(_read)
