"""Timesheet review + Nexus Sign (Sep 2026).

The flow Sagar set out:
    employee submits -> manager changes and sends it back -> employee changes
    and resubmits -> ... until the manager agrees; then it is signed
    employee -> manager -> HR, and HR's signature finalizes it for payroll.
    Signatures may be electronic or on paper (Nexus Sign's paper return).

Two phases, deliberately separate:

REVIEW (here). The timesheet is live and editable, one side at a time: while it
is "with_manager" the employee cannot propose changes, while "with_employee"
the manager cannot edit (guard_edit, called from every timeclock edit route).
Each hand-off is a round with a note and the per-day hours that moved since the
previous hand-off, so nobody has to re-check the whole period.

SIGNING (Nexus Sign). When the manager agrees, the exact version he agreed to
is fingerprinted, rendered to a PDF and sent as an envelope - employee first,
manager second, HR contact last. Nexus Sign already brings consent, a code,
drawn/typed/paper signatures, the certificate and the sealed copy in the
employee's Documents. While the envelope is out, the period is locked. A
decline in Nexus Sign cancels it and hands the timesheet back to whoever
declined (HR's goes to the manager) for another round. HR's signature
completes it: the sign-off rows the timecard shows are written and the period
is finalized (locked, pay snapshot), exactly as the old Finalize button did.

Nexus Sign calls back through on_progress / on_declined / on_voided / on_completed
(routers/esign.py, by HrSignRequest.link_kind == "timesheet"); each is guarded
so a problem here can never break a signature.

OCT 16 2026 (Neil, Charmi, Pranshu, Sagar - call): the chain above is
replaced. ONLY THE EMPLOYEE SIGNS - "who gets hurt if there's a mistake?
The employee" - so:
    the manager (or the HR contact when nobody is set) clicks Agree / Review
    & Approve - no signature, no code; the employee need not have submitted
    first - and the envelope goes straight to the employee, its only signer
    ->  their signature finalizes the period; the PDF carries a timestamped
    log of who approved it ("Approved by Max Test (manager) on 10/16/2026 at
    2:15 PM").
Any change after the manager approved - the employee asking for a punch fix,
the manager editing - reopens it: back with the manager to approve again
(the envelope is voided). HR is the one override: HR may edit at any point
without anyone's approval; a card out for signature is pulled back and waits
as "approved" until the employee signs the edited version (is_hr /
_hr_override / employee_approve). HR's Unlock of a finalized period starts a
new round (status "unlocked").

OCT 17 2026: an employee who never signs (left the company, unreachable)
would hold the period open for good - no finalization, no manager approval
row, so their hours were missing from the finalized-only IIF and Import Hub's
approved-only export. HR may Finalize Without Employee Signature
(finalize_unsigned): any time once the person is no longer active, or once an
approved card has waited UNSIGNED_WAIT_DAYS for an active one. A reason is
required and is logged on the review and on the approval row.
"""
from __future__ import annotations

import hashlib
import io
import json
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy.orm import Session

from models import (HrEntity, HrSignParty, HrSignRequest, NexusEmployee, PunchRequest,
                    TimeApproval, TimePunch, TimesheetReview)

ACTIVE = ("with_manager", "with_employee", "approved", "signing")
LINK_KIND = "timesheet"
# Nexus Sign role keys, in signing order. Only the EMPLOYEE signs (Neil, Oct
# 16): the lead approver - their manager, or the company's HR contact / a
# Global Admin when nobody is set - approves by clicking Agree, and the
# employee's signature finalizes the period. The manager and HR rows are gone
# from the envelope; the approval is printed on the document instead.
ROLES = (("employee", "Employee"),)
# Display order of the parties of any envelope, old three-signer ones included.
_PARTY_ORDER = {"employee": 0, "manager": 1, "hr": 2}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _tc():
    from routers import timeclock
    return timeclock


def us_date(iso: str) -> str:
    try:
        return date.fromisoformat((iso or "")[:10]).strftime("%m/%d/%Y")
    except ValueError:
        return iso or ""


def us_datetime(iso: str, offset_min: int = 0) -> str:
    """'10/16/2026 at 2:15 PM' in the employee's local time (offset_min is
    minutes WEST of UTC, the punch convention); '' when unreadable."""
    try:
        t = datetime.fromisoformat((iso or "").replace("Z", "+00:00")[:19])
    except ValueError:
        return ""
    from datetime import timedelta
    t = t - timedelta(minutes=offset_min or 0)
    return f"{t.strftime('%m/%d/%Y')} at {t.strftime('%I:%M %p').lstrip('0')}"


def _hm(minutes) -> str:
    m = int(round(minutes or 0))
    return f"{m // 60}h {m % 60:02d}m"


# ── Who is involved ──────────────────────────────────────────────────────────

def _employee(db: Session, email: str):
    return db.query(NexusEmployee).filter(NexusEmployee.work_email == (email or "").lower()).first()


def display_name(db: Session, email: str) -> str:
    return _tc()._display_name(db, email)


def manager_of(db: Session, email: str) -> str:
    """The employee's own manager; else their company's first manager."""
    emp = _employee(db, email)
    mgr = ((emp.manager_email if emp else "") or "").strip().lower()
    if mgr and mgr != email:
        return mgr
    ent = db.query(HrEntity).filter(HrEntity.id == (emp.company if emp else "")).first() if emp else None
    for m in ((ent.manager_emails or []) if ent else []):
        if (m or "").lower() not in ("", email):
            return m.lower()
    # Nobody set: the company's HR contact is the lead approver (Neil, Oct 16 -
    # HR and the Global Admins decide when there is no manager, never "any
    # manager").
    hr = ((ent.hr_contact_email if ent else "") or "").strip().lower()
    if not hr or hr == email:
        return ""
    # Only someone who can actually act on it: manager level or an HR editor
    # grant (what Agree / Send Back require) - else "nobody to review".
    from auth import _module_level, _role_for
    if _role_for(hr, db)[1] >= 3 or _module_level(hr, "hr", db) >= 2:
        return hr
    return ""


def hr_of(db: Session, email: str) -> str:
    """The HR contact of the employee's company (People -> Companies)."""
    emp = _employee(db, email)
    ent = db.query(HrEntity).filter(HrEntity.id == (emp.company if emp else "")).first() if emp else None
    return ((ent.hr_contact_email if ent else "") or "").strip().lower()


def is_hr(db: Session, actor: str, employee_email: str) -> bool:
    """HR, the one override on a timesheet (Neil, Oct 16): the company's HR
    contact, an administrator, or a Full HR grant. Never on their own card -
    there they are the employee like anyone else. A manager is not HR."""
    actor, employee_email = (actor or "").strip().lower(), (employee_email or "").strip().lower()
    if not actor or actor == employee_email:
        return False
    if actor == hr_of(db, employee_email):
        return True
    from auth import _LEVELS, _MODULE_LEVEL_RANK, _module_level, level_for
    if level_for(actor, db) >= _LEVELS["administrator"]:
        return True
    return _module_level(actor, "hr", db) >= _MODULE_LEVEL_RANK["full"]


def _offset(db: Session, email: str) -> int:
    """The employee's UTC offset, from their latest punch (0 if none)."""
    last = (db.query(TimePunch).filter(TimePunch.employee_email == email)
            .order_by(TimePunch.at.desc()).first())
    return (last.tz_offset_min or 0) if last else 0


# ── The period and its numbers ───────────────────────────────────────────────

def period_for(db: Session, email: str, anchor: str) -> tuple[str, str, str]:
    """(start, end, pay_type): salaried staff by the calendar month, hourly by
    the bi-weekly pay period - the same bounds the timecard itself uses."""
    tc = _tc()
    if tc._pay_type(db, email) == "fixed":
        s, e = tc._month_bounds(anchor or tc._employee_today(db, email))
        return s, e, "fixed"
    s, e = tc._pay_period(anchor or tc._employee_today(db, email))
    return s, e, "hourly"


def card_for(db: Session, email: str, start: str, end: str, pay_type: str) -> dict:
    tc = _tc()
    if pay_type == "fixed":
        return tc._fixed_card(db, email, start)
    return tc._compute_timecard(db, email, start, end)


