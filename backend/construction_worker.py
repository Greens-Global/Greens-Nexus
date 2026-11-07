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
from datetime import date, datetime, timezone

import httpx
from sqlalchemy.exc import IntegrityError

import construction_ai
import models
from database import SessionLocal
from services import egnyte as egnyte_svc
from services import construction_storage as storage
import job_switch

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


def _try_sweep_lock(db) -> bool:
    """The same lock, without waiting: False while another worker holds it,
    and that worker is draining the same queue, so this tick has nothing to do.
    Every worker runs the loop; with the blocking form the other workers each
    sat in pg_advisory_xact_lock for as long as the holder's Egnyte uploads
    took (dev, 11/05/2026: 786k waits, mean 613 ms, longest 120 s), each wait
    pinning a pooled connection - and, on the transaction pooler, one of the
    few server connections every API request needs. True on SQLite."""
    if db.bind.dialect.name != "postgresql":
        return True
    from sqlalchemy import text
    return bool(db.execute(text("SELECT pg_try_advisory_xact_lock(:k)"),
                           {"k": _CONSTRUCTION_SWEEP_LOCK_KEY}).scalar())


# One answer per property (and one job folder per job) per sweep tick: a
# batch of 20 photos from one job must not list the Egnyte roots 20 times -
# nor, while Egnyte is down, fail 20 times over by re-listing them (a lookup
# that raised is remembered and raised again). Cleared at the start of every
# tick (sweep_once), so a folder made or renamed in Egnyte is seen a minute
# later.
_FOLDER_MEMO: dict = {}


def _construction_root() -> str:
    """Where a job with no property files (the `construction.root` wiring)."""
    from egnyte_wiring import raw_value
    return ((raw_value("construction.root") or "").strip()
            or os.getenv("EGNYTE_CONSTRUCTION_ROOT", "").strip()
            or egnyte_svc.create_root()
            or "/Shared")


def _root_folder(project) -> str:
    """`<construction root>/<job name>` - the base every file used before
    11/03/2026, and still the base for a job with no property."""
    return egnyte_svc.norm(f"{_construction_root()}/{project.name}")


class PinnedFolderMissing(RuntimeError):
    """The job's property has a PINNED Egnyte folder that Egnyte says is not
    there. Never a name guess and never the construction root: the row is
    HELD (sweep_once) until the folder is back or the pin changes."""


def pinned_folder(prop) -> str:
    """The Egnyte folder pinned on an Asset Management asset (its
    `egnyteFolder`, set on the asset's Details, checked by the row save) -
    '' when none is."""
    raw = str(((getattr(prop, "payload", None) or {}) if prop is not None else {}).get("egnyteFolder") or "").strip()
    return egnyte_svc.norm(raw) if raw else ""


# The answers that HOLD a file instead of filing it: a folder was pinned, so
# neither a name match nor the construction root may stand in for it.
_HOLD_REASONS = ("pinned_missing", "pinned_invalid")


def _pin_ok(path: str) -> bool:
    try:
        return bool(egnyte_svc.normalize_pinned_folder(path))
    except ValueError:
        return False


