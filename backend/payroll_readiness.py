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
       - no pay rate on file (timeclock._rate_on on the period's last day:
         an hourly rate, or a monthly salary).
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

Every figure is read off the timecard engine (timeclock._compute_timecard /
_fixed_card): one long card per hourly person, split by payroll week (see
Gathering below). Hourly people use the bi-weekly pay period, salaried people
the latest calendar month that has ended by the period's last day (their pay
is monthly). Weekly anomalies and the schedule comparison are hourly only.

The payroll export's warning (check_export) judges what the export carries:
every pay period overlapping its dates for hourly people, the month
containing its first day for salaried people - readiness only.

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
#
# Cost (PR #631 review, Oct 17): an hourly person used to cost four engine
# passes (this period's card, last period's, a six-week history card and the
# exceptions). Now ONE _compute_timecard runs from eight weeks before the
# period through its last day, and every period / week figure is split out
# of that card's own day lines (split_figures). The split is exact because
# the engine's overtime week is the Sunday payroll week and every pay period
# starts on a Sunday, so no week straddles a split; each day line carries the
# rate it was priced at. The one thing a long card cannot see is a FINALIZED
# period's frozen rate / OT rule (it applies only to a card of exactly that
# period) - when a snapshot disagrees with the long card, that period gets its
# own standalone card (_pinned_differs). The review state, finalization and
# open fixes are read for everyone in a few queries (_bulk_status).

def _figures(card: dict) -> dict:
    t = card.get("totals") or {}
    return {"hours": int(t.get("workedMin") or 0),
            "ot": int(t.get("otMin") or 0) + int(t.get("dtMin") or 0),
            "leave": int(t.get("sickMin") or 0) + int(t.get("vacationMin") or 0) + int(t.get("personalMin") or 0),
            "pay": float(t.get("totalPay") or 0)}


def split_figures(card: dict, start: str, end: str) -> dict:
    """The _figures of [start, end] summed from a longer card's day lines:
    minutes as the engine split them, pay priced the way its totals are (each
    day at its own rate, the engine's OT / DT multipliers, each pay class
    rounded, then the total)."""
    tc = _tc()
    hours = ot = leave = 0
    reg_p = ot_p = dt_p = sick_p = vac_p = pers_p = hol_p = 0.0
    meal_p = rest_p = 0.0    # CA premiums (ca_breaks.py) - 0 on every other card
    for d in card.get("days") or []:
        if not (start <= d["date"] <= end):
            continue
        r = float(d.get("rate") or 0)
        reg, o, dt = int(d.get("regMin") or 0), int(d.get("otMin") or 0), int(d.get("dtMin") or 0)
        sick, vac, pers = int(d.get("sickMin") or 0), int(d.get("vacationMin") or 0), int(d.get("personalMin") or 0)
        hours += int(d.get("workedMin") or 0)
        ot += o + dt
        leave += sick + vac + pers
        reg_p += reg / 60 * r
        ot_p += o / 60 * r * tc._OT_MULT
        dt_p += dt / 60 * r * tc._DT_MULT
        sick_p += sick / 60 * r
        vac_p += vac / 60 * r
        pers_p += pers / 60 * r
        hol_p += float(d.get("holidayPay") or 0)
        meal_p += float(d.get("mealPremiumPay") or 0)
        rest_p += float(d.get("restPremiumPay") or 0)
    pay = round(round(reg_p, 2) + round(ot_p, 2) + round(dt_p, 2) + round(hol_p, 2)
                + round(sick_p, 2) + round(vac_p, 2) + round(pers_p, 2)
                + round(meal_p, 2) + round(rest_p, 2), 2)
    return {"hours": hours, "ot": ot, "leave": leave, "pay": pay}


def _pinned_differs(db: Session, em: str, final, card: dict, start: str, end: str) -> bool:
    """True when `final` (the period's finalization row) froze a rate or OT
    rule the long card did not price [start, end] with."""
    if not final or not final.note:
        return False
    try:
        snap = json.loads(final.note)
    except (TypeError, ValueError):
        return False
    if not isinstance(snap, dict) or "rate" not in snap:
        return False
    rate = float(snap.get("rate") or 0)
    if (snap.get("rule") or card.get("overtimeRule")) != card.get("overtimeRule"):
        return True
    for d in card.get("days") or []:
        if not (start <= d["date"] <= end):
            continue
        r = d.get("rate")
        if r is None and d.get("holidayPay"):
            r = _tc()._rate_on(db, em, d["date"])["hourlyRate"]
        if r is not None and abs(float(r) - rate) > 1e-9:
            return True
    return False


