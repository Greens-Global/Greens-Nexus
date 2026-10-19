"""Which Cubby units are storage, which are mailboxes, and which are not units
at all (Neil, Oct 20 2026 Ops review).

Cubby has no unit type field. The only handle is the unit's pricing group
name, for example "10' x 10' Storage - Interior, Lower", "0' x 3' mailbox" or
"0' x 0' Ω Deactivated". Cubby itself never tells a mailbox from a storage
unit, so Nexus does it here, in ONE place, by matching words in that name:

  - mailbox:  the name contains any MAILBOX word (default "mailbox", "mail box")
  - excluded: the name contains any EXCLUDED word (default "deactivated") - a
              unit record that was switched off in Cubby. It is not a unit
              anyone can rent, so it counts nowhere.
  - storage:  everything else (storage, parking, "Other").

Storage occupancy, the off-market count, vacancy and the Units by Facility
bar read storage units only; mailboxes get their own figure. Why it matters:
at Valley Center 236 of the 263 "off market" units on Oct 20 were mailboxes
Cubby marks unrentable until someone rents one.

The words are a setting (`nexus_settings` key below, editable from
Operations > Units), so a new pricing group name never needs a deploy.
"""
import json
from datetime import datetime, timezone

SETTING_KEY = "ops_unit_classes"
DEFAULTS = {"mailbox": ["mailbox", "mail box"], "excluded": ["deactivated"]}
MAX_WORDS = 20
MAX_LEN = 60

STORAGE, MAILBOX, EXCLUDED = "storage", "mailbox", "excluded"


def normalize(rules: dict | None) -> dict:
    """Lower-cased, trimmed, de-duplicated word lists. A missing list falls
    back to the default; an explicitly empty one stays empty (switched off)."""
    rules = rules if isinstance(rules, dict) else {}
    out = {}
    for k, default in DEFAULTS.items():
        words = rules.get(k)
        if not isinstance(words, list):
            words = default
        seen: list[str] = []
        for w in words:
            w = str(w or "").strip().lower()[:MAX_LEN]
            if w and w not in seen:
                seen.append(w)
        out[k] = seen[:MAX_WORDS]
    return out


def unit_class(pricing_group_name: str, rules: dict | None = None) -> str:
    """'storage', 'mailbox' or 'excluded' for one Cubby pricing group name.
    `rules` is normalize()'s shape (load() returns it); None = the defaults."""
    rules = DEFAULTS if rules is None else rules
    name = (pricing_group_name or "").lower()
    if any(w in name for w in rules.get(EXCLUDED, [])):
        return EXCLUDED
    if any(w in name for w in rules.get(MAILBOX, [])):
        return MAILBOX
    return STORAGE


def load(db=None) -> dict:
    """The saved rules, or the defaults. Blocking (DB) - call it in a thread."""
    import models
    own = db is None
    if own:
        from database import SessionLocal
        db = SessionLocal()
    try:
        row = db.get(models.NexusSetting, SETTING_KEY)
        try:
            return normalize(json.loads(row.value) if row and row.value else None)
        except ValueError:
            return normalize(None)
    finally:
        if own:
            db.close()


def save(db, rules: dict, by: str = "") -> dict:
    import models
    clean = normalize(rules)
    row = db.get(models.NexusSetting, SETTING_KEY)
    if row is None:
        row = models.NexusSetting(key=SETTING_KEY)
        db.add(row)
    row.value = json.dumps(clean)
    row.updated_by = by
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    return clean
