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
"""
from __future__ import annotations

import hashlib
import io
import json
import uuid
from datetime import date, datetime, timezone

from fastapi import HTTPException
from sqlalchemy.orm import Session

from models import (HrEntity, HrSignParty, HrSignRequest, NexusEmployee, PunchRequest,
                    TimeApproval, TimePunch, TimesheetReview)

ACTIVE = ("with_manager", "with_employee", "signing")
LINK_KIND = "timesheet"
# Nexus Sign role keys, in signing order.
ROLES = (("employee", "Employee"), ("manager", "Manager"), ("hr", "HR"))


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
    return ""


def hr_of(db: Session, email: str) -> str:
    """The HR contact of the employee's company (People -> Companies)."""
    emp = _employee(db, email)
    ent = db.query(HrEntity).filter(HrEntity.id == (emp.company if emp else "")).first() if emp else None
    return ((ent.hr_contact_email if ent else "") or "").strip().lower()


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
               employee_request: bool = False) -> None:
    """Called by every route that changes hours. One side at a time during
    review; nobody while it is out for signature.

    `employee_request`: the approver is deciding the EMPLOYEE's own punch fix
    (an add / remove request or a proposed time). That is the employee's
    change, not the manager's, so it goes through whichever side holds the
    timesheet (Oct 1: back with the employee, their "add clock-in" request
    could not be approved - the employee could not resubmit with the error,
    the manager could not approve the fix: neither side could move)."""
    email = (email or "").lower()
    r = review_covering(db, email, (local_date or "")[:10])
    if not r:
        return
    if r.status == "signing":
        raise HTTPException(403, "This timesheet is out for signature in Nexus Sign. To change it, "
                                 "decline it there with a reason - it comes back for another round.")
    if employee_request:
        return
    is_employee = (actor_email or "").lower() == email
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


# ── Waiting on a reviewer ────────────────────────────────────────────────────

def submit_blocker(db: Session, email: str, start: str, end: str) -> str:
    """Why the employee may not submit (or resubmit) this period yet, in plain
    words; '' when they may. A missing clock-out, a clock-out with no
    clock-in or a break that never ended is fixed by the employee BEFORE it
    reaches the manager (Oct 1) - the same blocking exceptions agree() checks.
    Judged as if the employee's own pending punch fixes were approved: their
    fixes ARE requests, and the manager approves them during review."""
    tc = _tc()
    exc = tc._blocking_exceptions(db, email, start, end, with_pending=True)
    if not exc:
        return ""
    return (f"Fix {'this' if len(exc) == 1 else 'these'} on your timesheet before you submit it - "
            f"{tc._exception_summary(exc)}.")


def agree_blocker(db: Session, r: TimesheetReview) -> str:
    """Why Agree would be refused right now, in plain words; '' when it would
    go through. The same checks agree() makes, so the screen can say so up
    front instead of after the click (Sep 29)."""
    tc = _tc()
    if tc._employee_today(db, r.employee_email) < r.period_end:
        return (f"This period runs to {us_date(r.period_end)}. You can agree to it after that day, "
                "once every day is in.")
    exc = tc._blocking_exceptions(db, r.employee_email, r.period_start, r.period_end)
    if exc:
        pending = tc._pending_fixes(db, r.employee_email, r.period_start, r.period_end)
        if pending:
            # The employee's fixes are on the timecard, waiting on the approver.
            return (f"{display_name(db, r.employee_email)} has {pending} punch "
                    f"fix{'' if pending == 1 else 'es'} waiting for your approval on the timesheet above - "
                    f"approve {'it' if pending == 1 else 'them'} to clear: {tc._exception_summary(exc)}.")
        return (f"Fix {'this' if len(exc) == 1 else 'these'} on the timesheet before you can agree - "
                f"{tc._exception_summary(exc)}. Or send it back to the employee to fix.")
    return ""


def waiting_on(db: Session, reviewer: str) -> list:
    """Timesheets submitted to `reviewer` that they have not decided yet,
    oldest first."""
    rows = (db.query(TimesheetReview)
            .filter(TimesheetReview.status == "with_manager",
                    TimesheetReview.manager_email == (reviewer or "").lower()).all())
    return sorted(rows, key=lambda r: (r.updated_at or "", r.period_start))


def queue_row(db: Session, r: TimesheetReview) -> dict:
    """One line of the reviewer's list: who, which period, the hours as last
    submitted, when, their note, and whether Agree would go through now."""
    last = next((e for e in reversed(r.rounds or []) if e.get("action") in ("submitted", "resubmitted")), {})
    return {"id": r.id, "employeeEmail": r.employee_email, "name": display_name(db, r.employee_email),
            "periodStart": r.period_start, "periodEnd": r.period_end, "payType": r.pay_type,
            "workedMin": int(last.get("workedMin") or 0), "submittedAt": last.get("at") or r.updated_at or "",
            "resubmitted": last.get("action") == "resubmitted", "note": last.get("note") or "",
            "agreeBlocker": agree_blocker(db, r)}


