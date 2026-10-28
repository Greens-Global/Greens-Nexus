"""The per-job off switch for the built-in background automations (Neil,
Oct 28 2026: "automations should be managed ... a good ability to turn
these off"; spec 6.9 item 6, the follow-up the Workflows release left open).

ONE organization-wide list: the NexusSetting ``automations.off`` holds a JSON
list of job keys (the keys of ``workflows.automations.jobs()``), written by
a Global Admin from Workflows > Automations. Every loop's synchronous tick
starts with ``if job_switch.off("<key>"): return <empty>`` - the loop keeps
ticking and sleeping, it just does nothing while its key is in the list, so
switching back on needs no restart.

``off()`` reads through a process cache refreshed at most every 30 seconds
from its own short-lived session, so forty loops asking every minute cost
one query per half minute. It never raises: on any error (no database, no
table yet, a bad row) the answer is False and the job stays ON - the switch
can only ever turn work off, never break it. Dependency-free on purpose:
``database`` and ``models`` are imported inside the functions so every loop
module can import this at the top without a cycle.
"""
from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone

KEY = "automations.off"
CACHE_SEC = 30.0

_lock = threading.Lock()
_cache: dict = {"at": None, "keys": frozenset()}


def _parse(value) -> list[str]:
    """The stored list, as a list of distinct non-empty strings in order."""
    try:
        raw = json.loads(value) if isinstance(value, str) and value else []
    except (TypeError, ValueError):
        return []
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for k in raw:
        if isinstance(k, str) and k.strip() and k.strip() not in out:
            out.append(k.strip())
    return out


def _read_keys() -> frozenset:
    import database
    import models
    db = database.SessionLocal()
    try:
        row = db.get(models.NexusSetting, KEY)
        return frozenset(_parse(row.value if row is not None else ""))
    finally:
        db.close()


def invalidate() -> None:
    """Forget the cache; the next ``off()`` reads the database."""
    with _lock:
        _cache["at"] = None
        _cache["keys"] = frozenset()


def off(key: str) -> bool:
    """True when the job is switched off. Never raises; an error means ON."""
    try:
        now = time.monotonic()
        with _lock:
            at = _cache["at"]
            if at is None or now - at >= CACHE_SEC:
                try:
                    _cache["keys"] = _read_keys()
                except Exception:
                    # Unreachable database, missing table, broken row: every
                    # job runs, and the next read waits a full window so a
                    # dead database is not asked on every tick.
                    _cache["keys"] = frozenset()
                _cache["at"] = now
            return str(key or "") in _cache["keys"]
    except Exception:
        return False


def off_keys(db) -> list[str]:
    """The keys switched off, read from the caller's session (no cache)."""
    import models
    row = db.get(models.NexusSetting, KEY)
    return _parse(row.value if row is not None else "")


def set_off(db, key: str, off_now: bool, actor: str = "") -> list[str]:
    """Add or remove one key; the caller commits. Returns the new list."""
    import models
    key = str(key or "").strip()
    keys = off_keys(db)
    if off_now and key and key not in keys:
        keys.append(key)
    elif not off_now and key in keys:
        keys = [k for k in keys if k != key]
    row = db.get(models.NexusSetting, KEY)
    if row is None:
        row = models.NexusSetting(key=KEY)
        db.add(row)
    row.value = json.dumps(keys)
    row.updated_by = (actor or "").lower()
    row.updated_at = datetime.now(timezone.utc).isoformat()
    invalidate()
    return keys
