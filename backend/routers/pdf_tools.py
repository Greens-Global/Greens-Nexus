"""PDF Tools: who did what (Neil, 11/02/2026).

PDF Tools edits files in the browser, in an iframe, so the server never sees
what happens to a file unless the browser says so. The shell
(frontend/src/views/PdfEditorModule.jsx) reports each action here and this
router writes ONE audit_logs row for it, which the Audit Log screen shows under
Documents & E-Sign. No new table.

What is kept: the action, the file's name, its page count, where it came from
and where it went. NEVER the file's contents or any text out of it - the body
has no field for them, and anything extra a client sends is dropped.

The row is written here, so AuditMiddleware skips this path (audit.py): its
generic row for the same POST would list every action twice. A report that
fails must never get in the way of the person's work - the shell ignores the
answer.
"""
import json
import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import audit_capture
from auth import get_current_user
from client_ip import client_ip
from database import get_db
from models import AuditLog

router = APIRouter(prefix="/pdf-tools", tags=["PDF Tools"])

# action -> (the title the Audit Log shows, its kind there).
ACTIONS = {
    "open": ("Opened a PDF in PDF Tools", "view"),
    "download": ("Downloaded a PDF from PDF Tools", "view"),
    "export": ("Exported a PDF from PDF Tools", "view"),
    "redact": ("Redacted a PDF in PDF Tools", "update"),
    "protect": ("Password-protected a PDF in PDF Tools", "update"),
    "save_egnyte": ("Saved a PDF to Egnyte from PDF Tools", "create"),
    "send_sign": ("Sent a PDF to Nexus Sign from PDF Tools", "create"),
}

# What is stored, per field. A longer value is cut, not refused: an unusually
# deep Egnyte path is still an event worth keeping.
NAME_CAP = 255
PLACE_CAP = 512
# What is accepted at all. Past this it is not a file name or a path.
BODY_CAP = 8192
MAX_PAGES = 1_000_000

_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")


class PdfToolsEvent(BaseModel):
    action: str = Field(max_length=32)
    fileName: Optional[str] = Field(default="", max_length=BODY_CAP)
    pages: Optional[int] = 0
    source: Optional[str] = Field(default="", max_length=BODY_CAP)
    destination: Optional[str] = Field(default="", max_length=BODY_CAP)


def _clean(value: Optional[str], cap: int) -> str:
    return _CONTROL.sub(" ", value or "").strip()[:cap]


@router.post("/events")
def record_event(body: PdfToolsEvent, request: Request, user: dict = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    known = ACTIONS.get(body.action)
    if not known:
        raise HTTPException(400, "Unknown PDF Tools action")
    title, kind = known
    path = request.url.path
    details = {"path": path, "method": "POST", "status": 200}
    for key, value in (("file_name", _clean(body.fileName, NAME_CAP)),
                       ("pages", max(0, min(body.pages or 0, MAX_PAGES))),
                       ("source", _clean(body.source, PLACE_CAP)),
                       ("destination", _clean(body.destination, PLACE_CAP))):
        if value:
            details[key] = value
    details["event"] = body.action
    # Act As: the real person did it, as the middleware's rows say.
    ctx = audit_capture.current()
    db.add(AuditLog(
        timestamp=datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
        user_email=(ctx.actor if ctx is not None and ctx.actor else user["email"]),
        user_role=user.get("role", "") or "",
        action=title,
        resource_type="pdf_tools",
        resource_id="",
        details=json.dumps(details),
        ip_address=client_ip(request),
        module="documents",
        kind=kind,
        acting_as=(ctx.acting_as if ctx is not None else "") or "",
    ))
    db.commit()
    return {"ok": True}
