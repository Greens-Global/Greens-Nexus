"""Accounting -> Loans & Financing (Neil and Charmi, 10/02: "Nothing has been
done on Loans & Financing for me to review").

The loans table (fin_loans, in the accounting database, kept through the
dashboard's row-save) was empty on production, so every loan screen opened
blank. This router fills it FROM THE LEDGER and gives the owners a review:

  Set Up From the Ledger   every entity the caller may read, its balance
                           sheet as of the month shown, and one proposed loan
                           per liability account whose title says loan,
                           mortgage, note payable, line of credit, financing,
                           or names a lender. Tick + Create writes fin_loans
                           rows through the same upsert Data > Loans uses,
                           with balance_source 'ledger' - nothing typed.
                           Re-running proposes only what is missing.
  Review                   per loan, for the month shown: the balance now, a
                           month ago and twelve months ago (balance sheet as
                           of those dates), principal paid (the decrease),
                           interest paid (the entity's interest expense
                           accounts, from the P&L), debt service, the
                           property's trailing-12 NOI, and DSCR against the
                           covenant minimum (1.35 unless typed - Charmi,
                           09/25: "at least 35% more").

Every figure comes through the accounting app's internal API (routers/
accounting.py is the reference): balance-sheet and pnl per entity, the
dashboard's tables op for the loan rows. Nexus never opens the accounting
database. A person limited to certain entities (Neil, Sep 25) sees only the
loans of those entities; every ledger read goes through `_limit`.

Live run, 10/02 (317 entities, 811 liability accounts):
  - Credit cards ("OSM - Capital One - 5431" on 22603) matched on the lender's
    name. A lender-name-only match now counts only from GL 25000 up (the
    long-term range: 26xxx mortgages, 27xxx LOC / auto / credit union loans);
    a 2xxxx below that needs a loan word.
  - The balance sheet sends every amount as debits less credits: a mortgage
    owed is NEGATIVE (GE Five Star 26013 = -11,245,000), a positive liability
    is a debit balance (Golden 1 26023 = +14,500,000). `owed` = -amount is
    the loan balance everywhere; principal paid = owed a year ago less owed
    now; a debit balance is proposed with a flag and shown as negative owed,
    never flipped.
  - A parent entity rolls its children up ("(AM) (G) 910 S. El Camino Real"
    = 12027-1 + 12027-2), so the same loan was proposed twice. Only LEAF
    entities are scanned.
  - 105 s is more than one request may take (Azure drops it at 230 s): the
    scan is a background job on the request's loop - the first GET starts it
    and answers 202 with the progress, later GETs the same until the result
    (kept 30 minutes, cleared on create); a failed job answers 424 once and
    the next GET starts it again. The review (one second) stays synchronous.
"""
import asyncio
import calendar
import contextvars
import re
import time
from collections import defaultdict
from datetime import date, datetime, timezone
from typing import Any, Callable, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import require_module_grant
from database import get_db
from routers import accounting, accounting_dashboard
from routers.accounting import _limit, entity_scope

router = APIRouter(prefix="/accounting/loans", tags=["Accounting"], dependencies=[Depends(require_module_grant("accounting", "viewer"))])
_edit = require_module_grant("accounting", "editor")

DEFAULT_COVENANT = 1.35
_MONTH = re.compile(r"^\d{4}-\d{2}$")
_SCAN_TTL = 300.0          # the review, synchronous
_RESULT_TTL = 1800.0       # a finished scan job
_PARTIAL_TTL = 60.0        # a scan with entities not read: shown, then re-run
_SCAN: dict[tuple, tuple[float, Any]] = {}
LENDER_ONLY_MIN_GL = 25000
# Ledger reads in flight at once - one semaphore PER EVENT LOOP (a module-level
# asyncio.Semaphore binds to the first loop that waits on it and then raises
# "bound to a different event loop" from any other; TestClient runs each
# request on its own loop, a worker restart does the same) and per size: a
# request reads 4 at a time, a background scan job 6.
_PARALLEL: contextvars.ContextVar[int] = contextvars.ContextVar("acct_scan_parallel", default=4)
_SEMS: dict[tuple[int, int], asyncio.Semaphore] = {}


def _sem() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    key = (id(loop), _PARALLEL.get())
    sem = _SEMS.get(key)
    if sem is None:
        for k in [k for k in _SEMS if k[0] != id(loop)]:
            _SEMS.pop(k, None)
        sem = _SEMS[key] = asyncio.Semaphore(key[1])
    return sem


