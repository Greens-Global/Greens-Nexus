"""Task Module — organisation router: projects, portfolios, departments, and the
department member-request workflow. Single router with absolute paths (one
include in main.py). Email-keyed; serialisers emit the export's runtime shape.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
import models
from database import get_db
from auth import get_current_user
from routers.task_util import now_iso, gen_id, task_notify, admin_emails, log_activity

router = APIRouter(tags=["Tasks"], dependencies=[Depends(get_current_user)])


def _nz(v):
    return v if v not in ("", None) else None


def project_to_dict(p: models.TaskProject) -> dict:
    return {
        "id": p.id, "name": p.name, "description": p.description or "", "color": _nz(p.color),
        "ownerId": _nz(p.owner_email), "memberIds": p.member_emails or [],
        "portfolioId": _nz(p.portfolio_id), "departmentId": _nz(p.department_id),
        "status": p.status or "not_started", "startOn": _nz(p.start_on), "dueOn": _nz(p.due_on),
        "archived": bool(p.archived), "activityIds": p.activity_ids or [],
        "createdAt": p.created_at or "", "modifiedAt": p.modified_at or "",
    }


def portfolio_to_dict(p: models.TaskPortfolio) -> dict:
    return {
        "id": p.id, "name": p.name, "description": p.description or "", "color": _nz(p.color),
        "ownerId": _nz(p.owner_email), "projectIds": p.project_ids or [],
        "archived": bool(p.archived), "createdAt": p.created_at or "", "modifiedAt": p.modified_at or "",
    }


def department_to_dict(d: models.TaskDepartment) -> dict:
    return {"id": d.id, "name": d.name, "color": d.color or "", "icon": d.icon or "",
            "memberIds": d.member_emails or [], "createdAt": d.created_at or ""}


def member_request_to_dict(m: models.TaskMemberRequest) -> dict:
    return {"id": m.id, "departmentId": m.department_id, "userId": _nz(m.user_email),
            "kind": m.kind or "add", "requestedById": _nz(m.requested_by), "status": m.status or "pending",
            "createdAt": m.created_at or "", "decidedAt": _nz(m.decided_at), "decidedById": _nz(m.decided_by)}


# ── Projects ─────────────────────────────────────────────────────────────────
class ProjectBody(BaseModel):
    id: Optional[str] = None
    name: str
    description: Optional[str] = ""
    color: Optional[str] = ""
    owner_email: Optional[str] = ""
    member_emails: Optional[list] = None
    portfolio_id: Optional[str] = ""
    department_id: Optional[str] = ""
    status: Optional[str] = "not_started"
    start_on: Optional[str] = ""
    due_on: Optional[str] = ""
    archived: Optional[bool] = None


@router.get("/task-projects")
def list_projects(db: Session = Depends(get_db)):
    return [project_to_dict(p) for p in db.query(models.TaskProject).all()]


@router.post("/task-projects", status_code=201)
def create_project(body: ProjectBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    now = now_iso()
    p = models.TaskProject(
        id=body.id or gen_id(), name=body.name, description=body.description or "",
        color=body.color or "", owner_email=(body.owner_email or user["email"]).lower(),
        member_emails=body.member_emails or [], portfolio_id=body.portfolio_id or "",
        department_id=body.department_id or "", status=body.status or "not_started",
        start_on=body.start_on or "", due_on=body.due_on or "", archived=False,
        activity_ids=[], created_at=now, modified_at=now, created_by=user["email"],
    )
    db.add(p)
    # keep the portfolio's ordered project list in sync
    if p.portfolio_id:
        pf = db.query(models.TaskPortfolio).filter(models.TaskPortfolio.id == p.portfolio_id).first()
        if pf:
            pf.project_ids = list(pf.project_ids or []) + [p.id]
    # Log a project-scoped "created" activity (source createProject).
    aid = log_activity(db, entity_kind="project", type="created", actor_email=user["email"],
                       entity_id=p.id, entity_code=p.name, detail="created this project")
    p.activity_ids = [aid]
    db.commit()
    db.refresh(p)
    return project_to_dict(p)


@router.patch("/task-projects/{project_id}")
def update_project(project_id: str, body: ProjectBody, db: Session = Depends(get_db)):
    p = db.query(models.TaskProject).filter(models.TaskProject.id == project_id).first()
    if not p:
        raise HTTPException(404, "Project not found")
    data = body.model_dump(exclude_unset=True, exclude={"id"})
    for k, v in data.items():
        if k == "owner_email" and v is not None:
            v = (v or "").lower()
        setattr(p, k, v)
    p.modified_at = now_iso()
    db.commit()
    db.refresh(p)
    return project_to_dict(p)


@router.delete("/task-projects/{project_id}", status_code=204)
def delete_project(project_id: str, db: Session = Depends(get_db)):
    p = db.query(models.TaskProject).filter(models.TaskProject.id == project_id).first()
    if not p:
        raise HTTPException(404, "Project not found")
    # unlink tasks + portfolio references
    for t in db.query(models.Task).filter(models.Task.project_id == project_id).all():
        t.project_id = ""
    for pf in db.query(models.TaskPortfolio).all():
        if project_id in (pf.project_ids or []):
            pf.project_ids = [x for x in pf.project_ids if x != project_id]
    db.delete(p)
    db.commit()


# ── Portfolios ───────────────────────────────────────────────────────────────
class PortfolioBody(BaseModel):
    id: Optional[str] = None
    name: Optional[str] = None   # optional so PATCH can send partial bodies; required on create (guarded below)
    description: Optional[str] = ""
    color: Optional[str] = ""
    owner_email: Optional[str] = ""
    project_ids: Optional[list] = None
    archived: Optional[bool] = None


@router.get("/task-portfolios")
def list_portfolios(db: Session = Depends(get_db)):
    return [portfolio_to_dict(p) for p in db.query(models.TaskPortfolio).all()]


@router.post("/task-portfolios", status_code=201)
def create_portfolio(body: PortfolioBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if not (body.name or "").strip():
        raise HTTPException(422, "Portfolio name is required")
    now = now_iso()
    p = models.TaskPortfolio(
        id=body.id or gen_id(), name=body.name, description=body.description or "",
        color=body.color or "", owner_email=(body.owner_email or user["email"]).lower(),
        project_ids=body.project_ids or [], archived=False,
        created_at=now, modified_at=now, created_by=user["email"],
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return portfolio_to_dict(p)


@router.patch("/task-portfolios/{portfolio_id}")
def update_portfolio(portfolio_id: str, body: PortfolioBody, db: Session = Depends(get_db)):
    p = db.query(models.TaskPortfolio).filter(models.TaskPortfolio.id == portfolio_id).first()
    if not p:
        raise HTTPException(404, "Portfolio not found")
    data = body.model_dump(exclude_unset=True, exclude={"id"})
    for k, v in data.items():
        if k == "owner_email" and v is not None:
            v = (v or "").lower()
        setattr(p, k, v)
    p.modified_at = now_iso()
    db.commit()
    db.refresh(p)
    return portfolio_to_dict(p)


@router.delete("/task-portfolios/{portfolio_id}", status_code=204)
def delete_portfolio(portfolio_id: str, db: Session = Depends(get_db)):
    p = db.query(models.TaskPortfolio).filter(models.TaskPortfolio.id == portfolio_id).first()
    if not p:
        raise HTTPException(404, "Portfolio not found")
    for proj in db.query(models.TaskProject).filter(models.TaskProject.portfolio_id == portfolio_id).all():
        proj.portfolio_id = ""
    db.delete(p)
    db.commit()


# ── Departments ──────────────────────────────────────────────────────────────
class DepartmentBody(BaseModel):
    id: Optional[str] = None
    name: str
    color: Optional[str] = ""
    icon: Optional[str] = ""
    member_emails: Optional[list] = None


@router.get("/task-departments")
def list_departments(db: Session = Depends(get_db)):
    return [department_to_dict(d) for d in db.query(models.TaskDepartment).all()]


@router.post("/task-departments", status_code=201)
def create_department(body: DepartmentBody, db: Session = Depends(get_db)):
    d = models.TaskDepartment(id=body.id or gen_id(), name=body.name, color=body.color or "",
                              icon=body.icon or "", member_emails=body.member_emails or [],
                              created_at=now_iso())
    db.add(d)
    db.commit()
    db.refresh(d)
    return department_to_dict(d)


@router.patch("/task-departments/{dept_id}")
def update_department(dept_id: str, body: DepartmentBody, db: Session = Depends(get_db)):
    d = db.query(models.TaskDepartment).filter(models.TaskDepartment.id == dept_id).first()
    if not d:
        raise HTTPException(404, "Department not found")
    data = body.model_dump(exclude_unset=True, exclude={"id"})
    for k, v in data.items():
        setattr(d, k, v)
    db.commit()
    db.refresh(d)
    return department_to_dict(d)


@router.delete("/task-departments/{dept_id}", status_code=204)
def delete_department(dept_id: str, db: Session = Depends(get_db)):
    # Never orphan projects — refuse while any project still points at this team
    # (source deleteDepartment no-ops in that case; we surface a 400 instead).
    if db.query(models.TaskProject).filter(models.TaskProject.department_id == dept_id).first():
        raise HTTPException(400, "Reassign or remove this team's projects first")
    db.query(models.TaskDepartment).filter(models.TaskDepartment.id == dept_id).delete()
    db.commit()


# ── Member requests ──────────────────────────────────────────────────────────
class MemberRequestBody(BaseModel):
    id: Optional[str] = None
    department_id: str
    user_email: str
    kind: Optional[str] = "add"


class DecideBody(BaseModel):
    status: str  # approved | rejected


@router.get("/task-member-requests")
def list_member_requests(db: Session = Depends(get_db)):
    return [member_request_to_dict(m) for m in db.query(models.TaskMemberRequest).all()]


@router.post("/task-member-requests", status_code=201)
def raise_member_request(body: MemberRequestBody, user: dict = Depends(get_current_user),
                         db: Session = Depends(get_db)):
    m = models.TaskMemberRequest(
        id=body.id or gen_id(), department_id=body.department_id,
        user_email=(body.user_email or "").lower(), kind=body.kind or "add",
        requested_by=user["email"], status="pending", created_at=now_iso(),
        decided_at="", decided_by="",
    )
    db.add(m)
    dept = db.query(models.TaskDepartment).filter(models.TaskDepartment.id == body.department_id).first()
    dept_name = dept.name if dept else "a department"
    task_notify(db, kind="member_request", for_email="admins",
                title="Department member request",
                body=f"{user['email']} requested to {m.kind} {m.user_email} for {dept_name}",
                department_id=body.department_id, request_id=m.id)
    db.commit()
    db.refresh(m)
    return member_request_to_dict(m)


@router.post("/task-member-requests/{request_id}/decide")
def decide_member_request(request_id: str, body: DecideBody, user: dict = Depends(get_current_user),
                          db: Session = Depends(get_db)):
    if user["level"] < 4:  # administrator+
        raise HTTPException(403, "Only administrators can decide member requests")
    m = db.query(models.TaskMemberRequest).filter(models.TaskMemberRequest.id == request_id).first()
    if not m:
        raise HTTPException(404, "Request not found")
    if m.status != "pending":
        raise HTTPException(400, "Request already decided")
    m.status = "approved" if body.status == "approved" else "rejected"
    m.decided_at = now_iso()
    m.decided_by = user["email"]
    if m.status == "approved":
        dept = db.query(models.TaskDepartment).filter(models.TaskDepartment.id == m.department_id).first()
        if dept:
            members = [e for e in (dept.member_emails or [])]
            if m.kind == "add" and m.user_email not in members:
                members.append(m.user_email)
            elif m.kind == "remove":
                members = [e for e in members if e != m.user_email]
            dept.member_emails = members
    task_notify(db, kind=("request_approved" if m.status == "approved" else "request_rejected"),
                for_email=m.requested_by, title=f"Member request {m.status}",
                body=f"Your request to {m.kind} {m.user_email} was {m.status}.",
                department_id=m.department_id, request_id=m.id)
    db.commit()
    db.refresh(m)
    return member_request_to_dict(m)
