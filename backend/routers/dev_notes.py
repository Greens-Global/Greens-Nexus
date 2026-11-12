"""Build Mode (Neil, Oct 24 2026) - pins, markup, Build Sessions, Build Tokens
and the CLI loop that hands them to Claude Code. Contract: docs/Build-Mode.md.

A Global Admin (or anyone whose Access Group grants the `build-mode` module)
turns Build Mode on from the profile menu, pins comments and markup onto any
element of the live app and sends the collected pins to Claude Code running in
their own terminal. Claude Code claims them through this router with a Build
Token, writes progress and the PR back onto the pins, and when the PR merges
to dev the GitHub webhook turns each pin into "Fixed - Verify" for its author
to accept or reopen where the bug was.

Access: `require_build_mode` (signed-in user) and `require_build_mode_or_token`
(signed-in user OR `Authorization: Bearer nxbn_...`). A token resolves to its
owner's email and the SAME access check runs on every call, so a person who
leaves the group loses the token's power at once. Administrators do NOT get
Build Mode by role alone - Global Admin group membership or the grant, the
same idea as act_as.py's `act-as` grant.

Everything a person reads is camelCase; requests may send camelCase or
snake_case for note fields (stored snake). Media URLs are accepted ONLY inside
the PRIVATE `qa-evidence` bucket under `dev-notes/`; the CLI never gets a
public URL, only signed ones (routers/files._sign) valid for an hour.

Bells are created server-side only, one per pin per event, updated in place
by `ref_id` (CLAUDE.md). `/cli/wait` is the one long-poll: `async def`, every
database query in `asyncio.to_thread`, `asyncio.sleep` between polls - a sync
sleep or query there would freeze the whole worker.

v2 (docs/Build-Mode.md section 7): a pin on another developer's area
(code_owners.py) is held for them until they release it; Ready To Check - a
local preview of the PR branch the author Accepts (no second check after
merge) or Reopens (back to Claude Code on the same branch); an accepted bug
whose e2e repro went failing -> passing becomes a Testing module regression
case (`promote_regression`).
"""
import asyncio
import base64
import hashlib
import html as _html
import json
import os
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, Header, HTTPException, Query, Request, Response, UploadFile
from sqlalchemy import and_, func, or_, text as sa_text
from sqlalchemy.orm import Session

import auth
import code_owners
import database
from auth import company_of, get_current_user
from database import get_db
from models import AuditLog, DevNote, DevNoteSession, DevNoteToken, NexusNotification, NexusSetting, QaTestCase
from routers import files as _files
import build_mode_chat as _chat
import build_mode_cloud as _cloud
import build_mode_merge as _merge
import job_switch

router = APIRouter(prefix="/dev-notes", tags=["Build Mode"])

MODULE_ID = "build-mode"
BUCKET = "qa-evidence"
MEDIA_PREFIX = "dev-notes/"
TOKEN_PREFIX = "nxbn_"
TOKEN_DAYS = 30
TOKEN_TOUCH_SEC = 60            # how often last_used_at is rewritten (the watcher polls every ~25 s)
WAIT_POLL_SEC = 2
WAIT_MAX_SEC = 50
ATTACH_MAX_BYTES = 8 * 1024 * 1024
PURGE_DAYS = 30                 # media of a done / dismissed pin is purged this long after
ENTRY_STR_MAX = 2048            # any string inside a network_log entry (request / response bodies)
DICT_FIELD_MAX = 64 * 1024      # serialized size of one JSON dict field (state, target, markup, edit, viewport, verification)
TEXT_FIELD_MAX = 20 * 1024      # comment / transcript
STATS_DAYS = 90
PICKED_UP = "Picked up by Claude Code"
CLOUD_STARTING = "Claude Code is starting in the cloud"
CLOUD_RESTART_SEC = 120   # Start Claude Code is refused this long after a start: a second call is a second session
# Screens Build Mode never captures: the client refuses on these views and the
# server refuses a pin that names them (the records behind them are the most
# sensitive in Nexus - CLAUDE.md on PFS and the Credential Vault).
BLOCKED_ROUTES = ("pfs", "credvault")

KINDS = ("bug", "change", "question", "edit")
PRIORITIES = ("blocking", "normal", "nice")
STATUSES = ("open", "dispatched", "building", "needs_input", "pr_open", "fixed", "done", "dismissed")
SESSION_STATUSES = ("collecting", "sent", "building", "pr_open", "fixed", "done")
ATTACH_KINDS = ("after", "before", "paste", "clip")   # before-/after- files are the verify shots, clip- a video of the fix working, paste- the rest
CLIP_MAX_BYTES = 25 * 1024 * 1024
_CLIP_TYPES = {"video/webm": "webm", "video/mp4": "mp4"}
# Send to Claude Code (on since Oct 27 2026). Off, a stored Send Instantly is
# read as off, so a saved pin never dispatches on its own. The browser's switch
# is CLAUDE_SEND_ON in frontend/src/devnotes/meta.js - flip both together.
CLAUDE_SEND_ON = True

DEFAULT_SETTINGS = {"sendInstantly": False, "dispatchTarget": "local", "pinsOnLoad": True,
                    # Collect Fixes Into One PR (Pranshu, Oct 27 2026): Claude
                    # Code keeps every batch on one branch and opens the PR
                    # only when told to in its terminal.
                    "onePr": False,
                    # The Teams chat the person last posted their pins to
                    # (their pick, any chat they are in); '' = none picked yet.
                    "teamsChatId": "", "teamsChatName": ""}

# Note fields the browser may write on create (snake). Everything else on the
# row is the server's (status, numbering, PR fields, verification).
CREATE_FIELDS = (
    "kind", "priority", "comment", "route", "sub", "url", "build_id", "viewport",
    "target", "markup", "edit", "screenshot_url", "page_shot_url", "video_url",
    "contact_sheet_url", "transcript", "attachments", "console_log", "network_log",
    "actions", "state",
)
PATCH_FIELDS = ("comment", "kind", "priority", "markup", "edit")
MEDIA_FIELDS = ("screenshot_url", "page_shot_url", "video_url", "contact_sheet_url")
_LIST_FIELDS = ("thread", "attachments", "console_log", "network_log", "actions")
_DICT_FIELDS = ("viewport", "target", "markup", "edit", "state", "verification", "preview")
_LIST_CAPS = {"console_log": 50, "network_log": 30, "actions": 30}
_TEXT_CAPPED = ("comment", "transcript")
REPRO_RESULTS = ("failing", "passing", "skipped")
REPRO_KINDS = ("python", "e2e")    # e2e = a Playwright spec in the repo's e2e format (v2)
PREVIEW_HOSTS = ("localhost", "127.0.0.1")
E2E_SPEC_MAX = 20000
# Testing module (routers/qa.py _MODULES) for a pin's route when an accepted
# bug becomes a regression test; anything else is "Other".
QA_MODULE_FOR_ROUTE = {
    "inventory": "Item Management", "itemmanagement": "Item Management",
    "property-asset": "Asset Management", "propertyasset": "Asset Management",
    "hr": "People", "myhr": "My HR",
    "timeclock": "Time Clock",
    "dashboard": "Dashboards", "bi": "Dashboards",
    "documents": "Documents (E-Sign)", "esign": "Documents (E-Sign)",
}
QA_PRIORITY = {"blocking": "High", "normal": "Medium", "nice": "Low"}
REGRESSION_ADDED = "Added To The Regression Suite"
REGRESSION_READY = "Regression test ready - it joins the suite when the PR merges"
BRANCH_CHANGED = "The branch changed after you checked it - check it again on the preview"
REGRESSION_OFF = "Regression test not added - the Testing module is off on this deployment"
_IMAGE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp"}


# ── small helpers ─────────────────────────────────────────────────────────────
def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _camel(s: str) -> str:
    head, *rest = s.split("_")
    return head + "".join(p[:1].upper() + p[1:] for p in rest)


def _snake(s: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", s).lower()


def _get(body: dict, key: str, default=None):
    """Read `key` from a request body in camelCase or snake_case."""
    if not isinstance(body, dict):
        return default
    if key in body:
        return body[key]
    alt = _snake(key)
    if alt in body:
        return body[alt]
    alt = _camel(key)
    return body.get(alt, default)


def _ids(body: dict, key: str = "noteIds") -> list:
    raw = _get(body, key) or []
    if not isinstance(raw, list):
        raise HTTPException(400, f"{key} must be a list")
    return [str(x) for x in raw if x]


def _thread_out(thread) -> list:
    """Thread entries camelCase on the way out (stored with image_url)."""
    out = []
    for e in thread or []:
        if not isinstance(e, dict):
            continue
        e = dict(e)
        e["imageUrl"] = e.pop("image_url", e.get("imageUrl", "")) or ""
        out.append(e)
    return out


def _viewer(user: Optional[dict], db: Session) -> dict:
    """Who is reading, for the per-caller flags - the Global Admin check runs
    ONCE per request here, never once per pin."""
    if not user:
        return {"email": "", "ga": False, "super": False}
    return {"email": (user.get("email") or "").lower(), "ga": bool(_is_ga(user, db)), "super": _is_super(user)}


def _serialize(n: DevNote, viewer: Optional[dict] = None) -> dict:
    """The note camelCase, plus `held` / `readyToCheck` and the caller's own
    `canRelease` (held, and they are the owner or a Global Admin) and
    `canVerdict` (Ready To Check or Fixed - Verify, and they are the author or
    a Global Admin). No viewer (a background poll) = both False."""
    out = {}
    for col in DevNote.__table__.columns:
        v = getattr(n, col.name)
        if col.name == "thread":
            v = _thread_out(v)
        elif col.name in _LIST_FIELDS:
            v = list(v or [])
        elif col.name in _DICT_FIELDS:
            v = dict(v or {})
        elif v is None:
            v = 0 if col.name in ("number", "pr_number", "github_issue", "reopen_count") else ""
        out[_camel(col.name)] = v
    out["held"] = _held(n)
    out["readyToCheck"] = _ready_to_check(n)
    out["checkable"] = _checkable(n)          # Ready To Check, or the pin carries its proof
    me, ga = (viewer or {}).get("email") or "", bool((viewer or {}).get("ga"))
    out["canRelease"] = bool(me) and out["held"] and (ga or me == (n.owner_email or "").lower())
    out["canVerdict"] = (bool(me) and (out["checkable"] or n.status == "fixed")
                         and (ga or me == (n.created_by or "").lower()))
    # Merge To Dev (11/12/2026): a Super Administrator, a pin whose PR is open,
    # and a server that carries the merge credential.
    out["canMerge"] = (bool((viewer or {}).get("super")) and n.status == "pr_open" and bool(n.pr_number)
                       and _merge.available())
    return out


def _held(n: DevNote) -> bool:
    """The pin is in another developer's area (code_owners.py) and waits for
    them: owner set, owner is not the author, nobody released it yet."""
    owner = (n.owner_email or "").lower()
    return bool(owner) and owner != (n.created_by or "").lower() and not n.owner_released_at


def _ready_to_check(n: DevNote) -> bool:
    """PR open, a local preview is running for it, and the author has not
    accepted it yet (a reopen sends the pin back to building)."""
    return (n.status == "pr_open" and bool((n.preview or {}).get("url"))
            and (n.preview_verdict or "") != "accepted")


def _has_proof(n: DevNote) -> bool:
    """Proof on the pin (11/12/2026): Claude Code attached what the fix looks
    like - an after picture (with its before) or a clip of it working - so
    the author can judge it on the pin itself, from any device, with no
    preview running on anyone's computer."""
    v = (n.verification or {}).get("visual") or {}
    return bool(v.get("afterUrl") or v.get("clipUrl"))


def _checkable(n: DevNote) -> bool:
    """The author can give a verdict before the merge: a preview is running
    for the pin (Ready To Check), or the pin carries its proof."""
    return (n.status == "pr_open" and (n.preview_verdict or "") != "accepted"
            and (bool((n.preview or {}).get("url")) or _has_proof(n)))


def _waits_for(n: DevNote) -> str:
    return f"Pin #{n.number} waits for {n.owner_name or n.owner_email}"


def _name_of(db: Session, email: str) -> str:
    """A person's name for thread entries and bells - task_notify's helper
    (employee record, else the role's display name, else the email's local
    part capitalized). Imported lazily: task_notify is a big module."""
    from task_notify import _name_of as name_of
    return name_of(db, (email or "").lower())


def _serialize_session(s: DevNoteSession) -> dict:
    out = {}
    for col in DevNoteSession.__table__.columns:
        v = getattr(s, col.name)
        if v is None:
            v = 0 if col.name in ("pr_number", "note_count") else ""
        out[_camel(col.name)] = v
    return out


def _serialize_token(t: DevNoteToken) -> dict:
    return {"id": t.id, "email": t.email, "label": t.label or "", "createdAt": t.created_at or "",
            "expiresAt": t.expires_at or "", "lastUsedAt": t.last_used_at or "",
            "revokedAt": t.revoked_at or ""}


def _entry(by: str, kind: str, text: str, image_url: str = "") -> dict:
    return {"id": str(uuid.uuid4()), "by": by, "at": _now(), "kind": kind,
            "text": (text or "")[:4000], "image_url": image_url or ""}


def _append(n: DevNote, entry: dict) -> None:
    # JSON columns do not notice in-place mutation: always assign a new list.
    n.thread = [*(n.thread or []), entry]
    n.updated_at = _now()


def _purge_stamp() -> str:
    return (datetime.now(timezone.utc) + timedelta(days=PURGE_DAYS)).isoformat()


def _close(n: DevNote, status: str) -> None:
    """done / dismissed: the pin is closed and its media gets a purge date."""
    n.status = status
    n.purge_at = _purge_stamp()


def _audit(db: Session, user: dict, action: str, resource_id: str, details: Optional[dict] = None,
           kind: str = "other") -> None:
    """One audit_logs row per Build Mode event (the way items.py writes its
    own), filed under Settings & Admin by audit_modules ("dev-notes")."""
    db.add(AuditLog(
        timestamp=_now(), user_email=(user.get("email") or "").lower(), user_role=user.get("role") or "",
        action=f"dev_note_{action}", resource_type="dev-notes", resource_id=resource_id or "",
        details=json.dumps(details or {}), ip_address="", module="settings", kind=kind,
    ))


# ── media URLs ────────────────────────────────────────────────────────────────
def _storage_base() -> str:
    return os.getenv("SUPABASE_URL", "").strip().rstrip("/")


def _canonical(path: str) -> str:
    return f"{_storage_base()}/storage/v1/object/public/{BUCKET}/{path}"


def _valid_media_url(u: str) -> bool:
    """Only the canonical public-style URL of an object in qa-evidence under
    dev-notes/ (what the browser's upload helper produces). Anything else -
    another bucket, another prefix, a data: URL, an outside link - is refused,
    so a pin can never point evidence at a place the viewer will not serve."""
    if not u or not isinstance(u, str) or len(u) > 1000:
        return False
    if "?" in u or "#" in u:
        return False   # parse_public_url would strip these; the stored value must be the plain object URL
    if _files._SUPABASE_URL:
        p = _files.parse_public_url(u)
        return bool(p) and p[0] == BUCKET and p[1].startswith(MEDIA_PREFIX) and len(p[1]) > len(MEDIA_PREFIX)
    # Storage not configured (a local backend without Supabase): parse_public_url
    # answers None for everything, so check the shape alone - the stored value
    # must still be one api.js can rewrite.
    if ".." in u or "\\" in u:
        return False
    marker = f"/storage/v1/object/public/{BUCKET}/{MEDIA_PREFIX}"
    idx = u.find(marker)
    return u.startswith("https://") and idx > 0 and len(u) > idx + len(marker)


def _check_media(field: str, u) -> str:
    if not u:
        return ""
    if not _valid_media_url(u):
        raise HTTPException(400, f"{_camel(field)} must be a qa-evidence dev-notes storage URL")
    return u


def _signed(u: str) -> str:
    """A one-hour signed URL for an object in the private bucket (files._sign
    through fetchable_url); '' when there is no URL or storage refuses."""
    if not u:
        return ""
    try:
        signed = _files.fetchable_url(u)
    except Exception:  # noqa: BLE001 - a missing object must not fail the claim
        return ""
    # Unchanged means storage could not sign it (no service key): a public
    # URL of a private bucket is useless to the CLI, so hand back nothing.
    return "" if signed == u else signed


def _shot_kind(url: str) -> str:
    """before / after / '' from the object's filename (`<kind>-<ts>.<ext>`)."""
    name = url.rsplit("/", 1)[-1]
    for kind in ("before", "after"):
        if name.startswith(kind + "-"):
            return kind
    return ""


def _media(n: DevNote) -> dict:
    attachments = [a for a in (n.attachments or []) if isinstance(a, str) and a]
    return {
        "screenshot": _signed(n.screenshot_url or ""),
        "pageShot": _signed(n.page_shot_url or ""),
        "video": _signed(n.video_url or ""),
        "contactSheet": _signed(n.contact_sheet_url or ""),
        "attachments": [_signed(a) for a in attachments if not _shot_kind(a)],
        "beforeShots": [_signed(a) for a in attachments if _shot_kind(a) == "before"],
        "afterShots": [_signed(a) for a in attachments if _shot_kind(a) == "after"],
    }


def _upload_bytes(note_id: str, kind: str, data: bytes, content_type: str) -> str:
    """Upload with the service key (the way files.py signs) and return the
    canonical URL the row stores."""
    base = _storage_base()
    key = os.getenv("SUPABASE_SERVICE_KEY", "")
    if not base or not key:
        raise HTTPException(503, "File storage is not configured on this deployment (SUPABASE_URL / SUPABASE_SERVICE_KEY)")
    ext = _IMAGE_TYPES.get(content_type) or _CLIP_TYPES[content_type]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")
    path = f"{MEDIA_PREFIX}{note_id}/{kind}-{stamp}.{ext}"
    r = httpx.post(
        f"{base}/storage/v1/object/{BUCKET}/{path}", content=data,
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": content_type,
                 "cache-control": "31536000", "x-upsert": "false"},
        timeout=60,
    )
    if r.status_code >= 300:
        raise HTTPException(502, f"Storage refused the upload ({r.status_code})")
    return _canonical(path)


