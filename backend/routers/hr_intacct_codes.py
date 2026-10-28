"""People > Sync Employee Codes From Intacct (Charmi, Oct 21 2026).

"All the employee codes need to be updated based on the Intacct employee
codes. We want to avoid manual if there is an option."

Nexus hands out GG-001 style codes when a person is added (hr._next_code);
payroll and the ledger know people by their Intacct EMPLOYEEID. This screen
lines the two up:

  - The Intacct employees are read straight from Intacct by Nexus's own
    read-only Web Services client (intacct_client.py, INTACCT_* settings) -
    EMPLOYEEID, name, email, status, location. When those settings are not
    on this server the screen falls back to the employee codes on the
    accounting app's ledger (/reports/dimensions?kind=employee, code and name
    only, same proxy rules as routers/accounting.py), which can only ever
    match by name.
  - Matching: work email first; else the exact name (a "Last, First" print
    name is turned around), narrowed by company when several people share a
    name. Never fuzzy. Two people claiming one Intacct ID, one Intacct
    employee matching several people, or a code already held by somebody
    else are CONFLICTS - shown, never applied.
  - HR applies the rows it ticks. The server rebuilds the preview at apply
    time and only writes a row whose Intacct code is still what HR saw.
  - Nightly sync (per company, OFF by default) applies only work-email
    matches whose Nexus code is empty or was last written by this sync - a
    code anybody typed in Nexus is never replaced without HR seeing it here.

Every change is an AuditLog row (who / when / old / new) on top of the
field-level audit_capture row the ORM write produces anyway.

State lives in one NexusSetting row (`intacct_employee_codes`): the per-company
nightly switch, the code this sync last wrote per person and the last nightly
run. No new table, no new column.
"""
from __future__ import annotations

import asyncio
import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import intacct_client
import models
from auth import hr_scope, is_team_scope, require_module_grant
from database import get_db
from routers import accounting as acct
import job_switch

router = APIRouter(prefix="/hr/intacct-codes", tags=["hr"])

# People editors only (the HR grant at editor, or an administrator). A manager
# who sees their own team in People is turned away below.
require_hr_write = require_module_grant("hr", "editor")

SETTINGS_KEY = "intacct_employee_codes"
LEDGER_PATH = "/api/internal/reports/dimensions"
SYNC_ACTOR = "intacct-employee-sync"
# The nightly pass runs once a day after this UTC hour (9 UTC = 1-2 AM Pacific).
NIGHTLY_HOUR_UTC = 9
TICK_SEC = 30 * 60

ACTIONS = ("update", "keep", "no_match", "conflict")


SOURCE_LABELS = {"intacct": "Intacct (direct)", "ledger": "Ledger codes, names only"}


