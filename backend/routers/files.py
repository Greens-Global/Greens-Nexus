"""Authenticated viewer for the evidence buckets (Sep 22, 2026).

Checkout, receipt, return, ticket and QA photos used to sit in PUBLIC Supabase
buckets: anyone holding a URL (or guessing one) could open them with no login
(Neil's security-debt list). The buckets are private now, and this is the only
read path:

    GET /files/view?u=<the stored public-style URL>[&download=1]

The stored value in the database never changes - it is still the canonical
`.../storage/v1/object/public/<bucket>/<path>` string that `_validate_photo_url`
in items.py accepts - so no data migration, no export changes, no email
template changes. api.js rewrites those strings to this endpoint on the way
INTO the browser and back on the way OUT (see frontend/src/lib/storageView.js),
so no screen had to learn a new URL shape.

The response is a 302 to a short-lived signed URL minted with the service key.
The bytes still stream from Supabase, not through Azure; the browser follows
the redirect for <img>, <a>, <iframe> and fetch alike, and the private
Cache-Control keeps a repeat view off this endpoint for most of the signature's
life. Signed URLs are cached per object in-process so a page of 40 thumbnails
costs 40 storage calls once, not on every render.

Only the buckets listed in PROTECTED_BUCKETS are served, and only paths under
them: this is not a general storage proxy. Avatars and logos stay public on
purpose (they are shown to everyone and embedded in email).
"""
import os
import threading
import time
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse

from auth import get_current_user

router = APIRouter(prefix="/files", tags=["Files"])

_SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# Keep in step with PROTECTED_BUCKETS in frontend/src/lib/storageView.js and
# the `update storage.buckets set public = false` applied on dev + prod.
PROTECTED_BUCKETS = frozenset({
    "checkout-photos",
    "item-photos",
    "return-photos",
    "ticket-evidence",
    "qa-evidence",
})

_SIGN_TTL_SEC = 3600            # signature lifetime
_REUSE_SEC = 2700               # hand out a cached signature for 45 min of that hour
_BROWSER_CACHE_SEC = 1500       # the redirect itself: safe well inside the reuse window
_cache: dict[str, tuple[float, str]] = {}
_lock = threading.Lock()


def parse_public_url(u: str):
    """(bucket, path) for a canonical public-style URL of a protected bucket, else None."""
    if not _SUPABASE_URL or not u:
        return None
    prefix = f"{_SUPABASE_URL}/storage/v1/object/public/"
    if not u.startswith(prefix):
        return None
    rest = u[len(prefix):].split("?", 1)[0].split("#", 1)[0]
    bucket, _, path = rest.partition("/")
    if bucket not in PROTECTED_BUCKETS or not path:
        return None
    if ".." in path or path.startswith("/") or "\\" in path:
        return None
    return bucket, path


def _sign(bucket: str, path: str) -> str:
    key = f"{bucket}/{path}"
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < _REUSE_SEC:
            return hit[1]
    r = httpx.post(
        f"{_SUPABASE_URL}/storage/v1/object/sign/{bucket}/{quote(path, safe='/')}",
        json={"expiresIn": _SIGN_TTL_SEC},
        headers={"apikey": _SERVICE_KEY, "Authorization": f"Bearer {_SERVICE_KEY}"},
        timeout=10,
    )
    if r.status_code == 404:
        raise HTTPException(404, "File not found")
    if r.status_code != 200:
        raise HTTPException(502, f"Storage refused to sign the file ({r.status_code})")
    signed = (r.json() or {}).get("signedURL") or ""
    if not signed:
        raise HTTPException(502, "Storage returned no signed URL")
    if signed.startswith("/"):
        signed = f"{_SUPABASE_URL}/storage/v1{signed}"
    with _lock:
        _cache[key] = (now, signed)
        if len(_cache) > 20000:
            _cache.clear()
    return signed


@router.get("/view")
def view_file(u: str = Query(..., max_length=1000), download: int = 0,
              user: dict = Depends(get_current_user)):
    parsed = parse_public_url(u)
    if not parsed:
        raise HTTPException(400, "Not a Nexus evidence file")
    if not _SERVICE_KEY:
        raise HTTPException(503, "File viewing is not configured on this deployment (SUPABASE_SERVICE_KEY)")
    bucket, path = parsed
    url = _sign(bucket, path)
    if download:
        url += ("&" if "?" in url else "?") + "download"
    return RedirectResponse(url, status_code=302,
                            headers={"Cache-Control": f"private, max-age={_BROWSER_CACHE_SEC}"})
