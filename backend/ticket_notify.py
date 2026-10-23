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

import email_theme
import models
from database import SessionLocal
import graph_mail
import ticket_mail_templates as tmpl
import ticket_inbound_parse
from routers.task_util import log_activity

from app_url import app_url
_SETTINGS_KEY = "ticket_notify_config"

_DEFAULT_SETTINGS = {
    "fromMailbox":      "",     # blank = fall back to graph_mail.DEFAULT_FROM_EMAIL (NEXUS_FROM_EMAIL env var)
    "agentEmails":      [],     # the service desk - who new tickets go to (see ticket_agents)
    # Multi-company desks (Aug 2026): {HrEntity.id: [email, ...]}. A ticket's
    # own company_id (stamped from the requester's People record at creation -
    # see company_for in routers/tickets.py) picks its roster from here FIRST;
    # `agentEmails` above is the fallback for a company with no roster of its
    # own, and stays the everything-fallback for a workspace running as one
    # company that has never touched this. Same shape as `agentEmails` - one
    # flat list per key, no per-company nesting of the other settings below.
    "agentEmailsByCompany": {},
    "ticketAdminEmail": "",     # last-resort recipient when no agent is available to notify
    "defaultCc":        [],
    "replyTo":           "",
    "autoCloseDays":     5,     # 0 = never auto-close
    "logoUrl":           "",
    "commentsTrigger":   True,
    "attachmentsTrigger": True,
    "enabledEvents": {
        "created": True, "assigned": True, "updated": True,
        "resolved": True, "reopened": True, "approval_required": True,
        "escalated": True,
        # Due-date / overdue reminders to the assignee (ticket_overdue.py).
        # Off by default: they go out from managers' Teams accounts.
        "overdue_reminder": False,
        # SLA breach alerts (ticket_sla.scan_breaches): the bell, to the
        # assignee (or the desk) and the department lead. ON by default.
        "sla_breach": True,
        # The Monday Weekly Ticket Report email to desk supervisors
        # (ticket_reports.py, Oct 2026). ON by default; each person can
        # also opt out on the Reports tab.
        "weekly_report": True,
    },
    # Email to ticket (Oct 2026, ticket_inbound.py). Off by default: reading
    # the mailbox marks its mail read and files it away. While on, every
    # ticket email's Reply-To is that mailbox's signed per-ticket address.
    "inboundEnabled":    False,
    "inboundMailbox":    "",    # the support mailbox read, e.g. support@...; never the Tasks one
    # {HrEntity.id: HrDepartment.id} - where a NEW ticket from an email goes,
    # per the sender's company. No entry = refused ("no default department").
    "inboundDefaultDepartment": {},
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


def _dedupe(emails: list[str]) -> list[str]:
    seen, out = set(), []
    for email in emails:
        email = (email or "").strip().lower()
        if email and email not in seen:
            seen.add(email)
            out.append(email)
    return out


def _administrators(db: Session) -> list[str]:
    return [r.email for r in db.query(models.NexusRole)
            .filter(models.NexusRole.role.in_(["administrator", "owner"])).all()]


def ticket_agents(db: Session, cfg: dict | None = None, company_id: str | None = None) -> list[str]:
    """The service desk: who new tickets go to for assignment and everything
    that follows. Chosen in Ticket -> Manage, not derived from anything.

    Two earlier answers to "who owns an incoming ticket" were both wrong. The
    department lead was wrong because a ticket is filed against the department
    it is ABOUT, which is rarely the one that resolves it. Falling back to every
    administrator was wrong the other way: running the service desk and holding
    app-wide admin are different jobs, and tying them meant you had to hand
    someone administrator - the whole application - to let them triage tickets.

    Multi-company desks (Aug 2026): pass the ticket's `company_id` and, if that
    company has its own roster in `agentEmailsByCompany`, it wins over the flat
    `agentEmails` list - a Greens India ticket should not page a Greens US
    agent who cannot act on it and has no context for it. `company_id=None`
    (or a company with no roster of its own) falls through to `agentEmails`
    unchanged, so single-company workspaces and every existing caller that
    doesn't pass one are unaffected.

    An empty result at every level falls back to the administrators rather
    than nobody, so a workspace that has not configured a desk yet still
    routes its tickets somewhere a human will see them.

    THE one definition of the desk. routers/tickets.py drives the in-app bell
    from this same function - the two channels must never disagree about who
    owns a ticket."""
    cfg = cfg if cfg is not None else get_settings(db)
    configured = []
    if company_id:
        configured = list((cfg.get("agentEmailsByCompany") or {}).get(company_id) or [])
    if not configured:
        configured = list(cfg.get("agentEmails") or [])
    if not configured:
        configured = _administrators(db)
    return _dedupe(configured)


def all_agents(db: Session, cfg: dict | None = None) -> list[str]:
    """Every configured agent across every company, plus the flat fallback
    list - the union used for "is this person on desk AT ALL" checks (queue
    visibility) that have no single ticket, and so no single company, to
    scope to. Per-ticket routing uses `ticket_agents(..., company_id=...)`
    instead - this is deliberately broader."""
    cfg = cfg if cfg is not None else get_settings(db)
    configured = list(cfg.get("agentEmails") or [])
    for roster in (cfg.get("agentEmailsByCompany") or {}).values():
        configured.extend(roster or [])
    if not configured:
        configured = _administrators(db)
    return _dedupe(configured)


def _agent_recipients(db: Session, cfg: dict, company_id: str | None = None) -> list[str]:
    """ticket_agents, minus anyone we must not email (inactive/offboarded)."""
    return [e for e in ticket_agents(db, cfg, company_id) if _is_sendable(db, e)]


def _recipients_for(db: Session, t: models.TaskTicket, event_type: str, cfg: dict) -> list[tuple[str, str]]:
    """Returns deduped [(email, role)] for an event. `role` labels the log/audit
    entry (requester|it_admin|assignee|ticket_admin) - it does not change what
    the recipient receives (that's decided per-recipient when building the
    email body, e.g. the assignee's copy has an extra "action required" line)."""
    out: dict[str, str] = {}   # email -> role (first role wins if somehow doubled up)

    def add(email: str, role: str):
        email = (email or "").strip().lower()
        if email and _is_sendable(db, email) and email not in out:
            out[email] = role

    requester = (t.requester_email or "").strip().lower()
    assignee = (t.assignee_email or "").strip().lower()
    agents = _agent_recipients(db, cfg, t.company_id)
    if not agents:
        # No desk configured, no administrators either, or none of them is
        # sendable. The configured Ticket Administrator is the last resort so a
        # ticket is never emailed to nobody, and the gap is logged either way.
        admin = (cfg.get("ticketAdminEmail") or "").strip().lower()
        if admin:
            agents = [admin]
        log_activity(db, type="notify_gap", actor_email="system", entity_kind="ticket",
                     entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                     detail=f"No ticket agent available to notify - routed to {'the Ticket Administrator' if admin else 'nobody (Ticket Administrator not configured either)'}")

    def add_it_admins():
        for email in agents:
            add(email, "it_admin")

    if event_type in ("created",):
        add(requester, "requester")
        # Approval gate: the "needs assignment" copy is held back while a request
        # is parked, and queued by decide_approval once approved - mirroring the
        # in-app bell gate in tickets.py. (Routing it for approval is its own
        # event; this one is about assigning.)
        if (t.approval_status or "none") != "pending":
            add_it_admins()
    elif event_type == "assigned":
        add(requester, "requester")
        add_it_admins()
        add(assignee, "assignee")
    elif event_type == "updated":
        add(requester, "requester")   # spec: update emails go to the end user only
    elif event_type == "resolved":
        add(requester, "requester")
        add_it_admins()
        add(assignee, "assignee")
    elif event_type == "reopened":
        add_it_admins()
        add(assignee, "assignee")
        add(requester, "requester")
    elif event_type == "approval_required":
        # Only the approver - this is their personal action item.
        add((t.approver_email or "").strip().lower(), "approver")
    elif event_type == "escalated":
        # The department the ticket is ABOUT, not whoever's working it - see
        # escalate_ticket in routers/tickets.py. No head on file (or no
        # department at all) falls back to the desk so it's never silent.
        dept = (db.query(models.TicketDepartment).filter(models.TicketDepartment.id == t.hr_department_id).first()
                if t.hr_department_id else None)
        # The head is the department's own (one head everywhere, Oct 15 2026); the backup is the desk's.
        live = (db.query(models.HrDepartment).filter(models.HrDepartment.id == t.hr_department_id).first()
                if t.hr_department_id else None)
        heads = [e for e in [(live.lead_email if live else ""), (dept.backup_email if dept else "")] if e]
        if heads:
            for h in heads:
                add(h, "dept_head")
        else:
            add_it_admins()
            log_activity(db, type="notify_gap", actor_email="system", entity_kind="ticket",
                         entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                         detail="Escalated but no department head is set - routed to the service desk instead")

    return list(out.items())


# ── Idempotency + delivery ─────────────────────────────────────────────────

def _next_event_version(db: Session, ticket_id: str, event_type: str) -> int:
    last = (db.query(models.TicketEmailLog)
            .filter(models.TicketEmailLog.ticket_id == ticket_id, models.TicketEmailLog.event_type == event_type)
            .order_by(models.TicketEmailLog.event_version.desc()).first())
    return (last.event_version + 1) if last else 1


_CLAIM_TRIES = 5


def _claim_rows(db: Session, t: models.TaskTicket, event_type: str, actor_email: str,
                mails: list) -> list:
    """Insert one pending log row per (recipient, role, subject, html) for a
    NEW event version, and return them. The version is claimed by the insert
    itself: two quick events of the same type on one ticket (two replies a
    second apart) used to read the same "next" version, build the same
    idempotency key, and the second email was silently dropped as "already
    sent". The key is unique, so a racing insert fails, rolls back and takes
    the next version instead."""
    from sqlalchemy.exc import IntegrityError
    for _ in range(_CLAIM_TRIES):
        version = _next_event_version(db, t.id, event_type)
        now = datetime.now(timezone.utc).isoformat()
        rows = [models.TicketEmailLog(
            id=str(uuid.uuid4()), ticket_id=t.id, ticket_code=t.code, event_type=event_type,
            event_version=version, idempotency_key=f"{t.id}:{event_type}:{version}:{recipient}",
            recipient=recipient, recipient_role=role, subject=subject, html=html,
            actor_email=(actor_email or "").strip().lower(), status="pending", attempts=0,
            created_at=now, updated_at=now) for recipient, role, subject, html in mails]
        db.add_all(rows)
        try:
            db.commit()
            return rows
        except IntegrityError:
            db.rollback()
    return []


# A row moves pending/failed -> "sending" through ONE conditional UPDATE, so
# exactly one worker sends it: the request's background task working through
# its recipients (one slow Graph call each) and the retry sweep looking for
# stale rows can no longer both pick up the same row and email it twice.
_IN_FLIGHT = ("pending", "sending", "retrying")   # "retrying": rows from before the claim existed


def _claim_send(db: Session, row: models.TicketEmailLog, expect_status: str,
                expect_updated: str | None = None) -> bool:
    """Take the row for one send attempt: status -> "sending", the claim time
    in updated_at (what the stale sweep measures), attempts + 1. Only when
    it is still in `expect_status` (and, for a stale row, still carries the
    updated_at the sweep saw). False = someone else has it."""
    q = db.query(models.TicketEmailLog).filter(models.TicketEmailLog.id == row.id,
                                               models.TicketEmailLog.status == expect_status)
    if expect_updated is not None:
        q = q.filter(models.TicketEmailLog.updated_at == expect_updated)
    n = q.update({"status": "sending", "updated_at": datetime.now(timezone.utc).isoformat(),
                  "attempts": func.coalesce(models.TicketEmailLog.attempts, 0) + 1},
                 synchronize_session=False)
    db.commit()
    if n:
        db.refresh(row)
    return bool(n)


def _finish_send(db: Session, row: models.TicketEmailLog, result: dict | None, error: str = "") -> None:
    """Record how a claimed send went. The stored body is kept only while a
    retry may still need it: cleared once sent, and once the last attempt
    has failed."""
    if result is not None:
        row.status = "sent"
        row.graph_message_id = result.get("messageId", "")
        row.conversation_id = result.get("conversationId", "")
        row.internet_message_id = result.get("internetMessageId", "")
        row.error = ""
        row.html = ""
    else:
        row.status = "failed"
        row.error = (error or "")[:1000]
        if (row.attempts or 0) >= MAX_ATTEMPTS:
            row.html = ""
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()


def _graph_send(row: models.TicketEmailLog, cfg: dict, subject: str, html: str) -> dict:
    from_email = (cfg.get("fromMailbox") or graph_mail.DEFAULT_FROM_EMAIL or "").strip()
    cc = [e for e in (cfg.get("defaultCc") or []) if e and e.lower() != row.recipient]
    # Inbound on: the signed per-ticket address, so a reply comes back to this
    # ticket (ticket_inbound_parse.outbound_reply_to); off: replyTo as ever.
    return graph_mail.send_mail(from_email=from_email, to=[row.recipient], cc=cc,
                                subject=subject, html=html,
                                reply_to=ticket_inbound_parse.outbound_reply_to(cfg, row.ticket_id))


def _deliver_row(db: Session, row: models.TicketEmailLog, t: models.TaskTicket, cfg: dict,
                 expect_status: str = "pending") -> None:
    """One send attempt for a row, if this worker wins the claim."""
    if not _claim_send(db, row, expect_status):
        return
    try:
        _finish_send(db, row, _graph_send(row, cfg, row.subject, row.html or ""))
        detail = f"{row.event_type.title()} email sent to {row.recipient} ({row.recipient_role})"
    except graph_mail.GraphMailError as e:
        _finish_send(db, row, None, str(e))
        detail = (f"{row.event_type.title()} email to {row.recipient} ({row.recipient_role}) failed - "
                  f"will retry: {row.error[:200]}")
    log_activity(db, type="notify_sent" if row.status == "sent" else "notify_failed",
                 actor_email="system", entity_kind="ticket", entity_id=t.id,
                 entity_code=t.code, entity_title=t.subject, detail=detail)
    db.commit()


def _send_one(db: Session, *, t: models.TaskTicket, event_type: str, event_version: int,
              recipient: str, role: str, subject: str, html: str, cfg: dict, actor_email: str = "") -> None:
    """A send under a FIXED version (the walkthrough's one email, version 1):
    a replayed submit finds its row and sends nothing again."""
    key = f"{t.id}:{event_type}:{event_version}:{recipient}"
    existing = db.query(models.TicketEmailLog).filter(models.TicketEmailLog.idempotency_key == key).first()
    if existing and existing.status in ("sent", *_IN_FLIGHT):
        return   # already sent, or another worker is currently sending it

    now = datetime.now(timezone.utc).isoformat()
    row = existing or models.TicketEmailLog(
        id=str(uuid.uuid4()), ticket_id=t.id, ticket_code=t.code, event_type=event_type,
        event_version=event_version, idempotency_key=key, recipient=recipient, recipient_role=role,
        subject=subject, status="pending", attempts=0, created_at=now, updated_at=now,
    )
    if not existing:
        db.add(row)
    row.subject = subject
    row.html = html
    row.actor_email = (actor_email or "").strip().lower()
    db.commit()
    _deliver_row(db, row, t, cfg, expect_status=row.status)


def _comment_thread(db: Session, ticket_id: str, limit: int = 3, zone: str = "") -> list[dict]:
    """Last `limit` PUBLIC comments on a ticket, newest first, with the author's
    profile photo from Nexus People (nexus_employees.photo_url - the avatars
    bucket is public, so the URLs embed directly in email). Internal agent notes
    are always excluded: update emails go to the requester."""
    if clashing_ids(db, [ticket_id]):
        return []
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
        "at": _fmt(r.created_at, zone),
        "body": r.body or "",
    } for r in rows]


