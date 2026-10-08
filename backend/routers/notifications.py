import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError
from pydantic import BaseModel
from typing import Optional, List
import httpx
from database import get_db
from auth import get_current_user, company_of, company_scope
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
    # 1 = a priority notice: the bar across the top of the recipient's screen
    # until they act (Neil, call of 09/29). Managers and above may raise one.
    priority:     Optional[int] = 0



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
    priority = 1 if n.priority else 0
    if priority and user["level"] < 3:
        raise HTTPException(403, "Manager or above required to raise a priority notice")
    if priority and not (n.recipient or "").strip():
        raise HTTPException(400, "A priority notice goes to a person, never to everyone")
    # Server-generate the id and INSERT (never merge/upsert on a client id) - a
    # client-supplied id + merge let a supervisor overwrite any existing
    # notification's contents/recipient. Ignore n.id entirely.
    server_id = str(uuid.uuid4())
    row = NexusNotification(
        id           = server_id,
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
        company      = company_of(user, db),   # company wall: sender's company
        created_at   = datetime.now(timezone.utc).isoformat(),
        priority     = priority,
    )
    db.add(row)
    db.commit()
    return {"id": server_id}


@router.get("")
def get_notifications(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """
    Returns notifications visible to the authenticated caller:
    - recipient IS NULL/empty  → broadcast to ALL MANAGERS ONLY (level >= 3).
      These carry who-requested-what, order totals and lost-item reports, so an
      employee must NEVER receive them - actioning/deleting was already manager-
      gated, but the read filter previously leaked every broadcast row to anyone.
    - recipient == email       → personal notification for this user
    Identity AND level come from the verified token - never from a query parameter.
    Filter is applied at the SQL level so the DB only sends relevant rows.
    """
    email = user["email"]
    is_manager = user.get("level", 0) >= 3
    # SQL-level filter: personal notifications for this user, PLUS broadcasts
    # (recipient="") only when the caller is a manager or above. Company wall:
    # once armed, a scoped manager sees only broadcasts from their own companies
    # (untagged/legacy broadcasts become Global-Admin-only); off = unchanged.
    from sqlalchemy import or_, and_
    q = db.query(NexusNotification)
    if is_manager:
        scope = company_scope(user, db)
        if scope is None:
            q = q.filter(or_(NexusNotification.recipient == "", NexusNotification.recipient == email))
        else:
            conds = [NexusNotification.recipient == email]
            if scope:
                conds.append(and_(NexusNotification.recipient == "",
                                  NexusNotification.company.in_(list(scope))))
            q = q.filter(or_(*conds))
    else:
        q = q.filter(NexusNotification.recipient == email)
    # Thirty days of history (Neil, 10/01), closed rows included - the bell
    # lists them under Closed so an accidental clear can be undone. The sweep
    # removes older rows; this filter keeps the list honest between sweeps.
    # created_at is an ISO string, so the comparison is lexical on the
    # YYYY-MM-DD prefix.
    q = q.filter(NexusNotification.created_at >= retention_cutoff())
    rows = (
        q.order_by(NexusNotification.created_at.desc())
        .limit(300)
        .all()
    )

    result = []
    for r in rows:
        read_list = [x for x in (r.read_by or "").split(",") if x]
        closed_list = [x for x in (r.closed_by or "").split(",") if x]
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
            "priority":     int(r.priority or 0),
            "closed":       email in closed_list,
        })
    return result


# Retention (Neil, 10/01): every notification stays 30 days, then goes.
RETENTION_DAYS = 30


def retention_cutoff(now: Optional[datetime] = None) -> str:
    return ((now or datetime.now(timezone.utc)) - timedelta(days=RETENTION_DAYS)).isoformat()


def _set_closed(row: NexusNotification, email: str, closed: bool) -> None:
    emails = [x for x in (row.closed_by or "").split(",") if x]
    if closed and email not in emails:
        emails.append(email)
    if not closed and email in emails:
        emails = [x for x in emails if x != email]
    row.closed_by = ",".join(emails)


def _may_clear(row: NexusNotification, user: dict) -> None:
    rec = (row.recipient or "").lower()
    # Only the intended recipient (or a manager for broadcast notifications) may close or restore it.
    if rec != "" and rec != user["email"]:
        raise HTTPException(403, "You can only clear your own notifications")
    if rec == "" and user["level"] < 3:
        raise HTTPException(403, "Manager or above required to clear broadcast notifications")


