"""Field history for tasks (Neil, Oct 22 2026).

"Who changed this field, when, from what to what." Every write path that
changes a task's fields takes a `snapshot` before it writes and calls
`record` once the row stands as it will be committed. Each field that really
moved becomes ONE activity row carrying the structured change on
TaskActivity.field_change:

    {"field": "priority", "fieldId": "", "label": "Priority",
     "from": "medium", "to": "high", "labels": {...}}

Values stay raw - status / option / project / section ids, emails, ISO dates -
and the client renders them. `labels` keeps the names (and option colors) of
the ids involved as they were at the time, so a deleted option, status,
project or section still reads as what it was called.

No second row for a story already told. A status move that is the task being
completed / closed as Missed lands on the "completed" / "closed_missed" row
the caller already logged (see CLAIMS); a status move otherwise is a
"status_changed" row and an assignee move an "assignee_changed" row - the
same types and wording the feeds, the Updates card and the briefing always
read. Every other field is a "field_changed" row whose detail is one short
line ("changed Priority"), so a feed that prints `detail` stays tidy.

Due dates are not recorded here: every due_on write already goes through
task_due.record_due_change, whose "due_changed" row carries the change. The
one writer that moves due_on on its own (the HR checklist sync) asks for it
with `with_due`.

Automation rules (task_automation.run_for_change) record their own part
under AUTOMATION_ACTOR; `record_edit` then records the person's part, so a
rule's change is never put on the person who triggered it.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

import models
from routers.task_util import log_activity, now_iso, task_assignees

FIELD_CHANGED = "field_changed"
# Every activity type that can carry a field_change, for the history query.
HISTORY_TYPES = (FIELD_CHANGED, "status_changed", "assignee_changed", "due_changed",
                 "completed", "closed_missed")

# The core fields, in the order a save records them, with the name a person
# reads. dueOn is task_due's (see above); custom fields are "customField".
CORE = (
    ("title", "Title"),
    ("status", "Status"),
    ("priority", "Priority"),
    ("startOn", "Start Date"),
    ("assigneeIds", "Assignees"),
    ("projectId", "Project"),
    ("projectIds", "Also In"),
    ("sectionId", "Section"),
    ("tags", "Labels"),          # what the drawer calls them
    ("estimateHours", "Estimate"),
    ("isMilestone", "Milestone"),
    ("approvalStatus", "Approval"),
)
CUSTOM = "customField"
DUE = "dueOn"

# A status move already told by another row: activity type -> the status it
# moved to. Recorded on that row instead of a second "status_changed".
CLAIMS = {"status": {"completed": "completed", "closed_missed": "missed"}}

_BUILTIN_STATUS = {"not_started": "Not Started", "in_progress": "In Progress", "completed": "Completed",
                   "recurring": "Recurring", "missed": "Missed"}


def _blank(v):
    """One "empty" for every kind: None, "", [] and {} all read as Empty."""
    if v is None or v == "" or v == [] or v == {}:
        return None
    return v


def _same(a, b) -> bool:
    a, b = _blank(a), _blank(b)
    if isinstance(a, list) and isinstance(b, list):
        return sorted(map(str, a)) == sorted(map(str, b))
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool) \
            and not isinstance(b, bool):
        return float(a) == float(b)
    return a == b


def _copy(v):
    if isinstance(v, list):
        return list(v)
    if isinstance(v, dict):
        return dict(v)
    return v


def snapshot(t: models.Task) -> dict:
    """The tracked fields, frozen. `_at` marks when, so `record` only ever
    reuses a row logged after it."""
    cf = t.custom_field_values if isinstance(t.custom_field_values, dict) else {}
    primary = t.project_id or ""
    return {
        "_at": now_iso(),
        "title": t.title or "",
        "status": t.status or "",
        "priority": t.priority or "",
        "startOn": (t.start_on or "")[:10],
        "dueOn": (t.due_on or "")[:10],
        "assigneeIds": list(task_assignees(t)),
        "projectId": primary,
        "projectIds": [p for p in (t.project_ids or []) if p and p != primary],
        "sectionId": t.section_id or "",
        "tags": [str(x) for x in (t.tags or []) if str(x).strip()],
        "estimateHours": t.estimate_hours,
        "isMilestone": bool(t.is_milestone),
        "approvalStatus": (t.approval_status or "none") if (t.approval_status or "none") != "none" else "",
        "cf": {k: _copy(v) for k, v in cf.items()},
    }


def key_of(change: dict) -> str:
    """The key `diff`'s only / exclude take for a change: the core field name,
    or "cf:<id>" for a custom field."""
    return f"cf:{change['fieldId']}" if change["field"] == CUSTOM else change["field"]


def _cached(db: Session, kind: str, ids, load) -> dict:
    """{id: value} for `ids`, each looked up once per session: a bulk edit of
    fifty tasks asks for the same status / field names fifty times. `load`
    takes the ids not seen yet and answers {id: value}; a miss is kept as
    None so it is not asked again."""
    cache = db.info.setdefault("task_history_cache", {})
    missing = [i for i in ids if (kind, i) not in cache]
    if missing:
        found = load(missing)
        for i in missing:
            cache[(kind, i)] = found.get(i)
    return {i: (dict(v) if isinstance(v, dict) else v) for i in ids
            if (v := cache.get((kind, i))) is not None}


def _custom_defs(db: Session, ids) -> dict:
    ids = sorted({i for i in ids if i})
    if not ids:
        return {}
    return _cached(db, "field", ids, lambda miss: {
        f.id: f for f in db.query(models.TaskCustomField).filter(models.TaskCustomField.id.in_(miss)).all()})


def _records_custom(f) -> bool:
    """A task field a person sets. A read-only (formula) field is computed,
    and a project-level field's values live on the project."""
    if f is None or f.read_only:
        return False
    from routers.task_config import _parse_applies_to
    return "task" in _parse_applies_to(f.applies_to)