def property_folder(db, project, memo: dict | None = None) -> tuple[str, str]:
    """(the property's Egnyte folder, why) for a job attached to a property.

    Where the folder comes from (Neil, 11/03/2026: a property may pin its
    exact folder instead of matching by name):
      1. the folder PINNED on the Asset Management asset (`egnyteFolder`),
         when one is - why 'pinned' while Egnyte lists it. A pinned folder
         Egnyte answers 404 for is 'pinned_missing' with no folder, and it
         never falls back to a name match: someone chose that folder, so a
         file never lands in a guessed place (media_folder refuses to file);
      2. else the one the Egnyte module finds over the `property.roots`
         wiring (#Entities, then --Asset Management) by the Asset
         Management property's name - through
         `services/egnyte.find_property_folder`, the UNATTENDED form of the
         resolver: an exact or site-key match, or a substring match only
         when it is the one candidate across every root. It only ever
         answers a folder that EXISTS; it never makes one up.

    `why` is 'pinned' or 'matched' with a folder, else the reason it is '' -
    'no_property', 'property_missing', 'property_unnamed', 'pinned_missing',
    'pinned_invalid' (a pin outside the roots), 'ambiguous' or
    'no_egnyte_folder' - and, except for the two pinned ones (_HOLD_REASONS),
    the file goes to the construction root (today's behavior), logged.
    Egnyte not answering raises (and keeps raising for the rest of the
    tick), so the row is retried rather than filed at the root for good.

    (Until 11/03/2026 this read `models.Property`, which does not exist, so
    every file went to the construction root.)"""
    pid = (getattr(project, "property_id", "") or "").strip()
    if not pid:
        return "", "no_property"
    memo = _FOLDER_MEMO if memo is None else memo
    key = ("property", pid)
    if key in memo:
        got = memo[key]
        if isinstance(got, Exception):
            raise got
        return got
    prop = db.get(models.PropertyAsset, pid)
    name = (getattr(prop, "name", "") or "").strip() if prop else ""
    pinned = pinned_folder(prop)
    if prop is None:
        out = ("", "property_missing")
    elif pinned and not _pin_ok(pinned):
        out = ("", "pinned_invalid")   # saved before the roots moved, or seeded - still never a guess
    elif pinned:
        try:
            out = (pinned, "pinned") if egnyte_svc.folder_exists(pinned) else ("", "pinned_missing")
        except Exception as e:
            memo[key] = e
            raise
    elif not name:
        out = ("", "property_unnamed")
    else:
        try:
            found, why = egnyte_svc.find_property_folder(name)
        except Exception as e:
            memo[key] = e
            raise
        out = ((egnyte_svc.norm(found), "matched") if found
               else ("", "ambiguous" if why == "ambiguous" else "no_egnyte_folder"))
    memo[key] = out
    return out


def job_folder_name(db, project, prop_folder: str, memo: dict | None = None) -> str:
    """The job's folder inside `<property folder>/Construction/`.

    Built from the job code (else the first 8 of its id) and its name -
    `GSVC-2026-04 - Phase 2 Canopy`. Once a file of the job has been filed
    there, that folder is reused for good, so renaming the job (or giving it
    a code later) never splits its files across two folders."""
    memo = _FOLDER_MEMO if memo is None else memo
    key = ("job", project.id, prop_folder.lower())
    if key in memo:
        return memo[key]
    prefix = f"{prop_folder}/{storage.PROPERTY_SUBFOLDER}/"
    filed = (db.query(models.ConstructionMedia.egnyte_path)
             .filter(models.ConstructionMedia.project_id == project.id,
                     models.ConstructionMedia.egnyte_status == "uploaded",
                     models.ConstructionMedia.egnyte_path.startswith(prefix, autoescape=True))
             .order_by(models.ConstructionMedia.egnyte_synced_at).first())
    seg = ""
    if filed and filed[0]:
        seg = filed[0][len(prefix):].split("/", 1)[0]
    if not seg:
        seg = storage.job_segment(project.name, getattr(project, "code", "") or "", project.id)
    memo[key] = seg
    return seg


def media_folder(db, project, day: str, memo: dict | None = None) -> str:
    """The Egnyte folder one media row of `project`, taken on `day`, files in.

    A job with a property: `<property folder>/Construction/<job>/Daily Logs/
    YYYY-MM/YYYY-MM-DD` (Neil, 11/03/2026). Without one, or when the
    property's folder cannot be found: `<construction root>/<job name>/
    Construction/Daily Logs/YYYY-MM/YYYY-MM-DD`, as every file has gone
    since August. A property whose PINNED folder is missing raises
    PinnedFolderMissing - nothing is filed anywhere for it."""
    folder, why = property_folder(db, project, memo)
    if folder:
        return storage.property_job_log_folder(folder, job_folder_name(db, project, folder, memo), day)
    if why in _HOLD_REASONS:
        prop = db.get(models.PropertyAsset, project.property_id)
        raise PinnedFolderMissing(
            f"The property's pinned Egnyte folder {pinned_folder(prop)} "
            + ("is not in Egnyte" if why == "pinned_missing" else "is not inside the property folder roots")
            + " - waiting for it to be back or for a new folder to be pinned on the asset")
    if why != "no_property":
        print(f"[construction] job {project.id} ({project.name}): property "
              f"{project.property_id} has no Egnyte folder ({why}) - filing at the construction root")
    return storage.daily_log_folder(_root_folder(project), day)


