"""Accounting -> Reporting -> Employee Compensation (Neil, 10/15: "We still
need to make employee compensation report"; rebuilt from the ledger after the
10/27 call with Charmi, items 11-17).

Three reads:

  /accounting/compensation/report   per employee, Intacct's Employee
      Compensation Report: Payroll Expenses (Bonus, Salaried / Hourly
      Payroll), Benefits (401(k) and Health Insurance - Company, Other
      Benefits), Employer Payroll Taxes (FUTA, Medicare, Social Security, SUTA,
      CA Employment Training Tax), Workers' Comp, Total Employer Expenses, and
      the employee's side: Deductions from Gross Pay, Employee Taxes Withheld
      (Federal, Medicare, Social Security, SDI, State) and Employee Net Pay -
      for the months asked and the same months a year before (Intacct's
      "Year Ending" and prior-year columns). Every figure is the LEDGER's: the
      lines carrying the Intacct Employee dimension, read through the
      accounting app's buckets (by=employee), never the accounting database -
      so a correction made in Intacct shows on the next Sync (Charmi, 15:41:
      "when I fix it in Intacct, Nexus should fix it too"). Before 10/27 wages
      came from Time Clock's payroll cards (Valinda Cranfill: 3,540.23 against
      Intacct's 52,123.06).
  /accounting/compensation/lines    the ledger lines behind one figure (item
      17: "everything should have the drill down option").
  /accounting/compensation/people   hours per employee from Time Clock's
      payroll card for each month (`_compute_timecard` / `_fixed_card` through
      accounting_allocations._people_and_cards, the Allocations engine) -
      regular, overtime / double time, sick and vacation (no Personal: item
      15, "either it is sick or vacation"). The screen labels them as Time
      Clock's. There is NO second pay computation here.

Who may read it: wages for everyone are payroll figures. The gate is the
strictest one already used for them (Accounting > Allocations): the FULL level
on the Accounting grant (administrators bypass, as everywhere), a fresh
step-up, AND no entity limit - the roster covers every company, so there is
no part of it to show a person limited to certain entities (CR-02: the
policy is `COMP_ENTITY_SCOPED_POLICY` in accounting_assumptions.py). The HR
record's compensation block (hr_comp grant) is not read; the workers' comp
rate (models.WorkersCompRate, item 14) is the one thing from People. No
figure is ever logged.

SPEED (CR-02, Oct 23 2026: Jan-Sep "never finished loading"): the Time Clock
engine is built for one card at a time and made ~26 database round trips per
person per month. The pass now runs inside read_memo.memoized (an identical
SELECT is answered once) with each month's punches, finalizations, idle
frames and punch requests preloaded (timeclock.preload_range) and the CA
waiver / premium rows preloaded (ca_breaks.preload). A run is refused up
front past COMP_MAX_PERSON_MONTHS and stopped past COMP_TIME_BUDGET_SEC, both
with a 422 that says what to do (a 5xx would be retried by the browser and
raise the "reconnecting" banner). The ledger report is one buckets read per
calendar year in each period, so it is on screen while the hours still build.

LEDGER LINES (comp_line below). The payroll accounts the Import Hub's payroll
file posts to (payrollConvert.js DEFAULT_PAYROLL_MAPPING - the accounts on the
OSM payroll file Charmi shared) are named by number in ACCOUNT_LINES; any
other account goes by its title. On cost accounts (cogs, expense,
other_expense; amount = debits less credits): payroll taxes first, then
bonus, 401(k) / retirement, health / dental / vision, wages; EVERY other cost
line carrying an employee is Other Benefits, by account (item 12: "anytime a
transaction has an employee name attached to it, it should be considered as
a part of the compensation" - the fuel on a company card). On balance-sheet
accounts only the employee's side of pay counts - what was withheld or
deducted (a credit, so a negative figure); net pay owed, cash, cards and the
employer-tax liabilities are not compensation. Health insurance is split by
side: the company's premium is the debit, the employee's share deducted from
pay is the credit the payroll file posts to the same account (61903). Income
accounts never count.
"""
import asyncio
import re
import time
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import event
from sqlalchemy.orm import Session

import accounting_assumptions as A
import database
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
# Time Clock minutes per month. No Personal: time off is Sick or Vacation (10/27 item 15).
_MIN_KEYS = ("regMin", "otMin", "dtMin", "sickMin", "vacationMin")


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
        r["leaveMin"] = r["sickMin"] + r["vacationMin"]
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


