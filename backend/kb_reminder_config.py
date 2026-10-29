"""Knowledge Base reminder switches (Oct 2026) - Settings > Emails & Reminders >
Training Reminders.

The daily Knowledge Base scan (kb_daily.py) sends three kinds of reminder:

  - learners: training due soon / overdue and policies to sign, to the person;
  - managers: the Monday "team training behind" digest about direct reports;
  - owners:   the Monday "pages that need you" digest to collection owners.

Each can be turned off, or kept as a bell only with its email turned off.
Stored in one NexusSetting row (`kb_reminder_config`) with the same cached
read, validation and audit row as equipment_reminder_config.py. A saved row
is merged over DEFAULTS, so a deploy with no row keeps everything on, as
before. Assignment rules and renewals are not reminders and always run.
Workflows > Automations > Training Reminders (job_switch "kb_daily") still
stops all three at once; this is the finer, per-reminder control.
"""
import copy
import json
from datetime import datetime, timezone

from hr_reminder_config import ReminderConfigError

_SETTINGS_KEY = "kb_reminder_config"

DEFAULTS = {
    "learners": {"enabled": True, "email": True},
    "managers": {"enabled": True, "email": True},
    "owners":   {"enabled": True, "email": True},
}

_LABELS = {
    "learners": "Training due and overdue",
    "managers": "Manager digest",
    "owners": "Page owner digest",
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
            base.update({k: v for k, v in val.items() if k in base and isinstance(v, bool)})
    return out


def validate(payload, base: dict = None) -> dict:
    """Normalize a full or partial config over `base` (defaults when None).
    Unknown kinds/fields and non-boolean values are rejected."""
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
        for field, v in val.items():
            if not isinstance(v, bool):
                raise ReminderConfigError(f"{label}: {field} must be true or false.")
            out[key][field] = v
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
        action="kb_reminder_settings_updated", resource_type="settings",
        resource_id=_SETTINGS_KEY, details=json.dumps(changed)))
    db.commit()
    cache.settings_config.invalidate(_SETTINGS_KEY)
    return {"config": cfg, "updatedBy": user["email"], "updatedAt": now}