def _media_day(db, media) -> str:
    """The jobsite day a media row files under: its daily log's date, else (a
    job photo with no log - the photo timeline, a punch Done photo, an
    attached Mark Up; 11/03/2026) the day it was taken."""
    log = (db.query(models.ConstructionDailyLog)
           .filter(models.ConstructionDailyLog.id == media.daily_log_id).first()) if media.daily_log_id else None
    if media.daily_log_id and not log:
        return ""
    return log.log_date if log else ((media.taken_at or media.uploaded_at or "")[:10])


def _file_one(db, media) -> None:
    """Upload one media row's bytes to Egnyte. Raises on failure; the caller
    decides retry vs dead."""
    project = (db.query(models.ConstructionProject)
               .filter(models.ConstructionProject.id == media.project_id).first())
    day = _media_day(db, media)
    if not project or not day:
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

    # Where it goes first: a property whose pinned folder is missing holds the
    # file (PinnedFolderMissing) before any bytes are pulled.
    folder = media_folder(db, project, day)
    if media.kind == "drawing":   # a sheet files with the job's set, not under a day (Round Two item 9)
        folder = folder.rsplit("/Daily Logs/", 1)[0] + "/Drawings"

    # The bytes live in Supabase. Pull them back rather than asking the phone to
    # upload twice - the worker has bandwidth, the jobsite does not.
    # storage.fetch_url refuses anything that is not this job's own object in
    # construction-media (11/03/2026): the link came from a browser.
    src = storage.fetch_url(media)
    with httpx.Client(timeout=_DOWNLOAD_TIMEOUT) as c:
        resp = c.get(src)   # private bucket: signed URL
        resp.raise_for_status()
        raw = resp.content
    if not raw:
        raise ValueError("source object is empty")

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


# ── Files filed at the root before 11/03/2026 (read only) ──────────────────
# How the property's folder was found, in the report's words.
_SOURCE_WORDS = {"pinned": "Pinned", "matched": "Matched by Name"}

_REASON_WORDS = {
    "property_missing": "The job's property is not in Asset Management.",
    "property_unnamed": "The job's property has no name to find its folder by.",
    "no_egnyte_folder": "No Egnyte folder was found for the property.",
    "ambiguous": "More than one Egnyte folder could be the property's - none was picked.",
    "pinned_missing": "The Egnyte folder pinned on the property is not in Egnyte - its files wait, nothing is filed by name.",
    "pinned_invalid": "The Egnyte folder pinned on the property is outside the property folder roots - its files wait.",
    "egnyte_unreachable": "Egnyte did not answer while looking for the property's folder.",
    "egnyte_not_connected": "Egnyte is not connected on this server.",
}


