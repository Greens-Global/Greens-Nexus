"""PFS Affiliated Entities and the co-borrower's executive profile (Charmi, 10/04).

Affiliated Entities: "list all entities that are joint and several between the
2 borrowers - the banker wants ownership and beneficial ownership interest in
all entities: single member LLC, partnerships, multi-member LLC, corporations,
trusts, etc." One row per entity, kept per statement file (a pfs_profiles row,
which holds both borrowers of a joint statement): the entity's name and type,
the last four digits of its EIN (never more - a longer number is refused), its
state, each borrower's ownership percent, the beneficial ownership percent,
the borrowers' role in it and a note. Rows keep the order they are put in.

Executive profile per borrower: "Executive profile should be there for both
borrowers". The borrower's stays where it always was (pfs_profiles.
executive_profile, saved with the History tab); the co-borrower's is its own
row in pfs_profile_extras, saved on its own.

Both ride along in every statement the server computes (`attach`, called by
routers/pfs.py `_statement`), so a statement kept on record prints them
exactly as they were, in the PDF and the Excel workbook alike.

Same door as routers/pfs.py: owners and explicit "pfs" grants only, and the
per-file lock (routers/pfs_access.file_gate) on every route.
"""
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
from auth import require_module_grant
from database import SessionLocal, get_db
from routers.pfs_access import file_gate

_read = require_module_grant("pfs", "viewer", bypass_level="owner")
_edit = require_module_grant("pfs", "editor", bypass_level="owner")

router = APIRouter(prefix="/pfs", tags=["Personal Financial Statements - affiliated entities"],
                   dependencies=[Depends(_read), Depends(file_gate)])

ENTITY_TYPES = [
    ("single_member_llc", "Single-Member LLC"),
    ("multi_member_llc", "Multi-Member LLC"),
    ("general_partnership", "General Partnership"),
    ("limited_partnership", "Limited Partnership"),
    ("c_corporation", "C Corporation"),
    ("s_corporation", "S Corporation"),
    ("trust", "Trust"),
    ("other", "Other"),
]
ROLES = ["Member", "Manager", "Managing Member", "Partner", "General Partner", "Limited Partner", "Shareholder",
         "Officer", "Trustee", "Beneficiary"]
