"""Nexus Daily Briefing (Aug 2026 - Neil's "one email" ask, call 8/21).

Every employee gets exactly ONE email a day, ~2.5 hours before THEIR OWN
shift starts, replacing the scatter of individual Nexus notification emails.
Sections are color-banded by urgency: red (needs your approval), amber
(activity on something you're watching), blue (FYI - manager add-on only in
this phase), green (completed since your last briefing). A section with
nothing in it is omitted, never rendered empty.

Settings live in NexusSetting (key="daily_briefing_config", JSON value) -
same pattern as ticket_notify.py. `mode`:
  - "off"  - loop still scans + logs (so timing/dedupe can be watched) but
             never sends mail.
  - "test" - computes each real employee's real content, but the SEND is
             redirected to `test_recipients` with a "[TEST -> original]"
             subject prefix, so every employee's actual briefing can be
             eyeballed without anyone else receiving anything. This is the
             mode Phase 1 ships in - Neil was explicit: build it, don't turn
             it on for real people until it's proven.
  - "live" - sends to the real employee.

Dedupe + "since last briefing" cursor is NexusDailyBriefingLog (models.py) -
one row per (employee, shift-local calendar day). Shift-start resolution
reuses routers.timeclock._shift_start_for / _shift_local_now rather than
reimplementing shift lookup - those already handle ScheduledShift ->
ShiftAssignment -> preset fallback and, as of Sep 11, the Shift preset's own
`timezone` field (e.g. GG India's shift stays anchored to IST) instead of
guessing the employee's zone from their last punch's browser offset.
"""
import asyncio
import json
import uuid
from datetime import datetime, timezone, timedelta
from html import escape

from sqlalchemy import func, text
from sqlalchemy.orm import Session

import models
from database import SessionLocal
import graph_mail
import briefing_mail_actions
import task_mail_actions
import ticket_mail_templates
from app_url import app_url
from routers.task_util import task_assignees
from routers.timeclock import _shift_start_for, _shift_local_now

_SETTINGS_KEY = "daily_briefing_config"
_DEFAULT_SETTINGS = {
    "mode": "off",              # off|test|live
    "test_recipients": [],
}

TRIGGER_MINUTES_BEFORE_SHIFT = 150   # 2.5h - agreed on the call
SCAN_EVERY_SEC = 15 * 60             # tight enough to catch a shift-relative
                                      # instant within 15 minutes, matching
                                      # timeclock_watch.py's 30-min precedent
                                      # for a similar per-person threshold
LOOKBACK_HOURS_FIRST_RUN = 48        # "since" window when an employee has no
                                      # prior briefing logged yet


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def _fmt_date(iso_str: str) -> str:
    """ISO (YYYY-MM-DD) -> MM/DD/YYYY, per the US date-format convention."""
    try:
        return datetime.strptime(iso_str, "%Y-%m-%d").strftime("%m/%d/%Y")
    except (TypeError, ValueError):
        return iso_str or ""


# ── Settings ───────────────────────────────────────────────────────────────

def get_settings(db: Session) -> dict:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    if not row or not row.value:
        return json.loads(json.dumps(_DEFAULT_SETTINGS))
    try:
        cfg = json.loads(row.value)
    except (TypeError, ValueError):
        cfg = {}
    merged = json.loads(json.dumps(_DEFAULT_SETTINGS))
    merged.update(cfg)
    return merged


def save_settings(db: Session, patch: dict, actor_email: str) -> dict:
    merged = get_settings(db)
    merged.update(patch)
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    if not row:
        row = models.NexusSetting(key=_SETTINGS_KEY)
        db.add(row)
    row.value = json.dumps(merged)
    row.updated_by = actor_email
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    return merged


# ── Trigger + dedupe ──────────────────────────────────────────────────────

def _last_log(db: Session, email: str):
    return (db.query(models.NexusDailyBriefingLog)
            .filter(models.NexusDailyBriefingLog.employee_email == email)
            .order_by(models.NexusDailyBriefingLog.created_at.desc())
            .first())


def _already_logged_today(db: Session, email: str, briefing_date: str) -> bool:
    return (db.query(models.NexusDailyBriefingLog)
            .filter(models.NexusDailyBriefingLog.employee_email == email,
                    models.NexusDailyBriefingLog.briefing_date == briefing_date)
            .first()) is not None


def _trigger_due(db: Session, email: str) -> tuple:
    """(due: bool, briefing_date: str, local_now: datetime) - due once the
    employee's SHIFT's own timezone has reached shift_start minus
    TRIGGER_MINUTES_BEFORE_SHIFT, for a shift on today's or tomorrow's date in
    that zone (whichever the trigger window actually falls on - a person whose
    shift starts at 1am local needs their briefing to fire while "today" by
    wall clock is still yesterday's date, exactly like the call-out to reject
    a fixed UTC hour). Uses the Shift preset's own `timezone` field (e.g. GG
    India's 18:00 shift stays on IST) rather than guessing the employee's
    timezone from their last punch - a team's shift clock doesn't move just
    because someone hasn't punched in yet."""
    # Candidate dates span a full day either side of UTC-today rather than the
    # employee's own local date: which calendar date a shift is scheduled/
    # assigned on is independent of the timezone the shift then runs in, and a
    # +/-1 day window comfortably covers every real-world UTC offset (-12..+14).
    utc_today = datetime.now(timezone.utc).date()
    for dd in (utc_today - timedelta(days=1), utc_today, utc_today + timedelta(days=1)):
        shift = _shift_start_for(db, email, dd)
        if not shift:
            continue
        hh, mm = shift[0].split(":")
        local_now = _shift_local_now(shift[2])
        shift_start = datetime.combine(dd, datetime.min.time()).replace(hour=int(hh), minute=int(mm))
        trigger_at = shift_start - timedelta(minutes=TRIGGER_MINUTES_BEFORE_SHIFT)
        if trigger_at <= local_now < shift_start and not _already_logged_today(db, email, dd.isoformat()):
            return True, dd.isoformat(), local_now
    return False, "", _shift_local_now("America/Los_Angeles")


# ── Content ───────────────────────────────────────────────────────────────

def _collaborator_emails(t: "models.Task") -> set:
    # Same guard as task_util.email_list: a null in follower_emails would raise
    # here too, and this runs inside the briefing loop where the failure is
    # silent rather than a visible 500.
    return set(task_assignees(t)) | {(t.owner_email or "").lower()} | \
           {f.lower() for f in (t.follower_emails or []) if isinstance(f, str)}


