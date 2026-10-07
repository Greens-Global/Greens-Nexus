"""Accounting -> Loans & Financing (Neil and Charmi, 10/02: "Nothing has been
done on Loans & Financing for me to review").

The loans table (fin_loans, in the accounting database, kept through the
dashboard's row-save) was empty on production, so every loan screen opened
blank. This router fills it FROM THE LEDGER and gives the owners a review:

  + Add > From the Ledger  every ACTIVE entity the caller may read (or the
                           ones picked), its balance sheet as of today, and
                           one proposed loan per liability account whose
                           title says loan, mortgage, note payable, line of
                           credit, financing, names a lender, or is owed to
                           another entity (intercompany). Tick + Create writes
                           fin_loans rows through the same upsert Data > Loans
                           uses, with balance_source 'ledger' - nothing typed.
                           Re-running proposes only what is missing.
  + Add > Manual           a loan that is not in Intacct: lender, entity,
                           loan number, original principal, balance, rate,
                           maturity, monthly payment, Internal / External.
  Review                   per loan, for the period shown: the balance owed
                           as of its last day, principal paid (the DEBITS to
                           the loan's liability account in the period), the
                           interest paid (the loan's own interest expense
                           account), debt service, the property's trailing-12
                           NOI and DSCR against the covenant minimum (1.35
                           unless typed - Charmi, 09/25).

Oct 6 (Charmi and Neil, 10/03-10/04 feedback):
  - "I added a few of the loans and they do not show up": the review was
    cached per person for five minutes in THIS worker. A loan added under
    Data > Loans (another router), or a create served by another worker,
    left the cached "no loans" answer standing. The review is no longer
    cached as a whole - only the ledger reads under it are (accounting.
    _acct_get, five minutes), and the loan list is read fresh every time.
  - Principal and interest come from the ledger per loan: principal = the
    debits to the loan's liability account in the period; interest = the
    net debits to ITS interest expense account - wired by hand on the loan,
    or matched by the words and numbers the two account titles share
    ("RJK - F&M - 6870 - (Mortgage)" <-> "RJK - F&M - 6870 Interest"). Only
    an entity's leftover interest accounts are shared, by balance, among
    the loans no account matched; the screen says which (wired / matched /
    shared).
  - Pulled as of today by default; a loan whose balance is zero as of the
    date (paid off) or that is marked inactive is "closed" and the screen
    hides it unless Customize > Show Closed Loans. A loan whose account has
    never been used in its entity is NOT closed - it is shown with "Check
    the wiring" (hiding it would be the same "it does not show up" again).
  - Intercompany: "Due to <entity>", intercompany / related-party / officer
    and shareholder payables are loans (internal), with or without a loan
    word.
  - The scan reads ACTIVE entities only - the historical ones ("(H)" in the
    name or an H before the number, the Reports EntitiesPicker's rule) are
    left out unless asked for - and only the entities picked, when any are.
  - Balances are shown as the positive amount owed; a liability with a debit
    balance is flagged for a hover note, never flipped.
  - Original principal: the first credit on the loan's account (an opening
    balance entry counts), typed over when the ledger does not have it.
    Nexus keeps that, the interest account, Internal / External and the
    Egnyte folders in accounting_loan_settings - fin_loans takes no new
    columns from Nexus.

Every figure comes through the accounting app's internal API (routers/
accounting.py is the reference): balance sheet, trial balance and the ledger
search per entity, the dashboard's tables op for the loan rows. Nexus never
opens the accounting database. A person limited to certain entities (Neil,
Sep 25) sees only the loans of those entities; every ledger read goes
through `_limit`.

Live run, 10/02 (317 entities, 811 liability accounts):
  - Credit cards ("OSM - Capital One - 5431" on 22603) matched on the lender's
    name. A lender-name-only match now counts only from GL 25000 up (the
    long-term range: 26xxx mortgages, 27xxx LOC / auto / credit union loans);
    a 2xxxx below that needs a loan word.
  - The ledger sends every amount as debits less credits: a mortgage owed is
    NEGATIVE (GE Five Star 26013 = -11,245,000), a positive liability is a
    debit balance (Golden 1 26023 = +14,500,000). `owed` = -amount.
  - A parent entity rolls its children up ("(AM) (G) 910 S. El Camino Real"
    = 12027-1 + 12027-2), so the same loan was proposed twice. Only LEAF
    entities are scanned.
  - 105 s is more than one request may take (Azure drops it at 230 s): the
    scan is a background job on the request's loop - the first GET starts it
    and answers 202 with the progress, later GETs the same until the result
    (kept 30 minutes, cleared on create); a failed job answers 424 once and
    the next GET starts it again.
"""
import asyncio
import calendar
import contextvars
import json
import os
import re
import time
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Optional
from urllib.parse import unquote, urlparse

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

import database
import models
from auth import require_module_grant
from database import get_db
from routers import accounting, accounting_dashboard
from routers.accounting import _csv, _limit, entity_scope
from services import egnyte as egnyte_svc

router = APIRouter(prefix="/accounting/loans", tags=["Accounting"], dependencies=[Depends(require_module_grant("accounting", "viewer"))])
_edit = require_module_grant("accounting", "editor")

