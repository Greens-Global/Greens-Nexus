"""Expense reimbursements (Neil, Oct 18 2026).

Someone without a company card buys something the company agreed to (a
monitor), pays out of pocket, and has to be paid back. Until now that was an
email to accounting forwarded eight or nine times - paid late, or not at all.
This merges the two designs that were raised for it (Pranshu's #637 and the
Oct 18 call): where it lives and who approves from the call, the steps,
categories, currencies, history and People tab from #637, and HR paying the
way it signs off time sheets.

Workday > Reimbursements (a tile beside Ask HR, a panel - not a new tab):
  1. The employee files it: what, category, amount (any currency), when,
     where, what for, who approves it (their manager by default) and the
     receipts - now, or added later.                         -> submitted
  2. That approver approves, sends it back with a note, or rejects it.
                                     -> approver_approved | sent_back | rejected
  3. HR approves, sends back or rejects it - HR as on time sheets
     (timesheet_review.is_hr: the company's HR contact, an administrator, a
     Full HR grant; never on their own claim). Needs the receipt.
                                     -> hr_approved | sent_back | rejected
  4. HR pays it and marks it Paid (date, method, reference). -> paid
A sent-back claim is edited and resubmitted to its approver; while submitted
or sent back the employee can cancel it. Nothing is ever deleted; every step
is on the claim's history.

Bells are server-side and targeted, a new one at each step (as time off and
time sheets do). Receipts go to the private hr-docs bucket under
reimbursements/<email>/ and open through a five-minute signed link, only for
the employee, the approver, HR or the employee's manager.
"""
import json
import re
import uuid
from datetime import date, datetime, timezone
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

import timesheet_review
from auth import _LEVELS, _MODULE_LEVEL_RANK, _module_level, get_current_user, hr_scope, level_for
from database import get_db
from models import ExpenseReimbursement, HrEntity, NexusEmployee, NexusNotification, NexusRole
from routers.hr import _DOC_BUCKET, _SUPABASE_URL, _in_scope, _storage_headers

router = APIRouter(prefix="/reimbursements", tags=["Reimbursements"],
                   dependencies=[Depends(get_current_user)])

