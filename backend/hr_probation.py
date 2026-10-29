"""Probation tracking (Neil, Oct 27 2026).

Before this, probation was only the checklist step "ON-33 Probation
Confirmation Letter". Now each person can carry a probation record
(nexus_employees.probation, JSON):

    status        '' (Not Tracked) | in_probation | extended | confirmed | ended
                  | passed (Passed Probation) | removed (Removed From
                  Probation); OPEN = in_probation / extended. 'past' (Past
                  Probation) is DERIVED, never stored - see below
    startDate     the day it counts from (their start date)
    endDate       start + months (calendar months, a day past the end of a
                  shorter month lands on its last day); HR may set it by hand
    months        a per-person override; None = the company's length
    endManual     HR typed the end date (a start date change leaves it alone)
    pending       a manager's recommendation waiting for HR
    decision      the last decision (who, when, why, the end before it)
    letter        the confirmation / extension letter: its life event, or the
                  reason it could not go
    remindedFor   the end date the reminder went out for (it fires once per
                  end date - an extension gets a reminder of its own)
    history       [{at, by, action, from, to, endDate, reason}], newest last

Who does what:
  - HR++ (the company's HR contact, an administrator / owner, or a Full HR
    grant - the same people timesheet_review.is_hr names; never on their own
    record) starts tracking, edits the length or end date, and FINALIZES
    every decision.
  - The manager (Reports To, or their Backup Manager) records Confirm /
    Extend / End as a RECOMMENDATION that HR approves or declines - the same
    shape as the manager-asks / HR-decides role change requests
    (role_change.py), so a manager can never end someone's employment or
    send a letter on their own.

What a finalized decision does:
  - Confirm: status Confirmed; the onboarding checklist's ON-33 ticks itself
    (signal probation_confirmed, hr_checklists.SIGNALS); the confirmation
    letter goes out.
  - Extend: a new end date (after the current one) and a reason; status
    Extended; the reminder fires again before the new date; the extension
    letter goes out.
  - End Employment: status Ended. It never offboards anyone by itself - the
    profile opens the EXISTING Offboard flow (hr_life_events separation),
    prefilled with Termination and the reason. Nothing is duplicated.

The letters are Documents templates (seeded once: Probation Confirmation
Letter / Probation Extension Letter, editable in Documents, picked per
company in Settings > Hiring & Onboarding > Probation), rendered at their
PUBLISHED version on the company letterhead with the company signatory
printed (never signed - the company never signs before the employee, Neil
Oct 22 2026), and sent through Nexus Sign with the EMPLOYEE as the only
signer. Each letter is an HrLifeEvent of kind 'probation', so the existing
life-event engine does the rest: the signed copy lands on the profile's
Documents tab and the filing pass files it in the person's Egnyte folder
(Probation Documents). A letter that cannot be generated never undoes the
decision: the card says why, and HR can Send Letter again.

Who is tracked: only new employees, by their start date (Neil, Oct 27
2026). New hires get a record automatically - a hired candidate (Mark Hired
or a signed hiring packet, create_employee_from_candidate) and anyone added
in People with a start date - unless that start date already puts the end in
the past. Added without a start date, the record waits and starts when the
start date is filled in. Existing employees are picked up ONCE by
backfill_existing (main._startup_seeds, a nexus_settings mark like the other
seeds): every active / onboarding employee (never a contractor, an external
or a guest - applies()) with no probation record whose start date + their
length (the person's own months, else the company's, default 3) has not
passed yet starts In Probation with that end date. Anyone already past the
window, or with no start date, stays Not Tracked until HR starts it. The
backfill sends nothing itself: someone already inside the reminder window
gets the ONE normal reminder on the next daily pass (remindedFor guards it
per end date), so the release fires no burst of duplicate or stale bells.

The reminder runs in reminders_loop (already in a thread): once per end
date, `reminderDays` before it (company setting, 0 = off), one bell per
recipient - the manager and the company HR contact (no HR contact: the
Global Admins) - updated in place, and one email each.

Past the window (Neil, Oct 29 2026: "The people that have been here for 3
months or longer are not on probation, they clearly made the cut. Go ahead
and make it effectively clear so the probation tracking isn't a thing for
those. Should be an option also to remove from probation."):
  - Passed, automatically. The daily pass (run_daily, while the Probation
    switch in Workflows > Automations is on - off stops the pass and the
    reminders alike) moves
    every OPEN record of an active / onboarding person whose end date is
    before today (the company clock, _today) and that has NO pending
    manager recommendation to `passed`: logged {action: passed, by:
    system}, the reminder state cleared, the bells closed, ON-33 ticked like
    a confirm (probation_confirmed counts passed), the probation.decided
    event emitted (decision passed, automatic) - and NO letter. HR can send
    the confirmation letter by hand (Send Letter on a passed record). A
    record with a pending recommendation past its end stays open for HR: a
    real decision is in flight. pass_past_window_once (main._startup_seeds,
    nexus_settings mark PAST_MARK) ran the same move once at release.
  - Never tracked and past the window = Past Probation. Someone with no
    record whom applies() covers and whose start date + their length (the
    person's months, else the company's) is before today reads the DERIVED
    status 'past' ("Past Probation", pastSince = that end date) in summary
    and ser: no Start Tracking prompt, no reminder, never "Not Tracked".
    No start date stays Not Tracked (we cannot know). HR keeps Start A New
    Probation (begin, from a day HR picks) for a real case like a new role.
  - Remove From Probation (remove; the old stop_tracking route is its
    alias): HR++ only, on an OPEN record, with a reason. Status `removed`,
    logged, bells closed, no letter, and nothing restarts it by itself - not
    the backfill, not a start date change, not a hire (start_for_new_hire /
    on_profile_change skip it). A manager cannot remove; they recommend.
"""
import calendar
import copy
import json
import uuid
from datetime import date, datetime, timezone
from html import escape
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

import scoped_settings
import workflows
from models import HrEntity, HrLifeEvent, NexusEmployee, NexusNotification
import job_switch

SETTING_KEY = "hr_probation"
CONFIRM_TEMPLATE_ID = "probation-confirmation-letter"
EXTEND_TEMPLATE_ID = "probation-extension-letter"
DEFAULTS = {"months": 3, "reminderDays": 14, "confirmTemplateId": CONFIRM_TEMPLATE_ID,
            "extendTemplateId": EXTEND_TEMPLATE_ID, "letterheadId": ""}
LIMITS = {"months": (1, 24), "reminderDays": (0, 90)}

OPEN = ("in_probation", "extended")
STATUSES = OPEN + ("confirmed", "ended", "passed", "removed")
PAST = "past"                                               # derived (never stored): untracked, past the window
LABELS = {"": "Not Tracked", "in_probation": "In Probation", "extended": "Extended",
          "confirmed": "Confirmed", "ended": "Ended", "passed": "Passed Probation",
          "removed": "Removed From Probation", PAST: "Past Probation"}
LIVE = ("active", "onboarding")                             # still here: the passes and the reminder look at these
AUTO_PASS_REASON = "Reached the end of probation with no decision - passed automatically."
PAST_MARK = "hr_probation.past_window_v1"
DECISIONS = ("confirm", "extend", "end")
DECISION_LABELS = {"confirm": "Confirm", "extend": "Extend", "end": "End Employment"}
DECIDED = {"confirm": "confirmed", "extend": "extended", "end": "ended"}
LETTER_TITLES = {"confirm": "Probation Confirmation Letter", "extend": "Probation Extension Letter"}
EMPLOYEE_TYPES = ("full_time", "part_time", "intern")      # contractors are engaged, not on probation
BUSINESS_TZ = "America/Los_Angeles"
NOTICE_PREFIX = "probation:"                                # NexusNotification.ref_id = probation:<employee id>
SEED_MARK = "hr_probation.templates_seeded"
SIGNAL_MARK = "hr_probation.on33_signal"
BACKFILL_MARK = "hr_probation.backfill_existing"
SIGNAL = "probation_confirmed"


class ProbationError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# ── small helpers ────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today() -> date:
    """Today where the company works (the same clock hr_life_events uses)."""
    return datetime.now(ZoneInfo(BUSINESS_TZ)).date()


