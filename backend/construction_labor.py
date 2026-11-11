"""Crews and labor on a Job (Neil, 11/03/2026, plan
https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr, phase 2).

CREW. The crew is whoever the Shifts planner placed at the jobsite key
`project-<job id>` (jobsites.py) - the one place a crew is scheduled. "This
Week's Crew" reads the published, live placements (not removed, not called
off by weather) in the job's week, with the planned paid hours
(shift_attendance._paid_minutes - the planner's own rule).

LABOR. Hours worked on a job come from Time Clock punches carrying
`time_punches.jobsite`. Choice made (and why): the jobsite is STAMPED on the
IN punch when it is written, from that person-day's live placement, rather
than derived later from the shift. A stamp is a record - a shift moved,
re-placed or deleted next week never rewrites where last week's hours were
worked, and a punch with no placement stays unattributed instead of being
guessed. The stamp is a before_flush hook on new IN punches (`wire`, in
database.py), so every path that writes one - the live clock, the phone,
the offline replay, a manager's add or Add Time - is covered without a
change to each route. Only `jobsite` is written: never `category` (the
leave rule, _leave_class, reads it), never the time, so the time sheet,
pay and timesheet review (guard_edit) are untouched.

  one placement with a jobsite that day        that jobsite
  several                                      the one whose hours hold the
                                               punch time, else the earliest
  none (or only the team's own site '')        '' - not on any job

Hours per day and person = each in -> out pair whose IN punch carries the
job's key, less the breaks inside it; voided punches, pending edits (only
`at` counts, as for pay) and leave pairs (Sick / Vacation categories) are
left out. HOURS ONLY - nothing here reads a rate, so a manager sees hours
and never pay. A crew member sees only their own row.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import event
from sqlalchemy.orm import Session

# `models` is imported inside each function: database.py imports this module
# to wire the hook before models.py (which needs database.Base) can load.
PROJECT = "project-"


def key_for(job_id: str) -> str:
    return PROJECT + (job_id or "")


def _minutes(hhmm: str):
    try:
        return int(hhmm[:2]) * 60 + int(hhmm[3:5])
    except (TypeError, ValueError, IndexError):
        return None


def _local_minute(punch) -> int | None:
    """The punch's wall-clock minute of the day in the puncher's zone
    (tz_offset_min is JS getTimezoneOffset: UTC - local, in minutes)."""
    try:
        at = datetime.fromisoformat(str(punch.at).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    local = at.astimezone(timezone.utc) - timedelta(minutes=int(punch.tz_offset_min or 0))
    return local.hour * 60 + local.minute


def placement_jobsite(db: Session, email: str, work_date: str, minute: int | None = None) -> str:
    """The jobsite of that person-day's live placement ('' when none names one)."""
    import models
    S = models.ScheduledShift
    em = (email or "").strip().lower()
    if not em or not work_date:
        return ""
    rows = [r for r in db.query(S).filter(S.employee_email == em, S.work_date == work_date,
                                          S.published == 1, S.pending_delete == 0).all()
            if (r.weather_status or "") != "cancelled" and (r.jobsite or "")]
    if not rows:
        return ""
    if len({r.jobsite for r in rows}) == 1:
        return rows[0].jobsite
    if minute is not None:
        for r in rows:
            s, e = _minutes(r.start_hhmm or ""), _minutes(r.end_hhmm or "")
            if s is None or e is None:
                continue
            inside = (s <= minute <= e) if e > s else (minute >= s or minute <= e)
            if inside:
                return r.jobsite
    return sorted(rows, key=lambda r: r.start_hhmm or "")[0].jobsite


def stamp_jobsite(db: Session, punch) -> str:
    if (punch.kind or "") != "in" or (getattr(punch, "jobsite", "") or ""):
        return getattr(punch, "jobsite", "") or ""
    js = placement_jobsite(db, punch.employee_email, punch.local_date or "", _local_minute(punch))
    if js:
        punch.jobsite = js
    return js


# ── Cost codes on a punch (Round Three item 3, Neil, 11/11/2026) ────────────
# The person picks one of the job's labor codes (an Intacct item, the job's
# `labor_codes`) at punch-in; the phone remembers the last one per job and
# sends it with the job it was picked for. It is KEPT only on an IN punch
# whose stamped jobsite is that job, with the code on that job's list -
# anything else is dropped, and the punch always lands.

def offer_cost_code(punch, code: str, job_id: str = "") -> None:
    """Put the picked code on a new IN punch, to be checked at flush."""
    punch.cost_code = (code or "").strip()[:60]
    punch._cost_code_job = (job_id or "").strip()[:64]


def labor_codes_of(job) -> list:
    """The job's labor codes, cleaned: [{code, name}]."""
    out = []
    for c in (getattr(job, "labor_codes", None) or []):
        if isinstance(c, dict) and str(c.get("code") or "").strip():
            out.append({"code": str(c["code"]).strip(), "name": str(c.get("name") or "").strip()})
    return out


def check_cost_code(db: Session, punch) -> str:
    import models
    code = (getattr(punch, "cost_code", "") or "").strip()
    if not code:
        return ""
    js = getattr(punch, "jobsite", "") or ""
    wanted = getattr(punch, "_cost_code_job", "") or ""
    job = db.get(models.ConstructionProject, js[len(PROJECT):]) if (punch.kind or "") == "in" and js.startswith(PROJECT) else None
    ok = (job is not None and not job.deleted_at and (not wanted or wanted == job.id)
          and code in {c["code"] for c in labor_codes_of(job)})
    punch.cost_code = code if ok else ""
    return punch.cost_code


