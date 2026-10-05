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

Oct 6 (Charmi, 10/04: "5 of 279 entities" - and slow):
  - Only ACTIVE entities are scanned: the historical (H) ones - "(H)" in the
    name or an H before the number, the rule of the Reports entity list
    (reportModel.isHistoricalEntity) - are skipped like the parents.
  - The P&L read per entity is gone. ONE buckets by=entity read over the
    active leaf entities (the month summary, fast at any size; in chunks of
    100 codes) says which entities have rent-titled income at all. Only those
    get a by=customer read. The month-by-month split is ONE /by-customer read
    for every tenant found (the read the rent roll uses), not one per
    customer; a customer seen on more than one entity still gets the
    per-entity month read, so two properties never mix. Hundreds of reads
    became a few dozen.
  - The ledger sync (leasing_sync_loop, every six hours on the deployed
    worker; POST /accounting/leasing/sync on demand): links every lease to
    its Intacct customer by name (routers/leasing.autolink) and adds a lease
    for a NEW tenant - a customer who posted rent in the last two months and
    is on no lease (active or ended) of that entity, and is not inactive in
    Intacct. Added leases say so in their notes. Nothing is emailed.
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

_HISTORICAL = re.compile(r"\(\s*H\s*\)", re.I)
_CHUNK = 100       # entity codes per by=entity read
_BY_CUSTOMER = 300  # customers per /by-customer read
SYNC_EMAIL = "ledger-sync"
SYNC_EVERY_SEC = 6 * 3600

router = APIRouter(prefix="/accounting/leasing", tags=["Accounting"], dependencies=[Depends(require_module_grant("accounting", "viewer"))])
_edit = require_module_grant("accounting", "editor")

RENT_WORDS = re.compile(r"\brents?\b|rental|\blease\b|leasing|tenant")
LOOKED_FOR = ["Rent", "Rental", "Lease / Leasing", "Tenant"]
_INCOME = ("revenue", "other_income")
_POSTED = 0.5     # dollars: below this a month did not post


def _r2(v) -> float:
    return round(float(v or 0) + 0.0, 2)


# ── The arithmetic (pure) ────────────────────────────────────────────────────
def rent_accounts(pnl_accounts: list[dict]) -> list[dict]:
    """The income accounts rent posts to: revenue / other income whose title
    says rent, rental, lease or tenant."""
    return [a for a in pnl_accounts if a.get("section") in _INCOME and RENT_WORDS.search((a.get("title") or "").lower())]


def is_historical_entity(e: dict) -> bool:
    """A historical entity: "(H)" in its name or an H before its number
    (H12001) - the Reports entity list's rule (reportModel.isHistoricalEntity)."""
    return bool(_HISTORICAL.search(e.get("name") or "")) or bool(re.match(r"^H\d", e.get("code") or "", re.I))


def active_leaves(entities: list[dict]) -> tuple[list[dict], int, int]:
    """(the leaf entities that are not historical, parents skipped, historical skipped)."""
    leaves, parents = leaf_entities(entities)
    active = [e for e in leaves if not is_historical_entity(e)]
    return active, parents, len(leaves) - len(active)


def rent_by_entity(rows: list[dict], codes: list[str]) -> dict[str, list[dict]]:
    """entity -> its rent accounts with activity, from by=entity buckets rows
    (one row per account and entity: account_no, title, section, bucket)."""
    out: dict[str, dict[str, dict]] = defaultdict(dict)
    one = codes[0] if len(codes) == 1 else None
    for r in rows:
        ent = str(r.get("bucket") or one or "")
        if not ent or ent not in codes:
            continue
        acct = {"section": r.get("section") or "", "account_no": str(r.get("account_no") or ""), "title": r.get("title") or ""}
        if acct["account_no"] and rent_accounts([acct]) and abs(_r2(r.get("credit")) - _r2(r.get("debit"))) > _POSTED:
            out[ent].setdefault(acct["account_no"], acct)
    return {e: sorted(a.values(), key=lambda x: x["account_no"]) for e, a in out.items()}


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


async def _rent_entities(scope: dict, codes: list[str], from_: str, to: str) -> dict[str, list[dict]]:
    """Which of `codes` have rent-titled income in the window: ONE buckets
    by=entity read (the month summary - fast whatever the count)."""
    location, locations = await _limit(scope, codes[0] if len(codes) == 1 else None, None if len(codes) == 1 else ",".join(codes))
    async with _sem():
        data = await accounting._acct_get("/api/internal/reports/buckets", {"from": from_, "to": to, "by": "entity", "location": location, "locations": locations})
    return rent_by_entity(data.get("rows") or [], codes)