def _parse(iso: str):
    try:
        return datetime.strptime((iso or "")[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def us_date(iso: str) -> str:
    d = _parse(iso)
    return d.strftime("%m/%d/%Y") if d else (iso or "")


def long_date(iso: str) -> str:
    """'2026-10-09' -> 'October 9, 2026' - the form a letter prints."""
    d = _parse(iso)
    return f"{d.strftime('%B')} {d.day}, {d.year}" if d else (iso or "")


def add_months(d: date, months: int) -> date:
    """Calendar months; a day the target month does not have becomes its
    last day (Jan 31 + 1 month = Feb 28, or 29 in a leap year)."""
    m = d.month - 1 + int(months)
    y, m = d.year + m // 12, m % 12 + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def end_for(start_iso: str, months: int) -> str:
    d = _parse(start_iso)
    return add_months(d, months).isoformat() if d else ""


def full_name(emp: NexusEmployee) -> str:
    return (emp.display_name or f"{emp.first_name} {emp.last_name}").strip()


def person_name(db: Session, email: str) -> str:
    from hr_life_events import person_name as pn
    return pn(db, email) if email else ""


def record(emp: NexusEmployee) -> dict:
    return copy.deepcopy(emp.probation) if isinstance(emp.probation, dict) else {}


def _save(emp: NexusEmployee, rec: dict) -> None:
    emp.probation = rec
    flag_modified(emp, "probation")
    emp.updated_at = _now()


def _log(rec: dict, by: str, action: str, *, frm: str = None, to: str = None, end: str = "",
         reason: str = "", note: str = "") -> None:
    rec.setdefault("history", []).append({
        "at": _now(), "by": (by or "").lower(), "action": action,
        "from": rec.get("status", "") if frm is None else frm,
        "to": rec.get("status", "") if to is None else to,
        "endDate": end or rec.get("endDate", ""), "reason": (reason or "")[:1000], "note": note[:300]})


def applies(emp: NexusEmployee) -> bool:
    """Employees only - an independent contractor is engaged, not on
    probation, and an external / guest is not ours to track."""
    return ((emp.employment_type or "full_time") in EMPLOYEE_TYPES
            and (emp.identity_type or "internal") == "internal")


# ── settings (defaults <- tenant row <- company override) ────────────────────

def _clamp(cfg: dict) -> dict:
    out = dict(DEFAULTS)
    for k, (lo, hi) in LIMITS.items():
        try:
            out[k] = max(lo, min(hi, int(cfg.get(k, DEFAULTS[k]))))
        except (TypeError, ValueError):
            out[k] = DEFAULTS[k]
    for k in ("confirmTemplateId", "extendTemplateId", "letterheadId"):
        out[k] = str(cfg.get(k) if cfg.get(k) is not None else DEFAULTS[k]).strip()[:80]
    return out


def settings(db: Session, company_id: str = "") -> dict:
    return _clamp(scoped_settings.get(db, SETTING_KEY, DEFAULTS, company_id or ""))


def has_override(db: Session, company_id: str) -> bool:
    return scoped_settings.has_override(db, SETTING_KEY, company_id)


def save_settings(db: Session, company_id: str, cfg: dict, actor: str, reset: bool = False) -> dict:
    """Validate and store the tenant row ('' company) or a company's override.
    Commits; returns the effective setting."""
    company_id = (company_id or "").strip()
    if reset:
        scoped_settings.reset(db, SETTING_KEY, company_id)
        db.commit()
        return settings(db, company_id)
    clean = {}
    for k, (lo, hi) in LIMITS.items():
        if k in (cfg or {}):
            try:
                v = int(cfg[k])
            except (TypeError, ValueError):
                raise ProbationError(f"{'Length' if k == 'months' else 'Reminder days'} must be a whole number.")
            if not lo <= v <= hi:
                raise ProbationError(f"{'The length' if k == 'months' else 'The reminder'} must be {lo} to {hi}"
                                     f"{' months' if k == 'months' else ' days'}.")
            clean[k] = v
    from models import DocLetterhead, DocTemplate
    for k in ("confirmTemplateId", "extendTemplateId"):
        if k in (cfg or {}):
            tid = str(cfg[k] or "").strip()
            if tid and not db.query(DocTemplate.id).filter(DocTemplate.id == tid).first():
                raise ProbationError("That letter template is not in Documents any more - pick another.")
            clean[k] = tid
    if "letterheadId" in (cfg or {}):
        lid = str(cfg["letterheadId"] or "").strip()
        if lid and not db.query(DocLetterhead.id).filter(DocLetterhead.id == lid).first():
            raise ProbationError("That letterhead is not in Documents any more - pick another.")
        clean["letterheadId"] = lid
    base = scoped_settings.saved(db, SETTING_KEY, company_id, DEFAULTS)
    base.update(clean)
    scoped_settings.save(db, SETTING_KEY, company_id, base, actor)
    db.commit()
    return settings(db, company_id)


# ── who may do what ──────────────────────────────────────────────────────────

def _entity(db: Session, emp: NexusEmployee):
    return db.query(HrEntity).filter(HrEntity.id == emp.company).first() if emp.company else None


def hr_contact(db: Session, emp: NexusEmployee) -> str:
    e = _entity(db, emp)
    return ((e.hr_contact_email if e else "") or "").strip().lower()


def _in_hr_scope(db: Session, user: dict, emp: NexusEmployee) -> bool:
    from auth import hr_scope
    from routers.hr import _in_scope
    scope = hr_scope(user, db)
    return scope is None or _in_scope(emp, scope)


def is_hr_plus(db: Session, user: dict, emp: NexusEmployee) -> bool:
    """HR, the one who finalizes (timesheet_review.is_hr's people): the
    company's HR contact, an administrator / owner, or a Full HR grant - in
    their People scope. Never on their own record."""
    from auth import _LEVELS, _MODULE_LEVEL_RANK, _module_level, hr_team_limited
    me = (user.get("email") or "").strip().lower()
    if not me or me == (emp.work_email or "").strip().lower():
        return False
    if me == hr_contact(db, emp):
        return True
    if not _in_hr_scope(db, user, emp):
        return False
    if int(user.get("level", 0)) >= _LEVELS["administrator"]:
        return True
    return not hr_team_limited(user) and _module_level(me, "hr", db) >= _MODULE_LEVEL_RANK["full"]


def is_manager_of(db: Session, me: str, emp: NexusEmployee) -> bool:
    """Reports To, or the Backup Manager (backup_manager.py: same rights)."""
    me = (me or "").strip().lower()
    work = (emp.work_email or "").strip().lower()
    if not me or me == work:
        return False
    if me == (emp.manager_email or "").strip().lower():
        return True
    if work:
        import backup_manager
        return backup_manager.backup_of(db, work)[0] == me
    return False


def actor_role(db: Session, user: dict, emp: NexusEmployee) -> str:
    """'hr' (finalizes), 'manager' (recommends) or '' (neither)."""
    if is_hr_plus(db, user, emp):
        return "hr"
    if is_manager_of(db, user.get("email", ""), emp):
        return "manager"
    return ""


def can_read(db: Session, user: dict, emp: NexusEmployee) -> bool:
    """HR, the manager, or a People reader in scope - never on their own
    record (a person does not read their own probation notes through People)."""
    if actor_role(db, user, emp):
        return True
    me = (user.get("email") or "").strip().lower()
    if not me or me == (emp.work_email or "").strip().lower():
        return False
    from auth import _LEVELS, _MODULE_LEVEL_RANK, _module_level
    has_people = (int(user.get("level", 0)) >= _LEVELS["administrator"]
                  or _module_level(user.get("email", ""), "hr", db) >= _MODULE_LEVEL_RANK["viewer"])
    return has_people and _in_hr_scope(db, user, emp)


def _require_hr(db: Session, user: dict, emp: NexusEmployee) -> None:
    if not is_hr_plus(db, user, emp):
        raise ProbationError("Only HR finalizes probation - the company's HR contact, an administrator or a "
                             "Full People grant.", 403)


# ── summary (the People list) and the full record (the profile card) ─────────

def _company_months(emp: NexusEmployee) -> int:
    """The company's length, read through the row's own session (the People
    serializer has no db at hand); a detached row reads the default."""
    from sqlalchemy.orm import object_session
    db = object_session(emp)
    if db is None:
        return DEFAULTS["months"]
    try:
        return settings(db, emp.company or "")["months"]
    except Exception:   # noqa: BLE001 - a summary never fails a listing
        return DEFAULTS["months"]


def past_since(emp: NexusEmployee, rec: dict, company_months: int, today: date) -> str:
    """The derived Past Probation (Neil, Oct 29 2026): never tracked (no
    status), applies(), and start date + their length (the person's own
    months, else the company's) before today -> that end date, else ''. No
    start date: '' (we cannot know)."""
    if rec.get("status") or not applies(emp):
        return ""
    start = _parse(emp.start_date or "")
    if not start:
        return ""
    end = add_months(start, int(rec.get("months") or company_months or DEFAULTS["months"]))
    return end.isoformat() if end < today else ""


def summary(emp: NexusEmployee, reminder_days: int = None, today: date = None, months: int = None) -> dict:
    """What the People list needs: status, end date, days left and whether it
    is ending (inside the reminder window, or past the end undecided).
    `months` = the company's length (None: read it), for the derived Past
    Probation of someone never tracked."""
    rec = record(emp)
    today = today or _today()
    st = rec.get("status", "") if rec.get("status", "") in STATUSES else ""
    end = rec.get("endDate", "")
    days = None
    # Someone who has Left or is Inactive is never "ending" (no reminder either).
    if st in OPEN and _parse(end) and (emp.status or "active") in LIVE:
        days = (_parse(end) - today).days
    window = DEFAULTS["reminderDays"] if reminder_days is None else reminder_days
    past = "" if st else past_since(emp, rec, _company_months(emp) if months is None else months, today)
    shown = PAST if past else st
    return {"status": shown, "label": LABELS[shown], "endDate": end if st else "", "pastSince": past,
            "daysLeft": days, "ending": days is not None and days <= max(window, 0),
            "pending": (rec.get("pending") or {}).get("decision", "") if st in OPEN else ""}


def summaries(db: Session, emps: list) -> dict:
    """{employee id: summary} with each company's own reminder window and length."""
    cache, out, today = {}, {}, _today()
    for e in emps:
        c = e.company or ""
        if c not in cache:
            cache[c] = settings(db, c)
        out[e.id] = summary(e, cache[c]["reminderDays"], today, cache[c]["months"])
    return out


def _letter_out(db: Session, rec: dict) -> dict:
    let = rec.get("letter") or {}
    if not let:
        return {}
    out = {"outcome": let.get("outcome", ""), "title": LETTER_TITLES.get(let.get("outcome", ""), "Letter"),
           "error": let.get("error", ""), "at": let.get("at", ""), "eventId": let.get("eventId", ""),
           "status": "failed" if let.get("error") else "", "filingStatus": ""}
    if let.get("eventId"):
        ev = db.query(HrLifeEvent).filter(HrLifeEvent.id == let["eventId"]).first()
        if ev is not None:
            out["status"], out["filingStatus"] = ev.status, ev.filing_status or ""
    return out


def _letter_sendable(db: Session, rec: dict, st: str) -> bool:
    """A letter can go (again): Confirmed / Extended whose letter failed or
    was declined / voided / expired, or Passed Probation with no letter out."""
    if st not in ("confirmed", "extended", "passed"):
        return False
    let = _letter_out(db, rec)
    bad = let.get("status", "") in ("failed", "declined", "voided", "expired")
    return bad or (st == "passed" and not let)


def ser(db: Session, emp: NexusEmployee, user: dict) -> dict:
    rec = record(emp)
    cfg = settings(db, emp.company or "")
    role = actor_role(db, user, emp)
    st = rec.get("status", "") if rec.get("status", "") in STATUSES else ""
    s = summary(emp, cfg["reminderDays"], months=cfg["months"])
    names = {"system": "Nexus"}

    def name(em):
        if em and em not in names:
            names[em] = person_name(db, em)
        return names.get(em, "")

    pending = rec.get("pending") if st in OPEN else None
    if pending:
        pending = {**pending, "byName": name(pending.get("by", "")),
                   "label": DECISION_LABELS.get(pending.get("decision", ""), "")}
    history = [{**h, "byName": name(h.get("by", ""))} for h in reversed(rec.get("history") or [])]
    open_ = st in OPEN
    return {
        "employeeId": emp.id, "applies": applies(emp), "status": s["status"], "label": s["label"],
        "pastSince": s["pastSince"],
        "startDate": rec.get("startDate", "") if st else "", "endDate": rec.get("endDate", "") if st else "",
        "months": rec.get("months") or cfg["months"], "monthsOverride": rec.get("months"),
        "companyMonths": cfg["months"], "endManual": bool(rec.get("endManual")),
        "reminderDays": cfg["reminderDays"], "daysLeft": s["daysLeft"], "ending": s["ending"],
        "awaitingStart": bool(rec.get("awaitingStart")) and not st,
        "pending": pending, "letter": _letter_out(db, rec),
        "decision": ({**rec["decision"], "byName": name(rec["decision"].get("by", ""))} if rec.get("decision") else None),
        "history": history[:50],
        "role": role,
        "canDecide": open_ and role in ("hr", "manager") and not (role == "manager" and pending),
        "canFinalize": role == "hr",
        "canManage": role == "hr",
        "canRemove": open_ and role == "hr",
        # Send Letter: a confirmation / extension whose letter did not land,
        # or a passed record (no letter goes by itself) whose letter is not out.
        "canSendLetter": role == "hr" and _letter_sendable(db, rec, st),
        "employeeActive": emp.status in ("active", "onboarding"),
        "hasWorkEmail": bool((emp.work_email or "").strip()),
    }


# ── starting, editing, stopping ──────────────────────────────────────────────

def _months_for(db: Session, emp: NexusEmployee, rec: dict) -> int:
    return int(rec.get("months") or settings(db, emp.company or "")["months"])


def start_tracking(db: Session, emp: NexusEmployee, by: str, *, reason: str = "", months=None,
                   action: str = "started", start: str = "") -> dict:
    """Begin (or restart) probation from the start date (or `start`, the day
    HR picked for a new probation). Caller commits."""
    if not applies(emp):
        raise ProbationError("Probation is tracked for employees only - not contractors or external people.", 409)
    picked = (start or "")[:10]
    start = (picked or emp.start_date or "")[:10]
    if not _parse(start):
        raise ProbationError(f"Add {emp.first_name}'s start date first - probation counts from it.", 409)
    rec = record(emp)
    if months is not None:
        months = _check_months(months)
        rec["months"] = months
    prev = rec.get("status", "")
    end = end_for(start, _months_for(db, emp, rec))
    # startManual: counted from a day HR picked - a start date edit leaves it alone.
    rec.update({"status": "in_probation", "startDate": start, "endDate": end, "endManual": False,
                "startManual": bool(picked) and picked != (emp.start_date or "")[:10],
                "remindedFor": "", "pending": None, "decision": None, "letter": None, "awaitingStart": False})
    _log(rec, by, action, frm=prev, to="in_probation", end=end, reason=reason)
    _save(emp, rec)
    workflows.emit(db, "probation.started", subject=emp, actor=by,
                   changes={"probation.status": (prev, "in_probation")},
                   extra={"endDate": end, "reason": reason, "how": action})
    return rec


def _check_months(months) -> int:
    lo, hi = LIMITS["months"]
    try:
        m = int(months)
    except (TypeError, ValueError):
        raise ProbationError("The length must be a whole number of months.")
    if not lo <= m <= hi:
        raise ProbationError(f"The length must be {lo} to {hi} months.")
    return m


def start_for_new_hire(db: Session, emp: NexusEmployee, by: str, how: str) -> bool:
    """A new hire gets probation by itself (existing people are picked up
    once by backfill_existing - see the module docstring). No start date
    yet: it waits for one. A start date
    that already puts the end in the past (an existing person added late)
    starts nothing. Caller commits; never raises."""
    try:
        if not applies(emp):
            return False
        rec = record(emp)
        if rec.get("status") in OPEN or rec.get("status") == "removed":
            return False                  # HR removed them: nothing restarts it by itself
        if not _parse(emp.start_date or ""):
            rec["awaitingStart"] = True
            _save(emp, rec)
            return False
        if end_for(emp.start_date, _months_for(db, emp, rec)) < _today().isoformat():
            return False
        start_tracking(db, emp, by, reason=how, action="started")
        return True
    except Exception as e:   # noqa: BLE001 - probation never blocks a hire
        print(f"[probation] not started for {getattr(emp, 'id', '?')}: {type(e).__name__}: {e}")
        return False


def on_profile_change(db: Session, emp: NexusEmployee, by: str, old_start: str) -> None:
    """After a People edit: a record waiting for a start date starts; an open,
    undecided record whose end was computed follows a moved start date.
    Caller commits; never raises."""
    try:
        rec = record(emp)
        if rec.get("status") == "removed":
            return                        # Removed From Probation: a start date change never restarts it
        start = (emp.start_date or "")[:10]
        if rec.get("awaitingStart") and not rec.get("status") and _parse(start):
            rec["awaitingStart"] = False
            _save(emp, rec)
            start_for_new_hire(db, emp, by, "Start date added")
            return
        if (rec.get("status") == "in_probation" and not rec.get("endManual") and not rec.get("startManual")
                and _parse(start)
                and start != (old_start or "")[:10] and start != rec.get("startDate")):
            end = end_for(start, _months_for(db, emp, rec))
            rec["startDate"] = start
            if end != rec.get("endDate"):
                rec["endDate"], rec["remindedFor"] = end, ""
            _log(rec, by, "edited", end=end, note="Start date changed")
            _save(emp, rec)
    except Exception as e:   # noqa: BLE001 - never fails a profile save
        print(f"[probation] profile change not applied for {getattr(emp, 'id', '?')}: {type(e).__name__}: {e}")


def edit(db: Session, user: dict, emp: NexusEmployee, *, months=None, end_date: str = None,
         clear_months: bool = False, reason: str = "") -> dict:
    """HR++: the person's length (None keeps it, clear_months = the company's)
    or an end date typed by hand. Only while probation is open. Commits."""
    _require_hr(db, user, emp)
    rec = record(emp)
    if rec.get("status") not in OPEN:
        raise ProbationError("Probation is not open - start tracking first.", 409)
    if rec.get("status") == "extended" and (months is not None or clear_months):
        raise ProbationError("The probation was extended to a set date - change the end date instead.", 409)
    before = rec.get("endDate", "")
    if clear_months or months is not None:
        rec["months"] = None if clear_months else _check_months(months)
        rec["endDate"] = end_for(rec.get("startDate") or emp.start_date, _months_for(db, emp, rec))
        rec["endManual"] = False
    if end_date is not None:
        d = _parse(end_date)
        if not d:
            raise ProbationError("Enter the end date.")
        if _parse(rec.get("startDate", "")) and d <= _parse(rec["startDate"]):
            raise ProbationError("The end date must be after the start date.")
        rec["endDate"], rec["endManual"] = d.isoformat(), True
    if rec.get("endDate") != before:
        rec["remindedFor"] = ""
        _close_bells(db, emp)
    _log(rec, user["email"], "edited", reason=reason)
    _save(emp, rec)
    db.commit()
    return rec


def remove(db: Session, user: dict, emp: NexusEmployee, reason: str) -> dict:
    """HR++'s Remove From Probation (Neil, Oct 29 2026: "Should be an option
    also to remove from probation"): an OPEN probation ends with no decision
    and no letter - status removed. Nothing restarts it by itself (not the
    backfill, a start date change or a hire); HR can Start A New Probation
    later. A manager cannot remove - they recommend. The history stays.
    Commits."""
    _require_hr(db, user, emp)
    reason = (reason or "").strip()[:1000]
    if not reason:
        raise ProbationError("Add the reason - it is kept in the probation history.")
    rec = record(emp)
    if rec.get("status") not in OPEN:
        raise ProbationError("They are not on probation - there is nothing to remove.", 409)
    me = user["email"].lower()
    prev, pending = rec["status"], rec.get("pending") or {}
    rec.update({"status": "removed", "pending": None, "remindedFor": "", "awaitingStart": False,
                "decision": {"decision": "removed", "by": me, "at": _now(), "reason": reason,
                             "previousEndDate": rec.get("endDate", ""), "newEndDate": "", "recommendedBy": ""}})
    _log(rec, me, "removed", frm=prev, to="removed", reason=reason)
    _save(emp, rec)
    workflows.emit(db, "probation.decided", subject=emp, actor=me,
                   changes={"probation.status": (prev, "removed")},
                   extra={"decision": "removed", "reason": reason})
    _close_bells(db, emp)
    # A manager's recommendation was waiting: they hear it is moot.
    rec_by = (pending.get("by") or "").lower()
    if rec_by and rec_by not in (me, (emp.work_email or "").lower()):
        _bell(db, rec_by, f"Removed From Probation - {full_name(emp)}",
              f"HR removed {full_name(emp)} from probation, so your recommendation is closed: {reason}", emp)
    db.commit()
    return rec


def stop_tracking(db: Session, user: dict, emp: NexusEmployee, reason: str) -> dict:
    """The old Stop Tracking (a record started by mistake) - now an alias of
    Remove From Probation: status removed, never back to Not Tracked (that
    would let the backfill or a start date change start it again)."""
    return remove(db, user, emp, reason)


def begin(db: Session, user: dict, emp: NexusEmployee, *, months=None, reason: str = "",
          start: str = "") -> dict:
    """HR++'s Start Tracking for someone Not Tracked, or Start A New
    Probation after a decision / a removal / past the window - say, a move
    into a new role - counted from `start` (a day HR picks; empty = their
    start date). A probation that would already be over is refused: past
    the window is not probation (Neil, Oct 29 2026). Commits."""
    _require_hr(db, user, emp)
    rec = record(emp)
    if rec.get("status") in OPEN:
        raise ProbationError("Probation is already open for them.", 409)
    if start and not _parse(start):
        raise ProbationError("Pick the day the new probation counts from.")
    first = (start or emp.start_date or "")[:10]
    if _parse(first) and applies(emp):
        m = _check_months(months) if months is not None else _months_for(db, emp, rec)
        end = end_for(first, m)
        if end < _today().isoformat():
            raise ProbationError(f"Counted from {us_date(first)} it would already have ended on {us_date(end)} - "
                                 f"pick a later day for the new probation to count from.", 409)
    start_tracking(db, emp, user["email"], months=months, reason=reason, start=start)
    db.commit()
    return record(emp)


# ── decisions ────────────────────────────────────────────────────────────────

def _clean_decision(rec: dict, decision: str, new_end: str, reason: str) -> tuple:
    if decision not in DECISIONS:
        raise ProbationError("Pick Confirm, Extend or End Employment.")
    reason = (reason or "").strip()[:1000]
    if decision in ("extend", "end") and not reason:
        raise ProbationError("Add the reason - it is kept in the probation history"
                             + (" and printed on the extension letter." if decision == "extend" else "."))
    if decision == "extend":
        d = _parse(new_end)
        if not d:
            raise ProbationError("Pick the new end date.")
        cur = _parse(rec.get("endDate", ""))
        if cur and d <= cur:
            raise ProbationError(f"The new end date must be after the current one ({us_date(rec['endDate'])}).")
        new_end = d.isoformat()
    else:
        new_end = ""
    return decision, new_end, reason


def decide(db: Session, user: dict, emp: NexusEmployee, decision: str, *, new_end: str = "",
           reason: str = "") -> dict:
    """Confirm / Extend / End. HR++ finalizes at once; the manager's choice is
    a recommendation for HR. Commits (the letter after the decision)."""
    role = actor_role(db, user, emp)
    if not role:
        raise ProbationError("Only their manager or HR can decide their probation.", 403)
    rec = record(emp)
    if rec.get("status") not in OPEN:
        raise ProbationError("Their probation is not open - nothing to decide.", 409)
    decision, new_end, reason = _clean_decision(rec, decision, new_end, reason)
    if role == "manager":
        if rec.get("pending"):
            raise ProbationError("A recommendation is already waiting for HR.", 409)
        me = user["email"].lower()
        rec["pending"] = {"decision": decision, "newEndDate": new_end, "reason": reason, "by": me, "at": _now()}
        _log(rec, me, "recommended", end=new_end or rec.get("endDate", ""), reason=reason,
             note=DECISION_LABELS[decision])
        _save(emp, rec)
        _ask_hr(db, emp, rec["pending"])
        db.commit()
        return {"applied": False, "pending": True}
    return _apply(db, user, emp, decision, new_end, reason)


def approve_pending(db: Session, user: dict, emp: NexusEmployee, *, new_end: str = None,
                    reason: str = None) -> dict:
    """HR++ approves the manager's recommendation (an extension's date and the
    reason may be adjusted). Commits."""
    _require_hr(db, user, emp)
    rec = record(emp)
    p = rec.get("pending") if rec.get("status") in OPEN else None
    if not p:
        raise ProbationError("There is no recommendation waiting.", 409)
    decision, new_end, reason = _clean_decision(
        rec, p.get("decision", ""), new_end if new_end is not None else p.get("newEndDate", ""),
        reason if reason is not None and reason.strip() else p.get("reason", ""))
    return _apply(db, user, emp, decision, new_end, reason, recommended_by=p.get("by", ""))


def decline_pending(db: Session, user: dict, emp: NexusEmployee, note: str) -> dict:
    """HR++ declines the recommendation; the manager is told why. Commits."""
    _require_hr(db, user, emp)
    note = (note or "").strip()[:1000]
    if not note:
        raise ProbationError("Add a note for the manager - why it is declined.")
    rec = record(emp)
    p = rec.get("pending") if rec.get("status") in OPEN else None
    if not p:
        raise ProbationError("There is no recommendation waiting.", 409)
    rec["pending"] = None
    _log(rec, user["email"], "recommendation_declined", reason=note, note=DECISION_LABELS.get(p.get("decision"), ""))
    _save(emp, rec)
    _close_bells(db, emp)
    _bell(db, p.get("by", ""), f"Probation Recommendation Declined - {full_name(emp)}",
          f"HR declined your recommendation to {DECISION_LABELS.get(p.get('decision'), '').lower()}: {note}", emp)
    db.commit()
    return rec


def _apply(db: Session, user: dict, emp: NexusEmployee, decision: str, new_end: str, reason: str,
           recommended_by: str = "") -> dict:
    me = user["email"].lower()
    rec = record(emp)
    prev_status, prev_end = rec.get("status", ""), rec.get("endDate", "")
    rec["status"] = DECIDED[decision]
    rec["pending"] = None
    rec["decision"] = {"decision": decision, "by": me, "at": _now(), "reason": reason,
                       "previousEndDate": prev_end, "newEndDate": new_end, "recommendedBy": recommended_by}
    if decision == "extend":
        rec["endDate"], rec["endManual"], rec["remindedFor"] = new_end, True, ""
        rec["extensions"] = int(rec.get("extensions") or 0) + 1
    _log(rec, me, {"confirm": "confirmed", "extend": "extended", "end": "ended"}[decision], frm=prev_status,
         end=rec["endDate"], reason=reason,
         note=f"Recommended by {person_name(db, recommended_by)}" if recommended_by else "")
    _save(emp, rec)
    workflows.emit(db, "probation.decided", subject=emp, actor=me,
                   changes={"probation.status": (prev_status, rec["status"]),
                            "probation.end": (prev_end, rec["endDate"])},
                   extra={"decision": decision, "reason": reason, "recommendedBy": recommended_by})
    _close_bells(db, emp)
    # Tell the manager (and whoever recommended it) what HR decided.
    name = full_name(emp)
    words = {"confirm": f"{name}'s employment is confirmed.",
             "extend": f"{name}'s probation is extended to {us_date(new_end)}.",
             "end": f"{name}'s probation ended without confirmation - HR handles the offboarding."}[decision]
    for to in {recommended_by, (emp.manager_email or "").strip().lower()} - {"", me, (emp.work_email or "").lower()}:
        _bell(db, to, f"Probation {LABELS[DECIDED[decision]]} - {name}", words, emp)
    db.flush()
    if decision == "confirm":
        _tick_checklist(db, emp, me)
    db.commit()
    out = {"applied": True, "pending": False, "status": rec["status"], "startSeparation": decision == "end"}
    if decision in ("confirm", "extend"):
        out["letter"] = send_letter(db, user, emp)
    return out


def _tick_checklist(db: Session, emp: NexusEmployee, by: str) -> None:
    """ON-33 ticks through the checklist's own signal (probation_confirmed):
    an open onboarding checklist first takes its template as it stands (an
    older checklist's ON-33 had no condition yet), then syncs."""
    import hr_checklists as hc
    sp = db.begin_nested()
    try:
        for cl in db.query(hc.HrChecklist).filter(hc.HrChecklist.employee_id == emp.id,
                                                  hc.HrChecklist.kind == "onboarding",
                                                  hc.HrChecklist.status == "open").all():
            hc.reconcile(db, cl, emp, by=by)
        sp.commit()
    except Exception as e:   # noqa: BLE001 - a checklist never undoes the decision
        sp.rollback()
        print(f"[probation] checklist reconcile skipped for {emp.id}: {e}")
    hc.refresh_person(db, emp.id, by)


# ── the letter ───────────────────────────────────────────────────────────────

def _supervisor(db: Session, emp: NexusEmployee) -> str:
    mgr = (emp.manager_email or "").strip().lower()
    if mgr:
        return person_name(db, mgr)
    hr = hr_contact(db, emp)
    return person_name(db, hr) if hr else "Human Resources"


def letter_values(db: Session, emp: NexusEmployee, outcome: str, *, start: str, prev_end: str,
                  new_end: str, reason: str, months: int, confirmed_on: str = "") -> dict:
    """The probation variables a letter prints (on top of the person and the
    company Documents resolves by itself). `confirmed_on`: a Passed Probation
    record's letter is confirmed as of the end date, not the day it is sent."""
    confirmed = confirmed_on or _today().isoformat()
    vals = {
        "probation_start_date": long_date(start),
        "probation_end_date": long_date(prev_end),
        "probation_months": str(months),
        "confirmation_date": long_date(confirmed),
        "effective_date": long_date(confirmed if outcome == "confirm" else new_end),
        "supervisor": _supervisor(db, emp),
    }
    if outcome == "extend":
        vals["new_probation_end_date"] = long_date(new_end)
        vals["extension_reason"] = reason
    return vals


VARIABLE_LABELS = {"signatory": "the company signatory (Settings > Companies)",
                   "company_legal": "the company's legal name (Settings > Companies)",
                   "company": "their company (People)", "job_title": "their job title (People)",
                   "department": "their department (People)"}


def letter_plan(db: Session, emp: NexusEmployee, outcome: str, *, prev_end: str, new_end: str = "",
                reason: str = "", confirmed_on: str = "") -> dict:
    """Render the letter (raises ProbationError with what HR must fix):
    {pdf, fields, title, templateId, templateVersion}."""
    import io

    import hr_packet_docs as hpd
    from routers.documents import signing_fields
    if outcome not in LETTER_TITLES:
        raise ProbationError("Only a confirmation or an extension has a letter.")
    if not (emp.work_email or "").strip():
        raise ProbationError(f"{emp.first_name} needs a work email first - the letter is signed in Nexus.", 409)
    cfg = settings(db, emp.company or "")
    tid = cfg["confirmTemplateId" if outcome == "confirm" else "extendTemplateId"]
    if not tid:
        raise ProbationError(f"No {LETTER_TITLES[outcome].lower()} template is picked - set one in Settings > "
                             f"Hiring & Onboarding > Probation.", 409)
    snaps, problems = hpd.load_snaps(db, [tid])
    if problems or not snaps:
        raise ProbationError((problems or ["The letter template is missing."])[0], 409)
    snap = snaps[0]
    others = sorted(r for r in snap.signature_roles if r != "employee")
    if others:
        raise ProbationError(f'"{snap.name}" has a signature line for {", ".join(others)} - only the employee signs '
                             f'a probation letter (the company signatory is printed). Remove it in Documents.', 409)
    if "employee" not in snap.signature_roles:
        raise ProbationError(f'"{snap.name}" has no signature line for the employee - add one in Documents.', 409)
    rec = record(emp)
    values = letter_values(db, emp, outcome, start=rec.get("startDate") or emp.start_date or "",
                           prev_end=prev_end, new_end=new_end, reason=reason,
                           months=_months_for(db, emp, rec), confirmed_on=confirmed_on)
    merge = hpd.full_merge(db, snap, employee_id=emp.id, entity_id=emp.company or "", overrides=values)
    missing = hpd.unresolved(snap, merge)
    if missing:
        raise ProbationError("The letter still needs " + ", ".join(VARIABLE_LABELS.get(m, m) for m in missing) + ".", 409)
    letterhead = hpd.document_letterhead(db, SimpleNamespace(letterhead_id=cfg["letterheadId"]), snap)
    title = f"{LETTER_TITLES[outcome]} - {full_name(emp)}"
    anchors = []
    pdf = hpd.render(db, snap, title=title, letterhead_id=letterhead, merge=merge, employee_id=emp.id,
                     entity_id=emp.company or "", anchors=anchors)
    fields = signing_fields(anchors)
    if not any(f["role"] == "employee" for f in fields):
        raise ProbationError(f'"{snap.name}" printed no signature line for the employee - check it in Documents.', 409)
    from pypdf import PdfReader
    if "{{" in "".join(pg.extract_text() or "" for pg in PdfReader(io.BytesIO(pdf)).pages):
        raise ProbationError(f'"{snap.name}" still shows an unfilled variable - fix the template in Documents.', 409)
    return {"pdf": pdf, "fields": fields, "title": title, "templateId": tid, "templateVersion": snap.version}


def preview(db: Session, user: dict, emp: NexusEmployee, decision: str, new_end: str = "", reason: str = "") -> tuple:
    """(pdf, title) of the letter a decision would send - HR++ only."""
    _require_hr(db, user, emp)
    rec = record(emp)
    if decision not in LETTER_TITLES:
        raise ProbationError("Only a confirmation or an extension has a letter.")
    if decision == "extend":
        _d, new_end, reason = _clean_decision(rec, decision, new_end, reason or "(The reason you enter.)")
    p = letter_plan(db, emp, decision, prev_end=rec.get("endDate", ""), new_end=new_end, reason=reason)
    return p["pdf"], p["title"]


def send_letter(db: Session, user: dict, emp: NexusEmployee) -> dict:
    """Generate the letter for the last decision and send it through Nexus
    Sign, the employee its only signer. A Passed Probation record (no letter
    goes by itself) takes the confirmation letter, confirmed as of its end
    date. Never raises: what went wrong is kept on the record ({error}) and
    the decision stands. Commits."""
    from fastapi import HTTPException

    import hr_life_events as hle
    from routers import esign
    eid = emp.id
    rec = record(emp)
    d = rec.get("decision") or {}
    passed = rec.get("status") == "passed"
    outcome = "confirm" if passed else d.get("decision", "")
    try:
        if rec.get("status") not in ("confirmed", "extended", "passed") or outcome not in LETTER_TITLES:
            raise ProbationError("There is no confirmation or extension to send a letter for.", 409)
        busy = (db.query(HrLifeEvent).filter(HrLifeEvent.employee_id == eid, HrLifeEvent.kind == "probation",
                                             HrLifeEvent.status.in_(hle.ACTIVE)).first())
        if busy is not None:
            raise ProbationError("A probation letter is already out for signature - void it first.", 409)
        plan = letter_plan(db, emp, outcome, prev_end=d.get("previousEndDate", "") or rec.get("endDate", ""),
                           new_end="" if passed else d.get("newEndDate", ""), reason="" if passed else d.get("reason", ""),
                           confirmed_on=rec.get("endDate", "") if passed else "")
        path = f"esign/{uuid.uuid4()}/{hle._safe_name(plan['title'], 90)}.pdf"
        if not esign._storage_put(esign._DOC_BUCKET, path, plan["pdf"], "application/pdf").is_success:
            raise ProbationError("Could not store the letter - try Send Letter again in a minute.", 502)
        now = _now()
        ev = HrLifeEvent(id=str(uuid.uuid4()), kind="probation", status="sent", entity_id=emp.company or "",
                         employee_id=eid, subject_name=full_name(emp), subject_email=emp.work_email.lower(),
                         inputs={"outcome": outcome, "templateId": plan["templateId"],
                                 "templateVersion": plan["templateVersion"], "reason": d.get("reason", ""),
                                 "previousEndDate": d.get("previousEndDate", ""), "newEndDate": d.get("newEndDate", ""),
                                 "passed": passed},
                         effective_date=(rec.get("endDate") if passed else d.get("newEndDate")) or _today().isoformat(),
                         created_by=user["email"].lower(), created_at=now, updated_at=now)
        db.add(ev)
        db.flush()
        party = esign.PartyIn(role_key="employee", name=full_name(emp), email=emp.work_email.lower(),
                              kind="internal", ordinal=1, party_role="signer")
        # An employment letter: the Documents-built HR letters confirm the
        # e-sign exclusion the same way (OffboardModal / verify-and-send).
        out = esign.envelope_from_documents(
            db, user, documents=[{"name": f"{plan['title']}.pdf", "path": path, "fields": plan["fields"]}],
            parties=[party], title=plan["title"], employee_id=eid, entity_id=emp.company or "",
            message="", excluded_ack=True, document_class="employment", link_kind="life_event", link_id=ev.id)
        ev.sign_request_id = out["id"]
        emp = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
        rec = record(emp)
        rec["letter"] = {"outcome": outcome, "eventId": ev.id, "at": now, "error": ""}
        _log(rec, user["email"], "letter_sent", note=LETTER_TITLES[outcome])
        _save(emp, rec)
        db.commit()
        return {"sent": True, "eventId": ev.id, "title": plan["title"]}
    except (ProbationError, HTTPException) as e:
        msg = str(e.detail) if isinstance(e, HTTPException) else str(e)
    except Exception as e:   # noqa: BLE001 - storage / mail trouble: the decision stands
        msg = f"Nexus could not send the letter ({type(e).__name__}) - try Send Letter again."
        print(f"[probation] letter for {eid} failed: {type(e).__name__}: {e}")
    db.rollback()
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == eid).first()
    rec = record(emp)
    rec["letter"] = {"outcome": outcome, "eventId": "", "at": _now(), "error": msg[:500]}
    _save(emp, rec)
    db.commit()
    return {"sent": False, "error": msg}


def resend_letter(db: Session, user: dict, emp: NexusEmployee) -> dict:
    """HR++'s Send Letter (the first one failed, or was voided / declined)."""
    _require_hr(db, user, emp)
    return send_letter(db, user, emp)


def letter_signed(db: Session, ev: HrLifeEvent, req) -> None:
    """hr_life_events._APPLY['probation']: the employee signed. The record
    notes it; filing and the Documents tab copy are the engine's own."""
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == ev.employee_id).with_for_update().first()
    if emp is None:
        ev.apply_note = "The employee record is gone."
        return
    rec = record(emp)
    if (rec.get("letter") or {}).get("eventId") == ev.id:
        rec["letter"]["signedAt"] = _now()
    _log(rec, ev.subject_email, "letter_signed",
         note=LETTER_TITLES.get((ev.inputs or {}).get("outcome", ""), "Letter"))
    _save(emp, rec)
    ev.apply_note = "Signed by the employee"


