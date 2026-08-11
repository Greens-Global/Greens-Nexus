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
"""
import math
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import construction_notify
import models
from auth import get_current_user
from database import get_db
from services import construction_storage as storage


# Defined here rather than imported from routers/task_util: this module is
# independent of the Task module (Sagar, Aug 4), and reaching into it for a
# uuid4 and an isoformat would be a dependency bought for nothing.
def gen_id() -> str:
    return str(uuid.uuid4())


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


router = APIRouter(prefix="/construction", tags=["Construction"],
                   dependencies=[Depends(get_current_user)])


# ── Permissions ──────────────────────────────────────────────────────────────
def _level(user: dict) -> int:
    return int(user.get("level") or 0)


def _project(db: Session, project_id: str) -> models.ConstructionProject:
    p = (db.query(models.ConstructionProject)
         .filter(models.ConstructionProject.id == project_id,
                 models.ConstructionProject.deleted_at == "").first())
    if not p:
        raise HTTPException(404, "Project not found")
    return p


def _emails(value) -> set:
    return {(e or "").strip().lower() for e in (value or []) if (e or "").strip()}


def _may_log(user: dict, p: models.ConstructionProject) -> bool:
    """May this person file a daily log on this project?

    Deliberately NOT a level check. The whole module exists so the person
    holding the phone on the jobsite can file in two minutes, and that person is
    the lowest-privileged user in the system. Membership of the project's
    worker/manager list is the grant; level only ever adds."""
    em = (user.get("email") or "").lower()
    return (_level(user) >= 4                      # admin
            or em in _emails(p.worker_emails)
            or em in _emails(p.manager_emails))


def _may_review(user: dict, p: models.ConstructionProject) -> bool:
    """May this person approve?

    Level 3 is `manager` in auth.py's _LEVELS, and this bypass matches
    routers/task_util.py's require_project_role, which also opens at manager.
    An earlier draft used >= 4 (administrator), which contradicted this module's
    own docstring and meant a real manager could not approve a log unless
    somebody had individually listed them in manager_emails.

    The membership term is what lets a project name its own approvers without
    promoting anyone. What neither term does is let the AUTHOR approve their own
    log - submit_log and review_log are separate endpoints and the worker can
    only reach the first."""
    em = (user.get("email") or "").lower()
    return _level(user) >= 3 or em in _emails(p.manager_emails)


def _may_read(db: Session, user: dict, p: models.ConstructionProject) -> bool:
    em = (user.get("email") or "").lower()
    return (_level(user) >= 3
            or em in _emails(p.worker_emails)
            or em in _emails(p.manager_emails)
            or em in _emails(p.executive_emails))


def _visible_projects(db: Session, user: dict) -> list:
    rows = (db.query(models.ConstructionProject)
            .filter(models.ConstructionProject.deleted_at == "").all())
    if _level(user) >= 3:
        return rows
    return [p for p in rows if _may_read(db, user, p)]


# ── Serialization ────────────────────────────────────────────────────────────
def _nz(v):
    return v if v not in ("", None) else None


def project_to_dict(p: models.ConstructionProject, *, with_cost: bool) -> dict:
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
    }
    # Contract value is withheld from workers and supervisors. A daily-log screen
    # has no reason to carry it, and "the numbers leaked through the field app"
    # is a phone call nobody wants.
    if with_cost:
        d["contractValue"] = p.contract_value or 0.0
        d["currency"] = p.currency or "USD"
    return d


def log_to_dict(l: models.ConstructionDailyLog) -> dict:
    return {
        "id": l.id, "projectId": l.project_id, "logDate": l.log_date,
        "authorEmail": l.author_email, "status": l.status,
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
    with_cost = _level(user) >= 3
    return [project_to_dict(p, with_cost=with_cost)
            for p in sorted(_visible_projects(db, user), key=lambda p: (p.archived, p.name))]


class ProjectBody(BaseModel):
    name: Optional[str] = None
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


@router.post("/projects", status_code=201)
def create_project(body: ProjectBody, user: dict = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    if _level(user) < 3:
        raise HTTPException(403, "Only a manager can create a construction project.")
    if not (body.name or "").strip():
        raise HTTPException(422, "Project name is required")
    now = now_iso()
    p = models.ConstructionProject(
        id=gen_id(), name=body.name.strip(), code=body.code or "",
        description=body.description or "",
        property_id=body.property_id or "",
        address=body.address or "", status=body.status or "active", phase=body.phase or "",
        percent_complete=body.percent_complete or 0.0,
        contract_value=body.contract_value or 0.0, currency=body.currency or "USD",
        general_contractor=body.general_contractor or "",
        start_on=body.start_on or "", target_finish_on=body.target_finish_on or "",
        # The creator is a manager by default. Without this the person who just
        # made the project cannot review anything in it, which reads as a bug.
        manager_emails=body.manager_emails if body.manager_emails is not None else [user["email"]],
        worker_emails=body.worker_emails or [],
        executive_emails=body.executive_emails or [],
        latitude=body.latitude or 0.0, longitude=body.longitude or 0.0,
        geofence_radius_m=body.geofence_radius_m if body.geofence_radius_m is not None else 500,
        week_starts_on=body.week_starts_on if body.week_starts_on is not None else 1,
        report_day=body.report_day if body.report_day is not None else 5,
        archived=bool(body.archived),
        created_by=user["email"], created_at=now, modified_at=now,
    )
    db.add(p)
    _log_activity(db, project_id=p.id, entity_kind="project", entity_id=p.id,
                  type="created", actor_email=user["email"], detail="created this project")
    db.commit()
    db.refresh(p)
    return project_to_dict(p, with_cost=True)


@router.patch("/projects/{project_id}")
def update_project(project_id: str, body: ProjectBody,
                   user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    p = _project(db, project_id)
    if not _may_review(user, p):
        raise HTTPException(403, "Only a project manager can change this project.")
    data = body.model_dump(exclude_unset=True)
    for k, v in data.items():
        if v is not None:
            setattr(p, k, v)
    p.modified_at = now_iso()
    _log_activity(db, project_id=p.id, entity_kind="project", entity_id=p.id,
                  type="edited", actor_email=user["email"],
                  detail=", ".join(sorted(data)) or "no fields")
    db.commit()
    db.refresh(p)
    return project_to_dict(p, with_cost=True)


# ── Daily logs ───────────────────────────────────────────────────────────────
@router.get("/projects/{project_id}/logs")
def list_logs(project_id: str, date_from: str = "", date_to: str = "",
              user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    p = _project(db, project_id)
    if not _may_read(db, user, p):
        raise HTTPException(403, "You do not have access to this project.")
    q = (db.query(models.ConstructionDailyLog)
         .filter(models.ConstructionDailyLog.project_id == project_id,
                 models.ConstructionDailyLog.deleted_at == ""))
    if date_from:
        q = q.filter(models.ConstructionDailyLog.log_date >= date_from)
    if date_to:
        q = q.filter(models.ConstructionDailyLog.log_date <= date_to)
    rows = q.all()
    # A draft is private to its author until submitted. A half-written log read
    # over somebody's shoulder is how workers learn to stop writing them.
    em = (user.get("email") or "").lower()
    if not _may_review(user, p):
        rows = [l for l in rows
                if l.status != "draft" or (l.author_email or "").lower() == em]
    return [log_to_dict(l) for l in sorted(rows, key=lambda l: (l.log_date, l.created_at),
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


@router.post("/projects/{project_id}/logs", status_code=201)
def create_log(project_id: str, body: LogBody, user: dict = Depends(get_current_user),
               db: Session = Depends(get_db)):
    """Opens a draft. Called the moment the worker taps Start Daily Log, before
    any media exists, so photos have somewhere to attach as they upload rather
    than being held on the phone until a final Submit."""
    p = _project(db, project_id)
    if not _may_log(user, p):
        raise HTTPException(403, "You are not assigned to this project.")
    if not (body.log_date or "").strip():
        raise HTTPException(422, "log_date is required (YYYY-MM-DD, jobsite-local)")
    now = now_iso()
    # One draft per person per day. Tapping Start twice - which happens when the
    # app is backgrounded on site - must resume, not fork the day into two logs
    # that each hold half the photos.
    existing = (db.query(models.ConstructionDailyLog)
                .filter(models.ConstructionDailyLog.project_id == project_id,
                        models.ConstructionDailyLog.log_date == body.log_date,
                        models.ConstructionDailyLog.author_email == user["email"],
                        models.ConstructionDailyLog.status == "draft",
                        models.ConstructionDailyLog.deleted_at == "").first())
    if existing:
        return log_to_dict(existing)
    l = models.ConstructionDailyLog(
        id=gen_id(), project_id=project_id, log_date=body.log_date,
        author_email=user["email"], status="draft",
        notes_raw=body.notes_raw or "", weather=body.weather or "",
        temperature_f=body.temperature_f or 0.0,
        crew_size=body.crew_size or 0, hours_worked=body.hours_worked or 0.0,
        gps_latitude=body.gps_latitude or 0.0, gps_longitude=body.gps_longitude or 0.0,
        gps_accuracy_m=body.gps_accuracy_m or 0.0,
        geofence_ok=_within_geofence(p, body.gps_latitude, body.gps_longitude),
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


@router.patch("/logs/{log_id}")
def update_log(log_id: str, body: LogBody, user: dict = Depends(get_current_user),
               db: Session = Depends(get_db)):
    l = _get_log(db, log_id)
    p = _project(db, l.project_id)
    em = (user.get("email") or "").lower()
    if (l.author_email or "").lower() != em and not _may_review(user, p):
        raise HTTPException(403, "You can only edit your own daily log.")
    if l.status not in ("draft", "needs_info"):
        raise HTTPException(409, "This log has been submitted and can no longer be edited.")
    for k, v in body.model_dump(exclude_unset=True).items():
        if v is not None:
            setattr(l, k, v)
    l.modified_at = now_iso()
    db.commit()
    db.refresh(l)
    return log_to_dict(l)


def _get_log(db: Session, log_id: str) -> models.ConstructionDailyLog:
    l = (db.query(models.ConstructionDailyLog)
         .filter(models.ConstructionDailyLog.id == log_id,
                 models.ConstructionDailyLog.deleted_at == "").first())
    if not l:
        raise HTTPException(404, "Daily log not found")
    return l


@router.post("/logs/{log_id}/submit")
def submit_log(log_id: str, user: dict = Depends(get_current_user),
               db: Session = Depends(get_db)):
    """The worker's last action. Returns immediately.

    Everything expensive - captioning, transcription, summarization, the Egnyte
    record copy - is queued as ConstructionAIJob rows and runs after this
    responds. The two-minute budget is spent on the phone, not waiting on a
    model."""
    l = _get_log(db, log_id)
    p = _project(db, l.project_id)
    em = (user.get("email") or "").lower()
    if (l.author_email or "").lower() != em and _level(user) < 4:
        raise HTTPException(403, "You can only submit your own daily log.")
    if l.status not in ("draft", "needs_info"):
        raise HTTPException(409, f"This log is already {l.status}.")

    media = (db.query(models.ConstructionMedia)
             .filter(models.ConstructionMedia.daily_log_id == log_id,
                     models.ConstructionMedia.deleted_at == "").all())
    if not media and not (l.notes_raw or "").strip():
        raise HTTPException(422, "Add at least one photo, video, voice note or written note.")

    now = now_iso()
    l.status = "submitted"
    l.submitted_at = now
    l.modified_at = now

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
    for m in media:
        if m.kind == "photo" and not (m.ai_caption or "").strip():
            jobs.append(_queue(db, p.id, "media_caption", m.id, priority=20))
    _queue(db, p.id, "log_summarize", l.id, priority=50, depends_on=jobs)

    _log_activity(db, project_id=p.id, entity_kind="log", entity_id=l.id,
                  type="submitted", actor_email=user["email"],
                  detail=f"{len(media)} attachment(s)")
    # Bells go in the same transaction as the status change: a log that says
    # "submitted" while nobody was told is the state this workflow cannot have.
    construction_notify.log_submitted(db, p, l)
    db.commit()
    db.refresh(l)
    return {**log_to_dict(l), "queuedJobs": len(jobs) + 1}


def _queue(db: Session, project_id: str, kind: str, subject_id: str, *,
           priority: int = 100, depends_on: list = None) -> str:
    job = models.ConstructionAIJob(
        id=gen_id(), project_id=project_id, kind=kind, subject_id=subject_id,
        status="queued", priority=priority, depends_on=depends_on or [],
        queued_at=now_iso())
    db.add(job)
    db.flush()   # sessions are autoflush=False; the id must be visible to callers
    return job.id


@router.post("/logs/{log_id}/review")
def review_log(log_id: str, body: dict, user: dict = Depends(get_current_user),
               db: Session = Depends(get_db)):
    """Manager approves a log or bounces it back. A worker can never reach here -
    publishing is a manager act, which is the entire point of the workflow."""
    l = _get_log(db, log_id)
    p = _project(db, l.project_id)
    if not _may_review(user, p):
        raise HTTPException(403, "Only a project manager can review daily logs.")
    decision = (body or {}).get("decision")
    if decision not in ("approve", "needs_info"):
        raise HTTPException(422, "decision must be 'approve' or 'needs_info'")
    l.status = "approved" if decision == "approve" else "needs_info"
    l.reviewed_by = user["email"]
    l.reviewed_at = now_iso()
    l.review_note = ((body or {}).get("note") or "")[:2000]
    l.modified_at = l.reviewed_at
    _log_activity(db, project_id=p.id, entity_kind="log", entity_id=l.id,
                  type=decision, actor_email=user["email"], detail=l.review_note)
    # The sent-back case is the whole reason this exists: review_note is a
    # question for the person on site, and it used to be written to the row and
    # shown to nobody.
    construction_notify.log_reviewed(db, p, l)
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
    landed and queues the Egnyte record copy."""
    l = _get_log(db, log_id)
    p = _project(db, l.project_id)
    em = (user.get("email") or "").lower()
    if (l.author_email or "").lower() != em and not _may_review(user, p):
        raise HTTPException(403, "You can only attach media to your own daily log.")
    if l.status not in ("draft", "needs_info"):
        raise HTTPException(409, "This log has been submitted; media can no longer be added.")

    err = storage.validate(body.kind, body.size_bytes or 0, body.mime_type or "")
    if err:
        raise HTTPException(413 if "limit is" in err else 422, err)

    now = now_iso()
    mid = gen_id()
    # An inline (data:) row has no Supabase object, so it gets no storage_path -
    # synthesizing one would describe an object that does not exist and send the
    # rebuild sweep looking for it.
    inline = storage.is_inline(body.url or "")
    m = models.ConstructionMedia(
        id=mid, project_id=p.id, daily_log_id=l.id, kind=body.kind,
        storage_path="" if inline else (body.storage_path or storage.supabase_path(
            project_id=p.id, media_id=mid, mime_type=body.mime_type or "",
            original_name=body.original_name or "")),
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
    p = _project(db, l.project_id)
    if not _may_read(db, user, p):
        raise HTTPException(403, "You do not have access to this project.")
    rows = (db.query(models.ConstructionMedia)
            .filter(models.ConstructionMedia.daily_log_id == log_id,
                    models.ConstructionMedia.deleted_at == "",
                    models.ConstructionMedia.duplicate_of == "").all())
    return [media_to_dict(m) for m in sorted(rows, key=lambda m: (m.sort_order, m.uploaded_at))]


@router.delete("/media/{media_id}", status_code=204)
def delete_media(media_id: str, user: dict = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    """Soft delete. The Egnyte record copy is NOT removed - that file is the
    project's record and lives under Egnyte's own retention, not ours."""
    m = (db.query(models.ConstructionMedia)
         .filter(models.ConstructionMedia.id == media_id,
                 models.ConstructionMedia.deleted_at == "").first())
    if not m:
        raise HTTPException(404, "Media not found")
    p = _project(db, m.project_id)
    em = (user.get("email") or "").lower()
    if (m.uploaded_by or "").lower() != em and not _may_review(user, p):
        raise HTTPException(403, "You can only remove media you uploaded.")
    m.deleted_at = now_iso()
    _log_activity(db, project_id=p.id, entity_kind="media", entity_id=m.id,
                  type="deleted", actor_email=user["email"])
    db.commit()


# ── Manager review ───────────────────────────────────────────────────────────
@router.get("/review-queue")
def review_queue(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Every log awaiting a decision, across all projects this manager reviews.

    One request rather than the client fanning out per project: a manager with
    twelve jobsites would otherwise make twelve calls to render one list, and the
    ordering below has to be computed across all of them anyway.

    Ordered by what needs a human first, not by date:
      1. logs the AI was unsure about (low confidence) - a thin or ambiguous day
         is exactly where a manager's read adds the most
      2. logs carrying a safety flag
      3. oldest first
    A log the model was confident about and that raised nothing can wait."""
    projects = [p for p in _visible_projects(db, user) if _may_review(user, p)]
    if not projects:
        return []
    by_id = {p.id: p for p in projects}
    rows = (db.query(models.ConstructionDailyLog)
            .filter(models.ConstructionDailyLog.project_id.in_(list(by_id)),
                    models.ConstructionDailyLog.status.in_(("submitted", "processed")),
                    models.ConstructionDailyLog.deleted_at == "").all())

    def rank(l):
        # Unprocessed logs sort as unknown-confidence rather than 0.0, or every
        # log still queued for AI would jump the queue ahead of real findings.
        conf = l.ai_confidence if l.ai_processed_at else 0.5
        return (0 if conf < 0.5 else 1,
                0 if (l.ai_safety_flags or []) else 1,
                l.log_date, l.created_at or "")

    out = []
    for l in sorted(rows, key=rank):
        d = log_to_dict(l)
        d["projectName"] = by_id[l.project_id].name
        d["mediaCount"] = (db.query(models.ConstructionMedia)
                           .filter(models.ConstructionMedia.daily_log_id == l.id,
                                   models.ConstructionMedia.deleted_at == "").count())
        d["awaitingAi"] = not l.ai_processed_at
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
             "cost_impact", "schedule_impact_days"},
    "submittals": {"number", "title", "spec_section", "status", "revision",
                   "submitted_by", "submitted_on", "due_on", "returned_on",
                   "document_urls"},
}


def _register(kind: str):
    if kind not in _REGISTERS:
        raise HTTPException(404, "Unknown register")
    return _REGISTERS[kind]


@router.get("/projects/{project_id}/register/{kind}")
def list_register(project_id: str, kind: str, user: dict = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    model, to_dict, _ = _register(kind)
    p = _project(db, project_id)
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
    p = _project(db, project_id)
    if not _may_review(user, p):
        raise HTTPException(403, f"Only a project manager can add {kind}.")
    data = {k: v for k, v in (body or {}).items()
            if k in _REGISTER_FIELDS[kind] and v is not None}
    if kind == "milestones" and not (data.get("name") or "").strip():
        raise HTTPException(422, "Milestone name is required")
    now = now_iso()
    row = model(id=gen_id(), project_id=p.id, created_at=now, modified_at=now, **data)
    db.add(row)
    _log_activity(db, project_id=p.id, entity_kind=entity, entity_id=row.id,
                  type="created", actor_email=user["email"],
                  detail=data.get("name") or data.get("subject") or data.get("title") or "")
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
    p = _project(db, row.project_id)
    if not _may_review(user, p):
        raise HTTPException(403, f"Only a project manager can change {kind}.")
    data = {k: v for k, v in (body or {}).items()
            if k in _REGISTER_FIELDS[kind] and v is not None}
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
    p = _project(db, row.project_id)
    if not _may_review(user, p):
        raise HTTPException(403, f"Only a project manager can remove {kind}.")
    row.deleted_at = now_iso()
    _log_activity(db, project_id=p.id, entity_kind=entity, entity_id=row.id,
                  type="deleted", actor_email=user["email"])
    db.commit()


# ── Weekly reports ───────────────────────────────────────────────────────────
def report_to_dict(r: models.ConstructionWeeklyReport) -> dict:
    return {
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
    p = _project(db, project_id)
    if not _may_read(db, user, p):
        raise HTTPException(403, "You do not have access to this project.")
    rows = (db.query(models.ConstructionWeeklyReport)
            .filter(models.ConstructionWeeklyReport.project_id == project_id,
                    models.ConstructionWeeklyReport.deleted_at == "").all())
    # Executives see published only. A draft an executive read and quoted before
    # a manager finished editing it is the failure this module's review gate
    # exists to prevent.
    if not _may_review(user, p):
        rows = [r for r in rows if r.status == "published"]
    return [report_to_dict(r) for r in
            sorted(rows, key=lambda r: (r.week_start, r.version), reverse=True)]


@router.post("/projects/{project_id}/reports/generate", status_code=201)
def generate_report(project_id: str, body: dict,
                    user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Draft (or redraft) one week. Manager-only: this spends model tokens and
    supersedes a published report."""
    p = _project(db, project_id)
    if not _may_review(user, p):
        raise HTTPException(403, "Only a project manager can generate a report.")
    week_start = ((body or {}).get("week_start") or "").strip()
    if not week_start:
        raise HTTPException(422, "week_start is required (YYYY-MM-DD)")
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
    db.commit()
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
    p = _project(db, r.project_id)
    if not _may_review(user, p):
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
    for field in ("risks", "recommendations", "cost_exposure", "media_ids", "section_order"):
        if field in (body or {}):
            setattr(r, field, body[field])
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
    p = _project(db, r.project_id)
    if not _may_review(user, p):
        raise HTTPException(403, "Only a project manager can publish a report.")
    if r.status == "published":
        return report_to_dict(r)
    now = now_iso()
    r.status, r.approved_by, r.approved_at, r.published_at = "published", user["email"], now, now
    r.modified_at = now
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
    p = _project(db, r.project_id)
    if not _may_read(db, user, p):
        raise HTTPException(403, "You do not have access to this project.")
    # Executives may hold a link to a draft's id; only published content leaves.
    if r.status != "published" and not _may_review(user, p):
        raise HTTPException(403, "This report has not been published yet.")

    media = {m.id: m for m in db.query(models.ConstructionMedia)
             .filter(models.ConstructionMedia.id.in_(r.media_ids or [""])).all()} if r.media_ids else {}
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
@router.get("/overview")
def overview(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Backs the Construction Overview cards, which were hardcoded (156 / 12 / 0
    / 94%). Every number here is derived; a stat with no real source is omitted
    rather than invented."""
    projects = _visible_projects(db, user)
    ids = [p.id for p in projects]
    active = [p for p in projects if (p.status or "active") == "active" and not p.archived]
    logs = (db.query(models.ConstructionDailyLog)
            .filter(models.ConstructionDailyLog.project_id.in_(ids or [""]),
                    models.ConstructionDailyLog.deleted_at == "").all()) if ids else []
    workforce = len({e for p in projects for e in _emails(p.worker_emails)})
    safety = sum(len(l.ai_safety_flags or []) for l in logs)
    pending = len([l for l in logs if l.status in ("submitted", "processed")])
    return {
        "totalWorkforce": workforce,
        "activeSites": len(active),
        "safetyFlags": safety,
        "pendingReview": pending,
        "logsThisWeek": len([l for l in logs if l.status != "draft"]),
        "projects": [project_to_dict(p, with_cost=_level(user) >= 3) for p in active],
    }
