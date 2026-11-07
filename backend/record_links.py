"""Record links everywhere (Neil, 11/07/2026 - the "everything links both ways"
idea from Macro). A [[ link is <a data-type="recordLink" data-ref="<kind>:<id>">
in a note, a task's description, a ticket's description, or a task or ticket
comment. Every one of them is written down here, in `nexus_record_links`, so
the record it points at can list "Mentioned In" without searching every body.

ONE writer: a before_flush hook on SessionLocal (wired in database.py) sees
every insert, change and delete of those four kinds of row, whatever route
made it, and rewrites that row's links. Nothing else writes the table.

ONE reader: `mentions()` (GET /notes/mentions). A link is only ever shown to
someone who may open the place it was written - the note's access, the task's
wall and visibility, the ticket's participant rule, and for an internal ticket
note the desk's internal-note rule. Nothing about a place the reader cannot
open is counted or named.
"""
import json
import re
from datetime import datetime, timezone

from sqlalchemy import event, inspect

# Mirrors notes.py _RECORD_REF and frontend notes/recordLink.jsx - change all three together.
RECORD_REF = re.compile(r"^(note|task|job|kb|ticket):[A-Za-z0-9_\-.]{1,100}$")
_IN_HTML = re.compile(r'data-ref="((?:note|task|job|kb|ticket):[A-Za-z0-9_\-.]{1,100})"')
MARK = "record_links.backfill_2026_11_07"


def refs_in(html: str) -> list:
    """The record refs a body links to, in order, each once."""
    if not html or "data-ref=" not in html:
        return []
    out = []
    for r in _IN_HTML.findall(html):
        if r not in out:
            out.append(r)
    return out


def scene_refs(raw: str) -> list:
    """The records a board's cards stand for (Record Cards, 11/07/2026): each
    live element's customData.nexusRecord.ref, in order, each once."""
    if not raw or '"nexusRecord"' not in raw:
        return []
    try:
        els = (json.loads(raw) or {}).get("elements") or []
    except (TypeError, ValueError, AttributeError):
        return []
    out = []
    for e in els:
        if not isinstance(e, dict) or e.get("isDeleted"):
            continue
        ref = ((e.get("customData") or {}).get("nexusRecord") or {}).get("ref")
        if isinstance(ref, str) and RECORD_REF.match(ref) and ref not in out:
            out.append(ref)
    return out


def _refs_of(obj, deleted=False) -> list:
    import models
    if deleted:
        return []
    if isinstance(obj, models.NexusNote):
        out = refs_in(obj.body or "")
        return out + [r for r in scene_refs(obj.scene or "") if r not in out]
    return refs_in(getattr(obj, _source_kind(obj)[0], "") or "")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _source(session, obj):
    """(src_ref, parent_ref, internal, html) for a row that can hold links,
    else None. A comment lives in the task tables whether it is on a task or a
    ticket; the ticket table says which."""
    import models
    if isinstance(obj, models.NexusNote):
        return f"note:{obj.id}", f"note:{obj.id}", False, "body"
    if isinstance(obj, models.Task):
        return f"task:{obj.id}", f"task:{obj.id}", False, "description"
    if isinstance(obj, models.TaskTicket):
        return f"ticket:{obj.id}", f"ticket:{obj.id}", False, "description"
    if isinstance(obj, models.TaskComment):
        on_ticket = (session.query(models.TaskTicket.id)
                     .execution_options(include_confidential=True)   # only "is it a ticket", never its contents
                     .filter(models.TaskTicket.id == obj.task_id).first()) is not None
        parent = f"ticket:{obj.task_id}" if on_ticket else f"task:{obj.task_id}"
        return f"comment:{obj.id}", parent, bool(obj.internal), "body"
    return None


def _rewrite(session, obj, deleted=False) -> None:
    import models
    if not getattr(obj, "id", None):
        return
    fields = _source_kind(obj)
    if fields is None:
        return
    is_new = obj in session.new
    if not deleted and not is_new:
        state = inspect(obj).attrs
        if not any(state[f].history.has_changes() for f in fields):
            return
    refs = _refs_of(obj, deleted)
    if is_new and not refs:
        return                       # nothing to write and nothing written before
    src = _source(session, obj)
    if src is None:
        return
    src_ref, parent_ref, internal, _ = src
    L = models.NexusRecordLink
    if not is_new:
        session.query(L).filter(L.src_ref == src_ref).delete(synchronize_session=False)
    now = _now()
    for ref in refs:
        if ref == parent_ref:
            continue                 # a record never lists itself
        session.add(L(src_ref=src_ref, parent_ref=parent_ref, dst_ref=ref, internal=internal, created_at=now))


