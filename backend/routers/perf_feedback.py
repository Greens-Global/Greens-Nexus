"""Performance: peer feedback, kudos and improvement plans API (Neil, Oct 29
2026). The rules are perf_feedback.py and perf_plans.py; this file is
shapes and checks. Something the caller may not see answers 404."""
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
import perf_feedback as pf
import perf_plans as pp
import performance as perf
from auth import get_current_user
from database import get_db

router = APIRouter(prefix="/performance", tags=["Performance Feedback"], dependencies=[Depends(get_current_user)])


def _me(user: dict) -> str:
    perf.require_internal(user)
    return (user.get("email") or "").strip().lower()


def _locked(db: Session, model, rid: str):
    return db.query(model).filter(model.id == rid).with_for_update().first()


# ── Peer feedback ────────────────────────────────────────────────────────────

class FeedbackAskIn(BaseModel):
    subject: Optional[str] = ""          # '' = me
    givers: list
    note: Optional[str] = ""
    review_id: Optional[str] = ""


class FeedbackAnswerIn(BaseModel):
    answers: Optional[dict] = None
    submit: Optional[bool] = False


class NoteIn(BaseModel):
    note: Optional[str] = ""


@router.get("/feedback")
def list_feedback(person: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    return pf.lists(db, user, person)


@router.post("/feedback", status_code=201)
def ask_feedback(body: FeedbackAskIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    rows = pf.request(db, user, subject=body.subject or "", givers=body.givers or [], note=body.note or "",
                      review_id=body.review_id or "")
    db.commit()
    return {"asked": len(rows), "items": [pf.feedback_out(db, user, f) for f in rows]}


@router.get("/feedback/{fid}")
def get_feedback(fid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    f = db.get(models.PerfFeedback, fid)
    s = pf.seat_or_404(db, user, f)
    return pf.feedback_out(db, user, f, s)


@router.put("/feedback/{fid}")
def answer_feedback(fid: str, body: FeedbackAnswerIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    f = _locked(db, models.PerfFeedback, fid)
    pf.answer(db, user, f, body.answers or {}, bool(body.submit))
    db.commit()
    return pf.feedback_out(db, user, f)


@router.post("/feedback/{fid}/decline")
def decline_feedback(fid: str, body: NoteIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    f = _locked(db, models.PerfFeedback, fid)
    pf.decline(db, user, f, body.note or "")
    db.commit()
    return pf.feedback_out(db, user, f)


@router.post("/feedback/{fid}/cancel")
def cancel_feedback(fid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    f = _locked(db, models.PerfFeedback, fid)
    pf.cancel(db, user, f)
    db.commit()
    return pf.feedback_out(db, user, f)


# ── Kudos ────────────────────────────────────────────────────────────────────

class KudosIn(BaseModel):
    to: str
    message: str
    value: Optional[str] = ""
    post_teams: Optional[bool] = True    # the "Also post to Teams" switch; nothing is posted with no chat set


class ThanksIn(BaseModel):
    note: Optional[str] = ""


@router.get("/kudos")
def list_kudos(scope: str = "company", person: str = "", company: str = "",
               user: dict = Depends(get_current_user), db: Session = Depends(get_db), limit: int = 60):
    _me(user)
    return pf.kudos_list(db, user, scope=scope, person=person, company=company, limit=limit)


@router.post("/kudos", status_code=201)
def give_kudos(body: KudosIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db),
               background_tasks: BackgroundTasks = None):
    _me(user)
    k = pf.give_kudos(db, user, body.to, body.message, body.value or "")
    row = pf.queue_teams_post(db, k) if body.post_teams else None
    db.commit()
    if row is not None and background_tasks is not None:
        from routers.tickets import _deliver_teams_dm
        background_tasks.add_task(_deliver_teams_dm, row.id)
    return pf.kudos_out(db, user, k)


# Thanks and the recipient's moment (Neil, 11/08/2026). Unseen comes before
# /kudos/{kid} so the word is never read as an id.
@router.get("/kudos/unseen")
def unseen_kudos(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    return pf.unseen(db, user)


@router.get("/kudos/summary")
def kudos_summary(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    return pf.summary(db, user)


@router.get("/kudos/options")
def kudos_options(to: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The send form, once a recipient is picked: their company's values and
    whether their company posts kudos to Teams."""
    _me(user)
    return pf.options(db, user, to)


@router.post("/kudos/{kid}/thanks", status_code=201)
def thank_kudos(kid: str, body: ThanksIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    k = _locked(db, models.PerfKudos, kid)
    pf.add_thanks(db, user, k, body.note or "")
    db.commit()
    return pf.kudos_out(db, user, k)


@router.delete("/kudos/{kid}/thanks")
def unthank_kudos(kid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    k = _locked(db, models.PerfKudos, kid)
    pf.remove_thanks(db, user, k)
    db.commit()
    return pf.kudos_out(db, user, k)


@router.post("/kudos/{kid}/seen")
def seen_kudos(kid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    pf.mark_seen(db, user, db.get(models.PerfKudos, kid))
    db.commit()
    return {"ok": True, "id": kid}


@router.post("/kudos/{kid}/hide")
def hide_kudos(kid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    k = _locked(db, models.PerfKudos, kid)
    if k is None or not pf.can_read_kudos(db, user, k):
        raise HTTPException(404, "Kudos not found")
    pf.hide_kudos(db, user, k)
    db.commit()
    return {"ok": True, "id": kid}


# ── Improvement plans ────────────────────────────────────────────────────────

class PlanIn(BaseModel):
    employee: Optional[str] = ""
    title: Optional[str] = None
    reason: Optional[str] = None
    expectations: Optional[list] = None
    support: Optional[str] = None
    start_on: Optional[str] = None
    end_on: Optional[str] = None


class CheckinIn(BaseModel):
    note: str


class ExtendIn(BaseModel):
    end_on: str
    note: str


class CloseIn(BaseModel):
    outcome: str
    note: Optional[str] = ""
    results: Optional[dict] = None


class AckIn(BaseModel):
    comment: Optional[str] = ""


@router.get("/plans")
def list_plans(person: str = "", company: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    return pp.plans_for(db, user, person=person, company=company)


@router.post("/plans", status_code=201)
def create_plan(body: PlanIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    p = pp.create(db, user, employee=body.employee or "", title=body.title or "", reason=body.reason or "",
                  expectations=body.expectations or [], support=body.support or "",
                  start_on=body.start_on or "", end_on=body.end_on or "")
    db.commit()
    return pp.plan_out(db, user, p)


@router.get("/plans/{pid}")
def get_plan(pid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    p = db.get(models.PerfPlan, pid)
    s = pp.seat_or_404(db, user, p)
    return pp.plan_out(db, user, p, s)


@router.patch("/plans/{pid}")
def update_plan(pid: str, body: PlanIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    p = _locked(db, models.PerfPlan, pid)
    data = {k: v for k, v in body.model_dump(exclude_unset=True).items() if k != "employee"}
    pp.update(db, user, p, data)
    db.commit()
    return pp.plan_out(db, user, p)


def _act(pid: str, user: dict, db: Session, fn, *a):
    _me(user)
    p = _locked(db, models.PerfPlan, pid)
    fn(db, user, p, *a)
    db.commit()
    return pp.plan_out(db, user, p)


@router.post("/plans/{pid}/send")
def send_plan(pid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _act(pid, user, db, pp.send_to_hr)


@router.post("/plans/{pid}/start")
def start_plan(pid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _act(pid, user, db, pp.start)


@router.post("/plans/{pid}/acknowledge")
def acknowledge_plan(pid: str, body: AckIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _act(pid, user, db, pp.acknowledge, body.comment or "")


@router.post("/plans/{pid}/checkins")
def plan_checkin(pid: str, body: CheckinIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _act(pid, user, db, pp.checkin, body.note)


@router.post("/plans/{pid}/extend")
def extend_plan(pid: str, body: ExtendIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _act(pid, user, db, pp.extend, body.end_on, body.note)


@router.post("/plans/{pid}/close")
def close_plan(pid: str, body: CloseIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _act(pid, user, db, pp.close, body.outcome, body.note or "", body.results or None)