DEFAULT_COVENANT = 1.35
_MONTH = re.compile(r"^\d{4}-\d{2}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_GL = re.compile(r"^[\w.\-]{1,40}$")
_SCAN_TTL = 300.0          # kept for callers that read it; the review is no longer cached as a whole
_RESULT_TTL = 1800.0       # a finished scan job
_PARTIAL_TTL = 60.0        # a scan with entities not read: shown, then re-run
_FIRST_TTL = 6 * 3600.0    # the first credit on a loan's account barely ever changes
_SCAN: dict[tuple, tuple[float, Any]] = {}
_FIRST: dict[tuple, tuple[float, Optional[dict]]] = {}
LENDER_ONLY_MIN_GL = 25000
# Ledger reads in flight at once - one semaphore PER EVENT LOOP (a module-level
# asyncio.Semaphore binds to the first loop that waits on it and then raises
# "bound to a different event loop" from any other; TestClient runs each
# request on its own loop, a worker restart does the same) and per size: a
# request reads 4 at a time, a background scan job 8.
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
        _PARALLEL.set(8)
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


# Historical entities (Charmi, 10/04: "Set Up From the Ledger reads 279
# entities"): the Reports EntitiesPicker's rule (reportModel.isHistoricalEntity)
# - "(H)" in the name or an H before the number (H12001). Their books are
# closed; scanning them is most of the wait and all of the old loans.
_HIST = re.compile(r"\(\s*h\s*\)", re.I)


def is_historical(e: dict) -> bool:
    return bool(_HIST.search(e.get("name") or "")) or bool(re.match(r"^h\d", e.get("code") or "", re.I))


def active_entities(entities: list[dict], historical: bool = False) -> tuple[list[dict], int]:
    """(the entities to read, how many historical ones were left out)."""
    if historical:
        return list(entities), 0
    keep = [e for e in entities if not is_historical(e)]
    return keep, len(entities) - len(keep)


def _r2(v) -> float:
    return round(float(v or 0) + 0.0, 2)


def _num(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


# ── Which liability accounts are loans ───────────────────────────────────────
# A loan is a liability whose title or number says so (loan, mortgage, note
# payable, line of credit, LOC, HELOC, financing, promissory, borrowing) or
# names a lender (F&M, Citi, Chase, BofA, Wells, SBA, PNC, US Bank, a bank or
# credit union, EIDL / PPP) - but a lender's name ALONE counts only from GL
# 25000 up, the long-term range (26xxx mortgages, 27xxx LOC / auto / credit
# union loans seen live): "OSM - Capital One - 5431" on 22603, "GC - Chase -
# 2305" on 22301 and "US Bank - Amazon - 4863" on 22114 are credit cards.
# Working-capital and payroll balances are never loans, whatever else the
# title says, unless it says "loan": accounts payable, credit cards, payroll,
# accrued, deferred, unearned, security and customer deposits, clearing /
# suspense.
#
# Oct 6 (Charmi: "intercompany loans are missing"): money owed to another
# entity - "Due to <entity>", intercompany, related party, shareholder,
# member, officer, affiliate - is an INTERCOMPANY loan with or without a loan
# word (it used to need one, which dropped every "Due to" account).
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
_INTERCO = re.compile(r"intercompany|inter-company|\bi/c\b|due to|\bdue from\b|related part|shareholder|member loan|\bmember\b|officer|affiliate")
_STRIP = re.compile(r"\b(loans?|payable|mortgage|notes?|n/p|line of credit|loc|heloc|financing|equipment|promissory|intercompany|inter-company|due|from|to|the|a|an|of|-|–|:)\b", re.I)
LOOKED_FOR = ["Loan", "Mortgage", "Note Payable / Notes", "Line of Credit / LOC / HELOC", "Financing / Promissory / Borrowing",
              "Due to another entity / Intercompany / Related Party",
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
    lender = ""
    for rx, name in LENDER_NAMES:
        if rx.search(low):
            lender = name
            break
    if lender in ("Bank", "Credit Union"):
        lender = _guess_lender(t) or lender      # "City National Bank - Gr. FLP LOC": the bank's own name
    if interco:
        return {"kind": "intercompany", "lender": names_entity or lender or _guess_lender(t)}
    if not says_loan:
        n = _gl_number(code)
        if not _LENDER_ANY.search(low) or n is None or n < LENDER_ONLY_MIN_GL:
            return None
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


# ── Which expense account carries a loan's interest ─────────────────────────
# Oct 6 (Charmi: "interest = the matching interest expense account per
# loan"). The entity's interest expense accounts are its cost accounts with
# "interest" in the title (not interest income). A loan takes the one whose
# title shares the most distinctive words and numbers with the loan's own
# account title, lender and number - the bank, the last four digits, the
# property's initials ("RJK - F&M - 6870 - (Mortgage)" <-> "RJK - F&M - 6870
# Interest"). A tie is no match: guessing between two equal candidates is how
# the wiring went wrong.
_INTEREST = re.compile(r"interest")
_NOT_INTEREST_EXPENSE = re.compile(r"income|receivable|revenue|earned")
_TOKEN = re.compile(r"[a-z0-9&]+")
_GENERIC = {"interest", "expense", "expenses", "exp", "int", "loan", "loans", "mortgage", "note", "notes", "payable", "the", "and", "of", "on",
            "to", "from", "for", "line", "credit", "loc", "heloc", "long", "term", "short", "current", "portion", "financing", "bank", "paid",
            "pmt", "payment", "payments", "mtg", "llc", "inc", "co"}


def _tokens(*texts: str) -> set[str]:
    out: set[str] = set()
    for t in texts:
        for w in _TOKEN.findall((t or "").lower()):
            w = w.strip("&")
            if len(w) >= 2 and w not in _GENERIC:
                out.add(w)
    return out


def interest_candidates(tb: dict[str, dict]) -> dict[str, str]:
    """{GL code: title} of the interest EXPENSE accounts in a trial balance."""
    return {code: a["title"] for code, a in tb.items()
            if a.get("section") in _COSTS and _INTEREST.search((a.get("title") or "").lower()) and not _NOT_INTEREST_EXPENSE.search((a.get("title") or "").lower())}


def match_interest(loan_title: str, lender: str, loan_no: str, candidates: dict[str, str]) -> Optional[str]:
    """The candidate sharing the most words with the loan; None on a tie or nothing shared."""
    want = _tokens(loan_title, lender, loan_no)
    if not want:
        return None
    scored = []
    for code, title in candidates.items():
        common = want & _tokens(title)
        score = sum(2 if w.isdigit() and len(w) >= 3 else 1 for w in common)
        if score:
            scored.append((score, code))
    if not scored:
        return None
    scored.sort(reverse=True)
    if len(scored) > 1 and scored[0][0] == scored[1][0]:
        return None
    return scored[0][1]


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


async def _picked(scope: dict, entities: Optional[str]) -> Optional[set[str]]:
    """The entities picked on screen with their sub-entities, or None (all).
    An entity outside the caller's limit is refused (403), never ignored."""
    codes = _csv(entities)
    if not codes:
        return None
    await _limit(scope, None, ",".join(codes))
    return await accounting._with_children(set(codes))


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
    (the screen shows it as a positive figure with a hover note)."""
    return _r2(-amount) if section == "liability" else _r2(amount)


async def _trial(scope: dict, entity: str, from_: str, to: str) -> dict[str, dict]:
    """GL code -> {title, section, opening, debit, credit, closing} of one
    entity for a window: the accounting app's trial balance (opening before
    `from`, the movement inside, the closing at `to`; debits positive)."""
    location, _ = await _limit(scope, entity, None)
    async with _sem():
        data = await accounting._acct_get("/api/internal/reports/trial-balance", {"from": from_, "to": to, "location": location})
    out: dict[str, dict] = {}
    for r in data.get("rows") or []:
        code = str(r.get("account_no") or "").strip()
        if code:
            out[code] = {"title": r.get("title") or "", "section": r.get("section") or "", "opening": _r2(r.get("opening")),
                         "debit": _r2(r.get("debit")), "credit": _r2(r.get("credit")), "closing": _r2(r.get("closing"))}
    return out


def _line(x: dict) -> dict:
    return {"date": str(x.get("entry_date") or "")[:10], "entryId": x.get("entry_id") or "", "entryNo": x.get("entry_no") or "", "doc": x.get("doc") or "",
            "description": x.get("description") or "", "memo": x.get("memo") or "", "account": x.get("gl_code") or "", "accountName": x.get("account_name") or "",
            "journal": x.get("journal") or "", "vendor": x.get("vendor_name") or "", "debit": _r2(x.get("debit")), "credit": _r2(x.get("credit"))}


async def _lines(location: str, gl: str, from_: Optional[str], to: str, limit: int = 1000) -> dict:
    """Every posted line on one account in one entity (newest first)."""
    async with _sem():
        data = await accounting._acct_get("/api/internal/search", {"account": gl, "location": location, "from": from_, "to": to, "book": "accrual", "offset": 0, "limit": limit})
    rows = [_line(x) for x in data.get("rows") or []]
    total = int(data.get("total") or 0)
    return {"account": gl, "total": total, "debit": _r2(data.get("debit")), "credit": _r2(data.get("credit")), "lines": rows, "truncated": total > len(rows)}


async def _first_credit(scope: dict, entity: str, gl: str, to: str, given: bool = False) -> Optional[dict]:
    """The loan's original principal as the ledger has it: the FIRST credit on
    its account in its entity (the funding, or the opening balance entry); for
    a loan given, the first debit. Two reads (the count, then the oldest page)
    kept for six hours - it does not move."""
    key = (entity, gl, given)
    hit = _FIRST.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < _FIRST_TTL:
        return hit[1]
    location, _ = await _limit(scope, entity, None)
    if not location:
        return None
    async with _sem():
        head = await accounting._acct_get("/api/internal/search", {"account": gl, "location": location, "to": to, "book": "accrual", "offset": 0, "limit": 1})
    total = int(head.get("total") or 0)
    found = None
    if total:
        offset = max(0, total - 50)
        async with _sem():
            tail = await accounting._acct_get("/api/internal/search", {"account": gl, "location": location, "to": to, "book": "accrual", "offset": offset, "limit": 50})
        for x in reversed(tail.get("rows") or []):          # newest first: walk from the oldest
            amt = _r2(x.get("debit") if given else x.get("credit"))
            if amt > 0:
                found = {"amount": amt, "date": str(x.get("entry_date") or "")[:10], "entryId": x.get("entry_id") or ""}
                break
    _FIRST[key] = (now, found)
    return found


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


def pnl_from_trial(tb: dict[str, dict]) -> list[dict]:
    """A trial balance's income and cost accounts as P&L lines (income =
    credits less debits, costs = debits less credits) - the same NOI without
    a second read."""
    out = []
    for code, a in tb.items():
        if a.get("section") in _INCOME:
            out.append({"section": a["section"], "account_no": code, "title": a.get("title") or "", "amount": _r2(a["credit"] - a["debit"])})
        elif a.get("section") in _COSTS:
            out.append({"section": a["section"], "account_no": code, "title": a.get("title") or "", "amount": _r2(a["debit"] - a["credit"])})
    return out


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


def _day(v: str, what: str) -> str:
    v = (v or "").strip()
    try:
        if not _DATE.match(v):
            raise ValueError
        date.fromisoformat(v)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{what} must be a date (YYYY-MM-DD)")
    return v


def period(from_: Optional[str], to: Optional[str], month: Optional[str] = None) -> tuple[str, str]:
    """The window shown: a month (older callers), or from / to; by default
    this month up to TODAY (Charmi, 10/04: "pull loan data as of the current
    date")."""
    if month:
        return month_bounds(_month(month))
    t = _day(to, "to") if to else date.today().isoformat()
    f = _day(from_, "from") if from_ else f"{t[:8]}01"
    if f > t:
        raise HTTPException(status_code=400, detail="from must be on or before to")
    return f, t


def trailing_from(to: str) -> str:
    """The first day of the twelve months ending `to`."""
    d = date.fromisoformat(to)
    try:
        back = d.replace(year=d.year - 1)
    except ValueError:                     # 02/29
        back = d.replace(year=d.year - 1, day=28)
    return (back + timedelta(days=1)).isoformat()


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


def _clear_tables_cache() -> None:
    for k in [k for k in accounting_dashboard._CACHE if k.startswith("op=tables")]:
        accounting_dashboard._CACHE.pop(k, None)


# ── What Nexus keeps per loan (accounting_loan_settings) ────────────────────
_SETTING_FIELDS = ("interest_account", "original_principal", "internal", "docs_path", "statements_path", "loan_type", "stress_excluded")
LOAN_TYPES = ("term", "line_of_credit")
_LOC = re.compile(r"line of credit|\bloc\b|heloc|credit line|\brevolv", re.I)


def guess_loan_type(*texts: str) -> str:
    """A line of credit by its words (Charmi, Oct 7: Draws only for lines of
    credit): "LOC", "line of credit", "HELOC", "credit line", "revolving" in
    the GL title (or the lender / notes); anything else is a term loan."""
    return "line_of_credit" if any(_LOC.search(t or "") for t in texts) else "term"


def loan_type_of(setting: dict, *texts: str) -> tuple[str, bool]:
    """(type, guessed): the type typed under Change Loan, else the guess."""
    typed = str((setting or {}).get("loan_type") or "")
    if typed in LOAN_TYPES:
        return typed, False
    return guess_loan_type(*texts), True


def _audit_sync(user: dict, action: str, resource_id: str, details: dict) -> None:
    db = database.SessionLocal()
    try:
        db.add(models.AuditLog(timestamp=datetime.now(timezone.utc).isoformat(timespec="seconds"), user_email=user.get("email") or "",
                               user_role=user.get("role", "") or "", action=action, resource_type="accounting_loan", resource_id=str(resource_id)[:200],
                               details=json.dumps(details, default=str)[:4000]))
        db.commit()
    finally:
        db.close()


def _settings_sync(ids: list[str]) -> dict[str, dict]:
    if not ids:
        return {}
    db = database.SessionLocal()
    try:
        rows = db.query(models.AccountingLoanSetting).filter(models.AccountingLoanSetting.loan_id.in_(ids)).all()
        return {r.loan_id: {f: getattr(r, f) for f in _SETTING_FIELDS} for r in rows}
    finally:
        db.close()


def _save_settings_sync(loan_id: str, entity: str, patch: dict, by: str) -> None:
    db = database.SessionLocal()
    try:
        row = db.query(models.AccountingLoanSetting).filter(models.AccountingLoanSetting.loan_id == loan_id).first()
        if not row:
            row = models.AccountingLoanSetting(loan_id=loan_id, interest_account="", docs_path="", statements_path="")
            db.add(row)
        row.entity_code = entity
        for k, v in patch.items():
            setattr(row, k, v)
        row.updated_by = by
        row.updated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        db.commit()
    finally:
        db.close()


def _egnyte_web(path: str) -> Optional[str]:
    if not path or not os.getenv("EGNYTE_DOMAIN", "").strip():
        return None
    return f"{egnyte_svc.base_url()}/app/index.do#storage/files/1{egnyte_svc.norm(path)}"


def egnyte_folder(value: Optional[str]) -> str:
    """A folder in the company Egnyte: a /Shared/... or /Private/... path, or
    a link copied from Egnyte's address bar (...#storage/files/1/Shared/...)
    on the company's own Egnyte domain - anything else is refused."""
    s = (value or "").strip()
    if not s:
        return ""
    if re.match(r"^https?://", s, re.I):
        host = (urlparse(s).hostname or "").lower()
        domain = os.getenv("EGNYTE_DOMAIN", "").strip()
        own = (urlparse(egnyte_svc.base_url()).hostname or "").lower() if domain else ""
        if not own or host != own:
            raise HTTPException(status_code=400, detail=f"Paste a link to the company Egnyte{f' ({own})' if own else ''}, or the folder's path.")
        m = re.search(r"#storage/files/1(/[^?]*)", s)
        if not m:
            raise HTTPException(status_code=400, detail="That Egnyte link is not a folder - open the folder in Egnyte and copy the address.")
        s = unquote(m.group(1))
    p = egnyte_svc.norm(s)
    if not re.match(r"^/(shared|private)(/|$)", p, re.I):
        raise HTTPException(status_code=400, detail="An Egnyte folder starts with /Shared or /Private.")
    return p[:500]


# ── Proposals ───────────────────────────────────────────────────────────────
def _asof(month: Optional[str], asof: Optional[str]) -> str:
    if asof:
        return _day(asof, "asof")
    if month:
        return month_bounds(_month(month))[1]
    return date.today().isoformat()


def _scan_key(scope: dict, asof: str, picked: list[str], historical: bool) -> tuple:
    return (scope["user"]["email"], "loans", asof, ",".join(picked), bool(historical))


async def _scan(scope: dict, asof: str, picked: list[str], historical: bool, job: Optional[ScanJob] = None) -> dict:
    """The liability accounts of every ACTIVE leaf entity (the picked ones
    when any are) as of `asof`, classified. Accounts with nothing owed (the
    loans paid off long ago) are not proposed, nor historical "(H)" accounts
    unless historical is asked for."""
    all_entities = await _entities(scope)
    if picked:
        reach = await accounting._with_children(set(picked))
        all_entities = [e for e in all_entities if e["code"] in reach]
    live, historical_skipped = active_entities(all_entities, historical)
    entities, parents = leaf_entities(live)
    names = {e["code"]: e.get("name") or "" for e in all_entities}
    if job:
        job.total = len(entities)
    sheets, notes = await gather_tolerant([(lambda e=e: _balance_sheet(scope, e["code"], asof)) for e in entities],
                                          [f"{e.get('name') or e['code']} ({e['code']}) balance sheet" for e in entities], dict,
                                          on_done=job.tick if job else None)
    proposals, liabilities, paid_off = [], 0, 0
    for e, sheet in zip(entities, sheets):
        for code, a in sorted(sheet.items()):
            if a["section"] != "liability":
                continue
            liabilities += 1
            if not historical and _HIST.search(a["title"] or ""):
                continue
            hit_ = classify_loan_account(a["section"], code, a["title"], names, e["code"])
            if not hit_:
                continue
            if abs(a["owed"]) < 0.005:
                paid_off += 1
                continue
            proposals.append({"entityCode": e["code"], "entityName": names.get(e["code"]) or e["code"], "glAccount": code, "title": a["title"],
                              "balance": _r2(abs(a["owed"])), "owed": a["owed"], "debitBalance": a["owed"] < 0, "lender": hit_["lender"], "kind": hit_["kind"],
                              "internal": hit_["kind"] == "intercompany", "balanceSource": "ledger"})
    out = {"asOf": asof, "month": asof[:7], "entitiesScanned": len(entities), "parentsSkipped": parents, "historicalSkipped": historical_skipped,
           "liabilityAccounts": liabilities, "paidOff": paid_off, "proposals": proposals, "lookedFor": LOOKED_FOR,
           "notes": [f"Not read this time - {n}" for n in notes]}
    if job:
        job.cacheable = not notes   # a partial scan is shown, never kept as the answer
    return out


def _forget(email: str) -> None:
    for k in [k for k in _SCAN if k[0] == email]:
        _SCAN.pop(k, None)
    forget_jobs(email, "loans")


def _dismissed_sync() -> dict[tuple[str, str], dict]:
    """(entity, GL) -> the removed loan (Oct 7): + Add > From the Ledger does
    not offer these again unless asked."""
    db = database.SessionLocal()
    try:
        return {(r.entity_code, r.gl_account): {"lender": r.lender or "", "by": r.dismissed_by or "", "at": r.dismissed_at or ""}
                for r in db.query(models.AccountingLoanDismissed).all()}
    finally:
        db.close()


def _undismiss_sync(keys: list[tuple[str, str]]) -> None:
    if not keys:
        return
    db = database.SessionLocal()
    try:
        for entity, gl in keys:
            db.query(models.AccountingLoanDismissed).filter(models.AccountingLoanDismissed.entity_code == entity,
                                                            models.AccountingLoanDismissed.gl_account == gl).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def _with_status(scan: dict, existing: list[dict], dismissed: Optional[dict] = None) -> dict:
    have = {_set_up_key(r): r for r in existing}
    dismissed = dismissed or {}
    rows = []
    for p in scan["proposals"]:
        row = dict(p)
        key = (p["entityCode"], p["glAccount"])
        cur = have.get(key)
        row["status"] = "set_up" if cur else "dismissed" if key in dismissed else "new"
        row["loanId"] = cur.get("id") if cur else None
        row["loanType"] = guess_loan_type(p.get("title") or "", p.get("lender") or "")
        if row["status"] == "dismissed":
            row["removedBy"], row["removedAt"] = dismissed[key]["by"], dismissed[key]["at"]
        rows.append(row)
    return {**scan, "proposals": rows, "setUp": sum(1 for r in rows if r["status"] == "set_up"), "missing": sum(1 for r in rows if r["status"] == "new"),
            "removed": sum(1 for r in rows if r["status"] == "dismissed")}


@router.get("/proposals")
async def proposals(month: Optional[str] = None, asof: Optional[str] = None, entities: Optional[str] = None, historical: bool = False, scope: dict = Depends(entity_scope)):
    """One proposed loan per loan-like liability account, with the ones
    already in fin_loans marked as set up (idempotent: re-running proposes
    only what is missing). The scan runs in the background: 202 with the
    progress until it is done, then the result."""
    a = _asof(month, asof)
    picked = sorted(_csv(entities))
    if picked:
        await _limit(scope, None, ",".join(picked))
    job = scan_job(_scan_key(scope, a, picked, historical), lambda job: _scan(scope, a, picked, historical, job))
    if job.result is None:
        return JSONResponse(status_code=202, content=job.progress())
    existing, dismissed = await asyncio.gather(_loan_rows(scope, a[:7]), asyncio.to_thread(_dismissed_sync))
    return _with_status(job.result, existing, dismissed)


class CreateItem(BaseModel):
    entityCode: str
    glAccount: str
    # Optional at setup (Charmi, Oct 7) - can be done later under Change Loan.
    docsPath: Optional[str] = None
    statementsPath: Optional[str] = None
    loanType: Optional[str] = None


class CreateBody(BaseModel):
    month: Optional[str] = None
    asof: Optional[str] = None
    entities: Optional[str] = None
    historical: bool = False
    items: list[CreateItem]


def _loan_no(gl: str, title: str) -> str:
    m = re.search(r"#\s*(\w[\w-]{2,})", title or "")
    return (m.group(1) if m else gl)[:40]


@router.post("/create", status_code=201)
async def create_from_ledger(body: CreateBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope), db: Session = Depends(get_db)):
    """Write the ticked proposals as fin_loans rows through the dashboard's
    row-save - loan number from the account, GL account, balance from the
    ledger. An account already set up is skipped, never duplicated."""
    a = _asof(body.month, body.asof)
    picked = sorted(_csv(body.entities))
    if not body.items:
        raise HTTPException(status_code=400, detail="Tick at least one loan to create.")
    if picked:
        await _limit(scope, None, ",".join(picked))
    scan, existing = await asyncio.gather(scan_result(_scan_key(scope, a, picked, body.historical), lambda job: _scan(scope, a, picked, body.historical, job)),
                                          _loan_rows(scope, a[:7]))
    have = {_set_up_key(r) for r in existing}
    by_key = {(p["entityCode"], p["glAccount"]): p for p in scan["proposals"]}
    accounting_dashboard._require_configured()
    by = accounting_dashboard._display_name(db, user["email"])
    for it in body.items:
        if it.loanType and it.loanType not in LOAN_TYPES:
            raise HTTPException(status_code=400, detail="Loan type is Term Loan or Line of Credit.")
    folders = {(it.entityCode.strip(), it.glAccount.strip()): (egnyte_folder(it.docsPath), egnyte_folder(it.statementsPath)) for it in body.items}
    created, skipped, restored = [], [], []
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
        row = {"id": str(uuid.uuid4()), "loan_no": _loan_no(p["glAccount"], p["title"]), "kind": p["kind"], "lender": p["lender"] or p["title"][:80], "entity_code": p["entityCode"],
               "gl_account": p["glAccount"], "balance_source": "ledger", "balance": p["balance"], "rate_pct": 0, "rate_type": "fixed", "maturity": None,
               "monthly_pi": 0, "dscr": None, "covenant_min": None, "is_active": True, "notes": f"Set up from the ledger ({p['title']}) as of {scan['asOf']}"}
        await asyncio.to_thread(accounting_dashboard._post_sync, {"op": "row-save", "table": "fin_loans", "row": row, "by": by})
        docs, statements = folders[key]
        patch: dict[str, Any] = {}
        if docs:
            patch["docs_path"] = docs
        if statements:
            patch["statements_path"] = statements
        if it.loanType:
            patch["loan_type"] = it.loanType
        if patch:
            await asyncio.to_thread(_save_settings_sync, row["id"], key[0], patch, user["email"])
        have.add(key)
        restored.append(key)
        created.append({**p, "loanNo": row["loan_no"], "loanId": row["id"]})
    # Set up again = no longer removed (the way back from Delete, Oct 7).
    await asyncio.to_thread(_undismiss_sync, restored)
    _clear_tables_cache()
    _forget(user["email"])
    return {"created": created, "skipped": skipped}


class ManualBody(BaseModel):
    lender: str
    entityCode: str
    loanNo: str = ""
    originalPrincipal: Optional[float] = None
    balance: float = 0
    ratePct: Optional[float] = None
    rateType: str = "fixed"
    maturity: Optional[str] = None
    monthlyPayment: Optional[float] = None
    internal: bool = False
    notes: str = ""
    docsPath: Optional[str] = None
    statementsPath: Optional[str] = None
    loanType: Optional[str] = None


@router.post("/manual", status_code=201)
async def create_manual(body: ManualBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope), db: Session = Depends(get_db)):
    """+ Add > Manual (Charmi, 10/04): a loan that is not in Intacct. A
    fin_loans row kept by hand (balance typed, no GL account), plus the
    original principal and Internal / External Nexus keeps beside it."""
    lender = body.lender.strip()[:120]
    entity = body.entityCode.strip()
    if not lender:
        raise HTTPException(status_code=400, detail="Give the loan a lender.")
    if not entity:
        raise HTTPException(status_code=400, detail="Pick the entity that owes the loan.")
    await _limit(scope, entity, None)
    if entity not in {e["code"] for e in await _entities(scope)}:
        raise HTTPException(status_code=400, detail=f"Entity {entity} is not on the ledger.")
    if body.rateType not in ("fixed", "variable"):
        raise HTTPException(status_code=400, detail="Rate is fixed or variable.")
    maturity = _day(body.maturity, "maturity") if body.maturity else None
    if body.loanType and body.loanType not in LOAN_TYPES:
        raise HTTPException(status_code=400, detail="Loan type is Term Loan or Line of Credit.")
    docs, statements = egnyte_folder(body.docsPath), egnyte_folder(body.statementsPath)
    for v, what in ((body.balance, "balance"), (body.originalPrincipal, "original principal"), (body.ratePct, "rate"), (body.monthlyPayment, "monthly payment")):
        if v is not None and v < 0:
            raise HTTPException(status_code=400, detail=f"The {what} cannot be negative.")
    accounting_dashboard._require_configured()
    by = accounting_dashboard._display_name(db, user["email"])
    row = {"id": str(uuid.uuid4()), "loan_no": body.loanNo.strip()[:40], "kind": "intercompany" if body.internal else "external", "lender": lender, "entity_code": entity,
           "gl_account": "", "balance_source": "manual", "balance": _r2(body.balance), "rate_pct": body.ratePct or 0, "rate_type": body.rateType, "maturity": maturity,
           "monthly_pi": body.monthlyPayment or 0, "dscr": None, "covenant_min": None, "is_active": True, "notes": body.notes.strip()[:200] or "Added by hand in Nexus (not in Intacct)"}
    await asyncio.to_thread(accounting_dashboard._post_sync, {"op": "row-save", "table": "fin_loans", "row": row, "by": by})
    await asyncio.to_thread(_save_settings_sync, row["id"], entity, {"original_principal": body.originalPrincipal, "internal": bool(body.internal),
                                                                     "docs_path": docs, "statements_path": statements, "loan_type": body.loanType or ""}, user["email"])
    _clear_tables_cache()
    _forget(user["email"])
    return {"ok": True, "loanId": row["id"], "row": row}