# ── bells and email ──────────────────────────────────────────────────────────

def _action(emp: NexusEmployee) -> dict:
    return {"view": "hr", "sub": f"hr-probation-{emp.id}", "label": "Open Probation"}


def _bell(db: Session, to: str, title: str, body: str, emp: NexusEmployee, priority: int = 0) -> None:
    """One bell per person per probation, rewritten in place (CLAUDE.md: one
    notification per workflow, updated in place)."""
    from notify_company import notification_company
    to = (to or "").strip().lower()
    if not to:
        return
    ref = f"{NOTICE_PREFIX}{emp.id}"
    row = (db.query(NexusNotification)
           .filter(NexusNotification.type == "custom_alert", NexusNotification.ref_id == ref,
                   NexusNotification.recipient == to).with_for_update().first())
    if row is None:
        db.add(NexusNotification(
            id=str(uuid.uuid4()), type="custom_alert", recipient=to, title=title, body=body, ref_id=ref,
            item_name="", requested_by="probation", action=json.dumps(_action(emp)), actioned=False,
            read_by="", company=notification_company(db, emp.work_email, to), created_at=_now(),
            priority=1 if priority else 0))
        return
    row.title, row.body, row.read_by, row.actioned = title, body, "", False
    row.action, row.priority, row.created_at = json.dumps(_action(emp)), 1 if priority else 0, _now()