class IntacctUnavailable(Exception):
    """Neither Intacct nor the ledger could give us the employee list. The message is
    shown to HR as is; nothing is changed when this is raised."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Settings (one NexusSetting row) ──────────────────────────────────────────

def load_state(db: Session) -> dict:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTINGS_KEY).first()
    saved = {}
    if row and row.value:
        try:
            saved = json.loads(row.value) or {}
        except (TypeError, ValueError):
            saved = {}
    return {
        "nightly": {str(k): bool(v) for k, v in (saved.get("nightly") or {}).items()},
        "synced": {str(k): str(v) for k, v in (saved.get("synced") or {}).items()},
        "lastRun": saved.get("lastRun") or {},
    }


def save_state(db: Session, state: dict, by: str) -> None:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTINGS_KEY).first()
    if not row:
        row = models.NexusSetting(key=SETTINGS_KEY)
        db.add(row)
    row.value = json.dumps({"nightly": state.get("nightly") or {}, "synced": state.get("synced") or {},
                            "lastRun": state.get("lastRun") or {}})
    row.updated_by = by
    row.updated_at = _now()


# ── The Intacct employees: Intacct direct, else the ledger ───────────────────

def _http_get(path: str, params: dict):
    if not acct._ACCT_BASE or not acct._ACCT_KEY:
        raise IntacctUnavailable("Intacct is not configured on this server (the INTACCT_* settings), and neither is "
                                 "the accounting service (ACCOUNTING_BASE_URL / ACCOUNTING_INTERNAL_KEY), so no "
                                 "employee codes can be read. Nothing was changed.")
    try:
        return httpx.get(f"{acct._ACCT_BASE}{path}", params=params,
                         headers={"x-internal-api-key": acct._ACCT_KEY}, timeout=30)
    except httpx.HTTPError as e:
        raise IntacctUnavailable(f"Could not reach the accounting service ({type(e).__name__}). "
                                 "Nothing was changed - try again in a few minutes.") from e


def _json_body(r) -> dict:
    try:
        data = r.json()
    except ValueError as e:
        raise IntacctUnavailable("The accounting service answered with something that is not JSON. Nothing was changed.") from e
    if isinstance(data, list):
        return {"ok": True, "rows": data}
    if not isinstance(data, dict):
        return {}
    if data.get("ok") is False:
        raise IntacctUnavailable(f"Accounting service: {data.get('error') or 'error'}. Nothing was changed.")
    return data


def _norm_record(p: dict) -> dict:
    first = str(p.get("firstName") or p.get("first_name") or "").strip()
    last = str(p.get("lastName") or p.get("last_name") or "").strip()
    name = " ".join(str(p.get("name") or p.get("printAs") or "").split()) or f"{first} {last}".strip()
    return {
        "employeeId": str(p.get("employeeId") or p.get("employee_id") or p.get("code") or p.get("id") or "").strip(),
        "name": name,
        "firstName": first,
        "lastName": last,
        "email": str(p.get("email") or "").strip().lower(),
        "status": str(p.get("status") or "").strip().lower(),
        "location": str(p.get("location") or p.get("locationId") or p.get("entity") or "").strip(),
        "locationName": str(p.get("locationName") or p.get("location_name") or p.get("entityName") or "").strip(),
    }


def _fetch_direct() -> dict:
    try:
        rows = intacct_client.fetch_employees()
    except intacct_client.IntacctError as e:
        raise IntacctUnavailable(f"{e} Nothing was changed.") from e
    return {"source": "intacct", "employees": [_norm_record({
        "employeeId": p["employeeId"], "printAs": p["printAs"], "firstName": p["firstName"],
        "lastName": p["lastName"], "email": p["email"], "status": p["status"],
        "locationId": p["locationId"], "locationName": p["locationName"]}) for p in rows]}


def _fetch_ledger() -> dict:
    r = _http_get(LEDGER_PATH, {"kind": "employee"})
    if r.status_code != 200:
        raise IntacctUnavailable(f"{acct._upstream_detail(r)}. Nothing was changed.")
    data = _json_body(r)
    values = data.get("values") or data.get("rows") or []
    return {"source": "ledger", "employees": [_norm_record({"employeeId": v.get("code"), "name": v.get("name"),
                                                            "status": v.get("status")})
                                              for v in values if isinstance(v, dict)]}


def fetch_intacct_employees() -> dict:
    """{source, employees} - blocking HTTP, call it from a thread or a sync
    endpoint. source 'intacct' = the full employee list read from Intacct by
    Nexus (when the INTACCT_* settings are on this server); 'ledger' = only
    the employee codes on the accounting ledger (no email, no location).
    Tests replace this."""
    if intacct_client.configured():
        return _fetch_direct()
    return _fetch_ledger()


# ── Matching ─────────────────────────────────────────────────────────────────

def name_key(s: str) -> str:
    """'Desai, Charmi' and 'charmi  desai' -> 'charmi desai'. Exact after
    that: case, spacing and punctuation only - never fuzzy."""
    s = " ".join(str(s or "").split())
    if s.count(",") == 1:
        last, _, first = s.partition(",")
        s = f"{first} {last}"
    s = re.sub(r"[^\w ]", "", s.lower())
    return " ".join(s.split())


_ORG_SUFFIX = {"llc", "inc", "ltd", "pvt", "private", "limited", "corp", "corporation", "co", "lp", "llp", "plc"}


def org_key(s: str) -> str:
    words = re.sub(r"[^\w ]", " ", str(s or "").lower()).split()
    while words and words[-1] in _ORG_SUFFIX:
        words.pop()
    return " ".join(words)


def _person_keys(p) -> set:
    keys = {name_key(f"{p.first_name or ''} {p.last_name or ''}")}
    if (p.display_name or "").strip():
        keys.add(name_key(p.display_name))
    return {k for k in keys if k}


def _record_keys(rec: dict) -> set:
    keys = {name_key(rec["name"])}
    if rec["firstName"] or rec["lastName"]:
        keys.add(name_key(f"{rec['firstName']} {rec['lastName']}"))
    return {k for k in keys if k}


def _company_matches(p, rec: dict, entities: dict) -> bool:
    ent = entities.get(p.company or "")
    if ent is None:
        return False
    wanted = {org_key(rec["locationName"]), org_key(rec["location"])} - {""}
    have = {org_key(ent.name), org_key(ent.legal_name or "")} - {""}
    return bool(wanted & have)


def _person_name(p) -> str:
    return (p.display_name or "").strip() or f"{p.first_name or ''} {p.last_name or ''}".strip()


def build_preview(db: Session, scope, data: dict, state: Optional[dict] = None) -> dict:
    """One row per Nexus person in `scope` (None = everyone) with the action
    HR would take. Matching runs over EVERY internal person, so a conflict
    with somebody outside a scoped admin's companies is still a conflict."""
    state = state or load_state(db)
    synced = state["synced"]
    records = [r for r in data.get("employees") or [] if r.get("employeeId")]
    entities = {e.id: e for e in db.query(models.HrEntity).all()}
    people = [p for p in db.query(models.NexusEmployee).all()
              if (p.identity_type or "internal") == "internal"]
    # Codes held by anybody, removed people included (they can be restored).
    holders = defaultdict(list)
    for p in db.query(models.NexusEmployee).execution_options(include_deleted=True).all():
        if (p.employee_code or "").strip():
            holders[p.employee_code.strip()].append(p)

    by_email, by_name = defaultdict(list), defaultdict(list)
    for p in people:
        if (p.work_email or "").strip():
            by_email[p.work_email.strip().lower()].append(p)
        for k in _person_keys(p):
            by_name[k].append(p)

    claims = defaultdict(list)      # person id -> [(record, method)]
    ambiguous = defaultdict(list)   # person id -> [record matching several people]
    claimed_records = set()
    for rec in records:
        hits = by_email.get(rec["email"]) if rec["email"] else None
        if hits:
            if len(hits) == 1:
                claims[hits[0].id].append((rec, "email"))
            else:
                for p in hits:
                    ambiguous[p.id].append(rec)
            claimed_records.add(rec["employeeId"])
            continue
        cands = {}
        for k in _record_keys(rec):
            for p in by_name.get(k, []):
                cands[p.id] = p
        if not cands:
            continue
        claimed_records.add(rec["employeeId"])
        if len(cands) == 1:
            claims[next(iter(cands))].append((rec, "name"))
            continue
        narrowed = [p for p in cands.values() if _company_matches(p, rec, entities)]
        if len(narrowed) == 1:
            claims[narrowed[0].id].append((rec, "name_company"))
            continue
        for pid in cands:
            ambiguous[pid].append(rec)

    rows = []
    for p in people:
        current = (p.employee_code or "").strip()
        row = {"employeeId": p.id, "name": _person_name(p), "workEmail": p.work_email or "",
               "company": p.company or "", "companyName": (entities.get(p.company or "").name if entities.get(p.company or "") else ""),
               "status": p.status or "", "currentCode": current, "intacctCode": "", "intacctName": "",
               "intacctEmail": "", "intacctStatus": "", "intacctLocation": "", "matchBy": "",
               "action": "no_match", "reason": "", "replacesNexusCode": False, "autoEligible": False}
        mine = claims.get(p.id) or []
        strong = [c for c in mine if c[1] == "email"] or mine
        codes = sorted({c[0]["employeeId"] for c in strong})
        if len(codes) > 1:
            row.update(action="conflict", matchBy=strong[0][1],
                       reason=f"Several Intacct employees match this person: {', '.join(codes)}")
        elif codes:
            rec, method = strong[0]
            row.update(intacctCode=rec["employeeId"], intacctName=rec["name"], intacctEmail=rec["email"],
                       intacctStatus=rec["status"], intacctLocation=rec["locationName"] or rec["location"],
                       matchBy=method)
            if current == rec["employeeId"]:
                row["action"] = "keep"
            else:
                row["action"] = "update"
                row["replacesNexusCode"] = bool(current) and synced.get(p.id) != current
                row["autoEligible"] = method == "email" and (not current or synced.get(p.id) == current)
        elif ambiguous.get(p.id):
            ids = sorted({r["employeeId"] for r in ambiguous[p.id]})
            row.update(action="conflict",
                       reason=f"Intacct {', '.join(ids)} matches more than one Nexus person - set this code by hand")
        else:
            row["reason"] = "No Intacct employee with this work email or name"
        rows.append(row)

    # One Intacct ID proposed for two people, or a code somebody else keeps.
    by_id = {r["employeeId"]: r for r in rows}
    proposed = defaultdict(list)
    for r in rows:
        if r["action"] in ("update", "keep"):
            proposed[r["intacctCode"]].append(r)
    for code, rs in proposed.items():
        if len(rs) > 1:
            for r in rs:
                others = ", ".join(x["name"] for x in rs if x is not r)
                r.update(action="conflict", autoEligible=False, reason=f"Intacct {code} also matches {others}")
    for r in rows:
        if r["action"] != "update":
            continue
        for h in holders.get(r["intacctCode"], []):
            if h.id == r["employeeId"]:
                continue
            other = by_id.get(h.id)
            if other is not None and other["action"] == "update":
                continue   # that person moves to their own Intacct code in the same pass
            who = _person_name(h) + (" (removed from Nexus)" if (h.deleted_at or "") else "")
            r.update(action="conflict", autoEligible=False, reason=f"{r['intacctCode']} already belongs to {who}")
            break

    if scope is not None:
        rows = [r for r in rows if r["company"] in scope]
    rows.sort(key=lambda r: (ACTIONS.index(r["action"]), r["name"].lower()))
    counts = {a: sum(1 for r in rows if r["action"] == a) for a in ACTIONS}
    not_in_nexus = [] if scope is not None else [
        {"employeeId": r["employeeId"], "name": r["name"], "email": r["email"], "status": r["status"],
         "location": r["locationName"] or r["location"]}
        for r in records if r["employeeId"] not in claimed_records]
    source = data.get("source") or "intacct"
    return {"source": source, "sourceLabel": SOURCE_LABELS.get(source, source), "rows": rows, "counts": counts,
            "notInNexus": not_in_nexus}


