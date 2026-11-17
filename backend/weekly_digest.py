"""Nexus Weekly Digest (Neil, Sep 28 2026) - separate from the Daily Briefing.

"These are the tasks you have overdue, along with their due dates." One email
per employee per week listing every open task assigned to them that is past
its due date, oldest first, each with its due date, how late it is and an
Extend Due Date button (routers/mail_actions.py do=extend, which applies the
app's own due-date rule - task_due.py). A manager also gets one line per
direct report who has overdue work.

Needs Your Attention (Sep 29, Sagar; was "Still to Do"): everything else still waiting on the person -
the Daily Briefing's own "Action Required" rows (daily_briefing._red_rows):
approvals, time off to decide, the time card, item handovers, tickets and
documents to sign - with the same one-click actions. The briefing's "Updates"
and "Completed" sections cover only the last day, so they stay daily-only. A
task already listed as overdue is not repeated. Nothing in any section = no
email.

Oct 5 (Neil, call of 10/01: "it needs to be all actions, not just the
tasks"): Needs Your Attention comes first and also carries shift requests and
timesheet fixes; the opening line counts what is waiting across modules; the
team table opens with a one-line total; Upcoming Time Off lists who on the
team - and the person's own manager - is off in the next two weeks.

Upcoming Holidays (Oct 29 2026, Sagar): the holidays on the person's own
company calendar for their country (holiday_policies.holidays_by_date - the
rule Time Sheets and the Workforce Scorecard read), this week and next, so a
Monday holiday is flagged the week before. Each says whether it is a Day Off,
a Half Day (New Year's Eve) or Optional. A week with a holiday is a reason
to send on its own.

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
import job_switch

_SETTINGS_KEY = "weekly_digest_config"
_DEFAULT_SETTINGS = {
    "mode": "off",              # off|test|live
    "test_recipients": [],
    "sendDay": 1,               # ISO weekday: 1 = Monday .. 7 = Sunday
    "leadMinutes": 120,         # before the shift starts (Neil: 2 hours)
    "includeNoShift": True,     # no shift that day -> send at defaultSendTime
    "defaultSendTime": "08:00",  # local 24h HH:MM
    "defaultTimeZone": "America/Los_Angeles",
    # The Daily Briefing's "decisions waiting" Outlook card on top of the
    # digest (Neil, Oct 26): Approve / Reject inside Outlook, and it refreshes
    # each time the email is opened, so a request decided since Monday drops
    # off instead of still offering Reject. Only on the person's own copy and
    # only where Actionable Messages are set up; other clients see the email.
    "outlookCard": True,
}
DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
SECTION = "overdue"            # the person's own overdue tasks
TEAM_SECTION = "team_overdue"  # manager: one line per direct report behind
PENDING_SECTION = "pending"    # everything else still waiting on them (daily "Action Required")
DUE_SECTION = "due_week"       # their open tasks due in the coming week (Oct 2)
TIME_OFF_SECTION = "time_off_ahead"   # who is off in the next two weeks (Oct 5)
HOLIDAY_SECTION = "holidays_ahead"    # company holidays this week and next (Oct 29 2026)
COMING_SECTION = "coming_up"          # the email's one section for the two above (Nov 15 2026)
# Actions first, then tasks (Neil, 10/01: "it needs to be all actions ... not
# just the tasks").
ORDER = [PENDING_SECTION, SECTION, DUE_SECTION, TEAM_SECTION, TIME_OFF_SECTION, HOLIDAY_SECTION]
EMAIL_ORDER = [PENDING_SECTION, SECTION, DUE_SECTION, TEAM_SECTION, COMING_SECTION]
TIME_OFF_DAYS = 14
HOLIDAY_WORDS = {"mandatory": "Day Off", "half_day": "Half Day", "optional": "Optional Holiday"}

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
    if "outlookCard" in out:
        out["outlookCard"] = bool(out["outlookCard"])
    if "sendDay" in out:
        v = out["sendDay"]
        if isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= 7:
            raise ValueError("Send day must be a weekday from 1 (Monday) to 7 (Sunday).")
    return out


def save_settings(db: Session, patch: dict, actor_email: str) -> dict:
    """Merge a PATCH into what is stored now, under the row lock
    (scoped_settings.merge_save) - two saves at once keep both changes."""
    import scoped_settings

    def build(stored: dict) -> dict:
        merged = json.loads(json.dumps(_DEFAULT_SETTINGS))
        merged.update(stored)
        merged.update(patch)
        return merged
    merged = scoped_settings.merge_save(db, _SETTINGS_KEY, build, actor_email)
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
        # On or after the send day (11/17/2026): a week whose Monday was a
        # holiday or a day off goes out on the next working day instead.
        if dd.isoweekday() < send_day(cfg):
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
    if today.isoweekday() < send_day(cfg) or daily._shift_start_for(db, email, today):
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
        late = (today - due).days
        project = f" - {projects[t.project_id]}" if projects.get(t.project_id or "") else ""
        detail = f"Due {due.strftime('%m/%d/%Y')} - {_plural(late, 'day')} overdue{project}"
        short = f"Due {due.strftime('%m/%d/%Y')}{project}"
        rows.append({
            # No task ID (Oct 1): the title is what a person recognizes, and
            # without a "ref" the table drops its ID column.
            "title": t.title, "detail": detail,
            # The email says how late in a red tag (Nov 15 2026).
            "overdue_days": late, "short_detail": short,
            "url": f"{app_url()}/tasks/mine?task={t.id}",
            "module": "tasks", "task_id": t.id, "action_email": email,
            # Extend Due Date (Neil) plus the usual Comment / React / Toggle
            # Completion / Open - see daily_briefing._row_actions_html.
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
            # The email: the name, an "N Overdue" tag and the tasks as a short
            # list rather than one run-on line (Nov 15 2026).
            "name": name, "lines": shown + ([f"and {len(hidden)} more"] if hidden else []),
            "url": f"{app_url()}/tasks/mine?task={items[0][1].id}", "module": "team",
            "overdue_count": len(items),
        })
    return rows, team


def pending_rows(db: Session, email: str, my_reports: dict, skip_task_ids: set) -> list:
    """The Daily Briefing's "Action Required" rows, today - built by the same
    function, so the two emails can never disagree about what is waiting.
    Tasks already in the Overdue section are left out."""
    return [r for r in daily._red_rows(db, email.lower(), my_reports)
            if not (r.get("task_id") and r["task_id"] in skip_task_ids)]


def holiday_rows(db: Session, email: str, today: date) -> list:
    """The holidays that apply to this person from `today` through the end of
    NEXT week (Sunday): their company's calendar, their country's rows, one
    answer per date (holiday_policies.holidays_by_date). Soonest first."""
    import holiday_policies
    emp = (db.query(models.NexusEmployee)
           .filter(func.lower(models.NexusEmployee.work_email) == (email or "").lower()).first())
    if not emp or not emp.company:
        return []
    this_monday = today - timedelta(days=today.weekday())
    next_sunday = this_monday + timedelta(days=13)
    rows = (db.query(models.HrCompanyHoliday)
            .filter(models.HrCompanyHoliday.company_id == emp.company,
                    models.HrCompanyHoliday.date >= today.isoformat(),
                    models.HrCompanyHoliday.date <= next_sunday.isoformat()).all())
    out = []
    country = holiday_policies.person_country(emp, holiday_policies.company_countries(db, [emp.company]).get(emp.company, ""))
    for d, h in holiday_policies.holidays_by_date(rows, country).items():
        try:
            day = date.fromisoformat(d)
        except ValueError:
            continue
        when = "This Week" if day < this_monday + timedelta(days=7) else "Next Week"
        out.append({"title": h.get("name") or "Holiday",
                    "detail": f"{day.strftime('%A')}, {day.strftime('%m/%d/%Y')} - "
                              f"{HOLIDAY_WORDS.get(h.get('type'), 'Day Off')} - {when}",
                    "url": "", "module": "holidays"})
    return out


def build_sections(db: Session, email: str, today: date) -> dict:
    my_reports = {(e.work_email or "").lower(): e for e in
                  db.query(models.NexusEmployee)
                  .filter(func.lower(models.NexusEmployee.manager_email) == email.lower()).all()
                  if e.work_email}
    own, team = overdue_rows(db, email, today, my_reports)
    # Due This Week (Oct 2): today through six days on - where a recurring
    # task's next date shows, now that a series keeps one open occurrence.
    due = daily.due_task_rows(db, email, today.isoformat(), (today + timedelta(days=6)).isoformat())
    pending = pending_rows(db, email, my_reports, {r["task_id"] for r in own + due})
    daily.stamp_waiting(pending, today.isoformat())
    # Upcoming Time Off (Neil, 10/01): a manager sees which reports are off,
    # and everyone sees when their own manager is - two weeks ahead, so
    # "people are not guessing".
    off = daily.upcoming_time_off_rows(db, email, my_reports, today.isoformat(),
                                       (today + timedelta(days=TIME_OFF_DAYS - 1)).isoformat())
    holidays = holiday_rows(db, email, today)
    return {k: v for k, v in ((PENDING_SECTION, pending), (SECTION, own), (DUE_SECTION, due),
                              (TEAM_SECTION, team), (TIME_OFF_SECTION, off), (HOLIDAY_SECTION, holidays)) if v}


def _intro(sections: dict) -> str:
    """What the week holds, in one short line (Nov 15 2026; it used to list
    every section in one 50-word sentence, which the tiles under it already
    say). Across every module, not only tasks (Neil, 10/01: "the paragraph at
    the top should not be limited to the task")."""
    parts = []
    if sections.get(PENDING_SECTION):
        parts.append(f"{len(sections[PENDING_SECTION])} need{'s' if len(sections[PENDING_SECTION]) == 1 else ''} "
                     "your attention")
    if sections.get(SECTION):
        n = len(sections[SECTION])
        parts.append(f"{_plural(n, 'task')} {'is' if n == 1 else 'are'} overdue")
    if sections.get(DUE_SECTION):
        n = len(sections[DUE_SECTION])
        parts.append(f"{n} {'is' if n == 1 else 'are'} due this week")
    if not parts:
        return "Here is your week in Nexus."
    return "Here is your week: " + (parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]) + "."


