"""The weather call (Weather Call, Phase 2 - Neil, Oct 10 2026).

The advisory (weather_watch.py) informs; this is the decision. A decider -
the company manager, or a designee named on the shift group, each with
Manage access to Shifts - opens one group's day, picks WHO the call applies
to (everyone checked by default; anyone unchecked keeps their shift and
their pay), picks ONE of a fixed set of decisions, gives a reason, and
confirms. Nexus then:

  - changes the shift rows in place (a cancelled day is kept on the grid,
    struck through, unpaid; a delayed or shortened one keeps its original
    times; a moved one keeps its original label) and cancels pending swap
    / offer / open requests on them;
  - writes ONE weather_decisions row - the roster as it stood, each
    person's outcome, every channel's result, and later each person's
    acknowledgment - which is what settles "who was told what, when";
  - tells the people affected on every channel at once: a priority bell, an
    email with an Acknowledge button, a text (on by default; a person can
    turn their own texts off, and a person with no phone is marked so on
    the decider's roster), and an URGENT Teams message from the decider;
  - tells everyone unchecked, quietly, that their shift stands;
  - posts a summary in the group's Teams chat and writes the call as the
    day's note (editable afterward, like any day note).

Acknowledgment is one tap on a signed link (same pattern as the task email
buttons) or the button in My Shifts. Silence escalates: a second text at
30 minutes, and at 60 the decider gets a priority bell naming who has not
seen it, with phone numbers on the screen. Reinstate undoes the call and
tells the same people. Pay follows punches, so a cancelled shift simply has
no punch; the Workforce Scorecard treats cancelled hours as excused.

Everything here is synchronous DB and HTTP work: the routes are plain
`def`, the follow-up loop runs its tick in a thread.
"""
import asyncio
import base64
import hashlib
import hmac
import json
import time
import uuid
from datetime import datetime, timezone, timedelta
from html import escape

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

import models
import weather_watch
from app_url import app_url
from database import SessionLocal

KINDS = ("cancel", "delay", "end_early", "move", "proceed")
OUTCOME = {"cancel": "cancelled", "delay": "delayed", "end_early": "shortened", "move": "moved", "proceed": "kept"}
REMIND_AFTER_MIN = 30      # a second text to anyone still silent
ESCALATE_AFTER_MIN = 60    # ...then the decider is told who has not acknowledged
FOLLOW_UP_SCAN_SEC = 5 * 60
TOKEN_TTL_SEC = 14 * 24 * 3600
_CONTEXT = b"weather-call-ack:v1:"
MY_SHIFTS = {"view": "shifts", "sub": "mine"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime = None) -> str:
    return (dt or _now()).isoformat()


# ── Signed acknowledgment links ───────────────────────────────────────────

def _secret() -> bytes:
    from task_mail_actions import _SECRET
    return _SECRET


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign_ack(decision_id: str, email: str, *, now: float = None) -> str:
    payload = json.dumps({"d": decision_id, "r": (email or "").lower(), "e": int((now or time.time()) + TOKEN_TTL_SEC)},
                         separators=(",", ":")).encode()
    sig = hmac.new(_secret(), _CONTEXT + payload, hashlib.sha256).digest()[:16]
    return f"{_b64(payload)}.{_b64(sig)}"


def verify_ack(token: str, *, now: float = None) -> dict | None:
    try:
        p64, s64 = (token or "").split(".", 1)
        payload = _unb64(p64)
        want = hmac.new(_secret(), _CONTEXT + payload, hashlib.sha256).digest()[:16]
        if not hmac.compare_digest(want, _unb64(s64)):
            return None
        data = json.loads(payload)
        if int(data.get("e", 0)) < (now or time.time()):
            return None
        return {"decision_id": data["d"], "email": data.get("r", "")}
    except Exception:   # noqa: BLE001 - a bad token is just invalid
        return None


def ack_url(decision_id: str, email: str) -> str:
    from task_mail_actions import api_base
    return f"{api_base()}/weather-call/ack?t={sign_ack(decision_id, email)}"


# ── Who may decide ────────────────────────────────────────────────────────

def may_decide(db: Session, user: dict, g, company_id: str) -> bool:
    """A decider named on the group, one of its schedulers, a manager of its
    company, or anyone with company-wide team access - each with Manage
    access to Shifts (manager and above)."""
    from routers.timeclock import can_manage_shifts, _visible_emails, _schedulers, _weather_deciders
    if not can_manage_shifts(user):
        return False
    em = (user.get("email") or "").lower()
    if em in _weather_deciders(g) or em in _schedulers(g) or em in weather_watch.company_managers(db, company_id):
        return True
    return _visible_emails(db, user) is None


# ── Reading the day ───────────────────────────────────────────────────────

def _group(db: Session, group_id: str):
    return db.query(models.ShiftGroup).filter(models.ShiftGroup.id == group_id).first()


def _members(db: Session, group_id: str) -> list:
    return [(m.employee_email or "").lower() for m in
            db.query(models.ShiftGroupMember).filter(models.ShiftGroupMember.group_id == group_id).all()]


def day_shifts(db: Session, g, day: str, member_emails: list, lock: bool = False) -> list:
    """The group's published shifts that day: rows on the group, plus older
    rows with no group on its members. Open slots (no person) included."""
    S = models.ScheduledShift
    # A row a delay moved past midnight lives on the next day now but still
    # belongs to this day's call (original_work_date).
    q = (db.query(S)
         .filter(or_(S.work_date == day, S.original_work_date == day), S.published == 1, S.pending_delete == 0,
                 or_(S.group_id == g.id,
                     and_(or_(S.group_id == "", S.group_id == None),   # noqa: E711 - older rows with no group
                          func.lower(S.employee_email).in_(list(member_emails) or ["-"])))))
    if lock:
        q = q.with_for_update()   # these rows only - never the whole day's schedule
    return q.all()


def _prefs(db: Session, emails: list) -> dict:
    rows = db.query(models.NexusPersonPref).filter(models.NexusPersonPref.email.in_(list(emails))).all() if emails else []
    return {r.email: bool(int(r.weather_sms if r.weather_sms is not None else 1)) for r in rows}


