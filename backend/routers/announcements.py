"""Announcements (Essentials, Oct 7) - company / department notices for the
Announcements dashboard tile, with per-person read and acknowledge marks.

Tables: models.Announcement (nexus_announcements) and models.AnnouncementRead
(nexus_announcement_reads). Everyone signed in can list, read and acknowledge;
create / edit / delete and the read-receipt list are administrator-level
(`require_administrator`, the AdminConsole gate).

SCAFFOLD: every endpoint below returns an empty shape. The builder fills in the
bodies; keep the paths, method names and gating as they are - api.js and the
tile already point at them.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from auth import get_current_user, require_administrator
from database import get_db

router = APIRouter(prefix="", tags=["Announcements"])


@router.get("/announcements")
def list_announcements(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Announcements the caller can see (company-wide + their department),
    newest first, each with the caller's read / acknowledged state."""
    return []


@router.post("/announcements")
def create_announcement(body: dict, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    return {}


@router.patch("/announcements/{announcement_id}")
def update_announcement(announcement_id: str, body: dict, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    return {}


@router.delete("/announcements/{announcement_id}")
def delete_announcement(announcement_id: str, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    return {}


@router.post("/announcements/{announcement_id}/read")
def mark_announcement_read(announcement_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return {}


@router.post("/announcements/{announcement_id}/ack")
def acknowledge_announcement(announcement_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return {}


@router.get("/announcements/{announcement_id}/reads")
def announcement_reads(announcement_id: str, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    """Who has read / acknowledged one announcement (administrators only)."""
    return []
