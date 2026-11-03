"""Construction module - projects, daily logs, and jobsite media.

Backs the Construction screen (frontend/src/views/Operations.jsx), which until
now was hardcoded INIT_PROJECTS / INIT_LOGISTICS / INIT_EQUIPMENT arrays.

Patterns copied from routers/items.py, the reference implementation: server-side
notifications only, targeted at a specific recipient; permission checks resolve
the caller and never trust a body field; soft delete rather than DELETE.

THE PERMISSION SHAPE IS THE WHOLE POINT OF THIS MODULE, so it is stated once
here rather than re-derived per endpoint:

  Worker      files daily logs on projects they are assigned to, and uploads
              media to their own logs. Cannot see another worker's draft.
              Cannot approve anything. Cannot see cost data.
  Supervisor  everything a worker can, plus reads every log on their projects
              and can bounce one back with a question.
  Manager     reviews, edits and approves. The only role that can publish.
  Executive   reads published reports. No write path at all.
  Admin       everything, as everywhere else in Nexus.

A worker is the person this module exists to serve, and `is_manager()` is NOT
the check for "may file a log" - see _may_log below.

COMPANY WALLS (Neil, 11/03/2026): every project carries `company_id` and the
role-based reach (a manager by role reads and reviews every project) stops at
the caller's companies - auth.company_scope / company_ok, the one wall the
rest of Nexus uses. A project's own lists (crew, managers, executives) are an
explicit grant made by someone inside its company, so a listed person keeps
their reach. A project with no company ('') is visible only to callers the
walls do not confine. Out-of-company reads are a 404, never a 403.

The module has no Access Group gate of its own: Construction is a baseline
screen (Sidebar.jsx has no minRole on 'ops', so crews see it), and the reach
is per jobsite - nothing more to enforce here.
"""
import math
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import auth
import construction_company
import construction_notify
import construction_tasks
import construction_weather
import models
from auth import get_current_user
from database import get_db
from services import construction_storage as storage


# Small enough to keep here rather than import from routers/task_util. (Jobs
# may connect to Tasks fully since Neil's 11/03/2026 decision - this is just
# a uuid4 and an isoformat.)
def gen_id() -> str:
    return str(uuid.uuid4())


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


router = APIRouter(prefix="/construction", tags=["Construction"],
                   dependencies=[Depends(get_current_user)])


# ── Permissions ──────────────────────────────────────────────────────────────
def _level(user: dict) -> int:
    return int(user.get("level") or 0)


def _emails(value) -> set:
    return {(e or "").strip().lower() for e in (value or []) if (e or "").strip()}


def _me(user: dict) -> str:
    return (user.get("email") or "").strip().lower()


_SCOPE_KEY = "construction_company_scope"


def _scope(db: Session, user: dict):
    """auth.company_scope for this caller, read once per request (the session
    is per request; the scope costs a few queries)."""
    cache = db.info.setdefault(_SCOPE_KEY, {})
    key = (_me(user), int(user.get("level") or 0), user.get("acting_as") or "", user.get("real_email") or "")
    if key not in cache:
        cache[key] = auth.company_scope(user, db)
    return cache[key]


def _in_company(db: Session, user: dict, p: models.ConstructionProject) -> bool:
    """Does the caller's company wall admit this project? '' (no company) is
    admitted only to a caller the walls do not confine."""
    return auth.company_ok(getattr(p, "company_id", "") or "", _scope(db, user))


def _member(user: dict, p: models.ConstructionProject) -> bool:
    em = _me(user)
    return bool(em) and (em in _emails(p.worker_emails) or em in _emails(p.manager_emails)
                         or em in _emails(p.executive_emails))


def _project(db: Session, project_id: str, user: dict = None) -> models.ConstructionProject:
    """The live project, or 404. With `user`, also 404 when the project sits
    behind the caller's company wall and they are not on it - existence never
    leaks across the wall."""
    p = (db.query(models.ConstructionProject)
         .filter(models.ConstructionProject.id == project_id,
                 models.ConstructionProject.deleted_at == "").first())
    if not p:
        raise HTTPException(404, "Project not found")
    if user is not None and not _member(user, p) and not _in_company(db, user, p):
        raise HTTPException(404, "Project not found")
    return p


def _may_log(db: Session, user: dict, p: models.ConstructionProject) -> bool:
    """May this person file a daily log on this project?

    Deliberately NOT a level check. The whole module exists so the person
    holding the phone on the jobsite can file in two minutes, and that person is
    the lowest-privileged user in the system. Membership of the project's
    worker/manager list is the grant; level only ever adds - an administrator
    inside the project's company."""
    em = _me(user)
    return (em in _emails(p.worker_emails) or em in _emails(p.manager_emails)
            or (_level(user) >= 4 and _in_company(db, user, p)))


def _may_review(db: Session, user: dict, p: models.ConstructionProject) -> bool:
    """May this person approve?

    Level 3 is `manager` in auth.py's _LEVELS, and this bypass matches
    routers/task_util.py's require_project_role, which also opens at manager -
    inside the project's company (11/03/2026): a manager in one company never
    reviews or publishes another company's job.

    The membership term is what lets a project name its own approvers without
    promoting anyone. What neither term does is let the AUTHOR approve their own
    log - review_log refuses it outright (11/03/2026)."""
    return _me(user) in _emails(p.manager_emails) or (_level(user) >= 3 and _in_company(db, user, p))


def _may_read(db: Session, user: dict, p: models.ConstructionProject) -> bool:
    return _member(user, p) or (_level(user) >= 3 and _in_company(db, user, p))


def _may_see_cost(db: Session, user: dict, p: models.ConstructionProject) -> bool:
    """Contract value: managers by role inside the company, and the project's
    own managers. Never crews or executives-by-list."""
    return _me(user) in _emails(p.manager_emails) or (_level(user) >= 3 and _in_company(db, user, p))


def _visible_projects(db: Session, user: dict) -> list:
    rows = (db.query(models.ConstructionProject)
            .filter(models.ConstructionProject.deleted_at == "").all())
    return [p for p in rows if _may_read(db, user, p)]


def _draft_hidden(db: Session, user: dict, p, log) -> bool:
    """A draft is private to its author until submitted (and to reviewers)."""
    return (log.status == "draft" and (log.author_email or "").lower() != _me(user)
            and not _may_review(db, user, p))


# ── Serialization ────────────────────────────────────────────────────────────
def _nz(v):
    return v if v not in ("", None) else None


def project_to_dict(p: models.ConstructionProject, *, with_cost: bool, db: Session = None,
                    health: dict = None, names: dict = None, can_edit: bool = False) -> dict:
    d = {
        "id": p.id, "name": p.name, "code": _nz(p.code), "description": p.description or "",
        "propertyId": _nz(p.property_id),
        "address": p.address or "", "status": p.status or "active", "phase": p.phase or "",
        "percentComplete": p.percent_complete or 0.0,
        "generalContractor": p.general_contractor or "",
        "startOn": p.start_on or "", "targetFinishOn": p.target_finish_on or "",
        "managerEmails": p.manager_emails or [], "workerEmails": p.worker_emails or [],
        "executiveEmails": p.executive_emails or [],
        "weekStartsOn": p.week_starts_on, "reportDay": p.report_day,
        "latitude": p.latitude or 0.0, "longitude": p.longitude or 0.0,
        "geofenceRadiusM": p.geofence_radius_m or 0,
        "archived": bool(p.archived), "createdAt": p.created_at or "",
        "companyId": _nz(getattr(p, "company_id", "")),
        # The Job, connected (11/03/2026): its type (work_order | project -
        # size decides which sections the Job page shows) and its task project.
        "jobType": construction_tasks.job_type_of(p),
        "taskProjectId": _nz(getattr(p, "task_project_id", "")),
        # May the caller change this project (the Edit Job sheet)?
        "canEdit": bool(can_edit),
    }
    if db is not None:
        # The jobsite's own clock (construction_company): its zone, its today
        # (a new log's date) and the week the weekly report would cover now.
        d["timeZone"] = construction_company.zone_of(db, p)
        d["today"] = construction_company.local_today(db, p).isoformat()
        d["weekStart"] = construction_company.current_week_start(db, p).isoformat()
    if health is not None:
        d["health"] = health
    if names is not None:
        d["names"] = {e: names[e] for e in (_emails(p.manager_emails) | _emails(p.worker_emails)
                                            | _emails(p.executive_emails)) if e in names}
    # Contract value is withheld from workers and supervisors. A daily-log screen
    # has no reason to carry it, and "the numbers leaked through the field app"
    # is a phone call nobody wants.
    if with_cost:
        d["contractValue"] = p.contract_value or 0.0
        d["currency"] = p.currency or "USD"
    return d


LOG_TAGS = ("delay", "safety", "issue", "weather")


def _tags(value) -> list:
    """The crew's own tags, cleaned: known ones only, in a fixed order."""
    got = {(t or "").strip().lower() for t in (value or []) if isinstance(t, str)}
    return [t for t in LOG_TAGS if t in got]


def log_to_dict(l: models.ConstructionDailyLog, names: dict = None) -> dict:
    names = names or {}
    return {
        "id": l.id, "projectId": l.project_id, "logDate": l.log_date,
        "authorEmail": l.author_email, "status": l.status,
        "authorName": names.get((l.author_email or "").lower(), ""),
        "reviewedByName": names.get((l.reviewed_by or "").lower(), ""),
        "tags": _tags(getattr(l, "tags", None)),
        "notes": l.notes_raw or "",
        "weather": l.weather or "", "temperatureF": l.temperature_f or 0.0,
        "crewSize": l.crew_size or 0, "hoursWorked": l.hours_worked or 0.0,
        "geofenceOk": bool(l.geofence_ok),
        "aiSummary": l.ai_summary or "", "aiWorkCompleted": l.ai_work_completed or [],
        "aiCategories": l.ai_categories or [], "aiSafetyFlags": l.ai_safety_flags or [],
        "aiDelayFlags": l.ai_delay_flags or [], "aiActionItems": l.ai_action_items or [],
        "aiNextWork": l.ai_next_work or [], "aiConfidence": l.ai_confidence or 0.0,
        "aiProcessedAt": l.ai_processed_at or "",
        "reviewedBy": l.reviewed_by or "", "reviewNote": l.review_note or "",
        "submittedAt": l.submitted_at or "", "createdAt": l.created_at or "",
    }


