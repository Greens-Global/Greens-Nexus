"""Tickets pack (Workflows, Oct 28 2026 - plan Task 10): the ticket entity,
the events `routers/task_util.log_activity` emits for it, the actions a
workflow may take on a ticket and the two lists a schedule loops over.

A confidential (Ask HR) ticket is read with `include_confidential=True`
(`load`) and `visible_to` applies the module's own rule - its own people
and HR for its company (`ticket_confidential.may_read`); the desk grant
opens an ordinary ticket, never a confidential one - so nothing about one
ever reaches a workflow owner or a recipient outside its desk (spec 6.5).

Every action calls the Tickets module's OWN function as the run-as user:
Create Ticket through `tickets.file_ticket` (`arrived_by="workflow"`), Add
Comment through `post_ticket_comment`, Assign and Set Status through
`update_ticket`, Request Approval through `request_approval` - so the desk
rules, the SLA clock, the bells and the emails all apply as they do to a
person. `allowed` runs the same permission check and answers with its
reason. Routers are imported lazily inside each function (packs load from
inside a request).
"""
from __future__ import annotations

from datetime import date, datetime, timezone

import models
from workflows.catalog import F, P, action, entity, event, list_source

PRIORITIES = [("urgent", "Urgent"), ("high", "High"), ("medium", "Medium"), ("low", "Low")]
STATUSES = [("open", "Open"), ("in_progress", "In Progress"), ("waiting_user", "Waiting For User"),
            ("waiting_vendor", "Waiting For Vendor"), ("on_hold", "On Hold"), ("resolved", "Resolved"),
            ("closed", "Closed"), ("reopened", "Reopened")]
TYPES = [("incident", "Incident"), ("bug", "Bug"), ("feature_request", "Feature Request"),
         ("access_request", "Access Request"), ("other", "Other")]
APPROVAL = [("none", "Not Needed"), ("pending", "Pending"), ("approved", "Approved"), ("rejected", "Rejected")]
DESKS = [("", "Not Confidential"), ("hr", "HR")]
MAX_LIST = 500


# ── helpers ──────────────────────────────────────────────────────────────────
def _emails(vals) -> list[str]:
    out: list[str] = []
    for v in vals or ():
        for e in str(v or "").split(","):
            e = e.strip().lower()
            if e and e not in out:
                out.append(e)
    return out


def _tk():
    from routers import tickets
    return tickets


def _load(db, ticket_id: str):
    import ticket_confidential
    if not ticket_id:
        return None
    return (ticket_confidential.include(db.query(models.TaskTicket))
            .filter(models.TaskTicket.id == str(ticket_id)).first())


def _assignee(db, row) -> list[str]:
    return _emails([row.assignee_email])


def _requester(db, row) -> list[str]:
    return _emails([row.requester_email])


def _creator(db, row) -> list[str]:
    return _emails([row.created_by_email or row.requester_email])


def _participants(db, row) -> list[str]:
    return _emails(sorted(_tk()._ticket_participants(row)))


def _approver(db, row) -> list[str]:
    return _emails([row.approver_email])


def _ticket_visible(db, user, row) -> bool:
    """The Tickets module's read rule, as `_require_ticket_participant`
    applies it: inside the company wall; a confidential ticket only for its
    own people and HR for its company; otherwise the desk grant or being
    one of the ticket's readers (requester, assignee, watchers, filer, the
    pending approver)."""
    if not user or row is None:
        return False
    import auth
    import ticket_confidential
    tk = _tk()
    scope = auth.company_scope(user, db)
    if scope is not None and not auth.company_ok(row.company_id or "", scope):
        return False
    if ticket_confidential.is_confidential(row):
        return bool(ticket_confidential.may_read(db, user, row))
    if tk._has_desk_grant(user, db):
        return True
    return (user.get("email") or "").strip().lower() in tk._ticket_readers(row)


def _label(row) -> str:
    return (row.subject or "").strip() or (row.code or "") or (row.id or "")


def _nexus_visible(db, row) -> bool:
    """The Nexus system actor never acts on a confidential-desk ticket."""
    import ticket_confidential
    return not ticket_confidential.is_confidential(row)


