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

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

import auth
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
        "unit": t.property_unit or "",      # the ticket's Unit field (Ops review, Oct 20)
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
        # What was said and spent on it is the conversation's / the desk's
        # record - a read-only asset viewer gets the summary only.
        "resolution": t.resolution or "", "resolutionNote": (t.resolution_note or "") if full else "",
        "vendor": (t.maintenance_vendor or "") if full else "", "cost": (t.maintenance_cost or "") if full else "",
        "photoCount": photos.get(t.id, 0), "batchId": t.batch_id or "",
        # Worked (not Duplicate / Won't Fix / rejected) - eligible for the record.
        "maintenanceRecord": worked,
        "logged": t.id in logged,
        # Resolved/closed after real work and not yet in the maintenance record:
        # the asset manager's Needs Action list (Pranshu, 10/06).
        "needsAction": status in property_links.CLOSED_STATES and worked and t.id not in logged,
        "parentTicketId": t.parent_ticket_id or "",
        "isServiceParent": t.id in service_parents,
        # Preventive maintenance (11/03/2026): the schedule, its due day, the
        # equipment it is about.
        "serviceId": t.service_id or "", "pmDueOn": t.pm_due_on or "",
        "equipmentAssetId": t.equipment_asset_id or "",
        "canOpen": desk or me in T._ticket_readers(t),
        "watching": me in watchers,
    }


def _latest_public(db: Session, ids: list) -> dict:
    """The newest PUBLIC reply on each of these tickets - the Support table's
    Latest Comment column. Internal notes never leave the desk, and Asset
    Management viewers are not the desk."""
    import ticket_notify
    ids = [i for i in ids if i not in ticket_notify.clashing_ids(db, ids)]   # a task's thread is not theirs
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


def _service_out(svc, by_id: dict, records: dict, full: bool = True) -> dict:
    """A recurring service: its parent ticket and every child under it, each
    with its date and cost (the logged record's, else what the ticket has)."""
    preventive = maintenance_services.is_preventive(svc)
    parent = None if preventive else by_id.get(svc.parent_ticket_id)
    family = [parent] if parent else []
    if preventive:
        family += sorted([t for t in by_id.values() if t.service_id == svc.id], key=lambda t: t.created_at or "")
    else:
        family += sorted([t for t in by_id.values() if t.parent_ticket_id == svc.parent_ticket_id],
                         key=lambda t: t.created_at or "")

    def row(t):
        rec = records.get(t.id)
        status = t.status if (t.status and t.status != "new") else "open"
        return {"id": t.id, "codeLabel": ticket_no(t.code), "subject": t.subject, "status": status,
                "isParent": (not preventive) and t.id == svc.parent_ticket_id,
                "pmDueOn": t.pm_due_on or "",
                "date": (rec.service_date if rec else "") or (t.resolved_at or t.created_at or "")[:10],
                # The logged record is the property's history; a ticket's own
                # vendor / cost (not yet logged) is the desk's, like _summary.
                "cost": (rec.cost if rec else "") or ((t.maintenance_cost or "") if full else ""),
                "currency": (rec.currency if rec else "") or "USD",
                "vendor": (rec.vendor if rec else "") or ((t.maintenance_vendor or "") if full else ""),
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
            "active": bool(svc.active), "tickets": rows, "totals": totals, "totalCost": usd,
            **_preventive_out(svc, family)}


