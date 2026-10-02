"""Accounting -> MRI -> Leasing -> Set Up From the Ledger (Neil and Charmi,
10/02: "Did you work on ... MRI at all?" - production had no leases, so the
rent roll opened empty).

A tenant is an Intacct customer, and rent received is what posted to the
lease's income accounts for that customer in that month (routers/leasing.py).
So the ledger already knows who the tenants are: for each LEAF entity the
caller may read (a parent entity rolls its children up - "(AM) (G) 910 S. El
Camino Real" is 12027-1 + 12027-2 - so scanning it too proposed every tenant
twice), the income accounts whose title says Rent / Rental / Lease, the
customers who posted to them in the last twelve months, and the month-by-
month amounts. One lease is proposed per (entity, customer) - tenant = the
customer, property = the entity, monthly rent = the most common amount of the
last three posted months, start = the first posted month. Tick + Create
writes the leases through the same validation and save New Lease uses;
a customer who already has an active lease on that entity is shown as set
up, never duplicated. Nothing is emailed to anyone.

Reads go through the accounting app's internal API only, every one through
`_limit`: the P&L account list once per entity (a light read), ONE buckets
by=customer read for each entity that has a rent account (a heavy one: every
posting of the window - reading it for every entity instead of the P&L made
the live scan slower, 391 s against 305 s), then by=month only for the
customers with rent postings - and not even that when the by=customer rows
carry a date and the customer posted in fewer than two months of the window
(the live payload carries no date, so the month read stays). The accounting
app answers about two reads a second whatever the parallelism, so the count
of reads is the scan's time. 305 s live is more than one request may take, so the
scan is a background job (accounting_loans.scan_job): the first GET starts it
and answers 202 with the progress, later GETs the same until the result (kept
30 minutes, cleared on create); a failed job answers 424 once and the next
GET starts over.
"""
import asyncio
import re
from collections import Counter, defaultdict
from datetime import date
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import models
from auth import require_module_grant
from database import SessionLocal
from routers import accounting, leasing
from routers.accounting import _limit, entity_scope
from routers.accounting_loans import ScanJob, _entities, _sem, forget_jobs, gather_tolerant, leaf_entities, month_bounds, scan_job, scan_result, shift_month

router = APIRouter(prefix="/accounting/leasing", tags=["Accounting"], dependencies=[Depends(require_module_grant("accounting", "viewer"))])
_edit = require_module_grant("accounting", "editor")

RENT_WORDS = re.compile(r"\brents?\b|rental|\blease\b|leasing|tenant")
LOOKED_FOR = ["Rent", "Rental", "Lease / Leasing", "Tenant"]
_INCOME = ("revenue", "other_income")
_POSTED = 0.5     # dollars: below this a month did not post
_DATE_KEYS = ("month", "date", "entry_date", "posted", "period")


def _r2(v) -> float:
    return round(float(v or 0) + 0.0, 2)


# ── The arithmetic (pure) ────────────────────────────────────────────────────
def rent_accounts(pnl_accounts: list[dict]) -> list[dict]:
    """The income accounts rent posts to: revenue / other income whose title
    says rent, rental, lease or tenant."""
    return [a for a in pnl_accounts if a.get("section") in _INCOME and RENT_WORDS.search((a.get("title") or "").lower())]


def row_month(row: dict) -> Optional[str]:
    """'YYYY-MM' when a buckets row carries a date, else None (the live
    by=customer payload does not; a by=month row's bucket is the month)."""
    for k in _DATE_KEYS:
        v = row.get(k)
        if isinstance(v, str) and re.match(r"^\d{4}-\d{2}", v):
            return v[:7]
    return None


def monthly_rent(monthly: dict[str, float]) -> Optional[float]:
    """The most common amount of the last three posted months; a tie goes to
    the latest month (a rent that just went up is the rent now)."""
    posted = sorted((m, _r2(v)) for m, v in monthly.items() if v > _POSTED)
    if not posted:
        return None
    last = posted[-3:]
    counts = Counter(v for _m, v in last)
    best = max(counts.values())
    for _m, v in reversed(last):      # the most common amount; a tie goes to the latest month
        if counts[v] == best:
            return v
    return last[-1][1]


