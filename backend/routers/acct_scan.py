"""Bounded ledger scans and the aggregate op (Oct 7, Charmi: MRI "Set Up
From the Ledger" timed out on most entity batches and then said "none had
one"; MRE "Add From the Ledger" sat at 133 of 142 entities for 5+ minutes).

Both scans read raw ledger lines through the accounting app, entity by
entity. Until the accounting app answers the aggregate op below, they stay
scans - but bounded:

  - every read (one entity, or one small batch of entities) has a hard time
    ceiling (`READ_CEILING`), and the whole scan a deadline (`SCAN_CEILING`):
    a read still waiting when the deadline passes is reported, never awaited;
  - reads run a few at a time (`PARALLEL`), each HTTP call in a thread
    (accounting._acct_get -> asyncio.to_thread), so the event loop never waits;
  - what could not be read is RETURNED - {code, name, reason} per entity - so
    the screen says "Read 37 of 142 entities - 105 could not be read" and
    offers Retry for just those, and never claims "none had one" while
    entities were skipped.

The aggregate op (`party_months`) is the clean fix: one GROUP BY in the
accounting database - amount by entity x account x customer/vendor x month -
instead of every posting line. Its contract is in `party_months`' docstring.
Until the accounting app ships it (404 / 501 / an answer without `rows`), the
scans fall back to the bounded reads, and the "not there" answer is
remembered for ten minutes so a scan does not ask on every batch.
"""
import asyncio
import re
import time
from typing import Any, Awaitable, Callable, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import require_module_grant
from routers import accounting

READ_CEILING = 45.0     # seconds one read (an entity, a batch) may take
SCAN_CEILING = 240.0    # seconds a whole scan may take; the rest is reported, not awaited
PARALLEL = 6            # reads in flight at once
AGGREGATE_PATH = "/api/internal/reports/party-months"
_AGG_DOWN: dict[str, float] = {}   # 'until': monotonic time to ask for the aggregate op again
_AGG_RETRY = 600.0


class Deadline:
    """The scan's deadline, shared by every read in it."""

    def __init__(self, seconds: Optional[float] = None):
        self.until = time.monotonic() + (SCAN_CEILING if seconds is None else seconds)

    def left(self) -> float:
        return self.until - time.monotonic()


def _reason(e: BaseException) -> str:
    if isinstance(e, asyncio.TimeoutError):
        return "took too long to read"
    return str(getattr(e, "detail", None) or e.__class__.__name__)[:200]


async def bounded(makers: list[Callable[[], Awaitable[Any]]], deadline: Deadline, *, ceiling: Optional[float] = None,
                  parallel: Optional[int] = None, on_done: Optional[Callable[[], None]] = None) -> list[tuple[bool, Any]]:
    """Run the reads `parallel` at a time, each under `ceiling` seconds and
    the scan's `deadline`. Returns one (ok, value-or-reason) per maker, in
    order. A read that fails fast (not a timeout) is tried once more while
    time is left; a read that times out is not (it would only time out again)."""
    ceiling = READ_CEILING if ceiling is None else ceiling
    sem = asyncio.Semaphore(max(1, PARALLEL if parallel is None else parallel))

    async def one(i: int) -> tuple[bool, Any]:
        try:
            async with sem:
                for attempt in (1, 2):
                    if deadline.left() <= 0.5:
                        return False, "not reached before the scan's time limit"
                    left = min(ceiling, deadline.left())
                    try:
                        return True, await asyncio.wait_for(makers[i](), timeout=left)
                    except asyncio.TimeoutError as e:
                        return False, _reason(e)
                    except HTTPException as e:
                        if e.status_code == 503:
                            raise            # not configured: the whole scan says so
                        if attempt == 2:
                            return False, _reason(e)
                    except Exception as e:  # noqa: BLE001 - retried once, then reported
                        if attempt == 2:
                            return False, _reason(e)
                return False, "could not be read"
        finally:
            if on_done:
                on_done()

    return list(await asyncio.gather(*[one(i) for i in range(len(makers))]))


def failure(e: dict, reason: str) -> dict:
    return {"code": e["code"], "name": e.get("name") or e["code"], "reason": reason}


def status_text(total: int, failed: list[dict]) -> str:
    """"Read 37 of 142 entities - 105 could not be read." (or "Read all 142 entities.")."""
    if not failed:
        return f"Read all {total} {'entity' if total == 1 else 'entities'}."
    read = total - len(failed)
    return f"Read {read} of {total} {'entity' if total == 1 else 'entities'} - {len(failed)} could not be read."


def finished_results(email: str, kind: str) -> list[dict]:
    """Every finished scan of this person and kind still kept (the full scan
    and any Retry of the entities it could not read), newest last."""
    from routers import accounting_loans
    jobs = [j for k, j in list(accounting_loans._JOBS.items()) if k[0] == email and k[1] == kind and j.result is not None]
    return [j.result for j in sorted(jobs, key=lambda j: j.finished or 0)]


# ── The aggregate op (accounting app) ────────────────────────────────────────
def aggregate_available() -> bool:
    return _AGG_DOWN.get("until", 0) <= time.monotonic()


def _mark_unavailable() -> None:
    _AGG_DOWN["until"] = time.monotonic() + _AGG_RETRY


