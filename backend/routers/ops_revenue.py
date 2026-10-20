"""Operations > Revenue Management (Neil, Oct 20 2026): rent changes for
existing tenants. The calculation lives in `ops_revenue.py`; this is the door.

Managers and above, or an Operations grant at Full - tighter than the rest of
Operations (supervisors read the figures; only managers change rents).
Nexus never writes to Cubby (Visesh, Oct 20 2026): staff enter each new rent
in Cubby by hand and mark the row Entered in Cubby here - the only way a row
reaches Cubby. There is no push route and there must never be one again.
Nothing here emails a tenant (CLAUDE.md) and nothing runs on a timer.
"""
import asyncio
import uuid
from datetime import date
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import cubby
import models
import ops_revenue as rev
from auth import get_current_user, require_level_or_module
from database import get_db

router = APIRouter(
    prefix="/facility-ops/revenue",
    tags=["Operations"],
    dependencies=[Depends(require_level_or_module(3, "operations", "full"))],
)

# ── Facility rows ─────────────────────────────────────────────────────────────

def _facility_rows(facility_id: str):
    """(facility, raw rows) for one facility, from the synced Cubby tables. Blocking."""
    for fac, raw in cubby._rows():
        if fac["facilityId"] == facility_id:
            return fac, raw
    return None, None


def _history(db: Session, facility_id: str, today: date):
    """What Nexus already did per lease: the last change it applied (for
    tenants Cubby has no lastRentChangeDate for), and open batches."""
    last: dict[str, str] = {}
    pending: dict[str, dict] = {}
    q = (db.query(models.OpsRevenueChange, models.OpsRevenueBatch)
         .join(models.OpsRevenueBatch, models.OpsRevenueBatch.id == models.OpsRevenueChange.batch_id)
         .filter(models.OpsRevenueChange.facility_id == facility_id, models.OpsRevenueChange.status != "removed",
                 models.OpsRevenueBatch.status != "canceled"))
    for c, b in q.all():
        if not c.lease_id:
            continue
        eff = c.cubby_change_date or b.effective_date or ""
        upcoming = b.status in rev.OPEN_BATCH or (b.status == "applied" and eff > today.isoformat())
        if upcoming:
            pending[c.lease_id] = {"batchId": b.id, "status": b.status, "effective": eff}
        elif c.status in rev.IN_CUBBY and eff > last.get(c.lease_id, ""):
            last[c.lease_id] = eff
    return last, pending


async def _tenants(db: Session, facility_id: str):
    try:
        fac, raw = await asyncio.to_thread(_facility_rows, facility_id)
    except cubby.CubbyError as e:
        raise HTTPException(status_code=424, detail=f"Cubby did not answer: {e.message}") from e
    if not fac:
        raise HTTPException(status_code=404, detail="Facility not found")

    def _build():
        last, pending = _history(db, facility_id, raw["today"])
        return rev.tenant_rows(raw, last, pending)
    rows = await asyncio.to_thread(_build)
    return fac, raw["today"], rows


@router.get("/tenants")
async def tenants(facility_id: str, db: Session = Depends(get_db)):
    fac, today, rows = await _tenants(db, facility_id)
    return {
        "facilityId": facility_id, "facility": cubby._short(fac), "asOf": today.isoformat(),
        "tenants": rows, "unitTypes": sorted({t["unitType"] for t in rows}),
        "defaults": rev.DEFAULT_STRATEGY,
    }


# ── Strategies ────────────────────────────────────────────────────────────────

class StrategyBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    method: Literal["percent", "amount"] = "percent"
    increase_pct: float = Field(default=0, ge=0, le=100)
    increase_cents: int = Field(default=0, ge=0, le=1_000_000)
    cap_mode: Literal["street", "street_plus", "none"] = "street"
    cap_pct: float = Field(default=0, ge=0, le=100)
    round_dollar: bool = True
    min_months_in: int = Field(default=12, ge=0, le=240)
    min_months_since: int = Field(default=12, ge=0, le=240)
    skip_balance: bool = True
    notice_days: int = Field(default=rev.DEFAULT_NOTICE_DAYS, ge=1, le=rev.MAX_NOTICE_DAYS)


