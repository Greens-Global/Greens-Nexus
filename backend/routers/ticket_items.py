"""Tickets <-> equipment (Oct 2026): a ticket names the item(s) it is about.

"My laptop will not boot" is about one laptop, and the next person to work on
that laptop should see that it has been in before. A ticket links to one or
more rows of `items` (Items and Assets are ONE concept - Neil; the legacy
hardware_assets table is never used here) through ticket_item_links.

THE TICKET SIDE ONLY. Items belong to Visesh: routers/items.py and the
Inventory screens are read, never changed. GET /task-tickets/by-item/{id} is
the ready-made read for the item screen to show an item's tickets.

Who may link what (strict, decided here - the items list itself shows every
item in the company to anyone, which is too wide for this):
  * Everyone: the item must be live (not soft-deleted), inside the caller's
    company scope (auth.company_ok - the wall), AND in the ticket's own
    company. An untagged item or ticket ('' company) only fits while the
    company walls are off, so nothing crosses a wall that is armed.
  * Desk agents (ticket_roles.can_work_queue): any item that passes the
    above, on any ticket they can open.
  * Everyone else - the ticket's requester, or whoever filed it for them:
    only an item HELD by the requester or by themselves. Held = permanently
    assigned (items.assigned_to_email) or in an active checkout they hold
    (item_checkouts.requested_by_email, status pending_receipt / allocated).
    Watchers and other participants may look, not link.
  * Unlinking: the desk any link; anyone else only a link they made.

Ticket history per item ("Other Tickets for This Item", by-item) is filtered
through tickets.ListScope - the one definition of which tickets a caller may
see - so a link never reveals a ticket the list would hide.

Every link and unlink writes a ticket activity row (item_linked /
item_unlinked) like any other field change. Soft links: a deleted ticket
vanishes from by-item (the database.py hook), a deleted or purged item still
shows on the ticket by its stored name.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

import auth
import models
import ticket_roles
from auth import get_current_user
from database import get_db
from routers import tickets as T
from routers.task_util import gen_id, log_activity, now_iso
from ticket_code import ticket_no

router = APIRouter(tags=["Tickets"], dependencies=[Depends(get_current_user)])

# A checkout in these states means the item is in that person's hands.
HELD_CHECKOUT_STATES = ("pending_receipt", "allocated")
MAX_LINKS_PER_TICKET = 20
OPTION_LIMIT = 50


# ── helpers ─────────────────────────────────────────────────────────────────
def _live(q):
    I = models.Item
    return q.filter(or_(I.deleted_at.is_(None), I.deleted_at == ""))


def _held_ids(db: Session, emails: set) -> dict:
    """{item_id: holder email} for every item held by one of `emails` -
    permanently assigned, or in an active checkout they hold."""
    emails = {e.strip().lower() for e in emails if (e or "").strip()}
    if not emails:
        return {}
    out = {}
    for iid, who in (db.query(models.Item.id, models.Item.assigned_to_email)
                     .filter(func.lower(func.coalesce(models.Item.assigned_to_email, "")).in_(sorted(emails))).all()):
        out[iid] = (who or "").lower()
    C = models.ItemCheckout
    for iid, who in (db.query(C.item_id, C.requested_by_email)
                     .filter(C.status.in_(HELD_CHECKOUT_STATES),
                             func.lower(func.coalesce(C.requested_by_email, "")).in_(sorted(emails))).all()):
        out.setdefault(iid, (who or "").lower())
    return out


def _checkout_holders(db: Session, item_ids: list) -> dict:
    """{item_id: email} of who holds each item on an active checkout."""
    if not item_ids:
        return {}
    C = models.ItemCheckout
    return {iid: (who or "").lower() for iid, who in
            db.query(C.item_id, C.requested_by_email)
            .filter(C.item_id.in_(item_ids), C.status.in_(HELD_CHECKOUT_STATES)).all()}


def _company_fits(db: Session, item_company: str, ticket_company: str) -> bool:
    """The item belongs to the ticket's company. Both tagged = they must be
    the same; either untagged = only while the walls are off."""
    ic, tc = (item_company or "").strip(), (ticket_company or "").strip()
    if ic and tc:
        return ic == tc
    return not auth._company_walls_on(db)


def _label(name: str, serial: str) -> str:
    return f"{name} ({serial})" if serial else (name or "an item")


def _item_dict(i: Optional[models.Item], *, holder: str = "", fallback_name: str = "",
               item_id: str = "", mine: bool = False) -> dict:
    """What a ticket shows about an item - identity and who has it, nothing
    financial (no value, no custom fields beyond an asset tag)."""
    if i is None:
        return {"id": item_id, "name": fallback_name or "Removed Item", "serialNumber": "", "assetTag": "",
                "itemType": "", "makeModel": "", "assignedToEmail": "", "assignedToName": "",
                "heldBy": "", "status": "", "removed": True, "deleted": True, "mine": False}
    cf = i.custom_fields if isinstance(i.custom_fields, dict) else {}
    return {
        "id": i.id, "name": i.name or "", "serialNumber": i.serial_number or "",
        # No asset-tag column on items yet - read one only if an admin made it
        # a custom field. Never written from here.
        "assetTag": str(cf.get("asset_tag") or cf.get("assetTag") or ""),
        "itemType": i.item_type or "",
        "makeModel": " ".join(x for x in ((i.make or "").strip(), (i.model or "").strip()) if x),
        "assignedToEmail": (i.assigned_to_email or "").lower(), "assignedToName": i.assigned_to_name or "",
        "heldBy": holder or (i.assigned_to_email or "").lower(),
        "status": i.status or "", "removed": False, "deleted": bool(i.deleted_at), "mine": mine,
    }


def _ticket_brief(t) -> dict:
    return {"id": t.id, "code": t.code or "", "number": ticket_no(t.code or ""), "subject": t.subject or "",
            "status": t.status or "", "priority": t.priority or "", "requesterId": (t.requester_email or "").lower(),
            "createdAt": t.created_at or ""}


def _visible_tickets(db: Session, user: dict, ticket_ids: set) -> list:
    """The tickets among `ticket_ids` the caller may see - ListScope, the same
    rule as the ticket list (company wall in SQL, participant match off the
    desk, then the exact admits() guard)."""
    if not ticket_ids:
        return []
    scope = T.ListScope(db, user)
    q = scope.apply(db.query(models.TaskTicket).filter(models.TaskTicket.id.in_(sorted(ticket_ids))))
    return [t for t in q.all() if scope.admits(t)]


def _is_desk(db: Session, user: dict) -> bool:
    return ticket_roles.can_work_queue(user, db)


def _may_link(db: Session, user: dict, t: models.TaskTicket) -> bool:
    me = (user.get("email") or "").lower()
    return _is_desk(db, user) or me in {(t.requester_email or "").lower(), (t.created_by_email or "").lower()}


def check_items(db: Session, user: dict, item_ids, *, ticket_company: str, requester_email: str) -> list:
    """The items `user` may link to a ticket of `ticket_company` raised for
    `requester_email`, in the order given (duplicates dropped). Raises on the
    first one they may not: 404 when it is gone or behind the wall (existence
    never leaks), 422 when it is another company's than the ticket's, 403
    when it is not theirs to link."""
    ids = []
    for x in item_ids or []:
        x = str(x or "").strip()
        if x and x not in ids:
            ids.append(x)
    if not ids:
        return []
    if len(ids) > MAX_LINKS_PER_TICKET:
        raise HTTPException(422, f"A ticket can name at most {MAX_LINKS_PER_TICKET} items")
    rows = {i.id: i for i in _live(db.query(models.Item).filter(models.Item.id.in_(ids))).all()}
    scope = auth.company_scope(user, db)
    desk = _is_desk(db, user)
    held = {} if desk else _held_ids(db, {requester_email, user.get("email") or ""})
    out = []
    for iid in ids:
        i = rows.get(iid)
        if i is None or not auth.company_ok(i.company_id or "", scope):
            raise HTTPException(404, "Equipment not found")
        if not _company_fits(db, i.company_id or "", ticket_company):
            raise HTTPException(422, f"{i.name} belongs to a different company than this ticket")
        if not desk and iid not in held:
            raise HTTPException(403, "You can only link equipment assigned to you or checked out by you")
        out.append(i)
    return out


def _add_links(db: Session, t: models.TaskTicket, items: list, actor: str) -> int:
    """Insert the links not already there, one activity row each."""
    have = {r.item_id for r in db.query(models.TicketItemLink.item_id)
            .filter(models.TicketItemLink.ticket_id == t.id).all()}
    fresh = [i for i in items if i.id not in have]
    if len(have) + len(fresh) > MAX_LINKS_PER_TICKET:
        raise HTTPException(422, f"A ticket can name at most {MAX_LINKS_PER_TICKET} items")
    now = now_iso()
    for i in fresh:
        db.add(models.TicketItemLink(id=gen_id(), ticket_id=t.id, item_id=i.id, item_name=i.name or "",
                                     linked_by=actor, linked_at=now))
        log_activity(db, type="item_linked", actor_email=actor, entity_kind="ticket", entity_id=t.id,
                     entity_code=t.code, entity_title=t.subject,
                     detail=f"linked equipment {_label(i.name, i.serial_number or '')}")
    return len(fresh)


def link_at_intake(db: Session, t: models.TaskTicket, user: dict, items: list) -> None:
    """Called by tickets.file_ticket once the new row exists (same commit).
    `items` comes from check_items, run before anything was written."""
    if items:
        _add_links(db, t, items, (user.get("email") or "").lower())


def _links_payload(db: Session, user: dict, t: models.TaskTicket) -> dict:
    links = (db.query(models.TicketItemLink).filter(models.TicketItemLink.ticket_id == t.id)
             .order_by(models.TicketItemLink.linked_at).all())
    ids = [lk.item_id for lk in links]
    rows = ({i.id: i for i in db.query(models.Item).filter(models.Item.id.in_(ids)).all()} if ids else {})
    holders = _checkout_holders(db, ids)
    # Other tickets for each item - one query for every link, one for the
    # tickets, then ListScope decides what this caller may see of them.
    others = {}
    if ids:
        for iid, tid in (db.query(models.TicketItemLink.item_id, models.TicketItemLink.ticket_id)
                         .filter(models.TicketItemLink.item_id.in_(ids),
                                 models.TicketItemLink.ticket_id != t.id).all()):
            others.setdefault(iid, set()).add(tid)
    visible = {x.id: x for x in _visible_tickets(db, user, set().union(*others.values()) if others else set())}
    me = (user.get("email") or "").lower()
    desk = _is_desk(db, user)
    may_link = _may_link(db, user, t)
    out = []
    for lk in links:
        d = _item_dict(rows.get(lk.item_id), holder=holders.get(lk.item_id, ""), fallback_name=lk.item_name,
                       item_id=lk.item_id)
        tickets_ = sorted((_ticket_brief(visible[x]) for x in others.get(lk.item_id, ()) if x in visible),
                          key=lambda b: b["createdAt"], reverse=True)
        d.update({"linkedBy": lk.linked_by or "", "linkedAt": lk.linked_at or "",
                  "canUnlink": desk or (may_link and (lk.linked_by or "").lower() == me),
                  "otherTickets": tickets_, "otherCount": len(tickets_)})
        out.append(d)
    return {"items": out, "canLink": may_link, "desk": desk}


# ── endpoints ───────────────────────────────────────────────────────────────
@router.get("/task-tickets/item-options")
def item_options(ticket_id: str = "", company_id: str = "", requester: str = "", q: str = "",
                 user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The Equipment picker's choices: the items this caller may link, the
    requester's own (assigned or checked out) first - "My Laptop" is the
    usual answer. On an existing ticket pass ticket_id; on the create form
    pass the company and requester the form has (the company is resolved
    exactly as filing would - tickets._intake_company)."""
    me = (user.get("email") or "").lower()
    desk = _is_desk(db, user)
    if ticket_id:
        t = T._ticket_or_404(db, ticket_id)
        T._require_ticket_participant(db, user, t)
        if not _may_link(db, user, t):
            raise HTTPException(403, "You can't add equipment to this ticket")
        ticket_company, req_email = t.company_id or "", (t.requester_email or "").lower()
    else:
        try:   # the form may still hold a half-typed requester - suggest for me then
            req_email = T._valid_requester(db, user, requester or "") or me
        except HTTPException:
            req_email = me
        ticket_company = T._intake_company(db, user, company_id, req_email)
    held = _held_ids(db, {req_email} | ({me} if not desk else set()))
    scope = auth.company_scope(user, db)
    I = models.Item
    query = _live(db.query(I))
    needle = (q or "").strip().lower()
    if needle:
        like = f"%{needle}%"
        query = query.filter(or_(*[func.lower(func.coalesce(c, "")).like(like)
                                   for c in (I.name, I.serial_number, I.make, I.model, I.assigned_to_name, I.item_type)]))
    if not desk:
        if not held:
            return {"items": [], "desk": False}
        query = query.filter(I.id.in_(sorted(held)))
    # The requester's own first, then by name; a little over the limit is
    # read so the company filter below still leaves a full page.
    rows = query.order_by(I.name).limit(OPTION_LIMIT * 4).all()
    rows = [i for i in rows if auth.company_ok(i.company_id or "", scope) and _company_fits(db, i.company_id or "", ticket_company)]
    if desk and not needle:
        # Make sure the requester's own are in the page even in a big catalog.
        mine_missing = [x for x in held if x not in {i.id for i in rows}]
        if mine_missing:
            extra = _live(db.query(I).filter(I.id.in_(mine_missing))).all()
            rows += [i for i in extra if auth.company_ok(i.company_id or "", scope)
                     and _company_fits(db, i.company_id or "", ticket_company)]
    rows.sort(key=lambda i: (0 if held.get(i.id) == req_email else 1 if i.id in held else 2, (i.name or "").lower()))
    holders = _checkout_holders(db, [i.id for i in rows[:OPTION_LIMIT]])
    return {"items": [_item_dict(i, holder=held.get(i.id) or holders.get(i.id, ""), mine=held.get(i.id) == req_email)
                      for i in rows[:OPTION_LIMIT]],
            "desk": desk}