def _ticket_context(db: Session, t: models.TaskTicket, actor_email: str, zone: str = "") -> dict:
    dept_name = ""
    if t.hr_department_id:
        dept = db.query(models.TicketDepartment).filter(models.TicketDepartment.id == t.hr_department_id).first()
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
        **_time_fields(t, zone),
        "resolutionLabel": (t.resolution or "").replace("_", " ").title(),
        "resolutionDuration": _duration(t.created_at, t.resolved_at) if t.resolved_at else "",
        "resolutionNote": t.resolution_note or "",
    }


def _time_fields(t: models.TaskTicket, zone: str = "") -> dict:
    """The context's dates and times, in one reader's time zone."""
    return {"createdAtDisplay": _fmt(t.created_at, zone),
            "eventAtDisplay": _fmt(datetime.now(timezone.utc).isoformat(), zone),
            # The deadline is a moment (Honest SLA): date AND time in the
            # reader's zone; a row with no datetime yet shows its old date.
            "dueDateDisplay": _fmt(t.sla_due_at or t.sla_due_on, zone) if (t.sla_due_at or t.sla_due_on) else ""}


_FALLBACK_ZONE = "America/Los_Angeles"


def _zone_for(db: Session, email: str) -> str:
    """The recipient's own time zone (daily_briefing._person_zone: their
    shift preset's zone, else the company default) - an email's times read
    in the reader's clock, never UTC."""
    try:
        import daily_briefing
        return daily_briefing._person_zone(db, (email or "").strip().lower(), daily_briefing.get_settings(db))
    except Exception:
        return _FALLBACK_ZONE


