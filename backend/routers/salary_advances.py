"""Salary advances (Neil, Oct 27 2026; asked from the Time Sheet, Oct 29
2026). The rules, the schedule and the pay card line live in
salary_advance.py (its docstring has the who / where / what-you-see rules);
this is the routes.

    GET    /salary-advances/pending               HR: requests to decide, advances to pay out
    GET    /salary-advances/person/{email}        the person, HR for them, their direct manager
    POST   /salary-advances/for/{email}           from the person's Time Sheet: grant or request
                                                  (sa.can_request_for)
    POST   /salary-advances                       never for yourself - 403; with someone else's
                                                  `email` it is /for/{email}
    POST   /salary-advances/grant                 HR with the pay grant grants one directly
    POST   /salary-advances/{id}/decide           HR: approve | decline
    POST   /salary-advances/{id}/cancel           the requester (while Requested), or HR (before payout)
    POST   /salary-advances/{id}/paid             HR: paid out on a date - builds the repayment schedule
    POST   /salary-advances/{id}/installments/{iid}/move   HR: to a later pay period, with why
    PUT    /salary-advances/{id}/schedule         HR: replace what is left to repay, with why

Nobody asks for their own advance (Neil, 10/29/2026: "Workday is not the
right place for this"). Pay is restricted: what a viewer sees is
salary_advance.view_of; deciding needs the pay grant (can_decide). Bells are
server-side, one notice per advance for HR, one for the person and one for
the manager who asked, updated in place, each opening the person's Time
Sheet. Advances asked for before Oct 29 2026 (a manager's own, from the
Workday card) keep working: HR decides, pays out and reschedules them here.
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
    if sa.view_of(db, user, adv) == "requester":
        raise HTTPException(403, "HR decides on the salary advance you asked for.")
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

@router.get("/pending")
def pending(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """What waits on me as HR - salary_advance.pending_for_hr (the Approvals
    Inbox reads the same function)."""
    names: dict = {}
    return [sa.serialize(db, a, names=names, viewer=user) for a in sa.pending_for_hr(db, user)]


@router.get("/person/{email}")
def for_person(email: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The Salary Advances panel of `email`'s Time Sheet: the person, HR for
    them and their direct manager (anyone else 404), each seeing what
    sa.view_of allows, and what the caller may ask for (`canAsk`)."""
    em = sa.norm(email)
    if em != sa.norm(user["email"]) and not sa.is_hr_for(db, user, em) and not sa.is_direct_manager(db, user, em):
        raise HTTPException(404, "Not found")
    if sa.heal(db, em, "system"):
        db.commit()
    rows = (db.query(SalaryAdvance).filter(SalaryAdvance.employee_email == em)
            .order_by(SalaryAdvance.created_at.desc()).limit(200).all())
    names: dict = {}
    return {"email": em, "name": sa.name_of(db, em), "payCurrency": sa.pay_currency(db, em),
            "advances": [sa.serialize(db, a, names=names, viewer=user) for a in rows if sa.view_of(db, user, a)],
            "canAsk": sa.can_request_for(db, user, em), "maxInstallments": sa.MAX_INSTALLMENTS,
            "payMethods": list(sa.PAY_METHODS)}


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


_OWN = "An advance is requested by your manager or HR, from your Time Sheet."
_NOT_YOURS = "Only their direct manager or HR asks for a salary advance for someone - from their Time Sheet."


def _target(db: Session, user: dict, email: str):
    """The person an advance is asked for: never yourself (rule 1), someone
    in Nexus People."""
    me, em = sa.norm(user["email"]), sa.norm(email)
    if not em or em == me:
        raise HTTPException(403, _OWN)
    emp = sa.person(db, em)
    if emp is None:
        raise HTTPException(404, "Pick someone in Nexus People")
    return em, emp


def _not_left(emp) -> None:
    """Checked once the caller may ask - so a stranger learns nothing."""
    if sa.has_left(emp):
        raise HTTPException(400, "This person has left - an advance can't be repaid from their pay.")


def _ask(db: Session, user: dict, em: str, body: RequestIn) -> SalaryAdvance:
    """A request for HR to decide, by the direct manager or HR without the
    pay grant (rule 2)."""
    me = sa.norm(user["email"])
    amount, n = _amount(body.amount), _installments(body.installments)
    cur = _currency(db, em, body.currency)
    reason = _reason(body.reason, "Say what the advance is for")
    if db.query(SalaryAdvance.id).filter(SalaryAdvance.employee_email == em,
                                         SalaryAdvance.status == "requested").first():
        raise HTTPException(409, f"{sa.name_of(db, em)} already has a request waiting for HR.")
    adv = _new(db, em, amount, cur, reason, n, "requested", "request", me)
    sa.log(adv, me, "requested", reason)
    db.add(adv)
    workflows.emit(db, "salary_advance.requested", subject=adv, actor=me)
    sa.tell_hr(db, adv, f"Salary Advance to Approve - {adv.employee_name}",
               f"{sa.name_of(db, me)} asked for a salary advance of {sa.money(amount, cur)} for "
               f"{adv.employee_name}, repaid over {n} pay period{'' if n == 1 else 's'}: {reason}", actor=me)
    return adv


