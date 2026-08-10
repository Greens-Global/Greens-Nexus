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


def _fold(s: str) -> str:
    """Comparison key: lowercase, punctuation dropped, whitespace collapsed -
    so "GGCon Pvt Ltd." (the HR entity name) matches the real Egnyte folder
    "GGCon Pvt. Ltd (India)" instead of failing on a dot."""
    out = "".join(c for c in (s or "").lower() if c not in ".,'’")
    return " ".join(out.split())


def _match_path(path: str) -> str | None:
    """Resolve `path` against what actually exists, matching EVERY segment
    (not just the person at the end) - real folder names carry punctuation,
    legal suffixes and per-person suffixes the template can't know
    ("GGCon Pvt. Ltd (India)", "Aarav Mehta - 1982"). Per segment: exact
    folded match -> folded prefix -> folded substring, first hit wins. None
    when some segment matches nothing (a genuinely missing folder)."""
    from services import egnyte as svc
    segs = [s for s in svc.norm(path).split("/") if s]
    cur = ""
    for seg in segs:
        try:
            names = [f["name"] for f in svc.list_folder(cur or "/")["folders"]]
        except svc.EgnyteError:
            return None
        want = _fold(seg)
        hit = None
        for matches in (
            lambda n: _fold(n) == want,
            lambda n: _fold(n).startswith(want),
            lambda n: want in _fold(n),
        ):
            hit = next((n for n in names if matches(n)), None)
            if hit:
                break
        if not hit:
            return None
        cur = f"{cur}/{hit}"
    return svc.norm(cur)


# ── folder groups (rule-based cohort wiring) ────────────────────────────────
# RULE_FIELDS is the closed vocabulary a rule may use - the AI parser is told
# exactly these and nothing else, so a prompt can only ever produce conditions
# the matcher below actually understands.
RULE_FIELDS = {
    "entity_country":  "Country of the person's employing legal entity (hr_entities.country): US, IN, ...",
    "company":         "Employing legal entity, by name (hr_entities.name)",
    "department":      "Department name on the person",
    "division":        "Functional division on the person",
    "employment_type": "full_time | part_time | contractor | intern",
    "status":          "onboarding | active | inactive",
    "location":        "Person's location field (substring match)",
    "pay_type":        "hourly (paid on the biweekly cycle - 'biweekly salary') | fixed (monthly salary)",
    "pay_currency":    "USD | INR (payroll currency)",
}


def _rule_context(db) -> dict:
    """Prefetched lookups one rule evaluation sweep needs - entities by id and
    payroll rows by email - so matching 60 people is 2 queries, not 120."""
    from models import HrEntity
    ents = {e.id: e for e in db.query(HrEntity).all()}
    pay = {}
    try:
        from models import PayrollRate
        pay = {(r.employee_email or "").lower(): r for r in db.query(PayrollRate).all()}
    except Exception:
        pass
    return {"entities": ents, "payroll": pay}


def person_matches(emp, rule: list, rctx: dict) -> bool:
    """Does this employee satisfy EVERY condition of `rule`?
    Comparisons are folded (case/punctuation-insensitive); unknown fields fail
    closed so a malformed rule matches nobody rather than everybody."""
    ent = rctx["entities"].get(emp.company or "")
    pay = rctx["payroll"].get((emp.work_email or "").lower())
    for cond in (rule or []):
        field = (cond.get("field") or "").strip()
        want = _fold(str(cond.get("value") or ""))
        if not field or not want:
            return False
        if field == "entity_country":
            got = _fold(getattr(ent, "country", "") or "")
        elif field == "company":
            got = _fold(getattr(ent, "name", "") or "")
        elif field == "department":
            got = _fold(emp.department or "")
        elif field == "division":
            got = _fold(getattr(emp, "division", "") or "")
        elif field == "employment_type":
            got = _fold(emp.employment_type or "")
        elif field == "status":
            got = _fold(emp.status or "active")
        elif field == "location":
            if want not in _fold(emp.location or ""):
                return False
            continue
        elif field == "pay_type":
            got = _fold(getattr(pay, "pay_type", "") or "")
        elif field == "pay_currency":
            got = _fold(getattr(pay, "currency", "") or "")
        else:
            return False
        if got != want:
            return False
    return True


def _groups(db) -> list:
    """Enabled folder groups, newest first (cached alongside the wirings)."""
    got = cache.egnyte_wirings.get("groups")
    if got is not None:
        return got
    from models import EgnyteFolderGroup
    try:
        rows = (db.query(EgnyteFolderGroup)
                .filter(EgnyteFolderGroup.enabled == 1)
                .order_by(EgnyteFolderGroup.created_at.desc()).all())
        rows = [{"id": r.id, "name": r.name, "rule": r.rule or [], "path": r.path} for r in rows]
    except Exception:
        return []
    cache.egnyte_wirings.set("groups", rows)
    return rows


def group_for_person(emp, db) -> dict | None:
    groups = _groups(db)
    if not groups:
        return None
    rctx = _rule_context(db)
    for g in groups:
        if g["rule"] and person_matches(emp, g["rule"], rctx):
            return g
    return None


