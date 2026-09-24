"""Due-date accountability for tasks (Neil, Sep 24).

"I don't want to penalize Sagar for not finishing it, but he needs to realize
he's not meeting his own deadline - using data, not a random opinion of a
manager." Three pieces, all kept on the task row (see models.Task):

  • due_history - every move of due_on: who, when, from/to, and where it came
    from (the app, a bulk edit, Asana, or an accepted proposal). Nexus used to
    log status and assignee changes but never a due date, so an extension left
    no trace at all.
  • due_extension_count - how many of those moves pushed an AGREED date later.
    Setting the first date, moving it earlier, clearing it, or renegotiating a
    target the assignee never confirmed are not extensions. Counted whoever
    made the move; the history says who, so the badge is never a mystery.
  • due_agreement / due_proposal - the negotiation. The requester sets a
    target ("pending"); the assignee confirms it ("accepted") or proposes
    another date ("proposed"), which the requester accepts or declines. A date
    the assignee sets themselves is theirs by definition ("accepted").

Every due_on write in the app goes through record_due_change so the three can
never disagree. No emails are sent from here - the caller decides, because the
bulk and Asana paths must not mail anyone per row.
"""
from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy.orm import Session

import models
from routers.task_util import log_activity, now_iso, task_assignees, task_notify

AGREED = ("", "accepted")      # "" = legacy row, or a date nobody needs to confirm
SOURCES = ("app", "bulk", "asana", "proposal", "counter")
# Managers hear about a task on its 3rd extension, then every 3rd after that -
# "I would love to know that the task was extended 9 times" without a bell
# ping for every single push.
MANAGER_ALERT_EVERY = 3


def us_date(iso: str) -> str:
    """YYYY-MM-DD → MM/DD/YYYY (CLAUDE.md: US dates in anything a person reads)."""
    try:
        return date.fromisoformat((iso or "")[:10]).strftime("%m/%d/%Y")
    except ValueError:
        return iso or ""


def requester_of(t: models.Task) -> str:
    """Whoever asked for the work - the creator, else the owner. Asana-synced
    rows often have no creator, which is why owner is the fallback."""
    return ((t.created_by or t.owner_email or "")).strip().lower()


def _is_assignee(t: models.Task, email: str) -> bool:
    return bool(email) and email.strip().lower() in task_assignees(t)


def _log(db: Session, t: models.Task, type_: str, actor: str, detail: str) -> None:
    """Activity row + its id on the task, so it shows on the task's timeline.
    Callers that rebuild t.activity_ids from a local list must call into this
    module AFTER assigning that list, or the id is overwritten."""
    aid = log_activity(db, type=type_, actor_email=actor, entity_id=t.id, entity_code=t.code or "",
                       entity_title=t.title or "", detail=detail)
    t.activity_ids = list(t.activity_ids or []) + [aid]


def is_extension(t: models.Task, old: str, new: str, source: str) -> bool:
    """A later date replacing an agreed one. Read BEFORE the agreement moves."""
    old, new = (old or "")[:10], (new or "")[:10]
    return (bool(old) and bool(new) and new > old and source != "proposal"
            and (t.due_agreement or "") in AGREED)


def settle_agreement(t: models.Task, actor: str) -> None:
    """Where the negotiation stands after `actor` put the current date/assignees
    on the task. Used on create, on a date change, and on reassignment."""
    actor = (actor or "").strip().lower()
    assignees = task_assignees(t)
    t.due_proposal = None
    if not t.due_on or not assignees:
        t.due_agreement = ""
    elif actor in assignees:
        t.due_agreement = "accepted"    # their own deadline
    else:
        t.due_agreement = "pending"     # somebody else's target - theirs to confirm


def init_due(t: models.Task, actor: str) -> None:
    """A new task's first date: the start of its history, and where the
    negotiation begins. No activity row - "created this task" already covers it."""
    if t.due_on:
        t.due_history = [{"at": now_iso(), "from": "", "to": t.due_on[:10], "by": (actor or "").lower(),
                          "source": "app", "extension": False}]
    settle_agreement(t, actor)


