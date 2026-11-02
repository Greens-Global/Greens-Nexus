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
from datetime import date, datetime, timedelta, timezone
from statistics import mean

from fastapi import HTTPException

import models
import perf_scorecards as sc
import perf_scores as ps
import performance as perf

PERIODS = ("monthly", "quarterly")
ADJUST_MAX_DEFAULT = 20
MIN_MEASURED = 50          # % of the scorecard weight a period must have measured before it pays - a score built on less is "thin data", not a bonus
HOURS_PER_MONTH = 173.33     # fallback only: a full-time month at 40 h/week when the Time Sheet has nothing for the period
REVIEW_SCORES = {"exceeds": 100.0, "meets": 85.0, "partly": 55.0, "below": 0.0}   # the review's 4-word rating as a 0..100 score
REMIND_FROM_DAY = 25         # from this day of the month managers are reminded of manual KPIs still unrated


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
            "adjustMax": p.adjust_max, "reviewWeight": p.review_weight or 0, "active": bool(p.active),
            "updatedBy": p.updated_by, "updatedAt": p.updated_at}


def plan_history(db, plan_id: str) -> list:
    rows = (db.query(models.PerfBonusPlanLog).filter(models.PerfBonusPlanLog.plan_id == plan_id)
            .order_by(models.PerfBonusPlanLog.changed_at.desc()).all())
    return [{"id": r.id, "at": r.changed_at, "by": r.changed_by, "byName": perf.name_of(db, r.changed_by), **(r.snapshot or {})} for r in rows]


def plan_summary(db, role_id: str, score=None, over: float = 0.0, email: str = "", on: str = "") -> dict | None:
    """What a person may know about their own role's plan: the target %, the
    cadence, the curve and what their score pays - blended with their latest
    review exactly as a run would, so the two never disagree. Never anyone's pay."""
    p = plan_for(db, role_id) if role_id else None
    if p is None or not p.active:
        return None
    rs = review_score(db, email, on) if email and on and score is not None and (p.review_weight or 0) > 0 else None
    blended = round(score * (1 - p.review_weight / 100) + rs * p.review_weight / 100, 1) if rs is not None else None
    return {"targetPct": p.target_pct, "period": p.period, "thresholdScore": p.threshold_score, "payoutAtThreshold": p.payout_at_threshold,
            "maxPayout": p.max_payout, "reviewWeight": p.review_weight or 0, "reviewScore": rs, "blendedScore": blended,
            "payoutPct": payout_pct(p, blended if blended is not None else score, over)}


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
            "review_weight": _pct(body.get("reviewWeight", 0), "Review weight", 0, 100),
            "period": period, "active": 1 if body.get("active", True) else 0,
            "updated_by": (user.get("email") or "").lower(), "updated_at": _now()}
    p = plan_for(db, role.id)
    if p is None:
        p = models.PerfBonusPlan(id=str(uuid.uuid4()), company_id=company_id, role_id=role.id, created_at=_now())
        db.add(p)
    for k, v in vals.items():
        setattr(p, k, v)
    db.flush()
    snap = {k: vals[k] for k in ("target_pct", "period", "threshold_score", "payout_at_threshold", "max_payout", "adjust_max", "review_weight", "active")}
    db.add(models.PerfBonusPlanLog(id=str(uuid.uuid4()), plan_id=p.id, snapshot=snap, changed_by=vals["updated_by"], changed_at=vals["updated_at"]))
    db.flush()
    return p


