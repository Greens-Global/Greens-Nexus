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
whether/where it appears in the intake picker, its intake field list, and
whether it requires approval. Adding a brand-new type (with a new icon) is
still a code change; renaming, reordering, retiring from intake, and fully
managing an existing type's questions is not.

Approval per type (Sep 2026): `types[<key>].requiresApproval` is the admin's
on/off switch for whether a NEW ticket of that type parks for approval before
the desk can work it. It replaces the hardcoded APPROVAL_REQUIRED_TYPES set
that used to live in routers/tickets.py. The switch is read only at the
moment the gate is decided (a ticket is created, or re-typed) and the outcome
is stored on the ticket as approval_status, so flipping it never changes a
ticket that already exists - see requires_approval() below.
"""
import json
import re
from typing import Any

from sqlalchemy.orm import Session

import models

_SETTINGS_KEY = "ticket_taxonomy_config"

# Mirrors the frontend defaults (ticketMeta.js SLA_TARGET_HOURS) - this is
# the fallback when no admin override has ever been saved, and the seed a
# fresh override starts from in the Admin editor.
_DEFAULT_SLA_HOURS = {"urgent": 24, "high": 48, "medium": 72, "low": 168}

# The three types that were hardcoded as gated before the switch existed.
# They stay gated until an admin turns them off, so nothing changes on
# deploy. Every other type - including any type key an admin configures that
# is not in this set - defaults to NOT requiring approval.
#
# Why these three: they commit somebody else's money, access or production
# config, so a second person signs off. A bug report or a question commits
# nothing, and gating those would only add a step between a user and help.
DEFAULT_APPROVAL_TYPES = frozenset({"service_request", "change_request", "access_request"})

# A type key as the rest of the ticket module writes them ("access_request").
_TYPE_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class TaxonomyError(ValueError):
    """A save patch the server refuses - the router turns it into a 400."""


_DEFAULTS = {
    "slaTargetHours": _DEFAULT_SLA_HOURS,
    # Every type key is absent by default - frontend falls back to its own
    # compiled-in TICKET_TYPE_META/TYPE_FIELDS/TICKET_TYPE_ORDER until an
    # admin actually edits a type, at which point that type's key gets an
    # entry here: { label?, hint?, fields?, requiresApproval? }. typeOrder, if
    # present, fully replaces the intake picker's order/membership.
    # (get_config always fills requiresApproval in for DEFAULT_APPROVAL_TYPES,
    # so those three keys are present in what it returns.)
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


def _fill_approval_defaults(types: dict) -> None:
    """Makes `requiresApproval` explicit for the default-gated types that have
    no saved choice yet, so the Admin editor (and every ticket screen) reads
    the effective value straight off the config instead of re-deriving the
    default. Any other type without the flag is simply not gated."""
    for key in DEFAULT_APPROVAL_TYPES:
        entry = types.setdefault(key, {})
        if not isinstance(entry.get("requiresApproval"), bool):
            entry["requiresApproval"] = True


def _validate_types_patch(types: Any) -> None:
    if not isinstance(types, dict):
        raise TaxonomyError("types must be an object keyed by ticket type.")
    for key, entry in types.items():
        if not isinstance(key, str) or not _TYPE_KEY_RE.match(key):
            raise TaxonomyError(f"Invalid ticket type key: {key!r}.")
        if not isinstance(entry, dict):
            raise TaxonomyError(f"Settings for ticket type {key!r} must be an object.")
        if "requiresApproval" in entry and not isinstance(entry["requiresApproval"], bool):
            raise TaxonomyError(f"requiresApproval for ticket type {key!r} must be true or false.")


def get_config(db: Session) -> dict:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    if not row or not row.value:
        merged = json.loads(json.dumps(_DEFAULTS))
        _fill_approval_defaults(merged["types"])
        return merged
    try:
        cfg = json.loads(row.value)
    except (TypeError, ValueError):
        cfg = {}
    merged = json.loads(json.dumps(_DEFAULTS))
    merged["slaTargetHours"] = {**_DEFAULT_SLA_HOURS, **(cfg.get("slaTargetHours") or {})}
    merged["types"] = {k: dict(v) for k, v in (cfg.get("types") or {}).items() if isinstance(v, dict)}
    _fill_approval_defaults(merged["types"])
    if isinstance(cfg.get("typeOrder"), list):
        merged["typeOrder"] = cfg["typeOrder"]
    cf = cfg.get("companyField") or {}
    merged["companyField"] = {
        "enabled": bool(cf.get("enabled")),
        "companyIds": [c for c in (cf.get("companyIds") or []) if isinstance(c, str) and c],
    }
    return merged


def save_config(db: Session, patch: dict, actor_email: str) -> dict:
    if not isinstance(patch, dict):
        raise TaxonomyError("Settings must be an object.")
    if "types" in patch:
        _validate_types_patch(patch["types"])
    merged = get_config(db)
    if "slaTargetHours" in patch and isinstance(patch["slaTargetHours"], dict):
        merged["slaTargetHours"] = {**merged["slaTargetHours"], **patch["slaTargetHours"]}
    if "types" in patch:
        # Per-type entries replace wholesale (the editor always sends a type's
        # full entry). A default-gated type whose entry arrives without the
        # flag keeps its default (True) rather than silently losing its gate.
        merged["types"] = {**merged["types"], **{k: dict(v) for k, v in patch["types"].items()}}
        _fill_approval_defaults(merged["types"])
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


def requires_approval(db: Session, type_: str) -> bool:
    """Whether a ticket of this type, created (or re-typed) NOW, parks for
    approval. The authoritative read for create_ticket / update_ticket in
    routers/tickets.py, through the same get_config path sla_hours and
    company_field use, so a saved switch takes effect on the next ticket with
    no redeploy.

    Only ever consulted at the moment the gate is decided. The outcome is
    stored on the ticket (approval_status), so turning the switch on or off
    later never re-gates, releases or otherwise changes an existing ticket."""
    key = (type_ or "").strip()
    entry = get_config(db)["types"].get(key)
    flag = entry.get("requiresApproval") if isinstance(entry, dict) else None
    if isinstance(flag, bool):
        return flag
    return key in DEFAULT_APPROVAL_TYPES
