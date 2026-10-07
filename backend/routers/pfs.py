"""Personal Financial Statements (Neil, Sep 25).

A lender deciding on a loan asks first for the guarantor's personal financial
statement: who they are, what they own, what they owe, the schedule of real
estate, and the net worth those add up to. Accounting used to build it in
Excel on top of a ledger add-in; this is the same statement produced from
Nexus for any date.

How it works
  - A PROFILE is one guarantor - a person, a couple filing jointly, a trust.
  - A LINE is one thing they own or owe. A line either reads the ledger (the
    balance of the listed GL accounts of one Intacct entity as of the statement
    date) or carries a figure somebody keeps by hand. Its ownership percent
    turns the balance into the guarantor's share.
  - The STATEMENT for a date is computed from the lines: every balance, the
    adjusted share, the section totals, total assets - total liabilities =
    net worth. Setting the lines up is done once; after that a statement is a
    date and a click.

Sep 30 (Neil, call of 09/29 - "an emergency"): a spouse on the statement
("Neil and Archana's PFS"); four real estate categories (domestic and
international, residential and commercial); and the bulk setup - one entity's
bank, retirement, investment and loan accounts added from the ledger in one
go, each at its ownership share, so a statement never needs hand updates.

Oct 2 (Charmi + Neil, Teams 10/01-10/02): the ledger picker classifies each
account (bank-type and cash-range accounts are bank accounts, not "other
holdings"; IRA / 401k / HSA titles are retirement; brokerage is investment;
loans, notes, lines of credit, credit cards and mortgages are liabilities;
land and buildings are real estate) and any line can be moved between
categories; liabilities and real estate are set up from the ledger in bulk
(a property line with its mortgage account as the loan); a co-borrower on the
statement (last four of the SSN only - more digits are refused); jewelry as
its own asset category; Schedule E (per real estate line with an entity) and
Schedule C (per business interest with an entity) for the calendar year of
the statement date, mapped from the entity's P&L account titles to the IRS
lines; the statement also goes out as Excel.

Oct 6 (Charmi, 10/03-10/04): the bank-style first page - a one-page
Statement of Financial Condition (assets and liabilities on the lines a bank
form uses, the totals, net worth, contingent liabilities, annual income from
the schedules) heads the screen, the PDF and the workbook. The Institution of
a ledger line is the BANK (the bank account record linked to the GL account,
else the bank named in the account title), never the guarantor or entity.
Cash on hand is its own section, the first; Vehicles is a section; Jewelry
and Personal Property fold into Personal Holdings (saved lines move with
them); lines keep the order they are put in, per guarantor.

Who may see it
  Nobody by default. Owners, and people an Access Group explicitly grants the
  "pfs" module, and nobody else - an administrator's usual bypass does NOT
  apply here. Every statement produced and every change is written to the
  audit log. A full Social Security number is never stored (last four only).

The ledger is read through the accounting app's internal API (the same proxy
as routers/accounting.py); Nexus never opens the accounting database. Outbound
calls run in a thread there, and database work here runs in sync helpers
pushed to a thread, so nothing blocks the event loop.
"""
import asyncio
import json
import re
import uuid
from datetime import date, datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
from auth import require_module_grant
from database import SessionLocal, get_db
from routers import accounting, pfs_access, pfs_affiliates

_read = require_module_grant("pfs", "viewer", bypass_level="owner")
_edit = require_module_grant("pfs", "editor", bypass_level="owner")

# Oct 6 (Charmi, 10/04): every route of a file ({profile_id} / {statement_id})
# is locked until opened with a one-time code - routers/pfs_access.py.
router = APIRouter(prefix="/pfs", tags=["Personal Financial Statements"], dependencies=[Depends(_read), Depends(pfs_access.file_gate)])

KINDS = ("individual", "joint", "trust")

# The statement's sections, in the order a lender reads them.
# Oct 6 (Charmi): Cash - the GL called Cash, petty cash, cash on hand, never
# a bank - is its own section and the first; Vehicles is a section; Notes
# Receivable and Loans on Life Insurance get the lines the first page prints.
# Jewelry and Personal Property fold into Personal Holdings.
ASSET_CATEGORIES = [
    ("cash", "Cash"),
    ("bank", "Bank Accounts"),
    ("retirement", "Retirement Accounts"),
    ("investment", "Investment Accounts"),
    ("business", "Business Interests"),
    ("notes_receivable", "Notes Receivable"),
    ("insurance", "Insurance"),
    ("vehicles", "Vehicles"),
    ("personal", "Personal Holdings"),
    ("other_holding", "Other Holdings"),
]
# Oct 7 (Charmi): Business Loans reads "Commercial Loans" (key kept);
# Residential Loans right after it; International Debt, Loans on Life
# Insurance and Contingent Liabilities are no longer offered. A saved
# international line reads as Commercial Loans and an insurance loan as Other
# Liabilities (_LEGACY); a saved contingent line stays contingent (below).
LIABILITY_CATEGORIES = [
    ("business_loan", "Commercial Loans"),
    ("residential_loan", "Residential Loans"),
    ("auto", "Automobile Loans"),
    ("loc", "Lines of Credit"),
    ("credit_card", "Credit Cards"),
    ("other_liability", "Other Liabilities"),
]
# A guarantee of somebody else's debt: printed under Contingent Liabilities on
# the first page, never added into total liabilities. Not offered for a new
# line since Oct 7 (the History answer covers it); old lines keep it - moving
# one into a real section would START counting it, so that is never automatic.
RETIRED_LIABILITY_CATEGORIES = [("contingent", "Contingent Liabilities")]
REAL_ESTATE_KINDS = [
    ("domestic_residential", "Domestic Residential Real Estate"),
    ("domestic_commercial", "Domestic Commercial Real Estate"),
    ("international_residential", "International Residential Real Estate"),
    ("international_commercial", "International Commercial Real Estate"),
]
# The three categories the schedule had before 09/30, as the four read them.
_RE_LEGACY = {"residential": "domestic_residential", "commercial": "domestic_commercial", "international_re": "international_residential",
              # Oct 6 (Charmi): "remove Jewelry and Personal Property and merge
              # their logic into Personal Holdings" - a saved jewelry line reads
              # (and is saved again) as Personal Holdings, appraisal and all.
              "jewelry": "personal"}
# Every retired category -> the one it reads (and is saved again) as.
_LEGACY = {**_RE_LEGACY, "international": "business_loan", "insurance_loan": "other_liability"}
_CATEGORIES = {
    "asset": [c for c, _ in ASSET_CATEGORIES],
    "liability": [c for c, _ in LIABILITY_CATEGORIES + RETIRED_LIABILITY_CATEGORIES],
    "real_estate": [c for c, _ in REAL_ESTATE_KINDS],
}
_NOT_OFFERED = {c for c, _ in RETIRED_LIABILITY_CATEGORIES}
# The questions every lender asks; answered once per guarantor.
HISTORY_QUESTIONS = [
    "Have you ever filed for bankruptcy?",
    "Are you a party to any lawsuit or legal action?",
    "Do you have any unpaid judgments or tax liens?",
    "Have you ever had property foreclosed or given a deed in lieu?",
    "Are you a guarantor, co-maker or endorser on any debt not listed here?",
    "Are any assets held in a trust?",
    "Are any assets pledged as collateral?",
]
# Oct 7, later (Charmi + Neil): City, State and ZIP are three keys on both
# blocks. `city_state_zip` (one combined text, before Oct 7) is still taken
# from an older client and split - never stored again; `spouse` (the old
# separate "Spouse or Co-Borrower" name) is folded into coBorrower.name, the
# one source of truth.
_DETAIL_KEYS = ("address", "city", "state", "zip", "phone", "email", "date_of_birth", "marital_status", "employer", "title",
                "ssn_last4", "members", "coBorrower")
# The co-borrower (Charmi, 10/01: "Spouse/Co-borrower details as well") mirrors
# the borrower's fields, plus a name.
_CO_BORROWER_KEYS = ("name", "address", "city", "state", "zip", "phone", "email", "date_of_birth", "marital_status", "employer",
                     "title", "ssn_last4", "photo")
US_STATES = frozenset((
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
    "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
    "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "AS", "GU", "MP", "PR", "VI",
))
_ZIP = re.compile(r"^\d{5}(?:-?\d{4})?$")
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_PHOTO_MAX = 400_000   # characters of data URL (a downscaled JPEG is a tenth of this)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _r2(v) -> float:
    return round(float(v or 0) + 0.0, 2)


def _audit(db: Session, user: dict, action: str, resource_id: str, details: Optional[dict] = None) -> None:
    db.add(models.AuditLog(timestamp=_now(), user_email=user["email"], user_role=user.get("role", ""), action=action,
                           resource_type="pfs", resource_id=resource_id, details=json.dumps(details or {})))


# ── Addresses and the co-borrower's name (Oct 7) ─────────────────────────────
def _fmt_zip(v: str) -> str:
    digits = re.sub(r"\D", "", v)
    return f"{digits[:5]}-{digits[5:]}" if len(digits) == 9 else digits


def split_city_state_zip(text) -> dict:
    """Best-effort split of an old combined value ("Sacramento, CA 95814").
    What cannot be split is kept whole as the city, so nothing is lost."""
    s = str(text or "").strip()
    if not s:
        return {}
    m = re.match(r"^(.*?)[\s,]+([A-Za-z]{2})\.?[\s,]+(\d{5}(?:-?\d{4})?)$", s)
    if m and m.group(1).strip() and m.group(2).upper() in US_STATES:
        return {"city": m.group(1).rstrip(" ,"), "state": m.group(2).upper(), "zip": _fmt_zip(m.group(3))}
    m = re.match(r"^(.*?)[\s,]+([A-Za-z]{2})\.?$", s)
    if m and m.group(1).strip() and m.group(2).upper() in US_STATES:
        return {"city": m.group(1).rstrip(" ,"), "state": m.group(2).upper()}
    m = re.match(r"^(.*?)[\s,]+(\d{5}(?:-?\d{4})?)$", s)
    if m and m.group(1).strip():
        return {"city": m.group(1).rstrip(" ,"), "zip": _fmt_zip(m.group(2))}
    return {"city": s}


def _with_parts(block: dict) -> dict:
    """One block with an old combined City, State, ZIP turned into the three
    keys, unless the three are already there."""
    out = dict(block)
    old = out.pop("city_state_zip", None)
    if old and not (out.get("city") or out.get("state") or out.get("zip")):
        out.update(split_city_state_zip(old))
    return out


def read_details(d) -> dict:
    """A profile's details as they read since Oct 7: city / state / zip on both
    blocks and the old spouse name as the co-borrower's. Read-only - the row
    is rewritten this way on its next save."""
    d = _with_parts(d if isinstance(d, dict) else {})
    spouse = str(d.pop("spouse", "") or "").strip()
    co = d.get("coBorrower") if isinstance(d.get("coBorrower"), dict) else None
    if co is not None or spouse:
        co = _with_parts(co or {})
        if not str(co.get("name") or "").strip() and spouse:
            co["name"] = spouse
        d["coBorrower"] = co
    return d


# ── Shapes ───────────────────────────────────────────────────────────────────
def _display_name(p: models.PfsProfile) -> str:
    """The name on the statement: "Neil R. Kadakia and Archana Kadakia" when a
    co-borrower is named (or, on a row saved before Oct 7, a spouse), the name
    alone otherwise."""
    co = read_details(p.details).get("coBorrower") or {}
    spouse = str(co.get("name") or "").strip()
    return f"{p.name} and {spouse}" if spouse and spouse.lower() not in (p.name or "").lower() else p.name


