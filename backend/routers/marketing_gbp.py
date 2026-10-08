"""Google Business Profile endpoints (Marketing, Neil call of 10/01) - gbp.py.

Who may do what:
  - see listings, reviews, performance, posts and photos:  Marketing grant (viewer)
  - reply / edit / delete a reply, posts and photos, Sync Now: Marketing grant (editor)
  - edit the listing, map a location:                      Marketing grant (full)
  - connect / disconnect the Google account: administrators

Two routers, like routers/egnyte_oauth.py: `router` needs a signed-in user;
`public_router` is the OAuth callback Google redirects a bare browser to -
identity comes from the sealed `state`, never a bearer token.

A location is addressed by its Google number (the "123" of locations/123),
which keeps the slash out of the URL path.
"""
import urllib.parse
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

import gbp
import gbp_client
from app_url import app_url
from auth import get_current_user, require_administrator, require_module_grant
from database import get_db
from gbp_client import GbpError

router = APIRouter(prefix="/marketing/gbp", tags=["Marketing - Google Business Profile"],
                   dependencies=[Depends(get_current_user)])
public_router = APIRouter(prefix="/marketing/gbp", tags=["Marketing - Google Business Profile"])

can_view = require_module_grant("marketing", "viewer")
can_reply = require_module_grant("marketing", "editor")
can_edit_listing = require_module_grant("marketing", "full")


def _http(e: GbpError) -> HTTPException:
    """Google's refusal, in words someone can act on. Before Google approves
    the project's Business Profile API access every call is refused with a
    quota / permission error - say that plainly instead of passing it on."""
    msg = str(e)
    low = msg.lower()
    if e.status in (403, 429) and ("quota" in low or "has not been used" in low or "disabled" in low):
        msg = ("Google has not opened Business Profile API access for this project yet "
               "(the access request is pending, or the APIs are not enabled). " + msg)
    elif e.status == 401 and gbp_client.RECONNECT not in msg:
        msg = gbp_client.RECONNECT + " " + msg
    # Never 401: api.js reads a 401 as "the Nexus session is dead" and sends
    # the user through a Microsoft re-login. A dead GOOGLE connection is a
    # conflict with the server's state, so 409.
    code = 409 if e.status == 401 else e.status if e.status in (400, 403, 404, 409, 422, 429, 503) else 502
    return HTTPException(code, msg)


def _loc(key: str) -> str:
    key = (key or "").strip()
    if not key.isdigit():
        raise HTTPException(404, "Location not found")
    return f"locations/{key}"


@router.get("/status", dependencies=[Depends(can_view)])
def status(db: Session = Depends(get_db)):
    return gbp.status(db)


@router.get("/summary", dependencies=[Depends(can_view)])
def summary(db: Session = Depends(get_db)):
    """Real review figures for Marketing's alerts bell and AI Analyst."""
    return gbp.summary(db)


@router.get("/performance", dependencies=[Depends(can_view)])
def performance(start: str, end: str, location: str = "", db: Session = Depends(get_db)):
    try:
        return gbp.performance(db, _loc(location) if location else "", start, end)
    except GbpError as e:
        raise _http(e)


@router.post("/oauth/start", dependencies=[Depends(require_administrator)])
def oauth_start(user: dict = Depends(get_current_user)):
    reason = gbp_client.not_configured_reason()
    if reason:
        return {"url": "", "error": reason}
    return {"url": gbp_client.authorize_url(gbp.issue_state(user["email"])), "error": ""}


def _back(result: str, detail: str = "") -> RedirectResponse:
    """Back to Marketing > Business Profile with the outcome in the query
    string. The full /marketing/<tab> path matters: App.jsx rewrites a bare
    /marketing to its default tab and the query string would be lost."""
    q = {"gbp": result, **({"reason": detail[:200]} if detail else {})}
    return RedirectResponse(f"{app_url()}/marketing/marketing-listings?{urllib.parse.urlencode(q)}", status_code=303)


@public_router.get("/oauth/callback")
def oauth_callback(code: str = "", state: str = "", error: str = "", db: Session = Depends(get_db)):
    if error:
        return _back("denied")
    admin = gbp.consume_state(state)
    if not admin:
        return _back("error", "This connection link expired. Please try again.")
    if not code:
        return _back("error", "Google did not return an authorization code.")
    try:
        gbp.connect(db, code, admin)
    except GbpError as e:
        # Connected but the first sync was refused (typically: API access not
        # approved yet) - the connection itself is kept; say so.
        if gbp.status(db)["connected"]:
            return _back("connected", _http(e).detail)
        return _back("error", _http(e).detail)
    return _back("connected")


@router.delete("/connection", status_code=204, dependencies=[Depends(require_administrator)])
def disconnect(db: Session = Depends(get_db)):
    gbp.disconnect(db)


@router.post("/sync", dependencies=[Depends(can_reply)])
def sync_now(db: Session = Depends(get_db)):
    try:
        return gbp.sync(db)
    except GbpError as e:
        raise _http(e)


