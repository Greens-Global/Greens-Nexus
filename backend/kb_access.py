"""Who may see and do what in the Knowledge Base (Oct 2026 rebuild).

The old module had two walls (the list and the page) and one rule ("is a
manager"). This is the one place the new routers ask:

  Read      every signed-in employee (externals need the `sop` grant, which
            auth.apply_external_policy already enforces by path prefix).
  Author    the `sop` grant at `editor` or better, or a manager+ role.
  Manage    the `sop` grant at `full` or better, or a manager+ role.
  Owner     a collection owner acts as Manage inside their collection.

Company walls apply to EVERY route: a page belongs to its owner's company,
a collection to its owner's, a course to its owner's. Drafts (draft /
in_review / changes_requested) are only visible to their author, their
reviewer, the collection owner and Manage. Archived pages are visible to
authors and above.
"""
from __future__ import annotations

from typing import Iterable

from fastapi import HTTPException
from sqlalchemy.orm import Session

import auth
import models
from auth import get_current_user, require_module_grant

MODULE = "sop"
DRAFT_STATES = ("draft", "in_review", "changes_requested")
LEVEL_MANAGER = 3

require_read = get_current_user
require_author = require_module_grant(MODULE, "editor", bypass_level="manager")
require_manage = require_module_grant(MODULE, "full", bypass_level="manager")


def is_author(user: dict, db: Session) -> bool:
    return user.get("level", 0) >= LEVEL_MANAGER or auth._module_level(user["email"], MODULE, db) >= auth._MODULE_LEVEL_RANK["editor"]


def is_manage(user: dict, db: Session) -> bool:
    return user.get("level", 0) >= LEVEL_MANAGER or auth._module_level(user["email"], MODULE, db) >= auth._MODULE_LEVEL_RANK["full"]


def _email(user: dict) -> str:
    return (user.get("email") or "").lower()


def collection_owner(db: Session, collection_id: str) -> str:
    if not collection_id:
        return ""
    c = db.query(models.KbCollection).filter(models.KbCollection.id == collection_id).first()
    if not c:
        return ""
    if c.owner_email:
        return c.owner_email.lower()
    if c.parent_id:
        p = db.query(models.KbCollection).filter(models.KbCollection.id == c.parent_id).first()
        return (p.owner_email or "").lower() if p else ""
    return ""


def owns_collection(user: dict, db: Session, collection_id: str) -> bool:
    return bool(collection_id) and collection_owner(db, collection_id) == _email(user)


# ----------------------------------------------------------------- walls

def scope(user: dict, db: Session):
    """None = sees every company; else the set of company ids."""
    return auth.company_scope(user, db)


def wall_rows(rows: Iterable, user: dict, db: Session, owner_attr: str = "owner_email") -> list:
    """Keep the rows whose owner's company the caller may see. Rows with no
    owner (or an owner with no company) are shared."""
    sc = scope(user, db)
    rows = list(rows)
    if sc is None:
        return rows
    emp = auth.company_of_email_map(db)
    return [r for r in rows if auth.company_ok(emp.get((getattr(r, owner_attr, "") or "").lower(), ""), sc, shared_when_blank=True)]


def scope_of_email(db: Session, email: str):
    """The company scope of someone who is not the caller: the person who made
    an assignment rule or a training plan, so the daily job only reaches people
    that person could reach themselves. Blank = no limit (nothing to scope by)."""
    email = (email or "").lower()
    if not email or email == "rule":
        return None
    return auth.company_scope({"email": email, "level": auth.level_for(email, db)}, db)


def in_scope(db: Session, email: str, sc) -> bool:
    """May a person with company scope `sc` assign training to `email`?"""
    if sc is None:
        return True
    return auth.company_ok(auth.company_of(email, db), sc, shared_when_blank=True)


def assert_wall(row, user: dict, db: Session, owner_attr: str = "owner_email") -> None:
    sc = scope(user, db)
    if sc is None:
        return
    company = auth.company_of((getattr(row, owner_attr, "") or "").lower(), db)
    if not auth.company_ok(company, sc, shared_when_blank=True):
        raise HTTPException(404, "Not found")


