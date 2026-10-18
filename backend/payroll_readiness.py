"""Payroll Readiness (Neil, Oct 17 2026) - People > Time > Payroll.

Before payroll runs, one check over a pay period answers "who is not ready,
and what looks off". Per person in the caller's scope:

  1. Readiness exceptions (any one of these = Not Ready):
       - the Time Sheet is not approved by the manager (timesheet_review: no
         review, "with_manager", "with_employee", or HR unlocked it);
       - it is approved but the employee has not signed it ("approved" /
         "signing" - only the employee signs, Oct 16);
       - missing punches (timeclock._period_exceptions, the same blocking
         exceptions approve/finalize check; a shift still running is not
         missing its clock-out - list_exceptions' rule);
       - punch-fix requests or punch edits waiting on a decision
         (timeclock._pending_fixes);
       - no pay rate on file (the card's own rateSet / rate / monthly salary).
     Punches out of location are reported as a note, never Not Ready: there
     is no acknowledge step for them in Nexus, the manager sets the site on
     the Time Sheet instead.
     Approval and signature are judged only once the period is over for the
     person (approve_blocker's gate) - before that nobody can approve.
  2. Variance: hours, overtime, leave and gross pay against the previous
     period, and hours against the expected hours (workforce_scorecard.
     expected_for_day - the ONE expectation rule: published shift > preset >
     country standard; holidays and approved time off excuse the day).
     Flagged when the change is over `varianceHours`, or over `variancePct`
     (a change under one hour never counts as a percentage jump).
  3. Anomalies (rule-based, each with a one-line reason): a week of this
     period far from the person's own trailing 8-week average (`anomalyPct`
     / `anomalyHours`, needs 3 weeks of history), overtime up by more than
     `otJumpHours` on the previous period, `missingOutCount`+ missing
     clock-outs in the period.

Every figure is read off the timecard engine (timesheet_review.card_for ->
timeclock._compute_timecard / _fixed_card); nothing here re-adds hours or
re-prices pay. Hourly people use the bi-weekly pay period, salaried people the
latest calendar month that has ended by the period's last day (their pay is
monthly). Weekly anomalies and the schedule comparison are hourly only.

Thresholds are stored per company like the Shifts settings: defaults <- the
tenant row (`payroll_readiness_config`) <- a sparse company override
(`payroll_readiness_config:<company id>`).
"""
from __future__ import annotations

import json
import threading
import time
from datetime import date, datetime, timedelta, timezone

from sqlalchemy.orm import Session

import models

SETTINGS_KEY = "payroll_readiness_config"
DEFAULTS = {"variancePct": 25, "varianceHours": 8, "anomalyPct": 40, "anomalyHours": 10,
            "otJumpHours": 4, "missingOutCount": 2}
LIMITS = {"variancePct": (1, 500), "varianceHours": (1, 200), "anomalyPct": (1, 500),
          "anomalyHours": (1, 200), "otJumpHours": (1, 200), "missingOutCount": (1, 31)}
HISTORY_WEEKS = 8
MIN_HISTORY_WEEKS = 3
PCT_FLOOR_MIN = 60          # a change under an hour is never a "percentage jump"
CACHE_TTL_SEC = 120


def _tc():
    from routers import timeclock
    return timeclock


def _tsr():
    import timesheet_review
    return timesheet_review


# ── Settings ──────────────────────────────────────────────────────────────

def _key(company_id: str = "") -> str:
    return f"{SETTINGS_KEY}:{company_id}" if company_id else SETTINGS_KEY


def clean(patch: dict) -> dict:
    """The usable keys of `patch`, clamped to their limits; unknown keys and
    non-numbers are dropped."""
    out = {}
    for k, (lo, hi) in LIMITS.items():
        if k not in (patch or {}):
            continue
        try:
            v = float(patch[k])
        except (TypeError, ValueError):
            continue
        if v != v:    # NaN
            continue
        out[k] = max(lo, min(hi, int(round(v))))
    return out


