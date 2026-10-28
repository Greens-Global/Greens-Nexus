"""Public holiday sources (Neil, Oct 29 2026 - docs/superpowers/specs/
2026-10-29-holiday-policies-design.md). Moved out of routers/hr.py.

`public_holidays(country, year)` is what Settings > Companies picks holidays
from. Every row carries the REAL calendar date; nothing is moved for a
weekend here. A policy's weekend rule (holiday_policies.apply_rule) decides
the day off, and `observed` is only a hint of what the US federal rule would
give.

  * United States - computed in-house, no network, every year: the 11
    federal holidays (scope "federal"), the common company holidays (scope
    "company_common"), plus state-only days from date.nager.at (global=false,
    scope "state:CA,CT"). Nager names the third Monday of February
    "Washington's Birthday" and returns observed dates - which is why the
    federal list is no longer taken from it.
  * India - the three national holidays computed (scope "national"), the rest
    from Google's public "en.indian" calendar, classified by its DESCRIPTION:
    "Public holiday" = gazetted (mandatory), "Observance" = restricted
    (optional). Lunar dates marked "(tentative)" keep tentative=True with the
    suffix stripped. A year the feed only partly covers says so.
  * Every other country - Nager, then Google, as before (scope "public").

Results are cached in-process for 6 hours per (country, year).
"""
from __future__ import annotations

import copy
import re
import threading
import time
from datetime import date, timedelta
from typing import Optional

import httpx

# Google's public per-country holiday calendars, for countries date.nager.at
# does not have. Each id was checked by hand (Google's id naming is not a
# function of the ISO code: "en.indian", not "en.india").
_GOOGLE_HOLIDAY_CALENDARS = {
    "IN": "en.indian", "SG": "en.singapore", "TW": "en.taiwan",
    "VN": "en.vietnamese", "SA": "en.saudiarabian",
}

WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")

# A full year of the India feed has ~61 entries; fewer than this = partial.
INDIA_FULL_YEAR = 45

_CACHE_TTL = 6 * 3600
_SHORT_TTL = 10 * 60          # a degraded answer (a source was down) is retried sooner
_cache: dict = {}
_cache_lock = threading.Lock()


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def us_date(iso: str) -> str:
    """YYYY-MM-DD -> MM/DD/YYYY (user-facing copy)."""
    s = (iso or "")[:10]
    if len(s) == 10 and s[4] == "-" and s[7] == "-":
        return f"{s[5:7]}/{s[8:10]}/{s[:4]}"
    return s


def weekday_name(iso: str) -> str:
    try:
        return WEEKDAYS[date.fromisoformat(iso[:10]).weekday()]
    except (TypeError, ValueError):
        return ""


# --- Date arithmetic ---------------------------------------------------------

def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """The n-th `weekday` (Mon=0) of the month; n=-1 = the last one."""
    if n > 0:
        d = date(year, month, 1)
        d += timedelta(days=(weekday - d.weekday()) % 7)
        return d + timedelta(weeks=n - 1)
    nxt = date(year + (month == 12), month % 12 + 1, 1)
    d = nxt - timedelta(days=1)
    return d - timedelta(days=(d.weekday() - weekday) % 7)


