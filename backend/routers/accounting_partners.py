"""Accounting > Vendors & Customers (Charmi and Neil, 10/01: "edit a vendor,
change all the details and get pushed to manager for approval").

The records are Intacct's, read through the accounting app's
/api/internal/partners (contract V1) - the same proxy shape as
routers/accounting.py, with every read held to the caller's entity limit
(a limited person sees the partners of their entities and those with no
entity). Nexus keeps only the CHANGE REQUESTS (accounting_partner_changes):
an edit on the screen becomes a pending row with {field: {from, to}}; a
manager who holds the Accounting grant (or anyone at the Full level on it)
approves or declines it, and the requester gets a bell either way. An
approved change shows on the record as its current values with an
"Awaiting Intacct" badge, and the CSV of approved changes is what gets
keyed into Intacct - Intacct stays the source of truth, one way; nothing is
written back.

Until the accounting app ships the partners route it answers 404; that is
passed on as 501 so the screen can say "not available yet". The requests
list and export work regardless.
"""
import asyncio
import csv
import io
import time
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
from auth import company_of, get_current_user, require_module_grant
from database import get_db
from routers import accounting as acct
from routers.accounting import _display_name, _with_children, entity_scope

router = APIRouter(
    prefix="/accounting/partners",
    tags=["Accounting"],
    dependencies=[Depends(require_module_grant("accounting", "viewer"))],
)

_PATH = "/api/internal/partners"
_NOT_READY = "Not available yet - the accounting app needs its update."
_KINDS = ("vendor", "customer")
_STATUSES = ("pending", "approved", "declined")
# The fields a request may change, in the order the export lists them.
FIELDS = ("displayName", "name", "email", "phone", "address.line1", "address.line2", "address.city", "address.state", "address.zip", "address.country", "terms", "status", "taxId")
_CACHE: dict[str, tuple[float, list]] = {}
_TTL = 120.0
_NOTE_MAX = 1000
_VALUE_MAX = 300

# Deciding a request: a manager with the grant, or the Full level on it.
_decide = require_module_grant("accounting", "full", bypass_level="manager")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _kind(v: str) -> str:
    k = (v or "vendor").strip().lower()
    if k not in _KINDS:
        raise HTTPException(status_code=400, detail="kind must be vendor or customer")
    return k


# ── The records, from the accounting app ─────────────────────────────────────

def _get_sync(params: dict) -> list:
    r = httpx.get(f"{acct._ACCT_BASE}{_PATH}", params=params, headers={"x-internal-api-key": acct._ACCT_KEY}, timeout=30)
    if r.status_code == 404:
        raise HTTPException(status_code=501, detail=_NOT_READY)
    if r.status_code != 200:
        raise HTTPException(status_code=424, detail=acct._upstream_detail(r))
    data = r.json()
    if isinstance(data, dict):
        if not data.get("ok", True):
            raise HTTPException(status_code=424, detail=data.get("error") or "Accounting service error")
        data = data.get("partners") or data.get("rows") or data.get("items") or []
    return data if isinstance(data, list) else []


async def _get(params: dict) -> list:
    """Tests replace this. Short cache per kind and search."""
    if not acct._ACCT_BASE or not acct._ACCT_KEY:
        raise HTTPException(status_code=503, detail="Accounting service is not configured (ACCOUNTING_BASE_URL / ACCOUNTING_INTERNAL_KEY)")
    clean = {k: v for k, v in params.items() if v not in (None, "")}
    key = "&".join(f"{k}={v}" for k, v in sorted(clean.items()))
    hit = _CACHE.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < _TTL:
        return hit[1]
    data = await asyncio.to_thread(_get_sync, clean)
    _CACHE[key] = (now, data)
    return data


