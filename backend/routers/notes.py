"""Notes - the scratchpad that follows you around Nexus (Neil, Oct 29 2026).

Dashboard > Notes is the full page, Quick Note (top bar, Ctrl/Cmd+Shift+N)
the slide-over and the dashboard's Notes widget the glance; all three read
and write the same rows (models.NexusNote).

  Who reads   - the owner, and the Nexus People the owner shared the note
                with (shared_with: [{email, can: read|edit}]). Anyone else
                gets 404, never 403, so a note's existence does not leak. A
                trashed note is the owner's alone.
  Who writes  - the owner, everything; an `edit` share the title and body.
                Pin, color, tags, the day, sharing and trash are the owner's.
  Saving      - every save carries the rev it was read with; a save from an
                older rev is refused with 409 and the server copy in
                detail.note, so the screen can offer Keep Mine / Use Theirs
                instead of losing either side.
  Versions    - before a save, when the newest copy is older than ten
                minutes (or there is none), the note as it stood is kept in
                nexus_note_versions; the newest 25 per note stay.
  Daily       - kind 'daily' is one scratchpad per owner per day. Quick Note
                and the widget's capture line append to it
                (/notes/daily/append); POST /notes with kind 'daily' for a
                day that already has one returns that one.
  Sharing     - only with the curated Nexus People list (the same list and
                company wall as /myhr/directory), one bell to the person.
                Mentions inside a note send nothing - a note is private.
  Delete      - only from the Trash, only the owner; the versions go with it.

Working together (Neil, Oct 30 2026):
  Seen        - `seen` keeps the rev each person last opened and the rev and
                author of the last change to the words; the list's Updated
                dot is a change by someone else after you last looked. No
                bells for edits.
  Versions    - also kept when a different person starts editing (their
                predecessor's words, under the predecessor's name), so the
                history says who changed what; the newest 50 stay.
  Presence    - POST /presence every few seconds while a note is open: one
                row per person (nexus_note_presence, in the database so
                every worker agrees), counted for 45 seconds. Its answer
                carries the rev, so an open note re-reads itself when
                someone else saved.
  Co-typing   - editors (owner and Can Edit) type together live: Yjs updates
                over a Supabase Realtime broadcast channel, ENCRYPTED in the
                browser with the note's AES-GCM key from GET /collab (never
                to read-only sharers, who follow along by re-reading; rotated
                when an editor is removed or made read-only). The channel
                name is derived from the key, so it cannot be found without
                it. The Yjs state is kept here (ydoc, base64) with an epoch;
                a note without one is seeded by exactly one browser
                (/collab/seed, first one wins). Anything that changes the
                words without Yjs (Quick Note's append, a version restore, a
                save from a screen not co-typing) clears the state and the
                epoch, so the next opener rebuilds from the HTML and a live
                session reloads instead of writing old words back.

The body is HTML from the Notes editor, sanitized here with the rich-text
allowlist the saved replies use (ticket_saved_replies._RichSanitizer) plus
what the editor's checklists, mentions and alignment need. AI is off for
Notes as for the rest of Nexus - nothing here calls a model.
"""
import base64
import hashlib
import json
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from html import escape, unescape
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
from auth import get_current_user
from database import get_db
from routers.ticket_saved_replies import _RichSanitizer, _SAFE_HREF, _own_image
from task_inbound_parse import plain_to_html

router = APIRouter(prefix="/notes", tags=["Notes"])

TITLE_MAX = 200
BODY_MAX = 300_000
TAG_MAX, TAGS_MAX = 40, 20
SHARES_MAX = 50
VERSION_GAP = timedelta(minutes=10)
VERSIONS_KEPT = 50
AUTHOR_GAP = timedelta(minutes=2)     # a new author within this of their predecessor's last copy adds none
PRESENCE_TTL = timedelta(seconds=45)
YDOC_MAX = 3_000_000                  # base64; bigger and the state is rebuilt from the body instead
LIST_MAX = 500
COLORS = ("", "green", "blue", "amber", "red", "purple", "slate")
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_MONTH = re.compile(r"^\d{4}-\d{2}$")
_EMAIL = re.compile(r"^[^@\s<>\"]+@[^@\s<>\"]+$")