def root_filed_report(db, projects, user: dict, limit: int = 2000) -> dict:
    """Which construction files already in Egnyte sit outside their property's
    folder, and where the sweep would file each one today.

    READ ONLY (Neil, 11/03/2026): nothing is moved, copied or deleted - the
    list is for Neil to decide on a move later. Every live job with a
    property is looked at; a job without one belongs at the construction
    root and is not listed. A file already under `<property folder>/
    Construction/` is where it belongs and is not listed either. A file that
    went to the root because its property's folder cannot be found (no
    match, more than one candidate, a renamed folder) is listed with an
    empty destination and the reason - those are the ones the sweep is
    STILL filing at the root. Each destination says how the property's
    folder was found (`folderSource`: Pinned or Matched by Name); a pinned
    folder that is missing gives no destination and its reason, and `held`
    counts the files waiting on one.

    Left out: deleted jobs and deleted media, and media on a draft log the
    caller did not write (a draft is private to its author). A PRIVATE
    Asset Management property's name and folder are blanked unless the
    caller may see private assets (property_links.viewable).

    Lists Egnyte (once per property) - call it from a thread or a sync route,
    never on the event loop."""
    import property_links
    me = ((user or {}).get("email") or "").strip().lower()
    memo: dict = {}
    ready = storage.egnyte_ready()
    rows, total, held = [], 0, 0
    for p in projects:
        if not (p.property_id or "").strip() or p.deleted_at:
            continue
        folder, why = "", "egnyte_not_connected"
        if ready:
            try:
                folder, why = property_folder(db, p, memo)
            except Exception as e:   # Egnyte did not answer
                print(f"[construction] root-filed report: property {p.property_id}: {e}")
                folder, why = "", "egnyte_unreachable"
        prop = db.get(models.PropertyAsset, p.property_id)
        shown = prop is None or property_links.viewable(prop, user)
        drafts = {lid for (lid, author) in
                  db.query(models.ConstructionDailyLog.id, models.ConstructionDailyLog.author_email)
                  .filter(models.ConstructionDailyLog.project_id == p.id,
                          models.ConstructionDailyLog.status == "draft").all()
                  if (author or "").strip().lower() != me}
        media = (db.query(models.ConstructionMedia)
                 .filter(models.ConstructionMedia.project_id == p.id,
                         models.ConstructionMedia.deleted_at == "",
                         models.ConstructionMedia.egnyte_status == "uploaded",
                         models.ConstructionMedia.egnyte_path != "")
                 .order_by(models.ConstructionMedia.uploaded_at).all())
        home = f"{folder}/{storage.PROPERTY_SUBFOLDER}/".lower() if folder else ""
        for m in media:
            if m.daily_log_id and m.daily_log_id in drafts:
                continue
            current = egnyte_svc.norm(m.egnyte_path or "")
            if home and current.lower().startswith(home):
                continue
            total += 1
            if len(rows) >= limit:
                continue
            dest_folder = ""
            if folder and shown:
                day = _media_day(db, m)
                try:
                    dest_folder = media_folder(db, p, day, memo) if day else ""
                except ValueError:
                    dest_folder = ""
            name = current.rsplit("/", 1)[-1]
            rows.append({
                "mediaId": m.id, "kind": m.kind or "",
                "jobId": p.id, "jobName": p.name or "", "jobCode": p.code or "",
                "propertyId": p.property_id,
                "propertyName": (getattr(prop, "name", "") or "") if prop and shown else "",
                "currentPath": current, "currentUrl": m.egnyte_web_url or "",
                "filedAt": m.egnyte_synced_at or "",
                "destinationFolder": dest_folder,
                "destinationPath": f"{dest_folder}/{name}" if dest_folder and name else "",
                "reason": "" if folder or not shown else _REASON_WORDS.get(why, why),
                # 'Pinned' (the asset's own Egnyte Folder) or 'Matched by Name'.
                "folderSource": _SOURCE_WORDS.get(why, "") if folder and shown else "",
            })
        held += (db.query(models.ConstructionMedia)
                 .filter(models.ConstructionMedia.project_id == p.id,
                         models.ConstructionMedia.deleted_at == "",
                         models.ConstructionMedia.egnyte_status == "held").count())
    return {"rows": rows, "total": total, "truncated": total > len(rows),
            # Files not yet in Egnyte at all: waiting on a missing pinned folder.
            "held": held,
            "egnyteConfigured": ready,
            "note": "Read only - nothing has been moved, copied or deleted."}


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
    # The thumbnail is written beside its own validated object, never at a
    # path a client chose (11/03/2026).
    if not storage.path_ok(media.storage_path or "", media.project_id or ""):
        raise ValueError("media has no valid storage path for a thumbnail")
    src = storage.fetch_url(media)
    with httpx.Client(timeout=_DOWNLOAD_TIMEOUT) as c:
        resp = c.get(src)   # private bucket: signed URL
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
    if not storage.path_ok(path, media.project_id or ""):
        raise ValueError("thumbnail path is outside the job's folder")
    media.thumbnail_url = _supabase_put(path, buf.getvalue(), "image/jpeg")


