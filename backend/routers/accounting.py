from fastapi import APIRouter, Depends, HTTPException, Query
from auth import require_module_grant

# Grant-driven (Jun 17): a manager role no longer opens Accounting by itself -
# it needs an "accounting" Access Group grant (or IT Admin+). The router has no
# per-endpoint read/write split, so a grant = full accounting access; grant it
# only to finance people.
router = APIRouter(prefix="/accounting", tags=["Accounting"], dependencies=[Depends(require_module_grant("accounting", "viewer"))])

# The old mock endpoints (/transactions, /ramp, /ama - seeded demo rows, never
# real data) were removed Sep 8. Only ledger-backed reports live here now.

# ── Reports from Greens Accounting (Supabase mirror of the Intacct ledger) ──
# Nexus never talks to Intacct or to the accounting database directly: the
# accounting app exposes read-only /api/internal/reports/* behind a hashed
# x-internal-api-key, and this proxy calls it over HTTP (Egnyte/Ramp shape,
# NOT a second DB engine). Outbound HTTP runs in a thread so the event loop
# never blocks (see the Aug 2 freeze note in CLAUDE.md). 5-minute cache keyed
# by the query so a dashboard full of widgets costs one upstream call.
import asyncio
import json
import os
import re
import time

import httpx

_ACCT_BASE = os.environ.get("ACCOUNTING_BASE_URL", "").rstrip("/")
_ACCT_KEY = os.environ.get("ACCOUNTING_INTERNAL_KEY", "")
_ACCT_CACHE: dict[str, tuple[float, dict]] = {}
_ACCT_TTL = 300.0


def _upstream_detail(r) -> str:
    """Why the accounting app refused, in words. It answers errors as
    {"ok": false, "error": "..."}; a bare "returned 500" told nobody anything
    (Charmi, Sep 25: a search failed and the screen could not say why)."""
    try:
        msg = (r.json() or {}).get("error") or ""
    except Exception:  # noqa: BLE001 - the body may not be JSON
        msg = ""
    if "statement timeout" in msg or "canceling statement" in msg:
        return "That covers too many ledger lines to finish in time. Add a word, pick an entity, or narrow the dates."
    if msg:
        return f"Accounting service: {msg}"[:300]
    return f"Accounting service returned {r.status_code}"


def _acct_get_sync(path: str, params: dict) -> dict:
    r = httpx.get(
        f"{_ACCT_BASE}{path}",
        params=params,
        headers={"x-internal-api-key": _ACCT_KEY},
        timeout=30,
    )
    if r.status_code != 200:
        raise HTTPException(status_code=424, detail=_upstream_detail(r))
    data = r.json()
    if not data.get("ok"):
        raise HTTPException(status_code=424, detail=data.get("error") or "Accounting service error")
    return data


async def _acct_get(path: str, params: dict) -> dict:
    if not _ACCT_BASE or not _ACCT_KEY:
        raise HTTPException(status_code=503, detail="Accounting service is not configured (ACCOUNTING_BASE_URL / ACCOUNTING_INTERNAL_KEY)")
    key = path + "?" + "&".join(f"{k}={v}" for k, v in sorted(params.items()) if v is not None)
    hit = _ACCT_CACHE.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < _ACCT_TTL:
        return hit[1]
    data = await asyncio.to_thread(_acct_get_sync, path, {k: v for k, v in params.items() if v is not None})
    _ACCT_CACHE[key] = (now, data)
    return data


# ── Entity-level access (Neil, Sep 25) ──────────────────────────────────────
# The Accounting grant opens the screen; WHICH entities a person may read is a
# second, narrower question - family and personal entities must not be open to
# everyone on the accounting team. The limit is a set of nexus_access_scopes
# rows (module_id "accounting", scope_id = the Intacct entity code), the same
# table that limits People administration to certain companies. No rows =
# every entity. An entity brings its sub-entities with it. Administrators and
# owners are never limited.
#
# Enforced HERE, on every read, because hiding an entity in a picker is not a
# boundary: a limited caller who asks for nothing gets their own set, and one
# who asks for an entity outside it gets 403.
from sqlalchemy.orm import Session
from auth import _module_level, _LEVELS, _MODULE_LEVEL_RANK, scoped_ids
from database import get_db
import models

