"""HR & Compliance Reminders settings (Sep 2026) - GET/PUT the admin-set
timing the daily HR reminder scan (reminders.py) reads. Storage, defaults and
validation live in hr_reminder_config.py; this is only the HTTP face.

Gates:
  - View: a manager (level 3+) OR anyone whose Access Group grants the HR
    module. The HR team is who receives most of these reminders, so they must
    be able to see when they will be warned.
  - Save: a Global Admin (administrator, level 4+) OR an HR grant at "full" or
    above. Deliberately higher than Task/Ticket notification settings
    (require_manager): turning a reminder off here silences visa and contract
    compliance warnings for the whole company, so an ordinary manager must not
    be able to do it - but HR owns these warnings ("HR controls how early
    they're warned"), so a full HR grant may. Lower than Daily Briefing
    (administrator only), which can start mailing every employee at once;
    nothing here reaches beyond HR, managers and signature senders.
Every save writes an audit row with the before/after of each changed type.
"""
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.orm import Session

import auth
import hr_reminder_config
from auth import require_level_or_module
from database import get_db

router = APIRouter(prefix="/hr-reminder-settings", tags=["HR Reminders"])

require_view = require_level_or_module(3, "hr", "viewer")
require_save = require_level_or_module(4, "hr", "full")


def _can_save(user: dict, db: Session) -> bool:
    return user["level"] >= 4 or auth._module_level(user["email"], "hr", db) >= auth._MODULE_LEVEL_RANK["full"]


@router.get("")
def get_settings(user: dict = Depends(require_view), db: Session = Depends(get_db)):
    state = hr_reminder_config.get_state(db)
    return {**state, "defaults": hr_reminder_config.defaults(), "canEdit": _can_save(user, db),
            "limits": {"maxDay": hr_reminder_config.MAX_DAY, "maxEntries": hr_reminder_config.MAX_ENTRIES}}


@router.put("")
def put_settings(payload: dict = Body(...), user: dict = Depends(require_save), db: Session = Depends(get_db)):
    # Accept either the bare config or the {config: {...}} shape GET returns.
    cfg = payload.get("config") if isinstance(payload.get("config"), dict) else payload
    try:
        state = hr_reminder_config.save_config(db, cfg, user)
    except hr_reminder_config.ReminderConfigError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {**state, "defaults": hr_reminder_config.defaults(), "canEdit": True,
            "limits": {"maxDay": hr_reminder_config.MAX_DAY, "maxEntries": hr_reminder_config.MAX_ENTRIES}}
