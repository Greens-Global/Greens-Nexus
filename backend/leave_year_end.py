"""Year-end for paid leave balances (Neil, Oct 27 2026).

Greens' policy is USE IT OR LOSE IT: by default, what is left of a bucket
when the leave year ends expires. Per company and per bucket (vacation,
sick), layered through scoped_settings (defaults <- the tenant row <- the
company's own, key "leave.yearEnd"), Settings > Time & Pay > Leave Year-End
picks one of:
  reset      "Use It Or Lose It" - everything left expires (the default);
  carry_all  "Carry Everything" - nothing expires;
  carry_cap  "Carry Up To" a cap, in hours or days (days x the person's
             policy hours a day) - the rest expires.

The law comes first: in a state listed in NO_FORFEIT_VACATION (California,
Labor Code 227.3 - earned vacation is wages), VACATION never expires at year
end, whatever the company picked. Who is on the California rule is the same
detection the CA sick policy uses (leave_balances.on_ca_rule). CA sick keeps
its 40-hour lump each calendar year (leave_balances.py) - a lump grant needs
no carry-over, so its year end is the company's sick rule like anyone's.

The leave year: the calendar year (Jan 1 - Dec 31) unless the company picks
"Work Anniversary" for vacation - then a person whose vacation is GRANTED on
their work anniversary (policy method 'anniversary', India) closes their
year the day before each anniversary, so the new grant lands in the new
year. Everyone else (vacation earned per hour worked, sick, no start date on
file) stays on the calendar year. Sick is always the calendar year: its
grant is a calendar-year lump.

What a year end writes - ledger rows, never a delete or an edit:
  expire     dated the closing day: minus what expired (both buckets);
  carryover  dated the next day: plus what carried - SICK only. Vacation is
             a running balance (it already carries), so the expire row alone
             leaves the right number; sick restarts every calendar year in
             leave_balances.balances, so the hours it keeps need a row in the
             new year.
Every row of one closing carries ref_id "yearend:<bucket>:<closing day>".
A pass works out what the closing SHOULD have written from the balance on
the closing day (its own rows left out), compares it with what those rows
already add up to, and writes only the difference - so running the same
year again changes nothing, and a pay period finalized after the year ended
(late December worked or taken) settles with a correction row instead of an
overwrite. A balance at or below zero has nothing to expire: vacation keeps
it, sick starts the new year fresh, as before.

The daily pass (hr_life_events.life_events_loop, in a thread) settles each
person's most recent closing for WINDOW_DAYS after it; HR previews any
company's next or last year end (routers/leave_balances.py) and may apply
the last one at any time. The rule in force when a pass runs is the one it
settles by, so pick the rule before the year ends.

There is no cash-out at year end (Neil, Oct 27 2026: encashment is not being
built) - what is not carried expires.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

import leave_balances as lb
import models
import scoped_settings

SETTING_KEY = "leave.yearEnd"
MODES = ("reset", "carry_all", "carry_cap")
MODE_LABEL = {"reset": "Use It Or Lose It", "carry_all": "Carry Everything", "carry_cap": "Carry Up To a Cap"}
YEAR_BASES = ("calendar", "anniversary")
DEFAULTS = {
    "vacationMode": "reset", "vacationCap": 0.0, "vacationCapUnit": "hours", "vacationYear": "calendar",
    "sickMode": "reset", "sickCap": 0.0, "sickCapUnit": "hours",
}
# Where the law says earned vacation is wages and can never be forfeited.
# Add a state here (its code -> the line Settings and the preview show).
NO_FORFEIT_VACATION = {
    "CA": "California vacation does not expire - required by law (Labor Code 227.3).",
}
WINDOW_DAYS = 45        # the daily pass keeps settling a closed year this long
REF = "yearend"
_EPS = 0.005


def ref_for(bucket: str, closing: str) -> str:
    return f"{REF}:{bucket}:{closing}"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _us(d: date | str) -> str:
    s = d.isoformat() if isinstance(d, date) else (d or "")
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d").strftime("%m/%d/%Y")
    except ValueError:
        return s


# ── The rule ────────────────────────────────────────────────────────────────

def clean(cfg: dict) -> dict:
    """A rule as saved: unknown modes fall back to the default, numbers are
    clamped. Raises ValueError on a cap that is not a number."""
    out = dict(DEFAULTS)
    for b in lb.BUCKETS:
        m = (cfg or {}).get(f"{b}Mode")
        out[f"{b}Mode"] = m if m in MODES else DEFAULTS[f"{b}Mode"]
        try:
            cap = float((cfg or {}).get(f"{b}Cap") or 0)
        except (TypeError, ValueError):
            raise ValueError("The cap is a number of hours or days.")
        if cap != cap or cap < 0 or cap > 2000:
            raise ValueError("Keep the cap between 0 and 2,000.")
        out[f"{b}Cap"] = round(cap, 2)
        u = (cfg or {}).get(f"{b}CapUnit")
        out[f"{b}CapUnit"] = u if u in ("hours", "days") else "hours"
    y = (cfg or {}).get("vacationYear")
    out["vacationYear"] = y if y in YEAR_BASES else "calendar"
    return out


def config(db: Session, company_id: str = "") -> dict:
    try:
        return clean(scoped_settings.get(db, SETTING_KEY, DEFAULTS, company_id))
    except ValueError:
        return dict(DEFAULTS)


def legal_state(db: Session, email: str, emp=None, pol: dict | None = None) -> str:
    """The NO_FORFEIT_VACATION state a person works under, '' for none."""
    return "CA" if lb.on_ca_rule(db, email, emp, pol) else ""


def _closings(bucket: str, cfg: dict, pol: dict, start: date | None, today: date) -> tuple:
    """(basis, last, next) for one bucket of a person's leave year: whether
    it runs by the calendar or their work anniversary, the most recent
    closing day before today (None when there is none yet) and the one
    still ahead (on or after today)."""
    if (bucket == "vacation" and cfg.get("vacationYear") == "anniversary" and start is not None
            and (pol.get("vacation") or {}).get("method") == "anniversary"):
        n = lb._years_on(start, today)
        last = lb._anniversary(start, n) - timedelta(days=1) if n >= 1 else None
        return "anniversary", last, lb._anniversary(start, n + 1) - timedelta(days=1)
    return "calendar", date(today.year - 1, 12, 31), date(today.year, 12, 31)


def rules_for(db: Session, email: str, emp=None, pol: dict | None = None, cfg: dict | None = None,
              today: date | None = None) -> dict:
    """What happens to a person's buckets at their next year end - for the
    employee's own card and the preview. No balances are read."""
    email = (email or "").strip().lower()
    if emp is None:
        emp = lb.employee(db, email)
    pol = pol or lb.policy_for(db, email, emp)
    cfg = cfg or config(db, (getattr(emp, "company", "") or "") if emp is not None else "")
    today = today or lb._today(db, email)
    state = legal_state(db, email, emp, pol)
    hpd = float(pol.get("hoursPerDay") or 8)
    out = {}
    for b in lb.BUCKETS:
        mode = cfg[f"{b}Mode"]
        exempt = b == "vacation" and state in NO_FORFEIT_VACATION
        cap = float(cfg[f"{b}Cap"] or 0)
        cap_h = cap * hpd if cfg[f"{b}CapUnit"] == "days" else cap
        basis, last, nxt = _closings(b, cfg, pol, lb._start(emp), today)
        out[b] = {
            "mode": mode, "modeLabel": MODE_LABEL[mode],
            "effectiveMode": "carry_all" if exempt else mode,
            "cap": cap, "capUnit": cfg[f"{b}CapUnit"], "capHours": round(cap_h, 4),
            "exempt": exempt, "note": NO_FORFEIT_VACATION.get(state, "") if exempt else "",
            "yearBasis": basis,
            "lastClosing": last.isoformat() if last else "", "nextClosing": nxt.isoformat(),
        }
    return out


