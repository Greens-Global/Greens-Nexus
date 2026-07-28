"""Ticket Notification workflow (Jul 2026) - Outlook email side-effects for
ticket lifecycle events, plus the background retry and auto-close loops.

Kept out of routers/tickets.py so that file doesn't balloon further:
tickets.py calls `notify_ticket_event(...)` via FastAPI `BackgroundTasks`
after each ticket mutation has already committed - email delivery runs after
the HTTP response, and a failure here can never surface as a failed ticket
operation (every entry point below is wrapped so nothing escapes to the
caller). See graph_mail.py for the actual Graph API call and
ticket_mail_templates.py for the HTML.

Settings live in NexusSetting (key="ticket_notify_config", JSON value) -
the same "small admin config" pattern timeclock.py uses for auto-lunch rules.
Delivery state lives in TicketEmailLog (models.py) - one row per
(ticket, event, recipient) attempt; idempotency_key prevents ever sending the
same event to the same person twice, including across a mid-send restart.
"""
import asyncio
import json
import uuid
from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

import models
from database import SessionLocal
import graph_mail
import ticket_mail_templates as tmpl
from routers.task_util import log_activity

from app_url import app_url
_APP_URL = app_url()   # NEXUS_APP_URL override, else derived per environment - see app_url.py
_SETTINGS_KEY = "ticket_notify_config"

_DEFAULT_SETTINGS = {
    "fromMailbox":      "",     # blank = fall back to graph_mail.DEFAULT_FROM_EMAIL (NEXUS_FROM_EMAIL env var)
    "ticketAdminEmail": "",     # fallback recipient when a department has no lead/backup
    "defaultCc":        [],
    "replyTo":           "",
    "autoCloseDays":     5,     # 0 = never auto-close
    "logoUrl":           "",
    "commentsTrigger":   True,
    "attachmentsTrigger": True,
    "enabledEvents": {
        "created": True, "assigned": True, "updated": True,
        "resolved": True, "reopened": True, "approval_required": True,
    },
}

MAX_ATTEMPTS = 5
_RETRY_LOOP_SEC = 5 * 60      # how often the retry/auto-close loop wakes up
_STALE_PENDING_SEC = 5 * 60   # a "pending" row older than this is treated as lost (server restarted mid-send)


# ── Settings ───────────────────────────────────────────────────────────────

def get_settings(db: Session) -> dict:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    if not row or not row.value:
        return json.loads(json.dumps(_DEFAULT_SETTINGS))   # deep copy
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
    """False for blank/malformed addresses and known inactive/offboarded
    employees. An email with no NexusEmployee record at all is allowed
    through (unknown, not "known inactive") - most people who can raise or
    own a ticket already have a role/employee row, but this must not become
    a silent block for the ones who don't."""
    email = (email or "").strip().lower()
    if not email or "@" not in email or " " in email:
        return False
    emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == email).first()
    return not (emp and emp.status in ("inactive", "offboarded"))


def _is_punched_in(db: Session, email: str) -> bool:
    """True if `email`'s most recent non-voided punch leaves them on the
    clock (in, or on break) rather than punched out or never punched in.
    Mirrors timeclock.py's own state machine (_allowed_kinds): the next
    allowed action is 'in' only when nobody is currently clocked in, i.e.
    the last punch is missing or was 'out'."""
    if not email:
        return False
    last = (db.query(models.TimePunch)
            .filter(models.TimePunch.employee_email == email.lower(), models.TimePunch.voided == 0)
            .order_by(models.TimePunch.at.desc()).first())
    return bool(last) and last.kind != "out"


def _dept_recipients(db: Session, hr_department_id: str) -> list[str]:
    """Who to notify to triage/assign a ticket for this department. The lead
    is the primary owner; the backup is ALSO notified whenever the lead isn't
    currently punched in - a ticket must never sit waiting on someone who
    isn't at their desk to see it, or the SLA clock runs out unnoticed.
    Returns [] if neither lead nor backup is usable (caller falls back to
    the Ticket Administrator)."""
    if not hr_department_id:
        return []
    dept = db.query(models.HrDepartment).filter(models.HrDepartment.id == hr_department_id).first()
    if not dept:
        return []
    lead = (dept.lead_email or "").strip().lower()
    backup = (dept.backup_email or "").strip().lower()
    lead_ok = bool(lead) and _is_sendable(db, lead)
    backup_ok = bool(backup) and _is_sendable(db, backup)
    if lead_ok and _is_punched_in(db, lead):
        return [lead]
    return [e for e, ok in ((lead, lead_ok), (backup, backup_ok)) if ok]


