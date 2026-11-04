"""Tickets <-> Asset Management properties (Property Tickets, Neil 10/05/2026).

A ticket can be about one property; the property's Maintenance section shows
its open tickets and turns its closed ones into maintenance history; a
walkthrough files many tickets at one property in one go. The rules live here
so tickets.py and the property-ticket endpoints cannot drift:

1. The link is SOFT: task_tickets.property_asset_id holds a PropertyAsset.id
   (precedent: IrFund.property_asset_id). No foreign key - PUT
   /property-assets/workspace deletes and re-inserts every property row on
   each save, so an FK would block every save or cascade into tickets.
2. Nothing here WRITES the Asset Management workspace. A closed ticket is a
   maintenance record by derivation (is_maintenance_record), never an inserted
   property_records row: the next whole-workspace save from any tab that had
   not pulled it would erase it, and the module's local/IndexedDB reconcile
   (asset/lib/sync.js) could resurrect it after a reopen.
3. Only real estate is linkable - never a deleted, vehicle or equipment
   asset, and never a private one for someone Asset Management would hide it
   from (asset/App.jsx canSeePrivate).
4. Only BUILDING tickets are linkable (department_takes_property): a ticket
   on a property is shown to the asset team, so an HR / Payroll / Admin
   ticket must never be able to land there.
5. A closed property ticket IS the maintenance record, so it is protected:
   no delete and no re-point while Resolved/Closed (guard_record).
6. The asset manager is told about NEW tickets; they are not auto-added as
   a watcher (every status move bells every watcher - "one per item").
   Follow is an opt-in for editors and the property's manager (may_follow).
"""
import re
from decimal import Decimal, InvalidOperation

from fastapi import HTTPException

import models

CLOSED_STATES = ("resolved", "closed")
# Closed, but nothing was done to the building: never a maintenance record,
# never counted in a property's spend. decide_approval closes a rejected
# request as wont_fix, so a refused request lands here too.
NO_WORK_RESOLUTIONS = frozenset({"duplicate", "wont_fix", "cannot_reproduce"})

# Help topic (lower-cased) -> the maintenance log's System / Area option
# (asset/lib/recordTypes.jsx). Unlisted topics file as General Repair.
TOPIC_SYSTEM = {
    "lights or electrical": "Electrical",
    "plumbing or water leak": "Plumbing",
    "heating or cooling (hvac)": "HVAC",
    "doors, gates or locks": "Security / Access",
    "roof or ceiling leak": "Roofing",
    "building damage or repair": "Structural",
    "parking lot or paving": "Parking / Pavement",
    "landscaping or snow removal": "Landscaping / Grounds",
    "pest control": "Pest Control",
    "cleaning": "General Repair",
    "signs": "Other",
    "painting": "Painting",
    "flooring or tile": "Flooring",
    "appliances": "Appliance",
    "railings or stairs": "Structural",
    "cameras": "Security / Access",
    "gate access": "Security / Access",
    "gate codes": "Security / Access",
}

# Help-topic service areas that are about a place (ticket_taxonomy topics):
# buildings, site operations, site security (cameras, gates, gate codes).
PROPERTY_AREAS = frozenset({"facilities", "storageops", "security"})

_PRIVATE_ROLE = re.compile(r"owner|officer|exec|admin", re.I)
_MONEY = re.compile(r"^\d{1,9}(\.\d{1,2})?$")


def can_see_private(user: dict) -> bool:
    """Server mirror of asset/App.jsx canSeePrivate."""
    user = user or {}
    return user.get("level", 0) >= 5 or bool(_PRIVATE_ROLE.search(user.get("role") or ""))


def asset_kind(prop) -> str:
    """Server mirror of asset/lib/vehicleFields.js inferAssetKind - keep in step."""
    pl = prop.payload or {}
    if pl.get("kind"):
        return str(pl["kind"])
    a = str(prop.asset_type or pl.get("assetType") or "").lower()
    if "vehicle" in a:
        return "vehicle"
    if "equipment" in a:
        return "equipment"
    return "property"


def viewable(prop, user) -> bool:
    """May this caller see this asset at all (exists, not hidden as private)."""
    return prop is not None and not ((prop.payload or {}).get("private") and not can_see_private(user))


_UNSET = object()


def asset_scope(db, user):
    """The caller's property-asset scope rows (nexus_access_scopes): None =
    every asset, else the ids they are narrowed to - the rule
    routers/property_assets._reach applies to the workspace."""
    from auth import scoped_ids
    return scoped_ids(((user or {}).get("email") or ""), "property-asset", db) if db is not None else None


def in_scope(prop, allowed) -> bool:
    return allowed is None or (prop is not None and prop.id in allowed)


def is_listed(prop, user, db=None, allowed=_UNSET) -> bool:
    """Offered in the ticket property picker / accepted as a link target.
    With `db` (or a precomputed `allowed`), the caller's property-asset scope
    rows narrow it too (review, 11/03/2026) - a person narrowed to some
    properties never lists, links or scans another."""
    if allowed is _UNSET:
        allowed = asset_scope(db, user)
    return (viewable(prop, user) and not (prop.payload or {}).get("deleted")
            and asset_kind(prop) == "property" and in_scope(prop, allowed))


