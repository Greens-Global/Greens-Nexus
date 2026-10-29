"""Performance review API, made simple (Neil, Oct 29 2026). Rules and the
flow are perf_reviews.py; this file is shapes and checks. HR runs cycles from
People > Performance; everyone else works their reviews from Workday >
Performance. A review the caller may not see answers 404."""
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


def _locked(db: Session, user: dict, rid: str):
    r = db.query(models.PerfReview).filter(models.PerfReview.id == rid).with_for_update().first()
    a = pr.access_or_404(db, user, r)
    cycle = db.get(models.PerfReviewCycle, r.cycle_id)
    if cycle is None:
        raise HTTPException(404, "Review not found")
    return r, cycle, a


def _review_out(db: Session, user: dict, rid: str) -> dict:
    r = db.get(models.PerfReview, rid)
    a = pr.access_or_404(db, user, r)
    cycle = db.get(models.PerfReviewCycle, r.cycle_id)
    if cycle is None:
        raise HTTPException(404, "Review not found")
    return pr.review_out(db, user, r, cycle, a)


def _counts(c: models.PerfReviewCycle, rows: list) -> dict:
    live = [r for r in rows if r.stage != "removed"]
    on = pr.today()
    counts = pr.stage_counts(live)
    counts["total"] = len(live)
    counts["removed"] = len(rows) - len(live)
    counts["overdue"] = sum(1 for r in live if pr.overdue(r, c, on))
    counts["ratings"] = pr.rating_counts(live)
    return counts


# ── Cycles (HR) ──────────────────────────────────────────────────────────────

class CycleIn(BaseModel):
    company_id: str
    name: str
    due: Optional[str] = ""
    period_start: Optional[str] = ""
    period_end: Optional[str] = ""


class CyclePatch(BaseModel):
    name: Optional[str] = None
    due: Optional[str] = None


class CloseIn(BaseModel):
    force: Optional[bool] = False


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
    return [pr.cycle_out(db, c, _counts(c, by.get(c.id, []))) for c in cycles]