def _close_bells(db: Session, emp: NexusEmployee) -> None:
    """The waiting bells are done once someone acts (the bar clears)."""
    (db.query(NexusNotification)
     .filter(NexusNotification.ref_id == f"{NOTICE_PREFIX}{emp.id}", NexusNotification.actioned == False)  # noqa: E712
     .update({"actioned": True}, synchronize_session=False))


def hr_recipients(db: Session, emp: NexusEmployee) -> list:
    """The company HR contact; none set - the Global Admins (the last stop
    everywhere else in HR)."""
    hr = hr_contact(db, emp)
    if hr:
        return [hr]
    import hr_checklists as hc
    return list(hc.global_admins(db))


def _ask_hr(db: Session, emp: NexusEmployee, pending: dict) -> None:
    name = full_name(emp)
    who = person_name(db, pending.get("by", ""))
    what = DECISION_LABELS[pending["decision"]]
    body = (f"{who} recommends {what}"
            + (f" to {us_date(pending['newEndDate'])}" if pending.get("newEndDate") else "")
            + (f": {pending['reason']}" if pending.get("reason") else ".")
            + " Approve or decline it on their profile.")
    title = f"Probation Recommendation - {name}"
    batch = []
    for to in set(hr_recipients(db, emp)) - {(pending.get("by") or "").lower(), (emp.work_email or "").lower()}:
        _bell(db, to, title, body, emp, priority=1)
        batch.append((to, title, _email_html(db, to, title, body, [
            ("Employee", name), ("Recommendation", what), ("By", who),
            ("New End Date", us_date(pending.get("newEndDate", ""))), ("Reason", pending.get("reason", ""))], emp)))
    _mail_after_commit(db, batch)


