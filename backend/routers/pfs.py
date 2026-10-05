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
ASSET_CATEGORIES = [
    ("bank", "Bank Accounts"),
    ("retirement", "Retirement Accounts"),
    ("investment", "Investment Accounts"),
    ("business", "Business Interests"),
    ("insurance", "Insurance"),
    ("personal", "Personal Holdings"),
    ("jewelry", "Jewelry & Personal Property"),
    ("other_holding", "Other Holdings"),
]
LIABILITY_CATEGORIES = [
    ("business_loan", "Business Loans"),
    ("international", "International Debt"),
    ("auto", "Automobile Loans"),
    ("loc", "Lines of Credit"),
    ("credit_card", "Credit Cards"),
    ("other_liability", "Other Liabilities"),
]
REAL_ESTATE_KINDS = [
    ("domestic_residential", "Domestic Residential Real Estate"),
    ("domestic_commercial", "Domestic Commercial Real Estate"),
    ("international_residential", "International Residential Real Estate"),
    ("international_commercial", "International Commercial Real Estate"),
]
# The three categories the schedule had before 09/30, as the four read them.
_RE_LEGACY = {"residential": "domestic_residential", "commercial": "domestic_commercial", "international_re": "international_residential"}
_CATEGORIES = {
    "asset": [c for c, _ in ASSET_CATEGORIES],
    "liability": [c for c, _ in LIABILITY_CATEGORIES],
    "real_estate": [c for c, _ in REAL_ESTATE_KINDS],
}
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
_DETAIL_KEYS = ("address", "city_state_zip", "phone", "email", "date_of_birth", "marital_status", "employer", "title",
                "ssn_last4", "members", "spouse", "coBorrower")
# The co-borrower (Charmi, 10/01: "Spouse/Co-borrower details as well") mirrors
# the borrower's fields, plus a name.
_CO_BORROWER_KEYS = ("name", "address", "city_state_zip", "phone", "email", "date_of_birth", "marital_status", "employer",
                     "title", "ssn_last4")
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_PHOTO_MAX = 400_000   # characters of data URL (a downscaled JPEG is a tenth of this)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _r2(v) -> float:
    return round(float(v or 0) + 0.0, 2)


def _audit(db: Session, user: dict, action: str, resource_id: str, details: Optional[dict] = None) -> None:
    db.add(models.AuditLog(timestamp=_now(), user_email=user["email"], user_role=user.get("role", ""), action=action,
                           resource_type="pfs", resource_id=resource_id, details=json.dumps(details or {})))


# ── Shapes ───────────────────────────────────────────────────────────────────
def _display_name(p: models.PfsProfile) -> str:
    """The name on the statement: "Neil R. Kadakia and Archana Kadakia" when a
    spouse is set, the name alone otherwise."""
    d = p.details if isinstance(p.details, dict) else {}
    co = d.get("coBorrower") if isinstance(d.get("coBorrower"), dict) else {}
    spouse = (d.get("spouse") or co.get("name") or "").strip()
    return f"{p.name} and {spouse}" if spouse and spouse.lower() not in (p.name or "").lower() else p.name


def _profile_out(p: models.PfsProfile, full: bool = True) -> dict:
    out = {"id": p.id, "name": p.name, "displayName": _display_name(p), "kind": p.kind or "individual", "archived": bool(p.archived),
           "updatedAt": p.updated_at, "hasPhoto": bool(p.photo)}
    if full:
        out.update({"details": p.details if isinstance(p.details, dict) else {},
                    "history": p.history if isinstance(p.history, list) else [],
                    "executiveProfile": p.executive_profile or "", "photo": p.photo or ""})
    return out


def _line_out(l: models.PfsLine) -> dict:
    return {"id": l.id, "section": l.section, "category": _RE_LEGACY.get(l.category, l.category), "label": l.label or "", "institution": l.institution or "",
            "accountRef": l.account_ref or "", "ownershipPct": float(l.ownership_pct if l.ownership_pct is not None else 100),
            "source": l.source or "manual", "ledgerEntity": l.ledger_entity or "",
            "ledgerAccounts": l.ledger_accounts if isinstance(l.ledger_accounts, list) else [],
            "manualValue": float(l.manual_value or 0), "manualAsOf": l.manual_as_of or "",
            "details": l.details if isinstance(l.details, dict) else {}, "sort": l.sort or 0, "notes": l.notes or ""}


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


def _clean_details(d: Optional[dict]) -> dict:
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
        if k == "ssn_last4":
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


def _clean_line(body: LineBody) -> dict:
    if body.section not in _CATEGORIES:
        raise HTTPException(status_code=400, detail="section must be asset, liability or real_estate")
    body.category = _RE_LEGACY.get(body.category, body.category)
    if body.category not in _CATEGORIES[body.section]:
        raise HTTPException(status_code=400, detail=f"category must be one of {', '.join(_CATEGORIES[body.section])}")
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
    details = body.details if isinstance(body.details, dict) else {}
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