# ── Review actions ───────────────────────────────────────────────────────────

def submit(db: Session, employee_email: str, anchor: str, note: str = "") -> TimesheetReview:
    """Employee: first submission, or a resubmission after it was sent back."""
    email = employee_email.lower()
    start, end, pay_type = period_for(db, email, anchor)
    r = active_review(db, email, start)
    if r and r.status == "with_manager":
        raise HTTPException(409, "Your timesheet is already with your manager.")
    if r and r.status in ("signing", "completed"):
        raise HTTPException(409, "This timesheet has already been agreed and is being signed.")
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


def agree(db: Session, r: TimesheetReview, actor: str, note: str = "", *, ip: str = "",
          user_agent: str = "") -> TimesheetReview:
    """Manager agrees to the timesheet exactly as it stands: freeze it and send
    it for signature, employee first."""
    tc = _tc()
    if r.status != "with_manager":
        raise HTTPException(409, "Only a timesheet that is with the manager can be agreed.")
    today = tc._employee_today(db, r.employee_email)
    if today < r.period_end:
        raise HTTPException(409, f"This period runs to {us_date(r.period_end)}. Agree to it after the "
                                 "last day, so every day is in before it is signed.")
    exc = tc._blocking_exceptions(db, r.employee_email, r.period_start, r.period_end)
    if exc:
        if tc._pending_fixes(db, r.employee_email, r.period_start, r.period_end):
            # The employee's fixes are waiting on THIS approver - say so, in the
            # words the panel shows (agree_blocker), not "send it back".
            raise HTTPException(409, {"code": "unresolved_exceptions", "message": agree_blocker(db, r),
                                      "exceptions": exc})
        tc._exceptions_409(exc, can_override=False)   # a review has no override - send it back instead
    hr = hr_of(db, r.employee_email)
    if not hr:
        raise HTTPException(409, "This company has no HR contact, so nobody can finalize the timesheet. "
                                 "Set one in People -> Companies.")
    r.agreed_fingerprint = fingerprint(db, r.employee_email, r.period_start, r.period_end)
    r.agreed_at, r.agreed_by, r.hr_email = _now(), actor.lower(), hr
    _round(db, r, by=actor, action="agreed", note=note, with_changes=True)
    r.sign_request_id = _send_envelope(db, r, actor, ip=ip, user_agent=user_agent)
    r.status = "signing"
    db.commit()
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
    offset = 0
    last = (db.query(TimePunch).filter(TimePunch.employee_email == r.employee_email)
            .order_by(TimePunch.at.desc()).first())
    if last:
        offset = last.tz_offset_min or 0

    def local_time(iso: str) -> str:
        if not iso:
            return "-"
        try:
            t = datetime.fromisoformat(iso.replace("Z", "+00:00")[:19])
        except ValueError:
            return "-"
        from datetime import timedelta
        t = t - timedelta(minutes=offset)
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
    text(margin, f"Agreed by {display_name(db, r.agreed_by)} on {us_date(r.agreed_at)}. "
                 f"Version {r.agreed_fingerprint[:12]}", 8, color=(0.4, 0.4, 0.45))
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
        spans = ", ".join(f"{local_time(s.get('in'))} - {local_time(s.get('out'))}" for s in segs) or "-"
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
              "agreed": "agreed", "declined": "declined", "returned": "returned", "cancelled": "cancelled"}
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
    text(margin, "By signing, each party attests that the hours on this timesheet are accurate "
                 "for the pay period shown.", 9)
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
    page_count = c.getPageNumber()
    c.save()
    return buf.getvalue(), page_count - 1