# ── Applying ─────────────────────────────────────────────────────────────────

def apply_codes(db: Session, preview: dict, picks: dict, actor: str, role: str, state: dict) -> dict:
    """Write the picked rows ({person id: Intacct code}) that are still an
    Update with that same code. Commits nothing; returns applied / skipped."""
    rows = {r["employeeId"]: r for r in preview["rows"]}
    applied, skipped, todo = [], [], []
    for pid, code in picks.items():
        r = rows.get(pid)
        if r is None:
            skipped.append({"employeeId": pid, "reason": "Not on this list"})
        elif r["action"] != "update":
            skipped.append({"employeeId": pid, "name": r["name"], "reason": r["reason"] or f"Nothing to update ({r['action']})"})
        elif r["intacctCode"] != (code or "").strip():
            skipped.append({"employeeId": pid, "name": r["name"], "reason": "Intacct changed since the preview - refresh and check again"})
        else:
            todo.append(r)
    # No two people may end up with one code: a holder who is also moving only
    # frees the code when their own row is picked too.
    final = {}
    everyone = db.query(models.NexusEmployee).execution_options(include_deleted=True).all()
    for p in everyone:
        final[p.id] = (p.employee_code or "").strip()
    while True:
        trial = dict(final)
        for r in todo:
            trial[r["employeeId"]] = r["intacctCode"]
        count = defaultdict(int)
        for c in trial.values():
            if c:
                count[c] += 1
        clash = [r for r in todo if count[r["intacctCode"]] > 1]
        if not clash:
            break
        for r in clash:
            todo.remove(r)
            skipped.append({"employeeId": r["employeeId"], "name": r["name"],
                            "reason": f"{r['intacctCode']} is still held by another person - apply their row too"})
    if not todo:
        return {"applied": applied, "skipped": skipped}
    emps = {p.id: p for p in everyone}
    now = _now()
    for r in todo:
        p = emps[r["employeeId"]]
        old = (p.employee_code or "").strip()
        p.employee_code = r["intacctCode"]
        p.updated_at = now
        state["synced"][p.id] = r["intacctCode"]
        db.add(models.AuditLog(timestamp=now, user_email=actor, user_role=role or "",
                               action="Employee code from Intacct", resource_type="employee", resource_id=p.id,
                               details=json.dumps({"employee": p.work_email or "", "matchBy": r["matchBy"],
                                                   "changes": {"employee_code": [old, r["intacctCode"]]}})[:4000]))
        applied.append({"employeeId": p.id, "name": r["name"], "from": old, "to": r["intacctCode"]})
    return {"applied": applied, "skipped": skipped}


