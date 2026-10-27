"""Paid leave balances - vacation and sick, in hours (Neil / Charmi call,
Oct 19 2026).

How a balance is made:
  * ONE import as of a cutover date (HR > Leave): what each person had left
    in QuickBooks on that day -> `opening` rows. Nothing shows to employees
    until HR sets the cutover.
  * From then on Nexus keeps it, from FINALIZED pay periods only
    (finalize_timecard calls record_period; unfinalize removes its rows):
      - vacation earned per hour worked (US), by years of service;
      - sick / vacation hours paid on the card are `used`.
  * Grants that are not earned per hour are computed, never stored:
      - sick, lump sum: e.g. California 5 days (40 h) once the person passes
        90 days, for the calendar year, use it or lose it (sick = personal);
      - vacation, on each work anniversary (India: 5 days after one year,
        10 after three).
  * HR adjustments are `adjust` rows with a note.

Policies are data (NexusSetting "leave.policies"): the defaults below come
from the call and HR can change them. A person gets their country's policy
(California = the 'ca' overtime rule on their pay rate, the same rule the
CA break features use) unless HR picked another on their row.

Nothing here changes pay. The timecard still pays what its Sick / Vacation
punches say; the balance is what the person has left.
"""
from __future__ import annotations

import copy
import json
import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy.orm import Session

import models

POLICIES_KEY = "leave.policies"
CUTOVER_KEY = "leave.cutover"
BUCKETS = ("vacation", "sick")

# The call (Oct 19 2026). Hours throughout; `unit` is only how it is shown.
DEFAULT_POLICIES = {
    "us-ca": {
        "id": "us-ca", "name": "US - California", "unit": "hours", "hoursPerDay": 8,
        "eligibleTypes": ["full_time"],
        # After 90 days of full-time employment, 5 days at once for the
        # calendar year; use it or lose it; sick and personal are one.
        "sick": {"method": "lump", "hours": 40, "afterDays": 90},
        # After one year, earned per hour worked: 1 week a year, 2 weeks after
        # 3 years, 3 weeks after 5 (the cap).
        "vacation": {"method": "per_hour", "baseHoursPerYear": 2080,
                     "tiers": [{"fromYears": 1, "hoursPerYear": 40},
                               {"fromYears": 3, "hoursPerYear": 80},
                               {"fromYears": 5, "hoursPerYear": 120}]},
    },
    "us-other": {
        "id": "us-other", "name": "US - Other States", "unit": "hours", "hoursPerDay": 8,
        "eligibleTypes": ["full_time"],
        # Texas was "two days" on the call but not confirmed - 0 until HR sets it.
        "sick": {"method": "lump", "hours": 0, "afterDays": 90},
        "vacation": {"method": "per_hour", "baseHoursPerYear": 2080,
                     "tiers": [{"fromYears": 1, "hoursPerYear": 40},
                               {"fromYears": 3, "hoursPerYear": 80},
                               {"fromYears": 5, "hoursPerYear": 120}]},
    },
    "in": {
        "id": "in", "name": "India", "unit": "days", "hoursPerDay": 8,
        "eligibleTypes": ["full_time"],
        # 3 paid days after 90 days, calendar year, use it or lose it.
        "sick": {"method": "lump", "hours": 24, "afterDays": 90},
        # 5 days on the first work anniversary, 10 from the third (the cap).
        "vacation": {"method": "anniversary",
                     "tiers": [{"fromYears": 1, "hoursPerYear": 40},
                               {"fromYears": 3, "hoursPerYear": 80}]},
    },
    "none": {
        "id": "none", "name": "No Paid Leave", "unit": "hours", "hoursPerDay": 8,
        "eligibleTypes": [],
        "sick": {"method": "none"},
        "vacation": {"method": "none"},
    },
}

_EMP_TYPES = ("full_time", "part_time", "contractor", "intern")


# ── Settings ─────────────────────────────────────────────────────────────────

def _setting(db: Session, key: str) -> str:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == key).first()
    return (row.value if row else "") or ""


def _put_setting(db: Session, key: str, value: str, by: str) -> None:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == key).first()
    if row is None:
        row = models.NexusSetting(key=key)
        db.add(row)
    row.value, row.updated_by, row.updated_at = value, by, _now()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _cutover_key(company_id: str = "") -> str:
    return f"{CUTOVER_KEY}:{company_id}" if company_id else CUTOVER_KEY


