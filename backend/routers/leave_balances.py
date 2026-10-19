"""Paid leave balances - the API (Neil / Charmi call, Oct 19 2026). The
rules live in backend/leave_balances.py.

Employees read their own balance. HR (timesheet_review.is_hr: the company's
HR contact, an administrator, a Full HR grant) reads and corrects anyone's
in their reach, imports the opening balances and picks a person's policy.
The start date, the policies and Recalculate are company-wide, so they need
an administrator or a Full HR grant. A manager reads their direct reports'.
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

import leave_balances as lb
import models
import timesheet_review
from auth import _LEVELS, _MODULE_LEVEL_RANK, _module_level, get_current_user, level_for
from database import get_db

router = APIRouter(prefix="/leave-balances", tags=["Leave Balances"],
                   dependencies=[Depends(get_current_user)])


def _me(user: dict) -> str:
    return (user.get("email") or "").strip().lower()


def _hr_global(db: Session, me: str) -> bool:
    return (level_for(me, db) >= _LEVELS["administrator"]
            or _module_level(me, "hr", db) >= _MODULE_LEVEL_RANK["full"])


def _require_global(db: Session, me: str) -> None:
    if not _hr_global(db, me):
        raise HTTPException(403, "Only an administrator or HR with Full access can change this.")


def _hr_companies(db: Session, me: str) -> set:
    return {r[0] for r in db.query(models.HrEntity.id)
            .filter(func.lower(models.HrEntity.hr_contact_email) == me).all()}


def _can_manage(db: Session, me: str, email: str) -> bool:
    return timesheet_review.is_hr(db, me, email)


def _require_manage(db: Session, me: str, email: str) -> None:
    if not _can_manage(db, me, email):
        raise HTTPException(403, "You can't change this person's leave balance.")


@router.get("/me")
def my_balance(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return lb.balances(db, _me(user), with_entries=True)


@router.get("/person/{email}")
def person_balance(email: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me, email = _me(user), (email or "").strip().lower()
    emp = lb.employee(db, email)
    if emp is None:
        raise HTTPException(404, "Person not found")
    is_mgr = (emp.manager_email or "").strip().lower() == me
    if not (me == email or is_mgr or _can_manage(db, me, email)):
        raise HTTPException(403, "You can't see this person's leave balance.")
    out = lb.balances(db, email, emp=emp, with_entries=True)
    out["canEdit"] = _can_manage(db, me, email)
    return out


@router.get("/admin")
def admin_overview(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Everyone this HR person looks after, with their balances."""
    me = _me(user)
    glob = _hr_global(db, me)
    companies = set() if glob else _hr_companies(db, me)
    if not glob and not companies:
        raise HTTPException(403, "Leave balances are for HR.")
    q = (db.query(models.NexusEmployee)
         .filter(models.NexusEmployee.work_email != "",
                 models.NexusEmployee.status.in_(["active", "onboarding"]),
                 func.coalesce(models.NexusEmployee.identity_type, "internal") == "internal"))
    if not glob:
        q = q.filter(models.NexusEmployee.company.in_(list(companies)))
    pols = lb.policies(db)
    people = []
    for emp in q.order_by(models.NexusEmployee.first_name.asc(), models.NexusEmployee.last_name.asc()).all():
        email = (emp.work_email or "").strip().lower()
        if email == me and not glob:
            continue
        b = lb.balances(db, email, pols=pols, emp=emp)
        people.append({"email": email, "name": f"{emp.first_name or ''} {emp.last_name or ''}".strip() or email,
                       "company": emp.company or "", "department": emp.department or "", **b})
    return {"cutover": lb.cutover(db), "canSetup": glob, "policies": list(pols.values()),
            "defaults": list(lb.DEFAULT_POLICIES.keys()), "people": people}


class CutoverIn(BaseModel):
    date: str


