"""Construction background sweep - files the Egnyte record copy.

Media uploads browser -> Supabase and the row lands with
egnyte_status='pending'. This drains that queue: pull the bytes back from
Supabase, file them into the project's Egnyte folder, record the deep link.

THREE THINGS THIS HAD TO GET RIGHT, none of them obvious:

1. `is_sync_worker()` does NOT elect a leader. It returns True for all 8
   gunicorn workers on the deployed instance - it only excludes laptops. So the
   loop runs 8 times over, and without cross-process exclusion every worker
   would claim the same rows and upload the same file 8 times. A Postgres
   advisory lock closes that, exactly as _acquire_pull_lock does for the Asana
   pull. The key is a DIFFERENT constant: sharing Asana's would make the two
   sweeps block each other for no reason.

2. Blocking I/O must not touch the event loop. httpx here is sync and an Egnyte
   upload can take a minute; run on the loop it would freeze every request the
   worker is serving, CORS preflights included. Hence asyncio.to_thread, per
   CLAUDE.md and the corrected task_notify_loop.

3. Egnyte errors are not all equal. `_raise` in services/egnyte.py preserves
   401/403/404/409 and maps everything else to 502. The first group is permanent
   for a sweep - a bad token or a missing folder will not fix itself by being
   retried 4 times - so those go straight to `dead` instead of burning attempts.
"""
import asyncio
import os
from datetime import date, datetime, timedelta, timezone

import httpx

import construction_ai
import models
from database import SessionLocal
from services import egnyte as egnyte_svc
from services import construction_storage as storage

# Distinct from asana_sync's 728100177 - see note 1 above.
_CONSTRUCTION_SWEEP_LOCK_KEY = 815224906

_LOOP_SEC = 60
_STARTUP_DELAY_SEC = 105   # a free slot: reminders 60, task_notify 75, timeclock 90
_BATCH = 20                # bounded so one tick cannot hold the lock for minutes
_DOWNLOAD_TIMEOUT = 120

# Egnyte statuses that will never succeed by being retried.
_PERMANENT = (401, 403, 404, 409)


def _acquire_sweep_lock(db) -> None:
    """Transaction-scoped, so a killed worker cannot leave it stuck locked.
    No-op on SQLite, where there is only one process."""
    if db.bind.dialect.name == "postgresql":
        from sqlalchemy import text
        db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _CONSTRUCTION_SWEEP_LOCK_KEY})


def _project_folder(db, project) -> str:
    """The Egnyte folder a project's media belongs under.

    Prefers the Asset module's existing property tree, so construction media
    lands beside the plans and permits people already keep there rather than in a
    parallel hierarchy. Falls back to a construction root when the project has no
    property - a jobsite without a Property row is still valid."""
    if project.property_id:
        prop = (db.query(models.Property).filter(models.Property.id == project.property_id).first()
                if hasattr(models, "Property") else None)
        name = getattr(prop, "name", "") if prop else ""
        if name:
            resolved = egnyte_svc.resolve_property_folder(name)
            if resolved:
                return resolved
    from egnyte_wiring import raw_value
    root = ((raw_value("construction.root") or "").strip()
            or os.getenv("EGNYTE_CONSTRUCTION_ROOT", "").strip()
            or egnyte_svc.create_root()
            or "/Shared")
    return egnyte_svc.norm(f"{root}/{project.name}")


