"""Accounting -> Reporting -> Employee Compensation (Neil, 10/15: "We still
need to make employee compensation report").

Two reads:

  /accounting/compensation/people   per employee for a range of months:
      company, department, title, pay type, rate, regular / overtime /
      double time hours, sick / vacation / personal leave hours and gross
      wages, with totals by company and by department and per currency.
      Hours and wages are Time Clock's payroll card for each month -
      `_compute_timecard` for hourly people, `_fixed_card` for salaried -
      read through accounting_allocations._people_and_cards, the roster and
      engine the Allocations entry already uses. There is NO second pay
      computation here: this only adds the months up.
  /accounting/compensation/ledger   payroll expense on the ledger for the
      same months, by Intacct department or employee dimension, split into
      Wages, Employer Taxes and Benefits by account title (classification
      below). Employer taxes and benefits are not kept in Nexus HR, so the
      ledger is where they come from. Through accounting._acct_get (buckets),
      never the accounting database.

Who may read it: wages for everyone are payroll figures. The gate is the
strictest one already used for them (Accounting > Allocations): the FULL level
on the Accounting grant (administrators bypass, as everywhere), a fresh
step-up, AND no entity limit - the roster covers every company, so there is
no part of it to show a person limited to certain entities (CR-02: the
policy is `COMP_ENTITY_SCOPED_POLICY` in accounting_assumptions.py). The HR
record's compensation block (hr_comp grant) is not read; rates come from the
payroll card like everywhere else in Time Clock. No figure is ever logged.

SPEED (CR-02, Oct 23 2026: Jan-Sep "never finished loading"): the engine is
built for one card at a time and made ~26 database round trips per person
per month. The pass now runs inside read_memo.memoized (an identical SELECT
is answered once) with each month's punches, finalizations, idle frames and
punch requests preloaded (timeclock.preload_range) and the CA waiver /
premium rows preloaded (ca_breaks.preload). The cards are still priced by
the same engine - only the repeated reads are gone. A run is refused up
front past COMP_MAX_PERSON_MONTHS and stopped past COMP_TIME_BUDGET_SEC,
both with a 422 that says what to do (a 5xx would be retried by the
browser and raise the "reconnecting" banner).

LEDGER CLASSIFICATION (cost-section accounts only - cogs, expense,
other_expense; amount = debits less credits):
  Employer Taxes  title says payroll tax, employer tax, FICA, FUTA, SUTA / SUI,
                  Medicare, Social Security or unemployment.
  Benefits        title says benefit, health / medical / dental / vision,
                  401(k), retirement, pension, workers' comp, life insurance,
                  HSA / FSA.
  Wages           title says payroll, salary / salaries, wage, bonus,
                  commission, overtime, PTO, vacation or sick pay.
  Taxes are tested first ("Payroll Taxes" is a tax, not a wage). Anything
  else is not payroll and is left out. Contract labor is not payroll.
  Each row's total is also split DIRECT (cost of sales) / INDIRECT
  (operating and other expense) - CR-02's "direct or indirect expenses",
  sections in accounting_assumptions.COMP_DIRECT_SECTIONS.
"""
import re
import time
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import event
from sqlalchemy.orm import Session

import accounting_assumptions as A
import models
import read_memo
from auth import require_module_grant
from database import get_db
from routers import accounting
from routers.accounting import _limit, entity_scope
from routers.stepup import require_stepup

SCOPED_REFUSED = ("Your Accounting access is limited to certain entities, and Compensation lists wages for every "
                  "company's people, so it is not available to you. Ask a Global Admin to remove the entity limit "
                  "on Accounting > Access if you should see the whole payroll.")


def comp_scope(scope: dict = Depends(entity_scope)) -> dict:
    """require_unlimited, with CR-02's policy for a Full-level person who has
    entity rows (accounting_assumptions.COMP_ENTITY_SCOPED_POLICY)."""
    if scope["allowed"] is not None and A.COMP_ENTITY_SCOPED_POLICY != "all":
        raise HTTPException(status_code=403, detail=SCOPED_REFUSED)
    return scope


router = APIRouter(
    prefix="/accounting/compensation",
    tags=["Accounting"],
    dependencies=[Depends(require_module_grant("accounting", "full")), Depends(comp_scope)],
)

MAX_MONTHS = 12
_MONTH = re.compile(r"^\d{4}-\d{2}$")
_MIN_KEYS = ("regMin", "otMin", "dtMin", "sickMin", "vacationMin", "personalMin")


