"""Every property-related ticket lands on the property and its unit (Neil,
Ops review Oct 20 2026: "a property-related ticket ... should sit with the
user AND the property ... if every single piece of maintenance doesn't get
connected here from either a task ticket or a manual entry, this whole
concept doesn't work").

property_links.py owns the link itself (soft link, real estate only, closed
tickets are the maintenance record). This module adds what the review asked
for on top of it:

1. RULES (config, NexusSetting `ticket_property_rules`): which tickets MUST
   name a property - the Buildings & Maintenance service area by default,
   plus any extra help topics an admin lists - for a team that may link at
   all (property_links rule 4 still decides that). The service desk and
   guests may file without one; the requester may not.
2. UNIT: free text, checked against the facility's synced Cubby units when
   the property is a Cubby store ("Common Area" always allowed).
3. SUGGEST: proposes properties from a ticket's own words - a street number
   ("26382"), a distinctive name word ("palisades"), the city. A person
   always picks; nothing here links on its own.
4. FACILITY <-> PROPERTY: a Cubby facility is the property whose site model
   carries that `cubbyFacilityId` (matched the way SiteModelSection.jsx
   matchSiteModel does: id, then APN, then exact name), else the property
   named like the facility; an admin override map in the same setting wins.
"""
import json
import re
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy.orm import Session

import models
import property_links

SETTINGS_KEY = "ticket_property_rules"
COMMON_AREA = "Common Area"
UNIT_MAX = 60

DEFAULT_RULES = {
    # Service areas (ticketMeta.js SERVICE_AREAS keys) whose tickets must name
    # a property. "facilities" = Buildings & Maintenance.
    "requiredServiceAreas": ["facilities"],
    # Extra help topics (names, any case) that must name one wherever they file.
    "requiredTopics": [],
    # Cubby facility id -> Asset Management property id. Only needed where the
    # site model / name match below gets it wrong or finds nothing.
    "facilityPropertyMap": {},
}


# ── Rules ─────────────────────────────────────────────────────────────────────

def get_rules(db: Session) -> dict:
    row = db.get(models.NexusSetting, SETTINGS_KEY)
    try:
        saved = json.loads(row.value) if row and row.value else {}
    except (TypeError, ValueError):
        saved = {}
    out = json.loads(json.dumps(DEFAULT_RULES))
    if isinstance(saved.get("requiredServiceAreas"), list):
        out["requiredServiceAreas"] = [str(a).strip().lower() for a in saved["requiredServiceAreas"] if str(a).strip()]
    if isinstance(saved.get("requiredTopics"), list):
        out["requiredTopics"] = [str(a).strip() for a in saved["requiredTopics"] if str(a).strip()]
    if isinstance(saved.get("facilityPropertyMap"), dict):
        out["facilityPropertyMap"] = {str(k).strip(): str(v).strip() for k, v in saved["facilityPropertyMap"].items()
                                      if str(k).strip() and str(v).strip()}
    return out


def save_rules(db: Session, patch: dict, actor: str) -> dict:
    if not isinstance(patch, dict):
        raise HTTPException(400, "Settings must be an object.")
    cur = get_rules(db)
    for key, kind in (("requiredServiceAreas", list), ("requiredTopics", list), ("facilityPropertyMap", dict)):
        if key in patch:
            if not isinstance(patch[key], kind):
                raise HTTPException(400, f"{key} has the wrong shape.")
            cur[key] = patch[key]
    row = db.get(models.NexusSetting, SETTINGS_KEY)
    if row is None:
        row = models.NexusSetting(key=SETTINGS_KEY)
        db.add(row)
    row.value = json.dumps(cur)
    row.updated_by = actor
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    return get_rules(db)


def property_required(db: Session, service_area: str, application: str, rules: dict | None = None) -> bool:
    rules = rules or get_rules(db)
    if (service_area or "").strip().lower() in set(rules["requiredServiceAreas"]):
        return True
    topic = (application or "").strip().lower()
    return bool(topic) and topic in {t.lower() for t in rules["requiredTopics"]}


def takes_property(db: Session, dept_id: str, service_area: str = "") -> bool:
    """May this ticket sit on a property? Only a building / site team's
    (property_links rule 4 - an HR ticket never lands on a property's page,
    whatever topic it was filed under). `service_area` is accepted so the
    callers read the same whichever rule this grows into."""
    return property_links.department_takes_property(db, dept_id)


def require_takes_property(db: Session, dept_id: str, service_area: str) -> None:
    if not takes_property(db, dept_id, service_area):
        property_links.require_department_takes_property(db, dept_id)   # its 400


# ── Facility <-> property ─────────────────────────────────────────────────────

def _norm(s) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()


def _digits(s) -> str:
    return re.sub(r"\D", "", str(s or ""))