def _preventive_out(svc, family: list) -> dict:
    """What the schedule editor and the Preventive list read (11/03/2026).
    A service set from a ticket answers kind '' and the editor offers it the
    old fields only."""
    tpl = svc.template or {}
    today = date.today().isoformat()
    live = [t for t in family if (t.status or "") not in property_links.CLOSED_STATES]
    return {"kind": svc.kind or "", "kindLabel": maintenance_services.KIND_LABEL.get(svc.kind or "", ""),
            "scheduleLabel": (maintenance_services.schedule_label(svc) if maintenance_services.is_preventive(svc)
                              else maintenance_services.recurrence_label(svc.recurrence_unit or "",
                                                                         svc.recurrence_every or 1)),
            "description": tpl.get("description") or "", "priority": tpl.get("priority") or "medium",
            "application": tpl.get("application") or "", "departmentId": tpl.get("hr_department_id") or "",
            "location": tpl.get("location") or "", "assigneeEmail": svc.assignee_email or "",
            "assetId": svc.asset_id or "", "itemId": svc.item_id or "", "checklist": list(svc.checklist or []),
            "leadDays": int(svc.lead_days or 0), "meterField": svc.meter_field or "",
            "meterEvery": svc.meter_every or 0, "meterNext": svc.meter_next or 0, "meterLast": svc.meter_last or 0,
            "meterNextLabel": maintenance_services.meter_label(svc.meter_field, svc.meter_next)
            if svc.meter_field else "",
            "meterLastLabel": maintenance_services.meter_label(svc.meter_field, svc.meter_last)
            if svc.meter_field else "",
            "openCount": len(live),
            "overdueCount": len([t for t in live if t.pm_due_on and t.pm_due_on < today]),
            "waitingOnCompletion": (svc.kind or "") == "floating" and not svc.next_due}


@router.get("/property-assets/{property_id}/tickets")
def property_tickets(property_id: str, user: dict = Depends(require_asset_read), db: Session = Depends(get_db)):
    prop = db.get(models.PropertyAsset, property_id)
    if not property_links.viewable(prop, user):
        raise HTTPException(404, "Property not found")
    ids = property_links.group_ids(db, prop, user)        # private / deleted parcels left out
    rows = db.query(models.TaskTicket).filter(models.TaskTicket.property_asset_id.in_(ids)).all()
    scope = auth.company_scope(user, db)   # company wall - same confinement as the desk queue (list_tickets)
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
    # Preventive schedules (11/03/2026) sit on the property itself.
    M = models.PropertyMaintenanceService
    services += [s for s in db.query(M).filter(M.property_asset_id.in_(ids),
                                               M.kind.in_(maintenance_services.KINDS)).all()
                 if auth.company_ok((s.template or {}).get("company_id") or "", scope)]
    names = _names(db, {t.assignee_email for t in rows} | {t.requester_email for t in rows})
    desk = T._has_desk_grant(user, db)
    me = (user.get("email") or "").lower()
    can_manage = property_links.may_follow(db, user, prop)
    full = desk or can_manage
    summaries = [_summary(t, prop_names, prop.id, photos, names, desk, me, full=full,
                          logged=set(records), service_parents={s.parent_ticket_id for s in services})
                 for t in rows]
    # The latest reply is the conversation - never for a read-only viewer (see
    # the module docstring), so it is not even queried for one.
    latest = _latest_public(db, list(by_id)) if full else {}
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
            "services": sorted([_service_out(s, by_id, records, full) for s in services],
                               key=lambda s: (not s["active"], s["nextDue"])),
            "spend": spend, "spendTotals": spend_totals,
            # Preventive maintenance (11/03/2026): open and overdue at this
            # property (and its parcels), for the Maintenance tab's header.
            "preventive": {"open": len([x for x in open_ if x["serviceId"] and x["pmDueOn"]]),
                           "overdue": len([x for x in open_ if x["serviceId"] and x["pmDueOn"]
                                           and x["pmDueOn"] < date.today().isoformat()])},
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
    # Preventive schedules (11/03/2026) - maintenance_services.clean_schedule.
    kind: Optional[str] = None
    subject: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[str] = None
    application: Optional[str] = None
    hr_department_id: Optional[str] = None
    location: Optional[str] = None
    assignee_email: Optional[str] = None
    asset_id: Optional[str] = None
    item_id: Optional[str] = None
    checklist: Optional[list] = None
    lead_days: Optional[int] = None
    meter_every: Optional[float] = None
    meter_next: Optional[float] = None


