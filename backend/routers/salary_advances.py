"""Workday > Salary Advance (Neil, Oct 27 2026). The rules, the schedule and
the pay card line live in salary_advance.py; this is the routes.

    GET    /salary-advances                       mine + (HR) the ones I am HR for
    GET    /salary-advances/pending               HR: requests to decide, advances to pay out
    GET    /salary-advances/person/{email}        the person themself or their HR
    POST   /salary-advances                       request my own (manager tier and up)
    POST   /salary-advances/grant                 HR grants one to anyone
    POST   /salary-advances/{id}/decide           HR: approve | decline
    POST   /salary-advances/{id}/cancel           the requester (while Requested), or HR (before payout)
    POST   /salary-advances/{id}/paid             HR: paid out on a date - builds the repayment schedule
    POST   /salary-advances/{id}/installments/{iid}/move   HR: to a later pay period, with why
    PUT    /salary-advances/{id}/schedule         HR: replace what is left to repay, with why

Pay is restricted: the person and their HR (salary_advance.is_hr_for) only -
a manager never sees anyone else's advance; the amounts only with the pay
grant (salary_advance.sees_pay), and deciding needs it too (can_decide). Bells are server-side, one notice
per advance for HR and one for the person, updated in place.
"""
import uuid
from datetime import date
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import salary_advance as sa
import workflows
from auth import get_current_user
from currency import is_currency
from database import get_db
from models import SalaryAdvance, SalaryAdvanceInstallment

router = APIRouter(prefix="/salary-advances", tags=["Salary Advances"], dependencies=[Depends(get_current_user)])


def _get(db: Session, aid: str, lock_person: bool = False) -> SalaryAdvance:
    """The advance, row-locked. lock_person: a schedule write - take the
    person's lock FIRST (the order salary_advance.on_finalize takes them in),
    so a move / reschedule and a finalize never interleave."""
    if lock_person:
        who = db.query(SalaryAdvance.employee_email).filter(SalaryAdvance.id == aid).first()
        if who is not None:
            from routers.timeclock import _lock_person
            _lock_person(db, who[0])
    adv = db.query(SalaryAdvance).filter(SalaryAdvance.id == aid).with_for_update().first()
    if adv is None:
        raise HTTPException(404, "Salary advance not found")
    return adv


_NEEDS_PAY_GRANT = ("Deciding a salary advance needs the pay grant (Pay & Benefits Editor, or an owner) - an "
                    "advance is pay.")


def _hr_or_404(db: Session, user: dict, adv: SalaryAdvance) -> None:
    """HR for this person with the pay grant (sa.can_decide), else 404
    (existence must not leak) - except to the person themself, told plainly
    that HR decides, and to HR without the pay grant, told what it needs."""
    if sa.can_decide(db, user, adv.employee_email):
        return
    if sa.norm(user["email"]) == sa.norm(adv.employee_email):
        raise HTTPException(403, "HR decides on your salary advance - not you.")
    if sa.is_hr_for(db, user, adv.employee_email):
        raise HTTPException(403, _NEEDS_PAY_GRANT)
    raise HTTPException(404, "Salary advance not found")


def _out(db: Session, adv: SalaryAdvance, user: dict) -> dict:
    return sa.serialize(db, adv, viewer=user)


def _amount(v) -> float:
    try:
        amt = round(float(v or 0), 2)
    except (TypeError, ValueError):
        raise HTTPException(400, "Enter the amount")
    if not (amt > 0) or amt > sa.MAX_AMOUNT:
        raise HTTPException(400, "Enter an amount above zero")
    return amt


def _installments(v) -> int:
    try:
        n = int(v or 1)
    except (TypeError, ValueError):
        raise HTTPException(400, "Installments must be a whole number")
    if n < 1 or n > sa.MAX_INSTALLMENTS:
        raise HTTPException(400, f"Repay it in 1 to {sa.MAX_INSTALLMENTS} pay periods")
    return n


