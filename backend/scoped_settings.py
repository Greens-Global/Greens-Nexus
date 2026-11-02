"""One way to layer a per-company setting over an organization default
(Settings redesign phase 4, Oct 23 2026, plan
https://claude.ai/artifact/UGtPmeFBrfU6wXhd474erx).

A setting lives in nexus_settings under its base key for the organization
(the "tenant row") and under ``<base>:<company_id>`` for a company's
override. Reading layers defaults <- tenant <- company; a company with no
override row reads exactly what the tenant row says, so turning a setting
per company changes nothing until someone saves an override. Shift Settings
(routers/shift_requests.py) and Payroll Readiness (payroll_readiness.py)
already worked this way with helpers of their own; the pay rules
(routers/timeclock.py) and the time-off reasons use this one.
"""
import json
from datetime import datetime, timezone

from sqlalchemy import event
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import models

# Per-session memo (Oct 27 2026): a report that builds a card per person
# (payroll readiness, exports) read the same setting rows and the same
# person's company again for every card - `db.get` caches a row it found but
# never one that is not there, so a company with no override cost a query
# per read: ~11 queries a person. The memo lives in `db.info` and is dropped
# on every flush, commit and rollback, so it never outlives what the session
# could see anyway (sessions run autoflush=False).
_MISSING = "_scoped_settings_missing"     # setting keys known to have no row
_COMPANY = "_scoped_settings_company"     # email -> company id


def _forget(session, *_a) -> None:
    session.info.pop(_MISSING, None)
    session.info.pop(_COMPANY, None)


for _ev in ("after_flush", "after_commit", "after_rollback"):
    event.listen(Session, _ev, _forget)


def key_for(base: str, company_id: str = "") -> str:
    return f"{base}:{company_id}" if company_id else base


def saved(db: Session, base: str, company_id: str = "", keys=None) -> dict:
    """What is stored for the tenant ('' company) or a company's override;
    {} when nothing is. `keys` limits the result to the keys a setting knows
    (unknown keys in an old row are dropped, never surfaced)."""
    key = key_for(base, company_id)
    missing = db.info.setdefault(_MISSING, set())
    if key in missing:
        return {}
    row = db.get(models.NexusSetting, key)
    if row is None:
        missing.add(key)
    if not row or not row.value:
        return {}
    try:
        v = json.loads(row.value)
    except (TypeError, ValueError):
        return {}
    if not isinstance(v, dict):
        return {}
    return {k: v[k] for k in v if keys is None or k in keys}


def get(db: Session, base: str, defaults: dict, company_id: str = "") -> dict:
    """The effective setting: defaults <- the tenant row <- that company's
    override (when `company_id` names one). Clamping is the caller's."""
    cfg = dict(defaults)
    cfg.update(saved(db, base, "", defaults))
    if company_id:
        cfg.update(saved(db, base, company_id, defaults))
    return cfg


def has_override(db: Session, base: str, company_id: str) -> bool:
    return bool(company_id) and bool(saved(db, base, company_id))


def save(db: Session, base: str, company_id: str, cfg: dict, actor: str) -> None:
    """Store `cfg` whole as the tenant row (company '') or a company's
    override. The caller commits."""
    key = key_for(base, company_id)
    db.info.get(_MISSING, set()).discard(key)
    row = db.get(models.NexusSetting, key)
    if row is None:
        row = models.NexusSetting(key=key)
        db.add(row)
    row.value = json.dumps(cfg)
    row.updated_by = actor or ""
    row.updated_at = datetime.now(timezone.utc).isoformat()


def reset(db: Session, base: str, company_id: str) -> bool:
    """Drop a company's override so it follows the tenant row again. True
    when there was one. The tenant row itself is never dropped here."""
    if not company_id:
        return False
    row = db.get(models.NexusSetting, key_for(base, company_id))
    if row is None:
        return False
    db.delete(row)
    return True


# ── Saving a JSON setting without losing a concurrent save (11/02/2026) ──────
# A setting saved read-modify-write (read the blob, change some keys, write
# the blob back) loses the other request's keys when two saves overlap: both
# read the same old blob and the later write wins whole. Every such save
# takes the row lock FIRST (lock_row), reads what is stored now and merges
# its PATCH into that (merge_save) - never into a copy read before the lock.

def _loads(value) -> dict:
    try:
        v = json.loads(value or "")
    except (TypeError, ValueError):
        return {}
    return v if isinstance(v, dict) else {}


def lock_row(db: Session, key: str):
    """The nexus_settings row for `key`, read fresh under a row lock
    (SELECT ... FOR UPDATE; SQLite has no row locks and serializes writers
    anyway). A save that started later waits here until the earlier one
    commits, then sees what it stored. Take it before reading the setting
    for a save: every read after it in the same request sees the locked,
    current value. None when there is no row yet."""
    db.info.get(_MISSING, set()).discard(key)
    return (db.query(models.NexusSetting).filter(models.NexusSetting.key == key)
            .populate_existing().with_for_update().first())


