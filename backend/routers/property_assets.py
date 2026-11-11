"""Asset Management (property portfolio) - Ankush's module.

The frontend (frontend/src/views/AssetModule.jsx) treats its data as one
workspace blob: { properties, warranties, inspections, documents, ahj,
utilities, vendors, logs }. It used to live in the browser's localStorage;
this router moves it to a shared Supabase-backed store so every user sees the
same portfolio.

Storage is intentionally simple: the property objects and each child row are
kept whole in JSON `payload` columns (the data is semi-structured - free-form
snapshot/timeline/permit sheets plus a wide, evolving set of header fields), so
the workspace round-trips losslessly with no per-field schema churn. The
dataset is tiny (~24 properties + a few hundred child rows), so a whole-blob
GET / replace-all PUT is the pragmatic, low-risk shape. Later phases can promote
warranty/inspection date columns for expiry notifications.
"""
import os
import time
from datetime import datetime, timezone, date
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from auth import require_module_grant, scoped_ids
from property_links import can_see_private, viewable
from models import PropertyAsset, PropertyRecord, PropertyActivityLog, PropertyWorkspaceMeta

router = APIRouter(tags=["Asset Management"])

# Screen access is grant-driven (property-asset Access Group grant); mirror it
# here so the API can't be read/overwritten by users the UI hides it from.
require_asset_read  = require_module_grant("property-asset", "viewer")
require_asset_write = require_module_grant("property-asset", "editor")

# Activity-log rows kept per asset (newest first); the rest are dropped on save.
LOG_CAP_PER_ASSET = 500

# Files live in the PRIVATE asset-files bucket (routers/files.py PROTECTED_BUCKETS);
# a record keeps the canonical URL. Only that bucket's URLs are accepted for a
# photo or document - a data: URL is 20 lines of base64 in every save and load.
# Existing data: URLs are tolerated until asset_files_migrate moves them; a NEW
# one is refused. With no storage configured (a local backend) anything goes.
_SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
_FILES_PREFIX = f"{_SUPABASE_URL}/storage/v1/object/public/asset-files/" if _SUPABASE_URL else ""
PROPERTY_FILE_FIELDS = ("image",)
RECORD_FILE_FIELDS = ("docFile",)


def _file_values(payload: Dict[str, Any], keys) -> List[str]:
    out = []
    for k in keys:
        v = payload.get(k)
        if isinstance(v, str) and v:
            out.append(v)
    images = payload.get("images")
    for v in images if isinstance(images, list) else []:
        if isinstance(v, str) and v:
            out.append(v)
    return out


def _check_file_rows(rows, db: Session) -> None:
    """`rows` = [(what, payload, keys)]. 400 on a data: URL the server has not
    seen before (one it already holds is still migrating). Anything that is not
    a data: URL is left alone: a bucket URL, a legacy /assets path or an outside
    link is a link, not an upload - refusing it would make the row unsaveable.
    The known set is only built when a data: URL is in the payload at all."""
    if not _FILES_PREFIX:
        return
    fresh = [(what, row, keys) for what, row, keys in rows
             if any(v.startswith("data:") for v in _file_values(row, keys))]
    if not fresh:
        return
    known: set = set()
    for p in db.query(PropertyAsset).all():
        known.update(v for v in _file_values(p.payload or {}, PROPERTY_FILE_FIELDS) if v.startswith("data:"))
    for r in db.query(PropertyRecord).all():
        known.update(v for v in _file_values(r.payload or {}, RECORD_FILE_FIELDS) if v.startswith("data:"))
    for what, row, keys in fresh:
        for v in _file_values(row, keys):
            if v.startswith("data:") and v not in known:
                name = row.get("name") or row.get("id") or what
                raise HTTPException(status_code=400, detail=f"A photo or document on {name} is not stored in Nexus storage. Upload it again.")


def _carry_over(payload: Dict[str, Any], existing: Dict[str, Any], keys) -> None:
    """What the server did to a row while a tab held it travels with the tab's
    next save instead of being undone by it: a data: value the migration has
    already moved takes the bucket URL the row holds now (same field, same
    position), and the geocoded point stays when the address it was looked up
    for is unchanged."""
    if not existing:
        return
    for k in keys:
        v = payload.get(k)
        w = existing.get(k)
        if isinstance(v, str) and v.startswith("data:") and isinstance(w, str) and _FILES_PREFIX and w.startswith(_FILES_PREFIX):
            payload[k] = w
    imgs, had = payload.get("images"), existing.get("images")
    if isinstance(imgs, list) and isinstance(had, list) and len(imgs) == len(had):
        payload["images"] = [w if (isinstance(v, str) and v.startswith("data:") and isinstance(w, str) and _FILES_PREFIX and w.startswith(_FILES_PREFIX)) else v
                             for v, w in zip(imgs, had)]
        if isinstance(payload.get("image"), str) and payload["image"].startswith("data:") and payload["images"] and isinstance(payload["images"][0], str) and not payload["images"][0].startswith("data:"):
            payload["image"] = payload["images"][0]
    geo = existing.get("geo")
    if "geo" not in payload and isinstance(geo, dict) and geo.get("for"):
        from asset_geocode import address_of
        if address_of(payload) == geo.get("for"):
            payload["geo"] = geo


# The flat child collections the module persists alongside properties + logs.
# vservice/odometer are the vehicle & equipment service/maintenance + odometer logs.
COLLECTIONS = ["warranties", "inspections", "documents", "ahj", "utilities", "vendors",
               "vservice", "odometer", "vdocs", "maintenance"]