def _ids(v) -> list:
    v = _blank(v)
    if v is None:
        return []
    return [str(x) for x in (v if isinstance(v, list) else [v])]


def _labels_for(db: Session, field: str, frm, to, f=None) -> dict:
    """{id: {label, color?}} for the ids a change involves, as named now."""
    ids = set(_ids(frm)) | set(_ids(to))
    if not ids:
        return {}
    ids = sorted(ids)
    out: dict = {}
    if field == "status":
        out = _cached(db, "status", ids, lambda miss: {
            r.id: {"label": r.label or r.id, "color": r.color or ""}
            for r in db.query(models.TaskCustomStatus).filter(models.TaskCustomStatus.id.in_(miss)).all()})
        for i in ids:
            if i not in out and i in _BUILTIN_STATUS:
                out[i] = {"label": _BUILTIN_STATUS[i]}
    elif field in ("projectId", "projectIds"):
        out = _cached(db, "project", ids, lambda miss: {
            r.id: {"label": r.name or ""}
            for r in (db.query(models.TaskProject).execution_options(include_deleted=True)
                      .filter(models.TaskProject.id.in_(miss)).all())})
    elif field == "sectionId":
        # The project rides along: a restricted project's section names are
        # hidden from whoever cannot see that project (Redactor).
        out = _cached(db, "section", ids, lambda miss: {
            r.id: {"label": r.name or "", "projectId": r.project_id or ""}
            for r in db.query(models.TaskSection).filter(models.TaskSection.id.in_(miss)).all()})
    elif field == CUSTOM and f is not None and (f.type or "") in ("select", "multiselect"):
        from routers.task_config import normalize_field_options
        for o in normalize_field_options(f.options or []):
            if o["id"] in ids:
                out[o["id"]] = {"label": o["label"], "color": o.get("color") or ""}
    return out


def diff(db: Session, before: dict, after: dict, *, only=None, exclude=(), with_due: bool = False) -> list[dict]:
    """The changes from `before` to `after` (two snapshots), as field_change
    dicts. `only` / `exclude` are keys: a core field name, or "cf:<id>".
    The due date only with `with_due` - for a writer that moves it without
    task_due.record_due_change (the HR checklist sync)."""
    out = []
    if with_due and not _same(before.get(DUE), after.get(DUE)):
        out.append(due_change(before.get(DUE) or "", after.get(DUE) or ""))
    for field, label in CORE:
        if (only is not None and field not in only) or field in exclude:
            continue
        a, b = before.get(field), after.get(field)
        if _same(a, b):
            continue
        out.append({"field": field, "fieldId": "", "label": label,
                    "from": _blank(_copy(a)), "to": _blank(_copy(b))})
    cf0, cf1 = before.get("cf") or {}, after.get("cf") or {}
    moved = [fid for fid in dict.fromkeys([*cf0.keys(), *cf1.keys()])
             if not _same(cf0.get(fid), cf1.get(fid))
             and (only is None or f"cf:{fid}" in only) and f"cf:{fid}" not in exclude]
    defs = _custom_defs(db, moved) if moved else {}
    for fid in moved:
        f = defs.get(fid)
        if not _records_custom(f):
            continue   # deleted, read-only (formula) or a project field
        ch = {"field": CUSTOM, "fieldId": fid, "label": f.name or "", "type": (f.type or "text").lower(),
              "from": _blank(_copy(cf0.get(fid))), "to": _blank(_copy(cf1.get(fid)))}
        scope = [x for x in (f.project_ids or []) if x]
        if scope:
            ch["scope"] = scope   # a field only those projects use (Redactor)
        out.append(ch)
    for ch in out:
        labels = _labels_for(db, ch["field"], ch["from"], ch["to"], defs.get(ch["fieldId"]))
        if labels:
            ch["labels"] = labels
    return out


