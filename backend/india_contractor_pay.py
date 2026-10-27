"""India Contractor Work Hours and Extra Time Policy (Neil, Oct 27 2026).

The policy, the exact algorithm and the worked example are in
docs/India-Contractor-Pay.md. NEVER change these numbers without Neil.

Who: a contractor (NexusEmployee.employment_type == 'contractor') on FIXED
monthly pay who works in India (their People country, else their company's;
an INR pay rate when neither is known), at a company whose Settings > Pay >
India Contractor Policy switch is on (on by default for an India company),
for a month that starts on or after the company's Policy Starts date
(default 11/01/2026 - October and earlier keep the old rules). Everyone
else keeps _fixed_card's rules exactly.

The month (routers/timeclock._fixed_card calls price_month):
  * A SCHEDULED WORKDAY is Monday - Friday, not a full company holiday on the
    person's calendar. Only days that are over count; today and later never
    deduct.
  * DAILY CREDIT from hours actually worked h (leave minutes excluded):
    h >= 8 -> full; 4 <= h < 8 -> half; h < 4 -> none. More than 9 hours
    earns nothing more by itself.
  * PAID LEAVE (a Sick / Vacation entry on a scheduled day) fills the day's
    missing halves from the person's paid balance (leave_balances), half a
    day (hoursPerDay / 2 hours) at a time, as far as the balance goes.
    Personal / unpaid leave and any absence stay missing.
  * THE POOL (reading B): per scheduled day, full -> h - 9 (never below 0),
    half -> h - 4, none -> h; a half-day holiday -> h - 4.5; a non-scheduled
    day (weekend, full holiday) -> h. Hours paid as approved Extra Time are
    taken out (never counted twice); pending, declined and unclaimed hours
    stay in.
  * RECOVERY: M = missing half-days. Each recovered half-day costs 4.5 pool
    hours: R = min(M, pool // 4.5h); remainder r = pool - 4.5h x R; if R < M
    and r >= 1.5 h, R += 1 (the round-up). Recovered halves go to the missing
    days in date order (earliest first), so each day still unpaid keeps its
    own day's rate (a mid-month raise stays right). Regular credits never
    exceed the scheduled days; pool hours left after that earn nothing.
  * PAY = the monthly base (unchanged: salary in effect / days in month, per
    day) - unpaid halves x that day's daily / 2 + approved Extra Time, where
    Extra Time = approved hours x (that day's daily / 9) x 1.35, no floor.

Everything here is a pure function of its inputs except price_month (reads
the claims and the leave balance) and the settings readers.
"""
from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy.orm import Session

import models
import scoped_settings

POLICY_VERSION = "india-contractor-2026-11-v1"

SETTING_KEY = "timeclock_india_contractor"
DEFAULT_START = "2026-11-01"
# mode: '' = the default (on for an India company - or one with no country,
# where each person's own country decides), 'on', 'off'.
DEFAULTS = {"mode": "", "startDate": DEFAULT_START}
MODES = ("on", "off")

SCHEDULED_MIN = 9 * 60          # the scheduled day
FULL_CREDIT_MIN = 8 * 60        # a full day's credit from hours worked
HALF_CREDIT_MIN = 4 * 60        # a half day's credit
HALF_DAY_COST_MIN = 270         # 4.5 pool hours buy back one missing half day
ROUND_UP_MIN = 90               # a remainder of 1.5 h or more rounds up to a half day
HALF_HOLIDAY_POOL_FROM_MIN = 270  # on a half-day holiday only hours past 4.5 go to the pool
EXTRA_TIME_MULT = 1.35          # x the hourly equivalent (daily / 9)
HOURS_PER_DAY = 9               # the hourly equivalent's divisor

CONSTANTS = {"scheduledMin": SCHEDULED_MIN, "fullCreditMin": FULL_CREDIT_MIN, "halfCreditMin": HALF_CREDIT_MIN,
             "halfDayCostMin": HALF_DAY_COST_MIN, "roundUpMin": ROUND_UP_MIN,
             "halfHolidayPoolFromMin": HALF_HOLIDAY_POOL_FROM_MIN, "extraTimeMultiplier": EXTRA_TIME_MULT,
             "hoursPerDay": HOURS_PER_DAY}

PAID_LEAVE = {"sick": "sick", "vacation": "vacation"}   # leave class -> balance bucket; personal is unpaid


# ── Settings ──────────────────────────────────────────────────────────────────

def _valid_day(v) -> str:
    try:
        return date.fromisoformat(str(v or "")[:10]).isoformat()
    except ValueError:
        return ""