def _subject(sections: dict, week_of: str) -> str:
    """The inbox line says what is waiting (Nov 15 2026)."""
    bits = []
    if sections.get(PENDING_SECTION):
        n = len(sections[PENDING_SECTION])
        bits.append(f"{n} Need{'s' if n == 1 else ''} Your Attention")
    if sections.get(SECTION):
        bits.append(f"{len(sections[SECTION])} Overdue")
    return f"Weekly Briefing - {', '.join(bits) or 'Your Week'} - {week_of}"


def _preheader(sections: dict) -> str:
    """The inbox preview line: the opening line's counts, then the first
    holiday coming up."""
    line = _intro(sections)
    line = line[len("Here is your week: "):] if line.startswith("Here is your week: ") else ""
    hol = sections.get(HOLIDAY_SECTION) or []
    if hol:
        day = (hol[0].get("detail") or "").split(",")[0]
        when = "next week" if "Next Week" in (hol[0].get("detail") or "") else "this week"
        line = (line + " " if line else "") + f"{hol[0]['title']} is {day} {when}."
    if not line and sections.get(TEAM_SECTION):
        line = _team_note(sections)
    return (line[:1].upper() + line[1:]) if line else "Your week in Nexus."


def _for_email(sections: dict) -> dict:
    """The sections as the email draws them: Due This Week under a heading
    per day, Upcoming Time Off and Upcoming Holidays together as Coming Up
    (Nov 15 2026). build_sections keeps its keys - the counts, the log and
    the card read them."""
    out = dict(sections)
    if out.get(DUE_SECTION):
        days = []
        for r in out[DUE_SECTION]:
            try:
                d = date.fromisoformat(r.get("due_on") or "")
                days.append(dict(r, group=f"{d.strftime('%A')}, {d.strftime('%m/%d/%Y')}"))
            except ValueError:
                days.append(dict(r, group="Later"))
        out[DUE_SECTION] = days
    coming = ([dict(r, group="Time Off") for r in out.pop(TIME_OFF_SECTION, [])] +
              [dict(r, group="Holidays") for r in out.pop(HOLIDAY_SECTION, [])])
    if coming:
        out[COMING_SECTION] = coming
    return out


