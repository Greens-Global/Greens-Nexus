"""Nexus AI Assistant - the shared tool-dispatch engine (Phase 0 + 1 + 2).

Raw httpx against the Messages API, matching construction_ai.py / help.py /
items.py's web-search call. The codebase has no Anthropic SDK dependency and
adding one for this module alone would leave two ways to call the same API.

SECURITY INVARIANT - read before adding a tool: every tool handler is called
with the server-resolved `user` dict from auth.get_current_user. A handler
must scope its query using `user["email"]` (or existing scoping helpers like
auth.company_scope) and must never let a model-supplied argument widen that
scope - the model chooses WHAT to ask, never WHOSE data it reads. This is the
whole reason the assistant is safe to expose to every employee from day one.

Every tool here is read-only and scoped to the caller's own rows. Tools that
belong to another developer's owned module (items.py is Visesh's) query
models.py directly, or import a handful of plain, non-router helper
functions from that module (e.g. routers.timeclock, routers.task_util) -
never the router file's own endpoint functions, and no router file is ever
edited from here. Later modules add their own tools to _TOOLS /
_TOOL_HANDLERS here - one engine, same as asana_sync.py is "one engine,
three entry points" for the Asana side.
"""
import os
from datetime import date, timedelta

import httpx
from sqlalchemy.orm import Session

import models

_API = "https://api.anthropic.com/v1/messages"
_MODEL = os.getenv("NEXUS_ASSISTANT_MODEL", "claude-sonnet-5")
_TIMEOUT = 60
_MAX_TOOL_ITERATIONS = 6

_SYSTEM = """You are the Nexus Assistant, built into Greens Nexus (the internal staff portal for Greens Global).

You can look up the asking user's own profile, notifications, clock status and worked hours, tasks, items they hold, and search the Knowledge Base for SOPs and guides. You can also look up their e-signature status (pending/signed/sent), their documents, their manager and direct reports, their time-off requests, their open HR requests, their paystubs, their payroll/timecard status for the current period, and their Credential Vault metadata (never secret values).

There is no leave-balance/accrual system in Nexus - only days taken/pending this year. There is no "next payday" date, only pay-period boundaries. Never imply a balance or payday date exists; say so plainly if asked.

Answer only from what your tools return - never invent data about the user's items, notifications, hours, tasks, documents, pay, or anything else in Nexus. If a tool has no data or you have no tool for what was asked, say so plainly and suggest what the person could check manually; do not guess.

Keep answers short and direct. Use Markdown (lists, bold) only when it genuinely helps readability. Use American English spelling. Never use em dashes; use plain hyphens."""


def configured() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY", "").strip())


