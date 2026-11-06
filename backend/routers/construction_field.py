"""Construction in the field - the routes (Neil, 11/03/2026, plan
https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr, phase 3 "Field and
Closeout"). Same `/construction` prefix and the same reach rules as
routers/construction.py (`_project` / `_may_read` / `_may_log` /
`_may_review` - a job behind the caller's company wall is a 404):

  GET  /projects/{id}/logs/prefill        what today's log drafts itself from
  GET  /projects/{id}/timeline            the photo timeline (filters, pairs)
  POST /projects/{id}/media               a job photo (no daily log)
  PATCH /media/{id}/meta                  a photo's tags, spot, caption
  POST /projects/{id}/pairs               before and after
  DELETE /pairs/{id}                      take a pair apart (soft)
  POST /media/{id}/markup                 a Mark Up attached back onto the job
  POST /projects/{id}/photo-report        the curated photo report PDF

Every write the phone's outbox may resend takes the Idempotency-Key
(idempotency.py) - the ONE mechanism (docs/Offline.md section 5); a job
photo also accepts a phone-made id. Photo links pass
construction_storage.check_media: this job's own folder in the private
construction-media bucket, nothing else.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

import construction_company
import construction_field
import models
from auth import get_current_user
from database import get_db
from idempotency import Idem, idempotency
from routers.construction import (_DAY, _get_log, _log_activity, _may_log, _may_read, _may_review, _me,
                                  _project, media_to_dict)
from services import construction_storage as storage

router = APIRouter(prefix="/construction", tags=["Construction"],
                   dependencies=[Depends(get_current_user)])

TAG_MAX, TAGS_MAX = 30, 12
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{7,63}$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _readable(db: Session, job_id: str, user: dict):
    p = _project(db, job_id, user)
    if not _may_read(db, user, p):
        raise HTTPException(403, "You do not have access to this job.")
    return p


def clean_tags(value) -> list:
    """A photo's own tags: short words, lower case, de-duplicated."""
    if value in (None, ""):
        return []
    if not isinstance(value, list):
        raise HTTPException(422, "Tags must be a list.")
    out = []
    for t in value:
        w = " ".join(str(t or "").split()).strip().lower()[:TAG_MAX]
        if w and w not in out:
            out.append(w)
    if len(out) > TAGS_MAX:
        raise HTTPException(422, f"A photo holds at most {TAGS_MAX} tags.")
    return out


# ── The self-drafting log ────────────────────────────────────────────────────

@router.get("/projects/{job_id}/logs/prefill")
def log_prefill(job_id: str, date: str = "", user: dict = Depends(get_current_user),
                db: Session = Depends(get_db)):
    """What a daily log for `date` (the jobsite's today when blank) drafts
    itself from - see construction_field. Anyone who may file a log reads it;
    names and each person's hours only for a job reviewer."""
    p = _project(db, job_id, user)
    if not _may_log(db, user, p) and not _may_review(db, user, p):
        raise HTTPException(403, "You are not on this job.")
    day = (date or "").strip()[:10] or construction_company.local_today(db, p).isoformat()
    if not _DAY.match(day):
        raise HTTPException(422, "date must be a full date (YYYY-MM-DD)")
    return construction_field.prefill(db, user, p, day)


# ── The photo timeline ───────────────────────────────────────────────────────

def _pair_dict(pr) -> dict:
    return {"id": pr.id, "beforeId": pr.before_media_id, "afterId": pr.after_media_id,
            "caption": pr.caption or "", "createdBy": pr.created_by or "", "createdAt": pr.created_at or ""}


def _photo_row(m, logs: dict, names: dict) -> dict:
    d = media_to_dict(m)
    lg = logs.get(m.daily_log_id or "")
    d["logDate"] = lg.log_date if lg else ""
    d["uploadedByName"] = names.get((m.uploaded_by or "").lower(), "")
    d["takenAt"] = m.taken_at or m.uploaded_at or ""
    return d


