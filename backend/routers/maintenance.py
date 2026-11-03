"""Maintenance in the field (Construction plan phase 5, Neil 11/03/2026).

Tickets ARE the maintenance work orders - there is no second queue. This
router only reads and writes tickets through routers/tickets.py
(file_ticket, update_ticket) so every intake rule, permission, SLA, bell and
workflow event is the desk's own:

  * GET  /maintenance/rollup - open and overdue preventive tickets per
    property and per company (the Tickets desk's Preventive queue header,
    Asset Management, Insights). Company walls, and only properties the
    caller may see.
  * GET  /maintenance/place/{property}[?asset=] - what a scanned site or
    equipment tag opens: the open tickets there (the summary only for a
    ticket the caller cannot open), the topics a problem can be reported
    under, and whether the caller may start work. 404 for a property the
    caller may not see (the screen's access-denied state).
  * POST /maintenance/place/{property}/report - Report a Problem: ONE ticket
    through file_ticket, the property (and equipment) set and locked.
  * GET  /maintenance/my-work - a technician's list: open tickets assigned
    to me, and (desk agents) my team's unassigned tickets at properties,
    preventive first by due date.
  * POST /maintenance/tickets/{id}/start | /done | /checklist - Start (In
    Progress, mine when nobody holds it), Done (a photo is REQUIRED on a
    preventive ticket - evidence, like Items), and a checklist tick. Each
    goes through update_ticket.
  * POST /maintenance/tags - the site tag and its equipment tags for one
    property, for the Items tag sheet (white-label company name).

No offline layer here (feat/field-offline builds it): the screens call these
plainly so they can adopt its outbox later.
"""
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

import auth
import maintenance_services as MS
import models
import property_links
import ticket_roles
import ticket_taxonomy
from auth import get_current_user
from database import get_db
from routers import tickets as T
from routers.task_util import gen_id, now_iso
from ticket_code import ticket_no

router = APIRouter(prefix="/maintenance", tags=["Maintenance"], dependencies=[Depends(get_current_user)])

_CLOSED = property_links.CLOSED_STATES
_AREA_LABEL = {"facilities": "Buildings & Maintenance", "storageops": "Site Operations", "security": "Site Security"}
PHOTO_MAX = 10


def _me(user: dict) -> str:
    return (user.get("email") or "").strip().lower()


def _names(db: Session, emails) -> dict:
    emails = {(e or "").lower() for e in emails if e}
    if not emails:
        return {}
    out = {}
    for e in (db.query(models.NexusEmployee)
              .filter(func.lower(models.NexusEmployee.work_email).in_(emails)).all()):
        out[(e.work_email or "").lower()] = f"{e.first_name or ''} {e.last_name or ''}".strip() or e.work_email
    return out


def _checklist(t) -> list:
    raw = (t.type_fields or {}).get("checklist") if isinstance(t.type_fields, dict) else None
    return [{"label": str(c.get("label") or ""), "done": bool(c.get("done"))}
            for c in (raw if isinstance(raw, list) else []) if isinstance(c, dict) and c.get("label")]


def _row(t, *, can_open: bool, names: dict, assets: dict, today_of) -> dict:
    """One ticket as the field screens show it. A ticket the caller cannot
    open is a summary: no description, no checklist, no people."""
    status = t.status if (t.status and t.status != "new") else "open"
    preventive = MS.is_preventive_ticket(t)
    due = (t.pm_due_on or "") if preventive else ""
    asset = assets.get(t.equipment_asset_id or "")
    out = {"id": t.id, "codeLabel": ticket_no(t.code), "subject": t.subject, "status": status,
           "priority": t.priority or "medium", "preventive": preventive, "pmDueOn": due,
           "overdue": MS.pm_overdue(t, today_of),
           "propertyId": t.property_asset_id or "", "propertyName": t.property_name or "",
           "equipmentAssetId": t.equipment_asset_id or "",
           "equipmentName": property_links.display_name(asset) if asset is not None else "",
           "unit": t.property_unit or "", "canOpen": can_open, "createdAt": t.created_at or ""}
    if can_open:
        a = (t.assignee_email or "").lower()
        out.update(assigneeEmail=a, assigneeName=names.get(a, a), checklist=_checklist(t),
                   description=t.description or "", slaDueAt=t.sla_due_at or "")
    return out