def _profile_out(p: models.PfsProfile, full: bool = True) -> dict:
    out = {"id": p.id, "name": p.name, "displayName": _display_name(p), "kind": p.kind or "individual", "archived": bool(p.archived),
           "updatedAt": p.updated_at, "hasPhoto": bool(p.photo)}
    if full:
        out.update({"details": read_details(p.details),
                    "history": p.history if isinstance(p.history, list) else [],
                    "executiveProfile": p.executive_profile or "", "photo": p.photo or ""})
    return out


def _line_out(l: models.PfsLine) -> dict:
    details = l.details if isinstance(l.details, dict) else {}
    # Oct 7: `shareFrom` = "affiliated" (the % is read from Affiliated
    # Entities at read time) | "manual" (typed on the line; also every line
    # saved before Oct 7). Kept in details.shareFrom - no new column.
    return {"id": l.id, "section": l.section, "category": _LEGACY.get(l.category, l.category), "label": l.label or "", "institution": l.institution or "",
            "accountRef": l.account_ref or "", "ownershipPct": float(l.ownership_pct if l.ownership_pct is not None else 100),
            "source": l.source or "manual", "ledgerEntity": l.ledger_entity or "",
            "ledgerAccounts": l.ledger_accounts if isinstance(l.ledger_accounts, list) else [],
            "manualValue": float(l.manual_value or 0), "manualAsOf": l.manual_as_of or "",
            "details": details, "sort": l.sort or 0, "notes": l.notes or "",
            "shareFrom": "affiliated" if details.get("shareFrom") == "affiliated" else "manual"}


class ProfileBody(BaseModel):
    name: str
    kind: Optional[str] = "individual"
    details: Optional[dict[str, Any]] = None
    history: Optional[list[dict[str, Any]]] = None
    executiveProfile: Optional[str] = None
    photo: Optional[str] = None
    archived: Optional[bool] = None


class LineBody(BaseModel):
    section: str
    category: str
    label: str
    institution: Optional[str] = ""
    accountRef: Optional[str] = ""
    ownershipPct: Optional[float] = 100
    source: Optional[str] = "manual"
    ledgerEntity: Optional[str] = ""
    ledgerAccounts: Optional[list[str]] = None
    manualValue: Optional[float] = 0
    manualAsOf: Optional[str] = ""
    details: Optional[dict[str, Any]] = None
    sort: Optional[int] = 0
    notes: Optional[str] = ""


def _clean_address(out: dict, k: str, v, who: str) -> None:
    """State is a two-letter US state; ZIP is 5 digits or 9 (12345-6789)."""
    text = str(v).strip()
    if not text:
        return
    if k == "state":
        st = text.upper().rstrip(".")
        if st not in US_STATES:
            raise HTTPException(status_code=400, detail=f"Pick the {who}state from the list of US states.")
        out[k] = st
    elif k == "zip":
        if not _ZIP.match(text.replace(" ", "")):
            raise HTTPException(status_code=400, detail=f"The {who}ZIP is 5 digits, or 9 as 12345-6789.")
        out[k] = _fmt_zip(text)
    else:
        out[k] = text[:200]


def _clean_details(d: Optional[dict]) -> dict:
    # An older client may still send the combined City, State, ZIP or the
    # separate spouse name: both land in the Oct 7 keys.
    d = read_details(d)
    out = {}
    for k in _DETAIL_KEYS:
        v = (d or {}).get(k)
        if v in (None, ""):
            continue
        if k == "ssn_last4":
            digits = re.sub(r"\D", "", str(v))
            # Never more than the last four, whatever was typed or pasted.
            out[k] = digits[-4:] if digits else ""
        elif k == "members":
            out[k] = [{"name": str(m.get("name", ""))[:120], "role": str(m.get("role", ""))[:60]}
                      for m in v if isinstance(m, dict) and m.get("name")][:6]
        elif k == "coBorrower":
            co = _clean_co_borrower(v)
            if co:
                out[k] = co
        elif k in ("city", "state", "zip"):
            _clean_address(out, k, v, "")
        else:
            out[k] = str(v)[:200]
    return out


def _clean_co_borrower(v) -> dict:
    """The co-borrower's details. A Social Security number is the last four
    digits and nothing more: a longer value is refused outright, so a full
    number never reaches the database even by accident."""
    if not isinstance(v, dict):
        return {}
    out = {}
    for k in _CO_BORROWER_KEYS:
        val = v.get(k)
        if val in (None, ""):
            continue
        if k == "photo":
            # Oct 7 (item 38): the co-borrower's cover photo, kept like the
            # borrower's - a small downscaled image as a data URL, never a link.
            if not isinstance(val, str) or not val.startswith("data:image/") or len(val) > _PHOTO_MAX:
                raise HTTPException(status_code=400, detail="The co-borrower's photo must be an image under 300 KB.")
            out[k] = val
        elif k in ("city", "state", "zip"):
            _clean_address(out, k, val, "co-borrower's ")
        elif k == "ssn_last4":
            digits = re.sub(r"\D", "", str(val))
            if len(digits) > 4:
                raise HTTPException(status_code=400, detail="Enter only the last four digits of the co-borrower's Social Security number.")
            if digits:
                out[k] = digits
        else:
            out[k] = str(val)[:200]
    return out


def _clean_history(h: Optional[list]) -> list:
    out = []
    for row in (h or [])[:30]:
        if isinstance(row, dict) and row.get("question"):
            out.append({"question": str(row["question"])[:240], "answer": str(row.get("answer", ""))[:20],
                        "note": str(row.get("note", ""))[:400]})
    return out


def _clean_line(body: LineBody, keep_category: str = "") -> dict:
    """`keep_category`: the category the line already has - a retired one
    (contingent) may be kept by a line that has it, never newly chosen."""
    if body.section not in _CATEGORIES:
        raise HTTPException(status_code=400, detail="section must be asset, liability or real_estate")
    body.category = _LEGACY.get(body.category, body.category)
    offered = [c for c in _CATEGORIES[body.section] if c not in _NOT_OFFERED]
    if body.category not in offered and not (body.category in _CATEGORIES[body.section] and body.category == keep_category):
        raise HTTPException(status_code=400, detail=f"category must be one of {', '.join(offered)}")
    label = (body.label or "").strip()
    if not label:
        raise HTTPException(status_code=400, detail="Give the line a name.")
    pct = 100.0 if body.ownershipPct is None else float(body.ownershipPct)
    if not 0 <= pct <= 100:
        raise HTTPException(status_code=400, detail="Ownership is a percent between 0 and 100.")
    source = body.source if body.source in ("manual", "ledger") else "manual"
    accounts = [str(a).strip() for a in (body.ledgerAccounts or []) if str(a).strip()][:40]
    entity = (body.ledgerEntity or "").strip()
    if source == "ledger" and (not entity or not accounts):
        raise HTTPException(status_code=400, detail="A ledger line needs an entity and at least one account.")
    if body.manualAsOf and not _ISO.match(body.manualAsOf):
        raise HTTPException(status_code=400, detail="The date of a manual figure must be YYYY-MM-DD.")
    details = dict(body.details) if isinstance(body.details, dict) else {}
    # Oct 7: where the line's % comes from - "affiliated" | "manual"; anything else is dropped.
    if "shareFrom" in details and details["shareFrom"] not in ("affiliated", "manual"):
        details.pop("shareFrom")
    if len(json.dumps(details)) > 4000:
        raise HTTPException(status_code=400, detail="Too much detail on one line.")
    loan = details.get("loan") if isinstance(details.get("loan"), dict) else None
    if loan and loan.get("source") == "ledger" and (not loan.get("entity") or not loan.get("accounts")):
        raise HTTPException(status_code=400, detail="A loan read from the ledger needs an entity and at least one account.")
    return {"section": body.section, "category": body.category, "label": label[:160], "institution": (body.institution or "")[:160],
            "account_ref": (body.accountRef or "")[:40], "ownership_pct": pct, "source": source, "ledger_entity": entity,
            "ledger_accounts": accounts, "manual_value": float(body.manualValue or 0), "manual_as_of": body.manualAsOf or "",
            "details": details, "sort": int(body.sort or 0), "notes": (body.notes or "")[:400]}


