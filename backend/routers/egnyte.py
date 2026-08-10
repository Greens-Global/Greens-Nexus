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
from database import get_db
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


def _is_privileged(user: dict, db) -> bool:
    """May browse with the SHARED service token: supervisor+ (the module's
    original gate) or an egnyte/hr Access-Group grant (the person card and the
    pickers live behind those)."""
    from auth import _module_level
    return (user["level"] >= 2
            or _module_level(user["email"], "egnyte", db) >= 1
            or _module_level(user["email"], "hr", db) >= 1)


def _browse_token(user: dict, db) -> str | None:
    """Which Egnyte identity this request browses as (Aug 10: "anybody in here
    would only be able to see what they actually have access to").

    With OAuth configured, connecting is REQUIRED for everyone - Global Admin
    included (Visesh: an unconnected friend could still see everything through
    the privileged fallback, which defeated the point). Connected -> the
    caller's OWN token; Egnyte's folder permissions decide everything from
    here, Nexus adds nothing. Without OAuth configured, the old shared-token
    behavior stays, gated to supervisor+/egnyte/hr grants - which also closes
    the old gap where these endpoints accepted ANY signed-in user while only
    the UI pretended supervisor+."""
    import egnyte_oauth
    if egnyte_oauth.oauth_configured():
        tok = egnyte_oauth.token_for(db, user["email"])
        if tok:
            return tok
        raise HTTPException(428, "Connect your Egnyte account to browse files - open Egnyte and press Connect.")
    if _is_privileged(user, db):
        return None
    raise HTTPException(403, "You don't have access to this screen")


@router.get("/status")
def status(user: dict = Depends(get_current_user)):
    """Deliberately does NOT 503 - the UI asks this to decide what to render.

    `service.canRefresh` is the piece worth watching: false means the SHARED
    service token will expire (~30 days) and take every server-mediated surface
    down with a 401 until a human pastes a new one. Reporting it here makes that
    visible NOW rather than discovered as an outage, which is exactly how it was
    discovered the first time. It is separate from `oauth`, which covers this
    caller's own connection.
    """
    import egnyte_oauth
    from database import SessionLocal
    out = {"configured": svc.configured(),
           "service": {"canRefresh": svc.can_refresh(), "expiresAt": svc.token_expires_at()},
           "oauth": {"enabled": egnyte_oauth.oauth_configured(), "connected": False,
                     "egnyteUsername": "", "mustConnect": False}}
    if out["oauth"]["enabled"]:
        _db = SessionLocal()
        try:
            row = egnyte_oauth.get_row(_db, user["email"])
            connected = bool(row and row.access_token_enc)
            out["oauth"]["connected"] = connected
            out["oauth"]["egnyteUsername"] = (row.egnyte_username or "") if row else ""
            # Strict: with OAuth on, browsing requires a personal connection -
            # no privileged shared-view fallback.
            out["oauth"]["mustConnect"] = not connected
        finally:
            _db.close()
    return out


# ── browse / read ────────────────────────────────────────────────────────────

@router.get("/folder")
def list_folder(path: str = "", user: dict = Depends(get_current_user),
                db=Depends(get_db)):
    tok = _browse_token(user, db)
    data = _call(svc.list_folder, path, token=tok)
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
def get_file(path: str, inline: bool = False, user: dict = Depends(get_current_user),
             db=Depends(get_db)):
    """Streams whatever is at `path`. Unlike the DMS importer this is NOT
    extension-filtered - a property Documents tab must serve what is actually in
    the folder, not only what the importer can convert.

    `inline=true` asks to VIEW rather than download: the response then carries
    the file's real content type so the viewer can render it. That is granted
    only for the allowlist above; anything else is served back as a download
    regardless, so asking for inline can never turn a file into script.
    """
    content = _call(svc.read_file, path, token=_browse_token(user, db))
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
def search(q: str, folder: str = "", limit: int = 20, user: dict = Depends(get_current_user),
           db=Depends(get_db)):
    """Backs Ctrl+K federation. Nexus indexes nothing - Egnyte does the search."""
    if not (q or "").strip():
        return {"results": []}
    results = _call(svc.search, q.strip(), folder, limit, token=_browse_token(user, db))
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

    # This endpoint is async (UploadFile.read), so BOTH the token lookup and
    # the Egnyte HTTP call go through to_thread - a sync call here blocks the
    # whole worker for the upload's duration (the Aug 2 freeze class).
    # Connected users write as THEMSELVES: Egnyte's audit shows the real
    # person and its permissions bound what they can touch.
    import asyncio
    import egnyte_oauth as _eo
    from database import SessionLocal as _SL

    def _do_upload():
        _db = _SL()
        try:
            _tok = _eo.token_for(_db, user["email"])
        finally:
            _db.close()
        return _call(svc.upload_file, dest, raw, token=_tok)

    result = await asyncio.to_thread(_do_upload)
    result["webUrl"] = svc.web_url(dest)
    result["uploadedBy"] = user["email"]
    return result