@router.patch("/{nid}/restore")
def restore_notification(nid: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Brings a closed notification back into the person's list."""
    row = db.query(NexusNotification).filter(NexusNotification.id == nid).first()
    if not row:
        return {"ok": False}
    _may_clear(row, user)
    _set_closed(row, user["email"], False)
    try:
        db.commit()
    except StaleDataError:
        db.rollback()
    return {"ok": True}


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
        # the SELECT above and this UPDATE - SQLAlchemy then raises
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
    """Clearing a notification CLOSES it for the caller (Neil, 10/01) - the
    row stays for its 30 days under the bell's Closed list, where Restore
    brings it back. Nothing a person does removes a row; only the sweep."""
    row = db.query(NexusNotification).filter(NexusNotification.id == nid).first()
    if not row:
        return {"ok": True}
    _may_clear(row, user)
    _set_closed(row, user["email"], True)
    try:
        db.commit()
    except StaleDataError:
        db.rollback()
    return {"ok": True}


# ── Send Alert ────────────────────────────────────────────────────────────────

class AlertIn(BaseModel):
    to:      List[str]
    subject: str
    message: str


def _alert_html(subject: str, message: str) -> str:
    """Branded alert email. Auto-populates from the alert content: plain lines
    become paragraphs, '•' lines (the overdue item lists the frontend builds)
    render as rows in a highlighted box. Inline styles only - email clients
    ignore stylesheets."""
    from html import escape

    parts: list = []
    bullets: list = []

    def flush_bullets():
        if not bullets:
            return
        rows = "".join(
            f"<tr><td style='padding:9px 16px;border-bottom:1px solid #fde8d4;"
            f"font-size:14px;color:#1f2937;line-height:1.5'>{b}</td></tr>"
            for b in bullets
        )
        parts.append(
            "<table width='100%' cellpadding='0' cellspacing='0' "
            "style='background:#fff7ed;border:1px solid #fdba74;border-radius:10px;"
            f"margin:6px 0 16px;border-collapse:separate'>{rows}</table>"
        )
        bullets.clear()

    for raw in message.split("\n"):
        stripped = raw.strip()
        if stripped.startswith("•"):
            bullets.append(escape(stripped[1:].strip()))
        elif stripped:
            flush_bullets()
            parts.append(
                f"<p style='margin:0 0 12px;font-size:14px;line-height:1.6;color:#1f2937'>{escape(stripped)}</p>"
            )
        else:
            flush_bullets()
    flush_bullets()

    return f"""<div style="background:#f4f5f7;padding:28px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
  <table align="center" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:14px;border:1px solid #e5e7eb;border-collapse:separate;overflow:hidden">
    <tr>
      <td style="background:#0f3d2e;padding:18px 28px">
        <span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:3px">GREENS GLOBAL</span>
      </td>
    </tr>
    <tr>
      <td style="background:#ea7317;padding:9px 28px">
        <span style="color:#ffffff;font-size:12px;font-weight:700;letter-spacing:.1em">&#9888; ALERT</span>
      </td>
    </tr>
    <tr>
      <td style="padding:26px 28px 14px">
        <h2 style="margin:0 0 16px;font-size:19px;color:#111827;line-height:1.35">{escape(subject)}</h2>
        {"".join(parts)}
      </td>
    </tr>
    <tr>
      <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-size:11.5px;color:#6b7280;line-height:1.5">
        Sent via Nexus. This is an automated alert - replies to this mailbox are not monitored.
      </td>
    </tr>
  </table>
</div>"""


def _graph_token() -> str:
    if not all([_AZURE_TENANT_ID, _AZURE_CLIENT_ID, _AZURE_CLIENT_SECRET]):
        raise HTTPException(503, "Email not configured - set AZURE_CLIENT_SECRET and NEXUS_FROM_EMAIL in env vars")
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
    if not (_NEXUS_FROM_EMAIL and _AZURE_CLIENT_SECRET):
        # Without this the response claimed email_sent=true while never even
        # attempting delivery - the UI showed success and nothing arrived.
        email_errors.append(
            "Email not configured: set AZURE_CLIENT_SECRET and NEXUS_FROM_EMAIL "
            "env vars (and grant the Entra app the Mail.Send application permission)"
        )
    else:
        try:
            token = _graph_token()
            html_body = _alert_html(body.subject, body.message)
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
    # Auth tokens carry only the email - show a readable name, not the address
    _local = user["email"].split("@", 1)[0]
    sender_name = " ".join(p.capitalize() for p in _local.replace("_", ".").split(".") if p) or user["email"]
    for recipient_email in body.to:
        db.add(NexusNotification(
            id=str(uuid.uuid4()),
            type="custom_alert",
            recipient=recipient_email.lower(),
            title=body.subject,
            body=f"{body.message}\n\n- {sender_name}",
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