# ── Nightly ──────────────────────────────────────────────────────────────────

def run_nightly(db: Session, day: str = "", fetch=None) -> dict:
    """Apply the confident rows (work email, Nexus code empty or last written
    by this sync) for the companies that switched the nightly sync on. When
    Intacct cannot be read nothing changes and the run says why."""
    state = load_state(db)
    enabled = {cid for cid, on in state["nightly"].items() if on}
    if not enabled:
        return {"skipped": "off"}
    run = {"at": _now(), "day": day or datetime.now(timezone.utc).date().isoformat()}
    try:
        data = (fetch or fetch_intacct_employees)()
    except IntacctUnavailable as e:
        state["lastRun"] = {**run, "ok": False, "error": str(e), "applied": 0, "review": 0}
        save_state(db, state, SYNC_ACTOR)
        db.commit()
        return state["lastRun"]
    preview = build_preview(db, None, data, state)
    mine = [r for r in preview["rows"] if r["company"] in enabled]
    picks = {r["employeeId"]: r["intacctCode"] for r in mine if r["action"] == "update" and r["autoEligible"]}
    out = apply_codes(db, preview, picks, SYNC_ACTOR, "system", state)
    done = {a["employeeId"] for a in out["applied"]}
    review = sum(1 for r in mine if r["employeeId"] not in done and r["action"] in ("update", "conflict"))
    state["lastRun"] = {**run, "ok": True, "source": preview["source"], "applied": len(out["applied"]),
                        "review": review, "noMatch": sum(1 for r in mine if r["action"] == "no_match")}
    save_state(db, state, SYNC_ACTOR)
    db.commit()
    return state["lastRun"]


