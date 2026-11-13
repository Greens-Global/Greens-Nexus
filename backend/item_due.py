"""When an Item Management checkout is due (Nov 2026) - the ONE clock.

Every reader of a checkout's due date goes through here: the catalog's
"available in N days" (routers/items.list_items), the checkout payload
(`dueAt` / `dueDate`), the overdue reminders (equipment_reminders) and the
Workflows pack's `due_date` (workflows/packs/items.py). Before this each kept
its own copy and they disagreed: two started the clock at `allocated_at`
first (the RECEIPT confirmation, which can come days after the handover) and
every one turned the due instant into a UTC calendar date, so an item handed
over at 6 PM in California read as due a day late, and one handed over in
the morning in India a day early.

The rules:
  * The clock starts when the item physically changes hands:
    `handed_over_at`, else `allocated_at` (a direct allocator handover stamps
    both), else `created_at` for a row that never recorded either.
    Approval delay never eats into the borrower's days.
  * due = start + `days` (approved extensions are already added to `days`).
  * The due DATE is the handover's calendar date in the BORROWER's own time
    zone plus `days` calendar days - counted in dates, so a DST change in
    between never moves it. The zone: their Shift preset's, else their
    company's team zone (Settings > Shifts & Scheduling), else
    America/Los_Angeles - the same fallback chain shift_expect uses. "Today"
    for an overdue count is read in the same zone.
  * dueAt (the instant) stays start + days, for "available in N days".

The return date (Neil, 11/02/2026): Borrow asks for a return DATE on a
calendar instead of a number of days. The request stores the date picked
(`requested_due_date`, YYYY-MM-DD in the borrower's zone) and `days` = that
date minus the day the request was made. The due date is then:
  * the date picked, when the item changes hands on or before the day the
    request was made (the usual same-day handover);
  * otherwise the same loan length counted from the handover - the handover
    date + `days`, as above - so an item handed over three days late is still
    lent for the length the borrower asked for and never comes back due the
    day after it was handed over.
An approved extension moves the picked date by the days it adds.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Optional


def _parse(iso) -> Optional[datetime]:
    s = str(iso or "").strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    # Stored timestamps are UTC; a naive one is read as UTC.
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def start_iso(co) -> str:
    """When the checkout clock started (see the module rules)."""
    return (getattr(co, "handed_over_at", "") or getattr(co, "allocated_at", "")
            or getattr(co, "created_at", "") or "")


def handed_over(co) -> bool:
    """Has the item changed hands yet (is there a due date worth showing)?"""
    return bool((getattr(co, "handed_over_at", "") or "").strip() or (getattr(co, "allocated_at", "") or "").strip())


def due_at(co) -> Optional[datetime]:
    """The due instant (aware, UTC), or None when no start can be read."""
    start = _parse(start_iso(co))
    if start is None:
        return None
    return (start + timedelta(days=_days(co))).astimezone(timezone.utc)


def _zone(tz: str):
    import shift_expect
    return shift_expect.zone(tz or "")


def _days(co) -> int:
    try:
        return int(getattr(co, "days", 0) or 0)
    except (TypeError, ValueError):
        return 0


def requested_date(co) -> Optional[date]:
    """The return date the borrower picked, or None (an older days request)."""
    s = str(getattr(co, "requested_due_date", "") or "").strip()[:10]
    if not s:
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def due_date(co, tz: str = "") -> Optional[date]:
    """The due date in zone `tz` (the borrower's - see zone_for): the picked
    return date when the handover came on or before the day of the request,
    else the local handover date plus `days` days (DST-safe - dates, not
    24-hour steps)."""
    start = _parse(start_iso(co))
    if start is None:
        return None
    z = _zone(tz)
    picked = requested_date(co)
    if picked is not None:
        asked = _parse(getattr(co, "created_at", ""))
        if asked is not None and start.astimezone(z).date() <= asked.astimezone(z).date():
            return picked
    return start.astimezone(z).date() + timedelta(days=_days(co))


def loan_days(picked: date, tz: str = "", now: Optional[datetime] = None) -> int:
    """`days` for a request whose borrower picked `picked`: the days from
    today (in the borrower's zone) to that date."""
    return (picked - local_today(tz, now)).days


def local_today(tz: str = "", now: Optional[datetime] = None) -> date:
    """Today's date in zone `tz`."""
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now.astimezone(_zone(tz)).date()


def zone_for(db, email: str) -> str:
    """The borrower's IANA zone: their Shift preset's zone (it holds on their
    days off too), else their company's team zone, else the tenant's, else
    America/Los_Angeles.

    Read straight from the tables (models only) - never through
    routers.shift_requests: this also runs INSIDE a session flush (the
    Workflows observer computes `due_date` there), and importing that router
    mid-flush registers session listeners while SQLAlchemy is iterating them
    ("deque mutated during iteration" - seen Nov 2026). The team zone is the
    `timeZone` key of the Shifts settings rows routers.shift_requests.get_settings
    layers (`shift_requests_config:<company>` over `shift_requests_config`);
    test_items_due_dates pins that the two agree."""
    em = (email or "").strip().lower()
    try:
        import models
        from sqlalchemy import func
        if em:
            # The zone the person set for themselves wins (person_zone.py,
            # 11/13/2026) - models only, like the rest of this function.
            import person_zone
            own = person_zone.stored(db, em)
            if own:
                return own
            assign = (db.query(models.ShiftAssignment.shift_id)
                      .filter(func.lower(models.ShiftAssignment.employee_email) == em).first())
            if assign and assign[0]:
                preset = db.query(models.Shift.timezone).filter(models.Shift.id == assign[0]).first()
                tz = ((preset[0] if preset else "") or "").strip()
                if tz and _valid(tz):
                    return tz
        company = ""
        if em:
            row = (db.query(models.NexusEmployee.company)
                   .filter(func.lower(models.NexusEmployee.work_email) == em).first())
            company = ((row[0] if row else "") or "").strip()
        keys = ([f"{SHIFT_SETTINGS_KEY}:{company}"] if company else []) + [SHIFT_SETTINGS_KEY]
        for key in keys:
            tz = _saved_zone(db, key)
            if tz:
                return tz
    except Exception:   # noqa: BLE001 - a zone that cannot be worked out reads as the default
        pass
    return DEFAULT_TZ


SHIFT_SETTINGS_KEY = "shift_requests_config"    # routers.shift_requests._SETTINGS_KEY
DEFAULT_TZ = "America/Los_Angeles"              # shift_expect.DEFAULT_TEAM_TZ


def _saved_zone(db, key: str) -> str:
    import json
    import models
    row = db.query(models.NexusSetting.value).filter(models.NexusSetting.key == key).first()
    if not row or not row[0]:
        return ""
    try:
        saved = json.loads(row[0])
    except (TypeError, ValueError):
        return ""
    tz = str((saved or {}).get("timeZone") or "").strip() if isinstance(saved, dict) else ""
    return tz if tz and _valid(tz) else ""


def _valid(tz: str) -> bool:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
    try:
        ZoneInfo(tz)
        return True
    except (ZoneInfoNotFoundError, ValueError):
        return False


class Zones:
    """zone_for, cached per email for one request / one scan."""

    def __init__(self, db):
        self.db = db
        self._cache: dict = {}

    def get(self, email: str) -> str:
        em = (email or "").strip().lower()
        if em not in self._cache:
            self._cache[em] = zone_for(self.db, em)
        return self._cache[em]


def due_fields(co, zones: Optional[Zones]) -> dict:
    """{"dueAt", "dueDate"} for a checkout payload - blank until the item has
    changed hands. dueDate is YYYY-MM-DD in the borrower's zone (screens
    format it MM/DD/YYYY)."""
    tz = zones.get(getattr(co, "requested_by_email", "")) if zones is not None else ""
    today = local_today(tz)
    blank = {"dueAt": "", "dueDate": "", "borrowerToday": today.isoformat(), "overdue": False, "dueToday": False}
    if not handed_over(co):
        return blank
    at = due_at(co)
    if at is None:
        return blank
    day = due_date(co, tz)
    out_now = getattr(co, "status", "") == "allocated"
    # The screens read these instead of comparing the VIEWER's today.
    return {"dueAt": at.isoformat(), "dueDate": day.isoformat(), "borrowerToday": today.isoformat(),
            "overdue": out_now and day < today, "dueToday": out_now and day == today}