# ── Review ──────────────────────────────────────────────────────────────────
def review_rows(loans: list[dict], settings: dict, tbs: dict, names: dict, originals: Optional[dict] = None) -> list[dict]:
    """The review figures per loan. `tbs` is {(entity, 'period'|'t12'): {gl:
    trial balance row}} for the window shown and the twelve months ending on
    its last day; `settings` is {loan id: what Nexus keeps}; `originals` is
    {loan id: the ledger's first credit}.

    Balance owed = minus the closing of the loan's liability account (plus
    for a loan given: an asset). Principal paid = the DEBITS to that account
    in the window - a payment, never netted against a draw (draws are their
    own figure). Interest paid = the net debits to the loan's interest
    account (wired / matched; see match_interest); an account several loans
    share is split by balance. DSCR is the entity's NOI over the entity's
    whole debt service - the figure a lender looks at."""
    originals = originals or {}
    by_entity: dict[str, list[dict]] = defaultdict(list)
    for l in loans:
        by_entity[str(l.get("entity_code") or "")].append(l)
    out = []
    for entity, group in by_entity.items():
        tp, ty = tbs.get((entity, "period")) or {}, tbs.get((entity, "t12")) or {}
        n = noi(pnl_from_trial(ty))
        cands = {**interest_candidates(ty), **interest_candidates(tp)}
        figs = []
        for l in group:
            lid = str(l.get("id") or "")
            s = settings.get(lid) or {}
            gl = str(l.get("gl_account") or "").strip()
            given = (l.get("kind") or "external") == "given"
            ledger = (l.get("balance_source") or "manual") == "ledger" and bool(gl)
            ap, ay = (tp.get(gl), ty.get(gl)) if ledger else (None, None)
            pay, draw = ("credit", "debit") if given else ("debit", "credit")
            if ledger and (ap or ay):
                a = ap or ay
                owed_ = _r2(a["closing"] if given else -a["closing"])
                wiring = "ok"
                paid, drawn = (ap or {}).get(pay, 0.0), (ap or {}).get(draw, 0.0)
                paid12 = (ay or {}).get(pay, 0.0)
                gl_title = a.get("title") or ""
            elif ledger:
                owed_, wiring, paid, drawn, paid12, gl_title = 0.0, "missing", None, None, None, ""
            else:
                owed_, wiring, paid, drawn, paid12, gl_title = _r2(_num(l.get("balance"))), "manual", None, None, None, ""
            active = l.get("is_active", True) is not False
            closed = (not active) or (wiring in ("ok", "manual") and abs(owed_) < 0.005)
            figs.append({"loan": l, "s": s, "gl": gl, "glTitle": gl_title, "given": given, "owed": owed_, "wiring": wiring, "closed": closed,
                         "paid": paid, "drawn": drawn, "paid12": paid12})
        # Interest: wired, then matched, then the entity's leftover interest accounts shared.
        claimed: set[str] = set()
        for f in figs:
            wired = str(f["s"].get("interest_account") or "").strip()
            if wired:
                f["accounts"], f["interestSource"] = (wired,), "wired"
                claimed.add(wired)
        for f in figs:
            if "accounts" in f or f["given"]:
                continue
            m = match_interest(f["glTitle"], f["loan"].get("lender") or "", str(f["loan"].get("loan_no") or ""), {c: t for c, t in cands.items() if c not in claimed})
            if m:
                f["accounts"], f["interestSource"] = (m,), "matched"
                claimed.add(m)
        # The leftovers go to the open ledger loans only: a hand-kept loan is not
        # in Intacct, a paid-off one pays no interest, an unwired one is unknown.
        leftover = tuple(sorted(c for c in cands if c not in claimed))
        for f in figs:
            if "accounts" not in f:
                share = leftover and not f["given"] and f["wiring"] == "ok" and not f["closed"]
                f["accounts"], f["interestSource"] = (leftover, "shared") if share else ((), "none")
        groups: dict[tuple, list[dict]] = defaultdict(list)
        for f in figs:
            if f["accounts"]:
                groups[f["accounts"]].append(f)
        for accts, members in groups.items():
            def net(tb, accts=accts, members=members):
                sign = -1 if members[0]["given"] else 1
                return _r2(sum(sign * ((tb.get(c) or {}).get("debit", 0.0) - (tb.get(c) or {}).get("credit", 0.0)) for c in accts))
            month_i, t12_i = net(tp), net(ty)
            total = sum(max(0.0, m["owed"]) for m in members)
            for m in members:
                share = (max(0.0, m["owed"]) / total) if total > 0 else 1.0 / len(members)
                m["interest"], m["interest12"], m["shared"] = _r2(month_i * share), _r2(t12_i * share), len(members) - 1
                m["share"] = round(share, 6)
        entity_ds = 0.0
        for f in figs:
            f.setdefault("interest", None)
            f.setdefault("interest12", None)
            f.setdefault("shared", 0)
            f.setdefault("share", 1.0)
            f["ds"] = _r2((f["paid"] or 0) + (f["interest"] or 0))
            f["ds12"] = _r2((f["paid12"] or 0) + (f["interest12"] or 0))
            entity_ds += f["ds12"]
        cov = dscr(n["noi"], entity_ds)
        for f in figs:
            l, s = f["loan"], f["s"]
            lid = str(l.get("id") or "")
            minimum = _num(l.get("covenant_min")) or DEFAULT_COVENANT
            led = originals.get(lid)
            typed = s.get("original_principal")
            internal = s.get("internal")
            titles = {c: (tp.get(c) or ty.get(c) or {}).get("title") or cands.get(c, "") for c in f["accounts"]}
            ltype, guessed = loan_type_of(s, f["glTitle"], l.get("lender") or "", l.get("notes") or "")
            out.append({
                "id": l.get("id"), "loanNo": l.get("loan_no") or "", "lender": l.get("lender") or "", "kind": l.get("kind") or "external",
                "internal": bool(internal) if internal is not None else (l.get("kind") == "intercompany"), "internalTyped": internal is not None,
                "entityCode": entity, "entityName": names.get(entity) or entity, "glAccount": f["gl"], "glTitle": f["glTitle"],
                "balanceSource": l.get("balance_source") or "manual", "wiring": f["wiring"], "closed": f["closed"], "isActive": l.get("is_active", True) is not False,
                "balance": _r2(abs(f["owed"])), "owed": f["owed"], "debitBalance": f["owed"] < -0.005,
                "originalPrincipal": _r2(typed) if typed is not None else (led["amount"] if led else None),
                "originalPrincipalLedger": led["amount"] if led else None, "originalPrincipalDate": led["date"] if led else None, "originalPrincipalEdited": typed is not None,
                "principalPaid": f["paid"], "draws": f["drawn"], "interestPaid": f["interest"], "debtService": f["ds"],
                "principalPaidT12": f["paid12"], "interestPaidT12": f["interest12"], "debtServiceT12": f["ds12"],
                "interestAccount": ",".join(f["accounts"]), "interestAccounts": [{"code": c, "title": titles[c]} for c in f["accounts"]],
                "interestSource": f["interestSource"], "interestSharedWith": f["shared"], "sharedWith": f["shared"],
                # The part of the interest account(s) this loan carries (1 unless
                # shared by balance): the payments table scales by it, so its
                # Interest Paid is the row's (Oct 7, 38,891.83 vs 61,554.19).
                "interestShare": f["share"],
                "loanType": ltype, "lineOfCredit": ltype == "line_of_credit", "loanTypeGuessed": guessed, "stressExcluded": bool(s.get("stress_excluded")),
                "entityDebtServiceT12": _r2(entity_ds), "noiT12": n["noi"], "incomeT12": n["income"], "operatingExpensesT12": n["operatingExpenses"],
                "dscr": cov, "covenantMin": round(minimum, 2), "covenantTyped": bool(_num(l.get("covenant_min"))), "belowCovenant": cov is not None and cov < minimum and not f["closed"],
                "ratePct": _num(l.get("rate_pct")) or None, "rateType": l.get("rate_type") or "", "maturity": str(l.get("maturity"))[:10] if l.get("maturity") else None,
                "monthlyPayment": _num(l.get("monthly_pi")) or None, "monthlyPi": _num(l.get("monthly_pi")) or None, "notes": l.get("notes") or "",
                "docsPath": s.get("docs_path") or "", "statementsPath": s.get("statements_path") or "",
                "docsUrl": _egnyte_web(s.get("docs_path") or ""), "statementsUrl": _egnyte_web(s.get("statements_path") or ""),
            })
    out.sort(key=lambda r: ((r["lender"] or "").lower(), (r["entityName"] or "").lower(), r["loanNo"]))
    return out


