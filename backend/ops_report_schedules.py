"""Operations > Reports > Scheduled: catalog reports emailed as a file (Oct 20 2026).

Cubby's "Scheduled" tab, done better: any report in ops_reports.CATALOG, one
or several facilities, a rolling period (current / previous day, week, month,
quarter or year), its report options, as an XLSX, PDF or CSV ATTACHMENT, with
the headline figures in the email body. Daily (weekdays only unless
include_weekends), weekly (a weekday) or monthly (a day 1-28), at an hour,
Pacific time. Recipients are Nexus People work emails only (staff, never
tenants - the router validates them like the Report Builder does).

Sending reuses the Report Builder's machinery: the same loop
(ops_report_builder.ops_report_schedule_loop calls scan_once here, in a
thread), the same Graph mailbox (graph_mail), the same once-per-period claim
(a conditional UPDATE on last_sent_period, so two workers cannot both send)
and the same retry rule (a failed send gives the claim back and is retried
at most once an hour). A new schedule, or one whose timing changes, starts
at its NEXT occurrence - "Send Now" is there for one today.

Everything here is blocking; the router and the loop run it in a thread.
"""
from __future__ import annotations

import html as _html
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import ops_report_export as export

TZ = "America/Los_Angeles"
FREQUENCIES = {"daily": "Daily", "weekly": "Weekly", "monthly": "Monthly"}
FORMATS = {"xlsx": "XLSX", "pdf": "PDF", "csv": "CSV"}
MODES = {"current": "Current", "previous": "Previous"}
UNITS = {"day": "Day", "week": "Week", "month": "Month", "quarter": "Quarter", "year": "Year"}
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
MAX_ATTACH_BYTES = 3 * 1024 * 1024     # Graph takes inline attachments up to ~3 MB
RETRY_AFTER_SEC = 3600


class ScheduleError(Exception):
    pass


def local_now() -> datetime:
    return datetime.now(ZoneInfo(TZ))


# ── Periods ───────────────────────────────────────────────────────────────────

