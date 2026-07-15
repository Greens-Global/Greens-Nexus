"""Shared helpers for the Task Module routers (Jul 2026).

Mirrors the conventions in routers/items.py: ISO-string timestamps, snake→camel
serialisers, a fire-and-forget Supabase realtime ping (task_events, anon-readable
so it carries no sensitive payload), and server-side notifications. The module
has its OWN in-app bell backed by `task_notifications` (parity with the export),
and `task_notify` also mirrors each notification into the shared Nexus bell
(`nexus_notifications`, the same table items.py writes to) so task/ticket
events show up in the global bell in TopHeader, not just inside the module.
"""
import json
import os
import threading
import uuid
from datetime import datetime, timezone

import httpx
from sqlalchemy.orm import Session

from models import TaskNotification, TaskActivity, NexusRole, NexusNotification

_SUPABASE_URL = os.getenv("SUPABASE_URL", "")
_SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def gen_id() -> str:
    return str(uuid.uuid4())


# ── Realtime ping ───────────────────────────────────────────────────────────
def _post_task_event(task_id: str, kind: str) -> None:
    try:
        httpx.post(
            f"{_SUPABASE_URL}/rest/v1/task_events",
            headers={
                "apikey": _SUPABASE_SERVICE_KEY,
                "Authorization": f"Bearer {_SUPABASE_SERVICE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            # affected_email deliberately blank — task_events is anon-readable for
            # realtime pings, so nothing personal is written. Clients refetch via
            # the authenticated API.
            json={"task_id": task_id, "kind": kind, "affected_email": ""},
            timeout=5.0,
        )
    except Exception:
        pass


def fire_task_event(task_id: str = "", kind: str = "") -> None:
    """Notify subscribed clients that task data changed, so they refetch."""
    if not _SUPABASE_URL or not _SUPABASE_SERVICE_KEY:
        return
    threading.Thread(target=_post_task_event, args=(task_id, kind), daemon=True).start()


# ── Notifications (module's own bell → task_notifications) ───────────────────
def task_notify(db: Session, *, kind: str, for_email: str, title: str, body: str = "",
                task_id: str = "", department_id: str = "", request_id: str = "",
                nexus_action: dict | None = None) -> None:
    """Create one in-app notification. `for_email` is a specific address or the
    literal "admins" to fan out to every administrator (resolved client-side).
    Server-side only — employees can't POST notifications directly.

    Also mirrors into the shared Nexus bell (nexus_notifications) so the same
    event surfaces in TopHeader's global bell, not just the module's own one.
    `nexus_action`, if given, is `{"view": ..., "sub": ..., "label": ...}` —
    NotificationBell's default click handler dispatches nexus:navigate to it.
    """
    target = for_email if for_email == "admins" else (for_email or "").lower()
    if not target:
        return
    db.add(TaskNotification(
        id=gen_id(), kind=kind, title=title, body=body, for_email=target,
        request_id=request_id, department_id=department_id, task_id=task_id,
        read=False, created_at=now_iso(),
    ))
    recipients = admin_emails(db) if target == "admins" else [target]
    action_json = json.dumps(nexus_action) if nexus_action else ""
    now = now_iso()
    for recipient in recipients:
        db.add(NexusNotification(
            id=gen_id(), type=f"task_{kind}", recipient=recipient, title=title, body=body,
            ref_id=task_id or request_id, item_name="", requested_by="", action=action_json,
            actioned=False, read_by="", created_at=now,
        ))


# ── Activity feed ────────────────────────────────────────────────────────────
def log_activity(db: Session, *, type: str, actor_email: str, entity_kind: str = "task",
                 entity_id: str = "", entity_code: str = "", entity_title: str = "",
                 detail: str = "") -> str:
    aid = gen_id()
    db.add(TaskActivity(
        id=aid, entity_kind=entity_kind, entity_id=entity_id, entity_code=entity_code,
        entity_title=entity_title, type=type, actor_email=actor_email, at=now_iso(),
        detail=detail,
    ))
    return aid


def admin_emails(db: Session) -> list[str]:
    """Emails of everyone at administrator level or above (for 'admins' fan-out
    when a caller needs the concrete list)."""
    rows = db.query(NexusRole).filter(NexusRole.role.in_(["administrator", "owner"])).all()
    return [r.email for r in rows if r.email]