async def _customers_of(scope: dict, e: dict, accounts: list[dict], from_: str, to: str) -> dict:
    """The customers who posted to the entity's rent accounts in the window,
    with what they posted in all (one by=customer read)."""
    codes = {a["account_no"] for a in accounts}
    data = await _buckets(scope, e["code"], "customer", from_, to)
    labels = data.get("labels") or {}
    totals: dict[str, float] = defaultdict(float)
    for r in data.get("rows") or []:
        if r.get("bucket") and str(r.get("account_no")) in codes:
            totals[str(r["bucket"])] += _r2(r.get("credit")) - _r2(r.get("debit"))
    customers = sorted(c for c, v in totals.items() if v > _POSTED)
    return {"entity": e, "accounts": accounts, "customers": customers, "names": {c: str(labels.get(c) or "") for c in customers}}


async def _months_by_customer(customers: list[str], accounts: set[str], from_: str, to: str) -> dict[str, dict[str, dict[str, float]]]:
    """customer -> account -> {'YYYY-MM': amount}, ONE /by-customer read per 300 customers."""
    out: dict[str, dict[str, dict[str, float]]] = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    for i in range(0, len(customers), _BY_CUSTOMER):
        async with _sem():
            data = await accounting._acct_get("/api/internal/reports/by-customer", {"from": from_, "to": to, "customers": ",".join(customers[i:i + _BY_CUSTOMER]), "accounts": ",".join(sorted(accounts))})
        for r in data.get("rows") or []:
            if r.get("customer") and r.get("month"):
                out[str(r["customer"])][str(r.get("account_no"))][str(r["month"])[:7]] += _r2(r.get("credit")) - _r2(r.get("debit"))
    return out