def _record(p: dict) -> dict:
    """One partner in the shape the screen reads (V1, camelCase)."""
    addr = p.get("address") or {}
    if not isinstance(addr, dict):
        addr = {}
    return {
        "id": str(p.get("id") or p.get("code") or ""),
        "kind": p.get("kind") or "",
        "name": p.get("name") or "",
        "displayName": p.get("displayName") or p.get("display_name") or p.get("name") or "",
        "taxId": p.get("taxId") or p.get("tax_id") or "",
        "email": p.get("email") or "",
        "phone": p.get("phone") or "",
        "address": {k: addr.get(k) or "" for k in ("line1", "line2", "city", "state", "zip", "country")},
        "terms": p.get("terms") or "",
        "status": p.get("status") or "",
        "entity": p.get("entity") or "",
        "updatedAt": p.get("updatedAt") or p.get("updated_at") or "",
    }


def _set_field(rec: dict, field: str, value) -> None:
    if field.startswith("address."):
        rec["address"][field[8:]] = value
    else:
        rec[field] = value


def _get_field(rec: dict, field: str):
    if field.startswith("address."):
        return (rec.get("address") or {}).get(field[8:], "")
    return rec.get(field, "")


def _overlay(records: list[dict], db: Session, kind: str) -> list[dict]:
    """Approved changes not yet in Intacct become the record's current values
    (badge "Awaiting Intacct"); a pending one is flagged so nobody files a
    second ask for the same record."""
    ids = [r["id"] for r in records if r["id"]]
    if not ids:
        return records
    rows = (db.query(models.AccountingPartnerChange)
            .filter(models.AccountingPartnerChange.kind == kind, models.AccountingPartnerChange.partner_id.in_(ids),
                    models.AccountingPartnerChange.status.in_(("pending", "approved")))
            .order_by(models.AccountingPartnerChange.requested_at.asc()).all())
    by_id: dict[str, list] = {}
    for r in rows:
        by_id.setdefault(r.partner_id, []).append(r)
    for rec in records:
        changes = by_id.get(rec["id"]) or []
        rec["awaitingIntacct"] = False
        rec["pendingChange"] = False
        rec["intacctValues"] = {}
        for ch in changes:
            if ch.status == "pending":
                rec["pendingChange"] = True
                continue
            for field, fx in (ch.changes or {}).items():
                if field not in FIELDS or not isinstance(fx, dict):
                    continue
                rec["intacctValues"].setdefault(field, _get_field(rec, field))
                _set_field(rec, field, fx.get("to", ""))
                rec["awaitingIntacct"] = True
    return records


@router.get("")
async def list_partners(kind: str = "vendor", q: str = "", scope: dict = Depends(entity_scope), db: Session = Depends(get_db)):
    """Vendors or customers as Intacct has them, searched by `q`, with the
    approved-but-not-yet-keyed changes shown as current values."""
    k = _kind(kind)
    raw = await _get({"kind": k, "q": (q or "").strip()[:120]})
    records = [_record(p) for p in raw if isinstance(p, dict)]
    for r in records:
        r["kind"] = r["kind"] or k
    if scope["allowed"] is not None:
        reach = await _with_children(scope["allowed"]) if scope["allowed"] else set()
        records = [r for r in records if not r["entity"] or r["entity"] in reach]
    return {"kind": k, "partners": await asyncio.to_thread(_overlay, records, db, k)}


# ── Change requests ──────────────────────────────────────────────────────────

class ChangeRequestBody(BaseModel):
    kind: str
    partnerId: str
    partnerName: str = ""
    changes: dict[str, dict]
    note: str = ""


class DecisionBody(BaseModel):
    note: str = ""


def _out(r: models.AccountingPartnerChange, db: Session) -> dict:
    return {"id": r.id, "kind": r.kind, "partnerId": r.partner_id, "partnerName": r.partner_name, "changes": r.changes or {},
            "status": r.status, "requestedBy": r.requested_by, "requestedByName": _display_name(r.requested_by, db), "requestedAt": r.requested_at,
            "decidedBy": r.decided_by, "decidedByName": _display_name(r.decided_by, db) if r.decided_by else "", "decidedAt": r.decided_at, "note": r.note or ""}