class FolderIn(BaseModel):
    path: str


@router.post("/folder")
def make_folder(body: FolderIn, user: dict = Depends(require_writer), db=Depends(get_db)):
    """Idempotent - 'already exists' is success, because the caller wanted it to
    exist. Lets a property's folder be provisioned on first use."""
    if not (body.path or "").strip():
        raise HTTPException(400, "path is required")
    import egnyte_oauth as _eo
    return _call(svc.create_folder, body.path, token=_eo.token_for(db, user["email"]))


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


# ── wiring registry (Aug 10 - Neil's "give you that wiring", minus the you) ──
# Manager+ edits which Egnyte folder each Nexus surface reads/writes, from the
# module's Wiring tab, so re-pointing a surface never needs a deploy or an env
# change. Slots and resolution live in egnyte_wiring.py.

import uuid as _uuid

from sqlalchemy.orm import Session

import egnyte_wiring as wiring
from auth import require_manager, require_module_grant
from database import get_db

_require_hr_read = require_module_grant("hr", "viewer")


@router.get("/wiring")
def wiring_list(user: dict = Depends(require_manager), db: Session = Depends(get_db)):
    """Every known slot with its effective value + where it came from, plus any
    per-record overrides. The UI renders exactly this - there is no slot that
    exists only in the database."""
    from models import EgnyteWiring
    rows = db.query(EgnyteWiring).all()
    by_slot: dict[str, list] = {}
    for r in rows:
        by_slot.setdefault(r.slot, []).append(r)
    out = []
    for spec in wiring.KNOWN_SLOTS:
        path, source = wiring.effective(spec["slot"])
        out.append({
            **{k: spec[k] for k in ("slot", "group", "label", "description", "kind",
                                    "placeholders", "overrides")},
            "default": spec["default"],
            "effective": {"path": path, "source": source},
            "overrideRows": [
                {"scopeId": r.scope_id, "path": r.path,
                 "updatedBy": r.updated_by, "updatedAt": r.updated_at}
                for r in by_slot.get(spec["slot"], []) if r.scope_id
            ],
            "customized": any(not r.scope_id for r in by_slot.get(spec["slot"], [])),
        })
    return {"slots": out}


class WiringIn(BaseModel):
    path: str
    scope_id: str = ""


@router.put("/wiring/{slot}")
def wiring_set(slot: str, body: WiringIn, user: dict = Depends(require_manager),
               db: Session = Depends(get_db)):
    from models import EgnyteWiring
    spec = wiring.known_slot(slot)
    if not spec:
        raise HTTPException(404, "Unknown wiring slot")
    path = (body.path or "").strip()
    if not path or len(path) > 800:
        raise HTTPException(400, "path is required (use DELETE to reset to the default)")
    scope = (body.scope_id or "").strip().lower()
    if scope and spec["overrides"] is None:
        raise HTTPException(400, "This slot does not take per-record overrides")
    row = (db.query(EgnyteWiring)
           .filter(EgnyteWiring.slot == slot, EgnyteWiring.scope_id == scope)
           .with_for_update().first())
    if row is None:
        row = EgnyteWiring(id=_uuid.uuid4().hex, slot=slot, scope_id=scope, path=path)
        db.add(row)
    row.path = path
    row.updated_by = user["email"]
    row.updated_at = wiring.now_iso()
    db.commit()
    return {"ok": True}


