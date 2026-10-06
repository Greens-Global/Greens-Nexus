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
import re
from datetime import date, datetime, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

import maintenance_services
import models
import property_links
from auth import get_current_user
from database import get_db
from routers import tickets as T
from routers.property_assets import require_asset_read
from routers import ticket_walkthroughs as W
from routers.task_util import gen_id, log_activity, now_iso
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
             full: bool, logged: set, service_parents: set) -> dict:
    status = t.status if (t.status and t.status != "new") else "open"
    watchers = {(w or "").lower() for w in (t.watcher_emails or [])}
    pid = t.property_asset_id or ""
    worked = property_links.is_maintenance_record(t)
    return {
        "id": t.id, "code": t.code or "", "codeLabel": ticket_no(t.code), "subject": t.subject,
        "status": status, "priority": t.priority or "medium", "type": t.type or "",
        "category": t.application or "", "system": property_links.system_for(t.application),
        "location": str((t.type_fields or {}).get("svc_unit") or ""),
        "propertyId": pid, "propertyName": prop_names.get(pid) or t.property_name or "",
        "onParcel": pid != lead_id,
        "assigneeName": names.get((t.assignee_email or "").lower(), t.assignee_email or ""),
        "assigneeEmail": (t.assignee_email or "").lower(),
        "modifiedAt": t.modified_at or "",
        # Who raised it is for the people who may act on it, not every viewer.
        "requesterName": (names.get((t.requester_email or "").lower(), t.requester_email or "")
                          if full else ""),
        "approvalStatus": t.approval_status or "none",
        "createdAt": t.created_at or "", "resolvedAt": t.resolved_at or "",
        "resolution": t.resolution or "", "resolutionNote": t.resolution_note or "",
        "vendor": t.maintenance_vendor or "", "cost": t.maintenance_cost or "",
        "photoCount": photos.get(t.id, 0), "batchId": t.batch_id or "",
        # Worked (not Duplicate / Won't Fix / rejected) - eligible for the record.
        "maintenanceRecord": worked,
        "logged": t.id in logged,
        # Resolved/closed after real work and not yet in the maintenance record:
        # the asset manager's Needs Action list (Pranshu, 10/06).
        "needsAction": status in property_links.CLOSED_STATES and worked and t.id not in logged,
        "parentTicketId": t.parent_ticket_id or "",
        "isServiceParent": t.id in service_parents,
        "canOpen": desk or me in T._ticket_participants(t),
        "watching": me in watchers,
    }


def _latest_public(db: Session, ids: list) -> dict:
    """The newest PUBLIC reply on each of these tickets - the Support table's
    Latest Comment column. Internal notes never leave the desk, and Asset
    Management viewers are not the desk."""
    if not ids:
        return {}
    C = models.TaskComment
    public = (C.internal.is_(False)) | (C.internal.is_(None))
    newest = (db.query(C.task_id.label("tid"), func.max(C.created_at).label("mx"))
              .filter(C.task_id.in_(ids), public).group_by(C.task_id).subquery())
    out: dict = {}
    for tid, author, body, created in (db.query(C.task_id, C.author_email, C.body, C.created_at)
                                       .join(newest, (C.task_id == newest.c.tid) & (C.created_at == newest.c.mx))
                                       .filter(public).all()):
        out.setdefault(tid, {"authorId": (author or "").lower(), "preview": T._comment_preview(body or "", 160),
                             "createdAt": created or "", "internal": False})
    return out


def _record_out(r, by_id: dict) -> dict:
    t = by_id.get(r.ticket_id)
    parent = by_id.get(r.parent_ticket_id) if r.parent_ticket_id and r.parent_ticket_id != r.ticket_id else None
    return {"id": r.id, "ticketId": r.ticket_id, "codeLabel": ticket_no(t.code) if t else "",
            "subject": t.subject if t else "", "propertyId": r.property_asset_id,
            "date": r.service_date, "system": r.system, "description": r.description, "vendor": r.vendor,
            "cost": r.cost, "currency": r.currency or "USD", "docUrl": r.doc_url, "docName": r.doc_name, "notes": r.notes,
            "parentTicketId": r.parent_ticket_id or "", "parentCodeLabel": ticket_no(parent.code) if parent else ""}