def _carried(closing: float, rule: dict) -> float:
    if closing <= 0:
        return 0.0
    m = rule["effectiveMode"]
    if m == "carry_all":
        return closing
    if m == "carry_cap":
        return min(closing, max(0.0, float(rule["capHours"] or 0)))
    return 0.0


def _applied(db: Session, email: str, ref: str) -> dict:
    out = {"expire": 0.0, "carryover": 0.0}
    for kind, hours in (db.query(models.LeaveLedgerEntry.kind, func.sum(models.LeaveLedgerEntry.hours))
                        .filter(models.LeaveLedgerEntry.employee_email == email,
                                models.LeaveLedgerEntry.ref_id == ref)
                        .group_by(models.LeaveLedgerEntry.kind).all()):
        if kind in out:
            out[kind] = round(float(hours or 0), 4)
    return out


# ── One person ──────────────────────────────────────────────────────────────

def plan(db: Session, email: str, period: str = "last", emp=None, pols: dict | None = None,
         cfg: dict | None = None, today: date | None = None) -> dict | None:
    """What one person's year end is (period 'last': the closing that has
    passed) or will be (period 'next': projected from today's balance).
    None when balances are not set up for them."""
    email = (email or "").strip().lower()
    if emp is None:
        emp = lb.employee(db, email)
    if emp is None:
        return None
    cut = lb.cutover_for(db, email, emp)
    if not cut:
        return None
    pol = lb.policy_for(db, email, emp, pols)
    today = today or lb._today(db, email)
    rules = rules_for(db, email, emp, pol, cfg, today)
    now_bal = None
    out = {"email": email, "name": f"{emp.first_name or ''} {emp.last_name or ''}".strip() or email,
           "company": getattr(emp, "company", "") or "", "period": period,
           "policy": {"id": pol["id"], "name": pol["name"], "unit": pol.get("unit", "hours"),
                      "hoursPerDay": pol.get("hoursPerDay", 8)},
           "state": legal_state(db, email, emp, pol), "buckets": {}}
    for b in lb.BUCKETS:
        r = rules[b]
        closing_day = r["lastClosing"] if period == "last" else r["nextClosing"]
        row = {**r, "closesOn": closing_day, "carryDate": "", "projected": period != "last",
               "closing": 0.0, "carried": 0.0, "expired": 0.0, "applied": {"expire": 0.0, "carryover": 0.0},
               "toWrite": {"expire": 0.0, "carryover": 0.0}, "skip": ""}
        if not closing_day:
            row["skip"] = "No year end yet"
            out["buckets"][b] = row
            continue
        if closing_day < cut:
            row["skip"] = "Before balances started"
            out["buckets"][b] = row
            continue
        ref = ref_for(b, closing_day)
        end = date.fromisoformat(closing_day)
        row["carryDate"] = (end + timedelta(days=1)).isoformat()
        if period == "last":
            bal = lb.balances(db, email, today=end, pols=pols, emp=emp, exclude_ref=ref)
        else:
            if now_bal is None:
                now_bal = lb.balances(db, email, today=today, pols=pols, emp=emp)
            bal = now_bal
        closing = float((bal.get(b) or {}).get("available") or 0)
        carried = _carried(closing, r)
        lost = max(0.0, closing - carried) if closing > 0 else 0.0
        applied = _applied(db, email, ref)
        want = {"expire": -round(lost, 4), "carryover": round(carried, 4) if b == "sick" else 0.0}
        row.update(closing=round(closing, 2), carried=round(carried, 2), expired=round(lost, 2),
                   applied=applied,
                   toWrite={k: round(want[k] - applied[k], 4) for k in want})
        out["buckets"][b] = row
    return out


