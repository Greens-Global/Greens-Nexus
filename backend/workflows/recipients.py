"""Recipients (spec 5.5): a `recipients` param is a list of specs that
resolve to Nexus directory people - the subject's people roles (`self`,
`manager`, `hr_contact`, `assignees`, ...), a named person, a role in the
company (the HR contact, the Global Admins), a department or a manager's
team (through `kb_audience.members`) or everyone in the company (capped).
Every resolved email must be a current directory person who may see the
record (`entity.visible_to`) before a message about it goes out; the cap
drops the rest. `resolve` returns the emails and how many were dropped so
the step can say so.
"""
from __future__ import annotations

from typing import Any

from workflows.context import RunContext

KINDS = ("self", "manager", "hr_contact", "assignees", "creator", "followers", "approver", "owner",
         "person", "role", "department", "team", "company", "global_admins")
ROLES = ("hr_contact", "global_admins")


def _emails(vals) -> list[str]:
    out: list[str] = []
    for v in vals or ():
        for e in str(v or "").split(","):
            e = e.strip().lower()
            if e and "@" in e and e not in out:
                out.append(e)
    return out


def global_admins(db) -> list[str]:
    import models
    rows = db.query(models.NexusRole).filter(models.NexusRole.role == "owner").all()
    return _emails(r.email for r in rows)


def hr_contacts(db, company_id: str) -> list[str]:
    import hr_access
    return _emails(hr_access.hr_contacts(db, company_id or ""))


def _audience(db, spec: dict) -> list[str]:
    import kb_audience
    return _emails(e.work_email for e in kb_audience.members(db, spec))


def _people_role(ctx: RunContext, role: str) -> list[str]:
    if ctx.entity is None or role not in ctx.entity.people:
        return []
    if ctx.subject is None:
        # a sample / dry run with no row: the payload's person fields stand in
        sub = (ctx.payload or {}).get("subject") or {}
        if role == "self":
            return _emails([sub.get("work_email") or sub.get("email") or sub.get("employee_email")])
        if role == "manager":
            return _emails([sub.get("manager_email")])
        if role == "hr_contact":
            return hr_contacts(ctx.db, ctx.company())
        return _emails(sub.get(role) if isinstance(sub.get(role), list) else [sub.get(role)])
    try:
        return _emails(ctx.entity.people[role](ctx.db, ctx.subject))
    except Exception as e:   # noqa: BLE001 - one role that cannot be read drops out, the rest still go
        print(f"[workflows] recipients: {ctx.entity.key}.{role} not read: {type(e).__name__}: {str(e)[:120]}")
        return []


def expand(ctx: RunContext, item: dict) -> list[str]:
    """One spec item -> raw emails (not yet checked)."""
    kind = str((item or {}).get("kind") or "").strip()
    value = (item or {}).get("value")
    company = ctx.company()
    if kind == "person":
        return _emails([value])
    if kind == "role":
        return _role(ctx, str(value or ""), company)
    if kind == "global_admins":
        return global_admins(ctx.db)
    if kind == "department":
        if not value:
            return []
        spec: dict[str, Any] = {"departments": [str(value)]}
        if company:
            spec["companies"] = [company]
        return _audience(ctx.db, spec)
    if kind == "team":
        return _audience(ctx.db, {"managers": [str(value or "").lower()]}) if value else []
    if kind == "company":
        cid = str(value or company or "")
        return _audience(ctx.db, {"companies": [cid]}) if cid else []
    if kind == "owner" and (ctx.entity is None or "owner" not in ctx.entity.people):
        return _emails([getattr(ctx.workflow, "owner_email", "")])
    if kind in KINDS or (ctx.entity is not None and kind in ctx.entity.people):
        if kind == "hr_contact" and (ctx.entity is None or "hr_contact" not in ctx.entity.people):
            return hr_contacts(ctx.db, company)
        return _people_role(ctx, kind)
    return []


def _role(ctx: RunContext, role: str, company: str) -> list[str]:
    if role == "hr_contact":
        return hr_contacts(ctx.db, company)
    if role == "global_admins":
        return global_admins(ctx.db)
    return []


def _directory_user(db, email: str):
    from task_automation import _person_user
    return _person_user(db, email)


def resolve(ctx: RunContext, spec, *, cap: int) -> tuple[list[str], int]:
    """Specs -> deduped, lowercased directory emails that may see the
    record, at most `cap`; plus how many were dropped (visibility and cap)."""
    items = spec if isinstance(spec, (list, tuple)) else ([spec] if spec else [])
    raw: list[str] = []
    for it in items:
        if isinstance(it, str):
            it = {"kind": "person", "value": it}
        for e in expand(ctx, it):
            if e not in raw:
                raw.append(e)
    import auth
    # the company wall, whatever the entity's own rule says: a message
    # about a record never crosses to someone whose scope excludes its
    # company (a record with no company is shared)
    company = (ctx.entity.company_of(ctx.subject) if ctx.entity is not None and ctx.subject is not None
               else ctx.company())
    kept: list[str] = []
    dropped = 0
    for e in raw:
        user = _directory_user(ctx.db, e)
        if user is None or user.get("external"):
            dropped += 1     # not a current directory person, or an external identity: never a recipient
            continue
        if company and not auth.company_ok(company, auth.company_scope(user, ctx.db), shared_when_blank=True):
            dropped += 1
            continue
        if ctx.entity is not None and ctx.subject is not None and not ctx.entity.can_see(ctx.db, user, ctx.subject):
            dropped += 1
            continue
        kept.append(e)
    cap = max(0, int(cap or 0))
    if cap and len(kept) > cap:
        dropped += len(kept) - cap
        kept = kept[:cap]
    return kept, dropped


def describe(spec) -> str:
    """Plain words for a spec list: "the manager, the HR contact and Priya"."""
    items = spec if isinstance(spec, (list, tuple)) else ([spec] if spec else [])
    words = []
    for it in items:
        if isinstance(it, str):
            words.append(it)
            continue
        kind = str((it or {}).get("kind") or "")
        value = str((it or {}).get("value") or "")
        if kind == "person":
            words.append(value)
        elif kind == "role":
            words.append("the HR contact" if value == "hr_contact" else "the Global Admins")
        elif kind == "department":
            words.append(f"the {value} department")
        elif kind == "team":
            words.append(f"{value}'s team")
        elif kind == "company":
            words.append("everyone in the company")
        elif kind == "global_admins":
            words.append("the Global Admins")
        elif kind == "self":
            words.append("the person")
        elif kind:
            words.append("the " + kind.replace("_", " "))
    if not words:
        return "nobody"
    if len(words) == 1:
        return words[0]
    return ", ".join(words[:-1]) + " and " + words[-1]
