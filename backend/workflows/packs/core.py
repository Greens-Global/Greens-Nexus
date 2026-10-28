"""Core pack: the company (the subject of a schedule tick) and the person
(the record most workflows are about), with the record-observer events on
the person, the option sources every builder picker reads (companies,
departments, locations, ticket departments, HR checklist and letter
templates) and the core ACTIONS (Task 6): Send A Notification, Send An
Email, Post To Teams and Call A Webhook. Wait, Stop, If / Else, For Each
and Ask For Approval are STEP KINDS the engine runs itself (the pinned
definition shape), not actions. The HR pack (Task 9) adds the HR life
events and actions on top of these registrations.

Every action's `run` is idempotent on the step: it appends each recipient
to `ctx.step_output["sent"]` as the message goes out, and skips the ones
already there on a retry (Review Focus 2)."""
from __future__ import annotations

import hashlib
import hmac
import json
from html import escape
from urllib.parse import urlparse

import models
from workflows.catalog import D, F, P, action, entity, event, option_source
from workflows.context import link_url, person_name, render
from workflows.errors import TransientError


# ── helpers ──────────────────────────────────────────────────────────────────
def _emails(*vals) -> list[str]:
    out = []
    for v in vals:
        for e in str(v or "").split(","):
            e = e.strip().lower()
            if e and e not in out:
                out.append(e)
    return out


def _employee_self(db, row) -> list[str]:
    return _emails(getattr(row, "work_email", ""))


def _employee_manager(db, row) -> list[str]:
    return _emails(getattr(row, "manager_email", ""))


def _company_hr_contacts(db, company_id: str) -> list[str]:
    import hr_access
    return hr_access.hr_contacts(db, company_id or "")


def _employee_hr_contact(db, row) -> list[str]:
    return _company_hr_contacts(db, getattr(row, "company", "") or "")


def _company_hr_contact(db, row) -> list[str]:
    return _company_hr_contacts(db, getattr(row, "id", "") or "")


def _global_admins(db, row=None) -> list[str]:
    rows = db.query(models.NexusRole).filter(models.NexusRole.role == "owner").all()
    return _emails(*[r.email for r in rows])


def employee_name(row) -> str:
    name = (getattr(row, "display_name", "") or "").strip()
    if not name:
        name = f"{getattr(row, 'first_name', '') or ''} {getattr(row, 'last_name', '') or ''}".strip()
    return name or (getattr(row, "work_email", "") or "")


def _employee_visible(db, user, row) -> bool:
    """A person's record is visible to themselves, their manager, HR and
    administrators - the People screen's own rule, in short."""
    if not user:
        return False
    import auth
    me = (user.get("email") or "").lower()
    if int(user.get("level", 0) or 0) >= auth._LEVELS["administrator"]:
        return True
    if me and me in (_employee_self(db, row) + _employee_manager(db, row)):
        return True
    return auth._module_level(me, "hr", db) >= 1


# ── entities ─────────────────────────────────────────────────────────────────
entity("company", label="Company", model=models.HrEntity, module="core",
       company=lambda row: row.id,
       link=lambda row: {"view": "admin", "sub": f"companies@{row.id}"},
       people={"hr_contact": _company_hr_contact, "global_admins": _global_admins},
       fields=[F("name", "Name", "text"), F("country", "Country", "text"), F("region", "Region", "text")],
       label_of=lambda row: row.name or row.id)

EMPLOYEE_FIELDS = [
    F("name", "Name", "text", path="__label__"),
    F("work_email", "Work Email", "person"),
    F("department", "Department", "select", options="departments"),
    F("job_title", "Job Title", "text"),
    F("manager_email", "Manager", "person"),
    F("company", "Company", "select", options="companies"),
    F("employment_type", "Employment Type", "select",
      options=[("full_time", "Full Time"), ("part_time", "Part Time"), ("contractor", "Contractor"),
               ("intern", "Intern")]),
    F("location", "Location", "select", options="locations"),
    F("status", "Status", "select",
      options=[("onboarding", "Onboarding"), ("active", "Active"), ("inactive", "Inactive"),
               ("offboarded", "Offboarded")]),
    F("start_date", "Start Date", "date"),
    F("birthday", "Birthday", "date", visibility="hr", path="personal.dob", yearly=True),
]