def _file_one(db, media) -> None:
    """Upload one media row's bytes to Egnyte. Raises on failure; the caller
    decides retry vs dead."""
    project = (db.query(models.ConstructionProject)
               .filter(models.ConstructionProject.id == media.project_id).first())
    log = (db.query(models.ConstructionDailyLog)
           .filter(models.ConstructionDailyLog.id == media.daily_log_id).first())
    if not project or not log:
        raise ValueError("media has no project or daily log")
    if not media.url:
        raise ValueError("media has no source URL to fetch")
    # Nothing to file: the bytes are in the row, not behind a URL. register_media
    # already marks these 'skipped' so they never reach here, but a row created
    # before that did could still be sitting at 'pending'.
    if storage.is_inline(media.url):
        media.egnyte_status = "skipped"
        media.egnyte_error = "stored inline; no object to file"
        media.egnyte_synced_at = _now()
        return

    # The bytes live in Supabase. Pull them back rather than asking the phone to
    # upload twice - the worker has bandwidth, the jobsite does not.
    with httpx.Client(timeout=_DOWNLOAD_TIMEOUT) as c:
        resp = c.get(media.url)
        resp.raise_for_status()
        raw = resp.content
    if not raw:
        raise ValueError("source object is empty")

    folder = storage.daily_log_folder(_project_folder(db, project), log.log_date)
    name = storage.media_filename(
        uploaded_by=media.uploaded_by or "", taken_at=media.taken_at or "",
        uploaded_at=media.uploaded_at or "", kind=media.kind,
        mime_type=media.mime_type or "", description=media.description or "",
        original_name="", media_id=media.id)
    dest = egnyte_svc.norm(f"{folder}/{name}")

    # upload_file does not create missing parents; create_folder is idempotent
    # (403/405/409 are treated as "already exists"), so this is safe to call
    # unconditionally on every file.
    egnyte_svc.create_folder(folder)
    egnyte_svc.upload_file(dest, raw)

    media.egnyte_path = dest
    media.egnyte_web_url = egnyte_svc.web_url(dest)
    media.egnyte_status = "uploaded"
    media.egnyte_error = ""
    media.egnyte_synced_at = _now()


def _now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


# ── Supabase derivatives ─────────────────────────────────────────────────────
# The bucket the client uploads to (construction/lib/upload.js BUCKET).
_BUCKET = "construction-media"


def _supabase_ready() -> bool:
    return bool(os.getenv("SUPABASE_URL", "").strip()
                and os.getenv("SUPABASE_SERVICE_KEY", "").strip())


def _supabase_put(path: str, raw: bytes, content_type: str) -> str:
    """Upload one derivative and return its public URL.

    Raw httpx against the storage REST API, matching routers/hr.py and
    routers/esign.py - this codebase has no Supabase client dependency and
    adding one for a thumbnail would be a third way to do the same thing.

    `upsert: true` here, unlike the client's upload: a rebuild sweep must be able
    to overwrite a thumbnail derived from a since-replaced rendition, and unlike
    the record copy a thumbnail is disposable by definition."""
    base = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_KEY", "").strip()
    with httpx.Client(timeout=60) as c:
        r = c.post(f"{base}/storage/v1/object/{_BUCKET}/{path}", content=raw, headers={
            "Authorization": f"Bearer {key}", "apikey": key,
            "Content-Type": content_type, "x-upsert": "true",
            "cache-control": "31536000",   # the key is id-derived, so immutable
        })
    if r.status_code >= 400:
        raise RuntimeError(f"Supabase {r.status_code}: {r.text[:200]}")
    return f"{base}/storage/v1/object/public/{_BUCKET}/{path}"


def _derive_thumbnail(db, media) -> None:
    """Build the grid-sized rendition for one photo.

    Why this is a job and not part of the upload: the phone already spent its
    budget pushing the original over jobsite LTE, and asking it to encode and
    upload a second image doubles the slowest part of the worker's two minutes.
    The server has the bytes and the bandwidth.

    Failure is not fatal to anything. `thumbnail_url` staying empty means the
    grid falls back to the full rendition - slower, but every photo still
    shows."""
    from io import BytesIO
    from PIL import Image, ImageOps

    if not media.url:
        raise ValueError("media has no source URL to fetch")
    # An inline row is already small (capped at 2 MB client-side) and there is
    # nowhere to put a derivative anyway - the thumbnail would need a Supabase
    # bucket, which is precisely what is absent when a row ends up inline.
    if storage.is_inline(media.url):
        return
    with httpx.Client(timeout=_DOWNLOAD_TIMEOUT) as c:
        resp = c.get(media.url)
        resp.raise_for_status()
        raw = resp.content

    img = Image.open(BytesIO(raw))
    # A phone photo carries an EXIF orientation flag rather than rotated pixels.
    # Without this the thumbnail of a portrait shot comes out on its side while
    # the full rendition looks right, which reads as a bug in the grid.
    img = ImageOps.exif_transpose(img)
    # Flatten alpha and drop palettes: JPEG has neither, and Pillow raises rather
    # than guessing. PNG screenshots off a site tablet hit this constantly.
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    img.thumbnail((storage.THUMBNAIL_MAX_PX, storage.THUMBNAIL_MAX_PX), Image.LANCZOS)

    buf = BytesIO()
    img.save(buf, format="JPEG", quality=storage.THUMBNAIL_QUALITY, optimize=True)

    path = storage.thumbnail_path(media.storage_path or "")
    media.thumbnail_url = _supabase_put(path, buf.getvalue(), "image/jpeg")