async def gather_tolerant(makers: list, what: list, empty, on_done: Optional[Callable[[], None]] = None):
    """Run the reads together. `makers` are zero-argument callables that
    build the coroutine, so a read that fails can be retried once; one that
    fails twice is answered with `empty` and a note. One entity the
    accounting app drops (10/02: it closed a connection mid-scan of 317
    entities) must not take the whole screen down with it. `on_done` is
    called once per read as it settles (the job's progress)."""
    notes: list[str] = []

    async def one(i: int):
        try:
            try:
                return await makers[i]()
            except Exception:  # noqa: BLE001 - retried once
                return await makers[i]()
        except Exception as e:  # noqa: BLE001 - the note carries the reason
            notes.append(f"{what[i] if i < len(what) else 'a read'}: {getattr(e, 'detail', None) or e.__class__.__name__}")
            return empty() if callable(empty) else empty
        finally:
            if on_done:
                on_done()

    out = list(await asyncio.gather(*[one(i) for i in range(len(makers))]))
    return out, notes


# ── Scan jobs (both scans: loans and leases) ────────────────────────────────
class ScanJob:
    """One background scan: started on the request's loop, polled by later
    requests. `done` / `total` count entities."""

    def __init__(self, key: tuple):
        self.key = key
        self.done = 0
        self.total = 0
        self.started_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        self.loop = asyncio.get_running_loop()
        self.task: Optional[asyncio.Task] = None
        self.result: Optional[dict] = None
        self.error: Optional[str] = None
        self.status = 424            # what a failed job answers with; a 503 (not configured) stays a 503
        self.finished: Optional[float] = None
        self.cacheable = True

    def tick(self) -> None:
        self.done += 1

    def progress(self) -> dict:
        return {"scanning": True, "done": self.done, "total": self.total, "startedAt": self.started_at}

    def failed(self) -> bool:
        return bool(self.error) or self.loop.is_closed() or bool(self.task and self.task.done() and self.result is None)

    def expired(self, now: float) -> bool:
        return self.result is not None and now - (self.finished or 0) >= (_RESULT_TTL if self.cacheable else _PARTIAL_TTL)


_JOBS: dict[tuple, ScanJob] = {}
_INTERRUPTED = "The ledger scan was interrupted - open again to start it over."


def scan_job(key: tuple, run: Callable[[ScanJob], Any]) -> ScanJob:
    """The job for `key`: the finished one while its result is fresh, the
    running one, or a new one started now (`run(job)` is awaited on this
    loop and must set job.total and call job.tick()). A failed job raises
    424 with the reason ONCE and is forgotten, so the next call starts over."""
    now = time.monotonic()
    job = _JOBS.get(key)
    if job and job.expired(now):
        _JOBS.pop(key, None)
        job = None
    if job and job.result is None and job.failed():
        _JOBS.pop(key, None)
        raise HTTPException(status_code=job.status, detail=job.error or _INTERRUPTED)
    if job:
        return job
    job = ScanJob(key)

    async def runner():
        _PARALLEL.set(6)
        try:
            job.result = await run(job)
            job.finished = time.monotonic()
        except Exception as e:  # noqa: BLE001 - the job carries the reason
            job.error = str(getattr(e, "detail", None) or f"{e.__class__.__name__}: {e}")
            if isinstance(e, HTTPException) and e.status_code == 503:
                job.status = 503

    job.task = asyncio.create_task(runner())
    _JOBS[key] = job
    return job


async def scan_result(key: tuple, run: Callable[[ScanJob], Any]) -> dict:
    """The scan's result, waiting for the job when it is still running (the
    create routes, right after the dialog showed the table)."""
    job = scan_job(key, run)
    if job.result is None and job.task is not None:
        await asyncio.shield(job.task)
    if job.result is None:
        _JOBS.pop(key, None)
        raise HTTPException(status_code=job.status, detail=job.error or _INTERRUPTED)
    return job.result


def forget_jobs(email: str, kind: str) -> None:
    for k in [k for k in _JOBS if k[0] == email and k[1] == kind]:
        _JOBS.pop(k, None)


def leaf_entities(entities: list[dict]) -> tuple[list[dict], int]:
    """(the leaf entities, how many parents were left out). An entity is a
    parent when another entity's parent_code is its code or another code
    starts with "<code>-" (Intacct's child-code convention, the same rule as
    accounting._with_children); its figures roll up from the children, so
    scanning it too would propose everything twice."""
    codes = {e["code"] for e in entities}
    parents: set[str] = set()
    for e in entities:
        if e.get("parent_code") in codes:
            parents.add(e["parent_code"])
        for c in codes:
            if c != e["code"] and e["code"].startswith(f"{c}-"):
                parents.add(c)
    return [e for e in entities if e["code"] not in parents], len(parents)


def _r2(v) -> float:
    return round(float(v or 0) + 0.0, 2)