def _notify(db: Session, *, type: str, recipient: str, title: str, body: str, ref_id: str, requested_by: str) -> None:
    db.add(models.NexusNotification(
        id=str(uuid.uuid4()), type=type, recipient=(recipient or "").lower(), title=title, body=body, ref_id=ref_id,
        item_name="", requested_by=requested_by, action="", actioned=False, read_by="",
        company=company_of(recipient or requested_by, db), created_at=_now(),
    ))


def _deciders(db: Session) -> list[str]:
    """Who gets the bell for a new request: everyone at the Full level on the
    Accounting grant, plus managers who hold it at all (the same people
    `_decide` admits), administrators and owners left out."""
    from auth import _MODULE_LEVEL_RANK
    rows = (db.query(models.NexusGroupMember.email, models.NexusGroup.allowed_modules)
            .join(models.NexusGroup, models.NexusGroup.id == models.NexusGroupMember.group_id)
            .filter(models.NexusGroup.allowed_modules.like("%accounting%")).all())
    level: dict[str, int] = {}
    for email, modules in rows:
        for part in (modules or "").split(","):
            mid, _, lvl = part.strip().partition(":")
            if mid == "accounting" and email:
                level[email.lower()] = max(level.get(email.lower(), 0), _MODULE_LEVEL_RANK.get(lvl, 1))
    if not level:
        return []
    managers = {e.lower() for (e,) in db.query(models.NexusRole.email).filter(models.NexusRole.role == "manager").all() if e}
    full = _MODULE_LEVEL_RANK["full"]
    return sorted(e for e, lvl in level.items() if lvl >= full or e in managers)