def _sort_key(r: dict):
    # Preventive first by due date, then the rest by priority and age.
    rank = {"urgent": 0, "high": 1, "medium": 2, "low": 3}
    return (0 if r["preventive"] and r["pmDueOn"] else 1, r["pmDueOn"] or "9999",
            rank.get(r["priority"], 9), r["createdAt"])


def _assets(db: Session, ids) -> dict:
    ids = [i for i in set(ids) if i]
    if not ids:
        return {}
    return {a.id: a for a in db.query(models.PropertyAsset).filter(models.PropertyAsset.id.in_(ids)).all()}


# ── Overdue per site ─────────────────────────────────────────────────────────

def rollup_rows(db: Session, user: dict) -> dict:
    """Open / overdue preventive tickets per property and per company, walled.
    A preventive ticket = one a schedule filed (service_id) with its due day."""
    scope = auth.company_scope(user, db)
    T_ = models.TaskTicket
    rows = (db.query(T_.id, T_.property_asset_id, T_.property_name, T_.company_id, T_.pm_due_on)
            .filter(T_.service_id != "", T_.service_id.isnot(None), T_.pm_due_on != "",
                    ~T_.status.in_(_CLOSED)).all())
    rows = [r for r in rows if auth.company_ok(r.company_id or "", scope)]
    props = _assets(db, [r.property_asset_id for r in rows])
    allowed = property_links.asset_scope(db, user)
    today_of = MS.TodayCache(db)         # each ticket's company calendar (review M3)
    per: dict = {}
    comp: dict = {}
    for r in rows:
        p = props.get(r.property_asset_id or "")
        if p is None or not property_links.viewable(p, user) or not property_links.in_scope(p, allowed):
            continue
        o = per.setdefault(p.id, {"propertyId": p.id, "propertyName": property_links.display_name(p),
                                  "open": 0, "overdue": 0, "nextDue": "", "oldestOverdue": ""})
        late = r.pm_due_on < today_of(r.company_id or "").isoformat()
        o["open"] += 1
        if late:
            o["overdue"] += 1
            o["oldestOverdue"] = min(filter(None, [o["oldestOverdue"], r.pm_due_on]))
        elif not o["nextDue"] or r.pm_due_on < o["nextDue"]:
            o["nextDue"] = r.pm_due_on
        c = comp.setdefault(r.company_id or "", {"companyId": r.company_id or "", "open": 0, "overdue": 0})
        c["open"] += 1
        c["overdue"] += 1 if late else 0
    names = {e.id: e.name for e in db.query(models.HrEntity)
             .filter(models.HrEntity.id.in_([k for k in comp if k] or [""])).all()}
    for c in comp.values():
        c["companyName"] = names.get(c["companyId"], "") or ("No Company" if not c["companyId"] else "")
    properties = sorted(per.values(), key=lambda o: (-o["overdue"], -o["open"], o["propertyName"].lower()))
    return {"properties": properties,
            "companies": sorted(comp.values(), key=lambda c: (-c["overdue"], c["companyName"].lower())),
            "open": sum(o["open"] for o in properties), "overdue": sum(o["overdue"] for o in properties)}


