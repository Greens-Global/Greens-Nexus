"""What is waiting on me (Pranshu, Oct 18 2026): the red dot on a sidebar
module and the count on the tab inside it, so nobody has to open Team to find
out a time-off request is waiting.

    GET /me/action-counts -> {"counts": {view: {tab: n}}}

`view` and `tab` are the frontend's own ids (Sidebar NAV view, the module's
tab key). A module's dot is the sum of its tabs.

Every count asks the SAME function or rule the screen uses - the time-off
list's canDecide, the shift inbox's _decidable, Time Sheet review's
waiting_on / to_sign, the Nexus Sign inbox's myTurn - and an approver count
goes through the same dependency the list route uses, so the number never
disagrees with the screen and a caller without access simply gets nothing.
One count failing never blanks the others.

The approval counts (time off, punch fixes, Time Sheets to review and to
sign, Nexus Sign, shift requests and swaps) are read from the Approvals
registry (approvals_inbox.collect, Oct 27 2026) - ONE pass over every
source - so a module's count and the Approvals screen always agree; the
`approvals` view's own count is that registry's total.

Left out on purpose (too slow to poll every minute): Time Sheet review's
never-submitted closed periods (timesheet_review.not_reviewed builds a time
card per person) and AMA questions (they read the ledger).
"""
import logging
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

import approvals_inbox
import models
from auth import get_current_user
from database import get_db

log = logging.getLogger(__name__)
router = APIRouter(prefix="/me", tags=["Action Counts"])


def _safe(db: Session, fn) -> int:
    """`fn()`'s count; 0 when the caller has no access (the route's own
    dependency raised) or the count failed - one bad count never blanks the
    bar."""
    try:
        return int(fn() or 0)
    except HTTPException:
        return 0
    except Exception:   # noqa: BLE001 - a badge is never worth a 500
        log.exception("action count failed")
        db.rollback()
        return 0


# ── Workday ──────────────────────────────────────────────────────────────────

def _timesheet(db: Session, me: str, to_sign: int) -> int:
    """Time Sheets waiting on my signature, or sent back to me. The ones
    waiting on my review count on People > Time (Oct 22). `to_sign` is the
    Approvals registry's timesheet_review.to_sign count.
    A time-tracking-exempt person has no time sheet of their own, so nothing
    of theirs is "sent back": a review row left from before they became
    exempt would otherwise show as a "1" over an empty tab for good
    (Neil, Oct 21 2026)."""
    from routers.timeclock import is_time_tracking_exempt
    sent_back = 0 if is_time_tracking_exempt(db, me) else (
        db.query(func.count(models.TimesheetReview.id))
        .filter(models.TimesheetReview.employee_email == me,
                models.TimesheetReview.status == "with_employee").scalar())
    return to_sign + (sent_back or 0)


def _schedule_confirm(db: Session, me: str) -> int:
    import shift_confirm
    return len(shift_confirm.my_unconfirmed(db, me))


def _weather(db: Session, user: dict) -> int:
    from routers.weather_call import my_calls
    return sum(1 for c in my_calls(user=user, db=db)["calls"] if not c.get("ackAt"))


def _checklist_steps(db: Session, me: str) -> int:
    """My open steps that are due - today or before, or with no date. A step
    due in three weeks is on the card, but not waiting on me yet."""
    import hr_checklists
    I = models.HrChecklistItem
    return (db.query(func.count(I.id))
            .join(models.HrChecklist, models.HrChecklist.id == I.checklist_id)
            .filter(hr_checklists.owned_by(me), I.status == "open", models.HrChecklist.status == "open",
                    or_(I.due_date.is_(None), I.due_date == "", func.substr(I.due_date, 1, 10) <= date.today().isoformat()))
            .scalar())


# ── Team / People (approvers) ────────────────────────────────────────────────
# Time off, shift requests and punch fixes come from the Approvals registry.

def _ask_hr(db: Session, user: dict) -> int:
    """Ask HR requests waiting on me - open HR tickets assigned to me, or
    nobody's yet in a company I am HR for (hr_tickets.waiting_on, Oct 27
    2026: Ask HR runs through Tickets)."""
    import hr_tickets
    return hr_tickets.waiting_on(db, user)


def _role_changes(db: Session, user: dict) -> int:
    from routers.hr_life_events import list_role_change_requests
    return sum(1 for r in list_role_change_requests(employee_id="", email="", user=user, db=db) if r.get("canDecide"))


# ── Accounting ───────────────────────────────────────────────────────────────

