"""Salary advances (Neil, Oct 27 2026) - the rules, the schedule and the
pay card line. The routes are routers/salary_advances.py.

Who asks: a person whose role tier is manager or above (auth._LEVELS:
manager 3, administrator 4, owner 5), for themself. Everyone else does not
see the option.
Who decides: ONLY HR as on time sheets - timesheet_review.is_hr (the
person's company HR contact, an administrator or owner, a Full HR grant),
inside the company walls. HR approves or declines a request and can grant an
advance to anyone directly. Nobody decides their own (is_hr is never true on
your own record - the own-pay rule).

Repayment: when HR marks an advance Paid Out (with the date), it is split
into its installments (default 1) and the first comes out of the NEXT pay
period after the payout, one more each period after that. A pay period
that is already finalized is skipped - the installment moves forward on its
own; a finalized card is never edited. HR can move an installment to a
later period or replace the remaining schedule, always with a reason; every
change is on the advance's history.

On the pay card each installment is a "Salary Advance Repayment" line
(timeclock._add_advance_repayments, hourly and fixed-salary cards alike).
It is a DEDUCTION from what is paid out, not a cut in wages: `totalPay`
stays the gross the hours and salary earn (taxes and the wage lines in the
exports read it), and the card gains `advanceRepayment` and `netPay`. A
period never pays out less than zero: when the installment is more than the
period's pay, the card takes what there is and, when the period is
finalized, the rest moves to the next open period. Finalizing a period
records what its card took (on_finalize); unlocking it puts the
installment back (on_unfinalize).

Status: requested -> approved -> paid_out (stored); Repaying and Repaid are
read off the installments; declined and canceled end it. Nothing is ever
deleted.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from models import (HrEntity, NexusEmployee, NexusNotification, NexusRole, PayrollRate, SalaryAdvance,
                    SalaryAdvanceInstallment)

LINE_LABEL = "Salary Advance Repayment"
PAY_CLASS = "advanceRepayment"            # payroll_codes.PAY_CLASSES key
MAX_AMOUNT = 1_000_000                    # a typo guard, not a policy limit
MAX_INSTALLMENTS = 24
PAY_METHODS = ("payroll", "ach", "check", "other")
ACTION = {"view": "myhr", "sub": "salary-advances"}
STATUS_LABEL = {"requested": "Requested", "approved": "Approved", "declined": "Declined",
                "paid_out": "Paid Out", "repaying": "Repaying", "repaid": "Repaid", "canceled": "Canceled"}
ACTION_WORD = {"requested": "Requested", "granted": "Granted by HR", "approved": "Approved", "declined": "Declined",
               "canceled": "Canceled", "paid_out": "Paid Out", "moved": "Installment Moved",
               "rescheduled": "Schedule Changed", "deducted": "Repaid From Pay", "carried": "Carried Forward",
               "reopened": "Period Unlocked", "skipped": "Moved Past a Finalized Period"}
_EPS = 0.004


# ── Small helpers ────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def norm(e: str) -> str:
    return (e or "").strip().lower()


def _tc():
    from routers import timeclock
    return timeclock


def _tsr():
    import timesheet_review
    return timesheet_review


def r2(v) -> float:
    return round(float(v or 0) + 0.0, 2)


def us_date(iso: str) -> str:
    return _tsr().us_date(iso)


def money(amount, currency: str = "USD") -> str:
    from currency import money_prefix
    return f"{money_prefix((currency or 'USD').upper())}{float(amount or 0):,.2f}"


def person(db: Session, email: str):
    return db.query(NexusEmployee).filter(func.lower(NexusEmployee.work_email) == norm(email)).first()


def name_of(db: Session, email: str) -> str:
    p = person(db, email)
    n = f"{(p.first_name or '') if p else ''} {(p.last_name or '') if p else ''}".strip()
    return n or email


def can_request(user: dict) -> bool:
    """Manager tier and up ask for their own advance (Neil, Oct 27)."""
    from auth import _LEVELS
    return int(user.get("level") or 0) >= _LEVELS["manager"]


def pay_currency(db: Session, email: str) -> str:
    """The currency the person is paid in: the time clock rate, else the HR
    record's Pay & Benefits, else USD."""
    rr = db.query(PayrollRate).filter(PayrollRate.employee_email == norm(email)).first()
    if rr and (rr.currency or "").strip():
        return rr.currency.strip().upper()
    p = person(db, email)
    cur = ((getattr(p, "compensation", None) or {}).get("currency") if p else "") or ""
    return cur.strip().upper() or "USD"


