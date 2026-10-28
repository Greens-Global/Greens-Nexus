"""Templates (spec 8.1): the nine built-in workflows with blanks to fill,
plus the ones full-level users save for their company (a NexusSetting
list per company, `workflows.templates:<company>`; '' = every company).

A built-in template names what it needs from the catalog in `requires`
(an event key, a list source key, or `date:<entity>:<field>` for a date
trigger); `visible()` hides one whose needs are not registered yet, so a
template built for a pack that is not deployed never shows a broken
draft. Use Template copies the definition as a new draft - nothing runs
until it is tested and published.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

import models
from workflows import catalog, validate

SETTING = "workflows.templates"


def _t(key, name, module, description, trigger, steps, *, conditions=None, settings=None, blanks=(), requires=()):
    return {
        "key": key, "name": name, "module": module, "description": description,
        "definition": {"v": 1, "trigger": trigger, "conditions": list(conditions or []), "steps": steps,
                       "settings": {**validate.DEFAULT_SETTINGS, **(settings or {})}},
        "blanks": list(blanks), "requires": list(requires), "builtIn": True,
    }


def _notify(sid, to, title, body="", priority=False):
    params = {"to": to, "title": title}
    if body:
        params["body"] = body
    if priority:
        params["priority"] = True
    return {"id": sid, "kind": "action", "action": "notify", "params": params, "enabled": True}


def _email(sid, to, subject, body):
    return {"id": sid, "kind": "action", "action": "email", "params": {"to": to, "subject": subject, "body": body},
            "enabled": True}


MANAGER_HR = [{"kind": "manager"}, {"kind": "role", "value": "hr_contact"}]

TEMPLATES: list[dict] = [
    _t("new_hire_welcome", "New Hire Welcome And Equipment", "hr",
       "When a person is added, the manager and HR get a bell to arrange equipment and access, and the "
       "new hire gets a welcome email.",
       {"kind": "event", "event": "employee.created", "filters": []},
       [_notify("s1", MANAGER_HR, "New Hire: {{ subject.name }} Starts {{ subject.start_date | us_date }}",
                "Please arrange a laptop, system access and a first-week plan for {{ subject.name }} "
                "({{ subject.job_title | default:'role to be set' }}, {{ subject.department | default:'-' }})."),
        _email("s2", [{"kind": "self"}], "Welcome To The Team, {{ subject.name }}",
               "Hello {{ subject.name }},\n\nWe are glad to have you starting on "
               "{{ subject.start_date | us_date }}. Your manager will be in touch before your first day.\n\n"
               "Welcome aboard.")],
       blanks=["steps[1].params.body"]),
    _t("probation_ending", "Probation Ending Reminder", "hr",
       "Fourteen days before a probation ends, the manager and HR are reminded to decide.",
       {"kind": "date", "entity": "employee", "field": "probation.end", "offsetDays": -14, "time": "08:00"},
       [_notify("s1", MANAGER_HR, "Probation Ends In 14 Days: {{ subject.name }}",
                "{{ subject.name }}'s probation ends on {{ subject.probation.end | us_date }}. Please confirm, "
                "extend or end it before then.", priority=True)],
       requires=["date:employee:probation.end"]),
    _t("unsigned_timesheet_chase", "Unsigned Time Sheet Chase", "time",
       "Every Monday morning, everyone with an approved Time Sheet still unsigned after three days gets a bell.",
       {"kind": "schedule", "every": "week", "days": [1], "time": "08:00", "zone": "company"},
       [{"id": "s1", "kind": "for_each", "source": {"key": "timesheets.unsigned", "params": {"days": 3}}, "as": "item",
         "enabled": True,
         "steps": [_notify("s2", [{"kind": "self"}], "Your Time Sheet Is Waiting For Your Signature",
                           "Your approved Time Sheet is waiting for your signature. Please sign it today.",
                           priority=True)]}],
       requires=["timesheets.unsigned"]),
    _t("ticket_unanswered", "Ticket Unanswered For 2 Business Days", "tickets",
       "Every morning, a ticket with no reply for two business days is raised with its assignee and the "
       "department lead.",
       {"kind": "schedule", "every": "day", "days": [], "time": "09:00", "zone": "company"},
       [{"id": "s1", "kind": "for_each", "source": {"key": "tickets.unanswered", "params": {"businessDays": 2}},
         "as": "item", "enabled": True,
         "steps": [_notify("s2", [{"kind": "assignee"}], "No Reply For 2 Business Days: {{ item.title }}",
                           "{{ item.title }} has had no reply for two business days. Please answer the requester "
                           "or hand it on.", priority=True)]}],
       requires=["tickets.unanswered"]),
    _t("leaver_offboarding_kit", "Leaver Offboarding Kit", "hr",
       "When a person is offboarded, the manager and HR get the offboarding checklist and IT is told to "
       "collect equipment and remove access.",
       {"kind": "event", "event": "employee.status_changed",
        "filters": [{"field": "status", "op": "changed_to", "value": "offboarded"}]},
       [_notify("s1", MANAGER_HR, "Offboarding: {{ subject.name }}",
                "{{ subject.name }} has left. Please collect equipment, close system access and file the final "
                "pay with payroll.", priority=True),
        _email("s2", [{"kind": "global_admins"}], "Access Removal: {{ subject.name }}",
               "{{ subject.name }} ({{ subject.work_email }}) has left on {{ today | us_date }}. Please remove "
               "their access and collect any equipment on loan.")],
       blanks=["steps[1].params.to"]),
    _t("time_off_approved_tell_team", "Time Off Approved: Tell The Team", "hr",
       "When time off is approved, the manager and HR contact are told so cover can be arranged.",
       {"kind": "event", "event": "time_off.decided",
        "filters": [{"field": "status", "op": "changed_to", "value": "approved"}]},
       [_notify("s1", MANAGER_HR, "Time Off Approved: {{ subject.name }}",
                "{{ subject.name }} ({{ subject.start | us_date }} to {{ subject.end | us_date }}) was approved. "
                "Please arrange cover.")],
       requires=["time_off.decided"]),
    _t("overdue_task_escalation", "Overdue Task Escalation", "tasks",
       "Every morning, a task overdue by two days is raised with its assignees and the project owner.",
       {"kind": "schedule", "every": "day", "days": [], "time": "08:00", "zone": "company"},
       [{"id": "s1", "kind": "for_each", "source": {"key": "tasks.overdue", "params": {"days": 2}}, "as": "item",
         "enabled": True,
         "steps": [_notify("s2", [{"kind": "assignees"}, {"kind": "project_owner"}],
                           "Overdue: {{ item.title }}",
                           "{{ item.title }} was due on {{ item.due_date | us_date }} and is still open.",
                           priority=True)]}],
       requires=["tasks.overdue"]),
    _t("contract_ending_30", "Contract Ending In 30 Days", "hr",
       "Thirty days before a contract ends, the manager and HR are reminded to renew or close it.",
       {"kind": "date", "entity": "employee", "field": "contract_end", "offsetDays": -30, "time": "08:00"},
       [_notify("s1", MANAGER_HR, "Contract Ends In 30 Days: {{ subject.name }}",
                "{{ subject.name }}'s contract ends on {{ subject.contract_end | us_date }}. Please decide on a "
                "renewal.", priority=True)],
       requires=["date:employee:contract_end"]),
    _t("work_anniversary", "Work Anniversary", "hr",
       "On a person's work anniversary, they and their manager get a note.",
       {"kind": "date", "entity": "employee", "field": "start_date", "offsetDays": 0, "time": "08:00",
        "yearly": True},
       [_notify("s1", [{"kind": "self"}, {"kind": "manager"}], "Happy Work Anniversary, {{ subject.name }}!",
                "{{ subject.name }} started on {{ subject.start_date | us_date }}. Thank you for everything "
                "since.")],
       blanks=["steps[0].params.body"]),
]


# ── availability ─────────────────────────────────────────────────────────────
def available(key: str) -> bool:
    """Whether the catalog has what a `requires` entry names."""
    catalog.load_packs()
    if key in catalog.EVENTS or key in catalog.LIST_SOURCES or key in catalog.ACTIONS:
        return True
    if key.startswith("date:"):
        parts = key.split(":", 2)
        if len(parts) == 3:
            ent = catalog.ENTITIES.get(parts[1])
            return ent is not None and any(d.key == parts[2] for d in ent.dates)
    return False


def missing(template: dict) -> list[str]:
    return [k for k in (template.get("requires") or []) if not available(k)]


def built_in(key: str):
    return next((t for t in TEMPLATES if t["key"] == key), None)


# ── company templates ────────────────────────────────────────────────────────
def _key(company_id: str) -> str:
    return f"{SETTING}:{company_id}" if company_id else SETTING


def company_templates(db, company_id: str) -> list[dict]:
    row = db.get(models.NexusSetting, _key(company_id))
    try:
        rows = json.loads(row.value) if row and row.value else []
    except (TypeError, ValueError):
        rows = []
    return [r for r in rows if isinstance(r, dict) and r.get("key")]


def _write(db, company_id: str, rows: list, actor: str) -> None:
    row = db.get(models.NexusSetting, _key(company_id))
    if row is None:
        row = models.NexusSetting(key=_key(company_id))
        db.add(row)
    row.value = json.dumps(rows)
    row.updated_by = actor
    row.updated_at = datetime.now(timezone.utc).isoformat()


def save_as_template(db, wf, user: dict, *, name: str = "", description: str = "") -> dict:
    """A full-level user keeps a workflow's draft as a company template
    (the organization's when the workflow is for every company)."""
    from workflows import store
    company_id = wf.company_id or ""
    rows = company_templates(db, company_id)
    entry = {
        "key": f"custom-{uuid.uuid4().hex[:12]}", "name": (name or wf.name or "Template").strip()[:120],
        "module": "custom", "description": (description or wf.description or "").strip()[:500],
        "definition": store.draft_of(wf), "blanks": [], "requires": [], "builtIn": False,
        "companyId": company_id, "createdBy": (user.get("email") or "").lower(),
        "createdAt": datetime.now(timezone.utc).isoformat(), "fromWorkflow": wf.id,
    }
    rows.append(entry)
    _write(db, company_id, rows, entry["createdBy"])
    return entry


def visible(db, user: dict, companies=None) -> list[dict]:
    """The built-in templates whose needs the catalog meets, plus the
    organization's and the caller's companies' saved ones."""
    out = [dict(t, missing=[]) for t in TEMPLATES if not missing(t)]
    seen_companies = [""]
    if companies is None:
        seen_companies += [r.id for r in db.query(models.HrEntity.id).all()]
    else:
        seen_companies += [c for c in companies if c]
    for cid in dict.fromkeys(seen_companies):
        out += company_templates(db, cid)
    return out


def find(db, key: str, user: dict, companies=None):
    for t in visible(db, user, companies):
        if t["key"] == key:
            return t
    return None


def serialize(t: dict) -> dict:
    return {"key": t["key"], "name": t["name"], "module": t.get("module") or "core",
            "description": t.get("description") or "", "definition": t["definition"],
            "blanks": list(t.get("blanks") or []), "requires": list(t.get("requires") or []),
            "builtIn": bool(t.get("builtIn", False)), "companyId": t.get("companyId", ""),
            "createdBy": t.get("createdBy", ""), "createdAt": t.get("createdAt", "")}