@router.delete("/wiring/{slot}")
def wiring_reset(slot: str, scope_id: str = "", user: dict = Depends(require_manager),
                 db: Session = Depends(get_db)):
    """Remove a stored wiring - the slot falls back to env var / default."""
    from models import EgnyteWiring
    if not wiring.known_slot(slot):
        raise HTTPException(404, "Unknown wiring slot")
    scope = (scope_id or "").strip().lower()
    (db.query(EgnyteWiring)
     .filter(EgnyteWiring.slot == slot, EgnyteWiring.scope_id == scope)
     .delete())
    db.commit()
    return {"ok": True}


@router.get("/person/{email}")
def person_folder(email: str, user: dict = Depends(_require_hr_read),
                  db: Session = Depends(get_db)):
    """Resolve a person's wired Egnyte folder for the HR person card. HR-gated
    (same grant as the card itself) because the person folder contains the
    Confidential subfolder - the employee-safe view is /myhr/egnyte-documents."""
    _guard()
    from sqlalchemy import func as _f
    from models import NexusEmployee
    emp = (db.query(NexusEmployee)
           .filter(_f.lower(NexusEmployee.work_email) == email.lower()).first())
    if not emp:
        raise HTTPException(404, "No HR record for that email")
    res = wiring.resolve_person_folder("people.person-folder", emp, db)
    folder = res["folder"]
    return {
        "email": email.lower(),
        "folder": folder,
        "webUrl": svc.web_url(folder) if folder else None,
        "missing": folder is None,
        "proposed": res["proposed"],
        "source": res["source"],
    }


# ── person-card actions (Aug 10 - "too hard for a normal HR user"): pointing a
# person at a folder and creating their folder set are ONE-CLICK acts on the
# People card, hr-editor gated. The Wiring tab stays the admin backstage for
# templates; nothing here requires understanding a placeholder.

_require_hr_edit = require_module_grant("hr", "editor")


class PersonFolderIn(BaseModel):
    path: str


def _emp_or_404(email: str, db: Session):
    from sqlalchemy import func as _f
    from models import NexusEmployee
    emp = (db.query(NexusEmployee)
           .filter(_f.lower(NexusEmployee.work_email) == email.lower()).first())
    if not emp:
        raise HTTPException(404, "No HR record for that email")
    return emp


def _person_payload(email: str, emp, db):
    res = wiring.resolve_person_folder("people.person-folder", emp, db)
    folder = res["folder"]
    return {"email": email.lower(), "folder": folder,
            "webUrl": svc.web_url(folder) if folder else None,
            "missing": folder is None, "proposed": res["proposed"], "source": res["source"]}


@router.put("/person/{email}/folder")
def person_folder_point(email: str, body: PersonFolderIn,
                        user: dict = Depends(_require_hr_edit), db: Session = Depends(get_db)):
    """Point this person at an EXISTING Egnyte folder (stored as the per-person
    override on people.person-folder; My Documents follows automatically). The
    folder must really exist - a typo would silently point the card at nothing."""
    _guard()
    from models import EgnyteWiring
    emp = _emp_or_404(email, db)
    path = svc.norm((body.path or "").strip())
    if not path:
        raise HTTPException(400, "Pick a folder first")
    try:
        svc.list_folder(path)
    except svc.EgnyteError as exc:
        raise HTTPException(400, "That folder does not exist in Egnyte" if exc.status == 404 else str(exc))
    scope = email.lower()
    row = (db.query(EgnyteWiring)
           .filter(EgnyteWiring.slot == "people.person-folder", EgnyteWiring.scope_id == scope)
           .with_for_update().first())
    if row is None:
        row = EgnyteWiring(id=_uuid.uuid4().hex, slot="people.person-folder", scope_id=scope, path=path)
        db.add(row)
    row.path = path
    row.updated_by = user["email"]
    row.updated_at = wiring.now_iso()
    db.commit()
    return _person_payload(email, emp, db)


