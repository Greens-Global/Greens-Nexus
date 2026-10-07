"""Accounting -> Reporting -> MRE, Monthly Recurring Expenses (Oct 6: Neil
listed MRE as pending; Charmi wants it under Reporting next to MRI).

The expense-side mirror of MRI's Leasing. A RECURRING EXPENSE is one vendor
(an Intacct vendor) that one entity pays from the same expense account(s) on
a schedule - monthly, quarterly or annually - with the amount expected each
time: utilities, insurance, payroll services, software, rent paid, other.
Debt service is left out on purpose: Loans & Financing covers it.

What was PAID is never keyed: it is what posted to the line's expense
accounts for that vendor in that month (debit - credit), read from the ledger
through the accounting app's internal API - one buckets by=month read per
(entity, vendor), every one through `_limit`. The grid compares it with what
the line expects that month: paid / short / over / missed / upcoming, and a
Balance (expected - paid, to date).

"+ Add -> From the Ledger" proposes the lines: for every ACTIVE leaf entity
the caller may read (historical (H) entities are left out - the same rule as
the Reports Entities picker, reportModel.isHistoricalEntity - and a parent
rolls its children up, so only leaves are read), the expense accounts on its
P&L (never interest / loan / mortgage / principal, never depreciation), the
vendors who posted to them in the last twelve months, and the month-by-month
amounts. A vendor qualifies when at least N months (default 3) posted within
10% of the expected amount; expected = the most common amount of the last
three posted months, a tie going to the latest (MRI's rent heuristic). The
scan is a background job (accounting_loans.scan_job), polled with progress,
like the leases scan; every ledger read in it is async HTTP pushed to a
thread by accounting._acct_get, and the database reads run in
asyncio.to_thread.

Access: the Accounting grant (viewer reads, editor changes, full deletes); a
person limited to certain entities reads and edits only the lines of those.
"""
import asyncio
import re
import uuid
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import models
from auth import require_module_grant
from database import SessionLocal
from routers import accounting, accounting_partners, acct_scan
from routers.accounting import _csv, _limit, entity_scope
from routers.accounting_loans import ScanJob, _entities, _sem, forget_jobs, gather_tolerant, leaf_entities, month_bounds, scan_job, scan_result, shift_month

router = APIRouter(prefix="/accounting/mre", tags=["Accounting"], dependencies=[Depends(require_module_grant("accounting", "viewer"))])
_edit = require_module_grant("accounting", "editor")
_full = require_module_grant("accounting", "full")

_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FREQUENCIES = {"monthly": 1, "quarterly": 3, "annual": 12}
CATEGORIES = ("utilities", "insurance", "payroll_services", "software", "rent_paid", "other")
_COSTS = ("cogs", "expense", "other_expense")
# Debt service is Loans & Financing's; depreciation and amortization are
# journal entries, never a vendor's bill.
_NOT_MRE = re.compile(r"interest|\bloans?\b|mortgage|principal|notes? payable|debt service|depreciation|amorti[sz]ation")
_POSTED = 0.5         # dollars: below this a month did not post
_STABLE = 0.10        # a month within 10% of the expected amount counts as "the same amount"
DEFAULT_MIN = 3

_CATEGORY_WORDS = [
    ("utilities", re.compile(r"utilit|electric|\bgas\b|water|sewer|trash|waste|power|energy|internet|telephone|\bphone|telecom|cable|sdg&e|edison|pg&e")),
    ("insurance", re.compile(r"insur")),
    ("payroll_services", re.compile(r"payroll|\badp\b|paychex|gusto|paylocity|\bpeo\b")),
    ("software", re.compile(r"software|subscription|saas|licen[cs]e|microsoft|google|adobe|intuit|quickbooks|amazon web|\baws\b|cloud|zoom|slack|dues and sub")),
    ("rent_paid", re.compile(r"\brent\b|\blease\b|leasing|occupancy")),
]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _r2(v) -> float:
    return round(float(v or 0) + 0.0, 2)


# ── The arithmetic (pure) ────────────────────────────────────────────────────
def is_historical(e: dict) -> bool:
    """A historical entity: "(H)" in its name or an H before its number
    (H12001) - the frontend's isHistoricalEntity, kept in step."""
    return bool(re.search(r"\(\s*H\s*\)", e.get("name") or "", re.I) or re.match(r"^H\d", e.get("code") or "", re.I))


