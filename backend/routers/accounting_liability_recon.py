"""Accounting -> Close -> Account Reconciliations: mortgages, loans and lines
of credit reconciled in Nexus (Charmi, 10/25 and 10/26, item 09; Neil, 10/25:
"Looked at it. Intacct doesn't have it. Should do in Nexus.").

Bank and card accounts keep Intacct's own reconciliation status (read-only,
09/25 and 10/07). Liability accounts have no reconciliation in Intacct, so a
loan of Loans & Financing (a fin_loans row in the accounting app: lender,
entity, principal GL account) is reconciled here, one month at a time:

- the person types the lender statement's ending balance (and its date,
  the month end by default) and may attach the statement PDF;
- Nexus reads the ledger balance of the loan's GL account in its entity on
  that date (the accounting app's balance sheet - the same read Loans &
  Financing uses) and keeps statement - ledger as the difference;
- Mark Reconciled is refused unless the difference is 0.00;
- a reconciled month is locked; only an Accounting admin (the `full` grant)
  reopens it, with a reason, and the reopen is logged and audited.

Everything is saved in Nexus only (accounting_liability_recons + its
append-only log). Nothing is sent to Intacct or to the accounting app.
Amounts are what is OWED: a liability's credit balance as a positive figure.
A person limited to certain entities reads and writes only theirs (404 for
the rest, like no loan).
"""
import asyncio
import json
import re
import uuid
from calendar import monthrange
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError

import models
from auth import require_module_grant
from database import SessionLocal
from routers import accounting, accounting_dashboard, accounting_loan_plans, accounting_loans
from routers.accounting import entity_scope

router = APIRouter(prefix="/accounting/liability-recons", tags=["Accounting"], dependencies=[Depends(require_module_grant("accounting", "viewer"))])

_edit = require_module_grant("accounting", "editor")
_admin = require_module_grant("accounting", "full")

_PERIOD = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TOLERANCE = 0.005               # a difference under half a cent is 0.00
MAX_NOTE = 2000
HISTORY = 24                    # months of a loan's history the panel lists


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _r2(v) -> Optional[float]:
    return None if v is None else round(float(v) + 0.0, 2)


def check_period(period: str) -> str:
    """YYYY-MM, not after the current month."""
    p = (period or "").strip()
    if not _PERIOD.match(p):
        raise HTTPException(status_code=400, detail="The month must look like 2026-09.")
    if p > date.today().isoformat()[:7]:
        raise HTTPException(status_code=400, detail="A month that has not started cannot be reconciled.")
    return p


def month_end(period: str) -> str:
    y, m = int(period[:4]), int(period[5:7])
    return f"{period}-{monthrange(y, m)[1]:02d}"


def check_statement_date(period: str, value: Optional[str]) -> str:
    """The statement's date: inside the month, the month end when left out."""
    d = (value or "").strip() or month_end(period)
    if not _DATE.match(d):
        raise HTTPException(status_code=400, detail="The statement date must be a date.")
    try:
        date.fromisoformat(d)
    except ValueError:
        raise HTTPException(status_code=400, detail="The statement date is not a real date.")
    if d[:7] != period:
        raise HTTPException(status_code=400, detail="The statement date must fall inside the month being reconciled.")
    return d


def difference(statement: Optional[float], ledger: Optional[float]) -> Optional[float]:
    if statement is None or ledger is None:
        return None
    return round(statement - ledger, 2)


def balanced(diff: Optional[float]) -> bool:
    return diff is not None and abs(diff) < TOLERANCE