async def _entity_months(scope: dict, e: dict, cust: str, codes: set[str], from_: str, to: str) -> dict[str, float]:
    """One customer's rent on one entity, month by month (a customer seen on
    several entities: the consolidated read would mix them)."""
    data = await _buckets(scope, e["code"], "month", from_, to, cust)
    cell: dict[str, float] = defaultdict(float)
    for r in data.get("rows") or []:
        if str(r.get("account_no")) in codes and r.get("bucket"):
            cell[str(r["bucket"])[:7]] += _r2(r.get("credit")) - _r2(r.get("debit"))
    return dict(cell)


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
    entities, parents, historical = active_leaves(await _entities(scope))
    if job:
        job.total = len(entities)
    # 1. Which active entities have rent income at all: a read per 100 codes.
    chunks = [entities[i:i + _CHUNK] for i in range(0, len(entities), _CHUNK)]
    found, notes = await gather_tolerant([(lambda c=c: _rent_entities(scope, [e["code"] for e in c], from_, to)) for c in chunks],
                                         [f"{len(c)} entities from {c[0]['code']}" for c in chunks], dict)
    rent: dict[str, list[dict]] = {}
    for f in found:
        rent.update(f)
    with_rent = [e for e in entities if e["code"] in rent]
    if job:
        job.done += len(entities) - len(with_rent)
    # 2. Their customers: one by=customer read per entity with rent.
    parts, more = await gather_tolerant([(lambda e=e: _customers_of(scope, e, rent[e["code"]], from_, to)) for e in with_rent],
                                        [f"{e.get('name') or e['code']} ({e['code']})" for e in with_rent],
                                        lambda: {"entity": {"code": ""}, "accounts": [], "customers": [], "names": {}},
                                        on_done=job.tick if job else None)
    notes += more
    parts = [p for p in parts if p["entity"].get("code")]
    # 3. Month by month: one consolidated read for every tenant seen on one
    # entity; a per-entity month read for a tenant seen on several.
    seen: dict[str, int] = defaultdict(int)
    for p in parts:
        for c in p["customers"]:
            seen[c] += 1
    single = sorted(c for c, n in seen.items() if n == 1)
    all_rent_accounts = {a["account_no"] for p in parts for a in p["accounts"]}
    consolidated: dict = {}
    if single:
        try:
            consolidated = await _months_by_customer(single, all_rent_accounts, from_, to)
        except Exception:  # noqa: BLE001 - fall back to the per-entity month reads
            consolidated = None
    proposals = []
    for p in parts:
        codes = {a["account_no"] for a in p["accounts"]}
        by_customer: dict[str, dict[str, float]] = {}
        split = [c for c in p["customers"] if consolidated is None or seen[c] > 1]
        for c in p["customers"]:
            if c in split:
                continue
            cell: dict[str, float] = defaultdict(float)
            for acct, months in (consolidated.get(c) or {}).items():
                if acct in codes:
                    for m, v in months.items():
                        cell[m] += v
            by_customer[c] = dict(cell)
        months_read, failed = await gather_tolerant([(lambda c=c: _entity_months(scope, p["entity"], c, codes, from_, to)) for c in split],
                                                    [f"{c} at {p['entity']['code']}" for c in split], dict)
        notes += failed
        by_customer.update(dict(zip(split, months_read)))
        proposals += propose(p["entity"], p["accounts"], by_customer, p["names"])
    out: dict[str, Any] = {
        "notes": [f"Not read this time - {n}" for n in notes],
        "from": from_, "to": to, "entitiesScanned": len(entities), "parentsSkipped": parents, "historicalSkipped": historical,
        "entitiesWithRentAccounts": len(parts),
        "rentAccounts": [{"entityCode": p["entity"]["code"], "entityName": p["entity"].get("name") or p["entity"]["code"], "code": a["account_no"], "title": a["title"]} for p in parts for a in p["accounts"]],
        "proposals": sorted(proposals, key=lambda x: (x["entityName"], x["tenantName"])), "lookedFor": LOOKED_FOR,
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


def _lease_from(p: dict, how: str = "Set up from the ledger") -> tuple[dict, list[dict]]:
    """A proposal as a lease - the same validation and save New Lease uses."""
    start = f"{p['firstMonth']}-01"
    body = leasing.LeaseBody(
        propertyName=p["entityName"], tenancy="external", landlord=p["entityName"], entityCode=p["entityCode"], incomeAccounts=p["incomeAccounts"],
        customerId=p["customerId"], tenantName=p["tenantName"], leaseStart=start, status="active",
        notes=f"{how}: rent posted {p['firstMonth']} to {p['lastMonth']} ({p['postedMonths']} months).",
        rates=[leasing.RateBody(startDate=start, rent=p["monthlyRent"] or 0, note="From the ledger")],
    )
    return leasing._clean(body), leasing._clean_rates(body.rates)


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
        fields, rates = _lease_from(p)
        await leasing._must_reach(scope, fields["entity_code"])
        lease = await asyncio.to_thread(leasing._save_lease, None, fields, rates, user)
        have[key] = lease["id"]
        created.append({**p, "leaseId": lease["id"]})
    _forget(user["email"])
    return {"created": created, "skipped": skipped}


# ── The ledger sync (Oct 6) ──────────────────────────────────────────────────
def _all_leases() -> list[dict]:
    db = SessionLocal()
    try:
        rows = db.query(models.Lease).all()
        return [{"id": l.id, "entityCode": l.entity_code or "", "customerId": l.customer_id or "", "tenantName": l.tenant_name or "", "status": l.status or "active",
                 "propertyName": l.property_name or ""} for l in rows]
    finally:
        db.close()


def new_tenants(proposals: list[dict], leases: list[dict], directory: dict, this_month: str) -> list[dict]:
    """The proposals the sync adds as leases: a customer who posted rent this
    month or last, on no lease (active or ended - a tenant who left is not
    brought back) of that entity, and not inactive in Intacct."""
    known = {(l["entityCode"], l["customerId"]) for l in leases if l["customerId"]}
    recent = shift_month(this_month, 1)
    out = []
    for p in proposals:
        c = directory.get(p["customerId"])
        if (p["entityCode"], p["customerId"]) in known or (p.get("lastMonth") or "") < recent or (c and not c.get("active", True)):
            continue
        out.append(p)
    return out


async def ledger_sync(scope: dict, user: dict) -> dict:
    """Link the leases to their customers and add the new tenants' leases."""
    leases = await asyncio.to_thread(_all_leases)
    reach = await leasing._reach(scope)
    if reach is not None:
        leases = [l for l in leases if l["entityCode"] in reach]
    directory = await leasing.customer_directory()
    linked = await leasing.autolink(leases, directory)
    scan = await scan_result(_scan_key(scope), lambda job: _scan(scope, job))
    created = []
    for p in new_tenants(scan["proposals"], await asyncio.to_thread(_all_leases), directory, date.today().isoformat()[:7]):
        fields, rates = _lease_from(p, "Added automatically from the ledger")
        fields["link_source"] = "auto-ledger"
        lease = await asyncio.to_thread(leasing._save_lease, None, fields, rates, user)
        created.append({"leaseId": lease["id"], "entityCode": p["entityCode"], "entityName": p["entityName"], "customerId": p["customerId"], "tenantName": p["tenantName"], "monthlyRent": p["monthlyRent"]})
    if created:
        _forget(scope["user"]["email"])
    return {"linked": linked, "created": created, "notes": scan.get("notes") or []}


@router.post("/sync")
async def sync_now(user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    """Run the ledger sync now for the entities the caller may read: link the
    leases to their Intacct customers, add the leases of new tenants."""
    return await ledger_sync(scope, user)


async def leasing_sync_loop():
    """Every six hours on the deployed worker. Every read is async or in a
    thread (asyncio.to_thread), never a blocking call on the loop."""
    from leader import is_deployed_worker

    if not is_deployed_worker():
        print("[leasing-sync] skipped (not the deployed worker)")
        return
    await asyncio.sleep(300)  # let startup settle
    scope = {"user": {"email": SYNC_EMAIL, "name": "Ledger Sync"}, "allowed": None}
    while True:
        try:
            if accounting._ACCT_BASE and accounting._ACCT_KEY:
                out = await ledger_sync(scope, {"email": SYNC_EMAIL})
                if out["linked"] or out["created"]:
                    print(f"[leasing-sync] linked {len(out['linked'])}, added {len(out['created'])}")
        except Exception as e:  # noqa: BLE001 - the next round tries again
            print(f"[leasing-sync] failed: {e}")
        await asyncio.sleep(SYNC_EVERY_SEC)
