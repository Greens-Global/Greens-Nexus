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
In the same transaction they carry through to what NAMES a label: the
company's automation rules (tag conditions, Add Tag actions), its projects'
row color rules, people's own row color rules (My Tasks) and saved views'
Labels filter. Task templates are left as they are (counted, not changed).

WHO SEES WHAT. The map's entries reach a caller only for labels on tasks
they can open (visible_keys): a label that lives only on restricted tasks
never shows its name through the map. The full list of labels in use, with
counts, is Manage's (managers, `all`).

LOCK ORDER for a rename / delete: the map row, then the tasks (id order,
the Trash included), then the automation rules, the projects, the people's
preferences and the saved views - each in id order.
"""
from __future__ import annotations

import json
from typing import Iterable

from fastapi import HTTPException
from sqlalchemy import String, cast, func, or_
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


def existing_name(name) -> str:
    """A label that already exists (on tasks, in the map), named to recolor,
    rename, delete or remove it: cleaned, never refused for its length - a
    label stored before the MAX_NAME cap (or by an old import) must still be
    manageable. check_name is for a NEW name only."""
    v = clean_name(name)
    if not v:
        raise HTTPException(422, "A label needs a name.")
    return v


def known_keys(db: Session, names) -> set:
    """The keys among `names` that some live task (or task template) already
    carries - a label "in use", which a copy (Duplicate, Create From Template, a board lane's
    Add) or a bulk replace may carry whatever its length. One query for all
    of them (a LIKE per name narrows it, the key confirms it); a label stored
    in a spelling the LIKE misses reads as unknown, which only refuses."""
    want = {label_key(n): clean_name(n).lower() for n in names or () if label_key(n)}
    if not want:
        return set()
    def esc(v):
        return v.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    like = [func.lower(cast(models.Task.tags, String)).like(f"%{esc(v)}%", escape="\\") for v in want.values()]
    found = set()
    for (tags,) in db.query(models.Task.tags).filter(or_(*like)).all():
        for x in tags or []:
            k = label_key(x)
            if k in want:
                found.add(k)
    if found != set(want):
        # A task template's labels are labels in use too: Create From Template
        # carries them, whatever their length.
        tlike = [func.lower(cast(models.TaskTemplate.patch, String)).like(f"%{esc(v)}%", escape="\\")
                 for k, v in want.items() if k not in found]
        for (patch,) in db.query(models.TaskTemplate.patch).filter(or_(*tlike)).all():
            for x in ((patch or {}).get("tags") or []) if isinstance(patch, dict) else []:
                k = label_key(x)
                if k in want:
                    found.add(k)
    return found


def check_new_tags(tags, current=(), db: Session | None = None, known: set | None = None) -> list:
    """A task's labels as a save stores them (create, PATCH, bulk replace,
    import): merged by key (merge_tags - spacing and case variants are one
    label). A label NEW to the task and not already in use on some task
    (known_keys, read only when a rule would refuse) is held to MAX_NAME
    characters, and such a label cannot take a task past MAX_PER_TASK (or
    past what it already carries). Labels the task or the company already
    has pass as they are, so an old long label never blocks a copy."""
    out = merge_tags(tags)
    have = {label_key(x) for x in current or ()}
    fresh = [x for x in out if label_key(x) not in have]
    long = [x for x in fresh if len(x) > MAX_NAME]
    over = len(out) > max(MAX_PER_TASK, len(have))
    if not (long or (over and fresh)):
        return out
    if known is None:   # `known`: worked out once by a caller checking many rows
        known = known_keys(db, fresh) if db is not None else set()
    if any(label_key(x) not in known for x in long):
        raise HTTPException(422, f"A label can be at most {MAX_NAME} characters.")
    if over and any(label_key(x) not in known for x in fresh):
        raise HTTPException(422, f"A task can carry at most {MAX_PER_TASK} labels.")
    return out


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
    """Only entries that say something: a color. An entry with no color
    would only repeat the spelling the tasks already carry (a rename
    rewrites them), so it is dropped - the map never creeps toward MAX_MAP
    with entries that change nothing."""
    out = {}
    if not isinstance(raw, dict):
        return out
    for k, v in raw.items():
        key = label_key(k)
        if not key or not isinstance(v, dict):
            continue
        color = str(v.get("color") or "")
        if color not in TONES:
            continue
        out[key] = {"name": clean_name(v.get("name")) or key, "color": color}
    return out


def get_map(db: Session, company: str = "") -> dict:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == settings_key(company)).first()
    if not row or not row.value:
        return {}
    try:
        return _clean_map(json.loads(row.value))
    except (TypeError, ValueError):
        return {}


def lock_map(db: Session, company: str) -> tuple:
    """(row, map) - the company map's row locked for this transaction (no-op
    on SQLite), created when missing, and the map as it stands under the
    lock. Every change computes from this value, so two admins at once queue
    up rather than one dropping the other's change."""
    key = settings_key(company)
    row = (db.query(models.NexusSetting).filter(models.NexusSetting.key == key)
           .with_for_update().first())
    if row is None:
        row = models.NexusSetting(key=key, value="{}")
        db.add(row)
    try:
        current = _clean_map(json.loads(row.value or "{}"))
    except (TypeError, ValueError):
        current = {}
    return row, current


