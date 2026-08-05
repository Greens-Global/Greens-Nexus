"""Backend-For-Frontend (BFF) login sessions for Nexus.

The browser holds ONLY an opaque, HttpOnly session cookie. The Entra tokens live
server-side in `server_sessions`, Fernet-encrypted at rest (secret_box /
NEXUS_VAULT_KEY). This module owns:
  - the confidential-client Entra OAuth (authorize URL + PKCE, code exchange,
    refresh) - the backend is a confidential client here, unlike the SPA/Bearer
    flow it runs alongside during the dual-mode migration,
  - the session store CRUD, including transparent server-side access-token refresh.

Identity resolution and the Bearer fallback stay in auth.get_current_user; this
module is only reached when a session cookie is present. See
docs/BFF-Migration-Plan.md.
"""
import os
import time
import json
import base64
import hashlib
import secrets
import urllib.parse
from datetime import datetime, timezone

import httpx

import secret_box
from auth import TENANT_ID, CLIENT_ID   # SAME app registration as the SPA/Bearer flow

# The confidential-client secret (Entra > app reg > Certificates & secrets). BFF
# is inert until this is set, so a deploy without it never breaks the Bearer path.
CLIENT_SECRET = os.getenv("NEXUS_BFF_CLIENT_SECRET", "").strip()

_AUTHORITY    = f"https://login.microsoftonline.com/{TENANT_ID}"
AUTHORIZE_URL = f"{_AUTHORITY}/oauth2/v2.0/authorize"
TOKEN_URL     = f"{_AUTHORITY}/oauth2/v2.0/token"
LOGOUT_URL    = f"{_AUTHORITY}/oauth2/v2.0/logout"
# offline_access -> a refresh token (the whole point: renew server-side, no
# browser iframe). openid/profile/email -> id token + identity claims.
SCOPES = "openid profile email offline_access"

SESSION_COOKIE = "nx_session"     # opaque session id (HttpOnly)
CSRF_COOKIE    = "nx_csrf"        # readable by JS, echoed back in X-CSRF-Token (double-submit)
LOGIN_COOKIE   = "nx_login"       # short-lived: carries {state, verifier, next} across the redirect

SESSION_IDLE_DAYS = 30            # no activity for this long -> session dead
_REFRESH_SKEW = 120              # refresh the access token this many seconds before it expires


def configured() -> bool:
    """BFF is usable only with a client secret. Gates the /auth routes and the
    cookie path in get_current_user, so an un-provisioned env is a clean no-op."""
    return bool(CLIENT_SECRET)


def _now() -> float:
    return time.time()


