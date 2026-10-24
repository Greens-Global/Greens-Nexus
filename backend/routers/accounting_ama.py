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

Oct 23 (Charmi, 22 Oct call, CR-03): a third basis, PERCENT OR FLAT - the
operating-agreement rule "X% of gross when gross is above a threshold, else a
flat amount", with the percent, threshold, flat amount and what the threshold
is measured on (the year's gross or the period's) kept per agreement. The
summary takes a PERIOD of the year (Year to Date, a quarter or a month) and
answers, per agreement, the managed entity's gross for it (`grossRevenue`)
and the fee it works out to (`calculatedFee`); Billed / Expected YTD run Jan 1
through the period's end. What "gross" is and every default an agreement
leaves blank live in accounting_assumptions.py (MGMT_FEE_*). An agreement
saved before this has no threshold and reads exactly as it did.

Oct 23, team answer (Neil): "Usually it's 3% of gross revenue or
$3,000/month, whichever is higher ... built in property by property". A
fourth basis, GREATER OF: per agreement a rate and a MONTHLY MINIMUM (kept in
flat_amount - no new column); each month takes the higher of the two
(MGMT_FEE_GREATER_OF_COMPARE), read from ONE by=month buckets read, and the
row says which rule applied (feeTier 'percent' / 'minimum' / 'mixed', with
the months on each side). New agreements start on it (MGMT_FEE_DEFAULT_*).
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

import accounting_assumptions as assume
import models
from auth import require_module_grant
from database import SessionLocal
from routers import accounting
from routers.accounting import _limit, entity_scope
from routers.accounting_ask import chart_of
from routers.accounting_loans import _sem

router = APIRouter(prefix="/accounting/ama", tags=["Accounting"], dependencies=[Depends(require_module_grant("accounting", "viewer"))])
_edit = require_module_grant("accounting", "editor")

_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
STATUSES = ("Active", "Pending Review", "Ended")
BASES = ("percent_revenue", "flat", "percent_or_flat", "greater_of")
_PERCENT_BASES = ("percent_revenue", "percent_or_flat", "greater_of")
FREQUENCIES = {"Monthly": 1, "Quarterly": 3, "Annually": 12}
_INCOME = assume.MGMT_FEE_GROSS_SECTIONS
_PERIOD = re.compile(r"^(ytd|q[1-4]|m(0[1-9]|1[0-2]))$")


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


def in_window(a: dict, lo: date, hi: date) -> Optional[tuple[date, date]]:
    """(from, to): the part of lo..hi the agreement was in force, or None.
    An Ended agreement with no end date is in force nowhere - when it
    stopped is unknown, so nothing is expected of it."""
    start = _d(a.get("startDate") or "")
    end = _d(a.get("endDate") or "")
    if not start or (a.get("status") == "Ended" and not end):
        return None
    lo = max(start, lo)
    hi = min(hi, end or hi)
    return (lo, hi) if lo <= hi else None


def in_force(a: dict, year: int, as_of: date) -> Optional[tuple[date, date]]:
    """The part of `year` up to `as_of` the agreement was in force, or None."""
    return in_window(a, date(year, 1, 1), min(as_of, date(year, 12, 31)))


def billings_in(a: dict, window: Optional[tuple[date, date]]) -> int:
    """How many billing dates fell inside `window` (an in_window answer)."""
    if not window:
        return 0
    start = _d(a["startDate"])
    return sum(1 for b in billing_dates(start, a.get("billingFrequency") or "Monthly", window[1]) if b >= window[0])


def periods_elapsed(a: dict, year: int, as_of: date) -> int:
    """How many billing dates fell in the part of the year it was in force."""
    return billings_in(a, in_force(a, year, as_of))


def period_window(year: int, period: str, today: date) -> tuple[date, date]:
    """The dates of a period of `year` - 'ytd', 'q1'..'q4', 'm01'..'m12' -
    cut at today. A period that has not started yet is a 400."""
    if not _PERIOD.match(period or ""):
        raise HTTPException(status_code=400, detail="The period is ytd, q1-q4 or m01-m12.")
    if period == "ytd":
        lo, hi = date(year, 1, 1), date(year, 12, 31)
    elif period[0] == "q":
        q = int(period[1])
        lo = date(year, q * 3 - 2, 1)
        hi = add_months(lo, 2, 31)
    else:
        lo = date(year, int(period[1:]), 1)
        hi = add_months(lo, 0, 31)
    if lo > today:
        raise HTTPException(status_code=400, detail="That period has not started yet.")
    return lo, min(hi, today)