def _saved(db: Session, company_id: str = "") -> dict:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _key(company_id)).first()
    if not row or not row.value:
        return {}
    try:
        v = json.loads(row.value)
    except (TypeError, ValueError):
        return {}
    return clean(v) if isinstance(v, dict) else {}


def get_settings(db: Session, company_id: str = "") -> dict:
    """defaults <- tenant row <- that company's override."""
    cfg = dict(DEFAULTS)
    cfg.update(_saved(db))
    if company_id:
        cfg.update(_saved(db, company_id))
    return cfg


def has_override(db: Session, company_id: str) -> bool:
    return bool(company_id) and bool(_saved(db, company_id))


def save_settings(db: Session, company_id: str, patch: dict, actor: str, reset: bool = False) -> dict:
    """Store `patch` as the tenant row (company '') or a company's override.
    A company override keeps only the keys that differ from the tenant's, so
    a later tenant change still reaches it. `reset` drops the override."""
    key = _key(company_id)
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == key).first()
    if reset and company_id:
        if row:
            db.delete(row)
        db.commit()
        clear_cache()
        return get_settings(db, company_id)
    vals = {**_saved(db, company_id), **clean(patch)}
    if company_id:
        tenant = get_settings(db)
        vals = {k: v for k, v in vals.items() if tenant.get(k) != v}
    if not row:
        row = models.NexusSetting(key=key)
        db.add(row)
    row.value = json.dumps(vals)
    if hasattr(row, "updated_by"):
        row.updated_by = actor
    if hasattr(row, "updated_at"):
        row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    clear_cache()
    return get_settings(db, company_id)


# ── Periods ───────────────────────────────────────────────────────────────

def _d(iso: str) -> date:
    return date.fromisoformat(iso)


def default_anchor(today: date | None = None) -> str:
    """A date in the last bi-weekly pay period that is over."""
    tc = _tc()
    today = today or datetime.now(timezone.utc).date()
    s, _e = tc._pay_period(today.isoformat())
    return (_d(s) - timedelta(days=1)).isoformat()


def closed_month(end_iso: str) -> tuple:
    """The latest calendar month whose last day is on or before `end_iso`."""
    tc = _tc()
    ms, me = tc._month_bounds(end_iso)
    if me > end_iso:
        ms, me = tc._month_bounds((_d(ms) - timedelta(days=1)).isoformat())
    return ms, me


def periods(anchor: str) -> dict:
    tc = _tc()
    s, e = tc._pay_period(anchor)
    ps, pe = tc._pay_period((_d(s) - timedelta(days=1)).isoformat())
    ms, me = closed_month(e)
    pms, pme = tc._month_bounds((_d(ms) - timedelta(days=1)).isoformat())
    return {"start": s, "end": e, "prevStart": ps, "prevEnd": pe,
            "monthStart": ms, "monthEnd": me, "prevMonthStart": pms, "prevMonthEnd": pme}


# ── Wording ───────────────────────────────────────────────────────────────

def us_date(iso: str) -> str:
    try:
        return datetime.strptime(iso[:10], "%Y-%m-%d").strftime("%m/%d/%Y")
    except (TypeError, ValueError):
        return iso or ""


def hrs(minutes) -> str:
    return f"{(minutes or 0) / 60:.1f}h"


def money(v, currency: str = "USD") -> str:
    v = float(v or 0)
    cur = (currency or "USD").upper()
    return f"${v:,.2f}" if cur == "USD" else f"{cur} {v:,.2f}"


def _change_words(cur: float, ref: float) -> str:
    """'+32%' against a reference above zero, else the change in hours."""
    diff = cur - ref
    if ref > 0:
        return f"{diff * 100 / ref:+.0f}%"
    return ("+" if diff >= 0 else "") + hrs(diff)


# ── Rules (pure - unit-tested without a database) ─────────────────────────

def over_threshold(cur_min: float, ref_min: float, pct: float, hours: float) -> bool:
    """Change over `hours`, or over `pct` of `ref` (and at least an hour)."""
    diff = abs((cur_min or 0) - (ref_min or 0))
    if diff > hours * 60:
        return True
    return ref_min > 0 and diff >= PCT_FLOOR_MIN and diff * 100.0 / ref_min > pct


