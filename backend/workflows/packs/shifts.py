"""Shifts pack (Task 11): a placed shift (`shift`), a no-show alert
(`shift_no_show`) and a weather call (`weather_call`).

Events and where they come from:
  * `shift.shared` / `shift.changed` / `shift.removed` / `shift.claimed` -
    `shift_log.record`, the one place every schedule write is logged; the
    log action maps to an event through `log_event_key` (shared -> shared;
    edited, moved, assigned -> changed; removed, cleared, discarded ->
    removed; claimed, swapped -> claimed; created, copied, offered,
    released, weather -> no event). `extra` carries the action, the reason
    and the before / after snapshots.
  * `shift.no_show` - `shift_attendance.noshow_scan`, when a NEW
    shift_noshow_alerts row opens for a recipient, team and day (a refresh
    of an open alert is not a new event); `extra.people` lists who was not
    in.
  * `weather_call.decided` - `weather_call.decide`, once the call is made and
    applied to the day's shifts; `extra.people` is the crew it applies to.

`may_use`: a manager (timeclock.SHIFT_MANAGE_LEVEL) or the People grant -
what `_require_company_manage` resolves a company's shift management to.
"""
from __future__ import annotations

import json
from datetime import timedelta

import models
from workflows.catalog import F, entity, event, list_source
from workflows.context import us_date
from workflows.packs._people import (attach_property, emails, group_company, has_grant, is_admin, is_manager,
                                     person_company, person_manager)

MODULE = "shifts"

LOG_EVENTS = {
    "shared": "shift.shared",
    "edited": "shift.changed", "moved": "shift.changed", "assigned": "shift.changed",
    "removed": "shift.removed", "cleared": "shift.removed", "discarded": "shift.removed",
    "claimed": "shift.claimed", "swapped": "shift.claimed",
}
SHIFT_STATUSES = [("draft", "Draft"), ("shared", "Shared"), ("open", "Open"), ("cancelled", "Cancelled")]
WEATHER_KINDS = [("cancel", "Cancel"), ("delay", "Delay"), ("end_early", "End Early"), ("move", "Move"),
                 ("proceed", "Proceed")]


def log_event_key(action: str) -> str:
    """The event a shift_log action emits, '' for none."""
    return LOG_EVENTS.get((action or "").strip().lower(), "")


# ── derived attributes ───────────────────────────────────────────────────────
def _shift_status(r) -> str:
    if (r.weather_status or "") == "cancelled":
        return "cancelled"
    if not (r.employee_email or "") and int(r.open_slots or 0) > 0:
        return "open"
    return "shared" if int(r.published or 0) else "draft"


attach_property(models.ScheduledShift, "wf_status", _shift_status)


# ── access ───────────────────────────────────────────────────────────────────
def may_use(db, user) -> bool:
    if not user:
        return False
    return is_admin(user) or is_manager(user) or has_grant(db, user, "hr")


def _shift_visible(db, user, row) -> bool:
    if not user:
        return False
    me = (user.get("email") or "").lower()
    em = (getattr(row, "employee_email", "") or "").lower()
    if me and em and (me == em or me in person_manager(db, em)):
        return True
    return may_use(db, user)


def _shift_company(row) -> str:
    return person_company(row, row.employee_email) or group_company(row, row.group_id)


# ── people ───────────────────────────────────────────────────────────────────
def _shift_self(db, row) -> list[str]:
    return emails(row.employee_email)


def _shift_manager(db, row) -> list[str]:
    return person_manager(db, row.employee_email)


def _told(row) -> list:
    try:
        v = json.loads(row.people_json or "[]")
    except (TypeError, ValueError):
        return []
    return [p for p in v if isinstance(p, dict)] if isinstance(v, list) else []


def _noshow_recipient(db, row) -> list[str]:
    return emails(row.recipient)


def _noshow_missing(db, row) -> list[str]:
    return emails(*[p.get("email") for p in _told(row)])


def _crew(row) -> list:
    try:
        v = json.loads(row.people_json or "[]")
    except (TypeError, ValueError):
        return []
    return [p for p in v if isinstance(p, dict)] if isinstance(v, list) else []


def _weather_decider(db, row) -> list[str]:
    return emails(row.decided_by)


def _weather_crew(db, row) -> list[str]:
    return emails(*[p.get("email") for p in _crew(row) if p.get("selected")])