@router.put("/cutover")
def set_cutover(body: CutoverIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    _require_global(db, me)
    try:
        lb.set_cutover(db, (body.date or "").strip()[:10], me)
    except ValueError:
        raise HTTPException(400, "Pick a valid start date.")
    db.commit()
    return {"cutover": lb.cutover(db)}


class PoliciesIn(BaseModel):
    policies: dict


@router.put("/policies")
def save_policies(body: PoliciesIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    _require_global(db, me)
    try:
        pols = lb.save_policies(db, body.policies, me)
    except ValueError as e:
        raise HTTPException(400, str(e))
    db.commit()
    return {"policies": list(pols.values())}


class ImportRow(BaseModel):
    email: str
    vacation: Optional[float] = None
    sick: Optional[float] = None


class ImportIn(BaseModel):
    rows: List[ImportRow]
    unit: str = "hours"          # hours | days (days x the person's policy hours a day)


@router.post("/import")
def import_opening(body: ImportIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The one-time import of what each person had left in QuickBooks on the
    start date. Re-importing a person replaces their opening numbers."""
    me = _me(user)
    if not lb.cutover(db):
        raise HTTPException(400, "Set the start date before importing balances.")
    if len(body.rows) > 2000:
        raise HTTPException(400, "Import at most 2,000 people at a time.")
    pols = lb.policies(db)
    done, errors = 0, []
    for i, r in enumerate(body.rows, start=1):
        email = (r.email or "").strip().lower()
        emp = lb.employee(db, email) if email else None
        if emp is None:
            errors.append({"row": i, "email": email, "error": "Not a person in Nexus"})
            continue
        if not _can_manage(db, me, email):
            errors.append({"row": i, "email": email, "error": "Not someone you look after"})
            continue
        vals = []
        for v in (r.vacation, r.sick):
            if v is None:
                vals.append(None)
                continue
            if v < 0 or v > 5000:
                vals.append("bad")
                continue
            hpd = float(lb.policy_for(db, email, emp, pols).get("hoursPerDay") or 8)
            vals.append(round(v * hpd, 4) if body.unit == "days" else float(v))
        if "bad" in vals:
            errors.append({"row": i, "email": email, "error": "Balances must be between 0 and 5,000"})
            continue
        if vals == [None, None]:
            errors.append({"row": i, "email": email, "error": "No vacation or sick number"})
            continue
        lb.set_opening(db, email, vals[0], vals[1], me)
        done += 1
    db.commit()
    return {"imported": done, "errors": errors}


class AdjustIn(BaseModel):
    email: str
    bucket: str
    hours: float
    note: str


@router.post("/adjust")
def adjust(body: AdjustIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me, email = _me(user), (body.email or "").strip().lower()
    _require_manage(db, me, email)
    if not lb.cutover(db):
        raise HTTPException(400, "Set the start date first.")
    if body.bucket not in lb.BUCKETS:
        raise HTTPException(400, "bucket must be vacation or sick")
    if not body.hours or abs(body.hours) > 5000:
        raise HTTPException(400, "Enter the hours to add (or a negative number to take away).")
    note = (body.note or "").strip()
    if not note:
        raise HTTPException(400, "Add a note saying why.")
    from routers import timeclock
    row = lb.add_entry(db, email, body.bucket, body.hours, "adjust", timeclock._employee_today(db, email), note, me)
    db.commit()
    return lb.entry_dict(row)


class AssignIn(BaseModel):
    email: str
    policy_id: str = ""          # '' = the default for their country


@router.put("/assign")
def assign_policy(body: AssignIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me, email = _me(user), (body.email or "").strip().lower()
    _require_manage(db, me, email)
    pid = (body.policy_id or "").strip()
    if pid and pid not in lb.policies(db):
        raise HTTPException(400, "Unknown policy")
    emp = lb.employee(db, email)
    if emp is None:
        raise HTTPException(404, "Person not found")
    emp.leave_policy = pid
    db.commit()
    return lb.balances(db, email, emp=emp)


@router.post("/recalculate")
def recalculate(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Rebuild the earned / used rows of every period finalized since the
    start date - after the start date or a policy changes."""
    me = _me(user)
    _require_global(db, me)
    cut = lb.cutover(db)
    if not cut:
        raise HTTPException(400, "Set the start date first.")
    rows = (db.query(models.TimeApproval)
            .filter(models.TimeApproval.kind == "final", models.TimeApproval.revoked == 0,
                    models.TimeApproval.period_end >= cut).all())
    periods, failed = 0, []
    for r in rows:
        try:
            lb.record_period(db, r.employee_email, r.period_start, r.period_end, r.id, me)
            periods += 1
        except Exception as e:  # noqa: BLE001 - one bad card never stops the rest
            failed.append({"email": r.employee_email, "start": r.period_start, "error": str(e)[:200]})
    db.commit()
    return {"periods": periods, "failed": failed}