@router.post("/cycles", status_code=201)
def create_cycle(body: CycleIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """New Review Cycle: name, company, due date - it starts at once, with
    everyone who belongs in it."""
    _me(user)
    cid = (body.company_id or "").strip()
    if not cid or db.get(models.HrEntity, cid) is None:
        raise HTTPException(400, "Pick the company.")
    c = pr.start_cycle(db, user, company_id=cid, name=body.name or "", due=_day(body.due),
                       period_start=_day(body.period_start), period_end=_day(body.period_end))
    db.commit()
    return cycle_dashboard(c.id, user, db)


@router.patch("/cycles/{cid}")
def update_cycle(cid: str, body: CyclePatch, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    c = _cycle_or_404(db, user, cid)
    if c.status == "closed":
        raise HTTPException(409, "This cycle is closed.")
    data = body.model_dump(exclude_unset=True)
    if "name" in data:
        if not (data["name"] or "").strip():
            raise HTTPException(400, "Name the review.")
        c.name = data["name"].strip()[:200]
    if "due" in data:
        due = _day(data["due"])
        if not due:
            raise HTTPException(400, "Pick the due date.")
        c.manager_due, c.self_due = due, pr.self_due_for(due)
    c.updated_at = perf.now_iso()
    db.commit()
    return cycle_dashboard(cid, user, db)


@router.post("/cycles/{cid}/launch")
def launch_cycle(cid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A draft from the first build starts the simple way."""
    me = _me(user)
    c = (db.query(models.PerfReviewCycle).filter(models.PerfReviewCycle.id == cid)
         .with_for_update().populate_existing().first())
    if c is None or not perf.hr_for(db, user, c.company_id or ""):
        raise HTTPException(404, "Review cycle not found")
    if c.status == "draft":
        if not c.manager_due:
            raise HTTPException(400, "Set the due date first.")
        c.self_due = c.self_due or pr.self_due_for(c.manager_due)
        c.status, c.launched_at, c.launched_by = "active", perf.now_iso(), me
        db.flush()
        pr.sync_members(db, c, me)
    db.commit()
    return cycle_dashboard(cid, user, db)


@router.post("/cycles/{cid}/share-all")
def share_all(cid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    c = _cycle_or_404(db, user, cid)
    n = pr.share_all(db, user, c)
    db.commit()
    return {**cycle_dashboard(cid, user, db), "shared": n}


@router.post("/cycles/{cid}/close")
def close_cycle(cid: str, body: CloseIn = CloseIn(), user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    c = _cycle_or_404(db, user, cid)
    pr.close(db, user, c, bool(body.force))
    db.commit()
    return cycle_dashboard(cid, user, db)


@router.get("/cycles/{cid}")
def cycle_dashboard(cid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """HR's progress table: who, their manager, the stage and the rating."""
    _me(user)
    c = _cycle_or_404(db, user, cid)
    rows = db.query(models.PerfReview).filter(models.PerfReview.cycle_id == c.id).all()
    on = pr.today()
    people = []
    for r in rows:
        if r.stage == "removed":
            continue
        people.append({"id": r.id, "employeeEmail": r.employee_email, "employeeName": perf.name_of(db, r.employee_email),
                       "managerEmail": r.manager_email or "",
                       "managerName": perf.name_of(db, r.manager_email) if r.manager_email else "HR",
                       "stage": r.stage, "stageLabel": pr.STAGE_LABELS.get(r.stage, r.stage),
                       "rating": r.rating or "", "ratingLabel": pr.RATING_LABELS.get(r.rating or "", ""),
                       "overdue": pr.overdue(r, c, on), "updatedAt": r.updated_at or ""})
    order = {s: i for i, s in enumerate(pr.STAGES)}
    people.sort(key=lambda p: (not p["overdue"], order.get(p["stage"], 9), p["employeeName"].lower()))
    return {**pr.cycle_out(db, c, _counts(c, rows)), "reviews": people}


# ── Reviews (everyone) ───────────────────────────────────────────────────────

class SelfIn(BaseModel):
    answers: Optional[dict] = None
    submit: Optional[bool] = False


class ManagerIn(BaseModel):
    answers: Optional[dict] = None
    goal_scores: Optional[dict] = None
    rating: Optional[str] = ""
    promotion_ready: Optional[bool] = False
    private_note: Optional[str] = ""
    submit: Optional[bool] = False


class NoteIn(BaseModel):
    note: Optional[str] = ""


class ReviewerIn(BaseModel):
    email: Optional[str] = ""


class AckIn(BaseModel):
    comment: Optional[str] = ""


@router.get("/reviews")
def my_reviews(user: dict = Depends(get_current_user), db: Session = Depends(get_db), person: str = ""):
    """My own reviews, and the ones I write or can read as a manager - a
    reviewer HR picked sees theirs here even with nobody reporting to them.
    With `person`: that one person's reviews (their profile), as far as the
    caller may read each one."""
    me = _me(user)
    who = (person or "").strip().lower()
    if who and who != me:
        if not perf.can_see_person(db, user, who):
            raise HTTPException(404, "Person not found")
        rows = db.query(models.PerfReview).filter(models.PerfReview.employee_email == who).all()
        out = []
        for r in rows:
            c = db.get(models.PerfReviewCycle, r.cycle_id)
            if c is None or c.status == "draft" or r.stage == "removed" or not pr.Access(db, user, r).any:
                continue
            out.append({"id": r.id, "cycleName": c.name, "cycleStatus": c.status, "employeeEmail": r.employee_email,
                        "employeeName": perf.name_of(db, r.employee_email), "stage": r.stage,
                        "stageLabel": pr.STAGE_LABELS.get(r.stage, r.stage), "overdue": pr.overdue(r, c),
                        "yours": False, "periodStart": c.period_start or "", "periodEnd": c.period_end or "",
                        "due": "", "rating": r.rating if r.stage in ("ready", "shared", "complete") else ""})
        out.sort(key=lambda x: x["periodEnd"] or "", reverse=True)
        return {"mine": [], "team": out}
    own = db.query(models.PerfReview).filter(models.PerfReview.employee_email == me).all()
    team_emails = sorted({(e.work_email or "").lower() for e in perf.below(db, me)})
    team = (db.query(models.PerfReview).filter(models.PerfReview.employee_email.in_(team_emails or [""])).all()
            if team_emails else [])
    writes = db.query(models.PerfReview).filter(models.PerfReview.manager_email == me).all()
    seen, out = set(), {"mine": [], "team": []}
    cycles: dict = {}
    for bucket, rows in (("mine", own), ("team", writes + team)):
        for r in rows:
            if r.id in seen or r.stage == "removed":
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
            yours = a.manager or (a.hr and not r.manager_email)
            out[bucket].append({"id": r.id, "cycleName": c.name, "cycleStatus": c.status,
                                "employeeEmail": r.employee_email, "employeeName": perf.name_of(db, r.employee_email),
                                "stage": r.stage, "stageLabel": pr.STAGE_LABELS.get(r.stage, r.stage),
                                "overdue": pr.overdue(r, c), "yours": yours,
                                "periodStart": c.period_start or "", "periodEnd": c.period_end or "",
                                "due": c.self_due if (bucket == "mine" and r.stage == "self_review")
                                else c.manager_due if r.stage in ("self_review", "manager_review") else ""})
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
    r, cycle, _a = _locked(db, user, rid)
    pr.save_self(db, user, r, cycle, body.answers, bool(body.submit))
    db.commit()
    return _review_out(db, user, rid)


@router.put("/reviews/{rid}/manager")
def save_manager(rid: str, body: ManagerIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    r, cycle, _a = _locked(db, user, rid)
    sent = body.model_fields_set
    kw = {k: getattr(body, f) for k, f in (("answers", "answers"), ("goal_scores", "goal_scores"), ("rating", "rating"),
                                           ("promotion", "promotion_ready"), ("private_note", "private_note")) if f in sent}
    pr.save_manager(db, user, r, cycle, **kw, submit=bool(body.submit))
    db.commit()
    return _review_out(db, user, rid)


@router.post("/reviews/{rid}/return")
def return_review(rid: str, body: NoteIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    r, cycle, _a = _locked(db, user, rid)
    pr.return_review(db, user, r, cycle, body.note or "")
    db.commit()
    return _review_out(db, user, rid)


@router.post("/reviews/{rid}/reviewer")
def set_reviewer(rid: str, body: ReviewerIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    r, cycle, _a = _locked(db, user, rid)
    pr.set_reviewer(db, user, r, cycle, body.email or "")
    db.commit()
    return _review_out(db, user, rid)


@router.post("/reviews/{rid}/remove")
def remove_review(rid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    r, cycle, _a = _locked(db, user, rid)
    pr.remove(db, user, r)
    db.commit()
    return {"ok": True, "id": rid}


@router.post("/reviews/{rid}/share")
def share_review(rid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    r, cycle, _a = _locked(db, user, rid)
    pr.share(db, user, r, cycle)
    db.commit()
    return _review_out(db, user, rid)


@router.post("/reviews/{rid}/recall")
def recall_review(rid: str, body: NoteIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    r, cycle, _a = _locked(db, user, rid)
    pr.recall(db, user, r, body.note or "")
    db.commit()
    return _review_out(db, user, rid)


@router.post("/reviews/{rid}/acknowledge")
def acknowledge_review(rid: str, body: AckIn, request: Request, user: dict = Depends(get_current_user),
                       db: Session = Depends(get_db)):
    """The employee acknowledges: their comments go on the PDF, which goes to
    them in Nexus Sign as its only signer. Storage is blocking I/O - this is a
    sync endpoint, so it already runs in a worker thread."""
    _me(user)
    r, cycle, _a = _locked(db, user, rid)
    from routers.esign import _client_meta
    ip, ua = _client_meta(request)
    party = pr.acknowledge(db, user, r, cycle, body.comment or "", ip=ip, user_agent=ua)
    db.commit()
    return {"signPartyId": party, "review": _review_out(db, user, rid)}


# ── Settings of the first build (the 1-5 scale and the company values) ──────
# Reviews no longer read them (one 4-word rating, no values - Oct 29 2026);
# the stored settings stay, and so do these two routes for anyone who has
# them open.

class ReviewSettingsIn(BaseModel):
    company: Optional[str] = ""
    rating_scale: Optional[list] = None
    values: Optional[list] = None
    reset: Optional[bool] = False
    part: Optional[str] = ""


@router.get("/review-settings")
def get_review_settings(company: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    if perf.hr_reach(db, user) is False:
        raise HTTPException(403, "Review settings are HR's.")
    cid = (company or "").strip()
    return {"company": cid, "settings": scoped_settings.saved(db, "performance_reviews", cid, {}) if cid else {},
            "unused": True}
