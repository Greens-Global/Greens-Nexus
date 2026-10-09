"""Announcements (Essentials, Oct 7) - company / department notices for the
Announcements dashboard tile, with per-person read and acknowledge marks.

Tables: models.Announcement (nexus_announcements) and models.AnnouncementRead
(nexus_announcement_reads). Everyone signed in can list, read and acknowledge;
create / edit / delete and the read-receipt list are administrator-level
(`require_administrator`, the AdminConsole gate).

Who sees what
  - audience 'company'    -> everyone signed in
  - audience 'department' -> people whose nexus_employees.department matches
    (case-insensitive), plus the author, plus administrators (they manage it)
  - Company walls (auth.company_scope): an announcement has no company column,
    so its company is its AUTHOR's (auth.company_of_email_map, the same rule the
    knowledge base and documents use). Walls on -> a scoped caller sees only
    announcements from authors in their own companies; an announcement by an
    untagged author stays org-wide (shared_when_blank). Walls off -> everyone.

Bell notifications
  A new announcement puts one bell notification in front of EACH person in its
  audience (type 'announcement'). The bell's broadcast form (recipient='') is
  manager-only by design, so an employee would never see it - per-person rows
  are the only route to the whole company. Cost: one nexus_notifications row
  per recipient (~180 for a company-wide post), written in the same commit.
  No email or Teams message is sent (ANNOUNCEMENT_EMAIL_ENABLED below).

Body text is PLAIN TEXT with line breaks; the tile renders it pre-wrapped and
React escapes it, so no HTML is accepted or sanitized here.
"""
import re
import uuid
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import case, func
from sqlalchemy.orm import Session

import auth
from auth import get_current_user, require_administrator
from database import get_db
from models import Announcement, AnnouncementRead, NexusEmployee, NexusNotification, NexusRole

router = APIRouter(prefix="", tags=["Announcements"])

# Future company setting (Admin Console > Notifications): also email / Teams
# each new announcement to its audience. Off - the bell is the only channel.
ANNOUNCEMENT_EMAIL_ENABLED = False

TITLE_MAX = 200
BODY_MAX = 20000
LIST_LIMIT = 50
AUDIENCES = ("company", "department")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ── Helpers ──────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today() -> str:
    return date.today().isoformat()


def _person_name(e) -> str:
    """Same rule as routers.myhr._person_name: Teams displayName, then
    first+last, then the email."""
    return (e.display_name or "").strip() or f"{e.first_name or ''} {e.last_name or ''}".strip() or (e.work_email or "")


def _fallback_name(email: str) -> str:
    local = (email or "").split("@", 1)[0]
    return " ".join(p.capitalize() for p in local.replace("_", ".").split(".") if p) or (email or "")


def _people(db: Session) -> dict:
    """{email(lower) -> {name, department, company, status, external}} for every
    employee with a work email - one query serves names, departments, walls
    and the notification audience."""
    out = {}
    for e in db.query(NexusEmployee).filter(NexusEmployee.work_email != "").all():
        em = (e.work_email or "").lower()
        if not em:
            continue
        out[em] = {
            "name": _person_name(e),
            "department": (e.department or "").strip(),
            "company": (e.company or "").strip(),
            "status": (e.status or "active"),
            "external": (e.identity_type or "") in ("guest", "external"),
        }
    return out


def _name_of(people: dict, db: Session, email: str) -> str:
    em = (email or "").lower()
    if em in people and people[em]["name"]:
        return people[em]["name"]
    role = db.query(NexusRole).filter(NexusRole.email == em).first() if em else None
    if role and role.display_name:
        return role.display_name
    return _fallback_name(em)


def _is_pinned(a: Announcement, today: str) -> bool:
    return bool(a.pinned_until) and a.pinned_until >= today


def _can_see(a: Announcement, *, email: str, department: str, is_admin: bool) -> bool:
    if (a.audience or "company") != "department":
        return True
    if is_admin or (a.author_email or "").lower() == email:
        return True
    return bool(department) and (a.department or "").strip().lower() == department.lower()


