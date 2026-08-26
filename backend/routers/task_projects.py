"""Task Module - organisation router: projects, portfolios, teams, and the
team member-request workflow. Single router with absolute paths (one include
in main.py). Email-keyed; serialisers emit the export's runtime shape.

"Team" (TaskTeam) is scoped to ONE project (IT Team/QA Team/... WITHIN a
project) - not to be confused with a project's `hr_department_id`, which
points at the real People-module department (HrDepartment) that owns the
project. Same dual-field shape TaskTicket already uses for this distinction.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
import models
from database import get_db
from auth import get_current_user, require_manager, require_any_module_grant
from routers.task_util import (now_iso, gen_id, task_notify, is_manager, visible_project_ids,
                               require_project_role, team_project_ids, log_activity,
                               task_assignees, set_task_assignees)
from routers.hr import _ensure_departments
from routers.task_config import coerce_custom_field_values

router = APIRouter(tags=["Tasks"],
                   dependencies=[Depends(get_current_user), Depends(require_any_module_grant("tasks", "tickets"))])


def _nz(v):
    return v if v not in ("", None) else None


def _resolve_hr_department(db: Session, email: str):
    """Auto-populate a project's department from its creator's own People-module
    record, rather than a manual picker - name-matches NexusEmployee.department
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
        "customFieldValues": p.custom_field_values or {},
        "createdAt": p.created_at or "", "modifiedAt": p.modified_at or "",
    }


def portfolio_to_dict(p: models.TaskPortfolio) -> dict:
    return {
        "id": p.id, "name": p.name, "description": p.description or "", "color": _nz(p.color),
        "ownerId": _nz(p.owner_email), "projectIds": p.project_ids or [],
        "archived": bool(p.archived), "createdAt": p.created_at or "", "modifiedAt": p.modified_at or "",
    }


def team_to_dict(d: models.TaskTeam) -> dict:
    ids = team_project_ids(d)
    # projectId stays in the payload as the FIRST project so anything still
    # reading the singular field keeps working; projectIds is the real answer.
    return {"id": d.id, "projectId": _nz(ids[0] if ids else ""), "projectIds": ids,
            "name": d.name, "color": d.color or "", "icon": d.icon or "",
            "memberIds": d.member_emails or [], "accessRole": d.access_role or "editor", "createdAt": d.created_at or ""}


def member_request_to_dict(m: models.TaskMemberRequest) -> dict:
    return {"id": m.id, "teamId": m.department_id, "userId": _nz(m.user_email),
            "kind": m.kind or "add", "requestedById": _nz(m.requested_by), "status": m.status or "pending",
            "createdAt": m.created_at or "", "decidedAt": _nz(m.decided_at), "decidedById": _nz(m.decided_by)}


# ── Projects ─────────────────────────────────────────────────────────────────
class ProjectBody(BaseModel):
    id: Optional[str] = None
    # Optional so a partial PATCH (e.g. the Share panel updating only
    # member_roles/access_level) doesn't have to resend the name - same reason
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
    custom_field_values: Optional[dict] = None
    # A project's People-module department. Auto-resolved from the creator at
    # creation time, but editable afterwards - the creator's own department is a
    # guess, and a project raised by IT for Accounting belongs to Accounting.
    # The NAME is a display snapshot; update_project re-derives it from the id
    # so the two can never disagree.
    hr_department_id: Optional[str] = None
    hr_department_name: Optional[str] = None


