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
