"""Bonus plans per role and the bonus run (Performance, Oct 30 2026 - PR 3).

A BONUS PLAN belongs to a job role (Pranshu: "the bonus % needs to be set for
each role, not for each candidate"): a target percentage of base pay, how
often it pays (monthly or quarterly) and the payout curve read off the
monthly score (perf_scores):

  score < thresholdScore          -> nothing
  score at thresholdScore         -> payoutAtThreshold % of target
  score 100                       -> 100 % of target (straight line between)
  over target (the KPIs' weighted
  over-target reading, 0..100)    -> up to maxPayout % when maxPayout > 100

A BONUS RUN is one period for one company: HR starts it once the period has
ended, Nexus builds a line per eligible person (active, holds a role with an
active plan of that cadence) with the period's score (the average of its
scored months), the payout and the amount from their pay rate; managers
review their reports' lines and may adjust within the plan's bound with a
reason; HR approves, then pays - one TimecardBonus per line, which prints on
the Time Sheet and tells the person (the existing bonus path, never a second
one). The line keeps every input it was priced with, so a plan or pay change
after the run changes nothing.

Who sees amounts: HR for the company (pay is salary data). A manager sees
score, payout and their own adjustment - never the money.
"""
import uuid
from datetime import date, datetime, timezone
from statistics import mean

from fastapi import HTTPException

import models
import perf_scorecards as sc
import perf_scores as ps
import performance as perf

PERIODS = ("monthly", "quarterly")
ADJUST_MAX_DEFAULT = 20
MIN_MEASURED = 50          # % of the scorecard weight a period must have measured before it pays - a score built on less is "thin data", not a bonus
HOURS_PER_MONTH = 173.33     # shortcut: a full-time month at 40 h/week for hourly base pay; upgrade to the period's paid hours when payroll asks


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── plans ───────────────────────────────────────────────────────────────────
def plan_for(db, role_id: str):
    return db.query(models.PerfBonusPlan).filter(models.PerfBonusPlan.role_id == role_id).first()


def plan_out(p) -> dict | None:
    if p is None:
        return None
    return {"id": p.id, "roleId": p.role_id, "companyId": p.company_id, "targetPct": p.target_pct, "period": p.period,
            "thresholdScore": p.threshold_score, "payoutAtThreshold": p.payout_at_threshold, "maxPayout": p.max_payout,
            "adjustMax": p.adjust_max, "active": bool(p.active), "updatedBy": p.updated_by, "updatedAt": p.updated_at}


def _pct(v, field: str, lo: float, hi: float) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise HTTPException(400, f"{field} must be a number")
    if not (lo <= x <= hi):
        raise HTTPException(400, f"{field} runs from {lo:g} to {hi:g}")
    return round(x, 2)


def save_plan(db, user: dict, company_id: str, role_id: str, body: dict):
    role = sc._role(db, company_id, role_id)
    period = (body.get("period") or "monthly").strip()
    if period not in PERIODS:
        raise HTTPException(400, "The period is monthly or quarterly")
    vals = {"target_pct": _pct(body.get("targetPct", 0), "Target %", 0, 100),
            "threshold_score": _pct(body.get("thresholdScore", 60), "Threshold score", 0, 99),
            "payout_at_threshold": _pct(body.get("payoutAtThreshold", 50), "Payout at threshold", 0, 100),
            "max_payout": _pct(body.get("maxPayout", 100), "Maximum payout", 100, 300),
            "adjust_max": _pct(body.get("adjustMax", ADJUST_MAX_DEFAULT), "Manager adjustment", 0, 100),
            "period": period, "active": 1 if body.get("active", True) else 0,
            "updated_by": (user.get("email") or "").lower(), "updated_at": _now()}
    p = plan_for(db, role.id)
    if p is None:
        p = models.PerfBonusPlan(id=str(uuid.uuid4()), company_id=company_id, role_id=role.id, created_at=_now())
        db.add(p)
    for k, v in vals.items():
        setattr(p, k, v)
    db.flush()
    return p


