"""Task Notification workflow (Jul 2026) - Outlook email side-effects for
task lifecycle events, plus the background retry and due-date-reminder loops.
Mirrors ticket_notify.py's design exactly (same author, same day) - see that
file's docstring for the shared reasoning; only the recipient rules, event
set, and templates differ.

routers/tasks.py calls `notify_task_event(...)` via FastAPI BackgroundTasks
after each task mutation has already committed - email delivery runs after
the HTTP response, and a failure here can never surface as a failed task
operation (every entry point below is wrapped so nothing escapes to the
caller). See graph_mail.py for the actual Graph API call and
task_mail_templates.py for the HTML.

Settings live in NexusSetting (key="task_notify_config"). Delivery state
lives in TaskEmailLog (models.py).

Event set (mirrors Asana's own email notification triggers - task assigned,
due date reminders, task completed, comments, collaborator updates, plus
Nexus's own created/modified/deleted): created, assigned, due_soon, overdue,
completed, commented, follower_added, modified, deleted.
"""
import asyncio
import json
import uuid
from datetime import datetime, timezone, date

from sqlalchemy.orm import Session

import models
from database import SessionLocal
import graph_mail
import task_mail_templates as tmpl
from app_url import app_url
from task_inbound_parse import reply_address, reply_mailbox
from routers.task_util import log_activity, task_assignees

_SETTINGS_KEY = "task_notify_config"

_DEFAULT_SETTINGS = {
    "fromMailbox": "",     # blank = fall back to graph_mail.DEFAULT_FROM_EMAIL (NEXUS_FROM_EMAIL env var)
    "defaultCc":   [],
    "replyTo":     "",
    "logoUrl":     "",
    # Replying to a notification posts a comment on the task (task_inbound.py).
    # Off by default: it needs a mailbox the app can READ, which is a separate
    # Graph grant (Mail.ReadWrite) from the one that sends. `inboundMailbox`
    # falls back to replyTo - they are normally the same address, and the reply
    # address people actually see is a signed sub-address of it.
    "inboundEnabled": False,
    "inboundMailbox": "",
    "dueSoonDays": 2,      # remind this many days before due_on; 0 = due-date reminders off
    "overdueRepeatDays": 3,   # re-remind an overdue task every N days until done/reassigned; 0 = only once
    "enabledEvents": {
        "created": True, "assigned": True, "due_soon": True, "overdue": True,
        "completed": True, "commented": True, "mentioned": True, "follower_added": True,
        "modified": True, "deleted": True,
    },
}

MAX_ATTEMPTS = 5
_RETRY_LOOP_SEC = 5 * 60
_STALE_PENDING_SEC = 5 * 60
_DUE_SCAN_LOOP_SEC = 60 * 60   # due-date reminders only need an hourly resolution, not 5 min


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
    merged.update({k: v for k, v in cfg.items() if k != "enabledEvents"})
    merged["enabledEvents"] = {**_DEFAULT_SETTINGS["enabledEvents"], **(cfg.get("enabledEvents") or {})}
    return merged


def save_settings(db: Session, patch: dict, actor_email: str) -> dict:
    merged = get_settings(db)
    merged.update({k: v for k, v in patch.items() if k != "enabledEvents"})
    if "enabledEvents" in patch:
        merged["enabledEvents"] = {**merged["enabledEvents"], **(patch["enabledEvents"] or {})}
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    if not row:
        row = models.NexusSetting(key=_SETTINGS_KEY)
        db.add(row)
    row.value = json.dumps(merged)
    row.updated_by = actor_email
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    return merged


# ── Recipient resolution ──────────────────────────────────────────────────

def _name_of(db: Session, email: str) -> str:
    if not email:
        return ""
    emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == email.lower()).first()
    if emp:
        full = f"{emp.first_name or ''} {emp.last_name or ''}".strip()
        if full:
            return full
    role = db.query(models.NexusRole).filter(models.NexusRole.email == email.lower()).first()
    if role and role.display_name:
        return role.display_name
    local = email.split("@", 1)[0]
    return " ".join(p.capitalize() for p in local.replace("_", ".").split(".") if p) or email


def _is_sendable(db: Session, email: str) -> bool:
    email = (email or "").strip().lower()
    if not email or "@" not in email or " " in email:
        return False
    if email == "asana-sync":   # synced tasks stamp this as created_by - never a real mailbox
        return False
    emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == email).first()
    return not (emp and emp.status in ("inactive", "offboarded"))


