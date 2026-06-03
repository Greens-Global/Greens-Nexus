import json
from datetime import datetime, timezone
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from database import get_db
from models import NexusNotification

router = APIRouter(prefix="/notifications", tags=["notifications"])


class NotificationIn(BaseModel):
    id:           str
    type:         str
    recipient:    Optional[str] = None
    title:        str
    body:         str
    ref_id:       Optional[str] = ""
    item_name:    Optional[str] = ""
    requested_by: Optional[str] = ""
    action:       Optional[dict] = None


class MarkRead(BaseModel):
    email: str


@router.post("")
def create_notification(n: NotificationIn, db: Session = Depends(get_db)):
    row = NexusNotification(
        id           = n.id,
        type         = n.type,
        recipient    = (n.recipient or "").lower(),
        title        = n.title,
        body         = n.body,
        ref_id       = n.ref_id or "",
        item_name    = n.item_name or "",
        requested_by = n.requested_by or "",
        action       = json.dumps(n.action) if n.action else "",
        actioned     = False,
        read_by      = "",
        created_at   = datetime.now(timezone.utc).isoformat(),
    )
    db.merge(row)   # upsert — idempotent on repeated calls
    db.commit()
    return {"id": n.id}


@router.get("")
def get_notifications(email: str, db: Session = Depends(get_db)):
    """
    Returns notifications visible to this email:
    - recipient IS NULL/empty  → broadcast to all managers (caller filters by role client-side)
    - recipient == email       → personal notification for this user
    """
    email = email.lower()
    rows = db.query(NexusNotification).order_by(NexusNotification.created_at.desc()).limit(100).all()

    result = []
    for r in rows:
        rec = (r.recipient or "").lower()
        if rec == "" or rec == email:
            read_list = [x for x in (r.read_by or "").split(",") if x]
            result.append({
                "id":           r.id,
                "type":         r.type,
                "recipient":    r.recipient,
                "title":        r.title,
                "body":         r.body,
                "ref_id":       r.ref_id,
                "item_name":    r.item_name,
                "requested_by": r.requested_by,
                "action":       json.loads(r.action) if r.action else None,
                "actioned":     r.actioned,
                "read":         email in read_list,
                "created_at":   r.created_at,
            })
    return result


@router.patch("/{nid}/read")
def mark_read(nid: str, body: MarkRead, db: Session = Depends(get_db)):
    row = db.query(NexusNotification).filter(NexusNotification.id == nid).first()
    if not row:
        return {"ok": False}
    emails = [x for x in (row.read_by or "").split(",") if x]
    if body.email.lower() not in emails:
        emails.append(body.email.lower())
        row.read_by = ",".join(emails)
        db.commit()
    return {"ok": True}


@router.patch("/{nid}/action")
def mark_actioned(nid: str, db: Session = Depends(get_db)):
    row = db.query(NexusNotification).filter(NexusNotification.id == nid).first()
    if row:
        row.actioned = True
        db.commit()
    return {"ok": True}


@router.delete("/{nid}")
def delete_notification(nid: str, db: Session = Depends(get_db)):
    db.query(NexusNotification).filter(NexusNotification.id == nid).delete()
    db.commit()
    return {"ok": True}
