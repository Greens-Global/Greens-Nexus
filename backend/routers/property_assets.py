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
    for v in payload.get("images") or []:
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


@router.post("/property-assets/changes")
def post_changes(ch: Changes, db: Session = Depends(get_db), user=Depends(require_asset_write)):
    now = _now()
    email = (user or {}).get("email", "")
    sees_private, allowed = _reach(db, user)
    conflicts: List[str] = []
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

    for row in ch.properties.upsert:
        pid = str(row.get("id") or "").strip()
        if not pid:
            continue
        existing = db.get(PropertyAsset, pid)
        guard(pid, existing, row)
        if _stale(existing, row.get("_rev")):
            conflicts.append(pid)
            continue
        payload = _strip_rev(row)
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
        if _stale(existing, ch.properties.deleteRevs.get(str(pid))):
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

    lost = set(conflicts)
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
    return {"ok": True, "_ts": ts_ms, "conflicts": conflicts, "revs": revs}


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
