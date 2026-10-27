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

Nexus chat triage 10/27/2026, item 15 (Charmi: "we did an update to a vendor
in Intacct and use the Sync option but it still did not update on Nexus"):
- An approved change no longer covers Intacct forever. Every read of the
  Intacct record checks it (`_check_rows`): once Intacct holds the approved
  value the request closes itself as "In Intacct" and the badge goes; when
  Intacct holds a third value (someone changed it there since) Intacct's
  value shows, with a note, and the request closes as "Changed In Intacct".
  Nothing else closes an approved change - it stays "Approved - Awaiting
  Intacct" until the CSV is imported by hand and the next read sees it.
- The accounting app reads vendors and customers changed in Intacct on
  every 30-minute run (it was once a day); the list says how fresh its copy
  is ("Intacct data as of", from the accounting app's sync-status).
- Export Approved CSV for vendors is Intacct's vendor import file
  (INTACCT_VENDOR_TEMPLATE), one row per vendor.
- Two-way sync (Charmi: "once the vendor is approved in Nexus, it should
  auto sync with Intacct") is NOT built: it needs Nexus to write to Intacct,
  which waits on Neil's decision to enable direct write. Nothing in this
  module calls Intacct at all; it reads the accounting app's copy.
"""
import asyncio
import csv
import io
import re
import time
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

import models
from auth import company_of, require_module_grant
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
_STATUSES = ("pending", "approved", "in_intacct", "intacct_changed", "declined")
# Approved and since seen in Intacct (item 15): still read for which change
# came last on a field, never laid over the record again.
_SEEN = ("in_intacct", "intacct_changed")
# The fields a request may change, in the order the export lists them.
FIELDS = ("displayName", "name", "email", "phone", "address.line1", "address.line2", "address.city", "address.state", "address.zip", "address.country", "terms", "status", "taxId")
# Approved vendors checked against Intacct per requests read or export.
_SETTLE_MAX = 200

# ── Intacct's vendor import file (item 15, 10/27/2026) ──────────────────────
# Charmi: "the CSV export is not exactly matching the Intacct template so we
# were not able to do the import". Sage Intacct's standard vendor import
# template, header names in the template's order, from Intacct's field list
# for it (Accounts Payable > Vendors > Import > Download template):
# https://www.intacct.com/ia/docs/en_US/help_action/More/Uploading_Data/AP/import-vendors.htm
# (the page lists VENDOR_ACCTNO twice; the template has it once). This is
# the ONE place the columns live: to use Charmi's own template, replace this
# tuple with its header row - the file follows its names and order.
INTACCT_VENDOR_TEMPLATE = (
    "DONOTIMPORT", "VENDOR_ID", "NAME", "PARENT_ID", "TERM_NAME", "VENDTYPE_NAME", "TAX_ID", "TAXGROUP", "CREDIT_LIMIT",
    "VENDOR_ACCTNO", "ACCT_LABEL", "GL_ACCTNO", "BILLING_TYPE", "DISC_ON_CKSTUB", "ONHOLD", "COMMENTS", "FORM1099TYPE",
    "FORM1099BOX", "NAME1099", "CURRENCY", "PAYMENTPRIORITY", "HIDEDISPLAYCONTACT", "ACTIVE",
    "CONTACT_NAME", "COMPANY_NAME", "MRMS", "FIRST_NAME", "MI", "LAST_NAME", "PRINT_AS", "TAXABLE",
    "PHONE1", "PHONE2", "CELLPHONE", "PAGER", "FAX", "EMAIL1", "EMAIL2", "URL1", "URL2",
    "ADDRESS1", "ADDRESS2", "CITY", "STATE", "ZIP", "COUNTRY", "LATITUDE", "LONGITUDE",
    *(f"{p}_{f}" for p in ("R", "P") for f in (
        "CONTACT_NAME", "COMPANY_NAME", "MRMS", "FIRST_NAME", "MI", "LAST_NAME", "PRINT_AS", "TAXABLE", "PHONE1", "PHONE2",
        "CELLPHONE", "PAGER", "FAX", "EMAIL1", "EMAIL2", "URL1", "URL2", "ADDRESS1", "ADDRESS2", "CITY", "STATE", "ZIP", "COUNTRY")),
    "APACCOUNT", "MERGE_PAYMENT_REQUESTS", "DEFAULT_LEAD_TIME", "BILLAPPROVERID",
)
# What Nexus fills, by template header, from the Intacct record with the
# approved changes laid on. ONLY these columns go in the file: Intacct's
# import updates an existing vendor (matched on VENDOR_ID) with every column
# it is given, and a blank cell CLEARS that field on the vendor (Intacct:
# "if you leave a field blank in the import file, the blank entry will
# overwrite any existing information"). So a column Nexus does not hold in
# full - vendor type, 1099, GL group, credit limit, the pay-to and return-to
# contacts, the tax ID (Nexus sees its last 4 only) - is left out rather
# than sent blank, and every column sent carries the vendor's whole current
# value, not just the changed field. CONTACT_NAME is how Intacct finds the
# vendor's contact (the phone, email and address are the contact's).
INTACCT_VENDOR_SOURCES = {
    "DONOTIMPORT": lambda r: "",
    "VENDOR_ID": lambda r: r["id"],
    "NAME": lambda r: r["name"],
    "TERM_NAME": lambda r: r["terms"],
    "ACTIVE": lambda r: "F" if str(r["status"]).strip().lower().startswith("inactive") else "T",
    "CONTACT_NAME": lambda r: r.get("contactName") or "",
    "PRINT_AS": lambda r: r["displayName"],
    "PHONE1": lambda r: r["phone"],
    "EMAIL1": lambda r: r["email"],
    "ADDRESS1": lambda r: r["address"]["line1"],
    "ADDRESS2": lambda r: r["address"]["line2"],
    "CITY": lambda r: r["address"]["city"],
    "STATE": lambda r: r["address"]["state"],
    "ZIP": lambda r: r["address"]["zip"],
    "COUNTRY": lambda r: r["address"]["country"],
}
# The request fields the file carries (a tax ID change is keyed by hand).
_IMPORT_FIELDS = {"name", "terms", "status", "displayName", "phone", "email", "address.line1", "address.line2",
                  "address.city", "address.state", "address.zip", "address.country"}


def intacct_vendor_columns() -> list[str]:
    """The import file's header row: the template's columns Nexus fills, in the template's order."""
    return [h for h in INTACCT_VENDOR_TEMPLATE if h in INTACCT_VENDOR_SOURCES]
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
    if acct._ACCT_FRESH.get():
        # A Sync also drops this kind's one-record reads, so Export Approved
        # CSV right after it reads each vendor fresh, not a copy up to 2 minutes old.
        kind_part = f"kind={clean.get('kind', '')}"
        for other in [c for c in _CACHE if c != key and kind_part in c.split("&")]:
            _CACHE.pop(other, None)
    hit = _CACHE.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < acct.fresh_ttl(_TTL):    # the list's Sync reads past the cache (10/23 meeting, item 13)
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
        "contactName": p.get("contactName") or p.get("contact_name") or "",
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


def _norm(field: str, value) -> str:
    """A value as compared with Intacct's: spaces collapsed, case ignored; a
    phone by its digits ("(949)745-3900" is "(949) 745-3900"); the tax ID by
    its last 4 (Intacct's is served masked)."""
    s = " ".join(str(value if value is not None else "").split())
    if field == "phone":
        return re.sub(r"\D", "", s)
    if field == "taxId":
        return re.sub(r"[^0-9A-Za-z]", "", s)[-4:].upper()
    return s.casefold()


def _field_state(field: str, fx: dict, intacct) -> str:
    """One approved field against what Intacct holds now: "match" (Intacct
    has the approved value), "changed" (Intacct has a third value - someone
    changed it there since the request; never said of the masked tax ID),
    else "awaiting" (Intacct still has the old value)."""
    now = _norm(field, intacct)
    if now == _norm(field, fx.get("to")):
        return "match"
    if field != "taxId" and now and now != _norm(field, fx.get("from")):
        return "changed"
    return "awaiting"


def _check_rows(rec: dict, rows: list) -> dict[str, dict[str, dict]]:
    """Each approved or seen row's fields against the Intacct record `rec`
    (as Intacct has it - before any overlay): {row id: {field: {"state",
    "intacct", "latest"}}}. A field a LATER approved change also sets takes
    that change's state - the latest ask on a field is the one Intacct must
    hold (V00045: the 11:12 phone was restyled by the 11:21 one)."""
    out: dict[str, dict[str, dict]] = {}
    latest: dict[str, str] = {}
    for ch in sorted(rows, key=lambda r: r.requested_at or "", reverse=True):
        fields: dict[str, dict] = {}
        for field, fx in (ch.changes or {}).items():
            if field not in FIELDS or not isinstance(fx, dict):
                continue
            cur = _get_field(rec, field)
            if field in latest:
                fields[field] = {"state": latest[field], "intacct": cur, "latest": False}
            else:
                st = _field_state(field, fx, cur)
                latest[field] = st
                fields[field] = {"state": st, "intacct": cur, "latest": True}
        out[ch.id] = fields
    return out


def _settled(fields: dict[str, dict]) -> str:
    """What an approved row becomes once every field is seen: "in_intacct",
    "intacct_changed", or "" while any field still waits for Intacct."""
    states = {f["state"] for f in fields.values()}
    if not states or "awaiting" in states:
        return ""
    return "intacct_changed" if "changed" in states else "in_intacct"


def _overlay(records: list[dict], db: Session, kind: str, check: bool = True) -> list[dict]:
    """Approved changes not yet in Intacct become the record's current values
    (badge "Awaiting Intacct"); a pending one is flagged so nobody files a
    second ask for the same record.

    `check` (records read from Intacct, not the ledger's names-only list):
    each approved change is checked against the record first (item 15). One
    Intacct already holds closes as "in_intacct"; a field Intacct changed to
    something else since shows Intacct's value with a note
    (`intacctChanged`), and a change made only of such fields closes as
    "intacct_changed". Only fields still waiting are laid over the record.
    Closing writes the request row in Nexus - never anything in Intacct."""
    ids = [r["id"] for r in records if r["id"]]
    if not ids:
        return records
    wanted = ("pending", "approved", *_SEEN) if check else ("pending", "approved")
    rows = (db.query(models.AccountingPartnerChange)
            .filter(models.AccountingPartnerChange.kind == kind, models.AccountingPartnerChange.partner_id.in_(ids),
                    models.AccountingPartnerChange.status.in_(wanted))
            .order_by(models.AccountingPartnerChange.requested_at.asc()).all())
    by_id: dict[str, list] = {}
    for r in rows:
        by_id.setdefault(r.partner_id, []).append(r)
    closed = False
    for rec in records:
        changes = by_id.get(rec["id"]) or []
        rec["awaitingIntacct"] = False
        rec["pendingChange"] = any(ch.status == "pending" for ch in changes)
        rec["intacctValues"] = {}
        rec["intacctChanged"] = {}
        live = [ch for ch in changes if ch.status != "pending"]
        checks = _check_rows(rec, live) if check else {}
        overlay: dict[str, str] = {}
        for ch in live:                                   # oldest first: a later change wins the field
            seen = checks.get(ch.id)
            if check and ch.status == "approved":
                to = _settled(seen or {})
                if to:
                    ch.status, ch.intacct_seen_at = to, _now()
                    ch.intacct_check = {f: {"state": v["state"], "intacct": v["intacct"]} for f, v in seen.items()}
                    closed = True
            for field, fx in (ch.changes or {}).items():
                if field not in FIELDS or not isinstance(fx, dict):
                    continue
                if not check:
                    if ch.status == "approved":
                        overlay[field] = fx.get("to", "")
                    continue
                f = (seen or {}).get(field) or {}
                if not f.get("latest"):
                    continue
                if f["state"] == "awaiting" and ch.status == "approved":
                    overlay[field] = fx.get("to", "")
                elif f["state"] == "changed" and ch.status in ("approved", "intacct_changed"):
                    rec["intacctChanged"][field] = {"intacct": f["intacct"], "approved": fx.get("to", ""), "approvedAt": ch.decided_at or ""}
        for field, value in overlay.items():
            rec["intacctValues"][field] = _get_field(rec, field)
            _set_field(rec, field, value)
            rec["awaitingIntacct"] = True
    if closed:
        db.commit()
    return records


async def _intacct_record(kind: str, pid: str) -> dict | None:
    """One partner as Intacct has it (no overlay), or None when the
    accounting app does not have it. The accounting app not serving records
    yet (501) is passed on."""
    raw = await _get({"kind": kind, "q": pid})
    found = next((p for p in raw if isinstance(p, dict) and str(p.get("id") or p.get("code") or "") == pid), None)
    if not found:
        return None
    rec = _record(found)
    rec["kind"] = rec["kind"] or kind
    return rec


async def _settle(db: Session, kinds: tuple[str, ...]) -> None:
    """Close the approved changes Intacct now holds before the requests list
    or the export is read (the same check the record list makes), so neither
    offers a change that is already in Intacct. Best effort: while the
    accounting app cannot serve the records nothing is closed."""
    def pairs():
        return (db.query(models.AccountingPartnerChange.kind, models.AccountingPartnerChange.partner_id)
                .filter(models.AccountingPartnerChange.status == "approved", models.AccountingPartnerChange.kind.in_(kinds))
                .distinct().limit(_SETTLE_MAX).all())
    for k, pid in await asyncio.to_thread(pairs):
        try:
            rec = await _intacct_record(k, pid)
        except Exception:  # noqa: BLE001 - the list and the export never fail on the check
            return
        if rec:
            await asyncio.to_thread(_overlay, [rec], db, k)


async def _intacct_as_of() -> str:
    """When the accounting app's vendor and customer copy last caught up with
    Intacct (ISO, UTC): its every-run read of changed records, else its daily
    refresh. "" when it cannot say. Tests replace this."""
    try:
        d = await acct._acct_get("/api/internal/sync-status", {})
    except Exception:  # noqa: BLE001 - a missing "as of" line never fails the list
        return ""
    return str(d.get("partners_synced_at") or d.get("last_dimensions_sync_at") or "")


async def _ledger_dimension(kind: str) -> list:
    """The vendor or customer codes on the ledger, with names and status
    (the Reports filter list). Tests replace this."""
    data = await acct._acct_get("/api/internal/reports/dimensions", {"kind": kind})
    return data.get("values") or data.get("rows") or []


async def _ledger_partners(kind: str, text: str, scope: dict, db: Session) -> dict:
    """Vendors or customers as the ledger knows them, when the accounting app
    does not serve the full Intacct record yet. The ledger keeps no entity
    against a vendor or customer, so - like the Reports filter list - the
    list is not open to a person limited to certain entities."""
    if scope["allowed"] is not None:
        raise HTTPException(status_code=403, detail="Your accounting access is limited to certain entities. The vendor and customer list covers every entity, so it is not available to you yet.")
    values = await _ledger_dimension(kind)
    needle = text.lower()
    records = []
    for v in values:
        if not isinstance(v, dict):
            continue
        code = str(v.get("code") or v.get("id") or "").strip()
        if not code:
            continue
        name = str(v.get("name") or "")
        if needle and needle not in code.lower() and needle not in name.lower():
            continue
        rec = _record({"id": code, "kind": kind, "name": name, "status": v.get("status") or ""})
        rec["lines"] = v.get("lines") if isinstance(v.get("lines"), int) else v.get("count")
        records.append(rec)
    records.sort(key=lambda r: (r["displayName"] or r["id"]).lower())
    return {"kind": kind, "source": "ledger", "partners": await asyncio.to_thread(_overlay, records, db, kind, False)}


@router.get("")
async def list_partners(kind: str = "vendor", q: str = "", scope: dict = Depends(entity_scope), db: Session = Depends(get_db)):
    """Vendors or customers as Intacct has them, searched by `q`, with the
    approved-but-not-yet-keyed changes shown as current values, and
    `intacctAsOf` - how fresh the accounting app's copy of Intacct is."""
    k = _kind(kind)
    text = (q or "").strip()[:120]
    try:
        raw = await _get({"kind": k, "q": text})
    except HTTPException as e:
        if e.status_code != 501:
            raise
        # Oct 14 (Neil: "Vendor and Customer, not working at all"): the
        # accounting app's partners route was reverted before it reached
        # production, so every read here was a 501 and the screen only said
        # "not available yet". Until it ships, the list is the ledger's own
        # vendor / customer codes (number, name, status) - read-only.
        return await _ledger_partners(k, text, scope, db)
    records = [_record(p) for p in raw if isinstance(p, dict)]
    for r in records:
        r["kind"] = r["kind"] or k
    if scope["allowed"] is not None:
        reach = await _with_children(scope["allowed"]) if scope["allowed"] else set()
        records = [r for r in records if not r["entity"] or r["entity"] in reach]
    partners = await asyncio.to_thread(_overlay, records, db, k)
    return {"kind": k, "source": "intacct", "intacctAsOf": await _intacct_as_of(), "partners": partners}


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
            "decidedBy": r.decided_by, "decidedByName": _display_name(r.decided_by, db) if r.decided_by else "", "decidedAt": r.decided_at, "note": r.note or "",
            "intacctSeenAt": r.intacct_seen_at or "", "intacctCheck": r.intacct_check or {}}


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


async def _visible_partners(scope: dict, kinds: tuple[str, ...]) -> set[tuple[str, str]] | None:
    """The (kind, partner id) pairs a change request may concern for this
    caller - the same reach list_partners gives: partners of their entities
    (and sub-entities) and partners with no entity. None = no limit (Neil's
    review, Oct 20: the requests list and export carried every entity's
    from/to values - tax ID, address, email - to any Accounting viewer).
    While the accounting app cannot serve the records (501) nothing is known
    about a partner's entity, so a limited caller sees none - the same
    answer the ledger fallback gives them."""
    if scope["allowed"] is None:
        return None
    reach = await _with_children(scope["allowed"]) if scope["allowed"] else set()
    out: set[tuple[str, str]] = set()
    for k in kinds:
        try:
            raw = await _get({"kind": k})
        except HTTPException as e:
            if e.status_code != 501:
                raise
            continue
        for p in raw:
            if not isinstance(p, dict):
                continue
            rec = _record(p)
            if rec["id"] and (not rec["entity"] or rec["entity"] in reach):
                out.add((rec["kind"] or k, rec["id"]))
    return out


def _within(rows: list, visible: set[tuple[str, str]] | None) -> list:
    if visible is None:
        return rows
    return [r for r in rows if (r.kind, r.partner_id) in visible]


@router.get("/changes")
async def list_changes(status: str = "", kind: str = "", scope: dict = Depends(entity_scope), db: Session = Depends(get_db)):
    """Change requests, newest first; `status` and `kind` narrow them. A
    caller limited to certain entities sees only the requests about partners
    within their reach. Approved ones Intacct now holds are closed first
    (item 15), so "Approved - Awaiting Intacct" means what it says."""
    if status and status not in _STATUSES:
        raise HTTPException(status_code=400, detail="status must be pending, approved, in_intacct, intacct_changed or declined")
    k = _kind(kind) if kind else ""
    await _settle(db, (k,) if k else _KINDS)
    visible = await _visible_partners(scope, (k,) if k else _KINDS)

    def _read() -> dict:
        q = db.query(models.AccountingPartnerChange)
        if status:
            q = q.filter(models.AccountingPartnerChange.status == status)
        if k:
            q = q.filter(models.AccountingPartnerChange.kind == k)
        q = q.order_by(models.AccountingPartnerChange.requested_at.desc())
        rows = q.limit(500).all() if visible is None else _within(q.all(), visible)[:500]
        return {"changes": [_out(r, db) for r in rows]}
    out = await asyncio.to_thread(_read)
    out["intacctAsOf"] = await _intacct_as_of()
    return out


# Two-int-form advisory lock namespace for "one pending request per record"
# (its own keyspace; daily_briefing and the others use different ones).
_PENDING_LOCK_NS = 517309284


def _lock_partner(db: Session, kind: str, pid: str) -> None:
    """Serialize creates for one record until this transaction ends, so two
    concurrent posts cannot both pass the one-pending-request check - a row
    lock alone cannot cover a row that does not exist yet. CAST as in
    daily_briefing._acquire_employee_lock. No-op on SQLite (one writer)."""
    if db.bind.dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(CAST(:ns AS integer), hashtext(:key))"),
                   {"ns": _PENDING_LOCK_NS, "key": f"{kind}:{pid}"})


@router.post("/changes", status_code=201)
async def create_change(body: ChangeRequestBody, scope: dict = Depends(entity_scope), db: Session = Depends(get_db)):
    """An edit becomes a request: only the fields that differ, each with the
    value Intacct has and the value asked for. One pending request per
    record at a time. A caller limited to certain entities may only ask
    about a partner within their reach (403 otherwise)."""
    user = scope["user"]
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
    visible = await _visible_partners(scope, (kind,))
    if visible is not None and (kind, pid) not in visible:
        raise HTTPException(status_code=403, detail="Your accounting access does not include this vendor or customer's entity.")

    def _write() -> dict:
        _lock_partner(db, kind, pid)
        open_row = (db.query(models.AccountingPartnerChange)
                    .filter(models.AccountingPartnerChange.kind == kind, models.AccountingPartnerChange.partner_id == pid,
                            models.AccountingPartnerChange.status == "pending").with_for_update().first())
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
            _notify(db, type="acct_partner_change", recipient=em, title=f"{label} Change to Approve: {row.partner_name or pid}",
                    body=f"{who} asked to change {fields}. Approve or decline it under Accounting > Vendors & Customers.",
                    ref_id=row.id, requested_by=user["email"])
        db.commit()
        return _out(row, db)
    return await asyncio.to_thread(_write)


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
        title = f"{label} Change Approved: {row.partner_name or row.partner_id}"
        body = f"{who} approved it. It shows as the record's current values until it is keyed into Intacct."
    else:
        title = f"{label} Change Declined: {row.partner_name or row.partner_id}"
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
async def export_changes(status: str = Query("approved"), kind: str = "", format: str = Query("review"),
                         scope: dict = Depends(entity_scope), db: Session = Depends(get_db)):
    """`format=review`: the changes as a CSV, one row per field, with who
    asked and who decided. Dates are MM/DD/YYYY. `format=intacct`: the
    approved vendor changes as Intacct's vendor import file
    (`_intacct_vendor_csv`). Held to the caller's entity reach, like the
    list."""
    if status not in _STATUSES:
        raise HTTPException(status_code=400, detail="status must be pending, approved, in_intacct, intacct_changed or declined")
    if format not in ("review", "intacct"):
        raise HTTPException(status_code=400, detail="format must be review or intacct")
    k = _kind(kind) if kind else ""
    await _settle(db, (k,) if k else _KINDS)
    visible = await _visible_partners(scope, (k,) if k else _KINDS)
    if format == "intacct":
        if k != "vendor" or status != "approved":
            raise HTTPException(status_code=400, detail="The Intacct import file is for approved vendor changes. Customer changes export as the change list until Intacct's customer template is set up.")
        return await _intacct_vendor_csv(db, visible)
    return await asyncio.to_thread(_export_csv, db, status, k, visible)


async def _intacct_vendor_csv(db: Session, visible: set[tuple[str, str]] | None) -> StreamingResponse:
    """Approved vendor changes still waiting for Intacct as Intacct's vendor
    import file (INTACCT_VENDOR_TEMPLATE / INTACCT_VENDOR_SOURCES): one row
    per vendor, every column carrying the vendor's whole value - Intacct's
    record with the waiting changes laid on - so the import changes what was
    approved and blanks nothing. Changed-in-Intacct fields keep Intacct's
    value. A vendor whose approved changes are only to the tax ID is not in
    the file (Nexus sees its last 4 only - keyed by hand). Refused (409)
    when a record cannot be read whole: a guessed or blank cell would
    overwrite Intacct. Nothing is sent to Intacct; the file is imported by
    hand (Accounts Payable > Vendors > Import), and each change closes as
    "In Intacct" once the next sync shows it there."""
    def waiting() -> list:
        q = (db.query(models.AccountingPartnerChange)
             .filter(models.AccountingPartnerChange.kind == "vendor", models.AccountingPartnerChange.status == "approved")
             .order_by(models.AccountingPartnerChange.decided_at.asc()))
        return _within(q.all(), visible)
    rows = await asyncio.to_thread(waiting)
    pids = list(dict.fromkeys(r.partner_id for r in rows if _IMPORT_FIELDS & set((r.changes or {}).keys())))
    records, missing = [], []
    for pid in pids:
        try:
            rec = await _intacct_record("vendor", pid)
        except HTTPException as e:
            if e.status_code == 501:
                raise HTTPException(status_code=409, detail="The Intacct import file needs each vendor's full Intacct record, which the accounting app does not serve yet.")
            raise
        if rec is None:
            missing.append(pid)
        else:
            records.append(rec)
    if missing:
        raise HTTPException(status_code=409, detail=f"Could not read the Intacct record of {', '.join(missing)}. The import file needs each vendor's current values so nothing in Intacct is blanked - press Sync and try again.")
    records = await asyncio.to_thread(_overlay, records, db, "vendor")
    records = [r for r in records if r.get("awaitingIntacct")]
    no_contact = [r["id"] for r in records if not r.get("contactName")]
    if no_contact:
        raise HTTPException(status_code=409, detail=f"Intacct's contact name for {', '.join(no_contact)} has not reached Nexus yet, and Intacct's import needs it to update the phone, email and address. It arrives with the accounting app's next vendor sync.")
    columns = intacct_vendor_columns()
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(columns)
    for r in sorted(records, key=lambda x: x["id"]):
        w.writerow([INTACCT_VENDOR_SOURCES[c](r) for c in columns])
    fname = f"intacct-vendor-import-{datetime.now(timezone.utc).strftime('%Y%m%d')}.csv"
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv", headers={"Content-Disposition": f"attachment; filename={fname}"})


def _export_csv(db: Session, status: str, kind: str, visible: set[tuple[str, str]] | None) -> StreamingResponse:
    q = db.query(models.AccountingPartnerChange).filter(models.AccountingPartnerChange.status == status)
    if kind:
        q = q.filter(models.AccountingPartnerChange.kind == kind)
    rows = _within(q.order_by(models.AccountingPartnerChange.decided_at.asc(), models.AccountingPartnerChange.requested_at.asc()).all(), visible)

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


# ── One vendor or customer, drilled into (Charmi, 10/16) ───────────────────

_ACTIVITY_LINES = 25


def _history(db: Session, kind: str, pid: str) -> list[dict]:
    rows = (db.query(models.AccountingPartnerChange)
            .filter(models.AccountingPartnerChange.kind == kind, models.AccountingPartnerChange.partner_id == pid)
            .order_by(models.AccountingPartnerChange.requested_at.desc()).limit(200).all())
    return [_out(r, db) for r in rows]


def _activity_line(r: dict) -> dict:
    return {"lineId": str(r.get("line_id") or ""), "entryId": r.get("entry_id") or "", "entryNo": r.get("entry_no") or "",
            "date": str(r.get("entry_date") or "")[:10], "entity": r.get("location") or "", "entityName": r.get("location_name") or "",
            "account": str(r.get("gl_code") or ""), "accountName": r.get("account_name") or "",
            "memo": r.get("memo") or r.get("description") or "", "debit": r.get("debit") or 0, "credit": r.get("credit") or 0}


async def _activity(kind: str, pid: str, scope: dict) -> dict:
    """The record's ledger lines, every date, held to the caller's entities:
    how many, the totals, the entities and accounts they post to, and the
    latest few lines. Read through the accounting app's search, never the
    accounting database."""
    location, locations = await acct._limit(scope, None, None)
    d = await acct._acct_get("/api/internal/search", {
        "q": None, "location": location, "locations": locations, "from": None, "to": datetime.now(timezone.utc).date().isoformat(),
        "party_kind": kind, "party": pid, "offset": 0, "limit": _ACTIVITY_LINES})
    facets = d.get("facets") or {}

    def pick(key: str) -> list[dict]:
        return [{"code": f.get("code") or "", "name": f.get("name") or "", "lines": f.get("lines") or 0, "net": f.get("net") or 0}
                for f in (facets.get(key) or []) if isinstance(f, dict)]
    return {"total": int(d.get("total") or 0), "debit": d.get("debit") or 0, "credit": d.get("credit") or 0,
            "entities": pick("entities"), "accounts": pick("accounts"),
            "lines": [_activity_line(r) for r in (d.get("rows") or []) if isinstance(r, dict)]}


@router.get("/record/{kind}/{partner_id}")
async def partner_record(kind: str, partner_id: str, scope: dict = Depends(entity_scope), db: Session = Depends(get_db)):
    """One vendor or customer (Charmi, 10/16: "drill down into a vendor - still
    can't"): its fields as the list has them (approved changes overlaid), its
    entity and status, every change request filed on it, and its ledger
    activity. Read-only. Held to the same entity limit as the list: a record
    of another entity is a 404, and the ledger-only list stays closed to a
    person limited to certain entities."""
    k = _kind(kind)
    pid = (partner_id or "").strip()[:60]
    if not pid:
        raise HTTPException(status_code=400, detail="Which vendor or customer?")
    source = "intacct"
    try:
        raw = await _get({"kind": k, "q": pid})
        found = next((p for p in raw if isinstance(p, dict) and str(p.get("id") or p.get("code") or "") == pid), None)
        rec = _record(found) if found else None
        if rec and scope["allowed"] is not None:
            reach = await _with_children(scope["allowed"]) if scope["allowed"] else set()
            if rec["entity"] and rec["entity"] not in reach:
                rec = None
    except HTTPException as e:
        if e.status_code != 501:
            raise
        source = "ledger"
        if scope["allowed"] is not None:
            raise HTTPException(status_code=403, detail="Your accounting access is limited to certain entities. The vendor and customer list covers every entity, so it is not available to you yet.")
        values = await _ledger_dimension(k)
        v = next((x for x in values if isinstance(x, dict) and str(x.get("code") or x.get("id") or "").strip() == pid), None)
        rec = _record({"id": pid, "kind": k, "name": str(v.get("name") or ""), "status": v.get("status") or ""}) if v else None
        if rec:
            rec["lines"] = v.get("lines") if isinstance(v.get("lines"), int) else v.get("count")
    if not rec:
        raise HTTPException(status_code=404, detail=f"No {k} {pid} on the records you can read.")
    rec["kind"] = rec["kind"] or k

    def work():
        return _overlay([rec], db, k, source == "intacct")[0], _history(db, k, pid)
    rec, history = await asyncio.to_thread(work)
    activity, activity_error = None, ""
    try:
        activity = await _activity(k, pid, scope)
    except HTTPException as e:
        activity_error = str(e.detail)
    return {"kind": k, "source": source, "record": rec, "history": history, "activity": activity, "activityError": activity_error}