def active_leaves(entities: list[dict]) -> tuple[list[dict], int]:
    """(the active leaf entities, how many parents were left out)."""
    return leaf_entities([e for e in entities if not is_historical(e)])


def expense_accounts(pnl_accounts: list[dict]) -> list[dict]:
    """The P&L accounts a recurring bill posts to: cost of sales and expense
    accounts, never debt service or depreciation."""
    return [a for a in pnl_accounts if a.get("section") in _COSTS and not _NOT_MRE.search((a.get("title") or "").lower())]


def guess_category(titles: list[str], vendor_name: str) -> str:
    text = " ".join([*(titles or []), vendor_name or ""]).lower()
    for key, rx in _CATEGORY_WORDS:
        if rx.search(text):
            return key
    return "other"


def typical_amount(monthly: dict[str, float]) -> Optional[float]:
    """The most common amount of the last three posted months; a tie goes to
    the latest month (MRI's rent heuristic: a price that just went up is the
    price now)."""
    posted = sorted((m, _r2(v)) for m, v in monthly.items() if v > _POSTED)
    if not posted:
        return None
    last = posted[-3:]
    counts = Counter(v for _m, v in last)
    best = max(counts.values())
    for _m, v in reversed(last):
        if counts[v] == best:
            return v
    return last[-1][1]


def stable_months(monthly: dict[str, float], expected: Optional[float]) -> int:
    """How many posted months were within 10% of the expected amount."""
    if not expected:
        return 0
    return sum(1 for v in monthly.values() if v > _POSTED and abs(v - expected) <= _STABLE * expected)


def _month_index(m: str) -> int:
    return int(m[:4]) * 12 + int(m[5:7]) - 1


