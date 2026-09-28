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

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
from auth import require_module_grant
from database import SessionLocal, get_db
from routers import accounting

_read = require_module_grant("pfs", "viewer", bypass_level="owner")
_edit = require_module_grant("pfs", "editor", bypass_level="owner")

router = APIRouter(prefix="/pfs", tags=["Personal Financial Statements"], dependencies=[Depends(_read)])

KINDS = ("individual", "joint", "trust")

# The statement's sections, in the order a lender reads them.
ASSET_CATEGORIES = [
    ("bank", "Bank Accounts"),
    ("retirement", "Retirement Accounts"),
    ("investment", "Investment Accounts"),
    ("business", "Business Interests"),
    ("insurance", "Insurance"),
    ("personal", "Personal Holdings"),
    ("other_holding", "Other Holdings"),
]
LIABILITY_CATEGORIES = [
    ("business_loan", "Business Loans"),
    ("international", "International Debt"),
    ("auto", "Automobile Loans"),
    ("loc", "Lines of Credit"),
    ("other_liability", "Other Liabilities"),
]
REAL_ESTATE_KINDS = [
    ("residential", "Residential Real Estate"),
    ("commercial", "Commercial Real Estate"),
    ("international_re", "International Real Estate"),
]
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
                "ssn_last4", "members")
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
def _profile_out(p: models.PfsProfile, full: bool = True) -> dict:
    out = {"id": p.id, "name": p.name, "kind": p.kind or "individual", "archived": bool(p.archived),
           "updatedAt": p.updated_at, "hasPhoto": bool(p.photo)}
    if full:
        out.update({"details": p.details if isinstance(p.details, dict) else {},
                    "history": p.history if isinstance(p.history, list) else [],
                    "executiveProfile": p.executive_profile or "", "photo": p.photo or ""})
    return out


def _line_out(l: models.PfsLine) -> dict:
    return {"id": l.id, "section": l.section, "category": l.category, "label": l.label or "", "institution": l.institution or "",
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
        else:
            out[k] = str(v)[:200]
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


def _save_statement(profile_id: str, as_of: str, payload: dict, user: dict) -> str:
    db = SessionLocal()
    try:
        sid = str(uuid.uuid4())
        db.add(models.PfsStatement(id=sid, profile_id=profile_id, as_of=as_of, payload=payload,
                                   generated_by=user["email"], generated_at=_now()))
        # Who, which guarantor, which date - never a figure: the audit log is
        # read by people who may not see the statement itself.
        _audit(db, user, "pfs_statement_produced", profile_id, {"statement": sid, "as_of": as_of})
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
def create_profile(body: ProfileBody, user: dict = Depends(_edit), db: Session = Depends(get_db)):
    p = models.PfsProfile(id=str(uuid.uuid4()), name="", created_by=user["email"], created_at=_now(),
                          history=[{"question": q, "answer": "", "note": ""} for q in HISTORY_QUESTIONS])
    _apply_profile(p, body, user)
    db.add(p)
    _audit(db, user, "pfs_profile_created", p.id, {"name": p.name})
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
    as they stand, liabilities as what is owed (both positive in the normal case)."""
    data = await accounting._acct_get("/api/internal/reports/balance-sheet", {"asof": as_of, "location": entity})
    out: dict[str, dict] = {}
    for s in data.get("sections") or []:
        if s.get("key") not in _BS_SECTIONS:
            continue
        for a in s.get("accounts") or []:
            if a.get("account_no"):
                out[a["account_no"]] = {"title": a.get("title") or "", "section": s["key"], "amount": _r2(a.get("amount"))}
    return out


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
    return {"entity": entity, "asOf": _as_of(asof),
            "accounts": [{"code": c, **v} for c, v in sorted(rows.items())]}


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


def compute(profile: dict, lines: list[dict], as_of: str, books: dict[str, dict[str, dict]]) -> dict:
    """The statement for one date. Pure: the lines and the ledger balances in,
    the figures out. `books` is {entity: {gl_code: {amount, ...}}}."""
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
        "profile": {k: profile[k] for k in ("id", "name", "kind", "details", "history", "executiveProfile")},
        "asOf": as_of, "assets": assets, "liabilities": liabilities, "realEstate": real_estate,
        "summary": {"assets": summary_assets, "liabilities": summary_liabilities},
        "totals": {"assets": total_assets, "liabilities": total_liabilities, "netWorth": _r2(total_assets - total_liabilities)},
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


async def _statement(profile_id: str, as_of: str) -> dict:
    profile, lines = await asyncio.to_thread(_load, profile_id)
    entities = _entities_of(lines)
    fetched = await asyncio.gather(*[_balances(e, as_of) for e in entities])
    return compute(profile, lines, as_of, dict(zip(entities, fetched)))


@router.get("/profiles/{profile_id}/statement")
async def statement(profile_id: str, asof: Optional[str] = None):
    """The statement as of a date, computed now. Nothing is kept."""
    return await _statement(profile_id, _as_of(asof))


class ProduceBody(BaseModel):
    asof: Optional[str] = None


@router.post("/profiles/{profile_id}/statements", status_code=201)
async def produce(profile_id: str, body: ProduceBody, user: dict = Depends(_read)):
    """Compute the statement and KEEP it: this is what goes to a lender, so the
    exact figures stay on record and the audit log says who produced it."""
    as_of = _as_of(body.asof)
    payload = await _statement(profile_id, as_of)
    sid = await asyncio.to_thread(_save_statement, profile_id, as_of, payload, user)
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