def _valid_day(v: str) -> str:
    v = (v or "").strip()[:10]
    try:
        date.fromisoformat(v)
        return v
    except ValueError:
        return ""


def cutover(db: Session, company_id: str = "") -> str:
    """The date balances start from ('' = not set up - nothing is shown).
    Per company since Oct 23 2026: a company's own date wins over the
    organization's; a company with none follows the organization's."""
    if company_id:
        own = _valid_day(_setting(db, _cutover_key(company_id)))
        if own:
            return own
    return _valid_day(_setting(db, CUTOVER_KEY))


def cutover_for(db: Session, email: str, emp=None) -> str:
    """The start date that applies to one person: their company's."""
    if emp is None:
        emp = employee(db, email)
    return cutover(db, (getattr(emp, "company", "") or "") if emp else "")


def company_cutovers(db: Session) -> dict:
    """{company id: its own start date} - only the companies with one."""
    rows = (db.query(models.NexusSetting)
            .filter(models.NexusSetting.key.like(f"{CUTOVER_KEY}:%")).all())
    out = {}
    for r in rows:
        co = r.key[len(CUTOVER_KEY) + 1:]
        d = _valid_day(r.value or "")
        if co and d:
            out[co] = d
    return out


def any_cutover(db: Session) -> bool:
    return bool(cutover(db)) or bool(company_cutovers(db))


def set_cutover(db: Session, day: str, by: str, company_id: str = "") -> None:
    date.fromisoformat(day)          # raises on a bad date
    _put_setting(db, _cutover_key(company_id), day, by)


def clear_cutover(db: Session, company_id: str) -> bool:
    """Drop a company's own start date so it follows the organization's."""
    if not company_id:
        return False
    row = db.get(models.NexusSetting, _cutover_key(company_id))
    if row is None:
        return False
    db.delete(row)
    return True


def policies(db: Session) -> dict:
    """Every policy by id - HR's saved copy over the defaults."""
    out = copy.deepcopy(DEFAULT_POLICIES)
    raw = _setting(db, POLICIES_KEY)
    if raw:
        try:
            saved = json.loads(raw)
        except ValueError:
            saved = {}
        for pid, p in (saved or {}).items():
            if isinstance(p, dict):
                out[pid] = {**out.get(pid, {}), **p, "id": pid}
    return out


def _num(v, lo=0.0, hi=10000.0) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise ValueError("Numbers only.")
    if x != x or x < lo or x > hi:
        raise ValueError(f"Keep numbers between {lo:g} and {hi:g}.")
    return x


def clean_policy(pid: str, p: dict) -> dict:
    """A policy HR saved, checked field by field (unknown keys dropped)."""
    if not isinstance(p, dict):
        raise ValueError("A policy is an object.")
    name = str(p.get("name") or "").strip()[:80]
    if not name:
        raise ValueError("Give the policy a name.")
    unit = p.get("unit") if p.get("unit") in ("hours", "days") else "hours"
    types = [t for t in (p.get("eligibleTypes") or []) if t in _EMP_TYPES]
    sick_in = p.get("sick") or {}
    vac_in = p.get("vacation") or {}
    sick = {"method": "none"}
    if sick_in.get("method") == "lump":
        sick = {"method": "lump", "hours": _num(sick_in.get("hours", 0), 0, 2000),
                "afterDays": int(_num(sick_in.get("afterDays", 0), 0, 3650))}
    vac = {"method": "none"}
    if vac_in.get("method") in ("per_hour", "anniversary"):
        tiers = []
        for t in vac_in.get("tiers") or []:
            tiers.append({"fromYears": int(_num(t.get("fromYears", 0), 0, 60)),
                          "hoursPerYear": _num(t.get("hoursPerYear", 0), 0, 2000)})
        tiers.sort(key=lambda t: t["fromYears"])
        if not tiers:
            raise ValueError("Add at least one vacation tier.")
        vac = {"method": vac_in["method"], "tiers": tiers}
        if vac["method"] == "per_hour":
            vac["baseHoursPerYear"] = _num(vac_in.get("baseHoursPerYear", 2080), 1, 5000)
    return {"id": pid, "name": name, "unit": unit,
            "hoursPerDay": _num(p.get("hoursPerDay", 8), 1, 24),
            "eligibleTypes": types, "sick": sick, "vacation": vac}