def _team_note(sections: dict) -> str:
    """One line over Your Team's Overdue Work (Neil, 10/01: "666 people under
    you and each of them has 10 to 15 tasks that are overdue"): the whole
    picture in numbers, then the people furthest behind first. The table
    itself is capped like every other one."""
    team = sections.get(TEAM_SECTION) or []
    if not team:
        return ""
    total = sum(r.get("overdue_count") or 0 for r in team)
    who = f"{len(team)} team member{'' if len(team) == 1 else 's'}"
    if len(team) == 1:
        return f"{who} has {_plural(total, 'overdue task')}."
    return f"{who} have {_plural(total, 'overdue task')} between them, furthest behind first."


def render(first_name: str, today: date, sections: dict, greeting: str, logo_url: str, cfg: dict,
           recap: list = None, today_text: str = "") -> tuple:
    week_of = f"Week of {datetime.strptime(week_start(today), '%Y-%m-%d').strftime('%m/%d/%Y')}"
    footer = (f"You receive the Weekly Briefing every {DAY_NAMES[send_day(cfg) - 1]}, before your shift "
              "starts. It lists everything waiting on you across Nexus, who on your team is off and the "
              "holidays coming up.")
    return daily.render_email(first_name, today.isoformat(), _for_email(sections), greeting=greeting,
                              logo_url=logo_url, title="Weekly Briefing", date_label=week_of,
                              intro=_intro(sections), subject=_subject(sections, week_of),
                              preheader=_preheader(sections), footer=footer, order=EMAIL_ORDER,
                              recap=recap, today_line=today_text,
                              cta_label="Open My Briefing", cta_path="/briefing",
                              notes={TEAM_SECTION: _team_note(sections)}, stop_kind="weekly_digest")


