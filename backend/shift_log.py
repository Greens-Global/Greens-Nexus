"""Shifts Phase 2 - the schedule change log (Neil, Oct 14 2026).

Every write path on the schedule records what it did to each placed shift
(models.ShiftChangeLog): the action, who did it, when, a small snapshot of
the shift before and after, and - for a publish over warnings or a weather
call - the reason given. `GET /timeclock/schedule/{id}/history`
(routers/timeclock.py) reads it back newest first.

    record(db, "edited", row, actor, before=snapshot(row), after=new)

`record` never commits: the route that made the change commits, so the log
row lands with the change or not at all.

Actions: created, edited, removed, assigned, copied, moved, cleared,
discarded, shared, claimed, swapped, offered, weather.
"""
import json
import uuid
from datetime import datetime, timedelta, timezone

import models

ACTIONS = ("created", "edited", "removed", "assigned", "copied", "moved", "cleared", "discarded",
           "shared", "claimed", "swapped", "offered", "weather")
# The snapshot keys, in the order they are kept.
_FIELDS = ("start", "end", "label", "shiftId", "date", "email", "openSlots")


_last_at = ""


def _now() -> str:
    """UTC ISO with microseconds, strictly increasing within a process, so
    the rows one request writes read back in the order they were written."""
    global _last_at
    at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")
    if at <= _last_at:
        at = (datetime.strptime(_last_at, "%Y-%m-%dT%H:%M:%S.%f") + timedelta(microseconds=1)).strftime("%Y-%m-%dT%H:%M:%S.%f")
    _last_at = at
    return at


def snapshot(row_or_dict, **extra) -> dict:
    """The small {start, end, label, shiftId, date, email, openSlots} of a
    shift - from a ScheduledShift row (its PUBLISHED values) or from a
    _sched_dict / pending-shaped dict. Keys that are not there are left
    out; `extra` adds more (a weather outcome, say)."""
    if row_or_dict is None:
        return dict(extra)
    if isinstance(row_or_dict, dict):
        d = row_or_dict
        out = {"start": d.get("start"), "end": d.get("end"), "label": d.get("label"),
               "shiftId": d.get("shiftId"), "date": d.get("date", d.get("work_date")),
               "email": d.get("email", d.get("employee_email")), "openSlots": d.get("openSlots")}
    else:
        r = row_or_dict
        out = {"start": getattr(r, "start_hhmm", None), "end": getattr(r, "end_hhmm", None),
               "label": getattr(r, "label", None), "shiftId": getattr(r, "shift_id", None),
               "date": getattr(r, "work_date", None), "email": getattr(r, "employee_email", None),
               "openSlots": getattr(r, "open_slots", None)}
        ws = getattr(r, "weather_status", "") or ""
        if ws:
            out["weatherStatus"] = ws
    out = {k: v for k, v in out.items() if v is not None}
    if "email" in out:
        out["email"] = (out["email"] or "").lower()
    if "openSlots" in out:
        out["openSlots"] = int(out["openSlots"] or 0)
    out.update(extra)
    return out


def _ident(row_or_dict) -> tuple:
    """(shift id, email, work date) of the shift a row is about."""
    if isinstance(row_or_dict, dict):
        d = row_or_dict
        return (str(d.get("id") or d.get("shiftId") or ""), (d.get("email") or d.get("employee_email") or "").lower(),
                str(d.get("date") or d.get("work_date") or ""))
    r = row_or_dict
    return (str(getattr(r, "id", "") or ""), (getattr(r, "employee_email", "") or "").lower(),
            str(getattr(r, "work_date", "") or ""))


def record(db, action: str, row_or_dict, actor: str, before: dict = None, after: dict = None,
           reason: str = "", publish_id: str = "") -> models.ShiftChangeLog:
    """Add one log row for a shift. `row_or_dict` is the ScheduledShift row
    (or a dict with id / email / date for one that is already gone); `before`
    and `after` are snapshot() dicts. No commit - the route commits."""
    sid, email, day = _ident(row_or_dict)
    entry = models.ShiftChangeLog(
        id=str(uuid.uuid4()), shift_id=sid, employee_email=email, work_date=day,
        action=(action or "")[:40], actor=(actor or "").lower()[:200], at=_now(),
        before_json=json.dumps(before) if before else "", after_json=json.dumps(after) if after else "",
        reason=(reason or "").strip()[:300], publish_id=publish_id or "")
    db.add(entry)
    return entry


def _loads(s: str):
    try:
        v = json.loads(s or "")
    except (TypeError, ValueError):
        return None
    return v if isinstance(v, dict) else None


def entry_dict(e: models.ShiftChangeLog, names: dict = None) -> dict:
    actor = (e.actor or "").lower()
    return {"id": e.id, "action": e.action, "actor": actor, "actorName": (names or {}).get(actor) or actor,
            "at": e.at, "before": _loads(e.before_json), "after": _loads(e.after_json),
            "reason": e.reason or "", "publishId": e.publish_id or ""}


def history(db, shift_id: str, names: dict = None) -> list:
    """Every entry about one shift, newest first."""
    rows = (db.query(models.ShiftChangeLog).filter(models.ShiftChangeLog.shift_id == shift_id)
            .order_by(models.ShiftChangeLog.at.desc(), models.ShiftChangeLog.id.desc()).all())
    return [entry_dict(e, names) for e in rows]