# ── Which liability accounts are loans ───────────────────────────────────────
# A loan is a liability whose title or number says so (loan, mortgage, note
# payable, line of credit, LOC, HELOC, financing, promissory, borrowing) or
# names a lender (F&M, Citi, Chase, BofA, Wells, SBA, PNC, US Bank, a bank or
# credit union, EIDL / PPP) - but a lender's name ALONE counts only from GL
# 25000 up, the long-term range (26xxx mortgages, 27xxx LOC / auto / credit
# union loans seen live): "OSM - Capital One - 5431" on 22603, "GC - Chase -
# 2305" on 22301 and "US Bank - Amazon - 4863" on 22114 are credit cards.
# Working-capital and payroll balances are never
# loans, whatever else the title says, unless it says "loan": accounts
# payable, credit cards, payroll, accrued, deferred, unearned, security and
# customer deposits, clearing / suspense. "Due to <entity>" and intercompany
# titles are loans only when they say loan; a loan whose title names another
# entity or says due to / intercompany is an INTERCOMPANY loan.
LOAN_WORDS = re.compile(r"\bloans?\b|mortgage|notes? payable|\bn/p\b|\bnotes\b|line of credit|\bloc\b|heloc|financ|promissory|borrow|\bcredit line\b")
LENDER_NAMES = [
    (re.compile(r"\bf\s*&\s*m\b|farmers\s*&?\s*merchants"), "F&M Bank"),
    (re.compile(r"\bciti\b|citibank|citizens"), "Citi"),
    (re.compile(r"\bchase\b|jpmorgan|jp morgan"), "Chase"),
    (re.compile(r"\bbofa\b|bank of america|\bboa\b"), "Bank of America"),
    (re.compile(r"wells"), "Wells Fargo"),
    (re.compile(r"\bsba\b|\beidl\b|\bppp\b"), "SBA"),
    (re.compile(r"\bpnc\b"), "PNC"),
    (re.compile(r"us bank|u\.s\. bank"), "US Bank"),
    (re.compile(r"first citizens"), "First Citizens"),
    (re.compile(r"capital one"), "Capital One"),
    (re.compile(r"credit union"), "Credit Union"),
    (re.compile(r"\bbank\b"), "Bank"),
]
_LENDER_ANY = re.compile("|".join(rx.pattern for rx, _ in LENDER_NAMES))
_NEVER = re.compile(r"accounts payable|\ba/p\b|credit card|\bamex\b|\bvisa\b|mastercard|discover|payroll|withh|accrued|deferred|unearned|security deposit|customer deposit|tenant deposit|sales tax|tax payable|clearing|suspense|garnish")
# Never a loan even when a loan word is in the title: the interest owed on one
# is an accrual ("HELOC Interest Payable" on 25011, live 10/02).
_NEVER_EVEN_WITH_LOAN_WORD = re.compile(r"interest payable|accrued interest|interest accru")
_INTERCO = re.compile(r"intercompany|inter-company|\bi/c\b|due to|\bdue from\b|related part|shareholder|member loan|officer")
_STRIP = re.compile(r"\b(loans?|payable|mortgage|notes?|n/p|line of credit|loc|heloc|financing|equipment|promissory|intercompany|inter-company|due|from|to|the|a|an|of|-|–|:)\b", re.I)
LOOKED_FOR = ["Loan", "Mortgage", "Note Payable / Notes", "Line of Credit / LOC / HELOC", "Financing / Promissory / Borrowing",
              "a lender's name (F&M, Citi, Chase, BofA, Wells Fargo, SBA, PNC, US Bank, a bank or credit union)"]


def classify_loan_account(section: str, code: str, title: str, entity_names: Optional[dict] = None, own_code: str = "") -> Optional[dict]:
    """None when the account is not a loan; else {"kind": external | intercompany,
    "lender": a guess from the title}. `entity_names` is {code: name} of every
    entity, to spot a title that names another entity."""
    if section != "liability":
        return None
    t = (title or "").strip()
    low = t.lower()
    says_loan = bool(LOAN_WORDS.search(low))
    if _NEVER_EVEN_WITH_LOAN_WORD.search(low) or (_NEVER.search(low) and not says_loan):
        return None
    names_entity = ""
    for ecode, ename in (entity_names or {}).items():
        if ecode == own_code or not ename:
            continue
        key = ename.lower().replace(", llc.", "").replace(", llc", "").replace(", inc.", "").replace(", inc", "").strip()
        if len(key) >= 4 and key in low:
            names_entity = ename
            break
    interco = bool(_INTERCO.search(low)) or bool(names_entity)
    if interco and not says_loan:
        return None
    if not says_loan:
        n = _gl_number(code)
        if not _LENDER_ANY.search(low) or n is None or n < LENDER_ONLY_MIN_GL:
            return None
    lender = ""
    for rx, name in LENDER_NAMES:
        if rx.search(low):
            lender = name
            break
    if lender in ("Bank", "Credit Union"):
        lender = _guess_lender(t) or lender      # "City National Bank - Gr. FLP LOC": the bank's own name
    if interco:
        return {"kind": "intercompany", "lender": names_entity or lender or _guess_lender(t)}
    return {"kind": "external", "lender": lender or _guess_lender(t)}