def config(db: Session, company_id: str = "") -> dict:
    """{mode, startDate} for the tenant ('' company) or one company:
    defaults <- tenant row <- company override (scoped_settings)."""
    cfg = scoped_settings.get(db, SETTING_KEY, DEFAULTS, company_id)
    mode = str(cfg.get("mode") or "").strip().lower()
    return {"mode": mode if mode in MODES else "", "startDate": _valid_day(cfg.get("startDate")) or DEFAULT_START}


def company_country(db: Session, company_id: str) -> str:
    if not company_id:
        return ""
    row = db.query(models.HrEntity.country).filter(models.HrEntity.id == company_id).first()
    return ((row[0] if row else "") or "").strip().upper()


def enabled_for_company(db: Session, company_id: str, cfg: dict | None = None) -> bool:
    """The switch as it stands for one company: saved on / off, else on for
    an India company and for one with no country (each person's own country
    then decides), off for a company in any other country."""
    cfg = cfg or config(db, company_id)
    if cfg["mode"]:
        return cfg["mode"] == "on"
    return company_country(db, company_id) in ("IN", "")


def works_in_india(db: Session, em: str, emp=None, rate_row=None) -> bool:
    """The person's People country, else their company's (ca_breaks.country_of);
    with neither known, an INR pay rate."""
    import ca_breaks
    country = ca_breaks.country_of(db, em, emp) if emp is not None else ca_breaks.country_of(db, em)
    if country:
        return country == "IN"
    return ((getattr(rate_row, "currency", "") or "") if rate_row is not None else "").strip().upper() == "INR"


def scope(db: Session, em: str, rate_row, month_start: str, emp=None) -> dict | None:
    """The policy's terms for this person's month, or None when it does not
    apply (then _fixed_card keeps the old rules exactly). Fixed pay is the
    caller's check (_fixed_card is only ever the fixed card)."""
    if rate_row is None or (getattr(rate_row, "pay_type", None) or "hourly") != "fixed":
        return None
    if emp is None:
        emp = (db.query(models.NexusEmployee)
               .filter(models.NexusEmployee.work_email == (em or "").lower()).first())
    if emp is None or (getattr(emp, "employment_type", "") or "") != "contractor":
        return None
    company = getattr(emp, "company", "") or ""
    cfg = config(db, company)
    if not enabled_for_company(db, company, cfg):
        return None
    if (month_start or "") < cfg["startDate"]:
        return None
    if not works_in_india(db, em, emp, rate_row):
        return None
    return {"applies": True, "version": POLICY_VERSION, "startDate": cfg["startDate"],
            "company": company, "constants": dict(CONSTANTS)}


# ── The month, as pure arithmetic ─────────────────────────────────────────────

def work_halves(worked_min: int) -> int:
    """Daily credit in half days from hours actually worked: 2 / 1 / 0."""
    w = max(0, int(worked_min or 0))
    return 2 if w >= FULL_CREDIT_MIN else 1 if w >= HALF_CREDIT_MIN else 0


def claimable_min(kind: str, state: str, worked_min: int) -> int:
    """The most Extra Time one day can be claimed for: every hour worked on a
    weekend or a full holiday; on a scheduled weekday only the hours past 9
    (past 4.5 on a half-day holiday - the pool's own line). Nothing for a
    day that has not happened."""
    if state == "future":
        return 0
    w = max(0, int(worked_min or 0))
    if kind in ("weekend", "holiday"):
        return w
    if kind == "half_holiday":
        return max(0, w - HALF_HOLIDAY_POOL_FROM_MIN)
    return max(0, w - SCHEDULED_MIN)


