"""Construction - extra work, change orders and closeout: the routes (Neil,
11/03/2026, plan https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr, phase 3).
The rules live in construction_changes.py and construction_closeout.py; the
reach is routers/construction.py's (`_project` / `_may_log` / `_may_review`
/ `_may_see_cost` - another company's job is a 404).

  The crew (_may_log)        writes and gets field tickets signed on the phone,
                             adds closeout records
  A job reviewer             prices change orders and sends them, closes the
  (_may_review)              job out, sends the owner's sign-off
  An internal approver       approves or sends back a change order named to them
  Money (_may_see_cost)      only reviewers see amounts and the contract value;
                             crew see their field tickets (quantities only)

Every phone write takes the Idempotency-Key (idempotency.py - the ONE
mechanism; a field ticket also takes a phone-made id as its record id).
"""
from __future__ import annotations

import re
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import construction_changes as cc
import construction_closeout as cx
import construction_company
import models
from auth import get_current_user
from database import get_db
from idempotency import Idem, idempotency
from routers.construction import (_DAY, _EMAIL, _log_activity, _may_log, _may_read, _may_review, _may_see_cost,
                                  _me, _project)
from services import construction_storage as storage

router = APIRouter(prefix="/construction", tags=["Construction"],
                   dependencies=[Depends(get_current_user)])

_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{7,63}$")


def _names(db: Session, emails) -> dict:
    return construction_company.people_names(db, {(e or "").lower() for e in emails if e})


def _urls_ok(urls, project_id: str, what: str) -> list:
    if urls in (None, ""):
        return []
    if not isinstance(urls, list) or len(urls) > 30:
        raise HTTPException(422, f"{what} must be a list of at most 30 links.")
    out = []
    for u in urls:
        u = str(u or "").strip()
        if not u:
            continue
        bad = storage.check_media(url=u, storage_path="", thumbnail_url="", project_id=project_id)
        if bad:
            raise HTTPException(422, bad)
        out.append(u)
    return out


def _one_url(u: str, project_id: str) -> str:
    return (_urls_ok([u], project_id, "The file") or [""])[0] if (u or "").strip() else ""


def _replayed(idem: Idem, db, user):
    return idem.replay(db, user)


def _finish(idem: Idem, db, user, out, status=200):
    db.flush()
    idem.remember(db, user, out, status)
    lost = idem.commit(db, user)
    return lost if lost is not None else out


# ── The Changes tab ──────────────────────────────────────────────────────────