def _partner_changes(db: Session, user: dict) -> int:
    from routers.accounting_partners import _decide
    _decide(user=user, db=db)
    return (db.query(func.count(models.AccountingPartnerChange.id))
            .filter(models.AccountingPartnerChange.status == "pending").scalar())


# ── Help Center / Dashboard ──────────────────────────────────────────────────

def _kb_signoffs(db: Session, me: str) -> int:
    """Published pages that need my signature and do not have it for their
    current major version (Oct 2026 rebuild: kb_core.signoff_state is the one
    rule; audiences decide who owes a signature)."""
    import kb_core
    n = 0
    for d in db.query(models.KbDocument).filter(models.KbDocument.status == "approved", models.KbDocument.require_ack.is_(True)).all():
        st = kb_core.signoff_state(db, d, me)
        if st["required"] and not st["signed"]:
            n += 1
    return n


def _training(db: Session, me: str) -> int:
    """Assigned, published courses not completed (or expired) - read only,
    the same rule My Training shows (kb_core.training_status)."""
    import kb_core
    n = 0
    for a in db.query(models.KbCourseAssignment).filter(func.lower(models.KbCourseAssignment.user_email) == me).all():
        c = db.query(models.KbCourse).filter(models.KbCourse.id == a.course_id).first()
        if not c or c.status != "published":
            continue
        st = kb_core.training_status(db, c, kb_core.progress_of(db, c, me), a.due_date)
        if st["status"] != "Completed":
            n += 1
    return n


def _my_tickets(db: Session, me: str) -> int:
    """Tickets I raised that wait on me: the desk asked me something
    (waiting_user) or replied since I last looked (Support's unread dot)."""
    T = models.TaskTicket
    # My own Ask HR tickets count too - the query is mine only.
    return (db.query(func.count(T.id)).execution_options(include_confidential=True)
            .filter(func.lower(T.requester_email) == me,
                    or_(T.status.is_(None), T.status.notin_(("resolved", "closed"))),
                    or_(T.status == "waiting_user",
                        (T.requester_update_at != "") & (T.requester_update_at > func.coalesce(T.requester_seen_at, ""))))
            .scalar())


def _announcements(db: Session, user: dict) -> int:
    from routers.announcements import list_announcements
    return sum(1 for a in list_announcements(user=user, db=db) if a["requires_ack"] and not a["acknowledged_at"])


@router.get("/action-counts")
def action_counts(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """{"counts": {view: {tab: n}}} - zero counts are left out."""
    me = (user.get("email") or "").lower()
    s = lambda fn: _safe(db, fn)   # noqa: E731
    # The approval counts: one pass over the Approvals registry (a source that
    # fails or that the caller cannot open counts 0 there, as _safe does).
    try:
        inbox = approvals_inbox.collect(db, user)
    except Exception:   # noqa: BLE001 - a badge is never worth a 500
        log.exception("approvals count failed")
        db.rollback()
        inbox = {"counts": {}, "total": 0}
    a = inbox["counts"].get
    # Team > Requests and People > Time both list it; HR's second level of
    # Second Approval By HR (leave depth, Oct 27 2026) counts with it, once.
    time_off = a("time_off", 0) + a("time_off_hr", 0)
    counts = {
        "myhr": {
            "timesheet": s(lambda: _timesheet(db, me, a("timesheet_sign", 0))),
            "overview": s(lambda: _schedule_confirm(db, me)) + s(lambda: _weather(db, user))
                        + s(lambda: _checklist_steps(db, me)) + a("nexus_sign", 0),
            "timeoff": a("shift_peer", 0),
        },
        "shifts": {
            "requests": a("shift_request", 0) + time_off,
        },
        "hr": {
            "hr-time": time_off + a("punch_fix", 0) + a("timesheet_review", 0),
            "hr-people": s(lambda: _ask_hr(db, user)) + s(lambda: _role_changes(db, user)),
        },
        "accounting": {
            "partners": s(lambda: _partner_changes(db, user)),
        },
        "support": {
            "kb": s(lambda: _kb_signoffs(db, me)) + s(lambda: _training(db, me)),
            "open": s(lambda: _my_tickets(db, me)),
        },
        "dashboard": {
            "announcements": s(lambda: _announcements(db, user)),
        },
        # The Approvals screen (Oct 27 2026): every decision above, plus
        # reimbursements, purchase requests and hiring votes.
        "approvals": {
            "inbox": int(inbox.get("total") or 0),
        },
    }
    return {"counts": {v: {t: n for t, n in tabs.items() if n} for v, tabs in counts.items()
                       if any(tabs.values())}}
