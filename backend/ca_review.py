"""California Review (Neil, Oct 18 2026) - an automated check of each CA-rule
employee's pay period against California rules, for HR to handle.

"On Californian employees make sure that there is an automated review on the
time card by HR that reviews against California rules and if something
doesn't make sense it can flag and HR can handle it."

Scope: hourly USD staff on the 'ca' overtime rule working in the US ONLY (ca_breaks.in_scope).
Nobody else is looked at or produces anything.

Every figure comes from the timecard engine (timeclock._compute_timecard) and
the meal detection inside it (ca_breaks) - never a second calculation. Each
rule is a small function taking the facts and returning flags:

  1. meal_flags        meal late / short / missed (the engine's day["meal"]),
                       and the days a signed waiver would have covered but
                       there is no waiver on file;
  2. attestation_flags a missed break reported at signing, or not signed yet
                       while the card waits for the employee's signature;
  3. seventh_day_flags 7 consecutive days worked in a workweek: the 7th day
                       must carry no regular time (first 8 h overtime, the
                       rest double time) - flagged when the engine did not;
  4. long_day_flags    over 12 h with less double time than the hours past 12;
                       over 16 h (likely a missed punch);
  5. split_shift_flags an unpaid gap over 1 hour between work on one day -
                       HR decides whether a split-shift premium is owed (it is
                       not computed here);
  6. reporting_flags   a published shift where the person worked less than
                       half of it (reporting time) - HR decides;
  7. min_wage_flags    a day's rate below the California state minimum wage
                       (`minWage` setting, default $16.90 for 2026). Local
                       city / county minimums are out of scope;
  8. manual_time_flags manual time adds, self-backfilled punches and punch
                       edits with no reason.

A flag is {key, rule, date, reason, facts}; `fingerprint` hashes its facts.
HR resolves a flag with a note (CaReviewResolution); it stays resolved while
the fingerprint is unchanged - when the facts change it is open again.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy.orm import Session

import ca_breaks
import models

SETTINGS_KEY = "ca_review_config"
DEFAULTS = {"minWage": 16.90}     # California state minimum wage, 2026
RULES = {
    "meal": "Meal Break", "waiver": "Meal Waiver", "attest_no": "Break Attestation",
    "attest_pending": "Break Attestation", "seventh_day": "Seventh Day", "dt_missing": "Double Time",
    "over16": "Over 16 Hours", "split_shift": "Split Shift", "reporting": "Reporting Time",
    "min_wage": "Minimum Wage", "manual_time": "Manual Time",
}
_INTERNAL_NOTES = {"payroll edit"}


def _tc():
    from routers import timeclock
    return timeclock


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def us_date(iso: str) -> str:
    try:
        return date.fromisoformat((iso or "")[:10]).strftime("%m/%d/%Y")
    except ValueError:
        return iso or ""


def _hm(m) -> str:
    m = int(round(m or 0))
    return f"{m // 60}h {m % 60:02d}m"


def fingerprint(facts) -> str:
    return hashlib.sha256(json.dumps(facts, sort_keys=True, default=str).encode()).hexdigest()[:24]


def _flag(rule: str, day: str, reason: str, facts, detail: str = "") -> dict:
    key = f"{rule}:{day}" + (f":{detail}" if detail else "")
    return {"key": key, "rule": rule, "ruleLabel": RULES.get(rule, rule), "date": day, "reason": reason,
            "fingerprint": fingerprint(facts)}


# ── Settings ──────────────────────────────────────────────────────────────

def get_settings(db: Session) -> dict:
    cfg = dict(DEFAULTS)
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTINGS_KEY).first()
    if row and row.value:
        try:
            v = json.loads(row.value)
            if isinstance(v, dict) and v.get("minWage") is not None:
                mw = float(v["minWage"])
                if 0 < mw < 1000:
                    cfg["minWage"] = round(mw, 2)
        except (TypeError, ValueError):
            pass
    return cfg


def save_settings(db: Session, patch: dict, actor: str) -> dict:
    try:
        mw = round(float((patch or {}).get("minWage")), 2)
    except (TypeError, ValueError):
        raise HTTPException(422, "Enter the minimum wage as an amount, for example 16.90.")
    if not (0 < mw < 1000):
        raise HTTPException(422, "Enter the minimum wage as an amount, for example 16.90.")
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTINGS_KEY).first()
    if not row:
        row = models.NexusSetting(key=SETTINGS_KEY)
        db.add(row)
    row.value = json.dumps({"minWage": mw})
    row.updated_by = actor
    db.commit()
    return get_settings(db)


# ── The rules (each separately testable) ─────────────────────────────────

def _worked(d: dict) -> int:
    return int(d.get("regMin") or 0) + int(d.get("otMin") or 0) + int(d.get("dtMin") or 0)


def meal_flags(days: list, waivers: list, tz_offset_min: int = 0) -> list:
    out = []
    for d in days:
        m = d.get("meal")
        if not m:
            continue
        out.append(_flag("meal", d["date"], f"{m['chip']}: {m['label']}", {"m": m.get("issues"), "w": m.get("workMin")}))
        # A waiver would have excused it, but none is on file for the day.
        tl = ca_breaks.day_timeline(d.get("segments") or [])
        if tl and not ca_breaks.waiver_on(waivers, d["date"], tz_offset_min) and not ca_breaks.evaluate(tl[0], tl[1], True):
            out.append(_flag("waiver", d["date"],
                             f"No signed meal waiver on file - one would have covered this {_hm(tl[0])} day",
                             {"w": tl[0], "g": tl[1]}))
    return out


def attestation_flags(review) -> list:
    """`review` = the period's TimesheetReview (or None)."""
    if review is None:
        return []
    import timesheet_review as tsr
    out = []
    rounds = list(review.rounds or [])
    last_approval = max([i for i, e in enumerate(rounds) if e.get("action") in ("approved", "agreed")] or [-1])
    for i, e in enumerate(rounds):
        if e.get("breakClaims"):
            words = "; ".join(f"{us_date(c.get('date'))} {'Meal' if c.get('kind') == 'meal' else 'Rest'}"
                              for c in e["breakClaims"])
            out.append(_flag("attest_no", review.period_start,
                             f"Reported a missed break instead of signing ({words})"
                             + (" - re-approved since" if i < last_approval else ""),
                             {"c": e["breakClaims"], "at": e.get("at")}, detail=str(i)))
    if review.status == "signing" and not tsr.break_attested(review):
        out.append(_flag("attest_pending", review.period_start,
                         "Approved - the employee has not signed the meal and rest break statement yet",
                         {"env": review.sign_request_id}))
    elif review.status == "approved":
        out.append(_flag("attest_pending", review.period_start,
                         "Approved - waiting on the employee to sign the meal and rest break statement",
                         {"st": "approved", "at": review.updated_at}))
    return out


