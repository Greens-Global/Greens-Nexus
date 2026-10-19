"""Payroll export codes (Neil, Oct 17 2026): the name each pay class carries
in the payroll exports - the QuickBooks IIF's payroll item (PITEM) and the
Intacct GL memo - per company.

The defaults are EXACTLY the names the exports always wrote, so nothing
changes for anyone until HR saves a different name for their company. One
`nexus_settings` row (key below) holds only the overrides, as
{company_id: {pay_class: name}}; a class missing from a company's map, or a
company with no map, reads the default. Every export names a pay class
through `codebook` / `earnings_code` - never a literal.
"""
import json

from sqlalchemy.orm import Session

from models import NexusSetting

SETTING_KEY = "payroll_earnings_codes"

# (pay class, default name), in the order the exports write them. The keys
# match the timecard engine's names (regMin -> regular, ...).
PAY_CLASSES = (
    ("regular", "Regular Pay"),
    ("overtime", "Overtime Pay"),
    ("doubleTime", "Double-time Pay"),
    ("holiday", "Holiday Pay"),
    ("sick", "Sick Pay"),
    ("vacation", "Vacation Pay"),
    ("personal", "Personal Pay"),
    # Shift differentials + call-back pay (pay_premiums.py, Oct 17): written
    # only when a card carries them, i.e. never while a company has them off.
    ("shiftDifferential", "Shift Differential"),
    ("callBack", "Call-Back Pay"),
    # CA meal / rest premiums (Oct 17 2026, ca_breaks.py) - written only for
    # cards that carry a premium, so every other export is unchanged.
    ("mealPremium", "Meal Premium"),
    ("restPremium", "Rest Premium"),
)
DEFAULTS = dict(PAY_CLASSES)
# How a pay class is named in a message to HR.
LABELS = {"regular": "Regular", "overtime": "Overtime", "doubleTime": "Double Time", "holiday": "Holiday",
          "sick": "Sick", "vacation": "Vacation", "personal": "Personal",
          "shiftDifferential": "Shift Differential", "callBack": "Call-Back Pay",
          "mealPremium": "Meal Premium", "restPremium": "Rest Premium"}
# QuickBooks Desktop caps a payroll item name at 31 characters.
MAX_LEN = 31


def clean_code(value) -> str:
    """A name safe in a tab-separated IIF row: no tabs or line breaks,
    trimmed, at most MAX_LEN characters."""
    s = " ".join(str(value or "").replace("\t", " ").replace("\r", " ").replace("\n", " ").split())
    return s[:MAX_LEN].strip()


