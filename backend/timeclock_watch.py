"""Long-session watch - nudges people who look like they forgot to punch out.

Every 15 minutes: find employees whose open session (last non-voided punch is
in / break_start / break_end) started more than LONG_SESSION_HOURS ago and nudge
them - a bell notification plus a best-effort email - once per open session
(Oct 14 2026; it used to repeat every 12 hours). Dedupe is DB-backed (the bell row
itself, keyed on the session's in-punch id), so restarts never double-send.

Note: there used to be an end-of-day auto clock-out sweep here (closed a
forgotten session itself at 11:59 PM local with a flagged system punch). It was
removed (Aug 27) - too many employees were getting silently clocked out and it
caused confusion. The `source='auto_eod'` pay-hold convention it used is still
honored elsewhere for the shared-PC takeover flow (see `_handover_shared_pc` in
routers/timeclock.py), which is a different, human-triggered path.

Lives in its own module (not reminders.py) so the daily HR scan and this
frequent loop can evolve independently. Runs ONLY on the elected background-
jobs leader (see main.py / leader.py), so multi-worker prod can't double-fire.
"""
import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone

import graph_mail
from database import SessionLocal
from models import NexusEmployee, NexusNotification, TimePunch
import job_switch

LONG_SESSION_HOURS = 12   # the cap agreed Jul 27 - nudge past this
# Once per open session (Oct 14 2026; it used to repeat every 12 hours) -
# the dedupe window is longer than any session can stay open (16h cap).
RENOTIFY_HOURS = 24 * 30
CHECK_EVERY_SEC = 15 * 60  # 30 -> 15 min (Aug 25): the 23:30 warn + 23:59 close need the resolution
NOTIF_TYPE = "timeclock_long_session"


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
            "<p><b>Still working?</b> No action needed - this is the only reminder for this "
            "session.</p>"
            "<p><b>Forgot to punch out?</b> Open Time Clock in Nexus and use "
            "<b>\"I forgot - fix my punch-out\"</b> (or \"Add clock-out\" on the open session in "
            "your time sheet) to set the real end time. Your approver confirms the fix.</p>"
            "<p style=\"color:#6b7280;font-size:12px\">Sessions over "
            f"{LONG_SESSION_HOURS} hours are flagged on the time sheet until corrected.</p>"
        )
        graph_mail.send_mail(from_email=from_email, to=[email], cc=None,
                             subject=f"Nexus - Time Clock - Clocked in {hours}+ Hours",
                             html=html)
    except Exception:
        pass


def _scan_once():
    if job_switch.off("long_session"):   # Workflows > Automations switch
        return
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
            # No manager alert from here any more (Neil, Oct 14 2026: one
            # forgotten clock-out was three alerts). The manager hears once,
            # the next morning, from reminders.py's "Missing clock-out".
            if _already_nudged(db, start.id):
                continue
            db.add(NexusNotification(
                id=str(uuid.uuid4()), type=NOTIF_TYPE, recipient=email,
                title=f"Still Working? You've Been Clocked in {h} Hours",
                body=("If you're still on the clock, carry on. If you forgot to punch out, "
                      "open Time Clock and use \"I forgot - fix my punch-out\" to set the real end time."),
                ref_id=start.id, action=json.dumps({"view": "timeclock"}),
                company=(emp.company if emp else "") or "", created_at=_iso(_now())))
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
