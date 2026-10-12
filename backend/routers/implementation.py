"""Implementation Guide progress (Neil, 10/06: "when you and I earn our first
client, what are the internal steps that we are going to take with that client").

The guide itself is frontend content (support/implementationContent.js); this
only remembers which of its checks are done, ONE shared list for the whole
organization, so everyone setting Nexus up sees the same progress and who
ticked what. Stored in the nexus_settings key-value table (no new table).
Administrators only - it is the implementer's checklist, not an employee
screen.
"""
import json
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import require_administrator
from database import get_db
from models import NexusSetting

router = APIRouter(prefix="/implementation", tags=["Implementation Guide"])

KEY = "implementation_progress"
_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")


def _load(db: Session) -> dict:
    row = db.query(NexusSetting).filter(NexusSetting.key == KEY).first()
    try:
        data = json.loads(row.value) if row and row.value else {}
    except ValueError:
        data = {}
    return data if isinstance(data, dict) else {}


@router.get("/progress")
def get_progress(user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    """{check_id: {"by": email, "at": ISO}} for every check marked done."""
    return {"done": _load(db)}


class CheckIn(BaseModel):
    done: bool


@router.put("/progress/{check_id}")
def set_check(check_id: str, body: CheckIn, user: dict = Depends(require_administrator),
              db: Session = Depends(get_db)):
    if not _ID.match(check_id or ""):
        raise HTTPException(400, "Unknown check")
    row = db.query(NexusSetting).filter(NexusSetting.key == KEY).with_for_update().first()
    if not row:
        row = NexusSetting(key=KEY, value="{}")
        db.add(row)
    try:
        data = json.loads(row.value or "{}")
    except ValueError:
        data = {}
    now = datetime.now(timezone.utc).isoformat()
    if body.done:
        data[check_id] = {"by": user["email"], "at": now}
    else:
        data.pop(check_id, None)
    row.value = json.dumps(data)
    row.updated_by, row.updated_at = user["email"], now
    db.commit()
    return {"done": data}
