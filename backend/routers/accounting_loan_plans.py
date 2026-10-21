"""Accounting -> Loans & Financing: amortization schedules and rate stress
scenarios per loan (Charmi and Neil, 10/06).

  Amortization   "Add in Amortization schedule for Commercial loans, allow us
                 to build it or upload an existing file from the bank." One
                 schedule per loan, kept in Nexus (accounting_loan_schedules):
                 built on screen from principal / rate / term / amortization
                 / interest-only months / day count (frontend loanMath.js -
                 the arithmetic lives in one tested place), or read from the
                 bank's Excel / CSV with the columns mapped by hand. The
                 bank's original file is kept in the PRIVATE task-files
                 bucket; only its canonical storage URL is stored here.
  Stress         "If the interest rate were to go up, we should be able to
                 calculate if the income will support the loan." The figures
                 are computed on screen; a scenario worth keeping (its
                 inputs only) is saved here.
  Planning       (Charmi, item 25, Oct 15) planned loans - not yet taken -
                 saved by name per entity for the Loan Planning tab's
                 mortgage calculator, comparison and DSCR impact.

The loan itself is a fin_loans row in the accounting app - Nexus never keeps
a copy. Every route resolves the loan through accounting_loans._loan_rows,
which already drops the loans of entities the caller may not read (Neil,
Sep 25), so a limited person cannot read or write a schedule of a loan
outside their entities: it answers 404 like a loan that does not exist.
Reading takes the Accounting grant, writing its editor level, like the
loans screen itself. Sync DB work runs in a thread (CLAUDE.md: never block
the loop).
"""
import asyncio
import csv
import io
import json
import os
import re
import time
import uuid
from datetime import date, datetime, timezone
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import models
from auth import require_module_grant
from database import SessionLocal
from routers import accounting, accounting_loans
from routers.accounting import entity_scope

router = APIRouter(prefix="/accounting/loan-plans", tags=["Accounting"], dependencies=[Depends(require_module_grant("accounting", "viewer"))])
_edit = require_module_grant("accounting", "editor")

MAX_ROWS = 1200                 # 100 years of monthly payments
MAX_SCENARIOS = 50              # per loan
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_BUCKET = "task-files"          # private (Sep 22); the bank's file lives under accounting/loan-schedules/
_SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


async def _loan(scope: dict, loan_id: str) -> dict:
    """The fin_loans row, if the caller may read its entity - else 404."""
    rows = await accounting_loans._loan_rows(scope, date.today().isoformat()[:7])
    cur = next((r for r in rows if str(r.get("id")) == str(loan_id)), None)
    if not cur:
        raise HTTPException(status_code=404, detail="Loan not found in your entities.")
    return cur


def _num(v: Any, field: str) -> float:
    if v is None or v == "":
        return 0.0
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{field} must be a number.")
    if f != f or abs(f) > 1e13:   # NaN or absurd
        raise HTTPException(status_code=400, detail=f"{field} is out of range.")
    return round(f, 2)


def clean_rows(rows: list) -> list[dict]:
    """The schedule rows as stored: dated, in date order, numbered from 1,
    every amount a number rounded to cents."""
    if not isinstance(rows, list) or not rows:
        raise HTTPException(status_code=400, detail="The schedule has no rows.")
    if len(rows) > MAX_ROWS:
        raise HTTPException(status_code=400, detail=f"A schedule holds up to {MAX_ROWS} payments.")
    out = []
    for i, r in enumerate(rows):
        if not isinstance(r, dict):
            raise HTTPException(status_code=400, detail=f"Row {i + 1} is not a payment.")
        d = str(r.get("date") or "")[:10]
        if not _DATE.match(d):
            raise HTTPException(status_code=400, detail=f"Row {i + 1} has no date (YYYY-MM-DD).")
        try:
            date.fromisoformat(d)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Row {i + 1} has an impossible date ({d}).")
        out.append({"date": d, **{k: _num(r.get(k), f"Row {i + 1} {k}") for k in ("payment", "interest", "principal", "balloon", "balance")}})
    out.sort(key=lambda r: r["date"])
    return [{"n": i + 1, **r} for i, r in enumerate(out)]


