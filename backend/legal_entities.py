"""Accounting > Entities (Neil, 11/17/2026) - the rules. Pure functions only.

An entity is an Intacct entity (location) code. Its legal record lives in
`legal_entities` (models.LegalEntity); its figures are read live from the
books; its owners are either a deal's members in Investor Relations (an entity
that IS a deal) or `legal_entity_owners` rows (every other entity) - one home
per entity, never both. The routes (routers/accounting_entities.py) read the
rows and the books and hand them in here.

Structure charts follow the convention tax and legal teams draw them in, by
the entity's TAX classification (what the IRS sees it as):

    corporation  rectangle            (C or S corporation; an S is marked "S")
    partnership  triangle             (multi-member LLC, LP, GP)
    disregarded  rectangle + oval     (single-member LLC)
    trust        octagon
    individual   circle               (a person, an IRA)
    unknown      dashed rectangle     (not set yet)

`shape_of` is the ONE place that decides it; the frontend's legend and
diagrams read the shape key, never the type.
"""
from __future__ import annotations

import re
from datetime import date

ENTITY_TYPES = {
    "llc_single": "Single-Member LLC",
    "llc_multi": "Multi-Member LLC",
    "lp": "Limited Partnership",
    "gp": "General Partnership",
    "c_corp": "C Corporation",
    "s_corp": "S Corporation",
    "trust": "Trust",
    "other": "Other",
}
TAX_CLASSES = {
    "disregarded": "Disregarded Entity",
    "partnership": "Partnership",
    "s_corp": "S Corporation",
    "c_corp": "C Corporation",
    "trust": "Trust",
}
_TYPE_TAX = {"llc_single": "disregarded", "llc_multi": "partnership", "lp": "partnership", "gp": "partnership",
             "c_corp": "c_corp", "s_corp": "s_corp", "trust": "trust"}
STATUSES = {"active": "Active", "inactive": "Inactive", "dissolved": "Dissolved", "sold": "Sold"}
ENDED = ("dissolved", "sold")
MANAGEMENT = {"member": "Member-Managed", "manager": "Manager-Managed", "board": "Board of Directors", "trustee": "Trustee"}
OWNER_KINDS = ("entity", "investor", "person")
# Investor Relations profile types -> chart shape.
_INVESTOR_SHAPE = {"individual": "individual", "ira": "individual", "trust": "trust", "llc": "partnership",
                   "partnership": "partnership", "corporation": "corporation"}

US_STATES = frozenset((
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND "
    "OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU"
).split())

_CODE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.\-]{0,39}$")
_LOCATION = re.compile(r"^[^-]+-[^-]+$")
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_MMDD = re.compile(r"^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$")


def valid_code(code: str) -> bool:
    return bool(_CODE.match(code or ""))


def is_location_code(code: str) -> bool:
    """Intacct's child-code convention: 15001-1 is a location of 15001."""
    return bool(_LOCATION.match(code or ""))


def parent_of_location(code: str) -> str:
    return code.split("-")[0] if is_location_code(code) else ""


def kind_of(code: str, stored: str = "") -> str:
    """'entity' or 'location': what the record says, else the code's shape."""
    if stored in ("entity", "location"):
        return stored
    return "location" if is_location_code(code) else "entity"


def tax_class_of(entity_type: str, tax_class: str = "") -> str:
    """The tax classification: typed, else the one the type has by default
    ('' when neither says)."""
    if tax_class in TAX_CLASSES:
        return tax_class
    return _TYPE_TAX.get(entity_type or "", "")


def shape_of(entity_type: str, tax_class: str = "") -> str:
    t = tax_class_of(entity_type, tax_class)
    if t in ("c_corp", "s_corp"):
        return "corporation"
    if t in ("partnership", "disregarded", "trust"):
        return t
    return "unknown"


def investor_shape(investor_type: str) -> str:
    return _INVESTOR_SHAPE.get((investor_type or "").lower(), "individual")


def type_line(entity_type: str, tax_class: str = "") -> str:
    """'Multi-Member LLC, taxed as a partnership' - the words the page shows."""
    t = ENTITY_TYPES.get(entity_type or "", "")
    tc = tax_class_of(entity_type, tax_class)
    if not tc:
        return t
    if not t:
        return f"Taxed as {_TAX_PHRASE[tc]}"
    if entity_type in ("c_corp", "s_corp", "trust") and tc == _TYPE_TAX[entity_type]:
        return t
    return f"{t}, " + ("disregarded for tax" if tc == "disregarded" else f"taxed as {_TAX_PHRASE[tc]}")


_TAX_PHRASE = {"disregarded": "a disregarded entity", "partnership": "a partnership", "s_corp": "an S corporation",
               "c_corp": "a C corporation", "trust": "a trust"}


