"""Shift notifications (Sep 28 2026 - Shifts QA gap list, item 2).

Nexus Shifts never told anyone anything: a manager could publish, change or
remove someone's shift and the person only found out by opening the schedule.
Teams Shifts tells the people affected. Two pieces:

  Schedule published (notify_published, called from
  routers/timeclock.publish_schedule): everyone whose shifts were added,
  changed or removed by that publish gets ONE bell notification and ONE email
  listing exactly their changes - never one per shift, never the whole team,
  and never the person who pressed Publish. The emails go out after the
  response (BackgroundTasks), so publishing a big team stays fast.

  Shift reminder (shift_reminder_loop): a bell notification REMINDER_LEAD_MIN
  before a shift placed on the schedule starts, in the shift's own time zone.
  Only placed (published) shifts - a default preset repeats every workday, and
  a daily ping about the same 9 AM start is noise. Skipped when the person is
  already clocked in, on approved time off, or on a company holiday that day.
  One per shift (NexusNotification.ref_id is the dedupe key). Bell only: an
  email before every shift is more than anyone asked for.
"""
import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from html import escape

from sqlalchemy.orm import Session

import models
from app_url import app_url
from database import SessionLocal

REMINDER_LEAD_MIN = 60   # default; admins change it in the Requests inbox settings
REMINDER_SCAN_SEC = 5 * 60
_DEFAULT_TZ = "America/Los_Angeles"
# My Shifts lives in the Shifts module now (Sep 29), not a Workday tab.
MY_SHIFTS_ACTION = {"view": "shifts", "sub": "mine"}


def _t12(hhmm: str) -> str:
    try:
        h, m = (int(x) for x in (hhmm or "")[:5].split(":"))
    except ValueError:
        return hhmm or ""
    return f"{(h % 12) or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"


def _day(iso: str) -> str:
    try:
        d = datetime.strptime(iso[:10], "%Y-%m-%d")
    except ValueError:
        return iso or ""
    return f"{d.strftime('%a')}, {d.strftime('%m/%d/%Y')}"


def _us(iso: str) -> str:
    try:
        return datetime.strptime(iso[:10], "%Y-%m-%d").strftime("%m/%d/%Y")
    except ValueError:
        return iso or ""


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


# ── Schedule published ────────────────────────────────────────────────────

def change(kind: str, row, *, start: str, end: str, label: str, was: tuple = None) -> dict:
    """One line of what a publish did to a person's schedule. `kind` is
    added | changed | removed; `was` = (start, end, label) before a change."""
    return {"kind": kind, "email": (row.employee_email or "").lower(), "date": row.work_date,
            "start": start, "end": end, "label": label or "", "was": was}


def _summary(items: list) -> str:
    counts = {k: sum(1 for i in items if i["kind"] == k) for k in ("added", "changed", "removed")}
    bits = []
    if counts["added"]:
        bits.append(f"{counts['added']} new")
    if counts["changed"]:
        bits.append(f"{counts['changed']} changed")
    if counts["removed"]:
        bits.append(f"{counts['removed']} removed")
    return ", ".join(bits)


def _row_html(i: dict) -> str:
    shift = f"{_t12(i['start'])} - {_t12(i['end'])}" + (f" &middot; {escape(i['label'])}" if i["label"] else "")
    if i["kind"] == "added":
        what = "<span style='color:#15803d;font-weight:600'>New</span>"
    elif i["kind"] == "removed":
        what = "<span style='color:#b91c1c;font-weight:600'>Removed</span>"
        shift = f"<span style='text-decoration:line-through;color:#6b7280'>{shift}</span>"
    else:
        ws, we, wl = i["was"] or ("", "", "")
        before = f"{_t12(ws)} - {_t12(we)}" + (f" &middot; {escape(wl)}" if wl else "")
        what = f"<span style='color:#b45309;font-weight:600'>Changed</span><br><span style='color:#6b7280;font-size:12px'>was {before}</span>"
    td = "padding:10px 12px;border-top:1px solid #e5e7eb;font-size:13.5px;vertical-align:top"
    return (f"<tr><td style='{td};white-space:nowrap;font-weight:600'>{escape(_day(i['date']))}</td>"
            f"<td style='{td}'>{shift}</td><td style='{td}'>{what}</td></tr>")