def day_minutes(card: dict, pay_type: str) -> dict:
    rows = card.get("fixedDays") if pay_type == "fixed" and card.get("fixedDays") else card.get("days") or []
    out = {}
    for d in rows:
        out[d["date"]] = out.get(d["date"], 0) + int(d.get("workedMin") or 0)
    return out


def fingerprint(db: Session, email: str, start: str, end: str) -> str:
    """Identity of the timesheet's contents: every live punch (time, kind,
    pending edit) and every pending add/remove request in the period. Any
    change to any of them changes this - which is what makes an agreement or a
    signature go stale."""
    punches = (db.query(TimePunch)
               .filter(TimePunch.employee_email == email, TimePunch.voided == 0,
                       TimePunch.local_date >= start, TimePunch.local_date <= end).all())
    reqs = (db.query(PunchRequest)
            .filter(PunchRequest.employee_email == email, PunchRequest.status == "pending",
                    PunchRequest.local_date >= start, PunchRequest.local_date <= end).all())
    body = sorted([p.id, p.kind, p.at, p.pending_at or "", p.edit_status or "", p.category or ""]
                  for p in punches) + sorted(["req", r.id] for r in reqs)
    return hashlib.sha256(json.dumps(body).encode()).hexdigest()


def _changes(before: dict, after: dict) -> list:
    out = []
    for d in sorted(set(before) | set(after)):
        b, a = int(before.get(d, 0)), int(after.get(d, 0))
        if b != a:
            out.append({"date": d, "before": b, "after": a})
    return out


# ── Lookup ────────────────────────────────────────────────────────────────────

def active_review(db: Session, email: str, start: str) -> TimesheetReview | None:
    return (db.query(TimesheetReview)
            .filter(TimesheetReview.employee_email == email, TimesheetReview.period_start == start,
                    TimesheetReview.status.in_(ACTIVE + ("completed",)))
            .order_by(TimesheetReview.created_at.desc()).first())


def review_covering(db: Session, email: str, local_date: str) -> TimesheetReview | None:
    return (db.query(TimesheetReview)
            .filter(TimesheetReview.employee_email == email,
                    TimesheetReview.period_start <= local_date, TimesheetReview.period_end >= local_date,
                    TimesheetReview.status.in_(ACTIVE))
            .first())


def guard_edit(db: Session, email: str, local_date: str, actor_email: str, *,
               employee_request: bool = False, dry_run: bool = False) -> None:
    """Called by every route that changes hours, BEFORE the change. One side at
    a time during review.

    `employee_request`: the EMPLOYEE's own punch fix (an add / remove request
    or a proposed time) - filed by them, or decided by the approver. That is
    the employee's change, not the manager's, so it goes through whichever side
    holds the timesheet (Oct 1: back with the employee, their "add clock-in"
    request could not be approved - neither side could move).

    Oct 16 (Neil): HR may change it at any point (_hr_override). Anyone else
    changing a timesheet the manager already approved - or one out for the
    employee's signature - reopens it: back with the manager to approve again
    (reopen). `dry_run` only answers whether the change may go ahead (the Add
    Time screen's lock check), changing nothing."""
    email = (email or "").lower()
    actor = (actor_email or "").lower()
    r = review_covering(db, email, (local_date or "")[:10])
    if not r:
        return
    is_employee = actor == email
    if not is_employee and is_hr(db, actor, email):
        if not dry_run:
            _hr_override(db, r, actor)
        return
    if r.status in ("approved", "signing"):
        if not dry_run:
            reopen(db, r, actor, "asked for a change" if (is_employee or employee_request) else "changed the hours")
        return
    if employee_request:
        return
    if r.status == "with_manager" and is_employee:
        raise HTTPException(403, "Your timesheet is with your manager for review. They can send it "
                                 "back to you if something needs changing.")
    if r.status == "with_employee" and not is_employee:
        raise HTTPException(403, f"This timesheet is back with {display_name(db, email)} for changes. "
                                 "It returns to you when they resubmit.")


# ── Rounds ────────────────────────────────────────────────────────────────────

def _round(db: Session, r: TimesheetReview, *, by: str, action: str, note: str = "",
           with_changes: bool = False) -> dict:
    entry = {"at": _now(), "by": (by or "").lower(), "action": action, "note": (note or "").strip()[:1000]}
    if with_changes:
        card = card_for(db, r.employee_email, r.period_start, r.period_end, r.pay_type)
        now = day_minutes(card, r.pay_type)
        entry["changes"] = _changes(r.last_snapshot or {}, now) if r.last_snapshot else []
        entry["workedMin"] = int((card.get("totals") or {}).get("workedMin") or sum(now.values()))
        r.last_snapshot = now
    r.rounds = list(r.rounds or []) + [entry]
    r.updated_at = entry["at"]
    return entry


def _notify(db: Session, to: str, title: str, body: str, r: TimesheetReview) -> None:
    """The employee lands on their own timecard. The manager, while the
    timesheet is waiting on THEM (submitted, handed back, signing cancelled),
    lands on Workday > Time Sheet, whose Timesheets to Review list sits at the
    top (Oct 1) - reachable without the HR grant People > Time needs, and the
    list's Agree / Send Back only need manager level. Anyone else (HR, a
    manager told for information) opens THAT employee's card for THAT period
    in People > Time > Payroll (Sep 29)."""
    if not to:
        return
    if to.lower() == r.employee_email:
        action = {"view": "timeclock", "sub": "timecard", "email": r.employee_email, "start": r.period_start}
    elif to.lower() == (r.manager_email or "").lower() and r.status == "with_manager":
        action = {"view": "timeclock", "sub": "timesheet"}
    else:
        action = {"view": "hr", "sub": "hr-time", "timecard": r.employee_email,
                  "start": r.period_start, "payType": r.pay_type}
    # A timesheet waiting on someone is a priority notice: the bar across the
    # top of their screen until they act (Neil, call of 09/29).
    _tc()._hr_notify(db, to, title, body, action=action, priority=1)


def _label(r: TimesheetReview) -> str:
    return f"{us_date(r.period_start)} - {us_date(r.period_end)}"


def _void_envelope(db: Session, r: TimesheetReview, actor: str, note: str) -> None:
    """Pull an envelope that is out for signature back (voided, logged)."""
    if r.sign_request_id:
        from routers.esign import _log
        req = db.query(HrSignRequest).filter(HrSignRequest.id == r.sign_request_id).first()
        if req and req.status == "pending":
            req.status = "voided"
            _log(db, req.id, "voided", f"by {actor}: {note}")
    r.sign_request_id = ""


def reopen(db: Session, r: TimesheetReview, actor: str, what: str) -> None:
    """A change to a timesheet the manager already approved (or that is out
    for the employee's signature) by anyone but HR: it goes back to the
    manager to approve again (Oct 16 - "if the employee is unhappy, they edit
    their time card again and it opens it again")."""
    if r.status not in ("approved", "signing"):
        return
    was_signing = r.status == "signing"
    _void_envelope(db, r, actor, what)
    r.status, r.agreed_fingerprint = "with_manager", ""
    _round(db, r, by=actor, action="reopened", note=what)
    who = display_name(db, actor)
    msg = (f"{who} {what} on {display_name(db, r.employee_email)}'s timesheet for {_label(r)} after it was "
           f"approved{' and sent for signature' if was_signing else ''}, so it is back with the manager to "
           "review and approve again.")
    if actor != (r.manager_email or "").lower():
        _notify(db, r.manager_email, "Timesheet back for review", msg, r)
    if actor != r.employee_email:
        _notify(db, r.employee_email, "Timesheet back for review", msg, r)


