"""Task labels done right (Neil, Oct 22 2026 - Planner parity).

A task's labels are Task.tags: a JSON list of free text, unchanged. What this
module adds is everything around them:

COLORS. Every label has a color with no setup: the browser hashes the label's
key (frontend/src/tasks/labels.js) into a soft palette of TONES[:10].
`default_tone` here is the same hash, so a rename can keep the color the
label already showed. A company can override a label's color (and the
spelling it is shown with) in its LABEL MAP:

    {"<label key>": {"name": "Display Name", "color": "<tone>"}}

stored as JSON on a nexus_settings row - no new table, no new column. With
the company walls off everyone shares one map ("task_labels"); with them on
each company has its own ("task_labels:<company id>"), the per-company key
shape shift settings already use (routers/shift_requests._settings_key).
Nothing is inherited between the two: a company's map is its own.

A label's KEY is its name trimmed, inner whitespace collapsed, lowercased -
"Urgent", "urgent" and " URGENT " are one label. Every comparison goes
through `label_key`; the frontend's labelKey is the same rule.

MANAGE (routers/task_labels.py): recolor, rename, merge (a rename onto a
name already in use) and delete. Rename / merge / delete rewrite the tags on
EVERY task in the company - restricted tasks and the Trash included, since
it is an admin action - locked in id order, one quiet field-history row per
task changed, no emails, no automation run, one realtime ping at the end.
"""
from __future__ import annotations

import json
from typing import Iterable

from fastapi import HTTPException
from sqlalchemy.orm import Session, load_only

import models
from routers.task_util import now_iso

SETTINGS_KEY = "task_labels"

# The palette keys; labels.js LABEL_TONES carries the light / dark shades.
# The first ten are the hashed defaults; slate (grey) is offered only as an
# override.
TONES = ("blue", "sky", "teal", "green", "amber", "orange", "red", "pink", "purple", "indigo", "slate")
DEFAULT_TONES = TONES[:10]

MAX_NAME = 60          # characters in one label
MAX_PER_TASK = 30      # the CSV import's cap (task_import.MAX_TAGS)
MAX_MAP = 500          # overrides one company may keep
_CHUNK = 500           # ids per IN (...) / lock round in a rewrite


# ── Names and keys ────────────────────────────────────────────────────────
def clean_name(name) -> str:
    """The label as it is stored: trimmed, inner whitespace collapsed."""
    return " ".join(str(name or "").split())


def label_key(name) -> str:
    """The one identity of a label - see the module docstring."""
    return clean_name(name).lower()


def default_tone(key: str) -> str:
    """FNV-1a (32-bit) over the key's UTF-8 bytes, into DEFAULT_TONES. The
    same arithmetic as labels.js labelTone, so the server can tell which
    color the browser shows for a label nobody has colored."""
    h = 0x811C9DC5
    for b in label_key(key).encode("utf-8"):
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return DEFAULT_TONES[h % len(DEFAULT_TONES)]


def check_name(name) -> str:
    v = clean_name(name)
    if not v:
        raise HTTPException(422, "A label needs a name.")
    if len(v) > MAX_NAME:
        raise HTTPException(422, f"A label can be at most {MAX_NAME} characters.")
    return v


def merge_tags(current, add: Iterable = (), remove: Iterable = ()) -> list:
    """`current` with `remove` taken off and `add` put on, by key: a label the
    task already carries in any spelling is not added twice, and removing
    "urgent" removes "Urgent". Order is kept; new labels go at the end."""
    drop = {label_key(x) for x in remove or () if label_key(x)}
    out, seen = [], set()
    for tag in list(current or []):
        k = label_key(tag)
        if not k or k in drop or k in seen:
            continue
        seen.add(k)
        out.append(clean_name(tag))
    for tag in add or ():
        k = label_key(tag)
        if not k or k in seen or k in drop:
            continue
        seen.add(k)
        out.append(clean_name(tag))
    return out


# ── The label map ─────────────────────────────────────────────────────────
def settings_key(company: str = "") -> str:
    return f"{SETTINGS_KEY}:{company}" if company else SETTINGS_KEY


