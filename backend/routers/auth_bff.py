"""BFF auth endpoints: server-side Entra login, session cookie, logout.

Public (no bearer) except /me. The browser never sees a token - /login redirects
to Entra, /callback exchanges the code and sets an HttpOnly session cookie, and
get_current_user (auth.py) resolves identity from that cookie. Runs ALONGSIDE the
Bearer flow (dual-mode) - inert until NEXUS_BFF_CLIENT_SECRET is set. See
docs/BFF-Migration-Plan.md.
"""
import os
import json
import secrets

from fastapi import APIRouter, Request, Depends
from fastapi.responses import RedirectResponse, JSONResponse

import secret_box
import bff_session as bff
from database import SessionLocal
from auth import get_current_user

router = APIRouter(prefix="/auth", tags=["Auth (BFF)"])

# Public origin of the app (e.g. https://nexus.greensglobal.com). The Cloudflare
# route proxies {APP_URL}/api/* -> this backend, so the registered redirect URI is
# {APP_URL}/api/auth/callback and post-login redirects go back to {APP_URL}.
APP_URL = os.getenv("NEXUS_APP_URL", "").rstrip("/")
_LOGIN_MAX_AGE = 600
_SESSION_MAX_AGE = bff.SESSION_IDLE_DAYS * 86400


def _redirect_uri() -> str:
    return f"{APP_URL}/api/auth/callback" if APP_URL else ""


def _set_cookie(resp, name, value, *, http_only=True, max_age=None):
    # Secure + SameSite=Lax: Lax already blocks cross-site POST/subresource (strong
    # CSRF defense); the CSRF token is defense-in-depth. First-party thanks to the
    # same-site /api proxy - that's the whole prerequisite for BFF.
    resp.set_cookie(name, value, max_age=max_age, path="/",
                    httponly=http_only, secure=True, samesite="lax")


@router.get("/login")
def login(request: Request, next: str = "/", hint: str = ""):
    if not bff.configured() or not _redirect_uri():
        return JSONResponse(status_code=503, content={"error": "BFF login not configured on the server"})
    verifier, challenge = bff.new_pkce()
    state = secrets.token_urlsafe(24)
    nxt = next if isinstance(next, str) and next.startswith("/") else "/"
    # login_hint: the email that last signed in on this browser (client-remembered)
    # so Entra preselects the account instead of asking. Sanity-gated; never trusted
    # for identity - the id token from the code exchange decides who the user is.
    hint = hint.strip().lower() if isinstance(hint, str) and "@" in hint and len(hint) < 200 else ""
    # Carry state + PKCE verifier + return path across the redirect in a short-lived,
    # encrypted, HttpOnly cookie (no server-side state table needed).
    payload = secret_box.encrypt(json.dumps({"s": state, "v": verifier, "n": nxt}))
    resp = RedirectResponse(bff.authorize_url(_redirect_uri(), state, challenge, login_hint=hint), status_code=302)
    _set_cookie(resp, bff.LOGIN_COOKIE, payload, http_only=True, max_age=_LOGIN_MAX_AGE)
    return resp


@router.get("/callback")
def callback(request: Request, code: str = "", state: str = "", error: str = ""):
    fail = RedirectResponse(f"{APP_URL}/?auth_error=1", status_code=302)
    if error or not code:
        return fail
    raw = request.cookies.get(bff.LOGIN_COOKIE, "")
    try:
        saved = json.loads(secret_box.decrypt(raw)) if raw else {}
    except Exception:
        saved = {}
    if not saved or saved.get("s") != state:      # state mismatch -> CSRF on the login flow
        return fail
    try:
        token_resp = bff.exchange_code(code, _redirect_uri(), saved.get("v", ""))
    except Exception:
        return fail
    db = SessionLocal()
    try:
        sid, csrf, email = bff.create_session(db, token_resp)
    except Exception:
        # e.g. the DB pool isn't ready yet during a restart. Never surface a raw
        # 500 to a user mid-login - send them back to a clean login to retry.
        return fail
    finally:
        db.close()
    if not sid:
        return fail
    nxt = saved.get("n") or "/"
    nxt = nxt if isinstance(nxt, str) and nxt.startswith("/") else "/"
    resp = RedirectResponse(f"{APP_URL}{nxt}", status_code=302)
    _set_cookie(resp, bff.SESSION_COOKIE, sid, http_only=True, max_age=_SESSION_MAX_AGE)
    _set_cookie(resp, bff.CSRF_COOKIE, csrf, http_only=False, max_age=_SESSION_MAX_AGE)
    resp.delete_cookie(bff.LOGIN_COOKIE, path="/")
    return resp


@router.get("/logout")
def logout(request: Request):
    """Full sign-out: drop the server session AND end the Entra SSO session, then
    land back on the app (which re-gates to a fresh login prompt). A GET so the
    browser can navigate to it and follow the redirect to Microsoft - clearing the
    app cookie alone was NOT enough, /auth/login just silently re-authed the still
    active Microsoft session and bounced the user right back in."""
    sid = request.cookies.get(bff.SESSION_COOKIE, "")
    id_token = ""
    db = SessionLocal()
    try:
        # Read the id_token BEFORE dropping the row - Entra needs it as id_token_hint
        # to sign out the exact account (no picker) and redirect cleanly back.
        if sid:
            from models import ServerSession
            row = db.query(ServerSession).filter(ServerSession.id == sid).first()
            if row and row.id_token_enc:
                try:
                    id_token = secret_box.decrypt(row.id_token_enc)
                except Exception:
                    id_token = ""
                # id tokens expire in ~1h and Entra IGNORES an expired
                # id_token_hint - the user gets the "pick an account" screen on
                # sign-out and the redirect back may never happen. Anyone idle
                # longer than an hour hit this (another "works for some"
                # inconsistency). Mint a fresh one first; best-effort - a stale
                # hint is still better than none.
                if row.access_expires_at and bff._now() > (row.access_expires_at - 120):
                    try:
                        rt = secret_box.decrypt(row.refresh_token_enc or "")
                        resp = bff.refresh_tokens(rt) if rt else {}
                        if resp.get("id_token"):
                            id_token = resp["id_token"]
                    except Exception:
                        pass
        bff.delete_session(db, sid)
    finally:
        db.close()
    dest = bff.logout_url(APP_URL, id_token) if (bff.configured() and APP_URL) else (APP_URL or "/")
    resp = RedirectResponse(dest, status_code=302)
    resp.delete_cookie(bff.SESSION_COOKIE, path="/")
    resp.delete_cookie(bff.CSRF_COOKIE, path="/")
    return resp


@router.get("/me")
def me(request: Request, user: dict = Depends(get_current_user)):
    """Bootstrap endpoint: who am I + display name + the CSRF token to echo on
    mutations. The name comes from the session's id-token so the app shows the
    real name (not the raw email) under cookie auth."""
    sid = request.cookies.get(bff.SESSION_COOKIE, "")
    name = ""
    if sid:
        db = SessionLocal()
        try:
            from models import ServerSession
            row = db.query(ServerSession).filter(ServerSession.id == sid).first()
            if row and row.id_token_enc:
                claims = bff._decode_id_claims(secret_box.decrypt(row.id_token_enc))
                name = (claims.get("name") or "").strip()
        except Exception:
            name = ""
        finally:
            db.close()
    return {
        "email": user["email"], "role": user["role"], "level": user["level"],
        "name": name or user["email"],
        "csrf": request.cookies.get(bff.CSRF_COOKIE, ""),
        "mode": "session" if sid else "bearer",
    }