def variance(cur: dict, prev: dict, expected_min, cfg: dict, currency: str = "USD",
             compare_prev: bool = True) -> list:
    """[{metric, current, reference, flag, reason}] - hours / ot / leave / pay
    against the previous period (when there was one to compare), hours
    against the expected hours (when the schedule expects any)."""
    pct, hours = cfg["variancePct"], cfg["varianceHours"]
    out = []
    labels = (("hours", "Hours"), ("ot", "Overtime"), ("leave", "Leave"))
    if compare_prev:
        for metric, label in labels:
            c, p = int(cur.get(metric) or 0), int(prev.get(metric) or 0)
            flag = over_threshold(c, p, pct, hours)
            out.append({"metric": metric, "against": "previous", "current": c, "reference": p, "flag": flag,
                        "reason": f"{label} {hrs(c)} vs. {hrs(p)} last period ({_change_words(c, p)})"})
        c, p = float(cur.get("pay") or 0), float(prev.get("pay") or 0)
        diff = abs(c - p)
        flag = (p > 0 and diff * 100.0 / p > pct) or (p == 0 and c > 0)
        words = _change_words(c, p) if p > 0 else "nothing last period"
        out.append({"metric": "pay", "against": "previous", "current": round(c, 2), "reference": round(p, 2),
                    "flag": bool(flag),
                    "reason": f"Gross pay {money(c, currency)} vs. {money(p, currency)} last period ({words})"})
    if expected_min:
        c = int(cur.get("hours") or 0)
        flag = over_threshold(c, expected_min, pct, hours)
        out.append({"metric": "scheduled", "against": "expected", "current": c, "reference": int(expected_min),
                    "flag": flag,
                    "reason": f"Hours {hrs(c)} vs. {hrs(expected_min)} expected from the schedule "
                              f"({_change_words(c, expected_min)})"})
    return out


def week_anomalies(weeks: list, history: list, cfg: dict) -> list:
    """`weeks` [(week_start, minutes)] of this period; `history` the minutes of
    each counted earlier week (up to 8). A week far from the average."""
    if len(history) < MIN_HISTORY_WEEKS:
        return []
    avg = sum(history) / len(history)
    out = []
    for ws, m in weeks:
        if over_threshold(m, avg, cfg["anomalyPct"], cfg["anomalyHours"]):
            out.append({"type": "week_vs_average", "week": ws,
                        "reason": f"Week of {us_date(ws)}: {hrs(m)}, far from the {len(history)}-week "
                                  f"average of {hrs(avg)} ({_change_words(m, avg)})"})
    return out


def ot_jump(cur_ot: int, prev_ot: int, cfg: dict) -> list:
    if (cur_ot or 0) - (prev_ot or 0) > cfg["otJumpHours"] * 60:
        return [{"type": "ot_jump",
                 "reason": f"Overtime up from {hrs(prev_ot)} last period to {hrs(cur_ot)}"}]
    return []


def missing_outs(exceptions: list, cfg: dict) -> list:
    days = sorted({e["date"] for e in exceptions if e.get("type") == "missing_out"})
    if len(days) >= cfg["missingOutCount"]:
        return [{"type": "missing_clock_outs",
                 "reason": f"{len(days)} missing clock-outs this period ({', '.join(us_date(d) for d in days)})"}]
    return []


NOT_APPROVED_WORDS = {
    "with_manager": "Waiting on the manager's approval",
    "with_employee": "Sent back to the employee - not approved yet",
    "unlocked": "Unlocked by HR - needs the manager's approval again",
}


