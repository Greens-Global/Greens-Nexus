"""Customizable dashboards: saveable drag-and-drop widget layouts (personal +
manager-published department templates) and a single KPI aggregate endpoint the
widgets read from. Kept separate from the legacy /dashboard/summary router."""
import re
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from pydantic import BaseModel
from sqlalchemy.orm import Session

import cache
import models
from database import get_db
from routers.task_util import task_assignees
from auth import get_current_user

router = APIRouter(prefix="/dashboards", tags=["Dashboards"], dependencies=[Depends(get_current_user)])

# Manager Dashboard folded into the one Dashboard (Sep 3) - widgets are gated
# per-widget by minRole instead of a whole second board. 'manager-dashboard'
# stays out of _TARGETS so no new view can be created against it; the startup
# migration (main.py) already relabeled every existing row to 'dashboard'.
_TARGETS = ("dashboard",)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dept_of(email: str, db: Session) -> str:
    row = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == email).first()
    return (row.department or "") if row else ""


def _view_dict(v: models.DashboardView) -> dict:
    return {
        "id": v.id, "target": v.target, "name": v.name, "scope": v.scope,
        "department": v.department or "", "layout": v.layout or [],
        "isDefault": bool(v.is_default), "createdBy": v.created_by or "",
        "updatedAt": v.updated_at or "",
    }


# ── Views ─────────────────────────────────────────────────────────────────────

class ViewIn(BaseModel):
    target: str = "dashboard"
    name: str = "My view"
    layout: list = []
    scope: Optional[str] = "personal"       # personal | department
    department: Optional[str] = ""           # required when scope=department
    is_default: Optional[bool] = False


