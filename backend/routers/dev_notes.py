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
"""
import asyncio
import hashlib
import json
import os
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, Request, Response, UploadFile
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

import auth
import database
from auth import company_of, get_current_user
from database import get_db
from models import AuditLog, DevNote, DevNoteSession, DevNoteToken, NexusNotification, NexusSetting
from routers import files as _files

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
STATS_DAYS = 90
# Screens Build Mode never captures: the client refuses on these views and the
# server refuses a pin that names them (the records behind them are the most
# sensitive in Nexus - CLAUDE.md on PFS and the Credential Vault).
BLOCKED_ROUTES = ("pfs", "credvault")

KINDS = ("bug", "change", "question", "edit")
PRIORITIES = ("blocking", "normal", "nice")
STATUSES = ("open", "dispatched", "building", "needs_input", "pr_open", "fixed", "done", "dismissed")
SESSION_STATUSES = ("collecting", "sent", "building", "pr_open", "fixed", "done")
ATTACH_KINDS = ("after", "paste")
DEFAULT_SETTINGS = {"sendInstantly": False, "dispatchTarget": "local", "pinsOnLoad": True}

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
_DICT_FIELDS = ("viewport", "target", "markup", "edit", "state", "verification")
_LIST_CAPS = {"console_log": 50, "network_log": 30, "actions": 30}
REPRO_RESULTS = ("failing", "passing", "skipped")
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


def _serialize(n: DevNote) -> dict:
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
    return out


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


def _last_human_comment(n: DevNote) -> bool:
    thread = n.thread or []
    if not thread:
        return False
    last = thread[-1]
    return last.get("kind") == "comment" and (last.get("by") or "") != "claude"


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
    if "?" in u or "#" in u or ".." in u or "\\" in u:
        return False
    marker = f"/storage/v1/object/public/{BUCKET}/{MEDIA_PREFIX}"
    base = _storage_base()
    if base:
        prefix = base + marker
        return u.startswith(prefix) and len(u) > len(prefix)
    # Storage not configured (a local backend without Supabase): still only
    # the right shape, so the stored value is one api.js can rewrite.
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
        return _files.fetchable_url(u)
    except Exception:  # noqa: BLE001 - a missing object must not fail the claim
        return ""


def _media(n: DevNote) -> dict:
    attachments = [a for a in (n.attachments or []) if isinstance(a, str) and a]
    after = [a for a in attachments if a.rsplit("/", 1)[-1].startswith("after-")]
    return {
        "screenshot": _signed(n.screenshot_url or ""),
        "pageShot": _signed(n.page_shot_url or ""),
        "video": _signed(n.video_url or ""),
        "contactSheet": _signed(n.contact_sheet_url or ""),
        "attachments": [_signed(a) for a in attachments if a not in after],
        "afterShots": [_signed(a) for a in after],
    }


def _upload_bytes(note_id: str, kind: str, data: bytes, content_type: str) -> str:
    """Upload with the service key (the way files.py signs) and return the
    canonical URL the row stores."""
    base = _storage_base()
    key = os.getenv("SUPABASE_SERVICE_KEY", "")
    if not base or not key:
        raise HTTPException(503, "File storage is not configured on this deployment (SUPABASE_URL / SUPABASE_SERVICE_KEY)")
    ext = _IMAGE_TYPES[content_type]
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


# ── access ────────────────────────────────────────────────────────────────────
def _allowed(user: dict, db: Session) -> bool:
    email = (user.get("email") or "").lower()
    if not email:
        return False
    # Module attributes on purpose (not `from auth import ...`): the tests and
    # any future override patch auth.* and this must see the patch.
    if auth.is_global_admin(user, db):
        return True
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


def _own_or_admin(n_owner: str, user: dict, db: Session, what: str) -> None:
    if (n_owner or "").lower() != (user.get("email") or "").lower() and not _is_ga(user, db):
        raise HTTPException(403, f"Only the author or a Global Admin can {what}")


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
    s = (db.query(DevNoteSession)
         .filter(DevNoteSession.created_by == email, DevNoteSession.status == "collecting")
         .order_by(DevNoteSession.created_at.desc())
         .with_for_update().first())
    if s or not create:
        return s
    now = _now()
    s = DevNoteSession(id=str(uuid.uuid4()), title=(title or "").strip()[:120] or _auto_title(), status="collecting",
                       created_by=email, created_at=now, updated_at=now, note_count=0)
    db.add(s)
    db.flush()
    return s


def _session(db: Session, session_id: str) -> Optional[DevNoteSession]:
    if not session_id:
        return None
    return db.query(DevNoteSession).filter(DevNoteSession.id == session_id).first()


def _sync_session(db: Session, s: Optional[DevNoteSession]) -> None:
    """note_count and the statuses that follow the pins: done when every pin
    is done or dismissed, building when any pin is being worked on. sent,
    pr_open and fixed are set by the step that causes them."""
    if not s:
        return
    db.flush()   # autoflush is off: count what this request just wrote too
    rows = db.query(DevNote.status).filter(DevNote.session_id == s.id).all()
    statuses = [r[0] for r in rows]
    s.note_count = len(statuses)
    if statuses and all(x in ("done", "dismissed") for x in statuses):
        s.status = "done"
    elif s.status == "done":
        s.status = "fixed" if any(x == "fixed" for x in statuses) else "sent"
    if any(x in ("building", "needs_input") for x in statuses) and s.status not in ("collecting",):
        s.status = "building"
    s.updated_at = _now()


def _dispatch_notes(db: Session, notes: list, by: str) -> list:
    """Mark pins dispatched and their sessions sent."""
    now = _now()
    touched = []
    for n in notes:
        if n.status != "open":
            raise HTTPException(409, f"Pin #{n.number} is {n.status}, not open - only open pins can be sent")
        if n.dispatch_target == "github":
            raise HTTPException(400, "GitHub dispatch is not available yet")
        n.status = "dispatched"
        n.dispatched_at = now
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
    return {"enabled": True, "settings": _settings(db, user["email"]), "blockedRoutes": list(BLOCKED_ROUTES)}


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
        if target != "local":
            raise HTTPException(400, "dispatchTarget must be local")
        current["dispatchTarget"] = target
    for key in ("sendInstantly", "pinsOnLoad"):
        v = _get(body, key)
        if v is not None:
            current[key] = bool(v)
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


@router.post("/", status_code=201)
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
    _audit(db, user, "create", n.id, {"kind": n.kind, "route": n.route, "session": s.id}, kind="create")
    if settings.get("sendInstantly"):
        db.flush()
        _dispatch_notes(db, [n], email)
        _audit(db, user, "dispatch", n.id, {"session": s.id, "instant": True})
    else:
        _sync_session(db, s)
    db.commit()
    db.refresh(n)
    return _serialize(n)


@router.get("/")
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
    return [_serialize(n) for n in rows]


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
    return [_serialize(n) for n in q.order_by(DevNote.created_at.asc()).all()]


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
                 .with_for_update().all())
        if not notes:
            raise HTTPException(400, "No open pins to send")
    for n in notes:
        _own_or_admin(n.created_by, user, db, "send this pin")
    if title and s:
        s.title = str(title).strip()[:200]
    touched = _dispatch_notes(db, notes, email)
    _audit(db, user, "dispatch", s.id if s else "", {"notes": [n.id for n in notes]})
    db.commit()
    s = s or (touched[0] if touched else None)
    return {"session": _serialize_session(s) if s else None, "notes": [_serialize(n) for n in notes]}


# ── retention ─────────────────────────────────────────────────────────────────
def _media_urls(n: DevNote) -> list:
    urls = [n.screenshot_url, n.page_shot_url, n.video_url, n.contact_sheet_url, *(n.attachments or [])]
    visual = (n.verification or {}).get("visual") or {}
    urls += [visual.get("beforeUrl"), visual.get("afterUrl")]
    return [u for u in urls if isinstance(u, str) and u]


def purge_media(db: Session) -> int:
    """Pins past their purge date (done / dismissed + 30 days): delete every
    media object from storage and blank the URL columns, with a "Media Purged"
    entry. A URL storage would not delete stays for the next run. Returns the
    number of pins purged. No background loop yet - POST /dev-notes/purge
    runs it (a daily loop in main.py's lifespan is the follow-up)."""
    now = _now()
    rows = (db.query(DevNote)
            .filter(DevNote.purge_at != "", DevNote.purge_at <= now,
                    DevNote.status.in_(("done", "dismissed")))
            .with_for_update().all())
    purged = 0
    for n in rows:
        urls = _media_urls(n)
        if not urls:
            continue
        kept = {u for u in urls if not _delete_object(u)}
        for col in MEDIA_FIELDS:
            if getattr(n, col) and getattr(n, col) not in kept:
                setattr(n, col, "")
        n.attachments = [a for a in (n.attachments or []) if a in kept]
        v = dict(n.verification or {})
        visual = dict(v.get("visual") or {})
        if visual:
            v["visual"] = {k: (u if u in kept else "") for k, u in visual.items()}
            n.verification = v
        if len(kept) < len(set(urls)):
            _append(n, _entry("claude", "system", "Media Purged" if not kept else f"Media Purged ({len(kept)} left for the next run)"))
            purged += 1
    db.commit()
    return purged


@router.post("/purge")
def purge(user: dict = Depends(require_build_mode), db: Session = Depends(get_db)):
    if not _is_ga(user, db):
        raise HTTPException(403, "Only a Global Admin can purge Build Mode media")
    n = purge_media(db)
    _audit(db, user, "purge", "", {"purged": n}, kind="delete")
    db.commit()
    return {"purged": n}


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
    return _serialize(_note(db, note_id))


@router.patch("/{note_id}")
def patch_note(note_id: str, body: dict, user: dict = Depends(require_build_mode),
               db: Session = Depends(get_db)):
    n = _note(db, note_id, lock=True)
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
    return _serialize(n)


@router.post("/{note_id}/thread")
def add_thread(note_id: str, body: dict, user: dict = Depends(require_build_mode),
               db: Session = Depends(get_db)):
    n = _note(db, note_id, lock=True)
    text = str(_get(body, "text") or "").strip()
    image_url = _check_media("imageUrl", _get(body, "imageUrl") or "")
    if not text and not image_url:
        raise HTTPException(400, "text is required")
    _append(n, _entry(user["email"].lower(), "comment", text, image_url))
    if n.status == "needs_input":
        n.status = "building"   # Claude was waiting on this answer
    _sync_session(db, _session(db, n.session_id))
    db.commit()
    db.refresh(n)
    return _serialize(n)


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
        if _settings(db, n.created_by).get("sendInstantly"):
            _dispatch_notes(db, [n], email)
    n.updated_at = now
    _sync_session(db, _session(db, n.session_id))
    db.commit()
    db.refresh(n)
    return _serialize(n)


# ── CLI ───────────────────────────────────────────────────────────────────────
def _pending(db: Session) -> list:
    """Pins Claude Code should pick up: dispatched ones, plus pins Claude was
    waiting on whose author has answered (the last thread entry is a human
    comment). A claim clears the second kind by appending its own entry."""
    rows = (db.query(DevNote)
            .filter(DevNote.status.in_(("dispatched", "needs_input", "building")))
            .order_by(DevNote.created_at.asc()).all())
    return [n for n in rows if n.status == "dispatched" or _last_human_comment(n)]


def _poll_pending() -> tuple:
    """One poll on its own short-lived session (called in a thread)."""
    db = database.SessionLocal()
    try:
        notes = _pending(db)
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
    """Long poll: returns at once when a pin is waiting, else polls every 2 s
    up to `timeout` and returns empty lists. Every query runs in a thread and
    the sleep is asyncio's - nothing here may block the event loop."""
    await asyncio.to_thread(db.close)   # give the pooled connection back for the wait
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        notes, sessions = await asyncio.to_thread(_poll_pending)
        remaining = deadline - loop.time()
        if notes or remaining <= 0:
            return {"notes": notes, "sessions": sessions}
        await asyncio.sleep(min(WAIT_POLL_SEC, remaining))


@router.get("/cli/whoami")
def cli_whoami(user: dict = Depends(require_build_mode_or_token)):
    return {"email": user["email"], "tokenLabel": user.get("token_label") or ""}


@router.post("/cli/claim")
def cli_claim(body: dict, user: dict = Depends(require_build_mode_or_token), db: Session = Depends(get_db)):
    ids = _ids(body)
    if not ids:
        raise HTTPException(400, "noteIds is required")
    notes = db.query(DevNote).filter(DevNote.id.in_(ids)).with_for_update().all()
    if len(notes) != len(set(ids)):
        raise HTTPException(404, "Pin not found")
    now = _now()
    out = []
    touched = []
    for n in notes:
        if n.status not in ("dispatched", "needs_input", "building"):
            raise HTTPException(409, f"Pin #{n.number} is {n.status} and cannot be claimed")
        n.status = "building"
        n.progress = "Picked up by Claude Code"
        n.progress_at = now
        n.updated_at = now
        # The entry is what takes the pin out of the wait set (the last entry
        # is no longer the author's comment) - one is enough; a re-claim right
        # after another must not stack them.
        last = (n.thread or [{}])[-1]
        if not (last.get("kind") == "progress" and last.get("text") == n.progress):
            _append(n, _entry("claude", "progress", n.progress))
        s = _session(db, n.session_id)
        if s and s not in touched:
            touched.append(s)
    for s in touched:
        s.status = "building"
        _sync_session(db, s)
    _audit(db, user, "claim", ",".join(n.id for n in notes)[:200],
           {"notes": [n.id for n in notes], "token": user.get("token_label") or ""})
    db.commit()
    for n in notes:
        db.refresh(n)
        out.append({**_serialize(n), "media": _media(n)})
    return {"notes": out, "sessions": [_serialize_session(s) for s in touched]}


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
    return _serialize(n)


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
    return _serialize(n)


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
        v["repro"] = {"script": str(repro.get("script") or "")[:20000], "before": before, "after": after}
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
        v["visual"] = {"beforeUrl": _check_media("beforeUrl", _get(visual, "beforeUrl") or ""),
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
    return _serialize(n)


@router.post("/cli/attach/{note_id}")
def cli_attach(note_id: str, file: UploadFile = File(...), kind: str = Form("paste"),
               user: dict = Depends(require_build_mode_or_token), db: Session = Depends(get_db)):
    if kind not in ATTACH_KINDS:
        raise HTTPException(400, "kind must be after or paste")
    n = _note(db, note_id, lock=True)
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
    notes = db.query(DevNote).filter(DevNote.id.in_(ids)).with_for_update().all()
    if len(notes) != len(set(ids)):
        raise HTTPException(404, "Pin not found")
    now = _now()
    touched = []
    for n in notes:
        if n.status not in ("building", "needs_input"):
            raise HTTPException(409, f"Pin #{n.number} is {n.status} - only a pin being built can be completed")
        n.status = "pr_open"
        n.pr_url = pr_url
        n.pr_number = pr_number
        n.branch = branch
        n.updated_at = now
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
    db.commit()
    for n in notes:
        db.refresh(n)
    return {"notes": [_serialize(n) for n in notes],
            "session": _serialize_session(touched[0]) if touched else None}


# ── GitHub webhook hook ───────────────────────────────────────────────────────
def mark_fixed_for_pr(db: Session, pr_number, merge_sha: str = "") -> int:
    """A PR merged into dev: every pr_open pin on it becomes fixed, with the
    merge commit as its fixed build, a "Merged To Dev" entry and a bell to its
    author. Returns how many pins changed. Never raises - the webhook must
    keep answering GitHub whatever happens here."""
    try:
        number = int(pr_number)
    except (TypeError, ValueError):
        return 0
    if not number:
        return 0
    try:
        notes = (db.query(DevNote)
                 .filter(DevNote.pr_number == number, DevNote.status == "pr_open")
                 .with_for_update().all())
        if not notes:
            return 0
        now = _now()
        sessions = []
        for n in notes:
            n.status = "fixed"
            n.fixed_build_id = merge_sha or ""
            n.fixed_at = now
            n.updated_at = now
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
        db.commit()
        return len(notes)
    except Exception as exc:  # noqa: BLE001 - see docstring
        db.rollback()
        print(f"[build-mode] mark_fixed_for_pr({pr_number}) failed: {exc}")
        return 0
