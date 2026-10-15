"""Shifts Phase 2 - rules before publish (Neil, Oct 14 2026).

Five schedule rules, set per company in Settings > Shifts
(routers/shift_requests._DEFAULTS; 0 turns a rule off):

  ruleMinRestHours   rest between one shift's end and the next one's start
  ruleMaxDaysInRow   worked days in a row
  ruleDailyOtHours   paid hours in a day - only people whose overtime rule
                     (PayrollRate.overtime_rule) is 'ca' have daily overtime
  ruleWeeklyOtHours  paid hours in a week ('ca' and 'federal'; 'none' skips
                     both overtime rules but keeps the rest)
  ruleMaxWeekHours   paid hours in a week, everyone

Rules WARN - they never block a save. The grid shows a warning the same way
it shows a conflict (the dot), the Add/Edit Shift dialog lists it live, and
sharing a schedule that carries a warning asks for a reason
(publishReasonRequired, routers/timeclock publish review).

`evaluate` is pure: one person's shifts across a window, as dicts
{id, date, start, end, paidMin, cancelled} -> {shift id: [sentences]}. A
weather-cancelled day is not worked: it counts no hours and does not
continue a days-in-a-row streak. An end at or before the start runs past
midnight (the same rule as routers/timeclock._interval); an overnight
shift's hours count on the day it starts. `rule_warnings` loads the live
schedule for real people - the scheduler's view, pending edits applied and
pending removals left out - and runs it per person with their company's
settings and their overtime rule.
"""
from datetime import datetime, timedelta, date

RULE_KEYS = ("ruleMinRestHours", "ruleMaxDaysInRow", "ruleDailyOtHours", "ruleWeeklyOtHours", "ruleMaxWeekHours")
# Days loaded either side of a window so a streak, a week or last night's
# shift that started before it still counts (ruleMaxDaysInRow caps at 14).
PAD_DAYS = 14


def _hm(minutes) -> str:
    h, m = divmod(max(0, int(round(minutes))), 60)
    return f"{h}h {m:02d}m"