@router.get("/rollup")
def rollup(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if not (T._has_desk_grant(user, db) or property_links.may_walkthrough(db, user)):
        raise HTTPException(403, "The preventive maintenance roll-up is for the service desk and the Asset "
                                 "Management team.")
    return rollup_rows(db, user)


# ── Scan to Request ──────────────────────────────────────────────────────────

def _place_or_404(db: Session, user: dict, property_id: str, asset_id: str = ""):
    prop = db.get(models.PropertyAsset, property_id)
    if prop is None or not property_links.is_listed(prop, user, db):
        raise HTTPException(404, "No property you can see matches this tag.")
    asset = None
    if (asset_id or "").strip():
        asset = db.get(models.PropertyAsset, asset_id.strip())
        if (asset is None or not property_links.viewable(asset, user) or (asset.payload or {}).get("deleted")
                or property_links.asset_kind(asset) not in ("vehicle", "equipment")
                or not property_links.in_scope(asset, property_links.asset_scope(db, user))):
            raise HTTPException(404, "No equipment you can see matches this tag.")
    return prop, asset


def report_options(db: Session, user: dict) -> list:
    """The topics a problem at a property can be reported under, each with the
    caller's company's team that takes it: help topics about a place
    (property_links.PROPERTY_AREAS), from the groups whose departments exist
    in that company and may link a property."""
    company = T.company_for(db, _me(user))
    depts = (db.query(models.HrDepartment).filter(models.HrDepartment.company_id == company).all()
             if company else [])
    by_name = {(d.name or "").strip().lower(): d for d in depts}
    out, seen = [], set()
    for g in ticket_taxonomy.get_config(db).get("helpTopics") or []:
        dept = next((by_name[n] for n in (str(x).strip().lower() for x in (g.get("departments") or []))
                     if n in by_name), None)
        if dept is None or not property_links.department_takes_property(db, dept.id):
            continue
        for tp in g.get("topics") or []:
            area = (tp or {}).get("area")
            name = str((tp or {}).get("name") or "").strip()
            if area in property_links.PROPERTY_AREAS and name and name.lower() not in seen:
                seen.add(name.lower())
                out.append({"topic": name, "area": area, "areaLabel": _AREA_LABEL.get(area, area),
                            "departmentId": dept.id, "departmentName": dept.name or ""})
    return out


@router.get("/place/{property_id}")
def place(property_id: str, asset: str = "", user: dict = Depends(get_current_user),
          db: Session = Depends(get_db)):
    prop, eq = _place_or_404(db, user, property_id, asset)
    ids = property_links.group_ids(db, prop, user)
    T_ = models.TaskTicket
    q = db.query(T_).filter(T_.property_asset_id.in_(ids), ~T_.status.in_(_CLOSED))
    if eq is not None:
        q = q.filter(T_.equipment_asset_id == eq.id)
    scope = auth.company_scope(user, db)
    rows = [t for t in q.all() if auth.company_ok(t.company_id or "", scope)]
    desk = T._has_desk_grant(user, db)
    me = _me(user)
    names = _names(db, {t.assignee_email for t in rows})
    assets = _assets(db, [t.equipment_asset_id for t in rows])
    today_of = MS.TodayCache(db)
    # Who sees what (review M4): a ticket the caller may open in full; the
    # Asset Management team (and the desk) a summary of the rest; anyone else
    # who scans - a tenant-facing crew, another team - only that something is
    # open here, never what, where or how urgent.
    reader = desk or property_links.is_asset_reader(db, user)
    out = []
    for t in rows:
        can_open = desk or me in T._ticket_readers(t)
        if can_open or reader:
            out.append(_row(t, can_open=can_open, names=names, assets=assets, today_of=today_of))
        else:
            out.append({"id": "", "codeLabel": "", "subject": "Open Request", "status": "open", "priority": "",
                        "preventive": False, "pmDueOn": "", "overdue": False, "propertyId": "", "propertyName": "",
                        "equipmentAssetId": "", "equipmentName": "", "unit": "", "canOpen": False,
                        "createdAt": t.created_at or "", "generic": True})
    out.sort(key=_sort_key)
    for i, r in enumerate(out):
        if r.get("generic"):
            r["id"] = f"open-{i + 1}"       # a key for the list, never the ticket's id
    import ticket_property_link
    units = ticket_property_link.unit_options(db, prop)
    return {"property": {"id": prop.id, "name": property_links.display_name(prop),
                         "city": str((prop.payload or {}).get("city") or "")},
            "asset": ({"id": eq.id, "name": property_links.display_name(eq),
                       "kind": property_links.asset_kind(eq)} if eq is not None else None),
            "tickets": out, "topics": report_options(db, user), "units": units,
            "canStart": ticket_roles.can_work_queue(user, db)}


class ReportBody(BaseModel):
    topic: str
    subject: str
    description: Optional[str] = ""
    photos: Optional[list] = None
    unit: Optional[str] = ""
    asset_id: Optional[str] = ""
    priority: Optional[str] = "medium"


@router.post("/place/{property_id}/report", status_code=201)
def report_problem(property_id: str, body: ReportBody, background_tasks: BackgroundTasks,
                   user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    prop, eq = _place_or_404(db, user, property_id, body.asset_id or "")
    opt = next((o for o in report_options(db, user) if o["topic"].lower() == (body.topic or "").strip().lower()),
               None)
    if opt is None:
        raise HTTPException(400, "Pick what the problem is about.")
    subject = " ".join((body.subject or "").split())[:200]
    if not subject:
        raise HTTPException(400, "Say what is wrong.")
    photos = [u for u in (body.photos or []) if isinstance(u, str) and u.strip()][:PHOTO_MAX]
    tb = T.TicketBody(subject=subject, description=_html(body.description or ""),
                      type="incident", priority=(body.priority or "medium"), application=opt["topic"],
                      hr_department_id=opt["departmentId"], property_asset_id=prop.id, property_locked=True,
                      property_unit=body.unit or "", images=photos,
                      equipment_asset_id=eq.id if eq is not None else "")
    return T.file_ticket(tb, background_tasks, user, db, arrived_by="scan")


def _html(text: str) -> str:
    import html
    lines = [html.escape(x) for x in (text or "").strip().splitlines()]
    return "".join(f"<p>{x}</p>" for x in lines if x.strip())


# ── My Work ──────────────────────────────────────────────────────────────────

def _my_departments(db: Session, email: str) -> list:
    emp = (db.query(models.NexusEmployee)
           .filter(func.lower(models.NexusEmployee.work_email) == email).first())
    name = ((emp.department if emp is not None else "") or "").strip().lower()
    company = (emp.company if emp is not None else "") or ""
    if not name:
        return []
    return [d.id for d in db.query(models.HrDepartment).filter(models.HrDepartment.company_id == company).all()
            if (d.name or "").strip().lower() == name]


@router.get("/my-work")
def my_work(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = _me(user)
    T_ = models.TaskTicket
    scope = auth.company_scope(user, db)
    mine = (db.query(T_).filter(func.lower(T_.assignee_email) == me, ~T_.status.in_(_CLOSED)).all())
    team = []
    worker = ticket_roles.can_work_queue(user, db)
    depts = _my_departments(db, me) if worker else []
    if depts:
        team = (db.query(T_).filter(T_.hr_department_id.in_(depts), T_.property_asset_id != "",
                                    func.coalesce(T_.assignee_email, "") == "", ~T_.status.in_(_CLOSED),
                                    T_.approval_status.in_(("none", "approved"))).all())
    rows = [t for t in mine + team if auth.company_ok(t.company_id or "", scope)]
    names = _names(db, {t.assignee_email for t in rows})
    assets = _assets(db, [t.equipment_asset_id for t in rows])
    mine_ids = {t.id for t in mine}
    today_of = MS.TodayCache(db)
    out = sorted([dict(_row(t, can_open=True, names=names, assets=assets, today_of=today_of), mine=t.id in mine_ids)
                  for t in rows], key=_sort_key)
    return {"tickets": out, "canStart": worker,
            "overdue": len([r for r in out if r["overdue"]]),
            "preventive": len([r for r in out if r["preventive"]])}


def _ticket_for(db: Session, user: dict, ticket_id: str):
    t = db.query(models.TaskTicket).filter(models.TaskTicket.id == ticket_id).first()
    if t is None:
        raise HTTPException(404, "Ticket not found.")
    auth.assert_company(t.company_id or "", user, db)
    if not (T._has_desk_grant(user, db) or _me(user) in T._ticket_readers(t)):
        raise HTTPException(404, "Ticket not found.")
    return t


@router.post("/tickets/{ticket_id}/start")
def start_work(ticket_id: str, background_tasks: BackgroundTasks, user: dict = Depends(get_current_user),
               db: Session = Depends(get_db)):
    """In Progress - and mine when nobody holds it (the desk's own assign)."""
    t = _ticket_for(db, user, ticket_id)
    if (t.status or "") in _CLOSED:
        raise HTTPException(409, "This ticket is already done - reopen it from the ticket.")
    upd = T.TicketUpdate(status="in_progress")
    if not (t.assignee_email or "").strip():
        if not ticket_roles.can_assign(user, db):
            raise HTTPException(403, "Ask the service desk to assign this ticket to you.")
        upd.assignee_email = _me(user)
    return T.update_ticket(ticket_id, upd, background_tasks, user=user, db=db)


class DoneBody(BaseModel):
    note: str = ""
    photos: Optional[list] = None
    checklist: Optional[list] = None   # [{label, done}] as ticked on the phone


def _merged_checklist(t, ticks) -> list:
    have = _checklist(t)
    if not isinstance(ticks, list):
        return have
    done = {str(c.get("label") or ""): bool(c.get("done")) for c in ticks if isinstance(c, dict)}
    return [{"label": c["label"], "done": done.get(c["label"], c["done"])} for c in have]


@router.post("/tickets/{ticket_id}/done")
def done_work(ticket_id: str, body: DoneBody, background_tasks: BackgroundTasks,
              user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Resolved, with what was done. A preventive ticket needs a photo: the
    photo is the evidence the service happened (Items' rule for handovers)."""
    from routers.items import _validate_photo_url
    t = _ticket_for(db, user, ticket_id)
    if (t.status or "") in _CLOSED:
        raise HTTPException(409, "This ticket is already done.")
    note = (body.note or "").strip()
    if not note:
        raise HTTPException(400, "Say what was done.")
    photos = []
    for u in (body.photos or [])[:PHOTO_MAX]:
        if isinstance(u, str) and u.strip():
            _validate_photo_url(u.strip(), "Photo")
            photos.append(u.strip())
    if MS.is_preventive_ticket(t) and not photos:
        raise HTTPException(400, "Add a photo of the finished work - a preventive ticket needs one.")
    fields = dict(t.type_fields or {}) if isinstance(t.type_fields, dict) else {}
    if fields.get("checklist"):
        fields["checklist"] = _merged_checklist(t, body.checklist)
    upd = T.TicketUpdate(status="resolved", resolution="done", resolution_note=note[:4000], type_fields=fields)
    me = _me(user)
    now = now_iso()
    for i, u in enumerate(photos):
        db.add(models.TaskAttachment(id=gen_id(), task_id=t.id, name=f"Finished Work {i + 1}.jpg", size="",
                                     kind="image", url=u, added_at=now, added_by=me))
    db.flush()   # the photos are on the ticket before update_ticket checks for one
    return T.update_ticket(ticket_id, upd, background_tasks, user=user, db=db)


class TickBody(BaseModel):
    label: str
    done: bool = True


@router.post("/tickets/{ticket_id}/checklist")
def tick(ticket_id: str, body: TickBody, background_tasks: BackgroundTasks,
         user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = _ticket_for(db, user, ticket_id)
    items = _checklist(t)
    if not any(c["label"] == body.label for c in items):
        raise HTTPException(404, "That step is not on this ticket's checklist.")
    fields = dict(t.type_fields or {})
    fields["checklist"] = [dict(c, done=body.done if c["label"] == body.label else c["done"]) for c in items]
    T.update_ticket(ticket_id, T.TicketUpdate(type_fields=fields), background_tasks, user=user, db=db)
    return {"checklist": fields["checklist"]}


# ── Tags ─────────────────────────────────────────────────────────────────────

class TagsBody(BaseModel):
    property_id: str


def place_path(property_id: str, asset_id: str = "") -> str:
    from urllib.parse import quote
    return f"/tickets/place/{quote(property_id, safe='')}" + (f"/{quote(asset_id, safe='')}" if asset_id else "")


@router.post("/tags")
def place_tags(body: TagsBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The property's site tag and one tag per piece of equipment there (the
    vehicles and equipment its schedules and open tickets name - Asset
    Management has no other link between a property and its equipment).
    For the people who keep the property's maintenance."""
    from routers.items import _tag_public_base
    prop = db.get(models.PropertyAsset, body.property_id)
    if prop is None or not property_links.is_listed(prop, user, db):
        raise HTTPException(404, "Property not found")
    if not property_links.may_follow(db, user, prop):
        raise HTTPException(403, "Tags are printed by the property's asset manager and Asset Management editors.")
    ids = property_links.group_ids(db, prop, user)
    M = models.PropertyMaintenanceService
    svc = db.query(M).filter(M.property_asset_id.in_(ids)).all()
    T_ = models.TaskTicket
    eq_ids = {s.asset_id for s in svc if s.asset_id} | {
        r[0] for r in db.query(T_.equipment_asset_id).filter(T_.property_asset_id.in_(ids),
                                                              T_.equipment_asset_id != "").all()}
    companies = [(s.template or {}).get("company_id") for s in svc if (s.template or {}).get("company_id")]
    company_id = companies[0] if companies else T.company_for(db, _me(user))
    ent = db.get(models.HrEntity, company_id) if company_id else None
    company = (ent.name if ent is not None else "") or ""
    name = property_links.display_name(prop)
    tags = [{"id": prop.id, "name": name, "serialNumber": "Report a Problem", "companyName": company,
             "path": place_path(prop.id), "kind": "site"}]
    for a in sorted(_assets(db, eq_ids).values(), key=lambda a: property_links.display_name(a).lower()):
        if not property_links.viewable(a, user) or (a.payload or {}).get("deleted"):
            continue
        tags.append({"id": a.id, "name": property_links.display_name(a), "serialNumber": name,
                     "companyName": company, "path": place_path(prop.id, a.id), "kind": "equipment"})
    return {"tags": tags, "publicBase": _tag_public_base()}