def reconcile(days: list) -> dict:
    """The month-end reconciliation. `days`, in date order:
        {date, kind: scheduled | half_holiday | holiday | weekend,
         state: past | today | future, workedMin (leave excluded),
         dailyRate, approvedExtraMin, coveredHalves (paid leave, scheduled
         only), open (a punch still running - half-day holiday only)}
    Returns {days: [...], totals: {...}}; money unrounded per day, the
    totals' money rounded to 2 places."""
    out = []
    pool = missing = earned = leave_halves = 0
    scheduled = upcoming = extra_total = 0
    extra_pay = 0.0
    for d in days:
        kind, state = d["kind"], d.get("state") or "past"
        w = max(0, int(d.get("workedMin") or 0))
        rate = float(d.get("dailyRate") or 0)
        covered = 0
        halves = miss = 0
        credit = ""
        if kind == "scheduled":
            scheduled += 1
            c = work_halves(w)
            covered = min(2 - c, max(0, int(d.get("coveredHalves") or 0)))
            if state == "past" or c + covered == 2:
                halves = c + covered
                miss = 2 - halves
                credit = "full" if halves == 2 else "half" if halves == 1 else "none"
            else:
                # Today or later and not yet a full day: never deducted before it is over.
                credit = "pending"
                upcoming += 1
            # Reading B: what the hours did not earn goes to the pool.
            contrib = max(0, w - SCHEDULED_MIN) if c == 2 else (w - HALF_CREDIT_MIN) if c == 1 else w
            if state != "past" and credit == "pending":
                contrib = max(0, w - SCHEDULED_MIN)
        elif kind == "half_holiday":
            scheduled += 1
            if w > 0 or d.get("open"):
                halves, credit = 2, "full"          # worked their half - the whole day (today's rule)
            elif state == "past":
                halves, miss, credit = 1, 1, "half"  # the holiday half only
            else:
                credit = "pending"
                upcoming += 1
            contrib = max(0, w - HALF_HOLIDAY_POOL_FROM_MIN)
        elif kind == "holiday":
            credit, contrib = "holiday", w
        else:
            credit, contrib = "", w
        earned += halves
        leave_halves += covered if credit != "pending" else 0
        claim_max = claimable_min(kind, state, w)
        extra = min(max(0, int(d.get("approvedExtraMin") or 0)), claim_max)
        contrib = max(0, contrib - extra)
        pool += contrib
        missing += miss
        day_extra_pay = extra / 60.0 * rate / HOURS_PER_DAY * EXTRA_TIME_MULT if extra else 0.0
        extra_total += extra
        extra_pay += day_extra_pay
        out.append({"date": d["date"], "kind": kind, "state": state, "credit": credit, "creditHalves": halves,
                    "leaveHalves": covered, "missingHalves": miss, "poolMin": contrib, "claimableMin": claim_max,
                    "extraMin": extra, "extraPay": day_extra_pay, "recoveredHalves": 0, "unpaidHalves": miss,
                    "deduct": miss * rate / 2.0, "dailyRate": rate})

    available = pool // HALF_DAY_COST_MIN
    recovered = min(missing, available)
    remainder = pool - recovered * HALF_DAY_COST_MIN
    rounded_up = recovered < missing and remainder >= ROUND_UP_MIN
    if rounded_up:
        recovered += 1
    left = recovered
    deduction = 0.0
    unpaid = 0
    for od in out:
        if od["missingHalves"]:
            rec = min(od["missingHalves"], left)
            left -= rec
            od["recoveredHalves"] = rec
            od["unpaidHalves"] = od["missingHalves"] - rec
            od["deduct"] = od["unpaidHalves"] * od["dailyRate"] / 2.0
            unpaid += od["unpaidHalves"]
        deduction += od["deduct"]
    used = min(pool, recovered * HALF_DAY_COST_MIN)
    totals = {
        "scheduledDays": scheduled,
        "earnedHalves": earned,                 # from hours worked and paid leave
        "leaveHalves": leave_halves,            # of those, from the paid balance
        "upcomingDays": upcoming,               # not over yet - never deducted
        "missingHalves": missing,
        "poolMin": pool,
        "poolHalvesAvailable": available,       # whole 4.5 h blocks in the pool
        "remainderMin": remainder,              # what was left after those blocks
        "roundedUp": rounded_up,                # the 1.5 h round-up applied
        "recoveredHalves": recovered,
        "unpaidHalves": unpaid,
        "poolUsedMin": used,
        "poolUnusedMin": pool - used,           # earns nothing
        "paidDays": scheduled - unpaid / 2.0,   # never more than the scheduled days
        "extraTimeMin": extra_total,
        "extraTimePay": round(extra_pay, 2),
        "deduction": round(deduction, 2),
    }
    return {"days": out, "totals": totals}


# ── The month, from the card ──────────────────────────────────────────────────

def live_claims(db: Session, em: str, start: str, end: str) -> dict:
    """{date: ExtraTimeClaim} - the live (not withdrawn) claim of each day."""
    rows = (db.query(models.ExtraTimeClaim)
            .filter(models.ExtraTimeClaim.employee_email == (em or "").lower(),
                    models.ExtraTimeClaim.local_date >= start, models.ExtraTimeClaim.local_date <= end,
                    models.ExtraTimeClaim.status != "withdrawn")
            .order_by(models.ExtraTimeClaim.created_at.asc()).all())
    return {r.local_date: r for r in rows}


def claim_dict(r) -> dict:
    return {"id": r.id, "date": r.local_date, "status": r.status, "claimedMin": int(r.claimed_min or 0),
            "approvedMin": int(r.approved_min or 0) if r.status == "approved" else 0,
            "note": r.note or "", "decisionNote": r.decision_note or "", "decidedBy": r.decided_by or "",
            "decidedAt": r.decided_at or "", "createdAt": r.created_at or "", "updatedAt": r.updated_at or ""}