def has_pay_rate(db: Session, email: str) -> bool:
    return db.query(PayrollRate.employee_email).filter(PayrollRate.employee_email == norm(email)).first() is not None


def is_hr_for(db: Session, user: dict, email: str) -> bool:
    """HR++ for this person: timesheet_review.is_hr (never on your own
    record), inside the caller's company wall. Remembered for the session's
    request, so a list of many advances asks once per person."""
    from auth import company_ok, company_scope
    key = (norm(user.get("email")), norm(email))
    memo = db.info.setdefault("_advance_hr_for", {})
    if key in memo:
        return memo[key]
    ok = False
    if _tsr().is_hr(db, user.get("email") or "", email):
        p = person(db, email)
        if "_advance_scope" not in db.info or db.info["_advance_scope"][0] != key[0]:
            db.info["_advance_scope"] = (key[0], company_scope(user, db))
        ok = company_ok((p.company if p else "") or "", db.info["_advance_scope"][1])
    memo[key] = ok
    return ok


def hr_anywhere(db: Session, email: str) -> bool:
    """Could this person be HR for anyone - so the HR side is worth showing."""
    from auth import _LEVELS, _MODULE_LEVEL_RANK, _module_level, level_for
    me = norm(email)
    if level_for(me, db) >= _LEVELS["administrator"]:
        return True
    if _module_level(me, "hr", db) >= _MODULE_LEVEL_RANK["full"]:
        return True
    return db.query(HrEntity).filter(func.lower(HrEntity.hr_contact_email) == me).first() is not None


def log(adv: SalaryAdvance, by: str, action: str, note: str = "", detail: dict | None = None) -> None:
    # Reassign, never append in place: a JSON column's mutation is not tracked.
    entry = {"at": _now(), "by": by, "action": action, "note": note}
    if detail:
        entry["detail"] = detail
    adv.history = list(adv.history or []) + [entry]
    adv.updated_at = _now()


def _forget(db: Session) -> None:
    """Drop the per-session "who has an installment" cache after a write."""
    db.info.pop("_advance_emails", None)


# ── Pay periods ──────────────────────────────────────────────────────────────

def period_of(db: Session, email: str, day: str) -> tuple[str, str]:
    """The pay period holding `day`, as the time sheet bounds it (monthly for
    fixed salary, bi-weekly for hourly)."""
    s, e, _pt = _tsr().period_for(db, norm(email), day)
    return s, e


def finalized(db: Session, email: str, start: str, end: str) -> bool:
    return _tc()._finalized_row(db, norm(email), start, end) is not None


def _day_after(iso: str) -> str:
    return (date.fromisoformat(iso) + timedelta(days=1)).isoformat()


def open_period_from(db: Session, email: str, day: str) -> tuple[str, bool]:
    """(start, skipped): the first pay period on or after `day` that is not
    finalized, and whether a finalized one had to be skipped to get there."""
    d, skipped = day, False
    for _ in range(600):
        s, e = period_of(db, email, d)
        if not finalized(db, email, s, e):
            return s, skipped
        skipped, d = True, _day_after(e)
    raise ValueError("No open pay period found")


def next_open_after(db: Session, email: str, day: str) -> tuple[str, bool]:
    """The first open pay period AFTER the one holding `day`."""
    _s, e = period_of(db, email, day)
    return open_period_from(db, email, _day_after(e))


def split(amount: float, n: int) -> list[float]:
    """`amount` in `n` installments to the cent; the last takes the remainder."""
    n = max(1, int(n or 1))
    cents = int(round(float(amount or 0) * 100))
    base = cents // n
    parts = [base] * n
    parts[-1] += cents - base * n
    return [p / 100 for p in parts]


# ── Reading an advance ───────────────────────────────────────────────────────

