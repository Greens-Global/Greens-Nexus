"""Accounting -> Reporting -> Profitability (Charmi, 10/15: "Need to add
Profitability Sheet... it is a major end of year report"; Neil: "we still
need to make ... profitability").

One row per entity (property) for a period, with the same period a year
earlier beside it:

  Revenue, Operating Expenses, NOI, NOI Margin %, Interest Expense,
  Depreciation & Amortization, Net Income, Net Margin %, Debt Service,
  Cash Flow After Debt Service, and the prior year's figures.

Where the figures come from: the accounting app's /api/internal/reports/
buckets with by=entity (the same read the Reports tab's "By Entity" columns
use), through `accounting._acct_get` - Nexus never opens the accounting
database. Every read goes through `_limit` (entity scope, Neil Sep 25): a
person limited to certain entities gets rows for those entities only, and an
entity outside the limit is refused with 403.

Rollup: the accounting app answers one column per PICKED entity (its
sub-entities rolled in), or one per top-level entity when nothing is picked.
"Show Sub-Entities" adds each row's direct children as their own rows under
it; the Totals row adds only the rows that are not inside another row, so a
parent and its child are never counted twice.

ACCOUNT CLASSIFICATION (the Loans review's rule, routers/accounting_loans.py
`noi` / `interest_expense`, so NOI here and NOI on Loans agree):
  - Every account sits in one of the accounting app's P&L sections:
    revenue, other_income (income: credits less debits) and cogs, expense,
    other_expense (costs: debits less credits).
  - Revenue                     = revenue + other_income sections.
  - Interest Expense            = cost-section accounts whose title says
                                  "interest".
  - Depreciation & Amortization = cost-section accounts whose title says
                                  depreciation / amortization (and not
                                  interest).
  - Operating Expenses          = every other cost-section account.
  - NOI                         = Revenue - Operating Expenses.
  - Net Income                  = Revenue - all costs
                                = NOI - Interest - Depreciation & Amortization
                                  (equals the Income Statement's Net Income).
  - Margins                     = NOI / Revenue and Net Income / Revenue
                                  (blank when there is no revenue).
  - Debt Service                = SCHEDULED: the monthly payment (principal and
                                  interest) of every active loan set up under
                                  Loans & Financing for the entity or one of its
                                  sub-entities, times the months in the period
                                  (a part month by its days). Blank when no
                                  loan of the entity has a payment set.
  - Cash Flow After Debt Service = NOI - Debt Service.
"""
import asyncio
import calendar
import re
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import require_module_grant
from routers import accounting, accounting_loans
from routers.accounting import _book, _csv, _limit, entity_scope

router = APIRouter(prefix="/accounting/profitability", tags=["Accounting"],
                   dependencies=[Depends(require_module_grant("accounting", "viewer"))])

_INCOME = ("revenue", "other_income")
_COSTS = ("cogs", "expense", "other_expense")
_INTEREST = re.compile(r"interest", re.I)
_DA = re.compile(r"depreciat|amortiz|amortis", re.I)
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_ROWS = 300


def _r2(v) -> float:
    return round(float(v or 0) + 0.0, 2)


def _day(v: str, what: str) -> str:
    if not v or not _ISO.match(v):
        raise HTTPException(status_code=400, detail=f"{what} must be YYYY-MM-DD")
    try:
        date.fromisoformat(v)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{what} is not a date")
    return v


def year_back(d: str) -> str:
    """The same day a year earlier; February 29 falls back to the 28th."""
    x = date.fromisoformat(d)
    try:
        return x.replace(year=x.year - 1).isoformat()
    except ValueError:
        return x.replace(year=x.year - 1, day=28).isoformat()


def months_in(from_: str, to: str) -> float:
    """Calendar months covered by [from, to]: a whole month counts 1, a part
    month its days over the month's days. January 1 - December 31 = 12."""
    f, t = date.fromisoformat(from_), date.fromisoformat(to)
    if f > t:
        return 0.0
    total = 0.0
    cur = date(f.year, f.month, 1)
    while cur <= t:
        dim = calendar.monthrange(cur.year, cur.month)[1]
        last = date(cur.year, cur.month, dim)
        start, end = max(cur, f), min(last, t)
        total += ((end - start).days + 1) / dim
        cur = last + timedelta(days=1)
    return round(total, 4)


def classify(section: str, title: str) -> Optional[str]:
    """Which profitability line an account feeds: revenue, opex, interest, da;
    None for a balance sheet account."""
    if section in _INCOME:
        return "revenue"
    if section not in _COSTS:
        return None
    if _INTEREST.search(title or ""):
        return "interest"
    if _DA.search(title or ""):
        return "da"
    return "opex"