@router.post("/person/{email}/provision")
def person_folder_provision(email: str, user: dict = Depends(_require_hr_edit),
                            db: Session = Depends(get_db)):
    """Create the person's standard folder set (person folder + Contractor
    Documents + Confidential) under the wired location. Idempotent - an
    existing folder just gains any missing subfolders."""
    _guard()
    emp = _emp_or_404(email, db)
    try:
        wiring.provision_person_folder(emp, db)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except svc.EgnyteError as exc:
        raise HTTPException(exc.status, str(exc))
    return _person_payload(email, emp, db)


# ── folder groups (Aug 10 - "create me a folder group for people who are
# working from the US and have biweekly salary"). A plain-English prompt is
# parsed by the Claude API into a closed-vocabulary rule (egnyte_wiring
# RULE_FIELDS - the model can only produce conditions the matcher
# understands), previewed with the people it matches, attached to a real
# Egnyte folder, and saved. Membership is evaluated at resolution time, so a
# new hire who fits the rule is wired the day they appear - nobody clicks
# per-person overrides. Manager+ like the rest of the wiring.

import json as _json
import os as _os

import httpx as _httpx

_AI_MODEL = _os.getenv("NEXUS_AI_MODEL", "claude-opus-4-8")
_ANTHROPIC_API_KEY = _os.getenv("ANTHROPIC_API_KEY", "")


def _grounding(db) -> dict:
    """Real values from THIS company's data, given to the model so it maps
    words onto rows that exist instead of inventing labels."""
    from models import HrEntity, NexusEmployee
    ents = db.query(HrEntity).all()
    emps = db.query(NexusEmployee).filter(NexusEmployee.status != "offboarded").all()
    return {
        "entities": [{"name": e.name, "country": e.country or ""} for e in ents],
        "departments": sorted({e.department for e in emps if e.department}),
        "divisions": sorted({(getattr(e, "division", "") or "") for e in emps} - {""}),
    }


def _ai_parse_rule(prompt: str, grounding: dict) -> dict:
    """Prompt -> {name, conditions[], notes}. Raises HTTPException with a
    human message on any failure - the UI shows it verbatim."""
    if not _ANTHROPIC_API_KEY:
        raise HTTPException(503, "AI parsing is not configured (ANTHROPIC_API_KEY is not set on this environment).")
    fields_doc = "\n".join(f"- {k}: {v}" for k, v in wiring.RULE_FIELDS.items())
    ask = (
        "You translate a manager's plain-English description of a group of employees into a "
        "STRICT JSON rule for an internal HR system.\n\n"
        "ALLOWED FIELDS (a condition may use ONLY these; all conditions are ANDed):\n"
        f"{fields_doc}\n\n"
        "REAL DATA in this company (map words onto these, never invent values):\n"
        f"Legal entities: {_json.dumps(grounding['entities'])}\n"
        f"Departments: {_json.dumps(grounding['departments'])}\n"
        f"Divisions: {_json.dumps(grounding['divisions'])}\n\n"
        "Mapping hints: 'working in/from the US' -> entity_country US; 'India team' -> entity_country IN; "
        "'biweekly salary/pay' -> pay_type hourly; 'monthly salary/fixed salary' -> pay_type fixed; "
        "'contractors' -> employment_type contractor.\n\n"
        f"MANAGER'S DESCRIPTION: {prompt}\n\n"
        'Answer with ONLY this JSON (no fences, no prose): {"name": "<short Title Case group name>", '
        '"conditions": [{"field": "<allowed field>", "value": "<value>"}], '
        '"notes": "<anything in the description you could NOT map, else empty string>"}'
    )
    # Errors here are 503/424, NEVER 502: Cloudflare replaces an origin 502
    # with its own branded HTML error page, so the UI showed a bare "API error
    # 502" instead of the real reason (Aug 10). The details below surface
    # verbatim in the UI and the true upstream error is printed to the logs.
    try:
        with _httpx.Client(timeout=60) as client:
            r = client.post(
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": _ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01",
                         "content-type": "application/json"},
                json={"model": _AI_MODEL, "max_tokens": 500,
                      "messages": [{"role": "user", "content": ask}]},
            )
        if r.status_code != 200:
            snippet = (r.text or "")[:200]
            print(f"[egnyte-groups] AI call failed: HTTP {r.status_code}: {snippet}")
            raise HTTPException(424, f"The AI service answered {r.status_code}: {snippet}")
        text = "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text").strip()
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        print(f"[egnyte-groups] AI call failed: {type(e).__name__}: {e}")
        raise HTTPException(503, f"The AI service could not be reached ({type(e).__name__}) - try again in a moment.")
    if text.startswith("```"):
        text = text.strip("`").removeprefix("json").strip()
    try:
        parsed = _json.loads(text)
    except Exception:
        raise HTTPException(424, "The AI answer could not be understood - try rephrasing the description.")
    conditions, dropped = [], []
    for c in (parsed.get("conditions") or []):
        f, v = (c.get("field") or "").strip(), str(c.get("value") or "").strip()
        if f in wiring.RULE_FIELDS and v:
            conditions.append({"field": f, "value": v})
        elif f or v:
            dropped.append(f or v)
    notes = (parsed.get("notes") or "").strip()
    if dropped:
        notes = (notes + " " if notes else "") + f"Ignored unmappable condition(s): {', '.join(dropped)}."
    if not conditions:
        raise HTTPException(400, "Nothing in that description mapped to people data - try naming a country, company, department, pay cycle, or employment type.")
    return {"name": (parsed.get("name") or "").strip() or "New Folder Group",
            "conditions": conditions, "notes": notes}