@router.get("/projects/{job_id}/changes")
def job_changes(job_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Field tickets (everyone on the job) and change orders with the money
    (job reviewers - the contract value's own rule)."""
    p = _project(db, job_id, user)
    if not _may_read(db, user, p):
        raise HTTPException(403, "You do not have access to this job.")
    T, C = models.ConstructionFieldTicket, models.ConstructionChangeOrder
    tickets = db.query(T).filter(T.project_id == p.id, T.deleted_at == "").order_by(T.created_at.desc()).all()
    money = _may_see_cost(db, user, p)
    cos = db.query(C).filter(C.project_id == p.id, C.deleted_at == "").order_by(C.created_at.desc()).all() if money else []
    names = _names(db, [t.created_by for t in tickets] + [c.created_by for c in cos] + [c.approver_email for c in cos])
    full = _may_review(db, user, p)
    return {
        # Each person's hours only for a job reviewer (review M4): the crew
        # sees one total line - the hours-only rule of the labor tab.
        "fieldTickets": [cc.ticket_to_dict(t, names, full_labor=full) for t in tickets],
        "changeOrders": [cc.co_to_dict(c, names) for c in cos],
        "totals": cc.totals(cos) if money else None,
        "contractValue": (p.contract_value or 0.0) if money else None,
        "targetFinishOn": p.target_finish_on or "",
        "canWrite": _may_log(db, user, p), "canPrice": money and _may_review(db, user, p),
        "today": construction_company.local_today(db, p).isoformat(),
        "reasons": [{"key": k, "label": cc.REASON_LABEL[k]} for k in cc.REASONS],
    }


@router.get("/projects/{job_id}/field-tickets/labor")
def field_ticket_labor(job_id: str, date: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    p = _project(db, job_id, user)
    if not _may_log(db, user, p):
        raise HTTPException(403, "You are not on this job.")
    day = (date or "").strip()[:10] or construction_company.local_today(db, p).isoformat()
    if not _DAY.match(day):
        raise HTTPException(422, "date must be a full date (YYYY-MM-DD)")
    return cc.ticket_labor(db, user, p, day, full=_may_review(db, user, p))


class TicketBody(BaseModel):
    id: Optional[str] = None
    work_date: Optional[str] = None
    description: Optional[str] = None
    labor: Optional[list] = None
    labor_from_punches: Optional[bool] = None
    materials: Optional[list] = None
    photo_urls: Optional[list] = None
    customer_name: Optional[str] = None
    customer_email: Optional[str] = None
    signature_url: Optional[str] = None
    signed_name: Optional[str] = None


def _apply_ticket(db, user, p, t, data: dict) -> None:
    if data.get("work_date") is not None:
        if data["work_date"] and not _DAY.match(data["work_date"]):
            raise HTTPException(422, "The work date must be a full date.")
        t.work_date = data["work_date"] or t.work_date
    if data.get("description") is not None:
        t.description = data["description"].strip()[:4000]
    try:
        if data.get("labor") is not None:
            t.labor = cc.clean_labor(data["labor"])
            t.labor_hours = round(sum(x["hours"] for x in t.labor), 2)
        if data.get("materials") is not None:
            t.materials = cc.clean_materials(data["materials"])
    except ValueError as e:
        raise HTTPException(422, str(e))
    if data.get("labor_from_punches") is not None:
        t.labor_from_punches = bool(data["labor_from_punches"])
        if t.labor_from_punches and data.get("labor") is None:
            got = cc.ticket_labor(db, user, p, t.work_date, full=_may_review(db, user, p))
            t.labor, t.labor_hours = got["lines"], got["total"]
    if data.get("photo_urls") is not None:
        t.photo_urls = _urls_ok(data["photo_urls"], p.id, "Photos")
    if data.get("customer_name") is not None:
        t.customer_name = " ".join(data["customer_name"].split())[:120]
    if data.get("customer_email") is not None:
        em = data["customer_email"].strip().lower()
        if em and not _EMAIL.match(em):
            raise HTTPException(422, f"{em!r} is not an email address")
        t.customer_email = em


def _sign_ticket(p, t, signature_url: str, signed_name: str) -> None:
    url = _one_url(signature_url, p.id)
    name = " ".join((signed_name or t.customer_name or "").split())[:120]
    if not url:
        raise HTTPException(422, "The customer's signature is missing - have them sign again.")
    if not name:
        raise HTTPException(422, "Type the name of the person signing.")
    t.signature_url, t.signed_name, t.signed_at, t.status = url, name, cc.now(), "signed"
    if not t.customer_name:
        t.customer_name = name


@router.post("/projects/{job_id}/field-tickets", status_code=201)
def create_field_ticket(job_id: str, body: TicketBody, user: dict = Depends(get_current_user),
                        db: Session = Depends(get_db), idem: Idem = Depends(idempotency)):
    """A time and material ticket. Written with no signal on the phone, the
    signature and all, it lands here once (the outbox's key; the phone-made id)."""
    hit = _replayed(idem, db, user)
    if hit is not None:
        return hit
    p = _project(db, job_id, user)
    if not _may_log(db, user, p):
        raise HTTPException(403, "You are not on this job.")
    T = models.ConstructionFieldTicket
    tid = (body.id or "").strip()
    if tid:
        if not _ID.match(tid):
            raise HTTPException(422, "A field ticket id is 8 to 64 letters, digits, '.', '_', ':' or '-'.")
        was = db.get(T, tid)
        if was is not None:
            if was.project_id != p.id or (was.created_by or "").lower() != _me(user):
                raise HTTPException(409, "That field ticket id is taken.")
            return cc.ticket_to_dict(was)
    data = body.model_dump(exclude_unset=True)
    if not (data.get("description") or "").strip():
        raise HTTPException(422, "Say what extra work was done.")
    t = T(id=tid or str(uuid.uuid4()), project_id=p.id, number=cc.next_number(db, T, p.id, "FT"),
          work_date=construction_company.local_today(db, p).isoformat(), status="open", created_by=_me(user),
          created_at=cc.now(), modified_at=cc.now(), deleted_at="", labor=[], materials=[], photo_urls=[])
    _apply_ticket(db, user, p, t, data)
    if data.get("signature_url"):
        _sign_ticket(p, t, data["signature_url"], data.get("signed_name") or "")
    db.add(t)
    _log_activity(db, project_id=p.id, entity_kind="field_ticket", entity_id=t.id, type="created",
                  actor_email=_me(user), detail=f"wrote field ticket {t.number}" + (" (signed)" if t.status == "signed" else ""))
    return _finish(idem, db, user, cc.ticket_to_dict(t), 201)


def _ticket(db, ticket_id: str, user):
    t = cc.find_ticket(db, ticket_id)
    if t is None:
        raise HTTPException(404, "Field ticket not found")
    p = _project(db, t.project_id, user)
    if not _may_read(db, user, p):
        raise HTTPException(404, "Field ticket not found")
    return t, p


@router.patch("/field-tickets/{ticket_id}")
def update_field_ticket(ticket_id: str, body: TicketBody, user: dict = Depends(get_current_user),
                        db: Session = Depends(get_db), idem: Idem = Depends(idempotency)):
    hit = _replayed(idem, db, user)
    if hit is not None:
        return hit
    t, p = _ticket(db, ticket_id, user)
    if (t.created_by or "").lower() != _me(user) and not _may_review(db, user, p):
        raise HTTPException(403, "Only its writer or a job manager can change this field ticket.")
    if t.status != "open":
        raise HTTPException(409, "A signed field ticket is the customer's record and cannot be changed.")
    _apply_ticket(db, user, p, t, body.model_dump(exclude_unset=True))
    t.modified_at = cc.now()
    return _finish(idem, db, user, cc.ticket_to_dict(t))


class SignBody(BaseModel):
    signature_url: str
    signed_name: Optional[str] = ""
    customer_name: Optional[str] = None
    customer_email: Optional[str] = None


@router.post("/field-tickets/{ticket_id}/sign")
def sign_field_ticket(ticket_id: str, body: SignBody, user: dict = Depends(get_current_user),
                      db: Session = Depends(get_db), idem: Idem = Depends(idempotency)):
    """The customer or owner signs on the phone (Nexus Sign's signature pad)."""
    hit = _replayed(idem, db, user)
    if hit is not None:
        return hit
    t, p = _ticket(db, ticket_id, user)
    if not _may_log(db, user, p):
        raise HTTPException(403, "You are not on this job.")
    if t.status == "signed":
        return cc.ticket_to_dict(t)
    if t.status != "open":
        raise HTTPException(409, "This field ticket can no longer be signed.")
    _apply_ticket(db, user, p, t, {k: v for k, v in body.model_dump(exclude_unset=True).items()
                                   if k in ("customer_name", "customer_email")})
    _sign_ticket(p, t, body.signature_url, body.signed_name or "")
    t.modified_at = cc.now()
    _log_activity(db, project_id=p.id, entity_kind="field_ticket", entity_id=t.id, type="signed",
                  actor_email=_me(user), detail=f"{t.signed_name} signed field ticket {t.number}")
    return _finish(idem, db, user, cc.ticket_to_dict(t))


@router.post("/field-tickets/{ticket_id}/void")
def void_field_ticket(ticket_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t, p = _ticket(db, ticket_id, user)
    if (t.created_by or "").lower() != _me(user) and not _may_review(db, user, p):
        raise HTTPException(403, "Only its writer or a job manager can void this field ticket.")
    if t.status == "signed" and not _may_review(db, user, p):
        raise HTTPException(403, "The customer signed this one - only a job manager can void it.")
    if t.status == "priced":
        raise HTTPException(409, "This field ticket is on a change order - void the change order instead.")
    t.status, t.modified_at = "void", cc.now()
    _log_activity(db, project_id=p.id, entity_kind="field_ticket", entity_id=t.id, type="voided",
                  actor_email=_me(user), detail=f"voided field ticket {t.number}")
    db.commit()
    return cc.ticket_to_dict(t)


# ── Change orders ────────────────────────────────────────────────────────────

class COBody(BaseModel):
    id: Optional[str] = None
    field_ticket_id: Optional[str] = None
    title: Optional[str] = None
    reason: Optional[str] = None
    description: Optional[str] = None
    amount: Optional[float] = None
    schedule_impact_days: Optional[int] = None
    approver_email: Optional[str] = None
    signer_name: Optional[str] = None
    signer_email: Optional[str] = None


def _pricer(db, user, p):
    if not (_may_review(db, user, p) and _may_see_cost(db, user, p)):
        raise HTTPException(403, "Only a job manager can price a change order.")


def _apply_co(db, user, p, c, data: dict) -> None:
    import math
    if data.get("title") is not None:
        c.title = data["title"].strip()[:200]
    if data.get("reason") is not None:
        if data["reason"] not in cc.REASONS:
            raise HTTPException(422, "Pick the reason for the change.")
        c.reason = data["reason"]
    if data.get("description") is not None:
        c.description = data["description"].strip()[:6000]
    if data.get("amount") is not None:
        a = float(data["amount"])
        if math.isnan(a) or abs(a) > 1e10:
            raise HTTPException(422, "The amount must be a number.")
        c.amount = round(a, 2)
    if data.get("schedule_impact_days") is not None:
        d = int(data["schedule_impact_days"])
        if abs(d) > 3650:
            raise HTTPException(422, "Schedule impact is at most 3650 days.")
        c.schedule_impact_days = d
    if data.get("approver_email") is not None:
        em = data["approver_email"].strip().lower()
        if em:
            if em == _me(user):
                raise HTTPException(422, "The approver must be someone else.")
            from routers.construction import _check_people
            import task_automation
            _check_people(db, user, [em])
            ap = task_automation._person_user(db, em)
            # Review M2: the approver reads the amount, so they must be a job
            # reviewer who may see the contract value.
            if not ap or not _may_review(db, ap, p) or not _may_see_cost(db, ap, p):
                raise HTTPException(422, "The approver must be a manager of this job who can see its money.")
        # Review M3: once an approver was asked, the pricer cannot take them off.
        if not em and (c.approver_email or "") and _approval_asked(db, c):
            raise HTTPException(409, "This change order already went to its approver - it needs their approval.")
        c.approver_email = em
    if data.get("signer_name") is not None:
        c.signer_name = " ".join(data["signer_name"].split())[:120]
    if data.get("signer_email") is not None:
        em = data["signer_email"].strip().lower()
        if em and not _EMAIL.match(em):
            raise HTTPException(422, f"{em!r} is not an email address")
        c.signer_email = em


@router.post("/projects/{job_id}/change-orders", status_code=201)
def create_change_order(job_id: str, body: COBody, user: dict = Depends(get_current_user),
                        db: Session = Depends(get_db), idem: Idem = Depends(idempotency)):
    """A Draft change order - from a signed field ticket (prefilled from it) or blank."""
    hit = _replayed(idem, db, user)
    if hit is not None:
        return hit
    p = _project(db, job_id, user)
    _pricer(db, user, p)
    C = models.ConstructionChangeOrder
    cid = (body.id or "").strip()
    if cid and db.get(C, cid) is not None:
        was = db.get(C, cid)
        if was.project_id != p.id:
            raise HTTPException(409, "That change order id is taken.")
        return cc.co_to_dict(was)
    c = C(id=cid or str(uuid.uuid4()), project_id=p.id, number=cc.next_number(db, C, p.id, "CO"), status="draft",
          reason="owner_request", amount=0.0, schedule_impact_days=0, created_by=_me(user), created_at=cc.now(),
          modified_at=cc.now(), deleted_at="")
    t = None
    if body.field_ticket_id:
        t = cc.find_ticket(db, body.field_ticket_id)
        if t is None or t.project_id != p.id:
            raise HTTPException(422, "Pick a field ticket from this job.")
        if t.status != "signed":
            raise HTTPException(409, "Only a signed field ticket can be priced." if t.status == "open"
                                else "That field ticket is already on a change order.")
        c.field_ticket_id = t.id
        c.title = (t.description or "").split("\n")[0][:120] or f"Extra work on {t.work_date}"
        c.description = t.description or ""
        c.signer_name, c.signer_email = t.customer_name or t.signed_name or "", t.customer_email or ""
    _apply_co(db, user, p, c, body.model_dump(exclude_unset=True))
    if not (c.title or "").strip():
        raise HTTPException(422, "Give the change order a title.")
    db.add(c)
    if t is not None:
        t.status, t.change_order_id, t.modified_at = "priced", c.id, cc.now()
    cc._activity(db, p, c, "created", _me(user), f"wrote change order {c.number}")
    return _finish(idem, db, user, cc.co_to_dict(c), 201)


def _co(db, co_id: str, user):
    c = db.get(models.ConstructionChangeOrder, co_id)
    if c is None or c.deleted_at:
        raise HTTPException(404, "Change order not found")
    p = _project(db, c.project_id, user)
    return c, p


@router.patch("/change-orders/{co_id}")
def update_change_order(co_id: str, body: COBody, user: dict = Depends(get_current_user),
                        db: Session = Depends(get_db), idem: Idem = Depends(idempotency)):
    hit = _replayed(idem, db, user)
    if hit is not None:
        return hit
    c, p = _co(db, co_id, user)
    _pricer(db, user, p)
    if c.status != "draft":
        raise HTTPException(409, "Only a draft change order can be changed.")
    data = body.model_dump(exclude_unset=True)
    data.pop("field_ticket_id", None)
    _apply_co(db, user, p, c, data)
    # Review M3: a changed draft is not what anyone approved.
    c.approved_by, c.approved_at = "", ""
    c.modified_at = cc.now()
    return _finish(idem, db, user, cc.co_to_dict(c))


def _approval_asked(db, c) -> bool:
    A = models.ConstructionActivity
    return db.query(A.id).filter(A.entity_kind == "change_order", A.entity_id == c.id,
                                 A.type == "approval_asked").first() is not None


def _claim_co(db, c, frm: str, to: str, **values) -> None:
    """Move a change order on only if it is still `frm` - one conditional
    UPDATE (review M6): two Send / Approve taps never make two envelopes."""
    C = models.ConstructionChangeOrder
    n = (db.query(C).filter(C.id == c.id, C.status == frm)
         .update({"status": to, "modified_at": cc.now(), **values}, synchronize_session=False))
    if n != 1:
        db.rollback()
        raise HTTPException(409, "This change order changed a moment ago - reload it.")
    db.commit()
    db.refresh(c)


def _ready_to_send(c) -> None:
    if not (c.signer_name or "").strip() or not _EMAIL.match((c.signer_email or "").strip()):
        raise HTTPException(422, "Name the owner or client who signs it, with their email.")
    if not (c.title or "").strip():
        raise HTTPException(422, "Give the change order a title.")


@router.post("/change-orders/{co_id}/send")
def send_change_order(co_id: str, body: COBody = None, user: dict = Depends(get_current_user),
                      db: Session = Depends(get_db), idem: Idem = Depends(idempotency)):
    """Draft -> Awaiting Approval (an internal approver is named and has not
    approved) or -> Sent (one Nexus Sign envelope to the owner or client)."""
    hit = _replayed(idem, db, user)
    if hit is not None:
        return hit
    c, p = _co(db, co_id, user)
    _pricer(db, user, p)
    if c.status not in ("draft",):
        raise HTTPException(409, f"This change order is already {c.status.replace('_', ' ')}.")
    if body is not None:
        data = {k: v for k, v in body.model_dump(exclude_unset=True).items() if k in ("signer_name", "signer_email")}
        _apply_co(db, user, p, c, data)
    _ready_to_send(c)
    if c.approver_email and not c.approved_at:
        db.flush()
        _claim_co(db, c, "draft", "awaiting_approval")
        cc.ask_approval(db, p, c)
        cc._activity(db, p, c, "approval_asked", _me(user), f"asked {c.approver_email} to approve {c.number}")
        return _finish(idem, db, user, cc.co_to_dict(c))
    db.flush()
    _claim_co(db, c, "draft", "sending")
    try:
        cc.send_for_signature(db, user, p, c)
    except RuntimeError as e:
        _claim_co(db, c, "sending", "draft")
        raise HTTPException(502, str(e))
    c = db.get(models.ConstructionChangeOrder, co_id)
    return _finish(idem, db, user, cc.co_to_dict(c))


class DecideBody(BaseModel):
    note: Optional[str] = ""


@router.post("/change-orders/{co_id}/approve")
def approve_change_order(co_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db),
                         idem: Idem = Depends(idempotency)):
    """The named internal approver approves: it goes to the owner or client."""
    hit = _replayed(idem, db, user)
    if hit is not None:
        return hit
    c, p = _co(db, co_id, user)
    if (c.approver_email or "").lower() != _me(user):
        raise HTTPException(403, "This change order is waiting on someone else.")
    if c.status != "awaiting_approval":
        raise HTTPException(409, "This change order is not waiting for approval.")
    if not _may_review(db, user, p) or not _may_see_cost(db, user, p):
        raise HTTPException(403, "Only a manager of this job who can see its money can approve it.")
    _claim_co(db, c, "awaiting_approval", "sending", approved_by=_me(user), approved_at=cc.now())
    cc._bell(db, p, c, c.approver_email, "Change Order Approved",
             f"You approved {c.number} {c.title} on {p.name}. It went to {c.signer_name} for signature.", done=True)
    cc._activity(db, p, c, "approved", _me(user), f"approved {c.number}")
    db.commit()
    try:
        cc.send_for_signature(db, user, p, c)
    except RuntimeError as e:
        _claim_co(db, c, "sending", "awaiting_approval", approved_by="", approved_at="")
        raise HTTPException(502, str(e))
    c = db.get(models.ConstructionChangeOrder, co_id)
    return _finish(idem, db, user, cc.co_to_dict(c))


@router.post("/change-orders/{co_id}/send-back")
def send_back_change_order(co_id: str, body: DecideBody, user: dict = Depends(get_current_user),
                           db: Session = Depends(get_db)):
    """The internal approver sends it back to Draft, with a note for its writer."""
    c, p = _co(db, co_id, user)
    if (c.approver_email or "").lower() != _me(user):
        raise HTTPException(403, "This change order is waiting on someone else.")
    if c.status != "awaiting_approval":
        raise HTTPException(409, "This change order is not waiting for approval.")
    note = (body.note or "").strip()[:500]
    if not note:
        raise HTTPException(422, "Say what should change before it is sent again.")
    c.status, c.decline_reason, c.modified_at = "draft", note, cc.now()
    c.approved_by, c.approved_at = "", ""
    cc._bell(db, p, c, c.approver_email, "Change Order Sent Back", f"You sent {c.number} back: {note}", done=True)
    if c.created_by:
        cc._bell(db, p, c, c.created_by, "Change Order Sent Back",
                 f"{c.number} {c.title} on {p.name} was sent back: {note}")
    cc._activity(db, p, c, "sent_back", _me(user), f"sent {c.number} back: {note}")
    db.commit()
    return cc.co_to_dict(c)


@router.post("/change-orders/{co_id}/void")
def void_change_order(co_id: str, body: DecideBody, user: dict = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    """Void a change order that is not signed (its open envelope is voided
    too). A signed one is never voided - write a credit change order."""
    c, p = _co(db, co_id, user)
    _pricer(db, user, p)
    if c.status == "signed":
        raise HTTPException(409, "A signed change order moved the contract - write a credit change order instead.")
    if c.status == "void":
        return cc.co_to_dict(c)
    reason = (body.note or "").strip()[:300] or "voided by the job manager"
    cc.void_envelope(db, c, _me(user), reason)
    c.status, c.modified_at = "void", cc.now()
    import construction_notify
    construction_notify.close_bells(db, ref_id=f"co:{c.id}", family=cc.CO_FAMILY, kind="change_order",
                                    title="Change Order Voided", body=f"{c.number} {c.title} on {p.name} was voided.")
    if c.field_ticket_id:
        t = cc.find_ticket(db, c.field_ticket_id)
        if t is not None and t.status == "priced":
            t.status, t.change_order_id = "signed", ""     # the ticket can be priced again
    cc._activity(db, p, c, "voided", _me(user), f"voided {c.number}: {reason}")
    db.commit()
    return cc.co_to_dict(c)


# ── Closeout ─────────────────────────────────────────────────────────────────

@router.get("/projects/{job_id}/closeout")
def job_closeout(job_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    import property_links
    p = _project(db, job_id, user)
    if not _may_read(db, user, p):
        raise HTTPException(403, "You do not have access to this job.")
    R = models.ConstructionCloseoutRecord
    recs = db.query(R).filter(R.project_id == p.id, R.deleted_at == "").order_by(R.created_at).all()
    prop = db.get(models.PropertyAsset, p.property_id) if p.property_id else None
    asset_write = False
    if prop is not None:
        try:
            from routers import property_assets as pa
            pa.require_asset_write(user=user, db=db)
            asset_write = True
        except HTTPException:
            asset_write = False
    items = {}
    ids = [r.item_id for r in recs if r.item_id]
    if ids:
        items = {i.id: i.name for i in db.query(models.Item).filter(models.Item.id.in_(ids)).all()}
    return {
        "checklist": cx.checklist(db, p),
        "records": [{**cx.record_to_dict(r), "itemName": items.get(r.item_id, "")} for r in recs],
        "closeout": dict(p.closeout or {}),
        "property": ({"id": prop.id, "name": property_links.display_name(prop), "canWrite": asset_write}
                     if prop is not None and property_links.viewable(prop, user) else None),
        "canAdd": _may_log(db, user, p), "canClose": _may_review(db, user, p),
        "kinds": list(cx.KINDS),
    }


class RecordBody(BaseModel):
    id: Optional[str] = None
    kind: Optional[str] = None
    title: Optional[str] = None
    item_id: Optional[str] = None
    serial: Optional[str] = None
    vendor: Optional[str] = None
    start_on: Optional[str] = None
    end_on: Optional[str] = None
    ahj: Optional[str] = None
    number: Optional[str] = None
    result: Optional[str] = None
    date_on: Optional[str] = None
    category: Optional[str] = None
    doc_url: Optional[str] = None
    doc_name: Optional[str] = None
    notes: Optional[str] = None


def _apply_record(db, user, p, r, data: dict) -> None:
    for k in ("start_on", "end_on", "date_on"):
        if data.get(k) and not _DAY.match(data[k]):
            raise HTTPException(422, "Dates must be full dates.")
    if data.get("result") is not None and data["result"] not in cx.RESULTS:
        raise HTTPException(422, "The result is Passed, Failed, Partial or Pending.")
    if data.get("category") is not None and data["category"] and data["category"] not in cx.DOC_CATEGORIES:
        raise HTTPException(422, "Pick the document's category.")
    if data.get("item_id"):
        import auth
        it = db.get(models.Item, data["item_id"])
        # An item of the caller's own companies (the Items wall).
        if it is None or (it.deleted_at or "") or not auth.company_ok(it.company_id or "", auth.company_scope(user, db)):
            raise HTTPException(422, "Pick an item from Items.")
    if data.get("doc_url") is not None:
        data["doc_url"] = _one_url(data["doc_url"], p.id)
    limits = {"title": 200, "serial": 80, "vendor": 200, "ahj": 200, "number": 80, "doc_name": 200, "notes": 2000}
    for k, v in data.items():
        if k in ("id", "kind") or v is None:
            continue
        setattr(r, k, v.strip()[:limits[k]] if k in limits and isinstance(v, str) else v)


@router.post("/projects/{job_id}/closeout/records", status_code=201)
def add_closeout_record(job_id: str, body: RecordBody, user: dict = Depends(get_current_user),
                        db: Session = Depends(get_db), idem: Idem = Depends(idempotency)):
    hit = _replayed(idem, db, user)
    if hit is not None:
        return hit
    p = _project(db, job_id, user)
    if not _may_log(db, user, p):
        raise HTTPException(403, "You are not on this job.")
    if body.kind not in cx.KINDS:
        raise HTTPException(422, "A record is a warranty, permit, inspection or document.")
    if not (body.title or "").strip() and not (body.number or "").strip():
        raise HTTPException(422, "Say what it is.")
    if body.kind == "warranty" and not body.end_on:
        raise HTTPException(422, "A warranty needs its end date.")
    R = models.ConstructionCloseoutRecord
    rid = (body.id or "").strip()
    if rid:
        if not _ID.match(rid):
            raise HTTPException(422, "A record id is 8 to 64 letters, digits, '.', '_', ':' or '-'.")
        was = db.get(R, rid)
        if was is not None:
            if was.project_id != p.id:
                raise HTTPException(409, "That record id is taken.")
            return cx.record_to_dict(was)
    r = R(id=rid or str(uuid.uuid4()), project_id=p.id, kind=body.kind, written={}, created_by=_me(user),
          created_at=cx.now(), modified_at=cx.now(), deleted_at="")
    _apply_record(db, user, p, r, body.model_dump(exclude_unset=True))
    db.add(r)
    _log_activity(db, project_id=p.id, entity_kind="closeout", entity_id=r.id, type="created",
                  actor_email=_me(user), detail=f"added a {r.kind} to the closeout")
    return _finish(idem, db, user, cx.record_to_dict(r), 201)


def _record(db, rid, user):
    r = db.get(models.ConstructionCloseoutRecord, rid)
    if r is None or r.deleted_at:
        raise HTTPException(404, "Record not found")
    p = _project(db, r.project_id, user)
    if not _may_log(db, user, p):
        raise HTTPException(403, "You are not on this job.")
    return r, p


@router.patch("/closeout/records/{record_id}")
def update_closeout_record(record_id: str, body: RecordBody, user: dict = Depends(get_current_user),
                           db: Session = Depends(get_db)):
    r, p = _record(db, record_id, user)
    if (r.written or {}).get("asset"):
        raise HTTPException(409, "This record is already in Asset Management - change it there.")
    _apply_record(db, user, p, r, body.model_dump(exclude_unset=True))
    r.modified_at = cx.now()
    db.commit()
    return cx.record_to_dict(r)


@router.delete("/closeout/records/{record_id}", status_code=204)
def remove_closeout_record(record_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Take a record off the closeout (kept, marked removed). One already in
    Asset Management stays there - it is that module's row now."""
    r, p = _record(db, record_id, user)
    if (r.written or {}).get("asset"):
        raise HTTPException(409, "This record is already in Asset Management - it stays there.")
    r.deleted_at = cx.now()
    db.commit()


class CloseBody(BaseModel):
    write_back: bool = True


@router.post("/projects/{job_id}/closeout")
def close_out(job_id: str, body: CloseBody = None, user: dict = Depends(get_current_user),
              db: Session = Depends(get_db)):
    """Close Out: write the records to Asset Management and Items (as the
    caller, through their own APIs), mark the job Complete and keep who and
    when. Again on a closed job = try the records that did not land."""
    p = _project(db, job_id, user)
    if not _may_review(db, user, p):
        raise HTTPException(403, "Only a job manager can close a job out.")
    recs = cx.write_back(db, user, p) if (body is None or body.write_back) else []
    p = db.get(models.ConstructionProject, p.id)
    state = dict(p.closeout or {})
    first = not state.get("closedOutAt")
    if first:
        state.update({"closedOutAt": cx.now(), "closedOutBy": _me(user)})
        p.closeout = state
        was = p.status or "active"
        p.status, p.modified_at = "complete", cx.now()
        p._nx_actor = _me(user)
        _log_activity(db, project_id=p.id, entity_kind="project", entity_id=p.id, type="closed_out",
                      actor_email=_me(user), detail=f"closed the job out ({len(recs)} record(s) handed over)")
        if was != "complete":
            from routers.construction import _emit
            _emit(db, "job.status_changed", p, user, changes={"status": (was, "complete")})
    db.commit()
    return {"closeout": dict(p.closeout or {}), "status": p.status,
            "records": [cx.record_to_dict(r) for r in recs]}


class SignoffBody(BaseModel):
    signer_name: str
    signer_email: str


@router.post("/projects/{job_id}/closeout/signoff")
def send_signoff(job_id: str, body: SignoffBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The owner's or client's sign-off on substantial completion, through
    Nexus Sign (one envelope; link_kind owner_signoff)."""
    p = _project(db, job_id, user)
    if not _may_review(db, user, p):
        raise HTTPException(403, "Only a job manager can send the sign-off.")
    name = " ".join((body.signer_name or "").split())[:120]
    em = (body.signer_email or "").strip().lower()
    if not name or not _EMAIL.match(em):
        raise HTTPException(422, "Name the owner or client who signs, with their email.")
    so = ((p.closeout or {}).get("signoff") or {})
    if so.get("status") in ("sent", "signed"):
        raise HTTPException(409, "The sign-off was already sent." if so["status"] == "sent" else "The owner already signed.")
    try:
        out = cx.send_signoff(db, user, p, name, em)
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    return {"signoff": out}