# ── Tool schemas (Anthropic custom tool-use format) ─────────────────────────
_TOOLS = [
    {
        "name": "get_my_profile",
        "description": "Get the asking user's own Nexus employee profile: name, role, department, job title.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "get_my_notifications",
        "description": "Get the asking user's own recent Nexus notifications (approvals, reminders, etc.).",
        "input_schema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "Max notifications to return, default 10, max 25."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_my_clock_status",
        "description": "Get whether the asking user is currently clocked in, clocked out, or on break, and since when.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "get_my_hours",
        "description": "Get the asking user's worked hours per day over a date range (e.g. \"my hours yesterday\").",
        "input_schema": {
            "type": "object",
            "properties": {
                "start": {"type": "string", "description": "ISO date yyyy-mm-dd, inclusive. Defaults to yesterday."},
                "end": {"type": "string", "description": "ISO date yyyy-mm-dd, inclusive. Defaults to today."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_my_tasks",
        "description": "Get tasks assigned to the asking user from the Tasks module.",
        "input_schema": {
            "type": "object",
            "properties": {
                "filter": {"type": "string", "enum": ["open", "due_today", "overdue", "completed"],
                            "description": "Which subset to return. Defaults to open."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_my_items",
        "description": "Get items the asking user currently holds or has pending, checked-out or permanently assigned.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "search_knowledge_base",
        "description": "Search the Nexus Knowledge Base for an approved SOP, manual or guide matching a topic.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to search for, e.g. 'Microsoft admin'."},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_my_esign_status",
        "description": "Get the asking user's e-signature status: documents awaiting their signature, already signed, or sent by them for signature.",
        "input_schema": {
            "type": "object",
            "properties": {
                "filter": {"type": "string", "enum": ["pending", "signed", "sent"],
                            "description": "Which subset to return. Defaults to pending."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_my_documents",
        "description": "Get documents the asking user owns in the Documents module.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "get_my_manager_and_reports",
        "description": "Get the asking user's manager and, if they manage anyone, their direct reports.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "get_my_time_off",
        "description": "Get the asking user's time-off requests. There is no leave-balance system - only requests, days taken/pending this year.",
        "input_schema": {
            "type": "object",
            "properties": {
                "filter": {"type": "string", "enum": ["upcoming", "pending", "all"],
                            "description": "Which subset to return. Defaults to upcoming."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_my_hr_requests",
        "description": "Get the status of the asking user's own 'Ask HR' requests.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "get_my_paystubs",
        "description": "Get the asking user's own paystub documents (filenames and dates only, no amounts).",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "get_my_payroll_summary",
        "description": "Get the asking user's own payroll/timecard status for a pay period: rate, hours, overtime, and approval/finalize/sign-off state. There is no payday-date field, only period boundaries.",
        "input_schema": {
            "type": "object",
            "properties": {
                "period_start": {"type": "string", "description": "ISO date yyyy-mm-dd for the pay period's start. Defaults to the current period."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_my_vault_credentials",
        "description": "Get metadata (never secret values) for Credential Vault entries the asking user owns or has been shared.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
]


# ── Tool handlers ────────────────────────────────────────────────────────────
def _get_my_profile(user: dict, db: Session, **_args) -> dict:
    row = (
        db.query(models.NexusEmployee)
        .filter(models.NexusEmployee.work_email == user["email"])
        .first()
    )
    if not row:
        return {"found": False, "email": user["email"], "role": user["role"]}
    return {
        "found": True,
        "email": user["email"],
        "role": user["role"],
        "name": f"{row.first_name} {row.last_name}".strip(),
        "job_title": row.job_title,
        "department": row.department,
        "status": row.status,
    }


def _get_my_notifications(user: dict, db: Session, limit: int = 10, **_args) -> dict:
    limit = max(1, min(int(limit or 10), 25))
    rows = (
        db.query(models.NexusNotification)
        .filter(models.NexusNotification.recipient == user["email"])
        .order_by(models.NexusNotification.created_at.desc())
        .limit(limit)
        .all()
    )
    return {
        "notifications": [
            {
                "type": r.type,
                "title": r.title,
                "body": r.body,
                "actioned": r.actioned,
                "created_at": r.created_at,
            }
            for r in rows
        ]
    }


def _get_my_clock_status(user: dict, db: Session, **_args) -> dict:
    last = (
        db.query(models.TimePunch)
        .filter(models.TimePunch.employee_email == user["email"], models.TimePunch.voided == 0)
        .order_by(models.TimePunch.at.desc())
        .first()
    )
    if not last:
        return {"clocked_in": False, "on_break": False, "last_punch": None}
    return {
        "clocked_in": last.kind in ("in", "break_end"),
        "on_break": last.kind == "break_start",
        "last_punch_kind": last.kind,
        "last_punch_at": last.at,
    }


def _get_my_hours(user: dict, db: Session, start: str = "", end: str = "", **_args) -> dict:
    from routers import timeclock
    if not start and not end:
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        start, end = yesterday, date.today().isoformat()
    punches = timeclock._live_punches(db, user["email"], start=start, end=end)
    days = timeclock._day_summaries(
        punches, timeclock._round_min(db),
        break_cfg=timeclock._break_cfg_for(db, user["email"]),
    )
    return {"days": days}


def _get_my_tasks(user: dict, db: Session, filter: str = "open", **_args) -> dict:
    from routers.task_util import wall_tasks, task_assignees
    email = user["email"].lower()
    rows = wall_tasks(db, user, db.query(models.Task).all())
    mine = [t for t in rows if email in task_assignees(t)]

    today = date.today().isoformat()
    if filter == "completed":
        mine = [t for t in mine if t.completed]
    elif filter == "overdue":
        mine = [t for t in mine if not t.completed and t.due_on and t.due_on[:10] < today]
    elif filter == "due_today":
        mine = [t for t in mine if not t.completed and t.due_on and t.due_on[:10] == today]
    else:
        mine = [t for t in mine if not t.completed]

    return {
        "tasks": [
            {"title": t.title, "due_on": t.due_on, "priority": t.priority,
             "status": t.status, "completed": t.completed}
            for t in mine[:20]
        ]
    }


def _get_my_items(user: dict, db: Session, **_args) -> dict:
    checkouts = (
        db.query(models.ItemCheckout)
        .filter(
            models.ItemCheckout.requested_by_email == user["email"],
            models.ItemCheckout.status.in_(["pending", "approved", "pending_receipt", "allocated"]),
        )
        .all()
    )
    assignments = (
        db.query(models.ItemAssignment)
        .filter(
            models.ItemAssignment.assignee_email == user["email"],
            models.ItemAssignment.status.in_(["pending_acceptance", "active", "return_initiated"]),
        )
        .all()
    )
    return {
        "checkouts": [
            {"item_name": c.item_name, "status": c.status,
             "in_hand": c.status == "allocated"}
            for c in checkouts
        ],
        "assignments": [
            {"item_name": a.item_name, "status": a.status,
             "in_hand": a.status in ("active", "return_initiated"),
             "pending_your_acceptance": a.status == "pending_acceptance"}
            for a in assignments
        ],
    }


def _search_knowledge_base(user: dict, db: Session, query: str = "", **_args) -> dict:
    from routers import knowledge_base
    if not query.strip():
        return {"results": []}
    docs = knowledge_base._rank_docs(query, db)
    return {
        "results": [
            {"doc_code": d.doc_code, "title": d.title, "summary": knowledge_base._doc_context(d)}
            for d in docs
        ]
    }


def _get_my_esign_status(user: dict, db: Session, filter: str = "pending", **_args) -> dict:
    from routers import esign
    email = user["email"].lower()

    if filter == "signed":
        parties = (
            db.query(models.HrSignParty)
            .filter(models.HrSignParty.email == email, models.HrSignParty.status == "signed")
            .all()
        )
        out = []
        for p in parties:
            req = db.query(models.HrSignRequest).filter(models.HrSignRequest.id == p.request_id).first()
            if req:
                out.append({"title": req.title, "signed_at": p.signed_at, "completed_at": req.completed_at})
        return {"signed": out}

    if filter == "sent":
        reqs = db.query(models.HrSignRequest).filter(models.HrSignRequest.created_by == user["email"]).all()
        out = []
        for req in reqs:
            parties = db.query(models.HrSignParty).filter(models.HrSignParty.request_id == req.id).all()
            signed = sum(1 for p in parties if p.status == "signed")
            out.append({"title": req.title, "status": req.status, "signed": signed, "total": len(parties)})
        return {"sent": out}

    return {"pending": esign.my_signatures(user=user, db=db)}


def _get_my_documents(user: dict, db: Session, **_args) -> dict:
    from routers import documents
    rows = documents.list_documents(mine=True, user=user, db=db)
    return {"documents": rows}


def _get_my_manager_and_reports(user: dict, db: Session, **_args) -> dict:
    email = user["email"].lower()
    me = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == user["email"]).first()
    manager = None
    if me and me.manager_email:
        mgr_row = (
            db.query(models.NexusEmployee)
            .filter(models.NexusEmployee.work_email.ilike(me.manager_email))
            .first()
        )
        if mgr_row:
            manager = {"name": f"{mgr_row.first_name} {mgr_row.last_name}".strip(), "email": mgr_row.work_email}
    reports = (
        db.query(models.NexusEmployee)
        .filter(models.NexusEmployee.manager_email == email)
        .all()
    )
    return {
        "manager": manager,
        "direct_reports": [
            {"name": f"{r.first_name} {r.last_name}".strip(), "email": r.work_email}
            for r in reports
        ],
    }


def _get_my_time_off(user: dict, db: Session, filter: str = "upcoming", **_args) -> dict:
    from routers import timeclock
    rows = timeclock.my_timeoff(user=user, db=db)
    today = date.today().isoformat()

    if filter == "pending":
        rows = [r for r in rows if r.get("status") == "pending"]
    elif filter == "upcoming":
        rows = [r for r in rows if r.get("status") == "approved" and r.get("end_date", "") >= today]

    return {"requests": rows}


def _get_my_hr_requests(user: dict, db: Session, **_args) -> dict:
    from routers import myhr
    return {"requests": myhr.my_requests(user=user, db=db)}


def _get_my_paystubs(user: dict, db: Session, **_args) -> dict:
    from routers import myhr
    return {"paystubs": myhr.my_paystubs(user=user, db=db)}


def _get_my_payroll_summary(user: dict, db: Session, period_start: str = "", **_args) -> dict:
    from routers import timeclock
    return timeclock.my_payroll(start=period_start or "", user=user, db=db)


def _get_my_vault_credentials(user: dict, db: Session, **_args) -> dict:
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()

    owned = db.query(models.VaultCredential).filter(models.VaultCredential.owner_email == user["email"]).all()
    shared = (
        db.query(models.VaultAccessGrant)
        .filter(models.VaultAccessGrant.granted_to == user["email"], models.VaultAccessGrant.expires_at > now)
        .all()
    )
    personal = (
        db.query(models.VaultPersonalCredential)
        .filter(models.VaultPersonalCredential.owner_email == user["email"])
        .all()
    )
    cred_names = {
        c.id: c.name
        for c in db.query(models.VaultCredential).filter(
            models.VaultCredential.id.in_([g.cred_id for g in shared])
        ).all()
    } if shared else {}
    return {
        "owned": [
            {"name": c.name, "type": c.type, "tier": c.tier, "rotated_at": c.rotated_at,
             "rotation_max_days": c.rotation_max, "expires_at": c.expires_at, "breached": c.breached}
            for c in owned
        ],
        "shared_with_me": [
            {"cred_name": cred_names.get(g.cred_id), "granted_by": g.granted_by, "expires_at": g.expires_at}
            for g in shared
        ],
        "personal": [{"name": p.name, "type": p.type} for p in personal],
    }


_TOOL_HANDLERS = {
    "get_my_profile": _get_my_profile,
    "get_my_notifications": _get_my_notifications,
    "get_my_clock_status": _get_my_clock_status,
    "get_my_hours": _get_my_hours,
    "get_my_tasks": _get_my_tasks,
    "get_my_items": _get_my_items,
    "search_knowledge_base": _search_knowledge_base,
    "get_my_esign_status": _get_my_esign_status,
    "get_my_documents": _get_my_documents,
    "get_my_manager_and_reports": _get_my_manager_and_reports,
    "get_my_time_off": _get_my_time_off,
    "get_my_hr_requests": _get_my_hr_requests,
    "get_my_paystubs": _get_my_paystubs,
    "get_my_payroll_summary": _get_my_payroll_summary,
    "get_my_vault_credentials": _get_my_vault_credentials,
}


def _call_claude(messages: list) -> dict:
    key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    body = {
        "model": _MODEL,
        "max_tokens": 1500,
        "system": _SYSTEM,
        "messages": messages,
        "tools": _TOOLS,
    }
    with httpx.Client(timeout=_TIMEOUT) as c:
        r = c.post(_API, headers={
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }, json=body)
    if r.status_code >= 400:
        raise RuntimeError(f"Anthropic {r.status_code}: {r.text[:300]}")
    return r.json()


def run_assistant_turn(user: dict, db: Session, history: list, user_message: str) -> tuple[str, list]:
    """Run one user turn through the tool-dispatch loop.

    `history` is a list of {"role": "user"|"assistant", "content": str} from
    prior AiMessage rows, oldest first. Returns (reply_text, tool_names_used).
    """
    messages = [{"role": h["role"], "content": h["content"]} for h in history]
    messages.append({"role": "user", "content": user_message})
    tools_used: list[str] = []

    for _ in range(_MAX_TOOL_ITERATIONS):
        data = _call_claude(messages)
        if data.get("stop_reason") == "refusal":
            return "I can't help with that.", tools_used
        content = data.get("content", [])
        if data.get("stop_reason") != "tool_use":
            text = "".join(b.get("text", "") for b in content if b.get("type") == "text").strip()
            return (text or "I don't have an answer for that."), tools_used

        messages.append({"role": "assistant", "content": content})
        tool_results = []
        for block in content:
            if block.get("type") != "tool_use":
                continue
            name = block.get("name")
            handler = _TOOL_HANDLERS.get(name)
            tools_used.append(name)
            try:
                result = handler(user, db, **(block.get("input") or {})) if handler else {"error": f"unknown tool {name}"}
            except Exception as e:  # noqa: BLE001
                result = {"error": str(e)}
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.get("id"),
                "content": str(result),
            })
        messages.append({"role": "user", "content": tool_results})

    return "I wasn't able to finish looking that up - please try rephrasing your question.", tools_used