entity("employee", label="Person", model=models.NexusEmployee, module="hr",
       company=lambda row: row.company or "",
       link=lambda row: {"view": "hr", "sub": f"people:{row.id}"},
       people={"self": _employee_self, "manager": _employee_manager, "hr_contact": _employee_hr_contact},
       fields=EMPLOYEE_FIELDS,
       dates=["start_date", D("start_date", "Work Anniversary", yearly=True), "birthday"],
       observe=True,
       observe_fields=("department", "manager_email", "job_title", "company", "employment_type", "location",
                       "status"),
       label_of=employee_name,
       visible_to=_employee_visible)

SAMPLE_EMPLOYEE = {
    "name": "Priya Shah", "work_email": "priya.shah@greensglobal.com", "department": "Operations",
    "job_title": "Site Manager", "manager_email": "max.miller@greensglobal.com", "company": "",
    "employment_type": "full_time", "location": "Escondido", "status": "active",
    "start_date": "2026-11-12", "birthday": "1994-03-08",
}

# ── events ───────────────────────────────────────────────────────────────────
event("employee.created", entity="employee", label="Person Is Added", module="hr", group="People",
      sample=SAMPLE_EMPLOYEE)
event("employee.field_changed", entity="employee", label="Person Detail Changes", module="hr", group="People",
      changes=("department", "manager_email", "job_title", "company", "employment_type", "location", "status"),
      sample={"subject": dict(SAMPLE_EMPLOYEE, department="Sales"),
              "changes": {"department": {"from": "Operations", "to": "Sales"}},
              "extra": {"field": "department"}, "actor": "hana.hr@greensglobal.com"})
event("employee.status_changed", entity="employee", label="Person Status Changes", module="hr", group="People",
      changes=("status",),
      sample={"subject": dict(SAMPLE_EMPLOYEE, status="offboarded"),
              "changes": {"status": {"from": "active", "to": "offboarded"}},
              "extra": {"reason": "Resigned", "effectiveDate": "2026-11-30"},
              "actor": "hana.hr@greensglobal.com"})


# ── option sources (the builder's pickers; `options="<name>"` on F / P) ──────
def _companies(db) -> list:
    rows = db.query(models.HrEntity).order_by(models.HrEntity.name).all()
    return [{"value": r.id, "label": r.name or r.id} for r in rows]


def _departments(db) -> list:
    names = sorted({(r.name or "").strip() for r in db.query(models.HrDepartment).all() if (r.name or "").strip()},
                   key=str.lower)
    return [{"value": n, "label": n} for n in names]


def _locations(db) -> list:
    rows = db.query(models.NexusEmployee.location).filter(models.NexusEmployee.location != "").distinct().all()
    names = sorted({(r[0] or "").strip() for r in rows if (r[0] or "").strip()}, key=str.lower)
    return [{"value": n, "label": n} for n in names]


def _ticket_departments(db) -> list:
    rows = db.query(models.TicketDepartment).all()
    out = [{"value": r.id, "label": r.name or r.id} for r in rows if getattr(r, "enabled", True)]
    return sorted(out, key=lambda o: o["label"].lower())


def _hr_checklist_templates(db) -> list:
    out = []
    for r in db.query(models.HrChecklistTemplate).all():
        kind = (r.kind or "").replace("_", " ").title()
        label = r.name or kind
        if r.name and kind and kind.lower() not in r.name.lower():
            label = f"{r.name} ({kind})"
        out.append({"value": r.id, "label": label})
    return sorted(out, key=lambda o: o["label"].lower())


def _hr_letter_templates(db) -> list:
    import hr_letters
    return [{"value": t["key"], "label": t["label"]} for t in hr_letters.LETTER_TYPES]


def _task_custom_fields(db) -> list:
    rows = db.query(models.TaskCustomField).all()
    return sorted([{"value": r.id, "label": r.name or r.id} for r in rows], key=lambda o: o["label"].lower())