def sweep_once() -> dict:
    """One tick. Synchronous by design - the caller runs it in a thread."""
    counts = {"filed": 0, "failed": 0, "dead": 0, "skipped": 0}
    if not storage.egnyte_ready():
        # Unconfigured is a first-class state, not an error: rows stay pending
        # and file themselves once EGNYTE_DOMAIN/EGNYTE_TOKEN exist. Failing them
        # would lose the record copy for an operator problem.
        counts["skipped"] = 1
        return counts

    db = SessionLocal()
    try:
        _acquire_sweep_lock(db)
        rows = (db.query(models.ConstructionMedia)
                .filter(models.ConstructionMedia.egnyte_status == "pending",
                        models.ConstructionMedia.deleted_at == "")
                .order_by(models.ConstructionMedia.uploaded_at)
                .limit(_BATCH).all())
        for m in rows:
            job = (db.query(models.ConstructionAIJob)
                   .filter(models.ConstructionAIJob.kind == "egnyte_sync",
                           models.ConstructionAIJob.subject_id == m.id).first())
            attempts = (job.attempts if job else 0) + 1
            max_attempts = (job.max_attempts if job else 4)
            try:
                _file_one(db, m)
                if job:
                    job.status, job.finished_at, job.attempts = "done", _now(), attempts
                counts["filed"] += 1
            except Exception as e:
                status = getattr(e, "status", None)
                permanent = status in _PERMANENT
                m.egnyte_error = str(e)[:500]
                if permanent or attempts >= max_attempts:
                    m.egnyte_status = "failed"
                    if job:
                        job.status, job.error, job.finished_at = "dead", m.egnyte_error, _now()
                    counts["dead"] += 1
                else:
                    # Left 'pending' so the next tick picks it up again.
                    counts["failed"] += 1
                if job:
                    job.attempts, job.heartbeat_at = attempts, _now()
            db.commit()
    except Exception as e:
        db.rollback()
        print(f"[construction] sweep failed: {e}")
    finally:
        db.close()
    return counts


def _run_ai_job(db, job) -> None:
    """Execute one AI job. Raises on failure; the caller decides retry vs dead."""
    if job.kind == "derive_rendition":
        m = (db.query(models.ConstructionMedia)
             .filter(models.ConstructionMedia.id == job.subject_id).first())
        if not m or m.deleted_at:
            return
        if not storage.can_thumbnail(m.kind, m.mime_type or ""):
            return   # not an error - see THUMBNAILABLE_MIME
        _derive_thumbnail(db, m)
        return

    if job.kind == "media_caption":
        m = (db.query(models.ConstructionMedia)
             .filter(models.ConstructionMedia.id == job.subject_id).first())
        if not m or m.deleted_at:
            return
        # An inline row has no URL the API can fetch - the bytes ARE the url.
        # Decode and send them as a base64 image block instead; _image_block
        # already takes that path when given raw bytes. Without this, captioning
        # an inline photo posts a multi-kilobyte data: URL as a URL source and
        # gets a 400 four times over.
        raw = None
        if storage.is_inline(m.url or ""):
            import base64
            try:
                raw = base64.b64decode((m.url.split(",", 1) + [""])[1])
            except Exception as e:
                raise ValueError(f"inline media is not decodable base64: {e}")
        out = construction_ai.caption_photo(
            url=m.url, mime_type=m.mime_type or "", raw=raw,
            worker_note=m.description or "")
        m.ai_caption = (out.get("caption") or "")[:500]
        m.ai_tags = out.get("tags") or []
        m.ai_safety = out.get("safety") or []
        m.ai_model = construction_ai._MODEL
        m.ai_processed_at = _now()
        m.ai_error = ""
        # Seeded, not forced: `caption` is what the report prints and a manager
        # edits, so only fill it when nobody has written one.
        if not (m.caption or "").strip():
            m.caption = m.ai_caption
        # The flattened haystack keyword search reads.
        m.search_text = " ".join(filter(None, [
            m.description or "", m.caption or "", m.ai_caption or "",
            " ".join(m.ai_tags or []), m.ai_ocr_text or "", m.transcript or ""]))[:4000]
        return

    if job.kind == "log_summarize":
        l = (db.query(models.ConstructionDailyLog)
             .filter(models.ConstructionDailyLog.id == job.subject_id).first())
        if not l or l.deleted_at:
            return
        project = (db.query(models.ConstructionProject)
                   .filter(models.ConstructionProject.id == l.project_id).first())
        media = (db.query(models.ConstructionMedia)
                 .filter(models.ConstructionMedia.daily_log_id == l.id,
                         models.ConstructionMedia.deleted_at == "").all())
        out = construction_ai.summarize_log(
            project_name=getattr(project, "name", "") or "",
            log_date=l.log_date, notes=l.notes_raw or "",
            weather=l.weather or "", crew_size=l.crew_size or 0,
            hours=l.hours_worked or 0.0,
            captions=[m.ai_caption or m.description for m in media
                      if (m.ai_caption or m.description)],
            transcripts=[m.transcript for m in media if (m.transcript or "").strip()])
        l.ai_summary = out.get("summary") or ""
        l.ai_work_completed = out.get("work_completed") or []
        l.ai_categories = out.get("categories") or []
        l.ai_safety_flags = out.get("safety_flags") or []
        l.ai_delay_flags = out.get("delay_flags") or []
        l.ai_action_items = out.get("action_items") or []
        l.ai_next_work = out.get("next_work") or []
        l.ai_confidence = float(out.get("confidence") or 0.0)
        l.ai_model = construction_ai._MODEL
        l.ai_processed_at = _now()
        l.ai_error = ""
        # Only now is the log ready to roll into a weekly report. A manager who
        # opens it before this sees the worker's raw words, not a blank.
        if l.status == "submitted":
            l.status = "processed"
        return

    raise ValueError(f"unknown job kind {job.kind!r}")


