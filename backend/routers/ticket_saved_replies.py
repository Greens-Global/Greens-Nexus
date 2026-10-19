"""Ticket saved replies (canned responses) for the service desk (Oct 2026).

An agent answering the same question for the tenth time picks a saved reply
in the ticket drawer's reply composer ("Saved Replies"); its text is filled in
and inserted into the composer for editing. It is never sent on its own - the
reply still goes out with the rest of the drawer's changes on Done.

Two kinds, one table (models.TicketSavedReply):
  shared   - owner_email "", one company's whole desk sees it. Created, edited
             and deleted by ticket supervisors only (ticket_roles.can_manage_desk).
  personal - owner_email = the agent; only they see, edit or delete it.
Every route is desk-only (ticket_roles.can_work_queue) and walled by company
(auth.assert_company / company_ok - another company's reply is 404).

Placeholders, filled in the browser when a reply is inserted (the drawer has
the ticket and the agent; frontend/src/tickets/savedReplies.js fillPlaceholders
is the one implementation, and PLACEHOLDERS below the one list):
  {requester_first_name} {requester_name} {ticket_number} {ticket_subject}
  {agent_first_name} {agent_name}
Anything else in braces is left exactly as typed.

The body is rich text from the same editor as ticket comments. Ticket
comments have no server-side sanitizer - they are stored as written and made
safe on render (tasks/lib.js sanitizeRichHtml). A saved reply is sanitized on
save as well, with that same allowlist (_RichSanitizer below mirrors RICH_TAGS
/ RICH_ATTRS), so quotes, tables and pasted screenshots survive; images only
from our own storage (items._validate_photo_url, the rule ticket images
follow). It is rendered through richBodyHtml again like every comment body.
A body with no markup at all is plain text and becomes paragraphs (escaped
once - never twice).
"""
import re
from html import escape
from html.parser import HTMLParser
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

import auth
import models
import ticket_roles
from auth import get_current_user
from database import get_db
from routers.task_util import gen_id, now_iso
from task_inbound_parse import has_text, plain_to_html

router = APIRouter(tags=["Tickets"], dependencies=[Depends(ticket_roles.require_ticket_agent)])

PLACEHOLDERS = ("requester_first_name", "requester_name", "ticket_number", "ticket_subject",
                "agent_first_name", "agent_name")
TITLE_MAX = 120
BODY_MAX = 20000


class SavedReplyIn(BaseModel):
    title: str
    body: str
    help_topic: Optional[str] = ""
    shared: Optional[bool] = False
    company_id: Optional[str] = None     # default: the caller's own company


