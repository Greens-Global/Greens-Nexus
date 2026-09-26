"""Admin-set timing for the HR & compliance reminders (Sep 2026).

The daily scan in reminders.py used to hard-code when each reminder fires
(visa expiry at 60/30/14/7/3/1/0 days, contract end at 30/14/7/1/0, ...).
Product ask: "the admin picks the timing, so HR controls how early they're
warned". The timing now lives in one NexusSetting row, `hr_reminder_config`,
edited from Settings > Global Settings > Notifications & Communications.

DEFAULTS below are exactly the values the code used before this change, so
a deploy with no saved row behaves identically. A saved row is merged over
the defaults per reminder type, so a reminder type added later picks up its
default instead of vanishing.

Read through cache.settings_config (the same TTL cache branding uses; a
commit touching NexusSetting drops it on the writing worker, the others
converge within its 60s TTL). The scan runs once a day, so that window
never matters in practice.
"""
import copy
import json
from datetime import datetime, timezone

_SETTINGS_KEY = "hr_reminder_config"

MAX_DAY = 365
MAX_ENTRIES = 10

# Each list reminder fires on the days whose offset is IN the list - exact
# matches only, never "within N days". That is what keeps a changed list safe:
# adding an earlier day (e.g. 90 while a visa is 45 days out) cannot fire for
# a day that has already passed, and the per-day dedupe in reminders._notify
# stops a same-day repeat.
DEFAULTS = {
    # Right-to-work / visa document (employee compliance.expiryDate).
    # Before expiry on these days, then every day for the 7 days after it.
    "rightToWork":    {"enabled": True, "daysBefore": [60, 30, 14, 7, 3, 1, 0],
                       "daysAfter": [1, 2, 3, 4, 5, 6, 7]},
    # Contractor contract end (contractor.contract_end).
    "contractEnd":    {"enabled": True, "daysBefore": [30, 14, 7, 1, 0]},
    # New starter start date (onboarding employees).
    "newStarter":     {"enabled": True, "daysBefore": [7, 3, 1, 0]},
    # HR documents uploaded with an expiry date.
    "documentExpiry": {"enabled": True, "daysBefore": [30, 14, 7, 1, 0]},
    # Pending e-sign request close to its expiry date (was "0 <= d <= 3").
    "esignExpiring":  {"enabled": True, "daysBefore": [3, 2, 1, 0]},
    # E-sign auto-chase of the signer holding an envelope up: nudge after this
    # many days with no contact (each nudge restarts the count), at most this
    # many automatic nudges per signer.
    "esignChase":     {"enabled": True, "firstNudgeAfterDays": 3, "maxNudges": 3},
}

# Which list fields each type accepts.
_LIST_FIELDS = {
    "rightToWork": ("daysBefore", "daysAfter"),
    "contractEnd": ("daysBefore",),
    "newStarter": ("daysBefore",),
    "documentExpiry": ("daysBefore",),
    "esignExpiring": ("daysBefore",),
}

_LABELS = {
    "rightToWork": "Right-to-work / visa expiry",
    "contractEnd": "Contract end",
    "newStarter": "New starter",
    "documentExpiry": "HR document expiry",
    "esignExpiring": "Signature request expiring",
    "esignChase": "Signature chase",
}


class ReminderConfigError(ValueError):
    """A saved config that fails validation. The message is shown to the admin."""


def defaults() -> dict:
    return copy.deepcopy(DEFAULTS)


def _merge(saved: dict) -> dict:
    out = defaults()
    if not isinstance(saved, dict):
        return out
    for key, base in out.items():
        val = saved.get(key)
        if isinstance(val, dict):
            base.update({k: v for k, v in val.items() if k in base})
    return out


def _clean_days(value, label: str, field: str, low: int) -> list:
    if not isinstance(value, list):
        raise ReminderConfigError(f"{label}: days must be a list.")
    out = set()
    for v in value:
        # bool is an int subclass - True must not sneak in as day 1.
        if isinstance(v, bool) or not isinstance(v, (int, float)) or int(v) != v:
            raise ReminderConfigError(f"{label}: every day must be a whole number.")
        v = int(v)
        if v < low or v > MAX_DAY:
            raise ReminderConfigError(f"{label}: days must be between {low} and {MAX_DAY}.")
        out.add(v)
    if len(out) > MAX_ENTRIES:
        raise ReminderConfigError(f"{label}: at most {MAX_ENTRIES} days.")
    return sorted(out, reverse=True)


def _clean_int(value, label: str, low: int, high: int, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
        raise ReminderConfigError(f"{label}: {what} must be a whole number.")
    value = int(value)
    if value < low or value > high:
        raise ReminderConfigError(f"{label}: {what} must be between {low} and {high}.")
    return value


def validate(payload, base: dict = None) -> dict:
    """Normalize a full or partial config over `base` (the defaults when not
    given). Unknown types/fields are rejected (a typo must not silently save
    as "no change"); anything the payload leaves out keeps its `base` value.
    Day lists come back deduped and sorted, latest first."""
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
            if not isinstance(val["enabled"], bool):
                raise ReminderConfigError(f"{label}: on/off must be true or false.")
            out[key]["enabled"] = val["enabled"]
        for field in _LIST_FIELDS.get(key, ()):
            if field in val:
                # "0 days before" means the day itself; after-days start at 1.
                out[key][field] = _clean_days(val[field], label, field, 0 if field == "daysBefore" else 1)
        if key == "esignChase":
            if "firstNudgeAfterDays" in val:
                out[key]["firstNudgeAfterDays"] = _clean_int(
                    val["firstNudgeAfterDays"], label, 1, 30, "days before the first nudge")
            if "maxNudges" in val:
                out[key]["maxNudges"] = _clean_int(val["maxNudges"], label, 0, 10, "number of nudges")
    return out


def _load(db) -> dict:
    import models
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    saved = {}
    meta = {"updatedBy": "", "updatedAt": ""}
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
        action="hr_reminder_settings_updated", resource_type="settings",
        resource_id=_SETTINGS_KEY, details=json.dumps(changed)))
    db.commit()
    cache.settings_config.invalidate(_SETTINGS_KEY)
    return {"config": cfg, "updatedBy": user["email"], "updatedAt": now}