def _totals(rows: list[dict], key: str, label: str) -> list[dict]:
    groups: dict[str, dict] = {}
    for r in rows:
        g = groups.setdefault(r[key] or "(none)", {key: r[key] or "", "label": r[label] if label else (r[key] or "(no lender)"), "loans": 0, "balance": 0.0, "debtServiceT12": 0.0, "interestT12": 0.0, "noiT12": 0.0, "_entities": set()})
        g["loans"] += 1
        g["balance"] = _r2(g["balance"] + r["balance"])
        g["debtServiceT12"] = _r2(g["debtServiceT12"] + (r["debtServiceT12"] or 0))
        g["interestT12"] = _r2(g["interestT12"] + (r["interestPaidT12"] or 0))
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
async def review(from_: Optional[str] = Query(default=None, alias="from"), to: Optional[str] = None, month: Optional[str] = None,
                 entities: Optional[str] = None, scope: dict = Depends(entity_scope)):
    """The review table for the window shown (this month up to today unless
    asked), every loan of the caller's entities (or the ones picked) with a
    `closed` flag - the screen hides those unless Show Closed Loans - and the
    totals by lender and by entity and the maturities ahead, of the open
    loans. Read fresh every time (Oct 6): only the ledger reads under it are
    cached, so a loan added anywhere shows on the next open."""
    f, t = period(from_, to, month)
    t12 = trailing_from(t)
    picked = await _picked(scope, entities)
    loans, ents = await asyncio.gather(_loan_rows(scope, t[:7]), _entities(scope))
    if picked is not None:
        loans = [l for l in loans if str(l.get("entity_code") or "") in picked]
    names = {e["code"]: e.get("name") or "" for e in ents}
    settings = await asyncio.to_thread(_settings_sync, [str(l.get("id")) for l in loans if l.get("id")])
    codes = sorted({str(l.get("entity_code") or "") for l in loans if l.get("entity_code")})
    reads, labels = [], []
    for c in codes:
        reads += [lambda c=c: _trial(scope, c, f, t), lambda c=c: _trial(scope, c, t12, t)]
        labels += [f"{names.get(c) or c} trial balance {f} - {t}", f"{names.get(c) or c} trial balance trailing 12"]
    results, notes = await gather_tolerant(reads, labels, dict)
    tbs = {}
    for i, c in enumerate(codes):
        tbs[(c, "period")], tbs[(c, "t12")] = results[i * 2], results[i * 2 + 1]
    rows = review_rows(loans, settings, tbs, names)
    # The original principal from the ledger: open ledger loans not typed over.
    need = [r for r in rows if r["wiring"] == "ok" and not r["closed"] and not r["originalPrincipalEdited"]]
    firsts, _ = await gather_tolerant([(lambda r=r: _first_credit(scope, r["entityCode"], r["glAccount"], t, r["kind"] == "given")) for r in need],
                                      [f"{r['lender']} original principal" for r in need], lambda: None)
    originals = {str(r["id"]): o for r, o in zip(need, firsts) if o}
    if originals:
        rows = review_rows(loans, settings, tbs, names, originals)
    open_rows = [r for r in rows if not r["closed"]]
    return {
        "from": f, "to": t, "asOf": t, "month": t[:7], "trailingFrom": t12, "defaultCovenant": DEFAULT_COVENANT,
        "loans": rows, "byLender": _totals(open_rows, "lender", ""), "byEntity": _totals(open_rows, "entityCode", "entityName"), "maturities": maturities(open_rows, t[:7]),
        "notes": [f"Not read this time - {n}" for n in notes],
        "summary": {"loans": len(open_rows), "closed": len(rows) - len(open_rows), "balance": _r2(sum(r["balance"] for r in open_rows)),
                    "debtServiceT12": _r2(sum(r["debtServiceT12"] for r in open_rows)), "belowCovenant": sum(1 for r in open_rows if r["belowCovenant"]),
                    "entities": len({r["entityCode"] for r in open_rows})},
        "lookedFor": LOOKED_FOR,
    }