# ----------------------------------------------------------------- pages

def readers_of(d: models.KbDocument):
    """The page's reader audience, or None when everyone in its company reads it."""
    import kb_audience
    raw = getattr(d, "readers", "") or ""
    if not raw.strip():
        return None
    a = kb_audience.loads(raw)
    return None if kb_audience.is_everyone(a) else a


class _Reader:
    """Who the caller is, worked out once for a list of pages."""
    def __init__(self, user: dict, db: Session):
        self.email = _email(user)
        self.manage = is_manage(user, db)
        self.owned = {c.id for c in db.query(models.KbCollection).filter(models.KbCollection.owner_email == self.email).all()} if self.email else set()
        self.emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == self.email).first() if self.email else None


def may_read(d: models.KbDocument, user: dict, db: Session, who: "_Reader | None" = None) -> bool:
    """WP 5.3: a page with readers is read by them, its owner, reviewer and
    collection owner, Knowledge Base Manage, and - a policy - everyone who
    must sign it. A page with no readers is read by its whole company."""
    import kb_core
    a = readers_of(d)
    if a is None and kb_core.is_live(d):
        return True
    import kb_audience
    who = who or _Reader(user, db)
    if who.manage or (d.owner_email or "").lower() == who.email or (d.reviewer_email or "").lower() == who.email:
        return True
    if d.collection_id and d.collection_id in who.owned:
        return True
    if not kb_core.is_live(d):   # scheduled (WP 5.8): its editors only, until the day
        return False
    if who.emp is None:
        return False
    if kb_audience.matches(who.emp, a):
        return True
    return bool(d.require_ack and d.audience and kb_audience.matches(who.emp, kb_audience.loads(d.audience)))


def readable(rows: Iterable[models.KbDocument], user: dict, db: Session) -> list[models.KbDocument]:
    """The pages the caller may read: the company wall, then each page's readers."""
    rows = wall_rows(rows, user, db)
    who = _Reader(user, db)
    return [d for d in rows if may_read(d, user, db, who)]


def can_see_page(d: models.KbDocument, user: dict, db: Session) -> bool:
    me = _email(user)
    if d.status == "approved":
        return may_read(d, user, db)
    if is_manage(user, db):
        return True
    if (d.owner_email or "").lower() == me or (d.reviewer_email or "").lower() == me:
        return True
    if owns_collection(user, db, d.collection_id):
        return True
    if d.status == "archived" and is_author(user, db):
        return True
    return False


def visible_pages(rows: Iterable[models.KbDocument], user: dict, db: Session) -> list[models.KbDocument]:
    rows = wall_rows(rows, user, db)
    if is_manage(user, db):
        return rows
    me = _email(user)
    author = is_author(user, db)
    owned = {c.id for c in db.query(models.KbCollection).filter(models.KbCollection.owner_email == me).all()} if me else set()
    who = _Reader(user, db)
    out = []
    for d in rows:
        if d.status == "approved":
            if may_read(d, user, db, who):   # WP 5.3
                out.append(d)
        elif (d.owner_email or "").lower() == me or (d.reviewer_email or "").lower() == me:
            out.append(d)
        elif d.collection_id in owned:
            out.append(d)
        elif d.status == "archived" and author:
            out.append(d)
    return out


def get_page(db: Session, doc_id: str, user: dict) -> models.KbDocument:
    d = db.query(models.KbDocument).filter(models.KbDocument.id == doc_id).first()
    if not d:
        raise HTTPException(404, "Page not found")
    assert_wall(d, user, db)
    if not can_see_page(d, user, db):
        raise HTTPException(404, "Page not found")
    return d


