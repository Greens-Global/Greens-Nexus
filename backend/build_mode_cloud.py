"""Build Mode: Send To Claude Code starts a session in Claude's cloud
(Neil, 11/12/2026 - "Yes": Nexus may start a Claude Code cloud session for a
developer).

A developer makes ONE scheduled task in Claude Code with an API trigger and
saves its Fire URL and token in Build Mode > Settings, once. From then on
Send To Claude Code posts the pin ids to that trigger and Claude Code starts
in the cloud on the developer's OWN Claude subscription - no terminal, no
watcher, nothing installed. The session reaches Nexus with the developer's
Build Token (a network secret on their cloud environment) and works the pins
through the same /dev-notes/cli routes the terminal uses. Setup:
docs/Build-Mode-Cloud-Setup.md.

What this is NOT (CLAUDE.md, "AI is OFF"): it never reads ANTHROPIC_API_KEY,
spends no Nexus credits, and is not behind ai_switch because no Nexus AI
feature runs - the only call is "start MY session", made with a token the
developer gave for that one scheduled task. Keep it that way: no other
Anthropic address, no key, nothing a developer did not connect themselves.

The token is a secret: encrypted at rest (secret_box), never returned by any
route, never logged, never put in an audit row. The Fire URL is pinned to
Anthropic's own address, so a saved token can never be posted anywhere else.
There is no retry: the endpoint has no idempotency key, and a second call is
a second session working the same pins.
"""
import json
import re
from datetime import datetime, timezone

import httpx
from sqlalchemy.orm import Session

import secret_box
from models import NexusSetting

FIRE_RE = re.compile(r"^https://api\.anthropic\.com/v1/claude_code/routines/(trig_[A-Za-z0-9_-]{6,80})/fire/?$")
TOKEN_PREFIX = "sk-ant-oat01-"
SESSION_PREFIX = "https://claude.ai/code/"
TEXT_MAX = 60_000          # the endpoint takes 65,536 characters
TIMEOUT_SEC = 20


class CloudError(Exception):
    """Why a session did not start, in words for the person who pressed Send."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _key(email: str) -> str:
    return f"dev_notes_cloud:{(email or '').lower()}"


def _row(db: Session, email: str):
    return db.query(NexusSetting).filter(NexusSetting.key == _key(email)).first()


def _load(db: Session, email: str) -> dict:
    row = _row(db, email)
    if not row or not row.value:
        return {}
    try:
        saved = json.loads(row.value)
    except ValueError:
        return {}
    return saved if isinstance(saved, dict) and saved.get("routineId") and saved.get("token") else {}


def _store(db: Session, email: str, values: dict) -> None:
    row = _row(db, email)
    if not row:
        row = NexusSetting(key=_key(email))
        db.add(row)
    row.value = json.dumps(values)
    row.updated_by = (email or "").lower()
    row.updated_at = _now()


def connected(db: Session, email: str) -> bool:
    return bool(_load(db, email))


def _public(cfg: dict) -> dict:
    """What the browser may know: never the token, and only the tail of the
    scheduled task's id."""
    if not cfg:
        return {"connected": False, "task": "", "savedAt": "", "lastStartedAt": "", "lastError": ""}
    rid = str(cfg["routineId"])
    return {"connected": True, "task": "..." + rid[-6:], "savedAt": cfg.get("savedAt") or "",
            "lastStartedAt": cfg.get("lastStartedAt") or "", "lastError": cfg.get("lastError") or ""}


def status(db: Session, email: str) -> dict:
    return _public(_load(db, email))