def payout_pct(plan, score, over: float = 0.0):
    """The payout as % of the target bonus for a score (None = unscored)."""
    if score is None:
        return None
    if score < plan.threshold_score:
        return 0.0
    span = 100 - plan.threshold_score
    base = 100.0 if span <= 0 or score >= 100 else plan.payout_at_threshold + (score - plan.threshold_score) / span * (100 - plan.payout_at_threshold)
    stretch = (over or 0.0) / 100 * (plan.max_payout - 100) if plan.max_payout > 100 else 0.0
    return round(min(base + stretch, plan.max_payout), 1)


# ── periods ─────────────────────────────────────────────────────────────────
def period_months(key: str) -> list:
    """'2026-10' -> ['2026-10']; '2026-Q4' -> ['2026-10', '2026-11', '2026-12']."""
    k = (key or "").strip().upper()
    try:
        if "-Q" in k:
            y, q = k.split("-Q")
            y, q = int(y), int(q)
            if not 1 <= q <= 4:
                raise ValueError
            return [f"{y}-{m:02d}" for m in range((q - 1) * 3 + 1, q * 3 + 1)]
        y, m = (int(x) for x in k.split("-")[:2])
        date(y, m, 1)
        return [f"{y}-{m:02d}"]
    except (TypeError, ValueError):
        raise HTTPException(400, "Period must be YYYY-MM or YYYY-Qn")


def period_bounds(key: str) -> tuple:
    months = period_months(key)
    start = f"{months[0]}-01"
    end = sc.month_end(date.fromisoformat(f"{months[-1]}-01"))
    return start, end


def _month_label(k: str) -> str:
    y, m = k.split("-")[:2]
    return date(int(y), int(m), 1).strftime("%B %Y")


def period_kind(key: str) -> str:
    return "quarterly" if "-Q" in (key or "").upper() else "monthly"


# ── runs ────────────────────────────────────────────────────────────────────
def _base_pay(db, email: str, n_months: int) -> tuple:
    """(base pay for the period, currency, note) from the person's pay rate."""
    rr = db.query(models.PayrollRate).filter(models.PayrollRate.employee_email == email).first()
    if rr is None:
        return 0.0, "USD", "no_pay_rate"
    cur = (rr.currency or "USD")
    if (rr.pay_type or "hourly") == "fixed":
        return round((rr.monthly_salary or 0) * n_months, 2), cur, ""
    return round((rr.hourly_rate or 0) * HOURS_PER_MONTH * n_months, 2), cur, "hourly_standard_month"


def _line_amounts(line) -> None:
    line.computed_amount = round(line.base_pay * line.target_pct / 100 * (line.payout_pct or 0) / 100, 2)
    line.final_amount = 0.0 if line.excluded else round(line.computed_amount * (1 + (line.adjust_pct or 0) / 100), 2)


def start_run(db, user: dict, company_id: str, period: str, today: date | None = None):
    """HR starts the run for a period that has ended; one per company and period."""
    today = today or date.today()
    months = period_months(period)
    start, end = period_bounds(period)
    if end >= today.isoformat():
        raise HTTPException(400, "The period has not ended yet - start the run after its last day")
    key = period.strip().upper()
    if db.query(models.PerfBonusRun).filter(models.PerfBonusRun.company_id == company_id, models.PerfBonusRun.period == key,
                                            models.PerfBonusRun.status != "cancelled").first():
        raise HTTPException(409, "A run for this period already exists")
    kind = period_kind(key)
    me = (user.get("email") or "").lower()
    run = models.PerfBonusRun(id=str(uuid.uuid4()), company_id=company_id, period=key, period_start=start, period_end=end,
                              status="review", created_by=me, created_at=_now())
    db.add(run)
    db.flush()
    emps = (db.query(models.NexusEmployee).filter(models.NexusEmployee.company == company_id)
            .order_by(models.NexusEmployee.first_name, models.NexusEmployee.last_name).all())
    n, seen = 0, set()
    for emp in emps:
        em = (emp.work_email or "").lower()
        if not perf._active(emp) or not em or em in seen:        # one line per person, whatever People holds
            continue
        seen.add(em)
        role = sc.role_of_person(db, em)
        plan = plan_for(db, role.id) if role else None
        if not plan or not plan.active or plan.period != kind:
            continue
        scored = [ps.score(db, em, m, today) for m in months]
        with_score = [s for s in scored if s["score"] is not None]
        score = round(mean(s["score"] for s in with_score), 1) if with_score else None
        over = round(mean(s.get("overTarget") or 0 for s in with_score), 1) if with_score else 0.0
        measured = round(mean(s["measuredWeight"] for s in with_score), 1) if with_score else 0
        base, cur, note = _base_pay(db, em, len(months))
        if score is not None and measured < MIN_MEASURED:
            score, note = None, "thin_data"                         # kept on the line's months_scored; the flag says why
        line = models.PerfBonusLine(id=str(uuid.uuid4()), run_id=run.id, email=em, role_id=role.id, role_name=role.name,
                                    department=emp.department or "", manager_email=(emp.manager_email or "").lower(),
                                    score=score, over_target=over, measured_weight=measured, months_scored=len(with_score),
                                    payout_pct=payout_pct(plan, score, over), base_pay=base, currency=cur, target_pct=plan.target_pct,
                                    adjust_max=plan.adjust_max, note=note, adjust_pct=0.0, adjust_reason="", excluded=0)
        _line_amounts(line)
        db.add(line)
        n += 1
    run.line_count = n
    db.flush()
    return run