def save_policies(db: Session, incoming: dict, by: str) -> dict:
    """Replace HR's saved policies. The four built-in ids always exist."""
    cleaned = {}
    for pid, p in (incoming or {}).items():
        pid = str(pid).strip().lower()[:40]
        if not pid or not all(c.isalnum() or c in "-_" for c in pid):
            raise ValueError("Policy ids are letters, numbers and dashes.")
        cleaned[pid] = clean_policy(pid, p)
    _put_setting(db, POLICIES_KEY, json.dumps(cleaned), by)
    return policies(db)


# ── Who gets which policy ───────────────────────────────────────────────────

def employee(db: Session, email: str):
    return (db.query(models.NexusEmployee)
            .filter(models.NexusEmployee.work_email == (email or "").strip().lower()).first())


def default_policy_id(db: Session, email: str, emp=None) -> str:
    import ca_breaks
    if emp is None:
        emp = employee(db, email)
    if emp is None:
        return "none"
    country = ca_breaks.country_of(db, email, emp)
    if country == "IN":
        return "in"
    rate = db.query(models.PayrollRate).filter(models.PayrollRate.employee_email == (email or "").lower()).first()
    if country in ("US", "USA") or (country == "" and rate is not None
                                    and (getattr(rate, "currency", "") or "USD").upper() == "USD"):
        rule = (getattr(rate, "overtime_rule", None) or "ca") if rate is not None else "ca"
        return "us-ca" if rule == "ca" else "us-other"
    return "none"


def on_ca_rule(db: Session, email: str, emp=None, pol: dict | None = None) -> bool:
    """Whether a person is on the California rule - the detection the CA
    sick policy uses (default_policy_id: US and the 'ca' overtime rule), or
    the CA policy itself assigned to them. Either one is enough: the law it
    stands for (leave_year_end.NO_FORFEIT_VACATION) must never be missed."""
    if pol is not None and pol.get("id") == "us-ca":
        return True
    return default_policy_id(db, email, emp) == "us-ca"


def policy_for(db: Session, email: str, emp=None, pols: dict | None = None) -> dict:
    pols = pols or policies(db)
    if emp is None:
        emp = employee(db, email)
    pid = ((getattr(emp, "leave_policy", "") or "") if emp is not None else "").strip()
    if pid not in pols:
        pid = default_policy_id(db, email, emp)
    p = dict(pols.get(pid) or pols["none"])
    p["assigned"] = bool(emp is not None and (getattr(emp, "leave_policy", "") or "") in pols)
    return p


def _start(emp) -> date | None:
    try:
        return date.fromisoformat((getattr(emp, "start_date", "") or "")[:10])
    except ValueError:
        return None


def _eligible_type(emp, pol: dict) -> bool:
    return emp is not None and (getattr(emp, "employment_type", "") or "full_time") in (pol.get("eligibleTypes") or [])


def _years_on(start: date, d: date) -> int:
    """Whole years of service completed on day d."""
    y = d.year - start.year - ((d.month, d.day) < (start.month, start.day))
    return max(0, y)


def _anniversary(start: date, years: int) -> date:
    try:
        return start.replace(year=start.year + years)
    except ValueError:              # Feb 29 start
        return start.replace(year=start.year + years, day=28)


def _tier(tiers: list, years: int) -> float:
    rate = 0.0
    for t in tiers or []:
        if years >= int(t.get("fromYears", 0)):
            rate = float(t.get("hoursPerYear", 0))
    return rate


def bucket_of(name: str) -> str:
    """Which balance a leave type / punch category draws from: vacation /
    PTO / annual leave -> vacation; sick, personal and medical -> sick (one
    balance - "sick can also mean personal"). '' = unpaid, no balance."""
    n = (name or "").strip().lower()
    if not n:
        return ""
    if any(w in n for w in ("vacation", "pto", "paid time off", "annual")):
        return "vacation"
    if any(w in n for w in ("sick", "personal", "medical")):
        return "sick"
    return ""