def save(db: Session, email: str, fire_url: str, token: str) -> dict:
    """Keep a developer's trigger. Raises CloudError on anything that is not
    Claude Code's own Fire URL and token. Nothing is called here: a test call
    would start a real session."""
    m = FIRE_RE.match((fire_url or "").strip())
    if not m:
        raise CloudError("That is not a Claude Code Fire URL - copy it from the scheduled task's API trigger "
                         "(it starts with https://api.anthropic.com/v1/claude_code/routines/trig_)")
    token = (token or "").strip()
    if not token.startswith(TOKEN_PREFIX) or len(token) < len(TOKEN_PREFIX) + 16 or len(token) > 400 or " " in token:
        raise CloudError("That is not a Claude Code trigger token - generate one in the scheduled task's "
                         "API trigger and copy it whole (it starts with sk-ant-oat01-)")
    cfg = {"routineId": m.group(1), "token": secret_box.encrypt(token), "savedAt": _now(),
           "lastStartedAt": "", "lastError": ""}
    _store(db, email, cfg)
    # Not read back: sessions run with autoflush off, so the row just written
    # is not visible to a query until the caller commits.
    return _public(cfg)


def clear(db: Session, email: str) -> None:
    row = _row(db, email)
    if row:
        db.delete(row)


def fire_text(note_ids: list, api_base: str = "", sender: str = "") -> str:
    """The message the session gets. The scheduled task's own instructions say
    what to do with it; this is only data (ids and where Nexus is)."""
    lines = ["Build Mode pins to work: " + " ".join(str(i) for i in note_ids)]
    if api_base:
        lines.append("Nexus API: " + api_base)
    if sender:
        lines.append("Sent by: " + sender)
    return "\n".join(lines)[:TEXT_MAX]


def _post(url: str, headers: dict, body: dict):
    """The one outbound call (its own function so tests replace it)."""
    return httpx.post(url, headers=headers, json=body, timeout=TIMEOUT_SEC)


def _reason(resp) -> str:
    code = resp.status_code
    if code == 401:
        return ("Claude Code did not accept your trigger token - generate a new one in the scheduled task "
                "and connect again")
    if code == 403:
        return "Your Claude account cannot start sessions this way - check that Claude Code on the web is on for you"
    if code == 404:
        return "That scheduled task no longer exists in Claude Code - connect again with a new one"
    if code == 429:
        wait = (resp.headers.get("Retry-After") or "").strip()
        mins = f" (try again in about {max(1, round(int(wait) / 60))} min)" if wait.isdigit() else ""
        return "Claude Code's hourly limit for starting sessions was reached" + mins
    if code == 400:
        return "Claude Code refused the request - the scheduled task may be paused"
    return "Claude Code is having trouble right now - try again in a minute"


def fire(db: Session, email: str, text: str) -> dict:
    """Start the developer's Claude Code session. Returns {sessionId,
    sessionUrl}; raises CloudError with the reason otherwise. The outcome is
    kept on the setting row (lastStartedAt / lastError) - the caller commits."""
    cfg = _load(db, email)
    if not cfg:
        raise CloudError("Claude Code in the cloud is not connected - connect it in Build Mode > Settings")
    try:
        token = secret_box.decrypt(cfg["token"])
    except (ValueError, RuntimeError):
        token = ""
    if not token:
        raise CloudError("The saved trigger can no longer be read - connect Claude Code in the cloud again")
    url = f"https://api.anthropic.com/v1/claude_code/routines/{cfg['routineId']}/fire"
    headers = {"Authorization": f"Bearer {token}", "anthropic-version": "2023-06-01",
               "anthropic-beta": "experimental-cc-routine-2026-04-01", "Content-Type": "application/json"}
    err, out = "", {}
    try:
        resp = _post(url, headers, {"text": (text or "")[:TEXT_MAX]})
    except httpx.HTTPError:
        err = "Claude Code could not be reached - try again in a minute"
    else:
        if resp.status_code != 200:
            err = _reason(resp)
        else:
            try:
                data = resp.json()
            except ValueError:
                data = {}
            session_url = str((data or {}).get("claude_code_session_url") or "")
            # Shown as a link on the pin: only Claude's own session address.
            if not session_url.startswith(SESSION_PREFIX) or len(session_url) > 300:
                session_url = ""
            out = {"sessionId": str((data or {}).get("claude_code_session_id") or "")[:120], "sessionUrl": session_url}
    cfg = {**cfg, "lastError": err}
    if not err:
        cfg["lastStartedAt"] = _now()
    _store(db, email, cfg)
    if err:
        raise CloudError(err)
    return out
