"""Who has Build Mode, set once (Neil, 11/12/2026).

Neil: "anyone who is on the IT development team (Visesh, Pranshu, Sagar) but
also Neil ... granted as a separate access through roles but no new role."

So Build Mode is its OWN access - the `build-mode` module grant - and no
tier opens it by itself, Super Administrator included
(routers/dev_notes.py `_allowed`). This pass makes one Access Group (not a
job role, no tier, shared by every company) named "Build Mode" that grants
the module, with those four people in it. It runs at startup after the
migrations, on dev and prod alike, and records itself in nexus_settings
under MARK so it never re-applies: someone a Super Administrator later takes
out of the group stays out after a restart, and anyone added stays in.
Change who has Build Mode in Settings > People & Access, never here.

A group that already grants `build-mode` is left exactly as it is and no
second one is made - whoever set it up in Settings decided.
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session

MARK = "build_mode.access_set_2026_11_12"
MODULE_ID = "build-mode"
GROUP_NAME = "Build Mode"
GROUP_DESCRIPTION = ("Build Mode: pin comments on live screens and send them to Claude Code. "
                     "The IT development team and Neil (Neil, 11/12/2026).")
PEOPLE = (
    "neil@greensglobal.com",
    "visesh.lodha@greensglobal.com",
    "pranshu.pandey@greensglobal.com",
    "sagar.shoundik@greensglobal.com",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _grants_it(allowed_modules: str) -> bool:
    return any(part.strip().partition(":")[0] == MODULE_ID for part in (allowed_modules or "").split(","))


def apply_once(db: Session) -> dict | None:
    """Make the Build Mode Access Group and put the four people in it, then
    write the mark. Returns {"group": name, "added": [emails]} - `group` is ''
    when a group already granted Build Mode and nothing was made - or None
    when the mark is already there (nothing touched). Commits."""
    from models import NexusGroup, NexusGroupMember, NexusSetting
    import cache

    if db.get(NexusSetting, MARK):
        return None
    now = _now()
    out = {"group": "", "added": []}
    existing = [g for g in db.query(NexusGroup).all() if _grants_it(g.allowed_modules)]
    if not existing:
        gid = str(uuid.uuid4())
        db.add(NexusGroup(id=gid, name=GROUP_NAME, department="", allowed_modules=f"{MODULE_ID}:full",
                          created_by="build_mode_access_seed", created_at=now, is_job_role=0, tier="",
                          description=GROUP_DESCRIPTION, company_id=""))
        for email in PEOPLE:
            db.add(NexusGroupMember(group_id=gid, email=email, added_by="build_mode_access_seed", added_at=now))
        out = {"group": GROUP_NAME, "added": list(PEOPLE)}
    db.add(NexusSetting(key=MARK, value=now, updated_by="startup", updated_at=now))
    db.commit()
    cache.module_grants.invalidate()
    return out