def _item_action_rows(db: Session, email: str, is_manager: bool) -> list:
    """Read-only against models.ItemCheckout / models.ItemAssignment - mirrors
    the same "query the shared table directly" pattern _red_rows already uses
    for Task/TimeOffRequest, without touching routers/items.py (Visesh's
    file). Status vocab + responsible-party fields confirmed against
    items.py's own _notify call sites (approver_email / assigned_allocator_email
    / requested_by_email / assignee_email)."""
    # Every row here is a physical handover, a photo requirement, or an
    # allocator pick (per CLAUDE.md's "photos are evidence" rule) - none of
    # that can be a one-click email action, so these stay "Open in Nexus"
    # only. Module tag drives the email's per-module accordion grouping.
    rows = []
    items_url = f"{app_url()}/itemmanagement"
    for c in (db.query(models.ItemCheckout)
              .filter(models.ItemCheckout.status == "pending",
                      models.ItemCheckout.approver_email == email).all()):
        rows.append({"title": f"Approve checkout: {c.item_name}",
                     "detail": f"Requested by {c.requested_by}", "url": items_url, "module": "items"})
    for c in (db.query(models.ItemCheckout)
              .filter(models.ItemCheckout.status == "approved",
                      models.ItemCheckout.assigned_allocator_email == email).all()):
        rows.append({"title": f"Hand over: {c.item_name}",
                     "detail": f"Approved for {c.requested_by}", "url": items_url, "module": "items"})
    for c in (db.query(models.ItemCheckout)
              .filter(models.ItemCheckout.status == "pending_receipt",
                      models.ItemCheckout.requested_by_email == email).all()):
        rows.append({"title": f"Confirm receipt: {c.item_name}",
                     "detail": "Handed over - confirm you received it", "url": items_url, "module": "items"})
    for a in (db.query(models.ItemAssignment)
              .filter(models.ItemAssignment.status == "pending_acceptance",
                      models.ItemAssignment.assignee_email == email).all()):
        rows.append({"title": f"Accept assignment: {a.item_name}",
                     "detail": f"Assigned by {a.assigned_by}", "url": items_url, "module": "items"})
    if is_manager:
        for c in (db.query(models.ItemCheckout)
                  .filter(models.ItemCheckout.extension_status == "pending").all()):
            rows.append({"title": f"Approve extension: {c.item_name}",
                         "detail": f"{c.requested_by} requested {c.extension_days} more day(s)",
                         "url": items_url, "module": "items"})
    return rows


def _ticket_url(*, ticket_id: str, for_requester: bool) -> str:
    return ticket_mail_templates._ticket_url(app_url(), ticket_id, for_requester=for_requester)


def _ticket_action_rows(db: Session, email: str) -> list:
    """Read-only against models.TaskTicket, same pattern as
    _item_action_rows. Only the approval decision is a plain yes/no with no
    picker attached - it gets a one-click Approve/Reject (rejecting still
    lands on the confirm page since a reason is required there, same as
    Nexus itself - see routers/briefing_actions.py). An assigned, unresolved
    ticket has no single safe one-click resolution (status change needs a
    resolution reason) so it stays "Open in Nexus" only, same reasoning as
    the checkout/assignment rows above (Pranshu, Sep 20)."""
    rows = []
    for t in (db.query(models.TaskTicket)
              .filter(models.TaskTicket.approval_status == "pending",
                      models.TaskTicket.approver_email == email).all()):
        rows.append({
            "title": f"Approve: {t.subject}",
            "detail": f"{t.code or 'Ticket'} - waiting on your decision",
            "url": _ticket_url(ticket_id=t.id, for_requester=False),
            "module": "tickets",
            "action_kind": "ticket_approval", "action_id": t.id, "action_email": email,
        })
    for t in (db.query(models.TaskTicket)
              .filter(models.TaskTicket.assignee_email == email,
                      models.TaskTicket.status.notin_(["resolved", "closed"])).all()):
        rows.append({
            "title": f"{t.code or 'Ticket'} - {t.subject}",
            "detail": f"Assigned to you - {(t.status or 'new').replace('_', ' ')}",
            "url": _ticket_url(ticket_id=t.id, for_requester=False),
            "module": "tickets",
        })
    return rows


def _ticket_needs_to_know_rows(db: Session, email: str, since_iso: str) -> list:
    rows = []
    for t in (db.query(models.TaskTicket)
              .filter(models.TaskTicket.requester_email == email,
                      models.TaskTicket.last_comment_at >= since_iso,
                      models.TaskTicket.last_comment_at != "",
                      models.TaskTicket.status.notin_(["resolved", "closed"])).all()):
        rows.append({
            "title": f"{t.code or 'Ticket'} - {t.subject}",
            "detail": "New activity on your ticket",
            "url": _ticket_url(ticket_id=t.id, for_requester=True),
            "module": "tickets",
        })
    return rows


def _ticket_completed_rows(db: Session, email: str, since_iso: str) -> list:
    rows = []
    for t in (db.query(models.TaskTicket)
              .filter(models.TaskTicket.requester_email == email,
                      models.TaskTicket.status.in_(["resolved", "closed"]),
                      models.TaskTicket.resolved_at >= since_iso,
                      models.TaskTicket.resolved_at != "").all()):
        rows.append({
            "title": f"{t.code or 'Ticket'} - {t.subject}",
            "detail": "Resolved" if t.status == "resolved" else "Closed",
            "url": _ticket_url(ticket_id=t.id, for_requester=True),
            "module": "tickets",
        })
    return rows


_ESIGN_URL = "/documents/documents-esign"   # same landing every internal signer's own notification email already uses (esign.py _send_sign_email) - no per-envelope deep link exists for internal parties, so this is not a step down from what they get today.


def _esign_action_rows(db: Session, email: str) -> list:
    """Read-only against HrSignRequest/HrSignParty (Nexus Sign, part of the
    Documents module). Reuses esign.py's own _its_their_turn rather than
    re-deriving it - sequential vs parallel routing, acting-role filtering
    (signer/approver/certified_delivery vs a CC) and the decline/consent
    edge cases are intricate enough that a second copy would drift (Pranshu,
    Sep 20). External parties are skipped: they sign via a token link with no
    Nexus login, so there is no Nexus account to send a briefing to. Signing
    itself is never a one-click mail action - it is a drawn/typed signature
    plus ESIGN/UETA consent, which is exactly the kind of thing CLAUDE.md's
    "photos are evidence" rule already rules out for a bare link."""
    from routers.esign import _its_their_turn
    rows = []
    candidates = (db.query(models.HrSignParty)
                  .filter(models.HrSignParty.email == email, models.HrSignParty.kind == "internal",
                          models.HrSignParty.status.in_(["waiting", "notified", "viewed"])).all())
    if not candidates:
        return rows
    req_ids = {p.request_id for p in candidates}
    reqs = {r.id: r for r in db.query(models.HrSignRequest)
            .filter(models.HrSignRequest.id.in_(req_ids), models.HrSignRequest.status == "pending").all()}
    for p in candidates:
        req = reqs.get(p.request_id)
        if not req or not _its_their_turn(req, p):
            continue
        rows.append({
            "title": f"Sign: {req.title}",
            "detail": "Signature required",
            "url": f"{app_url()}{_ESIGN_URL}",
            "module": "documents",
        })
    return rows


def _esign_needs_to_know_rows(db: Session, email: str, since_iso: str) -> list:
    """Envelopes you sent where a party declined since your last briefing -
    the one mid-flight esign event that needs your attention without waiting
    for full completion (a decline usually means re-sending to someone
    else)."""
    rows = []
    # Dedupe in Python, not .distinct() - HrSignRequest has JSON (not JSONB)
    # columns, which Postgres has no equality operator for, so a
    # SELECT DISTINCT across the full entity 500s there (fine on SQLite,
    # which is why local testing never caught it).
    seen_ids, declined = set(), []
    for req in (db.query(models.HrSignRequest)
                .join(models.HrSignEvent, models.HrSignEvent.request_id == models.HrSignRequest.id)
                .filter(models.HrSignRequest.created_by == email,
                        models.HrSignEvent.type == "declined",
                        models.HrSignEvent.at >= since_iso).all()):
        if req.id not in seen_ids:
            seen_ids.add(req.id)
            declined.append(req)
    for req in declined:
        rows.append({
            "title": f"Declined: {req.title}",
            "detail": "A signer declined - review and re-send if needed",
            "url": f"{app_url()}{_ESIGN_URL}",
            "module": "documents",
        })
    return rows


