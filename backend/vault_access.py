"""Who may open a company credential (Credentials, Oct 29 2026).

Until now a credential had one audience it could not change: its own
department (routers/credvault._access_for, Neil Oct 14 2026). That made the
module a poor fit for the logins people actually share - the office Wi-Fi is
for everyone, a vendor portal is for two departments, a bank login is for
three named people - so the spreadsheet stayed. A credential now carries
AUDIENCE rows (models.VaultCredentialAudience):

  kind        value                      who it admits
  company     HrEntity id ('' = any)     every active person in that company
  department  department name            every active person in it (owner's company)
  group       NexusGroup id              the Access Group's members
  person      work email                 that one person, for good (a grant is timed)

each at a level: 'open' reveals the password; 'view' sees the row, username
and link but never the password (Bitwarden's "view, except passwords" - for
the people who need to know a login exists and who to ask).

A credential with NO audience rows keeps the old rule exactly: its own
department opens it unless the tier is Critical. On a Critical credential
only PERSON rows count - a whole company, department or group never opens
the most sensitive logins; the owner names people, or shares for a while.

Department heads (Settings > Companies > Departments: head and backup) manage
every credential of their department - edit, share, approve, transfer - the
same as a backup owner, so a login does not wait on one person's holiday.

No routes here; routers/credvault.py calls these inside its own session.
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import func

import models
from auth import company_of

KINDS = ("company", "department", "group", "person")
LEVELS = ("open", "view")
ANY_COMPANY = ""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _active(e) -> bool:
    return bool(e.work_email) and (e.status or "active").lower() == "active" and not (e.deleted_at or "")


def person_ctx(db, email: str) -> dict:
    """What decides a person's audience membership: their department, company
    and Access Groups. One query each, computed once per request."""
    email = (email or "").lower()
    e = (db.query(models.NexusEmployee.department, models.NexusEmployee.company)
         .filter(func.lower(models.NexusEmployee.work_email) == email).first())
    groups = {g for (g,) in db.query(models.NexusGroupMember.group_id)
              .filter(models.NexusGroupMember.email == email).all()}
    return {"email": email, "dept": ((e.department if e else "") or "").strip().lower(),
            "company": (e.company if e else "") or "", "groups": groups}


def rows_for(db, cred_ids) -> dict:
    """{cred_id: [audience rows]} for the given credentials."""
    ids = [i for i in cred_ids if i]
    out: dict = {i: [] for i in ids}
    if not ids:
        return out
    for r in db.query(models.VaultCredentialAudience).filter(models.VaultCredentialAudience.cred_id.in_(ids)).all():
        out.setdefault(r.cred_id, []).append(r)
    return out


def _matches(row, ctx: dict) -> bool:
    v = (row.value or "").strip()
    if row.kind == "company":
        return v == ANY_COMPANY or (ctx["company"] and v == ctx["company"])
    if row.kind == "department":
        return bool(ctx["dept"]) and v.lower() == ctx["dept"]
    if row.kind == "group":
        return v in ctx["groups"]
    if row.kind == "person":
        return v.lower() == ctx["email"]
    return False


def audience_access(cred, rows, ctx: dict) -> str:
    """'' when the audiences do not admit this person; else the kind of the
    best matching row ('company' | 'department' | 'group' | 'person'), or
    'view' when every matching row is view-only."""
    if not rows:
        # Legacy rule (Oct 14 2026): the credential's own department, never Critical.
        if ctx["dept"] and (cred.dept or "").strip().lower() == ctx["dept"] and (cred.tier or "Standard") != "Critical":
            return "department"
        return ""
    if (cred.tier or "Standard") == "Critical":
        rows = [r for r in rows if r.kind == "person"]
    hit = [r for r in rows if _matches(r, ctx)]
    if not hit:
        return ""
    opens = [r for r in hit if (r.level or "open") != "view"]
    if not opens:
        return "view"
    # The most specific reason wins the label: person, group, department, company.
    rank = {"person": 0, "group": 1, "department": 2, "company": 3}
    return sorted(opens, key=lambda r: rank.get(r.kind, 9))[0].kind


def heads_map(db, creds) -> dict:
    """{cred_id: {emails}} - the head and backup head of each credential's
    department, in the owner's company (a department named the same in another
    company is someone else's). Built once for a list."""
    depts = db.query(models.HrDepartment).all()
    by_name: dict = {}
    for d in depts:
        if d.lead_email or d.backup_email:
            by_name.setdefault((d.name or "").strip().lower(), []).append(d)
    if not by_name:
        return {c.id: set() for c in creds}
    emp_company = {(e.work_email or "").lower(): (e.company or "")
                   for e in db.query(models.NexusEmployee.work_email, models.NexusEmployee.company).all()}
    out = {}
    for c in creds:
        found = by_name.get((c.dept or "").strip().lower(), [])
        owner_co = emp_company.get((c.owner_email or "").lower(), "")
        same = [d for d in found if owner_co and d.company_id == owner_co] or ([] if owner_co and found and all(d.company_id for d in found) else found)
        out[c.id] = {x for d in same for x in ((d.lead_email or "").lower(), (d.backup_email or "").lower()) if x}
    return out