def merge_save(db: Session, key: str, build, actor: str = "") -> dict:
    """Read-modify-write ONE JSON setting row safely and return what was
    stored. `build(stored)` gets the stored value read fresh under the row
    lock ({} when there is none) and returns the whole value to store - it
    merges the caller's PATCH into `stored`, never into a copy read earlier.

    The first save of a key can race another request's first save on the
    primary key. The insert runs in a savepoint: when the other request won,
    only the savepoint rolls back, the row is re-read under the lock and
    `build` runs again on what the other request stored - never a 500, never
    a lost save. The caller commits."""
    db.flush()
    for _ in range(3):
        row = lock_row(db, key)
        value = build(_loads(row.value) if row is not None else {})
        now = datetime.now(timezone.utc).isoformat()
        if row is not None:
            row.value = json.dumps(value)
            row.updated_by = actor or ""
            row.updated_at = now
            return value
        try:
            with db.begin_nested():
                db.add(models.NexusSetting(key=key, value=json.dumps(value),
                                           updated_by=actor or "", updated_at=now))
            return value
        except IntegrityError:
            continue   # another request stored it first: merge into theirs
    raise RuntimeError(f"Could not save the setting {key!r}")


def save_patch(db: Session, base: str, company_id: str, patch: dict, actor: str,
               keys=None) -> dict:
    """`save` for a PATCH: merge `patch` into what is stored now for the
    tenant row or a company's override, under the row lock. `keys` limits
    what is kept to the keys the setting knows. The caller commits."""
    def build(stored: dict) -> dict:
        out = {k: v for k, v in stored.items() if keys is None or k in keys}
        out.update({k: v for k, v in (patch or {}).items() if keys is None or k in keys})
        return out
    return merge_save(db, key_for(base, company_id), build, actor)


def sparse(cfg: dict, inherited: dict) -> dict:
    """A company override holds only what DIFFERS from what it would
    inherit, so a later change to the organization value still reaches every
    company that never chose otherwise (a whole-blob override pinned every
    inherited value as it stood on the day it was saved)."""
    return {k: v for k, v in (cfg or {}).items() if k not in inherited or inherited[k] != v}


# ── Checked values for settings saves ────────────────────────────────────────

def clean_email(value, what: str) -> str:
    """'' or one email address, lowercased. ValueError with the reason."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{what} must be an email address.")
    v = value.strip().lower()
    if v and ("@" not in v or " " in v or len(v) > 254):
        raise ValueError(f"{what} must be an email address.")
    return v


def clean_email_list(value, what: str, limit: int = 200) -> list:
    """A list of email addresses (a comma-separated string is accepted),
    lowercased, de-duplicated, in order."""
    if value is None:
        return []
    if isinstance(value, str):
        value = [p for p in value.split(",")]
    if not isinstance(value, list):
        raise ValueError(f"{what} must be a list of email addresses.")
    out: list = []
    for v in value:
        e = clean_email(v, what)
        if e and e not in out:
            out.append(e)
    if len(out) > limit:
        raise ValueError(f"{what} can hold at most {limit} addresses.")
    return out


def clean_int(value, what: str, lo: int, hi: int) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{what} must be a whole number.")
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{what} must be a whole number.") from None
    if isinstance(value, float) and value != n:
        raise ValueError(f"{what} must be a whole number.")
    if n < lo or n > hi:
        raise ValueError(f"{what} must be between {lo} and {hi}.")
    return n


def clean_bool_map(value, what: str, known) -> dict:
    """{key: bool} for the `known` keys only (anything else is dropped)."""
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"{what} must be a set of on / off switches.")
    return {k: bool(v) for k, v in value.items() if k in known}


def clean_text(value, what: str, limit: int = 2000) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{what} must be text.")
    v = value.strip()
    if len(v) > limit:
        raise ValueError(f"{what} is too long.")
    return v


def _norm(v):
    if v is None:
        return ""
    if isinstance(v, str):
        return v.strip().lower()
    if isinstance(v, list):
        return sorted({str(_norm(x)) for x in v if str(_norm(x))})   # order, case, blanks and repeats are no change
    return v


def changed_keys(current: dict, patch: dict, keys) -> list:
    """Which of `keys` the patch CHANGES. A settings form sends its whole
    copy back, so a key sent with the value it already has is no change."""
    return [k for k in keys if k in (patch or {}) and _norm(patch[k]) != _norm((current or {}).get(k))]


def company_of_email(db: Session, email: str) -> str:
    """The company a person's settings come from (nexus_employees.company),
    '' for an untagged person - who then reads the tenant row."""
    from auth import company_of
    em = (email or "").strip().lower()
    memo = db.info.setdefault(_COMPANY, {})
    if em not in memo:
        memo[em] = company_of(em, db)
    return memo[em]