def _esign_completed_rows(db: Session, email: str, since_iso: str) -> list:
    my_party_reqs = {p.request_id for p in
                      db.query(models.HrSignParty)
                      .filter(models.HrSignParty.email == email, models.HrSignParty.kind == "internal").all()}
    rows = []
    for req in (db.query(models.HrSignRequest)
                .filter(models.HrSignRequest.status == "completed",
                        models.HrSignRequest.completed_at >= since_iso,
                        (models.HrSignRequest.created_by == email) |
                        (models.HrSignRequest.id.in_(my_party_reqs))).all()):
        rows.append({
            "title": f"Fully executed: {req.title}",
            "detail": "Completed",
            "url": f"{app_url()}{_ESIGN_URL}",
            "module": "documents",
        })
    return rows


def _red_rows(db: Session, email: str, my_reports: dict) -> list:
    rows = []
    # Filtered in Python rather than SQL: assignee_emails is a JSON list and
    # there is no containment predicate that works on both SQLite and Postgres.
    # The pre-filter keeps the scan to pending approvals only.
    for t in [x for x in db.query(models.Task)
              .filter(models.Task.type == "approval",
                      models.Task.approval_status == "pending").all()
              if email in task_assignees(x)]:
        rows.append({
            "title": f"Approve: {t.title}",
            "detail": "Waiting on your decision",
            "url": f"{app_url()}/tasks/mine?task={t.id}",
            "module": "tasks", "task_id": t.id,
            # One decision, no photo/picker required - safe to act on straight
            # from the email (via the confirm page, not a bare GET - see
            # briefing_mail_actions.py for why).
            "action_kind": "task_approval", "action_id": t.id, "action_email": email,
        })
    if my_reports:
        # One card per employee, not one per request - a person with several
        # pending requests (e.g. two separate vacation windows) used to get a
        # separate card each, which made the same "Approve X's time off" line
        # repeat and drowned out the rest of the section (Pranshu, Sep 15).
        by_employee = {}
        for r in (db.query(models.TimeOffRequest)
                  .filter(models.TimeOffRequest.status == "pending",
                          models.TimeOffRequest.employee_email.in_(list(my_reports))).all()):
            by_employee.setdefault((r.employee_email or "").lower(), []).append(r)
        for emp_email, reqs in by_employee.items():
            emp = my_reports.get(emp_email)
            name = f"{emp.first_name} {emp.last_name}".strip() if emp else emp_email
            reqs.sort(key=lambda r: r.start_date)
            if len(reqs) == 1:
                r = reqs[0]
                rows.append({
                    "title": f"Approve: {name}'s time off ({r.type})",
                    "detail": f"{_fmt_date(r.start_date)} - {_fmt_date(r.end_date)}",
                    "url": f"{app_url()}/timeclock",
                    "module": "time_off",
                    # Only a single, unambiguous request gets a one-click
                    # decision - a bundled card (below) covers several requests
                    # at once and there is no single Approve to bind the link to.
                    "action_kind": "timeoff_approval", "action_id": r.id, "action_email": email,
                })
            else:
                types = {r.type for r in reqs}
                same_type = next(iter(types)) if len(types) == 1 else None
                label = f"({same_type})" if same_type else f"({len(reqs)} requests)"
                rows.append({
                    "title": f"Approve: {name}'s time off {label}",
                    "detail": f"{len(reqs)} pending requests - decide each below",
                    "url": f"{app_url()}/timeclock",
                    "module": "time_off",
                    # A bundled card still gets one-click actions - just one
                    # Approve/Reject pair PER request instead of a single
                    # ambiguous pair for the whole card (Pranshu, Sep 20 - the
                    # Sep 15 "one card per employee" change accidentally also
                    # dropped the one-click actions along with the repetition).
                    "sub_actions": [{
                        "detail": f"{_fmt_date(r.start_date)} - {_fmt_date(r.end_date)}" +
                                  ("" if same_type else f" ({r.type})"),
                        "action_kind": "timeoff_approval", "action_id": r.id, "action_email": email,
                    } for r in reqs],
                })
    rows.extend(_timecard_rows(db, email))
    rows.extend(_item_action_rows(db, email, bool(my_reports)))
    rows.extend(_ticket_action_rows(db, email))
    rows.extend(_esign_action_rows(db, email))
    return rows


def _timecard_rows(db: Session, email: str) -> list:
    """Pay-period reminders (Neil, 8/21: 'we want to make sure you get paid on
    time. You need to do this.'). Reuses the SAME period math + sign-off state
    the Time module's own timecard header uses - no fresh TimePunch/TimeApproval
    query, just the existing _pay_type/_pay_period/_month_bounds/_signoff_state
    (routers/timeclock.py). Auto-drafting an actual contractor invoice (Neil's
    India idea) is a separate feature with no existing hook to build on - out
    of scope here; this is the reminder half only."""
    from routers.timeclock import _pay_type, _pay_period, _month_bounds, _signoff_state, _employee_today
    today = _employee_today(db, email)
    start, end = (_month_bounds(today) if _pay_type(db, email) == "fixed" else _pay_period(today))
    end_d = datetime.strptime(end, "%Y-%m-%d").date()
    today_d = datetime.strptime(today, "%Y-%m-%d").date()
    days_to_close = (end_d - today_d).days

    state = _signoff_state(db, email, start, end)
    signed = state["signed"]
    needs_action = signed is None or signed["stale"]
    if not needs_action:
        return []
    if 0 <= days_to_close <= 2:
        return [{"title": "Confirm your time card",
                 "detail": f"Pay period closes {end} - review and sign off before it locks",
                 "url": f"{app_url()}/timeclock", "module": "timecard"}]
    if days_to_close == -1:
        return [{"title": "Submit your time card",
                 "detail": f"Pay period ending {end} is closed - sign off is still open",
                 "url": f"{app_url()}/timeclock", "module": "timecard"}]
    return []


def _item_needs_to_know_rows(db: Session, email: str, since_iso: str, is_manager: bool) -> list:
    rows = []
    items_url = f"{app_url()}/itemmanagement"
    for c in (db.query(models.ItemCheckout)
              .filter(models.ItemCheckout.status.in_(["approved", "rejected"]),
                      models.ItemCheckout.resolved_at >= since_iso,
                      models.ItemCheckout.requested_by_email == email).all()):
        rows.append({"title": f"Checkout {c.status}: {c.item_name}",
                     "detail": c.reject_reason if c.status == "rejected" else "Awaiting handover",
                     "url": items_url, "module": "items"})
    if is_manager:
        # No fixed approver field for a return confirmation - items.py's
        # perm_return notification broadcasts the same way (recipient="").
        for a in (db.query(models.ItemAssignment)
                  .filter(models.ItemAssignment.status == "return_initiated").all()):
            rows.append({"title": f"Return pending confirmation: {a.item_name}",
                         "detail": f"{a.assignee_name or a.assignee_email} initiated a return",
                         "url": items_url, "module": "items"})
    return rows


_TASK_COMMENT_PREVIEW_COUNT = 3
_TASK_COMMENT_PREVIEW_CHARS = 180