# ── entity ───────────────────────────────────────────────────────────────────
TICKET_FIELDS = [
    F("title", "Subject", "text", path="subject"),
    F("code", "Code", "text"),
    F("status", "Status", "select", options=STATUSES),
    F("priority", "Priority", "select", options=PRIORITIES),
    F("type", "Type", "select", options="ticket_types"),
    F("department", "Department", "select", options="ticket_departments", path="hr_department_id"),
    F("assignee", "Assignee", "person", path="assignee_email"),
    F("requester", "Requester", "person", path="requester_email"),
    F("created_at", "Filed At", "datetime"),
    F("sla_due", "SLA Due", "datetime", path="sla_due_at"),
    F("approval_status", "Approval", "select", options=APPROVAL),
    F("application", "Application", "text"),
    F("confidential_desk", "Confidential Desk", "select", options=DESKS),
]

entity("ticket", label="Ticket", model=models.TaskTicket, module="tickets",
       company=lambda row: (row.company_id or "").strip(),
       link=lambda row: {"view": "tickets", "ticketId": row.id},
       people={"self": _requester, "assignee": _assignee, "requester": _requester, "participants": _participants,
               "creator": _creator, "approver": _approver},
       fields=TICKET_FIELDS,
       dates=["created_at", "sla_due"],
       load=_load,
       label_of=_label,
       visible_to=_ticket_visible,
       nexus_visible=_nexus_visible,
       # `self` is the requester: the person an approval about the ticket
       # may not decide unless the step allows it (allowSelf)
       people_labels={"self": "The Person (Requester)", "creator": "Filed By"})

SAMPLE_TICKET = {
    "title": "Laptop will not start", "code": "TIC-00318", "status": "open", "priority": "high",
    "type": "incident", "department": "", "assignee": "", "requester": "sam.lee@greensglobal.com",
    "created_at": "2026-10-28T15:04:00+00:00", "sla_due": "2026-10-29T15:04:00+00:00",
    "approval_status": "none", "application": "Nexus", "confidential_desk": "",
}
_ACTOR = "agent.one@greensglobal.com"


def _sample(changes: dict | None = None, extra: dict | None = None, actor: str = _ACTOR, **over) -> dict:
    ex = {"confidentialDesk": ""}
    ex.update(extra or {})
    return {"subject": dict(SAMPLE_TICKET, **over), "changes": dict(changes or {}), "extra": ex, "actor": actor}


# ── events (emitted by routers/task_util.log_activity) ──────────────────────
event("ticket.filed", entity="ticket", label="Ticket Is Filed", module="tickets", group="Tickets",
      sample=_sample(extra={"activity": "created"}, actor="sam.lee@greensglobal.com"))
event("ticket.assigned", entity="ticket", label="Ticket Is Assigned", module="tickets", group="Tickets",
      changes=("assignee",),
      sample=_sample({"assignee": {"from": "", "to": "agent.one@greensglobal.com"}}, {"activity": "assigned"},
                     assignee="agent.one@greensglobal.com", status="in_progress"))
event("ticket.status_changed", entity="ticket", label="Ticket Status Changes", module="tickets", group="Tickets",
      changes=("status",),
      sample=_sample({"status": {"from": "open", "to": "in_progress"}}, {"activity": "status_changed"},
                     status="in_progress"))
event("ticket.resolved", entity="ticket", label="Ticket Is Resolved", module="tickets", group="Tickets",
      changes=("status",),
      sample=_sample({"status": {"from": "in_progress", "to": "resolved"}}, {"activity": "status_changed"},
                     status="resolved"))
event("ticket.reopened", entity="ticket", label="Ticket Is Reopened", module="tickets", group="Tickets",
      changes=("status",),
      sample=_sample({"status": {"from": "resolved", "to": "reopened"}}, {"activity": "status_changed"},
                     status="reopened", actor="sam.lee@greensglobal.com"))
event("ticket.escalated", entity="ticket", label="Ticket Is Escalated", module="tickets", group="Tickets",
      sample=_sample(extra={"activity": "escalated"}, actor="sam.lee@greensglobal.com"))
event("ticket.commented", entity="ticket", label="Ticket Gets A Reply", module="tickets", group="Tickets",
      sample=_sample(extra={"activity": "commented"}))
event("ticket.approval_requested", entity="ticket", label="Ticket Is Sent For Approval", module="tickets",
      group="Tickets",
      sample=_sample(extra={"activity": "approval_requested", "approver": "max.miller@greensglobal.com"},
                     type="access_request", approval_status="pending"))