def _iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── PKCE ──────────────────────────────────────────────────────────────────────
def new_pkce() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def authorize_url(redirect_uri: str, state: str, challenge: str, login_hint: str = "") -> str:
    params = {
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "response_mode": "query",
        "scope": SCOPES,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    # Preselect the account (skip Entra's picker) when the client remembers who
    # last signed in on this browser. Entra still authenticates fully - the hint
    # only picks the tile, it never bypasses credentials.
    if login_hint:
        params["login_hint"] = login_hint
    return f"{AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"


def logout_url(post_logout_redirect_uri: str, id_token_hint: str = "") -> str:
    """Entra sign-out URL. Ending the IdP session (not just the app session) is
    what makes logout stick - otherwise /auth/login silently re-auths the still
    active Microsoft session and bounces the user straight back in.

    Pass id_token_hint (the account's id token) + client_id so Entra signs out the
    EXACT account and redirects straight back. Without them Entra can't tell which
    session to end, so it stalls on a blank "which account?" page, never ends the
    session, and never returns to post_logout_redirect_uri - which is exactly the
    'logged out of Nexus but Microsoft stays signed in' gap this closes."""
    params = {
        "post_logout_redirect_uri": post_logout_redirect_uri,
        "client_id": CLIENT_ID,
    }
    if id_token_hint:
        params["id_token_hint"] = id_token_hint
    return f"{LOGOUT_URL}?{urllib.parse.urlencode(params)}"


def _token_request(data: dict) -> dict:
    r = httpx.post(TOKEN_URL, data=data,
                   headers={"Accept": "application/json",
                            "Content-Type": "application/x-www-form-urlencoded"},
                   timeout=20)
    r.raise_for_status()
    return r.json()


def exchange_code(code: str, redirect_uri: str, verifier: str) -> dict:
    return _token_request({
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "code_verifier": verifier,
        "scope": SCOPES,
    })


def refresh_tokens(refresh_token: str) -> dict:
    return _token_request({
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "scope": SCOPES,
    })


# ── identity ──────────────────────────────────────────────────────────────────
def normalize_email(claims: dict) -> str:
    """Same canonical-identity rule as the Bearer path (auth.get_current_user):
    the @greensg.onmicrosoft.com UPN is rewritten to the primary @greensglobal.com
    so a user never splits into two identities."""
    email = (claims.get("preferred_username") or claims.get("upn")
             or claims.get("unique_name") or claims.get("email") or "").lower().strip()
    if email.endswith("@greensg.onmicrosoft.com"):
        email = email.split("@")[0] + "@greensglobal.com"
    return email


def _decode_id_claims(id_token: str) -> dict:
    """Read claims from an id_token WITHOUT signature verification. Safe here (and
    only here): this token came straight from Entra's token endpoint over TLS in
    THIS request - it was never handled by a client. The inbound Bearer path in
    auth.py, which receives a client-supplied token, still verifies fully."""
    try:
        payload = id_token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return {}


# ── session store ─────────────────────────────────────────────────────────────
def create_session(db, token_resp: dict) -> tuple[str, str, str]:
    """Persist a new session from an Entra token response. Returns
    (session_id, csrf_token, email); empty strings if identity can't be resolved."""
    from models import ServerSession
    claims = _decode_id_claims(token_resp.get("id_token", ""))
    email = normalize_email(claims)
    if not email:
        return "", "", ""
    sid = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(24)
    row = ServerSession(
        id=sid,
        user_email=email,
        csrf_token=csrf,
        access_token_enc=secret_box.encrypt(token_resp.get("access_token", "")),
        refresh_token_enc=secret_box.encrypt(token_resp.get("refresh_token", "")),
        id_token_enc=secret_box.encrypt(token_resp.get("id_token", "")),
        access_expires_at=_now() + int(token_resp.get("expires_in", 3600)),
        auth_time=float(claims.get("auth_time") or _now()),
        created_at=_iso(),
        last_seen=_iso(),
    )
    db.add(row)
    db.commit()
    return sid, csrf, email


def _idle_expired(row) -> bool:
    try:
        seen = datetime.fromisoformat(row.last_seen)
        return (datetime.now(timezone.utc) - seen).total_seconds() > SESSION_IDLE_DAYS * 86400
    except Exception:
        return False


def get_session(db, sid: str):
    """Load a session by cookie id, refreshing the access token server-side if it
    is near expiry. Returns the row (identity is `row.user_email`) or None if the
    session is unknown, idle-expired, or its refresh token was revoked."""
    from models import ServerSession
    if not sid:
        return None
    row = db.query(ServerSession).filter(ServerSession.id == sid).first()
    if not row:
        return None
    if _idle_expired(row):
        db.delete(row)
        db.commit()
        return None
    # Transparent refresh: the browser never renews anything - we do it here with
    # the confidential-client refresh token (no iframe, no third-party cookies).
    if row.access_expires_at and _now() > (row.access_expires_at - _REFRESH_SKEW):
        try:
            rt = secret_box.decrypt(row.refresh_token_enc or "")
            resp = refresh_tokens(rt) if rt else {}
            if resp.get("access_token"):
                row.access_token_enc = secret_box.encrypt(resp["access_token"])
                if resp.get("refresh_token"):        # Entra rotates refresh tokens
                    row.refresh_token_enc = secret_box.encrypt(resp["refresh_token"])
                if resp.get("id_token"):
                    row.id_token_enc = secret_box.encrypt(resp["id_token"])
                row.access_expires_at = _now() + int(resp.get("expires_in", 3600))
            else:
                raise ValueError("refresh returned no access_token")
        except Exception:
            # Refresh failed (revoked / password change / 90-day window) -> the
            # session is genuinely dead. Drop it; the client gets a clean 401 and
            # is sent to /auth/login (a real interactive sign-in, which works).
            db.delete(row)
            db.commit()
            return None
    # Throttle last_seen writes: this runs on EVERY authenticated request, so
    # persisting it every time would be a DB write per call. Only update when it's
    # meaningfully stale (idle-expiry has day granularity, so minutes is plenty).
    try:
        stale = (datetime.now(timezone.utc)
                 - datetime.fromisoformat(row.last_seen)).total_seconds() > 300
    except Exception:
        stale = True
    if stale:
        row.last_seen = _iso()
        db.commit()
    return row


# ── delegated Graph tokens (server-side Teams posting) ────────────────────────
# Entra v2 refresh tokens are not resource-bound: the SAME refresh token the
# session already holds can be redeemed for a Microsoft Graph access token, as
# long as the user (or an admin, org-wide) has consented to the scopes. This is
# what lets the BACKEND post the BOD/EOD Teams message as the user - the
# confidential-client refresh chain lives for ~90 days rolling, vs the ~24h cap
# on browser-side SPA tokens that made client-side posting unreliable.
GRAPH_CHAT_SCOPES = ("https://graph.microsoft.com/Chat.ReadBasic "
                     "https://graph.microsoft.com/ChatMessage.Send offline_access")


def graph_token_for_email(db, email: str) -> str:
    """Mint a delegated Graph chat token for this user from their most recent
    live session. Persists the rotated refresh token back onto the session so
    the chain keeps extending. Returns '' when no session can produce one (user
    fully logged out everywhere, consent missing, or refresh revoked)."""
    from models import ServerSession
    if not configured() or not email:
        return ""
    rows = (db.query(ServerSession)
            .filter(ServerSession.user_email == email.lower())
            .order_by(ServerSession.last_seen.desc()).limit(3).all())
    for row in rows:
        try:
            rt = secret_box.decrypt(row.refresh_token_enc or "")
            if not rt:
                continue
            resp = _token_request({
                "client_id": CLIENT_ID,
                "client_secret": CLIENT_SECRET,
                "grant_type": "refresh_token",
                "refresh_token": rt,
                "scope": GRAPH_CHAT_SCOPES,
            })
            if resp.get("refresh_token"):            # Entra rotates refresh tokens
                row.refresh_token_enc = secret_box.encrypt(resp["refresh_token"])
                db.commit()
            tok = resp.get("access_token", "")
            if tok:
                return tok
        except Exception:
            continue   # try an older session; '' if none works
    return ""


def delete_session(db, sid: str) -> None:
    from models import ServerSession
    if not sid:
        return
    row = db.query(ServerSession).filter(ServerSession.id == sid).first()
    if row:
        db.delete(row)
        db.commit()