def review_score(db, email: str, on: str):
    """The person's latest completed review rating as 0..100 (REVIEW_SCORES),
    completed on or before `on` and within a year of it; None = no review."""
    rows = (db.query(models.PerfReview).filter(models.PerfReview.employee_email == email, models.PerfReview.stage == "complete",
                                               models.PerfReview.completed_at != "", models.PerfReview.completed_at <= on + "T99")
            .order_by(models.PerfReview.completed_at.desc()).all())
    floor = (date.fromisoformat(on) - timedelta(days=365)).isoformat()
    for r in rows:
        if r.completed_at[:10] < floor:
            break
        if (r.rating or "") in REVIEW_SCORES:
            return REVIEW_SCORES[r.rating]
    return None


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
def _base_pay(db, email: str, n_months: int, start: str = "", end: str = "") -> tuple:
    """(base pay for the period, currency, note) from the person's pay rate."""
    rr = db.query(models.PayrollRate).filter(models.PayrollRate.employee_email == email).first()
    if rr is None:
        return 0.0, "USD", "no_pay_rate"
    cur = (rr.currency or "USD")
    if (rr.pay_type or "hourly") == "fixed":
        return round((rr.monthly_salary or 0) * n_months, 2), cur, ""
    paid = period_pay(db, email, start, end)
    if paid is not None and paid > 0:
        return round(paid, 2), cur, "hourly_paid"
    return round((rr.hourly_rate or 0) * HOURS_PER_MONTH * n_months, 2), cur, "hourly_standard_month"


def period_pay(db, email: str, start: str, end: str):
    """What the Time Sheet paid an hourly person over the period (regular, OT,
    holiday and leave pay - the totals the Time Sheet prints); None when the
    card cannot be read."""
    try:
        from routers.timeclock import _compute_timecard
        return float((_compute_timecard(db, email, start, end).get("totals") or {}).get("totalPay") or 0)
    except Exception:   # noqa: BLE001 - a card that cannot be built falls back to the standard month
        return None


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
        base, cur, note = _base_pay(db, em, len(months), start, end)
        notes = [note] if note else []                               # the line's notes, comma-joined: how it was priced and what it lacks
        if score is not None and measured < MIN_MEASURED:
            score = None                                             # kept on the line's months_scored; the flag says why
            notes.append("thin_data")
        kpi_score, rs = score, None
        if score is not None and (plan.review_weight or 0) > 0:
            rs = review_score(db, em, end)
            if rs is None:
                notes.append("no_review")                            # the KPI score alone; the line says so
            else:
                w = plan.review_weight / 100
                score = round(kpi_score * (1 - w) + rs * w, 1)
        line = models.PerfBonusLine(id=str(uuid.uuid4()), run_id=run.id, email=em, role_id=role.id, role_name=role.name,
                                    department=emp.department or "", manager_email=(emp.manager_email or "").lower(),
                                    score=score, kpi_score=kpi_score, review_score=rs, over_target=over, measured_weight=measured, months_scored=len(with_score),
                                    payout_pct=payout_pct(plan, score, over), base_pay=base, currency=cur, target_pct=plan.target_pct,
                                    adjust_max=plan.adjust_max, note=",".join(notes), adjust_pct=0.0, adjust_reason="", excluded=0)
        _line_amounts(line)
        db.add(line)
        n += 1
    run.line_count = n
    db.flush()
    _tell_managers(db, run)
    return run


def _tell_managers(db, run) -> None:
    """One bell per manager with people on the run: look it over before HR approves."""
    import notify_rollup
    by: dict = {}
    for ln in lines_of(db, run):
        if ln.manager_email:
            by.setdefault(ln.manager_email, []).append(ln)
    for mgr, ls in by.items():
        who = perf.name_of(db, ls[0].email) if len(ls) == 1 else f"{len(ls)} of your people"
        notify_rollup.upsert_rollup(
            db, recipient=mgr, key=f"perf-bonus-review:{run.id}", title="Bonus Review Open",
            line=(f"The {_label(run.period)} bonus run is in review with {who} on it. Look over the scores and "
                  f"payouts in My Team - adjust within the plan's bound with a reason, or mark them Looks Right - before HR approves."),
            action={"view": "myhr", "sub": "performance:team"}, company=run.company_id or "", replace=True)


def lines_of(db, run) -> list:
    return (db.query(models.PerfBonusLine).filter(models.PerfBonusLine.run_id == run.id)
            .order_by(models.PerfBonusLine.manager_email, models.PerfBonusLine.email).all())


