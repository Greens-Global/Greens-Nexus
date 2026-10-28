"""People > Analytics (Neil, Oct 27 2026). Every number is calculated in
hr_analytics.py; this router only checks who is asking and passes their
People scope through.

  GET /hr/analytics/summary  - the cards: headcount, joiners and leavers,
                               attrition, tenure, absence, leave liability
  GET /hr/analytics/people   - the people behind one number (the drill-down)

Access: the People grant (hr, viewer) narrowed by auth.hr_scope - a
company-scoped HR admin sees their companies only, and the multi-company
walls apply. The manager tier (team-limited People) is refused: the /hr
allowlist (auth.TEAM_ALLOWED_HR_ROUTES) does not include these routes, and
the check below says so again. Money (the leave liability amounts, rates
and currencies) needs the hr_comp grant or owner, exactly like Pay &
Benefits; without it the answer carries hours only.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

import hr_analytics as ha
import models
from auth import hr_scope, is_team_scope
from database import get_db
from routers.hr import _has_comp, require_hr_read

router = APIRouter(prefix="/hr/analytics", tags=["hr-analytics"])


def _dataset(db: Session, user: dict, company: str, type_: str, from_: str, to: str) -> ha.Dataset:
    scope = hr_scope(user, db)
    if is_team_scope(scope):
        raise HTTPException(403, "People Analytics is for HR - as a manager, People shows your own team.")
    company = (company or "").strip()
    if company:
        if scope is not None and company not in scope:
            raise HTTPException(404, "Company not found.")
        if not db.query(models.HrEntity.id).filter(models.HrEntity.id == company).first():
            raise HTTPException(404, "Company not found.")
    type_ = (type_ or "employees").strip().lower()
    if type_ not in ha.TYPE_FILTERS:
        raise HTTPException(400, "type must be employees, contractors or all.")
    return ha.build(db, scope, _has_comp(user, db), company, type_, from_, to)


def _companies(db: Session, user: dict) -> list:
    scope = hr_scope(user, db)
    q = db.query(models.HrEntity.id, models.HrEntity.name)
    if scope is not None:
        q = q.filter(models.HrEntity.id.in_(sorted(scope) or [""]))
    return [{"id": r.id, "name": r.name} for r in q.order_by(models.HrEntity.name.asc()).all()]


@router.get("/summary")
def summary(company: str = "", type: str = "employees", from_month: str = "", to_month: str = "",
            parts: str = "", user: dict = Depends(require_hr_read), db: Session = Depends(get_db)):
    ds = _dataset(db, user, company, type, from_month, to_month)
    want = [p for p in (parts or "").split(",") if p in ha.PARTS] or list(ha.PARTS)
    out = ha.summary(ds, want)
    out.update(company=(company or "").strip(), type=(type or "employees").strip().lower(),
               companies=_companies(db, user))
    return out


@router.get("/people")
def people(metric: str, month: str = "", key: str = "", company: str = "", type: str = "employees",
           from_month: str = "", to_month: str = "", user: dict = Depends(require_hr_read),
           db: Session = Depends(get_db)):
    ds = _dataset(db, user, company, type, from_month, to_month)
    try:
        return ha.drill(ds, (metric or "").strip(), month, key)
    except ValueError as e:
        raise HTTPException(400, str(e))
