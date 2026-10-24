"""Knowledge Base images and files (Oct 2026 rebuild).

Every picture a page carries lives in the PRIVATE `kb-media` bucket and is
stored on the page as the canonical public-style URL
(`.../storage/v1/object/public/kb-media/<path>`), exactly like every other
evidence bucket in Nexus: the browser opens it only through
`GET /files/view?u=` (routers/files.py), and api.js rewrites the URL both
ways, so the screens never see the difference. The old module had its own
signing route and allowed `data:` blobs inside the document; both are gone.
"""
from __future__ import annotations

import base64
import os
import re
import uuid

import httpx

BUCKET = "kb-media"
MAX_BYTES = 10 * 1024 * 1024
_ALLOWED = {
    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
    "application/pdf": "pdf",
}
_DATA_URL = re.compile(r"^data:([\w/+.-]+);base64,(.+)$", re.DOTALL)


def _supabase_url() -> str:
    return (os.getenv("SUPABASE_URL", "") or "").rstrip("/")


def _service_key() -> str:
    return os.getenv("SUPABASE_SERVICE_KEY", "") or ""


def configured() -> bool:
    return bool(_supabase_url() and _service_key())


def canonical_url(path: str) -> str:
    return f"{_supabase_url()}/storage/v1/object/public/{BUCKET}/{path.lstrip('/')}"


def storage_prefix() -> str:
    return f"{_supabase_url()}/storage/v1/object/public/" if _supabase_url() else ""


def is_storage_url(u: str) -> bool:
    """A URL inside OUR storage (any bucket). The page sanitizer keeps these
    and plain https links; it drops data: blobs."""
    if not isinstance(u, str) or not u:
        return False
    p = storage_prefix()
    if p and u.startswith(p):
        return True
    return u.startswith("https://") and not u.startswith("data:")


def upload_bytes(data: bytes, content_type: str, folder: str = "pages") -> str:
    if not configured():
        raise RuntimeError("Image storage is not configured on this server")
    if not data:
        raise ValueError("Empty file")
    if len(data) > MAX_BYTES:
        raise ValueError("File is larger than 10 MB")
    ct = (content_type or "").split(";")[0].strip().lower() or "image/jpeg"
    ext = _ALLOWED.get(ct)
    if not ext:
        raise ValueError("Only JPEG, PNG, GIF, WebP images and PDF files can be uploaded")
    path = f"{folder.strip('/')}/{uuid.uuid4().hex}.{ext}"
    with httpx.Client(timeout=60) as c:
        r = c.post(f"{_supabase_url()}/storage/v1/object/{BUCKET}/{path}", content=data, headers={
            "Authorization": f"Bearer {_service_key()}", "apikey": _service_key(),
            "Content-Type": ct, "cache-control": "31536000", "x-upsert": "false",
        })
    if r.status_code >= 300:
        raise RuntimeError(f"Storage refused the upload ({r.status_code})")
    return canonical_url(path)


def upload_data_url(data_url: str, folder: str = "pages") -> str:
    m = _DATA_URL.match((data_url or "").strip())
    if not m:
        raise ValueError("Not an image")
    ct, b64 = m.group(1), m.group(2)
    try:
        raw = base64.b64decode(b64, validate=False)
    except Exception as e:  # noqa: BLE001
        raise ValueError("Bad image data") from e
    return upload_bytes(raw, ct, folder)


def resolve_legacy(ref: str, folder: str = "legacy") -> str:
    """What the migration does with an old image reference:
      "sop/<hex>.jpg"  (old kb-media path)  -> canonical URL, same object
      "data:image/..."                       -> uploaded, URL
      "https://..."                          -> kept as the link it was
    Returns "" when it cannot be stored (the report notes it)."""
    ref = (ref or "").strip()
    if not ref:
        return ""
    if ref.startswith("data:"):
        try:
            return upload_data_url(ref, folder)
        except Exception:  # noqa: BLE001
            return ""
    if ref.startswith("http://") or ref.startswith("https://"):
        return ref
    if "/" in ref and not ref.startswith("/") and ".." not in ref and _supabase_url():
        return canonical_url(ref)
    return ""
