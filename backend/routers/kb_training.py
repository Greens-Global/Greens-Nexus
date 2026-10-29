"""Training API (Oct 2026 rebuild): courses with versions, the server-graded
quiz, certificates with serials, assignments and rules, Training Plans,
My Training, and Manage > Compliance.

Answers never leave the server. A learner gets the questions (shuffled,
options shuffled) when an attempt opens; grading happens on submit; the
result names which questions were missed and where to reread, never the
right answer. Three tries, then a manager unlocks another round.
"""
from __future__ import annotations

import io
import json
import random
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

import kb_access
import kb_ai
import kb_audience
import kb_blocks
import kb_core
import models
from auth import get_current_user
from database import SessionLocal, get_db
from kb_access import require_author, require_manage

router = APIRouter(prefix="/kb", tags=["Knowledge Base Training"], dependencies=[Depends(get_current_user)])


# ----------------------------------------------------------------- payloads

class CourseIn(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    overview: Optional[list] = None
    est_minutes: Optional[int] = None
    recert_months: Optional[int] = None
    departments: Optional[str] = None
    lessons: Optional[list] = None
    quiz: Optional[dict] = None
    rev: Optional[str] = None


class PublishIn(BaseModel):
    change_note: str = ""


class LessonDoneIn(BaseModel):
    pass


class QuizSubmitIn(BaseModel):
    answers: dict           # {qid: [shown positions]}


class UnlockIn(BaseModel):
    email: str
    note: str = ""


class AssignIn(BaseModel):
    emails: list
    due_date: str = ""


class RuleIn(BaseModel):
    kind: Optional[str] = None
    target_id: Optional[str] = None
    audience: Optional[dict] = None
    due_days: Optional[int] = None
    renew_months: Optional[int] = None
    active: Optional[bool] = None


class PlanIn(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    items: Optional[list] = None
    due_days: Optional[int] = None
    audience: Optional[dict] = None
    active: Optional[bool] = None


class PlanAssignIn(BaseModel):
    emails: list


class GenerateIn(BaseModel):
    doc_ids: list
    title_hint: str = ""
    questions: int = 15


class NudgeIn(BaseModel):
    emails: list


# ----------------------------------------------------------------- helpers

def _name(db: Session, email: str) -> str:
    return kb_access.display_name(db, email)


def _j(raw, default):
    try:
        v = json.loads(raw) if raw else default
    except (ValueError, TypeError):
        return default
    return v if isinstance(v, type(default)) else default


def _assignment(db: Session, c: models.KbCourse, email: str):
    return db.query(models.KbCourseAssignment).filter(models.KbCourseAssignment.course_id == c.id,
                                                      models.KbCourseAssignment.user_email == email).first()


def _lesson_blocks(db: Session, L: dict) -> tuple[dict, dict]:
    """(blocks, page meta) for a lesson. A page lesson is pinned to the
    version it was published with; if that version row is gone, the current
    page is used and `newer` says so."""
    if L.get("type") == "page" and L.get("docId"):
        d = db.query(models.KbDocument).filter(models.KbDocument.id == L["docId"]).first()
        if not d:
            return kb_blocks.doc([kb_blocks.paragraph("This page is no longer available.")]), {"missing": True}
        ver = db.query(models.KbPageVersion).filter(models.KbPageVersion.doc_id == d.id, models.KbPageVersion.version == (L.get("docVersion") or "")).first()
        blocks = kb_blocks.loads(ver.blocks if ver else d.blocks)
        return blocks, {"doc_id": d.id, "title": d.title, "code": d.doc_code or "", "version": (L.get("docVersion") or d.version),
                        "current_version": d.version, "newer": bool(L.get("docVersion")) and L.get("docVersion") != d.version, "status": d.status}
    if L.get("type") == "checkpoint":
        return kb_blocks.doc(), {}
    return kb_blocks.loads(L.get("blocks")), {}


def _draft_of(c: models.KbCourse) -> dict:
    d = _j(c.draft, {})
    if d:
        return d
    return {"title": c.title, "description": c.description or "", "overview": _j(c.overview, []), "est_minutes": c.est_minutes or 15,
            "lessons": kb_core.lessons_of(c), "quiz": _j(c.quiz, {}) or {"passPct": 80, "drawCount": 0, "maxTries": 3, "shuffle": True, "questions": []},
            "recert_months": c.recert_months or 0, "departments": c.departments or ""}


def _norm_quiz(q: dict) -> dict:
    qs = []
    for x in q.get("questions") or []:
        if not isinstance(x, dict) or not str(x.get("q") or "").strip():
            continue
        t = x.get("type") if x.get("type") in ("single", "multi", "tf") else "single"
        opts = [str(o)[:300] for o in (x.get("options") or [])][:6]
        if t == "tf":
            opts = ["True", "False"]
        ans = x.get("answer")
        if isinstance(ans, int):
            ans = [ans]
        ans = sorted({int(a) for a in (ans or []) if isinstance(a, int) and 0 <= a < len(opts)})
        if t != "multi":
            ans = ans[:1]
        qs.append({"_id": str(x.get("_id") or kb_core.new_id("q")), "type": t, "q": str(x["q"]).strip()[:600], "options": opts, "answer": ans,
                   "explanation": str(x.get("explanation") or "")[:400], "lessonId": str(x.get("lessonId") or "")})
    return {"passPct": max(1, min(100, int(q.get("passPct") or 80))), "drawCount": max(0, int(q.get("drawCount") or 0)),
            "maxTries": max(1, min(10, int(q.get("maxTries") or 3))), "shuffle": q.get("shuffle", True) is not False, "questions": qs[:200]}


def _page_for_lesson(db: Session, did: str, user: Optional[dict]):
    """A page an author may build training from: one they can open (company
    wall, drafts only for their own people - kb_access.get_page), else None."""
    if not did:
        return None
    if user is None:
        return db.query(models.KbDocument).filter(models.KbDocument.id == did).first()
    try:
        return kb_access.get_page(db, did, user)
    except HTTPException:
        return None


def _norm_lessons(db: Session, lessons: list, user: Optional[dict] = None) -> list[dict]:
    out = []
    for L in lessons or []:
        if not isinstance(L, dict):
            continue
        t = L.get("type") if L.get("type") in ("text", "page", "checkpoint") else "text"
        lid = str(L.get("_id") or kb_core.new_id("l"))
        item = {"_id": lid, "type": t, "title": str(L.get("title") or "Lesson")[:200], "summary": str(L.get("summary") or "")[:600]}
        if t == "page":
            did = str(L.get("docId") or "")
            d = _page_for_lesson(db, did, user)
            if not d:
                continue
            item.update({"docId": d.id, "docVersion": str(L.get("docVersion") or d.version or ""), "blocks": None})
            if not item["title"] or item["title"] == "Lesson":
                item["title"] = d.title
        elif t == "checkpoint":
            item.update({"docId": "", "docVersion": "", "blocks": None,
                         "questions": _norm_quiz({"questions": L.get("questions") or []})["questions"][:10]})
        else:
            item.update({"docId": "", "docVersion": "", "blocks": kb_blocks.sanitize(L.get("blocks") or kb_blocks.doc(), image_ok=lambda u: not u.startswith("data:"))})
        out.append(item)
    return out[:60]


def _quiz_public(q: dict) -> dict:
    return {"pass_pct": q.get("passPct", 80), "draw": q.get("drawCount") or 0, "max_tries": q.get("maxTries") or 3,
            "question_count": len(q.get("questions") or [])}


def _course_card(db: Session, c: models.KbCourse, email: str) -> dict:
    prog = kb_core.progress_of(db, c, email)
    asn = _assignment(db, c, email)
    st = kb_core.training_status(db, c, prog, asn.due_date if asn else "", email)
    cert = db.query(models.KbCertificate).filter(models.KbCertificate.id == prog.certificate_id).first() if prog and prog.certificate_id else None
    return {"id": c.id, "code": c.course_code or "", "title": c.title, "description": c.description or "", "status": c.status,
            "major": c.major or 0, "est_minutes": c.est_minutes or 15, "lesson_count": len(kb_core.lessons_of(c)),
            "question_count": len(kb_core.course_settings(c)["questions"]), "recert_months": c.recert_months or 0,
            "owner_email": (c.owner_email or "").lower(), "owner_name": c.owner_name or _name(db, c.owner_email),
            "departments": c.departments or "", "published_at": c.published_at or "", "updated_at": c.updated_at or "",
            "assigned": bool(asn), "due_date": asn.due_date if asn else "", "source": asn.source if asn else "",
            "plan_id": asn.plan_id if asn else "", "my_status": st["status"], "my_pct": st["pct"], "expires": st["expires"],
            "days_overdue": st["days_overdue"], "completed_at": (prog.completed_at if prog else ""),
            "certificate": ({"id": cert.id, "serial": cert.serial, "issued_at": cert.issued_at, "expires_at": cert.expires_at} if cert else None),
            "has_draft": bool(c.draft)}


def _course_learner(db: Session, c: models.KbCourse, user: dict) -> dict:
    email = user["email"].lower()
    card = _course_card(db, c, email)
    prog = kb_core.progress_of(db, c, email)
    done = set(_j(prog.lessons_done, []) if prog else [])
    lessons = []
    for i, L in enumerate(kb_core.lessons_of(c)):
        blocks, meta = _lesson_blocks(db, L)
        lessons.append({"_id": L["_id"], "type": L.get("type"), "title": L.get("title"), "summary": L.get("summary") or "", "index": i,
                        "done": L["_id"] in done, "blocks": blocks if L.get("type") != "checkpoint" else None, "page": meta,
                        "headings": kb_blocks.headings(blocks) if L.get("type") != "checkpoint" else [],
                        "reading_minutes": kb_blocks.reading_minutes(blocks) if L.get("type") != "checkpoint" else 3,
                        "question_count": len(L.get("questions") or []) if L.get("type") == "checkpoint" else 0})
    settings = kb_core.course_settings(c)
    all_done = all(L["done"] for L in lessons) if lessons else True
    used = kb_core.attempts_used(db, c, email)
    allowed = kb_core.tries_allowed(c, prog)
    open_attempt = db.query(models.KbQuizAttempt).filter(models.KbQuizAttempt.course_id == c.id, models.KbQuizAttempt.user_email == email,
                                                        models.KbQuizAttempt.status == "open").first()
    last = db.query(models.KbQuizAttempt).filter(models.KbQuizAttempt.course_id == c.id, models.KbQuizAttempt.user_email == email,
                                                models.KbQuizAttempt.status == "graded").order_by(models.KbQuizAttempt.created_at.desc()).first()
    card.update({
        "overview": _j(c.overview, []), "lessons": lessons,
        "quiz": {**_quiz_public(settings), "locked": not all_done, "tries_used": used, "tries_allowed": allowed,
                 "tries_left": max(0, allowed - used), "open_attempt_id": open_attempt.id if open_attempt else "",
                 "passed": bool(prog and prog.passed), "score": (prog.quiz_score if prog else None),
                 "last": ({"score": last.score, "passed": last.passed, "at": last.created_at, "missed": _j(last.missed, [])} if last else None)},
        "started_at": prog.started_at if prog else "", "can_edit": kb_access.can_edit_course(c, user, db),
    })
    return card


def _touch_progress(db: Session, c: models.KbCourse, email: str) -> models.KbCourseProgress:
    prog = kb_core.progress_of(db, c, email)
    if not prog:
        prog = models.KbCourseProgress(id=kb_core.new_id("prg"), course_id=c.id, user_email=email, lessons_done="[]", quiz_score=None,
                                       passed=False, started_at=kb_core.now(), completed_at="", course_major=c.major or 0, unlock_rounds=0, certificate_id="")
        db.add(prog)
    elif not prog.started_at:
        prog.started_at = kb_core.now()
    return prog


def _complete_if_done(db: Session, c: models.KbCourse, prog: models.KbCourseProgress, email: str) -> bool:
    lessons = kb_core.lessons_of(c)
    done = set(_j(prog.lessons_done, []))
    settings = kb_core.course_settings(c)
    if not all(L["_id"] in done for L in lessons):
        return False
    if settings["questions"] and not prog.passed:
        return False
    if prog.completed_at:
        return False
    prog.completed_at = kb_core.now()
    asn = _assignment(db, c, email)
    kb_core.issue_certificate(db, c, prog, score=prog.quiz_score or 0, user_name=_name(db, email), assignment_id=asn.id if asn else "")
    kb_core.event(db, kind="course_completed", actor=email, course_id=c.id, version=str(c.major or 0), actor_name=_name(db, email))
    mgr = kb_access.manager_of(db, email)
    if mgr:
        kb_core.notify(db, recipient=mgr, ntype="kb_course_complete", title="Course Completed",
                       body=f"{_name(db, email)} completed {c.title}" + (f" with {prog.quiz_score}%" if settings["questions"] else ""),
                       ref_id=c.id, item_name=c.title, sub="compliance", requested_by=email)
    # a plan completes when all of its courses and policies are done
    for pa in db.query(models.KbPlanAssignment).filter(models.KbPlanAssignment.user_email == email, models.KbPlanAssignment.completed_at == "").all():
        if _plan_done(db, pa, email):
            pa.completed_at = kb_core.now()
    return True


def _plan_items(db: Session, plan: models.KbTrainingPlan, email: str) -> list[dict]:
    out = []
    for it in _j(plan.items, []):
        if not isinstance(it, dict):
            continue
        if it.get("kind") == "course":
            c = db.query(models.KbCourse).filter(models.KbCourse.id == it.get("id")).first()
            if not c:
                continue
            st = kb_core.training_status(db, c, kb_core.progress_of(db, c, email), "", email)
            out.append({"kind": "course", "id": c.id, "title": c.title, "code": c.course_code or "", "done": st["status"] == "Completed", "status": st["status"], "est_minutes": c.est_minutes or 15})
        elif it.get("kind") == "policy":
            d = db.query(models.KbDocument).filter(models.KbDocument.id == it.get("id")).first()
            if not d:
                continue
            signed = bool(kb_core.signature_for(db, d, email)) if d.status == "approved" else False
            out.append({"kind": "policy", "id": d.id, "title": d.title, "code": d.doc_code or "", "done": signed, "status": "Signed" if signed else "To Sign"})
    return out


def _plan_done(db: Session, pa: models.KbPlanAssignment, email: str) -> bool:
    plan = db.query(models.KbTrainingPlan).filter(models.KbTrainingPlan.id == pa.plan_id).first()
    if not plan:
        return False
    items = _plan_items(db, plan, email)
    return bool(items) and all(i["done"] for i in items)


def my_training_summary(db: Session, email: str) -> dict:
    """Used by /kb/home and /kb/training/me."""
    due, completed = [], []
    seen = set()
    for a in db.query(models.KbCourseAssignment).filter(models.KbCourseAssignment.user_email == email).all():
        c = db.query(models.KbCourse).filter(models.KbCourse.id == a.course_id, models.KbCourse.status == "published").first()
        if not c:
            continue
        seen.add(c.id)
        card = _course_card(db, c, email)
        (completed if card["my_status"] == "Completed" else due).append(card)
    for p in db.query(models.KbCourseProgress).filter(models.KbCourseProgress.user_email == email).all():
        if p.course_id in seen:
            continue
        c = db.query(models.KbCourse).filter(models.KbCourse.id == p.course_id, models.KbCourse.status == "published").first()
        if not c:
            continue
        seen.add(c.id)
        card = _course_card(db, c, email)
        (completed if card["my_status"] == "Completed" else due).append(card)
    due.sort(key=lambda x: (x["due_date"] or "9999", x["title"]))
    completed.sort(key=lambda x: x["completed_at"] or "", reverse=True)
    plans = []
    for pa in db.query(models.KbPlanAssignment).filter(models.KbPlanAssignment.user_email == email).all():
        plan = db.query(models.KbTrainingPlan).filter(models.KbTrainingPlan.id == pa.plan_id).first()
        if not plan:
            continue
        items = _plan_items(db, plan, email)
        plans.append({"id": plan.id, "name": plan.name, "description": plan.description or "", "due_date": pa.due_date, "items": items,
                      "done": sum(1 for i in items if i["done"]), "total": len(items), "completed_at": pa.completed_at,
                      "days_overdue": max(0, kb_core.days_between(pa.due_date, kb_core.today_for(db, email))) if pa.due_date and not pa.completed_at else 0})
    certs = [{"id": x.id, "serial": x.serial, "course_title": x.course_title, "course_code": x.course_code, "score": x.score, "issued_at": x.issued_at,
              "expires_at": x.expires_at, "course_major": x.course_major, "expired": bool(x.expires_at and x.expires_at < kb_core.today_for(db, email))}
             for x in db.query(models.KbCertificate).filter(models.KbCertificate.user_email == email, models.KbCertificate.revoked_at == "").order_by(models.KbCertificate.issued_at.desc()).all()]
    return {"due": due, "completed": completed, "plans": plans, "certificates": certs}


# ----------------------------------------------------------------- my training

@router.get("/training/me")
def training_me(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = user["email"].lower()
    s = my_training_summary(db, email)
    policies = []
    for d in kb_access.wall_rows(db.query(models.KbDocument).filter(models.KbDocument.status == "approved", models.KbDocument.require_ack.is_(True)).all(), user, db):
        st = kb_core.signoff_state(db, d, email)
        if st["required"]:
            policies.append({"id": d.id, "title": d.title, "code": d.doc_code or "", "version": d.version, "signed": st["signed"], "signed_at": st["signed_at"],
                             "due": st["due"], "overdue_days": st["overdue_days"], "version_signed": st["version_signed"]})
    policies.sort(key=lambda p: (p["signed"], p["due"] or "9999"))
    s["policies"] = policies
    s["stats"] = {"due": len(s["due"]), "overdue": sum(1 for x in s["due"] if x["days_overdue"]), "completed": len(s["completed"]),
                  "certificates": len(s["certificates"]), "to_sign": sum(1 for p in policies if not p["signed"])}
    s["can_author"] = kb_access.is_author(user, db)
    return s


# ----------------------------------------------------------------- courses

@router.get("/courses")
def list_courses(all: bool = False, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = user["email"].lower()
    rows = db.query(models.KbCourse).filter(models.KbCourse.status != "archived").all()
    rows = kb_access.wall_rows(rows, user, db)
    if not kb_access.is_author(user, db):
        rows = [c for c in rows if c.status == "published"]
    cards = [_course_card(db, c, email) for c in rows]
    for card, c in zip(cards, rows):
        card["learners"] = db.query(models.KbCourseAssignment).filter(models.KbCourseAssignment.course_id == c.id).count()
        card["completions"] = db.query(models.KbCourseProgress).filter(models.KbCourseProgress.course_id == c.id, models.KbCourseProgress.completed_at != "").count()
    cards.sort(key=lambda x: (x["status"] != "published", x["title"].lower()))
    return cards


@router.get("/courses/{cid}")
def get_course(cid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    c = kb_access.get_course(db, cid, user)
    return _course_learner(db, c, user)


@router.post("/courses", status_code=201)
def create_course(body: CourseIn, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    title = (body.title or "").strip()
    if not title:
        raise HTTPException(422, "A course needs a title")
    me = user["email"].lower()
    c = models.KbCourse(id=kb_core.new_id("crs"), course_code="", title=title[:200], description=(body.description or "")[:400], overview=json.dumps(body.overview or []),
                        recert_months=int(body.recert_months or 0), departments=body.departments or "", status="draft", owner_email=me, owner_name=_name(db, me),
                        est_minutes=int(body.est_minutes or 15), lessons="[]", quiz=json.dumps({"passPct": 80, "drawCount": 0, "maxTries": 3, "shuffle": True, "questions": []}),
                        created_at=kb_core.now(), updated_at=kb_core.now(), major=0, draft="", published_at="", published_by="")
    kb_core.assign_course_code(db, c)
    draft = _draft_of(c)
    if body.lessons is not None:
        draft["lessons"] = _norm_lessons(db, body.lessons, user)
    if body.quiz is not None:
        draft["quiz"] = _norm_quiz(body.quiz)
    c.draft = json.dumps(draft)
    db.add(c)
    kb_core.event(db, kind="course_created", actor=me, course_id=c.id, actor_name=c.owner_name)
    db.commit()
    return builder(c.id, user, db)


@router.get("/courses/{cid}/builder")
def builder(cid: str, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    c = kb_access.get_course(db, cid, user)
    kb_access.assert_edit_course(c, user, db)
    draft = _draft_of(c)
    lessons = []
    for L in draft.get("lessons") or []:
        item = dict(L)
        if L.get("type") == "page":
            d = db.query(models.KbDocument).filter(models.KbDocument.id == L.get("docId")).first()
            item["page"] = ({"id": d.id, "title": d.title, "code": d.doc_code or "", "current_version": d.version, "status": d.status,
                             "newer": bool(L.get("docVersion")) and L.get("docVersion") != d.version} if d else {"missing": True})
        lessons.append(item)
    versions = [{"id": v.id, "major": v.major, "published_at": v.published_at, "published_by": _name(db, v.published_by), "change_note": v.change_note,
                 "lessons": len(_j(v.lessons, [])), "questions": len((_j(v.quiz, {}) or {}).get("questions") or [])}
                for v in db.query(models.KbCourseVersion).filter(models.KbCourseVersion.course_id == c.id).order_by(models.KbCourseVersion.major.desc()).all()]
    rules = [_rule_out(db, r) for r in db.query(models.KbAssignmentRule).filter(models.KbAssignmentRule.kind == "course", models.KbAssignmentRule.target_id == c.id).all()]
    assignments = db.query(models.KbCourseAssignment).filter(models.KbCourseAssignment.course_id == c.id).count()
    return {"course": _course_card(db, c, user["email"].lower()), "draft": {**draft, "lessons": lessons}, "versions": versions, "rules": rules,
            "assignments": assignments, "dirty": bool(c.draft) and c.status == "published", "rev": c.updated_at,
            "live_summary": {"lessons": len(kb_core.lessons_of(c)), "questions": len(kb_core.course_settings(c)["questions"]), "major": c.major or 0}}


@router.patch("/courses/{cid}")
def update_course(cid: str, body: CourseIn, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    """Edits the DRAFT. The live course keeps running until Publish."""
    c = kb_access.get_course(db, cid, user)
    kb_access.assert_edit_course(c, user, db)
    if body.rev and body.rev != (c.updated_at or ""):
        raise HTTPException(409, "Someone else saved this course since you opened it. Reload to see their changes.")
    draft = _draft_of(c)
    if body.title is not None and body.title.strip():
        draft["title"] = body.title.strip()[:200]
    if body.description is not None:
        draft["description"] = body.description[:400]
    if body.overview is not None:
        draft["overview"] = [str(o)[:200] for o in body.overview][:8]
    if body.est_minutes is not None:
        draft["est_minutes"] = max(1, int(body.est_minutes))
    if body.recert_months is not None:
        draft["recert_months"] = max(0, int(body.recert_months))
    if body.departments is not None:
        draft["departments"] = body.departments[:200]
    if body.lessons is not None:
        draft["lessons"] = _norm_lessons(db, body.lessons, user)
    if body.quiz is not None:
        draft["quiz"] = _norm_quiz(body.quiz)
    c.draft = json.dumps(draft)
    if c.status == "draft":   # a never-published course shows its draft title in lists
        c.title, c.description, c.est_minutes, c.recert_months, c.departments = draft["title"], draft["description"], draft["est_minutes"], draft["recert_months"], draft["departments"]
        c.overview = json.dumps(draft["overview"])
    c.updated_at = kb_core.now()
    db.commit()
    return builder(c.id, user, db)


@router.post("/courses/{cid}/publish")
def publish_course(cid: str, body: PublishIn, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    c = kb_access.get_course(db, cid, user)
    kb_access.assert_edit_course(c, user, db)
    draft = _draft_of(c)
    lessons = _norm_lessons(db, draft.get("lessons") or [], user)
    if not lessons:
        raise HTTPException(422, "Add at least one lesson")
    for L in lessons:
        if L["type"] == "page":
            d = db.query(models.KbDocument).filter(models.KbDocument.id == L["docId"]).first()
            if not d or d.status != "approved":
                raise HTTPException(422, f"Lesson \"{L['title']}\" points at a page that is not published")
            if not L.get("docVersion"):
                L["docVersion"] = d.version
    quiz = _norm_quiz(draft.get("quiz") or {})
    if quiz["drawCount"] and quiz["drawCount"] > len(quiz["questions"]):
        raise HTTPException(422, "The quiz draws more questions than the pool has")
    me = user["email"].lower()
    c.title, c.description, c.est_minutes = draft["title"], draft.get("description") or "", int(draft.get("est_minutes") or 15)
    c.recert_months, c.departments = int(draft.get("recert_months") or 0), draft.get("departments") or ""
    c.overview = json.dumps(draft.get("overview") or [])
    c.lessons, c.quiz = json.dumps(lessons), json.dumps(quiz)
    c.major = (c.major or 0) + 1
    c.status = "published"
    c.published_at, c.published_by = kb_core.now(), me
    c.draft = ""
    c.updated_at = kb_core.now()
    db.add(models.KbCourseVersion(id=kb_core.new_id("cv"), course_id=c.id, major=c.major, title=c.title, description=c.description, overview=c.overview,
                                  est_minutes=c.est_minutes, lessons=c.lessons, quiz=c.quiz, published_at=c.published_at, published_by=me, change_note=(body.change_note or "")[:500]))
    kb_core.event(db, kind="course_published", actor=me, course_id=c.id, version=str(c.major), note=body.change_note or "", actor_name=_name(db, me))
    db.commit()
    return builder(c.id, user, db)


@router.post("/courses/{cid}/archive")
def archive_course(cid: str, user: dict = Depends(require_manage), db: Session = Depends(get_db)):
    c = kb_access.get_course(db, cid, user)
    c.status = "archived"
    c.updated_at = kb_core.now()
    kb_core.event(db, kind="course_archived", actor=user["email"], course_id=c.id)
    db.commit()
    return {"ok": True}


@router.post("/courses/{cid}/discard-draft")
def discard_course_draft(cid: str, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    c = kb_access.get_course(db, cid, user)
    kb_access.assert_edit_course(c, user, db)
    if c.status != "published":
        raise HTTPException(409, "Only a published course has a separate draft")
    c.draft = ""
    c.updated_at = kb_core.now()
    db.commit()
    return builder(c.id, user, db)


@router.get("/courses/{cid}/versions")
def course_versions(cid: str, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    c = kb_access.get_course(db, cid, user)
    return [{"id": v.id, "major": v.major, "title": v.title, "published_at": v.published_at, "published_by": _name(db, v.published_by), "change_note": v.change_note,
             "lessons": _j(v.lessons, []), "questions": len((_j(v.quiz, {}) or {}).get("questions") or [])}
            for v in db.query(models.KbCourseVersion).filter(models.KbCourseVersion.course_id == c.id).order_by(models.KbCourseVersion.major.desc()).all()]


# ----------------------------------------------------------------- learning

@router.post("/courses/{cid}/lessons/{lid}/done")
def lesson_done(cid: str, lid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    c = kb_access.get_course(db, cid, user)
    if c.status != "published":
        raise HTTPException(409, "This course is not published")
    email = user["email"].lower()
    lessons = kb_core.lessons_of(c)
    L = next((x for x in lessons if x.get("_id") == lid), None)
    if not L:
        raise HTTPException(404, "Lesson not found")
    if L.get("type") == "checkpoint":
        raise HTTPException(409, "A checkpoint is passed by answering it")
    prog = _touch_progress(db, c, email)
    done = _j(prog.lessons_done, [])
    if lid not in done:
        done.append(lid)
        prog.lessons_done = json.dumps(done)
    _complete_if_done(db, c, prog, email)
    db.commit()
    return _course_learner(db, c, user)


def _draw(c: models.KbCourse, questions: list[dict], shuffle: bool, draw: int) -> tuple[list[dict], dict]:
    rng = random.SystemRandom()
    pool = list(questions)
    if shuffle:
        rng.shuffle(pool)
    if draw and draw < len(pool):
        pool = pool[:draw]
    order: dict[str, list[int]] = {}
    shown = []
    for q in pool:
        idx = list(range(len(q["options"])))
        if shuffle and q.get("type") != "tf":
            rng.shuffle(idx)
        order[q["_id"]] = idx
        shown.append({"_id": q["_id"], "type": q.get("type") or "single", "q": q["q"], "options": [q["options"][i] for i in idx]})
    return shown, order


@router.post("/courses/{cid}/quiz/start", status_code=201)
def quiz_start(cid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    c = kb_access.get_course(db, cid, user)
    if c.status != "published":
        raise HTTPException(409, "This course is not published")
    email = user["email"].lower()
    settings = kb_core.course_settings(c)
    if not settings["questions"]:
        raise HTTPException(409, "This course has no quiz")
    prog = _touch_progress(db, c, email)
    done = set(_j(prog.lessons_done, []))
    if not all(L["_id"] in done for L in kb_core.lessons_of(c)):
        raise HTTPException(409, "Finish every lesson first")
    if prog.passed:
        raise HTTPException(409, "You already passed this quiz")
    existing = db.query(models.KbQuizAttempt).filter(models.KbQuizAttempt.course_id == c.id, models.KbQuizAttempt.user_email == email,
                                                    models.KbQuizAttempt.status == "open").first()
    if existing:
        order = _j(existing.option_order, {})
        by_id = {q["_id"]: q for q in settings["questions"]}
        shown = [{"_id": qid, "type": by_id[qid].get("type") or "single", "q": by_id[qid]["q"], "options": [by_id[qid]["options"][i] for i in order.get(qid, range(len(by_id[qid]["options"])))]}
                 for qid in _j(existing.question_ids, []) if qid in by_id]
        return {"attempt_id": existing.id, "questions": shown, "pass_pct": settings["pass_pct"], "tries_left": max(0, kb_core.tries_allowed(c, prog) - kb_core.attempts_used(db, c, email))}
    used = kb_core.attempts_used(db, c, email)
    allowed = kb_core.tries_allowed(c, prog)
    if used >= allowed:
        raise HTTPException(423, "No tries left. Ask your manager to unlock another round.")
    shown, order = _draw(c, settings["questions"], settings["shuffle"], settings["draw"])
    a = models.KbQuizAttempt(id=kb_core.new_id("qa"), course_id=c.id, course_code=c.course_code or "", course_title=c.title, user_email=email,
                             user_name=_name(db, email), score=0, passed=False, missed="[]", created_at=kb_core.now(), status="open",
                             course_major=c.major or 0, question_ids=json.dumps([q["_id"] for q in shown]), option_order=json.dumps(order), answers="")
    db.add(a)
    db.commit()
    return {"attempt_id": a.id, "questions": shown, "pass_pct": settings["pass_pct"], "tries_left": max(0, allowed - used - 1), "try_number": used + 1}


@router.post("/quiz/{aid}/submit")
def quiz_submit(aid: str, body: QuizSubmitIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = user["email"].lower()
    a = db.query(models.KbQuizAttempt).filter(models.KbQuizAttempt.id == aid, models.KbQuizAttempt.user_email == email).first()
    if not a:
        raise HTTPException(404, "Attempt not found")
    if a.status != "open":
        raise HTTPException(409, "Already graded")
    c = kb_access.get_course(db, a.course_id, user)
    settings = kb_core.course_settings(c)
    by_id = {q["_id"]: q for q in settings["questions"]}
    order = _j(a.option_order, {})
    qids = [q for q in _j(a.question_ids, []) if q in by_id]
    lessons = {L["_id"]: L for L in kb_core.lessons_of(c)}
    correct = 0
    missed = []
    answers_in = body.answers or {}
    for qid in qids:
        q = by_id[qid]
        picked_positions = answers_in.get(qid)
        if isinstance(picked_positions, int):
            picked_positions = [picked_positions]
        picked = set()
        for p in picked_positions or []:
            try:
                p = int(p)
            except (TypeError, ValueError):
                continue
            idx = order.get(qid) or list(range(len(q["options"])))
            if 0 <= p < len(idx):
                picked.add(idx[p])
        if picked == set(q["answer"]):
            correct += 1
        else:
            L = lessons.get(q.get("lessonId") or "")
            missed.append({"id": qid, "q": q["q"], "lesson_id": q.get("lessonId") or "", "lesson_title": (L or {}).get("title") or "",
                           "explanation": q.get("explanation") or "", "unanswered": not picked})
    score = int(round(100 * correct / len(qids))) if qids else 0
    passed = score >= settings["pass_pct"]
    a.score, a.passed, a.status, a.graded_at = score, passed, "graded", kb_core.now()
    a.answers = json.dumps({k: v for k, v in answers_in.items() if k in by_id})
    a.missed = json.dumps(missed)
    prog = _touch_progress(db, c, email)
    prog.quiz_score = max(score, prog.quiz_score or 0) if not passed else score
    if passed:
        prog.passed = True
        prog.quiz_score = score
        _complete_if_done(db, c, prog, email)
    db.commit()
    used = kb_core.attempts_used(db, c, email)
    allowed = kb_core.tries_allowed(c, prog)
    return {"score": score, "passed": passed, "pass_pct": settings["pass_pct"], "correct": correct, "total": len(qids), "missed": missed,
            "tries_used": used, "tries_left": max(0, allowed - used), "locked": (not passed) and used >= allowed,
            "completed": bool(prog.completed_at), "certificate_id": prog.certificate_id or ""}


@router.post("/courses/{cid}/lessons/{lid}/checkpoint/start", status_code=201)
def checkpoint_start(cid: str, lid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    c = kb_access.get_course(db, cid, user)
    L = next((x for x in kb_core.lessons_of(c) if x.get("_id") == lid and x.get("type") == "checkpoint"), None)
    if not L:
        raise HTTPException(404, "Checkpoint not found")
    shown, order = _draw(c, L.get("questions") or [], True, 0)
    email = user["email"].lower()
    a = models.KbQuizAttempt(id=kb_core.new_id("cp"), course_id=c.id, course_code=c.course_code or "", course_title=f"{c.title} - {L.get('title')}",
                             user_email=email, user_name=_name(db, email), score=0, passed=False, missed="[]", created_at=kb_core.now(), status="open",
                             course_major=-1, question_ids=json.dumps([q["_id"] for q in shown]), option_order=json.dumps(order), answers=json.dumps({"lesson": lid}))
    db.add(a)
    db.commit()
    return {"attempt_id": a.id, "questions": shown}


@router.post("/checkpoint/{aid}/submit")
def checkpoint_submit(aid: str, body: QuizSubmitIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A checkpoint is practice: graded, shows what was missed, and marks the
    lesson done either way. It never counts as a quiz try."""
    email = user["email"].lower()
    a = db.query(models.KbQuizAttempt).filter(models.KbQuizAttempt.id == aid, models.KbQuizAttempt.user_email == email, models.KbQuizAttempt.course_major == -1).first()
    if not a or a.status != "open":
        raise HTTPException(404, "Checkpoint not found")
    c = kb_access.get_course(db, a.course_id, user)
    lid = (_j(a.answers, {}) or {}).get("lesson")
    L = next((x for x in kb_core.lessons_of(c) if x.get("_id") == lid), None)
    if not L:
        raise HTTPException(404, "Lesson not found")
    by_id = {q["_id"]: q for q in (L.get("questions") or [])}
    order = _j(a.option_order, {})
    correct, missed = 0, []
    for qid in _j(a.question_ids, []):
        q = by_id.get(qid)
        if not q:
            continue
        picked = set()
        for p in (body.answers or {}).get(qid) or []:
            try:
                p = int(p)
            except (TypeError, ValueError):
                continue
            idx = order.get(qid) or list(range(len(q["options"])))
            if 0 <= p < len(idx):
                picked.add(idx[p])
        if picked == set(q["answer"]):
            correct += 1
        else:
            missed.append({"id": qid, "q": q["q"], "explanation": q.get("explanation") or ""})
    a.score, a.status, a.graded_at, a.missed = int(round(100 * correct / max(1, len(by_id)))), "graded", kb_core.now(), json.dumps(missed)
    a.passed = not missed
    prog = _touch_progress(db, c, email)
    done = _j(prog.lessons_done, [])
    if lid not in done:
        done.append(lid)
        prog.lessons_done = json.dumps(done)
    _complete_if_done(db, c, prog, email)
    db.commit()
    return {"score": a.score, "correct": correct, "total": len(by_id), "missed": missed}


@router.post("/courses/{cid}/unlock")
def unlock(cid: str, body: UnlockIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    c = kb_access.get_course(db, cid, user)
    target = (body.email or "").lower()
    me = user["email"].lower()
    allowed = kb_access.can_edit_course(c, user, db) or kb_access.manager_of(db, target) == me or kb_access.is_manage(user, db)
    if not allowed:
        raise HTTPException(403, "Only the person's manager, the course owner or a Knowledge Base manager can unlock")
    prog = kb_core.progress_of(db, c, target)
    if not prog:
        raise HTTPException(404, "That person has not started this course")
    prog.unlock_rounds = (prog.unlock_rounds or 0) + 1
    kb_core.event(db, kind="quiz_unlocked", actor=me, course_id=c.id, note=f"{target} {body.note or ''}".strip(), actor_name=_name(db, me))
    kb_core.notify(db, recipient=target, ntype="kb_quiz_unlocked", title="You Can Try the Quiz Again", body=f"{c.title}: {_name(db, me)} unlocked another round",
                   ref_id=c.id, item_name=c.title, sub=f"course:{c.id}", requested_by=me)
    db.commit()
    return {"tries_allowed": kb_core.tries_allowed(c, prog), "tries_used": kb_core.attempts_used(db, c, target)}


@router.get("/courses/{cid}/report")
def course_report(cid: str, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    c = kb_access.get_course(db, cid, user)
    if not (kb_access.can_edit_course(c, user, db) or kb_access.is_manage(user, db)):
        raise HTTPException(403, "Only the course owner or a Knowledge Base manager sees the report")
    people = {}
    for a in db.query(models.KbCourseAssignment).filter(models.KbCourseAssignment.course_id == c.id).all():
        people[a.user_email] = {"email": a.user_email, "name": a.user_name or _name(db, a.user_email), "due_date": a.due_date, "source": a.source, "assignment_id": a.id}
    for p in db.query(models.KbCourseProgress).filter(models.KbCourseProgress.course_id == c.id).all():
        people.setdefault(p.user_email, {"email": p.user_email, "name": _name(db, p.user_email), "due_date": "", "source": "", "assignment_id": ""})
    rows = []
    settings = kb_core.course_settings(c)
    for email, row in people.items():
        prog = kb_core.progress_of(db, c, email)
        st = kb_core.training_status(db, c, prog, row["due_date"], email)
        attempts = db.query(models.KbQuizAttempt).filter(models.KbQuizAttempt.course_id == c.id, models.KbQuizAttempt.user_email == email,
                                                        models.KbQuizAttempt.status == "graded", models.KbQuizAttempt.course_major == (c.major or 0)).order_by(models.KbQuizAttempt.created_at).all()
        rows.append({**row, **st, "score": prog.quiz_score if prog else None, "tries_used": len(attempts), "tries_allowed": kb_core.tries_allowed(c, prog),
                     "locked": bool(prog) and not (prog.passed) and len(attempts) >= kb_core.tries_allowed(c, prog),
                     "completed_at": prog.completed_at if prog else "", "started_at": prog.started_at if prog else "",
                     "last_missed": _j(attempts[-1].missed, []) if attempts else []})
    rows.sort(key=lambda r: ({"Overdue": 0, "Expired": 1, "In Progress": 2, "Not Started": 3, "Completed": 4}.get(r["status"], 5), r["name"]))
    # which questions are missed most
    miss_count: dict[str, int] = {}
    for a in db.query(models.KbQuizAttempt).filter(models.KbQuizAttempt.course_id == c.id, models.KbQuizAttempt.status == "graded", models.KbQuizAttempt.course_major == (c.major or 0)).all():
        for m in _j(a.missed, []):
            if isinstance(m, dict) and m.get("id"):
                miss_count[m["id"]] = miss_count.get(m["id"], 0) + 1
    hardest = sorted(({"id": q["_id"], "q": q["q"], "missed": miss_count.get(q["_id"], 0)} for q in settings["questions"]), key=lambda x: -x["missed"])[:8]
    return {"course": _course_card(db, c, user["email"].lower()), "people": rows, "hardest": hardest,
            "stats": {"assigned": len(rows), "completed": sum(1 for r in rows if r["status"] == "Completed"), "overdue": sum(1 for r in rows if r["status"] == "Overdue"),
                      "locked": sum(1 for r in rows if r["locked"]), "avg_score": (int(sum(r["score"] for r in rows if r["score"] is not None) / max(1, len([r for r in rows if r["score"] is not None]))))}}


# ----------------------------------------------------------------- assignments

@router.post("/courses/{cid}/assign")
def assign_course(cid: str, body: AssignIn, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    c = kb_access.get_course(db, cid, user)
    if c.status != "published":
        raise HTTPException(409, "Publish the course first")
    me = user["email"].lower()
    made = 0
    sc = kb_access.scope(user, db)
    for e in {str(x).lower().strip() for x in body.emails if str(x).strip()}:
        if not kb_access.in_scope(db, e, sc):
            continue   # another company's person: never assigned across the wall
        have = _assignment(db, c, e)
        if have:
            if body.due_date and have.due_date != body.due_date[:10]:
                have.due_date = body.due_date[:10]
            continue
        db.add(models.KbCourseAssignment(id=kb_core.new_id("asn"), course_id=c.id, user_email=e, user_name=_name(db, e), due_date=(body.due_date or "")[:10],
                                         assigned_by=me, created_at=kb_core.now(), source="manual"))
        kb_core.notify(db, recipient=e, ntype="kb_course_assigned", title="Training Assigned", body=f"{c.title}" + (f" - due {body.due_date[:10]}" if body.due_date else ""),
                       ref_id=c.id, item_name=c.title, sub=f"course:{c.id}", requested_by=me)
        made += 1
    db.commit()
    return {"assigned": made, "assignments": course_assignments(cid, user, db)}


@router.get("/courses/{cid}/assignments")
def course_assignments(cid: str, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    c = kb_access.get_course(db, cid, user)
    out = []
    for a in db.query(models.KbCourseAssignment).filter(models.KbCourseAssignment.course_id == c.id).all():
        st = kb_core.training_status(db, c, kb_core.progress_of(db, c, a.user_email), a.due_date, a.user_email)
        out.append({"id": a.id, "email": a.user_email, "name": a.user_name or _name(db, a.user_email), "due_date": a.due_date, "source": a.source,
                    "assigned_by": a.assigned_by, "created_at": a.created_at, **st})
    out.sort(key=lambda r: r["name"].lower())
    return out


@router.delete("/assignments/{aid}")
def remove_assignment(aid: str, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    a = db.query(models.KbCourseAssignment).filter(models.KbCourseAssignment.id == aid).first()
    if not a:
        raise HTTPException(404, "Not found")
    c = kb_access.get_course(db, a.course_id, user)
    kb_access.assert_edit_course(c, user, db)
    db.delete(a)
    kb_core.event(db, kind="assignment_removed", actor=user["email"], course_id=c.id, note=a.user_email)
    db.commit()
    return {"ok": True}


def _rule_out(db: Session, r: models.KbAssignmentRule) -> dict:
    target = ""
    if r.kind == "course":
        c = db.query(models.KbCourse).filter(models.KbCourse.id == r.target_id).first()
        target = c.title if c else ""
    else:
        p = db.query(models.KbTrainingPlan).filter(models.KbTrainingPlan.id == r.target_id).first()
        target = p.name if p else ""
    a = kb_audience.loads(r.audience)
    return {"id": r.id, "kind": r.kind, "target_id": r.target_id, "target": target, "audience": a, "audience_text": kb_audience.describe(a, db),
            "due_days": r.due_days, "renew_months": r.renew_months, "active": bool(r.active), "created_by": r.created_by, "last_run_at": r.last_run_at,
            "matches": len(kb_audience.members(db, a, kb_access.scope_of_email(db, r.created_by)))}


@router.get("/rules")
def list_rules(user: dict = Depends(require_author), db: Session = Depends(get_db)):
    rows = db.query(models.KbAssignmentRule).order_by(models.KbAssignmentRule.created_at.desc()).all()
    return [_rule_out(db, r) for r in kb_access.wall_rows(rows, user, db, owner_attr="created_by")]


@router.post("/rules", status_code=201)
def create_rule(body: RuleIn, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    if body.kind not in ("course", "plan") or not body.target_id:
        raise HTTPException(422, "A rule needs a course or plan")
    if body.kind == "course":
        kb_access.get_course(db, body.target_id, user)
    else:
        _get_plan(db, body.target_id, user)
    r = models.KbAssignmentRule(id=kb_core.new_id("rule"), kind=body.kind, target_id=body.target_id, audience=kb_audience.dumps(body.audience or {}),
                                due_days=int(body.due_days if body.due_days is not None else 14), renew_months=int(body.renew_months or 0), active=True,
                                created_by=user["email"].lower(), created_at=kb_core.now(), updated_at=kb_core.now())
    db.add(r)
    db.commit()
    import kb_daily
    kb_daily.run_rules(db)
    return _rule_out(db, r)


@router.patch("/rules/{rid}")
def update_rule(rid: str, body: RuleIn, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    r = db.query(models.KbAssignmentRule).filter(models.KbAssignmentRule.id == rid).first()
    if not r:
        raise HTTPException(404, "Not found")
    kb_access.assert_wall(r, user, db, owner_attr="created_by")
    if body.audience is not None:
        r.audience = kb_audience.dumps(body.audience)
    if body.due_days is not None:
        r.due_days = int(body.due_days)
    if body.renew_months is not None:
        r.renew_months = int(body.renew_months)
    if body.active is not None:
        r.active = bool(body.active)
    r.updated_at = kb_core.now()
    db.commit()
    if r.active:
        import kb_daily
        kb_daily.run_rules(db)
    return _rule_out(db, r)


@router.delete("/rules/{rid}")
def delete_rule(rid: str, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    r = db.query(models.KbAssignmentRule).filter(models.KbAssignmentRule.id == rid).first()
    if r:
        kb_access.assert_wall(r, user, db, owner_attr="created_by")
        r.active = False
        r.updated_at = kb_core.now()
        db.commit()
    return {"ok": True}


# ----------------------------------------------------------------- plans

def _plan_out(db: Session, p: models.KbTrainingPlan, email: str = "") -> dict:
    items = []
    for it in _j(p.items, []):
        if not isinstance(it, dict):
            continue
        if it.get("kind") == "course":
            c = db.query(models.KbCourse).filter(models.KbCourse.id == it.get("id")).first()
            if c:
                items.append({"kind": "course", "id": c.id, "title": c.title, "code": c.course_code or "", "status": c.status, "est_minutes": c.est_minutes or 15})
        elif it.get("kind") == "policy":
            d = db.query(models.KbDocument).filter(models.KbDocument.id == it.get("id")).first()
            if d:
                items.append({"kind": "policy", "id": d.id, "title": d.title, "code": d.doc_code or "", "status": d.status})
    a = kb_audience.loads(p.audience) if p.audience else {}
    assigned = db.query(models.KbPlanAssignment).filter(models.KbPlanAssignment.plan_id == p.id).all()
    return {"id": p.id, "name": p.name, "description": p.description or "", "items": items, "due_days": p.due_days, "audience": a,
            "audience_text": kb_audience.describe(a, db) if p.audience else "Assigned by name", "active": bool(p.active),
            "assigned": len(assigned), "completed": sum(1 for x in assigned if x.completed_at), "created_by": p.created_by}


def _get_plan(db: Session, pid: str, user: dict) -> models.KbTrainingPlan:
    """A plan the caller's company may see (its maker's company, or shared), else 404."""
    p = db.query(models.KbTrainingPlan).filter(models.KbTrainingPlan.id == pid).first()
    if not p:
        raise HTTPException(404, "Not found")
    kb_access.assert_wall(p, user, db, owner_attr="created_by")
    return p


@router.get("/plans")
def list_plans(user: dict = Depends(require_author), db: Session = Depends(get_db)):
    rows = db.query(models.KbTrainingPlan).order_by(models.KbTrainingPlan.name).all()
    return [_plan_out(db, p) for p in kb_access.wall_rows(rows, user, db, owner_attr="created_by")]


@router.post("/plans", status_code=201)
def create_plan(body: PlanIn, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    if not (body.name or "").strip():
        raise HTTPException(422, "A plan needs a name")
    p = models.KbTrainingPlan(id=kb_core.new_id("plan"), name=body.name.strip()[:200], description=(body.description or "")[:500],
                              items=json.dumps([{"kind": i.get("kind"), "id": i.get("id")} for i in (body.items or []) if isinstance(i, dict) and i.get("kind") in ("course", "policy") and i.get("id")]),
                              due_days=int(body.due_days or 30), audience=kb_audience.dumps(body.audience) if body.audience else "", active=True,
                              created_by=user["email"].lower(), created_at=kb_core.now(), updated_at=kb_core.now())
    db.add(p)
    db.commit()
    return _plan_out(db, p)


@router.patch("/plans/{pid}")
def update_plan(pid: str, body: PlanIn, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    p = _get_plan(db, pid, user)
    if body.name is not None and body.name.strip():
        p.name = body.name.strip()[:200]
    if body.description is not None:
        p.description = body.description[:500]
    if body.items is not None:
        p.items = json.dumps([{"kind": i.get("kind"), "id": i.get("id")} for i in body.items if isinstance(i, dict) and i.get("kind") in ("course", "policy") and i.get("id")])
    if body.due_days is not None:
        p.due_days = int(body.due_days)
    if body.audience is not None:
        p.audience = kb_audience.dumps(body.audience) if body.audience else ""
    if body.active is not None:
        p.active = bool(body.active)
    p.updated_at = kb_core.now()
    db.commit()
    return _plan_out(db, p)


@router.post("/plans/{pid}/assign")
def assign_plan(pid: str, body: PlanAssignIn, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    p = _get_plan(db, pid, user)
    import kb_daily
    made = 0
    sc = kb_access.scope(user, db)
    for e in {str(x).lower().strip() for x in body.emails if str(x).strip()}:
        emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == e).first()
        if not emp or not kb_access.in_scope(db, e, sc):
            continue
        if kb_daily.assign_plan(db, p, emp, due_days=p.due_days, source="manual", by=user["email"].lower()):
            made += 1
    db.commit()
    return {"assigned": made, "plan": _plan_out(db, p)}


# ----------------------------------------------------------------- generate

def _run_generate(job_id: str) -> None:
    db = SessionLocal()
    try:
        j = db.query(models.KbJob).filter(models.KbJob.id == job_id).first()
        if not j:
            return
        inp = json.loads(j.input or "{}")
        c = db.query(models.KbCourse).filter(models.KbCourse.id == j.course_id).first()
        pages = []
        for did in inp.get("doc_ids") or []:
            d = db.query(models.KbDocument).filter(models.KbDocument.id == did, models.KbDocument.status == "approved").first()
            if d:
                pages.append({"id": d.id, "title": d.title, "version": d.version or "", "text": d.content_text or kb_blocks.plain_text(kb_blocks.loads(d.blocks))})
        if not c or not pages:
            j.status, j.error = "failed", "No published pages to build from"
            db.commit()
            return
        j.status, j.total, j.progress = "running", 2, 0
        db.commit()
        try:
            out = kb_ai.course(pages, title_hint=inp.get("title_hint") or c.title, questions=int(inp.get("questions") or 15))
        except kb_ai.AiError as e:
            j.status, j.error, j.updated_at = "failed", str(e), kb_core.now()
            db.commit()
            return
        draft = _draft_of(c)
        by_id = {p["id"]: p for p in pages}
        lessons = []
        for L in out["lessons"]:
            if L["docId"] and L["docId"] in by_id:
                d = db.query(models.KbDocument).filter(models.KbDocument.id == L["docId"]).first()
                lessons.append({"_id": kb_core.new_id("l"), "type": "page", "title": L["title"], "docId": d.id, "docVersion": d.version, "blocks": None, "summary": L["summary"]})
            else:
                lessons.append({"_id": kb_core.new_id("l"), "type": "text", "title": L["title"], "docId": "", "docVersion": "",
                                "blocks": kb_blocks.from_plain_text(L["summary"]), "summary": ""})
        lesson_for_doc = {L["docId"]: L["_id"] for L in lessons if L.get("docId")}
        questions = [{"_id": kb_core.new_id("q"), "type": q["type"], "q": q["q"], "options": q["options"], "answer": q["answer"], "explanation": q["explanation"],
                      "lessonId": lesson_for_doc.get(q["docId"], "")} for q in out["questions"]]
        if not draft.get("title") or draft["title"] == c.title and not c.lessons:
            draft["title"] = out["title"]
        draft["description"] = draft.get("description") or out["description"]
        draft["overview"] = draft.get("overview") or out["overview"]
        draft["est_minutes"] = out["est_minutes"]
        draft["lessons"] = (draft.get("lessons") or []) + lessons
        q = draft.get("quiz") or {"passPct": 80, "drawCount": 0, "maxTries": 3, "shuffle": True, "questions": []}
        q["questions"] = (q.get("questions") or []) + questions
        draft["quiz"] = q
        c.draft = json.dumps(draft)
        c.updated_at = kb_core.now()
        j.status, j.progress, j.updated_at = "done", 2, kb_core.now()
        j.result = json.dumps({"lessons": len(lessons), "questions": len(questions)})
        db.commit()
    finally:
        db.close()


@router.post("/courses/{cid}/generate", status_code=202)
def generate(cid: str, body: GenerateIn, background_tasks: BackgroundTasks, user: dict = Depends(require_author), db: Session = Depends(get_db)):
    c = kb_access.get_course(db, cid, user)
    kb_access.assert_edit_course(c, user, db)
    if not kb_ai.available():
        raise HTTPException(503, "Nexus is not available on this server")
    # Only pages the author may open (Oct 29 2026: the ids came straight from the body).
    ids = [str(x) for x in body.doc_ids if _page_for_lesson(db, str(x), user)][:8]
    if not ids:
        raise HTTPException(422, "Pick at least one page")
    j = models.KbJob(id=kb_core.new_id("job"), kind="course", status="queued", course_id=c.id, input=json.dumps({"doc_ids": ids, "title_hint": body.title_hint, "questions": body.questions}),
                     created_by=user["email"].lower(), created_at=kb_core.now(), updated_at=kb_core.now())
    db.add(j)
    db.commit()
    background_tasks.add_task(_run_generate, j.id)
    return {"id": j.id, "status": "queued"}


# ----------------------------------------------------------------- certificates

def _cert_out(db: Session, x: models.KbCertificate) -> dict:
    return {"id": x.id, "serial": x.serial, "course_id": x.course_id, "course_code": x.course_code, "course_title": x.course_title, "course_major": x.course_major,
            "user_email": x.user_email, "user_name": x.user_name or _name(db, x.user_email), "score": x.score, "issued_at": x.issued_at, "expires_at": x.expires_at,
            "expired": bool(x.expires_at and x.expires_at < kb_core.today_for(db, x.user_email)), "revoked": bool(x.revoked_at), "legacy": bool(x.legacy)}


@router.get("/certificates/lookup")
def certificate_lookup(serial: str = Query(...), user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    x = db.query(models.KbCertificate).filter(models.KbCertificate.serial == serial.strip().upper()).first()
    if not x:
        return {"found": False}
    return {"found": True, **_cert_out(db, x)}


@router.get("/certificates/{cert_id}")
def get_certificate(cert_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    x = db.query(models.KbCertificate).filter(models.KbCertificate.id == cert_id).first()
    if not x:
        raise HTTPException(404, "Certificate not found")
    me = user["email"].lower()
    if x.user_email != me and not kb_access.is_author(user, db) and kb_access.manager_of(db, x.user_email) != me:
        raise HTTPException(404, "Certificate not found")
    if x.user_email != me:
        kb_access.assert_wall(x, user, db, owner_attr="user_email")   # an author never opens another company's
    return _cert_out(db, x)


@router.get("/certificates/{cert_id}/pdf")
def certificate_pdf(cert_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    out = get_certificate(cert_id, user, db)
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import landscape, letter
    from reportlab.pdfgen import canvas as rl_canvas
    buf = io.BytesIO()
    W, H = landscape(letter)
    cv = rl_canvas.Canvas(buf, pagesize=landscape(letter))
    cv.setTitle(f"Certificate {out['serial']}")
    green = colors.HexColor("#1e7b4e")
    cv.setStrokeColor(green)
    cv.setLineWidth(6)
    cv.rect(28, 28, W - 56, H - 56)
    cv.setLineWidth(1)
    cv.setStrokeColor(colors.HexColor("#cbd5e1"))
    cv.rect(40, 40, W - 80, H - 80)
    cv.setFillColor(green)
    cv.setFont("Helvetica-Bold", 14)
    cv.drawCentredString(W / 2, H - 90, "GREENS GLOBAL  ·  NEXUS KNOWLEDGE BASE")
    cv.setFillColor(colors.HexColor("#0f172a"))
    cv.setFont("Helvetica-Bold", 34)
    cv.drawCentredString(W / 2, H - 150, "Certificate of Completion")
    cv.setFont("Helvetica", 14)
    cv.setFillColor(colors.HexColor("#64748b"))
    cv.drawCentredString(W / 2, H - 185, "This certifies that")
    cv.setFillColor(colors.HexColor("#0f172a"))
    cv.setFont("Helvetica-Bold", 28)
    cv.drawCentredString(W / 2, H - 230, out["user_name"][:60])
    cv.setFont("Helvetica", 14)
    cv.setFillColor(colors.HexColor("#64748b"))
    cv.drawCentredString(W / 2, H - 262, "completed the course")
    cv.setFillColor(colors.HexColor("#0f172a"))
    cv.setFont("Helvetica-Bold", 22)
    cv.drawCentredString(W / 2, H - 300, out["course_title"][:70])
    cv.setFont("Helvetica", 13)
    cv.setFillColor(colors.HexColor("#334155"))
    parts = [f"Course {out['course_code']}" if out["course_code"] else "", f"version {out['course_major']}", f"score {out['score']}%" if out["score"] else ""]
    cv.drawCentredString(W / 2, H - 328, "  ·  ".join(p for p in parts if p))

    def us(iso: str) -> str:
        try:
            y, m, d = iso[:10].split("-")
            return f"{m}/{d}/{y}"
        except ValueError:
            return iso
    cv.drawCentredString(W / 2, H - 352, f"Issued {us(out['issued_at'])}" + (f"  ·  Valid through {us(out['expires_at'])}" if out["expires_at"] else ""))
    cv.setFont("Helvetica", 10)
    cv.setFillColor(colors.HexColor("#64748b"))
    cv.drawCentredString(W / 2, 70, f"Serial {out['serial']}  ·  Check any certificate in Nexus under Training > Certificate Check")
    cv.showPage()
    cv.save()
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="{out["serial"]}.pdf"'})


# ----------------------------------------------------------------- compliance

@router.get("/compliance")
def compliance(scope: str = "direct", company: str = "", department: str = "", manager: str = "",
               user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = user["email"].lower()
    manage = kb_access.is_manage(user, db)
    if scope == "company" and not manage:
        scope = "team"
    if scope == "direct":
        people = kb_access.direct_reports(db, manager or me) if (manage or not manager or manager == me) else kb_access.direct_reports(db, me)
    elif scope == "team":
        people = kb_access.reporting_line(db, manager if (manage and manager) else me)
    else:
        people = db.query(models.NexusEmployee).filter(models.NexusEmployee.status.in_(("onboarding", "active")), models.NexusEmployee.deleted_at == "",
                                                       models.NexusEmployee.work_email != "", models.NexusEmployee.identity_type != "guest").all()
        if manager:
            people = [p for p in people if (p.manager_email or "").lower() == manager.lower()]
    if company:
        people = [p for p in people if (p.company or "") == company]
    if department:
        people = [p for p in people if (p.department or "").lower() == department.lower()]
    sc = kb_access.scope(user, db)
    if sc is not None:
        people = [p for p in people if (p.company or "") in sc or not p.company]
    courses = [c for c in db.query(models.KbCourse).filter(models.KbCourse.status == "published").all()]
    policies = [d for d in db.query(models.KbDocument).filter(models.KbDocument.status == "approved", models.KbDocument.require_ack.is_(True)).all()]
    policy_aud = {d.id: kb_core.policy_audience_emails(db, d) for d in policies}
    cols: list[dict] = []
    used_course, used_policy = set(), set()
    rows = []
    for p in sorted(people, key=lambda e: ((e.last_name or ""), (e.first_name or ""))):
        email = (p.work_email or "").lower()
        cells = {}
        counts = {"green": 0, "amber": 0, "red": 0}
        for c in courses:
            a = _assignment(db, c, email)
            prog = kb_core.progress_of(db, c, email)
            if not a and not prog:
                continue
            used_course.add(c.id)
            st = kb_core.training_status(db, c, prog, a.due_date if a else "", email)
            day = kb_core.today_for(db, email)
            due_soon = bool(a and a.due_date and 0 <= kb_core.days_between(day, a.due_date) <= 14) or bool(st["expires"] and 0 <= kb_core.days_between(day, st["expires"]) <= 30)
            color = "green" if st["status"] == "Completed" and not due_soon else "red" if st["status"] in ("Overdue", "Expired") else "amber"
            counts[color] += 1
            cells[f"course:{c.id}"] = {"status": st["status"], "color": color, "pct": st["pct"], "due": a.due_date if a else "", "expires": st["expires"], "days_overdue": st["days_overdue"]}
        for d in policies:
            if email not in policy_aud[d.id]:
                continue
            used_policy.add(d.id)
            st = kb_core.signoff_state(db, d, email)
            color = "green" if st["signed"] else ("red" if st["overdue_days"] > 0 else "amber")
            counts[color] += 1
            cells[f"policy:{d.id}"] = {"status": "Signed" if st["signed"] else ("Overdue" if st["overdue_days"] else "To Sign"), "color": color, "due": st["due"],
                                      "days_overdue": st["overdue_days"], "signed_at": st["signed_at"]}
        rows.append({"email": email, "name": (p.display_name or f"{p.first_name or ''} {p.last_name or ''}").strip(), "department": p.department or "",
                     "job_title": p.job_title or "", "company": p.company or "", "manager_email": (p.manager_email or "").lower(), "cells": cells,
                     "counts": counts, "compliant": counts["red"] == 0 and counts["amber"] == 0 and bool(cells)})
    for c in courses:
        if c.id in used_course:
            cols.append({"key": f"course:{c.id}", "kind": "course", "id": c.id, "title": c.title, "code": c.course_code or ""})
    for d in policies:
        if d.id in used_policy:
            cols.append({"key": f"policy:{d.id}", "kind": "policy", "id": d.id, "title": d.title, "code": d.doc_code or ""})
    total_cells = sum(len(r["cells"]) for r in rows)
    green = sum(r["counts"]["green"] for r in rows)
    return {"scope": scope, "people": rows, "columns": cols,
            "stats": {"people": len(rows), "compliant_pct": int(round(100 * green / total_cells)) if total_cells else 100,
                      "overdue": sum(r["counts"]["red"] for r in rows), "due_soon": sum(r["counts"]["amber"] for r in rows),
                      "compliant_people": sum(1 for r in rows if r["compliant"])},
            "filters": {"companies": [{"id": e.id, "name": e.name} for e in db.query(models.HrEntity).all()],
                        "departments": sorted({(p.department or "") for p in people if p.department}),
                        "can_company": manage}}


@router.post("/compliance/nudge")
def compliance_nudge(body: NudgeIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = user["email"].lower()
    import kb_daily
    n = 0
    sc = kb_access.scope(user, db)
    for e in {str(x).lower() for x in body.emails}:
        if not kb_access.in_scope(db, e, sc):
            continue   # another company's person: never nudged across the wall
        if not (kb_access.is_manage(user, db) or kb_access.manager_of(db, e) == me or e in {(x.work_email or "").lower() for x in kb_access.reporting_line(db, me)}):
            continue
        items = [i for i in kb_daily.learner_items(db, e) if i["status"] in ("Overdue", "To Sign", "Not Started", "In Progress", "Expired")]
        if not items:
            continue
        lines = [f"{i['title']}" + (f" ({i['days_overdue']} days overdue)" if i["days_overdue"] else "") for i in items]
        if kb_core.notify(db, recipient=e, ntype="kb_training_reminder", title="A Nudge From Your Manager", body="; ".join(lines)[:900], ref_id="training",
                          item_name="Training", sub="training", requested_by=me, dedupe_today=True, priority=1):
            kb_daily._mail(db, e, f"{_name(db, me)} asked you to finish your training", lines)
            n += 1
    db.commit()
    return {"nudged": n}