def _task_statuses(db) -> list:
    rows = db.query(models.TaskCustomStatus).order_by(models.TaskCustomStatus.position).all()
    return [{"value": r.id, "label": r.label or r.id} for r in rows]


def _ticket_types(db) -> list:
    import ticket_taxonomy
    return [{"value": k, "label": k.replace("_", " ").title()} for k in ticket_taxonomy.TICKET_TYPES]


option_source("companies", _companies)
option_source("departments", _departments)
option_source("locations", _locations)
option_source("ticket_departments", _ticket_departments)
option_source("ticket_types", _ticket_types)
option_source("hr_checklist_templates", _hr_checklist_templates)
option_source("hr_letter_templates", _hr_letter_templates)
option_source("task_custom_fields", _task_custom_fields)
option_source("task_statuses", _task_statuses)
# "task_projects" is deliberately NOT registered: the builder loads projects
# through its own API (the list is per caller), and the name passes through.


# ── action helpers ───────────────────────────────────────────────────────────
def _settings(ctx) -> dict:
    return (ctx.definition or {}).get("settings") or {}


def recipient_cap(ctx) -> int:
    """The workflow's maxRecipients, never above the company's ceiling."""
    from workflows import settings as wf_settings
    want = int(_settings(ctx).get("maxRecipients") or 50)
    try:
        ceiling = int(wf_settings.get(ctx.db, ctx.company()).get("maxRecipientsCap") or 200)
    except Exception:   # noqa: BLE001 - a settings read that fails keeps the hard cap
        ceiling = 200
    return max(1, min(want, ceiling))


def resolve_to(ctx, spec) -> tuple[list[str], int]:
    from workflows import recipients
    return recipients.resolve(ctx, spec, cap=recipient_cap(ctx))


def _names(ctx, emails: list[str]) -> str:
    """"Priya Shah and 2 others" - the first by name, the rest counted."""
    if not emails:
        return "nobody"
    first = person_name(ctx.db, emails[0])
    rest = len(emails) - 1
    if rest == 0:
        return first
    return f"{first} and {rest} other" + ("s" if rest > 1 else "")


def _rendered(ctx, text) -> str:
    return render(text or "", ctx)[0]


def _run_as_email(ctx) -> str:
    return ((ctx.run_as or {}).get("email") or "").lower() if ctx.run_as else "workflows@nexus"


def _workflow_id(ctx) -> str:
    return str(getattr(ctx.workflow, "id", "") or "")


def _workflow_name(ctx) -> str:
    return str(getattr(ctx.workflow, "name", "") or "a workflow")


def _already_sent(ctx) -> list[str]:
    sent = ctx.step_output.setdefault("sent", [])
    if not isinstance(sent, list):
        sent = []
        ctx.step_output["sent"] = sent
    return sent


def _dropped_note(dropped: int) -> str:
    return f" ({dropped} left out: cap or visibility)" if dropped else ""


# ── Send A Notification ──────────────────────────────────────────────────────
def _notify_plan(ctx, params) -> str:
    to, dropped = resolve_to(ctx, params.get("to"))
    title = _rendered(ctx, params.get("title"))
    return f"Would notify {_names(ctx, to)}: {title}{_dropped_note(dropped)}"


def _notify_run(ctx, params) -> dict:
    import notify_rollup
    to, dropped = resolve_to(ctx, params.get("to"))
    title = _rendered(ctx, params.get("title"))
    body = _rendered(ctx, params.get("body")) or title
    link = ctx.subject_link() or None
    key = f"wf:{_workflow_id(ctx)}:{ctx.subject_id() or 'run'}"
    sent = _already_sent(ctx)
    for who in to:
        if who in sent:
            continue
        notify_rollup.upsert_rollup(ctx.db, recipient=who, key=key, title=title, line=body, action=link,
                                    company=ctx.company(), requested_by=_run_as_email(ctx), replace=True,
                                    priority=1 if params.get("priority") else None)
        sent.append(who)
    return {"line": f"Notified {_names(ctx, to)}: {title}{_dropped_note(dropped)}", "sent": list(sent),
            "affected": []}


