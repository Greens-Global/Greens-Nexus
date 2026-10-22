"""Import tasks from a CSV or Excel file (Neil, Oct 22 2026).

POST /tasks/import (routers/tasks.py). The browser reads the file, the person
maps its columns to task fields, and the rows arrive here as raw cell values
keyed by field. Everything is decided HERE - the browser's preview is this
module's own dry run - so a hand-built request gets exactly the checks a
person clicking through the wizard gets:

  * the project: editor or better (company wall first, like any move of work
    into a project), and an external caller must be able to see it;
  * every person named (assignees, people fields) is a current directory
    person on the project's side of the company wall - matched by work email
    or by exact directory name. Anyone else is LEFT OFF with a warning, the
    way a create drops them (task_util.split_people / droppedPeople), never
    turned into an arbitrary address;
  * statuses, priorities and select options match by label, ignoring case;
    an unknown one is a warning and the value is left at its default. A
    missing option is added only when asked AND the caller may change the
    field's definition (a manager, and behind a company wall not a shared
    field) - the rule Manage > Fields enforces;
  * dates: MM/DD/YYYY (US, the default), YYYY-MM-DD, Excel serial numbers and
    real date cells (the browser sends those as YYYY-MM-DD). 03/04/2026 is
    March 4 - always; a "day" over 12 in the first place is an error, never
    swapped round;
  * a project's required custom fields: a top-level row without one is an
    ERROR (create_task refuses the same task), a subtask is part of its parent;
  * Parent: another row of the same file, by its title or its row number;
    subtasks are created after their parents, in file order.

All-or-nothing. A row with an error is skipped and reported; every other row
is created in ONE transaction, so a failure part-way (the database, a bug)
leaves nothing behind - no half-imported plan to clean up by hand. 2,000
rows is a few thousand INSERTs in one commit, well within what Postgres does
in a second or two; task codes come from the counter as one block
(code_sequence.next_task_codes) so the counter's row lock is held for one
UPDATE, not 2,000.

Each task is built by the same helpers create_task uses (_new_task_row,
set_task_assignees, task_due.init_due, the 'created' automation pass,
_apply_completion) and gets the normal "created this task" activity row; the
project gets one "imported N tasks from file.xlsx" row. Nobody is told
anything unless Notify Assignees is ticked, and then it is one bell per
person for the whole import and one batched email per person
(task_notify.queue_bulk_assignments) - never one per task. Comments an
automation rule adds are posted silently for the same reason.
"""
from __future__ import annotations

import html
import logging
import re
import time
from datetime import date, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

import auth
import models
import task_automation
import task_due
from database import SessionLocal
from routers.task_config import (
    _parse_applies_to, coerce_custom_field_values, field_applies_to, missing_required_fields,
    normalize_field_options,
)
from routers.task_util import (
    config_admits, fire_task_event, gen_id, is_manager, log_activity, note_dropped_people,
    now_iso, person_problem, require_project_access, set_task_assignees, task_assignees, task_notify,
    visible_project_ids,
)

log = logging.getLogger(__name__)

MAX_ROWS = 2000
MAX_TITLE = 500
MAX_TEXT = 20000
MAX_TAGS = 30

_BUILTIN_STATUS_LABELS = {"not_started": "Not Started", "in_progress": "In Progress", "completed": "Completed"}
_STATUS_SYNONYMS = {
    "not started": "not_started", "to do": "not_started", "todo": "not_started", "open": "not_started",
    "new": "not_started",
    "in progress": "in_progress", "started": "in_progress", "doing": "in_progress", "wip": "in_progress",
    "completed": "completed", "complete": "completed", "done": "completed", "closed": "completed",
}
_PRIORITY_SYNONYMS = {"low": "low", "medium": "medium", "med": "medium", "normal": "medium",
                      "high": "high", "urgent": "urgent", "critical": "urgent"}
_TRUE = {"yes", "y", "true", "1", "x", "checked", "done", "on"}
_FALSE = {"no", "n", "false", "0", "unchecked", "off"}


def _norm(s) -> str:
    """Case-, spacing-, underscore- and dash-insensitive key."""
    return re.sub(r"[\s_\-]+", " ", str(s or "").strip().lower())