def _claim(db: Session, t: models.Task, change: dict, since: str):
    """A row this request already logged on `t` that tells this change's story
    (CLAIMS) and carries no change yet - or None."""
    wanted = CLAIMS.get(change["field"]) or {}
    if not wanted:
        return None
    for entity_id, type_, at, row in reversed(db.info.get("task_activity_rows") or []):
        if entity_id != t.id or (at or "") < since:
            continue
        if wanted.get(type_) == change["to"] and getattr(row, "field_change", None) is None:
            return row
    return None


def _type_and_detail(change: dict) -> tuple[str, str]:
    if change["field"] == "status":
        # The wording every reader of status_changed parses (daily_briefing).
        return "status_changed", f"changed status to {change['to'] or ''}"
    if change["field"] == "assigneeIds":
        return "assignee_changed", "reassigned this task"
    if change["field"] == DUE:
        from task_due import us_date
        frm, to = change.get("from") or "", change.get("to") or ""
        if not frm:
            return "due_changed", f"set the due date to {us_date(to)}"
        if not to:
            return "due_changed", f"removed the due date (was {us_date(frm)})"
        return "due_changed", f"changed the due date from {us_date(frm)} to {us_date(to)}"
    return FIELD_CHANGED, f"changed {change['label'] or 'a field'}"


def record(db: Session, t: models.Task, before: dict, actor: str, *, after: dict | None = None,
           only=None, exclude=(), with_due: bool = False, quiet: bool = False, at: str | None = None) -> list[str]:
    """Log what changed on `t` since `before` (or up to `after`), attributed to
    `actor`. Returns the ids of new status / assignee rows - the ones callers
    keep on t.activity_ids; field rows are found by entity id and left off the
    task row so it does not grow with every edit. A no-op records nothing.
    `quiet` / `at`: see write."""
    if before is None:
        return []
    changes = diff(db, before, after if after is not None else snapshot(t), only=only, exclude=exclude,
                   with_due=with_due)
    return write(db, t, changes, actor, since=before.get("_at") or "", quiet=quiet, at=at)


def write(db: Session, t: models.Task, changes: list[dict], actor: str, *, since: str = "",
          quiet: bool = False, at: str | None = None) -> list[str]:
    """Log `changes` (from diff) on `t` - see record. `quiet` writes even a
    status / assignee move as a plain field_changed row: on the task's own
    history, never on the Updates card or the briefing (an admin action across
    hundreds of tasks, like the offboarding handover). `at` dates the rows
    (default now) - a person's part of an edit a rule then added to is dated
    to before the rule ran (record_edit)."""
    ids = []
    for ch in changes:
        row = _claim(db, t, ch, since)
        if row is not None:
            row.field_change = ch
            continue
        type_, detail = _type_and_detail(ch)
        if quiet and type_ != "due_changed":
            type_, detail = FIELD_CHANGED, f"changed {ch['label'] or 'a field'}"
        aid = log_activity(db, type=type_, actor_email=actor or "system", entity_id=t.id,
                           entity_code=t.code or "", entity_title=t.title or "", detail=detail, change=ch, at=at)
        if type_ != FIELD_CHANGED:
            ids.append(aid)
    return ids


def record_edit(db: Session, t: models.Task, before: dict, actor: str, auto=None) -> list[str]:
    """A person's edit that an automation pass may have added to. The rules
    recorded their own changes (task_automation.run_for_change, as
    AUTOMATION_ACTOR) and left on `auto` the state they started from
    (history_mid) and the state they left (history_post). The person is
    credited with everything else; for a field a rule moved, with what they
    did to it before the rules ran (dated then, so it reads before the rule's
    line) and with whatever the rest of their edit did to it after - a
    completion landing on top of a rule's status move."""
    mid = getattr(auto, "history_mid", None)
    post = getattr(auto, "history_post", None)
    keys = set(getattr(auto, "history_keys", None) or ())
    if mid is None or not keys:
        return record(db, t, before, actor)
    ids = record(db, t, before, actor, after=mid, only=keys, at=mid.get("_at"))
    ids += record(db, t, before, actor, exclude=keys)
    if post is not None:
        ids += record(db, t, post, actor, only=keys)
    return ids