def _service_out(svc, by_id: dict, records: dict) -> dict:
    """A recurring service: its parent ticket and every child under it, each
    with its date and cost (the logged record's, else what the ticket has)."""
    parent = by_id.get(svc.parent_ticket_id)
    family = [parent] if parent else []
    family += sorted([t for t in by_id.values() if t.parent_ticket_id == svc.parent_ticket_id],
                     key=lambda t: t.created_at or "")

    def row(t):
        rec = records.get(t.id)
        status = t.status if (t.status and t.status != "new") else "open"
        return {"id": t.id, "codeLabel": ticket_no(t.code), "subject": t.subject, "status": status,
                "isParent": t.id == svc.parent_ticket_id,
                "date": (rec.service_date if rec else "") or (t.resolved_at or t.created_at or "")[:10],
                "cost": (rec.cost if rec else "") or (t.maintenance_cost or ""),
                "currency": (rec.currency if rec else "") or "USD",
                "vendor": (rec.vendor if rec else "") or (t.maintenance_vendor or ""),
                "logged": rec is not None}
    rows = [row(t) for t in family]
    totals = _totals((r["cost"], r["currency"]) for r in rows)
    usd = next((x["amount"] for x in totals if x["currency"] == "USD"), "0.00")
    return {"id": svc.id, "parentTicketId": svc.parent_ticket_id,
            "parentCodeLabel": ticket_no(parent.code) if parent else "",
            "subject": (svc.template or {}).get("subject") or (parent.subject if parent else ""),
            "system": property_links.system_for((svc.template or {}).get("application")),
            "nextDue": svc.next_due, "recurrenceUnit": svc.recurrence_unit or "",
            "recurrenceEvery": svc.recurrence_every or 1,
            "recurrenceLabel": maintenance_services.recurrence_label(svc.recurrence_unit or "", svc.recurrence_every or 1),
            "active": bool(svc.active), "tickets": rows, "totals": totals, "totalCost": usd}


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
    by_id = {t.id: t for t in rows}
    props = db.query(models.PropertyAsset).filter(models.PropertyAsset.id.in_(ids)).all()
    prop_names = {p.id: property_links.display_name(p) for p in props}
    photos = dict(db.query(models.TaskAttachment.task_id, func.count(models.TaskAttachment.id))
                  .filter(models.TaskAttachment.task_id.in_([t.id for t in rows] or [""]),
                          models.TaskAttachment.kind == "image")
                  .group_by(models.TaskAttachment.task_id).all())
    recs = (db.query(models.TicketMaintenanceRecord)
            .filter(models.TicketMaintenanceRecord.ticket_id.in_(list(by_id) or [""])).all())
    records = {r.ticket_id: r for r in recs}
    services = (db.query(models.PropertyMaintenanceService)
                .filter(models.PropertyMaintenanceService.parent_ticket_id.in_(list(by_id) or [""])).all())
    names = _names(db, {t.assignee_email for t in rows} | {t.requester_email for t in rows})
    desk = T._has_desk_grant(user, db)
    me = (user.get("email") or "").lower()
    can_manage = property_links.may_follow(db, user, prop)
    summaries = [_summary(t, prop_names, prop.id, photos, names, desk, me, full=desk or can_manage,
                          logged=set(records), service_parents={s.parent_ticket_id for s in services})
                 for t in rows]
    latest = _latest_public(db, list(by_id))
    names.update(_names(db, {c["authorId"] for c in latest.values()} - set(names)))
    for s in summaries:
        par = by_id.get(s["parentTicketId"]) if s["parentTicketId"] else None
        s["parentCodeLabel"] = ticket_no(par.code) if par else ""
        c = latest.get(s["id"])
        s["latestComment"] = {**c, "authorName": names.get(c["authorId"], c["authorId"])} if c else None
    open_ = sorted([s for s in summaries if s["status"] not in property_links.CLOSED_STATES],
                   key=lambda s: (_PRIORITY_RANK.get(s["priority"], 9), s["createdAt"]))
    history = sorted([s for s in summaries if s["status"] in property_links.CLOSED_STATES],
                     key=lambda s: s["resolvedAt"] or s["createdAt"], reverse=True)
    # Spend = what the asset manager put in the maintenance record, per currency.
    spend_totals = _totals((r.cost, r.currency) for r in recs)
    spend = next((x["amount"] for x in spend_totals if x["currency"] == "USD"), "0.00")
    return {"property": {"id": prop.id, "name": property_links.display_name(prop),
                         "parcels": [{"id": p.id, "name": prop_names[p.id]} for p in props if p.id != prop.id]},
            "open": open_, "history": history,
            "needsAction": [s for s in history if s["needsAction"]],
            "records": sorted([_record_out(r, by_id) for r in recs], key=lambda r: r["date"], reverse=True),
            "services": sorted([_service_out(s, by_id, records) for s in services],
                               key=lambda s: (not s["active"], s["nextDue"])),
            "spend": spend, "spendTotals": spend_totals,
            "canWalkthrough": property_links.may_walkthrough(db, user),
            "canFollow": can_manage, "canManage": can_manage}


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