def heads_for(db, cred) -> set:
    return heads_map(db, [cred]).get(cred.id, set())


def clean(rows_in) -> list:
    """Validate audience rows from a client: known kinds and levels, no blanks
    (a company row may be blank = every company), no duplicates."""
    out, seen = [], set()
    for r in rows_in or []:
        kind = (r.get("kind") or "").strip()
        value = (r.get("value") or "").strip()
        level = (r.get("level") or "open").strip()
        if kind not in KINDS or level not in LEVELS:
            continue
        if not value and kind != "company":
            continue
        if kind == "person":
            value = value.lower()
        key = (kind, value.lower())
        if key in seen:
            continue
        seen.add(key)
        out.append({"kind": kind, "value": value, "level": level})
    return out


def replace(db, cred_id: str, rows_in, actor: str) -> list:
    """Make the credential's audiences exactly `rows_in` (already cleaned)."""
    db.query(models.VaultCredentialAudience).filter(models.VaultCredentialAudience.cred_id == cred_id).delete()
    now = _now()
    for r in rows_in:
        db.add(models.VaultCredentialAudience(id=str(uuid.uuid4()), cred_id=cred_id, kind=r["kind"], value=r["value"],
                                              level=r["level"], created_at=now, created_by=actor))
    return rows_in


def labels(db, rows) -> list:
    """Rows as the screen shows them: [{kind, value, level, label}]."""
    companies = {c.id: c.name for c in db.query(models.HrEntity.id, models.HrEntity.name).all()}
    groups = {g.id: g.name for g in db.query(models.NexusGroup.id, models.NexusGroup.name).all()}
    out = []
    for r in rows:
        if r.kind == "company":
            label = f"Everyone at {companies.get(r.value, '')}" if r.value else "Everyone, every company"
        elif r.kind == "department":
            label = f"Everyone in {r.value}"
        elif r.kind == "group":
            label = groups.get(r.value, "Access Group")
        else:
            label = r.value
        out.append({"kind": r.kind, "value": r.value, "level": r.level or "open", "label": label})
    return out


def openers(db, cred, rows) -> set:
    """Every email that can open the credential right now (for a change
    notice): owners, heads, live grants, and the audience - or, with no
    audience rows, its own department."""
    emails = {(cred.owner_email or "").lower(), (cred.backup_owner_email or "").lower()} | heads_for(db, cred)
    now = _now()
    emails |= {g.granted_to for g in db.query(models.VaultAccessGrant.granted_to)
               .filter(models.VaultAccessGrant.cred_id == cred.id, models.VaultAccessGrant.expires_at > now).all()}
    owner_co = company_of(cred.owner_email or "", db)
    people = [e for e in db.query(models.NexusEmployee).all() if _active(e)]
    opening = [r for r in rows if (r.level or "open") != "view"]
    if not rows and (cred.tier or "Standard") != "Critical" and cred.dept:
        emails |= {e.work_email.lower() for e in people
                   if (e.department or "").strip().lower() == cred.dept.strip().lower() and (not owner_co or (e.company or "") == owner_co)}
    for r in opening:
        v = (r.value or "").strip()
        if r.kind == "company":
            emails |= {e.work_email.lower() for e in people if not v or (e.company or "") == v}
        elif r.kind == "department":
            emails |= {e.work_email.lower() for e in people
                       if (e.department or "").strip().lower() == v.lower() and (not owner_co or (e.company or "") == owner_co)}
        elif r.kind == "group":
            emails |= {m for (m,) in db.query(models.NexusGroupMember.email).filter(models.NexusGroupMember.group_id == v).all()}
        elif r.kind == "person":
            emails.add(v.lower())
    emails.discard("")
    return emails


def options(db, scope) -> dict:
    """What the form offers: companies and departments inside the caller's
    company scope, every Access Group that is not a job role's hiring shell."""
    from auth import company_ok
    companies = [{"id": c.id, "name": c.name} for c in db.query(models.HrEntity).order_by(models.HrEntity.name).all()
                 if company_ok(c.id, scope)]
    depts = [{"name": d.name, "companyId": d.company_id, "head": d.lead_email or "", "backup": d.backup_email or ""}
             for d in db.query(models.HrDepartment).order_by(models.HrDepartment.sort_order, models.HrDepartment.name).all()
             if company_ok(d.company_id, scope)]
    groups = [{"id": g.id, "name": g.name} for g in db.query(models.NexusGroup).order_by(models.NexusGroup.name).all()
              if not (g.company_id or "") or company_ok(g.company_id, scope)]
    return {"companies": companies, "departments": depts, "groups": groups}
