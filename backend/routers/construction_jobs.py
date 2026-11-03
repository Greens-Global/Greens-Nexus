"""The Job, Connected (Neil, 11/03/2026, plan
https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr, phase 2).

A Job (a construction_projects row - a Work Order or a Project) is the
place people look; the work itself stays in the module that already does
it best. This router is the Job's view of those modules, under the same
`/construction` prefix and the same walls as routers/construction.py (its
`_project` / `_may_read` / `_may_review` / `_may_log` are THE reach rules -
a job behind the caller's company wall is a 404, never a 403):

  Tasks          the job's task project: schedule, milestones, look-ahead
                 and the punch list (construction_tasks; every task write
                 through routers.tasks._create_task / update_task)
  Tickets        Start Job on a ticket, the job's source tickets; status
                 follows both ways in construction_ticket_sync's hook
  Asset Mgmt     the job's property, and a property's jobs (read only -
                 nothing here writes the Asset workspace)
  Shifts / Time  this week's crew from the planner, hours from the punches
                 (construction_labor - hours only, never pay)
  Forms          entries linked to the job (DocFormEntry.linked_project_id)
  Items          equipment out to the job: ordinary checkouts with a link
                 row (ConstructionJobLink kind 'checkout') - Items' own
                 tables and routes are untouched
  Search         the Jobs group in the header search

Field writes (punch items, Done, equipment links) take an id the phone may
make, so the offline outbox (feat/field-offline) can resend one safely: a
resend of a write that landed answers with what it made.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import auth
import construction_company
import construction_labor
import construction_tasks
import models
from auth import get_current_user
from database import get_db
from routers.construction import (_emails, _may_log, _may_read, _may_review, _me, _project,
                                  _visible_projects, project_to_dict, stamp_task_project, _may_see_cost)

router = APIRouter(prefix="/construction", tags=["Construction"],
                   dependencies=[Depends(get_current_user)])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _readable(db: Session, job_id: str, user: dict):
    p = _project(db, job_id, user)
    if not _may_read(db, user, p):
        raise HTTPException(403, "You do not have access to this job.")
    return p


def _names(db: Session, emails) -> dict:
    return construction_company.people_names(db, {(e or "").lower() for e in emails if e})


def _jobsite_today(db: Session, p) -> date:
    return construction_company.local_today(db, p)


# ── Schedule (the task project) ──────────────────────────────────────────────

def _task_row(t, names: dict) -> dict:
    from routers.tasks import task_to_dict
    d = task_to_dict(t)
    d["assigneeNames"] = {e: names.get(e, "") for e in (d.get("assigneeIds") or []) if e}
    return d


def _project_view(db: Session, p, user: dict) -> dict:
    """Everything the Schedule and Punch tabs read from the task project."""
    from routers.task_util import task_assignees, task_is_visible, visible_project_ids
    tp = construction_tasks.task_project(db, p)
    if tp is None:
        return {"taskProject": None, "tasks": [], "canStamp": _may_review(db, user, p)}
    rows = construction_tasks.project_tasks(db, tp)
    vis = visible_project_ids(db, user) | {tp.id}
    rows = [t for t in rows if task_is_visible(t, user, vis)]
    sec = construction_tasks.punch_section(db, tp, create=False)
    ver = construction_tasks.verified_status(db, tp, create=False)
    names = _names(db, {e for t in rows for e in task_assignees(t)})
    today = _jobsite_today(db, p)
    ahead = construction_tasks.look_ahead(rows, today)
    return {
        "taskProject": {"id": tp.id, "name": tp.name, "portfolioId": tp.portfolio_id or "",
                        "startOn": tp.start_on or "", "dueOn": tp.due_on or ""},
        "tasks": [_task_row(t, names) for t in rows],
        "punchSectionId": sec.id if sec else "",
        "sections": [{"id": s.id, "name": s.name or "", "position": s.position or 0}
                     for s in sorted(db.query(models.TaskSection).filter(models.TaskSection.project_id == tp.id).all(),
                                     key=lambda s: (s.position or 0, s.name or ""))],
        "verifiedStatusId": ver.id if ver else "",
        "lookAheadIds": [t.id for t in ahead],
        "milestoneIds": [t.id for t in sorted((t for t in rows if t.is_milestone),
                                              key=lambda t: (t.due_on or "9999"))],
        "punch": construction_tasks.punch_counts(rows, sec.id if sec else "", ver.id if ver else ""),
        "today": today.isoformat(),
        "canEdit": _may_review(db, user, p),
        "canLog": _may_log(db, user, p),
    }


@router.get("/projects/{job_id}/schedule")
def job_schedule(job_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    p = _readable(db, job_id, user)
    return _project_view(db, p, user)


@router.post("/projects/{job_id}/task-project", status_code=201)
def make_task_project(job_id: str, body: dict = None, user: dict = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    """Stamp the job's task project now (a job made before 11/03/2026, or
    one whose template did not build). A reviewer's act; idempotent."""
    p = _project(db, job_id, user)
    if not _may_review(db, user, p):
        raise HTTPException(403, "Only a job manager can set up the schedule.")
    if construction_tasks.task_project(db, p) is None:
        stamp_task_project(db, p, user, str((body or {}).get("templateId") or ""))
        if construction_tasks.task_project(db, p) is None:
            raise HTTPException(409, "The schedule could not be set up - try again.")
        construction_tasks.migrate_milestones(db, p, user)
    return _project_view(db, p, user)


