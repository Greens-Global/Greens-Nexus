"""Shifts Phase 3a - shared shifts on people's Outlook calendars (Neil, Oct 14 2026).

The schedule comes to people: every shift a manager has SHARED with a person
becomes an event on that person's Outlook calendar, kept in step as the
schedule changes, and taken off when the shift is removed, cancelled by a
weather call or handed to someone else. Microsoft Graph, app-only
(`POST/PATCH/DELETE /users/{id}/events[/{id}]` with graph_mail.access_token),
which needs the Calendars.ReadWrite APPLICATION permission with admin
consent - docs/Outlook-Calendar-Setup.md. Until that is granted Graph
answers 401 / 403, the sync pauses for five minutes with the reason (status()
shows it, like the Teams presence dots), and nothing else is affected.

Nothing here runs inside a request. The write paths on the schedule (publish,
a request approved, a weather call, a discard) only QUEUE work:

    enqueue(db, shift_ids)              these shifts changed - re-sync them
    enqueue_delete(db, shift_id, email) this person's event for it must go

and the sync loop (calendar_sync_loop, every minute, in a thread) works the
queue in sync_once: up to 50 rows per tick. A row is skipped - and any event
it had is removed - when the company's outlookCalendar switch is off, the
person opted out (nexus_person_prefs.shift_calendar), the person has no
Microsoft 365 account (nexus_employees.m365_id), or the shift is no longer a
shared, assigned, live shift. The event body is hashed (synced_hash) so an
unchanged shift is never sent again. The first tick with an empty table
backfills every shared assigned shift from today onward (enqueue_all_upcoming).

The event: subject "Shift · 7:00 AM - 3:30 PM · GSV" (the label, else the
shift type), start and end in the shift's own zone (an overnight shift ends
the next day), showAs per the company setting (free by default), no reminder,
a text body with the team, the site and a link to My Shifts, category
"Nexus Shift", transactionId = the shift id so a retried create cannot make
two events. Pay never appears; a person's calendar only ever carries their own
shifts.

`graph` in sync_once is an injectable callable `(method, path, body) ->
(status, data)` so the tests drive the whole state machine without Graph.
"""
import asyncio
import hashlib
import json
import time
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

import models
from app_url import app_url
from database import SessionLocal

BATCH = 50
SYNC_SEC = 60
RETRY_SEC = 300            # how long a 401 / 403 pauses the sync
ERROR_RETRY_SEC = 15 * 60  # an errored row is tried again after this
CATEGORY = "Nexus Shift"
SETUP_DOC = "docs/Outlook-Calendar-Setup.md"
GRAPH = "https://graph.microsoft.com/v1.0"
_DEFAULT_TZ = "America/Los_Angeles"
STATES = ("pending", "ok", "delete", "error", "skipped")

_disabled_until: float = 0.0
_disabled_reason: str = ""
_backfill_checked = False


class GraphDenied(Exception):
    """401 / 403 from Graph: the permission is missing - stop the tick."""


class GraphError(Exception):
    """Any other failed Graph call: this row errors, the tick goes on."""


