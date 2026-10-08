"""My Work (Essentials, Oct 7) - the signed-in person's open work, bucketed by
when it is due, for the My Work dashboard tile.

SCAFFOLD: returns the empty shape. The builder fills in the body (tasks
assigned to the caller, tickets, approvals waiting on them ...); keep the
path and the four bucket keys - api.getMyWork and the tile read them.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db

router = APIRouter(prefix="", tags=["My Work"])


@router.get("/me/work")
def my_work(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return {"overdue": [], "today": [], "week": [], "later": []}