# ── The balance ─────────────────────────────────────────────────────────────

def _rows(db: Session, email: str, exclude_ref: str = "") -> list:
    q = (db.query(models.LeaveLedgerEntry)
         .filter(models.LeaveLedgerEntry.employee_email == (email or "").strip().lower()))
    if exclude_ref:
        # The year-end rows of the closing being worked out (leave_year_end.py)
        # are not part of the balance they close.
        q = q.filter(models.LeaveLedgerEntry.ref_id != exclude_ref)
    return (q.order_by(models.LeaveLedgerEntry.effective_date.asc(), models.LeaveLedgerEntry.created_at.asc())
            .all())


def _today(db: Session, email: str) -> date:
    from routers import timeclock
    return date.fromisoformat(timeclock._employee_today(db, email))


def request_hours(r, hours_per_day: float) -> float:
    """Hours a time-off request covers: its window on a part day, else its
    weekdays (Mon-Fri) at the policy's hours a day."""
    st, et = (getattr(r, "start_time", "") or ""), (getattr(r, "end_time", "") or "")
    if st and et:
        try:
            a = datetime.strptime(st, "%H:%M")
            b = datetime.strptime(et, "%H:%M")
            return max(0.0, (b - a).total_seconds() / 3600)
        except ValueError:
            return 0.0
    try:
        d0 = date.fromisoformat(r.start_date[:10])
        d1 = date.fromisoformat((r.end_date or r.start_date)[:10])
    except (TypeError, ValueError):
        return 0.0
    n, d = 0, d0
    while d <= d1 and n < 400:
        if d.weekday() < 5:
            n += 1
        d += timedelta(days=1)
    return n * hours_per_day


