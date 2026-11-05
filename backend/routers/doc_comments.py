"""Comments on a Documents editor page (Review tab, Nov 2026).

A comment is a thread on a document or a template: a root with a quote of the
text it was made on, replies under it, Resolve / Reopen, edit by its author,
delete by its author or an administrator. The editor keeps the ANCHOR (a
`comment` mark carrying the comment id) in the page JSON; this table keeps the
words, so a comment survives the text it sat on being retyped and shows in the
Review pane either way.

Access is the document's own: whoever may read the document (documents.py
_get_readable - the same walls as the list) may read and write its comments;
a template's comments follow _get_template. Resolve is the author's, the
document owner's or an administrator's. The document owner gets one bell per
new comment from someone else (a named recipient, so it pushes to the phone);
a reply also bells the thread's author.
"""
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import DocComment, NexusEmployee
from routers import documents as docs
from routers.hr import _hr_notify


def _display_name(db: Session, email: str) -> str:
    """The person's name from Nexus People, else a readable form of the email."""
    emp = db.query(NexusEmployee).filter(NexusEmployee.work_email == email).first()
    if emp and (emp.first_name or emp.last_name):
        return f"{emp.first_name or ''} {emp.last_name or ''}".strip()
    return email.split("@")[0].replace(".", " ").title()

router = APIRouter(prefix="/documents", tags=["documents"])

MAX_BODY = 4000
MAX_QUOTE = 300


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _target(db: Session, kind: str, tid: str, user: dict):
    """The document or template through its own read rule, and its owner."""
    if kind == "template":
        row = docs._get_template(db, tid)
        return row, (row.created_by or "").lower(), (row.name or "")
    row = docs._get_readable(db, tid, user)
    return row, (row.owner_email or "").lower(), (row.title or "")


def _ser(c: DocComment) -> dict:
    return {
        "id": c.id, "docKind": c.doc_kind, "docId": c.doc_id, "parentId": c.parent_id or "",
        "author": c.author_email, "authorName": c.author_name, "body": c.body or "", "quote": c.quote or "",
        "resolvedAt": c.resolved_at or "", "resolvedBy": c.resolved_by or "",
        "createdAt": c.created_at, "updatedAt": c.updated_at or "",
    }


def _comment(db: Session, kind: str, tid: str, cid: str) -> DocComment:
    row = (db.query(DocComment)
           .filter(DocComment.id == cid, DocComment.doc_kind == kind, DocComment.doc_id == tid).first())
    if not row:
        raise HTTPException(404, "Comment not found")
    return row


class CommentIn(BaseModel):
    body: str
    quote: str = ""
    parentId: str = ""


class CommentPatch(BaseModel):
    body: Optional[str] = None
    resolved: Optional[bool] = None


def _clean_body(body) -> str:
    text = str(body or "").strip()
    if not text:
        raise HTTPException(400, "Write something first")
    if len(text) > MAX_BODY:
        raise HTTPException(400, f"A comment is at most {MAX_BODY} characters")
    return text


def _list(db: Session, kind: str, tid: str, user: dict) -> list:
    _target(db, kind, tid, user)
    rows = (db.query(DocComment).filter(DocComment.doc_kind == kind, DocComment.doc_id == tid)
            .order_by(DocComment.created_at.asc()).all())
    return [_ser(r) for r in rows]