def _check_files(ws: "Workspace", db: Session) -> None:
    rows = [("property", p, PROPERTY_FILE_FIELDS) for p in ws.properties]
    rows += [(c, r, RECORD_FILE_FIELDS) for c in COLLECTIONS for r in (getattr(ws, c) or [])]
    _check_file_rows(rows, db)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Workspace(BaseModel):
    properties: List[Dict[str, Any]] = []
    warranties: List[Dict[str, Any]] = []
    inspections: List[Dict[str, Any]] = []
    documents: List[Dict[str, Any]] = []
    ahj: List[Dict[str, Any]] = []
    utilities: List[Dict[str, Any]] = []
    vendors: List[Dict[str, Any]] = []
    vservice: List[Dict[str, Any]] = []
    odometer: List[Dict[str, Any]] = []
    vdocs: List[Dict[str, Any]] = []
    maintenance: List[Dict[str, Any]] = []
    logs: List[Dict[str, Any]] = []
    # Optimistic-concurrency marker: the server _ts this client's copy is based
    # on. Every client sends one; a save without it is stale once the server
    # holds anything (it cannot have pulled).
    baseTs: Optional[int] = None


def _reach(db: Session, user) -> tuple:
    """(sees_private, allowed_ids or None). Private assets are for officers (the
    server mirror of App.jsx canSeePrivate, property_links.can_see_private);
    nexus_access_scopes rows for property-asset narrow a person to listed ids."""
    user = user or {}
    return can_see_private(user), scoped_ids(user.get("email", ""), "property-asset", db)


def _visible_ids(db: Session, user) -> set:
    sees_private, allowed = _reach(db, user)
    out = set()
    for p in db.query(PropertyAsset).all():
        if not viewable(p, user):
            continue
        if allowed is not None and p.id not in allowed:
            continue
        out.add(p.id)
    return out


@router.get("/property-assets/workspace")
def get_workspace(db: Session = Depends(get_db), user=Depends(require_asset_read)):
    """The portfolio workspace in the shape the module renders - only the assets
    this caller may see (private ones are officers' alone, scope rows narrow
    the rest), with their records and log entries; every row carries `_rev`,
    the server stamp a later row save is checked against."""
    ws: Dict[str, Any] = {"properties": []}
    for c in COLLECTIONS:
        ws[c] = []
    visible = _visible_ids(db, user)
    for p in db.query(PropertyAsset).all():
        if p.id not in visible:
            continue
        obj = dict(p.payload or {})
        obj["id"] = p.id  # the id is the source of truth on the row
        obj["_rev"] = p.updated_at or ""
        ws["properties"].append(obj)
    for r in db.query(PropertyRecord).all():
        if r.collection in ws and (r.property_id in visible):
            obj = dict(r.payload or {})
            obj["_rev"] = r.updated_at or ""
            ws[r.collection].append(obj)
    # The log is kept whole in the database (nothing is ever trimmed); the
    # workspace carries the newest LOG_CAP_PER_ASSET entries per asset.
    per_asset: Dict[str, int] = {}
    logs = []
    for l in db.query(PropertyActivityLog).order_by(PropertyActivityLog.created_at.desc()).all():
        if l.property_id not in visible:
            continue
        per_asset[l.property_id] = per_asset.get(l.property_id, 0) + 1
        if per_asset[l.property_id] <= LOG_CAP_PER_ASSET:
            logs.append(l.payload or {})
    ws["logs"] = logs
    # Server-stamped freshness marker - clients pull whenever this moves past the
    # last value they saw (value-only edits move it too, unlike the log count).
    meta = db.get(PropertyWorkspaceMeta, 1)
    ws["_ts"] = (meta.ts if meta else 0) or 0
    return ws


@router.get("/property-assets/workspace/ts")
def get_workspace_ts(db: Session = Depends(get_db), user=Depends(require_asset_read)):
    """Just the workspace freshness marker (server epoch ms), from the one-row meta
    table. The module's background poll runs every 7s; having it check THIS first -
    a few bytes - instead of re-pulling the whole portfolio blob (properties +
    records + activity logs) means it only downloads the full workspace when
    something actually changed. That full-blob poll was a top pooler-egress driver."""
    meta = db.get(PropertyWorkspaceMeta, 1)
    return {"_ts": (meta.ts if meta else 0) or 0}