def line_out(db, ln, money: bool) -> dict:
    out = {"id": ln.id, "email": ln.email, "name": perf.name_of(db, ln.email), "roleName": ln.role_name, "department": ln.department,
           "manager": ln.manager_email, "managerName": perf.name_of(db, ln.manager_email) if ln.manager_email else "",
           "score": ln.score, "overTarget": ln.over_target, "measuredWeight": ln.measured_weight, "monthsScored": ln.months_scored,
           "payoutPct": ln.payout_pct, "targetPct": ln.target_pct, "adjustPct": ln.adjust_pct, "adjustMax": ln.adjust_max,
           "adjustReason": ln.adjust_reason or "", "adjustedBy": ln.adjusted_by or "", "adjustedByName": perf.name_of(db, ln.adjusted_by) if ln.adjusted_by else "",
           "excluded": bool(ln.excluded), "note": ln.note or "", "paid": bool(ln.bonus_id),
           "kpiScore": ln.kpi_score, "reviewScore": ln.review_score,
           "reviewedBy": ln.reviewed_by or "", "reviewedByName": perf.name_of(db, ln.reviewed_by) if ln.reviewed_by else "", "reviewedAt": ln.reviewed_at or ""}
    if money:
        out.update({"basePay": ln.base_pay, "currency": ln.currency, "computedAmount": ln.computed_amount, "finalAmount": ln.final_amount})
    return out


def run_out(db, run, money: bool, with_lines: bool = True) -> dict:
    out = {"id": run.id, "companyId": run.company_id, "period": run.period, "label": _label(run.period), "periodStart": run.period_start,
           "periodEnd": run.period_end, "status": run.status, "lineCount": run.line_count, "createdBy": run.created_by, "createdAt": run.created_at,
           "approvedBy": run.approved_by or "", "approvedAt": run.approved_at or "", "paidAt": run.paid_at or "", "notes": run.notes or "",
           "budget": run.budget}
    if with_lines:
        rows = lines_of(db, run)
        out["lines"] = [line_out(db, ln, money) for ln in rows]
        live = [ln for ln in rows if not ln.excluded]
        out["reviewed"] = sum(1 for ln in live if ln.reviewed_at)
        pending = sorted({ln.manager_email for ln in live if ln.manager_email and not ln.reviewed_at})
        out["managersPending"] = [{"email": m, "name": perf.name_of(db, m)} for m in pending]
        if money:
            out["total"] = round(sum(ln.final_amount for ln in live), 2)
            out["overBudget"] = bool(run.budget and out["total"] > run.budget)
        out["fairness"] = fairness(db, rows)
    return out


def set_budget(db, run, budget, notes=None) -> None:
    """HR's pool for the run - the total over it is flagged, never blocked."""
    if run.status in ("paid", "cancelled"):
        raise HTTPException(409, "This run is closed")
    if budget is not None:
        run.budget = None if budget == "" else _pct(budget, "Budget", 0, 1e9)
    if notes is not None:
        run.notes = (notes or "").strip()


def mark_reviewed(db, user: dict, run, emails=None) -> int:
    """A manager says their people's lines look right (all of their people on
    the run, or the emails given); the line keeps who and when."""
    if run.status != "review":
        raise HTTPException(409, "This run is no longer in review")
    me = (user.get("email") or "").lower()
    want = {(e or "").lower() for e in (emails or [])}
    n = 0
    for ln in lines_of(db, run):
        if want and ln.email not in want:
            continue
        if ln.email == me or not perf.is_above(db, me, ln.email):
            continue
        ln.reviewed_by, ln.reviewed_at = me, _now()
        n += 1
    if not n:
        raise HTTPException(403, "None of these people report to you")
    db.flush()
    return n


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
    before_by, before_pct = line.adjusted_by or "", line.adjust_pct or 0
    line.adjust_pct, line.adjust_reason, line.adjusted_by, line.adjusted_at = a, reason.strip(), me, _now()
    if perf.is_above(db, me, line.email):
        line.reviewed_by, line.reviewed_at = me, _now()                 # a manager's adjustment is their review
    _line_amounts(line)
    db.flush()
    if hr and before_by and before_by != me and (before_pct != a or excluded is not None):
        import notify_rollup
        what = "excluded them from the run" if line.excluded else f"set the adjustment to {a:+g}% (you had {before_pct:+g}%)"
        notify_rollup.upsert_rollup(
            db, recipient=before_by, key=f"perf-bonus-override:{line.id}", title="Your Bonus Adjustment Was Changed",
            line=f'HR {what} for {perf.name_of(db, line.email)} on the {_label(run.period)} bonus run: "{reason.strip()}"',
            action={"view": "myhr", "sub": "performance:team"}, company=run.company_id or "", replace=True)
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
            if any("thin_data" in (ln.note or "") for ln in ls):
                flags.append("thin data")
            if any("no_review" in (ln.note or "") for ln in ls):
                flags.append("no review on file")
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