def _now_iso(now: datetime = None) -> str:
    return (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%S")


def _t12(hhmm: str) -> str:
    try:
        h, m = (int(x) for x in (hhmm or "")[:5].split(":"))
    except ValueError:
        return hhmm or ""
    return f"{(h % 12) or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"


def _us(iso: str) -> str:
    try:
        d = datetime.strptime(iso[:10], "%Y-%m-%d")
    except ValueError:
        return iso or ""
    return f"{d.strftime('%a')}, {d.strftime('%m/%d/%Y')}"


# ── The queue (called from requests; never a Graph call) ──────────────────

def _rows_for(db: Session, shift_ids: list) -> list:
    """The queue rows for these shifts - including rows added earlier in
    the same request and not yet flushed (sessions run with autoflush off,
    so a query alone would miss them and a second enqueue would add a
    duplicate)."""
    wanted = set(shift_ids)
    rows = (db.query(models.ShiftCalendarEvent)
            .filter(models.ShiftCalendarEvent.shift_id.in_(list(wanted))).all())
    seen = {r.id for r in rows}
    for obj in list(db.new):
        if isinstance(obj, models.ShiftCalendarEvent) and obj.shift_id in wanted and obj.id not in seen:
            rows.append(obj)
    return rows


def enqueue(db: Session, shift_ids) -> int:
    """These shifts changed: mark the row for each shift's CURRENT owner
    pending (made when new) and any row for a previous owner delete, so a
    swap or an offer moves the event. A shift that is gone or open marks
    every row it had delete. No commit - the route commits. Returns how
    many rows are now pending."""
    ids = list(dict.fromkeys(str(x) for x in (shift_ids or []) if x))
    if not ids:
        return 0
    shifts = {r.id: r for r in db.query(models.ScheduledShift).filter(models.ScheduledShift.id.in_(ids)).all()}
    for obj in list(db.new):   # a shift placed in this same request (a claimed open shift) is not flushed yet
        if isinstance(obj, models.ScheduledShift) and obj.id in ids:
            shifts[obj.id] = obj
    existing = {}
    for e in _rows_for(db, ids):
        existing.setdefault(e.shift_id, []).append(e)
    now = _now_iso()
    n = 0
    for sid in ids:
        r = shifts.get(sid)
        owner = (r.employee_email or "").lower() if r is not None else ""
        mine = None
        for e in existing.get(sid, []):
            if e.employee_email == owner:
                mine = e
            else:
                _mark_delete(db, e, now)
        if not owner:
            continue
        if mine is None:
            mine = models.ShiftCalendarEvent(id=str(uuid.uuid4()), shift_id=sid, employee_email=owner)
            db.add(mine)
        mine.state, mine.last_error, mine.updated_at = "pending", "", now
        n += 1
    return n


def _mark_delete(db: Session, e, now: str) -> None:
    if e.event_id:
        e.state, e.updated_at = "delete", now
    elif e in db.new:
        db.expunge(e)  # queued earlier in this request, never flushed: forget it
    else:
        db.delete(e)   # never reached Outlook: nothing to take off


def enqueue_delete(db: Session, shift_id: str, email: str) -> bool:
    """This person's event for the shift must go (the removal was shared).
    No commit. False when there was never a row."""
    em = (email or "").lower()
    e = next((r for r in _rows_for(db, [str(shift_id or "")]) if r.employee_email == em), None)
    if e is None:
        return False
    _mark_delete(db, e, _now_iso())
    return True


def enqueue_all_upcoming(db: Session) -> int:
    """Backfill: every shared, assigned shift from today onward (today in
    the zone furthest behind UTC, so nothing is missed at a day's edge).
    Run once at the first tick when the table is empty. No commit."""
    today = (datetime.now(timezone.utc) - timedelta(hours=12)).date().isoformat()
    rows = (db.query(models.ScheduledShift.id)
            .filter(models.ScheduledShift.published == 1, models.ScheduledShift.employee_email != "",
                    models.ScheduledShift.work_date >= today).all())
    return enqueue(db, [sid for (sid,) in rows])


# ── The event ─────────────────────────────────────────────────────────────

def title_of(shift, preset) -> str:
    """What the subject carries after the times: the shift's label, else
    its shift type's code or name, else nothing."""
    label = (getattr(shift, "label", "") or "").strip()
    if label:
        return label
    if preset is not None:
        return (preset.code or preset.name or "").strip()
    return ""


def subject_for(start: str, end: str, title: str) -> str:
    s = f"Shift · {_t12(start)} - {_t12(end)}"
    return f"{s} · {title}" if title else s


def bounds(work_date: str, start: str, end: str) -> tuple:
    """(start, end) naive local datetimes; an end at or before the start is
    the next day (an overnight shift)."""
    d = datetime.strptime(work_date[:10], "%Y-%m-%d")
    s = d.replace(hour=int(start[:2]), minute=int(start[3:5]))
    e = d.replace(hour=int(end[:2]), minute=int(end[3:5]))
    if e <= s:
        e += timedelta(days=1)
    return s, e


def shift_zone(shift, preset, team_tz: str) -> str:
    """placement -> preset -> the company's team zone (timeclock._shift_tz)."""
    return ((getattr(shift, "timezone", "") or "").strip()
            or ((preset.timezone or "") if preset is not None else "")
            or team_tz or _DEFAULT_TZ)


def event_payload(shift, preset, tz: str, show_as: str, group_name: str = "", site_name: str = "") -> dict:
    """The Graph event body for one shift. Deterministic: the sync hashes
    it to know whether Outlook already has this version."""
    s, e = bounds(shift.work_date, shift.start_hhmm or "09:00", shift.end_hhmm or "17:00")
    lines = [f"{_t12(shift.start_hhmm)} - {_t12(shift.end_hhmm)} on {_us(shift.work_date)}"]
    if group_name:
        lines.append(f"Team: {group_name}")
    if site_name:
        lines.append(f"Site: {site_name}")
    lines.append(f"My Shifts: {app_url()}/shifts/mine")
    return {"subject": subject_for(shift.start_hhmm, shift.end_hhmm, title_of(shift, preset)),
            "start": {"dateTime": s.strftime("%Y-%m-%dT%H:%M:%S"), "timeZone": tz},
            "end": {"dateTime": e.strftime("%Y-%m-%dT%H:%M:%S"), "timeZone": tz},
            "showAs": show_as if show_as in ("free", "busy") else "free",
            "isReminderOn": False,
            "body": {"contentType": "text", "content": "\n".join(lines)},
            "categories": [CATEGORY],
            "transactionId": shift.id}


def _hash(payload: dict, upn: str) -> str:
    body = {k: v for k, v in payload.items() if k != "transactionId"}
    return hashlib.sha256(json.dumps({"upn": upn, **body}, sort_keys=True).encode()).hexdigest()[:40]


# ── Graph ─────────────────────────────────────────────────────────────────

def _graph_call(method: str, path: str, body: dict = None) -> tuple:
    """The real thing: one Graph call with the cached app-only token.
    Returns (status, json) - the caller judges the status."""
    import httpx

    import graph_mail
    headers = {"Authorization": f"Bearer {graph_mail.access_token()}", "Content-Type": "application/json"}
    r = httpx.request(method, GRAPH + path, headers=headers, json=body, timeout=20)
    try:
        data = r.json() if r.content else {}
    except ValueError:
        data = {}
    return r.status_code, data if isinstance(data, dict) else {}


def _check(status: int, data: dict, what: str) -> None:
    if status in (401, 403):
        raise GraphDenied("The Entra app lacks the Calendars.ReadWrite application permission, or admin "
                          f"consent has not been granted - see {SETUP_DOC}.")
    if status == 404:
        return
    if status >= 300:
        msg = ((data or {}).get("error") or {}).get("message") or ""
        raise GraphError(f"Graph answered {status} on {what}" + (f": {msg[:160]}" if msg else ""))


def _remove_event(graph, upn: str, event_id: str) -> None:
    if not (upn and event_id):
        return
    status, data = graph("DELETE", f"/users/{upn}/events/{event_id}", None)
    _check(status, data, "delete")   # 404: already gone - fine


# ── The sync ──────────────────────────────────────────────────────────────

class _Ctx:
    """Per-tick lookups, loaded once and cached: people, prefs, settings per
    company, shift types, teams and sites."""

    def __init__(self, db: Session):
        self.db = db
        self._emp = None
        self._prefs = None
        self._cfg = {}
        self._presets = None
        self._groups = None
        self._sites = None

    def employee(self, email: str):
        if self._emp is None:
            self._emp = {(e.work_email or "").lower(): e for e in
                         self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email != "").all()}
        return self._emp.get(email)

    def opted_in(self, email: str) -> bool:
        if self._prefs is None:
            self._prefs = {(p.email or "").lower(): p for p in self.db.query(models.NexusPersonPref).all()}
        p = self._prefs.get(email)
        return True if p is None or p.shift_calendar is None else bool(int(p.shift_calendar))

    def settings(self, company: str) -> dict:
        if company not in self._cfg:
            from routers.shift_requests import get_settings
            self._cfg[company] = get_settings(self.db, company or "")
        return self._cfg[company]

    def preset(self, shift_id: str):
        if self._presets is None:
            self._presets = {s.id: s for s in self.db.query(models.Shift).all()}
        return self._presets.get(shift_id or "")

    def group_name(self, gid: str) -> str:
        if self._groups is None:
            self._groups = {g.id: g for g in self.db.query(models.ShiftGroup).all()}
        g = self._groups.get(gid or "")
        return (g.name or "") if g is not None else ""

    def site_name(self, gid: str) -> str:
        if self._groups is None:
            self.group_name(gid)
        g = self._groups.get(gid or "")
        sid = (getattr(g, "work_site_id", "") or "") if g is not None else ""
        if not sid:
            return ""
        if self._sites is None:
            self._sites = {s.id: s for s in self.db.query(models.HrWorkSite).all()}
        s = self._sites.get(sid)
        return (s.name or "") if s is not None else ""