def _cell(raw) -> str:
    """A raw cell as trimmed text. Lists (a client that already split a cell)
    join back with commas."""
    if raw is None:
        return ""
    if isinstance(raw, bool):
        return "Yes" if raw else "No"
    if isinstance(raw, float) and raw.is_integer():
        raw = int(raw)
    if isinstance(raw, (list, tuple)):
        return ", ".join(_cell(x) for x in raw if _cell(x))
    return str(raw).strip()


def _split(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"[;,\n]+", text or "") if p.strip()]


# ── Dates ────────────────────────────────────────────────────────────────────
_EXCEL_EPOCH = date(1899, 12, 30)   # serial 1 = 01/01/1900, with Excel's 1900 leap-year bug folded in
_ISO_RE = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$")
_US_RE = re.compile(r"^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})$")
_NAMED_FORMATS = ("%b %d, %Y", "%B %d, %Y", "%b %d %Y", "%B %d %Y", "%d %b %Y", "%d %B %Y")


def parse_import_date(raw) -> tuple[str, bool]:
    """(YYYY-MM-DD, ok). Blank -> ("", True).

    US first and only: 03/04/2026 is March 4, never April 3 - Nexus shows
    and reads dates as MM/DD/YYYY everywhere, and a file mixing the two
    orders cannot be told apart row by row. A first number over 12 is
    therefore an error, not a hint to swap. Also YYYY-MM-DD (with or without
    a time), M/D/YY (20YY), "Oct 22, 2026", and Excel serial numbers (a date
    cell the browser could not read as a date arrives as its serial)."""
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return "", True
    if isinstance(raw, bool):
        return "", False
    text = _cell(raw)
    num = None
    if isinstance(raw, (int, float)):
        num = float(raw)
    elif re.fullmatch(r"\d+(\.\d+)?", text):
        num = float(text)
    if num is not None:
        # 10000..100000 is 05/18/1927..10/14/2173: a serial, not a year or a
        # YYYYMMDD number (which is far larger) or a stray small count.
        if 10000 <= num <= 100000:
            return (_EXCEL_EPOCH + timedelta(days=int(num))).isoformat(), True
        return "", False
    y = m = d = None
    hit = _ISO_RE.match(text)
    if hit:
        y, m, d = int(hit.group(1)), int(hit.group(2)), int(hit.group(3))
    else:
        hit = _US_RE.match(text)
        if hit:
            m, d, y = int(hit.group(1)), int(hit.group(2)), int(hit.group(3))
            if len(hit.group(3)) == 2:
                y += 2000
        else:
            for fmt in _NAMED_FORMATS:
                try:
                    parsed = datetime.strptime(text.replace(".", ""), fmt).date()
                    y, m, d = parsed.year, parsed.month, parsed.day
                    break
                except ValueError:
                    continue
    if y is None or not (1900 <= y <= 2200):
        return "", False
    try:
        return date(y, m, d).isoformat(), True
    except ValueError:
        return "", False


def _as_html(text: str) -> str:
    """Plain text -> the HTML descriptions are stored as. Escaped: a file is
    never a way to put markup (or a script) into a task."""
    if not text:
        return ""
    paras = [p for p in re.split(r"\n\s*\n", text.replace("\r\n", "\n")) if p.strip()]
    return "".join("<p>" + html.escape(p.strip()).replace("\n", "<br>") + "</p>" for p in paras)


