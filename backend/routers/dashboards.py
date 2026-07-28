"""Customizable dashboards: saveable drag-and-drop widget layouts (personal +
manager-published department templates) and a single KPI aggregate endpoint the
widgets read from. Kept separate from the legacy /dashboard/summary router."""
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
from database import get_db
from auth import get_current_user

router = APIRouter(prefix="/dashboards", tags=["Dashboards"], dependencies=[Depends(get_current_user)])

_TARGETS = ("dashboard", "manager-dashboard")


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
    out: dict[str, int] = {}

    def safe(key, fn):
        try:
            out[key] = int(fn())
        except Exception:
            out[key] = 0

    M = models
    safe("open_tasks", lambda: db.query(M.Task).filter(M.Task.status != "Completed").count())
    safe("pending_requisitions", lambda: db.query(M.Requisition).filter(M.Requisition.status == "pending_manager").count())
    safe("pending_inventory", lambda: db.query(M.ItemCheckout).filter(M.ItemCheckout.status == "pending").count())
    safe("open_purchases", lambda: db.query(M.PurchaseRequest).filter(M.PurchaseRequest.status == "pending").count())
    safe("my_checkouts", lambda: db.query(M.ItemCheckout).filter(
        M.ItemCheckout.requested_by_email == email,
        M.ItemCheckout.status.in_(["approved", "allocated", "pending_receipt"])).count())
    safe("my_assignments", lambda: db.query(M.ItemAssignment).filter(
        M.ItemAssignment.assignee_email == email, M.ItemAssignment.status == "active").count())
    safe("my_open_tasks", lambda: db.query(M.Task).filter(
        M.Task.assignee == email, M.Task.status != "Completed").count())
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
    if scope == "team" and user["level"] >= 2:
        safe("clocked_in_now", clocked_in)
        safe("time_off_pending", lambda: db.query(M.TimeOffRequest).filter(M.TimeOffRequest.status == "pending").count())

    return {"kpis": out, "at": _now()}