event("ticket.approval_decided", entity="ticket", label="Ticket Approval Is Decided", module="tickets",
      group="Tickets", changes=("approval_status",),
      sample=_sample({"approval_status": {"from": "pending", "to": "approved"}},
                     {"activity": "approved", "decision": "approve", "note": ""},
                     type="access_request", approval_status="approved", actor="max.miller@greensglobal.com"))


# ── action plumbing ──────────────────────────────────────────────────────────
def _wf_name(ctx) -> str:
    return (getattr(ctx.workflow, "name", "") or "").strip() or "a workflow"


def _render(ctx, text) -> str:
    from workflows.context import render
    out, _ = render(str(text or ""), ctx)
    return out.strip()


def _run_as(ctx) -> dict:
    user = ctx.run_as
    if not user or not (user.get("email") or ""):
        raise RuntimeError("This step needs a person's identity to run as.")
    return user


def _later(ctx):
    from task_automation import _Later
    return _Later(getattr(ctx, "defer", None))


def _people(ctx, spec, cap: int = 20) -> list[str]:
    from workflows.packs.tasks import _people as people
    return people(ctx, spec, cap=cap)


def _names(spec) -> str:
    from workflows.recipients import describe
    return describe(spec)


def _detail(e) -> str:
    d = getattr(e, "detail", None)
    return str(d if d is not None else e)


def _refused(what: str, e) -> RuntimeError:
    return RuntimeError(f"Could not {what}: {_detail(e)}")


def _target_ticket(ctx):
    """The ticket a step acts on: the run's subject, or the For Each item."""
    if isinstance(ctx.subject, models.TaskTicket):
        return ctx.subject
    item = ctx.item if isinstance(ctx.item, dict) else {}
    if item.get("id"):
        row = _load(ctx.db, str(item["id"]))
        if row is not None:
            return row
    raise RuntimeError("This step needs a ticket as its record - use it on a ticket event or inside For Each over tickets.")


def _subject_ticket(ctx):
    try:
        return _target_ticket(ctx)
    except RuntimeError:
        return None


def _affected(t) -> list[dict]:
    return [{"entity": "ticket", "id": t.id, "label": _label(t)}]


def _can_read_reason(ctx, user: dict, t) -> str:
    from fastapi import HTTPException
    try:
        _tk()._require_ticket_participant(ctx.db, user, t)
    except HTTPException as e:
        return _detail(e)
    return ""


def _desk_reason(db, user: dict, what: str) -> str:
    import ticket_roles
    if not ticket_roles.can_work_queue(user, db):
        return f"{user.get('email')} is not a ticket agent - only the service desk can {what}."
    return ""


def _patch_reason(ctx, user: dict, t) -> str:
    """May `user` change `t`'s fields - the desk (or HR for a confidential
    ticket), else its requester - plus the wall and the confidential rule."""
    reason = _can_read_reason(ctx, user, t)
    if reason:
        return reason
    if not _tk()._may_patch_ticket(ctx.db, t, user):
        return f"{user.get('email')} may not change this ticket - only the service desk or its requester can."
    return ""


# ── ticket.create ────────────────────────────────────────────────────────────
def _create_bits(ctx, params) -> dict:
    subject = _render(ctx, params.get("subject"))[:200]
    requester = (_people(ctx, params.get("requester"), cap=5) if params.get("requester") else [])[:1]
    assignee = (_people(ctx, params.get("assignee"), cap=5) if params.get("assignee") else [])[:1]
    typ = str(params.get("type") or "other")
    priority = str(params.get("priority") or "medium").lower()
    dept = params.get("department")
    dept = str(dept.get("id") if isinstance(dept, dict) else (dept or "")).strip()
    return {"subject": subject, "requester": requester, "assignee": assignee, "type": typ,
            "priority": priority, "department": dept}


def _create_plan(ctx, params) -> str:
    b = _create_bits(ctx, params)
    line = f'Would file a {b["priority"]} {b["type"].replace("_", " ")} ticket "{b["subject"] or "(no subject)"}"'
    who = b["requester"][0] if b["requester"] else (_names(params.get("requester")) if params.get("requester")
                                                    else (ctx.run_as or {}).get("email") or "the run-as person")
    line += f" for {who}"
    if b["assignee"]:
        line += f", assigned to {b['assignee'][0]}"
    return line