action("notify", label="Send A Notification", module="core",
       params=[P("to", "To", "recipients"),
               P("title", "Title", "template", max=120),
               P("body", "Message", "template", max=1000, required=False),
               P("priority", "Priority", "bool", required=False, default=False,
                 hint="Shows the yellow priority bar")],
       plan=_notify_plan, run=_notify_run, needs_person=False)


# ── Send An Email ────────────────────────────────────────────────────────────
def email_html(db, to: str, heading: str, body: str, link: str, workflow_name: str) -> str:
    """The themed shell every Nexus mail uses (hr_probation._email_html's
    layout), with the recipient's company logo (email_theme.logo_for)."""
    import email_theme
    theme = email_theme.current()
    band = theme.color("#0f3d2e")
    button = (f'<tr><td style="padding:0 28px 28px"><a href="{escape(link)}" style="display:inline-block;'
              f'padding:10px 22px;border-radius:4px;background:{band};color:#ffffff;text-decoration:none;'
              f'font-weight:600;font-size:13px">Open In Nexus</a></td></tr>') if link else ""
    return f"""<div style="background:#f3f4f6;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-collapse:collapse">
    <tr><td style="background:{band};padding:16px 28px">{theme.logo_block(email_theme.logo_for(db, "", to))}</td></tr>
    <tr><td style="padding:24px 28px">
      <div style="font-size:20px;font-weight:600;color:#111827">{escape(heading)}</div>
      <div style="font-size:14px;line-height:1.55;color:#374151;margin-top:12px;white-space:pre-line">{escape(body)}</div>
    </td></tr>
    {button}
    <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-size:11.5px;line-height:1.6;color:#6b7280">
      Sent by the workflow "{escape(workflow_name)}" in Nexus.{theme.footer_lines()}
    </td></tr>
  </table>
</div>"""


def _email_plan(ctx, params) -> str:
    to, dropped = resolve_to(ctx, params.get("to"))
    subject = _rendered(ctx, params.get("subject"))
    return f"Would email {_names(ctx, to)}: {subject}{_dropped_note(dropped)}"


def _email_run(ctx, params) -> dict:
    import graph_mail
    import leader
    to, dropped = resolve_to(ctx, params.get("to"))
    subject = _rendered(ctx, params.get("subject"))
    body = _rendered(ctx, params.get("body"))
    if not leader.is_deployed_worker():
        return {"line": "Email not sent (not the deployed worker)", "sent": [], "affected": [],
                "wouldSend": to, "subject": subject}
    link = link_url(ctx.subject_link())
    sent = _already_sent(ctx)
    for who in to:
        if who in sent:
            continue
        html = email_html(ctx.db, who, subject, body, link, _workflow_name(ctx))
        graph_mail.send_mail(from_email=graph_mail.DEFAULT_FROM_EMAIL, to=[who], cc=None, subject=subject, html=html)
        sent.append(who)
    return {"line": f"Emailed {_names(ctx, to)}: {subject}{_dropped_note(dropped)}", "sent": list(sent),
            "affected": []}


action("email", label="Send An Email", module="core",
       params=[P("to", "To", "recipients"),
               P("subject", "Subject", "template", max=200),
               P("body", "Message", "template", max=5000)],
       plan=_email_plan, run=_email_run, needs_person=False)


# ── Post To Teams ────────────────────────────────────────────────────────────
def _teams_allowed(ctx, params) -> str:
    if not ctx.run_as:
        return "Post To Teams needs a person's identity"
    return ""


def _teams_plan(ctx, params) -> str:
    to, dropped = resolve_to(ctx, params.get("to"))
    msg = _rendered(ctx, params.get("message"))
    who = person_name(ctx.db, _run_as_email(ctx))
    return f"Would post to {_names(ctx, to)} on Teams as {who}: {msg[:80]}{_dropped_note(dropped)}"