def _clean_map(raw) -> dict:
    out = {}
    if not isinstance(raw, dict):
        return out
    for k, v in raw.items():
        key = label_key(k)
        if not key or not isinstance(v, dict):
            continue
        color = str(v.get("color") or "")
        out[key] = {"name": clean_name(v.get("name")) or key, "color": color if color in TONES else ""}
    return out


def get_map(db: Session, company: str = "") -> dict:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == settings_key(company)).first()
    if not row or not row.value:
        return {}
    try:
        return _clean_map(json.loads(row.value))
    except (TypeError, ValueError):
        return {}


def _lock_map_row(db: Session, company: str):
    """The map's row, locked for this transaction (no-op on SQLite), created
    when missing - two admins recoloring at once queue up rather than one
    write dropping the other's change."""
    key = settings_key(company)
    row = (db.query(models.NexusSetting).filter(models.NexusSetting.key == key)
           .with_for_update().first())
    if row is None:
        row = models.NexusSetting(key=key, value="{}")
        db.add(row)
    return row


def write_map(db: Session, company: str, change: dict, actor: str) -> dict:
    """Apply {key: entry or None} to the company's map (None drops the key)
    under the row lock and return the new map. Not committed."""
    row = _lock_map_row(db, company)
    try:
        current = _clean_map(json.loads(row.value or "{}"))
    except (TypeError, ValueError):
        current = {}
    for key, entry in change.items():
        if entry is None:
            current.pop(key, None)
        else:
            current[key] = entry
    if len(current) > MAX_MAP:
        raise HTTPException(422, f"A company can keep at most {MAX_MAP} label colors.")
    row.value = json.dumps(current, sort_keys=True)
    row.updated_by = actor or ""
    row.updated_at = now_iso()
    return current


# ── Which company's labels ────────────────────────────────────────────────
def _walls_on(db: Session) -> bool:
    import auth
    return auth._company_walls_on(db)


def company_choices(db: Session, user: dict) -> list:
    """[{id, name}] of the companies whose labels the caller may pick
    between - empty with the walls off (one shared map)."""
    import auth
    if not _walls_on(db):
        return []
    scope = auth.company_scope(user, db)
    q = db.query(models.HrEntity.id, models.HrEntity.name)
    rows = [(r.id, r.name or r.id) for r in q.all() if scope is None or r.id in scope]
    known = {i for i, _ in rows}
    # A scope can name a company that has no HrEntity row (a stale access
    # scope); it is still the caller's, so it is still listed.
    rows += [(c, c) for c in (scope or ()) if c not in known]
    return [{"id": i, "name": n} for i, n in sorted(rows, key=lambda r: (str(r[1]).lower(), r[0]))]


def company_for(db: Session, user: dict, requested: str = "") -> str:
    """The company whose label map the caller reads or changes.

    '' with the walls off (the one shared map). Behind the walls: the
    requested company when it is inside the caller's scope (another one is
    a 404, as everywhere behind the wall), else their own company, else the
    one company in their scope. A Global Admin may name any company; one
    with no company of their own and none named gets '' (the shared map,
    read-only for changes - see require_company)."""
    import auth
    if not _walls_on(db):
        return ""
    scope = auth.company_scope(user, db)
    requested = (requested or "").strip()
    if requested:
        if scope is not None and requested not in scope:
            raise HTTPException(404, "Not found")
        return requested
    home = auth.company_of(user, db)
    if home and (scope is None or home in scope):
        return home
    if scope:
        return sorted(scope)[0]
    return ""


def require_company(db: Session, company: str) -> None:
    """Behind the walls a change is always for one company: rename / merge /
    delete reach every task in it, and '' would mean every company's."""
    if _walls_on(db) and not company:
        raise HTTPException(422, "Pick the company whose labels to change.")


def in_company(db: Session, company: str):
    """Predicate: is this task inside `company`'s labels? Every task with
    the walls off; behind them, the task's company (task_util.task_company,
    the same reading the wall itself uses)."""
    if not _walls_on(db):
        return lambda t: True
    from routers.task_util import _emp_company_map, task_company
    emp = _emp_company_map(db)
    return lambda t: task_company(t, emp) == company


# ── Labels in use ─────────────────────────────────────────────────────────
_SCAN_COLS = ("id", "tags", "company_id", "owner_email", "created_by", "access_level", "assignee_email",
              "assignee_emails", "follower_emails", "project_id", "project_ids")


