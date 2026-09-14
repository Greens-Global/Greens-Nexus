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
import auth
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
        # Company-wide, same as pending_requisitions/open_purchases above (not
        # a "my" metric) - feeds the BI board's cross-module view of Support.
        safe("open_tickets", lambda: db.query(M.TaskTicket).filter(
            M.TaskTicket.status.notin_(["resolved", "closed"])).count())

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


# ── BI insights (Neil, Sep 14) ──────────────────────────────────────────────
# "From every module take all the data which needs to be in watch of the
# management level" - one company-wide payload (never per-viewer - see
# cache.dashboard_insights) of real per-module numbers, not the personal
# /kpis feed. Each module block is `safe`-guarded independently so one wrong
# query (a bad status string, a renamed column) degrades that one card to
# zeros instead of blanking the whole board - same defensive shape as /kpis.
def _safe_insight(modules: list, mod_id: str, label: str, nav: str, fn):
    try:
        block = fn()
    except Exception as e:
        print(f"[dashboards] insight module {mod_id} failed: {type(e).__name__}: {e}")
        block = {"stats": [], "breakdown": []}
    modules.append({"id": mod_id, "label": label, "nav": nav, **block})


@router.get("/insights")
def insights(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if user["level"] < 2:
        raise HTTPException(403, "Manager access required")
    M = models

    def _compute() -> dict:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
        week_ahead = (datetime.now(timezone.utc) + timedelta(days=7)).strftime("%Y-%m-%d")
        month_ahead = (datetime.now(timezone.utc) + timedelta(days=30)).strftime("%Y-%m-%d")
        ninety_ahead = (datetime.now(timezone.utc) + timedelta(days=90)).strftime("%Y-%m-%d")
        month_start = datetime.now(timezone.utc).strftime("%Y-%m-01")
        # Multi-company tenant wall (see auth.company_scope): None = unrestricted
        # (walls off, or a Global Admin), else the exact set of HrEntity ids this
        # caller may see. Every block below that reads a company_id-bearing table
        # must apply this the same way its own module's real list endpoint does,
        # or the BI number and that module's own screen disagree (see the Tasks
        # fix, Sep 14 - it queried Task rows with no wall and no subtask/section
        # exclusion, which both inflated its counts past the real ones).
        _cscope = auth.company_scope(user, db)
        modules: list = []

        def tasks_block():
            # Must match the Tasks module's own Reporting tab exactly (see
            # frontend/src/tasks/lib.js topLevel()/taskStats()) or the two
            # screens disagree: a subtask/section is not a task for counting
            # purposes (topLevel excludes parent_task_id set and type
            # 'section'), and the company wall applies here too - the
            # Reporting tab gets it for free because /tasks/delta already
            # walls the rows before they reach the client. Counting raw
            # Task rows without either massively over-counted "Open" (every
            # subtask row added to the total) and over-counted "Overdue"
            # by the same mechanism, plus whatever cross-company rows the
            # wall would have excluded.
            from routers.task_util import wall_tasks
            rows = wall_tasks(db, user, db.query(M.Task).filter(
                M.Task.deleted_at == "", M.Task.type != "section", M.Task.parent_task_id == "").all())
            overdue = sum(1 for t in rows if not t.completed and t.due_on and t.due_on < today)
            upcoming = sum(1 for t in rows if not t.completed and t.due_on and today <= t.due_on <= week_ahead)
            completed_7d = sum(1 for t in rows if t.completed and t.completed_at >= week_ago)
            open_total = sum(1 for t in rows if not t.completed)
            on_track = max(0, open_total - overdue)
            return {
                "stats": [
                    {"key": "overdue", "label": "Overdue", "value": overdue, "tone": "critical"},
                    {"key": "upcoming", "label": "Due This Week", "value": upcoming, "tone": "warning"},
                    {"key": "completed_7d", "label": "Completed (7d)", "value": completed_7d, "tone": "good"},
                    {"key": "open_total", "label": "Open", "value": open_total, "tone": "neutral"},
                ],
                "breakdown": [
                    {"label": "On Track", "value": on_track, "tone": "neutral"},
                    {"label": "Overdue", "value": overdue, "tone": "critical"},
                    {"label": "Completed (7d)", "value": completed_7d, "tone": "good"},
                ],
            }
        _safe_insight(modules, "tasks", "Tasks", "tasks", tasks_block)

        def attendance_block():
            total_active = db.query(M.NexusEmployee).filter(M.NexusEmployee.status == "active").count()
            rows = (db.query(M.TimePunch)
                    .filter(M.TimePunch.local_date == today)
                    .order_by(M.TimePunch.at).all())
            latest: dict[str, str] = {}
            for p in rows:
                latest[p.employee_email] = p.kind
            working = sum(1 for k in latest.values() if k == "in")
            on_break = sum(1 for k in latest.values() if k == "break_start")
            clocked_in = working + on_break
            not_clocked_in = max(0, total_active - clocked_in)
            # 7-day trend: distinct employees with an in-punch each day - a
            # real line, not a single snapshot. Small table, cheap to scan.
            day_list = [(datetime.now(timezone.utc) - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(6, -1, -1)]
            week_rows = db.query(M.TimePunch.local_date, M.TimePunch.employee_email).filter(
                M.TimePunch.local_date >= day_list[0], M.TimePunch.kind == "in").all()
            by_day: dict[str, set] = {}
            for d, email in week_rows:
                by_day.setdefault(d, set()).add(email)
            trend = [{"label": d[5:], "value": len(by_day.get(d, ()))} for d in day_list]
            return {
                "stats": [
                    {"key": "clocked_in", "label": "Clocked In", "value": clocked_in, "tone": "good"},
                    {"key": "on_break", "label": "On Break", "value": on_break, "tone": "warning"},
                    {"key": "not_clocked_in", "label": "Not Clocked In", "value": not_clocked_in, "tone": "neutral"},
                ],
                "breakdown": [
                    {"label": "Working", "value": working, "tone": "good"},
                    {"label": "On Break", "value": on_break, "tone": "warning"},
                    {"label": "Not Clocked In", "value": not_clocked_in, "tone": "neutral"},
                ],
                "trend": trend,
            }
        _safe_insight(modules, "attendance", "Time & Attendance", "employee-tracking", attendance_block)

        def tickets_block():
            live = db.query(M.TaskTicket)
            if _cscope is not None:
                live = live.filter(M.TaskTicket.company_id.in_(_cscope))
            closed_states = ["resolved", "closed"]
            open_q = live.filter(M.TaskTicket.status.notin_(closed_states))
            open_count = open_q.count()
            closed = live.filter(M.TaskTicket.status == "closed").count()
            resolved = live.filter(M.TaskTicket.status == "resolved").count()
            unassigned = open_q.filter(M.TaskTicket.assignee_email == "").count()
            # Mirrors _sla_breached in routers/tickets.py: no due date, or
            # already resolved/closed, never counts as breached.
            sla_breached = open_q.filter(M.TaskTicket.sla_due_on != "", M.TaskTicket.sla_due_on < today).count()
            waiting = live.filter(M.TaskTicket.status.in_(["waiting_user", "waiting_vendor", "on_hold"])).count()
            active_open = max(0, open_count - waiting)
            return {
                "stats": [
                    {"key": "open", "label": "Open", "value": open_count, "tone": "warning"},
                    {"key": "unassigned", "label": "Unassigned", "value": unassigned, "tone": "critical"},
                    {"key": "sla_breached", "label": "SLA Breached", "value": sla_breached, "tone": "critical"},
                    {"key": "resolved", "label": "Resolved", "value": resolved, "tone": "good"},
                    {"key": "closed", "label": "Closed", "value": closed, "tone": "neutral"},
                ],
                "breakdown": [
                    {"label": "Active", "value": active_open, "tone": "warning"},
                    {"label": "Waiting", "value": waiting, "tone": "neutral"},
                    {"label": "Resolved", "value": resolved, "tone": "good"},
                    {"label": "Closed", "value": closed, "tone": "neutral"},
                ],
            }
        _safe_insight(modules, "tickets", "Tickets", "tickets", tickets_block)

        def kb_block():
            live = db.query(M.KbDocument)
            draft = live.filter(M.KbDocument.status == "draft").count()
            in_review = live.filter(M.KbDocument.status == "in_review").count()
            changes = live.filter(M.KbDocument.status == "changes_requested").count()
            approved = live.filter(M.KbDocument.status == "approved").count()
            archived = live.filter(M.KbDocument.status == "archived").count()
            return {
                "stats": [
                    {"key": "pending_review", "label": "Pending Review", "value": in_review, "tone": "warning"},
                    {"key": "changes_requested", "label": "Changes Requested", "value": changes, "tone": "critical"},
                    {"key": "published", "label": "Published", "value": approved, "tone": "good"},
                    {"key": "draft", "label": "In Draft", "value": draft, "tone": "neutral"},
                ],
                "breakdown": [
                    {"label": "Draft", "value": draft, "tone": "neutral"},
                    {"label": "Pending Review", "value": in_review + changes, "tone": "warning"},
                    {"label": "Published", "value": approved, "tone": "good"},
                    {"label": "Archived", "value": archived, "tone": "neutral"},
                ],
            }
        _safe_insight(modules, "knowledge_base", "Knowledge Base", "sop", kb_block)

        def ops_block():
            req_q = db.query(M.Requisition).filter(M.Requisition.status == "pending_manager")
            if _cscope is not None:
                req_q = req_q.filter(M.Requisition.company_id.in_(_cscope))
            return {
                "stats": [
                    {"key": "pending_requisitions", "label": "Requisitions to Approve", "value": req_q.count(), "tone": "warning"},
                    {"key": "open_purchases", "label": "Open Purchases", "value": db.query(M.PurchaseRequest).filter(M.PurchaseRequest.status == "pending").count(), "tone": "warning"},
                    {"key": "pending_inventory", "label": "Inventory Requests", "value": db.query(M.ItemCheckout).filter(M.ItemCheckout.status == "pending").count(), "tone": "warning"},
                ],
                "breakdown": [],
            }
        _safe_insight(modules, "operations", "Item Management", "inventory", ops_block)

        def documents_block():
            docs = db.query(M.Document)
            draft = docs.filter(M.Document.status == "draft").count()
            final = docs.filter(M.Document.status == "final").count()
            archived = docs.filter(M.Document.status == "archived").count()
            sign = db.query(M.HrSignRequest)
            pending_sig = sign.filter(M.HrSignRequest.status == "pending").count()
            completed_7d = sign.filter(M.HrSignRequest.status == "completed", M.HrSignRequest.completed_at >= week_ago).count()
            # declined/voided/expired all mean "this envelope needs a human to
            # act" - resend, chase a party, or clean it up - so they're grouped
            # for the management view rather than split three ways.
            needs_attention = sign.filter(M.HrSignRequest.status.in_(["declined", "voided", "expired"])).count()
            return {
                "stats": [
                    {"key": "pending_signatures", "label": "Pending Signatures", "value": pending_sig, "tone": "warning"},
                    {"key": "signed_7d", "label": "Signed (7d)", "value": completed_7d, "tone": "good"},
                    {"key": "needs_attention", "label": "Declined / Expired", "value": needs_attention, "tone": "critical"},
                    {"key": "total_documents", "label": "Documents", "value": draft + final + archived, "tone": "neutral"},
                ],
                "breakdown": [
                    {"label": "Draft", "value": draft, "tone": "neutral"},
                    {"label": "Final", "value": final, "tone": "good"},
                    {"label": "Archived", "value": archived, "tone": "neutral"},
                ],
            }
        _safe_insight(modules, "documents", "Documents", "documents", documents_block)

        def it_block():
            sites = db.query(M.Website)
            sites_down = sites.filter(M.Website.status != "Online").count()
            ssl_expiring = sites.filter(M.Website.ssl_days <= 30).count()
            hw = db.query(M.HardwareAsset)
            hw_unassigned = hw.filter(M.HardwareAsset.assigned_to == "Unassigned").count()
            warranties_expiring = hw.filter(
                M.HardwareAsset.warranty_end != "", M.HardwareAsset.warranty_end >= today,
                M.HardwareAsset.warranty_end <= month_ahead).count()
            return {
                "stats": [
                    {"key": "sites_down", "label": "Sites Down / Degraded", "value": sites_down, "tone": "critical"},
                    {"key": "ssl_expiring", "label": "SSL Expiring (30d)", "value": ssl_expiring, "tone": "warning"},
                    {"key": "warranties_expiring", "label": "Warranties Expiring (30d)", "value": warranties_expiring, "tone": "warning"},
                    {"key": "hw_unassigned", "label": "Unassigned Hardware", "value": hw_unassigned, "tone": "neutral"},
                ],
                "breakdown": [],
            }
        _safe_insight(modules, "it", "IT", "it", it_block)

        def construction_block():
            proj = db.query(M.ConstructionProject).filter(M.ConstructionProject.deleted_at == "")
            active = proj.filter(M.ConstructionProject.status == "active").count()
            on_hold = proj.filter(M.ConstructionProject.status == "on_hold").count()
            logs_pending = db.query(M.ConstructionDailyLog).filter(
                M.ConstructionDailyLog.status == "submitted", M.ConstructionDailyLog.deleted_at == "").count()
            overdue_rfis = db.query(M.ConstructionRfi).filter(
                M.ConstructionRfi.status == "open", M.ConstructionRfi.due_on != "", M.ConstructionRfi.due_on < today).count()
            pending_submittals = db.query(M.ConstructionSubmittal).filter(
                M.ConstructionSubmittal.status.in_(["pending", "submitted"]), M.ConstructionSubmittal.deleted_at == "").count()
            at_risk_milestones = db.query(M.ConstructionMilestone).filter(
                M.ConstructionMilestone.status.in_(["at_risk", "missed"]), M.ConstructionMilestone.deleted_at == "").count()
            return {
                "stats": [
                    {"key": "active_projects", "label": "Active Projects", "value": active, "tone": "good"},
                    {"key": "logs_pending", "label": "Logs Pending Review", "value": logs_pending, "tone": "warning"},
                    {"key": "overdue_rfis", "label": "Overdue RFIs", "value": overdue_rfis, "tone": "critical"},
                    {"key": "pending_submittals", "label": "Pending Submittals", "value": pending_submittals, "tone": "warning"},
                    {"key": "at_risk_milestones", "label": "At-Risk Milestones", "value": at_risk_milestones, "tone": "critical"},
                ],
                "breakdown": [
                    {"label": "Active", "value": active, "tone": "good"},
                    {"label": "On Hold", "value": on_hold, "tone": "warning"},
                ],
            }
        _safe_insight(modules, "construction", "Construction", "ops", construction_block)

        def asset_block():
            total_props = db.query(M.PropertyAsset).filter(M.PropertyAsset.parent_id == "").count()
            # Warranties/inspections live as generic {collection, payload} rows
            # (see routers/property_assets.py) - same date fields and windows
            # scan_reminders() already uses for the bell, read straight rather
            # than re-derived, so this can never drift from what that scan flags.
            records = db.query(M.PropertyRecord).filter(M.PropertyRecord.collection.in_(["warranties", "inspections"])).all()
            warranties_expiring = sum(
                1 for r in records if r.collection == "warranties"
                and (r.payload or {}).get("expiration", "")[:10] and (r.payload or {}).get("expiration", "")[:10] <= ninety_ahead)
            inspections_due = sum(
                1 for r in records if r.collection == "inspections"
                and (r.payload or {}).get("nextDue", "")[:10] and (r.payload or {}).get("nextDue", "")[:10] <= month_ahead)
            return {
                "stats": [
                    {"key": "total_properties", "label": "Properties", "value": total_props, "tone": "neutral"},
                    {"key": "warranties_expiring", "label": "Warranties Expiring (90d)", "value": warranties_expiring, "tone": "warning"},
                    {"key": "inspections_due", "label": "Inspections Due (30d)", "value": inspections_due, "tone": "critical"},
                ],
                "breakdown": [],
            }
        _safe_insight(modules, "asset_management", "Asset Management", "property-asset", asset_block)

        def people_block():
            headcount = db.query(M.NexusEmployee).filter(M.NexusEmployee.status == "active").count()
            pipeline = db.query(M.HrCandidate).filter(M.HrCandidate.stage.notin_(["hired", "rejected"]))
            if _cscope is not None:
                pipeline = pipeline.filter(M.HrCandidate.company.in_(_cscope))
            open_candidates = pipeline.count()
            interviews_7d = pipeline.filter(
                M.HrCandidate.interview_at != "", M.HrCandidate.interview_at >= today,
                M.HrCandidate.interview_at <= week_ahead + "T23:59:59").count()
            leave_pending = db.query(M.HrLeaveRequest).filter(M.HrLeaveRequest.status == "pending").count()
            docs_expiring = db.query(M.HrDocument).filter(
                M.HrDocument.expires_on != "", M.HrDocument.expires_on >= today, M.HrDocument.expires_on <= month_ahead).count()
            # Current pipeline distribution by stage (not a cumulative "ever
            # reached" funnel - HrCandidate only tracks a candidate's CURRENT
            # stage, not history - but the current headcount at each stage,
            # in order, is exactly the shape a funnel visual is for).
            stage_order = [("applied", "Applied"), ("screening", "Screening"),
                           ("interview", "Interview"), ("offer", "Offer"), ("hired", "Hired")]
            stage_counts = {s: 0 for s, _ in stage_order}
            stage_q = db.query(M.HrCandidate.stage).filter(M.HrCandidate.stage != "rejected")
            if _cscope is not None:
                stage_q = stage_q.filter(M.HrCandidate.company.in_(_cscope))
            for (stage,) in stage_q.all():
                if stage in stage_counts:
                    stage_counts[stage] += 1
            funnel = [{"label": label, "value": stage_counts[s]} for s, label in stage_order]
            return {
                "stats": [
                    {"key": "headcount", "label": "Active Headcount", "value": headcount, "tone": "neutral"},
                    {"key": "open_candidates", "label": "In Hiring Pipeline", "value": open_candidates, "tone": "warning"},
                    {"key": "interviews_7d", "label": "Interviews This Week", "value": interviews_7d, "tone": "neutral"},
                    {"key": "leave_pending", "label": "Leave to Approve", "value": leave_pending, "tone": "warning"},
                    {"key": "docs_expiring", "label": "Employee Docs Expiring (30d)", "value": docs_expiring, "tone": "critical"},
                ],
                "breakdown": [],
                "funnel": funnel,
            }
        _safe_insight(modules, "people", "People", "hr", people_block)

        def vault_block():
            creds = db.query(M.VaultCredential).filter(M.VaultCredential.deleted_at == "")
            total = creds.count()
            weak = creds.filter(M.VaultCredential.strength == "weak").count()
            breached = creds.filter(M.VaultCredential.breached == True).count()  # noqa: E712
            pending_shares = db.query(M.VaultShareRequest).filter(M.VaultShareRequest.status == "pending").count()
            # rotation_max is per-credential, so this needs real date math per
            # row, not a single SQL window - same pattern as the reminders scan
            # in routers/property_assets.py (small table, fine to load + loop).
            rotation_overdue = 0
            for c in creds.filter(M.VaultCredential.rotated_at != "").all():
                try:
                    rotated = datetime.fromisoformat(c.rotated_at.replace("Z", "+00:00"))
                    if rotated.tzinfo is None:
                        rotated = rotated.replace(tzinfo=timezone.utc)
                    if (datetime.now(timezone.utc) - rotated).days > (c.rotation_max or 90):
                        rotation_overdue += 1
                except Exception:
                    continue
            return {
                "stats": [
                    {"key": "breached", "label": "Breached Credentials", "value": breached, "tone": "critical"},
                    {"key": "weak", "label": "Weak Credentials", "value": weak, "tone": "warning"},
                    {"key": "rotation_overdue", "label": "Rotation Overdue", "value": rotation_overdue, "tone": "warning"},
                    {"key": "pending_shares", "label": "Pending Share Requests", "value": pending_shares, "tone": "neutral"},
                    {"key": "total", "label": "Total Credentials", "value": total, "tone": "neutral"},
                ],
                "breakdown": [],
            }
        _safe_insight(modules, "credential_vault", "Credential Vault", "credvault", vault_block)

        def accounting_block():
            # Nexus has no ledger of its own - Accounting proxies read-only
            # reports from the real accounting app (see routers/accounting.py).
            # Calling the same sync helper directly is safe here: this whole
            # endpoint is a sync `def`, so FastAPI already runs it in a
            # worker thread, not on the event loop (see CLAUDE.md's blocking-
            # I/O rule). Degrades to an empty card (via _safe_insight) if the
            # service isn't configured or isn't reachable - never fabricated.
            from routers.accounting import _acct_get_sync
            cash = _acct_get_sync("/api/internal/reports/cash-position", {"asof": today, "location": None})
            pnl = _acct_get_sync("/api/internal/reports/pnl", {"from": month_start, "to": today, "location": None})
            totals = pnl.get("totals") or {}
            net_income = totals.get("net_income", 0) or 0
            return {
                "stats": [
                    {"key": "cash_on_hand", "label": "Cash on Hand", "value": f"${cash.get('total', 0):,.0f}", "tone": "good"},
                    {"key": "net_income_mtd", "label": "Net Income (MTD)", "value": f"${net_income:,.0f}", "tone": "good" if net_income >= 0 else "critical"},
                    {"key": "gross_profit_mtd", "label": "Gross Profit (MTD)", "value": f"${totals.get('gross_profit', 0):,.0f}", "tone": "neutral"},
                ],
                "breakdown": [],
            }
        _safe_insight(modules, "accounting", "Accounting", "accounting", accounting_block)

        return {"modules": [m for m in modules if m["stats"] or m["breakdown"] or m.get("table") or m.get("trend") or m.get("funnel")]}

    out = cache.dashboard_insights.get_or_load((), _compute)
    return {**out, "at": _now()}


# ── BI drill-down (Pranshu, Sep 14) ─────────────────────────────────────────
# "If I click Open, it should show me which employee has how many open
# tasks... implement in each [module] but with different logic - think which
# logic suits which module." A metric on the board is a COUNT; this answers
# "of what" - and "of what" is genuinely different per metric:
#   - "by_person": a workload question (who's carrying this?) - grouped
#     counts, e.g. open tasks/tickets per assignee, KB docs stuck per owner.
#   - "list": a status question (which records, specifically?) - there is no
#     meaningful "who" for a down website or an expiring warranty, so this
#     returns the affected records themselves (name + one relevant detail),
#     not a person tally.
# Listed here deliberately rather than derived generically: each entry knows
# exactly which rows match that metric (mirroring the SAME predicate
# `insights()` above used to compute the count) and which field it groups or
# lists by. Duplicating that predicate per metric is cheaper to keep honest
# than a shared helper both endpoints would have to agree on forever.
def _by_person(db, emails: list, title: str) -> dict:
    names = {(e.work_email or "").lower(): (e.display_name or e.work_email)
             for e in db.query(models.NexusEmployee.work_email, models.NexusEmployee.display_name).all()}
    counts: dict[str, int] = {}
    for e in emails:
        k = (e or "").strip().lower() or "(none)"
        counts[k] = counts.get(k, 0) + 1
    rows = [{"label": names.get(k, k) if k != "(none)" else "Unassigned", "value": v} for k, v in counts.items()]
    rows.sort(key=lambda r: -r["value"])
    return {"kind": "by_person", "title": title, "rows": rows[:25], "total": sum(r["value"] for r in rows)}


def _list(items: list, title: str) -> dict:
    """items: [(label, detail)] - already sorted by the caller (e.g. soonest
    due date first); truncated here so nobody ships an unbounded payload."""
    rows = [{"label": label, "detail": detail} for label, detail in items[:25]]
    return {"kind": "list", "title": title, "rows": rows, "total": len(items)}


@router.get("/insights/drilldown")
def insights_drilldown(module: str, metric: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if user["level"] < 2:
        raise HTTPException(403, "Manager access required")

    M = models
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
    week_ahead = (datetime.now(timezone.utc) + timedelta(days=7)).strftime("%Y-%m-%d")
    month_ahead = (datetime.now(timezone.utc) + timedelta(days=30)).strftime("%Y-%m-%d")
    ninety_ahead = (datetime.now(timezone.utc) + timedelta(days=90)).strftime("%Y-%m-%d")
    _cscope = auth.company_scope(user, db)

    if module == "tasks":
        from routers.task_util import wall_tasks, task_assignees
        rows = wall_tasks(db, user, db.query(M.Task).filter(
            M.Task.deleted_at == "", M.Task.type != "section", M.Task.parent_task_id == "").all())
        pred = {
            "overdue": lambda t: not t.completed and t.due_on and t.due_on < today,
            "upcoming": lambda t: not t.completed and t.due_on and today <= t.due_on <= week_ahead,
            "completed_7d": lambda t: t.completed and t.completed_at >= week_ago,
            "open_total": lambda t: not t.completed,
        }.get(metric)
        titles = {"overdue": "Overdue Tasks by Employee", "upcoming": "Tasks Due This Week by Employee",
                  "completed_7d": "Tasks Completed (7d) by Employee", "open_total": "Open Tasks by Employee"}
        if not pred:
            raise HTTPException(404, "No breakdown for this metric")
        emails = [e for t in rows if pred(t) for e in (task_assignees(t) or [""])]
        return _by_person(db, emails, titles[metric])

    if module == "tickets":
        q = db.query(M.TaskTicket)
        if _cscope is not None:
            q = q.filter(M.TaskTicket.company_id.in_(_cscope))
        closed_states = ("resolved", "closed")
        pred = {
            "open": lambda t: t.status not in closed_states,
            "sla_breached": lambda t: t.status not in closed_states and t.sla_due_on and t.sla_due_on < today,
            "resolved": lambda t: t.status == "resolved",
            "closed": lambda t: t.status == "closed",
            "unassigned": lambda t: t.status not in closed_states and not t.assignee_email,
        }.get(metric)
        if not pred:
            raise HTTPException(404, "No breakdown for this metric")
        field = "requester_email" if metric == "unassigned" else "assignee_email"
        emails = [getattr(t, field, "") for t in q.all() if pred(t)]
        ticket_titles = {"open": "Open Tickets by Assignee", "sla_breached": "SLA-Breached Tickets by Assignee",
                         "resolved": "Resolved Tickets by Assignee", "closed": "Closed Tickets by Assignee",
                         "unassigned": "Unassigned Tickets by Requester"}
        title = ticket_titles[metric]
        return _by_person(db, emails, title)

    if module == "attendance":
        punches = db.query(M.TimePunch).filter(M.TimePunch.local_date == today).order_by(M.TimePunch.at).all()
        latest: dict[str, str] = {}
        for p in punches:
            latest[p.employee_email] = p.kind
        active = {(e.work_email or "").lower() for e in db.query(M.NexusEmployee.work_email).filter(M.NexusEmployee.status == "active").all()}
        if metric == "clocked_in":
            emails = [e for e, k in latest.items() if k in ("in", "break_start")]
        elif metric == "on_break":
            emails = [e for e, k in latest.items() if k == "break_start"]
        elif metric == "not_clocked_in":
            clocked = {e for e, k in latest.items() if k != "out"}
            emails = [e for e in active if e.lower() not in clocked]
        else:
            raise HTTPException(404, "No breakdown for this metric")
        names = {(e.work_email or "").lower(): (e.display_name or e.work_email)
                 for e in db.query(M.NexusEmployee.work_email, M.NexusEmployee.display_name).all()}
        items = sorted(((names.get(e.lower(), e), "") for e in emails), key=lambda r: r[0])
        return _list(items, f"Who's {metric.replace('_', ' ').title()}")

    if module == "knowledge_base":
        status_map = {"pending_review": "in_review", "changes_requested": "changes_requested", "draft": "draft"}
        if metric not in status_map:
            raise HTTPException(404, "No breakdown for this metric")
        rows = db.query(M.KbDocument).filter(M.KbDocument.status == status_map[metric]).all()
        emails = [r.owner_email for r in rows]
        return _by_person(db, emails, f"{metric.replace('_', ' ').title()} by Owner")

    if module == "operations":
        if metric == "pending_requisitions":
            q = db.query(M.Requisition).filter(M.Requisition.status == "pending_manager")
            if _cscope is not None:
                q = q.filter(M.Requisition.company_id.in_(_cscope))
            return _by_person(db, [r.employee_email for r in q.all()], "Requisitions to Approve by Employee")
        if metric == "open_purchases":
            rows = db.query(M.PurchaseRequest).filter(M.PurchaseRequest.status == "pending").all()
            counts: dict[str, int] = {}
            for r in rows:
                d = r.dept or "(no department)"
                counts[d] = counts.get(d, 0) + 1
            items = sorted(counts.items(), key=lambda kv: -kv[1])
            return {"kind": "by_person", "title": "Open Purchases by Department",
                    "rows": [{"label": k, "value": v} for k, v in items][:25], "total": sum(counts.values())}
        if metric == "pending_inventory":
            rows = db.query(M.ItemCheckout).filter(M.ItemCheckout.status == "pending").all()
            return _by_person(db, [r.requested_by_email for r in rows], "Inventory Requests by Employee")
        raise HTTPException(404, "No breakdown for this metric")

    if module == "documents":
        if metric in ("pending_signatures", "needs_attention", "signed_7d"):
            status_sets = {"pending_signatures": ("pending",), "needs_attention": ("declined", "voided", "expired"), "signed_7d": ("completed",)}
            rows = db.query(M.HrSignRequest).filter(M.HrSignRequest.status.in_(status_sets[metric])).all()
            if metric == "signed_7d":
                rows = [r for r in rows if r.completed_at >= week_ago]
            doc_titles = {"pending_signatures": "Pending Signatures by Sender", "needs_attention": "Declined / Expired by Sender", "signed_7d": "Signed (7d) by Sender"}
            return _by_person(db, [r.created_by for r in rows], doc_titles[metric])
        raise HTTPException(404, "No breakdown for this metric")

    if module == "it":
        if metric == "sites_down":
            rows = db.query(M.Website).filter(M.Website.status != "Online").all()
            items = sorted(((r.name or r.domain, r.status) for r in rows), key=lambda r: r[0])
            return _list(items, "Sites Down / Degraded")
        if metric == "ssl_expiring":
            rows = db.query(M.Website).filter(M.Website.ssl_days <= 30).order_by(M.Website.ssl_days).all()
            items = [(r.name or r.domain, f"{r.ssl_days}d left") for r in rows]
            return _list(items, "SSL Expiring Soon")
        if metric == "warranties_expiring":
            rows = db.query(M.HardwareAsset).filter(
                M.HardwareAsset.warranty_end != "", M.HardwareAsset.warranty_end >= today,
                M.HardwareAsset.warranty_end <= month_ahead).order_by(M.HardwareAsset.warranty_end).all()
            items = [(r.name, f"{r.assigned_to or 'Unassigned'} · {r.warranty_end}") for r in rows]
            return _list(items, "Hardware Warranties Expiring")
        if metric == "hw_unassigned":
            rows = db.query(M.HardwareAsset).filter(M.HardwareAsset.assigned_to == "Unassigned").all()
            items = sorted(((r.name, r.category) for r in rows), key=lambda r: r[0])
            return _list(items, "Unassigned Hardware")
        raise HTTPException(404, "No breakdown for this metric")

    if module == "construction":
        if metric == "logs_pending":
            rows = db.query(M.ConstructionDailyLog).filter(M.ConstructionDailyLog.status == "submitted", M.ConstructionDailyLog.deleted_at == "").all()
            return _by_person(db, [r.author_email for r in rows], "Logs Pending Review by Author")
        projects = {p.id: p.name for p in db.query(M.ConstructionProject.id, M.ConstructionProject.name).all()}
        if metric == "overdue_rfis":
            rows = db.query(M.ConstructionRfi).filter(M.ConstructionRfi.status == "open", M.ConstructionRfi.due_on != "", M.ConstructionRfi.due_on < today).order_by(M.ConstructionRfi.due_on).all()
            items = [(r.subject or r.number, f"{projects.get(r.project_id, '')} · due {r.due_on}") for r in rows]
            return _list(items, "Overdue RFIs")
        if metric == "pending_submittals":
            rows = db.query(M.ConstructionSubmittal).filter(M.ConstructionSubmittal.status.in_(["pending", "submitted"]), M.ConstructionSubmittal.deleted_at == "").all()
            items = [(r.title or r.number, projects.get(r.project_id, '')) for r in rows]
            return _list(items, "Pending Submittals")
        if metric == "at_risk_milestones":
            rows = db.query(M.ConstructionMilestone).filter(M.ConstructionMilestone.status.in_(["at_risk", "missed"]), M.ConstructionMilestone.deleted_at == "").order_by(M.ConstructionMilestone.target_date).all()
            items = [(r.name, f"{projects.get(r.project_id, '')} · {r.status}") for r in rows]
            return _list(items, "At-Risk Milestones")
        raise HTTPException(404, "No breakdown for this metric")

    if module == "asset_management":
        props = {p.id: p.name for p in db.query(M.PropertyAsset.id, M.PropertyAsset.name).all()}
        if metric == "warranties_expiring":
            rows = db.query(M.PropertyRecord).filter(M.PropertyRecord.collection == "warranties").all()
            items = []
            for r in rows:
                exp = (r.payload or {}).get("expiration", "")[:10]
                if exp and exp <= ninety_ahead:
                    items.append(((r.payload or {}).get("scope") or "Warranty", f"{props.get(r.property_id, '')} · {exp}"))
            items.sort(key=lambda r: r[1])
            return _list(items, "Warranties Expiring")
        if metric == "inspections_due":
            rows = db.query(M.PropertyRecord).filter(M.PropertyRecord.collection == "inspections").all()
            items = []
            for r in rows:
                due = (r.payload or {}).get("nextDue", "")[:10]
                if due and due <= month_ahead:
                    items.append(((r.payload or {}).get("type") or "Inspection", f"{props.get(r.property_id, '')} · {due}"))
            items.sort(key=lambda r: r[1])
            return _list(items, "Inspections Due")
        raise HTTPException(404, "No breakdown for this metric")

    if module == "people":
        if metric in ("open_candidates", "interviews_7d"):
            q = db.query(M.HrCandidate).filter(M.HrCandidate.stage.notin_(["hired", "rejected"]))
            if _cscope is not None:
                q = q.filter(M.HrCandidate.company.in_(_cscope))
            rows = q.all()
            if metric == "interviews_7d":
                rows = [r for r in rows if r.interview_at and today <= r.interview_at <= week_ahead + "T23:59:59"]
                items = sorted((((r.first_name + " " + r.last_name).strip() or r.email, r.interview_at) for r in rows), key=lambda r: r[1])
            else:
                items = sorted((((r.first_name + " " + r.last_name).strip() or r.email, f"{r.role_title or ''} · {r.stage}") for r in rows), key=lambda r: r[0])
            return _list(items, "Interviews This Week" if metric == "interviews_7d" else "Hiring Pipeline")
        if metric in ("leave_pending", "docs_expiring"):
            emp_names = {e.id: (e.display_name or f"{e.first_name} {e.last_name}".strip())
                         for e in db.query(M.NexusEmployee.id, M.NexusEmployee.display_name, M.NexusEmployee.first_name, M.NexusEmployee.last_name).all()}
            if metric == "leave_pending":
                rows = db.query(M.HrLeaveRequest).filter(M.HrLeaveRequest.status == "pending").all()
                items = [(emp_names.get(r.employee_id, r.employee_id), f"{r.leave_type} · {r.start_date} to {r.end_date}") for r in rows]
            else:
                rows = db.query(M.HrDocument).filter(M.HrDocument.expires_on != "", M.HrDocument.expires_on >= today, M.HrDocument.expires_on <= month_ahead).order_by(M.HrDocument.expires_on).all()
                items = [(emp_names.get(r.employee_id, r.employee_id), f"{r.kind} · expires {r.expires_on}") for r in rows]
            return _list(items, "Leave to Approve" if metric == "leave_pending" else "Employee Docs Expiring")
        raise HTTPException(404, "No breakdown for this metric")

    if module == "credential_vault":
        creds = db.query(M.VaultCredential).filter(M.VaultCredential.deleted_at == "")
        if metric == "breached":
            rows = creds.filter(M.VaultCredential.breached == True).all()  # noqa: E712
            items = [(r.name, r.owner_email) for r in rows]
            return _list(items, "Breached Credentials")
        if metric == "weak":
            rows = creds.filter(M.VaultCredential.strength == "weak").all()
            items = [(r.name, r.owner_email) for r in rows]
            return _list(items, "Weak Credentials")
        if metric == "rotation_overdue":
            items = []
            for c in creds.filter(M.VaultCredential.rotated_at != "").all():
                try:
                    rotated = datetime.fromisoformat(c.rotated_at.replace("Z", "+00:00"))
                    if rotated.tzinfo is None:
                        rotated = rotated.replace(tzinfo=timezone.utc)
                    days = (datetime.now(timezone.utc) - rotated).days
                    if days > (c.rotation_max or 90):
                        items.append((c.name, f"{c.owner_email} · {days}d since rotation"))
                except Exception:
                    continue
            items.sort(key=lambda r: r[0])
            return _list(items, "Rotation Overdue")
        if metric == "pending_shares":
            rows = db.query(M.VaultShareRequest).filter(M.VaultShareRequest.status == "pending").all()
            return _by_person(db, [r.requested_by_email for r in rows], "Pending Share Requests by Requester")
        raise HTTPException(404, "No breakdown for this metric")

    raise HTTPException(404, "No breakdown for this metric")


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
        # Exclusive midnight boundary, not "tomorrow 23:59:59" - see the
        # frontend AgendaPanel's matching comment (Sep 4) on why a non-midnight
        # end let an all-day event straddling it slip into the window.
        end = (datetime.now(timezone.utc) + timedelta(days=2)).strftime("%Y-%m-%dT00:00:00Z")
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
                        # 250 (not the old 15) so a full-month window for the
                        # Calendar widget's grid isn't truncated - the day/2-day
                        # window My Agenda uses never gets near either cap.
                        "$orderby": "start/dateTime", "$top": "250",
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


# Company-wide birthday roster for the Calendar widget (Pranshu, Sep 4: "add
# birthday as an event of all the employees... helps us prepare any
# celebration prior"). Deliberately NOT the HR /people endpoint's full
# record - this returns only name + month/day for active employees who have
# a DOB on file, never the birth year or anything else from `personal`, and
# needs no HR grant to read (every employee benefits from knowing when to
# bring a cake, and month/day alone doesn't reveal age). Cached (see cache.py
# dashboard_birthdays - watches NexusEmployee, so an HR edit invalidates it).
@router.get("/birthdays")
def birthdays(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    def _load() -> dict:
        rows = (db.query(models.NexusEmployee)
                .filter(models.NexusEmployee.status == "active").all())
        out = []
        for e in rows:
            dob = ((e.personal or {}).get("dob") or "").strip()
            m = re.fullmatch(r"\d{4}-(\d{2})-(\d{2})", dob)
            if not m:
                continue
            name = (e.display_name or f"{e.first_name} {e.last_name}".strip()).strip()
            if not name:
                continue
            out.append({"name": name, "month": int(m.group(1)), "day": int(m.group(2))})
        return {"birthdays": out}

    return {**cache.dashboard_birthdays.get_or_load((), _load), "at": _now()}