def ser(r: models.AccountingLiabilityRecon) -> dict:
    return {
        "id": r.id, "loanId": r.loan_id, "entityCode": r.entity_code or "", "glAccount": r.gl_account or "", "accountName": r.account_name or "",
        "period": r.period, "statementDate": r.statement_date or "", "statementBalance": r.statement_balance, "ledgerBalance": r.ledger_balance,
        "difference": r.difference, "status": r.status or "open", "statementUrl": r.statement_url or "", "statementName": r.statement_name or "",
        "note": r.note or "", "savedBy": r.saved_by or "", "savedAt": r.saved_at or "", "reconciledBy": r.reconciled_by or "",
        "reconciledAt": r.reconciled_at or "", "reopenedBy": r.reopened_by or "", "reopenedAt": r.reopened_at or "", "reopenReason": r.reopen_reason or "",
    }


def _ser_log(x: models.AccountingLiabilityReconLog) -> dict:
    return {"id": x.id, "period": x.period, "action": x.action, "by": x.by_name or x.by_email, "at": x.at, "detail": x.detail or {}}


async def _loan(scope: dict, loan_id: str, period: str) -> dict:
    """The fin_loans row, if the caller may read its entity - else 404."""
    rows = await accounting_loans._loan_rows(scope, period)
    cur = next((r for r in rows if str(r.get("id")) == str(loan_id)), None)
    if not cur:
        raise HTTPException(status_code=404, detail="Loan not found in your entities.")
    return cur


async def ledger_owed(scope: dict, loan: dict, asof: str) -> Optional[float]:
    """What the ledger says is owed on the loan's GL account in its entity on
    `asof`; None when the loan has no GL account. An account with no balance
    on the balance sheet is 0.00."""
    gl = str(loan.get("gl_account") or "").strip()
    if not gl:
        return None
    sheet = await accounting_loans._balance_sheet(scope, str(loan.get("entity_code") or ""), asof)
    row = sheet.get(gl)
    return _r2(row["owed"]) if row else 0.0


async def _reach(scope: dict) -> Optional[set]:
    if scope["allowed"] is None:
        return None
    return await accounting._with_children(scope["allowed"]) if scope["allowed"] else set()


# ── Reads ────────────────────────────────────────────────────────────────────
def _status_sync(upto: str, reach: Optional[set]) -> dict:
    db = SessionLocal()
    try:
        q = db.query(models.AccountingLiabilityRecon).filter(models.AccountingLiabilityRecon.period <= upto)
        rows = q.order_by(models.AccountingLiabilityRecon.period.desc()).all()
    finally:
        db.close()
    out: dict[str, dict] = {}
    for r in rows:
        if reach is not None and (r.entity_code or "") not in reach:
            continue
        cur = out.setdefault(r.loan_id, {"month": None, "last": None})
        if r.period == upto and cur["month"] is None:
            cur["month"] = ser(r)
        if r.status == "reconciled" and cur["last"] is None:
            cur["last"] = ser(r)
    return out


@router.get("")
async def status(upto: str = Query(...), scope: dict = Depends(entity_scope)):
    """Per loan: this month's record (any state) and the latest reconciled
    month up to it - what the reconciliation list shows as Last Reconciled."""
    p = check_period(upto)
    reach = await _reach(scope)
    return {"loans": await asyncio.to_thread(_status_sync, p, reach)}


def _detail_sync(loan_id: str, period: str) -> tuple[Optional[dict], list[dict], list[dict]]:
    db = SessionLocal()
    try:
        cur = db.query(models.AccountingLiabilityRecon).filter(models.AccountingLiabilityRecon.loan_id == loan_id, models.AccountingLiabilityRecon.period == period).first()
        hist = (db.query(models.AccountingLiabilityRecon).filter(models.AccountingLiabilityRecon.loan_id == loan_id)
                .order_by(models.AccountingLiabilityRecon.period.desc()).limit(HISTORY).all())
        log = (db.query(models.AccountingLiabilityReconLog).filter(models.AccountingLiabilityReconLog.loan_id == loan_id)
               .order_by(models.AccountingLiabilityReconLog.at.desc()).limit(100).all())
        return (ser(cur) if cur else None), [ser(h) for h in hist], [_ser_log(x) for x in log]
    finally:
        db.close()