@router.put("/property-assets/workspace")
def put_workspace(ws: Workspace, db: Session = Depends(get_db), user=Depends(require_asset_write)):
    """Replace the whole workspace. Tiny dataset → delete-all + re-insert in one
    request is simplest and matches the module's whole-blob save semantics."""
    now = _now()
    email = (user or {}).get("email", "")
    if not can_see_private(user):
        raise HTTPException(status_code=403, detail="Replacing the whole portfolio is an officer's tool - row saves go through /property-assets/changes.")
    if _reach(db, user)[1] is not None:
        raise HTTPException(status_code=403, detail="Replacing the whole portfolio needs reach over every asset - row saves go through /property-assets/changes.")
    # A deployed API (storage configured) takes a whole-blob replace only when
    # NEXUS_ASSET_SEED_PUT is set for a seeding session: an old tab's blob would
    # otherwise undo every row saved since it last pulled.
    if _SUPABASE_URL and os.getenv("NEXUS_ASSET_SEED_PUT", "").strip().lower() not in ("1", "true", "yes"):
        raise HTTPException(status_code=403, detail="Whole-portfolio saves are off. Reload Asset Management - this tab is running an old version.")

    # Refuse a STALE overwrite: this is a whole-blob replace, so a client whose
    # copy predates the server's would silently erase everything saved since it
    # last pulled (mid-edit sessions suppress pulls, so long sessions get very
    # stale). 409 'stale' → the client pulls, merges by row id, and retries -
    # nobody's work is dropped on either side.
    # The meta row is locked for the whole replace: two saves with the same
    # baseTs used to both pass the check, and the second then hit the first's
    # re-inserted ids (a 500, not a 409). Locked, the second waits and sees the
    # new ts. A client that sends no baseTs is stale by definition now that
    # every client sends one.
    cur_meta = db.query(PropertyWorkspaceMeta).filter(PropertyWorkspaceMeta.id == 1).with_for_update().first()
    server_ts = (cur_meta.ts if cur_meta else 0) or 0
    if server_ts and (ws.baseTs is None or ws.baseTs < server_ts):
        raise HTTPException(status_code=409,
                            detail="stale: the portfolio changed since this tab last pulled - merge and retry")

    # Refuse a wipe: a client that booted during an outage starts from an EMPTY
    # store, and its first save would replace-all a populated portfolio with
    # nothing. Deleting the genuinely-last asset (server count <= 1) is allowed;
    # 0-over-many can only be a broken client. 409 → the client's sync queue
    # drops the write and re-pulls instead of retrying forever.
    if not ws.properties and db.query(PropertyAsset).count() > 1:
        raise HTTPException(status_code=409, detail="Refusing to replace a populated portfolio with an empty one")

    _check_files(ws, db)

    db.query(PropertyRecord).delete()
    db.query(PropertyAsset).delete()
    db.flush()

    for p in ws.properties:
        pid = str(p.get("id") or "").strip()
        if not pid:
            continue
        db.add(PropertyAsset(
            id=pid,
            name=str(p.get("name") or ""),
            manager=str(p.get("manager") or ""),
            asset_type=str(p.get("assetType") or ""),
            parent_id=str(p.get("parentId") or ""),
            payload=p,
            updated_at=now,
            updated_by=email,
        ))

    for c in COLLECTIONS:
        for r in (getattr(ws, c) or []):
            rid = str(r.get("id") or "").strip()
            if not rid:
                continue
            db.add(PropertyRecord(
                id=rid,
                property_id=str(r.get("propertyId") or ""),
                collection=c,
                payload=r,
                updated_at=now,
            ))

    # The log is append-only: a blob save adds the entries it carries that the
    # database does not have yet and never removes one (the workspace GET
    # bounds what a client sees, the database keeps everything). An entry
    # keeps the client's stamp (the Activity Log shows when the person made
    # the change); one without gets the server's.
    for entry in ws.logs:
        lid = str(entry.get("id") or "").strip()
        if not lid or db.get(PropertyActivityLog, lid) is not None:
            continue
        pid = str(entry.get("propertyId") or "")
        db.add(PropertyActivityLog(
            id=lid,
            property_id=pid,
            payload=entry,
            created_at=str(entry.get("ts") or now),
        ))

    # Stamp the workspace's freshness marker with SERVER time (epoch ms) so pull
    # decisions never depend on any client's clock.
    ts_ms = int(time.time() * 1000)
    meta = cur_meta
    if meta is None:
        meta = PropertyWorkspaceMeta(id=1)
        db.add(meta)
    meta.ts = ts_ms
    meta.updated_by = email
    meta.updated_at = now

    db.commit()
    return {"ok": True, "properties": len(ws.properties), "_ts": ts_ms}


class RowOps(BaseModel):
    upsert: List[Dict[str, Any]] = []
    delete: List[str] = []
    deleteRevs: Dict[str, str] = {}   # id -> the _rev the row was read with


class LogOps(BaseModel):
    append: List[Dict[str, Any]] = []
    update: List[Dict[str, Any]] = []   # {id, undone}: the one flag that changes on an entry


class Changes(BaseModel):
    """One batch of row saves from a tab (Oct 21 2026): each row is written on
    its own, so two people editing different rows never overwrite each other.
    A row carries the `_rev` it was read with; a row the server has changed
    since is skipped and reported in `conflicts` for the tab to re-pull."""
    properties: RowOps = RowOps()
    warranties: RowOps = RowOps()
    inspections: RowOps = RowOps()
    documents: RowOps = RowOps()
    ahj: RowOps = RowOps()
    utilities: RowOps = RowOps()
    vendors: RowOps = RowOps()
    vservice: RowOps = RowOps()
    odometer: RowOps = RowOps()
    vdocs: RowOps = RowOps()
    maintenance: RowOps = RowOps()
    logs: LogOps = LogOps()


def _stale(existing, rev) -> bool:
    """A row the server has stamped is written only with the stamp it was read
    with: a different one, or none at all (a tab that read the row before the
    stamps existed, or a cached copy), is someone else's turn."""
    if existing is None or not existing.updated_at:
        return False
    return rev is None or str(rev) != existing.updated_at


def _strip_rev(row: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in row.items() if k != "_rev"}


