"""The five Super Administrators, set once (Neil, 11/02/2026).

Super Administrator is the `owner` tier (level 5) - the only tier that sees
past the company walls (auth.is_global_admin). Neil named the five people
who hold it for now; everyone else who held `owner` becomes an Administrator
(level 4, company-walled). This pass runs at startup after the migrations,
on dev and prod alike, and records itself in nexus_settings under MARK so it
never re-applies: a Super Administrator later demoted by a Super
Administrator stays demoted after a restart, and a later promotion stands.
Never turn this into a code default that reasserts the set.
"""
from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

MARK = "roles.super_admins_set_2026_11_02"

SUPER_ADMINS = (
    "neil@greensglobal.com",
    "visesh.lodha@greensglobal.com",
    "charmi@greensglobal.com",
    "pranshu.pandey@greensglobal.com",
    "sagar.shoundik@greensglobal.com",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def apply_once(db: Session) -> dict | None:
    """Set the five to `owner` (tier pinned, so a job role's tier never
    re-stamps them) and every OTHER `owner` row to `administrator`, then
    write the mark. Returns what changed, or None when the mark is already
    there (nothing touched). Commits."""
    from models import NexusRole, NexusSetting
    import auth

    if db.get(NexusSetting, MARK):
        return None
    now = _now()
    promoted, demoted = [], []
    for email in SUPER_ADMINS:
        row = db.query(NexusRole).filter(func.lower(NexusRole.email) == email).first()
        if row is None:
            row = NexusRole(email=email, role="owner", assigned_by="super_admins_seed")
            db.add(row)
        elif row.role != "owner":
            row.role = "owner"
            row.assigned_by = "super_admins_seed"
        row.tier_pinned = True
        promoted.append(email)
    for row in db.query(NexusRole).filter(NexusRole.role == "owner").all():
        if (row.email or "").lower() in SUPER_ADMINS:
            continue
        row.role = "administrator"
        row.assigned_by = "super_admins_seed"
        demoted.append(row.email)
    db.add(NexusSetting(key=MARK, value=now, updated_by="startup", updated_at=now))
    db.commit()
    auth.invalidate_role_cache()
    return {"super_admins": promoted, "demoted": demoted}