def can_edit_page(d: models.KbDocument, user: dict, db: Session) -> bool:
    """Edit the page record (a draft's content, or a published page's
    settings / open a revision)."""
    me = _email(user)
    if is_manage(user, db) or owns_collection(user, db, d.collection_id):
        return True
    if not is_author(user, db):
        return False
    return (d.owner_email or "").lower() == me


def assert_edit(d: models.KbDocument, user: dict, db: Session) -> None:
    if not can_edit_page(d, user, db):
        raise HTTPException(403, "You can't edit this page")


def can_approve(d: models.KbDocument, author_email: str, reviewer_email: str, user: dict, db: Session) -> tuple[bool, str]:
    """Second-person approval: the named reviewer, the collection owner or
    Manage - and never the author of the change."""
    me = _email(user)
    if me and me == (author_email or "").lower():
        return False, "You can't approve your own change. Ask the reviewer or the collection owner."
    if me == (reviewer_email or "").lower() and reviewer_email:
        return True, ""
    if owns_collection(user, db, d.collection_id):
        return True, ""
    if is_manage(user, db):
        return True, ""
    return False, "Only the named reviewer, the collection owner or a Knowledge Base manager can approve."


def publishes_directly(page_type: str) -> bool:
    """How-Tos and References go live when an author publishes them; SOPs and
    Policies need a second person."""
    return page_type in ("how_to", "reference")


# ----------------------------------------------------------------- courses

def can_see_course(c: models.KbCourse, user: dict, db: Session, assigned: bool = False) -> bool:
    if is_author(user, db):
        return True
    return c.status == "published"


def get_course(db: Session, course_id: str, user: dict) -> models.KbCourse:
    c = db.query(models.KbCourse).filter(models.KbCourse.id == course_id).first()
    if not c:
        raise HTTPException(404, "Course not found")
    assert_wall(c, user, db)
    if not can_see_course(c, user, db):
        raise HTTPException(404, "Course not found")
    return c


def can_edit_course(c: models.KbCourse, user: dict, db: Session) -> bool:
    if is_manage(user, db):
        return True
    return is_author(user, db) and (c.owner_email or "").lower() == _email(user)


def assert_edit_course(c: models.KbCourse, user: dict, db: Session) -> None:
    if not can_edit_course(c, user, db):
        raise HTTPException(403, "You can't edit this course")


# ----------------------------------------------------------------- people

def display_name(db: Session, email: str) -> str:
    """The person's name from People (the user dict carries no name)."""
    e = (email or "").lower().strip()
    if not e:
        return ""
    emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == e).first()
    if emp:
        n = (emp.display_name or f"{emp.first_name or ''} {emp.last_name or ''}").strip()
        if n:
            return n
    r = db.query(models.NexusRole).filter(models.NexusRole.email == e).first()
    if r and r.display_name:
        return r.display_name
    return e


def manager_of(db: Session, email: str) -> str:
    emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == (email or "").lower()).first()
    return (emp.manager_email or "").lower() if emp else ""


def direct_reports(db: Session, email: str) -> list[models.NexusEmployee]:
    return db.query(models.NexusEmployee).filter(
        models.NexusEmployee.manager_email == (email or "").lower(),
        models.NexusEmployee.status.in_(("onboarding", "active")),
        models.NexusEmployee.deleted_at == "").all()


def reporting_line(db: Session, email: str, depth: int = 6) -> list[models.NexusEmployee]:
    seen: set[str] = set()
    out: list[models.NexusEmployee] = []
    frontier = [(email or "").lower()]
    for _ in range(depth):
        nxt: list[str] = []
        for m in frontier:
            for e in direct_reports(db, m):
                k = (e.work_email or "").lower()
                if k and k not in seen:
                    seen.add(k)
                    out.append(e)
                    nxt.append(k)
        if not nxt:
            break
        frontier = nxt
    return out


def kb_managers(db: Session) -> list[str]:
    """Who hears about things with no owner: manager+ roles."""
    rows = db.query(models.NexusRole).filter(models.NexusRole.role.in_(("manager", "administrator", "owner"))).all()
    return [r.email.lower() for r in rows if r.email]
