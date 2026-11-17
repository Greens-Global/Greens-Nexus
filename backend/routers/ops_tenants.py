"""Operations > Tenants (Neil, 11/17/2026): the tenant directory, one
tenant's record, and who may see them.

  GET    /facility-ops/access/me           what the caller reaches: facilities, tenant details, may manage
  GET    /facility-ops/access              the rules, with the facilities and groups to pick from
  PUT    /facility-ops/access              add or change one subject's rule
  DELETE /facility-ops/access/{id}         remove a rule
  GET    /facility-ops/tenants             the directory: search, one facility, current / former, paged
  GET    /facility-ops/tenants/{customer}  one tenant, re-read LIVE from Cubby

Neil's decisions (11/17/2026):
  - Nexus keeps a READ-ONLY copy of tenant contact details (ops_tenants,
    ops_lease_extras - written by cubby_sync.py). Cubby stays the single
    source of truth: nothing here edits a tenant, the copy is refreshed by the
    15-minute sync, and opening a tenant re-reads that tenant live from Cubby.
  - Gate codes are shown plainly (Nexus is internal only). They are stored
    encrypted and searched by a keyed hash, exact match only.
  - Access is by role (Access Group / job role) and by person, including
    which facilities each sees - ops_access.reach, the ONE rule. Nobody below
    Administrator sees tenant details until a rule says so.
  - Still never stored: date of birth, ID type / number, card or bank numbers.

Same door as the rest of Operations (supervisors and above, or the Operations
grant); tenant details on top of it need ops_access.reach to say so (403).
Every record open and every rule change is an AuditLog row. Rules are changed
by an Administrator or an Operations grant at Full (the Push to Cubby rule).

Money is integer cents, dates are ISO and Cubby's own codes (a payment's
status and method, a vehicle type) go out as Cubby spells them - the screen
formats all three. The one exception is a lease's coverage type, sent as the
label Operations > Reports already uses ("Facility Plan", "Private Policy"):
Cubby's own word for the facility's plan is "ORGANISATION". Lease, unit,
balance and payment figures come from the cubby_* rows the sync already keeps
(the same blob fields cubby.py and ops_reports.py read); the ledger is not
here - the screen calls GET /ops-reports/tenant/ledger.

Nothing here logs a contact value or a gate code, and the tenant tables are
written with plain table statements so the change log (audit_capture) never
holds one either. Blocking work (database, Cubby) runs in a thread.
"""
import asyncio
import json
import re
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import and_, exists, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import cubby
import cubby_sync
import models
import ops_access
import ops_reports
import secret_box
from auth import get_current_user, require_level_or_module
from database import SessionLocal, get_db

router = APIRouter(
    prefix="/facility-ops",
    tags=["Operations"],
    dependencies=[Depends(require_level_or_module(2, "operations", "viewer"))],
)

LIVE_LIMIT_SEC = 8.0          # the whole live re-read; past it the stored copy is shown
NOT_CONNECTED = "Cubby is not connected on this server."
PAYMENTS_SHOWN = 24
MAX_PAGE = 200
STATUSES = ("current", "former", "all")
OPENED = "ops_tenant_opened"
RULE_SAVED = "ops_access_rule_saved"
RULE_DELETED = "ops_access_rule_deleted"

_CONTACT = ("phone", "email", "address", "address2", "city", "state", "zip", "country")
_iso_day = ops_reports._iso_day


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _audit(db: Session, user: dict, action: str, resource_type: str, resource_id: str, details: dict) -> None:
    """One AuditLog row (the caller commits). Ids and switches only - never a
    contact value or a gate code."""
    db.add(models.AuditLog(
        timestamp=_now(), user_email=user["email"], user_role=user.get("role", ""),
        action=action, resource_type=resource_type, resource_id=resource_id,
        details=json.dumps(details)))


def _facilities(db: Session) -> dict[str, str]:
    """{facility id: short name} of the facilities Cubby still lists."""
    F = models.CubbyFacility
    return {f.facility_id: cubby._short({"name": f.name or ""})
            for f in db.query(F).filter(F.enabled.is_(True)).all()}


def _details_reach(user: dict, db: Session) -> dict:
    """The caller's reach, or 403 when it carries no tenant details."""
    reached = ops_access.reach(user, db)
    if not reached["tenant_details"]:
        raise HTTPException(status_code=403, detail=ops_access.DENIED)
    return reached


