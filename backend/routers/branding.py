"""Branding settings (Jul 2026) - the login screen's accent color, exposed as
a Global Admin-configurable setting rather than hardcoded (Pranshu, Jul 28:
"make this a setting that can be changed in global settings"). Stored in the
same NexusSetting key/value pattern every other module's small admin config
uses (ticket_notify_config, task_notify_config, etc).

GET is public/unauthenticated on purpose: the login screen itself needs the
current accent BEFORE anyone has signed in, so it can't sit behind
get_current_user. Nothing in the payload is sensitive - same threat model as
/stepup/config.
"""
from datetime import datetime, timezone
import json

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import require_administrator
from database import get_db
import models

router = APIRouter(prefix="/branding", tags=["Branding"])

_SETTINGS_KEY = "branding_config"
_VALID_ACCENTS = ("green", "blue")
_DEFAULT_ACCENT = "green"


def _get_config(db: Session) -> dict:
    # Cached (cache.py): this endpoint is UNAUTHENTICATED (the login screen
    # needs it pre-sign-in), so without a cache anyone can make the DB do work
    # from outside the auth wall. Accent changes are near-annual.
    import cache
    cached = cache.settings_config.get(_SETTINGS_KEY)
    if cached is not None:
        return cached
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    cfg = {"accent": _DEFAULT_ACCENT}
    if row and row.value:
        try:
            cfg = json.loads(row.value)
        except (TypeError, ValueError):
            cfg = {"accent": _DEFAULT_ACCENT}
        if cfg.get("accent") not in _VALID_ACCENTS:
            cfg["accent"] = _DEFAULT_ACCENT
    cache.settings_config.set(_SETTINGS_KEY, cfg)
    return cfg


class BrandingIn(BaseModel):
    accent: str


@router.get("/config")
def get_config(db: Session = Depends(get_db)):
    return _get_config(db)


@router.put("/config")
def update_config(body: BrandingIn, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    accent = body.accent if body.accent in _VALID_ACCENTS else _DEFAULT_ACCENT
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _SETTINGS_KEY).first()
    if not row:
        row = models.NexusSetting(key=_SETTINGS_KEY)
        db.add(row)
    row.value = json.dumps({"accent": accent})
    row.updated_by = user["email"]
    row.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    return {"accent": accent}