# ── The report from the ledger (10/27 call, items 11-14) ─────────────────────
_COSTS = ("cogs", "expense", "other_expense")
_INCOME = ("income", "revenue", "other_income")

PAYROLL_LINES = ("bonus", "payroll")
BENEFIT_LINES = ("k401", "health", "otherBenefits")
TAX_LINES = ("futa", "medicare", "socsec", "suta", "ett", "otherTaxes")
DEDUCTION_LINES = ("dedHealth", "ded401k", "dedOther")
WITHHELD_LINES = ("fedWh", "medicareWh", "socsecWh", "sdi", "stateWh")
LEDGER_LINES = PAYROLL_LINES + BENEFIT_LINES + TAX_LINES + DEDUCTION_LINES + WITHHELD_LINES

# The accounts the payroll file posts to (payrollConvert.js DEFAULT_PAYROLL_MAPPING).
ACCOUNT_LINES = {
    "61908": "bonus",
    "61904": "payroll", "61905": "payroll", "61906": "payroll", "61907": "payroll", "61909": "payroll", "61910": "payroll",
    "61903": "health",
    "62101": "futa", "62102": "medicare", "62104": "socsec", "62105": "suta", "62106": "ett",
    "23801": "fedWh", "23804": "medicareWh", "23807": "socsecWh", "23806": "sdi", "23811": "stateWh",
    "23101": "ded401k",
}
# Net pay owed and the employer-tax liabilities: the expense side of each is what counts.
NOT_PAY_ACCOUNTS = frozenset({"23700", "23802", "23803", "23805", "23808", "23810"})

_PAY_TAX = re.compile(r"payroll tax|employer tax|\bfica\b|\bfuta\b|\bsuta\b|\bsui\b|medicare|social security|unemployment|training tax|\bett\b", re.I)
_BONUS = re.compile(r"\bbonus", re.I)
_K401 = re.compile(r"401\s*\(?k|retirement|pension", re.I)
_HEALTH = re.compile(r"health|medical|dental|vision", re.I)
_WAGE = re.compile(r"payroll|salar|wage|commission|overtime|hourly|holiday|\bpto\b|vacation|\bsick", re.I)


def _tax_line(title: str) -> str:
    for line, pat in (("futa", r"\bfuta\b|federal unemployment"), ("medicare", r"medicare"), ("socsec", r"social security|oasdi|\bfica\b"),
                      ("ett", r"training tax|\bett\b"), ("suta", r"\bsuta\b|\bsui\b|unemployment")):
        if re.search(pat, title, re.I):
            return line
    return "otherTaxes"


def _withheld_line(title: str) -> Optional[str]:
    """A balance-sheet account: the employee's side of pay, or None."""
    t = title or ""
    if re.search(r"compan|employer|net pay", t, re.I):
        return None
    if re.search(r"federal|\bfit\b", t, re.I) and re.search(r"withh|income tax|\bfit\b", t, re.I):
        return "fedWh"
    for line, pat in (("medicareWh", r"medicare"), ("socsecWh", r"social security|oasdi"), ("sdi", r"\bsdi\b|disability"),
                      ("stateWh", r"withh|state income tax|\bsit\b")):
        if re.search(pat, t, re.I):
            return line
    if _K401.search(t):
        return "ded401k"
    if _HEALTH.search(t):
        return "dedHealth"
    if re.search(r"deduction|garnish|child support", t, re.I):
        return "dedOther"
    return None


def comp_line(section: str, account_no: str, title: str) -> Optional[str]:
    """The report line an employee's ledger line belongs to, or None when it is
    not compensation (LEDGER LINES above). Pure."""
    code = str(account_no or "").strip()
    if code in NOT_PAY_ACCOUNTS:
        return None
    if code in ACCOUNT_LINES:
        return ACCOUNT_LINES[code]
    t = title or ""
    if section in _COSTS:
        if _PAY_TAX.search(t):
            return _tax_line(t)
        if _BONUS.search(t):
            return "bonus"
        if _K401.search(t):
            return "k401"
        if _HEALTH.search(t):
            return "health"
        if _WAGE.search(t) and not re.search(r"contract", t, re.I):
            return "payroll"
        return "otherBenefits"
    if not section or section in _INCOME:
        return None
    return _withheld_line(t)


