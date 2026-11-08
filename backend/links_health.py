"""Links health (11/08/2026): is every company link still reachable?

Once a week (reminders_loop, in a thread, switch key "links_health") every
ExternalLink's URL is fetched through safe_fetch - the shared SSRF guard: http
or https only, the host must resolve to public addresses only (no loopback,
RFC1918, link-local / cloud metadata, private IPv6), every redirect hop checked
the same way, TLS on.

Three answers per link (`check`):
  ok      - the host answered at all: 2xx, 3xx or 4xx (a login wall's 401,
            a bot wall's 403 or 429 still prove the site is serving);
  miss    - no answer (connection or TLS error, a public host that does not
            resolve) or a 5xx;
  skipped - the guard refused the URL (a private / VPN-only address, not
            http(s)): NOT a miss, nothing recorded - it cannot be checked
            from here.
A link marked down needs two misses in a row (a week apart): the first is
noted in the setting `links_health.pending`, the second sets
`unreachable_since`; an ok clears both. The pass runs the fetches on four
threads, 6 s per link, 3 minutes for the whole pass; whatever did not finish
is left exactly as it was for next week. No bell: Manage shows "Not reachable
since <date>" with Check Now (`check_now`, the same rule on one link).
"""
from __future__ import annotations

import json
import socket
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as FutureTimeout
from datetime import datetime, timezone, timedelta

import httpx

import job_switch
import safe_fetch

KEY = "links_health"
PENDING_KEY = "links_health.pending"
LAST_RUN_KEY = "links_health.last_run"
PER_LINK_SEC = 2.0        # safe_fetch's per-operation timeout; its whole-body deadline is 3x = 6 s
PASS_BUDGET_SEC = 180.0
WORKERS = 4
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
                         "Chrome/120.0 Safari/537.36 NexusLinkCheck/1.0",
           "Accept": "text/html,application/xhtml+xml,*/*;q=0.8"}
OK, MISS, SKIPPED = "ok", "miss", "skipped"
SKIPPED_TEXT = "Not checked - this address is only reachable from inside the network"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def check(url: str) -> str:
    """One GET under the guard -> OK | MISS | SKIPPED (see the module docstring).
    A page too large for the cap still answered."""
    try:
        got = safe_fetch.fetch(url, headers=HEADERS, timeout=PER_LINK_SEC, max_bytes=512_000)
    except safe_fetch.FetchRefused as e:
        if "larger than the cap" in str(e):
            return OK
        # The guard says "no public address" for a private host AND for a name
        # that does not resolve at all; only the second is the site's fault.
        return MISS if "does not resolve" in str(e) and _dns_failed(url) else SKIPPED
    except httpx.HTTPError:
        return MISS
    return MISS if got.status_code >= 500 else OK


def _dns_failed(url: str) -> bool:
    try:
        host = httpx.URL(url).host
    except (httpx.InvalidURL, TypeError):
        return False
    if not host:
        return False
    try:
        socket.getaddrinfo(host, None)
        return False
    except (socket.gaierror, UnicodeError):
        return True


def _setting(db, key: str):
    import models
    return db.get(models.NexusSetting, key)


def _read_pending(db) -> set:
    row = _setting(db, PENDING_KEY)
    try:
        return {int(x) for x in json.loads(row.value or "[]")} if row else set()
    except (TypeError, ValueError):
        return set()


def _write_setting(db, key: str, value: str) -> None:
    import models
    row = _setting(db, key)
    if row is None:
        db.add(models.NexusSetting(key=key, value=value))
    else:
        row.value = value


def _apply(link, result: str, pending: set, now: str) -> str:
    """The one mark-or-clear rule; returns what changed ("marked" / "cleared" / "")."""
    if result == SKIPPED:
        return ""
    if result == OK:
        pending.discard(link.id)
        if link.unreachable_since:
            link.unreachable_since = ""
            return "cleared"
        return ""
    if link.unreachable_since:
        return ""
    if link.id in pending:
        link.unreachable_since = now
        pending.discard(link.id)
        return "marked"
    pending.add(link.id)
    return ""


def check_now(db, link) -> str:
    """Manual Check Now on one link: the same rule, at once (the caller
    commits). A first miss is a strike, a second marks; an ok clears."""
    pending = _read_pending(db)
    result = check(link.url)
    _apply(link, result, pending, _now())
    _write_setting(db, PENDING_KEY, json.dumps(sorted(pending)))
    return result


def run_weekly(db, fetch=check, budget_sec: float = PASS_BUDGET_SEC, workers: int = WORKERS) -> dict:
    """Every company link once, four at a time, within the budget; two
    misses in a row mark it. A link the budget did not reach is left as it was."""
    import models
    links = db.query(models.ExternalLink).all()
    pending = _read_pending(db)
    now = _now()
    counts = {"marked": 0, "cleared": 0, "skipped": 0, "unfinished": 0}
    pool = ThreadPoolExecutor(max_workers=max(1, workers))
    futures = {pool.submit(fetch, l.url): l for l in links}
    try:
        for fut in as_completed(futures, timeout=budget_sec):
            link = futures.pop(fut)
            try:
                result = fut.result()
            except Exception:   # noqa: BLE001 - a fetcher that raises is "no answer"
                result = MISS
            if result == SKIPPED:
                counts["skipped"] += 1
            change = _apply(link, result, pending, now)
            if change:
                counts[change] += 1
    except FutureTimeout:
        counts["unfinished"] = len(futures)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    _write_setting(db, PENDING_KEY, json.dumps(sorted(pending)))
    _write_setting(db, LAST_RUN_KEY, now)
    db.commit()
    counts["pending"] = len(pending)
    return counts


def run_daily() -> dict:
    """The reminders_loop tick: runs the weekly pass when 7 days have gone by."""
    if job_switch.off(KEY):
        return {}
    import database
    db = database.SessionLocal()
    try:
        last = _setting(db, LAST_RUN_KEY)
        if last and last.value:
            try:
                if datetime.fromisoformat(last.value) > datetime.now(timezone.utc) - timedelta(days=7):
                    return {}
            except ValueError:
                pass
        out = run_weekly(db)
        print(f"[links health] weekly pass: {out}")
        return out
    except Exception as e:   # noqa: BLE001 - a background pass never takes the loop down
        db.rollback()
        print(f"[links health] pass failed: {e}")
        return {}
    finally:
        db.close()