@router.get("/changes")
def list_changes(status: str = "", kind: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Change requests, newest first; `status` and `kind` narrow them."""
    q = db.query(models.AccountingPartnerChange)
    if status:
        if status not in _STATUSES:
            raise HTTPException(status_code=400, detail="status must be pending, approved or declined")
        q = q.filter(models.AccountingPartnerChange.status == status)
    if kind:
        q = q.filter(models.AccountingPartnerChange.kind == _kind(kind))
    rows = q.order_by(models.AccountingPartnerChange.requested_at.desc()).limit(500).all()
    return {"changes": [_out(r, db) for r in rows]}


@router.post("/changes", status_code=201)
def create_change(body: ChangeRequestBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """An edit becomes a request: only the fields that differ, each with the
    value Intacct has and the value asked for. One pending request per
    record at a time."""
    kind = _kind(body.kind)
    pid = (body.partnerId or "").strip()[:60]
    if not pid:
        raise HTTPException(status_code=400, detail="Which vendor or customer?")
    changes = {}
    for field, fx in (body.changes or {}).items():
        if field not in FIELDS or not isinstance(fx, dict):
            continue
        frm = str(fx.get("from") if fx.get("from") is not None else "")[:_VALUE_MAX]
        to = str(fx.get("to") if fx.get("to") is not None else "")[:_VALUE_MAX]
        if frm.strip() != to.strip():
            changes[field] = {"from": frm, "to": to}
    if not changes:
        raise HTTPException(status_code=400, detail="Nothing changed.")
    open_row = (db.query(models.AccountingPartnerChange)
                .filter(models.AccountingPartnerChange.kind == kind, models.AccountingPartnerChange.partner_id == pid,
                        models.AccountingPartnerChange.status == "pending").first())
    if open_row:
        raise HTTPException(status_code=409, detail="A change for this record is already waiting for approval.")
    row = models.AccountingPartnerChange(
        id=str(uuid.uuid4()), kind=kind, partner_id=pid, partner_name=(body.partnerName or "").strip()[:200], changes=changes,
        status="pending", requested_by=user["email"], requested_at=_now(), note=(body.note or "").strip()[:_NOTE_MAX],
    )
    db.add(row)
    who = _display_name(user["email"], db)
    label = "Vendor" if kind == "vendor" else "Customer"
    fields = ", ".join(changes.keys())
    for em in _deciders(db):
        if em == user["email"].lower():
            continue
        _notify(db, type="acct_partner_change", recipient=em, title=f"{label} change to approve: {row.partner_name or pid}",
                body=f"{who} asked to change {fields}. Approve or decline it under Accounting > Vendors & Customers.",
                ref_id=row.id, requested_by=user["email"])
    db.commit()
    return _out(row, db)


def _decide_row(db: Session, change_id: str, status: str, note: str, user: dict) -> dict:
    row = db.query(models.AccountingPartnerChange).filter(models.AccountingPartnerChange.id == change_id).with_for_update().first()
    if not row:
        raise HTTPException(status_code=404, detail="That request is gone.")
    if row.status != "pending":
        raise HTTPException(status_code=409, detail=f"Already {row.status}.")
    row.status, row.decided_by, row.decided_at = status, user["email"], _now()
    if note:
        row.note = ((row.note + "\n") if row.note else "") + f"Decision: {note[:_NOTE_MAX]}"
    who = _display_name(user["email"], db)
    label = "Vendor" if row.kind == "vendor" else "Customer"
    if status == "approved":
        title = f"{label} change approved: {row.partner_name or row.partner_id}"
        body = f"{who} approved it. It shows as the record's current values until it is keyed into Intacct."
    else:
        title = f"{label} change declined: {row.partner_name or row.partner_id}"
        body = f"{who} declined it." + (f" Note: {note[:300]}" if note else "")
    if row.requested_by and row.requested_by.lower() != user["email"].lower():
        _notify(db, type="acct_partner_decision", recipient=row.requested_by, title=title, body=body, ref_id=row.id, requested_by=user["email"])
    db.commit()
    return _out(row, db)


@router.post("/changes/{change_id}/approve")
def approve_change(change_id: str, body: DecisionBody, user: dict = Depends(_decide), db: Session = Depends(get_db)):
    return _decide_row(db, change_id, "approved", (body.note or "").strip(), user)


@router.post("/changes/{change_id}/decline")
def decline_change(change_id: str, body: DecisionBody, user: dict = Depends(_decide), db: Session = Depends(get_db)):
    return _decide_row(db, change_id, "declined", (body.note or "").strip(), user)


@router.get("/changes/export.csv")
def export_changes(status: str = Query("approved"), kind: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The approved changes as a CSV, one row per field, for keying into
    Intacct. Dates are MM/DD/YYYY."""
    if status not in _STATUSES:
        raise HTTPException(status_code=400, detail="status must be pending, approved or declined")
    q = db.query(models.AccountingPartnerChange).filter(models.AccountingPartnerChange.status == status)
    if kind:
        q = q.filter(models.AccountingPartnerChange.kind == _kind(kind))
    rows = q.order_by(models.AccountingPartnerChange.decided_at.asc(), models.AccountingPartnerChange.requested_at.asc()).all()

    def _mdy(iso: str) -> str:
        s = (iso or "")[:10]
        return f"{s[5:7]}/{s[8:10]}/{s[0:4]}" if len(s) == 10 else ""

    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(["Kind", "Intacct ID", "Name", "Field", "Intacct Value", "New Value", "Requested By", "Requested On", "Decided By", "Decided On", "Status", "Note"])
    for r in rows:
        for field in FIELDS:
            fx = (r.changes or {}).get(field)
            if not isinstance(fx, dict):
                continue
            w.writerow([r.kind, r.partner_id, r.partner_name, field, fx.get("from", ""), fx.get("to", ""),
                        _display_name(r.requested_by, db), _mdy(r.requested_at), _display_name(r.decided_by, db) if r.decided_by else "",
                        _mdy(r.decided_at), r.status, (r.note or "").replace("\n", " ")])
    fname = f"partner-changes-{status}{('-' + kind) if kind else ''}-{datetime.now(timezone.utc).strftime('%Y%m%d')}.csv"
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv", headers={"Content-Disposition": f"attachment; filename={fname}"})