# ── An asset's company (Neil, 11/03/2026: "A company field on asset
# management would replace the inferred company") ─────────────────────────────
# The asset row's own `companyId` (payload key, an HrEntity id) is THE answer,
# set on the asset's Details and in Add Asset, validated on the per-row save
# (routers/property_assets._check_company). Every reader asks
# `property_company`; the inference below is only the fallback for a row that
# has none yet - asset_company_fill sets every placeable row ONCE from it, and
# the rows it cannot place wait under Asset Management's "Needs a Company".

AMBIGUOUS = object()
_FALLBACK_LOGGED: set = set()


def entity_ids_by_name(db) -> dict:
    """{company name or legal name (lower): HrEntity id, or AMBIGUOUS when
    two companies answer to it}."""
    out: dict = {}
    for e in db.query(models.HrEntity.id, models.HrEntity.name, models.HrEntity.legal_name).all():
        for n in {(e.name or "").strip().lower(), (e.legal_name or "").strip().lower()} - {""}:
            out[n] = AMBIGUOUS if (n in out and out[n] != e.id) else e.id
    return out


def stored_company(db, prop) -> str:
    """The Company field as saved on the row - '' when blank, or when it names
    a company that no longer exists."""
    if prop is None:
        return ""
    cid = str((prop.payload or {}).get("companyId") or "").strip()
    return cid if cid and db.get(models.HrEntity, cid) is not None else ""


MANAGER_GUESS = "its asset manager's company"


def infer_company(db, prop, names=None, _lead: bool = True, strong: bool = False) -> tuple:
    """(company id, how) from what the row says about itself, never its
    Company field: its Operating Entity matched to exactly ONE company (name
    or legal name - a name two companies share places nothing), else, for a
    parcel, its lead property's company, else its asset manager's company.
    ('', '') when nothing places it. `how` is the Activity Log wording.

    `strong=True` stops before the asset manager: who manages a property is
    a weak guess at who owns it, good enough for a read while the field is
    blank, never written to the row (review, 11/03/2026 - the one-time fill
    asks with strong=True)."""
    if prop is None:
        return "", ""
    pl = prop.payload or {}
    entity = str(pl.get("entity") or "").strip().lower()
    if entity:
        names = names if names is not None else entity_ids_by_name(db)
        hit = names.get(entity, "")
        if hit and hit is not AMBIGUOUS:
            return hit, "its Operating Entity"
    parent_id = (prop.parent_id or str(pl.get("parentId") or "")).strip()
    if _lead and parent_id and parent_id != prop.id:
        lead = db.get(models.PropertyAsset, parent_id)
        cid, how = stored_company(db, lead), "its lead property"
        if not cid:
            cid, lead_how = infer_company(db, lead, names, _lead=False, strong=strong)
            # A lead placed only by its manager is the same weak guess for its parcel.
            how = MANAGER_GUESS if lead_how == MANAGER_GUESS else how
        if cid:
            return cid, how
    if strong:
        return "", ""
    mgr = manager_email(db, prop)
    if mgr:
        from sqlalchemy import func
        emp = (db.query(models.NexusEmployee)
               .filter(func.lower(models.NexusEmployee.work_email) == mgr).first())
        cid = ((emp.company if emp is not None else "") or "").strip()
        if cid and db.get(models.HrEntity, cid) is not None:
            return cid, MANAGER_GUESS
    return "", ""


def property_company(db, prop) -> str:
    """THE company (HrEntity id) an Asset Management asset belongs to: its
    Company field; only while that is blank, the inference (logged once per
    asset per process, so a fallback still in use shows in the log). '' =
    unknown. A preventive schedule's team, a construction job's company and
    the tag sheet's company name all read this - never a second rule."""
    if prop is None:
        return ""
    cid = stored_company(db, prop)
    if cid:
        return cid
    cid, how = infer_company(db, prop)
    if cid and prop.id not in _FALLBACK_LOGGED:
        _FALLBACK_LOGGED.add(prop.id)
        print(f"[property-company] {prop.id}: no Company set - inferred from {how} ({cid})")
    return cid


def display_name(prop) -> str:
    return (prop.name or (prop.payload or {}).get("name") or prop.id or "").strip()


def require_linkable(db, property_id: str, user: dict):
    pid = (property_id or "").strip()
    prop = db.get(models.PropertyAsset, pid) if pid else None
    if prop is None or not is_listed(prop, user, db):
        raise HTTPException(400, "That property is not available in Asset Management - pick another one.")
    return prop


def group_ids(db, prop, user) -> list:
    """The property plus, for a lead property, the parcels THIS caller could
    open on their own: not deleted, and not private unless they can see
    private assets. A parcel they would get a 404 on must not leak its name,
    tickets, notes or spend through its lead property's roll-up."""
    if prop.parent_id:
        return [prop.id]
    kids = db.query(models.PropertyAsset).filter(models.PropertyAsset.parent_id == prop.id).all()
    return [prop.id] + [k.id for k in kids
                        if viewable(k, user) and not (k.payload or {}).get("deleted")]