KINDS = ("customer", "vendor", "employee")
SECTIONS = ("revenue", "other_income", "cogs", "expense", "other_expense", "asset", "liability", "equity")


async def _party_names(kind: str) -> dict[str, str]:
    """code -> name of the customers / vendors / employees (the rows carry codes only)."""
    try:
        data = await accounting._acct_get("/api/internal/reports/dimensions", {"kind": kind})
    except Exception:  # noqa: BLE001 - names are a nicety; the code stands in
        return {}
    return {str(v.get("code")): str(v.get("name") or "") for v in data.get("values") or [] if v.get("code")}


async def party_months(locations: list[str], from_: str, to: str, kind: str, *, sections: list[str],
                       accounts: Optional[list[str]] = None, words: Optional[list[str]] = None, book: Optional[str] = None) -> Optional[list[dict]]:
    """Amount by entity x account x party x month, from ONE grouped read.

    The accounting app's op (defined Oct 7 in the accounting repo):
        GET /api/internal/reports/party-months
          kind=customer | vendor | employee     (default customer)
          from=YYYY-MM-DD  to=YYYY-MM-DD        (at most three years)
          location=<code> | locations=<a,b,..>  the entities
          accounts=41101,41102                  GL codes
          words=rent,rental,lease               account title words
          sections=revenue,other_income         narrows (or alone selects) the accounts
          parties=C00300,...                    optional
          book=accrual | cash
        The account set is: in `accounts` OR title matches `words`; `sections`
        narrows it (or alone selects it).
        200 {"ok": true, "kind", "from", "to", "book", "locations",
             "rows": [{"location": "12027-1", "gl_code": "41101", "title": "Rental Income",
                       "section": "revenue", "party": "C00300", "month": "2026-02",
                       "debit": 0, "credit": 2275.0, "lines": 1}]}
        Party names come from /reports/dimensions (kind). About 1.2 s for
        twelve months of every entity.

    Returns the rows in the scans' shape ({entity, account_no, title, section,
    party, party_name, month, debit, credit, lines}), or None when the op is
    not there (404 / 405 / 501, or an answer without a `rows` list) - the
    caller then scans. Other failures raise, so the caller reports the batch."""
    if not aggregate_available():
        return None
    location, many = (locations[0], None) if len(locations) == 1 else (None, ",".join(locations))
    params = {"kind": kind, "from": from_, "to": to, "location": location, "locations": many, "sections": ",".join(sections) or None,
              "accounts": ",".join(accounts) if accounts else None, "words": ",".join(words) if words else None, "book": book}
    try:
        data = await accounting._acct_get(AGGREGATE_PATH, params)
    except accounting.UpstreamError as e:
        if e.upstream_status in (404, 405, 501):
            _mark_unavailable()
            return None
        raise
    rows = data.get("rows") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        _mark_unavailable()
        return None
    names = await _party_names(kind) if rows else {}
    return [{"entity": str(r.get("location") or ""), "account_no": str(r.get("gl_code") or ""), "title": r.get("title") or "",
             "section": r.get("section") or "", "party": str(r.get("party") or ""), "party_name": names.get(str(r.get("party") or ""), ""),
             "month": str(r.get("month") or "")[:7], "debit": r.get("debit") or 0, "credit": r.get("credit") or 0, "lines": r.get("lines") or 0}
            for r in rows]


# ── The Nexus proxy (Oct 7) ──────────────────────────────────────────────────
# GET /accounting/reports/party-months: the same op for any Nexus screen, with
# the caller's entity scope (a limited person reads only their entities, 403
# outside them). Every read is async HTTP in a thread (accounting._acct_get).
router = APIRouter(prefix="/accounting/reports", tags=["Accounting"], dependencies=[Depends(require_module_grant("accounting", "viewer"))])
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@router.get("/party-months")
async def party_months_route(from_: str = Query(..., alias="from"), to: str = Query(...), kind: str = "customer",
                             location: Optional[str] = None, locations: Optional[str] = None, accounts: Optional[str] = None,
                             words: Optional[str] = None, sections: Optional[str] = None, parties: Optional[str] = None,
                             book: Optional[str] = None, scope: dict = Depends(accounting.entity_scope)):
    """Amount by entity x account x customer / vendor / employee x month."""
    if kind not in KINDS:
        raise HTTPException(status_code=400, detail=f"kind must be one of {', '.join(KINDS)}")
    if not (_DATE.match(from_ or "") and _DATE.match(to or "")) or to < from_:
        raise HTTPException(status_code=400, detail="from and to are dates (YYYY-MM-DD), from first.")
    secs = accounting._csv(sections)
    if any(s not in SECTIONS for s in secs):
        raise HTTPException(status_code=400, detail=f"sections are {', '.join(SECTIONS)}")
    if not (accounting._csv(accounts) or accounting._csv(words) or secs):
        raise HTTPException(status_code=400, detail="Name the accounts, title words or sections to read.")
    location, locations = await accounting._limit(scope, location, locations)
    return await accounting._acct_get(AGGREGATE_PATH, {
        "kind": kind, "from": from_, "to": to, "location": location, "locations": locations, "accounts": accounts or None,
        "words": words or None, "sections": sections or None, "parties": parties or None, "book": accounting._book(book)})
