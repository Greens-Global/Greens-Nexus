"""Operations: which facilities a person sees and whether they see tenant
details (Neil, 11/17/2026).

Nexus keeps a read-only copy of tenant contact details (ops_tenants,
cubby_sync.py). Who reads it is decided here and nowhere else - by role (an
Access Group / job role) and by person, including which facilities each sees:

  ops_access_rules   one row per subject: a person (work email) or a group
                     (NexusGroup.id). `facility_ids` [] = every facility;
                     `tenant_details` = may see tenant contact details.

  reach(user, db)    {"facilities": None | set of ids, "tenant_details": bool}
    - Administrator and above (level 4+): every facility, tenant details.
    - Everyone else: their own rule plus the rules of every group they belong
      to. Facilities are the UNION (None = every facility, as soon as one
      matching rule says so); tenant details are on as soon as one rule has
      them on.
    - No rule at all: FAIL CLOSED on tenant details - nobody below
      Administrator sees a phone number until a rule says so. Their
      facilities stay unlimited (None), as Operations has always shown them.

  may_manage(user, db)   who edits the rules: Administrator and above, or an
                     Operations grant at Full - the same rule as the Push to
                     Cubby switch (routers/ops_settings.py).

This only narrows who reads tenant details. The door to Operations itself is
still `require_level_or_module(2, "operations", "viewer")` on the routers.
"""
from __future__ import annotations

from sqlalchemy import and_, or_, select

import auth

DENIED = "You do not have access to tenant details."


def rules_for(email: str, db) -> list:
    """The person's own rule and the rules of every Access Group / job role
    they belong to."""
    import models as m
    email = (email or "").strip().lower()
    if not email:
        return []
    R, M = m.OpsAccessRule, m.NexusGroupMember
    mine = select(M.group_id).where(M.email == email)
    return (db.query(R)
            .filter(or_(and_(R.subject_type == "person", R.subject_id == email),
                        and_(R.subject_type == "group", R.subject_id.in_(mine))))
            .all())


def reach(user: dict, db) -> dict:
    """{"facilities": None | set[str], "tenant_details": bool}. `facilities`
    None = every facility."""
    if int(user.get("level", 0) or 0) >= auth._LEVELS["administrator"]:
        return {"facilities": None, "tenant_details": True}
    rows = rules_for(user.get("email", ""), db)
    if not rows:
        return {"facilities": None, "tenant_details": False}
    every, ids = False, set()
    for r in rows:
        if r.facility_ids == []:
            every = True
        elif isinstance(r.facility_ids, list):   # anything else (a hand-edited row) grants no facility
            ids |= {str(f) for f in r.facility_ids if f}
    return {"facilities": None if every else ids, "tenant_details": any(bool(r.tenant_details) for r in rows)}


def may_manage(user: dict, db) -> bool:
    """Administrator and above, or an Operations grant at Full."""
    if int(user.get("level", 0) or 0) >= auth._LEVELS["administrator"]:
        return True
    try:
        return auth._module_level(user["email"], "operations", db) >= auth._MODULE_LEVEL_RANK["full"]
    except Exception:  # noqa: BLE001 - a flag on the screen must not 500 it; in doubt, no
        return False


def sees(reached: dict, facility_id: str) -> bool:
    """Is this facility inside a reach()?"""
    return reached["facilities"] is None or facility_id in reached["facilities"]


def narrow(reached: dict, facility_ids) -> list[str]:
    """The given facility ids that are inside a reach(), in their order."""
    return [f for f in facility_ids if sees(reached, f)]