def _check_step(body: StrategyBody):
    if (body.method == "percent" and body.increase_pct <= 0) or (body.method == "amount" and body.increase_cents <= 0):
        raise HTTPException(status_code=422, detail="The increase must be more than zero")


def _apply(m, body: StrategyBody):
    m.name = body.name.strip()
    m.method = body.method
    m.increase_pct = body.increase_pct
    m.increase_cents = body.increase_cents
    m.cap_mode = body.cap_mode
    m.cap_pct = body.cap_pct
    m.round_dollar = body.round_dollar
    m.min_months_in = body.min_months_in
    m.min_months_since = body.min_months_since
    m.skip_balance = body.skip_balance
    m.notice_days = body.notice_days


def _strategy_from_body(body: StrategyBody) -> dict:
    m = models.OpsRevenueStrategy(id="", active=True)
    _apply(m, body)
    return rev.strategy_dict(m)


@router.get("/strategies")
def list_strategies(db: Session = Depends(get_db)):
    rows = (db.query(models.OpsRevenueStrategy).filter(models.OpsRevenueStrategy.active == True)  # noqa: E712
            .order_by(models.OpsRevenueStrategy.name).all())
    return {"strategies": [{**rev.strategy_dict(m), "summary": rev.describe(rev.strategy_dict(m))} for m in rows]}


