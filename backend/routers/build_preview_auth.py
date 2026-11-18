"""Sign-in for hosted Build Mode previews (11/13/2026) - the two halves of the
handoff in `build_preview.py` (read its docstring first).

`GET /auth/preview-handoff` runs on the DEV site (its own session cookie);
`POST /auth/preview-claim` runs on the preview (through the preview's /api
proxy) and sets that preview's session cookie. Both are under /auth/, the
prefix the CSRF guard leaves to the sign-in routes; the claim is guarded by
its single-use code and the verifier instead.
"""
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

import auth
import bff_session as bff
import build_preview
import client_ip
from database import SessionLocal
from models import AuditLog
from routers import auth_bff
from routers.dev_notes import _allowed

router = APIRouter(prefix="/auth", tags=["Auth (BFF)"])


def _may_preview(email: str, db) -> bool:
    """Build Mode access (any level) - previews are how a pin's author checks
    a fix, and no one else is sent to one."""
    return bool(email) and _allowed({"email": email}, db)


def _audit(db, email: str, action: str, detail: str) -> None:
    try:
        db.add(AuditLog(timestamp=build_preview._iso(), user_email=email, action=action,
                        resource_type="build_preview", resource_id="", details=detail[:500]))
        db.commit()
    except Exception:
        db.rollback()


def _page(status: int, text: str):
    # A plain sentence for a person who followed a link - never a JSON error.
    body = ("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
            "<title>Preview</title><body style='font:14px Inter,system-ui,sans-serif;margin:40px;color:#111'>"
            f"<p>{text}</p></body>")
    return HTMLResponse(body, status_code=status)


@router.get("/preview-handoff")
def preview_handoff(request: Request, to: str = "", next: str = "/", challenge: str = ""):
    if not build_preview.host_suffix():
        return _page(404, "Previews open from the dev site only.")
    origin = build_preview.preview_origin(to)
    if not origin or not build_preview.challenge_ok(challenge):
        return _page(400, "This preview link is not one of ours.")
    nxt = build_preview.safe_next(next)
    email = auth._email_from_session(request)
    if not email:
        # Sign in to the dev site first; the callback comes straight back here.
        if not bff.configured() or not auth_bff.APP_URL:
            return _page(503, "Sign-in is not set up on this server.")
        back = "/api/auth/preview-handoff?" + urlencode({"to": origin, "next": nxt, "challenge": challenge})
        return RedirectResponse(f"{auth_bff.APP_URL}/api/auth/login?next={quote(back, safe='')}", status_code=302)
    db = SessionLocal()
    try:
        if not _may_preview(email, db):
            return _page(403, "Previews are for people with Build Mode. Ask IT if you need it.")
        code = build_preview.issue(db, email, origin, challenge, ip=client_ip.client_ip(request))
        _audit(db, email, "build_preview_handoff", origin)
    finally:
        db.close()
    resp = RedirectResponse(f"{origin}{nxt}#nx_preview={code}", status_code=302)
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Cache-Control"] = "no-store"
    return resp


@router.post("/preview-claim")
def preview_claim(request: Request, body: dict):
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"detail": "Bad request"})
    db = SessionLocal()
    try:
        email = build_preview.claim(db, body.get("code"), body.get("verifier"),
                                    origin=request.headers.get("origin", ""))
        # Access is checked again at the claim: a grant taken away in the
        # last minute still counts.
        if not email or not _may_preview(email, db):
            return JSONResponse(status_code=401, content={"detail": "This preview sign-in has expired - open the preview again"})
        sid, csrf = bff.create_passwordless_session(db, email)
        _audit(db, email, "build_preview_sign_in", request.headers.get("origin", ""))
    finally:
        db.close()
    resp = JSONResponse(content={"ok": True})
    auth_bff._set_cookie(resp, bff.SESSION_COOKIE, sid, http_only=True, max_age=auth_bff._SESSION_MAX_AGE)
    auth_bff._set_cookie(resp, bff.CSRF_COOKIE, csrf, http_only=False, max_age=auth_bff._SESSION_MAX_AGE)
    resp.headers["Cache-Control"] = "no-store"
    return resp
