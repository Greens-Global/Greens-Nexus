"""American copy for notifications (Neil, Oct 17 2026: "we always stick to US
format dates ... remember it permanently").

A notification's title and body are built by dozens of senders; one that
interpolates a raw ISO date ("2026-10-04") puts it on every screen and in the
priority bar. `us_copy` is the backstop:
  - a standalone ISO date becomes MM/DD/YYYY ("10/04/2026") - not one inside
    a URL, an id or a timestamp ("2026-10-04T09:00" is left alone);
  - the retired "Sign your timecard" reminder (removed Oct 16) reads in the
    current Time Sheet wording.
It runs on every NEW row (the before_insert listener below - every sender
goes through the NexusNotification model) and on every row as it is SERVED
(routers/notifications.py), so rows written before this existed read right
without rewriting them. Senders should still format dates themselves (us_date / _us_day); this
only catches the ones that forget.
"""
import re

from sqlalchemy import event

from models import NexusNotification

_ISO_DATE = re.compile(r"(?<![\w/.:=-])(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?![\w:/-])")
# The retired reminder: "Your timecard for 10/04/2026 to 10/17/2026 is due tomorrow."
_LEGACY_TITLES = {"Sign your timecard": "Sign Your Time Sheet"}
_LEGACY_SPAN = re.compile(r"Your timecard for (\d{2}/\d{2}/\d{4}) to (\d{2}/\d{2}/\d{4})")


def us_copy(text):
    """The text with ISO dates in US format and retired wording updated."""
    if not text or not isinstance(text, str):
        return text
    out = _LEGACY_TITLES.get(text, text)
    out = _ISO_DATE.sub(lambda m: f"{m.group(2)}/{m.group(3)}/{m.group(1)}", out)
    return _LEGACY_SPAN.sub(r"Your time sheet for \1 - \2", out)


@event.listens_for(NexusNotification, "before_insert")
def _american_copy(_mapper, _conn, row) -> None:
    row.title = us_copy(row.title)
    row.body = us_copy(row.body)