def installments(db: Session, adv_id: str) -> list[SalaryAdvanceInstallment]:
    return (db.query(SalaryAdvanceInstallment).filter(SalaryAdvanceInstallment.advance_id == adv_id)
            .order_by(SalaryAdvanceInstallment.date, SalaryAdvanceInstallment.seq).all())


def figures(adv: SalaryAdvance, rows: list) -> dict:
    """What was repaid, what is left and the status to show."""
    repaid = r2(sum(float(r.deducted_amount or 0) for r in rows if r.status == "deducted"))
    scheduled = r2(sum(float(r.amount or 0) for r in rows if r.status == "scheduled"))
    owed = adv.status == "paid_out"
    balance = r2(max(0.0, float(adv.amount or 0) - repaid)) if owed else 0.0
    status = adv.status
    if owed:
        status = "repaid" if balance <= _EPS else ("repaying" if repaid > _EPS else "paid_out")
    return {"repaid": repaid, "scheduled": scheduled, "balance": balance, "status": status}


def outstanding(db: Session, email: str) -> list[dict]:
    """Every paid-out advance of this person with money still to recover:
    [{id, amount, currency, repaid, balance, paidOn, reason}] - the exit
    statement reads it."""
    out = []
    for adv in (db.query(SalaryAdvance)
                .filter(SalaryAdvance.employee_email == norm(email), SalaryAdvance.status == "paid_out")
                .order_by(SalaryAdvance.paid_on).all()):
        f = figures(adv, installments(db, adv.id))
        if f["balance"] > _EPS:
            out.append({"id": adv.id, "amount": r2(adv.amount), "currency": adv.currency or "USD",
                        "repaid": f["repaid"], "balance": f["balance"], "paidOn": adv.paid_on or "",
                        "reason": adv.reason or ""})
    return out


def pending_for_hr(db: Session, user: dict) -> list[SalaryAdvance]:
    """What waits on this HR person: requests to decide and approved
    advances to pay out - for the Approvals Inbox (one query, filtered by
    is_hr_for)."""
    rows = (db.query(SalaryAdvance).filter(SalaryAdvance.status.in_(("requested", "approved")),
                                           SalaryAdvance.employee_email != norm(user.get("email")))
            .order_by(SalaryAdvance.created_at).limit(500).all())
    return [a for a in rows if is_hr_for(db, user, a.employee_email)]


def serialize(db: Session, adv: SalaryAdvance, rows: list | None = None, names: dict | None = None) -> dict:
    rows = installments(db, adv.id) if rows is None else rows
    names = {} if names is None else names

    def nm(e: str) -> str:
        e = norm(e)
        if not e:
            return ""
        if e not in names:
            names[e] = name_of(db, e)
        return names[e]
    f = figures(adv, rows)
    schedule = []
    for r in rows:
        if r.status == "canceled":
            continue
        ps, pe = period_of(db, adv.employee_email, r.date)
        schedule.append({"id": r.id, "seq": r.seq, "date": r.date, "periodStart": ps, "periodEnd": pe,
                         "amount": r2(r.amount), "deductedAmount": r2(r.deducted_amount), "status": r.status,
                         "carriedFrom": r.carried_from or "", "currency": r.currency or adv.currency})
    return {"id": adv.id, "email": adv.employee_email, "name": adv.employee_name or nm(adv.employee_email),
            "company": adv.company or "", "amount": r2(adv.amount), "currency": adv.currency or "USD",
            "reason": adv.reason or "", "installments": int(adv.installments or 1),
            "status": f["status"], "statusLabel": STATUS_LABEL.get(f["status"], f["status"].title()),
            "source": adv.source or "request",
            "requestedBy": adv.requested_by or "", "requestedByName": nm(adv.requested_by),
            "requestedAt": adv.requested_at or "",
            "decidedByName": nm(adv.decided_by), "decidedAt": adv.decided_at or "",
            "decisionNote": adv.decision_note or "",
            "paidOn": adv.paid_on or "", "paidByName": nm(adv.paid_by), "paymentMethod": adv.payment_method or "",
            "paymentRef": adv.payment_ref or "",
            "repaid": f["repaid"], "balance": f["balance"], "scheduled": f["scheduled"], "schedule": schedule,
            "history": [{**h, "byName": nm(h.get("by", "")), "label": ACTION_WORD.get(h.get("action"), h.get("action"))}
                        for h in (adv.history or [])],
            "createdAt": adv.created_at or "", "updatedAt": adv.updated_at or ""}