# ── Company (Neil, 11/03/2026) ───────────────────────────────────────────────
# An asset's company is its payload's `companyId` (an HrEntity id) - the field
# property_links.property_company reads before any inference. A save that
# CHANGES it is checked here: the new value must be a company in Nexus that the
# saver may assign (auth.company_scope - a Super Administrator or an unwalled
# caller any, a walled Administrator / walled person only their companies),
# the asset must not be leaving a company outside the saver's reach, and only
# an unwalled caller may clear it. An unchanged value is never re-checked (a
# walled editor still saves the rest of a row placed elsewhere), and a row
# saved without the key keeps the company it has (a tab that never read the
# field cannot erase it - nothing is deleted by code). A refused row is
# reported in `refused` and the rest of the batch still saves.

_COMPANY_KEY = "companyId"


class _Scope:
    """The saver's company scope, read once per batch and only when needed."""
    def __init__(self, db: Session, user):
        self.db, self.user, self._v, self._read = db, user, None, False

    def get(self):
        if not self._read:
            import auth
            self._v, self._read = auth.company_scope(self.user or {}, self.db), True
        return self._v


def _check_company(db: Session, scope: "_Scope", existing, payload: Dict[str, Any]):
    """None when the row's company may be saved as it stands, else the
    refusal (status, message). A refusal is per ROW (review, 11/03/2026):
    post_changes reports it in `refused` and saves the rest of the batch."""
    import auth
    from models import HrEntity
    had = str(((existing.payload or {}) if existing is not None else {}).get(_COMPANY_KEY) or "").strip()
    if _COMPANY_KEY not in payload:
        if had:
            payload[_COMPANY_KEY] = had
        return None
    new = str(payload.get(_COMPANY_KEY) or "").strip()
    payload[_COMPANY_KEY] = new
    if new == had:
        return None
    reach = scope.get()
    if had and reach is not None and db.get(HrEntity, had) is not None and had not in reach:
        return 403, "This asset belongs to a company outside yours - a Super Administrator can move it."
    if not new:
        if reach is not None:
            return 403, "Only a Super Administrator can clear an asset's company - pick another company instead."
        return None
    if db.get(HrEntity, new) is None:
        return 400, "That company is not in Nexus - pick one from the list."
    if not auth.company_ok(new, reach):
        return 403, "You can put an asset only in a company you manage."
    return None


# ── Egnyte Folder (Neil, 11/03/2026) ─────────────────────────────────────────
# "Should a property be able to pin its exact Egnyte folder instead of matching
# by name?" - yes. The pin is the payload's `egnyteFolder`; the construction
# filer uses it before any name match and never guesses when it is missing
# (construction_worker.property_folder). Set by whoever may edit the asset (the
# same row save and guard as every other field; a private asset stays an
# officer's). A CHANGED value is checked and stored normalized
# (services/egnyte.normalize_pinned_folder: inside the property roots, no '..');
# blank unpins. Makes no Egnyte call, so it saves with Egnyte not set up. As
# with the company, a row saved without the key keeps its pin, and an
# unchanged value is never re-checked (roots moved since stay the filer's
# business - it holds the files rather than guess).
#
# Connecting is ONE TIME (Neil, 11/05/2026): any editor of the asset connects
# an unpinned asset; once pinned, only an Asset Management OWNER (the Owner
# grant on property-asset, or a Super Administrator) may change or clear it.

_EGNYTE_KEY = "egnyteFolder"
_REPIN_REFUSED = "This asset's Egnyte folder is connected - only an Asset Management Owner can change it."


def may_repin_egnyte(db: Session, user) -> bool:
    """True when this caller may change or clear a connected Egnyte folder."""
    from auth import _module_level, _MODULE_LEVEL_RANK
    user = user or {}
    if int(user.get("level", 0) or 0) >= 5:
        return True
    return _module_level(user.get("email", ""), "property-asset", db) >= _MODULE_LEVEL_RANK["owner"]


def _check_egnyte_folder(existing, payload: Dict[str, Any], may_repin: bool = False):
    """None when the row's Egnyte Folder may be saved as it stands, else the
    refusal (status, message) - per row, like _check_company."""
    from services import egnyte as egnyte_svc
    had = str(((existing.payload or {}) if existing is not None else {}).get(_EGNYTE_KEY) or "").strip()
    if _EGNYTE_KEY not in payload:
        if had:
            payload[_EGNYTE_KEY] = had
        return None
    raw = payload.get(_EGNYTE_KEY)
    if raw is not None and not isinstance(raw, str):
        return 400, "The Egnyte folder must be a folder path"
    new = (raw or "").strip()
    if new == had:
        payload[_EGNYTE_KEY] = had
        return None
    if had and not may_repin:
        return 403, _REPIN_REFUSED
    try:
        payload[_EGNYTE_KEY] = egnyte_svc.normalize_pinned_folder(new)
    except ValueError as e:
        return 400, str(e)
    return None


class _FillRevs:
    """What the one-time Company fill did to each row (asset_company_fill),
    read once per batch and only when a stale row needs it."""
    def __init__(self, db: Session):
        self.db, self._v = db, None

    def get(self) -> dict:
        if self._v is None:
            import asset_company_fill
            self._v = asset_company_fill.filled_revs(self.db)
        return self._v


def _filled_since(fill: "_FillRevs", existing, rev) -> str:
    """The company the one-time fill set on this row when the fill is the ONLY
    change since the tab read it (its rev is the pre-fill one and the row
    still carries the fill's stamp) - '' otherwise. A save a tab queued over
    the deploy window is then not a conflict: it is taken, and the row keeps
    the filled company (review, 11/03/2026). A row stamped by anyone after
    the fill is an ordinary conflict again."""
    if existing is None:
        return ""
    entry = fill.get().get(existing.id) or {}
    if not entry or existing.updated_at != entry.get("to"):
        return ""
    before = entry.get("from") or ""
    # An unstamped row took any save before the fill (_stale), so it still does.
    if before and str(rev or "") != before:
        return ""
    return str(entry.get("companyId") or "")


