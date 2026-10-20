"""Sign in once with a Google account Cubby has granted warehouse access, and
save the login Nexus uses to read StorTrack (docs/Cubby-StorTrack-Setup.md).

Cubby gives people access to its BigQuery warehouse by their Google account
(Sep 2026). This makes that access usable by the Nexus API: it signs in
through your browser and writes an "authorized_user" JSON (OAuth client id +
secret + refresh token + billing project) to a file on THIS computer. That
file's contents go into the API's CUBBY_BQ_CREDENTIALS_JSON app setting.

    python backend/scripts/cubby_bq_login.py --client <client_secret_....json> --project <google-cloud-project-id>
    python backend/scripts/cubby_bq_login.py --check --out <saved file>     # test a saved login

--client  the OAuth client JSON downloaded from Google Cloud (APIs & Services
          > Credentials > your OAuth client, application type "Desktop app")
--project the Google Cloud project queries are billed to (the one with the
          BigQuery API enabled)
--out     where to save the login (default: cubby-bq-login.json in your home
          folder - never inside the repo)

The refresh token is a password: this script never prints it, and the file
must never be committed, emailed or pasted in chat.
"""
import argparse
import base64
import hashlib
import http.server
import json
import os
import secrets
import sys
import threading
import urllib.parse
import webbrowser
from pathlib import Path

import httpx

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/bigquery"
TABLE = "cubby-partner-data.analytics.stor_track"


def _client_info(path: str) -> tuple[str, str]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    block = data.get("installed") or data.get("web") or data
    cid, secret = block.get("client_id"), block.get("client_secret")
    if not cid or not secret:
        sys.exit("That file has no client_id / client_secret. Download the OAuth client JSON from Google Cloud.")
    if "web" in data:
        print("Note: this is a Web client. If Google says redirect_uri_mismatch, create a 'Desktop app' client instead.")
    return cid, secret


def _sign_in(client_id: str, client_secret: str) -> str:
    """Browser sign-in on a loopback redirect, with PKCE. Returns the refresh token."""
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(24)
    got: dict = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - http.server API
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            if "code" in q or "error" in q:
                got.update({k: v[0] for k, v in q.items()})
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"<p style='font-family:sans-serif'>Signed in. You can close this tab and go back to the terminal.</p>")

        def log_message(self, *a):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    redirect = f"http://127.0.0.1:{server.server_port}/"
    url = AUTH_URL + "?" + urllib.parse.urlencode({
        "client_id": client_id, "redirect_uri": redirect, "response_type": "code", "scope": SCOPE,
        "access_type": "offline", "prompt": "consent", "state": state,
        "code_challenge": challenge, "code_challenge_method": "S256"})
    t = threading.Thread(target=lambda: [server.handle_request() for _ in range(5) if not got], daemon=True)
    t.start()
    print("Opening your browser to sign in. Use the Google account Cubby granted access.")
    print("If it does not open, paste this address into the browser:\n" + url)
    webbrowser.open(url)
    t.join(timeout=300)
    server.server_close()
    if got.get("error"):
        sys.exit(f"Google said: {got['error']}")
    if not got.get("code") or got.get("state") != state:
        sys.exit("No sign-in came back (timed out or the state did not match). Run it again.")
    r = httpx.post(TOKEN_URL, data={
        "code": got["code"], "client_id": client_id, "client_secret": client_secret, "redirect_uri": redirect,
        "grant_type": "authorization_code", "code_verifier": verifier}, timeout=30)
    if r.status_code != 200:
        sys.exit(f"Google refused the sign-in code ({r.status_code}): {r.json().get('error_description') or r.json().get('error')}")
    token = r.json().get("refresh_token")
    if not token:
        sys.exit("Google returned no refresh token. Remove the app's access at myaccount.google.com/permissions and run again.")
    return token


def _check(path: Path) -> None:
    """Run one small query as the saved login: rows in the last 30 days and the newest date."""
    try:
        from google.cloud import bigquery
        from google.oauth2 import credentials
    except ImportError:
        sys.exit("Install google-cloud-bigquery first (pip install -r backend/requirements.txt).")
    info = json.loads(path.read_text(encoding="utf-8"))
    creds = credentials.Credentials.from_authorized_user_info(info, scopes=[SCOPE])
    client = bigquery.Client(project=info.get("quota_project_id"), credentials=creds)
    sql = (f"SELECT COUNT(*) AS n, MAX(date_collected) AS latest, COUNT(DISTINCT facility_id) AS facilities "
           f"FROM `{TABLE}` WHERE date_collected >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)")
    try:
        row = list(client.query(sql).result(timeout=120))[0]
    except Exception as e:  # noqa: BLE001 - show Google's reason, never the token
        sys.exit(f"The query failed: {type(e).__name__}: {str(getattr(e, 'message', e))[:300]}")
    print(f"Works. StorTrack rows in the last 30 days: {row['n']:,} across {row['facilities']} facilities; newest {row['latest']}.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--client", help="OAuth client JSON downloaded from Google Cloud")
    ap.add_argument("--project", help="Google Cloud project id queries are billed to")
    ap.add_argument("--out", default=str(Path.home() / "cubby-bq-login.json"))
    ap.add_argument("--check", action="store_true", help="only test the saved login")
    a = ap.parse_args()
    out = Path(a.out).expanduser().resolve()
    if a.check:
        return _check(out)
    if not a.client or not a.project:
        ap.error("--client and --project are required to sign in")
    repo = Path(__file__).resolve().parents[2]
    if repo in out.parents:
        sys.exit("Save the login outside the repo (it is a password). Pick another --out.")
    cid, secret = _client_info(a.client)
    token = _sign_in(cid, secret)
    out.write_text(json.dumps({"type": "authorized_user", "client_id": cid, "client_secret": secret,
                               "refresh_token": token, "quota_project_id": a.project}), encoding="utf-8")
    try:
        os.chmod(out, 0o600)
    except OSError:
        pass
    print(f"Saved the login to {out}. Testing it...")
    _check(out)


if __name__ == "__main__":
    main()