NOTIFY_TYPE = "reimbursement"
ACTION = {"view": "myhr", "sub": "reimbursements"}
CATEGORIES = ("travel", "meals", "supplies", "software", "equipment", "other")
PAY_METHODS = ("payroll", "ach", "check", "other")
MAX_RECEIPT_BYTES = 15 * 1024 * 1024
MAX_RECEIPTS = 10
MAX_AMOUNT = 1_000_000            # a typo guard, not a policy limit
RECEIPT_TYPES = ("image/", "application/pdf")
STATUS_LABEL = {
    "submitted": "Waiting for Approval", "approver_approved": "With HR",
    "hr_approved": "Approved - To Pay", "paid": "Paid", "sent_back": "Sent Back",
    "rejected": "Rejected", "canceled": "Canceled",
}
ACTION_WORD = {"submitted": "Submitted", "resubmitted": "Resubmitted", "approved": "Approved",
               "hr_approved": "Approved by HR", "sent_back": "Sent Back", "rejected": "Rejected",
               "canceled": "Canceled", "receipt": "Receipt Added", "paid": "Paid"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm(e: str) -> str:
    return (e or "").strip().lower()


def _person(db: Session, email: str) -> Optional[NexusEmployee]:
    return (db.query(NexusEmployee)
            .filter(func.lower(NexusEmployee.work_email) == _norm(email)).first())


def _name(db: Session, email: str) -> str:
    p = _person(db, email)
    n = f"{(p.first_name or '') if p else ''} {(p.last_name or '') if p else ''}".strip()
    return n or email


def _money(amount: float, currency: str) -> str:
    sym = {"USD": "$", "INR": "₹", "EUR": "€", "GBP": "£"}.get((currency or "USD").upper(), "")
    return f"{sym}{amount:,.2f}" if sym else f"{amount:,.2f} {currency}"


def _log(r: ExpenseReimbursement, by: str, action: str, note: str = "") -> None:
    # Reassign, never append in place: a JSON column's mutation is not tracked.
    r.history = list(r.history or []) + [{"at": _now(), "by": by, "action": action, "note": note}]
    r.updated_at = _now()


def _waiting_receipt(r: ExpenseReimbursement) -> bool:
    return r.status in ("submitted", "approver_approved") and not (r.receipts or [])


def _ser(r: ExpenseReimbursement, names: dict) -> dict:
    def nm(e):
        if e and e not in names:
            names[e] = names.get(e) or e
        return names.get(e, e)
    label = STATUS_LABEL.get(r.status, r.status.title())
    if r.status == "approver_approved" and not (r.receipts or []):
        label = "Waiting for Receipt"
    return {"id": r.id, "email": r.employee_email, "name": r.employee_name,
            "item": r.item, "category": r.category or "other", "categoryOther": r.category_other or "",
            "details": r.details or "", "vendor": r.vendor or "",
            "amount": float(r.amount or 0), "currency": r.currency or "USD",
            "purchaseDate": r.purchase_date or "",
            "approverEmail": r.approver_email or "", "approverName": nm(r.approver_email or ""),
            "receipts": [{"name": x.get("name") or f"Receipt {i + 1}"} for i, x in enumerate(r.receipts or [])],
            "status": r.status, "statusLabel": label,
            "approvedBy": nm(r.approved_by or ""), "approvedAt": r.approved_at or "",
            "hrBy": nm(r.hr_by or ""), "hrAt": r.hr_at or "",
            "paidBy": nm(r.paid_by or ""), "paidOn": r.paid_on or "",
            "paymentMethod": r.payment_method or "", "paymentRef": r.payment_ref or "",
            "history": [{**h, "byName": nm(h.get("by", "")), "label": ACTION_WORD.get(h.get("action"), h.get("action"))}
                        for h in (r.history or [])],
            "createdAt": r.created_at, "updatedAt": r.updated_at or ""}


def _ser_many(db: Session, rows) -> list:
    names: dict = {}
    emails = set()
    for r in rows:
        emails |= {r.approver_email, r.approved_by, r.hr_by, r.paid_by}
        emails |= {h.get("by") for h in (r.history or [])}
    for e in emails - {None, ""}:
        names[e] = _name(db, e)
    return [_ser(r, names) for r in rows]


def _bell(db: Session, recipient: str, r: ExpenseReimbursement, title: str, body: str,
          actor: str = "", priority: int = 0) -> None:
    """A new bell at each step (Sagar, Oct 18 2026), targeted - never a broadcast."""
    recipient = _norm(recipient)
    if not recipient:
        return
    db.add(NexusNotification(
        id=str(uuid.uuid4()), type=NOTIFY_TYPE, recipient=recipient, title=title, body=body,
        ref_id=r.id, item_name=(r.item or "")[:120], requested_by=actor or r.employee_name,
        action=json.dumps(ACTION), actioned=False, read_by="", company=r.company or "",
        created_at=_now(), priority=priority))


def _hr_people(db: Session, r: ExpenseReimbursement) -> list[str]:
    """Who hears that HR is up - as on time sheets: the company's HR contact,
    and when there is none the Global Admins. Never the employee."""
    hr = timesheet_review.hr_of(db, r.employee_email)
    out = [hr] if hr else [_norm(x.email) for x in db.query(NexusRole).filter(NexusRole.role == "owner").all()]
    return [e for e in out if e and e != _norm(r.employee_email)]


def _is_hr(db: Session, me: str, r: ExpenseReimbursement) -> bool:
    return timesheet_review.is_hr(db, me, r.employee_email)


def _hr_anywhere(db: Session, me: str) -> bool:
    """Could this person be HR for anyone - so the HR tab is worth showing."""
    if level_for(me, db) >= _LEVELS["administrator"]:
        return True
    if _module_level(me, "hr", db) >= _MODULE_LEVEL_RANK["full"]:
        return True
    return db.query(HrEntity).filter(func.lower(HrEntity.hr_contact_email) == me).first() is not None


def _manages(db: Session, me: str, employee: str) -> bool:
    p = _person(db, employee)
    return bool(p and _norm(p.manager_email) == me)


def _get(db: Session, rid: str) -> ExpenseReimbursement:
    r = db.query(ExpenseReimbursement).filter(ExpenseReimbursement.id == rid).with_for_update().first()
    if not r:
        raise HTTPException(404, "Reimbursement not found")
    return r


# ── Receipt upload ──────────────────────────────────────────────────────────

@router.post("/receipt")
def upload_receipt(file: UploadFile = File(...), user: dict = Depends(get_current_user)):
    """Stage a receipt (photo or PDF) in the private hr-docs bucket; the claim
    created or updated right after references it."""
    ctype = (file.content_type or "").lower()
    if not ctype.startswith(RECEIPT_TYPES):
        raise HTTPException(400, "A receipt is a photo or a PDF")
    data = file.file.read()
    if len(data) > MAX_RECEIPT_BYTES:
        raise HTTPException(400, "File too large (max 15 MB)")
    safe = re.sub(r"[^a-zA-Z0-9._-]", "_", file.filename or "receipt")
    path = f"reimbursements/{_norm(user['email'])}/{uuid.uuid4()}-{safe}"
    resp = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/{_DOC_BUCKET}/{path}",
                      headers={**_storage_headers(), "Content-Type": ctype or "application/octet-stream"},
                      content=data, timeout=60)
    if not resp.is_success:
        raise HTTPException(502, f"Storage upload failed: {resp.text[:200]}")
    return {"path": path, "name": file.filename or safe}