def balances(db: Session, email: str, today: date | None = None, pols: dict | None = None,
             emp=None, with_entries: bool = False, exclude_ref: str = "") -> dict:
    """{live, cutover, policy, vacation: {...}, sick: {...}} for one person.
    Each bucket: available (hours, may be negative), plus how it was made."""
    email = (email or "").strip().lower()
    if emp is None:
        emp = employee(db, email)
    cut = cutover_for(db, email, emp)
    pol = policy_for(db, email, emp, pols)
    out = {"live": bool(cut), "cutover": cut,
           "policy": {"id": pol["id"], "name": pol["name"], "unit": pol.get("unit", "hours"),
                      "hoursPerDay": pol.get("hoursPerDay", 8), "assigned": pol.get("assigned", False)},
           "startDate": (getattr(emp, "start_date", "") or "") if emp is not None else "",
           "employmentType": (getattr(emp, "employment_type", "") or "") if emp is not None else ""}
    if not cut:
        return out
    today = today or _today(db, email)
    cut_d = date.fromisoformat(cut)
    start = _start(emp)
    eligible = _eligible_type(emp, pol) and start is not None
    rows = _rows(db, email, exclude_ref)

    # Vacation: carries over (unless the company's year-end says otherwise -
    # leave_year_end.py writes that as ledger rows, so it is in `rows`). Opening + everything since the cutover + the
    # anniversary grants that fell on or after the cutover.
    vac_rows = [r for r in rows if r.bucket == "vacation"
                and (r.kind == "opening" or (r.effective_date or "") >= cut)
                and (r.effective_date or "") <= today.isoformat()]
    vac_total = sum(float(r.hours or 0) for r in vac_rows)
    grants = []
    vp = pol.get("vacation") or {}
    rate_now = 0.0
    next_tier = None
    if eligible and vp.get("method") == "anniversary":
        n = 1
        while n < 80:
            a = _anniversary(start, n)
            if a > today:
                break
            if a >= cut_d:
                h = _tier(vp.get("tiers"), n)
                if h:
                    grants.append({"date": a.isoformat(), "hours": h, "note": f"{n}-year anniversary"})
            n += 1
        nxt = _anniversary(start, _years_on(start, today) + 1)
        h = _tier(vp.get("tiers"), _years_on(start, today) + 1)
        if h:
            next_tier = {"date": nxt.isoformat(), "hours": h}
    elif eligible and vp.get("method") == "per_hour":
        yrs = _years_on(start, today)
        rate_now = _tier(vp.get("tiers"), yrs) / float(vp.get("baseHoursPerYear") or 2080)
        if not rate_now:
            first = min((int(t.get("fromYears", 0)) for t in vp.get("tiers") or [] if t.get("hoursPerYear")), default=None)
            if first is not None:
                next_tier = {"date": _anniversary(start, first).isoformat(), "hours": 0}
    vac_total += sum(g["hours"] for g in grants)

    # Sick: this calendar year only (use it or lose it; a company that
    # carries sick over gets a `carryover` row dated Jan 1 - leave_year_end.py).
    y0 = date(today.year, 1, 1).isoformat()
    sp = pol.get("sick") or {}
    sick_rows = [r for r in rows if r.bucket == "sick" and (r.effective_date or "")[:4] == str(today.year)
                 and (r.kind == "opening" or (r.effective_date or "") >= cut)
                 and (r.effective_date or "") <= today.isoformat()]
    opening = [r for r in sick_rows if r.kind == "opening"]
    sick_total = sum(float(r.hours or 0) for r in sick_rows)
    sick_grant = None
    eligible_on = ""
    if eligible and sp.get("method") == "lump":
        el = start + timedelta(days=int(sp.get("afterDays") or 0))
        eligible_on = el.isoformat()
        if el <= today and float(sp.get("hours") or 0) > 0:
            # The import already IS this year's sick time for anyone eligible
            # by the cutover - their year's grant is not added on top.
            replaced = bool(opening) and el <= cut_d and today.year == cut_d.year
            if not replaced:
                sick_grant = {"date": max(el, date.fromisoformat(y0)).isoformat(),
                              "hours": float(sp["hours"])}
                sick_total += sick_grant["hours"]

    # What is booked but not yet on a finalized card: approved time off from
    # today on, and pending requests.
    upcoming = {"vacation": 0.0, "sick": 0.0}
    pending = {"vacation": 0.0, "sick": 0.0}
    hpd = float(pol.get("hoursPerDay") or 8)
    for r in (db.query(models.TimeOffRequest)
              .filter(models.TimeOffRequest.employee_email == email,
                      models.TimeOffRequest.status.in_(["approved", "pending"]),
                      models.TimeOffRequest.end_date >= today.isoformat()).all()):
        b = bucket_of(r.type)
        if not b:
            continue
        (upcoming if r.status == "approved" else pending)[b] += request_hours(r, hpd)

    out["vacation"] = {
        "method": vp.get("method", "none"), "available": round(vac_total, 2),
        "upcoming": round(upcoming["vacation"], 2), "pending": round(pending["vacation"], 2),
        "accrualPerHour": round(rate_now, 5), "grants": grants, "next": next_tier,
        "eligible": eligible and vp.get("method", "none") != "none",
        "carriesOver": True,
    }
    out["sick"] = {
        "method": sp.get("method", "none"), "available": round(sick_total, 2),
        "upcoming": round(upcoming["sick"], 2), "pending": round(pending["sick"], 2),
        "grant": sick_grant, "eligibleOn": eligible_on,
        "eligible": bool(eligible and sp.get("method") == "lump" and eligible_on and eligible_on <= today.isoformat()
                         and (float(sp.get("hours") or 0) > 0 or sick_total > 0)),
        "expiresOn": f"{today.year}-12-31",
    }
    if with_entries:
        out["entries"] = [entry_dict(r) for r in reversed(rows)][:200]
    return out


def entry_dict(r) -> dict:
    return {"id": r.id, "bucket": r.bucket, "hours": round(float(r.hours or 0), 2), "kind": r.kind,
            "date": r.effective_date, "note": r.note or "", "by": r.created_by or "",
            "at": r.created_at or "", "refId": r.ref_id or ""}


def available(db: Session, email: str, bucket: str) -> float | None:
    """Hours left in one bucket, or None when balances aren't set up yet."""
    b = balances(db, email)
    if not b.get("live") or bucket not in b:
        return None
    return float(b[bucket]["available"])


# ── Writing ─────────────────────────────────────────────────────────────────