def readiness_exceptions(f: dict) -> list:
    """[{type, label, blocking}] from the gathered facts `f`:
    periodOpen, periodEnd, hasHours, fixed, finalized, reviewStatus,
    legacyApproved, blocking (timeclock exception rows), summary (their
    words), pendingFixes, rateSet, outOfFenceDays. Approval is needed only
    for a period with hours (timesheet_review.not_reviewed's rule); a
    salaried person needs a salary on file either way."""
    out = []
    if f.get("periodOpen"):
        out.append({"type": "period_open", "blocking": False,
                    "label": f"Period runs through {us_date(f.get('periodEnd', ''))} - approval comes after that day"})
    elif f.get("hasHours") and not (f.get("finalized") or f.get("reviewStatus") == "completed"):
        st = f.get("reviewStatus") or ""
        if st in ("approved", "signing") or f.get("legacyApproved"):
            out.append({"type": "not_signed", "blocking": True,
                        "label": "Approved - waiting on the employee's signature"})
        else:
            out.append({"type": "not_approved", "blocking": True,
                        "label": NOT_APPROVED_WORDS.get(st, "Time Sheet not approved by the manager")})
    if f.get("blocking"):
        n = len(f["blocking"])
        out.append({"type": "missing_punches", "blocking": True,
                    "label": f"{n} missing punch{'' if n == 1 else 'es'} - {f.get('summary', '')}"})
    if f.get("pendingFixes"):
        n = f["pendingFixes"]
        out.append({"type": "pending_fixes", "blocking": True,
                    "label": f"{n} punch fix{'' if n == 1 else 'es'} waiting for a decision"})
    if (f.get("hasHours") or f.get("fixed")) and not f.get("rateSet"):
        out.append({"type": "no_rate", "blocking": True, "label": "No pay rate on file"})
    if f.get("outOfFenceDays"):
        n = f["outOfFenceDays"]
        out.append({"type": "out_of_location", "blocking": False,
                    "label": f"Punches out of location on {n} day{'' if n == 1 else 's'} - check the site on the Time Sheet"})
    return out


# ── Gathering ─────────────────────────────────────────────────────────────

def _figures(card: dict) -> dict:
    t = card.get("totals") or {}
    return {"hours": int(t.get("workedMin") or 0),
            "ot": int(t.get("otMin") or 0) + int(t.get("dtMin") or 0),
            "leave": int(t.get("sickMin") or 0) + int(t.get("vacationMin") or 0) + int(t.get("personalMin") or 0),
            "pay": float(t.get("totalPay") or 0)}


def _week_minutes(cards: list) -> dict:
    out = {}
    for c in cards:
        for d in c.get("days") or []:
            ws = d.get("weekStart") or ""
            out[ws] = out.get(ws, 0) + int(d.get("workedMin") or 0)
    return out


def _expected(db: Session, people: list, start: str, end: str) -> dict:
    """{email: expected minutes over [start, end]} - the scorecard's own
    expected_for_day, its context loaded once per 7-day stretch."""
    import workforce_scorecard as wsc
    if not people:
        return {}
    cfg = wsc.get_settings(db)
    out = {e.work_email.lower(): 0 for e in people}
    seen = {e.work_email.lower(): False for e in people}
    d0, d1 = _d(start), _d(end)
    ws = d0
    while ws <= d1:
        ctx = wsc._context(db, people, ws, cfg)
        for i in range(7):
            dd = ws + timedelta(days=i)
            if dd > d1:
                break
            for emp in people:
                exp = wsc.expected_for_day(emp, dd, ctx, cfg)
                if exp.get("reason") == "no_schedule":
                    continue
                seen[emp.work_email.lower()] = True
                out[emp.work_email.lower()] += int(exp.get("expectedMin") or 0)
        ws += timedelta(days=7)
    return {k: v for k, v in out.items() if seen[k]}


