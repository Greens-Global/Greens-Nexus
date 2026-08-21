"""Admin config for the Nexus Daily Briefing (Aug 2026). GET/PUT the
NexusSetting-backed `daily_briefing_config` blob that daily_briefing.py's
scan loop reads every pass - `mode` (off|test|live) and `test_recipients`.

Global-Admin gated: this flag controls whether every employee in the company
starts receiving a daily email, so it sits behind require_administrator like
branding.py's config, not the lower require_manager bar ticket settings use.
No frontend toggle yet (Phase 1) - callable directly until the content is
verified, per Neil's "don't turn it on" instruction on the 8/21 call.
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import Optional

from auth import require_administrator
from database import get_db
import daily_briefing

router = APIRouter(prefix="/daily-briefing", tags=["Daily Briefing"])


class ConfigIn(BaseModel):
    mode: Optional[str] = None                 # off|test|live
    test_recipients: Optional[list] = None


@router.get("/config", dependencies=[Depends(require_administrator)])
def get_config(db: Session = Depends(get_db)):
    return daily_briefing.get_settings(db)


@router.put("/config", dependencies=[Depends(require_administrator)])
def update_config(body: ConfigIn, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if patch.get("mode") not in (None, "off", "test", "live"):
        patch.pop("mode", None)
    return daily_briefing.save_settings(db, patch, user["email"])