# ── Notices: one per advance for HR, one per advance for the person ──────────

def _hr_key(adv: SalaryAdvance) -> str:
    return f"salary-advance:{adv.id}"


def _person_key(adv: SalaryAdvance) -> str:
    return f"salary-advance:{adv.id}:person"


def hr_people(db: Session, adv: SalaryAdvance) -> list[str]:
    """Who hears HR is up - as on time sheets and reimbursements: the
    company's HR contact, and when there is none the owners. Never the
    person themself."""
    hr = _tsr().hr_of(db, adv.employee_email)
    out = [hr] if hr else [norm(x.email) for x in db.query(NexusRole).filter(NexusRole.role == "owner").all()]
    return [e for e in out if e and e != norm(adv.employee_email)]


def tell_hr(db: Session, adv: SalaryAdvance, title: str, line: str, actor: str = "") -> None:
    from notify_rollup import upsert_rollup
    for who in hr_people(db, adv):
        if who == norm(actor):
            continue
        upsert_rollup(db, recipient=who, key=_hr_key(adv), title=title, line=line, action=ACTION,
                      company=adv.company or "", requested_by=actor, replace=True, priority=1)


def settle_hr(db: Session, adv: SalaryAdvance, title: str, line: str) -> None:
    """HR's notice is done with: resolved in place for everyone who got it."""
    from notify_rollup import resolve_rollup
    key = _hr_key(adv)
    got = {r.recipient for r in db.query(NexusNotification.recipient).filter(NexusNotification.ref_id == key).all()}
    got |= {o.recipient for o in db.new if isinstance(o, NexusNotification) and o.ref_id == key}
    for who in got:
        resolve_rollup(db, recipient=who, key=key, title=title, line=line)


def tell_person(db: Session, adv: SalaryAdvance, title: str, line: str, actor: str = "") -> None:
    """The person's one notice for this advance, a line added at each step."""
    from notify_rollup import upsert_rollup
    em = norm(adv.employee_email)
    if not em or em == norm(actor):
        return
    upsert_rollup(db, recipient=em, key=_person_key(adv), title=title, line=line, action=ACTION,
                  company=adv.company or "", requested_by=actor)


# ── The schedule ─────────────────────────────────────────────────────────────

def _new_installment(adv: SalaryAdvance, seq: int, amount: float, day: str, carried_from: str = "") -> SalaryAdvanceInstallment:
    now = _now()
    return SalaryAdvanceInstallment(id=str(uuid.uuid4()), advance_id=adv.id, employee_email=norm(adv.employee_email),
                                    seq=seq, amount=r2(amount), currency=adv.currency or "USD", date=day,
                                    status="scheduled", deducted_amount=0.0, final_approval_id="",
                                    carried_from=carried_from, created_at=now, updated_at=now)


def build_schedule(db: Session, adv: SalaryAdvance) -> tuple[list, bool]:
    """The installments of a just-paid-out advance: the first in the next
    open pay period after the payout date, one per period after it."""
    em = adv.employee_email
    out, prev, skipped_any = [], adv.paid_on, False
    for i, amt in enumerate(split(adv.amount, adv.installments or 1)):
        start, skipped = next_open_after(db, em, prev)
        skipped_any = skipped_any or skipped
        row = _new_installment(adv, i + 1, amt, start)
        db.add(row)
        out.append(row)
        prev = start
    _forget(db)
    return out, skipped_any


def _max_seq(db: Session, adv_id: str) -> int:
    n = db.query(func.max(SalaryAdvanceInstallment.seq)).filter(SalaryAdvanceInstallment.advance_id == adv_id).scalar()
    pending = [o.seq or 0 for o in db.new if isinstance(o, SalaryAdvanceInstallment) and o.advance_id == adv_id]
    return max([int(n or 0)] + pending)