def _source_kind(obj):
    """The fields of a row that can hold links (a board's cards are in its
    scene; a comment moving to or from internal moves its links), else None."""
    import models
    if isinstance(obj, models.NexusNote):
        return ("body", "scene")
    if isinstance(obj, (models.Task, models.TaskTicket)):
        return ("description",)
    if isinstance(obj, models.TaskComment):
        return ("body", "internal")
    return None


def wire(session_factory):
    @event.listens_for(session_factory, "before_flush")
    def _record_links(session, _ctx, _instances):
        for obj in list(session.new) + list(session.dirty):
            if _source_kind(obj) is None:
                continue
            try:
                _rewrite(session, obj)
            except Exception as e:  # noqa: BLE001 - a link list must never fail the save it rides on
                print(f"[record-links] {type(obj).__name__} {getattr(obj, 'id', '')}: {e}")
        for obj in list(session.deleted):
            if _source_kind(obj) is None:
                continue
            try:
                _rewrite(session, obj, deleted=True)
            except Exception as e:  # noqa: BLE001
                print(f"[record-links] delete {type(obj).__name__} {getattr(obj, 'id', '')}: {e}")


def backfill_once(db) -> int | None:
    """Write the links of every note saved before the table existed (record
    links shipped in Notes on 11/06/2026, a day before this). Tasks, tickets
    and comments could not hold a link until now. Returns the count, or None
    when the mark is already there. Commits."""
    import models
    if db.get(models.NexusSetting, MARK):
        return None
    N, L = models.NexusNote, models.NexusRecordLink
    n = 0
    for note in db.query(N).filter(N.body.like('%data-ref="%')).all():
        src = f"note:{note.id}"
        db.query(L).filter(L.src_ref == src).delete(synchronize_session=False)
        for ref in refs_in(note.body or ""):
            if ref != src:
                db.add(L(src_ref=src, parent_ref=src, dst_ref=ref, internal=False, created_at=_now()))
                n += 1
    db.add(models.NexusSetting(key=MARK, value=_now()))
    db.commit()
    return n


# ── reading ────────────────────────────────────────────────────────────────

def _note_item(db, user, nid):
    import models
    from routers.notes import _access, _me
    n = db.get(models.NexusNote, nid)
    me = _me(user)
    if n is None or n.trashed_at or not _access(n, me):
        return None
    return {"kind": "board" if (n.kind or "note") == "board" else "note", "id": n.id,
            "title": n.title or "", "owner": n.owner_email, "mine": _access(n, me) == "owner",
            "updatedAt": n.updated_at or ""}


def _task_item(db, user, tid):
    from fastapi import HTTPException
    from routers.tasks import _wall_task
    try:
        t = _wall_task(db, user, tid)
    except HTTPException:
        return None
    return {"kind": "task", "id": t.id, "title": t.title or "", "code": t.code or "",
            "done": bool(t.completed), "updatedAt": t.modified_at or t.created_at or ""}


def _ticket_item(db, user, kid, internal_only):
    from fastapi import HTTPException
    from routers import tickets
    try:
        t = tickets._ticket_or_404(db, kid, confidential=True)
        tickets._require_ticket_participant(db, user, t)
    except HTTPException:
        return None
    if internal_only and not tickets._sees_internal(db, t, user, tickets._has_desk_grant(user, db)):
        return None                  # only an internal note links it, and this reader never sees those
    return {"kind": "ticket", "id": t.id, "title": t.subject or "", "code": t.code or "",
            "done": (t.status or "") in ("resolved", "closed"), "updatedAt": t.modified_at or t.created_at or ""}


def mentions(db, user, ref: str, limit: int = 50) -> dict:
    """The places the caller may open that link to `ref`, newest first: one
    row per note, board, task or ticket (a comment counts for its task or
    ticket; `via` says when only comments link it)."""
    import models
    L = models.NexusRecordLink
    places = {}      # parent_ref -> {"internal_only": bool, "comment_only": bool}
    for r in db.query(L).filter(L.dst_ref == ref).all():
        p = places.setdefault(r.parent_ref, {"internal_only": True, "comment_only": True})
        p["internal_only"] = p["internal_only"] and bool(r.internal)
        p["comment_only"] = p["comment_only"] and r.src_ref.startswith("comment:")
    items = []
    for parent, how in places.items():
        kind, _, pid = parent.partition(":")
        if kind == "note":
            item = _note_item(db, user, pid)
        elif kind == "task":
            item = _task_item(db, user, pid)
        elif kind == "ticket":
            item = _ticket_item(db, user, pid, how["internal_only"])
        else:
            item = None
        if item is not None:
            item["via"] = "comment" if how["comment_only"] and kind in ("task", "ticket") else ""
            items.append(item)
    items.sort(key=lambda i: i.get("updatedAt") or "", reverse=True)
    return {"items": items[:limit], "total": len(items)}
