"""Per-user Asana connection - the endpoints behind Account Settings.

Two routers on purpose:
  - `router`        needs a signed-in user; every endpoint acts on THAT user's
                    own grant only, never anyone else's (no admin surface -
                    these are personal credentials).
  - `public_router` is the OAuth callback. Asana redirects a browser there with
                    no bearer token, so it can't sit behind auth - same reason
                    routers/asana_webhook.py is its own unauthenticated router.
                    Identity comes from the single-use `state` row instead.

Tokens are never returned to the client by any of these.
"""
import urllib.parse

from fastapi import APIRouter, Depends
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

import asana_oauth
import asana_sync
import models
from app_url import app_url
from auth import get_current_user
from database import get_db

router = APIRouter(prefix="/asana-oauth", tags=["Asana"], dependencies=[Depends(get_current_user)])
public_router = APIRouter(prefix="/asana-oauth", tags=["Asana"])


@router.get("/status")
def status(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = asana_oauth.get_row(db, user["email"])
    return {
        "configured": asana_oauth.oauth_configured(),
        "notConfiguredReason": asana_oauth.not_configured_reason(),
        # The exact string that must be registered as the app's redirect URI in
        # Asana. Not a secret (it's visible in the authorize URL anyway), and
        # having the server state it removes the guesswork from setup - a
        # mismatch here is the usual reason a first connection attempt fails.
        "redirectUri": asana_oauth.redirect_uri(),
        "connected": bool(row and row.refresh_token_enc),
        "asanaName": (row.asana_name or "") if row else "",
        "asanaEmail": (row.asana_email or "") if row else "",
        "connectedAt": (row.created_at or "") if row else "",
    }


@router.get("/check")
def check(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Would a comment posted right now go out as this person, or as the
    service account - and if the latter, why?

    Exists because the fallback is deliberately silent: losing a comment is
    worse than posting it under the wrong name, so every failure degrades
    instead of raising. That is right for the comment and useless for the
    person, who is told "comments appear as you" and then sees somebody else's
    name in Asana with nothing to explain it.

    Does the real thing rather than inspecting state: takes the same token
    push_comment would take and calls Asana with it. A grant can be perfectly
    valid and still be rejected by the project the task lives in, and only an
    actual request finds that out."""
    email = user["email"]
    token, why = asana_oauth.token_reason(db, email)
    out = {"willPostAsMe": False, "asanaName": "", "asanaEmail": "", "reason": why,
           "serviceAccountName": ""}

    # Who the shared token is - the name that shows up instead. Naming it turns
    # "why is Sai posting my comments" into an answered question.
    try:
        cfg = asana_sync.get_config(db)
        if cfg and cfg.token:
            me = asana_sync.asana_identity(cfg.token)
            out["serviceAccountName"] = me.get("name") or ""
    except Exception:
        pass

    if not token:
        return out
    try:
        me = asana_sync.asana_identity(token)
    except Exception as e:
        out["reason"] = f"Asana rejected your grant ({e}) - disconnect and reconnect"
        return out
    out.update({"asanaName": me.get("name") or "", "asanaEmail": me.get("email") or ""})

    # A valid grant is not the same as a usable one: Asana refuses writes on a
    # task the token's owner cannot reach, and /users/me succeeds regardless.
    #
    # Probed against a REAL synced task, not the workspace. A guest account is
    # a workspace member and would pass a workspace check while still being
    # unable to touch the task a comment is actually posted to - so a
    # workspace-level probe reports "working" about a connection that falls back
    # on every comment, which is the same blindness this endpoint exists to end.
    #
    # A read: proving write access by writing would leave test comments in a
    # real project.
    link = (db.query(models.AsanaTaskLink)
              .filter(models.AsanaTaskLink.asana_gid != "")
              .order_by(models.AsanaTaskLink.last_synced_at.desc()).first())
    if link:
        try:
            asana_sync.asana_task(token, link.asana_gid)
        except Exception as e:
            out["reason"] = (f"{me.get('name') or 'your Asana account'} cannot access the tasks this "
                             f"syncs to, so Asana refuses their comments ({e}). A Guest account only "
                             f"sees projects it has been added to - add it to the project, or connect "
                             f"an account that is a full workspace member.")
            return out

    out.update({"willPostAsMe": True, "reason": ""})
    return out


@router.post("/start")
def start(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if not asana_oauth.oauth_configured():
        return {"url": "", "error": asana_oauth.not_configured_reason()}
    state = asana_oauth.issue_state(db, user["email"])
    return {"url": asana_oauth.authorize_url(state), "error": ""}


@router.delete("/me", status_code=204)
def disconnect(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    asana_oauth.disconnect(db, user["email"])


def _back(result: str, detail: str = ""):
    """Land the browser back on the app. TopHeader reads ?asana= on mount and
    reopens Account Settings with the outcome, so the user ends up where they
    started rather than on a bare page."""
    q = {"asana": result}
    if detail:
        q["reason"] = detail[:200]
    return RedirectResponse(f"{app_url()}/?{urllib.parse.urlencode(q)}", status_code=303)


@public_router.get("/callback")
def callback(code: str = "", state: str = "", error: str = "",
             db: Session = Depends(get_db)):
    # Asana sends ?error=access_denied when the user clicks Deny.
    if error:
        return _back("denied")
    email = asana_oauth.consume_state(db, state)
    if not email:
        # Unknown or expired state - also the CSRF case (a callback for a flow
        # this server never issued).
        return _back("error", "This connection link expired. Please try again.")
    if not code:
        return _back("error", "Asana did not return an authorization code.")
    try:
        payload = asana_oauth.exchange_code(code)
    except ValueError as e:
        return _back("error", str(e))
    if not payload.get("access_token"):
        return _back("error", "Asana did not return an access token.")
    asana_oauth.save_grant(db, email, payload)
    return _back("connected")