class ReceiptRef(BaseModel):
    path: str
    name: str = ""


def _own_receipts(user: dict, refs: List[ReceiptRef]) -> list:
    """Only paths this user staged themselves."""
    mine = f"reimbursements/{_norm(user['email'])}/"
    out = []
    for x in refs or []:
        p = (x.path or "").strip()
        if not p:
            continue
        if not p.startswith(mine):
            raise HTTPException(400, "Bad receipt")
        out.append({"path": p, "name": (x.name or "").strip()[:200]})
    return out


# ── File / edit ─────────────────────────────────────────────────────────────

class ClaimIn(BaseModel):
    item: str
    amount: float
    currency: str = "USD"
    category: str = "other"
    category_other: str = ""
    purchase_date: str = ""
    vendor: str = ""
    details: str = ""
    approver_email: str = ""
    receipts: List[ReceiptRef] = []


def _clean(db: Session, user: dict, body: ClaimIn) -> dict:
    me = _norm(user["email"])
    item = (body.item or "").strip()
    if not item:
        raise HTTPException(400, "Describe the expense")
    details = (body.details or "").strip()
    if not details:
        raise HTTPException(400, "Add the business purpose")
    if body.category not in CATEGORIES:
        raise HTTPException(400, f"Category must be one of: {', '.join(CATEGORIES)}")
    other = (body.category_other or "").strip()[:100] if body.category == "other" else ""
    if body.category == "other" and not other:
        raise HTTPException(400, "Say what the Other category is")
    amount = round(float(body.amount or 0), 2)
    if amount <= 0 or amount > MAX_AMOUNT:
        raise HTTPException(400, "Enter the amount you paid")
    cur = (body.currency or "USD").strip().upper()
    if len(cur) != 3 or not cur.isalpha():
        raise HTTPException(400, "Currency must be a 3-letter code like USD")
    pd = (body.purchase_date or "").strip()
    if pd:
        try:
            if date.fromisoformat(pd) > date.today():
                raise HTTPException(400, "The purchase date can't be in the future")
        except ValueError:
            raise HTTPException(400, "Purchase date must be a date")
    emp = _person(db, me)
    approver = _norm(body.approver_email) or _norm(emp.manager_email if emp else "")
    if not approver:
        raise HTTPException(400, "Pick who approves this")
    if approver == me:
        raise HTTPException(400, "Someone else has to approve your reimbursement")
    ap = _person(db, approver)
    if ap is None or (ap.status or "active") not in ("active", "onboarding"):
        raise HTTPException(400, "The approver must be someone in Nexus People")
    receipts = _own_receipts(user, body.receipts)
    if len(receipts) > MAX_RECEIPTS:
        raise HTTPException(400, f"Attach at most {MAX_RECEIPTS} receipts")
    return dict(item=item[:200], details=details[:2000], category=body.category, category_other=other,
                amount=amount, currency=cur, purchase_date=pd, vendor=(body.vendor or "").strip()[:120],
                approver_email=approver, receipts=receipts)