# ── body sanitizer ─────────────────────────────────────────────────────────
# The saved-reply allowlist, plus: checklists (ul/li data-type, data-checked),
# @mentions (span data-type="mention" data-id data-label), text alignment
# (style text-align only), table spans. The checklist's own <label><input>
# is presentation the editor rebuilds, so it is dropped. Voice notes and
# videos (Oct 29 2026, notes/noteMedia.jsx) are <audio>/<video> players whose
# src is our own storage - rebuilt here with fixed attributes, children and
# anything else dropped; one pointing anywhere else is removed.
_NOTE_ATTRS = {
    "a": ("href", "title"),
    "img": ("src", "alt", "title"),
    "ul": ("data-type",),
    "li": ("data-type", "data-checked"),
    "span": ("data-type", "data-id", "data-label"),
    "p": ("style",), "h1": ("style",), "h2": ("style",), "h3": ("style",), "h4": ("style",),
    "td": ("colspan", "rowspan"), "th": ("colspan", "rowspan"),
}
_ALIGN = re.compile(r"^text-align:\s*(left|center|right|justify);?$", re.I)
_DATA_TYPES = {"taskList", "taskItem", "mention"}


_MEDIA = {"audio": ' controls preload="metadata"', "video": ' controls playsinline preload="metadata"'}


class _NoteSanitizer(_RichSanitizer):
    def __init__(self):
        super().__init__()
        self._in_media = 0

    def _attrs(self, tag, attrs):
        allowed = _NOTE_ATTRS.get(tag, ())
        kept = []
        for k, v in attrs:
            k, v = (k or "").lower(), (v or "").strip()
            if k not in allowed:
                continue
            if k == "href" and not _SAFE_HREF.match(v):
                continue
            if k == "src" and not _own_image(v):
                continue
            if k == "style":
                if not _ALIGN.match(v):
                    continue
            elif k == "data-type" and v not in _DATA_TYPES:
                continue
            elif k == "data-checked" and v not in ("true", "false"):
                continue
            elif k in ("colspan", "rowspan") and not v.isdigit():
                continue
            elif k == "data-id" and not _EMAIL.match(v):
                continue
            kept.append(f' {k}="{escape(v[:200], quote=True)}"')
        return "".join(kept)

    def handle_starttag(self, tag, attrs):
        if tag in ("label", "input"):
            return
        if tag in _MEDIA:
            if self.drop_depth:
                return
            src = next(((v or "").strip() for k, v in attrs if (k or "").lower() == "src"), "")
            if src and _own_image(src):
                self.out.append(f'<{tag} src="{escape(src[:1000], quote=True)}"{_MEDIA[tag]}></{tag}>')
            self._in_media += 1
            return
        if self._in_media:
            if tag in ("source", "track"):
                return      # a player's own children
            self._in_media = 0   # an unclosed player never swallows the rest of the note
        super().handle_starttag(tag, attrs)

    def handle_startendtag(self, tag, attrs):
        if tag in _MEDIA:
            self.handle_starttag(tag, attrs)
            self.handle_endtag(tag)
            return
        super().handle_startendtag(tag, attrs)

    def handle_endtag(self, tag):
        if tag in _MEDIA:
            self._in_media = max(0, self._in_media - 1)
            return
        if self._in_media:
            return
        super().handle_endtag(tag)

    def handle_data(self, data):
        if not self._in_media:      # a player's fallback text
            super().handle_data(data)


def sanitize_note(body: str) -> str:
    body = body or ""
    if not body.strip():
        return ""
    if not re.search(r"<[a-z/!][^>]*>", body, re.I):
        return plain_to_html(body)
    p = _NoteSanitizer()
    p.feed(body)
    p.close()
    return p.result().strip()


def plain_text(html: str) -> str:
    """The words of a sanitized body, for search and the list preview."""
    s = re.sub(r"<(br|/p|/li|/h[1-4]|/blockquote|/pre|/tr|hr)[^>]*>", "\n", html or "", flags=re.I)
    s = unescape(re.sub(r"<[^>]+>", "", s))
    return re.sub(r"[ \t]+", " ", re.sub(r"\n\s*\n+", "\n", s)).strip()


