"""Accounting -> Loans & Financing: amortization schedules and rate stress
scenarios per loan (Charmi and Neil, 10/06).

  Amortization   "Add in Amortization schedule for Commercial loans, allow us
                 to build it or upload an existing file from the bank." One
                 schedule per loan, kept in Nexus (accounting_loan_schedules):
                 built on screen from principal / rate / term / amortization
                 / interest-only months / day count (frontend loanMath.js -
                 the arithmetic lives in one tested place), or read from the
                 bank's Excel / CSV with the columns mapped by hand. The
                 bank's original file is kept in the PRIVATE task-files
                 bucket; only its canonical storage URL is stored here.
  Stress         "If the interest rate were to go up, we should be able to
                 calculate if the income will support the loan." The figures
                 are computed on screen; a scenario worth keeping (its
                 inputs only) is saved here.

The loan itself is a fin_loans row in the accounting app - Nexus never keeps
a copy. Every route resolves the loan through accounting_loans._loan_rows,
which already drops the loans of entities the caller may not read (Neil,
Sep 25), so a limited person cannot read or write a schedule of a loan
outside their entities: it answers 404 like a loan that does not exist.
Reading takes the Accounting grant, writing its editor level, like the
loans screen itself. Sync DB work runs in a thread (CLAUDE.md: never block
the loop).
"""
import asyncio
import os
import re
import uuid
from datetime import date, datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import models
from auth import require_module_grant
from database import SessionLocal
from routers import accounting, accounting_loans
from routers.accounting import entity_scope

router = APIRouter(prefix="/accounting/loan-plans", tags=["Accounting"], dependencies=[Depends(require_module_grant("accounting", "viewer"))])
_edit = require_module_grant("accounting", "editor")

MAX_ROWS = 1200                 # 100 years of monthly payments
MAX_SCENARIOS = 50              # per loan
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_BUCKET = "task-files"          # private (Sep 22); the bank's file lives under accounting/loan-schedules/
_SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


async def _loan(scope: dict, loan_id: str) -> dict:
    """The fin_loans row, if the caller may read its entity - else 404."""
    rows = await accounting_loans._loan_rows(scope, date.today().isoformat()[:7])
    cur = next((r for r in rows if str(r.get("id")) == str(loan_id)), None)
    if not cur:
        raise HTTPException(status_code=404, detail="Loan not found in your entities.")
    return cur


def _num(v: Any, field: str) -> float:
    if v is None or v == "":
        return 0.0
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{field} must be a number.")
    if f != f or abs(f) > 1e13:   # NaN or absurd
        raise HTTPException(status_code=400, detail=f"{field} is out of range.")
    return round(f, 2)


def clean_rows(rows: list) -> list[dict]:
    """The schedule rows as stored: dated, in date order, numbered from 1,
    every amount a number rounded to cents."""
    if not isinstance(rows, list) or not rows:
        raise HTTPException(status_code=400, detail="The schedule has no rows.")
    if len(rows) > MAX_ROWS:
        raise HTTPException(status_code=400, detail=f"A schedule holds up to {MAX_ROWS} payments.")
    out = []
    for i, r in enumerate(rows):
        if not isinstance(r, dict):
            raise HTTPException(status_code=400, detail=f"Row {i + 1} is not a payment.")
        d = str(r.get("date") or "")[:10]
        if not _DATE.match(d):
            raise HTTPException(status_code=400, detail=f"Row {i + 1} has no date (YYYY-MM-DD).")
        try:
            date.fromisoformat(d)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Row {i + 1} has an impossible date ({d}).")
        out.append({"date": d, **{k: _num(r.get(k), f"Row {i + 1} {k}") for k in ("payment", "interest", "principal", "balloon", "balance")}})
    out.sort(key=lambda r: r["date"])
    return [{"n": i + 1, **r} for i, r in enumerate(out)]