@router.get("/projects/{job_id}/timeline")
def photo_timeline(job_id: str, tag: str = "", q: str = "", log_id: str = "", kind: str = "photo",
                   user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The job's photos in time order (taken, else uploaded) with who / when /
    where, filtered by a tag, words in the spot or caption, or one daily log;
    plus the job's before and after pairs among them and every tag in use.
    The logs' privacy holds (construction_field.visible_photos)."""
    p = _readable(db, job_id, user)
    kinds = ("photo", "video") if kind == "all" else ("photo",)
    rows = construction_field.visible_photos(db, user, p, kinds=kinds)
    all_tags = sorted({t for m in rows for t in (m.tags or [])})
    want = (tag or "").strip().lower()
    term = (q or "").strip().lower()
    if want:
        rows = [m for m in rows if want in (m.tags or [])]
    if term:
        rows = [m for m in rows if term in " ".join([m.location_text or "", m.caption or "", m.description or ""]).lower()]
    if log_id:
        rows = [m for m in rows if (m.daily_log_id or "") == log_id]
    rows.sort(key=lambda m: (m.taken_at or m.uploaded_at or ""), reverse=True)
    L = models.ConstructionDailyLog
    logs = {lg.id: lg for lg in db.query(L).filter(L.project_id == p.id, L.deleted_at == "").all()}
    names = construction_company.people_names(db, [m.uploaded_by for m in rows])
    PP = models.ConstructionPhotoPair
    visible = {m.id for m in construction_field.visible_photos(db, user, p)}
    pairs = [pr for pr in db.query(PP).filter(PP.project_id == p.id, PP.deleted_at == "").order_by(PP.created_at).all()
             if pr.before_media_id in visible and pr.after_media_id in visible]
    tz = construction_field._zone(db, p)
    return {
        "photos": [{**_photo_row(m, logs, names),
                    "day": construction_field.local_day_of(m.taken_at or m.uploaded_at or "", tz)} for m in rows],
        "pairs": [_pair_dict(pr) for pr in pairs],
        "tags": all_tags,
        "logs": [{"id": lg.id, "logDate": lg.log_date} for lg in sorted(logs.values(), key=lambda x: x.log_date, reverse=True)
                 if lg.id in {m.daily_log_id for m in construction_field.visible_photos(db, user, p)}],
        "canAdd": _may_log(db, user, p),
        "canReview": _may_review(db, user, p),
        "timeZone": construction_company.zone_of(db, p),
    }


class JobMediaBody(BaseModel):
    id: Optional[str] = None             # made on the phone - a resend answers with the row
    kind: str = "photo"
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
    tags: Optional[list] = None
    location_text: Optional[str] = ""
    log_id: Optional[str] = ""           # put it on my own draft log instead of the job


def make_media(db: Session, user: dict, p, body: JobMediaBody, *, log=None, task_id: str = "",
               source_media_id: str = "", extra_tags=()) -> models.ConstructionMedia:
    """One media row from a file the browser already put in construction-media
    (the link checked), queued for the Egnyte record copy. Not committed."""
    from routers.construction import _queue
    kind = body.kind or "photo"
    err = storage.validate(kind, body.size_bytes or 0, body.mime_type or "")
    if err:
        raise HTTPException(413 if "limit is" in err else 422, err)
    bad = storage.check_media(url=body.url or "", storage_path=body.storage_path or "",
                              thumbnail_url=body.thumbnail_url or "", project_id=p.id)
    if bad:
        raise HTTPException(422, bad)
    inline = storage.is_inline(body.url or "")
    mid = (body.id or "").strip() or str(uuid.uuid4())
    tags = clean_tags(list(body.tags or []) + list(extra_tags))
    m = models.ConstructionMedia(
        id=mid, project_id=p.id, daily_log_id=log.id if log is not None else "", kind=kind,
        storage_path="" if inline else (storage.object_path(body.url or "") or body.storage_path or ""),
        url=body.url or "", thumbnail_url=body.thumbnail_url or "", mime_type=body.mime_type or "",
        size_bytes=body.size_bytes or 0, taken_at=body.taken_at or "", uploaded_at=_now(),
        uploaded_by=_me(user), description=(body.description or "")[:500], duration_s=body.duration_s or 0.0,
        gps_latitude=body.gps_latitude or 0.0, gps_longitude=body.gps_longitude or 0.0,
        egnyte_status="skipped" if inline else "pending", tags=tags,
        location_text=(body.location_text or "").strip()[:200], source_media_id=source_media_id or "",
        task_id=task_id or "")
    db.add(m)
    if not inline:
        _queue(db, p.id, "egnyte_sync", mid, priority=30)
        if storage.can_thumbnail(kind, body.mime_type or ""):
            _queue(db, p.id, "derive_rendition", mid, priority=25)
    return m


@router.post("/projects/{job_id}/media", status_code=201)
def add_job_media(job_id: str, body: JobMediaBody, user: dict = Depends(get_current_user),
                  db: Session = Depends(get_db), idem: Idem = Depends(idempotency)):
    """A photo for the job's timeline (Add Photos), not tied to a daily log -
    or, with `log_id`, onto the caller's own draft log. The crew and the
    job's managers may add one."""
    hit = idem.replay(db, user)
    if hit is not None:
        return hit
    p = _project(db, job_id, user)
    if not _may_log(db, user, p):
        raise HTTPException(403, "You are not on this job.")
    if body.kind == "drawing":
        raise HTTPException(422, "Drawings go on the job's Drawings tab.")
    mid = (body.id or "").strip()
    if mid:
        if not _ID.match(mid):
            raise HTTPException(422, "A photo id is 8 to 64 letters, digits, '.', '_', ':' or '-'.")
        was = db.get(models.ConstructionMedia, mid)
        if was is not None:
            if was.project_id != p.id or (was.uploaded_by or "").lower() != _me(user):
                raise HTTPException(409, "That photo id is taken.")
            return media_to_dict(was)
    log = None
    if body.log_id:
        log = _get_log(db, body.log_id)
        if log.project_id != p.id or (log.author_email or "").lower() != _me(user):
            raise HTTPException(403, "You can only add photos to your own daily log.")
        if log.status not in ("draft", "needs_info"):
            raise HTTPException(409, "This log has been submitted; media can no longer be added.")
    m = make_media(db, user, p, body, log=log)
    db.flush()
    out = media_to_dict(m)
    idem.remember(db, user, out, 201)
    lost = idem.commit(db, user)
    return lost if lost is not None else out


class MetaBody(BaseModel):
    tags: Optional[list] = None
    location_text: Optional[str] = None
    caption: Optional[str] = None


@router.patch("/media/{media_id}/meta")
def update_media_meta(media_id: str, body: MetaBody, user: dict = Depends(get_current_user),
                      db: Session = Depends(get_db), idem: Idem = Depends(idempotency)):
    """A photo's tags, its spot in words and its caption - by whoever took it
    or a job reviewer. The file itself never changes (it is evidence)."""
    hit = idem.replay(db, user)
    if hit is not None:
        return hit
    m = db.query(models.ConstructionMedia).filter(models.ConstructionMedia.id == media_id,
                                                  models.ConstructionMedia.deleted_at == "").first()
    if m is None:
        raise HTTPException(404, "Photo not found")
    p = _project(db, m.project_id, user)
    if m.id not in {x.id for x in construction_field.visible_photos(db, user, p, kinds=("photo", "video"))}:
        raise HTTPException(404, "Photo not found")
    if (m.uploaded_by or "").lower() != _me(user) and not _may_review(db, user, p):
        raise HTTPException(403, "Only the person who took it or a job manager can change this photo.")
    data = body.model_dump(exclude_unset=True)
    if "tags" in data:
        m.tags = clean_tags(data["tags"])
    if data.get("location_text") is not None:
        m.location_text = data["location_text"].strip()[:200]
    if data.get("caption") is not None:
        m.caption = data["caption"].strip()[:500]
    db.flush()
    out = media_to_dict(m)
    idem.remember(db, user, out, 200)
    lost = idem.commit(db, user)
    return lost if lost is not None else out


class PairBody(BaseModel):
    id: Optional[str] = None
    before_media_id: str
    after_media_id: str
    caption: Optional[str] = ""


@router.post("/projects/{job_id}/pairs", status_code=201)
def make_pair(job_id: str, body: PairBody, user: dict = Depends(get_current_user),
              db: Session = Depends(get_db), idem: Idem = Depends(idempotency)):
    """Before and after: two of the job's photos the caller can see, before
    first (the earlier one unless they say otherwise)."""
    hit = idem.replay(db, user)
    if hit is not None:
        return hit
    p = _project(db, job_id, user)
    if not _may_log(db, user, p) and not _may_review(db, user, p):
        raise HTTPException(403, "You are not on this job.")
    if body.before_media_id == body.after_media_id:
        raise HTTPException(422, "Pick two different photos.")
    seen = {m.id: m for m in construction_field.visible_photos(db, user, p)}
    if body.before_media_id not in seen or body.after_media_id not in seen:
        raise HTTPException(422, "Pick two photos from this job.")
    PP = models.ConstructionPhotoPair
    pid = (body.id or "").strip()
    if pid:
        if not _ID.match(pid):
            raise HTTPException(422, "A pair id is 8 to 64 letters, digits, '.', '_', ':' or '-'.")
        was = db.get(PP, pid)
        if was is not None:
            if was.project_id != p.id:
                raise HTTPException(409, "That pair id is taken.")
            return _pair_dict(was)
    pr = PP(id=pid or str(uuid.uuid4()), project_id=p.id, before_media_id=body.before_media_id,
            after_media_id=body.after_media_id, caption=(body.caption or "").strip()[:300],
            created_by=_me(user), created_at=_now(), deleted_at="")
    db.add(pr)
    _log_activity(db, project_id=p.id, entity_kind="media", entity_id=pr.id, type="paired",
                  actor_email=_me(user), detail="made a before and after pair")
    db.flush()
    out = _pair_dict(pr)
    idem.remember(db, user, out, 201)
    lost = idem.commit(db, user)
    return lost if lost is not None else out


@router.delete("/pairs/{pair_id}", status_code=204)
def unpair(pair_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Take a pair apart (the photos stay). Its maker or a job reviewer; the
    row is kept, marked removed."""
    pr = db.get(models.ConstructionPhotoPair, pair_id)
    if pr is None or pr.deleted_at:
        raise HTTPException(404, "Pair not found")
    p = _project(db, pr.project_id, user)
    if (pr.created_by or "").lower() != _me(user) and not _may_review(db, user, p):
        raise HTTPException(403, "Only the person who made it or a job manager can take it apart.")
    pr.deleted_at = _now()
    db.commit()


class MarkupBody(BaseModel):
    id: Optional[str] = None
    url: str
    storage_path: Optional[str] = ""
    mime_type: Optional[str] = "image/png"
    size_bytes: Optional[int] = 0
    name: Optional[str] = ""


@router.post("/media/{media_id}/markup", status_code=201)
def attach_markup(media_id: str, body: MarkupBody, user: dict = Depends(get_current_user),
                  db: Session = Depends(get_db), idem: Idem = Depends(idempotency)):
    """"Attach to" from a Mark Up board (lib/markup.js, source kind
    'construction_media' - the ONE markup path): the board's PNG becomes a
    job photo beside the original (source_media_id, tag 'markup'). The
    original is never changed."""
    hit = idem.replay(db, user)
    if hit is not None:
        return hit
    src = db.query(models.ConstructionMedia).filter(models.ConstructionMedia.id == media_id,
                                                    models.ConstructionMedia.deleted_at == "").first()
    if src is None:
        raise HTTPException(404, "Photo not found")
    p = _project(db, src.project_id, user)
    if src.id not in {x.id for x in construction_field.visible_photos(db, user, p)}:
        raise HTTPException(404, "Photo not found")
    if not _may_log(db, user, p) and not _may_review(db, user, p):
        raise HTTPException(403, "You are not on this job.")
    m = make_media(db, user, p, JobMediaBody(
        id=body.id, kind="photo", url=body.url, storage_path=body.storage_path or "",
        mime_type=body.mime_type or "image/png", size_bytes=body.size_bytes or 0,
        description=(body.name or "Mark Up")[:200], location_text=src.location_text or ""),
        source_media_id=src.id, extra_tags=("markup",))
    _log_activity(db, project_id=p.id, entity_kind="media", entity_id=m.id, type="markup",
                  actor_email=_me(user), detail="attached a Mark Up of a photo")
    db.flush()
    out = media_to_dict(m)
    idem.remember(db, user, out, 201)
    lost = idem.commit(db, user)
    return lost if lost is not None else out


class PhotoReportBody(BaseModel):
    media_ids: list = []
    pair_ids: list = []
    title: Optional[str] = ""


@router.post("/projects/{job_id}/photo-report")
def photo_report(job_id: str, body: PhotoReportBody, user: dict = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    """The curated photo report: the photos and before / after pairs the
    caller picked, as a PDF through construction_pdf (the weekly report's
    letterhead and photo log). Only photos the caller can see print."""
    import construction_pdf
    p = _readable(db, job_id, user)
    seen = {m.id: m for m in construction_field.visible_photos(db, user, p)}
    picked = [seen[i] for i in body.media_ids if isinstance(i, str) and i in seen]
    PP = models.ConstructionPhotoPair
    pairs = []
    for pid in body.pair_ids or []:
        pr = db.get(PP, str(pid))
        if pr is not None and not pr.deleted_at and pr.project_id == p.id \
                and pr.before_media_id in seen and pr.after_media_id in seen:
            pairs.append((pr, seen[pr.before_media_id], seen[pr.after_media_id]))
    if not picked and not pairs:
        raise HTTPException(422, "Pick at least one photo or pair.")
    if len(picked) + 2 * len(pairs) > 120:
        raise HTTPException(422, "A photo report holds at most 120 photos.")
    names = construction_company.people_names(db, [m.uploaded_by for m in picked]
                                              + [x.uploaded_by for _, a, b in pairs for x in (a, b)])
    pdf = construction_pdf.build_photo_report(p, picked, pairs, title=(body.title or "").strip()[:150],
                                              names=names)
    _log_activity(db, project_id=p.id, entity_kind="project", entity_id=p.id, type="photo_report",
                  actor_email=_me(user), detail=f"{len(picked)} photo(s), {len(pairs)} pair(s)")
    db.commit()
    safe = re.sub(r"[^A-Za-z0-9 _-]+", "", p.name or "Job").strip() or "Job"
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{safe} Photo Report.pdf"'})