def _hr_override(db: Session, r: TimesheetReview, actor: str, note: str = "") -> None:
    """HR changes the hours - no approval needed, at any point (Neil, Oct 16:
    the last-second payroll edits, Jeremy's overtime paid as a bonus). The
    review keeps its place; one already approved stays approved, and one out
    for signature is pulled back so the employee signs the edited version.
    The employee always signs the final card."""
    if r.status not in ("approved", "signing"):
        return       # still in review: HR edits like the manager, nothing moves
    was_signing = r.status == "signing"
    r.agreed_fingerprint = ""        # the approved version now includes HR's edit
    last = (r.rounds or [{}])[-1] if r.rounds else {}
    if not was_signing and last.get("action") == "hr_edited" and last.get("by") == actor:
        return       # one line (and one notice) per HR pass, not one per punch
    if was_signing:
        _void_envelope(db, r, actor, "HR changed the hours")
        r.status = "approved"
    _round(db, r, by=actor, action="hr_edited", note=note)
    _notify(db, r.employee_email, "Timesheet updated by HR",
            f"{display_name(db, actor)} (HR) updated your timesheet for {_label(r)}. Review the hours, "
            "then approve and sign it.", r)


# ── Waiting on a reviewer ────────────────────────────────────────────────────

def submit_blocker(db: Session, email: str, start: str, end: str) -> str:
    """Why the employee may not submit (or resubmit) this period yet, in plain
    words; '' when they may. A missing clock-out, a clock-out with no
    clock-in or a break that never ended is fixed by the employee BEFORE it
    reaches the manager (Oct 1) - the same blocking exceptions agree() checks.
    Judged as if the employee's own pending punch fixes were approved: their
    fixes ARE requests, and the manager approves them during review."""
    tc = _tc()
    # Not before the period's last day (Oct 16): a timesheet submitted on day
    # one sat with the manager for two weeks, during which the employee could
    # no longer file punch fixes and the manager could not agree.
    if tc._employee_today(db, email) < end:
        return (f"This period runs through {us_date(end)}. Submit it on that day, once your "
                "last shift is in, or any day after.")
    exc = tc._blocking_exceptions(db, email, start, end, with_pending=True)
    if not exc:
        return ""
    return (f"Fix {'this' if len(exc) == 1 else 'these'} on your timesheet before you submit it - "
            f"{tc._exception_summary(exc)}.")


def approve_blocker(db: Session, email: str, start: str, end: str) -> str:
    """Why the manager's Review & Approve would be refused right now, in plain
    words; '' when it would go through. The same checks approve() makes, so
    the screen can say so up front instead of after the click (Sep 29)."""
    tc = _tc()
    # "<=": on the last day itself a shift may still be ahead - the gate used
    # to open at midnight of the last day (Oct 16).
    if tc._employee_today(db, email) <= end:
        return (f"This period runs to {us_date(end)}. You can approve it after that day, "
                "once every day is in.")
    exc = tc._blocking_exceptions(db, email, start, end)
    pending = tc._pending_fixes(db, email, start, end)
    if exc:
        if pending:
            # The employee's fixes are on the timecard, waiting on the approver.
            return (f"{display_name(db, email)} has {pending} punch "
                    f"fix{'' if pending == 1 else 'es'} waiting for your approval on the timesheet above - "
                    f"approve {'it' if pending == 1 else 'them'} to clear: {tc._exception_summary(exc)}.")
        return (f"Fix {'this' if len(exc) == 1 else 'these'} on the timesheet before you can approve - "
                f"{tc._exception_summary(exc)}. Or send it back to the employee to fix.")
    if pending:
        # Oct 16: the manager resolves every change before approving, so the
        # employee signs a card with nothing left open on it.
        return (f"{display_name(db, email)} has {pending} change{'' if pending == 1 else 's'} waiting for your "
                f"decision on the timesheet above - approve or reject {'it' if pending == 1 else 'them'} first.")
    return ""


def agree_blocker(db: Session, r: TimesheetReview) -> str:
    return approve_blocker(db, r.employee_email, r.period_start, r.period_end)


def waiting_on(db: Session, reviewer: str) -> list:
    """Timesheets submitted to `reviewer` that they have not decided yet,
    oldest first."""
    import backup_manager
    me = (reviewer or "").lower()
    rows = (db.query(TimesheetReview)
            .filter(TimesheetReview.status == "with_manager",
                    TimesheetReview.manager_email == me).all())
    # ...and those of everyone `reviewer` manages NOW - their direct reports
    # and the people they are Backup Manager for (Neil, Oct 13). A review
    # submitted before the employee's manager changed stays addressed to the
    # old one; without this the new manager never saw it (Oct 17).
    mine = backup_manager.managed_directly(db, me)
    # ...and, for a Global Admin, the people nobody else can review: no
    # manager and no HR contact who can act (Neil, Oct 16 - "HR and the
    # Global Admins decide when there is no manager").
    if _is_global_admin(db, me):
        mine |= {r.employee_email for r in db.query(TimesheetReview)
                 .filter(TimesheetReview.status == "with_manager").all()
                 if not manager_of(db, r.employee_email)}
    if mine:
        seen = {r.id for r in rows}
        rows += [r for r in db.query(TimesheetReview)
                 .filter(TimesheetReview.status == "with_manager",
                         TimesheetReview.employee_email.in_(sorted(mine))).all() if r.id not in seen]
    rows = [r for r in rows if r.employee_email != me]          # never their own
    return sorted(rows, key=lambda r: (r.updated_at or "", r.period_start))


def _is_global_admin(db: Session, email: str) -> bool:
    from models import NexusRole
    return bool(email) and db.query(NexusRole).filter(NexusRole.email == email,
                                                      NexusRole.role == "owner").first() is not None


def no_approver(db: Session) -> set:
    """Active, time-tracked people with nobody to review their timesheet."""
    from routers.timeclock import is_time_tracking_exempt
    out = set()
    for e in db.query(NexusEmployee).filter(NexusEmployee.status.in_(("active", "onboarding"))).all():
        em = (e.work_email or "").lower()
        if em and not manager_of(db, em) and not is_time_tracking_exempt(db, em):
            out.add(em)
    return out


def to_sign(db: Session, signer: str) -> list:
    """Timesheet envelopes waiting on `signer`'s signature right now (their
    turn in Nexus Sign), as rows for the Workday > Time Sheet card (Oct 16).
    Managers reach the People and Documents screens only through an Access
    Group grant, so without one the bell and the email link both landed on
    Access Restricted and the manager could never sign; this card signs in
    place, the same way the employee does on their own timecard."""
    me = (signer or "").lower()
    if not me:
        return []
    out = []
    parties = (db.query(HrSignParty)
               .filter(HrSignParty.email == me, HrSignParty.status.in_(["waiting", "notified", "viewed"])).all())
    for p in parties:
        req = db.query(HrSignRequest).filter(HrSignRequest.id == p.request_id).first()
        if not req or req.status != "pending" or req.current_order != p.ordinal:
            continue
        if (getattr(req, "link_kind", "") or "") != LINK_KIND:
            continue
        r = db.query(TimesheetReview).filter(TimesheetReview.id == req.link_id).first()
        if not r or r.status != "signing":
            continue
        # The employee's own envelope is listed too: their Time Sheet opens on
        # the CURRENT period while the envelope is for the one just closed, so
        # the card signs it in place from any period (Oct 16).
        out.append({"id": r.id, "partyId": p.id, "role": p.role_key, "employeeEmail": r.employee_email,
                    "name": display_name(db, r.employee_email), "periodStart": r.period_start,
                    "periodEnd": r.period_end, "payType": r.pay_type, "agreedAt": r.agreed_at or "",
                    "agreedBy": display_name(db, r.agreed_by) if r.agreed_by else ""})
    # HR changed an agreed timesheet that was out for signature (Oct 17): its
    # envelope was pulled back, so it has no party yet - without this row the
    # employee had only the one bell to find it by. needsResign: the card
    # sends the fresh envelope (POST /{id}/sign) and opens it.
    for r in db.query(TimesheetReview).filter(TimesheetReview.employee_email == me,
                                              TimesheetReview.status == "approved").all():
        out.append({"id": r.id, "partyId": "", "role": "employee", "employeeEmail": r.employee_email,
                    "name": display_name(db, r.employee_email), "periodStart": r.period_start,
                    "periodEnd": r.period_end, "payType": r.pay_type, "agreedAt": r.agreed_at or "",
                    "agreedBy": display_name(db, r.agreed_by) if r.agreed_by else "", "needsResign": True})
    return sorted(out, key=lambda x: (x["agreedAt"], x["periodStart"]))