def check_file_url(url: Optional[str]) -> str:
    """The bank's file: empty, or our own storage under the private
    task-files bucket (the canonical .../object/public/task-files/... URL the
    viewer rewrites - api.js turns the viewer URL back into it on the way
    here)."""
    u = (url or "").strip()
    if not u:
        return ""
    marker = f"/storage/v1/object/public/{_BUCKET}/"
    if _SUPABASE_URL:
        ok = u.startswith(f"{_SUPABASE_URL}{marker}")
    else:
        ok = u.startswith("https://") and marker in u
    if not ok or len(u) > 1000:
        raise HTTPException(status_code=400, detail="The bank's file must be stored in Nexus (task-files storage).")
    return u


def _ser(s: models.AccountingLoanSchedule) -> dict:
    return {"id": s.id, "loanId": s.loan_id, "entityCode": s.entity_code or "", "source": s.source or "build", "params": s.params or {}, "rows": s.rows or [],
            "columnMap": s.column_map or {}, "fileUrl": s.file_url or "", "fileName": s.file_name or "", "by": s.saved_by or "", "at": s.saved_at or ""}


def _ser_scenario(s: models.AccountingLoanStressScenario) -> dict:
    return {"id": s.id, "loanId": s.loan_id, "name": s.name or "", "params": s.params or {}, "by": s.saved_by or "", "at": s.saved_at or ""}


def expected_balance(rows: list[dict], month: str) -> Optional[dict]:
    """What the schedule says is owed at the end of `month` (YYYY-MM): the
    balance after the last payment dated in or before that month. Before the
    first payment the loan is at its starting balance (the first row's
    balance plus its principal and balloon); None for an empty schedule."""
    if not rows:
        return None
    last = None
    for r in rows:
        if r["date"][:7] <= month:
            last = r
        else:
            break
    if last is None:
        first = rows[0]
        return {"balance": round(first["balance"] + first["principal"] + first.get("balloon", 0), 2), "asOf": None, "n": 0}
    return {"balance": last["balance"], "asOf": last["date"], "n": last["n"]}


# ── Schedules ───────────────────────────────────────────────────────────────
@router.get("/expected")
async def expected(month: Optional[str] = None, scope: dict = Depends(entity_scope)):
    """Every loan with a schedule the caller may read, and the balance its
    schedule expects at the end of the month - for comparing with the ledger
    on the Loans review without opening each schedule."""
    month = accounting_loans._month(month)
    allowed = scope["allowed"]
    reach = None if allowed is None else (await accounting._with_children(allowed) if allowed else set())

    def _load():
        db = SessionLocal()
        try:
            q = db.query(models.AccountingLoanSchedule)
            if reach is not None:
                if not reach:
                    return []
                q = q.filter(models.AccountingLoanSchedule.entity_code.in_(tuple(reach)))
            return [(s.loan_id, s.source, s.rows or []) for s in q.all()]
        finally:
            db.close()
    out = {}
    for loan_id, source, rows in await asyncio.to_thread(_load):
        e = expected_balance(rows, month)
        if e:
            out[loan_id] = {**e, "source": source}
    return {"month": month, "loans": out}


# ── Stress Test page (Charmi, Oct 7) ────────────────────────────────────────
# Per entity: the NOI basis (T12 from the ledger / Annualized YTD / Manual)
# and an Addback with its note, Adjusted NOI = NOI + Addback driving the
# DSCR; per loan: left out of the stress run (restorable - the loan stays).
NOI_BASES = ("t12", "ytd", "manual")


def _ser_stress(r: models.AccountingLoanStressEntity) -> dict:
    return {"entityCode": r.entity_code, "noiBasis": r.noi_basis or "", "noiManual": r.noi_manual, "addback": r.addback,
            "addbackNote": r.addback_note or "", "by": r.updated_by or "", "at": r.updated_at or ""}


def _audit(db, user: dict, action: str, resource_id: str, details: dict) -> None:
    db.add(models.AuditLog(timestamp=_now(), user_email=user.get("email") or "", user_role=user.get("role", "") or "", action=action,
                           resource_type="accounting_loan_stress", resource_id=str(resource_id)[:200], details=json.dumps(details, default=str)[:4000]))