def propose(entity: dict, accounts: list[dict], by_customer: dict[str, dict[str, float]], names: dict[str, str]) -> list[dict]:
    """One proposal per customer with rent postings; `by_customer` is
    {customer: {'YYYY-MM': amount}}."""
    out = []
    for cust, monthly in by_customer.items():
        posted = sorted(m for m, v in monthly.items() if v > _POSTED)
        if not posted:
            continue
        rent = monthly_rent(monthly)
        out.append({
            "entityCode": entity["code"], "entityName": entity.get("name") or entity["code"], "customerId": cust, "tenantName": names.get(cust) or cust,
            "incomeAccounts": [a["account_no"] for a in accounts], "accountTitles": [a["title"] for a in accounts],
            "monthlyRent": rent, "firstMonth": posted[0], "lastMonth": posted[-1], "postedMonths": len(posted),
            "received12": _r2(sum(v for v in monthly.values() if v > _POSTED)),
            "monthly": [{"month": m, "amount": _r2(monthly[m])} for m in sorted(monthly)],
        })
    return sorted(out, key=lambda p: (p["entityName"], p["tenantName"]))


# ── Ledger reads (every one through _limit) ──────────────────────────────────
async def _buckets(scope: dict, entity: str, by: str, from_: str, to: str, customer: Optional[str] = None) -> dict:
    location, _ = await _limit(scope, entity, None)
    async with _sem():
        return await accounting._acct_get("/api/internal/reports/buckets", {"from": from_, "to": to, "by": by, "location": location, "customer": customer})


async def _pnl_accounts(scope: dict, entity: str, from_: str, to: str) -> list[dict]:
    location, _ = await _limit(scope, entity, None)
    async with _sem():
        data = await accounting._acct_get("/api/internal/reports/pnl", {"from": from_, "to": to, "location": location})
    out = []
    for s in data.get("sections") or []:
        for a in s.get("accounts") or []:
            if a.get("account_no"):
                out.append({"section": s.get("key") or "", "account_no": str(a["account_no"]), "title": a.get("title") or ""})
    return out


async def _scan_entity(scope: dict, e: dict, from_: str, to: str) -> dict:
    accounts = rent_accounts(await _pnl_accounts(scope, e["code"], from_, to))
    if not accounts:
        return {"entity": e, "accounts": [], "proposals": []}
    codes = {a["account_no"] for a in accounts}
    data = await _buckets(scope, e["code"], "customer", from_, to)
    rows = data.get("rows") or []
    labels = data.get("labels") or {}
    rent_rows: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        if r.get("bucket") and str(r.get("account_no")) in codes:
            rent_rows[str(r["bucket"])].append(r)
    customers = sorted(c for c, rs in rent_rows.items() if sum(_r2(r.get("credit")) - _r2(r.get("debit")) for r in rs) > _POSTED)
    by_customer: dict[str, dict[str, float]] = {}
    need_months = []
    for cust in customers:
        months = {row_month(r) for r in rent_rows[cust]}
        if None not in months and len(months) < 2:
            # The payload says when it posted and it was one month: no month read needed.
            cell: dict[str, float] = defaultdict(float)
            for r in rent_rows[cust]:
                cell[row_month(r)] += _r2(r.get("credit")) - _r2(r.get("debit"))
            by_customer[cust] = dict(cell)
        else:
            need_months.append(cust)
    months = await asyncio.gather(*[_buckets(scope, e["code"], "month", from_, to, c) for c in need_months])
    for cust, data_m in zip(need_months, months):
        cell = defaultdict(float)
        for r in data_m.get("rows") or []:
            if str(r.get("account_no")) in codes and r.get("bucket"):
                cell[str(r["bucket"])[:7]] += _r2(r.get("credit")) - _r2(r.get("debit"))
        by_customer[cust] = dict(cell)
    names = {c: str(labels.get(c) or "") for c in customers}
    return {"entity": e, "accounts": accounts, "proposals": propose(e, accounts, by_customer, names)}


def _active_leases() -> dict[tuple[str, str], str]:
    db = SessionLocal()
    try:
        rows = db.query(models.Lease).filter(models.Lease.status == "active").all()
        return {((l.entity_code or ""), (l.customer_id or "")): l.id for l in rows if l.customer_id}
    finally:
        db.close()


def _window() -> tuple[str, str]:
    this = date.today().isoformat()[:7]
    from_, _ = month_bounds(shift_month(this, 11))
    _, to = month_bounds(this)
    return from_, to


def _scan_key(scope: dict) -> tuple:
    from_, to = _window()
    return (scope["user"]["email"], "leases", from_, to)


