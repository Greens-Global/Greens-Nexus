"""Nexus Daily Briefing (Aug 2026 - Neil's "one email" ask, call 8/21).

Every employee gets exactly ONE email a day, ~2.5 hours before THEIR OWN
shift starts, replacing the scatter of individual Nexus notification emails.
Sections are color-banded by urgency: red (needs your approval), amber
(activity on something you're watching), blue (FYI - manager add-on only in
this phase), green (completed since your last briefing). A section with
nothing in it is omitted, never rendered empty.

Settings live in NexusSetting (key="daily_briefing_config", JSON value) -
same pattern as ticket_notify.py. `mode`:
  - "off"  - loop still scans + logs (so timing/dedupe can be watched) but
             never sends mail.
  - "test" - computes each real employee's real content, but the SEND is
             redirected to `test_recipients` with a "[TEST -> original]"
             subject prefix, so every employee's actual briefing can be
             eyeballed without anyone else receiving anything. This is the
             mode Phase 1 ships in - Neil was explicit: build it, don't turn
             it on for real people until it's proven.
  - "live" - sends to the real employee.

Dedupe + "since last briefing" cursor is NexusDailyBriefingLog (models.py) -
one row per (employee, employee-local calendar day). Shift-start resolution
reuses routers.timeclock._shift_start_for / _employee_now rather than
reimplementing shift lookup - those already handle ScheduledShift ->
ShiftAssignment -> preset fallback and the employee's own tz offset.
"""
import asyncio
import json
import uuid
from datetime import datetime, timezone, timedelta, date
from html import escape

from sqlalchemy import func
from sqlalchemy.orm import Session

import models
from database import SessionLocal
import graph_mail
from app_url import app_url
from routers.timeclock import _shift_start_for, _employee_now

_SETTINGS_KEY = "daily_briefing_config"
_DEFAULT_SETTINGS = {
    "mode": "off",              # off|test|live
    "test_recipients": [],
}

TRIGGER_MINUTES_BEFORE_SHIFT = 150   # 2.5h - agreed on the call
SCAN_EVERY_SEC = 15 * 60             # tight enough to catch a shift-relative
                                      # instant within 15 minutes, matching
                                      # timeclock_watch.py's 30-min precedent
                                      # for a similar per-person threshold
LOOKBACK_HOURS_FIRST_RUN = 48        # "since" window when an employee has no
                                      # prior briefing logged yet


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


# ── Settings ───────────────────────────────────────────────────────────────

def get_settings(db: Session) -> dict:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    if not row or not row.value:
        return json.loads(json.dumps(_DEFAULT_SETTINGS))
    try:
        cfg = json.loads(row.value)
    except (TypeError, ValueError):
        cfg = {}
    merged = json.loads(json.dumps(_DEFAULT_SETTINGS))
    merged.update(cfg)
    return merged


def save_settings(db: Session, patch: dict, actor_email: str) -> dict:
    merged = get_settings(db)
    merged.update(patch)
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    if not row:
        row = models.NexusSetting(key=_SETTINGS_KEY)
        db.add(row)
    row.value = json.dumps(merged)
    row.updated_by = actor_email
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    return merged


# ── Trigger + dedupe ──────────────────────────────────────────────────────

def _last_log(db: Session, email: str):
    return (db.query(models.NexusDailyBriefingLog)
            .filter(models.NexusDailyBriefingLog.employee_email == email)
            .order_by(models.NexusDailyBriefingLog.created_at.desc())
            .first())


def _already_logged_today(db: Session, email: str, briefing_date: str) -> bool:
    return (db.query(models.NexusDailyBriefingLog)
            .filter(models.NexusDailyBriefingLog.employee_email == email,
                    models.NexusDailyBriefingLog.briefing_date == briefing_date)
            .first()) is not None


def _trigger_due(db: Session, email: str) -> tuple:
    """(due: bool, briefing_date: str, local_now: datetime) - due once the
    employee's local wall-clock time has reached shift_start minus
    TRIGGER_MINUTES_BEFORE_SHIFT, for a shift on today's or tomorrow's local
    date (whichever the trigger window actually falls on - a person whose
    shift starts at 1am local needs their briefing to fire while "today" by
    wall clock is still yesterday's date, exactly like the call-out to reject
    a fixed UTC hour)."""
    local_now = _employee_now(db, email)
    for dd in (local_now.date(), local_now.date() + timedelta(days=1)):
        shift = _shift_start_for(db, email, dd)
        if not shift:
            continue
        hh, mm = shift[0].split(":")
        shift_start = datetime.combine(dd, datetime.min.time()).replace(hour=int(hh), minute=int(mm))
        trigger_at = shift_start - timedelta(minutes=TRIGGER_MINUTES_BEFORE_SHIFT)
        if trigger_at <= local_now < shift_start and not _already_logged_today(db, email, dd.isoformat()):
            return True, dd.isoformat(), local_now
    return False, "", local_now