def _name(e) -> str:
    if e is None:
        return ""
    return (e.display_name or "").strip() or f"{e.first_name or ''} {e.last_name or ''}".strip() or (e.work_email or "")


def _t12(hhmm: str) -> str:
    try:
        h, m = (int(x) for x in (hhmm or "")[:5].split(":"))
    except ValueError:
        return hhmm or ""
    return f"{(h % 12) or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"


def _day_label(day: str) -> str:
    try:
        d = datetime.strptime(day, "%Y-%m-%d")
        return f"{d.strftime('%a')} {d.strftime('%m/%d')}"
    except ValueError:
        return day


def _shift_dict(r) -> dict:
    return {"id": r.id, "email": (r.employee_email or "").lower(), "date": r.work_date or "",
            "start": (r.start_hhmm or "")[:5], "end": (r.end_hhmm or "")[:5],
            "label": r.label or "", "weatherStatus": getattr(r, "weather_status", "") or "",
            "originalStart": getattr(r, "original_start_hhmm", "") or "", "originalEnd": getattr(r, "original_end_hhmm", "") or "",
            "openSlots": int(getattr(r, "open_slots", 0) or 0)}


def roster(db: Session, g, day: str, people: dict = None) -> list:
    """Everyone on the group's day with their shifts, phone and texts
    switch, by name. Open slots come last as one row with no email."""
    people = people if people is not None else weather_watch._people(db)
    rows = day_shifts(db, g, day, _members(db, g.id))
    emails = sorted({(r.employee_email or "").lower() for r in rows if r.employee_email})
    prefs = _prefs(db, emails)
    out = []
    for em in emails:
        e = people.get(em)
        out.append({"email": em, "name": _name(e) or em, "phone": bool(e is not None and (e.phone or "").strip()),
                    "smsOn": prefs.get(em, True), "active": e is not None,
                    "shifts": [_shift_dict(r) for r in rows if (r.employee_email or "").lower() == em]})
    out.sort(key=lambda p: p["name"].lower())
    open_rows = [_shift_dict(r) for r in rows if not r.employee_email]
    if open_rows:
        out.append({"email": "", "name": "Open shifts", "phone": False, "smsOn": False, "active": False, "shifts": open_rows})
    return out


def _outlook(db: Session, group_id: str, day: str) -> dict:
    r = db.query(models.WeatherOutlook).filter(models.WeatherOutlook.id == f"{group_id}:{day}").first()
    if not r:
        return {}
    try:
        hourly = json.loads(r.hourly_json or "[]")
    except (TypeError, ValueError):
        hourly = []
    try:
        alerts = json.loads(r.alerts_json or "[]")
    except (TypeError, ValueError):
        alerts = []
    return {"band": r.band, "chance": int(r.chance or 0), "inches": float(r.inches or 0), "storm": bool(r.storm), "alerts": alerts,
            "windowStart": r.window_start or "", "windowEnd": r.window_end or "", "hourly": hourly, "updatedAt": r.updated_at or ""}


def latest_decision(db: Session, group_id: str, day: str):
    return (db.query(models.WeatherDecision)
            .filter(models.WeatherDecision.group_id == group_id, models.WeatherDecision.work_date == day)
            .order_by(models.WeatherDecision.decided_at.desc()).first())


def decision_dict(db: Session, d, people: dict = None) -> dict:
    people = people if people is not None else weather_watch._people(db)
    try:
        ppl = json.loads(d.people_json or "[]")
    except (TypeError, ValueError):
        ppl = []
    try:
        outlook = json.loads(d.outlook_json or "{}")
    except (TypeError, ValueError):
        outlook = {}
    for p in ppl:
        p["name"] = _name(people.get(p["email"])) or p.get("name") or p["email"]
    selected = [p for p in ppl if p.get("selected")]
    g = _group(db, d.group_id)
    return {"id": d.id, "groupId": d.group_id, "groupName": g.name if g else "", "date": d.work_date, "kind": d.kind,
            "outcome": OUTCOME.get(d.kind, ""), "newStart": d.new_start or "", "newEnd": d.new_end or "", "moveTo": d.move_to or "",
            "reason": d.reason or "", "sms": bool(d.sms), "status": d.status, "unpaid": d.kind == "cancel",
            "decidedBy": d.decided_by, "decidedByName": _name(people.get(d.decided_by)) or d.decided_by, "decidedAt": d.decided_at,
            "escalatedAt": d.escalated_at or "", "reinstatedBy": d.reinstated_by or "", "reinstatedAt": d.reinstated_at or "",
            "people": ppl, "selectedCount": len(selected), "ackedCount": sum(1 for p in selected if p.get("ackAt")),
            "pendingCount": sum(1 for p in selected if not p.get("ackAt")), "outlook": outlook}


def screen(db: Session, user: dict, g, day: str) -> dict:
    """Everything the Weather Call screen needs for one group-day."""
    people = weather_watch._people(db)
    cid = weather_watch.group_company(db, g, _members(db, g.id), people)
    deciders, told = weather_watch.deciders_for(db, g, cid)
    d = latest_decision(db, g.id, day)
    note = (db.query(models.ScheduleDayNote)
            .filter(models.ScheduleDayNote.work_date == day, models.ScheduleDayNote.group_id == g.id).first())
    site = db.query(models.HrWorkSite).filter(models.HrWorkSite.id == (getattr(g, "work_site_id", "") or "")).first()
    cfg = weather_watch.get_config(db)
    can = may_decide(db, user, g, cid)
    head = {"group": {"id": g.id, "name": g.name, "workSiteName": site.name if site else "",
                      "deciders": [{"email": e, "name": _name(people.get(e)) or e} for e in deciders]},
            "date": day, "outlook": _outlook(db, g.id, day), "canDecide": can,
            "smsDefault": bool(cfg.get("smsDefault", True)), "dayNote": note.note if note else "", "companyId": cid}
    if not can:
        # A shift manager with no say over this group sees the forecast and
        # who makes the call - never the roster or anyone's phone number.
        return {**head, "roster": [], "decision": None}
    # The decider's roster carries the numbers: a call may be needed for
    # anyone who stays silent.
    def phone_of(em):
        e = people.get(em)
        return (e.phone or "").strip() if e is not None else ""
    ros = roster(db, g, day, people)
    for p in ros:
        p["phoneNumber"] = phone_of(p["email"]) if p["email"] else ""
    dec = decision_dict(db, d, people) if d else None
    if dec:
        for p in dec["people"]:
            p["phoneNumber"] = phone_of(p["email"])
    return {**head, "roster": ros, "decision": dec}