# ── Database work (sync; async endpoints push it to a thread) ───────────────
def _get_profile(db: Session, profile_id: str) -> models.PfsProfile:
    p = db.query(models.PfsProfile).filter(models.PfsProfile.id == profile_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Profile not found.")
    return p


# Lines set up before the Oct 6 sections: a Jewelry line becomes Personal
# Holdings, and a "Cash" line that was listed under Bank Accounts moves to
# Cash. Only lines last saved before the release are touched, so a line
# somebody has since put back under Bank Accounts on purpose stays there.
# Oct 7 (Charmi: "Cash is not on the top"): the rule only knew a title that
# is exactly "Cash"; ledger titles carry the owner or entity around it ("GA -
# Cash", "Cash - RJK", "Cash Account"). Those count too, as long as no bank
# is named and no account number ends the title ("Cash - Chase 6532" is a
# bank account). The cut-off moves to the Oct 7 release so lines added from
# the ledger under the narrower rule move as well.
_SECTIONS_OCT06 = "2026-10-08"
_CASH_TITLE = re.compile(r"^\s*cash\s*$|petty cash|cash on hand|cash in hand|cash drawer|cash register", re.I)
_CASH_WIDE = re.compile(r"^\s*(?:[a-z&.'\s]{1,24}\s*[-:(]\s*)?cash(?:\s+account|\s+acct)?(?:\s*[-:(]\s*[a-z&.'\s]{1,24}\)?)?\s*$", re.I)


def is_cash_title(title: str) -> bool:
    """A Cash line (the Cash section), not a bank account, by its title."""
    t = title or ""
    if _CASH_TITLE.search(t):
        return True
    return bool(_CASH_WIDE.match(t)) and not bank_name(t) and not _ENDING.search(t)


def _migrate_lines(db: Session, profile_id: str) -> None:
    rows = (db.query(models.PfsLine).filter(models.PfsLine.profile_id == profile_id,
                                            models.PfsLine.category.in_(("jewelry", "bank"))).all())
    changed = False
    for row in rows:
        if row.category == "jewelry":
            row.category, changed = "personal", True
        elif row.section == "asset" and (row.updated_at or "") < _SECTIONS_OCT06 and is_cash_title(row.label or ""):
            row.category, changed = "cash", True
    if changed:
        db.commit()


def _ordered(q):
    return q.order_by(models.PfsLine.sort, models.PfsLine.label).all()


def _load(profile_id: str) -> tuple[dict, list[dict], dict]:
    """(profile, lines, Affiliated Entities shares by entity code)."""
    db = SessionLocal()
    try:
        p = _get_profile(db, profile_id)
        _migrate_lines(db, profile_id)
        lines = _ordered(db.query(models.PfsLine).filter(models.PfsLine.profile_id == profile_id))
        return _profile_out(p), [_line_out(l) for l in lines], pfs_affiliates.shares(db, profile_id)
    finally:
        db.close()


async def _parents() -> dict[str, str]:
    """{entity code: parent code} from the accounting app's entity list; {}
    when it cannot answer (the "67001-1" convention still applies)."""
    try:
        data = await accounting._acct_get("/api/internal/reports/locations", {})
    except HTTPException:
        return {}
    return {str(e.get("code")).strip(): str(e.get("parent_code")).strip()
            for e in (data.get("entities") or []) if isinstance(e, dict) and e.get("code") and e.get("parent_code")}


async def _parents_if_needed(entities: list[str], shares: dict) -> dict[str, str]:
    """The parent map, read only when an entity has no row of its own and
    could inherit one."""
    if shares and any(e and e not in shares for e in entities):
        return await _parents()
    return {}


def _save_statement(profile_id: str, as_of: str, payload: dict, user: dict, fmt: str = "pdf", delivery: str = "download") -> str:
    db = SessionLocal()
    try:
        sid = str(uuid.uuid4())
        db.add(models.PfsStatement(id=sid, profile_id=profile_id, as_of=as_of, payload=payload,
                                   generated_by=user["email"], generated_at=_now()))
        # Who, which guarantor, which date, which file - never a figure: the
        # audit log is read by people who may not see the statement itself.
        _audit(db, user, "pfs_statement_produced", profile_id, {"statement": sid, "as_of": as_of, "format": fmt, "delivery": delivery})
        db.commit()
        return sid
    finally:
        db.close()


# ── Profiles ─────────────────────────────────────────────────────────────────
@router.get("/meta")
def meta():
    """The vocabulary of a statement: sections, categories, the standard questions."""
    pair = lambda rows: [{"key": k, "label": v} for k, v in rows]  # noqa: E731
    # Oct 7: `liabilityCategories` is what a new line may use; `retiredCategories`
    # names categories old lines may still carry (contingent) so they get a label.
    return {"kinds": list(KINDS), "assetCategories": pair(ASSET_CATEGORIES), "liabilityCategories": pair(LIABILITY_CATEGORIES),
            "retiredCategories": pair(RETIRED_LIABILITY_CATEGORIES),
            "realEstateKinds": pair(REAL_ESTATE_KINDS), "historyQuestions": HISTORY_QUESTIONS}


@router.get("/profiles")
def list_profiles(db: Session = Depends(get_db)):
    rows = db.query(models.PfsProfile).order_by(models.PfsProfile.archived, models.PfsProfile.name).all()
    return [_profile_out(p, full=False) for p in rows]


def _apply_profile(p: models.PfsProfile, body: ProfileBody, user: dict) -> None:
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Give the profile a name.")
    if body.kind and body.kind not in KINDS:
        raise HTTPException(status_code=400, detail="kind must be individual, joint or trust")
    p.name = name[:160]
    if body.kind:
        p.kind = body.kind
    if body.details is not None:
        p.details = _clean_details(body.details)
    if body.history is not None:
        p.history = _clean_history(body.history)
    if body.executiveProfile is not None:
        p.executive_profile = body.executiveProfile[:6000]
    if body.photo is not None:
        if body.photo and (not body.photo.startswith("data:image/") or len(body.photo) > _PHOTO_MAX):
            raise HTTPException(status_code=400, detail="The photo must be an image under 300 KB.")
        p.photo = body.photo
    if body.archived is not None:
        p.archived = bool(body.archived)
    p.updated_by, p.updated_at = user["email"], _now()


@router.post("/profiles", status_code=201)
def create_profile(body: ProfileBody, request: Request, user: dict = Depends(_edit), db: Session = Depends(get_db)):
    p = models.PfsProfile(id=str(uuid.uuid4()), name="", created_by=user["email"], created_at=_now(),
                          history=[{"question": q, "answer": "", "note": ""} for q in HISTORY_QUESTIONS])
    _apply_profile(p, body, user)
    db.add(p)
    _audit(db, user, "pfs_profile_created", p.id, {"name": p.name})
    pfs_access.grant_now(db, user["email"], p.id, request)   # its creator opens it without a code
    db.commit()
    db.refresh(p)
    return _profile_out(p)


def _open_profile(profile_id: str, user: dict) -> tuple[dict, dict]:
    db = SessionLocal()
    try:
        p = _get_profile(db, profile_id)
        _migrate_lines(db, profile_id)
        lines = _ordered(db.query(models.PfsLine).filter(models.PfsLine.profile_id == profile_id))
        _audit(db, user, "pfs_profile_opened", p.id)
        db.commit()
        return {**_profile_out(p), "lines": [_line_out(l) for l in lines]}, pfs_affiliates.shares(db, profile_id)
    finally:
        db.close()


@router.get("/profiles/{profile_id}")
async def get_profile(profile_id: str, user: dict = Depends(_read)):
    """The file and its lines. Oct 7: each line also carries shareFrom,
    storedOwnershipPct, affiliatedShare and shareMissing (apply_shares), and
    `ownershipPct` is the % the statement will use."""
    out, shares = await asyncio.to_thread(_open_profile, profile_id, user)
    parents = await _parents_if_needed([_share_entity(l) for l in out["lines"]], shares)
    out["lines"] = apply_shares(out["lines"], shares, parents)
    return out


@router.put("/profiles/{profile_id}")
def update_profile(profile_id: str, body: ProfileBody, user: dict = Depends(_edit), db: Session = Depends(get_db)):
    p = _get_profile(db, profile_id)
    _apply_profile(p, body, user)
    _audit(db, user, "pfs_profile_changed", p.id)
    db.commit()
    db.refresh(p)
    return _profile_out(p)


@router.delete("/profiles/{profile_id}", status_code=204)
def delete_profile(profile_id: str, user: dict = Depends(require_module_grant("pfs", "full", bypass_level="owner")), db: Session = Depends(get_db)):
    """Removes the profile and its lines. Statements already produced stay:
    they are the record of what was sent."""
    p = _get_profile(db, profile_id)
    db.query(models.PfsLine).filter(models.PfsLine.profile_id == profile_id).delete(synchronize_session=False)
    pfs_affiliates.forget(db, profile_id)   # its affiliated entities and co-borrower profile go with it; the access log stays
    _audit(db, user, "pfs_profile_deleted", p.id, {"name": p.name})
    db.delete(p)
    db.commit()


# ── Lines ────────────────────────────────────────────────────────────────────
def _next_sort(db: Session, profile_id: str) -> int:
    """A new line goes to the end of its section once the guarantor's lines
    have been put in an order; before that every line is 0 and they read by
    name, as they always did."""
    top = max((s for (s,) in db.query(models.PfsLine.sort).filter(models.PfsLine.profile_id == profile_id).all() if s), default=0)
    return top + 1 if top else 0


@router.post("/profiles/{profile_id}/lines", status_code=201)
def add_line(profile_id: str, body: LineBody, user: dict = Depends(_edit), db: Session = Depends(get_db)):
    _get_profile(db, profile_id)
    fields = _clean_line(body)
    if not fields["sort"]:
        fields["sort"] = _next_sort(db, profile_id)
    row = models.PfsLine(id=str(uuid.uuid4()), profile_id=profile_id, updated_by=user["email"], updated_at=_now(), **fields)
    db.add(row)
    _audit(db, user, "pfs_line_added", profile_id, {"line": row.id, "label": row.label})
    db.commit()
    db.refresh(row)
    return _line_out(row)


class BulkAccount(BaseModel):
    code: str
    label: Optional[str] = ""
    category: Optional[str] = ""
    ownershipPct: Optional[float] = None
    # Real estate only (Charmi, 10/01): the mortgage account of the same
    # entity, read from the ledger as the property's loan.
    loanAccount: Optional[str] = ""


class BulkBody(BaseModel):
    section: str
    category: str
    entity: str
    entityName: Optional[str] = ""
    ownershipPct: Optional[float] = 100
    accounts: list[BulkAccount]
    # Oct 7 (Charmi): "affiliated" | "manual" | None. None = "affiliated" when
    # the entity (or a parent) has an Affiliated Entities row with a %, else
    # "manual". With "affiliated" the lines are saved at that % and follow it.
    shareFrom: Optional[str] = None


_ENDING = re.compile(r"[-\s](\d{4})\s*$")


def _account_ref(title: str) -> str:
    """"Chase Checking -6532" -> "6532": the account's last four, when the
    ledger names it that way."""
    m = _ENDING.search(title or "")
    return m.group(1) if m else ""


@router.post("/profiles/{profile_id}/lines/bulk", status_code=201)
async def add_lines_bulk(profile_id: str, body: BulkBody, user: dict = Depends(_edit)):
    """Oct 7: the response also carries `shareFrom` (what the new lines got)
    and `affiliatedShare` (resolve_share for the entity, or null)."""
    entity = (body.entity or "").strip()
    shares = await asyncio.to_thread(_shares_of, profile_id)
    parents = await _parents_if_needed([entity], shares)
    share = resolve_share(entity, shares, parents) if entity else None
    share_from = body.shareFrom if body.shareFrom in ("affiliated", "manual") else ("affiliated" if share else "manual")
    if share_from == "affiliated" and not share:
        share_from = "manual"
    return await asyncio.to_thread(_add_lines_bulk, profile_id, body, user, share_from, share)


def _shares_of(profile_id: str) -> dict:
    db = SessionLocal()
    try:
        return pfs_affiliates.shares(db, profile_id)
    finally:
        db.close()


def _add_lines_bulk(profile_id: str, body: BulkBody, user: dict, share_from: str, share: Optional[dict]) -> dict:
    db = SessionLocal()
    try:
        out = _bulk(db, profile_id, body, user, share_from, share)
    finally:
        db.close()
    return {**out, "shareFrom": share_from, "affiliatedShare": share}


def _bulk(db: Session, profile_id: str, body: BulkBody, user: dict, share_from: str, share: Optional[dict]) -> dict:
    """One line per ledger account, in one go (Neil, call of 09/29: "my bank
    accounts are all in Intacct - pick them by GL group and the PFS never
    needs a manual update"). Every line reads the ledger, so each statement
    shows the balance as of its date. A line already pointed at the same
    entity and account is left alone, never doubled.

    Oct 2 (Charmi: "the wiring is not done here and also Real Estate"): the
    same for liabilities and for real estate - a land or building account
    becomes a property line of the kind picked, with its mortgage account
    (`loanAccount`, same entity) read from the ledger as the loan."""
    _get_profile(db, profile_id)
    if body.section not in _CATEGORIES:
        raise HTTPException(status_code=400, detail="section must be asset, liability or real_estate")
    entity = (body.entity or "").strip()
    if not entity:
        raise HTTPException(status_code=400, detail="Pick an entity.")
    if not body.accounts:
        raise HTTPException(status_code=400, detail="Pick at least one account.")
    have = {(l.ledger_entity, tuple(l.ledger_accounts or [])) for l in
            db.query(models.PfsLine).filter(models.PfsLine.profile_id == profile_id, models.PfsLine.source == "ledger").all()}
    made = []
    sort = _next_sort(db, profile_id)
    for a in body.accounts[:120]:
        code = (a.code or "").strip()
        if not code or (entity, (code,)) in have:
            continue
        label = (a.label or "").strip() or code
        details: dict = {}
        if body.section == "real_estate":
            loan_code = (a.loanAccount or "").strip()
            details = {"legal_owner": (body.entityName or "")[:160],
                       "loan": {"source": "ledger", "entity": entity, "accounts": [loan_code]} if loan_code else {"source": "manual", "value": 0}}
        # Oct 7: the % from Affiliated Entities, unless this account was given its own.
        if share_from == "affiliated" and share and a.ownershipPct is None:
            details["shareFrom"], pct = "affiliated", share["pct"]
        else:
            details["shareFrom"], pct = "manual", (body.ownershipPct if a.ownershipPct is None else a.ownershipPct)
        # Oct 6 (Charmi): the Institution is the bank ("Chase Checking - 6532"
        # -> Chase), never the entity the account sits in. The statement
        # prefers the bank account record linked to the GL when it has one.
        line = _clean_line(LineBody(
            section=body.section, category=(a.category or body.category), label=label,
            institution="" if body.section == "real_estate" else bank_name(label),
            accountRef=_account_ref(label), ownershipPct=pct,
            source="ledger", ledgerEntity=entity, ledgerAccounts=[code], details=details, notes="", sort=sort,
        ))
        sort = sort + 1 if sort else 0
        row = models.PfsLine(id=str(uuid.uuid4()), profile_id=profile_id, updated_by=user["email"], updated_at=_now(), **line)
        db.add(row)
        have.add((entity, (code,)))
        made.append(row)
    _audit(db, user, "pfs_lines_added_from_ledger", profile_id, {"entity": entity, "count": len(made)})
    db.commit()
    for row in made:
        db.refresh(row)
    return {"added": len(made), "lines": [_line_out(r) for r in made]}


def _get_line(db: Session, profile_id: str, line_id: str) -> models.PfsLine:
    row = db.query(models.PfsLine).filter(models.PfsLine.id == line_id, models.PfsLine.profile_id == profile_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Line not found.")
    return row


@router.put("/profiles/{profile_id}/lines/{line_id}")
def update_line(profile_id: str, line_id: str, body: LineBody, user: dict = Depends(_edit), db: Session = Depends(get_db)):
    row = _get_line(db, profile_id, line_id)
    for k, v in _clean_line(body, keep_category=row.category or "").items():
        setattr(row, k, v)
    row.updated_by, row.updated_at = user["email"], _now()
    _audit(db, user, "pfs_line_changed", profile_id, {"line": row.id, "label": row.label})
    db.commit()
    db.refresh(row)
    return _line_out(row)


class MoveBody(BaseModel):
    section: str
    category: str


@router.patch("/profiles/{profile_id}/lines/{line_id}/move")
def move_line(profile_id: str, line_id: str, body: MoveBody, user: dict = Depends(_edit), db: Session = Depends(get_db)):
    """"Move to...": the line's section and category change, nothing else
    (Charmi, 10/01: bank accounts listed under Other Holdings - a wrong guess
    is one click to fix). A line moved into real estate gets an empty manual
    loan so the schedule can read it; one moved out keeps its details."""
    row = _get_line(db, profile_id, line_id)
    section = body.section
    category = _LEGACY.get(body.category, body.category)
    if section not in _CATEGORIES or category not in _CATEGORIES[section] or category in _NOT_OFFERED:
        raise HTTPException(status_code=400, detail="Pick a category of the statement.")
    was = (row.section, row.category)
    row.section, row.category = section, category
    details = dict(row.details) if isinstance(row.details, dict) else {}
    if section == "real_estate" and not isinstance(details.get("loan"), dict):
        details["loan"] = {"source": "manual", "value": 0}
    row.details = details
    row.updated_by, row.updated_at = user["email"], _now()
    _audit(db, user, "pfs_line_moved", profile_id, {"line": row.id, "label": row.label, "from": list(was), "to": [section, category]})
    db.commit()
    db.refresh(row)
    return _line_out(row)


class OrderBody(BaseModel):
    ids: list[str]


@router.put("/profiles/{profile_id}/line-order")   # not under /lines/: PUT /lines/{line_id} is declared first
def order_lines(profile_id: str, body: OrderBody, user: dict = Depends(_edit), db: Session = Depends(get_db)):
    """The order of lines within a section (Charmi, 10/04: "rows must be
    reorderable"), kept per guarantor: the ids in the order wanted. Every
    statement, the PDF and the workbook print them in that order."""
    _get_profile(db, profile_id)
    ids = [str(i) for i in (body.ids or [])][:400]
    if not ids:
        raise HTTPException(status_code=400, detail="Give the lines in the order wanted.")
    rows = {r.id: r for r in db.query(models.PfsLine).filter(models.PfsLine.profile_id == profile_id, models.PfsLine.id.in_(ids)).all()}
    if len(rows) != len(set(ids)):
        raise HTTPException(status_code=404, detail="A line in that order is not on this statement.")
    for i, line_id in enumerate(ids):
        rows[line_id].sort = i + 1
    _audit(db, user, "pfs_lines_reordered", profile_id, {"count": len(ids)})
    db.commit()
    return {"ok": True, "ids": ids}


@router.delete("/profiles/{profile_id}/lines/{line_id}", status_code=204)
def delete_line(profile_id: str, line_id: str, user: dict = Depends(_edit), db: Session = Depends(get_db)):
    row = _get_line(db, profile_id, line_id)
    _audit(db, user, "pfs_line_removed", profile_id, {"line": row.id, "label": row.label})
    db.delete(row)
    db.commit()


# ── The ledger, for setting a line up and for the figures ───────────────────
_BS_SECTIONS = ("asset", "liability", "equity")


async def _balances(entity: str, as_of: str) -> dict[str, dict]:
    """GL code -> {title, section, amount} for one entity as of a date: assets
    as they stand, liabilities as what is OWED (both positive in the normal
    case). The accounting app's balance sheet sends debits minus credits for
    every section (checked live 10/02: a mortgage owed arrives as
    -11,245,000.00), so liability and equity amounts are turned around here;
    a liability account with a debit balance therefore reads negative - not
    owed - rather than being flipped silently."""
    data = await accounting._acct_get("/api/internal/reports/balance-sheet", {"asof": as_of, "location": entity})
    out: dict[str, dict] = {}
    for s in data.get("sections") or []:
        if s.get("key") not in _BS_SECTIONS:
            continue
        flip = -1.0 if s["key"] in ("liability", "equity") else 1.0
        for a in s.get("accounts") or []:
            if a.get("account_no"):
                out[a["account_no"]] = {"title": a.get("title") or "", "section": s["key"], "amount": _r2(flip * (a.get("amount") or 0)),
                                        "accountType": a.get("account_type") or ""}
    return out


# ── Which statement category a ledger account belongs to ────────────────────
# Charmi, 10/01: "ANK Earmarked ETC-7047", "NRK & ANK - F&M - 6870" were
# listed under Other Holdings - "these are bank accounts". The guess goes, in
# order: the account's TYPE when the accounting app sends one (cash_bank /
# petty_cash / credit_card are the chart of accounts' own types), then the
# TITLE's words (IRA / 401k / HSA, brokerage, insurance, loan, land...), then
# the GL group (Intacct's cash range 10xxx-11xxx is a bank account, 15xxx-17xxx
# are fixed assets). Every guess is one "Move to..." click to change.
_TYPE_CATEGORY = {"cash_bank": ("asset", "bank"), "petty_cash": ("asset", "cash"), "credit_card": ("liability", "credit_card")}
_ASSET_WORDS = [
    # Oct 6 (Charmi): "Cash" - the GL called Cash, petty cash, cash on hand -
    # is not a bank account; it is the Cash section.
    (_CASH_TITLE, "cash"),
    (re.compile(r"401\s*\(?k\)?|\bira\b|roth|retirement|pension|\bsep\b|403\s*\(?b\)?|\bhsa\b|health savings|457\b"), "retirement"),
    (re.compile(r"brokerage|etrade|e\*trade|webull|fidelity|schwab|robinhood|merrill|morgan stanley|vanguard|investment|securities|stock|bond|mutual|crypto|coinbase|treasur"), "investment"),
    (re.compile(r"insurance|life policy|cash value|annuity"), "insurance"),
    (re.compile(r"vehicle|automobile|\bauto\b|\bcar\b|\btruck\b|boat|yacht|\brv\b|motorcycle|aircraft|airplane"), "vehicles"),
    # Jewelry and personal property are Personal Holdings now (Oct 6).
    (re.compile(r"jewel|watch|art\b|collectib|antique|furniture|equipment|household|personal property"), "personal"),
    (re.compile(r"checking|chkg|savings|\bbank\b|\bcash\b|money market|\bcd\b|certificate of deposit|venmo|paypal|earmarked|operating|payroll acct|\bf&m\b|\bchase\b|wells fargo|\bbofa\b|\bciti\b|\bpnc\b|us bank|first citizens|\betc\b|escrow"), "bank"),
]
_RE_WORDS = re.compile(r"\bland\b|building|real estate|\bproperty\b|improvement|rental|apartment|\bbldg\b|storage|plaza|center|hotel|motel|condo|\bhouse\b|residence")
# Oct 7 (Charmi): International Debt and Loans on Life Insurance are gone -
# a loan in India is a Commercial Loan, a policy loan an Other Liability; a
# home loan / HELOC / mortgage on a residence is a Residential Loan.
_LIABILITY_WORDS = [
    (re.compile(r"policy loan|insurance loan|loan against (?:life )?(?:insurance|policy)"), "other_liability"),
    (re.compile(r"credit card|\bamex\b|\bvisa\b|mastercard|discover card|capital one"), "credit_card"),
    (re.compile(r"home loan|residential|heloc|home equity|mortgage on (?:the )?(?:primary )?residence"), "residential_loan"),
    (re.compile(r"line of credit|\bloc\b|credit line|revolv"), "loc"),
    (re.compile(r"\bauto\b|vehicle|\bcar\b|lease payable"), "auto"),
    (re.compile(r"india|\bintl\b|international|\bhdfc\b|icici|\bsbi\b|\bpune\b|mumbai|\bdubai\b"), "business_loan"),
    (re.compile(r"mortgage|\bloan|note payable|notes payable|\bn/p\b|promissory|\bsba\b|due to|financing|borrow"), "business_loan"),
]
# Accounts that are not a holding or a debt a lender lists: contra accounts,
# working-capital balances, payroll and tax accruals. They fall to the
# catch-all of their side, never to a bank or a loan category.
_ASSET_SKIP = re.compile(r"accum|depreciation|amortization|allowance|clearing|suspense|receivable|\ba/r\b|prepaid|inventory|undeposited|intercompany|due from")
_NOTES_RECEIVABLE = re.compile(r"notes? receivable|loans? receivable|\bn/r\b|note from|loan to\b")
_LIABILITY_SKIP = re.compile(r"accounts payable|\ba/p\b|accrued|payroll|withh|tax payable|sales tax|deferred|clearing|suspense|intercompany|security deposit|unearned")


def classify_account(section: str, code: str, title: str, account_type: str = "") -> tuple[str, str]:
    """(statement section, category) for a balance sheet account. Type first,
    then the title, then the GL group; the last resort is the catch-all of the
    account's side ("other_holding" / "other_liability")."""
    t = (title or "").lower()
    typed = _TYPE_CATEGORY.get((account_type or "").lower())
    if typed:
        return typed
    if section == "liability":
        if not _LIABILITY_SKIP.search(t):
            for rx, cat in _LIABILITY_WORDS:
                if rx.search(t):
                    return "liability", cat
        return "liability", "other_liability"
    if section != "asset":
        return "asset", "other_holding"
    if _NOTES_RECEIVABLE.search(t):
        return "asset", "notes_receivable"
    if _ASSET_SKIP.search(t):
        return "asset", "other_holding"
    if is_cash_title(title or ""):
        return "asset", "cash"
    for rx, cat in _ASSET_WORDS:
        if rx.search(t):
            return "asset", cat
    if _RE_WORDS.search(t):
        return "real_estate", "domestic_commercial"
    group = (code or "")[:2]
    if group in ("10", "11") or _ENDING.search(title or ""):
        return "asset", "bank"
    if group in ("15", "16", "17"):
        return "asset", "personal"
    return "asset", "other_holding"


# ── Which bank holds an account (Charmi, 10/03) ──────────────────────────────
# "The INSTITUTION shows Neil & Archana Kadakia - it must show the bank name.
# The bank name is available in the bank accounts. Bank accounts are linked to
# these GLs." The bank account records the accounting app keeps (Intacct's
# checking / savings / card accounts, and its own bank accounts) each point at
# a GL account; `_bank_directory` reads them through the internal dashboard
# API. When no record names a bank, the account's own title usually does
# ("Chase Checking - 6532"); `bank_name` reads it from there.
_BANK_NAMES = [
    (r"bank of the west|\bbotw\b|\bbow\b", "Bank of the West"),
    (r"bank of america|\bbofa\b|\bboa\b", "Bank of America"),
    (r"bank of baroda", "Bank of Baroda"),
    (r"bank of hope", "Bank of Hope"),
    (r"\bchase\b|jp\s*morgan|jpmc", "Chase"),
    (r"citi\s*bank|\bciti\b|citigroup", "Citibank"),
    (r"\bu\.?\s?s\.?\s*bank\b|\busbank\b", "U.S. Bank"),
    (r"wells\s*fargo|\bwfb\b", "Wells Fargo"),
    (r"farmers\s*(?:&|and)\s*merchants|\bf\s*&\s*m\b|\bfmb\b", "Farmers & Merchants Bank"),
    (r"first citizens", "First Citizens Bank"),
    (r"first republic", "First Republic Bank"),
    (r"\bpnc\b", "PNC Bank"),
    (r"capital\s*one", "Capital One"),
    (r"american express|\bamex\b", "American Express"),
    (r"\btd\s*bank\b", "TD Bank"),
    (r"\btruist\b", "Truist"),
    (r"\bhsbc\b", "HSBC"),
    (r"east\s*west|\bewb\b", "East West Bank"),
    (r"\bcathay\b", "Cathay Bank"),
    (r"silicon valley bank|\bsvb\b", "Silicon Valley Bank"),
    (r"\bcomerica\b", "Comerica"),
    (r"mechanics bank", "Mechanics Bank"),
    (r"union bank", "Union Bank"),
    (r"citizens bank", "Citizens Bank"),
    (r"\bkey\s*bank\b", "KeyBank"),
    (r"\bhuntington\b", "Huntington Bank"),
    (r"\bregions\b", "Regions Bank"),
    (r"\bally\b", "Ally Bank"),
    (r"\bmercury\b", "Mercury"),
    (r"\baxos\b", "Axos Bank"),
    (r"live oak", "Live Oak Bank"),
    (r"pacific premier", "Pacific Premier Bank"),
    (r"\bumpqua\b", "Umpqua Bank"),
    (r"\bzions\b", "Zions Bank"),
    (r"\bfrost\b", "Frost Bank"),
    (r"\bsantander\b", "Santander"),
    (r"\bbmo\b", "BMO"),
    (r"\bschwab\b", "Charles Schwab"),
    (r"\bfidelity\b", "Fidelity"),
    (r"\bvanguard\b", "Vanguard"),
    (r"morgan stanley", "Morgan Stanley"),
    (r"\bmerrill\b", "Merrill"),
    (r"e\s*\*?\s*trade", "E*TRADE"),
    (r"\bwebull\b", "Webull"),
    (r"\brobinhood\b", "Robinhood"),
    (r"\bcoinbase\b", "Coinbase"),
    (r"\bpaypal\b", "PayPal"),
    (r"\bvenmo\b", "Venmo"),
    (r"\bhdfc\b", "HDFC Bank"),
    (r"\bicici\b", "ICICI Bank"),
    (r"\bsbi\b|state bank of india", "State Bank of India"),
    (r"\bkotak\b", "Kotak Mahindra Bank"),
    (r"\baxis\b", "Axis Bank"),
]
_BANK_RX = [(re.compile(rx, re.I), name) for rx, name in _BANK_NAMES]
# Any other "<Something> Bank" / credit union / savings named in a title.
_BANK_GENERIC = re.compile(r"([A-Z][A-Za-z&.'\s]{1,40}?\b(?:Bank|Credit Union|Savings Bank|Federal Savings|Trust Company))\b")
_NOT_BANK_WORDS = re.compile(r"\b(?:checking|chkg|savings|operating|payroll|account|acct|money market)\b", re.I)


def bank_name(text: str) -> str:
    """The bank an account title (or a bank account record) names, or ''.
    "Chase Checking - 6532" -> "Chase"; "Bank of the West - 2721" -> "Bank of
    the West"; "CitiBank" -> "Citibank"; "US Bank Checking" -> "U.S. Bank"."""
    t = (text or "").strip()
    if not t:
        return ""
    for rx, name in _BANK_RX:
        if rx.search(t):
            return name
    m = _BANK_GENERIC.search(t)
    if m:
        name = _NOT_BANK_WORDS.sub("", m.group(1))
        name = re.sub(r"^(?:[A-Z]{2,4}\s*(?:&\s*[A-Z]{2,4})?\s*-\s*)", "", name)   # "NRK & ANK - " owner initials
        return re.sub(r"\s{2,}", " ", name).strip(" -&")
    return ""


async def _bank_directory(as_of: str) -> dict:
    """{(entity, gl_code): bank, gl_code: bank} from the bank account records
    the accounting app links to GL accounts. Read through its internal
    dashboard API (never its database); an app that cannot answer leaves the
    statement to read the bank from each account's title."""
    async def read(params: dict) -> dict:
        try:
            return await accounting._acct_get("/api/internal/dashboard", params)
        except HTTPException:
            return {}
    recon, tables = await asyncio.gather(read({"op": "recon-accounts", "scope": "ALL", "asof": as_of}),
                                         read({"op": "tables", "period": as_of[:7]}))
    by_entity: dict = {}
    by_code: dict[str, set] = {}
    code_of: dict[str, str] = {}

    def note(entity: str, code: str, name: str) -> None:
        if entity:
            by_entity[(entity, code)] = name
        by_code.setdefault(code, set()).add(name)

    # Oct 7 (Charmi: "the institution name is not coming in for all the
    # accounts"): codes and entities are compared trimmed; a bank record
    # whose GL id is not a recon account id is read as the GL code itself
    # when it is one (or when it sends `gl_code`); and an Intacct account
    # with no bank name of its own takes the name of the app's bank record
    # pointing at the same account (applied after both lists are read).
    recon_rows = [r for r in (recon.get("rows") if isinstance(recon.get("rows"), list) else []) if isinstance(r, dict) and r.get("gl_code")]
    unnamed: list[tuple[str, str]] = []
    for r in recon_rows:
        code = str(r["gl_code"]).strip()
        if r.get("account_id"):
            code_of[str(r["account_id"]).strip()] = code
    codes = set(code_of.values())
    for r in recon_rows:
        code = str(r["gl_code"]).strip()
        entity = str(r.get("entity") or "").strip()
        # The Intacct bank account linked to this GL and entity: its bank name
        # when the app sends one, else its id ("CHASE-6532", "BOTW 2721").
        name = bank_name(r.get("bank_name") or "") or (r.get("bank_name") or "").strip() or bank_name(r.get("intacct_ref") or "")
        if name:
            note(entity, code, name)
        elif entity:
            unnamed.append((entity, code))
    by_gl_id: dict[str, str] = {}
    for b in tables.get("banks") if isinstance(tables.get("banks"), list) else []:
        if not isinstance(b, dict):
            continue
        gid = str(b.get("gl_account_id") or "").strip()
        code = code_of.get(gid) or str(b.get("gl_code") or "").strip() or (gid if gid in codes or gid.isdigit() else "")
        raw = (b.get("bank_name") or "").strip()
        name = bank_name(raw) or raw or bank_name(b.get("nickname") or "")
        if code and name:
            note("", code, name)
            by_gl_id[code] = name
    for entity, code in unnamed:
        if (entity, code) not in by_entity and code in by_gl_id:
            by_entity[(entity, code)] = by_gl_id[code]
    # A GL code alone names a bank only when every record on it agrees: the
    # chart of accounts is shared, and 10100 is a different bank per entity.
    return {**by_entity, **{c: next(iter(n)) for c, n in by_code.items() if len(n) == 1}}


def _lineage(entity: str, parents: Optional[dict] = None) -> list[str]:
    """An entity, then its parent, its parent's parent... - the accounting
    app's parent chain, else Intacct's "67001-1" child-code convention."""
    out: list[str] = []
    code = (entity or "").strip()
    while code and code not in out and len(out) < 12:
        out.append(code)
        code = (parents or {}).get(code) or (code.rsplit("-", 1)[0] if "-" in code else "")
    return out


def _institution(line: dict, books: dict[str, dict[str, dict]], banks: dict, parents: Optional[dict] = None) -> str:
    """The Institution printed for a line. Typed by hand: as typed. Read from
    the ledger: the bank account record linked to its GL (in its entity, else
    in a parent entity - Oct 7), else the bank its account title names, else
    a bank in what was kept - never the entity or the guarantor (the setup
    used to put the entity's name there)."""
    d = line.get("details") or {}
    if line["source"] != "ledger" or d.get("institutionManual"):
        return line["institution"]
    entity = (line["ledgerEntity"] or "").strip()
    chain = _lineage(entity, parents)
    for code in line["ledgerAccounts"]:
        code = str(code).strip()
        hit = next((banks[(e, code)] for e in chain if (e, code) in banks), None) or banks.get(code)
        if hit:
            return hit
    for code in line["ledgerAccounts"]:
        hit = bank_name((books.get(entity, {}).get(code) or {}).get("title") or "")
        if hit:
            return hit
    return bank_name(line["label"]) or bank_name(line["institution"])


def _as_of(v: Optional[str]) -> str:
    v = (v or date.today().isoformat()).strip()
    if not _ISO.match(v):
        raise HTTPException(status_code=400, detail="asof must be YYYY-MM-DD")
    return v


@router.get("/ledger/entities")
async def ledger_entities():
    """Entities on the ledger, for the picker on a ledger line."""
    data = await accounting._acct_get("/api/internal/reports/locations", {})
    return {"entities": data.get("entities") or []}


@router.get("/ledger/accounts")
async def ledger_accounts(entity: str = Query(...), asof: Optional[str] = None):
    """Balance sheet accounts of one entity with their balance as of a date -
    what a line can be pointed at."""
    rows = await _balances(entity.strip(), _as_of(asof))
    out = []
    for c, v in sorted(rows.items()):
        section, category = classify_account(v["section"], c, v["title"], v.get("accountType") or "")
        out.append({"code": c, **v, "suggested": {"section": section, "category": category}})
    return {"entity": entity, "asOf": _as_of(asof), "accounts": out}


# ── The statement ────────────────────────────────────────────────────────────
def _figure(spec: dict, books: dict[str, dict[str, dict]]) -> tuple[float, str, list[str]]:
    """(balance, where it came from, GL codes not found) for one figure."""
    if spec.get("source") == "ledger":
        entity_books = books.get(spec.get("entity") or "", {})
        missing = [c for c in spec.get("accounts") or [] if c not in entity_books]
        total = sum(entity_books[c]["amount"] for c in spec.get("accounts") or [] if c in entity_books)
        return _r2(total), "ledger", missing
    return _r2(spec.get("value")), "manual", []


def _spec_of(line: dict) -> dict:
    return {"source": line["source"], "entity": line["ledgerEntity"], "accounts": line["ledgerAccounts"], "value": line["manualValue"]}


def _loan_spec(line: dict) -> dict:
    loan = line["details"].get("loan") if isinstance(line["details"].get("loan"), dict) else {}
    return {"source": loan.get("source") or "manual", "entity": loan.get("entity") or "", "accounts": loan.get("accounts") or [],
            "value": loan.get("value") or 0}


# ── Schedule E and Schedule C (Charmi, 10/01: "SCH C and Sch E reporting") ──
# One block per real estate line (Schedule E) or business interest (Schedule
# C) whose ledger entity is known, for the calendar year of the statement
# date: the entity's P&L accounts mapped to the IRS lines by their titles.
# Figures come from the accounting app's pnl, never from its database.
SCHEDULE_E_LINES = [
    ("advertising", "Advertising", r"advertis|marketing|promotion"),
    ("auto_travel", "Auto and Travel", r"\bauto\b|vehicle|travel|mileage|fuel|parking"),
    ("cleaning", "Cleaning and Maintenance", r"clean|janitor|maintenance|landscap|pest|trash|pool"),
    ("commissions", "Commissions", r"commission|leasing fee"),
    ("insurance", "Insurance", r"insurance"),
    ("legal", "Legal and Other Professional Fees", r"legal|attorney|professional|accounting fee|cpa|consult|audit"),
    ("management", "Management Fees", r"management fee|property management|mgmt"),
    ("mortgage_interest", "Mortgage Interest", r"mortgage interest|interest.*mortgage|loan interest"),
    ("other_interest", "Other Interest", r"interest"),
    ("repairs", "Repairs", r"repair"),
    ("supplies", "Supplies", r"suppl"),
    ("taxes", "Taxes", r"\btax|license|permit"),
    ("utilities", "Utilities", r"utilit|electric|water|sewer|gas and electric|internet|phone|telephone|cable"),
    ("depreciation", "Depreciation", r"depreciation|amortization"),
    ("other", "Other", r"."),
]
SCHEDULE_C_LINES = [
    ("advertising", "Advertising", r"advertis|marketing|promotion"),
    ("car_truck", "Car and Truck Expenses", r"\bauto\b|vehicle|car and truck|truck|mileage|fuel"),
    ("commissions", "Commissions and Fees", r"commission|merchant fee|bank fee|processing fee|service charge"),
    ("contract_labor", "Contract Labor", r"contract labor|contractor|subcontract|1099|temp"),
    ("depletion", "Depletion", r"depletion"),
    ("depreciation", "Depreciation", r"depreciation|amortization"),
    ("employee_benefits", "Employee Benefit Programs", r"benefit|health insurance|medical|dental|vision|workers comp"),
    ("insurance", "Insurance (Other Than Health)", r"insurance"),
    ("interest_mortgage", "Interest - Mortgage", r"mortgage interest|interest.*mortgage"),
    ("interest_other", "Interest - Other", r"interest"),
    ("legal", "Legal and Professional Services", r"legal|attorney|professional|accounting fee|cpa|consult|audit"),
    ("office", "Office Expense", r"office(?!\s*suppl)|postage|software|subscription|dues|printing|computer"),
    ("pension", "Pension and Profit-Sharing Plans", r"pension|401|retirement|profit.sharing"),
    ("rent_vehicles", "Rent or Lease - Vehicles, Machinery, Equipment", r"equipment (rent|lease)|vehicle lease|machinery"),
    ("rent_other", "Rent or Lease - Other Business Property", r"\brent\b|lease"),
    ("repairs", "Repairs and Maintenance", r"repair|maintenance|clean|janitor"),
    ("supplies", "Supplies", r"suppl"),
    ("taxes", "Taxes and Licenses", r"\btax|license|permit"),
    ("travel", "Travel", r"travel|lodging|hotel|airfare"),
    ("meals", "Deductible Meals", r"meal|entertain"),
    ("utilities", "Utilities", r"utilit|electric|water|sewer|internet|phone|telephone|cable"),
    ("wages", "Wages", r"wage|salar|payroll|bonus|compensation"),
    ("other", "Other Expenses", r"."),
]
_SCHEDULE_RX = {"e": [(k, l, re.compile(rx)) for k, l, rx in SCHEDULE_E_LINES],
                "c": [(k, l, re.compile(rx)) for k, l, rx in SCHEDULE_C_LINES]}


def irs_line(schedule: str, title: str) -> str:
    """The IRS line a P&L expense account's title lands on ("e" or "c"); the
    first match in the schedule's order wins, "other" catches the rest."""
    t = (title or "").lower()
    for key, _label, rx in _SCHEDULE_RX[schedule]:
        if rx.search(t):
            return key
    return "other"


def _schedule_block(schedule: str, line: dict, pnl: dict, year: str) -> dict:
    """One Schedule E (real estate) or C (business) block from an entity's
    P&L for the year: income, the expense lines in IRS order, the net."""
    sections = {s.get("key"): s for s in (pnl.get("sections") or [])}
    accounts = lambda key: [a for a in (sections.get(key) or {}).get("accounts") or [] if a.get("account_no")]  # noqa: E731
    income = _r2(sum(_r2(a.get("amount")) for a in accounts("revenue")) + sum(_r2(a.get("amount")) for a in accounts("other_income")))
    cogs = _r2(sum(_r2(a.get("amount")) for a in accounts("cogs")))
    by_line: dict[str, dict] = {}
    for a in accounts("expense") + accounts("other_expense"):
        key = irs_line(schedule, a.get("title") or "")
        row = by_line.setdefault(key, {"amount": 0.0, "accounts": []})
        row["amount"] = _r2(row["amount"] + _r2(a.get("amount")))
        row["accounts"].append({"code": a["account_no"], "title": a.get("title") or "", "amount": _r2(a.get("amount"))})
    expense_lines = [{"key": k, "label": label, "amount": by_line[k]["amount"], "accounts": by_line[k]["accounts"]}
                     for k, label, _rx in _SCHEDULE_RX[schedule] if k in by_line]
    expenses = _r2(sum(x["amount"] for x in expense_lines))
    net = _r2(income - cogs - expenses)
    pct = line["ownershipPct"]
    return {"lineId": line["id"], "label": line["label"], "entity": _schedule_entity(line), "year": year, "ownershipPct": pct,
            "income": income, "cogs": cogs, "expenses": expenses, "lines": expense_lines, "net": net, "netAtShare": _r2(net * pct / 100),
            "address": (line["details"] or {}).get("address", "")}


def _schedule_entity(line: dict) -> str:
    """The entity whose P&L is the line's schedule: the one named for it, else
    the one its value reads, else (real estate) the one its loan reads."""
    d = line.get("details") or {}
    if d.get("schedule_entity"):
        return str(d["schedule_entity"])
    if line.get("source") == "ledger" and line.get("ledgerEntity"):
        return line["ledgerEntity"]
    if line.get("section") == "real_estate":
        loan = _loan_spec(line)
        if loan["source"] == "ledger" and loan["entity"]:
            return loan["entity"]
    return ""


def schedules(lines: list[dict], as_of: str, pnls: dict[str, dict]) -> dict:
    """Schedule E and C blocks for the calendar year of `as_of`. `pnls` is
    {entity: the accounting app's pnl for that year}."""
    year = as_of[:4]
    e, c = [], []
    for line in lines:
        entity = _schedule_entity(line)
        if not entity or entity not in pnls:
            continue
        if line["section"] == "real_estate":
            e.append(_schedule_block("e", line, pnls[entity], year))
        elif line["section"] == "asset" and line["category"] == "business":
            c.append(_schedule_block("c", line, pnls[entity], year))
    return {"year": year, "e": e, "c": c}


def _schedule_entities(lines: list[dict]) -> list[str]:
    return sorted({_schedule_entity(l) for l in lines
                   if _schedule_entity(l) and (l["section"] == "real_estate" or (l["section"] == "asset" and l["category"] == "business"))})


# ── The first page: a Statement of Financial Condition (Charmi, 10/04) ──────
# "You need to build out the first page of our PFS": the one page a bank's
# own form opens with - every line of it, in the bank's words, whether or not
# anything is listed under it - built from the sections the statement keeps.
CONDITION_ASSETS = [
    ("cash", "Cash on Hand", ("cash",)),
    ("bank", "Bank Accounts / Cash Equivalents", ("bank",)),
    ("securities", "Marketable Securities", ("investment",)),
    ("retirement", "Retirement Accounts", ("retirement",)),
    ("real_estate", "Real Estate", ()),
    ("business", "Business Interests / Closely Held", ("business",)),
    ("notes_receivable", "Notes Receivable", ("notes_receivable",)),
    ("insurance", "Cash Value of Life Insurance", ("insurance",)),
    ("vehicles", "Vehicles", ("vehicles",)),
    ("personal", "Personal Holdings", ("personal",)),
    ("other", "Other Assets", ("other_holding",)),
]
CONDITION_LIABILITIES = [
    # Oct 7: residential loans are notes payable to banks; International Debt
    # and the Loans on Life Insurance line are gone (their old lines read as
    # Commercial Loans / Other Liabilities - _LEGACY).
    ("notes_banks", "Notes Payable to Banks", ("business_loan", "loc", "residential_loan")),
    ("mortgages", "Mortgages on Real Estate", ()),
    ("credit_cards", "Credit Cards", ("credit_card",)),
    ("auto", "Automobile Loans", ("auto",)),
    ("other", "Other Liabilities", ("other_liability",)),
]


def _ownership(rows: list[dict]) -> str:
    """The share column of a first-page line: one percent when every row
    under it is owned alike, "Various" when they differ, blank when empty."""
    pcts = {round(float(r["ownershipPct"]), 2) for r in rows}
    if not pcts:
        return ""
    if len(pcts) > 1:
        return "Various"
    p = pcts.pop()
    return f"{p:g}%"


def _condition(assets: list[dict], liabilities: list[dict], real_estate: list[dict], contingent: list[dict], schedules_: dict,
               profile: dict) -> dict:
    by_cat = {g["key"]: g for g in assets + liabilities}
    re_rows = [r for g in real_estate for r in g["rows"]]

    def lines(spec, real_key):
        out = []
        for key, label, cats in spec:
            rows = [r for c in cats for r in (by_cat.get(c) or {}).get("rows", [])]
            if key == real_key:
                rows = re_rows
                amount = _r2(sum(r["valueAdjusted"] if real_key == "real_estate" else r["loanAdjusted"] for r in rows))
            else:
                amount = _r2(sum(r["adjusted"] for r in rows))
            out.append({"key": key, "label": label, "ownership": _ownership(rows), "count": len(rows), "amount": amount})
        return out

    a = lines(CONDITION_ASSETS, "real_estate")
    liab = lines(CONDITION_LIABILITIES, "mortgages")
    # Annual income: what the schedules hold for the calendar year, at the
    # guarantor's share. Nothing is invented when there is no schedule.
    income = []
    if schedules_.get("e"):
        income.append({"key": "rental", "label": "Net Rental Income (Schedule E)", "amount": _r2(sum(b["netAtShare"] for b in schedules_["e"]))})
    if schedules_.get("c"):
        income.append({"key": "business", "label": "Net Business Income (Schedule C)", "amount": _r2(sum(b["netAtShare"] for b in schedules_["c"]))})
    # Contingent liabilities: the guarantees listed, and what the guarantor
    # answered when asked whether there are others.
    asked = next((h for h in profile.get("history") or [] if "guarantor" in (h.get("question") or "").lower()), None)
    return {
        "assets": a, "liabilities": liab,
        "totals": {"assets": _r2(sum(x["amount"] for x in a)), "liabilities": _r2(sum(x["amount"] for x in liab))},
        "contingent": [{"label": r["label"], "institution": r["institution"], "ownershipPct": r["ownershipPct"], "amount": r["adjusted"], "notes": r["notes"]}
                       for r in contingent],
        "contingentAnswer": {"answer": asked.get("answer", ""), "note": asked.get("note", "")} if asked else None,
        "income": {"year": schedules_.get("year", ""), "lines": income, "total": _r2(sum(x["amount"] for x in income))} if income else None,
    }


# ── The share % from Affiliated Entities (Charmi, Oct 7) ────────────────────
# "Whenever we are adding any entity into the PFS, the % calculations should
# be calculated based on the inputs into the affiliated entities." A line
# whose details.shareFrom is "affiliated" takes, at read time, the share of the
# Affiliated Entities row whose ledger entity is the line's (a sub-entity
# inherits its parent's row unless it has its own): Beneficial % when set,
# else the sum of the borrowers' ownership % (pfs_affiliates.share_of). A %
# typed on the line ("manual") always wins.
def _share_entity(line: dict) -> str:
    return _schedule_entity(line)


def resolve_share(entity: str, shares: dict, parents: Optional[dict] = None) -> Optional[dict]:
    """The Affiliated Entities share for an entity code, or None. Adds `via`
    (the entity whose row it is) and `inherited` (True when that is a parent)."""
    for code in _lineage(entity, parents):
        if code in shares:
            return {**shares[code], "via": code, "inherited": code != (entity or "").strip()}
    return None


def apply_shares(lines: list[dict], shares: dict, parents: Optional[dict] = None) -> list[dict]:
    """The lines with the share they read. Every line gets (Oct 7):
      storedOwnershipPct - the % saved on the line;
      ownershipPct       - the % the statement uses (the Affiliated one when
                           shareFrom is "affiliated" and a row exists);
      affiliatedShare    - resolve_share() for the line's entity, or None;
      shareMissing       - shareFrom "affiliated" but no row with a % (the
                           saved % is used)."""
    out = []
    for l in lines:
        share = resolve_share(_share_entity(l), shares, parents) if shares else None
        affiliated = (l.get("details") or {}).get("shareFrom") == "affiliated"
        stored = l["ownershipPct"]
        out.append({**l, "storedOwnershipPct": stored, "ownershipPct": share["pct"] if affiliated and share else stored,
                    "shareFrom": "affiliated" if affiliated else "manual", "affiliatedShare": share,
                    "shareMissing": bool(affiliated and not share)})
    return out


def compute(profile: dict, lines: list[dict], as_of: str, books: dict[str, dict[str, dict]], pnls: Optional[dict[str, dict]] = None,
            banks: Optional[dict] = None, shares: Optional[dict] = None, parents: Optional[dict] = None) -> dict:
    """The statement for one date. Pure: the lines and the ledger balances in,
    the figures out. `books` is {entity: {gl_code: {amount, ...}}}; `pnls`
    (optional) is {entity: pnl for the year} for the schedules; `banks`
    (optional) is the bank account records by (entity, GL) and GL; `shares`
    (optional) is pfs_affiliates.shares() and `parents` {entity: parent}.

    Oct 7 fields on every statement row: shareFrom, affiliatedShare,
    storedOwnershipPct, shareMissing (see apply_shares) and institutionMissing
    (True when an asset/liability row has no Institution - the UI offers "Not
    found - set it"). New top-level `investments` (see _investments)."""
    warnings: list[str] = []
    banks = banks or {}
    lines = apply_shares(lines, shares or {}, parents)

    def row(line: dict, spec: dict, what: str = "") -> dict:
        balance, source, missing = _figure(spec, books)
        if missing:
            warnings.append(f"{line['label']}{what}: account {', '.join(missing)} has no balance in entity {spec.get('entity')} as of this date.")
        pct = line["ownershipPct"]
        institution = _institution(line, books, banks, parents)
        return {"id": line["id"], "label": line["label"], "institution": institution, "accountRef": line["accountRef"],
                "ownershipPct": pct, "balance": balance, "adjusted": _r2(balance * pct / 100), "source": source,
                "asOf": as_of if source == "ledger" else (line["manualAsOf"] or ""), "notes": line["notes"], "details": line["details"],
                "shareFrom": line["shareFrom"], "affiliatedShare": line["affiliatedShare"], "storedOwnershipPct": line["storedOwnershipPct"],
                "shareMissing": line["shareMissing"], "institutionMissing": line["section"] != "real_estate" and not (institution or "").strip()}

    def group(section: str, categories: list) -> list[dict]:
        out = []
        for key, label in categories:
            rows = [row(l, _spec_of(l)) for l in lines if l["section"] == section and l["category"] == key]
            if rows:
                out.append({"key": key, "label": label, "rows": rows, "total": _r2(sum(r["adjusted"] for r in rows))})
        return out

    assets = group("asset", ASSET_CATEGORIES)
    # Guarantees are listed, never added in: they are what the guarantor may
    # owe, not what they owe.
    contingent = [r for g in group("liability", RETIRED_LIABILITY_CATEGORIES) for r in g["rows"]]
    liabilities = group("liability", LIABILITY_CATEGORIES)

    # The schedule of real estate: each property is a value and a loan, both
    # at the guarantor's share. Their totals join the assets and liabilities.
    real_estate = []
    for key, label in REAL_ESTATE_KINDS:
        rows = []
        for l in lines:
            if l["section"] != "real_estate" or l["category"] != key:
                continue
            value = row(l, _spec_of(l), " (value)")
            loan = row(l, _loan_spec(l), " (loan)")
            rows.append({**value, "value": value["balance"], "valueAdjusted": value["adjusted"], "loan": loan["balance"],
                         "loanAdjusted": loan["adjusted"], "loanSource": loan["source"],
                         "equity": _r2(value["adjusted"] - loan["adjusted"])})
        if rows:
            real_estate.append({"key": key, "label": label, "rows": rows,
                                "value": _r2(sum(r["valueAdjusted"] for r in rows)), "loan": _r2(sum(r["loanAdjusted"] for r in rows))})
    re_value = _r2(sum(g["value"] for g in real_estate))
    re_loan = _r2(sum(g["loan"] for g in real_estate))

    summary_assets = [{"label": g["label"], "amount": g["total"]} for g in assets]
    if real_estate:
        summary_assets.append({"label": "Real Estate (fair market value)", "amount": re_value})
    summary_liabilities = ([{"label": "Real Estate Loans", "amount": re_loan}] if real_estate else []) + \
        [{"label": g["label"], "amount": g["total"]} for g in liabilities]
    total_assets = _r2(sum(x["amount"] for x in summary_assets))
    total_liabilities = _r2(sum(x["amount"] for x in summary_liabilities))
    sched = schedules(lines, as_of, pnls or {})
    return {
        "profile": {k: profile[k] for k in ("id", "name", "displayName", "kind", "details", "history", "executiveProfile")},
        "asOf": as_of, "assets": assets, "liabilities": liabilities, "realEstate": real_estate,
        "summary": {"assets": summary_assets, "liabilities": summary_liabilities},
        "totals": {"assets": total_assets, "liabilities": total_liabilities, "netWorth": _r2(total_assets - total_liabilities)},
        "condition": _condition(assets, liabilities, real_estate, contingent, sched, profile),
        "investments": _investments(assets, real_estate),
        "schedules": sched,
        "warnings": warnings,
    }


# ── Investments (Charmi, 10/03: "Add Investments under Assets in PFS - Real
# Estate should be included under Investments") ─────────────────────────────
# Reading A (Oct 7 default): one Investments group - Investment Accounts,
# Business Interests and Real Estate (equity at share, one line per
# property) - with a subtotal. It is a WAY OF SHOWING the assets, not more of
# them: the totals still count each property's value once in total assets and
# its loan once in total liabilities, so its equity is in net worth exactly
# once. The Real Estate tab stays where properties and mortgages are kept.
INVESTMENT_ASSET_KEYS = ("investment", "business")


def _investments(assets: list[dict], real_estate: list[dict]) -> dict:
    """-> {label, groups: [{key, label, rows, total}], total, assetKeys,
    realEstate: {value, loans, equity}, note}. `groups` holds the asset groups
    `assetKeys` (Investment Accounts, Business Interests - the same rows as in
    `assets`, so a screen that shows this block skips those groups in
    `assets`) and, last, key "real_estate_equity": one row per property
    {id, label, category, categoryLabel, ownershipPct, valueAdjusted,
    loanAdjusted, equity, details}. `total` = the asset groups + real estate
    equity; it is never added to `totals`."""
    by_key = {g["key"]: g for g in assets}
    groups = [{"key": k, "label": by_key[k]["label"], "rows": by_key[k]["rows"], "total": by_key[k]["total"]}
              for k in INVESTMENT_ASSET_KEYS if k in by_key]
    re_rows = [{"id": r["id"], "label": r["label"], "category": g["key"], "categoryLabel": g["label"], "ownershipPct": r["ownershipPct"],
                "valueAdjusted": r["valueAdjusted"], "loanAdjusted": r["loanAdjusted"], "equity": r["equity"], "details": r["details"]}
               for g in real_estate for r in g["rows"]]
    value = _r2(sum(r["valueAdjusted"] for r in re_rows))
    loans = _r2(sum(r["loanAdjusted"] for r in re_rows))
    equity = _r2(value - loans)
    if re_rows:
        groups.append({"key": "real_estate_equity", "label": "Real Estate", "rows": re_rows, "total": equity})
    return {"label": "Investments", "groups": groups, "total": _r2(sum(g["total"] for g in groups)),
            "assetKeys": [g["key"] for g in groups if g["key"] != "real_estate_equity"],
            "realEstate": {"value": value, "loans": loans, "equity": equity},
            "note": "Real estate is shown here at equity (market value less loans, at the share owned). "
                    "Its market value and loans are counted once, in total assets and total liabilities."}


def _entities_of(lines: list[dict]) -> list[str]:
    out = set()
    for l in lines:
        if l["source"] == "ledger" and l["ledgerEntity"]:
            out.add(l["ledgerEntity"])
        if l["section"] == "real_estate":
            loan = _loan_spec(l)
            if loan["source"] == "ledger" and loan["entity"]:
                out.add(loan["entity"])
    return sorted(out)


async def _pnl(entity: str, year: str) -> dict:
    """An entity's P&L for a calendar year, from the accounting app. An entity
    the app cannot report on leaves its schedule out rather than failing the
    statement."""
    try:
        return await accounting._acct_get("/api/internal/reports/pnl", {"from": f"{year}-01-01", "to": f"{year}-12-31", "location": entity})
    except HTTPException:
        return {}


async def _statement(profile_id: str, as_of: str) -> dict:
    profile, lines, shares = await asyncio.to_thread(_load, profile_id)
    entities = _entities_of(lines)
    sched = _schedule_entities(lines)
    # The bank account records are read only when a line reads the ledger
    # outside real estate - the lines whose Institution they name. The parent
    # map serves both a share inherited from a parent's Affiliated row and a
    # bank record kept on the parent entity.
    wants_banks = any(l["source"] == "ledger" and l["section"] != "real_estate" for l in lines)
    wants_parents = wants_banks or bool(shares and any(_share_entity(l) and _share_entity(l) not in shares for l in lines))
    fetched = await asyncio.gather(*[_balances(e, as_of) for e in entities], *[_pnl(e, as_of[:4]) for e in sched],
                                   _bank_directory(as_of) if wants_banks else _nothing(),
                                   _parents() if wants_parents else _nothing())
    books = dict(zip(entities, fetched[:len(entities)]))
    pnls = {e: p for e, p in zip(sched, fetched[len(entities):len(entities) + len(sched)]) if p.get("sections")}
    return await asyncio.to_thread(pfs_affiliates.attach, profile_id,
                                   compute(profile, lines, as_of, books, pnls, fetched[-2], shares, fetched[-1]))


async def _nothing() -> dict:
    return {}


@router.get("/profiles/{profile_id}/statement")
async def statement(profile_id: str, asof: Optional[str] = None):
    """The statement as of a date, computed now. Nothing is kept."""
    return await _statement(profile_id, _as_of(asof))


class ProduceBody(BaseModel):
    asof: Optional[str] = None
    format: Optional[str] = "pdf"     # pdf | xlsx (Neil, 10/01: "in excel also") - what the audit says went out
    # Oct 6 (Charmi: one Export menu, the one Reports has): where the file
    # went - downloaded, emailed, or saved to Files. The audit says which.
    delivery: Optional[str] = "download"


@router.post("/profiles/{profile_id}/statements", status_code=201)
async def produce(profile_id: str, body: ProduceBody, user: dict = Depends(_read)):
    """Compute the statement and KEEP it: this is what goes to a lender, so the
    exact figures stay on record and the audit log says who produced it."""
    as_of = _as_of(body.asof)
    payload = await _statement(profile_id, as_of)
    fmt = {"excel": "xlsx"}.get(body.format or "", body.format)
    fmt = fmt if fmt in ("pdf", "xlsx") else "pdf"
    delivery = body.delivery if body.delivery in ("download", "email", "files") else "download"
    sid = await asyncio.to_thread(_save_statement, profile_id, as_of, payload, user, fmt, delivery)
    return {"id": sid, **payload}


# ── Share % from Affiliated Entities: for the screens (Charmi, Oct 7) ───────
@router.get("/profiles/{profile_id}/affiliated-shares")
async def affiliated_shares(profile_id: str, entities: Optional[str] = Query(None)):
    """What a line of each entity would take from Affiliated Entities.
    -> {"shares": {code: share}} for every row with a ledger entity, and, when
    `entities` (comma-separated codes) is given, {"resolved": {code: share |
    null}} for each of them - a sub-entity reads its parent's row when it has
    none of its own. A share is {pct, basis ("beneficial"|"ownership"),
    parts: [{key, name, pct}], text ("Neil R. Kadakia 10% + Archana N.
    Kadakia 10%" / "Beneficial 20%"), affiliateId, affiliateName, entity, and
    in `resolved` also via (the entity whose row it is) and inherited}."""
    await asyncio.to_thread(_require_profile, profile_id)
    shares = await asyncio.to_thread(_shares_of, profile_id)
    asked = [e.strip() for e in (entities or "").split(",") if e.strip()][:200]
    out: dict = {"shares": shares}
    if asked:
        parents = await _parents_if_needed(asked, shares)
        out["resolved"] = {e: resolve_share(e, shares, parents) for e in asked}
    return out


def _require_profile(profile_id: str) -> None:
    db = SessionLocal()
    try:
        _get_profile(db, profile_id)
    finally:
        db.close()


@router.get("/profiles/{profile_id}/share-mismatches")
async def share_mismatches(profile_id: str):
    """Lines whose entity has an Affiliated Entities share but which use a
    different % and have not been told to keep it (shareFrom is not
    "affiliated", and was never set to "manual" on purpose - i.e. lines saved
    before Oct 7). For the one-time "Update / Keep" offer.
    -> {"lines": [{id, label, section, category, entity, ownershipPct,
    affiliatedPct, text, affiliateName, via}], "count": n}"""
    _p, lines, shares = await asyncio.to_thread(_load, profile_id)
    parents = await _parents_if_needed([_share_entity(l) for l in lines], shares)
    out = []
    for l in lines:
        if "shareFrom" in (l.get("details") or {}):
            continue
        s = resolve_share(_share_entity(l), shares, parents) if shares else None
        if s and abs(float(s["pct"]) - float(l["ownershipPct"])) > 0.0001:
            out.append({"id": l["id"], "label": l["label"], "section": l["section"], "category": l["category"], "entity": _share_entity(l),
                        "ownershipPct": l["ownershipPct"], "affiliatedPct": s["pct"], "text": s["text"], "affiliateName": s["affiliateName"],
                        "via": s["via"]})
    return {"lines": out, "count": len(out)}


class ShareChoiceBody(BaseModel):
    ids: list[str]
    action: str    # "update" -> follow Affiliated Entities | "keep" -> keep the line's own %


@router.post("/profiles/{profile_id}/share-mismatches")
async def resolve_share_mismatches(profile_id: str, body: ShareChoiceBody, user: dict = Depends(_edit)):
    """Answer the offer for some lines: "update" makes them follow Affiliated
    Entities (shareFrom "affiliated", saved % set to it); "keep" marks their own
    % as chosen (shareFrom "manual") so they are not offered again.
    -> {"updated": n, "lines": [line, ...]} (lines as GET /profiles/{id} returns them)."""
    if body.action not in ("update", "keep"):
        raise HTTPException(status_code=400, detail="action must be update or keep")
    ids = [str(i) for i in (body.ids or [])][:400]
    if not ids:
        raise HTTPException(status_code=400, detail="Pick at least one line.")
    shares = await asyncio.to_thread(_shares_of, profile_id)
    _p, lines, _s = await asyncio.to_thread(_load, profile_id)
    parents = await _parents_if_needed([_share_entity(l) for l in lines if l["id"] in ids], shares)
    pcts = {}
    for l in lines:
        if l["id"] in ids:
            s = resolve_share(_share_entity(l), shares, parents) if shares else None
            pcts[l["id"]] = s["pct"] if s else None
    return await asyncio.to_thread(_apply_share_choice, profile_id, ids, body.action, pcts, user, shares, parents)


def _apply_share_choice(profile_id: str, ids: list[str], action: str, pcts: dict, user: dict, shares: dict, parents: dict) -> dict:
    db = SessionLocal()
    try:
        rows = db.query(models.PfsLine).filter(models.PfsLine.profile_id == profile_id, models.PfsLine.id.in_(ids)).all()
        if len(rows) != len(set(ids)):
            raise HTTPException(status_code=404, detail="A line is not on this statement.")
        if action == "update" and any(pcts.get(r.id) is None for r in rows):
            raise HTTPException(status_code=400, detail="A line's entity has no percent on Affiliated Entities.")
        for r in rows:
            details = dict(r.details) if isinstance(r.details, dict) else {}
            details["shareFrom"] = "affiliated" if action == "update" else "manual"
            r.details = details
            if action == "update":
                r.ownership_pct = pcts[r.id]
            r.updated_by, r.updated_at = user["email"], _now()
        _audit(db, user, "pfs_line_shares_" + ("followed" if action == "update" else "kept"), profile_id, {"count": len(rows)})
        db.commit()
        return {"updated": len(rows), "lines": apply_shares([_line_out(r) for r in rows], shares, parents)}
    finally:
        db.close()


# ── Password-protected PDF (Charmi, 10/03; Oct 7 default: a password typed at
# export, never stored) ──────────────────────────────────────────────────────
# The browser builds the PDF (pfsPdf.js) and sends it here with the password
# the person typed; the answer is the same PDF encrypted AES-256 (pypdf). The
# password is never stored, never logged and never in the audit row. The body
# is read by hand, not through a model, so a malformed request can never
# echo the password back in a validation error.
PDF_MAX_BYTES = 25 * 1024 * 1024


@router.post("/profiles/{profile_id}/pdf/encrypt")
async def encrypt_pdf(profile_id: str, request: Request, user: dict = Depends(_read)):
    """Body JSON: {"pdf": base64 of the PDF, "password": str (4-128
    characters), "statementId": optional id of the kept statement it prints}.
    -> {"pdf": base64 of the encrypted PDF, "encryption": "AES-256"}."""
    import base64
    try:
        body = json.loads(await request.body() or b"{}")
    except ValueError:
        raise HTTPException(status_code=400, detail="Send the PDF and a password.")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Send the PDF and a password.")
    password = body.get("password")
    if not isinstance(password, str) or not 4 <= len(password) <= 128:
        raise HTTPException(status_code=400, detail="The password must be 4 to 128 characters.")
    raw = body.get("pdf")
    try:
        data = base64.b64decode(raw if isinstance(raw, str) else "", validate=True)
    except (ValueError, TypeError):
        data = b""
    if not data.startswith(b"%PDF"):
        raise HTTPException(status_code=400, detail="That is not a PDF.")
    if len(data) > PDF_MAX_BYTES:
        raise HTTPException(status_code=413, detail="The PDF is too large.")
    sid = str(body.get("statementId") or "")[:64]
    out = await asyncio.to_thread(_encrypt, profile_id, data, password, sid, user)
    return {"pdf": base64.b64encode(out).decode("ascii"), "encryption": "AES-256"}


def encrypt_pdf_bytes(data: bytes, password: str) -> bytes:
    """The PDF encrypted with AES-256: the password opens it; printing and
    copying stay allowed once open."""
    import io

    from pypdf import PdfReader, PdfWriter
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise HTTPException(status_code=400, detail="That PDF is already protected.")
        writer = PdfWriter(clone_from=reader)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="That PDF could not be read.")
    writer.encrypt(user_password=password, owner_password=None, algorithm="AES-256")
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def _encrypt(profile_id: str, data: bytes, password: str, sid: str, user: dict) -> bytes:
    db = SessionLocal()
    try:
        _get_profile(db, profile_id)
        out = encrypt_pdf_bytes(data, password)
        # Who, which file, which statement - never the password, never a figure.
        _audit(db, user, "pfs_pdf_encrypted", profile_id, {"statement": sid, "encryption": "AES-256"} if sid else {"encryption": "AES-256"})
        db.commit()
        return out
    finally:
        db.close()


@router.get("/profiles/{profile_id}/statements")
def list_statements(profile_id: str, db: Session = Depends(get_db)):
    rows = (db.query(models.PfsStatement).filter(models.PfsStatement.profile_id == profile_id)
            .order_by(models.PfsStatement.generated_at.desc()).limit(50).all())
    return [{"id": s.id, "asOf": s.as_of, "generatedBy": s.generated_by, "generatedAt": s.generated_at,
             "netWorth": ((s.payload or {}).get("totals") or {}).get("netWorth", 0)} for s in rows]


@router.get("/statements/{statement_id}")
def get_statement(statement_id: str, user: dict = Depends(_read), db: Session = Depends(get_db)):
    s = db.query(models.PfsStatement).filter(models.PfsStatement.id == statement_id).first()
    if not s:
        raise HTTPException(status_code=404, detail="Statement not found.")
    _audit(db, user, "pfs_statement_opened", s.profile_id, {"statement": s.id})
    db.commit()
    return {"id": s.id, "generatedBy": s.generated_by, "generatedAt": s.generated_at, **(s.payload or {})}
