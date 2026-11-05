"""Construction in the field (Neil, 11/03/2026, plan
https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr, phase 3 "Field and
Closeout"). The daily log that drafts itself, its delay lines, the morning
reminder for a missing log, and the facts the photo timeline and the weekly
report read. AI is OFF (ai_switch): nothing here calls a model - the log is
drafted from rows Nexus already holds, and the person adds what was unusual
(dictation is the browser's own speech recognition).

THE SELF-DRAFTING LOG. When someone opens today's log on a job, `prefill`
gathers, for that jobsite day (the jobsite's own zone, construction_company):

  weather   the jobsite's forecast for the day (construction_weather.site_weather,
            Open-Meteo through the widget's cache) - the day's sky, high, low and
            chance of rain, plus the reading at the moment the log was drafted
            (the "observed" temperature). Stored with weather_source 'forecast'
            until the person types over it ('typed').
  crew      Time Clock punches stamped with the jobsite that day
            (time_punches.jobsite, construction_labor.hours): how many people and
            how many hours. HOURS ONLY, never pay; the names and each person's
            hours only for a job reviewer (a crew member sees the totals).
  photos    the job's photos taken that day (the same privacy as the logs).
  punch     punch items marked Done and Verified that day.
  forms     form entries filed to the job that day (title, who, when - never
            the answers, which stay behind the Forms reach rule).
  delays    a suggested weather delay line when a Weather Call delayed, shortened
            or cancelled shifts at the jobsite that day (weather_call.py).

Everything is editable; the log keeps `prefill` as the record of where each
number came from.

DELAY LINES. A log's `delays` is [{cause, hours, note}] - one line per delay,
causes from DELAY_CAUSES. A delay line puts the Delay tag on the log (and a
weather cause the Weather tag), so the dashboard counts it; the weekly
report adds the hours by cause (`delay_summary`).

THE MORNING REMINDER. Once a day per job, from 7 AM jobsite time, when the
day before was worked on the job (a published placement at the jobsite that
a Weather Call did not cancel, or a punch stamped with it) and nobody filed a
log for it: ONE bell to the job's superintendent (else its managers), updated
in place day to day (construction_notify.bell, family "log_missing"). A day a
Weather Call cancelled at the jobsite is never asked for. `reminder_tick`
runs in `field_loop` (main.py lifespan, leader only, in a thread).
"""
from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

import construction_company
import models

DELAY_CAUSES = ("weather", "inspection", "material", "labor", "owner", "design", "equipment", "other")
DELAY_LABEL = {"weather": "Weather", "inspection": "Inspection", "material": "Material", "labor": "Labor",
               "owner": "Owner or Client", "design": "Design or RFI", "equipment": "Equipment", "other": "Other"}
MAX_DELAYS = 12
REMIND_FROM_HOUR = 7          # jobsite-local: the morning bell waits for the day to start
TICK_SEC = 15 * 60
_MARKS_KEY = "construction_log_reminders"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _zone(db: Session, p) -> ZoneInfo:
    return ZoneInfo(construction_company.zone_of(db, p))


def local_day_of(iso: str, tz: ZoneInfo) -> str:
    """'' or the jobsite-local YYYY-MM-DD of an ISO timestamp."""
    s = str(iso or "").strip()
    if not s:
        return ""
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return s[:10]
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(tz).date().isoformat()


def _us(day: str) -> str:
    try:
        return date.fromisoformat(str(day or "")[:10]).strftime("%m/%d/%Y")
    except ValueError:
        return str(day or "")


# ── Delay lines ──────────────────────────────────────────────────────────────

def clean_delays(value) -> list:
    """The delay lines a client sent, cleaned; raises ValueError with a
    sentence for the 422."""
    if value in (None, ""):
        return []
    if not isinstance(value, list):
        raise ValueError("Delays must be a list.")
    if len(value) > MAX_DELAYS:
        raise ValueError(f"A daily log holds at most {MAX_DELAYS} delay lines.")
    out = []
    for d in value:
        if not isinstance(d, dict):
            raise ValueError("Each delay line needs a cause and the hours lost.")
        cause = str(d.get("cause") or "").strip().lower()
        if cause not in DELAY_CAUSES:
            raise ValueError("Pick what caused the delay.")
        try:
            hours = round(float(d.get("hours") or 0), 2)
        except (TypeError, ValueError):
            raise ValueError("Hours lost must be a number.")
        if hours < 0 or hours > 24:
            raise ValueError("Hours lost must be between 0 and 24.")
        out.append({"cause": cause, "hours": hours, "note": str(d.get("note") or "").strip()[:300]})
    return out