def _bulk_status(db: Session, emails: list, start: str, end: str) -> dict:
    """For everyone at once, what timesheet_review.active_review,
    timeclock._finalized_row and timeclock._pending_fixes answer one person
    at a time: {"review": {email: status}, "final": {email: row},
    "fixes": {email: count}}."""
    from sqlalchemy import func
    tsr = _tsr()
    out = {"review": {}, "final": {}, "fixes": {}}
    if not emails:
        return out
    emails = list(emails)
    latest = {}
    for r in (db.query(models.TimesheetReview)
              .filter(models.TimesheetReview.employee_email.in_(emails), models.TimesheetReview.period_start == start,
                      models.TimesheetReview.status.in_(tsr.ACTIVE + ("completed",))).all()):
        if r.employee_email not in latest or (r.created_at or "") > (latest[r.employee_email].created_at or ""):
            latest[r.employee_email] = r
    out["review"] = {em: r.status for em, r in latest.items()}
    for a in (db.query(models.TimeApproval)
              .filter(models.TimeApproval.employee_email.in_(emails), models.TimeApproval.revoked == 0,
                      models.TimeApproval.kind == "final", models.TimeApproval.period_start <= start,
                      models.TimeApproval.period_end >= end).all()):
        out["final"].setdefault(a.employee_email, a)
    for em, n in (db.query(models.PunchRequest.employee_email, func.count(models.PunchRequest.id))
                  .filter(models.PunchRequest.employee_email.in_(emails), models.PunchRequest.status == "pending",
                          models.PunchRequest.local_date >= start, models.PunchRequest.local_date <= end)
                  .group_by(models.PunchRequest.employee_email).all()):
        out["fixes"][em] = out["fixes"].get(em, 0) + int(n)
    for em, n in (db.query(models.TimePunch.employee_email, func.count(models.TimePunch.id))
                  .filter(models.TimePunch.employee_email.in_(emails), models.TimePunch.voided == 0,
                          models.TimePunch.edit_status == "pending", models.TimePunch.local_date >= start,
                          models.TimePunch.local_date <= end)
                  .group_by(models.TimePunch.employee_email).all()):
        out["fixes"][em] = out["fixes"].get(em, 0) + int(n)
    return out


def _rate_set(db: Session, em: str, fixed: bool, day: str, rate_row) -> bool:
    """A pay rate on file in effect on `day`: an hourly rate, or a monthly salary."""
    if rate_row is None:
        return False
    r = _tc()._rate_on(db, em, day, rate_row=rate_row)
    return float(r["monthlySalary"] if fixed else r["hourlyRate"]) > 0


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


def _exceptions_for(db: Session, em: str, s: str, e: str) -> list:
    """timeclock._period_exceptions, minus the clock-out of a shift still
    running (list_exceptions' rule)."""
    tc = _tc()
    exc = tc._period_exceptions(db, em, s, e)
    if exc:
        live = tc._clocked_in_now(db, em)
        if live:
            exc = [x for x in exc if not (x["date"] == live and x["type"] == "missing_out")]
    return exc


def _facts(db: Session, em: str, s: str, e: str, *, fixed: bool, has_hours: bool, today: str, exc: list,
           status: dict, approved: set, rate_row, days: dict) -> list:
    """readiness_exceptions for one person-period - shared by the full report
    and the export check, so both judge readiness the same way."""
    tc = _tc()
    blocking = [x for x in exc if x["blocking"]]
    ooo = 0 if fixed else sum(1 for d in (days or {}).values() if "out_of_fence" in (d.get("flags") or []))
    return readiness_exceptions({
        "periodOpen": today <= e, "periodEnd": e, "hasHours": has_hours, "fixed": fixed,
        "finalized": em in status["final"], "reviewStatus": status["review"].get(em, ""),
        "legacyApproved": em in approved, "blocking": blocking,
        "summary": tc._exception_summary(blocking) if blocking else "",
        "pendingFixes": status["fixes"].get(em, 0), "rateSet": _rate_set(db, em, fixed, e, rate_row),
        "outOfFenceDays": ooo})


