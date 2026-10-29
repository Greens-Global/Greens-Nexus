"""Knowledge Base API (Oct 2026 rebuild): the Library, writing and
publishing, sign-offs, Start as Task, import, Ask Nexus, Manage > Health.
Training is routers/kb_training.py. Rules live in kb_core / kb_access.

Every route is behind the company wall and the draft rule (kb_access). A
page open writes one view row and nothing else. Reminders are the daily
scan's job (kb_daily), never a GET's.
"""
from __future__ import annotations

import json
import re
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

import kb_access
import kb_ai
import kb_audience
import kb_blocks
import kb_core
import kb_media
import kb_search
import models
from auth import get_current_user
from database import SessionLocal, get_db
from kb_access import require_author, require_manage

router = APIRouter(prefix="/kb", tags=["Knowledge Base"], dependencies=[Depends(get_current_user)])

PAGE_TYPES = kb_core.PAGE_TYPES
_IMG_MARK = re.compile(r"\[\[IMG(\d+)\]\]")


# ----------------------------------------------------------------- payloads

class PageCreate(BaseModel):
    title: str
    page_type: str = "how_to"
    collection_id: str = ""
    summary: str = ""
    blocks: Optional[dict] = None
    tags: Optional[list] = None
    reviewer_email: str = ""
    template: str = ""          # blank | how_to | sop | policy | reference
    original_content: str = ""  # the raw import text, kept forever
    original_title: str = ""


class PageUpdate(BaseModel):
    """Partial: only the fields sent change. `rev` = the updated_at the
    screen read; a stale one is a 409, never an overwrite."""
    rev: Optional[str] = None
    title: Optional[str] = None
    summary: Optional[str] = None
    blocks: Optional[dict] = None
    page_type: Optional[str] = None
    collection_id: Optional[str] = None
    tags: Optional[list] = None
    owner_email: Optional[str] = None
    reviewer_email: Optional[str] = None
    review_every_months: Optional[int] = None
    require_ack: Optional[bool] = None
    audience: Optional[dict] = None
    signing: Optional[str] = None
    related_ids: Optional[list] = None
    effective_date: Optional[str] = None


class RevisionUpdate(BaseModel):
    rev: Optional[str] = None
    title: Optional[str] = None
    summary: Optional[str] = None
    blocks: Optional[dict] = None
    change_kind: Optional[str] = None
    change_note: Optional[str] = None
    reviewer_email: Optional[str] = None


class ReviewIn(BaseModel):
    decision: str            # approve | request_changes
    note: str = ""


class SubmitIn(BaseModel):
    reviewer_email: str = ""
    change_kind: str = ""
    change_note: str = ""


class CommentIn(BaseModel):
    text: str


class FlagIn(BaseModel):
    text: str


class ResolveIn(BaseModel):
    resolution: str = ""


class SignIn(BaseModel):
    typed_name: str


class FeedbackIn(BaseModel):
    helpful: bool


class CollectionIn(BaseModel):
    name: Optional[str] = None
    parent_id: Optional[str] = None
    department: Optional[str] = None
    description: Optional[str] = None
    owner_email: Optional[str] = None
    review_every_months: Optional[int] = None
    reading_order: Optional[list] = None
    sort_order: Optional[int] = None
    active: Optional[bool] = None


class StartTaskIn(BaseModel):
    title: str = ""
    assignee_email: str = ""
    due_on: str = ""
    priority: str = "medium"
    project_id: str = ""
    note: str = ""
    recurrence: Optional[dict] = None


class AskIn(BaseModel):
    question: str


class ImportIn(BaseModel):
    text: str
    title: str = ""
    source_name: str = ""
    images: Optional[dict] = None    # {"1": "data:image/png;base64,..."}
    page_type: str = ""


class SuggestIn(BaseModel):
    instruction: str
    blocks: Optional[dict] = None


class TranslateIn(BaseModel):
    lang: str


class RequestIn(BaseModel):
    query: str
    note: str = ""
    collection_id: str = ""


class MediaIn(BaseModel):
    data: str
    folder: str = "pages"


class TagIn(BaseModel):
    name: str


class NudgeIn(BaseModel):
    emails: Optional[list] = None


# ----------------------------------------------------------------- helpers

def _clean_blocks(blocks) -> dict:
    return kb_blocks.sanitize(blocks, image_ok=kb_media.is_storage_url)


def _name(db: Session, email: str) -> str:
    return kb_access.display_name(db, email)


def _tags(d: models.KbDocument) -> list[str]:
    return [t.strip() for t in (d.tags or "").split(",") if t.strip()]


def _collection(db: Session, cid: str):
    return db.query(models.KbCollection).filter(models.KbCollection.id == cid).first() if cid else None


def _collection_path(db: Session, cid: str) -> list[dict]:
    out = []
    c = _collection(db, cid)
    hops = 0
    while c and hops < 4:
        out.insert(0, {"id": c.id, "name": c.name})
        c = _collection(db, c.parent_id) if c.parent_id else None
        hops += 1
    return out


def _open_revision(db: Session, doc_id: str):
    return db.query(models.KbRevision).filter(models.KbRevision.doc_id == doc_id,
                                              models.KbRevision.status.in_(("draft", "in_review", "changes_requested"))).first()


def _page_card(db: Session, d: models.KbDocument, user: dict, pins: set | None = None) -> dict:
    rs = kb_core.review_state(db, d)
    rev = _open_revision(db, d.id)
    return {
        "id": d.id, "code": d.doc_code or "", "title": d.title, "summary": d.summary or "",
        "page_type": d.page_type or "how_to", "type_label": kb_core.PAGE_TYPE_LABEL.get(d.page_type or "how_to", "Page"),
        "status": d.status, "version": d.version or "", "collection_id": d.collection_id or "",
        "collection": _collection_path(db, d.collection_id), "owner_email": (d.owner_email or "").lower(),
        "owner_name": d.owner_name or _name(db, d.owner_email), "reviewer_email": (d.reviewer_email or "").lower(),
        "reviewer_name": (d.reviewer_name or _name(db, d.reviewer_email)) if d.reviewer_email else "",
        "verified_by_name": _name(db, d.verified_by) if d.verified_by else "",
        "tags": _tags(d), "verified_at": d.verified_at or "", "verified_by": d.verified_by or "",
        "updated_at": d.updated_at or "", "published_at": d.published_at or "", "views": int(d.views or 0),
        "require_ack": bool(d.require_ack), "stale": rs["stale"], "next_review": rs["next_review"],
        "pinned": (pins is not None and d.id in pins), "pending_revision": rev.status if rev else "",
        "reading_minutes": kb_blocks.reading_minutes(kb_blocks.loads(d.blocks)) if d.blocks else 1,
    }


def _versions(db: Session, d: models.KbDocument) -> list[dict]:
    rows = db.query(models.KbPageVersion).filter(models.KbPageVersion.doc_id == d.id).all()
    rows.sort(key=lambda v: (v.major or 0, v.minor or 0, v.published_at or ""), reverse=True)
    return [{"id": v.id, "version": v.version, "published_at": v.published_at, "change_kind": v.change_kind,
             "change_note": v.change_note or "", "author_email": v.author_email, "author_name": _name(db, v.author_email),
             "approved_by": v.approved_by, "approved_by_name": _name(db, v.approved_by) if v.approved_by else ""} for v in rows]


def _translations_meta(d: models.KbDocument) -> list[dict]:
    try:
        t = json.loads(d.translations or "{}")
    except ValueError:
        t = {}
    out = []
    for lang, v in (t or {}).items():
        if isinstance(v, dict):
            out.append({"lang": lang, "version": v.get("version") or "", "outdated": (v.get("version") or "") != (d.version or ""), "at": v.get("at") or ""})
    return out


def _page_full(db: Session, d: models.KbDocument, user: dict) -> dict:
    me = (user["email"] or "").lower()
    pins = {p.doc_id for p in db.query(models.KbPin).filter(models.KbPin.user_email == me).all()}
    card = _page_card(db, d, user, pins)
    blocks = kb_blocks.loads(d.blocks) if d.blocks else None
    legacy_only = blocks is None
    if legacy_only:
        # not migrated yet: convert on the fly for reading (never written back)
        try:
            body = json.loads(d.body or "{}")
        except ValueError:
            body = {}
        blocks, _n = kb_blocks.from_guided(body, resolve_image=lambda r: kb_media.resolve_legacy(r) if kb_media.configured() else "", title=d.title)
    fb = db.query(models.KbFeedback).filter(models.KbFeedback.doc_id == d.id).all()
    mine = next((f for f in fb if (f.user_email or "").lower() == me), None)
    rev = _open_revision(db, d.id)
    can_edit = kb_access.can_edit_page(d, user, db)
    courses = []
    for c in db.query(models.KbCourse).filter(models.KbCourse.status == "published").all():
        if any(L.get("docId") == d.id for L in kb_core.lessons_of(c)):
            courses.append({"id": c.id, "title": c.title, "code": c.course_code or ""})
    tasks = db.query(models.KbTaskLink).filter(models.KbTaskLink.doc_id == d.id).all()
    related = []
    for rid in [r.strip() for r in (d.related_ids or "").split(",") if r.strip()]:
        r = db.query(models.KbDocument).filter(models.KbDocument.id == rid, models.KbDocument.status == "approved").first()
        if r:
            related.append({"id": r.id, "title": r.title, "code": r.doc_code or "", "page_type": r.page_type or ""})
    embeds = {}
    for eid in kb_blocks.embedded_page_ids(blocks):
        e = db.query(models.KbDocument).filter(models.KbDocument.id == eid).first()
        if e and e.status == "approved":
            embeds[eid] = {"id": e.id, "title": e.title, "code": e.doc_code or "", "summary": e.summary or ""}
    card.update({
        "blocks": blocks, "headings": kb_blocks.headings(blocks), "legacy_only": legacy_only,
        "effective_date": d.effective_date or "", "review_every_months": kb_core.review_months(db, d),
        "review": kb_core.review_state(db, d), "signing": d.signing or "in_page",
        "audience": kb_audience.loads(d.audience) if d.audience else {"everyone": True},
        "audience_text": kb_audience.describe(kb_audience.loads(d.audience), db) if d.audience else "Everyone",
        "signoff": kb_core.signoff_state(db, d, me),
        "feedback": {"helpful": sum(1 for f in fb if f.helpful), "not_helpful": sum(1 for f in fb if not f.helpful),
                     "mine": (None if not mine else bool(mine.helpful))},
        "versions": _versions(db, d), "translations": _translations_meta(d),
        "used_in_courses": courses, "task_runs": len(tasks),
        "related": related, "embeds": embeds, "steps": kb_blocks.step_list(blocks),
        "can_edit": can_edit, "can_review": False,
        "open_revision": ({"id": rev.id, "status": rev.status, "author_email": rev.author_email, "author_name": _name(db, rev.author_email),
                           "change_kind": rev.change_kind, "updated_at": rev.updated_at, "reviewer_email": rev.reviewer_email} if rev and can_edit else None),
        "has_original": bool(d.original_content), "comments": _comments(db, d),
        "can_start_task": d.page_type == "sop" and d.status == "approved" and bool(kb_blocks.step_list(blocks)),
    })
    if d.status == "in_review":
        ok, _why = kb_access.can_approve(d, d.owner_email, d.reviewer_email, user, db)
        card["can_review"] = ok
    return card