@router.get("/views")
def list_views(target: str = "dashboard", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The user's own personal views for the target PLUS any department template
    published for their department. The frontend picks a default (the user's
    is_default personal view, else a matching department template)."""
    if target not in _TARGETS:
        raise HTTPException(400, "bad target")
    email = user["email"]
    dept = _dept_of(email, db)
    personal = (db.query(models.DashboardView)
                .filter(models.DashboardView.owner_email == email,
                        models.DashboardView.scope == "personal",
                        models.DashboardView.target == target)
                .order_by(models.DashboardView.created_at).all())
    dept_q = db.query(models.DashboardView).filter(
        models.DashboardView.scope == "department",
        models.DashboardView.target == target)
    # Members see only their department's template; managers+ see all (to manage).
    if user["level"] < 3 and dept:
        dept_q = dept_q.filter(models.DashboardView.department == dept)
    presets = dept_q.order_by(models.DashboardView.created_at).all()
    return {
        "views": [_view_dict(v) for v in personal] + [_view_dict(v) for v in presets],
        "department": dept,
        "canPublish": user["level"] >= 3,
    }


@router.post("/views")
def create_view(body: ViewIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if body.target not in _TARGETS:
        raise HTTPException(400, "bad target")
    scope = body.scope if body.scope in ("personal", "department") else "personal"
    if scope == "department" and user["level"] < 3:
        raise HTTPException(403, "Only managers can publish department views")
    v = models.DashboardView(
        id=str(uuid.uuid4()),
        owner_email="" if scope == "department" else user["email"],
        target=body.target, name=(body.name or "My view")[:80], scope=scope,
        department=(body.department or _dept_of(user["email"], db)) if scope == "department" else "",
        layout=body.layout or [], is_default=bool(body.is_default),
        created_by=user["email"], created_at=_now(), updated_at=_now())
    if v.is_default and scope == "personal":
        _clear_defaults(db, user["email"], body.target)
    db.add(v)
    db.commit()
    return _view_dict(v)


class ViewUpdate(BaseModel):
    name: Optional[str] = None
    layout: Optional[list] = None
    is_default: Optional[bool] = None


@router.put("/views/{view_id}")
def update_view(view_id: str, body: ViewUpdate, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    v = db.query(models.DashboardView).filter(models.DashboardView.id == view_id).first()
    if not v:
        raise HTTPException(404, "View not found")
    _guard_write(v, user)
    if body.name is not None:
        v.name = body.name[:80]
    if body.layout is not None:
        v.layout = body.layout
    if body.is_default is not None and v.scope == "personal":
        if body.is_default:
            _clear_defaults(db, v.owner_email, v.target)
        v.is_default = bool(body.is_default)
    v.updated_at = _now()
    db.commit()
    return _view_dict(v)


@router.put("/views/{view_id}/default")
def set_default(view_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    v = db.query(models.DashboardView).filter(models.DashboardView.id == view_id,
                                              models.DashboardView.owner_email == user["email"]).first()
    if not v:
        raise HTTPException(404, "View not found")
    _clear_defaults(db, user["email"], v.target)
    v.is_default = True
    v.updated_at = _now()
    db.commit()
    return {"ok": True}


@router.delete("/views/{view_id}")
def delete_view(view_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    v = db.query(models.DashboardView).filter(models.DashboardView.id == view_id).first()
    if not v:
        raise HTTPException(404, "View not found")
    _guard_write(v, user)
    db.delete(v)
    db.commit()
    return {"ok": True}


def _guard_write(v: models.DashboardView, user: dict):
    if v.scope == "department":
        # Only the manager who published a department view (or an admin) may
        # edit/delete it - members and other managers cannot.
        if user["level"] < 3:
            raise HTTPException(403, "Only managers can edit department views")
        if v.created_by != user["email"] and user["level"] < 4:
            raise HTTPException(403, "Only the publisher of this view can change it")
    elif v.owner_email != user["email"]:
        raise HTTPException(403, "Not your view")


def _clear_defaults(db: Session, owner_email: str, target: str):
    for row in db.query(models.DashboardView).filter(
            models.DashboardView.owner_email == owner_email,
            models.DashboardView.target == target,
            models.DashboardView.is_default.is_(True)).all():
        row.is_default = False


# ── KPI aggregate ─────────────────────────────────────────────────────────────

@router.get("/kpis")
def kpis(scope: str = "self", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Every KPI a widget might show, each computed defensively (0 on any error)
    so one broken metric never fails the whole dashboard. scope 'team' unlocks
    manager metrics for level>=2."""
    email = user["email"]
    team = scope == "team" and user["level"] >= 2

    # A dozen COUNT queries per call; cached per (email, team) for a short TTL so
    # a dashboard full of widgets (and its poll) doesn't recompute every load, and
    # single-flight collapses the concurrent burst into one DB pass. Counts are
    # glanceable, so ~20s staleness is fine (see cache.dashboard_kpis).
    def _compute() -> dict:
        out: dict[str, int] = {}

        def safe(key, fn):
            try:
                out[key] = int(fn())
            except Exception as e:
                # Still 0 - one broken count must not take the whole dashboard
                # down. But it is LOUD now: my_open_tasks read 0 for everyone
                # for as long as it existed because it filtered on a column that
                # does not exist, and a silent zero is a believable answer, so
                # nobody could tell it apart from "you have no tasks".
                print(f"[dashboards] KPI {key} failed, reporting 0: {type(e).__name__}: {e}")
                out[key] = 0

        M = models
        # `completed` (the boolean the module actually toggles), not a status
        # string. Task.status is not_started/in_progress/completed plus each
        # project's own custom board-column ids, so comparing it against
        # "Completed" matched nothing and counted done tasks as open.
        safe("open_tasks", lambda: db.query(M.Task).filter(M.Task.completed == False).count())  # noqa: E712
        safe("pending_requisitions", lambda: db.query(M.Requisition).filter(M.Requisition.status == "pending_manager").count())
        safe("pending_inventory", lambda: db.query(M.ItemCheckout).filter(M.ItemCheckout.status == "pending").count())
        safe("open_purchases", lambda: db.query(M.PurchaseRequest).filter(M.PurchaseRequest.status == "pending").count())
        safe("my_checkouts", lambda: db.query(M.ItemCheckout).filter(
            M.ItemCheckout.requested_by_email == email,
            M.ItemCheckout.status.in_(["approved", "allocated", "pending_receipt"])).count())
        safe("my_assignments", lambda: db.query(M.ItemAssignment).filter(
            M.ItemAssignment.assignee_email == email, M.ItemAssignment.status == "active").count())
        # Task.assignee does not exist - the column is assignee_email. The
        # attribute error was caught by safe() and turned into 0, so the hero
        # card on every dashboard read "0 Open tasks / Assigned to you" for
        # everyone, forever, while the same person's My Tasks listed plenty.
        # A KPI that silently degrades to zero is worse than one that errors:
        # zero is a believable answer.
        # Counted in Python because a task can now be assigned to several
        # people and assignee_emails is a JSON list - see the daily-briefing
        # note for why there is no portable SQL containment predicate here. The
        # completed filter keeps the row set to open work only.
        safe("my_open_tasks", lambda: sum(
            1 for t in db.query(M.Task).filter(M.Task.completed == False).all()  # noqa: E712
            if email in task_assignees(t)))
        safe("unread_notifications", lambda: db.query(M.NexusNotification).filter(
            M.NexusNotification.recipient == email).count())

        def warranties():
            cutoff = (datetime.now(timezone.utc) + timedelta(days=30)).strftime("%Y-%m-%d")
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            return db.query(M.HardwareAsset).filter(
                M.HardwareAsset.warranty_end != "",
                M.HardwareAsset.warranty_end <= cutoff,
                M.HardwareAsset.warranty_end >= today).count()
        safe("warranties_expiring", warranties)

        def clocked_in():
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            rows = (db.query(M.TimePunch)
                    .filter(M.TimePunch.local_date == today)
                    .order_by(M.TimePunch.at).all())
            latest: dict[str, str] = {}
            for p in rows:
                latest[p.employee_email] = p.kind
            return sum(1 for k in latest.values() if k != "out")
        if team:
            safe("clocked_in_now", clocked_in)
            safe("time_off_pending", lambda: db.query(M.TimeOffRequest).filter(M.TimeOffRequest.status == "pending").count())
        return out

    out = cache.dashboard_kpis.get_or_load((email, team), _compute)
    return {"kpis": out, "at": _now()}


# ── My Agenda (Outlook calendar via Graph) ────────────────────────────────────

# Per (email, window) for a couple of minutes so a dashboard remount doesn't
# hit Graph again - an agenda is glanceable, not realtime.
_agenda_cache = cache.TTLCache("dashboard_agenda", ttl=120)

_TZ_OK = re.compile(r"^[A-Za-z0-9_+\-/ ]{1,64}$")
_ISO_OK = re.compile(r"^[0-9T:.+\-Z]{10,40}$")


def agenda_window_to_utc(s: str, tz: str) -> str:
    """A wall-clock ISO string (naive, no offset) interpreted as local time in
    `tz`, converted to a UTC ISO string with a trailing Z. An already-absolute
    string (has an offset or trailing Z) passes through unchanged (just
    re-expressed in UTC) - only a naive string gets the `tz` interpretation
    applied. Falls back to treating `tz` as UTC if it isn't a real IANA zone
    name, and returns the input unchanged if it isn't parseable at all.

    Graph's calendarView startDateTime/endDateTime query params are parsed as
    UTC when the string carries no offset - the Prefer: outlook.timezone
    header on the request only controls how the RETURNED event times are
    formatted, it does not change how the query window itself is interpreted.
    Sending a naive "local midnight" string straight through silently shifted
    the query window by the caller's UTC offset (up to a full day for zones
    like Pacific/India), pulling in - or dropping - events from the wrong day,
    which then rendered under the wrong Today/Tomorrow header in My Agenda
    (Neil, Aug 31: an already-past event still showing as "Tomorrow").
    """
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        zone = timezone.utc
    try:
        dt = datetime.fromisoformat((s or "").replace("Z", "+00:00"))
    except ValueError:
        return s
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=zone)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@router.get("/agenda")
def agenda(start: str = "", end: str = "", tz: str = "UTC",
           user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The caller's OWN Outlook agenda for a day window, read with the app's
    Graph credential (same registration the HR provisioning/interview flows
    use). Only for M365 staff: the People directory's identity_type must be
    'internal' - guests and external HR-record-only people have no mailbox in
    the tenant, so for them (and when Graph/consent is unavailable) this
    returns {available: false} and the widget stays quiet instead of erroring."""
    email = user["email"].lower()
    emp = (db.query(models.NexusEmployee)
           .filter(func.lower(models.NexusEmployee.work_email) == email).first())
    if not emp or (emp.identity_type or "internal") != "internal":
        return {"available": False, "reason": "not_m365"}

    # The client sends its local day window; defaults cover a headless call.
    # These defaults ARE already UTC - tagged with a trailing Z so the
    # wall-clock conversion below (which only applies to naive strings)
    # leaves them alone instead of re-interpreting them as local time.
    if not _ISO_OK.match(start or ""):
        start = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00Z")
    if not _ISO_OK.match(end or ""):
        end = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%dT23:59:59Z")
    if not _TZ_OK.match(tz or ""):
        tz = "UTC"

    # See agenda_window_to_utc's docstring: the naive local window the client
    # sends must be converted to real UTC before it goes to Graph.
    start_utc, end_utc = agenda_window_to_utc(start, tz), agenda_window_to_utc(end, tz)

    def _load() -> dict:
        from routers.hr import _graph_token, _GRAPH
        try:
            token = _graph_token()
        except Exception:
            return {"available": False, "reason": "not_configured"}
        try:
            r = httpx.get(
                f"{_GRAPH}/users/{email}/calendarView",
                params={"startDateTime": start_utc, "endDateTime": end_utc,
                        "$orderby": "start/dateTime", "$top": "15",
                        "$select": "subject,start,end,location,isAllDay,isCancelled,onlineMeeting,webLink"},
                headers={"Authorization": f"Bearer {token}",
                         # Times come back already in the user's zone - no
                         # client-side UTC conversion to get wrong.
                         "Prefer": f'outlook.timezone="{tz}"'},
                timeout=15,
            )
        except Exception:
            return {"available": False, "reason": "graph_unreachable"}
        if r.status_code == 403:
            # App consent missing: needs Calendars.Read (application) in Entra.
            return {"available": False, "reason": "no_consent"}
        if not r.is_success:
            # 404 = no mailbox behind this account (unlicensed/shared identity).
            return {"available": False, "reason": "no_mailbox"}
        events = [{
            "subject": ev.get("subject") or "(No subject)",
            "start": (ev.get("start") or {}).get("dateTime", ""),
            "end": (ev.get("end") or {}).get("dateTime", ""),
            "isAllDay": bool(ev.get("isAllDay")),
            "location": ((ev.get("location") or {}).get("displayName") or ""),
            "joinUrl": ((ev.get("onlineMeeting") or {}).get("joinUrl") or ""),
            "webLink": ev.get("webLink") or "",
        } for ev in r.json().get("value", []) if not ev.get("isCancelled")]
        return {"available": True, "events": events}

    out = _agenda_cache.get_or_load((email, start, end, tz), _load)
    return {**out, "at": _now()}