def _delete_object(url: str) -> bool:
    """Delete one object of the private bucket with the service key (the same
    client /cli/attach uploads with). True when it is gone (404 counts), False
    when storage is not configured or refused - the caller leaves the URL in
    place and tries again next time."""
    parsed = _files.parse_public_url(url)
    key = os.getenv("SUPABASE_SERVICE_KEY", "")
    if not parsed or not key:
        return False
    bucket, path = parsed
    if bucket != BUCKET or not path.startswith(MEDIA_PREFIX):
        return False
    r = httpx.request("DELETE", f"{_storage_base()}/storage/v1/object/{bucket}/{path}",
                      headers={"apikey": key, "Authorization": f"Bearer {key}"}, timeout=30)
    return r.status_code < 300 or r.status_code == 404


def _sniff_image(data: bytes, declared: str) -> str:
    """The image type from the bytes (png / jpeg / webp), else the declared one
    when it is an allowed type, else ''."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    declared = (declared or "").split(";")[0].strip().lower()
    return declared if declared in _IMAGE_TYPES else ""


def _sniff_clip(data: bytes) -> str:
    """video/webm or video/mp4 by the file's own first bytes, else ''."""
    if data[:4] == b"\x1a\x45\xdf\xa3":
        return "video/webm"
    if data[4:8] == b"ftyp":
        return "video/mp4"
    return ""


# ── access ────────────────────────────────────────────────────────────────────
def _allowed(user: dict, db: Session) -> bool:
    email = (user.get("email") or "").lower()
    if not email:
        return False
    # Build Mode is its own access (Neil, 11/12/2026: "granted as a separate
    # access through roles but no new role"): only an Access Group that
    # grants the `build-mode` module opens it. No tier does by itself, Super
    # Administrator included - build_mode_access_seed.py put the IT
    # development team and Neil in the group once.
    # Module attributes on purpose (not `from auth import ...`): the tests and
    # any future override patch auth.* and this must see the patch.
    return auth._module_level(email, MODULE_ID, db) >= auth._MODULE_LEVEL_RANK["viewer"]


