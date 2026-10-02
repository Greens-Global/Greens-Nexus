"""Which workday a moment belongs to - the shift's day, not the calendar's.

Oct 2 (Pranshu): a 6:30 PM - 2:30 AM IST shift's End-of-day message, sent at
2:30 AM, was filed under the NEXT day, and the People > Work Logs tab then
showed every night-shift EOD one day late beside the wrong punch-out - an
audit record that disagreed with the timecard. Payroll already had the rule
right (_day_summaries / _compute_timecard: an overnight shift is ONE segment
on the day it STARTED); BOD/EOD dating and the Work Logs pairing did not use it.

The rule, for every country: a shift's day is the `local_date` of the clock-in
that opened it. That date is stamped from the punching device's own UTC offset
(TimePunch.tz_offset_min), so it is the employee's wall-clock date wherever
they are - nothing here depends on the server's or the viewer's time zone.
A moment inside an open shift belongs to that shift's day; a moment outside
any shift belongs to its own local date.

Pure functions over punch rows plus one query helper, shared by timeclock.py
and hr.py so the two cannot drift.
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from models import TimePunch

# The pairing guard every timeclock surface uses (timeclock._MAX_SHIFT_MIN): a
# clock-in left open longer than this is a missed clock-out, not a shift.
MAX_SHIFT_MIN = 16 * 60


def _ts(at: str) -> Optional[datetime]:
    try:
        return datetime.strptime((at or "")[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def local_date_at(utc_iso: str, tz_offset_min: int) -> str:
    """The wall-clock date at `utc_iso` for a device whose JS
    getTimezoneOffset() was `tz_offset_min` (UTC - local, so local = UTC - offset)."""
    dt = _ts(utc_iso) or datetime.now(timezone.utc)
    return (dt - timedelta(minutes=tz_offset_min or 0)).strftime("%Y-%m-%d")


def shifts(punches) -> list:
    """Clock-in / clock-out pairs over punches ordered by `at` (voided ones
    skipped), the same pairing payroll uses: a clock-in opens a shift, the next
    clock-out closes it, breaks stay inside. Each: {day, in_at, out_at, in_id,
    out_id}. `day` is the clock-in's local_date; a clock-out with no open
    clock-in is its own entry on its own date (in_at ''); a shift whose
    clock-out never came has out_at ''."""
    out, cur = [], None
    for p in punches:
        if getattr(p, "voided", 0):
            continue
        if p.kind == "in":
            if cur:
                out.append(cur)                      # prior shift never closed
            cur = {"day": p.local_date, "in_at": p.at, "out_at": "", "in_id": p.id, "out_id": "",
                   "in_tz": getattr(p, "tz_offset_min", 0) or 0, "out_tz": 0}
        elif p.kind == "out":
            if cur:
                cur["out_at"], cur["out_id"], cur["out_tz"] = p.at, p.id, getattr(p, "tz_offset_min", 0) or 0
                out.append(cur)
                cur = None
            else:
                out.append({"day": p.local_date, "in_at": "", "out_at": p.at, "in_id": "", "out_id": p.id,
                            "in_tz": 0, "out_tz": getattr(p, "tz_offset_min", 0) or 0})
    if cur:
        out.append(cur)
    return out


def shift_for(punches, at: str) -> Optional[dict]:
    """The shift `at` falls inside (clock-in <= at, and at <= clock-out or the
    shift is still open within the guard), or None."""
    t = _ts(at)
    if not t:
        return None
    for s in reversed(shifts(punches)):
        tin = _ts(s["in_at"])
        if not tin or tin > t:
            continue
        tout = _ts(s["out_at"])
        if tout is not None:
            return s if t <= tout else None
        return s if (t - tin).total_seconds() <= MAX_SHIFT_MIN * 60 else None
    return None


def shift_day(db: Session, email: str, at: str, tz_offset_min: int, *, grace_min: int = 0) -> str:
    """The workday the moment `at` (UTC ISO) belongs to for `email`: the day of
    the shift it falls inside, else the device's local date at `at`.
    `grace_min` also counts a shift that CLOSED up to that many minutes before
    `at` - an End-of-day message composed right after the clock-out still
    belongs to the shift it reports on."""
    t = _ts(at)
    if not t:
        return local_date_at(at, tz_offset_min)
    since = (t - timedelta(minutes=MAX_SHIFT_MIN + grace_min)).strftime("%Y-%m-%dT%H:%M:%S")
    punches = (db.query(TimePunch)
               .filter(TimePunch.employee_email == email, TimePunch.voided == 0,
                       TimePunch.kind.in_(("in", "out")), TimePunch.at >= since,
                       TimePunch.at <= at[:19])
               .order_by(TimePunch.at.asc()).all())
    s = shift_for(punches, at)
    if s is None and grace_min:
        last = next((x for x in reversed(shifts(punches)) if x["in_at"] and x["out_at"]), None)
        tout = _ts(last["out_at"]) if last else None
        if tout and timedelta(0) <= t - tout <= timedelta(minutes=grace_min):
            s = last
    return s["day"] if s else local_date_at(at, tz_offset_min)


def shift_bounds_by_day(punches) -> dict:
    """day -> {first_in, last_out, in_tz, out_tz} over the shifts that STARTED
    that day - the clock-in that opened the workday and the clock-out that
    closed it, even when that clock-out falls after midnight. *_tz is the
    punching device's UTC offset, so a reader can show the employee's own
    wall-clock time rather than the viewer's."""
    by = {}
    for s in shifts(punches):
        d = by.setdefault(s["day"], {"first_in": "", "last_out": "", "in_tz": 0, "out_tz": 0})
        if s["in_at"] and not d["first_in"]:
            d["first_in"], d["in_tz"] = s["in_at"], s["in_tz"]
        if s["out_at"]:
            d["last_out"], d["out_tz"] = s["out_at"], s["out_tz"]
    return by