def guess_frequency(posted: list[str]) -> str:
    """Monthly when the posted months sit about a month apart, quarterly when
    about three; one posting a year is annual."""
    if len(posted) < 2:
        return "annual"
    idx = sorted(_month_index(m) for m in posted)
    gaps = sorted(b - a for a, b in zip(idx, idx[1:]))
    mid = gaps[len(gaps) // 2]
    if mid <= 1:
        return "monthly"
    if mid <= 4:
        return "quarterly"
    return "annual"


def propose(entity: dict, accounts: list[dict], by_vendor: dict[str, dict[str, dict[str, float]]], names: dict[str, str], min_count: int = DEFAULT_MIN) -> list[dict]:
    """One proposal per vendor that posted at least `min_count` months at a
    stable amount. `by_vendor` is {vendor: {'YYYY-MM': {gl: amount}}}."""
    titles = {a["account_no"]: a["title"] for a in accounts}
    out = []
    for vendor, months in by_vendor.items():
        monthly = {m: _r2(sum(cell.values())) for m, cell in months.items()}
        posted = sorted(m for m, v in monthly.items() if v > _POSTED)
        if not posted:
            continue
        expected = typical_amount(monthly)
        stable = stable_months(monthly, expected)
        if stable < max(1, min_count):
            continue
        used = sorted({gl for cell in months.values() for gl, v in cell.items() if abs(v) > _POSTED and gl in titles})
        name = names.get(vendor) or vendor
        out.append({
            "entityCode": entity["code"], "entityName": entity.get("name") or entity["code"], "vendorId": vendor, "vendorName": name,
            "expenseAccounts": used, "accountTitles": [titles[g] for g in used],
            "expectedAmount": expected, "frequency": guess_frequency(posted), "category": guess_category([titles[g] for g in used], name),
            "firstMonth": posted[0], "lastMonth": posted[-1], "postedMonths": len(posted), "stableMonths": stable,
            "paid12": _r2(sum(v for v in monthly.values() if v > _POSTED)),
            "monthly": [{"month": m, "amount": monthly[m]} for m in sorted(monthly)],
        })
    return sorted(out, key=lambda p: (p["entityName"], p["vendorName"]))


def due_in_month(line: dict, year: int, month: int) -> bool:
    """Whether the line falls due in this calendar month: inside its start /
    end, and on its frequency counted from the start month."""
    start, end = line.get("startDate") or "", line.get("endDate") or ""
    key = f"{year}-{month:02d}"
    if start and key < start[:7]:
        return False
    if end and key > end[:7]:
        return False
    if line.get("status") == "ended" and not end:
        return False
    step = FREQUENCIES.get(line.get("frequency") or "monthly", 1)
    if step == 1 or not start:
        return True
    return (_month_index(key) - _month_index(start[:7])) % step == 0


def month_status(due: bool, expected: float, paid: float, key: str, this_month: str) -> str:
    """paid | short | over | missed | upcoming | none."""
    tol = max(0.5, abs(expected) * 0.01)
    if not due:
        return "over" if paid > _POSTED else "none"
    if abs(paid - expected) <= tol:
        return "paid"
    if paid > expected + tol:
        return "over"
    if key >= this_month:
        return "upcoming"     # the month is not over yet (or still ahead)
    return "short" if paid > _POSTED else "missed"


def grid(lines: list[dict], payments: dict, year: int, today: date, unread: Optional[set] = None) -> dict:
    """The year, line by line and month by month. `payments` is
    {(entity, vendor): {'YYYY-MM': {gl: debit - credit}}}; `unread` holds the
    (entity, vendor) pairs the ledger could not answer for."""
    unread = unread or set()
    this_month = today.isoformat()[:7]
    rows = []
    totals = [{"month": f"{year}-{m:02d}", "expected": 0.0, "paid": 0.0} for m in range(1, 13)]
    for line in lines:
        pair = (line["entityCode"], line["vendorId"])
        posted = payments.get(pair, {})
        accounts = set(line["expenseAccounts"])
        cells, expected_to_date, paid_to_date, paid_year, missed = [], 0.0, 0.0, 0.0, 0
        for m in range(1, 13):
            key = f"{year}-{m:02d}"
            due = due_in_month(line, year, m)
            expected = _r2(line["expectedAmount"]) if due else 0.0
            paid = _r2(sum(v for gl, v in posted.get(key, {}).items() if gl in accounts))
            if pair in unread:
                status = "upcoming" if key > this_month else ("unknown" if due else "none")
            else:
                status = month_status(due, expected, paid, key, this_month)
            cells.append({"month": key, "due": due, "expected": expected, "paid": paid, "status": status})
            paid_year = _r2(paid_year + paid)
            totals[m - 1]["expected"] = _r2(totals[m - 1]["expected"] + expected)
            totals[m - 1]["paid"] = _r2(totals[m - 1]["paid"] + paid)
            if status in ("paid", "short", "over", "missed"):
                expected_to_date = _r2(expected_to_date + expected)
                paid_to_date = _r2(paid_to_date + paid)
            if status == "missed":
                missed += 1
        rows.append({"line": line, "months": cells, "paidTotal": paid_year, "expectedYear": _r2(sum(c["expected"] for c in cells)),
                     "expectedToDate": expected_to_date, "paidToDate": paid_to_date, "balance": _r2(expected_to_date - paid_to_date),
                     "monthsMissed": missed, "unread": pair in unread})
    return {"year": year, "asOf": today.isoformat(), "rows": rows, "totals": totals,
            "summary": {"lines": len([r for r in rows if r["line"]["status"] == "active"]),
                        "expectedToDate": _r2(sum(r["expectedToDate"] for r in rows)),
                        "paidToDate": _r2(sum(r["paidToDate"] for r in rows)),
                        "balance": _r2(sum(r["balance"] for r in rows)),
                        "missed": sum(1 for r in rows if r["monthsMissed"])}}


# ── Shapes and the lines themselves ──────────────────────────────────────────
def _line_out(r: models.RecurringExpense) -> dict:
    return {
        "id": r.id, "entityCode": r.entity_code or "", "entityName": r.entity_name or r.entity_code or "", "vendorId": r.vendor_id or "",
        "vendorName": r.vendor_name or r.vendor_id or "", "expenseAccounts": list(r.expense_accounts) if isinstance(r.expense_accounts, list) else [],
        "category": r.category if r.category in CATEGORIES else "other", "frequency": r.frequency if r.frequency in FREQUENCIES else "monthly",
        "expectedAmount": _r2(r.expected_amount), "startDate": r.start_date or "", "endDate": r.end_date or "",
        "status": r.status or "active", "notes": r.notes or "", "source": r.source or "manual",
        "updatedBy": r.updated_by or "", "updatedAt": r.updated_at or "",
    }


class LineBody(BaseModel):
    entityCode: str
    entityName: Optional[str] = ""
    vendorId: str
    vendorName: Optional[str] = ""
    expenseAccounts: list[str]
    category: Optional[str] = "other"
    frequency: Optional[str] = "monthly"
    expectedAmount: float = 0
    startDate: Optional[str] = ""
    endDate: Optional[str] = ""
    status: Optional[str] = "active"
    notes: Optional[str] = ""


def _clean(body: LineBody) -> dict:
    entity = (body.entityCode or "").strip()
    vendor = (body.vendorId or "").strip()
    if not entity:
        raise HTTPException(status_code=400, detail="Pick the entity that pays it.")
    if not vendor:
        raise HTTPException(status_code=400, detail="Pick the vendor.")
    accounts = list(dict.fromkeys(str(a).strip() for a in (body.expenseAccounts or []) if str(a).strip()))[:10]
    if not accounts:
        raise HTTPException(status_code=400, detail="Name at least one expense account (GL code).")
    if body.frequency not in FREQUENCIES:
        raise HTTPException(status_code=400, detail="Frequency is monthly, quarterly or annual.")
    if body.category not in CATEGORIES:
        raise HTTPException(status_code=400, detail="Pick a category.")
    if (body.expectedAmount or 0) < 0:
        raise HTTPException(status_code=400, detail="The expected amount cannot be negative.")
    for label, v in (("Start", body.startDate), ("End", body.endDate)):
        if v and not _ISO.match(v):
            raise HTTPException(status_code=400, detail=f"{label} must be a date (YYYY-MM-DD).")
    if body.startDate and body.endDate and body.endDate < body.startDate:
        raise HTTPException(status_code=400, detail="It ends before it starts.")
    return {
        "entity_code": entity[:40], "entity_name": (body.entityName or "").strip()[:200], "vendor_id": vendor[:60], "vendor_name": (body.vendorName or "").strip()[:200],
        "expense_accounts": accounts, "category": body.category, "frequency": body.frequency, "expected_amount": float(body.expectedAmount or 0),
        "start_date": body.startDate or "", "end_date": body.endDate or "", "status": body.status if body.status in ("active", "ended") else "active",
        "notes": (body.notes or "")[:1000],
    }


def _load_all() -> list[dict]:
    db = SessionLocal()
    try:
        rows = db.query(models.RecurringExpense).order_by(models.RecurringExpense.vendor_name, models.RecurringExpense.entity_code).all()
        return [_line_out(r) for r in rows]
    finally:
        db.close()


async def _reach(scope: dict) -> Optional[set]:
    """Entity codes the caller may read, or None when they are not limited."""
    if scope["allowed"] is None:
        return None
    return await accounting._with_children(scope["allowed"]) if scope["allowed"] else set()


async def _must_reach(scope: dict, entity_code: str) -> None:
    reach = await _reach(scope)
    if reach is not None and (entity_code or "") not in reach:
        raise HTTPException(status_code=403, detail="Your accounting access does not include that entity.")


async def _picked(scope: dict, entities: Optional[str]) -> Optional[set]:
    """The entity codes asked for, with their sub-entities - None for all.
    Checked against the caller's limit first (403 outside it)."""
    codes = _csv(entities)
    if not codes:
        return None
    await _limit(scope, None, ",".join(codes))
    return await accounting._with_children(set(codes))


# ── Ledger reads (every one through _limit) ──────────────────────────────────
async def _buckets(scope: dict, entity: str, by: str, from_: str, to: str, vendor: Optional[str] = None) -> dict:
    location, _ = await _limit(scope, entity, None)
    async with _sem():
        return await accounting._acct_get("/api/internal/reports/buckets", {"from": from_, "to": to, "by": by, "location": location, "vendor": vendor})


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


def _spent(r: dict) -> float:
    return _r2(r.get("debit")) - _r2(r.get("credit"))


async def _vendor_months(scope: dict, entity: str, vendor: str, from_: str, to: str, codes: Optional[set] = None) -> dict[str, dict[str, float]]:
    """{'YYYY-MM': {gl: debit - credit}} for one vendor on one entity."""
    data = await _buckets(scope, entity, "month", from_, to, vendor)
    out: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for r in data.get("rows") or []:
        gl = str(r.get("account_no") or "")
        if r.get("bucket") and gl and (codes is None or gl in codes):
            out[str(r["bucket"])[:7]][gl] = _r2(out[str(r["bucket"])[:7]][gl] + _spent(r))
    return {m: dict(c) for m, c in out.items()}


def _window() -> tuple[str, str, list[str]]:
    this = date.today().isoformat()[:7]
    months = [shift_month(this, back) for back in range(11, -1, -1)]
    return month_bounds(months[0])[0], month_bounds(this)[1], months


async def _scan_entity(scope: dict, e: dict, min_count: int) -> dict:
    from_, to, months = _window()
    accounts = expense_accounts(await _pnl_accounts(scope, e["code"], from_, to))
    if not accounts:
        return {"entity": e, "accounts": 0, "proposals": []}
    codes = {a["account_no"] for a in accounts}
    data = await _buckets(scope, e["code"], "vendor", from_, to)
    labels = data.get("labels") or {}
    totals: dict[str, float] = defaultdict(float)
    for r in data.get("rows") or []:
        if r.get("bucket") and str(r.get("account_no")) in codes:
            totals[str(r["bucket"])] += _spent(r)
    vendors = sorted(v for v, t in totals.items() if t > _POSTED)
    by_vendor: dict[str, dict[str, dict[str, float]]] = {}
    if len(vendors) > len(months):
        # Many vendors: one by=vendor read per month (12) costs less than one
        # by=month read per vendor - the accounting app answers about two
        # reads a second whatever the parallelism, so reads are the scan's time.
        wanted = set(vendors)
        parts = await asyncio.gather(*[_buckets(scope, e["code"], "vendor", *month_bounds(m)) for m in months])
        for m, part in zip(months, parts):
            for r in part.get("rows") or []:
                v, gl = str(r.get("bucket") or ""), str(r.get("account_no") or "")
                if v in wanted and gl in codes:
                    cell = by_vendor.setdefault(v, {}).setdefault(m, {})
                    cell[gl] = _r2(cell.get(gl, 0) + _spent(r))
    else:
        parts = await asyncio.gather(*[_vendor_months(scope, e["code"], v, from_, to, codes) for v in vendors])
        by_vendor = dict(zip(vendors, parts))
    names = {v: str(labels.get(v) or "") for v in vendors}
    return {"entity": e, "accounts": len(accounts), "proposals": propose(e, accounts, by_vendor, names, min_count)}


def _scan_key(scope: dict, min_count: int, picked: Optional[set]) -> tuple:
    from_, to, _ = _window()
    return (scope["user"]["email"], "mre", from_, to, min_count, tuple(sorted(picked)) if picked else ())


_AGG_CHUNK = 200   # the op answers twelve months of every entity in about 1.2 s


def parts_from_aggregate(rows: list[dict], entities: list[dict], min_count: int) -> list[dict]:
    """The aggregate op's rows (party = vendor) as scan parts: per entity, the
    expense accounts posted to and one proposal per stable vendor."""
    by_code = {e["code"]: e for e in entities}
    accts: dict[str, dict[str, dict]] = defaultdict(dict)
    by_vendor: dict[str, dict[str, dict[str, dict[str, float]]]] = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: defaultdict(float))))
    names: dict[str, dict[str, str]] = defaultdict(dict)
    for r in rows:
        ent, gl, vendor = str(r.get("entity") or ""), str(r.get("account_no") or ""), str(r.get("party") or "")
        acct = {"section": r.get("section") or "", "account_no": gl, "title": r.get("title") or ""}
        if ent not in by_code or not gl or not vendor or not expense_accounts([acct]):
            continue
        accts[ent].setdefault(gl, acct)
        cell = by_vendor[ent][vendor][str(r.get("month") or "")[:7]]
        cell[gl] = _r2(cell[gl] + _spent(r))
        if r.get("party_name"):
            names[ent][vendor] = str(r["party_name"])
    out = []
    for ent, e in by_code.items():
        vendors = {v: {m: dict(c) for m, c in months.items()} for v, months in by_vendor.get(ent, {}).items()
                   if sum(sum(c.values()) for c in months.values()) > _POSTED}
        out.append({"entity": e, "accounts": len(accts.get(ent, {})), "proposals": propose(e, list(accts.get(ent, {}).values()), vendors, names.get(ent, {}), min_count)})
    return out