def _r2(v) -> float:
    return round(float(v or 0) + 0.0, 2)


def month_list(from_: str, to: str) -> list[str]:
    """Every "YYYY-MM" from `from_` to `to`, inclusive (at most 12)."""
    for v, what in ((from_, "from"), (to, "to")):
        if not v or not _MONTH.match(v) or not 1 <= int(v[5:7]) <= 12:
            raise HTTPException(status_code=400, detail=f"{what} must be YYYY-MM")
    if from_ > to:
        raise HTTPException(status_code=400, detail="from must be on or before to")
    out, y, m = [], int(from_[:4]), int(from_[5:7])
    while f"{y:04d}-{m:02d}" <= to:
        out.append(f"{y:04d}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        if len(out) > MAX_MONTHS:
            raise HTTPException(status_code=400, detail=f"Pick at most {MAX_MONTHS} months.")
    return out


def month_end(month: str) -> str:
    first = datetime.strptime(month, "%Y-%m").date()
    nxt = date(first.year + (first.month == 12), 1 if first.month == 12 else first.month + 1, 1)
    return (nxt - timedelta(days=1)).isoformat()


def person_month(person: dict, card: dict) -> dict:
    """One person's figures for one month from their payroll card. A salaried
    (fixed) person is not paid overtime, so all their worked time is regular."""
    t = card.get("totals") or {}
    mins = {k: int(t.get(k) or 0) for k in _MIN_KEYS}
    fixed = person.get("payType") == "fixed"
    if fixed:
        mins["regMin"] += mins["otMin"] + mins["dtMin"]
        mins["otMin"] = mins["dtMin"] = 0
        rate = _r2(card.get("monthlySalary") or t.get("monthlySalary"))
    else:
        rate = _r2(card.get("rate"))
    return {**mins, "wages": _r2(t.get("totalPay")), "rate": rate,
            "currency": card.get("currency") or person.get("currency") or "USD"}


def summarize(months: list[tuple[str, list[dict], dict]], titles: dict[str, str]) -> dict:
    """Add the months up per person, then total by company, by department and
    per currency. `months` = [(month, people, cards)] as
    _people_and_cards returns them; `titles` = email -> job title. Pure."""
    people: dict[str, dict] = {}
    for month, roster, cards in months:
        for p in roster:
            card = cards.get(p["email"]) or {}
            pm = person_month(p, card)
            if pm["wages"] == 0 and not any(pm[k] for k in _MIN_KEYS):
                continue
            cur = people.get(p["email"])
            if cur is None:
                cur = people[p["email"]] = {
                    "email": p["email"], "name": p.get("name") or p["email"], "employeeId": p.get("employeeId") or "",
                    "company": p.get("company") or "", "companyName": p.get("companyName") or "",
                    "department": p.get("department") or "", "title": titles.get(p["email"], ""),
                    "payType": "salary" if p.get("payType") == "fixed" else "hourly",
                    "currency": pm["currency"], "rate": pm["rate"], "rates": [], "months": 0,
                    **{k: 0 for k in _MIN_KEYS}, "wages": 0.0,
                }
            for k in _MIN_KEYS:
                cur[k] += pm[k]
            cur["wages"] = _r2(cur["wages"] + pm["wages"])
            cur["months"] += 1
            # The latest month's rate is the one shown; a change is flagged.
            cur["rate"] = pm["rate"] or cur["rate"]
            if pm["rate"] and pm["rate"] not in cur["rates"]:
                cur["rates"].append(pm["rate"])
    rows = sorted(people.values(), key=lambda r: (r["companyName"].lower(), r["department"].lower(), r["name"].lower()))
    for r in rows:
        r["rateChanged"] = len(r.pop("rates")) > 1
        r["overtimeMin"] = r["otMin"] + r["dtMin"]
        r["leaveMin"] = r["sickMin"] + r["vacationMin"] + r["personalMin"]
    return {
        "people": rows,
        "byCompany": group(rows, lambda r: (r["company"], r["companyName"] or "No Company")),
        "byDepartment": group(rows, lambda r: (r["department"], r["department"] or "No Department")),
        "totals": group(rows, lambda r: ("", "Total")),
    }


def group(rows: list[dict], key) -> list[dict]:
    """Sums per group AND currency (wages in USD and INR are never added)."""
    out: dict[tuple, dict] = {}
    for r in rows:
        k, label = key(r)
        g = out.setdefault((k, r["currency"]), {"key": k, "label": label, "currency": r["currency"], "people": 0,
                                                  **{m: 0 for m in _MIN_KEYS}, "overtimeMin": 0, "leaveMin": 0, "wages": 0.0})
        g["people"] += 1
        for m in (*_MIN_KEYS, "overtimeMin", "leaveMin"):
            g[m] += r[m]
        g["wages"] = _r2(g["wages"] + r["wages"])
    return sorted(out.values(), key=lambda g: (g["label"].lower(), g["currency"]))


def _day_after(iso: str) -> str:
    return (date.fromisoformat(iso) + timedelta(days=1)).isoformat()


def _slim(card: dict) -> dict:
    """What person_month reads - the full card (every segment of every day) is
    not kept for twelve months of everyone."""
    return {k: card[k] for k in ("rate", "monthlySalary", "currency", "totals") if k in card}


class TooSlow(Exception):
    pass


def _people_sync(db: Session, months: list[str], deadline: Optional[float] = None) -> dict:
    """Every month's roster and cards (the Allocations engine), added up. The
    repeated reads are memoized and each month's rows preloaded - see SPEED
    above. Raises TooSlow when `deadline` (time.monotonic()) passes."""
    import ca_breaks
    from routers import timeclock
    from routers.accounting_allocations import _people_and_cards
    per_month, roster_max = [], 0
    stats: dict = {}
    first, last = f"{months[0]}-01", month_end(months[-1])

    def drop_preloads(session):
        # A commit mid-pass (Time Clock creates a missing monitoring policy on
        # first read) expires every loaded row: the readers then go back to
        # the database instead of refreshing preloaded rows one by one.
        timeclock.clear_range_preload(session)
        ca_breaks.clear_preload(session)
    event.listen(db, "after_commit", drop_preloads)
    try:
        with read_memo.memoized(db, deadline=deadline, stats=stats):
            emails = [(e.work_email or "").lower() for e in db.query(models.NexusEmployee).all() if e.work_email]
            ca_breaks.preload(db, emails, first, last)
            try:
                for m in months:
                    if deadline is not None and time.monotonic() > deadline:
                        raise TooSlow()
                    # One day past the month: the engine borrows the next
                    # morning's clock-out for an overnight shift.
                    timeclock.preload_range(db, f"{m}-01", _day_after(month_end(m)))
                    try:
                        people, cards = _people_and_cards(db, m)
                    finally:
                        timeclock.clear_range_preload(db)
                    roster_max = max(roster_max, len(people))
                    per_month.append((m, people, {em: _slim(c) for em, c in cards.items()}))
            finally:
                ca_breaks.clear_preload(db)
            titles = {(e.work_email or "").lower(): (e.job_title or e.designation or "")
                      for e in db.query(models.NexusEmployee).all() if e.work_email}
            punches = (db.query(models.TimePunch).filter(models.TimePunch.voided == 0, models.TimePunch.local_date >= first,
                                                         models.TimePunch.local_date <= last).count())
            rated = db.query(models.PayrollRate).count()
    except read_memo.TimeBudgetExceeded as e:
        raise TooSlow() from e
    finally:
        event.remove(db, "after_commit", drop_preloads)
    if stats.get("tripped"):
        raise TooSlow()
    out = summarize(per_month, titles)
    # Why a report can be empty (CR-02: "a clear 'no data because...'"): the
    # screen picks its sentence from these counts. Counts only - no figure.
    out["coverage"] = {"roster": roster_max, "punches": punches, "ratesSet": rated}
    return out


def _too(code: str, message: str) -> HTTPException:
    # 422, not 5xx: the browser retries a 5xx and shows "reconnecting".
    return HTTPException(status_code=422, detail={"code": code, "message": message})


@router.get("/people")
def compensation_people(from_: str = Query(alias="from"), to: str = Query(...),
                        _su: dict = Depends(require_stepup), db: Session = Depends(get_db)):
    """Per employee for the months [from, to] (YYYY-MM, at most 12). A sync
    route on purpose: FastAPI runs it in the threadpool, so the payroll cards
    are never computed on the event loop."""
    months = month_list(from_, to)
    roster = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email != "").count()
    if roster * len(months) > A.COMP_MAX_PERSON_MONTHS:
        raise _too("too_large", f"{roster} people x {len(months)} months is more than this report builds at once "
                                f"({A.COMP_MAX_PERSON_MONTHS:,} person-months). Pick fewer months and run it again.")
    try:
        out = _people_sync(db, months, deadline=time.monotonic() + A.COMP_TIME_BUDGET_SEC)
    except TooSlow:
        db.rollback()
        raise _too("too_slow", f"Building {len(months)} months took longer than {A.COMP_TIME_BUDGET_SEC} seconds, so it "
                               "was stopped. Pick fewer months and run it again.") from None
    return {"from": f"{months[0]}-01", "to": month_end(months[-1]), "months": months, **out}