def _schedule_link(work_date: str, group_id: str) -> dict:
    gid = group_id if group_id and group_id != "-" else ""
    return {"view": "shifts", "sub": f"schedule:{work_date}:{gid}"}


# ── entities ─────────────────────────────────────────────────────────────────
entity("shift", label="Shift", model=models.ScheduledShift, module=MODULE,
       company=_shift_company,
       link=lambda row: _schedule_link(row.work_date, row.group_id),
       people={"self": _shift_self, "manager": _shift_manager},
       fields=[
           F("employee", "Person", "person", path="employee_email"),
           F("work_date", "Day", "date"),
           F("start", "Start", "text", path="start_hhmm"),
           F("end", "End", "text", path="end_hhmm"),
           F("label", "Label", "text"),
           F("shift_id", "Shift Type", "text"),
           F("group_id", "Team", "text"),
           F("status", "Status", "select", options=SHIFT_STATUSES, path="wf_status"),
           F("open_slots", "Open Slots", "number"),
           F("break_min", "Break Minutes", "number"),
           F("timezone", "Time Zone", "text"),
           F("weather_status", "Weather Outcome", "select",
             options=[("", "None"), ("cancelled", "Cancelled"), ("delayed", "Delayed"), ("shortened", "Shortened"),
                      ("moved", "Moved"), ("kept", "Kept")]),
           F("note", "Note", "text"),
       ],
       dates=["work_date"],
       label_of=lambda row: (f"{row.employee_email or 'Open shift'} {us_date(row.work_date)} "
                             f"{(row.start_hhmm or '')[:5]}-{(row.end_hhmm or '')[:5]}").strip(),
       visible_to=_shift_visible)

entity("shift_no_show", label="No-Show Alert", model=models.ShiftNoShowAlert, module=MODULE,
       company=lambda row: group_company(row, row.group_id) or person_company(row, row.recipient),
       link=lambda row: _schedule_link(row.work_date, row.group_id),
       people={"recipient": _noshow_recipient, "missing": _noshow_missing},
       people_labels={"recipient": "Manager Told", "missing": "People Not In"},
       fields=[
           F("group_id", "Team", "text"),
           F("work_date", "Day", "date"),
           F("recipient", "Told", "person"),
           F("first_at", "First Noticed", "datetime"),
           F("last_at", "Last Updated", "datetime"),
           F("resolved_at", "Resolved", "datetime"),
       ],
       dates=["work_date"],
       label_of=lambda row: f"No-show {us_date(row.work_date)} ({row.recipient})",
       visible_to=lambda db, user, row: may_use(db, user))

entity("weather_call", label="Weather Call", model=models.WeatherDecision, module=MODULE,
       company=lambda row: row.company or group_company(row, row.group_id),
       link=lambda row: _schedule_link(row.work_date, row.group_id),
       people={"decider": _weather_decider, "crew": _weather_crew},
       people_labels={"decider": "Decider", "crew": "Crew"},
       fields=[
           F("group_id", "Team", "text"),
           F("work_date", "Day", "date"),
           F("kind", "Call", "select", options=WEATHER_KINDS),
           F("new_start", "New Start", "text"),
           F("new_end", "New End", "text"),
           F("move_to", "Moved To", "text"),
           F("reason", "Reason", "text"),
           F("status", "Status", "select",
             options=[("active", "Active"), ("superseded", "Superseded"), ("reinstated", "Reinstated")]),
           F("company", "Company", "select", options="companies"),
           F("decided_by", "Decided By", "person"),
           F("decided_at", "Decided At", "datetime"),
       ],
       dates=["work_date"],
       label_of=lambda row: f"Weather call {us_date(row.work_date)}: {row.kind}",
       visible_to=lambda db, user, row: may_use(db, user))

SAMPLE_SHIFT = {
    "employee": "priya.shah@greensglobal.com", "work_date": "2026-11-02", "start": "07:00", "end": "15:30",
    "label": "Escondido", "shift_id": "", "group_id": "team-escondido", "status": "shared",
    "open_slots": 0, "break_min": 30, "timezone": "America/Los_Angeles", "weather_status": "", "note": "",
}
_SHIFT_SNAPSHOT = {"start": "07:00", "end": "15:30", "label": "Escondido", "shiftId": "", "date": "2026-11-02",
                   "email": "priya.shah@greensglobal.com", "openSlots": 0, "breakMin": 30, "groupId": "team-escondido"}