_TYPE_LABEL = dict(ENTITY_TYPES)
MAX_ROWS = 200


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _profile(db: Session, profile_id: str) -> models.PfsProfile:
    p = db.query(models.PfsProfile).filter(models.PfsProfile.id == profile_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Profile not found.")
    return p


def borrowers(p: models.PfsProfile) -> list[dict]:
    """The borrowers of a statement file: the borrower, and the co-borrower
    (or spouse) when there is one. Their keys are what ownership is stored by."""
    d = p.details if isinstance(p.details, dict) else {}
    co = d.get("coBorrower") if isinstance(d.get("coBorrower"), dict) else {}
    out = [{"key": "primary", "name": p.name or "Borrower"}]
    co_name = (co.get("name") or d.get("spouse") or "").strip()
    if co_name or p.kind == "joint":
        out.append({"key": "co", "name": co_name or "Co-Borrower"})
    return out


def _audit(db: Session, user: dict, action: str, profile_id: str, details: Optional[dict] = None) -> None:
    import json
    db.add(models.AuditLog(timestamp=_now(), user_email=user["email"], user_role=user.get("role", ""), action=action,
                           resource_type="pfs", resource_id=profile_id, details=json.dumps(details or {})))


def _pct(v, what: str) -> Optional[float]:
    if v in (None, ""):
        return None
    try:
        n = round(float(v), 4)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{what} must be a percent.")
    if not 0 <= n <= 100:
        raise HTTPException(status_code=400, detail=f"{what} is a percent between 0 and 100.")
    return n


def _out(a: models.PfsAffiliate) -> dict:
    return {"id": a.id, "name": a.name or "", "entityType": a.entity_type or "other",
            "entityTypeLabel": _TYPE_LABEL.get(a.entity_type or "", "Other"), "einLast4": a.ein_last4 or "",
            "state": a.state or "", "ownership": a.ownership if isinstance(a.ownership, dict) else {},
            "beneficialPct": a.beneficial_pct, "role": a.role or "", "notes": a.notes or "",
            "ledgerEntity": a.ledger_entity or "", "sort": a.sort or 0, "updatedBy": a.updated_by or "", "updatedAt": a.updated_at or ""}


class AffiliateBody(BaseModel):
    name: str
    entityType: Optional[str] = "other"
    einLast4: Optional[str] = ""
    state: Optional[str] = ""
    ownership: Optional[dict[str, Any]] = None
    beneficialPct: Optional[Any] = None
    role: Optional[str] = ""
    notes: Optional[str] = ""
    ledgerEntity: Optional[str] = ""


def _clean(body: AffiliateBody) -> dict:
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Give the entity a name.")
    etype = body.entityType if body.entityType in _TYPE_LABEL else "other"
    digits = re.sub(r"\D", "", body.einLast4 or "")
    if len(digits) > 4:
        # Never a full EIN, even by accident: refused, not trimmed.
        raise HTTPException(status_code=400, detail="Enter only the last four digits of the EIN.")
    ownership = {}
    for k, v in (body.ownership or {}).items():
        if k in ("primary", "co"):
            n = _pct(v, "Ownership")
            if n is not None:
                ownership[k] = n
    role = (body.role or "").strip()
    return {"name": name[:160], "entity_type": etype, "ein_last4": digits, "state": (body.state or "").strip()[:40],
            "ownership": ownership, "beneficial_pct": _pct(body.beneficialPct, "Beneficial ownership"),
            "role": role[:60], "notes": (body.notes or "").strip()[:400], "ledger_entity": (body.ledgerEntity or "").strip()[:40]}


def _rows(db: Session, profile_id: str) -> list[models.PfsAffiliate]:
    return (db.query(models.PfsAffiliate).filter(models.PfsAffiliate.profile_id == profile_id)
            .order_by(models.PfsAffiliate.sort, models.PfsAffiliate.name).all())


def _co_text(db: Session, profile_id: str) -> str:
    x = db.query(models.PfsProfileExtra).filter(models.PfsProfileExtra.profile_id == profile_id).first()
    return (x.co_executive_profile or "") if x else ""


# ── Affiliated entities ──────────────────────────────────────────────────────
@router.get("/affiliates/meta")
def affiliates_meta():
    return {"entityTypes": [{"key": k, "label": v} for k, v in ENTITY_TYPES], "roles": ROLES}


@router.get("/profiles/{profile_id}/affiliates")
def list_affiliates(profile_id: str, db: Session = Depends(get_db)):
    p = _profile(db, profile_id)
    return {"borrowers": borrowers(p), "rows": [_out(a) for a in _rows(db, profile_id)]}


@router.post("/profiles/{profile_id}/affiliates", status_code=201)
def add_affiliate(profile_id: str, body: AffiliateBody, user: dict = Depends(_edit), db: Session = Depends(get_db)):
    _profile(db, profile_id)
    have = _rows(db, profile_id)
    if len(have) >= MAX_ROWS:
        raise HTTPException(status_code=400, detail="That is the most entities one statement can list.")
    a = models.PfsAffiliate(id=str(uuid.uuid4()), profile_id=profile_id, sort=(max([r.sort or 0 for r in have], default=0) + 1),
                            updated_by=user["email"], updated_at=_now(), **_clean(body))
    db.add(a)
    _audit(db, user, "pfs_affiliate_added", profile_id, {"affiliate": a.id, "name": a.name})
    db.commit()
    db.refresh(a)
    return _out(a)


def _get(db: Session, profile_id: str, affiliate_id: str) -> models.PfsAffiliate:
    a = db.query(models.PfsAffiliate).filter(models.PfsAffiliate.id == affiliate_id, models.PfsAffiliate.profile_id == profile_id).first()
    if not a:
        raise HTTPException(status_code=404, detail="Entity not found.")
    return a


@router.put("/profiles/{profile_id}/affiliates/{affiliate_id}")
def update_affiliate(profile_id: str, affiliate_id: str, body: AffiliateBody, user: dict = Depends(_edit), db: Session = Depends(get_db)):
    a = _get(db, profile_id, affiliate_id)
    for k, v in _clean(body).items():
        setattr(a, k, v)
    a.updated_by, a.updated_at = user["email"], _now()
    _audit(db, user, "pfs_affiliate_changed", profile_id, {"affiliate": a.id, "name": a.name})
    db.commit()
    db.refresh(a)
    return _out(a)


@router.delete("/profiles/{profile_id}/affiliates/{affiliate_id}", status_code=204)
def delete_affiliate(profile_id: str, affiliate_id: str, user: dict = Depends(_edit), db: Session = Depends(get_db)):
    a = _get(db, profile_id, affiliate_id)
    _audit(db, user, "pfs_affiliate_removed", profile_id, {"affiliate": a.id, "name": a.name})
    db.delete(a)
    db.commit()


class OrderBody(BaseModel):
    ids: list[str]


@router.put("/profiles/{profile_id}/affiliates-order")
def reorder_affiliates(profile_id: str, body: OrderBody, user: dict = Depends(_edit), db: Session = Depends(get_db)):
    """The rows in the order given; rows not named keep their place after them."""
    rows = {a.id: a for a in _rows(db, profile_id)}
    order = [i for i in body.ids if i in rows] + [i for i in rows if i not in body.ids]
    for n, i in enumerate(order, start=1):
        rows[i].sort = n
    _audit(db, user, "pfs_affiliates_reordered", profile_id, {"count": len(order)})
    db.commit()
    return {"rows": [_out(rows[i]) for i in order]}


# ── Executive profile per borrower ───────────────────────────────────────────
@router.get("/profiles/{profile_id}/executive-profiles")
def executive_profiles(profile_id: str, db: Session = Depends(get_db)):
    p = _profile(db, profile_id)
    return {"profiles": _exec_profiles(p, _co_text(db, profile_id))}


def _exec_profiles(p: models.PfsProfile, co_text: str) -> list[dict]:
    out = []
    for b in borrowers(p):
        out.append({**b, "text": (p.executive_profile or "") if b["key"] == "primary" else co_text})
    return out


class ExecBody(BaseModel):
    key: str            # primary | co
    text: str


@router.put("/profiles/{profile_id}/executive-profiles")
def save_executive_profile(profile_id: str, body: ExecBody, user: dict = Depends(_edit), db: Session = Depends(get_db)):
    """One borrower's executive profile, saved on its own."""
    p = _profile(db, profile_id)
    text = (body.text or "")[:6000]
    if body.key == "primary":
        p.executive_profile = text
        p.updated_by, p.updated_at = user["email"], _now()
    elif body.key == "co":
        x = db.query(models.PfsProfileExtra).filter(models.PfsProfileExtra.profile_id == profile_id).first()
        if not x:
            x = models.PfsProfileExtra(profile_id=profile_id)
            db.add(x)
        x.co_executive_profile, x.updated_by, x.updated_at = text, user["email"], _now()
    else:
        raise HTTPException(status_code=400, detail="key must be primary or co")
    _audit(db, user, "pfs_executive_profile_changed", profile_id, {"borrower": body.key})
    db.commit()
    return {"profiles": _exec_profiles(p, _co_text(db, profile_id))}


def forget(db: Session, profile_id: str) -> None:
    """A deleted file takes its affiliated entities and co-borrower profile
    with it (the caller commits). The access log is kept."""
    db.query(models.PfsAffiliate).filter(models.PfsAffiliate.profile_id == profile_id).delete(synchronize_session=False)
    db.query(models.PfsProfileExtra).filter(models.PfsProfileExtra.profile_id == profile_id).delete(synchronize_session=False)


# ── Into every statement ─────────────────────────────────────────────────────
def attach(profile_id: str, payload: dict) -> dict:
    """The statement payload with the affiliated entities and every borrower's
    executive profile added (sync: routers/pfs.py runs it in a thread)."""
    db = SessionLocal()
    try:
        p = db.query(models.PfsProfile).filter(models.PfsProfile.id == profile_id).first()
        if not p:
            return payload
        payload["affiliated"] = {"borrowers": borrowers(p), "rows": [_out(a) for a in _rows(db, profile_id)]}
        payload["executiveProfiles"] = _exec_profiles(p, _co_text(db, profile_id))
        return payload
    finally:
        db.close()
