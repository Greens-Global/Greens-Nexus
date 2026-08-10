"""Per-user Egnyte OAuth - so browsing Egnyte from Nexus shows each person
exactly what THEIR Egnyte account can see, not everything the shared service
token can (Visesh, Aug 10).

Nexus keeps no permission logic at all: when a user has connected, their calls
run on their own token and Egnyte's folder permissions are the boundary. A
person with no Egnyte account (or none of the folders shared to them) sees
nothing, which is the correct answer.

Egnyte's OAuth is the standard authorization-code flow on a slightly unusual
endpoint - /puboauth/token serves BOTH the browser authorize redirect (GET)
and the code exchange (POST). Access tokens are long-lived and there is no
refresh token: a revoked/expired grant surfaces as a 401 on use, and the fix
is reconnecting.

Setup (deployment, once):
  - Register an API key at https://developers.egnyte.com (or the domain's
    Developer console) with redirect URI  {public_base()}/egnyte-oauth/callback
  - Set EGNYTE_OAUTH_CLIENT_ID / EGNYTE_OAUTH_CLIENT_SECRET.
Until then oauth_configured() is False and everything behaves exactly as
before (shared service token, module gated at supervisor).
"""
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import models
import secret_box
from routers.task_util import gen_id, now_iso

STATE_TTL_SECONDS = 10 * 60


def _client_id() -> str:
    return os.getenv("EGNYTE_OAUTH_CLIENT_ID", "").strip()


def _client_secret() -> str:
    return os.getenv("EGNYTE_OAUTH_CLIENT_SECRET", "").strip()


def _domain_base() -> str:
    """https://<tenant>.egnyte.com - same derivation as services/egnyte._auth,
    duplicated in 4 lines rather than importing the auth tuple (which requires
    the service TOKEN to be set; OAuth only needs the domain)."""
    dom = os.getenv("EGNYTE_DOMAIN", "").strip().rstrip("/")
    if not dom:
        return ""
    if dom.startswith("http"):
        return dom
    if "." not in dom:
        dom = f"{dom}.egnyte.com"
    return f"https://{dom}"


def redirect_uri() -> str:
    from asana_sync import public_base   # the backend's public URL helper
    base = public_base()
    return f"{base}/egnyte-oauth/callback" if base else ""


def oauth_configured() -> bool:
    return bool(_client_id() and _client_secret() and redirect_uri() and _domain_base())


def not_configured_reason() -> str:
    if not _domain_base():
        return "Egnyte is not connected on this server (EGNYTE_DOMAIN)."
    if not _client_id() or not _client_secret():
        return "Egnyte OAuth app credentials are not set on the server (EGNYTE_OAUTH_CLIENT_ID / EGNYTE_OAUTH_CLIENT_SECRET)."
    if not redirect_uri():
        return "This environment has no public URL for Egnyte to redirect back to, so connecting only works on the deployed site."
    return ""


def authorize_url(state: str) -> str:
    q = urllib.parse.urlencode({
        "client_id": _client_id(),
        "redirect_uri": redirect_uri(),
        "scope": "Egnyte.filesystem",
        "state": state,
        "response_type": "code",
    })
    return f"{_domain_base()}/puboauth/token?{q}"


def exchange_code(code: str) -> dict:
    body = urllib.parse.urlencode({
        "client_id": _client_id(),
        "client_secret": _client_secret(),
        "redirect_uri": redirect_uri(),
        "code": code,
        "grant_type": "authorization_code",
    }).encode()
    req = urllib.request.Request(
        f"{_domain_base()}/puboauth/token", data=body, method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="ignore")[:300]
        raise ValueError(f"Egnyte OAuth failed (HTTP {e.code}): {detail}") from e
    except urllib.error.URLError as e:
        raise ValueError(f"Egnyte OAuth failed (network): {e}") from e


def whoami(token: str) -> dict:
    """The connected Egnyte identity - stored so the UI can say who you are in
    Egnyte ('Connected as vlodha')."""
    req = urllib.request.Request(
        f"{_domain_base()}/pubapi/v1/userinfo",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read() or b"{}")
    except Exception:  # noqa: BLE001 - identity is a nicety, the token is the point
        return {}


# ── state rows ───────────────────────────────────────────────────────────────

def issue_state(db, email: str) -> str:
    state = gen_id()
    db.add(models.EgnyteOAuthState(id=state, email=(email or "").lower(), created_at=now_iso()))
    db.commit()
    return state


def consume_state(db, state: str) -> str:
    row = db.query(models.EgnyteOAuthState).filter(models.EgnyteOAuthState.id == (state or "")).first()
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
    return db.query(models.EgnyteUserToken).filter(
        models.EgnyteUserToken.email == (email or "").lower()).first()


def save_grant(db, email: str, access_token: str, who: dict) -> models.EgnyteUserToken:
    email = (email or "").lower()
    row = get_row(db, email)
    if not row:
        row = models.EgnyteUserToken(id=gen_id(), email=email, created_at=now_iso())
        db.add(row)
    row.access_token_enc = secret_box.encrypt(access_token or "")
    row.egnyte_username = (who.get("username") or "") if who else ""
    name = f"{(who.get('first_name') or '').strip()} {(who.get('last_name') or '').strip()}".strip() if who else ""
    row.egnyte_name = name
    row.last_error = ""
    row.last_error_at = ""
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


def token_for(db, email: str) -> str | None:
    """The user's own Egnyte token, or None ("not connected" / undecryptable).
    Never raises - the caller decides what None means for its surface."""
    if not email or not oauth_configured():
        return None
    try:
        row = get_row(db, email)
        if not row or not row.access_token_enc:
            return None
        return secret_box.decrypt(row.access_token_enc) or None
    except Exception as e:  # noqa: BLE001 - vault-key mismatch etc.
        print(f"[egnyte-oauth] token_for({email}) failed: {e}")
        return None
