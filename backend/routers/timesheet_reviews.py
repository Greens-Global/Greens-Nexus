"""Timesheet review endpoints (Sep 2026) - the hand-offs between an employee
and their manager before a timesheet is signed in Nexus Sign. The rules live
in timesheet_review.py; this file only decides who may call what.

Signing itself happens in Nexus Sign (/esign/mine/{party_id}/...), which calls
back into timesheet_review when a party signs, declines, or completes it.

Managers WITHOUT the People module (Pranshu, 10/06): access follows the
reporting line, not a module grant. The manager a timesheet was submitted to
(review.manager_email) - and the employee's current manager in People - may
open that employee's timecard for a reviewed period through
/{id}/timecard, see My Team's Timesheets (/team), Agree / Send Back, and
change hours while it is with them (timeclock._check_edit_scope). They never
see pay: rates, wages, salary and totals are stripped server-side unless the
viewer is an administrator or holds the HR (People) grant.
"""
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

import timesheet_review as tsr
from auth import _LEVELS, _MODULE_LEVEL_RANK, _module_level, get_current_user
from database import get_db
from models import AuditLog, NexusEmployee, TimesheetReview
from routers.esign import _client_meta
from routers.timeclock import _visible_emails

router = APIRouter(prefix="/timesheet-review", tags=["Timesheet review"],
                   dependencies=[Depends(get_current_user)])


class SubmitIn(BaseModel):
    start: str = ""      # any date in the period; omit for the current one
    note: str = ""


class NoteIn(BaseModel):
    note: str = ""


def _review(db: Session, rid: str) -> TimesheetReview:
    r = db.query(TimesheetReview).filter(TimesheetReview.id == rid).first()
    if not r:
        raise HTTPException(404, "Timesheet review not found")
    return r


def _team_write(db: Session, user: dict) -> bool:
    return (user.get("level", 0) >= _LEVELS["manager"]
            or _module_level(user.get("email") or "", "hr", db) >= _MODULE_LEVEL_RANK["editor"])


def sees_pay(db: Session, user: dict) -> bool:
    """Pay figures are payroll's: administrators and the HR (People) grant.
    A manager reviewing hours never sees them (Pranshu, 10/06)."""
    return (user.get("level", 0) >= _LEVELS["administrator"]
            or _module_level(user.get("email") or "", "hr", db) >= _MODULE_LEVEL_RANK["viewer"])


def _is_line_manager(db: Session, me: str, r: TimesheetReview) -> bool:
    """The reviewer it was submitted to, or the employee's manager in People now."""
    if me and me == (r.manager_email or "").lower():
        return True
    emp = db.query(NexusEmployee).filter(NexusEmployee.work_email == r.employee_email).first()
    return bool(emp and me and (emp.manager_email or "").strip().lower() == me)


def _as_reviewer(db: Session, user: dict, r: TimesheetReview) -> str:
    """Who may Agree / Send Back: the manager it was submitted to - by the
    reporting line alone, no module grant needed - or the team-write audience
    (HR editors, managers) whose scope covers the employee. Never the employee
    on their own timesheet."""
    me = (user.get("email") or "").lower()
    if me == r.employee_email:
        raise HTTPException(403, "You can't review your own timesheet.")
    if me == (r.manager_email or "").lower():
        return me
    if not _team_write(db, user):
        raise HTTPException(404, "Timesheet review not found")
    scope = _visible_emails(db, user)
    if scope is not None and r.employee_email not in scope:
        raise HTTPException(404, "Timesheet review not found")
    return me


def _may_view(db: Session, user: dict, r: TimesheetReview) -> bool:
    me = (user.get("email") or "").lower()
    if me == r.employee_email:
        return False                       # their own card is /timeclock/my-payroll
    if _is_line_manager(db, me, r):
        return True
    if not sees_pay(db, user) and user.get("level", 0) < _LEVELS["manager"]:
        return False
    scope = _visible_emails(db, user)
    return scope is None or r.employee_email in scope


# Every money field the timecard builders emit (timeclock._compute_timecard,
# _fixed_card) - removed for a viewer who does not see pay.
PAY_KEYS = frozenset({"pay", "rate", "rateSet", "rateSplits", "amount", "regPay", "otPay", "dtPay", "sickPay",
                      "vacationPay", "holidayPay", "totalPay", "hourlyRate", "dailyRate", "monthlySalary",
                      "salaryForPeriod", "weekendFloor", "deductionAmount", "weekendPay", "currency",
                      "deduct", "deduction", "bonus", "weekendBonus"})


def strip_pay(o):
    if isinstance(o, dict):
        return {k: strip_pay(v) for k, v in o.items() if k not in PAY_KEYS}
    if isinstance(o, list):
        return [strip_pay(v) for v in o]
    return o


