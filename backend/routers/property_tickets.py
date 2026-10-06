"""Property Tickets - Asset Management's view of the tickets at a property
(Neil, 10/05/2026): "when you click on the asset, it should show all the open
tickets... and all the closed tickets should become part of maintenance
history". Plus the property picker the ticket forms use.

READ-ONLY against Asset Management: nothing here touches the workspace blob
(see property_links.py for why). Three tiers:
  * asset viewers: a summary per ticket - no requester, no conversation, no
    attachments, no Follow (a read-only grant must not self-upgrade);
  * asset editors, administrators, the property's own asset manager: the
    summary with the requester, plus Follow. Follow makes them a watcher -
    a DELIBERATE widening of who can open the ticket, bounded to building
    tickets (property_links rule 4) at properties they can see, explicit,
    logged on the ticket, row-locked;
  * desk / participants: open the ticket itself, unchanged.
A lead property's roll-up includes only the parcels the caller could open
themselves (property_links.group_ids).
"""
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

import models
import property_links
from auth import get_current_user
from database import get_db
from routers import tickets as T
from routers.property_assets import require_asset_read
from routers.task_util import log_activity
from ticket_code import ticket_no

router = APIRouter(tags=["Asset Management"], dependencies=[Depends(get_current_user)])

_PRIORITY_RANK = {"urgent": 0, "high": 1, "medium": 2, "low": 3}


