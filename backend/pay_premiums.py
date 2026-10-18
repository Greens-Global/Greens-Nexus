"""Shift differentials and call-back pay (Neil, Oct 17 2026).

OFF BY DEFAULT, per company (Settings > Global Settings > Time Clock > Pay
Rules). While a company has it off, nothing here touches a time sheet: the
timecard engine (routers/timeclock._compute_timecard) gets an empty result
back and its output - days, totals, exports, finalize, Retro Pay - is exactly
what it was before this module existed.

When a company turns it on, HR defines:

- Differentials: a name ("Night Differential"), a flat amount per hour OR a
  percent of the base rate, and WHEN it applies - a time-of-day window in
  the employee's local time (the in-punch's tz offset; a window may cross
  midnight, e.g. 22:00-06:00), and/or days of the week, and optionally only
  certain work sites. It pays the WORKED minutes that fall inside the window
  (segments are split at the window edges; unpaid break minutes inside the
  window do not count). With a window AND days, the days name the day a
  window STARTS (a Fri 22:00-06:00 window covers Friday night into Saturday
  morning); with days and no window, a minute counts on its own calendar day.
  Two rules that cover the same minute both pay (they stack).

  Overtime: the differential is its own pay line for the qualifying hours,
  on top of the regular / overtime pay - it is NOT folded into the overtime
  rate. TODO (open question for HR / counsel): federal regular-rate-of-pay
  rules (29 CFR 778.207) and California include shift differentials in the
  regular rate, so a week with differential hours AND overtime may owe an
  extra 0.5x (1.0x for double time) of the differential's per-hour average
  on the overtime hours. That adjustment is not computed here.

- Call-back pay: someone who clocks in again on the same day after being
  clocked out for at least `gapMin` (default 60), for a stint shorter than
  `minimumMin` (default 120), is paid the shortfall at the base rate as
  "Call-Back Pay". Those minutes are not hours worked and never feed
  overtime. Each call-back stint is judged on its own.

Hourly employees only: fixed-salary and time-tracking-exempt people are
never priced here.

A FINALIZED period keeps the rules it was finalized with (the finalize
snapshot carries them under "premiums"); a period finalized while the
feature was off (or before it existed) has no "premiums" and stays off, so
turning the feature on never re-prices a locked, paid period. Each day of a
finalized period keeps its frozen rate (the per-day snapshot), which is the
base a percent differential and call-back pay are priced from.

Known simplifications (open questions): a segment uses its clock-in's tz
offset throughout (a DST change mid-shift is not re-split); an auto-lunch
deduction comes off the window's minutes only through the cap at the
segment's paid minutes; the first stint of a day is never a call-back (a
call-out after midnight following a late shift is not caught).

Storage: one `nexus_settings` row, {company_id: config}.
"""
import json
import re
import uuid
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from models import NexusSetting

SETTING_KEY = "timeclock_pay_premiums"
MAX_RULES = 20
MAX_NAME = 40
MAX_SITES = 100
_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
CALLBACK_DEFAULT = {"enabled": False, "minimumMin": 120, "gapMin": 60}
DEFAULT = {"enabled": False, "differentials": [], "callBack": dict(CALLBACK_DEFAULT)}


# ── Settings ──────────────────────────────────────────────────────────────────

def _stored(db: Session) -> dict:
    row = db.query(NexusSetting).filter(NexusSetting.key == SETTING_KEY).first()
    if not row or not row.value:
        return {}
    try:
        raw = json.loads(row.value)
    except (ValueError, TypeError):
        return {}
    return raw if isinstance(raw, dict) else {}


def _num(v, default=0.0) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if f == f else default   # NaN -> default


