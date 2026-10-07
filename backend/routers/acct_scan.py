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
import time
from typing import Any, Awaitable, Callable, Optional

from fastapi import HTTPException

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


async def party_months(locations: list[str], from_: str, to: str, party: str, *, sections: list[str],
                       accounts: Optional[list[str]] = None, title_match: str = "", title_exclude: str = "") -> Optional[list[dict]]:
    """Amount by entity x account x party x month, from ONE grouped read.

    Request (accounting app, internal key):
        GET /api/internal/reports/party-months
          from=YYYY-MM-DD  to=YYYY-MM-DD        the window (inclusive)
          party=customer | vendor               which dimension is the payer / payee
          locations=12027-1,15000,...           entity codes (posting entities, max 200)
          sections=revenue,other_income         P&L sections to read (or cogs,expense,other_expense)
          accounts=41101,41102                  optional: only these GL codes
          titleMatch=<regex>                    optional, case-insensitive, on the account title
          titleExclude=<regex>                  optional, case-insensitive, on the account title
          book=accrual                          optional (accrual default)
    Response 200:
        {"ok": true, "op": "party-months", "from": "...", "to": "...", "party": "customer",
         "rows": [{"entity": "12027-1", "account_no": "41101", "title": "Rental Income",
                   "section": "revenue", "party": "C00300", "party_name": "Rajesh J. Kadakia MD, Inc.",
                   "month": "2026-02", "debit": 0.0, "credit": 2275.0, "lines": 1}],
         "truncated": false}
      One row per (entity, account, party, month) with any posting; lines with
      no party are left out. `truncated` true when the app capped the rows.
    Errors: {"ok": false, "error": "..."} with 4xx/5xx.

    Returns the rows, or None when the op is not there (404 / 405 / 501, or
    an answer without a `rows` list) - the caller then scans. Other failures
    raise, so the caller can report the batch."""
    if not aggregate_available():
        return None
    params = {"from": from_, "to": to, "party": party, "locations": ",".join(locations), "sections": ",".join(sections),
              "accounts": ",".join(accounts) if accounts else None, "titleMatch": title_match or None, "titleExclude": title_exclude or None}
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
    if data.get("truncated"):
        return None          # too many rows for one answer: this batch is scanned instead
    return rows