def measures(accounts: list[dict]) -> dict:
    """The figures of one entity from its accounts [{section, account_no,
    title, debit, credit}] (one row per account). Pure."""
    groups: dict[str, list[dict]] = {"revenue": [], "opex": [], "interest": [], "da": []}
    for a in accounts:
        kind = classify(a.get("section") or "", a.get("title") or "")
        if not kind:
            continue
        debit, credit = float(a.get("debit") or 0), float(a.get("credit") or 0)
        amount = _r2(credit - debit) if kind == "revenue" else _r2(debit - credit)
        if amount == 0:
            continue
        groups[kind].append({"account": str(a.get("account_no") or ""), "title": a.get("title") or "", "amount": amount})
    for g in groups.values():
        g.sort(key=lambda x: x["account"])
    tot = {k: _r2(sum(x["amount"] for x in v)) for k, v in groups.items()}
    noi = _r2(tot["revenue"] - tot["opex"])
    net = _r2(noi - tot["interest"] - tot["da"])
    return {
        "revenue": tot["revenue"], "opex": tot["opex"], "noi": noi, "noiMargin": margin(noi, tot["revenue"]),
        "interest": tot["interest"], "da": tot["da"], "netIncome": net, "netMargin": margin(net, tot["revenue"]),
        "accounts": groups,
    }


def margin(part: float, revenue: float) -> Optional[float]:
    return round(part / revenue * 100, 2) if abs(revenue) >= 0.005 else None


def with_debt(m: dict, debt_service: Optional[float]) -> dict:
    out = {**m, "debtService": debt_service}
    out["cashFlowAfterDebt"] = _r2(m["noi"] - debt_service) if debt_service is not None else None
    return out


def by_entity(rows: list[dict]) -> dict[str, list[dict]]:
    """Bucket rows ({bucket, ...account}) grouped by entity code."""
    out: dict[str, list[dict]] = {}
    for r in rows or []:
        out.setdefault(str(r.get("bucket") or ""), []).append(r)
    return out


def children_of(entities: list[dict], code: str) -> list[str]:
    """The DIRECT sub-entities of `code`: parent_code is it, or Intacct's
    "<code>-1" child-code convention one level down (accounting._with_children's
    rule, one step at a time)."""
    depth = code.count("-")
    out = []
    for e in entities:
        c = e.get("code") or ""
        if not c or c == code:
            continue
        if e.get("parent_code") == code or (c.startswith(f"{code}-") and c.count("-") == depth + 1 and not e.get("parent_code")):
            out.append(c)
    return sorted(out)


def descendants(entities: list[dict], code: str) -> set[str]:
    """`code` and everything under it."""
    out = {code}
    grew = True
    while grew:
        grew = False
        for e in entities:
            c = e.get("code") or ""
            if c and c not in out and (e.get("parent_code") in out or any(c.startswith(f"{x}-") for x in out)):
                out.add(c)
                grew = True
    return out


def top_level(entities: list[dict]) -> list[str]:
    codes = {e.get("code") for e in entities if e.get("code")}
    out = []
    for e in entities:
        c = e.get("code") or ""
        if not c:
            continue
        if e.get("parent_code") in codes:
            continue
        if any(c != x and c.startswith(f"{x}-") for x in codes):
            continue
        out.append(c)
    return sorted(out)


def debt_service_by_entity(loans: list[dict], entities: list[dict], codes: list[str], months: float) -> dict[str, Optional[float]]:
    """Scheduled debt service of each row: the monthly payment of every active
    loan of the entity or its sub-entities, times the months. None when none
    of them has a payment set."""
    out: dict[str, Optional[float]] = {}
    for code in codes:
        reach = descendants(entities, code)
        pays = [float(l.get("monthly_pi") or 0) for l in loans
                if str(l.get("entity_code") or "") in reach and l.get("is_active", True) not in (False, 0, "false")]
        pays = [p for p in pays if p > 0]
        out[code] = _r2(sum(pays) * months) if pays else None
    return out


def change(cur: Optional[float], prior: Optional[float]) -> dict:
    if cur is None or prior is None:
        return {"amount": None, "pct": None}
    amt = _r2(cur - prior)
    return {"amount": amt, "pct": round(amt / abs(prior) * 100, 2) if abs(prior) >= 0.005 else None}


_SUM_KEYS = ("revenue", "opex", "noi", "interest", "da", "netIncome")


def totals(rows: list[dict], key: str) -> dict:
    """Totals over the ROOT rows (a sub-entity row is already inside its
    parent's figures)."""
    roots = [r for r in rows if not r.get("parent")]
    t = {k: _r2(sum((r[key] or {}).get(k) or 0 for r in roots)) for k in _SUM_KEYS}
    ds = [(r[key] or {}).get("debtService") for r in roots]
    t["debtService"] = _r2(sum(d for d in ds if d is not None)) if any(d is not None for d in ds) else None
    t["cashFlowAfterDebt"] = _r2(t["noi"] - t["debtService"]) if t["debtService"] is not None else None
    t["noiMargin"] = margin(t["noi"], t["revenue"])
    t["netMargin"] = margin(t["netIncome"], t["revenue"])
    return t


async def _buckets(from_: str, to: str, location, locations, book) -> dict:
    return await accounting._acct_get("/api/internal/reports/buckets", {
        "from": from_, "to": to, "by": "entity", "location": location, "locations": locations, "book": book,
    })


async def _loans(scope: dict, month: str) -> tuple[list[dict], Optional[str]]:
    try:
        return await accounting_loans._loan_rows(scope, month), None
    except HTTPException as e:
        return [], f"Debt service not read - {e.detail}"


