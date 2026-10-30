"""KPI scorecards API (Oct 30 2026). Rules are perf_scorecards.py; this file is
shapes and the HR check. Settings > Performance > KPI Scorecards, per company."""
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
import perf_scorecards as sc
import performance as perf
from auth import get_current_user
from database import get_db

router = APIRouter(prefix="/performance", tags=["Performance Scorecards"], dependencies=[Depends(get_current_user)])


def _me(user: dict) -> str:
    perf.require_internal(user)
    return (user.get("email") or "").strip().lower()


def _company(db: Session, user: dict, company: str) -> str:
    cid = (company or "").strip()
    if not cid:
        raise HTTPException(400, "Pick the company")
    if not db.get(models.HrEntity, cid):
        raise HTTPException(404, "Company not found")
    return cid


def _may_read(db: Session, user: dict, cid: str, department: str = "") -> bool:
    if perf.hr_for(db, user, cid):
        return True
    me = _me(user)
    if department and me in sc.heads_of(db, cid, department):
        return True
    emp = perf.employee(db, me)
    return bool(emp and (emp.company or "") == cid and (not department or (emp.department or "").strip().lower() == department.strip().lower()))


def _require_hr(db: Session, user: dict, cid: str) -> None:
    if not perf.hr_for(db, user, cid):
        raise HTTPException(403, "KPI scorecards are set by HR for the company")


# ── library ──────────────────────────────────────────────────────────────────
class KpiIn(BaseModel):
    company: str = ""              # "" = every company (HR for every company only)
    name: str = ""
    description: str = ""
    unit: str = "rating"           # % | count | per100 | rating
    direction: str = "high"        # high | low


@router.get("/kpis")
def list_kpis(company: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    cid = _company(db, user, company)
    if not _may_read(db, user, cid):
        raise HTTPException(404, "Company not found")
    return {"kpis": sc.library(db, cid, include_inactive=True), "manualMax": sc.MANUAL_MAX, "canEdit": bool(perf.hr_for(db, user, cid))}


@router.post("/kpis", status_code=201)
def create_kpi(body: KpiIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    cid = (body.company or "").strip()
    if cid:
        _company(db, user, cid)
        _require_hr(db, user, cid)
    elif perf.hr_reach(db, user) is not None:
        raise HTTPException(403, "A KPI for every company is added by HR with access to every company")
    row = sc.create_manual_kpi(db, user, cid, body.name, body.description, body.unit, body.direction)
    db.commit()
    return {"id": row.id, "key": row.key, "name": row.name}


class KpiPatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    active: Optional[bool] = None


@router.patch("/kpis/{kid}")
def update_kpi(kid: str, body: KpiPatch, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    row = db.get(models.PerfKpi, kid)
    if not row:
        raise HTTPException(404, "KPI not found")
    if row.company_id:
        _require_hr(db, user, row.company_id)
    elif perf.hr_reach(db, user) is not None:
        raise HTTPException(403, "A KPI for every company is changed by HR with access to every company")
    if body.name is not None and body.name.strip():
        row.name = body.name.strip()
    if body.description is not None:
        row.description = body.description.strip()
    if body.active is not None:
        row.active = bool(body.active)
    db.commit()
    return {"ok": True}


# ── scorecards ───────────────────────────────────────────────────────────────
@router.get("/scorecards")
def list_scorecards(company: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Every department of the company with its version in force, the one
    starting next month if any, and how many versions there have been."""
    _me(user)
    cid = _company(db, user, company)
    if not _may_read(db, user, cid):
        raise HTTPException(404, "Company not found")
    lib = sc.library_map(db, cid)
    today = date.today()
    out = []
    for d in sc.departments_of(db, cid):
        cur = sc.active_for(db, cid, d["name"], today)
        up = sc.upcoming_for(db, cid, d["name"], today)
        out.append({**d, "current": sc.version_out(db, cur, lib) if cur else None,
                    "upcoming": sc.version_out(db, up, lib) if up else None,
                    "versions": len(sc.versions(db, cid, d["name"])),
                    "suggestion": sc.suggestion_for(d["name"])})
    return {"company": cid, "departments": out, "kpis": sc.library(db, cid), "manualMax": sc.MANUAL_MAX,
            "nextMonth": sc.next_month_start(today), "canEdit": bool(perf.hr_for(db, user, cid))}


@router.get("/scorecards/current")
def my_scorecard(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The scorecard in force for the caller's own department (Workday)."""
    me = _me(user)
    emp = perf.employee(db, me)
    if not emp or not (emp.company or "") or not (emp.department or "").strip():
        return {"scorecard": None}
    cur = sc.active_for(db, emp.company, emp.department)
    return {"scorecard": sc.version_out(db, cur) if cur else None, "department": emp.department, "company": emp.company}


class ScorecardIn(BaseModel):
    company: str = ""
    department: str = ""
    items: list = []
    notes: str = ""


@router.put("/scorecards")
def save_scorecard(body: ScorecardIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    cid = _company(db, user, body.company)
    _require_hr(db, user, cid)
    row = sc.save(db, user, cid, body.department, body.items, body.notes)
    db.commit()
    return sc.version_out(db, row)


@router.post("/scorecards/{sid}/retire")
def retire_scorecard(sid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    row = db.get(models.PerfScorecard, sid)
    if not row:
        raise HTTPException(404, "Scorecard not found")
    _require_hr(db, user, row.company_id)
    sc.retire(db, row)
    db.commit()
    return {"ok": True}


@router.get("/scorecards/{sid}/history")
def scorecard_history(sid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    row = db.get(models.PerfScorecard, sid)
    if not row or not _may_read(db, user, row.company_id, row.department):
        raise HTTPException(404, "Scorecard not found")
    lib = sc.library_map(db, row.company_id)
    return [sc.version_out(db, v, lib) for v in sc.versions(db, row.company_id, row.department)]