@router.get("/stress-settings")
async def stress_settings(scope: dict = Depends(entity_scope)):
    """The Stress Test's kept inputs the caller may read: per entity (NOI
    basis, manual NOI, addback + note) and the loans left out of the run."""
    allowed = scope["allowed"]
    reach = None if allowed is None else (await accounting._with_children(allowed) if allowed else set())

    def _load():
        db = SessionLocal()
        try:
            q = db.query(models.AccountingLoanStressEntity)
            x = db.query(models.AccountingLoanSetting).filter(models.AccountingLoanSetting.stress_excluded.is_(True))
            if reach is not None:
                q = q.filter(models.AccountingLoanStressEntity.entity_code.in_(tuple(reach) or ("",)))
                x = x.filter(models.AccountingLoanSetting.entity_code.in_(tuple(reach) or ("",)))
            return {"entities": {r.entity_code: _ser_stress(r) for r in q.all()}, "excluded": sorted(r.loan_id for r in x.all())}
        finally:
            db.close()
    return await asyncio.to_thread(_load)


class StressEntityBody(BaseModel):
    noiBasis: Optional[str] = None
    noiManual: Optional[float] = None
    addback: Optional[float] = None
    addbackNote: Optional[str] = None


@router.put("/stress-settings/{entity}")
async def save_stress_entity(entity: str, body: StressEntityBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    """Keep one entity's NOI basis / manual NOI / addback (only the fields
    sent; null clears a figure). Audited."""
    code = (entity or "").strip()
    if not code or len(code) > 40:
        raise HTTPException(status_code=400, detail="An entity code is needed.")
    await accounting._limit(scope, code, None)
    sent = body.model_fields_set
    if body.noiBasis is not None and body.noiBasis not in ("", *NOI_BASES):
        raise HTTPException(status_code=400, detail="NOI basis is T12, Annualized YTD or Manual.")
    for v, what in ((body.noiManual, "NOI"), (body.addback, "Addback")):
        if v is not None and (v != v or abs(v) > 1e13):
            raise HTTPException(status_code=400, detail=f"{what} is out of range.")

    def _save():
        db = SessionLocal()
        try:
            r = db.query(models.AccountingLoanStressEntity).filter(models.AccountingLoanStressEntity.entity_code == code).first()
            before = _ser_stress(r) if r else None
            if not r:
                r = models.AccountingLoanStressEntity(entity_code=code, noi_basis="", addback_note="")
                db.add(r)
            if "noiBasis" in sent:
                r.noi_basis = body.noiBasis or ""
            if "noiManual" in sent:
                r.noi_manual = None if body.noiManual is None else round(body.noiManual, 2)
            if "addback" in sent:
                r.addback = None if body.addback is None else round(body.addback, 2)
            if "addbackNote" in sent:
                r.addback_note = (body.addbackNote or "").strip()[:300]
            r.updated_by, r.updated_at = user["email"].lower(), _now()
            after = _ser_stress(r)
            _audit(db, user, "accounting_loan_stress_entity_saved", code, {"before": before, "after": after})
            db.commit()
            return after
        finally:
            db.close()
    return {"entity": await asyncio.to_thread(_save)}


class StressExcludeBody(BaseModel):
    excluded: bool


@router.put("/{loan_id}/stress-excluded")
async def set_stress_excluded(loan_id: str, body: StressExcludeBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    """Take a loan out of the Stress Test run, or put it back. The loan
    itself stays (removing it is Loans > Delete). Audited."""
    loan = await _loan(scope, loan_id)
    entity = str(loan.get("entity_code") or "")

    def _save():
        db = SessionLocal()
        try:
            s = db.query(models.AccountingLoanSetting).filter(models.AccountingLoanSetting.loan_id == loan_id).first()
            if not s:
                s = models.AccountingLoanSetting(loan_id=loan_id, interest_account="", docs_path="", statements_path="")
                db.add(s)
            s.entity_code, s.stress_excluded = entity, bool(body.excluded)
            s.updated_by, s.updated_at = user["email"].lower(), _now()
            _audit(db, user, "accounting_loan_stress_excluded" if body.excluded else "accounting_loan_stress_restored", loan_id,
                   {"lender": loan.get("lender"), "entity": entity})
            db.commit()
        finally:
            db.close()
    await asyncio.to_thread(_save)
    return {"ok": True, "loanId": loan_id, "excluded": bool(body.excluded)}


# ── Loan Planning: planned loans (Charmi, item 25, Oct 15) ──────────────────
# "New Loan Planning / Mortgage Calculator": a loan the company is thinking of
# taking - not in the ledger, not a fin_loans row - saved by name per entity
# so two or three can be compared and their effect on the entity's debt
# service / DSCR seen beside its real loans. Kept in the same
# accounting_loan_stress_scenarios table as the stress scenarios (it already
# has RLS, an entity code, a name and a JSON params column - no new table):
# a planned loan is a row whose loan_id is PLANNED, a value no fin_loans id
# (a uuid) can take, so the per-loan scenario routes never see them (their
# _loan lookup answers 404 for it). Only the inputs are kept; every figure is
# recomputed on screen (loanMath.js). Reading takes the Accounting grant,
# writing its editor level; a person limited to certain entities lists and
# changes only theirs. Audited.
PLANNED = "planned"
MAX_PLANNED = 50                 # per entity
FREQUENCIES = ("monthly", "quarterly", "semiannual", "annual")
_PLAN_NUMBERS = {                # field: (low, high)
    "loanAmount": (0, 1e11), "purchasePrice": (0, 1e11), "downPct": (0, 100), "ratePct": (0, 50),
    "amortYears": (0, 100), "termYears": (0, 100), "ioMonths": (0, 1200), "closingCosts": (0, 1e10),
    "pointsPct": (0, 20), "dscrTarget": (0, 10), "noi": (-1e12, 1e12),
    # The Loan Calculator (Neil, Oct 16): a variable rate is the index plus the
    # margin; Other takes an extra principal payment every period.
    "indexRatePct": (-5, 50), "marginPct": (-20, 30), "extraPayment": (0, 1e10),
}
_PLAN_TEXT = {"lender": 120, "notes": 2000}
_PLAN_DATES = ("startDate", "closeDate", "indexAsOf")
# Residential and Commercial are the basic calculators, Other the fully
# customizable one; a plan saved before the sections has no kind and the
# screen works out which section it belongs in (loanMath.planKind).
PLAN_KINDS = ("residential", "commercial", "other")
RATE_TYPES = ("fixed", "variable")
INDEX_KEYS = ("sofr", "treasury10", "prime", "custom")
MAX_PLAN_LIST = 60               # extra payments / rate periods per plan


def _plan_list(p: dict, key: str, fields: dict) -> list[dict]:
    """A list of {field: number} rows (Other's one-time extra payments and its
    rate periods), each field in range, at most MAX_PLAN_LIST rows."""
    raw = p.get(key)
    if raw in (None, ""):
        return []
    if not isinstance(raw, list) or len(raw) > MAX_PLAN_LIST:
        raise HTTPException(status_code=400, detail=f"{key} must be a list of at most {MAX_PLAN_LIST} rows.")
    out = []
    for row in raw:
        if not isinstance(row, dict):
            raise HTTPException(status_code=400, detail=f"{key} rows must be objects.")
        clean = {}
        for f, (lo, hi) in fields.items():
            try:
                v = float(row.get(f))
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail=f"{key}: {f} must be a number.")
            if v != v or v < lo or v > hi:
                raise HTTPException(status_code=400, detail=f"{key}: {f} is out of range.")
            clean[f] = round(v, 4)
        out.append(clean)
    return out


def clean_plan_params(p: Any) -> dict:
    """The planned loan's inputs as kept: the known fields only, numbers in
    range (blank = not given), dates YYYY-MM-DD, text trimmed and capped."""
    if not isinstance(p, dict):
        raise HTTPException(status_code=400, detail="The planned loan's settings are not readable.")
    out: dict = {}
    for k, (lo, hi) in _PLAN_NUMBERS.items():
        v = p.get(k)
        if v is None or v == "":
            continue
        try:
            f = float(v)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"{k} must be a number.")
        if f != f or f < lo or f > hi:
            raise HTTPException(status_code=400, detail=f"{k} is out of range.")
        out[k] = round(f, 4)
    for k, cap in _PLAN_TEXT.items():
        v = p.get(k)
        if v is not None:
            out[k] = str(v).strip()[:cap]
    for k in _PLAN_DATES:
        v = str(p.get(k) or "").strip()[:10]
        if not v:
            continue
        try:
            if not _DATE.match(v):
                raise ValueError
            date.fromisoformat(v)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"{k} must be a date (YYYY-MM-DD).")
        out[k] = v
    freq = str(p.get("frequency") or "monthly")
    if freq not in FREQUENCIES:
        raise HTTPException(status_code=400, detail="Payment frequency is Monthly, Quarterly, Semiannual or Annual.")
    out["frequency"] = freq
    out["usePurchase"] = bool(p.get("usePurchase"))
    for key, allowed, what in (("kind", PLAN_KINDS, "The calculator is Residential, Commercial or Other."),
                               ("rateType", RATE_TYPES, "The rate is Fixed or Variable."),
                               ("index", INDEX_KEYS, "The index is SOFR, 10-Year Treasury, Prime or Custom.")):
        v = p.get(key)
        if v in (None, ""):
            continue
        if v not in allowed:
            raise HTTPException(status_code=400, detail=what)
        out[key] = v
    extras = _plan_list(p, "extraPayments", {"n": (1, 1200), "amount": (0, 1e10)})
    if extras:
        out["extraPayments"] = extras
    steps = _plan_list(p, "ratePeriods", {"fromPayment": (1, 1200), "ratePct": (0, 50)})
    if steps:
        out["ratePeriods"] = steps
    return out


