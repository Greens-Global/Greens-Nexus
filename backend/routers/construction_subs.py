"""Subs on a job, and their papers (Round Two item 7, Neil, 11/05/2026:
"make sure the vendor stuff is fully integrated with Intacct and the
accounting module so we are not reduplicating").

The vendor is Intacct's. Putting a sub on a job looks the VENDORID up
through routers/accounting_partners (the accounting app's copy of Intacct)
and keeps a ConstructionJobLink (kind 'sub', ref_id the VENDORID, note the
trade) - the same link table the job's tickets and equipment use. The
papers are vendor_compliance.py's one row per vendor, shown on the job's
Subs tab and on the vendor's record under Accounting > Vendors & Customers
(Compliance tab) - one row, two doors.

Reach: reading a job's subs is reading the job (_may_read); putting one on
or taking one off is the job's managers (_may_review); the papers may be
saved by a job's managers, a manager-tier person, or anyone with the
Accounting grant (the person who collects certificates is as often in
accounting as in the field). The vendor search is open to anyone who may
review a job - names and ids only, never the contact details.
"""
from __future__ import annotations

import asyncio
import re
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import auth
import construction_company
import models
import vendor_compliance as vc
from auth import get_current_user
from database import get_db
from routers import accounting_partners
from routers.construction import _DAY, _log_activity, _may_read, _may_review, _me, _project, now_iso

router = APIRouter(prefix="/construction", tags=["Construction"],
                   dependencies=[Depends(get_current_user)])

_TRADE_MAX = 80
_NOTES_MAX = 1000


async def _vendor(vendor_id: str) -> dict | None:
    """Intacct's vendor, by id, through the accounting app (501 / 503 pass
    through: the screen says the accounting app is not available)."""
    raw = await accounting_partners._get({"kind": "vendor", "q": vendor_id})
    for p in raw:
        if isinstance(p, dict) and str(p.get("id") or p.get("code") or "") == vendor_id:
            return accounting_partners._record(p)
    return None


def _may_keep(db: Session, user: dict, vendor_id: str) -> bool:
    if int(user.get("level") or 0) >= auth._LEVELS["manager"]:
        return True
    if auth._module_level(_me(user), "accounting", db) >= auth._MODULE_LEVEL_RANK["viewer"]:
        return True
    L = models.ConstructionJobLink
    for lk in db.query(L).filter(L.kind == "sub", L.ref_id == vendor_id, L.ended_at == "").all():
        p = db.get(models.ConstructionProject, lk.project_id)
        if p is not None and not p.deleted_at and _may_review(db, user, p):
            return True
    return False


# ── Vendors, for the picker ──────────────────────────────────────────────────

@router.get("/vendors")
async def search_vendors(q: str = "", job_id: str = "", user: dict = Depends(get_current_user),
                         db: Session = Depends(get_db)):
    """Intacct's vendors matching `q`, for the Add Sub picker on `job_id`:
    id, name and whether Intacct has them active. Nothing else."""
    p = _project(db, job_id, user)
    if not _may_review(db, user, p):
        raise HTTPException(403, "Only a job manager picks the subs.")
    text = (q or "").strip()[:120]
    if not text:
        return {"vendors": []}
    raw = await accounting_partners._get({"kind": "vendor", "q": text})
    out = []
    for r in (accounting_partners._record(x) for x in raw if isinstance(x, dict)):
        if r["id"]:
            out.append({"id": r["id"], "name": r["displayName"] or r["name"] or r["id"],
                        "inactive": str(r["status"]).strip().lower().startswith("inactive")})
    return {"vendors": out[:25]}


# ── The client (Round Three item 2, Neil, 11/11/2026) ───────────────────────
# Who the job is built for is one of Intacct's CUSTOMERS, read through the
# same accounting_partners read the vendors use - names and ids for the
# picker, Intacct's contact copied as the default signer. Nothing is written
# to Intacct. A job's managers set it (Edit Job). The database work runs in
# a thread (sync dependency / asyncio.to_thread): only the accounting call
# is awaited on the event loop.

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


async def _customer(customer_id: str) -> dict | None:
    raw = await accounting_partners._get({"kind": "customer", "q": customer_id})
    for c in raw:
        if isinstance(c, dict) and str(c.get("id") or c.get("code") or "") == customer_id:
            return accounting_partners._record(c)
    return None


