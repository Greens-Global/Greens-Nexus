"""
Today's shift for the clock's shift track (Neil, 11/02/2026, mock
https://claude.ai/artifact/PwncxMck8YaSkFkQ8hmTHE section 1), as GET
/timeclock/status carries it.

`lookup(db, email, workday, now)` returns:
  shifts  every expected shift around the workday, as drawable spans
          ({start, end, startUtc, endUtc, source, date}), earliest first -
          the workday's own (a split shift gives each placement), the day
          before's while its end is within RECENT_HOURS (an overnight shift
          just finished, or still running past midnight), and the day after's
          starting within SOON_HOURS (a midnight shift about to begin).
  shift   the one to draw at `now` (pick), or None.
  exp     shift_expect.expected_start for the workday - unchanged, for the
          early clock-in hint (Late reads it elsewhere).

The rule is shift_expect's (published placements win, a weather-cancelled
day is no shift, else the usual-hours preset); this module only frames it
in time. The status route is polled every 20-25 s per person, so the answer
is cached in-process per (email, workday) for CACHE_SECONDS - a schedule
change shows within a minute - and the read runs inside a savepoint, so a
database error leaves the rest of the status read untouched (a failed
statement would otherwise abort the whole transaction on Postgres).
"""
import threading
import time
from datetime import date, datetime, timedelta, timezone
from typing import Optional

import shift_expect

CACHE_SECONDS = 60
RECENT_HOURS = 6      # the day before's shift, while it ended this recently
SOON_HOURS = 6        # the day after's shift, when it starts this soon
NEXT_WINDOW_HOURS = 4  # an upcoming shift this close wins over one that ended

_cache: dict = {}
_lock = threading.Lock()


def clear_cache() -> None:
    with _lock:
        _cache.clear()


def _stamp(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def spans(by_day: dict, workday: date, now: datetime) -> list:
    """The drawable shifts around `workday` (see the module docstring)."""
    out = []
    for dd, shifts in sorted((by_day or {}).items()):
        for exp in shifts or []:
            s, e = shift_expect.start_utc(dd, exp), shift_expect.end_utc(dd, exp)
            if s is None or e is None or e <= s:
                continue
            if dd < workday and e < now - timedelta(hours=RECENT_HOURS):
                continue
            if dd > workday and s > now + timedelta(hours=SOON_HOURS):
                continue
            out.append({"start": exp.get("start") or "", "end": exp.get("end") or "",
                        "startUtc": _stamp(s), "endUtc": _stamp(e),
                        "source": exp.get("source") or "", "date": dd.isoformat()})
    out.sort(key=lambda x: (x["startUtc"], x["endUtc"]))
    return out


def pick(shifts: list, now: datetime) -> Optional[dict]:
    """The shift to draw at `now`: the one running, else one starting within
    NEXT_WINDOW_HOURS, else the last one that ended, else the next. The
    browser re-picks with the clock state (lib/shiftTrack.js pickShift) as
    time moves; this is the same order without it."""
    if not shifts:
        return None
    running = [x for x in shifts if _parse(x["startUtc"]) <= now < _parse(x["endUtc"])]
    if running:
        return running[-1]
    upcoming = [x for x in shifts if _parse(x["startUtc"]) > now]
    if upcoming and _parse(upcoming[0]["startUtc"]) - now <= timedelta(hours=NEXT_WINDOW_HOURS):
        return upcoming[0]
    ended = [x for x in shifts if _parse(x["endUtc"]) <= now]
    if ended:
        return max(ended, key=lambda x: x["endUtc"])
    return upcoming[0] if upcoming else None


def _compute(db, email: str, workday: date, now: datetime) -> dict:
    by_day = shift_expect.expected_shifts(db, email, [workday - timedelta(days=1), workday, workday + timedelta(days=1)])
    return {"shifts": spans(by_day, workday, now), "exp": shift_expect.expected_start(db, email, workday)}


def lookup(db, email: str, workday: date, now: Optional[datetime] = None) -> dict:
    """{shifts, shift, exp} for one person's workday (see the module
    docstring). Never raises: a failure gives no shifts and no exp."""
    now = now or datetime.now(timezone.utc)
    key = ((email or "").strip().lower(), workday.isoformat())
    hit = None
    with _lock:
        got = _cache.get(key)
        if got and time.monotonic() - got[0] < CACHE_SECONDS:
            hit = got[1]
    if hit is None:
        try:
            with db.begin_nested():
                hit = _compute(db, email, workday, now)
        except Exception as e:   # a hint only - never fail the clock for it
            print(f"[today_shift] skipped for {email}: {e}")
            return {"shifts": [], "shift": None, "exp": None}
        with _lock:
            if len(_cache) > 5000:
                _cache.clear()
            _cache[key] = (time.monotonic(), hit)
    # The day before's / after's windows move with `now`; re-frame the cached
    # list so a minute-old answer never shows a shift that has left them.
    shifts = [x for x in hit["shifts"]
              if not (x["date"] < key[1] and _parse(x["endUtc"]) < now - timedelta(hours=RECENT_HOURS))]
    return {"shifts": shifts, "shift": pick(shifts, now), "exp": hit["exp"]}