async def _scan(scope: dict, job: Optional[ScanJob] = None) -> dict:
    from_, to = _window()
    entities, parents = leaf_entities(await _entities(scope))
    if job:
        job.total = len(entities)
    parts, notes = await gather_tolerant([(lambda e=e: _scan_entity(scope, e, from_, to)) for e in entities],
                                         [f"{e.get('name') or e['code']} ({e['code']})" for e in entities],
                                         lambda: {"entity": {"code": "", "name": ""}, "accounts": [], "proposals": []},
                                         on_done=job.tick if job else None)
    parts = [p for p in parts if p["entity"].get("code")]
    out: dict[str, Any] = {
        "notes": [f"Not read this time - {n}" for n in notes],
        "from": from_, "to": to, "entitiesScanned": len(entities), "parentsSkipped": parents, "entitiesWithRentAccounts": sum(1 for p in parts if p["accounts"]),
        "rentAccounts": [{"entityCode": p["entity"]["code"], "entityName": p["entity"].get("name") or p["entity"]["code"], "code": a["account_no"], "title": a["title"]} for p in parts for a in p["accounts"]],
        "proposals": [x for p in parts for x in p["proposals"]], "lookedFor": LOOKED_FOR,
    }
    if job:
        job.cacheable = not notes   # a partial scan is shown, never kept as the answer
    return out


def _forget(email: str) -> None:
    forget_jobs(email, "leases")


def _with_status(scan: dict, have: dict) -> dict:
    rows = []
    for p in scan["proposals"]:
        lease_id = have.get((p["entityCode"], p["customerId"]))
        rows.append({**p, "status": "set_up" if lease_id else "new", "leaseId": lease_id})
    return {**scan, "proposals": rows, "setUp": sum(1 for r in rows if r["status"] == "set_up"), "missing": sum(1 for r in rows if r["status"] == "new")}


@router.get("/from-ledger/proposals")
async def proposals(scope: dict = Depends(entity_scope)):
    """One proposed lease per (entity, customer) with rent postings in the last
    twelve months; customers already on an active lease are marked set up.
    The scan runs in the background: 202 with the progress until it is done,
    then the result."""
    job = scan_job(_scan_key(scope), lambda job: _scan(scope, job))
    if job.result is None:
        return JSONResponse(status_code=202, content=job.progress())
    return _with_status(job.result, await asyncio.to_thread(_active_leases))


class CreateItem(BaseModel):
    entityCode: str
    customerId: str


class CreateBody(BaseModel):
    items: list[CreateItem]


@router.post("/from-ledger/create", status_code=201)
async def create_from_ledger(body: CreateBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    """Write the ticked proposals as leases - the same validation and save as
    New Lease. A customer already on an active lease for the entity is
    skipped, never duplicated (idempotent)."""
    if not body.items:
        raise HTTPException(status_code=400, detail="Tick at least one lease to create.")
    scan, have = await asyncio.gather(scan_result(_scan_key(scope), lambda job: _scan(scope, job)), asyncio.to_thread(_active_leases))
    by_key = {(p["entityCode"], p["customerId"]): p for p in scan["proposals"]}
    created, skipped = [], []
    for it in body.items:
        key = (it.entityCode.strip(), it.customerId.strip())
        await leasing._must_reach(scope, key[0])
        p = by_key.get(key)
        if not p:
            skipped.append({"entityCode": key[0], "customerId": key[1], "why": "no rent postings for this customer on the ledger"})
            continue
        if key in have:
            skipped.append({"entityCode": key[0], "customerId": key[1], "why": "already set up"})
            continue
        start = f"{p['firstMonth']}-01"
        lease_body = leasing.LeaseBody(
            propertyName=p["entityName"], tenancy="external", landlord=p["entityName"], entityCode=p["entityCode"], incomeAccounts=p["incomeAccounts"],
            customerId=p["customerId"], tenantName=p["tenantName"], leaseStart=start, status="active",
            notes=f"Set up from the ledger: rent posted {p['firstMonth']} to {p['lastMonth']} ({p['postedMonths']} months).",
            rates=[leasing.RateBody(startDate=start, rent=p["monthlyRent"] or 0, note="From the ledger")],
        )
        fields = leasing._clean(lease_body)
        await leasing._must_reach(scope, fields["entity_code"])
        lease = await asyncio.to_thread(leasing._save_lease, None, fields, leasing._clean_rates(lease_body.rates), user)
        have[key] = lease["id"]
        created.append({**p, "leaseId": lease["id"]})
    _forget(user["email"])
    return {"created": created, "skipped": skipped}