def _recipients_for(db: Session, t: models.TaskTicket, event_type: str, cfg: dict) -> list[tuple[str, str]]:
    """Returns deduped [(email, role)] for an event. `role` labels the log/audit
    entry (requester|dept_head|assignee|ticket_admin) - it does not change what
    the recipient receives (that's decided per-recipient when building the
    email body, e.g. the assignee's copy has an extra "action required" line)."""
    out: dict[str, str] = {}   # email -> role (first role wins if somehow doubled up)

    def add(email: str, role: str):
        email = (email or "").strip().lower()
        if email and _is_sendable(db, email) and email not in out:
            out[email] = role

    requester = (t.requester_email or "").strip().lower()
    assignee = (t.assignee_email or "").strip().lower()
    dept_heads = _dept_recipients(db, t.hr_department_id)
    if not dept_heads and t.hr_department_id:
        # Spec requirement: no department lead configured -> notify the Ticket
        # Administrator instead, and record the gap.
        admin = (cfg.get("ticketAdminEmail") or "").strip().lower()
        if admin:
            dept_heads = [admin]
        log_activity(db, type="notify_gap", actor_email="system", entity_kind="ticket",
                     entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                     detail=f"Department has no lead/backup configured - routed to {'Ticket Administrator' if admin else 'nobody (Ticket Administrator not configured either)'}")

    def add_dept_heads():
        # Both lead and backup only when the lead isn't currently punched
        # in - otherwise just the lead - so a ticket never sits waiting on
        # someone who isn't at their desk (missing this risks the SLA).
        for email in dept_heads:
            add(email, "dept_head")

    if event_type in ("created",):
        add(requester, "requester")
        # Approval gate: a ticket awaiting approval must not reach the department
        # lead yet - their "needs assignment" copy is queued by decide_approval
        # once the approver approves (mirrors the in-app bell gate in tickets.py).
        if (t.approval_status or "none") != "pending":
            add_dept_heads()
    elif event_type == "assigned":
        add(requester, "requester")
        add_dept_heads()
        add(assignee, "assignee")
    elif event_type == "updated":
        add(requester, "requester")   # spec: update emails go to the end user only
    elif event_type == "resolved":
        add(requester, "requester")
        add_dept_heads()
        add(assignee, "assignee")
    elif event_type == "reopened":
        add_dept_heads()
        add(assignee, "assignee")
        add(requester, "requester")
    elif event_type == "approval_required":
        # Only the approver - this is their personal action item.
        add((t.approver_email or "").strip().lower(), "approver")

    return list(out.items())


# ── Idempotency + delivery ─────────────────────────────────────────────────

def _next_event_version(db: Session, ticket_id: str, event_type: str) -> int:
    last = (db.query(models.TicketEmailLog)
            .filter(models.TicketEmailLog.ticket_id == ticket_id, models.TicketEmailLog.event_type == event_type)
            .order_by(models.TicketEmailLog.event_version.desc()).first())
    return (last.event_version + 1) if last else 1


def _send_one(db: Session, *, t: models.TaskTicket, event_type: str, event_version: int,
              recipient: str, role: str, subject: str, html: str, cfg: dict) -> None:
    key = f"{t.id}:{event_type}:{event_version}:{recipient}"
    existing = db.query(models.TicketEmailLog).filter(models.TicketEmailLog.idempotency_key == key).first()
    if existing and existing.status in ("sent", "pending"):
        return   # already sent, or another worker is currently sending it

    now = datetime.now(timezone.utc).isoformat()
    row = existing or models.TicketEmailLog(
        id=str(uuid.uuid4()), ticket_id=t.id, ticket_code=t.code, event_type=event_type,
        event_version=event_version, idempotency_key=key, recipient=recipient, recipient_role=role,
        subject=subject, status="pending", attempts=0, created_at=now,
    )
    if not existing:
        db.add(row)
    row.status = "pending"
    row.subject = subject
    row.attempts = (row.attempts or 0) + 1
    row.updated_at = now
    db.commit()

    from_email = (cfg.get("fromMailbox") or graph_mail.DEFAULT_FROM_EMAIL or "").strip()
    cc = [e for e in (cfg.get("defaultCc") or []) if e and e.lower() != recipient]
    try:
        result = graph_mail.send_mail(from_email=from_email, to=[recipient], cc=cc,
                                       subject=subject, html=html, reply_to=cfg.get("replyTo") or "")
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
                 actor_email="system", entity_kind="ticket", entity_id=t.id,
                 entity_code=t.code, entity_title=t.subject, detail=detail)
    db.commit()


