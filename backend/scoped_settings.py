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


def company_of_email(db: Session, email: str) -> str:
    """The company a person's settings come from (nexus_employees.company),
    '' for an untagged person - who then reads the tenant row."""
    from auth import company_of
    em = (email or "").strip().lower()
    memo = db.info.setdefault(_COMPANY, {})
    if em not in memo:
        memo[em] = company_of(em, db)
    return memo[em]
