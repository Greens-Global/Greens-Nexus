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
from datetime import datetime, timedelta, timezone, date

from sqlalchemy import func
from sqlalchemy.orm import Session

import models
from database import SessionLocal
import graph_mail
import task_mail_templates as tmpl
import task_mail_actions as mail_actions
import task_notify_prefs as prefs_mod
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
        "modified": True, "deleted": True, "recurring": True,
    },
    # Whether a person may switch overdue reminders OFF in their own email
    # settings (task_notify_prefs). Off by default: the least they can choose
    # is weekly / only once, so overdue work never goes completely silent.
    "allowUserOverdueOff": False,
    # Batching (Neil, Sep 24): hold a person's task emails and send what
    # piled up as ONE email once the oldest has waited this long. 0 = send
    # every email the moment it happens (the old behavior). See flush_batches.
    "batchWindowMinutes": 60,
}

MAX_ATTEMPTS = 5
_RETRY_LOOP_SEC = 5 * 60
_STALE_PENDING_SEC = 5 * 60
_DUE_SCAN_LOOP_SEC = 60 * 60   # due-date reminders only need an hourly resolution, not 5 min
_BATCH_LOOP_SEC = 60           # how often held (batched) emails are checked
_CLAIM_STALE_SEC = 10 * 60     # a batch claimed this long ago by a worker that died is re-queued


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
        # A moved due date always reaches whoever asked for the work, follower
        # or not (Neil, Sep 24).
        if extra.get("due_changed"):
            add(creator, "creator")
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
        # For the in-mail actions (task_mail_actions): the status dropdown is
        # scoped to the task's project, and the card's "Open in Nexus" button
        # needs the same link the HTML CTA uses.
        "projectId": t.project_id or "",
        "taskUrl": tmpl._task_url(app_url(), t.id),
    }


def _with_actions(db: Session, html: str, *, event_type: str, ctx: dict, recipient: str,
                  comment_body: str = "", comment_author: str = "") -> str:
    """Adds the in-mail action buttons / Outlook card to a rendered email.
    Never lets a problem here cost the email itself - worst case it goes out
    exactly as it did before actions existed."""
    try:
        return mail_actions.decorate(
            html, event_type=event_type, t=ctx, recipient=recipient,
            options=mail_actions.status_options(db, ctx.get("projectId") or ""),
            comment_body=comment_body, comment_author=comment_author)
    except Exception:
        return html.replace(mail_actions.ACTIONS_SLOT, "").replace(mail_actions.FOOTER_SLOT, "")