def run_ai_jobs_once() -> dict:
    """Drain queued AI jobs whose dependencies are done.

    `depends_on` is a hard gate, not a hint: a voice note's transcript is an
    INPUT to its log's summary, so summarizing before transcription finishes
    would produce a summary that silently ignores what the worker said."""
    counts = {"done": 0, "failed": 0, "dead": 0, "skipped": 0, "blocked": 0}
    # Two independent integrations, so two independent gates. Running thumbnails
    # only when the Anthropic key happens to be set would make the grid's
    # performance depend on a setting that has nothing to do with it.
    kinds = []
    if construction_ai.configured():
        kinds += ["media_caption", "log_summarize"]
    if _supabase_ready():
        kinds.append("derive_rendition")
    if not kinds:
        counts["skipped"] = 1
        return counts

    db = SessionLocal()
    try:
        _acquire_sweep_lock(db)
        jobs = (db.query(models.ConstructionAIJob)
                .filter(models.ConstructionAIJob.status == "queued",
                        models.ConstructionAIJob.kind.in_(kinds))
                .order_by(models.ConstructionAIJob.priority,
                          models.ConstructionAIJob.queued_at)
                .limit(_BATCH).all())
        for job in jobs:
            deps = [d for d in (job.depends_on or []) if d]
            if deps:
                unfinished = (db.query(models.ConstructionAIJob)
                              .filter(models.ConstructionAIJob.id.in_(deps),
                                      models.ConstructionAIJob.status.in_(("queued", "running")))
                              .count())
                if unfinished:
                    counts["blocked"] += 1
                    continue
            job.status, job.started_at, job.heartbeat_at = "running", _now(), _now()
            job.attempts = (job.attempts or 0) + 1
            db.commit()
            try:
                _run_ai_job(db, job)
                job.status, job.finished_at, job.error = "done", _now(), ""
                # Only the kinds that actually called a model. Stamping one on a
                # thumbnail would make per-project cost attribution read as if
                # image resizing spent tokens.
                if job.kind in ("media_caption", "log_summarize"):
                    job.model = construction_ai._MODEL
                counts["done"] += 1
            except Exception as e:
                job.error = str(e)[:500]
                if job.attempts >= (job.max_attempts or 4):
                    job.status, job.finished_at = "dead", _now()
                    counts["dead"] += 1
                else:
                    job.status = "queued"      # next tick retries
                    counts["failed"] += 1
            db.commit()
    except Exception as e:
        db.rollback()
        print(f"[construction] AI sweep failed: {e}")
    finally:
        db.close()
    return counts