def manager_email(db, prop) -> str:
    """The property's PM / Asset Manager - the one resolver the date alerts
    already use (contact map, then name lookup, then the parent's manager)."""
    if prop is None:
        return ""
    import equipment_reminders as er
    props = {p.id: p for p in db.query(models.PropertyAsset).all()}
    return (er.asset_manager_email(prop, props, er._People(db)) or "").strip().lower()


def department_takes_property(db, dept_id: str) -> bool:
    """May a ticket for this department be linked to a property? Yes when the
    department's help-topic group (matched by department name, the same match
    the form's helpGroupFor makes) has a facilities / site-ops / site-security
    topic. HR, Payroll, Admin, Accounting: no - those tickets are about
    people and money, and a linked ticket is shown to the asset team."""
    from routers import tickets as T
    import ticket_taxonomy
    name = (T.dept_name(db, dept_id) or "").strip().lower()
    if not name:
        return False
    for g in ticket_taxonomy.get_config(db).get("helpTopics") or []:
        if name in {str(d).strip().lower() for d in (g.get("departments") or [])}:
            return any((tp or {}).get("area") in PROPERTY_AREAS for tp in (g.get("topics") or []))
    return False


def require_department_takes_property(db, dept_id: str) -> None:
    if not department_takes_property(db, dept_id):
        raise HTTPException(400, "Tickets for this team aren't linked to properties - "
                                 "pick a building or site team, or leave Property empty.")


def guard_record(t, action: str) -> None:
    """A Resolved/Closed ticket on a property is that property's maintenance
    record (derived, so its source row must not vanish or move). Reopen it
    first - which is logged - to correct a mistake."""
    if (t.property_asset_id or "") and (t.status or "") in CLOSED_STATES:
        name = t.property_name or "this property"
        if action == "delete":
            raise HTTPException(409, f"This ticket is part of {name}'s maintenance history. "
                                     "Reopen it and remove the property first if it was filed by mistake.")
        raise HTTPException(409, "Reopen the ticket to move it to another property - "
                                 f"while closed it is part of {name}'s maintenance history.")


def _grant_rank(db, user: dict, *modules: str) -> int:
    from auth import _grants_for
    grants = _grants_for((user or {}).get("email") or "", db)
    return max((grants.get(m, 0) for m in modules), default=0)


def is_asset_editor(db, user: dict) -> bool:
    from auth import _LEVELS, _MODULE_LEVEL_RANK
    user = user or {}
    if user.get("external"):
        return False
    if user.get("level", 0) >= _LEVELS["administrator"]:
        return True
    return _grant_rank(db, user, "property-asset") >= _MODULE_LEVEL_RANK["editor"]


def is_asset_reader(db, user: dict) -> bool:
    """May open Asset Management at all (the property-asset viewer grant, or
    an administrator) - what the scanned place sheet shows a ticket summary to."""
    from auth import _LEVELS, _MODULE_LEVEL_RANK
    user = user or {}
    if user.get("external"):
        return False
    if user.get("level", 0) >= _LEVELS["administrator"]:
        return True
    return _grant_rank(db, user, "property-asset") >= _MODULE_LEVEL_RANK["viewer"]


def may_follow(db, user: dict, prop) -> bool:
    """Follow = become a watcher = open the ticket's whole thread. That IS a
    widening of the ticket ACL, so it is not self-service for a read-only
    asset viewer: asset editors, administrators, and the property's own asset
    manager only."""
    me = ((user or {}).get("email") or "").strip().lower()
    return is_asset_editor(db, user) or (bool(me) and me == manager_email(db, prop))


def may_walkthrough(db, user: dict) -> bool:
    """The service desk, the Asset Management team, administrators. Never a
    guest. Raising ONE ticket stays open to everyone - this is the 50-ticket
    button."""
    from auth import _LEVELS, _MODULE_LEVEL_RANK
    user = user or {}
    if user.get("external"):
        return False
    if user.get("level", 0) >= _LEVELS["administrator"]:
        return True
    return _grant_rank(db, user, "property-asset", "tasks", "tickets") >= _MODULE_LEVEL_RANK["viewer"]


def system_for(application: str) -> str:
    return TOPIC_SYSTEM.get((application or "").strip().lower(), "General Repair")


def is_maintenance_record(t) -> bool:
    return ((t.status or "") in CLOSED_STATES
            and (t.resolution or "") not in NO_WORK_RESOLUTIONS
            and (t.approval_status or "none") != "rejected")


def normalize_cost(raw) -> str:
    """'$1,250.5' -> '1250.50'; '' -> ''. Anything else is a 400."""
    s = str(raw if raw is not None else "").strip().replace("$", "").replace(",", "")
    if not s:
        return ""
    if not _MONEY.match(s):
        raise HTTPException(400, "Cost must be an amount like 1250 or 1250.50.")
    try:
        return str(Decimal(s).quantize(Decimal("0.01")))
    except InvalidOperation:
        raise HTTPException(400, "Cost must be an amount like 1250 or 1250.50.")


def cost_value(s: str) -> Decimal:
    try:
        return Decimal(s or "0")
    except InvalidOperation:
        return Decimal("0")