@router.get("/locations", dependencies=[Depends(can_view)])
def locations(db: Session = Depends(get_db)):
    return gbp.list_locations(db)


class FacilityIn(BaseModel):
    facility: str = ""


@router.patch("/locations/{key}/facility", dependencies=[Depends(can_edit_listing)])
def map_facility(key: str, body: FacilityIn, db: Session = Depends(get_db)):
    try:
        return gbp.map_facility(db, _loc(key), body.facility)
    except GbpError as e:
        raise _http(e)


class ListingIn(BaseModel):
    description: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    regularHours: Optional[dict] = None
    specialHours: Optional[dict] = None


@router.patch("/locations/{key}/listing")
def update_listing(key: str, body: ListingIn, user: dict = Depends(can_edit_listing), db: Session = Depends(get_db)):
    try:
        return gbp.update_listing(db, _loc(key), body.model_dump(exclude_unset=True), user["email"])
    except GbpError as e:
        raise _http(e)


@router.get("/locations/{key}/history", dependencies=[Depends(can_view)])
def listing_history(key: str, db: Session = Depends(get_db)):
    return gbp.listing_history(db, _loc(key))


@router.get("/reviews", dependencies=[Depends(can_view)])
def reviews(replied: str = "", location: str = "", limit: int = 200, offset: int = 0, db: Session = Depends(get_db)):
    return gbp.list_reviews(db, replied=replied if replied in ("yes", "no") else "",
                            location_id=_loc(location) if location else "", limit=limit, offset=offset)


class ReplyIn(BaseModel):
    text: str


@router.put("/reviews/{review_id}/reply")
def reply(review_id: str, body: ReplyIn, user: dict = Depends(can_reply), db: Session = Depends(get_db)):
    try:
        return gbp.reply(db, review_id, body.text, user["email"])
    except GbpError as e:
        raise _http(e)


@router.delete("/reviews/{review_id}/reply", status_code=204)
def delete_reply(review_id: str, user: dict = Depends(can_reply), db: Session = Depends(get_db)):
    try:
        gbp.delete_reply(db, review_id, user["email"])
    except GbpError as e:
        raise _http(e)


@router.get("/reviews/{review_id}/history", dependencies=[Depends(can_view)])
def review_history(review_id: str, db: Session = Depends(get_db)):
    return gbp.history(db, review_id)


# ── Posts ─────────────────────────────────────────────────────────────────────

class PostIn(BaseModel):
    summary: str = ""
    ctaType: str = ""
    ctaUrl: str = ""
    photoUrl: str = ""


@router.get("/locations/{key}/posts", dependencies=[Depends(can_view)])
def posts(key: str, db: Session = Depends(get_db)):
    try:
        return gbp.list_posts(db, _loc(key))
    except GbpError as e:
        raise _http(e)


@router.post("/locations/{key}/posts")
def create_post(key: str, body: PostIn, user: dict = Depends(can_reply), db: Session = Depends(get_db)):
    try:
        return gbp.create_post(db, _loc(key), body.model_dump(), user["email"])
    except GbpError as e:
        raise _http(e)


@router.patch("/locations/{key}/posts/{post_id}")
def update_post(key: str, post_id: str, body: PostIn, user: dict = Depends(can_reply), db: Session = Depends(get_db)):
    try:
        return gbp.update_post(db, _loc(key), post_id, body.model_dump(), user["email"])
    except GbpError as e:
        raise _http(e)


@router.delete("/locations/{key}/posts/{post_id}", status_code=204)
def delete_post(key: str, post_id: str, user: dict = Depends(can_reply), db: Session = Depends(get_db)):
    try:
        gbp.delete_post(db, _loc(key), post_id, user["email"])
    except GbpError as e:
        raise _http(e)


# ── Photos ────────────────────────────────────────────────────────────────────

@router.get("/locations/{key}/photos", dependencies=[Depends(can_view)])
def photos(key: str, db: Session = Depends(get_db)):
    try:
        return gbp.list_photos(db, _loc(key))
    except GbpError as e:
        raise _http(e)


@router.post("/locations/{key}/photos")
async def add_photo(key: str, file: UploadFile = File(...), category: str = Form("ADDITIONAL"),
                    user: dict = Depends(can_reply), db: Session = Depends(get_db)):
    # async only to read the upload; the Google calls and DB work run in a
    # thread (CLAUDE.md: never block the event loop).
    import asyncio
    data = await file.read(gbp.PHOTO_MAX_BYTES + 1)
    try:
        return await asyncio.to_thread(gbp.add_photo, db, _loc(key), data, file.content_type or "", category, user["email"])
    except GbpError as e:
        raise _http(e)


@router.delete("/locations/{key}/photos/{photo_id}", status_code=204)
def delete_photo(key: str, photo_id: str, user: dict = Depends(can_reply), db: Session = Depends(get_db)):
    try:
        gbp.delete_photo(db, _loc(key), photo_id, user["email"])
    except GbpError as e:
        raise _http(e)