def clean(cfg, strict: bool = False) -> dict:
    """A config with every field in range. `strict` (a save) raises
    ValueError on a rule HR has to fix instead of quietly dropping it."""
    cfg = cfg if isinstance(cfg, dict) else {}
    out = {"enabled": bool(cfg.get("enabled")), "differentials": [], "callBack": dict(CALLBACK_DEFAULT)}
    seen = set()
    rules = cfg.get("differentials") if isinstance(cfg.get("differentials"), list) else []
    if strict and len(rules) > MAX_RULES:
        raise ValueError(f"At most {MAX_RULES} differentials per company.")
    for r in rules[:MAX_RULES]:
        if not isinstance(r, dict):
            continue
        name = " ".join(str(r.get("name") or "").split())[:MAX_NAME]
        kind = r.get("kind") if r.get("kind") in ("flat", "percent") else ""
        amount = round(_num(r.get("amount")), 4)
        start = str(r.get("start") or "").strip()
        end = str(r.get("end") or "").strip()
        days = sorted({int(d) for d in (r.get("days") or []) if str(d).lstrip("-").isdigit() and 0 <= int(d) <= 6})
        sites = sorted({str(s).strip() for s in (r.get("sites") or []) if str(s).strip()})[:MAX_SITES]
        problem = ""
        if not name:
            problem = "Every differential needs a name."
        elif name.lower() in seen:
            problem = f"Two differentials are named \"{name}\" - give each its own name."
        elif not kind:
            problem = f"{name}: choose a flat amount per hour or a percent of the base rate."
        elif amount <= 0 or (kind == "flat" and amount > 1000) or (kind == "percent" and amount > 200):
            problem = (f"{name}: the amount must be more than 0 and at most "
                       f"{'$1,000 per hour' if kind == 'flat' else '200%'}.")
        elif bool(start) != bool(end) or (start and (not _HHMM.match(start) or not _HHMM.match(end))):
            problem = f"{name}: give both a start and an end time, or neither."
        elif start and start == end:
            problem = f"{name}: the start and end times are the same."
        if problem:
            if strict:
                raise ValueError(problem)
            continue
        seen.add(name.lower())
        out["differentials"].append({"id": str(r.get("id") or "")[:64] or str(uuid.uuid4()), "name": name,
                                     "kind": kind, "amount": amount, "start": start, "end": end,
                                     "days": days, "sites": sites})
    cb = cfg.get("callBack") if isinstance(cfg.get("callBack"), dict) else {}
    out["callBack"] = {"enabled": bool(cb.get("enabled")),
                       "minimumMin": int(min(720, max(15, _num(cb.get("minimumMin"), 120)))),
                       "gapMin": int(min(720, max(0, _num(cb.get("gapMin"), 60))))}
    return out


def config(db: Session, company_id: str) -> dict:
    """One company's config (the defaults - off - when it has none)."""
    raw = _stored(db).get(company_id or "")
    return clean(raw) if raw else clean(DEFAULT)


def save(db: Session, company_id: str, cfg: dict, by: str) -> dict:
    """Replace one company's config. Raises ValueError on a rule to fix.
    Commits; returns the saved config."""
    cfg = clean(cfg, strict=True)
    stored = _stored(db)
    stored[company_id or ""] = cfg
    row = db.query(NexusSetting).filter(NexusSetting.key == SETTING_KEY).first()
    if not row:
        row = NexusSetting(key=SETTING_KEY)
        db.add(row)
    row.value = json.dumps(stored, sort_keys=True)
    row.updated_by = by
    db.commit()
    return cfg


def active(cfg) -> bool:
    """True when the config can pay anything at all."""
    return bool(cfg and cfg.get("enabled") and (cfg.get("differentials") or (cfg.get("callBack") or {}).get("enabled")))


# ── Math (pure) ───────────────────────────────────────────────────────────────

def _dow(d) -> int:
    """0 = Sunday ... 6 = Saturday (JavaScript's getDay)."""
    return (d.weekday() + 1) % 7


def _hm(s: str) -> timedelta:
    h, m = s.split(":")
    return timedelta(hours=int(h), minutes=int(m))