async def _aggregate(scope: dict, entities: list[dict], min_count: int, deadline: acct_scan.Deadline) -> tuple[list[dict], list[dict]]:
    """(parts read through the aggregate op, the entities it did not answer for)."""
    if not entities or not acct_scan.aggregate_available():
        return [], entities
    from_, to, _ = _window()
    chunks = [entities[i:i + _AGG_CHUNK] for i in range(0, len(entities), _AGG_CHUNK)]

    async def read(chunk: list[dict]):
        codes = [e["code"] for e in chunk]
        await _limit(scope, None, ",".join(codes))
        async with _sem():
            # Every expense section; debt service and depreciation are left out here (expense_accounts).
            return await acct_scan.party_months(codes, from_, to, "vendor", sections=list(_COSTS))
    got = await acct_scan.bounded([(lambda c=c: read(c)) for c in chunks], deadline)
    parts, rest = [], []
    for chunk, (ok, rows) in zip(chunks, got):
        if ok and rows is not None:
            parts += parts_from_aggregate(rows, chunk, min_count)
        else:
            rest += chunk
    return parts, rest


async def _scan(scope: dict, min_count: int, picked: Optional[set], job: Optional[ScanJob] = None) -> dict:
    """Oct 7 (Charmi: stuck at 133 of 142 entities for 5+ minutes): the
    aggregate op when the accounting app answers it; otherwise one entity at
    a time, each under a hard ceiling and the whole scan under a deadline. An
    entity not read in time is listed in `failed` (Retry reads just those) and
    the rest is shown - never an endless bar."""
    from_, to, _ = _window()
    every = await _entities(scope)
    historical = sum(1 for e in every if is_historical(e))
    if picked is not None:
        every = [e for e in every if e["code"] in picked]
    entities, parents = active_leaves(every)
    if job:
        job.total = len(entities)
    deadline = acct_scan.Deadline()
    parts, rest = await _aggregate(scope, entities, min_count, deadline)
    if job:
        job.done += len(entities) - len(rest)
    got = await acct_scan.bounded([(lambda e=e: _scan_entity(scope, e, min_count)) for e in rest], deadline, on_done=job.tick if job else None)
    failed = []
    for e, (ok, p) in zip(rest, got):
        if ok:
            parts.append(p)
        else:
            failed.append(acct_scan.failure(e, p))
    failed.sort(key=lambda f: (f["name"], f["code"]))
    out: dict[str, Any] = {
        "notes": [],
        "from": from_, "to": to, "minCount": min_count, "entitiesScanned": len(entities), "parentsSkipped": parents, "historicalSkipped": historical,
        "entitiesRead": len(entities) - len(failed), "failed": failed, "status": acct_scan.status_text(len(entities), failed),
        "source": "scan" if len(rest) == len(entities) else ("aggregate" if not rest else "mixed"),
        "entitiesWithExpenses": sum(1 for p in parts if p["accounts"]),
        "proposals": [x for p in parts for x in p["proposals"]],
    }
    if job:
        job.cacheable = not failed
    return out