def _attach_task_comment_previews(db: Session, rows: list) -> None:
    """Mutates each tasks-module row in place, adding a "comments" list of its
    last 3 comments (Sep 23, Pranshu: "the comments made on that particular
    task should be visible in daily brief mail... last 3 comments"). Runs
    regardless of WHY the task made it into this section - a task showing up
    because of a status change still gets its recent comments attached, not
    just one that showed up because of a comment - so the reader gets real
    context instead of just "added a comment" with no content. One batched
    query for all rows' comments, one batched query for author display
    names, rather than a per-row round trip."""
    task_ids = {r["task_id"] for r in rows if r.get("task_id")}
    if not task_ids:
        return
    comments = (db.query(models.TaskComment)
                .filter(models.TaskComment.task_id.in_(task_ids), models.TaskComment.internal == False)  # noqa: E712
                .order_by(models.TaskComment.created_at.desc()).all())
    by_task: dict = {}
    for c in comments:
        bucket = by_task.setdefault(c.task_id, [])
        if len(bucket) < _TASK_COMMENT_PREVIEW_COUNT:
            bucket.append(c)
    author_emails = {c.author_email.lower() for c in comments if c.author_email}
    names = {}
    if author_emails:
        for e in db.query(models.NexusEmployee).filter(func.lower(models.NexusEmployee.work_email).in_(author_emails)).all():
            names[(e.work_email or "").lower()] = f"{e.first_name} {e.last_name}".strip()
    for r in rows:
        bucket = by_task.get(r.get("task_id") or "")
        if not bucket:
            continue
        r["comments"] = [{
            "author": names.get((c.author_email or "").lower()) or c.author_email or "Someone",
            # A comment's body is rich HTML (the editor wraps every line in
            # <p>, same shape task_mail_actions.comment_html produces) - raw-
            # truncating it left the literal "<p>...</p>" tags visible in the
            # email (Sep 23 screenshot). task_mail_actions._plain already
            # exists for exactly this - HTML -> plain text for a text-only
            # summary - so reuse it instead of a second strip-tags implementation.
            "body": task_mail_actions._plain(c.body or "", _TASK_COMMENT_PREVIEW_CHARS),
        } for c in bucket]


def _amber_rows(db: Session, email: str, since_iso: str, my_reports: dict) -> list:
    activity = (db.query(models.TaskActivity)
                .filter(models.TaskActivity.entity_kind == "task",
                        models.TaskActivity.at >= since_iso)
                .order_by(models.TaskActivity.at.desc())
                .limit(500).all())
    task_ids = {a.entity_id for a in activity}
    tasks = {t.id: t for t in db.query(models.Task).filter(models.Task.id.in_(task_ids)).all()} if task_ids else {}
    rows, seen_tasks = [], set()
    for a in activity:
        t = tasks.get(a.entity_id)
        if not t or t.id in seen_tasks:
            continue
        if email.lower() not in _collaborator_emails(t) or (a.actor_email or "").lower() == email.lower():
            continue
        seen_tasks.add(t.id)
        rows.append({
            "title": f"{t.code or 'Task'} - {a.entity_title or t.title}",
            "detail": a.detail or a.type,
            "url": f"{app_url()}/tasks/mine?task={t.id}",
            "module": "tasks", "task_id": t.id, "action_email": email,
            # Open task, not yet a decided approval or already-closed-out row -
            # the one place "act on it" plausibly means change status/complete
            # it, not just comment/react. Approval rows have their own
            # Approve/Reject; a completed row needs neither.
            "task_open": not bool(t.completed),
        })
    _attach_task_comment_previews(db, rows)
    rows.extend(_item_needs_to_know_rows(db, email, since_iso, bool(my_reports)))
    rows.extend(_ticket_needs_to_know_rows(db, email, since_iso))
    rows.extend(_esign_needs_to_know_rows(db, email, since_iso))
    rows.extend(_manager_task_completion_rows(db, email, since_iso, my_reports))
    return rows


def _item_completed_rows(db: Session, email: str, since_iso: str) -> list:
    rows = []
    items_url = f"{app_url()}/itemmanagement"
    for c in (db.query(models.ItemCheckout)
              .filter(models.ItemCheckout.status == "returned",
                      models.ItemCheckout.returned_at >= since_iso,
                      models.ItemCheckout.requested_by_email == email).all()):
        rows.append({"title": f"{c.item_name} returned", "detail": "Checkout closed out",
                     "url": items_url, "module": "items"})
    for a in (db.query(models.ItemAssignment)
              .filter(models.ItemAssignment.status == "closed",
                      models.ItemAssignment.return_accepted_at >= since_iso,
                      (models.ItemAssignment.assignee_email == email) |
                      (models.ItemAssignment.assigned_by_email == email)).all()):
        rows.append({"title": f"{a.item_name} assignment closed", "detail": "Return accepted",
                     "url": items_url, "module": "items"})
    return rows


def _green_rows(db: Session, email: str, since_iso: str) -> list:
    rows = []
    # Completed is "you did this" - only the person actually ASSIGNED the task
    # belongs here (Pranshu, Sep 21). An owner/follower who never did the work
    # is still a collaborator and still needs to know it's done, but that's an
    # FYI, not their own accomplishment - _amber_rows' own activity-feed loop
    # already covers them (a "completed" TaskActivity fires there for every
    # non-actor collaborator), so nothing extra is needed here for that case.
    for t in (db.query(models.Task)
              .filter(models.Task.completed == True,  # noqa: E712
                      models.Task.completed_at >= since_iso).all()):
        if email.lower() not in task_assignees(t):
            continue
        rows.append({
            "title": f"{t.code or 'Task'} - {t.title}",
            "detail": "Completed",
            "url": f"{app_url()}/tasks/mine?task={t.id}",
            "module": "tasks", "task_id": t.id, "action_email": email,
        })
    rows.extend(_item_completed_rows(db, email, since_iso))
    rows.extend(_ticket_completed_rows(db, email, since_iso))
    rows.extend(_esign_completed_rows(db, email, since_iso))
    return rows


def _manager_task_completion_rows(db: Session, email: str, since_iso: str, my_reports: dict) -> list:
    """A manager gets ONE card per direct report summarizing everything that
    report finished since the manager's last briefing - not one row per task
    (Pranshu, Sep 21: "suppose Aarav completed 5 tasks today it should not
    come in large rows"). Mirrors the same "one card per employee" bundling
    _red_rows already does for a report's pending time-off requests. The
    manager just needs to know it happened, not act on each one, so this is
    plain text (titles capped, "+N more" past that) rather than the module
    accordion's own per-card cap - that cap only kicks in ACROSS separate
    cards, and one card per report is already the compact form here."""
    if not my_reports:
        return []
    report_emails = set(my_reports)
    by_report: dict = {}
    for t in (db.query(models.Task)
              .filter(models.Task.completed == True,  # noqa: E712
                      models.Task.completed_at >= since_iso).all()):
        for rep in set(task_assignees(t)) & report_emails:
            by_report.setdefault(rep, []).append(t)
    rows = []
    for rep_email, tasks in by_report.items():
        emp = my_reports.get(rep_email)
        name = f"{emp.first_name} {emp.last_name}".strip() if emp else rep_email
        titles = [f"{t.code or 'Task'} - {t.title}" for t in tasks]
        shown, hidden = titles[:3], titles[3:]
        detail = "; ".join(shown) + (f"; and {len(hidden)} more" if hidden else "")
        n = len(tasks)
        rows.append({
            "title": f"{name} completed {n} task{'' if n == 1 else 's'}",
            "detail": detail,
            "url": f"{app_url()}/tasks/mine?task={tasks[0].id}",
            "module": "tasks",
        })
    return rows