def queue_row(db: Session, r: TimesheetReview) -> dict:
    """One line of the reviewer's list: who, which period, the hours as last
    submitted, when, their note, and whether Agree would go through now."""
    last = next((e for e in reversed(r.rounds or []) if e.get("action") in ("submitted", "resubmitted")), {})
    return {"id": r.id, "employeeEmail": r.employee_email, "name": display_name(db, r.employee_email),
            "periodStart": r.period_start, "periodEnd": r.period_end, "payType": r.pay_type,
            "workedMin": int(last.get("workedMin") or 0), "submittedAt": last.get("at") or r.updated_at or "",
            "resubmitted": last.get("action") == "resubmitted", "note": last.get("note") or "",
            "agreeBlocker": agree_blocker(db, r), "notSubmitted": False}


def last_closed_period(db: Session, email: str) -> tuple[str, str, str]:
    """The person's most recent pay period that is already over."""
    return closed_periods(db, email, 1)[0]


# How far back the reviewer's list looks for a closed period nobody reviewed
# (Oct 17): a period missed one cycle must not drop off the list when the next
# one closes - but nothing from before the review + Nexus Sign launch, which
# was signed off the old way.
LOOKBACK_PERIODS = 3
REVIEW_LAUNCH = "2026-10-01"


def closed_periods(db: Session, email: str, n: int | None = None) -> list:
    """The person's last `n` pay periods that are over (default
    LOOKBACK_PERIODS, read at call time), newest first."""
    from datetime import timedelta
    s, _e, _pt = period_for(db, email, _tc()._employee_today(db, email))
    out = []
    for _ in range(max(1, LOOKBACK_PERIODS if n is None else n)):
        prev = (date.fromisoformat(s) - timedelta(days=1)).isoformat()
        s, e, pt = period_for(db, email, prev)
        out.append((s, e, pt))
    return out


def not_reviewed(db: Session, reviewer: str) -> list:
    """Oct 16 (Neil): the manager reviews first - the employee need not have
    submitted. So the reviewer's list also has every person they manage (or
    back up) whose last closed period has hours but no review and is not
    finalized: a queue_row-shaped dict with no review id. The last
    LOOKBACK_PERIODS closed periods, so one missed cycle stays on the list;
    a Global Admin also gets the people nobody else can review."""
    import backup_manager
    tc = _tc()
    from routers.timeclock import is_time_tracking_exempt
    me = (reviewer or "").lower()
    people = set(backup_manager.managed_directly(db, me))
    if _is_global_admin(db, me):
        people |= no_approver(db)
    out = []
    for em in sorted(people - {me}):
        emp = _employee(db, em)
        if not emp or (emp.status or "active") not in ("active", "onboarding") or is_time_tracking_exempt(db, em):
            continue
        for start, end, pay_type in closed_periods(db, em):
            if end < REVIEW_LAUNCH:
                break
            if db.query(TimesheetReview).filter(TimesheetReview.employee_email == em,
                                                TimesheetReview.period_start == start,
                                                TimesheetReview.status != "unlocked").first():
                continue
            if tc._finalized_row(db, em, start, end):
                continue
            if not (db.query(TimePunch).filter(TimePunch.employee_email == em, TimePunch.voided == 0,
                                               TimePunch.local_date >= start, TimePunch.local_date <= end).first()):
                continue
            card = card_for(db, em, start, end, pay_type)
            out.append({"id": "", "employeeEmail": em, "name": display_name(db, em), "periodStart": start,
                        "periodEnd": end, "payType": pay_type,
                        "workedMin": int((card.get("totals") or {}).get("workedMin") or 0),
                        "submittedAt": "", "resubmitted": False, "note": "",
                        "agreeBlocker": approve_blocker(db, em, start, end), "notSubmitted": True})
    return sorted(out, key=lambda x: (x["periodStart"], x["name"]))


# ── Review actions ───────────────────────────────────────────────────────────

def submit(db: Session, employee_email: str, anchor: str, note: str = "") -> TimesheetReview:
    """Employee: first submission, or a resubmission after it was sent back."""
    email = employee_email.lower()
    # Exempt from time tracking = no timesheet at all (Visesh, 10/02). The
    # exemption is set on the person's role in Settings > Access.
    from routers.timeclock import is_time_tracking_exempt
    if is_time_tracking_exempt(db, email):
        raise HTTPException(400, "You are exempt from time tracking, so there is no timesheet to submit.")
    start, end, pay_type = period_for(db, email, anchor)
    r = active_review(db, email, start)
    if r and r.status == "with_manager":
        raise HTTPException(409, "Your timesheet is already with your manager.")
    if r and r.status == "signing":
        raise HTTPException(409, "This timesheet is out for your signature. Sign it, or decline it in "
                                 "Nexus Sign with a reason to send it back to your manager.")
    if r and r.status == "completed":
        raise HTTPException(409, "This timesheet is already signed and finalized.")
    mgr = manager_of(db, email)
    if not mgr:
        raise HTTPException(409, "You have no manager set in Nexus People, so there is nobody to review "
                                 "your timesheet. Ask HR to set your manager.")
    if _tc()._finalized_row(db, email, start, end):
        raise HTTPException(409, "This pay period is already finalized.")
    blocker = submit_blocker(db, email, start, end)
    if blocker:
        raise HTTPException(409, blocker)
    first = r is None
    if r is not None and r.status == "approved":
        # Approved, but the employee does not agree: back to the manager with
        # their note instead of signing (Oct 16).
        r.agreed_fingerprint = ""
    if first:
        r = TimesheetReview(id=str(uuid.uuid4()), employee_email=email, period_start=start, period_end=end,
                            pay_type=pay_type, manager_email=mgr, rounds=[], last_snapshot={},
                            created_at=_now())
        db.add(r)
    r.manager_email = mgr
    r.status = "with_manager"
    _round(db, r, by=email, action="submitted" if first else "resubmitted", note=note, with_changes=True)
    who = display_name(db, email)
    _notify(db, mgr, "Timesheet to review",
            f"{who} {'submitted' if first else 'resubmitted'} their timesheet for {_label(r)}."
            + (f' "{note.strip()[:200]}"' if (note or "").strip() else ""), r)
    db.commit()
    return r


def send_back(db: Session, r: TimesheetReview, actor: str, note: str) -> TimesheetReview:
    if r.status != "with_manager":
        raise HTTPException(409, "Only a timesheet that is with the manager can be sent back.")
    if not (note or "").strip():
        raise HTTPException(422, "Say what needs changing so they know what to look at.")
    r.status = "with_employee"
    _round(db, r, by=actor, action="sent_back", note=note, with_changes=True)
    _notify(db, r.employee_email, "Timesheet sent back",
            f"{display_name(db, actor)} sent your timesheet for {_label(r)} back: \"{note.strip()[:200]}\"", r)
    db.commit()
    return r


def approve(db: Session, r: TimesheetReview, actor: str, note: str = "", *, ip: str = "",
            user_agent: str = "") -> TimesheetReview:
    """The manager's Agree / Review & Approve (Oct 16): "I have looked at this,
    this time is accurate". No signature and no code - a timestamped click,
    logged on the PDF - and it sends the envelope straight to the employee,
    the only signer (Neil's flow); their signature finalizes the period."""
    tc = _tc()
    if r.status != "with_manager":
        raise HTTPException(409, "Only a timesheet waiting on the manager's review can be approved.")
    today = tc._employee_today(db, r.employee_email)
    if today <= r.period_end:
        raise HTTPException(409, f"This period runs to {us_date(r.period_end)}. Approve it after the "
                                 "last day, so every day is in before it is signed.")
    exc = tc._blocking_exceptions(db, r.employee_email, r.period_start, r.period_end)
    if exc:
        if tc._pending_fixes(db, r.employee_email, r.period_start, r.period_end):
            # The employee's fixes are waiting on THIS approver - say so, in the
            # words the panel shows (agree_blocker), not "send it back".
            raise HTTPException(409, {"code": "unresolved_exceptions", "message": agree_blocker(db, r),
                                      "exceptions": exc})
        tc._exceptions_409(exc, can_override=False)   # a review has no override - send it back instead
    blocker = agree_blocker(db, r)
    if blocker:
        raise HTTPException(409, blocker)       # changes still waiting on a decision
    r.agreed_fingerprint = fingerprint(db, r.employee_email, r.period_start, r.period_end)
    # The HR contact no longer signs (Oct 16) - kept on the review for the
    # record and for the finalize notice; a company without one still closes.
    r.agreed_at, r.agreed_by, r.hr_email = _now(), actor.lower(), hr_of(db, r.employee_email)
    _round(db, r, by=actor, action="agreed", note=note, with_changes=True)
    r.sign_request_id = _send_envelope(db, r, actor, ip=ip, user_agent=user_agent)
    r.status = "signing"
    db.commit()
    return r