# ── Payroll expense on the ledger ────────────────────────────────────────────
_TAX = re.compile(r"payroll tax|employer tax|\bfica\b|\bfuta\b|\bsuta\b|\bsui\b|medicare|social security|unemployment", re.I)
_BENEFIT = re.compile(r"benefit|health|medical|dental|vision|401\s*\(?k|retirement|pension|workers'?\s*comp|life insurance|\bhsa\b|\bfsa\b", re.I)
_WAGE = re.compile(r"payroll|salar|wage|bonus|commission|overtime|\bpto\b|vacation|sick pay", re.I)
_COSTS = ("cogs", "expense", "other_expense")


def payroll_class(section: str, title: str) -> Optional[str]:
    """wages / taxes / benefits, or None when the account is not payroll."""
    if section not in _COSTS:
        return None
    t = title or ""
    if re.search(r"contract labor|contractor", t, re.I):
        return None
    if _TAX.search(t):
        return "taxes"
    if _BENEFIT.search(t):
        return "benefits"
    if _WAGE.search(t):
        return "wages"
    return None


def cost_kind(section: str) -> str:
    """direct / indirect (CR-02's "direct or indirect expenses" - the sections
    are accounting_assumptions.COMP_DIRECT_SECTIONS / COMP_INDIRECT_SECTIONS)."""
    return "direct" if section in A.COMP_DIRECT_SECTIONS else "indirect"