def person(db: Session, row: dict, P: dict, *, cfg: dict, emp, currency: str, approved: set,
           expected_min) -> dict | None:
    """One person's readiness row, or None when there is nothing to report
    (no hours in this period or the previous one)."""
    tc, tsr = _tc(), _tsr()
    em = row["email"]
    fixed = (row.get("payType") or "hourly") == "fixed"
    s, e = (P["monthStart"], P["monthEnd"]) if fixed else (P["start"], P["end"])
    ps, pe = (P["prevMonthStart"], P["prevMonthEnd"]) if fixed else (P["prevStart"], P["prevEnd"])
    pay_type = "fixed" if fixed else "hourly"
    active = (getattr(emp, "status", None) or "active") in ("active", "onboarding")

    cur = tsr.card_for(db, em, s, e, pay_type)
    cur_f = _figures(cur)
    if not active and not cur_f["hours"]:
        return None
    prev = tsr.card_for(db, em, ps, pe, pay_type)
    prev_f = _figures(prev)
    if not fixed and not cur_f["hours"] and not prev_f["hours"]:
        return None

    exc = tc._period_exceptions(db, em, s, e)
    if exc:
        live = tc._clocked_in_now(db, em)
        if live:
            exc = [x for x in exc if not (x["date"] == live and x["type"] == "missing_out")]
    blocking = [x for x in exc if x["blocking"]]
    review = tsr.active_review(db, em, s)
    today = tc._employee_today(db, em)
    period_open = today <= e
    if fixed:
        rate_set = float(cur.get("monthlySalary") or 0) > 0
    else:
        rate_set = bool(cur.get("rateSet")) and float(cur.get("rate") or 0) > 0
    ooo = sum(1 for d in (row.get("days") or {}).values() if "out_of_fence" in (d.get("flags") or [])) if not fixed else 0
    exceptions = readiness_exceptions({
        "periodOpen": period_open, "periodEnd": e, "hasHours": bool(cur_f["hours"]), "fixed": fixed,
        "finalized": bool(tc._finalized_row(db, em, s, e)),
        "reviewStatus": review.status if review else "", "legacyApproved": em in approved,
        "blocking": blocking, "summary": tc._exception_summary(blocking) if blocking else "",
        "pendingFixes": tc._pending_fixes(db, em, s, e), "rateSet": rate_set, "outOfFenceDays": ooo})

    # The previous period counts as something to compare with only when the
    # person was there for it (hours, or a salaried month that was paid) - a
    # new hire's first period is not a jump from zero.
    compare_prev = bool(prev_f["hours"] or prev_f["pay"])
    var = variance(cur_f, prev_f, expected_min if not fixed else None, cfg, currency, compare_prev)

    anomalies = []
    if not fixed:
        hist_start = (_d(s) - timedelta(days=7 * HISTORY_WEEKS)).isoformat()
        older = tc._compute_timecard(db, em, hist_start, (_d(ps) - timedelta(days=1)).isoformat())
        by_week = _week_minutes([older, prev])
        started = ((getattr(emp, "start_date", "") or "")[:10]) if emp else ""
        history = []
        for i in range(HISTORY_WEEKS, 0, -1):
            wk = (_d(s) - timedelta(days=7 * i)).isoformat()
            # Only the weeks the person was employed for (start date, else the
            # first week with hours).
            if started and (_d(wk) + timedelta(days=6)).isoformat() < started:
                continue
            if not started and not history and not by_week.get(wk):
                continue
            history.append(by_week.get(wk, 0))
        this = _week_minutes([cur])
        weeks = []
        ws = _d(s)
        while ws <= _d(e):
            if (ws + timedelta(days=6)).isoformat() < today:      # a whole, finished week
                weeks.append((ws.isoformat(), this.get(ws.isoformat(), 0)))
            ws += timedelta(days=7)
        anomalies += week_anomalies(weeks, history, cfg)
        anomalies += ot_jump(cur_f["ot"], prev_f["ot"], cfg)
    anomalies += missing_outs(exc, cfg)

    ready = not any(x["blocking"] for x in exceptions)
    return {
        "email": em, "name": row.get("name") or em, "department": row.get("department", ""),
        "company": row.get("company", ""), "companyId": row.get("companyId", ""), "payType": pay_type,
        "periodStart": s, "periodEnd": e, "periodOpen": period_open,
        "ready": ready, "exceptions": exceptions, "variance": var,
        "varianceFlags": sum(1 for v in var if v["flag"]), "anomalies": anomalies,
        "reviewStatus": review.status if review else "",
        "totals": {"hoursMin": cur_f["hours"], "otMin": cur_f["ot"], "leaveMin": cur_f["leave"],
                   "grossPay": round(cur_f["pay"], 2), "prevHoursMin": prev_f["hours"], "prevOtMin": prev_f["ot"],
                   "prevLeaveMin": prev_f["leave"], "prevGrossPay": round(prev_f["pay"], 2),
                   "expectedMin": expected_min if not fixed else None},
        "currency": currency,
    }