def _recipients_for(db: Session, t: models.Task, event_type: str, actor_email: str, cfg: dict,
                    extra: dict) -> list[tuple[str, str]]:
    """Returns deduped [(email, role)] for an event, excluding the actor
    themselves (nobody needs an email for their own action) except where
    Asana's own behavior is explicitly to notify the actor too (none of the
    events here do that - matches Asana, which never emails you about your
    own action)."""
    out: dict[str, str] = {}
    actor = (actor_email or "").strip().lower()

    def add(email: str, role: str):
        email = (email or "").strip().lower()
        if email and email != actor and _is_sendable(db, email) and email not in out:
            out[email] = role

    # add() de-duplicates, so fanning out over every assignee cannot mail
    # anyone twice even when they are also a follower.
    assignees = task_assignees(t)
    assignee = assignees[0] if assignees else ""
    followers = [(f or "").strip().lower() for f in (t.follower_emails or [])]

    def add_assignees():
        for _a in assignees:
            add(_a, "assignee")
    creator = (t.created_by or "").strip().lower()

    if event_type == "created":
        add_assignees()
        for f in followers:
            add(f, "follower")
    elif event_type == "assigned":
        add_assignees()
    elif event_type in ("due_soon", "overdue"):
        add_assignees()
    elif event_type == "completed":
        add_assignees()
        add(creator, "creator")
        for f in followers:
            add(f, "follower")
    elif event_type == "commented":
        add_assignees()
        for f in followers:
            add(f, "follower")
    elif event_type == "mentioned":
        # ONLY the people named in the comment. Assignees and followers already
        # got the "commented" mail for the same comment; adding them here would
        # send two emails about one event.
        for who in extra.get("mentioned", []) or []:
            add(who, "mentioned")
    elif event_type == "follower_added":
        add(extra.get("new_follower", ""), "follower")
    elif event_type == "modified":
        add_assignees()
        for f in followers:
            add(f, "follower")
    elif event_type == "deleted":
        add_assignees()
        add(creator, "creator")
        for f in followers:
            add(f, "follower")

    return list(out.items())


# ── Idempotency + delivery ─────────────────────────────────────────────────

def _next_event_version(db: Session, task_id: str, event_type: str) -> int:
    last = (db.query(models.TaskEmailLog)
            .filter(models.TaskEmailLog.task_id == task_id, models.TaskEmailLog.event_type == event_type)
            .order_by(models.TaskEmailLog.event_version.desc()).first())
    return (last.event_version + 1) if last else 1


def _send_one(db: Session, *, task_id: str, task_code: str, event_type: str, idem_suffix: str,
              recipient: str, role: str, subject: str, html: str, cfg: dict) -> None:
    """idem_suffix distinguishes repeat sends of the SAME event_type that
    aren't a version bump - due-date reminders key on the calendar day
    (f"{date}") instead of an incrementing version, so a reminder that
    already went out today never resends today even across multiple pull/
    scan cycles, but does resend tomorrow."""
    key = f"{task_id}:{event_type}:{idem_suffix}:{recipient}"
    existing = db.query(models.TaskEmailLog).filter(models.TaskEmailLog.idempotency_key == key).first()
    if existing and existing.status in ("sent", "pending"):
        return

    now = datetime.now(timezone.utc).isoformat()
    row = existing or models.TaskEmailLog(
        id=str(uuid.uuid4()), task_id=task_id, task_code=task_code, event_type=event_type,
        event_version=0, idempotency_key=key, recipient=recipient, recipient_role=role,
        subject=subject, status="pending", attempts=0, created_at=now,
    )
    if not existing:
        db.add(row)
    row.status = "pending"
    row.subject = subject
    row.html = html
    row.attempts = (row.attempts or 0) + 1
    row.updated_at = now
    db.commit()

    from_email = (cfg.get("fromMailbox") or graph_mail.DEFAULT_FROM_EMAIL or "").strip()
    cc = [e for e in (cfg.get("defaultCc") or []) if e and e.lower() != recipient]
    try:
        result = graph_mail.send_mail(from_email=from_email, to=[recipient], cc=cc,
                                       subject=subject, html=html,
                                       reply_to=reply_address(reply_mailbox(cfg), task_id))
        row.status = "sent"
        row.graph_message_id = result.get("messageId", "")
        row.conversation_id = result.get("conversationId", "")
        row.internet_message_id = result.get("internetMessageId", "")
        row.error = ""
        detail = f"{event_type.title()} email sent to {recipient} ({role})"
    except graph_mail.GraphMailError as e:
        row.status = "failed"
        row.error = str(e)[:1000]
        detail = f"{event_type.title()} email to {recipient} ({role}) failed - will retry: {row.error[:200]}"
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    log_activity(db, type="notify_sent" if row.status == "sent" else "notify_failed",
                 actor_email="system", entity_kind="task", entity_id=task_id,
                 entity_code=task_code, entity_title="", detail=detail)
    db.commit()