def assignable_companies(db: Session, user) -> List[Dict[str, Any]]:
    """The companies the Company picker offers this caller: every company they
    may assign (their company scope), plus - named, not assignable - any other
    company an asset they can see already sits in, so the screen can show it."""
    import auth
    from models import HrEntity
    reach = auth.company_scope(user or {}, db)
    visible = _visible_ids(db, user)
    used = {str((p.payload or {}).get(_COMPANY_KEY) or "").strip()
            for p in db.query(PropertyAsset).all() if p.id in visible}
    out = []
    for e in db.query(HrEntity).order_by(HrEntity.name).all():
        ok = auth.company_ok(e.id, reach)
        if ok or e.id in used:
            out.append({"id": e.id, "name": e.name or "", "assignable": ok})
    return out


@router.get("/property-assets/companies")
def get_companies(db: Session = Depends(get_db), user=Depends(require_asset_read)):
    """The Company picker's list (see assignable_companies) and whether this
    caller may leave an asset with no company (only an unwalled one)."""
    import auth
    return {"companies": assignable_companies(db, user),
            "canClear": auth.company_scope(user or {}, db) is None}


_FIND_WORDS = {
    "matched": "",
    "ambiguous": "More than one Egnyte folder could be this property's - pick the right one.",
    "no_match": "No Egnyte folder matched this name - paste the folder's path, or search another name.",
}


@router.get("/property-assets/{pid}/egnyte-folders")
def find_egnyte_folders(pid: str, q: str = "", db: Session = Depends(get_db), user=Depends(require_asset_write)):
    """Find Folder on an asset's Egnyte Folder field: the Egnyte folders
    whose name could be this asset's (or `q`'s), best first, with the one the
    name match would pick - for the person to choose; nothing is pinned or
    written here (the pick saves through the row save). Read only. Editors
    of the asset only, inside its privacy and scope (404 otherwise, as if it
    were not there).

    With Egnyte not set up it answers `configured: false` and says so; the
    field still takes a pasted path. A sync route on purpose - it lists
    Egnyte, so FastAPI runs it in its thread pool, off the event loop."""
    from services import egnyte as egnyte_svc
    prop = db.get(PropertyAsset, pid)
    if prop is None or pid not in _visible_ids(db, user):
        raise HTTPException(status_code=404, detail="That asset is not here.")
    site = (q or "").strip()[:200] or (prop.name or "").strip()
    pinned = str((prop.payload or {}).get(_EGNYTE_KEY) or "").strip()
    out = {"configured": False, "site": site, "roots": egnyte_svc.pin_roots(), "pinned": pinned,
           "pinnedFound": None, "match": None, "why": "", "candidates": [], "message": "", "error": ""}
    if not egnyte_svc.configured():
        out["message"] = "Egnyte is not set up on this server - paste the folder's path instead."
        return out
    out["configured"] = True
    try:
        found = egnyte_svc.property_folder_candidates(site) if site else {"match": None, "why": "no_match", "candidates": []}
        if pinned:
            try:
                ok = bool(egnyte_svc.normalize_pinned_folder(pinned))
            except ValueError:
                ok = False      # outside the roots now - the filer holds its files
            out["pinnedFound"] = egnyte_svc.folder_exists(pinned) if ok else False
    except Exception as e:   # EgnyteError, or httpx giving up on the connection
        # A 200 with `error`, not a 5xx: Egnyte being down is not Nexus being
        # down (api.js would show the reconnecting banner and retry).
        print(f"[property-assets] Find Folder for {pid}: {e}")
        out["error"] = "Egnyte did not answer - try again in a minute."
        return out
    out.update(match=found["match"], why=found["why"], candidates=found["candidates"],
               message=_FIND_WORDS.get(found["why"], ""))
    return out


# ── Documents from the connected Egnyte folder (Neil, 11/05/2026) ───────────
# "Nobody should be lost in Egnyte to see the docs": anyone who may see the
# asset in Asset Management - viewers included - browses and opens the files
# in its connected folder, read only, whether or not they have Egnyte access
# of their own. So these routes read with the SHARED Egnyte service token and
# the asset is the permission: the caller must see the asset (privacy and
# scope rows, 404 otherwise) and every path must sit inside its pinned folder.
# Nothing is copied or indexed; no write path. Sync routes - FastAPI runs them
# in its thread pool, off the event loop.

_DOCS_TIMEOUT = 50   # a big folder can take Egnyte this long (routers/egnyte._BROWSE_TIMEOUT)


def _pinned_for(db: Session, user, pid: str) -> str:
    prop = db.get(PropertyAsset, pid)
    if prop is None or pid not in _visible_ids(db, user):
        raise HTTPException(status_code=404, detail="That asset is not here.")
    return str((prop.payload or {}).get(_EGNYTE_KEY) or "").strip()