def _create_allowed(ctx, params) -> str:
    user = ctx.run_as
    if not user:
        return "Create Ticket needs a person's identity."
    if params.get("assignee"):
        reason = _desk_reason(ctx.db, user, "assign a ticket while filing it")
        if reason:
            return reason + " Leave Assign To blank."
    return ""


def _create_run(ctx, params) -> dict:
    from fastapi import HTTPException
    user = _run_as(ctx)
    b = _create_bits(ctx, params)
    if not b["subject"]:
        raise RuntimeError("Could not file the ticket: the subject is blank.")
    desc = _render(ctx, params.get("description"))
    note = f"Created by Workflow: {_wf_name(ctx)}"
    tk = _tk()
    body = tk.TicketBody(subject=b["subject"], description=f"{desc}\n\n{note}" if desc else note,
                         type=b["type"], priority=b["priority"],
                         requester_email=b["requester"][0] if b["requester"] else "",
                         assignee_email=b["assignee"][0] if b["assignee"] else "",
                         hr_department_id=b["department"])
    try:
        made = tk.file_ticket(body, _later(ctx), user, ctx.db, arrived_by="workflow")
    except HTTPException as e:
        ctx.db.rollback()
        raise _refused("file the ticket", e)
    code = made.get("code") or ""
    line = f'Filed ticket {code} "{b["subject"]}" for {made.get("requesterId") or user["email"]}'
    if made.get("assigneeId"):
        line += f", assigned to {made['assigneeId']}"
    return {"line": line, "affected": [{"entity": "ticket", "id": made["id"], "label": b["subject"]}], "sent": []}


action("ticket.create", label="Create Ticket", module="tickets",
       params=[P("subject", "Subject", "template", max=200),
               P("description", "Description", "template", required=False, max=5000),
               P("type", "Type", "select", required=False, options=TYPES, default="other"),
               P("priority", "Priority", "select", required=False, options=PRIORITIES, default="medium"),
               P("requester", "For", "recipients", required=False,
                 hint="Who the ticket is for - blank files it for the run-as person"),
               P("assignee", "Assign To", "recipients", required=False, hint="Service desk only"),
               P("department", "Department", "entity_ref", required=False, options="ticket_departments")],
       plan=_create_plan, run=_create_run, allowed=_create_allowed)


# ── ticket.comment ───────────────────────────────────────────────────────────
def _comment_text(ctx, params) -> str:
    return f"Workflow: {_wf_name(ctx)} - {_render(ctx, params.get('text'))}"[:5000]


def _comment_plan(ctx, params) -> str:
    kind = "an internal note" if params.get("internal") else "a reply"
    return f'Would add {kind} on "{ctx.subject_label() or "the ticket"}": {_comment_text(ctx, params)}'


def _comment_allowed(ctx, params) -> str:
    user = ctx.run_as
    if not user:
        return "Add Comment needs a person's identity."
    if params.get("internal"):
        import ticket_roles
        if not ticket_roles.can_read_internal(user, ctx.db):
            return f"{user.get('email')} is not a ticket agent - only the service desk writes internal notes."
    t = _subject_ticket(ctx)
    return _can_read_reason(ctx, user, t) if t is not None else ""


def _comment_run(ctx, params) -> dict:
    user = _run_as(ctx)
    t = _target_ticket(ctx)
    reason = _comment_allowed(ctx, params)
    if reason:
        raise RuntimeError(f"Could not comment: {reason}")
    internal = bool(params.get("internal"))
    _tk().post_ticket_comment(ctx.db, t, user, _comment_text(ctx, params), internal, _later(ctx))
    kind = "an internal note" if internal else "a reply"
    return {"line": f'Added {kind} on {t.code or ""} "{_label(t)}"', "affected": _affected(t), "sent": []}


action("ticket.comment", label="Add Ticket Comment", module="tickets",
       params=[P("text", "Comment", "template", max=5000),
               P("internal", "Internal Note", "bool", required=False, default=False,
                 hint="Seen by the service desk only")],
       plan=_comment_plan, run=_comment_run, allowed=_comment_allowed)