def _set_up() -> dict[tuple[str, str], str]:
    db = SessionLocal()
    try:
        rows = db.query(models.RecurringExpense).filter(models.RecurringExpense.status == "active").all()
        return {((r.entity_code or ""), (r.vendor_id or "")): r.id for r in rows if r.vendor_id}
    finally:
        db.close()


def _with_status(scan: dict, have: dict) -> dict:
    rows = [{**p, "status": "set_up" if have.get((p["entityCode"], p["vendorId"])) else "new", "lineId": have.get((p["entityCode"], p["vendorId"]))} for p in scan["proposals"]]
    return {**scan, "proposals": rows, "setUp": sum(1 for r in rows if r["status"] == "set_up"), "missing": sum(1 for r in rows if r["status"] == "new")}


def _min(v: Optional[int]) -> int:
    n = DEFAULT_MIN if v is None else int(v)
    if not 1 <= n <= 12:
        raise HTTPException(status_code=400, detail="min is between 1 and 12 months.")
    return n


async def _inactive_vendors() -> set[str]:
    """The vendors Intacct marks inactive (Customize > Show Inactive Vendors),
    from the records Vendors & Customers reads. Unreadable = none: the grid
    never fails over it."""
    try:
        raw = await accounting_partners._get({"kind": "vendor"})
    except Exception:  # noqa: BLE001 - not connected, not built yet, or down: nothing is inactive
        return set()
    out = set()
    for p in raw:
        if isinstance(p, dict):
            rec = accounting_partners._record(p)
            if rec["id"] and str(rec["status"]).strip().lower() in ("inactive", "false", "0", "no", "disabled"):
                out.add(rec["id"])
    return out