def _email_html(db: Session, to: str, heading: str, intro: str, rows: list, emp: NexusEmployee) -> str:
    """role_change._email's layout, with the recipient's company logo
    (email_theme.logo_for - the one logo chain)."""
    import email_theme
    from app_url import app_url
    theme = email_theme.current()
    band = theme.color("#0f3d2e")
    url = f"{app_url()}/hr/hr-probation-{emp.id}"
    cells = "".join(
        f'<tr><td style="padding:8px 12px;font-size:12px;color:#6b7280;width:130px;vertical-align:top;border-top:1px solid #e5e7eb">{escape(k)}</td>'
        f'<td style="padding:8px 12px;font-size:14px;color:#111827;border-top:1px solid #e5e7eb;white-space:pre-line">{escape(v)}</td></tr>'
        for k, v in rows if v)
    return f"""<div style="background:#f3f4f6;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-collapse:collapse">
    <tr><td style="background:{band};padding:16px 28px">{theme.logo_block(email_theme.logo_for(db, "", to))}</td></tr>
    <tr><td style="padding:24px 28px 0">
      <div style="font-size:20px;font-weight:600;color:#111827">{escape(heading)}</div>
      <div style="font-size:14px;line-height:1.55;color:#374151;margin-top:8px">{escape(intro)}</div>
    </td></tr>
    <tr><td style="padding:18px 28px 0">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-top:none;border-collapse:collapse">{cells}</table>
    </td></tr>
    <tr><td style="padding:24px 28px 28px">
      <a href="{escape(url)}" style="display:inline-block;padding:10px 22px;border-radius:4px;background:{band};color:#ffffff;text-decoration:none;font-weight:600;font-size:13px">Open Probation</a>
    </td></tr>
    <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-size:11.5px;line-height:1.6;color:#6b7280">
      You get this because you manage {escape(full_name(emp))} or are their company's HR contact.{theme.footer_lines()}
    </td></tr>
  </table>
</div>"""


