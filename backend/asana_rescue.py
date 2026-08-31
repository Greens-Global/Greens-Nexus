"""Rescue attachment files that still live on Asana's servers before the
subscription ends and their URLs die.

Two kinds of at-risk rows in task_attachments (audit of 08/17: 447 + 19):

- ``asanausercontent.com`` - Asana-hosted files _pull_attachments never
  inlined because they were over its 5 MB cap (or a download failed once).
  Signed S3 URLs; most signatures are already expired, and all of them die
  with the workspace. Rescue = ask the Asana API for a FRESH download_url via
  the attachment gid we stored in asana_attachment_links, stream the bytes
  down, and store them through the same task-files bucket path every other
  task upload uses (task_files.store_bytes / store_file).

- ``app.asana.com`` - pointers to externally hosted attachments (Google
  Drive, Dropbox, ...). There are no bytes to fetch from Asana; the file
  lives on the external host. Rescue = resolve the underlying external URL
  from the attachment record and store THAT.

Either way the pre-rescue URL is kept in task_attachments.original_asana_url
(first write wins) so every rewrite is auditable and reversible.

Additive and idempotent: a row is only ever rewritten away from an at-risk
URL, never deleted, never touched twice (a rescued row no longer matches the
at-risk scan). Rows that fail (gid missing, 404 on both tokens, download
failed 3 times, file over the 512 MB cap) are counted and LEFT UNTOUCHED so a
re-run retries them.

Runs as a background thread started by POST /asana-sync/rescue-attachments
(same shape as pull-new: returns immediately, one-at-a-time guard in
asana_sync_config.rescue_running_at with a 30-minute stale window, never on
the async event loop). Progress is visible at GET /asana-sync/rescue-status,
which merges the in-memory run counters with DB-derived totals so it stays
truthful across worker restarts.
"""
import mimetypes
import os
import tempfile
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

import httpx

import asana_enabled
import models
import task_files

_ASANA_BASE = "https://app.asana.com/api/1.0"
_META_FIELDS = "name,size,host,download_url,view_url,permanent_url"

# Hosts whose URLs die with the subscription. Suffix-matched on the URL's
# netloc, so s3 regional variants of asanausercontent and app.asana.com both
# count, but e.g. drive.google.com never does.
AT_RISK_HOST_SUFFIXES = ("asanausercontent.com", "asana.com")

# Over this, skip and count rather than pull half a gigabyte through the API
# worker (nothing in the 08/17 audit is anywhere near it).
MAX_FILE_BYTES = 512 * 1024 * 1024
# Up to this, upload via the proven store_bytes path; above it, stream from
# the temp file through store_file so the worker never holds it in RAM.
IN_MEMORY_MAX_BYTES = 32 * 1024 * 1024

_TRIES = 3
BATCH_SIZE = 6          # rows per commit
MAX_CONCURRENT = 3      # parallel downloads (Asana rate limits; be modest)
STALE_SECS = 30 * 60    # rescue_running_at older than this = dead run

# In-memory progress for the current/most recent run on this worker process.
_STATUS_LOCK = threading.Lock()
_STATUS = {"state": "never-run"}


def _set_status(**kw):
    with _STATUS_LOCK:
        _STATUS.update(kw)


def status_snapshot():
    with _STATUS_LOCK:
        return dict(_STATUS)


def _host(url):
    try:
        return (urllib.parse.urlparse(url or "").netloc or "").lower()
    except ValueError:
        return ""


def url_at_risk(url):
    """True when this URL stops working once the Asana subscription ends."""
    h = _host(url)
    return bool(h) and any(h == s or h.endswith("." + s) for s in AT_RISK_HOST_SUFFIXES)


def _get_json(path, token):
    """GET an Asana API path. Returns (payload, None) or (None, status_code).
    Retries 429 (Retry-After) and 5xx; a 4xx comes back for the caller to
    decide (403/404 mean "try the other token")."""
    if not asana_enabled.is_asana_enabled():
        return None, -1        # same shape as an exhausted retry - callers cope
    url = f"{_ASANA_BASE}{path}"
    for attempt in range(5):
        try:
            r = httpx.get(url, headers={"Authorization": f"Bearer {token}",
                                        "Accept": "application/json"}, timeout=60)
        except Exception:
            if attempt < 4:
                time.sleep(2 * (attempt + 1))
                continue
            return None, -1
        if r.status_code == 429:
            try:
                wait = int(r.headers.get("Retry-After", "10"))
            except ValueError:
                wait = 10
            time.sleep(min(wait, 60))
            continue
        if r.status_code >= 500 and attempt < 4:
            time.sleep(2 * (attempt + 1))
            continue
        if r.is_success:
            try:
                return r.json(), None
            except ValueError:
                return None, -1
        return None, r.status_code
    return None, -1


