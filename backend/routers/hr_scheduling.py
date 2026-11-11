"""People > a person's Time & Scheduling: Work Limits and availability
(Neil, 11/11/2026, Deputy parity - the "stress profile" and the
unavailability on an employee's profile).

  GET/PUT /hr/employees/{eid}/work-limits    limits HR sets for ONE person
  GET/PUT /hr/employees/{eid}/availability   when they can work, as the
                                             planner reads it

Work Limits live on the person (NexusEmployee.work_limits) and are read by
shift_rules.evaluate - a warning past the tighter of theirs and the
company's, never a block. Availability is the person's own
(ShiftAvailability / ShiftAvailabilityDate / ShiftAvailabilityPref, set in
My Workday > Shifts); HR may set it for someone who has no phone at work,
through the same save (timeclock.save_availability_for). The manager tier
reads both for their own team (auth.TEAM_ALLOWED_HR_ROUTES) and changes
neither.
"""
import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

import shift_rules
from auth import hr_scope
from database import get_db
from models import AuditLog, NexusEmployee
from routers.hr import _assert_scope, require_hr_read, require_hr_write
from routers.timeclock import AvailIn, _my_availability_payload, _now_iso, save_availability_for

router = APIRouter(prefix="/hr", tags=["hr"])


def _employee(db: Session, eid: str, user: dict, lock: bool = False) -> NexusEmployee:
    q = db.query(NexusEmployee).filter(NexusEmployee.id == eid)
    emp = (q.with_for_update() if lock else q).first()
    if emp is None:
        raise HTTPException(404, "Employee not found")
    _assert_scope(emp, hr_scope(user, db))
    return emp


def _can_write(user: dict, db: Session) -> bool:
    from auth import _LEVELS, _MODULE_LEVEL_RANK, _module_level, hr_team_limited
    if hr_team_limited(user):
        return False
    return (user.get("level", 0) >= _LEVELS["administrator"]
            or _module_level(user.get("email") or "", "hr", db) >= _MODULE_LEVEL_RANK["editor"])


def _audit(db: Session, user: dict, emp: NexusEmployee, action: str, details: dict) -> None:
    db.add(AuditLog(timestamp=_now_iso(), user_email=user["email"], user_role=str(user.get("role") or ""),
                    action=action, resource_type="employee", resource_id=emp.id,
                    details=json.dumps({"employee": emp.work_email or "", **details})[:4000]))


def _editable(emp: NexusEmployee) -> None:
    if emp.deleted_at:
        raise HTTPException(409, "This person was removed from Nexus - restore them to edit their record")


# ── Work Limits ──────────────────────────────────────────────────────────

@router.get("/employees/{eid}/work-limits")
def get_work_limits(eid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    emp = _employee(db, eid, user)
    lim = emp.work_limits if isinstance(emp.work_limits, dict) else {}
    return {"limits": {k: int(lim.get(k) or 0) for k in shift_rules.LIMIT_KEYS},
            "canEdit": _can_write(user, db) and not emp.deleted_at}


@router.put("/employees/{eid}/work-limits")
def put_work_limits(eid: str, body: dict, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """Replaces the person's Work Limits; a limit left out or 0 is none."""
    emp = _employee(db, eid, user, lock=True)
    _editable(emp)
    try:
        clean = shift_rules.clean_limits((body or {}).get("limits", body or {}))
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    before = emp.work_limits if isinstance(emp.work_limits, dict) else {}
    emp.work_limits = clean
    emp.updated_at = _now_iso()
    if clean != before:
        _audit(db, user, emp, "Changed work limits", {"before": before, "after": clean})
    db.commit()
    return {"limits": {k: int(clean.get(k) or 0) for k in shift_rules.LIMIT_KEYS}, "canEdit": True}


# ── Availability ─────────────────────────────────────────────────────────

def _availability_view(db: Session, emp: NexusEmployee, user: dict) -> dict:
    em = (emp.work_email or "").lower()
    if not em:
        return {"days": [], "dates": [], "prefs": {"preferredHoursWeek": 0, "maxHoursWeek": 0},
                "today": "", "canEdit": False, "noEmail": True}
    out = _my_availability_payload(db, em)
    # People shows what still matters: today on. Past dates stay on record.
    out["dates"] = [d for d in out.get("dates") or [] if (d.get("date") or "") >= (out.get("today") or "")]
    out["canEdit"] = _can_write(user, db) and not emp.deleted_at
    return out


@router.get("/employees/{eid}/availability")
def get_availability(eid: str, user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    return _availability_view(db, _employee(db, eid, user), user)


@router.put("/employees/{eid}/availability")
def put_availability(eid: str, body: AvailIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    """HR sets availability for someone (a crew member with no phone at
    work): the same rules and the same rows as the person's own save."""
    emp = _employee(db, eid, user)
    _editable(emp)
    em = (emp.work_email or "").lower()
    if not em:
        raise HTTPException(400, "This person needs a work email first - the schedule keys off it.")
    save_availability_for(db, em, body)
    _audit(db, user, emp, "Changed availability for them",
           {"days": body.days is not None, "dates": body.dates is not None, "prefs": body.prefs is not None})
    db.commit()
    return _availability_view(db, emp, user)