def _grant(db: Session, user: dict, em: str, body: RequestIn) -> SalaryAdvance:
    """HR with the pay grant gives the advance directly - approved at once,
    paid out with Mark Paid Out."""
    me = sa.norm(user["email"])
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
    return adv


@router.post("/for/{email}", status_code=201)
def ask_for(email: str, body: RequestIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """From `email`'s Time Sheet (Neil, Oct 29 2026): HR with the pay grant
    grants it; their direct manager, or HR without the pay grant, sends a
    request to HR; anyone else is refused (sa.can_request_for)."""
    em, emp = _target(db, user, email)
    how = sa.can_request_for(db, user, em)
    if not how:
        if sa.is_hr_for(db, user, em) or sa.is_direct_manager(db, user, em):
            _not_left(emp)     # can_request_for says "" for someone who has left
        raise HTTPException(403, _NOT_YOURS)
    adv = _grant(db, user, em, body) if how == "grant" else _ask(db, user, em, body)
    db.commit()
    return _out(db, adv, user)


class AskIn(RequestIn):
    email: str = ""


@router.post("", status_code=201)
def request_advance(body: AskIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Never for yourself (rule 1, Oct 29 2026) - the Workday request is
    gone. With someone else's `email` it is the Time Sheet's ask."""
    if not (body.email or "").strip() or sa.norm(body.email) == sa.norm(user["email"]):
        raise HTTPException(403, _OWN)
    return ask_for(body.email, RequestIn(**body.model_dump(exclude={"email"})), user=user, db=db)


class GrantIn(RequestIn):
    email: str


@router.post("/grant", status_code=201)
def grant(body: GrantIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """HR with the pay grant gives someone an advance directly (Neil, Oct 27)
    - the same checks as the Time Sheet's ask. Never your own."""
    me, em = sa.norm(user["email"]), sa.norm(body.email)
    if em == me:
        raise HTTPException(403, "An advance for yourself is granted by another HR person.")
    em, emp = _target(db, user, em)
    if not sa.is_hr_for(db, user, em):
        raise HTTPException(404, "Pick someone in Nexus People")
    if not sa.can_decide(db, user, em):
        raise HTTPException(403, _NEEDS_PAY_GRANT)
    _not_left(emp)
    adv = _grant(db, user, em, body)
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
        sa.tell_requester(db, adv, f"Salary Advance Declined - {adv.employee_name}",
                          f"{who} declined the salary advance you asked for {adv.employee_name}.", actor=me)
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
        sa.tell_requester(db, adv, f"Salary Advance Approved - {adv.employee_name}",
                          f"{who} approved the salary advance you asked for {adv.employee_name}.", actor=me)
    workflows.emit(db, "salary_advance.decided", subject=adv, actor=me, changes={"status": ("requested", adv.status)},
                   extra={"decision": body.action, "note": note, "installments": int(adv.installments or 1)})
    db.commit()
    return _out(db, adv, user)


class CancelIn(BaseModel):
    note: str = ""


@router.post("/{aid}/cancel")
def cancel(aid: str, body: CancelIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The one who asked cancels while it is Requested (the manager, or HR
    without the pay grant - or, for a request made before Oct 29 2026, the
    person who asked for their own); HR cancels anything not yet paid out
    (with a note). A paid-out advance is never canceled - its schedule is
    changed instead."""
    me = sa.norm(user["email"])
    adv = _get(db, aid)
    asker = (adv.source or "request") == "request" and me == sa.norm(adv.requested_by)
    hr = sa.can_decide(db, user, adv.employee_email)
    if not asker and not hr:
        if sa.is_hr_for(db, user, adv.employee_email):
            raise HTTPException(403, _NEEDS_PAY_GRANT)
        if me == sa.norm(adv.employee_email):
            raise HTTPException(403, "HR or whoever asked for it cancels it.")
        raise HTTPException(404, "Salary advance not found")
    if adv.status == "requested" and asker:
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
    if not asker:
        sa.tell_person(db, adv, "Salary Advance Canceled",
                       f"{who} canceled your salary advance of {sa.money(adv.amount, adv.currency)}: {note}", actor=me)
        sa.tell_requester(db, adv, f"Salary Advance Canceled - {adv.employee_name}",
                          f"{who} canceled the salary advance you asked for {adv.employee_name}.", actor=me)
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