def record_due_change(db: Session, t: models.Task, old: str, new: str, *, actor: str,
                      source: str = "app", note: str = "") -> dict | None:
    """Log one move of t.due_on (already written by the caller) and keep the
    count and the agreement in step. Returns the history entry, or None when
    the date did not actually change."""
    old, new = (old or "")[:10], (new or "")[:10]
    if old == new:
        return None
    actor = (actor or "").strip().lower()
    ext = is_extension(t, old, new, source)
    entry = {"at": now_iso(), "from": old, "to": new, "by": actor,
             "source": source if source in SOURCES else "app", "extension": ext}
    if note:
        entry["note"] = note[:500]
    t.due_history = list(t.due_history or []) + [entry]
    if ext:
        t.due_extension_count = int(t.due_extension_count or 0) + 1

    if source == "proposal":
        t.due_agreement, t.due_proposal = "accepted", None
    elif source != "asana":
        # An Asana edit has no Nexus actor to attribute a confirmation to, so
        # it leaves the negotiation where it was.
        settle_agreement(t, actor)

    if not old:
        detail = f"set the due date to {us_date(new)}"
    elif not new:
        detail = f"removed the due date (was {us_date(old)})"
    else:
        detail = f"changed the due date from {us_date(old)} to {us_date(new)}"
    if ext:
        n = t.due_extension_count
        detail += f" - extension #{n}"
    if source == "asana":
        detail += " (in Asana)"
    _log(db, t, "due_changed", actor or "asana", detail)
    if ext:
        _alert_managers(db, t, actor)
    return entry


def _alert_managers(db: Session, t: models.Task, actor: str) -> None:
    """Bell (never email) to each assignee's manager on the 3rd, 6th, 9th...
    extension - the "management alert" Neil asked for, raised by data."""
    n = int(t.due_extension_count or 0)
    if n < MANAGER_ALERT_EVERY or n % MANAGER_ALERT_EVERY:
        return
    assignees = task_assignees(t)
    if not assignees:
        return
    rows = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email.in_(assignees)).all()
    names = {(e.work_email or "").lower(): (e.display_name or f"{e.first_name or ''} {e.last_name or ''}".strip()
                                            or e.work_email) for e in rows}
    sent = set()
    for e in rows:
        mgr = (e.manager_email or "").strip().lower()
        if not mgr or mgr in sent or mgr == actor or mgr in assignees:
            continue
        sent.add(mgr)
        who = ", ".join(names.get(a, a) for a in assignees)
        task_notify(db, kind="task_due_extended", for_email=mgr,
                    title=f"Task extended {n} times",
                    body=f"{t.title} ({who}) - now due {us_date(t.due_on)}",
                    task_id=t.id, nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})


# ── Negotiation ─────────────────────────────────────────────────────────────

def confirm(db: Session, t: models.Task, actor: str) -> None:
    t.due_agreement, t.due_proposal = "accepted", None
    _log(db, t, "due_confirmed", actor, f"confirmed the due date {us_date(t.due_on)}")
    req = requester_of(t)
    if req and req != actor:
        task_notify(db, kind="task_due_confirmed", for_email=req, title="Due date confirmed",
                    body=f"{t.title} - due {us_date(t.due_on)}", task_id=t.id,
                    nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})


def propose(db: Session, t: models.Task, actor: str, due_on: str, note: str = "") -> None:
    t.due_agreement = "proposed"
    t.due_proposal = {"dueOn": due_on[:10], "by": actor, "at": now_iso(), "note": (note or "")[:500]}
    detail = f"asked to move the due date from {us_date(t.due_on)} to {us_date(due_on)}"
    if note:
        detail += f": {note[:200]}"
    _log(db, t, "due_proposed", actor, detail)
    req = requester_of(t)
    if req and req != actor:
        task_notify(db, kind="task_due_proposed", for_email=req, title="New due date proposed",
                    body=f"{t.title} - {us_date(t.due_on)} → {us_date(due_on)}", task_id=t.id,
                    nexus_action={"view": "tasks", "sub": "mine", "label": "Review"})


