"""Expense reimbursement (Neil, Oct 17 2026): "employee pays on behalf of
company, how can they get reimbursed with an upload of receipt and payment -
needs to be added to Workday." Oct 18 (Pranshu): one receipt upload is
enough - no separate proof of payment - and "What was it for" is required.

    employee submits (Workday > Expenses)  -> submitted
    manager decides  (Team > Requests)     -> manager_approved | rejected | sent_back
    accounting       (Accounting > Reimbursements) -> approved | rejected | sent_back
    accounting pays                        -> paid

A sent-back claim is edited and resubmitted by the employee; submitted or
sent back, they can also cancel it. Who decides the manager step is the time
off rule - timeclock._visible_emails (direct reports, Backup Manager, a
company's HR contact for people with no manager, HR grant holders,
administrators) - and nobody decides their own claim. The accounting step is
a tab of Accounting (Pranshu, Oct 18: not a module of its own): the Accounting
grant with no entity limit reads the queue (claims span every company, so it
is a consolidated surface - require_unlimited), the editor level decides and
pays. Bells are server-side and targeted (CLAUDE.md).

Files live in the PRIVATE ticket-evidence bucket under an `expense-` prefix
and open only through /files/view.
shortcut: shares ticket-evidence and /files/view's login-only check, so any
signed-in user holding a file's link can open it; move to an
`expense-receipts` bucket with a per-claim check if Neil wants card
statements locked to the claim's viewers.
"""
import uuid
from datetime import date
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import get_current_user, scoped_ids, _module_level, _MODULE_LEVEL_RANK, _LEVELS
from database import get_db
from models import ExpenseClaim, NexusEmployee, NexusRole
from routers.hr import _hr_notify
from routers.accounting import ACCOUNTING_SCOPE_MODULE, require_unlimited
from routers.items import _validate_photo_url
from routers.timeclock import (_visible_emails, _notify_team_alert, _display_name, _now_iso,
                               require_approval_read, require_approval_write)

router = APIRouter(prefix="/expenses", tags=["Expenses"])

MODULE_ID = "accounting"
CATEGORIES = ("travel", "meals", "supplies", "software", "equipment", "other")
MAX_AMOUNT = 1_000_000           # a typo guard, not a policy limit
MAX_FILES = 10

_EMPLOYEE_ACTION = {"view": "myhr", "sub": "expenses"}
_MANAGER_ACTION = {"view": "shifts", "sub": "requests"}
_ACCOUNTING_ACTION = {"view": "accounting", "sub": "reimbursements"}


class ClaimIn(BaseModel):
    expense_date: str
    vendor: str
    category: str = "other"
    category_other: Optional[str] = ""   # required when category is "other"
    amount: float
    currency: str = "USD"
    description: Optional[str] = ""
    receipt_urls: List[str] = []


class DecisionIn(BaseModel):
    action: str                  # approve | reject | send_back
    note: Optional[str] = ""


class PaidIn(BaseModel):
    paid_on: str                 # YYYY-MM-DD
    payment_method: str          # payroll | ach | check | other
    payment_ref: Optional[str] = ""


def _clean(body: ClaimIn) -> dict:
    try:
        d = date.fromisoformat(body.expense_date)
    except ValueError:
        raise HTTPException(400, "Expense date must be YYYY-MM-DD")
    if d > date.today():
        raise HTTPException(400, "The expense date can't be in the future")
    vendor = (body.vendor or "").strip()
    if not vendor:
        raise HTTPException(400, "Who was it paid to? Add the vendor")
    if body.category not in CATEGORIES:
        raise HTTPException(400, f"Category must be one of: {', '.join(CATEGORIES)}")
    other = (body.category_other or "").strip()[:100] if body.category == "other" else ""
    if body.category == "other" and not other:
        raise HTTPException(400, "Say what the Other category is")
    description = (body.description or "").strip()
    if not description:
        raise HTTPException(400, "Say what it was for")
    cents = round((body.amount or 0) * 100)
    if cents <= 0 or cents > MAX_AMOUNT * 100:
        raise HTTPException(400, "Enter the amount you paid")
    currency = (body.currency or "USD").strip().upper()
    if len(currency) != 3 or not currency.isalpha():
        raise HTTPException(400, "Currency must be a 3-letter code like USD")
    receipts = [u.strip() for u in body.receipt_urls if (u or "").strip()]
    if not receipts:
        raise HTTPException(400, "Attach the receipt")
    if len(receipts) > MAX_FILES:
        raise HTTPException(400, f"Attach at most {MAX_FILES} files")
    for u in receipts:
        _validate_photo_url(u, "Receipt")
    return dict(expense_date=d.isoformat(), vendor=vendor[:200], category=body.category, category_other=other,
                amount_cents=cents, currency=currency, description=description[:1000], receipt_urls=receipts)