def tags_with_delays(tags: list, delays: list) -> list:
    """A delay line flags the day: Delay, and Weather for a weather cause."""
    got = list(tags or [])
    if delays and "delay" not in got:
        got.append("delay")
    if any(d.get("cause") == "weather" for d in delays or []) and "weather" not in got:
        got.append("weather")
    return got


def delay_summary(logs) -> dict:
    """{total, byCause: {cause: hours}, weather, lines: [{date, cause, hours, note}]}
    over the delay lines of these logs - the weekly report's weather-delay
    summary, from what the crew wrote, never a guess."""
    by, lines = {}, []
    for lg in logs:
        for d in (getattr(lg, "delays", None) or []):
            if not isinstance(d, dict):
                continue
            c = d.get("cause") or "other"
            h = float(d.get("hours") or 0)
            by[c] = round(by.get(c, 0) + h, 2)
            lines.append({"date": lg.log_date, "cause": c, "hours": h, "note": d.get("note") or ""})
    return {"total": round(sum(by.values()), 2), "byCause": by, "weather": by.get("weather", 0.0),
            "lines": sorted(lines, key=lambda x: x["date"])}


# ── Subs on site (Round Two, 11/05/2026) ─────────────────────────────────────
# A log's `subs` is [{name, headcount, hours}] - one line per subcontractor on
# site that day. Free text for the name until the job's subs are Intacct
# vendors (plan item 7); the weekly report sums them beside the crew.
MAX_SUBS = 12


def clean_subs(value) -> list:
    if value in (None, ""):
        return []
    if not isinstance(value, list):
        raise ValueError("Subs on site must be a list.")
    if len(value) > MAX_SUBS:
        raise ValueError(f"A daily log holds at most {MAX_SUBS} subcontractor lines.")
    out = []
    for s in value:
        if not isinstance(s, dict) or not str(s.get("name") or "").strip():
            raise ValueError("Each subcontractor line needs the sub's name.")
        try:
            headcount = int(s.get("headcount") or 0)
            hours = round(float(s.get("hours") or 0), 2)
        except (TypeError, ValueError):
            raise ValueError("A sub's headcount and hours must be numbers.")
        if not (0 <= headcount <= 500) or not (0 <= hours <= 24 * 500):
            raise ValueError("A sub's headcount is 0 to 500 and its hours 0 to 12,000.")
        out.append({"name": str(s["name"]).strip()[:120], "headcount": headcount, "hours": hours})
    return out


def sub_summary(logs) -> dict:
    """{crewDays, hours, byName: {name: hours}} over these logs' sub lines."""
    days, hours, by = 0, 0.0, {}
    for lg in logs:
        for s in (getattr(lg, "subs", None) or []):
            if not isinstance(s, dict):
                continue
            days += int(s.get("headcount") or 0)
            h = float(s.get("hours") or 0)
            hours += h
            by[s.get("name") or "?"] = round(by.get(s.get("name") or "?", 0) + h, 2)
    return {"crewDays": days, "hours": round(hours, 2), "byName": by}


# ── The self-drafting log ────────────────────────────────────────────────────

def _weather_text(o: dict) -> str:
    from construction_weather import sky_words
    bits = [sky_words(o.get("code"))]
    unit = o.get("tempUnit") or "°F"
    if o.get("high") is not None and o.get("low") is not None:
        bits.append(f"high {round(o['high'])}{unit} / low {round(o['low'])}{unit}")
    if (o.get("chance") or 0) >= 10:      # a 1% chance is no news on a jobsite
        bits.append(f"{int(o['chance'])}% chance of rain")
    if (o.get("windMax") or 0) >= 15:
        bits.append(f"wind to {round(o['windMax'])} {o.get('windUnit') or 'mph'}")
    return ", ".join(b for b in bits if b and b != "-")