def media_to_dict(m: models.ConstructionMedia) -> dict:
    return {
        "id": m.id, "projectId": m.project_id, "dailyLogId": _nz(m.daily_log_id),
        "kind": m.kind, "url": m.url or "", "thumbnailUrl": m.thumbnail_url or "",
        "mimeType": m.mime_type or "", "sizeBytes": m.size_bytes or 0,
        "takenAt": m.taken_at or "", "uploadedAt": m.uploaded_at or "",
        "uploadedBy": m.uploaded_by or "",
        "description": m.description or "", "caption": m.caption or "",
        "durationS": m.duration_s or 0.0, "transcript": m.transcript or "",
        "aiCaption": m.ai_caption or "", "aiTags": m.ai_tags or [],
        # The Egnyte deep link is surfaced to the UI on purpose: it is where
        # permissions, versions and sharing actually live (routers/egnyte.py).
        "egnyteWebUrl": m.egnyte_web_url or "", "egnyteStatus": m.egnyte_status or "",
        "featured": bool(m.featured),
    }


def _log_activity(db: Session, *, project_id: str, entity_kind: str, entity_id: str,
                  type: str, actor_email: str, detail: str = "") -> None:
    db.add(models.ConstructionActivity(
        id=gen_id(), project_id=project_id, entity_kind=entity_kind,
        entity_id=entity_id, type=type, actor_email=actor_email,
        at=now_iso(), detail=detail))


