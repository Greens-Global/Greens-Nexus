"""Company time for printed records (Oct 23 2026).

Nexus stores every instant in UTC. What a person READS on a Nexus Sign
certificate or a signed document is the company's own clock - Pacific, PDT or
PST by the date - with the recorded UTC instant kept beside it in brackets so
the evidence stays exact:

    10-20-2026 11:08:03 AM PDT (18:08:03 UTC)
    10-20-2026 7:30 PM PDT (10-21-2026 02:30 UTC)      <- UTC date shown when it differs

Certificates sealed before this keep printing plain UTC: the certificate of
record must re-render byte for byte from its snapshot, so only snapshots
carrying TIME_STYLE use this (services/certificate.build_snapshot stamps it).
"""
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

PACIFIC = ZoneInfo("America/Los_Angeles")
TIME_STYLE = "pacific"          # snapshot["time_style"] on certificates issued from Oct 23 2026


def _parse(value):
    v = (value or "").strip()
    if not v:
        return None
    try:
        dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:                     # stored without a zone = UTC
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _iso_day(d) -> str:
    return d.strftime("%Y-%m-%d")


def pacific_with_utc(value, us_date, seconds: bool = True) -> str:
    """'2026-10-20T18:08:03+00:00' -> '<date> 11:08:03 AM PDT (18:08:03 UTC)'.

    `us_date` turns an ISO day into the caller's printed date (the certificate's
    MM-DD-YYYY, or MM/DD/YYYY on a document), so this never picks a date style
    of its own. '' for an empty or unreadable value - the caller prints its dash."""
    utc = _parse(value)
    if utc is None:
        return ""
    local = utc.astimezone(PACIFIC)
    clock = local.strftime("%I:%M:%S %p" if seconds else "%I:%M %p").lstrip("0")
    utc_clock = utc.strftime("%H:%M:%S" if seconds else "%H:%M")
    utc_day = "" if utc.date() == local.date() else us_date(_iso_day(utc)) + " "
    return f"{us_date(_iso_day(local))} {clock} {local.tzname()} ({utc_day}{utc_clock} UTC)"