def _fmt(iso: str, zone: str = "") -> str:
    """MM/DD/YYYY for a date; "MM/DD/YYYY 2:15 PM PDT" for a timestamp, in
    `zone` (US 12-hour, with the zone's abbreviation). Never a raw ISO
    string: an unreadable timestamp falls back to its date, else to ""."""
    from datetime import date
    from zoneinfo import ZoneInfo
    if not iso:
        return ""
    raw = str(iso)
    try:
        if len(raw) <= 10:
            return date.fromisoformat(raw).strftime("%m/%d/%Y")
        d = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        try:
            return date.fromisoformat(raw[:10]).strftime("%m/%d/%Y")
        except ValueError:
            return ""
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)   # stored timestamps are UTC
    try:
        tz = ZoneInfo(zone or _FALLBACK_ZONE)
    except Exception:
        tz = ZoneInfo(_FALLBACK_ZONE)
    local = d.astimezone(tz)
    return f"{local.strftime('%m/%d/%Y')} {local.strftime('%I:%M %p').lstrip('0')} {local.strftime('%Z')}"


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

def requester_hears(event_type: str, actor_email: str, requester_email: str, kw: dict | None = None) -> bool:
    """Whether the requester gets an email for this event (Neil, Oct 1 2026 -
    the same policy as their Teams messages, after a requester was messaged
    every time an agent touched her ticket):

    - created:  yes, always - the "we received your ticket" receipt, even
                when they raised it themselves.
    - anything they caused themselves: no (replying, reopening, confirming,
                or resolving their own ticket - the desk and the assignee
                still hear about it).
    - assigned, resolved: yes.
    - updated, reopened: only when the save carried a public reply
                (`latest_comment`) - a status move, priority or field edit
                alone is not mailed.
    Other events (approval_required, escalated) never list the requester."""
    if event_type == "created":
        return True
    if (actor_email or "").strip().lower() == (requester_email or "").strip().lower():
        return False
    if event_type in ("updated", "reopened"):
        return bool((kw or {}).get("latest_comment"))
    return True