agree = approve     # the name the /agree route and older callers use


def approve_period(db: Session, employee_email: str, anchor: str, actor: str, note: str = "") -> TimesheetReview:
    """Review & Approve straight from the timecard, whether or not the
    employee submitted it (Oct 16: the manager reviews first)."""
    email = (employee_email or "").strip().lower()
    from routers.timeclock import is_time_tracking_exempt
    if is_time_tracking_exempt(db, email):
        raise HTTPException(400, "This person is exempt from time tracking, so there is no timesheet to approve.")
    start, end, pay_type = period_for(db, email, anchor)
    r = active_review(db, email, start)
    if r is None:
        if _tc()._finalized_row(db, email, start, end):
            raise HTTPException(409, "This pay period is already finalized.")
        r = TimesheetReview(id=str(uuid.uuid4()), employee_email=email, period_start=start, period_end=end,
                            pay_type=pay_type, manager_email=manager_of(db, email) or actor.lower(),
                            rounds=[], last_snapshot={}, status="with_manager", created_at=_now())
        db.add(r)
    elif r.status == "approved":
        raise HTTPException(409, "This timesheet is approved and waiting for the employee to sign HR's changes.")
    elif r.status == "with_employee":
        raise HTTPException(409, "This timesheet is back with the employee for changes.")
    elif r.status in ("signing", "completed"):
        raise HTTPException(409, "This timesheet is already approved and with the employee to sign.")
    return approve(db, r, actor, note)


def employee_approve(db: Session, r: TimesheetReview, actor: str, *, ip: str = "",
                     user_agent: str = "") -> TimesheetReview:
    """The employee signs again after HR changed an approved timesheet that
    was out for their signature (_hr_override pulled that envelope back): a
    fresh envelope of the edited card, the employee its only signer. The
    manager's own approval sends the first envelope (approve)."""
    actor = (actor or "").lower()
    if actor != r.employee_email:
        raise HTTPException(403, "Only the employee signs their own timesheet.")
    if r.status == "signing":
        return r                               # already out - the panel opens it
    if r.status != "approved":
        raise HTTPException(409, "There is nothing for you to sign yet - your manager's approval sends "
                                 "the timesheet to you to sign.")
    r.agreed_fingerprint = fingerprint(db, r.employee_email, r.period_start, r.period_end)
    _round(db, r, by=actor, action="employee_approved")
    r.sign_request_id = _send_envelope(db, r, actor, ip=ip, user_agent=user_agent)
    r.status = "signing"
    db.commit()
    return r


# ── HR finalizes without the employee's signature (Oct 17) ───────────────────

# How long an approved card waits on an ACTIVE employee's signature before HR
# may finalize it without them. Someone who left may be finalized at once.
UNSIGNED_WAIT_DAYS = 3


def _has_left(db: Session, email: str) -> bool:
    emp = _employee(db, email)
    return bool(emp) and (emp.status or "active") not in ("active", "onboarding")


def _waiting_since(r: TimesheetReview) -> str:
    """When the card last went to the employee to sign: the newest approval,
    HR change or re-sign round."""
    for e in reversed(list(r.rounds or [])):
        if e.get("action") in ("agreed", "approved", "hr_edited", "employee_approved"):
            return e.get("at") or ""
    return r.agreed_at or r.updated_at or ""


def finalize_unsigned_blocker(db: Session, email: str, start: str, actor: str) -> str:
    """Why HR's Finalize Without Employee Signature would be refused now, in
    plain words; '' when it would go through."""
    email, actor = (email or "").lower(), (actor or "").lower()
    if not is_hr(db, actor, email):
        return "Only HR can finalize a timesheet without the employee's signature."
    s, e, _pt = period_for(db, email, start)
    if _tc()._finalized_row(db, email, s, e):
        return "This pay period is already finalized."
    r = active_review(db, email, s)
    if not _has_left(db, email):
        if not r or r.status not in ("approved", "signing"):
            return ("The manager approves the timesheet first. HR can finalize it without the employee's "
                    "signature only once it has waited for their signature, or once they have left.")
        since = _waiting_since(r)
        try:
            due = datetime.fromisoformat(since.replace("Z", "+00:00")) + timedelta(days=UNSIGNED_WAIT_DAYS)
        except ValueError:
            due = None
        if due is not None:
            if due.tzinfo is None:
                due = due.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) < due:
                return (f"{display_name(db, email)} has until {us_date(due.date().isoformat())} to sign "
                        f"({UNSIGNED_WAIT_DAYS} days after it went to them). After that, or once they "
                        "leave, HR can finalize it without their signature.")
    # The hours themselves must be clean - HR can fix the punches first.
    return approve_blocker(db, email, s, e)


def finalize_unsigned(db: Session, email: str, start: str, actor: str, reason: str) -> TimesheetReview:
    """HR: finalize the period with no employee signature. The envelope (if
    any) is voided, the approval row payroll reads is written - the manager's
    approval when there was one, else HR's - and the period is finalized, with
    the reason on the review's history and on that row."""
    email, actor, reason = (email or "").lower(), (actor or "").lower(), (reason or "").strip()
    if len(reason) < 5:
        raise HTTPException(422, "Say why it is being finalized without the employee's signature.")
    blocker = finalize_unsigned_blocker(db, email, start, actor)
    if blocker:
        raise HTTPException(403 if blocker.startswith("Only HR") else 409, blocker)
    s, e, pay_type = period_for(db, email, start)
    r = active_review(db, email, s)
    if r is None:
        r = TimesheetReview(id=str(uuid.uuid4()), employee_email=email, period_start=s, period_end=e,
                            pay_type=pay_type, manager_email=manager_of(db, email) or actor,
                            rounds=[], last_snapshot={}, status="with_manager", created_at=_now())
        db.add(r)
    _void_envelope(db, r, actor, "Finalized by HR without the employee's signature")
    tc = _tc()
    worked = int((card_for(db, email, s, e, r.pay_type).get("totals") or {}).get("workedMin") or 0)
    for old in (db.query(TimeApproval)
                .filter(TimeApproval.employee_email == email, TimeApproval.revoked == 0,
                        TimeApproval.period_start == s, TimeApproval.period_end == e,
                        TimeApproval.kind.in_(("employee_sign", "manager"))).all()):
        old.revoked = 1
    approved = r.status in ("approved", "signing") and r.agreed_by
    approver = (r.agreed_by if approved else actor).lower()
    db.add(TimeApproval(id=str(uuid.uuid4()), employee_email=email, period_start=s, period_end=e,
                        worked_min=worked, approved_by=approver,
                        approved_at=(r.agreed_at if approved else "") or _now(), kind="manager",
                        note=f"Finalized by {display_name(db, actor)} (HR) without the employee's signature: "
                             f"{reason[:400]}"))
    r.status = "completed"
    _round(db, r, by=actor, action="finalized_unsigned", note=reason)
    if r.manager_email and r.manager_email not in (actor, email):
        _notify(db, r.manager_email, "Timesheet finalized by HR",
                f"{display_name(db, actor)} (HR) finalized {display_name(db, email)}'s timesheet for "
                f"{_label(r)} without their signature: \"{reason[:200]}\"", r)
    db.flush()
    tc.finalize_timecard(tc.FinalizeIn(email=email, start=s, end=e, allow_exceptions=True),
                         user={"email": actor, "level": 4}, db=db)
    return r


# ── The document and the envelope ────────────────────────────────────────────

