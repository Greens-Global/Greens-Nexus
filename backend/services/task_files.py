"""Where a task file's bytes go.

Until now the Task module had no server-side upload at all: the browser turns a
file under 2 MB into a base64 `data:` URL and stores it in the row, and anything
larger is stored as metadata with NO url (see uploadTaskAttachment in
tasks/lib.js, and the conditional `href` in CommentAttachments that exists
because of it). That is workable for a person who can see the failure; it is not
workable for a file that arrived by email, where nobody is watching.

So attachments ingested from email are uploaded properly, to Supabase storage:
raw httpx against the storage REST API with the service key, the way every
server-side upload in this codebase is done (routers/hr.py, routers/esign.py).
There is no Supabase client dependency here and adding one to move a few bytes
would be another way to do the same thing.

`data:` URLs are deliberately NOT produced here. The Asana sync skips them when
pushing attachments outward (CLAUDE.md), so a data-URL attachment silently never
reaches Asana - and an emailed attachment is exactly the kind that should.
"""
import os
import re
import uuid

import httpx

# Public-read, and it has to be: the drawer loads these URLs directly, and the
# Asana push sends one as an EXTERNAL attachment, which means Asana fetches it
# itself with none of our credentials. The path carries a uuid, so an object is
# unguessable, but it is not access-controlled - do not put anything here that
# a task's own attachment list would not already show.
BUCKET = "task-files"

# A gunicorn worker reads the whole file into memory to upload it, so this is a
# memory budget, not a policy preference: two concurrent large files on one
# instance is the failure being bounded here.
MAX_BYTES = 25 * 1024 * 1024

_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def configured() -> bool:
    return bool(os.getenv("SUPABASE_URL", "").strip()
                and os.getenv("SUPABASE_SERVICE_KEY", "").strip())


def storage_path(task_id: str, name: str) -> str:
    """`task-email/<task>/<uuid>.<ext>` - id-keyed, not name-keyed.

    Two people replying with `photo.jpg` on the same task must not overwrite each
    other, and a comment's file has to stay reachable from a notification email
    sent months ago."""
    ext = ""
    if "." in (name or ""):
        ext = _UNSAFE.sub("", name.rsplit(".", 1)[-1].lower())[:8]
    return f"task-email/{task_id}/{uuid.uuid4().hex}{('.' + ext) if ext else ''}"


def _base_and_key() -> tuple[str, str]:
    return (os.getenv("SUPABASE_URL", "").strip().rstrip("/"),
            os.getenv("SUPABASE_SERVICE_KEY", "").strip())


def _ensure_bucket(base: str, key: str) -> None:
    """Create the bucket on first use.

    Self-provisioning rather than a release step: this runs on dev and prod from
    the same code, and a missing bucket would otherwise turn every emailed
    attachment into a silent failure until somebody noticed. Public read matches
    what the module already needs (see BUCKET); an existing bucket is left
    exactly as it is - this never reconfigures one."""
    r = httpx.post(f"{base}/storage/v1/bucket", timeout=20,
                   headers={"Authorization": f"Bearer {key}", "apikey": key},
                   json={"name": BUCKET, "id": BUCKET, "public": True,
                         "file_size_limit": MAX_BYTES})
    if r.status_code >= 400 and "already exists" not in r.text.lower():
        raise RuntimeError(f"Supabase create-bucket {r.status_code}: {r.text[:200]}")


def upload(path: str, raw: bytes, content_type: str) -> str:
    """Upload and return the public URL. Raises on failure - the caller decides
    what a file it could not store means for the comment it belongs to."""
    if not configured():
        raise RuntimeError("Supabase storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY)")
    base, key = _base_and_key()
    headers = {"Authorization": f"Bearer {key}", "apikey": key,
               "Content-Type": content_type or "application/octet-stream",
               # The path carries a uuid, so the object at it never changes.
               "cache-control": "31536000"}
    url = f"{base}/storage/v1/object/{BUCKET}/{path}"
    r = httpx.post(url, content=raw, headers=headers, timeout=60)
    if r.status_code == 404:            # no bucket yet
        _ensure_bucket(base, key)
        r = httpx.post(url, content=raw, headers=headers, timeout=60)
    if r.status_code >= 400:
        raise RuntimeError(f"Supabase upload {r.status_code}: {r.text[:200]}")
    return f"{base}/storage/v1/object/public/{BUCKET}/{path}"


def kind_for(content_type: str) -> str:
    """image | doc - the same two values uploadTaskAttachment sends, so an
    emailed file renders exactly like an uploaded one."""
    return "image" if (content_type or "").lower().startswith("image/") else "doc"


def size_label(size_bytes: int) -> str:
    """"412 KB" - TaskAttachment.size is a display string, not a number, and the
    client writes it in KB (tasks/lib.js). Same format or the column holds two
    different things."""
    return f"{max(1, round((size_bytes or 0) / 1024))} KB"