def _ordinal(n: int) -> str:
    if 10 <= n % 100 <= 20:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def _day(iso: str):
    try:
        return datetime.strptime((iso or "")[:10], "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


def _span(d: date, start: str, end: str):
    """(start, end) datetimes; an end at or before the start runs into the
    next day. None when the times do not parse or the shift has no length."""
    try:
        s = datetime(d.year, d.month, d.day, int(start[:2]), int(start[3:5]))
        e = datetime(d.year, d.month, d.day, int(end[:2]), int(end[3:5]))
    except (ValueError, TypeError, IndexError):
        return None
    if e == s:
        return None
    if e < s:
        e += timedelta(days=1)
    return s, e


def week_of(d: date, week_start: str = "monday") -> date:
    """The first day of the week `d` falls in."""
    off = 6 if (week_start or "").lower() == "sunday" else 0
    return d - timedelta(days=(d.weekday() - off) % 7)


def _int(cfg: dict, key: str) -> int:
    try:
        return max(0, int(cfg.get(key) or 0))
    except (TypeError, ValueError):
        return 0


def evaluate(shifts: list, cfg: dict, ot_rule: str = "ca", week_start: str = "monday") -> dict:
    """One person's shifts across a window -> {shift id: [warning sentences]}.
    Each shift: {id, date (YYYY-MM-DD), start, end (HH:MM), paidMin, cancelled}."""
    out = {}

    def warn(sid, text):
        out.setdefault(sid, []).append(text)

    items = []
    for s in shifts or []:
        d = _day(s.get("date"))
        if d is None:
            continue
        cancelled = bool(s.get("cancelled"))
        try:
            paid = 0 if cancelled else max(0, int(s.get("paidMin") or 0))
        except (TypeError, ValueError):
            paid = 0
        iv = _span(d, str(s.get("start") or ""), str(s.get("end") or ""))
        items.append({"id": s.get("id"), "d": d, "iv": iv, "paid": paid, "cancelled": cancelled,
                      "key": (iv[0] if iv else datetime(d.year, d.month, d.day), str(s.get("id") or ""))})
    worked = sorted((i for i in items if not i["cancelled"]), key=lambda i: i["key"])
    rule = (ot_rule or "ca").lower()

    # Rest between consecutive shifts: measured from the latest end so far.
    rest_h = _int(cfg, "ruleMinRestHours")
    if rest_h > 0:
        latest = None
        for i in worked:
            if not i["iv"]:
                continue
            if latest is not None:
                gap = (i["iv"][0] - latest[1]).total_seconds() / 60
                # An overlap is a conflict (_shift_conflicts), not a rest problem.
                if 0 <= gap < rest_h * 60:
                    warn(i["id"], f"Only {_hm(gap)} rest before this shift ({rest_h}h minimum).")
            if latest is None or i["iv"][1] > latest[1]:
                latest = i["iv"]

    # Days in a row: every worked day past the limit.
    max_days = _int(cfg, "ruleMaxDaysInRow")
    if max_days > 0:
        streak, prev = 0, None
        for d in sorted({i["d"] for i in worked}):
            streak = streak + 1 if prev is not None and (d - prev).days == 1 else 1
            prev = d
            if streak > max_days:
                for i in worked:
                    if i["d"] == d:
                        warn(i["id"], f"{_ordinal(streak)} day in a row ({max_days} is the most).")

    # Daily overtime (California only).
    daily = _int(cfg, "ruleDailyOtHours")
    if daily > 0 and rule == "ca":
        by_day = {}
        for i in worked:
            by_day[i["d"]] = by_day.get(i["d"], 0) + i["paid"]
        for d, tot in by_day.items():
            if tot > daily * 60:
                for i in worked:
                    if i["d"] == d:
                        warn(i["id"], f"{_hm(tot)} scheduled this day (over {daily}h is overtime).")

    # Weekly overtime ('ca' and 'federal') and the hard weekly cap (everyone):
    # the warning lands on the shift that crosses the line and every one after.
    weekly = _int(cfg, "ruleWeeklyOtHours") if rule in ("ca", "federal") else 0
    max_wk = _int(cfg, "ruleMaxWeekHours")
    if weekly > 0 or max_wk > 0:
        by_week = {}
        for i in worked:
            by_week.setdefault(week_of(i["d"], week_start), []).append(i)
        for lst in by_week.values():
            tot = sum(i["paid"] for i in lst)
            cum = 0
            for i in lst:
                cum += i["paid"]
                if weekly > 0 and tot > weekly * 60 and cum > weekly * 60:
                    warn(i["id"], f"{_hm(tot)} scheduled this week (over {weekly}h is overtime).")
                if max_wk > 0 and tot > max_wk * 60 and cum > max_wk * 60:
                    warn(i["id"], f"{_hm(tot)} scheduled this week ({max_wk}h is the most).")
    return out


# ── The live schedule ─────────────────────────────────────────────────────

def as_rule_shift(sd: dict) -> dict:
    """A _sched_dict (or any dict with id/date/start/end/paidMin) -> what
    evaluate() reads."""
    return {"id": sd.get("id"), "date": sd.get("date"), "start": sd.get("start"), "end": sd.get("end"),
            "paidMin": sd.get("paidMin") or 0,
            "cancelled": bool(sd.get("cancelled")) or (sd.get("weatherStatus") or "") == "cancelled"}


def person_shifts(db, emails, lo: str, hi: str) -> dict:
    """{email: [rule shifts]} - each person's effective schedule in [lo, hi]:
    pending edits applied (the scheduler's view), pending removals and open
    slots left out."""
    from sqlalchemy import func
    from models import ScheduledShift, Shift
    from routers.timeclock import _sched_dict
    emails = sorted({(e or "").lower() for e in emails if e})
    out = {}
    if not emails:
        return out
    presets = {s.id: s for s in db.query(Shift).all()}
    rows = (db.query(ScheduledShift)
            .filter(func.lower(ScheduledShift.employee_email).in_(emails),
                    ScheduledShift.work_date >= lo, ScheduledShift.work_date <= hi).all())
    for r in rows:
        if getattr(r, "pending_delete", 0) or not r.employee_email:
            continue
        out.setdefault((r.employee_email or "").lower(), []).append(as_rule_shift(_sched_dict(r, presets, effective=True)))
    return out


def config_for(db, emails) -> dict:
    """{email: (that person's company settings, their overtime rule)}."""
    from sqlalchemy import func
    from auth import company_of_email_map
    from models import PayrollRate
    from routers.shift_requests import get_settings
    emails = sorted({(e or "").lower() for e in emails if e})
    if not emails:
        return {}
    companies = company_of_email_map(db)
    rates = {(r.employee_email or "").lower(): (r.overtime_rule or "ca").lower()
             for r in db.query(PayrollRate).filter(func.lower(PayrollRate.employee_email).in_(emails)).all()}
    by_company = {}
    out = {}
    for em in emails:
        cid = companies.get(em, "") or ""
        if cid not in by_company:
            by_company[cid] = get_settings(db, cid)
        out[em] = (by_company[cid], rates.get(em) or "ca")
    return out


def rule_warnings(db, emails, start: str, end: str, extra: list = None, exclude_ids=None) -> dict:
    """{shift id: [warning sentences]} for every effective shift of these
    people dated in [start, end] (the grid, the publish review). `extra` adds
    hypothetical shifts ({id, email, date, start, end, paidMin}) - the
    Add/Edit Shift dialog's live check - and `exclude_ids` drops rows (the
    one being edited). PAD_DAYS either side are loaded so earlier shifts
    still count toward rest, streaks and the week."""
    emails = {(e or "").lower() for e in (emails or []) if e}
    extra = [x for x in (extra or []) if (x.get("email") or "").strip()]
    emails |= {x["email"].strip().lower() for x in extra}
    if not emails:
        return {}
    d0, d1 = _day(start), _day(end)
    if d0 is None or d1 is None:
        return {}
    lo, hi = (d0 - timedelta(days=PAD_DAYS)).isoformat(), (d1 + timedelta(days=PAD_DAYS)).isoformat()
    shifts = person_shifts(db, emails, lo, hi)
    drop = {str(i) for i in (exclude_ids or []) if i}
    keep = set()
    for x in extra:
        rs = as_rule_shift(x)
        keep.add(rs["id"])
        shifts.setdefault(x["email"].strip().lower(), []).append(rs)
    conf = config_for(db, emails)
    out = {}
    for em, lst in shifts.items():
        lst = [s for s in lst if str(s.get("id")) not in drop]
        cfg, rule = conf.get(em) or ({}, "ca")
        found = evaluate(lst, cfg, rule, cfg.get("weekStart") or "monday")
        dated = {s["id"]: s["date"] for s in lst}
        for sid, texts in found.items():
            if sid in keep or (start[:10] <= (dated.get(sid) or "")[:10] <= end[:10]):
                out[sid] = texts
    return out