def _log(row: ExpenseClaim, by: str, action: str, note: str = "") -> None:
    # Reassign, not append: a JSON column's in-place mutation is not tracked.
    row.history = list(row.history or []) + [{"at": _now_iso(), "by": by, "action": action, "note": note}]
    row.updated_at = _now_iso()


def _ser(row: ExpenseClaim, names: Optional[dict] = None) -> dict:
    names = names or {}
    em = row.employee_email
    return {
        "id": row.id, "employeeEmail": em, "employeeName": names.get(em, ""),
        "expenseDate": row.expense_date, "vendor": row.vendor, "category": row.category,
        "categoryOther": row.category_other or "",
        "amount": (row.amount_cents or 0) / 100, "currency": row.currency or "USD",
        "description": row.description or "",
        "receiptUrls": list(row.receipt_urls or []),
        "status": row.status,
        "history": [{**h, "byName": names.get(h.get("by", ""), "")} for h in (row.history or [])],
        "paymentMethod": row.payment_method or "", "paymentRef": row.payment_ref or "", "paidOn": row.paid_on or "",
        "createdAt": row.created_at, "updatedAt": row.updated_at,
    }


def _names(db: Session) -> dict:
    return {(e.work_email or "").lower(): f"{e.first_name or ''} {e.last_name or ''}".strip()
            for e in db.query(NexusEmployee).all() if e.work_email}


def _money(row: ExpenseClaim) -> str:
    return f"{row.currency or 'USD'} {(row.amount_cents or 0) / 100:,.2f}"


def _get(db: Session, claim_id: str, lock: bool = False) -> ExpenseClaim:
    q = db.query(ExpenseClaim).filter(ExpenseClaim.id == claim_id)
    row = (q.with_for_update() if lock else q).first()
    if not row:
        raise HTTPException(404, "Claim not found")
    return row


def _accounting_recipients(db: Session, exclude: str) -> list:
    """Accounting editors who can open the tab (no entity limit); with none,
    the administrators - an approved claim is never left waiting on nobody."""
    from workforce_scorecard import grant_holders
    out = {em for em, rank in grant_holders(db, MODULE_ID).items()
           if rank >= _MODULE_LEVEL_RANK["editor"] and scoped_ids(em, ACCOUNTING_SCOPE_MODULE, db) is None}
    if not out:
        out = {(r.email or "").strip().lower() for r in db.query(NexusRole)
               .filter(NexusRole.role.in_(["administrator", "owner"])).all() if r.email}
    return sorted(out - {exclude, ""})


def _can_review(user: dict, db: Session) -> bool:
    return (user["level"] >= _LEVELS["administrator"]
            or _module_level(user["email"], MODULE_ID, db) >= _MODULE_LEVEL_RANK["editor"])


# ── Employee: Workday > Expenses ─────────────────────────────────────────────