def check_file_url(url: Optional[str]) -> str:
    """The bank's file: empty, or our own storage under the private
    task-files bucket (the canonical .../object/public/task-files/... URL the
    viewer rewrites - api.js turns the viewer URL back into it on the way
    here)."""
    u = (url or "").strip()
    if not u:
        return ""
    marker = f"/storage/v1/object/public/{_BUCKET}/"
    if _SUPABASE_URL:
        ok = u.startswith(f"{_SUPABASE_URL}{marker}")
    else:
        ok = u.startswith("https://") and marker in u
    if not ok or len(u) > 1000:
        raise HTTPException(status_code=400, detail="The bank's file must be stored in Nexus (task-files storage).")
    return u


def _ser(s: models.AccountingLoanSchedule) -> dict:
    return {"id": s.id, "loanId": s.loan_id, "entityCode": s.entity_code or "", "source": s.source or "build", "params": s.params or {}, "rows": s.rows or [],
            "columnMap": s.column_map or {}, "fileUrl": s.file_url or "", "fileName": s.file_name or "", "by": s.saved_by or "", "at": s.saved_at or ""}


def _ser_scenario(s: models.AccountingLoanStressScenario) -> dict:
    return {"id": s.id, "loanId": s.loan_id, "name": s.name or "", "params": s.params or {}, "by": s.saved_by or "", "at": s.saved_at or ""}


def expected_balance(rows: list[dict], month: str) -> Optional[dict]:
    """What the schedule says is owed at the end of `month` (YYYY-MM): the
    balance after the last payment dated in or before that month. Before the
    first payment the loan is at its starting balance (the first row's
    balance plus its principal and balloon); None for an empty schedule."""
    if not rows:
        return None
    last = None
    for r in rows:
        if r["date"][:7] <= month:
            last = r
        else:
            break
    if last is None:
        first = rows[0]
        return {"balance": round(first["balance"] + first["principal"] + first.get("balloon", 0), 2), "asOf": None, "n": 0}
    return {"balance": last["balance"], "asOf": last["date"], "n": last["n"]}


# ── Schedules ───────────────────────────────────────────────────────────────
@router.get("/expected")
async def expected(month: Optional[str] = None, scope: dict = Depends(entity_scope)):
    """Every loan with a schedule the caller may read, and the balance its
    schedule expects at the end of the month - for comparing with the ledger
    on the Loans review without opening each schedule."""
    month = accounting_loans._month(month)
    allowed = scope["allowed"]
    reach = None if allowed is None else (await accounting._with_children(allowed) if allowed else set())

    def _load():
        db = SessionLocal()
        try:
            q = db.query(models.AccountingLoanSchedule)
            if reach is not None:
                if not reach:
                    return []
                q = q.filter(models.AccountingLoanSchedule.entity_code.in_(tuple(reach)))
            return [(s.loan_id, s.source, s.rows or []) for s in q.all()]
        finally:
            db.close()
    out = {}
    for loan_id, source, rows in await asyncio.to_thread(_load):
        e = expected_balance(rows, month)
        if e:
            out[loan_id] = {**e, "source": source}
    return {"month": month, "loans": out}


@router.get("/{loan_id}/schedule")
async def get_schedule(loan_id: str, scope: dict = Depends(entity_scope)):
    """The loan's schedule, or null when none is kept yet."""
    await _loan(scope, loan_id)

    def _load():
        db = SessionLocal()
        try:
            s = db.query(models.AccountingLoanSchedule).filter(models.AccountingLoanSchedule.loan_id == loan_id).first()
            return _ser(s) if s else None
        finally:
            db.close()
    return {"schedule": await asyncio.to_thread(_load)}


class ScheduleBody(BaseModel):
    source: str = "build"
    params: dict = {}
    rows: list = []
    columnMap: dict = {}
    fileUrl: Optional[str] = ""
    fileName: Optional[str] = ""