def _comments(db: Session, d: models.KbDocument) -> list[dict]:
    rows = db.query(models.KbComment).filter(models.KbComment.doc_id == d.id).order_by(models.KbComment.created_at).all()
    return [{"id": c.id, "author_email": c.author_email, "author_name": c.author_name or _name(db, c.author_email),
             "text": c.text, "created_at": c.created_at} for c in rows]


def _record_view(db: Session, d: models.KbDocument, email: str) -> None:
    day = kb_core.today()
    row = db.query(models.KbView).filter(models.KbView.doc_id == d.id, models.KbView.user_email == email, models.KbView.day == day).first()
    if row:
        row.count = (row.count or 0) + 1
    else:
        db.add(models.KbView(id=kb_core.new_id("vw"), doc_id=d.id, user_email=email, day=day, count=1))
    d.views = (d.views or 0) + 1
    db.commit()


def _published(db: Session, user: dict) -> list[models.KbDocument]:
    rows = db.query(models.KbDocument).filter(models.KbDocument.status == "approved").all()
    return kb_access.wall_rows(rows, user, db)


def _check_rev(row, rev: Optional[str]) -> None:
    if rev is not None and rev != "" and (row.updated_at or "") != rev:
        raise HTTPException(409, "Someone else saved this page since you opened it. Reload to see their changes.")


def _set_reviewer(db: Session, d: models.KbDocument, email: str) -> None:
    d.reviewer_email = (email or "").lower()
    d.reviewer_name = _name(db, d.reviewer_email) if d.reviewer_email else ""


def _me_info(db: Session, user: dict) -> dict:
    me = (user["email"] or "").lower()
    owned = [c.id for c in db.query(models.KbCollection).filter(models.KbCollection.owner_email == me).all()]
    author = kb_access.is_author(user, db)
    return {"email": me, "name": _name(db, me), "can_author": author,
            "can_manage": kb_access.is_manage(user, db), "owned_collections": owned, "ai": kb_ai.available(),
            "storage": kb_media.configured(), "review_count": len(_review_queue(db, user)) if author else 0}


# ----------------------------------------------------------------- me / home