def nightly_tick(now: Optional[datetime] = None, fetch=None) -> Optional[dict]:
    """One check of the loop: run once a day after NIGHTLY_HOUR_UTC."""
    if job_switch.off("employee_code_sync"):   # Workflows > Automations switch
        return None
    from database import SessionLocal
    now = now or datetime.now(timezone.utc)
    if now.hour < NIGHTLY_HOUR_UTC:
        return None
    day = now.date().isoformat()
    db = SessionLocal()
    try:
        state = load_state(db)
        if not any(state["nightly"].values()) or (state["lastRun"] or {}).get("day") == day:
            return None
        return run_nightly(db, day=day, fetch=fetch)
    finally:
        db.close()


async def employee_code_sync_loop():
    from leader import is_deployed_worker

    if not is_deployed_worker():
        print("[intacct-codes] nightly sync skipped (not the deployed worker)")
        return
    await asyncio.sleep(180)
    while True:
        try:
            out = await asyncio.to_thread(nightly_tick)
            if out:
                print(f"[intacct-codes] nightly: {out}")
        except Exception as e:   # noqa: BLE001 - the loop must outlive one bad night
            print(f"[intacct-codes] nightly failed: {e}")
        await asyncio.sleep(TICK_SEC)


# ── Endpoints ────────────────────────────────────────────────────────────────