# ── helpers ────────────────────────────────────────────────────────────────
def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _me(user: dict) -> str:
    return (user.get("email") or "").strip().lower()


def _loads(raw, default):
    try:
        v = json.loads(raw or "")
        return v if isinstance(v, type(default)) else default
    except (TypeError, ValueError):
        return default


def _shares(n: models.NexusNote) -> list:
    out = []
    for s in _loads(n.shared_with, []):
        if isinstance(s, dict) and s.get("email"):
            out.append({"email": str(s["email"]).lower(), "can": "edit" if s.get("can") == "edit" else "read"})
    return out


def _access(n: models.NexusNote, me: str) -> str:
    """'owner', 'edit', 'read' or '' (no access)."""
    if (n.owner_email or "").lower() == me:
        return "owner"
    if n.trashed_at:
        return ""
    for s in _shares(n):
        if s["email"] == me:
            return s["can"]
    return ""


def _seen(n: models.NexusNote) -> dict:
    s = _loads(n.seen, {})
    by = s.get("by") if isinstance(s.get("by"), dict) else {}
    content = s.get("content") if isinstance(s.get("content"), dict) else {}
    return {"by": by, "content": content}


def _mark_seen(n: models.NexusNote, me: str) -> bool:
    """Record that `me` has the note as it stands now; True when that changed anything."""
    s = _seen(n)
    if s["by"].get(me) == (n.rev or 1):
        return False
    s["by"][me] = n.rev or 1
    n.seen = json.dumps(s)
    return True


def _content_changed(n: models.NexusNote, me: str) -> None:
    """The words changed (call after _touch): who and at which rev, for the Updated dot."""
    s = _seen(n)
    s["content"] = {"rev": n.rev or 1, "by": me}
    s["by"][me] = n.rev or 1
    n.seen = json.dumps(s)


def _unseen(n: models.NexusNote, me: str) -> bool:
    s = _seen(n)
    c = s["content"]
    return bool(c.get("by")) and c.get("by") != me and int(c.get("rev") or 0) > int(s["by"].get(me) or 0)


def _drop_collab_state(n: models.NexusNote) -> None:
    """The words changed outside co-typing: the next opener rebuilds from the body."""
    n.ydoc = ""
    n.yepoch = ""


def _get_or_404(db: Session, note_id: str, me: str, lock: bool = False) -> tuple:
    q = db.query(models.NexusNote).filter(models.NexusNote.id == note_id)
    if lock:
        q = q.with_for_update()
    n = q.first()
    can = _access(n, me) if n else ""
    if not can:
        raise HTTPException(404, "Note not found")
    return n, can


def _summary(n: models.NexusNote, me: str) -> dict:
    can = _access(n, me)
    text = n.text or ""
    return {
        "id": n.id, "kind": n.kind or "note", "title": n.title or "", "preview": text[:220],
        "day": n.day or "", "tags": _loads(n.tags, []), "color": n.color or "",
        "pinned": bool(n.pinned) if can == "owner" else False,
        "owner": n.owner_email, "mine": can == "owner", "can": can,
        "shared": bool(_shares(n)), "trashedAt": n.trashed_at or "",
        "rev": n.rev or 1, "words": len(text.split()), "updatedAt": n.updated_at or "",
        "updatedBy": n.updated_by or "", "createdAt": n.created_at or "",
        "unseen": _unseen(n, me) if not n.trashed_at else False,
        "editedBy": _seen(n)["content"].get("by") or n.updated_by or "",
    }


def _full(n: models.NexusNote, me: str) -> dict:
    out = _summary(n, me)
    out["body"] = n.body or ""
    out["sharedWith"] = _shares(n) if out["mine"] else [s for s in _shares(n) if s["email"] == me]
    return out


def _clean_tags(tags) -> list:
    seen, out = set(), []
    for t in tags or []:
        t = re.sub(r"\s+", " ", str(t or "")).strip().lstrip("#")[:TAG_MAX]
        if t and t.lower() not in seen:
            seen.add(t.lower())
            out.append(t)
    return out[:TAGS_MAX]