def send_emails(batch: list) -> None:
    """Off the request (a thread after commit, or the daily pass's own
    thread). One failure never stops the rest; the bell is there either way."""
    import graph_mail
    for to, subject, html in batch:
        try:
            graph_mail.send_mail(from_email=graph_mail.DEFAULT_FROM_EMAIL, to=[to], cc=None, subject=subject, html=html)
        except Exception as e:   # noqa: BLE001 - mail never fails the workflow
            print(f"[probation] email to {to} failed: {type(e).__name__}: {e}")


def _mail_after_commit(db: Session, batch: list) -> None:
    if not batch:
        return
    import threading

    from sqlalchemy import event as sa_event
    sa_event.listen(db, "after_commit",
                    lambda _s: threading.Thread(target=send_emails, args=(list(batch),), daemon=True).start(),
                    once=True)


# ── the daily reminder ───────────────────────────────────────────────────────

def reminder_recipients(db: Session, emp: NexusEmployee) -> list:
    out = [(emp.manager_email or "").strip().lower()] + hr_recipients(db, emp)
    work = (emp.work_email or "").strip().lower()
    return [e for i, e in enumerate(out) if e and e != work and e not in out[:i]]


def _due(db: Session, emp: NexusEmployee, today: date, cache: dict) -> bool:
    """Open, active, inside the company's window (0 = off), not yet reminded
    for this end date."""
    rec = record(emp)
    if emp.status not in ("active", "onboarding") or rec.get("status") not in OPEN:
        return False
    if not _parse(rec.get("endDate", "")) or rec.get("remindedFor") == rec["endDate"]:
        return False
    c = emp.company or ""
    if c not in cache:
        cache[c] = settings(db, c)["reminderDays"]
    return cache[c] > 0 and (_parse(rec["endDate"]) - today).days <= cache[c]