def _currency(db: Session, email: str, v: str) -> str:
    """The advance is repaid out of pay, so it is in the pay currency: blank
    takes it; another code is refused while the person has a pay rate."""
    pay = sa.pay_currency(db, email)
    cur = (v or "").strip().upper() or pay
    if not is_currency(cur):
        raise HTTPException(400, "Currency must be a 3-letter code like USD")
    if cur != pay and sa.has_pay_rate(db, email):
        raise HTTPException(400, f"Paid in {pay} - a salary advance repaid from pay is in {pay} too.")
    return cur


def _day(v: str, what: str) -> str:
    try:
        return date.fromisoformat((v or "").strip()[:10]).isoformat()
    except ValueError:
        raise HTTPException(400, f"{what} must be a date")


def _reason(v: str, what: str = "Say why") -> str:
    r = (v or "").strip()
    if len(r) < 3:
        raise HTTPException(400, what)
    return r[:1000]


# ── Lists ────────────────────────────────────────────────────────────────────

@router.get("")
def overview(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = sa.norm(user["email"])
    if sa.heal(db, me, "system"):
        db.commit()
    mine = (db.query(SalaryAdvance).filter(SalaryAdvance.employee_email == me)
            .order_by(SalaryAdvance.created_at.desc()).limit(100).all())
    can_hr = sa.hr_anywhere(db, me)
    hr_rows = []
    if can_hr:
        rows = (db.query(SalaryAdvance).filter(SalaryAdvance.employee_email != me)
                .order_by(SalaryAdvance.created_at.desc()).limit(500).all())
        hr_rows = [a for a in rows if sa.is_hr_for(db, user, a.employee_email)]
    names: dict = {}
    can_request = sa.can_request(user)
    return {"mine": [sa.serialize(db, a, names=names, viewer=user) for a in mine],
            "hr": [sa.serialize(db, a, names=names, viewer=user) for a in hr_rows],
            "canRequest": can_request, "canHr": can_hr,
            # Grant / decide need the pay grant too (sa.can_decide).
            "canGrant": bool(can_hr and sa.has_comp(db, user, write=True)),
            # Nothing to show: no option, no advance, not HR - the card hides.
            "show": bool(can_request or can_hr or mine),
            "payCurrency": sa.pay_currency(db, me), "payMethods": list(sa.PAY_METHODS),
            "maxInstallments": sa.MAX_INSTALLMENTS}


@router.get("/pending")
def pending(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """What waits on me as HR - salary_advance.pending_for_hr (the Approvals
    Inbox reads the same function)."""
    names: dict = {}
    return [sa.serialize(db, a, names=names, viewer=user) for a in sa.pending_for_hr(db, user)]


@router.get("/person/{email}")
def for_person(email: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    em = sa.norm(email)
    if em != sa.norm(user["email"]) and not sa.is_hr_for(db, user, em):
        raise HTTPException(404, "Not found")
    if sa.heal(db, em, "system"):
        db.commit()
    rows = (db.query(SalaryAdvance).filter(SalaryAdvance.employee_email == em)
            .order_by(SalaryAdvance.created_at.desc()).limit(200).all())
    names: dict = {}
    return {"email": em, "payCurrency": sa.pay_currency(db, em),
            "advances": [sa.serialize(db, a, names=names, viewer=user) for a in rows]}


# ── Ask / grant ──────────────────────────────────────────────────────────────

class RequestIn(BaseModel):
    amount: float
    currency: str = ""
    reason: str = ""
    installments: int = 1


def _new(db: Session, em: str, amount: float, currency: str, reason: str, n: int, status: str,
         source: str, actor: str) -> SalaryAdvance:
    emp = sa.person(db, em)
    now = sa._now()
    adv = SalaryAdvance(id=str(uuid.uuid4()), employee_email=em, employee_name=sa.name_of(db, em),
                        company=(emp.company or "") if emp else "", amount=amount, currency=currency,
                        reason=reason, installments=n, status=status, source=source,
                        requested_by=actor, requested_at=now, history=[], created_at=now, updated_at=now)
    return adv


@router.post("", status_code=201)
def request_advance(body: RequestIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Ask for my own advance - manager tier and up only (Neil, Oct 27)."""
    me = sa.norm(user["email"])
    if not sa.can_request(user):
        raise HTTPException(403, "Salary advances are requested by managers and above - ask HR.")
    amount, n = _amount(body.amount), _installments(body.installments)
    cur = _currency(db, me, body.currency)
    reason = _reason(body.reason, "Say what the advance is for")
    if db.query(SalaryAdvance.id).filter(SalaryAdvance.employee_email == me,
                                         SalaryAdvance.status == "requested").first():
        raise HTTPException(409, "You already have a request waiting for HR - cancel it or wait for HR's answer.")
    adv = _new(db, me, amount, cur, reason, n, "requested", "request", me)
    sa.log(adv, me, "requested", reason)
    db.add(adv)
    workflows.emit(db, "salary_advance.requested", subject=adv, actor=me)
    sa.tell_hr(db, adv, f"Salary Advance to Approve - {adv.employee_name}",
               f"{adv.employee_name} asked for a salary advance of {sa.money(amount, cur)}, repaid over "
               f"{n} pay period{'' if n == 1 else 's'}: {reason}", actor=me)
    db.commit()
    return _out(db, adv, user)


class GrantIn(RequestIn):
    email: str


@router.post("/grant", status_code=201)
def grant(body: GrantIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """HR gives anyone an advance directly (Neil, Oct 27) - approved at once,
    paid out with Mark Paid Out. Never your own (is_hr)."""
    me, em = sa.norm(user["email"]), sa.norm(body.email)
    emp = sa.person(db, em)
    if emp is None:
        raise HTTPException(404, "Pick someone in Nexus People")
    if em == me:
        raise HTTPException(403, "An advance for yourself is granted by another HR person.")
    if not sa.is_hr_for(db, user, em):
        raise HTTPException(404, "Pick someone in Nexus People")
    if not sa.can_decide(db, user, em):
        raise HTTPException(403, _NEEDS_PAY_GRANT)
    if (emp.status or "active").lower() in ("inactive", "offboarded", "terminated"):
        raise HTTPException(400, "This person has left - an advance can't be repaid from their pay.")
    amount, n = _amount(body.amount), _installments(body.installments)
    cur = _currency(db, em, body.currency)
    reason = _reason(body.reason, "Say what the advance is for")
    adv = _new(db, em, amount, cur, reason, n, "approved", "grant", me)
    adv.decided_by, adv.decided_at = me, sa._now()
    sa.log(adv, me, "granted", reason)
    db.add(adv)
    workflows.emit(db, "salary_advance.decided", subject=adv, actor=me, changes={"status": ("requested", "approved")},
                   extra={"decision": "grant", "note": reason, "installments": n})
    who = sa.name_of(db, me)
    sa.tell_person(db, adv, "Salary Advance Approved",
                   f"{who} granted you a salary advance of {sa.money(amount, cur)}, repaid over {n} pay "
                   f"period{'' if n == 1 else 's'} starting the pay period after it is paid out.", actor=me)
    sa.tell_hr(db, adv, f"Salary Advance to Pay Out - {adv.employee_name}",
               f"{who} granted {adv.employee_name} {sa.money(amount, cur)}. Mark it Paid Out once it is paid.", actor=me)
    db.commit()
    return _out(db, adv, user)


# ── HR decides ───────────────────────────────────────────────────────────────

class DecideIn(BaseModel):
    action: str                         # approve | decline
    note: str = ""
    installments: Optional[int] = None  # HR may change the count when approving


@router.post("/{aid}/decide")
def decide(aid: str, body: DecideIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = sa.norm(user["email"])
    adv = _get(db, aid)
    _hr_or_404(db, user, adv)
    if body.action not in ("approve", "decline"):
        raise HTTPException(400, "action must be approve or decline")
    if adv.status != "requested":
        raise HTTPException(409, f"Already {sa.STATUS_LABEL.get(adv.status, adv.status).lower()}")
    note = (body.note or "").strip()[:1000]
    who = sa.name_of(db, me)
    if body.action == "decline":
        if not note:
            raise HTTPException(400, "Add a note saying why")
        adv.status, adv.decided_by, adv.decided_at, adv.decision_note = "declined", me, sa._now(), note
        sa.log(adv, me, "declined", note)
        sa.tell_person(db, adv, "Salary Advance Declined",
                       f"{who} declined your salary advance of {sa.money(adv.amount, adv.currency)}: {note}", actor=me)
        sa.settle_hr(db, adv, f"Salary Advance Declined - {adv.employee_name}",
                     f"{who} declined it: {note}")
    else:
        if body.installments is not None:
            adv.installments = _installments(body.installments)
        adv.status, adv.decided_by, adv.decided_at, adv.decision_note = "approved", me, sa._now(), note
        sa.log(adv, me, "approved", note, {"installments": int(adv.installments or 1)})
        n = int(adv.installments or 1)
        sa.tell_person(db, adv, "Salary Advance Approved",
                       f"{who} approved your salary advance of {sa.money(adv.amount, adv.currency)}, repaid over {n} "
                       f"pay period{'' if n == 1 else 's'} starting the pay period after it is paid out.", actor=me)
        sa.tell_hr(db, adv, f"Salary Advance to Pay Out - {adv.employee_name}",
                   f"{who} approved {sa.money(adv.amount, adv.currency)}. Mark it Paid Out once it is paid.", actor=me)
    workflows.emit(db, "salary_advance.decided", subject=adv, actor=me, changes={"status": ("requested", adv.status)},
                   extra={"decision": body.action, "note": note, "installments": int(adv.installments or 1)})
    db.commit()
    return _out(db, adv, user)


class CancelIn(BaseModel):
    note: str = ""


@router.post("/{aid}/cancel")
def cancel(aid: str, body: CancelIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The requester cancels while it is Requested; HR cancels anything not
    yet paid out (with a note). A paid-out advance is never canceled - its
    schedule is changed instead."""
    me = sa.norm(user["email"])
    adv = _get(db, aid)
    mine = me == sa.norm(adv.employee_email)
    hr = sa.can_decide(db, user, adv.employee_email)
    if not mine and not hr:
        if sa.is_hr_for(db, user, adv.employee_email):
            raise HTTPException(403, _NEEDS_PAY_GRANT)
        raise HTTPException(404, "Salary advance not found")
    if adv.status == "requested" and mine:
        pass
    elif adv.status in ("requested", "approved") and hr:
        if not (body.note or "").strip():
            raise HTTPException(400, "Add a note saying why")
    elif adv.status == "approved":
        raise HTTPException(409, "It is approved - ask HR to cancel it")
    elif adv.status == "paid_out":
        raise HTTPException(409, "A paid-out advance is repaid from pay - HR changes its schedule instead")
    else:
        raise HTTPException(409, f"Already {sa.STATUS_LABEL.get(adv.status, adv.status).lower()}")
    note = (body.note or "").strip()[:1000]
    adv.status = "canceled"
    sa.log(adv, me, "canceled", note)
    who = sa.name_of(db, me)
    sa.settle_hr(db, adv, f"Salary Advance Canceled - {adv.employee_name}",
                 f"{who} canceled it{': ' + note if note else '.'}")
    if not mine:
        sa.tell_person(db, adv, "Salary Advance Canceled",
                       f"{who} canceled your salary advance of {sa.money(adv.amount, adv.currency)}: {note}", actor=me)
    db.commit()
    return _out(db, adv, user)


class PaidIn(BaseModel):
    paid_on: str
    payment_method: str = "ach"
    payment_ref: str = ""


@router.post("/{aid}/paid")
def mark_paid(aid: str, body: PaidIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """HR paid it out: the repayment schedule starts the next pay period."""
    me = sa.norm(user["email"])
    adv = _get(db, aid, lock_person=True)
    _hr_or_404(db, user, adv)
    if adv.status != "approved":
        raise HTTPException(409, "Only an approved advance can be paid out")
    paid_on = _day(body.paid_on, "Paid on")
    if paid_on > sa.local_today(db, me, adv):
        raise HTTPException(400, "Paid on can't be in the future")
    if body.payment_method not in sa.PAY_METHODS:
        raise HTTPException(400, f"Method must be one of: {', '.join(sa.PAY_METHODS)}")
    adv.status, adv.paid_on, adv.paid_by = "paid_out", paid_on, me
    adv.payment_method, adv.payment_ref = body.payment_method, (body.payment_ref or "").strip()[:120]
    try:
        rows, skipped = sa.build_schedule(db, adv)
    except ValueError as e:
        raise HTTPException(409, str(e))
    plan = ", ".join(f"{sa.money(r.amount, adv.currency)} from the pay period starting {sa.us_date(r.date)}" for r in rows)
    sa.log(adv, me, "paid_out", adv.payment_ref,
           {"schedule": [{"date": r.date, "amount": r.amount} for r in rows], "skippedFinalized": skipped})
    sa.tell_person(db, adv, "Salary Advance Paid Out",
                   f"Your salary advance of {sa.money(adv.amount, adv.currency)} was paid out on {sa.us_date(paid_on)}. "
                   f"It is repaid from your pay: {plan}.", actor=me)
    sa.settle_hr(db, adv, f"Salary Advance Paid Out - {adv.employee_name}",
                 f"{sa.name_of(db, me)} paid it out on {sa.us_date(paid_on)}.")
    db.commit()
    return _out(db, adv, user)


# ── HR changes the repayment ─────────────────────────────────────────────────

class MoveIn(BaseModel):
    date: str            # any day of the pay period it should come out of
    reason: str = ""


@router.post("/{aid}/installments/{iid}/move")
def move(aid: str, iid: str, body: MoveIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = sa.norm(user["email"])
    adv = _get(db, aid, lock_person=True)
    _hr_or_404(db, user, adv)
    if adv.status != "paid_out":
        raise HTTPException(409, "Only a paid-out advance has installments to move")
    row = (db.query(SalaryAdvanceInstallment)
           .filter(SalaryAdvanceInstallment.id == iid, SalaryAdvanceInstallment.advance_id == adv.id).first())
    if row is None:
        raise HTTPException(404, "Installment not found")
    if row.status != "scheduled":
        raise HTTPException(409, "That installment has already been repaid" if row.status == "deducted"
                            else "That installment was replaced")
    reason = _reason(body.reason, "Give a reason - it is logged on the advance")
    to_day = _day(body.date, "The pay period")
    old = row.date
    try:
        start, skipped = sa.move_installment(db, adv, row, to_day, reason, me)
    except ValueError as e:
        raise HTTPException(409, str(e))
    sa.tell_person(db, adv, "Salary Advance Repayment Moved",
                   f"{sa.name_of(db, me)} moved the {sa.money(row.amount, adv.currency)} repayment from the pay period "
                   f"starting {sa.us_date(old)} to the one starting {sa.us_date(start)}: {reason}", actor=me)
    db.commit()
    out = _out(db, adv, user)
    out["skippedFinalized"] = skipped
    return out


class ScheduleItem(BaseModel):
    date: str
    amount: float


class ScheduleIn(BaseModel):
    installments: List[ScheduleItem]
    reason: str = ""


@router.put("/{aid}/schedule")
def set_schedule(aid: str, body: ScheduleIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = sa.norm(user["email"])
    adv = _get(db, aid, lock_person=True)
    _hr_or_404(db, user, adv)
    if adv.status != "paid_out":
        raise HTTPException(409, "Only a paid-out advance has a repayment schedule")
    reason = _reason(body.reason, "Give a reason - it is logged on the advance")
    try:
        rows, skipped = sa.reschedule(db, adv, [i.model_dump() for i in body.installments], reason, me)
    except ValueError as e:
        raise HTTPException(400, str(e))
    plan = ", ".join(f"{sa.money(r.amount, adv.currency)} from {sa.us_date(r.date)}" for r in rows)
    sa.tell_person(db, adv, "Salary Advance Schedule Changed",
                   f"{sa.name_of(db, me)} changed how your salary advance is repaid: {plan}. Why: {reason}", actor=me)
    db.commit()
    out = _out(db, adv, user)
    out["skippedFinalized"] = skipped
    return out