def apply_map(row, current: dict, change: dict, actor: str) -> dict:
    """Apply {key: entry or None} (None drops the key) to the locked map and
    store it. Not committed."""
    out = dict(current)
    for key, entry in change.items():
        if entry is None:
            out.pop(key, None)
        else:
            out[key] = entry
    out = _clean_map(out)
    if len(out) > MAX_MAP:
        raise HTTPException(422, f"A company can keep at most {MAX_MAP} label colors.")
    row.value = json.dumps(out, sort_keys=True)
    row.updated_by = actor or ""
    row.updated_at = now_iso()
    _cache_drop()
    return out


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
    first of the companies they may pick (company_choices) - so a Global
    Admin with no company of their own lands on a real company, and the
    picker never shows one company over another's data. '' only when there
    is no company at all (then nothing can be changed - require_company)."""
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
    choices = company_choices(db, user)
    return choices[0]["id"] if choices else ""


def require_company(db: Session, company: str) -> None:
    """Behind the walls a change is always for one company: rename / merge /
    delete reach every task in it, and '' would mean every company's."""
    if _walls_on(db) and not company:
        raise HTTPException(422, "Pick the company whose labels to change.")


def _owner_in(db: Session, company: str):
    """Predicate on an email: is this person in `company`'s labels? Everyone
    with the walls off; behind them, the people whose company it is."""
    if not _walls_on(db):
        return lambda email: True
    from routers.task_util import _emp_company_map
    emp = _emp_company_map(db)
    return lambda email: emp.get((email or "").lower(), "") == company


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
              "assignee_emails", "follower_emails", "project_id", "project_ids", "parent_task_id",
              "narrowed_by")


def _scan(db: Session, company: str = "", include_deleted: bool = False):
    """The tasks that carry any label, narrow columns only. Untagged rows are
    left out in SQL; behind the walls so are rows stamped for another
    company (a blank stamp is derived from the owner, so it stays in)."""
    cols = [getattr(models.Task, c) for c in _SCAN_COLS]
    q = (db.query(models.Task).options(load_only(*cols))
         .filter(models.Task.tags.isnot(None), cast(models.Task.tags, String).notin_(["[]", "null", ""])))
    if company and _walls_on(db):
        q = q.filter(or_(models.Task.company_id == company, models.Task.company_id == "",
                         models.Task.company_id.is_(None)))
    if include_deleted:
        q = q.execution_options(include_deleted=True)
    return q


# A short per-company memo of the tagged rows (Oct 22 2026 review): the map
# filter reads them on every page load. Dropped on every label change; a
# label added to a task shows its company color to others within the TTL.
_CACHE_TTL = 45.0
_cache: dict = {}


def _cache_drop() -> None:
    _cache.clear()


def _tagged_rows(db: Session, company: str) -> list:
    """[(id, label keys, visibility fields...)] for live tagged tasks in the
    company - plain tuples, safe to keep between requests."""
    import time
    now = time.monotonic()
    hit = _cache.get(company)
    if hit and now - hit[0] < _CACHE_TTL:
        return hit[1]
    inside = in_company(db, company)
    rows = []
    for t in _scan(db, company).all():
        if not inside(t):
            continue
        keys = frozenset(k for k in (label_key(x) for x in (t.tags or [])) if k)
        if keys:
            rows.append(_Row(t, keys))
    _cache[company] = (now, rows)
    return rows