# ── Content ───────────────────────────────────────────────────────────────

def _collaborator_emails(t: "models.Task") -> set:
    # Same guard as task_util.email_list: a null in follower_emails would raise
    # here too, and this runs inside the briefing loop where the failure is
    # silent rather than a visible 500.
    return {(t.assignee_email or "").lower(), (t.owner_email or "").lower()} | \
           {f.lower() for f in (t.follower_emails or []) if isinstance(f, str)}


def _red_rows(db: Session, email: str) -> list:
    rows = []
    for t in (db.query(models.Task)
              .filter(models.Task.type == "approval",
                      models.Task.approval_status == "pending",
                      models.Task.assignee_email == email).all()):
        rows.append({
            "title": f"Approve: {t.title}",
            "detail": "Waiting on your decision",
            "url": f"{app_url()}/tasks/mine?task={t.id}",
        })
    my_reports = {(e.work_email or "").lower(): e for e in
                  db.query(models.NexusEmployee)
                  .filter(func.lower(models.NexusEmployee.manager_email) == email.lower()).all()}
    if my_reports:
        for r in (db.query(models.TimeOffRequest)
                  .filter(models.TimeOffRequest.status == "pending",
                          models.TimeOffRequest.employee_email.in_(list(my_reports))).all()):
            emp = my_reports.get((r.employee_email or "").lower())
            name = f"{emp.first_name} {emp.last_name}".strip() if emp else r.employee_email
            rows.append({
                "title": f"Approve: {name}'s time off ({r.type})",
                "detail": f"{r.start_date} - {r.end_date}",
                "url": f"{app_url()}/timeclock",
            })
    rows.extend(_timecard_rows(db, email))
    return rows


def _timecard_rows(db: Session, email: str) -> list:
    """Pay-period reminders (Neil, 8/21: 'we want to make sure you get paid on
    time. You need to do this.'). Reuses the SAME period math + sign-off state
    the Time module's own timecard header uses - no fresh TimePunch/TimeApproval
    query, just the existing _pay_type/_pay_period/_month_bounds/_signoff_state
    (routers/timeclock.py). Auto-drafting an actual contractor invoice (Neil's
    India idea) is a separate feature with no existing hook to build on - out
    of scope here; this is the reminder half only."""
    from routers.timeclock import _pay_type, _pay_period, _month_bounds, _signoff_state, _employee_today
    today = _employee_today(db, email)
    start, end = (_month_bounds(today) if _pay_type(db, email) == "fixed" else _pay_period(today))
    end_d = datetime.strptime(end, "%Y-%m-%d").date()
    today_d = datetime.strptime(today, "%Y-%m-%d").date()
    days_to_close = (end_d - today_d).days

    state = _signoff_state(db, email, start, end)
    signed = state["signed"]
    needs_action = signed is None or signed["stale"]
    if not needs_action:
        return []
    if 0 <= days_to_close <= 2:
        return [{"title": "Confirm your time card",
                 "detail": f"Pay period closes {end} - review and sign off before it locks",
                 "url": f"{app_url()}/timeclock"}]
    if days_to_close == -1:
        return [{"title": "Submit your time card",
                 "detail": f"Pay period ending {end} is closed - sign off is still open",
                 "url": f"{app_url()}/timeclock"}]
    return []


def _amber_rows(db: Session, email: str, since_iso: str) -> list:
    activity = (db.query(models.TaskActivity)
                .filter(models.TaskActivity.entity_kind == "task",
                        models.TaskActivity.at >= since_iso)
                .order_by(models.TaskActivity.at.desc())
                .limit(500).all())
    if not activity:
        return []
    task_ids = {a.entity_id for a in activity}
    tasks = {t.id: t for t in db.query(models.Task).filter(models.Task.id.in_(task_ids)).all()}
    rows, seen_tasks = [], set()
    for a in activity:
        t = tasks.get(a.entity_id)
        if not t or t.id in seen_tasks:
            continue
        if email.lower() not in _collaborator_emails(t) or (a.actor_email or "").lower() == email.lower():
            continue
        seen_tasks.add(t.id)
        rows.append({
            "title": f"{t.code or 'Task'} - {a.entity_title or t.title}",
            "detail": a.detail or a.type,
            "url": f"{app_url()}/tasks/mine?task={t.id}",
        })
    return rows