def on_desk(db: Session, email: str) -> bool:
    """Does this person work the ticket queue (ticket_roles.can_work_queue,
    built from their stored role like a signed-in user)? Decides whether a
    link sends them to the Tickets module or to Support."""
    import auth
    import ticket_roles
    email = (email or "").strip().lower()
    if not email:
        return False
    try:
        rec = auth._external_record(email) or {}
        who = {"email": email, "level": auth.level_for(email, db), "external": bool(rec.get("external"))}
        return ticket_roles.can_work_queue(who, db)
    except Exception:
        return True   # unknown: the old link


def clashing_ids(db: Session, ids=None) -> set:
    """Ticket ids that are also task ids. Comments and files live in the task
    tables keyed only by id, so such a ticket's "thread" is the task's - it
    is never read as a ticket's (Oct 18 2026 review). `ids`: only these."""
    q = (db.query(models.TaskTicket.id).execution_options(include_deleted=True)
         .join(models.Task, models.Task.id == models.TaskTicket.id))
    if ids is not None:
        ids = list(ids)
        if not ids:
            return set()
        q = q.filter(models.TaskTicket.id.in_(ids))
    return {i for (i,) in q.all()}


def _render(db: Session, t: models.TaskTicket, event_type: str, role: str, ctx: dict, cfg: dict,
            kw: dict, zone: str = "", recipient: str = "") -> tuple | None:
    """(subject, html) for one recipient of one event, or None for an event
    with no email. THE one renderer - the first send and a legacy row's retry
    (one stored before the body was kept) both come through here."""
    logo_url = email_theme.logo_for(db, cfg.get("logoUrl") or "", recipient)
    base = app_url()
    if event_type == "created":
        return (tmpl.created_email_requester(t=ctx, base_url=base, logo_url=logo_url) if role == "requester"
                else tmpl.created_email_triage(t=ctx, base_url=base, logo_url=logo_url))
    if event_type == "assigned":
        return tmpl.assigned_email(t=ctx, base_url=base, logo_url=logo_url,
                                   audience="assignee" if role == "assignee" else "other",
                                   for_requester=role == "requester",
                                   latest_comment=kw.get("latest_comment", ""))
    if event_type == "updated":
        # Comment updates render as a conversation thread (avatars + full
        # bodies, newest first) instead of a details table.
        thread = (_comment_thread(db, t.id, zone=zone)
                  if kw.get("update_kind") == "New comment added" else None)
        return tmpl.update_email(t=ctx, base_url=base, logo_url=logo_url,
                                 update_kind=kw.get("update_kind", "Ticket updated"),
                                 prev_status=kw.get("prev_status", ""),
                                 latest_comment=kw.get("latest_comment", ""),
                                 thread=thread)
    if event_type == "resolved":
        return tmpl.resolved_email(t=ctx, base_url=base, logo_url=logo_url,
                                   audience="requester" if role == "requester" else "other",
                                   latest_comment=kw.get("latest_comment", ""))
    if event_type == "reopened":
        return tmpl.reopened_email(t=ctx, base_url=base, logo_url=logo_url,
                                   reason=kw.get("reopen_reason", ""),
                                   latest_comment=kw.get("latest_comment", ""))
    if event_type == "approval_required":
        return tmpl.approval_email(t=ctx, base_url=base, logo_url=logo_url,
                                   for_requester=bool(recipient) and not on_desk(db, recipient))
    if event_type == "escalated":
        return tmpl.escalated_email(t=ctx, base_url=base, logo_url=logo_url,
                                    audience="dept_head" if role == "dept_head" else "other")
    return None