def earliest_start(db: Session, adv: SalaryAdvance) -> str:
    """No installment may come out of the payout's own period or earlier."""
    _s, e = period_of(db, adv.employee_email, adv.paid_on)
    return _day_after(e)


def move_installment(db: Session, adv: SalaryAdvance, row: SalaryAdvanceInstallment, to_day: str,
                     reason: str, actor: str) -> tuple[str, bool]:
    """Move one scheduled installment to the pay period holding `to_day`
    (or the next open one after it). Returns (new start, skipped)."""
    em = adv.employee_email
    s, e = period_of(db, em, row.date)
    if finalized(db, em, s, e):
        raise ValueError("That installment's pay period is finalized - it has been repaid from that pay.")
    if to_day < earliest_start(db, adv):
        raise ValueError("An installment comes out of a pay period after the advance was paid out.")
    start, skipped = open_period_from(db, em, to_day)
    old = row.date
    if start == old:
        raise ValueError("The installment is already in that pay period.")
    row.date, row.updated_at = start, _now()
    _forget(db)
    detail = {"installment": row.id, "from": old, "to": start, "amount": r2(row.amount)}
    log(adv, actor, "moved", reason, detail)
    return start, skipped


def reschedule(db: Session, adv: SalaryAdvance, items: list[dict], reason: str, actor: str) -> tuple[list, bool]:
    """Replace every installment still to come with `items` ([{date,
    amount}]) - they must add up to the balance left. Deducted rows stay."""
    em = adv.employee_email
    rows = installments(db, adv.id)
    f = figures(adv, rows)
    if not items:
        raise ValueError("Add at least one installment.")
    if len(items) > MAX_INSTALLMENTS:
        raise ValueError(f"At most {MAX_INSTALLMENTS} installments.")
    floor = earliest_start(db, adv)
    clean = []
    for it in items:
        day = str(it.get("date") or "")[:10]
        try:
            date.fromisoformat(day)
        except ValueError:
            raise ValueError("Each installment needs a date.")
        amt = r2(it.get("amount"))
        if amt <= 0:
            raise ValueError("Each installment needs an amount above zero.")
        if day < floor:
            raise ValueError("An installment comes out of a pay period after the advance was paid out.")
        clean.append((day, amt))
    total = r2(sum(a for _d, a in clean))
    if abs(total - f["balance"]) > _EPS:
        raise ValueError(f"The installments add up to {money(total, adv.currency)} - they must add up to the "
                         f"{money(f['balance'], adv.currency)} still owed.")
    for r in rows:
        if r.status == "scheduled":
            s, e = period_of(db, em, r.date)
            if finalized(db, em, s, e):
                raise ValueError(f"The installment in the period from {us_date(s)} is in a finalized period - "
                                 f"unlock it or let it be repaid first.")
    before = [{"date": r.date, "amount": r2(r.amount)} for r in rows if r.status == "scheduled"]
    for r in rows:
        if r.status == "scheduled":
            r.status, r.updated_at = "canceled", _now()
    seq = _max_seq(db, adv.id)
    made, skipped_any = [], False
    for day, amt in sorted(clean):
        start, skipped = open_period_from(db, em, day)
        skipped_any = skipped_any or skipped
        seq += 1
        row = _new_installment(adv, seq, amt, start)
        db.add(row)
        made.append(row)
    adv.installments = len([r for r in rows if r.status == "deducted"]) + len(made)
    _forget(db)
    log(adv, actor, "rescheduled", reason,
        {"before": before, "after": [{"date": r.date, "amount": r2(r.amount)} for r in made]})
    return made, skipped_any


# ── The pay card ─────────────────────────────────────────────────────────────

def _rows_in(db: Session, em: str, start: str, end: str) -> list:
    """Live installments dated inside [start, end]. Who has any at all is
    read once per session: most cards have none (payroll readiness builds a
    card per person). Status is checked in Python: sessions run
    autoflush=False, so a row changed earlier in this request (finalize)
    still matches the SQL as it was."""
    who = db.info.get("_advance_emails")
    if who is None:
        who = db.info["_advance_emails"] = {e for (e,) in db.query(SalaryAdvanceInstallment.employee_email)
                                            .filter(SalaryAdvanceInstallment.status != "canceled").distinct()}
    if em not in who:
        return []
    rows = (db.query(SalaryAdvanceInstallment)
            .filter(SalaryAdvanceInstallment.employee_email == em,
                    SalaryAdvanceInstallment.date >= (start or "0"), SalaryAdvanceInstallment.date <= (end or "9"))
            .order_by(SalaryAdvanceInstallment.date, SalaryAdvanceInstallment.seq).all())
    return [r for r in rows if r.status in ("scheduled", "deducted")]


