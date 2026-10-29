"""Training Reminders settings (Oct 2026) - GET/PUT the switches the daily
Knowledge Base scan (kb_daily.py) reads. Storage, defaults and validation
live in kb_reminder_config.py; this is only the HTTP face.

  - View: a manager (level 3+) OR anyone with a Knowledge Base (sop) grant.
  - Save: a Global Admin / IT Admin (administrator, level 4+) OR a Knowledge
    Base grant at "full". Turning these off silences training reminders
    company-wide, so an ordinary manager or page editor cannot.
"""
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.orm import Session

import auth
import kb_reminder_config as krc
from auth import require_level_or_module
from database import get_db
from hr_reminder_config import ReminderConfigError

router = APIRouter(prefix="/kb-reminder-settings", tags=["Knowledge Base"])

require_view = require_level_or_module(3, "sop", "viewer")
require_save = require_level_or_module(4, "sop", "full")


def _can_save(user: dict, db: Session) -> bool:
    return user["level"] >= 4 or auth._module_level(user["email"], "sop", db) >= auth._MODULE_LEVEL_RANK["full"]


def _out(state: dict, can_edit: bool) -> dict:
    return {**state, "defaults": krc.defaults(), "canEdit": can_edit}


@router.get("")
def get_settings(user: dict = Depends(require_view), db: Session = Depends(get_db)):
    return _out(krc.get_state(db), _can_save(user, db))


@router.put("")
def put_settings(payload: dict = Body(...), user: dict = Depends(require_save), db: Session = Depends(get_db)):
    # Accept either the bare config or the {config: {...}} shape GET returns.
    cfg = payload.get("config") if isinstance(payload.get("config"), dict) else payload
    try:
        state = krc.save_config(db, cfg, user)
    except ReminderConfigError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return _out(state, True)