def notify_ticket_event(ticket_id: str, event_type: str, actor_email: str, **kw) -> None:
    """event_type ∈ created|assigned|updated|resolved|reopened|approval_required|escalated.
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
        if event_type == "updated" and t.status in ("resolved", "closed") and not kw.get("latest_comment"):
            return   # spec: update emails stop once the ticket is resolved - a reply still goes

        recipients = _recipients_for(db, t, event_type, cfg)
        if not requester_hears(event_type, actor_email, t.requester_email or "", kw):
            recipients = [(e, r) for e, r in recipients if r != "requester"]
        # only_roles: caller wants a subset (e.g. decide_approval re-queues
        # "created" for just the IT Admins after releasing the approval gate,
        # without re-emailing the requester their submission receipt).
        only = kw.get("only_roles")
        if only:
            recipients = [(e, r) for e, r in recipients if r in only]
        if not recipients:
            return
        ctx = _ticket_context(db, t, actor_email)
        ctx["autoCloseDays"] = cfg.get("autoCloseDays") or 0

        mails = []
        for recipient, role in recipients:
            zone = _zone_for(db, recipient)
            # Every date and time in the reader's own clock.
            mail = _render(db, t, event_type, role, {**ctx, **_time_fields(t, zone)}, cfg, kw, zone,
                           recipient=recipient)
            if mail is not None:
                mails.append((recipient, role, mail[0], mail[1]))
        for row in _claim_rows(db, t, event_type, actor_email, mails):
            _deliver_row(db, row, t, cfg)
    except Exception as e:
        try:
            db.rollback()
            log_activity(db, type="notify_error", actor_email="system", entity_kind="ticket",
                         entity_id=ticket_id, entity_code="", entity_title="",
                         detail=f"Notification pipeline error ({event_type}): {e}")
            db.commit()
        except Exception:
            pass
    finally:
        db.close()


def _walkthrough_recipients(db: Session, b, tickets: list, cfg: dict, actor: str) -> list:
    """[(email, role)] for a Property Walkthrough's ONE email each. First role
    wins, so someone who is both the requester and an agent hears once."""
    out: dict = {}
    actor = (actor or "").strip().lower()

    def add(email: str, role: str):
        email = (email or "").strip().lower()
        if email and email != actor and email not in out and _is_sendable(db, email):
            out[email] = role

    add(b.requester_email, "requester")              # the receipt - "created" always sends one
    for t in tickets:
        add(t.assignee_email, "assignee")
    add(b.asset_manager_email, "asset_manager")
    if any(not t.assignee_email or (t.approval_status or "none") == "pending" for t in tickets):
        for e in _agent_recipients(db, cfg, b.company_id):
            add(e, "it_admin")
    return list(out.items())


def _walkthrough_mail(db: Session, b, tickets: list, role: str, recipient: str, cfg: dict) -> tuple:
    mine = ([t for t in tickets if (t.assignee_email or "").lower() == recipient]
            if role == "assignee" else tickets)
    rows = [{"id": t.id, "code": t.code, "subject": t.subject, "category": t.application or "",
             "priority": t.priority or "medium", "location": (t.type_fields or {}).get("svc_unit") or "",
             "pending": (t.approval_status or "none") == "pending"} for t in mine]
    return tmpl.walkthrough_email(property_name=b.property_name, property_id=b.property_asset_id,
                                  actor_name=_name_of(db, b.created_by_email), rows=rows, audience=role,
                                  base_url=app_url(), logo_url=email_theme.logo_for(db, cfg.get("logoUrl") or "", recipient))


def notify_walkthrough(batch_id: str, actor_email: str) -> None:
    """ONE email per person for a whole Property Walkthrough (never one per
    line - CLAUDE.md). Background task, own session, never raises - same
    contract as notify_ticket_event. Logged on the first ticket with event
    "walkthrough" and version 1, so _send_one's idempotency key makes a
    replayed submit a no-op."""
    db = SessionLocal()
    try:
        b = db.get(models.TicketBatch, batch_id)
        if b is None or not b.ticket_ids:
            return
        cfg = get_settings(db)
        if not cfg["enabledEvents"].get("created", True):
            return
        tickets = (db.query(models.TaskTicket).filter(models.TaskTicket.id.in_(b.ticket_ids))
                   .order_by(models.TaskTicket.code).all())
        if not tickets:
            return
        for recipient, role in _walkthrough_recipients(db, b, tickets, cfg, actor_email):
            subject, html = _walkthrough_mail(db, b, tickets, role, recipient, cfg)
            _send_one(db, t=tickets[0], event_type="walkthrough", event_version=1,
                      recipient=recipient, role=role, subject=subject, html=html, cfg=cfg,
                      actor_email=actor_email)
    except Exception as e:
        try:
            log_activity(db, type="notify_error", actor_email="system", entity_kind="ticket",
                         entity_id="", entity_code="", entity_title="",
                         detail=f"Walkthrough notification error ({batch_id}): {e}")
            db.commit()
        except Exception:
            pass
    finally:
        db.close()


# ── Background loops (main.py starts these the same way it starts
#    reminders.reminders_loop - a bare asyncio loop; no task-queue library
#    exists in this codebase to hook into instead) ───────────────────────────

def _retry_failed_once(db: Session) -> None:
    now = datetime.now(timezone.utc)
    L = models.TicketEmailLog
    # Failed rows with attempts left, and in-flight rows (pending / sending)
    # whose CLAIM is older than the stale window - the worker died mid-send
    # (a restart, a crash). An in-flight row out of attempts is finalized as
    # failed; a failed row out of attempts still holding a body has it cleared.
    rows = (db.query(L).filter(L.status.in_(["failed", *_IN_FLIGHT]))
            .filter((L.attempts < MAX_ATTEMPTS) | (L.status != "failed") | (func.coalesce(L.html, "") != ""))
            .all())
    for row in rows:
        stale = row.status in _IN_FLIGHT
        if stale:
            try:
                claimed_at = datetime.fromisoformat((row.updated_at or "").replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                claimed_at = now
            if (now - claimed_at).total_seconds() < _STALE_PENDING_SEC:
                continue   # a send may genuinely be in flight right now - leave it
        if (row.attempts or 0) >= MAX_ATTEMPTS:
            q = db.query(L).filter(L.id == row.id, L.status == row.status)
            if stale:
                q = q.filter(L.updated_at == row.updated_at)
            q.update({"status": "failed", "html": "",
                      "error": row.error or "Gave up - the last attempt never finished",
                      "updated_at": now.isoformat()}, synchronize_session=False)
            db.commit()
            continue
        t = db.query(models.TaskTicket).filter(models.TaskTicket.id == row.ticket_id).first()
        if not t:
            row.status = "failed"
            row.error = "Ticket no longer exists"
            row.html = ""
            db.commit()
            continue
        cfg = get_settings(db)
        if not _claim_send(db, row, row.status, row.updated_at if stale else None):
            continue   # another worker took it
        try:
            if row.html:
                # The email exactly as it was first rendered - same content,
                # same actor, same reply text.
                subject, html = row.subject, row.html
            else:
                subject, html = _rebuild_row(db, t, row, cfg)
            _finish_send(db, row, _graph_send(row, cfg, row.subject or subject, html))
            log_activity(db, type="notify_sent", actor_email="system", entity_kind="ticket",
                         entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                         detail=f"Retry succeeded - {row.event_type} email sent to {row.recipient}")
        except graph_mail.GraphMailError as e:
            _finish_send(db, row, None, str(e))
            log_activity(db, type="notify_failed", actor_email="system", entity_kind="ticket",
                         entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                         detail=f"Retry {row.attempts}/{MAX_ATTEMPTS} failed for {row.recipient}: {row.error[:200]}")
        db.commit()


def _rebuild_row(db: Session, t: models.TaskTicket, row: models.TicketEmailLog, cfg: dict) -> tuple[str, str]:
    """A row with no stored body (written before bodies were kept): rebuilt
    from the ticket, with the real actor when the row names one - never the
    recipient as the actor."""
    if row.event_type == "walkthrough" and t.batch_id:
        b = db.get(models.TicketBatch, t.batch_id)
        if b is not None:
            # Rebuilt from the batch - not a generic "Ticket updated" about its first ticket.
            tickets = (db.query(models.TaskTicket).filter(models.TaskTicket.id.in_(b.ticket_ids or []))
                       .order_by(models.TaskTicket.code).all()) or [t]
            return _walkthrough_mail(db, b, tickets, row.recipient_role, row.recipient, cfg)
    zone = _zone_for(db, row.recipient)
    ctx = _ticket_context(db, t, row.actor_email or "", zone)
    ctx["autoCloseDays"] = cfg.get("autoCloseDays") or 0
    return _rebuild_email(row.event_type, ctx, row.recipient_role, cfg, db=db, t=t, zone=zone,
                          recipient=row.recipient)


def _rebuild_email(event_type: str, ctx: dict, role: str, cfg: dict, *, db: Session | None = None,
                   t: models.TaskTicket | None = None, zone: str = "", recipient: str = "") -> tuple[str, str]:
    """Every event type notify_ticket_event sends (approval_required and
    escalated included), rendered by the same _render as the first send. An
    "updated" email is always a reply; an old row's reply text is not known,
    so it shows the ticket's latest public thread."""
    kw = {"update_kind": "New comment added"} if (event_type == "updated" and t is not None) else {}
    mail = _render(db, t, event_type, role, ctx, cfg, kw, zone, recipient=recipient)
    if mail is not None:
        return mail
    return tmpl.update_email(t=ctx, base_url=app_url(), logo_url=email_theme.logo_for(db, cfg.get("logoUrl") or "", recipient),
                             update_kind="Ticket updated")


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
        import ticket_sla
        ticket_sla.set_status(t, "closed", now)
        t.modified_at = now.isoformat()
        db.commit()
        log_activity(db, type="auto_closed", actor_email="system", entity_kind="ticket",
                     entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                     detail=f"Auto-closed after {days} day(s) in Resolved with no reopen")


