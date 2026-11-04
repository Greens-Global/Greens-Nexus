"""Asset Management - the one-time Company fill (Neil, 11/03/2026: "A company
field on asset management would replace the inferred company").

Every asset row gets a real Company field (`companyId` in its payload, read
first by property_links.property_company). This pass fills it ONCE, at
startup, for the rows that have none, from the inference the module used
until now (property_links.infer_company: the Operating Entity matched to
exactly one company, else a parcel's lead property, else the asset
manager's company). It writes the way the module's own row save does:

  * a row that already has a companyId is NEVER touched (checked again under
    the workspace lock, so a person who set one meanwhile wins);
  * each filled row gets a fresh `updated_at` (its `_rev`) - an open tab that
    still holds the old copy gets the usual conflict and re-pulls, never
    overwrites the company with its stale row;
  * each filled row gets one Activity Log entry, "Company set from <how>";
  * the workspace freshness marker moves, so open tabs pull the new field.

A row nothing places stays blank and is listed under Asset Management's
"Needs a Company" filter for an administrator to set. Trashed and private
rows are filled too (a recovered asset keeps its company).

It runs once per database (FILL_MARK in nexus_settings), from main.py's
startup seeds, and only where it is meant to: the deployed API
(leader.is_deployed_worker) or a laptop on its own SQLite file - never a
laptop pointed at the shared Postgres. Before release, read what it would do
on prod (reads only, writes nothing):

    cd backend && python asset_company_fill.py
"""
from __future__ import annotations

import os
import time
import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session

import models
import property_links

FILL_MARK = "asset_company_fill_2026_11_03"
LOG_USER = "Nexus"


def _name(p) -> str:
    return property_links.display_name(p) or p.id


def dry_run(db: Session) -> dict:
    """What `fill` would do, without writing: {"set": [{assetId, name, kind,
    companyId, companyName, how}], "blank": [{assetId, name, kind}], "kept":
    n rows that already have a company}."""
    names = property_links.entity_ids_by_name(db)
    labels = {e.id: e.name for e in db.query(models.HrEntity.id, models.HrEntity.name).all()}
    out = {"set": [], "blank": [], "kept": 0}
    for p in db.query(models.PropertyAsset).order_by(models.PropertyAsset.name).all():
        if str((p.payload or {}).get("companyId") or "").strip():
            out["kept"] += 1
            continue
        cid, how = property_links.infer_company(db, p, names)
        row = {"assetId": p.id, "name": _name(p), "kind": property_links.asset_kind(p)}
        if cid:
            out["set"].append({**row, "companyId": cid, "companyName": labels.get(cid, cid), "how": how})
        else:
            out["blank"].append(row)
    return out


def should_run(database_url: str | None = None) -> bool:
    """The deployed API, or a laptop on its own SQLite - never a laptop whose
    DATABASE_URL points at the shared database."""
    url = database_url if database_url is not None else os.getenv("DATABASE_URL", "")
    if (url or "sqlite").startswith("sqlite"):
        return True
    from leader import is_deployed_worker
    return is_deployed_worker()


def fill(db: Session):
    """Set the Company on every row without one that the inference places,
    ONCE (FILL_MARK). Commits. Returns how many rows were set, or None when
    it had already run."""
    if db.query(models.NexusSetting).filter(models.NexusSetting.key == FILL_MARK).first():
        return None
    plan = dry_run(db)
    now = datetime.now(timezone.utc).isoformat()
    # The same lock every row save takes: a save racing this pass waits, then
    # finds the new _rev (and the company) and re-pulls.
    meta = (db.query(models.PropertyWorkspaceMeta)
            .filter(models.PropertyWorkspaceMeta.id == 1).with_for_update().first())
    db.expire_all()
    done = 0
    for item in plan["set"]:
        p = db.get(models.PropertyAsset, item["assetId"])
        if p is None or str((p.payload or {}).get("companyId") or "").strip():
            continue                       # gone, or someone set it meanwhile - theirs wins
        p.payload = {**(p.payload or {}), "companyId": item["companyId"]}
        p.updated_at = now
        p.updated_by = "system"
        name = _name(p)
        entry = {"id": str(uuid.uuid4()), "ts": now, "user": LOG_USER, "section": "Property",
                 "property": name, "propertyId": p.id, "action": "edited", "item": name,
                 "changes": [{"field": "Company", "from": "", "to": item["companyName"]}],
                 "reason": f"Company set from {item['how']}"}
        db.add(models.PropertyActivityLog(id=entry["id"], property_id=p.id, payload=entry, created_at=now))
        done += 1
    if done:
        if meta is None:
            meta = models.PropertyWorkspaceMeta(id=1)
            db.add(meta)
        meta.ts = int(time.time() * 1000)
        meta.updated_by = "system"
        meta.updated_at = now
    db.add(models.NexusSetting(key=FILL_MARK, value=str(done), updated_by="system", updated_at=now))
    db.commit()
    return done


if __name__ == "__main__":
    # Read-only: what the one-time fill would do on this database.
    #   cd backend && python asset_company_fill.py
    from database import SessionLocal
    _db = SessionLocal()
    try:
        _plan = dry_run(_db)
        for _i in _plan["set"]:
            print(f"SET    {_i['name']} ({_i['kind']})  ->  {_i['companyName']}  (from {_i['how']})")
        for _i in _plan["blank"]:
            print(f"BLANK  {_i['name']} ({_i['kind']})  - nothing places it; listed under Needs a Company")
        print(f"{len(_plan['set'])} to set, {len(_plan['blank'])} left blank, {_plan['kept']} already have a company")
        if _db.query(models.NexusSetting).filter(models.NexusSetting.key == FILL_MARK).first():
            print("(the one-time fill has already run on this database)")
    finally:
        _db.close()