# ── Access ────────────────────────────────────────────────────────────────────

def _require_manage(user: dict = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    # 403, not the role gates' 401: the screen treats a 401 as a dead sign-in.
    if not ops_access.may_manage(user, db):
        raise HTTPException(status_code=403, detail="Only an Administrator or an Operations grant at Full can change who sees tenants.")
    return user


@router.get("/access/me")
def access_me(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    reached = ops_access.reach(user, db)
    return {"facilities": None if reached["facilities"] is None else sorted(reached["facilities"]),
            "tenantDetails": reached["tenant_details"], "canManage": ops_access.may_manage(user, db)}


def _person_names(db: Session, emails: list[str]) -> dict[str, str]:
    if not emails:
        return {}
    E = models.NexusEmployee
    out = {}
    for e in db.query(E).filter(func.lower(E.work_email).in_(emails)).all():
        out[(e.work_email or "").lower()] = (e.display_name or f"{e.first_name or ''} {e.last_name or ''}").strip()
    return out


def _rule_out(r: models.OpsAccessRule, names: dict) -> dict:
    return {"id": r.id, "subjectType": r.subject_type, "subjectId": r.subject_id,
            "subjectName": names.get((r.subject_type, r.subject_id)) or r.subject_id,
            "facilityIds": list(r.facility_ids or []), "tenantDetails": bool(r.tenant_details),
            "updatedBy": r.updated_by or "", "updatedAt": r.updated_at or ""}


def _access_out(db: Session) -> dict:
    rules = db.query(models.OpsAccessRule).all()
    groups = db.query(models.NexusGroup).all()
    names = {("group", g.id): g.name or "" for g in groups}
    people = _person_names(db, [r.subject_id for r in rules if r.subject_type == "person"])
    names.update({("person", email): name for email, name in people.items()})
    out = sorted((_rule_out(r, names) for r in rules), key=lambda r: (r["subjectType"] != "group", r["subjectName"].lower()))
    return {"rules": out,
            "facilities": sorted(({"id": fid, "name": name} for fid, name in _facilities(db).items()),
                                 key=lambda f: f["name"].lower()),
            "groups": sorted(({"id": g.id, "name": g.name or "", "isJobRole": bool(g.is_job_role)} for g in groups),
                             key=lambda g: g["name"].lower())}


@router.get("/access")
def get_access(_: dict = Depends(_require_manage), db: Session = Depends(get_db)):
    return _access_out(db)


class RuleBody(BaseModel):
    subjectType: str
    subjectId: str
    facilityIds: list[str] = Field(default_factory=list)
    tenantDetails: bool = False


@router.put("/access")
def put_access(body: RuleBody, user: dict = Depends(_require_manage), db: Session = Depends(get_db)):
    """Add or change one subject's rule (one row per subject)."""
    kind, sid = body.subjectType.strip().lower(), body.subjectId.strip()
    if kind == "person":
        sid = sid.lower()
        E = models.NexusEmployee
        if not sid or db.query(E.id).filter(func.lower(E.work_email) == sid).first() is None:
            raise HTTPException(status_code=422, detail="Pick a person from Nexus People.")
    elif kind == "group":
        if not sid or db.get(models.NexusGroup, sid) is None:
            raise HTTPException(status_code=422, detail="Pick an Access Group or a job role.")
    else:
        raise HTTPException(status_code=422, detail="A rule is for a person or a group.")
    ids = list(dict.fromkeys(f.strip() for f in body.facilityIds if f and f.strip()))
    F = models.CubbyFacility
    known = {fid for (fid,) in db.query(F.facility_id).filter(F.facility_id.in_(ids)).all()} if ids else set()
    if set(ids) - known:
        raise HTTPException(status_code=422, detail="One of the facilities is not a Cubby facility.")

    R = models.OpsAccessRule
    row = db.query(R).filter(R.subject_type == kind, R.subject_id == sid).with_for_update().first()
    before = None
    now = _now()
    if row is None:
        row = R(id=str(uuid.uuid4()), subject_type=kind, subject_id=sid, created_by=user["email"], created_at=now)
        db.add(row)
    else:
        before = {"facilityIds": list(row.facility_ids or []), "tenantDetails": bool(row.tenant_details)}
    row.facility_ids = ids
    row.tenant_details = bool(body.tenantDetails)
    row.updated_by, row.updated_at = user["email"], now
    _audit(db, user, RULE_SAVED, "ops_access_rule", row.id,
           {"subjectType": kind, "subjectId": sid, "from": before,
            "to": {"facilityIds": ids, "tenantDetails": bool(body.tenantDetails)}})
    try:
        db.commit()
    except IntegrityError:
        # Two saves for the same new subject at once: the other one made the row.
        db.rollback()
        raise HTTPException(status_code=409, detail="Someone else just saved a rule for them. Reload and try again.") from None
    out = _access_out(db)
    return {**out, "rule": next((r for r in out["rules"] if r["id"] == row.id), None)}


@router.delete("/access/{rule_id}")
def delete_access(rule_id: str, user: dict = Depends(_require_manage), db: Session = Depends(get_db)):
    row = db.get(models.OpsAccessRule, rule_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Rule not found")
    _audit(db, user, RULE_DELETED, "ops_access_rule", row.id,
           {"subjectType": row.subject_type, "subjectId": row.subject_id,
            "from": {"facilityIds": list(row.facility_ids or []), "tenantDetails": bool(row.tenant_details)}, "to": None})
    db.delete(row)
    db.commit()
    return _access_out(db)


# ── The directory ─────────────────────────────────────────────────────────────

def _search(q: str):
    """The directory's search, or None for an empty box: every word in the
    search text (name, company, email, unit, plate); 4+ digits also a phone
    number; the whole box also a gate code, exact match through its hash."""
    q = (q or "").strip()
    if not q:
        return None
    T = models.OpsTenant
    words = q.lower().split()[:8]
    # autoescape: a % or _ somebody types is a character, not a wildcard.
    ways = [and_(*[T.search_text.contains(w, autoescape=True) for w in words])]
    digits = re.sub(r"\D", "", q)
    if len(digits) >= 4:
        ways.append(T.phone_digits.like(f"%{digits}%"))
    ways.append(T.gate_code_hash == cubby_sync.gate_code_hash(q))
    return or_(*ways)


def _rented_line(u: models.CubbyUnit, customer_id: str) -> dict:
    """The rent-roll line of a unit, when this customer rents it now ({} otherwise)."""
    rr = (u.data or {}).get("rentRoll") or {}
    rented = (rr.get("status") or u.status or "").upper() == "RENTED"
    return rr if rented and str(u.customer_id or rr.get("customerId") or "") == customer_id else {}


@router.get("/tenants")
def list_tenants(q: str = "", facility: str = "", facilities: str = "", status: str = "current",
                 limit: int = Query(50, ge=1, le=MAX_PAGE), offset: int = Query(0, ge=0),
                 user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The tenant directory: one row per tenant per facility, current first."""
    reached = _details_reach(user, db)
    if status not in STATUSES:
        raise HTTPException(status_code=422, detail="status is current, former or all")
    names = _facilities(db)
    fids = ops_access.narrow(reached, sorted(names))
    if facility:
        fids = [f for f in fids if f == facility]
    # The page's State choice: several facilities at once, by id.
    several = {f.strip() for f in facilities.split(",") if f.strip()}
    if several:
        fids = [f for f in fids if f in several]
    F = models.CubbyFacility
    stamps = [s or "" for (s,) in db.query(F.synced_at).filter(F.facility_id.in_(fids)).all()] if fids else []
    synced = min(stamps) if stamps and all(stamps) else ""
    if not fids:
        return {"rows": [], "total": 0, "syncedAt": synced}

    T, L = models.OpsTenant, models.CubbyRental
    # ops_tenants holds everyone a facility's rows point at - leads and people
    # who only ever paid a fee too. The directory is tenants: someone with a
    # lease here now (current) or one that ended (former).
    had_lease = exists().where(L.facility_id == T.facility_id, L.customer_id == T.customer_id)
    conds = [T.facility_id.in_(fids),
             {"current": T.current.is_(True), "former": and_(T.current.is_(False), had_lease),
              "all": or_(T.current.is_(True), had_lease)}[status]]
    match = _search(q)
    if match is not None:
        conds.append(match)
    total = db.query(func.count(T.id)).filter(*conds).scalar() or 0
    page = (db.query(T).filter(*conds)
            .order_by(T.current.desc(), func.lower(T.name), T.facility_id, T.customer_id)
            .limit(limit).offset(offset).all())
    if not page:
        return {"rows": [], "total": total, "syncedAt": synced}

    # Money and plates for this page only, from the rows the sync already keeps.
    pairs = {(t.facility_id, t.customer_id) for t in page}
    page_fids, cids = sorted({p[0] for p in pairs}), sorted({p[1] for p in pairs})
    U, R, X = models.CubbyUnit, models.CubbyReceivable, models.OpsLeaseExtra
    lines: dict[tuple, list] = {}
    for u in db.query(U).filter(U.facility_id.in_(page_fids), U.customer_id.in_(cids)).all():
        rr = _rented_line(u, u.customer_id)
        if rr:
            lines.setdefault((u.facility_id, u.customer_id), []).append(rr)
    owed: dict[tuple, int] = {}
    for r in db.query(R).filter(R.facility_id.in_(page_fids), R.customer_id.in_(cids)).all():
        owed[(r.facility_id, r.customer_id)] = owed.get((r.facility_id, r.customer_id), 0) + int(r.total_cents or 0)
    plates: dict[tuple, list] = {}
    for x in (db.query(X).filter(X.facility_id.in_(page_fids), X.customer_id.in_(cids), X.vehicle_plate != "")
              .order_by(X.id).all()):
        got = plates.setdefault((x.facility_id, x.customer_id), [])
        if x.vehicle_plate not in got:
            got.append(x.vehicle_plate)

    rows = []
    for t in page:
        key = (t.facility_id, t.customer_id)
        mine = lines.get(key, [])
        paid = sorted(d for d in (_iso_day(rr.get("paidThroughDate")) for rr in mine) if d)
        rows.append({
            "customerId": t.customer_id, "facilityId": t.facility_id, "facilityName": names.get(t.facility_id, ""),
            "name": t.name or "", "companyName": t.company_name or "", "phone": t.phone or "", "email": t.email or "",
            "units": [n for n in (t.unit_names or "").split(", ") if n], "current": bool(t.current),
            "balanceCents": owed.get(key, 0),
            # Several units: the one furthest behind, and autopay only when every unit is on it.
            "paidThrough": paid[0] if paid else "",
            "autopay": all(bool(rr.get("autoPayEnabled")) for rr in mine) if mine else None,
            "plates": plates.get(key, []),
        })
    return {"rows": rows, "total": total, "syncedAt": synced}


# ── One tenant ────────────────────────────────────────────────────────────────

def _cubby_read(path: str, where: dict) -> dict:
    """One Cubby search for the live re-read. cubby._post waits a minute for
    an answer; a person looking at a tenant waits LIVE_LIMIT_SEC. Blocking.
    Raises cubby.CubbyError (Cubby's own message, never the key)."""
    try:
        r = httpx.post(f"{cubby.BASE}/{path}", json={"where": where},
                       headers={"Authorization": f"Bearer {cubby._key()}"}, timeout=LIVE_LIMIT_SEC)
    except httpx.HTTPError as e:
        raise cubby.CubbyError(0, f"Cubby could not be reached ({type(e).__name__})") from e
    try:
        body = r.json()
    except Exception:  # noqa: BLE001 - upstream body may not be JSON
        body = {}
    if r.status_code != 200:
        errors = (body.get("errors") if isinstance(body, dict) else None) or [f"Cubby returned {r.status_code}"]
        raise cubby.CubbyError(r.status_code, f"{path}: {'; '.join(str(e) for e in errors)}")
    return (body.get("data") if isinstance(body, dict) else None) or {}


async def _read_live(customer_id: str, fids: list[str]) -> dict:
    """The customer and their gate codes at these facilities, from Cubby, now:
    {"ok": True, "customer": row, "codes": {facility id: [rows]}} or
    {"ok": False, "error": a short, safe line}. Never raises."""
    if not cubby.configured():
        return {"ok": False, "error": NOT_CONNECTED}

    async def rows(path, where, key):
        got = (await asyncio.to_thread(_cubby_read, path, where)).get(key)
        # Whatever the search answered with, only this customer's rows are used.
        return [x for x in got or [] if isinstance(x, dict) and str(x.get("customerId") or "") == customer_id]

    async def codes(fid):
        # The customer read decides whether this was live. A gate-code read
        # that is refused (a key that may not read access codes) or that
        # names nobody is None: the stored code stays as the sync left it.
        try:
            return await rows("access-codes/search", {"facilityId": fid, "customerId": customer_id}, "accessCodes") or None
        except Exception:  # noqa: BLE001 - never fails the record
            return None

    try:
        # Scoped to a facility like every Cubby search (an unscoped one answers 403).
        got = await asyncio.wait_for(asyncio.gather(
            rows("customers/search", {"facilityId": fids[0], "customerId": customer_id}, "customers"),
            *[codes(f) for f in fids]),
            timeout=LIVE_LIMIT_SEC)
    except asyncio.TimeoutError:
        return {"ok": False, "error": "Cubby took too long to answer."}
    except cubby.CubbyError as e:
        return {"ok": False, "error": (e.message or "Cubby did not answer.")[:200]}
    except Exception as e:  # noqa: BLE001 - the type only: a message can quote a row
        return {"ok": False, "error": type(e).__name__}
    if not got[0]:
        return {"ok": False, "error": "Cubby did not return this tenant."}
    return {"ok": True, "customer": got[0][0], "codes": dict(zip(fids, got[1:]))}


def _scope(user: dict, customer_id: str) -> list[str]:
    """The facilities this caller may see this customer at. 403 without
    tenant details, 404 when there is none. Blocking."""
    db = SessionLocal()
    try:
        reached = _details_reach(user, db)
        fids = ops_access.narrow(reached, sorted(_facilities(db)))
        T = models.OpsTenant
        mine = [f for (f,) in db.query(T.facility_id).filter(T.customer_id == customer_id, T.facility_id.in_(fids))
                .order_by(T.current.desc(), T.facility_id).all()] if fids else []
        if not mine:
            raise HTTPException(status_code=404, detail="Tenant not found")
        return mine
    finally:
        db.close()


def _plates(db: Session, fid: str, customer_id: str) -> list[str]:
    X = models.OpsLeaseExtra
    return [p for (p,) in db.query(X.vehicle_plate).filter(X.facility_id == fid, X.customer_id == customer_id,
                                                           X.vehicle_plate != "").order_by(X.id).all()]


def _apply_live(db: Session, rows: list[dict], live: dict, stamp: str) -> None:
    """Bring the stored copy of one customer up to what Cubby just said, where
    it differs - `rows` (their ops_tenants rows as dicts) are changed in place
    too. A plain table UPDATE on purpose: an ORM write would put the phone
    number and address into the change log (audit_capture)."""
    t = models.OpsTenant.__table__
    fresh = cubby_sync.tenant_fields(live["customer"])
    if not fresh["name"]:
        fresh.pop("name")          # the sync may have named them from the rent roll; keep that
    for row in rows:
        changed = {k: v for k, v in fresh.items() if row.get(k) != v}
        live_codes = live["codes"].get(row["facility_id"])
        if live_codes:   # None / empty: Cubby said nothing usable about the code - keep the stored one
            gate = cubby_sync.gate_fields(live_codes)
            # The encrypted text differs on every write, so the hash says whether the code moved.
            if (gate["gate_code_hash"], gate["gate_code_enabled"]) != (row["gate_code_hash"] or "", bool(row["gate_code_enabled"])):
                changed.update(gate)
        if not changed:
            continue
        row.update(changed)
        if {"name", "company_name", "email"} & set(changed):   # what the directory's search reads
            changed["search_text"] = cubby_sync.tenant_search_text(
                row["name"] or "", row["company_name"] or "", row["email"] or "", row["unit_names"] or "",
                _plates(db, row["facility_id"], row["customer_id"]))
        changed["synced_at"] = stamp
        row.update(changed)
        db.execute(t.update().where(t.c.id == row["id"]).values(**changed))


def _gate_code(sealed: str) -> str:
    try:
        return secret_box.decrypt(sealed or "")
    except Exception:  # noqa: BLE001 - written under another vault key: shown as none, never a 500
        return ""


def _size(rr: dict, un: dict) -> str:
    try:
        w, d = float(rr.get("width") or un.get("width") or 0), float(rr.get("depth") or un.get("depth") or 0)
    except (TypeError, ValueError):
        return ""
    return f"{w:g}x{d:g}" if w and d else ""


def _leases(db: Session, customer_id: str, fids: list[str], names: dict) -> list[dict]:
    """Every tenancy of this customer at these facilities. Rent, coverage and
    the scheduled move-out come from the lease (cubby_rentals); paid-through,
    autopay and the lock from the unit's rent-roll line while they still rent
    it; the balance from the receivables; the vehicle and alternate contacts
    from ops_lease_extras - the fields cubby.py and ops_reports.Data read,
    for one customer instead of a whole facility."""
    L, U, R, X = models.CubbyRental, models.CubbyUnit, models.CubbyReceivable, models.OpsLeaseExtra
    rentals = db.query(L).filter(L.customer_id == customer_id, L.facility_id.in_(fids)).all()
    unit_ids = sorted({r.unit_id for r in rentals if r.unit_id})
    units = {(u.facility_id, u.unit_id): u
             for u in db.query(U).filter(U.facility_id.in_(fids), U.unit_id.in_(unit_ids)).all()} if unit_ids else {}
    owed: dict[tuple, int] = {}
    for r in db.query(R).filter(R.facility_id.in_(fids), R.customer_id == customer_id).all():
        owed[(r.facility_id, r.unit_id)] = owed.get((r.facility_id, r.unit_id), 0) + int(r.total_cents or 0)
    extras = {(x.facility_id, x.lease_id): x
              for x in db.query(X).filter(X.facility_id.in_(fids), X.customer_id == customer_id).all()}
    today = {f.facility_id: cubby._facility_today({"timeZone": f.time_zone or cubby.DEFAULT_TZ}).isoformat()
             for f in db.query(models.CubbyFacility).filter(models.CubbyFacility.facility_id.in_(fids)).all()}

    # Live tenancies first, then the newest move-in. What a unit owes is one
    # receivables line per unit and customer, so it shows once: on the first
    # (the live, else the latest) of their tenancies in that unit.
    rentals.sort(key=lambda r: _iso_day(r.move_in_date), reverse=True)
    rentals.sort(key=lambda r: bool(_iso_day(r.move_out_date)) and _iso_day(r.move_out_date) <= today.get(r.facility_id, ""))
    out, billed = [], set()
    for r in rentals:
        d = r.data or {}
        u = units.get((r.facility_id, r.unit_id))
        blob = (u.data or {}) if u is not None else {}
        move_out = _iso_day(r.move_out_date)
        live = not (move_out and move_out <= today.get(r.facility_id, ""))
        rr = _rented_line(u, customer_id) if u is not None and live else {}
        cov = d.get("coverage") or {}
        cov_type = (cov.get("coverageType") or "").upper()
        smo = d.get("scheduledMoveOut") or {}
        x = extras.get((r.facility_id, r.lease_id))
        out.append({
            "leaseId": r.lease_id, "facilityId": r.facility_id, "facilityName": names.get(r.facility_id, ""),
            "unitId": r.unit_id or "",
            "unitName": ((u.unit_name if u is not None else "") or "").strip(),
            "unitSize": _size(blob.get("rentRoll") or {}, blob.get("unit") or {}),
            "moveIn": _iso_day(r.move_in_date), "moveOut": move_out,
            "rentCents": int(d.get("monthlyRentalAmount") or rr.get("monthlyRentalAmount") or 0),
            "paidThrough": _iso_day(rr.get("paidThroughDate")),
            "paid": bool(rr.get("paid")) if "paid" in rr else None,
            "autopay": bool(rr.get("autoPayEnabled")) if rr else None,
            "balanceCents": owed.get((r.facility_id, r.unit_id), 0) if (r.facility_id, r.unit_id) not in billed else 0,
            # Cubby flags the unit and no lock is on it yet - the Operations screen's "to lock" rule.
            "overlockNeeded": bool(rr.get("overlockNeeded")) and not rr.get("overlockApplied"),
            "coverage": ({"type": ops_reports._coverage_label(cov_type), "premiumCents": int(cov.get("premiumAmount") or 0),
                          "amountCents": int(cov.get("coverageAmount") or 0)} if cov_type and cov_type != "NONE" else None),
            "privatePolicy": ({"number": str(d.get("privatePolicyNumber") or ""),
                               "expires": _iso_day(d.get("privatePolicyExpirationDate"))}
                              if d.get("privatePolicyNumber") or d.get("privatePolicyExpirationDate") else None),
            "scheduledMoveOut": ({"date": _iso_day(smo.get("moveOutDate")),
                                  "reason": str(smo.get("reason") or smo.get("moveOutReason") or "")[:200]}
                                 if isinstance(smo, dict) and smo.get("moveOutDate") else None),
            "vehicle": ({"type": x.vehicle_type or "", "plate": x.vehicle_plate or "", "state": x.vehicle_state or ""}
                        if x is not None and (x.vehicle_plate or x.vehicle_type) else None),
            "altContacts": list(x.alt_contacts or []) if x is not None else [],
        })
        billed.add((r.facility_id, r.unit_id))
    return out


def _record(user: dict, customer_id: str, fids: list[str], live: dict) -> dict:
    """Build the record (live values when Cubby answered, the stored copy when
    it did not), bring the stored copy up to date and write the audit row.
    Blocking."""
    db = SessionLocal()
    try:
        T = models.OpsTenant
        cols = [c.name for c in T.__table__.columns]
        rows = [{c: getattr(t, c) for c in cols}
                for t in db.query(T).filter(T.customer_id == customer_id, T.facility_id.in_(fids)).all()]
        if not rows:
            raise HTTPException(status_code=404, detail="Tenant not found")
        rows.sort(key=lambda r: fids.index(r["facility_id"]))
        stamp = _now()
        if live["ok"]:
            try:
                _apply_live(db, rows, live, stamp)
            except Exception as e:  # noqa: BLE001 - the type only: the message can quote a row
                db.rollback()
                live = {"ok": False, "error": type(e).__name__}
                rows = [{c: getattr(t, c) for c in cols}
                        for t in db.query(T).filter(T.customer_id == customer_id, T.facility_id.in_(fids)).all()]
                rows.sort(key=lambda r: fids.index(r["facility_id"]))
        names = _facilities(db)
        # One person, the same in every facility: the row that says the most.
        head = max(rows, key=lambda r: (bool(r["phone"] or r["email"]), r["synced_at"] or ""))
        P = models.CubbyPayment
        pays = (db.query(P).filter(P.customer_id == customer_id, P.facility_id.in_(fids))
                .order_by(P.payment_date.desc(), P.id.desc()).limit(PAYMENTS_SHOWN).all())
        out = {
            "customerId": customer_id, "cubbyUrl": cubby._tenant_url(customer_id),
            "name": head["name"] or "", "firstName": head["first_name"] or "",
            "lastName": head["last_name"] or "", "companyName": head["company_name"] or "", "military": bool(head["military"]),
            "contact": {k: head[k] or "" for k in _CONTACT},
            "commPrefs": head["comm_prefs"] if isinstance(head["comm_prefs"], dict) else None,
            "facilities": [{"facilityId": r["facility_id"], "facilityName": names.get(r["facility_id"], ""),
                            "gateCode": _gate_code(r["gate_code"]), "gateCodeEnabled": bool(r["gate_code_enabled"])}
                           for r in rows],
            "leases": _leases(db, customer_id, fids, names),
            "payments": [{"paymentId": p.payment_id or "", "date": _iso_day(p.payment_date),
                          "amountCents": int(p.amount_cents or 0), "status": (p.status or "").upper(),
                          "method": str((p.data or {}).get("methodType") or "")} for p in pays],
            "live": {"ok": bool(live["ok"]), "asOf": stamp, "error": "" if live["ok"] else live.get("error") or ""},
            "storedAsOf": min((r["synced_at"] or "" for r in rows), default=""),
        }
        _audit(db, user, OPENED, "ops_tenant", customer_id, {"facilities": fids, "live": bool(live["ok"])})
        db.commit()
        return out
    finally:
        db.close()


@router.get("/tenants/{customer_id}")
async def tenant_record(customer_id: str, user: dict = Depends(get_current_user)):
    """One tenant across the facilities the caller sees, re-read live from
    Cubby (LIVE_LIMIT_SEC at most); the stored copy when Cubby does not
    answer. One AuditLog row per open."""
    fids = await asyncio.to_thread(_scope, user, customer_id)
    live = await _read_live(customer_id, fids)
    return await asyncio.to_thread(_record, user, customer_id, fids, live)