class PortfolioIn(BaseModel):
    portfolio_id: str = ""


@router.post("/projects/{job_id}/portfolio")
def add_to_portfolio(job_id: str, body: PortfolioIn, user: dict = Depends(get_current_user),
                     db: Session = Depends(get_db)):
    """A program of jobs is a Tasks portfolio: "Add to Portfolio" puts the
    job's task project in one ('' takes it out) through Tasks' own project
    update (its owner check and the portfolio's wall)."""
    p = _project(db, job_id, user)
    if not _may_review(db, user, p):
        raise HTTPException(403, "Only a job manager can change its portfolio.")
    tp = construction_tasks.task_project(db, p)
    if tp is None:
        raise HTTPException(409, "Set up the job's schedule first.")
    from routers import task_projects
    task_projects.update_project(tp.id, task_projects.ProjectBody(portfolio_id=body.portfolio_id or ""), user, db)
    return {"portfolioId": body.portfolio_id or ""}


# ── Punch list ───────────────────────────────────────────────────────────────

class PunchIn(BaseModel):
    id: Optional[str] = None            # made on the phone (offline outbox) - a resend answers with the item
    title: str
    description: Optional[str] = ""
    assignee_emails: Optional[list] = None
    due_on: Optional[str] = ""


def _punch_task(db: Session, task_id: str, user: dict, punch_only: bool = True):
    """(job, task project, task) for a punch item (or, `punch_only` False,
    any task of the job's project - a work order's steps) the caller may reach."""
    t = db.query(models.Task).filter(models.Task.id == task_id).first()
    if t is None:
        raise HTTPException(404, "Punch item not found")
    job = construction_tasks.job_for_task_project(db, t.project_id or "")
    if job is None:
        raise HTTPException(404, "Punch item not found")
    job = _project(db, job.id, user)
    if not _may_read(db, user, job):
        raise HTTPException(404, "Punch item not found")
    tp = construction_tasks.task_project(db, job)
    sec = construction_tasks.punch_section(db, tp, create=False) if tp else None
    if tp is None or t.project_id != tp.id or (punch_only and (sec is None or t.section_id != sec.id)):
        raise HTTPException(404, "Punch item not found")
    return job, tp, t