def fetch_attachment_meta(gid, tokens):
    """The attachment record, tried with each token in turn (service first,
    setup on 403/404 - some projects are visible to only one of them)."""
    for tok in tokens:
        payload, err = _get_json(f"/attachments/{gid}?opt_fields={_META_FIELDS}", tok)
        if payload is not None:
            return payload.get("data") or {}
        if err not in (401, 403, 404):
            return None
    return None


def decide(meta):
    """Pure decision logic - what to do with one attachment record.

    Returns one of:
      ("download", fresh_download_url)  - Asana-hosted bytes to fetch + store
      ("external", safe_external_url)   - externally hosted; rewrite URL only
      ("failed", reason)
    """
    if not meta:
        return ("failed", "no-metadata")
    host = (meta.get("host") or "").lower()
    dl = meta.get("download_url") or ""
    if host and host != "asana":
        # Externally hosted - find any recorded URL that does not go through
        # Asana. download_url first (it is the direct link when Asana has one).
        for cand in (dl, meta.get("view_url") or "", meta.get("permanent_url") or ""):
            if cand and not url_at_risk(cand):
                return ("external", cand)
        return ("failed", "external-no-safe-url")
    if not dl:
        return ("failed", "no-download-url")
    size = meta.get("size") or 0
    if size and size > MAX_FILE_BYTES:
        return ("failed", "oversize")
    return ("download", dl)


def _download_to_temp(url):
    """Stream a download to a temp file. Returns (path, nbytes, content_type)
    or (None, 0, "") on failure. Caps at MAX_FILE_BYTES (the reported size can
    be missing or wrong, so the cap is enforced on actual bytes too)."""
    if not asana_enabled.is_asana_enabled():
        return None, 0, ""     # the module's own "download failed" shape
    fd, path = tempfile.mkstemp(prefix="asana-rescue-")
    n = 0
    try:
        with os.fdopen(fd, "wb") as out:
            with httpx.stream("GET", url, follow_redirects=True, timeout=300) as r:
                if not r.is_success:
                    raise RuntimeError(f"HTTP {r.status_code}")
                ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip()
                for chunk in r.iter_bytes(1024 * 1024):
                    n += len(chunk)
                    if n > MAX_FILE_BYTES:
                        raise RuntimeError("oversize")
                    out.write(chunk)
        return path, n, ctype
    except Exception:
        try:
            os.remove(path)
        except OSError:
            pass
        return None, 0, ""


def _store_temp_file(name, path, nbytes, ctype):
    """Upload a downloaded temp file through the existing task-files helpers;
    small files via store_bytes (the proven path), big ones streamed."""
    ctype = ctype or mimetypes.guess_type(name or "")[0] or "application/octet-stream"
    if nbytes <= IN_MEMORY_MAX_BYTES:
        with open(path, "rb") as fh:
            return task_files.store_bytes(name, fh.read(), ctype)
    with open(path, "rb") as fh:
        return task_files.store_file(name, fh, nbytes, ctype)


def _process_one(att_id, att_name, gid, tokens):
    """Network half of one row's rescue - safe to run on a pool thread, no DB.
    Returns {"id", "outcome": rescued|external|failed, "new_url", "reason"}."""
    meta = fetch_attachment_meta(gid, tokens)
    action, value = decide(meta)
    if action == "external":
        return {"id": att_id, "outcome": "external", "new_url": value, "reason": ""}
    if action == "failed":
        return {"id": att_id, "outcome": "failed", "new_url": "", "reason": value}
    # action == "download": the signed URL is fresh, but S3 can still hiccup.
    name = (meta.get("name") or att_name or "attachment")
    for attempt in range(_TRIES):
        path, nbytes, ctype = _download_to_temp(value)
        if path is None:
            time.sleep(2 * (attempt + 1))
            continue
        try:
            new_url = _store_temp_file(name, path, nbytes, ctype)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
        if new_url:
            return {"id": att_id, "outcome": "rescued", "new_url": new_url,
                    "reason": "", "bytes": nbytes}
        time.sleep(2 * (attempt + 1))
    return {"id": att_id, "outcome": "failed", "new_url": "", "reason": "download-or-store-failed"}


