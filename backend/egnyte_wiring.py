"""Egnyte wiring registry - the UI-editable layer between Nexus surfaces and
Egnyte folders (Neil, Aug 6 call).

A "slot" is a named place in Nexus that reads or writes Egnyte: the property
documents panel, a person's documents folder, the construction upload root.
KNOWN_SLOTS below is the single registry of slots code actually consumes -
the Wiring tab renders exactly this list, so a slot nobody consumes cannot be
configured and silently do nothing.

Resolution order for every slot, strongest first:
  1. an EgnyteWiring row with a matching non-empty scope_id (per-person /
     per-property override) - wins outright, used verbatim;
  2. the slot's default row (scope_id='') - a path template;
  3. the legacy env var(s) the slot replaced (so existing deployments keep
     behaving until someone edits the wiring in the UI);
  4. the hardcoded default.

Templates carry placeholders filled from the record being resolved:
  {entity}   - legal entity/company folder name (HrEntity.name)
  {bucket}   - "Contractors" or "Employees" (from employment_type)
  {person}   - the person's display name
  {email}    - the person's work email
  {property} - the property/site name
Person folders in the tenant carry suffixes Nexus doesn't know ("Aarav Mehta
- 1982"), so after filling a person template the LAST segment is matched
against the real children of its parent folder (exact, then prefix, then
substring - same philosophy as services/egnyte.py property resolution).
"""
import os
import time

from database import SessionLocal
import cache

# ── slot registry ────────────────────────────────────────────────────────────
# `kind`: 'path' = one folder/template; 'csv' = comma-separated list of paths.
# `env`: legacy env vars consulted (in order) when no wiring row exists.
KNOWN_SLOTS = [
    {
        "slot": "people.person-folder",
        "group": "People documents",
        "label": "Person folder (HR view)",
        "description": "The person's whole Egnyte folder, shown on the HR person card. "
                       "Includes every subfolder (Confidential too), so this surface stays HR-only.",
        "kind": "path",
        "placeholders": ["entity", "bucket", "person", "email"],
        "env": [],
        "default": "/Shared/#Entities/{entity}/Human Resources/{bucket}/{person}",
        "overrides": "person",
    },
    {
        "slot": "people.my-documents",
        "group": "People documents",
        "label": "My Documents (employee view)",
        "description": "What a person sees under My HR - My Documents. Deliberately a SUBFOLDER "
                       "of the person folder: the Confidential folder (Aadhaar/PAN) next to it "
                       "must never be wired here.",
        "kind": "path",
        "placeholders": ["entity", "bucket", "person", "email"],
        "env": [],
        "default": "/Shared/#Entities/{entity}/Human Resources/{bucket}/{person}/Contractor Documents",
        "overrides": "person",
    },
    {
        "slot": "property.roots",
        "group": "Property / Asset Management",
        "label": "Property search roots",
        "description": "Where a property's folder is looked for, in priority order. "
                       "First root that contains a matching folder wins.",
        "kind": "csv",
        "placeholders": [],
        "env": ["EGNYTE_PROPERTIES_ROOTS", "EGNYTE_PROPERTIES_ROOT"],
        "default": "/Shared/#Entities,/Shared/--Asset Management",
        "overrides": None,
    },
    {
        "slot": "property.plans-subfolders",
        "group": "Property / Asset Management",
        "label": "Plans subfolder names",
        "description": "Subfolder names (in order) that hold a property's documents/plans. "
                       "The first name that actually exists inside the property folder wins.",
        "kind": "csv",
        "placeholders": [],
        "env": ["EGNYTE_PLANS_SUBFOLDER"],
        "default": "Property Plans and Maps,Properties",
        "overrides": None,
    },
    {
        "slot": "property.create-root",
        "group": "Property / Asset Management",
        "label": "New property folders go under",
        "description": "Where the Create Folder flow makes a folder for a property that has none. "
                       "Deliberately not the entity register.",
        "kind": "path",
        "placeholders": [],
        "env": ["EGNYTE_CREATE_ROOT"],
        "default": "/Shared/--Asset Management",
        "overrides": None,
    },
    {
        "slot": "construction.root",
        "group": "Construction",
        "label": "Construction fallback root",
        "description": "Where a construction project's daily-log media lands when the project "
                       "has no linked property. The project name is appended.",
        "kind": "path",
        "placeholders": [],
        "env": ["EGNYTE_CONSTRUCTION_ROOT"],
        "default": "/Shared/--Asset Management",
        "overrides": None,
    },
    {
        "slot": "esign.default-folder",
        "group": "E-Sign",
        "label": "Default sealed-document folder",
        "description": "Pre-fills the 'Signed document location - Egnyte' field on new e-sign "
                       "templates. Each template can still be pointed elsewhere.",
        "kind": "path",
        "placeholders": [],
        "env": [],
        "default": "",
        "overrides": None,
    },
]

