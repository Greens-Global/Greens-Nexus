"""Long-session watch - nudges people who look like they forgot to punch out.

Every 30 minutes: find employees whose open session (last non-voided punch is
in / break_start / break_end) started more than LONG_SESSION_HOURS ago and nudge
them - a bell notification plus a best-effort email - repeating every
RENOTIFY_HOURS while the session stays open. Dedupe is DB-backed (the bell row
itself, keyed on the session's in-punch id), so restarts never double-send.

Lives in its own module (not reminders.py) so the daily HR scan and this
half-hourly loop can evolve independently.
"""
import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone

import graph_mail
from database import SessionLocal
from models import NexusEmployee, NexusNotification, TimePunch

LONG_SESSION_HOURS = 12   # the cap agreed Jul 27 - nudge past this
RENOTIFY_HOURS = 12       # re-nudge cadence while the session stays open
CHECK_EVERY_SEC = 30 * 60
NOTIF_TYPE = "timeclock_long_session"
MGR_NOTIF_TYPE = "timeclock_long_session_mgr"   # the SAME event, sent to the manager
# Loop the manager in only once the session is clearly a forgotten punch, not just
# a long shift - matches the payroll guard (a shift past this is dropped from pay).
MGR_ALERT_HOURS = 16


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def _parse(s: str):
    try:
        return datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _open_sessions(db):
    """[(email, in_punch)] for every employee whose newest punch isn't an out.
    Scans a 14-day window - anything older is a data problem, not a live shift."""
    floor = _iso(_now() - timedelta(days=14))
    rows = (db.query(TimePunch)
            .filter(TimePunch.voided == 0, TimePunch.at >= floor)
            .order_by(TimePunch.at).all())
    latest, session_in = {}, {}
    for p in rows:
        latest[p.employee_email] = p
        if p.kind == "in":
            session_in[p.employee_email] = p
    return [(email, session_in.get(email) or p)
            for email, p in latest.items() if p.kind != "out"]


def _already_nudged(db, punch_id: str, ntype: str = NOTIF_TYPE) -> bool:
    cutoff = _iso(_now() - timedelta(hours=RENOTIFY_HOURS))
    return (db.query(NexusNotification)
            .filter(NexusNotification.type == ntype,
                    NexusNotification.ref_id == punch_id,
                    NexusNotification.created_at >= cutoff)
            .first()) is not None


def _notify_manager(db, emp, hours: int, punch_id: str):
    """Loop the employee's manager in once a session crosses MGR_ALERT_HOURS - the
    SwipeClock model surfaces a missing punch to the supervisor, not just the
    employee. Deduped on its own type so it re-sends at the same cadence."""
    mgr = ((emp.manager_email if emp else "") or "").strip().lower()
    if not mgr or _already_nudged(db, punch_id, MGR_NOTIF_TYPE):
        return
    who = (f"{(emp.first_name or '').strip()} {(emp.last_name or '').strip()}".strip()
           or (emp.work_email if emp else "An employee"))
    db.add(NexusNotification(
        id=str(uuid.uuid4()), type=MGR_NOTIF_TYPE, recipient=mgr,
        title=f"{who} has been clocked in {hours} hours - likely a missed punch-out",
        body=(f"{who}'s time clock has run {hours}+ hours with no clock-out. Hours past "
              f"{LONG_SESSION_HOURS}h are held off the timesheet until fixed. Open their "
              "timesheet and add the real clock-out, or ask them to."),
        ref_id=punch_id, action=json.dumps({"view": "timeclock", "sub": "timesheet"}),
        created_at=_iso(_now())))
    db.commit()


def _email(db, email: str, hours: int):
    """Best-effort - a mail failure must never stop the bell notification."""
    try:
        from_email = (graph_mail.DEFAULT_FROM_EMAIL or "").strip()
        if not from_email:
            return
        emp = db.query(NexusEmployee).filter(NexusEmployee.work_email == email).first()
        first = ((emp.first_name if emp else "") or "there").strip()
        html = (
            f"<p>Hi {first},</p>"
            f"<p>Your Nexus time clock shows you've been <b>clocked in for {hours}+ hours</b>.</p>"
            "<p><b>Still working?</b> No action needed - you'll get one reminder like this "
            f"every {RENOTIFY_HOURS} hours while the session stays open.</p>"
            "<p><b>Forgot to punch out?</b> Open Time Clock in Nexus and use "
            "<b>\"I forgot - fix my punch-out\"</b> (or \"Add clock-out\" on the open session in "
            "your timesheet) to set the real end time. Your approver confirms the fix.</p>"
            "<p style=\"color:#6b7280;font-size:12px\">Sessions over "
            f"{LONG_SESSION_HOURS} hours are flagged on the timesheet until corrected.</p>"
        )
        graph_mail.send_mail(from_email=from_email, to=[email], cc=None,
                             subject=f"Nexus - Time clock - Clocked in {hours}+ hours",
                             html=html)
    except Exception:
        pass


def _scan_once():
    db = SessionLocal()
    try:
        for email, start in _open_sessions(db):
            t0 = _parse(start.at)
            if t0 is None:
                continue
            hours = (_now() - t0).total_seconds() / 3600.0
            if hours < LONG_SESSION_HOURS:
                continue
            h = int(hours)
            emp = db.query(NexusEmployee).filter(NexusEmployee.work_email == email).first()
            # Manager alert fires on its own (later) threshold + dedupe, independent
            # of the employee nudge below.
            if hours >= MGR_ALERT_HOURS:
                _notify_manager(db, emp, h, start.id)
            if _already_nudged(db, start.id):
                continue
            db.add(NexusNotification(
                id=str(uuid.uuid4()), type=NOTIF_TYPE, recipient=email,
                title=f"Still working? You've been clocked in {h} hours",
                body=("If you're still on the clock, carry on. If you forgot to punch out, "
                      "open Time Clock and use \"I forgot - fix my punch-out\" to set the real end time."),
                ref_id=start.id, action=json.dumps({"view": "timeclock"}),
                created_at=_iso(_now())))
            db.commit()
            _email(db, email, h)
    finally:
        db.close()


async def long_session_loop():
    await asyncio.sleep(90)  # let startup settle before the first scan
    while True:
        try:
            await asyncio.to_thread(_scan_once)
        except Exception as e:
            print(f"[timeclock-watch] scan failed: {e}")
        await asyncio.sleep(CHECK_EVERY_SEC)