def card_lines(db: Session, em: str, start: str, end: str, gross: float, currency: str = "") -> list[dict]:
    """The repayment lines of one card. A finalized period shows what it
    took (deducted_amount); an open one takes each installment in full while
    the period's pay lasts, never below zero. An installment in another
    currency than the card's is shown and not taken (HR recovers it outside
    payroll)."""
    rows = _rows_in(db, norm(em), start, end)
    if not rows:
        return []
    currency = (currency or pay_currency(db, em)).upper()
    left = max(0.0, float(gross or 0))
    out = []
    for r in sorted(rows, key=lambda x: (x.status != "deducted", x.date, x.seq)):
        line = {"id": r.id, "advanceId": r.advance_id, "date": r.date, "seq": r.seq, "status": r.status,
                "amount": r2(r.amount), "currency": r.currency or currency, "label": LINE_LABEL}
        if r.status == "deducted":
            applied = r2(r.deducted_amount)
        elif finalized(db, em, *period_of(db, em, r.date)):
            # Never edit a finalized card: a scheduled row left inside one
            # (finalized before it was recorded) is not taken there - heal()
            # moves it forward.
            applied = 0.0
            line["note"] = "Moves to the next open pay period - this one is finalized."
        elif (r.currency or currency) != currency:
            applied = 0.0
            line["note"] = f"In {r.currency}, not the pay currency {currency} - recovered outside payroll."
        else:
            applied = r2(min(float(r.amount or 0), left))
            if applied + _EPS < float(r.amount or 0):
                line["note"] = (f"This period's pay covers {money(applied, currency)}; the other "
                                f"{money(r2(float(r.amount) - applied), currency)} moves to the next pay period "
                                f"when this one is finalized.")
        left = max(0.0, left - applied)
        line["applied"] = applied
        out.append(line)
    return out


def heal(db: Session, email: str, actor: str = "system") -> int:
    """Move forward any scheduled installment that sits in a pay period
    finalized without recording it (a finalize that failed to, or one from
    before a pay type change): it is never taken from a finalized card.
    Returns how many moved; the caller commits."""
    em = norm(email)
    rows = (db.query(SalaryAdvanceInstallment)
            .filter(SalaryAdvanceInstallment.employee_email == em, SalaryAdvanceInstallment.status == "scheduled").all())
    moved = 0
    for r in rows:
        s, e = period_of(db, em, r.date)
        if not finalized(db, em, s, e):
            continue
        adv = db.query(SalaryAdvance).filter(SalaryAdvance.id == r.advance_id).with_for_update().first()
        start, _sk = open_period_from(db, em, _day_after(e))
        old, r.date, r.updated_at = r.date, start, _now()
        moved += 1
        if adv is not None:
            log(adv, actor, "skipped", f"The pay period from {us_date(s)} was already finalized - the installment "
                                       f"moved to the period from {us_date(start)}.",
                {"installment": r.id, "from": old, "to": start})
    if moved:
        _forget(db)
    return moved


# ── Finalize / unlock (timeclock.finalize_timecard / unfinalize_timecard) ────

