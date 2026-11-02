"""Edition watch: is the bundled edition of a form still the one to send?

`status(kind, today)` answers ok / expiring / expired with one sentence.
The I-9 carries its own expiration (printed on the form); the W-4 is good
for its calendar year. HR is warned EXPIRING_DAYS ahead (the I-9) or from
12/01 of the edition year (the W-4, when the IRS publishes the next one), and
an expired edition is refused at send - never silently sent.
"""
from datetime import date, timedelta

from .registry import FORMS, spec

EXPIRING_DAYS = 60

# The last day a W-4 edition may be sent is 12/31 of its year: a 2026 form
# registered on 01/15/2027 is refused (plan Review Focus 5). The plan's
# Interfaces block also floated a January grace month (last valid day 01/31) -
# flip this to (1, 31) if Neil prefers that reading; the warning from 12/01
# stays either way.
W4_LAST_VALID_MONTH_DAY = (12, 31)
W4_WARN_FROM_MONTH_DAY = (12, 1)


def _us(d: date) -> str:
    return d.strftime("%m/%d/%Y")


def last_valid_day(kind: str) -> date | None:
    """The last day this edition may be sent, or None when it never lapses."""
    s = spec(kind)
    if kind == "w4":
        year = int(s["edition"])
        if W4_LAST_VALID_MONTH_DAY[0] == 12:
            return date(year, 12, 31)
        return date(year + 1, *W4_LAST_VALID_MONTH_DAY)
    if s.get("expires"):
        return date.fromisoformat(s["expires"])
    return None


def warn_from(kind: str) -> date | None:
    last = last_valid_day(kind)
    if last is None:
        return None
    if kind == "w4":
        return date(int(spec(kind)["edition"]), *W4_WARN_FROM_MONTH_DAY)
    return last - timedelta(days=EXPIRING_DAYS)


def status(kind: str, today: date | None = None) -> dict:
    """{"state": "ok"|"expiring"|"expired", "message": str, "expires": "MM/DD/YYYY"|"",
    "editionLabel": str}."""
    s = spec(kind)
    today = today or date.today()
    last = last_valid_day(kind)
    label = s["editionLabel"]
    title = s["title"]
    out = {"editionLabel": label, "expires": _us(last) if last else ""}
    if last is None:
        return {**out, "state": "ok", "message": f"{title} ({label}) is current."}
    if today > last:
        return {**out, "state": "expired",
                "message": f"The {title} edition in Nexus ({label}) expired on {_us(last)}. "
                           "Ask an administrator to update it before sending."}
    if today >= warn_from(kind):
        if kind == "w4":
            nxt = int(s["edition"]) + 1
            return {**out, "state": "expiring",
                    "message": f"The {nxt} Form W-4 is due in January. The {label} edition in "
                               f"Nexus can be sent through {_us(last)}."}
        return {**out, "state": "expiring",
                "message": f"The {title} edition in Nexus ({label}) expires on {_us(last)}."}
    return {**out, "state": "ok", "message": f"{title} ({label}) is current through {_us(last)}."}


def all_status(today: date | None = None) -> dict:
    return {kind: status(kind, today) for kind in FORMS}
