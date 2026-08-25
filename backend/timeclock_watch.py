"""Long-session watch - nudges people who look like they forgot to punch out.

Every 15 minutes: find employees whose open session (last non-voided punch is
in / break_start / break_end) started more than LONG_SESSION_HOURS ago and nudge
them - a bell notification plus a best-effort email - repeating every
RENOTIFY_HOURS while the session stays open. Dedupe is DB-backed (the bell row
itself, keyed on the session's in-punch id), so restarts never double-send.

End-of-day auto clock-out (Neil, Aug 24 - Edgar/Kenny never clocked out and
looked clocked in for days): as an open session approaches the employee's LOCAL
end of day, up to three escalating "Still clocked in?" bells go out; at 11:59 PM
local the sweep closes the session itself with a flagged `source='auto_eod'`
out-punch and alerts both the employee and their manager, loudly. The auto
punch fixes the STATE only (the person shows clocked out, the next morning's
punch-in pairs cleanly) - the pay engine holds an auto-closed segment at ZERO
paid minutes and blocks approve/finalize until a human sets the real end time
(see _unconfirmed_auto_out in routers/timeclock.py). This is the industry
model: reminder, boundary auto-close, flagged unpaid system punch, supervisor
correction - never silently paying through an auto-generated punch.

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
from models import NexusEmployee, NexusNotification, NexusSetting, TimePunch

LONG_SESSION_HOURS = 12   # the cap agreed Jul 27 - nudge past this
RENOTIFY_HOURS = 12       # re-nudge cadence while the session stays open
CHECK_EVERY_SEC = 15 * 60  # 30 -> 15 min (Aug 25): the 23:30 warn + 23:59 close need the resolution
NOTIF_TYPE = "timeclock_long_session"
MGR_NOTIF_TYPE = "timeclock_long_session_mgr"   # the SAME event, sent to the manager
# Loop the manager in only once the session is clearly a forgotten punch, not just
# a long shift - matches the payroll guard (a shift past this is dropped from pay).
MGR_ALERT_HOURS = 16

# ── End-of-day auto clock-out config (admin-tunable via NexusSetting) ─────────
AUTO_OUT_KEY = "timeclock_autoclockout"
AUTO_OUT_DEFAULT = {
    "enabled": True,                              # Neil, Aug 24: on by default
    "warnLocal": ["21:30", "22:30", "23:30"],     # escalating "still clocked in?" bells
    "outLocal": "23:59",                          # the auto-close moment (employee-local)
    "minSessionMin": 120,                         # never insta-close a late-evening clock-in
}
EOD_WARN_TYPES = ("timeclock_eod_warn1", "timeclock_eod_warn2", "timeclock_eod_warn3")
AUTO_OUT_TYPE = "timeclock_auto_out"
AUTO_OUT_MGR_TYPE = "timeclock_auto_out_mgr"


def _auto_out_cfg(db) -> dict:
    row = db.query(NexusSetting).filter(NexusSetting.key == AUTO_OUT_KEY).first()
    cfg = dict(AUTO_OUT_DEFAULT)
    if row and row.value:
        try:
            cfg.update({k: v for k, v in json.loads(row.value).items() if k in cfg})
        except (ValueError, TypeError):
            pass
    return cfg


def _hhmm_min(v: str, fallback: int) -> int:
    """'23:59' -> minutes-of-day; bad input falls back rather than breaking the sweep."""
    try:
        h, m = str(v).split(":")
        return max(0, min(23, int(h))) * 60 + max(0, min(59, int(m)))
    except (ValueError, AttributeError):
        return fallback


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


def _who(emp, email: str) -> str:
    return (f"{(emp.first_name or '').strip()} {(emp.last_name or '').strip()}".strip()
            if emp else "") or (email.split("@")[0].replace(".", " ").title() if email else "An employee")


def _notify_once(db, *, ntype: str, recipient: str, title: str, body: str,
                 ref_id: str, action: dict, window_hours: int = 24) -> bool:
    """Insert one bell notification unless the same (type, ref) already went out
    inside the window - the DB row IS the dedupe, so leader restarts never
    double-send. Returns whether a row was added (caller commits)."""
    if not recipient:
        return False
    cutoff = _iso(_now() - timedelta(hours=window_hours))
    exists = (db.query(NexusNotification)
              .filter(NexusNotification.type == ntype,
                      NexusNotification.ref_id == ref_id,
                      NexusNotification.created_at >= cutoff).first())
    if exists:
        return False
    db.add(NexusNotification(id=str(uuid.uuid4()), type=ntype, recipient=recipient,
                             title=title, body=body, ref_id=ref_id,
                             action=json.dumps(action), created_at=_iso(_now())))
    return True


def _auto_clock_out(db, email: str, start, close_local, off: int, out_hhmm: str):
    """Close one forgotten session at the employee's local end of day. The punch
    is source='auto_eod': the pay engine holds its segment at 0 minutes and
    blocks sign-off until a human confirms the real end time - state is fixed,
    pay never is."""
    # The scan snapshot is minutes old - re-read the latest punch right before
    # writing, in case the person punched out (or was closed) in the meantime.
    latest = (db.query(TimePunch)
              .filter(TimePunch.employee_email == email, TimePunch.voided == 0)
              .order_by(TimePunch.at.desc()).first())
    if latest is None or latest.kind == "out":
        return
    # Session-keyed idempotence, INCLUDING voided rows: one auto close per
    # session, ever. Without this, an auto punch backdated behind a later break
    # punch (or one a manager voided to fix the day) leaves "latest.kind" a
    # non-out and every 15-minute tick would insert another duplicate forever
    # (adversarial review, Aug 25). A manager voiding the auto punch means
    # "I'm fixing this by hand" - the sweep stays out of that session for good.
    prior_auto = (db.query(TimePunch.id)
                  .filter(TimePunch.employee_email == email,
                          TimePunch.kind == "out", TimePunch.source == "auto_eod",
                          TimePunch.at > start.at).first())
    if prior_auto is not None:
        return
    # Recent activity = a live human, not a forgotten punch. A break ended at
    # 11:30 PM proves presence - defer this tick (the warns already went out);
    # the close fires once they actually go quiet.
    last_at = _parse(latest.at)
    if last_at is not None and (_now() - last_at).total_seconds() < 60 * 60:
        return
    # Stamp: the configured boundary, clamped STRICTLY after both the session
    # start and the newest punch, so the auto out is always the latest punch by
    # `at` - the state machine terminates and the guard above stays cheap.
    at_utc = close_local + timedelta(minutes=off)   # local = UTC - offset  =>  UTC = local + offset
    for floor in (_parse(start.at), last_at):
        if floor is not None and at_utc <= floor:
            at_utc = floor + timedelta(minutes=1)
    db.add(TimePunch(id=str(uuid.uuid4()), employee_email=email, kind="out",
                     at=_iso(at_utc), local_date=close_local.strftime("%Y-%m-%d"),
                     tz_offset_min=off, geo_status="",
                     source="auto_eod", note="Auto clock-out - no punch-out recorded",
                     created_by="system", created_at=_iso(_now())))
    # Mirror a real punch-out's side effects: free any shared-PC binding and
    # close a live tracking session, so the next person/morning starts clean.
    try:
        from models import AgentDevice
        for d in db.query(AgentDevice).filter(AgentDevice.active_email == email).all():
            d.active_email = ""
            d.active_session_id = ""
    except Exception:
        pass
    try:
        from routers.timeclock import close_track_session
        close_track_session(db, email, "auto_clock_out")
    except Exception:
        pass
    emp = db.query(NexusEmployee).filter(NexusEmployee.work_email == email).first()
    who = _who(emp, email)
    first_close = _notify_once(db, ntype=AUTO_OUT_TYPE, recipient=email,
                               title=f"Auto clocked out at {out_hhmm}",
                               body=("You never clocked out, so Nexus closed your shift at "
                                     f"{out_hhmm}. Your timecard holds that day at 0 hours until the real "
                                     "end time is set - open Time Clock and fix the punch-out; your "
                                     "approver confirms it."),
                               ref_id=start.id, action={"view": "timeclock", "sub": "timesheet"})
    mgr = ((emp.manager_email if emp else "") or "").strip().lower()
    _notify_once(db, ntype=AUTO_OUT_MGR_TYPE, recipient=mgr,
                 title=f"{who} never clocked out - auto-closed at {out_hhmm}",
                 body=(f"{who}'s shift had no clock-out and was auto-closed at {out_hhmm}. "
                       "The day is held at 0 paid hours and blocks timecard sign-off until "
                       "the real end time is set - open their timesheet and correct it, or "
                       "have them propose the time."),
                 ref_id=start.id, action={"view": "hr", "sub": "hr-time"})
    db.commit()
    # Dedicated email, once per closed session (gated on the bell insert above) -
    # NOT the long-session template, whose "still open, no action needed" copy
    # would contradict the close that just happened.
    if first_close:
        _email_auto_out(db, email, out_hhmm)


def _email_auto_out(db, email: str, out_hhmm: str):
    """Best-effort - a mail failure must never stop the sweep."""
    try:
        from_email = (graph_mail.DEFAULT_FROM_EMAIL or "").strip()
        if not from_email:
            return
        emp = db.query(NexusEmployee).filter(NexusEmployee.work_email == email).first()
        first = ((emp.first_name if emp else "") or "there").strip()
        html = (
            f"<p>Hi {first},</p>"
            f"<p>You never clocked out, so Nexus <b>closed your shift at {out_hhmm}</b>.</p>"
            "<p>That day is held at <b>0 paid hours</b> until the real end time is set. "
            "Open Time Clock in Nexus, tap the Out time on the auto-closed day, and "
            "propose your real end time - your approver confirms the fix.</p>"
        )
        graph_mail.send_mail(from_email=from_email, to=[email], cc=None,
                             subject=f"Nexus - Time clock - Auto clocked out at {out_hhmm}",
                             html=html)
    except Exception:
        pass


def _eod_sweep(db):
    """The end-of-day pass: escalating warns, then the 11:59 PM auto-close."""
    cfg = _auto_out_cfg(db)
    if not cfg.get("enabled"):
        return
    # An admin-stored EMPTY list means "auto-close, no warn bells" - _auto_out_cfg
    # already fills the defaults when nothing was ever stored, so no fallback here.
    warn_defaults = (21 * 60 + 30, 22 * 60 + 30, 23 * 60 + 30)
    warn_mins = [_hhmm_min(v, d) for v, d in zip(list(cfg.get("warnLocal") or []), warn_defaults)][:3]
    out_min = _hhmm_min(cfg.get("outLocal"), 23 * 60 + 59)
    _h, _m = out_min // 60, out_min % 60
    out_hhmm = f"{_h % 12 or 12}:{_m:02d} {'PM' if _h >= 12 else 'AM'}"
    min_session = max(0, int(cfg.get("minSessionMin") or 0))
    now = _now()
    for email, start in _open_sessions(db):
        # _open_sessions anchors on the newest break punch when the real
        # in-punch predates its 14-day floor - resolve the true shift start
        # (floorless) so the close time, dedupe ref and min-session guard all
        # key off the in punch. No in punch at all = a data problem to surface
        # by hand, not to punch over.
        if start.kind != "in":
            start = (db.query(TimePunch)
                     .filter(TimePunch.employee_email == email,
                             TimePunch.kind == "in", TimePunch.voided == 0)
                     .order_by(TimePunch.at.desc()).first())
            if start is None:
                continue
        t0 = _parse(start.at)
        if t0 is None:
            continue
        if (now - t0).total_seconds() / 60 < min_session:
            continue   # a genuine late-evening clock-in is never insta-closed
        off = int(start.tz_offset_min or 0)             # JS getTimezoneOffset: local = UTC - offset
        now_local = now - timedelta(minutes=off)
        start_local = t0 - timedelta(minutes=off)
        # Close at `outLocal` on the day the shift STARTED - a tick just past
        # local midnight still closes yesterday's shift at yesterday's boundary,
        # and a days-stale session closes on the next tick. A clock-in AT/AFTER
        # the boundary (23:59:30, or any evening once an admin sets an earlier
        # outLocal) belongs to the NEXT day's boundary - never stamp a close
        # at or before the session's own start.
        close_local = (start_local.replace(hour=0, minute=0, second=0, microsecond=0)
                       + timedelta(minutes=out_min))
        while close_local <= start_local:
            close_local += timedelta(days=1)
        if now_local >= close_local:
            _auto_clock_out(db, email, start, close_local, off, out_hhmm)
            continue
        # Escalating warns (same local day by construction - the close above
        # catches any session older than its own day). Send only the HIGHEST
        # stage reached, once per session: a leader that was down at 21:30
        # sends one 23:30-stage bell, not a burst of three.
        mins_of_day = now_local.hour * 60 + now_local.minute
        stage = -1
        for i, wm in enumerate(warn_mins):
            if mins_of_day >= wm:
                stage = i
        if stage < 0:
            continue
        if _notify_once(db, ntype=EOD_WARN_TYPES[stage], recipient=email,
                        title="Still clocked in?",
                        body=("Your shift is still running this late in the day. Still working? "
                              "Carry on. Done for the day? Clock out now - at "
                              f"{out_hhmm} Nexus closes the shift itself and the day is held at "
                              "0 hours until the real end time is confirmed."),
                        ref_id=start.id, action={"view": "timeclock"}):
            db.commit()


def _scan_once():
    db = SessionLocal()
    try:
        try:
            _eod_sweep(db)
        except Exception as e:
            db.rollback()
            print(f"[timeclock-watch] eod sweep failed: {e}")
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