@router.get("/{loan_id}/{period}")
async def detail(loan_id: str, period: str, date_: Optional[str] = Query(default=None, alias="date"), scope: dict = Depends(entity_scope)):
    """One loan and month: the saved record, the ledger balance on the
    statement date (the saved one, else `date`, else the month end), the
    loan's recent months and its log."""
    p = check_period(period)
    loan = await _loan(scope, loan_id, p)
    record, history, log = await asyncio.to_thread(_detail_sync, loan_id, p)
    asof = check_statement_date(p, date_ or (record or {}).get("statementDate"))
    ledger = await ledger_owed(scope, loan, asof)
    stmt = (record or {}).get("statementBalance")
    return {
        "loan": {"id": str(loan.get("id")), "lender": loan.get("lender") or "", "loanNo": loan.get("loan_no") or "", "entityCode": loan.get("entity_code") or "",
                 "glAccount": str(loan.get("gl_account") or ""), "kind": loan.get("kind") or "external"},
        "period": p, "asOf": asof, "ledgerBalance": ledger, "difference": difference(stmt, ledger),
        "record": record, "history": history, "log": log,
    }


# ── Writes ───────────────────────────────────────────────────────────────────
class SaveBody(BaseModel):
    statementBalance: Optional[float] = None
    statementDate: Optional[str] = None
    statementUrl: Optional[str] = None
    statementName: Optional[str] = None
    note: Optional[str] = None
    reconcile: bool = False


class ReopenBody(BaseModel):
    reason: str = ""


def _log(db, r: models.AccountingLiabilityRecon, action: str, email: str, name: str, at: str, detail: dict) -> None:
    db.add(models.AccountingLiabilityReconLog(id=str(uuid.uuid4()), recon_id=r.id, loan_id=r.loan_id, period=r.period, action=action,
                                              by_email=email, by_name=name, at=at, detail=detail))


def _audit(db, user: dict, action: str, r: models.AccountingLiabilityRecon, at: str, details: dict) -> None:
    db.add(models.AuditLog(timestamp=at, user_email=user.get("email") or "", user_role=user.get("role", "") or "", action=action,
                           resource_type="accounting_liability_recon", resource_id=f"{r.loan_id}:{r.period}"[:200],
                           details=json.dumps(details, default=str)[:4000]))


def _save_sync(user: dict, name: str, loan: dict, period: str, body: SaveBody, stmt_date: str, ledger: Optional[float], url: str) -> dict:
    email = (user.get("email") or "").lower()
    at = _now()
    db = SessionLocal()
    try:
        r = (db.query(models.AccountingLiabilityRecon)
             .filter(models.AccountingLiabilityRecon.loan_id == str(loan["id"]), models.AccountingLiabilityRecon.period == period)
             .with_for_update().first())
        if r is not None and r.status == "reconciled":
            raise HTTPException(status_code=409, detail="This month is already reconciled. An Accounting admin can reopen it.")
        if r is None:
            r = models.AccountingLiabilityRecon(id=str(uuid.uuid4()), loan_id=str(loan["id"]), period=period, status="open")
            db.add(r)
        r.entity_code = str(loan.get("entity_code") or "")
        r.gl_account = str(loan.get("gl_account") or "")
        r.account_name = str(loan.get("lender") or "")
        r.statement_date = stmt_date
        r.statement_balance = _r2(body.statementBalance)
        r.ledger_balance = ledger
        r.difference = difference(r.statement_balance, ledger)
        if body.statementUrl is not None:
            r.statement_url = url
            r.statement_name = (body.statementName or "").strip()[:200] if url else ""
        if body.note is not None:
            r.note = body.note.strip()[:MAX_NOTE]
        r.saved_by, r.saved_at = name, at
        figures = {"statementDate": stmt_date, "statementBalance": r.statement_balance, "ledgerBalance": ledger, "difference": r.difference}
        if body.reconcile:
            if r.statement_balance is None:
                raise HTTPException(status_code=400, detail="Type the statement's ending balance first.")
            if not balanced(r.difference):
                raise HTTPException(status_code=400, detail=f"The difference is {r.difference:,.2f}. A month can be marked Reconciled only when the difference is 0.00.")
            r.status = "reconciled"
            r.reconciled_by, r.reconciled_at = name, at
            _log(db, r, "reconciled", email, name, at, figures)
            _audit(db, user, "liability_recon_reconciled", r, at, figures)
        else:
            _log(db, r, "saved", email, name, at, figures)
        db.commit()
        db.refresh(r)
        return ser(r)
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Someone saved this month at the same moment. Open it again to see their figures.")
    finally:
        db.close()