def threshold_basis(a: dict) -> str:
    """What a Percent or Flat agreement's threshold is measured on."""
    b = (a.get("thresholdBasis") or "").strip().lower()
    if b in assume.MGMT_FEE_THRESHOLD_BASES:
        return b
    d = assume.MGMT_FEE_DEFAULT_THRESHOLD_BASIS
    return d if d in assume.MGMT_FEE_THRESHOLD_BASES else "annual"


def threshold_of(a: dict) -> float:
    t = a.get("thresholdAmount")
    return float(assume.MGMT_FEE_DEFAULT_THRESHOLD if t is None else t)


def above_threshold(gross: float, threshold: float) -> bool:
    return gross > threshold if assume.MGMT_FEE_STRICTLY_ABOVE else gross >= threshold


def tier_flat(a: dict, billings: int) -> float:
    """The flat side of Percent or Flat for `billings` billing dates: a yearly
    amount spread over the year's billing dates (MGMT_FEE_TIER_FLAT_IS_ANNUAL),
    else an amount per billing date."""
    flat = float(a.get("flatAmount") or 0)
    if assume.MGMT_FEE_TIER_FLAT_IS_ANNUAL:
        per_year = 12 // FREQUENCIES.get(a.get("billingFrequency") or "Monthly", 1)
        return _r2(flat * billings / per_year)
    return _r2(flat * billings)