def due_reminders(db: Session, today: date = None) -> list:
    """The ids of the people whose reminder is due today."""
    today, cache = today or _today(), {}
    return [emp.id for emp in db.query(NexusEmployee).filter(NexusEmployee.status.in_(["active", "onboarding"])).all()
            if _due(db, emp, today, cache)]


def remind(db: Session, eid: str, today: date = None) -> list:
    """Send one person's reminder, on the row locked and checked again (a
    decision saved meanwhile is never overwritten). Returns the emails to
    send after commit, or None when it is no longer due."""
    today = today or _today()
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == eid).with_for_update().first()
    if emp is None or not _due(db, emp, today, {}):
        return None
    rec = record(emp)
    end = rec["endDate"]
    days = (_parse(end) - today).days
    name = full_name(emp)
    when = (f"in {days} day{'s' if days != 1 else ''}" if days > 0 else "today" if days == 0
            else f"{-days} day{'s' if days != -1 else ''} ago")
    title = f"Probation Ending - {name}"
    body = (f"{name}'s probation ends {us_date(end)} ({when}). Confirm, extend or end it on their profile - "
            f"HR finalizes; a manager's choice goes to HR as a recommendation. With no decision or "
            f"recommendation by then, it passes automatically the day after.")
    batch = []
    for to in reminder_recipients(db, emp):
        _bell(db, to, title, body, emp, priority=1 if days <= 0 else 0)
        batch.append((to, f"{title} ({us_date(end)})", _email_html(db, to, title, body, [
            ("Employee", name), ("Job Title", emp.job_title or ""), ("Start Date", us_date(rec.get("startDate", ""))),
            ("Probation Ends", us_date(end)), ("Status", LABELS.get(rec.get("status", ""), ""))], emp)))
    rec["remindedFor"], rec["remindedAt"] = end, _now()
    _save(emp, rec)
    return batch


# ── past the window: passed automatically (Neil, Oct 29 2026) ────────────────

def _passable(emp: NexusEmployee, today: date) -> bool:
    """Open, still here, the end date before today, and no manager
    recommendation waiting (that one is a real decision in flight - HR's)."""
    rec = record(emp)
    if (emp.status or "active") not in LIVE or rec.get("status") not in OPEN or rec.get("pending"):
        return False
    end = _parse(rec.get("endDate", ""))
    return end is not None and end < today


def due_passes(db: Session, today: date = None) -> list:
    """The ids of the open probations past their end with nothing pending."""
    today = today or _today()
    return [emp.id for emp in db.query(NexusEmployee).filter(NexusEmployee.status.in_(LIVE)).all()
            if _passable(emp, today)]


def auto_pass(db: Session, eid: str, today: date = None, emit: bool = True) -> bool:
    """One person's Passed Probation, on the row locked and checked again (a
    decision or recommendation saved meanwhile wins). Logged as the system,
    the reminder state cleared, the bells closed, ON-33 ticked like a
    confirm, probation.decided emitted - and NO letter (HR's Send Letter
    sends the confirmation letter by hand). Caller commits."""
    today = today or _today()
    emp = db.query(NexusEmployee).filter(NexusEmployee.id == eid).with_for_update().first()
    if emp is None or not _passable(emp, today):
        return False
    rec = record(emp)
    prev, end = rec["status"], rec.get("endDate", "")
    rec.update({"status": "passed", "pending": None, "remindedFor": "",
                "decision": {"decision": "passed", "by": "system", "at": _now(), "reason": AUTO_PASS_REASON,
                             "previousEndDate": end, "newEndDate": "", "recommendedBy": "", "automatic": True}})
    rec.pop("remindedAt", None)
    _log(rec, "system", "passed", frm=prev, to="passed", end=end, reason=AUTO_PASS_REASON)
    _save(emp, rec)
    if emit:   # the one-time release pass does not replay the backlog into Workflows
        workflows.emit(db, "probation.decided", subject=emp, actor="system",
                       changes={"probation.status": (prev, "passed")},
                       extra={"decision": "passed", "automatic": True})
    _close_bells(db, emp)
    db.flush()
    _tick_checklist(db, emp, "system")
    return True


def pass_past_window(db: Session, today: date = None, emit: bool = True) -> int:
    """Every open probation past its end with nothing pending -> passed, one
    person at a time (one never stops the pass). Commits; returns how many.
    `emit=False` (the one-time release pass) writes no workflow events, so a
    workflow on "Probation Is Decided" never fires for the old backlog."""
    today, n = today or _today(), 0
    for eid in due_passes(db, today):
        sp = db.begin_nested()
        try:
            hit = auto_pass(db, eid, today, emit=emit)
            sp.commit()
        except Exception as e:   # noqa: BLE001
            sp.rollback()
            print(f"[probation] automatic pass for {eid} skipped: {type(e).__name__}: {e}")
            continue
        n += 1 if hit else 0
    db.commit()
    return n


def pass_past_window_once(db: Session, today: date = None) -> tuple:
    """Once at release (a nexus_settings mark): the same move for every
    existing record, so long-tenured people stop reading In Probation the
    moment this deploys. Nothing is deleted; history is appended. Returns
    (passed, still open past the end with a recommendation waiting for HR),
    or None when it already ran. Commits."""
    from models import NexusSetting
    if db.get(NexusSetting, PAST_MARK):
        return None
    today = today or _today()
    passed = pass_past_window(db, today, emit=False)
    waiting = 0
    for emp in db.query(NexusEmployee).filter(NexusEmployee.status.in_(LIVE)).all():
        r = record(emp)
        end = _parse(r.get("endDate", ""))
        waiting += 1 if r.get("status") in OPEN and r.get("pending") and end and end < today else 0
    db.add(NexusSetting(key=PAST_MARK, value=_now(), updated_by="startup", updated_at=_now()))
    db.commit()
    return passed, waiting


