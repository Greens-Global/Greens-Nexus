"""Egnyte module endpoints (Jul 2026).

Thin HTTP surface over services/egnyte.py - the shared client. NOTHING here talks
to Egnyte directly; adding a second client is the mistake CLAUDE.md records for
Asana. If a capability is missing, add the verb to the service.

Owner goal (Neil): upload and pull directly, at the right folder level. Egnyte
remains the source of truth - Nexus lists, reads, writes and links, and never
keeps a second copy. Every file response therefore also carries `webUrl`, the
deep link into Egnyte's own UI where permissions, versions and sharing live.

Unconfigured is a first-class state, not an error to hide: /status reports it and
every other route 503s with an actionable message, so the UI can render an
explained empty state before the API key exists.
"""
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Response
from pydantic import BaseModel

from auth import get_current_user, require_level
from services import egnyte as svc

router = APIRouter(prefix="/egnyte", tags=["Egnyte"])

# Reads: any signed-in user - the folder's own Egnyte permissions are the real
# boundary and re-implementing them here would drift from them.
# Writes: supervisor+. Uploading into a shared property folder is a real-world
# action with no undo in Nexus, so it is not left at employee level.
require_writer = require_level(2)

MAX_UPLOAD_BYTES = 100 * 1024 * 1024   # Egnyte handles larger; this bounds our memory


def _guard():
    if not svc.configured():
        raise HTTPException(503, "Egnyte is not connected yet - set EGNYTE_DOMAIN and EGNYTE_TOKEN")


def _call(fn, *args, **kwargs):
    """Map EgnyteError onto the upstream status. A 404 must stay a 404: a
    property with no Egnyte folder yet is an expected empty state, and flattening
    it to 502 would make the UI say 'Egnyte is broken' for a normal condition."""
    _guard()
    try:
        return fn(*args, **kwargs)
    except svc.EgnyteError as exc:
        raise HTTPException(exc.status, str(exc))


@router.get("/status")
def status(user: dict = Depends(get_current_user)):
    """Deliberately does NOT 503 - the UI asks this to decide what to render."""
    return {"configured": svc.configured()}


# ── browse / read ────────────────────────────────────────────────────────────

@router.get("/folder")
def list_folder(path: str = "", user: dict = Depends(get_current_user)):
    data = _call(svc.list_folder, path)
    for f in data["files"]:
        f["webUrl"] = svc.web_url(f["path"])
    for d in data["folders"]:
        d["webUrl"] = svc.web_url(d["path"])
    return data


@router.get("/file")
def get_file(path: str, user: dict = Depends(get_current_user)):
    """Streams whatever is at `path`. Unlike the DMS importer this is NOT
    extension-filtered - a property Documents tab must serve what is actually in
    the folder, not only what the importer can convert."""
    content = _call(svc.read_file, path)
    name = svc.norm(path).rsplit("/", 1)[-1] or "download"
    return Response(
        content=content,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


@router.get("/search")
def search(q: str, folder: str = "", limit: int = 20, user: dict = Depends(get_current_user)):
    """Backs Ctrl+K federation. Nexus indexes nothing - Egnyte does the search."""
    if not (q or "").strip():
        return {"results": []}
    results = _call(svc.search, q.strip(), folder, limit)
    for r in results:
        r["webUrl"] = svc.web_url(r["path"])
    return {"results": results}


# ── write ────────────────────────────────────────────────────────────────────

@router.post("/upload")
async def upload(
    folder: str = Form(...),
    file: UploadFile = File(...),
    user: dict = Depends(require_writer),
):
    """Upload INTO a named folder - the owner's "at the right folder level".

    The destination is folder + the file's own name, so a file lands where the
    user is looking rather than in a generic inbox to be re-filed by hand.
    """
    _guard()
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Empty file")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"File is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
    name = (file.filename or "upload").rsplit("/", 1)[-1].strip()
    if not name:
        raise HTTPException(400, "File has no name")
    dest = svc.norm(f"{svc.norm(folder)}/{name}")
    result = _call(svc.upload_file, dest, raw)
    result["webUrl"] = svc.web_url(dest)
    result["uploadedBy"] = user["email"]
    return result


class FolderIn(BaseModel):
    path: str


@router.post("/folder")
def make_folder(body: FolderIn, user: dict = Depends(require_writer)):
    """Idempotent - 'already exists' is success, because the caller wanted it to
    exist. Lets a property's folder be provisioned on first use."""
    if not (body.path or "").strip():
        raise HTTPException(400, "path is required")
    return _call(svc.create_folder, body.path)


# ── property convenience ─────────────────────────────────────────────────────

@router.get("/property/{site}")
def property_documents(site: str, user: dict = Depends(get_current_user)):
    """Everything a property card needs in ONE call: the resolved folder paths
    plus the plans listing.

    Resolution LISTS and MATCHES rather than constructing a path from a prefix.
    Verified against the live tenant: the folders under /Shared/--Asset Management
    use three naming styles (GS <site>, a street address, a project name), and
    half do not follow "GS <site>" - constructing would 404 for eight properties.

    `missing: true` (rather than a 404) when nothing matches - that is the normal
    state for a new property and the UI should offer to create it.
    """
    _guard()
    try:
        folder = svc.resolve_property_folder(site)
    except svc.EgnyteError as exc:
        raise HTTPException(exc.status, str(exc))
    if not folder:
        return {"site": site, "folder": None, "plansFolder": None, "webUrl": None,
                "plansWebUrl": None, "missing": True, "plans": {"folders": [], "files": []},
                "systems": []}

    plans = svc.plans_folder(folder)
    payload = {
        "site": site,
        "folder": folder,
        "plansFolder": plans,
        "webUrl": svc.web_url(folder),
        "plansWebUrl": svc.web_url(plans),
        "missing": False,
        "plans": {"folders": [], "files": []},
        "systems": [],
    }

    # The per-system subfolders (HVAC, Electrical, Plumbing, ...) ARE the tabs
    # Neil described - they come from Egnyte rather than a hardcoded list, so a
    # folder added there appears in Nexus without a deploy.
    try:
        top = svc.list_folder(folder)
        payload["systems"] = [
            {"name": f["name"], "path": f["path"], "webUrl": svc.web_url(f["path"])}
            for f in top["folders"]
        ]
    except svc.EgnyteError:
        pass

    try:
        listing = svc.list_folder(plans)
        for f in listing["files"]:
            f["webUrl"] = svc.web_url(f["path"])
        for d in listing["folders"]:
            d["webUrl"] = svc.web_url(d["path"])
        payload["plans"] = listing
    except svc.EgnyteError as exc:
        if exc.status != 404:
            raise HTTPException(exc.status, str(exc))
    return payload