def respond(db: Session, t: models.Task, actor: str, accept: bool, note: str = "",
            counter_on: str = "") -> None:
    """Accept the proposed date, keep the current one, or suggest a third
    (`counter_on`) - which becomes the new target, back with the assignee to
    confirm. A counter is still negotiation, never an extension."""
    prop = t.due_proposal or {}
    proposer = (prop.get("by") or "").lower()
    if counter_on:
        old = t.due_on or ""
        t.due_on = counter_on[:10]
        record_due_change(db, t, old, t.due_on, actor=actor, source="counter", note=note)
        t.due_agreement, t.due_proposal = "pending", None
        title = "New due date suggested"
        detail = f"suggested {us_date(t.due_on)} instead of {us_date(prop.get('dueOn') or '')}"
    elif accept:
        old = t.due_on or ""
        t.due_on = prop.get("dueOn") or old
        record_due_change(db, t, old, t.due_on, actor=actor, source="proposal", note=note)
        title = "Due date change accepted"
        detail = f"accepted the new due date {us_date(t.due_on)}"
    else:
        t.due_agreement, t.due_proposal = "pending", None
        title = "Due date change declined"
        detail = f"kept the due date {us_date(t.due_on)}"
    if note:
        detail += f": {note[:200]}"
    _log(db, t, "due_answered", actor, detail)
    for who in {proposer, *task_assignees(t)}:
        if who and who != actor:
            task_notify(db, kind="task_due_answered", for_email=who, title=title,
                        body=f"{t.title} - due {us_date(t.due_on)}", task_id=t.id,
                        nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})


# ── Per-person record ───────────────────────────────────────────────────────

def _completed_day(t: models.Task) -> str:
    return (t.completed_at or "")[:10]


def person_record(tasks: list, email: str, *, days: int = 90, today: date | None = None) -> dict:
    """How a person does against their deadlines: open work plus everything
    they finished in the last `days` days, among tasks assigned to them.

    Deliberately facts, not a score - "this person extends a lot" can mean
    overloaded as easily as careless, and the manager reading it knows which.
    `flags` are the patterns worth a conversation."""
    email = (email or "").strip().lower()
    today = today or date.today()
    since = (today - timedelta(days=days)).isoformat()
    today_iso = today.isoformat()
    mine = [t for t in tasks if email in task_assignees(t)]
    in_window = [t for t in mine if not t.completed or _completed_day(t) >= since]

    dated_done = [t for t in in_window if t.completed and t.due_on and _completed_day(t)]
    late = [t for t in dated_done if _completed_day(t) > t.due_on[:10]]
    open_overdue = [t for t in in_window if not t.completed and t.due_on and t.due_on[:10] < today_iso]
    extended = [t for t in in_window if int(t.due_extension_count or 0) > 0]
    total_ext = sum(int(t.due_extension_count or 0) for t in in_window)
    self_ext = sum(1 for t in in_window for h in (t.due_history or [])
                   if h.get("extension") and (h.get("by") or "").lower() == email)
    stale = [t for t in in_window if not t.completed and int(t.due_extension_count or 0) >= 3]
    awaiting = [t for t in in_window if not t.completed and (t.due_agreement or "") == "pending"]

    on_time_pct = round(100 * (len(dated_done) - len(late)) / len(dated_done)) if dated_done else None
    flags = []
    if len(dated_done) >= 5 and on_time_pct is not None and on_time_pct < 70:
        flags.append(f"Finished {100 - on_time_pct}% of dated tasks late")
    if stale:
        flags.append(f"{len(stale)} open task{'s' if len(stale) != 1 else ''} extended 3+ times")
    if len(open_overdue) >= 5:
        flags.append(f"{len(open_overdue)} tasks overdue right now")

    def brief(t):
        return {"id": t.id, "code": t.code or "", "title": t.title, "dueOn": t.due_on or None,
                "extensions": int(t.due_extension_count or 0), "completed": bool(t.completed)}

    return {
        "windowDays": days,
        "completedWithDueDate": len(dated_done),
        "completedLate": len(late),
        "onTimePct": on_time_pct,
        "openOverdue": len(open_overdue),
        "tasksExtended": len(extended),
        "totalExtensions": total_ext,
        "selfExtensions": self_ext,
        "awaitingConfirmation": len(awaiting),
        "mostExtended": [brief(t) for t in sorted(extended, key=lambda t: -int(t.due_extension_count or 0))[:5]],
        "flags": flags,
    }