def _is_live(shift, email: str) -> bool:
    """A shared, assigned shift this person still owns and no weather call
    has cancelled. A pending (unshared) removal keeps the event: staff
    still see the shift until the manager shares the removal."""
    return (shift is not None and bool(shift.published)
            and (shift.employee_email or "").lower() == email
            and (getattr(shift, "weather_status", "") or "") != "cancelled")


def _skip_reason(shift, email: str, emp, ctx: _Ctx) -> str:
    if not _is_live(shift, email):
        if shift is not None and (getattr(shift, "weather_status", "") or "") == "cancelled":
            return "cancelled by a weather call"
        return "not a shared assigned shift"
    company = (emp.company or "") if emp is not None else ""
    if not ctx.settings(company).get("outlookCalendar", True):
        return "the Outlook calendar is off for this company"
    if not ctx.opted_in(email):
        return "opted out of the Outlook calendar"
    if emp is None or not (emp.m365_id or "").strip():
        return "no Microsoft 365 account (nexus_employees.m365_id)"
    return ""


def _sync_row(db: Session, e, ctx: _Ctx, graph, now: datetime, out: dict) -> None:
    email = (e.employee_email or "").lower()
    emp = ctx.employee(email)
    upn = ((emp.m365_id or "").strip() if emp is not None else "")
    stamp = _now_iso(now)
    if e.state == "delete":
        _remove_event(graph, upn, e.event_id)
        db.delete(e)
        out["deleted"] += 1
        return
    shift = db.query(models.ScheduledShift).filter(models.ScheduledShift.id == e.shift_id).first()
    why = _skip_reason(shift, email, emp, ctx)
    if why:
        if e.event_id:
            _remove_event(graph, upn, e.event_id)
            out["deleted"] += 1
        e.event_id, e.synced_hash = "", ""
        e.state, e.last_error, e.updated_at = "skipped", why, stamp
        out["skipped"] += 1
        return
    cfg = ctx.settings(emp.company or "")
    preset = ctx.preset(shift.shift_id)
    payload = event_payload(shift, preset, shift_zone(shift, preset, cfg.get("timeZone") or _DEFAULT_TZ),
                            cfg.get("outlookShowAs") or "free",
                            ctx.group_name(getattr(shift, "group_id", "") or ""),
                            ctx.site_name(getattr(shift, "group_id", "") or ""))
    h = _hash(payload, upn)
    if e.event_id and h == e.synced_hash:
        e.state, e.last_error, e.updated_at = "ok", "", stamp
        out["unchanged"] += 1
        return
    if e.event_id:
        body = {k: v for k, v in payload.items() if k != "transactionId"}
        status, data = graph("PATCH", f"/users/{upn}/events/{e.event_id}", body)
        _check(status, data, "update")
        if status == 404:
            e.event_id = ""   # the person deleted it from their calendar: make it again
        else:
            out["updated"] += 1
    if not e.event_id:
        # A recreate carries a fresh transactionId: Graph remembers the one
        # the first create used for that mailbox.
        create = dict(payload)
        if e.synced_hash:
            create["transactionId"] = f"{shift.id}.{int(now.timestamp())}"
        status, data = graph("POST", f"/users/{upn}/events", create)
        _check(status, data, "create")
        if status == 404:
            raise GraphError("Graph answered 404 on create: the mailbox was not found")
        e.event_id = str((data or {}).get("id") or "")
        if not e.event_id:
            raise GraphError("Graph created the event but returned no id")
        out["created"] += 1
    e.synced_hash, e.synced_at = h, stamp
    e.state, e.last_error, e.updated_at = "ok", "", stamp