def _ticket_scan_once() -> None:
    """Blocking body of ticket_notify_loop: synchronous DB queries plus
    Outlook/Graph email retries and auto-close. Run via asyncio.to_thread (see
    the loop) so it never executes on the request event loop - a slow synchronous
    Graph send here would otherwise freeze every request on this worker, CORS
    preflights included, until it returned. Mirrors reminders_loop /
    long_session_loop, which already offload their scans this way."""
    db = SessionLocal()
    try:
        _retry_failed_once(db)
        _auto_close_once(db)
        try:
            import ticket_overdue
            ticket_overdue.run(db)
        except Exception as e:   # reminders must never stop the retries above
            db.rollback()
            print(f"[ticket-overdue] pass failed: {e}")
        try:
            import ticket_sla
            ticket_sla.scan_breaches(db)
        except Exception as e:   # breach alerts must never stop the rest either
            db.rollback()
            print(f"[ticket-sla] breach scan failed: {e}")
    finally:
        db.close()


async def ticket_notify_loop() -> None:
    """Started once from main.py's lifespan, same convention as
    reminders.reminders_loop - retries failed/stuck sends and auto-closes
    long-resolved tickets on a fixed interval. The scan runs in a worker thread
    (asyncio.to_thread) so its blocking DB + Graph I/O never stalls the loop."""
    await asyncio.sleep(60)   # let startup finish before the first scan
    while True:
        try:
            await asyncio.to_thread(_ticket_scan_once)
        except Exception:
            pass   # a scan failure must not kill the loop - next tick tries again
        await asyncio.sleep(_RETRY_LOOP_SEC)