def employee_code(bucket) -> str:
    """The employee ID from "E-0084" or Intacct's "E-0084--Valinda Cranfill"."""
    return str(bucket or "").split("--")[0].strip()


def _add_account(accounts: dict, line: str, acct: str, title: str, side: str, amount: float):
    rows = accounts.setdefault(line, [])
    hit = next((a for a in rows if a["account"] == acct and a["side"] == side), None)
    if hit:
        hit["amount"] = _r2(hit["amount"] + amount)
    else:
        rows.append({"account": acct, "title": title, "side": side, "amount": amount})


def ledger_people(rows: list[dict], labels: dict) -> dict[str, dict]:
    """Buckets by employee (one row per account per employee) -> per employee
    code: the name the ledger knows, each line's amount and the accounts behind
    it ({account, title, side, amount}; side "d" / "c" = only the debits /
    credits, the health split). Lines with no employee are left out. Pure."""
    out: dict[str, dict] = {}
    for r in rows or []:
        code = employee_code(r.get("bucket"))
        if not code:
            continue
        section = r.get("section") or ""
        acct = str(r.get("account_no") or "").strip()
        title = r.get("title") or ""
        line = comp_line(section, acct, title)
        if not line:
            continue
        debit, credit = _r2(r.get("debit")), _r2(r.get("credit"))
        # The company's premium is the debit; the employee's share, deducted from pay, the credit.
        parts = [("health", "d", debit), ("dedHealth", "c", -credit)] if line == "health" else [(line, "", _r2(debit - credit))]
        p = out.setdefault(code, {"code": code, "name": str(labels.get(r.get("bucket")) or labels.get(code) or "").strip(), "lines": {}, "accounts": {}})
        for key, side, amt in parts:
            if not amt:
                continue
            p["lines"][key] = _r2(p["lines"].get(key, 0) + amt)
            _add_account(p["accounts"], key, acct, title, side, amt)
    return out


def with_totals(lines: dict, workers_comp: float = 0.0) -> dict:
    """Every line and Intacct's totals. Deductions and taxes withheld are
    negative (taken out of pay), so Net Pay is their sum with the payroll."""
    v = {k: _r2(lines.get(k)) for k in LEDGER_LINES}
    v["workersComp"] = _r2(workers_comp)
    v["totalPayroll"] = _r2(sum(v[k] for k in PAYROLL_LINES))
    v["totalBenefits"] = _r2(sum(v[k] for k in BENEFIT_LINES))
    v["totalTaxes"] = _r2(sum(v[k] for k in TAX_LINES))
    v["totalEmployer"] = _r2(v["totalPayroll"] + v["totalBenefits"] + v["totalTaxes"] + v["workersComp"])
    v["totalDeductions"] = _r2(sum(v[k] for k in DEDUCTION_LINES))
    v["totalWithheld"] = _r2(sum(v[k] for k in WITHHELD_LINES))
    v["netPay"] = _r2(v["totalPayroll"] + v["totalDeductions"] + v["totalWithheld"])
    return v


def rate_in_force(entries: list[tuple], year: int) -> Optional[tuple]:
    """(rate %, the year it is from) for `year` - the latest year on or before
    it, the newest entry for that year - or None. `entries` = [(effective_year,
    rate_pct, set_at)]. Pure."""
    best = None
    for y, rate, at in entries or []:
        if y <= year and (best is None or (y, at or "") > (best[0], best[2] or "")):
            best = (y, rate, at)
    return (best[1], best[0]) if best else None


def year_slices(months: list[str]) -> list[tuple[int, str, str]]:
    """[(year, first day, last day)] - the months split where a new year starts
    (workers' comp takes the rate in force each year)."""
    out: list[tuple[int, str, str]] = []
    for m in months:
        y = int(m[:4])
        if out and out[-1][0] == y:
            out[-1] = (y, out[-1][1], month_end(m))
        else:
            out.append((y, f"{m}-01", month_end(m)))
    return out