def run_daily() -> int:
    """From reminders_loop, already in a worker thread (asyncio.to_thread) -
    never on the event loop. Own session and commit; the emails go after the
    commit. First the automatic Passed Probation, then the reminders. The
    Workflows > Automations switch (hr_probation) stops BOTH: switched off,
    nobody is passed automatically and nobody is reminded (Oct 29 2026
    review). The one-time startup pass (pass_past_window_once) is not this
    job. Returns how many people were reminded."""
    if job_switch.off("hr_probation"):   # Workflows > Automations switch
        return 0
    from database import SessionLocal
    db = SessionLocal()
    try:
        passed = pass_past_window(db)
        if passed:
            print(f"[probation] {passed} past their end date with no decision - passed automatically")
    except Exception as e:   # noqa: BLE001
        db.rollback()
        print(f"[probation] automatic pass failed: {e}")
    finally:
        db.close()
    db = SessionLocal()
    sent, batch = 0, []
    try:
        for eid in due_reminders(db):
            sp = db.begin_nested()
            try:
                mails = remind(db, eid)
                sp.commit()
            except Exception as e:   # noqa: BLE001 - one person never stops the pass
                sp.rollback()
                print(f"[probation] reminder for {eid} skipped: {e}")
                continue
            if mails is not None:
                sent += 1
                batch += mails
        db.commit()
    except Exception as e:   # noqa: BLE001
        db.rollback()
        print(f"[probation] daily pass failed: {e}")
        return 0
    finally:
        db.close()
    send_emails(batch)
    if sent:
        print(f"[probation] {sent} reminder(s)")
    return sent


# ── one-time seeds (main._startup_seeds) ─────────────────────────────────────

def _confirmation_content() -> dict:
    from routers.documents import _h, _mf, _p, _t
    return {"type": "doc", "content": [
        _h("Confirmation Of Employment"),
        _p(_mf("today")),
        _p(_t("Dear "), _mf("first_name"), _t(",")),
        _p(_t("We are pleased to confirm that you have successfully completed your probation period with "),
           _mf("company_legal"), _t(". Your employment as "), _mf("job_title"), _t(" is confirmed effective "),
           _mf("confirmation_date"), _t(".")),
        _p(_t("Your probation began on "), _mf("probation_start_date"),
           _t(". All other terms and conditions of your employment remain unchanged.")),
        _p(_t("Thank you for your work so far. We look forward to your continued success with the team.")),
        _p(_t("Please sign below to acknowledge that you have received this letter.")),
        _p(_t("Sincerely,")),
        _p(_mf("signatory")),
        _p(_mf("company_legal")),
        {"type": "signatureBlock", "attrs": {"role": "employee", "label": "Acknowledged By The Employee"}},
    ]}


def _extension_content() -> dict:
    from routers.documents import _h, _mf, _p, _t
    return {"type": "doc", "content": [
        _h("Extension Of Probation Period"),
        _p(_mf("today")),
        _p(_t("Dear "), _mf("first_name"), _t(",")),
        _p(_t("Your probation period as "), _mf("job_title"), _t(" with "), _mf("company_legal"),
           _t(", which began on "), _mf("probation_start_date"), _t(" and was due to end on "),
           _mf("probation_end_date"), _t(", has been extended through "), _mf("new_probation_end_date"), _t(".")),
        _p(_t("Reason for the extension: ", bold=True), _mf("extension_reason")),
        _p(_t("During the extension, "), _mf("supervisor"),
           _t(" will meet with you to review your progress. Your employment will be reviewed again before the "
              "new end date. All other terms and conditions of your employment remain unchanged.")),
        _p(_t("Please sign below to acknowledge that you have received this letter. Your signature confirms that "
              "you received it.")),
        _p(_t("Sincerely,")),
        _p(_mf("signatory")),
        _p(_mf("company_legal")),
        {"type": "signatureBlock", "attrs": {"role": "employee", "label": "Acknowledged By The Employee"}},
    ]}


_VARS = [
    ("probation_start_date", "Probation Start Date", "The day probation counted from (their start date)."),
    ("probation_end_date", "Probation End Date", "The end date before this letter (on an extension, the old one)."),
    ("new_probation_end_date", "New Probation End Date", "The end date an extension moves probation to."),
    ("confirmation_date", "Confirmation Date", "The day HR confirmed the employment."),
    ("extension_reason", "Extension Reason", "Why probation was extended - HR's words from the decision."),
    ("probation_months", "Probation Length (Months)", "The probation length in months."),
    ("supervisor", "Supervisor", "Their manager, else the company HR contact."),
]
SEEDS = (
    (CONFIRM_TEMPLATE_ID, "Probation Confirmation Letter", _confirmation_content,
     ("probation_start_date", "confirmation_date", "probation_months")),
    (EXTEND_TEMPLATE_ID, "Probation Extension Letter", _extension_content,
     ("probation_start_date", "probation_end_date", "new_probation_end_date", "extension_reason", "supervisor",
      "probation_months")),
)


def seed_templates(db: Session) -> int:
    """Once (a nexus_settings mark): the two default letters, active and
    published, on the default letterhead. A template HR deletes or rewrites
    afterwards stays that way. Commits; returns how many were added."""
    from models import DocLetterhead, DocTemplate, DocTemplateVersion, NexusSetting
    from routers.documents import _clean_field_defs, _publish
    if db.get(NexusSetting, SEED_MARK):
        return 0
    lh = db.query(DocLetterhead).filter(DocLetterhead.is_default == True).first()  # noqa: E712
    labels = {t: (lbl, desc) for t, lbl, desc in _VARS}
    added, now = 0, _now()
    for tid, name, content_fn, tokens in SEEDS:
        if db.query(DocTemplate.id).filter(DocTemplate.id == tid).first():
            continue
        content = {"pages": [{"id": str(uuid.uuid4()), "json": content_fn()}], "header": None, "footer": None}
        defs = [{"token": t, "label": labels[t][0], "type": "text", "description": labels[t][1]} for t in tokens]
        row = DocTemplate(id=tid, name=name, category="hr", tags=["probation", "hr letter"], content=content,
                          requires_letterhead=True, letterhead_id=lh.id if lh else "",
                          field_defs=_clean_field_defs(defs),
                          signer_roles=[{"key": "employee", "label": "Employee", "order": 1}],
                          department="", doc_type="document", status="active", version=1,
                          created_by="system", created_at=now, updated_by="system", updated_at=now)
        db.add(row)
        db.flush()
        db.add(DocTemplateVersion(id=str(uuid.uuid4()), template_id=tid, version_no=1,
                                  content=copy.deepcopy(content), edited_by="system", edited_at=now, note="Starter"))
        db.flush()
        _publish(db, row, "system", "Starter")
        added += 1
    db.add(NexusSetting(key=SEED_MARK, value=now, updated_by="startup", updated_at=now))
    db.commit()
    return added


def backfill_existing(db: Session, today: date = None) -> int:
    """Once (a nexus_settings mark): start probation for every existing
    employee still inside their window - start date + their length (the
    person's own months, else the company's) not passed yet. Contractors,
    externals and guests are never tracked (applies()); anyone already
    tracked, past the window or with no start date is left alone. Sends
    nothing: a person inside the reminder window gets the one normal
    reminder from the next daily pass. Commits; returns how many started."""
    from models import NexusSetting
    if db.get(NexusSetting, BACKFILL_MARK):
        return 0
    today = (today or _today()).isoformat()
    started = 0
    for emp in (db.query(NexusEmployee).filter(NexusEmployee.status.in_(("active", "onboarding")))
                .order_by(NexusEmployee.id).all()):
        try:
            if not applies(emp):
                continue
            rec = record(emp)
            if rec.get("status"):
                continue                      # already tracked, decided, passed or removed - never restarted
            start = (emp.start_date or "")[:10]
            if not _parse(start):
                continue                      # no start date: Not Tracked
            if end_for(start, _months_for(db, emp, rec)) < today:
                continue                      # already past the window
            start_tracking(db, emp, "system", reason="Still inside the probation window at release",
                           action="started")
            started += 1
        except Exception as e:   # noqa: BLE001 - one person never stops the pass
            print(f"[probation] backfill skipped {getattr(emp, 'id', '?')}: {type(e).__name__}: {e}")
    db.add(NexusSetting(key=BACKFILL_MARK, value=_now(), updated_by="startup", updated_at=_now()))
    db.commit()
    return started


def backfill_checklist_signal(db: Session) -> int:
    """Once: ON-33 in the Checklist Library and every company's own onboarding
    template takes the probation_confirmed condition where it has none (open
    checklists take it in the daily reconcile, or at the confirmation). A
    condition HR removes afterwards stays removed. Commits."""
    import hr_checklists as hc
    from models import NexusSetting
    if db.get(NexusSetting, SIGNAL_MARK):
        return 0
    n = 0
    for tpl in hc._base(db).filter(hc.HrChecklistTemplate.kind == "onboarding").all():
        items = [dict(r) for r in (tpl.items or []) if isinstance(r, dict)]
        hit = False
        for r in items:
            if r.get("key") == "ON-33" and not r.get("signal"):
                r["signal"], hit = SIGNAL, True
        if hit:
            tpl.items, tpl.updated_by, tpl.updated_at = items, "system", _now()
            n += 1
    db.add(NexusSetting(key=SIGNAL_MARK, value=_now(), updated_by="startup", updated_at=_now()))
    db.commit()
    return n
