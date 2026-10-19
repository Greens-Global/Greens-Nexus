"""Operations -> Rate Management (Oct 20 2026): the CMA screen's own records.

  GET  /facility-ops/rates            the table, the cards, the drafts
  PUT  /facility-ops/rates/draft      propose (or clear) a unit type's new rate
  POST /facility-ops/rates/push       Review & Push: send drafts to Cubby, one by one
  GET  /facility-ops/rates/history    our pushed rates + competitors' rates for one unit type

Same door as the rest of Operations to look. Proposing a rate takes a manager
or an Operations editor grant; pushing to Cubby takes a manager (level 3) or
above - never automatic, never a grant alone. Every push is audited in
`ops_rate_pushes`. Market math: routers.facility_ops._market -> ops_market.
"""
import asyncio
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import auth
import cubby
import models
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
    Cubby cannot be read; it just cannot push."""
    try:
        groups, fac = await asyncio.to_thread(ops_rate_mgmt.pricing_groups, facility_id, fresh)
        return groups, fac, ""
    except cubby.CubbyError as e:
        print(f"[ops-rates] pricing groups unavailable: {e.status}")
        return [], {}, e.message


def _view(db: Session, facility: dict, groups: list, fac: dict, groups_error: str, user: dict) -> dict:
    fid = facility["id"]
    idx = ops_rate_mgmt.group_index(groups)
    types = ops_rate_mgmt.priced_types(facility["unitTypes"], idx)
    market = facility_ops._market(db, {**facility, "unitTypes": types})
    drafts = {d.unit_type: _draft_dict(d) for d in
              db.query(models.OpsRateDraft).filter(models.OpsRateDraft.facility_id == fid).all()}
    rows = ops_rate_mgmt.build_rows(types, market["rows"], idx, drafts)
    comps = market["competitors"]
    closed = (db.query(models.OpsCompetitor)
              .filter(models.OpsCompetitor.facility_id == fid, models.OpsCompetitor.active == False).count())  # noqa: E712

    def kind(c):
        if c["ratesUrl"] and c["watch"] and c["lastStatus"] == "ok":
            return "web"
        if any(r.get("source") == "stortrack" for r in c["rates"]):
            return "stortrack"
        return "manual"
    kinds = [kind(c) for c in comps]
    pushes = (db.query(models.OpsRatePush).filter(models.OpsRatePush.facility_id == fid)
              .order_by(models.OpsRatePush.pushed_at.desc()).limit(25).all())
    survey = max((r["newestObservation"] for r in rows if r["newestObservation"]), default="")
    return {
        "facilityId": fid, "facility": facility["shortName"], "name": facility["name"], "asOf": facility["asOf"],
        "address": ops_rate_mgmt.address_of(fac), "billingCycle": (fac or {}).get("billingCycle") or "",
        "lastSurvey": survey,
        "cubbyGroups": {"ok": not groups_error, "count": len(groups), "error": groups_error},
        "compSet": {"active": len(comps), "web": kinds.count("web"), "stortrack": kinds.count("stortrack"),
                    "manual": kinds.count("manual"), "closed": closed},
        "kpis": ops_rate_mgmt.kpis(rows),
        "attention": ops_rate_mgmt.attention(rows, groups_error),
        "rows": rows,
        "competitors": [{"id": c["id"], "name": c["name"], "ratesUrl": c["ratesUrl"], "watch": c["watch"]} for c in comps],
        "freshDays": market["freshDays"], "minCompetitors": market["minCompetitors"],
        "pushes": [_push_dict(p) for p in pushes],
        "canEdit": _can_edit(user, db), "canPush": user.get("level", 0) >= 3, "pushConnected": ops_rate_mgmt.write_configured(),
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


class PushBody(BaseModel):
    facility_id: str
    unit_types: list[str] = Field(min_length=1, max_length=200)
    confirm: bool = False


@router.post("/push")
async def push(body: PushBody, user: dict = Depends(require_manager), db: Session = Depends(get_db)):
    """Send the chosen drafts to Cubby, one pricing group per call, and record
    each result. A failed row keeps its draft so it can be tried again."""
    if not body.confirm:
        raise HTTPException(status_code=422, detail="Confirm the push in the review first")
    if not cubby.configured() or not ops_rate_mgmt.write_configured():
        raise HTTPException(status_code=503, detail="Pushing rates needs a Manager-role Cubby key (CUBBY_MANAGER_API_KEY) on this server - use Export Checklist meanwhile")
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
                    ops_rate_mgmt.change_rate(rec.pricing_group_id, p["newSet"], p["newSell"])
                    rec.status, rec.detail = "ok", "Updated in Cubby"
                    db.delete(d)
                except cubby.CubbyError as e:
                    rec.status, rec.detail = "failed", (e.message or "Cubby refused the change")[:500]
        db.add(rec)
        db.commit()
        return _push_dict(rec)

    def _run():
        results = [_one(n) for n in dict.fromkeys(body.unit_types)]
        return results

    results = await asyncio.to_thread(_run)
    ops_rate_mgmt.forget(body.facility_id)
    groups, fac, err = await _groups(body.facility_id, fresh=True)
    view = await asyncio.to_thread(_view, db, facility, groups, fac, err, user)
    print(f"[ops-rates] push {batch}: {sum(r['status'] == 'ok' for r in results)} ok, "
          f"{sum(r['status'] == 'failed' for r in results)} failed")
    return {"batchId": batch, "results": results, "view": view}


@router.get("/history")
async def history(facility_id: str, unit_type: str, db: Session = Depends(get_db)):
    """Our rate changes for one unit type (the push log) and every competitor
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
