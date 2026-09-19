"""Per-person task email preferences (Sept 2026).

Everyone used to get exactly the company-wide behavior set in Manage (due-soon
days, overdue repeat, which events email at all). This layers each person's own
choices on top of it - and only on top: a key that is missing, or set to
"company", falls back to the company value, so someone who never opens the
settings page keeps exactly what they had.

Choices a person can make:
  reminderHour / timezone  when the daily reminders (due soon, overdue) arrive
  skipWeekends             no reminders on Saturday/Sunday (their local time)
  dueSoonDays              "company" | "off" | 0 (due date only) .. 7 days before
  overdueFrequency         "company" | "daily" | "every2" | "every3" | "weekly"
                           | "once" | "off" (off only when an admin allows it -
                           allowUserOverdueOff in the company settings)
  reminderDelivery         "each" (one email per task) | "digest" (one daily
                           summary of every due-soon/overdue task)
  events                   instant emails on/off. Assigned and mentioned are
                           ALWAYS on - they are addressed at this person.
  updateThrottleMinutes    at most one "Updated" email per task per N minutes
  mutedTaskIds / mutedProjectIds
                           no email about these at all, except a mention (which
                           is somebody asking this person directly)
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

import models

DEFAULT_TZ = "America/Los_Angeles"
DEFAULT_HOUR = 8

# Instant events a person may turn off. Assigned / mentioned are not here on
# purpose - see the module docstring.
OPTIONAL_EVENTS = ("created", "commented", "modified", "follower_added", "completed",
                   "deleted", "recurring")
LOCKED_EVENTS = ("assigned", "mentioned")

OVERDUE_CHOICES = {"company": None, "daily": 1, "every2": 2, "every3": 3,
                   "weekly": 7, "once": 0, "off": -1}
THROTTLE_CHOICES = (0, 15, 60)

DEFAULTS = {
    "reminderHour": DEFAULT_HOUR,
    "timezone": DEFAULT_TZ,
    "skipWeekends": False,
    "dueSoonDays": "company",
    "overdueFrequency": "company",
    "reminderDelivery": "each",
    "events": {e: True for e in OPTIONAL_EVENTS},
    "updateThrottleMinutes": 0,
    "mutedTaskIds": [],
    "mutedProjectIds": [],
}


def _valid_tz(tz: str) -> bool:
    try:
        from zoneinfo import ZoneInfo
        ZoneInfo(tz)
        return True
    except Exception:
        return False


def normalize(raw: dict | None) -> dict:
    """Coerce whatever was stored or sent into a complete, valid prefs dict.
    Unknown keys are dropped; bad values fall back to the default."""
    raw = raw if isinstance(raw, dict) else {}
    p = {k: (dict(v) if isinstance(v, dict) else list(v) if isinstance(v, list) else v)
         for k, v in DEFAULTS.items()}
    try:
        h = int(raw.get("reminderHour", DEFAULT_HOUR))
        if 0 <= h <= 23:
            p["reminderHour"] = h
    except (TypeError, ValueError):
        pass
    tz = str(raw.get("timezone") or "")
    if tz and _valid_tz(tz):
        p["timezone"] = tz
    p["skipWeekends"] = bool(raw.get("skipWeekends", False))
    ds = raw.get("dueSoonDays", "company")
    if ds in ("company", "off"):
        p["dueSoonDays"] = ds
    else:
        try:
            n = int(ds)
            if 0 <= n <= 7:
                p["dueSoonDays"] = n
        except (TypeError, ValueError):
            pass
    if raw.get("overdueFrequency") in OVERDUE_CHOICES:
        p["overdueFrequency"] = raw["overdueFrequency"]
    if raw.get("reminderDelivery") in ("each", "digest"):
        p["reminderDelivery"] = raw["reminderDelivery"]
    ev = raw.get("events") if isinstance(raw.get("events"), dict) else {}
    p["events"] = {e: bool(ev.get(e, True)) for e in OPTIONAL_EVENTS}
    try:
        th = int(raw.get("updateThrottleMinutes", 0))
        p["updateThrottleMinutes"] = th if th in THROTTLE_CHOICES else 0
    except (TypeError, ValueError):
        pass
    for key in ("mutedTaskIds", "mutedProjectIds"):
        vals = raw.get(key) if isinstance(raw.get(key), list) else []
        p[key] = list(dict.fromkeys(str(v) for v in vals if v))[:500]
    return p


def load(db: Session, email: str) -> dict:
    row = db.query(models.TaskNotifyPref).filter(models.TaskNotifyPref.email == (email or "").lower()).first()
    return normalize(row.prefs if row else None)


def save(db: Session, email: str, raw: dict) -> dict:
    p = normalize(raw)
    email = (email or "").lower()
    row = db.query(models.TaskNotifyPref).filter(models.TaskNotifyPref.email == email).first()
    if not row:
        row = models.TaskNotifyPref(email=email)
        db.add(row)
    row.prefs = p
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    return p


def mute_task(db: Session, email: str, task_id: str) -> dict:
    p = load(db, email)
    if task_id not in p["mutedTaskIds"]:
        p["mutedTaskIds"].append(task_id)
    return save(db, email, p)


# ── Rules the senders apply ──────────────────────────────────────────────────

def is_muted(p: dict, t) -> bool:
    return (getattr(t, "id", "") in p["mutedTaskIds"]
            or bool(getattr(t, "project_id", "")) and t.project_id in p["mutedProjectIds"])


def wants_event(p: dict, event_type: str, t) -> bool:
    """Instant (event-driven) emails. A mention always gets through - even a
    muted task - because it is a person asking this person directly."""
    if event_type == "mentioned":
        return True
    if is_muted(p, t):
        return False
    if event_type in LOCKED_EVENTS:
        return True
    return p["events"].get(event_type, True)


def due_soon_days(p: dict, cfg: dict) -> int | None:
    """Days-before window for due-soon reminders; None = off."""
    v = p["dueSoonDays"]
    if v == "off":
        return None
    if v == "company":
        return int(cfg.get("dueSoonDays") or 0)
    return int(v)


def overdue_repeat(p: dict, cfg: dict) -> int | None:
    """Repeat interval in days for overdue reminders: 0 = first day only,
    None = off. "off" only counts when the company allows it; otherwise it is
    read as weekly - the least a person can get."""
    choice = p["overdueFrequency"]
    if choice == "off" and not cfg.get("allowUserOverdueOff"):
        return 7
    n = OVERDUE_CHOICES.get(choice)
    if n is None:
        return int(cfg.get("overdueRepeatDays") or 0)
    return None if n < 0 else n


def local_now(p: dict, now_utc: datetime | None = None) -> datetime:
    from zoneinfo import ZoneInfo
    return (now_utc or datetime.now(timezone.utc)).astimezone(ZoneInfo(p["timezone"]))


def reminders_due_now(p: dict, now_utc: datetime | None = None) -> bool:
    """Is it this person's reminder time? The scan is hourly, so this is
    "the chosen hour has been reached today" - a scan that missed the exact
    hour (a restart) still sends later that day; the per-day idempotency key
    keeps it to once."""
    local = local_now(p, now_utc)
    if p["skipWeekends"] and local.weekday() >= 5:
        return False
    return local.hour >= p["reminderHour"]
