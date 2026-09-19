"""Nexus AI Assistant - the shared tool-dispatch engine (Phase 0).

Raw httpx against the Messages API, matching construction_ai.py / help.py /
items.py's web-search call. The codebase has no Anthropic SDK dependency and
adding one for this module alone would leave two ways to call the same API.

SECURITY INVARIANT - read before adding a tool: every tool handler is called
with the server-resolved `user` dict from auth.get_current_user. A handler
must scope its query using `user["email"]` (or existing scoping helpers like
auth.company_scope) and must never let a model-supplied argument widen that
scope - the model chooses WHAT to ask, never WHOSE data it reads. This is the
whole reason the assistant is safe to expose to every employee from day one.

Phase 0 ships exactly two tools, both read-only and scoped to the caller's
own rows: get_my_profile and get_my_notifications. Later modules add their
own tools to _TOOLS / _TOOL_HANDLERS here - one engine, same as asana_sync.py
is "one engine, three entry points" for the Asana side.
"""
import os

import httpx
from sqlalchemy.orm import Session

import models

_API = "https://api.anthropic.com/v1/messages"
_MODEL = os.getenv("NEXUS_ASSISTANT_MODEL", "claude-sonnet-5")
_TIMEOUT = 60
_MAX_TOOL_ITERATIONS = 6

_SYSTEM = """You are the Nexus Assistant, built into Greens Nexus (the internal staff portal for Greens Global).

Answer only from what your tools return - never invent data about the user's items, notifications, role, or anything else in Nexus. If a tool has no data or you have no tool for what was asked, say so plainly and suggest what the person could check manually; do not guess.

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


_TOOL_HANDLERS = {
    "get_my_profile": _get_my_profile,
    "get_my_notifications": _get_my_notifications,
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
