"""Board card previews - Planner's "Show On Card" (Neil, Oct 22 2026).

A board card can show a little of the task under its title: a cover image,
the first few open checklist lines, or the start of the description. What it
shows is the task's `card_preview` setting (models.Task.card_preview):

    ""            Automatic - the task's first image file, else its open
                  checklist lines, else nothing
    "checklist"   the open checklist lines
    "description" the description, as plain text
    "none"        nothing
    "image:<id>"  that image file (one of THIS task's attachments)

The task list (GET /tasks, /tasks/delta, a PATCH's answer) carries a small
`cardPreview` per task, built here in bulk for every listed task at once:
a fixed handful of queries whatever the number of tasks (the image files,
then the picked covers' URLs; the projects and teams when a caller's right
to read a checklist needs them; the checklist lines) - never a query per
task. Tasks that cannot show anything cost no query at all.

A cover is the CURRENT version of a file (a newer version takes its place),
only a file stored in Nexus's own storage (never an Egnyte row or a web
link - kind "egnyte" / "link", whatever its address looks like),
and only ever a file of the task it is shown on: the files are read by the
listed tasks' ids, and a picked image is looked up among that task's own.
"""
from __future__ import annotations

import os
import re
from html import unescape
from html.parser import HTMLParser

from fastapi import HTTPException
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

import models

MODES = ("", "checklist", "description", "none")
IMAGE_PREFIX = "image:"
MAX_ITEMS = 5          # checklist lines on a card
MAX_TEXT = 200         # description characters on a card
_CHUNK = 500           # ids per IN (...) - SQLite's variable limit, and a sane query
_IMAGE_EXT = re.compile(r"\.(png|jpe?g|gif|webp|avif|bmp)$", re.I)
_SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
# Without a configured Supabase (local dev, tests) any storage-shaped URL
# counts; a deployed API accepts only its own project's storage.
_STORAGE_PREFIX = f"{_SUPABASE_URL}/storage/v1/object/public/" if _SUPABASE_URL else ""
_STORAGE_SHAPE = re.compile(r"^https?://[^/]+/storage/v1/object/public/[^?#]+", re.I)
# Attachment rows that are LINKS, not files: an Egnyte item (POST
# /{id}/egnyte-links) and a web page (POST /{id}/links). Never a cover, by
# their kind - not by whether the address happens to look like storage.
LINK_KINDS = ("egnyte", "link")


# ── What counts as a cover ──────────────────────────────────────────────────
def stored_file(url: str) -> bool:
    """A file kept in Nexus's own storage - never a data: URL, an Egnyte link
    or anything outside."""
    u = (url or "").strip()
    if not u:
        return False
    if _STORAGE_PREFIX:
        return u.startswith(_STORAGE_PREFIX)
    return bool(_STORAGE_SHAPE.match(u))


def image_file(kind, name) -> bool:
    """An image FILE by its kind and name: never a link row (LINK_KINDS); an
    "image" kind or an image file name. The one test is_cover_file and the
    bulk build (_covers) both use - storage is checked beside it."""
    k = kind or ""
    if k in LINK_KINDS:
        return False
    return k == "image" or bool(_IMAGE_EXT.search((name or "").split("?", 1)[0]))


def is_cover_file(a) -> bool:
    """An image file in our storage. `a` is a TaskAttachment row or a row of
    its columns (kind, name, url)."""
    return image_file(a.kind, a.name) and stored_file(a.url)


def copyable(mode) -> str:
    """The setting a COPY of a task takes (duplicate, template, the next
    occurrence of a repeating task): the same choice, except a picked image -
    the copy does not have that file, so it goes back to Automatic."""
    m = str(mode or "").strip()
    return m if m in MODES else ""


def clean_mode(db: Session, t: models.Task, value) -> str:
    """The value to store, or 422. A picked image must be an image file of
    THIS task, stored in Nexus."""
    v = str(value or "").strip()
    if v in MODES:
        return v
    if v.startswith(IMAGE_PREFIX) and len(v) <= 120:
        aid = v[len(IMAGE_PREFIX):]
        a = (db.query(models.TaskAttachment)
             .filter(models.TaskAttachment.id == aid, models.TaskAttachment.task_id == t.id).first()
             if aid else None)
        if a is not None and is_cover_file(a):
            return IMAGE_PREFIX + a.id
        raise HTTPException(422, "Show On Card: pick an image file attached to this task.")
    raise HTTPException(422, "Show On Card must be Automatic, Checklist, Description, None or an image.")


