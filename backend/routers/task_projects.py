"""Task Module — organisation router: projects, portfolios, teams, and the
team member-request workflow. Single router with absolute paths (one include
in main.py). Email-keyed; serialisers emit the export's runtime shape.

"Team" (TaskTeam) is scoped to ONE project (IT Team/QA Team/... WITHIN a
project) — not to be confused with a project's `hr_department_id`, which
points at the real People-module department (HrDepartment) that owns the
project. Same dual-field shape TaskTicket already uses for this distinction.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
import models
from database import get_db
from auth import get_current_user
from routers.task_util import now_iso, gen_id, task_notify, is_manager, visible_project_ids, require_project_role
from routers.hr import _ensure_departments

router = APIRouter(tags=["Tasks"], dependencies=[Depends(get_current_user)])


def _nz(v):
    return v if v not in ("", None) else None


def _resolve_hr_department(db: Session, email: str):
    """Auto-populate a project's department from its creator's own People-module
    record, rather than a manual picker — name-matches NexusEmployee.department
    against that person's company's HrDepartment list (_ensure_departments
    already seeds/backfills that list from employee data). No match (employee
    not found, no department set, etc.) -> ("", ""); a project without a
    department stays valid."""
    emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == email).first()
    if not emp or not emp.company or not emp.department:
        return "", ""
    entity = db.query(models.HrEntity).filter(models.HrEntity.id == emp.company).first()
    if not entity:
        return "", ""
    _ensure_departments(db, entity)
    dept = (db.query(models.HrDepartment)
            .filter(models.HrDepartment.company_id == emp.company,
                    models.HrDepartment.name == emp.department).first())
    return (dept.id, dept.name) if dept else ("", "")


def project_to_dict(p: models.TaskProject) -> dict:
    return {
        "id": p.id, "name": p.name, "description": p.description or "", "color": _nz(p.color),
        "ownerId": _nz(p.owner_email), "memberIds": p.member_emails or [], "memberRoles": p.member_roles or {},
        "portfolioId": _nz(p.portfolio_id),
        "hrDepartmentId": _nz(p.hr_department_id), "hrDepartmentName": _nz(p.hr_department_name),
        "accessLevel": p.access_level or "org",
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


def team_to_dict(d: models.TaskTeam) -> dict:
    return {"id": d.id, "projectId": _nz(d.project_id), "name": d.name, "color": d.color or "", "icon": d.icon or "",
            "memberIds": d.member_emails or [], "accessRole": d.access_role or "editor", "createdAt": d.created_at or ""}


def member_request_to_dict(m: models.TaskMemberRequest) -> dict:
    return {"id": m.id, "teamId": m.department_id, "userId": _nz(m.user_email),
            "kind": m.kind or "add", "requestedById": _nz(m.requested_by), "status": m.status or "pending",
            "createdAt": m.created_at or "", "decidedAt": _nz(m.decided_at), "decidedById": _nz(m.decided_by)}


# ── Projects ─────────────────────────────────────────────────────────────────
class ProjectBody(BaseModel):
    id: Optional[str] = None
    # Optional so a partial PATCH (e.g. the Share panel updating only
    # member_roles/access_level) doesn't have to resend the name — same reason
    # TeamBody/PortfolioBody make theirs optional too. Required in practice on
    # create, checked explicitly in create_project below.
    name: Optional[str] = None
    description: Optional[str] = ""
    color: Optional[str] = ""
    owner_email: Optional[str] = ""
    member_emails: Optional[list] = None
    member_roles: Optional[dict] = None
    portfolio_id: Optional[str] = ""
    access_level: Optional[str] = None
    status: Optional[str] = "not_started"
    start_on: Optional[str] = ""
    due_on: Optional[str] = ""
    archived: Optional[bool] = None


@router.get("/task-projects")
def list_projects(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.query(models.TaskProject).all()
    if is_manager(user):
        return [project_to_dict(p) for p in rows]
    visible = visible_project_ids(db, user["email"])
    return [project_to_dict(p) for p in rows if p.id in visible]


@router.post("/task-projects", status_code=201)
def create_project(body: ProjectBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if not (body.name or "").strip():
        raise HTTPException(422, "Project name is required")
    now = now_iso()
    hr_dept_id, hr_dept_name = _resolve_hr_department(db, user["email"])
    p = models.TaskProject(
        id=body.id or gen_id(), name=body.name, description=body.description or "",
        color=body.color or "", owner_email=(body.owner_email or user["email"]).lower(),
        member_emails=body.member_emails or [], portfolio_id=body.portfolio_id or "",
        hr_department_id=hr_dept_id, hr_department_name=hr_dept_name,
        # New projects default to 'restricted' (visible only to the owner,
        # its teams' members, and task assignees) — a stricter default than
        # the DB column's own 'org' backfill for pre-existing rows.
        access_level=body.access_level or "restricted",
        status=body.status or "not_started",
        start_on=body.start_on or "", due_on=body.due_on or "", archived=False,
        activity_ids=[], created_at=now, modified_at=now, created_by=user["email"],
    )
    db.add(p)
    # keep the portfolio's ordered project list in sync
    if p.portfolio_id:
        pf = db.query(models.TaskPortfolio).filter(models.TaskPortfolio.id == p.portfolio_id).first()
        if pf:
            pf.project_ids = list(pf.project_ids or []) + [p.id]
    db.commit()
    db.refresh(p)
    return project_to_dict(p)


@router.patch("/task-projects/{project_id}")
def update_project(project_id: str, body: ProjectBody, user: dict = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    p = db.query(models.TaskProject).filter(models.TaskProject.id == project_id).first()
    if not p:
        raise HTTPException(404, "Project not found")
    # Renaming, archiving, changing access, or managing who's on the Share
    # panel are all project-settings actions — Asana's "Project admin" tier,
    # not "Editor" (which only covers the tasks inside it).
    require_project_role(db, user, p, "owner")
    data = body.model_dump(exclude_unset=True, exclude={"id"})
    for k, v in data.items():
        if k == "owner_email" and v is not None:
            v = (v or "").lower()
        if k == "member_roles" and v:
            v = {em.lower(): role for em, role in v.items()}
        setattr(p, k, v)
    # A role grant is also an access grant — keep member_emails (the flat
    # "has access at all" list every other visibility check relies on) a
    # superset of member_roles' keys rather than two lists that can drift.
    if "member_roles" in data:
        p.member_emails = sorted(set(p.member_emails or []) | set((p.member_roles or {}).keys()))
    p.modified_at = now_iso()
    db.commit()
    db.refresh(p)
    return project_to_dict(p)


@router.delete("/task-projects/{project_id}", status_code=204)
def delete_project(project_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    p = db.query(models.TaskProject).filter(models.TaskProject.id == project_id).first()
    if not p:
        raise HTTPException(404, "Project not found")
    require_project_role(db, user, p, "owner")
    # unlink tasks + portfolio references; a team can't outlive its project
    for t in db.query(models.Task).filter(models.Task.project_id == project_id).all():
        t.project_id = ""
        t.team_id = ""
    for team in db.query(models.TaskTeam).filter(models.TaskTeam.project_id == project_id).all():
        db.delete(team)
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
    prev_project_ids = set(p.project_ids or [])
    for k, v in data.items():
        if k == "owner_email" and v is not None:
            v = (v or "").lower()
        setattr(p, k, v)
    p.modified_at = now_iso()
    # A project's own portfolio_id is the source of truth ProjectsView reads for
    # its portfolio badge, but this endpoint only used to touch the portfolio's
    # side of the relationship — adding a project here never tagged the project
    # itself. Diff old vs new project_ids and update both directions.
    if "project_ids" in data:
        new_project_ids = set(p.project_ids or [])
        for pid in new_project_ids - prev_project_ids:
            proj = db.query(models.TaskProject).filter(models.TaskProject.id == pid).first()
            if proj:
                proj.portfolio_id = portfolio_id
        for pid in prev_project_ids - new_project_ids:
            proj = (db.query(models.TaskProject)
                    .filter(models.TaskProject.id == pid, models.TaskProject.portfolio_id == portfolio_id).first())
            if proj:
                proj.portfolio_id = ""
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


# ── Teams (project-scoped — see module docstring) ───────────────────────────
class TeamBody(BaseModel):
    id: Optional[str] = None
    project_id: Optional[str] = ""
    # Optional so a partial PATCH (e.g. assigning just project_id from a
    # project's Teams checklist) doesn't have to resend the name — required
    # in practice on create, checked explicitly below.
    name: Optional[str] = None
    color: Optional[str] = ""
    icon: Optional[str] = ""
    member_emails: Optional[list] = None
    access_role: Optional[str] = None   # Share panel: owner|editor|commenter|viewer this team's roster gets on its project


@router.get("/task-teams")
def list_teams(db: Session = Depends(get_db)):
    return [team_to_dict(d) for d in db.query(models.TaskTeam).all()]


@router.post("/task-teams", status_code=201)
def create_team(body: TeamBody, db: Session = Depends(get_db)):
    if not (body.name or "").strip():
        raise HTTPException(422, "Team name is required")
    d = models.TaskTeam(id=body.id or gen_id(), project_id=body.project_id or "", name=body.name, color=body.color or "",
                        icon=body.icon or "", member_emails=body.member_emails or [],
                        created_at=now_iso())
    db.add(d)
    db.commit()
    db.refresh(d)
    return team_to_dict(d)


@router.patch("/task-teams/{team_id}")
def update_team(team_id: str, body: TeamBody, db: Session = Depends(get_db)):
    d = db.query(models.TaskTeam).filter(models.TaskTeam.id == team_id).first()
    if not d:
        raise HTTPException(404, "Team not found")
    data = body.model_dump(exclude_unset=True, exclude={"id"})
    for k, v in data.items():
        setattr(d, k, v)
    db.commit()
    db.refresh(d)
    return team_to_dict(d)


@router.delete("/task-teams/{team_id}", status_code=204)
def delete_team(team_id: str, db: Session = Depends(get_db)):
    for t in db.query(models.Task).filter(models.Task.team_id == team_id).all():
        t.team_id = ""
    db.query(models.TaskTeam).filter(models.TaskTeam.id == team_id).delete()
    db.commit()


# ── Member requests ──────────────────────────────────────────────────────────
class MemberRequestBody(BaseModel):
    id: Optional[str] = None
    team_id: str
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
        id=body.id or gen_id(), department_id=body.team_id,
        user_email=(body.user_email or "").lower(), kind=body.kind or "add",
        requested_by=user["email"], status="pending", created_at=now_iso(),
        decided_at="", decided_by="",
    )
    db.add(m)
    team = db.query(models.TaskTeam).filter(models.TaskTeam.id == body.team_id).first()
    team_name = team.name if team else "a team"
    task_notify(db, kind="member_request", for_email="admins",
                title="Team member request",
                body=f"{user['email']} requested to {m.kind} {m.user_email} for {team_name}",
                department_id=body.team_id, request_id=m.id,
                nexus_action={"view": "tasks", "sub": "teams", "label": "Review request"})
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
        team = db.query(models.TaskTeam).filter(models.TaskTeam.id == m.department_id).first()
        if team:
            members = [e for e in (team.member_emails or [])]
            if m.kind == "add" and m.user_email not in members:
                members.append(m.user_email)
            elif m.kind == "remove":
                members = [e for e in members if e != m.user_email]
            team.member_emails = members
    task_notify(db, kind=("request_approved" if m.status == "approved" else "request_rejected"),
                for_email=m.requested_by, title=f"Member request {m.status}",
                body=f"Your request to {m.kind} {m.user_email} was {m.status}.",
                department_id=m.department_id, request_id=m.id,
                nexus_action={"view": "tasks", "sub": "teams", "label": "View team"})
    db.commit()
    db.refresh(m)
    return member_request_to_dict(m)