# Signature block geometry on the LAST page, normalized from the top-left (the
# convention Nexus Sign stamps with). Three rows: employee, manager, HR.
_SIG_TOP, _SIG_ROW = 0.66, 0.095
# What the employee attests to by signing, printed just above their signature
# line (Charmi, Oct 1 - the wording from the paper time sheet).
EMPLOYEE_ATTESTATION = ("By execution and signature of this time sheet, I agree I have reviewed this "
                        "time card, and agree the hours stated are accurate and correct.")


def _sig_fields(last_page: int) -> list:
    fields = []
    for i, (role, _label_) in enumerate(ROLES):
        y = _SIG_TOP + i * _SIG_ROW
        fields.append({"id": f"{role}_sign", "role": role, "type": "sign", "page": last_page,
                       "x": 0.20, "y": y, "w": 0.42, "h": 0.05, "required": True})
        fields.append({"id": f"{role}_date", "role": role, "type": "date", "page": last_page,
                       "x": 0.70, "y": y + 0.012, "w": 0.18, "h": 0.03, "required": True})
    return fields


def build_pdf(db: Session, r: TimesheetReview) -> tuple[bytes, int]:
    """The agreed timesheet as a PDF: every day, the totals, the review history
    and a signature block on the last page. Returns (bytes, last page index)."""
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas

    card = card_for(db, r.employee_email, r.period_start, r.period_end, r.pay_type)
    emp = _employee(db, r.employee_email)
    ent = db.query(HrEntity).filter(HrEntity.id == (emp.company if emp else "")).first() if emp else None
    # Every punch prints in the zone it was recorded in (its own tz_offset_min),
    # not the zone of the person's latest punch: a period agreed after the US
    # DST change would otherwise show every clock time an hour off (Oct 16).
    # Through the day AFTER the period: an overnight shift that starts on the
    # last day clocks out with local_date = end + 1 and still prints here.
    _end_nx = (date.fromisoformat(r.period_end) + timedelta(days=1)).isoformat()
    _rows = (db.query(TimePunch).filter(TimePunch.employee_email == r.employee_email,
                                        TimePunch.local_date >= r.period_start,
                                        TimePunch.local_date <= _end_nx).all())
    offsets = {p.id: (p.tz_offset_min or 0) for p in _rows}
    last = (db.query(TimePunch).filter(TimePunch.employee_email == r.employee_email)
            .order_by(TimePunch.at.desc()).first())
    default_offset = (last.tz_offset_min or 0) if last else 0
    offset = default_offset      # the approval log's times

    def local_time(iso: str, punch_id: str = "") -> str:
        if not iso:
            return "-"
        try:
            t = datetime.fromisoformat(iso.replace("Z", "+00:00")[:19])
        except ValueError:
            return "-"
        from datetime import timedelta
        t = t - timedelta(minutes=offsets.get(punch_id, default_offset))
        return t.strftime("%I:%M %p").lstrip("0")

    buf = io.BytesIO()
    W, H = letter
    c = canvas.Canvas(buf, pagesize=letter)
    margin = 48
    y = H - margin

    def text(x, s, size=9, bold=False, color=(0.1, 0.1, 0.12)):
        c.setFillColorRGB(*color)
        c.setFont("Helvetica-Bold" if bold else "Helvetica", size)
        c.drawString(x, y, s)

    def new_page():
        nonlocal y
        c.showPage()
        y = H - margin

    text(margin, "TIMESHEET", 16, True)
    y -= 18
    text(margin, f"{display_name(db, r.employee_email)}  ({r.employee_email})", 10.5, True)
    y -= 14
    text(margin, f"{(ent.name if ent else '') or ''}   Pay period {_label(r)}   "
                 f"{'Salaried (monthly)' if r.pay_type == 'fixed' else 'Hourly (bi-weekly)'}", 9)
    y -= 14
    text(margin, f"Approved by {display_name(db, r.agreed_by)} on "
                 f"{us_datetime(r.agreed_at, offset) or us_date(r.agreed_at)}. "
                 f"Version {(r.agreed_fingerprint or '')[:12]}", 8, color=(0.4, 0.4, 0.45))
    y -= 22

    # Days
    cols = (margin, margin + 90, margin + 330, margin + 400)
    text(cols[0], "Date", 9, True)
    text(cols[1], "Clock in - out", 9, True)
    text(cols[2], "Break", 9, True)
    text(cols[3], "Hours" if r.pay_type == "hourly" else "Worked / Status", 9, True)
    y -= 4
    c.line(margin, y, W - margin, y)
    y -= 12
    rows = card.get("days") or []
    by_date = {d["date"]: d for d in rows}
    fixed = {d["date"]: d for d in (card.get("fixedDays") or [])}
    for ds in sorted(set(by_date) | set(fixed)):
        if y < margin + 40:
            new_page()
        d = by_date.get(ds) or {}
        segs = d.get("segments") or []
        spans = ", ".join(f"{local_time(s.get('in'), s.get('inId') or '')} - "
                          f"{local_time(s.get('out'), s.get('outId') or '')}" for s in segs) or "-"
        if d.get("isHoliday"):
            spans = f"Holiday: {d.get('holidayName') or ''}".strip()
        text(cols[0], date.fromisoformat(ds).strftime("%a %m/%d/%Y"), 8.5)
        text(cols[1], spans[:52], 8.5)
        text(cols[2], _hm(d.get("breakMin")) if d.get("breakMin") else "-", 8.5)
        if r.pay_type == "fixed":
            f = fixed.get(ds) or {}
            text(cols[3], f"{_hm(f.get('workedMin', d.get('workedMin')))}  {f.get('status') or ''}"[:40], 8.5)
        else:
            text(cols[3], _hm(d.get("workedMin")), 8.5)
        y -= 12

    # Totals
    t = card.get("totals") or {}
    y -= 8
    if y < margin + 120:
        new_page()
    c.line(margin, y, W - margin, y)
    y -= 14
    text(margin, "Totals", 10, True)
    y -= 13
    if r.pay_type == "fixed":
        lines = [("Worked", _hm(t.get("workedMin"))),
                 ("Missed full days", str(t.get("missedFullDays", 0))),
                 ("Missed half days", str(t.get("missedHalfDays", 0))),
                 ("Weekend days worked", str(t.get("weekendDaysWorked", 0)))]
    else:
        lines = [("Regular", _hm(t.get("regMin"))), ("Overtime", _hm(t.get("otMin"))),
                 ("Double time", _hm(t.get("dtMin"))), ("Sick", _hm(t.get("sickMin"))),
                 ("Vacation", _hm(t.get("vacationMin"))), ("Total worked", _hm(t.get("workedMin")))]
    for k, v in lines:
        text(margin, k, 9)
        text(margin + 160, v, 9, True)
        y -= 12

    # Review history
    y -= 8
    if y < margin + 90:
        new_page()
    text(margin, "Review history", 10, True)
    y -= 13
    labels = {"submitted": "submitted", "resubmitted": "resubmitted", "sent_back": "sent back",
              "agreed": "agreed", "declined": "declined", "returned": "returned", "cancelled": "cancelled",
              "approved": "reviewed and approved", "reopened": "reopened it", "hr_edited": "edited it (HR)",
              "employee_approved": "approved it to sign", "unlocked": "unlocked it", "recalled": "recalled it"}
    for e in (r.rounds or []):
        if y < margin + 30:
            new_page()
        who = display_name(db, e.get("by", ""))
        line = f"{us_date(e.get('at'))}  {who} {labels.get(e.get('action'), e.get('action'))}"
        if e.get("note"):
            line += f': "{e["note"]}"'
        # Wrap whole words to the page width - a note cut mid-word loses its point.
        import textwrap
        for part in textwrap.wrap(line, width=115, subsequent_indent="      ") or [""]:
            if y < margin + 20:
                new_page()
            text(margin, part, 8)
            y -= 11

    # Signature block (always on its own final page, at fixed positions).
    new_page()
    y = H - margin
    text(margin, "Signatures", 12, True)
    y -= 16
    text(margin, "By signing, the employee attests that the hours on this timesheet are accurate "
                 "for the pay period shown.", 9)
    y -= 14
    text(margin, "The approver does not sign - the approval, and any change HR made, are logged below.", 9)
    # The employee's attestation, boxed just above their signature line. Drawn
    # in the free space above the first row, so no signature / date field moves
    # (_sig_fields places them at the same fixed positions).
    from reportlab.lib.utils import simpleSplit
    att_lines = simpleSplit(EMPLOYEE_ATTESTATION, "Helvetica-Bold", 9, W - 2 * margin - 16)
    box_bottom = H - _SIG_TOP * H + 10
    box_h = 12 * len(att_lines) + 10
    c.setStrokeColorRGB(0.6, 0.6, 0.65)
    c.rect(margin, box_bottom, W - 2 * margin, box_h, stroke=1, fill=0)
    c.setFillColorRGB(0.1, 0.1, 0.12)
    c.setFont("Helvetica-Bold", 9)
    for k, ln in enumerate(att_lines):
        c.drawString(margin + 8, box_bottom + box_h - 14 - 12 * k, ln)
    for i, (role, label) in enumerate(ROLES):
        top = (_SIG_TOP + i * _SIG_ROW) * H
        base = H - top - 0.05 * H
        c.setFillColorRGB(0.1, 0.1, 0.12)
        c.setFont("Helvetica-Bold", 9)
        c.drawString(margin, base + 12, label)
        c.setStrokeColorRGB(0.6, 0.6, 0.65)
        c.line(0.20 * W, base, 0.62 * W, base)
        c.line(0.70 * W, base, 0.88 * W, base)
        c.setFont("Helvetica", 7)
        c.drawString(0.20 * W, base - 9, "Signature")
        c.drawString(0.70 * W, base - 9, "Date")
    # Approval log (Oct 16, Neil): "manager Sahil approved Jackson's time card
    # on this time at this date" - who approved, who changed it as HR, when.
    # Below the employee's row, clear of every signature field.
    log = approval_log(db, r, offset)
    ly = H - (_SIG_TOP + 1.3 * _SIG_ROW) * H
    c.setFillColorRGB(0.1, 0.1, 0.12)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(margin, ly, "Approval log")
    c.setFont("Helvetica", 8.5)
    for line in (log or ["No approvals recorded."]):
        ly -= 13
        if ly < margin:
            break
        c.drawString(margin, ly, line[:130])
    page_count = c.getPageNumber()
    c.save()
    return buf.getvalue(), page_count - 1