# ── Projects ─────────────────────────────────────────────────────────────────
@router.get("/projects")
def list_projects(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = sorted(_visible_projects(db, user), key=lambda p: (p.archived, p.name))
    return [project_to_dict(p, with_cost=_may_see_cost(db, user, p), db=db,
                            can_edit=_may_review(db, user, p)) for p in rows]


@router.get("/meta")
def module_meta(user: dict = Depends(get_current_user)):
    """What the screens need to know about the server: whether AI is on
    (ai_switch - Neil, Oct 29 2026: off unless Neil or Visesh turns it on).
    While it is off every AI chip, label, sort and helper is hidden."""
    import construction_ai
    return {"aiEnabled": construction_ai.configured(), "tags": list(LOG_TAGS)}


class ProjectBody(BaseModel):
    # Made on the phone when the client has one (the offline outbox resends
    # it): a create that already landed answers with the job it made.
    id: Optional[str] = None
    name: Optional[str] = None
    job_type: Optional[str] = None          # work_order | project (default project)
    task_template_id: Optional[str] = None  # a Tasks project template; '' = the job type's own
    code: Optional[str] = ""
    description: Optional[str] = ""
    property_id: Optional[str] = ""
    address: Optional[str] = ""
    status: Optional[str] = None
    phase: Optional[str] = ""
    percent_complete: Optional[float] = None
    contract_value: Optional[float] = None
    currency: Optional[str] = None
    general_contractor: Optional[str] = ""
    start_on: Optional[str] = ""
    target_finish_on: Optional[str] = ""
    manager_emails: Optional[list] = None
    worker_emails: Optional[list] = None
    executive_emails: Optional[list] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    geofence_radius_m: Optional[int] = None
    week_starts_on: Optional[int] = None
    report_day: Optional[int] = None
    archived: Optional[bool] = None


PROJECT_STATUSES = ("active", "on_hold", "complete", "archived")
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _clean_emails(value, field: str) -> list:
    if not isinstance(value, list):
        raise HTTPException(422, f"{field} must be a list of email addresses")
    out = []
    for e in value:
        em = (e or "").strip().lower() if isinstance(e, str) else ""
        if not _EMAIL.match(em):
            raise HTTPException(422, f"{e!r} is not an email address")
        if em not in out:
            out.append(em)
    return out


def _check_people(db: Session, user: dict, added: list) -> None:
    """Crew and managers come from the Nexus People list (the picker's
    /myhr/directory) and from inside the caller's companies - a walled
    manager cannot put another company's people on their job."""
    scope = _scope(db, user)
    for em in added:
        if not auth.person_in_scope(em, scope, db):
            raise HTTPException(422, f"{em} is not in your company's people.")


def _validate(db: Session, user: dict, p, data: dict) -> dict:
    """Clean a create / edit body. Raises 422 with a sentence."""
    out = dict(data)
    if "name" in out and out["name"] is not None:
        out["name"] = (out["name"] or "").strip()[:200]
        if not out["name"]:
            raise HTTPException(422, "Project name is required")
    out.pop("id", None)
    out.pop("task_template_id", None)
    if out.get("job_type") is not None and out["job_type"] not in construction_tasks.JOB_TYPES:
        raise HTTPException(422, "A job is a Work Order or a Project")
    if out.get("status") is not None:
        if out["status"] not in PROJECT_STATUSES:
            raise HTTPException(422, "Status must be Active, On Hold, Complete or Archived")
        out["archived"] = out["status"] == "archived"
    if out.get("percent_complete") is not None:
        pc = float(out["percent_complete"])
        if not (0 <= pc <= 100) or math.isnan(pc):
            raise HTTPException(422, "Percent complete must be between 0 and 100")
        out["percent_complete"] = round(pc, 1)
    for k in ("start_on", "target_finish_on"):
        if k in out and out[k] and not _DAY.match(str(out[k])):
            raise HTTPException(422, "Dates must be full dates")
    if out.get("start_on") and out.get("target_finish_on") and out["target_finish_on"] < out["start_on"]:
        raise HTTPException(422, "The target finish cannot be before the start")
    for k in ("manager_emails", "worker_emails", "executive_emails"):
        if out.get(k) is not None:
            out[k] = _clean_emails(out[k], k)
    had = set() if p is None else (_emails(p.manager_emails) | _emails(p.worker_emails))
    _check_people(db, user, [e for k in ("manager_emails", "worker_emails")
                             for e in (out.get(k) or []) if e not in had])
    # Executives: an outside address (an investor) is allowed - it only ever
    # gets the published report by email - but one that is a Nexus person
    # passes the same wall as the crew and the managers (review, 11/03/2026).
    had_exec = set() if p is None else _emails(p.executive_emails)
    new_exec = [e for e in (out.get("executive_emails") or []) if e not in had_exec]
    if new_exec:
        from sqlalchemy import func
        people = {(r[0] or "").lower() for r in db.query(models.NexusEmployee.work_email)
                  .filter(func.lower(models.NexusEmployee.work_email).in_(new_exec)).all()}
        _check_people(db, user, [e for e in new_exec if e in people])
    if out.get("property_id"):
        import property_links
        property_links.require_linkable(db, out["property_id"], user)
    if out.get("contract_value") is not None:
        cv = float(out["contract_value"])
        if cv < 0 or math.isnan(cv):
            raise HTTPException(422, "Contract value cannot be negative")
    for k in ("week_starts_on", "report_day"):
        if out.get(k) is not None and not (0 <= int(out[k]) <= 6):
            raise HTTPException(422, "Pick a day of the week")
    return out


@router.post("/projects", status_code=201)
def create_project(body: ProjectBody, user: dict = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    if _level(user) < 3:
        raise HTTPException(403, "Only a manager can create a construction project.")
    if not (body.name or "").strip():
        raise HTTPException(422, "Project name is required")
    cid = (body.id or "").strip()[:64]
    if cid:
        was = db.get(models.ConstructionProject, cid)
        if was is not None:
            if (was.created_by or "").lower() != _me(user) or was.deleted_at:
                raise HTTPException(409, "That job id is taken.")
            return project_to_dict(was, with_cost=True, db=db, can_edit=True)
    data = _validate(db, user, None, body.model_dump(exclude_unset=True))
    now = now_iso()
    p = models.ConstructionProject(
        id=cid or gen_id(), name=data["name"], code=body.code or "",
        job_type=data.get("job_type") or "project",
        description=body.description or "",
        property_id=body.property_id or "",
        address=body.address or "", status=data.get("status") or "active", phase=body.phase or "",
        percent_complete=data.get("percent_complete") or 0.0,
        contract_value=body.contract_value or 0.0, currency=body.currency or "USD",
        general_contractor=body.general_contractor or "",
        start_on=body.start_on or "", target_finish_on=body.target_finish_on or "",
        # The creator is a manager by default. Without this the person who just
        # made the project cannot review anything in it, which reads as a bug.
        manager_emails=data["manager_emails"] if data.get("manager_emails") is not None else [_me(user)],
        worker_emails=data.get("worker_emails") or [],
        executive_emails=data.get("executive_emails") or [],
        latitude=body.latitude or 0.0, longitude=body.longitude or 0.0,
        geofence_radius_m=body.geofence_radius_m if body.geofence_radius_m is not None else 500,
        week_starts_on=body.week_starts_on if body.week_starts_on is not None else 1,
        report_day=body.report_day if body.report_day is not None else 5,
        archived=bool(data.get("archived")),
        created_by=user["email"], created_at=now, modified_at=now,
        # The company wall (11/03/2026): the job lands on its creator's side.
        company_id=auth.company_of(user, db) or construction_company.company_from_property(db, body.property_id or ""),
    )
    # Project-based weather (Neil, 10/30/2026): the address is the jobsite's
    # weather point, found now so the first look at the project has a sky.
    if not construction_weather.has_point(p):
        construction_weather.geocode(p)
    db.add(p)
    _log_activity(db, project_id=p.id, entity_kind="project", entity_id=p.id,
                  type="created", actor_email=user["email"], detail="created this project")
    _emit(db, "job.created", p, user)
    db.commit()
    db.refresh(p)
    stamp_task_project(db, p, user, body.task_template_id or "")
    return project_to_dict(p, with_cost=True, db=db, can_edit=True)


def _emit(db: Session, key: str, subject, user: dict, changes: dict = None, extra: dict = None) -> None:
    """workflows.emit at the module's choke points (Neil, 11/03/2026 - the
    construction pack, workflows/packs/construction.py), inside the
    transaction. Never raises."""
    import workflows
    workflows.emit(db, key, subject=subject, actor=_me(user), changes=changes, extra=extra)


def stamp_task_project(db: Session, p, user: dict, template_id: str = "") -> None:
    """Give a job its task project (construction_tasks), committed on its
    own: a template that will not build never undoes the job itself - the
    Schedule tab offers it again."""
    try:
        if construction_tasks.ensure_task_project(db, p, user, template_id) is not None:
            db.commit()
            db.refresh(p)
    except Exception as e:   # noqa: BLE001 - the job stands; its schedule can be made later
        db.rollback()
        print(f"[construction] task project for {p.id}: {getattr(e, 'detail', e)}")


class MapLinkIn(BaseModel):
    link: str


@router.post("/resolve-link")
def resolve_project_link(body: MapLinkIn, user: dict = Depends(get_current_user)):
    """A jobsite placed from its Google Maps link (Pranshu, 11/02/2026), the
    same way as a work site: the exact point the weather is read at, and the
    address the link names. The work-site reader, behind New Project's gate."""
    if _level(user) < 3:
        raise HTTPException(403, "Only a manager can create a construction project.")
    from routers.hr import MapLinkIn as HrLink, resolve_work_site_link
    return resolve_work_site_link(HrLink(link=body.link), user)


@router.patch("/projects/{project_id}")
def update_project(project_id: str, body: ProjectBody,
                   user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The Edit Job sheet. Contract value is read and written only by the
    people allowed to see it (_may_see_cost) - for anyone else it is dropped
    from the change and left out of the answer."""
    p = _project(db, project_id, user)
    if not _may_review(db, user, p):
        raise HTTPException(403, "Only a project manager can change this project.")
    data = body.model_dump(exclude_unset=True)
    may_cost = _may_see_cost(db, user, p)
    if not may_cost:
        data.pop("contract_value", None)
        data.pop("currency", None)
    data = _validate(db, user, p, data)
    address_was = p.address or ""
    status_was, phase_was = p.status or "active", p.phase or ""
    for k, v in data.items():
        if v is not None:
            setattr(p, k, v)
    if (p.address or "") != address_was and "latitude" not in data and "longitude" not in data:
        p.latitude, p.longitude = 0.0, 0.0
        construction_weather.geocode(p)
    if "latitude" in data or "longitude" in data or (p.address or "") != address_was:
        p.time_zone = ""   # a new point: its forecast says its zone again
    p.modified_at = now_iso()
    _log_activity(db, project_id=p.id, entity_kind="project", entity_id=p.id,
                  type="edited", actor_email=user["email"],
                  detail=", ".join(sorted(data)) or "no fields")
    if (p.status or "active") != status_was:
        # The ticket sync (construction_ticket_sync) names who completed it.
        p._nx_actor = _me(user)
        _emit(db, "job.status_changed", p, user, changes={"status": (status_was, p.status)})
    if (p.phase or "") != phase_was:
        _emit(db, "job.phase_changed", p, user, changes={"phase": (phase_was, p.phase)})
    tp = construction_tasks.task_project(db, p)
    if tp is not None and ("manager_emails" in data or "worker_emails" in data):
        construction_tasks.sync_members(p, tp)
    db.commit()
    db.refresh(p)
    return project_to_dict(p, with_cost=may_cost, db=db, can_edit=True,
                           names=construction_company.people_names(
                               db, _emails(p.manager_emails) | _emails(p.worker_emails) | _emails(p.executive_emails)))

# ── Daily logs ───────────────────────────────────────────────────────────────
def _log_names(db: Session, logs) -> dict:
    return construction_company.people_names(
        db, {(l.author_email or "") for l in logs} | {(l.reviewed_by or "") for l in logs})


@router.get("/projects/{project_id}/logs")
def list_logs(project_id: str, date_from: str = "", date_to: str = "",
              user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    p = _project(db, project_id, user)
    if not _may_read(db, user, p):
        raise HTTPException(403, "You do not have access to this project.")
    q = (db.query(models.ConstructionDailyLog)
         .filter(models.ConstructionDailyLog.project_id == project_id,
                 models.ConstructionDailyLog.deleted_at == ""))
    if date_from:
        q = q.filter(models.ConstructionDailyLog.log_date >= date_from)
    if date_to:
        q = q.filter(models.ConstructionDailyLog.log_date <= date_to)
    # A draft is private to its author until submitted. A half-written log read
    # over somebody's shoulder is how workers learn to stop writing them.
    rows = [l for l in q.all() if not _draft_hidden(db, user, p, l)]
    names = _log_names(db, rows)
    return [log_to_dict(l, names) for l in sorted(rows, key=lambda l: (l.log_date, l.created_at),
                                                  reverse=True)]


class LogBody(BaseModel):
    log_date: Optional[str] = None
    notes_raw: Optional[str] = ""
    weather: Optional[str] = ""
    temperature_f: Optional[float] = None
    crew_size: Optional[int] = None
    hours_worked: Optional[float] = None
    gps_latitude: Optional[float] = None
    gps_longitude: Optional[float] = None
    gps_accuracy_m: Optional[float] = None
    tags: Optional[list] = None


@router.post("/projects/{project_id}/logs", status_code=201)
def create_log(project_id: str, body: LogBody, user: dict = Depends(get_current_user),
               db: Session = Depends(get_db)):
    """Opens a draft. Called the moment the worker taps Start Daily Log, before
    any media exists, so photos have somewhere to attach as they upload rather
    than being held on the phone until a final Submit.

    `log_date` is the JOBSITE's date (construction_company.local_today) when
    the phone does not send one - a log filed at 6 PM on a Pacific site never
    lands on tomorrow because the server runs on UTC."""
    p = _project(db, project_id, user)
    if not _may_log(db, user, p):
        raise HTTPException(403, "You are not assigned to this project.")
    log_date = (body.log_date or "").strip() or construction_company.local_today(db, p).isoformat()
    if not _DAY.match(log_date):
        raise HTTPException(422, "log_date must be a full date (YYYY-MM-DD, jobsite-local)")
    now = now_iso()
    # One draft per person per day. Tapping Start twice - which happens when the
    # app is backgrounded on site - must resume, not fork the day into two logs
    # that each hold half the photos.
    existing = (db.query(models.ConstructionDailyLog)
                .filter(models.ConstructionDailyLog.project_id == project_id,
                        models.ConstructionDailyLog.log_date == log_date,
                        models.ConstructionDailyLog.author_email == user["email"],
                        models.ConstructionDailyLog.status == "draft",
                        models.ConstructionDailyLog.deleted_at == "").first())
    if existing:
        if body.gps_latitude and body.gps_longitude:
            _set_gps(p, existing, body.gps_latitude, body.gps_longitude, body.gps_accuracy_m)
            db.commit()
            db.refresh(existing)
        return log_to_dict(existing)
    l = models.ConstructionDailyLog(
        id=gen_id(), project_id=project_id, log_date=log_date,
        author_email=user["email"], status="draft",
        notes_raw=body.notes_raw or "", weather=body.weather or "",
        temperature_f=body.temperature_f or 0.0,
        crew_size=body.crew_size or 0, hours_worked=body.hours_worked or 0.0,
        gps_latitude=body.gps_latitude or 0.0, gps_longitude=body.gps_longitude or 0.0,
        gps_accuracy_m=body.gps_accuracy_m or 0.0,
        geofence_ok=_within_geofence(p, body.gps_latitude, body.gps_longitude),
        tags=_tags(body.tags),
        created_at=now, modified_at=now,
    )
    db.add(l)
    db.commit()
    db.refresh(l)
    return log_to_dict(l)


def _within_geofence(p: models.ConstructionProject, lat, lon) -> bool:
    """Advisory only - the result is recorded, never enforced.

    Jobsite coverage is bad and phone GPS drifts tens of meters indoors or beside
    steel. Rejecting an out-of-fence log would mean the day's update is simply
    never filed, which is strictly worse than an unverified one. The manager sees
    the flag and decides."""
    if not p.geofence_radius_m or not p.latitude or not p.longitude or not lat or not lon:
        return True
    # Equirectangular approximation: at jobsite scale (hundreds of meters) the
    # error against haversine is centimeters, and this avoids the trig.
    dy = (lat - p.latitude) * 111_320
    dx = (lon - p.longitude) * 111_320 * max(0.01, abs(math.cos(math.radians(p.latitude))))
    return (dx * dx + dy * dy) ** 0.5 <= p.geofence_radius_m


def _set_gps(p, l, lat, lon, accuracy=None) -> None:
    """Record where the phone was and work out the (advisory) geofence check -
    whenever GPS arrives, on create AND on every later save (11/03/2026)."""
    l.gps_latitude, l.gps_longitude = float(lat or 0.0), float(lon or 0.0)
    if accuracy is not None:
        l.gps_accuracy_m = float(accuracy or 0.0)
    l.geofence_ok = _within_geofence(p, l.gps_latitude, l.gps_longitude)


@router.patch("/logs/{log_id}")
def update_log(log_id: str, body: LogBody, user: dict = Depends(get_current_user),
               db: Session = Depends(get_db)):
    l = _get_log(db, log_id)
    p = _project(db, l.project_id, user)
    em = _me(user)
    if (l.author_email or "").lower() != em and not _may_review(db, user, p):
        raise HTTPException(403, "You can only edit your own daily log.")
    if l.status not in ("draft", "needs_info"):
        raise HTTPException(409, "This log has been submitted and can no longer be edited.")
    data = body.model_dump(exclude_unset=True)
    gps = {k: data.pop(k) for k in ("gps_latitude", "gps_longitude", "gps_accuracy_m") if k in data}
    if "tags" in data:
        data["tags"] = _tags(data["tags"])
    if "log_date" in data and data["log_date"] is not None and not _DAY.match(str(data["log_date"])):
        raise HTTPException(422, "log_date must be a full date (YYYY-MM-DD, jobsite-local)")
    for k, v in data.items():
        if v is not None:
            setattr(l, k, v)
    if gps.get("gps_latitude") and gps.get("gps_longitude"):
        _set_gps(p, l, gps["gps_latitude"], gps["gps_longitude"], gps.get("gps_accuracy_m"))
    l.modified_at = now_iso()
    db.commit()
    db.refresh(l)
    return log_to_dict(l)


def _get_log(db: Session, log_id: str, lock: bool = False) -> models.ConstructionDailyLog:
    """The live log, or 404. `lock` takes its row lock (Postgres FOR UPDATE)
    for the state changes - submit, review, reopen, removing a photo - so two
    people acting at once queue instead of both passing the state check."""
    q = (db.query(models.ConstructionDailyLog)
         .filter(models.ConstructionDailyLog.id == log_id,
                 models.ConstructionDailyLog.deleted_at == ""))
    l = (q.with_for_update() if lock else q).first()
    if not l:
        raise HTTPException(404, "Daily log not found")
    return l


def _claim(db: Session, l, allowed: tuple, **values) -> None:
    """Move a log on only if it is still in one of `allowed` states - one
    conditional UPDATE whose row count says whether this request won. A
    second manager deciding the same log a moment later gets a 409, never a
    second decision (review, 11/03/2026). `l` is re-read afterwards."""
    n = (db.query(models.ConstructionDailyLog)
         .filter(models.ConstructionDailyLog.id == l.id,
                 models.ConstructionDailyLog.status.in_(allowed),
                 models.ConstructionDailyLog.deleted_at == "")
         .update(values, synchronize_session=False))
    if n != 1:
        db.rollback()
        raise HTTPException(409, "This log changed while you were looking at it - reload it and try again.")
    db.refresh(l)


@router.post("/logs/{log_id}/submit")
def submit_log(log_id: str, user: dict = Depends(get_current_user),
               db: Session = Depends(get_db)):
    """The worker's last action. Returns immediately.

    With AI on, the expensive part - captioning, summarization - is queued as
    ConstructionAIJob rows and runs after this responds. With AI off (the
    default, ai_switch) nothing is queued: a submitted log IS ready for review
    the moment it lands (11/03/2026), never stuck "processing". The Egnyte
    record copy and thumbnails were queued at upload and do not wait on this."""
    import construction_ai
    l = _get_log(db, log_id, lock=True)
    p = _project(db, l.project_id, user)
    em = _me(user)
    if (l.author_email or "").lower() != em and not (_level(user) >= 4 and _in_company(db, user, p)):
        raise HTTPException(403, "You can only submit your own daily log.")
    if l.status not in ("draft", "needs_info"):
        raise HTTPException(409, f"This log is already {l.status}.")

    media = (db.query(models.ConstructionMedia)
             .filter(models.ConstructionMedia.daily_log_id == log_id,
                     models.ConstructionMedia.deleted_at == "").all())
    if not media and not (l.notes_raw or "").strip():
        raise HTTPException(422, "Add at least one photo, video, voice note or written note.")

    now = now_iso()
    _claim(db, l, ("draft", "needs_info"), status="submitted", submitted_at=now, modified_at=now)

    # Captions are an INPUT to the log summary, so the summary waits on them:
    # priority orders the queue and depends_on is the hard gate.
    #
    # PHOTOS ONLY, and nothing is queued for audio. Both of those are corrections
    # to what this used to do, and both were silent failures rather than errors:
    #
    #   - Captioning a video sent the .mp4 URL as a vision image block, which the
    #     API rejects. The job burned all four attempts and died. Frames would
    #     have to be extracted first, and there is no ffmpeg here.
    #   - Audio and video queued `media_transcribe`, which nothing drains (see
    #     ConstructionAIJob.kind). Because the summary listed those job ids in
    #     depends_on, its dependency check never cleared - so ANY log carrying a
    #     voice note or a clip was blocked forever and never summarized at all.
    #
    # A video or voice note still reaches the manager: it is filed to Egnyte, it
    # shows in the log, and the worker's own note and photo captions still drive
    # the summary. It just contributes nothing the model can read.
    jobs = []
    if construction_ai.configured():
        for m in media:
            if m.kind == "photo" and not (m.ai_caption or "").strip():
                jobs.append(_queue(db, p.id, "media_caption", m.id, priority=20))
        _queue(db, p.id, "log_summarize", l.id, priority=50, depends_on=jobs)
        queued = len(jobs) + 1
    else:
        queued = 0

    _log_activity(db, project_id=p.id, entity_kind="log", entity_id=l.id,
                  type="submitted", actor_email=user["email"],
                  detail=f"{len(media)} attachment(s)")
    # Bells go in the same transaction as the status change: a log that says
    # "submitted" while nobody was told is the state this workflow cannot have.
    construction_notify.log_submitted(db, p, l)
    _emit(db, "daily_log.submitted", l, user)
    db.commit()
    db.refresh(l)
    return {**log_to_dict(l), "queuedJobs": queued}


def _queue(db: Session, project_id: str, kind: str, subject_id: str, *,
           priority: int = 100, depends_on: list = None) -> str:
    job = models.ConstructionAIJob(
        id=gen_id(), project_id=project_id, kind=kind, subject_id=subject_id,
        status="queued", priority=priority, depends_on=depends_on or [],
        queued_at=now_iso())
    db.add(job)
    db.flush()   # sessions are autoflush=False; the id must be visible to callers
    return job.id


REVIEWABLE = ("submitted", "processed", "needs_info")


@router.post("/logs/{log_id}/review")
def review_log(log_id: str, body: dict, user: dict = Depends(get_current_user),
               db: Session = Depends(get_db)):
    """Manager approves a log or bounces it back. A worker can never reach here -
    publishing is a manager act, which is the entire point of the workflow.

    The log's state decides (11/03/2026): only a submitted (or sent back)
    log is reviewed - never a draft, never an approved one (that takes an
    explicit Reopen, with a reason), and never by its own author."""
    l = _get_log(db, log_id, lock=True)
    p = _project(db, l.project_id, user)
    if not _may_review(db, user, p):
        raise HTTPException(403, "Only a project manager can review daily logs.")
    if (l.author_email or "").lower() == _me(user):
        raise HTTPException(403, "You cannot review your own daily log - another manager has to.")
    decision = (body or {}).get("decision")
    if decision not in ("approve", "needs_info"):
        raise HTTPException(422, "decision must be 'approve' or 'needs_info'")
    if l.status == "approved":
        raise HTTPException(409, "This log is already approved. Reopen it first to change the decision.")
    if l.status not in REVIEWABLE:
        raise HTTPException(409, "This log has not been submitted yet.")
    if decision == "needs_info" and not ((body or {}).get("note") or "").strip():
        raise HTTPException(422, "Say what the crew should add before sending the log back.")
    at = now_iso()
    was_status = l.status
    _claim(db, l, REVIEWABLE, status="approved" if decision == "approve" else "needs_info",
           reviewed_by=user["email"], reviewed_at=at, modified_at=at,
           review_note=((body or {}).get("note") or "")[:2000])
    _log_activity(db, project_id=p.id, entity_kind="log", entity_id=l.id,
                  type=decision, actor_email=user["email"], detail=l.review_note)
    # The sent-back case is the whole reason this exists: review_note is a
    # question for the person on site, and it used to be written to the row and
    # shown to nobody.
    construction_notify.log_reviewed(db, p, l)
    _emit(db, "daily_log.reviewed", l, user, changes={"status": (was_status, l.status)},
          extra={"decision": decision, "note": l.review_note or ""})
    db.commit()
    db.refresh(l)
    return log_to_dict(l)


@router.post("/logs/{log_id}/reopen")
def reopen_log(log_id: str, body: dict, user: dict = Depends(get_current_user),
               db: Session = Depends(get_db)):
    """The one way back from Approved (11/03/2026): a project reviewer, with a
    reason, on the record (the activity log and the author's bell). The log
    goes back into review; a published report keeps what it printed."""
    l = _get_log(db, log_id, lock=True)
    p = _project(db, l.project_id, user)
    if not _may_review(db, user, p):
        raise HTTPException(403, "Only a project manager can reopen a daily log.")
    reason = ((body or {}).get("reason") or "").strip()[:500]
    if not reason:
        raise HTTPException(422, "Say why the log is being reopened.")
    if l.status != "approved":
        raise HTTPException(409, "Only an approved log can be reopened.")
    _claim(db, l, ("approved",), status="submitted", modified_at=now_iso())
    _log_activity(db, project_id=p.id, entity_kind="log", entity_id=l.id,
                  type="reopened", actor_email=user["email"], detail=reason)
    construction_notify.log_reopened(db, p, l, user["email"], reason)
    db.commit()
    db.refresh(l)
    return log_to_dict(l)


# ── Media ────────────────────────────────────────────────────────────────────
class MediaBody(BaseModel):
    kind: str
    storage_path: Optional[str] = ""
    url: Optional[str] = ""
    thumbnail_url: Optional[str] = ""
    mime_type: Optional[str] = ""
    size_bytes: Optional[int] = 0
    taken_at: Optional[str] = ""
    description: Optional[str] = ""
    original_name: Optional[str] = ""
    duration_s: Optional[float] = None
    gps_latitude: Optional[float] = None
    gps_longitude: Optional[float] = None


@router.post("/logs/{log_id}/media", status_code=201)
def register_media(log_id: str, body: MediaBody, user: dict = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """Records a file the client already uploaded to Supabase.

    Bytes go browser -> Supabase directly, never through this API: routing a
    100 MB clip through the request would hold it in a gunicorn worker's memory
    for the length of a jobsite LTE upload. This endpoint records where it
    landed and queues the Egnyte record copy.

    The links are checked (11/03/2026, storage.check_media): the file must be
    in the construction-media bucket under this job's own folder, because the
    server later fetches it into Egnyte and into the PDF executives receive."""
    l = _get_log(db, log_id)
    p = _project(db, l.project_id, user)
    em = _me(user)
    if (l.author_email or "").lower() != em and not _may_review(db, user, p):
        raise HTTPException(403, "You can only attach media to your own daily log.")
    if l.status not in ("draft", "needs_info"):
        raise HTTPException(409, "This log has been submitted; media can no longer be added.")

    err = storage.validate(body.kind, body.size_bytes or 0, body.mime_type or "")
    if err:
        raise HTTPException(413 if "limit is" in err else 422, err)
    bad = storage.check_media(url=body.url or "", storage_path=body.storage_path or "",
                              thumbnail_url=body.thumbnail_url or "", project_id=p.id)
    if bad:
        raise HTTPException(422, bad)

    now = now_iso()
    mid = gen_id()
    # An inline (data:) row has no Supabase object, so it gets no storage_path -
    # synthesizing one would describe an object that does not exist and send the
    # rebuild sweep looking for it.
    inline = storage.is_inline(body.url or "")
    m = models.ConstructionMedia(
        id=mid, project_id=p.id, daily_log_id=l.id, kind=body.kind,
        storage_path="" if inline else (storage.object_path(body.url or "") or body.storage_path or ""),
        url=body.url or "", thumbnail_url=body.thumbnail_url or "",
        mime_type=body.mime_type or "", size_bytes=body.size_bytes or 0,
        taken_at=body.taken_at or "", uploaded_at=now, uploaded_by=user["email"],
        description=(body.description or "")[:500],
        duration_s=body.duration_s or 0.0,
        gps_latitude=body.gps_latitude or 0.0, gps_longitude=body.gps_longitude or 0.0,
        # 'pending' even when Egnyte is unconfigured: the sweep files it once
        # EGNYTE_DOMAIN/EGNYTE_TOKEN exist. Failing the worker's upload for an
        # operator problem would lose the day's update.
        # 'skipped' for an inline row - there is no object to file, and leaving
        # it 'pending' would show a record copy as perpetually owed.
        egnyte_status="skipped" if inline else "pending",
    )
    db.add(m)
    # Neither job has anything to do with an inline row: no bytes to fetch into
    # Egnyte, and the image is already the size it was sent at.
    if not inline:
        _queue(db, p.id, "egnyte_sync", mid, priority=30)
        # Queued at upload rather than at submit: the grid shows a draft's photos
        # while the worker is still adding to it, so the thumbnail is wanted
        # before Submit is ever pressed. Skipped for kinds with no still frame.
        if storage.can_thumbnail(body.kind, body.mime_type or ""):
            _queue(db, p.id, "derive_rendition", mid, priority=25)
    db.commit()
    db.refresh(m)
    return media_to_dict(m)


@router.get("/logs/{log_id}/media")
def list_media(log_id: str, user: dict = Depends(get_current_user),
               db: Session = Depends(get_db)):
    l = _get_log(db, log_id)
    p = _project(db, l.project_id, user)
    if not _may_read(db, user, p):
        raise HTTPException(403, "You do not have access to this project.")
    # The same privacy as list_logs (11/03/2026): someone else's draft is not
    # there to read, photos included.
    if _draft_hidden(db, user, p, l):
        raise HTTPException(404, "Daily log not found")
    rows = (db.query(models.ConstructionMedia)
            .filter(models.ConstructionMedia.daily_log_id == log_id,
                    models.ConstructionMedia.deleted_at == "",
                    models.ConstructionMedia.duplicate_of == "").all())
    return [media_to_dict(m) for m in sorted(rows, key=lambda m: (m.sort_order, m.uploaded_at))]


def _in_published_report(db: Session, m) -> bool:
    reports = (db.query(models.ConstructionWeeklyReport.media_ids)
               .filter(models.ConstructionWeeklyReport.project_id == m.project_id,
                       models.ConstructionWeeklyReport.status.in_(("published", "superseded")),
                       models.ConstructionWeeklyReport.deleted_at == "").all())
    return any(m.id in (r.media_ids or []) for r in reports)


@router.delete("/media/{media_id}", status_code=204)
def delete_media(media_id: str, reason: str = "", user: dict = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    """Soft delete, and only while the log is still being written (11/03/2026).

    A photo is evidence: once its log is submitted, approved or printed in a
    published report it stays - nobody removes it, a manager included. Its
    uploader may take it out only while the log is a draft that was NEVER
    submitted; once a log has been in front of a reviewer (sent back, or
    approved and reopened and sent back) only a manager may, with a reason on
    the record (review, 11/03/2026). Nothing is ever hard-deleted, and the
    Egnyte record copy is NOT removed - that file is the project's record and
    lives under Egnyte's own retention. The log's row is locked meanwhile, so
    a Submit at the same moment cannot slip past the state check."""
    m = (db.query(models.ConstructionMedia)
         .filter(models.ConstructionMedia.id == media_id,
                 models.ConstructionMedia.deleted_at == "").first())
    if not m:
        raise HTTPException(404, "Media not found")
    p = _project(db, m.project_id, user)
    log = _get_log(db, m.daily_log_id, lock=True) if m.daily_log_id else None
    if log is None or log.status not in ("draft", "needs_info") or _in_published_report(db, m):
        raise HTTPException(409, "This file is part of a submitted daily log and is kept as evidence.")
    mine = (m.uploaded_by or "").lower() == _me(user)
    never_submitted = log.status == "draft" and not (log.submitted_at or "")
    if not (mine and never_submitted):
        if not _may_review(db, user, p):
            raise HTTPException(403, "This file was already in front of a reviewer - a manager has to remove it."
                                if mine else "You can only remove media you uploaded.")
        if not (reason or "").strip():
            raise HTTPException(422, "Say why this file is being removed.")
    n = (db.query(models.ConstructionMedia)
         .filter(models.ConstructionMedia.id == m.id, models.ConstructionMedia.deleted_at == "")
         .update({"deleted_at": now_iso()}, synchronize_session=False))
    if n != 1:
        db.rollback()
        raise HTTPException(404, "Media not found")
    _log_activity(db, project_id=p.id, entity_kind="media", entity_id=m.id,
                  type="deleted", actor_email=user["email"],
                  detail=(reason or "").strip()[:500] or "removed by the uploader")
    db.commit()


# ── Manager review ───────────────────────────────────────────────────────────
@router.get("/review-queue")
def review_queue(project_id: str = "", user: dict = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    """Every log awaiting a decision, across all projects this manager reviews
    (`project_id` narrows it to one jobsite - Site Activity's picker).

    One request rather than the client fanning out per project: a manager with
    twelve jobsites would otherwise make twelve calls to render one list, and the
    ordering below has to be computed across all of them anyway.

    Ordered by what needs a human first, not by date:
      with AI on    1. logs the AI was unsure about (low confidence)
                    2. logs carrying a safety flag (the AI's or the crew's tag)
      with AI off   1. logs the crew tagged Safety, then any other tag
      then oldest first. Never the caller's own log - it is not theirs to
    review."""
    import construction_ai
    ai_on = construction_ai.configured()
    projects = [p for p in _visible_projects(db, user) if _may_review(db, user, p)]
    if project_id:
        projects = [p for p in projects if p.id == project_id]
    if not projects:
        return []
    by_id = {p.id: p for p in projects}
    me = _me(user)
    rows = [l for l in (db.query(models.ConstructionDailyLog)
                        .filter(models.ConstructionDailyLog.project_id.in_(list(by_id)),
                                models.ConstructionDailyLog.status.in_(("submitted", "processed")),
                                models.ConstructionDailyLog.deleted_at == "").all())
            if (l.author_email or "").lower() != me]

    def rank(l):
        tags = _tags(getattr(l, "tags", None))
        if ai_on:
            # Unprocessed logs sort as unknown-confidence rather than 0.0, or every
            # log still queued for AI would jump the queue ahead of real findings.
            conf = l.ai_confidence if l.ai_processed_at else 0.5
            return (0 if conf < 0.5 else 1,
                    0 if ((l.ai_safety_flags or []) or "safety" in tags) else 1,
                    l.log_date, l.created_at or "")
        return (0 if "safety" in tags else 1 if tags else 2, l.log_date, l.created_at or "")

    names = _log_names(db, rows)
    counts = {}
    if rows:
        from sqlalchemy import func
        counts = dict(db.query(models.ConstructionMedia.daily_log_id, func.count(models.ConstructionMedia.id))
                      .filter(models.ConstructionMedia.daily_log_id.in_([l.id for l in rows]),
                              models.ConstructionMedia.deleted_at == "")
                      .group_by(models.ConstructionMedia.daily_log_id).all())
    out = []
    for l in sorted(rows, key=rank):
        d = log_to_dict(l, names)
        d["projectName"] = by_id[l.project_id].name
        d["mediaCount"] = int(counts.get(l.id, 0))
        d["awaitingAi"] = ai_on and not l.ai_processed_at
        out.append(d)
    return out

# ── Milestones, RFIs, submittals ─────────────────────────────────────────────
# The three registers the weekly report prints but nothing could populate until
# now: generate() already resolves milestone_ids / rfi_ids / submittal_ids, and
# construction_pdf renders them, so every one of those sections came out empty.
#
# All three are manager-write, project-read. A worker files what they saw on
# site; an RFI's ball-in-court and a milestone slipping are contractual events,
# and letting the field edit them is how a delay claim loses its paperwork.

def milestone_to_dict(m: models.ConstructionMilestone) -> dict:
    return {
        "id": m.id, "projectId": m.project_id, "name": m.name,
        "description": m.description or "",
        "targetDate": m.target_date or "", "actualDate": m.actual_date or "",
        "status": m.status or "upcoming", "critical": bool(m.critical),
        # Surfaced so the UI can show "AI thinks this is done - confirm?" without
        # ever having moved the milestone itself.
        "aiDetectedAt": m.ai_detected_at or "", "aiEvidence": m.ai_evidence or [],
        "confirmedBy": m.confirmed_by or "", "createdAt": m.created_at or "",
    }


def rfi_to_dict(r: models.ConstructionRfi) -> dict:
    return {
        "id": r.id, "projectId": r.project_id, "number": r.number or "",
        "subject": r.subject or "", "question": r.question or "",
        "answer": r.answer or "", "status": r.status or "open",
        "ballInCourt": r.ball_in_court or "", "submittedBy": r.submitted_by or "",
        "submittedOn": r.submitted_on or "", "dueOn": r.due_on or "",
        "answeredOn": r.answered_on or "",
        "costImpact": r.cost_impact or 0.0,
        "scheduleImpactDays": r.schedule_impact_days or 0,
        "responderEmail": _nz(getattr(r, "responder_email", "")),
        "createdAt": r.created_at or "",
    }


def submittal_to_dict(s: models.ConstructionSubmittal) -> dict:
    return {
        "id": s.id, "projectId": s.project_id, "number": s.number or "",
        "title": s.title or "", "specSection": s.spec_section or "",
        "status": s.status or "pending", "revision": s.revision or 0,
        "submittedBy": s.submitted_by or "", "submittedOn": s.submitted_on or "",
        "dueOn": s.due_on or "", "returnedOn": s.returned_on or "",
        "documentUrls": s.document_urls or [], "createdAt": s.created_at or "",
        "approverEmail": _nz(getattr(s, "approver_email", "")),
    }


_REGISTERS = {
    "milestones":  (models.ConstructionMilestone,  milestone_to_dict,  "milestone"),
    "rfis":        (models.ConstructionRfi,        rfi_to_dict,        "rfi"),
    "submittals":  (models.ConstructionSubmittal,  submittal_to_dict,  "submittal"),
}

# Only these columns may be written from a request body. An allow-list rather
# than model_dump(): the three registers share one set of endpoints, and without
# it a client could set `ai_detected_at` or `confirmed_by` on a milestone and
# forge the AI's suggestion or a manager's sign-off.
_REGISTER_FIELDS = {
    "milestones": {"name", "description", "target_date", "actual_date", "status", "critical"},
    "rfis": {"number", "subject", "question", "answer", "status", "ball_in_court",
             "submitted_by", "submitted_on", "due_on", "answered_on",
             "cost_impact", "schedule_impact_days", "responder_email"},
    "submittals": {"number", "title", "spec_section", "status", "revision",
                   "submitted_by", "submitted_on", "due_on", "returned_on",
                   "document_urls", "approver_email"},
}


_REGISTER_STATUSES = {
    "milestones": ("upcoming", "at_risk", "hit", "missed"),
    "rfis": ("open", "answered", "closed", "void"),
    "submittals": ("pending", "submitted", "approved", "approved_as_noted", "revise_resubmit", "rejected"),
}
_REGISTER_DATES = {"target_date", "actual_date", "submitted_on", "due_on", "answered_on", "returned_on"}


# The submittal decisions a reviewer makes (the submittal.decided event).
SUBMITTAL_DECISIONS = ("approved", "approved_as_noted", "revise_resubmit", "rejected")
# What the named responder / approver may write on their own row.
RESPONDER_FIELDS = {"answer", "answered_on", "status"}
APPROVER_FIELDS = {"status", "returned_on"}


def _register_events(db: Session, kind: str, row, user: dict, p, *, created: bool, before: dict) -> None:
    """The RFI / submittal events and the one bell to the person who owes the
    answer or the decision (Neil, 11/03/2026). `before` = the row's
    status / named person before this write ({} on create)."""
    if kind == "rfis":
        if created:
            _emit(db, "rfi.opened", row, user)
        elif (row.status or "") == "answered" and before.get("status") != "answered":
            _emit(db, "rfi.answered", row, user, changes={"status": (before.get("status") or "", "answered")})
        who = (getattr(row, "responder_email", "") or "").lower()
        if who and who != _me(user) and (created or who != before.get("person")) and (row.status or "open") == "open":
            construction_notify.bell(
                db, kind="rfi_assigned", recipient=who, ref_id=row.id, family=("rfi_assigned",),
                title=f"RFI to Answer - {p.name}",
                body=f"{row.number + ' ' if row.number else ''}{row.subject or 'An RFI'}"
                     + (f" - due {construction_notify._us(row.due_on)}" if row.due_on else ""),
                requested_by=_me(user), label="Open RFIs", sub=f"project:{p.id}:rfis", company=p.company_id or "")
    elif kind == "submittals":
        if (row.status or "") in SUBMITTAL_DECISIONS and before.get("status") != row.status:
            _emit(db, "submittal.decided", row, user, changes={"status": (before.get("status") or "", row.status)})
        who = (getattr(row, "approver_email", "") or "").lower()
        if who and who != _me(user) and (created or who != before.get("person")) and (row.status or "") in ("pending", "submitted"):
            construction_notify.bell(
                db, kind="submittal_assigned", recipient=who, ref_id=row.id, family=("submittal_assigned",),
                title=f"Submittal to Decide - {p.name}",
                body=f"{row.number + ' ' if row.number else ''}{row.title or 'A submittal'}"
                     + (f" - due {construction_notify._us(row.due_on)}" if row.due_on else ""),
                requested_by=_me(user), label="Open Submittals", sub=f"project:{p.id}:rfis", company=p.company_id or "")


def _register_person(db: Session, user: dict, data: dict) -> None:
    """The responder / approver is a Nexus person inside the caller's companies."""
    for k in ("responder_email", "approver_email"):
        if data.get(k):
            em = str(data[k]).strip().lower()
            if not _EMAIL.match(em):
                raise HTTPException(422, f"{data[k]!r} is not an email address")
            _check_people(db, user, [em])
            data[k] = em


def _register_data(kind: str, body: dict, p) -> dict:
    """The allow-listed fields of a register body, checked: known statuses,
    full dates, and document links that are files in this job's own storage
    (11/03/2026 - the same rule as a daily log's photos)."""
    data = {k: v for k, v in (body or {}).items()
            if k in _REGISTER_FIELDS[kind] and v is not None}
    if "status" in data and data["status"] not in _REGISTER_STATUSES[kind]:
        raise HTTPException(422, "Pick a status from the list")
    for k in _REGISTER_DATES & set(data):
        if data[k] and not _DAY.match(str(data[k])):
            raise HTTPException(422, "Dates must be full dates")
    if "document_urls" in data:
        bad = storage.check_document_urls(data["document_urls"], p.id)
        if bad:
            raise HTTPException(422, bad)
    return data


def _register(kind: str):
    if kind not in _REGISTERS:
        raise HTTPException(404, "Unknown register")
    return _REGISTERS[kind]


@router.get("/projects/{project_id}/register/{kind}")
def list_register(project_id: str, kind: str, user: dict = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    model, to_dict, _ = _register(kind)
    p = _project(db, project_id, user)
    if not _may_read(db, user, p):
        raise HTTPException(403, "You do not have access to this project.")
    rows = (db.query(model)
            .filter(model.project_id == project_id, model.deleted_at == "").all())
    # Milestones read as a schedule, so they sort by date. The other two are
    # registers people cite by number, and a register that reorders itself when
    # a due date is edited is one nobody can read down.
    key = ((lambda r: (r.target_date or "9999", r.name or ""))
           if kind == "milestones" else
           (lambda r: (r.created_at or "", r.number or "")))
    return [to_dict(r) for r in sorted(rows, key=key)]


@router.post("/projects/{project_id}/register/{kind}", status_code=201)
def create_register(project_id: str, kind: str, body: dict,
                    user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    model, to_dict, entity = _register(kind)
    p = _project(db, project_id, user)
    if not _may_review(db, user, p):
        raise HTTPException(403, f"Only a project manager can add {kind}.")
    data = _register_data(kind, body, p)
    _register_person(db, user, data)
    if kind == "milestones" and not (data.get("name") or "").strip():
        raise HTTPException(422, "Milestone name is required")
    now = now_iso()
    # An id made on the phone (offline outbox): a resend answers with the row.
    rid = str((body or {}).get("id") or "").strip()[:64]
    if rid:
        was = db.query(model).filter(model.id == rid).first()
        if was is not None:
            if was.project_id != p.id:
                raise HTTPException(409, "That id is taken.")
            return to_dict(was)
    row = model(id=rid or gen_id(), project_id=p.id, created_at=now, modified_at=now, **data)
    db.add(row)
    _log_activity(db, project_id=p.id, entity_kind=entity, entity_id=row.id,
                  type="created", actor_email=user["email"],
                  detail=data.get("name") or data.get("subject") or data.get("title") or "")
    _register_events(db, kind, row, user, p, created=True, before={})
    db.commit()
    db.refresh(row)
    return to_dict(row)


@router.patch("/register/{kind}/{row_id}")
def update_register(kind: str, row_id: str, body: dict,
                    user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    model, to_dict, entity = _register(kind)
    row = db.query(model).filter(model.id == row_id, model.deleted_at == "").first()
    if not row:
        raise HTTPException(404, "Not found")
    p = _project(db, row.project_id, user)
    data = _register_data(kind, body, p)
    if not _may_review(db, user, p):
        # The person named to answer an RFI / decide a submittal (11/03/2026 -
        # their Approvals row opens here) gives the answer or the decision,
        # and nothing else.
        own = {"rfis": ("responder_email", RESPONDER_FIELDS), "submittals": ("approver_email", APPROVER_FIELDS)}.get(kind)
        if not own or (getattr(row, own[0], "") or "").lower() != _me(user) or not _may_read(db, user, p) \
                or set(data) - own[1]:
            raise HTTPException(403, f"Only a project manager can change {kind}.")
        if "status" in data and data["status"] not in (("answered",) if kind == "rfis" else SUBMITTAL_DECISIONS):
            raise HTTPException(403, "Only a project manager can set that status.")
    _register_person(db, user, data)
    before = {"status": row.status or "",
              "person": (getattr(row, "responder_email", "") if kind == "rfis"
                         else getattr(row, "approver_email", "") if kind == "submittals" else "") or ""}
    for k, v in data.items():
        setattr(row, k, v)
    # Confirming a milestone is a human act with a name attached, and the only
    # way ai_detected_at's suggestion ever becomes a state change.
    if kind == "milestones" and data.get("status") in ("hit", "missed"):
        row.confirmed_by = user["email"]
    row.modified_at = now_iso()
    _log_activity(db, project_id=p.id, entity_kind=entity, entity_id=row.id,
                  type="edited", actor_email=user["email"],
                  detail=", ".join(sorted(data)) or "no fields")
    _register_events(db, kind, row, user, p, created=False, before=before)
    db.commit()
    db.refresh(row)
    return to_dict(row)


@router.delete("/register/{kind}/{row_id}", status_code=204)
def delete_register(kind: str, row_id: str, user: dict = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    """Soft delete - a published report's provenance still points at these ids."""
    model, _, entity = _register(kind)
    row = db.query(model).filter(model.id == row_id, model.deleted_at == "").first()
    if not row:
        raise HTTPException(404, "Not found")
    p = _project(db, row.project_id, user)
    if not _may_review(db, user, p):
        raise HTTPException(403, f"Only a project manager can remove {kind}.")
    row.deleted_at = now_iso()
    _log_activity(db, project_id=p.id, entity_kind=entity, entity_id=row.id,
                  type="deleted", actor_email=user["email"])
    db.commit()


# ── Weekly reports ───────────────────────────────────────────────────────────
def report_to_dict(r: models.ConstructionWeeklyReport, names: dict = None) -> dict:
    return {
        "approvedByName": (names or {}).get((r.approved_by or "").lower(), ""),
        # Written by the model, or assembled from the logs without it.
        "aiWritten": bool(r.ai_model) and not (r.ai_model or "").startswith("fallback"),
        "id": r.id, "projectId": r.project_id, "weekStart": r.week_start,
        "weekEnd": r.week_end or "", "title": r.title or "",
        "status": r.status or "draft", "version": r.version or 1,
        "supersedesId": _nz(r.supersedes_id),
        "sections": r.sections or {}, "sectionOrder": r.section_order or [],
        "stats": r.stats or {}, "risks": r.risks or [],
        "recommendations": r.recommendations or [],
        "executiveSummary": r.executive_summary or "",
        "managerNotes": r.manager_notes or "",
        "dailyLogIds": r.daily_log_ids or [], "mediaIds": r.media_ids or [],
        "pdfUrl": r.pdf_url or "", "generatedAt": r.generated_at or "",
        "approvedBy": r.approved_by or "", "publishedAt": r.published_at or "",
    }


@router.get("/projects/{project_id}/reports")
def list_reports(project_id: str, user: dict = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    p = _project(db, project_id, user)
    if not _may_read(db, user, p):
        raise HTTPException(403, "You do not have access to this project.")
    rows = (db.query(models.ConstructionWeeklyReport)
            .filter(models.ConstructionWeeklyReport.project_id == project_id,
                    models.ConstructionWeeklyReport.deleted_at == "").all())
    # Executives see published only. A draft an executive read and quoted before
    # a manager finished editing it is the failure this module's review gate
    # exists to prevent.
    if not _may_review(db, user, p):
        rows = [r for r in rows if r.status == "published"]
    names = construction_company.people_names(db, {r.approved_by or "" for r in rows})
    return [report_to_dict(r, names) for r in
            sorted(rows, key=lambda r: (r.week_start, r.version), reverse=True)]


@router.post("/projects/{project_id}/reports/generate", status_code=201)
def generate_report(project_id: str, body: dict,
                    user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Draft (or redraft) one week. Manager-only: this spends model tokens and
    supersedes a published report."""
    p = _project(db, project_id, user)
    if not _may_review(db, user, p):
        raise HTTPException(403, "Only a project manager can generate a report.")
    # ONE week rule (11/03/2026): the project's week_starts_on on the jobsite's
    # clock. Any day of a week names that week; no day = the week on site now.
    from datetime import date as _date
    raw = ((body or {}).get("week_start") or "").strip()
    if raw:
        try:
            day = _date.fromisoformat(raw[:10])
        except ValueError:
            raise HTTPException(422, "week_start must be a full date (YYYY-MM-DD)")
        if day > construction_company.local_today(db, p):
            raise HTTPException(422, "That week has not started yet on site.")
        week_start = construction_company.week_start_for(
            day, construction_company.week_starts(p)).isoformat()
    else:
        week_start = construction_company.current_week_start(db, p).isoformat()
    import construction_report
    try:
        r = construction_report.generate(db, p, week_start, user["email"])
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:
        # Model/transport failures are the common case here and must not read as
        # a bug in the button.
        raise HTTPException(502, f"Could not draft the report: {str(e)[:200]}")
    _log_activity(db, project_id=p.id, entity_kind="report", entity_id=r.id,
                  type="generated", actor_email=user["email"],
                  detail=f"week of {week_start}")
    from sqlalchemy.exc import IntegrityError
    try:
        db.commit()
    except IntegrityError:
        # Someone (the scheduler, a second click) wrote this week's version a
        # moment ago - the unique project/week/version index. Theirs stands.
        db.rollback()
        r = (db.query(models.ConstructionWeeklyReport)
             .filter(models.ConstructionWeeklyReport.project_id == p.id,
                     models.ConstructionWeeklyReport.week_start == week_start,
                     models.ConstructionWeeklyReport.deleted_at == "")
             .order_by(models.ConstructionWeeklyReport.version.desc()).first())
        if r is None:
            raise HTTPException(409, "This week's report changed while it was drafting - try again.")
        return report_to_dict(r)
    db.refresh(r)
    return report_to_dict(r)


def _report(db, report_id):
    r = (db.query(models.ConstructionWeeklyReport)
         .filter(models.ConstructionWeeklyReport.id == report_id,
                 models.ConstructionWeeklyReport.deleted_at == "").first())
    if not r:
        raise HTTPException(404, "Report not found")
    return r


@router.patch("/reports/{report_id}")
def update_report(report_id: str, body: dict, user: dict = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    """Manager edits. Section edits write to `text` only - `ai_text` is never
    overwritten, so "what did the model actually say" survives every edit."""
    r = _report(db, report_id)
    p = _project(db, r.project_id, user)
    if not _may_review(db, user, p):
        raise HTTPException(403, "Only a project manager can edit a report.")
    if r.status == "published":
        raise HTTPException(409, "A published report is immutable. Regenerate to create a new version.")
    now = now_iso()
    edits = (body or {}).get("sections") or {}
    if edits:
        sections = dict(r.sections or {})
        for key, text in edits.items():
            cur = dict(sections.get(key) or {"ai_text": "", "sources": []})
            cur["text"] = text
            cur["edited_by"], cur["edited_at"] = user["email"], now
            sections[key] = cur
        r.sections = sections
    for field, col in (("title", "title"), ("manager_notes", "manager_notes"),
                       ("executive_summary", "executive_summary")):
        if field in (body or {}):
            setattr(r, col, body[field])
    for field in ("risks", "recommendations", "cost_exposure", "section_order"):
        if field in (body or {}):
            setattr(r, field, body[field])
    if "media_ids" in (body or {}):
        # Only this job's own, live photos (11/03/2026): the report is printed
        # and emailed, so an id from another job never gets into it.
        wanted = [i for i in (body.get("media_ids") or []) if isinstance(i, str)]
        mine = {m.id for m in db.query(models.ConstructionMedia.id)
                .filter(models.ConstructionMedia.id.in_(wanted or [""]),
                        models.ConstructionMedia.project_id == r.project_id,
                        models.ConstructionMedia.deleted_at == "").all()}
        r.media_ids = [i for i in wanted if i in mine]
    r.modified_at = now
    _log_activity(db, project_id=p.id, entity_kind="report", entity_id=r.id,
                  type="edited", actor_email=user["email"],
                  detail=", ".join(sorted(edits)) or "fields")
    db.commit()
    db.refresh(r)
    return report_to_dict(r)


@router.post("/reports/{report_id}/publish")
def publish_report(report_id: str, background_tasks: BackgroundTasks,
                   user: dict = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """Approve and publish in one act. Publishing freezes the report - later
    edits produce a new version rather than mutating what an executive may
    already be holding a link to."""
    r = _report(db, report_id)
    p = _project(db, r.project_id, user)
    if not _may_review(db, user, p):
        raise HTTPException(403, "Only a project manager can publish a report.")
    if r.status == "published":
        return report_to_dict(r)
    now = now_iso()
    r.status, r.approved_by, r.approved_at, r.published_at = "published", user["email"], now, now
    r.modified_at = now
    # The week's earlier published version stays readable until this one is
    # out (construction_report.generate); only now does it step aside.
    for old in (db.query(models.ConstructionWeeklyReport)
                .filter(models.ConstructionWeeklyReport.project_id == r.project_id,
                        models.ConstructionWeeklyReport.week_start == r.week_start,
                        models.ConstructionWeeklyReport.status == "published",
                        models.ConstructionWeeklyReport.id != r.id,
                        models.ConstructionWeeklyReport.deleted_at == "").all()):
        old.status, old.modified_at = "superseded", now
    _log_activity(db, project_id=p.id, entity_kind="report", entity_id=r.id,
                  type="published", actor_email=user["email"],
                  detail=f"v{r.version} week of {r.week_start}")
    db.commit()
    db.refresh(r)
    # Delivery runs after the response: rendering a PDF of jobsite photos and
    # then waiting on Graph is not something the manager who pressed Publish
    # should sit through, and a mail failure must never un-publish a report.
    background_tasks.add_task(construction_notify.deliver_published_report, r.id)
    return report_to_dict(r)


@router.get("/reports/{report_id}/pdf")
def report_pdf(report_id: str, user: dict = Depends(get_current_user),
               db: Session = Depends(get_db)):
    """Render the report as a PDF.

    Rendered on demand rather than stored: a manager edits a section and the very
    next download must reflect it. Caching a file would mean either a stale
    document or an invalidation rule that gets it wrong once."""
    from fastapi.responses import Response
    r = _report(db, report_id)
    p = _project(db, r.project_id, user)
    if not _may_read(db, user, p):
        raise HTTPException(403, "You do not have access to this project.")
    # Executives may hold a link to a draft's id; only published content leaves.
    if r.status != "published" and not _may_review(db, user, p):
        raise HTTPException(403, "This report has not been published yet.")

    # A removed photo, or another job's, never prints (11/03/2026).
    media = {m.id: m for m in db.query(models.ConstructionMedia)
             .filter(models.ConstructionMedia.id.in_(r.media_ids or [""]),
                     models.ConstructionMedia.project_id == r.project_id,
                     models.ConstructionMedia.deleted_at == "").all()} if r.media_ids else {}
    logs = (db.query(models.ConstructionDailyLog)
            .filter(models.ConstructionDailyLog.id.in_(r.daily_log_ids or [""]))
            .order_by(models.ConstructionDailyLog.log_date).all()) if r.daily_log_ids else []

    import construction_pdf
    try:
        pdf = construction_pdf.build(r, p, media, logs)
    except Exception as e:
        raise HTTPException(502, f"Could not render the PDF: {str(e)[:200]}")
    safe = "".join(c for c in (r.title or "weekly-report") if c.isalnum() or c in " -_").strip() or "weekly-report"
    return Response(pdf, media_type="application/pdf", headers={
        "Content-Disposition": f'inline; filename="{safe} v{r.version or 1}.pdf"'})


# ── Dashboard ────────────────────────────────────────────────────────────────
def health_for(db: Session, projects: list) -> dict:
    """{project id: health row} for these projects - three batched reads
    (milestones, RFIs, the last filed log per project), then
    construction_health on the jobsite's own today."""
    import construction_health
    from sqlalchemy import func
    ids = [p.id for p in projects]
    if not ids:
        return {}
    M, R, L = models.ConstructionMilestone, models.ConstructionRfi, models.ConstructionDailyLog
    ms, rf = {}, {}
    for m in db.query(M).filter(M.project_id.in_(ids), M.deleted_at == "").all():
        ms.setdefault(m.project_id, []).append(m)
    # A job with a task project reads its milestones from there (11/03/2026,
    # construction_tasks) - the old rows were moved in and are kept as record.
    by_tp = {p.task_project_id: p.id for p in projects if (getattr(p, "task_project_id", "") or "")}
    if by_tp:
        from types import SimpleNamespace
        T = models.Task
        for pid in by_tp.values():
            ms[pid] = []
        today = datetime.now(timezone.utc).date().isoformat()
        for t in db.query(T).filter(T.project_id.in_(sorted(by_tp)), T.is_milestone.is_(True)).all():
            due = (t.due_on or "")[:10]
            ms[by_tp[t.project_id]].append(SimpleNamespace(
                id=t.id, name=t.title or "", target_date=due,
                status="hit" if t.completed else ("missed" if due and due < today else "upcoming")))
    for r in db.query(R).filter(R.project_id.in_(ids), R.deleted_at == "").all():
        rf.setdefault(r.project_id, []).append(r)
    last = dict(db.query(L.project_id, func.max(L.log_date))
                .filter(L.project_id.in_(ids), L.deleted_at == "", L.status != "draft")
                .group_by(L.project_id).all())
    return {p.id: construction_health.health(p, milestones=ms.get(p.id, []), rfis=rf.get(p.id, []),
                                             last_log_date=last.get(p.id) or "",
                                             today=construction_company.local_today(db, p))
            for p in projects}


@router.get("/overview")
def overview(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Backs the Construction Overview cards, which were hardcoded (156 / 12 / 0
    / 94%). Every number here is derived; a stat with no real source is omitted
    rather than invented.

    11/03/2026: projects come worst first with their health row
    (construction_health), the open ones only (active and on hold); "Pending
    Review" counts the logs the caller can actually decide (not their own);
    and the crew's own tags over the last 7 days on site replace the AI's
    safety flags, which read 0 forever while AI is off."""
    import construction_ai
    import construction_health
    from datetime import timedelta
    projects = _visible_projects(db, user)
    ids = [p.id for p in projects]
    open_ = [p for p in projects if (p.status or "active") in ("active", "on_hold") and not p.archived]
    active = [p for p in open_ if (p.status or "active") == "active"]
    logs = (db.query(models.ConstructionDailyLog)
            .filter(models.ConstructionDailyLog.project_id.in_(ids or [""]),
                    models.ConstructionDailyLog.deleted_at == "").all()) if ids else []
    by_id = {p.id: p for p in projects}
    workforce = len({e for p in open_ for e in _emails(p.worker_emails)})
    me = _me(user)
    reviewable = {p.id for p in projects if _may_review(db, user, p)}
    pending = len([l for l in logs if l.status in ("submitted", "processed")
                   and l.project_id in reviewable and (l.author_email or "").lower() != me])
    since = {pid: (construction_company.local_today(db, p) - timedelta(days=6)).isoformat()
             for pid, p in by_id.items()}
    recent = [l for l in logs if l.status != "draft" and (l.log_date or "") >= since.get(l.project_id, "9999")]
    tags = {t: 0 for t in LOG_TAGS}
    for l in recent:
        for t in _tags(getattr(l, "tags", None)):
            tags[t] += 1
    health = health_for(db, open_)
    names = construction_company.people_names(
        db, {e for p in open_ for e in _emails(p.manager_emails) | _emails(p.worker_emails)})
    rows = [project_to_dict(p, with_cost=_may_see_cost(db, user, p), db=db, health=health.get(p.id),
                            names=names, can_edit=_may_review(db, user, p)) for p in open_]
    rows.sort(key=construction_health.sort_key)
    ai_on = construction_ai.configured()
    return {
        "aiEnabled": ai_on,
        "totalWorkforce": workforce,
        "activeSites": len(active),
        "safetyFlags": sum(len(l.ai_safety_flags or []) for l in recent) if ai_on else tags["safety"],
        "tagCounts": tags,
        "pendingReview": pending,
        "logsThisWeek": len(recent),
        "projects": rows,
    }


@router.get("/projects/{project_id}")
def get_project(project_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """One project, with its health row - what a project URL
    (/construction/project:<id>) opens, whatever its status."""
    p = _project(db, project_id, user)
    if not _may_read(db, user, p):
        raise HTTPException(403, "You do not have access to this project.")
    names = construction_company.people_names(
        db, _emails(p.manager_emails) | _emails(p.worker_emails) | _emails(p.executive_emails))
    return project_to_dict(p, with_cost=_may_see_cost(db, user, p), db=db,
                           health=health_for(db, [p]).get(p.id), names=names,
                           can_edit=_may_review(db, user, p))


# ── Site weather (Neil, call of 10/30/2026) ──────────────────────────────────
@router.get("/weather")
def site_weather(units: str = "imperial", user: dict = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    """Every active jobsite the caller may see, with its weather: now, today,
    the next days, the first wet hour and a flag (rain / storm / wind / heat).
    One row per project; a project with no map point says why. The forecast
    is the widget's cache (10 minutes a point), so this costs one outbound
    call per site per ten minutes whoever asks. The zone each forecast
    answers is kept as the jobsite's clock (construction_company)."""
    units = "metric" if units == "metric" else "imperial"
    cfg = construction_weather.watch_config(db)
    active = [p for p in _visible_projects(db, user) if (p.status or "active") == "active" and not p.archived]
    sites = []
    zoned = False
    for p in sorted(active, key=lambda p: p.name.lower()):
        try:
            row = construction_weather.site_weather(p, units, cfg)
            zoned = construction_company.remember_zone(p, (row.get("weather") or {}).get("timezone") or "") or zoned
            sites.append(row)
        except Exception as e:   # noqa: BLE001 - one site's outage never blanks the strip
            sites.append({"projectId": p.id, "name": p.name, "address": p.address or "",
                          "latitude": p.latitude or 0.0, "longitude": p.longitude or 0.0,
                          "weather": None, "reason": getattr(e, "detail", None) or "Weather is unavailable right now."})
    if zoned:
        db.commit()
    return {"sites": sites, "units": units}
