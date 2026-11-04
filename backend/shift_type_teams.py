"""Shift types belong to teams (Neil, 11/04/2026: "it's weird to see IT
Support Team available for operations, which is silly").

`Shift.group_ids` (JSON list of ShiftGroup ids, '' = every team) says which
teams a shift type is for; the planner offers a type only on its teams' rows
(the day menu's Place Shift Type, the Add Shift editor), and Settings > Shifts
& Scheduling > Shift Types sets it.

apply_once (main._startup_seeds, a nexus_settings mark like the other seeds)
fills it ONCE for the types that existed before, from what each team already
does with them - nothing is guessed:
  - the teams whose members have the type as their usual hours
    (ShiftAssignment), and
  - the teams whose members had it placed in the last LOOKBACK_DAYS days.
A type nobody on a team uses stays shared with every team. A type used by
every live team stays shared too (linking it to all of them says nothing).
Nothing is deleted and no placed shift changes; a manager can widen or
narrow any type afterwards in Settings.
"""
import json
from datetime import date, timedelta

from sqlalchemy.orm import Session

from models import NexusSetting, ScheduledShift, Shift, ShiftAssignment, ShiftGroup, ShiftGroupMember

MARK = "shift_type_teams.filled_2026_11_04"
LOOKBACK_DAYS = 120


def teams_by_use(db: Session, today: date = None) -> dict:
    """{shift type id: set of team ids} from usual hours and recent placements."""
    today = today or date.today()
    since = (today - timedelta(days=LOOKBACK_DAYS)).isoformat()
    live = {g.id for g in db.query(ShiftGroup).all() if not int(getattr(g, "archived", 0) or 0)}
    teams_of: dict = {}
    for m in db.query(ShiftGroupMember).all():
        if m.employee_email and m.group_id in live:
            teams_of.setdefault((m.employee_email or "").lower(), set()).add(m.group_id)
    used: dict = {}
    for a in db.query(ShiftAssignment).filter(ShiftAssignment.shift_id != "").all():
        used.setdefault(a.shift_id, set()).update(teams_of.get((a.employee_email or "").lower(), set()))
    for sid, em, gid in (db.query(ScheduledShift.shift_id, ScheduledShift.employee_email, ScheduledShift.group_id)
                         .filter(ScheduledShift.shift_id != "", ScheduledShift.work_date >= since).all()):
        # The team the placement was made under says it best; else the person's.
        teams = {gid} if gid and gid in live else teams_of.get((em or "").lower(), set())
        used.setdefault(sid, set()).update(teams)
    return {sid: t for sid, t in used.items() if t and t != live}


def apply_once(db: Session) -> dict | None:
    """Fill the types' teams once. Returns {name: [team names]} of what it
    linked, or None when it already ran."""
    if db.query(NexusSetting).filter(NexusSetting.key == MARK).first():
        return None
    names = {g.id: g.name for g in db.query(ShiftGroup).all()}
    by_use = teams_by_use(db)
    linked = {}
    for s in db.query(Shift).all():
        if (getattr(s, "group_ids", "") or "").strip():
            continue                                   # already set by hand
        teams = sorted(by_use.get(s.id, set()), key=lambda gid: (names.get(gid, "") or "").lower())
        if teams:
            s.group_ids = json.dumps(teams)
            linked[s.name or s.code or s.id] = [names.get(g, g) for g in teams]
    db.add(NexusSetting(key=MARK, value=json.dumps({"linked": linked}), updated_by="system"))
    db.commit()
    return linked