@router.post("/projects/{job_id}/punch", status_code=201)
def add_punch_item(job_id: str, body: PunchIn, background_tasks: BackgroundTasks,
                   user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A punch item: a task in the job's "Punch" section, made through
    routers.tasks._create_task. The crew and the job's managers may add one."""
    from routers import tasks as tasks_router
    p = _project(db, job_id, user)
    if not _may_log(db, user, p):
        raise HTTPException(403, "You are not on this job.")
    title = (body.title or "").strip()[:300]
    if not title:
        raise HTTPException(422, "Say what needs fixing.")
    # A job with no schedule yet (one made before 11/03/2026) gets the
    # template's sections and statuses only from here - never the template's
    # tasks dated from a start that may be long past.
    tp = construction_tasks.ensure_task_project(db, p, user, include_tasks=False)
    if tp is None:
        raise HTTPException(409, "Set up the job's schedule first.")
    sec = construction_tasks.punch_section(db, tp)
    db.commit()
    tid = (body.id or "").strip()[:64]
    if tid:
        was = db.query(models.Task).filter(models.Task.id == tid).execution_options(include_deleted=True).first()
        if was is not None:
            if was.project_id != tp.id:
                raise HTTPException(409, "That id is taken.")
            return _task_row(was, _names(db, was.assignee_emails or []))
    people = sorted(_emails(body.assignee_emails or []))
    made = tasks_router._create_task(
        tasks_router.TaskCreate(id=tid or None, title=title, description=body.description or "",
                                project_id=tp.id, section_id=sec.id, assignee_emails=people,
                                due_on=(body.due_on or "")[:10]),
        background_tasks, user, db, check_people=True)
    t = db.query(models.Task).filter(models.Task.id == made["id"]).first()
    return _task_row(t, _names(db, people))


class DoneIn(BaseModel):
    done: bool = True


@router.post("/punch/{task_id}/done")
def punch_done(task_id: str, body: DoneIn, background_tasks: BackgroundTasks,
               user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The crew's step: Done (or not done) - a punch item, or any step of the
    job's task project (a work order's Tasks tab). Through update_task.
    Idempotent - asking for the state it is already in changes nothing.
    Taking Done back also takes Verified away."""
    from routers import tasks as tasks_router
    job, tp, t = _punch_task(db, task_id, user, punch_only=False)
    if not _may_log(db, user, job):
        raise HTTPException(403, "You are not on this job.")
    if bool(t.completed) != bool(body.done):
        tasks_router.update_task(t.id, tasks_router.TaskUpdate(completed=bool(body.done)), background_tasks, user, db)
    db.refresh(t)
    return _task_row(t, _names(db, t.assignee_emails or []))


class VerifyIn(BaseModel):
    verified: bool = True


@router.post("/punch/{task_id}/verify")
def punch_verify(task_id: str, body: VerifyIn, background_tasks: BackgroundTasks,
                 user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The reviewer's step: Verified - the project's "Verified" custom status
    set WITH completed (so the item stays done everywhere Tasks counts done).
    Only a Done item; unverify puts it back to plain Done."""
    from routers import tasks as tasks_router
    job, tp, t = _punch_task(db, task_id, user)
    if not _may_review(db, user, job):
        raise HTTPException(403, "Only a job manager can verify punch items.")
    ver = construction_tasks.verified_status(db, tp)
    db.commit()
    if body.verified:
        if not t.completed:
            raise HTTPException(409, "Mark it Done first - the crew's step comes before Verified.")
        if t.status != ver.id:
            tasks_router.update_task(t.id, tasks_router.TaskUpdate(status=ver.id, completed=True), background_tasks, user, db)
    elif t.status == ver.id:
        tasks_router.update_task(t.id, tasks_router.TaskUpdate(status="completed", completed=True), background_tasks, user, db)
    db.refresh(t)
    return _task_row(t, _names(db, t.assignee_emails or []))


# ── Tickets: Start Job, the job's source tickets ─────────────────────────────

def _ticket_links(db: Session, job_id: str = "", ticket_id: str = "", kind: str = "ticket") -> list:
    L = models.ConstructionJobLink
    q = db.query(L).filter(L.kind == kind, L.ended_at == "")
    if job_id:
        q = q.filter(L.project_id == job_id)
    if ticket_id:
        q = q.filter(L.ref_id == ticket_id)
    return q.order_by(L.created_at).all()


def _ticket_card(db: Session, t, photos: bool = True) -> dict:
    out = {"id": t.id, "code": t.code or "", "subject": t.subject or "",
           "status": "open" if (t.status or "") == "new" else (t.status or ""),
           "requesterEmail": (t.requester_email or "").lower(),
           "propertyId": t.property_asset_id or "", "propertyName": t.property_name or "",
           "createdAt": t.created_at or ""}
    if photos:
        A = models.TaskAttachment
        imgs = [a.url for a in db.query(A).filter(A.task_id == t.id, A.kind == "image").all() if a.url]
        imgs += [u for u in (t.images or []) if isinstance(u, str) and u.startswith("http")]
        out["photos"] = imgs[:12]
    return out


class StartJobIn(BaseModel):
    id: Optional[str] = None             # made on the phone - a resend answers with the job
    project_id: Optional[str] = ""       # link to this existing job instead of making one
    name: Optional[str] = ""
    worker_emails: Optional[list] = None
    manager_emails: Optional[list] = None
    task_template_id: Optional[str] = ""


@router.post("/tickets/{ticket_id}/start-job", status_code=201)
def start_job(ticket_id: str, body: StartJobIn, user: dict = Depends(get_current_user),
              db: Session = Depends(get_db)):
    """Tickets ARE the maintenance work orders; "Start Job" gives one a Job
    when it needs a crew, materials or more than a day. A Work Order job,
    prefilled from the ticket (its subject, description, property, requester;
    its photos show on the job through the link), linked ticket <-> job. A
    ticket with a live job answers with that job (one job per ticket unless
    another is named). The ticket keeps its SLA and its queue; its status
    follows the job's (construction_ticket_sync). Never a confidential
    (Ask HR) ticket - it is a 404 here, as for Create Task. Managers make
    jobs (as New Job), from the desk's own ticket access."""
    from routers.construction import ProjectBody, create_job
    from routers.tickets import _may_patch_ticket
    from routers.task_util import log_activity
    import property_links
    t = db.query(models.TaskTicket).filter(models.TaskTicket.id == ticket_id).first()
    if t is None:
        raise HTTPException(404, "Ticket not found")
    auth.assert_company(t.company_id or "", user, db)
    if not _may_patch_ticket(db, t, user):
        raise HTTPException(403, "You don't have access to this ticket")
    if int(user.get("level") or 0) < 3:
        raise HTTPException(403, "Only a manager can start a job.")
    live = _ticket_links(db, ticket_id=t.id)
    if live and not body.project_id:
        job = db.query(models.ConstructionProject).filter(
            models.ConstructionProject.id == live[0].project_id,
            models.ConstructionProject.deleted_at == "").first()
        if job is not None:
            return {"job": project_to_dict(job, with_cost=_may_see_cost(db, user, job), db=db,
                                           can_edit=_may_review(db, user, job)), "created": False}
    if body.project_id:
        job = _project(db, body.project_id, user)
        if not _may_review(db, user, job):
            raise HTTPException(403, "Only a job manager can add a ticket to it.")
        created = False
    else:
        prop_id = t.property_asset_id or ""
        if prop_id:
            prop = db.get(models.PropertyAsset, prop_id)
            if prop is None or not property_links.viewable(prop, user):
                prop_id = ""
        desc = (t.description or "").strip()
        req = (t.requester_email or "").lower()
        lines = [f"From ticket {t.code or ''}".strip() + (f", requested by {req}." if req else ".")]
        if desc:
            lines.append(desc)
        # The job is the TICKET's company's (else its property's) - never just
        # the starter's: a manager who works another company's desk starts a
        # job for that company.
        import construction_company
        company = (t.company_id or "") or construction_company.company_from_property(db, prop_id or t.property_asset_id or "")
        job_dict = create_job(ProjectBody(
            id=body.id or None, name=(body.name or t.subject or "Work Order").strip()[:200],
            job_type="work_order", description="\n\n".join(lines)[:4000], property_id=prop_id,
            address=t.property_name or "", worker_emails=body.worker_emails or None,
            manager_emails=body.manager_emails or None, task_template_id=body.task_template_id or ""),
            user, db, company_id=company or None)
        job = db.get(models.ConstructionProject, job_dict["id"])
        created = True
    if not _ticket_links(db, job_id=job.id, ticket_id=t.id):
        db.add(models.ConstructionJobLink(id=str(uuid.uuid4()), project_id=job.id, kind="ticket", ref_id=t.id,
                                          created_by=_me(user), created_at=_now(), ended_at="", note=""))
        log_activity(db, type="job_linked", actor_email=_me(user), entity_kind="ticket", entity_id=t.id,
                     entity_code=t.code or "", entity_title=t.subject or "",
                     detail=f"{'started the job' if created else 'added this ticket to the job'} {job.name}")
        db.add(models.ConstructionActivity(
            id=str(uuid.uuid4()), project_id=job.id, entity_kind="project", entity_id=job.id, type="ticket_linked",
            actor_email=_me(user), at=_now(), detail=f"linked ticket {t.code or t.subject or t.id}"))
        t.modified_at = _now()
        db.commit()
    db.refresh(job)
    return {"job": project_to_dict(job, with_cost=_may_see_cost(db, user, job), db=db,
                                   can_edit=_may_review(db, user, job)), "created": created}


@router.get("/tickets/{ticket_id}/jobs")
def ticket_jobs(ticket_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The jobs a ticket is linked to (the Job chip in the ticket drawer) -
    only those the caller may read, and only for a ticket they may read."""
    from routers.tickets import _require_ticket_participant
    t = db.query(models.TaskTicket).filter(models.TaskTicket.id == ticket_id).first()
    if t is None:
        raise HTTPException(404, "Ticket not found")
    _require_ticket_participant(db, user, t)
    out = []
    for lk in _ticket_links(db, ticket_id=t.id):
        job = db.query(models.ConstructionProject).filter(models.ConstructionProject.id == lk.project_id,
                                                          models.ConstructionProject.deleted_at == "").first()
        # _may_read is the wall: the job's own people, or a manager inside its company.
        if job is not None and _may_read(db, user, job):
            out.append({"id": job.id, "name": job.name, "status": job.status or "active",
                        "jobType": construction_tasks.job_type_of(job)})
    return {"jobs": out, "canStart": int(user.get("level") or 0) >= 3}


# ── Equipment (Items checkouts linked to the job) ───────────────────────────

def _checkout_card(c, names: dict) -> dict:
    holder = (c.requested_by_email or "").lower()
    return {"checkoutId": c.id, "itemId": c.item_id or "", "itemName": c.item_name or "",
            "itemType": c.item_type or "", "status": c.status or "", "holderEmail": holder,
            "holderName": names.get(holder, "") or c.requested_by or "",
            "handedOverAt": c.handed_over_at or c.allocated_at or "", "returnedAt": c.returned_at or ""}


@router.get("/projects/{job_id}/equipment")
def job_equipment(job_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Equipment out to the job (open links), and for the job's people the
    checkouts they hold that could be added."""
    p = _readable(db, job_id, user)
    C = models.ItemCheckout
    links = _ticket_links(db, job_id=p.id, kind="checkout")
    by_id = {c.id: c for c in db.query(C).filter(C.id.in_([lk.ref_id for lk in links] or [""])).all()}
    people = sorted(_emails(p.worker_emails) | _emails(p.manager_emails))
    held = []
    if _may_log(db, user, p):
        linked = set(by_id)
        held = [c for c in db.query(C).filter(C.requested_by_email.in_(people or [""]),
                                              C.status.in_(("allocated", "pending_receipt"))).all()
                if c.id not in linked]
    names = _names(db, [c.requested_by_email for c in list(by_id.values()) + held])
    out = []
    for lk in links:
        c = by_id.get(lk.ref_id)
        if c is not None:
            out.append({"linkId": lk.id, "linkedAt": lk.created_at, **_checkout_card(c, names)})
    return {"equipment": out, "candidates": [_checkout_card(c, names) for c in held],
            "canEdit": _may_log(db, user, p)}


class EquipmentIn(BaseModel):
    id: Optional[str] = None        # made on the phone - a resend answers with the link
    checkout_id: str


@router.post("/projects/{job_id}/equipment", status_code=201)
def link_equipment(job_id: str, body: EquipmentIn, user: dict = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """Put an ordinary Items checkout on the job. Only a checkout that is out
    (allocated or awaiting receipt) to one of the job's people; one live job
    per checkout - moving it ends the old link (history kept)."""
    p = _project(db, job_id, user)
    if not _may_log(db, user, p):
        raise HTTPException(403, "You are not on this job.")
    L = models.ConstructionJobLink
    if body.id:
        was = db.get(L, body.id)
        if was is not None:
            if was.project_id != p.id:
                raise HTTPException(409, "That id is taken.")
            return {"linkId": was.id}
    c = db.get(models.ItemCheckout, body.checkout_id)
    people = _emails(p.worker_emails) | _emails(p.manager_emails)
    if c is None or (c.requested_by_email or "").lower() not in people or c.status not in ("allocated", "pending_receipt"):
        raise HTTPException(422, "Pick equipment that is checked out to someone on this job.")
    for old in db.query(L).filter(L.kind == "checkout", L.ref_id == c.id, L.ended_at == "").all():
        if old.project_id == p.id:
            return {"linkId": old.id}
        old.ended_at = _now()
        old.note = f"moved to {p.name}"
    lk = L(id=(body.id or str(uuid.uuid4()))[:64], project_id=p.id, kind="checkout", ref_id=c.id,
           created_by=_me(user), created_at=_now(), ended_at="", note="")
    db.add(lk)
    db.add(models.ConstructionActivity(id=str(uuid.uuid4()), project_id=p.id, entity_kind="project",
                                       entity_id=p.id, type="equipment_linked", actor_email=_me(user),
                                       at=_now(), detail=f"{c.item_name or 'equipment'} on the job"))
    db.commit()
    return {"linkId": lk.id}


@router.post("/equipment-links/{link_id}/end")
def end_equipment(link_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    lk = db.get(models.ConstructionJobLink, link_id)
    if lk is None or lk.kind != "checkout":
        raise HTTPException(404, "Not found")
    p = _project(db, lk.project_id, user)
    if not _may_log(db, user, p):
        raise HTTPException(403, "You are not on this job.")
    if not lk.ended_at:
        lk.ended_at = _now()
        lk.note = lk.note or "taken off the job"
        db.commit()
    return {"ok": True}


# ── Field: crew, hours, forms, photos ────────────────────────────────────────

@router.get("/projects/{job_id}/crew")
def job_crew(job_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    p = _readable(db, job_id, user)
    crew = construction_labor.crew_this_week(db, p, _jobsite_today(db, p))
    names = _names(db, [c["email"] for c in crew["people"]])
    for c in crew["people"]:
        c["name"] = names.get(c["email"], "")
    return crew


@router.get("/projects/{job_id}/labor")
def job_labor(job_id: str, date_from: str = "", date_to: str = "", user: dict = Depends(get_current_user),
              db: Session = Depends(get_db)):
    """Hours worked on the job, by day and person, from Time Clock punches
    stamped with its jobsite. HOURS ONLY - no rate, no cost, ever, so the
    pay-hidden rule holds for every caller. A job reviewer sees everyone;
    anyone else on the job sees their own hours."""
    p = _readable(db, job_id, user)
    only = "" if _may_review(db, user, p) else _me(user)
    out = construction_labor.hours(db, p, date_from=date_from[:10], date_to=date_to[:10], only_email=only)
    out["names"] = _names(db, list(out["byPerson"]))
    out["ownOnly"] = bool(only)
    return out


@router.get("/projects/{job_id}/forms")
def job_forms(job_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Form entries linked to the job (inspections, safety, toolbox talks):
    the title, who, when and the status - never the answers, which stay
    behind the Forms reach rule on the entry itself (Documents > Forms).
    Only the entries that rule (form_audience - the ONE reach rule) lets the
    caller see at all."""
    import form_audience
    p = _readable(db, job_id, user)
    E = models.DocFormEntry
    reach = form_audience.viewer_reach(db, user)
    rows = [e for e in (db.query(E).filter(E.linked_project_id == p.id, E.deleted_at == "")
                        .order_by(E.submitted_at.desc()).limit(300).all()) if reach(e)][:100]
    names = _names(db, [e.submitted_by for e in rows])
    return {"entries": [{"id": e.id, "title": e.title or "Form", "status": e.status or "submitted",
                         "submittedBy": (e.submitted_by or "").lower(),
                         "submittedByName": names.get((e.submitted_by or "").lower(), ""),
                         "submittedAt": e.submitted_at or ""} for e in rows]}


@router.get("/projects/{job_id}/photos")
def job_photos(job_id: str, limit: int = 60, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The job's newest photos across its daily logs - a submitted log's to
    everyone on the job, a draft's only to its author (and reviewers), the
    same privacy as the logs; removed photos never show."""
    p = _readable(db, job_id, user)
    L, M = models.ConstructionDailyLog, models.ConstructionMedia
    logs = {lg.id: lg for lg in db.query(L).filter(L.project_id == p.id, L.deleted_at == "").all()}
    reviewer, me = _may_review(db, user, p), _me(user)
    ok = {i for i, lg in logs.items() if lg.status != "draft" or reviewer or (lg.author_email or "").lower() == me}
    rows = (db.query(M).filter(M.project_id == p.id, M.kind == "photo", M.deleted_at == "",
                               M.daily_log_id.in_(sorted(ok) or [""]))
            .order_by(M.uploaded_at.desc()).limit(max(1, min(int(limit or 60), 200))).all())
    return {"photos": [{"id": m.id, "url": m.url or "", "thumbnailUrl": m.thumbnail_url or m.url or "",
                        "takenAt": m.taken_at or m.uploaded_at or "", "logId": m.daily_log_id or "",
                        "logDate": (logs.get(m.daily_log_id).log_date if logs.get(m.daily_log_id) else ""),
                        "caption": m.caption or m.description or ""} for m in rows]}


# ── The Overview's connected facts ───────────────────────────────────────────

@router.get("/projects/{job_id}/connected")
def job_connected(job_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """What the Job page's Overview shows beside the health row: the next
    milestones, what needs the caller, punch counts, the last log, this
    week's crew, the source tickets and the property."""
    import property_links
    p = _readable(db, job_id, user)
    me = _me(user)
    view = _project_view(db, p, user)
    tasks = {t["id"]: t for t in view.get("tasks") or []}
    today = view.get("today") or _jobsite_today(db, p).isoformat()
    next_ms = [tasks[i] for i in view.get("milestoneIds") or [] if i in tasks
               and not tasks[i].get("completed") and (tasks[i].get("dueOn") or "") >= today][:3]
    L, R, S = models.ConstructionDailyLog, models.ConstructionRfi, models.ConstructionSubmittal
    needs = {"logsToReview": 0, "rfisToAnswer": 0, "submittalsToDecide": 0, "myPunch": 0}
    if _may_review(db, user, p):
        needs["logsToReview"] = (db.query(L).filter(L.project_id == p.id, L.deleted_at == "",
                                                    L.status.in_(("submitted", "processed")),
                                                    L.author_email != me).count())
    needs["rfisToAnswer"] = (db.query(R).filter(R.project_id == p.id, R.deleted_at == "", R.status == "open",
                                                R.responder_email == me).count())
    needs["submittalsToDecide"] = (db.query(S).filter(S.project_id == p.id, S.deleted_at == "",
                                                      S.status.in_(("pending", "submitted")),
                                                      S.approver_email == me).count())
    psec = view.get("punchSectionId") or ""
    needs["myPunch"] = len([t for t in tasks.values() if psec and t.get("sectionId") == psec
                            and not t.get("completed") and me in (t.get("assigneeIds") or [])])
    last = (db.query(L).filter(L.project_id == p.id, L.deleted_at == "", L.status != "draft")
            .order_by(L.log_date.desc(), L.submitted_at.desc()).first())
    tickets = []
    for lk in _ticket_links(db, job_id=p.id):
        t = db.query(models.TaskTicket).filter(models.TaskTicket.id == lk.ref_id).first()
        if t is not None:
            tickets.append(_ticket_card(db, t))
    prop = None
    if p.property_id:
        row = db.get(models.PropertyAsset, p.property_id)
        if row is not None and property_links.viewable(row, user):
            pay = row.payload or {}
            prop = {"id": row.id, "name": property_links.display_name(row),
                    "address": pay.get("address") or "", "city": pay.get("city") or "",
                    "state": pay.get("state") or ""}
    crew = construction_labor.crew_this_week(db, p, _jobsite_today(db, p))
    names = _names(db, [c["email"] for c in crew["people"]] + [t.get("requesterEmail") for t in tickets]
                   + ([last.author_email] if last else []))
    for c in crew["people"]:
        c["name"] = names.get(c["email"], "")
    return {
        "taskProjectId": (view.get("taskProject") or {}).get("id", ""),
        "nextMilestones": next_ms,
        "needsYou": needs,
        "punch": view.get("punch") or {"open": 0, "done": 0, "verified": 0, "total": 0},
        "lastLog": ({"id": last.id, "logDate": last.log_date, "status": last.status,
                     "authorName": names.get((last.author_email or "").lower(), ""),
                     "crewSize": last.crew_size or 0, "hoursWorked": last.hours_worked or 0}
                    if last else None),
        "crew": crew,
        "tickets": tickets,
        "property": prop,
        "names": names,
    }


# ── Lookups other modules call ───────────────────────────────────────────────

@router.get("/task-projects/{task_project_id}/job")
def job_for_task_project(task_project_id: str, user: dict = Depends(get_current_user),
                         db: Session = Depends(get_db)):
    """The Job chip on a task: the job whose task project this is, when the
    caller may read the job ({"job": None} otherwise - never a 403 here)."""
    job = construction_tasks.job_for_task_project(db, task_project_id)
    if job is None or not _may_read(db, user, job):
        return {"job": None}
    return {"job": {"id": job.id, "name": job.name, "jobType": construction_tasks.job_type_of(job)}}


@router.get("/properties/{property_id}/jobs")
def property_jobs(property_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A property's jobs for its Asset Management page (read only): open
    ones and the five most recent finished ones the caller may read. 404
    for a property the caller may not see: a private one, or one outside
    their Asset Management scope rows (nexus_access_scopes, the same reach
    GET /property-assets/workspace applies)."""
    import property_links
    prop = db.get(models.PropertyAsset, property_id)
    if prop is None or not property_links.viewable(prop, user):
        raise HTTPException(404, "Property not found")
    allowed = auth.scoped_ids(user.get("email", ""), "property-asset", db)
    if allowed is not None and property_id not in allowed:
        raise HTTPException(404, "Property not found")
    ids = set(property_links.group_ids(db, prop, user) or [property_id])
    if allowed is not None:
        ids = {i for i in ids if i in allowed} | {property_id}
    P = models.ConstructionProject
    rows = [j for j in db.query(P).filter(P.property_id.in_(sorted(ids)), P.deleted_at == "").all()
            if _may_read(db, user, j)]
    from routers.construction import health_for
    open_ = [j for j in rows if (j.status or "active") in ("active", "on_hold") and not j.archived]
    done = sorted([j for j in rows if j not in open_], key=lambda j: j.modified_at or "", reverse=True)[:5]
    health = health_for(db, open_)
    return {"open": [project_to_dict(j, with_cost=False, db=db, health=health.get(j.id)) for j in open_],
            "recent": [project_to_dict(j, with_cost=False, db=db) for j in done]}


@router.get("/my-jobs")
def my_jobs(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The jobs the caller is on, those they are placed at today first (Fill
    a Form's job picker): [{id, name, onShiftToday}]."""
    me = _me(user)
    S = models.ScheduledShift
    today_keys = set()
    rows = [p for p in _visible_projects(db, user) if (p.status or "active") == "active" and not p.archived]
    for p in rows:
        d = _jobsite_today(db, p).isoformat()
        if db.query(S.id).filter(S.employee_email == me, S.work_date == d, S.jobsite == construction_labor.key_for(p.id),
                                 S.published == 1, S.pending_delete == 0).first():
            today_keys.add(p.id)
    mine = [p for p in rows if p.id in today_keys or me in (_emails(p.worker_emails) | _emails(p.manager_emails))]
    mine.sort(key=lambda p: (p.id not in today_keys, (p.name or "").lower()))
    return {"jobs": [{"id": p.id, "name": p.name, "onShiftToday": p.id in today_keys,
                      "jobType": construction_tasks.job_type_of(p)} for p in mine]}


@router.get("/search")
def search_jobs(q: str = "", limit: int = 6, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The Jobs group of the header search: jobs the caller may read
    (_visible_projects - the company wall and the job's own lists) whose
    name, code, address or phase holds the text. Prefix matches first."""
    term = (q or "").strip().lower()
    if len(term) < 2:
        return {"jobs": [], "total": 0}
    limit = max(1, min(int(limit or 6), 20))
    hits = []
    for p in _visible_projects(db, user):
        hay = " ".join([p.name or "", p.code or "", p.address or "", p.phase or ""]).lower()
        if term in hay:
            hits.append(((0 if (p.name or "").lower().startswith(term) else 1), (p.name or "").lower(), p))
    hits.sort(key=lambda h: (h[0], h[1]))
    return {"jobs": [{"id": p.id, "name": p.name, "code": p.code or "", "address": p.address or "",
                      "status": p.status or "active", "jobType": construction_tasks.job_type_of(p)}
                     for _, _, p in hits[:limit]],
            "total": len(hits)}
