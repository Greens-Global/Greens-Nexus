"""Admin-set timing for the equipment reminders (Sep 2026).

Two jobs read this one NexusSetting row, `equipment_reminder_config`
(Settings > Global Settings > Notifications & Communications > Equipment
Reminders), through the same cached path hr_reminder_config.py uses:

  - overdue checkout reminders (equipment_reminders.run_overdue_checkouts):
    an allocated transient checkout past its due date chases the borrower,
    then also the person who owns the checkout on the Nexus side;
  - asset date alerts (equipment_reminders.run_asset_alerts): warranty
    expiry, inspection due, registration / insurance expiry and next service
    date, routed to the asset manager instead of broadcast.

DEFAULTS match the lead times the asset scan used before this change (90 /
30 / 60 / 30 days), so a deploy with no saved row keeps the same windows.
Overdue reminders are new and ship ON (product ask: "items come back on
time"). A saved row is merged over the defaults per type, so a type added
later picks up its default instead of vanishing.

Validation reuses hr_reminder_config's helpers so the two settings pages
accept exactly the same kind of day lists.
"""
import copy
import json
from datetime import datetime, timezone

from hr_reminder_config import MAX_DAY, MAX_ENTRIES, ReminderConfigError, _clean_days, _clean_int

_SETTINGS_KEY = "equipment_reminder_config"

# The asset alerts: which days before the date each one warns on. Unlike the
# HR list (exact offsets), an asset alert CATCHES UP: a warranty entered 40
# days before expiry with the list [90] still warns today, once - the old
# scan's "within N days" behavior. Each further (smaller) day in the list is
# one more warning, sent once, to the same notification (updated in place).
DATE_TYPES = ("warranty", "inspection", "registration", "service")

DEFAULTS = {
    # Allocated transient checkouts past their due date.
    "overdue": {"enabled": True, "onDueDate": True, "everyDays": 3,
                "maxReminders": 5, "notifyOwnerAfterDays": 3},
    # Property / equipment warranties (Asset Management warranty rows, and an
    # item's "warranty" date custom field).
    "warranty":     {"enabled": True, "daysBefore": [90]},
    # Property annual inspections (next due date).
    "inspection":   {"enabled": True, "daysBefore": [30]},
    # Vehicle / equipment registration AND insurance expiry.
    "registration": {"enabled": True, "daysBefore": [60]},
    # Vehicle / equipment next service date.
    "service":      {"enabled": True, "daysBefore": [30]},
}

# Overdue number fields: (low, high, label for the error message).
_OVERDUE_INTS = {
    "everyDays": (1, 30, "days between reminders"),
    "maxReminders": (0, 20, "number of reminders"),
    "notifyOwnerAfterDays": (0, 60, "days before the owner is told"),
}

_LABELS = {
    "overdue": "Overdue checkouts",
    "warranty": "Warranty expiry",
    "inspection": "Inspection due",
    "registration": "Registration and insurance",
    "service": "Next service",
}


def defaults() -> dict:
    return copy.deepcopy(DEFAULTS)


def _merge(saved) -> dict:
    out = defaults()
    if not isinstance(saved, dict):
        return out
    for key, base in out.items():
        val = saved.get(key)
        if isinstance(val, dict):
            base.update({k: v for k, v in val.items() if k in base})
    return out


def _bool(val, label, what):
    if not isinstance(val, bool):
        raise ReminderConfigError(f"{label}: {what} must be true or false.")
    return val


def validate(payload, base: dict = None) -> dict:
    """Normalize a full or partial config over `base` (defaults when None).
    Unknown types/fields are rejected; left-out fields keep their base value."""
    if not isinstance(payload, dict):
        raise ReminderConfigError("Settings must be an object.")
    unknown = set(payload) - set(DEFAULTS)
    if unknown:
        raise ReminderConfigError(f"Unknown reminder type: {', '.join(sorted(unknown))}.")
    out = _merge(base) if base is not None else defaults()
    for key, val in payload.items():
        label = _LABELS[key]
        if not isinstance(val, dict):
            raise ReminderConfigError(f"{label}: settings must be an object.")
        extra = set(val) - set(DEFAULTS[key])
        if extra:
            raise ReminderConfigError(f"{label}: unknown field {', '.join(sorted(extra))}.")
        if "enabled" in val:
            out[key]["enabled"] = _bool(val["enabled"], label, "on/off")
        if key == "overdue":
            if "onDueDate" in val:
                out[key]["onDueDate"] = _bool(val["onDueDate"], label, "remind on the due date")
            for field, (low, high, what) in _OVERDUE_INTS.items():
                if field in val:
                    out[key][field] = _clean_int(val[field], label, low, high, what)
        elif "daysBefore" in val:
            days = _clean_days(val["daysBefore"], label, "daysBefore", 0)
            if not days:
                raise ReminderConfigError(f"{label}: pick at least one day, or turn it off.")
            out[key]["daysBefore"] = days
    return out


def _load(db) -> dict:
    import models
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    saved, meta = {}, {"updatedBy": "", "updatedAt": ""}
    if row and row.value:
        try:
            saved = json.loads(row.value)
        except (TypeError, ValueError):
            saved = {}
        meta = {"updatedBy": row.updated_by or "", "updatedAt": row.updated_at or ""}
    return {"config": _merge(saved), **meta}


def get_state(db) -> dict:
    """{config, updatedBy, updatedAt} - a fresh copy the caller may mutate."""
    import cache
    try:
        state = cache.settings_config.get_or_load(_SETTINGS_KEY, lambda: _load(db))
    except Exception:            # noqa: BLE001 - the cache must never stop a scan
        state = _load(db)
    return copy.deepcopy(state)


def get_config(db) -> dict:
    return get_state(db)["config"]


def limits() -> dict:
    return {"maxDay": MAX_DAY, "maxEntries": MAX_ENTRIES,
            **{k: {"min": lo, "max": hi} for k, (lo, hi, _w) in _OVERDUE_INTS.items()}}


def save_config(db, payload, user: dict) -> dict:
    """Validate, store, audit-log and commit. Raises ReminderConfigError."""
    import cache
    import models
    before = _load(db)["config"]
    cfg = validate(payload, base=before)
    now = datetime.now(timezone.utc).isoformat()
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    if not row:
        row = models.NexusSetting(key=_SETTINGS_KEY)
        db.add(row)
    row.value = json.dumps(cfg)
    row.updated_by = user["email"]
    row.updated_at = now
    changed = {k: {"from": before[k], "to": cfg[k]} for k in cfg if before.get(k) != cfg[k]}
    db.add(models.AuditLog(
        timestamp=now, user_email=user["email"], user_role=user.get("role", ""),
        action="equipment_reminder_settings_updated", resource_type="settings",
        resource_id=_SETTINGS_KEY, details=json.dumps(changed)))
    db.commit()
    cache.settings_config.invalidate(_SETTINGS_KEY)
    return {"config": cfg, "updatedBy": user["email"], "updatedAt": now}
