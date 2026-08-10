"""Per-user Egnyte connection endpoints - mirrors routers/asana_oauth.py.

Two routers on purpose: `router` needs a signed-in user (personal grant only);
`public_router` is the OAuth callback Egnyte redirects a bare browser to -
identity comes from the single-use state row, never a bearer token.
"""
import urllib.parse

from fastapi import APIRouter, Depends
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

import egnyte_oauth
from app_url import app_url
from auth import get_current_user
from database import get_db

router = APIRouter(prefix="/egnyte-oauth", tags=["Egnyte"], dependencies=[Depends(get_current_user)])
public_router = APIRouter(prefix="/egnyte-oauth", tags=["Egnyte"])


@router.get("/status")
def status(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = egnyte_oauth.get_row(db, user["email"])
    return {
        "configured": egnyte_oauth.oauth_configured(),
        "notConfiguredReason": egnyte_oauth.not_configured_reason(),
        # The exact redirect URI to register in Egnyte's developer console -
        # a mismatch is the usual reason a first connection fails.
        "redirectUri": egnyte_oauth.redirect_uri(),
        "connected": bool(row and row.access_token_enc),
        "egnyteUsername": (row.egnyte_username or "") if row else "",
        "egnyteName": (row.egnyte_name or "") if row else "",
        "connectedAt": (row.created_at or "") if row else "",
    }


@router.post("/start")
def start(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if not egnyte_oauth.oauth_configured():
        return {"url": "", "error": egnyte_oauth.not_configured_reason()}
    state = egnyte_oauth.issue_state(db, user["email"])
    return {"url": egnyte_oauth.authorize_url(state), "error": ""}


@router.delete("/me", status_code=204)
def disconnect(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    egnyte_oauth.disconnect(db, user["email"])


def _back(result: str, detail: str = ""):
    """Land the browser back on the Egnyte module with the outcome in the
    query string; EgnyteApp reads ?egnyte= on mount and shows it."""
    q = {"egnyte": result}
    if detail:
        q["reason"] = detail[:200]
    return RedirectResponse(f"{app_url()}/egnyte?{urllib.parse.urlencode(q)}", status_code=303)


@public_router.get("/callback")
def callback(code: str = "", state: str = "", error: str = "",
             db: Session = Depends(get_db)):
    if error:
        return _back("denied")
    email = egnyte_oauth.consume_state(db, state)
    if not email:
        return _back("error", "This connection link expired. Please try again.")
    if not code:
        return _back("error", "Egnyte did not return an authorization code.")
    try:
        payload = egnyte_oauth.exchange_code(code)
    except ValueError as e:
        return _back("error", str(e))
    token = payload.get("access_token") or ""
    if not token:
        return _back("error", "Egnyte did not return an access token.")
    egnyte_oauth.save_grant(db, email, token, egnyte_oauth.whoami(token))
    return _back("connected")
