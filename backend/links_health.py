"""Links health (11/08/2026): is every company link still reachable?

Once a week (reminders_loop, in a thread, switch key "links_health") every
ExternalLink's URL is fetched through safe_fetch - the shared SSRF guard: http
or https only, the host must resolve to public addresses only (no loopback,
RFC1918, link-local / cloud metadata, private IPv6), every redirect hop checked
the same way, TLS on. A 2xx or 3xx answer is reachable and clears
`unreachable_since`; anything else, or no answer, is a miss. A link marked
down needs two misses in a row (one week apart): the first miss is noted in
the setting `links_health.pending`, the second sets `unreachable_since`. No
bell: Manage shows "Not reachable since <date>" with Check Now
(`check_now`, the same fetch, one link, marks or clears at once).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone, timedelta

import httpx

import job_switch
import safe_fetch

KEY = "links_health"
PENDING_KEY = "links_health.pending"
LAST_RUN_KEY = "links_health.last_run"
TIMEOUT = 8.0
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
                         "Chrome/120.0 Safari/537.36 NexusLinkCheck/1.0",
           "Accept": "text/html,application/xhtml+xml,*/*;q=0.8"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def refused_reason(url: str) -> str:
    """Why this URL is never fetched ("" = allowed): not http(s), no host, or a
    host that resolves to anything but public addresses. The same rule
    safe_fetch applies on every hop; this is the up-front answer."""
    try:
        parsed = httpx.URL(url or "")
    except (httpx.InvalidURL, TypeError):
        return "not a URL"
    if parsed.scheme not in ("http", "https"):
        return "only http and https links are checked"
    if not parsed.host:
        return "no host"
    if not safe_fetch.public_addresses(parsed.host):
        return "host does not resolve to a public address"
    return ""


def reachable(url: str) -> bool:
    """One GET under the guard. A page too large for the cap still answered,
    so it counts as reachable; a refused URL or a network error does not."""
    if refused_reason(url):
        return False
    try:
        got = safe_fetch.fetch(url, headers=HEADERS, timeout=TIMEOUT, max_bytes=512_000)
    except safe_fetch.FetchRefused as e:
        return "larger than the cap" in str(e)
    except httpx.HTTPError:
        return False
    return 200 <= got.status_code < 400


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


def check_now(db, link) -> bool:
    """Manual Check Now on one link: marks or clears at once."""
    ok = reachable(link.url)
    link.unreachable_since = "" if ok else (link.unreachable_since or _now())
    return ok


def run_weekly(db, fetch=reachable) -> dict:
    """Every company link once; two misses in a row mark it."""
    import models
    pending = _read_pending(db)
    marked = cleared = 0
    now = _now()
    for link in db.query(models.ExternalLink).all():
        if fetch(link.url):
            pending.discard(link.id)
            if link.unreachable_since:
                link.unreachable_since = ""
                cleared += 1
            continue
        if link.unreachable_since:
            continue
        if link.id in pending:
            link.unreachable_since = now
            pending.discard(link.id)
            marked += 1
        else:
            pending.add(link.id)
    _write_setting(db, PENDING_KEY, json.dumps(sorted(pending)))
    _write_setting(db, LAST_RUN_KEY, now)
    db.commit()
    return {"marked": marked, "cleared": cleared, "pending": len(pending)}


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
