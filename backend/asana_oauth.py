"""Per-user Asana OAuth - so a comment pushed from Nexus appears in Asana under
the person who actually wrote it.

Asana attributes a story to whoever owns the token that posted it, and its API
has no impersonation parameter. The old workaround stamped the author's email
into the comment TEXT (`[Nexus - someone@...]`); this replaces that with a real
per-user grant.

Scope is deliberately COMMENTS ONLY. push_comment is the one outbound write
where the acting user is already in scope (comment.author_email). Task field
edits keep using the service token: on_task_changed carries only a task id
across its thread boundary, Task has no modified_by column, and several module
caches in asana_sync are keyed on (cfg.token, ...) - making those per-actor is a
separate, much larger change.

Setup (deployment, once):
  - Register an app in Asana (https://app.asana.com/0/my-apps).
  - Redirect URI must be exactly  {public_base()}/asana-oauth/callback
  - Set ASANA_OAUTH_CLIENT_ID / ASANA_OAUTH_CLIENT_SECRET.
Until then oauth_configured() is False, the Account Settings card says so, and
every comment keeps going out under the service token.
"""
import json
import os
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone

import models
import secret_box
from routers.task_util import gen_id, now_iso

_AUTHORIZE_URL = "https://app.asana.com/-/oauth_authorize"
_TOKEN_URL = "https://app.asana.com/-/oauth_token"

# An authorization that hasn't come back within this long is abandoned - the
# state row is the only thing binding a callback to a Nexus user, so it must
# not stay usable indefinitely.
STATE_TTL_SECONDS = 10 * 60

# Refresh this far ahead of expiry rather than exactly at it, so a token can't
# lapse between the check and the Asana call that uses it.
_REFRESH_SKEW_SECONDS = 60


def _client_id() -> str:
    return os.getenv("ASANA_OAUTH_CLIENT_ID", "").strip()


def _client_secret() -> str:
    return os.getenv("ASANA_OAUTH_CLIENT_SECRET", "").strip()


def redirect_uri() -> str:
    """Must match what's registered in the Asana app exactly. Empty on a laptop
    (public_base() has no host to derive from), which is what makes
    oauth_configured() False locally - Asana can't redirect a browser to a
    machine it can't reach."""
    from asana_sync import public_base
    base = public_base()
    return f"{base}/asana-oauth/callback" if base else ""


def oauth_configured() -> bool:
    return bool(_client_id() and _client_secret() and redirect_uri())


def not_configured_reason() -> str:
    """Why the Connect button is disabled - shown in Account Settings rather
    than leaving the user to guess."""
    if not _client_id() or not _client_secret():
        return "Asana app credentials are not set on the server (ASANA_OAUTH_CLIENT_ID / ASANA_OAUTH_CLIENT_SECRET)."
    if not redirect_uri():
        return "This environment has no public URL for Asana to redirect back to, so connecting only works on the deployed site."
    return ""


# ── the OAuth calls ──────────────────────────────────────────────────────────
def _post_form(payload: dict) -> dict:
    body = urllib.parse.urlencode(payload).encode()
    req = urllib.request.Request(
        _TOKEN_URL, data=body, method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="ignore")[:300]
        raise ValueError(f"Asana OAuth failed (HTTP {e.code}): {detail}") from e
    except urllib.error.URLError as e:
        raise ValueError(f"Asana OAuth failed (network): {e}") from e


def authorize_url(state: str) -> str:
    q = urllib.parse.urlencode({
        "client_id": _client_id(),
        "redirect_uri": redirect_uri(),
        "response_type": "code",
        "state": state,
    })
    return f"{_AUTHORIZE_URL}?{q}"


def exchange_code(code: str) -> dict:
    """Authorization code -> tokens. Asana returns the authorizing user inline
    as `data` {gid,name,email}, so no extra /users/me round-trip is needed."""
    return _post_form({
        "grant_type": "authorization_code",
        "client_id": _client_id(),
        "client_secret": _client_secret(),
        "redirect_uri": redirect_uri(),
        "code": code,
    })


def refresh(refresh_token: str) -> dict:
    return _post_form({
        "grant_type": "refresh_token",
        "client_id": _client_id(),
        "client_secret": _client_secret(),
        "refresh_token": refresh_token,
    })


# ── state rows ───────────────────────────────────────────────────────────────
def issue_state(db, email: str) -> str:
    state = gen_id()
    db.add(models.AsanaOAuthState(id=state, email=(email or "").lower(), created_at=now_iso()))
    db.commit()
    return state


def consume_state(db, state: str) -> str:
    """Returns the Nexus email that started this flow, or "" if the state is
    unknown/expired. Single-use: the row is deleted either way, so a replayed
    callback can't mint a second grant."""
    row = db.query(models.AsanaOAuthState).filter(models.AsanaOAuthState.id == (state or "")).first()
    if not row:
        return ""
    email = row.email or ""
    started = _parse_iso(row.created_at)
    db.delete(row)
    db.commit()
    if not started or (datetime.now(timezone.utc) - started).total_seconds() > STATE_TTL_SECONDS:
        return ""
    return email