def _base_row(row: dict, pay_type: str, s: str, e: str, today: str, exceptions: list) -> dict:
    return {"email": row["email"], "name": row.get("name") or row["email"], "department": row.get("department", ""),
            "company": row.get("company", ""), "companyId": row.get("companyId", ""), "payType": pay_type,
            "periodStart": s, "periodEnd": e, "periodOpen": today <= e,
            "ready": not any(x["blocking"] for x in exceptions), "exceptions": exceptions,
            "variance": [], "varianceFlags": 0, "anomalies": []}


def person(db: Session, row: dict, P: dict, *, cfg: dict, emp, currency: str, approved: set,
           expected_min, status: dict, rate_row, ca_ctx: dict | None = None) -> dict | None:
    """One person's readiness row, or None when there is nothing to report
    (no hours in this period or the previous one)."""
    tc, tsr = _tc(), _tsr()
    em = row["email"]
    fixed = (row.get("payType") or "hourly") == "fixed"
    s, e = (P["monthStart"], P["monthEnd"]) if fixed else (P["start"], P["end"])
    ps, pe = (P["prevMonthStart"], P["prevMonthEnd"]) if fixed else (P["prevStart"], P["prevEnd"])
    active = (getattr(emp, "status", None) or "active") in ("active", "onboarding")

    if fixed:
        # Salaried: the month card and last month's (their pay is the month's).
        cur = tsr.card_for(db, em, s, e, "fixed")
        cur_f = _figures(cur)
        if not active and not cur_f["hours"]:
            return None
        prev_f = _figures(tsr.card_for(db, em, ps, pe, "fixed"))
        long_card = None
    else:
        hist_start = (_d(s) - timedelta(days=7 * HISTORY_WEEKS)).isoformat()
        long_card = tc._compute_timecard(db, em, hist_start, e)
        cur_f = split_figures(long_card, s, e)
        if not active and not cur_f["hours"]:
            return None
        if _pinned_differs(db, em, status["final"].get(em), long_card, s, e):
            cur_f = _figures(tc._compute_timecard(db, em, s, e))
        prev_f = split_figures(long_card, ps, pe)
        if prev_f["hours"] or prev_f["pay"]:
            pfin = tc._finalized_row(db, em, ps, pe)
            if _pinned_differs(db, em, pfin, long_card, ps, pe):
                prev_f = _figures(tc._compute_timecard(db, em, ps, pe))
        if not cur_f["hours"] and not prev_f["hours"]:
            return None

    exc = _exceptions_for(db, em, s, e)
    today = tc._employee_today(db, em)
    exceptions = _facts(db, em, s, e, fixed=fixed, has_hours=bool(cur_f["hours"]), today=today, exc=exc,
                        status=status, approved=approved, rate_row=rate_row, days=row.get("days"))

    # The previous period counts as something to compare with only when the
    # person was there for it (hours, or a salaried month that was paid) - a
    # new hire's first period is not a jump from zero.
    compare_prev = bool(prev_f["hours"] or prev_f["pay"])
    var = variance(cur_f, prev_f, expected_min if not fixed else None, cfg, currency, compare_prev)

    anomalies = []
    if not fixed:
        by_week = _week_minutes([long_card])
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
        weeks = []
        ws = _d(s)
        while ws <= _d(e):
            if (ws + timedelta(days=6)).isoformat() < today:      # a whole, finished week
                weeks.append((ws.isoformat(), by_week.get(ws.isoformat(), 0)))
            ws += timedelta(days=7)
        anomalies += week_anomalies(weeks, history, cfg)
        anomalies += ot_jump(cur_f["ot"], prev_f["ot"], cfg)
    anomalies += missing_outs(exc, cfg)
    if not fixed:
        # CA-rule staff only (Oct 18 2026): meal break flags and the open
        # California Review count, as information - never blocking, never
        # Ready / Not Ready. Nobody else gets anything here.
        exceptions = exceptions + ca_info(db, em, s, e, long_card, rate_row, ca_ctx)

    out = _base_row(row, "fixed" if fixed else "hourly", s, e, today, exceptions)
    out.update({
        "variance": var, "varianceFlags": sum(1 for v in var if v["flag"]), "anomalies": anomalies,
        "reviewStatus": status["review"].get(em, ""),
        "totals": {"hoursMin": cur_f["hours"], "otMin": cur_f["ot"], "leaveMin": cur_f["leave"],
                   "grossPay": round(cur_f["pay"], 2), "prevHoursMin": prev_f["hours"], "prevOtMin": prev_f["ot"],
                   "prevLeaveMin": prev_f["leave"], "prevGrossPay": round(prev_f["pay"], 2),
                   "expectedMin": expected_min if not fixed else None},
        "currency": currency,
    })
    return out