def email_html(first_name: str, items: list, actor_name: str) -> tuple:
    """(subject, html) for one person's published changes. Uses the saved
    email theme (header color/logo/footer) like every other Nexus email."""
    import email_theme
    theme = email_theme.current()
    items = sorted(items, key=lambda i: (i["date"], i["start"]))
    n = len(items)
    subject = f"Your schedule was updated - {_plural(n, 'change')}"
    band = theme.color("#0f3d2e")
    url = f"{app_url()}/shifts/mine"
    hello = f"Hi {escape(first_name)}," if first_name else "Hi,"
    who = escape(actor_name) if actor_name else "Your manager"
    rows = "".join(_row_html(i) for i in items)
    th = "padding:8px 12px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#374151;text-align:left;background:#f9fafb"
    html = f"""<div style="background:#f3f4f6;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-collapse:collapse">
    <tr><td style="background:{band};padding:16px 28px">{theme.logo_block()}</td></tr>
    <tr><td style="padding:24px 28px 0">
      <div style="font-size:20px;font-weight:600;color:#111827">Your Schedule Was Updated</div>
      <div style="font-size:14px;line-height:1.55;color:#374151;margin-top:8px">{hello} {who} published {_plural(n, 'change')} to your shifts.</div>
    </td></tr>
    <tr><td style="padding:18px 28px 0">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-collapse:collapse">
        <tr><th style="{th}">Date</th><th style="{th}">Shift</th><th style="{th}">Change</th></tr>{rows}
      </table>
    </td></tr>
    <tr><td style="padding:24px 28px 28px">
      <a href="{escape(url)}" style="display:inline-block;padding:10px 22px;border-radius:4px;background:{band};color:#ffffff;text-decoration:none;font-weight:600;font-size:13px">Open My Shifts</a>
    </td></tr>
    <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-size:11.5px;line-height:1.6;color:#6b7280">
      You get this email when a manager publishes a change to your shifts in Nexus.{theme.footer_lines()}
    </td></tr>
  </table>
</div>"""
    return subject, html


def _send_emails(batch: list) -> None:
    """Runs after the publish response (BackgroundTasks). One failure never
    stops the rest; the bell notification is already there either way."""
    import graph_mail
    for to, subject, html in batch:
        try:
            graph_mail.send_mail(from_email=graph_mail.DEFAULT_FROM_EMAIL, to=[to], cc=None,
                                 subject=subject, html=html)
        except Exception as e:   # noqa: BLE001 - never fail the batch for one address
            print(f"[shift-notify] schedule email to {to} failed: {e}")


def _upsert_bell(db: Session, recipient: str, ref_id: str, title: str, body: str, actor: str, now: str) -> None:
    """ONE notification per (person, ref_id), updated in place (Oct 2, B4-33:
    five publishes of a week were five bells and five emails). An unread,
    un-actioned row for the same key is refreshed - new text, back to the
    top, unread again; a row the person already dealt with stays as history
    and a new one is added."""
    row = (db.query(models.NexusNotification)
           .filter(models.NexusNotification.recipient == recipient, models.NexusNotification.ref_id == ref_id,
                   models.NexusNotification.actioned == False)   # noqa: E712 - SQLAlchemy expression
           .order_by(models.NexusNotification.created_at.desc()).first())
    if row is not None:
        row.title, row.body, row.requested_by, row.created_at, row.read_by = title, body, actor, now, ""
        return
    db.add(models.NexusNotification(
        id=str(uuid.uuid4()), type="custom_alert", recipient=recipient, title=title, body=body,
        ref_id=ref_id, item_name="", requested_by=actor,
        action='{"view": "shifts", "sub": "mine"}', actioned=False, read_by="", created_at=now))