def approval_log(db: Session, r: TimesheetReview, offset: int = 0) -> list:
    """The timestamped lines the signed PDF carries: the manager's approval,
    HR's changes, the employee's own approval - newest approval round only
    (an earlier approval that was reopened no longer stands)."""
    rounds = list(r.rounds or [])
    start = max([i for i, e in enumerate(rounds) if e.get("action") in ("approved", "agreed")] or [0])
    words = {"approved": "Approved by {who} (manager) on {when}",
             "agreed": "Approved by {who} (manager) on {when}",
             "hr_edited": "Hours changed by {who} (HR) on {when}",
             "employee_approved": "Approved for signature by {who} (employee) on {when}",
             "finalized_unsigned": "Finalized without the employee's signature by {who} (HR) on {when}"}
    out = []
    for e in rounds[start:]:
        w = words.get(e.get("action"))
        if w:
            line = w.format(who=display_name(db, e.get("by", "")), when=us_datetime(e.get("at", ""), offset))
            if e.get("note"):
                line += f' - "{e["note"][:80]}"'
            out.append(line)
    return out


def _send_envelope(db: Session, r: TimesheetReview, actor: str, *, ip: str, user_agent: str) -> str:
    from routers import esign
    pdf, last_page = build_pdf(db, r)
    emp = _employee(db, r.employee_email)
    safe = esign._safe_filename(f"Timesheet {display_name(db, r.employee_email)} {r.period_start}")
    path = f"esign/{uuid.uuid4()}/{safe}.pdf"
    up = esign._storage_put(esign._DOC_BUCKET, path, pdf, "application/pdf")
    if not up.is_success:
        raise HTTPException(502, "The timesheet could not be stored for signing. Try again.")
    who = {"employee": r.employee_email}
    parties = [esign.PartyIn(role_key=role, name=display_name(db, who[role]), email=who[role],
                             kind="internal", ordinal=i + 1, party_role="signer")
               for i, (role, _l) in enumerate(ROLES)]
    # Sent in the approving manager's name; the employee is the only signer.
    out = esign._create_request(
        db, {"email": (r.agreed_by or r.manager_email or actor).lower()}, title=f"Timesheet - {display_name(db, r.employee_email)} - {_label(r)}",
        source="pdf", template_id="", employee_id=(emp.id if emp else ""), candidate_id="",
        entity_id=(emp.company if emp else ""), body_snapshot=[], pdf_storage_path=path,
        fields=esign._clean_fields(_sig_fields(last_page)),
        message=f"Please review and sign the timesheet for {_label(r)}.", expires_on="",
        parties=parties, ip=ip, user_agent=user_agent, routing="sequential",
        excluded_ack=True, document_class="employment")
    req = db.query(HrSignRequest).filter(HrSignRequest.id == out["id"]).first()
    req.link_kind, req.link_id = LINK_KIND, r.id
    return req.id


def egnyte_folder(db: Session, req) -> str:
    """Where the signed timesheet is filed in Egnyte (esign._signed_folder):
    the employee's person folder - created if missing, as a hire's is - plus
    the timesheet.signed-subfolder wiring ('Timesheets'). Neil, Oct 16: the
    PDF goes in the employee's file. '' when there is no folder to file into
    (Egnyte off, no company or name in People): the sealed copy still lands
    in their Nexus Documents, and it is never filed under someone else."""
    try:
        import egnyte_wiring
        from services import egnyte as svc
        if not svc.configured():
            return ""
        emp = (db.query(NexusEmployee).filter(NexusEmployee.id == req.employee_id).first()
               if getattr(req, "employee_id", "") else None)
        if emp is None:
            r = _for(db, req)
            emp = _employee(db, r.employee_email) if r else None
        if emp is None:
            return ""
        base = egnyte_wiring.provision_person_folder(emp, db)
        sub, _src = egnyte_wiring.effective("timesheet.signed-subfolder")
        sub = (sub or "").strip().strip("/")
        return f"{base.rstrip('/')}/{sub}" if sub else base
    except Exception as e:      # filing must never block sealing
        print(f"[timesheet-review] no Egnyte folder for {getattr(req, 'id', '')}: {type(e).__name__}: {e}")
        return ""


# ── Nexus Sign callbacks ─────────────────────────────────────────────────────

def _for(db: Session, req) -> TimesheetReview | None:
    if (getattr(req, "link_kind", "") or "") != LINK_KIND:
        return None
    return db.query(TimesheetReview).filter(TimesheetReview.id == req.link_id).first()


def on_progress(db: Session, req) -> None:
    """A party finished (e-signature, paper return, or any other way Nexus Sign
    advances): record each new signature once in the review history."""
    r = _for(db, req)
    if not r or r.status != "signing":
        return
    done = {e.get("action") for e in (r.rounds or [])}
    for p in db.query(HrSignParty).filter(HrSignParty.request_id == req.id).all():
        if p.status == "signed" and f"signed_{p.role_key}" not in done:
            _round(db, r, by=p.email, action=f"signed_{p.role_key}",
                   note="Signed on paper" if (p.signature_kind or "") == "paper" else "")


def on_declined(db: Session, req, party, reason: str) -> None:
    """A decline sends it back to the manager with the reason (Oct 16: the
    employee who is unhappy edits their card again and it reopens; HR's
    return on an older three-signer envelope also goes to the manager)."""
    r = _for(db, req)
    if not r or r.status != "signing":
        return
    r.status = "with_manager"
    r.sign_request_id, r.agreed_fingerprint = "", ""
    _round(db, r, by=party.email, action="returned" if party.role_key == "hr" else "declined",
           note=reason, with_changes=True)
    msg = (f"{display_name(db, party.email)} did not sign the timesheet for {_label(r)}"
           + (f': "{reason.strip()[:200]}"' if (reason or "").strip() else "") + ".")
    _notify(db, r.manager_email, "Timesheet returned for changes", msg + " It is back with you to review.", r)
    if (party.email or "").lower() != r.employee_email:
        _notify(db, r.employee_email, "Timesheet returned for changes", msg, r)