def build_report(slices: list[tuple[str, int, dict]], rates: dict, people: dict) -> list[dict]:
    """`slices` = [(period "cur" | "prior", year, buckets answer)], `rates` =
    employee code -> [(effective_year, rate_pct, set_at)], `people` = employee
    code -> the Nexus People record. One row per employee with something in
    the current period: both periods' lines with totals, the accounts behind
    each line and the workers' comp worked out per year. Pure."""
    per: dict[str, dict] = {}
    for key, year, data in slices:
        for code, p in ledger_people(data.get("rows") or [], data.get("labels") or {}).items():
            e = per.setdefault(code.upper(), {"code": code, "name": "", "cur": {"lines": {}, "accounts": {}, "wc": []},
                                              "prior": {"lines": {}, "accounts": {}, "wc": []}})
            e["name"] = e["name"] or p["name"]
            t = e[key]
            for k, amt in p["lines"].items():
                t["lines"][k] = _r2(t["lines"].get(k, 0) + amt)
            for k, accts in p["accounts"].items():
                for a in accts:
                    _add_account(t["accounts"], k, a["account"], a["title"], a["side"], a["amount"])
            gross = _r2(sum(p["lines"].get(k, 0) for k in PAYROLL_LINES))
            hit = rate_in_force(rates.get(code.upper()) or [], year)
            if hit and gross:
                t["wc"].append({"year": year, "ratePct": hit[0], "rateYear": hit[1], "gross": gross, "amount": _r2(gross * hit[0] / 100)})
    rows = []
    for code_u, e in per.items():
        cur = with_totals(e["cur"]["lines"], sum(w["amount"] for w in e["cur"]["wc"]))
        if not any(cur.values()):
            continue
        info = people.get(code_u) or {}
        rows.append({
            "code": e["code"], "name": info.get("name") or e["name"] or e["code"], "email": info.get("email") or "",
            "company": info.get("company") or "", "companyName": info.get("companyName") or "",
            "department": info.get("department") or "", "title": info.get("title") or "", "inPeople": bool(info),
            "hasRate": bool(rates.get(code_u)),
            "cur": cur, "prior": with_totals(e["prior"]["lines"], sum(w["amount"] for w in e["prior"]["wc"])),
            "accounts": {"cur": e["cur"]["accounts"], "prior": e["prior"]["accounts"]},
            "workersComp": {"cur": e["cur"]["wc"], "prior": e["prior"]["wc"]},
        })
    rows.sort(key=lambda r: (r["companyName"].lower(), r["department"].lower(), r["name"].lower()))
    return rows


def _people_and_rates() -> tuple[dict, dict]:
    """Nexus People by employee code (the Intacct employee ID - Valinda
    Cranfill is E-0084 in both), and the workers' comp rates by the same code.
    Its own session: called through asyncio.to_thread."""
    db = database.SessionLocal()
    try:
        companies = {c.id: c.name or "" for c in db.query(models.HrEntity).all()}
        people, ids = {}, {}
        # An active record wins over an old one with the same code.
        for e in sorted(db.query(models.NexusEmployee).all(), key=lambda e: e.status == "active"):
            code = (e.employee_code or "").strip().upper()
            if not code:
                continue
            ids[e.id] = code
            people[code] = {"name": (e.display_name or f"{e.first_name or ''} {e.last_name or ''}").strip(), "email": (e.work_email or "").lower(),
                            "company": e.company or "", "companyName": companies.get(e.company or "", ""),
                            "department": e.department or "", "title": e.job_title or e.designation or ""}
        rates: dict[str, list] = {}
        for r in db.query(models.WorkersCompRate).all():
            code = ids.get(r.employee_id)
            if code and r.rate_pct is not None:
                rates.setdefault(code, []).append((int(r.effective_year), float(r.rate_pct), r.set_at or ""))
        return people, rates
    finally:
        db.close()


def _year_back(month: str) -> str:
    return f"{int(month[:4]) - 1:04d}{month[4:]}"


@router.get("/report")
async def compensation_report(from_: str = Query(alias="from"), to: str = Query(...),
                              scope: dict = Depends(comp_scope), _su: dict = Depends(require_stepup)):
    """Intacct's Employee Compensation Report for every employee on the ledger:
    the months [from, to] (YYYY-MM, at most 12) and the same months a year
    before. One buckets read per calendar year in each period, side by side."""
    months = month_list(from_, to)
    prior = [_year_back(m) for m in months]
    location, locs = await _limit(scope, None, None)
    slices = [(key, y, f, t) for key, ms in (("cur", months), ("prior", prior)) for (y, f, t) in year_slices(ms)]
    answers = await asyncio.gather(*[accounting._acct_get("/api/internal/reports/buckets", {
        "from": f, "to": t, "by": "employee", "location": location, "locations": locs}) for (_k, _y, f, t) in slices])
    people, rates = await asyncio.to_thread(_people_and_rates)
    rows = build_report([(k, y, a) for (k, y, _f, _t), a in zip(slices, answers)], rates, people)
    return {"from": f"{months[0]}-01", "to": month_end(months[-1]), "months": months,
            "prior": {"from": f"{prior[0]}-01", "to": month_end(prior[-1])}, "people": rows,
            "notInPeople": sum(1 for r in rows if not r["inPeople"])}