@router.get("/accounts")
async def loan_accounts(entity: str, to: Optional[str] = None, scope: dict = Depends(entity_scope)):
    """The accounts a loan of `entity` can be wired to (Change Loan): its
    balance sheet accounts for the principal and its cost accounts for the
    interest, interest accounts first - from the trial balance of the three
    years to `to`."""
    t = _day(to, "to") if to else date.today().isoformat()
    start = (date.fromisoformat(t) - timedelta(days=3 * 365)).isoformat()
    tb = await _trial(scope, entity.strip(), start, t)
    principal = [{"code": c, "title": a["title"], "section": a["section"], "balance": _r2(abs(a["closing"])), "owed": owed(a["section"], a["closing"])}
                 for c, a in tb.items() if a["section"] in ("liability", "asset")]
    interest = interest_candidates(tb)
    costs = [{"code": c, "title": a["title"], "interest": c in interest, "amount": _r2(a["debit"] - a["credit"])} for c, a in tb.items() if a["section"] in _COSTS]
    by_code = lambda x: (x["code"])  # noqa: E731
    principal.sort(key=lambda x: (x["section"] != "liability", by_code(x)))
    costs.sort(key=lambda x: (not x["interest"], by_code(x)))
    return {"entity": entity, "to": t, "principal": principal, "interest": costs}