# ── People ───────────────────────────────────────────────────────────────────
class _People:
    """The directory, loaded once per import: by work email, and by exact
    name (the name the People picker shows, and first + last)."""

    _ANGLE = re.compile(r"<([^<>@\s]+@[^<>\s]+)>")

    def __init__(self, db: Session, user: dict, company_id: str):
        self.db, self.user = db, user
        self.actor = (user.get("email") or "").lower()
        # person_problem judges against the task's company - every imported
        # task is stamped with the importer's, so one stand-in task serves all.
        self.probe = models.Task(id="import-probe", company_id=company_id, owner_email="",
                                 created_by=self.actor)
        self.known: set = set()
        self.by_name: dict = {}
        rows = (db.query(models.NexusEmployee.work_email, models.NexusEmployee.first_name,
                         models.NexusEmployee.last_name, models.NexusEmployee.display_name,
                         models.NexusEmployee.status, models.NexusEmployee.company)
                .filter(models.NexusEmployee.work_email != "").all())
        # Names resolve only to people the caller's People picker shows: behind
        # a company wall, their own companies - a name is never a way to find
        # out who works on the other side of it.
        scope = auth.company_scope(user, db)
        for e in rows:
            email = (e.work_email or "").strip().lower()
            if not email:
                continue
            self.known.add(email)
            if (e.status or "") == "offboarded":
                continue
            if scope is not None and (e.company or "") not in scope:
                continue
            names = {(e.display_name or "").strip(), f"{e.first_name or ''} {e.last_name or ''}".strip()}
            for n in names:
                if n:
                    self.by_name.setdefault(_norm(n), set()).add(email)
        self._problems: dict = {}

    def resolve(self, token: str) -> tuple[str, str]:
        """(email, "") for a person who may be put on an imported task, else
        ("", why)."""
        tok = (token or "").strip()
        angle = self._ANGLE.search(tok)
        if angle:
            tok = angle.group(1)
        if "@" in tok:
            email = tok.strip().lower()
            if email == self.actor:
                return email, ""
            if email not in self.known:
                return "", "is not in the Nexus directory"
        else:
            hits = self.by_name.get(_norm(tok), set())
            if not hits:
                return "", "is not in the Nexus directory"
            if len(hits) > 1:
                return "", "matches more than one person - use their email"
            email = next(iter(hits))
            if email == self.actor:
                return email, ""
        if email not in self._problems:
            self._problems[email] = person_problem(self.db, self.probe, email, self.user)
        problem = self._problems[email]
        return ("", problem) if problem else (email, "")


# ── The import context (everything loaded once) ─────────────────────────────
class _Context:
    def __init__(self, db: Session, user: dict, body):
        self.db, self.user = db, user
        self.actor = (user.get("email") or "").lower()
        project = (db.query(models.TaskProject).filter(models.TaskProject.id == (body.project_id or "")).first()
                   if body.project_id else None)
        if project is None:
            raise HTTPException(404, "Project not found")
        # The bar for creating a task in a project, company wall first.
        require_project_access(db, user, project, "editor")
        # project_role_for hands an external editor on any org-wide project,
        # which externals never see - they import only into one they can.
        if user.get("external") and project.id not in visible_project_ids(db, user):
            raise HTTPException(404, "Project not found")
        if getattr(project, "archived", False):
            raise HTTPException(422, "This project is archived. Unarchive it to import tasks into it.")
        self.project = project
        rows = body.rows or []
        if not rows:
            raise HTTPException(422, "The file has no rows to import.")
        if len(rows) > MAX_ROWS:
            raise HTTPException(422, f"A file can have at most {MAX_ROWS:,} rows. This one has {len(rows):,} - "
                                     "split it into smaller files.")
        self.scope = auth.company_scope(user, db)
        if body.add_missing_options and not is_manager(user):
            raise HTTPException(403, "Only a manager can add options to a custom field.")
        creator = (db.query(models.NexusEmployee.company)
                   .filter(func.lower(models.NexusEmployee.work_email) == self.actor).first())
        self.company_id = (creator.company if creator else "") or ""
        self.access_level = project.access_level or "org"
        self.people = _People(db, user, self.company_id)
        # Statuses this project shows: the built-ins plus custom ones on it.
        self.statuses: dict = {}
        for sid, label in _BUILTIN_STATUS_LABELS.items():
            self.statuses[_norm(sid)] = sid
            self.statuses[_norm(label)] = sid
        for s in db.query(models.TaskCustomStatus).all():
            if not config_admits(getattr(s, "company_id", "") or "", self.scope):
                continue
            pids = [p for p in (s.project_ids or []) if p]
            if pids and project.id not in pids:
                continue
            self.statuses.setdefault(_norm(s.label), s.id)
            self.statuses.setdefault(_norm(s.id), s.id)
        self.status_synonyms = {k: v for k, v in _STATUS_SYNONYMS.items() if k not in self.statuses}
        # Custom fields: every definition (coercion and the required check
        # read them all), and the ones a person can fill on this project.
        self.all_fields = db.query(models.TaskCustomField).all()
        self.defs = {f.id: f for f in self.all_fields}
        self.fields = {f.id: f for f in self.all_fields
                       if config_admits(getattr(f, "company_id", "") or "", self.scope)
                       and field_applies_to(f, project.id) and "task" in _parse_applies_to(f.applies_to)}
        self.add_options = bool(body.add_missing_options)
        # Sections made for the Custom grouping (customSections.js) - the
        # ones the project screen shows.
        self.sections = {}
        self.section_rows = sorted(
            (s for s in db.query(models.TaskSection).filter(models.TaskSection.project_id == project.id).all()
             if s.custom), key=lambda s: (s.position or 0, s.created_at or ""))
        for s in self.section_rows:
            self.sections.setdefault(_norm(s.name), s)
        self.default_section = self.default_section_name = ""
        if body.section_id:
            sec = next((s for s in self.section_rows if s.id == body.section_id), None)
            if sec is None:
                raise HTTPException(422, "That section is not in this project.")
            self.default_section, self.default_section_name = sec.id, sec.name
        self.create_sections = bool(body.create_sections)
        self.new_sections: dict = {}     # norm name -> display name, in first-seen order
        self.new_options: dict = {}      # field id -> {norm label: label}

    def may_add_option(self, f) -> bool:
        """A field's options are its definition: a manager's to change, and
        behind a company wall only a company's own field (a shared one
        reaches every company - Global Admins only), as Manage > Fields."""
        if not self.add_options or not is_manager(self.user):
            return False
        c = (getattr(f, "company_id", "") or "").strip()
        return self.scope is None or (bool(c) and c in self.scope)