def recall_for_change(db: Session, r: TimesheetReview, actor: str, note: str) -> None:
    """An approver is applying a change the employee asked for (a punch fix)
    while the agreed version is out for signature. Nobody should have to go
    into Nexus Sign and decline a timesheet to approve a lunch (Neil, 10/08:
    the approver only saw "out for signature... decline it there"). The
    envelope is voided and the review comes back to the manager for another
    round, with the reason in the history, so the fix applies and a fresh
    agreed version goes out to be signed."""
    if r.status != "signing":
        return
    if is_hr(db, actor, r.employee_email):
        _hr_override(db, r, actor.lower(), note)     # HR: the employee signs the new version
        return
    _void_envelope(db, r, actor, note)
    r.status, r.sign_request_id, r.agreed_fingerprint = "with_manager", "", ""
    _round(db, r, by=actor, action="recalled", note=note)
    msg = (f"{display_name(db, actor)} approved a change to {display_name(db, r.employee_email)}'s "
           f"timesheet for {_label(r)} while it was out for signature ({note}). Signing was cancelled "
           "and the timesheet is back with the manager to agree again.")
    _notify(db, r.manager_email, "Timesheet signing recalled", msg, r)
    if r.employee_email != r.manager_email:
        _notify(db, r.employee_email, "Timesheet signing recalled", msg, r)


def on_voided(db: Session, req, actor: str) -> None:
    r = _for(db, req)
    if not r or r.status != "signing":
        return
    r.status, r.sign_request_id, r.agreed_fingerprint = "with_manager", "", ""
    _round(db, r, by=actor, action="cancelled", note="Signing was cancelled in Nexus Sign.")
    _notify(db, r.manager_email, "Timesheet signing cancelled",
            f"Signing of {display_name(db, r.employee_email)}'s timesheet for {_label(r)} was cancelled. "
            "It is back with you.", r)


def on_completed(db: Session, req) -> None:
    """Everyone signed: write the sign-offs the timecard shows and finalize the
    period for payroll with HR as the finalizer."""
    r = _for(db, req)
    if not r or r.status != "signing":
        return
    tc = _tc()
    parties = {p.role_key: p for p in db.query(HrSignParty).filter(HrSignParty.request_id == req.id).all()}
    worked = int((card_for(db, r.employee_email, r.period_start, r.period_end, r.pay_type)
                  .get("totals") or {}).get("workedMin") or 0)
    base = dict(employee_email=r.employee_email, period_start=r.period_start, period_end=r.period_end,
                worked_min=worked)
    for kind in ("employee_sign", "manager"):
        for old in (db.query(TimeApproval)
                    .filter(TimeApproval.employee_email == r.employee_email, TimeApproval.revoked == 0,
                            TimeApproval.period_start == r.period_start, TimeApproval.period_end == r.period_end,
                            TimeApproval.kind == kind).all()):
            old.revoked = 1
    e = parties.get("employee")
    if e:
        db.add(TimeApproval(id=str(uuid.uuid4()), approved_by=e.email, approved_at=e.signed_at or _now(),
                            kind="employee_sign", note=e.name or display_name(db, e.email), **base))
    # The approver's "Agree" is the manager approval (Oct 16: approvers do not
    # sign); the row the timecard badges, exports and briefings read.
    approver = (r.agreed_by or r.manager_email or "").lower()
    if approver:
        db.add(TimeApproval(id=str(uuid.uuid4()), approved_by=approver, approved_at=r.agreed_at or _now(),
                            kind="manager", note=f"Agreed in review; Nexus Sign {req.id}", **base))
    r.status = "completed"
    _round(db, r, by=approver or r.hr_email, action="completed")
    db.flush()
    if not tc._finalized_row(db, r.employee_email, r.period_start, r.period_end):
        tc.finalize_timecard(tc.FinalizeIn(email=r.employee_email, start=r.period_start, end=r.period_end,
                                           allow_exceptions=True),
                             user={"email": approver or r.hr_email, "level": 4}, db=db)


def safe(fn, *a, **kw) -> None:
    """Run a callback without ever letting it break a Nexus Sign action."""
    try:
        fn(*a, **kw)
    except Exception as e:   # pragma: no cover - logged, never raised
        print(f"[timesheet-review] {getattr(fn, '__name__', fn)} failed: {type(e).__name__}: {e}")


# ── What the timecard shows ──────────────────────────────────────────────────

def state_for(db: Session, email: str, start: str, viewer: str, viewer_team: bool) -> dict | None:
    """The review panel's data for one employee-period, with what THIS viewer
    may do right now. viewer_team = the viewer manages this person (or HR)."""
    email, viewer = (email or "").lower(), (viewer or "").lower()
    r = active_review(db, email, start)
    is_self = viewer == email
    manager_side = viewer_team and not is_self
    hr_view = manager_side and is_hr(db, viewer, email)
    if not r:
        s, e, _pt = period_for(db, email, start)
        out = {"status": "not_submitted", "canSubmit": is_self, "rounds": [], "parties": [], "submitBlocker": "",
               "periodStart": s, "periodEnd": e, "employeeEmail": email, "isHr": hr_view,
               # Oct 16: the manager reviews and approves without waiting for a submission.
               "canApprove": manager_side and not _tc()._finalized_row(db, email, s, e),
               "agreeBlocker": approve_blocker(db, email, s, e) if manager_side else "",
               "managerEmail": manager_of(db, email)}
        if hr_view:
            out["finalizeUnsignedBlocker"] = finalize_unsigned_blocker(db, email, s, viewer)
            out["canFinalizeUnsigned"] = not out["finalizeUnsignedBlocker"]
            out["employeeLeft"] = _has_left(db, email)
        if is_self:
            out["submitBlocker"] = submit_blocker(db, email, s, e)
        return out
    parties, my_party, turn = [], None, None
    if r.sign_request_id:
        req = db.query(HrSignRequest).filter(HrSignRequest.id == r.sign_request_id).first()
        rows = db.query(HrSignParty).filter(HrSignParty.request_id == r.sign_request_id).all()
        for p in sorted(rows, key=lambda p: _PARTY_ORDER.get(p.role_key, 9)):
            parties.append({"role": p.role_key, "name": p.name, "email": p.email, "status": p.status,
                            "signedAt": p.signed_at or "", "signatureKind": p.signature_kind or ""})
            if p.email == viewer and req and req.status == "pending" and p.ordinal == req.current_order:
                my_party = p.id
            if req and req.status == "pending" and p.ordinal == req.current_order:
                turn = p.role_key
    unsigned_blocker = (finalize_unsigned_blocker(db, email, r.period_start, viewer)
                        if hr_view and r.status in ACTIVE else "")
    return {
        "canFinalizeUnsigned": hr_view and r.status in ACTIVE and not unsigned_blocker,
        "finalizeUnsignedBlocker": unsigned_blocker,
        "employeeLeft": _has_left(db, email) if hr_view else False,
        "id": r.id, "status": r.status, "payType": r.pay_type, "employeeEmail": r.employee_email,
        "periodStart": r.period_start, "periodEnd": r.period_end,
        "managerEmail": r.manager_email, "hrEmail": r.hr_email or hr_of(db, email),
        "agreedAt": r.agreed_at, "agreedBy": r.agreed_by, "signRequestId": r.sign_request_id,
        "rounds": r.rounds or [], "parties": parties, "turn": turn, "myPartyId": my_party,
        "canSubmit": is_self and r.status in ("with_employee", "approved"),
        "canSendBack": manager_side and r.status == "with_manager",
        "canAgree": manager_side and r.status == "with_manager",
        "canApprove": manager_side and r.status == "with_manager",
        "canEmployeeApprove": is_self and r.status == "approved",
        "isHr": hr_view,
        "approvalLog": (approval_log(db, r, _offset(db, email))
                        if r.status in ("approved", "signing", "completed") else []),
        "agreeBlocker": agree_blocker(db, r) if manager_side and r.status == "with_manager" else "",
        "submitBlocker": (submit_blocker(db, email, r.period_start, r.period_end)
                          if is_self and r.status in ("with_employee", "approved") else ""),
    }
