"""Cubby tasks <-> Nexus Tasks (Neil, Oct 30 2026) - Settings > Operations >
Cubby Tasks, and the drawer's "From Cubby" row.

  GET  /cubby-tasks/settings        switches, the facility -> project map, facilities,
                                    projects, the last run and the push queue
  PUT  /cubby-tasks/settings        {on?, closeInCubby?, projects?}
  POST /cubby-tasks/sync-now        run the task sync on the rows the last Cubby sync saved
  GET  /cubby-tasks/link/{task_id}  what Cubby knows about one Nexus task (anyone who can
                                    open the task)

Gates, the Push to Cubby pattern (routers/ops_settings.py): anyone who can
open Operations sees the settings; a Global Admin / IT Admin or an
Operations grant at Full changes them. "Close Tasks in Cubby" writes to
Cubby, so an ordinary manager cannot turn it on.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import auth
import cubby_tasks
from auth import get_current_user, require_level_or_module
from database import get_db

router = APIRouter(prefix="/cubby-tasks", tags=["Operations"])

require_view = require_level_or_module(2, "operations", "viewer")
require_save = require_level_or_module(4, "operations", "full")


def _can_save(user: dict, db: Session) -> bool:
    if user.get("level", 0) >= 4:
        return True
    try:
        return auth._module_level(user["email"], "operations", db) >= auth._MODULE_LEVEL_RANK["full"]
    except Exception:  # noqa: BLE001 - a flag on the screen must not 500 it
        return False


def _out(db: Session, user: dict) -> dict:
    return {**cubby_tasks.overview(db), "canEdit": _can_save(user, db)}


@router.get("/settings")
def get_settings(user: dict = Depends(require_view), db: Session = Depends(get_db)):
    return _out(db, user)


class SettingsBody(BaseModel):
    on: Optional[bool] = None
    closeInCubby: Optional[bool] = None
    projects: Optional[dict] = None


@router.put("/settings")
def put_settings(body: SettingsBody, user: dict = Depends(require_save), db: Session = Depends(get_db)):
    patch = {k: v for k, v in body.__dict__.items() if v is not None}
    if not patch:
        raise HTTPException(422, "Nothing to change")
    try:
        cubby_tasks.save(db, patch, user)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    print(f"[cubby-tasks] settings changed by {user['email']}: {sorted(patch)}")
    return _out(db, user)


@router.post("/sync-now")
def sync_now(user: dict = Depends(require_save), db: Session = Depends(get_db)):
    """Runs in this request (a sync route is a plain def, so it is on a worker
    thread, never the event loop). Uses the rows the last Cubby sync saved."""
    if not cubby_tasks.is_on(db):
        raise HTTPException(409, "Turn on Cubby Tasks first.")
    summary = cubby_tasks.after_sync(None, trigger="manual")
    if summary.get("status") == "busy":
        raise HTTPException(409, "A sync is already running - try again in a minute.")
    return {"run": summary, **_out(db, user)}


@router.get("/link/{task_id}")
def link(task_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    from routers import tasks as tasks_router
    from routers.task_util import assert_task_wall, task_visible_to
    t = tasks_router._get_task(db, task_id)
    assert_task_wall(db, user, t)
    if not task_visible_to(db, user, t):
        raise HTTPException(404, "Task not found")
    info = cubby_tasks.link_for_task(db, task_id)
    if info is None:
        raise HTTPException(404, "This task did not come from Cubby")
    return info
