"""KPI scorecards API (Oct 30 2026). Rules are perf_scorecards.py; this file is
shapes and the HR check. Settings > Performance > KPI Scorecards, per company:
a scorecard per job role, shared sets to copy from, the KPI library."""
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


def _company(db: Session, company: str) -> str:
    cid = (company or "").strip()
    if not cid:
        raise HTTPException(400, "Pick the company")
    if not db.get(models.HrEntity, cid):
        raise HTTPException(404, "Company not found")
    return cid


def _may_read(db: Session, user: dict, cid: str) -> bool:
    if perf.hr_for(db, user, cid):
        return True
    emp = perf.employee(db, _me(user))
    return bool(emp and (emp.company or "") == cid)


def _require_hr(db: Session, user: dict, cid: str) -> None:
    if not perf.hr_for(db, user, cid):
        raise HTTPException(403, "KPI scorecards are set by HR for the company")


# ── library ──────────────────────────────────────────────────────────────────
class KpiIn(BaseModel):
    company: str = ""
    name: str = ""
    description: str = ""
    unit: str = "rating"
    direction: str = "high"


@router.get("/kpis")
def list_kpis(company: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    cid = _company(db, company)
    if not _may_read(db, user, cid):
        raise HTTPException(404, "Company not found")
    return {"kpis": sc.library(db, cid, include_inactive=True), "manualMax": sc.MANUAL_MAX, "canEdit": bool(perf.hr_for(db, user, cid))}


@router.post("/kpis", status_code=201)
def create_kpi(body: KpiIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    cid = (body.company or "").strip()
    if cid:
        _company(db, cid)
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
    """Every job role of the company with its version in force and the one
    starting next month, the shared sets, and the library."""
    _me(user)
    cid = _company(db, company)
    if not _may_read(db, user, cid):
        raise HTTPException(404, "Company not found")
    lib = sc.library_map(db, cid)
    today = date.today()
    roles = []
    for r in sc.job_roles(db, cid):
        cur, up = sc.active_for(db, r["id"], today), sc.upcoming_for(db, r["id"], today)
        roles.append({**r, "current": sc.version_out(db, cur, lib) if cur else None,
                      "upcoming": sc.version_out(db, up, lib) if up else None,
                      "versions": len(sc.versions(db, r["id"])),
                      "suggestion": sc.suggestion_for(r["department"], r["name"])})
    return {"company": cid, "roles": roles, "shared": [sc.version_out(db, s, lib) for s in sc.shared_sets(db, cid)],
            "kpis": sc.library(db, cid), "manualMax": sc.MANUAL_MAX, "nextMonth": sc.next_month_start(today),
            "canEdit": bool(perf.hr_for(db, user, cid)), "canEditEveryCompany": perf.hr_reach(db, user) is None}


@router.get("/scorecards/current")
def my_scorecard(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The scorecard in force for the caller's own role (Workday)."""
    me = _me(user)
    role = sc.role_of_person(db, me)
    if not role:
        return {"scorecard": None, "role": None}
    cur = sc.active_for(db, role.id)
    return {"scorecard": sc.version_out(db, cur) if cur else None, "role": {"id": role.id, "name": role.name}}


class ScorecardIn(BaseModel):
    company: str = ""
    roleId: str = ""
    items: list = []
    notes: str = ""
    copiedFrom: str = ""


@router.put("/scorecards")
def save_scorecard(body: ScorecardIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    cid = _company(db, body.company)
    _require_hr(db, user, cid)
    row = sc.save(db, user, cid, body.roleId, body.items, body.notes, body.copiedFrom)
    db.commit()
    return sc.version_out(db, row)


@router.get("/scorecards/copy-source/{source_id}")
def copy_source(source_id: str, company: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The rows to copy from a shared set or another role (the form fills its draft with them)."""
    _me(user)
    cid = _company(db, company)
    if not _may_read(db, user, cid):
        raise HTTPException(404, "Company not found")
    rows, label = sc.copy_source(db, cid, source_id)
    return {"items": rows, "copiedFrom": label}


class SharedIn(BaseModel):
    company: str = ""              # "" = a set every company may copy (HR for every company)
    id: str = ""
    name: str = ""
    items: list = []
    notes: str = ""


@router.put("/scorecards/shared")
def save_shared(body: SharedIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    cid = (body.company or "").strip()
    if cid:
        _company(db, cid)
        _require_hr(db, user, cid)
    elif perf.hr_reach(db, user) is not None:
        raise HTTPException(403, "A set for every company is kept by HR with access to every company")
    if body.id:
        existing = db.get(models.PerfScorecard, body.id)
        if existing and existing.kind == sc.SHARED and (existing.company_id or "") != cid:
            raise HTTPException(404, "Shared set not found")
    row = sc.save_shared(db, user, cid, body.id, body.name, body.items, body.notes)
    db.commit()
    return sc.version_out(db, row)


@router.post("/scorecards/{sid}/retire")
def retire_scorecard(sid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A role's: stop scoring it this month (a future version is dropped). A shared set: delete it."""
    _me(user)
    row = db.get(models.PerfScorecard, sid)
    if not row:
        raise HTTPException(404, "Scorecard not found")
    if row.company_id:
        _require_hr(db, user, row.company_id)
    elif perf.hr_reach(db, user) is not None:
        raise HTTPException(403, "A set for every company is kept by HR with access to every company")
    sc.retire(db, row)
    db.commit()
    return {"ok": True}


@router.get("/scorecards/{sid}/history")
def scorecard_history(sid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _me(user)
    row = db.get(models.PerfScorecard, sid)
    if not row or row.kind != "role" or not _may_read(db, user, row.company_id):
        raise HTTPException(404, "Scorecard not found")
    lib = sc.library_map(db, row.company_id)
    return [sc.version_out(db, v, lib) for v in sc.versions(db, row.role_id)]