def _send_envelope(db: Session, r: TimesheetReview, actor: str, *, ip: str, user_agent: str) -> str:
    from routers import esign
    pdf, last_page = build_pdf(db, r)
    emp = _employee(db, r.employee_email)
    safe = esign._safe_filename(f"Timesheet {display_name(db, r.employee_email)} {r.period_start}")
    path = f"esign/{uuid.uuid4()}/{safe}.pdf"
    up = esign._storage_put(esign._DOC_BUCKET, path, pdf, "application/pdf")
    if not up.is_success:
        raise HTTPException(502, "The timesheet could not be stored for signing. Try again.")
    who = {"employee": r.employee_email, "manager": actor.lower(), "hr": r.hr_email}
    parties = [esign.PartyIn(role_key=role, name=display_name(db, who[role]), email=who[role],
                             kind="internal", ordinal=i + 1, party_role="signer")
               for i, (role, _l) in enumerate(ROLES)]
    out = esign._create_request(
        db, {"email": actor.lower()}, title=f"Timesheet - {display_name(db, r.employee_email)} - {_label(r)}",
        source="pdf", template_id="", employee_id=(emp.id if emp else ""), candidate_id="",
        entity_id=(emp.company if emp else ""), body_snapshot=[], pdf_storage_path=path,
        fields=esign._clean_fields(_sig_fields(last_page)),
        message=f"Please review and sign the timesheet for {_label(r)}.", expires_on="",
        parties=parties, ip=ip, user_agent=user_agent, routing="sequential",
        excluded_ack=True, document_class="employment")
    req = db.query(HrSignRequest).filter(HrSignRequest.id == out["id"]).first()
    req.link_kind, req.link_id = LINK_KIND, r.id
    return req.id


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
    """Whoever declines gets it back to change; HR's return goes to the manager."""
    r = _for(db, req)
    if not r or r.status != "signing":
        return
    to_employee = party.role_key == "employee"
    r.status = "with_employee" if to_employee else "with_manager"
    r.sign_request_id, r.agreed_fingerprint = "", ""
    _round(db, r, by=party.email, action="returned" if party.role_key == "hr" else "declined",
           note=reason, with_changes=True)
    back_to = r.employee_email if to_employee else r.manager_email
    other = r.manager_email if to_employee else r.employee_email
    msg = (f"{display_name(db, party.email)} did not sign the timesheet for {_label(r)}"
           + (f': "{reason.strip()[:200]}"' if (reason or "").strip() else "") + ".")
    _notify(db, back_to, "Timesheet returned for changes", msg + " It is back with you.", r)
    _notify(db, other, "Timesheet returned for changes", msg, r)


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
    e, m = parties.get("employee"), parties.get("manager")
    if e:
        db.add(TimeApproval(id=str(uuid.uuid4()), approved_by=e.email, approved_at=e.signed_at or _now(),
                            kind="employee_sign", note=e.name or display_name(db, e.email), **base))
    if m:
        db.add(TimeApproval(id=str(uuid.uuid4()), approved_by=m.email, approved_at=m.signed_at or _now(),
                            kind="manager", note=f"Nexus Sign {req.id}", **base))
    r.status = "completed"
    _round(db, r, by=r.hr_email, action="completed")
    db.flush()
    if not tc._finalized_row(db, r.employee_email, r.period_start, r.period_end):
        hr = parties.get("hr")
        tc.finalize_timecard(tc.FinalizeIn(email=r.employee_email, start=r.period_start, end=r.period_end,
                                           allow_exceptions=True),
                             user={"email": (hr.email if hr else r.hr_email), "level": 4}, db=db)


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
    if not r:
        out = {"status": "not_submitted", "canSubmit": is_self, "rounds": [], "parties": [], "submitBlocker": ""}
        if is_self:
            s, e, _pt = period_for(db, email, start)
            out["submitBlocker"] = submit_blocker(db, email, s, e)
        return out
    parties, my_party, turn = [], None, None
    if r.sign_request_id:
        req = db.query(HrSignRequest).filter(HrSignRequest.id == r.sign_request_id).first()
        rows = db.query(HrSignParty).filter(HrSignParty.request_id == r.sign_request_id).all()
        order = {k: i for i, (k, _l) in enumerate(ROLES)}
        for p in sorted(rows, key=lambda p: order.get(p.role_key, 9)):
            parties.append({"role": p.role_key, "name": p.name, "email": p.email, "status": p.status,
                            "signedAt": p.signed_at or "", "signatureKind": p.signature_kind or ""})
            if p.email == viewer and req and req.status == "pending" and p.ordinal == req.current_order:
                my_party = p.id
            if req and req.status == "pending" and p.ordinal == req.current_order:
                turn = p.role_key
    manager_side = viewer_team and not is_self
    return {
        "id": r.id, "status": r.status, "payType": r.pay_type, "employeeEmail": r.employee_email,
        "periodStart": r.period_start, "periodEnd": r.period_end,
        "managerEmail": r.manager_email, "hrEmail": r.hr_email or hr_of(db, email),
        "agreedAt": r.agreed_at, "agreedBy": r.agreed_by, "signRequestId": r.sign_request_id,
        "rounds": r.rounds or [], "parties": parties, "turn": turn, "myPartyId": my_party,
        "canSubmit": is_self and r.status == "with_employee",
        "canSendBack": manager_side and r.status == "with_manager",
        "canAgree": manager_side and r.status == "with_manager",
        "agreeBlocker": agree_blocker(db, r) if manager_side and r.status == "with_manager" else "",
        "submitBlocker": (submit_blocker(db, email, r.period_start, r.period_end)
                          if is_self and r.status == "with_employee" else ""),
    }