class _Row:
    """A detached copy of the columns visibility reads (task_is_visible,
    task_company) - a cached row must not hold a session's object."""
    __slots__ = _SCAN_COLS + ("keys",)

    def __init__(self, t, keys):
        for c in _SCAN_COLS:
            v = getattr(t, c)
            setattr(self, c, list(v) if isinstance(v, list) else v)
        self.keys = keys


def visible_keys(db: Session, user: dict, company: str, wanted) -> set:
    """Which of the label keys `wanted` sit on at least one live task the
    caller can SEE (the GET /tasks rule: the company wall, then a
    non-manager's own visibility) in `company`. Cheap checks first; a
    non-manager's visible projects are worked out only when a task's own
    access does not settle it, and the scan stops once every key is found."""
    wanted = {k for k in wanted or () if k}
    if not wanted:
        return set()
    from routers.task_util import ParentSight, is_manager, task_is_visible, visible_project_ids, wall_tasks
    rows = [r for r in _tagged_rows(db, company) if r.keys & wanted]
    if not rows:
        return set()
    rows = wall_tasks(db, user, rows)
    if is_manager(user):
        return set().union(*(r.keys for r in rows)) & wanted
    # Pass 1: what the task itself settles (org-wide, or the caller is on it).
    found: set = set()
    later = []
    for r in rows:
        new = (r.keys & wanted) - found
        if not new:
            continue
        if task_is_visible(r, user, set()):
            found |= new
            if found == wanted:
                return found
        elif r.project_id or r.project_ids or r.parent_task_id:
            later.append(r)
    # Pass 2, only for keys still unfound: sight through a project, which
    # needs the caller's visible projects (a scan of its own) - once - or
    # through a private parent (task_util.ParentSight, read in one batch).
    later = [r for r in later if (r.keys & wanted) - found]
    if later:
        projects = visible_project_ids(db, user)
        parents = ParentSight(db, later, user=user)
        for r in later:
            new = (r.keys & wanted) - found
            if new and task_is_visible(r, user, projects, parents):
                found |= new
                if found == wanted:
                    break
    return found


def visible_map(db: Session, user: dict, company: str) -> dict:
    """The company map, cut down to the labels the caller can see on a task
    - a label that lives only on restricted tasks never shows its name."""
    full = get_map(db, company)
    keep = visible_keys(db, user, company, set(full))
    return {k: v for k, v in full.items() if k in keep}


def company_labels(db: Session, company: str) -> list:
    """[{key, name, count}] over every live task in the company - Manage's
    list, which counts restricted tasks too (an admin view)."""
    inside = in_company(db, company)
    return _tally(t for t in _scan(db, company).all() if t.tags and inside(t))


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
def _lock_ids(db: Session, model, ids) -> None:
    """FOR UPDATE on these rows in id order, soft-deleted ones included (a
    purge or a restore mid-rename waits rather than racing). No-op on SQLite."""
    ids = sorted({i for i in ids if i})
    for i in range(0, len(ids), _CHUNK):
        (db.query(model.id).execution_options(include_deleted=True)
         .filter(model.id.in_(ids[i:i + _CHUNK])).order_by(model.id).with_for_update().all())


def rewrite(db: Session, company: str, old_key: str, new_name: str | None, actor: str) -> int:
    """Take the label `old_key` off every task in the company - restricted
    and trashed tasks included - and, with `new_name`, put that on in its
    place (a task already carrying `new_name` in any spelling keeps just the
    one). Returns how many tasks changed. Not committed.

    The candidates are found with a narrow scan, then locked in id order
    chunk by chunk (trashed rows too) and read again under the lock, so a
    concurrent edit of one of them is either before this or after it -
    never lost. Each changed task gets ONE quiet field-history row
    (task_history.write quiet: on the task's own history, not the Updates
    card or the briefing) and a new modified_at, so every open list picks the
    change up on its next delta. No email, no bell, no automation: an admin
    tidying the vocabulary is not news about the work."""
    import task_history
    inside = in_company(db, company)
    ids = sorted(t.id for t in _scan(db, company, include_deleted=True).all()
                 if t.tags and inside(t) and any(label_key(x) == old_key for x in t.tags))
    changed = 0
    now = now_iso()
    new_key = label_key(new_name) if new_name else ""
    for i in range(0, len(ids), _CHUNK):
        chunk = ids[i:i + _CHUNK]
        _lock_ids(db, models.Task, chunk)
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
    _cache_drop()
    return changed


