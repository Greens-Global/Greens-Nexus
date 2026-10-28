"""India Contractor Extra Time claims (Neil, Oct 27 2026, docs/India-Contractor-Pay.md).

Work needs no prior approval, but to be PAID as Extra Time an in-scope
contractor (india_contractor_pay.scope) identifies the hours on their Time
Sheet with a note describing the work, and an approver approves them:

  * one claim per day; the hours are prefilled - every hour worked on a
    weekend or a full holiday, only the hours past 9 on a scheduled weekday
    (past 4.5 on a half-day holiday) - and that is the most one day takes;
  * Pending -> Approved (the approver may approve fewer hours than claimed)
    or Declined (a reason is required). The contractor edits or withdraws
    while it is Pending;
  * pay = approved hours x (that day's daily rate / 9) x 1.35, no floor;
    approved hours leave the month-end pool, declined / pending / unclaimed
    hours stay in it (india_contractor_pay.reconcile);
  * the approver is the company's HR contact; when there is none, or the HR
    contact is the claimant, the Global Admins (timesheet_review's fallback).
    HR may also decide - the one HR rule (timesheet_review.is_hr: the HR
    contact, an administrator / owner, a Full HR grant) WITHIN the person's
    company: an administrator or a Full grant only for the companies their
    People scope / company walls cover (auth.hr_scope), the same reach every
    other HR module uses (Oct 27 2026). NOBODY decides their own claim;
  * claims are filed until the month's time sheet goes to Review & Approve,
    and Review & Approve is blocked while any claim of the month is Pending
    (timesheet_review.approve_blocker). Changing a decision after approval
    goes through timesheet_review.guard_edit (HR's override: the employee
    signs the updated card);
  * notices are server-side: ONE grouped notice per approver per month,
    rewritten in place; the contractor gets one per month listing the
    decisions; on the month's last day a reminder goes to each in-scope
    contractor with weekend / holiday hours not claimed (period_close_loop,
    in a thread).

`waiting_on(db, user)` lists the claims waiting on a named approver - the
source of the Approvals inbox's extra_time row (approvals_inbox._extra_time).
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text as _sa_text
from sqlalchemy.orm import Session

import india_contractor_pay as icp
import timesheet_review as tsr
from auth import get_current_user
from database import get_db
from models import ExtraTimeClaim, NexusEmployee, NexusNotification, NexusRole, PayrollRate
from notify_company import notification_company
from notify_rollup import resolve_rollup, upsert_rollup

router = APIRouter(prefix="/extra-time", tags=["extra-time"])

NOTE_MAX = 1000
LIVE = ("pending", "approved", "declined")
_REVIEW_ACTION = {"view": "hr", "sub": "hr-time-extra"}


def _tc():
    from routers import timeclock
    return timeclock


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hm(minutes) -> str:
    m = max(0, int(minutes or 0))
    return f"{m // 60}h {m % 60:02d}m"


def _month_label(start: str) -> str:
    try:
        return date.fromisoformat(start[:10]).strftime("%B %Y")
    except ValueError:
        return start


def _advisory(db: Session, key: str) -> None:
    """A transaction-scoped lock (never a session lock - the 6543 pooler would
    hold that forever), so two claims filed at once never write two grouped
    notices. SQLite is single-writer."""
    try:
        if db.get_bind().dialect.name == "postgresql":
            db.execute(_sa_text("select pg_advisory_xact_lock(hashtext(:k))"), {"k": key})
    except Exception:   # noqa: BLE001 - the lock is a guard, never a failure
        pass


# ── Who decides ───────────────────────────────────────────────────────────────

def _global_admins(db: Session) -> list:
    return sorted({(r.email or "").lower() for r in db.query(NexusRole).filter(NexusRole.role == "owner").all()
                   if r.email})


def approvers(db: Session, email: str) -> list:
    """The named approvers of `email`'s claims: their company's HR contact;
    else - none set, or the HR contact is the claimant - the Global Admins.
    Never the claimant."""
    email = (email or "").strip().lower()
    hr = tsr.hr_of(db, email)
    if hr and hr != email:
        return [hr]
    return [a for a in _global_admins(db) if a != email]


def hr_for(db: Session, actor: str, email: str) -> bool:
    """HR for this person's claims - the ONE scoped HR rule (hr_access.is_hr_for):
    the company's HR contact, or an administrator / owner or a Full HR grant
    whose People scope covers the person's company. The manager tier's
    own-team view is never HR. Never on their own claim."""
    import hr_access
    return hr_access.is_hr_for(db, actor, email)


def can_decide(db: Session, actor: str, email: str) -> bool:
    """HR within the person's company (hr_for) or a named approver - never on
    their own claim."""
    actor, email = (actor or "").strip().lower(), (email or "").strip().lower()
    if not actor or actor == email:
        return False
    return actor in approvers(db, email) or hr_for(db, actor, email)


# ── Is the month still open ──────────────────────────────────────────────────

def filing_state(db: Session, email: str, start: str, end: str) -> dict:
    """{open, reason}: claims are filed until the month's time sheet goes to
    Review & Approve (Neil, Oct 27 2026)."""
    email = (email or "").lower()
    if _tc()._finalized_row(db, email, start, end):
        return {"open": False, "reason": "This month is finalized, so Extra Time can no longer be claimed."}
    r = tsr.active_review(db, email, start)
    if r is not None and r.status in ("approved", "signing", "completed"):
        when = tsr.us_date((r.agreed_at or r.updated_at or "")[:10])
        return {"open": False, "reason": f"Extra Time for {_month_label(start)} closed when the time sheet was "
                                         f"approved{f' on {when}' if when else ''}."}
    if r is not None and r.status == tsr.CORRECTING:
        return {"open": False, "reason": "HR is correcting this time sheet, so Extra Time can no longer be claimed."}
    return {"open": True, "reason": ""}


def _day(db: Session, email: str, ds: str) -> tuple:
    """(card, that day's row) - 400 when the policy does not cover the month."""
    card = _tc()._fixed_card(db, email, ds) if _tc()._pay_type(db, email) == "fixed" else {}
    if not card.get("indiaPolicy"):
        raise HTTPException(400, "Extra Time claims are for India contractors paid by the month under the "
                                 "India Contractor Policy.")
    fd = next((d for d in card.get("fixedDays") or [] if d.get("date") == ds), None)
    if fd is None:
        raise HTTPException(400, "That day is not on this month's time sheet.")
    return card, fd


def _limit_message(fd: dict, ds: str) -> str:
    most = int(fd.get("claimableMin") or 0)
    if fd.get("dayKind") in ("weekend", "holiday"):
        return (f"You worked {_hm(most)} on {tsr.us_date(ds)}, so that is the most you can claim."
                if most else f"There are no hours worked on {tsr.us_date(ds)} to claim.")
    past = "4.5" if fd.get("dayKind") == "half_holiday" else "9"
    return (f"On a scheduled workday only the hours past {past} can be claimed as Extra Time - "
            f"{_hm(most)} on {tsr.us_date(ds)}." if most else
            f"On a scheduled workday only the hours past {past} can be claimed as Extra Time, and "
            f"{tsr.us_date(ds)} has none.")


def _clean_note(note: str, what: str = "Describe the work you did in those hours.") -> str:
    n = (note or "").strip()
    if not n:
        raise HTTPException(422, what)
    return n[:NOTE_MAX]


def _row(db: Session, claim_id: str, lock: bool = True) -> ExtraTimeClaim:
    q = db.query(ExtraTimeClaim).filter(ExtraTimeClaim.id == claim_id)
    c = (q.with_for_update() if lock else q).first()
    if c is None:
        raise HTTPException(404, "Claim not found.")
    return c


def _history(c: ExtraTimeClaim, by: str, action: str, minutes: int = 0, note: str = "") -> None:
    c.history = list(c.history or []) + [{"at": _now(), "by": by, "action": action, "minutes": int(minutes or 0),
                                          "note": (note or "")[:NOTE_MAX]}]
    c.updated_at = c.history[-1]["at"]


def _out(db: Session, c: ExtraTimeClaim, viewer: str = "") -> dict:
    d = icp.claim_dict(c)
    d.update({"employeeEmail": c.employee_email, "name": tsr.display_name(db, c.employee_email),
              "periodStart": c.period_start, "periodEnd": c.period_end,
              "decidedByName": tsr.display_name(db, c.decided_by) if c.decided_by else ""})
    if viewer:
        d["canDecide"] = can_decide(db, viewer, c.employee_email)
        d["mine"] = viewer == c.employee_email
    return d


# ── Notices ───────────────────────────────────────────────────────────────────

def _pending_for(db: Session, approver: str, start: str) -> list:
    rows = (db.query(ExtraTimeClaim)
            .filter(ExtraTimeClaim.status == "pending", ExtraTimeClaim.period_start == start)
            .order_by(ExtraTimeClaim.local_date.asc()).all())
    return [r for r in rows if approver in approvers(db, r.employee_email)]


def refresh_approver_notices(db: Session, start: str, who: list) -> None:
    """ONE notice per approver per month, rewritten in place: the claims
    waiting on them; resolved once none is left. Anyone still holding an open
    notice for the month is refreshed too (an HR contact who changed since
    the claim was filed sees theirs resolved, not left asking)."""
    holders = {(n.recipient or "").lower() for n in db.query(NexusNotification.recipient)
               .filter(NexusNotification.ref_id.like(f"extra-time:%:{start}"),
                       NexusNotification.actioned == False).all()}   # noqa: E712 - SQLAlchemy expression
    for approver in sorted({(a or "").lower() for a in list(who) + list(holders) if a}):
        key = f"extra-time:{approver}:{start}"
        _advisory(db, key)
        rows = _pending_for(db, approver, start)
        month = _month_label(start)
        if rows:
            names = [f"{tsr.display_name(db, r.employee_email)} ({tsr.us_date(r.local_date)}, {_hm(r.claimed_min)})"
                     for r in rows[:12]]
            more = f" and {len(rows) - 12} more" if len(rows) > 12 else ""
            line = (f"{len(rows)} Extra Time claim{'' if len(rows) == 1 else 's'} for {month} waiting on you: "
                    f"{', '.join(names)}{more}. Approve or decline each one - the time sheet cannot be "
                    "approved while a claim is pending.")
            upsert_rollup(db, recipient=approver, key=key, title=f"Extra Time to Review - {month}", line=line,
                          action=_REVIEW_ACTION, company=notification_company(db, approver), replace=True,
                          priority=1, open_only=True)
        else:
            resolve_rollup(db, recipient=approver, key=key, title=f"Extra Time Reviewed - {month}",
                           line=f"Every Extra Time claim for {month} is decided.")


def _tell_contractor(db: Session, c: ExtraTimeClaim) -> None:
    """The contractor's one notice for the month, listing each decision."""
    key = f"extra-time-decided:{c.employee_email}:{c.period_start}"
    _advisory(db, key)
    rows = (db.query(ExtraTimeClaim)
            .filter(ExtraTimeClaim.employee_email == c.employee_email, ExtraTimeClaim.period_start == c.period_start,
                    ExtraTimeClaim.status.in_(("approved", "declined")))
            .order_by(ExtraTimeClaim.local_date.asc()).all())
    if not rows:
        return
    parts = []
    for r in rows:
        if r.status == "approved":
            fewer = f" of {_hm(r.claimed_min)} claimed" if int(r.approved_min or 0) < int(r.claimed_min or 0) else ""
            parts.append(f"{tsr.us_date(r.local_date)}: Approved {_hm(r.approved_min)}{fewer}")
        else:
            parts.append(f"{tsr.us_date(r.local_date)}: Declined - {(r.decision_note or '').strip()[:160]}")
    month = _month_label(c.period_start)
    upsert_rollup(db, recipient=c.employee_email, key=key, title=f"Extra Time Decided - {month}",
                  line="; ".join(parts) + ".",
                  action={"view": "timeclock", "sub": "timecard", "email": c.employee_email, "start": c.period_start},
                  company=notification_company(db, c.employee_email), replace=True)


# ── Waiting on someone ───────────────────────────────────────────────────────

def waiting_on(db: Session, user: str) -> list:
    """Pending claims waiting on `user` as a named approver (their companies'
    HR contact, or a Global Admin where nobody is set), oldest first - never
    their own. The Approvals inbox source (PR #810) at merge time."""
    me = (user or "").strip().lower()
    if not me:
        return []
    rows = (db.query(ExtraTimeClaim).filter(ExtraTimeClaim.status == "pending")
            .order_by(ExtraTimeClaim.created_at.asc()).all())
    return [_out(db, r, me) for r in rows if r.employee_email != me and me in approvers(db, r.employee_email)]


def pending_count(db: Session, email: str, start: str, end: str) -> int:
    return (db.query(ExtraTimeClaim)
            .filter(ExtraTimeClaim.employee_email == (email or "").lower(), ExtraTimeClaim.status == "pending",
                    ExtraTimeClaim.local_date >= start, ExtraTimeClaim.local_date <= end).count())


# ── Routes ────────────────────────────────────────────────────────────────────

class ClaimIn(BaseModel):
    date: str
    minutes: int
    note: str = ""


class ClaimEditIn(BaseModel):
    minutes: int
    note: str = ""


class DecideIn(BaseModel):
    decision: str                # approve | decline
    minutes: int = 0             # approve: the hours approved (may be fewer than claimed)
    reason: str = ""             # decline: required


def _check_minutes(fd: dict, ds: str, minutes: int) -> int:
    m = int(minutes or 0)
    if m <= 0:
        raise HTTPException(422, "Enter the hours to claim.")
    if m > int(fd.get("claimableMin") or 0):
        raise HTTPException(422, _limit_message(fd, ds))
    return m


@router.post("/claims")
def file_claim(body: ClaimIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The contractor files Extra Time for one day of their own Time Sheet."""
    email = (user.get("email") or "").strip().lower()
    try:
        ds = date.fromisoformat((body.date or "")[:10]).isoformat()
    except ValueError:
        raise HTTPException(400, "Pick the day the hours were worked.")
    tc = _tc()
    tc._lock_person(db, email)
    if ds > tc._employee_today(db, email):
        raise HTTPException(400, "Extra Time is claimed once the hours are worked.")
    card, fd = _day(db, email, ds)
    state = filing_state(db, email, card["periodStart"], card["periodEnd"])
    if not state["open"]:
        raise HTTPException(409, state["reason"])
    live = (db.query(ExtraTimeClaim)
            .filter(ExtraTimeClaim.employee_email == email, ExtraTimeClaim.local_date == ds,
                    ExtraTimeClaim.status.in_(LIVE)).first())
    if live is not None:
        raise HTTPException(409, f"{tsr.us_date(ds)} already has an Extra Time claim ({live.status.title()})"
                                 + (" - edit it instead." if live.status == "pending" else "."))
    minutes = _check_minutes(fd, ds, body.minutes)
    note = _clean_note(body.note)
    emp = db.query(NexusEmployee).filter(NexusEmployee.work_email == email).first()
    now = _now()
    c = ExtraTimeClaim(id=str(uuid.uuid4()), employee_email=email, company_id=(emp.company if emp else "") or "",
                       local_date=ds, period_start=card["periodStart"], period_end=card["periodEnd"],
                       claimed_min=minutes, approved_min=0, note=note, status="pending", history=[],
                       created_at=now, updated_at=now)
    _history(c, email, "filed", minutes, note)
    db.add(c)
    db.flush()
    refresh_approver_notices(db, c.period_start, approvers(db, email))
    db.commit()
    return _out(db, c, email)


@router.put("/claims/{claim_id}")
def edit_claim(claim_id: str, body: ClaimEditIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The contractor changes the hours or the note while it is Pending."""
    email = (user.get("email") or "").strip().lower()
    _tc()._lock_person(db, email)
    c = _row(db, claim_id)
    if c.employee_email != email:
        raise HTTPException(403, "Only the person who filed it changes an Extra Time claim.")
    if c.status != "pending":
        raise HTTPException(409, "Only a pending claim can be changed.")
    state = filing_state(db, email, c.period_start, c.period_end)
    if not state["open"]:
        raise HTTPException(409, state["reason"])
    _card, fd = _day(db, email, c.local_date)
    minutes = _check_minutes(fd, c.local_date, body.minutes)
    note = _clean_note(body.note)
    if minutes == c.claimed_min and note == (c.note or ""):
        return _out(db, c, email)
    c.claimed_min, c.note = minutes, note
    _history(c, email, "edited", minutes, note)
    db.flush()
    refresh_approver_notices(db, c.period_start, approvers(db, email))
    db.commit()
    return _out(db, c, email)


@router.post("/claims/{claim_id}/withdraw")
def withdraw_claim(claim_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The contractor takes back a Pending claim; the hours go back to the pool."""
    email = (user.get("email") or "").strip().lower()
    _tc()._lock_person(db, email)
    c = _row(db, claim_id)
    if c.employee_email != email:
        raise HTTPException(403, "Only the person who filed it withdraws an Extra Time claim.")
    if c.status != "pending":
        raise HTTPException(409, "Only a pending claim can be withdrawn.")
    state = filing_state(db, email, c.period_start, c.period_end)
    if not state["open"]:
        raise HTTPException(409, state["reason"])
    c.status = "withdrawn"
    _history(c, email, "withdrawn", c.claimed_min)
    db.flush()
    refresh_approver_notices(db, c.period_start, approvers(db, email))
    db.commit()
    return _out(db, c, email)


@router.post("/claims/{claim_id}/decide")
def decide_claim(claim_id: str, body: DecideIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Approve (all or fewer of the hours) or decline (with a reason). A
    decision may be changed until the month is finalized; once the time
    sheet is approved that goes through guard_edit (HR's override - the
    employee signs the updated card)."""
    actor = (user.get("email") or "").strip().lower()
    c = _row(db, claim_id, lock=False)
    email = c.employee_email
    tc = _tc()
    tc._lock_person(db, email)
    c = _row(db, claim_id)
    if actor == email:
        raise HTTPException(403, "You can't decide your own Extra Time - your approver does.")
    if not can_decide(db, actor, email):
        raise HTTPException(403, "Only HR, the company's HR contact or a Global Admin decides Extra Time.")
    if c.status == "withdrawn":
        raise HTTPException(409, "This claim was withdrawn.")
    if tc._finalized_row(db, email, c.period_start, c.period_end):
        raise HTTPException(409, "This month is finalized. Unlock the time sheet to change an Extra Time decision.")
    decision = (body.decision or "").strip().lower()
    if decision not in ("approve", "decline"):
        raise HTTPException(400, "Approve or decline.")
    if decision == "approve":
        _card, fd = _day(db, email, c.local_date)
        minutes = int(body.minutes or 0) or int(c.claimed_min or 0)
        if minutes <= 0:
            raise HTTPException(422, "Enter the hours to approve.")
        if minutes > int(c.claimed_min or 0):
            raise HTTPException(422, f"No more than the {_hm(c.claimed_min)} claimed can be approved.")
        if minutes > int(fd.get("claimableMin") or 0):
            raise HTTPException(422, _limit_message(fd, c.local_date))
        reason = (body.reason or "").strip()[:NOTE_MAX]
        if c.status == "approved" and int(c.approved_min or 0) == minutes:
            return _out(db, c, actor)
        new_status = "approved"
    else:
        minutes = 0
        reason = _clean_note(body.reason, "Say why it is declined - the contractor sees the reason.")
        if c.status == "declined" and (c.decision_note or "") == reason:
            return _out(db, c, actor)
        new_status = "declined"
    changing = c.status != "pending"
    tsr.guard_edit(db, email, c.local_date, actor,
                   what=f"{'changed an Extra Time decision' if changing else 'decided an Extra Time claim'} "
                        f"({tsr.us_date(c.local_date)})")
    c.status, c.approved_min, c.decision_note = new_status, minutes, reason
    c.decided_by, c.decided_at = actor, _now()
    _history(c, actor, ("re" if changing else "") + ("approved" if new_status == "approved" else "declined"),
             minutes, reason)
    db.flush()
    refresh_approver_notices(db, c.period_start, approvers(db, email))
    _tell_contractor(db, c)
    db.commit()
    return _out(db, c, actor)


@router.get("/queue")
def queue(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """People > Time > Extra Time: the pending claims this person may decide
    (oldest first) and the last 60 days of decisions they may see."""
    me = (user.get("email") or "").strip().lower()
    pending = [_out(db, r, me) for r in db.query(ExtraTimeClaim).filter(ExtraTimeClaim.status == "pending")
               .order_by(ExtraTimeClaim.created_at.asc()).all() if can_decide(db, me, r.employee_email)]
    since = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat()
    decided = [_out(db, r, me) for r in db.query(ExtraTimeClaim)
               .filter(ExtraTimeClaim.status.in_(("approved", "declined")), ExtraTimeClaim.decided_at >= since)
               .order_by(ExtraTimeClaim.decided_at.desc()).limit(300).all() if can_decide(db, me, r.employee_email)]
    return {"pending": pending, "decided": decided[:100]}


@router.get("/mine")
def mine(start: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The caller's own claims for the month containing `start`."""
    email = (user.get("email") or "").strip().lower()
    tc = _tc()
    s, e = tc._month_bounds(start or tc._employee_today(db, email))
    rows = (db.query(ExtraTimeClaim)
            .filter(ExtraTimeClaim.employee_email == email, ExtraTimeClaim.local_date >= s,
                    ExtraTimeClaim.local_date <= e).order_by(ExtraTimeClaim.local_date.asc()).all())
    return {"claims": [_out(db, r, email) for r in rows], "filing": filing_state(db, email, s, e)}


# ── The month-end reminder (period_close_loop, in a thread) ──────────────────

def remind_unclaimed(db: Session, now_utc: datetime | None = None) -> int:
    """On the last day of a month (each contractor's own local date), ONE
    notice to each in-scope contractor who worked weekend or holiday hours
    that month and has not claimed them - claimed or not, the notice is sent
    once per month. Commits nothing; returns how many were written."""
    import timesheet_alerts
    tc = _tc()
    now_utc = now_utc or datetime.now(timezone.utc)
    sent = 0
    for emp in (db.query(NexusEmployee)
                .filter(NexusEmployee.employment_type == "contractor",
                        NexusEmployee.status.in_(("active", "onboarding"))).all()):
        em = (emp.work_email or "").strip().lower()
        if not em:
            continue
        today = timesheet_alerts._today(db, em, now_utc)
        d = date.fromisoformat(today)
        if (d + timedelta(days=1)).month == d.month:
            continue                                   # not the month's last day
        m_start = d.replace(day=1).isoformat()
        rr = db.query(PayrollRate).filter(PayrollRate.employee_email == em).first()
        if icp.scope(db, em, rr, m_start, emp) is None:
            continue
        key = f"extra-time-reminder:{em}:{m_start}"
        if db.query(NexusNotification.id).filter(NexusNotification.recipient == em,
                                                 NexusNotification.ref_id == key).first():
            continue
        card = tc._fixed_card(db, em, today)
        if not filing_state(db, em, card["periodStart"], card["periodEnd"])["open"]:
            continue
        days = [fd for fd in card.get("fixedDays") or []
                if fd.get("dayKind") in ("weekend", "holiday") and fd.get("date", "") <= today
                and int(fd.get("claimableMin") or 0) > 0 and not fd.get("claim")]
        if not days:
            continue
        listed = ", ".join(f"{tsr.us_date(fd['date'])} ({_hm(fd['claimableMin'])})" for fd in days[:10])
        more = f" and {len(days) - 10} more" if len(days) > 10 else ""
        upsert_rollup(db, recipient=em, key=key, title="Claim Your Extra Time",
                      line=(f"You worked on {listed}{more} - a weekend or holiday - and have not claimed it as "
                            "Extra Time. To be paid at 1.35x, claim it with a note from your Time Sheet before it "
                            "goes to Review & Approve. Hours not claimed only count toward the month-end "
                            "reconciliation."),
                      action={"view": "timeclock", "sub": "timecard", "email": em, "start": m_start},
                      company=notification_company(db, em), replace=True)
        sent += 1
    return sent