def _comment_thread(db: Session, ticket_id: str, limit: int = 3) -> list[dict]:
    """Last `limit` PUBLIC comments on a ticket, newest first, with the author's
    profile photo from Nexus People (nexus_employees.photo_url - the avatars
    bucket is public, so the URLs embed directly in email). Internal agent notes
    are always excluded: update emails go to the requester."""
    rows = (db.query(models.TaskComment)
            .filter(models.TaskComment.task_id == ticket_id,
                    models.TaskComment.internal == False)  # noqa: E712 - SQLA expression
            .order_by(models.TaskComment.created_at.desc()).limit(limit).all())
    emails = list({(r.author_email or "").lower() for r in rows if r.author_email})
    photos: dict[str, str] = {}
    if emails:
        for e, p in (db.query(models.NexusEmployee.work_email, models.NexusEmployee.photo_url)
                     .filter(func.lower(models.NexusEmployee.work_email).in_(emails)).all()):
            photos[(e or "").lower()] = p or ""
    return [{
        "name": _name_of(db, r.author_email or "") or (r.author_email or ""),
        "photoUrl": photos.get((r.author_email or "").lower(), ""),
        "at": _fmt(r.created_at),
        "body": r.body or "",
    } for r in rows]


def _ticket_context(db: Session, t: models.TaskTicket, actor_email: str) -> dict:
    dept_name = ""
    if t.hr_department_id:
        dept = db.query(models.HrDepartment).filter(models.HrDepartment.id == t.hr_department_id).first()
        dept_name = dept.name if dept else ""
    company_name = ""
    if t.company_id:
        company = db.query(models.HrEntity).filter(models.HrEntity.id == t.company_id).first()
        company_name = company.name if company else ""
    return {
        "id": t.id, "code": t.code or "", "subject": t.subject, "status": t.status,
        "description": t.description or "", "priority": t.priority,
        "companyName": company_name,
        "departmentName": dept_name, "typeLabel": (t.type or "request").replace("_", " ").title(),
        "requesterId": t.requester_email or "", "requesterName": _name_of(db, t.requester_email or ""),
        "assigneeId": t.assignee_email or "", "assigneeName": _name_of(db, t.assignee_email or ""),
        "actorEmail": actor_email, "actorName": _name_of(db, actor_email),
        "createdAtDisplay": _fmt(t.created_at), "eventAtDisplay": _fmt(datetime.now(timezone.utc).isoformat()),
        "dueDateDisplay": _fmt(t.sla_due_on) if t.sla_due_on else "",
        "resolutionLabel": (t.resolution or "").replace("_", " ").title(),
        "resolutionDuration": _duration(t.created_at, t.resolved_at) if t.resolved_at else "",
    }


def _fmt(iso: str) -> str:
    if not iso:
        return ""
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return d.strftime("%b %d, %Y %I:%M %p UTC")
    except ValueError:
        return iso[:10]