def lines_of(db, run) -> list:
    return (db.query(models.PerfBonusLine).filter(models.PerfBonusLine.run_id == run.id)
            .order_by(models.PerfBonusLine.manager_email, models.PerfBonusLine.email).all())


def line_out(db, ln, money: bool) -> dict:
    out = {"id": ln.id, "email": ln.email, "name": perf.name_of(db, ln.email), "roleName": ln.role_name, "department": ln.department,
           "manager": ln.manager_email, "managerName": perf.name_of(db, ln.manager_email) if ln.manager_email else "",
           "score": ln.score, "overTarget": ln.over_target, "measuredWeight": ln.measured_weight, "monthsScored": ln.months_scored,
           "payoutPct": ln.payout_pct, "targetPct": ln.target_pct, "adjustPct": ln.adjust_pct, "adjustMax": ln.adjust_max,
           "adjustReason": ln.adjust_reason or "", "adjustedBy": ln.adjusted_by or "", "adjustedByName": perf.name_of(db, ln.adjusted_by) if ln.adjusted_by else "",
           "excluded": bool(ln.excluded), "note": ln.note or "", "paid": bool(ln.bonus_id)}
    if money:
        out.update({"basePay": ln.base_pay, "currency": ln.currency, "computedAmount": ln.computed_amount, "finalAmount": ln.final_amount})
    return out


def run_out(db, run, money: bool, with_lines: bool = True) -> dict:
    out = {"id": run.id, "companyId": run.company_id, "period": run.period, "label": _label(run.period), "periodStart": run.period_start,
           "periodEnd": run.period_end, "status": run.status, "lineCount": run.line_count, "createdBy": run.created_by, "createdAt": run.created_at,
           "approvedBy": run.approved_by or "", "approvedAt": run.approved_at or "", "paidAt": run.paid_at or "", "notes": run.notes or ""}
    if with_lines:
        rows = lines_of(db, run)
        out["lines"] = [line_out(db, ln, money) for ln in rows]
        if money:
            out["total"] = round(sum(ln.final_amount for ln in rows if not ln.excluded), 2)
        out["fairness"] = fairness(db, rows)
    return out


def _label(key: str) -> str:
    k = (key or "").upper()
    if "-Q" in k:
        y, q = k.split("-Q")
        return f"Q{q} {y}"
    return _month_label(k)