# ── Parsing one row ──────────────────────────────────────────────────────────
class _Row:
    __slots__ = ("n", "index", "title", "description", "assignees", "dropped", "due", "start", "priority",
                 "status", "tags", "section_id", "section_new", "section_name", "parent_raw", "parent",
                 "values", "new_opts", "errors", "warnings", "depth", "task", "task_id")

    def __init__(self, n: int, index: int):
        self.n, self.index = n, index
        self.title = self.description = self.due = self.start = ""
        self.priority, self.status = "medium", "not_started"
        self.assignees, self.dropped, self.tags = [], [], []
        self.section_id = self.section_new = self.section_name = ""
        self.parent_raw, self.parent = "", None
        self.values: dict = {}
        self.new_opts: set = set()   # (field id, option key) this row needs added
        self.errors, self.warnings = [], []
        self.depth = 0
        self.task = None
        self.task_id = ""   # kept apart from `task`: reading the row after the commit re-SELECTs it


def _parse_row(ctx: _Context, raw: dict, index: int) -> _Row:
    try:
        n = int(raw.get("row") or 0)
    except (TypeError, ValueError):
        n = 0
    r = _Row(n if n > 0 else index + 2, index)

    title = _cell(raw.get("title"))
    if not title:
        r.errors.append("Title is required.")
    elif len(title) > MAX_TITLE:
        r.errors.append(f"Title is longer than {MAX_TITLE} characters.")
    r.title = title[:MAX_TITLE]

    desc = _cell(raw.get("description"))
    if len(desc) > MAX_TEXT:
        r.warnings.append(f"Description was cut to {MAX_TEXT:,} characters.")
        desc = desc[:MAX_TEXT]
    r.description = _as_html(desc)

    for key, label, attr in (("due", "Due date", "due"), ("start", "Start date", "start")):
        iso, ok = parse_import_date(raw.get(key))
        if not ok:
            r.errors.append(f"{label} \"{_cell(raw.get(key))}\" is not a date - use MM/DD/YYYY.")
        setattr(r, attr, iso)
    if r.start and r.due and r.start > r.due:
        r.warnings.append("Start date is after the due date.")

    pr = _cell(raw.get("priority"))
    if pr:
        hit = _PRIORITY_SYNONYMS.get(_norm(pr))
        if hit:
            r.priority = hit
        else:
            r.warnings.append(f"Priority \"{pr}\" is not one of Low, Medium, High, Urgent - set to Medium.")

    st = _cell(raw.get("status"))
    if st:
        hit = ctx.statuses.get(_norm(st)) or ctx.status_synonyms.get(_norm(st))
        if hit:
            r.status = hit
        else:
            r.warnings.append(f"Status \"{st}\" is not a status in this project - set to Not Started.")

    seen = set()
    for who in _split(_cell(raw.get("assignees"))):
        email, why = ctx.people.resolve(who)
        if email:
            if email not in seen:
                seen.add(email)
                r.assignees.append(email)
        else:
            r.dropped.append({"email": who.lower() if "@" in who else who, "reason": why})
            r.warnings.append(f"Assignee \"{who}\" {why} - left off.")

    tags, tag_seen = [], set()
    for tag in _split(_cell(raw.get("tags"))):
        tag = tag[:100]
        if tag.lower() not in tag_seen:
            tag_seen.add(tag.lower())
            tags.append(tag)
    if len(tags) > MAX_TAGS:
        r.warnings.append(f"Only the first {MAX_TAGS} tags were kept.")
        tags = tags[:MAX_TAGS]
    r.tags = tags

    sec = _cell(raw.get("section"))
    if sec:
        hit = ctx.sections.get(_norm(sec))
        if hit is not None:
            r.section_id, r.section_name = hit.id, hit.name
        elif ctx.create_sections:
            r.section_new, r.section_name = _norm(sec), sec[:200]
            ctx.new_sections.setdefault(_norm(sec), sec[:200])
        else:
            r.warnings.append(f"Section \"{sec}\" is not in this project - "
                              + ("filed under the default section." if ctx.default_section else "left without a section."))
    if not r.section_id and not r.section_new and ctx.default_section:
        r.section_id, r.section_name = ctx.default_section, ctx.default_section_name

    r.parent_raw = _cell(raw.get("parent"))

    custom = raw.get("custom") if isinstance(raw.get("custom"), dict) else {}
    for fid, value in custom.items():
        f = ctx.fields.get(fid)
        if f is None:
            r.warnings.append("A column was mapped to a field this project does not have - ignored.")
            continue
        _parse_field(ctx, r, f, value)
    return r