def ledger_rows(rows: list[dict], labels: dict) -> dict:
    """Bucket rows (one per account per department / employee) -> one row per
    bucket with wages, taxes, benefits, the same total split direct /
    indirect, and the accounts behind them. Pure."""
    out: dict[str, dict] = {}
    for r in rows or []:
        section = r.get("section") or ""
        cls = payroll_class(section, r.get("title") or "")
        if not cls:
            continue
        amt = _r2(float(r.get("debit") or 0) - float(r.get("credit") or 0))
        if amt == 0:
            continue
        k = str(r.get("bucket") or "")
        g = out.setdefault(k, {"key": k, "label": labels.get(k) or k or "Unassigned", "wages": 0.0, "taxes": 0.0, "benefits": 0.0,
                               "direct": 0.0, "indirect": 0.0, "total": 0.0, "accounts": []})
        kind = cost_kind(section)
        g[cls] = _r2(g[cls] + amt)
        g[kind] = _r2(g[kind] + amt)
        g["total"] = _r2(g["total"] + amt)
        g["accounts"].append({"account": str(r.get("account_no") or ""), "title": r.get("title") or "", "class": cls, "cost": kind, "amount": amt})
    groups = sorted(out.values(), key=lambda g: (g["key"] == "", g["label"].lower()))
    tot = {k: _r2(sum(g[k] for g in groups)) for k in ("wages", "taxes", "benefits", "direct", "indirect", "total")}
    return {"rows": groups, "totals": tot}


@router.get("/ledger")
async def compensation_ledger(from_: str = Query(alias="from"), to: str = Query(...), by: str = "department",
                              locations: Optional[str] = None, book: Optional[str] = None,
                              scope: dict = Depends(comp_scope), _su: dict = Depends(require_stepup)):
    """Payroll expense on the ledger for the months [from, to], by department
    or employee (the Intacct dimensions), optionally for some entities."""
    if by not in ("department", "employee"):
        raise HTTPException(status_code=400, detail="by must be department or employee")
    months = month_list(from_, to)
    location, locs = await _limit(scope, None, locations)
    data = await accounting._acct_get("/api/internal/reports/buckets", {
        "from": f"{months[0]}-01", "to": month_end(months[-1]), "by": by, "location": location, "locations": locs,
        "book": accounting._book(book),
    })
    return {"from": f"{months[0]}-01", "to": month_end(months[-1]), "by": by, **ledger_rows(data.get("rows") or [], data.get("labels") or {})}