def _blue_rows_manager(db: Session, email: str, my_reports: dict, briefing_date: str) -> list:
    """Manager add-on only - direct reports out today, plus the day-before
    nudge for anyone whose leave STARTS tomorrow (Neil, 8/21: 'I want the
    e-mail on the prior today').

    Anchored on `briefing_date` - the SAME shift-local "today" _trigger_due
    already worked out for this manager - not the server process's own
    date.today() (Sep 22 fix). Those two dates can legitimately differ: a
    manager whose trigger time (shift start minus 2.5h) falls in their own
    early-morning hours can have a local calendar date that's already rolled
    over relative to the container's UTC clock, which silently shifted this
    whole check by a day for exactly the shift-timezone edge cases
    _trigger_due was built to handle in the first place."""
    reports = list(my_reports.values())
    if not reports:
        return []
    report_emails = {e.work_email for e in reports if e.work_email}
    if not report_emails:
        return []
    names = {e.work_email: f"{e.first_name} {e.last_name}".strip() for e in reports}
    today = briefing_date
    tomorrow = (datetime.strptime(briefing_date, "%Y-%m-%d").date() + timedelta(days=1)).isoformat()
    rows = []
    for r in (db.query(models.TimeOffRequest)
              .filter(models.TimeOffRequest.employee_email.in_(report_emails),
                      models.TimeOffRequest.status == "approved",
                      models.TimeOffRequest.start_date <= today,
                      models.TimeOffRequest.end_date >= today).all()):
        rows.append({
            "title": f"Out today: {names.get(r.employee_email, r.employee_email)} ({r.type})",
            "detail": f"Back {r.end_date}",
            "url": "", "module": "team",
        })
    for r in (db.query(models.TimeOffRequest)
              .filter(models.TimeOffRequest.employee_email.in_(report_emails),
                      models.TimeOffRequest.status == "approved",
                      models.TimeOffRequest.start_date == tomorrow).all()):
        rows.append({
            "title": f"Starting leave tomorrow: {names.get(r.employee_email, r.employee_email)}",
            "detail": f"{r.start_date} - {r.end_date}. Reassign anything time-sensitive today.",
            "url": "", "module": "team",
        })
    return rows


def build_sections(db: Session, email: str, since_iso: str, briefing_date: str) -> dict:
    my_reports = {(e.work_email or "").lower(): e for e in
                  db.query(models.NexusEmployee)
                  .filter(func.lower(models.NexusEmployee.manager_email) == email.lower()).all()}
    sections = {
        "action_required": _red_rows(db, email, my_reports),
        "needs_to_know":   _amber_rows(db, email, since_iso, my_reports) + _blue_rows_manager(db, email, my_reports, briefing_date),
        "completed":       _green_rows(db, email, since_iso),
    }
    return {k: v for k, v in sections.items() if v}


# ── Render (email-safe: inline styles, Segoe UI stack, table layout) ──────
#
# Sep 15 redesign (Pranshu: "use full screen, make it more attractive and
# responsive"). Two changes, kept email-client-safe:
#   - The outer table is now fluid (width:100% up to a wider 680px cap, not a
#     fixed 600px box) so it fills a phone screen edge-to-edge instead of
#     leaving the old fixed-width box floating with side gutters.
#   - A <style> block adds @media breakpoint tweaks (tighter padding, stacked
#     stat chips, full-width buttons) for clients that honor it (Gmail app/
#     web, Apple Mail, Outlook mobile/web). It is a pure enhancement layer -
#     Outlook desktop's Word engine ignores @media and <style> silently, and
#     the fluid table + inline styles underneath already look correct there
#     without it, so nothing depends on the media query firing.
_BADGE = {
    # Accent colors matched to Nexus Sign's own palette (routers/esign.py
    # _sign_email_html: header #14532d, button #15803d) so the two email
    # families read as one brand - and darkened for red/amber to match that
    # green's weight, rather than the lighter/muted tones this started with
    # (Pranshu, Sep 21).
    "action_required": ("Action required",                    "#b91c1c", "#faece9", "\U0001F534"),
    "needs_to_know":   ("Needs to know",                       "#b45309", "#faf1de", "\U0001F440"),
    "completed":       ("Completed since your last briefing",  "#15803d", "#e9f5ec", "✅"),
}
_ORDER = ["action_required", "needs_to_know", "completed"]
_SUMMARY_NOUN = {"action_required": "need your approval", "needs_to_know": "updates to check", "completed": "completed"}

# Module accordion (Pranshu, Sep 19 - "the list is too long to see and work,
# segregate into their module and collapse it"). One person's Action Required
# used to render 10 flat cards; grouping by module and collapsing each behind
# its own header lets you see the shape of the day (3 items, 3 tasks, 3 time
# off) before opening any of it.
_MODULE_META = {
    "tasks":    "Tasks",
    "tickets":  "Tickets",
    "documents": "Documents",
    "time_off": "Time Off",
    "timecard": "Time Card",
    "items":    "Items",
    "team":     "Team",
}
_MODULE_ORDER = ["tasks", "tickets", "documents", "time_off", "timecard", "items", "team"]
# A "view all" fallback per module for the "+N more" link (Pranshu, Sep 20 -
# true click-to-expand only works in clients that honor the checkbox-hack CSS
# (see _module_group_html); Outlook desktop's Word engine never will, and
# there is no JS-free way around that. A plain HTML cap+link works identically
# in every client instead, so it is the actual fix for "the list is too long"
# rather than a client-dependent nicety.
_MODULE_VIEW_URL = {
    "tasks": "/tasks/mine", "tickets": "/tickets", "documents": _ESIGN_URL,
    "time_off": "/timeclock", "timecard": "/timeclock", "items": "/itemmanagement",
}
_MODULE_CARD_CAP = 3
# Distinct titles shown in a module's "+N more" list before IT ALSO collapses
# to a "+K more distinct" line - a second, independent cap so a project with
# many genuinely different overflow items (not just duplicates of the same
# title) still can't make one email unboundedly long.
_OVERFLOW_GROUP_CAP = 15


def _sub_action_html(accent: str, sub: dict) -> str:
    """One request's own Approve/Reject pair inside a bundled card (e.g. an
    employee with several pending time-off requests) - each request still
    gets a one-click decision, just scoped to that row instead of the whole
    card (Pranshu, Sep 20)."""
    sbtn = ("display:inline-block;padding:4px 10px;border-radius:16px;"
            "font-size:11px;font-weight:700;text-decoration:none;margin:0 6px 0 0;")
    approve_url = briefing_mail_actions.action_url(sub["action_kind"], sub["action_id"], "approve", sub["action_email"])
    reject_url = briefing_mail_actions.action_url(sub["action_kind"], sub["action_id"], "reject", sub["action_email"])
    return f"""
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;
          border-top:1px solid rgba(0,0,0,.06);padding:7px 0;margin-top:2px">
          <span style="font-size:12.5px;color:#3a463e">{escape(sub['detail'])}</span>
          <span>
            <a href='{escape(approve_url)}' style='{sbtn}background:#15803d;color:#ffffff'>Approve</a>
            <a href='{escape(reject_url)}' style='{sbtn}background:#ffffff;color:#6b6b6b;border:1px solid #d8ddd6'>Reject</a>
          </span>
        </div>"""