def seventh_day_flags(days: list) -> list:
    """Seven consecutive days worked in one Sunday workweek: the 7th day's
    first 8 h are overtime and the rest double time - no regular time."""
    by = {d["date"]: d for d in days}
    weeks = sorted({d.get("weekStart") for d in days if d.get("weekStart")})
    out = []
    for ws in weeks:
        w0 = date.fromisoformat(ws)
        seq = [(w0 + timedelta(days=i)).isoformat() for i in range(7)]
        if not all(_worked(by.get(s) or {}) > 0 for s in seq):
            continue
        d7 = by[seq[6]]
        w7 = _worked(d7)
        want_dt = max(0, w7 - 480)
        if int(d7.get("regMin") or 0) > 0 or int(d7.get("dtMin") or 0) < want_dt:
            out.append(_flag("seventh_day", seq[6],
                             f"7th consecutive day worked ({_hm(w7)}) but paid {_hm(d7.get('regMin'))} regular and "
                             f"{_hm(d7.get('dtMin'))} double time - 7th-day overtime / double time not applied",
                             {"r": d7.get("regMin"), "o": d7.get("otMin"), "d": d7.get("dtMin")}))
    return out


def long_day_flags(days: list) -> list:
    out = []
    for d in days:
        w = _worked(d)
        if w > 16 * 60:
            out.append(_flag("over16", d["date"], f"Worked {_hm(w)} in one day - over 16 hours, likely a missed punch",
                             {"w": w}))
        if w > 12 * 60 and int(d.get("dtMin") or 0) < w - 12 * 60:
            out.append(_flag("dt_missing", d["date"],
                             f"Worked {_hm(w)} but only {_hm(d.get('dtMin'))} double time - hours past 12 should be "
                             "double time", {"w": w, "d": d.get("dtMin")}))
    return out