@router.get("/ticket-properties")
def list_ticket_properties(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Properties a ticket may be linked to - for every ticket form, so open to
    anyone signed in (like /ticket-sites). Names, parcel parent, city/state and
    tenant-unit labels only: no financials, no contacts."""
    rows = db.query(models.PropertyAsset).all()
    by_id = {p.id: p for p in rows}
    out = []
    for p in rows:
        if not property_links.is_listed(p, user):
            continue
        parent = by_id.get(p.parent_id) if p.parent_id else None
        parent = parent if parent is not None and property_links.is_listed(parent, user) else None
        pl = p.payload or {}
        units = [u.get("label") for u in (pl.get("tenantUnits") or [])
                 if isinstance(u, dict) and u.get("label")]
        out.append({"id": p.id, "name": property_links.display_name(p),
                    "parentId": parent.id if parent else None,
                    "parentName": property_links.display_name(parent) if parent else None,
                    "city": str(pl.get("city") or ""), "state": str(pl.get("state") or ""), "units": units})
    # Lead properties alphabetically, each followed by its parcels.
    out.sort(key=lambda x: ((x["parentName"] or x["name"]).lower(), x["parentId"] is not None, x["name"].lower()))
    return {"properties": out, "canWalkthrough": property_links.may_walkthrough(db, user)}


def _names(db: Session, emails: set) -> dict:
    emails = {e.lower() for e in emails if e}
    if not emails:
        return {}
    rows = (db.query(models.NexusEmployee)
            .filter(func.lower(models.NexusEmployee.work_email).in_(emails)).all())
    out = {}
    for e in rows:
        name = f"{e.first_name or ''} {e.last_name or ''}".strip()
        out[(e.work_email or "").lower()] = name or e.work_email
    return out


def _summary(t, prop_names: dict, lead_id: str, photos: dict, names: dict, desk: bool, me: str,
             full: bool) -> dict:
    status = t.status if (t.status and t.status != "new") else "open"
    watchers = {(w or "").lower() for w in (t.watcher_emails or [])}
    pid = t.property_asset_id or ""
    return {
        "id": t.id, "code": t.code or "", "codeLabel": ticket_no(t.code), "subject": t.subject,
        "status": status, "priority": t.priority or "medium", "type": t.type or "",
        "category": t.application or "", "system": property_links.system_for(t.application),
        "location": str((t.type_fields or {}).get("svc_unit") or ""),
        "propertyId": pid, "propertyName": prop_names.get(pid) or t.property_name or "",
        "onParcel": pid != lead_id,
        "assigneeName": names.get((t.assignee_email or "").lower(), t.assignee_email or ""),
        # Who raised it is for the people who may act on it, not every viewer.
        "requesterName": (names.get((t.requester_email or "").lower(), t.requester_email or "")
                          if full else ""),
        "approvalStatus": t.approval_status or "none",
        "createdAt": t.created_at or "", "resolvedAt": t.resolved_at or "",
        "resolution": t.resolution or "", "resolutionNote": t.resolution_note or "",
        "vendor": t.maintenance_vendor or "", "cost": t.maintenance_cost or "",
        "photoCount": photos.get(t.id, 0), "batchId": t.batch_id or "",
        "maintenanceRecord": property_links.is_maintenance_record(t),
        "canOpen": desk or me in T._ticket_participants(t),
        "watching": me in watchers,
    }


@router.get("/property-assets/{property_id}/tickets")
def property_tickets(property_id: str, user: dict = Depends(require_asset_read), db: Session = Depends(get_db)):
    prop = db.get(models.PropertyAsset, property_id)
    if not property_links.viewable(prop, user):
        raise HTTPException(404, "Property not found")
    ids = property_links.group_ids(db, prop, user)        # private / deleted parcels left out
    rows = db.query(models.TaskTicket).filter(models.TaskTicket.property_asset_id.in_(ids)).all()
    import auth   # company wall - same confinement as the desk queue (list_tickets)
    scope = auth.company_scope(user, db)
    if scope is not None:
        rows = [t for t in rows if (t.company_id or "") in scope]
    props = db.query(models.PropertyAsset).filter(models.PropertyAsset.id.in_(ids)).all()
    prop_names = {p.id: property_links.display_name(p) for p in props}
    photos = dict(db.query(models.TaskAttachment.task_id, func.count(models.TaskAttachment.id))
                  .filter(models.TaskAttachment.task_id.in_([t.id for t in rows] or [""]),
                          models.TaskAttachment.kind == "image")
                  .group_by(models.TaskAttachment.task_id).all())
    names = _names(db, {t.assignee_email for t in rows} | {t.requester_email for t in rows})
    desk = T._has_desk_grant(user, db)
    me = (user.get("email") or "").lower()
    can_follow = property_links.may_follow(db, user, prop)
    summaries = [_summary(t, prop_names, prop.id, photos, names, desk, me, full=desk or can_follow)
                 for t in rows]
    open_ = sorted([s for s in summaries if s["status"] not in property_links.CLOSED_STATES],
                   key=lambda s: (_PRIORITY_RANK.get(s["priority"], 9), s["createdAt"]))
    history = sorted([s for s in summaries if s["status"] in property_links.CLOSED_STATES],
                     key=lambda s: s["resolvedAt"] or s["createdAt"], reverse=True)
    spend = sum((property_links.cost_value(s["cost"]) for s in history if s["maintenanceRecord"]), Decimal("0"))
    return {"property": {"id": prop.id, "name": property_links.display_name(prop),
                         "parcels": [{"id": p.id, "name": prop_names[p.id]} for p in props if p.id != prop.id]},
            "open": open_, "history": history, "spend": str(spend.quantize(Decimal("0.01"))),
            "canWalkthrough": property_links.may_walkthrough(db, user), "canFollow": can_follow}


@router.post("/property-assets/{property_id}/tickets/{ticket_id}/follow")
def follow_property_ticket(property_id: str, ticket_id: str, user: dict = Depends(require_asset_read),
                           db: Session = Depends(get_db)):
    """Become a watcher - the participant path that already lets a person open,
    comment on and hear about a ticket. That widens who can read the ticket,
    so only asset editors, administrators and the property's own asset
    manager may (property_links.may_follow); a viewer gets 403. Row-locked:
    watcher_emails is a JSON read-modify-write, and two follows at once would
    otherwise drop one."""
    prop = db.get(models.PropertyAsset, property_id)
    if not property_links.viewable(prop, user):
        raise HTTPException(404, "Property not found")
    if not property_links.may_follow(db, user, prop):
        raise HTTPException(403, "Following a ticket is for Asset Management editors and the "
                                 "property's asset manager. Ask one of them, or the service desk.")
    t = (db.query(models.TaskTicket).filter(models.TaskTicket.id == ticket_id)
         .with_for_update().first())
    if t is None or (t.property_asset_id or "") not in property_links.group_ids(db, prop, user):
        raise HTTPException(404, "That ticket is not at this property.")
    import auth
    auth.assert_company(t.company_id or "", user, db)
    me = (user.get("email") or "").strip().lower()
    if me not in {(w or "").lower() for w in (t.watcher_emails or [])}:
        t.watcher_emails = [*(t.watcher_emails or []), me]
        log_activity(db, type="watcher_added", actor_email=me, entity_kind="ticket", entity_id=t.id,
                     entity_code=t.code, entity_title=t.subject,
                     detail=f"{me} followed this ticket from Asset Management")
        db.commit()
    return {"watching": True}