def _occurrences(rule: dict, a: datetime, b: datetime):
    """The rule's windows (local, naive) that can touch [a, b)."""
    days = set(rule.get("days") or [])
    day = (a - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    last = b.replace(hour=0, minute=0, second=0, microsecond=0)
    while day <= last:
        if not days or _dow(day) in days:
            if rule.get("start"):
                s, e = day + _hm(rule["start"]), day + _hm(rule["end"])
                if e <= s:            # crosses midnight
                    e += timedelta(days=1)
                yield s, e
            else:
                yield day, day + timedelta(days=1)
        day += timedelta(days=1)


def _overlap_min(a: datetime, b: datetime, wins) -> float:
    tot = 0.0
    for s, e in wins:
        lo, hi = max(a, s), min(b, e)
        if hi > lo:
            tot += (hi - lo).total_seconds() / 60
    return tot


def qualifying_minutes(rule: dict, start: datetime, end: datetime, breaks=(), worked_min: int = 0,
                       site_id: str = "") -> int:
    """Worked minutes of one segment [start, end) (LOCAL naive times) that the
    rule pays. `breaks` = [(start, end, unpaid fraction)] inside the segment;
    their unpaid part inside the window is not worked. Capped at the
    segment's paid `worked_min` (an auto-lunch deduction has no clock time,
    so it comes off the total, not off the window)."""
    sites = rule.get("sites") or []
    if sites and site_id not in sites:
        return 0
    if end <= start:
        return 0
    wins = list(_occurrences(rule, start, end))
    q = _overlap_min(start, end, wins)
    for bs, be, frac in breaks:
        if be > bs and frac > 0:
            q -= _overlap_min(bs, be, wins) * frac
    return int(max(0, min(worked_min, round(q))))


def rule_pay(rule: dict, minutes: int, rate: float) -> float:
    per_hour = rule["amount"] if rule["kind"] == "flat" else rate * rule["amount"] / 100.0
    return round(minutes / 60 * per_hour, 2)


def callback_shortfalls(stints: list, cb: dict) -> list:
    """`stints` = one day's worked segments in order as (in, out, worked
    minutes), UTC or local - only the gaps matter. Returns the shortfall in
    minutes of each stint that is a call-back: it starts at least `gapMin`
    after the stint before it ended and is shorter than `minimumMin`."""
    if not cb or not cb.get("enabled"):
        return []
    out = []
    prev_out = None
    for t_in, t_out, wm in stints:
        if prev_out is not None and (t_in - prev_out).total_seconds() / 60 >= cb["gapMin"] \
                and wm < cb["minimumMin"]:
            out.append(cb["minimumMin"] - wm)
        prev_out = t_out if prev_out is None else max(prev_out, t_out)
    return out


def _naive(s: str):
    try:
        return datetime.strptime((s or "")[:19], "%Y-%m-%dT%H:%M:%S")
    except (TypeError, ValueError):
        return None


def price_days(cfg: dict, days: list, *, tz_of, site_of, round_at) -> dict:
    """Add the differential and call-back lines to the time sheet's day rows
    (in place) and return the period totals. `days` are _compute_timecard's
    day rows (each with its `rate` and `segments`); `tz_of(punch_id)` gives
    a punch's tz offset (JavaScript getTimezoneOffset: local = UTC - offset);
    `site_of(segment)` its work site id; `round_at(iso)` a raw punch time
    rounded the way the time sheet rounds it (naive UTC)."""
    rules = cfg.get("differentials") or []
    cb = cfg.get("callBack") or {}
    by_rule = {r["id"]: {"name": r["name"], "min": 0, "pay": 0.0} for r in rules}
    t_diff_min = t_cb_min = 0
    t_diff_pay = t_cb_pay = 0.0
    for d in days:
        rate = float(d.get("rate") or 0)
        worked = [s for s in d.get("segments") or []
                  if not s.get("payClass") and s.get("out") and s.get("in") and (s.get("workedMin") or 0) > 0
                  and "auto_clock_out" not in (s.get("flags") or [])]
        lines = []
        day_min, day_pay = 0, 0.0
        for r in rules:
            rm = 0
            for s in worked:
                a, b = _naive(s.get("inR")), _naive(s.get("outR"))
                if a is None or b is None:
                    continue
                off = timedelta(minutes=int(tz_of(s.get("inId")) or 0))
                brks = []
                for w in s.get("breaks") or []:
                    bs, be = round_at(w.get("start")), round_at(w.get("end"))
                    if bs is None or be is None:
                        continue
                    bm = int(w.get("min") or 0)
                    frac = 1.0 - (min(bm, int(w.get("paidMin") or 0)) / bm) if bm > 0 else 1.0
                    brks.append((bs - off, be - off, frac))
                rm += qualifying_minutes(r, a - off, b - off, brks, int(s["workedMin"]), site_of(s))
            if rm:
                pay = rule_pay(r, rm, rate)
                lines.append({"name": r["name"], "min": rm, "pay": pay})
                by_rule[r["id"]]["min"] += rm
                by_rule[r["id"]]["pay"] = round(by_rule[r["id"]]["pay"] + pay, 2)
                day_min += rm
                day_pay = round(day_pay + pay, 2)
        if lines:
            d["differentials"], d["diffMin"], d["diffPay"] = lines, day_min, day_pay
            t_diff_min += day_min
            t_diff_pay = round(t_diff_pay + day_pay, 2)
        stints = sorted(((_naive(s.get("inR")), _naive(s.get("outR")), int(s["workedMin"])) for s in worked
                         if _naive(s.get("inR")) and _naive(s.get("outR"))), key=lambda x: x[0])
        short = sum(callback_shortfalls(stints, cb))
        if short:
            d["callBackMin"], d["callBackPay"] = short, round(short / 60 * rate, 2)
            t_cb_min += short
            t_cb_pay = round(t_cb_pay + d["callBackPay"], 2)
    return {"diffMin": t_diff_min, "diffPay": t_diff_pay,
            "differentials": [v for v in by_rule.values() if v["min"]],
            "callBackMin": t_cb_min, "callBackPay": t_cb_pay}


def add_totals(totals: dict, prem: dict) -> None:
    """Fold the premium totals into a card's totals (in place)."""
    totals.update(prem)
    totals["totalPay"] = round(float(totals.get("totalPay") or 0) + prem["diffPay"] + prem["callBackPay"], 2)