def _create(db: Session, kind: str, tid: str, data: CommentIn, user: dict) -> dict:
    _row, owner, title = _target(db, kind, tid, user)
    body = _clean_body(data.body)
    parent = None
    if data.parentId:
        parent = _comment(db, kind, tid, data.parentId)
        if parent.parent_id:
            raise HTTPException(400, "Reply to the comment, not to a reply")
    me = user["email"].lower()
    now = _now()
    c = DocComment(id=str(uuid.uuid4()), doc_kind=kind, doc_id=tid, parent_id=parent.id if parent else "",
                   author_email=me, author_name=_display_name(db, me),
                   body=body, quote=(str(data.quote or "").strip()[:MAX_QUOTE] if not parent else ""),
                   created_at=now, updated_at=now)
    db.add(c)
    db.commit()
    db.refresh(c)
    # One bell to the owner (never to yourself), one to the thread's author on
    # a reply; the action lands on the Documents list.
    preview = body if len(body) <= 120 else body[:117] + "..."
    heading = f"New Comment on {title or 'a document'}" if not parent else f"New Reply on {title or 'a document'}"
    action = {"view": "documents", "sub": "documents-browse" if kind == "document" else "templates"}
    for to in {owner, (parent.author_email if parent else "")} - {me, ""}:
        _hr_notify(db, to, heading, f"{c.author_name}: {preview}", ref_id=c.id, requested_by=me, action=action)
    db.commit()
    return _ser(c)


def _patch(db: Session, kind: str, tid: str, cid: str, data: CommentPatch, user: dict) -> dict:
    _row, owner, _title = _target(db, kind, tid, user)
    c = _comment(db, kind, tid, cid)
    me = user["email"].lower()
    is_admin = user["level"] >= docs._ADMIN_LEVEL
    if data.body is not None:
        if c.author_email != me and not is_admin:
            raise HTTPException(403, "Only the author can edit a comment")
        c.body = _clean_body(data.body)
        c.updated_at = _now()
    if data.resolved is not None:
        if c.parent_id:
            raise HTTPException(400, "Resolve the thread, not a reply")
        if me not in (c.author_email, owner) and not is_admin:
            raise HTTPException(403, "Only the author, the document's owner or an administrator can resolve a comment")
        c.resolved_at = _now() if data.resolved else ""
        c.resolved_by = me if data.resolved else ""
    db.commit()
    db.refresh(c)
    return _ser(c)


def _delete(db: Session, kind: str, tid: str, cid: str, user: dict) -> dict:
    _target(db, kind, tid, user)
    c = _comment(db, kind, tid, cid)
    me = user["email"].lower()
    if c.author_email != me and user["level"] < docs._ADMIN_LEVEL:
        raise HTTPException(403, "Only the author or an administrator can delete a comment")
    if not c.parent_id:   # a thread goes with its root
        db.query(DocComment).filter(DocComment.doc_kind == kind, DocComment.doc_id == tid,
                                    DocComment.parent_id == c.id).delete()
    db.delete(c)
    db.commit()
    return {"ok": True}


# ── Documents ───────────────────────────────────────────────────────────────
@router.get("/{did}/comments")
def list_document_comments(did: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _list(db, "document", did, user)


@router.post("/{did}/comments")
def add_document_comment(did: str, data: CommentIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _create(db, "document", did, data, user)


@router.patch("/{did}/comments/{cid}")
def patch_document_comment(did: str, cid: str, data: CommentPatch, user: dict = Depends(get_current_user),
                           db: Session = Depends(get_db)):
    return _patch(db, "document", did, cid, data, user)


@router.delete("/{did}/comments/{cid}")
def delete_document_comment(did: str, cid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _delete(db, "document", did, cid, user)


# ── Templates ───────────────────────────────────────────────────────────────
@router.get("/templates/{tid}/comments")
def list_template_comments(tid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _list(db, "template", tid, user)


@router.post("/templates/{tid}/comments")
def add_template_comment(tid: str, data: CommentIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _create(db, "template", tid, data, user)


@router.patch("/templates/{tid}/comments/{cid}")
def patch_template_comment(tid: str, cid: str, data: CommentPatch, user: dict = Depends(get_current_user),
                           db: Session = Depends(get_db)):
    return _patch(db, "template", tid, cid, data, user)


@router.delete("/templates/{tid}/comments/{cid}")
def delete_template_comment(tid: str, cid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _delete(db, "template", tid, cid, user)
