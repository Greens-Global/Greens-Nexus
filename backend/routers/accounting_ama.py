"""Accounting -> Reporting -> AMA, Asset Management Agreements (Priyanka,
Oct 7: "We still need to build AMA"; the old mock was the "AMA Entity Billing
Tracker", removed in 78bf25db).

An AGREEMENT is the fee one entity (the manager, optional) earns for managing
another (the managed ledger entity): a percent of the managed entity's
revenue, or a flat amount per billing period, billed monthly, quarterly or
annually from a start date.

What was BILLED is never keyed: it is the net credits (credit - debit) on the
agreement's fee GL account, Jan 1 through today (or Dec 31 of a past year),
in the manager entity when one is set, else in the managed entity - read
from the ledger through the accounting app's internal API (the same
`accounting._acct_get` proxy every Accounting read uses, each read through
`_limit`). EXPECTED is the fee rate times the managed entity's income (the
P&L's revenue + other income sections) over the part of the year the
agreement was in force, or the flat amount times the billing dates that fell
in that part of the year. A ledger read that fails answers that agreement
with billed / expected null and an `error` - never a 500 for the list.

Access: the Accounting grant (viewer reads, editor writes); a person limited
to certain entities sees and edits only the agreements of those.
"""
import asyncio
import calendar
import re
import uuid
from datetime import date, datetime, timezone
from typing import Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import models
from auth import require_module_grant
from database import SessionLocal
from routers import accounting
from routers.accounting import _limit, entity_scope
from routers.accounting_loans import _sem

router = APIRouter(prefix="/accounting/ama", tags=["Accounting"], dependencies=[Depends(require_module_grant("accounting", "viewer"))])
_edit = require_module_grant("accounting", "editor")

_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
STATUSES = ("Active", "Pending Review", "Ended")
BASES = ("percent_revenue", "flat")
FREQUENCIES = {"Monthly": 1, "Quarterly": 3, "Annually": 12}
_INCOME = ("revenue", "other_income")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _r2(v) -> float:
    return round(float(v or 0) + 0.0, 2)


# ── The arithmetic (pure) ────────────────────────────────────────────────────
def add_months(d: date, months: int, day: Optional[int] = None) -> date:
    """`d` moved by whole months, on `day` (default d's day) clamped to the
    month's last day: Jan 31 + 1 month = Feb 28 (29)."""
    i = d.year * 12 + d.month - 1 + months
    y, m = divmod(i, 12)
    m += 1
    return date(y, m, min(day or d.day, calendar.monthrange(y, m)[1]))


def billing_dates(start: date, frequency: str, upto: date):
    """Every billing date from `start` on (start, start + one period, ...),
    through `upto`. Each one keeps the start's day of the month."""
    step = FREQUENCIES.get(frequency, 1)
    k = 0
    while True:
        b = add_months(start, k * step, start.day)
        if b > upto:
            return
        yield b
        k += 1


def _d(s: str) -> Optional[date]:
    if not s or not _ISO.match(s):
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def in_force(a: dict, year: int, as_of: date) -> Optional[tuple[date, date]]:
    """(from, to): the part of `year` up to `as_of` the agreement was in
    force, or None. An Ended agreement with no end date is in force nowhere -
    when it stopped is unknown, so nothing is expected of it."""
    start = _d(a.get("startDate") or "")
    end = _d(a.get("endDate") or "")
    if not start or (a.get("status") == "Ended" and not end):
        return None
    lo = max(start, date(year, 1, 1))
    hi = min(as_of, date(year, 12, 31), end or as_of)
    return (lo, hi) if lo <= hi else None


def periods_elapsed(a: dict, year: int, as_of: date) -> int:
    """How many billing dates fell in the part of the year it was in force."""
    window = in_force(a, year, as_of)
    if not window:
        return 0
    start = _d(a["startDate"])
    return sum(1 for b in billing_dates(start, a.get("billingFrequency") or "Monthly", window[1]) if b >= window[0])