def _gl_number(code: str) -> Optional[int]:
    m = re.match(r"\d+", (code or "").strip())
    return int(m.group()) if m else None


def _guess_lender(title: str) -> str:
    """What is left of a title once the loan words are taken out."""
    rest = _STRIP.sub(" ", title)
    rest = re.sub(r"[#\d]+", " ", rest)
    rest = re.sub(r"\s+", " ", rest).strip(" -:")
    return rest[:60]


# ── Ledger reads (every one through _limit) ──────────────────────────────────
async def _entities(scope: dict) -> list[dict]:
    """The entities the caller may read, with names."""
    data = await accounting._acct_get("/api/internal/reports/locations", {})
    rows = [e for e in data.get("entities") or [] if e.get("code")]
    if scope["allowed"] is None:
        return rows
    if not scope["allowed"]:
        return []
    reach = await accounting._with_children(scope["allowed"])
    return [e for e in rows if e["code"] in reach]


async def _balance_sheet(scope: dict, entity: str, asof: str) -> dict[str, dict]:
    """GL code -> {title, section, amount, owed} of one entity as of a date.
    `amount` is the ledger's figure, debits less credits for every section
    (confirmed on 15001, 10/02); `owed` is the positive amount owed for a
    liability (-amount), the amount itself elsewhere."""
    location, _ = await _limit(scope, entity, None)
    async with _sem():
        data = await accounting._acct_get("/api/internal/reports/balance-sheet", {"asof": asof, "location": location})
    out: dict[str, dict] = {}
    for s in data.get("sections") or []:
        if s.get("key") not in ("asset", "liability", "equity"):
            continue
        for a in s.get("accounts") or []:
            if a.get("account_no"):
                amount = _r2(a.get("amount"))
                out[str(a["account_no"])] = {"title": a.get("title") or "", "section": s["key"], "amount": amount, "owed": owed(s["key"], amount), "accountType": a.get("account_type") or ""}
    return out


def owed(section: str, amount: float) -> float:
    """What is owed on a balance sheet account: a liability's credit balance
    arrives negative, so owed = -amount; a debit balance comes out negative
    and is shown that way, never flipped."""
    return _r2(-amount) if section == "liability" else _r2(amount)


async def _pnl(scope: dict, entity: str, from_: str, to: str) -> list[dict]:
    """[{section, account_no, title, amount}] of one entity between two dates."""
    location, _ = await _limit(scope, entity, None)
    async with _sem():
        data = await accounting._acct_get("/api/internal/reports/pnl", {"from": from_, "to": to, "location": location})
    out = []
    for s in data.get("sections") or []:
        for a in s.get("accounts") or []:
            if a.get("account_no"):
                out.append({"section": s.get("key") or "", "account_no": str(a["account_no"]), "title": a.get("title") or "", "amount": _r2(a.get("amount"))})
    return out


# ── The arithmetic (pure) ────────────────────────────────────────────────────
_INTEREST = re.compile(r"interest")
_NON_OPERATING = re.compile(r"interest|depreciation|amortization|amortisation")
_INCOME = ("revenue", "other_income")
_COSTS = ("cogs", "expense", "other_expense")


def interest_expense(pnl: list[dict]) -> float:
    """What the entity paid in interest: its expense accounts titled Interest."""
    return _r2(sum(a["amount"] for a in pnl if a["section"] in _COSTS and _INTEREST.search(a["title"].lower())))


def noi(pnl: list[dict]) -> dict:
    """Net operating income: income less operating costs, leaving out interest,
    depreciation and amortization (they are financing and book entries, not
    the property's operation)."""
    income = _r2(sum(a["amount"] for a in pnl if a["section"] in _INCOME))
    opex = _r2(sum(a["amount"] for a in pnl if a["section"] in _COSTS and not _NON_OPERATING.search(a["title"].lower())))
    return {"income": income, "operatingExpenses": opex, "noi": _r2(income - opex)}


def dscr(noi_t12: float, debt_service_t12: float) -> Optional[float]:
    """NOI over debt service for the same twelve months; None when nothing was
    serviced (a loan with no payments has no coverage to speak of)."""
    if debt_service_t12 <= 0.005:
        return None
    return round(noi_t12 / debt_service_t12, 2)


def month_bounds(month: str) -> tuple[str, str]:
    y, m = int(month[:4]), int(month[5:7])
    return f"{y}-{m:02d}-01", f"{y}-{m:02d}-{calendar.monthrange(y, m)[1]:02d}"


