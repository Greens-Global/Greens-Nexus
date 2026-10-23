"""Accounting -> Reports -> Audit & Insights -> Manual Journal Entries (Neil
and Charmi, 22 Oct call, CR-10: "I want Charmi to be able to audit anything
that was done manual ... If it was an auto entry, it's already set by the
rules.").

Only the journal entries a PERSON keyed: Intacct's journal entry header
(GLBATCH) names who created it and who last changed it (CREATEDBY /
MODIFIEDBY, record numbers turned into login IDs through USERINFO). Neither
the Nexus Accounting ledger copy nor its sync keeps them, so they are read
from Intacct itself, READ ONLY (intacct_client.read_entry_audit), for the
range asked, and kept for a few minutes.

An entry is manual when (accounting_assumptions MANUAL_JE_*):
  - it is a General Ledger entry (MODULE), and
  - its creator is a person - not "system", not the Web Services user - and
    no source / rule field on it says rule, bank feed, recurring ...
    ("created"), or
  - a person changed it after a system user created it ("edited" - team
    answer, 23 Oct: a system entry later edited by a person counts).

Filters: dates, entities (an entity brings its sub-entities), journals and
user (created or changed by). A person limited to certain entities sees an
entry only when every line is in their entities. With Intacct not set up on
the server the answer is {available: false, reason} - never a 500.
"""
import asyncio
import os
import time
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

import accounting_assumptions as assume
import intacct_client
from auth import require_module_grant
from routers import accounting
from routers.accounting import entity_scope

router = APIRouter(prefix="/accounting/manual-entries", tags=["Accounting"], dependencies=[Depends(require_module_grant("accounting", "viewer"))])

_CACHE: dict = {}


def _excluded() -> set:
    out = {u.lower() for u in assume.MANUAL_JE_EXCLUDED_USERS}
    api_user = (os.environ.get("INTACCT_USER_ID") or "").strip().lower()
    if assume.MANUAL_JE_API_USER_IS_SYSTEM and api_user:
        out.add(api_user)
    return out


def is_person(login: str, excluded: Optional[set] = None) -> bool:
    login = str(login or "").strip().lower()
    return bool(login) and login not in (_excluded() if excluded is None else excluded)


def by_rule(entry: dict) -> bool:
    """A source / rule field on the header names an automatic source."""
    words = assume.MANUAL_JE_EXCLUDED_SOURCES
    return any(w in str(v).lower() for v in (entry.get("sourceFields") or {}).values() for w in words)


def classify(entry: dict, excluded: Optional[set] = None) -> Optional[str]:
    """'created' (a person keyed it), 'edited' (a system entry a person then
    changed) or None (not a manual entry)."""
    excluded = _excluded() if excluded is None else excluded
    if str(entry.get("module") or "").strip() not in assume.MANUAL_JE_MODULES:
        return None
    if is_person(entry.get("createdBy"), excluded) and not by_rule(entry):
        return "created"
    if assume.MANUAL_JE_EDITED_COUNTS and is_person(entry.get("modifiedBy"), excluded):
        return "edited"
    return None


def _read(from_: str, to: str, journals: tuple) -> dict:
    """Intacct's answer for one range (cached), every manual entry kept."""
    key = (from_, to, journals)
    hit = _CACHE.get(key)
    if hit and time.time() - hit[0] < assume.MANUAL_JE_CACHE_SECONDS:
        return hit[1]
    excluded = _excluded()
    seen = {"scanned": 0, "withCreator": 0}

    def keep(h: dict) -> bool:
        seen["scanned"] += 1
        if str(h.get("createdBy") or "").strip():
            seen["withCreator"] += 1
        kind = classify(h, excluded)
        h["kind"] = kind
        return kind is not None

    data = intacct_client.read_entry_audit(from_, to, list(journals), keep=keep)
    out = {"entries": data["entries"], **seen}
    _CACHE[key] = (time.time(), out)
    return out


def _iso(v: str, name: str) -> date:
    try:
        return date.fromisoformat(v)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{name} must be a date (YYYY-MM-DD).") from None


def _csv(v: Optional[str]) -> list:
    return [x.strip() for x in (v or "").split(",") if x.strip()]


@router.get("")
async def manual_entries(
    from_: str = Query(alias="from"), to: str = Query(...), locations: Optional[str] = None, journals: Optional[str] = None,
    user: Optional[str] = None, edited: bool = True, scope: dict = Depends(entity_scope),
):
    lo, hi = _iso(from_, "from"), _iso(to, "to")
    if hi < lo:
        raise HTTPException(status_code=400, detail="The range ends before it starts.")
    if (hi - lo).days + 1 > assume.MANUAL_JE_MAX_DAYS:
        raise HTTPException(status_code=400, detail=f"Pick at most {assume.MANUAL_JE_MAX_DAYS} days - Intacct is read live.")
    if not intacct_client.configured():
        return {"available": False, "reason": "Intacct is not connected on this server, so who keyed each entry cannot be read.", "entries": []}
    syms = tuple(sorted({s.upper() for s in _csv(journals)}))
    try:
        data = await asyncio.to_thread(_read, lo.isoformat(), hi.isoformat(), syms)
    except intacct_client.IntacctError as e:
        raise HTTPException(status_code=424, detail=str(e)) from None
    reach = None if scope["allowed"] is None else (await accounting._with_children(scope["allowed"]) if scope["allowed"] else set())
    wanted = await accounting._with_children(set(_csv(locations))) if _csv(locations) else None
    who = (user or "").strip().lower()
    rows = []
    for e in data["entries"]:
        locs = set(e.get("locations") or [])
        if reach is not None and (not locs or not locs <= reach):
            continue
        if wanted is not None and not (locs & wanted):
            continue
        if not edited and e.get("kind") == "edited":
            continue
        if who and who not in (str(e.get("createdBy") or "").lower(), str(e.get("modifiedBy") or "").lower()):
            continue
        rows.append({k: e.get(k) for k in ("recordNo", "batchNo", "journal", "date", "title", "state", "amount", "locations",
                                          "createdBy", "modifiedBy", "whenCreated", "whenModified", "kind")})
    rows.sort(key=lambda r: (r["date"] or "", str(r["batchNo"] or "")), reverse=True)
    users = sorted({u for r in rows for u in (r["createdBy"], r["modifiedBy"]) if is_person(u)}, key=str.lower)
    note = ""
    if data["scanned"] and not data["withCreator"]:
        note = "Intacct returned no creator on these entries (CREATEDBY), so none could be called manual. The Web Services user may need permission to read it."
    return {"available": True, "from": lo.isoformat(), "to": hi.isoformat(), "entries": rows, "users": users,
            "scanned": data["scanned"], "excludedUsers": sorted(_excluded()), "note": note}