def easter(year: int) -> date:
    """Easter Sunday - the Anonymous Gregorian algorithm (Meeus/Jones/Butcher)."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l_ = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l_) // 451
    month, day = divmod(h + l_ - 7 * m + 114, 31)
    return date(year, month, day + 1)


def observed_federal(d) -> str:
    """The US federal observed date for a fixed-date holiday: Saturday -> the
    Friday before, Sunday -> the Monday after, a weekday -> itself. Takes a
    date or an ISO string, returns ISO."""
    if isinstance(d, str):
        d = date.fromisoformat(d[:10])
    if d.weekday() == 5:
        d -= timedelta(days=1)
    elif d.weekday() == 6:
        d += timedelta(days=1)
    return d.isoformat()


# Fixed-date federal holidays - the only rows that get an `observed` hint.
US_FIXED_FEDERAL = {
    "New Year's Day": (1, 1),
    "Juneteenth": (6, 19),
    "Independence Day": (7, 4),
    "Veterans Day": (11, 11),
    "Christmas Day": (12, 25),
}


def _row(d: date, name: str, scope: str, suggested: str, *, observed: str = "", tentative: bool = False) -> dict:
    iso = d.isoformat()
    return {"date": iso, "weekday": WEEKDAYS[d.weekday()], "name": name, "scope": scope,
            "suggestedType": suggested, "tentative": tentative, "observed": observed}


def us_federal(year: int) -> list:
    """The 11 federal holidays with their REAL dates, scope "federal"."""
    out = []
    spec = [
        ("New Year's Day", date(year, 1, 1)),
        ("Martin Luther King Jr. Day", _nth_weekday(year, 1, 0, 3)),
        ("Presidents' Day", _nth_weekday(year, 2, 0, 3)),
        ("Memorial Day", _nth_weekday(year, 5, 0, -1)),
        ("Juneteenth", date(year, 6, 19)),
        ("Independence Day", date(year, 7, 4)),
        ("Labor Day", _nth_weekday(year, 9, 0, 1)),
        ("Columbus Day", _nth_weekday(year, 10, 0, 2)),
        ("Veterans Day", date(year, 11, 11)),
        ("Thanksgiving Day", _nth_weekday(year, 11, 3, 4)),
        ("Christmas Day", date(year, 12, 25)),
    ]
    for name, d in spec:
        if name == "Juneteenth" and year < 2021:
            continue
        observed = ""
        if name in US_FIXED_FEDERAL and d.weekday() >= 5:
            observed = observed_federal(d)
        out.append(_row(d, name, "federal", "mandatory", observed=observed))
    return out


def us_common(year: int) -> list:
    """Holidays many US companies give that are not federal, scope "company_common"."""
    thanksgiving = _nth_weekday(year, 11, 3, 4)
    rows = [
        _row(easter(year) - timedelta(days=2), "Good Friday", "company_common", "optional"),
        _row(thanksgiving + timedelta(days=1), "Day After Thanksgiving", "company_common", "mandatory"),
        _row(date(year, 12, 24), "Christmas Eve", "company_common", "half_day"),
        _row(date(year, 12, 31), "New Year's Eve", "company_common", "half_day"),
    ]
    return sorted(rows, key=lambda r: r["date"])


INDIA_NATIONAL = (("Republic Day", 1, 26), ("Independence Day", 8, 15), ("Gandhi Jayanti", 10, 2))
# How the feed names the three national days - its copies are dropped.
_INDIA_NATIONAL_FEED_NAMES = {"republic day", "independence day", "mahatma gandhi jayanti", "gandhi jayanti"}


def india_national(year: int) -> list:
    return [_row(date(year, m, d), name, "national", "mandatory") for name, m, d in INDIA_NATIONAL]


def name_key(name: str) -> str:
    """A loose comparison key for holiday names: lowercase, no punctuation, no
    "(observed)" / "(tentative)" suffix."""
    s = (name or "").lower()
    s = re.sub(r"\((observed|tentative)\)", "", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


# --- Network sources ---------------------------------------------------------

def _nager_raw(country: str, year: int) -> Optional[list]:
    try:
        resp = httpx.get(f"https://date.nager.at/api/v3/PublicHolidays/{year}/{country}", timeout=10)
    except Exception:  # noqa: BLE001 - a network hiccup falls through to the next source
        return None
    if resp.status_code == 204:
        # Nager answers 204 both for "zero holidays this year" and for a
        # country it does not have (India) - treat it as no answer so the
        # Google fallback (or the final 404) takes over.
        return None
    if not resp.is_success:
        return None
    try:
        data = resp.json()
    except ValueError:
        return None
    return data if isinstance(data, list) else None


def _fetch_nager_holidays(country: str, year: int) -> Optional[list]:
    """[{date, name}] from Nager (the pre-Oct 29 shape, kept for callers)."""
    data = _nager_raw(country, year)
    if data is None:
        return None
    return [{"date": h.get("date"), "name": h.get("localName") or h.get("name") or ""} for h in data]


def _unescape_ics(s: str) -> str:
    return (s or "").replace("\\n", "\n").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\").strip()


def _google_events(country: str, year: int) -> Optional[list]:
    """[{date, name, description}] from Google's public holiday calendar for
    the year, or None when the country has no calendar or the feed is down."""
    cal_id = _GOOGLE_HOLIDAY_CALENDARS.get(country)
    if not cal_id:
        return None
    url = f"https://calendar.google.com/calendar/ical/{cal_id}%23holiday%40group.v.calendar.google.com/public/basic.ics"
    try:
        resp = httpx.get(url, timeout=10)
        resp.raise_for_status()
    except Exception:  # noqa: BLE001
        return None
    text = re.sub(r"\r?\n[ \t]", "", resp.text or "")   # unfold continuation lines
    out = []
    for block in text.split("BEGIN:VEVENT")[1:]:
        date_m = re.search(r"DTSTART;VALUE=DATE:(\d{8})", block)
        if not date_m or date_m.group(1)[:4] != str(year):
            continue
        name_m = re.search(r"^SUMMARY[^:\n]*:(.*)$", block, re.M)
        desc_m = re.search(r"^DESCRIPTION[^:\n]*:(.*)$", block, re.M)
        d = date_m.group(1)
        out.append({"date": f"{d[:4]}-{d[4:6]}-{d[6:8]}",
                    "name": _unescape_ics(name_m.group(1)) if name_m else "",
                    "description": _unescape_ics(desc_m.group(1)) if desc_m else ""})
    return out


def _fetch_google_holidays(country: str, year: int) -> Optional[list]:
    """[{date, name}] from Google (the pre-Oct 29 shape, kept for callers)."""
    ev = _google_events(country, year)
    if ev is None:
        return None
    return [{"date": e["date"], "name": e["name"]} for e in ev]


# --- Per-country builders ----------------------------------------------------

def _us(year: int) -> dict:
    rows = us_federal(year) + us_common(year)
    known = {name_key(r["name"]) for r in rows}
    raw = _nager_raw("US", year)
    note = ""
    if raw is None:
        note = "Could not reach the state holiday source - showing federal and common company holidays only"
    else:
        merged: dict = {}
        for h in raw:
            if h.get("global", True):
                continue
            name = (h.get("name") or h.get("localName") or "").strip()
            iso = (h.get("date") or "")[:10]
            if not name or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", iso) or name_key(name) in known:
                continue
            states = [c.split("-", 1)[1] if c.upper().startswith("US-") else c for c in (h.get("counties") or [])]
            slot = merged.setdefault((iso, name), [])
            for s in states:
                if s and s not in slot:
                    slot.append(s)
        for (iso, name), states in merged.items():
            r = _row(date.fromisoformat(iso), name, "state:" + ",".join(sorted(states)) if states else "state",
                     "optional")
            rows.append(r)
    rows.sort(key=lambda r: (r["date"], r["name"]))
    return {"country": "US", "year": year, "source": "computed" if raw is None else "mixed",
            "partial": False, "note": note, "holidays": rows}


def _classify_india(description: str) -> tuple:
    d = (description or "").strip().lower()
    if d.startswith("public holiday") or "gazetted" in d:
        return "gazetted", "mandatory"
    return "restricted", "optional"


def _india(year: int) -> dict:
    rows = india_national(year)
    events = _google_events("IN", year)
    if events is None:
        return {"country": "IN", "year": year, "source": "computed", "partial": True,
                "note": "Could not reach the India holiday source - showing the national holidays only",
                "holidays": rows}
    seen = {(r["date"], name_key(r["name"])) for r in rows}
    for e in events:
        name = e["name"]
        tentative = bool(re.search(r"\(tentative\)", name, re.I))
        name = re.sub(r"\s*\(tentative\)\s*", " ", name, flags=re.I).strip()
        if not name:
            continue
        if name_key(name) in _INDIA_NATIONAL_FEED_NAMES:
            continue
        key = (e["date"], name_key(name))
        if key in seen:
            continue
        seen.add(key)
        scope, suggested = _classify_india(e.get("description", ""))
        rows.append(_row(date.fromisoformat(e["date"]), name, scope, suggested, tentative=tentative))
    rows.sort(key=lambda r: (r["date"], r["name"]))
    partial = len(events) < INDIA_FULL_YEAR
    return {"country": "IN", "year": year, "source": "mixed", "partial": partial,
            "note": f"Partial list for {year} - confirm dates nearer the time" if partial else "",
            "holidays": rows}


def _other(country: str, year: int) -> Optional[dict]:
    source = "nager"
    result = _fetch_nager_holidays(country, year)
    if result is None:
        source = "google"
        result = _fetch_google_holidays(country, year)
    if result is None:
        return None
    seen, rows = set(), []
    for h in result:
        iso = (h.get("date") or "")[:10]
        name = (h.get("name") or "").strip()
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", iso) or not name or (iso, name) in seen:
            continue
        seen.add((iso, name))
        rows.append(_row(date.fromisoformat(iso), name, "public", "mandatory"))
    rows.sort(key=lambda r: (r["date"], r["name"]))
    return {"country": country, "year": year, "source": source, "partial": False, "note": "", "holidays": rows}


def public_holidays(country: str, year: int) -> Optional[dict]:
    """See the module docstring. None = no data for this country."""
    country = (country or "US").strip().upper()
    year = int(year)
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get((country, year))
        if hit and hit[0] > now:
            return copy.deepcopy(hit[1])
    if country == "US":
        result = _us(year)
    elif country == "IN":
        result = _india(year)
    else:
        result = _other(country, year)
    degraded = result is None or (result.get("source") == "computed")
    with _cache_lock:
        _cache[(country, year)] = (now + (_SHORT_TTL if degraded else _CACHE_TTL), result)
    return copy.deepcopy(result)