def shift_month(month: str, back: int) -> str:
    y, m = int(month[:4]), int(month[5:7])
    idx = y * 12 + (m - 1) - back
    return f"{idx // 12}-{idx % 12 + 1:02d}"


def _month(v: Optional[str]) -> str:
    v = (v or date.today().isoformat()[:7]).strip()
    if not _MONTH.match(v) or not 1 <= int(v[5:7]) <= 12:
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")
    return v


# ── The loans already set up (fin_loans, through the dashboard proxy) ───────
async def _loan_rows(scope: dict, month: str) -> list[dict]:
    data = await accounting_dashboard._get("tables", {"period": month})
    rows = [r for r in (data.get("tables") or data).get("loans") or [] if isinstance(r, dict)] if isinstance(data, dict) else []
    if scope["allowed"] is None:
        return rows
    reach = await accounting._with_children(scope["allowed"]) if scope["allowed"] else set()
    return [r for r in rows if (r.get("entity_code") or "") in reach]


def _set_up_key(r: dict) -> tuple[str, str]:
    return (str(r.get("entity_code") or ""), str(r.get("gl_account") or "").strip())


# ── Proposals ───────────────────────────────────────────────────────────────
def _scan_key(scope: dict, month: str) -> tuple:
    return (scope["user"]["email"], "loans", month)


async def _scan(scope: dict, month: str, job: Optional[ScanJob] = None) -> dict:
    """Every leaf entity's liability accounts as of the month end, classified."""
    entities, parents = leaf_entities(await _entities(scope))
    names = {e["code"]: e.get("name") or "" for e in entities}
    _, asof = month_bounds(month)
    if job:
        job.total = len(entities)
    sheets, notes = await gather_tolerant([(lambda e=e: _balance_sheet(scope, e["code"], asof)) for e in entities],
                                          [f"{e.get('name') or e['code']} ({e['code']}) balance sheet" for e in entities], dict,
                                          on_done=job.tick if job else None)
    proposals, liabilities = [], 0
    for e, sheet in zip(entities, sheets):
        for code, a in sorted(sheet.items()):
            if a["section"] != "liability":
                continue
            liabilities += 1
            hit_ = classify_loan_account(a["section"], code, a["title"], names, e["code"])
            if not hit_:
                continue
            proposals.append({"entityCode": e["code"], "entityName": names.get(e["code"]) or e["code"], "glAccount": code, "title": a["title"],
                              "balance": a["owed"], "debitBalance": a["owed"] < 0, "lender": hit_["lender"], "kind": hit_["kind"], "balanceSource": "ledger"})
    out = {"month": month, "asOf": asof, "entitiesScanned": len(entities), "parentsSkipped": parents, "liabilityAccounts": liabilities,
           "proposals": proposals, "lookedFor": LOOKED_FOR, "notes": [f"Not read this time - {n}" for n in notes]}
    if job:
        job.cacheable = not notes   # a partial scan is shown, never kept as the answer
    return out


def _forget(email: str) -> None:
    for k in [k for k in _SCAN if k[0] == email]:
        _SCAN.pop(k, None)
    forget_jobs(email, "loans")


def _with_status(scan: dict, existing: list[dict]) -> dict:
    have = {_set_up_key(r): r for r in existing}
    rows = []
    for p in scan["proposals"]:
        row = dict(p)
        cur = have.get((p["entityCode"], p["glAccount"]))
        row["status"] = "set_up" if cur else "new"
        row["loanId"] = cur.get("id") if cur else None
        rows.append(row)
    return {**scan, "proposals": rows, "setUp": sum(1 for r in rows if r["status"] == "set_up"), "missing": sum(1 for r in rows if r["status"] == "new")}


@router.get("/proposals")
async def proposals(month: Optional[str] = None, scope: dict = Depends(entity_scope)):
    """One proposed loan per loan-like liability account, with the ones
    already in fin_loans marked as set up (idempotent: re-running proposes
    only what is missing). The scan runs in the background: 202 with the
    progress until it is done, then the result."""
    month = _month(month)
    job = scan_job(_scan_key(scope, month), lambda job: _scan(scope, month, job))
    if job.result is None:
        return JSONResponse(status_code=202, content=job.progress())
    return _with_status(job.result, await _loan_rows(scope, month))


class CreateItem(BaseModel):
    entityCode: str
    glAccount: str


class CreateBody(BaseModel):
    month: Optional[str] = None
    items: list[CreateItem]


def _loan_no(gl: str, title: str) -> str:
    m = re.search(r"#\s*(\w[\w-]{2,})", title or "")
    return (m.group(1) if m else gl)[:40]


