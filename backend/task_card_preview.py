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
one query for the image files and one for the checklist lines, whatever the
number of tasks - never a query per task. Tasks that cannot show anything
(no files, no open lines, set to None) cost no query at all.

A cover is the CURRENT version of a file (a newer version takes its place),
only a file stored in Nexus's own storage (never an Egnyte or outside link),
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


def is_cover_file(a) -> bool:
    """An image file in our storage. `a` is a TaskAttachment row or a row of
    its columns (kind, name, url)."""
    if (a.kind or "") == "egnyte":
        return False
    name = (a.name or "").split("?", 1)[0]
    if (a.kind or "") != "image" and not _IMAGE_EXT.search(name):
        return False
    return stored_file(a.url)


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


def _covers(db: Session, tasks: list) -> dict:
    """{task id: the cover row} for `tasks`, from ONE query over their files
    (one per _CHUNK tasks). A picked image wins when it is still there; else
    the first image file, by when the file was first added."""
    if not tasks:
        return {}
    A = models.TaskAttachment
    rows = []
    for chunk in _chunks([t.id for t in tasks]):
        rows += (db.query(A.id, A.task_id, A.name, A.kind, A.url, A.version_group, A.version, A.added_at)
                 .filter(A.task_id.in_(chunk)).all())
    by_task: dict[str, dict[str, list]] = {}
    for r in rows:
        by_task.setdefault(r.task_id, {}).setdefault(r.version_group or r.id, []).append(r)

    def key(r):   # = routers.tasks._version_key
        return (r.version or 1, r.added_at or "", r.id)

    out = {}
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
            if pick is not None and not is_cover_file(pick):
                pick = None
        if pick is None:
            for _, _, cur in sorted(current.values(), key=lambda x: (x[0], x[1])):
                if is_cover_file(cur):
                    pick = cur
                    break
        if pick is not None:
            out[t.id] = pick
    return out


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


def card_previews(db: Session, tasks: list) -> dict:
    """{task id: cardPreview dict} for the listed tasks - only the ones with
    something to show. See the module docstring for the shape."""
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
        # Automatic or a picked image: the files first.
        # A picked image that has since gone counts as Automatic.
        if t.attachment_ids:
            want_cover.append(t)
        elif _open_lines(t):
            want_lines.append(t)
    covers = _covers(db, want_cover)
    for t in want_cover:
        a = covers.get(t.id)
        if a is not None:
            out[t.id] = {"kind": "image", "id": a.id, "name": a.name or "", "url": a.url}
        elif _open_lines(t):
            want_lines.append(t)   # no image after all - Automatic falls back to the checklist
    lines = _lines(db, want_lines)
    for t in want_lines:
        rs = lines.get(t.id) or []
        if not rs:
            continue
        out[t.id] = {
            "kind": "checklist",
            "items": [{"id": r.id, "title": r.title or "", "assigneeId": (r.assignee_email or None)} for r in rs],
            "more": max(0, _open_lines(t) - len(rs)),
        }
    return out