def inside_folder(root: str, path: str, allow_root: bool = True) -> bool:
    """True when `path` is `root` (if allowed) or below it. Egnyte paths are
    case-insensitive; '.' / '..' segments are refused outright."""
    from services import egnyte as egnyte_svc
    if not root:
        return False
    p = egnyte_svc.norm(path)
    if any(s in (".", "..") for s in p.split("/")):
        return False
    r, pl = egnyte_svc.norm(root).lower(), p.lower()
    return (allow_root and pl == r) or pl.startswith(r.rstrip("/") + "/")


def _egnyte_refusal(e: Exception, what: str) -> HTTPException:
    from services import egnyte as egnyte_svc
    status = e.status if isinstance(e, egnyte_svc.EgnyteError) else 502
    if status == 404:
        return HTTPException(status_code=404, detail=f"That {what} is not in Egnyte any more.")
    print(f"[property-assets] Egnyte {what}: {e}")
    if status in (401, 403):
        return HTTPException(status_code=403, detail=(
            f"Nexus's Egnyte connection cannot open this {what}. Connect your own Egnyte account "
            "(Files > Connect) to see it, or ask an administrator to give Nexus's Egnyte account access to it."))
    if status == 429:
        return HTTPException(status_code=429, detail="Egnyte is busy right now - try again in a minute.")
    return HTTPException(status_code=502, detail="Egnyte did not answer - try again in a minute.")


def _egnyte_read(db: Session, user, call):
    """Run `call(token)` as the caller's own Egnyte connection when they have one,
    else / then with the shared service token. Nov 10 2026: the service account's
    API quota runs out (Egnyte 429 / 403 "Developer Over Qps/Rate") under the
    server's sweeps, and every asset card showed "Egnyte is busy" while the same
    person browsed the folder fine in Files. Reading as the person spends their
    own quota; a refusal of theirs (401 / 403 no access / 429) falls back to the
    service token, so a viewer whose Egnyte cannot open the folder still sees it
    (Neil, 11/05/2026). The route has already checked the path is inside the
    pinned folder."""
    from services import egnyte as egnyte_svc
    import egnyte_oauth
    own = egnyte_oauth.token_for(db, (user or {}).get("email", ""))
    if own:
        try:
            return call(own)
        except egnyte_svc.EgnyteError as e:
            if e.status not in (401, 403, 404, 429):   # 404: Egnyte may hide a folder the person cannot see
                raise
    return call(None)


@router.get("/property-assets/{pid}/egnyte/folder")
def asset_egnyte_folder(pid: str, path: str = "", db: Session = Depends(get_db), user=Depends(require_asset_read)):
    """The asset's connected folder (or a subfolder of it) as Egnyte lists it.
    `connected: false` when nothing is pinned; `configured: false` when Egnyte
    is not set up here; `missing: true` when the pinned folder itself is gone."""
    from services import egnyte as egnyte_svc
    pinned = _pinned_for(db, user, pid)
    out: Dict[str, Any] = {"connected": bool(pinned), "configured": egnyte_svc.configured(),
                           "folder": pinned, "mayChange": may_repin_egnyte(db, user)}
    if not pinned or not out["configured"]:
        return out
    target = path.strip() or pinned
    if not inside_folder(pinned, target):
        raise HTTPException(status_code=403, detail="That folder is outside this asset's Egnyte folder.")
    try:
        data = _egnyte_read(db, user, lambda tok: egnyte_svc.list_folder(target, token=tok, timeout=_DOCS_TIMEOUT))
    except Exception as e:
        if isinstance(e, egnyte_svc.EgnyteError) and e.status == 404 and egnyte_svc.norm(target).lower() == egnyte_svc.norm(pinned).lower():
            return {**out, "missing": True}
        # A 200 with `error`, like Find Folder: Egnyte being down is not Nexus
        # being down (a 5xx would trip api.js's retry and reconnecting banner).
        return {**out, "error": _egnyte_refusal(e, "folder").detail}
    for f in data["files"]:
        f["webUrl"] = egnyte_svc.file_web_url(f.get("groupId", "")) or egnyte_svc.web_url(f["path"])
    for d in data["folders"]:
        d["webUrl"] = egnyte_svc.web_url(d["path"])
    return {**out, "path": data["path"], "folders": data["folders"], "files": data["files"],
            "webUrl": egnyte_svc.web_url(pinned)}


@router.get("/property-assets/{pid}/egnyte/file")
def asset_egnyte_file(pid: str, path: str, inline: bool = False, db: Session = Depends(get_db),
                      user=Depends(require_asset_read)):
    """One file from the asset's connected folder - a download, or a view for
    the /egnyte/file allowlist (PDF, images, text) so a file can never run as
    script on Nexus's origin."""
    from urllib.parse import quote
    from fastapi import Response
    from services import egnyte as egnyte_svc
    from routers.egnyte import preview_type
    pinned = _pinned_for(db, user, pid)
    if not inside_folder(pinned, path, allow_root=False):
        raise HTTPException(status_code=403, detail="That file is outside this asset's Egnyte folder.")
    if not egnyte_svc.configured():
        raise HTTPException(status_code=503, detail="Egnyte is not connected here.")
    want = egnyte_svc.norm(path)
    try:
        content = _egnyte_read(db, user, lambda tok: egnyte_svc.read_file(want, token=tok))
    except Exception as e:
        raise _egnyte_refusal(e, "file")
    name = want.rsplit("/", 1)[-1] or "download"
    kind = preview_type(name) if inline else None
    return Response(
        content=content,
        media_type=kind or "application/octet-stream",
        # filename* (RFC 5987): a name with quotes or non-Latin letters cannot break the header.
        headers={"Content-Disposition": f"{'inline' if kind else 'attachment'}; filename*=UTF-8''{quote(name, safe='')}",
                 "X-Content-Type-Options": "nosniff",
                 "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"},
    )


