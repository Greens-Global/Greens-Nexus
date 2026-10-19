"""Tickets <-> properties, the Ops review pieces (Neil, Oct 20 2026) - see
ticket_property_link.py for the rules.

  GET  /ticket-property/rules                 which tickets must name a property (any signed-in form)
  PUT  /ticket-property/rules                 ticket supervisors / administrators
  GET  /ticket-property/suggest?text=         properties a ticket's words point at
  GET  /ticket-property/units/{property_id}   the units a ticket at that property may name
  GET  /ticket-property/link-suggestions      Suggest Property Links: open unlinked tickets + proposals
  POST /ticket-property/link-suggestions/{ticket_id}          link it (a person approved it)
  POST /ticket-property/link-suggestions/{ticket_id}/dismiss  stop proposing it

Nothing here links a ticket on its own: the backfill only PROPOSES, and each
link is one person's click on one ticket (Neil: "a human approves each").
"""
import json
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
import property_links
import ticket_property_link as L
import ticket_roles
from auth import get_current_user
from database import get_db
from routers.task_util import log_activity, now_iso
from ticket_code import ticket_no

router = APIRouter(prefix="/ticket-property", tags=["Tickets"], dependencies=[Depends(get_current_user)])

DISMISSED_KEY = "ticket_property_link_dismissed"
_SCAN_LIMIT = 500


def _may_link_existing(db: Session, user: dict) -> bool:
    """Suggest Property Links is a manager's tool: managers and up, ticket
    supervisors, and Asset Management editors. Never a guest."""
    from auth import _LEVELS
    user = user or {}
    if user.get("external"):
        return False
    return (user.get("level", 0) >= _LEVELS["manager"] or ticket_roles.can_manage_desk(user, db)
            or property_links.is_asset_editor(db, user))


def _require_linker(db: Session, user: dict) -> None:
    if not _may_link_existing(db, user):
        raise HTTPException(403, "Suggest Property Links is for managers, ticket supervisors and Asset Management editors.")


@router.get("/rules")
def get_rules(db: Session = Depends(get_db)):
    r = L.get_rules(db)
    # The facility map is an admin setting, not something every form needs.
    return {"requiredServiceAreas": r["requiredServiceAreas"], "requiredTopics": r["requiredTopics"]}


@router.put("/rules")
def put_rules(body: dict, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    from auth import _LEVELS
    if not (user.get("level", 0) >= _LEVELS["administrator"] or ticket_roles.can_manage_desk(user, db)):
        raise HTTPException(403, "Only a ticket supervisor or an administrator can change this.")
    return L.save_rules(db, body, user.get("email") or "")


@router.get("/suggest")
def suggest(text: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    text = (text or "")[:4000]
    out = L.suggest(db, text, user)
    if out:
        top = db.get(models.PropertyAsset, out[0]["id"])
        out[0]["unit"] = L.suggest_unit(db, top, text)
    return {"suggestions": out}


@router.get("/units/{property_id}")
def units(property_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    prop = db.get(models.PropertyAsset, property_id)
    if prop is None or not property_links.is_listed(prop, user):
        raise HTTPException(404, "Property not found")
    o = L.unit_options(db, prop)
    return {"units": o["units"], "source": o["source"], "strict": o["strict"], "required": L.unit_required(db, prop)}


# ── Suggest Property Links (backfill) ─────────────────────────────────────────

def _dismissed(db: Session) -> set:
    row = db.get(models.NexusSetting, DISMISSED_KEY)
    try:
        return set(json.loads(row.value)) if row and row.value else set()
    except (TypeError, ValueError):
        return set()


def _ticket_text(t) -> str:
    tf = t.type_fields if isinstance(t.type_fields, dict) else {}
    return " ".join(str(x or "") for x in (t.subject, t.description, tf.get("svc_facility"), tf.get("svc_unit")))


def _open_unlinked(db: Session, user: dict) -> list:
    import auth
    q = (db.query(models.TaskTicket)
         .filter(models.TaskTicket.status.notin_(property_links.CLOSED_STATES))
         .filter((models.TaskTicket.property_asset_id == "") | (models.TaskTicket.property_asset_id.is_(None)))
         .order_by(models.TaskTicket.created_at.desc()).limit(_SCAN_LIMIT))
    rows = q.all()
    scope = auth.company_scope(user, db)
    if scope is not None:
        rows = [t for t in rows if (t.company_id or "") in scope]
    return rows


@router.get("/link-suggestions")
def link_suggestions(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_linker(db, user)
    gone = _dismissed(db)
    out = []
    for t in _open_unlinked(db, user):
        if t.id in gone or not L.takes_property(db, t.hr_department_id, t.service_area):
            continue
        text = _ticket_text(t)
        props = L.suggest(db, text, user, limit=3)
        if not props:
            continue
        top = db.get(models.PropertyAsset, props[0]["id"])
        props[0]["unit"] = L.suggest_unit(db, top, text)
        out.append({"ticket": {"id": t.id, "code": t.code or "", "codeLabel": ticket_no(t.code), "subject": t.subject,
                               "status": t.status if (t.status and t.status != "new") else "open",
                               "application": t.application or "", "serviceArea": t.service_area or "",
                               "createdAt": t.created_at or ""},
                    "suggestions": props})
    return {"items": out}


class LinkBody(BaseModel):
    property_asset_id: str
    property_unit: Optional[str] = ""


@router.post("/link-suggestions/{ticket_id}")
def apply_link(ticket_id: str, body: LinkBody, background_tasks: BackgroundTasks,
               user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A person approved one proposal: link this ticket to that property.
    Only an UNLINKED open ticket - re-pointing stays the ticket's own edit."""
    _require_linker(db, user)
    from routers import tickets as T
    import auth
    t = db.query(models.TaskTicket).filter(models.TaskTicket.id == ticket_id).with_for_update().first()
    if t is None:
        raise HTTPException(404, "Ticket not found")
    auth.assert_company(t.company_id or "", user, db)
    if (t.property_asset_id or ""):
        raise HTTPException(409, f"This ticket is already on {t.property_name or 'a property'}.")
    if (t.status or "") in property_links.CLOSED_STATES:
        raise HTTPException(409, "This ticket is closed - reopen it to link a property.")
    prop = property_links.require_linkable(db, body.property_asset_id, user)
    L.require_takes_property(db, t.hr_department_id, t.service_area)
    me = (user.get("email") or "").strip().lower()
    t.property_asset_id, t.property_name = prop.id, property_links.display_name(prop)
    t.property_unit = L.clean_unit(db, prop, body.property_unit)
    t.modified_at = now_iso()
    log_activity(db, type="property_changed", actor_email=me, entity_kind="ticket", entity_id=t.id,
                 entity_code=t.code, entity_title=t.subject,
                 detail=f"linked the ticket to {t.property_name}"
                        + (f" ({t.property_unit})" if t.property_unit else "") + " from Suggest Property Links")
    T._tell_asset_manager(db, t, property_links.manager_email(db, prop), me)
    db.commit()
    db.refresh(t)
    return T.ticket_to_dict(t)


@router.post("/link-suggestions/{ticket_id}/dismiss")
def dismiss_link(ticket_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Not about a property (or no proposal fits): stop proposing it."""
    _require_linker(db, user)
    row = db.get(models.NexusSetting, DISMISSED_KEY)
    if row is None:
        row = models.NexusSetting(key=DISMISSED_KEY, value="[]")
        db.add(row)
    gone = _dismissed(db)
    gone.add(ticket_id)
    row.value = json.dumps(sorted(gone)[-5000:])
    row.updated_by = user.get("email") or ""
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    return {"ok": True}