def ca_info(db: Session, em: str, s: str, e: str, card: dict, rate_row, ctx: dict | None = None) -> list:
    """Non-blocking readiness notes for a CA-rule hourly person ([] for
    anyone else): the days the meal detection flagged and the open
    California Review flags (ca_review.py - the same engine card)."""
    import ca_breaks
    import ca_review
    if not ca_breaks.is_ca_rate(rate_row):
        return []
    flags = ca_review.with_status(db, em, s, ca_review.flags_for(db, em, s, e, card=card, rate_row=rate_row,
                                                                 ctx=ctx), ctx)
    out = []
    meal_days = sorted({f["date"] for f in flags if f["rule"] == "meal"})
    if meal_days:
        n = len(meal_days)
        out.append({"type": "ca_meal", "blocking": False,
                    "label": f"Meal break flags on {n} day{'' if n == 1 else 's'} - "
                             f"{', '.join(us_date(d) for d in meal_days[:5])}{' ...' if n > 5 else ''}"})
    n_open = sum(1 for f in flags if f["status"] == "open")
    if n_open:
        out.append({"type": "ca_review", "blocking": False,
                    "label": f"{n_open} open California Review flag{'' if n_open == 1 else 's'} - information only"})
    return out


def _week_minutes(cards: list) -> dict:
    out = {}
    for c in cards:
        for d in c.get("days") or []:
            ws = d.get("weekStart") or ""
            out[ws] = out.get(ws, 0) + int(d.get("workedMin") or 0)
    return out


def strip_pay(report: dict) -> dict:
    """The report without any money: for the manager tier (timeclock._pay_hidden)."""
    for r in report.get("rows") or []:
        r["variance"] = [v for v in r["variance"] if v["metric"] != "pay"]
        r["varianceFlags"] = sum(1 for v in r["variance"] if v["flag"])
        # The California Review is HR's (Oct 18 2026) - not even its count here.
        r["exceptions"] = [x for x in r.get("exceptions") or [] if x.get("type") != "ca_review"]
        (r.get("totals") or {}).pop("grossPay", None)
        (r.get("totals") or {}).pop("prevGrossPay", None)
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


def _roster(db: Session, scope, start: str, end: str):
    """(team rows with companyId, employees by email, pay rates by email)."""
    tc = _tc()
    rows = tc._team_rows(db, start, end, only_emails=scope, include_fixed=True)
    emps = {(e.work_email or "").lower(): e for e in db.query(models.NexusEmployee).all() if e.work_email}
    for r in rows:
        r["companyId"] = (getattr(emps.get(r["email"]), "company", "") or "") if emps.get(r["email"]) else ""
    rates = {(r.employee_email or "").lower(): r for r in db.query(models.PayrollRate).all()}
    return rows, emps, rates


def build(db: Session, scope, anchor: str = "") -> dict:
    """The readiness report for the pay period containing `anchor` (default:
    the last one that is over), over `scope` (timeclock._visible_emails;
    None = everyone)."""
    tc = _tc()
    P = periods(anchor or default_anchor())
    rows, emps, rates = _roster(db, scope, P["start"], P["end"])
    hourly = [r for r in rows if (r.get("payType") or "hourly") != "fixed"]
    fixed = [r for r in rows if (r.get("payType") or "hourly") == "fixed"]
    approved = tc._approved_emails(db, hourly, P["start"], P["end"]) if hourly else set()
    if fixed:
        approved |= tc._approved_emails(db, [{"email": r["email"], "days": {}} for r in fixed],
                                        P["monthStart"], P["monthEnd"])
    st_h = _bulk_status(db, [r["email"] for r in hourly], P["start"], P["end"])
    st_f = _bulk_status(db, [r["email"] for r in fixed], P["monthStart"], P["monthEnd"])
    people = [emps[r["email"]] for r in hourly if r["email"] in emps]
    expected = _expected(db, people, P["start"], P["end"])
    # CA-rule hourly people (ca_review.py): their facts read once for all of them.
    import ca_breaks
    import ca_review
    ca_people = [r["email"] for r in hourly if ca_breaks.is_ca_rate(rates.get(r["email"]))]
    ca_ctx = ca_review.prefetch(db, ca_people, P["start"], P["end"]) if ca_people else None
    if ca_people:
        ca_breaks.preload(db, ca_people, (_d(P["start"]) - timedelta(days=7 * HISTORY_WEEKS)).isoformat(), P["end"])
    try:
        return _build_rows(db, rows, P, emps, rates, approved, st_h, st_f, expected, ca_ctx)
    finally:
        ca_breaks.clear_preload(db)