def _ser_planned(s: models.AccountingLoanStressScenario) -> dict:
    return {"id": s.id, "entityCode": s.entity_code or "", "name": s.name or "", "params": s.params or {}, "by": s.saved_by or "", "at": s.saved_at or ""}


async def _reach(scope: dict) -> Optional[set]:
    allowed = scope["allowed"]
    return None if allowed is None else (await accounting._with_children(allowed) if allowed else set())


class PlannedBody(BaseModel):
    name: str
    entityCode: str
    params: dict = {}


def _planned_input(body: PlannedBody) -> tuple[str, str, dict]:
    name = (body.name or "").strip()[:120]
    if not name:
        raise HTTPException(status_code=400, detail="Name the planned loan.")
    code = (body.entityCode or "").strip()
    if not code or len(code) > 40:
        raise HTTPException(status_code=400, detail="Pick the entity the loan is for.")
    return name, code, clean_plan_params(body.params)


@router.get("/planned")
async def list_planned(scope: dict = Depends(entity_scope)):
    """Every planned loan of the entities the caller may read, newest first."""
    reach = await _reach(scope)

    def _load():
        db = SessionLocal()
        try:
            q = db.query(models.AccountingLoanStressScenario).filter(models.AccountingLoanStressScenario.loan_id == PLANNED)
            if reach is not None:
                q = q.filter(models.AccountingLoanStressScenario.entity_code.in_(tuple(reach) or ("",)))
            return [_ser_planned(s) for s in q.order_by(models.AccountingLoanStressScenario.saved_at.desc()).all()]
        finally:
            db.close()
    return {"planned": await asyncio.to_thread(_load)}