# ── Description as plain text ───────────────────────────────────────────────
class _Text(HTMLParser):
    _SKIP = {"script", "style", "template", "iframe", "object", "embed", "noscript"}
    _BREAK = {"p", "br", "div", "li", "tr", "td", "th", "h1", "h2", "h3", "h4", "blockquote", "pre", "hr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self.skip += 1
        elif tag in self._BREAK:
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in self._SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag in self._BREAK:
            self.parts.append(" ")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def plain_text(body: str, limit: int = MAX_TEXT) -> str:
    """The text of a description (HTML or plain), whitespace collapsed, cut to
    `limit` characters at a word where it can be. Never markup."""
    s = str(body or "")
    if not s.strip():
        return ""
    if re.search(r"<[a-z/!]", s, re.I):
        p = _Text()
        try:
            p.feed(s)
            p.close()
            s = "".join(p.parts)
        except Exception:   # malformed markup: drop anything tag-shaped
            s = unescape(re.sub(r"<[^>]*>", " ", s))
    s = re.sub(r"\s+", " ", s).strip()
    if len(s) <= limit:
        return s
    cut = s[:limit]
    space = cut.rfind(" ")
    if space > limit * 0.6:
        cut = cut[:space]
    return cut.rstrip(" ,;:.-") + "…"


# ── The bulk build ──────────────────────────────────────────────────────────
def _chunks(ids: list) -> list:
    return [ids[i:i + _CHUNK] for i in range(0, len(ids), _CHUNK)]


def _open_lines(t: models.Task) -> int:
    return max(0, int(t.checklist_total or 0) - int(t.checklist_done or 0))


def _stored_clause(A):
    """SQL for "a file in Nexus's own storage, not an Egnyte or web link": the
    storage-URL rule of stored_file, evaluated in the database so no URL -
    a legacy inline data: file can be megabytes - is read to decide."""
    from sqlalchemy import and_
    if _STORAGE_PREFIX:
        in_store = A.url.startswith(_STORAGE_PREFIX, autoescape=True)
    else:
        in_store = and_(A.url.like("http%://%/storage/v1/object/public/%"), ~A.url.like("data:%"))
    return and_(func.coalesce(A.kind, "").notin_(LINK_KINDS), in_store)


def _covers(db: Session, tasks: list) -> dict:
    """{task id: (attachment id, name, url)} - the cover of each of `tasks`.

    Two queries (per _CHUNK tasks): the files' ids, names and versions, with
    "stored in Nexus" worked out in SQL - never their URLs - to pick the
    cover; then the URLs of the picked files alone. The current version of a
    file is decided over ALL its versions, so an unusable newest version is
    no cover rather than letting an older one stand in. A picked image wins
    when it is still there; else the first image file, by when the file was
    first added."""
    if not tasks:
        return {}
    from sqlalchemy import case
    A = models.TaskAttachment
    stored = case((_stored_clause(A), 1), else_=0).label("stored")
    rows = []
    for chunk in _chunks([t.id for t in tasks]):
        rows += (db.query(A.id, A.task_id, A.name, A.kind, A.version_group, A.version, A.added_at, stored)
                 .filter(A.task_id.in_(chunk)).all())
    by_task: dict[str, dict[str, list]] = {}
    for r in rows:
        by_task.setdefault(r.task_id, {}).setdefault(r.version_group or r.id, []).append(r)

    def key(r):   # = routers.tasks._version_key
        return (r.version or 1, r.added_at or "", r.id)

    def usable(r):
        return bool(r.stored) and image_file(r.kind, r.name)

    picked = {}
    for t in tasks:
        groups = by_task.get(t.id) or {}
        current = {}       # group -> (first added, first id, current version row)
        for g, rs in groups.items():
            rs.sort(key=key)
            current[g] = (rs[0].added_at or "", rs[0].id, rs[-1])
        mode = t.card_preview or ""
        pick = None
        if mode.startswith(IMAGE_PREFIX):
            want = mode[len(IMAGE_PREFIX):]
            for g, rs in groups.items():
                if any(r.id == want for r in rs):
                    pick = current[g][2]
                    break
            if pick is not None and not usable(pick):
                pick = None
        if pick is None:
            for _, _, cur in sorted(current.values(), key=lambda x: (x[0], x[1])):
                if usable(cur):
                    pick = cur
                    break
        if pick is not None:
            picked[t.id] = pick
    if not picked:
        return {}
    urls = {}
    for chunk in _chunks([r.id for r in picked.values()]):
        urls.update({i: u for i, u in db.query(A.id, A.url).filter(A.id.in_(chunk)).all()})
    return {tid: (r.id, r.name or "", urls[r.id]) for tid, r in picked.items() if urls.get(r.id)}


def _lines(db: Session, tasks: list) -> dict:
    """{task id: [its first MAX_ITEMS open checklist lines]} from ONE query
    (one per _CHUNK tasks), capped per task in the database."""
    if not tasks:
        return {}
    I = models.TaskChecklistItem
    rn = func.row_number().over(partition_by=I.task_id, order_by=(I.position, I.created_at, I.id)).label("rn")
    out: dict[str, list] = {}
    for chunk in _chunks([t.id for t in tasks]):
        sub = (db.query(I.id.label("id"), I.task_id.label("task_id"), I.title.label("title"),
                        I.assignee_email.label("assignee_email"), rn)
               .filter(I.task_id.in_(chunk), or_(I.done.is_(False), I.done.is_(None)))
               .subquery())
        for r in db.query(sub).filter(sub.c.rn <= MAX_ITEMS).order_by(sub.c.task_id, sub.c.rn).all():
            out.setdefault(r.task_id, []).append(r)
    return out


def _checklist_readers(db: Session, tasks: list, user: dict | None, listed: list = ()) -> set:
    """The ids of `tasks` whose checklist `user` may read - GET
    /tasks/{id}/checklist's rule (require_task_role "viewer"): a manager, an
    assignee, or a role on the task's project (its top-level ancestor's for a
    subtask). Seeing a task is not always that: an org-wide task in a project
    you are not on, or one you only follow. Worked out per PROJECT, with the
    projects and teams read once - never a query per task. `listed` is the
    whole list, where a subtask's parent is found without a query."""
    from routers.task_util import is_manager, project_role_for, task_assignees
    if not tasks:
        return set()
    if user is None or is_manager(user):
        return {t.id for t in tasks}
    email = (user.get("email") or "").lower()
    out, need = set(), []
    for t in tasks:
        if email and email in task_assignees(t):
            out.add(t.id)
        else:
            need.append(t)
    if not need:
        return out
    by_id = {t.id: t for t in (*listed, *tasks)}

    def root_project(t):
        seen = set()
        while not t.project_id and t.parent_task_id and t.parent_task_id not in seen:
            seen.add(t.parent_task_id)
            parent = by_id.get(t.parent_task_id) or db.query(models.Task).filter(
                models.Task.id == t.parent_task_id).first()
            if parent is None:
                break
            t = parent
        return t.project_id or ""

    pid_of = {t.id: root_project(t) for t in need}
    pids = sorted({p for p in pid_of.values() if p})
    projects = {}
    for chunk in _chunks(pids):
        projects.update({p.id: p for p in db.query(models.TaskProject).filter(models.TaskProject.id.in_(chunk)).all()})
    teams = db.query(models.TaskTeam).all() if any(
        (p.access_level or "org") != "org" for p in projects.values()) else []
    roles = {pid: project_role_for(db, email, projects.get(pid), teams=teams) for pid in pids}
    for t in need:
        pid = pid_of[t.id]
        # A task with no project anywhere: its sight is its access (the list
        # only holds tasks the caller may see), as require_task_role reads it.
        if not pid or roles.get(pid):
            out.add(t.id)
    return out


def card_previews(db: Session, tasks: list, user: dict | None = None) -> dict:
    """{task id: cardPreview dict} for the listed tasks - only the ones with
    something to show. See the module docstring for the shape. `user` is who
    the list is for: checklist lines show only where they may read the
    checklist; elsewhere the card falls back to the description, or nothing."""
    out: dict[str, dict] = {}
    want_cover, want_lines = [], []
    for t in tasks:
        mode = t.card_preview or ""
        if mode == "none":
            continue
        if mode == "description":
            text = plain_text(t.description)
            if text:
                out[t.id] = {"kind": "description", "text": text}
            continue
        if mode == "checklist":
            if _open_lines(t):
                want_lines.append(t)
            continue
        # Automatic or a picked image: the files first. A picked image that
        # has since gone counts as Automatic.
        if t.attachment_ids:
            want_cover.append(t)
        elif _open_lines(t):
            want_lines.append(t)
    covers = _covers(db, want_cover)
    for t in want_cover:
        c = covers.get(t.id)
        if c is not None:
            out[t.id] = {"kind": "image", "id": c[0], "name": c[1], "url": c[2]}
        elif _open_lines(t):
            want_lines.append(t)   # no image after all - Automatic falls back to the checklist
    readers = _checklist_readers(db, want_lines, user, tasks)
    lines = _lines(db, [t for t in want_lines if t.id in readers])
    for t in want_lines:
        rs = lines.get(t.id) or []
        if t.id not in readers or not rs:
            text = plain_text(t.description) if t.id not in readers else ""
            if text:
                out[t.id] = {"kind": "description", "text": text}
            continue
        out[t.id] = {
            "kind": "checklist",
            "items": [{"id": r.id, "title": r.title or "", "assigneeId": (r.assignee_email or None)} for r in rs],
            "more": max(0, _open_lines(t) - len(rs)),
        }
    return out