@router.post("/create", status_code=201)
async def create_from_ledger(body: CreateBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope), db: Session = Depends(get_db)):
    """Write the ticked proposals as fin_loans rows through the dashboard's
    row-save - loan number from the account, GL account, balance from the
    ledger. An account already set up is skipped, never duplicated."""
    month = _month(body.month)
    if not body.items:
        raise HTTPException(status_code=400, detail="Tick at least one loan to create.")
    scan, existing = await asyncio.gather(scan_result(_scan_key(scope, month), lambda job: _scan(scope, month, job)), _loan_rows(scope, month))
    have = {_set_up_key(r) for r in existing}
    by_key = {(p["entityCode"], p["glAccount"]): p for p in scan["proposals"]}
    accounting_dashboard._require_configured()
    by = accounting_dashboard._display_name(db, user["email"])
    created, skipped = [], []
    for it in body.items:
        key = (it.entityCode.strip(), it.glAccount.strip())
        await _limit(scope, key[0], None)
        p = by_key.get(key)
        if not p:
            skipped.append({"entityCode": key[0], "glAccount": key[1], "why": "not a loan account on the ledger"})
            continue
        if key in have:
            skipped.append({"entityCode": key[0], "glAccount": key[1], "why": "already set up"})
            continue
        row = {"loan_no": _loan_no(p["glAccount"], p["title"]), "kind": p["kind"], "lender": p["lender"] or p["title"][:80], "entity_code": p["entityCode"],
               "gl_account": p["glAccount"], "balance_source": "ledger", "balance": p["balance"], "rate_pct": 0, "rate_type": "fixed", "maturity": None,
               "monthly_pi": 0, "dscr": None, "covenant_min": None, "is_active": True, "notes": f"Set up from the ledger ({p['title']}) as of {scan['asOf']}"}
        await asyncio.to_thread(accounting_dashboard._post_sync, {"op": "row-save", "table": "fin_loans", "row": row, "by": by})
        have.add(key)
        created.append({**p, "loanNo": row["loan_no"]})
    for k in [k for k in accounting_dashboard._CACHE if k.startswith("op=tables")]:
        accounting_dashboard._CACHE.pop(k, None)
    _forget(user["email"])
    return {"created": created, "skipped": skipped}