def weather_for(db: Session, p, day: str) -> dict | None:
    """The jobsite's weather for `day`: {text, code, high, low, chance,
    temperatureF, observedAt, source}. None when the site has no map point or
    the forecast does not reach the day. Never raises."""
    import construction_weather
    if not construction_weather.has_point(p):
        return None
    try:
        from routers.weather import forecast_for
        from weather_watch import DEFAULTS
        fc = forecast_for(p.latitude, p.longitude, "imperial")
        o = construction_weather.day_outlook(fc, day, DEFAULTS)
    except Exception as e:   # noqa: BLE001 - a forecast that cannot be read leaves the box empty
        print(f"[construction-field] weather {p.id}: {e}")
        return None
    if not o:
        return None
    cur = (fc.get("current") or {}) if isinstance(fc, dict) else {}
    observed = None
    if day == construction_company.local_today(db, p).isoformat() and cur.get("temp") is not None:
        observed = cur.get("temp")
    return {"text": _weather_text(o), "code": o.get("code"), "high": o.get("high"), "low": o.get("low"),
            "chance": o.get("chance"), "flag": o.get("flag") or "",
            "temperatureF": round(observed if observed is not None else (o.get("high") or 0)),
            "observedAt": _now() if observed is not None else "", "source": "forecast"}


def crew_for(db: Session, p, day: str, *, full: bool) -> dict:
    """Crew and hours from the day's punches at the jobsite. `full` (a job
    reviewer) adds each person's hours; otherwise totals only."""
    import construction_labor
    T = models.TimePunch
    key = construction_labor.key_for(p.id)
    worked = construction_labor.hours(db, p, date_from=day, date_to=day)
    hours_by = dict(worked.get("byPerson") or {})
    on_clock = {(em or "").lower() for (em,) in db.query(T.employee_email).filter(
        T.jobsite == key, T.local_date == day, T.kind == "in", (T.voided == 0) | (T.voided.is_(None))).distinct().all()}
    people = sorted(set(hours_by) | {e for e in on_clock if e})
    out = {"count": len(people), "hours": round(sum(hours_by.values()), 2)}
    if full:
        names = construction_company.people_names(db, people)
        out["people"] = [{"email": e, "name": names.get(e, ""), "hours": hours_by.get(e, 0)} for e in people]
    return out


def _visible_log_ids(db: Session, user: dict, p) -> set:
    from routers.construction import _may_review, _me
    L = models.ConstructionDailyLog
    me, reviewer = _me(user), _may_review(db, user, p)
    return {lg.id for lg in db.query(L).filter(L.project_id == p.id, L.deleted_at == "").all()
            if lg.status != "draft" or reviewer or (lg.author_email or "").lower() == me}


def visible_photos(db: Session, user: dict, p, kinds=("photo",)) -> list:
    """The job's media the caller may see: a submitted log's to everyone on
    the job, a draft's only to its author (and reviewers) - the logs' privacy -
    and every job photo (no log). Removed ones never."""
    M = models.ConstructionMedia
    ok = _visible_log_ids(db, user, p)
    rows = db.query(M).filter(M.project_id == p.id, M.deleted_at == "", M.kind.in_(list(kinds))).all()
    return [m for m in rows if not (m.daily_log_id or "") or m.daily_log_id in ok]


def _taken(m) -> str:
    return m.taken_at or m.uploaded_at or ""


def photos_on(db: Session, user: dict, p, day: str) -> list:
    tz = _zone(db, p)
    out = [m for m in visible_photos(db, user, p) if local_day_of(_taken(m), tz) == day]
    out.sort(key=_taken)
    return out


def punch_on(db: Session, p, day: str) -> dict:
    """Punch items marked Done and Verified on `day` (jobsite-local)."""
    import construction_tasks
    tp = construction_tasks.task_project(db, p)
    if tp is None:
        return {"done": [], "verified": []}
    sec = construction_tasks.punch_section(db, tp, create=False)
    ver = construction_tasks.verified_status(db, tp, create=False)
    if sec is None:
        return {"done": [], "verified": []}
    tz = _zone(db, p)
    T, PM = models.Task, models.ConstructionPunchMeta
    rows = db.query(T).filter(T.project_id == tp.id, T.section_id == sec.id, T.completed.is_(True)).all()
    meta = {m.task_id: m for m in db.query(PM).filter(PM.task_id.in_([t.id for t in rows] or [""])).all()}
    done, verified = [], []
    for t in rows:
        m = meta.get(t.id)
        when_done = (m.done_at if m and m.done_at else "") or t.completed_at or ""
        if local_day_of(when_done, tz) == day:
            done.append({"id": t.id, "title": t.title or "", "location": (m.location_text if m else "") or ""})
        if ver is not None and t.status == ver.id and m and m.verified_at and local_day_of(m.verified_at, tz) == day:
            verified.append({"id": t.id, "title": t.title or "", "location": m.location_text or ""})
    return {"done": done, "verified": verified}