_PREVENTIVE_KEYS = {"kind", "subject", "description", "priority", "application", "hr_department_id", "location",
                    "assignee_email", "asset_id", "item_id", "checklist", "lead_days", "meter_every", "meter_next",
                    "next_due", "recurrence_unit", "recurrence_every"}


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
        import ticket_sla
        ticket_sla.set_status(t, "closed")   # stops the SLA clock
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
    if maintenance_services.is_preventive(svc):
        return _update_preventive(db, user, prop, svc, data)
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
def open_service_now(property_id: str, service_id: str, background_tasks: BackgroundTasks = None,
                     user: dict = Depends(require_asset_read), db: Session = Depends(get_db)):
    """Open the upcoming service's ticket now instead of waiting for the due
    date - the schedule then moves on exactly as if it had opened itself."""
    prop = _require_manage(db, user, property_id)
    svc = _service_or_404(db, prop, user, service_id)
    if not svc.active:
        raise HTTPException(409, "This service is stopped - restart it first.")
    if maintenance_services.is_preventive(svc):
        return _open_preventive_now(db, user, svc, background_tasks)
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


# ── Preventive schedules (Construction plan phase 5, Neil 11/03/2026) ────────
# The recurring service above, set up straight on the property instead of
# from a resolved ticket: fixed dates, N after the last completion, or by the
# asset's meter (maintenance_services.py). Kept by the same people (the
# property's asset manager, Asset Management editors, administrators), with
# the same row lock and the same daily scan - never a second scheduler.

class ScheduleBody(BaseModel):
    kind: str = "calendar"
    subject: str = ""
    description: Optional[str] = ""
    priority: Optional[str] = "medium"
    application: Optional[str] = ""
    hr_department_id: str = ""
    location: Optional[str] = ""
    assignee_email: Optional[str] = ""
    asset_id: Optional[str] = ""
    item_id: Optional[str] = ""
    checklist: Optional[list] = None
    lead_days: Optional[int] = 0
    next_due: Optional[str] = ""
    recurrence_unit: Optional[str] = "month"
    recurrence_every: Optional[int] = 1
    meter_every: Optional[float] = None
    meter_next: Optional[float] = None


@router.post("/property-assets/{property_id}/schedules", status_code=201)
def create_schedule(property_id: str, body: ScheduleBody, user: dict = Depends(require_asset_read),
                    db: Session = Depends(get_db)):
    prop = _require_manage(db, user, property_id)
    if not property_links.is_listed(prop, user):
        raise HTTPException(400, "Preventive schedules sit on a property - pick the property the work is at.")
    data = body.model_dump()
    data["checklist"] = data.get("checklist") or []
    fields = maintenance_services.clean_schedule(db, user, prop, data)
    me = (user.get("email") or "").strip().lower()
    now = now_iso()
    svc = models.PropertyMaintenanceService(
        id=gen_id(), property_asset_id=prop.id, parent_ticket_id=None, active=1, reminder_sent_for="",
        last_opened_for="", last_ticket_id="", created_by_email=me, created_at=now, updated_by_email=me,
        updated_at=now, next_due="", recurrence_unit="", recurrence_every=1)
    for k, v in fields.items():
        setattr(svc, k, v)
    db.add(svc)
    db.commit()
    return {"serviceId": svc.id, "nextDue": svc.next_due or None,
            "scheduleLabel": maintenance_services.schedule_label(svc)}


def _update_preventive(db: Session, user: dict, prop, svc, data: dict) -> dict:
    me = (user.get("email") or "").strip().lower()
    if set(data) & _PREVENTIVE_KEYS:
        if data.get("kind") is None:
            data.pop("kind", None)
        fields = maintenance_services.clean_schedule(db, user, prop, data, svc)
        for k, v in fields.items():
            setattr(svc, k, v)
    if "active" in data:
        if data["active"] and not svc.active and svc.kind in ("calendar", "floating"):
            d = maintenance_services.parse_ymd(svc.next_due)
            if d is not None and d < date.today():
                raise HTTPException(400, "Set a due date that is not in the past to restart this schedule.")
        svc.active = 1 if data["active"] else 0
    # The schedule files as whoever last saved it (maintenance_services.run_as).
    svc.updated_by_email, svc.updated_at = me, now_iso()
    db.commit()
    return {"ok": True, "nextDue": svc.next_due or None, "scheduleLabel": maintenance_services.schedule_label(svc)}


