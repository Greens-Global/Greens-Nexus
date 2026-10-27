"""Performance review cycles API (Neil, Oct 27 2026). Rules and the flow are
perf_reviews.py; this file is shapes and checks. HR runs cycles from People >
Performance; everyone else works their reviews from Workday > Performance.
A review the caller may not see answers 404."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
import perf_reviews as pr
import performance as perf
import scoped_settings
from auth import get_current_user
from database import get_db

router = APIRouter(prefix="/performance", tags=["Performance Reviews"], dependencies=[Depends(get_current_user)])


def _me(user: dict) -> str:
    perf.require_internal(user)
    return (user.get("email") or "").strip().lower()


def _day(s: Optional[str]) -> str:
    v = (s or "").strip()[:10]
    if v:
        from datetime import date
        try:
            date.fromisoformat(v)
        except ValueError:
            raise HTTPException(400, "Pick a valid date.")
    return v


def _cycle_or_404(db: Session, user: dict, cid: str) -> models.PerfReviewCycle:
    c = db.get(models.PerfReviewCycle, cid)
    if c is None or not perf.hr_for(db, user, c.company_id or ""):
        raise HTTPException(404, "Review cycle not found")
    return c


def _review(db: Session, user: dict, rid: str):
    r = db.get(models.PerfReview, rid)
    a = pr.access_or_404(db, user, r)
    cycle = db.get(models.PerfReviewCycle, r.cycle_id)
    if cycle is None:
        raise HTTPException(404, "Review not found")
    return r, cycle, a


def _review_out(db: Session, user: dict, rid: str) -> dict:
    r, cycle, a = _review(db, user, rid)
    return pr.review_out(db, user, r, cycle, a)


# ── Cycles (HR) ──────────────────────────────────────────────────────────────

class CycleIn(BaseModel):
    company_id: str
    name: str
    period_start: Optional[str] = ""
    period_end: Optional[str] = ""
    self_due: Optional[str] = ""
    manager_due: Optional[str] = ""
    filters: Optional[dict] = None
    questions: Optional[list] = None
    include_goals: Optional[bool] = True


class CyclePatch(BaseModel):
    name: Optional[str] = None
    period_start: Optional[str] = None
    period_end: Optional[str] = None
    self_due: Optional[str] = None
    manager_due: Optional[str] = None
    filters: Optional[dict] = None
    questions: Optional[list] = None
    include_goals: Optional[bool] = None


class NudgeIn(BaseModel):
    review_ids: Optional[list] = None
    overdue_only: Optional[bool] = True


def _check_dates(c: models.PerfReviewCycle) -> None:
    if c.period_start and c.period_end and c.period_end < c.period_start:
        raise HTTPException(400, "The period ends before it starts.")
    if c.self_due and c.manager_due and c.manager_due < c.self_due:
        raise HTTPException(400, "Manager reviews are due after self reviews.")


@router.get("/cycles")
def list_cycles(company: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    reach = perf.hr_reach(db, user)
    if reach is False:
        raise HTTPException(403, "Review cycles are run by HR.")
    q = db.query(models.PerfReviewCycle)
    cid = (company or "").strip()
    if cid:
        if not perf.hr_for(db, user, cid):
            raise HTTPException(404, "Company not found")
        q = q.filter(models.PerfReviewCycle.company_id == cid)
    elif reach is not None:
        q = q.filter(models.PerfReviewCycle.company_id.in_(sorted(reach) or [""]))
    cycles = q.order_by(models.PerfReviewCycle.created_at.desc()).all()
    rows = (db.query(models.PerfReview).filter(models.PerfReview.cycle_id.in_([c.id for c in cycles] or [""])).all())
    by: dict = {}
    for r in rows:
        by.setdefault(r.cycle_id, []).append(r)
    on = pr.today()
    out = []
    for c in cycles:
        rs = by.get(c.id, [])
        counts = pr.stage_counts(rs)
        counts["total"] = len(rs)
        counts["overdue"] = sum(1 for r in rs if pr.overdue(r, c, on))
        out.append(pr.cycle_out(db, c, counts))
    return out


@router.post("/cycles", status_code=201)
def create_cycle(body: CycleIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    cid = (body.company_id or "").strip()
    if not cid or db.get(models.HrEntity, cid) is None:
        raise HTTPException(400, "Pick the company.")
    pr.require_hr(db, user, cid)
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "Name the cycle.")
    cfg = pr.settings_for_company(db, cid)
    now = perf.now_iso()
    c = models.PerfReviewCycle(id=perf.new_id(), company_id=cid, name=name[:200], period_start=_day(body.period_start),
                               period_end=_day(body.period_end), self_due=_day(body.self_due),
                               manager_due=_day(body.manager_due), filters=pr.clean_filters(body.filters),
                               questions=pr.clean_questions(body.questions if body.questions is not None else pr.DEFAULT_QUESTIONS),
                               rating_scale=cfg["ratingScale"], values=cfg["values"],
                               include_goals=bool(body.include_goals), status="draft", created_by=me,
                               created_at=now, updated_at=now, launched_at="", launched_by="", closed_at="", closed_by="")
    _check_dates(c)
    db.add(c)
    db.commit()
    return pr.cycle_out(db, c)


@router.patch("/cycles/{cid}")
def update_cycle(cid: str, body: CyclePatch, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A draft changes freely; once launched only the name and the deadlines
    move - the questions and who is in it are what people already answer."""
    _me(user)
    c = _cycle_or_404(db, user, cid)
    if c.status == "closed":
        raise HTTPException(409, "This cycle is closed.")
    data = body.model_dump(exclude_unset=True)
    if c.status != "draft" and any(k in data for k in ("filters", "questions", "include_goals", "period_start", "period_end")):
        raise HTTPException(409, "Once a cycle is launched only its name and deadlines can change.")
    if "name" in data:
        if not (data["name"] or "").strip():
            raise HTTPException(400, "Name the cycle.")
        c.name = data["name"].strip()[:200]
    for k in ("period_start", "period_end", "self_due", "manager_due"):
        if k in data:
            setattr(c, k, _day(data[k]))
    if "filters" in data:
        c.filters = pr.clean_filters(data["filters"])
    if "questions" in data:
        c.questions = pr.clean_questions(data["questions"])
    if "include_goals" in data:
        c.include_goals = bool(data["include_goals"])
    _check_dates(c)
    c.updated_at = perf.now_iso()
    db.commit()
    return pr.cycle_out(db, c)