def forms_on(db: Session, p, day: str, user: dict) -> list:
    """The form entries filed to the job that day that the reader may see
    (form_audience.viewer_reach - the ONE Forms reach rule, review M5)."""
    import form_audience
    tz = _zone(db, p)
    E = models.DocFormEntry
    reach = form_audience.viewer_reach(db, user)
    rows = db.query(E).filter(E.linked_project_id == p.id, E.deleted_at == "").all()
    rows = [e for e in rows if local_day_of(e.submitted_at, tz) == day and reach(e)]
    names = construction_company.people_names(db, [e.submitted_by for e in rows])
    return [{"id": e.id, "title": e.title or "Form", "submittedBy": (e.submitted_by or "").lower(),
             "submittedByName": names.get((e.submitted_by or "").lower(), ""), "submittedAt": e.submitted_at or "",
             "status": e.status or "submitted"} for e in sorted(rows, key=lambda e: e.submitted_at or "")]


def _hhmm_minutes(v: str):
    try:
        return int(v[:2]) * 60 + int(v[3:5])
    except (TypeError, ValueError, IndexError):
        return None


def weather_call_delay(db: Session, p, day: str) -> dict | None:
    """A suggested delay line when a Weather Call moved the jobsite's shifts
    that day: the most hours any one placement lost (a crew's day, not the
    sum of everyone's)."""
    import construction_labor
    S = models.ScheduledShift
    rows = (db.query(S).filter(S.jobsite == construction_labor.key_for(p.id), S.work_date == day,
                               S.published == 1, S.pending_delete == 0).all())
    lost, kinds = 0.0, set()
    for r in rows:
        st = (r.weather_status or "")
        if st not in ("cancelled", "delayed", "shortened"):
            continue
        kinds.add(st)
        s0, e0 = _hhmm_minutes(r.original_start_hhmm or r.start_hhmm or ""), _hhmm_minutes(r.original_end_hhmm or r.end_hhmm or "")
        s1, e1 = _hhmm_minutes(r.start_hhmm or ""), _hhmm_minutes(r.end_hhmm or "")
        if None in (s0, e0):
            continue
        planned = (e0 - s0) % 1440 or 1440
        if st == "cancelled":
            gone = planned
        elif None in (s1, e1):
            gone = 0
        else:
            gone = max(0, planned - ((e1 - s1) % 1440 or 1440))
        lost = max(lost, gone / 60.0)
    if not kinds:
        return None
    words = {"cancelled": "cancelled", "delayed": "delayed", "shortened": "ended early"}
    return {"cause": "weather", "hours": round(lost, 2),
            "note": "Weather Call: shifts " + " and ".join(words[k] for k in sorted(kinds)) + "."}


def prefill(db: Session, user: dict, p, day: str) -> dict:
    """Everything the daily log drafts itself from (see the module docstring)."""
    from routers.construction import _may_review
    full = _may_review(db, user, p)
    photos = photos_on(db, user, p, day)
    names = construction_company.people_names(db, [m.uploaded_by for m in photos])
    suggested = weather_call_delay(db, p, day)
    return {
        "date": day,
        "weather": weather_for(db, p, day),
        "crew": crew_for(db, p, day, full=full),
        "photos": [{"id": m.id, "url": m.url or "", "thumbnailUrl": m.thumbnail_url or m.url or "",
                    "takenAt": _taken(m), "uploadedBy": (m.uploaded_by or "").lower(),
                    "uploadedByName": names.get((m.uploaded_by or "").lower(), ""),
                    "logId": m.daily_log_id or "", "caption": m.caption or m.description or "",
                    "tags": list(m.tags or []), "location": m.location_text or ""} for m in photos],
        "punch": punch_on(db, p, day),
        "forms": forms_on(db, p, day, user),
        "suggestedDelays": [suggested] if suggested else [],
        "delayCauses": [{"key": k, "label": DELAY_LABEL[k]} for k in DELAY_CAUSES],
    }