# ── ticket.assign ────────────────────────────────────────────────────────────
def _assign_plan(ctx, params) -> str:
    who = _people(ctx, params.get("to"))
    name = who[0] if who else _names(params.get("to"))
    return f'Would assign "{ctx.subject_label() or "the ticket"}" to {name}'


def _assign_allowed(ctx, params) -> str:
    import ticket_roles
    user = ctx.run_as
    if not user:
        return "Assign Ticket needs a person's identity."
    if not ticket_roles.can_assign(user, ctx.db):
        return f"{user.get('email')} is not a ticket agent - only the service desk assigns tickets."
    t = _subject_ticket(ctx)
    return _patch_reason(ctx, user, t) if t is not None else ""


def _assign_run(ctx, params) -> dict:
    from fastapi import HTTPException
    user = _run_as(ctx)
    t = _target_ticket(ctx)
    reason = _assign_allowed(ctx, params)
    if reason:
        raise RuntimeError(f"Could not assign: {reason}")
    who = _people(ctx, params.get("to"))
    if not who:
        raise RuntimeError("Could not assign: nobody on the Nexus People list resolved.")
    if (t.assignee_email or "").strip().lower() == who[0]:
        return {"line": f'{who[0]} already holds {t.code or ""} "{_label(t)}"', "affected": _affected(t), "sent": []}
    tk = _tk()
    try:
        tk.update_ticket(t.id, tk.TicketUpdate(assignee_email=who[0]), _later(ctx), user=user, db=ctx.db)
    except HTTPException as e:
        ctx.db.rollback()
        raise _refused("assign the ticket", e)
    return {"line": f'Assigned {t.code or ""} "{_label(t)}" to {who[0]}', "affected": _affected(t), "sent": []}


action("ticket.assign", label="Assign Ticket", module="tickets",
       params=[P("to", "Assign To", "recipients", hint="The first person resolved")],
       plan=_assign_plan, run=_assign_run, allowed=_assign_allowed)


# ── ticket.set_status ────────────────────────────────────────────────────────
def _status_label(status: str) -> str:
    return dict(STATUSES).get(status, status)


def _set_status_plan(ctx, params) -> str:
    st = str(params.get("status") or "")
    line = f'Would move "{ctx.subject_label() or "the ticket"}" to {_status_label(st)}'
    note = _render(ctx, params.get("note"))
    if note:
        line += f" with the note: {note}"
    return line


def _set_status_allowed(ctx, params) -> str:
    user = ctx.run_as
    if not user:
        return "Set Status needs a person's identity."
    t = _subject_ticket(ctx)
    if t is not None:
        return _patch_reason(ctx, user, t)
    return _desk_reason(ctx.db, user, "change a ticket's status")


def _set_status_run(ctx, params) -> dict:
    from fastapi import HTTPException
    user = _run_as(ctx)
    t = _target_ticket(ctx)
    reason = _patch_reason(ctx, user, t)
    if reason:
        raise RuntimeError(f"Could not set the status: {reason}")
    st = str(params.get("status") or "")
    if st not in dict(STATUSES):
        raise RuntimeError(f"Could not set the status: {st!r} is not a ticket status.")
    if st == (t.status or ""):
        return {"line": f'{t.code or ""} "{_label(t)}" is already {_status_label(st)}', "affected": _affected(t), "sent": []}
    fields = {"status": st}
    note = _render(ctx, params.get("note"))
    if note:
        fields["resolution_note"] = note[:2000]
    tk = _tk()
    try:
        tk.update_ticket(t.id, tk.TicketUpdate(**fields), _later(ctx), user=user, db=ctx.db)
    except HTTPException as e:
        ctx.db.rollback()
        raise _refused("set the status", e)
    return {"line": f'Moved {t.code or ""} "{_label(t)}" to {_status_label(st)}', "affected": _affected(t), "sent": []}


action("ticket.set_status", label="Set Ticket Status", module="tickets",
       params=[P("status", "Status", "select", options=STATUSES),
               P("note", "Resolution Note", "template", required=False, max=2000,
                 hint="Required by the desk when resolving or closing")],
       plan=_set_status_plan, run=_set_status_run, allowed=_set_status_allowed)