ACCOUNTING_SCOPE_MODULE = "accounting"
ACCOUNTING_SCOPE_TYPE = "ledger"


def entity_scope(user: dict = Depends(require_module_grant("accounting", "viewer")), db: Session = Depends(get_db)) -> dict:
    """The caller and the entity codes they are limited to (None = no limit).
    A sync dependency on purpose: FastAPI runs it in the threadpool, so the
    lookup never sits on the event loop."""
    if user["level"] >= _LEVELS["administrator"]:
        return {"user": user, "allowed": None}
    return {"user": user, "allowed": scoped_ids(user["email"], ACCOUNTING_SCOPE_MODULE, db)}


def require_unlimited(scope: dict = Depends(entity_scope)) -> dict:
    """For surfaces that only exist consolidated (the dashboard tabs, the
    accounting app itself): a person limited to certain entities cannot open
    them, because there is no way to show a part of a consolidated figure."""
    if scope["allowed"] is not None:
        raise HTTPException(status_code=403, detail="Your accounting access is limited to certain entities. This screen shows consolidated figures, so it is not available - use Reports.")
    return scope


async def _with_children(codes: set[str]) -> set[str]:
    """`codes` plus every entity under them: the parent chain the accounting
    app keeps, and Intacct's "15001-1" child-code convention."""
    data = await _acct_get("/api/internal/reports/locations", {})
    out = set(codes)
    grew = True
    while grew:
        grew = False
        for e in data.get("entities") or []:
            code = e.get("code") or ""
            if code and code not in out and (e.get("parent_code") in out or any(code.startswith(f"{c}-") for c in out)):
                out.add(code)
                grew = True
    return out


def _csv(v: str | None) -> list[str]:
    return [x.strip() for x in (v or "").split(",") if x.strip()]


async def _limit(scope: dict, location: str | None, locations: str | None) -> tuple[str | None, str | None]:
    """What to ask the accounting app for, given what was asked and what the
    caller may read. One entity always travels as `location`: the accounting
    app reads `locations` only when there are several."""
    allowed = scope["allowed"]
    if allowed is None:
        return location, locations
    if not allowed:
        raise HTTPException(status_code=403, detail="No accounting entities have been assigned to you yet.")
    asked = list(dict.fromkeys(([location] if location else []) + _csv(locations)))
    if asked:
        reach = await _with_children(allowed)
        outside = [c for c in asked if c not in reach]
        if outside:
            raise HTTPException(status_code=403, detail=f"Your accounting access does not include entity {', '.join(outside)}.")
    else:
        asked = sorted(allowed)
    return (asked[0], None) if len(asked) == 1 else (None, ",".join(asked))


_BOOKS = ("accrual", "cash")


def _book(book: str | None) -> str | None:
    b = (book or "accrual").lower()
    if b not in _BOOKS:
        raise HTTPException(status_code=400, detail="book must be accrual or cash")
    # The accounting app defaults to accrual; leaving it out keeps the cache key
    # the dashboard widgets already use.
    return None if b == "accrual" else b


# Every Intacct dimension as a report filter (Charmi, Sep 23): several
# entities / departments at once, plus vendor, customer, employee, Project-Job
# and item - each a comma-separated list of codes, passed through as is.
_DIM_KEYS = ("locations", "departments", "vendor", "customer", "employee", "project", "item")


def _dims(locations, departments, vendor, customer, employee, project, item) -> dict:
    vals = (locations, departments, vendor, customer, employee, project, item)
    return {k: v for k, v in zip(_DIM_KEYS, vals) if v}