def _listed(db: Session) -> list:
    """Real-estate properties (not deleted, not vehicles/equipment). Private
    ones are included: the mapping is a fact about the property, and every
    caller filters what it SHOWS by property_links.viewable."""
    return [p for p in db.query(models.PropertyAsset).all()
            if not (p.payload or {}).get("deleted") and property_links.asset_kind(p) == "property"]


def _site_models() -> list:
    try:
        from routers import site_models
        return site_models.list_models()
    except Exception:   # a broken model file must not take tickets down
        return []


def _match_model(model: dict, props: list):
    """SiteModelSection.jsx matchSiteModel, in reverse: the property a site
    model is about (id, then APN, then exact normalized name)."""
    by_id = next((p for p in props if p.id == model.get("id")), None)
    if by_id is not None:
        return by_id
    apn = _digits(model.get("apn"))
    if apn:
        hit = next((p for p in props if _digits((p.payload or {}).get("apn")) == apn), None)
        if hit is not None:
            return hit
    name = _norm(model.get("name"))
    if name:
        return next((p for p in props if _norm(property_links.display_name(p)) == name), None)
    return None


def property_for_facility(db: Session, facility_id: str):
    fid = (facility_id or "").strip()
    if not fid:
        return None
    props = _listed(db)
    override = get_rules(db)["facilityPropertyMap"].get(fid)
    if override:
        return next((p for p in props if p.id == override), None)
    for m in _site_models():
        if (m.get("cubbyFacilityId") or "") == fid:
            hit = _match_model(m, props)
            if hit is not None:
                return hit
    fac = db.get(models.CubbyFacility, fid)
    if fac is not None:
        names = {_norm(fac.name), _norm((fac.data or {}).get("internalName"))} - {""}
        return next((p for p in props if _norm(property_links.display_name(p)) in names), None)
    return None


def facility_for_property(db: Session, prop) -> str:
    """The Cubby facility a property (or its lead property) is, or ""."""
    if prop is None:
        return ""
    props = _listed(db)
    chain = [prop]
    if prop.parent_id:
        parent = db.get(models.PropertyAsset, prop.parent_id)
        if parent is not None:
            chain.append(parent)
    overrides = get_rules(db)["facilityPropertyMap"]
    models_ = _site_models()
    facilities = db.query(models.CubbyFacility).all()
    for p in chain:
        for fid, pid in overrides.items():
            if pid == p.id:
                return fid
        for m in models_:
            fid = m.get("cubbyFacilityId") or ""
            if fid and fid not in overrides:
                hit = _match_model(m, props)
                if hit is not None and hit.id == p.id:
                    return fid
        name = _norm(property_links.display_name(p))
        for f in facilities:
            if f.facility_id not in overrides and name and name in {_norm(f.name), _norm((f.data or {}).get("internalName"))}:
                return f.facility_id
    return ""


# ── Units ─────────────────────────────────────────────────────────────────────

def cubby_units(db: Session, facility_id: str) -> list:
    if not facility_id:
        return []
    rows = (db.query(models.CubbyUnit.unit_name)
            .filter(models.CubbyUnit.facility_id == facility_id).all())
    return sorted({(r[0] or "").strip() for r in rows if (r[0] or "").strip()},
                  key=lambda s: (re.sub(r"\d+", "", s), int(_digits(s) or 0), s))


def unit_options(db: Session, prop) -> dict:
    """{"units": [...], "source": "cubby"|"property"|"", "strict": bool}.
    strict = a unit must be one of these (a Cubby store's synced units)."""
    if prop is None:
        return {"units": [], "source": "", "strict": False}
    fid = facility_for_property(db, prop)
    units = cubby_units(db, fid)
    if units:
        return {"units": units, "source": "cubby", "strict": True, "facilityId": fid}
    own = [str(u.get("label")).strip() for u in ((prop.payload or {}).get("tenantUnits") or [])
           if isinstance(u, dict) and str(u.get("label") or "").strip()]
    return {"units": own, "source": "property" if own else "", "strict": False, "facilityId": fid}


def clean_unit(db: Session, prop, raw) -> str:
    unit = " ".join(str(raw or "").split())[:UNIT_MAX]
    if not unit:
        return ""
    if prop is None:
        raise HTTPException(400, "Pick the property before the unit.")
    if unit.lower() in ("common area", "common areas"):
        return COMMON_AREA
    opts = unit_options(db, prop)
    match = next((u for u in opts["units"] if u.lower() == unit.lower()), None)
    if match:
        return match
    if opts["strict"]:
        raise HTTPException(400, f"Unit {unit} isn't one of {property_links.display_name(prop)}'s units in Cubby - "
                                 "pick it from the list, or Common Area.")
    return unit


def unit_required(db: Session, prop) -> bool:
    """A Cubby store knows every unit, so a required ticket names one (or
    Common Area). Elsewhere the unit list is whatever someone typed into
    Manage Units - helpful, never demanded."""
    return unit_options(db, prop)["strict"] if prop is not None else False


# ── The ticket create / update hooks (routers/tickets.py) ─────────────────────

