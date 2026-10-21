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

Left out on purpose (too slow to poll every minute): Time Sheet review's
never-submitted closed periods (timesheet_review.not_reviewed builds a time
card per person) and AMA questions (they read the ledger).
"""
import logging
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

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

def _timesheet(db: Session, me: str) -> int:
    """Time Sheets submitted to me, waiting on my signature, or sent back to me.
    A time-tracking-exempt person has no time sheet of their own, so nothing
    of theirs is "sent back": a review row left from before they became
    exempt would otherwise show as a "1" over an empty tab for good
    (Neil, Oct 21 2026)."""
    import timesheet_review as tsr
    from routers.timeclock import is_time_tracking_exempt
    sent_back = 0 if is_time_tracking_exempt(db, me) else (
        db.query(func.count(models.TimesheetReview.id))
        .filter(models.TimesheetReview.employee_email == me,
                models.TimesheetReview.status == "with_employee").scalar())
    return len(tsr.waiting_on(db, me)) + len(tsr.to_sign(db, me)) + (sent_back or 0)


def _schedule_confirm(db: Session, me: str) -> int:
    import shift_confirm
    return len(shift_confirm.my_unconfirmed(db, me))


def _weather(db: Session, user: dict) -> int:
    from routers.weather_call import my_calls
    return sum(1 for c in my_calls(user=user, db=db)["calls"] if not c.get("ackAt"))


def _checklist_steps(db: Session, me: str) -> int:
    """My open steps that are due - today or before, or with no date. A step
    due in three weeks is on the card, but not waiting on me yet."""
    I = models.HrChecklistItem
    return (db.query(func.count(I.id))
            .join(models.HrChecklist, models.HrChecklist.id == I.checklist_id)
            .filter(I.owner_email == me, I.status == "open", models.HrChecklist.status == "open",
                    or_(I.due_date.is_(None), I.due_date == "", func.substr(I.due_date, 1, 10) <= date.today().isoformat()))
            .scalar())


def _documents_to_sign(db: Session, user: dict) -> int:
    """Nexus Sign documents where it is my turn - Time Sheets excluded (the
    Time Sheet tab counts those)."""
    from routers.esign import my_signatures
    return sum(1 for r in my_signatures(user=user, db=db) if r["myTurn"] and r.get("linkKind") != "timesheet")


def _swaps_for_me(db: Session, me: str) -> int:
    """A teammate's swap / offer waiting for my yes - upcoming shifts only."""
    R = models.ShiftRequest
    return (db.query(func.count(R.id))
            .filter(R.target_email == me, R.status == "pending_peer",
                    or_(R.shift_date == "", R.shift_date >= date.today().isoformat())).scalar())


# ── Team / People (approvers) ────────────────────────────────────────────────

def _approver(db: Session, user: dict) -> dict:
    """The user the approval list routes see (require_approval_read): the
    team-read gate, plus a live approval delegation's people."""
    from routers.timeclock import require_approval_read, require_team_read
    return require_approval_read(user=require_team_read(user={**user}, db=db), db=db)


def _time_off_to_decide(db: Session, user: dict) -> int:
    from routers.timeclock import list_timeoff, _TIMEOFF_LIST_LIMIT
    rows = list_timeoff(status="pending", from_="", to="", limit=_TIMEOFF_LIST_LIMIT,
                        user=_approver(db, user), db=db)
    return sum(1 for r in rows if r.get("canDecide") is not False)


def _shift_requests_to_decide(db: Session, user: dict) -> int:
    """The Team > Requests inbox's `pending` rule (shift_requests.inbox)."""
    from routers.timeclock import require_schedule_write, _visible_emails
    from routers.shift_requests import _decidable
    u = require_schedule_write(user={**user}, db=db)
    scope, me, cache = _visible_emails(db, u), u["email"].lower(), {}
    return sum(1 for r in db.query(models.ShiftRequest).filter(models.ShiftRequest.status == "pending_manager").all()
               if _decidable(db, r, scope, me, cache) and me not in (r.requester_email, r.target_email))


def _punch_fixes(db: Session, user: dict) -> int:
    """Punch-fix requests (one per person + kind + minute, as People > Time
    counts them) and punch-time edits waiting on me."""
    from routers.timeclock import list_punch_requests, list_pending_punch_edits
    u = _approver(db, user)
    keys = {(f"{r['employeeEmail'].lower()}|{r['punchKind']}|{(r['at'] or '')[:16]}"
             if r["action"] == "add" and r["at"] else r["id"])
            for r in list_punch_requests(status="pending", user=u, db=db)}
    return len(keys) + len(list_pending_punch_edits(user=u, db=db))


def _ask_hr(db: Session, user: dict) -> int:
    from routers.hr import list_self_requests, require_hr_read
    return len(list_self_requests(status="open", user=require_hr_read(user=user, db=db), db=db))


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
    docs = {d.id: d.version for d in db.query(models.KbDocument)
            .filter(models.KbDocument.status == "approved", models.KbDocument.require_ack.is_(True)).all()}
    if not docs:
        return 0
    signed = {(a.doc_id, a.version) for a in db.query(models.KbAcknowledgement)
              .filter(func.lower(models.KbAcknowledgement.user_email) == me,
                      models.KbAcknowledgement.doc_id.in_(list(docs))).all()}
    return sum(1 for doc_id, version in docs.items() if (doc_id, version) not in signed)


def _training(db: Session, me: str) -> int:
    """Assigned, published courses not completed (or due again) - the rule of
    /knowledge-base/my-assignments, read only (that route also sends the due
    reminders, which a badge must not)."""
    from routers.knowledge_base import _progress_dict, _recert, _status_for
    n = 0
    for a in db.query(models.KbCourseAssignment).filter(func.lower(models.KbCourseAssignment.user_email) == me).all():
        c = db.query(models.KbCourse).filter(models.KbCourse.id == a.course_id).first()
        if not c or c.status != "published":
            continue
        prog = _progress_dict(db.query(models.KbCourseProgress).filter(
            models.KbCourseProgress.course_id == c.id, func.lower(models.KbCourseProgress.user_email) == me).first())
        expired, _renew_by = _recert(c, prog)
        if _status_for(c, prog) != "Completed" or expired:
            n += 1
    return n


def _my_tickets(db: Session, me: str) -> int:
    """Tickets I raised that wait on me: the desk asked me something
    (waiting_user) or replied since I last looked (Support's unread dot)."""
    T = models.TaskTicket
    return (db.query(func.count(T.id))
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
    time_off = s(lambda: _time_off_to_decide(db, user))   # Team > Requests and People > Time both list it
    counts = {
        "myhr": {
            "timesheet": s(lambda: _timesheet(db, me)),
            "overview": s(lambda: _schedule_confirm(db, me)) + s(lambda: _weather(db, user))
                        + s(lambda: _checklist_steps(db, me)) + s(lambda: _documents_to_sign(db, user)),
            "timeoff": s(lambda: _swaps_for_me(db, me)),
        },
        "shifts": {
            "requests": s(lambda: _shift_requests_to_decide(db, user)) + time_off,
        },
        "hr": {
            "hr-time": time_off + s(lambda: _punch_fixes(db, user)),
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
    }
    return {"counts": {v: {t: n for t, n in tabs.items() if n} for v, tabs in counts.items()
                       if any(tabs.values())}}