def _parse_field(ctx: _Context, r: _Row, f, value) -> None:
    text = _cell(value)
    if not text:
        return
    name = f.name or "Field"
    if f.read_only:
        r.warnings.append(f"{name} is read-only - value ignored.")
        return
    kind = (f.type or "text").lower()
    if kind == "number":
        try:
            n = float(re.sub(r"[,$\s]", "", text))
        except ValueError:
            r.warnings.append(f"{name} \"{text}\" is not a number - left empty.")
            return
        r.values[f.id] = int(n) if n.is_integer() else n
    elif kind == "date":
        iso, ok = parse_import_date(value)
        if not ok:
            r.warnings.append(f"{name} \"{text}\" is not a date - left empty.")
            return
        r.values[f.id] = iso
    elif kind == "checkbox":
        low = text.strip().lower()
        if low in _TRUE:
            r.values[f.id] = True
        elif low in _FALSE:
            r.values[f.id] = False
        else:
            r.warnings.append(f"{name} \"{text}\" is not Yes or No - left empty.")
    elif kind in ("select", "multiselect"):
        options = {_norm(o["label"]): o["label"] for o in normalize_field_options(f.options or [])}
        picked = []
        for label in ([text] if kind == "select" else _split(text)):
            hit = options.get(_norm(label))
            if hit is None:
                pending = ctx.new_options.get(f.id, {})
                if _norm(label) in pending or ctx.may_add_option(f):
                    hit = pending.setdefault(_norm(label), label[:200])
                    ctx.new_options[f.id] = pending
                    r.new_opts.add((f.id, _norm(label)))
                else:
                    why = (" - only a Global Admin can add options to a field shared by every company"
                           if ctx.add_options else "")
                    r.warnings.append(f"{name} \"{label}\" is not an option{why} - left empty.")
                    continue
            if hit not in picked:
                picked.append(hit)
        if picked:
            r.values[f.id] = picked[0] if kind == "select" else picked
    elif kind == "people":
        emails = []
        for who in _split(text):
            email, why = ctx.people.resolve(who)
            if email:
                emails.append(email)
            else:
                r.warnings.append(f"{name}: \"{who}\" {why} - left off.")
        if emails:
            r.values[f.id] = sorted(set(emails))
    else:
        r.values[f.id] = text[:MAX_TEXT]