def _serialize(a: Announcement, *, people: dict, db: Session, mark=None, counts=None, today: str = "") -> dict:
    today = today or _today()
    out = {
        "id": a.id,
        "title": a.title or "",
        "body": a.body or "",
        "author_email": a.author_email or "",
        "author_name": _name_of(people, db, a.author_email),
        "audience": a.audience or "company",
        "department": a.department or "",
        "pinned_until": a.pinned_until or "",
        "pinned": _is_pinned(a, today),
        "requires_ack": bool(a.requires_ack),
        "created_at": a.created_at or "",
        "updated_at": a.updated_at or "",
        "read_at": (mark.read_at if mark else "") or "",
        "acknowledged_at": (mark.acknowledged_at if mark else "") or "",
    }
    if counts is not None:
        out["read_count"], out["ack_count"] = counts
    return out


def _live(db: Session, announcement_id: str) -> Announcement:
    row = db.query(Announcement).filter(Announcement.id == announcement_id).first()
    if not row or (row.deleted_at or ""):
        raise HTTPException(status_code=404, detail="Announcement not found")
    return row


def _author_company(people: dict, email: str) -> str:
    return people.get((email or "").lower(), {}).get("company", "")


def _assert_wall(a: Announcement, people: dict, user: dict, db: Session) -> None:
    """404 (never 403) when the caller's company wall does not admit this
    announcement - an untagged author's post is shared org-wide."""
    auth.assert_company(_author_company(people, a.author_email), user, db, shared_when_blank=True)


# ── Validation ───────────────────────────────────────────────────────────────

def _bad(msg: str):
    return HTTPException(status_code=422, detail=msg)


def _text(body: dict, key: str) -> str:
    v = body.get(key, "")
    if v is None:
        return ""
    if not isinstance(v, str):
        raise _bad(f"{key} must be text.")
    return v


def _validate(body: dict, current: Announcement | None = None) -> dict:
    """The writable fields, checked. On a PATCH only the keys present are
    returned, so a partial update never blanks the rest."""
    if not isinstance(body, dict):
        raise _bad("Expected a JSON object.")
    patch = current is not None
    out = {}

    if not patch or "title" in body:
        title = _text(body, "title").strip()
        if not title:
            raise _bad("Title is required.")
        if len(title) > TITLE_MAX:
            raise _bad(f"Title must be {TITLE_MAX} characters or fewer.")
        out["title"] = title

    if not patch or "body" in body:
        text = _text(body, "body").replace("\r\n", "\n").strip()
        if not text:
            raise _bad("Body is required.")
        if len(text) > BODY_MAX:
            raise _bad(f"Body must be {BODY_MAX} characters or fewer.")
        out["body"] = text

    if not patch or "audience" in body or "department" in body:
        audience = (_text(body, "audience") or (current.audience if current else "") or "company").strip().lower()
        if audience not in AUDIENCES:
            raise _bad("Audience must be 'company' or 'department'.")
        if "department" in body:
            department = _text(body, "department").strip()
        else:
            department = (current.department if current else "") or ""
        if audience == "department" and not department:
            raise _bad("Department is required for a department announcement.")
        if len(department) > 120:
            raise _bad("Department must be 120 characters or fewer.")
        out["audience"] = audience
        out["department"] = department if audience == "department" else ""

    if "pinned_until" in body:
        pinned = _text(body, "pinned_until").strip()
        if pinned:
            if not _DATE_RE.match(pinned):
                raise _bad("Pinned until must be a date (YYYY-MM-DD).")
            try:
                date.fromisoformat(pinned)
            except ValueError:
                raise _bad("Pinned until is not a real date.")
        out["pinned_until"] = pinned
    elif not patch:
        out["pinned_until"] = ""

    if "requires_ack" in body:
        v = body.get("requires_ack")
        if isinstance(v, str):
            word = v.strip().lower()
            if word in ("1", "true", "yes", "on"):
                v = True
            elif word in ("0", "false", "no", "off", ""):
                v = False
        if not isinstance(v, (bool, int)):
            raise _bad("Requires acknowledgement must be true or false.")
        out["requires_ack"] = bool(v)
    elif not patch:
        out["requires_ack"] = False

    return out