def _green_rows(db: Session, email: str, since_iso: str) -> list:
    rows = []
    for t in (db.query(models.Task)
              .filter(models.Task.completed == True,  # noqa: E712
                      models.Task.completed_at >= since_iso).all()):
        if email.lower() not in _collaborator_emails(t):
            continue
        rows.append({
            "title": f"{t.code or 'Task'} - {t.title}",
            "detail": "Completed",
            "url": f"{app_url()}/tasks/mine?task={t.id}",
        })
    return rows


def _blue_rows_manager(db: Session, email: str) -> list:
    """Manager add-on only - direct reports out today, plus the day-before
    nudge for anyone whose leave STARTS tomorrow (Neil, 8/21: 'I want the
    e-mail on the prior today')."""
    reports = (db.query(models.NexusEmployee)
               .filter(func.lower(models.NexusEmployee.manager_email) == email.lower()).all())
    if not reports:
        return []
    report_emails = {e.work_email for e in reports if e.work_email}
    if not report_emails:
        return []
    names = {e.work_email: f"{e.first_name} {e.last_name}".strip() for e in reports}
    today = date.today().isoformat()
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    rows = []
    for r in (db.query(models.TimeOffRequest)
              .filter(models.TimeOffRequest.employee_email.in_(report_emails),
                      models.TimeOffRequest.status == "approved",
                      models.TimeOffRequest.start_date <= today,
                      models.TimeOffRequest.end_date >= today).all()):
        rows.append({
            "title": f"Out today: {names.get(r.employee_email, r.employee_email)} ({r.type})",
            "detail": f"Back {r.end_date}",
            "url": "",
        })
    for r in (db.query(models.TimeOffRequest)
              .filter(models.TimeOffRequest.employee_email.in_(report_emails),
                      models.TimeOffRequest.status == "approved",
                      models.TimeOffRequest.start_date == tomorrow).all()):
        rows.append({
            "title": f"Starting leave tomorrow: {names.get(r.employee_email, r.employee_email)}",
            "detail": f"{r.start_date} - {r.end_date}. Reassign anything time-sensitive today.",
            "url": "",
        })
    return rows


def build_sections(db: Session, email: str, since_iso: str) -> dict:
    sections = {
        "red":   _red_rows(db, email),
        "amber": _amber_rows(db, email, since_iso),
        "blue":  _blue_rows_manager(db, email),
        "green": _green_rows(db, email, since_iso),
    }
    return {k: v for k, v in sections.items() if v}


# ── Render (email-safe: inline styles, Segoe UI stack, table layout) ──────

_BADGE = {
    "red":   ("Action required",        "#b8433a", "#faece9"),
    "amber": ("Might need a look",      "#a8721f", "#faf1de"),
    "blue":  ("FYI - no action needed", "#2f5f8a", "#e9f1f8"),
    "green": ("Completed since your last briefing", "#3c7a52", "#e9f5ec"),
}
_ORDER = ["red", "amber", "blue", "green"]
_SUMMARY_NOUN = {"red": "need your approval", "amber": "updates to check", "blue": "FYI", "green": "completed"}


def _card_html(color: str, row: dict) -> str:
    _, accent, tint = _BADGE[color]
    link = (f"<div style='margin-top:6px'><a href='{escape(row['url'])}' "
            f"style='color:{accent};font-size:12.5px;font-weight:700;text-decoration:none'>Open in Nexus &rarr;</a></div>"
            if row.get("url") else "")
    return f"""
        <div style="background:{tint};border:1px solid {accent}55;border-radius:8px;padding:13px 16px;margin-bottom:10px">
          <div style="font-size:14px;font-weight:700;color:#26312a">{escape(row['title'])}</div>
          <div style="font-size:12.5px;color:#5c6a60;margin-top:2px">{escape(row['detail'])}</div>
          {link}
        </div>"""


def _section_html(color: str, rows: list) -> str:
    label, accent, _ = _BADGE[color]
    badge = (f"<span style='display:inline-block;padding:5px 11px;border-radius:5px;background:{accent};"
             f"color:#ffffff;font-family:\"Courier New\",monospace;font-size:11px;letter-spacing:.09em;"
             f"text-transform:uppercase;font-weight:700'>{escape(label)}</span>")
    cards = "".join(_card_html(color, r) for r in rows)
    return f"""
      <tr><td style="padding:18px 28px 4px">
        <div style="margin-bottom:10px">{badge}</div>
        {cards}
      </td></tr>"""