@router.get("/mine")
def my_claims(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (db.query(ExpenseClaim).filter(ExpenseClaim.employee_email == user["email"])
            .order_by(ExpenseClaim.created_at.desc()).limit(200).all())
    names = _names(db)
    return [_ser(r, names) for r in rows]


@router.post("", status_code=201)
def submit_claim(body: ClaimIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    now = _now_iso()
    row = ExpenseClaim(id=str(uuid.uuid4()), employee_email=user["email"], status="submitted",
                       history=[], created_at=now, **_clean(body))
    _log(row, user["email"], "submitted")
    db.add(row)
    _tell_manager(db, row, "Expense Claim", "submitted")
    db.commit()
    return _ser(row, _names(db))


@router.put("/{claim_id}")
def resubmit_claim(claim_id: str, body: ClaimIn, user: dict = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """A sent-back claim, fixed and sent again - back to the manager step."""
    row = _get(db, claim_id, lock=True)
    if row.employee_email != user["email"]:
        raise HTTPException(403, "You can only change your own claims.")
    if row.status != "sent_back":
        raise HTTPException(409, "Only a claim that was sent back can be changed")
    for k, v in _clean(body).items():
        setattr(row, k, v)
    row.status = "submitted"
    _log(row, user["email"], "resubmitted")
    _tell_manager(db, row, "Expense Claim Resubmitted", "resubmitted")
    db.commit()
    return _ser(row, _names(db))


@router.post("/{claim_id}/cancel")
def cancel_claim(claim_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = _get(db, claim_id, lock=True)
    if row.employee_email != user["email"]:
        raise HTTPException(403, "You can only cancel your own claims.")
    if row.status not in ("submitted", "sent_back"):
        raise HTTPException(409, "This claim is already past approval - ask accounting")
    row.status = "canceled"
    _log(row, user["email"], "canceled")
    db.commit()
    return _ser(row, _names(db))


def _tell_manager(db: Session, row: ExpenseClaim, title: str, verb: str) -> None:
    who = _display_name(db, row.employee_email)
    _notify_team_alert(db, employee_email=row.employee_email, actor_email=row.employee_email,
                       title=title, body=f"{who} {verb} {_money(row)} paid to {row.vendor} on {_us(row.expense_date)}.",
                       ref_id=row.id, action=_MANAGER_ACTION, owners_as_fallback=True)


def _us(iso: str) -> str:
    try:
        return date.fromisoformat(iso).strftime("%m/%d/%Y")
    except (TypeError, ValueError):
        return iso or ""


# ── Manager / HR: Team > Requests, People > person > Expenses ────────────────

@router.get("/team")
def team_claims(status: str = "", email: str = "", user: dict = Depends(require_approval_read),
                db: Session = Depends(get_db)):
    """Claims of the people the caller manages (the time-off scope), newest
    first. `email` narrows to one person (the People profile tab). The
    caller's own claims are left out - those are on their Workday."""
    q = db.query(ExpenseClaim).filter(ExpenseClaim.employee_email != user["email"])
    scope = _visible_emails(db, user)
    if scope is not None:
        q = q.filter(ExpenseClaim.employee_email.in_(sorted(scope)))
    if email:
        q = q.filter(ExpenseClaim.employee_email == email.strip().lower())
    if status:
        q = q.filter(ExpenseClaim.status == status)
    names = _names(db)
    return [_ser(r, names) for r in q.order_by(ExpenseClaim.created_at.desc()).limit(2000).all()]


@router.post("/{claim_id}/manager-decision")
def manager_decide(claim_id: str, body: DecisionIn, user: dict = Depends(require_approval_write),
                   db: Session = Depends(get_db)):
    row = _get(db, claim_id, lock=True)
    if row.employee_email == user["email"]:
        raise HTTPException(403, "You can't approve your own claim - your manager decides it.")
    scope = _visible_emails(db, user)
    if scope is not None and row.employee_email not in scope:
        raise HTTPException(403, "You can only decide your own team's claims.")
    if row.status != "submitted":
        raise HTTPException(409, f"Already {row.status.replace('_', ' ')}")
    note = _decision_note(body)
    row.status = {"approve": "manager_approved", "reject": "rejected", "send_back": "sent_back"}[body.action]
    _log(row, user["email"], f"manager_{body.action}", note)
    _tell_employee(db, row, user["email"], note)
    if row.status == "manager_approved":
        for em in _accounting_recipients(db, row.employee_email):
            _hr_notify(db, em, "Expense Claim To Review",
                       f"{_display_name(db, row.employee_email)}'s {_money(row)} claim ({row.vendor}) "
                       f"was approved by {_display_name(db, user['email'])} and is ready for accounting.",
                       ref_id=row.id, requested_by=row.employee_email, action=_ACCOUNTING_ACTION)
    db.commit()
    return _ser(row, _names(db))


def _decision_note(body: DecisionIn) -> str:
    if body.action not in ("approve", "reject", "send_back"):
        raise HTTPException(400, "action must be approve, reject or send_back")
    note = (body.note or "").strip()[:500]
    if body.action != "approve" and not note:
        raise HTTPException(400, "Add a note so the employee knows why")
    return note


_TELL = {"manager_approved": ("Expense Claim Approved", "was approved by your manager and went to accounting"),
         "approved": ("Expense Claim Approved", "was approved by accounting and will be paid"),
         "rejected": ("Expense Claim Rejected", "was rejected"),
         "sent_back": ("Expense Claim Sent Back", "was sent back to you to fix and resubmit"),
         "paid": ("Expense Claim Paid", "was paid")}


def _tell_employee(db: Session, row: ExpenseClaim, actor: str, note: str = "") -> None:
    title, verb = _TELL[row.status]
    _hr_notify(db, row.employee_email, title,
               f"Your {_money(row)} claim ({row.vendor}, {_us(row.expense_date)}) {verb}."
               + (f" Note: {note}" if note else ""),
               ref_id=row.id, requested_by=actor, action=_EMPLOYEE_ACTION)


# ── Accounting > Reimbursements ──────────────────────────────────────────────

def _require_reviewer(scope: dict = Depends(require_unlimited), db: Session = Depends(get_db)) -> dict:
    if not _can_review(scope["user"], db):
        raise HTTPException(403, "Approving and paying claims needs the Editor level on Accounting.")
    return scope["user"]


@router.get("/queue")
def queue(status: str = "", scope: dict = Depends(require_unlimited), db: Session = Depends(get_db)):
    """Every claim, newest first - the manager-approved ones are the work."""
    user = scope["user"]
    q = db.query(ExpenseClaim)
    if status:
        q = q.filter(ExpenseClaim.status == status)
    names = _names(db)
    return {"canReview": _can_review(user, db),
            "claims": [_ser(r, names) for r in q.order_by(ExpenseClaim.created_at.desc()).limit(2000).all()]}


@router.post("/{claim_id}/review")
def accounting_decide(claim_id: str, body: DecisionIn, user: dict = Depends(_require_reviewer),
                      db: Session = Depends(get_db)):
    row = _get(db, claim_id, lock=True)
    if row.employee_email == user["email"]:
        raise HTTPException(403, "Someone else in accounting has to review your own claim.")
    if row.status != "manager_approved":
        raise HTTPException(409, "Only a manager-approved claim can be reviewed")
    note = _decision_note(body)
    row.status = {"approve": "approved", "reject": "rejected", "send_back": "sent_back"}[body.action]
    _log(row, user["email"], f"accounting_{body.action}", note)
    _tell_employee(db, row, user["email"], note)
    db.commit()
    return _ser(row, _names(db))


@router.post("/{claim_id}/paid")
def mark_paid(claim_id: str, body: PaidIn, user: dict = Depends(_require_reviewer),
              db: Session = Depends(get_db)):
    row = _get(db, claim_id, lock=True)
    if row.employee_email == user["email"]:
        raise HTTPException(403, "Someone else in accounting has to pay your own claim.")
    if row.status != "approved":
        raise HTTPException(409, "Only an approved claim can be marked paid")
    try:
        paid_on = date.fromisoformat(body.paid_on).isoformat()
    except ValueError:
        raise HTTPException(400, "Paid date must be YYYY-MM-DD")
    if body.payment_method not in ("payroll", "ach", "check", "other"):
        raise HTTPException(400, "payment_method must be payroll, ach, check or other")
    row.status = "paid"
    row.paid_on, row.payment_method = paid_on, body.payment_method
    row.payment_ref = (body.payment_ref or "").strip()[:200]
    _log(row, user["email"], "paid", row.payment_ref)
    _tell_employee(db, row, user["email"], f"Paid {_us(paid_on)} by {body.payment_method.upper() if body.payment_method == 'ach' else body.payment_method}"
                   + (f", reference {row.payment_ref}" if row.payment_ref else ""))
    db.commit()
    return _ser(row, _names(db))