def _card_html(color: str, row: dict) -> str:
    _, accent, tint, _icon = _BADGE[color]
    btn = ("display:inline-block;padding:7px 14px;border-radius:20px;"
           "font-size:12px;font-weight:700;text-decoration:none;margin:0 6px 6px 0;")
    buttons = []
    if row.get("action_kind"):
        # Two links, one per decision - NOT a single link that mutates on GET.
        # Email link scanners (Outlook Safe Links, Gmail) prefetch every URL in
        # a message; a bare GET that approved/rejected would fire from the scan
        # itself, not the person. Each link instead opens a one-tap confirm
        # page (routers/briefing_actions.py) that only acts on its own POST -
        # the same pattern task_mail_actions.py already uses for task emails.
        approve_url = briefing_mail_actions.action_url(row["action_kind"], row["action_id"], "approve", row["action_email"])
        reject_url = briefing_mail_actions.action_url(row["action_kind"], row["action_id"], "reject", row["action_email"])
        buttons.append(f"<a href='{escape(approve_url)}' class='nx-btn' "
                        f"style='{btn}background:#15803d;color:#ffffff'>Approve</a>")
        buttons.append(f"<a href='{escape(reject_url)}' class='nx-btn' "
                        f"style='{btn}background:#ffffff;color:#6b6b6b;border:1px solid #d8ddd6'>Reject</a>")
    if row.get("task_id"):
        # Same buttons Nexus itself shows on a task - Comment and React -
        # reusing task_mail_actions.py's already-shipped token + confirm page
        # (routers/mail_actions.py) wholesale rather than a second copy: one
        # token per (task, recipient), do=comment/react picks the form.
        tok = task_mail_actions.sign_token(row["task_id"], row.get("action_email", ""))
        base = f"{task_mail_actions.api_base()}/mail-actions/page?token={tok}"
        buttons.append(f"<a href='{escape(base)}&do=comment' class='nx-btn' "
                        f"style='{btn}background:#ffffff;color:#374151;border:1px solid #d8ddd6'>&#128172; Comment</a>")
        buttons.append(f"<a href='{escape(base)}&do=react' class='nx-btn' "
                        f"style='{btn}background:#ffffff;color:#374151;border:1px solid #d8ddd6'>&#128512; React</a>")
        if row.get("task_open"):
            # Full parity with the task card in Nexus, not just an FYI link -
            # same do=status/complete the task notification email already
            # ships, same token, no new endpoint.
            buttons.append(f"<a href='{escape(base)}&do=status' class='nx-btn' "
                            f"style='{btn}background:#ffffff;color:#374151;border:1px solid #d8ddd6'>Change Status</a>")
            buttons.append(f"<a href='{escape(base)}&do=complete' class='nx-btn' "
                            f"style='{btn}background:#ffffff;color:#374151;border:1px solid #d8ddd6'>Mark Complete</a>")
    if row.get("url"):
        buttons.append(f"<a href='{escape(row['url'])}' class='nx-btn' "
                        f"style='{btn}background:{accent};color:#ffffff'>Open in Nexus &rarr;</a>")
    link = f"<div style='margin-top:10px'>{''.join(buttons)}</div>" if buttons else ""
    sub_rows = "".join(_sub_action_html(accent, s) for s in row.get("sub_actions") or [])
    # Last 3 comments (Sep 23, Pranshu: "the comments made on that particular
    # task should be visible in daily brief mail") - _attach_task_comment_previews
    # already capped/truncated these, so this is display-only. Newest first,
    # matching the rest of the digest's own "most recent first" convention.
    comments_html = ""
    if row.get("comments"):
        lines = "".join(
            f"<div style='padding:4px 0;border-top:1px solid rgba(0,0,0,.08);font-size:12px;color:#3a463e;"
            f"line-height:1.4'><b>{escape(c['author'])}:</b> {escape(c['body'])}</div>"
            for c in row["comments"]
        )
        comments_html = f"<div style='margin-top:8px'>{lines}</div>"
    return f"""
        <div style="background:{tint};border-left:3px solid {accent};border-radius:10px;padding:14px 16px;margin-bottom:10px">
          <div style="font-size:14.5px;font-weight:700;color:#26312a;line-height:1.35">{escape(row['title'])}</div>
          <div style="font-size:12.5px;color:#5c6a60;margin-top:3px;line-height:1.45">{escape(row['detail'])}</div>
          {comments_html}
          {sub_rows}
          {link}
        </div>"""


def _group_by_module(rows: list) -> list:
    """[(module_key, label, rows), ...] in _MODULE_ORDER, any untagged module
    appended after in first-seen order so it still renders rather than vanish."""
    buckets: dict = {}
    for r in rows:
        buckets.setdefault(r.get("module") or "other", []).append(r)
    order = [m for m in _MODULE_ORDER if m in buckets] + [m for m in buckets if m not in _MODULE_ORDER]
    return [(m, _MODULE_META.get(m, m.replace("_", " ").title()), buckets[m]) for m in order]


def _module_group_html(color: str, group_id: str, module: str, label: str, rows: list) -> str:
    _, accent, _tint, _icon = _BADGE[color]
    shown, hidden = rows[:_MODULE_CARD_CAP], rows[_MODULE_CARD_CAP:]
    cards = "".join(_card_html(color, r) for r in shown)
    if hidden:
        # Plain lines, not another accordion layer - this is the part that has
        # to work identically in every client, so it cannot depend on CSS the
        # way the outer toggle below does. But a bare "+N more -> Open in
        # Nexus" told the reader nothing about what those N things actually
        # WERE before making them leave the email to find out (Pranshu, Sep
        # 21) - listing the titles as plain text needs no interactivity at
        # all, so it's exactly as universal as the link itself.
        #
        # Sep 22 redesign, after a duplicate-task data bug (two Asana-pull
        # workers racing on the same recurring series, see routers/tasks.py's
        # _next_code fix) put ~15 rows all reading the identical title into
        # one briefing: the OLD version joined every hidden row into a single
        # semicolon-separated run-on paragraph, which made a genuine data bug
        # look even worse than it was and was unreadable regardless of cause.
        # Now: (1) rows are grouped by exact title first, so N rows sharing
        # one title become ONE line with a "x N" count, not N repeats - this
        # helps even before anyone runs the sync-dedupe cleanup, and keeps
        # helping afterward for a genuinely busy recurring series; (2) each
        # remaining group gets its OWN line, not folded into one paragraph;
        # (3) the group LIST ITSELF is capped, so a single flooded project
        # can never make one email unboundedly long even in the worst case.
        more_url = (shown[0].get("url") if shown else "") or f"{app_url()}{_MODULE_VIEW_URL.get(module, '')}"
        groups: dict = {}
        for r in hidden:
            g = groups.setdefault(r["title"], {"count": 0, "url": r.get("url") or ""})
            g["count"] += 1
        by_title = list(groups.items())
        listed, overflow = by_title[:_OVERFLOW_GROUP_CAP], by_title[_OVERFLOW_GROUP_CAP:]
        lines = []
        for title, g in listed:
            count_tag = f" <span style='color:#8a9389'>&times;{g['count']}</span>" if g["count"] > 1 else ""
            open_link = (f" &mdash; <a href='{escape(g['url'])}' style='font-weight:700;color:{accent};"
                         f"text-decoration:none'>Open &rarr;</a>") if g["url"] else ""
            lines.append(f"<div style='padding:2px 0'>{escape(title)}{count_tag}{open_link}</div>")
        if overflow:
            overflow_total = sum(g["count"] for _, g in overflow)
            lines.append(f"<div style='padding:2px 0;color:#8a9389'>+{len(overflow)} more distinct "
                         f"({overflow_total} total)</div>")
        cards += (f"<div style='margin:4px 0 10px;font-size:12.5px;color:#5c6a60;line-height:1.6'>"
                  f"<div style='font-weight:700;color:#26312a;margin-bottom:3px'>+{len(hidden)} more:</div>"
                  f"{''.join(lines)}"
                  f"<a href='{escape(more_url)}' style='font-weight:700;color:{accent};text-decoration:none;"
                  f"display:inline-block;margin-top:4px'>Open in Nexus &rarr;</a></div>")
    cid = f"nx-acc-{escape(group_id)}"
    # Checkbox-hack accordion, collapsed by default via the .nx-acc CSS rules
    # below. The content div's OWN inline style is display:block (visible) -
    # a client that ignores the sibling-selector CSS entirely (Outlook
    # desktop's Word engine, same gap the @media block above already accepts)
    # just shows every module expanded instead of hiding action items behind
    # a toggle that can never be clicked. Nothing here depends on the CSS
    # firing; it only makes a supporting client more compact. The cap above
    # (not this toggle) is what actually keeps a long list short everywhere.
    #
    # `mso-hide:all` alongside display:none (Pranshu, Sep 22 - screenshot from
    # Outlook classic): plain display:none does NOT hide an <input> from
    # Word's rendering engine - it rendered the checkbox as a literal "[ ]"
    # sitting in front of every badge/module header, not just failing open to
    # expanded. mso-hide:all is the actual Outlook-specific directive for
    # "don't render this element at all"; every other client ignores an
    # unrecognized mso-* property and still sees the ordinary display:none.
    return f"""
        <input type="checkbox" id="{cid}" class="nx-acc" style="display:none;mso-hide:all">
        <label for="{cid}" class="nx-acc-label" style="display:block;cursor:pointer;padding:9px 12px;
          margin:10px 0 6px;background:#f4f6f3;border-radius:8px;font-size:13px;font-weight:700;color:#26312a">
          <span style="float:right;color:{accent};transition:transform .15s" class="nx-arrow">&#9656;</span>
          {escape(label)} <span style="font-weight:400;color:#5c6a60">({len(rows)})</span>
        </label>
        <div class="nx-content" style="display:block">{cards}</div>"""