def _candidates(db):
    """(attachment_id, name, current_url, asana_gid) for every at-risk row.
    Rows whose link is missing or carries a synthetic marker gid (non-numeric,
    e.g. "migrated-inline:...") have nothing to ask Asana about - counted as
    failures, never touched."""
    rows = (db.query(models.TaskAttachment)
              .filter(models.TaskAttachment.url.like("http%"))
              .filter((models.TaskAttachment.url.like("%asanausercontent.com%")) |
                      (models.TaskAttachment.url.like("%app.asana.com%")))
              .order_by(models.TaskAttachment.id).all())
    rows = [r for r in rows if url_at_risk(r.url)]
    links = {}
    if rows:
        for l in (db.query(models.AsanaAttachmentLink)
                    .filter(models.AsanaAttachmentLink.nexus_attachment_id.in_(
                        [r.id for r in rows])).all()):
            links[l.nexus_attachment_id] = (l.asana_attachment_gid or "").strip()
    out, no_gid = [], 0
    for r in rows:
        gid = links.get(r.id, "")
        if gid.isdigit():
            out.append((r.id, r.name, r.url, gid))
        else:
            no_gid += 1
    return out, no_gid


def run_rescue(session_factory):
    """The worker. Caller has already stamped rescue_running_at; this clears
    it on the way out no matter what."""
    counts = {"scanned": 0, "rescued": 0, "external_resolved": 0,
              "failed": 0, "no_gid": 0, "bytes_rescued": 0, "skipped_already_safe": 0}
    # Bail before the thread pool rather than letting every worker discover the
    # switch one dead download at a time. The endpoint is gated too.
    if not asana_enabled.is_asana_enabled():
        _set_status(state="failed", error=asana_enabled.DISABLED_MSG)
        return counts
    db = session_factory()
    try:
        cfg = db.query(models.AsanaSyncConfig).filter(
            models.AsanaSyncConfig.id == "singleton").first()
        tokens = [t for t in dict.fromkeys(
            [(cfg.token or "").strip(), (getattr(cfg, "setup_token", "") or "").strip()]) if t]
        if not tokens:
            _set_status(state="failed", error="No Asana token in asana_sync_config.")
            return counts
        todo, counts["no_gid"] = _candidates(db)
        counts["scanned"] = len(todo) + counts["no_gid"]
        _set_status(state="running", started_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    total=counts["scanned"], **{k: counts[k] for k in
                    ("rescued", "external_resolved", "failed", "no_gid", "bytes_rescued")})
        for i in range(0, len(todo), BATCH_SIZE):
            batch = todo[i:i + BATCH_SIZE]
            with ThreadPoolExecutor(max_workers=MAX_CONCURRENT) as pool:
                results = list(pool.map(
                    lambda c: _process_one(c[0], c[1], c[3], tokens), batch))
            for res in results:
                if res["outcome"] == "failed":
                    counts["failed"] += 1
                    continue
                row = db.query(models.TaskAttachment).filter(
                    models.TaskAttachment.id == res["id"]).first()
                # Re-check under this transaction: a concurrent run (other
                # worker/instance) may have rewritten it already.
                if row is None or not url_at_risk(row.url):
                    counts["skipped_already_safe"] += 1
                    continue
                if not row.original_asana_url:        # first write wins - audit trail
                    row.original_asana_url = row.url
                row.url = res["new_url"]
                if res["outcome"] == "rescued":
                    counts["rescued"] += 1
                    counts["bytes_rescued"] += res.get("bytes", 0)
                else:
                    counts["external_resolved"] += 1
            db.commit()
            done = min(i + BATCH_SIZE, len(todo))
            _set_status(state="running", done=done, **{k: counts[k] for k in
                        ("rescued", "external_resolved", "failed", "no_gid",
                         "bytes_rescued", "skipped_already_safe")})
            time.sleep(0.3)   # modest pacing between batches
        _set_status(state="done", finished_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    **counts)
        print(f"[asana-rescue] done: {counts}")
        return counts
    except Exception as e:
        db.rollback()
        _set_status(state="failed", error=str(e), **counts)
        print(f"[asana-rescue] failed: {e}")
        return counts
    finally:
        # Always release the guard, or the next click waits out the stale window.
        try:
            cfg = db.query(models.AsanaSyncConfig).filter(
                models.AsanaSyncConfig.id == "singleton").first()
            if cfg is not None:
                cfg.rescue_running_at = ""
                db.commit()
        except Exception as e2:
            print(f"[asana-rescue] guard-clear failed: {e2}")
        db.close()


def db_progress(db):
    """DB-derived truth for the status endpoint - survives worker restarts.
    `at_risk_remaining` counts rows still on a dying host; `rescued_total`
    counts every row any run has ever rewritten."""
    remaining = (db.query(models.TaskAttachment)
                   .filter((models.TaskAttachment.url.like("%asanausercontent.com%")) |
                           (models.TaskAttachment.url.like("%app.asana.com%"))).count())
    rescued = (db.query(models.TaskAttachment)
                 .filter(models.TaskAttachment.original_asana_url != "").count())
    return {"at_risk_remaining": remaining, "rescued_total": rescued}