# ── ticket.request_approval ──────────────────────────────────────────────────
def _approval_plan(ctx, params) -> str:
    who = _people(ctx, params.get("approver"))
    name = who[0] if who else _names(params.get("approver"))
    return f'Would send "{ctx.subject_label() or "the ticket"}" to {name} for approval'


def _approval_allowed(ctx, params) -> str:
    import ticket_roles
    user = ctx.run_as
    if not user:
        return "Request Approval needs a person's identity."
    if not ticket_roles.can_manage_desk(user, ctx.db):
        return f"{user.get('email')} is not a ticket supervisor - only a supervisor sends a ticket for approval."
    t = _subject_ticket(ctx)
    if t is not None and (t.approval_status or "none") != "pending":
        return ("This ticket does not require approval." if (t.approval_status or "none") == "none"
                else f"This ticket was already {t.approval_status}.")
    return ""


def _approval_run(ctx, params) -> dict:
    from fastapi import HTTPException
    user = _run_as(ctx)
    t = _target_ticket(ctx)
    reason = _approval_allowed(ctx, params)
    if reason:
        raise RuntimeError(f"Could not request approval: {reason}")
    who = _people(ctx, params.get("approver"))
    if not who:
        raise RuntimeError("Could not request approval: nobody on the Nexus People list resolved.")
    tk = _tk()
    body = tk.ApprovalRequestBody(approver_email=who[0], note=_render(ctx, params.get("note"))[:1000])
    try:
        tk.request_approval(t.id, body, _later(ctx), user=user, db=ctx.db)
    except HTTPException as e:
        ctx.db.rollback()
        raise _refused("request approval", e)
    return {"line": f'Sent {t.code or ""} "{_label(t)}" to {who[0]} for approval', "affected": _affected(t), "sent": []}


action("ticket.request_approval", label="Request Ticket Approval", module="tickets",
       params=[P("approver", "Approver", "recipients", hint="The first person resolved"),
               P("note", "Note", "template", required=False, max=1000)],
       plan=_approval_plan, run=_approval_run, allowed=_approval_allowed)


# ── list sources ─────────────────────────────────────────────────────────────
def _visible_rows(db, ctx, q) -> list:
    import ticket_confidential
    from workflows import catalog
    company = ctx.company()
    ent = catalog.ENTITIES["ticket"]
    out = []
    for t in ticket_confidential.include(q).limit(MAX_LIST * 4).all():
        if company and (t.company_id or "") != company:
            continue
        if not ent.can_see(db, ctx.run_as, t):
            continue
        out.append(t)
        if len(out) >= MAX_LIST:
            break
    return out


def _unanswered(db, ctx, params) -> list:
    """Open tickets nobody on the desk has replied to, filed at least
    `businessDays` business days ago (Monday to Friday, as the overdue
    reminders count them)."""
    import ticket_sla
    from ticket_overdue import business_days
    n = int(params.get("businessDays") or 0) if isinstance(params, dict) else 0
    T = models.TaskTicket
    q = (db.query(T)
         .filter(T.status.notin_(ticket_sla.PAUSED_STATUSES),
                 (T.first_response_at.is_(None)) | (T.first_response_at == ""))
         .order_by(T.created_at, T.id))
    rows = []
    for t in _visible_rows(db, ctx, q):
        if (t.approval_status or "") == "pending" or not ticket_sla.first_response_applies(t):
            continue
        try:
            filed = date.fromisoformat((t.created_at or "")[:10])
        except ValueError:
            continue
        if business_days(filed, ctx.today) >= max(0, n):
            rows.append(t)
    return rows


def _breaching(db, ctx, params) -> list:
    """Tickets whose resolution SLA is breached right now (ticket_sla's
    rule: the clock is running and the deadline has passed)."""
    import ticket_sla
    T = models.TaskTicket
    now_s = ticket_sla.iso(datetime.now(timezone.utc))
    q = db.query(T).filter(ticket_sla.breached_filter(now_s)).order_by(T.sla_due_at, T.id)
    return _visible_rows(db, ctx, q)


list_source("tickets.unanswered", label="Unanswered Tickets", entity="ticket", module="tickets",
            params=[P("businessDays", "Business Days Waiting", "number", required=False, default=1)],
            fn=_unanswered)
list_source("tickets.breaching_sla", label="Tickets Breaching SLA", entity="ticket", module="tickets",
            fn=_breaching)
