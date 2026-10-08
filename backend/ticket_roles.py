"""Ticket desk roles (Oct 2026) - who may work the service desk, and how much.

Before this, `_has_desk_grant` / `require_ticket_desk` in routers/tickets.py
made ANY Access Group grant on the `tasks` OR `tickets` module, at any level,
a full desk agent: the whole company's queue, internal notes, deleting
comments and attachments, managing components and links. Fine for one
company that hands those grants out deliberately; not a rule a new customer
should inherit.

This module puts named roles on top of the EXISTING module-grant levels
(auth.MODULE_LEVELS - viewer/editor/full/owner on an Access Group). Nothing
new is stored per person; a person's role is read from the grants they
already have.

Roles:
  requester   - no desk role. Raises tickets and reads/replies on the ones
                they are part of (the participant-scoped behavior every
                employee has always had).
  agent       - works the queue: the whole queue, internal notes, assign,
                reply, change status/priority, saved views, ticket links.
  supervisor  - agent + delete (tickets, comments, attachments, bulk delete),
                desk settings, components, sending a ticket for approval.

Which grants make which role is a company setting, `deskAccess`
(NexusSetting key "ticket_desk_access", edited by administrators on Admin >
Service Desk > Desk Access):

  legacy   (the rule Nexus always had) - any tasks OR tickets grant at viewer
           or above is a desk member, and every desk member keeps every desk
           power they have today (role "supervisor": before roles existed
           there was no agent/supervisor split, so nobody loses anything).
  explicit - only the `tickets` grant counts:
               tickets viewer / editor -> agent
               tickets full / owner    -> supervisor
               no tickets grant        -> requester (a tasks grant alone no
                                          longer opens the desk)

In both modes an administrator (role level 4+) is a supervisor - they run
every screen and must be able to unstick the desk - and an external (B2B
guest) user is always a requester, whatever their grant says.

Default (see seed_desk_access_mode, run once at startup): a database that
already has tickets, tasks or a tasks/tickets grant is an existing install
and is pinned to `legacy`, so its agents keep their access; a brand-new
database is pinned to `explicit`. The choice is WRITTEN the first time, so a
new customer's database stays `explicit` after its first ticket is raised.
If the row is somehow missing at request time, the answer is `legacy` - the
rule that never takes access away.
"""
import json
from datetime import datetime, timezone

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

import models
from database import get_db

SETTING_KEY = "ticket_desk_access"
LEGACY, EXPLICIT = "legacy", "explicit"
MODES = (LEGACY, EXPLICIT)

REQUESTER, AGENT, SUPERVISOR = "requester", "agent", "supervisor"
_ROLE_RANK = {REQUESTER: 0, AGENT: 1, SUPERVISOR: 2}

# explicit mode: the tickets grant's level -> desk role. Anything at/above
# `full` supervises (a rank above owner - a test or a future level - too).
EXPLICIT_ROLE_FOR_LEVEL = {"viewer": AGENT, "editor": AGENT, "full": SUPERVISOR, "owner": SUPERVISOR}


# ── The setting ──────────────────────────────────────────────────────────────

def _read_stored(db: Session) -> str | None:
    import cache
    key = ("ticket_desk_access",)
    hit = cache.settings_config.get(key)
    if hit is not None:
        return hit or None
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTING_KEY).first()
    mode = None
    if row and row.value:
        try:
            mode = (json.loads(row.value) or {}).get("mode")
        except (TypeError, ValueError, AttributeError):
            mode = None
    mode = mode if mode in MODES else None
    cache.settings_config.set(key, mode or "")
    return mode


def desk_access_mode(db: Session) -> str:
    """The company's desk-access rule. Unset reads as legacy: of the two, it
    is the one that can never take access away from anybody."""
    return _read_stored(db) or LEGACY


def set_desk_access_mode(db: Session, mode: str, actor_email: str) -> str:
    if mode not in MODES:
        raise ValueError(f"deskAccess must be one of: {', '.join(MODES)}")
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTING_KEY).first()
    if not row:
        row = models.NexusSetting(key=SETTING_KEY)
        db.add(row)
    row.value = json.dumps({"mode": mode})
    row.updated_by = actor_email or ""
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    import cache
    cache.settings_config.invalidate(("ticket_desk_access",))
    return mode


def _existing_install(db: Session) -> bool:
    """Has this database already been in use as a service desk / task
    workspace? Any ticket, any task, or any Access Group granting tasks or
    tickets says yes."""
    if db.query(models.TaskTicket.id).first() is not None:
        return True
    if db.query(models.Task.id).first() is not None:
        return True
    for (mods,) in db.query(models.NexusGroup.allowed_modules).all():
        for part in (mods or "").split(","):
            if part.strip().partition(":")[0] in ("tasks", "tickets"):
                return True
    return False


def seed_desk_access_mode(db: Session) -> str | None:
    """Startup, once: pin the default for this database if nobody has chosen.
    Existing data -> legacy (nothing changes for its agents); an empty
    database -> explicit (a new customer starts on the safer rule). Returns
    the mode written, or None when one was already stored."""
    if _read_stored(db) is not None:
        return None
    mode = LEGACY if _existing_install(db) else EXPLICIT
    set_desk_access_mode(db, mode, "system")
    return mode


