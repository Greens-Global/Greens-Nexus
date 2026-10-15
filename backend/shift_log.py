"""Shifts Phase 2 - the schedule change log (Neil, Oct 14 2026).

Every write path on the schedule records what it did to each placed shift
(models.ShiftChangeLog): the action, who did it, when, a small snapshot of
the shift before and after, and - for a publish over warnings or a weather
call - the reason given. `GET /timeclock/schedule/{id}/history`
(routers/timeclock.py) reads it back newest first.

    record(db, "edited", row, actor, before=snapshot(row), after=new)

`record` never commits: the route that made the change commits, so the log
row lands with the change or not at all. `shared_only` trims a history for
staff: nothing that is still waiting to be shared, and never the publish
reason (hardening pass, Oct 15 2026: the reason is recorded only on the
'shared' rows of the shifts the review warned about, and managers alone
read it).

The snapshot (Oct 15) also carries breakMin, groupId, timezone and a
short hash of the note (`noteHash`) - the history can say "Lunch 30 -> 60
min", "Team: Austin -> Georgetown", "Zone: ..." and "Note changed" without
ever storing the note's text. A shared row that carried warnings keeps
them on its `after` snapshot (`warnings`), so a publish can be read back.

Actions: created, edited, removed, assigned, copied, moved, cleared,
discarded, shared, claimed, swapped, offered, weather.
"""
import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone

import models

ACTIONS = ("created", "edited", "removed", "assigned", "copied", "moved", "cleared", "discarded",
           "shared", "claimed", "swapped", "offered", "weather")
# The snapshot keys, in the order they are kept.
_FIELDS = ("start", "end", "label", "shiftId", "date", "email", "openSlots", "breakMin", "groupId", "timezone", "noteHash")


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
               "email": d.get("email", d.get("employee_email")), "openSlots": d.get("openSlots"),
               "breakMin": d.get("breakMin", d.get("break_min")), "groupId": d.get("groupId", d.get("group_id")),
               "timezone": d.get("timezone", d.get("timeZone"))}
        note = d.get("note")
    else:
        r = row_or_dict
        out = {"start": getattr(r, "start_hhmm", None), "end": getattr(r, "end_hhmm", None),
               "label": getattr(r, "label", None), "shiftId": getattr(r, "shift_id", None),
               "date": getattr(r, "work_date", None), "email": getattr(r, "employee_email", None),
               "openSlots": getattr(r, "open_slots", None), "breakMin": getattr(r, "break_min", None),
               "groupId": getattr(r, "group_id", None), "timezone": getattr(r, "timezone", None)}
        note = getattr(r, "note", None)
        ws = getattr(r, "weather_status", "") or ""
        if ws:
            out["weatherStatus"] = ws
    out = {k: v for k, v in out.items() if v is not None}
    if "email" in out:
        out["email"] = (out["email"] or "").lower()
    for k in ("openSlots", "breakMin"):
        if k in out:
            out[k] = int(out[k] or 0)
    if "timezone" in out and not out["timezone"]:
        del out["timezone"]
    if note is not None:
        out["noteHash"] = note_hash(note)
    out.update(extra)
    return out


def note_hash(note: str) -> str:
    """A short fingerprint of a note ('' for no note) - enough to say the
    note changed, never what it says."""
    text = (note or "").strip()
    if not text:
        return ""
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:8]


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


def _utc_marked(at: str) -> str:
    """The stored stamp is UTC with no zone marker (so the rows sort as
    text); the API says so with a trailing Z - a browser reads a bare
    "2026-10-15T07:15:00" as LOCAL time and showed a 12:15 AM share as
    7:15 AM (QA, Oct 15)."""
    s = at or ""
    if not s or s.endswith("Z") or "+" in s[10:] or (len(s) > 10 and "-" in s[10:]):
        return s
    return s + "Z"


def entry_dict(e: models.ShiftChangeLog, names: dict = None) -> dict:
    actor = (e.actor or "").lower()
    return {"id": e.id, "action": e.action, "actor": actor, "actorName": (names or {}).get(actor) or actor,
            "at": _utc_marked(e.at), "before": _loads(e.before_json), "after": _loads(e.after_json),
            "reason": e.reason or "", "publishId": e.publish_id or ""}


def history(db, shift_id: str, names: dict = None) -> list:
    """Every entry about one shift, newest first."""
    rows = (db.query(models.ShiftChangeLog).filter(models.ShiftChangeLog.shift_id == shift_id)
            .order_by(models.ShiftChangeLog.at.desc(), models.ShiftChangeLog.id.desc()).all())
    return [entry_dict(e, names) for e in rows]


# Actions that change the schedule staff see the moment they happen - no
# publish in between (a claim is shared as of approval; a swap, an offer and
# a weather call act on published rows).
LIVE_ACTIONS = ("shared", "claimed", "swapped", "offered", "weather")


def shared_only(entries: list) -> list:
    """The history a person who cannot build schedules may see, from the
    newest-first list `history` gives: everything from the latest share
    back, and after it only the live actions - never an edit, removal or
    draft that is still waiting to be shared. The publish reason and the
    warnings it answered are the managers' (stripped here)."""
    out, past_share = [], False
    for e in entries:
        if e.get("action") == "shared":
            past_share = True
        if past_share or e.get("action") in LIVE_ACTIONS:
            e = dict(e)
            if e.get("action") == "shared":
                e["reason"] = ""
                after = e.get("after")
                if isinstance(after, dict) and "warnings" in after:
                    e["after"] = {k: v for k, v in after.items() if k != "warnings"}
            out.append(e)
    return out


def removed_history(db, email: str, work_date: str, names: dict = None) -> list:
    """The entries about shifts that no longer exist on one person-day -
    what an empty cell can still tell (newest first). A shift that is still
    on the schedule for that day (any state) keeps its own history."""
    email = (email or "").strip().lower()
    day = (work_date or "")[:10]
    if not email or not day:
        return []
    live = {r.id for r in db.query(models.ScheduledShift.id)
            .filter(models.ScheduledShift.employee_email == email, models.ScheduledShift.work_date == day).all()}
    rows = (db.query(models.ShiftChangeLog)
            .filter(models.ShiftChangeLog.employee_email == email, models.ShiftChangeLog.work_date == day)
            .order_by(models.ShiftChangeLog.at.desc(), models.ShiftChangeLog.id.desc()).all())
    gone = {e.shift_id for e in rows if e.shift_id and e.shift_id not in live}
    if not gone:
        return []
    still = {r.id for r in db.query(models.ScheduledShift.id).filter(models.ScheduledShift.id.in_(sorted(gone))).all()}
    return [entry_dict(e, names) for e in rows if e.shift_id in gone and e.shift_id not in still]