@router.get("/review-departments")
def review_departments(company: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The departments a cycle's filter can pick from: the company's people's."""
    _me(user)
    pr.require_hr(db, user, (company or "").strip())
    rows = db.query(models.NexusEmployee.department).filter(models.NexusEmployee.company == company.strip()).all()
    return sorted({(d or "").strip() for (d,) in rows if (d or "").strip()}, key=str.lower)


@router.get("/cycles/{cid}/participants")
def cycle_participants(cid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    c = _cycle_or_404(db, user, cid)
    return [{**perf.person_out(db, e), "type": e.employment_type or "", "startDate": e.start_date or "",
             "hasManager": bool((e.manager_email or "").strip())} for e in pr.participants(db, c)]


@router.post("/cycles/{cid}/launch")
def launch_cycle(cid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    c = _cycle_or_404(db, user, cid)
    n = pr.launch(db, user, c)
    db.commit()
    return {**cycle_dashboard(cid, user, db), "launched": n}


@router.post("/cycles/{cid}/close")
def close_cycle(cid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    c = _cycle_or_404(db, user, cid)
    if c.status != "closed":
        c.status, c.closed_at, c.closed_by, c.updated_at = "closed", perf.now_iso(), me, perf.now_iso()
        db.commit()
    return cycle_dashboard(cid, user, db)


@router.get("/cycles/{cid}")
def cycle_dashboard(cid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """HR's cycle dashboard: how many are at each stage, who is overdue."""
    _me(user)
    c = _cycle_or_404(db, user, cid)
    rows = db.query(models.PerfReview).filter(models.PerfReview.cycle_id == c.id).all()
    on = pr.today()
    counts = pr.stage_counts(rows)
    counts["total"] = len(rows)
    counts["overdue"] = sum(1 for r in rows if pr.overdue(r, c, on))
    people = []
    for r in rows:
        people.append({"id": r.id, "employeeEmail": r.employee_email, "employeeName": perf.name_of(db, r.employee_email),
                       "managerEmail": r.manager_email or "",
                       "managerName": perf.name_of(db, r.manager_email) if r.manager_email else "HR",
                       "stage": r.stage, "stageLabel": pr.STAGE_LABELS.get(r.stage, r.stage),
                       "overdue": pr.overdue(r, c, on), "nudgedAt": r.nudged_at or "", "updatedAt": r.updated_at or ""})
    order = {s: i for i, s in enumerate(pr.STAGES)}
    people.sort(key=lambda p: (not p["overdue"], order.get(p["stage"], 9), p["employeeName"].lower()))
    return {**pr.cycle_out(db, c, counts), "reviews": people}


@router.post("/cycles/{cid}/nudge")
def nudge_cycle(cid: str, body: NudgeIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    c = _cycle_or_404(db, user, cid)
    n = pr.nudge(db, user, c, body.review_ids, bool(body.overdue_only))
    db.commit()
    return {"nudged": n}


# ── Reviews (everyone) ───────────────────────────────────────────────────────

class SelfIn(BaseModel):
    answers: Optional[dict] = None
    values: Optional[dict] = None
    submit: Optional[bool] = False


class ManagerIn(BaseModel):
    answers: Optional[dict] = None
    values: Optional[dict] = None
    overall_rating: Optional[int] = None
    summary: Optional[str] = ""
    private_note: Optional[str] = ""
    attach_goals: Optional[bool] = True
    submit: Optional[bool] = False


class ReturnIn(BaseModel):
    to: Optional[str] = "manager"
    note: str


class NoteIn(BaseModel):
    note: Optional[str] = ""


class ReviewerIn(BaseModel):
    email: Optional[str] = ""


@router.get("/reviews")
def my_reviews(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """My own reviews, and the ones I write or can read as a manager."""
    me = _me(user)
    own = db.query(models.PerfReview).filter(models.PerfReview.employee_email == me).all()
    team_emails = sorted({(e.work_email or "").lower() for e in perf.below(db, me)})
    team = (db.query(models.PerfReview).filter(models.PerfReview.employee_email.in_(team_emails or [""])).all()
            if team_emails else [])
    writes = db.query(models.PerfReview).filter(models.PerfReview.manager_email == me).all()
    seen, out = set(), {"mine": [], "team": []}
    cycles: dict = {}
    for bucket, rows in (("mine", own), ("team", team + writes)):
        for r in rows:
            if r.id in seen:
                continue
            seen.add(r.id)
            if r.cycle_id not in cycles:
                cycles[r.cycle_id] = db.get(models.PerfReviewCycle, r.cycle_id)
            c = cycles[r.cycle_id]
            if c is None or c.status == "draft":
                continue
            a = pr.Access(db, user, r)
            if not a.any:
                continue
            out[bucket].append({"id": r.id, "cycleName": c.name, "cycleStatus": c.status,
                                "employeeEmail": r.employee_email, "employeeName": perf.name_of(db, r.employee_email),
                                "stage": r.stage, "stageLabel": pr.STAGE_LABELS.get(r.stage, r.stage),
                                "overdue": pr.overdue(r, c), "yours": a.manager or (a.hr and not r.manager_email),
                                "due": c.self_due if r.stage == "self_review" else c.manager_due if r.stage == "manager_review" else ""})
    for k in out:
        out[k].sort(key=lambda x: (x["stage"] == "complete", x["due"] or "9999", x["employeeName"].lower()))
    return out


@router.get("/reviews/{rid}")
def get_review(rid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    return _review_out(db, user, rid)


@router.put("/reviews/{rid}/self")
def save_self(rid: str, body: SelfIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    r = db.query(models.PerfReview).filter(models.PerfReview.id == rid).with_for_update().first()
    pr.access_or_404(db, user, r)
    cycle = db.get(models.PerfReviewCycle, r.cycle_id)
    pr.save_self(db, user, r, cycle, body.answers, body.values, bool(body.submit))
    db.commit()
    return _review_out(db, user, rid)


@router.put("/reviews/{rid}/manager")
def save_manager(rid: str, body: ManagerIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    r = db.query(models.PerfReview).filter(models.PerfReview.id == rid).with_for_update().first()
    pr.access_or_404(db, user, r)
    cycle = db.get(models.PerfReviewCycle, r.cycle_id)
    pr.save_manager(db, user, r, cycle, answers=body.answers, values=body.values, overall=body.overall_rating,
                    summary=body.summary or "", private_note=body.private_note or "",
                    attach_goals=bool(body.attach_goals), submit=bool(body.submit))
    db.commit()
    return _review_out(db, user, rid)


@router.put("/reviews/{rid}/hr-note")
def save_hr_note(rid: str, body: NoteIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    r, cycle, a = _review(db, user, rid)
    pr.hr_note(db, user, r, body.note or "")
    db.commit()
    return _review_out(db, user, rid)


@router.post("/reviews/{rid}/return")
def return_review(rid: str, body: ReturnIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    r = db.query(models.PerfReview).filter(models.PerfReview.id == rid).with_for_update().first()
    pr.access_or_404(db, user, r)
    cycle = db.get(models.PerfReviewCycle, r.cycle_id)
    pr.return_review(db, user, r, cycle, "employee" if body.to == "employee" else "manager", body.note)
    db.commit()
    return _review_out(db, user, rid)


@router.post("/reviews/{rid}/reviewer")
def set_reviewer(rid: str, body: ReviewerIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    r, cycle, a = _review(db, user, rid)
    pr.set_reviewer(db, user, r, body.email or "")
    db.commit()
    return _review_out(db, user, rid)


@router.post("/reviews/{rid}/share")
def share_review(rid: str, request: Request, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """HR shares the final review: the PDF goes to the employee in Nexus Sign,
    the employee its only signer. Storage is blocking I/O - this is a sync
    endpoint, so it already runs in a worker thread."""
    _me(user)
    r = db.query(models.PerfReview).filter(models.PerfReview.id == rid).with_for_update().first()
    pr.access_or_404(db, user, r)
    cycle = db.get(models.PerfReviewCycle, r.cycle_id)
    from routers.esign import _client_meta
    ip, ua = _client_meta(request)
    pr.share(db, user, r, cycle, ip=ip, user_agent=ua)
    db.commit()
    return _review_out(db, user, rid)


@router.post("/reviews/{rid}/recall")
def recall_review(rid: str, body: NoteIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    r = db.query(models.PerfReview).filter(models.PerfReview.id == rid).with_for_update().first()
    pr.access_or_404(db, user, r)
    pr.recall(db, user, r, body.note or "")
    db.commit()
    return _review_out(db, user, rid)


# ── Settings: the rating scale and the company values ────────────────────────

class ReviewSettingsIn(BaseModel):
    company: Optional[str] = ""
    rating_scale: Optional[list] = None
    values: Optional[list] = None
    reset: Optional[bool] = False


def _settings_payload(db: Session, user: dict, company: str) -> dict:
    reach = perf.hr_reach(db, user)
    return {**pr.settings_for_company(db, company), "company": company,
            "override": scoped_settings.has_override(db, pr.SETTINGS_KEY, company),
            "canEdit": reach is None or (bool(company) and reach is not False and company in reach),
            "canEditDefault": reach is None}


@router.get("/review-settings")
def get_review_settings(company: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    if perf.hr_reach(db, user) is False:
        raise HTTPException(403, "Review settings are HR's.")
    cid = (company or "").strip()
    if cid and not perf.hr_for(db, user, cid):
        raise HTTPException(404, "Company not found")
    return _settings_payload(db, user, cid)


@router.put("/review-settings")
def save_review_settings(body: ReviewSettingsIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    reach = perf.hr_reach(db, user)
    cid = (body.company or "").strip()
    if reach is False or (not cid and reach is not None) or (cid and not perf.hr_for(db, user, cid)):
        raise HTTPException(403, "Only HR for every company can change the default." if not cid
                            else "Only HR for this company can change its settings.")
    if body.reset and cid:
        scoped_settings.reset(db, pr.SETTINGS_KEY, cid)
    else:
        cur = pr.settings_for_company(db, cid)
        cfg = {"ratingScale": pr.clean_scale(body.rating_scale) if body.rating_scale is not None else cur["ratingScale"],
               "values": pr.clean_values(body.values) if body.values is not None else cur["values"]}
        scoped_settings.save(db, pr.SETTINGS_KEY, cid, cfg, me)
    db.commit()
    return _settings_payload(db, user, cid)