def _release_held(db) -> int:
    """Rows HELD because their property's pinned Egnyte folder was missing
    (or outside the roots) go back to the queue once property_folder answers
    anything else - the folder is back, the pin changed, or it was cleared
    (then the name match decides, as for any property). One answer per
    property per tick (the memo); Egnyte not answering leaves them held for
    the next tick. Held rows are out of the pending queue, so a property
    waiting on its folder never blocks another job's files."""
    held = (db.query(models.ConstructionMedia.project_id)
            .filter(models.ConstructionMedia.egnyte_status == "held",
                    models.ConstructionMedia.deleted_at == "")
            .distinct().all())
    released = 0
    for (pid,) in held:
        project = (db.query(models.ConstructionProject)
                   .filter(models.ConstructionProject.id == pid).first())
        if project is None:
            continue
        try:
            _folder, why = property_folder(db, project)
        except Exception as e:
            print(f"[construction] held files of job {pid}: Egnyte did not answer ({e}) - still held")
            continue
        if why in _HOLD_REASONS:
            continue
        released += (db.query(models.ConstructionMedia)
                     .filter(models.ConstructionMedia.project_id == pid,
                             models.ConstructionMedia.egnyte_status == "held")
                     .update({models.ConstructionMedia.egnyte_status: "pending",
                              models.ConstructionMedia.egnyte_error: ""},
                             synchronize_session=False))
    return released


