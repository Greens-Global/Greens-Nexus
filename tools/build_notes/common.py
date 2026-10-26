"""Shared pieces for the Build Mode tools: token and API base resolution, a
small urllib JSON client with friendly errors, multipart upload, streaming
download, and the US date formatter.

Standard library only. Works as a package module (`tools.build_notes.common`)
and as a plain file next to the scripts that import it.
"""

import datetime as _dt
import json
import mimetypes
import os
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

# The dev API and the dev site, as the frontend is built against them in CI
# (.github/workflows/ci.yml: VITE_API_BASE / VITE_REDIRECT_URI for the dev
# branch). Override the API with NEXUS_API_BASE or --api.
DEFAULT_API_BASE = "https://greens-nexus-api-dev-a6fad4brawevg8de.westus2-01.azurewebsites.net"
NEXUS_URL = os.environ.get("NEXUS_URL", "https://dev.nexus.greensglobal.com")

TOKEN_ENV = "NEXUS_BUILD_TOKEN"
API_ENV = "NEXUS_API_BASE"
TOKEN_FILE = Path.home() / ".config" / "nexus" / "build-notes.token"
CACHE_DIR = Path.home() / ".cache" / "nexus-build-notes"
TOKEN_PREFIX = "nxbn_"

MINT_HINT = "mint a new one in Nexus > Build Mode > Settings and save it to " + str(TOKEN_FILE)
REVOKED_MESSAGE = "Your Build Token was revoked or expired - " + MINT_HINT
NOT_ENABLED_MESSAGE = "Build Mode is not enabled for you"

USER_AGENT = "nexus-build-notes/1.0 (python-urllib)"