def _scan(db: Session, include_deleted: bool = False):
    cols = [getattr(models.Task, c) for c in _SCAN_COLS]
    q = db.query(models.Task).options(load_only(*cols))
    if include_deleted:
        q = q.execution_options(include_deleted=True)
    return q


def visible_labels(db: Session, user: dict, company: str) -> list:
    """[{key, name, count}] for the labels on live tasks the caller can SEE
    (the GET /tasks rule: the company wall, then a non-manager's own
    visibility) that sit in `company` - so a restricted task's labels never
    reach someone who cannot open it. The most common spelling names a
    label; ties go to the first seen."""
    from routers.task_util import (is_manager, task_is_visible, visible_project_ids, wall_tasks)
    rows = wall_tasks(db, user, [t for t in _scan(db).all() if t.tags])
    if not is_manager(user):
        vis = visible_project_ids(db, user)
        rows = [t for t in rows if task_is_visible(t, user, vis)]
    inside = in_company(db, company)
    return _tally(t for t in rows if inside(t))


def company_labels(db: Session, company: str) -> list:
    """[{key, name, count}] over every live task in the company - Manage's
    list, which counts restricted tasks too (an admin view)."""
    inside = in_company(db, company)
    return _tally(t for t in _scan(db).all() if t.tags and inside(t))


def _tally(rows) -> list:
    count: dict = {}
    spellings: dict = {}
    for t in rows:
        for k, name in {label_key(x): clean_name(x) for x in (t.tags or []) if label_key(x)}.items():
            count[k] = count.get(k, 0) + 1
            spellings.setdefault(k, {})
            spellings[k][name] = spellings[k].get(name, 0) + 1
    out = []
    for k, n in count.items():
        names = spellings[k]
        best = max(names.items(), key=lambda kv: kv[1])[0]
        out.append({"key": k, "name": best, "count": n})
    out.sort(key=lambda r: r["name"].lower())
    return out


# ── Rename / merge / delete ───────────────────────────────────────────────
def rewrite(db: Session, company: str, old_key: str, new_name: str | None, actor: str) -> int:
    """Take the label `old_key` off every task in the company - restricted
    and trashed tasks included - and, with `new_name`, put that on in its
    place (a task already carrying `new_name` in any spelling keeps just the
    one). Returns how many tasks changed. Not committed.

    The candidates are found with a narrow scan, then locked in id order
    (tasks._lock_task_rows, the module's lock order) chunk by chunk and read
    again under the lock, so a concurrent edit of one of them is either
    before this or after it - never lost. Each changed task gets ONE quiet
    field-history row (task_history.write quiet: on the task's own history,
    not the Updates card or the briefing) and a new modified_at, so every
    open list picks the change up on its next delta. No email, no bell, no
    automation: an admin tidying the vocabulary is not news about the work."""
    import task_history
    from routers.tasks import _lock_task_rows
    inside = in_company(db, company)
    ids = sorted(t.id for t in _scan(db, include_deleted=True).all()
                 if t.tags and inside(t) and any(label_key(x) == old_key for x in t.tags))
    changed = 0
    now = now_iso()
    new_key = label_key(new_name) if new_name else ""
    for i in range(0, len(ids), _CHUNK):
        chunk = ids[i:i + _CHUNK]
        _lock_task_rows(db, chunk)
        rows = (db.query(models.Task).execution_options(include_deleted=True)
                .filter(models.Task.id.in_(chunk)).order_by(models.Task.id).populate_existing().all())
        for t in rows:
            tags = list(t.tags or [])
            if not any(label_key(x) == old_key for x in tags):
                continue   # changed between the scan and the lock
            before = task_history.snapshot(t)
            # The new name takes the old one's place; when the task already
            # carries it, whichever comes first stays and the other goes.
            out, seen = [], set()
            for tag in tags:
                k, name = label_key(tag), clean_name(tag)
                if k == old_key:
                    if not new_name:
                        continue
                    k, name = new_key, new_name
                if not k or k in seen:
                    continue
                seen.add(k)
                out.append(name)
            t.tags = out
            t.modified_at = now
            task_history.record(db, t, before, actor, only={"tags"}, quiet=True)
            changed += 1
    return changed