def split_shift_flags(days: list) -> list:
    out = []
    for d in days:
        tl = ca_breaks.day_timeline(d.get("segments") or [])
        if not tl:
            continue
        long_gaps = [g for g in tl[1] if g["min"] > 60]
        if long_gaps:
            g = max(long_gaps, key=lambda x: x["min"])
            out.append(_flag("split_shift", d["date"],
                             f"Unpaid gap of {_hm(g['min'])} between work periods - check whether a split-shift "
                             "premium is owed", {"g": [x["min"] for x in long_gaps]}))
    return out


def reporting_flags(days: list, scheduled: dict) -> list:
    """`scheduled` = {date: scheduled minutes} of the person's published,
    live (not weather-cancelled) shifts."""
    by = {d["date"]: d for d in days}
    out = []
    for ds, sched in sorted(scheduled.items()):
        w = _worked(by.get(ds) or {})
        if sched > 0 and 0 < w < sched / 2:
            out.append(_flag("reporting", ds,
                             f"Worked {_hm(w)} of a {_hm(sched)} scheduled shift - under half, check reporting time pay",
                             {"w": w, "s": sched}))
    return out


def min_wage_flags(days: list, min_wage: float, period_start: str) -> list:
    low = sorted({round(float(d.get("rate") or 0), 4) for d in days
                  if _worked(d) > 0 and 0 < float(d.get("rate") or 0) < float(min_wage)})
    if not low:
        return []
    first = min(d["date"] for d in days if _worked(d) > 0 and 0 < float(d.get("rate") or 0) < float(min_wage))
    return [_flag("min_wage", first,
                  f"Pay rate ${low[0]:.2f}/hr is below the California minimum wage (${float(min_wage):.2f}/hr)",
                  {"r": low, "m": float(min_wage)}, detail=period_start)]


def manual_time_flags(punches: list) -> list:
    """Manual adds, self-backfilled punches and punch edits with no reason."""
    by_day = {}
    for p in punches:
        manual = (p.source or "") in ("manual", "self_manual", "offline")
        edited = bool(p.adjusted_by) or (p.edit_status or "") == "approved"
        if not (manual or edited):
            continue
        reasons = [(x or "").strip() for x in (p.note, p.adjust_note, p.edit_reason)]
        if any(r and r.lower() not in _INTERNAL_NOTES for r in reasons):
            continue
        by_day.setdefault(p.local_date, []).append(
            ("self-backfilled" if p.source in ("self_manual", "offline") else "manual add" if manual else "edit", p.id))
    out = []
    for ds, items in sorted(by_day.items()):
        kinds = sorted({k for k, _ in items})
        out.append(_flag("manual_time", ds,
                         f"{len(items)} punch{'' if len(items) == 1 else 'es'} ({', '.join(kinds)}) with no reason given",
                         sorted(i for _, i in items)))
    return out


# ── Gathering ─────────────────────────────────────────────────────────────