def _ask_approver(db: Session, r: ExpenseReimbursement, again: bool = False) -> None:
    _bell(db, r.approver_email, r, "Reimbursement Resubmitted" if again else "Reimbursement to Approve",
          f"{r.employee_name} paid {_money(r.amount, r.currency)} for {r.item}"
          f"{' at ' + r.vendor if r.vendor else ''}. Approve, send back or reject it.", priority=1)


@router.post("", status_code=201)
def create(body: ClaimIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _norm(user["email"])
    clean = _clean(db, user, body)
    emp = _person(db, me)
    now = _now()
    r = ExpenseReimbursement(id=str(uuid.uuid4()), employee_email=me, employee_name=_name(db, me),
                             company=(emp.company or "") if emp else "", status="submitted",
                             history=[], created_at=now, updated_at=now, **clean)
    _log(r, me, "submitted")
    db.add(r)
    _ask_approver(db, r)
    db.commit()
    return _ser_many(db, [r])[0]


@router.put("/{rid}")
def resubmit(rid: str, body: ClaimIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Fix a sent-back claim and send it to its approver again."""
    r = _get(db, rid)
    if r.employee_email != _norm(user["email"]):
        raise HTTPException(403, "Only the person who filed it can change it")
    if r.status != "sent_back":
        raise HTTPException(409, "Only a claim that was sent back can be changed")
    clean = _clean(db, user, body)
    keep = list(r.receipts or [])
    for k, v in clean.items():
        setattr(r, k, v)
    r.receipts = (keep + [x for x in clean["receipts"] if x not in keep])[:MAX_RECEIPTS]
    r.status = "submitted"
    r.approved_by = r.approved_at = r.hr_by = r.hr_at = ""
    _log(r, r.employee_email, "resubmitted")
    _ask_approver(db, r, again=True)
    db.commit()
    return _ser_many(db, [r])[0]


# ── Lists ───────────────────────────────────────────────────────────────────

@router.get("")
def overview(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Mine, the ones waiting on me as approver, and - for HR - the ones past
    their approver (to approve, to pay, paid)."""
    me = _norm(user["email"])
    mine = (db.query(ExpenseReimbursement).filter(ExpenseReimbursement.employee_email == me)
            .order_by(ExpenseReimbursement.created_at.desc()).limit(100).all())
    to_approve = (db.query(ExpenseReimbursement)
                  .filter(ExpenseReimbursement.approver_email == me, ExpenseReimbursement.employee_email != me)
                  .order_by(ExpenseReimbursement.created_at.desc()).limit(100).all())
    can_hr = _hr_anywhere(db, me)
    hr_rows = []
    if can_hr:
        rows = (db.query(ExpenseReimbursement)
                .filter(ExpenseReimbursement.status.in_(("approver_approved", "hr_approved", "paid")),
                        ExpenseReimbursement.employee_email != me)
                .order_by(ExpenseReimbursement.created_at.desc()).limit(300).all())
        hr_rows = [r for r in rows if _is_hr(db, me, r)]
    return {"mine": _ser_many(db, mine), "toApprove": _ser_many(db, to_approve),
            "hr": _ser_many(db, hr_rows), "canHr": can_hr,
            "categories": list(CATEGORIES), "payMethods": list(PAY_METHODS)}


def _may_see_person(db: Session, user: dict, employee: str) -> bool:
    me = _norm(user["email"])
    if me == employee or _manages(db, me, employee) or timesheet_review.is_hr(db, me, employee):
        return True
    if level_for(me, db) >= _LEVELS["administrator"]:
        return True
    if _module_level(me, "hr", db) >= _MODULE_LEVEL_RANK["viewer"]:
        scope = hr_scope(user, db)
        return scope is None or _in_scope(_person(db, employee), scope)
    return False


@router.get("/person/{email}")
def for_person(email: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Every claim one person filed - People > person > Expenses. The person,
    their manager, HR (as on time sheets) and the HR grant within its scope."""
    em = _norm(email)
    if not _may_see_person(db, user, em):
        raise HTTPException(404, "Not found")
    rows = (db.query(ExpenseReimbursement).filter(ExpenseReimbursement.employee_email == em)
            .order_by(ExpenseReimbursement.created_at.desc()).limit(200).all())
    return _ser_many(db, rows)


# ── Decide: the approver, then HR ───────────────────────────────────────────

class DecisionIn(BaseModel):
    action: str                  # approve | send_back | reject
    note: str = ""


@router.post("/{rid}/decide")
def decide(rid: str, body: DecisionIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _norm(user["email"])
    r = _get(db, rid)
    if body.action not in ("approve", "send_back", "reject"):
        raise HTTPException(400, "action must be approve, send_back or reject")
    if r.employee_email == me:
        raise HTTPException(403, "You can't decide your own reimbursement")
    if r.status == "submitted":
        if r.approver_email != me:
            raise HTTPException(403, "This reimbursement is waiting on its approver")
        step = "approver"
    elif r.status == "approver_approved":
        if not _is_hr(db, me, r):
            raise HTTPException(403, "This reimbursement is waiting on HR")
        step = "hr"
    else:
        raise HTTPException(409, f"Already {STATUS_LABEL.get(r.status, r.status).lower()}")
    note = (body.note or "").strip()[:1000]
    if body.action != "approve" and not note:
        raise HTTPException(400, "Add a note saying why")
    who = _name(db, me)
    if body.action == "approve" and step == "hr" and not (r.receipts or []):
        raise HTTPException(409, "Waiting for the receipt")
    if body.action == "approve" and step == "approver":
        r.status, r.approved_by, r.approved_at = "approver_approved", me, _now()
        _log(r, me, "approved", note)
        _bell(db, r.employee_email, r, "Reimbursement Approved",
              f"{who} approved {r.item} ({_money(r.amount, r.currency)}). It is with HR now."
              + ("" if r.receipts else " Attach the receipt so HR can pay it."), actor=who)
        for e in _hr_people(db, r):
            if e != me:
                _bell(db, e, r, "Reimbursement for HR",
                      f"{r.employee_name}: {r.item} - {_money(r.amount, r.currency)}, approved by {who}."
                      + (" Approve and pay it." if r.receipts else " The receipt is still to come."),
                      actor=who, priority=1)
    elif body.action == "approve":
        r.status, r.hr_by, r.hr_at = "hr_approved", me, _now()
        _log(r, me, "hr_approved", note)
        _bell(db, r.employee_email, r, "Reimbursement Approved by HR",
              f"HR approved {r.item} ({_money(r.amount, r.currency)}). Payment is on its way.", actor=who)
    else:
        r.status = "sent_back" if body.action == "send_back" else "rejected"
        _log(r, me, r.status, note)
        word = "sent back" if body.action == "send_back" else "rejected"
        _bell(db, r.employee_email, r, f"Reimbursement {'Sent Back' if body.action == 'send_back' else 'Rejected'}",
              f"{who} {word} {r.item} ({_money(r.amount, r.currency)}): {note}"
              + (" Fix it and send it again." if body.action == "send_back" else ""), actor=who,
              priority=1 if body.action == "send_back" else 0)
        if step == "hr" and r.approver_email != me:
            _bell(db, r.approver_email, r, f"Reimbursement {word.title()} by HR",
                  f"HR {word} {r.employee_name}'s {r.item}, which you approved: {note}", actor=who)
    db.commit()
    return _ser_many(db, [r])[0]


# ── Employee: receipts, cancel ──────────────────────────────────────────────

class ReceiptsIn(BaseModel):
    receipts: List[ReceiptRef]


@router.post("/{rid}/receipts")
def add_receipts(rid: str, body: ReceiptsIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Receipts can come after the claim (bought once it was approved)."""
    r = _get(db, rid)
    if r.employee_email != _norm(user["email"]):
        raise HTTPException(403, "Only the person who filed it can add receipts")
    if r.status not in ("submitted", "approver_approved", "sent_back"):
        raise HTTPException(409, f"Already {STATUS_LABEL.get(r.status, r.status).lower()}")
    new = _own_receipts(user, body.receipts)
    if not new:
        raise HTTPException(400, "Upload the receipt first")
    had = bool(r.receipts)
    r.receipts = (list(r.receipts or []) + new)[:MAX_RECEIPTS]
    _log(r, r.employee_email, "receipt")
    if r.status == "approver_approved" and not had:
        for e in _hr_people(db, r):
            _bell(db, e, r, "Reimbursement Receipt Added",
                  f"{r.employee_name} added the receipt for {r.item} ({_money(r.amount, r.currency)}). Approve and pay it.",
                  priority=1)
    db.commit()
    return _ser_many(db, [r])[0]


@router.post("/{rid}/cancel")
def cancel(rid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    r = _get(db, rid)
    if r.employee_email != _norm(user["email"]):
        raise HTTPException(403, "Only the person who filed it can cancel it")
    if r.status not in ("submitted", "sent_back"):
        raise HTTPException(409, "Only a claim waiting for approval or sent back can be canceled")
    was = r.status
    r.status = "canceled"
    _log(r, r.employee_email, "canceled")
    if was == "submitted":
        _bell(db, r.approver_email, r, "Reimbursement Canceled",
              f"{r.employee_name} canceled {r.item} ({_money(r.amount, r.currency)}). Nothing to approve.")
    db.commit()
    return _ser_many(db, [r])[0]


# ── HR: paid ────────────────────────────────────────────────────────────────

class PaidIn(BaseModel):
    paid_on: str
    payment_method: str
    payment_ref: str = ""


@router.post("/{rid}/paid")
def mark_paid(rid: str, body: PaidIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _norm(user["email"])
    r = _get(db, rid)
    if not _is_hr(db, me, r):
        raise HTTPException(403, "Only HR can mark a reimbursement paid")
    if r.status != "hr_approved":
        raise HTTPException(409, "Only a reimbursement HR approved can be paid")
    try:
        paid_on = date.fromisoformat((body.paid_on or "").strip()).isoformat()
    except ValueError:
        raise HTTPException(400, "Paid on must be a date")
    if body.payment_method not in PAY_METHODS:
        raise HTTPException(400, f"Method must be one of: {', '.join(PAY_METHODS)}")
    r.status, r.paid_by, r.paid_on = "paid", me, paid_on
    r.payment_method, r.payment_ref = body.payment_method, (body.payment_ref or "").strip()[:120]
    _log(r, me, "paid", r.payment_ref)
    method = {"payroll": "with payroll", "ach": "by bank transfer", "check": "by check"}.get(r.payment_method, "")
    _bell(db, r.employee_email, r, "Reimbursement Paid",
          f"{r.item} ({_money(r.amount, r.currency)}) was paid{' ' + method if method else ''} on "
          f"{datetime.fromisoformat(paid_on).strftime('%m/%d/%Y')}.", actor=_name(db, me))
    db.commit()
    return _ser_many(db, [r])[0]


# ── Receipt link ────────────────────────────────────────────────────────────

@router.get("/{rid}/receipt-url")
def receipt_url(rid: str, i: int = 0, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A five-minute signed link to receipt `i`: the employee, the approver,
    their manager and HR only."""
    r = db.query(ExpenseReimbursement).filter(ExpenseReimbursement.id == rid).first()
    recs = (r.receipts or []) if r else []
    if not r or not (0 <= i < len(recs)):
        raise HTTPException(404, "No receipt")
    me = _norm(user["email"])
    if me not in (r.employee_email, r.approver_email) and not _may_see_person(db, user, r.employee_email):
        raise HTTPException(404, "No receipt")
    resp = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/sign/{_DOC_BUCKET}/{recs[i]['path']}",
                      headers=_storage_headers(), json={"expiresIn": 300}, timeout=15)
    if not resp.is_success:
        raise HTTPException(502, "Could not open the receipt")
    return {"url": f"{_SUPABASE_URL}/storage/v1{resp.json()['signedURL']}", "expiresIn": 300}