def check_intake(db: Session, user: dict, body, prop, service_area: str, desk: bool) -> str:
    """create_ticket: may it link, must it, and its cleaned unit.

    The requirement is for the person raising it. The service desk (filing a
    phone call or an email for someone) and guests may file without one -
    the desk adds it at triage, and Suggest Property Links catches the rest."""
    if prop is not None:
        require_takes_property(db, body.hr_department_id, service_area)
    rules = get_rules(db)
    # "None / Other" is an answer (Neil, Oct 28 2026) - the person said the
    # ticket is not about one of our properties.
    must = (not desk and not (user or {}).get("external")
            and not getattr(body, "property_none", False)
            and property_required(db, service_area, body.application, rules)
            and takes_property(db, body.hr_department_id, service_area))
    if must and prop is None and any(property_links.is_listed(p, user) for p in _listed(db)):
        raise HTTPException(400, "Pick the property this ticket is about - every Buildings & Maintenance "
                                 "ticket sits on its property's Maintenance in Asset Management.")
    unit = clean_unit(db, prop, getattr(body, "property_unit", "")) if prop is not None else ""
    if must and prop is not None and not unit and unit_required(db, prop):
        raise HTTPException(400, f"Pick the unit at {property_links.display_name(prop)}, or Common Area.")
    return unit


def check_update(db: Session, t, data: dict, new_prop) -> None:
    """update_ticket: the unit is checked against the property it ends up on,
    and goes when the property goes or changes (unless a new one is sent)."""
    if "property_asset_id" in data:
        if not data["property_asset_id"]:
            data["property_unit"] = ""
        else:
            data["property_unit"] = clean_unit(db, new_prop, data.get("property_unit") or "")
    elif "property_unit" in data:
        prop = db.get(models.PropertyAsset, t.property_asset_id) if t.property_asset_id else None
        if prop is None and (data["property_unit"] or "").strip():
            raise HTTPException(400, "Pick the property before the unit.")
        data["property_unit"] = clean_unit(db, prop, data["property_unit"]) if prop is not None else ""


# ── Suggest a property from a ticket's words ──────────────────────────────────

# Words every Greens property shares - matching one says nothing.
_STOP = {"greens", "green", "storage", "self", "the", "of", "and", "at", "a", "an", "parcel", "property",
         "llc", "inc", "lp", "site", "facility", "lot", "rd", "road", "st", "street", "ave", "avenue",
         "blvd", "dr", "drive", "ln", "lane", "way", "pkwy", "hwy", "suite", "ste", "unit", "north",
         "south", "east", "west", "n", "s", "e", "w", "ca", "tx", "usa", "us"}
_TAG_RE = re.compile(r"<[^>]+>")


def _words(text: str) -> set:
    return {w for w in _norm(_TAG_RE.sub(" ", text or "")).split() if w}


def suggest(db: Session, text: str, user: dict, limit: int = 5) -> list:
    """Properties a ticket's words point at, best first:
    [{id, name, score, reason}]. Only properties this caller could pick."""
    words = _words(text)
    if not words:
        return []
    out = []
    for p in db.query(models.PropertyAsset).all():
        if not property_links.is_listed(p, user):
            continue
        pl = p.payload or {}
        name = property_links.display_name(p)
        score, reasons = 0, []
        address = str(pl.get("address") or "")
        nums = {w for w in _words(address) if w.isdigit() and len(w) >= 3}
        hit_num = sorted(nums & words)
        if hit_num:
            score += 5
            reasons.append(f'"{hit_num[0]}" is in its address')
        name_words = {w for w in _words(name) if w not in _STOP and len(w) >= 4}
        hit_name = sorted(name_words & words)
        if hit_name:
            score += 3 * len(hit_name)
            reasons.append(f'"{hit_name[0]}" is in its name')
        street = {w for w in _words(address) if not w.isdigit() and w not in _STOP and len(w) >= 4} - name_words
        hit_street = sorted(street & words)
        if hit_street:
            score += 2
            reasons.append(f'"{hit_street[0]}" is in its address')
        city = _norm(pl.get("city"))
        if city and city not in name_words and all(c in words for c in city.split()):
            score += 1
            reasons.append(f'"{pl.get("city")}" is its city')
        if score >= 2:
            out.append({"id": p.id, "name": name, "score": score, "reason": "; ".join(reasons),
                        "parentId": p.parent_id or None})
    out.sort(key=lambda x: (-x["score"], x["parentId"] is not None, x["name"].lower()))
    return out[:limit]


def suggest_unit(db: Session, prop, text: str) -> str:
    """A unit named in the ticket's words, when it is one of the property's."""
    if prop is None:
        return ""
    words = {w.upper() for w in re.findall(r"[A-Za-z]*\d+[A-Za-z0-9-]*", _TAG_RE.sub(" ", text or ""))}
    if not words:
        return ""
    for u in unit_options(db, prop)["units"]:
        if u.upper() in words:
            return u
    return ""