# ── Endpoints ────────────────────────────────────────────────────────────────
@router.get("/grid")
async def get_grid(year: Optional[int] = None, entities: Optional[str] = None, scope: dict = Depends(entity_scope)):
    """Expected against paid, every recurring expense, every month of a year."""
    today = date.today()
    year = year or today.year
    if not 2000 <= year <= today.year + 1:
        raise HTTPException(status_code=400, detail="Pick a year up to next year.")
    picked = await _picked(scope, entities)
    reach = await _reach(scope)
    lines = [l for l in await asyncio.to_thread(_load_all)
             if (reach is None or l["entityCode"] in reach) and (picked is None or l["entityCode"] in picked)]
    # The ledger is read only for lines in force some time this year.
    first, last = f"{year}-01", f"{year}-12"
    live = [l for l in lines if not (l["endDate"] and l["endDate"][:7] < first) and not (l["startDate"] and l["startDate"][:7] > last)
            and not (l["status"] == "ended" and not l["endDate"])]
    pairs = sorted({(l["entityCode"], l["vendorId"]) for l in live})
    parts, notes = await gather_tolerant([(lambda p=p: _vendor_months(scope, p[0], p[1], f"{year}-01-01", f"{year}-12-31")) for p in pairs],
                                         [f"{v} at {e}" for e, v in pairs], lambda: None)
    payments = {p: part for p, part in zip(pairs, parts) if part is not None}
    unread = {p for p, part in zip(pairs, parts) if part is None}
    out = grid(lines, payments, year, today, unread)
    inactive = await _inactive_vendors() if lines else set()
    for r in out["rows"]:
        r["vendorInactive"] = r["line"]["vendorId"] in inactive
    if notes:
        out["warning"] = (f"Payments could not be read from the ledger for {len(unread)} of {len(pairs)} "
                          f"{'line' if len(pairs) == 1 else 'lines'} ({notes[0].split(': ', 1)[-1]}). Expected amounts are shown; paid is not.")
    return out