_BY_ENTITY_FIELDS = ("id", "lender", "loanNo", "entityCode", "entityName", "balance", "ratePct", "rateType", "maturity", "monthlyPayment",
                     "dscr", "covenantMin", "belowCovenant", "debtServiceT12", "noiT12", "loanType", "internal",
                     "docsPath", "docsUrl", "statementsPath", "statementsUrl")


@router.get("/by-entity/{code}")
async def loans_by_entity(code: str, to: Optional[str] = None, scope: dict = Depends(entity_scope)):
    """The open loans of one entity (and its sub-entities) for another module -
    Asset Management's property (Charmi 10/03 #25, "wire this data into Asset
    Mgt"): lender, loan #, balance as of `to` (today by default), rate,
    maturity, monthly payment, DSCR, trailing-12 debt service and the Egnyte
    folders. Behind the same accounting entity scope as the Loans screen: an
    entity the caller may not read answers 403."""
    entity = (code or "").strip()
    if not entity or not _GL.match(entity):
        raise HTTPException(status_code=400, detail="An entity code is needed.")
    t = _day(to, "to") if to else date.today().isoformat()
    data = await review(from_=f"{t[:8]}01", to=t, month=None, entities=entity, scope=scope)
    loans = [{k: r.get(k) for k in _BY_ENTITY_FIELDS} for r in data["loans"] if not r["closed"]]
    return {"entityCode": entity, "asOf": t, "trailingFrom": data["trailingFrom"], "loans": loans,
            "totals": {"loans": len(loans), "balance": _r2(sum(x["balance"] or 0 for x in loans)),
                       "monthlyPayment": _r2(sum(x["monthlyPayment"] or 0 for x in loans)), "debtServiceT12": _r2(sum(x["debtServiceT12"] or 0 for x in loans))},
            "notes": data["notes"]}


