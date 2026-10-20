"""The AM / PM guard on entered punch times (Charmi, Oct 21 2026).

SwipeClock refuses an OUT time more than 11 hours from the first entry of
the punch ("Is it possible that AM/PM have been mis-entered?"). Nexus warns
the same way wherever a time is typed - the manager's Edit / Add, the
employee's punch fix / missing-time request and edit, the break fixer - and
offers the AM / PM flip when that makes a sane shift.

Pure: callers pass the person's other punches as (kind, utc datetime) pairs,
so the rule is testable without a database. The frontend twin is
frontend/src/lib/longShift.js - keep the wording the same.

Managers / HR may save a long shift anyway (a real double shift); an
employee's request needs `confirm_long` plus their reason, so an approver
always sees why.
"""
from __future__ import annotations

from datetime import datetime, timedelta

LONG_SHIFT_MIN = 11 * 60
# Punches further apart than this are never the same shift (the pairing
# guard elsewhere stops at 16 h); a clock-in days back is a missing punch,
# not an AM / PM slip.
_REACH = timedelta(hours=24)


def _span(others: list, kind: str, at: datetime):
    """(first, last) of the shift the punch `kind` at `at` would sit in, or
    None when it is not inside one (no clock-in before it, nothing to pair)."""
    seq = sorted([(t, k, False) for k, t in others] + [(at, kind, True)], key=lambda x: (x[0], not x[2]))
    i = next(n for n, x in enumerate(seq) if x[2])
    first = last = None
    if kind == "in":
        first = at
    else:
        for t, k, _new in reversed(seq[:i]):
            if at - t > _REACH or k == "out":
                break
            if k == "in":
                first = t
                break
    if kind == "out":
        last = at
    else:
        for t, k, _new in seq[i + 1:]:
            if t - at > _REACH or k == "in":
                break
            if k == "out":
                last = t
                break
    if first is None:
        return None
    if last is None:
        if kind == "in":
            return None          # a clock-in with nothing after it yet - no span to judge
        last = at                # a break / out: judged from the shift's first punch
    if last <= first:
        return None              # out before in: the order guard says so
    return first, last


def _clock(t: datetime, tz_offset_min: int) -> datetime:
    return t - timedelta(minutes=tz_offset_min or 0)


def _t12(t: datetime) -> str:
    return f"{t.hour % 12 or 12}:{t:%M} {'AM' if t.hour < 12 else 'PM'}"


def _dur(minutes: int) -> str:
    h, m = divmod(int(minutes), 60)
    return f"{h} hr {m} min" if m else f"{h} hr"


def check(others: list, kind: str, at: datetime, tz_offset_min: int = 0) -> dict | None:
    """None when fine, else {minutes, start, end, suggestAt, suggestText, message}.
    `others`: the person's other live punches (and pending requests) as
    (kind, utc datetime); `at`: the new or moved punch, UTC."""
    s = _span(others, kind, at)
    if not s:
        return None
    first, last = s
    minutes = int((last - first).total_seconds() // 60)
    if minutes <= LONG_SHIFT_MIN:
        return None
    loc = _clock(at, tz_offset_min)
    flip = timedelta(hours=12 if loc.hour < 12 else -12)
    cands = [at + flip]
    # A time that landed on the wrong day too (5:40 AM the next day for
    # 5:40 PM): try the same clock time on the shift's other end's day.
    anchor = first if kind != "in" else last
    shift_day = (_clock(anchor, tz_offset_min).date() - loc.date()).days
    if shift_day:
        moved = at + timedelta(days=shift_day)
        cands += [moved + flip, moved]
    suggest = None
    for c in cands:
        cs = _span(others, kind, c)
        if cs and 0 < (cs[1] - cs[0]).total_seconds() <= LONG_SHIFT_MIN * 60:
            suggest = c
            break
    a, b = _clock(first, tz_offset_min), _clock(last, tz_offset_min)
    end = _t12(b) + (" the next day" if b.date() > a.date() else "")
    sugg_text = _t12(_clock(suggest, tz_offset_min)) if suggest else ""
    msg = (f"This makes the shift {_dur(minutes)} long ({_t12(a)} to {end}). "
           + (f"Did you mean {sugg_text}? " if suggest else "")
           + "Check AM / PM. For a time after midnight, pick the next day.")
    return {"code": "long_shift", "minutes": minutes, "start": first.strftime("%Y-%m-%dT%H:%M:%S"),
            "end": last.strftime("%Y-%m-%dT%H:%M:%S"),
            "suggestAt": suggest.strftime("%Y-%m-%dT%H:%M:%S") if suggest else "",
            "suggestText": sugg_text, "message": msg}
