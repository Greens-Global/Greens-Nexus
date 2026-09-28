"""Nexus Weekly Digest (Neil, Sep 28 2026) - separate from the Daily Briefing.

"These are the tasks you have overdue, along with their due dates." One email
per employee per week listing every open task assigned to them that is past
its due date, oldest first, each with its due date, how late it is and an
Extend Due Date button (routers/mail_actions.py do=extend, which applies the
app's own due-date rule - task_due.py). A manager also gets one line per
direct report who has overdue work. Nobody with nothing overdue is mailed.

Default schedule (Neil): every Monday, 2 hours before the person's shift -
the same shift lookup the Daily Briefing uses (the Shift preset's own
timezone, a published ScheduledShift first). Someone with no shift that
Monday gets it at `defaultSendTime` in their own zone instead, so people
without a shift are not left out. Neil asked for the default to just work,
not for employees to configure it; the admin settings (Settings > Weekly
Digest) exist to test it and turn it on.

Settings live in NexusSetting (key="weekly_digest_config") with the same
off / test / live `mode` as the Daily Briefing: "off" scans and logs without
mailing, "test" builds each person's real digest but sends it to
`test_recipients` with a "[TEST -> original]" subject, "live" mails the
person. Off by default, so a deploy never starts mailing anyone on its own.

Dedupe: NexusWeeklyDigestLog, one row per (employee, week).
"""
import asyncio
import json
import uuid
from datetime import datetime, timezone, timedelta, date

from sqlalchemy import func, text
from sqlalchemy.orm import Session

import models
from database import SessionLocal
import graph_mail
import daily_briefing as daily
from app_url import app_url
from routers.task_util import task_assignees

_SETTINGS_KEY = "weekly_digest_config"
_DEFAULT_SETTINGS = {
    "mode": "off",              # off|test|live
    "test_recipients": [],
    "sendDay": 1,               # ISO weekday: 1 = Monday .. 7 = Sunday
    "leadMinutes": 120,         # before the shift starts (Neil: 2 hours)
    "includeNoShift": True,     # no shift that day -> send at defaultSendTime
    "defaultSendTime": "08:00",  # local 24h HH:MM
    "defaultTimeZone": "America/Los_Angeles",
}
DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
SECTION = "overdue"            # the person's own overdue tasks
TEAM_SECTION = "team_overdue"  # manager: one line per direct report behind
ORDER = [SECTION, TEAM_SECTION]

SCAN_EVERY_SEC = 15 * 60
_REPORT_TITLE_CAP = 3
# Its own advisory-lock keyspace, so a digest send never waits on the daily
# briefing's lock for the same person (daily_briefing._BRIEFING_LOCK_NS).
_DIGEST_LOCK_NS = 918273646


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


# ── Settings ───────────────────────────────────────────────────────────────

def get_settings(db: Session) -> dict:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    merged = json.loads(json.dumps(_DEFAULT_SETTINGS))
    if row and row.value:
        try:
            cfg = json.loads(row.value)
        except (TypeError, ValueError):
            cfg = {}
        if isinstance(cfg, dict):
            merged.update(cfg)
    return merged


def validate(patch: dict) -> dict:
    """Checks and normalizes a config patch. Raises ValueError with a readable
    message on a bad value; keys not present are left alone. The timing keys
    share their names and rules with the Daily Briefing's."""
    out = daily.validate_timing(patch)
    if "mode" in out and out["mode"] not in ("off", "test", "live"):
        raise ValueError("Mode must be off, test or live.")
    if "test_recipients" in out:
        if not isinstance(out["test_recipients"], list):
            raise ValueError("Test recipients must be a list of email addresses.")
        out["test_recipients"] = [str(e).strip() for e in out["test_recipients"] if str(e).strip()]
    if "sendDay" in out:
        v = out["sendDay"]
        if isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= 7:
            raise ValueError("Send day must be a weekday from 1 (Monday) to 7 (Sunday).")
    return out


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


def send_day(cfg: dict) -> int:
    v = cfg.get("sendDay")
    return v if isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= 7 else 1