@router.post("/property-assets/changes")
def post_changes(ch: Changes, db: Session = Depends(get_db), user=Depends(require_asset_write)):
    now = _now()
    email = (user or {}).get("email", "")
    sees_private, allowed = _reach(db, user)
    company_scope = _Scope(db, user)
    may_repin = may_repin_egnyte(db, user)
    fill = _FillRevs(db)
    conflicts: List[str] = []
    refused: List[Dict[str, Any]] = []   # rows the server would not take: {id, status, message}
    refused_new: set = set()             # new assets refused - their records in this batch wait with them
    trashed: List[str] = []        # live assets a Delete Forever only moved to the Trash
    revs: Dict[str, str] = {}      # id -> the updated_at every written row now carries

    def guard(pid: str, existing, payload=None) -> None:
        """403 for an asset outside the caller's reach: a private one they cannot
        see, one outside their scope rows, or a Private flag only an officer may
        set or clear."""
        if allowed is not None and pid not in allowed:
            raise HTTPException(status_code=403, detail="That asset is outside your access.")
        if existing is not None and not viewable(existing, user):
            raise HTTPException(status_code=403, detail="That asset is outside your access.")
        if payload is not None and not sees_private:
            was = bool((existing.payload or {}).get("private")) if existing is not None else False
            if bool(payload.get("private")) != was:
                raise HTTPException(status_code=403, detail="Only an officer can mark an asset private or public.")


    meta = db.query(PropertyWorkspaceMeta).filter(PropertyWorkspaceMeta.id == 1).with_for_update().first()
    if meta is None:
        # First save ever: the row the lock needs does not exist yet. Two first
        # saves can race to insert it; the loser retakes the lock on the winner's.
        try:
            with db.begin_nested():
                meta = PropertyWorkspaceMeta(id=1)
                db.add(meta)
                db.flush()
        except IntegrityError:
            meta = db.query(PropertyWorkspaceMeta).filter(PropertyWorkspaceMeta.id == 1).with_for_update().first()
    # Rows loaded before the lock (the file check) must not stand in for the
    # rows as they are under it: a colleague's write landing in between would
    # pass the _rev check against a stale updated_at.
    db.expire_all()
    # Read under the lock, like the stale check: a migration commit landing in
    # between would make a data: value the tab still holds look new.
    for r in ch.properties.upsert:
        cur = db.get(PropertyAsset, str(r.get("id") or "")) if r.get("id") else None
        _carry_over(r, (cur.payload or {}) if cur is not None else {}, PROPERTY_FILE_FIELDS)
    for c in COLLECTIONS:
        for r in getattr(ch, c).upsert:
            cur = db.get(PropertyRecord, str(r.get("id") or "")) if r.get("id") else None
            _carry_over(r, (cur.payload or {}) if cur is not None else {}, RECORD_FILE_FIELDS)
    rows = [("property", r, PROPERTY_FILE_FIELDS) for r in ch.properties.upsert]
    rows += [(c, r, RECORD_FILE_FIELDS) for c in COLLECTIONS for r in getattr(ch, c).upsert]
    _check_file_rows(rows, db)

    for row in ch.properties.upsert:
        pid = str(row.get("id") or "").strip()
        if not pid:
            continue
        existing = db.get(PropertyAsset, pid)
        guard(pid, existing, row)
        if _stale(existing, row.get("_rev")):
            filled = _filled_since(fill, existing, row.get("_rev"))
            if not filled:
                conflicts.append(pid)
                continue
            # Queued before the one-time fill: taken, keeping the filled company
            # unless the person picked one themselves.
            if not str(row.get(_COMPANY_KEY) or "").strip():
                row[_COMPANY_KEY] = filled
        payload = _strip_rev(row)
        why = _check_company(db, company_scope, existing, payload) or _check_egnyte_folder(existing, payload, may_repin)
        if why:
            refused.append({"id": pid, "status": why[0], "message": why[1]})
            if existing is None:
                refused_new.add(pid)
            continue
        revs[pid] = now
        if existing is None:
            db.add(PropertyAsset(id=pid, name=str(payload.get("name") or ""), manager=str(payload.get("manager") or ""),
                                 asset_type=str(payload.get("assetType") or ""), parent_id=str(payload.get("parentId") or ""),
                                 payload=payload, updated_at=now, updated_by=email))
        else:
            existing.name = str(payload.get("name") or "")
            existing.manager = str(payload.get("manager") or "")
            existing.asset_type = str(payload.get("assetType") or "")
            existing.parent_id = str(payload.get("parentId") or "")
            existing.payload = payload
            existing.updated_at = now
            existing.updated_by = email
    for pid in ch.properties.delete:
        existing = db.get(PropertyAsset, str(pid))
        if existing is None:
            continue
        guard(existing.id, existing)
        if (_stale(existing, ch.properties.deleteRevs.get(str(pid)))
                and not _filled_since(fill, existing, ch.properties.deleteRevs.get(str(pid)))):
            conflicts.append(existing.id)
            continue
        # Delete Forever is only for an asset already in the Trash; a live one
        # is moved there instead (the client re-pulls and sees it). The
        # activity log is history and stays either way.
        if not (existing.payload or {}).get("deleted"):
            existing.payload = {**(existing.payload or {}), "deleted": True}
            existing.updated_at = now
            existing.updated_by = email
            revs[existing.id] = now
            trashed.append(existing.id)
            continue
        db.query(PropertyRecord).filter(PropertyRecord.property_id == existing.id).delete()
        db.delete(existing)

    for c in COLLECTIONS:
        ops = getattr(ch, c)
        for row in ops.upsert:
            rid = str(row.get("id") or "").strip()
            if not rid:
                continue
            pid = str(row.get("propertyId") or "")
            if pid in refused_new:
                refused.append({"id": rid, "status": 409, "message": "Its asset was not saved."})
                continue
            guard(pid, db.get(PropertyAsset, pid) if pid else None)
            existing = db.get(PropertyRecord, rid)
            # Moving a record also needs reach over the asset it is leaving.
            if existing is not None and existing.property_id and existing.property_id != pid:
                guard(existing.property_id, db.get(PropertyAsset, existing.property_id))
            if _stale(existing, row.get("_rev")):
                conflicts.append(rid)
                continue
            payload = _strip_rev(row)
            revs[rid] = now
            if existing is None:
                db.add(PropertyRecord(id=rid, property_id=pid, collection=c, payload=payload, updated_at=now))
            else:
                existing.property_id = pid
                existing.collection = c
                existing.payload = payload
                existing.updated_at = now
        for rid in ops.delete:
            existing = db.get(PropertyRecord, str(rid))
            if existing is None:
                continue
            guard(existing.property_id, db.get(PropertyAsset, existing.property_id) if existing.property_id else None)
            if _stale(existing, ops.deleteRevs.get(str(rid))):
                conflicts.append(existing.id)
                continue
            db.delete(existing)

    lost = set(conflicts) | {r["id"] for r in refused}
    for entry in ch.logs.append:
        lid = str(entry.get("id") or "").strip()
        if not lid or db.get(PropertyActivityLog, lid) is not None:
            continue
        pid = str(entry.get("propertyId") or "")
        if pid in lost:
            continue                      # the change it describes did not land
        guard(pid, db.get(PropertyAsset, pid) if pid else None)
        db.add(PropertyActivityLog(id=lid, property_id=pid, payload=entry, created_at=str(entry.get("ts") or now)))
    for patch in ch.logs.update:
        row = db.get(PropertyActivityLog, str(patch.get("id") or ""))
        if row is None:
            continue
        guard(row.property_id, db.get(PropertyAsset, row.property_id) if row.property_id else None)
        row.payload = {**(row.payload or {}), "undone": bool(patch.get("undone"))}
    db.flush()
    ts_ms = int(time.time() * 1000)
    meta.ts = ts_ms
    meta.updated_by = email
    meta.updated_at = now
    db.commit()
    return {"ok": True, "_ts": ts_ms, "conflicts": conflicts, "trashed": trashed, "revs": revs, "refused": refused}