def _open_preventive_now(db: Session, user: dict, svc, background_tasks) -> dict:
    """Open Now for a preventive schedule: the coming occurrence's ticket,
    filed as the caller (who keeps the schedule), exactly as the scan would.
    A meter schedule opens for its next reading; a floating one only once the
    last ticket is done."""
    if maintenance_services.open_ticket_of(db, svc) is not None and svc.kind != "calendar":
        raise HTTPException(409, "This schedule's ticket is still open - finish it first.")
    if svc.kind == "meter":
        due_on, key = date.today().isoformat(), f"m:{float(svc.meter_next or 0):g}"
    else:
        d = maintenance_services.parse_ymd(svc.next_due)
        if d is None:
            raise HTTPException(409, "The next ticket opens when the last one is done.")
        due_on = key = d.isoformat()
    bt = background_tasks if background_tasks is not None else BackgroundTasks()
    try:
        made = maintenance_services.file_preventive(db, svc, due_on, key, user, bt, automatic=False)
    except HTTPException:
        db.rollback()
        raise
    if made is None:
        raise HTTPException(409, "The ticket for this due date is already open.")
    if background_tasks is None:
        maintenance_services.run_after(bt)
    return {"ticketId": made["id"], "code": made.get("code") or "", "nextDue": svc.next_due or None}


@router.get("/property-assets/{property_id}/schedule-options")
def schedule_options(property_id: str, user: dict = Depends(require_asset_read), db: Session = Depends(get_db)):
    """What the schedule editor offers: the teams that may sit on a property
    (inside the caller's company wall), the topics about a place, the
    vehicles and equipment with their readings, and whether the caller may
    name an assignee (the service desk only, as at ticket intake)."""
    import ticket_property_link
    import ticket_roles
    import ticket_taxonomy
    prop = _require_manage(db, user, property_id)
    scope = auth.company_scope(user, db)
    ents = {e.id: e.name for e in db.query(models.HrEntity).all()}
    depts = [{"id": d.id, "name": d.name or "", "companyId": d.company_id or "",
              "companyName": ents.get(d.company_id or "", "")}
             for d in db.query(models.HrDepartment).all()
             if auth.company_ok(d.company_id or "", scope) and property_links.department_takes_property(db, d.id)]
    topics, seen = [], set()
    for g in ticket_taxonomy.get_config(db).get("helpTopics") or []:
        for tp in g.get("topics") or []:
            name = str((tp or {}).get("name") or "").strip()
            if (tp or {}).get("area") in property_links.PROPERTY_AREAS and name and name.lower() not in seen:
                seen.add(name.lower())
                topics.append({"name": name, "area": tp.get("area")})
    equipment = []
    for a in db.query(models.PropertyAsset).all():
        kind = property_links.asset_kind(a)
        if kind not in ("vehicle", "equipment") or not property_links.viewable(a, user) or (a.payload or {}).get("deleted"):
            continue
        field = "odometer" if kind == "vehicle" else "hours"
        reading = maintenance_services.asset_reading(db, a, field)
        equipment.append({"id": a.id, "name": property_links.display_name(a), "kind": kind, "meterField": field,
                          "reading": reading,
                          "readingLabel": maintenance_services.meter_label(field, reading) if reading is not None else ""})
    return {"property": {"id": prop.id, "name": property_links.display_name(prop)},
            "departments": sorted(depts, key=lambda d: (d["companyName"].lower(), d["name"].lower())),
            "topics": topics, "equipment": sorted(equipment, key=lambda e: e["name"].lower()),
            "units": ticket_property_link.unit_options(db, prop),
            "canAssign": ticket_roles.can_assign(user, db)}