def _recently_sent(db: Session, task_id: str, event_type: str, recipient: str, minutes: int) -> bool:
    if not minutes:
        return False
    since = (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()
    return db.query(models.TaskEmailLog).filter(
        models.TaskEmailLog.task_id == task_id, models.TaskEmailLog.event_type == event_type,
        models.TaskEmailLog.recipient == recipient, models.TaskEmailLog.status == "sent",
        models.TaskEmailLog.created_at >= since,
    ).first() is not None


def _fmt(iso: str) -> str:
    if not iso:
        return ""
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00")) if len(iso) > 10 else datetime.fromisoformat(iso + "T00:00:00+00:00")
        return d.strftime("%b %d, %Y")
    except ValueError:
        return iso[:10]


def _render_event(db: Session, ctx: dict, event_type: str, recipient: str, role: str,
                  logo_url: str, kw: dict) -> tuple[str, str] | None:
    """The single-task email for one event, actions included - shared by the
    instant path and by a batch that turned out to hold just one event, so a
    batch of one reads exactly like the email it replaced."""
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
        return None
    html = _with_actions(db, html, event_type=event_type, ctx=ctx, recipient=recipient,
                         comment_body=kw.get("comment_body", ""),
                         comment_author=ctx.get("actorName", ""))
    return subject, html


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
            # The person's own email settings: events they turned off, muted
            # tasks/projects, and at most one "Updated" email per task per N
            # minutes (task_notify_prefs). Assigned/mentioned always pass.
            p = prefs_mod.load(db, recipient)
            if not prefs_mod.wants_event(p, event_type, t):
                continue
            if event_type == "modified" and _recently_sent(db, task_id, "modified", recipient,
                                                           p["updateThrottleMinutes"]):
                continue
            # Batching: everything that can wait is queued and goes out with
            # the rest of this person's hour (flush_batches). A deleted task
            # has no row left to batch from, so it never waits.
            if event_type != "deleted" and not _sends_now(t, event_type, cfg):
                _enqueue(db, recipient=recipient, role=role, task_id=task_id, event_type=event_type,
                         actor_email=actor_email, payload=kw)
                continue
            rendered = _render_event(db, ctx, event_type, recipient, role, logo_url, kw)
            if not rendered:
                continue
            subject, html = rendered
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

def _due_reminders_once(db: Session, now_utc: datetime | None = None) -> None:
    """Due-soon / overdue reminders, per PERSON (Sept 2026): each assignee's
    own preferences (task_notify_prefs) decide when their reminders arrive,
    which window counts as "due soon", how often an overdue task repeats, and
    whether they get one email per task or a single daily summary. The company
    settings are the default for anyone who hasn't chosen.

    Runs hourly; a person is only considered once their chosen hour has been
    reached in their own time zone, and every send is keyed to their LOCAL
    calendar day, so each reminder still goes out at most once a day."""
    cfg = get_settings(db)
    now_utc = now_utc or datetime.now(timezone.utc)
    overdue_on = cfg["enabledEvents"].get("overdue", True)
    due_soon_on = cfg["enabledEvents"].get("due_soon", True)
    if not overdue_on and not due_soon_on:
        return
    tasks = (db.query(models.Task)
             .filter(models.Task.due_on != "", models.Task.completed == False).all())  # noqa: E712

    # person -> their open dated tasks. Grouped first so each person's
    # preferences are read once and a summary can cover all of their tasks.
    by_person: dict[str, list] = {}
    sendable: dict[str, bool] = {}
    for t in tasks:
        for who in task_assignees(t):
            if who not in sendable:
                sendable[who] = _is_sendable(db, who)
            if sendable[who]:
                by_person.setdefault(who, []).append(t)

    logo_url = cfg.get("logoUrl") or ""
    for who, items in by_person.items():
        p = prefs_mod.load(db, who)
        if not prefs_mod.reminders_due_now(p, now_utc):
            continue
        today = prefs_mod.local_now(p, now_utc).date()
        day_key = today.isoformat()
        soon_window = prefs_mod.due_soon_days(p, cfg)
        repeat = prefs_mod.overdue_repeat(p, cfg)

        picked = []   # (task, days_left, event_type)
        for t in items:
            if prefs_mod.is_muted(p, t):
                continue
            try:
                due = date.fromisoformat((t.due_on or "")[:10])
            except ValueError:
                continue
            days_left = (due - today).days
            if days_left < 0:
                if not overdue_on or repeat is None:
                    continue
                # ALWAYS mail on the first day overdue - that's the one that
                # matters - then repeat every `repeat` days after it; 0 means
                # the first day only. (The original condition inverted both
                # halves: "only once" mailed daily forever, and with a 3-day
                # repeat the first overdue day itself was silent.)
                overdue_days = -days_left          # 1 == first day overdue
                if overdue_days > 1 and (not repeat or (overdue_days - 1) % repeat != 0):
                    continue
                picked.append((t, days_left, "overdue"))
            elif soon_window is not None and days_left <= soon_window:
                if not due_soon_on:
                    continue
                # A recurring occurrence the schedule just created already got
                # its own "due today" email (_recurrence_once).
                if _recurring_mail_sent(db, t):
                    continue
                picked.append((t, days_left, "due_soon"))
        if not picked:
            continue

        if p["reminderDelivery"] == "digest" and len(picked) > 1:
            rows = []
            for t, days_left, _ev in picked:
                ctx = _task_context(db, t, who)
                rows.append({"t": ctx, "days_left": days_left,
                             "links": mail_actions.task_links_html(t.id, who, done=bool(t.completed))})
            subject, html = tmpl.reminder_digest_email(items=rows, base_url=app_url(), logo_url=logo_url,
                                                       recipient_name=_name_of(db, who))
            html = html.replace(mail_actions.FOOTER_SLOT, mail_actions.footer_links_html())
            _send_one(db, task_id="", task_code="", event_type="digest", idem_suffix=day_key,
                      recipient=who, role="assignee", subject=subject, html=html, cfg=cfg)
            continue

        for t, days_left, event_type in picked:
            ctx = _task_context(db, t, who)
            subject, html = tmpl.due_reminder_email(t=ctx, base_url=app_url(), logo_url=logo_url, days_left=days_left)
            html = _with_actions(db, html, event_type=event_type, ctx=ctx, recipient=who)
            _send_one(db, task_id=t.id, task_code=t.code, event_type=event_type, idem_suffix=day_key,
                      recipient=who, role="assignee", subject=subject, html=html, cfg=cfg)


# ── Recurring tasks: create each occurrence on its scheduled date ──────────

# The day a recurrence "arrives" is a business day in the company's own time
# zone, not the server's (Azure runs in UTC, which would roll tomorrow's
# occurrence out on a US afternoon). Same zone the daily briefing uses.
_BUSINESS_TZ = "America/Los_Angeles"


def _business_today() -> str:
    from zoneinfo import ZoneInfo
    return datetime.now(ZoneInfo(_BUSINESS_TZ)).date().isoformat()


def _recurring_mail_sent(db: Session, t: models.Task) -> bool:
    return bool(t.due_on) and db.query(models.TaskEmailLog).filter(
        models.TaskEmailLog.task_id == t.id,
        models.TaskEmailLog.event_type == "recurring",
        models.TaskEmailLog.idempotency_key.like(f"{t.id}:recurring:{t.due_on[:10]}:%"),
    ).first() is not None


def _recurrence_once(db: Session) -> None:
    """Roll every calendar recurrence whose date has arrived, then email each
    new occurrence's assignees (with the in-mail actions). Idempotent: the roll
    is guarded by `nextOccurrenceId`, the email by its idempotency key."""
    from routers.tasks import spawn_scheduled_occurrences
    from routers.task_util import fire_task_event
    today = _business_today()
    spawned = spawn_scheduled_occurrences(db, today)
    cfg = get_settings(db)
    for nxt in spawned:
        fire_task_event(nxt.id, "created")
        log_activity(db, type="recurrence_scheduled", actor_email="system", entity_kind="task",
                     entity_id=nxt.id, entity_code=nxt.code, entity_title=nxt.title,
                     detail=f"Scheduled occurrence created for {nxt.due_on}")
        db.commit()
        if not cfg["enabledEvents"].get("recurring", True):
            continue
        logo_url = cfg.get("logoUrl") or ""
        for who in [a for a in task_assignees(nxt) if _is_sendable(db, a)]:
            if not prefs_mod.wants_event(prefs_mod.load(db, who), "recurring", nxt):
                continue
            ctx = _task_context(db, nxt, who)
            subject, html = tmpl.recurring_email(t=ctx, base_url=app_url(), logo_url=logo_url,
                                                 due_today=(nxt.due_on or "")[:10] == today)
            html = _with_actions(db, html, event_type="recurring", ctx=ctx, recipient=who)
            _send_one(db, task_id=nxt.id, task_code=nxt.code, event_type="recurring",
                      idem_suffix=(nxt.due_on or today)[:10], recipient=who, role="assignee",
                      subject=subject, html=html, cfg=cfg)


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
        if row.event_type in ("digest", "batch"):
            _retry_digest(db, row)
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


def _retry_digest(db: Session, row) -> None:
    """A daily summary has no single task to re-render from - resend the body
    exactly as it was built (row.html always exists for digest rows)."""
    cfg = get_settings(db)
    from_email = (cfg.get("fromMailbox") or graph_mail.DEFAULT_FROM_EMAIL or "").strip()
    row.status = "retrying"
    row.attempts += 1
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    try:
        result = graph_mail.send_mail(from_email=from_email, to=[row.recipient], cc=[],
                                      subject=row.subject, html=row.html or "")
        row.status = "sent"
        row.graph_message_id = result.get("messageId", "")
        row.error = ""
    except graph_mail.GraphMailError as e:
        row.status = "failed"
        row.error = str(e)[:1000]
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
    if event_type == "recurring":
        return tmpl.recurring_email(t=ctx, base_url=app_url(), logo_url=logo_url, due_today=True)
    if event_type in ("due_soon", "overdue"):
        return tmpl.due_reminder_email(t=ctx, base_url=app_url(), logo_url=logo_url,
                                       days_left=-1 if event_type == "overdue" else 0)
    if event_type == "deleted":
        return tmpl.deleted_email(t=ctx, base_url=app_url(), logo_url=logo_url)
    return tmpl.modified_email(t=ctx, base_url=app_url(), logo_url=logo_url, update_kind="Task updated")


def _task_scan_once(do_due: bool, do_retry: bool = True) -> None:
    """The blocking body of task_notify_loop: synchronous DB queries plus
    Outlook/Graph email sends. Run via asyncio.to_thread (see the loop) so it
    NEVER executes on the request event loop - a slow synchronous Graph send here
    used to freeze every request the worker was serving, CORS preflights
    included, for as long as the send took. Matches reminders_loop /
    long_session_loop, which already offload their scans the same way."""
    db = SessionLocal()
    try:
        # Every tick: a person whose hour is up should not wait for the slower
        # retry/due cadences below.
        try:
            flush_batches(db)
        except Exception:
            db.rollback()
        if do_retry:
            _retry_failed_once(db)
        if do_due:
            # Recurrences first, so an occurrence created today is already on
            # the books - and already mailed - when the due-date scan looks.
            try:
                _recurrence_once(db)
            except Exception:
                db.rollback()
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
    last_due_scan = last_retry = 0.0
    while True:
        now = asyncio.get_event_loop().time()
        do_due = (now - last_due_scan) >= _DUE_SCAN_LOOP_SEC
        do_retry = (now - last_retry) >= _RETRY_LOOP_SEC
        try:
            await asyncio.to_thread(_task_scan_once, do_due, do_retry)
            if do_due:
                last_due_scan = now
            if do_retry:
                last_retry = now
        except Exception:
            pass
        # Ticks every minute so a batch goes out within a minute of its hour
        # being up; retries and the due scan keep their own slower cadence.
        await asyncio.sleep(_BATCH_LOOP_SEC)


# ── Batching (Neil, Sep 24) ─────────────────────────────────────────────────
# "Wait to send the email until after one hour - if 5 tasks get assigned it can
# batch it. Neil reviews Sagar's work and assigns 4-5 at a time. That's how to
# make it smart and less spammy. Relevance is key."
#
# An event that can wait is queued (TaskEmailQueue) instead of mailed. Once a
# person's OLDEST pending row is older than the company window, everything they
# have pending goes out as one email - so the window starts at the first event
# and a busy afternoon can never push the email back forever. Before sending,
# anything that stopped being true is dropped (task deleted, reassigned away,
# already completed, muted since); if nothing is left, nothing is sent. A batch
# that holds a single event is sent as the ordinary single-task email.
#
# Never waits: mentions (someone asking you directly), deletions, and tasks
# that are urgent or due today/tomorrow - an hour's delay would cost the time
# the email exists to save. The in-app bell is never batched.

_WAIT_NEVER = ("mentioned", "deleted")


def batch_window_minutes(cfg: dict) -> int:
    try:
        return max(0, int(cfg.get("batchWindowMinutes", 60) or 0))
    except (TypeError, ValueError):
        return 60


def _is_time_critical(t) -> bool:
    if (getattr(t, "priority", "") or "") == "urgent":
        return True
    try:
        due = date.fromisoformat((getattr(t, "due_on", "") or "")[:10])
    except ValueError:
        return False
    return (due - date.fromisoformat(_business_today())).days <= 1


def _sends_now(t, event_type: str, cfg: dict) -> bool:
    """True when this event must be mailed immediately rather than batched."""
    return (batch_window_minutes(cfg) == 0 or event_type in _WAIT_NEVER
            or _is_time_critical(t))


_PAYLOAD_KEYS = ("update_kind", "comment_body", "new_follower")


def _enqueue(db: Session, *, recipient: str, role: str, task_id: str, event_type: str,
             actor_email: str, payload: dict, urgent: bool = False) -> None:
    now = datetime.now(timezone.utc).isoformat()
    db.add(models.TaskEmailQueue(
        id=str(uuid.uuid4()), recipient=recipient, role=role, task_id=task_id,
        event_type=event_type, actor_email=(actor_email or "").lower(),
        payload={k: payload[k] for k in _PAYLOAD_KEYS if payload.get(k)},
        urgent=urgent, status="pending", created_at=now, updated_at=now))
    db.commit()


def queue_bulk_assignments(db: Session, actor_email: str, assigned: dict) -> None:
    """Bulk edits never emailed anyone (fifty separate "you were assigned"
    mails for one action). With batching on they can: each newly assigned
    person gets ONE email for the lot. A time-critical task marks the batch
    urgent so it goes out on the next tick instead of waiting the hour.
    `assigned` = {email: [Task, ...]}. Never raises."""
    try:
        cfg = get_settings(db)
        if not batch_window_minutes(cfg) or not cfg["enabledEvents"].get("assigned", True):
            return
        for who, tasks in assigned.items():
            if not _is_sendable(db, who):
                continue
            p = prefs_mod.load(db, who)
            for t in tasks:
                if prefs_mod.wants_event(p, "assigned", t):
                    _enqueue(db, recipient=who, role="assignee", task_id=t.id, event_type="assigned",
                             actor_email=actor_email, payload={}, urgent=_is_time_critical(t))
    except Exception:
        db.rollback()


def _drop_reason(db: Session, q, t, p: dict) -> str:
    """Why a queued event is no longer worth sending, or "" to keep it."""
    if t is None:
        return "task deleted"
    who = q.recipient
    assignees = task_assignees(t)
    followers = [(f or "").strip().lower() for f in (t.follower_emails or [])]
    if q.role == "assignee" and who not in assignees:
        return "no longer assigned"
    if q.role == "follower" and who not in followers and who not in assignees:
        return "no longer following"
    if t.completed and q.event_type in ("created", "assigned", "modified", "follower_added"):
        return "task already completed"
    if not prefs_mod.wants_event(p, q.event_type, t):
        return "turned off or muted"
    return ""


def _event_line(q, actor_name: str) -> str:
    """One readable line for a queued event, e.g. "Neil assigned this to you"."""
    pl = q.payload if isinstance(q.payload, dict) else {}
    if q.event_type == "created":
        return f"{actor_name} created this task" + (" for you" if q.role == "assignee" else "")
    if q.event_type == "assigned":
        return f"{actor_name} assigned this to you" if q.role == "assignee" else f"{actor_name} assigned this task"
    if q.event_type == "completed":
        return f"{actor_name} completed this task"
    if q.event_type == "follower_added":
        return f"{actor_name} added you as a collaborator"
    if q.event_type == "commented":
        text = mail_actions._plain(pl.get("comment_body") or "", 160)
        return f'{actor_name} commented: "{text}"' if text else f"{actor_name} commented"
    if q.event_type == "modified":
        return f"{actor_name} changed: {pl.get('update_kind') or 'task details'}"
    return f"{actor_name} updated this task"


def _task_lines(rows: list, name_of) -> list[str]:
    """The lines for one task, coalesced: several "changed" events become one
    line, and comments past the second collapse into "and N more comments"."""
    lines, changes, comments = [], [], []
    for q in rows:
        actor = name_of(q.actor_email)
        if q.event_type == "modified":
            for kind in str((q.payload or {}).get("update_kind") or "task details").split(", "):
                if kind not in changes:
                    changes.append(kind)
            continue
        line = _event_line(q, actor)
        (comments if q.event_type == "commented" else lines).append(line)
    if changes:
        lines.append("Changed: " + ", ".join(changes))
    lines += comments[:2]
    if len(comments) > 2:
        lines.append(f"and {len(comments) - 2} more comment{'s' if len(comments) > 3 else ''}")
    return lines


def _reclaim_stale(db: Session, now: datetime) -> None:
    cutoff = (now - timedelta(seconds=_CLAIM_STALE_SEC)).isoformat()
    n = (db.query(models.TaskEmailQueue)
         .filter(models.TaskEmailQueue.status == "claimed", models.TaskEmailQueue.updated_at < cutoff)
         .update({"status": "pending", "batch_id": ""}, synchronize_session=False))
    if n:
        db.commit()


def _ready_recipients(db: Session, window: int, now: datetime) -> list[str]:
    cutoff = (now - timedelta(minutes=window)).isoformat()
    Q = models.TaskEmailQueue
    rows = (db.query(Q.recipient, func.min(Q.created_at), func.max(Q.urgent))
            .filter(Q.status == "pending").group_by(Q.recipient).all())
    return [r for r, oldest, urgent in rows if urgent or (oldest or "") <= cutoff]


def flush_batches(db: Session, now: datetime | None = None) -> int:
    """Send every batch whose window is up. Returns the number of emails sent.
    Safe to run from several workers at once: a person's rows are claimed
    under FOR UPDATE SKIP LOCKED before anything is sent."""
    now = now or datetime.now(timezone.utc)
    _reclaim_stale(db, now)
    cfg = get_settings(db)
    sent = 0
    for recipient in _ready_recipients(db, batch_window_minutes(cfg), now):
        try:
            sent += _flush_recipient(db, recipient, cfg, now)
        except Exception:
            db.rollback()
    return sent


def _flush_recipient(db: Session, recipient: str, cfg: dict, now: datetime) -> int:
    Q = models.TaskEmailQueue
    rows = (db.query(Q).filter(Q.recipient == recipient, Q.status == "pending")
            .order_by(Q.created_at).with_for_update(skip_locked=True).all())
    if not rows:
        return 0
    batch_id = str(uuid.uuid4())
    stamp = now.isoformat()
    for q in rows:
        q.status, q.batch_id, q.updated_at = "claimed", batch_id, stamp
    db.commit()

    p = prefs_mod.load(db, recipient)
    tasks = {}
    kept = []
    for q in rows:
        if q.task_id not in tasks:
            tasks[q.task_id] = db.query(models.Task).filter(models.Task.id == q.task_id).first()
        reason = _drop_reason(db, q, tasks[q.task_id], p)
        if reason:
            q.status, q.drop_reason, q.updated_at = "dropped", reason, stamp
        else:
            kept.append(q)
    if not kept:
        db.commit()
        return 0

    logo_url = cfg.get("logoUrl") or ""
    if len(kept) == 1:
        q = kept[0]
        t = tasks[q.task_id]
        ctx = _task_context(db, t, q.actor_email)
        rendered = _render_event(db, ctx, q.event_type, recipient, q.role, logo_url, q.payload or {})
        if rendered:
            subject, html = rendered
            _send_one(db, task_id=t.id, task_code=t.code, event_type=q.event_type,
                      idem_suffix=f"batch-{batch_id}", recipient=recipient, role=q.role,
                      subject=subject, html=html, cfg=cfg)
    else:
        names = {}

        def name_of(email):
            if email not in names:
                names[email] = _name_of(db, email) if email else "Someone"
            return names[email]

        order, by_task = [], {}
        for q in kept:
            if q.task_id not in by_task:
                order.append(q.task_id)
                by_task[q.task_id] = []
            by_task[q.task_id].append(q)
        items = []
        for tid in order:
            t = tasks[tid]
            items.append({"t": _task_context(db, t, by_task[tid][0].actor_email),
                          "lines": _task_lines(by_task[tid], name_of),
                          "links": mail_actions.task_links_html(t.id, recipient, done=bool(t.completed))})
        actors = {q.actor_email for q in kept}
        all_assigned = all(q.event_type in ("assigned", "created") and q.role == "assignee" for q in kept)
        headline = (f"{name_of(next(iter(actors)))} assigned you {len(items)} tasks"
                    if all_assigned and len(actors) == 1 else "")
        subject, html = tmpl.batch_email(items=items, base_url=app_url(), logo_url=logo_url,
                                         recipient_name=_name_of(db, recipient), headline=headline,
                                         window_minutes=batch_window_minutes(cfg))
        html = html.replace(mail_actions.FOOTER_SLOT, mail_actions.footer_links_html())
        _send_one(db, task_id="", task_code="", event_type="batch", idem_suffix=batch_id,
                  recipient=recipient, role=kept[0].role, subject=subject, html=html, cfg=cfg)
    for q in kept:
        q.status, q.sent_at, q.updated_at = "sent", stamp, stamp
    db.commit()
    return 1