def _parse_iso(value: str):
    try:
        d = datetime.fromisoformat((value or "").replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


# ── stored grants ────────────────────────────────────────────────────────────
def get_row(db, email: str):
    return db.query(models.AsanaUserToken).filter(
        models.AsanaUserToken.email == (email or "").lower()).first()


def save_grant(db, email: str, payload: dict) -> models.AsanaUserToken:
    """Upsert the grant from an exchange/refresh response. Re-connecting
    replaces the existing row rather than adding a second one for the same
    person (email is unique)."""
    email = (email or "").lower()
    who = payload.get("data") or {}
    expires_at = (datetime.now(timezone.utc)
                  + timedelta(seconds=int(payload.get("expires_in") or 3600))).isoformat()
    row = get_row(db, email)
    if not row:
        row = models.AsanaUserToken(id=gen_id(), email=email, created_at=now_iso())
        db.add(row)
    row.access_token_enc = secret_box.encrypt(payload.get("access_token") or "")
    # A refresh response omits refresh_token - keep the one we already hold
    # rather than blanking it, which would silently un-connect the user.
    if payload.get("refresh_token"):
        row.refresh_token_enc = secret_box.encrypt(payload["refresh_token"])
    row.expires_at = expires_at
    if who.get("gid"):
        row.asana_user_gid = str(who.get("gid"))
        row.asana_name = who.get("name") or ""
        row.asana_email = who.get("email") or ""
    row.updated_at = now_iso()
    db.commit()
    return row


def disconnect(db, email: str) -> bool:
    row = get_row(db, email)
    if not row:
        return False
    db.delete(row)
    db.commit()
    return True


def token_reason(db, email: str) -> tuple[str | None, str]:
    """(token, why-not) - token_for, plus the reason when there isn't one.

    Every "post as the service account instead" decision runs through here, so
    the reason a comment went out under the wrong name is a value the app can
    show rather than something only a server log knows. Account Settings
    promises "comments appear in Asana as <you>"; when that stops being true the
    user is the last to find out, because falling back is silent by design (it
    must never lose the comment).

    Reasons are for a person to read, not to branch on."""
    if not email:
        return None, "no author on the comment"
    if not oauth_configured():
        return None, not_configured_reason() or "Asana OAuth is not configured on this server"
    try:
        row = get_row(db, email)
        if not row:
            return None, f"{email} has not connected an Asana account"
        if not row.refresh_token_enc:
            return None, "the stored grant has no refresh token - reconnect to re-authorize"
        expires = _parse_iso(row.expires_at)
        fresh_enough = expires and (expires - datetime.now(timezone.utc)).total_seconds() > _REFRESH_SKEW_SECONDS
        if fresh_enough and row.access_token_enc:
            tok = secret_box.decrypt(row.access_token_enc) or None
            return (tok, "") if tok else (None, "the stored access token decrypted to nothing")
        payload = refresh(secret_box.decrypt(row.refresh_token_enc))
        if not payload.get("access_token"):
            # Silent before this: Asana accepted the refresh but returned no
            # token, and the caller could not tell that from "never connected".
            return None, "Asana refused to refresh the grant - it was probably revoked in Asana; reconnect"
        save_grant(db, email, payload)
        return payload["access_token"], ""
    except ValueError as e:
        # secret_box raises this when the ciphertext does not match the current
        # NEXUS_VAULT_KEY - the grant is unrecoverable and must be re-made.
        return None, f"the stored grant cannot be decrypted ({e}); disconnect and reconnect"
    except Exception as e:   # noqa: BLE001 - see token_for's docstring
        return None, f"{type(e).__name__}: {e}"


def token_for(db, email: str) -> str | None:
    """A usable Asana access token for this Nexus user, or None.

    None means "fall back to the service token" - the user never connected,
    their grant was revoked, or the stored ciphertext no longer matches
    NEXUS_VAULT_KEY. Never raises: this runs on the fire-and-forget comment
    push thread, where an exception would silently drop the comment.
    """
    if not email or not oauth_configured():
        return None
    try:
        row = get_row(db, email)
        if not row or not row.refresh_token_enc:
            return None
        expires = _parse_iso(row.expires_at)
        fresh_enough = expires and (expires - datetime.now(timezone.utc)).total_seconds() > _REFRESH_SKEW_SECONDS
        if fresh_enough and row.access_token_enc:
            return secret_box.decrypt(row.access_token_enc) or None
        # Expired or about to be - refresh in place.
        payload = refresh(secret_box.decrypt(row.refresh_token_enc))
        if not payload.get("access_token"):
            return None
        save_grant(db, email, payload)
        return payload["access_token"]
    except Exception as e:   # noqa: BLE001 - see docstring
        print(f"[asana-oauth] token_for({email}) failed, falling back to the service token: {e}")
        return None