# ── ratings missing ─────────────────────────────────────────────────────────
def missing_ratings(db, emails: list, months: list) -> list:
    """Manual KPIs with no rating for the people and months given - what a
    run would have to score without."""
    out = []
    for em in emails:
        role = sc.role_of_person(db, em)
        if not role:
            continue
        emp = perf.employee(db, em)
        for m in months:
            version = sc.active_for(db, role.id, date.fromisoformat(f"{m}-01"))
            if not version:
                continue
            lib = sc.library_map(db, (emp.company if emp else "") or version.company_id)
            rated = ps.ratings_for(db, em, m)
            for it in sc.items_of(db, version):
                k = lib.get(it["kpi"])
                if k and k["source"] == "manual" and it["kpi"] not in rated:
                    out.append({"email": em, "name": perf.name_of(db, em), "manager": (emp.manager_email or "").lower() if emp else "",
                                "kpi": it["kpi"], "kpiName": k["name"], "month": m, "weight": it["weight"]})
    return out


def eligible(db, company_id: str, kind: str) -> list:
    """Active people of the company on a role with an active plan of that cadence, once each."""
    out, seen = [], set()
    for emp in db.query(models.NexusEmployee).filter(models.NexusEmployee.company == company_id).all():
        em = (emp.work_email or "").lower()
        if not perf._active(emp) or not em or em in seen:
            continue
        seen.add(em)
        role = sc.role_of_person(db, em)
        plan = plan_for(db, role.id) if role else None
        if plan and plan.active and plan.period == kind:
            out.append(em)
    return out


def readiness(db, company_id: str, period: str) -> dict:
    """Before HR starts a run: who would be on it and which manual KPIs are
    still unrated (each one shrinks the measured weight, or makes thin data)."""
    months = period_months(period)
    people = eligible(db, company_id, period_kind(period))
    missing = missing_ratings(db, people, months)
    for row in missing:
        row["managerName"] = perf.name_of(db, row["manager"]) if row["manager"] else ""
    return {"period": period.strip().upper(), "people": len(people), "missing": missing}


def rating_reminders(db, today: date | None = None) -> int:
    """From REMIND_FROM_DAY each month: one bell per manager listing the manual
    KPIs of their direct reports still unrated this month, rewritten in place
    daily until they are. Only people on a role with an active bonus plan."""
    import notify_rollup
    today = today or date.today()
    if today.day < REMIND_FROM_DAY:
        return 0
    period = today.strftime("%Y-%m")
    by: dict = {}
    for plan in db.query(models.PerfBonusPlan).filter(models.PerfBonusPlan.active == 1).all():
        for mbr in db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == plan.role_id).all():
            em = (mbr.email or "").lower()
            emp = perf.employee(db, em)
            if emp is None or not perf._active(emp) or not (emp.manager_email or "").strip():
                continue
            by.setdefault((emp.manager_email or "").lower(), set()).add(em)
    sent = 0
    for mgr, ems in by.items():
        missing = missing_ratings(db, sorted(ems), [period])
        if not missing:
            continue
        names = sorted({m["name"] for m in missing})
        one = len(missing) == 1
        line = (f"{len(missing)} manual KPI {'rating is' if one else 'ratings are'} still missing for {_month_label(period)}: "
                f"{', '.join(names[:5])}{' and more' if len(names) > 5 else ''}. An unrated KPI is left out of the score, so rate them before the month ends.")
        notify_rollup.upsert_rollup(db, recipient=mgr, key=f"perf-ratings-due:{period}", title="Rate Your Team's Manual KPIs",
                                    line=line, action={"view": "myhr", "sub": "performance:team"}, replace=True, quiet=True)
        sent += 1
    return sent