def sweep_once() -> dict:
    """One tick. Synchronous by design - the caller runs it in a thread."""
    if job_switch.off("construction_sweep"):   # Workflows > Automations switch
        return {"filed": 0, "failed": 0, "dead": 0, "skipped": 0, "held": 0, "released": 0}
    counts = {"filed": 0, "failed": 0, "dead": 0, "skipped": 0, "held": 0, "released": 0}
    if not storage.egnyte_ready():
        # Unconfigured is a first-class state, not an error: rows stay pending
        # and file themselves once EGNYTE_DOMAIN/EGNYTE_TOKEN exist. Failing them
        # would lose the record copy for an operator problem.
        counts["skipped"] = 1
        return counts

    _FOLDER_MEMO.clear()   # each tick sees Egnyte as it is now
    db = SessionLocal()
    try:
        if not _try_sweep_lock(db):
            counts["skipped"] = 1   # another worker is on this tick
            return counts
        # Inside the lock's transaction; committed with the rows below.
        counts["released"] = _release_held(db)
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
            except PinnedFolderMissing as e:
                # Not an attempt: nothing is wrong with the file. It waits,
                # out of the queue, until _release_held sees the pinned
                # folder back or the pin changed.
                m.egnyte_status = "held"
                m.egnyte_error = str(e)[:500]
                counts["held"] += 1
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
        db.commit()   # the releases, when no row was swept
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
        # The model fetches the URL itself, so it gets a signed one: the
        # bucket is private and the canonical URL answers it with an error.
        out = construction_ai.caption_photo(
            url=m.url if raw is not None else storage.fetch_url(m),
            mime_type=m.mime_type or "", raw=raw,
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


AI_KINDS = ("media_caption", "log_summarize")


def skip_ai_jobs(db=None) -> int:
    """Mark every queued AI job skipped - for when AI is off, so they can
    never run (ai_switch). Never deletes: the rows stay as the history of what
    was asked. A log a summary job was holding at 'submitted' is already
    ready for review (submitted IS ready). Returns how many. Commits."""
    own = db is None
    db = db or SessionLocal()
    try:
        rows = (db.query(models.ConstructionAIJob)
                .filter(models.ConstructionAIJob.status == "queued",
                        models.ConstructionAIJob.kind.in_(AI_KINDS)).all())
        for j in rows:
            j.status, j.finished_at = "skipped", _now()
            j.error = "AI is off on this server - nothing to run."
        if rows:
            db.commit()
        return len(rows)
    except Exception as e:
        db.rollback()
        print(f"[construction] skipping AI jobs failed: {e}")
        return 0
    finally:
        if own:
            db.close()


def run_ai_jobs_once() -> dict:
    """Drain queued AI jobs whose dependencies are done.

    `depends_on` is a hard gate, not a hint: a voice note's transcript is an
    INPUT to its log's summary, so summarizing before transcription finishes
    would produce a summary that silently ignores what the worker said."""
    if job_switch.off("construction_ai"):   # Workflows > Automations switch
        return {"done": 0, "failed": 0, "dead": 0, "skipped": 0, "blocked": 0}
    counts = {"done": 0, "failed": 0, "dead": 0, "skipped": 0, "blocked": 0}
    # AI off (ai_switch): the AI kinds can never run, so they are marked
    # skipped instead of sitting at 'queued' forever (11/03/2026).
    if not construction_ai.configured():
        counts["skipped"] += skip_ai_jobs()
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
        if not _try_sweep_lock(db):
            counts["skipped"] += 1   # another worker is on this tick
            return counts
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
    import construction_company
    return construction_company.model_weekday(d)


def week_start_for(d: date, week_starts_on: int) -> date:
    """The start of the week `d` falls in, for a project whose week begins on
    `week_starts_on`. Crews run Sun-Sat or Mon-Sun depending on the payroll week
    the superintendent already thinks in, so this is per project, not global.
    ONE rule (11/03/2026): construction_company.week_start_for, which the
    Generate button's endpoint reads too."""
    import construction_company
    return construction_company.week_start_for(d, week_starts_on)


def cut_due_drafts(today: date = None, now: datetime = None) -> dict | None:
    """Draft this week's report for every project whose report day is today.

    The draft covers the week IN PROGRESS - a Friday cut on a Mon-Sun project
    reports Monday through today, so the manager edits over the weekend while
    the week is still fresh. Waiting for the week to close would put the report
    a full week behind the site.

    Idempotent by existence, not by a timestamp: a project that already has a
    report row for this week_start is skipped. That is what makes a restart, a
    second tick in the same minute, or a manager who drafted it early all safe,
    with no extra state to keep correct.

    Each project's day is its JOBSITE's day (construction_company.local_today,
    11/03/2026) - a Friday cut is the Friday on site, not in UTC - so `today`
    (a test's fixed date) applies to every project only when given.

    The construction_ai switch (Workflows > Automations) stops the MODEL, not
    the report: with it off, or AI off on the server, the draft is still cut,
    written without AI (construction_report.draft_offline)."""
    import construction_company
    use_ai = not job_switch.off("construction_ai")
    counts = {"cut": 0, "skipped": 0, "failed": 0}
    db = SessionLocal()
    try:
        _acquire_sweep_lock(db)   # same lock as the sweep: one worker cuts drafts
        projects = (db.query(models.ConstructionProject)
                    .filter(models.ConstructionProject.status == "active",
                            models.ConstructionProject.archived == False,  # noqa: E712
                            models.ConstructionProject.deleted_at == "").all())
        for p in projects:
            day = today or construction_company.local_today(db, p, now)
            if _model_weekday(day) != (p.report_day if p.report_day is not None else 5):
                continue
            ws = week_start_for(day, construction_company.week_starts(p)).isoformat()
            # The lock is transaction-scoped and every project commits, so it
            # is taken again for each one: two workers never both pass the
            # existence check for the same project (review, 11/03/2026).
            _acquire_sweep_lock(db)
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
                r = construction_report.generate(db, p, ws, "system", use_ai=use_ai)
                construction_notify.draft_cut(db, p, r)
                db.commit()
                counts["cut"] += 1
            except IntegrityError:
                # Another worker cut this week a moment ago (the unique
                # project/week/version index): theirs stands.
                db.rollback()
                counts["skipped"] += 1
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
            # Once an hour, not every minute: each project's report day is its
            # jobsite's own day (11/03/2026), which starts at a different UTC
            # hour per zone, so a once-a-UTC-day check would cut a Pacific
            # site's Friday draft on Thursday evening or miss it. The existence
            # check makes every later pass in the same week do nothing.
            today = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H")
            if today != last_draft_day:
                cut = await asyncio.to_thread(cut_due_drafts)
                # Switched off (None) = not done today: a switch flipped back on
                # the same report day still cuts this week's draft.
                if cut is not None:
                    last_draft_day = today
        except Exception as e:
            print(f"[construction] sweep loop error: {e}")
        await asyncio.sleep(_LOOP_SEC)