def add_entry(db: Session, email: str, bucket: str, hours: float, kind: str, day: str,
              note: str = "", by: str = "", ref_id: str = "") -> models.LeaveLedgerEntry:
    if bucket not in BUCKETS:
        raise ValueError("bucket must be vacation or sick")
    row = models.LeaveLedgerEntry(id=str(uuid.uuid4()), employee_email=(email or "").strip().lower(),
                                  bucket=bucket, hours=round(float(hours), 4), kind=kind,
                                  effective_date=day, ref_id=ref_id, note=(note or "")[:300],
                                  created_by=by, created_at=_now())
    db.add(row)
    return row


def set_opening(db: Session, email: str, vacation: float | None, sick: float | None, by: str) -> list:
    """The one-time import: each given bucket's opening row is replaced."""
    cut = cutover_for(db, email)
    if not cut:
        raise ValueError("Set the start date first.")
    out = []
    for bucket, hours in (("vacation", vacation), ("sick", sick)):
        if hours is None:
            continue
        (db.query(models.LeaveLedgerEntry)
         .filter(models.LeaveLedgerEntry.employee_email == email, models.LeaveLedgerEntry.bucket == bucket,
                 models.LeaveLedgerEntry.kind == "opening")
         .delete(synchronize_session=False))
        out.append(add_entry(db, email, bucket, hours, "opening", cut, "Opening balance (import)", by))
    return out


def period_entries(db: Session, email: str, start: str, end: str) -> list[dict]:
    """What a finalized period adds: vacation earned from its worked hours,
    and the sick / vacation hours it paid. Pure read - [] before the cutover."""
    import timesheet_review
    from routers import timeclock
    email = (email or "").strip().lower()
    emp = employee(db, email)
    cut = cutover_for(db, email, emp)
    if not cut or end < cut:
        return []
    pol = policy_for(db, email, emp)
    start_d = _start(emp)
    pay_type = timeclock._pay_type(db, email)
    card = timesheet_review.card_for(db, email, start, end, pay_type)
    vp = pol.get("vacation") or {}
    per_hour = (vp.get("method") == "per_hour" and _eligible_type(emp, pol) and start_d is not None)
    base = float(vp.get("baseHoursPerYear") or 2080)
    earned = 0.0
    used = {}           # (bucket, year) -> [hours, last day]
    for d in card.get("days") or []:
        ds = d.get("date") or ""
        if not ds or ds < cut or ds < start or ds > end:
            continue
        leave = {"sick": (d.get("sickMin") or 0) + (d.get("personalMin") or 0),
                 "vacation": d.get("vacationMin") or 0}
        worked = (d.get("regMin") or 0) + (d.get("otMin") or 0) + (d.get("dtMin") or 0)
        if not worked and d.get("workedMin"):
            worked = max(0, (d.get("workedMin") or 0) - leave["sick"] - leave["vacation"])
        if per_hour and worked:
            rate = _tier(vp.get("tiers"), _years_on(start_d, date.fromisoformat(ds))) / base
            earned += worked / 60 * rate
        for b, m in leave.items():
            if m:
                k = (b, ds[:4])
                cur = used.get(k, [0.0, ds])
                used[k] = [cur[0] + m / 60, max(cur[1], ds)]
    out = []
    span = f"{start} - {end}"
    if earned > 0:
        out.append({"bucket": "vacation", "hours": round(earned, 4), "kind": "accrual", "date": end,
                    "note": f"Earned in pay period {span}"})
    for (b, _y), (h, last) in sorted(used.items()):
        out.append({"bucket": b, "hours": -round(h, 4), "kind": "used", "date": last,
                    "note": f"Paid {b} in pay period {span}"})
    return out


def record_period(db: Session, email: str, start: str, end: str, ref_id: str, by: str = "") -> int:
    """Write a finalized period's leave rows (replacing any for the same
    finalize row). Everything is computed before anything is written."""
    entries = period_entries(db, email, start, end)
    (db.query(models.LeaveLedgerEntry).filter(models.LeaveLedgerEntry.ref_id == ref_id)
     .delete(synchronize_session=False))
    for e in entries:
        add_entry(db, email, e["bucket"], e["hours"], e["kind"], e["date"], e["note"], by or "system", ref_id)
    return len(entries)


def remove_period(db: Session, ref_id: str) -> int:
    if not ref_id:
        return 0
    return (db.query(models.LeaveLedgerEntry).filter(models.LeaveLedgerEntry.ref_id == ref_id)
            .delete(synchronize_session=False))