class ApiError(Exception):
    """An HTTP or network failure, already turned into a sentence for people."""

    def __init__(self, status, message, detail=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.detail = detail

    def __str__(self):
        return self.message


class ConfigError(Exception):
    """Missing token or an unusable setting - the message says what to do."""


# --------------------------------------------------------------------------
# Resolution
# --------------------------------------------------------------------------

def resolve_token(explicit=None):
    """The Build Token: --token, else NEXUS_BUILD_TOKEN, else the token file."""
    for candidate in (explicit, os.environ.get(TOKEN_ENV)):
        if candidate and candidate.strip():
            return candidate.strip()
    try:
        text = TOKEN_FILE.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        raise ConfigError(
            "No Build Token found. Set " + TOKEN_ENV + " or " + MINT_HINT
            + " (chmod 600)."
        )
    except OSError as exc:
        raise ConfigError("Cannot read " + str(TOKEN_FILE) + ": " + str(exc))
    if not text:
        raise ConfigError(str(TOKEN_FILE) + " is empty - " + MINT_HINT + ".")
    # The file may hold the token alone or a `NEXUS_BUILD_TOKEN=...` line.
    first = text.splitlines()[0].strip()
    if "=" in first and not first.startswith(TOKEN_PREFIX):
        first = first.split("=", 1)[1].strip().strip('"').strip("'")
    return first


def resolve_api_base(explicit=None):
    """The API base URL: --api, else NEXUS_API_BASE, else the dev API."""
    for candidate in (explicit, os.environ.get(API_ENV)):
        if candidate and candidate.strip():
            return candidate.strip().rstrip("/")
    return DEFAULT_API_BASE


def repo_root():
    """The repository root: two levels up from this file (tools/build_notes/)."""
    return Path(__file__).resolve().parents[2]


# --------------------------------------------------------------------------
# HTTP client
# --------------------------------------------------------------------------

def _friendly(status, detail, method, path):
    if status == 401:
        return REVOKED_MESSAGE
    if status == 403:
        return NOT_ENABLED_MESSAGE
    text = detail if isinstance(detail, str) and detail else json.dumps(detail) if detail else ""
    base = "API error " + str(status) + " on " + method + " " + path
    hint = ""
    if status == 409:
        hint = " - the pin's status does not allow this (it may already be building, completed, dismissed or done)"
    elif status == 413:
        hint = " - the image is over 8 MB"
    elif status == 503:
        hint = " - file storage is not configured on this API"
    return base + (": " + text if text else "") + hint


def _detail_from(body_bytes):
    if not body_bytes:
        return None
    try:
        data = json.loads(body_bytes.decode("utf-8", "replace"))
    except ValueError:
        return body_bytes.decode("utf-8", "replace")[:300]
    if isinstance(data, dict):
        d = data.get("detail", data.get("message"))
        if d is not None:
            return d if isinstance(d, str) else json.dumps(d)
    return None


class Client:
    """Talks to `/dev-notes/...` with the Build Token as a Bearer."""

    def __init__(self, api_base, token, prefix="/dev-notes"):
        self.api_base = api_base.rstrip("/")
        self.token = token
        self.prefix = prefix

    # -- plumbing -----------------------------------------------------------

    def url(self, path, query=None):
        full = self.api_base + self.prefix + path
        if query:
            clean = {k: v for k, v in query.items() if v is not None and v != ""}
            if clean:
                full += "?" + urllib.parse.urlencode(clean)
        return full

    def _headers(self, extra=None):
        h = {
            "Authorization": "Bearer " + self.token,
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        }
        if extra:
            h.update(extra)
        return h

    def _send(self, req, method, path, timeout):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            body = exc.read() if hasattr(exc, "read") else b""
            detail = _detail_from(body)
            raise ApiError(exc.code, _friendly(exc.code, detail, method, path), detail)
        except urllib.error.URLError as exc:
            reason = getattr(exc, "reason", exc)
            raise ApiError(0, "Cannot reach " + self.api_base + " (" + str(reason) + ")")
        except (TimeoutError, OSError) as exc:
            raise ApiError(0, "Cannot reach " + self.api_base + " (" + str(exc) + ")")

    def request(self, method, path, body=None, query=None, timeout=60):
        """JSON in, JSON out. Returns None on an empty (204) response."""
        data = None
        extra = {}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            extra["Content-Type"] = "application/json"
        req = urllib.request.Request(self.url(path, query), data=data, method=method,
                                     headers=self._headers(extra))
        status, raw = self._send(req, method, path, timeout)
        if status == 204 or not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            raise ApiError(status, "API returned something that is not JSON on " + method + " " + path)

    def get(self, path, query=None, timeout=60):
        return self.request("GET", path, query=query, timeout=timeout)

    def delete(self, path, timeout=60):
        return self.request("DELETE", path, timeout=timeout)

    def post(self, path, body=None, timeout=60):
        return self.request("POST", path, body=body if body is not None else {}, timeout=timeout)

    # -- multipart upload -----------------------------------------------------

    def upload(self, path, file_path, fields=None, field_name="file", timeout=120):
        """POST one file as multipart/form-data with extra form fields."""
        file_path = Path(file_path)
        if not file_path.is_file():
            raise ConfigError("File not found: " + str(file_path))
        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        boundary = "----NexusBuildNotes" + uuid.uuid4().hex
        parts = []
        for key, value in (fields or {}).items():
            parts.append(
                ("--" + boundary + "\r\n"
                 + 'Content-Disposition: form-data; name="' + key + '"\r\n\r\n'
                 + str(value) + "\r\n").encode("utf-8")
            )
        parts.append(
            ("--" + boundary + "\r\n"
             + 'Content-Disposition: form-data; name="' + field_name
             + '"; filename="' + file_path.name.replace('"', "") + '"\r\n'
             + "Content-Type: " + content_type + "\r\n\r\n").encode("utf-8")
        )
        parts.append(file_path.read_bytes())
        parts.append(("\r\n--" + boundary + "--\r\n").encode("utf-8"))
        data = b"".join(parts)
        req = urllib.request.Request(
            self.url(path), data=data, method="POST",
            headers=self._headers({
                "Content-Type": "multipart/form-data; boundary=" + boundary,
                "Content-Length": str(len(data)),
            }),
        )
        status, raw = self._send(req, "POST", path, timeout)
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            raise ApiError(status, "API returned something that is not JSON on POST " + path)

    # -- download -------------------------------------------------------------

    def download(self, url, dest, timeout=120):
        """Stream a file to `dest` (a Path). Signed URLs are fetched as they
        are; a relative URL is resolved against the API base and carries the
        token. Writes to a temp file first so a failed download leaves nothing
        half-written."""
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        headers = {"User-Agent": USER_AGENT}
        if url.startswith("/"):
            url = self.api_base + url
            headers["Authorization"] = "Bearer " + self.token
        req = urllib.request.Request(url, headers=headers)
        tmp = dest.with_name(dest.name + ".part")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp, open(tmp, "wb") as fh:
                shutil.copyfileobj(resp, fh, 64 * 1024)
        except urllib.error.HTTPError as exc:
            _unlink(tmp)
            raise ApiError(exc.code, "Download failed (" + str(exc.code) + "): " + url)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            _unlink(tmp)
            raise ApiError(0, "Download failed (" + str(getattr(exc, "reason", exc)) + "): " + url)
        os.replace(tmp, dest)
        return dest


def _unlink(path):
    try:
        Path(path).unlink()
    except OSError:
        pass


def make_client(api=None, token=None):
    """Resolve settings and build a Client. Raises ConfigError when no token."""
    return Client(resolve_api_base(api), resolve_token(token))


# --------------------------------------------------------------------------
# Formatting helpers
# --------------------------------------------------------------------------

def parse_iso(value):
    """Tolerant ISO-8601 parser; naive values are read as UTC. None when blank."""
    if not value or not isinstance(value, str):
        return None
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    # Trim sub-microsecond digits (Postgres can emit 7) so fromisoformat accepts it.
    if "." in text:
        head, _, tail = text.partition(".")
        digits = ""
        rest = ""
        for i, ch in enumerate(tail):
            if ch.isdigit():
                digits += ch
            else:
                rest = tail[i:]
                break
        text = head + "." + digits[:6].ljust(6, "0") + rest
    try:
        parsed = _dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_dt.timezone.utc)
    return parsed


def us_datetime(value, local=True):
    """'10/24/2026 9:05 AM' from an ISO string; '' when it cannot be read."""
    parsed = parse_iso(value)
    if parsed is None:
        return str(value or "")
    if local:
        parsed = parsed.astimezone()
    hour = parsed.hour % 12 or 12
    return "%02d/%02d/%04d %d:%02d %s" % (
        parsed.month, parsed.day, parsed.year, hour, parsed.minute,
        "AM" if parsed.hour < 12 else "PM",
    )


def us_date(value, local=True):
    parsed = parse_iso(value)
    if parsed is None:
        return str(value or "")
    if local:
        parsed = parsed.astimezone()
    return "%02d/%02d/%04d" % (parsed.month, parsed.day, parsed.year)


def us_time(value, local=True):
    parsed = parse_iso(value)
    if parsed is None:
        return str(value or "")
    if local:
        parsed = parsed.astimezone()
    hour = parsed.hour % 12 or 12
    return "%d:%02d:%02d %s" % (hour, parsed.minute, parsed.second, "AM" if parsed.hour < 12 else "PM")


def pin_link(note_id):
    return NEXUS_URL.rstrip("/") + "/dev-notes?pin=" + str(note_id)


def eprint(*args):
    print(*args, file=sys.stderr, flush=True)
