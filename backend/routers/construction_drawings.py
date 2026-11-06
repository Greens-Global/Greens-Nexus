"""Drawings, the current set (Round Two item 9, Neil, 11/06/2026: register
only, no pins on sheets). "Building from a stale sheet is the top cause of
rework."

A Project's drawing register: sheet number, title, discipline, revision,
revision date, the file, Current or Superseded. Adding a sheet whose number
already has a current sheet is a new revision: the old one becomes
Superseded (kept, never deleted, `superseded_by` the new row), the crew and
the job's managers get ONE bell per sheet ("A-201 is now Rev 3"), rewritten
in place on the next revision, and `drawing.revised` goes to Workflows.

The file is a construction_media row of kind `drawing`, made by the same
`make_media` every job file goes through - the browser puts it in the
private construction-media bucket, the Egnyte sweep files the record copy
into the job's folder under the property (`<job folder>/Drawings`).

Reach (routers/construction.py): reading is reading the job (_may_read);
adding a sheet or a revision and removing one are the job's managers
(_may_review). Remove only stamps `deleted_at`; removing the current sheet
puts the revision it replaced back as current.
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import construction_notify
import models
from auth import get_current_user
from database import get_db
from routers.construction import _DAY, _emit, _log_activity, _may_read, _may_review, _me, _project, now_iso
from routers.construction_field import JobMediaBody, make_media

router = APIRouter(prefix="/construction", tags=["Construction"],
                   dependencies=[Depends(get_current_user)])

FAMILY = ("drawing_revised",)


def _sheet(text: str) -> str:
    """'a-201 ' -> 'A-201': one sheet number however it was typed."""
    return " ".join((text or "").split()).upper()[:40]


def _to_dict(d: models.ConstructionDrawing, media: dict) -> dict:
    m = media.get(d.media_id)
    filed = m is not None and m.egnyte_status == "uploaded"
    return {"id": d.id, "sheetNumber": d.sheet_number, "title": d.title or "", "discipline": d.discipline or "",
            "revision": d.revision or "", "revisionOn": d.revision_on or "", "fileUrl": d.file_url or "",
            "fileName": d.file_name or "", "status": d.status, "supersededBy": d.superseded_by or "",
            "createdBy": d.created_by or "", "createdAt": d.created_at or "",
            "egnytePath": m.egnyte_path if filed else "", "egnyteUrl": m.egnyte_web_url if filed else ""}


def _out(db: Session, p, user: dict) -> dict:
    D = models.ConstructionDrawing
    rows = (db.query(D).filter(D.project_id == p.id, D.deleted_at == "")
            .order_by(D.sheet_number, D.created_at.desc()).all())
    ids = [d.media_id for d in rows if d.media_id]
    media = {m.id: m for m in db.query(models.ConstructionMedia)
             .filter(models.ConstructionMedia.id.in_(ids or [""])).all()}
    return {"drawings": [_to_dict(d, media) for d in rows], "canEdit": _may_review(db, user, p)}


@router.get("/projects/{job_id}/drawings")
def job_drawings(job_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    p = _project(db, job_id, user)
    if not _may_read(db, user, p):
        raise HTTPException(403, "You do not have access to this job.")
    return _out(db, p, user)


class DrawingIn(BaseModel):
    sheet_number: str
    title: Optional[str] = ""
    discipline: Optional[str] = ""
    revision: str
    revision_on: Optional[str] = ""
    file: JobMediaBody


@router.post("/projects/{job_id}/drawings", status_code=201)
def add_drawing(job_id: str, body: DrawingIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """A sheet, or a new revision of one already on the job."""
    p = _project(db, job_id, user)
    if not _may_review(db, user, p):
        raise HTTPException(403, "Only a job manager adds drawings.")
    sheet = _sheet(body.sheet_number)
    rev = " ".join((body.revision or "").split())[:20]
    if not sheet:
        raise HTTPException(422, "Give the sheet number.")
    if not rev:
        raise HTTPException(422, "Give the revision.")
    if body.revision_on and not _DAY.match(body.revision_on):
        raise HTTPException(422, "The revision date must be a full date.")
    if not (body.file.url or "").strip():
        raise HTTPException(422, "Attach the sheet's file.")
    D = models.ConstructionDrawing
    # Locked so two uploads of the same sheet at once cannot both stay current.
    was = (db.query(D).filter(D.project_id == p.id, D.sheet_number == sheet, D.status == "current",
                              D.deleted_at == "").with_for_update().first())
    if was is not None and (was.revision or "").upper() == rev.upper():
        raise HTTPException(409, f"{sheet} Rev {rev} is already the current sheet.")
    title = (body.title or "").strip()[:200] or (was.title if was is not None else "")
    f = body.file.model_copy(update={
        "id": None, "kind": "drawing", "log_id": "", "tags": None,
        "taken_at": body.revision_on or "",
        "description": f"{sheet} Rev {rev} {title}".strip()})
    m = make_media(db, user, p, f)
    now = now_iso()
    d = D(id=str(uuid.uuid4()), project_id=p.id, sheet_number=sheet, title=title,
          discipline=(body.discipline or "").strip()[:40] or (was.discipline if was is not None else ""),
          revision=rev, revision_on=body.revision_on or "", media_id=m.id, file_url=m.url or "",
          file_name=(body.file.original_name or "").strip()[:200], status="current", superseded_by="",
          created_by=_me(user), created_at=now, modified_at=now, deleted_at="")
    db.add(d)
    if was is None:
        _log_activity(db, project_id=p.id, entity_kind="drawing", entity_id=d.id, type="drawing_added",
                      actor_email=_me(user), detail=f"added drawing {sheet} Rev {rev}")
    else:
        was.status, was.superseded_by, was.modified_at = "superseded", d.id, now
        _log_activity(db, project_id=p.id, entity_kind="drawing", entity_id=d.id, type="drawing_revised",
                      actor_email=_me(user), detail=f"{sheet} Rev {was.revision} superseded by Rev {rev}")
        db.flush()
        _bell_revised(db, p, d, _me(user))
        _emit(db, "drawing.revised", p, user, extra={"drawing_id": d.id, "sheet_number": sheet, "revision": rev,
                                                     "previous_revision": was.revision or "", "title": title})
    db.commit()
    return _out(db, p, user)


def _bell_revised(db: Session, p, d, actor: str) -> None:
    """The crew and the job's managers: one bell per sheet per person,
    rewritten in place by the next revision."""
    people = {(e or "").strip().lower() for e in list(p.worker_emails or []) + list(p.manager_emails or [])}
    for em in sorted(people - {"", actor}):
        construction_notify.bell(
            db, kind="drawing_revised", family=FAMILY, recipient=em, ref_id=f"drawing:{p.id}:{d.sheet_number}",
            title="Drawing Revised",
            body=f"{d.sheet_number} is now Rev {d.revision}{' - ' + d.title if d.title else ''} on {p.name}. "
                 "Build from the current sheet; the one before it is superseded.",
            label="Open Drawings", sub=f"project:{p.id}:drawings", requested_by=actor,
            company=getattr(p, "company_id", "") or "")


@router.delete("/drawings/{drawing_id}", status_code=204)
def remove_drawing(drawing_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Take a sheet off the register (kept, marked removed). Removing the
    current sheet puts the revision it replaced back as current."""
    D = models.ConstructionDrawing
    d = db.get(D, drawing_id)
    if d is None or d.deleted_at:
        raise HTTPException(404, "Drawing not found")
    p = _project(db, d.project_id, user)
    if not _may_review(db, user, p):
        raise HTTPException(403, "Only a job manager removes drawings.")
    now = now_iso()
    d.deleted_at = d.modified_at = now
    if d.status == "current":
        prev = db.query(D).filter(D.superseded_by == d.id, D.deleted_at == "").first()
        if prev is not None:
            prev.status, prev.superseded_by, prev.modified_at = "current", "", now
    _log_activity(db, project_id=p.id, entity_kind="drawing", entity_id=d.id, type="drawing_removed",
                  actor_email=_me(user), detail=f"removed drawing {d.sheet_number} Rev {d.revision}")
    db.commit()
