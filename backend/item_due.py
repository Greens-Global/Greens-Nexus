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
  * The due DATE is the calendar date of that instant in the BORROWER's own
    time zone: their Shift preset's zone, else their company's team zone
    (Settings > Shifts & Scheduling), else America/Los_Angeles - the same
    fallback chain shift_expect uses. "Today" for an overdue count is read
    in the same zone.
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
    try:
        days = int(getattr(co, "days", 0) or 0)
    except (TypeError, ValueError):
        days = 0
    return (start + timedelta(days=days)).astimezone(timezone.utc)


def _zone(tz: str):
    import shift_expect
    return shift_expect.zone(tz or "")


def due_date(co, tz: str = "") -> Optional[date]:
    """The due date in zone `tz` (the borrower's - see zone_for)."""
    at = due_at(co)
    return at.astimezone(_zone(tz)).date() if at is not None else None


def local_today(tz: str = "", now: Optional[datetime] = None) -> date:
    """Today's date in zone `tz`."""
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now.astimezone(_zone(tz)).date()


def zone_for(db, email: str) -> str:
    """The borrower's IANA zone: their Shift preset's zone (it holds on their
    days off too), else their company's team zone (shift_expect.team_tz)."""
    em = (email or "").strip().lower()
    try:
        import models
        import shift_expect
        from sqlalchemy import func
        if em:
            assign = (db.query(models.ShiftAssignment.shift_id)
                      .filter(func.lower(models.ShiftAssignment.employee_email) == em).first())
            if assign and assign[0]:
                preset = db.query(models.Shift.timezone).filter(models.Shift.id == assign[0]).first()
                tz = ((preset[0] if preset else "") or "").strip()
                if tz and _valid(tz):
                    return tz
        import sys
        if "routers.shift_requests" not in sys.modules:
            # Never IMPORT the Shifts settings router from here: this runs inside
            # a session flush too (the Workflows observer computes `due_date`
            # there), and importing a module that registers session listeners
            # mid-flush breaks the flush. The API imports every router at
            # startup, so in the app this branch is never taken - only a
            # script or a test that never loaded Shifts reads the default.
            return shift_expect.DEFAULT_TEAM_TZ
        company = shift_expect.companies_of(db, [em]).get(em, "") if em else ""
        return shift_expect.team_tz(db, company)
    except Exception:   # noqa: BLE001 - a zone that cannot be worked out reads as the default
        import shift_expect
        return shift_expect.DEFAULT_TEAM_TZ


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
    if not handed_over(co):
        return {"dueAt": "", "dueDate": ""}
    at = due_at(co)
    if at is None:
        return {"dueAt": "", "dueDate": ""}
    tz = zones.get(getattr(co, "requested_by_email", "")) if zones is not None else ""
    return {"dueAt": at.isoformat(), "dueDate": at.astimezone(_zone(tz)).date().isoformat()}