def prefetch(db: Session, emails, s: str, e: str) -> dict:
    """Everything flags_for / with_status read besides the card, for many
    people at once (a few queries for the whole roster - Payroll Readiness
    and the queue run one person after another)."""
    import timesheet_review as tsr
    tc = _tc()
    emails = sorted({(x or "").lower() for x in emails if x})
    ctx = {"cfg": get_settings(db), "reviews": {}, "punches": {}, "scheduled": {}, "waivers": {}, "res": {}}
    if not emails:
        return ctx
    for r in (db.query(models.TimesheetReview)
              .filter(models.TimesheetReview.employee_email.in_(emails), models.TimesheetReview.period_start == s,
                      models.TimesheetReview.status.in_(tsr.ACTIVE + ("completed",))).all()):
        cur = ctx["reviews"].get(r.employee_email)
        if cur is None or (r.created_at or "") > (cur.created_at or ""):
            ctx["reviews"][r.employee_email] = r
    for p in (db.query(models.TimePunch)
              .filter(models.TimePunch.employee_email.in_(emails), models.TimePunch.voided == 0,
                      models.TimePunch.local_date >= s, models.TimePunch.local_date <= e)
              .order_by(models.TimePunch.at).all()):
        ctx["punches"].setdefault(p.employee_email, []).append(p)
    for r in (db.query(models.ScheduledShift)
              .filter(models.ScheduledShift.employee_email.in_(emails), models.ScheduledShift.work_date >= s,
                      models.ScheduledShift.work_date <= e, models.ScheduledShift.published == 1,
                      models.ScheduledShift.pending_delete == 0).all()):
        if (getattr(r, "weather_status", "") or "") == "cancelled":
            continue
        m = ctx["scheduled"].setdefault(r.employee_email.lower(), {})
        m[r.work_date] = m.get(r.work_date, 0) + max(0, tc._shift_minutes(r.start_hhmm, r.end_hhmm)
                                                    - int(r.break_min or 0))
    for w in (db.query(models.CaMealWaiver).filter(models.CaMealWaiver.employee_email.in_(emails))
              .order_by(models.CaMealWaiver.sent_at.desc()).all()):
        ctx["waivers"].setdefault(w.employee_email, []).append(w)
    for r in (db.query(models.CaReviewResolution)
              .filter(models.CaReviewResolution.employee_email.in_(emails), models.CaReviewResolution.period_start == s)
              .order_by(models.CaReviewResolution.resolved_at).all()):
        ctx["res"].setdefault(r.employee_email, {})[r.flag_key] = r
    return ctx


def flags_for(db: Session, em: str, s: str, e: str, *, card: dict | None = None, rate_row=None,
              cfg: dict | None = None, ctx: dict | None = None, in_scope: bool | None = None) -> list:
    """Every California Review flag for one person-period ([] for anyone not
    on the CA rule). `card` may be a longer engine card covering [s, e]
    (Payroll Readiness passes its own) - only its days in [s, e] are read.
    `ctx` = prefetch() for a roster; without it each fact is read here."""
    tc = _tc()
    em = (em or "").lower()
    if rate_row is None:
        rate_row = db.query(models.PayrollRate).filter(models.PayrollRate.employee_email == em).first()
    if not (in_scope if in_scope is not None else ca_breaks.in_scope(db, em, rate_row, _load_rate=False)):
        return []
    if ctx is None:
        ctx = prefetch(db, [em], s, e)
    cfg = cfg or ctx["cfg"]
    if card is None:
        card = tc._compute_timecard(db, em, s, e)
    if (card.get("overtimeRule") or "ca") != "ca":
        return []
    days = [d for d in (card.get("days") or []) if s <= d["date"] <= e and not d.get("isHoliday")]
    flags = []
    _p = ctx["punches"].get(em) or []
    flags += meal_flags(days, ctx["waivers"].get(em, []), (_p[-1].tz_offset_min or 0) if _p else 0)
    flags += attestation_flags(ctx["reviews"].get(em))
    flags += seventh_day_flags(days)
    flags += long_day_flags(days)
    flags += split_shift_flags(days)
    flags += reporting_flags(days, ctx["scheduled"].get(em, {}))
    flags += min_wage_flags(days, cfg["minWage"], s)
    flags += manual_time_flags(ctx["punches"].get(em, []))
    return flags


def _resolutions(db: Session, em: str, s: str) -> dict:
    out = {}
    for r in (db.query(models.CaReviewResolution)
              .filter(models.CaReviewResolution.employee_email == em, models.CaReviewResolution.period_start == s)
              .order_by(models.CaReviewResolution.resolved_at).all()):
        out[r.flag_key] = r      # newest wins
    return out