def _task_context(db: Session, t: models.Task, actor_email: str) -> dict:
    project_name = ""
    if t.project_id:
        p = db.query(models.TaskProject).filter(models.TaskProject.id == t.project_id).first()
        project_name = p.name if p else ""
    return {
        "id": t.id, "code": t.code or "", "title": t.title, "status": t.status,
        "description": t.description or "", "priority": t.priority,
        "projectName": project_name,
        # assigneeName lists EVERY assignee - a mail that named only the first
        # would read as though the other recipients were merely cc'd on somebody
        # else's task, when it is equally theirs.
        "assigneeId": t.assignee_email or "",
        "assigneeName": ", ".join(_name_of(db, a) for a in task_assignees(t)),
        "actorEmail": actor_email, "actorName": _name_of(db, actor_email),
        "eventAtDisplay": _fmt(datetime.now(timezone.utc).isoformat()),
        "dueDateDisplay": _fmt(t.due_on) if t.due_on else "",
    }


def _fmt(iso: str) -> str:
    if not iso:
        return ""
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00")) if len(iso) > 10 else datetime.fromisoformat(iso + "T00:00:00+00:00")
        return d.strftime("%b %d, %Y")
    except ValueError:
        return iso[:10]


# ── Main entry point - called from routers/tasks.py via BackgroundTasks ────

def notify_task_event(task_id: str, event_type: str, actor_email: str, **kw) -> None:
    """event_type ∈ created|assigned|completed|commented|follower_added|
    modified|deleted (due_soon/overdue are fired by the scheduled scan below,
    not from here). kw: update_kind, comment_body, new_follower, snapshot
    (only for "deleted" - the row is already gone by the time this runs, so
    the caller must pass {title, code, status, priority, assignee_email,
    follower_emails, created_by, project_id} captured before the delete).
    Never raises."""
    db = SessionLocal()
    try:
        cfg = get_settings(db)
        if not cfg["enabledEvents"].get(event_type, True):
            return

        if event_type == "deleted":
            snap = kw.get("snapshot") or {}
            t = models.Task(id=task_id, **{k: v for k, v in snap.items() if k not in ("id",)})
        else:
            t = db.query(models.Task).filter(models.Task.id == task_id).first()
            if not t:
                return

        recipients = _recipients_for(db, t, event_type, actor_email, cfg, kw)
        if not recipients:
            return
        ctx = _task_context(db, t, actor_email)
        logo_url = cfg.get("logoUrl") or ""
        version = _next_event_version(db, task_id, event_type)

        for recipient, role in recipients:
            if event_type == "created":
                subject, html = tmpl.created_email(t=ctx, base_url=app_url(), logo_url=logo_url,
                                                    audience="assignee" if role == "assignee" else "other")
            elif event_type == "assigned":
                subject, html = tmpl.assigned_email(t=ctx, base_url=app_url(), logo_url=logo_url,
                                                     audience="assignee" if role == "assignee" else "other")
            elif event_type == "completed":
                subject, html = tmpl.completed_email(t=ctx, base_url=app_url(), logo_url=logo_url)
            elif event_type == "mentioned":
                subject, html = tmpl.mentioned_email(t=ctx, base_url=app_url(), logo_url=logo_url,
                                                     comment_body=kw.get("comment_body", ""),
                                                     actor_name=ctx["actorName"])
            elif event_type == "commented":
                subject, html = tmpl.commented_email(t=ctx, base_url=app_url(), logo_url=logo_url,
                                                      comment_body=kw.get("comment_body", ""))
            elif event_type == "follower_added":
                subject, html = tmpl.follower_added_email(t=ctx, base_url=app_url(), logo_url=logo_url)
            elif event_type == "modified":
                subject, html = tmpl.modified_email(t=ctx, base_url=app_url(), logo_url=logo_url,
                                                     update_kind=kw.get("update_kind", "Task updated"))
            elif event_type == "deleted":
                subject, html = tmpl.deleted_email(t=ctx, base_url=app_url(), logo_url=logo_url)
            else:
                continue
            _send_one(db, task_id=task_id, task_code=t.code, event_type=event_type,
                      idem_suffix=str(version), recipient=recipient, role=role,
                      subject=subject, html=html, cfg=cfg)
    except Exception as e:
        try:
            log_activity(db, type="notify_error", actor_email="system", entity_kind="task",
                         entity_id=task_id, entity_code="", entity_title="",
                         detail=f"Notification pipeline error ({event_type}): {e}")
            db.commit()
        except Exception:
            pass
    finally:
        db.close()