def _check_day(day: str) -> str:
    day = (day or "").strip()
    if day and not _DAY.match(day):
        raise HTTPException(400, "Day must be YYYY-MM-DD")
    return day


def _set_body(n: models.NexusNote, body: str) -> None:
    if len(body or "") > BODY_MAX:
        raise HTTPException(413, "This note is too long to save - split it into two notes.")
    n.body = sanitize_note(body)
    n.text = plain_text(n.body)


def _snapshot(db: Session, n: models.NexusNote, me: str, force: bool = False) -> None:
    """Keep the note as it stands now, when the newest copy is old enough -
    or when `me` is not the person who wrote it last (the history then says
    whose words those were), unless that person's copy is only minutes old."""
    if not (n.body or n.title):
        return
    last = (db.query(models.NexusNoteVersion).filter(models.NexusNoteVersion.note_id == n.id)
            .order_by(models.NexusNoteVersion.created_at.desc()).first())
    if last and not force:
        try:
            age = datetime.now(timezone.utc) - datetime.fromisoformat(last.created_at)
        except ValueError:
            age = VERSION_GAP
        before = (n.updated_by or n.owner_email or "").lower()
        new_author = before != me and not (last.saved_by == before and age < AUTHOR_GAP)
        if age < VERSION_GAP and not new_author:
            return
    if last and last.body == (n.body or "") and last.title == (n.title or ""):
        return
    db.add(models.NexusNoteVersion(id="nv_" + uuid.uuid4().hex, note_id=n.id, title=n.title or "",
                                   body=n.body or "", rev=n.rev or 1, saved_by=n.updated_by or n.owner_email,
                                   created_at=_now()))
    db.flush()
    old = (db.query(models.NexusNoteVersion).filter(models.NexusNoteVersion.note_id == n.id)
           .order_by(models.NexusNoteVersion.created_at.desc()).offset(VERSIONS_KEPT).all())
    for v in old:
        db.delete(v)


def _touch(n: models.NexusNote, me: str) -> None:
    n.rev = (n.rev or 1) + 1
    n.updated_by = me
    n.updated_at = _now()


def _new_note(me: str, **kw) -> models.NexusNote:
    now = _now()
    return models.NexusNote(id="note_" + uuid.uuid4().hex, owner_email=me, rev=1, updated_by=me,
                            created_at=now, updated_at=now, tags="[]", shared_with="[]", **kw)


def _daily(db: Session, me: str, day: str) -> Optional[models.NexusNote]:
    return (db.query(models.NexusNote)
            .filter(models.NexusNote.owner_email == me, models.NexusNote.kind == "daily",
                    models.NexusNote.day == day, models.NexusNote.trashed_at == "")
            .order_by(models.NexusNote.created_at).first())


def _directory_person(db: Session, user: dict, email: str) -> Optional[dict]:
    """The person in the curated Nexus People list the caller may pick from."""
    from routers.myhr import people_directory
    for p in people_directory(False, user, db):
        if (p.get("email") or "").lower() == email:
            return p
    return None