def resolve_period(period: dict | None, today: date) -> tuple[str, str]:
    """(start, end) as YYYY-MM-DD for {"mode": current|previous, "unit": ...}.

    current  = the unit containing today, up to today (current day = today,
               current month = the 1st through today);
    previous = the whole unit before it (previous day = yesterday, previous
               month = all of last month).
    Weeks run Monday to Sunday - the operating week the Report Builder's
    "Week Starting" uses (payroll's Sunday week is a Time Clock rule, not an
    Operations one)."""
    period = period or {}
    mode = period.get("mode") or "current"
    unit = period.get("unit") or "month"
    if mode not in MODES or unit not in UNITS:
        raise ScheduleError("A period is current or previous, by day, week, month, quarter or year")
    if unit == "day":
        d = today if mode == "current" else today - timedelta(days=1)
        return d.isoformat(), d.isoformat()
    if unit == "week":
        start = today - timedelta(days=today.weekday())
        if mode == "current":
            return start.isoformat(), today.isoformat()
        return (start - timedelta(days=7)).isoformat(), (start - timedelta(days=1)).isoformat()
    if unit == "month":
        start = today.replace(day=1)
        if mode == "current":
            return start.isoformat(), today.isoformat()
        end = start - timedelta(days=1)
        return end.replace(day=1).isoformat(), end.isoformat()
    if unit == "quarter":
        start = date(today.year, 3 * ((today.month - 1) // 3) + 1, 1)
        if mode == "current":
            return start.isoformat(), today.isoformat()
        end = start - timedelta(days=1)
        return date(end.year, 3 * ((end.month - 1) // 3) + 1, 1).isoformat(), end.isoformat()
    if mode == "current":
        return date(today.year, 1, 1).isoformat(), today.isoformat()
    return date(today.year - 1, 1, 1).isoformat(), date(today.year - 1, 12, 31).isoformat()


def period_label(period: dict | None) -> str:
    period = period or {}
    return f"{MODES.get(period.get('mode'), 'Current')} {UNITS.get(period.get('unit'), 'Month')}"


# ── When a schedule is due ────────────────────────────────────────────────────

def _runs_on(row, d: date) -> bool:
    if row.frequency == "daily":
        return bool(row.include_weekends) or d.weekday() < 5
    if row.frequency == "weekly":
        return d.weekday() == max(0, min(6, row.day or 0))
    if row.frequency == "monthly":
        return d.day == max(1, min(28, row.day or 1))
    return False


def _key(row, d: date) -> str:
    return d.strftime("%Y-%m") if row.frequency == "monthly" else d.isoformat()


def due_period(row, now: datetime) -> str:
    """The period key this schedule owes a send for at `now` ('' = nothing
    yet): the day (daily), the send day of this week (weekly) or YYYY-MM
    (monthly). A send missed while the server was down goes out late in the
    same period, never twice."""
    today = now.date()
    hour = max(0, min(23, row.hour or 0))
    if row.frequency == "daily":
        return today.isoformat() if _runs_on(row, today) and now.hour >= hour else ""
    if row.frequency == "weekly":
        target = today - timedelta(days=today.weekday()) + timedelta(days=max(0, min(6, row.day or 0)))
    elif row.frequency == "monthly":
        target = today.replace(day=max(1, min(28, row.day or 1)))
    else:
        return ""
    if today > target or (today == target and now.hour >= hour):
        return _key(row, target)
    return ""


def next_run_at(row, now: datetime | None = None) -> str:
    """When the next send goes out (ISO with the Pacific offset), '' when paused."""
    if not row.active or row.frequency not in FREQUENCIES:
        return ""
    now = now or local_now()
    due = due_period(row, now)
    if due and due != (row.last_sent_period or ""):
        return now.replace(second=0, microsecond=0).isoformat()      # owed now: the next scan sends it
    hour = max(0, min(23, row.hour or 0))
    tz = ZoneInfo(TZ)
    for i in range(0, 70):
        d = now.date() + timedelta(days=i)
        at = datetime(d.year, d.month, d.day, hour, tzinfo=tz)
        if at <= now or not _runs_on(row, d) or _key(row, d) == (row.last_sent_period or ""):
            continue
        return at.isoformat()
    return ""


def describe(row) -> str:
    """'Weekdays at 7:00 AM', 'Every Monday at 7:00 AM', 'Monthly on day 1 at 7:00 AM'."""
    hour = max(0, min(23, row.hour or 0))
    at = datetime(2026, 1, 1, hour).strftime("%I:%M %p").lstrip("0") + " Pacific"
    if row.frequency == "daily":
        return f"{'Every day' if row.include_weekends else 'Weekdays'} at {at}"
    if row.frequency == "weekly":
        return f"Every {WEEKDAYS[max(0, min(6, row.day or 0))]} at {at}"
    return f"Monthly on day {max(1, min(28, row.day or 1))} at {at}"


# ── Running and sending ───────────────────────────────────────────────────────

def build(row, today: date | None = None) -> tuple[dict, bytes, str, str]:
    """Run the schedule's report: (result, file bytes, media type, filename)."""
    start, end = resolve_period(row.period or {}, today or local_now().date())
    result = export.run_report(row.kind, list(row.facility_ids or []), start, end, dict(row.options or {}))
    if result.get("available") is False:
        raise ScheduleError("That report is not available from Cubby")
    data, media, fname = export.render(result, row.format or "xlsx")
    return result, data, media.split(";")[0], fname


def _figures(result: dict) -> list[tuple[str, str]]:
    summary = [s for s in (result.get("summary") or []) if isinstance(s, dict) and s.get("label")]
    if summary:
        return [(str(s["label"]), export.text_of(s.get("value"), s.get("type") or "num") or "-") for s in summary[:8]]
    totals = result.get("totals") or {}
    out = []
    for c in export.columns(result):
        if c.get("type") in export.NUMERIC and isinstance(totals.get(c["key"]), (int, float)):
            out.append((f"Total {c['label']}", export.text_of(totals[c["key"]], c["type"]) or "-"))
    return out[:6]


def render_email(row, result: dict, fname: str) -> tuple[str, str]:
    title = result.get("title") or row.name
    when = export.period_line(result)
    subject = f"Ops Report: {row.name} ({when})" if when else f"Ops Report: {row.name}"
    esc = _html.escape
    figures = "".join(
        f"<td style=\"padding:10px 14px;background:#f6f8f3;border-left:3px solid #8dc63f;vertical-align:top\">"
        f"<div style=\"font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.03em\">{esc(label)}</div>"
        f"<div style=\"font-size:18px;font-weight:700;color:#1f2328;margin-top:2px\">{esc(value)}</div></td>"
        f"<td style=\"width:8px\"></td>"
        for label, value in _figures(result))
    lines = len(result.get("rows") or [])
    html = (
        "<div style=\"font-family:Inter,Segoe UI,Arial,sans-serif;color:#1f2328;max-width:720px\">"
        f"<h2 style=\"font-size:20px;margin:0 0 4px\">{esc(title)}</h2>"
        f"<p style=\"margin:0 0 2px;font-size:14px\">{esc(when)}</p>"
        f"<p style=\"margin:0 0 16px;font-size:13px;color:#6b7280\">{esc(export.facilities_line(result))}</p>"
        + (f"<table style=\"border-collapse:collapse;margin:0 0 16px\"><tr>{figures}</tr></table>" if figures else "")
        + f"<p style=\"font-size:13px;margin:0 0 4px\">{lines:,} line{'s' if lines != 1 else ''}. "
        f"The {esc(FORMATS.get(row.format, 'XLSX'))} file is attached: <b>{esc(fname)}</b></p>"
        f"<p style=\"margin-top:20px;font-size:12px;color:#6b7280\">\"{esc(row.name)}\" is scheduled "
        f"{esc(describe(row).lower())} by {esc(row.owner_email)} in Nexus Operations &gt; Reports &gt; Scheduled. "
        f"Figures from Cubby, synced every 15 minutes. {esc(export.PRIVACY)}</p></div>")
    return subject, html


def send(row, to: list[str] | None = None, today: date | None = None) -> dict:
    """Run and email one schedule (one email to every recipient, the file
    attached). Raises graph_mail.GraphMailError when the mail does not go."""
    import graph_mail
    recipients = list(to) if to is not None else list(row.recipients or [])
    if not recipients:
        raise graph_mail.GraphMailError("No recipient")
    result, data, media, fname = build(row, today)
    if len(data) > MAX_ATTACH_BYTES:
        raise graph_mail.GraphMailError(
            f"The file is {len(data) / 1048576:.1f} MB, more than email takes ({MAX_ATTACH_BYTES // 1048576} MB); "
            "pick fewer facilities, a shorter period or the XLSX format")
    subject, html = render_email(row, result, fname)
    graph_mail.send_mail(from_email=graph_mail.DEFAULT_FROM_EMAIL, to=recipients, cc=None, subject=subject, html=html,
                         attachments=[(fname, media, data)])
    return {"sent": True, "to": recipients, "file": fname, "lines": len(result.get("rows") or [])}


def _claim(db, schedule_id: str, period: str) -> bool:
    import models
    from sqlalchemy import or_
    S = models.OpsReportSchedule
    n = (db.query(S).filter(S.id == schedule_id, S.active.is_(True),
                            or_(S.last_sent_period.is_(None), S.last_sent_period != period))
         .update({S.last_sent_period: period, S.last_attempt_at: datetime.now(timezone.utc).isoformat()},
                 synchronize_session=False))
    db.commit()
    return n == 1


def _age(stamp: str) -> float:
    try:
        return (datetime.now(timezone.utc) - datetime.fromisoformat(stamp.replace("Z", "+00:00"))).total_seconds()
    except (ValueError, AttributeError):
        return 1e9


def scan_once(now: datetime | None = None) -> int:
    """Send every active schedule that is due. Blocking. Returns sends."""
    import graph_mail
    import models
    from database import SessionLocal
    if not graph_mail.graph_configured() or not graph_mail.DEFAULT_FROM_EMAIL:
        return 0
    now = now or local_now()
    sent = 0
    db = SessionLocal()
    try:
        S = models.OpsReportSchedule
        for row in db.query(S).filter(S.active.is_(True)).all():
            period = due_period(row, now)
            if not period or period == (row.last_sent_period or ""):
                continue
            if row.last_error and row.last_attempt_at and _age(row.last_attempt_at) < RETRY_AFTER_SEC:
                continue
            previous = row.last_sent_period or ""
            if not _claim(db, row.id, period):
                continue
            db.refresh(row)
            try:
                send(row, today=now.date())
                row.last_sent_at, row.last_error = datetime.now(timezone.utc).isoformat(), ""
                db.commit()
                sent += 1
            except Exception as e:  # noqa: BLE001 - give the claim back; retried after RETRY_AFTER_SEC
                db.rollback()
                db.refresh(row)
                row.last_sent_period, row.last_error = previous, f"{type(e).__name__}: {str(e)[:200]}"
                db.commit()
                print(f"[ops-reports] scheduled export failed for {row.id}: {type(e).__name__}")
        return sent
    finally:
        db.close()