def apply_prefill(l, pre: dict) -> None:
    """Fill an EMPTY new log's conditions from the prefill (never over what
    the person sent) and keep the record of where they came from."""
    w = pre.get("weather") or {}
    if not (l.weather or "").strip() and w.get("text"):
        l.weather = w["text"][:200]
        l.weather_source = "forecast"
        if not l.temperature_f and w.get("temperatureF") is not None:
            l.temperature_f = float(w["temperatureF"] or 0)
    crew = pre.get("crew") or {}
    if not l.crew_size and crew.get("count"):
        l.crew_size = int(crew["count"])
    if not l.hours_worked and crew.get("hours"):
        l.hours_worked = float(crew["hours"])
    if not (l.delays or []) and pre.get("suggestedDelays"):
        l.delays = list(pre["suggestedDelays"])
        l.tags = tags_with_delays(list(l.tags or []), l.delays)
    l.prefill = {
        "at": _now(),
        "weather": ({k: w.get(k) for k in ("text", "high", "low", "chance", "temperatureF", "observedAt", "source")}
                    if w else None),
        "crew": {"count": crew.get("count", 0), "hours": crew.get("hours", 0)},
        "photos": [x["id"] for x in pre.get("photos") or []],
        "punchDone": [x["id"] for x in (pre.get("punch") or {}).get("done") or []],
        "punchVerified": [x["id"] for x in (pre.get("punch") or {}).get("verified") or []],
        "forms": [x["id"] for x in pre.get("forms") or []],
    }


# ── The morning reminder ─────────────────────────────────────────────────────

def worked_day(db: Session, p, day: str) -> bool:
    """Was `day` a working day on the job? A published placement at the
    jobsite that a Weather Call did not cancel, or a punch stamped with it.
    A day every placement of which was weather-cancelled is not (and its
    punches alone do not make it one - the crew was sent home)."""
    import construction_labor
    S, T = models.ScheduledShift, models.TimePunch
    key = construction_labor.key_for(p.id)
    rows = (db.query(S.weather_status).filter(S.jobsite == key, S.work_date == day, S.published == 1,
                                              S.pending_delete == 0).all())
    if rows and all((r[0] or "") == "cancelled" for r in rows):
        return False
    if any((r[0] or "") != "cancelled" for r in rows):
        return True
    return db.query(T.id).filter(T.jobsite == key, T.local_date == day, T.kind == "in",
                                 (T.voided == 0) | (T.voided.is_(None))).first() is not None


def has_log(db: Session, p, day: str) -> bool:
    L = models.ConstructionDailyLog
    return db.query(L.id).filter(L.project_id == p.id, L.log_date == day, L.deleted_at == "",
                                 L.status != "draft").first() is not None


def reminder_recipients(db: Session, p) -> list:
    sup = (getattr(p, "superintendent_email", "") or "").strip().lower()
    if sup:
        return [sup]
    from construction_notify import reviewers
    named = [e for e in (p.manager_emails or []) if (e or "").strip()]
    return sorted({e.strip().lower() for e in named}) or reviewers(db, p)


def _marks(db: Session) -> dict:
    import json
    row = db.get(models.NexusSetting, _MARKS_KEY)
    try:
        return json.loads(row.value) if row and row.value else {}
    except ValueError:
        return {}


def _save_marks(db: Session, marks: dict) -> None:
    import json
    row = db.get(models.NexusSetting, _MARKS_KEY)
    if row is None:
        db.add(models.NexusSetting(key=_MARKS_KEY, value=json.dumps(marks)))
    else:
        row.value = json.dumps(marks)