# ── Weekly draft scheduler ───────────────────────────────────────────────────
# `report_day` and `week_starts_on` have been on ConstructionProject since the
# module was written, documented as "the weekday the draft is cut" - and nothing
# cut anything. A manager had to remember to press Generate, which is the manual
# step the module exists to delete.


def _model_weekday(d: date) -> int:
    """ConstructionProject counts 0=Sunday..6=Saturday; Python counts
    Monday=0..Sunday=6. Getting this backwards would cut every draft on the
    wrong day, quietly."""
    return (d.weekday() + 1) % 7


def week_start_for(d: date, week_starts_on: int) -> date:
    """The start of the week `d` falls in, for a project whose week begins on
    `week_starts_on`. Crews run Sun-Sat or Mon-Sun depending on the payroll week
    the superintendent already thinks in, so this is per project, not global."""
    back = (_model_weekday(d) - (week_starts_on or 0)) % 7
    return d - timedelta(days=back)


def cut_due_drafts(today: date = None) -> dict:
    """Draft this week's report for every project whose report day is today.

    The draft covers the week IN PROGRESS - a Friday cut on a Mon-Sun project
    reports Monday through today, so the manager edits over the weekend while
    the week is still fresh. Waiting for the week to close would put the report
    a full week behind the site.

    Idempotent by existence, not by a timestamp: a project that already has a
    report row for this week_start is skipped. That is what makes a restart, a
    second tick in the same minute, or a manager who drafted it early all safe,
    with no extra state to keep correct."""
    counts = {"cut": 0, "skipped": 0, "failed": 0}
    today = today or datetime.now(timezone.utc).date()
    db = SessionLocal()
    try:
        _acquire_sweep_lock(db)   # same lock as the sweep: one worker cuts drafts
        projects = (db.query(models.ConstructionProject)
                    .filter(models.ConstructionProject.status == "active",
                            models.ConstructionProject.archived == False,  # noqa: E712
                            models.ConstructionProject.deleted_at == "").all())
        for p in projects:
            if _model_weekday(today) != (p.report_day if p.report_day is not None else 5):
                continue
            ws = week_start_for(today, p.week_starts_on or 0).isoformat()
            existing = (db.query(models.ConstructionWeeklyReport)
                        .filter(models.ConstructionWeeklyReport.project_id == p.id,
                                models.ConstructionWeeklyReport.week_start == ws,
                                models.ConstructionWeeklyReport.deleted_at == "").first())
            if existing:
                counts["skipped"] += 1
                continue
            try:
                import construction_notify
                import construction_report
                # The same generator the Generate button calls. A second drafting
                # path would drift from it - the mistake CLAUDE.md records
                # against the Asana sync's two inbound paths.
                r = construction_report.generate(db, p, ws, "system")
                construction_notify.draft_cut(db, p, r)
                db.commit()
                counts["cut"] += 1
            except Exception as e:
                db.rollback()
                # A model outage must not stop the next project being drafted,
                # and must not mark this week done - tomorrow is a different
                # weekday, so this project simply waits for next week unless a
                # manager drafts it by hand. Loud, because that is a real gap.
                print(f"[construction] draft failed for {p.name} week {ws}: {e}")
                counts["failed"] += 1
    except Exception as e:
        db.rollback()
        print(f"[construction] draft scheduler failed: {e}")
    finally:
        db.close()
    return counts


async def construction_sweep_loop() -> None:
    """Started from main.py's lifespan, gated on is_sync_worker().

    The try wraps only the to_thread call, never the sleep, so a bad tick can
    never kill the loop - same shape as reminders_loop / task_notify_loop."""
    await asyncio.sleep(_STARTUP_DELAY_SEC)
    last_draft_day = ""
    while True:
        try:
            await asyncio.to_thread(sweep_once)
            await asyncio.to_thread(run_ai_jobs_once)
            # Once a day, not every minute: the work is a model call per project
            # and the existence check would otherwise re-run 1440 times to do
            # nothing. The date string is the guard, so a restart re-checks today
            # exactly once more - which the existence check absorbs.
            today = datetime.now(timezone.utc).date().isoformat()
            if today != last_draft_day:
                await asyncio.to_thread(cut_due_drafts)
                last_draft_day = today
        except Exception as e:
            print(f"[construction] sweep loop error: {e}")
        await asyncio.sleep(_LOOP_SEC)