@router.get("/task-projects/meta/departments")
def list_project_departments(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Departments a project can be filed under, flattened across companies.

    The People module's own listing is per-company AND behind require_hr_read,
    which an ordinary task user does not hold - so filing a project under a
    department would have needed HR access. This exposes names only (no people,
    no leads, no contact details), which is all the project picker renders.
    """
    entities = {e.id: e.name for e in db.query(models.HrEntity).all()}
    rows = db.query(models.HrDepartment).all()
    out = [{
        "id": d.id,
        "name": d.name,
        "companyId": d.company_id or "",
        "companyName": entities.get(d.company_id or "", ""),
    } for d in rows]
    out.sort(key=lambda r: (r["companyName"].lower(), r["name"].lower()))
    return out


@router.get("/task-projects")
def list_projects(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.query(models.TaskProject).all()
    if is_manager(user):
        return [project_to_dict(p) for p in rows]
    # User dict, not email: externals only see projects they explicitly belong to (Aug 17).
    visible = visible_project_ids(db, user)
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
        # its teams' members, and task assignees) - a stricter default than
        # the DB column's own 'org' backfill for pre-existing rows.
        access_level=body.access_level or "restricted",
        status=body.status or "not_started",
        start_on=body.start_on or "", due_on=body.due_on or "",
        # Honors the form's Archived checkbox. This was hardcoded False, so
        # ticking it on the Create modal silently did nothing and the project
        # came back unarchived - the box round-tripped through the request body
        # and was thrown away here. bool() because the field is Optional and
        # omitting it must still mean "not archived".
        archived=bool(body.archived),
        activity_ids=[], created_at=now, modified_at=now, created_by=user["email"],
        custom_field_values=coerce_custom_field_values(db, body.custom_field_values or {}),
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
    # panel are all project-settings actions - Asana's "Project admin" tier,
    # not "Editor" (which only covers the tasks inside it).
    require_project_role(db, user, p, "owner")
    data = body.model_dump(exclude_unset=True, exclude={"id"})
    for k, v in data.items():
        if k == "owner_email" and v is not None:
            v = (v or "").lower()
        if k == "member_roles" and v:
            v = {em.lower(): role for em, role in v.items()}
        if k == "custom_field_values":
            v = coerce_custom_field_values(db, v or {})
        setattr(p, k, v)
    # A role grant is also an access grant - keep member_emails (the flat
    # "has access at all" list every other visibility check relies on) a
    # superset of member_roles' keys rather than two lists that can drift.
    if "member_roles" in data:
        p.member_emails = sorted(set(p.member_emails or []) | set((p.member_roles or {}).keys()))
    # hr_department_name is a snapshot of the picked department, never a free
    # text field - re-derived here so a client that sends only the id (or sends
    # a stale name alongside it) cannot leave the two disagreeing.
    if "hr_department_id" in data:
        dept = (db.query(models.HrDepartment)
                  .filter(models.HrDepartment.id == (p.hr_department_id or ""))
                  .first()) if p.hr_department_id else None
        p.hr_department_name = dept.name if dept else ""
        if p.hr_department_id and not dept:
            p.hr_department_id = ""
    p.modified_at = now_iso()
    db.commit()
    db.refresh(p)
    return project_to_dict(p)


@router.get("/task-projects/{project_id}/asana-link")
def project_asana_link(project_id: str, user: dict = Depends(get_current_user),
                       db: Session = Depends(get_db)):
    """Whether this project is mapped to an Asana project - so the delete dialog
    knows whether to offer "also delete it in Asana" at all, instead of showing
    a choice that would only 400. Owner-gated like the delete it precedes."""
    import asana_sync
    p = db.query(models.TaskProject).filter(models.TaskProject.id == project_id).first()
    if not p:
        raise HTTPException(404, "Project not found")
    require_project_role(db, user, p, "owner")
    gid = asana_sync.project_gid_for(db, project_id)
    return {"mapped": bool(gid), "asanaProjectGid": gid}


@router.delete("/task-projects/{project_id}")
def delete_project(project_id: str, delete_in_asana: bool = False,
                   user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Delete a project permanently, taking its tasks and its Asana sync state
    with it, so the same Asana project can be imported again from scratch.

    `delete_in_asana` is the caller's explicit answer to "also delete it in
    Asana?" - default FALSE, because the normal reason to do this is to
    re-import from an Asana project that must survive. When true the Asana
    project is deleted FIRST and a failure there aborts the whole thing with
    nothing removed on either side: the alternative (delete Nexus, then fail on
    Asana) would leave a project nobody can reach from Nexus any more and no
    record of the intent, which is precisely the lost-deletion problem
    AsanaPendingDelete exists to prevent for tasks. Asana's project delete is a
    soft delete (trash, 30 days), so this is recoverable there.

    The tasks are now DELETED rather than orphaned. Orphaning them left rows
    with no project and a live AsanaTaskLink, which silently absorbed every
    later re-import - see asana_sync.purge_project_sync."""
    import asana_sync
    p = db.query(models.TaskProject).filter(models.TaskProject.id == project_id).first()
    if not p:
        raise HTTPException(404, "Project not found")
    require_project_role(db, user, p, "owner")

    gid = asana_sync.project_gid_for(db, project_id)
    if delete_in_asana:
        if not gid:
            raise HTTPException(400, "This project isn't mapped to an Asana project, so there is nothing to delete in Asana.")
        done, err = asana_sync.delete_asana_project(db, gid)
        if not done:
            raise HTTPException(502, f"Asana refused to delete the project ({err}). Nothing was deleted - try again, or untick 'also delete in Asana'.")

    # Tasks + every Asana link + the project map row. Asana itself is untouched
    # by this call (the optional deletion above already happened).
    purged = asana_sync.purge_project_sync(db, project_id, actor=user["email"])

    # Detach the project from its teams. A team shared with other projects survives -
    # only one that existed solely for THIS project is removed.
    for team in db.query(models.TaskTeam).all():
        ids = team_project_ids(team)
        if project_id not in ids:
            continue
        remaining = [x for x in ids if x != project_id]
        if remaining:
            _set_team_projects(team, remaining)
        else:
            db.delete(team)
    for pf in db.query(models.TaskPortfolio).all():
        if project_id in (pf.project_ids or []):
            pf.project_ids = [x for x in pf.project_ids if x != project_id]
    db.delete(p)
    db.commit()
    return {"tasks": purged["tasks"], "mappings": purged["maps"],
            "asanaProjectDeleted": bool(delete_in_asana and gid), "asanaProjectGid": gid}


@router.post("/task-projects/backfill-teams", dependencies=[Depends(require_manager)])
def backfill_task_teams(apply: bool = False, db: Session = Depends(get_db)):
    """Give tasks the team their project already implies.

    A task's `team_id` is really an override of its project's team, but nothing
    ever set it - so every task created before teams were assigned shows "-" in
    the Team column even though the project has exactly one team. This fills
    those in.

    Only touches tasks that have NO team, and only in projects with EXACTLY ONE
    team: with several there is no right answer and guessing would be worse than
    the blank. An explicit team already on a task is never overwritten.

    Dry run by default, like dedupe_tasks and sweep_orphans."""
    single = {}
    for team in db.query(models.TaskTeam).all():
        for pid in team_project_ids(team):
            single.setdefault(pid, []).append(team.id)
    solo = {pid: ids[0] for pid, ids in single.items() if len(ids) == 1}
    if not solo:
        return {"filled": 0, "projects": 0, "applied": apply}

    rows = (db.query(models.Task)
            .filter(models.Task.project_id.in_(list(solo.keys())))
            .all())
    todo = [t for t in rows if not (t.team_id or "")]
    if apply:
        now = now_iso()
        for t in todo:
            t.team_id = solo[t.project_id]
            t.modified_at = now
        db.commit()
    return {"filled": len(todo), "projects": len({t.project_id for t in todo}), "applied": apply}


def handover_person(db: Session, email: str, to_email: str, include_completed: bool = False,
                    actor: str = "") -> dict:
    """Hand a departing person's task work to someone else. Called by HR
    offboarding - Tasks stays the single source of truth for these transitions,
    the same split routers.items.force_return_person uses for equipment.
    Operates in the CALLER's session (the caller commits); no per-task
    notifications, as this is a bulk admin action.

      • Every task assigned to them  -> reassigned to `to_email`.
      • Their project-less tasks     -> moved into a new "Handover - <name>"
                                        project owned by `to_email`.
      • Projects they OWNED          -> owner transferred to `to_email`.

    Completed tasks are skipped unless `include_completed`.

    Tasks that already sit in a project KEEP that project and are only
    reassigned. Moving them would strip live projects of their work to build the
    handover project - a departing engineer's twenty tasks would vanish out of
    the boards their teams are still running. Only genuinely homeless tasks
    (My Tasks items, project_id="") have nowhere else to be, so those are what
    the handover project collects.

    Subtasks are reassigned but never moved: a subtask carries project_id="" and
    reaches its project through its parent, so relocating one on its own would
    detach it from that parent's project.

    Returns {"reassigned": n, "moved": n, "projectsTransferred": n,
             "projectId": <new project id or "">}."""
    out = {"reassigned": 0, "moved": 0, "projectsTransferred": 0, "projectId": ""}
    email = (email or "").strip().lower()
    to_email = (to_email or "").strip().lower()
    if not email or not to_email or email == to_email:
        return out
    now = now_iso()

    # Python-side because assignee_emails is a JSON list (see the daily-briefing
    # note). A shared task keeps its other assignees - only the departing person
    # is swapped out, so handing over does not quietly unassign their colleagues.
    tasks = [t for t in db.query(models.Task).all() if email in task_assignees(t)]
    if not include_completed:
        tasks = [t for t in tasks if not t.completed]

    # Homeless top-level tasks are the only ones that need a new home. A subtask
    # (parent_task_id set) is never homeless - its parent holds its project.
    homeless = [t for t in tasks if not (t.project_id or "") and not (t.parent_task_id or "")]
    owned = db.query(models.TaskProject).filter(models.TaskProject.owner_email == email).all()

    if homeless:
        who = (db.query(models.NexusEmployee)
               .filter(models.NexusEmployee.work_email == email).first())
        label = " ".join(x for x in [(getattr(who, "first_name", "") or ""),
                                     (getattr(who, "last_name", "") or "")] if x).strip() or email
        project = models.TaskProject(
            id=gen_id(), name=f"Handover - {label}",
            description=f"Tasks handed over from {label} on offboarding.",
            owner_email=to_email, member_emails=[to_email], member_roles={to_email: "owner"},
            access_level="restricted", status="not_started",
            created_at=now, modified_at=now, created_by=actor or to_email,
        )
        db.add(project)
        db.flush()   # sessions are autoflush=False - the id must be visible below
        out["projectId"] = project.id
        for t in homeless:
            t.project_id = project.id
            out["moved"] += 1

    for t in tasks:
        set_task_assignees(t, [to_email if a == email else a for a in task_assignees(t)])
        t.modified_at = now
        out["reassigned"] += 1

    # A project whose owner has left has nobody who can edit its Share panel -
    # move it with the rest of the handover rather than leaving it orphaned.
    for p in owned:
        p.owner_email = to_email
        p.member_emails = sorted(set(p.member_emails or []) | {to_email})
        p.member_roles = {**(p.member_roles or {}), to_email: "owner"}
        p.modified_at = now
        out["projectsTransferred"] += 1

    return out


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
        project_ids=body.project_ids or [], archived=bool(body.archived),   # same drop as create_project had
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
    # side of the relationship - adding a project here never tagged the project
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


# ── Teams (may belong to many projects - see the TaskTeam model docstring) ──
class TeamBody(BaseModel):
    id: Optional[str] = None
    # project_ids is the real field; project_id is still accepted from older
    # clients and folded into the list rather than overwriting it.
    project_ids: Optional[list] = None
    project_id: Optional[str] = None
    # Optional so a partial PATCH (e.g. assigning just projects from a
    # project's Teams checklist) doesn't have to resend the name - required
    # in practice on create, checked explicitly below.
    name: Optional[str] = None
    color: Optional[str] = ""
    icon: Optional[str] = ""
    member_emails: Optional[list] = None
    access_role: Optional[str] = None   # Share panel: owner|editor|commenter|viewer this team's roster gets on its projects


def _set_team_projects(d: models.TaskTeam, ids) -> None:
    """Assign a team's projects, de-duplicated and order-preserving, and keep the
    legacy single column in step as a mirror of the first entry."""
    seen, clean = set(), []
    for pid in ids or []:
        pid = (pid or "").strip()
        if pid and pid not in seen:
            seen.add(pid)
            clean.append(pid)
    d.project_ids = clean
    d.project_id = clean[0] if clean else ""


@router.get("/task-teams")
def list_teams(db: Session = Depends(get_db)):
    return [team_to_dict(d) for d in db.query(models.TaskTeam).all()]


@router.post("/task-teams", status_code=201)
def create_team(body: TeamBody, db: Session = Depends(get_db)):
    if not (body.name or "").strip():
        raise HTTPException(422, "Team name is required")
    d = models.TaskTeam(id=body.id or gen_id(), name=body.name, color=body.color or "",
                        icon=body.icon or "", member_emails=body.member_emails or [],
                        created_at=now_iso())
    _set_team_projects(d, body.project_ids if body.project_ids is not None
                       else ([body.project_id] if body.project_id else []))
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
    # Projects go through _set_team_projects so the legacy mirror can never
    # drift from the list; a lone project_id from an old client is treated as
    # "this team's projects are exactly [that one]", which is what it meant.
    if "project_ids" in data:
        _set_team_projects(d, data.pop("project_ids"))
        data.pop("project_id", None)
    elif "project_id" in data:
        _set_team_projects(d, [data.pop("project_id")])
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


# ── Project templates & project copying ──────────────────────────────────────
# Asana's "New project" dialog, three ways in: Blank, Use a template, Copy an
# existing project. One engine underneath - _snapshot_project captures,
# _build_from_payload builds - so a fix to either half reaches all of them. A
# second row-copying routine alongside this would drift the way the Asana import
# used to drift from the pull (see the asana_sync contract note in CLAUDE.md).
#
# A TEMPLATE IS A BLUEPRINT: structure only.
#   Carried:  name/description/color as DEFAULTS, sections, tasks (title,
#             description, type, priority, tags, estimate, milestone, subtask
#             nesting, dependencies), dates as day OFFSETS, task custom-field
#             values, and the DEFINITIONS of the custom fields and custom
#             statuses the project uses.
#   Dropped:  every person and every access decision - owner, members and their
#             roles, teams, task assignees and followers, portfolio, People
#             department, and the visibility setting. Those are asked for when
#             the template is USED, because they belong to the new project and
#             not to the one that happened to be captured.
#
# A COPY (Duplicate / "from an existing project") is the opposite: it is meant
# to be the same project again, so it carries the people and the settings too.
# Same payload shape, `blueprint: false`, and the caller picks which parts to
# keep.
from datetime import date, timedelta   # noqa: E402  (kept beside the code that uses it)

from routers.task_config import (normalize_field_options,   # noqa: E402
                                 _dump_applies_to, _parse_applies_to)

PAYLOAD_VERSION = 2
BUILTIN_STATUSES = {"not_started", "in_progress", "completed", "recurring"}


def project_template_to_dict(t: models.TaskProjectTemplate) -> dict:
    payload = t.payload if isinstance(t.payload, dict) else {}
    tasks = payload.get("tasks") or []
    return {
        "id": t.id, "name": t.name, "description": t.description or "",
        "color": _nz(t.color), "category": t.category or "",
        "sourceProjectId": _nz(t.source_project_id), "sourceProjectName": t.source_project_name or "",
        "accessLevel": t.access_level or "org", "ownerId": _nz(t.owner_email),
        "archived": bool(t.archived), "useCount": t.use_count or 0,
        "lastUsedAt": _nz(t.last_used_at),
        "createdAt": t.created_at or "", "modifiedAt": t.modified_at or "",
        "createdBy": _nz(t.created_by),
        # Rollups, so the Templates grid can describe a template without every
        # card having to walk the payload itself.
        "taskCount": len(tasks),
        "sectionCount": len(payload.get("sections") or []),
        "fieldCount": len(payload.get("customFields") or []),
        "statusCount": len(payload.get("customStatuses") or []),
        # Payload format this row was captured in. A template saved before
        # custom fields/statuses were part of the snapshot reads as outdated, so
        # the Templates screen can offer to re-capture it instead of quietly
        # building projects that are missing their columns.
        "payloadVersion": int(payload.get("version") or 1),
        "outdated": int(payload.get("version") or 1) < PAYLOAD_VERSION,
        "hasDates": any(x.get("dueOffset") is not None or x.get("startOffset") is not None for x in tasks),
        # Defaults the "use" form pre-fills with - the template's suggestion,
        # never a setting it imposes.
        "defaults": {
            "name": (payload.get("project") or {}).get("name") or t.name,
            "description": (payload.get("project") or {}).get("description") or "",
            "color": (payload.get("project") or {}).get("color") or t.color or "",
        },
        "payload": payload,
    }


def _iso_day(value: str):
    """Parse a stored yyyy-mm-dd, or None for blank/garbage. Task dates are
    validated on write (_check_iso_date in tasks.py), but a snapshot may capture
    rows written before that existed."""
    try:
        return date.fromisoformat((value or "")[:10])
    except (ValueError, TypeError):
        return None


def _project_task_tree(db: Session, project_id: str) -> list:
    """Every task belonging to a project, parents before their children.

    Top-level rows are found by project_id; subtasks are reached through their
    parent's subtask_ids, because a subtask carries project_id="" and belongs to
    its project only through that parent - the same rule handover_person above
    relies on. `seen` guards cycles and repeats, so a malformed subtask_ids list
    cannot spin here."""
    by_id = {t.id: t for t in db.query(models.Task).all()}
    roots = [t for t in by_id.values()
             if (t.project_id or "") == project_id and not (t.parent_task_id or "")]
    roots.sort(key=lambda t: ((t.position if t.position is not None else 0.0), t.created_at or ""))
    out, seen = [], set()

    def walk(t):
        if t.id in seen:
            return
        seen.add(t.id)
        out.append(t)
        for sid in (t.subtask_ids or []):
            child = by_id.get(sid)
            if child is not None:
                walk(child)

    for r in roots:
        walk(r)
    return out


def _scoped_to(row, project_id: str) -> bool:
    """Whether a custom field / custom status is scoped to this project
    specifically. An EMPTY project_ids means "every project" for both models -
    global, and so not something a template needs to re-create."""
    return project_id in [p for p in (getattr(row, "project_ids", None) or []) if p]


def _snapshot_project(db: Session, p: models.TaskProject, *, blueprint: bool,
                      include_tasks: bool = True, include_subtasks: bool = True,
                      include_completed: bool = False, include_assignees: bool = True,
                      include_members: bool = True, include_dates: bool = True) -> dict:
    """Capture a project as a payload. Pure read - writes nothing.

    `blueprint=True` is the template capture: people and access decisions are
    left out entirely (see the module note above), so include_assignees /
    include_members are ignored in that mode rather than silently half-honored.
    """
    if blueprint:
        include_assignees = False
        include_members = False

    sections = (db.query(models.TaskSection)
                .filter(models.TaskSection.project_id == p.id).all())
    sections.sort(key=lambda s: (s.position or 0, s.name or ""))
    section_key = {s.id: i for i, s in enumerate(sections)}

    rows = _project_task_tree(db, p.id) if include_tasks else []
    if not include_subtasks:
        rows = [t for t in rows if not (t.parent_task_id or "")]
    if not include_completed:
        rows = [t for t in rows if not t.completed]
    keep = {t.id for t in rows}
    task_key = {t.id: i for i, t in enumerate(rows)}

    # ── Custom fields and statuses ───────────────────────────────────────────
    # Captured so the new project arrives with the columns and board columns the
    # blueprint was designed around, instead of a "Phase" value with no Phase
    # column to render it in. Two sources, unioned:
    #   • everything SCOPED to this project (its own columns), and
    #   • anything a captured row actually holds a value for, even if that
    #     definition is global - the value has to have somewhere to land.
    all_fields = db.query(models.TaskCustomField).all()
    used_field_ids = {fid for t in rows
                      for fid in (t.custom_field_values or {}) if fid}
    used_field_ids |= {fid for fid in (p.custom_field_values or {}) if fid}
    field_rows = [f for f in all_fields if _scoped_to(f, p.id) or f.id in used_field_ids]
    field_rows.sort(key=lambda f: (f.name or "").lower())
    field_key = {f.id: i for i, f in enumerate(field_rows)}

    all_statuses = db.query(models.TaskCustomStatus).all()
    used_status_ids = {(t.status or "") for t in rows} - BUILTIN_STATUSES
    status_rows = [s for s in all_statuses if _scoped_to(s, p.id) or s.id in used_status_ids]
    status_rows.sort(key=lambda s: (s.position or 0, (s.label or "").lower()))
    status_key = {s.id: i for i, s in enumerate(status_rows)}

    def field_values(raw):
        """Re-key {fieldId: value} onto the payload's own field keys. A value
        whose definition was not captured is dropped - it could only be
        re-attached by guessing."""
        if not isinstance(raw, dict):
            return {}
        return {str(field_key[fid]): v for fid, v in raw.items()
                if fid in field_key and v not in ("", None)}

    # Anchor day for the date offsets: the project's own start, else the
    # earliest date anywhere in the snapshot. Without one, dates are dropped -
    # an offset needs something to be an offset FROM.
    anchor = _iso_day(p.start_on) if include_dates else None
    if include_dates and anchor is None:
        days = [d for t in rows for d in (_iso_day(t.start_on), _iso_day(t.due_on)) if d]
        anchor = min(days) if days else None

    def offset(value):
        d = _iso_day(value) if (include_dates and anchor) else None
        return (d - anchor).days if d else None

    snap_tasks = []
    for t in rows:
        parent = t.parent_task_id or ""
        status = t.status or "not_started"
        snap_tasks.append({
            "key": task_key[t.id],
            # A kept subtask whose parent was filtered out is promoted to
            # top-level rather than dropped - losing the work would be worse
            # than losing its nesting.
            "parentKey": task_key.get(parent) if parent in keep else None,
            "sectionKey": section_key.get(t.section_id or ""),
            "title": t.title, "description": t.description or "",
            "type": t.type or "task",
            # A built-in status rides as itself; a custom one rides as a key
            # into customStatuses, because its real id may not exist yet in the
            # workspace this template is later used in.
            "status": status if status in BUILTIN_STATUSES else "",
            "statusKey": status_key.get(status),
            "priority": t.priority or "medium",
            "tags": list(t.tags or []),
            "assigneeEmail": (t.assignee_email or "") if include_assignees else "",
            "assigneeEmails": (task_assignees(t) if include_assignees else []),
            "followerEmails": list(t.follower_emails or []) if include_assignees else [],
            "estimateHours": t.estimate_hours,
            "isMilestone": bool(t.is_milestone),
            # Blueprint tasks inherit the new project's visibility rather than
            # carrying the old project's.
            "accessLevel": "" if blueprint else (t.access_level or "org"),
            "customFieldValues": field_values(t.custom_field_values),
            "startOffset": offset(t.start_on),
            "dueOffset": offset(t.due_on),
            # Only dependencies BETWEEN snapshot tasks survive - a blocker
            # outside the project is a link the copy has no counterpart for.
            "blockedByKeys": [task_key[b] for b in (t.blocked_by_ids or []) if b in keep],
            "dependencyTypes": {str(task_key[b]): v for b, v in (t.dependency_types or {}).items() if b in keep},
        })

    project_block = {
        "name": p.name, "description": p.description or "", "color": p.color or "",
        "startOffset": (_iso_day(p.start_on) - anchor).days if (anchor and _iso_day(p.start_on)) else None,
        "dueOffset": (lambda d: (d - anchor).days if (d and anchor) else None)(_iso_day(p.due_on)),
        "customFieldValues": field_values(p.custom_field_values),
    }
    if not blueprint:
        # A copy is the same project again, so it keeps who is on it and where
        # it is filed. A blueprint deliberately holds none of this.
        project_block.update({
            "accessLevel": p.access_level or "org",
            "portfolioId": p.portfolio_id or "",
            "hrDepartmentId": p.hr_department_id or "",
            "hrDepartmentName": p.hr_department_name or "",
            "ownerEmail": p.owner_email or "",
            "memberEmails": list(p.member_emails or []) if include_members else [],
            "memberRoles": dict(p.member_roles or {}) if include_members else {},
            "teamIds": [d.id for d in db.query(models.TaskTeam).all() if p.id in team_project_ids(d)],
        })

    return {
        "version": PAYLOAD_VERSION,
        "blueprint": bool(blueprint),
        "anchor": anchor.isoformat() if anchor else "",
        "project": project_block,
        "customFields": [{
            "key": field_key[f.id], "name": f.name, "description": f.description or "",
            "type": f.type or "text",
            "options": normalize_field_options(f.options if isinstance(f.options, list) else []),
            "required": bool(f.required), "readOnly": bool(f.read_only),
            "appliesTo": _parse_applies_to(f.applies_to),
            # Whether the SOURCE scoped it to that project. A global definition
            # is left global on rebuild rather than being narrowed to the new
            # project, which would take it off every board that has it today.
            "scoped": _scoped_to(f, p.id),
        } for f in field_rows],
        "customStatuses": [{
            "key": status_key[s.id], "label": s.label, "color": s.color or "",
            "position": s.position or 0, "scoped": _scoped_to(s, p.id),
        } for s in status_rows],
        "sections": [{"key": section_key[s.id], "name": s.name, "position": s.position or 0} for s in sections],
        "tasks": snap_tasks,
    }


def _widen_scope(row, project_id: str) -> None:
    """Make an existing definition visible on `project_id` as well.

    An EMPTY project_ids means "every project" for both TaskCustomField and
    TaskCustomStatus, which is already broader than what is being asked for -
    turning it into a one-project list here would take an existing column off
    every board that shows it today."""
    scope = [x for x in (getattr(row, "project_ids", None) or []) if x]
    if scope and project_id not in scope:
        row.project_ids = scope + [project_id]


def _adopt_legacy_definitions(db: Session, payload: dict, project_id: str) -> None:
    """Scope the custom fields and statuses a VERSION 1 payload refers to.

    v1 templates predate customFields/customStatuses in the payload and stored
    task values keyed by the real field id. Nothing declared those definitions,
    so a project built from such a template arrived with the values present but
    no column to render them in - the fields were simply invisible on the new
    board (reported Aug 2026: "Category and SAIT are missing").

    Rather than make people re-capture every template they already saved, the
    ids a v1 payload mentions are looked up and widened to cover the new
    project. A field that has since been deleted is skipped; its values are
    dropped by coerce_custom_field_values anyway."""
    field_ids, status_ids = set(), set()
    for spec in (payload.get("tasks") or []):
        field_ids |= {k for k in (spec.get("customFieldValues") or {}) if k}
        st = spec.get("status") or ""
        if st and st not in BUILTIN_STATUSES:
            status_ids.add(st)
    field_ids |= {k for k in ((payload.get("project") or {}).get("customFieldValues") or {}) if k}

    for f in db.query(models.TaskCustomField).filter(models.TaskCustomField.id.in_(field_ids or [""])).all():
        _widen_scope(f, project_id)
    for st in db.query(models.TaskCustomStatus).filter(models.TaskCustomStatus.id.in_(status_ids or [""])).all():
        _widen_scope(st, project_id)


def _resolve_custom_fields(db: Session, payload: dict, project_id: str) -> dict:
    """Make sure every custom field the payload names exists, and is visible on
    the new project. Returns {payloadKey: realFieldId}.

    Matched by NAME + TYPE against what the workspace already has, so using a
    template twice reuses one "Phase" column rather than minting "Phase",
    "Phase", "Phase". (Asana-derived fields key on asana_gid instead - see
    TaskCustomField - so a field that belongs to the sync is matched on that and
    never merged with a same-named Nexus-only one.)

    A definition the source had SCOPED to its project is scoped to the new
    project as well; a global one is left global - narrowing it here would take
    an existing column off every other board that shows it."""
    out = {}
    existing = db.query(models.TaskCustomField).all()
    by_name = {}
    for f in existing:
        by_name.setdefault(((f.name or "").strip().lower(), (f.type or "text").lower()), f)

    for spec in (payload.get("customFields") or []):
        name = (spec.get("name") or "").strip()
        if not name:
            continue
        kind = (spec.get("type") or "text").lower()
        f = by_name.get((name.lower(), kind))
        if f is None:
            f = models.TaskCustomField(
                id=gen_id(), name=name, description=spec.get("description") or "",
                type=kind, options=normalize_field_options(spec.get("options") or []),
                # A brand-new definition starts scoped to the project that
                # needed it, never workspace-wide: an unscoped field becomes a
                # column on every board in Nexus (see TaskCustomField.project_ids).
                project_ids=[project_id],
                required=bool(spec.get("required")), read_only=bool(spec.get("readOnly")),
                applies_to=_dump_applies_to(spec.get("appliesTo") or ["task"]),
                asana_gid="",
            )
            db.add(f)
            db.flush()   # autoflush=False - the id must be visible to the tasks below
            by_name[(name.lower(), kind)] = f
        elif spec.get("scoped"):
            _widen_scope(f, project_id)
        out[str(spec.get("key"))] = f.id
    return out


def _resolve_custom_statuses(db: Session, payload: dict, project_id: str) -> dict:
    """Custom statuses the same way, matched by LABEL.

    Label, not id, on purpose: TaskCustomStatus already treats the label as
    identity (one "Waiting" fronting several Asana option gids - see its
    docstring), so a template must not mint a second "Waiting" beside the one
    the workspace already runs on."""
    out = {}
    existing = db.query(models.TaskCustomStatus).all()
    by_label = {}
    for s in existing:
        by_label.setdefault((s.label or "").strip().lower(), s)

    for spec in (payload.get("customStatuses") or []):
        lbl = (spec.get("label") or "").strip()
        if not lbl:
            continue
        s = by_label.get(lbl.lower())
        if s is None:
            s = models.TaskCustomStatus(
                id=gen_id(), label=lbl, color=spec.get("color") or "",
                position=int(spec.get("position") or 0),
                project_ids=[project_id], asana_option_gid="", asana_option_gids=[],
            )
            db.add(s)
            db.flush()
            by_label[lbl.lower()] = s
        elif spec.get("scoped"):
            _widen_scope(s, project_id)
        out[str(spec.get("key"))] = s.id
    return out


class ProjectSettings(BaseModel):
    """What the NEW project should be - asked for at build time rather than
    inherited from a template, because a blueprint deliberately carries none of
    it. Every field is optional so a copy can simply omit them and keep the
    original's; `use_project_template` requires a name.

    Mirrors ProjectBody's vocabulary field for field, so the create-a-project
    form is the same form here."""
    name: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = None
    owner_email: Optional[str] = None
    member_emails: Optional[list] = None
    member_roles: Optional[dict] = None
    team_ids: Optional[list] = None
    portfolio_id: Optional[str] = None
    hr_department_id: Optional[str] = None
    access_level: Optional[str] = None
    start_on: Optional[str] = None       # the anchor every saved offset re-hangs from
    due_on: Optional[str] = None
    archived: Optional[bool] = None
    custom_field_values: Optional[dict] = None


def _build_from_payload(db: Session, payload: dict, user: dict, *,
                        settings: ProjectSettings, include_tasks: bool = True,
                        include_assignees: bool = True, include_members: bool = True,
                        include_teams: bool = True, reset_status: bool = True,
                        force_blueprint: bool = False) -> models.TaskProject:
    """Create a real project + custom fields/statuses + sections + tasks.

    The CALLER commits. Nothing here notifies or pushes to Asana: one call can
    mint a hundred rows, and a hundred "you were assigned a task" mails - or a
    hundred Asana creates against a project that isn't even mapped - is not what
    "use a template" means. The result is a fresh, unsynced project; the normal
    per-task flows take over from its first edit onward.

    `settings` always wins over the payload. For a blueprint the payload holds
    no people or access fields at all, so this is the only source; for a copy it
    is how the caller overrides one thing (a new name) while keeping the rest.
    """
    payload = payload if isinstance(payload, dict) else {}
    src = payload.get("project") or {}
    # `force_blueprint` is what a TEMPLATE build passes, rather than trusting the
    # payload's own flag: a version-1 template row has no `blueprint` key at all
    # and would otherwise be read as a copy, resurrecting the captured project's
    # owner, members and teams onto a brand-new project.
    blueprint = force_blueprint or bool(payload.get("blueprint"))
    legacy = int(payload.get("version") or 1) < PAYLOAD_VERSION
    if blueprint:
        # Belt and braces: a blueprint has nothing to inherit, so a stale client
        # sending include_assignees on one cannot resurrect people from it.
        include_assignees = False
        include_members = False
    now = now_iso()

    given = settings.model_dump(exclude_unset=True)

    def pick(key, payload_key=None, default=""):
        v = given.get(key)
        if v is not None:
            return v
        return src.get(payload_key or key, default) if not blueprint else default

    anchor = _iso_day(settings.start_on or "") or _iso_day(payload.get("anchor") or "") or date.today()

    def shift(offset):
        return (anchor + timedelta(days=int(offset))).isoformat() if offset is not None else ""

    owner = str(pick("owner_email", "ownerEmail") or user["email"] or "").strip().lower()
    members = [e for e in (pick("member_emails", "memberEmails", []) or []) if e] if include_members or given.get("member_emails") else []
    roles = dict(pick("member_roles", "memberRoles", {}) or {}) if include_members or given.get("member_roles") else {}
    if owner:
        members = sorted(set(members) | {owner})
        roles = {**roles, owner: "owner"}

    # The department NAME is a display snapshot of the picked id, never free
    # text - re-derived here the same way update_project does it.
    hr_dept_id = str(pick("hr_department_id", "hrDepartmentId") or "")
    dept = (db.query(models.HrDepartment).filter(models.HrDepartment.id == hr_dept_id).first()
            if hr_dept_id else None)

    name = str(pick("name") or src.get("name") or "").strip() or "Untitled project"
    p = models.TaskProject(
        id=gen_id(), name=name,
        description=str(pick("description") or ""),
        color=str(pick("color") or ""),
        owner_email=owner, member_emails=members, member_roles=roles,
        portfolio_id=str(pick("portfolio_id", "portfolioId") or ""),
        hr_department_id=(dept.id if dept else ""),
        hr_department_name=(dept.name if dept else ""),
        # Same stricter default create_project applies to a hand-made project.
        access_level=str(pick("access_level", "accessLevel") or "") or "restricted",
        status="not_started",
        start_on=(settings.start_on if settings.start_on is not None else shift(src.get("startOffset"))),
        due_on=(settings.due_on if settings.due_on is not None else shift(src.get("dueOffset"))),
        archived=bool(given.get("archived")),
        activity_ids=[], created_at=now, modified_at=now, created_by=user["email"],
        custom_field_values={},   # re-keyed below, once the field ids are known
    )
    db.add(p)
    db.flush()   # autoflush=False - p.id must be visible to the rows built below

    if p.portfolio_id:
        pf = db.query(models.TaskPortfolio).filter(models.TaskPortfolio.id == p.portfolio_id).first()
        if pf:
            pf.project_ids = list(pf.project_ids or []) + [p.id]
        else:
            p.portfolio_id = ""   # the template outlived the portfolio it named

    # Teams: whatever the caller picked, plus the copy's own if it is keeping them.
    team_ids = list(given.get("team_ids") or [])
    if include_teams and not blueprint:
        team_ids += [t for t in (src.get("teamIds") or []) if t not in team_ids]
    for tid in team_ids:
        team = db.query(models.TaskTeam).filter(models.TaskTeam.id == tid).first()
        if team and p.id not in team_project_ids(team):
            _set_team_projects(team, team_project_ids(team) + [p.id])

    field_ids = _resolve_custom_fields(db, payload, p.id)
    status_ids = _resolve_custom_statuses(db, payload, p.id)
    if legacy:
        _adopt_legacy_definitions(db, payload, p.id)

    def real_values(keyed):
        """Payload field keys -> real field ids, then through the normal
        coercion so a template can never write a value the field's own type
        would reject.

        A v1 payload keyed its values by the real field id already (there were
        no payload keys yet), so those pass straight through - re-keying them
        would map nothing and silently blank every value."""
        raw = keyed or {}
        mapped = raw if legacy else {field_ids[k]: v for k, v in raw.items() if k in field_ids}
        return coerce_custom_field_values(db, mapped)

    # Project-level values: the caller's own take precedence (they were entered
    # against real field ids on the create form); otherwise the blueprint's.
    p.custom_field_values = (coerce_custom_field_values(db, given.get("custom_field_values") or {})
                             if given.get("custom_field_values")
                             else real_values(src.get("customFieldValues")))

    section_ids = {}
    for s in (payload.get("sections") or []):
        row = models.TaskSection(id=gen_id(), project_id=p.id, name=s.get("name") or "Untitled",
                                 position=int(s.get("position") or 0), created_at=now)
        db.add(row)
        section_ids[s.get("key")] = row.id

    made = []
    if include_tasks:
        # One code read, incremented locally: _next_code counts rows, and with
        # autoflush=False the rows added in this loop are invisible to that
        # count - calling it per task would hand every task the same code.
        next_n = db.query(models.Task).count() + 1
        task_ids = {}
        for i, spec in enumerate(payload.get("tasks") or []):
            tid = gen_id()
            task_ids[spec.get("key")] = tid
            saved_status = spec.get("status") or status_ids.get(str(spec.get("statusKey")), "")
            row = models.Task(
                id=tid, code=f"TASK-{next_n + i:03d}",
                title=spec.get("title") or "Untitled task",
                description=spec.get("description") or "",
                type=spec.get("type") or "task",
                status=("not_started" if reset_status else (saved_status or "not_started")),
                priority=spec.get("priority") or "medium",
                # Payload order IS the intended order - the snapshot walked the
                # source's manual positions. Left as whole numbers so a later
                # drag between two of these still has room in between.
                position=float(i),
                # Set below via set_task_assignees, which writes both columns.
                assignee_email="",
                owner_email=owner,
                follower_emails=(list(spec.get("followerEmails") or []) if include_assignees else []),
                liked_by_emails=[],
                access_level=spec.get("accessLevel") or p.access_level or "org",
                # A subtask reaches its project through its parent and must keep
                # project_id blank - the same rule _project_task_tree reads by.
                project_id=("" if spec.get("parentKey") is not None else p.id),
                project_ids=[],
                section_id=section_ids.get(spec.get("sectionKey"), ""),
                team_id="",
                parent_task_id="", subtask_ids=[],
                blocked_by_ids=[], blocking_ids=[], dependency_types={},
                tags=list(spec.get("tags") or []),
                custom_field_values=real_values(spec.get("customFieldValues")),
                start_on=shift(spec.get("startOffset")), due_on=shift(spec.get("dueOffset")),
                estimate_hours=spec.get("estimateHours"), actual_hours=None, recurrence=None,
                is_milestone=bool(spec.get("isMilestone")),
                approval_status="none", completed=False, completed_at="",
                comment_ids=[], attachment_ids=[], activity_ids=[],
                created_at=now, modified_at=now, created_by=user["email"],
            )
            if include_assignees:
                # assigneeEmails is the real field; assigneeEmail is the v2-era
                # single that older payloads carry, folded in so a template
                # captured before multi-assignee still assigns its one person.
                set_task_assignees(row, spec.get("assigneeEmails")
                                   or [spec.get("assigneeEmail") or ""])
            db.add(row)
            made.append((spec, row))

        # Second pass: parent/subtask links and dependencies, now that every
        # payload key has a real id behind it.
        by_id = {r.id: r for _, r in made}
        for spec, row in made:
            pk = spec.get("parentKey")
            parent = by_id.get(task_ids.get(pk)) if pk is not None else None
            if parent is not None:
                row.parent_task_id = parent.id
                parent.subtask_ids = list(parent.subtask_ids or []) + [row.id]
            blockers = [task_ids[k] for k in (spec.get("blockedByKeys") or []) if k in task_ids]
            if blockers:
                row.blocked_by_ids = blockers
                types = {}
                for k, v in (spec.get("dependencyTypes") or {}).items():
                    try:
                        key = int(k)
                    except (TypeError, ValueError):
                        continue
                    if key in task_ids:
                        types[task_ids[key]] = v
                row.dependency_types = types
                for b in blockers:
                    blocker = by_id.get(b)
                    if blocker is not None:
                        blocker.blocking_ids = list(blocker.blocking_ids or []) + [row.id]

    log_activity(db, type="created", entity_kind="project", actor_email=user["email"],
                 entity_id=p.id, entity_code=p.name, entity_title=p.name,
                 detail=f"created this project from a {'template' if blueprint else 'copy'} ({len(made)} tasks)")
    return p


# ── Request bodies ───────────────────────────────────────────────────────────
class ProjectTemplateBody(BaseModel):
    """Save-as-template. `project_id` blank = an empty template (a shell filled
    in from the Templates screen); set = capture that project's structure."""
    id: Optional[str] = None
    project_id: Optional[str] = ""
    name: Optional[str] = None
    description: Optional[str] = ""
    color: Optional[str] = ""
    category: Optional[str] = ""
    access_level: Optional[str] = None      # who can SEE the template (org|restricted)
    include_tasks: Optional[bool] = True
    include_subtasks: Optional[bool] = True
    include_completed: Optional[bool] = False
    include_dates: Optional[bool] = True


class ProjectTemplatePatch(BaseModel):
    """Editing a saved template's own card - never its payload. Re-capturing is
    "Save as Template" again, which is honest about being a new snapshot."""
    name: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = None
    category: Optional[str] = None
    access_level: Optional[str] = None
    archived: Optional[bool] = None


class UseTemplateBody(ProjectSettings):
    """The create-a-project form, plus the two things only a template build has
    a say in. Inherits every project setting from ProjectSettings because that
    is the point: a blueprint asks for all of them."""
    include_tasks: Optional[bool] = True
    reset_status: Optional[bool] = True


class DuplicateProjectBody(ProjectSettings):
    """A copy keeps the original's settings unless a field here overrides one."""
    include_tasks: Optional[bool] = True
    include_subtasks: Optional[bool] = True
    include_completed: Optional[bool] = False
    include_assignees: Optional[bool] = True
    include_members: Optional[bool] = True
    include_teams: Optional[bool] = True
    include_dates: Optional[bool] = True
    reset_status: Optional[bool] = True


_BUILD_ONLY = {"include_tasks", "include_subtasks", "include_completed", "include_assignees",
               "include_members", "include_teams", "include_dates", "reset_status"}


def _settings_from(body: ProjectSettings) -> ProjectSettings:
    """The project-settings half of a use/duplicate body, with the build flags
    stripped. exclude_unset is preserved so "not sent" stays distinguishable
    from "sent empty" - the difference between keeping a copy's portfolio and
    deliberately clearing it."""
    data = {k: v for k, v in body.model_dump(exclude_unset=True).items() if k not in _BUILD_ONLY}
    return ProjectSettings(**data)


# ── Template endpoints ───────────────────────────────────────────────────────
def _template_visible(t: models.TaskProjectTemplate, user: dict) -> bool:
    if is_manager(user):
        return True
    if (t.access_level or "org") != "restricted":
        return True
    return (t.owner_email or "").lower() == (user.get("email") or "").lower()


def _get_template(db: Session, template_id: str) -> models.TaskProjectTemplate:
    t = (db.query(models.TaskProjectTemplate)
         .filter(models.TaskProjectTemplate.id == template_id).first())
    if not t:
        raise HTTPException(404, "Template not found")
    return t


def _require_template_owner(t: models.TaskProjectTemplate, user: dict) -> None:
    if is_manager(user):
        return
    if (t.owner_email or "").lower() != (user.get("email") or "").lower():
        raise HTTPException(403, "Only the template's owner can change or delete it.")


@router.get("/task-project-templates")
def list_project_templates(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = [t for t in db.query(models.TaskProjectTemplate).all() if _template_visible(t, user)]
    rows.sort(key=lambda t: (bool(t.archived), (t.name or "").lower()))
    return [project_template_to_dict(t) for t in rows]


@router.post("/task-project-templates", status_code=201)
def create_project_template(body: ProjectTemplateBody, user: dict = Depends(get_current_user),
                            db: Session = Depends(get_db)):
    """Save a project's STRUCTURE as a template (or create an empty one)."""
    source = None
    if body.project_id:
        source = (db.query(models.TaskProject)
                  .filter(models.TaskProject.id == body.project_id).first())
        if not source:
            raise HTTPException(404, "Project not found")
        # Capturing a project reads everything inside it, so it takes the same
        # tier as editing that project's contents.
        require_project_role(db, user, source, "editor")

    name = (body.name or (source.name if source else "")).strip()
    if not name:
        raise HTTPException(422, "Template name is required")

    payload = (_snapshot_project(db, source, blueprint=True,
                                 include_tasks=bool(body.include_tasks),
                                 include_subtasks=bool(body.include_subtasks),
                                 include_completed=bool(body.include_completed),
                                 include_dates=bool(body.include_dates))
               if source else
               {"version": PAYLOAD_VERSION, "blueprint": True, "anchor": "",
                "project": {"name": name, "description": body.description or "",
                            "color": body.color or "", "customFieldValues": {}},
                "customFields": [], "customStatuses": [], "sections": [], "tasks": []})

    now = now_iso()
    t = models.TaskProjectTemplate(
        id=body.id or gen_id(), name=name,
        description=body.description or (source.description if source else "") or "",
        color=body.color or (source.color if source else "") or "",
        category=body.category or "",
        source_project_id=(source.id if source else ""),
        source_project_name=(source.name if source else ""),
        payload=payload,
        access_level=body.access_level or "org",
        owner_email=user["email"].lower(),
        archived=False, use_count=0, last_used_at="",
        created_at=now, modified_at=now, created_by=user["email"],
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return project_template_to_dict(t)


@router.patch("/task-project-templates/{template_id}")
def update_project_template(template_id: str, body: ProjectTemplatePatch,
                            user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = _get_template(db, template_id)
    _require_template_owner(t, user)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(t, k, v)
    t.modified_at = now_iso()
    db.commit()
    db.refresh(t)
    return project_template_to_dict(t)


@router.delete("/task-project-templates/{template_id}", status_code=204)
def delete_project_template(template_id: str, user: dict = Depends(get_current_user),
                            db: Session = Depends(get_db)):
    """Delete the blueprint only. Projects already built from it are ordinary
    projects and are never touched - the template was a snapshot, not a link."""
    t = _get_template(db, template_id)
    _require_template_owner(t, user)
    db.delete(t)
    db.commit()


class RecaptureBody(BaseModel):
    """Refresh a template's payload from a project, in place. `project_id` blank
    re-reads the project it was originally captured from."""
    project_id: Optional[str] = ""
    include_tasks: Optional[bool] = True
    include_subtasks: Optional[bool] = True
    include_completed: Optional[bool] = False
    include_dates: Optional[bool] = True


@router.post("/task-project-templates/{template_id}/recapture")
def recapture_project_template(template_id: str, body: RecaptureBody,
                               user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Re-snapshot a template from its source project, keeping the template row.

    Save-as-Template deliberately mints a NEW template every time, so without
    this the only way to refresh one was to delete it and re-save - which throws
    away its name, category, sharing and use count, and breaks any habit people
    have of reaching for that card. It also gives templates captured in an older
    payload format (before custom fields and statuses were part of the snapshot)
    a way forward that is not "delete everything and start again".

    Only the payload is replaced. Projects already built from this template are
    untouched, as always - a template was never a live link."""
    t = _get_template(db, template_id)
    _require_template_owner(t, user)
    pid = (body.project_id or t.source_project_id or "").strip()
    if not pid:
        raise HTTPException(400, "This template wasn't captured from a project, so there is nothing to re-read. "
                                 "Pick a project to capture instead.")
    source = db.query(models.TaskProject).filter(models.TaskProject.id == pid).first()
    if not source:
        raise HTTPException(404, "The project this template was captured from no longer exists. "
                                 "Pick another project to capture from.")
    require_project_role(db, user, source, "editor")

    t.payload = _snapshot_project(db, source, blueprint=True,
                                  include_tasks=bool(body.include_tasks),
                                  include_subtasks=bool(body.include_subtasks),
                                  include_completed=bool(body.include_completed),
                                  include_dates=bool(body.include_dates))
    t.source_project_id = source.id
    t.source_project_name = source.name
    t.modified_at = now_iso()
    db.commit()
    db.refresh(t)
    return project_template_to_dict(t)


@router.post("/task-project-templates/{template_id}/use", status_code=201)
def use_project_template(template_id: str, body: UseTemplateBody,
                         user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Build a new project from a template. Every project setting comes from
    THIS request - the template holds none of them (see the module note)."""
    t = _get_template(db, template_id)
    if not _template_visible(t, user):
        raise HTTPException(403, "This template isn't shared with you.")
    if not (body.name or "").strip():
        raise HTTPException(422, "Project name is required")
    settings = _settings_from(body)
    # No owner picked means the person doing this owns it, exactly as a
    # hand-made project does.
    if not (settings.owner_email or "").strip():
        settings.owner_email = user["email"].lower()
    p = _build_from_payload(
        db, t.payload if isinstance(t.payload, dict) else {}, user,
        settings=settings,
        include_tasks=bool(body.include_tasks), reset_status=bool(body.reset_status),
        # A template is always a blueprint, whatever version its payload is.
        force_blueprint=True,
    )
    t.use_count = (t.use_count or 0) + 1
    t.last_used_at = now_iso()
    db.commit()
    db.refresh(p)
    return project_to_dict(p)


@router.post("/task-projects/{project_id}/duplicate", status_code=201)
def duplicate_project(project_id: str, body: DuplicateProjectBody,
                      user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Copy a project - Asana's "create a project from an existing project".

    Unlike a template this is meant to BE the project again, so it carries the
    people and the settings across unless the caller says otherwise. Snapshot-
    then-build, the same two halves the template flow runs, so a fix to one is a
    fix to all three entry points.

    The copy is NOT linked to Asana even when the original is: its tasks are new
    Nexus rows with no AsanaTaskLink, and minting Asana counterparts for a copy
    nobody has looked at yet is not what "duplicate" asks for."""
    src = db.query(models.TaskProject).filter(models.TaskProject.id == project_id).first()
    if not src:
        raise HTTPException(404, "Project not found")
    require_project_role(db, user, src, "editor")
    payload = _snapshot_project(db, src, blueprint=False,
                                include_tasks=bool(body.include_tasks),
                                include_subtasks=bool(body.include_subtasks),
                                include_completed=bool(body.include_completed),
                                include_assignees=bool(body.include_assignees),
                                include_members=bool(body.include_members),
                                include_dates=bool(body.include_dates))
    settings = _settings_from(body)
    if not (settings.name or "").strip():
        settings.name = f"{src.name} (copy)"
    # An unset start date keeps the original's own anchor rather than sliding
    # the copy onto today - "duplicate" means the same plan, not a rescheduled one.
    if settings.start_on is None:
        settings.start_on = src.start_on or payload.get("anchor") or ""
    p = _build_from_payload(
        db, payload, user, settings=settings,
        include_tasks=bool(body.include_tasks), include_assignees=bool(body.include_assignees),
        include_members=bool(body.include_members), include_teams=bool(body.include_teams),
        reset_status=bool(body.reset_status),
    )
    db.commit()
    db.refresh(p)
    return project_to_dict(p)


@router.get("/task-projects/{project_id}/template-preview")
def preview_project_template(project_id: str, include_subtasks: bool = True,
                             include_completed: bool = False, blueprint: bool = True,
                             user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """What a Save-as-template (blueprint=true) or a Duplicate (blueprint=false)
    would carry, without writing anything - so the dialog can say "24 tasks, 4
    sections, 2 custom fields" instead of asking people to guess. Read-only, and
    gated at viewer: it reports counts, not content."""
    p = db.query(models.TaskProject).filter(models.TaskProject.id == project_id).first()
    if not p:
        raise HTTPException(404, "Project not found")
    require_project_role(db, user, p, "viewer")
    payload = _snapshot_project(db, p, blueprint=blueprint, include_subtasks=include_subtasks,
                                include_completed=include_completed)
    tasks = payload.get("tasks") or []
    return {
        "projectId": p.id, "projectName": p.name, "blueprint": blueprint,
        "taskCount": len(tasks),
        "subtaskCount": sum(1 for t in tasks if t.get("parentKey") is not None),
        "sectionCount": len(payload.get("sections") or []),
        "fieldCount": len(payload.get("customFields") or []),
        "statusCount": len(payload.get("customStatuses") or []),
        "fieldNames": [f.get("name") for f in (payload.get("customFields") or [])],
        "statusLabels": [s.get("label") for s in (payload.get("customStatuses") or [])],
        # Only meaningful for a copy - a blueprint drops assignees by design.
        "assigneeCount": len({t.get("assigneeEmail") for t in tasks if t.get("assigneeEmail")}),
        "hasDates": any(t.get("dueOffset") is not None or t.get("startOffset") is not None for t in tasks),
        "anchor": payload.get("anchor") or "",
    }