@router.get("/property-assets/metrics")
def get_metrics(db: Session = Depends(get_db), user=Depends(require_asset_read)):
    """The one number a tile shows for its stage (Neil, Oct 21 2026), per asset
    the caller may see: `occupancy` (leased units over units, from the site
    model's last build - Cubby's lease flag) and `percentComplete` (the asset's
    active construction project). Missing = the tile keeps its size figures.
    NOI per asset needs the ledger by entity and is not here yet."""
    visible = _visible_ids(db, user)
    out: Dict[str, Dict[str, Any]] = {}
    try:
        from routers.site_models import list_models, load_model
        for m in list_models():
            pid = m.get("id")
            if pid not in visible:
                continue
            units = [u for u in (load_model(pid).get("units") or []) if not u.get("gone")]
            if units:
                leased = sum(1 for u in units if u.get("l"))
                out.setdefault(pid, {})["occupancy"] = round(leased / len(units), 3)
                out[pid]["units"] = len(units)
    except Exception as e:  # noqa: BLE001 - a site-model read must not blank the tiles
        print(f"[property-assets] metrics: site models skipped: {e}")
    try:
        from construction_models import ConstructionProject
        rows = (db.query(ConstructionProject)
                .filter(ConstructionProject.property_id != "", ConstructionProject.deleted_at == "")
                .order_by(ConstructionProject.modified_at.desc()).all())
        for r in rows:
            # The most recently touched live project wins; "live" is the construction
            # router's own definition (status active / on hold and not archived).
            if r.archived or (r.status or "active") not in ("active", "on_hold"):
                continue
            if r.property_id in visible and "percentComplete" not in out.get(r.property_id, {}):
                out.setdefault(r.property_id, {})["percentComplete"] = round(float(r.percent_complete or 0.0), 1)
    except Exception as e:  # noqa: BLE001
        print(f"[property-assets] metrics: construction skipped: {e}")
    return out


def _parse_ymd(s):
    if not s:
        return None
    try:
        return date.fromisoformat(str(s)[:10])
    except Exception:
        return None


@router.post("/property-assets/reminders/scan")
def scan_reminders(db: Session = Depends(get_db), user=Depends(require_asset_read)):
    """Run the asset date alerts now. Same targeted logic as the daily scan
    (equipment_reminders.run_asset_alerts): each alert goes to the asset's
    manager (IT Admins when nobody is set), never a broadcast, with the lead
    days from Settings > Equipment Reminders."""
    import equipment_reminders
    created = equipment_reminders.run_asset_alerts(db)
    if created:
        db.commit()
    return {"created": created}
