"""Operations settings (Oct 21 2026) - Settings > Global Settings > Operations.

  GET /facility-ops/settings   the Push to Cubby switch, whether a write key is set, the last flips
  PUT /facility-ops/settings   {"cubbyPushOn": bool}

Storage, the audit row and the write client live in `ops_cubby_push.py`.

Gates (the Equipment Reminders pattern):
  - View: anyone who can open Operations (level 2+ or an Operations grant).
    The screens read `pushOn` to decide between Push and Mark Entered.
  - Change: a Global Admin / IT Admin (administrator, level 4+) OR an
    Operations grant at Full. Turning pushing on lets Nexus change live prices
    and rents in Cubby, so an ordinary manager cannot.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import auth
import ops_cubby_push
from auth import require_level_or_module
from database import get_db

router = APIRouter(prefix="/facility-ops/settings", tags=["Operations"])

require_view = require_level_or_module(2, "operations", "viewer")
require_save = require_level_or_module(4, "operations", "full")


def _can_save(user: dict, db: Session) -> bool:
    if user.get("level", 0) >= 4:
        return True
    try:
        return auth._module_level(user["email"], "operations", db) >= auth._MODULE_LEVEL_RANK["full"]
    except Exception:  # noqa: BLE001 - a flag on the screen must not 500 it
        return False


def _out(db: Session, can_edit: bool) -> dict:
    s = ops_cubby_push.get_state(db)
    return {"cubbyPushOn": s["on"], "writeConfigured": ops_cubby_push.write_configured(),
            "writeKeyEnv": ops_cubby_push.WRITE_KEY_ENV,
            "updatedBy": s["updatedBy"], "updatedAt": s["updatedAt"],
            "history": ops_cubby_push.history(db), "canEdit": can_edit}


@router.get("")
def get_settings(user: dict = Depends(require_view), db: Session = Depends(get_db)):
    return _out(db, _can_save(user, db))


class SettingsBody(BaseModel):
    cubbyPushOn: bool


@router.put("")
def put_settings(body: SettingsBody, user: dict = Depends(require_save), db: Session = Depends(get_db)):
    try:
        ops_cubby_push.save(db, body.cubbyPushOn, user)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    print(f"[ops-settings] push to Cubby turned {'on' if body.cubbyPushOn else 'off'} by {user['email']}")
    return _out(db, True)
