"""A ticket on a property files under the property's company (Neil,
11/03/2026: "Should a property ticket take the property's company?" - "Yes").

ONE rule, read by every door that files or re-points a ticket on a property:
`tickets.file_ticket` (the desk's New Ticket with a property picked, the
property's Tickets panel in Asset Management, Report a Problem / Scan to
Request, preventive maintenance whose team has no company), Batch Create
(`ticket_walkthroughs`) and `update_ticket` when the property changes.
Email-to-ticket names no property, so it never gets here.

The property's company is its Company field, else the STRONG inference only
(`property_links.property_company(strong=True)` - never the asset manager's
company): a property still under "Needs a Company" files exactly as before.
It is taken only when the ticket stays whole - otherwise nothing changes:

  * its team: a team with no company, or the property company's own, stays;
    another company's team is swapped for the property company's team of
    the SAME NAME (one the desk has not switched off for intake). With no
    such team the ticket keeps its company: a ticket is never stamped with
    another company than its team's (`tickets.company_for`'s promise; review
    H1 for preventive tickets);
  * its people: the filer (or editor), the requester and the assignee must
    each reach the property's company - inside the TICKETS wall
    (`ticket_roles.company_scope`, where an Administrator sees every company
    - hotfix 11/04/2026) AND the ordinary wall (`auth.company_scope`), which
    the property's own ticket list, the place sheet, My Work and the
    preventive roll-up still read (pinned by test_maintenance_pm). So nobody
    loses sight of a ticket they filed or are named on: an Administrator of
    one company filing at another company's property keeps their own;
  * its equipment: items linked at intake must fit the property's company
    (`ticket_items._company_fits`), or the link would be refused.

A server-trusted company (`file_ticket(trusted_company=)` - a preventive
schedule's team company) always wins; this rule only fills it when blank.
"""
from __future__ import annotations

from sqlalchemy import func

import auth
import models
import property_links
import ticket_roles


def company_of(db, prop) -> str:
    """The company a ticket on `prop` files under, '' = none (today's rule)."""
    return property_links.property_company(db, prop, strong=True) if prop is not None else ""


def _team_company(db, dept_id: str) -> str:
    d = db.get(models.HrDepartment, dept_id)
    if d is not None:
        return (d.company_id or "").strip()
    s = db.get(models.TicketDepartment, dept_id)   # a team deleted globally: the desk's last word on it
    return ((s.company_id if s is not None else "") or "").strip()


def team_in(db, dept_id: str, company: str, swap: bool = True):
    """The ticket's team inside `company`: `dept_id` itself when it has no
    company or is that company's, else (`swap`) that company's team of the
    same name that is offered at intake. None = no team fits."""
    did = (dept_id or "").strip()
    if not did:
        return ""
    have = _team_company(db, did)
    if not have or have == company:
        return did
    if not swap:
        return None
    d = db.get(models.HrDepartment, did)
    key = ((d.name if d is not None else "") or "").strip().lower()
    if not key:
        return None
    H = models.HrDepartment
    for cand in (db.query(H).filter(H.company_id == company, func.lower(func.trim(H.name)) == key)
                 .order_by(H.sort_order, H.id).all()):
        s = db.get(models.TicketDepartment, cand.id)
        if s is None or s.enabled is not False:
            return cand.id
    return None


def _sees(db, who: dict, company: str) -> bool:
    return (auth.company_ok(company, ticket_roles.company_scope(who, db))
            and auth.company_ok(company, auth.company_scope(who, db)))


def reachable(db, actor: dict, company: str, emails=()) -> bool:
    """May the actor and every one of `emails` still find a ticket of
    `company` - on the desk and on the property (see the module note)?"""
    if not _sees(db, actor, company):
        return False
    me = (actor.get("email") or "").strip().lower()
    for e in {(x or "").strip().lower() for x in emails} - {"", me}:
        if not _sees(db, {"email": e, "level": auth.level_for(e, db)}, company):
            return False
    return True


def _items_fit(db, item_ids, company: str) -> bool:
    from routers import ticket_items
    ids = [i for i in (item_ids or []) if isinstance(i, str) and i.strip()]
    if not ids:
        return True
    rows = db.query(models.Item.company_id).filter(models.Item.id.in_(ids)).all()
    return all(ticket_items._company_fits(db, r.company_id or "", company) for r in rows)


def resolve(db, actor: dict, prop, company_id: str, dept_id: str, *, people=(), item_ids=None,
            swap: bool = True) -> tuple:
    """(company_id, hr_department_id) for a ticket on `prop`: the property's
    company and its team when the rule above allows, else exactly what was
    passed in."""
    keep = (company_id or "", dept_id or "")
    owner = company_of(db, prop)
    if not owner:
        return keep
    team = team_in(db, dept_id, owner, swap=swap)
    if team is None:
        return keep
    if owner == (company_id or "").strip():
        return owner, team          # already the property's company: only the team follows it
    if not reachable(db, actor, owner, people):
        return keep
    if not _items_fit(db, item_ids, owner):
        return keep
    return owner, team


def on_repoint(db, actor: dict, t, new_prop, data: dict, may_set: bool) -> None:
    """update_ticket, the property changing from `t`'s to `new_prop`: the
    company follows ONLY when the ticket's company was the old property's
    company (one a person chose stays theirs), the editor may change the
    company and the team (`may_set`), and the same patch names no company.
    A team named in the same patch is the editor's pick - kept, never
    swapped. Writes the new company (and team) into `data`, so update_ticket
    applies and logs them like any other edit."""
    if new_prop is None or not may_set or "company_id" in data:
        return
    old = db.get(models.PropertyAsset, t.property_asset_id) if (t.property_asset_id or "") else None
    old_owner = company_of(db, old)
    if not old_owner or (t.company_id or "") != old_owner:
        return
    picked = "hr_department_id" in data
    dept = (data["hr_department_id"] if picked else t.hr_department_id) or ""
    assignee = data["assignee_email"] if "assignee_email" in data else t.assignee_email
    cid, team = resolve(db, actor, new_prop, t.company_id or "", dept,
                        people=(t.requester_email, assignee), swap=not picked)
    if cid != (t.company_id or ""):
        data["company_id"] = cid
        if team != dept:
            data["hr_department_id"] = team
