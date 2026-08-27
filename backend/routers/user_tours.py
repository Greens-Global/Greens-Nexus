"""Guided-tour "seen" state - which GuidedTour.jsx walkthroughs ONE user has
already been shown, so an auto-tour fires once per person instead of once per
browser. Self-service only, no admin gate: every read/write is scoped to the
caller's own email. Same posture and shape as task_prefs.py; see
models.py's UserTourState docstring for the data-shape rationale.

Deliberately dumb about what a tour IS - `tour` is an opaque client-owned id
("task", ...), validated only for shape and size.
"""
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import UserTourState

router = APIRouter(prefix="/tours", tags=["Tours"], dependencies=[Depends(get_current_user)])

MAX_TOURS = 40
MAX_KEY = 64


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row(db: Session, email: str, create: bool = False) -> UserTourState | None:
    row = db.query(UserTourState).filter(UserTourState.owner_email == email).first()
    if row is None and create:
        row = UserTourState(id=str(uuid.uuid4()), owner_email=email, seen={},
                             created_at=_now(), updated_at=_now())
        db.add(row)
        db.flush()
    return row


@router.get("")
def get_tours_seen(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Every tour this user has already dismissed. Absent = they've never
    seen it, which is not an error - a first-time user has no row."""
    row = _row(db, user["email"].lower())
    return {"seen": (row.seen or {}) if row else {}}


@router.post("/{tour}/seen")
def mark_tour_seen(tour: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    tour = (tour or "").strip()
    if not tour or len(tour) > MAX_KEY:
        raise HTTPException(400, "Invalid tour id")
    row = _row(db, user["email"].lower(), create=True)
    seen = dict(row.seen or {})
    if tour not in seen and len(seen) >= MAX_TOURS:
        raise HTTPException(400, "Too many tours recorded")
    seen[tour] = _now()
    row.seen = seen             # reassigned, not mutated - JSON columns only
    row.updated_at = _now()
    db.commit()
    return {"seen": seen}