# ── list ───────────────────────────────────────────────────────────────────
@router.get("")
def list_notes(view: str = "all", q: str = "", tag: str = "", month: str = "", day: str = "",
               today: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The caller's notes and the ones shared with them, newest first.
    view: all | pinned | today | shared | trash. month (YYYY-MM) or day
    narrows by the note's day; q searches title and words; tag one tag.
    `today` is the caller's own local date, for the Today count."""
    me = _me(user)
    if month and not _MONTH.match(month):
        raise HTTPException(400, "Month must be YYYY-MM")
    day, today = _check_day(day), _check_day(today)
    N = models.NexusNote
    own = db.query(N).filter(N.owner_email == me).all()
    shared = [n for n in db.query(N).filter(N.owner_email != me, N.trashed_at == "",
                                            N.shared_with.like(f'%"{me}"%')).all()
              if _access(n, me)]
    live = [n for n in own if not n.trashed_at]
    counts = {
        "all": len(live) + len(shared),
        "pinned": sum(1 for n in live if n.pinned),
        "today": sum(1 for n in live + shared if today and n.day == today),
        "shared": len(shared),
        "trash": sum(1 for n in own if n.trashed_at),
    }
    tags = sorted({t for n in live + shared for t in _loads(n.tags, [])}, key=str.lower)
    if view == "trash":
        rows = [n for n in own if n.trashed_at]
    elif view == "shared":
        rows = shared
    elif view == "pinned":
        rows = [n for n in live if n.pinned]
    elif view == "today":
        rows = [n for n in live + shared if today and n.day == today]
    else:
        rows = live + shared
    if month:
        rows = [n for n in rows if (n.day or "").startswith(month + "-")]
    if day:
        rows = [n for n in rows if n.day == day]
    if tag:
        rows = [n for n in rows if tag.lower() in (t.lower() for t in _loads(n.tags, []))]
    if q.strip():
        words = q.lower().split()
        rows = [n for n in rows
                if all(w in f"{n.title or ''}\n{n.text or ''}\n{' '.join(_loads(n.tags, []))}".lower() for w in words)]
    rows.sort(key=lambda n: (n.trashed_at if view == "trash" else (n.updated_at or "")), reverse=True)
    return {"notes": [_summary(n, me) for n in rows[:LIST_MAX]], "counts": counts, "tags": tags,
            "more": len(rows) > LIST_MAX}


# ── daily scratchpad ───────────────────────────────────────────────────────
class AppendIn(BaseModel):
    day: str
    text: str


@router.get("/daily")
def get_daily(day: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The caller's scratchpad for `day`, or note: null when there is none yet."""
    me = _me(user)
    n = _daily(db, me, _check_day(day) or "")
    return {"note": _full(n, me) if n else None}


@router.post("/daily/append")
def append_daily(body: AppendIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """One line onto the day's scratchpad, made on its first write. A line
    starting '[ ]' is added as an open checklist item."""
    me = _me(user)
    day = _check_day(body.day)
    text = (body.text or "").strip()
    if not day or not text:
        raise HTTPException(400, "A day and some text are needed")
    n = _daily(db, me, day)
    created = n is None
    if created:
        n = _new_note(me, kind="daily", title="", day=day, body="", text="")
        db.add(n)
    m = re.match(r"^\[( |x)?\]\s*(.+)$", text, re.I)
    if m:
        checked = "true" if (m.group(1) or "").lower() == "x" else "false"
        line = (f'<ul data-type="taskList"><li data-type="taskItem" data-checked="{checked}">'
                f"<p>{escape(m.group(2))}</p></li></ul>")
    else:
        line = "".join(f"<p>{escape(x)}</p>" for x in text.splitlines() if x.strip())
    _set_body(n, (n.body or "") + line)
    if not created:
        _touch(n, me)
    _drop_collab_state(n)
    _content_changed(n, me)
    db.commit()
    return _full(n, me)


# ── one note ───────────────────────────────────────────────────────────────
class NoteIn(BaseModel):
    title: Optional[str] = ""
    body: Optional[str] = ""
    day: Optional[str] = ""
    kind: Optional[str] = "note"
    tags: Optional[List[str]] = None
    color: Optional[str] = ""
    pinned: Optional[bool] = False


class NotePatch(BaseModel):
    rev: int
    title: Optional[str] = None
    body: Optional[str] = None
    day: Optional[str] = None
    tags: Optional[List[str]] = None
    color: Optional[str] = None
    pinned: Optional[bool] = None
    # Co-typing saves (see the header): the Yjs state and the epoch it belongs to.
    ydoc: Optional[str] = None
    yepoch: Optional[str] = None


@router.post("", status_code=201)
def create_note(body: NoteIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    kind = "daily" if body.kind == "daily" else "note"
    day = _check_day(body.day) or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if kind == "daily":
        existing = _daily(db, me, day)
        if existing is not None:
            return _full(existing, me)
    if (body.color or "") not in COLORS:
        raise HTTPException(400, "Unknown color")
    n = _new_note(me, kind=kind, title=(body.title or "").strip()[:TITLE_MAX], day=day,
                  color=body.color or "", pinned=bool(body.pinned))
    n.tags = json.dumps(_clean_tags(body.tags))
    _set_body(n, body.body or "")
    _content_changed(n, me)
    db.add(n)
    db.commit()
    return _full(n, me)


@router.get("/{note_id}")
def get_note(note_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    n, _ = _get_or_404(db, note_id, me)
    if _mark_seen(n, me):
        db.commit()
    return _full(n, me)


@router.patch("/{note_id}")
def update_note(note_id: str, body: NotePatch, user: dict = Depends(get_current_user),
                db: Session = Depends(get_db)):
    me = _me(user)
    n, can = _get_or_404(db, note_id, me, lock=True)
    if can == "read":
        raise HTTPException(403, "This note was shared with you to read only")
    if n.trashed_at:
        raise HTTPException(409, {"message": "This note is in the Trash - restore it to edit.", "note": _full(n, me)})
    collab_save = body.ydoc is not None
    if collab_save and (not n.yepoch or body.yepoch != n.yepoch):
        # The live session's state was rebuilt (or dropped) since it joined.
        raise HTTPException(409, {"message": "This note was changed outside the live session - reloading it.",
                                  "note": _full(n, me), "collab": _collab_state(n), "epoch": True})
    if body.rev != (n.rev or 1):
        detail = {"message": "This note changed somewhere else since you opened it.", "note": _full(n, me)}
        if collab_save:
            detail["collab"] = _collab_state(n)
        raise HTTPException(409, detail)
    owner_only = (body.day, body.tags, body.color, body.pinned)
    if can != "owner" and any(v is not None for v in owner_only):
        raise HTTPException(403, "Only the note's owner changes its pin, color, tags or day")
    changing = (body.title is not None and body.title.strip()[:TITLE_MAX] != (n.title or "")) or \
               (body.body is not None and sanitize_note(body.body) != (n.body or ""))
    if changing:
        _snapshot(db, n, me)
    if body.title is not None:
        n.title = body.title.strip()[:TITLE_MAX]
    if body.body is not None:
        _set_body(n, body.body)
    if body.day is not None:
        n.day = _check_day(body.day) or n.day
    if body.tags is not None:
        n.tags = json.dumps(_clean_tags(body.tags))
    if body.color is not None:
        if body.color not in COLORS:
            raise HTTPException(400, "Unknown color")
        n.color = body.color
    if body.pinned is not None:
        n.pinned = bool(body.pinned)
    if collab_save:
        if len(body.ydoc or "") > YDOC_MAX:
            _drop_collab_state(n)     # too big to keep: the next session rebuilds it from the body
        else:
            n.ydoc = body.ydoc or ""
    elif changing:
        _drop_collab_state(n)
    _touch(n, me)
    if changing:
        _content_changed(n, me)
    db.commit()
    return _full(n, me)


@router.post("/{note_id}/trash")
def trash_note(note_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    n, can = _get_or_404(db, note_id, me)
    if can != "owner":
        raise HTTPException(403, "Only the note's owner can move it to the Trash")
    if not n.trashed_at:
        n.trashed_at = _now()
        n.pinned = False
        _touch(n, me)
        db.commit()
    return _full(n, me)


@router.post("/{note_id}/restore")
def restore_note(note_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    n, can = _get_or_404(db, note_id, me)
    if can != "owner":
        raise HTTPException(404, "Note not found")
    if n.trashed_at:
        n.trashed_at = ""
        _touch(n, me)
        db.commit()
    return _full(n, me)


@router.delete("/{note_id}", status_code=204)
def delete_note_forever(note_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    n, can = _get_or_404(db, note_id, me)
    if can != "owner":
        raise HTTPException(404, "Note not found")
    if not n.trashed_at:
        raise HTTPException(409, "Move the note to the Trash first - only the Trash deletes forever.")
    db.query(models.NexusNoteVersion).filter(models.NexusNoteVersion.note_id == n.id).delete()
    db.query(models.NexusNotePresence).filter(models.NexusNotePresence.note_id == n.id).delete()
    db.delete(n)
    db.commit()


# ── sharing ────────────────────────────────────────────────────────────────
class ShareIn(BaseModel):
    email: str
    can: Optional[str] = "read"


@router.put("/{note_id}/share")
def share_note(note_id: str, body: ShareIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Share with one person from Nexus People (or change what they may do)."""
    me = _me(user)
    n, can = _get_or_404(db, note_id, me, lock=True)
    if can != "owner":
        raise HTTPException(403, "Only the note's owner shares it")
    email = (body.email or "").strip().lower()
    if not email or email == me:
        raise HTTPException(400, "Pick someone else to share with")
    person = _directory_person(db, user, email)
    if person is None:
        raise HTTPException(400, "Notes are shared only with people in Nexus People")
    level = "edit" if body.can == "edit" else "read"
    shares = _shares(n)
    fresh = not any(s["email"] == email for s in shares)
    if fresh and len(shares) >= SHARES_MAX:
        raise HTTPException(400, f"A note is shared with {SHARES_MAX} people at most")
    was = next((s["can"] for s in shares if s["email"] == email), "")
    shares = [s for s in shares if s["email"] != email] + [{"email": email, "can": level}]
    n.shared_with = json.dumps(shares)
    if was == "edit" and level == "read":
        _rotate_key(n)
    _touch(n, me)
    if fresh:
        import notify_rollup
        from auth import company_of
        who = user.get("name") or me
        title = (n.title or "").strip() or "Untitled Note"
        notify_rollup.upsert_rollup(
            db, recipient=email, key=f"note-share:{n.id}", title="Note Shared With You",
            line=f"{who} shared \"{title[:80]}\" with you ({'can edit' if level == 'edit' else 'can read'}).",
            action={"view": "dashboard", "sub": f"notes:{n.id}"}, company=company_of(email, db) or "",
            requested_by=me, replace=True)
    db.commit()
    return _full(n, me)


@router.delete("/{note_id}/share/{email}")
def unshare_note(note_id: str, email: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The owner takes someone off; a person may take themselves off (Leave)."""
    me = _me(user)
    email = (email or "").strip().lower()
    n, can = _get_or_404(db, note_id, me, lock=True)
    if can != "owner" and email != me:
        raise HTTPException(403, "Only the note's owner changes who it is shared with")
    shares = _shares(n)
    left = [s for s in shares if s["email"] != email]
    if len(left) != len(shares):
        n.shared_with = json.dumps(left)
        if any(s["email"] == email and s["can"] == "edit" for s in shares):
            _rotate_key(n)
        db.query(models.NexusNotePresence).filter(models.NexusNotePresence.note_id == n.id,
                                                  models.NexusNotePresence.email == email).delete()
        _touch(n, me)
        db.commit()
    if can != "owner":
        return {"ok": True}
    return _full(n, me)


# ── versions ───────────────────────────────────────────────────────────────
@router.get("/{note_id}/versions")
def list_versions(note_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    n, _ = _get_or_404(db, note_id, me)
    rows = (db.query(models.NexusNoteVersion).filter(models.NexusNoteVersion.note_id == n.id)
            .order_by(models.NexusNoteVersion.created_at.desc()).all())
    return [{"id": v.id, "title": v.title or "", "body": v.body or "", "rev": v.rev or 0,
             "savedBy": v.saved_by or "", "createdAt": v.created_at or "",
             "words": len(plain_text(v.body).split())} for v in rows]


@router.post("/{note_id}/versions/{version_id}/restore")
def restore_version(note_id: str, version_id: str, user: dict = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    """Put an earlier copy back; the note as it stood is kept first."""
    me = _me(user)
    n, can = _get_or_404(db, note_id, me, lock=True)
    if can == "read":
        raise HTTPException(403, "This note was shared with you to read only")
    if n.trashed_at:
        raise HTTPException(409, "Restore the note from the Trash first")
    v = db.query(models.NexusNoteVersion).filter(models.NexusNoteVersion.id == version_id,
                                                 models.NexusNoteVersion.note_id == n.id).first()
    if v is None:
        raise HTTPException(404, "Version not found")
    _snapshot(db, n, me, force=True)
    n.title, n.body = v.title or "", v.body or ""
    n.text = plain_text(n.body)
    _drop_collab_state(n)
    _touch(n, me)
    _content_changed(n, me)
    db.commit()
    return _full(n, me)


# ── who has it open ────────────────────────────────────────────────────────
class PresenceIn(BaseModel):
    state: Optional[str] = "viewing"


@router.post("/{note_id}/presence")
def note_presence(note_id: str, body: PresenceIn, user: dict = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    """The open note's heartbeat: I am here (viewing or editing). Answers who
    else is, and the note's rev, so the screen re-reads it when someone else
    saved."""
    me = _me(user)
    n, can = _get_or_404(db, note_id, me)
    state = "editing" if body.state == "editing" and can != "read" else "viewing"
    P = models.NexusNotePresence
    now = datetime.now(timezone.utc)
    row = db.query(P).filter(P.note_id == n.id, P.email == me).first()
    if row is None:
        db.add(P(note_id=n.id, email=me, state=state, at=now.isoformat()))
    else:
        row.state, row.at = state, now.isoformat()
    cutoff = (now - PRESENCE_TTL).isoformat()
    db.query(P).filter(P.note_id == n.id, P.at < cutoff).delete()
    try:
        db.commit()
    except Exception:       # two tabs of the same person racing the first insert
        db.rollback()
    allowed = {(n.owner_email or "").lower()} | {s["email"] for s in _shares(n)}
    people = [{"email": r.email, "state": r.state}
              for r in db.query(P).filter(P.note_id == n.id, P.at >= cutoff).all()
              if r.email != me and r.email in allowed]
    return {"people": people, "rev": n.rev or 1, "updatedBy": n.updated_by or "",
            "updatedAt": n.updated_at or "", "yepoch": n.yepoch or "", "trashed": bool(n.trashed_at)}


# ── co-typing ──────────────────────────────────────────────────────────────
def _rotate_key(n: models.NexusNote) -> None:
    """A new channel key: whoever lost edit access can neither read nor write the live channel."""
    n.collab_key = base64.b64encode(secrets.token_bytes(32)).decode()


def _channel(n: models.NexusNote) -> str:
    return "nx-note-" + hashlib.sha256(f"{n.id}:{n.collab_key}".encode()).hexdigest()[:32]


def _collab_state(n: models.NexusNote) -> dict:
    return {"ydoc": n.ydoc or "", "yepoch": n.yepoch or "", "rev": n.rev or 1}


def _editor_or_404(db: Session, note_id: str, me: str, lock: bool = False) -> models.NexusNote:
    n, can = _get_or_404(db, note_id, me, lock=lock)
    if can == "read":
        raise HTTPException(403, "This note was shared with you to read only")
    if n.trashed_at:
        raise HTTPException(409, "Restore the note from the Trash first")
    return n


@router.get("/{note_id}/collab")
def note_collab(note_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """What an editor needs to co-type: the channel key and name, and the
    stored Yjs state with its epoch. Owner and Can Edit only."""
    me = _me(user)
    n = _editor_or_404(db, note_id, me, lock=True)
    if not n.collab_key:
        _rotate_key(n)
        db.commit()
    return {"key": n.collab_key, "channel": _channel(n), **_collab_state(n),
            "title": n.title or "", "body": n.body or ""}


class SeedIn(BaseModel):
    rev: int
    ydoc: str
    yepoch: str


@router.post("/{note_id}/collab/seed")
def seed_collab(note_id: str, body: SeedIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Start the note's Yjs state from its body. The first editor wins; a
    second one gets 409 with the winner's state and joins it, so two
    browsers never seed the same words twice."""
    me = _me(user)
    n = _editor_or_404(db, note_id, me, lock=True)
    epoch = (body.yepoch or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", epoch) or not body.ydoc or len(body.ydoc) > YDOC_MAX:
        raise HTTPException(400, "Not a co-typing state")
    if n.yepoch or body.rev != (n.rev or 1):
        raise HTTPException(409, {"message": "Someone else started this note's live session first.",
                                  "collab": _collab_state(n), "note": _full(n, me)})
    n.ydoc, n.yepoch = body.ydoc, epoch
    db.commit()
    return _collab_state(n)

