"""A person's own time zone and working hours (11/13/2026).

Greens has people in the United States and India. Until now a colleague's
zone was only ever INFERRED (routers/directory._tz_name: US state, country,
the last punch's offset), and nothing said when their working day is. Both
are now kept on the person - `nexus_employees.time_zone` (an IANA name) and
`work_start` / `work_end` ("HH:MM" in that zone) - set by the person under
My Profile > Date & Time (PUT /myhr/profile). '' = not set: every reader
then works the zone out exactly as it did before.

This module is the validation and the one read (`stored`). Models only, no
router imports: `stored` is also called from inside a session flush
(item_due.zone_for), where importing a router registers session listeners
mid-iteration.
"""
from __future__ import annotations

import re
from zoneinfo import ZoneInfo

_HHMM = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
MAX_ZONE_LEN = 64


def valid_zone(tz) -> bool:
    if not isinstance(tz, str) or not tz.strip() or len(tz) > MAX_ZONE_LEN:
        return False
    try:
        ZoneInfo(tz.strip())
        return True
    except Exception:   # noqa: BLE001 - unknown key, bad path, a zone the host lacks
        return False


def clean_zone(raw) -> str:
    """'' (not set) or a valid IANA name. Raises ValueError otherwise."""
    tz = str(raw or "").strip()
    if not tz:
        return ""
    if not valid_zone(tz):
        raise ValueError("Pick a time zone from the list.")
    return tz


def clean_hhmm(raw, label: str = "The time") -> str:
    """'' (not set) or 'HH:MM' on the 24-hour clock, zero padded."""
    v = str(raw or "").strip()
    if not v:
        return ""
    m = _HHMM.match(v)
    if not m:
        raise ValueError(f"{label} must be a time of day, for example 9:00 AM.")
    return f"{int(m.group(1)):02d}:{m.group(2)}"


def clean_hours(start, end) -> tuple[str, str]:
    """Working hours are a pair: both set or both empty. An end before the
    start is a day that runs past midnight (a night shift) and is kept."""
    s = clean_hhmm(start, "The start of your working hours")
    e = clean_hhmm(end, "The end of your working hours")
    if bool(s) != bool(e):
        raise ValueError("Working hours need both a start and an end.")
    if s and s == e:
        raise ValueError("The start and end of your working hours cannot be the same time.")
    return s, e


def of(emp) -> str:
    """The zone stored on a person row (or anything shaped like one), '' when
    none is set or what is there is not a real zone."""
    tz = (getattr(emp, "time_zone", "") or "").strip()
    return tz if tz and valid_zone(tz) else ""


def stored(db, email: str) -> str:
    """The zone this person set for themselves, '' when they have not.
    Never raises: a reader falls back to its own inference."""
    em = (email or "").strip().lower()
    if not em:
        return ""
    try:
        from sqlalchemy import func

        import models
        row = (db.query(models.NexusEmployee.time_zone)
               .filter(func.lower(models.NexusEmployee.work_email) == em).first())
        tz = ((row[0] if row else "") or "").strip()
        return tz if tz and valid_zone(tz) else ""
    except Exception:   # noqa: BLE001 - a zone is never worth a failed request
        return ""