@router.get("/reports/pnl")
async def report_pnl(
    from_: str = Query(alias="from"), to: str = Query(...), location: str | None = None,
    locations: str | None = None, departments: str | None = None, vendor: str | None = None, customer: str | None = None,
    employee: str | None = None, project: str | None = None, item: str | None = None,
    book: str | None = None, scope: dict = Depends(entity_scope),
):
    """Income statement between two ISO dates, optionally for one Intacct
    location and any mix of dimensions, from the accrual or the cash book."""
    location, locations = await _limit(scope, location, locations)
    return await _acct_get("/api/internal/reports/pnl", {"from": from_, "to": to, "location": location, "book": _book(book), **_dims(locations, departments, vendor, customer, employee, project, item)})


@router.get("/reports/locations")
async def report_locations(scope: dict = Depends(entity_scope)):
    """Entities (Intacct locations) on the ledger, with names - for report
    filters. A limited caller gets only the entities they may read."""
    data = await _acct_get("/api/internal/reports/locations", {})
    if scope["allowed"] is None:
        return data
    reach = await _with_children(scope["allowed"]) if scope["allowed"] else set()
    return {**data, "entities": [e for e in data.get("entities") or [] if e.get("code") in reach], "limited": True}


@router.get("/reports/dimensions")
async def report_dimensions(kind: str = Query(...)):
    """Values one dimension can be filtered by: vendor, customer, employee,
    project (Project-Job), item (codes on the ledger, with names) or department."""
    if kind not in ("vendor", "customer", "employee", "project", "item", "department"):
        raise HTTPException(status_code=400, detail="kind must be vendor, customer, employee, project, item or department")
    return await _acct_get("/api/internal/reports/dimensions", {"kind": kind})


@router.get("/reports/balance-sheet")
async def report_balance_sheet(
    asof: str = Query(...), location: str | None = None,
    locations: str | None = None, departments: str | None = None, vendor: str | None = None, customer: str | None = None,
    employee: str | None = None, project: str | None = None, item: str | None = None,
    book: str | None = None, scope: dict = Depends(entity_scope),
):
    """Balance sheet as of an ISO date, optionally for one entity and any mix of dimensions."""
    location, locations = await _limit(scope, location, locations)
    return await _acct_get("/api/internal/reports/balance-sheet", {"asof": asof, "location": location, "book": _book(book), **_dims(locations, departments, vendor, customer, employee, project, item)})


@router.get("/reports/trial-balance")
async def report_trial_balance(
    from_: str = Query(alias="from"), to: str = Query(...), location: str | None = None,
    locations: str | None = None, departments: str | None = None, vendor: str | None = None, customer: str | None = None,
    employee: str | None = None, project: str | None = None, item: str | None = None,
    book: str | None = None, scope: dict = Depends(entity_scope),
):
    """Trial balance for a date range, optionally for one entity and any mix of dimensions."""
    location, locations = await _limit(scope, location, locations)
    return await _acct_get("/api/internal/reports/trial-balance", {"from": from_, "to": to, "location": location, "book": _book(book), **_dims(locations, departments, vendor, customer, employee, project, item)})


@router.get("/reports/cash-position")
async def report_cash_position(asof: str | None = None, location: str | None = None, locations: str | None = None, scope: dict = Depends(entity_scope)):
    """Bank and cash account balances as of an ISO date (today by default),
    optionally for one entity. Several entities (a picked set, or a limited
    caller's own) are read one by one and added up account by account."""
    location, locations = await _limit(scope, location, locations)
    codes = _csv(locations)
    if not codes:
        return await _acct_get("/api/internal/reports/cash-position", {"asof": asof, "location": location})
    parts = await asyncio.gather(*[_acct_get("/api/internal/reports/cash-position", {"asof": asof, "location": c}) for c in codes])
    accounts: dict[str, dict] = {}
    for part in parts:
        for a in part.get("accounts") or []:
            cur = accounts.setdefault(a["gl_code"], {**a, "balance": 0})
            cur["balance"] = round(cur["balance"] + (a.get("balance") or 0), 2)
            if (a.get("last_activity") or "") > (cur.get("last_activity") or ""):
                cur["last_activity"] = a["last_activity"]
    rows = sorted(accounts.values(), key=lambda a: a["gl_code"])
    return {**parts[0], "location": None, "locations": codes, "accounts": rows, "total": round(sum(a["balance"] for a in rows), 2)}


