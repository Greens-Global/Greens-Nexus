import json
import os
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError
from pydantic import BaseModel
from typing import Optional, List
import httpx
from database import get_db
from auth import get_current_user
from models import NexusNotification, NexusRole

_AZURE_TENANT_ID    = os.getenv("AZURE_TENANT_ID", "")
_AZURE_CLIENT_ID    = os.getenv("AZURE_CLIENT_ID", "")
_AZURE_CLIENT_SECRET = os.getenv("AZURE_CLIENT_SECRET", "")
_NEXUS_FROM_EMAIL   = os.getenv("NEXUS_FROM_EMAIL", "")

router = APIRouter(prefix="/notifications", tags=["notifications"], dependencies=[Depends(get_current_user)])


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



@router.post("")
def create_notification(n: NotificationIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    # Only supervisors and above can create notifications via the API.
    # System notifications (from backend workflows) are written directly via
    # the internal _notify() helper in items.py, not this endpoint.
    if user["level"] < 2:
        raise HTTPException(403, "Supervisor or above required to create notifications")
    # Non-managers may only send personal notifications (to a specific recipient),
    # never broadcasts (recipient="") which go to every manager's bell.
    if user["level"] < 3 and not (n.recipient or "").strip():
        raise HTTPException(403, "Broadcast notifications require manager access")
    # Enforce field length limits to prevent storage abuse
    if len(n.title) > 200:
        raise HTTPException(400, "Title too long (max 200 chars)")
    if len(n.body) > 1000:
        raise HTTPException(400, "Body too long (max 1000 chars)")
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
def get_notifications(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """
    Returns notifications visible to the authenticated caller:
    - recipient IS NULL/empty  → broadcast to all managers (caller filters by role client-side)
    - recipient == email       → personal notification for this user
    Identity comes from the verified token — never from a query parameter.
    Filter is applied at the SQL level so the DB only sends relevant rows.
    """
    email = user["email"]
    # SQL-level filter: personal notifications for this user OR broadcasts (recipient="")
    from sqlalchemy import or_
    rows = (
        db.query(NexusNotification)
        .filter(or_(NexusNotification.recipient == "", NexusNotification.recipient == email))
        .order_by(NexusNotification.created_at.desc())
        .limit(100)
        .all()
    )

    result = []
    for r in rows:
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
def mark_read(nid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.query(NexusNotification).filter(NexusNotification.id == nid).first()
    if not row:
        return {"ok": False}
    emails = [x for x in (row.read_by or "").split(",") if x]
    if user["email"] not in emails:
        emails.append(user["email"])
        row.read_by = ",".join(emails)
        # Row can be deleted by a concurrent request (e.g. clearRead) between
        # the SELECT above and this UPDATE — SQLAlchemy then raises
        # StaleDataError ("0 rows matched"), which previously crashed the
        # whole request with a 502. The end state we want (read) is moot if
        # the notification is already gone, so treat that as success.
        try:
            db.commit()
        except StaleDataError:
            db.rollback()
    return {"ok": True}


@router.patch("/{nid}/action")
def mark_actioned(nid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.query(NexusNotification).filter(NexusNotification.id == nid).first()
    if not row:
        return {"ok": False}
    rec = (row.recipient or "").lower()
    # Only the intended recipient (or a manager for broadcast notifications) may action a notification.
    if rec != "" and rec != user["email"]:
        raise HTTPException(403, "You can only action your own notifications")
    if rec == "" and user["level"] < 3:
        raise HTTPException(403, "Manager or above required to action broadcast notifications")
    row.actioned = True
    try:
        db.commit()
    except StaleDataError:
        db.rollback()
    return {"ok": True}


@router.delete("/{nid}")
def delete_notification(nid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.query(NexusNotification).filter(NexusNotification.id == nid).first()
    if not row:
        return {"ok": True}
    rec = (row.recipient or "").lower()
    # Only the intended recipient (or a manager for broadcast notifications) may delete a notification.
    if rec != "" and rec != user["email"]:
        raise HTTPException(403, "You can only delete your own notifications")
    if rec == "" and user["level"] < 3:
        raise HTTPException(403, "Manager or above required to delete broadcast notifications")
    db.delete(row)
    db.commit()
    return {"ok": True}


# ── Send Alert ────────────────────────────────────────────────────────────────

class AlertIn(BaseModel):
    to:      List[str]
    subject: str
    message: str


def _graph_token() -> str:
    if not all([_AZURE_TENANT_ID, _AZURE_CLIENT_ID, _AZURE_CLIENT_SECRET]):
        raise HTTPException(503, "Email not configured — set AZURE_CLIENT_SECRET and NEXUS_FROM_EMAIL in env vars")
    resp = httpx.post(
        f"https://login.microsoftonline.com/{_AZURE_TENANT_ID}/oauth2/v2.0/token",
        data={
            "grant_type":    "client_credentials",
            "client_id":     _AZURE_CLIENT_ID,
            "client_secret": _AZURE_CLIENT_SECRET,
            "scope":         "https://graph.microsoft.com/.default",
        },
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


@router.post("/send-alert")
def send_alert(body: AlertIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if user["level"] < 3:
        raise HTTPException(403, "Manager or above required to send alerts")
    if not body.to:
        raise HTTPException(400, "At least one recipient required")
    if not body.subject.strip():
        raise HTTPException(400, "Subject is required")
    if not body.message.strip():
        raise HTTPException(400, "Message is required")

    # Resolve display names for recipients
    role_rows = db.query(NexusRole).filter(NexusRole.email.in_([e.lower() for e in body.to])).all()
    name_map  = {r.email.lower(): (r.display_name or r.email) for r in role_rows}

    email_errors = []
    if _NEXUS_FROM_EMAIL and _AZURE_CLIENT_SECRET:
        try:
            token = _graph_token()
            html_body = f"<p>{body.message.replace(chr(10), '<br>')}</p><hr><p style='font-size:12px;color:#666'>Sent via Greens Nexus by {user.get('name', user['email'])}</p>"
            resp = httpx.post(
                f"https://graph.microsoft.com/v1.0/users/{_NEXUS_FROM_EMAIL}/sendMail",
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json={
                    "message": {
                        "subject": body.subject,
                        "body":    {"contentType": "HTML", "content": html_body},
                        "toRecipients": [{"emailAddress": {"address": e}} for e in body.to],
                    },
                    "saveToSentItems": False,
                },
                timeout=15,
            )
            if not resp.is_success:
                email_errors.append(resp.text)
        except Exception as e:
            email_errors.append(str(e))

    # Always create Nexus bell notifications regardless of email outcome
    now = datetime.now(timezone.utc).isoformat()
    # Auth tokens carry only the email — show a readable name, not the address
    _local = user["email"].split("@", 1)[0]
    sender_name = " ".join(p.capitalize() for p in _local.replace("_", ".").split(".") if p) or user["email"]
    for recipient_email in body.to:
        db.add(NexusNotification(
            id=str(uuid.uuid4()),
            type="custom_alert",
            recipient=recipient_email.lower(),
            title=body.subject,
            body=f"{body.message}\n\n— {sender_name}",
            ref_id="",
            item_name="",
            requested_by=sender_name,
            action="",
            actioned=False,
            read_by="",
            created_at=now,
        ))
    db.commit()

    return {"ok": True, "email_sent": not email_errors, "email_errors": email_errors}