def _teams_run(ctx, params) -> dict:
    import uuid
    from datetime import datetime, timezone
    import teams_post
    reason = _teams_allowed(ctx, params)
    if reason:
        raise PermissionError(reason)
    to, dropped = resolve_to(ctx, params.get("to"))
    msg = _rendered(ctx, params.get("message"))
    link = link_url(ctx.subject_link())
    html = f"<p>{escape(msg)}</p>"
    if link:
        html += f'<p><a href="{escape(link)}">Open in Nexus</a></p>'
    html = teams_post.with_signature(html)
    me = _run_as_email(ctx)
    sent = _already_sent(ctx)
    now = datetime.now(timezone.utc).isoformat()
    for who in to:
        if who in sent or who == me:
            continue
        ctx.db.add(models.TicketTeamsMessage(id=str(uuid.uuid4()), ticket_id="", agent_email=me, requester_email=who,
                                             html=html, created_at=now, kind="workflow"))
        sent.append(who)
    others = [w for w in to if w != me]
    return {"line": f"Queued a Teams message to {_names(ctx, others)}{_dropped_note(dropped)}",
            "sent": list(sent), "affected": []}


action("teams", label="Post To Teams", module="core",
       params=[P("to", "To", "recipients"),
               P("message", "Message", "template", max=2000),
               P("chat", "Chat", "select", required=False, default="direct",
                 options=[("direct", "Direct Message")], hint="A 1:1 chat with each person, posted as the owner")],
       plan=_teams_plan, run=_teams_run, allowed=_teams_allowed, needs_person=True)


# ── Call A Webhook (Global Admins only) ──────────────────────────────────────
def _host(url: str) -> str:
    try:
        return (urlparse(str(url or "")).hostname or "").lower()
    except ValueError:
        return ""


def _webhook_allowed(ctx, params) -> str:
    from workflows import settings as wf_settings
    url = str(params.get("url") or "")
    host = _host(url)
    if not url.lower().startswith("https://") or not host:
        return "The webhook URL must start with https://"
    hosts = wf_settings.get(ctx.db).get("webhookHosts") or []
    if host not in hosts:
        return f"{host} is not in the webhook allow-list (Settings > Workflows)"
    return ""


def webhook_body(ctx, params) -> dict:
    payload = _rendered(ctx, params.get("payload"))
    try:
        data = json.loads(payload) if payload.strip().startswith(("{", "[")) else payload
    except ValueError:
        data = payload
    return {
        "workflow": {"id": _workflow_id(ctx), "name": _workflow_name(ctx)},
        "run": str(getattr(ctx.run, "id", "") or ""),
        "event": str(getattr(ctx.event, "key", "") or ""),
        "subject": {"entity": ctx.entity.key if ctx.entity else "", "id": ctx.subject_id(),
                    "label": ctx.subject_label(), "link": link_url(ctx.subject_link())},
        "payload": data,
    }


def sign(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new((secret or "").encode("utf-8"), body, hashlib.sha256).hexdigest()


def _webhook_plan(ctx, params) -> str:
    return f"Would POST to {_host(params.get('url'))}: {json.dumps(webhook_body(ctx, params))[:120]}"


def _webhook_run(ctx, params) -> dict:
    import httpx
    from workflows import settings as wf_settings
    reason = _webhook_allowed(ctx, params)
    if reason:
        raise PermissionError(reason)
    url = str(params.get("url") or "")
    host = _host(url)
    body = json.dumps(webhook_body(ctx, params), default=str).encode("utf-8")
    headers = {"content-type": "application/json", "user-agent": "Nexus-Workflows/1",
               "X-Nexus-Signature": sign(wf_settings.webhook_secret(ctx.db, host), body)}
    r = httpx.post(url, content=body, headers=headers, timeout=10)
    if r.status_code >= 500:
        raise TransientError(f"{host} answered {r.status_code}")
    if r.status_code >= 400:
        raise RuntimeError(f"{host} answered {r.status_code}: {r.text[:160]}")
    return {"line": f"Called {host} ({r.status_code})", "sent": [], "affected": [], "status": r.status_code}


action("webhook", label="Call A Webhook", module="core",
       params=[P("url", "URL", "text", max=500, hint="https:// only, host on the allow-list"),
               P("payload", "Payload", "template", max=5000, required=False,
                 hint="Sent as the JSON body's payload; fields are filled in")],
       plan=_webhook_plan, run=_webhook_run, allowed=_webhook_allowed, needs_person=True, admin_only=True)