_COLUMN_KEYS = ("date", "entry", "doc", "description", "account", "entity", "department", "party", "vendor", "customer", "employee", "journal", "debit", "credit")


@router.get("/search")
async def search_ledger(
    q: str | None = None,
    location: str | None = None,
    locations: str | None = None,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    party_kind: str | None = None,
    party: str | None = None,
    account: str | None = None,
    journal: str | None = None,
    min_: str | None = Query(default=None, alias="min"),
    max_: str | None = Query(default=None, alias="max"),
    book: str | None = None,
    cols: str | None = None,
    offset: int = 0,
    limit: int = 100,
    scope: dict = Depends(entity_scope),
):
    """Global search over the posted ledger (Neil, Sep 17: type a vendor or a
    customer and see every line they are on; Charmi: anything that CONTAINS what
    was typed, then filter down). Every word must appear somewhere on the line -
    description, memo, entry / document number, account, entity, vendor,
    customer, employee or amount. The same call is the report drill-down: no
    words, one `account` (GL code), a period and an entity. `cols` is a JSON
    object of column -> text, one filter box per column (Charmi, Sep 25), and
    narrows the whole result. Returns one page of lines, the totals over the
    WHOLE result, and the facets to narrow it with."""
    location, locations = await _limit(scope, location, locations)
    col_filters = None
    if cols:
        try:
            parsed = json.loads(cols)
        except ValueError:
            raise HTTPException(status_code=400, detail="cols must be a JSON object")
        if not isinstance(parsed, dict):
            raise HTTPException(status_code=400, detail="cols must be a JSON object")
        kept = {k: str(parsed[k]).strip()[:120] for k in _COLUMN_KEYS if isinstance(parsed.get(k), str) and parsed[k].strip()}
        col_filters = json.dumps(kept, sort_keys=True) if kept else None
    return await _acct_get("/api/internal/search", {
        "q": (q or "").strip() or None, "location": location, "locations": locations, "from": from_, "to": to,
        "party_kind": party_kind if party else None, "party": party,
        "account": account, "journal": journal, "min": min_, "max": max_,
        "book": book, "cols": col_filters, "offset": max(0, offset), "limit": max(1, min(limit, 1000)),
    })


@router.get("/entry/{entry_id}")
async def ledger_entry(entry_id: str, scope: dict = Depends(entity_scope)):
    """One journal entry - header, every line, the Intacct records behind it -
    for the entry number on a search result or drill-down (Charmi, Sep 24:
    click the entry after pulling a report). `path` in the answer is where the
    accounting app shows the same entry, for "Open in Nexus Accounting". A
    caller limited to certain entities can open an entry only when every line
    of it sits in them - an entry between two entities shows both sides."""
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", entry_id or ""):
        raise HTTPException(status_code=400, detail="entry id must be a uuid")
    data = await _acct_get("/api/internal/entry", {"id": entry_id})
    if scope["allowed"] is not None:
        reach = await _with_children(scope["allowed"]) if scope["allowed"] else set()
        if any((line.get("location") or "") not in reach for line in data.get("lines") or []):
            raise HTTPException(status_code=403, detail="This entry includes an entity outside your accounting access.")
    return data