# ── Due-date reminders (scheduled scan - no mutation triggers this) ────────

def _due_reminders_once(db: Session) -> None:
    cfg = get_settings(db)
    due_soon_days = cfg.get("dueSoonDays") or 0
    overdue_repeat = cfg.get("overdueRepeatDays") or 0
    if not due_soon_days and not cfg["enabledEvents"].get("overdue", True):
        return
    today = date.today()
    day_key = today.isoformat()
    tasks = (db.query(models.Task)
            .filter(models.Task.due_on != "", models.Task.completed == False).all())  # noqa: E712
    for t in tasks:
        try:
            due = date.fromisoformat((t.due_on or "")[:10])
        except ValueError:
            continue
        days_left = (due - today).days
        recipients = [a for a in task_assignees(t) if _is_sendable(db, a)]
        if not recipients:
            continue

        if days_left < 0:
            if not cfg["enabledEvents"].get("overdue", True):
                continue
            # ALWAYS mail on the first day overdue - that's the one that matters
            # - then repeat every `overdue_repeat` days after it. 0 means the
            # first day only.
            #
            # The old condition (`if overdue_repeat and abs(days_left) %
            # overdue_repeat != 0`) inverted both halves of its own docstring:
            #   - overdue_repeat == 0 is falsy, so the guard never ran and the
            #     "only once" setting mailed the assignee EVERY DAY, forever.
            #   - with the default 3, day 1 gave 1 % 3 != 0 -> skipped, so the
            #     day a task actually went overdue was silent and the first
            #     mail didn't land until day 3.
            overdue_days = -days_left          # 1 == first day overdue
            if overdue_days > 1 and (not overdue_repeat
                                     or (overdue_days - 1) % overdue_repeat != 0):
                continue
            event_type, idem_suffix = "overdue", day_key
        elif 0 <= days_left <= due_soon_days:
            if not cfg["enabledEvents"].get("due_soon", True):
                continue
            event_type, idem_suffix = "due_soon", day_key
        else:
            continue

        logo_url = cfg.get("logoUrl") or ""
        # One reminder each. _send_one's idempotency key already includes the
        # recipient, so the "only once per day" guarantee holds per person
        # rather than being spent by whoever happens to be first in the list.
        for who in recipients:
            ctx = _task_context(db, t, who)
            subject, html = tmpl.due_reminder_email(t=ctx, base_url=app_url(), logo_url=logo_url, days_left=days_left)
            _send_one(db, task_id=t.id, task_code=t.code, event_type=event_type, idem_suffix=idem_suffix,
                      recipient=who, role="assignee", subject=subject, html=html, cfg=cfg)


# ── Background loops (same bare-asyncio-loop convention as ticket_notify.py /
#    reminders.py - no task-queue library exists in this codebase) ─────────

