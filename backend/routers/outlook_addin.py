"""Outlook Add-in (Sep 16, Pranshu) - the compose-time auto-insert companion
to the in-app signature builder (routers/myhr.py). A separate router on
purpose: myhr's router carries a router-level dependency that validates the
SPA's Bearer ID token, but the add-in's Office.auth.getAccessToken() issues a
different token shape (an access token for this API's own "Expose an API"
Application ID URI, not an ID token) that needs auth.get_addin_user's own
validation path - kept isolated here so a misconfiguration on the Entra side
can only ever break this one route, never the SPA's own sign-in.

Deployment (outside this repo, done once by an M365/Entra admin - see the
add-in files under frontend/public/outlook-addin/):
  1. Nexus's existing Entra app registration -> Expose an API -> set an
     Application ID URI (default api://<client-id> is fine) -> Add a scope
     named access_as_user -> Admin consent.
  2. Same app registration -> Token configuration -> Add optional claim ->
     Access token -> add "email" and "upn".
  3. Microsoft 365 admin center -> Integrated apps -> Upload custom app ->
     the manifest.xml this router's endpoint backs. Pushes to every
     employee's Outlook (desktop, web, New Outlook) automatically.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database import get_db
from auth import get_addin_user
from models import HrEntity
from routers.myhr import _me, _render_signature, recipient_scope_ok

router = APIRouter(prefix="/outlook-addin", tags=["Outlook Add-in"])


@router.get("/signature")
def addin_signature(recipients: str = "", user: dict = Depends(get_addin_user),
                     db: Session = Depends(get_db)):
    """HTML only - the add-in just inserts it into the compose body via
    Office.js's setSignatureAsync, no other fields needed.

    `recipients` (comma-separated To+Cc addresses, Sep 22) drives the
    company's recipient-scope setting: empty html here means "suppress the
    signature", not "nothing to insert yet" - the add-in must call
    setSignatureAsync("") in that case to actively clear a previously
    inserted signature (e.g. all recipients just became internal-only on an
    external-only company). Called twice per email: once at compose-open
    (recipients may still be empty on a brand-new message) and once more at
    OnMessageSend with the final list, which is what has to be right."""
    e = _me(db, user["email"])
    company = db.query(HrEntity).filter(HrEntity.id == e.company).first() if e.company else None
    scope = (company.signature_recipient_scope if company else "") or "all"
    to_list = [r.strip().lower() for r in recipients.split(",") if r.strip()]
    if not recipient_scope_ok(scope, company, to_list):
        return {"html": ""}
    return {"html": _render_signature(e, db)["html"]}