def with_status(db: Session, em: str, s: str, flags: list, ctx: dict | None = None) -> list:
    if not flags:
        return []
    res = ctx["res"].get(em, {}) if ctx is not None else _resolutions(db, em, s)
    out = []
    for f in flags:
        r = res.get(f["key"])
        row = dict(f)
        if r and r.status == "resolved" and r.fingerprint == f["fingerprint"]:
            row.update(status="resolved", resolution={"note": r.note, "by": r.resolved_by, "at": r.resolved_at})
        else:
            row["status"] = "open"
            if r and r.status == "resolved":
                row["changedSinceResolved"] = True
        out.append(row)
    return out


def open_count(db: Session, em: str, s: str, e: str, **kw) -> int:
    return sum(1 for f in with_status(db, em, s, flags_for(db, em, s, e, **kw)) if f["status"] == "open")


def build(db: Session, scope, anchor: str = "") -> dict:
    """The queue for the pay period containing `anchor` (default: the last
    one that is over), over `scope` (timeclock._visible_emails)."""
    import payroll_readiness as pr
    tc = _tc()
    P = pr.periods(anchor or pr.default_anchor())
    s, e = P["start"], P["end"]
    rates = {(r.employee_email or "").lower(): r for r in db.query(models.PayrollRate).all()}
    emps = {(x.work_email or "").lower(): x for x in db.query(models.NexusEmployee).all() if x.work_email}
    team = [r for r in tc._team_rows(db, s, e, only_emails=scope)
            if ca_breaks.in_scope(db, r["email"], rates.get(r["email"]), emp=emps.get(r["email"]), _load_rate=False)]
    ctx = prefetch(db, [r["email"] for r in team], s, e)
    cfg = ctx["cfg"]
    rows = []
    people = 0
    for r in team:
        em = r["email"]
        people += 1
        flags = with_status(db, em, s, flags_for(db, em, s, e, rate_row=rates.get(em), cfg=cfg, ctx=ctx), ctx)
        emp = emps.get(em)
        for f in flags:
            rows.append({**f, "email": em, "name": r.get("name") or em, "periodStart": s, "periodEnd": e,
                         "company": (getattr(emp, "company", "") or "") if emp else "",
                         "payType": "hourly"})
    rows.sort(key=lambda x: (x["status"] != "open", x["name"].lower(), x["date"], x["rule"]))
    return {"period": {"start": s, "end": e}, "rows": rows, "people": people,
            "openCount": sum(1 for x in rows if x["status"] == "open"), "settings": cfg,
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}


def _current_flag(db: Session, em: str, s: str, key: str) -> dict:
    tc = _tc()
    _s, e = tc._pay_period(s)
    for f in flags_for(db, em, _s, e):
        if f["key"] == key:
            return f
    raise HTTPException(404, "That flag is no longer raised - refresh the California Review.")


def resolve(db: Session, em: str, s: str, key: str, note: str, actor: str) -> dict:
    note = (note or "").strip()
    if len(note) < 3:
        raise HTTPException(422, "Say how this was handled.")
    em = (em or "").lower()
    s = _tc()._pay_period(s)[0]
    f = _current_flag(db, em, s, key)
    db.add(models.CaReviewResolution(id=str(uuid.uuid4()), employee_email=em, period_start=s, flag_key=key,
                                     fingerprint=f["fingerprint"], status="resolved", note=note[:1000],
                                     resolved_by=(actor or "").lower(), resolved_at=_now()))
    db.commit()
    return {"key": key, "status": "resolved"}


def reopen(db: Session, em: str, s: str, key: str, actor: str) -> dict:
    em = (em or "").lower()
    s = _tc()._pay_period(s)[0]
    r = _resolutions(db, em, s).get(key)
    if not r or r.status != "resolved":
        raise HTTPException(409, "This flag is not resolved.")
    r.status, r.reopened_by, r.reopened_at = "reopened", (actor or "").lower(), _now()
    db.commit()
    return {"key": key, "status": "open"}