@router.get("/noi")
async def entity_noi(entities: str, from_: Optional[str] = Query(default=None, alias="from"), to: Optional[str] = None, scope: dict = Depends(entity_scope)):
    """NOI per entity for a window (the Stress Test's Annualized YTD basis,
    Oct 7): income less operating costs - interest, depreciation and
    amortization left out, the review's rule - and the same annualized
    (x 365 / days in the window). From January 1 of `to`'s year by default."""
    t = _day(to, "to") if to else date.today().isoformat()
    f = _day(from_, "from") if from_ else f"{t[:4]}-01-01"
    if f > t:
        raise HTTPException(status_code=400, detail="from must be on or before to")
    codes = list(dict.fromkeys(_csv(entities)))[:300]
    if not codes:
        raise HTTPException(status_code=400, detail="Name at least one entity.")
    await _limit(scope, None, ",".join(codes))
    days = (date.fromisoformat(t) - date.fromisoformat(f)).days + 1
    results, notes = await gather_tolerant([(lambda c=c: _trial(scope, c, f, t)) for c in codes], [f"{c} trial balance {f} - {t}" for c in codes], dict)
    out = {}
    for c, tb in zip(codes, results):
        n = noi(pnl_from_trial(tb))
        out[c] = {**n, "annualized": _r2(n["noi"] * 365 / days) if days > 0 else None}
    return {"from": f, "to": t, "days": days, "entities": out, "notes": [f"Not read this time - {n}" for n in notes]}


@router.get("/{loan_id}/history")
async def loan_history(loan_id: str, from_: Optional[str] = Query(default=None, alias="from"), to: Optional[str] = None, interest: Optional[str] = None,
                       scope: dict = Depends(entity_scope)):
    """The ledger lines behind a loan (Charmi, 10/04: the drill-down and the
    whole payment history): every line on its principal account in its
    entity, and on its interest account(s) (`interest`, as the review row
    names them), from `from` (the beginning when not given) to `to`. Each line
    carries its entry id, which opens the whole entry."""
    t = _day(to, "to") if to else date.today().isoformat()
    f = _day(from_, "from") if from_ else None
    rows = await _loan_rows(scope, t[:7])
    cur = next((r for r in rows if str(r.get("id")) == loan_id), None)
    if not cur:
        raise HTTPException(status_code=404, detail="Loan not found in your entities.")
    entity = str(cur.get("entity_code") or "")
    gl = str(cur.get("gl_account") or "").strip()
    codes = [c for c in _csv(interest) if _GL.match(c)][:6]
    empty = {"account": "", "total": 0, "debit": 0.0, "credit": 0.0, "lines": [], "truncated": False}
    if not entity:
        return {"loanId": loan_id, "entityCode": "", "glAccount": gl, "from": f, "to": t, "principal": empty, "interest": [], "note": "The loan has no entity, so there is no ledger to read."}
    location, _ = await _limit(scope, entity, None)
    makers = ([lambda: _lines(location, gl, f, t)] if gl else []) + [(lambda c=c: _lines(location, c, f, t)) for c in codes]
    got, notes = await gather_tolerant(makers, ([f"GL {gl}"] if gl else []) + [f"GL {c}" for c in codes], lambda: dict(empty))
    principal = got[0] if gl else empty
    return {"loanId": loan_id, "entityCode": entity, "glAccount": gl, "from": f, "to": t, "principal": principal, "interest": got[1:] if gl else got,
            "notes": [f"Not read this time - {n}" for n in notes]}


class LoanEdit(BaseModel):
    lender: Optional[str] = None
    loanNo: Optional[str] = None
    glAccount: Optional[str] = None
    ratePct: Optional[float] = None
    rateType: Optional[str] = None
    maturity: Optional[str] = None
    monthlyPi: Optional[float] = None
    monthlyPayment: Optional[float] = None
    covenantMin: Optional[float] = None
    notes: Optional[str] = None
    isActive: Optional[bool] = None
    balance: Optional[float] = None
    # Kept by Nexus (accounting_loan_settings). Sent as null to go back to
    # automatic (interest account, original principal, internal).
    interestAccount: Optional[str] = None
    originalPrincipal: Optional[float] = None
    internal: Optional[bool] = None
    docsPath: Optional[str] = None
    statementsPath: Optional[str] = None
    loanType: Optional[str] = None          # term | line_of_credit; '' = guess from the GL title


_EDIT_MAP = {"lender": "lender", "loanNo": "loan_no", "ratePct": "rate_pct", "rateType": "rate_type", "maturity": "maturity", "monthlyPi": "monthly_pi",
             "monthlyPayment": "monthly_pi", "covenantMin": "covenant_min", "notes": "notes", "isActive": "is_active", "balance": "balance"}