# ── Last Week (Neil, 11/17/2026) ─────────────────────────────────────────
# A few plain lines at the foot of the Weekly Briefing: what you finished and
# the hours on your Time Sheet, and for a manager what the team finished and
# whether its overdue work went up or down. Counts only - a zero or a number
# that could not be read is left out, never shown as 0.

def _worked_minutes(db: Session, email: str, start: date) -> int:
    """Worked minutes on the person's own punches over the 7 days from `start`
    (the Time Sheet's own day totals; Sick / PTO leave punches are not work)."""
    from routers.timeclock import _day_summaries
    from workforce_scorecard import _split_leave
    end = start + timedelta(days=7)
    punches = (db.query(models.TimePunch)
               .filter(func.lower(models.TimePunch.employee_email) == email.lower(), models.TimePunch.voided == 0,
                       models.TimePunch.local_date >= (start - timedelta(days=1)).isoformat(),
                       models.TimePunch.local_date <= end.isoformat())
               .order_by(models.TimePunch.at).all())
    worked, _leave = _split_leave(punches)
    days = _day_summaries(worked, 0, None) if worked else {}
    return sum(int((v or {}).get("workedMin") or 0) for iso, v in days.items()
               if start.isoformat() <= iso < end.isoformat())


def _done_tasks(db: Session, first: str, before: str) -> list:
    return (db.query(models.Task)
            .filter(models.Task.completed == True,  # noqa: E712
                    models.Task.completed_at >= first, models.Task.completed_at < before,
                    models.Task.type != "section",
                    (models.Task.deleted_at == "") | (models.Task.deleted_at.is_(None))).all())


def _joined(parts: list) -> str:
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]


def last_week_lines(db: Session, email: str, today: date) -> list:
    """['You finished 14 tasks, resolved 6 tickets and worked 41h 20m.',
        'Your team finished 63 tasks. 7 are overdue, down from 12 the week before.']"""
    email = (email or "").lower()
    this_monday = date.fromisoformat(week_start(today))
    first, before = (this_monday - timedelta(days=7)).isoformat(), this_monday.isoformat()
    lines = []
    try:
        done = _done_tasks(db, first, before)
        mine = sum(1 for t in done if email in set(task_assignees(t)))
        tickets = (db.query(func.count(models.TaskTicket.id))
                   .filter(func.lower(models.TaskTicket.assignee_email) == email,
                           models.TaskTicket.resolved_at >= first, models.TaskTicket.resolved_at < before).scalar() or 0)
        minutes = _worked_minutes(db, email, this_monday - timedelta(days=7))
        parts = ([f"finished {_plural(mine, 'task')}"] if mine else []) + \
                ([f"resolved {_plural(tickets, 'ticket')}"] if tickets else []) + \
                ([f"worked {minutes // 60}h {minutes % 60:02d}m"] if minutes else [])
        if parts:
            lines.append(f"You {_joined(parts)}.")
        reports = {(e.work_email or "").lower() for e in db.query(models.NexusEmployee)
                   .filter(func.lower(models.NexusEmployee.manager_email) == email).all() if e.work_email} - {email}
        if reports:
            team_done = sum(1 for t in done if set(task_assignees(t)) & reports)
            then = (today - timedelta(days=7)).isoformat()
            now_iso = today.isoformat()
            open_now = then_n = 0
            for t in (db.query(models.Task)
                      .filter(models.Task.due_on != "", models.Task.due_on < now_iso,
                              models.Task.type != "section",
                              (models.Task.deleted_at == "") | (models.Task.deleted_at.is_(None))).all()):
                if not set(task_assignees(t)) & reports:
                    continue
                due = (t.due_on or "")[:10]
                if not t.completed:
                    open_now += 1
                if due < then and (not t.completed or (t.completed_at or "") >= then):
                    then_n += 1
            team = f"Your team finished {_plural(team_done, 'task')}." if team_done else ""
            if open_now or then_n:
                trend = ("down from" if open_now < then_n else "up from" if open_now > then_n else "the same as")
                tail = (f" {open_now} {'is' if open_now == 1 else 'are'} overdue, "
                        + (f"{trend} {then_n} the week before." if trend != "the same as" else "the same as the week before."))
                team = (team + tail).strip()
            if team:
                lines.append(team)
    except Exception as e:   # a recap never costs the email
        print(f"[weekly-briefing] last week failed for {email}: {e}")
    return lines