def _section_html(color: str, rows: list) -> str:
    label, accent, _tint, icon = _BADGE[color]
    badge = (f"<span style='display:inline-block;padding:6px 12px;border-radius:20px;background:{accent};"
             f"color:#ffffff;font-family:\"Segoe UI\",Arial,sans-serif;font-size:11.5px;letter-spacing:.02em;"
             f"font-weight:700'>{icon} {escape(label)}</span>")
    groups = _group_by_module(rows)
    body = "".join(_module_group_html(color, f"{color}-{m}", m, glabel, grows) for m, glabel, grows in groups)
    sid = f"nx-sec-{color}"
    # Same checkbox-hack accordion as _module_group_html, one level up - the
    # whole section (not just each module inside it) starts collapsed in a
    # client that honors the CSS, and safely stays expanded (never stuck
    # hidden) in one that doesn't, like Outlook desktop classic (Pranshu,
    # Sep 20: "the sections... should be collapsed - it should only expand
    # if user clicks on it"). Reuses the exact same .nx-acc/.nx-content CSS
    # rules - nested accordions each match only their own immediate
    # siblings, so the module-level toggles inside still work independently -
    # including the mso-hide:all fix (see _module_group_html) so this
    # checkbox doesn't render as a literal "[ ]" in Outlook either.
    #
    # Outlook desktop classic (Word engine) never runs that CSS though, so it
    # always falls back to fully expanded - badge, every module header, every
    # card, all in a row with nothing marking where one section ends and the
    # next begins (Pranshu, Sep 21: "confusing for end user"). A single bordered
    # card AROUND the whole section - white, not the same tint the individual
    # cards use inside it, so they still stand out against it - makes each
    # section read as one visual chunk regardless of whether the accordion CSS
    # fires, the same fallback-safe reasoning as the module cap's plain-text
    # "+N more" line above.
    return f"""
      <tr><td class="nx-pad" style="padding:12px 32px">
        <div style="background:#ffffff;border:1px solid #e2e5df;border-left:4px solid {accent};
          border-radius:14px;padding:16px 18px 6px">
          <input type="checkbox" id="{sid}" class="nx-acc" style="display:none;mso-hide:all">
          <label for="{sid}" class="nx-acc-label" style="display:block;cursor:pointer;margin-bottom:12px">
            {badge}
            <span style="float:right;color:{accent};font-size:15px;transition:transform .15s" class="nx-arrow">&#9656;</span>
          </label>
          <div class="nx-content" style="display:block">{body}</div>
        </div>
      </td></tr>"""


def _stat_chip_html(count: int, noun: str) -> str:
    return (f"<td class='nx-chip' style='padding:0 6px 8px 0'>"
            f"<div style='background:#f4f6f3;border-radius:20px;padding:6px 13px;font-size:12.5px;color:#3a463e;"
            f"white-space:nowrap'><b style='color:#173328'>{count}</b> {escape(noun)}</div></td>")