# ── Review ──────────────────────────────────────────────────────────────────
def _num(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def review_rows(loans: list[dict], sheets: dict, pnls: dict, month: str, names: dict) -> list[dict]:
    """The review figures per loan. `sheets` is {(entity, 'now'|'m1'|'m12'):
    {gl: {owed, ...}}} (`owed` as `_balance_sheet` gives it: positive for a
    loan owed, negative for a debit balance); `pnls` is {(entity,
    'month'|'t12'): [accounts]}. Principal paid is owed before less owed now,
    floored at zero inside the debt service (a draw is not a payment). An
    entity's interest and NOI belong to the property, so with several loans on
    one entity the interest is shared by balance and the DSCR is the entity's
    NOI over the entity's whole debt service - the figure a lender looks at."""
    by_entity: dict[str, list[dict]] = defaultdict(list)
    for l in loans:
        by_entity[str(l.get("entity_code") or "")].append(l)
    out = []
    for entity, group in by_entity.items():
        pm, pt = pnls.get((entity, "month"), []), pnls.get((entity, "t12"), [])
        int_month, int_t12 = interest_expense(pm), interest_expense(pt)
        n = noi(pt)
        figs = []
        for l in group:
            gl = str(l.get("gl_account") or "").strip()
            ledger = bool((l.get("balance_source") or "manual") == "ledger" and gl)
            at = {when: sheets.get((entity, when), {}).get(gl) for when in ("now", "m1", "m12")} if ledger else {}
            now_, m1, m12 = ((at.get(w) or {}).get("owed") if at.get(w) else None for w in ("now", "m1", "m12"))
            balance = now_ if now_ is not None else (_num(l.get("balance")) if not ledger else 0.0)
            figs.append({"loan": l, "balance": _r2(balance), "m1": m1, "m12": m12, "debitBalance": bool(ledger and now_ is not None and now_ < 0),
                         "principalMonth": _r2(m1 - now_) if ledger and m1 is not None and now_ is not None else None,
                         "principalT12": _r2(m12 - now_) if ledger and m12 is not None and now_ is not None else None})
        total_bal = sum(max(0.0, f["balance"]) for f in figs) or 0.0
        entity_ds = 0.0
        for f in figs:
            share = (max(0.0, f["balance"]) / total_bal) if total_bal > 0 else (1.0 / len(figs))
            f["interestMonth"] = _r2(int_month * share)
            f["interestT12"] = _r2(int_t12 * share)
            f["debtServiceMonth"] = _r2(max(0.0, f["principalMonth"] or 0) + f["interestMonth"])
            f["debtServiceT12"] = _r2(max(0.0, f["principalT12"] or 0) + f["interestT12"])
            entity_ds += f["debtServiceT12"]
        cov = dscr(n["noi"], entity_ds)
        for f in figs:
            l = f["loan"]
            minimum = _num(l.get("covenant_min")) or DEFAULT_COVENANT
            out.append({
                "id": l.get("id"), "loanNo": l.get("loan_no") or "", "lender": l.get("lender") or "", "kind": l.get("kind") or "external",
                "entityCode": entity, "entityName": names.get(entity) or entity, "glAccount": str(l.get("gl_account") or ""),
                "balanceSource": l.get("balance_source") or "manual", "balance": f["balance"], "debitBalance": f["debitBalance"], "balanceMonthAgo": f["m1"], "balanceYearAgo": f["m12"],
                "principalPaid": f["principalMonth"], "interestPaid": f["interestMonth"], "debtService": f["debtServiceMonth"],
                "principalPaidT12": f["principalT12"], "interestPaidT12": f["interestT12"], "debtServiceT12": f["debtServiceT12"],
                "entityDebtServiceT12": _r2(entity_ds), "noiT12": n["noi"], "incomeT12": n["income"], "operatingExpensesT12": n["operatingExpenses"],
                "dscr": cov, "covenantMin": round(minimum, 2), "covenantTyped": bool(_num(l.get("covenant_min"))), "belowCovenant": cov is not None and cov < minimum,
                "ratePct": _num(l.get("rate_pct")) or None, "rateType": l.get("rate_type") or "", "maturity": str(l.get("maturity"))[:10] if l.get("maturity") else None,
                "monthlyPi": _num(l.get("monthly_pi")) or None, "isActive": bool(l.get("is_active", True)), "notes": l.get("notes") or "",
                "sharedWith": len(figs) - 1,
            })
    out.sort(key=lambda r: (r["dscr"] is None, r["dscr"] if r["dscr"] is not None else 0, r["lender"], r["loanNo"]))
    return out


def _totals(rows: list[dict], key: str, label: str) -> list[dict]:
    groups: dict[str, dict] = {}
    for r in rows:
        g = groups.setdefault(r[key] or "(none)", {key: r[key] or "", "label": r[label] if label else (r[key] or "(no lender)"), "loans": 0, "balance": 0.0, "debtServiceT12": 0.0, "interestT12": 0.0, "noiT12": 0.0, "_entities": set()})
        g["loans"] += 1
        g["balance"] = _r2(g["balance"] + r["balance"])
        g["debtServiceT12"] = _r2(g["debtServiceT12"] + r["debtServiceT12"])
        g["interestT12"] = _r2(g["interestT12"] + r["interestPaidT12"])
        if r["entityCode"] not in g["_entities"]:
            g["_entities"].add(r["entityCode"])
            g["noiT12"] = _r2(g["noiT12"] + r["noiT12"])
    out = []
    for g in groups.values():
        g.pop("_entities")
        g["dscr"] = dscr(g["noiT12"], g["debtServiceT12"])
        out.append(g)
    return sorted(out, key=lambda g: -g["balance"])


def maturities(rows: list[dict], month: str, months_ahead: int = 24) -> list[dict]:
    """The next 24 months: which loans mature in each, and how much."""
    end = shift_month(month, -months_ahead)
    out: dict[str, dict] = {}
    for r in rows:
        m = (r.get("maturity") or "")[:7]
        if not m or m < month or m > end:
            continue
        cell = out.setdefault(m, {"month": m, "balance": 0.0, "loans": []})
        cell["balance"] = _r2(cell["balance"] + r["balance"])
        cell["loans"].append({"id": r["id"], "lender": r["lender"], "loanNo": r["loanNo"], "entityName": r["entityName"], "balance": r["balance"], "maturity": r["maturity"]})
    return [out[k] for k in sorted(out)]


@router.get("/review")
async def review(month: Optional[str] = None, scope: dict = Depends(entity_scope)):
    """The review table for the month shown, ledger-driven per loan, with the
    totals by lender and by entity and the maturities ahead."""
    month = _month(month)
    key = (scope["user"]["email"], "review", month)
    hit = _SCAN.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < _SCAN_TTL:
        return hit[1]
    loans, entities = await asyncio.gather(_loan_rows(scope, month), _entities(scope))
    loans = [l for l in loans if l.get("is_active", True) is not False]
    names = {e["code"]: e.get("name") or "" for e in entities}
    codes = sorted({str(l.get("entity_code") or "") for l in loans if l.get("entity_code")})
    _, asof = month_bounds(month)
    _, m1 = month_bounds(shift_month(month, 1))
    _, m12 = month_bounds(shift_month(month, 12))
    t12_from, _ = month_bounds(shift_month(month, 11))
    m_from, m_to = month_bounds(month)
    reads, labels = [], []
    for c in codes:
        reads += [lambda c=c: _balance_sheet(scope, c, asof), lambda c=c: _balance_sheet(scope, c, m1), lambda c=c: _balance_sheet(scope, c, m12),
                  lambda c=c: _pnl(scope, c, m_from, m_to), lambda c=c: _pnl(scope, c, t12_from, asof)]
        labels += [f"{names.get(c) or c} balance sheet {asof}", f"{names.get(c) or c} balance sheet {m1}", f"{names.get(c) or c} balance sheet {m12}",
                   f"{names.get(c) or c} P&L {month}", f"{names.get(c) or c} P&L trailing 12"]
    results, notes = await gather_tolerant(reads, labels, lambda: None)
    results = [r if r is not None else ({} if i % 5 < 3 else []) for i, r in enumerate(results)]
    sheets, pnls = {}, {}
    for i, c in enumerate(codes):
        sheets[(c, "now")], sheets[(c, "m1")], sheets[(c, "m12")] = results[i * 5], results[i * 5 + 1], results[i * 5 + 2]
        pnls[(c, "month")], pnls[(c, "t12")] = results[i * 5 + 3], results[i * 5 + 4]
    rows = review_rows(loans, sheets, pnls, month, names)
    out = {
        "month": month, "asOf": asof, "monthAgo": m1, "yearAgo": m12, "trailingFrom": t12_from, "defaultCovenant": DEFAULT_COVENANT,
        "loans": rows, "byLender": _totals(rows, "lender", ""), "byEntity": _totals(rows, "entityCode", "entityName"), "maturities": maturities(rows, month),
        "notes": [f"Not read this time - {n}" for n in notes],
        "summary": {"loans": len(rows), "balance": _r2(sum(r["balance"] for r in rows)), "debtServiceT12": _r2(sum(r["debtServiceT12"] for r in rows)),
                    "belowCovenant": sum(1 for r in rows if r["belowCovenant"]), "entities": len(codes)},
        "lookedFor": LOOKED_FOR,
    }
    if notes:
        return out   # a partial review is shown, never cached as the answer
    _SCAN[key] = (now, out)
    return out


class LoanEdit(BaseModel):
    lender: Optional[str] = None
    ratePct: Optional[float] = None
    rateType: Optional[str] = None
    maturity: Optional[str] = None
    monthlyPi: Optional[float] = None
    covenantMin: Optional[float] = None
    notes: Optional[str] = None
    isActive: Optional[bool] = None


_EDIT_MAP = {"lender": "lender", "ratePct": "rate_pct", "rateType": "rate_type", "maturity": "maturity", "monthlyPi": "monthly_pi", "covenantMin": "covenant_min", "notes": "notes", "isActive": "is_active"}


@router.put("/{loan_id}")
async def edit_loan(loan_id: str, body: LoanEdit, month: Optional[str] = None, user: dict = Depends(_edit), scope: dict = Depends(entity_scope), db: Session = Depends(get_db)):
    """What the ledger cannot say - rate, maturity, monthly P&I, covenant
    minimum, lender - through the same row-save Data > Loans uses, so both
    screens edit one row."""
    month = _month(month)
    rows = await _loan_rows(scope, month)
    cur = next((r for r in rows if str(r.get("id")) == loan_id), None)
    if not cur:
        raise HTTPException(status_code=404, detail="Loan not found in your entities.")
    if body.rateType is not None and body.rateType not in ("fixed", "variable"):
        raise HTTPException(status_code=400, detail="Rate is fixed or variable.")
    if body.maturity and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", body.maturity):
        raise HTTPException(status_code=400, detail="Maturity must be a date (YYYY-MM-DD).")
    if body.covenantMin is not None and body.covenantMin < 0:
        raise HTTPException(status_code=400, detail="The covenant minimum cannot be negative.")
    row = {k: v for k, v in cur.items() if k not in ("ledger_balance", "ledger_asof")}
    for field, col in _EDIT_MAP.items():
        v = getattr(body, field)
        if v is None:
            continue
        if isinstance(v, str):
            v = v.strip()[:200]
        if field == "maturity" and v == "":
            v = None            # an empty date clears the maturity
        if field == "covenantMin" and v == 0:
            v = None            # 0 = back to the 1.35 default
        row[col] = v
    accounting_dashboard._require_configured()
    by = accounting_dashboard._display_name(db, user["email"])
    data = await asyncio.to_thread(accounting_dashboard._post_sync, {"op": "row-save", "table": "fin_loans", "row": row, "by": by})
    for k in [k for k in accounting_dashboard._CACHE if k.startswith("op=tables")]:
        accounting_dashboard._CACHE.pop(k, None)
    _forget(user["email"])
    return {"ok": True, "row": data.get("row") or row}