def require_build_mode(user: dict = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    if not _allowed(user, db):
        raise HTTPException(403, "Build Mode is not enabled for you")
    return user


def _is_build_token(authorization: Optional[str]) -> bool:
    return bool(authorization) and authorization.startswith("Bearer " + TOKEN_PREFIX)


def _signed_in_user(request: Request, authorization: str = Header(default=None),
                    x_act_as_session: str = Header(default=None, alias="X-Act-As-Session")) -> Optional[dict]:
    """The normal signed-in caller, or None when the request carries a Build
    Token (which require_build_mode_or_token resolves itself)."""
    if _is_build_token(authorization):
        return None
    return get_current_user(request, authorization, x_act_as_session)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _resolve_token(authorization: str, db: Session) -> dict:
    raw = authorization.removeprefix("Bearer ").strip()
    row = db.query(DevNoteToken).filter(DevNoteToken.token_hash == _hash(raw)).first()
    now = _now()
    if not row or row.revoked_at or not row.expires_at or row.expires_at <= now:
        raise HTTPException(401, "Build Token is invalid, expired or revoked")
    email = (row.email or "").lower()
    role, level = auth._role_for(email, db)
    user = {"email": email, "role": role, "level": level, "token_label": row.label or "", "token_id": row.id}
    if not _allowed(user, db):
        raise HTTPException(403, "Build Mode is not enabled for you")
    last = row.last_used_at or ""
    if not last or (datetime.fromisoformat(now) - datetime.fromisoformat(last)).total_seconds() > TOKEN_TOUCH_SEC:
        row.last_used_at = now
        # A token in use renews itself (11/12/2026): it expires TOKEN_DAYS
        # after its LAST use, so a connected Claude Code never needs a new one
        # and a forgotten token still dies.
        row.expires_at = (datetime.fromisoformat(now) + timedelta(days=TOKEN_DAYS)).isoformat()
        db.commit()   # also hands the pooled connection back before a long poll
    return user


def require_build_mode_or_token(user: Optional[dict] = Depends(_signed_in_user),
                                authorization: str = Header(default=None),
                                db: Session = Depends(get_db)) -> dict:
    if user is None:
        return _resolve_token(authorization or "", db)
    if not _allowed(user, db):
        raise HTTPException(403, "Build Mode is not enabled for you")
    return {**user, "token_label": ""}


def _is_ga(user: dict, db: Session) -> bool:
    return auth.is_global_admin(user, db)


def _is_super(user: Optional[dict]) -> bool:
    """A Super Administrator by tier (level 5) - the merge rule. Stricter than
    `_is_ga`, which also passes a member of a group flagged Global Admin. A
    Super Administrator acting as someone else is that person here."""
    try:
        return int((user or {}).get("level") or 0) >= 5
    except (TypeError, ValueError):
        return False


def _own_or_admin(n_owner: str, user: dict, db: Session, what: str) -> None:
    if (n_owner or "").lower() != (user.get("email") or "").lower() and not _is_ga(user, db):
        raise HTTPException(403, f"Only the author or a Super Administrator can {what}")


# ── settings ──────────────────────────────────────────────────────────────────
def _settings_key(email: str) -> str:
    return f"dev_notes:{(email or '').lower()}"


def _settings(db: Session, email: str) -> dict:
    row = db.query(NexusSetting).filter(NexusSetting.key == _settings_key(email)).first()
    out = dict(DEFAULT_SETTINGS)
    if row and row.value:
        try:
            saved = json.loads(row.value)
            if isinstance(saved, dict):
                out.update({k: saved[k] for k in DEFAULT_SETTINGS if k in saved})
        except ValueError:
            pass
    if not CLAUDE_SEND_ON:
        out["sendInstantly"] = False
    return out


def _save_settings(db: Session, email: str, values: dict) -> dict:
    row = db.query(NexusSetting).filter(NexusSetting.key == _settings_key(email)).first()
    if not row:
        row = NexusSetting(key=_settings_key(email))
        db.add(row)
    row.value = json.dumps(values)
    row.updated_by = email.lower()
    row.updated_at = _now()
    return values


# ── bells ─────────────────────────────────────────────────────────────────────
def _bell_action(ref_kind: str, ref_id: str) -> str:
    """NotificationBell.jsx (Visesh's) navigates an unknown type only through
    action.view; devnotes/store.js answers `dev-notes` with `pin:<id>` /
    `session:<id>` by opening the pin's thread or the Sessions tab."""
    return json.dumps({"view": "dev-notes", "sub": f"{ref_kind}:{ref_id}"})


def _notify(db: Session, *, type: str, recipient: str, title: str, body: str, ref_id: str,
            ref_kind: str = "pin") -> None:
    """One bell per pin per event: a row with the same type + ref_id +
    recipient is updated in place (and surfaces again as unread) instead of a
    second row being added. Row-locked so two concurrent writers cannot both
    insert (CLAUDE.md: the dedupe races without it; a no-op on SQLite)."""
    recipient = (recipient or "").lower()
    if not recipient:
        return
    row = (db.query(NexusNotification)
           .filter(NexusNotification.type == type, NexusNotification.ref_id == ref_id,
                   NexusNotification.recipient == recipient)
           .with_for_update().first())
    now = _now()
    if row:
        row.title = title
        row.body = body[:500]
        row.read_by = ""
        row.closed_by = ""
        row.actioned = False
        row.action = _bell_action(ref_kind, ref_id)
        row.created_at = now
        return
    db.add(NexusNotification(
        id=str(uuid.uuid4()), type=type, recipient=recipient, title=title, body=body[:500],
        ref_id=ref_id, item_name="", requested_by="", action=_bell_action(ref_kind, ref_id),
        actioned=False, read_by="",
        company=company_of(recipient, db), created_at=now,
    ))


# ── ownership (code_owners.py, the machine-readable File Ownership table) ─────
def _owners_out() -> list:
    return [{"name": o["name"], "email": o["email"], "paths": list(o["paths"])} for o in code_owners.OWNERS]


def _source_file(n: DevNote) -> str:
    src = (n.target or {}).get("source") if isinstance(n.target, dict) else None
    return str(src.get("file") or "") if isinstance(src, dict) else ""


def _assign_owner(db: Session, n: DevNote) -> None:
    """On create: the owner of the pin's source file (client values are never
    read). A pin on someone else's area is held for them, with one bell."""
    owner = code_owners.owner_of(_source_file(n))
    if not owner:
        return
    n.owner_email = owner["email"].lower()
    n.owner_name = owner["name"]
    if not _held(n):
        return
    body = (f"{_name_of(db, n.created_by)} pinned {n.route or 'the app'} "
            f"({code_owners.normalize(_source_file(n))}). It waits for you - release it to Claude Code "
            "or handle it yourself.")
    if not _owner_has_access(db, n.owner_email):
        body += " Ask a Super Administrator for the Build Mode grant if the link does not open."
    _notify(db, type="dev_note_owner", recipient=n.owner_email, title=f"Pin #{n.number} On Your Area",
            body=body, ref_id=n.id)


HELD_SUFFIX = " (Held)"


def _held_title(old: Optional[DevNoteSession]) -> str:
    """A NEW session made for moved held pins is named after the one they
    left - "<title> (Held)", at most 120 characters - not the server's UTC
    auto title. '' (the auto title) when there is no old session."""
    base = ((old.title if old else "") or "").strip()
    if not base:
        return ""
    if base.endswith(HELD_SUFFIX):
        return base[:120]
    return base[:120 - len(HELD_SUFFIX)].rstrip() + HELD_SUFFIX


def _move_to_collecting(db: Session, n: DevNote) -> None:
    """Move a pin out of a session that is no longer collecting into its
    author's collecting session (created when there is none), as its next
    number, with one "Moved to Build Session" entry. Both sessions resync."""
    old = _session(db, n.session_id)
    if old and old.status == "collecting":
        return
    s = _collecting_session(db, n.created_by, title=_held_title(old))
    if old and s.id == old.id:
        return
    top = db.query(func.max(DevNote.number)).filter(DevNote.session_id == s.id).scalar() or 0
    n.session_id, n.number = s.id, int(top) + 1
    _append(n, _entry("claude", "system", f"Moved to Build Session '{s.title}' as Pin #{n.number}"))
    db.flush()
    _sync_session(db, old)
    _sync_session(db, s)


def _owner_has_access(db: Session, email: str) -> bool:
    # No try/except on purpose: a swallowed database error would leave a
    # Postgres transaction aborted for the rest of the request.
    role, level = auth._role_for(email, db)
    return _allowed({"email": email, "role": role, "level": level}, db)


# ── sessions ──────────────────────────────────────────────────────────────────
def _auto_title() -> str:
    now = datetime.now(timezone.utc)
    return f"Build Session {now.strftime('%m/%d/%Y')} {now.strftime('%I:%M %p').lstrip('0')}"


def _collecting_session(db: Session, email: str, create: bool = True,
                        title: str = "") -> Optional[DevNoteSession]:
    """The author's one collecting session, created on the first pin. `title`
    (the browser's "Build Session MM/DD/YYYY h:mm AM" in the author's local
    time) names a NEW session only - the server clock is UTC."""
    email = email.lower()
    if create and db.bind is not None and db.bind.dialect.name == "postgresql":
        # Two first pins at once would both find no session and both insert
        # one. The row lock below cannot guard a row that does not exist yet,
        # so serialize per author for this transaction (SQLite: single writer).
        db.execute(sa_text("SELECT pg_advisory_xact_lock(hashtext(:email))"), {"email": email})
    s = _oldest_collecting(db, email)
    if s or not create:
        return s
    now = _now()
    s = DevNoteSession(id=str(uuid.uuid4()), title=(title or "").strip()[:120] or _auto_title(), status="collecting",
                       created_by=email, created_at=now, updated_at=now, note_count=0)
    db.add(s)
    db.flush()
    return _oldest_collecting(db, email) or s


def _oldest_collecting(db: Session, email: str) -> Optional[DevNoteSession]:
    """The author's collecting session - and should more than one exist (a
    race that slipped past the lock), the oldest, with the others' pins moved
    onto it (renumbered after its last pin) and the emptied duplicates removed."""
    rows = (db.query(DevNoteSession)
            .filter(DevNoteSession.created_by == email, DevNoteSession.status == "collecting")
            .order_by(DevNoteSession.created_at.asc(), DevNoteSession.id.asc())
            .with_for_update().all())
    if not rows:
        return None
    keep, extra = rows[0], rows[1:]
    if extra:
        top = db.query(func.max(DevNote.number)).filter(DevNote.session_id == keep.id).scalar() or 0
        strays = (db.query(DevNote).filter(DevNote.session_id.in_([e.id for e in extra]))
                  .order_by(DevNote.created_at.asc()).all())
        for n in strays:
            top += 1
            n.session_id, n.number = keep.id, top
        for e in extra:
            db.delete(e)
        db.flush()
        _sync_session(db, keep)
    return keep


def _session(db: Session, session_id: str) -> Optional[DevNoteSession]:
    if not session_id:
        return None
    return db.query(DevNoteSession).filter(DevNoteSession.id == session_id).first()


def _sync_session(db: Session, s: Optional[DevNoteSession]) -> None:
    """note_count and the statuses that follow the pins. A session that was
    never dispatched (dispatched_at == '') stays `collecting` whatever its pins
    do - dismissing the only pin must not close it, or the next pin and the
    Send button would not find it. After dispatch: done when every pin is done
    or dismissed, building when any pin is being worked on; sent, pr_open and
    fixed are set by the step that causes them."""
    if not s:
        return
    db.flush()   # autoflush is off: count what this request just wrote too
    rows = db.query(DevNote.status).filter(DevNote.session_id == s.id).all()
    statuses = [r[0] for r in rows]
    s.note_count = len(statuses)
    s.updated_at = _now()
    if not s.dispatched_at:
        s.status = "collecting"
        return
    if statuses and all(x in ("done", "dismissed") for x in statuses):
        s.status = "done"
    elif s.status == "done":
        s.status = "fixed" if any(x == "fixed" for x in statuses) else "sent"
    if any(x in ("building", "needs_input") for x in statuses):
        s.status = "building"


def _target_for(db: Session, email: str) -> str:
    """Where this person's sent pins go: their Claude Code in the cloud when
    they connected it and it is their choice, else their terminal."""
    if _settings(db, email).get("dispatchTarget") == "cloud" and _cloud.connected(db, email):
        return "cloud"
    return "local"


def _terminal_live(db: Session, email: str) -> tuple:
    """(live, lastSeen): is one of this person's Build Tokens in use right now
    - their terminal watcher asks every ~25 s (CONNECTED_SEC)."""
    now = _now()
    rows = (db.query(DevNoteToken)
            .filter(DevNoteToken.email == (email or "").lower(), or_(DevNoteToken.revoked_at == "", DevNoteToken.revoked_at.is_(None)))
            .all())
    last = max((t.last_used_at for t in rows if t.last_used_at and (t.expires_at or "") > now), default="")
    live = bool(last) and (datetime.fromisoformat(now) - datetime.fromisoformat(last)).total_seconds() <= CONNECTED_SEC
    return live, last


def _connected(db: Session, email: str) -> bool:
    """Can a pin this person sends reach a Claude Code right now: the cloud
    (nothing has to be running) or a live terminal watcher."""
    return _target_for(db, email) == "cloud" or _terminal_live(db, email)[0]


def _cloud_start(db: Session, notes: list, by: str) -> dict:
    """Start the sender's Claude Code in the cloud for pins that were just
    sent or answered (build_mode_cloud.py). Call it AFTER the commit that made
    them wait for Claude - the session claims them within seconds. Never
    raises: a session that did not start is said on the pin and in the
    answer, and Start Claude Code (POST /cloud/start) tries again. Commits."""
    notes = [n for n in notes if (n.dispatch_target or "") == "cloud"]
    if not notes:
        return {}
    from app_url import public_base
    by = (by or "").lower()
    now = _now()
    try:
        res = _cloud.fire(db, by, _cloud.fire_text([n.id for n in notes], public_base(), by))
    except _cloud.CloudError as e:
        for n in notes:
            n.progress = f"Claude Code did not start: {e}"[:400]
            n.progress_at = now
        db.commit()
        return {"started": False, "error": str(e)}
    url = res.get("sessionUrl") or ""
    seen = set()
    for n in notes:
        n.claude_session_url = url
        n.progress = CLOUD_STARTING
        n.progress_at = now
        if n.session_id and n.session_id not in seen:
            seen.add(n.session_id)
            s = _session(db, n.session_id)
            if s:
                s.claude_session_url = url
                s.updated_at = now
    _audit(db, {"email": by, "role": ""}, "cloud_start", notes[0].session_id or "",
           {"notes": [n.id for n in notes], "session": res.get("sessionId") or ""})
    db.commit()
    return {"started": True, "sessionUrl": url}


def _dispatch_notes(db: Session, notes: list, by: str) -> list:
    """Mark pins dispatched and their sessions sent."""
    now = _now()
    touched = []
    target = _target_for(db, by)
    for n in notes:
        if n.status != "open":
            raise HTTPException(409, f"Pin #{n.number} is {n.status}, not open - only open pins can be sent")
        if n.dispatch_target == "github":
            raise HTTPException(400, "GitHub dispatch is not available yet")
        n.status = "dispatched"
        n.dispatched_at = now
        n.dispatched_by = (by or "").lower()      # only this person's Claude Code picks it up
        n.dispatch_target = target                 # cloud: started by _cloud_start; local: their watcher
        n.updated_at = now
        s = _session(db, n.session_id)
        if s and s not in touched:
            touched.append(s)
    for s in touched:
        s.status = "sent"
        s.dispatched_at = now
        s.updated_at = now
        _sync_session(db, s)
    return touched


# ── routes: signed-in user ────────────────────────────────────────────────────
@router.get("/enabled")
def enabled(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Asked for everyone by the profile menu: never 403, just the answer."""
    if not _allowed(user, db):
        return {"enabled": False}
    return {"enabled": True, "settings": _settings(db, user["email"]), "blockedRoutes": list(BLOCKED_ROUTES),
            "owners": _owners_out(), "isGlobalAdmin": bool(_is_ga(user, db))}


@router.get("/settings")
def get_settings(user: dict = Depends(require_build_mode), db: Session = Depends(get_db)):
    return _settings(db, user["email"])


@router.put("/settings")
def put_settings(body: dict, user: dict = Depends(require_build_mode), db: Session = Depends(get_db)):
    current = _settings(db, user["email"])
    target = _get(body, "dispatchTarget")
    if target is not None:
        if target == "github":
            raise HTTPException(400, "GitHub dispatch is not available yet")
        if target not in ("local", "cloud"):
            raise HTTPException(400, "dispatchTarget must be local or cloud")
        if target == "cloud" and not _cloud.connected(db, user["email"]):
            raise HTTPException(400, "Connect Claude Code in the cloud first")
        current["dispatchTarget"] = target
    for key in ("sendInstantly", "pinsOnLoad", "onePr"):
        v = _get(body, key)
        if v is not None:
            current[key] = bool(v)
    for key in ("teamsChatId", "teamsChatName"):
        v = _get(body, key)
        if v is not None:
            current[key] = str(v).strip()[:200]
    out = _save_settings(db, user["email"], current)
    db.commit()
    return out


def _clean_note_input(body: dict, allowed: tuple) -> dict:
    out = {}
    for k, v in (body or {}).items():
        sk = _snake(str(k))
        if sk not in allowed:
            continue
        if sk in _LIST_FIELDS:
            if v is None:
                v = []
            if not isinstance(v, list):
                raise HTTPException(400, f"{_camel(sk)} must be a list")
            if sk in _LIST_CAPS:
                v = v[-_LIST_CAPS[sk]:]
            if sk == "network_log":
                # request / response bodies ride along (masked by the client); never more than 2 KB each
                v = [{k2: (s[:ENTRY_STR_MAX] if isinstance(s, str) else s) for k2, s in e.items()}
                     if isinstance(e, dict) else e for e in v]
        elif sk in _DICT_FIELDS:
            if v is None:
                v = {}
            if not isinstance(v, dict):
                raise HTTPException(400, f"{_camel(sk)} must be an object")
            if len(json.dumps(v)) > DICT_FIELD_MAX:
                raise HTTPException(413, f"{_camel(sk)} is larger than 64 KB")
        elif sk in _TEXT_CAPPED:
            v = "" if v is None else str(v)
            if len(v.encode("utf-8")) > TEXT_FIELD_MAX:
                raise HTTPException(413, f"{_camel(sk)} is larger than 20 KB")
        elif sk in MEDIA_FIELDS:
            v = _check_media(sk, v)
        elif sk == "kind":
            if v not in KINDS:
                raise HTTPException(400, "kind must be bug, change, question or edit")
        elif sk == "priority":
            if v not in PRIORITIES:
                raise HTTPException(400, "priority must be blocking, normal or nice")
        else:
            v = "" if v is None else str(v)
        out[sk] = v
    if "attachments" in out:
        out["attachments"] = [_check_media("attachments", a) for a in out["attachments"] if a]
    return out


# "" not "/": the route lives at /dev-notes like every other router and api.js
# path; FastAPI still answers /dev-notes/ with a 307 to it.
@router.post("", status_code=201)
def create_note(body: dict, user: dict = Depends(require_build_mode), db: Session = Depends(get_db)):
    email = user["email"].lower()
    fields = _clean_note_input(body, CREATE_FIELDS)
    if (fields.get("route") or "") in BLOCKED_ROUTES:
        raise HTTPException(400, "Build Mode is off on this screen")
    settings = _settings(db, email)
    s = _collecting_session(db, email, title=str(_get(body, "sessionTitle", "") or ""))
    top = db.query(func.max(DevNote.number)).filter(DevNote.session_id == s.id).scalar() or 0
    now = _now()
    # The browser uploads screenshots to dev-notes/<id>/ BEFORE it creates the
    # pin, so it may name the id (a uuid it minted); anything else is minted here.
    want = str(_get(body, "id", "") or "").strip().lower()
    note_id = str(uuid.uuid4())
    if want:
        try:
            note_id = str(uuid.UUID(want))
        except ValueError:
            raise HTTPException(400, "id must be a UUID")
        if db.query(DevNote.id).filter(DevNote.id == note_id).first():
            raise HTTPException(409, "A pin with this id already exists")
    n = DevNote(id=note_id, session_id=s.id, number=int(top) + 1, status="open",
                thread=[], dispatch_target=settings.get("dispatchTarget") or "local",
                created_by=email, created_at=now, updated_at=now, **fields)
    for k in _LIST_FIELDS:
        if getattr(n, k) is None:
            setattr(n, k, [])
    for k in _DICT_FIELDS:
        if getattr(n, k) is None:
            setattr(n, k, {})
    db.add(n)
    _assign_owner(db, n)
    _audit(db, user, "create", n.id, {"kind": n.kind, "route": n.route, "session": s.id,
                                      "heldFor": n.owner_email if _held(n) else ""}, kind="create")
    # Send Instantly sends only when a Claude Code can receive it (11/12/2026):
    # with nothing connected the composer says "this saves the pin", and the
    # server used to send it anyway and call it sent. It now stays open in
    # the Build Session, to be sent from the Queue once connected.
    if settings.get("sendInstantly") and not _held(n) and _connected(db, email):
        db.flush()
        _dispatch_notes(db, [n], email)
        _audit(db, user, "dispatch", n.id, {"session": s.id, "instant": True})
    else:
        _sync_session(db, s)
    db.commit()
    if n.status == "dispatched":
        _cloud_start(db, [n], email)
    db.refresh(n)
    return _serialize(n, _viewer(user, db))


@router.get("")
def list_notes(status: str = "", sessionId: str = "", route: str = "", mine: int = 0,
               limit: int = Query(500, ge=1, le=2000),
               user: dict = Depends(require_build_mode_or_token), db: Session = Depends(get_db)):
    q = db.query(DevNote)
    if status:
        if status not in STATUSES:
            raise HTTPException(400, "Unknown status")
        q = q.filter(DevNote.status == status)
    else:
        q = q.filter(DevNote.status != "dismissed")
    if sessionId:
        q = q.filter(DevNote.session_id == sessionId)
    if route:
        q = q.filter(DevNote.route == route)
    if mine:
        q = q.filter(DevNote.created_by == user["email"].lower())
    rows = q.order_by(DevNote.created_at.desc()).limit(limit).all()
    me = _viewer(user, db)
    return [_serialize(n, me) for n in rows]


@router.get("/pins")
def pins(route: str = "", sub: str = "", user: dict = Depends(require_build_mode),
         db: Session = Depends(get_db)):
    """Every live pin on that screen, from every author - the team sees each
    other's pins. Fixed ones are included (the author verifies them there)."""
    q = db.query(DevNote).filter(DevNote.status.notin_(("done", "dismissed")))
    if route:
        q = q.filter(DevNote.route == route)
    if sub:
        q = q.filter(or_(DevNote.sub == sub, DevNote.sub == ""))
    me = _viewer(user, db)
    return [_serialize(n, me) for n in q.order_by(DevNote.created_at.asc()).all()]


def _note(db: Session, note_id: str, lock: bool = False) -> DevNote:
    q = db.query(DevNote).filter(DevNote.id == note_id)
    if lock:
        q = q.with_for_update()
    n = q.first()
    if not n:
        raise HTTPException(404, "Pin not found")
    return n


@router.get("/sessions")
def list_sessions(status: str = "", mine: int = 0, limit: int = Query(200, ge=1, le=1000),
                  user: dict = Depends(require_build_mode), db: Session = Depends(get_db)):
    q = db.query(DevNoteSession)
    if status:
        if status not in SESSION_STATUSES:
            raise HTTPException(400, "Unknown status")
        q = q.filter(DevNoteSession.status == status)
    if mine:
        q = q.filter(DevNoteSession.created_by == user["email"].lower())
    rows = q.order_by(DevNoteSession.created_at.desc()).limit(limit).all()
    return [_serialize_session(s) for s in rows]


@router.patch("/sessions/{session_id}")
def patch_session(session_id: str, body: dict, user: dict = Depends(require_build_mode),
                  db: Session = Depends(get_db)):
    s = _session(db, session_id)
    if not s:
        raise HTTPException(404, "Build Session not found")
    _own_or_admin(s.created_by, user, db, "rename a Build Session")
    title = _get(body, "title")
    if title is None or not str(title).strip():
        raise HTTPException(400, "title is required")
    s.title = str(title).strip()[:200]
    s.updated_at = _now()
    db.commit()
    return _serialize_session(s)


@router.get("/sessions/{session_id}/report")
def session_report(session_id: str, user: dict = Depends(require_build_mode), db: Session = Depends(get_db)):
    """Save Report: one self-contained HTML file of the Build Session - every
    pin grouped by module with its kind, comment, Where line and the marked-up
    element shot embedded (base64), so it opens anywhere with no login and
    can be attached to an email. Author or admin."""
    s = _session(db, session_id)
    if not s:
        raise HTTPException(404, "Build Session not found")
    _own_or_admin(s.created_by, user, db, "save this report")
    notes = db.query(DevNote).filter(DevNote.session_id == s.id, DevNote.status != "dismissed").all()
    notes.sort(key=lambda n: (n.route or "", n.number or 0))
    e = _html.escape
    from task_due import us_date
    made = us_date((s.created_at or "")[:10]) or (s.created_at or "")[:10]
    parts = [f"<!doctype html><html><head><meta charset='utf-8'><title>{e(s.title or 'Build Session')}</title>"
             "<style>body{font:14px/1.5 Inter,Arial,sans-serif;color:#111;max-width:860px;margin:32px auto;padding:0 16px}"
             "h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}"
             ".pin{margin:14px 0 22px}.k{display:inline-block;font-size:11px;font-weight:700;padding:1px 7px;border-radius:9px;background:#eee;margin-right:6px}"
             ".dim{color:#666;font-size:12px}img{max-width:100%;border:1px solid #ddd;border-radius:6px;margin-top:8px}</style></head><body>",
             f"<h1>{e(s.title or 'Build Session')}</h1>",
             f"<div class='dim'>{len(notes)} pin{'' if len(notes) == 1 else 's'} · {e(_chat.name_of(db, s.created_by))} · {e(made)}</div>"]
    module = None
    for n in notes:
        m = _chat.module_label(n.route, n.sub)
        if m != module:
            module = m
            parts.append(f"<h2>{e(m)}</h2>")
        parts.append(f"<div class='pin'><span class='k'>#{n.number} {e((n.kind or 'bug').capitalize())}</span>"
                     f"<span class='k'>{e(PRIORITY_LABELS.get(n.priority or 'normal', 'Normal'))}</span>"
                     f"<span class='k'>{e(STATUS_LABELS.get(n.status or 'open', (n.status or 'open').capitalize()))}</span>"
                     f"<div>{e(n.comment or '')}</div>")
        where = _chat.source_location(n.target)
        if where:
            parts.append(f"<div class='dim'>Where: {e(where)}</div>")
        if n.transcript:
            parts.append(f"<div class='dim'><em>{e(n.transcript)}</em></div>")
        got = _chat.read_image(n.screenshot_url) if n.screenshot_url else None
        if got:
            parts.append(f"<img alt='Pin #{n.number}' src='data:{got[1]};base64,{base64.b64encode(got[0]).decode('ascii')}'>")
        parts.append("</div>")
    parts.append("</body></html>")
    name = re.sub(r"[^A-Za-z0-9 _-]+", "", s.title or "Build Session").strip() or "Build Session"
    return Response("".join(parts), media_type="text/html",
                    headers={"Content-Disposition": f'attachment; filename="{name} {made.replace("/", "-")}.html"'})


PRIORITY_LABELS = {"blocking": "Blocking", "normal": "Normal", "nice": "Nice To Have"}
STATUS_LABELS = {"open": "Open", "dispatched": "Sent", "building": "Building", "needs_input": "Needs Input",
                 "pr_open": "PR Open", "fixed": "Fixed - Verify", "done": "Done", "dismissed": "Dismissed"}


@router.post("/teams-post")
def teams_post(body: dict, background_tasks: BackgroundTasks, user: dict = Depends(require_build_mode),
               db: Session = Depends(get_db)):
    """Post To Teams (Pranshu, Oct 26 2026): the caller's open pins - every
    screen they pinned on, or one Build Session's (`sessionId`) - as ONE card
    in the Teams chat they pick (any group or 1:1 chat they are in), posted
    as them with the screenshots inline. Nothing goes to Claude Code and the
    pins keep their status; each gets a "Posted To Teams" entry. The pick is
    remembered for next time. Delivery is the ticket Teams queue's
    (build_mode_chat.deliver), so it retries and keeps its reason."""
    email = user["email"].lower()
    chat_id = str(_get(body, "teamsChatId") or "").strip()[:200]
    chat_name = str(_get(body, "teamsChatName") or "").strip()[:200]
    if not chat_id:
        raise HTTPException(400, "Pick a Teams chat first")
    q = db.query(DevNote).filter(DevNote.created_by == email, DevNote.status == "open")
    session_id = str(_get(body, "sessionId") or "").strip()
    if session_id:
        q = q.filter(DevNote.session_id == session_id)
    notes = q.order_by(DevNote.route.asc(), DevNote.number.asc()).with_for_update().all()
    if not notes:
        raise HTTPException(400, "No open pins to post")
    s = _session(db, notes[0].session_id)
    settings = _settings(db, email)
    settings.update({"teamsChatId": chat_id, "teamsChatName": chat_name})
    _save_settings(db, email, settings)
    title = (s.title if s else "") or "Build Session"
    row = _chat.queue(db, email, s.id if s else notes[0].id, chat_id, _chat.card_html(db, title, email, notes))
    now = _now()
    for n in notes:
        _append(n, _entry(email, "system", f"Posted To Teams - {chat_name or 'a chat'}"))
        n.updated_at = now
    _audit(db, user, "teams_post", s.id if s else "", {"notes": [n.id for n in notes], "chat": chat_name})
    db.commit()
    _chat.deliver_later(background_tasks, row)
    return {"posted": len(notes), "chatName": chat_name}


@router.post("/dispatch")
def dispatch(body: Optional[dict] = None, user: dict = Depends(require_build_mode), db: Session = Depends(get_db)):
    body = body or {}
    email = user["email"].lower()
    if _settings(db, email).get("dispatchTarget") == "github":
        raise HTTPException(400, "GitHub dispatch is not available yet")
    note_ids = _ids(body)
    session_id = _get(body, "sessionId") or ""
    title = _get(body, "title")
    if note_ids:
        notes = db.query(DevNote).filter(DevNote.id.in_(note_ids)).with_for_update().all()
        if len(notes) != len(set(note_ids)):
            raise HTTPException(404, "Pin not found")
        s = _session(db, notes[0].session_id)
    else:
        s = _session(db, session_id) if session_id else _collecting_session(db, email, create=False)
        if not s and session_id:
            raise HTTPException(404, "Build Session not found")
        if not s:
            raise HTTPException(400, "No open pins to send")
        notes = (db.query(DevNote).filter(DevNote.session_id == s.id, DevNote.status == "open")
                 .order_by(DevNote.number.asc()).with_for_update().all())
        if not notes:
            raise HTTPException(400, "No open pins to send")
    for n in notes:
        _own_or_admin(n.created_by, user, db, "send this pin")
    # A pin on another developer's area waits for them (code_owners.py): it is
    # never sent to Claude Code until they release it.
    held = [n for n in notes if _held(n)]
    notes = [n for n in notes if not _held(n)]
    if not notes:
        raise HTTPException(400, "No open pins to send - " + "; ".join(_waits_for(n) for n in held))
    if title and s:
        s.title = str(title).strip()[:200]
    touched = _dispatch_notes(db, notes, email)
    # Held open pins left behind in a now-sent session move to their author's
    # collecting session: the sent one can finish, and they stay sendable
    # once released.
    db.flush()
    left = (db.query(DevNote)
            .filter(DevNote.session_id.in_([t.id for t in touched]), DevNote.status == "open")
            .order_by(DevNote.number.asc()).with_for_update().all()) if touched else []
    for n in left:
        if _held(n):
            _move_to_collecting(db, n)
            if n not in held:
                held.append(n)
    held_out = [{"id": n.id, "number": n.number or 0, "ownerName": n.owner_name or n.owner_email} for n in held]
    _audit(db, user, "dispatch", s.id if s else "", {"notes": [n.id for n in notes], "held": [n.id for n in held]})
    db.commit()
    # Claude Code in the cloud (11/12/2026): `cloud` is {} for a terminal
    # send, else {started, sessionUrl} or {started: False, error}.
    cloud = _cloud_start(db, notes, email)
    s = s or (touched[0] if touched else None)
    me = _viewer(user, db)
    return {"session": _serialize_session(s) if s else None, "notes": [_serialize(n, me) for n in notes],
            "held": held_out, "cloud": cloud}


# ── retention ─────────────────────────────────────────────────────────────────
def _media_urls(n: DevNote) -> list:
    urls = [n.screenshot_url, n.page_shot_url, n.video_url, n.contact_sheet_url, *(n.attachments or [])]
    visual = (n.verification or {}).get("visual") or {}
    urls += [visual.get("beforeUrl"), visual.get("afterUrl"), visual.get("clipUrl")]
    return [u for u in urls if isinstance(u, str) and u]


def purge_media(db: Session) -> int:
    """Pins past their purge date (done / dismissed + 30 days): delete every
    media object from storage and blank the URL columns, with one "Media
    Purged" entry. A URL storage would not delete stays for the next run (the
    pin keeps its purge date until nothing is left, then it is blanked so the
    row is never selected again). Returns the number of pins something was
    deleted from. `purge_media_loop` runs it daily on the deployed API;
    POST /dev-notes/purge runs it on demand."""
    now = _now()
    rows = (db.query(DevNote)
            .filter(DevNote.purge_at != "", DevNote.purge_at <= now,
                    DevNote.status.in_(("done", "dismissed")))
            .with_for_update().all())
    purged = 0
    for n in rows:
        urls = list(dict.fromkeys(_media_urls(n)))
        if not urls:
            n.purge_at = ""   # nothing to purge (a pin with no media): done with it
            continue
        kept = {u for u in urls if not _delete_object(u)}
        if len(kept) == len(urls):
            continue      # storage refused everything this run: no change, no entry, try again later
        for col in MEDIA_FIELDS:
            if getattr(n, col) and getattr(n, col) not in kept:
                setattr(n, col, "")
        n.attachments = [a for a in (n.attachments or []) if a in kept]
        v = dict(n.verification or {})
        visual = dict(v.get("visual") or {})
        if visual:
            v["visual"] = {k: (u if u in kept else "") for k, u in visual.items()}
            n.verification = v
        last = (n.thread or [{}])[-1]
        if not str(last.get("text", "")).startswith("Media Purged"):
            _append(n, _entry("claude", "system", "Media Purged" if not kept else f"Media Purged ({len(kept)} left for the next run)"))
        if not kept:
            n.purge_at = ""
        purged += 1
    db.commit()
    return purged


@router.post("/purge")
def purge(user: dict = Depends(require_build_mode), db: Session = Depends(get_db)):
    if not _is_ga(user, db):
        raise HTTPException(403, "Only a Super Administrator can purge Build Mode media")
    n = purge_media(db)
    _audit(db, user, "purge", "", {"purged": n}, kind="delete")
    db.commit()
    return {"purged": n}


PURGE_LOOP_SEC = 24 * 3600
PURGE_JOB = {"email": "build-mode-purge", "role": "system"}   # audit author, like m365_profile_sync


def _purge_pass() -> int:
    """One daily run in a worker thread: its own session, an audit row only
    when something was deleted (a quiet day leaves no trace)."""
    if job_switch.off("purge_media"):   # Workflows > Automations switch
        return 0
    db = database.SessionLocal()
    try:
        n = purge_media(db)
        if n:
            _audit(db, PURGE_JOB, "purge", "", {"purged": n, "by": "daily"}, kind="delete")
            db.commit()
        return n
    finally:
        db.close()


async def purge_media_loop():
    """Daily media purge (main.py lifespan, leader + deployed worker only: it
    deletes live storage with the service key). The storage calls and queries
    run in a thread - never on the event loop."""
    await asyncio.sleep(600)   # let startup settle
    while True:
        try:
            n = await asyncio.to_thread(_purge_pass)
            if n:
                print(f"[build-mode-purge] purged media of {n} pins")
        except Exception as e:
            print(f"[build-mode-purge] run failed: {e}")
        await asyncio.sleep(PURGE_LOOP_SEC)


# ── stats ─────────────────────────────────────────────────────────────────────
def _hours_between(a: str, b: str) -> Optional[float]:
    try:
        return (datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds() / 3600
    except (TypeError, ValueError):
        return None


def _median(xs: list) -> Optional[float]:
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    mid = len(xs) // 2
    return round(xs[mid] if len(xs) % 2 else (xs[mid - 1] + xs[mid]) / 2, 2)


@router.get("/stats")
def stats(user: dict = Depends(require_build_mode), db: Session = Depends(get_db)):
    """The last 90 days of pins. `open` includes dispatched, `building`
    includes needs_input. medianPinToPrHours: pin created -> its "PR #n Open"
    entry. reopenRate: share of pins that reached fixed and were reopened.
    firstClaimHitRate is a cheap proxy: share of completed pins (a PR opened)
    whose first progress line after the claim started with "Found " (the
    skill posts "Found <file>" when it locates the code) and that were never
    reopened. None where there is nothing to divide by."""
    since = (datetime.now(timezone.utc) - timedelta(days=STATS_DAYS)).isoformat()
    rows = db.query(DevNote).filter(DevNote.created_at >= since).all()
    counts = {"total": len(rows), "open": 0, "building": 0, "prOpen": 0, "fixed": 0, "done": 0, "dismissed": 0}
    bucket = {"open": "open", "dispatched": "open", "building": "building", "needs_input": "building",
              "pr_open": "prOpen", "fixed": "fixed", "done": "done", "dismissed": "dismissed"}
    to_pr, reached_fixed, reopened, completed, hits = [], 0, 0, 0, 0
    for n in rows:
        key = bucket.get(n.status)
        if key:
            counts[key] += 1
        thread = [e for e in (n.thread or []) if isinstance(e, dict)]
        pr_entry = next((e for e in thread if e.get("kind") == "system" and str(e.get("text", "")).startswith("PR #")), None)
        if pr_entry:
            to_pr.append(_hours_between(n.created_at, pr_entry.get("at", "")))
        if n.fixed_at or (n.status in ("fixed", "done") and n.pr_number):
            reached_fixed += 1
            if int(n.reopen_count or 0) > 0:
                reopened += 1
        if n.pr_number and n.status in ("pr_open", "fixed", "done"):
            completed += 1
            first = next((e for e in thread if e.get("kind") == "progress"
                          and str(e.get("text", "")) != "Picked up by Claude Code"), None)
            if first and str(first.get("text", "")).startswith("Found ") and not int(n.reopen_count or 0):
                hits += 1
    return {
        "pins": counts,
        "medianPinToPrHours": _median(to_pr),
        "reopenRate": round(reopened / reached_fixed, 3) if reached_fixed else None,
        "firstClaimHitRate": round(hits / completed, 3) if completed else None,
        "days": STATS_DAYS,
    }


# ── owners (before the /{note_id} routes: "/owners" is one segment too) ──────
@router.get("/owners")
def owners(user: dict = Depends(require_build_mode_or_token)):
    """The File Ownership map (code_owners.py) for the CLI when it cannot load
    the file itself."""
    return {"owners": _owners_out()}


@router.get("/owner-of")
def owner_of(path: str = "", user: dict = Depends(require_build_mode)):
    """Who owns the file a source stamp names (code_owners.normalize +
    owner_of on the server, so the composer needs no copy of them). `held`:
    a pin there would wait for its owner - the owner is not the caller."""
    owner = code_owners.owner_of(path)
    me = (user.get("email") or "").lower()
    return {"owner": owner, "held": bool(owner) and owner["email"].lower() != me}


# ── Build Tokens (before the /{note_id} routes: "/tokens" is one segment too) ──
@router.post("/tokens", status_code=201)
def mint_token(body: Optional[dict] = None, user: dict = Depends(require_build_mode), db: Session = Depends(get_db)):
    body = body or {}
    label = str(_get(body, "label") or "").strip()[:120]
    raw = TOKEN_PREFIX + secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    row = DevNoteToken(id=str(uuid.uuid4()), email=user["email"].lower(), label=label,
                       token_hash=_hash(raw), created_at=now.isoformat(),
                       expires_at=(now + timedelta(days=TOKEN_DAYS)).isoformat(),
                       last_used_at="", revoked_at="")
    db.add(row)
    _audit(db, user, "token_mint", row.id, {"label": label, "expiresAt": row.expires_at}, kind="create")
    db.commit()
    return {"id": row.id, "token": raw, "label": label, "expiresAt": row.expires_at}


CONNECTED_SEC = 150   # the watcher asks every ~25 s and the token's last use is rewritten once a minute


@router.get("/claude-connection")
def claude_connection(user: dict = Depends(require_build_mode), db: Session = Depends(get_db)):
    """Is the caller's own Claude Code listening? (Oct 26 2026: Send To
    Claude Code goes only to the sender's watcher, so Nexus says whether it is
    there before anyone sends.) Connected = one of their live Build Tokens was
    used in the last CONNECTED_SEC. `apiBase` is this API's public address for
    the connect command ('' when running locally - the browser knows it then)."""
    from app_url import public_base
    terminal, last = _terminal_live(db, user["email"])
    # In the cloud nothing has to be running: a saved trigger that is the
    # person's choice IS connected (11/12/2026).
    cloud = _target_for(db, user["email"]) == "cloud"
    return {"connected": terminal or cloud, "terminal": terminal, "cloud": cloud, "lastSeen": last,
            "apiBase": public_base()}


# ── Claude Code in the cloud (build_mode_cloud.py, Neil 11/12/2026) ───────────
def _set_target(db: Session, email: str, target: str) -> None:
    current = _settings(db, email)
    current["dispatchTarget"] = target
    _save_settings(db, email, current)


@router.get("/cloud")
def cloud_status(user: dict = Depends(require_build_mode), db: Session = Depends(get_db)):
    """Is the caller's Claude Code in the cloud connected? Never the token."""
    return {**_cloud.status(db, user["email"]), "target": _target_for(db, user["email"])}


@router.put("/cloud")
def cloud_connect(body: dict, user: dict = Depends(require_build_mode), db: Session = Depends(get_db)):
    """Save the caller's Claude Code trigger (the scheduled task's Fire URL and
    token). Connecting it is choosing it: their pins go to the cloud from now
    on. Nothing is called - a test call would start a real session."""
    email = user["email"].lower()
    try:
        out = _cloud.save(db, email, str(_get(body, "fireUrl") or ""), str(_get(body, "token") or ""))
    except _cloud.CloudError as e:
        raise HTTPException(400, str(e))
    _set_target(db, email, "cloud")
    _audit(db, user, "cloud_connect", "", {"task": out["task"]})
    db.commit()
    return {**out, "target": "cloud"}


@router.delete("/cloud", status_code=204)
def cloud_disconnect(user: dict = Depends(require_build_mode), db: Session = Depends(get_db)):
    email = user["email"].lower()
    if _cloud.connected(db, email):
        _cloud.clear(db, email)
        _audit(db, user, "cloud_disconnect", "")
    _set_target(db, email, "local")
    db.commit()
    return Response(status_code=204)


@router.post("/cloud/start")
def cloud_start(body: Optional[dict] = None, user: dict = Depends(require_build_mode), db: Session = Depends(get_db)):
    """Start Claude Code In The Cloud for the caller's pins that wait for it:
    sent, or answered. For a session that did not start, and for pins sent
    before the cloud was connected. `noteIds` narrows it; none = all of them."""
    email = user["email"].lower()
    if not _cloud.connected(db, email):
        raise HTTPException(400, "Connect Claude Code in the cloud first")
    ids = set(_ids(body or {}))
    notes = [n for n in _pending(db, email, cloud=True) if not ids or n.id in ids]
    if not notes:
        raise HTTPException(400, "No pins are waiting for Claude Code")
    now = datetime.fromisoformat(_now())
    for n in notes:
        # A second call is a second session on the same pins.
        if (n.progress or "") == CLOUD_STARTING and n.progress_at and \
                (now - datetime.fromisoformat(n.progress_at)).total_seconds() < CLOUD_RESTART_SEC:
            raise HTTPException(409, f"Claude Code was started for Pin #{n.number} a moment ago - give it two minutes")
        n.dispatch_target = "cloud"
    db.commit()
    cloud = _cloud_start(db, notes, email)
    me = _viewer(user, db)
    return {"cloud": cloud, "notes": [_serialize(n, me) for n in notes]}


@router.get("/tokens")
def list_tokens(user: dict = Depends(require_build_mode), db: Session = Depends(get_db)):
    q = db.query(DevNoteToken)
    if not _is_ga(user, db):
        q = q.filter(DevNoteToken.email == user["email"].lower())
    return [_serialize_token(t) for t in q.order_by(DevNoteToken.created_at.desc()).all()]


@router.delete("/tokens/{token_id}", status_code=204)
def revoke_token(token_id: str, user: dict = Depends(require_build_mode), db: Session = Depends(get_db)):
    t = db.query(DevNoteToken).filter(DevNoteToken.id == token_id).first()
    if not t:
        raise HTTPException(404, "Build Token not found")
    _own_or_admin(t.email, user, db, "revoke this Build Token")
    if not t.revoked_at:
        t.revoked_at = _now()
        _audit(db, user, "token_revoke", t.id, {"label": t.label or "", "owner": t.email}, kind="delete")
        db.commit()
    return Response(status_code=204)


# ── one pin (declared last: "/{note_id}" would otherwise swallow the named routes) ──
@router.get("/{note_id}")
def get_note(note_id: str, user: dict = Depends(require_build_mode_or_token), db: Session = Depends(get_db)):
    return _serialize(_note(db, note_id), _viewer(user, db))


@router.patch("/{note_id}")
def patch_note(note_id: str, body: dict, user: dict = Depends(require_build_mode),
               db: Session = Depends(get_db)):
    n = _note(db, note_id, lock=True)
    if _get(body, "release"):
        _release(db, n, user)
        if not any(k for k in (body or {}) if k != "release"):
            _sync_session(db, _session(db, n.session_id))
            db.commit()
            if n.status == "dispatched":
                _cloud_start(db, [n], sent_by(n))
            db.refresh(n)
            return _serialize(n, _viewer(user, db))
    _own_or_admin(n.created_by, user, db, "change this pin")
    fields = _clean_note_input(body, PATCH_FIELDS)
    status = _get(body, "status")
    if status is not None:
        if status == "dismissed":
            if n.status == "done":
                raise HTTPException(409, f"Pin #{n.number} is done and cannot be dismissed")
            if n.status != "dismissed":
                _close(n, "dismissed")
                _append(n, _entry(user["email"].lower(), "system", "Dismissed"))
        elif status == "open":
            if n.status != "dismissed":
                raise HTTPException(409, f"Pin #{n.number} is {n.status} - only a dismissed pin reopens this way")
            n.status = "open"
            n.purge_at = ""
            _append(n, _entry(user["email"].lower(), "system", "Reopened"))
        else:
            raise HTTPException(400, "status may only be dismissed or open here")
    for k, v in fields.items():
        setattr(n, k, v)
    n.updated_at = _now()
    _sync_session(db, _session(db, n.session_id))
    db.commit()
    db.refresh(n)
    return _serialize(n, _viewer(user, db))


def _release(db: Session, n: DevNote, user: dict) -> None:
    """The owner (or a Global Admin) hands a held pin to Claude Code: from now
    on it is an ordinary pin of its AUTHOR's. Still open in a session that was
    already sent, it moves to the author's collecting session; when the
    author's settings say Send Instantly it is dispatched at once, the way
    create_note sends an instant pin. Releasing a pin that is no longer held
    is a no-op."""
    email = (user.get("email") or "").lower()
    if email != (n.owner_email or "").lower() and not _is_ga(user, db):
        raise HTTPException(403, "Only the owner of this area or a Super Administrator can release this pin")
    if not _held(n):
        if not n.owner_released_at:
            raise HTTPException(409, f"Pin #{n.number} is not waiting for an owner")
        return
    now = _now()
    n.owner_released_by = email
    n.owner_released_at = now
    _append(n, _entry(email, "system", f"Released To Claude Code by {_name_of(db, email)}"))
    _audit(db, user, "release", n.id, {"owner": n.owner_email})
    if n.status != "open":
        return
    author = (n.created_by or "").lower()
    _move_to_collecting(db, n)
    if _settings(db, author).get("sendInstantly"):
        db.flush()
        _dispatch_notes(db, [n], author)
        _audit(db, user, "dispatch", n.id, {"session": n.session_id, "instant": True, "released": True})


@router.post("/{note_id}/thread")
def add_thread(note_id: str, body: dict, user: dict = Depends(require_build_mode),
               db: Session = Depends(get_db)):
    n = _note(db, note_id, lock=True)
    text = str(_get(body, "text") or "").strip()
    image_url = _check_media("imageUrl", _get(body, "imageUrl") or "")
    if not text and not image_url:
        raise HTTPException(400, "text is required")
    _append(n, _entry(user["email"].lower(), "comment", text, image_url))
    answered = n.status == "needs_input"
    if answered:
        n.status = "building"   # Claude was waiting on this answer
    _sync_session(db, _session(db, n.session_id))
    db.commit()
    # In the cloud nothing is listening: the answer starts Claude Code again
    # (same branch - the brief says so). Only from Needs Input, where Claude
    # had stopped; a comment on a pin it is still working starts nothing.
    if answered:
        _cloud_start(db, [n], sent_by(n))
    db.refresh(n)
    return _serialize(n, _viewer(user, db))


@router.post("/{note_id}/verify")
def verify(note_id: str, body: dict, user: dict = Depends(require_build_mode),
           db: Session = Depends(get_db)):
    n = _note(db, note_id, lock=True)
    _own_or_admin(n.created_by, user, db, "verify this pin")
    if n.status != "fixed":
        raise HTTPException(409, f"Pin #{n.number} is {n.status}, not fixed - nothing to verify")
    accepted = _get(body, "accepted")
    if accepted is None:
        raise HTTPException(400, "accepted is required")
    email = user["email"].lower()
    comment = str(_get(body, "comment") or "").strip()
    now = _now()
    if accepted:
        _close(n, "done")
        n.verified_by = email
        n.verified_at = now
        _append(n, _entry(email, "system", "Verified" + (f": {comment}" if comment else "")))
        _audit(db, user, "accept", n.id, {"pr": n.pr_number, "comment": comment[:200]})
    else:
        n.status = "open"
        n.purge_at = ""
        n.reopen_count = int(n.reopen_count or 0) + 1
        n.progress = ""
        n.progress_at = ""
        _append(n, _entry(email, "system", "Reopened" + (f": {comment}" if comment else "")))
        _audit(db, user, "reopen", n.id, {"pr": n.pr_number, "reopenCount": n.reopen_count, "comment": comment[:200]})
        if _settings(db, n.created_by).get("sendInstantly") and not _held(n):
            _dispatch_notes(db, [n], email)
    n.updated_at = now
    _sync_session(db, _session(db, n.session_id))
    db.commit()
    if accepted:
        promote_regression(db, n, user)
    elif n.status == "dispatched":
        _cloud_start(db, [n], sent_by(n))
    db.refresh(n)
    return _serialize(n, _viewer(user, db))


def _merge_guard(note_id: str, user: dict, db: Session, lock: bool = False) -> DevNote:
    if not _is_super(user):
        raise HTTPException(403, "Only a Super Administrator can merge to dev")
    n = _note(db, note_id, lock=lock)
    if n.status != "pr_open" or not n.pr_number:
        raise HTTPException(409, f"Pin #{n.number} has no open pull request to merge")
    return n


def _merge_chat(db: Session, email: str) -> tuple[str, str]:
    st = _settings(db, email)
    return str(st.get("teamsChatId") or ""), str(st.get("teamsChatName") or "")


def _merge_pins(db: Session, pr_number: int) -> list:
    return (db.query(DevNote).filter(DevNote.pr_number == pr_number, DevNote.status == "pr_open")
            .order_by(DevNote.number.asc()).all())


def _merge_look(db: Session, n: DevNote, email: str) -> dict:
    """GitHub's answer for the pin's PR plus what Nexus itself asks for: a
    team chat for the heads-up. `ok` only when nothing stands in the way."""
    try:
        look = _merge.look(n.pr_number)
    except _merge.MergeError as e:
        raise HTTPException(e.status, str(e))
    chat_id, chat_name = _merge_chat(db, email)
    reasons = list(look["reasons"])
    if not chat_id:
        reasons.append("Pick the team chat the heads-up goes to first: Queue, Post To Teams, the arrow beside it.")
    pins = _merge_pins(db, n.pr_number)
    unchecked = [x.number for x in pins if x.preview_verdict != "accepted"]
    return {**look, "ok": not reasons, "reasons": reasons, "chatName": chat_name,
            "pins": [{"id": x.id, "number": x.number or 0, "checked": x.preview_verdict == "accepted"} for x in pins],
            # Not a refusal: an unchecked pin goes to Fixed - Verify after the merge.
            "unchecked": unchecked}


@router.get("/{note_id}/merge")
def merge_look(note_id: str, user: dict = Depends(require_build_mode), db: Session = Depends(get_db)):
    """What Merge To Dev would do for this pin's pull request, and every
    reason it may not go yet. Reads only."""
    n = _merge_guard(note_id, user, db)
    if not _merge.available():
        return {"available": False, "ok": False, "reasons": ["Merge To Dev is not set up on this server."]}
    return {"available": True, **_merge_look(db, n, user["email"].lower())}


def _merge_card(db: Session, email: str, look: dict, pins: list) -> str:
    e = _html.escape
    nums = ", ".join(f"#{x.number}" for x in pins[:12]) or "-"
    return (f"<p><strong>Merging To Dev</strong> · <a href='{e(look['url'])}'>PR #{look['number']}</a> · {e(look['title'])}</p>"
            f"<p>Merged by {e(_chat.name_of(db, email))} from Build Mode · pins {e(nums)}. "
            "The dev site updates in about a minute and the dev API restarts for about 4 minutes - "
            "if you are testing on dev, expect a short interruption.</p>")


@router.post("/{note_id}/merge")
def merge_to_dev(note_id: str, body: dict, background_tasks: BackgroundTasks,
                 user: dict = Depends(require_build_mode), db: Session = Depends(get_db)):
    """Merge To Dev (Neil, 11/12/2026): a Super Administrator merges the
    pin's pull request into dev, and the heads-up goes to the team chat by
    the same click. `headSha` is the commit the person looked at - a branch
    that moved since is refused. One GitHub call, never retried."""
    email = user["email"].lower()
    n = _merge_guard(note_id, user, db, lock=True)
    look = _merge_look(db, n, email)
    if not look["ok"]:
        raise HTTPException(409, "Not merged. " + " ".join(look["reasons"]))
    if str(_get(body, "headSha") or "") != look["headSha"]:
        raise HTTPException(409, "Not merged. The branch changed since you looked - check it again, then merge.")
    chat_id, chat_name = _merge_chat(db, email)
    pins = _merge_pins(db, n.pr_number)
    # Queued in this transaction and kept only if the merge goes through: a
    # heads-up never announces a merge that did not happen.
    row = _chat.queue(db, email, n.session_id or n.id, chat_id, _merge_card(db, email, look, pins))
    try:
        sha = _merge.merge(n.pr_number, look["headSha"], look["title"])
    except _merge.MergeError as e:
        db.rollback()
        raise HTTPException(e.status, "Not merged. " + str(e))
    number = n.pr_number
    _audit(db, user, "merge_to_dev", n.session_id or "", {"pr": number, "sha": sha, "head": look["headSha"],
                                                          "chat": chat_name, "notes": [x.id for x in pins]})
    db.commit()
    _chat.deliver_later(background_tasks, row)
    # The webhook does this too when it arrives; whichever comes second finds
    # nothing left to change.
    mark_fixed_for_pr(db, number, sha)
    me = _viewer(user, db)
    ids = [x.id for x in pins]
    db.expire_all()
    rows = db.query(DevNote).filter(DevNote.id.in_(ids)).order_by(DevNote.number.asc()).all() if ids else []
    return {"merged": True, "sha": sha, "number": number, "chatName": chat_name, "notes": [_serialize(x, me) for x in rows]}


@router.post("/{note_id}/preview-verdict")
def preview_verdict(note_id: str, body: dict, user: dict = Depends(require_build_mode),
                    db: Session = Depends(get_db)):
    """The author's verdict on the Ready To Check local preview, before the PR
    merges. Accept counts as checked (the merge then closes the pin with no
    second check); Reopen (comment required) sends it back to Claude Code on
    the same branch - the comment is the last thread entry and the pin is
    building, which is exactly what /cli/wait picks up."""
    n = _note(db, note_id, lock=True)
    _own_or_admin(n.created_by, user, db, "check this pin")
    accepted = _get(body, "accepted")
    if accepted is None:
        raise HTTPException(400, "accepted is required")
    if not _checkable(n):
        raise HTTPException(409, f"Pin #{n.number} is not Ready To Check")
    # On the preview when one runs; else from the proof on the pin.
    where = "On The Preview" if (n.preview or {}).get("url") else "From The Proof On The Pin"
    email = user["email"].lower()
    comment = str(_get(body, "comment") or "").strip()
    if not accepted and not comment:
        raise HTTPException(400, "Say what is still wrong - a comment is required to reopen")
    if len(comment.encode("utf-8")) > TEXT_FIELD_MAX:
        raise HTTPException(413, "comment is larger than 20 KB")
    now = _now()
    n.preview_verdict = "accepted" if accepted else "reopened"
    n.preview_verdict_at = now
    # The verdict is about the commit the preview was running.
    commit = str((n.preview or {}).get("commit") or "")
    n.preview = {**(n.preview or {}), "verdictCommit": commit}
    if accepted:
        n.verified_by = email
        n.verified_at = now
        _append(n, _entry(email, "system", f"Checked {where}" + (f": {comment}" if comment else "")))
    else:
        # Counts as a reopen, like the post-merge one.
        n.reopen_count = int(n.reopen_count or 0) + 1
        n.progress = ""
        n.progress_at = ""
        _append(n, _entry(email, "system", f"Reopened {where}"))
        _append(n, _entry(email, "comment", comment))   # LAST: /cli/wait's rule
        n.status = "building"
        # The proof was of the fix that was just refused: the rework brings
        # its own (the files stay on the pin's attachments for the record).
        if (n.verification or {}).get("visual"):
            n.verification = {**n.verification, "visual": {}}
    _audit(db, user, "preview_verdict", n.id,
           {"accepted": bool(accepted), "pr": n.pr_number, "commit": commit, "comment": comment[:200],
            "proof": where != "On The Preview"})
    _sync_session(db, _session(db, n.session_id))
    db.commit()
    if accepted:
        # Not merged yet: the case waits as a draft until mark_fixed_for_pr.
        promote_regression(db, n, user, status="draft")
    else:
        # In the cloud nothing is listening: the reopen starts Claude Code again on the same branch.
        _cloud_start(db, [n], sent_by(n))
    db.refresh(n)
    return _serialize(n, _viewer(user, db))


# ── regression tests ──────────────────────────────────────────────────────────
_STEP_VERB = {"click": "Click", "input": "Fill", "nav": "Open", "key": "Press", "scroll": "Scroll"}


def _regression_ready(n: DevNote) -> bool:
    """A bug whose repro is an e2e spec (titled `[<pin id>] ...`) that failed
    before the fix and passes after it."""
    repro = (n.verification or {}).get("repro") if isinstance(n.verification, dict) else None
    if n.kind != "bug" or not isinstance(repro, dict):
        return False
    return (repro.get("kind") == "e2e" and repro.get("before") == "failing"
            and repro.get("after") == "passing" and f"[{n.id}]" in str(repro.get("script") or ""))


def _qa_module(route: str) -> str:
    key = (route or "").strip().lower()
    return QA_MODULE_FOR_ROUTE.get(key) or QA_MODULE_FOR_ROUTE.get(key.replace("-", "").replace("_", "")) or "Other"


def _steps(n: DevNote) -> list:
    out = []
    for a in n.actions or []:
        if not isinstance(a, dict):
            continue
        label = " ".join(str(a.get("label") or "").split())[:200]
        if not label:
            continue
        verb = _STEP_VERB.get(str(a.get("type") or ""), "")
        out.append(f"{verb} {label}" if verb else label)
    return out[-30:]


def _pr_summary(n: DevNote) -> str:
    """The summary Claude Code gave with `complete` ("PR #n Open: <summary>"),
    from the newest such entry."""
    for e in reversed(n.thread or []):
        if not isinstance(e, dict):
            continue
        text = str(e.get("text") or "")
        if e.get("kind") == "system" and text.startswith("PR #") and " Open" in text:
            return text.split(": ", 1)[1].strip() if ": " in text else ""
    return ""


def promote_regression(db: Session, n: DevNote, user: dict, status: str = "active") -> None:
    """An accepted bug whose e2e repro went failing -> passing joins the
    Testing module's suite: a QaTestCase with id = the pin id, run nightly by
    the qa-e2e workflow (it reads `active` cases only). A preview Accept comes
    before the merge, so it writes the case as `draft` - the fix is not on dev
    yet - and mark_fixed_for_pr turns it `active`; the post-merge Accept writes
    it `active`. Called AFTER the verdict is committed, so a failure here rolls
    back only its own changes - it never raises into the request. Idempotent:
    an active (or archived) case is left alone, a draft is refreshed."""
    try:
        if not _regression_ready(n):
            return
        case = db.query(QaTestCase).filter(QaTestCase.id == n.id).first()
        if case and case.status != "draft":
            return
        if n.regression_case_id and not case:
            return   # the Testing module removed it: do not bring it back
        from routers import qa as _qa   # module attribute: tests patch _qa._ENABLED
        if not case and not _qa._ENABLED:
            if not any(isinstance(e, dict) and e.get("text") == REGRESSION_OFF for e in n.thread or []):
                _append(n, _entry("claude", "system", REGRESSION_OFF))
                db.commit()
            return
        new = case is None
        repro = n.verification["repro"]
        comment = " ".join((n.comment or "").split())
        summary = _pr_summary(n)
        expected = f"Fixed by PR #{n.pr_number}" if n.pr_number else "Fixed"
        if summary:
            expected += f": {summary}"
        now = _now()
        if new:
            case = QaTestCase(id=n.id, created_at=now)
            db.add(case)
        case.module = _qa_module(n.route)
        case.feature = (n.route or "") + (f" > {n.sub}" if n.sub else "")
        case.title = f"Pin #{n.number} - {comment[:80].strip()}" if comment else f"Pin #{n.number}"
        case.precondition = ""
        case.steps = _steps(n)
        case.expected = expected[:2000]
        case.priority = QA_PRIORITY.get(n.priority or "", "Medium")
        case.case_type = "Regression"
        case.source = "build-mode"
        case.status = "active" if status == "active" else "draft"
        case.e2e_spec = str(repro.get("script") or "")[:E2E_SPEC_MAX]
        case.created_by = n.created_by or ""
        case.updated_at = now
        n.regression_case_id = n.id
        if case.status == "active":
            _append(n, _entry("claude", "system", REGRESSION_ADDED))
        elif new:
            _append(n, _entry("claude", "system", REGRESSION_READY))
        _audit(db, user, "regression", n.id, {"case": n.id, "module": case.module, "status": case.status})
        db.commit()
    except Exception as exc:  # noqa: BLE001 - see docstring
        db.rollback()
        print(f"[build-mode] promote_regression({getattr(n, 'id', '?')}) failed: {exc}")


def _activate_regression(db: Session, n: DevNote) -> None:
    """The PR merged: the pin's draft regression case (written at a preview
    Accept) joins the suite. No commit - mark_fixed_for_pr commits."""
    if not n.regression_case_id:
        return
    case = db.query(QaTestCase).filter(QaTestCase.id == n.regression_case_id).with_for_update().first()
    if case and case.status == "draft":
        case.status = "active"
        case.updated_at = _now()
        _append(n, _entry("claude", "system", REGRESSION_ADDED))


# ── CLI ───────────────────────────────────────────────────────────────────────
def _answered(thread) -> bool:
    """The last thread entry is a human comment (the author answered Claude)."""
    if not thread:
        return False
    last = thread[-1] if isinstance(thread[-1], dict) else {}
    return last.get("kind") == "comment" and (last.get("by") or "") != "claude"


def _last_human_comment(n: DevNote) -> bool:
    return _answered(n.thread or [])


def sent_by(n) -> str:
    """Whose Claude Code a pin belongs to: whoever sent it; a pin sent before
    dispatched_by existed belongs to its author."""
    return ((getattr(n, "dispatched_by", "") or "") or (n.created_by or "")).lower()


def _pending_ids(db: Session, email: str, cloud: bool = False) -> list:
    """Ids of the pins THIS person's Claude Code should pick up (Pranshu,
    Oct 26: several watchers run at once - Neil's, Visesh's, mine - and a pin
    must never land in someone else's terminal): the ones they sent, plus pins
    Claude was waiting on whose author has answered. A claim clears the second
    kind by appending its own entry. Cheap on purpose - this runs every 2 s
    per waiting watcher - so only these columns are read."""
    email = (email or "").lower()
    # A pin sent to Claude Code in the cloud is started there (_cloud_start):
    # a terminal watcher that is also running must never pick it up, or two
    # Claude Codes work one pin. `cloud=True` (Start Claude Code) reads all.
    where = () if cloud else (or_(DevNote.dispatch_target != "cloud", DevNote.dispatch_target.is_(None)),)
    rows = (db.query(DevNote.id, DevNote.status, DevNote.thread, DevNote.dispatched_by, DevNote.created_by)
            .filter(*where, DevNote.status.in_(("dispatched", "needs_input", "building")),
                    or_(func.lower(DevNote.dispatched_by) == email,
                        and_(or_(DevNote.dispatched_by == "", DevNote.dispatched_by.is_(None)),
                             func.lower(DevNote.created_by) == email)))
            .order_by(DevNote.created_at.asc()).all())
    return [r.id for r in rows if r.status == "dispatched" or _answered(r.thread or [])]


def _pending(db: Session, email: str, cloud: bool = False) -> list:
    ids = _pending_ids(db, email, cloud)
    if not ids:
        return []
    rows = db.query(DevNote).filter(DevNote.id.in_(ids)).all()
    order = {i: k for k, i in enumerate(ids)}
    return sorted(rows, key=lambda n: order.get(n.id, 0))


def _poll_pending(email: str) -> tuple:
    """One poll on its own short-lived session (called in a thread); the full
    rows are loaded and serialized only on a hit."""
    db = database.SessionLocal()
    try:
        notes = _pending(db, email)
        if not notes:
            return [], []
        sids = {n.session_id for n in notes if n.session_id}
        sessions = db.query(DevNoteSession).filter(DevNoteSession.id.in_(sids)).all() if sids else []
        return [_serialize(n) for n in notes], [_serialize_session(s) for s in sessions]
    finally:
        db.close()


@router.get("/cli/wait")
async def cli_wait(timeout: int = Query(25, ge=0, le=WAIT_MAX_SEC),
                   user: dict = Depends(require_build_mode_or_token), db: Session = Depends(get_db)):
    """Long poll: returns at once when a pin the caller sent is waiting, else
    polls every 2 s up to `timeout` and returns empty lists. Every query runs
    in a thread and the sleep is asyncio's - nothing here may block the event loop."""
    await asyncio.to_thread(db.close)   # give the pooled connection back for the wait
    email = (user.get("email") or "").lower()
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        notes, sessions = await asyncio.to_thread(_poll_pending, email)
        remaining = deadline - loop.time()
        if notes or remaining <= 0:
            return {"notes": notes, "sessions": sessions}
        await asyncio.sleep(min(WAIT_POLL_SEC, remaining))


@router.get("/cli/whoami")
def cli_whoami(user: dict = Depends(require_build_mode_or_token), db: Session = Depends(get_db)):
    return {"email": user["email"], "tokenLabel": user.get("token_label") or "",
            "onePr": bool(_settings(db, user["email"]).get("onePr"))}


@router.post("/cli/claim")
def cli_claim(body: dict, user: dict = Depends(require_build_mode_or_token), db: Session = Depends(get_db)):
    ids = _ids(body)
    if not ids:
        raise HTTPException(400, "noteIds is required")
    notes, skipped = _batch(db, ids, ("dispatched", "needs_input", "building"), "cannot be claimed", skip_held=True,
                            sent_to=(user.get("email") or "").lower())
    now = _now()
    out = []
    touched = []
    for n in notes:
        if n.status == "dispatched":
            # Only the first pick-up sets the progress line; a re-claim of a
            # building or answered pin keeps whatever Claude last reported.
            n.progress = PICKED_UP
            n.progress_at = now
        n.status = "building"
        n.updated_at = now
        # The entry is what takes the pin out of the wait set (the last entry
        # is no longer the author's comment) - one is enough; a re-claim right
        # after another must not stack them.
        last = (n.thread or [{}])[-1]
        if not (last.get("kind") == "progress" and last.get("text") == PICKED_UP):
            _append(n, _entry("claude", "progress", PICKED_UP))
        s = _session(db, n.session_id)
        if s and s not in touched:
            touched.append(s)
    for s in touched:
        s.status = "building"
        _sync_session(db, s)
    _audit(db, user, "claim", ",".join(n.id for n in notes)[:200],
           {"notes": [n.id for n in notes], "skipped": [x["id"] for x in skipped],
            "token": user.get("token_label") or ""})
    db.commit()
    me = _viewer(user, db)
    for n in notes:
        db.refresh(n)
        out.append({**_serialize(n, me), "media": _media(n)})
    return {"notes": out, "sessions": [_serialize_session(s) for s in touched], "skipped": skipped}


def _batch(db: Session, ids: list, eligible: tuple, verb: str, skip_held: bool = False, sent_to: str = "") -> tuple:
    """The pins of a CLI batch that can take the step, plus `skipped`
    [{id, number, status, reason}] for the rest. Per pin on purpose: one
    dismissed pin in a batch must not stop the PR being recorded on the others.
    404 only when NO id exists, 409 only when NONE is eligible. `skip_held`
    also skips pins held for another developer (code_owners.py); `sent_to`
    (claim) skips pins someone else sent - they belong to that person's Claude Code."""
    wanted = list(dict.fromkeys(ids))
    rows = {n.id: n for n in db.query(DevNote).filter(DevNote.id.in_(wanted)).with_for_update().all()}
    if not rows:
        raise HTTPException(404, "Pin not found")
    notes, skipped = [], []
    for i in wanted:
        n = rows.get(i)
        if n is None:
            skipped.append({"id": i, "number": 0, "status": "", "reason": "Pin not found"})
        elif skip_held and _held(n):
            skipped.append({"id": i, "number": n.number or 0, "status": n.status,
                            "reason": f"{_waits_for(n)} - it is in their area"})
        elif sent_to and sent_by(n) != sent_to:
            skipped.append({"id": i, "number": n.number or 0, "status": n.status,
                            "reason": f"Pin #{n.number} was sent to {_name_of(db, sent_by(n))}'s Claude Code, not yours"})
        elif n.status not in eligible:
            skipped.append({"id": i, "number": n.number or 0, "status": n.status,
                            "reason": f"Pin #{n.number} is {n.status} and {verb}"})
        else:
            notes.append(n)
    if not notes:
        raise HTTPException(409, skipped[0]["reason"] if len(skipped) == 1
                            else f"None of the {len(skipped)} pins can take this step: " + "; ".join(x["reason"] for x in skipped)[:400])
    return notes, skipped


@router.post("/cli/progress/{note_id}")
def cli_progress(note_id: str, body: dict, user: dict = Depends(require_build_mode_or_token),
                 db: Session = Depends(get_db)):
    n = _note(db, note_id, lock=True)
    text = " ".join(str(_get(body, "text") or "").split())[:300]
    if not text:
        raise HTTPException(400, "text is required")
    n.progress = text
    n.progress_at = _now()
    _append(n, _entry("claude", "progress", text))
    db.commit()
    db.refresh(n)
    return _serialize(n, _viewer(user, db))


@router.post("/cli/reply/{note_id}")
def cli_reply(note_id: str, body: dict, user: dict = Depends(require_build_mode_or_token),
              db: Session = Depends(get_db)):
    n = _note(db, note_id, lock=True)
    text = str(_get(body, "text") or "").strip()
    image_url = _check_media("imageUrl", _get(body, "imageUrl") or "")
    if not text and not image_url:
        raise HTTPException(400, "text is required")
    needs_input = bool(_get(body, "needsInput") or False)
    answered = bool(_get(body, "answered") or False)
    if needs_input and answered:
        raise HTTPException(400, "A reply is either needsInput or answered, not both")
    _append(n, _entry("claude", "claude", text, image_url))
    if needs_input:
        if n.status not in ("building", "dispatched", "needs_input"):
            raise HTTPException(409, f"Pin #{n.number} is {n.status} - Claude is not working on it")
        n.status = "needs_input"
        excerpt = text.replace("\n", " ")[:160]
        _notify(db, type="dev_note_reply", recipient=n.created_by,
                title=f"Claude Replied On Pin #{n.number}",
                body=f"Claude Code needs your answer on Pin #{n.number} ({n.route or 'app'}): {excerpt}",
                ref_id=n.id)
    elif answered:
        if n.status not in ("building", "dispatched", "needs_input"):
            raise HTTPException(409, f"Pin #{n.number} is {n.status} - Claude is not working on it")
        _close(n, "done")
        n.verified_by = "claude"
        n.verified_at = _now()
    _sync_session(db, _session(db, n.session_id))
    db.commit()
    db.refresh(n)
    return _serialize(n, _viewer(user, db))


def _verification_summary(v: dict) -> str:
    parts = []
    repro = v.get("repro") or {}
    if repro:
        parts.append(f"Repro: {repro.get('before', 'skipped')} -> {repro.get('after', 'skipped')}.")
    style = v.get("styleCheck") or {}
    if style:
        checks = style.get("checks") or []
        ok = sum(1 for c in checks if isinstance(c, dict) and c.get("ok"))
        word = "passed" if style.get("passed") else "failed"
        parts.append(f"Style check {word} {ok}/{len(checks)}." if checks else f"Style check {word}.")
    visual = v.get("visual") or {}
    if visual.get("beforeUrl") or visual.get("afterUrl"):
        parts.append("Before and after shots attached.")
    return " ".join(parts) or "Verification recorded."


@router.post("/cli/verify/{note_id}")
def cli_verify(note_id: str, body: dict, user: dict = Depends(require_build_mode_or_token),
               db: Session = Depends(get_db)):
    """What Claude Code checked before opening the PR: a repro script and its
    result before and after, the style check against the pin's Edit In Place
    values, and before / after shots. Stored on the pin, summarized in the thread."""
    n = _note(db, note_id, lock=True)
    v = dict(n.verification or {})
    repro = _get(body, "repro")
    if repro is not None:
        if not isinstance(repro, dict):
            raise HTTPException(400, "repro must be an object")
        before, after = repro.get("before", "skipped"), repro.get("after", "skipped")
        if before not in REPRO_RESULTS or after not in REPRO_RESULTS:
            raise HTTPException(400, "repro.before and repro.after must be failing, passing or skipped")
        kind = repro.get("kind") or "python"
        if kind not in REPRO_KINDS:
            raise HTTPException(400, "repro.kind must be e2e or python")
        v["repro"] = {"script": str(repro.get("script") or "")[:E2E_SPEC_MAX], "before": before, "after": after,
                      "kind": kind}
    style = _get(body, "styleCheck")
    if style is not None:
        if not isinstance(style, dict) or not isinstance(style.get("checks", []), list):
            raise HTTPException(400, "styleCheck must be {passed, checks: []}")
        checks = [{"prop": str(c.get("prop") or ""), "expected": str(c.get("expected") or ""),
                   "actual": str(c.get("actual") or ""), "ok": bool(c.get("ok"))}
                  for c in style.get("checks", []) if isinstance(c, dict)]
        v["styleCheck"] = {"passed": bool(style.get("passed")), "checks": checks}
    visual = _get(body, "visual")
    if visual is not None:
        if not isinstance(visual, dict):
            raise HTTPException(400, "visual must be {beforeUrl, afterUrl}")
        v["visual"] = {**{k: u for k, u in (v.get("visual") or {}).items() if k == "clipUrl"},   # a clip attached earlier stays
                       "beforeUrl": _check_media("beforeUrl", _get(visual, "beforeUrl") or ""),
                       "afterUrl": _check_media("afterUrl", _get(visual, "afterUrl") or "")}
    if all(x is None for x in (repro, style, visual)):
        raise HTTPException(400, "Nothing to record: send repro, styleCheck or visual")
    v["at"] = _now()
    n.verification = v
    summary = _verification_summary(v)
    _append(n, _entry("claude", "system", summary))
    _audit(db, user, "verify", n.id, {"summary": summary})
    db.commit()
    db.refresh(n)
    return _serialize(n, _viewer(user, db))


@router.post("/cli/attach/{note_id}")
def cli_attach(note_id: str, file: UploadFile = File(...), kind: str = Form("paste"),
               user: dict = Depends(require_build_mode_or_token), db: Session = Depends(get_db)):
    if kind not in ATTACH_KINDS:
        raise HTTPException(400, "kind must be after, before, paste or clip")
    n = _note(db, note_id, lock=True)
    if kind == "clip":
        # A short video of the fix working (11/12/2026): proof the author can
        # watch on the pin. WebM (what the browser test tool records) or MP4.
        data = file.file.read(CLIP_MAX_BYTES + 1)
        if not data:
            raise HTTPException(400, "Empty file")
        if len(data) > CLIP_MAX_BYTES:
            raise HTTPException(413, "A clip must be 25 MB or smaller")
        content_type = _sniff_clip(data)
        if not content_type:
            raise HTTPException(400, "Only WebM and MP4 clips can be attached")
        url = _upload_bytes(n.id, kind, data, content_type)
        v = dict(n.verification or {})
        v["visual"] = {**(v.get("visual") or {}), "clipUrl": url}
        v["at"] = _now()
        n.verification = v
        _append(n, _entry("claude", "system", "A clip of the fix is attached."))
        n.updated_at = _now()
        db.commit()
        return {"url": url}
    data = file.file.read(ATTACH_MAX_BYTES + 1)
    if not data:
        raise HTTPException(400, "Empty file")
    if len(data) > ATTACH_MAX_BYTES:
        raise HTTPException(413, "Images must be 8 MB or smaller")
    content_type = _sniff_image(data, file.content_type or "")
    if not content_type:
        raise HTTPException(400, "Only PNG, JPEG and WebP images can be attached")
    url = _upload_bytes(n.id, kind, data, content_type)
    n.attachments = [*(n.attachments or []), url]
    if kind == "after":
        _append(n, _entry("claude", "claude", "After:", url))
    n.updated_at = _now()
    db.commit()
    return {"url": url}


@router.post("/cli/complete")
def cli_complete(body: dict, user: dict = Depends(require_build_mode_or_token), db: Session = Depends(get_db)):
    ids = _ids(body)
    if not ids:
        raise HTTPException(400, "noteIds is required")
    pr_url = str(_get(body, "prUrl") or "").strip()
    branch = str(_get(body, "branch") or "").strip()
    summary = str(_get(body, "summary") or "").strip()
    try:
        pr_number = int(_get(body, "prNumber") or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "prNumber must be a number")
    if not pr_url or not pr_number:
        raise HTTPException(400, "prUrl and prNumber are required")
    notes, skipped = _batch(db, ids, ("building", "needs_input"), "cannot be completed - only a pin being built can")
    now = _now()
    touched = []
    for n in notes:
        n.status = "pr_open"
        n.pr_url = pr_url
        n.pr_number = pr_number
        n.branch = branch
        n.updated_at = now
        # A new round (e.g. after Reopen on the preview): the old preview and
        # its verdict are gone; the skill restarts the preview next.
        n.preview = {}
        n.preview_verdict = ""
        n.preview_verdict_at = ""
        _append(n, _entry("claude", "system", f"PR #{pr_number} Open" + (f": {summary}" if summary else ""), ""))
        s = _session(db, n.session_id)
        if s and s not in touched:
            touched.append(s)
    for s in touched:
        s.status = "pr_open"
        s.pr_url = pr_url
        s.pr_number = pr_number
        s.branch = branch
        s.updated_at = now
        _notify(db, type="dev_note_pr", recipient=s.created_by,
                title=f"PR #{pr_number} Open For Build Session '{s.title or 'Build Session'}'",
                body=f"Claude Code opened PR #{pr_number} for {len([x for x in notes if x.session_id == s.id])} pin(s). {pr_url}",
                ref_id=s.id, ref_kind="session")
    # New commits on the PR branch: an Accept given on the old preview no
    # longer covers what will merge - on every pin of the PR, not just these.
    _reset_accepted(db, pr_number, exclude=[n.id for n in notes])
    db.commit()
    me = _viewer(user, db)
    for n in notes:
        db.refresh(n)
    return {"notes": [_serialize(n, me) for n in notes],
            "session": _serialize_session(touched[0]) if touched else None,
            "sessions": [_serialize_session(s) for s in touched],
            "skipped": skipped}


def _reset_accepted(db: Session, pr_number: int, exclude=(), commit: str = "") -> list:
    """The PR branch changed after an Accept on the preview: every pin of that
    PR whose verdict is accepted is Ready To Check again (verdict and its
    verified stamp cleared, one entry saying why). With `commit`, only the
    Accepts recorded against a different commit are reset (one recorded with
    no commit cannot be compared and stands). Returns the pins reset."""
    if not pr_number:
        return []
    q = db.query(DevNote).filter(DevNote.pr_number == pr_number, DevNote.status == "pr_open",
                                 DevNote.preview_verdict == "accepted")
    if exclude:
        q = q.filter(DevNote.id.notin_(list(exclude)))
    rows = q.with_for_update().all()
    if commit:
        rows = [n for n in rows if (n.preview or {}).get("verdictCommit") not in ("", None, commit)]
    for n in rows:
        n.preview_verdict = ""
        n.preview_verdict_at = ""
        n.verified_by = ""
        n.verified_at = ""
        _append(n, _entry("claude", "system", BRANCH_CHANGED))
    return rows


def _check_preview_url(url: str) -> str:
    """Only a local preview: http://localhost:<port>/... or
    http://127.0.0.1:<port>/... - never an outside link. Parsed, not just
    prefix-matched, so "http://localhost:@evil.example" is refused too."""
    url = str(url or "").strip()
    bad = HTTPException(400, "url must be a local preview (http://localhost:<port> or http://127.0.0.1:<port>)")
    if not url or len(url) > 1000 or not url.startswith(("http://localhost:", "http://127.0.0.1:")):
        raise bad
    try:
        p = urlparse(url)
        port = p.port
    except ValueError:
        raise bad
    if p.scheme != "http" or p.hostname not in PREVIEW_HOSTS or not port or p.username or p.password or "@" in p.netloc:
        raise bad
    return url


@router.post("/cli/preview/{note_id}")
def cli_preview(note_id: str, body: dict, user: dict = Depends(require_build_mode_or_token),
                db: Session = Depends(get_db)):
    """tools/build_notes/preview.py started the PR branch on this machine:
    the pin turns Ready To Check with an Open Preview link (status stays
    pr_open). Posting again (a restarted preview) replaces it. `commit` (the
    branch head the preview runs) is optional; a post whose commit differs
    from the stored one means the branch moved, so every Accept on that PR is
    reset (`_reset_accepted`) - the author checks the new code again."""
    n = _note(db, note_id, lock=True)
    if n.status != "pr_open":
        raise HTTPException(409, f"Pin #{n.number} is {n.status}, not PR Open - only a pin with an open PR has a preview")
    url = _check_preview_url(_get(body, "url"))
    try:
        pr_number = int(_get(body, "prNumber") or n.pr_number or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "prNumber must be a number")
    host = " ".join(str(_get(body, "host") or "").split())[:200]
    commit = str(_get(body, "commit") or "").strip()[:64]
    if commit and not re.fullmatch(r"[0-9a-fA-F]{7,64}", commit):
        raise HTTPException(400, "commit must be a git sha")
    old = dict(n.preview or {})
    first = not old.get("url")
    n.preview = {"url": url, "branch": str(_get(body, "branch") or n.branch or "").strip()[:200],
                 "prNumber": pr_number, "host": host, "commit": commit.lower(), "startedAt": _now()}
    n.updated_at = _now()
    if first:
        _append(n, _entry("claude", "system", "Ready To Check" + (f" - runs on {host}" if host else "")))
    commit = commit.lower()
    if "verdictCommit" in old:
        n.preview = {**n.preview, "verdictCommit": old["verdictCommit"]}
    moved = bool(commit) and bool(old.get("commit")) and old.get("commit") != commit
    if moved:
        _reset_accepted(db, n.pr_number)            # this pin's preview moved: every Accept on the PR
    elif commit:
        _reset_accepted(db, n.pr_number, commit=commit)   # Accepts given on another commit
    _audit(db, user, "preview", n.id, {"url": url, "host": host, "pr": pr_number, "commit": commit,
                                       "branchMoved": moved, "token": user.get("token_label") or ""})
    db.commit()
    db.refresh(n)
    return _serialize(n, _viewer(user, db))


@router.delete("/cli/preview/{note_id}", status_code=204)
def cli_preview_stop(note_id: str, user: dict = Depends(require_build_mode_or_token),
                     db: Session = Depends(get_db)):
    """preview.py stopped (or is replacing) the running preview: the Open
    Preview link would be dead, so the pin is no longer Ready To Check. An
    accepted verdict stays - that pin was already checked - with its
    `verdictCommit`. Idempotent: a pin with no running preview (no url) is
    left exactly as it is."""
    n = _note(db, note_id, lock=True)
    old = dict(n.preview or {})
    if not old.get("url"):
        return Response(status_code=204)
    was_ready = _ready_to_check(n)
    # An accepted verdict keeps the commit it was given against, so a later
    # commit change on the PR still resets it (no url: never Ready To Check).
    keep = n.preview_verdict == "accepted" and "verdictCommit" in old
    n.preview = {"verdictCommit": old["verdictCommit"]} if keep else {}
    n.updated_at = _now()
    if was_ready:
        _append(n, _entry("claude", "system", "Preview stopped - it comes back when Claude Code restarts it"))
    _audit(db, user, "preview", n.id, {"stopped": True, "token": user.get("token_label") or ""})
    db.commit()
    return Response(status_code=204)


# ── GitHub webhook hook ───────────────────────────────────────────────────────
def mark_fixed_for_pr(db: Session, pr_number, merge_sha: str = "") -> int:
    """A PR merged into dev: every pr_open pin on it becomes fixed, with the
    merge commit as its fixed build, a "Merged To Dev" entry and a bell to its
    author - except a pin its author already accepted on the Ready To Check
    preview, which goes straight to done with no bell (and its draft
    regression case joins the suite). A pin on the PR that was sent back for
    rework (building / needs_input) keeps its status but loses the PR: its
    rework comes in a new PR, and its author gets a bell saying so. Returns
    how many pins changed. Never raises - the webhook must keep answering
    GitHub whatever happens here."""
    try:
        number = int(pr_number)
    except (TypeError, ValueError):
        return 0
    if not number:
        return 0
    try:
        notes = (db.query(DevNote)
                 .filter(DevNote.pr_number == number,
                         DevNote.status.in_(("pr_open", "building", "needs_input")))
                 .with_for_update().all())
        if not notes:
            return 0
        now = _now()
        sessions, rework_sessions = [], []
        for n in notes:
            n.updated_at = now
            if n.status != "pr_open":
                # Merged mid-rework: what merged is not this pin's fix.
                n.pr_number = 0
                n.pr_url = ""
                n.branch = ""
                n.preview = {}
                n.preview_verdict = ""
                n.preview_verdict_at = ""
                note = _entry("claude", "system",
                              f"PR #{number} merged while this pin was being reworked - the rework comes in a new PR")
                thread = list(n.thread or [])
                if _answered(thread):
                    # The author's comment must stay LAST: it is what keeps the
                    # pin in /cli/wait until Claude Code picks the rework up.
                    n.thread = [*thread[:-1], note, thread[-1]]
                else:
                    _append(n, note)
                _notify(db, type="dev_note_rework", recipient=n.created_by,
                        title=f"Pin #{n.number} Needs A New PR",
                        body=(f"PR #{number} merged to dev while Claude Code was reworking Pin #{n.number} "
                              f"({n.route or 'app'}). The rework comes in a new PR."),
                        ref_id=n.id)
                if n.session_id and n.session_id not in rework_sessions:
                    rework_sessions.append(n.session_id)
                continue
            n.fixed_build_id = merge_sha or ""
            n.fixed_at = now
            if (n.preview_verdict or "") == "accepted":
                # Checked on the Ready To Check preview: no second check after merge.
                _close(n, "done")
                _append(n, _entry("claude", "system", "Merged To Dev - checked on the preview before merge"))
                _activate_regression(db, n)
                if n.session_id and n.session_id not in sessions:
                    sessions.append(n.session_id)
                continue
            n.status = "fixed"
            _append(n, _entry("claude", "system", "Merged To Dev"))
            _notify(db, type="dev_note_fixed", recipient=n.created_by,
                    title=f"Pin #{n.number} Fixed - Verify",
                    body=f"PR #{number} merged to dev. Open {n.route or 'the app'} and confirm Pin #{n.number} is fixed, or reopen it.",
                    ref_id=n.id)
            if n.session_id and n.session_id not in sessions:
                sessions.append(n.session_id)
        for sid in sessions:
            s = _session(db, sid)
            if s:
                s.status = "fixed"
                s.updated_at = now
                _sync_session(db, s)
        for sid in rework_sessions:
            if sid not in sessions:
                _sync_session(db, _session(db, sid))
        db.commit()
        return len(notes)
    except Exception as exc:  # noqa: BLE001 - see docstring
        db.rollback()
        print(f"[build-mode] mark_fixed_for_pr({pr_number}) failed: {exc}")
        return 0