# ── Parents ──────────────────────────────────────────────────────────────────
_ROW_REF = re.compile(r"^(?:row\s*)?#?\s*(\d+)$", re.I)


def _resolve_parents(rows: list[_Row]) -> None:
    by_title: dict = {}
    for r in rows:
        if r.title:
            by_title.setdefault(_norm(r.title), []).append(r)
    by_n = {r.n: r for r in rows}
    for r in rows:
        if not r.parent_raw:
            continue
        cands = [x for x in by_title.get(_norm(r.parent_raw), []) if x is not r]
        if len(cands) > 1:
            r.errors.append(f"Parent \"{r.parent_raw}\" matches more than one row - use its row number.")
            continue
        if cands:
            r.parent = cands[0]
            continue
        hit = _ROW_REF.match(r.parent_raw)
        target = by_n.get(int(hit.group(1))) if hit else None
        if target is None:
            r.errors.append(f"Parent \"{r.parent_raw}\" is not a row in this file.")
        elif target is r:
            r.errors.append("A task cannot be its own parent.")
        else:
            r.parent = target
    # Loops (A under B under A) and depth.
    for r in rows:
        seen, cur, depth = {id(r)}, r.parent, 0
        while cur is not None:
            if id(cur) in seen:
                r.errors.append("Parent rows form a loop.")
                break
            seen.add(id(cur))
            depth += 1
            cur = cur.parent
        r.depth = depth


def _skip_orphans(rows: list[_Row]) -> None:
    """A row under a row that will not be created is not created either -
    after every other check, so a parent skipped for any reason counts."""
    changed = True
    while changed:
        changed = False
        for r in rows:
            if r.parent is not None and r.parent.errors and not any(e.startswith("Parent row") for e in r.errors):
                r.errors.append(f"Parent row {r.parent.n} is not being imported.")
                changed = True


def _check_required(ctx: _Context, rows: list[_Row]) -> None:
    """A project's required custom fields, judged as create_task judges
    them: top-level rows only, a company's own field binds only its tasks."""
    for r in rows:
        if r.parent is not None or r.errors:
            continue
        values = _assume_options(ctx, r.values)
        missing = missing_required_fields(ctx.db, ctx.project.id, values, task_company=ctx.company_id,
                                          fields=ctx.all_fields)
        if missing:
            names = ", ".join(f.name for f in missing)
            r.errors.append(f"{names} {'is' if len(missing) == 1 else 'are'} required in this project.")


def _assume_options(ctx: _Context, values: dict) -> dict:
    """The values as they will be stored, counting options this import adds
    as present (they are added before the tasks are made)."""
    out = coerce_custom_field_values(ctx.db, values, defs=ctx.defs)
    for fid, v in values.items():
        if fid not in out and fid in ctx.new_options and v not in ("", None, []):
            out[fid] = v
    return out


# ── The report ───────────────────────────────────────────────────────────────
def _row_report(r: _Row) -> dict:
    return {
        "row": r.n, "title": r.title, "parentRow": r.parent.n if r.parent is not None else None,
        "depth": r.depth, "status": r.status, "priority": r.priority,
        "dueOn": r.due, "startOn": r.start, "assignees": r.assignees, "tags": r.tags,
        "section": r.section_name, "newSection": bool(r.section_new),
        "errors": r.errors, "warnings": r.warnings,
    }


def _dropped(rows: list[_Row]) -> list:
    return [{**d, "row": r.n} for r in rows for d in r.dropped]


