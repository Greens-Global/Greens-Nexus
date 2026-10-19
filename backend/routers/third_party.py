"""Third-party managed properties - the API (Operations, Oct 20 2026).

  GET   /third-party/ops-facilities   the CubeSmart stores as Operations facility
                                      blocks (third_party.ops_facilities)
  GET   /third-party/properties       the stores and their mapping
  PATCH /third-party/properties/{id}  map a store to its portfolio property / Site Model
  POST  /third-party/upload           an SRE Summary, Daily Flash or rent roll:
                                      commit=0 -> validation preview, nothing saved;
                                      commit=1 -> the same parse, then upsert
  GET   /third-party/imports          the latest uploads and nightly fetches
  GET   /third-party/fetch            is the nightly fetch on (never a credential)

Reads: the Operations door (supervisors and above, or an Operations grant) -
the same as /facility-ops. Writes: managers and above, or an Operations
editor. Endpoints are plain `def` (FastAPI runs them in its threadpool): the
parse and the queries are blocking.
"""
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import third_party
import third_party_fetch
import third_party_parse as tpp
from auth import require_level_or_module
from database import get_db
from third_party_models import ThirdPartyImport, ThirdPartyProperty

router = APIRouter(prefix="/third-party", tags=["Operations"])

require_read = require_level_or_module(2, "operations", "viewer")
require_write = require_level_or_module(3, "operations", "editor")


@router.get("/ops-facilities")
def ops_facilities(user: dict = Depends(require_read), db: Session = Depends(get_db)):
    return third_party.ops_facilities(db)


@router.get("/properties")
def list_properties(user: dict = Depends(require_read), db: Session = Depends(get_db)):
    return [third_party.property_json(p) for p in third_party.properties(db, include_disabled=True)]


class PropertyPatch(BaseModel):
    property_asset_id: Optional[str] = Field(default=None, max_length=120)
    site_model_id: Optional[str] = Field(default=None, max_length=120)
    short_name: Optional[str] = Field(default=None, max_length=60)
    enabled: Optional[bool] = None
    fetch_enabled: Optional[bool] = None


@router.patch("/properties/{pid}")
def patch_property(pid: str, body: PropertyPatch, user: dict = Depends(require_write), db: Session = Depends(get_db)):
    third_party.ensure_seeded(db)
    p = db.query(ThirdPartyProperty).filter(ThirdPartyProperty.id == pid).with_for_update().first()
    if not p:
        raise HTTPException(404, "No such property")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(p, k, v.strip() if isinstance(v, str) else v)
    p.updated_at = third_party._now()
    db.commit()
    return third_party.property_json(p)


@router.post("/upload")
def upload(file: UploadFile = File(...), kind: str = Form("auto"), property_id: str = Form(""),
           as_of: str = Form(""), commit: bool = Form(False),
           user: dict = Depends(require_write), db: Session = Depends(get_db)):
    raw = file.file.read(tpp.MAX_BYTES + 1)
    try:
        preview = third_party.build_preview(db, raw, file.filename or "", kind, property_id, as_of)
    except tpp.ParseError as e:
        raise HTTPException(400, str(e)) from e
    # The rent roll's unit list is long and the preview only needs the count.
    shown = {**preview, "rows": [{k: v for k, v in r.items() if k != "units"} for r in preview["rows"]]}
    if not commit:
        return {**shown, "saved": False}
    if preview["errors"]:
        raise HTTPException(400, preview["errors"][0])
    try:
        result = third_party.save(db, preview, by=user.get("email") or "")
    except tpp.ParseError as e:
        raise HTTPException(400, str(e)) from e
    return {**shown, **result, "saved": True}


@router.get("/imports")
def imports(property_id: str = "", user: dict = Depends(require_read), db: Session = Depends(get_db)):
    q = db.query(ThirdPartyImport)
    if property_id:
        q = q.filter(ThirdPartyImport.property_id == property_id)
    return [{"id": r.id, "propertyId": r.property_id, "kind": r.kind, "via": r.via, "fileName": r.file_name,
             "rows": r.rows, "status": r.status, "error": r.error, "by": r.created_by, "at": r.created_at}
            for r in q.order_by(ThirdPartyImport.created_at.desc()).limit(50).all()]


@router.get("/fetch")
def fetch_status(user: dict = Depends(require_read)):
    """Whether the nightly fetch could run. Says which settings are present,
    never their values."""
    return {"enabled": third_party_fetch.enabled(), "switch": third_party_fetch.SWITCH,
            "sources": {k: {"configured": s.configured(), "settings": [s.username_env, s.password_env]}
                        for k, s in third_party_fetch.SOURCES.items()}}