# ── Making the call ───────────────────────────────────────────────────────

def _check_hhmm(v: str, what: str) -> str:
    v = (v or "").strip()[:5]
    try:
        h, m = (int(x) for x in v.split(":"))
    except ValueError:
        raise ValueError(f"{what} needs a time like 09:30.")
    if not (0 <= h < 24 and 0 <= m < 60):
        raise ValueError(f"{what} needs a time like 09:30.")
    return f"{h:02d}:{m:02d}"


def _mins(hhmm: str) -> int:
    h, m = (int(x) for x in (hhmm or "00:00")[:5].split(":"))
    return h * 60 + m


def _next_day(day: str) -> str:
    return (datetime.strptime(day, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")


def _apply_to_shift(r, kind: str, new_start: str, new_end: str, move_to: str, decision_id: str) -> str:
    """Change one shift row for the call. Returns this shift's outcome.

    Times are read relative to the shift's own start, so an overnight shift
    (10:00 PM - 4:00 AM) works the same as a day shift (Oct 12):
      - delay: a new start inside the shift delays it - past midnight on an
        overnight shift, the row moves to the next calendar day (its day is
        kept in original_work_date for Reinstate); a new start at or before
        the shift's own start leaves it unchanged ("kept" - a crew with
        staggered starts is never moved EARLIER by a delay); a start past
        the end cancels it.
      - end_early: a new end inside the shift shortens it; one at or after
        its own end leaves it unchanged; one at or before its start cancels.
      A time in the gap between a shift's end and its next start counts
      toward whichever edge it is nearer: 8:00 AM on a 9:00 AM - 5:00 PM
      shift is "before the start", 6:00 PM is "after the end"."""
    if not (getattr(r, "original_start_hhmm", "") or ""):
        r.original_start_hhmm, r.original_end_hhmm = (r.start_hhmm or "")[:5], (r.end_hhmm or "")[:5]
        r.original_label = r.label or ""
    r.weather_decision_id = decision_id
    if kind == "proceed":
        r.weather_status = "kept"
        return "kept"
    if kind == "cancel":
        r.weather_status = "cancelled"
        return "cancelled"
    if kind == "move":
        r.label, r.weather_status = move_to[:80], "moved"
        return "moved"
    s0 = _mins(r.start_hhmm)
    length = (_mins(r.end_hhmm) - s0) % 1440 or 1440   # end == start: a 24-hour shift
    rel = ((_mins(new_start if kind == "delay" else new_end)) - s0) % 1440
    in_gap = rel > length or (rel == length and kind == "delay")
    nearer_end = in_gap and (rel - length) <= (1440 - rel)
    if kind == "delay":
        if rel == 0 or (in_gap and not nearer_end):
            r.weather_status = "kept"     # starts at or after the new time already
            return "kept"
        if in_gap:
            r.weather_status = "cancelled"   # a start at or past the end is no shift
            return "cancelled"
        if s0 + rel >= 1440 and not (getattr(r, "original_work_date", "") or ""):
            # Past midnight: the shift now starts on the next calendar day.
            r.original_work_date = r.work_date
            r.work_date = _next_day(r.work_date)
        r.start_hhmm, r.weather_status = new_start, "delayed"
        return "delayed"
    # end_early
    if rel == length or (in_gap and nearer_end):
        r.weather_status = "kept"         # ends at or before the new time already
        return "kept"
    if rel == 0 or in_gap:
        r.weather_status = "cancelled"    # an end at or before the start is no shift
        return "cancelled"
    r.end_hhmm, r.weather_status = new_end, "shortened"
    return "shortened"


def headline(kind: str, new_start: str = "", new_end: str = "", move_to: str = "") -> str:
    return {"cancel": "Day cancelled for weather (unpaid)",
            "delay": f"Start delayed to {_t12(new_start)} for weather",
            "end_early": f"Ending early at {_t12(new_end)} for weather",
            "move": f"Moved to {move_to} for weather",
            "proceed": "Going ahead as planned despite the forecast"}.get(kind, kind)


def decide(db: Session, user: dict, g, day: str, body: dict, defer=None) -> dict:
    """Make (or remake) the call for one group-day. `body`: kind, emails
    (who it applies to), new_start / new_end / move_to as the kind needs,
    reason (required), sms (text the crew; default from settings).
    `defer` - see _run: the route hands the texts, email and Teams to a
    background task and answers at once with what was queued."""
    kind = (body.get("kind") or "").strip()
    if kind not in KINDS:
        raise ValueError("Pick what to do: cancel, delay, end early, move, or proceed.")
    reason = (body.get("reason") or "").strip()[:300]
    if not reason:
        raise ValueError("Give the crew a short reason.")
    new_start = _check_hhmm(body.get("new_start"), "The new start") if kind == "delay" else ""
    new_end = _check_hhmm(body.get("new_end"), "The new end") if kind == "end_early" else ""
    move_to = (body.get("move_to") or "").strip()[:80] if kind == "move" else ""
    if kind == "move" and not move_to:
        raise ValueError("Say where the crew should go instead.")
    people = weather_watch._people(db)
    cid = weather_watch.group_company(db, g, _members(db, g.id), people)
    cfg = weather_watch.get_config(db)
    sms = bool(body.get("sms")) if body.get("sms") is not None else bool(cfg.get("smsDefault", True))
    rows = day_shifts(db, g, day, _members(db, g.id), lock=True)
    if not rows:
        raise ValueError("Nobody is scheduled for this group that day.")
    on_day = sorted({(r.employee_email or "").lower() for r in rows if r.employee_email})
    picked = {str(e).strip().lower() for e in (body.get("emails") or []) if str(e).strip()}
    unknown = sorted(picked - set(on_day))
    if unknown:
        raise ValueError(f"Not on this day's roster: {', '.join(unknown)}")
    if not picked and kind != "proceed":
        raise ValueError("Pick at least one person the call applies to.")
    if kind == "proceed" and not picked:
        picked = set(on_day)   # "the plan stands" is for everyone on the day
    actor = (user.get("email") or "").lower()
    now = _iso()
    # A later call on the same day supersedes the earlier one: every shift
    # the earlier call touched goes back to how it was first (quietly), and
    # the new call starts from there - so nothing stays cancelled or
    # delayed under a call nobody can reinstate any more.
    for old in (db.query(models.WeatherDecision)
                .filter(models.WeatherDecision.group_id == g.id, models.WeatherDecision.work_date == day,
                        models.WeatherDecision.status == "active").all()):
        old.status = "superseded"
        _restore_rows(db, old.id)
    d = models.WeatherDecision(id=str(uuid.uuid4()), group_id=g.id, work_date=day, company=cid, kind=kind,
                               new_start=new_start, new_end=new_end, move_to=move_to, reason=reason, sms=1 if sms else 0,
                               status="active", decided_by=actor, decided_at=now,
                               outlook_json=json.dumps({k: v for k, v in _outlook(db, g.id, day).items() if k != "hourly"}))
    db.add(d)
    prefs = _prefs(db, on_day)
    touched, ppl = [], []
    for em in on_day:
        e = people.get(em)
        mine = [r for r in rows if (r.employee_email or "").lower() == em]
        selected = em in picked
        outcomes = []
        if selected:
            for r in mine:
                before = (r.work_date, (r.start_hhmm or "")[:5], (r.end_hhmm or "")[:5], r.label or "")
                outcomes.append(_apply_to_shift(r, kind, new_start, new_end, move_to, d.id))
                if (r.work_date, r.start_hhmm[:5], r.end_hhmm[:5], r.label or "") != before or r.weather_status == "cancelled":
                    touched.append(r.id)
        changed = [o for o in outcomes if o != "kept"]
        outcome = "kept" if not selected else ("cancelled" if "cancelled" in outcomes else (changed[0] if changed
                                                else "kept" if outcomes else OUTCOME[kind]))
        ppl.append({"email": em, "name": _name(e) or em, "selected": selected, "outcome": outcome,
                    "shiftIds": [r.id for r in mine], "shifts": [_shift_dict(r) for r in mine],
                    "phone": bool(e is not None and (e.phone or "").strip()), "smsOn": prefs.get(em, True),
                    "ackAt": "", "ackVia": "", "remindedAt": "", "channels": {}})
    # Open slots follow the call (nobody to tell).
    for r in rows:
        if not r.employee_email and kind != "proceed" and picked:
            _apply_to_shift(r, kind, new_start, new_end, move_to, d.id)
    d.people_json = json.dumps(ppl)
    if touched:
        from routers.shift_requests import cancel_requests_for_shifts
        cancel_requests_for_shifts(db, touched, actor)
    # The call as the day's note - a person may edit it afterward.
    decider_name = _name(people.get(actor)) or actor
    note = (db.query(models.ScheduleDayNote)
            .filter(models.ScheduleDayNote.work_date == day, models.ScheduleDayNote.group_id == g.id).first())
    if not note:
        note = models.ScheduleDayNote(id=str(uuid.uuid4()), work_date=day, group_id=g.id)
        db.add(note)
    who = "everyone" if len(picked) == len(on_day) else f"{len(picked)} of {len(on_day)}"
    note.note = f"Weather call: {headline(kind, new_start, new_end, move_to)} for {who} - {decider_name}. {reason}"[:200]
    note.updated_by, note.updated_at = actor, now
    db.commit()
    queued = notify_decision(db, d, g, people, actor, cid, defer=defer)
    return {**decision_dict(db, d, people), "queued": queued}


# ── Telling the crew ──────────────────────────────────────────────────────

def _bell(db: Session, recipient: str, ref_id: str, title: str, body: str, *, action: dict, company: str, priority: int) -> None:
    weather_watch._bell(db, recipient, ref_id, title, body, action=action, company=company, priority=priority)


def sms_text(company_name: str, g, site_name: str, day: str, p: dict, d, url: str) -> str:
    first = p["shifts"][0] if p.get("shifts") else {}
    start = _t12(first.get("originalStart") or first.get("start") or "")
    where = f" at {site_name}" if site_name else ""
    head = f"{company_name or 'Nexus'}: {g.name} - {_day_label(day)}{where}."
    if p["outcome"] == "cancelled":
        line = f"Your shift ({start}) is CANCELLED for weather (unpaid)."
    elif p["outcome"] == "delayed":
        moved = first.get("date") and first.get("date") != day
        on = f" on {_day_label(first['date'])}" if moved else ""
        line = f"Your shift starts at {_t12(d.new_start)}{on} instead of {start} for weather."
    elif p["outcome"] == "shortened":
        line = f"Your shift ({start}) ends at {_t12(d.new_end)} for weather."
    elif p["outcome"] == "moved":
        line = f"Report to {d.move_to} instead ({start}) for weather."
    elif d.kind != "proceed":
        line = f"Your shift ({start}) is unchanged by this call and goes ahead as scheduled."
    else:
        line = f"Your shift ({start}) goes ahead as planned despite the forecast."
    reason = f" Reason: {d.reason}." if d.reason else ""
    return f"{head} {line}{reason} Acknowledge: {url}"


def _email(company_name: str, g, site_name: str, day: str, p: dict, d, url: str, decider_name: str) -> tuple:
    import email_theme
    theme = email_theme.current()
    band = theme.color("#0f3d2e")
    first = p["shifts"][0] if p.get("shifts") else {}
    start = _t12(first.get("originalStart") or first.get("start") or "")
    what = {"cancelled": f"Your {_day_label(day)} shift is cancelled", "delayed": f"Your {_day_label(day)} shift starts later",
            "shortened": f"Your {_day_label(day)} shift ends early", "moved": f"Your {_day_label(day)} shift moves",
            "kept": f"Your {_day_label(day)} shift goes ahead"}[p["outcome"]]
    detail = {"cancelled": f"The {start} shift at {site_name or 'the site'} is cancelled for weather. The day is unpaid.",
              "delayed": f"Start at {_t12(d.new_start)}{' on ' + _day_label(first['date']) if first.get('date') and first.get('date') != day else ''} instead of {start} at {site_name or 'the site'}.",
              "shortened": f"The {start} shift ends at {_t12(d.new_end)} instead.",
              "moved": f"Report to {d.move_to} instead of {site_name or 'the usual site'} at {start}.",
              "kept": (f"The forecast was reviewed and the {start} shift at {site_name or 'the site'} goes ahead as planned." if d.kind == "proceed"
                       else f"This call does not change your {start} shift at {site_name or 'the site'}; it goes ahead as scheduled.")}[p["outcome"]]
    html = f"""<div style="background:#f3f4f6;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-collapse:collapse">
    <tr><td style="background:{band};padding:16px 28px">{theme.logo_block()}</td></tr>
    <tr><td style="padding:24px 28px 0">
      <div style="font-size:20px;font-weight:600;color:#111827">{escape(what)}</div>
      <div style="font-size:14px;line-height:1.55;color:#374151;margin-top:8px">Hi {escape((p.get('name') or '').split(' ')[0])}, {escape(decider_name)} made the weather call for {escape(g.name)}. {escape(detail)}</div>
      <div style="font-size:14px;line-height:1.55;color:#374151;margin-top:8px"><b>Reason:</b> {escape(d.reason or '')}</div>
    </td></tr>
    <tr><td style="padding:24px 28px 8px">
      <a href="{escape(url)}" style="display:inline-block;padding:10px 22px;border-radius:4px;background:{band};color:#ffffff;text-decoration:none;font-weight:600;font-size:13px">Acknowledge</a>
      <a href="{escape(app_url())}/shifts/mine" style="display:inline-block;margin-left:12px;font-size:13px;color:#374151">Open My Shifts</a>
    </td></tr>
    <tr><td style="padding:0 28px 24px;font-size:12px;color:#6b7280">One tap tells your manager you saw this. Nothing else is needed.</td></tr>
    <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-size:11.5px;line-height:1.6;color:#6b7280">
      You get this email when a manager makes a weather call on a day you are scheduled in Nexus.{theme.footer_lines()}
    </td></tr>
  </table>
</div>"""
    return f"Weather call: {what.lower()}", html


def _send_sms(phone: str, text: str) -> tuple:
    import sentdm
    if not sentdm.configured():
        return False, "texting is not set up on this server"
    return sentdm.send_text(phone, text)


def _send_email(to: str, subject: str, html: str) -> str:
    import graph_mail
    if not graph_mail.graph_configured():
        return "email is not set up on this server"
    try:
        graph_mail.send_mail(from_email=graph_mail.DEFAULT_FROM_EMAIL, to=[to], cc=None, subject=subject, html=html)
        return "ok"
    except Exception as e:   # noqa: BLE001
        return f"failed: {str(e)[:160]}"


def _teams_dm(db: Session, actor: str, to: str, html: str) -> str:
    """An urgent one-to-one Teams message from the decider."""
    import bff_session
    import teams_post
    try:
        tok = bff_session.graph_token_for_email(db, actor)
    except Exception as e:   # noqa: BLE001
        return f"failed: {str(e)[:160]}"
    if not tok:
        return "the decider is not signed in to Nexus with Teams access"
    try:
        chat_id = teams_post.get_or_create_one_on_one_chat(tok, actor, to)
        teams_post.send_chat_message_urgent(tok, chat_id, html)
        return "ok"
    except Exception as e:   # noqa: BLE001
        return f"failed: {str(e)[:160]}"


def _teams_group(db: Session, g, actor: str, html: str) -> str:
    try:
        return weather_watch._post_teams(db, g, html, [actor])
    except Exception as e:   # noqa: BLE001
        return f"failed: {str(e)[:160]}"


def _company_name(db: Session, cid: str) -> str:
    ent = db.query(models.HrEntity).filter(models.HrEntity.id == cid).first() if cid else None
    return (ent.name or "") if ent else ""


def _bell_person(db: Session, d, g, p: dict, decider_name: str) -> str:
    """The priority bell for one affected person (in the request - it is a
    row, not a send). Returns the bell's title, which the Teams DM reuses."""
    title = f"Weather call: {headline(d.kind, d.new_start, d.new_end, d.move_to)}" if p["outcome"] != "kept" else "Weather call: your shift goes ahead"
    if p["outcome"] == "cancelled" and d.kind != "cancel":
        title = "Weather call: your shift is cancelled (unpaid)"
    body = f"{g.name}, {_day_label(d.work_date)}. {d.reason} Tap Acknowledge in My Shifts so {decider_name} knows you saw this."
    _bell(db, p["email"], f"weather-call:{d.id}", title, body, action=MY_SHIFTS, company=d.company, priority=1)
    return title


def _texts(d, p: dict) -> bool:
    return bool(d.sms and p.get("phone") and p.get("smsOn", True))


def _sms_skip(d, p: dict) -> str:
    return "no phone on file" if not p.get("phone") else ("turned off by the person" if not p.get("smsOn", True) else "off for this call")


def _phone(db: Session, email: str) -> str:
    emp = db.query(models.NexusEmployee).filter(func.lower(models.NexusEmployee.work_email) == email).first()
    return (emp.phone or "") if emp else ""


def notify_person(db: Session, d, g, p: dict, *, site_name: str, company_name: str, actor: str, decider_name: str,
                  reminder: bool = False) -> dict:
    """The SENDS for one affected person - text, and (not on a reminder)
    email and an urgent Teams message. The bell is _bell_person's, made in
    the request. Runs in a delivery job (_run). Returns the results."""
    url = ack_url(d.id, p["email"])
    text = sms_text(company_name, g, site_name, d.work_date, p, d, url)
    out = {}
    if _texts(d, p):
        ok, err = _send_sms(_phone(db, p["email"]), text)
        out["sms"] = "ok" if ok else (err or "failed")
    else:
        out["sms"] = _sms_skip(d, p)
    if not reminder:
        title = f"Weather call: {headline(d.kind, d.new_start, d.new_end, d.move_to)}" if p["outcome"] != "kept" else "Weather call: your shift goes ahead"
        if p["outcome"] == "cancelled" and d.kind != "cancel":
            title = "Weather call: your shift is cancelled (unpaid)"
        subject, html = _email(company_name, g, site_name, d.work_date, p, d, url, decider_name)
        out["email"] = _send_email(p["email"], subject, html)
        out["teams"] = _teams_dm(db, actor, p["email"], f"<p><b>{escape(title)}</b><br>{escape(text)}</p>")
    return out


def _merge_people(db: Session, decision_id: str, fn) -> list:
    """Change people_json under a row lock: load the FRESH roster, let `fn`
    mutate it, save, commit. Sending to a crew takes seconds per person
    (texts, email, Teams), and an acknowledgment that lands meanwhile must
    not be written over by a stale copy."""
    # populate_existing: the session may already hold this row; without it
    # the lock re-reads the row but keeps the stale attributes.
    d = (db.query(models.WeatherDecision).filter(models.WeatherDecision.id == decision_id)
         .populate_existing().with_for_update().first())
    ppl = json.loads(d.people_json or "[]")
    fn(ppl)
    d.people_json = json.dumps(ppl)
    db.commit()
    return ppl


# ── Delivery jobs (Oct 12): the sends leave the request ───────────────────
#
# Texts, email and Teams take seconds per person; a crew of thirty inside
# the request could run into the gateway timeout. The request now does the
# DB work (shifts, record, bells, day note) and answers with what was
# QUEUED; a job with its own session sends and records each result in the
# decision's roster (under _merge_people's lock, so acknowledgments that
# land meanwhile survive). The route passes FastAPI BackgroundTasks.add_task
# as `defer` - a plain-`def` task runs in the threadpool after the
# response, never on the event loop. The follow-up loop, already in a
# thread, runs its jobs inline (defer=None).

def _run(defer, fn, *args) -> None:
    if defer is None:
        fn(*args)
    else:
        defer(fn, *args)


def _job(fn, *args) -> None:
    db = SessionLocal()
    try:
        fn(db, *args)
    except Exception as e:   # noqa: BLE001 - a failed send must not take down the worker thread
        db.rollback()
        print(f"[weather-call] delivery failed: {e}")
    finally:
        db.close()


def _context(db: Session, d, actor: str) -> tuple:
    g = _group(db, d.group_id)
    people = weather_watch._people(db)
    site = db.query(models.HrWorkSite).filter(models.HrWorkSite.id == (getattr(g, "work_site_id", "") or "")).first()
    return g, people, (site.name if site else ""), _company_name(db, d.company), _name(people.get(actor)) or actor


def _deliver_decision(db: Session, decision_id: str, actor: str) -> None:
    d = db.query(models.WeatherDecision).filter(models.WeatherDecision.id == decision_id).first()
    if d is None:
        return
    g, people, site_name, company_name, decider_name = _context(db, d, actor)
    results = {}
    for p in json.loads(d.people_json or "[]"):
        if p["selected"]:
            results[p["email"]] = notify_person(db, d, g, p, site_name=site_name, company_name=company_name,
                                                actor=actor, decider_name=decider_name)
    n = len(results)
    summary = (f"<p><b>Weather call for {escape(g.name)} - {escape(_day_label(d.work_date))}:</b> "
               f"{escape(headline(d.kind, d.new_start, d.new_end, d.move_to))} for {n} {'person' if n == 1 else 'people'}. "
               f"{escape(d.reason)} - {escape(decider_name)}</p>")
    result = _teams_group(db, g, actor, summary)

    def apply(ppl):
        for p in ppl:
            p["channels"] = {**(p.get("channels") or {}), **results.get(p["email"], {}), "groupChat": result}
    _merge_people(db, d.id, apply)


def deliver_decision(decision_id: str, actor: str) -> None:
    _job(_deliver_decision, decision_id, actor)


def _queued(d, ppl: list) -> dict:
    sel = [p for p in ppl if p.get("selected")]
    return {"people": len(sel), "texts": sum(1 for p in sel if _texts(d, p)), "emails": len(sel), "teams": len(sel)}


def notify_decision(db: Session, d, g, people: dict, actor: str, cid: str, defer=None) -> dict:
    """The bells now (priority for the picked, quiet for the rest), the
    sends in a delivery job. Returns what was queued."""
    decider_name = _name(people.get(actor)) or actor
    ppl = json.loads(d.people_json or "[]")
    for p in ppl:
        if p["selected"]:
            _bell_person(db, d, g, p, decider_name)
        else:
            _bell(db, p["email"], f"weather-call:{d.id}", "Weather call: your shift stands",
                  f"{g.name}, {_day_label(d.work_date)}: a weather call was made for others on the day. Your shift goes ahead as scheduled.",
                  action=MY_SHIFTS, company=d.company, priority=0)

    def apply(rows):
        for p in rows:
            p["channels"] = {**(p.get("channels") or {}), "bell": "ok"}
    _merge_people(db, d.id, apply)
    db.refresh(d)
    _run(defer, deliver_decision, d.id, actor)
    db.refresh(d)
    return _queued(d, ppl)


# ── Acknowledging ─────────────────────────────────────────────────────────

def acknowledge(db: Session, decision_id: str, email: str, via: str) -> dict | None:
    """Mark one person's acknowledgment; closes their bell. Returns the
    person's entry, or None when they are not on the decision."""
    d = (db.query(models.WeatherDecision).filter(models.WeatherDecision.id == decision_id)
         .populate_existing().with_for_update().first())
    if not d:
        return None
    email = (email or "").lower()
    ppl = json.loads(d.people_json or "[]")
    hit = next((p for p in ppl if p["email"] == email), None)
    if not hit:
        return None
    if not hit.get("ackAt"):
        hit["ackAt"], hit["ackVia"] = _iso(), via
        d.people_json = json.dumps(ppl)
    for n in (db.query(models.NexusNotification)
              .filter(models.NexusNotification.recipient == email, models.NexusNotification.ref_id == f"weather-call:{d.id}").all()):
        n.actioned = True
    db.commit()
    return {**hit, "decision": {"id": d.id, "date": d.work_date, "kind": d.kind, "status": d.status}}


def ack_page(db: Session, token: str, *, do: bool = False) -> tuple:
    """(status, title, text, show_button) for the public acknowledgment link.
    GET (do=False) only SHOWS the call with an Acknowledge button; the
    button's POST (do=True) acknowledges. A link that acted on GET would be
    "acknowledged" by every mail scanner that prefetches it (Safe Links),
    seconds after the call and before the person saw a thing - the same
    rule as the task email buttons (task_mail_actions.py)."""
    info = verify_ack(token)
    if not info:
        return 400, "This link has expired", "Open Nexus > Shifts > My Shifts to see your schedule and acknowledge there.", False
    d = db.query(models.WeatherDecision).filter(models.WeatherDecision.id == info["decision_id"]).first()
    if not d:
        return 404, "Not found", "This weather call is no longer on record.", False
    if d.status == "superseded":
        # A later call on the same day replaced this one: its instruction is
        # stale, and the later call sent its own link (Oct 12).
        return 410, "This weather call was replaced", "A later weather call replaced this one. Open Nexus > Shifts > My Shifts to see your shift as it stands.", False
    if do:
        hit = acknowledge(db, d.id, info["email"], "link")
    else:
        hit = next((p for p in json.loads(d.people_json or "[]") if p["email"] == info["email"]), None)
    if not hit:
        return 404, "Not found", "This weather call is no longer on record.", False
    g = _group(db, d.group_id)
    first = (hit.get("shifts") or [{}])[0]
    start = _t12(first.get("originalStart") or first.get("start") or "")
    what = {"cancelled": f"your {start} shift is cancelled (unpaid)", "delayed": f"your shift starts at {_t12(d.new_start)}",
            "shortened": f"your shift ends at {_t12(d.new_end)}", "moved": f"report to {d.move_to}",
            "kept": f"your {start} shift goes ahead"}.get(hit.get("outcome"), "")
    if d.status == "reinstated":
        what = f"the call was reversed - your {start} shift is back on as scheduled"
    where = f"{g.name if g else 'Your group'}, {_day_label(d.work_date)}"
    name = (hit.get("name") or "").split(" ")[0]
    if do:
        return 200, f"Thanks{', ' + name if name else ''}", f"{where}: {what}. Your manager can see you acknowledged.", False
    return 200, f"Weather call: {where}", f"{what[0].upper() + what[1:]}. Tap Acknowledge so your manager knows you saw this.", True


# ── Follow-up: remind, escalate, reinstate ────────────────────────────────

def remind_silent(db: Session, d, actor: str = "", defer=None) -> int:
    """A second text (and a refreshed bell) to everyone still silent. The
    bells and the reminded stamp now; the texts in a delivery job."""
    g = _group(db, d.group_id)
    people = weather_watch._people(db)
    decider_name = _name(people.get(d.decided_by)) or d.decided_by
    silent = [p for p in json.loads(d.people_json or "[]") if p["selected"] and not p.get("ackAt")]
    if not silent:
        return 0
    for p in silent:
        _bell_person(db, d, g, p, decider_name)
    stamp = _iso()
    emails = [p["email"] for p in silent]

    def apply(ppl):
        for p in ppl:
            if p["email"] in emails:
                p["remindedAt"] = stamp
    _merge_people(db, d.id, apply)
    db.refresh(d)
    _run(defer, deliver_reminders, d.id, actor or d.decided_by, emails)
    db.refresh(d)
    return len(emails)


def _deliver_reminders(db: Session, decision_id: str, actor: str, emails: list) -> None:
    d = db.query(models.WeatherDecision).filter(models.WeatherDecision.id == decision_id).first()
    if d is None:
        return
    g, people, site_name, company_name, _ = _context(db, d, actor)
    decider_name = _name(people.get(d.decided_by)) or d.decided_by
    out = {}
    for p in json.loads(d.people_json or "[]"):
        if p["email"] in emails and not p.get("ackAt"):   # acknowledged since: no text
            out[p["email"]] = notify_person(db, d, g, p, site_name=site_name, company_name=company_name, actor=actor,
                                            decider_name=decider_name, reminder=True).get("sms", "")

    def apply(ppl):
        for p in ppl:
            if p["email"] in out:
                p.setdefault("channels", {})["reminder"] = out[p["email"]]
    _merge_people(db, d.id, apply)


def deliver_reminders(decision_id: str, actor: str, emails: list) -> None:
    _job(_deliver_reminders, decision_id, actor, emails)


def _escalate(db: Session, d) -> int:
    g = _group(db, d.group_id)
    ppl = json.loads(d.people_json or "[]")
    silent = [p for p in ppl if p["selected"] and not p.get("ackAt")]
    if not silent:
        return 0
    deciders, told = weather_watch.deciders_for(db, g, d.company)
    told = list(dict.fromkeys([d.decided_by] + told))
    names = ", ".join(p.get("name") or p["email"] for p in silent[:6]) + (" and more" if len(silent) > 6 else "")
    for em in told:
        _bell(db, em, f"weather-call-silent:{d.id}",
              f"{len(silent)} {'person has' if len(silent) == 1 else 'people have'} not acknowledged the weather call",
              f"{g.name}, {_day_label(d.work_date)}: {names}. Their phone numbers are on the Weather Call screen - a call may be needed.",
              action={"view": "shifts", "sub": f"schedule:{d.work_date}:{d.group_id}"}, company=d.company, priority=1)
    d.escalated_at = _iso()
    db.commit()
    return len(silent)


def follow_up_once(db: Session, now_utc: datetime = None) -> dict:
    """Every few minutes: remind the silent at 30 minutes, escalate at 60.
    Only calls made in the last day; a reinstated or superseded call is done."""
    now_utc = now_utc or _now()
    since = (now_utc - timedelta(hours=24)).isoformat()
    out = {"reminded": 0, "escalated": 0}
    for d in (db.query(models.WeatherDecision)
              .filter(models.WeatherDecision.status == "active", models.WeatherDecision.decided_at >= since).all()):
        try:
            decided = datetime.fromisoformat(d.decided_at)
        except ValueError:
            continue
        age = (now_utc - decided).total_seconds() / 60
        ppl = json.loads(d.people_json or "[]")
        silent = [p for p in ppl if p["selected"] and not p.get("ackAt")]
        if not silent:
            continue
        if age >= REMIND_AFTER_MIN and any(not p.get("remindedAt") for p in silent):
            out["reminded"] += remind_silent(db, d)
        if age >= ESCALATE_AFTER_MIN and not (d.escalated_at or ""):
            out["escalated"] += _escalate(db, d)
    return out


def _restore_rows(db: Session, decision_id: str) -> list:
    """Every shift a call touched, back to how it was before it: original
    times and label, no weather status. Used by Reinstate and when a later
    call supersedes an earlier one. The caller commits."""
    rows = (db.query(models.ScheduledShift).filter(models.ScheduledShift.weather_decision_id == decision_id)
            .with_for_update().all())
    for r in rows:
        if getattr(r, "original_start_hhmm", ""):
            r.start_hhmm, r.end_hhmm = r.original_start_hhmm, r.original_end_hhmm
            r.label = r.original_label or ""
        if getattr(r, "original_work_date", ""):
            r.work_date = r.original_work_date
        r.weather_status, r.weather_decision_id = "", ""
        r.original_start_hhmm = r.original_end_hhmm = r.original_label = r.original_work_date = ""
    return rows


def reinstate(db: Session, user: dict, d, defer=None) -> dict:
    """Undo the call: every touched shift back to its original times, label,
    day and status; the same people told on the same channels - the bells
    now, the texts, email and Teams line in a delivery job."""
    if d.status != "active":
        raise ValueError("This weather call is no longer active.")
    actor = (user.get("email") or "").lower()
    people = weather_watch._people(db)
    g = _group(db, d.group_id)
    _restore_rows(db, d.id)
    d.status, d.reinstated_by, d.reinstated_at = "reinstated", actor, _iso()
    note = (db.query(models.ScheduleDayNote)
            .filter(models.ScheduleDayNote.work_date == d.work_date, models.ScheduleDayNote.group_id == d.group_id).first())
    decider_name = _name(people.get(actor)) or actor
    if note is not None:
        note.note = f"Weather call reversed by {decider_name}: shifts are back on as scheduled."[:200]
        note.updated_by, note.updated_at = actor, _iso()
    told = []
    for p in json.loads(d.people_json or "[]"):
        if not p["selected"]:
            continue
        first = (p.get("shifts") or [{}])[0]
        start = _t12(first.get("originalStart") or first.get("start") or "")
        _bell(db, p["email"], f"weather-call:{d.id}", "Weather call reversed: your shift is back on",
              f"{g.name}, {_day_label(d.work_date)}: your {start} shift goes ahead as scheduled after all.", action=MY_SHIFTS,
              company=d.company, priority=1)
        told.append(p)
    db.commit()
    emails = [p["email"] for p in told]

    def apply(ppl):
        for p in ppl:
            if p["email"] in emails:   # the reversal wants its own acknowledgment
                p["ackAt"], p["ackVia"], p["reinstateChannels"] = "", "", {"bell": "ok"}
    _merge_people(db, d.id, apply)
    db.refresh(d)
    _run(defer, deliver_reinstatement, d.id, actor)
    db.refresh(d)
    return {**decision_dict(db, d, people), "queued": {"people": len(told), "texts": sum(1 for p in told if _texts(d, p)),
                                                       "emails": len(told), "teams": 1}}


def _deliver_reinstatement(db: Session, decision_id: str, actor: str) -> None:
    d = db.query(models.WeatherDecision).filter(models.WeatherDecision.id == decision_id).first()
    if d is None:
        return
    g, people, site_name, company_name, decider_name = _context(db, d, actor)
    out = {}
    for p in json.loads(d.people_json or "[]"):
        if not p["selected"]:
            continue
        first = (p.get("shifts") or [{}])[0]
        start = _t12(first.get("originalStart") or first.get("start") or "")
        url = ack_url(d.id, p["email"])
        text = (f"{company_name or 'Nexus'}: {g.name} - {_day_label(d.work_date)}: the weather call is REVERSED. "
                f"Your shift ({start}) is back on as scheduled. Acknowledge: {url}")
        res = {}
        if _texts(d, p):
            ok, err = _send_sms(_phone(db, p["email"]), text)
            res["sms"] = "ok" if ok else (err or "failed")
        res["email"] = _send_email(p["email"], "Weather call reversed: your shift is back on",
                                   f"<p>{escape(text)}</p><p><a href=\"{escape(url)}\">Acknowledge</a></p>")
        out[p["email"]] = res

    def apply(ppl):
        for p in ppl:
            if p["email"] in out:
                p["reinstateChannels"] = {**(p.get("reinstateChannels") or {}), **out[p["email"]]}
    _merge_people(db, d.id, apply)
    _teams_group(db, g, actor, f"<p><b>Weather call reversed for {escape(g.name)} - {escape(_day_label(d.work_date))}:</b> "
                               f"shifts are back on as scheduled. - {escape(decider_name)}</p>")


def deliver_reinstatement(decision_id: str, actor: str) -> None:
    _job(_deliver_reinstatement, decision_id, actor)


def _tick() -> dict:
    db = SessionLocal()
    try:
        return follow_up_once(db)
    except Exception as e:   # noqa: BLE001
        db.rollback()
        print(f"[weather-call] follow-up failed: {e}")
        return {}
    finally:
        db.close()


async def weather_call_loop():
    """Leader-gated (main.py). The tick is synchronous DB and HTTP work, so
    it runs in a thread."""
    await asyncio.sleep(120)
    while True:
        s = await asyncio.to_thread(_tick)
        if s and (s.get("reminded") or s.get("escalated")):
            print(f"[weather-call] {s}")
        await asyncio.sleep(FOLLOW_UP_SCAN_SEC)