def sync_once(db: Session, now: datetime = None, graph=None) -> dict:
    """One tick: up to BATCH queued rows (pending, delete, and errors older
    than ERROR_RETRY_SEC). Commits after every row, so a failure in the
    middle keeps what was done. Returns the counts; `disabled` carries the
    reason when the sync is paused."""
    global _disabled_until, _disabled_reason, _backfill_checked
    now = now or datetime.now(timezone.utc)
    out = {"processed": 0, "created": 0, "updated": 0, "unchanged": 0, "deleted": 0, "skipped": 0,
           "errors": 0, "disabled": ""}
    if not _backfill_checked:
        _backfill_checked = True
        if db.query(models.ShiftCalendarEvent.id).first() is None:
            out["backfilled"] = enqueue_all_upcoming(db)
            db.commit()
    if _disabled_until > time.monotonic():
        out["disabled"] = _disabled_reason
        return out
    if graph is None:
        import graph_mail
        if not graph_mail.graph_configured():
            out["disabled"] = "Microsoft Graph is not configured (AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET)."
            return out
        graph = _graph_call
    retry_before = _now_iso(now - timedelta(seconds=ERROR_RETRY_SEC))
    E = models.ShiftCalendarEvent
    rows = (db.query(E)
            .filter((E.state.in_(["pending", "delete"])) | ((E.state == "error") & (E.updated_at < retry_before)))
            .order_by(E.updated_at, E.id).limit(BATCH).all())
    if not rows:
        return out
    ctx = _Ctx(db)
    for e in rows:
        try:
            _sync_row(db, e, ctx, graph, now, out)
        except GraphDenied as d:
            db.rollback()
            _disabled_until, _disabled_reason = time.monotonic() + RETRY_SEC, str(d)
            out["disabled"] = str(d)
            print(f"[shift-calendar] paused: {d}")
            break
        except Exception as ex:   # noqa: BLE001 - one bad row must not stop the queue
            db.rollback()
            e.state, e.last_error, e.updated_at = "error", str(ex)[:300], _now_iso(now)
            out["errors"] += 1
        out["processed"] += 1
        db.commit()
    return out