def apply_plan(db: Session, p: dict, by: str) -> int:
    """Write what a 'last' plan still owes - one row per kind at most, the
    difference between what the closing should have written and what its
    rows add up to. 0 rows = already settled. The caller commits."""
    if not p or p.get("period") != "last":
        return 0
    n = 0
    for b, row in (p.get("buckets") or {}).items():
        if row.get("skip") or not row.get("closesOn"):
            continue
        ref = ref_for(b, row["closesOn"])
        label = "vacation" if b == "vacation" else "sick time"
        for kind, day in (("expire", row["closesOn"]), ("carryover", row["carryDate"])):
            delta = float(row["toWrite"].get(kind) or 0)
            if abs(delta) < _EPS:
                continue
            fix = abs(float(row["applied"].get(kind) or 0)) >= _EPS
            when = _us(row["closesOn"])
            if kind == "expire":
                note = (f"Correction to the year ending {when}" if fix
                        else f"Year end {when}: unused {label} expired ({MODE_LABEL[row['effectiveMode']]})")
            else:
                note = (f"Correction to what carried over from the year ending {when}" if fix
                        else f"Carried over from the year ending {when}")
            lb.add_entry(db, p["email"], b, delta, kind, day, note, by or "system", ref)
            n += 1
    return n


# ── Everyone ────────────────────────────────────────────────────────────────

