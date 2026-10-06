"""Google Ads endpoints (Marketing, plan Phase 3) - google_ads.py. Read-only
against Google: nothing here changes a campaign.

Who may do what:
  - see the figures:                         Marketing grant (viewer)
  - Sync Now, set the monthly budgets:       Marketing grant (editor)
  - map campaigns to facilities:             Marketing grant (full)
  - connect / disconnect the Google account: administrators

Two routers, as routers/marketing_gbp.py: `public_router` is the OAuth
callback Google redirects a bare browser to - identity comes from the sealed
`state`, never a bearer token.
"""
import urllib.parse

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

import gbp_client
import google_ads
import google_ads_client
from app_url import app_url
from auth import get_current_user, require_administrator, require_module_grant
from database import get_db
from gbp_client import GbpError

router = APIRouter(prefix="/marketing/ads", tags=["Marketing - Google Ads"],
                   dependencies=[Depends(get_current_user)])
public_router = APIRouter(prefix="/marketing/ads", tags=["Marketing - Google Ads"])

can_view = require_module_grant("marketing", "viewer")
can_edit = require_module_grant("marketing", "editor")
can_map = require_module_grant("marketing", "full")


def _http(e: GbpError) -> HTTPException:
    msg = str(e)
    if e.status in (403, 429) and ("has not been used" in msg.lower() or "disabled" in msg.lower()):
        msg = "The Google Ads API is not enabled in the Google Cloud project yet. " + msg
    elif e.status == 401 and gbp_client.RECONNECT not in msg:
        msg = gbp_client.RECONNECT + " " + msg
    # Never 401 - api.js would take it as a dead Nexus session (marketing_gbp._http).
    code = 409 if e.status == 401 else e.status if e.status in (400, 403, 404, 409, 422, 429, 503) else 502
    return HTTPException(code, msg)


@router.get("/status", dependencies=[Depends(can_view)])
def status(db: Session = Depends(get_db)):
    return google_ads.status(db)


@router.get("/summary", dependencies=[Depends(can_view)])
def summary(db: Session = Depends(get_db)):
    """Real spend for Marketing's alerts bell and AI Analyst."""
    return google_ads.summary(db)


@router.get("/report", dependencies=[Depends(can_view)])
def report(start: str, end: str, facility: str = "", db: Session = Depends(get_db)):
    try:
        return google_ads.report(db, start, end, facility.strip())
    except GbpError as e:
        raise _http(e)


@router.post("/oauth/start", dependencies=[Depends(require_administrator)])
def oauth_start(user: dict = Depends(get_current_user)):
    reason = google_ads_client.not_configured_reason()
    if reason:
        return {"url": "", "error": reason}
    return {"url": google_ads_client.authorize_url(google_ads.issue_state(user["email"])), "error": ""}


def _back(result: str, detail: str = "") -> RedirectResponse:
    """Back to Marketing > Google Ads with the outcome in the query string."""
    q = {"ads": result, **({"reason": detail[:200]} if detail else {})}
    return RedirectResponse(f"{app_url()}/marketing/marketing-ads?{urllib.parse.urlencode(q)}", status_code=303)


@public_router.get("/oauth/callback")
def oauth_callback(code: str = "", state: str = "", error: str = "", db: Session = Depends(get_db)):
    if error:
        return _back("denied")
    admin = google_ads.consume_state(state)
    if not admin:
        return _back("error", "This connection link expired. Please try again.")
    if not code:
        return _back("error", "Google did not return an authorization code.")
    try:
        google_ads.connect(db, code, admin)
    except GbpError as e:
        # Connected, but the first sync was refused (typically: the Cloud project
        # still has Test access) - the connection is kept; say so.
        if google_ads.status(db)["connected"]:
            return _back("connected", _http(e).detail)
        return _back("error", _http(e).detail)
    return _back("connected")


@router.delete("/connection", status_code=204, dependencies=[Depends(require_administrator)])
def disconnect(db: Session = Depends(get_db)):
    google_ads.disconnect(db)


@router.post("/sync", dependencies=[Depends(can_edit)])
def sync_now(db: Session = Depends(get_db)):
    try:
        return google_ads.sync(db)
    except GbpError as e:
        raise _http(e)


@router.get("/campaigns", dependencies=[Depends(can_view)])
def campaigns(db: Session = Depends(get_db)):
    return google_ads.campaigns_for_mapping(db)


class MappingIn(BaseModel):
    changes: list


@router.put("/campaigns/facilities", dependencies=[Depends(can_map)])
def map_campaigns(body: MappingIn, db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    try:
        return google_ads.map_campaigns(db, body.changes, user["email"])
    except GbpError as e:
        raise _http(e)


@router.get("/budgets", dependencies=[Depends(can_view)])
def budgets(db: Session = Depends(get_db)):
    return google_ads.get_budgets(db)


class BudgetsIn(BaseModel):
    budgets: dict


@router.put("/budgets", dependencies=[Depends(can_edit)])
def set_budgets(body: BudgetsIn, db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    try:
        return google_ads.set_budgets(db, body.budgets, user["email"])
    except GbpError as e:
        raise _http(e)