def months_in(w: Optional[tuple[date, date]]) -> list[str]:
    """'YYYY-MM' of every calendar month a window touches."""
    if not w:
        return []
    out, y, m = [], w[0].year, w[0].month
    while (y, m) <= (w[1].year, w[1].month):
        out.append(f"{y:04d}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def _month_share(ym: str, w: tuple[date, date]) -> float:
    """The share of month `ym`'s days inside window `w` (0..1)."""
    y, m = int(ym[:4]), int(ym[5:7])
    last = calendar.monthrange(y, m)[1]
    lo, hi = max(w[0], date(y, m, 1)), min(w[1], date(y, m, last))
    return max(0, (hi - lo).days + 1) / last


def minimum_of(a: dict) -> float:
    """The monthly minimum of a Greater Of agreement (flat_amount holds it)."""
    f = a.get("flatAmount")
    return float(assume.MGMT_FEE_DEFAULT_MONTHLY_MINIMUM if f is None else f)


def greater_of_fee(a: dict, monthly: dict, w: Optional[tuple[date, date]]) -> dict:
    """CR-03 (Neil, 23 Oct): "3% of gross revenue or $3,000/month, whichever
    is higher", per agreement. `monthly` is {'YYYY-MM': gross}. Compared
    month by month (MGMT_FEE_GREATER_OF_COMPARE 'month') or once over the
    whole window ('window': rate x window gross vs. minimum x months).
    Answers {fee, tier, months, minimumMonths, percentMonths, gross} - tier
    'percent', 'minimum' or 'mixed' (some months each), None out of force."""
    months = months_in(w)
    rate = float(a.get("feeRate") or 0) / 100.0
    minimum = minimum_of(a)
    gross = _r2(sum(_r2(monthly.get(k)) for k in months))
    out = {"fee": 0.0, "tier": None, "months": len(months), "minimumMonths": 0, "percentMonths": 0, "gross": gross}
    if not months:
        return out
    if assume.MGMT_FEE_GREATER_OF_COMPARE == "window":
        pct, floor = _r2(rate * gross), _r2(minimum * len(months))
        at_min = floor > pct
        out.update(fee=max(pct, floor), tier="minimum" if at_min else "percent",
                   minimumMonths=len(months) if at_min else 0, percentMonths=0 if at_min else len(months))
        return out
    fee = 0.0
    for k in months:
        pct = _r2(rate * _r2(monthly.get(k)))
        floor = _r2(minimum * _month_share(k, w)) if assume.MGMT_FEE_PRORATE_PARTIAL_MONTH else minimum
        if floor > pct:
            fee += floor
            out["minimumMonths"] += 1
        else:
            fee += pct
            out["percentMonths"] += 1
    out["fee"] = _r2(fee)
    out["tier"] = "minimum" if not out["percentMonths"] else "percent" if not out["minimumMonths"] else "mixed"
    return out


def fee_for(a: dict, gross: float, test_gross: float, billings: int) -> tuple[float, str]:
    """(fee, tier) for one window: `gross` the managed entity's gross in it,
    `test_gross` what the threshold is compared with, `billings` the billing
    dates in it. tier is 'percent' or 'flat' - which side of the rule applied."""
    basis = a.get("feeBasis")
    if basis == "flat":
        return _r2(float(a.get("flatAmount") or 0) * billings), "flat"
    if basis == "percent_or_flat" and not above_threshold(float(test_gross or 0), threshold_of(a)):
        return tier_flat(a, billings), "flat"
    return expected_percent(a, gross), "percent"


def _account_spec(spec: str) -> list[tuple[str, str]]:
    """'40000-49999,70100' -> [('40000', '49999'), ('70100', '70100')]."""
    out = []
    for part in (spec or "").split(","):
        part = part.strip()
        if not part:
            continue
        lo, _, hi = part.partition("-")
        out.append((lo.strip(), (hi or lo).strip()))
    return out


def counts_as_gross(code: str, spec: Optional[list] = None) -> bool:
    """Whether a P&L account adds into gross (MGMT_FEE_GROSS_ACCOUNTS; none
    listed = every account of the gross sections). Numeric codes compare as
    numbers, anything else as text."""
    ranges = _account_spec(assume.MGMT_FEE_GROSS_ACCOUNTS) if spec is None else spec
    if not ranges:
        return True
    code = str(code or "").strip()
    for lo, hi in ranges:
        if code.isdigit() and lo.isdigit() and hi.isdigit():
            if int(lo) <= int(code) <= int(hi):
                return True
        elif lo <= code <= hi:
            return True
    return False


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
    """Gross income of one P&L answer: the MGMT_FEE_GROSS_SECTIONS (revenue +
    other income), narrowed to MGMT_FEE_GROSS_ACCOUNTS when any are listed."""
    spec = _account_spec(assume.MGMT_FEE_GROSS_ACCOUNTS)
    total = 0.0
    for s in pnl.get("sections") or []:
        if s.get("key") in _INCOME:
            total += sum(_r2(x.get("amount")) for x in s.get("accounts") or [] if counts_as_gross(x.get("account_no"), spec))
    return _r2(total)


def gross_by_month(buckets: dict) -> dict:
    """{'YYYY-MM': gross} from a by=month buckets answer: credits less debits
    on the MGMT_FEE_GROSS_SECTIONS accounts (narrowed like income_of)."""
    spec = _account_spec(assume.MGMT_FEE_GROSS_ACCOUNTS)
    out: dict = {}
    for r in buckets.get("rows") or []:
        if r.get("section") not in _INCOME or not counts_as_gross(r.get("account_no"), spec):
            continue
        k = str(r.get("month") or r.get("bucket") or "")[:7]
        out[k] = _r2(out.get(k, 0.0) + _r2(r.get("credit")) - _r2(r.get("debit")))
    return out


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
        "thresholdAmount": r.threshold_amount, "thresholdBasis": r.threshold_basis if r.threshold_basis in assume.MGMT_FEE_THRESHOLD_BASES else "",
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
    thresholdAmount: Optional[float] = None
    thresholdBasis: Optional[str] = ""


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
        raise HTTPException(status_code=400, detail="The fee is a percent of revenue, a flat amount, a percent or flat by a threshold, or the higher of a percent and a monthly minimum.")
    if body.billingFrequency not in FREQUENCIES:
        raise HTTPException(status_code=400, detail="Billing is Monthly, Quarterly or Annually.")
    rate = flat = threshold = None
    basis = ""
    if body.feeBasis in _PERCENT_BASES:
        if body.feeRate is None or not 0 < body.feeRate <= 100:
            raise HTTPException(status_code=400, detail="The fee rate is a percent above 0 and up to 100.")
        rate = float(body.feeRate)
    if body.feeBasis in ("flat", "percent_or_flat"):
        if body.flatAmount is None or body.flatAmount <= 0:
            raise HTTPException(status_code=400, detail="The flat fee must be more than zero.")
        flat = float(body.flatAmount)
    if body.feeBasis == "greater_of":
        # CR-03 (Neil, 23 Oct): here flat_amount is the MONTHLY minimum.
        if body.flatAmount is None or body.flatAmount < 0:
            raise HTTPException(status_code=400, detail="The monthly minimum must be zero or more.")
        flat = float(body.flatAmount)
    if body.feeBasis == "percent_or_flat":
        if body.thresholdAmount is None or body.thresholdAmount < 0:
            raise HTTPException(status_code=400, detail="The gross income threshold must be zero or more.")
        threshold = float(body.thresholdAmount)
        basis = (body.thresholdBasis or "").strip().lower()
        if basis and basis not in assume.MGMT_FEE_THRESHOLD_BASES:
            raise HTTPException(status_code=400, detail="The threshold is measured on the annual or the period gross.")
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
        "threshold_amount": threshold, "threshold_basis": basis,
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


async def _monthly_income(scope: dict, entity: str, from_: str, to: str) -> dict:
    location, _ = await _limit(scope, entity, None)
    async with _sem():
        data = await accounting._acct_get("/api/internal/reports/buckets", {"from": from_, "to": to, "by": "month", "location": location})
    return gross_by_month(data)


async def _income(scope: dict, entity: str, from_: str, to: str) -> float:
    location, _ = await _limit(scope, entity, None)
    async with _sem():
        data = await accounting._acct_get("/api/internal/reports/pnl", {"from": from_, "to": to, "location": location})
    return income_of(data)


def _why(e: Exception) -> str:
    if isinstance(e, HTTPException):
        return str(e.detail)
    return "The ledger could not be read."


async def summarize(scope: dict, a: dict, year: int, today: date, period: str = "ytd") -> dict:
    """One agreement for one period of `year`: the managed entity's gross and
    the fee for the period, and Billed / Expected YTD through its end."""
    p_from, p_to = period_window(year, period, min(today, date(year, 12, 31)))
    as_of = p_to
    jan1 = date(year, 1, 1)
    billing_entity = a["managerEntityCode"] or a["entityCode"]
    ytd = in_window(a, jan1, as_of)
    win = in_window(a, p_from, p_to)
    pct = a["feeBasis"] in _PERCENT_BASES
    tiered = a["feeBasis"] == "percent_or_flat"
    annual = threshold_basis(a) == "annual"
    out = {**a, "billingEntityCode": billing_entity, "year": year, "asOf": as_of.isoformat(),
           "period": period, "periodFrom": p_from.isoformat(), "periodTo": p_to.isoformat(),
           "billedYtd": None, "expectedYtd": None, "difference": None, "revenueYtd": None,
           "grossRevenue": None, "calculatedFee": None, "feeTier": None, "testGross": None, "expectedTier": None,
           "thresholdUsed": threshold_of(a) if tiered else None, "thresholdBasisUsed": threshold_basis(a) if tiered else None,
           "periodsElapsed": billings_in(a, ytd), "periodBillings": billings_in(a, win),
           "nextBilling": next_billing(a, today), "error": None, "grossError": None}
    seen: dict = {}

    async def gross(w: Optional[tuple[date, date]]) -> float:
        if not w:
            return 0.0
        k = (w[0].isoformat(), w[1].isoformat())
        if k not in seen:
            seen[k] = await _income(scope, a["entityCode"], *k)
        return seen[k]

    if a["feeBasis"] == "greater_of":
        return await _summarize_greater_of(scope, a, out, jan1, as_of, (p_from, p_to), ytd, win)
    try:
        if a["feeGlAccount"]:
            out["billedYtd"] = await _billed(scope, billing_entity, a["feeGlAccount"], jan1.isoformat(), as_of.isoformat())
        # The entity's gross for the whole period, whatever the agreement's
        # dates. A flat fee does not depend on it, so there a failed read only
        # blanks the gross.
        if pct:
            out["grossRevenue"] = await gross((p_from, p_to))
        else:
            try:
                out["grossRevenue"] = await gross((p_from, p_to))
            except Exception as e:  # noqa: BLE001
                out["grossError"] = _why(e)
        year_gross = await gross((jan1, as_of)) if tiered and annual else None
        ytd_gross = await gross(ytd) if pct else 0.0
        win_gross = await gross(win) if pct else 0.0
        if pct:
            out["revenueYtd"] = ytd_gross
        if tiered:
            out["testGross"] = year_gross if annual else win_gross
        out["expectedYtd"], out["expectedTier"] = fee_for(a, ytd_gross, year_gross if annual else ytd_gross, out["periodsElapsed"])
        if win:
            out["calculatedFee"], out["feeTier"] = fee_for(a, win_gross, year_gross if annual else win_gross, out["periodBillings"])
        else:
            out["calculatedFee"] = 0.0
    except Exception as e:  # noqa: BLE001 - one agreement's failed read never takes the list down
        for k in ("billedYtd", "expectedYtd", "revenueYtd", "grossRevenue", "calculatedFee", "feeTier", "testGross", "expectedTier"):
            out[k] = None
        out["error"] = _why(e)
    if out["billedYtd"] is not None and out["expectedYtd"] is not None:
        out["difference"] = _r2(out["billedYtd"] - out["expectedYtd"])
    return out


async def _summarize_greater_of(scope: dict, a: dict, out: dict, jan1: date, as_of: date, period: tuple, ytd, win) -> dict:
    """Greater Of: ONE by=month read of the managed entity, Jan 1 through the
    period's end, gives every figure - the period's gross, the fee month by
    month and Expected YTD - plus which rule applied (`feeTier`, and how many
    months took the minimum / the percent)."""
    out.update(minimumUsed=minimum_of(a), compareBy=assume.MGMT_FEE_GREATER_OF_COMPARE,
               minimumMonths=None, percentMonths=None, ytdMinimumMonths=None, ytdPercentMonths=None)
    try:
        if a["feeGlAccount"]:
            out["billedYtd"] = await _billed(scope, out["billingEntityCode"], a["feeGlAccount"], jan1.isoformat(), as_of.isoformat())
        monthly = await _monthly_income(scope, a["entityCode"], jan1.isoformat(), as_of.isoformat())
        out["grossRevenue"] = greater_of_fee(a, monthly, period)["gross"]
        y = greater_of_fee(a, monthly, ytd)
        out.update(revenueYtd=y["gross"], expectedYtd=y["fee"], expectedTier=y["tier"],
                   ytdMinimumMonths=y["minimumMonths"], ytdPercentMonths=y["percentMonths"])
        p = greater_of_fee(a, monthly, win)
        out.update(calculatedFee=p["fee"], feeTier=p["tier"], minimumMonths=p["minimumMonths"], percentMonths=p["percentMonths"])
    except Exception as e:  # noqa: BLE001 - one agreement's failed read never takes the list down
        for k in ("billedYtd", "expectedYtd", "revenueYtd", "grossRevenue", "calculatedFee", "feeTier", "expectedTier"):
            out[k] = None
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
async def summary(year: Optional[int] = None, period: str = "ytd", scope: dict = Depends(entity_scope)):
    """Every agreement with the managed entity's gross and the calculated
    fee for the period (ytd, q1-q4, m01-m12), its Billed YTD (from the
    ledger), Expected YTD and the difference through the period's end, and
    the next billing date."""
    today = date.today()
    year = year or today.year
    if not 2000 <= year <= today.year:
        raise HTTPException(status_code=400, detail="Pick a year up to this year.")
    period = (period or "ytd").strip().lower()
    p_from, p_to = period_window(year, period, min(today, date(year, 12, 31)))
    agreements = await _visible(scope)
    rows = await asyncio.gather(*[summarize(scope, a, year, today, period) for a in agreements])
    return {"year": year, "period": period, "periodFrom": p_from.isoformat(), "periodTo": p_to.isoformat(),
            "asOf": p_to.isoformat(), "rows": list(rows)}


@router.get("/accounts")
async def gl_accounts(_user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    """Every GL account with activity on the ledger the caller reads, from
    the start of the books - the Fee GL Account picker's list (Charmi, Oct 22:
    "I should be able to search it")."""
    location, locations = await _limit(scope, None, None)
    async with _sem():
        data = await accounting._acct_get("/api/internal/reports/buckets", {
            "to": date.today().isoformat(), "by": "total", "location": location, "locations": locations})
    return {"accounts": chart_of(data)}


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