def task_count(db: Session, company: str, key: str) -> int:
    """How many tasks in the company carry the label - the Recycle Bin too."""
    inside = in_company(db, company)
    return sum(1 for t in _scan(db, company, include_deleted=True).all()
               if inside(t) and any(label_key(x) == key for x in (t.tags or [])))


# ── What names a label: rules, row colors, saved views ───────────────────
def _names(value, old_key: str) -> bool:
    return isinstance(value, str) and label_key(value) == old_key


def _color_rules_naming(rules, old_key: str) -> bool:
    return any(_names(c.get("value"), old_key)
               for r in (rules if isinstance(rules, list) else []) if isinstance(r, dict)
               for c in (r.get("conditions") or []) if isinstance(c, dict) and c.get("field") == "tags")


def _rename_color_rules(rules, old_key: str, new_name: str) -> list:
    out = []
    for r in rules if isinstance(rules, list) else []:
        if not isinstance(r, dict):
            out.append(r)
            continue
        conds = []
        for c in r.get("conditions") or []:
            if isinstance(c, dict) and c.get("field") == "tags" and _names(c.get("value"), old_key):
                c = {**c, "value": new_name}
            conds.append(c)
        out.append({**r, "conditions": conds})
    return out


def _rule_naming(rule, old_key: str) -> tuple:
    """(conditions name it, Add Tag actions add it)."""
    conds = any(isinstance(c, dict) and c.get("field") == "tag" and _names(c.get("value"), old_key)
                for c in (rule.conditions or []))
    acts = any(isinstance(a, dict) and a.get("type") == "add_tag" and _names(a.get("value"), old_key)
               for a in (rule.actions or []))
    return conds, acts