def _load(profile_id: str) -> tuple[dict, list[dict]]:
    db = SessionLocal()
    try:
        p = _get_profile(db, profile_id)
        lines = (db.query(models.PfsLine).filter(models.PfsLine.profile_id == profile_id)
                 .order_by(models.PfsLine.sort, models.PfsLine.label).all())
        return _profile_out(p), [_line_out(l) for l in lines]
    finally:
        db.close()


def _save_statement(profile_id: str, as_of: str, payload: dict, user: dict, fmt: str = "pdf") -> str:
    db = SessionLocal()
    try:
        sid = str(uuid.uuid4())
        db.add(models.PfsStatement(id=sid, profile_id=profile_id, as_of=as_of, payload=payload,
                                   generated_by=user["email"], generated_at=_now()))
        # Who, which guarantor, which date, which file - never a figure: the
        # audit log is read by people who may not see the statement itself.
        _audit(db, user, "pfs_statement_produced", profile_id, {"statement": sid, "as_of": as_of, "format": fmt})
        db.commit()
        return sid
    finally:
        db.close()


# ── Profiles ─────────────────────────────────────────────────────────────────
@router.get("/meta")
def meta():
    """The vocabulary of a statement: sections, categories, the standard questions."""
    pair = lambda rows: [{"key": k, "label": v} for k, v in rows]  # noqa: E731
    return {"kinds": list(KINDS), "assetCategories": pair(ASSET_CATEGORIES), "liabilityCategories": pair(LIABILITY_CATEGORIES),
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


@router.get("/profiles/{profile_id}")
def get_profile(profile_id: str, user: dict = Depends(_read), db: Session = Depends(get_db)):
    p = _get_profile(db, profile_id)
    lines = (db.query(models.PfsLine).filter(models.PfsLine.profile_id == profile_id)
             .order_by(models.PfsLine.sort, models.PfsLine.label).all())
    _audit(db, user, "pfs_profile_opened", p.id)
    db.commit()
    return {**_profile_out(p), "lines": [_line_out(l) for l in lines]}


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
@router.post("/profiles/{profile_id}/lines", status_code=201)
def add_line(profile_id: str, body: LineBody, user: dict = Depends(_edit), db: Session = Depends(get_db)):
    _get_profile(db, profile_id)
    row = models.PfsLine(id=str(uuid.uuid4()), profile_id=profile_id, updated_by=user["email"], updated_at=_now(), **_clean_line(body))
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


_ENDING = re.compile(r"[-\s](\d{4})\s*$")


def _account_ref(title: str) -> str:
    """"Chase Checking -6532" -> "6532": the account's last four, when the
    ledger names it that way."""
    m = _ENDING.search(title or "")
    return m.group(1) if m else ""


@router.post("/profiles/{profile_id}/lines/bulk", status_code=201)
def add_lines_bulk(profile_id: str, body: BulkBody, user: dict = Depends(_edit), db: Session = Depends(get_db)):
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
        line = _clean_line(LineBody(
            section=body.section, category=(a.category or body.category), label=label, institution=(body.entityName or "")[:160],
            accountRef=_account_ref(label), ownershipPct=body.ownershipPct if a.ownershipPct is None else a.ownershipPct,
            source="ledger", ledgerEntity=entity, ledgerAccounts=[code], details=details, notes="",
        ))
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
    for k, v in _clean_line(body).items():
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
    category = _RE_LEGACY.get(body.category, body.category)
    if section not in _CATEGORIES or category not in _CATEGORIES[section]:
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
_TYPE_CATEGORY = {"cash_bank": ("asset", "bank"), "petty_cash": ("asset", "bank"), "credit_card": ("liability", "credit_card")}
_ASSET_WORDS = [
    (re.compile(r"401\s*\(?k\)?|\bira\b|roth|retirement|pension|\bsep\b|403\s*\(?b\)?|\bhsa\b|health savings|457\b"), "retirement"),
    (re.compile(r"brokerage|etrade|e\*trade|webull|fidelity|schwab|robinhood|merrill|morgan stanley|vanguard|investment|securities|stock|bond|mutual|crypto|coinbase|treasur"), "investment"),
    (re.compile(r"insurance|life policy|cash value|annuity"), "insurance"),
    (re.compile(r"jewel|watch|art\b|collectib|antique"), "jewelry"),
    (re.compile(r"vehicle|automobile|\bauto\b|\bcar\b|boat|furniture|equipment|household"), "personal"),
    (re.compile(r"checking|chkg|savings|\bbank\b|\bcash\b|money market|\bcd\b|certificate of deposit|venmo|paypal|earmarked|operating|payroll acct|\bf&m\b|\bchase\b|wells fargo|\bbofa\b|\bciti\b|\bpnc\b|us bank|first citizens|\betc\b|escrow"), "bank"),
]
_RE_WORDS = re.compile(r"\bland\b|building|real estate|\bproperty\b|improvement|rental|apartment|\bbldg\b|storage|plaza|center|hotel|motel|condo|\bhouse\b|residence")
_LIABILITY_WORDS = [
    (re.compile(r"credit card|\bamex\b|\bvisa\b|mastercard|discover card|capital one"), "credit_card"),
    (re.compile(r"line of credit|\bloc\b|credit line|heloc|revolv"), "loc"),
    (re.compile(r"\bauto\b|vehicle|\bcar\b|lease payable"), "auto"),
    (re.compile(r"india|\bintl\b|international|\bhdfc\b|icici|\bsbi\b|\bpune\b|mumbai|\bdubai\b"), "international"),
    (re.compile(r"mortgage|\bloan|note payable|notes payable|\bn/p\b|promissory|\bsba\b|due to|financing|borrow"), "business_loan"),
]
# Accounts that are not a holding or a debt a lender lists: contra accounts,
# working-capital balances, payroll and tax accruals. They fall to the
# catch-all of their side, never to a bank or a loan category.
_ASSET_SKIP = re.compile(r"accum|depreciation|amortization|allowance|clearing|suspense|receivable|\ba/r\b|prepaid|inventory|undeposited|intercompany|due from")
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
    if _ASSET_SKIP.search(t):
        return "asset", "other_holding"
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


def compute(profile: dict, lines: list[dict], as_of: str, books: dict[str, dict[str, dict]], pnls: Optional[dict[str, dict]] = None) -> dict:
    """The statement for one date. Pure: the lines and the ledger balances in,
    the figures out. `books` is {entity: {gl_code: {amount, ...}}}; `pnls`
    (optional) is {entity: pnl for the year} for the schedules."""
    warnings: list[str] = []

    def row(line: dict, spec: dict, what: str = "") -> dict:
        balance, source, missing = _figure(spec, books)
        if missing:
            warnings.append(f"{line['label']}{what}: account {', '.join(missing)} has no balance in entity {spec.get('entity')} as of this date.")
        pct = line["ownershipPct"]
        return {"id": line["id"], "label": line["label"], "institution": line["institution"], "accountRef": line["accountRef"],
                "ownershipPct": pct, "balance": balance, "adjusted": _r2(balance * pct / 100), "source": source,
                "asOf": as_of if source == "ledger" else (line["manualAsOf"] or ""), "notes": line["notes"], "details": line["details"]}

    def group(section: str, categories: list) -> list[dict]:
        out = []
        for key, label in categories:
            rows = [row(l, _spec_of(l)) for l in lines if l["section"] == section and l["category"] == key]
            if rows:
                out.append({"key": key, "label": label, "rows": rows, "total": _r2(sum(r["adjusted"] for r in rows))})
        return out

    assets = group("asset", ASSET_CATEGORIES)
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
    return {
        "profile": {k: profile[k] for k in ("id", "name", "displayName", "kind", "details", "history", "executiveProfile")},
        "asOf": as_of, "assets": assets, "liabilities": liabilities, "realEstate": real_estate,
        "summary": {"assets": summary_assets, "liabilities": summary_liabilities},
        "totals": {"assets": total_assets, "liabilities": total_liabilities, "netWorth": _r2(total_assets - total_liabilities)},
        "schedules": schedules(lines, as_of, pnls or {}),
        "warnings": warnings,
    }


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
    profile, lines = await asyncio.to_thread(_load, profile_id)
    entities = _entities_of(lines)
    sched = _schedule_entities(lines)
    fetched = await asyncio.gather(*[_balances(e, as_of) for e in entities], *[_pnl(e, as_of[:4]) for e in sched])
    books = dict(zip(entities, fetched[:len(entities)]))
    pnls = {e: p for e, p in zip(sched, fetched[len(entities):]) if p.get("sections")}
    return await asyncio.to_thread(pfs_affiliates.attach, profile_id, compute(profile, lines, as_of, books, pnls))


@router.get("/profiles/{profile_id}/statement")
async def statement(profile_id: str, asof: Optional[str] = None):
    """The statement as of a date, computed now. Nothing is kept."""
    return await _statement(profile_id, _as_of(asof))


class ProduceBody(BaseModel):
    asof: Optional[str] = None
    format: Optional[str] = "pdf"     # pdf | xlsx (Neil, 10/01: "in excel also") - what the audit says went out


@router.post("/profiles/{profile_id}/statements", status_code=201)
async def produce(profile_id: str, body: ProduceBody, user: dict = Depends(_read)):
    """Compute the statement and KEEP it: this is what goes to a lender, so the
    exact figures stay on record and the audit log says who produced it."""
    as_of = _as_of(body.asof)
    payload = await _statement(profile_id, as_of)
    fmt = body.format if body.format in ("pdf", "xlsx") else "pdf"
    sid = await asyncio.to_thread(_save_statement, profile_id, as_of, payload, user, fmt)
    return {"id": sid, **payload}


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