# ── One email on Monday (Neil, 11/17/2026) ────────────────────────────────
# The first Daily Briefing of the week on or after the send day carries the
# week's sections and stands in for the separate Weekly Briefing, which then
# skips the week (its log row is written by log_combined). Both must be in the
# same mode (live / test); someone who stopped the weekly email, or who gets
# no Daily Briefing, still gets the separate one as before.

def combine_into_daily(db: Session, emp: "models.NexusEmployee", today: date, daily_mode: str):
    try:
        cfg = get_settings(db)
        mode = cfg.get("mode", "off")
        if mode == "off" or mode != daily_mode or today.isoweekday() < send_day(cfg):
            return None
        if _already_logged(db, emp.work_email, week_start(today)):
            return None
        if mode == "live":
            import email_optout
            if email_optout.is_out(db, emp.work_email, "weekly_digest"):
                return None
        return {"sections": build_sections(db, emp.work_email, today),
                "recap": last_week_lines(db, emp.work_email, today), "cfg": cfg}
    except Exception as e:   # the daily still goes out on its own
        print(f"[weekly-briefing] combine failed for {emp.work_email}: {e}")
        return None


def combined(daily_sections: dict, week: dict, briefing_date: str, extra: dict) -> tuple:
    """(sections, render_email keywords) for the Monday email: the day's
    Action Required, then Overdue, Due This Week (minus what is due today and
    already listed), Updates, Your Team, Coming Up, Completed and Last Week."""
    w = week["sections"]
    action = daily_sections.get("action_required") or []
    listed = {r.get("task_id") for r in action if r.get("task_id")}
    wk = {k: v for k, v in w.items() if k != PENDING_SECTION}
    wk[DUE_SECTION] = [r for r in w.get(DUE_SECTION, []) if r.get("task_id") not in listed]
    shown = _for_email({k: v for k, v in wk.items() if v})
    sections = {"action_required": action, SECTION: shown.get(SECTION), DUE_SECTION: shown.get(DUE_SECTION),
                "needs_to_know": daily_sections.get("needs_to_know"), TEAM_SECTION: shown.get(TEAM_SECTION),
                COMING_SECTION: shown.get(COMING_SECTION), "completed": daily_sections.get("completed")}
    sections = {k: v for k, v in sections.items() if v}
    d = date.fromisoformat(briefing_date)
    label = f"{d.strftime('%A')}, {d.strftime('%m/%d/%Y')}"
    n, over = len(action), len(sections.get(SECTION) or [])
    bits = ([f"{n} Need{'s' if n == 1 else ''} Your Action"] if n else []) + ([f"{over} Overdue"] if over else [])
    pre = daily.daily_preheader(sections).rstrip(".")
    if pre == "Nothing new since your last briefing":
        pre = ""
    more = ([f"{over} overdue"] if over else []) + \
           ([f"{len(sections[DUE_SECTION])} due this week"] if sections.get(DUE_SECTION) else [])
    pre = ", ".join([p for p in (pre, ", ".join(more)) if p])
    hol = w.get(HOLIDAY_SECTION) or []
    if hol:
        day = (hol[0].get("detail") or "").split(",")[0]
        pre = (pre + ". " if pre else "") + f"{hol[0]['title']} is {day}"
    cfg = week.get("cfg") or {}
    footer = (f"You receive one briefing a day before your shift. On {DAY_NAMES[send_day(cfg) - 1]}s it is the "
              "Weekly Briefing: the day plus your week - overdue work, what is due, who is off and the holidays.")
    return sections, {**extra, "title": "Weekly Briefing",
                      "subject": f"Weekly Briefing - {', '.join(bits) or 'All Caught Up'} - {label}",
                      "preheader": (pre[:1].upper() + pre[1:] + ".") if pre else None,
                      "order": ["action_required", SECTION, DUE_SECTION, "needs_to_know", TEAM_SECTION,
                                COMING_SECTION, "completed"],
                      "footer": footer, "notes": {TEAM_SECTION: _team_note(w)}, "recap": week.get("recap")}