def wire(session_factory) -> None:
    @event.listens_for(session_factory, "before_flush")
    def _stamp_new_in_punches(session, _ctx, _instances):
        import models
        new = [o for o in session.new if isinstance(o, models.TimePunch) and (o.kind or "") == "in"
               and (not (getattr(o, "jobsite", "") or "") or (getattr(o, "cost_code", "") or ""))]
        if not new:
            return
        with session.no_autoflush:
            for p in new:
                try:
                    stamp_jobsite(session, p)
                    check_cost_code(session, p)
                except Exception as e:   # noqa: BLE001 - a stamp never fails a punch
                    p.cost_code = ""
                    print(f"[construction-labor] stamp {getattr(p, 'id', '')}: {e}")


# ── The job's week and crew ──────────────────────────────────────────────────

def week_bounds(job, today: date) -> tuple[date, date]:
    """The job's week holding `today` (its own week_starts_on: 0 = Sunday)."""
    start_dow = int(job.week_starts_on if job.week_starts_on is not None else 1)
    py = (start_dow - 1) % 7          # Python: Monday = 0
    d0 = today - timedelta(days=(today.weekday() - py) % 7)
    return d0, d0 + timedelta(days=6)


def crew_this_week(db: Session, job, today: date) -> dict:
    """{weekStart, weekEnd, people: [{email, days: [YYYY-MM-DD], plannedHours}]}"""
    import models
    from shift_attendance import _paid_minutes
    S = models.ScheduledShift
    d0, d1 = week_bounds(job, today)
    rows = (db.query(S).filter(S.jobsite == key_for(job.id), S.work_date >= d0.isoformat(),
                               S.work_date <= d1.isoformat(), S.published == 1, S.pending_delete == 0).all())
    people: dict = {}
    for r in rows:
        em = (r.employee_email or "").strip().lower()
        if not em or (r.weather_status or "") == "cancelled":
            continue
        p = people.setdefault(em, {"email": em, "days": set(), "plannedMin": 0})
        p["days"].add(r.work_date)
        p["plannedMin"] += _paid_minutes(r)
    out = [{"email": p["email"], "days": sorted(p["days"]), "plannedHours": round(p["plannedMin"] / 60.0, 2)}
           for p in people.values()]
    out.sort(key=lambda p: (-len(p["days"]), p["email"]))
    return {"weekStart": d0.isoformat(), "weekEnd": d1.isoformat(), "people": out}


# ── Hours from the punches ───────────────────────────────────────────────────

def _dt(s):
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _pairs(punches: list) -> list:
    """[(in_punch, worked_minutes)] for one person-day's punches, in order."""
    out, cur, brk_start, brk = [], None, None, 0
    for p in sorted(punches, key=lambda x: x.at or ""):
        k = p.kind or ""
        if k == "in":
            cur, brk_start, brk = p, None, 0
        elif k == "break_start" and cur is not None:
            brk_start = _dt(p.at)
        elif k == "break_end" and cur is not None and brk_start is not None:
            e = _dt(p.at)
            if e and e > brk_start:
                brk += int((e - brk_start).total_seconds() // 60)
            brk_start = None
        elif k == "out" and cur is not None:
            a, b = _dt(cur.at), _dt(p.at)
            if a and b and b > a:
                out.append((cur, max(0, int((b - a).total_seconds() // 60) - brk)))
            cur, brk_start, brk = None, None, 0
    return out


def hours(db: Session, job, *, date_from: str = "", date_to: str = "", only_email: str = "") -> dict:
    """{rows: [{date, email, hours}], byPerson: {email: h}, byDay: {date: h},
    byCode: [{code, name, hours}] ('' = Not Coded), total}"""
    import models
    from routers.timeclock import _leave_class
    T = models.TimePunch
    q = db.query(T.employee_email, T.local_date).filter(T.jobsite == key_for(job.id), T.kind == "in",
                                                        (T.voided == 0) | (T.voided.is_(None)))
    if date_from:
        q = q.filter(T.local_date >= date_from)
    if date_to:
        q = q.filter(T.local_date <= date_to)
    if only_email:
        q = q.filter(T.employee_email == only_email.lower())
    days = {((em or "").lower(), d) for em, d in q.distinct().all() if em and d}
    rows, by_person, by_day, by_code_min = [], {}, {}, {}
    for em, d in sorted(days, key=lambda x: (x[1], x[0])):
        punches = (db.query(T).filter(T.employee_email == em, T.local_date == d,
                                      (T.voided == 0) | (T.voided.is_(None))).all())
        pairs = [(p, m) for p, m in _pairs(punches)
                 if (getattr(p, "jobsite", "") or "") == key_for(job.id) and not _leave_class(p.category or "")]
        mins = sum(m for _p, m in pairs)
        if mins <= 0:
            continue
        # Round Three item 3: the same minutes by the IN punch's cost code.
        for p, m in pairs:
            k = getattr(p, "cost_code", "") or ""
            by_code_min[k] = by_code_min.get(k, 0) + m
        h = round(mins / 60.0, 2)
        rows.append({"date": d, "email": em, "hours": h})
        by_person[em] = round(by_person.get(em, 0) + h, 2)
        by_day[d] = round(by_day.get(d, 0) + h, 2)
    names = {c["code"]: c["name"] for c in labor_codes_of(job)}
    by_code = [{"code": k, "name": names.get(k, "") if k else "Not Coded", "hours": round(v / 60.0, 2)}
               for k, v in sorted(by_code_min.items(), key=lambda kv: (kv[0] == "", kv[0])) if v > 0]
    return {"rows": rows, "byPerson": by_person, "byDay": by_day, "byCode": by_code,
            "total": round(sum(r["hours"] for r in rows), 2)}