def _retry_failed_once(db: Session) -> None:
    cutoff = datetime.now(timezone.utc)
    rows = (db.query(models.TaskEmailLog)
            .filter(models.TaskEmailLog.status.in_(["failed", "pending"]),
                    models.TaskEmailLog.attempts < MAX_ATTEMPTS).all())
    for row in rows:
        if row.status == "pending":
            try:
                started = datetime.fromisoformat(row.updated_at.replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                started = cutoff
            if (cutoff - started).total_seconds() < _STALE_PENDING_SEC:
                continue
        t = db.query(models.Task).filter(models.Task.id == row.task_id).first()
        if not t:
            # Deleted-task emails legitimately have no row to re-render from -
            # only fail these out permanently instead of retrying forever.
            row.status = "failed"
            row.error = "Task no longer exists (nothing left to retry from)"
            db.commit()
            continue
        cfg = get_settings(db)
        from_email = (cfg.get("fromMailbox") or graph_mail.DEFAULT_FROM_EMAIL or "").strip()
        cc = [e for e in (cfg.get("defaultCc") or []) if e and e.lower() != row.recipient]
        row.status = "retrying"
        row.attempts += 1
        row.updated_at = datetime.now(timezone.utc).isoformat()
        db.commit()
        ctx = _task_context(db, t, row.recipient)
        try:
            # Prefer the ORIGINAL rendered body over rebuilding one: a rebuild
            # has no comment text to work from for commented/mentioned, and for
            # every event type it re-renders against the task's CURRENT state,
            # which can have drifted from what the event actually said between
            # the failed attempt and this retry. Only a legacy row from before
            # `html` existed falls back to a rebuild.
            subject, html = _rebuild_email(row.event_type, ctx, row.recipient_role, cfg)
            html = row.html or html
            result = graph_mail.send_mail(from_email=from_email, to=[row.recipient], cc=cc,
                                           subject=row.subject or subject, html=html,
                                           reply_to=reply_address(reply_mailbox(cfg), row.task_id))
            row.status = "sent"
            row.graph_message_id = result.get("messageId", "")
            row.conversation_id = result.get("conversationId", "")
            row.internet_message_id = result.get("internetMessageId", "")
            row.error = ""
            log_activity(db, type="notify_sent", actor_email="system", entity_kind="task",
                         entity_id=t.id, entity_code=t.code, entity_title=t.title,
                         detail=f"Retry succeeded - {row.event_type} email sent to {row.recipient}")
        except graph_mail.GraphMailError as e:
            row.status = "failed"
            row.error = str(e)[:1000]
            log_activity(db, type="notify_failed", actor_email="system", entity_kind="task",
                         entity_id=t.id, entity_code=t.code, entity_title=t.title,
                         detail=f"Retry {row.attempts}/{MAX_ATTEMPTS} failed for {row.recipient}: {row.error[:200]}")
        row.updated_at = datetime.now(timezone.utc).isoformat()
        db.commit()


def _rebuild_email(event_type: str, ctx: dict, role: str, cfg: dict) -> tuple[str, str]:
    """Fallback only for a row whose `html` predates that column (see
    TaskEmailLog.html) - every current row carries its own original body and
    never reaches this. Re-rendering against the task's CURRENT state means
    this can drift from what the event actually said; for commented/mentioned
    there is no comment text left to rebuild from at all, so those render
    honestly empty (the templates already show "-" for a blank comment_body)
    rather than the wrong "Task updated" body the generic fallback used to send."""
    logo_url = cfg.get("logoUrl") or ""
    if event_type == "created":
        return tmpl.created_email(t=ctx, base_url=app_url(), logo_url=logo_url, audience="assignee" if role == "assignee" else "other")
    if event_type == "assigned":
        return tmpl.assigned_email(t=ctx, base_url=app_url(), logo_url=logo_url, audience="assignee" if role == "assignee" else "other")
    if event_type == "completed":
        return tmpl.completed_email(t=ctx, base_url=app_url(), logo_url=logo_url)
    if event_type == "commented":
        return tmpl.commented_email(t=ctx, base_url=app_url(), logo_url=logo_url, comment_body="")
    if event_type == "mentioned":
        return tmpl.mentioned_email(t=ctx, base_url=app_url(), logo_url=logo_url, comment_body="",
                                    actor_name=ctx.get("actorName", ""))
    if event_type == "follower_added":
        return tmpl.follower_added_email(t=ctx, base_url=app_url(), logo_url=logo_url)
    if event_type in ("due_soon", "overdue"):
        return tmpl.due_reminder_email(t=ctx, base_url=app_url(), logo_url=logo_url,
                                       days_left=-1 if event_type == "overdue" else 0)
    if event_type == "deleted":
        return tmpl.deleted_email(t=ctx, base_url=app_url(), logo_url=logo_url)
    return tmpl.modified_email(t=ctx, base_url=app_url(), logo_url=logo_url, update_kind="Task updated")


def _task_scan_once(do_due: bool) -> None:
    """The blocking body of task_notify_loop: synchronous DB queries plus
    Outlook/Graph email sends. Run via asyncio.to_thread (see the loop) so it
    NEVER executes on the request event loop - a slow synchronous Graph send here
    used to freeze every request the worker was serving, CORS preflights
    included, for as long as the send took. Matches reminders_loop /
    long_session_loop, which already offload their scans the same way."""
    db = SessionLocal()
    try:
        _retry_failed_once(db)
        if do_due:
            _due_reminders_once(db)
    finally:
        db.close()


async def task_notify_loop() -> None:
    """Started once from main.py's lifespan, same convention as
    ticket_notify.ticket_notify_loop. Retries failed/stuck sends every 5 min;
    scans for due-date reminders hourly (that resolution is all a "due in N
    days" reminder needs). The scan runs in a worker thread (asyncio.to_thread)
    so its blocking DB + Graph I/O never stalls the event loop."""
    await asyncio.sleep(75)   # stagger slightly after the ticket loop's own 60s startup delay
    last_due_scan = 0.0
    while True:
        now = asyncio.get_event_loop().time()
        do_due = (now - last_due_scan) >= _DUE_SCAN_LOOP_SEC
        try:
            await asyncio.to_thread(_task_scan_once, do_due)
            if do_due:
                last_due_scan = now
        except Exception:
            pass
        await asyncio.sleep(_RETRY_LOOP_SEC)
