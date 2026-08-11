"""Per-user Egnyte OAuth - so browsing Egnyte from Nexus shows each person
exactly what THEIR Egnyte account can see, not everything the shared service
token can (Visesh, Aug 10).

Nexus keeps no permission logic at all: when a user has connected, their calls
run on their own token and Egnyte's folder permissions are the boundary. A
person with no Egnyte account (or none of the folders shared to them) sees
nothing, which is the correct answer.

Egnyte's OAuth is the standard authorization-code flow. The browser goes to
/puboauth/authorize (GET) and the code is exchanged at /puboauth/token (POST).

  CORRECTION (Aug 11): this file used to say /puboauth/token served BOTH, and
  built the browser redirect against it. It does not, and connecting therefore
  failed for everyone, every time, since the feature shipped - the browser
  landed on Egnyte showing raw JSON: "Incorrect request type GET for resource
  owner flow". Verified against the live tenant: /puboauth/authorize with no
  client_id answers REQUIRED_PARAMS_MISSING, so it is a real browser endpoint.

THE APP REGISTRATION MUST BE THE RIGHT KIND, and this is not something code can
work around. An Egnyte API key is registered for ONE flow. Ours is registered
for the resource-owner (username/password) flow, which is what the shared
SERVICE token uses and which has no browser step at all - so /authorize refuses
it with that same "for resource owner flow" message even when the URL is right.
Per-user OAuth needs a SEPARATE key registered for the authorization-code flow.
Distinguishing the cases: an unknown key answers "No valid app info found for
api key", so the resource-owner message means Egnyte found the app and rejected
the FLOW, not the key.

Setup (deployment, once):
  - Register an API key at https://developers.egnyte.com (or the domain's
    Developer console) for the AUTHORIZATION-CODE flow - not resource owner -
    with redirect URI  {public_base()}/egnyte-oauth/callback
  - Set EGNYTE_OAUTH_CLIENT_ID / EGNYTE_OAUTH_CLIENT_SECRET to THAT key, which
    is not the same key as EGNYTE_API_KEY unless one app is registered for both.
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
    """/puboauth/AUTHORIZE - see the correction in the module docstring. Sending
    a browser to /puboauth/token instead is what made connecting fail for
    everyone since this shipped."""
    q = urllib.parse.urlencode({
        "client_id": _client_id(),
        "redirect_uri": redirect_uri(),
        "scope": "Egnyte.filesystem",
        "state": state,
        "response_type": "code",
    })
    return f"{_domain_base()}/puboauth/authorize?{q}"


def preflight_error(state: str = "preflight") -> str:
    """Ask Egnyte whether it will accept this authorize request AT ALL, and turn
    a refusal into something a person can act on. "" means go ahead.

    Worth the extra round trip because the failure it catches is otherwise
    invisible: the browser leaves Nexus, lands on Egnyte, and shows raw JSON
    ("Incorrect request type GET for resource owner flow") with no way back and
    nothing naming the actual problem - which is a misregistered app, not
    anything the user did. Better to never send them.

    A GET here has no side effects: the authorize endpoint only renders a
    sign-in page until the user actually approves.
    """
    try:
        req = urllib.request.Request(
            authorize_url(state), method="GET",
            headers={"Accept": "application/json, text/html", "User-Agent": "Nexus-preflight"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            status, body = resp.status, resp.read(500).decode(errors="ignore")
    except urllib.error.HTTPError as e:
        status, body = e.code, e.read(500).decode(errors="ignore")
    except Exception:      # noqa: BLE001 - a network blip must not block connecting
        return ""

    if status < 400:
        return ""
    low = body.lower()
    if "resource owner" in low:
        return ("This Egnyte app is registered for the resource-owner (username and password) "
                "flow, which has no browser sign-in step, so connecting can never complete. "
                "Connecting needs a SEPARATE Egnyte API key registered for the "
                "authorization-code flow, set as EGNYTE_OAUTH_CLIENT_ID / "
                "EGNYTE_OAUTH_CLIENT_SECRET.")
    if "no valid app info" in low:
        return "Egnyte does not recognize EGNYTE_OAUTH_CLIENT_ID. Check the key on the server."
    if "redirect" in low:
        return ("Egnyte rejected the redirect URI. Register this exact URI on the Egnyte app: "
                f"{redirect_uri()}")
    return f"Egnyte refused the connection request (HTTP {status}). {body[:160]}"


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