@router.put("/{loan_id}")
async def edit_loan(loan_id: str, body: LoanEdit, month: Optional[str] = None, user: dict = Depends(_edit), scope: dict = Depends(entity_scope), db: Session = Depends(get_db)):
    """What the ledger cannot say - loan name (lender) and number, rate,
    maturity, monthly payment, covenant minimum - through the same row-save
    Data > Loans uses, so both screens edit one row; the principal account
    (the GL wiring); and what Nexus keeps beside it: the interest account,
    the original principal, Internal / External and the Egnyte folders."""
    sent = body.model_fields_set
    rows = await _loan_rows(scope, (month and _month(month)) or date.today().isoformat()[:7])
    cur = next((r for r in rows if str(r.get("id")) == loan_id), None)
    if not cur:
        raise HTTPException(status_code=404, detail="Loan not found in your entities.")
    if body.rateType is not None and body.rateType not in ("fixed", "variable"):
        raise HTTPException(status_code=400, detail="Rate is fixed or variable.")
    if body.maturity:
        _day(body.maturity, "maturity")
    if body.covenantMin is not None and body.covenantMin < 0:
        raise HTTPException(status_code=400, detail="The covenant minimum cannot be negative.")
    for v, what in ((body.ratePct, "rate"), (body.monthlyPi, "monthly payment"), (body.monthlyPayment, "monthly payment"), (body.originalPrincipal, "original principal"), (body.balance, "balance")):
        if v is not None and v < 0:
            raise HTTPException(status_code=400, detail=f"The {what} cannot be negative.")
    if "lender" in sent and not (body.lender or "").strip():
        raise HTTPException(status_code=400, detail="The loan needs a name.")
    gl = (body.glAccount or "").strip()
    if gl and not _GL.match(gl):
        raise HTTPException(status_code=400, detail="The principal account is a GL number.")
    ia = (body.interestAccount or "").strip()
    if ia and not _GL.match(ia):
        raise HTTPException(status_code=400, detail="The interest account is a GL number.")
    setting_patch: dict[str, Any] = {}
    if "interestAccount" in sent:
        setting_patch["interest_account"] = ia
    if "originalPrincipal" in sent:
        setting_patch["original_principal"] = body.originalPrincipal
    if "internal" in sent:
        setting_patch["internal"] = body.internal
    if "docsPath" in sent:
        setting_patch["docs_path"] = egnyte_folder(body.docsPath)
    if "statementsPath" in sent:
        setting_patch["statements_path"] = egnyte_folder(body.statementsPath)
    if "loanType" in sent:
        if body.loanType and body.loanType not in LOAN_TYPES:
            raise HTTPException(status_code=400, detail="Loan type is Term Loan or Line of Credit.")
        setting_patch["loan_type"] = body.loanType or ""

    row = {k: v for k, v in cur.items() if k not in ("ledger_balance", "ledger_asof")}
    changed = False
    for field, col in _EDIT_MAP.items():
        v = getattr(body, field)
        if v is None:
            continue
        if field == "balance" and (row.get("balance_source") or "manual") == "ledger" and not ("glAccount" in sent and not gl):
            continue            # a ledger loan's balance is read, never typed
        if isinstance(v, str):
            v = v.strip()[:200 if field != "loanNo" else 40]
        if field == "maturity" and v == "":
            v = None            # an empty date clears the maturity
        if field == "covenantMin" and v == 0:
            v = None            # 0 = back to the 1.35 default
        row[col] = v
        changed = True
    if "glAccount" in sent:
        # Wiring the principal account makes the balance the ledger's; taking
        # it off keeps the loan, kept by hand from here.
        row["gl_account"] = gl
        row["balance_source"] = "ledger" if gl else "manual"
        changed = True
    by = accounting_dashboard._display_name(db, user["email"])
    data: dict = {}
    if changed:
        accounting_dashboard._require_configured()
        data = await asyncio.to_thread(accounting_dashboard._post_sync, {"op": "row-save", "table": "fin_loans", "row": row, "by": by})
        _clear_tables_cache()
    if setting_patch:
        await asyncio.to_thread(_save_settings_sync, loan_id, str(cur.get("entity_code") or ""), setting_patch, user["email"])
    if changed or setting_patch:
        changes = {k: getattr(body, k) for k in sorted(sent)}
        await asyncio.to_thread(_audit_sync, user, "accounting_loan_changed", loan_id,
                                {"lender": row.get("lender"), "entity": cur.get("entity_code"), "glAccount": row.get("gl_account"), "changes": changes})
    _forget(user["email"])
    return {"ok": True, "row": data.get("row") or row}


def _remove_loan_sync(loan_id: str, cur: dict, dismiss: bool, user: dict) -> None:
    """What Nexus keeps beside a removed loan goes with it - its amortization
    schedule, stress scenarios, settings (interest account, Egnyte folders,
    type, stress exclusion) - and a ledger loan is remembered as removed so
    the ledger setup does not offer it again. Audited."""
    entity, gl = str(cur.get("entity_code") or ""), str(cur.get("gl_account") or "").strip()
    db = database.SessionLocal()
    try:
        db.query(models.AccountingLoanSchedule).filter(models.AccountingLoanSchedule.loan_id == loan_id).delete(synchronize_session=False)
        db.query(models.AccountingLoanStressScenario).filter(models.AccountingLoanStressScenario.loan_id == loan_id).delete(synchronize_session=False)
        db.query(models.AccountingLoanSetting).filter(models.AccountingLoanSetting.loan_id == loan_id).delete(synchronize_session=False)
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        if dismiss:
            row = db.query(models.AccountingLoanDismissed).filter(models.AccountingLoanDismissed.entity_code == entity,
                                                                  models.AccountingLoanDismissed.gl_account == gl).first()
            if not row:
                row = models.AccountingLoanDismissed(id=str(uuid.uuid4()), entity_code=entity, gl_account=gl)
                db.add(row)
            row.loan_id, row.lender, row.title = loan_id, str(cur.get("lender") or "")[:200], str(cur.get("notes") or "")[:200]
            row.dismissed_by, row.dismissed_at = user.get("email") or "", now
        db.add(models.AuditLog(timestamp=now, user_email=user.get("email") or "", user_role=user.get("role", "") or "", action="accounting_loan_removed",
                               resource_type="accounting_loan", resource_id=loan_id,
                               details=json.dumps({"lender": cur.get("lender"), "loanNo": cur.get("loan_no"), "entity": entity, "glAccount": gl,
                                                   "balanceSource": cur.get("balance_source"), "dismissed": dismiss}, default=str)))
        db.commit()
    finally:
        db.close()


@router.delete("/{loan_id}")
async def delete_loan(loan_id: str, user: dict = Depends(_edit), scope: dict = Depends(entity_scope), db: Session = Depends(get_db)):
    """Remove a loan (Charmi, Oct 7: "there should be a delete option"). The
    fin_loans row is deleted where it was created - the accounting app, through
    the same row-delete Data > Loans uses. A loan set up from the ledger is
    remembered as removed (entity + GL account) so + Add > From the Ledger
    does not offer it again; ticking it there under Show Removed sets it up
    again. Its schedule, scenarios and settings go with it."""
    rows = await _loan_rows(scope, date.today().isoformat()[:7])
    cur = next((r for r in rows if str(r.get("id")) == loan_id), None)
    if not cur:
        raise HTTPException(status_code=404, detail="Loan not found in your entities.")
    await _limit(scope, str(cur.get("entity_code") or "") or None, None)
    accounting_dashboard._require_configured()
    by = accounting_dashboard._display_name(db, user["email"])
    await asyncio.to_thread(accounting_dashboard._post_sync, {"op": "row-delete", "table": "fin_loans", "match": {"id": loan_id}, "by": by})
    _clear_tables_cache()
    dismiss = (cur.get("balance_source") or "manual") == "ledger" and bool(str(cur.get("gl_account") or "").strip())
    await asyncio.to_thread(_remove_loan_sync, loan_id, cur, dismiss, user)
    _forget(user["email"])
    return {"ok": True, "loanId": loan_id, "dismissed": dismiss}