# ── EIN ──────────────────────────────────────────────────────────────────────
def ein_digits(raw: str) -> str:
    return re.sub(r"\D", "", raw or "")


def valid_ein(raw: str) -> bool:
    d = ein_digits(raw)
    return len(d) == 9 and d != "000000000"


def format_ein(raw: str) -> str:
    d = ein_digits(raw)
    return f"{d[:2]}-{d[2:]}" if len(d) == 9 else ""


def mask_ein(last4: str) -> str:
    return f"XX-XXX{last4}" if last4 else ""


# ── Checks on what is typed ──────────────────────────────────────────────────
def clean_day(v: str, field: str) -> str:
    v = (v or "").strip()
    if not v:
        return ""
    if not _DAY.match(v):
        raise ValueError(f"{field} must be a date (YYYY-MM-DD).")
    try:
        date.fromisoformat(v)
    except ValueError:
        raise ValueError(f"{field} is not a real date.")
    return v


def clean_mmdd(v: str) -> str:
    v = (v or "").strip()
    if not v:
        return ""
    if not _MMDD.match(v):
        raise ValueError("Fiscal Year End must be a month and day (MM-DD).")
    return v


def clean_state(v: str, field: str = "State") -> str:
    v = (v or "").strip().upper()
    if not v:
        return ""
    if v not in US_STATES and v not in ("IN", "GB", "MX"):
        raise ValueError(f"{field} must be a two-letter state code.")
    return v


def clean_pct(v) -> float | None:
    if v is None or v == "":
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise ValueError("A percentage must be a number.")
    if not (0 < x <= 100):
        raise ValueError("A percentage must be more than 0 and no more than 100.")
    return round(x, 4)


def total_pct(pcts) -> float:
    return round(sum(float(p) for p in pcts if p is not None), 4)


# ── Ownership walks ─────────────────────────────────────────────────────────
def look_through(target: str, owners_of: dict, limit: int = 12) -> list:
    """Who ultimately owns `target`, and how much, through every chain.

    owners_of: {node_id: [(owner_id, pct or None), ...]}. An owner with no
    owners of its own (or none recorded) is an ultimate owner. Percentages
    multiply down a chain and add up across chains; a link with no percentage
    makes that chain's share unknown, never a guess. A loop (A owns B owns A)
    stops where it repeats.

    -> [{id, pct, via, partlyUnknown}]: `via` = the entities between the owner
    and the target, top down; `pct` None when no chain's share is known.
    Biggest first, unknowns last."""
    found: dict = {}

    def record(node, share, via):
        row = found.setdefault(node, {"pct": 0.0, "known": False, "unknown": False, "via": via})
        if share is None:
            row["unknown"] = True
        else:
            row["pct"] += share
            row["known"] = True
        if len(via) < len(row["via"]):
            row["via"] = via

    def walk(node, share, path, seen):
        live = [(o, p) for o, p in owners_of.get(node) or [] if o not in seen]
        if node != target and (not live or len(path) >= limit):
            record(node, share, list(reversed(path[:-1])))
            return
        for owner, pct in live:
            nxt = None if share is None or pct is None else share * float(pct) / 100.0
            walk(owner, nxt, path + [owner], seen | {owner})

    walk(target, 100.0, [], {target})
    out = [{"id": n, "pct": round(r["pct"], 4) if r["known"] else None, "via": r["via"],
            "partlyUnknown": r["known"] and r["unknown"]} for n, r in found.items()]
    out.sort(key=lambda r: (r["pct"] is None, -(r["pct"] or 0), r["id"]))
    return out


def owns_cycle(owned: str, owner: str, owners_of: dict) -> bool:
    """Would recording `owner` as an owner of `owned` close a loop? True when
    `owned` already sits above `owner` in the chain (or they are the same)."""
    if owned == owner:
        return True
    stack, seen = [owner], set()
    while stack:
        n = stack.pop()
        if n == owned:
            return True
        if n in seen:
            continue
        seen.add(n)
        stack.extend(o for o, _ in owners_of.get(n) or [])
    return False


def guess_type(name: str, members: int = 0) -> str:
    """A starting point for Fill From, from the name: never saved by itself."""
    low = (name or "").lower()
    if re.search(r"\btrust\b", low):
        return "trust"
    if re.search(r"\b(inc|corp|corporation|pvt|ltd)\b", low):
        return "c_corp"
    if re.search(r"\b(l\.?p\.?|lp)\b", low) and "llc" not in low:
        return "lp"
    if "llc" in low:
        return "llc_multi" if members > 1 else "llc_single" if members == 1 else ""
    return ""


def clean_name(name: str) -> str:
    """The books spell names 'Greens Austin, LLC.' - the trailing dot goes."""
    return re.sub(r"\.\s*$", "", " ".join(str(name or "").split()))