def _review_ctx(job_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """The job's managers who may also open its Money (review, 11/11/2026):
    the customer list carries Intacct's contacts, so it takes the same gate
    as Accounting > Vendors & Customers - a manager with Accounting access."""
    import construction_money
    p = _project(db, job_id, user)                  # 404 behind the wall
    if not _may_review(db, user, p):
        raise HTTPException(403, "Only a job manager sets the client.")
    why = construction_money.money_gate(db, user, p)
    if why:
        raise HTTPException(403, why)
    return {"p": p, "db": db, "user": user}


@router.get("/projects/{job_id}/customers")
async def search_customers(q: str = "", ctx: dict = Depends(_review_ctx)):
    """Intacct's customers matching `q`, for the Client picker on Edit Job:
    id, name, active, and the contact Intacct holds (prefills who signs)."""
    text = (q or "").strip()[:120]
    if not text:
        return {"customers": []}
    raw = await accounting_partners._get({"kind": "customer", "q": text})
    out = []
    for r in (accounting_partners._record(x) for x in raw if isinstance(x, dict)):
        if r["id"]:
            out.append({"id": r["id"], "name": r["displayName"] or r["name"] or r["id"],
                        "inactive": str(r["status"]).strip().lower().startswith("inactive"),
                        "contactName": r["contactName"], "contactEmail": r["email"]})
    return {"customers": out[:25]}


class ClientIn(BaseModel):
    client_id: Optional[str] = ""
    contact_name: Optional[str] = None
    contact_email: Optional[str] = None


def _save_client(ctx: dict, cid: str, name: str, contact_name: str, contact_email: str) -> dict:
    db, p, me = ctx["db"], ctx["p"], _me(ctx["user"])
    before = {"clientId": p.client_id or "", "clientName": p.client_name or "",
              "contactName": p.client_contact_name or "", "contactEmail": p.client_contact_email or ""}
    p.client_id, p.client_name = cid, name
    p.client_contact_name, p.client_contact_email = contact_name, contact_email
    after = {"clientId": cid, "clientName": name, "contactName": contact_name, "contactEmail": contact_email}
    if after != before:
        p.modified_at = now_iso()
        db.add(models.ConstructionActivity(
            id=str(uuid.uuid4()), project_id=p.id, entity_kind="project", entity_id=p.id, type="client_set",
            actor_email=me, at=now_iso(),
            detail=(f"set the client to {name} ({cid})" if cid else "cleared the client")[:500],
            before=before, after=after))
    db.commit()
    return {"ok": True, **after}


@router.put("/projects/{job_id}/client")
async def set_client(body: ClientIn, ctx: dict = Depends(_review_ctx)):
    """Set (or clear, with an empty id) the job's client: an Intacct customer
    by id - refused when Intacct does not know it - and who signs for them.
    With no contact given, Intacct's customer contact is copied."""
    cid = (body.client_id or "").strip()[:60]
    if not cid:
        return await asyncio.to_thread(_save_client, ctx, "", "", "", "")
    c = await _customer(cid)
    if c is None:
        raise HTTPException(422, f"Customer {cid} is not on the Intacct customer list.")
    name = (c["displayName"] or c["name"] or cid)[:200]
    contact_name = " ".join((body.contact_name if body.contact_name is not None else c["contactName"] or "").split())[:120]
    contact_email = (body.contact_email if body.contact_email is not None else c["email"] or "").strip().lower()[:200]
    if contact_email and not _EMAIL.match(contact_email):
        raise HTTPException(422, f"{contact_email!r} is not an email address")
    return await asyncio.to_thread(_save_client, ctx, cid, name, contact_name, contact_email)


# ── A job's subs ─────────────────────────────────────────────────────────────

def _subs_out(db: Session, p, user: dict) -> dict:
    today = construction_company.local_today(db, p)
    links = vc.live_subs(db, [p.id])
    rows = {r.vendor_id: r for r in db.query(models.VendorCompliance)
            .filter(models.VendorCompliance.vendor_id.in_([lk.ref_id for lk in links] or [""])).all()}
    subs = []
    for lk in sorted(links, key=lambda x: ((rows.get(x.ref_id).vendor_name if rows.get(x.ref_id) else x.ref_id) or "").lower()):
        c = vc.to_dict(rows.get(lk.ref_id), today, lk.ref_id)
        subs.append({"linkId": lk.id, "vendorId": lk.ref_id, "name": c["vendorName"] or lk.ref_id,
                     "trade": lk.note or "", "since": lk.created_at or "", "compliance": c})
    return {"subs": subs, "canEdit": _may_review(db, user, p), "today": today.isoformat()}


@router.get("/projects/{job_id}/subs")
def job_subs(job_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    p = _project(db, job_id, user)
    if not _may_read(db, user, p):
        raise HTTPException(403, "You do not have access to this job.")
    return _subs_out(db, p, user)


class SubIn(BaseModel):
    vendor_id: str
    trade: Optional[str] = ""


@router.post("/projects/{job_id}/subs", status_code=201)
async def add_sub(job_id: str, body: SubIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Put one of Intacct's vendors on the job. The same vendor twice is the
    one link; a vendor Intacct does not know is refused."""
    p = _project(db, job_id, user)
    if not _may_review(db, user, p):
        raise HTTPException(403, "Only a job manager adds a sub.")
    vid = (body.vendor_id or "").strip()[:60]
    if not vid:
        raise HTTPException(422, "Pick a vendor.")
    trade = (body.trade or "").strip()[:_TRADE_MAX]
    v = await _vendor(vid)
    if v is None:
        raise HTTPException(422, f"Vendor {vid} is not on the Intacct vendor list.")
    row = db.get(models.VendorCompliance, vid)
    if row is None:
        row = models.VendorCompliance(vendor_id=vid, updated_at=now_iso(), updated_by=_me(user))
        db.add(row)
    row.vendor_name = v["displayName"] or v["name"] or vid
    L = models.ConstructionJobLink
    lk = db.query(L).filter(L.kind == "sub", L.ref_id == vid, L.project_id == p.id, L.ended_at == "").first()
    if lk is None:
        lk = L(id=str(uuid.uuid4()), project_id=p.id, kind="sub", ref_id=vid, created_by=_me(user),
               created_at=now_iso(), ended_at="", note=trade)
        db.add(lk)
        _log_activity(db, project_id=p.id, entity_kind="project", entity_id=p.id, type="sub_added",
                      actor_email=_me(user), detail=f"{row.vendor_name}{' - ' + trade if trade else ''} on the job")
    elif trade:
        lk.note = trade
    db.commit()
    return _subs_out(db, p, user)


@router.post("/sub-links/{link_id}/end")
def end_sub(link_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    lk = db.get(models.ConstructionJobLink, link_id)
    if lk is None or lk.kind != "sub":
        raise HTTPException(404, "Not found")
    p = _project(db, lk.project_id, user)
    if not _may_review(db, user, p):
        raise HTTPException(403, "Only a job manager takes a sub off.")
    if not lk.ended_at:
        lk.ended_at = now_iso()
        _log_activity(db, project_id=p.id, entity_kind="project", entity_id=p.id, type="sub_ended",
                      actor_email=_me(user), detail=f"{lk.ref_id} off the job")
        db.commit()
    return {"ok": True}


# ── The papers ───────────────────────────────────────────────────────────────

class ComplianceIn(BaseModel):
    coi_expires_on: Optional[str] = None
    wc_expires_on: Optional[str] = None
    license_number: Optional[str] = None
    license_expires_on: Optional[str] = None
    w9_on_file: Optional[bool] = None
    notes: Optional[str] = None


@router.get("/vendors/{vendor_id}/compliance")
def get_compliance(vendor_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    vid = (vendor_id or "").strip()[:60]
    if not _may_keep(db, user, vid):
        raise HTTPException(403, "You do not keep this vendor's papers.")
    row = db.get(models.VendorCompliance, vid)
    today = construction_company.local_today(db, None)
    return {"compliance": vc.to_dict(row, today, vid), "canEdit": True, "today": today.isoformat()}


@router.put("/vendors/{vendor_id}/compliance")
async def save_compliance(vendor_id: str, body: ComplianceIn, user: dict = Depends(get_current_user),
                          db: Session = Depends(get_db)):
    vid = (vendor_id or "").strip()[:60]
    if not _may_keep(db, user, vid):
        raise HTTPException(403, "You do not keep this vendor's papers.")
    for f in vc.FIELDS:
        v = getattr(body, f)
        if v is not None and v != "" and not _DAY.match(v):
            raise HTTPException(422, f"{vc.LABEL[f]} needs a date.")
    row = db.get(models.VendorCompliance, vid)
    if row is None:
        v = await _vendor(vid)
        if v is None:
            raise HTTPException(422, f"Vendor {vid} is not on the Intacct vendor list.")
        row = models.VendorCompliance(vendor_id=vid, vendor_name=v["displayName"] or v["name"] or vid)
        db.add(row)
    for f in ("coi_expires_on", "wc_expires_on", "license_expires_on"):
        if getattr(body, f) is not None:
            setattr(row, f, getattr(body, f).strip())
    if body.license_number is not None:
        row.license_number = body.license_number.strip()[:60]
    if body.w9_on_file is not None:
        row.w9_on_file = bool(body.w9_on_file)
    if body.notes is not None:
        row.notes = body.notes.strip()[:_NOTES_MAX]
    row.updated_by = _me(user)
    row.updated_at = now_iso()
    db.commit()
    today = construction_company.local_today(db, None)
    return {"compliance": vc.to_dict(row, today, vid), "canEdit": True, "today": today.isoformat()}