def strip_pay(report: dict) -> dict:
    """The report without any money: for the manager tier (timeclock._pay_hidden)."""
    for r in report.get("rows") or []:
        r["variance"] = [v for v in r["variance"] if v["metric"] != "pay"]
        r["varianceFlags"] = sum(1 for v in r["variance"] if v["flag"])
        r["totals"].pop("grossPay", None)
        r["totals"].pop("prevGrossPay", None)
        r.pop("currency", None)
    report["payHidden"] = True
    report["summary"] = summarize(report.get("rows") or [])
    return report


def summarize(rows: list) -> dict:
    return {"people": len(rows),
            "ready": sum(1 for r in rows if r["ready"]),
            "notReady": sum(1 for r in rows if not r["ready"]),
            "withVariance": sum(1 for r in rows if r["varianceFlags"]),
            "withAnomalies": sum(1 for r in rows if r["anomalies"])}


def build(db: Session, scope, anchor: str = "") -> dict:
    """The readiness report for the pay period containing `anchor` (default:
    the last one that is over), over `scope` (timeclock._visible_emails;
    None = everyone)."""
    tc = _tc()
    P = periods(anchor or default_anchor())
    rows = tc._team_rows(db, P["start"], P["end"], only_emails=scope, include_fixed=True)
    emps = {(e.work_email or "").lower(): e for e in db.query(models.NexusEmployee).all() if e.work_email}
    for r in rows:
        r["companyId"] = (getattr(emps.get(r["email"]), "company", "") or "") if emps.get(r["email"]) else ""
    rates = {(r.employee_email or "").lower(): r for r in db.query(models.PayrollRate).all()}
    hourly = [r for r in rows if (r.get("payType") or "hourly") != "fixed"]
    fixed = [r for r in rows if (r.get("payType") or "hourly") == "fixed"]
    approved = tc._approved_emails(db, hourly, P["start"], P["end"]) if hourly else set()
    if fixed:
        approved |= tc._approved_emails(db, [{"email": r["email"], "days": {}} for r in fixed],
                                        P["monthStart"], P["monthEnd"])
    people = [emps[r["email"]] for r in hourly if r["email"] in emps]
    expected = _expected(db, people, P["start"], P["end"])
    cfgs: dict = {}
    out = []
    for r in rows:
        cid = r["companyId"]
        if cid not in cfgs:
            cfgs[cid] = get_settings(db, cid)
        rr = rates.get(r["email"])
        currency = (getattr(rr, "currency", None) or "USD") if rr else "USD"
        row = person(db, r, P, cfg=cfgs[cid], emp=emps.get(r["email"]), currency=currency,
                     approved=approved, expected_min=expected.get(r["email"]))
        if row:
            out.append(row)
    out.sort(key=lambda x: (x["ready"], -(len(x["anomalies"]) + x["varianceFlags"]), x["name"].lower()))
    return {"period": P, "rows": out, "summary": summarize(out),
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "settings": get_settings(db)}


# ── A short in-process cache: the panel and the export confirm ask for the
# same report within seconds of each other. Keyed by the caller.
_cache: dict = {}
_cache_lock = threading.Lock()


def cached(key: tuple, fn):
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_TTL_SEC:
            return json.loads(hit[1])
    value = fn()
    with _cache_lock:
        for k in [k for k, v in _cache.items() if now - v[0] >= CACHE_TTL_SEC]:
            _cache.pop(k, None)
        if len(_cache) >= 64:
            _cache.clear()
        _cache[key] = (now, json.dumps(value))
    return value


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()