@router.get("/waiting")
def waiting(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Timesheets submitted to the caller for review - the list at the top of
    People > Time (Sep 29). Empty for anyone nobody reports to."""
    me = (user.get("email") or "").lower()
    return {"reviews": [tsr.queue_row(db, r) for r in tsr.waiting_on(db, me)]}


@router.post("/submit")
def submit(body: SubmitIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    r = tsr.submit(db, user["email"], (body.start or "").strip(), body.note)
    return tsr.state_for(db, r.employee_email, r.period_start, user["email"], False)


@router.get("/team")
def my_team(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """My Team's Timesheets (Pranshu, 10/06): every timesheet of the people who
    report to the caller - waiting on them, back with the employee, signing,
    completed - newest period first, plus who has not submitted the current
    period yet. Hours only, never pay. Empty for anyone nobody reports to."""
    me = (user.get("email") or "").lower()
    reports = {(e.work_email or "").lower(): e for e in db.query(NexusEmployee)
               .filter(NexusEmployee.manager_email == me).all()
               if e.work_email and (e.status or "active") != "offboarded"}
    q = db.query(TimesheetReview).filter((TimesheetReview.manager_email == me)
                                         | (TimesheetReview.employee_email.in_(list(reports) or [""])))
    rows = q.order_by(TimesheetReview.period_start.desc(), TimesheetReview.updated_at.desc()).limit(300).all()
    out = []
    for r in rows:
        last = next((e for e in reversed(r.rounds or []) if e.get("workedMin") is not None), {})
        sub = next((e for e in reversed(r.rounds or []) if e.get("action") in ("submitted", "resubmitted")), {})
        out.append({"id": r.id, "employeeEmail": r.employee_email, "name": tsr.display_name(db, r.employee_email),
                    "periodStart": r.period_start, "periodEnd": r.period_end, "payType": r.pay_type,
                    "status": r.status, "workedMin": int(last.get("workedMin") or 0),
                    "submittedAt": sub.get("at") or "", "updatedAt": r.updated_at or "",
                    "agreedAt": r.agreed_at or ""})
    # The current period: who has not handed theirs in yet.
    pending = []
    from routers.timeclock import is_time_tracking_exempt
    for em in sorted(reports, key=lambda e: tsr.display_name(db, e).lower()):
        if is_time_tracking_exempt(db, em):
            continue
        start, end, _pt = tsr.period_for(db, em, "")
        if not any(o["employeeEmail"] == em and o["periodStart"] == start for o in out):
            pending.append({"employeeEmail": em, "name": tsr.display_name(db, em),
                            "periodStart": start, "periodEnd": end, "status": "not_submitted"})
    return {"reviews": out, "notSubmitted": pending}


@router.get("/{rid}/timecard")
def review_timecard(rid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The timecard behind one timesheet review, for its manager - without the
    People module (Pranshu, 10/06). Exactly that employee and that period;
    everyone else gets 404. Pay is removed unless the viewer sees pay. Each
    open is written to the audit log."""
    from routers import timeclock as tc
    r = _review(db, rid)
    if not _may_view(db, user, r):
        raise HTTPException(404, "Timesheet review not found")
    me = (user.get("email") or "").lower()
    card = tsr.card_for(db, r.employee_email, r.period_start, r.period_end, r.pay_type)
    card.update(tc._signoff_state(db, r.employee_email, r.period_start, r.period_end))
    card["review"] = tc._review_state(db, r.employee_email, r.period_start, user, team=True)
    card["notes"] = tc._timecard_notes(db, r.employee_email, r.period_start, r.period_end)
    card["email"] = r.employee_email
    card["employeeName"] = tsr.display_name(db, r.employee_email)
    card["reviewId"] = r.id
    card["canEdit"] = r.status == "with_manager" and (me == (r.manager_email or "").lower() or _team_write(db, user))
    if not sees_pay(db, user):
        card = strip_pay(card)
        card["payHidden"] = True
    db.add(AuditLog(timestamp=datetime.now(timezone.utc).isoformat(), user_email=me, user_role=user.get("role", ""),
                    action="timesheet_review_viewed", resource_type="timesheet_review", resource_id=r.id,
                    details=json.dumps({"employee": r.employee_email, "period": r.period_start,
                                        "payHidden": bool(card.get("payHidden"))})))
    db.commit()
    return card


@router.post("/{rid}/send-back")
def send_back(rid: str, body: NoteIn, user: dict = Depends(get_current_user),
              db: Session = Depends(get_db)):
    r = _review(db, rid)
    me = _as_reviewer(db, user, r)
    tsr.send_back(db, r, me, body.note)
    return tsr.state_for(db, r.employee_email, r.period_start, me, True)


@router.post("/{rid}/agree")
def agree(rid: str, body: NoteIn, request: Request, user: dict = Depends(get_current_user),
          db: Session = Depends(get_db)):
    r = _review(db, rid)
    me = _as_reviewer(db, user, r)
    ip, ua = _client_meta(request)
    tsr.agree(db, r, me, body.note, ip=ip, user_agent=ua)
    return tsr.state_for(db, r.employee_email, r.period_start, me, True)