@router.post("/planned", status_code=201)
async def create_planned(body: PlannedBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    name, code, params = _planned_input(body)
    await accounting._limit(scope, code, None)
    me = user["email"].lower()

    def _save():
        db = SessionLocal()
        try:
            have = db.query(models.AccountingLoanStressScenario).filter(models.AccountingLoanStressScenario.loan_id == PLANNED,
                                                                        models.AccountingLoanStressScenario.entity_code == code).count()
            if have >= MAX_PLANNED:
                raise HTTPException(status_code=400, detail=f"An entity keeps up to {MAX_PLANNED} planned loans - remove one first.")
            s = models.AccountingLoanStressScenario(id=str(uuid.uuid4()), loan_id=PLANNED, entity_code=code, name=name, params=params, saved_by=me, saved_at=_now())
            db.add(s)
            out = _ser_planned(s)
            _audit(db, user, "accounting_loan_planned_created", s.id, {"after": out})
            db.commit()
            return out
        finally:
            db.close()
    return {"planned": await asyncio.to_thread(_save)}


def _get_planned(db, plan_id: str, reach: Optional[set]):
    s = db.query(models.AccountingLoanStressScenario).filter(models.AccountingLoanStressScenario.loan_id == PLANNED,
                                                            models.AccountingLoanStressScenario.id == plan_id).first()
    if not s or (reach is not None and s.entity_code not in reach):
        raise HTTPException(status_code=404, detail="Planned loan not found in your entities.")
    return s


@router.put("/planned/{plan_id}")
async def update_planned(plan_id: str, body: PlannedBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    name, code, params = _planned_input(body)
    await accounting._limit(scope, code, None)
    reach = await _reach(scope)
    me = user["email"].lower()

    def _save():
        db = SessionLocal()
        try:
            s = _get_planned(db, plan_id, reach)
            before = _ser_planned(s)
            s.name, s.entity_code, s.params, s.saved_by, s.saved_at = name, code, params, me, _now()
            after = _ser_planned(s)
            _audit(db, user, "accounting_loan_planned_saved", plan_id, {"before": before, "after": after})
            db.commit()
            return after
        finally:
            db.close()
    return {"planned": await asyncio.to_thread(_save)}


@router.delete("/planned/{plan_id}")
async def delete_planned(plan_id: str, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    reach = await _reach(scope)

    def _del():
        db = SessionLocal()
        try:
            s = _get_planned(db, plan_id, reach)
            _audit(db, user, "accounting_loan_planned_deleted", plan_id, {"before": _ser_planned(s)})
            db.delete(s)
            db.commit()
        finally:
            db.close()
    await asyncio.to_thread(_del)
    return {"ok": True}


# ── Live index rates (Loan Calculator, Neil Oct 16) ─────────────────────────
# A variable rate is an index plus a margin, and the index can be PULLED
# instead of typed. Free public sources that need no key:
#   SOFR              the New York Fed's reference rate API (the latest day)
#   10-Year Treasury  the US Treasury's daily par yield curve (CSV, this year)
#   Prime             no free official feed: the Wall Street Journal convention,
#                     the Fed funds target's upper bound + 3.00% (the New York
#                     Fed's EFFR answer carries the target range) - labelled so
# Kept four hours per index (a rate a day; one fetch serves every screen), read
# in a thread (never block the loop), never called from tests. An unreachable
# source answers 424 with what to do - not a 5xx, which would put the
# "reconnecting" banner over the whole app - or the last rate read, marked
# stale, when there is one from the last day.
SOFR_URL = "https://markets.newyorkfed.org/api/rates/secured/sofr/last/1.json"
EFFR_URL = "https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json"
TREASURY_URL = ("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{year}/all"
                "?type=daily_treasury_yield_curve&field_tdr_date_value={year}&page&_format=csv")
PRIME_SPREAD = 3.0
INDEX_TTL = 4 * 3600.0
INDEX_STALE_OK = 24 * 3600.0
INDEX_LABELS = {"sofr": "SOFR", "treasury10": "10-Year Treasury", "prime": "Prime"}
INDEX_SOURCES = {"sofr": "the New York Fed", "treasury10": "the US Treasury", "prime": "the New York Fed"}
_INDEX_CACHE: dict[str, tuple[float, dict]] = {}


def parse_sofr(data: dict) -> dict:
    ref = (data.get("refRates") or [])[0]
    return {"ratePct": round(float(ref["percentRate"]), 4), "asOf": str(ref["effectiveDate"])[:10],
            "source": "Federal Reserve Bank of New York - SOFR", "sourceUrl": "https://www.newyorkfed.org/markets/reference-rates/sofr"}


def parse_prime(data: dict) -> dict:
    ref = (data.get("refRates") or [])[0]
    upper = float(ref["targetRateTo"])
    return {"ratePct": round(upper + PRIME_SPREAD, 4), "asOf": str(ref["effectiveDate"])[:10],
            "source": f"Derived: Fed funds target upper bound {upper:.2f}% (New York Fed) + {PRIME_SPREAD:.2f}%",
            "sourceUrl": "https://www.newyorkfed.org/markets/reference-rates/effr",
            "note": "Prime is not published as free data - this is the Wall Street Journal convention (Fed funds upper bound + 3%)."}


def parse_treasury_csv(text: str) -> Optional[dict]:
    """The newest day with a 10-year yield in the Treasury's yield curve CSV
    (dates MM/DD/YYYY, newest first - sorted here anyway)."""
    best = None
    for row in csv.DictReader(io.StringIO(text.lstrip("﻿"))):
        raw, val = (row.get("Date") or "").strip(), (row.get("10 Yr") or "").strip()
        if not raw or not val:
            continue
        try:
            d = datetime.strptime(raw, "%m/%d/%Y").date()
            v = float(val)
        except ValueError:
            continue
        if best is None or d > best[0]:
            best = (d, v)
    if not best:
        return None
    return {"ratePct": round(best[1], 4), "asOf": best[0].isoformat(), "source": "US Treasury - Daily Par Yield Curve, 10 Yr",
            "sourceUrl": "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve"}


def _get(url: str) -> httpx.Response:
    r = httpx.get(url, timeout=10, follow_redirects=True, headers={"User-Agent": "GreensNexus/1.0 (loan calculator)"})
    r.raise_for_status()
    return r


def fetch_index(index: str, today: Optional[date] = None) -> dict:
    """The index's latest published rate (sync: call it in a thread)."""
    if index == "sofr":
        return parse_sofr(_get(SOFR_URL).json())
    if index == "prime":
        return parse_prime(_get(EFFR_URL).json())
    if index == "treasury10":
        year = (today or date.today()).year
        for y in (year, year - 1):          # the first days of January have no rows yet
            got = parse_treasury_csv(_get(TREASURY_URL.format(year=y)).text)
            if got:
                return got
        raise ValueError("no 10-year yield in the Treasury's data")
    raise ValueError(f"unknown index {index}")


@router.get("/index-rate")
async def index_rate(index: str):
    """The live rate of one index for the Loan Calculator: {index, label,
    ratePct, asOf, source, sourceUrl, note?, stale?}."""
    if index not in INDEX_LABELS:
        raise HTTPException(status_code=400, detail="The index is SOFR, 10-Year Treasury or Prime (a Custom index is typed).")
    now = time.monotonic()
    hit = _INDEX_CACHE.get(index)
    if hit and now - hit[0] < INDEX_TTL:
        return hit[1]
    try:
        got = await asyncio.to_thread(fetch_index, index)
    except Exception as e:  # noqa: BLE001 - any failure of an outside source reads the same to the person
        print(f"[loan-plans] index {index} not read: {e.__class__.__name__}: {e}")
        if hit and now - hit[0] < INDEX_STALE_OK:
            return {**hit[1], "stale": True}
        raise HTTPException(status_code=424, detail=f"Could not read {INDEX_LABELS[index]} from {INDEX_SOURCES[index]} just now. Type the rate instead, or try again later.")
    out = {"index": index, "label": INDEX_LABELS[index], **got, "fetchedAt": _now()}
    _INDEX_CACHE[index] = (now, out)
    return out


@router.get("/{loan_id}/schedule")
async def get_schedule(loan_id: str, scope: dict = Depends(entity_scope)):
    """The loan's schedule, or null when none is kept yet."""
    await _loan(scope, loan_id)

    def _load():
        db = SessionLocal()
        try:
            s = db.query(models.AccountingLoanSchedule).filter(models.AccountingLoanSchedule.loan_id == loan_id).first()
            return _ser(s) if s else None
        finally:
            db.close()
    return {"schedule": await asyncio.to_thread(_load)}


class ScheduleBody(BaseModel):
    source: str = "build"
    params: dict = {}
    rows: list = []
    columnMap: dict = {}
    fileUrl: Optional[str] = ""
    fileName: Optional[str] = ""


@router.put("/{loan_id}/schedule")
async def put_schedule(loan_id: str, body: ScheduleBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    """Keep (or replace) the loan's schedule."""
    if body.source not in ("build", "upload"):
        raise HTTPException(status_code=400, detail="A schedule is built or uploaded.")
    loan = await _loan(scope, loan_id)
    rows = clean_rows(body.rows)
    file_url = check_file_url(body.fileUrl) if body.source == "upload" else ""
    file_name = (body.fileName or "").strip()[:200] if body.source == "upload" else ""
    params = body.params if body.source == "build" else {}
    if len(str(params)) > 4000 or len(str(body.columnMap)) > 2000:
        raise HTTPException(status_code=400, detail="The schedule's settings are too long.")
    me = user["email"].lower()
    entity = str(loan.get("entity_code") or "")

    def _save():
        db = SessionLocal()
        try:
            s = db.query(models.AccountingLoanSchedule).filter(models.AccountingLoanSchedule.loan_id == loan_id).first()
            if not s:
                s = models.AccountingLoanSchedule(id=str(uuid.uuid4()), loan_id=loan_id)
                db.add(s)
            s.entity_code, s.source, s.params, s.rows = entity, body.source, params, rows
            s.column_map = body.columnMap if body.source == "upload" else {}
            s.file_url, s.file_name, s.saved_by, s.saved_at = file_url, file_name, me, _now()
            db.commit()
            return _ser(s)
        finally:
            db.close()
    return {"schedule": await asyncio.to_thread(_save)}


@router.delete("/{loan_id}/schedule")
async def delete_schedule(loan_id: str, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    await _loan(scope, loan_id)

    def _del():
        db = SessionLocal()
        try:
            n = db.query(models.AccountingLoanSchedule).filter(models.AccountingLoanSchedule.loan_id == loan_id).delete(synchronize_session=False)
            db.commit()
            return n
        finally:
            db.close()
    return {"deleted": await asyncio.to_thread(_del)}


# ── Stress scenarios ────────────────────────────────────────────────────────
@router.get("/{loan_id}/scenarios")
async def list_scenarios(loan_id: str, scope: dict = Depends(entity_scope)):
    await _loan(scope, loan_id)

    def _load():
        db = SessionLocal()
        try:
            rows = db.query(models.AccountingLoanStressScenario).filter(models.AccountingLoanStressScenario.loan_id == loan_id).order_by(models.AccountingLoanStressScenario.saved_at.desc()).all()
            return [_ser_scenario(s) for s in rows]
        finally:
            db.close()
    return {"scenarios": await asyncio.to_thread(_load)}


class ScenarioBody(BaseModel):
    name: str
    params: dict = {}


@router.post("/{loan_id}/scenarios", status_code=201)
async def save_scenario(loan_id: str, body: ScenarioBody, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    name = (body.name or "").strip()[:120]
    if not name:
        raise HTTPException(status_code=400, detail="Name the scenario.")
    if len(str(body.params)) > 2000:
        raise HTTPException(status_code=400, detail="The scenario's settings are too long.")
    loan = await _loan(scope, loan_id)
    me = user["email"].lower()

    def _save():
        db = SessionLocal()
        try:
            have = db.query(models.AccountingLoanStressScenario).filter(models.AccountingLoanStressScenario.loan_id == loan_id).count()
            if have >= MAX_SCENARIOS:
                raise HTTPException(status_code=400, detail=f"A loan keeps up to {MAX_SCENARIOS} scenarios - remove one first.")
            s = models.AccountingLoanStressScenario(id=str(uuid.uuid4()), loan_id=loan_id, entity_code=str(loan.get("entity_code") or ""), name=name,
                                                    params=body.params, saved_by=me, saved_at=_now())
            db.add(s)
            db.commit()
            return _ser_scenario(s)
        finally:
            db.close()
    return {"scenario": await asyncio.to_thread(_save)}


@router.delete("/{loan_id}/scenarios/{scenario_id}")
async def delete_scenario(loan_id: str, scenario_id: str, user: dict = Depends(_edit), scope: dict = Depends(entity_scope)):
    await _loan(scope, loan_id)

    def _del():
        db = SessionLocal()
        try:
            n = db.query(models.AccountingLoanStressScenario).filter(models.AccountingLoanStressScenario.loan_id == loan_id,
                                                                     models.AccountingLoanStressScenario.id == scenario_id).delete(synchronize_session=False)
            db.commit()
            return n
        finally:
            db.close()
    if not await asyncio.to_thread(_del):
        raise HTTPException(status_code=404, detail="Scenario not found.")
    return {"ok": True}