@router.get("")
async def profitability(
    from_: str = Query(alias="from"), to: str = Query(...), locations: Optional[str] = None,
    book: Optional[str] = None, expand: bool = False, compare: bool = True, scope: dict = Depends(entity_scope),
):
    """The Profitability Sheet for [from, to] (see the module docstring for
    every figure). `locations` = the entities picked (comma-separated), none =
    the top-level entities (or the caller's own when limited). `expand` adds
    each row's direct sub-entities. `compare` reads the same window a year
    earlier for the prior-year columns."""
    f, t = _day(from_, "from"), _day(to, "to")
    if f > t:
        raise HTTPException(status_code=400, detail="from must be on or before to")
    b = _book(book)
    location, locs = await _limit(scope, None, locations)
    ents = (await accounting._acct_get("/api/internal/reports/locations", {})).get("entities") or []
    names = {e.get("code"): e.get("name") or "" for e in ents if e.get("code")}
    picked = ([location] if location else []) + _csv(locs)

    roots = picked or top_level(ents)
    rows_meta: list[dict] = [{"code": c, "parent": None} for c in roots]
    if expand:
        seen = set(roots)
        out = []
        for r in rows_meta:
            out.append(r)
            for ch in children_of(ents, r["code"]):
                if ch not in seen:
                    seen.add(ch)
                    out.append({"code": ch, "parent": r["code"]})
        rows_meta = out
    if len(rows_meta) > MAX_ROWS:
        raise HTTPException(status_code=400, detail=f"That is {len(rows_meta)} entities - pick at most {MAX_ROWS}, or turn off Show Sub-Entities.")
    codes = [r["code"] for r in rows_meta]

    # Always ask for the rows by name once there is a list, so the answer has
    # exactly one column per row (none picked + no expand keeps the upstream's
    # own top-level columns, the same read as Reports' By Entity).
    if picked or expand:
        q_loc, q_locs = (codes[0], None) if len(codes) == 1 else (None, ",".join(codes))
    else:
        q_loc, q_locs = None, None
    reads = [_buckets(f, t, q_loc, q_locs, b)]
    pf, pt = year_back(f), year_back(t)
    if compare:
        reads.append(_buckets(pf, pt, q_loc, q_locs, b))
    results = await asyncio.gather(*reads, _loans(scope, t[:7]))
    cur_data = results[0]
    prior_data = results[1] if compare else None
    loans, loan_note = results[-1]

    cur = by_entity(cur_data.get("rows") or [])
    prior = by_entity((prior_data or {}).get("rows") or [])
    labels = {**(prior_data or {}).get("labels", {}), **cur_data.get("labels", {})}
    if not (picked or expand):
        # The upstream's own top-level columns; add any it answered that the
        # entity list did not mark top-level (and keep the order by code).
        codes = sorted(set(codes) | {c for c in list(cur) + list(prior) if c})
        rows_meta = [{"code": c, "parent": None} for c in codes]

    months = months_in(f, t)
    prior_months = months_in(pf, pt)
    ds = debt_service_by_entity(loans, ents, codes, months)
    ds_prior = debt_service_by_entity(loans, ents, codes, prior_months) if compare else {}

    rows = []
    for meta in rows_meta:
        c = meta["code"]
        m = with_debt(measures(cur.get(c, [])), ds.get(c))
        p = with_debt(measures(prior.get(c, [])), ds_prior.get(c)) if compare else None
        if p is not None:
            p.pop("accounts", None)
        rows.append({
            "code": c, "name": names.get(c) or labels.get(c) or c, "parent": meta["parent"],
            "current": m, "prior": p,
            "change": {k: change(m.get(k), (p or {}).get(k)) for k in ("revenue", "noi", "netIncome", "cashFlowAfterDebt")} if p else None,
        })
    # An entity with nothing posted in either year is left out (an empty row
    # helps nobody), unless it was picked by name.
    keep = set(picked)
    rows = [r for r in rows if r["code"] in keep or r["parent"] in keep or any(abs(r["current"][k]) >= 0.005 for k in _SUM_KEYS)
            or (r["prior"] and any(abs(r["prior"][k]) >= 0.005 for k in _SUM_KEYS))]
    tot_cur = totals(rows, "current")
    tot_prior = totals(rows, "prior") if compare else None
    notes = []
    if loan_note:
        notes.append(loan_note)
    if not any(r["current"]["debtService"] is not None for r in rows):
        notes.append("No loan with a monthly payment is set up for these entities under Loans & Financing, so Debt Service is blank.")
    return {
        "from": f, "to": t, "priorFrom": pf if compare else None, "priorTo": pt if compare else None,
        "book": b or "accrual", "months": months, "expand": expand, "org": cur_data.get("org") or "",
        "rows": rows,
        "totals": {"current": tot_cur, "prior": tot_prior,
                   "change": {k: change(tot_cur.get(k), (tot_prior or {}).get(k)) for k in ("revenue", "noi", "netIncome", "cashFlowAfterDebt")} if compare else None},
        "notes": notes,
    }
