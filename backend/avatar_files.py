"""A removed or replaced profile photo leaves storage (11/02/2026, the legal
compliance pass).

Profile photos live in the PUBLIC `avatars` bucket (shown to everyone and in
email - routers/files.py). "Profile photo removed" used to blank the field
and leave the picture in the bucket, still open to anyone holding its link;
every replacement left the old one there too.

`forget(db, old_url, emp_id)` runs after the row's new value is committed and
deletes the old object only when it is that person's own photo (the
`avatars/<employee id>/` folder - logos and signature logos live elsewhere and
are never touched) and no person row still shows it. Only on the deployed API
(a laptop never deletes live storage). Called from plain `def` routes, so the
blocking call runs in FastAPI's threadpool. A failed delete is only an orphan.
"""
import os
from urllib.parse import quote

import httpx

BUCKET = "avatars"


def _deployed() -> bool:
    try:
        import leader
        return leader.is_deployed_worker()
    except Exception:
        return False


def forget(db, old_url: str, emp_id: str) -> bool:
    base = (os.getenv("SUPABASE_URL", "") or "").rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_KEY", "")
    if not (old_url and emp_id and base and key and _deployed()):
        return False
    prefix = f"{base}/storage/v1/object/public/{BUCKET}/"
    if not old_url.startswith(prefix):
        return False
    path = old_url[len(prefix):].split("?", 1)[0]
    if not path.startswith(f"{emp_id}/") or ".." in path:
        return False
    from models import NexusEmployee
    if db.query(NexusEmployee).filter(NexusEmployee.photo_url == old_url).first():
        return False   # still someone's photo
    try:
        r = httpx.delete(f"{base}/storage/v1/object/{BUCKET}/{quote(path)}",
                         headers={"Authorization": f"Bearer {key}", "apikey": key}, timeout=30)
    except Exception:
        return False
    return r.is_success or r.status_code == 404
