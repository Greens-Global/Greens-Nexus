"""Equipment Reminders settings (Sep 2026) - GET/PUT the timing the daily
equipment scan (equipment_reminders.py) reads. Storage, defaults and
validation live in equipment_reminder_config.py; this is only the HTTP face.

Gates (match how Items admin is gated, one step up for saving):
  - View: a manager (level 3+) OR anyone with an Items (inventory) or Asset
    Management (property-asset) grant - the people who receive these alerts
    can see when they fire.
  - Save: a Global Admin / IT Admin (administrator, level 4+) OR an inventory
    grant at "full". Turning these off silences overdue chasing and warranty
    warnings company-wide, so an ordinary manager or Items editor cannot.
Every save writes an audit row with the before/after of each changed type.
"""
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.orm import Session

import auth
import equipment_reminder_config as erc
from auth import require_level_or_module, require_level_or_modules
from database import get_db

router = APIRouter(prefix="/equipment-reminder-settings", tags=["Equipment Reminders"])

require_view = require_level_or_modules(3, [("inventory", "viewer"), ("property-asset", "viewer")])
require_save = require_level_or_module(4, "inventory", "full")


def _can_save(user: dict, db: Session) -> bool:
    return user["level"] >= 4 or auth._module_level(user["email"], "inventory", db) >= auth._MODULE_LEVEL_RANK["full"]


def _out(state: dict, can_edit: bool) -> dict:
    return {**state, "defaults": erc.defaults(), "canEdit": can_edit, "limits": erc.limits()}


@router.get("")
def get_settings(user: dict = Depends(require_view), db: Session = Depends(get_db)):
    return _out(erc.get_state(db), _can_save(user, db))


@router.put("")
def put_settings(payload: dict = Body(...), user: dict = Depends(require_save), db: Session = Depends(get_db)):
    # Accept either the bare config or the {config: {...}} shape GET returns.
    cfg = payload.get("config") if isinstance(payload.get("config"), dict) else payload
    try:
        state = erc.save_config(db, cfg, user)
    except erc.ReminderConfigError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return _out(state, True)
