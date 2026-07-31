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
import mimetypes

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


# Types the viewer may render IN Nexus. An allowlist, not a blocklist, and the
# reason is security rather than tidiness: the UI renders these through a blob:
# URL, which inherits the APP's origin, so an HTML or SVG file out of Egnyte
# would execute as first-party script - stored XSS by way of a file upload.
# Anything not named here still downloads perfectly well; it just does not get
# to choose its own content type.
_PREVIEWABLE = {
    "application/pdf",
    "image/png", "image/jpeg", "image/gif", "image/webp",
    "text/plain", "text/csv", "text/markdown",
}
# guess_type is inconsistent across platforms for these, so pin them.
_EXTRA_TYPES = {
    ".md": "text/markdown", ".markdown": "text/markdown",
    ".csv": "text/csv", ".log": "text/plain", ".txt": "text/plain",
}


def preview_type(name: str) -> str | None:
    """The content type this file may be shown as, or None if it may only be
    downloaded. Server-side is where this decision has to live - the client
    mirrors it to pick a viewer, but a client-only rule is not a rule."""
    ext = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
    guessed = _EXTRA_TYPES.get(ext) or mimetypes.guess_type(name)[0]
    return guessed if guessed in _PREVIEWABLE else None


@router.get("/file")
def get_file(path: str, inline: bool = False, user: dict = Depends(get_current_user)):
    """Streams whatever is at `path`. Unlike the DMS importer this is NOT
    extension-filtered - a property Documents tab must serve what is actually in
    the folder, not only what the importer can convert.

    `inline=true` asks to VIEW rather than download: the response then carries
    the file's real content type so the viewer can render it. That is granted
    only for the allowlist above; anything else is served back as a download
    regardless, so asking for inline can never turn a file into script.
    """
    content = _call(svc.read_file, path)
    name = svc.norm(path).rsplit("/", 1)[-1] or "download"
    kind = preview_type(name) if inline else None
    disposition = "inline" if kind else "attachment"
    return Response(
        content=content,
        media_type=kind or "application/octet-stream",
        headers={
            "Content-Disposition": f'{disposition}; filename="{name}"',
            # Belt and braces: never let a browser sniff its way past the
            # allowlist, and never let a previewed file pull in anything.
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
        },
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

    Resolution LISTS and MATCHES rather than constructing a path from a prefix,
    across both roots in priority order (see services/egnyte.py). A property
    resolves to its ENTITY folder under /Shared/#Entities when one exists, and
    falls back to /Shared/--Asset Management for the sites that live only there.

    `missing: true` (rather than a 404) when nothing matches anywhere - that is
    the normal state for a new property and the UI should offer to create it,
    which needs a proposed path, so one is returned alongside.
    """
    _guard()
    try:
        folder = svc.resolve_property_folder(site)
    except svc.EgnyteError as exc:
        raise HTTPException(exc.status, str(exc))

    if not folder:
        # Propose where it WOULD go. Returning nulls here left the UI's Create
        # Folder button wired to an empty path, so it silently did nothing.
        proposed = svc.folder_for_property(site)
        return {"site": site, "folder": proposed, "plansFolder": svc.plans_folder(proposed),
                "webUrl": None, "plansWebUrl": None, "missing": True,
                "plans": {"folders": [], "files": []}, "sections": []}

    # One listing serves both jobs: it names the subfolders AND decides which of
    # them holds the documents. Asking Egnyte twice for the same folder to
    # answer two questions about it would just be a slower way to be wrong.
    top: dict | None = None
    try:
        top = svc.list_folder(folder)
    except svc.EgnyteError as exc:
        if exc.status != 404:
            raise HTTPException(exc.status, str(exc))

    children = top["folders"] if top else []
    plans = svc.plans_folder(folder, [f["name"] for f in children] if top else None)
    payload = {
        "site": site,
        "folder": folder,
        "plansFolder": plans,
        "webUrl": svc.web_url(folder),
        "plansWebUrl": svc.web_url(plans),
        "missing": False,
        "plans": {"folders": [], "files": []},
        # The property folder's own subfolders - Financials/Lease/Legal/... on an
        # entity, HVAC/Electrical/Plumbing/... on an asset-management folder.
        # Read live from Egnyte rather than hardcoded, so a folder added there
        # shows up in Nexus without a deploy.
        "sections": [
            {"name": f["name"], "path": f["path"], "webUrl": svc.web_url(f["path"])}
            for f in children
        ],
    }

    # plans == folder when the property folder uses neither documents-subfolder
    # name; that listing is already in hand, so reuse it rather than re-fetch.
    if svc.norm(plans) == svc.norm(folder):
        if top is None:
            return payload
        listing = top
    else:
        try:
            listing = svc.list_folder(plans)
        except svc.EgnyteError as exc:
            if exc.status != 404:
                raise HTTPException(exc.status, str(exc))
            return payload
    for f in listing["files"]:
        f["webUrl"] = svc.web_url(f["path"])
    for d in listing["folders"]:
        d["webUrl"] = svc.web_url(d["path"])
    payload["plans"] = listing
    return payload