@router.get("/vendors/{vendor_id}")
async def vendor_card(vendor_id: str, scope: dict = Depends(entity_scope)):
    """Name, phone, email and address of one vendor, for the hover card - the
    records Accounting > Vendors & Customers reads (accounting_partners)."""
    vid = (vendor_id or "").strip()[:60]
    try:
        raw = await accounting_partners._get({"kind": "vendor", "q": vid})
    except HTTPException as e:
        if e.status_code in (501, 503):
            return {"available": False, "vendor": None}
        raise
    records = [accounting_partners._record(p) for p in raw if isinstance(p, dict)]
    reach = await _reach(scope)
    if reach is not None:
        records = [r for r in records if not r["entity"] or r["entity"] in reach]
    hit = next((r for r in records if r["id"] == vid), None) or next((r for r in records if vid.lower() in (r["name"] or "").lower()), None)
    return {"available": True, "vendor": hit}


@router.post("/lines", status_code=201)
async def create_line(body: LineBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    fields = _clean(body)
    await _must_reach(scope, fields["entity_code"])
    return await asyncio.to_thread(_save, None, fields, user, "manual")


def _save(line_id: Optional[str], fields: dict, user: dict, source: str = "manual") -> dict:
    db = SessionLocal()
    try:
        now = _now()
        if line_id:
            row = db.query(models.RecurringExpense).filter(models.RecurringExpense.id == line_id).first()
            if not row:
                raise HTTPException(status_code=404, detail="Recurring expense not found.")
        else:
            row = models.RecurringExpense(id=str(uuid.uuid4()), created_by=user["email"], created_at=now, source=source)
            db.add(row)
        for k, v in fields.items():
            setattr(row, k, v)
        row.updated_by, row.updated_at = user["email"], now
        db.commit()
        return _line_out(row)
    finally:
        db.close()


def _entity_of(line_id: str) -> str:
    db = SessionLocal()
    try:
        row = db.query(models.RecurringExpense).filter(models.RecurringExpense.id == line_id).first()
        if not row:
            raise HTTPException(status_code=404, detail="Recurring expense not found.")
        return row.entity_code or ""
    finally:
        db.close()


@router.put("/lines/{line_id}")
async def update_line(line_id: str, body: LineBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    fields = _clean(body)
    await _must_reach(scope, await asyncio.to_thread(_entity_of, line_id))
    await _must_reach(scope, fields["entity_code"])
    return await asyncio.to_thread(_save, line_id, fields, user)


class NotesBody(BaseModel):
    notes: Optional[str] = ""


@router.put("/lines/{line_id}/notes")
async def set_notes(line_id: str, body: NotesBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    """The Notes column, edited in place."""
    await _must_reach(scope, await asyncio.to_thread(_entity_of, line_id))
    return await asyncio.to_thread(_save, line_id, {"notes": (body.notes or "").strip()[:1000]}, user)


class EndBody(BaseModel):
    endDate: Optional[str] = ""


@router.post("/lines/{line_id}/end")
async def end_line(line_id: str, body: EndBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    """A bill that stopped is ended - kept with its history, never deleted."""
    end = body.endDate or date.today().isoformat()
    if not _ISO.match(end):
        raise HTTPException(status_code=400, detail="The end date must be a date (YYYY-MM-DD).")
    await _must_reach(scope, await asyncio.to_thread(_entity_of, line_id))
    return await asyncio.to_thread(_save, line_id, {"status": "ended", "end_date": end}, user)


@router.delete("/lines/{line_id}", status_code=204)
async def delete_line(line_id: str, user: dict = Depends(_full), scope: dict = Depends(entity_scope)):
    """For a line entered by mistake. A bill that stopped is ENDED."""
    await _must_reach(scope, await asyncio.to_thread(_entity_of, line_id))

    def work():
        db = SessionLocal()
        try:
            db.query(models.RecurringExpense).filter(models.RecurringExpense.id == line_id).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()
    await asyncio.to_thread(work)


@router.get("/from-ledger/proposals")
async def proposals(min: Optional[int] = None, entities: Optional[str] = None, scope: dict = Depends(entity_scope)):  # noqa: A002 - the query name
    """One proposed line per (active leaf entity, vendor) that posted to an
    expense account at a stable amount in at least `min` of the last twelve
    months; vendors already on an active line are marked set up. The scan
    runs in the background: 202 with the progress until it is done."""
    n = _min(min)
    picked = await _picked(scope, entities)
    job = scan_job(_scan_key(scope, n, picked), lambda job: _scan(scope, n, picked, job))
    if job.result is None:
        return JSONResponse(status_code=202, content=job.progress())
    return _with_status(job.result, await asyncio.to_thread(_set_up))


class CreateItem(BaseModel):
    entityCode: str
    vendorId: str
    category: Optional[str] = None


class CreateBody(BaseModel):
    items: list[CreateItem]
    min: Optional[int] = None
    entities: Optional[str] = None


@router.post("/from-ledger/create", status_code=201)
async def create_from_ledger(body: CreateBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    """Write the ticked proposals as lines - the same validation and save as
    Manual. A vendor already on an active line for the entity is skipped,
    never duplicated (idempotent)."""
    if not body.items:
        raise HTTPException(status_code=400, detail="Tick at least one expense to add.")
    n = _min(body.min)
    picked = await _picked(scope, body.entities)
    for it in body.items:
        await _must_reach(scope, it.entityCode.strip())
    # The proposals from the scans already run (the full one and any Retry of
    # the entities it could not read); only what is still missing is scanned.
    by_key = {}
    for res in acct_scan.finished_results(scope["user"]["email"], "mre"):
        if res.get("minCount") == n:
            by_key.update({(p["entityCode"], p["vendorId"]): p for p in res["proposals"]})
    missing = {it.entityCode.strip() for it in body.items if (it.entityCode.strip(), it.vendorId.strip()) not in by_key}
    if missing or not by_key:
        again = missing if by_key else picked
        scan = await scan_result(_scan_key(scope, n, again), lambda job: _scan(scope, n, again, job))
        by_key.update({(p["entityCode"], p["vendorId"]): p for p in scan["proposals"]})
    have = await asyncio.to_thread(_set_up)
    created, skipped = [], []
    for it in body.items:
        key = (it.entityCode.strip(), it.vendorId.strip())
        p = by_key.get(key)
        if not p:
            skipped.append({"entityCode": key[0], "vendorId": key[1], "why": "no recurring postings for this vendor on the ledger"})
            continue
        if key in have:
            skipped.append({"entityCode": key[0], "vendorId": key[1], "why": "already set up"})
            continue
        fields = _clean(LineBody(
            entityCode=p["entityCode"], entityName=p["entityName"], vendorId=p["vendorId"], vendorName=p["vendorName"], expenseAccounts=p["expenseAccounts"],
            category=it.category if it.category in CATEGORIES else p["category"], frequency=p["frequency"], expectedAmount=p["expectedAmount"] or 0,
            startDate=f"{p['firstMonth']}-01", notes=f"Set up from the ledger: posted {p['postedMonths']} of 12 months, {p['stableMonths']} at the expected amount.",
        ))
        line = await asyncio.to_thread(_save, None, fields, user, "ledger")
        have[key] = line["id"]
        created.append({**p, "lineId": line["id"]})
    forget_jobs(user["email"], "mre")
    return {"created": created, "skipped": skipped}