def due_change(old: str, new: str) -> dict:
    """The field_change a due_changed row carries (task_due.record_due_change)."""
    return {"field": DUE, "fieldId": "", "label": "Due Date",
            "from": (old or "")[:10] or None, "to": (new or "")[:10] or None}


def to_dict(a: models.TaskActivity, ch: dict | None = None) -> dict | None:
    """One history entry for the client; `ch` is the row's change as the
    Redactor left it (default: the row's own)."""
    if ch is None:
        ch = a.field_change if isinstance(a.field_change, dict) else None
    if not ch:
        return None
    return {
        "id": a.id, "at": a.at or "", "actorId": a.actor_email or None, "type": a.type or "",
        "field": ch.get("field") or "", "fieldId": ch.get("fieldId") or None,
        "label": ch.get("label") or "", "kind": ch.get("type") or None,
        "from": ch.get("from"), "to": ch.get("to"), "labels": ch.get("labels") or {},
    }


def matches(entry: dict, field: str) -> bool:
    """`field` is a core key ("priority"), "customField" for every custom
    field, or a custom field's id - or several of those, comma-separated (the
    drawer's Projects row is projectId and projectIds)."""
    wanted = {f.strip() for f in (field or "").split(",") if f.strip()}
    if not wanted:
        return True
    return entry["field"] in wanted or (entry["field"] == CUSTOM and entry["fieldId"] in wanted)


# Which activity types can hold a field's history - the SQL half of the
# ?field= filter, so a page is read from the rows that can match at all.
_TYPES_FOR = {
    "status": ("status_changed", "completed", "closed_missed"),
    "assigneeIds": ("assignee_changed", FIELD_CHANGED),   # field_changed: a quiet write (handover)
    DUE: ("due_changed",),
}


def types_for(field: str) -> tuple:
    wanted = {f.strip() for f in (field or "").split(",") if f.strip()}
    if not wanted:
        return HISTORY_TYPES
    out: set = set()
    for w in wanted:
        out |= set(_TYPES_FOR.get(w, (FIELD_CHANGED,)))
    return tuple(sorted(out))


class Redactor:
    """What a caller may not read in a task's history (Oct 22 2026 review).
    Seeing the task is not seeing every project it touches: a task can also
    sit in a restricted project the caller is not on. For someone who is not
    a manager, `apply` takes off the names of projects they cannot see and of
    those projects' sections, and marks for hiding the changes to a custom
    field only such projects use (its name and option labels are that
    project's). Managers see everything inside their wall, as on the lists.
    The visible-project set is worked out once, and only when needed."""

    def __init__(self, db: Session, user: dict):
        from routers.task_util import is_manager
        self.db, self.user = db, user
        self.open = is_manager(user)
        self._visible = None

    def _vis(self) -> set:
        if self._visible is None:
            from routers.task_util import visible_project_ids
            self._visible = visible_project_ids(self.db, self.user)
        return self._visible

    def apply(self, changes: list) -> set:
        """Strip `changes` (field_change-shaped dicts) in place; answers the
        id() of each change to hide entirely."""
        changes = [c for c in changes if isinstance(c, dict)]
        if self.open or not changes:
            return set()
        need_sec = {k for c in changes if c.get("field") == "sectionId"
                    for k, v in (c.get("labels") or {}).items() if "projectId" not in (v or {})}
        sec_project = ({r.id: r.project_id or "" for r in
                        self.db.query(models.TaskSection.id, models.TaskSection.project_id)
                        .filter(models.TaskSection.id.in_(need_sec)).all()} if need_sec else {})
        need_cf = {c.get("fieldId") for c in changes
                   if c.get("field") == CUSTOM and "scope" not in c and c.get("fieldId")}
        cf_scope = ({f.id: [x for x in (f.project_ids or []) if x] for f in
                     self.db.query(models.TaskCustomField.id, models.TaskCustomField.project_ids)
                     .filter(models.TaskCustomField.id.in_(need_cf)).all()} if need_cf else {})
        hidden = set()
        for c in changes:
            field, labels = c.get("field"), c.get("labels") or {}
            if field in ("projectId", "projectIds") and labels:
                c["labels"] = {k: v for k, v in labels.items() if k in self._vis()}
            elif field == "sectionId" and labels:
                keep = {}
                for k, v in labels.items():
                    pid = (v or {}).get("projectId") if "projectId" in (v or {}) else sec_project.get(k, "")
                    if not pid or pid in self._vis():
                        keep[k] = v
                c["labels"] = keep
            elif field == CUSTOM:
                scope = c["scope"] if "scope" in c else cf_scope.get(c.get("fieldId"), [])
                if scope and not (set(scope) & self._vis()):
                    hidden.add(id(c))
        return hidden