@router.get("/me")
def me(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _me_info(db, user)


@router.get("/home")
def home(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me_ = (user["email"] or "").lower()
    pub = _published(db, user)
    pins = {p.doc_id for p in db.query(models.KbPin).filter(models.KbPin.user_email == me_).all()}
    by_id = {d.id: d for d in pub}
    # waiting on you: policies to sign, training due
    policies = []
    for d in pub:
        if d.require_ack:
            st = kb_core.signoff_state(db, d, me_)
            if st["required"] and not st["signed"]:
                policies.append({**_page_card(db, d, user, pins), "due": st["due"], "overdue_days": st["overdue_days"]})
    from routers import kb_training
    training = kb_training.my_training_summary(db, me_)
    # collections with counts and health
    cols = db.query(models.KbCollection).filter(models.KbCollection.active.is_(True)).order_by(models.KbCollection.sort_order, models.KbCollection.name).all()
    counts: dict[str, int] = {}
    stale: dict[str, int] = {}
    for d in pub:
        counts[d.collection_id] = counts.get(d.collection_id, 0) + 1
        if kb_core.review_state(db, d)["stale"]:
            stale[d.collection_id] = stale.get(d.collection_id, 0) + 1
    parent_of = {c.id: c.parent_id for c in cols}

    def rollup(cid: str, m: dict) -> int:
        n = m.get(cid, 0)
        for c in cols:
            if c.parent_id == cid:
                n += rollup(c.id, m)
        return n
    collections = [{"id": c.id, "name": c.name, "parent_id": c.parent_id, "department": c.department,
                    "owner_email": c.owner_email, "owner_name": c.owner_name or _name(db, c.owner_email),
                    "description": c.description or "", "pages": rollup(c.id, counts), "stale": rollup(c.id, stale),
                    "review_every_months": c.review_every_months} for c in cols if c.id not in parent_of or True]
    recent = sorted(pub, key=lambda d: d.published_at or d.updated_at or "", reverse=True)[:8]
    mine = [d for d in kb_access.visible_pages(db.query(models.KbDocument).filter(models.KbDocument.status.in_(kb_access.DRAFT_STATES)).all(), user, db)
            if (d.owner_email or "").lower() == me_ or (d.reviewer_email or "").lower() == me_]
    my_revs = db.query(models.KbRevision).filter(models.KbRevision.author_email == me_, models.KbRevision.status.in_(("draft", "changes_requested"))).all()
    waiting_reviews = _review_queue(db, user)
    return {
        "me": _me_info(db, user),
        "waiting": {"policies": policies, "training": training["due"], "reviews": waiting_reviews[:6]},
        "collections": collections,
        "pinned": [_page_card(db, by_id[i], user, pins) for i in pins if i in by_id],
        "recent": [_page_card(db, d, user, pins) for d in recent],
        "my_drafts": [_page_card(db, d, user, pins) for d in mine] + [
            {"id": r.doc_id, "revision_id": r.id, "title": r.title or (by_id[r.doc_id].title if r.doc_id in by_id else "Revision"),
             "status": r.status, "page_type": by_id[r.doc_id].page_type if r.doc_id in by_id else "", "is_revision": True,
             "updated_at": r.updated_at} for r in my_revs],
        "counts": {"published": len(pub), "collections": len(cols)},
    }


def _review_queue(db: Session, user: dict) -> list[dict]:
    """Pages and revisions waiting for THIS person's approval."""
    me_ = (user["email"] or "").lower()
    out = []
    for d in kb_access.visible_pages(db.query(models.KbDocument).filter(models.KbDocument.status == "in_review").all(), user, db):
        ok, _w = kb_access.can_approve(d, d.owner_email, d.reviewer_email, user, db)
        if ok:
            out.append({**_page_card(db, d, user), "kind": "page", "author_email": d.owner_email, "author_name": d.owner_name or _name(db, d.owner_email),
                        "submitted_at": d.updated_at, "mine": (d.reviewer_email or "").lower() == me_})
    for r in db.query(models.KbRevision).filter(models.KbRevision.status == "in_review").all():
        d = db.query(models.KbDocument).filter(models.KbDocument.id == r.doc_id).first()
        if not d:
            continue
        try:
            kb_access.assert_wall(d, user, db)
        except HTTPException:
            continue
        ok, _w = kb_access.can_approve(d, r.author_email, r.reviewer_email, user, db)
        if ok:
            out.append({**_page_card(db, d, user), "kind": "revision", "revision_id": r.id, "author_email": r.author_email,
                        "author_name": r.author_name or _name(db, r.author_email), "submitted_at": r.submitted_at,
                        "change_kind": r.change_kind, "change_note": r.change_note, "mine": (r.reviewer_email or "").lower() == me_})
    out.sort(key=lambda x: (not x["mine"], x.get("submitted_at") or ""))
    return out


# ----------------------------------------------------------------- search / ask

@router.get("/search")
def search(q: str = "", type: str = "", collection: str = "", limit: int = 30,
           user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    q = (q or "").strip()
    pub = _published(db, user)
    if collection:
        ids = {collection} | {c.id for c in db.query(models.KbCollection).filter(models.KbCollection.parent_id == collection).all()}
        pub = [d for d in pub if d.collection_id in ids]
    if type and type in PAGE_TYPES:
        pub = [d for d in pub if (d.page_type or "how_to") == type]
    if not q:
        pub.sort(key=lambda d: d.published_at or "", reverse=True)
        return {"results": [_page_card(db, d, user) for d in pub[:limit]], "also_matched": [], "did_you_mean": "", "total": len(pub)}
    cands = kb_search.pg_candidates(db, q)
    if cands is not None and cands:
        cset = set(cands)
        ranked_pool = [d for d in pub if d.id in cset] or pub
    else:
        ranked_pool = pub
    res = kb_search.search(db, ranked_pool, q, limit=limit)
    by_id = {d.id: d for d in pub}
    pins = {p.doc_id for p in db.query(models.KbPin).filter(models.KbPin.user_email == user["email"].lower()).all()}
    results = []
    for r in res["results"]:
        d = by_id.get(r["id"])
        if d:
            results.append({**_page_card(db, d, user, pins), "snippet": r["snippet"], "score": r["score"]})
    kb_search.log_miss(db, q, len(results), user["email"].lower())
    db.commit()
    return {"results": results, "also_matched": res["also_matched"], "did_you_mean": res["did_you_mean"], "total": len(results)}


@router.post("/ask")
def ask(body: AskIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    q = (body.question or "").strip()
    if not q:
        raise HTTPException(422, "Ask something")
    pub = _published(db, user)
    res = kb_search.search(db, pub, q, limit=5)
    by_id = {d.id: d for d in pub}
    pages = []
    for r in res["results"][:5]:
        d = by_id[r["id"]]
        pages.append({"id": d.id, "code": d.doc_code or "", "title": d.title, "version": d.version or "", "verified_at": d.verified_at or "",
                      "text": d.content_text or kb_blocks.plain_text(kb_blocks.loads(d.blocks))})
    sources = [{"id": p["id"], "code": p["code"], "title": p["title"], "version": p["version"], "verified_at": p["verified_at"]} for p in pages]
    if not kb_ai.available():
        return {"answer": "", "sources": sources[:3], "grounded": False, "offline": True}
    try:
        out = kb_ai.answer(q, pages)
    except kb_ai.AiError as e:
        return {"answer": "", "sources": sources[:3], "grounded": False, "offline": True, "error": str(e)}
    used = [s for s in sources if s["id"] in out["sources"]] or sources[:3]
    return {"answer": out["answer"], "sources": used, "grounded": out["grounded"], "offline": False}


# ----------------------------------------------------------------- collections

@router.get("/collections")
def list_collections(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    cols = db.query(models.KbCollection).order_by(models.KbCollection.sort_order, models.KbCollection.name).all()
    pub = _published(db, user)
    counts: dict[str, int] = {}
    for d in pub:
        counts[d.collection_id] = counts.get(d.collection_id, 0) + 1
    return [{"id": c.id, "name": c.name, "parent_id": c.parent_id, "department": c.department, "description": c.description or "",
             "owner_email": c.owner_email, "owner_name": c.owner_name or _name(db, c.owner_email), "review_every_months": c.review_every_months,
             "reading_order": json.loads(c.reading_order or "[]"), "sort_order": c.sort_order, "active": bool(c.active),
             "pages": counts.get(c.id, 0)} for c in cols]


@router.get("/collections/{cid}")
def get_collection(cid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    c = _collection(db, cid)
    if not c:
        raise HTTPException(404, "Collection not found")
    pub = _published(db, user)
    children = db.query(models.KbCollection).filter(models.KbCollection.parent_id == cid, models.KbCollection.active.is_(True)).order_by(models.KbCollection.sort_order, models.KbCollection.name).all()
    child_ids = {x.id for x in children}
    pins = {p.doc_id for p in db.query(models.KbPin).filter(models.KbPin.user_email == user["email"].lower()).all()}
    pages = [d for d in pub if d.collection_id == cid]
    order = json.loads(c.reading_order or "[]")
    rank = {pid: i for i, pid in enumerate(order)}
    pages.sort(key=lambda d: (rank.get(d.id, 10**6), (d.title or "").lower()))
    drafts = [d for d in kb_access.visible_pages(db.query(models.KbDocument).filter(models.KbDocument.collection_id == cid, models.KbDocument.status != "approved").all(), user, db)]
    return {
        "id": c.id, "name": c.name, "parent": _collection_path(db, c.parent_id) if c.parent_id else [], "department": c.department,
        "description": c.description or "", "owner_email": c.owner_email, "owner_name": c.owner_name or _name(db, c.owner_email),
        "review_every_months": c.review_every_months, "reading_order": order, "can_edit": kb_access.is_manage(user, db) or kb_access.owns_collection(user, db, cid),
        "children": [{"id": x.id, "name": x.name, "pages": sum(1 for d in pub if d.collection_id == x.id), "owner_name": x.owner_name or _name(db, x.owner_email)} for x in children],
        "pages": [_page_card(db, d, user, pins) for d in pages],
        "drafts": [_page_card(db, d, user, pins) for d in drafts],
        "child_pages": sum(1 for d in pub if d.collection_id in child_ids),
    }


@router.post("/collections", status_code=201)
def create_collection(body: CollectionIn, user: dict = Depends(require_manage), db: Session = Depends(get_db)):
    if not (body.name or "").strip():
        raise HTTPException(422, "A collection needs a name")
    c = models.KbCollection(id=kb_core.new_id("col"), name=body.name.strip()[:120], parent_id=body.parent_id or "",
                            department=(body.department or "") if not body.parent_id else "", description=(body.description or "")[:500],
                            owner_email=(body.owner_email or "").lower(), owner_name=_name(db, body.owner_email) if body.owner_email else "",
                            review_every_months=int(body.review_every_months or 12), reading_order="[]",
                            sort_order=int(body.sort_order or 0), active=True, created_by=user["email"].lower(),
                            created_at=kb_core.now(), updated_at=kb_core.now())
    db.add(c)
    db.commit()
    return get_collection(c.id, user, db)


@router.patch("/collections/{cid}")
def update_collection(cid: str, body: CollectionIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    c = _collection(db, cid)
    if not c:
        raise HTTPException(404, "Collection not found")
    if not (kb_access.is_manage(user, db) or kb_access.owns_collection(user, db, cid)):
        raise HTTPException(403, "Only the collection owner or a Knowledge Base manager can change this")
    if body.name is not None and body.name.strip():
        c.name = body.name.strip()[:120]
    if body.description is not None:
        c.description = body.description[:500]
    if body.owner_email is not None:
        c.owner_email = body.owner_email.lower()
        c.owner_name = _name(db, c.owner_email) if c.owner_email else ""
    if body.review_every_months is not None:
        c.review_every_months = max(1, int(body.review_every_months))
    if body.reading_order is not None:
        c.reading_order = json.dumps([str(x) for x in body.reading_order][:500])
    if body.sort_order is not None:
        c.sort_order = int(body.sort_order)
    if body.active is not None and kb_access.is_manage(user, db):
        c.active = bool(body.active)
    if body.parent_id is not None and kb_access.is_manage(user, db):
        c.parent_id = body.parent_id
    if body.department is not None and kb_access.is_manage(user, db):
        c.department = body.department
    c.updated_at = kb_core.now()
    db.commit()
    return get_collection(c.id, user, db)


@router.get("/tags")
def list_tags(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.query(models.KbTag).filter(models.KbTag.active.is_(True)).order_by(models.KbTag.sort_order, models.KbTag.name).all()
    used: dict[str, int] = {}
    for d in db.query(models.KbDocument).filter(models.KbDocument.status == "approved").all():
        for t in _tags(d):
            used[t.lower()] = used.get(t.lower(), 0) + 1
    names = {r.name for r in rows}
    out = [{"id": r.id, "name": r.name, "pages": used.get(r.name.lower(), 0)} for r in rows]
    for t, n in used.items():
        if t not in {x.lower() for x in names}:
            out.append({"id": "", "name": t, "pages": n})
    return sorted(out, key=lambda x: (-x["pages"], x["name"]))


@router.post("/tags", status_code=201)
def create_tag(body: TagIn, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    name = (body.name or "").strip().lower()[:40]
    if not name:
        raise HTTPException(422, "A tag needs a name")
    if db.query(models.KbTag).filter(func.lower(models.KbTag.name) == name).first():
        return list_tags(user, db)
    db.add(models.KbTag(id=kb_core.new_id("tag"), name=name, active=True, sort_order=0, created_by=user["email"].lower(), created_at=kb_core.now()))
    db.commit()
    return list_tags(user, db)


# ----------------------------------------------------------------- pages

@router.get("/pages")
def list_pages(status: str = "", type: str = "", collection: str = "", mine: bool = False, q: str = "",
               user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.query(models.KbDocument).all()
    rows = kb_access.visible_pages(rows, user, db)
    me_ = user["email"].lower()
    if status:
        rows = [d for d in rows if d.status == status]
    if type in PAGE_TYPES:
        rows = [d for d in rows if (d.page_type or "how_to") == type]
    if collection:
        rows = [d for d in rows if d.collection_id == collection]
    if mine:
        rows = [d for d in rows if (d.owner_email or "").lower() == me_]
    if q:
        ql = q.lower()
        rows = [d for d in rows if ql in (d.title or "").lower() or ql in (d.doc_code or "").lower()]
    rows.sort(key=lambda d: d.updated_at or "", reverse=True)
    pins = {p.doc_id for p in db.query(models.KbPin).filter(models.KbPin.user_email == me_).all()}
    return [_page_card(db, d, user, pins) for d in rows[:500]]


@router.get("/pages/{doc_id}")
def get_page(doc_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    if d.status == "approved":
        _record_view(db, d, user["email"].lower())
    return _page_full(db, d, user)


@router.get("/pages/{doc_id}/versions/{vid}")
def get_version(doc_id: str, vid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    v = db.query(models.KbPageVersion).filter(models.KbPageVersion.id == vid, models.KbPageVersion.doc_id == d.id).first()
    if not v:
        raise HTTPException(404, "Version not found")
    blocks = kb_blocks.loads(v.blocks)
    return {"id": v.id, "version": v.version, "title": v.title, "summary": v.summary, "blocks": blocks, "published_at": v.published_at,
            "change_kind": v.change_kind, "change_note": v.change_note, "author_name": _name(db, v.author_email),
            "diff": kb_blocks.diff_summary(blocks, kb_blocks.loads(d.blocks))}


@router.get("/pages/{doc_id}/original")
def get_original(doc_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    legacy = None
    if d.body and d.body != "{}":
        try:
            legacy = json.loads(d.body)
        except ValueError:
            legacy = None
    return {"original_title": d.original_title or "", "original_content": d.original_content or "", "legacy_body": legacy,
            "legacy_type": d.doc_type or ""}


def _template_blocks(kind: str, title: str) -> dict:
    if kind == "sop":
        return kb_blocks.doc([
            kb_blocks.heading("Purpose"), kb_blocks.paragraph(""),
            kb_blocks.heading("Before You Start"), kb_blocks.bullet_list(["What you need"]),
            kb_blocks.heading("Steps"), kb_blocks.steps([kb_blocks.step("First step"), kb_blocks.step("Second step")]),
            kb_blocks.heading("Safety"), kb_blocks.callout("safety", [kb_blocks.paragraph("What must never happen.")]),
        ])
    if kind == "policy":
        return kb_blocks.doc([
            kb_blocks.heading("1. Purpose"), kb_blocks.paragraph(""),
            kb_blocks.heading("2. Who It Applies To"), kb_blocks.paragraph(""),
            kb_blocks.heading("3. The Rules"), kb_blocks.bullet_list(["Rule one"]),
            kb_blocks.heading("4. What Happens If"), kb_blocks.paragraph(""),
        ])
    if kind == "reference":
        return kb_blocks.doc([kb_blocks.paragraph("A short line on what this list is for."), kb_blocks.table(["Item", "Value"], [["", ""]])])
    if kind == "how_to":
        return kb_blocks.doc([kb_blocks.paragraph("The short answer in one or two sentences."), kb_blocks.steps([kb_blocks.step("First step")])])
    return kb_blocks.doc()


@router.post("/pages", status_code=201)
def create_page(body: PageCreate, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    title = (body.title or "").strip()
    if not title:
        raise HTTPException(422, "A page needs a title")
    pt = body.page_type if body.page_type in PAGE_TYPES else "how_to"
    blocks = _clean_blocks(body.blocks) if body.blocks else _template_blocks(body.template or pt, title)
    me_ = user["email"].lower()
    d = models.KbDocument(id=kb_core.new_id("kb"), doc_code="", title=title[:300], doc_type={"sop": "SOP", "policy": "SOP", "reference": "Guide", "how_to": "Guide"}[pt],
                          departments="", service="", status="draft", owner_email=me_, owner_name=_name(db, me_),
                          reviewer_email=(body.reviewer_email or "").lower(), reviewer_name=_name(db, body.reviewer_email) if body.reviewer_email else "",
                          version="0.1", effective_date="", body="{}", review_note="", revision_history="[]", require_ack=(pt == "policy"),
                          views=0, review_every_months=0, verified_at="", verified_by="", stale_notified_at="", retention_months=84,
                          tags=",".join(str(t).strip().lower() for t in (body.tags or []) if str(t).strip())[:500], related_ids="", content_text="",
                          created_by=me_, created_at=kb_core.now(), updated_at=kb_core.now(), original_title=(body.original_title or "")[:300],
                          original_content=body.original_content or "", page_type=pt, collection_id=body.collection_id or "",
                          summary=(body.summary or "")[:300], major=0, minor=1, published_at="", audience="", signing="in_page",
                          translations="", migrated_at=kb_core.now())
    kb_core.set_content(d, blocks)
    db.add(d)
    kb_core.event(db, kind="created", actor=me_, doc_id=d.id, version="0.1", actor_name=d.owner_name)
    db.commit()
    return _page_full(db, d, user)


@router.patch("/pages/{doc_id}")
def update_page(doc_id: str, body: PageUpdate, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    kb_access.assert_edit(d, user, db)
    _check_rev(d, body.rev)
    editing_content = body.blocks is not None or body.title is not None or body.summary is not None
    if editing_content and d.status == "approved":
        raise HTTPException(409, "This page is published. Open a revision to change what it says; readers keep the current version until it is approved.")
    if editing_content and d.status == "in_review":
        raise HTTPException(409, "This page is in review. Ask the reviewer to request changes, or withdraw it.")
    me_ = user["email"].lower()
    if body.title is not None and body.title.strip():
        d.title = body.title.strip()[:300]
    if body.summary is not None:
        d.summary = body.summary.strip()[:300]
    if body.blocks is not None:
        kb_core.set_content(d, _clean_blocks(body.blocks))
    if body.page_type in PAGE_TYPES and d.status != "approved":
        d.page_type = body.page_type
    if body.collection_id is not None:
        d.collection_id = body.collection_id
    if body.tags is not None:
        d.tags = ",".join(dict.fromkeys(str(t).strip().lower() for t in body.tags if str(t).strip()))[:500]
    if body.owner_email is not None and (kb_access.is_manage(user, db) or kb_access.owns_collection(user, db, d.collection_id) or (d.owner_email or "").lower() == me_):
        d.owner_email = body.owner_email.lower()
        d.owner_name = _name(db, d.owner_email) if d.owner_email else ""
    if body.reviewer_email is not None:
        _set_reviewer(db, d, body.reviewer_email)
    if body.review_every_months is not None:
        d.review_every_months = max(0, int(body.review_every_months))
    if body.require_ack is not None:
        d.require_ack = bool(body.require_ack)
    if body.audience is not None:
        d.audience = kb_audience.dumps(body.audience) if body.audience else ""
        raw = dict(body.audience or {})
        if raw.get("due_days") or raw.get("renew_months"):
            a = json.loads(d.audience or "{}")
            a["due_days"] = int(raw.get("due_days") or 14)
            a["renew_months"] = int(raw.get("renew_months") or 0)
            d.audience = json.dumps(a, separators=(",", ":"))
    if body.signing in ("in_page", "nexus_sign"):
        d.signing = body.signing
    if body.related_ids is not None:
        d.related_ids = ",".join(str(x) for x in body.related_ids if str(x) and str(x) != d.id)[:2000]
    if body.effective_date is not None:
        d.effective_date = body.effective_date[:10]
    d.updated_at = kb_core.now()
    db.commit()
    return _page_full(db, d, user)


@router.post("/pages/{doc_id}/submit")
def submit_page(doc_id: str, body: SubmitIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A new page (never published) goes to review."""
    d = kb_access.get_page(db, doc_id, user)
    kb_access.assert_edit(d, user, db)
    if d.status not in ("draft", "changes_requested"):
        raise HTTPException(409, "Only a draft can be submitted")
    if body.reviewer_email:
        _set_reviewer(db, d, body.reviewer_email)
    if kb_blocks.is_blank(kb_blocks.loads(d.blocks)):
        raise HTTPException(422, "The page is empty")
    if not d.reviewer_email and not kb_access.collection_owner(db, d.collection_id):
        raise HTTPException(422, "Pick a reviewer, or file the page in a collection that has an owner")
    d.status = "in_review"
    d.updated_at = kb_core.now()
    me_ = user["email"].lower()
    kb_core.event(db, kind="submitted", actor=me_, doc_id=d.id, version=d.version, note=body.change_note or "", actor_name=_name(db, me_))
    who = d.reviewer_email or kb_access.collection_owner(db, d.collection_id)
    kb_core.notify(db, recipient=who, ntype="kb_review_request", title="A Page Is Waiting for Your Review",
                   body=f"{d.title} ({kb_core.PAGE_TYPE_LABEL.get(d.page_type, 'Page')}) from {_name(db, me_)}", ref_id=d.id,
                   item_name=d.title, sub=f"review:{d.id}", requested_by=me_)
    db.commit()
    return _page_full(db, d, user)


@router.post("/pages/{doc_id}/withdraw")
def withdraw_page(doc_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    kb_access.assert_edit(d, user, db)
    if d.status != "in_review":
        raise HTTPException(409, "Not in review")
    d.status = "draft"
    d.updated_at = kb_core.now()
    kb_core.event(db, kind="withdrawn", actor=user["email"], doc_id=d.id, version=d.version)
    db.commit()
    return _page_full(db, d, user)


@router.post("/pages/{doc_id}/publish")
def publish_page(doc_id: str, body: SubmitIn, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    """How-Tos and References go live directly from their author (or any
    manager for any type). SOPs and Policies need /submit + /review."""
    d = kb_access.get_page(db, doc_id, user)
    kb_access.assert_edit(d, user, db)
    if d.status == "approved":
        raise HTTPException(409, "Already published. Open a revision to change it.")
    if not (kb_access.publishes_directly(d.page_type or "how_to") or kb_access.is_manage(user, db)):
        raise HTTPException(403, f"A {kb_core.PAGE_TYPE_LABEL.get(d.page_type, 'page')} needs a second person: submit it for review")
    blocks = kb_blocks.loads(d.blocks)
    if kb_blocks.is_blank(blocks):
        raise HTTPException(422, "The page is empty")
    me_ = user["email"].lower()
    kb_core.publish(db, d, blocks=blocks, title=d.title, summary=d.summary or "", change_kind="major",
                    change_note=body.change_note or "First version", author=me_, approved_by=me_)
    kb_core.event(db, kind="published", actor=me_, doc_id=d.id, version=d.version, note=body.change_note or "", actor_name=_name(db, me_))
    db.commit()
    return _page_full(db, d, user)


@router.post("/pages/{doc_id}/review")
def review_page(doc_id: str, body: ReviewIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    if d.status != "in_review":
        raise HTTPException(409, "This page is not in review")
    ok, why = kb_access.can_approve(d, d.owner_email, d.reviewer_email, user, db)
    if not ok:
        raise HTTPException(403, why)
    me_ = user["email"].lower()
    if body.decision == "approve":
        kb_core.publish(db, d, blocks=kb_blocks.loads(d.blocks), title=d.title, summary=d.summary or "", change_kind="major",
                        change_note=body.note or "First version", author=d.owner_email, approved_by=me_)
        d.review_note = body.note or ""
        kb_core.event(db, kind="published", actor=me_, doc_id=d.id, version=d.version, note=body.note or "", actor_name=_name(db, me_))
        kb_core.notify(db, recipient=d.owner_email, ntype="kb_approved", title="Your Page Was Approved and Published",
                       body=f"{d.title} is live as v{d.version}" + (f". Note: {body.note[:120]}" if body.note else ""), ref_id=d.id,
                       item_name=d.title, sub=f"page:{d.id}", requested_by=me_)
    elif body.decision == "request_changes":
        if not (body.note or "").strip():
            raise HTTPException(422, "Say what needs to change")
        d.status = "changes_requested"
        d.review_note = body.note
        d.updated_at = kb_core.now()
        kb_core.event(db, kind="changes_requested", actor=me_, doc_id=d.id, version=d.version, note=body.note, actor_name=_name(db, me_))
        kb_core.notify(db, recipient=d.owner_email, ntype="kb_changes_requested", title="Changes Requested on Your Page",
                       body=f"{d.title}: {body.note[:200]}", ref_id=d.id, item_name=d.title, sub=f"editor:{d.id}", requested_by=me_)
    else:
        raise HTTPException(422, "decision must be approve or request_changes")
    db.commit()
    return _page_full(db, d, user)


@router.post("/pages/{doc_id}/archive")
def archive_page(doc_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    if not (kb_access.is_manage(user, db) or kb_access.owns_collection(user, db, d.collection_id)):
        raise HTTPException(403, "Only the collection owner or a Knowledge Base manager can archive a page")
    if d.status == "archived":
        return _page_full(db, d, user)
    d.status = "archived"
    d.updated_at = kb_core.now()
    rev = _open_revision(db, d.id)
    if rev:
        rev.status = "discarded"
        rev.updated_at = kb_core.now()
    kb_core.event(db, kind="archived", actor=user["email"], doc_id=d.id, version=d.version)
    db.commit()
    return _page_full(db, d, user)


@router.post("/pages/{doc_id}/restore")
def restore_page(doc_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Back as a DRAFT, never straight to published."""
    d = kb_access.get_page(db, doc_id, user)
    if not (kb_access.is_manage(user, db) or kb_access.owns_collection(user, db, d.collection_id)):
        raise HTTPException(403, "Only the collection owner or a Knowledge Base manager can restore a page")
    if d.status != "archived":
        raise HTTPException(409, "Not archived")
    d.status = "draft"
    d.updated_at = kb_core.now()
    kb_core.event(db, kind="restored", actor=user["email"], doc_id=d.id, version=d.version)
    db.commit()
    return _page_full(db, d, user)


@router.post("/pages/{doc_id}/verify")
def verify_page(doc_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    kb_access.assert_edit(d, user, db)
    if d.status != "approved":
        raise HTTPException(409, "Only a published page can be verified")
    me_ = user["email"].lower()
    d.verified_at = kb_core.today()
    d.verified_by = me_
    d.updated_at = kb_core.now()
    kb_core.event(db, kind="verified", actor=me_, doc_id=d.id, version=d.version, note="Still accurate", actor_name=_name(db, me_))
    db.commit()
    return _page_full(db, d, user)


@router.post("/pages/{doc_id}/pin")
def pin_page(doc_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    me_ = user["email"].lower()
    p = db.query(models.KbPin).filter(models.KbPin.doc_id == d.id, models.KbPin.user_email == me_).first()
    if p:
        db.delete(p)
        pinned = False
    else:
        db.add(models.KbPin(id=kb_core.new_id("pin"), user_email=me_, doc_id=d.id, created_at=kb_core.now()))
        pinned = True
    db.commit()
    return {"pinned": pinned}


@router.post("/pages/{doc_id}/feedback")
def feedback(doc_id: str, body: FeedbackIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    me_ = user["email"].lower()
    f = db.query(models.KbFeedback).filter(models.KbFeedback.doc_id == d.id, func.lower(models.KbFeedback.user_email) == me_).first()
    if f:
        f.helpful = bool(body.helpful)
        f.created_at = kb_core.now()
    else:
        db.add(models.KbFeedback(id=kb_core.new_id("fb"), doc_id=d.id, user_email=me_, helpful=bool(body.helpful), created_at=kb_core.now()))
    db.commit()
    fb = db.query(models.KbFeedback).filter(models.KbFeedback.doc_id == d.id).all()
    return {"helpful": sum(1 for x in fb if x.helpful), "not_helpful": sum(1 for x in fb if not x.helpful), "mine": bool(body.helpful)}


@router.post("/pages/{doc_id}/flag", status_code=201)
def flag_page(doc_id: str, body: FlagIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(422, "Say what is wrong")
    me_ = user["email"].lower()
    f = models.KbFlag(id=kb_core.new_id("flg"), doc_id=d.id, version=d.version or "", user_email=me_, user_name=_name(db, me_),
                      text=text[:2000], status="open", created_at=kb_core.now())
    db.add(f)
    kb_core.event(db, kind="flagged", actor=me_, doc_id=d.id, version=d.version, note=text[:300], actor_name=f.user_name)
    who = d.owner_email or kb_access.collection_owner(db, d.collection_id)
    for r in ([who] if who else kb_access.kb_managers(db)):
        kb_core.notify(db, recipient=r, ntype="kb_flag", title="A Reader Reported a Problem", body=f"{d.title}: {text[:200]}",
                       ref_id=d.id, item_name=d.title, sub=f"page:{d.id}", requested_by=me_, dedupe_today=True)
    db.commit()
    return {"id": f.id, "status": "open"}


@router.get("/pages/{doc_id}/comments")
def list_comments(doc_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    return _comments(db, d)


@router.post("/pages/{doc_id}/comments", status_code=201)
def add_comment(doc_id: str, body: CommentIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(422, "Empty comment")
    me_ = user["email"].lower()
    db.add(models.KbComment(id=kb_core.new_id("cmt"), doc_id=d.id, author_email=me_, author_name=_name(db, me_), text=text[:4000], created_at=kb_core.now()))
    n = db.query(models.KbComment).filter(models.KbComment.doc_id == d.id).count() + 1
    for r in {(d.owner_email or "").lower(), (d.reviewer_email or "").lower()} - {me_, ""}:
        # one bell per page that updates in place: same type + ref today is replaced, not stacked
        prev = db.query(models.NexusNotification).filter(models.NexusNotification.type == "kb_comment", models.NexusNotification.recipient == r,
                                                        models.NexusNotification.ref_id == d.id, models.NexusNotification.actioned.is_(False)).first()
        if prev:
            prev.body = f"{n} comments. Latest from {_name(db, me_)}: {text[:160]}"
            prev.created_at = kb_core.now()
            prev.read_by = ""
        else:
            kb_core.notify(db, recipient=r, ntype="kb_comment", title="New Comment on a Page", body=f"{d.title}: {text[:160]}",
                           ref_id=d.id, item_name=d.title, sub=f"page:{d.id}", requested_by=me_)
    db.commit()
    return _comments(db, d)


# ----------------------------------------------------------------- revisions

def _rev_or_404(db: Session, rid: str) -> models.KbRevision:
    r = db.query(models.KbRevision).filter(models.KbRevision.id == rid).first()
    if not r:
        raise HTTPException(404, "Revision not found")
    return r


def _rev_out(db: Session, r: models.KbRevision, d: models.KbDocument, user: dict) -> dict:
    blocks = kb_blocks.loads(r.blocks)
    live = kb_blocks.loads(d.blocks)
    ok, why = kb_access.can_approve(d, r.author_email, r.reviewer_email, user, db)
    me_ = user["email"].lower()
    return {"id": r.id, "doc_id": d.id, "page": _page_card(db, d, user), "base_version": r.base_version, "title": r.title or d.title,
            "summary": r.summary if r.summary is not None else d.summary, "blocks": blocks, "live_blocks": live, "live_title": d.title,
            "change_kind": r.change_kind, "change_note": r.change_note or "", "status": r.status, "author_email": r.author_email,
            "author_name": r.author_name or _name(db, r.author_email), "reviewer_email": r.reviewer_email,
            "reviewer_name": _name(db, r.reviewer_email) if r.reviewer_email else "", "review_note": r.review_note or "",
            "created_at": r.created_at, "updated_at": r.updated_at, "submitted_at": r.submitted_at,
            "next_version": kb_core.version_str(*kb_core.bump(d.major or 0, d.minor or 0, r.change_kind)),
            "diff": kb_blocks.diff_summary(live, blocks), "can_review": ok and r.status == "in_review", "why_not": "" if ok else why,
            "can_edit": (r.author_email or "").lower() == me_ or kb_access.can_edit_page(d, user, db),
            "requires_review": not kb_access.publishes_directly(d.page_type or "how_to"),
            "resign": bool(d.require_ack) and r.change_kind == "major", "comments": _comments(db, d),
            "headings": kb_blocks.headings(blocks)}


@router.post("/pages/{doc_id}/revisions", status_code=201)
def open_revision(doc_id: str, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    kb_access.assert_edit(d, user, db)
    if d.status != "approved":
        raise HTTPException(409, "Only a published page takes a revision; edit the draft directly")
    r = _open_revision(db, d.id)
    if r:
        return _rev_out(db, r, d, user)
    me_ = user["email"].lower()
    r = models.KbRevision(id=kb_core.new_id("rev"), doc_id=d.id, base_version=d.version or "", title=d.title, summary=d.summary or "",
                          blocks=d.blocks or kb_blocks.dumps(kb_blocks.loads(d.blocks)), change_kind="minor", change_note="", status="draft",
                          author_email=me_, author_name=_name(db, me_), reviewer_email=(d.reviewer_email or "").lower(),
                          created_at=kb_core.now(), updated_at=kb_core.now())
    db.add(r)
    kb_core.event(db, kind="revision_opened", actor=me_, doc_id=d.id, version=d.version, actor_name=r.author_name)
    db.commit()
    return _rev_out(db, r, d, user)


@router.get("/revisions/{rid}")
def get_revision(rid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    r = _rev_or_404(db, rid)
    d = kb_access.get_page(db, r.doc_id, user)
    me_ = user["email"].lower()
    if not (kb_access.can_edit_page(d, user, db) or (r.author_email or "").lower() == me_ or (r.reviewer_email or "").lower() == me_):
        raise HTTPException(404, "Revision not found")
    return _rev_out(db, r, d, user)


@router.patch("/revisions/{rid}")
def update_revision(rid: str, body: RevisionUpdate, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    r = _rev_or_404(db, rid)
    d = kb_access.get_page(db, r.doc_id, user)
    me_ = user["email"].lower()
    if not ((r.author_email or "").lower() == me_ or kb_access.can_edit_page(d, user, db)):
        raise HTTPException(403, "You can't edit this revision")
    if r.status not in ("draft", "changes_requested"):
        raise HTTPException(409, "This revision is in review")
    _check_rev(r, body.rev)
    if body.title is not None and body.title.strip():
        r.title = body.title.strip()[:300]
    if body.summary is not None:
        r.summary = body.summary.strip()[:300]
    if body.blocks is not None:
        r.blocks = kb_blocks.dumps(_clean_blocks(body.blocks))
    if body.change_kind in ("minor", "major"):
        r.change_kind = body.change_kind
    if body.change_note is not None:
        r.change_note = body.change_note[:1000]
    if body.reviewer_email is not None:
        r.reviewer_email = body.reviewer_email.lower()
    r.updated_at = kb_core.now()
    db.commit()
    return _rev_out(db, r, d, user)


@router.post("/revisions/{rid}/submit")
def submit_revision(rid: str, body: SubmitIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    r = _rev_or_404(db, rid)
    d = kb_access.get_page(db, r.doc_id, user)
    me_ = user["email"].lower()
    if not ((r.author_email or "").lower() == me_ or kb_access.can_edit_page(d, user, db)):
        raise HTTPException(403, "You can't submit this revision")
    if r.status not in ("draft", "changes_requested"):
        raise HTTPException(409, "Already in review")
    if body.reviewer_email:
        r.reviewer_email = body.reviewer_email.lower()
    if body.change_kind in ("minor", "major"):
        r.change_kind = body.change_kind
    if body.change_note:
        r.change_note = body.change_note[:1000]
    if kb_blocks.is_blank(kb_blocks.loads(r.blocks)):
        raise HTTPException(422, "The revision is empty")
    if kb_access.publishes_directly(d.page_type or "how_to") and kb_access.can_edit_page(d, user, db):
        return _merge_revision(db, r, d, user, note=r.change_note, approved_by=me_)
    if not r.reviewer_email and not kb_access.collection_owner(db, d.collection_id):
        raise HTTPException(422, "Pick a reviewer")
    r.status = "in_review"
    r.submitted_at = kb_core.now()
    r.updated_at = kb_core.now()
    kb_core.event(db, kind="revision_submitted", actor=me_, doc_id=d.id, version=d.version, note=r.change_note, actor_name=_name(db, me_))
    who = r.reviewer_email or kb_access.collection_owner(db, d.collection_id)
    kb_core.notify(db, recipient=who, ntype="kb_review_request", title="A Revision Is Waiting for Your Review",
                   body=f"{d.title}: {r.change_kind} change from {_name(db, me_)}" + (f" - {r.change_note[:120]}" if r.change_note else ""),
                   ref_id=d.id, item_name=d.title, sub=f"revision:{r.id}", requested_by=me_)
    db.commit()
    return _rev_out(db, r, d, user)


def _merge_revision(db: Session, r: models.KbRevision, d: models.KbDocument, user: dict, *, note: str, approved_by: str) -> dict:
    me_ = user["email"].lower()
    old_major = d.major or 0
    kb_core.publish(db, d, blocks=kb_blocks.loads(r.blocks), title=r.title or d.title, summary=r.summary if r.summary is not None else d.summary,
                    change_kind=r.change_kind, change_note=r.change_note or note or "", author=r.author_email, approved_by=approved_by)
    r.status = "merged"
    r.decided_at = kb_core.now()
    r.decided_by = me_
    r.review_note = note or ""
    r.updated_at = kb_core.now()
    kb_core.event(db, kind="published", actor=me_, doc_id=d.id, version=d.version, note=r.change_note or note or "", actor_name=_name(db, me_))
    if (r.author_email or "").lower() != me_:
        kb_core.notify(db, recipient=r.author_email, ntype="kb_approved", title="Your Revision Was Approved and Published",
                       body=f"{d.title} is now v{d.version}", ref_id=d.id, item_name=d.title, sub=f"page:{d.id}", requested_by=me_)
    # a new MAJOR version of a signed policy asks everyone again
    if d.require_ack and (d.major or 0) != old_major:
        for e in kb_core.policy_audience_emails(db, d):
            kb_core.notify(db, recipient=e, ntype="kb_sign_required", title="A Policy Needs Your Signature Again",
                           body=f"{d.title} changed to v{d.version}" + (f": {r.change_note[:140]}" if r.change_note else ""), ref_id=d.id,
                           item_name=d.title, sub=f"page:{d.id}", requested_by=me_, dedupe_today=True)
    # translations fall out of date automatically (version != current)
    db.commit()
    return _rev_out(db, r, d, user)


@router.post("/revisions/{rid}/review")
def review_revision(rid: str, body: ReviewIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    r = _rev_or_404(db, rid)
    d = kb_access.get_page(db, r.doc_id, user)
    if r.status != "in_review":
        raise HTTPException(409, "This revision is not in review")
    ok, why = kb_access.can_approve(d, r.author_email, r.reviewer_email, user, db)
    if not ok:
        raise HTTPException(403, why)
    me_ = user["email"].lower()
    if body.decision == "approve":
        return _merge_revision(db, r, d, user, note=body.note, approved_by=me_)
    if body.decision == "request_changes":
        if not (body.note or "").strip():
            raise HTTPException(422, "Say what needs to change")
        r.status = "changes_requested"
        r.review_note = body.note
        r.decided_at = kb_core.now()
        r.decided_by = me_
        r.updated_at = kb_core.now()
        kb_core.event(db, kind="changes_requested", actor=me_, doc_id=d.id, version=d.version, note=body.note, actor_name=_name(db, me_))
        kb_core.notify(db, recipient=r.author_email, ntype="kb_changes_requested", title="Changes Requested on Your Revision",
                       body=f"{d.title}: {body.note[:200]}", ref_id=d.id, item_name=d.title, sub=f"editor:{d.id}", requested_by=me_)
        db.commit()
        return _rev_out(db, r, d, user)
    raise HTTPException(422, "decision must be approve or request_changes")


@router.post("/revisions/{rid}/discard")
def discard_revision(rid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    r = _rev_or_404(db, rid)
    d = kb_access.get_page(db, r.doc_id, user)
    me_ = user["email"].lower()
    if not ((r.author_email or "").lower() == me_ or kb_access.can_edit_page(d, user, db)):
        raise HTTPException(403, "You can't discard this revision")
    if r.status == "merged":
        raise HTTPException(409, "Already published")
    r.status = "discarded"
    r.updated_at = kb_core.now()
    kb_core.event(db, kind="revision_discarded", actor=me_, doc_id=d.id, version=d.version)
    db.commit()
    return {"ok": True}


# ----------------------------------------------------------------- sign-offs

def _names_match(typed: str, real: str) -> bool:
    norm = lambda s: re.sub(r"[^a-z]", "", (s or "").lower())  # noqa: E731
    t, r = norm(typed), norm(real)
    if not r or "@" in (real or ""):
        return len(t) >= 3
    return t == r or (len(t) >= 3 and (t in r or r in t))


@router.post("/pages/{doc_id}/sign")
def sign_page(doc_id: str, body: SignIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    if d.status != "approved" or not d.require_ack:
        raise HTTPException(409, "This page does not take signatures")
    if d.signing == "nexus_sign":
        raise HTTPException(409, "This policy is signed through Nexus Sign")
    me_ = user["email"].lower()
    real = _name(db, me_)
    typed = (body.typed_name or "").strip()
    if not _names_match(typed, real):
        raise HTTPException(422, f"Type your full name as it appears in Nexus: {real}")
    if kb_core.signature_for(db, d, me_):
        return kb_core.signoff_state(db, d, me_)
    text = d.content_text or kb_blocks.plain_text(kb_blocks.loads(d.blocks))
    s = models.KbSignature(id=kb_core.new_id("sig"), doc_id=d.id, version=d.version or "", major=d.major or 0, user_email=me_,
                           user_name=real, typed_name=typed[:200], signed_at=kb_core.now(), content_text=text,
                           content_hash=kb_core.content_hash(text), method="in_page")
    db.add(s)
    kb_core.event(db, kind="signed", actor=me_, doc_id=d.id, version=d.version, actor_name=real)
    db.commit()
    return kb_core.signoff_state(db, d, me_)


@router.get("/pages/{doc_id}/signatures")
def list_signatures(doc_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    if not kb_access.can_edit_page(d, user, db):
        raise HTTPException(403, "Only the page's editors see who signed")
    audience = kb_core.policy_audience_emails(db, d)
    sigs = db.query(models.KbSignature).filter(models.KbSignature.doc_id == d.id).all()
    current = {s.user_email: s for s in sigs if s.major == (d.major or 0)}
    older = {}
    for s in sigs:
        if s.major != (d.major or 0):
            older.setdefault(s.user_email, s)
    emps = {(e.work_email or "").lower(): e for e in db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email != "").all()}
    unsigned = []
    for e in sorted(audience):
        if e in current:
            continue
        emp = emps.get(e)
        due = kb_core.signature_due(db, d, emp)
        unsigned.append({"email": e, "name": _name(db, e), "due": due, "overdue_days": max(0, kb_core.days_between(due, kb_core.today())),
                         "signed_older": older[e].version if e in older else "", "department": emp.department if emp else "",
                         "manager_email": (emp.manager_email or "").lower() if emp else ""})
    unsigned.sort(key=lambda x: (-x["overdue_days"], x["name"]))
    return {"version": d.version, "major": d.major, "audience_count": len(audience), "audience_text": kb_audience.describe(kb_audience.loads(d.audience), db) if d.audience else "Everyone",
            "signed": [{"email": s.user_email, "name": s.user_name or _name(db, s.user_email), "typed_name": s.typed_name, "signed_at": s.signed_at,
                        "version": s.version, "method": s.method} for s in sorted(current.values(), key=lambda s: s.signed_at or "", reverse=True)],
            "unsigned": unsigned, "signed_count": len([e for e in audience if e in current]),
            "extra_signers": [{"email": e, "name": s.user_name, "signed_at": s.signed_at} for e, s in current.items() if e not in audience]}


@router.post("/pages/{doc_id}/nudge")
def nudge_signers(doc_id: str, body: NudgeIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    if not kb_access.can_edit_page(d, user, db):
        raise HTTPException(403, "Only the page's editors can nudge")
    me_ = user["email"].lower()
    targets = {e.lower() for e in (body.emails or [])} or kb_core.policy_audience_emails(db, d)
    n = 0
    for e in targets:
        if kb_core.signature_for(db, d, e):
            continue
        if kb_core.notify(db, recipient=e, ntype="kb_sign_required", title="Please Sign a Policy", body=f"{d.title} v{d.version} is waiting for your signature",
                          ref_id=d.id, item_name=d.title, sub=f"page:{d.id}", requested_by=me_, dedupe_today=True, priority=1):
            n += 1
    db.commit()
    return {"nudged": n}


# ----------------------------------------------------------------- start as task

@router.post("/pages/{doc_id}/start-task", status_code=201)
def start_task(doc_id: str, body: StartTaskIn, background_tasks: BackgroundTasks,
               user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    if d.status != "approved":
        raise HTTPException(409, "Only a published page can be started as a task")
    steps_ = kb_blocks.step_list(kb_blocks.loads(d.blocks))
    if not steps_:
        raise HTTPException(422, "This page has no steps")
    from routers import tasks as tasks_router
    me_ = user["email"].lower()
    assignee = (body.assignee_email or me_).lower()
    desc = f"From the Knowledge Base: {d.title} ({d.doc_code or 'no code'}, v{d.version}).\n{(body.note or '').strip()}".strip()
    payload = tasks_router.TaskCreate(title=(body.title or d.title).strip()[:300], description=desc, priority=body.priority if body.priority in ("low", "medium", "high", "urgent") else "medium",
                                      assignee_emails=[assignee], project_id=body.project_id or "", due_on=(body.due_on or "")[:10],
                                      recurrence=body.recurrence or None, tags=["sop", d.doc_code.lower()] if d.doc_code else ["sop"])

    def before_commit(t):
        now = kb_core.now()
        for i, s in enumerate(steps_, start=1):
            title = s["title"][:480]
            if s["photoRequired"]:
                title = f"{title} (photo required)"
            db.add(models.TaskChecklistItem(id=tasks_router.gen_id(), task_id=t.id, title=title, done=False, assignee_email="",
                                            position=float(i), created_at=now, created_by=me_))
        t.checklist_total, t.checklist_done = len(steps_), 0
        db.add(models.KbTaskLink(id=kb_core.new_id("tl"), doc_id=d.id, version=d.version or "", task_id=t.id,
                                 recurring=bool(body.recurrence), created_by=me_, created_at=now))
        kb_core.event(db, kind="task_started", actor=me_, doc_id=d.id, version=d.version, note=f"task {t.id}", actor_name=_name(db, me_))

    out = tasks_router._create_task(payload, background_tasks, user, db, before_commit=before_commit)
    tid = out.get("id") if isinstance(out, dict) else getattr(out, "id", "")
    return {"task_id": tid, "code": out.get("code", "") if isinstance(out, dict) else "", "steps": len(steps_)}


@router.get("/pages/{doc_id}/tasks")
def page_tasks(doc_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    links = db.query(models.KbTaskLink).filter(models.KbTaskLink.doc_id == d.id).order_by(models.KbTaskLink.created_at.desc()).limit(50).all()
    out = []
    for L in links:
        t = db.query(models.Task).filter(models.Task.id == L.task_id).first()
        if not t or t.deleted_at:
            continue
        out.append({"task_id": t.id, "code": t.code, "title": t.title, "status": t.status, "completed": bool(t.completed), "assignee_email": t.assignee_email,
                    "assignee_name": _name(db, t.assignee_email), "due_on": t.due_on, "created_at": L.created_at, "version": L.version,
                    "checklist_done": t.checklist_done or 0, "checklist_total": t.checklist_total or 0, "recurring": bool(L.recurring)})
    runs = db.query(models.KbRun).filter(models.KbRun.doc_id == d.id).order_by(models.KbRun.started_at.desc()).limit(30).all()
    return {"tasks": out, "legacy_runs": [{"id": r.id, "user_name": r.user_name or _name(db, r.user_email), "status": r.status, "started_at": r.started_at,
                                           "completed_at": r.completed_at, "steps_done": len(json.loads(r.steps_done or "[]")), "step_count": r.step_count} for r in runs]}


# ----------------------------------------------------------------- media

@router.post("/media", status_code=201)
def upload_media(body: MediaIn, user: dict = Depends(require_author)):
    try:
        url = kb_media.upload_data_url(body.data, folder=re.sub(r"[^a-z0-9-]", "", (body.folder or "pages").lower()) or "pages")
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    return {"url": url}


# ----------------------------------------------------------------- import / jobs

def _job_out(j: models.KbJob) -> dict:
    try:
        result = json.loads(j.result) if j.result else None
    except ValueError:
        result = None
    return {"id": j.id, "kind": j.kind, "status": j.status, "progress": j.progress, "total": j.total, "error": j.error or "",
            "result": result, "doc_id": j.doc_id, "created_at": j.created_at, "updated_at": j.updated_at}


def _update_job(job_id: str, **fields) -> None:
    db = SessionLocal()
    try:
        j = db.query(models.KbJob).filter(models.KbJob.id == job_id).first()
        if j:
            for k, v in fields.items():
                setattr(j, k, v)
            j.updated_at = kb_core.now()
            db.commit()
    finally:
        db.close()


def _run_import(job_id: str) -> None:
    db = SessionLocal()
    try:
        j = db.query(models.KbJob).filter(models.KbJob.id == job_id).first()
        if not j:
            return
        inp = json.loads(j.input or "{}")
        collections = [{"id": c.id, "name": c.name} for c in db.query(models.KbCollection).filter(models.KbCollection.active.is_(True)).all()]
        tags = [t.name for t in db.query(models.KbTag).all()]
        pages = [(d.id, d.title, d.doc_code) for d in db.query(models.KbDocument).filter(models.KbDocument.status != "archived").all()]
    finally:
        db.close()
    text = inp.get("text") or ""
    images = inp.get("images") or {}
    sections = kb_ai.split_sections(text)
    _update_job(job_id, status="running", total=len(sections) + 1, progress=0)
    # images first, so markers can be swapped for real URLs
    img_urls: dict[str, str] = {}
    for k, data in images.items():
        try:
            img_urls[str(k)] = kb_media.upload_data_url(data, folder="imports")
        except Exception:  # noqa: BLE001
            img_urls[str(k)] = ""
    content: list[dict] = []
    warnings: list[str] = []
    failed: list[dict] = []
    for i, sec in enumerate(sections, start=1):
        pos = f"section {i} of {len(sections)}" if len(sections) > 1 else "the whole"
        try:
            if not kb_ai.available():
                raise kb_ai.AiError("Nexus is not available on this server")
            shots = [v for v in images.values()] if (i == 1 and len(text) < 400 and images) else []
            blocks = kb_ai.format_text(sec["text"], title=inp.get("title") or "", page_type=inp.get("page_type") or "", position=pos, images=shots)
            blocks = kb_blocks.sanitize(blocks, image_ok=lambda u: True)
        except kb_ai.AiError as e:
            warnings.append(f"Section {i} ({sec['title'] or 'untitled'}): {e}. Its text is kept as plain paragraphs.")
            failed.append({"index": i, "title": sec["title"], "reason": str(e)})
            blocks = kb_blocks.from_plain_text(sec["text"])
            if sec["title"]:
                blocks["content"].insert(0, kb_blocks.heading(sec["title"], 2))
        content.extend(blocks.get("content") or [])
        _update_job(job_id, progress=i)
    # swap [[IMG#]] markers
    def fix_images(node: dict) -> None:
        if node.get("type") == "image":
            src = str((node.get("attrs") or {}).get("src") or "")
            m = _IMG_MARK.match(src)
            if m:
                node["attrs"]["src"] = img_urls.get(m.group(1), "")
        if node.get("type") == "step":
            ph = []
            for p in (node.get("attrs") or {}).get("photos") or []:
                m = _IMG_MARK.match(str(p))
                ph.append(img_urls.get(m.group(1), "") if m else p)
            node["attrs"]["photos"] = [p for p in ph if p]
        if node.get("type") == "text" and _IMG_MARK.search(node.get("text") or ""):
            node["text"] = _IMG_MARK.sub("", node["text"])
        for c in node.get("content") or []:
            if isinstance(c, dict):
                fix_images(c)
    docd = {"type": "doc", "content": content}
    fix_images(docd)
    # images the model never placed: appended so none is lost
    placed = set(kb_blocks.image_urls(docd))
    for k, u in img_urls.items():
        if u and u not in placed:
            content.append(kb_blocks.image(u, f"Image {k}"))
    docd = kb_blocks.sanitize(docd, image_ok=kb_media.is_storage_url)
    meta = {}
    try:
        if kb_ai.available():
            meta = kb_ai.suggest_meta(text, collections=collections, tags=tags)
    except kb_ai.AiError as e:
        warnings.append(f"Filing suggestions: {e}")
    # a possible existing page with the same title
    title = (meta.get("title") or inp.get("title") or "").strip().lower()
    match = None
    norm = lambda s: re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()  # noqa: E731
    if title:
        for pid, ptitle, pcode in pages:
            if norm(ptitle) == norm(title) or (len(norm(title)) > 12 and norm(title) in norm(ptitle)):
                match = {"id": pid, "title": ptitle, "code": pcode or ""}
                break
    _update_job(job_id, status="done", progress=len(sections) + 1,
                result=json.dumps({"blocks": docd, "warnings": warnings, "failed_sections": failed, "sections": len(sections),
                                   "suggested": meta, "possible_match": match, "images": len([u for u in img_urls.values() if u])}))


@router.post("/import", status_code=202)
def start_import(body: ImportIn, background_tasks: BackgroundTasks, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(422, "Nothing to import")
    if len(text) > 600000:
        raise HTTPException(413, "That is more than 600,000 characters. Split the file.")
    images = {str(k): v for k, v in (body.images or {}).items() if isinstance(v, str) and v.startswith("data:image")}
    if len(images) > 60:
        raise HTTPException(413, "At most 60 images per import")
    j = models.KbJob(id=kb_core.new_id("job"), kind="import", status="queued", progress=0, total=0,
                     input=json.dumps({"text": text, "title": body.title or "", "source_name": body.source_name or "", "images": images, "page_type": body.page_type or ""}),
                     result="", error="", created_by=user["email"].lower(), created_at=kb_core.now(), updated_at=kb_core.now())
    db.add(j)
    db.commit()
    background_tasks.add_task(_run_import, j.id)
    return _job_out(j)


@router.get("/jobs/{job_id}")
def get_job(job_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    j = db.query(models.KbJob).filter(models.KbJob.id == job_id).first()
    if not j or (j.created_by != user["email"].lower() and not kb_access.is_manage(user, db)):
        raise HTTPException(404, "Job not found")
    return _job_out(j)


@router.post("/pages/{doc_id}/suggest")
def suggest(doc_id: str, body: SuggestIn, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    kb_access.assert_edit(d, user, db)
    if not kb_ai.available():
        raise HTTPException(503, "Nexus is not available on this server")
    blocks = _clean_blocks(body.blocks) if body.blocks else kb_blocks.loads(d.blocks)
    try:
        out = kb_ai.suggestions(blocks, body.instruction or "", title=d.title)
    except kb_ai.AiError as e:
        raise HTTPException(502, str(e))
    return {"suggestions": out}


def _run_translate(job_id: str) -> None:
    db = SessionLocal()
    try:
        j = db.query(models.KbJob).filter(models.KbJob.id == job_id).first()
        if not j:
            return
        inp = json.loads(j.input or "{}")
        d = db.query(models.KbDocument).filter(models.KbDocument.id == j.doc_id).first()
        if not d:
            j.status, j.error = "failed", "Page not found"
            db.commit()
            return
        j.status = "running"
        db.commit()
        try:
            out = kb_ai.translate(kb_blocks.loads(d.blocks), d.title, inp.get("lang") or "")
        except kb_ai.AiError as e:
            j.status, j.error, j.updated_at = "failed", str(e), kb_core.now()
            db.commit()
            return
        try:
            t = json.loads(d.translations or "{}")
        except ValueError:
            t = {}
        t[inp["lang"]] = {"title": out["title"], "blocks": out["blocks"], "version": d.version or "", "at": kb_core.now(), "by": j.created_by}
        d.translations = json.dumps(t, ensure_ascii=False)
        kb_core.event(db, kind="translated", actor=j.created_by, doc_id=d.id, version=d.version, note=kb_ai.LANGS[inp["lang"]])
        j.status, j.progress, j.total, j.updated_at = "done", 1, 1, kb_core.now()
        j.result = json.dumps({"lang": inp["lang"]})
        db.commit()
    finally:
        db.close()


@router.post("/pages/{doc_id}/translate", status_code=202)
def translate_page(doc_id: str, body: TranslateIn, background_tasks: BackgroundTasks, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    kb_access.assert_edit(d, user, db)
    if body.lang not in kb_ai.LANGS:
        raise HTTPException(422, "Spanish (es) or Hindi (hi)")
    if not kb_ai.available():
        raise HTTPException(503, "Nexus is not available on this server")
    j = models.KbJob(id=kb_core.new_id("job"), kind="translate", status="queued", doc_id=d.id, input=json.dumps({"lang": body.lang}),
                     created_by=user["email"].lower(), created_at=kb_core.now(), updated_at=kb_core.now())
    db.add(j)
    db.commit()
    background_tasks.add_task(_run_translate, j.id)
    return _job_out(j)


@router.get("/pages/{doc_id}/translations/{lang}")
def get_translation(doc_id: str, lang: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    d = kb_access.get_page(db, doc_id, user)
    try:
        t = json.loads(d.translations or "{}")
    except ValueError:
        t = {}
    v = t.get(lang)
    if not isinstance(v, dict):
        raise HTTPException(404, "No translation yet")
    return {"lang": lang, "title": v.get("title") or d.title, "blocks": kb_blocks.loads(v.get("blocks")), "version": v.get("version") or "",
            "outdated": (v.get("version") or "") != (d.version or ""), "at": v.get("at") or "", "headings": kb_blocks.headings(kb_blocks.loads(v.get("blocks")))}


# ----------------------------------------------------------------- requests

@router.post("/requests", status_code=201)
def request_page(body: RequestIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    q = (body.query or "").strip()
    if not q:
        raise HTTPException(422, "Say what you were looking for")
    me_ = user["email"].lower()
    r = models.KbPageRequest(id=kb_core.new_id("req"), query=q[:300], note=(body.note or "")[:1000], collection_id=body.collection_id or "",
                             user_email=me_, user_name=_name(db, me_), status="open", created_at=kb_core.now())
    db.add(r)
    who = kb_access.collection_owner(db, body.collection_id) if body.collection_id else ""
    for m in ([who] if who else kb_access.kb_managers(db)):
        kb_core.notify(db, recipient=m, ntype="kb_page_request", title="Someone Needs a Page", body=f"\"{q[:160]}\" from {r.user_name}",
                       ref_id=r.id, item_name=q[:100], sub="health", requested_by=me_, dedupe_today=True)
    db.commit()
    return {"id": r.id, "status": "open"}


# ----------------------------------------------------------------- manage: health, activity, migration

# What the Health screen lists as searches with no good answer. A ticket
# title logged from the ticket form ("searched, then filed anyway") reaches
# administrators only, in Help Signals - collection owners at any company
# read this list, and a ticket title is not theirs to read.
_HEALTH_MISS_SOURCES = ("kb", "help", "ask")


@router.get("/health")
def health(user: dict = Depends(require_author), db: Session = Depends(get_db)):
    me_ = user["email"].lower()
    manage = kb_access.is_manage(user, db)
    owned = {c.id for c in db.query(models.KbCollection).filter(models.KbCollection.owner_email == me_).all()}
    pub = _published(db, user)

    def mine(d: models.KbDocument) -> bool:
        return manage or (d.owner_email or "").lower() == me_ or d.collection_id in owned
    stale = []
    for d in pub:
        rs = kb_core.review_state(db, d)
        if rs["stale"] and mine(d):
            stale.append({**_page_card(db, d, user), "days_overdue": rs["days_overdue"], "next_review": rs["next_review"]})
    stale.sort(key=lambda x: -x["days_overdue"])
    flags = []
    for f in db.query(models.KbFlag).filter(models.KbFlag.status == "open").order_by(models.KbFlag.created_at.desc()).all():
        d = db.query(models.KbDocument).filter(models.KbDocument.id == f.doc_id).first()
        if d and mine(d):
            flags.append({"id": f.id, "doc_id": d.id, "title": d.title, "code": d.doc_code or "", "text": f.text, "user_name": f.user_name or _name(db, f.user_email),
                          "created_at": f.created_at, "version": f.version})
    reqs = [{"id": r.id, "query": r.query, "note": r.note, "user_name": r.user_name, "created_at": r.created_at, "collection_id": r.collection_id}
            for r in db.query(models.KbPageRequest).filter(models.KbPageRequest.status == "open").order_by(models.KbPageRequest.created_at.desc()).all()
            if manage or (r.collection_id in owned)]
    drafts = [_page_card(db, d, user) for d in kb_access.visible_pages(db.query(models.KbDocument).filter(models.KbDocument.status.in_(("draft", "changes_requested"))).all(), user, db) if mine(d)]
    in_review = [_page_card(db, d, user) for d in kb_access.visible_pages(db.query(models.KbDocument).filter(models.KbDocument.status == "in_review").all(), user, db) if mine(d)]
    unmigrated = db.query(models.KbDocument).filter(models.KbDocument.migrated_at == "").count()
    return {
        "stats": {"published": len(pub), "stale": len(stale), "flags": len(flags), "drafts": len(drafts), "in_review": len(in_review),
                  "requests": len(reqs), "unmigrated": unmigrated,
                  "signatures_outstanding": sum(1 for d in pub if d.require_ack for e in kb_core.policy_audience_emails(db, d) if not kb_core.signature_for(db, d, e)) if manage else 0},
        "review_queue": _review_queue(db, user), "stale": stale[:60], "flags": flags[:60], "requests": reqs[:60],
        "misses": kb_search.misses(db, sources=_HEALTH_MISS_SOURCES) if manage or owned else [], "drafts": drafts[:60], "in_review": in_review[:60],
        "activity": activity(limit=40, user=user, db=db),
    }


@router.get("/activity")
def activity(limit: int = Query(60, ge=1, le=300), doc_id: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    q = db.query(models.KbEvent)
    if doc_id:
        kb_access.get_page(db, doc_id, user)
        q = q.filter(models.KbEvent.doc_id == doc_id)
    rows = q.order_by(models.KbEvent.created_at.desc()).limit(limit * 3).all()
    visible = {d.id for d in kb_access.visible_pages(db.query(models.KbDocument).all(), user, db)}
    out = []
    for e in rows:
        if e.doc_id and e.doc_id not in visible:
            continue
        d = db.query(models.KbDocument).filter(models.KbDocument.id == e.doc_id).first() if e.doc_id else None
        c = db.query(models.KbCourse).filter(models.KbCourse.id == e.course_id).first() if e.course_id else None
        out.append({"id": e.id, "kind": e.kind, "version": e.version, "actor_email": e.actor_email, "actor_name": e.actor_name or _name(db, e.actor_email),
                    "note": e.note, "created_at": e.created_at, "doc_id": e.doc_id, "course_id": e.course_id,
                    "title": (d.title if d else (c.title if c else "")), "code": (d.doc_code if d else (c.course_code if c else "")) or ""})
        if len(out) >= limit:
            break
    return out


@router.post("/flags/{fid}/resolve")
def resolve_flag(fid: str, body: ResolveIn, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    f = db.query(models.KbFlag).filter(models.KbFlag.id == fid).first()
    if not f:
        raise HTTPException(404, "Not found")
    d = kb_access.get_page(db, f.doc_id, user)
    kb_access.assert_edit(d, user, db)
    me_ = user["email"].lower()
    f.status, f.resolved_at, f.resolved_by, f.resolution = "resolved", kb_core.now(), me_, (body.resolution or "")[:500]
    kb_core.event(db, kind="flag_resolved", actor=me_, doc_id=d.id, version=d.version, note=body.resolution or "", actor_name=_name(db, me_))
    if f.user_email and f.user_email != me_:
        kb_core.notify(db, recipient=f.user_email, ntype="kb_flag_resolved", title="Thanks, That Page Was Fixed",
                       body=f"{d.title}" + (f": {body.resolution[:160]}" if body.resolution else ""), ref_id=d.id, item_name=d.title, sub=f"page:{d.id}", requested_by=me_)
    db.commit()
    return {"ok": True}


@router.post("/requests/{rid}/close")
def close_request(rid: str, body: ResolveIn, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    r = db.query(models.KbPageRequest).filter(models.KbPageRequest.id == rid).first()
    if not r:
        raise HTTPException(404, "Not found")
    me_ = user["email"].lower()
    r.status, r.closed_at, r.closed_by = "done", kb_core.now(), me_
    if body.resolution and body.resolution.startswith("kb_"):
        r.doc_id = body.resolution
    if r.user_email and r.user_email != me_:
        d = db.query(models.KbDocument).filter(models.KbDocument.id == r.doc_id).first() if r.doc_id else None
        kb_core.notify(db, recipient=r.user_email, ntype="kb_request_done", title="The Page You Asked For Is Ready" if d else "About the Page You Asked For",
                       body=(d.title if d else r.query), ref_id=d.id if d else r.id, item_name=d.title if d else r.query, sub=f"page:{d.id}" if d else "index", requested_by=me_)
    db.commit()
    return {"ok": True}


@router.get("/migrate")
def migration_report(user: dict = Depends(require_manage), db: Session = Depends(get_db)):
    """Dry run: what every old record becomes. Changes nothing."""
    import kb_migrate
    return kb_migrate.plan(db)


@router.post("/migrate")
def migration_apply(user: dict = Depends(require_manage), db: Session = Depends(get_db)):
    import kb_migrate
    rep = kb_migrate.apply(db, actor=user["email"].lower())
    kb_core.event(db, kind="migrated", actor=user["email"], note=json.dumps(rep["summary"]))
    db.commit()
    return rep


@router.get("/audience/options")
def audience_options(user: dict = Depends(require_author), db: Session = Depends(get_db)):
    return kb_audience.options(db)


class AudienceIn(BaseModel):
    audience: dict


@router.post("/audience/preview")
def audience_preview(body: AudienceIn, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    return kb_audience.preview(db, body.audience or {})


@router.get("/people")
def people(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Reviewer / owner pickers: the curated People list (manager+ roles are
    flagged so a reviewer picker can prefer them)."""
    roles = {r.email.lower(): r.role for r in db.query(models.NexusRole).all()}
    out = []
    for e in db.query(models.NexusEmployee).filter(models.NexusEmployee.status.in_(("onboarding", "active")), models.NexusEmployee.deleted_at == "",
                                                   models.NexusEmployee.work_email != "", models.NexusEmployee.identity_type != "guest").all():
        em = (e.work_email or "").lower()
        out.append({"email": em, "name": (e.display_name or f"{e.first_name or ''} {e.last_name or ''}").strip() or em,
                    "department": e.department or "", "job_title": e.job_title or "", "role": roles.get(em, "employee")})
    out.sort(key=lambda p: p["name"].lower())
    return out


@router.get("/print/{doc_id}", response_class=HTMLResponse)
def print_page(doc_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A clean printable copy (Share > Print)."""
    import html as _html
    d = kb_access.get_page(db, doc_id, user)
    blocks = kb_blocks.loads(d.blocks)
    text = _html.escape(kb_blocks.plain_text(blocks))
    paras = "".join(f"<p>{ln}</p>" for ln in text.split("\n") if ln.strip())
    title = _html.escape(d.title or "")
    meta = _html.escape(f"{d.doc_code or ''} · v{d.version} · verified {d.verified_at or ''} · Greens Global Knowledge Base")
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>{title}</title>
<style>body{{font-family:Inter,Segoe UI,Arial,sans-serif;max-width:760px;margin:40px auto;color:#0f172a;line-height:1.5}}h1{{font-size:24px}}.meta{{color:#64748b;font-size:13px}}</style></head>
<body><h1>{title}</h1><div class="meta">{meta}</div>{paras}</body></html>"""