def _build_rows(db: Session, rows, P, emps, rates, approved, st_h, st_f, expected, ca_ctx) -> dict:
    cfgs: dict = {}
    out = []
    for r in rows:
        cid = r["companyId"]
        if cid not in cfgs:
            cfgs[cid] = get_settings(db, cid)
        rr = rates.get(r["email"])
        currency = (getattr(rr, "currency", None) or "USD") if rr else "USD"
        is_fixed = (r.get("payType") or "hourly") == "fixed"
        row = person(db, r, P, cfg=cfgs[cid], emp=emps.get(r["email"]), currency=currency,
                     approved=approved, expected_min=expected.get(r["email"]),
                     status=st_f if is_fixed else st_h, rate_row=rr, ca_ctx=ca_ctx)
        if row:
            out.append(row)
    out.sort(key=lambda x: (x["ready"], -(len(x["anomalies"]) + x["varianceFlags"]), x["name"].lower()))
    return {"period": P, "rows": out, "summary": summarize(out),
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "settings": get_settings(db)}


def export_periods(start: str, end: str) -> dict:
    """What an export of [start, end] covers: every bi-weekly period that
    overlaps it (hourly people) and the calendar month containing `start`
    (salaried people - a salaried card exports its month)."""
    tc = _tc()
    hourly = []
    s, e = tc._pay_period(start)
    while s <= end:
        hourly.append((s, e))
        s, e = tc._pay_period((_d(e) + timedelta(days=1)).isoformat())
    ms, me = tc._month_bounds(start)
    return {"hourly": hourly, "monthStart": ms, "monthEnd": me}


def check_export(db: Session, scope, start: str, end: str) -> dict:
    """Readiness only (no variance, no anomalies, no timecards) for what an
    export of [start, end] carries - the export's warning. Hourly people are
    judged on each pay period overlapping the dates, salaried people on the
    month containing `start`; a row per person per period. Same rules as the
    report (_facts)."""
    tc = _tc()
    X = export_periods(start, end)
    out = []
    groups = [(ps, pe, False) for ps, pe in X["hourly"]] + [(X["monthStart"], X["monthEnd"], True)]
    emps = rates = None
    for ps, pe, want_fixed in groups:
        rows, emps_, rates_ = _roster(db, scope, ps, pe)
        emps, rates = emps or emps_, rates or rates_
        rows = [r for r in rows if ((r.get("payType") or "hourly") == "fixed") == want_fixed]
        if not rows:
            continue
        approved = tc._approved_emails(db, rows if not want_fixed else [{"email": r["email"], "days": {}} for r in rows],
                                       ps, pe)
        status = _bulk_status(db, [r["email"] for r in rows], ps, pe)
        for r in rows:
            em = r["email"]
            emp = emps.get(em)
            active = (getattr(emp, "status", None) or "active") in ("active", "onboarding")
            has_hours = bool(r.get("workedMin"))
            if not has_hours and (not want_fixed or not active):
                continue
            today = tc._employee_today(db, em)
            exceptions = _facts(db, em, ps, pe, fixed=want_fixed, has_hours=has_hours, today=today,
                                exc=_exceptions_for(db, em, ps, pe), status=status, approved=approved,
                                rate_row=rates.get(em), days=r.get("days"))
            out.append(_base_row(r, "fixed" if want_fixed else "hourly", ps, pe, today, exceptions))
    out.sort(key=lambda x: (x["ready"], x["name"].lower(), x["periodStart"]))
    return {"export": {"start": start, "end": end, **X}, "rows": out, "summary": summarize(out),
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "checkOnly": True}


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