# ── Trigger + dedupe ──────────────────────────────────────────────────────

def week_start(d: date) -> str:
    """The Monday of the week `d` falls in - the per-week dedupe key."""
    return (d - timedelta(days=d.weekday())).isoformat()


def _already_logged(db: Session, email: str, week: str) -> bool:
    return (db.query(models.NexusWeeklyDigestLog)
            .filter(models.NexusWeeklyDigestLog.employee_email == email,
                    models.NexusWeeklyDigestLog.week_start == week).first()) is not None


def _shift_due(db: Session, email: str, cfg: dict) -> tuple:
    """(due, digest_date, local_now) - the Daily Briefing's shift trigger
    (daily_briefing._trigger_due), for a shift on the send day only: due from
    shift start minus leadMinutes until the shift starts, in the shift's own
    timezone. The candidate dates span a day either side of UTC-today for the
    same reason as there - a shift's calendar date is independent of its zone."""
    lead = daily.lead_minutes({"leadMinutes": cfg.get("leadMinutes", 120)})
    utc_today = datetime.now(timezone.utc).date()
    for dd in (utc_today - timedelta(days=1), utc_today, utc_today + timedelta(days=1)):
        if dd.isoweekday() != send_day(cfg):
            continue
        shift = daily._shift_start_for(db, email, dd)
        if not shift:
            continue
        hh, mm = shift[0].split(":")
        local_now = daily._shift_local_now(shift[2])
        start = datetime.combine(dd, datetime.min.time()).replace(hour=int(hh), minute=int(mm))
        if start - timedelta(minutes=lead) <= local_now < start and not _already_logged(db, email, week_start(dd)):
            return True, dd, local_now
    return False, None, None


def _no_shift_due(db: Session, email: str, cfg: dict) -> tuple:
    """(due, digest_date, local_now) for someone with no shift on the send day
    (their local date): due from defaultSendTime until the Daily Briefing's
    catch-up window closes, in their own zone."""
    local_now = daily._shift_local_now(daily._person_zone(db, email, cfg))
    today = local_now.date()
    if today.isoweekday() != send_day(cfg) or daily._shift_start_for(db, email, today):
        return False, None, None
    send_at = datetime.combine(today, daily._default_send_time(cfg))
    if not (send_at <= local_now < send_at + timedelta(minutes=daily.NO_SHIFT_CATCH_UP_MIN)):
        return False, None, None
    if _already_logged(db, email, week_start(today)):
        return False, None, None
    return True, today, local_now


def trigger_due(db: Session, email: str, cfg: dict) -> tuple:
    due, d, local_now = _shift_due(db, email, cfg)
    if not due and cfg.get("includeNoShift", True) is not False:
        due, d, local_now = _no_shift_due(db, email, cfg)
    return due, d, local_now


# ── Content ───────────────────────────────────────────────────────────────

def _open_dated_tasks(db: Session) -> list:
    """Open, dated, live tasks. The assignee match is done by the caller in
    Python: assignee_emails is a JSON list with no containment predicate that
    works on both SQLite and Postgres (same reason as daily_briefing._red_rows)."""
    return (db.query(models.Task)
            .filter(models.Task.completed == False,  # noqa: E712
                    models.Task.due_on != "",
                    models.Task.type != "section",
                    (models.Task.deleted_at == "") | (models.Task.deleted_at.is_(None))).all())