def remind_one(db: Session, p, now: datetime | None = None, marks: dict | None = None) -> bool:
    """Ask for yesterday's log on one job when it is missing. True when a
    bell went out. Once per job and day (marks)."""
    import construction_notify
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    local = now.astimezone(_zone(db, p))
    if local.hour < REMIND_FROM_HOUR:
        return False
    today = local.date()
    yday = (today - timedelta(days=1)).isoformat()
    marks = marks if marks is not None else _marks(db)
    if marks.get(p.id) == yday:
        return False
    if (p.status or "active") != "active" or p.archived or (p.deleted_at or ""):
        return False
    if not worked_day(db, p, yday) or has_log(db, p, yday):
        return False
    to = reminder_recipients(db, p)
    for em in to:
        construction_notify.bell(
            db, kind="log_missing", family=("log_missing",), recipient=em, ref_id=f"log-missing:{p.id}",
            title="Daily Log Missing",
            body=f"No daily log was filed for {p.name} on {_us(yday)}. Open the job to file it.",
            label="Open Site Activity", sub=f"activity:{p.id}",
            company=getattr(p, "company_id", "") or "")
    marks[p.id] = yday
    return bool(to)


def close_reminder(db: Session, p, day: str) -> int:
    """A log filed for the day a missing-log bell asked about: that bell is
    done (rewritten in place, never a new one). Other days' bells stay."""
    R = models.NexusNotification
    n = 0
    for row in (db.query(R).filter(R.ref_id == f"log-missing:{p.id}", R.type == "construction_log_missing",
                                   R.actioned.is_(False)).all()):
        if _us(day) in (row.body or ""):
            row.title = "Daily Log Filed"
            row.body = f"The daily log for {p.name} on {_us(day)} was filed."
            row.actioned = True
            n += 1
    return n


def reminder_tick(db: Session, now: datetime | None = None) -> int:
    P = models.ConstructionProject
    marks = _marks(db)
    n = 0
    for p in db.query(P).filter(P.deleted_at == "", P.status == "active").all():
        # One commit per job (review L9): a job that fails never takes another
        # job's bell or mark with it.
        try:
            if remind_one(db, p, now=now, marks=marks):
                n += 1
            _save_marks(db, marks)
            db.commit()
        except Exception as e:   # noqa: BLE001 - one job never stops the rest
            db.rollback()
            marks = _marks(db)
            print(f"[construction-field] reminder {p.id}: {e}")
    return n


def inspection_tick(db: Session, now: datetime | None = None) -> int:
    """The day before an inspection is due (Round Two, 11/05/2026): one bell
    to the superintendent, else the managers - once per record and due date
    (the same marks as the missing-log bell, keyed insp:<record id>)."""
    import construction_notify
    R, P = models.ConstructionCloseoutRecord, models.ConstructionProject
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    jobs = {p.id: p for p in db.query(P).filter(P.deleted_at == "", P.status == "active").all()}
    recs = (db.query(R).filter(R.project_id.in_(list(jobs) or [""]), R.deleted_at == "", R.kind == "inspection",
                               R.result.in_(("", "pending")), R.due_on != "").all()) if jobs else []
    marks = _marks(db)
    n = 0
    for r in recs:
        p = jobs[r.project_id]
        local = now.astimezone(_zone(db, p))
        key = f"insp:{r.id}"
        if local.hour < REMIND_FROM_HOUR or r.due_on != (local.date() + timedelta(days=1)).isoformat() \
                or marks.get(key) == r.due_on:
            continue
        for em in reminder_recipients(db, p):
            construction_notify.bell(
                db, kind="inspection_due", family=("inspection_due",), recipient=em, ref_id=f"inspection:{r.id}",
                title="Inspection Tomorrow",
                body=f"{r.title or 'Inspection'}{' with ' + r.ahj if r.ahj else ''} on {p.name} is scheduled for {_us(r.due_on)}.",
                label="Open Permits And Inspections", sub=f"project:{p.id}:permits",
                company=getattr(p, "company_id", "") or "")
        marks[key] = r.due_on
        n += 1
    _save_marks(db, marks)
    db.commit()
    return n


async def field_loop():
    """The morning reminder, every TICK_SEC on the leader - DB work, in a
    thread (never on the event loop)."""
    from database import SessionLocal
    await asyncio.sleep(180)
    while True:
        try:
            def _pass():
                db = SessionLocal()
                try:
                    return reminder_tick(db) + inspection_tick(db)
                finally:
                    db.close()
            n = await asyncio.to_thread(_pass)
            if n:
                print(f"[construction-field] {n} missing-log reminder(s)")
        except Exception as e:  # noqa: BLE001 - the loop must outlive one bad pass
            print(f"[construction-field] pass skipped: {e}")
        await asyncio.sleep(TICK_SEC)
