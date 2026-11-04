"""Asset Management - the one-time Company fill (Neil, 11/03/2026: "A company
field on asset management would replace the inferred company").

Every asset row gets a real Company field (`companyId` in its payload, read
first by property_links.property_company). This pass fills it ONCE, at
startup, for the rows that have none - but only from a STRONG answer
(property_links.infer_company(strong=True)): the Operating Entity matched to
exactly one company, or a parcel's lead property. Who manages a property is
a weak guess at who owns it (review, 11/03/2026): a row only the asset
manager would place is left blank, listed under Asset Management's "Needs a
Company", and the dry run names the guess for a person to confirm. It
writes the way the module's own row save does:

  * a row that already has a companyId is NEVER touched (checked again under
    the workspace lock, so a person who set one meanwhile wins);
  * each filled row gets a fresh `updated_at` (its `_rev`) and one Activity
    Log entry, "Company set from <how>"; the workspace freshness marker
    moves, so open tabs pull the new field;
  * the rev each row had before and after the fill is kept (FILL_REVS_KEY):
    a save a tab queued against the pre-fill rev (the deploy window) is not
    a conflict while the fill is the only change since - the row save
    (routers/property_assets._filled_since) takes it and keeps the company.

Trashed and private rows are filled too (a recovered asset keeps its
company).

It runs once per database (FILL_MARK in nexus_settings), from main.py's
startup seeds, and only where it is meant to: the deployed API
(leader.is_deployed_worker) or a laptop on its own SQLite file - never a
laptop pointed at the shared Postgres. Before release, read what it would do
on prod (reads only, writes nothing):

    cd backend && python asset_company_fill.py
"""
from __future__ import annotations

import json
import os
import time
import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session

import models
import property_links

FILL_MARK = "asset_company_fill_2026_11_03"
FILL_REVS_KEY = "asset_company_fill_revs"     # {asset id: {"from": rev before, "to": rev after, "companyId"}}
LOG_USER = "Nexus"


def _name(p) -> str:
    return property_links.display_name(p) or p.id


def dry_run(db: Session) -> dict:
    """What `fill` would do, without writing:
      set    [{assetId, name, kind, companyId, companyName, how}] - written
      review [{assetId, name, kind, companyId, companyName, how}] - only the
             asset manager places it: left blank, the guess shown for review
      blank  [{assetId, name, kind}] - nothing places it
      kept   n rows that already have a company."""
    names = property_links.entity_ids_by_name(db)
    labels = {e.id: e.name for e in db.query(models.HrEntity.id, models.HrEntity.name).all()}
    out = {"set": [], "review": [], "blank": [], "kept": 0}
    for p in db.query(models.PropertyAsset).order_by(models.PropertyAsset.name).all():
        if str((p.payload or {}).get("companyId") or "").strip():
            out["kept"] += 1
            continue
        row = {"assetId": p.id, "name": _name(p), "kind": property_links.asset_kind(p)}
        cid, how = property_links.infer_company(db, p, names, strong=True)
        if cid:
            out["set"].append({**row, "companyId": cid, "companyName": labels.get(cid, cid), "how": how})
            continue
        guess, how = property_links.infer_company(db, p, names)
        if guess:
            out["review"].append({**row, "companyId": guess, "companyName": labels.get(guess, guess), "how": how})
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


def filled_revs(db: Session) -> dict:
    """{asset id: {"from", "to", "companyId"}} - what the fill did to each row."""
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == FILL_REVS_KEY).first()
    try:
        return json.loads(row.value or "{}") if row is not None else {}
    except (TypeError, ValueError):
        return {}


def fill(db: Session):
    """Set the Company on every row without one that a STRONG answer places,
    ONCE (FILL_MARK). Commits. Returns how many rows were set, or None when
    it had already run."""
    if db.query(models.NexusSetting).filter(models.NexusSetting.key == FILL_MARK).first():
        return None
    plan = dry_run(db)
    now = datetime.now(timezone.utc).isoformat()
    # The same lock every row save takes: a save racing this pass waits, then
    # sees the row as filled (and _filled_since lets a pre-fill save through).
    meta = (db.query(models.PropertyWorkspaceMeta)
            .filter(models.PropertyWorkspaceMeta.id == 1).with_for_update().first())
    db.expire_all()
    revs = {}
    for item in plan["set"]:
        p = db.get(models.PropertyAsset, item["assetId"])
        if p is None or str((p.payload or {}).get("companyId") or "").strip():
            continue                       # gone, or someone set it meanwhile - theirs wins
        revs[p.id] = {"from": p.updated_at or "", "to": now, "companyId": item["companyId"]}
        p.payload = {**(p.payload or {}), "companyId": item["companyId"]}
        p.updated_at = now
        p.updated_by = "system"
        name = _name(p)
        entry = {"id": str(uuid.uuid4()), "ts": now, "user": LOG_USER, "section": "Property",
                 "property": name, "propertyId": p.id, "action": "edited", "item": name,
                 "changes": [{"field": "Company", "from": "", "to": item["companyName"]}],
                 "reason": f"Company set from {item['how']}"}
        db.add(models.PropertyActivityLog(id=entry["id"], property_id=p.id, payload=entry, created_at=now))
    if revs:
        if meta is None:
            meta = models.PropertyWorkspaceMeta(id=1)
            db.add(meta)
        meta.ts = int(time.time() * 1000)
        meta.updated_by = "system"
        meta.updated_at = now
        db.add(models.NexusSetting(key=FILL_REVS_KEY, value=json.dumps(revs), updated_by="system", updated_at=now))
    db.add(models.NexusSetting(key=FILL_MARK, value=str(len(revs)), updated_by="system", updated_at=now))
    db.commit()
    return len(revs)


if __name__ == "__main__":
    # Read-only: what the one-time fill would do on this database.
    #   cd backend && python asset_company_fill.py
    from database import SessionLocal
    _db = SessionLocal()
    try:
        _plan = dry_run(_db)
        for _i in _plan["set"]:
            print(f"SET     {_i['name']} ({_i['kind']})  ->  {_i['companyName']}  (from {_i['how']})")
        for _i in _plan["review"]:
            print(f"REVIEW  {_i['name']} ({_i['kind']})  - left blank; would need review: "
                  f"{_i['companyName']} from asset manager")
        for _i in _plan["blank"]:
            print(f"BLANK   {_i['name']} ({_i['kind']})  - nothing places it; listed under Needs a Company")
        print(f"{len(_plan['set'])} to set, {len(_plan['review'])} need review, {len(_plan['blank'])} left blank, "
              f"{_plan['kept']} already have a company")
        if _db.query(models.NexusSetting).filter(models.NexusSetting.key == FILL_MARK).first():
            print("(the one-time fill has already run on this database)")
    finally:
        _db.close()