# ── Roles ────────────────────────────────────────────────────────────────────

def _role_from_grants(grants: dict, mode: str) -> str:
    import auth
    viewer = auth._MODULE_LEVEL_RANK["viewer"]
    if mode == EXPLICIT:
        rank = grants.get("tickets", 0)
        if rank >= auth._MODULE_LEVEL_RANK["full"]:
            return SUPERVISOR
        return AGENT if rank >= viewer else REQUESTER
    # legacy: exactly the old _has_desk_grant test, with every desk power.
    if any(grants.get(m, 0) >= viewer for m in ("tasks", "tickets")):
        return SUPERVISOR
    return REQUESTER


def ticket_role(user: dict, db: Session, mode: str | None = None) -> str:
    """requester / agent / supervisor for the signed-in `user` dict."""
    import auth
    if user.get("external"):
        return REQUESTER
    if user.get("level", 0) >= auth._LEVELS["administrator"]:
        return SUPERVISOR
    grants = auth._grants_for(user.get("email") or "", db)
    return _role_from_grants(grants, mode or desk_access_mode(db))


def _at_least(user: dict, db: Session, role: str) -> bool:
    return _ROLE_RANK[ticket_role(user, db)] >= _ROLE_RANK[role]


# The named checks. Use these - never a raw grant lookup - wherever a ticket
# endpoint or screen decides what someone may do on the desk.
def can_work_queue(user: dict, db: Session) -> bool:
    """See the whole company's queue, open any ticket, edit triage fields."""
    return _at_least(user, db, AGENT)


def can_read_internal(user: dict, db: Session) -> bool:
    """Read and write internal notes (subject to the requester carve-out in
    routers/tickets.py _sees_internal)."""
    return _at_least(user, db, AGENT)


def can_assign(user: dict, db: Session) -> bool:
    return _at_least(user, db, AGENT)


def can_delete(user: dict, db: Session) -> bool:
    """Delete tickets (incl. bulk), comments and attachments."""
    return _at_least(user, db, SUPERVISOR)


def can_manage_desk(user: dict, db: Session) -> bool:
    """Desk settings, components, departments, approval routing."""
    return _at_least(user, db, SUPERVISOR)


def capabilities(user: dict, db: Session) -> dict:
    mode = desk_access_mode(db)
    role = ticket_role(user, db, mode)
    rank = _ROLE_RANK[role]
    return {
        "role": role,
        "deskAccess": mode,
        "canWorkQueue": rank >= _ROLE_RANK[AGENT],
        "canReadInternal": rank >= _ROLE_RANK[AGENT],
        "canAssign": rank >= _ROLE_RANK[AGENT],
        "canDelete": rank >= _ROLE_RANK[SUPERVISOR],
        "canManageDesk": rank >= _ROLE_RANK[SUPERVISOR],
    }


def _require(check, message: str):
    import auth

    def _dep(user: dict = Depends(auth.get_current_user), db: Session = Depends(get_db)):
        if check(user, db):
            return user
        raise HTTPException(403, message)
    return _dep


require_ticket_agent = _require(can_work_queue, "You don't have access to this screen")
require_ticket_supervisor = _require(can_manage_desk, "Only a ticket supervisor can do this")


# ── Switching preview ────────────────────────────────────────────────────────

def access_changes(db: Session, to_mode: str) -> list:
    """Everyone whose desk role would DROP if the company switched to
    `to_mode` - the list an administrator sees before switching. Read from
    the Access Groups (where every grant lives), so it covers everybody with
    a tasks or tickets grant; administrators and guests are left out (their
    role is the same in both modes)."""
    import auth
    from sqlalchemy import func
    emails = set()
    rows = (db.query(models.NexusGroupMember.email, models.NexusGroup.allowed_modules)
            .join(models.NexusGroup, models.NexusGroup.id == models.NexusGroupMember.group_id).all())
    for email, mods in rows:
        if any(p.strip().partition(":")[0] in ("tasks", "tickets") for p in (mods or "").split(",")):
            emails.add((email or "").strip().lower())
    out = []
    current = desk_access_mode(db)
    for email in sorted(e for e in emails if e):
        if auth.level_for(email, db) >= auth._LEVELS["administrator"]:
            continue
        emp = (db.query(models.NexusEmployee)
               .filter(func.lower(models.NexusEmployee.work_email) == email).first())
        if emp is not None and (emp.identity_type or "internal") in ("guest", "external"):
            continue
        grants = auth._grants_for(email, db)
        before = _role_from_grants(grants, current)
        after = _role_from_grants(grants, to_mode)
        if _ROLE_RANK[after] < _ROLE_RANK[before]:
            name = " ".join(x for x in ((emp.first_name or "").strip(), (emp.last_name or "").strip()) if x) if emp else ""
            out.append({"email": email, "name": name, "from": before, "to": after})
    return out