class SavedReplyUpdate(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    help_topic: Optional[str] = None
    shared: Optional[bool] = None


def _me(user: dict) -> str:
    return (user.get("email") or "").strip().lower()


def _to_dict(r: models.TicketSavedReply, user: dict, db: Session, supervisor: bool | None = None) -> dict:
    mine = (r.owner_email or "") == _me(user)
    shared = not (r.owner_email or "")
    return {
        "id": r.id, "companyId": r.company_id or "", "title": r.title or "", "body": r.body or "",
        "helpTopic": r.help_topic or "", "shared": shared, "ownerEmail": r.owner_email or "",
        "createdBy": r.created_by or "", "createdAt": r.created_at or "", "modifiedAt": r.modified_at or "",
        "useCount": r.use_count or 0,
        "canEdit": mine or (shared and (ticket_roles.can_manage_desk(user, db) if supervisor is None else supervisor)),
    }


# Mirrors RICH_TAGS / RICH_ATTRS / SAFE_URL in frontend/src/tasks/lib.js.
_RICH_TAGS = {"p", "br", "b", "strong", "i", "em", "u", "s", "strike", "del", "code", "pre", "blockquote",
              "ul", "ol", "li", "a", "img", "mark", "span", "h1", "h2", "h3", "h4", "hr",
              "table", "thead", "tbody", "tr", "td", "th"}
_RICH_ATTRS = {"a": ("href", "title"), "img": ("src", "alt", "title")}
_VOID = {"br", "hr", "img"}
# Dropped WITH their contents.
_DROP_TREE = {"script", "style", "iframe", "object", "embed", "form", "svg", "math", "noscript",
              "template", "head", "title", "textarea", "select"}
_SAFE_HREF = re.compile(r"^(https?:|mailto:)", re.I)


def _own_image(src: str) -> bool:
    from routers.items import _validate_photo_url
    if not re.match(r"^https?://", src or "", re.I):
        return False
    try:
        _validate_photo_url(src, "Image")
        return True
    except HTTPException:
        return False


class _RichSanitizer(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.open = [], []
        self.drop_tag, self.drop_depth = "", 0

    def _attrs(self, tag, attrs):
        allowed = _RICH_ATTRS.get(tag, ())
        kept = []
        for k, v in attrs:
            k, v = (k or "").lower(), (v or "").strip()
            if k not in allowed:
                continue
            if k == "href" and not _SAFE_HREF.match(v):
                continue
            if k == "src" and not _own_image(v):
                continue
            kept.append(f' {k}="{escape(v, quote=True)}"')
        return "".join(kept)

    def handle_starttag(self, tag, attrs):
        if self.drop_depth:
            if tag == self.drop_tag:
                self.drop_depth += 1
            return
        if tag in _DROP_TREE:
            self.drop_tag, self.drop_depth = tag, 1
            return
        if tag not in _RICH_TAGS:
            return                                   # unwrap: children survive
        a = self._attrs(tag, attrs)
        if tag == "img":
            if ' src="' in a:
                self.out.append(f"<img{a}>")         # an image from anywhere else is dropped
            return
        if tag in _VOID:
            self.out.append(f"<{tag}>")
            return
        self.out.append(f"<{tag}{a}>")
        self.open.append(tag)

    def handle_startendtag(self, tag, attrs):
        if tag in _VOID:
            self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if self.drop_depth:
            if tag == self.drop_tag:
                self.drop_depth -= 1
                if not self.drop_depth:
                    self.drop_tag = ""
            return
        if tag in self.open:
            while self.open:
                t = self.open.pop()
                self.out.append(f"</{t}>")
                if t == tag:
                    break

    def handle_data(self, data):
        if not self.drop_depth and data:
            self.out.append(escape(data, quote=False))

    def result(self) -> str:
        while self.open:
            self.out.append(f"</{self.open.pop()}>")
        return "".join(self.out)


def sanitize_reply(body: str) -> str:
    """A saved reply's body as stored (see the module docstring)."""
    body = body or ""
    if not re.search(r"<[a-z/!][^>]*>", body, re.I):
        return plain_to_html(body)                    # plain text: escaped once, as paragraphs
    p = _RichSanitizer()
    p.feed(body)
    p.close()
    return p.result().strip()


def _clean(title, body, help_topic) -> tuple:
    title = " ".join((title or "").split())
    if not title:
        raise HTTPException(422, "Give the saved reply a title.")
    if len(title) > TITLE_MAX:
        raise HTTPException(422, f"The title is too long ({TITLE_MAX} characters max).")
    clean = sanitize_reply(body)
    if not has_text(clean) and "<img" not in clean:
        raise HTTPException(422, "The saved reply needs some text.")
    if len(clean) > BODY_MAX:
        raise HTTPException(422, "The saved reply is too long - keep it to a few paragraphs.")
    return title, clean, " ".join((help_topic or "").split())[:120]


def _require_supervisor(user: dict, db: Session) -> None:
    if not ticket_roles.can_manage_desk(user, db):
        raise HTTPException(403, "Only a ticket supervisor can change shared saved replies.")


def _visible_or_404(db: Session, user: dict, reply_id: str) -> models.TicketSavedReply:
    r = db.query(models.TicketSavedReply).filter(models.TicketSavedReply.id == reply_id).first()
    if r is None:
        raise HTTPException(404, "Saved reply not found")
    owner = r.owner_email or ""
    if owner and owner != _me(user):
        raise HTTPException(404, "Saved reply not found")   # someone else's personal reply
    if not owner:
        auth.assert_company(r.company_id or "", user, db)   # another company's shared reply is 404
    return r


def _may_edit(db: Session, user: dict, r: models.TicketSavedReply) -> None:
    if r.owner_email:
        if r.owner_email != _me(user):
            raise HTTPException(404, "Saved reply not found")
        return
    _require_supervisor(user, db)


@router.get("/ticket-saved-replies")
def list_saved_replies(company_id: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """My personal replies, plus the shared ones of my companies - or, with
    `company_id` (the ticket being answered), that company's shared replies."""
    q = db.query(models.TicketSavedReply)
    me = _me(user)
    scope = auth.company_scope(user, db)
    if company_id:
        auth.assert_company(company_id, user, db)
        shared = (models.TicketSavedReply.owner_email == "") & (models.TicketSavedReply.company_id == company_id)
    else:
        shared = models.TicketSavedReply.owner_email == ""
    rows = q.filter(or_(models.TicketSavedReply.owner_email == me, shared)).all()
    rows = [r for r in rows if r.owner_email or auth.company_ok(r.company_id or "", scope)]
    rows.sort(key=lambda r: ((r.title or "").lower(), r.id))
    sup = ticket_roles.can_manage_desk(user, db)
    return [_to_dict(r, user, db, sup) for r in rows]


@router.post("/ticket-saved-replies", status_code=201)
def create_saved_reply(body: SavedReplyIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if body.shared:
        _require_supervisor(user, db)
    company = (body.company_id if body.company_id is not None else auth.company_of(user, db)) or ""
    company = company.strip()
    if body.company_id:
        auth.assert_company(company, user, db)
    # A shared reply belongs to one company's desk. Once companies exist,
    # one must be named - a Global Admin with no company of their own picks.
    if body.shared and not company and db.query(models.HrEntity.id).first() is not None:
        raise HTTPException(422, "Pick the company whose desk shares this reply.")
    title, clean, topic = _clean(body.title, body.body, body.help_topic)
    now = now_iso()
    r = models.TicketSavedReply(id=gen_id(), company_id=company, owner_email="" if body.shared else _me(user),
                                title=title, body=clean, help_topic=topic, created_by=_me(user),
                                created_at=now, modified_at=now, use_count=0)
    db.add(r)
    db.commit()
    return _to_dict(r, user, db)


@router.patch("/ticket-saved-replies/{reply_id}")
def update_saved_reply(reply_id: str, body: SavedReplyUpdate, user: dict = Depends(get_current_user),
                       db: Session = Depends(get_db)):
    r = _visible_or_404(db, user, reply_id)
    _may_edit(db, user, r)
    title, clean, topic = _clean(body.title if body.title is not None else r.title,
                                 body.body if body.body is not None else r.body,
                                 body.help_topic if body.help_topic is not None else r.help_topic)
    r.title, r.body, r.help_topic = title, clean, topic
    if body.shared is not None and body.shared != (not r.owner_email):
        # Sharing a personal reply with the desk, or taking a shared one back
        # as your own, is a supervisor's call either way.
        _require_supervisor(user, db)
        r.owner_email = "" if body.shared else _me(user)
    r.modified_at = now_iso()
    db.commit()
    return _to_dict(r, user, db)


@router.delete("/ticket-saved-replies/{reply_id}", status_code=204)
def delete_saved_reply(reply_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    r = _visible_or_404(db, user, reply_id)
    _may_edit(db, user, r)
    db.delete(r)
    db.commit()


@router.post("/ticket-saved-replies/{reply_id}/use", status_code=204)
def use_saved_reply(reply_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Counted when a reply is inserted into the composer (the drawer fires
    this and does not wait for it) - the Manage list sorts by it."""
    _visible_or_404(db, user, reply_id)
    db.query(models.TicketSavedReply).filter(models.TicketSavedReply.id == reply_id).update(
        {models.TicketSavedReply.use_count: models.TicketSavedReply.use_count + 1}, synchronize_session=False)
    db.commit()
