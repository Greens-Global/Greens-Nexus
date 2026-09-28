"""Sign-in & session security settings (Sep 2026, Settings > Global > Security).

Before this, step-up re-auth, session lifetimes, credential-vault unlock
windows and guest sign-in limits were env vars or constants - invisible to
admins and changed with no audit trail. They now live in ONE NexusSetting row
(key `security_config`, JSON of saved overrides only) with this precedence
per setting:

    saved admin value  >  env var (where one exists today)  >  today's default

so a deploy with nothing saved behaves exactly as before.

Safety rails:
  * Every numeric setting has HARD bounds, enforced on write (routers/
    security_settings.py) AND on read: a saved value outside its bounds (a
    hand-edited row) is ignored and the env/default applies instead.
  * An env var that is outside the bounds still applies as-is - that is what
    the server runs today, and "nothing changes on deploy" wins. The GET
    response flags it (outOfRange) so an admin can see it.
  * Env is a FLOOR for the two safety toggles (step-up enforcement and
    MFA-required): if the server config turns one ON, a saved value cannot
    turn it off (the setting reports locked=True and PUT refuses). The env var
    is the deploy-time decision of whoever runs the server; the UI may make
    things stricter than that, never looser. Numeric values are NOT floored by
    env - the hard bounds are their safety net, and flooring them would make
    the Saved value silently not apply.

Reads go through cache.settings_config (60s TTL, dropped on the writing
worker at commit by cache.wire), so the hot paths that use this - the BFF
session idle check runs on every cookie-authenticated request - do not add a
DB round trip per request. A DB error while loading is NOT swallowed: failing
open (falling back to a looser default) on a transient error would be worse
than the request failing.
"""
import json
import os

import cache

SETTINGS_KEY = "security_config"

_TRUE = ("1", "true", "yes")

# key -> definition. `env` is the env var that configures it today (None when
# it was a hardcoded constant). Units are the unit the code consumes, so no
# conversion can drift between here and the consumer.
SETTINGS: dict[str, dict] = {
    # Re-authentication for sensitive actions (routers/stepup.py)
    "stepupEnforce":    {"type": "bool", "default": False, "env": "NEXUS_STEPUP_ENFORCE"},
    "stepupRequireMfa": {"type": "bool", "default": False, "env": "NEXUS_STEPUP_REQUIRE_MFA"},
    "stepupTtlSec":     {"type": "int", "default": 300, "min": 60, "max": 1800, "unit": "seconds",
                         "env": "NEXUS_STEPUP_TTL_SEC"},
    "stepupMaxAgeSec":  {"type": "int", "default": 120, "min": 60, "max": 1800, "unit": "seconds",
                         "env": "NEXUS_STEPUP_MAX_AGE"},
    # Sessions
    "webSessionIdleDays": {"type": "int", "default": 30, "min": 1, "max": 30, "unit": "days", "env": None},
    "actAsMinutes":       {"type": "int", "default": 240, "min": 15, "max": 480, "unit": "minutes", "env": None},
    "vaultOtpUnlockSec":  {"type": "int", "default": 300, "min": 60, "max": 1800, "unit": "seconds",
                           "env": "NEXUS_VAULT_OTP_TTL_SEC"},
    "vaultPersonalUnlockSec": {"type": "int", "default": 600, "min": 60, "max": 1800, "unit": "seconds",
                               "env": "NEXUS_VAULT_PERSONAL_TTL_SEC"},
    # Guest sign-in (routers/external_auth.py)
    "guestCodeTtlMin":      {"type": "int", "default": 10, "min": 5, "max": 30, "unit": "minutes", "env": None},
    "guestMaxAttempts":     {"type": "int", "default": 5, "min": 3, "max": 10, "unit": "attempts", "env": None},
    "guestLockoutMin":      {"type": "int", "default": 15, "min": 5, "max": 60, "unit": "minutes", "env": None},
    "guestInviteTtlDays":   {"type": "int", "default": 7, "min": 1, "max": 14, "unit": "days", "env": None},
    "guestRequestsPerHour": {"type": "int", "default": 5, "min": 3, "max": 10, "unit": "requests", "env": None},
}

# Turning one of these OFF weakens sign-in: owner-only (like every PUT here)
# plus an explicit confirmation flag on the request.
SAFETY_TOGGLES = ("stepupEnforce", "stepupRequireMfa")

DEFAULTS = {k: d["default"] for k, d in SETTINGS.items()}


def _env_value(key: str):
    """(value, present). Parsed exactly like the old import-time reads. An
    unparseable int env var used to crash the import; now it is ignored."""
    d = SETTINGS[key]
    name = d.get("env")
    if not name:
        return None, False
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return None, False
    if d["type"] == "bool":
        return raw.strip().lower() in _TRUE, True
    try:
        return int(raw.strip()), True
    except ValueError:
        return None, False


def in_bounds(key: str, value) -> bool:
    d = SETTINGS[key]
    if d["type"] == "bool":
        return isinstance(value, bool)
    if isinstance(value, bool) or not isinstance(value, int):
        return False
    return d["min"] <= value <= d["max"]


def env_locked(key: str) -> bool:
    """True when the server config forces a safety toggle ON (env is a floor)."""
    if key not in SAFETY_TOGGLES:
        return False
    val, present = _env_value(key)
    return bool(present and val)


def _load_saved(db) -> dict:
    from models import NexusSetting
    row = db.query(NexusSetting).filter(NexusSetting.key == SETTINGS_KEY).first()
    if not row or not row.value:
        return {}
    try:
        data = json.loads(row.value)
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def saved(db=None) -> dict:
    """The raw saved overrides (cached). Opens its own session when the caller
    has none - every consumer runs in a sync def (threadpool), never on the loop."""
    def _load():
        if db is not None:
            return _load_saved(db)
        from database import SessionLocal
        s = SessionLocal()
        try:
            return _load_saved(s)
        finally:
            s.close()
    return cache.settings_config.get_or_load(SETTINGS_KEY, _load)


def resolve(key: str, saved_values: dict):
    """(value, source) for one setting given the saved overrides."""
    d = SETTINGS[key]
    env_val, env_present = _env_value(key)
    if key in saved_values and in_bounds(key, saved_values[key]):
        val = saved_values[key]
        if d["type"] == "bool" and env_locked(key):
            return True, "env"          # env floor: saved OFF cannot beat env ON
        return val, "saved"
    if env_present:
        return env_val, "env"
    return d["default"], "default"


def get(key: str, db=None):
    """The effective value of one setting, at the point of use."""
    return resolve(key, saved(db))[0]


def effective(db=None) -> dict:
    s = saved(db)
    return {k: resolve(k, s)[0] for k in SETTINGS}


def describe(db) -> dict:
    """Everything the Settings screen shows, per setting."""
    s = saved(db)
    out = {}
    for key, d in SETTINGS.items():
        val, source = resolve(key, s)
        env_val, env_present = _env_value(key)
        item = {"value": val, "source": source, "default": d["default"], "type": d["type"],
                "locked": env_locked(key), "hasEnv": env_present,
                "envValue": env_val if env_present else None}
        if d["type"] == "int":
            item.update({"min": d["min"], "max": d["max"], "unit": d["unit"],
                         "outOfRange": not (d["min"] <= val <= d["max"])})
        else:
            item.update({"min": None, "max": None, "unit": None, "outOfRange": False})
        out[key] = item
    return out