def render_email(employee_name: str, briefing_date: str, sections: dict) -> tuple:
    _d = datetime.strptime(briefing_date, "%Y-%m-%d")
    weekday_date = f"{_d.strftime('%A, %B')} {_d.day}"  # avoid %-d/%#d (platform-specific strftime flags)
    counts = " &middot; ".join(f"{len(sections[c])} {_SUMMARY_NOUN[c]}"
                                for c in _ORDER if sections.get(c))
    body_sections = "".join(_section_html(c, sections[c]) for c in _ORDER if sections.get(c))
    subject = f"Your Nexus Briefing - {weekday_date}"
    html = f"""<div style="background:#f4f5f7;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;border:1px solid #e5e7eb;border-collapse:separate;overflow:hidden">
    <tr>
      <td style="background:#173328;padding:22px 28px">
        <div style="font-family:'Courier New',monospace;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#8fd3ac;font-weight:700">Nexus</div>
        <div style="color:#ffffff;font-size:21px;font-weight:700;margin-top:8px">Your Daily Briefing</div>
        <div style="color:#b7d8c6;font-size:13px;margin-top:3px">{escape(weekday_date)}</div>
      </td>
    </tr>
    <tr><td style="padding:16px 28px;border-bottom:1px solid #eef0ec;font-size:13px;color:#5c6a60">{escape(counts) or "Nothing new since your last briefing"}</td></tr>
    <tr><td style="padding:18px 28px 0;font-size:14.5px;color:#5c6a60">Good morning{', ' + escape(employee_name) if employee_name else ''}. Here's everything since your last briefing - sign in only if you need the full detail.</td></tr>
    {body_sections}
    <tr>
      <td style="padding:22px 28px 26px;margin-top:6px;border-top:1px solid #eef0ec">
        <p style="font-size:11.5px;color:#95a096;margin:0 0 6px;line-height:1.5">This briefing replaces individual task/HR notification emails. Anything genuinely blocking still reaches you instantly on Teams.</p>
        <p style="margin:0"><a href="{escape(app_url())}" style="color:#2f6b50;text-decoration:none;font-weight:700;font-size:12px">Open Nexus</a></p>
      </td>
    </tr>
  </table>
</div>"""
    return subject, html


# ── Send + scan ─────────────────────────────────────────────────────────

def _send_one(db: Session, emp: "models.NexusEmployee", cfg: dict, briefing_date: str) -> None:
    since_iso = ""
    last = _last_log(db, emp.work_email)
    if last and last.sent_at:
        since_iso = last.sent_at
    if not since_iso:
        since_iso = (datetime.now(timezone.utc) - timedelta(hours=LOOKBACK_HOURS_FIRST_RUN)).strftime("%Y-%m-%dT%H:%M:%S")

    sections = build_sections(db, emp.work_email, since_iso)
    name = f"{emp.first_name} {emp.last_name}".strip()
    subject, html = render_email(name, briefing_date, sections)

    mode = cfg.get("mode", "off")
    sent_at = ""
    if mode in ("test", "live") and sections:
        to = [emp.work_email] if mode == "live" else list(cfg.get("test_recipients") or [])
        if mode == "test":
            subject = f"[TEST -> {emp.work_email}] {subject}"
        if to:
            try:
                graph_mail.send_mail(from_email=graph_mail.DEFAULT_FROM_EMAIL, to=to, cc=None,
                                      subject=subject, html=html)
                sent_at = _now_iso()
            except graph_mail.GraphMailError as e:
                print(f"[daily-briefing] send failed for {emp.work_email}: {e}")

    db.add(models.NexusDailyBriefingLog(
        id=str(uuid.uuid4()), employee_email=emp.work_email, briefing_date=briefing_date,
        sent_at=sent_at, mode=mode,
        red_count=len(sections.get("red", [])), amber_count=len(sections.get("amber", [])),
        blue_count=len(sections.get("blue", [])), green_count=len(sections.get("green", [])),
        created_at=_now_iso(),
    ))
    db.commit()


def _scan_once() -> int:
    db = SessionLocal()
    sent = 0
    try:
        cfg = get_settings(db)
        employees = (db.query(models.NexusEmployee)
                     .filter(models.NexusEmployee.work_email != "").all())
        for emp in employees:
            try:
                due, briefing_date, _ = _trigger_due(db, emp.work_email)
                if not due:
                    continue
                _send_one(db, emp, cfg, briefing_date)
                sent += 1
            except Exception as e:
                db.rollback()
                print(f"[daily-briefing] scan failed for {emp.work_email}: {e}")
        return sent
    finally:
        db.close()


async def daily_briefing_loop():
    await asyncio.sleep(60)
    while True:
        try:
            n = await asyncio.to_thread(_scan_once)
            if n:
                print(f"[daily-briefing] scan complete - {n} briefing(s) logged")
        except Exception as e:
            print(f"[daily-briefing] loop error: {e}")
        await asyncio.sleep(SCAN_EVERY_SEC)