def _balance_halves(db: Session, em: str, needed: bool) -> tuple:
    """({bucket: half days available}, hours per day) from leave_balances -
    nothing at all until HR's cutover makes balances live."""
    if not needed:
        return {"vacation": 0, "sick": 0}, 8.0
    import leave_balances
    try:
        b = leave_balances.balances(db, em)
    except Exception as e:   # noqa: BLE001 - a balance problem must not break the card
        print(f"[india-contractor] balance read failed for {em}: {type(e).__name__}: {e}")
        return {"vacation": 0, "sick": 0}, 8.0
    hpd = float((b.get("policy") or {}).get("hoursPerDay") or 8) or 8.0
    if not b.get("live"):
        return {"vacation": 0, "sick": 0}, hpd
    half = hpd / 2.0
    out = {}
    for bucket in ("vacation", "sick"):
        avail = float((b.get(bucket) or {}).get("available") or 0)
        out[bucket] = max(0, int((avail + 1e-6) // half))
    return out, hpd


def price_month(db: Session, em: str, *, first: date, days_in_month: int, today: str,
                worked_by_day: dict, leave_by_day: dict, leave_min_by_day: dict, open_by_day: dict,
                holidays: dict, daily_on) -> dict:
    """Builds reconcile()'s input from the card's own day facts (the same
    dicts _fixed_card works from), runs it, and attaches each day's claim.
    Returns {days: {date: {...}}, totals, claims: {date: claim_dict}}."""
    end = (first + timedelta(days=days_in_month - 1)).isoformat()
    claims = live_claims(db, em, first.isoformat(), end)
    approved = {ds: int(c.approved_min or 0) for ds, c in claims.items() if c.status == "approved"}
    dates = [(first + timedelta(days=i)) for i in range(days_in_month)]
    need_balance = any(dd.weekday() < 5 and leave_by_day.get(dd.isoformat()) in PAID_LEAVE
                       and not holidays.get(dd.isoformat()) for dd in dates)
    halves_left, hpd = _balance_halves(db, em, need_balance)
    inputs, leave_meta = [], {}
    for dd in dates:
        ds = dd.isoformat()
        work = max(0, int(worked_by_day.get(ds, 0) or 0) - int(leave_min_by_day.get(ds, 0) or 0))
        state = "past" if ds < today else "today" if ds == today else "future"
        hol = holidays.get(ds)
        if dd.weekday() >= 5:
            kind = "weekend"
        elif hol and hol.get("type") == "half_day":
            kind = "half_holiday"
        elif hol:
            kind = "holiday"
        else:
            kind = "scheduled"
        covered = 0
        cls = leave_by_day.get(ds, "")
        if kind == "scheduled" and cls in PAID_LEAVE:
            bucket = PAID_LEAVE[cls]
            need = 2 - work_halves(work)
            covered = min(need, halves_left.get(bucket, 0))
            halves_left[bucket] = halves_left.get(bucket, 0) - covered
            leave_meta[ds] = {"bucket": bucket, "coveredHalves": covered,
                              "usedMin": int(round(covered * hpd * 30)), "paidLeave": True}
        elif kind == "scheduled" and cls:
            leave_meta[ds] = {"bucket": "", "coveredHalves": 0, "usedMin": 0, "paidLeave": False}
        inputs.append({"date": ds, "kind": kind, "state": state, "workedMin": work, "dailyRate": daily_on(ds),
                       "approvedExtraMin": approved.get(ds, 0), "coveredHalves": covered,
                       "open": bool(open_by_day.get(ds))})
    result = reconcile(inputs)
    days = {}
    for od in result["days"]:
        lm = leave_meta.get(od["date"])
        if lm:
            od.update({"leaveBucket": lm["bucket"], "leaveUsedMin": lm["usedMin"], "paidLeave": lm["paidLeave"]})
        days[od["date"]] = od
    return {"days": days, "totals": result["totals"], "claims": {ds: claim_dict(c) for ds, c in claims.items()}}


def snapshot(card: dict) -> dict:
    """What finalize freezes (the policy version, the full reconciliation and
    every day's numbers) so a finalized month never re-prices."""
    ip = card.get("indiaPolicy") or {}
    keep = ("kind", "state", "credit", "creditHalves", "leaveHalves", "missingHalves", "poolMin", "claimableMin",
            "extraMin", "extraPay", "recoveredHalves", "unpaidHalves", "deduct", "dailyRate", "status",
            "leaveBucket", "leaveUsedMin", "paidLeave")
    days = {fd["date"]: {k: fd.get(k) for k in keep if k in fd} for fd in card.get("fixedDays") or []
            if fd.get("credit") is not None}
    return {"version": ip.get("version", POLICY_VERSION), "startDate": ip.get("startDate", ""),
            "constants": ip.get("constants", dict(CONSTANTS)), "reconciliation": ip.get("reconciliation", {}),
            "salaryForPeriod": (card.get("totals") or {}).get("salaryForPeriod"), "days": days}