def notify_published(db: Session, changes: list, actor_email: str, d0: str, d1: str, bt=None) -> int:
    """One bell + one email per affected person. Returns how many people were
    notified. Commits the bell rows; emails are queued on `bt` when given.
    The bell is one row per (person, date range), updated in place."""
    actor = (actor_email or "").lower()
    by_person: dict = {}
    for c in changes:
        if c["email"] and c["email"] != actor:
            by_person.setdefault(c["email"], []).append(c)
    if not by_person:
        return 0
    people = {(e.work_email or "").lower(): e for e in
              db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email != "").all()}
    actor_emp = people.get(actor)
    actor_name = f"{actor_emp.first_name or ''} {actor_emp.last_name or ''}".strip() if actor_emp else ""
    now = datetime.now(timezone.utc).isoformat()
    batch = []
    for em, items in by_person.items():
        dates = sorted(i["date"] for i in items)
        span = _us(dates[0]) if dates[0] == dates[-1] else f"{_us(dates[0])} - {_us(dates[-1])}"
        _upsert_bell(db, em, f"schedule-publish:{d0}:{d1}", "Your schedule was updated",
                     f"{_summary(items).capitalize()} ({span}).", actor, now)
        emp = people.get(em)
        if emp is not None and (emp.status or "active") == "active":
            batch.append((em, *email_html((emp.first_name or "").strip(), items, actor_name)))
    db.commit()
    if batch and bt is not None:
        import graph_mail
        if graph_mail.graph_configured():
            bt.add_task(_send_emails, batch)
    return len(by_person)


def notify_team(db: Session, emails: set, actor_email: str, d0: str, d1: str) -> int:
    """Publish with "notify the whole team" (Sep 29, Teams parity): everyone
    else with a shift in the published range gets one short bell - their own
    schedule did not change, so no email. Commits; returns how many."""
    actor = (actor_email or "").lower()
    span = _us(d0) if d0 == d1 else f"{_us(d0)} - {_us(d1)}"
    now = datetime.now(timezone.utc).isoformat()
    n = 0
    for em in sorted(e for e in emails if e and e != actor):
        _upsert_bell(db, em, f"schedule-publish-team:{d0}:{d1}", "Schedule published",
                     f"The schedule for {span} was published. Open My Shifts to see yours.", actor, now)
        n += 1
    db.commit()
    return n


# ── Shift reminder ────────────────────────────────────────────────────────

def _local_now(tz: str) -> datetime:
    from routers.timeclock import _shift_local_now
    return _shift_local_now(tz)


def _reminder_key(row) -> str:
    """One reminder per shift AND start: a shift whose start moved at the
    next publish is reminded again at its new time (Oct 2, B2-16)."""
    return f"shift-reminder:{row.id}:{row.work_date}T{(row.start_hhmm or '')[:5]}"


def _clocked_in_set(db: Session, emails: set) -> set:
    """Who is clocked in right now, from ONE read of everyone's last punch
    (routers.timeclock._clocked_in is one query per person)."""
    if not emails:
        return set()
    last = {}
    for p in (db.query(models.TimePunch)
              .filter(models.TimePunch.employee_email.in_(list(emails)), models.TimePunch.voided == 0)
              .order_by(models.TimePunch.at).all()):
        last[(p.employee_email or "").lower()] = p.kind
    return {em for em, kind in last.items() if kind != "out"}