_SLOT_IDS = {s["slot"] for s in KNOWN_SLOTS}
_SLOTS_BY_ID = {s["slot"]: s for s in KNOWN_SLOTS}


def known_slot(slot: str) -> dict | None:
    return _SLOTS_BY_ID.get(slot)


# ── cached row access ────────────────────────────────────────────────────────
# One cache entry holds the WHOLE table as {(slot, scope_id): path} - it is a
# handful of rows, and loading it all means every resolution in the TTL window
# is a dict lookup. Invalidated on write via cache._WATCHED ("EgnyteWiring").

_ALL_KEY = "all"


def _rows() -> dict:
    got = cache.egnyte_wirings.get(_ALL_KEY)
    if got is not None:
        return got
    from models import EgnyteWiring
    db = SessionLocal()
    try:
        rows = {(r.slot, r.scope_id or ""): r.path for r in db.query(EgnyteWiring).all()}
    except Exception:
        return {}          # never let wiring lookup break a surface; fall back to defaults
    finally:
        db.close()
    cache.egnyte_wirings.set(_ALL_KEY, rows)
    return rows


def raw_value(slot: str, scope_id: str = "") -> str | None:
    """The stored wiring for (slot, scope_id), or None if unset."""
    return _rows().get((slot, (scope_id or "").lower() if scope_id else ""))


def effective(slot: str) -> tuple[str, str]:
    """The slot's default-template value and where it came from:
    ('custom' | 'env' | 'default'). Overrides are per-record and not part of
    this - callers resolving a specific record check raw_value(slot, scope)."""
    spec = _SLOTS_BY_ID.get(slot)
    if spec is None:
        return "", "default"
    stored = raw_value(slot)
    if stored:
        return stored, "custom"
    for var in spec["env"]:
        v = os.getenv(var, "").strip()
        if v:
            return v, "env"
    return spec["default"], "default"


# ── person-folder resolution ─────────────────────────────────────────────────

def _person_context(emp, db) -> dict:
    """Placeholder values for one NexusEmployee row."""
    entity_name = ""
    if getattr(emp, "company", ""):
        from models import HrEntity
        ent = db.query(HrEntity).filter(HrEntity.id == emp.company).first()
        entity_name = (ent.name if ent else "") or ""
    person = (getattr(emp, "display_name", "") or "").strip() \
        or f"{(emp.first_name or '').strip()} {(emp.last_name or '').strip()}".strip()
    bucket = "Contractors" if (emp.employment_type or "") == "contractor" else "Employees"
    return {
        "entity": entity_name,
        "bucket": bucket,
        "person": person,
        "email": (emp.work_email or "").lower(),
    }


def fill(template: str, ctx: dict) -> str:
    out = template
    for k, v in ctx.items():
        out = out.replace("{%s}" % k, v)
    return out


def _match_last_segment(path: str) -> str | None:
    """Fix up the LAST segment of `path` against the real folder names in its
    parent, because tenant folders carry suffixes/variants the template can't
    know. Exact (case-insensitive) -> prefix -> substring; None when the parent
    lists fine but nothing matches (a genuinely missing person folder)."""
    from services import egnyte as svc
    p = svc.norm(path)
    parent, _, want = p.rpartition("/")
    want_l = want.lower()
    if not parent or not want_l:
        return p
    try:
        names = [f["name"] for f in svc.list_folder(parent)["folders"]]
    except svc.EgnyteError:
        return None
    for matches in (
        lambda n: n.lower() == want_l,
        lambda n: n.lower().startswith(want_l),
        lambda n: want_l in n.lower(),
    ):
        for n in names:
            if matches(n):
                return svc.norm(f"{parent}/{n}")
    return None


def resolve_person_folder(slot: str, emp, db) -> dict:
    """Resolve a person-scoped slot for one employee.

    Returns {"folder": str|None, "source": "override"|"template",
             "proposed": str} - folder None means nothing exists in Egnyte yet;
    `proposed` is the filled template for a create-it flow or error message.
    An explicit per-person override is trusted verbatim (the manager pointed at
    a real folder; re-matching it could only un-fix what they fixed)."""
    email = (getattr(emp, "work_email", "") or "").lower()
    override = raw_value(slot, email)
    if override:
        return {"folder": override, "source": "override", "proposed": override}

    template, _src = effective(slot)
    ctx = _person_context(emp, db)
    filled = fill(template, ctx)
    if "{" in filled or not ctx["person"]:
        # a placeholder had no value (no company set, no name) - unresolvable
        return {"folder": None, "source": "template", "proposed": filled}

    # For my-documents the person segment is not last (".../{person}/Contractor
    # Documents") - match the PERSON segment, then re-append what follows.
    person_prefix = fill(template.split("{person}")[0] + "{person}", ctx) if "{person}" in template else filled
    suffix = filled[len(person_prefix):]
    matched = _match_last_segment(person_prefix)
    if matched is None:
        return {"folder": None, "source": "template", "proposed": filled}
    return {"folder": matched + suffix, "source": "template", "proposed": filled}


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