def _stored(db: Session) -> dict:
    row = db.query(NexusSetting).filter(NexusSetting.key == SETTING_KEY).first()
    if not row or not row.value:
        return {}
    try:
        raw = json.loads(row.value)
    except (ValueError, TypeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    out = {}
    for company, codes in raw.items():
        if not isinstance(codes, dict):
            continue
        kept = {k: clean_code(v) for k, v in codes.items() if k in DEFAULTS and clean_code(v)}
        if kept:
            out[str(company)] = kept
    return out


def custom_codes(db: Session, company_id: str) -> dict:
    """Only the names this company has changed ({} = every default)."""
    return dict(_stored(db).get(company_id or "", {}))


def codebook(db: Session):
    """Read the setting once; returns company_id -> {pay_class: name} with
    every class filled (defaults under the company's overrides). For export
    loops over many employees."""
    stored = _stored(db)

    def for_company(company_id: str) -> dict:
        return {**DEFAULTS, **stored.get(company_id or "", {})}
    return for_company


def earnings_code(db: Session, company_id: str, pay_class: str) -> str:
    """The name one company's exports give one pay class."""
    return codebook(db)(company_id)[pay_class]


def save_codes(db: Session, company_id: str, codes: dict, by: str) -> dict:
    """Replace one company's overrides with `codes`. Unknown classes are
    ignored; a blank name, or the default itself, is not stored (it reads the
    default). An empty `codes` is Reset to Default. Commits; returns the
    company's overrides as stored."""
    company_id = company_id or ""
    kept = {}
    for k, _default in PAY_CLASSES:
        v = clean_code((codes or {}).get(k))
        if v and v != DEFAULTS[k]:
            kept[k] = v
    # Two pay classes under one name would merge in QuickBooks - sick and
    # vacation paid as one line - so a clash is refused, not saved.
    final = {k: kept.get(k, DEFAULTS[k]) for k, _d in PAY_CLASSES}
    seen = {}
    for k, name in final.items():
        other = seen.get(name.lower())
        if other:
            raise ValueError(f"\"{name}\" is used for both {LABELS.get(other, other)} and {LABELS.get(k, k)} - "
                             f"QuickBooks would merge them. Give each pay class its own name.")
        seen[name.lower()] = k
    stored = _stored(db)
    if kept:
        stored[company_id] = kept
    else:
        stored.pop(company_id, None)
    row = db.query(NexusSetting).filter(NexusSetting.key == SETTING_KEY).first()
    if not row:
        row = NexusSetting(key=SETTING_KEY)
        db.add(row)
    row.value = json.dumps(stored, sort_keys=True)
    row.updated_by = by
    db.commit()
    return kept


# ── QuickBooks company name (Oct 19 2026) ─────────────────────────────────────
# The IIF header's COMPANYNAME has to match the QuickBooks company file the
# time is imported into. It is the export's company: HR's saved "QuickBooks
# Company Name" for it (another `nexus_settings` row, {company_id: name}),
# else the company's own name (HrEntity.name). A file that spans several
# companies, or none, keeps the name the export always wrote.
QB_COMPANY_KEY = "quickbooks_company_names"
FALLBACK_COMPANY = "Greens Global"
QB_COMPANY_MAX_LEN = 100


def clean_company(value) -> str:
    """A company name safe in the IIF header: no tabs or line breaks."""
    s = " ".join(str(value or "").replace("\t", " ").replace("\r", " ").replace("\n", " ").split())
    return s[:QB_COMPANY_MAX_LEN].strip()


def _qb_names(db: Session) -> dict:
    row = db.query(NexusSetting).filter(NexusSetting.key == QB_COMPANY_KEY).first()
    try:
        raw = json.loads(row.value) if row and row.value else {}
    except (ValueError, TypeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {str(k): clean_company(v) for k, v in raw.items() if clean_company(v)}


def qb_company_override(db: Session, company_id: str) -> str:
    """HR's saved QuickBooks company name for one company ('' = none)."""
    return _qb_names(db).get(company_id or "", "")


def qb_company_default(db: Session, company_id: str) -> str:
    """The name the IIF uses when HR saved none: the company's own name."""
    from models import HrEntity
    ent = db.query(HrEntity).filter(HrEntity.id == company_id).first() if company_id else None
    return clean_company(ent.name if ent else "") or FALLBACK_COMPANY


def qb_company_name(db: Session, company_ids) -> str:
    """The IIF header's COMPANYNAME for a file holding these companies'
    people: one company -> its saved name, else its own name; several or
    none -> FALLBACK_COMPANY."""
    ids = {c for c in (company_ids or ()) if c}
    if len(ids) != 1:
        return FALLBACK_COMPANY
    (cid,) = ids
    return qb_company_override(db, cid) or qb_company_default(db, cid)


def save_qb_company_name(db: Session, company_id: str, name, by: str) -> str:
    """Save (or, blank, clear) one company's QuickBooks company name.
    Commits; returns the name as stored ('' = cleared)."""
    company_id = company_id or ""
    name = clean_company(name)
    stored = _qb_names(db)
    if name:
        stored[company_id] = name
    else:
        stored.pop(company_id, None)
    row = db.query(NexusSetting).filter(NexusSetting.key == QB_COMPANY_KEY).first()
    if not row:
        row = NexusSetting(key=QB_COMPANY_KEY)
        db.add(row)
    row.value = json.dumps(stored, sort_keys=True)
    row.updated_by = by
    db.commit()
    return name