# ── Maintenance record + recurring service (Pranshu, 10/06) ──────────────────
# Resolved property ticket -> the asset manager's Needs Action -> Add to
# Maintenance Record. Logging it closes the ticket (that IS the sign-off, so
# the form has no status). On the ORIGINAL ticket only, a Next Service Due and
# how often it repeats start a PropertyMaintenanceService
# (maintenance_services.py): reminder 15 days out, a ticket opened on the due
# date if nobody did, every child shown under the parent.

class MaintenanceRecordBody(BaseModel):
    # Service Date and System / Area are NOT taken from the client - they come
    # from the ticket itself (its resolve date, its category) (Pranshu, 10/06).
    # Accepted for older clients and ignored.
    service_date: Optional[str] = None
    system: Optional[str] = None
    description: Optional[str] = ""
    vendor: Optional[str] = ""
    cost: Optional[str] = ""
    currency: Optional[str] = "USD"
    notes: Optional[str] = ""
    doc_url: Optional[str] = ""
    doc_name: Optional[str] = ""
    next_service_due: Optional[str] = ""
    recurrence_unit: Optional[str] = ""      # "" one time | week | month | year
    recurrence_every: Optional[int] = 1


_CURRENCY = re.compile(r"^[A-Z]{3}$")


def _business_date(iso: str):
    """The calendar day a UTC timestamp falls on for the business (Pacific),
    so an evening resolve is not recorded as the next day."""
    try:
        dt = datetime.fromisoformat((iso or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(ZoneInfo("America/Los_Angeles")).date()


def _totals(pairs) -> list:
    """[(amount_str, currency)] -> [{currency, amount}] - one total per
    currency, never dollars and euros added together."""
    out: dict = {}
    for amount, cur in pairs:
        if amount:
            out[cur or "USD"] = out.get(cur or "USD", Decimal("0")) + property_links.cost_value(amount)
    return [{"currency": c, "amount": str(v.quantize(Decimal("0.01")))} for c, v in sorted(out.items())]


class ServicePatch(BaseModel):
    next_due: Optional[str] = None
    recurrence_unit: Optional[str] = None
    recurrence_every: Optional[int] = None
    active: Optional[bool] = None


def _require_manage(db: Session, user: dict, property_id: str):
    prop = db.get(models.PropertyAsset, property_id)
    if not property_links.viewable(prop, user):
        raise HTTPException(404, "Property not found")
    if not property_links.may_follow(db, user, prop):
        raise HTTPException(403, "The maintenance record is kept by the property's asset manager and "
                                 "Asset Management editors.")
    return prop


def _schedule_fields(next_due: str, unit: str, every) -> tuple:
    d = maintenance_services.parse_ymd(next_due)
    if d is None:
        raise HTTPException(400, "Next Service Due must be a date.")
    if d <= date.today():
        raise HTTPException(400, "Next Service Due must be in the future.")
    unit = (unit or "").strip().lower()
    if unit not in maintenance_services.UNITS:
        raise HTTPException(400, "Repeats must be one time, or every so many weeks, months or years.")
    every = int(every or 1)
    if unit and not 1 <= every <= 52:
        raise HTTPException(400, "Repeat every 1 to 52.")
    return d.isoformat(), unit, (every if unit else 1)


@router.post("/property-assets/{property_id}/tickets/{ticket_id}/maintenance-record", status_code=201)
def add_maintenance_record(property_id: str, ticket_id: str, body: MaintenanceRecordBody,
                           user: dict = Depends(require_asset_read), db: Session = Depends(get_db)):
    prop = _require_manage(db, user, property_id)
    t = (db.query(models.TaskTicket).filter(models.TaskTicket.id == ticket_id).with_for_update().first())
    if t is None or (t.property_asset_id or "") not in property_links.group_ids(db, prop, user):
        raise HTTPException(404, "That ticket is not at this property.")
    import auth
    auth.assert_company(t.company_id or "", user, db)
    if (t.status or "") not in property_links.CLOSED_STATES:
        raise HTTPException(409, "Only a resolved ticket can be added to the maintenance record.")
    if not property_links.is_maintenance_record(t):
        raise HTTPException(409, "This ticket was closed without work - there is nothing to record.")
    if db.query(models.TicketMaintenanceRecord).filter(models.TicketMaintenanceRecord.ticket_id == t.id).first():
        raise HTTPException(409, "This ticket is already in the maintenance record.")
    sdate = _business_date(t.resolved_at) or date.today()
    system = property_links.system_for(t.application)
    currency = (body.currency or "USD").strip().upper()
    if not _CURRENCY.match(currency):
        raise HTTPException(400, "Pick the cost's currency.")
    doc_url = (body.doc_url or "").strip()
    if doc_url and not W._photo_ok(doc_url):
        raise HTTPException(400, "The invoice did not upload - attach it again.")
    schedule = None
    if (body.next_service_due or "").strip():
        if t.parent_ticket_id:
            raise HTTPException(400, "This ticket was opened by a recurring service - its schedule is set "
                                     "on the original ticket.")
        if db.query(models.PropertyMaintenanceService).filter(
                models.PropertyMaintenanceService.parent_ticket_id == t.id).first():
            raise HTTPException(409, "This ticket already has a service schedule.")
        schedule = _schedule_fields(body.next_service_due, body.recurrence_unit, body.recurrence_every)
    me = (user.get("email") or "").strip().lower()
    now = now_iso()
    cost = property_links.normalize_cost(body.cost)
    vendor = " ".join((body.vendor or "").split())[:200]
    rec = models.TicketMaintenanceRecord(
        id=gen_id(), ticket_id=t.id, property_asset_id=t.property_asset_id,
        parent_ticket_id=t.parent_ticket_id or (t.id if schedule else ""),
        service_date=sdate.isoformat(), system=system, description=(body.description or "").strip()[:2000],
        vendor=vendor, cost=cost, currency=currency, doc_url=doc_url, doc_name=(body.doc_name or "").strip()[:200],
        notes=(body.notes or "").strip()[:2000], created_by_email=me, created_at=now, updated_at=now)
    db.add(rec)
    # The ticket carries what was paid, and logging it is the sign-off: closed.
    t.maintenance_vendor, t.maintenance_cost = vendor, cost
    if t.status != "closed":
        t.status = "closed"
    t.modified_at = now
    if doc_url:
        db.add(models.TaskAttachment(id=gen_id(), task_id=t.id, name=rec.doc_name or "Invoice", size="",
                                     kind="doc", url=doc_url, added_at=now, added_by=me))
    log_activity(db, type="maintenance_recorded", actor_email=me, entity_kind="ticket", entity_id=t.id,
                 entity_code=t.code, entity_title=t.subject,
                 detail=f"added this ticket to {t.property_name}'s maintenance record and closed it")
    svc = None
    if schedule:
        next_due, unit, every = schedule
        svc = models.PropertyMaintenanceService(
            id=gen_id(), property_asset_id=t.property_asset_id, parent_ticket_id=t.id,
            template=maintenance_services.template_from(t), next_due=next_due, recurrence_unit=unit,
            recurrence_every=every, active=1, created_by_email=me, created_at=now,
            updated_by_email=me, updated_at=now)
        db.add(svc)
        log_activity(db, type="service_scheduled", actor_email=me, entity_kind="ticket", entity_id=t.id,
                     entity_code=t.code, entity_title=t.subject,
                     detail=f"set the next service for {maintenance_services.us_date(next_due)} "
                            f"({maintenance_services.recurrence_label(unit, every)})")
    db.commit()
    return {"recordId": rec.id, "serviceId": svc.id if svc else None}


def _service_or_404(db: Session, prop, user: dict, service_id: str):
    svc = (db.query(models.PropertyMaintenanceService)
           .filter(models.PropertyMaintenanceService.id == service_id).with_for_update().first())
    if svc is None or svc.property_asset_id not in property_links.group_ids(db, prop, user):
        raise HTTPException(404, "That service is not at this property.")
    return svc


@router.patch("/property-assets/{property_id}/services/{service_id}")
def update_service(property_id: str, service_id: str, body: ServicePatch,
                   user: dict = Depends(require_asset_read), db: Session = Depends(get_db)):
    """Change the next due date or how often it repeats, or stop / restart it."""
    prop = _require_manage(db, user, property_id)
    svc = _service_or_404(db, prop, user, service_id)
    data = body.model_dump(exclude_unset=True)
    if {"next_due", "recurrence_unit", "recurrence_every"} & set(data):
        next_due, unit, every = _schedule_fields(
            data.get("next_due", svc.next_due), data.get("recurrence_unit", svc.recurrence_unit),
            data.get("recurrence_every", svc.recurrence_every))
        if next_due != svc.next_due:
            svc.reminder_sent_for = ""
        svc.next_due, svc.recurrence_unit, svc.recurrence_every = next_due, unit, every
    if "active" in data:
        if data["active"] and not svc.active and maintenance_services.parse_ymd(svc.next_due) <= date.today():
            raise HTTPException(400, "Set a future Next Service Due to restart this service.")
        svc.active = 1 if data["active"] else 0
    me = (user.get("email") or "").strip().lower()
    svc.updated_by_email, svc.updated_at = me, now_iso()
    parent = db.get(models.TaskTicket, svc.parent_ticket_id)
    if parent is not None:
        log_activity(db, type="service_changed", actor_email=me, entity_kind="ticket", entity_id=parent.id,
                     entity_code=parent.code, entity_title=parent.subject,
                     detail=("stopped the recurring service" if not svc.active else
                             f"set the next service for {maintenance_services.us_date(svc.next_due)} "
                             f"({maintenance_services.recurrence_label(svc.recurrence_unit, svc.recurrence_every)})"))
    db.commit()
    return {"ok": True}


@router.post("/property-assets/{property_id}/services/{service_id}/open-now", status_code=201)
def open_service_now(property_id: str, service_id: str,
                     user: dict = Depends(require_asset_read), db: Session = Depends(get_db)):
    """Open the upcoming service's ticket now instead of waiting for the due
    date - the schedule then moves on exactly as if it had opened itself."""
    prop = _require_manage(db, user, property_id)
    svc = _service_or_404(db, prop, user, service_id)
    if not svc.active:
        raise HTTPException(409, "This service is stopped - restart it first.")
    if svc.last_opened_for == svc.next_due:
        raise HTTPException(409, "The ticket for this service date is already open.")
    last = db.get(models.TaskTicket, svc.last_ticket_id) if svc.last_ticket_id else None
    if last is not None and (last.status or "") not in property_links.CLOSED_STATES:
        # Early opening is for the coming service, not a way to queue up every
        # future one - the next opens once this one is done (or on its date).
        raise HTTPException(409, f"{ticket_no(last.code)} for this service is still open - finish it first.")
    t = maintenance_services.open_child(db, svc, (user.get("email") or "").strip().lower(), automatic=False)
    db.commit()
    return {"ticketId": t.id, "code": t.code, "nextDue": svc.next_due if svc.active else None}