@router.put("/{loan_id}/schedule")
async def put_schedule(loan_id: str, body: ScheduleBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    """Keep (or replace) the loan's schedule."""
    if body.source not in ("build", "upload"):
        raise HTTPException(status_code=400, detail="A schedule is built or uploaded.")
    loan = await _loan(scope, loan_id)
    rows = clean_rows(body.rows)
    file_url = check_file_url(body.fileUrl) if body.source == "upload" else ""
    file_name = (body.fileName or "").strip()[:200] if body.source == "upload" else ""
    params = body.params if body.source == "build" else {}
    if len(str(params)) > 4000 or len(str(body.columnMap)) > 2000:
        raise HTTPException(status_code=400, detail="The schedule's settings are too long.")
    me = user["email"].lower()
    entity = str(loan.get("entity_code") or "")

    def _save():
        db = SessionLocal()
        try:
            s = db.query(models.AccountingLoanSchedule).filter(models.AccountingLoanSchedule.loan_id == loan_id).first()
            if not s:
                s = models.AccountingLoanSchedule(id=str(uuid.uuid4()), loan_id=loan_id)
                db.add(s)
            s.entity_code, s.source, s.params, s.rows = entity, body.source, params, rows
            s.column_map = body.columnMap if body.source == "upload" else {}
            s.file_url, s.file_name, s.saved_by, s.saved_at = file_url, file_name, me, _now()
            db.commit()
            return _ser(s)
        finally:
            db.close()
    return {"schedule": await asyncio.to_thread(_save)}


@router.delete("/{loan_id}/schedule")
async def delete_schedule(loan_id: str, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    await _loan(scope, loan_id)

    def _del():
        db = SessionLocal()
        try:
            n = db.query(models.AccountingLoanSchedule).filter(models.AccountingLoanSchedule.loan_id == loan_id).delete(synchronize_session=False)
            db.commit()
            return n
        finally:
            db.close()
    return {"deleted": await asyncio.to_thread(_del)}


# ── Stress scenarios ────────────────────────────────────────────────────────
@router.get("/{loan_id}/scenarios")
async def list_scenarios(loan_id: str, scope: dict = Depends(entity_scope)):
    await _loan(scope, loan_id)

    def _load():
        db = SessionLocal()
        try:
            rows = db.query(models.AccountingLoanStressScenario).filter(models.AccountingLoanStressScenario.loan_id == loan_id).order_by(models.AccountingLoanStressScenario.saved_at.desc()).all()
            return [_ser_scenario(s) for s in rows]
        finally:
            db.close()
    return {"scenarios": await asyncio.to_thread(_load)}


class ScenarioBody(BaseModel):
    name: str
    params: dict = {}


@router.post("/{loan_id}/scenarios", status_code=201)
async def save_scenario(loan_id: str, body: ScenarioBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    name = (body.name or "").strip()[:120]
    if not name:
        raise HTTPException(status_code=400, detail="Name the scenario.")
    if len(str(body.params)) > 2000:
        raise HTTPException(status_code=400, detail="The scenario's settings are too long.")
    loan = await _loan(scope, loan_id)
    me = user["email"].lower()

    def _save():
        db = SessionLocal()
        try:
            have = db.query(models.AccountingLoanStressScenario).filter(models.AccountingLoanStressScenario.loan_id == loan_id).count()
            if have >= MAX_SCENARIOS:
                raise HTTPException(status_code=400, detail=f"A loan keeps up to {MAX_SCENARIOS} scenarios - remove one first.")
            s = models.AccountingLoanStressScenario(id=str(uuid.uuid4()), loan_id=loan_id, entity_code=str(loan.get("entity_code") or ""), name=name,
                                                    params=body.params, saved_by=me, saved_at=_now())
            db.add(s)
            db.commit()
            return _ser_scenario(s)
        finally:
            db.close()
    return {"scenario": await asyncio.to_thread(_save)}


@router.delete("/{loan_id}/scenarios/{scenario_id}")
async def delete_scenario(loan_id: str, scenario_id: str, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    await _loan(scope, loan_id)

    def _del():
        db = SessionLocal()
        try:
            n = db.query(models.AccountingLoanStressScenario).filter(models.AccountingLoanStressScenario.loan_id == loan_id,
                                                                     models.AccountingLoanStressScenario.id == scenario_id).delete(synchronize_session=False)
            db.commit()
            return n
        finally:
            db.close()
    if not await asyncio.to_thread(_del):
        raise HTTPException(status_code=404, detail="Scenario not found.")
    return {"ok": True}