def log_combined(db: Session, emp: "models.NexusEmployee", today: date, mode: str, week: dict, sent_at: str) -> None:
    """The week's row, so the separate Weekly Briefing skips it. Committed with
    the daily's own log row."""
    w = week.get("sections") or {}
    db.add(models.NexusWeeklyDigestLog(
        id=str(uuid.uuid4()), employee_email=emp.work_email, week_start=week_start(today), sent_at=sent_at,
        mode=mode, overdue_count=len(w.get(SECTION, [])), team_count=len(w.get(TEAM_SECTION, [])),
        created_at=_now_iso()))


# ── Outlook card ──────────────────────────────────────────────────────────

def card(sections: dict, email: str, today: date, outcome: str = "", always: bool = False):
    """The quick "decisions waiting" card for the digest's Needs Your
    Attention rows (briefing_card.build_quick_card, variant "weekly" so a
    click or a refresh redraws this card from the digest's own rows). None
    when nothing waits on a decision."""
    import briefing_card
    import briefing_mail_actions
    return briefing_card.build_quick_card(
        action_rows=sections.get(PENDING_SECTION) or [], briefing_date=today.isoformat(), since_iso="",
        outcome=outcome, briefing_url=f"{app_url()}/briefing", variant="weekly", always=always,
        refresh_token=briefing_mail_actions.refresh_token(email))


def _with_card(html: str, sections: dict, email: str, today: date, cfg: dict) -> str:
    import task_mail_actions
    if not cfg.get("outlookCard", True) or not task_mail_actions.am_enabled():
        return html
    c = card(sections, email, today)
    return daily.with_card(html, c) if c else html


# ── Send + scan ─────────────────────────────────────────────────────────

def _without_actions(sections: dict) -> dict:
    """The same rows minus Extend / Comment / React / Toggle Completion -
    those links act AS the employee, so a copy read by someone else
    (a test recipient) must not carry them. Open stays. The Daily
    Briefing applies the same rule to its Outlook card in test mode."""
    drop = ("task_id", "task_open", "task_done", "task_extend", "action_email", "action_kind", "action_id")

    def strip(r):
        out = {f: v for f, v in r.items() if f not in drop}
        if r.get("sub_actions"):   # a bundled time-off card: keep the dates, drop Approve / Reject
            out["sub_actions"] = [{"detail": s.get("detail", "")} for s in r["sub_actions"]]
        return out
    return {k: [strip(r) for r in rows] for k, rows in sections.items()}


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
                           daily._greeting(local_now), daily._logo_url(db), cfg,
                           recap=last_week_lines(db, emp.work_email, today),
                           today_text=daily.today_line_for(db, emp.work_email, today.isoformat()))
    if actions:
        # Its buttons act as this person, so only their own copy gets one.
        html = _with_card(html, sections, emp.work_email, today, cfg)
    return sections, subject, html


def send_test(db: Session, emp: "models.NexusEmployee", cfg: dict, to: list) -> dict:
    """Send Test Digest (Sep 28): builds this person's real digest right now
    and mails it ONLY to `to`, whatever the mode, day or shift. Writes no log
    row, so it never stands in for (or blocks) their real weekly send."""
    local_now = daily._shift_local_now(daily._person_zone(db, emp.work_email, cfg))
    sections, subject, html = compose(db, emp, cfg, local_now.date(), local_now, actions=_only_for(emp, to))
    counts = {"overdueCount": len(sections.get(SECTION, [])), "teamCount": len(sections.get(TEAM_SECTION, [])),
              "pendingCount": len(sections.get(PENDING_SECTION, []))}
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
    # Stopped from the email's own link or Profile (email_optout.py).
    import email_optout
    if mode == "live" and email_optout.is_out(db, emp.work_email, "weekly_digest"):
        sections = {}
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
    if job_switch.off("weekly_digest"):   # Workflows > Automations switch
        return 0
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
                if daily.skip_reason(db, emp, today.isoformat()):
                    db.rollback()   # no row: the week goes out on the next working day
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