def on_finalize(db: Session, em: str, start: str, end: str, final_id: str, actor: str) -> int:
    """The period is being finalized: record what its card takes for each
    installment in it, and carry any shortfall to the next open period.
    Inside the finalize transaction (the final row is not flushed yet, so the
    card is still the live one - the same figures the snapshot froze)."""
    em = norm(em)
    rows = [r for r in _rows_in(db, em, start, end) if r.status == "scheduled"]
    if not rows:
        return 0
    tc = _tc()
    pay_type = tc._pay_type(db, em)
    card = _tsr().card_for(db, em, start, end, pay_type)
    applied = {ln["id"]: ln["applied"] for ln in card.get("advanceRepayments") or []}
    cur = card.get("currency") or pay_currency(db, em)
    span = f"{us_date(start)} - {us_date(end)}"
    for r in rows:
        adv = db.query(SalaryAdvance).filter(SalaryAdvance.id == r.advance_id).with_for_update().first()
        if adv is None:
            continue
        took = r2(applied.get(r.id, 0.0))
        rcur = r.currency or cur
        if took <= _EPS:
            # Nothing taken (no pay this period, or another currency): the
            # installment itself moves on - no empty "repaid" row is left.
            nxt, _sk = next_open_after(db, em, end)
            old, r.date, r.updated_at = r.date, nxt, _now()
            why = ("it is in another currency than the pay" if rcur != cur
                   else "there was no pay to take it from")
            log(adv, actor, "carried", f"{money(r.amount, rcur)} moved to the pay period from {us_date(nxt)}: {why}",
                {"installment": r.id, "from": old, "to": nxt, "amount": r2(r.amount)})
            tell_person(db, adv, "Salary Advance Repayment",
                        f"Nothing was repaid from your pay for {span}; the {money(r.amount, rcur)} comes out of the "
                        f"pay period from {us_date(nxt)}.", actor)
            continue
        r.status, r.deducted_amount, r.final_approval_id, r.updated_at = "deducted", took, final_id, _now()
        log(adv, actor, "deducted", f"{money(took, cur)} from the pay period {span}",
            {"installment": r.id, "amount": took, "periodStart": start, "periodEnd": end})
        short = r2(float(r.amount or 0) - took)
        line = f"{money(took, cur)} was repaid from your pay for {span}."
        if short > _EPS:
            nxt, _sk = next_open_after(db, em, end)
            carry = _new_installment(adv, _max_seq(db, adv.id) + 1, short, nxt, carried_from=r.id)
            carry.currency = rcur
            db.add(carry)
            log(adv, actor, "carried", f"{money(short, rcur)} moved to the pay period from {us_date(nxt)}: that "
                                       f"period's pay was less than the installment",
                {"installment": r.id, "carry": carry.id, "amount": short, "to": nxt})
            line += f" The other {money(short, rcur)} comes out of the pay period from {us_date(nxt)}."
        tell_person(db, adv, "Salary Advance Repayment", line, actor)
    _forget(db)
    return len(rows)


def on_unfinalize(db: Session, final_id: str, actor: str) -> int:
    """HR unlocked the period: its installments are scheduled again (to be
    taken when it is finalized again). A shortfall it carried forward is
    taken back - unless that carry was already repaid in a later finalized
    period, which then keeps it and this installment shrinks to what this
    period took."""
    if not final_id:
        return 0
    rows = (db.query(SalaryAdvanceInstallment)
            .filter(SalaryAdvanceInstallment.final_approval_id == final_id,
                    SalaryAdvanceInstallment.status == "deducted").all())
    for r in rows:
        adv = db.query(SalaryAdvance).filter(SalaryAdvance.id == r.advance_id).with_for_update().first()
        kids = (db.query(SalaryAdvanceInstallment)
                .filter(SalaryAdvanceInstallment.carried_from == r.id, SalaryAdvanceInstallment.status != "canceled").all())
        kept = [k for k in kids if k.status == "deducted"]
        for k in kids:
            if k.status == "scheduled":
                k.status, k.updated_at = "canceled", _now()
        if kept:
            r.amount = r2(r.deducted_amount)
        r.status = "scheduled" if float(r.amount or 0) > _EPS else "canceled"
        r.deducted_amount, r.final_approval_id, r.updated_at = 0.0, "", _now()
        if adv is not None:
            log(adv, actor, "reopened", "The pay period was unlocked - the installment is taken again when it is "
                                        "finalized.", {"installment": r.id})
    _forget(db)
    return len(rows)


def applied_in(db: Session, em: str, start: str, end: str) -> float:
    """What the period's repayments took, as recorded at finalize (contractor
    invoices read it inside the same transaction)."""
    return r2(sum(float(r.deducted_amount or 0) for r in _rows_in(db, norm(em), start, end) if r.status == "deducted"))
