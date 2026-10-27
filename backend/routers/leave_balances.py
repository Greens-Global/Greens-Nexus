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
import leave_year_end as lye
import models
import scoped_settings
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


def _with_year_end(db: Session, email: str, out: dict, emp=None) -> dict:
    """What happens to each bucket at the next year end (leave_year_end.py)."""
    if out.get("live"):
        try:
            out["yearEnd"] = lye.rules_for(db, email, emp)
        except Exception:  # noqa: BLE001 - the balance shows without it
            pass
    return out


@router.get("/me")
def my_balance(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _with_year_end(db, _me(user), lb.balances(db, _me(user), with_entries=True))


@router.get("/person/{email}")
def person_balance(email: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me, email = _me(user), (email or "").strip().lower()
    emp = lb.employee(db, email)
    if emp is None:
        raise HTTPException(404, "Person not found")
    is_mgr = (emp.manager_email or "").strip().lower() == me
    if not (me == email or is_mgr or _can_manage(db, me, email)):
        raise HTTPException(403, "You can't see this person's leave balance.")
    out = _with_year_end(db, email, lb.balances(db, email, emp=emp, with_entries=True), emp)
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
    return {"cutover": lb.cutover(db), "companies": _company_cutovers(db), "canSetup": glob,
            "policies": list(pols.values()), "defaults": list(lb.DEFAULT_POLICIES.keys()), "people": people}


def _company_cutovers(db: Session) -> list:
    """Each company with the start date that applies to it and whether it is
    its own (Oct 23: a company may have one of its own)."""
    own = lb.company_cutovers(db)
    return [{"id": e.id, "name": e.name or "", "cutover": own.get(e.id) or lb.cutover(db), "own": e.id in own}
            for e in db.query(models.HrEntity).order_by(models.HrEntity.name).all()]


class CutoverIn(BaseModel):
    date: str = ""
    company: str = ""      # '' = the organization's; else that company's own
    reset: bool = False    # a company: drop its own and follow the organization's


@router.put("/cutover")
def set_cutover(body: CutoverIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    _require_global(db, me)
    cid = (body.company or "").strip()
    if cid and not db.query(models.HrEntity.id).filter(models.HrEntity.id == cid).first():
        raise HTTPException(404, "Company not found.")
    if body.reset and cid:
        lb.clear_cutover(db, cid)
    else:
        try:
            lb.set_cutover(db, (body.date or "").strip()[:10], me, cid)
        except ValueError:
            raise HTTPException(400, "Pick a valid start date.")
    db.commit()
    return {"cutover": lb.cutover(db), "companies": _company_cutovers(db)}


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
    if not lb.any_cutover(db):
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
    if not lb.cutover_for(db, email):
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
    # From the earliest start date anywhere; each person's own is applied
    # inside record_period (period_entries).
    cut = min([d for d in [lb.cutover(db), *lb.company_cutovers(db).values()] if d] or [""])
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


# ── Year end (Neil, Oct 27 2026 - leave_year_end.py) ────────────────────────
# Use It Or Lose It by default; per company and bucket a company may carry
# everything or up to a cap. California vacation never expires (the law).

def _company_param(db: Session, company: str) -> str:
    cid = (company or "").strip()
    if cid and not db.query(models.HrEntity.id).filter(models.HrEntity.id == cid).first():
        raise HTTPException(404, "Company not found.")
    return cid


def _require_year_end(db: Session, me: str, cid: str) -> None:
    """HR for that company: an administrator or a Full HR grant anywhere, or
    the company's own HR contact. Every company at once needs the first."""
    if _hr_global(db, me):
        return
    if cid and cid in _hr_companies(db, me):
        return
    raise HTTPException(403, "Year-end balances are for HR.")


def _year_end_settings(db: Session, cid: str) -> dict:
    return {**lye.config(db, cid), "company": cid,
            "hasOverride": scoped_settings.has_override(db, lye.SETTING_KEY, cid),
            "modes": [{"id": m, "label": lye.MODE_LABEL[m]} for m in lye.MODES],
            "legal": [{"state": k, "note": v} for k, v in lye.NO_FORFEIT_VACATION.items()],
            "companies": [{"id": e.id, "name": e.name or ""}
                          for e in db.query(models.HrEntity).order_by(models.HrEntity.name).all()]}


@router.get("/year-end/settings")
def get_year_end_settings(company: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    cid = _company_param(db, company)
    _require_year_end(db, _me(user), cid)
    return _year_end_settings(db, cid)


class YearEndIn(BaseModel):
    vacationMode: str = "reset"
    vacationCap: float = 0
    vacationCapUnit: str = "hours"
    vacationYear: str = "calendar"
    sickMode: str = "reset"
    sickCap: float = 0
    sickCapUnit: str = "hours"
    reset: bool = False          # a company: drop its own and follow the default


@router.put("/year-end/settings")
def save_year_end_settings(body: YearEndIn, company: str = "", user: dict = Depends(get_current_user),
                           db: Session = Depends(get_db)):
    """The default for every company (company '') or one company's own. A
    rule that shapes everyone's balance, so administrators and Full HR only -
    and a company-limited administrator changes only their own companies."""
    me, cid = _me(user), _company_param(db, company)
    _require_global(db, me)
    from routers.timeclock import _require_company_manage
    _require_company_manage(user, db, cid, "the leave year-end rule")
    if body.reset and cid:
        scoped_settings.reset(db, lye.SETTING_KEY, cid)
    else:
        try:
            cfg = lye.clean(body.model_dump(exclude={"reset"}))
        except ValueError as e:
            raise HTTPException(400, str(e))
        scoped_settings.save(db, lye.SETTING_KEY, cid, cfg, me)
    db.commit()
    return _year_end_settings(db, cid)


@router.get("/year-end/preview")
def year_end_preview(company: str = "", period: str = "next", user: dict = Depends(get_current_user),
                     db: Session = Depends(get_db)):
    """What a company's year end will do (period 'next', from today's
    balances) or did / still owes (period 'last'). company '' = everyone,
    for an administrator or Full HR."""
    me, cid = _me(user), _company_param(db, company)
    glob = _hr_global(db, me)
    mine = _hr_companies(db, me)
    if not cid and not glob and mine:
        cid = sorted(mine)[0]          # an HR contact opens on their own company
    _require_year_end(db, me, cid)
    if period not in ("next", "last"):
        raise HTTPException(400, "period is next or last")
    if not lb.any_cutover(db):
        raise HTTPException(400, "Set the balance start date first.")
    out = lye.preview(db, cid if cid else None, period)
    out["canAll"] = glob
    out["companies"] = [{"id": e.id, "name": e.name or ""}
                        for e in db.query(models.HrEntity).order_by(models.HrEntity.name).all()
                        if glob or e.id in mine]
    return out


class YearEndApplyIn(BaseModel):
    company: str = ""


@router.post("/year-end/apply")
def year_end_apply(body: YearEndApplyIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Settle the year that has ended now, instead of waiting for the daily
    pass (which settles each one for 45 days after it). Writes only what is
    still owed - running it again changes nothing."""
    me, cid = _me(user), _company_param(db, body.company)
    _require_year_end(db, me, cid)
    if not lb.any_cutover(db):
        raise HTTPException(400, "Set the balance start date first.")
    out = lye.apply_people(db, lye.people(db, cid if cid else None), me)
    return {**out, "preview": lye.preview(db, cid if cid else None, "last")}