@router.put("/{loan_id}/{period}")
async def save(loan_id: str, period: str, body: SaveBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    """Save the statement's ending balance (and its date, file and note) for
    a month; with `reconcile`, also mark it Reconciled - refused unless the
    difference against the ledger is 0.00. Editors and up."""
    p = check_period(period)
    loan = await _loan(scope, loan_id, p)
    if not str(loan.get("gl_account") or "").strip():
        raise HTTPException(status_code=400, detail="This loan has no GL account. Set it in Loans & Financing first, so Nexus can read the ledger balance.")
    stmt_date = check_statement_date(p, body.statementDate)
    if body.statementBalance is not None and abs(body.statementBalance) >= 1e12:
        raise HTTPException(status_code=400, detail="The statement balance is too large.")
    url = accounting_loan_plans.check_file_url(body.statementUrl) if body.statementUrl is not None else ""
    ledger = await ledger_owed(scope, loan, stmt_date)
    name = await asyncio.to_thread(_name, user["email"])
    return {"record": await asyncio.to_thread(_save_sync, user, name, loan, p, body, stmt_date, ledger, url)}


def _reopen_sync(user: dict, name: str, loan_id: str, period: str, reason: str) -> dict:
    email = (user.get("email") or "").lower()
    at = _now()
    db = SessionLocal()
    try:
        r = (db.query(models.AccountingLiabilityRecon)
             .filter(models.AccountingLiabilityRecon.loan_id == loan_id, models.AccountingLiabilityRecon.period == period)
             .with_for_update().first())
        if r is None or r.status != "reconciled":
            raise HTTPException(status_code=409, detail="This month is not reconciled, so there is nothing to reopen.")
        was = {"reconciledBy": r.reconciled_by, "reconciledAt": r.reconciled_at, "statementBalance": r.statement_balance,
               "ledgerBalance": r.ledger_balance, "difference": r.difference, "reason": reason}
        r.status = "open"
        r.reopened_by, r.reopened_at, r.reopen_reason = name, at, reason
        _log(db, r, "reopened", email, name, at, was)
        _audit(db, user, "liability_recon_reopened", r, at, was)
        db.commit()
        db.refresh(r)
        return ser(r)
    finally:
        db.close()


@router.post("/{loan_id}/{period}/reopen")
async def reopen(loan_id: str, period: str, body: ReopenBody, user: dict = Depends(_admin), scope: dict = Depends(entity_scope)):
    """Reopen a reconciled month - Accounting admins only, with a reason;
    logged and audited. The figures stay; the month can be saved again."""
    p = check_period(period)
    await _loan(scope, loan_id, p)
    reason = (body.reason or "").strip()
    if not reason:
        raise HTTPException(status_code=400, detail="Say why the month is being reopened.")
    name = await asyncio.to_thread(_name, user["email"])
    return {"record": await asyncio.to_thread(_reopen_sync, user, name, loan_id, p, reason[:MAX_NOTE])}


# ── Small helpers (sync; always called in a thread) ──────────────────────────
def _name(email: str) -> str:
    db = SessionLocal()
    try:
        return accounting_dashboard._display_name(db, email)
    finally:
        db.close()