def adjust(db, user: dict, line, adjust_pct, reason: str, excluded=None):
    """A manager in the person's chain (within the plan's bound) or HR for the
    company (any) adjusts a line while the run is in review; a reason is
    required for any change. HR may also exclude a line."""
    run = db.get(models.PerfBonusRun, line.run_id)
    if run.status != "review":
        raise HTTPException(409, "This run is no longer in review")
    me = (user.get("email") or "").lower()
    hr = perf.hr_for(db, user, run.company_id)
    if not (hr or perf.is_above(db, me, line.email)):
        raise HTTPException(403, "Only the person's manager chain or HR adjusts a bonus line")
    if line.email == me:
        raise HTTPException(403, "Nobody adjusts their own bonus")
    if not (reason or "").strip():
        raise HTTPException(400, "Say why - the reason stays on the line")
    bound = 100 if hr else (line.adjust_max or 0)
    a = _pct(adjust_pct, "Adjustment", -bound, bound)
    if excluded is not None:
        if not hr:
            raise HTTPException(403, "Only HR excludes a person from a run")
        line.excluded = 1 if excluded else 0
    line.adjust_pct, line.adjust_reason, line.adjusted_by, line.adjusted_at = a, reason.strip(), me, _now()
    _line_amounts(line)
    db.flush()
    return line


def approve(db, user: dict, run) -> None:
    if run.status != "review":
        raise HTTPException(409, "Only a run in review is approved")
    run.status, run.approved_by, run.approved_at = "approved", (user.get("email") or "").lower(), _now()


def cancel(db, run) -> None:
    if run.status == "paid":
        raise HTTPException(409, "A paid run cannot be cancelled - remove the bonuses on the Time Sheets instead")
    run.status = "cancelled"


def pay(db, user: dict, run, today: date | None = None) -> int:
    """Approved -> paid: a TimecardBonus per line with money, dated the day HR
    pays it, so it lands on the pay period that is OPEN now (the next payroll,
    as a real bonus does) and never on a period already signed and paid; the
    description names the period it was earned in. The person is told the way
    every bonus tells them."""
    pay_day = (today or date.today()).isoformat()
    if run.status != "approved":
        raise HTTPException(409, "Approve the run before paying it")
    from routers.timeclock import _bonus_told
    me = (user.get("email") or "").lower()
    n = 0
    for ln in lines_of(db, run):
        if ln.excluded or ln.bonus_id or (ln.final_amount or 0) <= 0:
            continue
        desc = f"Performance bonus - {_label(run.period)} (score {ln.score:g}, payout {ln.payout_pct:g}%" + (f", adjusted {ln.adjust_pct:+g}%" if ln.adjust_pct else "") + ")"
        row = models.TimecardBonus(id=str(uuid.uuid4()), employee_email=ln.email, date=pay_day, description=desc[:500],
                                   amount=round(ln.final_amount, 2), created_by=me, created_at=_now())
        db.add(row)
        ln.bonus_id = row.id
        db.info.pop("_bonus_emails", None)
        _bonus_told(db, user, row, True)
        n += 1
    run.status, run.paid_at = "paid", _now()
    db.flush()
    return n


# ── fairness ────────────────────────────────────────────────────────────────
def fairness(db, rows: list) -> dict:
    """The same numbers by manager and by department so HR sees a lenient or
    harsh hand before approving: average score, payout and adjustment, the
    spread of scores, and plain flags."""
    def group(key):
        buckets = {}
        for ln in rows:
            if ln.excluded:
                continue
            buckets.setdefault(key(ln) or "", []).append(ln)
        out = []
        for k, ls in sorted(buckets.items()):
            scored = [ln.score for ln in ls if ln.score is not None]
            adj = [ln.adjust_pct or 0 for ln in ls]
            flags = []
            if len(ls) - len(scored):
                flags.append(f"{len(ls) - len(scored)} unscored")
            if any(ln.note == "thin_data" for ln in ls):
                flags.append("thin data")
            if adj and mean(adj) >= 5:
                flags.append("adjustments lean up")
            if adj and mean(adj) <= -5:
                flags.append("adjustments lean down")
            if len(scored) >= 3 and max(scored) - min(scored) <= 5:
                flags.append("no spread")
            out.append({"key": k, "name": perf.name_of(db, k) if "@" in k else (k or "No department"), "people": len(ls),
                        "avgScore": round(mean(scored), 1) if scored else None,
                        "avgPayout": round(mean(ln.payout_pct or 0 for ln in ls), 1),
                        "avgAdjust": round(mean(adj), 1) if adj else 0,
                        "spread": round(max(scored) - min(scored), 1) if len(scored) > 1 else None, "flags": flags})
        return out
    return {"byManager": group(lambda ln: ln.manager_email), "byDepartment": group(lambda ln: ln.department)}
