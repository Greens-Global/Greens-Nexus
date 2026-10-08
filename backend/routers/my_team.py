"""My Team (Essentials, Oct 7) - a supervisor's direct reports today (clocked
in / out / on leave / late) and what of theirs is overdue, for the My Team
dashboard tile (minRole 'supervisor' in widgets.jsx).

Gating: `require_level(2)` - supervisor and up, the same level the dashboards
router's `scope=team` KPIs unlock on (`user["level"] >= 2`).

SCAFFOLD: both endpoints return their empty shape. The builder fills in the
bodies; keep the paths and keys - api.getMyTeamToday / getMyTeamOverdue and
the tile read them.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from auth import require_level
from database import get_db

router = APIRouter(prefix="", tags=["My Team"])

require_supervisor = require_level(2)


@router.get("/me/team/today")
def my_team_today(user: dict = Depends(require_supervisor), db: Session = Depends(get_db)):
    return {"in": [], "out": [], "onLeave": [], "late": [], "counts": {"in": 0, "out": 0, "onLeave": 0, "late": 0}}


@router.get("/me/team/overdue")
def my_team_overdue(user: dict = Depends(require_supervisor), db: Session = Depends(get_db)):
    return {"people": []}