# ── Notifications ────────────────────────────────────────────────────────────

def _audience_emails(a: Announcement, people: dict, author_scope) -> list[str]:
    """Who a new announcement is for: active internal employees with a work
    email, narrowed to the department for a department post and to the
    author's company wall when the walls are on. The author is skipped."""
    author = (a.author_email or "").lower()
    dept = (a.department or "").strip().lower()
    out = []
    for em, p in people.items():
        if em == author or p["external"] or p["status"] in ("inactive", "offboarded"):
            continue
        if (a.audience or "company") == "department" and p["department"].lower() != dept:
            continue
        if author_scope is not None and not auth.company_ok(p["company"], author_scope, shared_when_blank=True):
            continue
        out.append(em)
    return out


def _notify_audience(db: Session, a: Announcement, people: dict, author_scope, author_name: str) -> int:
    """One bell notification per person in the audience (see module docstring
    for why not a broadcast row). Returns how many were written."""
    recipients = _audience_emails(a, people, author_scope)
    now = _now()
    title = f"Announcement: {a.title}"
    body = (a.body or "")[:280] + ("..." if len(a.body or "") > 280 else "")
    if author_name:
        body = f"{author_name}: {body}"
    for em in recipients:
        db.add(NexusNotification(
            id=str(uuid.uuid4()),
            type="announcement",
            recipient=em,
            title=title,
            body=body,
            ref_id=a.id,
            item_name="",
            requested_by=a.author_email or "",
            action="",
            actioned=False,
            read_by="",
            company=people.get(em, {}).get("company", ""),
            created_at=now,
        ))
    # ANNOUNCEMENT_EMAIL_ENABLED: when a company setting turns it on, hand
    # `recipients` to the mail / Teams sender here. Bell only for now.
    return len(recipients)


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/announcements")
def list_announcements(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Announcements the caller can see (company-wide + their department),
    pinned first, then newest first, each with the caller's read / acknowledged
    state. Administrators also get read / acknowledge counts."""
    email = (user.get("email") or "").lower()
    is_admin = int(user.get("level") or 0) >= 4
    people = _people(db)
    department = people.get(email, {}).get("department", "")
    scope = auth.company_scope(user, db)
    today = _today()

    rows = (db.query(Announcement)
            .filter(Announcement.deleted_at == "")
            .order_by(Announcement.created_at.desc())
            .all())
    rows = [a for a in rows if _can_see(a, email=email, department=department, is_admin=is_admin)]
    if scope is not None:
        rows = [a for a in rows
                if auth.company_ok(_author_company(people, a.author_email), scope, shared_when_blank=True)]
    # Stable: pinned block first, each block newest first (created_at desc).
    rows.sort(key=lambda a: a.created_at or "", reverse=True)
    rows.sort(key=lambda a: 0 if _is_pinned(a, today) else 1)
    rows = rows[:LIST_LIMIT]
    ids = [a.id for a in rows]
    if not ids:
        return []

    marks = {m.announcement_id: m for m in
             db.query(AnnouncementRead)
               .filter(AnnouncementRead.announcement_id.in_(ids), AnnouncementRead.email == email).all()}
    counts = None
    if is_admin:
        counts = {}
        for aid, reads, acks in (
            db.query(AnnouncementRead.announcement_id,
                     func.sum(case((AnnouncementRead.read_at != "", 1), else_=0)),
                     func.sum(case((AnnouncementRead.acknowledged_at != "", 1), else_=0)))
              .filter(AnnouncementRead.announcement_id.in_(ids))
              .group_by(AnnouncementRead.announcement_id).all()):
            counts[aid] = (int(reads or 0), int(acks or 0))
    return [_serialize(a, people=people, db=db, mark=marks.get(a.id),
                       counts=(counts.get(a.id, (0, 0)) if counts is not None else None), today=today)
            for a in rows]


@router.post("/announcements", status_code=201)
def create_announcement(body: dict, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    fields = _validate(body)
    now = _now()
    a = Announcement(id=str(uuid.uuid4()), author_email=(user.get("email") or "").lower(),
                     created_at=now, updated_at=now, deleted_at="", **fields)
    db.add(a)
    people = _people(db)
    author_name = _name_of(people, db, a.author_email)
    _notify_audience(db, a, people, auth.company_scope(user, db), author_name)
    db.commit()
    db.refresh(a)
    return _serialize(a, people=people, db=db, counts=(0, 0))


@router.patch("/announcements/{announcement_id}")
def update_announcement(announcement_id: str, body: dict, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    a = _live(db, announcement_id)
    people = _people(db)
    _assert_wall(a, people, user, db)
    fields = _validate(body, current=a)
    for k, v in fields.items():
        setattr(a, k, v)
    a.updated_at = _now()
    db.commit()
    db.refresh(a)
    email = (user.get("email") or "").lower()
    mark = (db.query(AnnouncementRead)
              .filter(AnnouncementRead.announcement_id == a.id, AnnouncementRead.email == email).first())
    return _serialize(a, people=people, db=db, mark=mark, counts=_counts_for(db, a.id))


def _counts_for(db: Session, announcement_id: str) -> tuple[int, int]:
    marks = db.query(AnnouncementRead).filter(AnnouncementRead.announcement_id == announcement_id).all()
    return (sum(1 for m in marks if m.read_at), sum(1 for m in marks if m.acknowledged_at))


@router.delete("/announcements/{announcement_id}")
def delete_announcement(announcement_id: str, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    """Soft delete: the row and its read marks stay; the list hides it."""
    a = _live(db, announcement_id)
    _assert_wall(a, _people(db), user, db)
    a.deleted_at = _now()
    a.updated_at = a.deleted_at
    db.commit()
    return {"ok": True, "id": a.id, "deleted_at": a.deleted_at}


def _upsert_mark(db: Session, a: Announcement, email: str, *, ack: bool) -> AnnouncementRead:
    now = _now()
    mark = (db.query(AnnouncementRead)
              .filter(AnnouncementRead.announcement_id == a.id, AnnouncementRead.email == email).first())
    if not mark:
        mark = AnnouncementRead(id=str(uuid.uuid4()), announcement_id=a.id, email=email, read_at=now, acknowledged_at="")
        db.add(mark)
    if not mark.read_at:
        mark.read_at = now
    if ack and not mark.acknowledged_at:
        mark.acknowledged_at = now
    db.commit()
    db.refresh(mark)
    return mark


@router.post("/announcements/{announcement_id}/read")
def mark_announcement_read(announcement_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    a = _live(db, announcement_id)
    people = _people(db)
    _assert_wall(a, people, user, db)
    mark = _upsert_mark(db, a, (user.get("email") or "").lower(), ack=False)
    return {"id": a.id, "read_at": mark.read_at, "acknowledged_at": mark.acknowledged_at or ""}


@router.post("/announcements/{announcement_id}/ack")
def acknowledge_announcement(announcement_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Acknowledge (also marks read). Allowed whether or not the announcement
    asks for it - an extra acknowledgement is harmless."""
    a = _live(db, announcement_id)
    people = _people(db)
    _assert_wall(a, people, user, db)
    mark = _upsert_mark(db, a, (user.get("email") or "").lower(), ack=True)
    return {"id": a.id, "read_at": mark.read_at, "acknowledged_at": mark.acknowledged_at}


@router.get("/announcements/{announcement_id}/reads")
def announcement_reads(announcement_id: str, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    """Who has read / acknowledged one announcement (administrators only),
    acknowledged first, then most recent read first."""
    a = _live(db, announcement_id)
    people = _people(db)
    _assert_wall(a, people, user, db)
    marks = (db.query(AnnouncementRead)
               .filter(AnnouncementRead.announcement_id == a.id, AnnouncementRead.read_at != "").all())
    out = [{"email": m.email, "name": _name_of(people, db, m.email),
            "read_at": m.read_at or "", "acknowledged_at": m.acknowledged_at or ""} for m in marks]
    out.sort(key=lambda r: r["read_at"], reverse=True)
    out.sort(key=lambda r: 0 if r["acknowledged_at"] else 1)
    return out