_SPEC = re.compile(r"^[A-Za-z0-9._-]{1,24}(:[dc])?$")
_EMP = re.compile(r"^[A-Za-z0-9 ._-]{1,40}$")
MAX_DRILL_ACCOUNTS = 60
MAX_DRILL_PEOPLE = 500
DRILL_PAGE = 1000


def drill_line(x: dict, side: str) -> dict:
    """One ledger line for the drill-down: what the screen shows. The amount is
    debits less credits, as on the report (only one side for a split account)."""
    debit, credit = _r2(x.get("debit")), _r2(x.get("credit"))
    amount = debit if side == "d" else _r2(-credit) if side == "c" else _r2(debit - credit)
    return {"id": str(x.get("line_id") or ""), "entryId": x.get("entry_id") or "", "entryNo": x.get("entry_no") or "",
            "date": x.get("entry_date") or "", "account": str(x.get("gl_code") or ""), "accountName": x.get("account_name") or "",
            "vendor": x.get("vendor_name") or "", "vendorId": x.get("vendor_id") or "",
            "employee": x.get("employee_name") or "", "employeeId": x.get("employee_id") or "",
            "entity": x.get("location_name") or x.get("location") or "",
            "memo": x.get("memo") or "", "description": x.get("description") or "", "amount": amount}


@router.get("/lines")
async def compensation_lines(from_: str = Query(alias="from"), to: str = Query(...), employees: str = Query(...), accounts: str = Query(...),
                             scope: dict = Depends(comp_scope), _su: dict = Depends(require_stepup)):
    """The ledger lines behind one figure (10/27 call, item 17): the employees'
    lines on those accounts between two ISO dates. Each account may say
    `:d` / `:c` - only its debits / credits (the health split). Sorted by date;
    `truncated` when an account had more than DRILL_PAGE lines."""
    for v, what in ((from_, "from"), (to, "to")):
        try:
            date.fromisoformat(v)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"{what} must be a date (YYYY-MM-DD)") from None
    codes = list(dict.fromkeys(c.strip() for c in employees.split(",") if c.strip()))
    specs = list(dict.fromkeys(a.strip() for a in accounts.split(",") if a.strip()))
    if not codes or len(codes) > MAX_DRILL_PEOPLE or not all(_EMP.match(c) for c in codes):
        raise HTTPException(status_code=400, detail=f"employees must be 1 to {MAX_DRILL_PEOPLE} employee IDs")
    if not specs or len(specs) > MAX_DRILL_ACCOUNTS or not all(_SPEC.match(a) for a in specs):
        raise HTTPException(status_code=400, detail=f"accounts must be 1 to {MAX_DRILL_ACCOUNTS} account numbers")
    location, locs = await _limit(scope, None, None)

    async def one(spec: str):
        acct, _, side = spec.partition(":")
        params = {"from": from_, "to": to, "account": acct, "employee": ",".join(codes), "location": location, "locations": locs,
                  "offset": 0, "limit": DRILL_PAGE}
        if side == "d":
            params.update(debit_op="gt", debit_v=0)
        elif side == "c":
            params.update(credit_op="gt", credit_v=0)
        return side, await accounting._acct_get("/api/internal/search", params)

    lines, truncated = [], False
    for side, data in await asyncio.gather(*[one(s) for s in specs]):
        got = data.get("rows") or []
        truncated = truncated or int(data.get("total") or 0) > len(got)
        lines.extend(drill_line(x, side) for x in got)
    lines.sort(key=lambda r: (r["date"], r["entryNo"], r["account"]))
    return {"from": from_, "to": to, "lines": lines, "total": _r2(sum(r["amount"] for r in lines)), "truncated": truncated}