def _suggest_folders(rule: list, db) -> list:
    """Existing HR parent folders that plausibly host this cohort - the
    entities the rule points at, their Human Resources buckets. Best effort,
    capped, and only ever REAL folders (walked, not constructed)."""
    from models import HrEntity
    want_country = next((c["value"] for c in rule if c["field"] == "entity_country"), "")
    want_company = next((c["value"] for c in rule if c["field"] == "company"), "")
    ents = db.query(HrEntity).all()
    fold = wiring._fold
    cands = [e for e in ents
             if (not want_country or fold(e.country or "") == fold(want_country))
             and (not want_company or fold(want_company) in fold(e.name or ""))]
    out = []
    try:
        roots = svc.list_folder("/Shared/#Entities")["folders"]
    except svc.EgnyteError:
        return out
    by_fold = {fold(f["name"]): f for f in roots}
    for e in cands[:5]:
        ename = fold(e.name or "")
        hit = by_fold.get(ename) or next(
            (f for k, f in by_fold.items() if ename and ename in k), None)
        if not hit:
            continue
        try:
            hr = next((f for f in svc.list_folder(hit["path"])["folders"]
                       if fold(f["name"]) in ("human resources", "hr")), None)
            if not hr:
                continue
            for sub in svc.list_folder(hr["path"])["folders"]:
                if fold(sub["name"]) in ("contractors", "employees"):
                    out.append(sub["path"])
        except svc.EgnyteError:
            continue
        if len(out) >= 4:
            break
    return out[:4]


class GroupDraftIn(BaseModel):
    prompt: str


class GroupIn(BaseModel):
    name: str
    prompt: str = ""
    rule: list
    path: str


def _ser_group(row, count=None) -> dict:
    return {"id": row.id, "name": row.name, "prompt": row.prompt or "",
            "rule": row.rule or [], "path": row.path, "enabled": bool(row.enabled),
            "createdBy": row.created_by, "createdAt": row.created_at,
            **({"memberCount": count} if count is not None else {})}


@router.post("/folder-groups/draft")
def folder_group_draft(body: GroupDraftIn, user: dict = Depends(require_manager),
                       db: Session = Depends(get_db)):
    _guard()
    prompt = (body.prompt or "").strip()
    if len(prompt) < 8:
        raise HTTPException(400, "Describe the group in a sentence - who is it for?")
    parsed = _ai_parse_rule(prompt, _grounding(db))
    members = wiring.people_matching(parsed["conditions"], db)
    return {
        "name": parsed["name"],
        "rule": parsed["conditions"],
        "notes": parsed["notes"],
        "members": [{"email": (m.work_email or "").lower(), "name": wiring.person_label(m)} for m in members],
        "folderSuggestions": _suggest_folders(parsed["conditions"], db),
    }