@router.post("/strategies", status_code=201)
def create_strategy(body: StrategyBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _check_step(body)
    m = models.OpsRevenueStrategy(id=str(uuid.uuid4()), active=True, created_by=user["email"], created_at=rev.now_iso())
    _apply(m, body)
    db.add(m)
    db.commit()
    return rev.strategy_dict(m)


@router.put("/strategies/{sid}")
def update_strategy(sid: str, body: StrategyBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _check_step(body)
    m = db.get(models.OpsRevenueStrategy, sid)
    if not m or not m.active:
        raise HTTPException(status_code=404, detail="Strategy not found")
    _apply(m, body)
    m.updated_by, m.updated_at = user["email"], rev.now_iso()
    db.commit()
    return rev.strategy_dict(m)


@router.delete("/strategies/{sid}")
def archive_strategy(sid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Archived, not deleted: batches built from it keep its name and rule."""
    m = db.get(models.OpsRevenueStrategy, sid)
    if not m or not m.active:
        raise HTTPException(status_code=404, detail="Strategy not found")
    m.active = False
    m.updated_by, m.updated_at = user["email"], rev.now_iso()
    db.commit()
    return {"ok": True}


# ── Preview and batches ───────────────────────────────────────────────────────

class ScopeBody(BaseModel):
    type: Literal["unit_type", "tenants", "tenant"]
    unitType: Optional[str] = Field(default=None, max_length=200)
    keys: List[str] = Field(default_factory=list, max_length=2000)


class PlanBody(BaseModel):
    facility_id: str = Field(min_length=1, max_length=100)
    strategy_id: Optional[str] = None
    strategy: Optional[StrategyBody] = None      # an unsaved rule, to try before saving it
    scope: ScopeBody
    effective_date: str
    note: Optional[str] = Field(default="", max_length=2000)


async def _plan(body: PlanBody, db: Session):
    if body.strategy_id:
        m = await asyncio.to_thread(lambda: db.get(models.OpsRevenueStrategy, body.strategy_id))
        if not m or not m.active:
            raise HTTPException(status_code=404, detail="Strategy not found")
        strategy = rev.strategy_dict(m)
    elif body.strategy:
        _check_step(body.strategy)
        strategy = _strategy_from_body(body.strategy)
    else:
        raise HTTPException(status_code=422, detail="Choose a strategy")
    if body.scope.type == "tenant" and len(body.scope.keys) != 1:
        raise HTTPException(status_code=422, detail="Pick one tenant")
    if body.scope.type == "unit_type" and not (body.scope.unitType or "").strip():
        raise HTTPException(status_code=422, detail="Pick a unit type")
    fac, today, rows = await _tenants(db, body.facility_id)
    effective = rev._d(body.effective_date)
    if effective is None:
        raise HTTPException(status_code=422, detail="The effective date must be a real calendar date")
    first = rev.earliest_effective(today, strategy["noticeDays"])
    if effective < first:
        raise HTTPException(status_code=422, detail=(
            f"This strategy needs {strategy['noticeDays']} days of written notice, so the earliest effective date "
            f"is {rev.us_date(first.isoformat())}."))
    picked = rev.in_scope(rows, body.scope.model_dump())
    if not picked:
        raise HTTPException(status_code=422, detail="No current tenants match that choice")
    out = rev.preview(strategy, picked, effective)
    return fac, today, strategy, picked, effective, out


@router.post("/preview")
async def preview(body: PlanBody, db: Session = Depends(get_db)):
    """The proposed new rents and the revenue impact. Saves nothing."""
    fac, today, strategy, picked, effective, out = await _plan(body, db)
    return {**out, "strategy": {**strategy, "summary": rev.describe(strategy)},
            "effectiveDate": effective.isoformat(),
            "noticeDate": rev.notice_date(effective, strategy["noticeDays"]).isoformat(),
            "scopeLabel": rev.scope_label(body.scope.model_dump(), picked), "asOf": today.isoformat()}


def _audit(db, batch_id, actor, action, change_id="", **detail):
    db.add(models.OpsRevenueAudit(id=str(uuid.uuid4()), batch_id=batch_id, change_id=change_id, actor=actor,
                                  action=action, detail=detail, created_at=rev.now_iso()))


def _batch_out(db: Session, b, full: bool = False) -> dict:
    changes = (db.query(models.OpsRevenueChange).filter(models.OpsRevenueChange.batch_id == b.id)
               .order_by(models.OpsRevenueChange.unit_name).all())
    live = [c for c in changes if c.status != "removed"]
    monthly = sum((c.new_cents or 0) - (c.current_cents or 0) for c in live)
    out = {
        "id": b.id, "facilityId": b.facility_id, "facility": b.facility_name, "strategyName": b.strategy_name,
        "strategy": b.strategy or {}, "scopeType": b.scope_type, "scopeLabel": b.scope_label,
        "effectiveDate": b.effective_date, "noticeDate": b.notice_date, "status": b.status, "note": b.note or "",
        "createdBy": b.created_by, "createdAt": b.created_at, "approvedBy": b.approved_by, "approvedAt": b.approved_at,
        "notifiedBy": b.notified_by, "notifiedAt": b.notified_at, "appliedBy": b.applied_by, "appliedAt": b.applied_at,
        "canceledBy": b.canceled_by, "canceledAt": b.canceled_at,
        "count": len(live), "monthlyIncrease": monthly, "annualIncrease": monthly * 12,
        "inCubby": sum(1 for c in live if c.status in rev.IN_CUBBY),
    }
    if full:
        out["changes"] = [{
            "id": c.id, "leaseId": c.lease_id, "tenant": c.tenant_name, "unit": c.unit_name, "unitType": c.unit_type,
            "moveIn": c.move_in_date, "lastIncrease": c.last_increase_date, "rent": c.current_cents,
            "street": c.street_cents, "newRent": c.new_cents, "increase": (c.new_cents or 0) - (c.current_cents or 0),
            "status": c.status, "cubbyChangeDate": c.cubby_change_date, "cubbyNoticeDate": c.cubby_notice_date,
            "pushedBy": c.pushed_by, "pushedAt": c.pushed_at, "pushDetail": c.push_detail,
            "url": cubby._tenant_url(c.customer_id),
        } for c in changes]
        audit = (db.query(models.OpsRevenueAudit).filter(models.OpsRevenueAudit.batch_id == b.id)
                 .order_by(models.OpsRevenueAudit.created_at.desc()).all())
        out["audit"] = [{"actor": a.actor, "action": a.action, "changeId": a.change_id, "detail": a.detail or {},
                         "at": a.created_at} for a in audit]
    return out


@router.post("/batches", status_code=201)
async def create_batch(body: PlanBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Save the eligible rows of a preview as a Draft batch. The rows are
    recomputed here - the screen's numbers are never trusted."""
    fac, today, strategy, picked, effective, out = await _plan(body, db)
    ok = [r for r in out["rows"] if r["eligible"]]
    if not ok:
        raise HTTPException(status_code=422, detail="Nobody in that choice qualifies under this strategy")

    def _save():
        b = models.OpsRevenueBatch(
            id=str(uuid.uuid4()), facility_id=body.facility_id, facility_name=fac.get("name") or "",
            strategy_id=strategy.get("id") or "", strategy_name=strategy["name"],
            strategy={k: v for k, v in strategy.items() if k not in ("createdBy", "createdAt", "updatedBy", "updatedAt")},
            scope_type=body.scope.type, scope_label=rev.scope_label(body.scope.model_dump(), picked),
            effective_date=effective.isoformat(),
            notice_date=rev.notice_date(effective, strategy["noticeDays"]).isoformat(),
            status="draft", created_by=user["email"], created_at=rev.now_iso(), note=(body.note or "").strip())
        db.add(b)
        for r in ok:
            db.add(models.OpsRevenueChange(
                id=str(uuid.uuid4()), batch_id=b.id, facility_id=body.facility_id, lease_id=r["leaseId"],
                unit_id=r["unitId"], customer_id=r["customerId"], tenant_name=r["tenant"], unit_name=r["unit"],
                unit_type=r["unitType"], move_in_date=r["moveIn"], last_increase_date=r["lastIncrease"],
                current_cents=r["rent"], street_cents=r["street"], new_cents=r["newRent"], status="pending"))
        _audit(db, b.id, user["email"], "created", tenants=len(ok), monthlyIncrease=out["totals"]["monthlyIncrease"])
        db.commit()
        return _batch_out(db, b, full=True)
    return await asyncio.to_thread(_save)


@router.get("/batches")
def list_batches(facility_id: str = "", db: Session = Depends(get_db)):
    q = db.query(models.OpsRevenueBatch)
    if facility_id:
        q = q.filter(models.OpsRevenueBatch.facility_id == facility_id)
    return {"batches": [_batch_out(db, b) for b in q.order_by(models.OpsRevenueBatch.created_at.desc()).limit(200).all()]}


def _get_batch(db: Session, bid: str, lock: bool = False):
    q = db.query(models.OpsRevenueBatch).filter(models.OpsRevenueBatch.id == bid)
    b = (q.with_for_update() if lock else q).first()
    if not b:
        raise HTTPException(status_code=404, detail="Batch not found")
    return b


@router.get("/batches/{bid}")
def get_batch(bid: str, db: Session = Depends(get_db)):
    return _batch_out(db, _get_batch(db, bid), full=True)


class StatusBody(BaseModel):
    status: Literal["approved", "notified", "applied", "canceled"]
    note: Optional[str] = Field(default="", max_length=2000)


@router.post("/batches/{bid}/status")
def set_status(bid: str, body: StatusBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    b = _get_batch(db, bid, lock=True)
    if b.status not in rev.NEXT[body.status]:
        raise HTTPException(status_code=409, detail=f"A {b.status.title()} batch cannot be marked {body.status.title()}")
    live = [c for c in db.query(models.OpsRevenueChange).filter(models.OpsRevenueChange.batch_id == b.id).all()
            if c.status != "removed"]
    if body.status == "approved":
        if not live:
            raise HTTPException(status_code=409, detail="Every tenant was removed from this batch")
        today = cubby._facility_today({"timeZone": cubby.DEFAULT_TZ})
        days = int((b.strategy or {}).get("noticeDays") or rev.DEFAULT_NOTICE_DAYS)
        if rev._d(b.effective_date) < rev.earliest_effective(today, days):
            raise HTTPException(status_code=409, detail=(
                f"The effective date no longer leaves {days} days of notice. Cancel this batch and build a new one "
                f"with a later date."))
    if body.status == "applied":
        missing = [c for c in live if c.status not in rev.IN_CUBBY]
        if missing:
            raise HTTPException(status_code=409, detail=(
                f"{len(missing)} change(s) are not marked Entered in Cubby yet. Enter each one in Cubby, "
                f"then mark it Entered here."))
    stamp = rev.now_iso()
    b.status = body.status
    setattr(b, f"{body.status}_by", user["email"])
    setattr(b, f"{body.status}_at", stamp)
    if body.note:
        b.note = ((b.note or "") + f"\n{body.status.title()}: {body.note.strip()}").strip()
    _audit(db, b.id, user["email"], body.status, note=(body.note or "").strip())
    db.commit()
    return _batch_out(db, b, full=True)


def _get_change(db: Session, b, cid: str, lock: bool = False):
    q = db.query(models.OpsRevenueChange).filter(models.OpsRevenueChange.id == cid,
                                                 models.OpsRevenueChange.batch_id == b.id)
    c = (q.with_for_update() if lock else q).first()
    if not c:
        raise HTTPException(status_code=404, detail="Change not found")
    return c


@router.delete("/batches/{bid}/changes/{cid}")
def remove_change(bid: str, cid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Take one tenant out of a Draft batch."""
    b = _get_batch(db, bid, lock=True)
    if b.status != "draft":
        raise HTTPException(status_code=409, detail="Only a Draft batch can be edited")
    c = _get_change(db, b, cid, lock=True)
    c.status = "removed"
    _audit(db, b.id, user["email"], "removed", change_id=c.id, unit=c.unit_name)
    db.commit()
    return _batch_out(db, b, full=True)


@router.post("/batches/{bid}/changes/{cid}/entered")
def mark_entered(bid: str, cid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Staff entered this change in Cubby by hand (from the checklist). The
    only way a row reaches Cubby - Nexus never writes there itself."""
    b = _get_batch(db, bid, lock=True)
    if b.status not in ("approved", "notified"):
        raise HTTPException(status_code=409, detail="Approve the batch before entering changes in Cubby")
    c = _get_change(db, b, cid, lock=True)
    if c.status in (*rev.IN_CUBBY, "removed"):
        raise HTTPException(status_code=409, detail="This change cannot be marked again")
    c.status, c.pushed_by, c.pushed_at = "entered", user["email"], rev.now_iso()
    _audit(db, b.id, user["email"], "entered", change_id=c.id, unit=c.unit_name, toCents=c.new_cents)
    db.commit()
    return _batch_out(db, b, full=True)


# ── Notices and the export (staff send them; Nexus never emails a tenant) ────

@router.get("/batches/{bid}/export")
def export_batch(bid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Mail-merge rows and the Cubby checklist, as columns and rows."""
    b = _get_batch(db, bid)
    changes = (db.query(models.OpsRevenueChange).filter(models.OpsRevenueChange.batch_id == b.id)
               .order_by(models.OpsRevenueChange.unit_name).all())
    _audit(db, b.id, user["email"], "export")
    db.commit()
    return {"title": "Rent Changes", "facility": b.facility_name, "asOf": b.effective_date,
            "columns": rev.MERGE_COLUMNS, "rows": rev.merge_rows(b, changes)}


@router.get("/batches/{bid}/letters.pdf")
def letters(bid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    b = _get_batch(db, bid)
    if b.status not in ("approved", "notified", "applied"):
        raise HTTPException(status_code=409, detail="Approve the batch before printing notices")
    changes = (db.query(models.OpsRevenueChange).filter(models.OpsRevenueChange.batch_id == b.id)
               .order_by(models.OpsRevenueChange.unit_name).all())
    pdf = rev.letters_pdf(b, changes, cubby._facility_today({"timeZone": cubby.DEFAULT_TZ}))
    _audit(db, b.id, user["email"], "letters")
    db.commit()
    name = f"Rent Change Notices - {cubby._short({'name': b.facility_name})} - {rev.us_date(b.effective_date).replace('/', '-')}.pdf"
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})
