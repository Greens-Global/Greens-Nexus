"""Ticket taxonomy admin config (Sep 2026) - SLA target hours per priority and
per-type intake question overrides. Both used to be hardcoded constants
(SLA_TARGET_HOURS / TYPE_FIELDS in frontend/src/tickets/ticketMeta.js,
_SLA_TARGET_HOURS here) that an engineer had to edit and redeploy to change.

Kept out of routers/tickets.py so that file doesn't balloon further - same
reason ticket_notify.py is its own module. Settings live in NexusSetting
(key="ticket_taxonomy_config", JSON value), the same "small admin config"
pattern ticket_notify.py and timeclock.py's auto-lunch rules use.

Overrides only, not a full type catalogue: a type's KEY, icon and color stay
defined in the frontend (ticketMeta.js) - this only overrides label, hint,
whether/where it appears in the intake picker, and its intake field list.
Adding a brand-new type (with a new icon) is still a code change; renaming,
reordering, retiring from intake, and fully managing an existing type's
questions is not.
"""
import json

from sqlalchemy.orm import Session

import models

_SETTINGS_KEY = "ticket_taxonomy_config"

# Mirrors the frontend defaults (ticketMeta.js SLA_TARGET_HOURS) - this is
# the fallback when no admin override has ever been saved, and the seed a
# fresh override starts from in the Admin editor.
_DEFAULT_SLA_HOURS = {"urgent": 24, "high": 48, "medium": 72, "low": 168}

_DEFAULTS = {
    "slaTargetHours": _DEFAULT_SLA_HOURS,
    # Every type key is absent by default - frontend falls back to its own
    # compiled-in TICKET_TYPE_META/TYPE_FIELDS/TICKET_TYPE_ORDER until an
    # admin actually edits a type, at which point that type's key gets an
    # entry here: { label?, hint?, fields? }. typeOrder, if present, fully
    # replaces the intake picker's order/membership.
    "types": {},
    "typeOrder": None,
    # Company field on intake (Sep 19, Pranshu: "End user don't have the
    # ability to choose company but here it is showing the ticket is raised
    # for GGcon company - this is an issue... admin have the control to turn
    # on/off the company field for end user"). Off by default - a requester's
    # ticket is silently filed under their own People-record company, same as
    # before this setting existed (see company_for in routers/tickets.py).
    # When enabled, `companyIds` is the admin-picked subset an end user may
    # choose from at intake - an empty list with enabled=True offers nothing
    # (same "nothing to choose from" fallback the department/application
    # pickers already use), not "every company".
    "companyField": {"enabled": False, "companyIds": []},
}


def get_config(db: Session) -> dict:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    if not row or not row.value:
        return json.loads(json.dumps(_DEFAULTS))
    try:
        cfg = json.loads(row.value)
    except (TypeError, ValueError):
        cfg = {}
    merged = json.loads(json.dumps(_DEFAULTS))
    merged["slaTargetHours"] = {**_DEFAULT_SLA_HOURS, **(cfg.get("slaTargetHours") or {})}
    merged["types"] = cfg.get("types") or {}
    if isinstance(cfg.get("typeOrder"), list):
        merged["typeOrder"] = cfg["typeOrder"]
    cf = cfg.get("companyField") or {}
    merged["companyField"] = {
        "enabled": bool(cf.get("enabled")),
        "companyIds": [c for c in (cf.get("companyIds") or []) if isinstance(c, str) and c],
    }
    return merged


def save_config(db: Session, patch: dict, actor_email: str) -> dict:
    merged = get_config(db)
    if "slaTargetHours" in patch and isinstance(patch["slaTargetHours"], dict):
        merged["slaTargetHours"] = {**merged["slaTargetHours"], **patch["slaTargetHours"]}
    if "types" in patch and isinstance(patch["types"], dict):
        merged["types"] = {**merged["types"], **patch["types"]}
    if "typeOrder" in patch:
        merged["typeOrder"] = patch["typeOrder"]
    if "companyField" in patch and isinstance(patch["companyField"], dict):
        incoming = patch["companyField"]
        merged["companyField"] = {
            "enabled": bool(incoming.get("enabled", merged["companyField"]["enabled"])),
            "companyIds": [c for c in (incoming.get("companyIds", merged["companyField"]["companyIds"]) or [])
                           if isinstance(c, str) and c],
        }
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    if not row:
        row = models.NexusSetting(key=_SETTINGS_KEY)
        db.add(row)
    row.value = json.dumps(merged)
    row.updated_by = actor_email
    from datetime import datetime, timezone
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    return merged


def sla_hours(db: Session, priority: str) -> int:
    """The authoritative SLA target hours for a priority - used by
    _sla_due_from_priority in routers/tickets.py so a saved admin override
    takes effect immediately, server-side, without a redeploy."""
    cfg = get_config(db)
    hours = cfg["slaTargetHours"]
    return hours.get(priority, hours["medium"])


def company_field(db: Session) -> dict:
    """The authoritative company-field intake setting - used by create_ticket
    and update_ticket in routers/tickets.py to decide whether a plain
    requester's own company_id choice is honoured, same never-trust-the-UI-
    alone posture as every other permission check in that file."""
    return get_config(db)["companyField"]