def status(db: Session) -> dict:
    """For administrators: whether the sync can run, why not, and the
    queue by state."""
    import graph_mail
    counts = {s: 0 for s in STATES}
    for state, n in _counts(db).items():
        counts[state] = n
    paused = _disabled_until > time.monotonic()
    configured = graph_mail.graph_configured()
    reason = (_disabled_reason if paused else "" if configured else
              "Microsoft Graph is not configured (AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET).")
    return {"enabled": configured and not paused, "reason": reason, "setupDoc": SETUP_DOC,
            "pending": counts["pending"] + counts["delete"], "ok": counts["ok"],
            "errors": counts["error"], "skipped": counts["skipped"]}


def _counts(db: Session) -> dict:
    from sqlalchemy import func
    E = models.ShiftCalendarEvent
    return {s: int(n) for s, n in db.query(E.state, func.count(E.id)).group_by(E.state).all()}


def _tick() -> dict:
    db = SessionLocal()
    try:
        return sync_once(db)
    except Exception as e:   # noqa: BLE001 - a bad tick must not kill the loop
        db.rollback()
        print(f"[shift-calendar] sync failed: {e}")
        return {}
    finally:
        db.close()


async def calendar_sync_loop():
    """Started from main.py's lifespan on the elected leader, beside
    noshow_loop. Every Graph call and DB query runs in a thread; nothing
    here touches the event loop."""
    await asyncio.sleep(150)
    while True:
        s = await asyncio.to_thread(_tick)
        if s and (s.get("created") or s.get("updated") or s.get("deleted") or s.get("errors") or s.get("backfilled")):
            print(f"[shift-calendar] {s}")
        await asyncio.sleep(SYNC_SEC)