# ── Entry point ──────────────────────────────────────────────────────────────
def run_import(db: Session, user: dict, body, defer=None) -> dict:
    """Dry run (`body.dry_run`) or the real thing. `defer` is the request's
    BackgroundTasks.add_task, for the batched assignment emails."""
    ctx = _Context(db, user, body)
    rows = [_parse_row(ctx, raw if isinstance(raw, dict) else {}, i) for i, raw in enumerate(body.rows)]
    _resolve_parents(rows)
    _check_required(ctx, rows)
    _skip_orphans(rows)
    good = [r for r in rows if not r.errors]
    bad = [r for r in rows if r.errors]
    # Only what the rows being created use: a section or option named only
    # by a skipped row is not made.
    used_sections = {r.section_new for r in good if r.section_new}
    wanted = {key for r in good for key in r.new_opts}
    used_options = {fid: {k: v for k, v in opts.items() if (fid, k) in wanted}
                    for fid, opts in ctx.new_options.items()}
    used_options = {fid: opts for fid, opts in used_options.items() if opts}
    new_sections = [name for key, name in ctx.new_sections.items() if key in used_sections]
    new_options = [{"fieldId": fid, "field": ctx.fields[fid].name, "label": label}
                   for fid, opts in used_options.items() for label in opts.values()]
    report = {
        "dryRun": bool(body.dry_run), "total": len(rows), "valid": len(good), "skipped": len(bad),
        "rows": [_row_report(r) for r in rows],
        "errors": [{"row": r.n, "title": r.title, "errors": r.errors} for r in bad],
        "droppedPeople": _dropped(good),
        "newSections": new_sections, "newOptions": new_options,
    }
    if body.dry_run:
        return report
    if not good:
        raise HTTPException(422, "Every row has an error, so nothing was imported. Fix the file and try again.")
    try:
        made = _create(ctx, body, good, used_sections, used_options)
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        log.exception("task import failed")
        raise HTTPException(500, "The import failed and nothing was created. Try again, or split the file.")
    if defer is not None and made["assigned"]:
        defer(_queue_assignment_mail, ctx.actor, made["assigned"])
    # Comments the 'created' rules asked for - silently (see the docstring).
    for auto in made["autos"]:
        task_automation.run_after_commit(db, auto, defer, notify=False)
    fire_task_event("", "bulk")
    return {
        "dryRun": False, "created": len(good), "skipped": len(bad), "errors": report["errors"],
        "droppedPeople": report["droppedPeople"], "newSections": new_sections, "newOptions": new_options,
        "taskIds": [r.task_id for r in good], "topLevelIds": [r.task_id for r in good if r.parent is None],
        "projectId": ctx.project.id,
    }