def reminder_scan_once(db: Session) -> int:
    """Bell every person whose placed, published shift starts within the next
    REMINDER_LEAD_MIN minutes in its own zone. Returns how many were sent.
    Clocked-in, time off and holidays are read once per scan, not three
    queries per candidate (Oct 2, B4-35)."""
    from routers.timeclock import _company_holidays_for_many, _shift_tz
    from routers.shift_requests import get_settings as _settings
    cfg = _settings(db)
    if not cfg.get("reminders", True):
        return 0
    lead = int(cfg.get("reminderLeadMinutes") or REMINDER_LEAD_MIN)
    utc_today = datetime.now(timezone.utc).date()
    lo, hi = (utc_today - timedelta(days=1)).isoformat(), (utc_today + timedelta(days=1)).isoformat()
    rows = (db.query(models.ScheduledShift)
            .filter(models.ScheduledShift.published == 1, models.ScheduledShift.employee_email != "",
                    models.ScheduledShift.pending_delete == 0,   # being removed: no reminder
                    models.ScheduledShift.work_date >= lo, models.ScheduledShift.work_date <= hi).all())
    if not rows:
        return 0
    presets = {s.id: s for s in db.query(models.Shift).all()}
    people = {(e.work_email or "").lower(): e for e in db.query(models.NexusEmployee).all()
              if e.work_email and (e.status or "active") == "active" and not (e.deleted_at or "")}
    team_tz = cfg.get("timeZone") or _DEFAULT_TZ
    # Which of these shifts are due, before any of the per-person reads.
    due = []
    for r in rows:
        em = (r.employee_email or "").lower()
        if em not in people:
            continue
        tz = _shift_tz(r, presets.get(r.shift_id), team_tz)
        try:
            start = datetime.strptime(f"{r.work_date} {(r.start_hhmm or '09:00')[:5]}", "%Y-%m-%d %H:%M")
        except ValueError:
            continue
        now = _local_now(tz)
        if start - timedelta(minutes=lead) <= now < start:
            due.append((r, em, start, now))
    if not due:
        return 0
    emails = {em for _, em, _, _ in due}
    keys = {_reminder_key(r) for r, _, _, _ in due}
    already = {k for (k,) in db.query(models.NexusNotification.ref_id)
               .filter(models.NexusNotification.ref_id.in_(list(keys))).all()}
    clocked_in = _clocked_in_set(db, emails)
    off = {}
    for t in (db.query(models.TimeOffRequest)
              .filter(models.TimeOffRequest.employee_email.in_(list(emails)),
                      models.TimeOffRequest.status == "approved",
                      models.TimeOffRequest.start_date <= hi, models.TimeOffRequest.end_date >= lo).all()):
        off.setdefault((t.employee_email or "").lower(), []).append((t.start_date, t.end_date))
    holidays = _company_holidays_for_many(db, {em: people[em] for em in emails}, lo, hi)
    sent = 0
    for r, em, start, now in due:
        key = _reminder_key(r)
        if key in already or em in clocked_in:
            continue
        if any(a <= r.work_date <= b for a, b in off.get(em, [])) or r.work_date in holidays.get(em, {}):
            continue
        when = "Today" if start.date() == now.date() else "Tomorrow"
        detail = f"{when}, {_us(r.work_date)} · {_t12(r.start_hhmm)} - {_t12(r.end_hhmm)}"
        if r.label:
            detail += f" · {r.label}"
        db.add(models.NexusNotification(
            id=str(uuid.uuid4()), type="custom_alert", recipient=em,
            title=f"Your shift starts at {_t12(r.start_hhmm)}", body=detail + ".",
            ref_id=key, item_name="", requested_by="",
            action='{"view": "timeclock", "sub": "clock"}', actioned=False, read_by="",
            created_at=datetime.now(timezone.utc).isoformat()))
        already.add(key)
        sent += 1
    if sent:
        db.commit()
    return sent


def _reminder_tick() -> int:
    db = SessionLocal()
    try:
        return reminder_scan_once(db)
    except Exception as e:   # noqa: BLE001 - a bad row must not kill the loop
        db.rollback()
        print(f"[shift-notify] reminder scan failed: {e}")
        return 0
    finally:
        db.close()


async def shift_reminder_loop():
    """Started from main.py's lifespan on the elected leader. The scan is
    synchronous DB work, so it runs in a thread (CLAUDE.md: never block the
    event loop)."""
    await asyncio.sleep(120)
    while True:
        n = await asyncio.to_thread(_reminder_tick)
        if n:
            print(f"[shift-notify] {n} shift reminder(s) sent")
        await asyncio.sleep(REMINDER_SCAN_SEC)