def people_matching(rule: list, db) -> list:
    """Every current (non-offboarded, mailboxed) employee the rule matches."""
    from models import NexusEmployee
    if not rule:
        return []
    rctx = _rule_context(db)
    rows = (db.query(NexusEmployee)
            .filter(NexusEmployee.status != "offboarded")
            .filter(NexusEmployee.work_email != "").all())
    return [e for e in rows if person_matches(e, rule, rctx)]


def person_label(emp) -> str:
    return (getattr(emp, "display_name", "") or "").strip() \
        or f"{(emp.first_name or '').strip()} {(emp.last_name or '').strip()}".strip()


def resolve_person_folder(slot: str, emp, db) -> dict:
    """Resolve a person-scoped slot for one employee.

    Returns {"folder": str|None, "source": "override"|"template",
             "proposed": str} - folder None means nothing exists in Egnyte yet;
    `proposed` is the filled template for a create-it flow or error message.
    An explicit per-person override is trusted verbatim (the manager pointed at
    a real folder; re-matching it could only un-fix what they fixed).

    people.my-documents additionally inherits a people.person-folder override:
    pointing a person's FOLDER at the right place in the Wiring tab is one
    action, and their My Documents follows it (person folder + the template's
    subfolder tail) instead of needing a second override."""
    email = (getattr(emp, "work_email", "") or "").lower()
    override = raw_value(slot, email)
    if override:
        return {"folder": override, "source": "override", "proposed": override}

    template, _src = effective(slot)
    ctx = _person_context(emp, db)

    if slot == "people.my-documents":
        pf_override = raw_value("people.person-folder", email)
        if pf_override:
            tail = fill(template.split("{person}", 1)[1], ctx) if "{person}" in template else ""
            folder = pf_override.rstrip("/") + tail
            return {"folder": folder, "source": "override", "proposed": folder}

    # Folder group: a rule-matched cohort parent beats the template. The person
    # is a SUBFOLDER of the group's folder (matched by name, same folding as
    # everywhere); my-documents keeps its template tail under that.
    grp = group_for_person(emp, db) if ctx["person"] else None
    if grp:
        tail = fill(template.split("{person}", 1)[1], ctx) if "{person}" in template else ""
        proposed = f"{grp['path'].rstrip('/')}/{ctx['person']}{tail}"
        matched = _match_path(f"{grp['path'].rstrip('/')}/{ctx['person']}")
        if matched:
            return {"folder": matched + tail, "source": "group", "proposed": proposed}
        return {"folder": None, "source": "group", "proposed": proposed}

    filled = fill(template, ctx)
    if "{" in filled or not ctx["person"]:
        # a placeholder had no value (no company set, no name) - unresolvable
        return {"folder": None, "source": "template", "proposed": filled}

    matched = _match_path(filled)
    if matched is None and "{bucket}" in template:
        # Nexus employment_type and the tenant's filing don't always agree
        # (a Full-Time hire filed under Contractors). Try the other bucket
        # before giving up - reality in Egnyte wins over the HR field.
        other = "Employees" if ctx["bucket"] == "Contractors" else "Contractors"
        matched = _match_path(fill(template, {**ctx, "bucket": other}))
    if matched is None:
        return {"folder": None, "source": "template", "proposed": filled}
    return {"folder": matched, "source": "template", "proposed": filled}


def provision_person_folder(emp, db) -> str:
    """Create the person's standard Egnyte folder set (Neil's taxonomy: the
    person folder plus "Contractor Documents" and "Confidential") under the
    wired location, and return the created/existing folder path.

    The PARENT (entity/HR/bucket) must already exist - it is matched with the
    same folded per-segment logic as resolution, so punctuation drift doesn't
    block creation. Only the person leaf and its two subfolders are created:
    a person card must never be able to invent an entity register entry.
    Raises ValueError with a human message when the parent can't be found."""
    from services import egnyte as svc
    existing = resolve_person_folder("people.person-folder", emp, db)
    if existing["folder"]:
        folder = existing["folder"]
    else:
        ctx = _person_context(emp, db)
        if not ctx["person"]:
            raise ValueError("This person has no name in People, so there is no folder to create.")
        grp = group_for_person(emp, db)
        if grp:
            # The group's path was verified to exist when the group was saved.
            folder = svc.norm(f"{grp['path']}/{ctx['person']}")
        else:
            template, _src = effective("people.person-folder")
            filled = fill(template, ctx)
            if "{" in filled:
                raise ValueError("This person is missing a company or name in People, so there is no wired location to create the folder in.")
            parent_t, _, leaf = filled.rpartition("/")
            parent = _match_path(parent_t)
            if parent is None and "{bucket}" in template:
                other = "Employees" if ctx["bucket"] == "Contractors" else "Contractors"
                parent = _match_path(fill(template, {**ctx, "bucket": other}).rpartition("/")[0])
            if parent is None:
                raise ValueError(f"The parent folder for this person ({parent_t}) does not exist in Egnyte yet - create the entity's HR folders there first.")
            folder = svc.norm(f"{parent}/{leaf}")
        svc.create_folder(folder)
    for sub in ("Contractor Documents", "Confidential"):
        try:
            svc.create_folder(f"{folder}/{sub}")
        except svc.EgnyteError:
            pass    # subfolder is a nicety; the person folder is the point
    return folder


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