def render_email(employee_name: str, briefing_date: str, sections: dict, recipient: str = "") -> tuple:
    _d = datetime.strptime(briefing_date, "%Y-%m-%d")
    weekday_date = f"{_d.strftime('%A, %B')} {_d.day}"  # avoid %-d/%#d (platform-specific strftime flags)
    chips = "".join(_stat_chip_html(len(sections[c]), _SUMMARY_NOUN[c]) for c in _ORDER if sections.get(c))
    counts_row = (f"<table cellpadding='0' cellspacing='0'><tr>{chips}</tr></table>"
                  if chips else "<div style='font-size:13px;color:#5c6a60'>Nothing new since your last briefing</div>")
    body_sections = "".join(_section_html(c, sections[c]) for c in _ORDER if sections.get(c))
    subject = f"Your Daily Briefing - {weekday_date}"
    html = f"""<div style="background:#eef1ee;padding:32px 14px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <style>
    /* Module accordion - collapsed by default; label click checks the hidden
       box and reveals its .nx-content sibling. A client that does not apply
       this block at all (see _module_group_html) leaves every module visibly
       expanded instead, which is the safe direction to fail in. */
    .nx-acc:not(:checked) ~ .nx-content {{ display:none !important; }}
    .nx-acc:checked ~ .nx-content {{ display:block !important; }}
    .nx-acc:checked + .nx-acc-label .nx-arrow {{ transform:rotate(90deg); }}
    @media (max-width:520px) {{
      .nx-wrap {{ border-radius:0 !important; border-left:0 !important; border-right:0 !important; }}
      .nx-pad {{ padding-left:20px !important; padding-right:20px !important; }}
      .nx-hero {{ padding-left:20px !important; padding-right:20px !important; }}
      .nx-btn {{ display:block !important; text-align:center !important; margin:0 0 8px !important; }}
      .nx-chip {{ display:block !important; padding-right:0 !important; }}
      .nx-chip > div {{ display:inline-block; }}
    }}
  </style>
  <table class="nx-wrap" align="center" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:#ffffff;border-radius:18px;border:1px solid #e2e5df;border-collapse:separate;overflow:hidden">
    <tr>
      <td class="nx-hero" style="background:#173328;background-image:linear-gradient(135deg,#173328,#1e4d38);padding:26px 32px">
        <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#8fd3ac;font-weight:700">&#9670; NEXUS</div>
        <div style="color:#ffffff;font-size:23px;font-weight:700;margin-top:9px">Your Daily Briefing</div>
        <div style="color:#b7d8c6;font-size:13.5px;margin-top:4px">{escape(weekday_date)}</div>
      </td>
    </tr>
    <tr><td class="nx-pad" style="padding:18px 32px;border-bottom:1px solid #eef0ec">{counts_row}</td></tr>
    <tr><td class="nx-pad" style="padding:20px 32px 0;font-size:14.5px;color:#5c6a60">Good morning{', ' + escape(employee_name) if employee_name else ''}. Here's everything since your last briefing - sign in only if you need the full detail.</td></tr>
    {body_sections}
    <tr>
      <td class="nx-pad" style="padding:26px 32px 30px;margin-top:6px;border-top:1px solid #eef0ec">
        <p style="font-size:11.5px;color:#95a096;margin:0 0 14px;line-height:1.5">This briefing replaces individual task/HR notification emails. Anything genuinely blocking still reaches you instantly on Teams.</p>
        <a href="{escape(app_url())}" class="nx-btn" style="display:inline-block;padding:11px 22px;border-radius:22px;background:#173328;color:#ffffff;text-decoration:none;font-weight:700;font-size:13px">Open Nexus &rarr;</a>
      </td>
    </tr>
  </table>
</div>"""
    # Outlook Actionable Message card (Sep 23, Pranshu: "how to set this
    # actionable buttons working for daily briefing mail") - one consolidated
    # card for the whole Action Required section (briefing_mail_actions.
    # build_card), embedded the same way task_mail_actions.decorate() does
    # for task emails. hideOriginalBody is False in that card, so the plain
    # HTML above still renders underneath in clients that show both - only
    # gated on recipient/am_enabled/having anything actionable at all, so an
    # unregistered deployment or an empty Action Required section never pays
    # for a card nobody will see.
    if recipient and task_mail_actions.am_enabled() and sections.get("action_required"):
        card = briefing_mail_actions.build_card(sections["action_required"], recipient)
        card_json = json.dumps(card, ensure_ascii=False).replace("</", "<\\/")
        html = ("<html><head><meta http-equiv='Content-Type' content='text/html; charset=utf-8'>"
                f"<script type='application/adaptivecard+json'>{card_json}</script>"
                f"</head><body>{html}</body></html>")
    return subject, html


# ── Send + scan ─────────────────────────────────────────────────────────

def _send_one(db: Session, emp: "models.NexusEmployee", cfg: dict, briefing_date: str) -> None:
    since_iso = ""
    last = _last_log(db, emp.work_email)
    if last and last.sent_at:
        since_iso = last.sent_at
    if not since_iso:
        since_iso = (datetime.now(timezone.utc) - timedelta(hours=LOOKBACK_HOURS_FIRST_RUN)).strftime("%Y-%m-%dT%H:%M:%S")

    sections = build_sections(db, emp.work_email, since_iso, briefing_date)
    name = f"{emp.first_name} {emp.last_name}".strip()
    subject, html = render_email(name, briefing_date, sections, emp.work_email)

    mode = cfg.get("mode", "off")
    sent_at = ""
    if mode in ("test", "live") and sections:
        to = [emp.work_email] if mode == "live" else list(cfg.get("test_recipients") or [])
        if mode == "test":
            subject = f"[TEST -> {emp.work_email}] {subject}"
        if to:
            try:
                graph_mail.send_mail(from_email=graph_mail.DEFAULT_FROM_EMAIL, to=to, cc=None,
                                      subject=subject, html=html)
                sent_at = _now_iso()
            except graph_mail.GraphMailError as e:
                print(f"[daily-briefing] send failed for {emp.work_email}: {e}")

    db.add(models.NexusDailyBriefingLog(
        id=str(uuid.uuid4()), employee_email=emp.work_email, briefing_date=briefing_date,
        sent_at=sent_at, mode=mode,
        # NexusDailyBriefingLog kept its 4-column shape from the old red/amber/
        # blue/green model rather than a migration - blue_count is unused now
        # that amber+blue merged into needs_to_know.
        red_count=len(sections.get("action_required", [])), amber_count=len(sections.get("needs_to_know", [])),
        blue_count=0, green_count=len(sections.get("completed", [])),
        created_at=_now_iso(),
    ))
    db.commit()


# Two-int-form Postgres advisory lock, its own keyspace entirely separate
# from asana_sync._acquire_pull_lock's single-bigint-form lock - the two can
# never collide regardless of which constants either module picks.
_BRIEFING_LOCK_NS = 918273645


def _acquire_employee_lock(db: Session, email: str) -> None:
    """Cross-process serialization for one employee's due-check + send +
    log-insert - a transaction-scoped Postgres advisory lock keyed per
    employee, auto-released on this transaction's commit/rollback so a
    killed worker can never leave it stuck. No-op on local SQLite, where
    there's only one process.

    Without this, two dev App Service workers scanning at the same instant
    can both pass _trigger_due's _already_logged_today check before either
    commits, and both send - confirmed in NexusDailyBriefingLog as several
    rows for the same employee/date sharing the exact same sentAt second
    (Pranshu, Sep 20 - "it happened a few times in earlier days also").

    CAST(:ns AS integer) is required, not decorative - psycopg2 sends a
    plain Python int as bigint, and Postgres then has no
    pg_advisory_xact_lock(bigint, integer) overload to resolve to (only
    (bigint) and (int, int) exist), which 500'd every call here in prod
    (Sep 20 - force_resend surfaced it immediately since it's the first
    caller to run outside the background loop's own tolerant error
    handling). CAST(... AS integer), not the :ns::int shorthand - SQLAlchemy
    text()'s own ":name" bind-parameter syntax collides with Postgres's ::
    cast operator when they're adjacent with no space, so :ns::int is a
    genuine SQL syntax error, not just a style choice (confirmed via the
    force_resend error-surfacing added right after the first attempt at
    this fix still 500'd)."""
    if db.bind.dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(CAST(:ns AS integer), hashtext(:email))"),
                   {"ns": _BRIEFING_LOCK_NS, "email": email})


def _scan_once() -> int:
    db = SessionLocal()
    sent = 0
    try:
        cfg = get_settings(db)
        employees = (db.query(models.NexusEmployee)
                     .filter(models.NexusEmployee.work_email != "").all())
        for emp in employees:
            try:
                # Each employee gets its own short transaction so the lock is
                # held only for this employee's check, not the whole scan -
                # _send_one's own commit releases it on the due path, the
                # explicit rollback below releases it on the not-due path.
                _acquire_employee_lock(db, emp.work_email)
                due, briefing_date, _ = _trigger_due(db, emp.work_email)
                if not due:
                    db.rollback()
                    continue
                _send_one(db, emp, cfg, briefing_date)
                sent += 1
            except Exception as e:
                db.rollback()
                print(f"[daily-briefing] scan failed for {emp.work_email}: {e}")
        return sent
    finally:
        db.close()


async def daily_briefing_loop():
    await asyncio.sleep(60)
    while True:
        try:
            n = await asyncio.to_thread(_scan_once)
            if n:
                print(f"[daily-briefing] scan complete - {n} briefing(s) logged")
        except Exception as e:
            print(f"[daily-briefing] loop error: {e}")
        await asyncio.sleep(SCAN_EVERY_SEC)