def _hr_admin(user: dict, db: Session):
    """The caller's company scope; a manager's own-team view is not HR."""
    scope = hr_scope(user, db)
    if is_team_scope(scope):
        raise HTTPException(403, "Only HR can sync employee codes")
    return scope


def _fetch_or_424():
    try:
        return fetch_intacct_employees()
    except IntacctUnavailable as e:
        # 424 like the accounting screens: not a server fault, and the client
        # does not retry it as one.
        raise HTTPException(424, str(e)) from e


@router.get("/preview")
def preview(user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    scope = _hr_admin(user, db)
    data = _fetch_or_424()
    out = build_preview(db, scope, data)
    out["fetchedAt"] = _now()
    return out


class ApplyItem(BaseModel):
    employeeId: str
    code: str


class ApplyIn(BaseModel):
    items: list[ApplyItem]


@router.post("/apply")
def apply(body: ApplyIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    scope = _hr_admin(user, db)
    if not body.items:
        raise HTTPException(400, "Pick at least one person")
    data = _fetch_or_424()
    state = load_state(db)
    pv = build_preview(db, scope, data, state)
    out = apply_codes(db, pv, {i.employeeId: i.code for i in body.items}, user["email"], str(user.get("role") or ""), state)
    if out["applied"]:
        save_state(db, state, user["email"])
        db.commit()
    return out


@router.get("/settings")
def get_settings(user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    scope = _hr_admin(user, db)
    state = load_state(db)
    companies = [{"id": e.id, "name": e.name, "nightly": bool(state["nightly"].get(e.id))}
                 for e in db.query(models.HrEntity).order_by(models.HrEntity.name).all()
                 if scope is None or e.id in scope]
    return {"companies": companies, "lastRun": state["lastRun"], "nightlyHourUtc": NIGHTLY_HOUR_UTC}


class NightlyIn(BaseModel):
    companyId: str
    nightly: bool


@router.put("/settings")
def put_settings(body: NightlyIn, user: dict = Depends(require_hr_write), db: Session = Depends(get_db)):
    scope = _hr_admin(user, db)
    ent = db.query(models.HrEntity).filter(models.HrEntity.id == body.companyId).first()
    if ent is None or (scope is not None and ent.id not in scope):
        raise HTTPException(404, "Company not found")
    state = load_state(db)
    before = bool(state["nightly"].get(ent.id))
    state["nightly"][ent.id] = bool(body.nightly)
    save_state(db, state, user["email"])
    if before != bool(body.nightly):
        db.add(models.AuditLog(timestamp=_now(), user_email=user["email"], user_role=str(user.get("role") or ""),
                               action="Nightly employee code sync " + ("on" if body.nightly else "off"),
                               resource_type="settings", resource_id=SETTINGS_KEY,
                               details=json.dumps({"company": ent.name, "nightly": [before, bool(body.nightly)]})))
    db.commit()
    return {"id": ent.id, "name": ent.name, "nightly": bool(body.nightly)}