def _shift_sample(action: str, before=None, after=None, reason: str = "") -> dict:
    return {"subject": dict(SAMPLE_SHIFT),
            "extra": {"action": action, "reason": reason, "before": before or {}, "after": after or {},
                      "publishId": ""},
            "actor": "max.miller@greensglobal.com"}


# ── events ───────────────────────────────────────────────────────────────────
event("shift.shared", entity="shift", label="Shift Is Shared", module=MODULE, group="Schedule", may_use=may_use,
      sample=_shift_sample("shared", before=_SHIFT_SNAPSHOT, after=_SHIFT_SNAPSHOT))
event("shift.changed", entity="shift", label="Shift Changes", module=MODULE, group="Schedule", may_use=may_use,
      sample=_shift_sample("edited", before=_SHIFT_SNAPSHOT, after=dict(_SHIFT_SNAPSHOT, start="08:00"),
                           reason="Later start for the delivery"))
event("shift.removed", entity="shift", label="Shift Is Removed", module=MODULE, group="Schedule", may_use=may_use,
      sample=_shift_sample("removed", before=_SHIFT_SNAPSHOT))
event("shift.claimed", entity="shift", label="Open Shift Is Claimed", module=MODULE, group="Schedule",
      may_use=may_use,
      sample=_shift_sample("claimed", before=dict(_SHIFT_SNAPSHOT, email="", openSlots=1), after=_SHIFT_SNAPSHOT))
event("shift.no_show", entity="shift_no_show", label="Person Does Not Show Up", module=MODULE, group="Attendance",
      may_use=may_use,
      sample={"subject": {"group_id": "team-escondido", "work_date": "2026-11-02",
                          "recipient": "max.miller@greensglobal.com", "first_at": "2026-11-02T15:20:00+00:00",
                          "last_at": "2026-11-02T15:20:00+00:00", "resolved_at": ""},
              "extra": {"team": "Escondido", "title": "Not In Yet: Priya Shah",
                        "people": [{"email": "priya.shah@greensglobal.com", "name": "Priya Shah",
                                    "start": "07:00", "lateMin": 20}]},
              "actor": ""})
event("weather_call.decided", entity="weather_call", label="Weather Call Is Made", module=MODULE,
      group="Weather Call", may_use=may_use,
      sample={"subject": {"group_id": "team-escondido", "work_date": "2026-11-02", "kind": "delay",
                          "new_start": "10:00", "new_end": "", "move_to": "", "reason": "Heavy rain until 9",
                          "status": "active", "company": "", "decided_by": "max.miller@greensglobal.com",
                          "decided_at": "2026-11-02T12:05:00+00:00"},
              "extra": {"headline": "Start Delayed to 10:00 AM for Weather", "team": "Escondido",
                        "people": ["priya.shah@greensglobal.com"],
                        "outcomes": {"priya.shah@greensglobal.com": "delayed"}},
              "actor": "max.miller@greensglobal.com"})


# ── list sources ─────────────────────────────────────────────────────────────
def open_shifts_tomorrow(db, ctx, params) -> list:
    """Shared open shifts (no person, slots left) for tomorrow; in the run's
    company when it has one (a shared team's shifts count for every company)."""
    from datetime import date as _date
    today = getattr(ctx, "today", None) or _date.today()
    day = (today + timedelta(days=1)).isoformat()
    rows = (db.query(models.ScheduledShift)
            .filter(models.ScheduledShift.work_date == day, models.ScheduledShift.employee_email == "",
                    models.ScheduledShift.open_slots > 0, models.ScheduledShift.published == 1,
                    models.ScheduledShift.pending_delete == 0)
            .order_by(models.ScheduledShift.start_hhmm, models.ScheduledShift.group_id).all())
    cid = (getattr(ctx, "company_id", "") or "")
    if not cid:
        return rows
    memo: dict = {}
    out = []
    for r in rows:
        gid = r.group_id or ""
        if gid not in memo:
            memo[gid] = group_company(db, gid)
        if memo[gid] in ("", cid):
            out.append(r)
    return out


list_source("shifts.open_tomorrow", label="Open Shifts Tomorrow", entity="shift", module=MODULE,
            fn=open_shifts_tomorrow)
