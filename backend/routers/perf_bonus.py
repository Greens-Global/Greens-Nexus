"""Bonus plans and bonus runs API (Oct 30 2026). Rules are perf_bonus.py.
Plans: Settings > Performance > Bonus Plans, HR for the company. Runs: HR
starts, approves and pays; a manager reviews their reports' lines (no money)."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
import perf_bonus as pb
import perf_scorecards as sc
import performance as perf
from auth import get_current_user
from database import get_db

router = APIRouter(prefix="/performance/bonus", tags=["Performance Bonus"], dependencies=[Depends(get_current_user)])


def _me(user: dict) -> str:
    perf.require_internal(user)
    return (user.get("email") or "").strip().lower()


def _company(db: Session, company: str) -> str:
    cid = (company or "").strip()
    if not cid:
        raise HTTPException(400, "Pick the company")
    if not db.get(models.HrEntity, cid):
        raise HTTPException(404, "Company not found")
    return cid


def _require_hr(db: Session, user: dict, cid: str) -> None:
    if not perf.hr_for(db, user, cid):
        raise HTTPException(403, "Bonus plans and runs are HR's for the company")


# ── plans ───────────────────────────────────────────────────────────────────
@router.get("/plans")
def list_plans(company: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    cid = _company(db, company)
    _require_hr(db, user, cid)
    roles = [{**r, "plan": pb.plan_out(pb.plan_for(db, r["id"])), "hasScorecard": sc.active_for(db, r["id"]) is not None}
             for r in sc.job_roles(db, cid)]
    return {"company": cid, "roles": roles, "adjustMaxDefault": pb.ADJUST_MAX_DEFAULT}


class PlanIn(BaseModel):
    company: str = ""
    roleId: str = ""
    targetPct: float = 0
    period: str = "monthly"
    thresholdScore: float = 60
    payoutAtThreshold: float = 50
    maxPayout: float = 100
    adjustMax: float = pb.ADJUST_MAX_DEFAULT
    reviewWeight: float = 0
    active: bool = True


@router.get("/plans/{pid}/history")
def plan_history(pid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    p = db.get(models.PerfBonusPlan, pid)
    if not p:
        raise HTTPException(404, "Plan not found")
    _require_hr(db, user, p.company_id)
    return pb.plan_history(db, pid)


@router.get("/readiness")
def readiness(company: str = "", period: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Before a run: who would be on it and which manual KPIs are still unrated."""
    _me(user)
    cid = _company(db, company)
    _require_hr(db, user, cid)
    return pb.readiness(db, cid, period)


@router.put("/plans")
def save_plan(body: PlanIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    cid = _company(db, body.company)
    _require_hr(db, user, cid)
    p = pb.save_plan(db, user, cid, body.roleId, body.model_dump())
    db.commit()
    return pb.plan_out(p)


# ── runs ────────────────────────────────────────────────────────────────────
@router.get("/runs")
def list_runs(company: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    cid = _company(db, company)
    _require_hr(db, user, cid)
    rows = (db.query(models.PerfBonusRun).filter(models.PerfBonusRun.company_id == cid)
            .order_by(models.PerfBonusRun.period_start.desc(), models.PerfBonusRun.created_at.desc()).all())
    return [pb.run_out(db, r, True, with_lines=False) for r in rows]


class RunIn(BaseModel):
    company: str = ""
    period: str = ""


@router.post("/runs", status_code=201)
def start_run(body: RunIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    cid = _company(db, body.company)
    _require_hr(db, user, cid)
    run = pb.start_run(db, user, cid, body.period)
    db.commit()
    return pb.run_out(db, run, True)


def _run(db: Session, user: dict, rid: str):
    run = db.get(models.PerfBonusRun, rid)
    if not run or not perf.hr_for(db, user, run.company_id):
        raise HTTPException(404, "Run not found")
    return run


@router.get("/runs/{rid}")
def get_run(rid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    return pb.run_out(db, _run(db, user, rid), True)


class RunPatch(BaseModel):
    budget: Optional[float] = None
    clearBudget: bool = False
    notes: Optional[str] = None


@router.put("/runs/{rid}")
def update_run(rid: str, body: RunPatch, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    run = _run(db, user, rid)
    pb.set_budget(db, run, "" if body.clearBudget else body.budget, body.notes)
    db.commit()
    return pb.run_out(db, run, True)


class ReviewedIn(BaseModel):
    emails: list = []


@router.post("/runs/{rid}/reviewed")
def mark_reviewed(rid: str, body: ReviewedIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A manager marks their people's lines Looks Right."""
    _me(user)
    run = db.get(models.PerfBonusRun, rid)
    if not run:
        raise HTTPException(404, "Run not found")
    n = pb.mark_reviewed(db, user, run, body.emails)
    db.commit()
    return {"reviewed": n}


class LineIn(BaseModel):
    adjustPct: float = 0
    reason: str = ""
    excluded: Optional[bool] = None


@router.put("/lines/{lid}")
def adjust_line(lid: str, body: LineIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A manager (within the plan's bound) or HR adjusts one line with a reason."""
    _me(user)
    line = db.get(models.PerfBonusLine, lid)
    if not line:
        raise HTTPException(404, "Line not found")
    run = db.get(models.PerfBonusRun, line.run_id)
    pb.adjust(db, user, line, body.adjustPct, body.reason, body.excluded)
    db.commit()
    return pb.line_out(db, line, perf.hr_for(db, user, run.company_id))


@router.post("/runs/{rid}/approve")
def approve_run(rid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    run = _run(db, user, rid)
    pb.approve(db, user, run)
    db.commit()
    return pb.run_out(db, run, True)


@router.post("/runs/{rid}/pay")
def pay_run(rid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    run = _run(db, user, rid)
    n = pb.pay(db, user, run)
    db.commit()
    return {**pb.run_out(db, run, True), "paidLines": n}


@router.post("/runs/{rid}/cancel")
def cancel_run(rid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    run = _run(db, user, rid)
    pb.cancel(db, run)
    db.commit()
    return {"ok": True}


@router.get("/review")
def my_review(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The lines a manager reviews: their reporting line's people on runs in
    review, without money. HR sees its runs on the Bonus Runs screen instead."""
    me = _me(user)
    below = {(e.work_email or "").lower() for e in perf.below(db, me)}
    if not below:
        return []
    runs = db.query(models.PerfBonusRun).filter(models.PerfBonusRun.status == "review").all()
    out = []
    for run in runs:
        rows = [ln for ln in pb.lines_of(db, run) if ln.email in below]
        if rows:
            out.append({**pb.run_out(db, run, False, with_lines=False), "lines": [pb.line_out(db, ln, False) for ln in rows]})
    return out