def next_billing(a: dict, today: date) -> Optional[str]:
    """The first billing date after today (the start itself when it is still
    ahead); None when Ended or past the end date."""
    start = _d(a.get("startDate") or "")
    if not start or a.get("status") == "Ended":
        return None
    end = _d(a.get("endDate") or "")
    if start > today:
        nxt = start
    else:
        step = FREQUENCIES.get(a.get("billingFrequency") or "Monthly", 1)
        # Jump close, then walk: a start decades back stays cheap.
        k = max(0, ((today.year - start.year) * 12 + today.month - start.month) // step - 1)
        nxt = add_months(start, k * step, start.day)
        while nxt <= today:
            k += 1
            nxt = add_months(start, k * step, start.day)
    if end and nxt > end:
        return None
    return nxt.isoformat()


def expected_flat(a: dict, year: int, as_of: date) -> float:
    return _r2(float(a.get("flatAmount") or 0) * periods_elapsed(a, year, as_of))


def expected_percent(a: dict, revenue: float) -> float:
    return _r2(float(a.get("feeRate") or 0) / 100.0 * float(revenue or 0))


def income_of(pnl: dict) -> float:
    """Revenue + other income of one P&L answer."""
    total = 0.0
    for s in pnl.get("sections") or []:
        if s.get("key") in _INCOME:
            total += sum(_r2(x.get("amount")) for x in s.get("accounts") or [])
    return _r2(total)


def billed_of(buckets: dict, gl: str) -> float:
    """Net credits (credit - debit) on one GL account in a buckets answer."""
    return _r2(sum(_r2(r.get("credit")) - _r2(r.get("debit")) for r in buckets.get("rows") or [] if str(r.get("account_no") or "") == gl))


# ── Shapes ───────────────────────────────────────────────────────────────────
def _out(r: models.AccountingAmaAgreement) -> dict:
    return {
        "id": r.id, "entityCode": r.entity_code or "", "managerEntityCode": r.manager_entity_code or "",
        "status": r.status if r.status in STATUSES else "Active", "feeBasis": r.fee_basis if r.fee_basis in BASES else "percent_revenue",
        "feeRate": r.fee_rate, "flatAmount": r.flat_amount,
        "billingFrequency": r.billing_frequency if r.billing_frequency in FREQUENCIES else "Monthly",
        "startDate": r.start_date or "", "endDate": r.end_date or "", "feeGlAccount": r.fee_gl_account or "",
        "agreementUrl": r.agreement_url or "", "notes": r.notes or "",
        "createdBy": r.created_by or "", "createdAt": r.created_at or "", "updatedBy": r.updated_by or "", "updatedAt": r.updated_at or "",
    }


class AgreementBody(BaseModel):
    entityCode: str
    managerEntityCode: Optional[str] = ""
    status: Optional[str] = "Active"
    feeBasis: Optional[str] = "percent_revenue"
    feeRate: Optional[float] = None
    flatAmount: Optional[float] = None
    billingFrequency: Optional[str] = "Monthly"
    startDate: Optional[str] = ""
    endDate: Optional[str] = ""
    feeGlAccount: Optional[str] = ""
    agreementUrl: Optional[str] = ""
    notes: Optional[str] = ""


def _clean(body: AgreementBody) -> dict:
    entity = (body.entityCode or "").strip()
    manager = (body.managerEntityCode or "").strip()
    if not entity:
        raise HTTPException(status_code=400, detail="Pick the managed entity.")
    if manager and manager == entity:
        raise HTTPException(status_code=400, detail="The manager entity cannot be the managed entity.")
    if body.status not in STATUSES:
        raise HTTPException(status_code=400, detail="Status is Active, Pending Review or Ended.")
    if body.feeBasis not in BASES:
        raise HTTPException(status_code=400, detail="The fee is a percent of revenue or a flat amount.")
    if body.billingFrequency not in FREQUENCIES:
        raise HTTPException(status_code=400, detail="Billing is Monthly, Quarterly or Annually.")
    rate = flat = None
    if body.feeBasis == "percent_revenue":
        if body.feeRate is None or not 0 < body.feeRate <= 100:
            raise HTTPException(status_code=400, detail="The fee rate is a percent above 0 and up to 100.")
        rate = float(body.feeRate)
    else:
        if body.flatAmount is None or body.flatAmount <= 0:
            raise HTTPException(status_code=400, detail="The flat fee must be more than zero.")
        flat = float(body.flatAmount)
    if not body.startDate or not _ISO.match(body.startDate) or not _d(body.startDate):
        raise HTTPException(status_code=400, detail="The start date must be a date (YYYY-MM-DD).")
    if body.endDate and (not _ISO.match(body.endDate) or not _d(body.endDate)):
        raise HTTPException(status_code=400, detail="The end date must be a date (YYYY-MM-DD).")
    if body.endDate and body.endDate < body.startDate:
        raise HTTPException(status_code=400, detail="It ends before it starts.")
    url = (body.agreementUrl or "").strip()
    if url:
        p = urlparse(url)
        if p.scheme not in ("http", "https") or not p.netloc:
            raise HTTPException(status_code=400, detail="The agreement link must start with http:// or https://.")
    return {
        "entity_code": entity[:40], "manager_entity_code": manager[:40], "status": body.status, "fee_basis": body.feeBasis,
        "fee_rate": rate, "flat_amount": flat, "billing_frequency": body.billingFrequency,
        "start_date": body.startDate, "end_date": body.endDate or "", "fee_gl_account": (body.feeGlAccount or "").strip()[:40],
        "agreement_url": url[:1000], "notes": (body.notes or "").strip()[:2000],
    }


def _load_all() -> list[dict]:
    db = SessionLocal()
    try:
        rows = db.query(models.AccountingAmaAgreement).order_by(models.AccountingAmaAgreement.entity_code, models.AccountingAmaAgreement.start_date).all()
        return [_out(r) for r in rows]
    finally:
        db.close()


def _one(agreement_id: str) -> dict:
    db = SessionLocal()
    try:
        row = db.query(models.AccountingAmaAgreement).filter(models.AccountingAmaAgreement.id == agreement_id).first()
        if not row:
            raise HTTPException(status_code=404, detail="Agreement not found.")
        return _out(row)
    finally:
        db.close()


def _save(agreement_id: Optional[str], fields: dict, user: dict) -> dict:
    db = SessionLocal()
    try:
        now = _now()
        if agreement_id:
            row = db.query(models.AccountingAmaAgreement).filter(models.AccountingAmaAgreement.id == agreement_id).first()
            if not row:
                raise HTTPException(status_code=404, detail="Agreement not found.")
        else:
            row = models.AccountingAmaAgreement(id=str(uuid.uuid4()), created_by=user["email"], created_at=now)
            db.add(row)
        for k, v in fields.items():
            setattr(row, k, v)
        row.updated_by, row.updated_at = user["email"], now
        db.commit()
        return _out(row)
    finally:
        db.close()


async def _reach(scope: dict) -> Optional[set]:
    """Entity codes the caller may read, or None when they are not limited."""
    if scope["allowed"] is None:
        return None
    return await accounting._with_children(scope["allowed"]) if scope["allowed"] else set()


async def _must_reach(scope: dict, *codes: str) -> None:
    reach = await _reach(scope)
    if reach is None:
        return
    for c in codes:
        if c and c not in reach:
            raise HTTPException(status_code=403, detail="Your accounting access does not include that entity.")


async def _visible(scope: dict) -> list[dict]:
    reach = await _reach(scope)
    return [a for a in await asyncio.to_thread(_load_all) if reach is None or a["entityCode"] in reach]


# ── Ledger reads (every one through _limit) ──────────────────────────────────
async def _billed(scope: dict, entity: str, gl: str, from_: str, to: str) -> float:
    location, _ = await _limit(scope, entity, None)
    async with _sem():
        data = await accounting._acct_get("/api/internal/reports/buckets", {"from": from_, "to": to, "by": "total", "location": location})
    return billed_of(data, gl)


async def _income(scope: dict, entity: str, from_: str, to: str) -> float:
    location, _ = await _limit(scope, entity, None)
    async with _sem():
        data = await accounting._acct_get("/api/internal/reports/pnl", {"from": from_, "to": to, "location": location})
    return income_of(data)


def _why(e: Exception) -> str:
    if isinstance(e, HTTPException):
        return str(e.detail)
    return "The ledger could not be read."


async def summarize(scope: dict, a: dict, year: int, today: date) -> dict:
    as_of = min(today, date(year, 12, 31))
    billing_entity = a["managerEntityCode"] or a["entityCode"]
    out = {**a, "billingEntityCode": billing_entity, "year": year, "asOf": as_of.isoformat(),
           "billedYtd": None, "expectedYtd": None, "difference": None, "revenueYtd": None,
           "periodsElapsed": periods_elapsed(a, year, as_of), "nextBilling": next_billing(a, today), "error": None}
    try:
        if a["feeGlAccount"]:
            out["billedYtd"] = await _billed(scope, billing_entity, a["feeGlAccount"], f"{year}-01-01", as_of.isoformat())
        if a["feeBasis"] == "flat":
            out["expectedYtd"] = expected_flat(a, year, as_of)
        else:
            window = in_force(a, year, as_of)
            revenue = await _income(scope, a["entityCode"], window[0].isoformat(), window[1].isoformat()) if window else 0.0
            out["revenueYtd"] = revenue
            out["expectedYtd"] = expected_percent(a, revenue)
    except Exception as e:  # noqa: BLE001 - one agreement's failed read never takes the list down
        out["billedYtd"] = out["expectedYtd"] = out["revenueYtd"] = None
        out["error"] = _why(e)
    if out["billedYtd"] is not None and out["expectedYtd"] is not None:
        out["difference"] = _r2(out["billedYtd"] - out["expectedYtd"])
    return out


# ── Endpoints ────────────────────────────────────────────────────────────────
@router.get("/agreements")
async def list_agreements(scope: dict = Depends(entity_scope)):
    """The agreements of the entities the caller may read (no ledger read)."""
    return {"agreements": await _visible(scope)}


@router.get("/summary")
async def summary(year: Optional[int] = None, scope: dict = Depends(entity_scope)):
    """Every agreement with its Billed YTD (from the ledger), Expected YTD,
    the difference and the next billing date."""
    today = date.today()
    year = year or today.year
    if not 2000 <= year <= today.year:
        raise HTTPException(status_code=400, detail="Pick a year up to this year.")
    agreements = await _visible(scope)
    rows = await asyncio.gather(*[summarize(scope, a, year, today) for a in agreements])
    return {"year": year, "asOf": min(today, date(year, 12, 31)).isoformat(), "rows": list(rows)}


@router.post("/agreements", status_code=201)
async def create_agreement(body: AgreementBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    fields = _clean(body)
    await _must_reach(scope, fields["entity_code"], fields["manager_entity_code"])
    return await asyncio.to_thread(_save, None, fields, user)


@router.put("/agreements/{agreement_id}")
async def update_agreement(agreement_id: str, body: AgreementBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    fields = _clean(body)
    current = await asyncio.to_thread(_one, agreement_id)
    await _must_reach(scope, current["entityCode"], fields["entity_code"], fields["manager_entity_code"])
    return await asyncio.to_thread(_save, agreement_id, fields, user)


@router.delete("/agreements/{agreement_id}", status_code=204)
async def delete_agreement(agreement_id: str, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    current = await asyncio.to_thread(_one, agreement_id)
    await _must_reach(scope, current["entityCode"])

    def work():
        db = SessionLocal()
        try:
            db.query(models.AccountingAmaAgreement).filter(models.AccountingAmaAgreement.id == agreement_id).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()
    await asyncio.to_thread(work)