@router.get("/access/me")
async def my_entity_access(scope: dict = Depends(entity_scope)):
    """Whether the caller is limited to certain entities, and which. The screen
    uses it to show only what will answer; the limit itself is enforced on
    every read above."""
    allowed = scope["allowed"]
    return {"limited": allowed is not None, "entities": sorted(allowed) if allowed else []}


# ── Single sign-on into the accounting app (Nexus is the access authority) ──
# Nobody gets a password on accounting.greensglobal.com. Holding the Nexus
# "accounting" grant (or an administrator+ role, which bypasses grants app-wide)
# is the only way in: this endpoint asks the accounting app to provision the
# caller and mint a one-time handoff link, and the browser opens it. Losing the
# grant is enforced by accounting_sso.accounting_sso_sync_loop, which posts the
# full list of grant holders every few minutes so the accounting app can
# deactivate anyone who dropped off it. The grant is its own module,
# "accounting-app" ("Nexus Accounting App" in Roles & Access), separate from
# the read-only Accounting screen in Nexus. Full/owner level -> accounting
# "admin"; viewer/editor -> "member".
# Upstream failures are 424 (Failed Dependency), NEVER 502: Cloudflare replaces
# an origin 502 with its own HTML error page, so the UI showed a bare "API
# error 502" and hid the real reason (Sep 14 - Priyanka/Pranshu could not open
# the accounting app and nobody could see why; same lesson as egnyte.py, Aug 10).
# 424 is not retried by api.js and its detail reaches the screen verbatim.
def _acct_post_sync(path: str, payload: dict) -> dict:
    r = httpx.post(
        f"{_ACCT_BASE}{path}",
        json=payload,
        headers={"x-internal-api-key": _ACCT_KEY},
        timeout=30,
    )
    if r.status_code != 200:
        raise HTTPException(status_code=424, detail=_upstream_detail(r))
    data = r.json()
    if not data.get("ok"):
        raise HTTPException(status_code=424, detail=data.get("error") or "Accounting service error")
    return data


def _display_name(email: str, db: Session) -> str:
    key = (email or "").lower()
    e = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == key).first()
    if e:
        name = (e.display_name or "").strip() or f"{e.first_name} {e.last_name}".strip()
        if name:
            return name
    r = db.query(models.NexusRole).filter(models.NexusRole.email == key).first()
    if r and (r.display_name or "").strip():
        return r.display_name.strip()
    return email


def accounting_role_for(user: dict, db: Session) -> str:
    """Map the caller's Nexus standing onto the accounting app's role."""
    if user["level"] >= _LEVELS["administrator"] or _module_level(user["email"], "accounting-app", db) >= _MODULE_LEVEL_RANK["full"]:
        return "admin"
    return "member"


@router.post("/launch")
async def launch_accounting(next: str | None = None, user: dict = Depends(require_module_grant("accounting-app", "viewer")), db: Session = Depends(get_db)):
    """Provision the caller in the accounting app and return a one-time URL that
    signs them in there. The URL is single-use and short-lived; the browser
    must open it immediately. Refused for anyone limited to certain entities:
    the accounting app shows every entity to everyone it lets in."""
    if user["level"] < _LEVELS["administrator"] and scoped_ids(user["email"], ACCOUNTING_SCOPE_MODULE, db) is not None:
        raise HTTPException(status_code=403, detail="Your accounting access is limited to certain entities, and the accounting app shows all of them. Use Reports in Nexus.")
    if not _ACCT_BASE or not _ACCT_KEY:
        raise HTTPException(status_code=503, detail="Accounting service is not configured (ACCOUNTING_BASE_URL / ACCOUNTING_INTERNAL_KEY)")
    payload = {
        "email": user["email"],
        "full_name": _display_name(user["email"], db),
        "role": accounting_role_for(user, db),
    }
    if next and next.startswith("/") and not next.startswith("//"):
        payload["next"] = next
    data = await asyncio.to_thread(_acct_post_sync, "/api/internal/sso/launch", payload)
    return {"url": data["url"], "role": payload["role"]}