def people(db: Session, company: str | None = None) -> list:
    """Active internal people with a work email; `company` None = all."""
    q = (db.query(models.NexusEmployee)
         .filter(models.NexusEmployee.work_email != "",
                 models.NexusEmployee.status.in_(["active", "onboarding"]),
                 func.coalesce(models.NexusEmployee.identity_type, "internal") == "internal"))
    if company is not None:
        q = q.filter(func.coalesce(models.NexusEmployee.company, "") == company)
    return q.order_by(models.NexusEmployee.first_name.asc(), models.NexusEmployee.last_name.asc()).all()


def preview(db: Session, company: str | None, period: str = "next", today: date | None = None) -> dict:
    pols = lb.policies(db)
    cfgs: dict = {}
    rows = []
    for emp in people(db, company):
        cid = getattr(emp, "company", "") or ""
        if cid not in cfgs:
            cfgs[cid] = config(db, cid)
        p = plan(db, emp.work_email, period, emp=emp, pols=pols, cfg=cfgs[cid], today=today)
        if p is not None:
            rows.append(p)
    totals = {b: {"closing": 0.0, "carried": 0.0, "expired": 0.0, "toWrite": 0} for b in lb.BUCKETS}
    for p in rows:
        for b, r in p["buckets"].items():
            if r.get("skip"):
                continue
            t = totals[b]
            t["closing"] = round(t["closing"] + max(0.0, r["closing"]), 2)
            t["carried"] = round(t["carried"] + r["carried"], 2)
            t["expired"] = round(t["expired"] + r["expired"], 2)
            t["toWrite"] += sum(1 for v in r["toWrite"].values() if abs(v) >= _EPS)
    cid = company or ""
    return {"company": cid, "period": period, "settings": config(db, cid),
            "modeLabels": MODE_LABEL, "legal": NO_FORFEIT_VACATION, "people": rows, "totals": totals}


def apply_people(db: Session, emps: list, by: str, window_days: int | None = None,
                 today: date | None = None) -> dict:
    """Settle the last closing of each person. With `window_days`, only a
    closing that ended at most that many days ago (the daily pass). One
    commit per person, under a lock on their row, so a pass and HR's Apply
    at the same moment cannot both write the same difference."""
    pols = lb.policies(db)
    cfgs: dict = {}
    done = {"people": 0, "rows": 0, "failed": []}
    for emp in emps:
        email = (emp.work_email or "").strip().lower()
        try:
            (db.query(models.NexusEmployee).filter(models.NexusEmployee.id == emp.id)
             .with_for_update().first())
            cid = getattr(emp, "company", "") or ""
            if cid not in cfgs:
                cfgs[cid] = config(db, cid)
            day = today or lb._today(db, email)
            if window_days is not None:
                # Most days of the year nobody's year end is near: skip the
                # balance reads unless a closing falls inside the window.
                rules = rules_for(db, email, emp, cfg=cfgs[cid], today=day)
                if not any(r["lastClosing"] and (day - date.fromisoformat(r["lastClosing"])).days <= window_days
                           for r in rules.values()):
                    db.rollback()
                    continue
            p = plan(db, email, "last", emp=emp, pols=pols, cfg=cfgs[cid], today=day)
            if p is None:
                db.rollback()
                continue
            if window_days is not None:
                for b, r in p["buckets"].items():
                    if r.get("closesOn") and (day - date.fromisoformat(r["closesOn"])).days > window_days:
                        r["skip"] = "Outside the settling window"
            n = apply_plan(db, p, by)
            db.commit()
            done["people"] += 1 if n else 0
            done["rows"] += n
        except Exception as e:  # noqa: BLE001 - one person never stops the rest
            db.rollback()
            done["failed"].append({"email": email, "error": str(e)[:200]})
    return done


_last_run = {"day": ""}


def run_due() -> dict | None:
    """The daily pass, from hr_life_events.life_events_loop (in a thread).
    Once per UTC day; nothing until a balance start date is set."""
    import database
    day = datetime.now(timezone.utc).date().isoformat()
    if _last_run["day"] == day:
        return None
    db = database.SessionLocal()
    try:
        if not lb.any_cutover(db):
            _last_run["day"] = day
            return None
        out = apply_people(db, people(db), "system", window_days=WINDOW_DAYS)
        _last_run["day"] = day
        return out
    finally:
        db.close()
