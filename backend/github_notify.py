"""Tells every Global Admin when a PR lands on `dev` or `main` (Sep 2026).

This is the webhook module's own notifier, same reasoning as
construction_notify.py: `nexus_notifications` is shared infrastructure (many
modules write rows there), so writing to it directly is not a cross-module
dependency - importing another module's notify function would be.

Global Admin = NexusRole.role == "owner" (RoleContext.jsx labels this tier
"Global Admin", level 5). Read fresh on every call rather than cached, since
this fires rarely (once per merge) and must never miss someone promoted
minutes ago.
"""
import uuid
from datetime import datetime, timezone

import models


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def notify_global_admins(db, *, kind: str, title: str, body: str, ref_id: str = "") -> None:
    admins = db.query(models.NexusRole).filter(models.NexusRole.role == "owner").all()
    now = _now()
    for admin in admins:
        db.add(models.NexusNotification(
            id=str(uuid.uuid4()), type=f"github_{kind}", recipient=admin.email.lower(),
            title=title, body=body[:500], ref_id=ref_id, item_name="",
            requested_by="GitHub", action="", actioned=False, read_by="",
            created_at=now,
        ))
    db.commit()
