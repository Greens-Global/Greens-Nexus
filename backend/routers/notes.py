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

The body is HTML from the Notes editor, sanitized here with the rich-text
allowlist the saved replies use (ticket_saved_replies._RichSanitizer) plus
what the editor's checklists, mentions and alignment need. AI is off for
Notes as for the rest of Nexus - nothing here calls a model.
"""
import json
import re
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
VERSIONS_KEPT = 25
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
            return          # <source>, <track> and the like inside a player
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
    """Keep the note as it stands now, when the newest copy is old enough."""
    if not (n.body or n.title):
        return
    last = (db.query(models.NexusNoteVersion).filter(models.NexusNoteVersion.note_id == n.id)
            .order_by(models.NexusNoteVersion.created_at.desc()).first())
    if last and not force:
        try:
            if datetime.now(timezone.utc) - datetime.fromisoformat(last.created_at) < VERSION_GAP:
                return
        except ValueError:
            pass
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
    db.add(n)
    db.commit()
    return _full(n, me)


@router.get("/{note_id}")
def get_note(note_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    n, _ = _get_or_404(db, note_id, me)
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
    if body.rev != (n.rev or 1):
        raise HTTPException(409, {"message": "This note changed somewhere else since you opened it.",
                                  "note": _full(n, me)})
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
    _touch(n, me)
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
    shares = [s for s in shares if s["email"] != email] + [{"email": email, "can": level}]
    n.shared_with = json.dumps(shares)
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
    _touch(n, me)
    db.commit()
    return _full(n, me)