def _create(ctx: _Context, body, good: list[_Row], used_sections: set, used_options: dict) -> dict:
    """Everything in one transaction; the caller rolls back on any raise."""
    from routers.tasks import (TaskCreate, _new_task_row, _follow_as_actor, validate_task_payload,
                               _apply_completion, _resolve_completed)
    import code_sequence
    db, user, actor, now = ctx.db, ctx.user, ctx.actor, now_iso()
    project = ctx.project

    # Sections first, after the project's last one.
    section_ids = {}
    pos = max([s.position or 0 for s in ctx.section_rows] or [0])
    for key, name in ctx.new_sections.items():
        if key not in used_sections:
            continue
        pos += 1
        sec = models.TaskSection(id=gen_id(), project_id=project.id, name=name, position=pos,
                                 created_at=now, custom=True)
        db.add(sec)
        section_ids[key] = sec.id

    # Options next, so coercion below reads them as real options. A new list:
    # the JSON column only notices a reassignment.
    for fid, opts in used_options.items():
        if not opts:
            continue
        f = ctx.defs[fid]
        f.options = normalize_field_options(list(f.options or []) + [{"label": lbl} for lbl in opts.values()])

    rules = task_automation._enabled_rules(db)
    order = sorted(good, key=lambda r: (r.depth, r.index))
    codes = code_sequence.next_task_codes(db, len(order))
    base = time.time()
    assigned: dict = {}
    autos = []
    for i, r in enumerate(order):
        tid = gen_id()
        parent = r.parent.task if r.parent is not None else None
        data = {
            "title": r.title, "description": r.description, "type": "task",
            "status": r.status, "priority": r.priority,
            # File order is the manual order, after everything already there.
            "position": base + r.index * 0.001,
            "project_id": project.id,
            "section_id": "" if parent is not None else (section_ids.get(r.section_new) or r.section_id or ""),
            "parent_task_id": parent.id if parent is not None else "",
            "tags": list(r.tags), "start_on": r.start, "due_on": r.due,
            "assignee_emails": list(r.assignees), "follower_emails": [],
            "custom_field_values": dict(r.values),
        }
        # Same normalization a typed create gets (status is matched above,
        # against this project's own statuses).
        checked = {k: v for k, v in data.items() if k not in ("status", "parent_task_id")}
        try:
            validate_task_payload(db, checked)
        except HTTPException as e:
            raise HTTPException(422, f"Row {r.n}: {e.detail}")
        data.update({k: checked[k] for k in ("tags", "assignee_emails", "follower_emails")})
        t = _new_task_row(db, TaskCreate(**data), tid=tid, code=codes[i], company_id=ctx.company_id,
                          access_level=ctx.access_level, user=user, now=now, field_defs=ctx.defs)
        set_task_assignees(t, data["assignee_emails"])
        _follow_as_actor(t, actor)
        task_due.init_due(t, actor)
        db.add(t)
        if parent is not None:
            parent.subtask_ids = list(parent.subtask_ids or []) + [tid]
            parent.modified_at = now
        t.activity_ids = [log_activity(db, type="created", actor_email=actor, entity_id=tid,
                                       entity_code=t.code, entity_title=t.title,
                                       detail="created this task")]
        note_dropped_people(db, t, r.dropped, actor)
        # The 'created' rules, per task, exactly as create_task runs them -
        # against one load of the rules.
        before = task_automation.snapshot(t)
        auto = task_automation.run_for_change(db, t, event="created", before=before, rules=rules)
        if "status" in auto.changed:
            _apply_completion(t, _resolve_completed({"status": auto.changed["status"]}, bool(t.completed)),
                              bool(t.completed))
        if "due_on" in auto.changed:
            task_due.record_due_change(db, t, before["due_on"], t.due_on or "",
                                       actor=task_automation.AUTOMATION_ACTOR, source="automation")
        if auto.after_commit:
            autos.append(auto)
        r.task, r.task_id = t, tid
        if body.notify_assignees:
            for who in task_assignees(t):
                if who != actor:
                    assigned.setdefault(who, []).append(t)

    # One bell per person for the whole import, as a bulk assignment.
    for who, tasks in assigned.items():
        if len(tasks) == 1:
            task_notify(db, kind="task_assigned", for_email=who, title="You Were Assigned a Task",
                        body=tasks[0].title or "", task_id=tasks[0].id,
                        nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
        else:
            task_notify(db, kind="task_assigned", for_email=who,
                        title=f"You Were Assigned {len(tasks)} Tasks",
                        body=f"In {project.name}: " + ", ".join(x.title or "Untitled task" for x in tasks[:5])
                             + (f" and {len(tasks) - 5} more" if len(tasks) > 5 else ""),
                        nexus_action={"view": "tasks", "sub": "mine", "label": "View tasks"})

    name = (body.file_name or "").strip()[:200] or "a file"
    aid = log_activity(db, type="imported", entity_kind="project", actor_email=actor, entity_id=project.id,
                       entity_code=project.name, entity_title=project.name,
                       detail=f"imported {len(order)} task{'' if len(order) == 1 else 's'} from {name}")
    project.activity_ids = list(project.activity_ids or []) + [aid]
    project.modified_at = now
    # Ids taken before the commit expires the rows (each read after it would
    # re-SELECT its row).
    assigned_ids = {who: [t.id for t in tasks] for who, tasks in assigned.items()}
    db.commit()
    return {"assigned": assigned_ids, "autos": autos}


def _queue_assignment_mail(actor: str, assigned: dict) -> None:
    """After the response: one batched email per newly assigned person for the
    whole import (task_notify.queue_bulk_assignments), on its own session -
    the request's is closed by then."""
    import task_notify
    db = SessionLocal()
    try:
        ids = sorted({i for v in assigned.values() for i in v})
        tasks = {t.id: t for t in db.query(models.Task).filter(models.Task.id.in_(ids)).all()} if ids else {}
        task_notify.queue_bulk_assignments(db, actor, {who: [tasks[i] for i in v if i in tasks]
                                                       for who, v in assigned.items()})
    except Exception:
        log.exception("queueing import assignment mail failed")
    finally:
        db.close()