def carry_through(db: Session, company: str, old_key: str, new_name: str | None, *, dry_run: bool = False) -> dict:
    """Bring everything that NAMES the label along with a rename (`new_name`)
    or a delete (None). `dry_run` only counts - Manage's confirmation.

      automation rules   the company's (all with the walls off). Rename:
                         tag conditions and Add Tag actions take the new
                         name. Delete: Add Tag actions naming it are removed
                         (else the label comes back on the next run); a rule
                         left with no action is switched off; conditions are
                         left alone and counted (`rulesStillNaming`). Behind
                         the walls a rule shared by every company is never
                         changed from one company - counted (`sharedRules`).
      project row colors the company's projects: tag conditions renamed
                         (delete leaves them; they simply match nothing).
      My Tasks row colors each person's own rules (task_table_prefs
                         rowColors.data.mine), people in the company.
      saved views        Labels filter (filters.tags): renamed, or the label
                         dropped from it on delete; owners in the company.
      templates          NOT changed - counted (`templates`).
    Each table is locked in id order before it is written. Not committed."""
    from routers.task_util import config_admits, row_company
    walls = _walls_on(db)
    owner_in = _owner_in(db, company)
    out = {"automationRules": 0, "rulesDisabled": 0, "rulesStillNaming": 0, "sharedRules": 0,
           "projects": 0, "personalRules": 0, "savedViews": 0, "templates": 0}

    # Automation rules.
    rules = db.query(models.TaskAutomationRule).order_by(models.TaskAutomationRule.id).all()
    mine, shared = [], 0
    for r in rules:
        conds, acts = _rule_naming(r, old_key)
        if not (conds or acts):
            continue
        rc = (r.company_id or "").strip()
        if walls and rc != company:
            if not rc:
                shared += 1
            continue
        mine.append(r.id)
    out["sharedRules"] = shared
    if mine and not dry_run:
        _lock_ids(db, models.TaskAutomationRule, mine)
        locked = (db.query(models.TaskAutomationRule).filter(models.TaskAutomationRule.id.in_(mine))
                  .order_by(models.TaskAutomationRule.id).populate_existing().all())
    else:
        locked = [r for r in rules if r.id in set(mine)]
    for r in locked:
        conds, acts = _rule_naming(r, old_key)
        if not (conds or acts):
            continue
        if new_name:
            out["automationRules"] += 1
            if dry_run:
                continue
            r.conditions = [({**c, "value": new_name} if isinstance(c, dict) and c.get("field") == "tag"
                             and _names(c.get("value"), old_key) else c) for c in (r.conditions or [])]
            r.actions = [({**a, "value": new_name} if isinstance(a, dict) and a.get("type") == "add_tag"
                          and _names(a.get("value"), old_key) else a) for a in (r.actions or [])]
            continue
        if conds:
            out["rulesStillNaming"] += 1
        if acts:
            out["automationRules"] += 1
            kept = [a for a in (r.actions or []) if not (isinstance(a, dict) and a.get("type") == "add_tag"
                                                         and _names(a.get("value"), old_key))]
            if not kept:
                out["rulesDisabled"] += 1
            if not dry_run:
                r.actions = kept
                if not kept:
                    r.enabled = False   # a rule must have an action to run (validate_rule)

    # Project row color rules - renamed only; a delete leaves them be.
    if new_name or dry_run:
        projects = (db.query(models.TaskProject).execution_options(include_deleted=True)
                    .filter(models.TaskProject.color_rules.isnot(None),
                            cast(models.TaskProject.color_rules, String).notin_(["[]", "null", ""])).all())
        ids = [p.id for p in projects if _color_rules_naming(p.color_rules, old_key)
               and (not walls or row_company(db, p) == company)]
        out["projects"] = len(ids)
        if ids and new_name and not dry_run:
            _lock_ids(db, models.TaskProject, ids)
            now = now_iso()
            for p in (db.query(models.TaskProject).execution_options(include_deleted=True)
                      .filter(models.TaskProject.id.in_(ids)).order_by(models.TaskProject.id)
                      .populate_existing().all()):
                if _color_rules_naming(p.color_rules, old_key):
                    p.color_rules = _rename_color_rules(p.color_rules, old_key, new_name)
                    p.modified_at = now

    # People's own My Tasks row colors - renamed only.
    def _mine(prefs):
        data = ((prefs or {}).get("rowColors") or {}).get("data") if isinstance(prefs, dict) else None
        return data.get("mine") if isinstance(data, dict) else None

    if new_name or dry_run:
        prefs = [x for x in db.query(models.TaskTablePref).all()
                 if owner_in(x.owner_email) and _color_rules_naming(_mine(x.prefs), old_key)]
        out["personalRules"] = len(prefs)
        if prefs and new_name and not dry_run:
            _lock_ids(db, models.TaskTablePref, [x.id for x in prefs])
            now = now_iso()
            for x in (db.query(models.TaskTablePref).filter(models.TaskTablePref.id.in_([x.id for x in prefs]))
                      .order_by(models.TaskTablePref.id).populate_existing().all()):
                if not _color_rules_naming(_mine(x.prefs), old_key):
                    continue
                doc = json.loads(json.dumps(x.prefs))
                doc["rowColors"]["data"]["mine"] = _rename_color_rules(doc["rowColors"]["data"]["mine"],
                                                                      old_key, new_name)
                x.prefs = doc
                x.updated_at = now

    # Saved views' Labels filter - renamed, or the label taken out.
    def _view_names(v) -> bool:
        tags = (v.filters or {}).get("tags") if isinstance(v.filters, dict) else None
        return isinstance(tags, list) and any(_names(x, old_key) for x in tags)

    views = [v for v in db.query(models.TaskSavedView).all() if owner_in(v.owner_email) and _view_names(v)]
    out["savedViews"] = len(views)
    if views and not dry_run:
        _lock_ids(db, models.TaskSavedView, [v.id for v in views])
        for v in (db.query(models.TaskSavedView).filter(models.TaskSavedView.id.in_([v.id for v in views]))
                  .order_by(models.TaskSavedView.id).populate_existing().all()):
            if not _view_names(v):
                continue
            tags, seen = [], set()
            for x in v.filters.get("tags") or []:
                k = label_key(x) if isinstance(x, str) else ""
                if k == old_key:
                    if not new_name:
                        continue
                    k = label_key(new_name)
                if k and k not in seen:
                    seen.add(k)
                    tags.append(k)
            v.filters = {**v.filters, "tags": tags}

    # Templates: counted, never changed.
    scope = {company} if walls else None

    def _template_names(t) -> bool:
        tags = t.patch.get("tags") if isinstance(t.patch, dict) else None
        return isinstance(tags, list) and any(_names(x, old_key) for x in tags)

    out["templates"] = sum(1 for t in db.query(models.TaskTemplate).all()
                           if config_admits(getattr(t, "company_id", "") or "", scope) and _template_names(t))
    return out