def _due(t) -> date:
    try:
        return date.fromisoformat((t.due_on or "")[:10])
    except ValueError:
        return None


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def overdue_rows(db: Session, email: str, today: date, my_reports: dict) -> tuple:
    """(own, team): the person's own overdue tasks, oldest first, and one line
    per direct report with overdue work (the same one-card-per-report
    bundling the Daily Briefing uses for a report's completed tasks)."""
    email = email.lower()
    reports = set(my_reports) - {email}
    mine, by_report = [], {}
    for t in _open_dated_tasks(db):
        due = _due(t)
        if not due or due >= today:
            continue
        people = set(task_assignees(t))
        if email in people:
            mine.append((due, t))
        for rep in people & reports:
            by_report.setdefault(rep, []).append((due, t))
    mine.sort(key=lambda x: (x[0], x[1].title or ""))
    pids = {t.project_id for _, t in mine if t.project_id}
    projects = ({p.id: p.name for p in db.query(models.TaskProject).filter(models.TaskProject.id.in_(pids)).all()}
                if pids else {})
    rows, team = [], []
    for due, t in mine:
        detail = f"Due {due.strftime('%m/%d/%Y')} - {_plural((today - due).days, 'day')} overdue"
        if projects.get(t.project_id or ""):
            detail += f" - {projects[t.project_id]}"
        rows.append({
            "title": t.title, "ref": t.code or "", "detail": detail,
            "url": f"{app_url()}/tasks/mine?task={t.id}",
            "module": "tasks", "task_id": t.id, "action_email": email,
            # Extend Due Date (Neil) plus the usual Comment / React / Change
            # Status / Mark Complete - see daily_briefing._row_actions_html.
            "task_open": True, "task_extend": True,
        })
    for rep, items in sorted(by_report.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        items.sort(key=lambda x: (x[0], x[1].title or ""))
        emp = my_reports.get(rep)
        name = (f"{emp.first_name or ''} {emp.last_name or ''}".strip() if emp else "") or rep
        titles = [f"{t.title} (due {d.strftime('%m/%d/%Y')})" for d, t in items]
        shown, hidden = titles[:_REPORT_TITLE_CAP], titles[_REPORT_TITLE_CAP:]
        team.append({
            "title": f"{name} has {_plural(len(items), 'overdue task')}",
            "detail": "; ".join(shown) + (f"; and {len(hidden)} more" if hidden else ""),
            "url": f"{app_url()}/tasks/mine?task={items[0][1].id}", "module": "team",
        })
    return rows, team


def build_sections(db: Session, email: str, today: date) -> dict:
    my_reports = {(e.work_email or "").lower(): e for e in
                  db.query(models.NexusEmployee)
                  .filter(func.lower(models.NexusEmployee.manager_email) == email.lower()).all()
                  if e.work_email}
    own, team = overdue_rows(db, email, today, my_reports)
    return {k: v for k, v in ((SECTION, own), (TEAM_SECTION, team)) if v}


def render(first_name: str, today: date, sections: dict, greeting: str, logo_url: str, cfg: dict) -> tuple:
    week_of = f"Week of {datetime.strptime(week_start(today), '%Y-%m-%d').strftime('%m/%d/%Y')}"
    footer = (f"You receive the Weekly Digest every {DAY_NAMES[send_day(cfg) - 1]}, before your shift "
              "starts. It lists every task assigned to you that is past its due date.")
    return daily.render_email(first_name, today.isoformat(), sections, greeting=greeting, logo_url=logo_url,
                              title="Weekly Digest", date_label=week_of,
                              intro="These are the tasks you have overdue, along with their due dates.",
                              footer=footer, order=ORDER, expanded=True,
                              cta_label="Open My Tasks", cta_path="/tasks/mine",
                              cta_hint="Extend, comment on or complete each task in one click.")


# ── Send + scan ─────────────────────────────────────────────────────────

def _without_actions(sections: dict) -> dict:
    """The same rows minus Extend / Comment / React / Change Status / Mark
    Complete - those links act AS the employee, so a copy read by someone else
    (a test recipient) must not carry them. Open in Nexus stays. The Daily
    Briefing applies the same rule to its Outlook card in test mode."""
    drop = ("task_id", "task_open", "task_extend", "action_email")
    return {k: [{f: v for f, v in r.items() if f not in drop} for r in rows] for k, rows in sections.items()}


def _only_for(emp, to: list) -> bool:
    return {(e or "").strip().lower() for e in to} == {(emp.work_email or "").lower()}


def compose(db: Session, emp: "models.NexusEmployee", cfg: dict, today: date, local_now: datetime,
            actions: bool = True) -> tuple:
    """(sections, subject, html) - one person's digest as the scan would build
    it; `actions=False` renders it without the act-as-them links."""
    sections = build_sections(db, emp.work_email, today)
    if not actions:
        sections = _without_actions(sections)
    subject, html = render((emp.first_name or "").strip(), today, sections,
                           daily._greeting(local_now), daily._logo_url(db), cfg)
    return sections, subject, html


def send_test(db: Session, emp: "models.NexusEmployee", cfg: dict, to: list) -> dict:
    """Send Test Digest (Sep 28): builds this person's real digest right now
    and mails it ONLY to `to`, whatever the mode, day or shift. Writes no log
    row, so it never stands in for (or blocks) their real weekly send."""
    local_now = daily._shift_local_now(daily._person_zone(db, emp.work_email, cfg))
    sections, subject, html = compose(db, emp, cfg, local_now.date(), local_now, actions=_only_for(emp, to))
    counts = {"overdueCount": len(sections.get(SECTION, [])), "teamCount": len(sections.get(TEAM_SECTION, []))}
    if not sections:
        return {"sent": False, **counts}
    graph_mail.send_mail(from_email=graph_mail.DEFAULT_FROM_EMAIL, to=to, cc=None,
                         subject=f"[TEST -> {emp.work_email}] {subject}", html=html)
    return {"sent": True, **counts}


def send_one(db: Session, emp: "models.NexusEmployee", cfg: dict, today: date, local_now: datetime) -> dict:
    """Builds, sends (per mode) and logs one person's digest. Commits."""
    mode = cfg.get("mode", "off")
    # In test mode the copy goes to the test recipients, who must not get
    # links that act as this person - unless the only recipient is them.
    actions = mode != "test" or _only_for(emp, list(cfg.get("test_recipients") or []))
    sections, subject, html = compose(db, emp, cfg, today, local_now, actions=actions)
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
                print(f"[weekly-digest] send failed for {emp.work_email}: {e}")
    db.add(models.NexusWeeklyDigestLog(
        id=str(uuid.uuid4()), employee_email=emp.work_email, week_start=week_start(today),
        sent_at=sent_at, mode=mode,
        overdue_count=len(sections.get(SECTION, [])), team_count=len(sections.get(TEAM_SECTION, [])),
        created_at=_now_iso()))
    db.commit()
    return {"sent": bool(sent_at), "mode": mode, "hadContent": bool(sections)}


def acquire_employee_lock(db: Session, email: str) -> None:
    """Per-employee transaction-scoped advisory lock, so two workers scanning
    at once cannot both send (see daily_briefing._acquire_employee_lock for
    why the CAST is required). No-op on SQLite."""
    if db.bind.dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(CAST(:ns AS integer), hashtext(:email))"),
                   {"ns": _DIGEST_LOCK_NS, "email": email})


def _scan_once() -> int:
    db = SessionLocal()
    sent = 0
    try:
        cfg = get_settings(db)
        employees = (db.query(models.NexusEmployee)
                     .filter(models.NexusEmployee.work_email != "").all())
        for emp in employees:
            # Active internal staff only - the same filter the Daily Briefing
            # applies to its no-shift sends, here for everyone.
            if not daily._no_shift_eligible(emp):
                continue
            try:
                acquire_employee_lock(db, emp.work_email)
                due, today, local_now = trigger_due(db, emp.work_email, cfg)
                if not due:
                    db.rollback()
                    continue
                send_one(db, emp, cfg, today, local_now)
                sent += 1
            except Exception as e:
                db.rollback()
                print(f"[weekly-digest] scan failed for {emp.work_email}: {e}")
        return sent
    finally:
        db.close()


async def weekly_digest_loop():
    await asyncio.sleep(90)
    while True:
        try:
            n = await asyncio.to_thread(_scan_once)
            if n:
                print(f"[weekly-digest] scan complete - {n} digest(s) logged")
        except Exception as e:
            print(f"[weekly-digest] loop error: {e}")
        await asyncio.sleep(SCAN_EVERY_SEC)