@router.get("/folder-groups")
def folder_groups_list(user: dict = Depends(require_manager), db: Session = Depends(get_db)):
    from models import EgnyteFolderGroup
    rows = db.query(EgnyteFolderGroup).order_by(EgnyteFolderGroup.created_at.desc()).all()
    return {"groups": [_ser_group(r, len(wiring.people_matching(r.rule or [], db))) for r in rows]}


@router.post("/folder-groups")
def folder_group_create(body: GroupIn, user: dict = Depends(require_manager),
                        db: Session = Depends(get_db)):
    _guard()
    from models import EgnyteFolderGroup
    name = (body.name or "").strip()
    path = svc.norm((body.path or "").strip())
    rule = [c for c in (body.rule or [])
            if isinstance(c, dict) and (c.get("field") or "") in wiring.RULE_FIELDS and str(c.get("value") or "").strip()]
    if not name:
        raise HTTPException(400, "Give the group a name")
    if not rule:
        raise HTTPException(400, "The group needs at least one condition")
    if path in ("", "/", "/Shared"):
        raise HTTPException(400, "Pick the group's folder first")
    try:
        svc.list_folder(path)
    except svc.EgnyteError as exc:
        raise HTTPException(400, "That folder does not exist in Egnyte" if exc.status == 404 else str(exc))
    row = EgnyteFolderGroup(id=_uuid.uuid4().hex, name=name, prompt=(body.prompt or "").strip(),
                            rule=rule, path=path, enabled=1,
                            created_by=user["email"], created_at=wiring.now_iso(),
                            updated_by=user["email"], updated_at=wiring.now_iso())
    db.add(row)
    db.commit()
    return _ser_group(row, len(wiring.people_matching(rule, db)))


@router.delete("/folder-groups/{gid}")
def folder_group_delete(gid: str, user: dict = Depends(require_manager),
                        db: Session = Depends(get_db)):
    from models import EgnyteFolderGroup
    n = db.query(EgnyteFolderGroup).filter(EgnyteFolderGroup.id == gid).delete()
    db.commit()
    if not n:
        raise HTTPException(404, "No such folder group")
    return {"ok": True}


@router.post("/folder-groups/{gid}/sync")
def folder_group_sync(gid: str, user: dict = Depends(require_manager),
                      db: Session = Depends(get_db)):
    """Make Egnyte match the rule: every matching person gets a subfolder in
    the group folder (found by folded name-match, created with the standard
    Contractor Documents + Confidential set when missing). One folder listing,
    not one walk per person."""
    _guard()
    from models import EgnyteFolderGroup
    row = db.query(EgnyteFolderGroup).filter(EgnyteFolderGroup.id == gid).first()
    if not row:
        raise HTTPException(404, "No such folder group")
    members = wiring.people_matching(row.rule or [], db)
    try:
        children = svc.list_folder(row.path)["folders"]
    except svc.EgnyteError as exc:
        raise HTTPException(exc.status, f"Could not open the group folder: {exc}")
    fold = wiring._fold
    by_fold = [(fold(f["name"]), f["name"]) for f in children]
    existing, created, errors = [], [], []
    for m in members:
        label = wiring.person_label(m)
        want = fold(label)
        if not want:
            continue
        hit = next((n for k, n in by_fold if k == want), None) \
            or next((n for k, n in by_fold if k.startswith(want)), None) \
            or next((n for k, n in by_fold if want in k), None)
        if hit:
            existing.append({"name": label, "folder": f"{row.path}/{hit}"})
            continue
        target = svc.norm(f"{row.path}/{label}")
        try:
            svc.create_folder(target)
            for sub in ("Contractor Documents", "Confidential"):
                try:
                    svc.create_folder(f"{target}/{sub}")
                except svc.EgnyteError:
                    pass
            created.append({"name": label, "folder": target})
        except svc.EgnyteError as exc:
            errors.append({"name": label, "error": str(exc)})
    return {"members": len(members), "created": created, "existing": existing, "errors": errors}