def _duration(start_iso: str, end_iso: str) -> str:
    try:
        start = datetime.fromisoformat(start_iso.replace("Z", "+00:00"))
        end = datetime.fromisoformat(end_iso.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return ""
    delta = end - start
    hours = delta.total_seconds() / 3600
    if hours < 1:
        return f"{int(delta.total_seconds() / 60)} min"
    if hours < 48:
        return f"{hours:.1f} hours"
    return f"{hours / 24:.1f} days"


# ── Main entry point - called from routers/tickets.py via BackgroundTasks ──

def notify_ticket_event(ticket_id: str, event_type: str, actor_email: str, **kw) -> None:
    """event_type ∈ created|assigned|updated|resolved|reopened|approval_required.
    kw: prev_status, update_kind, latest_comment, reopen_reason (all optional,
    only relevant to specific event types - see ticket_mail_templates.py).
    Never raises - this runs in a background task after the ticket mutation's
    response has already been sent; a notification failure must never surface
    as a failed ticket operation."""
    db = SessionLocal()
    try:
        t = db.query(models.TaskTicket).filter(models.TaskTicket.id == ticket_id).first()
        if not t:
            return
        cfg = get_settings(db)
        if not cfg["enabledEvents"].get(event_type, True):
            return
        if event_type == "updated" and t.status in ("resolved", "closed"):
            return   # spec: update emails stop once the ticket is resolved

        recipients = _recipients_for(db, t, event_type, cfg)
        # only_roles: caller wants a subset (e.g. decide_approval re-queues
        # "created" for just the dept_head after releasing the approval gate,
        # without re-emailing the requester their submission receipt).
        only = kw.get("only_roles")
        if only:
            recipients = [(e, r) for e, r in recipients if r in only]
        if not recipients:
            return
        ctx = _ticket_context(db, t, actor_email)
        ctx["autoCloseDays"] = cfg.get("autoCloseDays") or 0
        version = _next_event_version(db, ticket_id, event_type)
        logo_url = cfg.get("logoUrl") or ""

        for recipient, role in recipients:
            if event_type == "created":
                subject, html = (tmpl.created_email_requester(t=ctx, base_url=_APP_URL, logo_url=logo_url)
                                  if role == "requester" else
                                  tmpl.created_email_dept_head(t=ctx, base_url=_APP_URL, logo_url=logo_url))
            elif event_type == "assigned":
                subject, html = tmpl.assigned_email(t=ctx, base_url=_APP_URL, logo_url=logo_url,
                                                     audience="assignee" if role == "assignee" else "other")
            elif event_type == "updated":
                # Comment updates render as a conversation thread (avatars + full
                # bodies, newest first) instead of a details table.
                thread = (_comment_thread(db, t.id)
                          if kw.get("update_kind") == "New comment added" else None)
                subject, html = tmpl.update_email(t=ctx, base_url=_APP_URL, logo_url=logo_url,
                                                   update_kind=kw.get("update_kind", "Ticket updated"),
                                                   prev_status=kw.get("prev_status", ""),
                                                   latest_comment=kw.get("latest_comment", ""),
                                                   thread=thread)
            elif event_type == "resolved":
                subject, html = tmpl.resolved_email(t=ctx, base_url=_APP_URL, logo_url=logo_url,
                                                     audience="requester" if role == "requester" else "other")
            elif event_type == "reopened":
                subject, html = tmpl.reopened_email(t=ctx, base_url=_APP_URL, logo_url=logo_url,
                                                     reason=kw.get("reopen_reason", ""))
            elif event_type == "approval_required":
                subject, html = tmpl.approval_email(t=ctx, base_url=_APP_URL, logo_url=logo_url)
            else:
                continue
            _send_one(db, t=t, event_type=event_type, event_version=version,
                      recipient=recipient, role=role, subject=subject, html=html, cfg=cfg)
    except Exception as e:
        try:
            log_activity(db, type="notify_error", actor_email="system", entity_kind="ticket",
                         entity_id=ticket_id, entity_code="", entity_title="",
                         detail=f"Notification pipeline error ({event_type}): {e}")
            db.commit()
        except Exception:
            pass
    finally:
        db.close()


# ── Background loops (main.py starts these the same way it starts
#    reminders.reminders_loop - a bare asyncio loop; no task-queue library
#    exists in this codebase to hook into instead) ───────────────────────────

def _retry_failed_once(db: Session) -> None:
    cutoff = datetime.now(timezone.utc)
    rows = (db.query(models.TicketEmailLog)
            .filter(models.TicketEmailLog.status.in_(["failed", "pending"]),
                    models.TicketEmailLog.attempts < MAX_ATTEMPTS).all())
    for row in rows:
        if row.status == "pending":
            try:
                started = datetime.fromisoformat(row.updated_at.replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                started = cutoff
            if (cutoff - started).total_seconds() < _STALE_PENDING_SEC:
                continue   # a send may genuinely be in flight right now - leave it
        t = db.query(models.TaskTicket).filter(models.TaskTicket.id == row.ticket_id).first()
        if not t:
            row.status = "failed"
            row.error = "Ticket no longer exists"
            db.commit()
            continue
        cfg = get_settings(db)
        from_email = (cfg.get("fromMailbox") or graph_mail.DEFAULT_FROM_EMAIL or "").strip()
        cc = [e for e in (cfg.get("defaultCc") or []) if e and e.lower() != row.recipient]
        row.status = "retrying"
        row.attempts += 1
        row.updated_at = datetime.now(timezone.utc).isoformat()
        db.commit()
        # The original HTML isn't stored (would roughly double the table's
        # size for every ticket email ever sent); a retry re-renders it from
        # current ticket state, which is a closer-to-reality re-send anyway
        # if something changed in the intervening minutes.
        ctx = _ticket_context(db, t, row.recipient)
        try:
            subject, html = _rebuild_email(row.event_type, ctx, row.recipient_role, cfg)
            result = graph_mail.send_mail(from_email=from_email, to=[row.recipient], cc=cc,
                                           subject=row.subject or subject, html=html, reply_to=cfg.get("replyTo") or "")
            row.status = "sent"
            row.graph_message_id = result.get("messageId", "")
            row.conversation_id = result.get("conversationId", "")
            row.internet_message_id = result.get("internetMessageId", "")
            row.error = ""
            log_activity(db, type="notify_sent", actor_email="system", entity_kind="ticket",
                         entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                         detail=f"Retry succeeded - {row.event_type} email sent to {row.recipient}")
        except graph_mail.GraphMailError as e:
            row.status = "failed" if row.attempts < MAX_ATTEMPTS else "failed"
            row.error = str(e)[:1000]
            log_activity(db, type="notify_failed", actor_email="system", entity_kind="ticket",
                         entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                         detail=f"Retry {row.attempts}/{MAX_ATTEMPTS} failed for {row.recipient}: {row.error[:200]}")
        row.updated_at = datetime.now(timezone.utc).isoformat()
        db.commit()


def _rebuild_email(event_type: str, ctx: dict, role: str, cfg: dict) -> tuple[str, str]:
    logo_url = cfg.get("logoUrl") or ""
    if event_type == "created":
        return (tmpl.created_email_requester(t=ctx, base_url=_APP_URL, logo_url=logo_url) if role == "requester"
                else tmpl.created_email_dept_head(t=ctx, base_url=_APP_URL, logo_url=logo_url))
    if event_type == "assigned":
        return tmpl.assigned_email(t=ctx, base_url=_APP_URL, logo_url=logo_url, audience="assignee" if role == "assignee" else "other")
    if event_type == "resolved":
        return tmpl.resolved_email(t=ctx, base_url=_APP_URL, logo_url=logo_url, audience="requester" if role == "requester" else "other")
    if event_type == "reopened":
        return tmpl.reopened_email(t=ctx, base_url=_APP_URL, logo_url=logo_url, reason="")
    return tmpl.update_email(t=ctx, base_url=_APP_URL, logo_url=logo_url, update_kind="Ticket updated")


def _auto_close_once(db: Session) -> None:
    cfg = get_settings(db)
    days = cfg.get("autoCloseDays") or 0
    if not days:
        return
    now = datetime.now(timezone.utc)
    candidates = db.query(models.TaskTicket).filter(models.TaskTicket.status == "resolved").all()
    for t in candidates:
        if not t.resolved_at:
            continue
        try:
            resolved = datetime.fromisoformat(t.resolved_at.replace("Z", "+00:00"))
        except ValueError:
            continue
        if (now - resolved).total_seconds() < days * 86400:
            continue
        t.status = "closed"
        t.modified_at = now.isoformat()
        db.commit()
        log_activity(db, type="auto_closed", actor_email="system", entity_kind="ticket",
                     entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                     detail=f"Auto-closed after {days} day(s) in Resolved with no reopen")


async def ticket_notify_loop() -> None:
    """Started once from main.py's lifespan, same convention as
    reminders.reminders_loop - retries failed/stuck sends and auto-closes
    long-resolved tickets on a fixed interval."""
    await asyncio.sleep(60)   # let startup finish before the first scan
    while True:
        db = SessionLocal()
        try:
            _retry_failed_once(db)
            _auto_close_once(db)
        except Exception:
            pass   # a scan failure must not kill the loop - next tick tries again
        finally:
            db.close()
        await asyncio.sleep(_RETRY_LOOP_SEC)