@router.get("/task-tickets/by-item/{item_id}")
def tickets_for_item(item_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Every ticket linked to this item that the caller may see (ListScope),
    newest first - the read the item screen uses for an item's ticket
    history. 404 for an item behind the company wall."""
    item = db.query(models.Item).filter(models.Item.id == item_id).first()
    if item is None:
        raise HTTPException(404, "Item not found")
    auth.assert_company(item.company_id or "", user, db)
    ids = {r.ticket_id for r in db.query(models.TicketItemLink.ticket_id)
           .filter(models.TicketItemLink.item_id == item_id).all()}
    rows = sorted((_ticket_brief(t) for t in _visible_tickets(db, user, ids)),
                  key=lambda b: b["createdAt"], reverse=True)
    return {"item": _item_dict(item), "tickets": rows, "count": len(rows)}


@router.get("/task-tickets/{ticket_id}/items")
def ticket_items(ticket_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = T._ticket_or_404(db, ticket_id)
    T._require_ticket_participant(db, user, t)
    return _links_payload(db, user, t)


class ItemLinkBody(BaseModel):
    item_ids: list[str]


@router.post("/task-tickets/{ticket_id}/items", status_code=201)
def link_items(ticket_id: str, body: ItemLinkBody, user: dict = Depends(get_current_user),
               db: Session = Depends(get_db)):
    t = T._ticket_or_404(db, ticket_id, lock=True)   # one link batch at a time per ticket
    T._require_ticket_participant(db, user, t)
    if not _may_link(db, user, t):
        raise HTTPException(403, "You can't add equipment to this ticket")
    items = check_items(db, user, body.item_ids, ticket_company=t.company_id or "",
                        requester_email=t.requester_email or "")
    if _add_links(db, t, items, (user.get("email") or "").lower()):
        t.modified_at = now_iso()
    db.commit()
    return _links_payload(db, user, t)


@router.delete("/task-tickets/{ticket_id}/items/{item_id}")
def unlink_item(ticket_id: str, item_id: str, user: dict = Depends(get_current_user),
                db: Session = Depends(get_db)):
    t = T._ticket_or_404(db, ticket_id, lock=True)
    T._require_ticket_participant(db, user, t)
    lk = (db.query(models.TicketItemLink)
          .filter(models.TicketItemLink.ticket_id == t.id, models.TicketItemLink.item_id == item_id).first())
    if lk is None:
        raise HTTPException(404, "That equipment is not linked to this ticket")
    me = (user.get("email") or "").lower()
    if not (_is_desk(db, user) or (_may_link(db, user, t) and (lk.linked_by or "").lower() == me)):
        raise HTTPException(403, "Only the service desk can remove equipment someone else linked")
    item = db.query(models.Item).filter(models.Item.id == item_id).first()
    name = (item.name if item is not None else "") or lk.item_name
    db.delete(lk)
    log_activity(db, type="item_unlinked", actor_email=me, entity_kind="ticket", entity_id=t.id,
                 entity_code=t.code, entity_title=t.subject,
                 detail=f"removed equipment {_label(name, (item.serial_number if item is not None else '') or '')}")
    t.modified_at = now_iso()
    db.commit()
    return _links_payload(db, user, t)
