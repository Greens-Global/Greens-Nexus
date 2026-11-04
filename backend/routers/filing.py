"""Documents > Filing & Sorting (Nov 2026).

The Egnyte filing engine online: scans the #Unsorted staging folders, proposes
a canonical name and destination for each file per filing_rules.py (the
Filing Rulebook distilled from the four naming SOPs), and applies the approved
moves. Rules only - no AI, nothing here touches the AI switch.

Safety model:
- Scan proposes; nothing moves without a person pressing Apply.
- Only "auto" proposals apply: doc class switched on in Rules (manager+),
  full-precision date, unambiguous entity/facility/project, no collision.
- Never deletes, never overwrites: a name collision at the destination is
  demoted to review, not renamed around.
- Every applied move writes ONE audit_logs row (same pattern as PDF Tools) -
  the Audit Log screen shows them under Documents, and the row's details
  carry from/to, which is the undo handle (move it back).
- Egnyte identity: the caller's own OAuth token when per-user OAuth is on
  (Egnyte's folder permissions bound every move), else the shared service
  token gated like the Egnyte module's writes (routers/egnyte.py).

All Egnyte I/O goes through services/egnyte.py - the ONE client.
"""
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import audit_capture
import filing_rules
from auth import get_current_user, require_level
from client_ip import client_ip
from database import get_db
from models import AuditLog, NexusSetting
from routers.egnyte import _browse_token, _call
from services import egnyte as svc

router = APIRouter(prefix="/filing", tags=["Filing & Sorting"])

# Scan and apply are supervisor+, matching the Egnyte module's write gate;
# with per-user OAuth on, Egnyte's own permissions are the real boundary.
require_writer = require_level(2)
# Flipping a doc class to auto-file, or changing what gets scanned, shapes
# the module - manager and up.
require_config = require_level(3)

_SETTING_KEY = "filing.config"
DEFAULT_SCAN_ROOTS = ["/Shared/#Unsorted", "/Shared/#Entities/#Unsorted"]
# Legacy dumps inside the global #Unsorted that the engine must not enter.
SKIP_SUBFOLDERS = {"kyle's old computer", "kyle - pc - documents"}
MAX_SCAN_FILES = 500
MAX_APPLY = 200
# A walked scan sends up to MAX_SCAN_PATHS folders per call and the server
# lists them until SCAN_BUDGET_SEC has passed, handing the rest back as
# `deferred` - so the fixed per-request cost (auth, settings, history) is
# paid once per many folders, and no call can near the browser's 18 s limit.
MAX_SCAN_PATHS = 20
SCAN_BUDGET_SEC = 8.0
_OPS_FACILITY = re.compile(r"^\d\d - (.+)$")


def _load_config(db: Session) -> dict:
    row = db.query(NexusSetting).filter(NexusSetting.key == _SETTING_KEY).first()
    data = {}
    if row and row.value:
        try:
            data = json.loads(row.value)
        except ValueError:
            data = {}
    return {
        "confirmed": {k: bool(v) for k, v in (data.get("confirmed") or {}).items()},
        "scanRoots": [svc.norm(p) for p in (data.get("scanRoots") or DEFAULT_SCAN_ROOTS)],
    }


def _save_config(db: Session, cfg: dict, who: str) -> None:
    row = db.query(NexusSetting).filter(NexusSetting.key == _SETTING_KEY).first()
    value = json.dumps(cfg)
    now = datetime.now(timezone.utc).isoformat()
    if row:
        row.value, row.updated_by, row.updated_at = value, who, now
    else:
        db.add(NexusSetting(key=_SETTING_KEY, value=value, updated_by=who, updated_at=now))
    db.commit()


def _template_rows(confirmed: dict) -> list[dict]:
    rows = []
    for key, tpl in filing_rules.TEMPLATES.items():
        rows.append({
            "key": key, "label": tpl["label"],
            "reviewAlways": bool(tpl.get("review_always")),
            "reviewReason": tpl.get("review_reason", ""),
            "dest": tpl.get("dest", ""), "note": tpl.get("note", ""),
            "confirmed": bool(confirmed.get(key)) and not tpl.get("review_always"),
        })
    return rows


@router.get("/status")
def status(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """What the tab needs to render. Does not 503 when Egnyte is unconfigured -
    unconfigured is a first-class state the UI explains (same as /egnyte/status)."""
    cfg = _load_config(db)
    return {
        "configured": svc.configured(),
        "scanRoots": cfg["scanRoots"],
        "templates": _template_rows(cfg["confirmed"]),
        "mayConfigure": user["level"] >= 3,
    }


class ConfigBody(BaseModel):
    confirmed: dict[str, bool] | None = None
    scanRoots: list[str] | None = None


@router.put("/config")
def put_config(body: ConfigBody, user: dict = Depends(require_config),
               db: Session = Depends(get_db)):
    cfg = _load_config(db)
    if body.confirmed is not None:
        for key, value in body.confirmed.items():
            tpl = filing_rules.TEMPLATES.get(key)
            if tpl is None:
                raise HTTPException(400, f"Unknown document class '{key}'")
            if tpl.get("review_always") and value:
                raise HTTPException(400, f"'{tpl['label']}' always needs a human - it cannot auto-file")
            cfg["confirmed"][key] = bool(value)
    if body.scanRoots is not None:
        roots = [svc.norm(p) for p in body.scanRoots if (p or "").strip()]
        bad = [p for p in roots if not p.startswith("/Shared/")]
        if bad:
            raise HTTPException(400, "Scan folders must be under /Shared")
        if len(roots) > 20:
            raise HTTPException(400, "At most 20 scan folders")
        cfg["scanRoots"] = roots or DEFAULT_SCAN_ROOTS
    _save_config(db, cfg, user["email"])
    return {"ok": True, "scanRoots": cfg["scanRoots"],
            "templates": _template_rows(cfg["confirmed"])}


# Egnyte throttles a per-user OAuth key past a few calls a second (Nov 4: a
# walked scan of a 178-subfolder tree hit it). A throttled or hiccupping call
# is waited out and retried; this router's endpoints are sync, so the sleep
# runs in the worker thread, never on the event loop.
_RETRY_STATUSES = (429, 502, 504)
_RETRY_WAITS = (0.8, 1.6, 3.2)

# Pacing beats retrying: Egnyte's default per-user allowance is about two
# calls a second, and a walk that bursts past it pays 0.8-3.2 s back-offs on
# every throttled call (measured 11/04: ~4 s a folder). Spacing this
# process's calls for one Egnyte identity at least _PACE_SEC apart keeps a
# walk under the limit, so it runs at the limit instead of far below it.
# Per process (each worker paces itself); the client sends one scan at a time.
_PACE_SEC = 0.5
_pace_lock = threading.Lock()
_pace_last: dict = {}
# What this request spent on Egnyte - calls made and seconds spent waiting
# (pacing plus back-offs). Answered by /scan so a slow walk can be read, not
# guessed at. Thread-local: the sync endpoints each run in their own thread.
_meter = threading.local()


def _meter_reset() -> None:
    _meter.calls, _meter.waited, _meter.throttled = 0, 0.0, 0


def _meter_add(calls: int = 0, waited: float = 0.0, throttled: int = 0) -> None:
    _meter.calls = getattr(_meter, "calls", 0) + calls
    _meter.waited = getattr(_meter, "waited", 0.0) + waited
    _meter.throttled = getattr(_meter, "throttled", 0) + throttled


# Folders a scan lists at once, and the shared threads they run on. The
# endpoints are sync (already off the event loop); these are short Egnyte
# HTTP calls, so a small pool is plenty for every request together.
_LANES = 2
_lane_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="filing-lane")


def _list_lane(token, root: str):
    """List one folder on a pool thread. The meter is thread-local, so this
    lane's own counts come back with the result for the request to add up."""
    _meter_reset()
    try:
        outcome = _egnyte(token, svc.list_folder, root)
    except HTTPException as exc:
        outcome = exc
    return root, outcome, _meter.calls, _meter.waited, _meter.throttled


def _pace(token) -> None:
    key = token or "service"
    with _pace_lock:
        now = time.monotonic()
        wait = _pace_last.get(key, 0.0) + _PACE_SEC - now
        _pace_last[key] = max(now, _pace_last.get(key, 0.0) + _PACE_SEC)
    if wait > 0:
        _meter_add(waited=wait)
        time.sleep(wait)


def _egnyte(token, fn, *args):
    """_call, with Egnyte's raw 401 fault turned into words a person can act
    on, calls paced under the per-user rate limit, and throttling that still
    happens waited out. With per-user OAuth there is no refresh (egnyte_oauth
    stores only the access token, which Egnyte expires after ~30 days), so an
    invalid token means one thing: reconnect."""
    for attempt in range(len(_RETRY_WAITS) + 1):
        try:
            _pace(token)
            _meter_add(calls=1)
            return _call(fn, *args, token)
        except HTTPException as exc:
            if exc.status_code == 401:
                raise HTTPException(401, (
                    "Your Egnyte connection has expired. Open the Egnyte module, "
                    "press Connect, then come back and scan again."
                    if token is not None else
                    "Egnyte rejected Nexus's connection. Check the Egnyte module's status screen."))
            if exc.status_code in _RETRY_STATUSES and attempt < len(_RETRY_WAITS):
                _meter_add(waited=_RETRY_WAITS[attempt], throttled=1 if exc.status_code == 429 else 0)
                time.sleep(_RETRY_WAITS[attempt])
                continue
            if exc.status_code == 429:
                raise HTTPException(429, "Egnyte is busy with this many requests - wait a moment and try again.")
            raise


# The maps change when someone reorganizes Egnyte, which is rare. Each one
# costs three Egnyte listings, and a per-process cache was not enough: the
# API runs several workers on two instances, a walk's calls land on any of
# them, and every cold worker re-listed the three index folders in a burst
# that tripped Egnyte's per-user throttle (measured 11/04: 1.2-3.7 s for a
# single small folder). So the maps live in the database for every worker,
# rebuilt at most every _MAPS_TTL_SEC by whichever worker finds them stale,
# with the in-process copy as a first, free layer. Shared across callers
# deliberately: the maps only steer which CONTEXT a suggestion gets, folder
# names of entities and facilities are not secrets to the supervisor+ users
# this router admits, and every actual move still runs under the caller's
# own Egnyte permissions. Only a complete rebuild is shared - a caller who
# cannot see one of the roots never narrows the maps for everyone else.
_MAPS_TTL_SEC = 600
_MAPS_KEY = "filing.maps_cache"
_maps_cache: dict = {"at": 0.0, "maps": None}


def _maps_from(data: dict) -> filing_rules.Maps:
    maps = filing_rules.Maps()
    maps.entities = list(data.get("entities") or [])
    maps.facilities = dict(data.get("facilities") or {})
    maps.projects = dict(data.get("projects") or {})
    return maps


def _live_maps(token: str | None, db: Session | None = None) -> filing_rules.Maps:
    """The entity / facility / project maps, read from the live tree - never
    hardcoded, so an Egnyte re-org does not need a deploy."""
    if _maps_cache["maps"] is not None and time.monotonic() - _maps_cache["at"] < _MAPS_TTL_SEC:
        return _maps_cache["maps"]
    if db is not None:
        row = db.query(NexusSetting).filter(NexusSetting.key == _MAPS_KEY).first()
        if row and row.value:
            try:
                data = json.loads(row.value)
                if time.time() - float(data.get("at") or 0) < _MAPS_TTL_SEC:
                    maps = _maps_from(data)
                    _maps_cache["at"], _maps_cache["maps"] = time.monotonic(), maps
                    return maps
            except (ValueError, TypeError):
                pass
    maps = filing_rules.Maps()
    complete = True
    try:
        folders = _egnyte(token, svc.list_folder, maps.entities_root)["folders"]
        maps.entities = [f["name"] for f in folders if not f["name"].startswith("#")]
    except HTTPException:
        complete = False   # a root the caller cannot see narrows matching, never breaks the scan
    try:
        for f in _egnyte(token, svc.list_folder, "/Shared/--Operations")["folders"]:
            m = _OPS_FACILITY.match(f["name"])
            if m:
                maps.facilities[m.group(1)] = f["path"]
    except HTTPException:
        complete = False
    try:
        for f in _egnyte(token, svc.list_folder, "/Shared/--Development/Projects")["folders"]:
            maps.projects[f["name"]] = f["path"]
    except HTTPException:
        complete = False
    _maps_cache["at"], _maps_cache["maps"] = time.monotonic(), maps
    if complete and db is not None:
        value = json.dumps({"at": time.time(), "entities": maps.entities,
                            "facilities": maps.facilities, "projects": maps.projects})
        try:
            row = db.query(NexusSetting).filter(NexusSetting.key == _MAPS_KEY).first()
            now = datetime.now(timezone.utc).isoformat()
            if row:
                row.value, row.updated_by, row.updated_at = value, "filing-maps", now
            else:
                db.add(NexusSetting(key=_MAPS_KEY, value=value, updated_by="filing-maps", updated_at=now))
            db.commit()
        except Exception:  # noqa: BLE001 - a cache write must never fail a scan
            db.rollback()
    return maps


class ScanBody(BaseModel):
    # Folders ticked in the tab's tree. The CLIENT walks the tree: each call
    # lists only the named folders and answers their subfolder paths, so no
    # single request can run past the browser's 18-second limit however deep
    # the tree goes (the 11/04 lesson: one long request is a 502 waiting to
    # happen). None/empty = the configured #Unsorted staging roots, exactly
    # as before.
    paths: list[str] | None = None


def _filing_history(db: Session, limit: int = 2000) -> list[tuple[set, str, str]]:
    """What people actually filed, from the audit rows apply() writes -
    (name tokens, context subtree, destination folder) per past move.
    Renames teach names, not destinations, so they are left out."""
    rows = (db.query(AuditLog).filter(AuditLog.resource_type == "filing")
            .order_by(AuditLog.id.desc()).limit(limit).all())
    out = []
    for r in rows:
        try:
            d = json.loads(r.details or "{}")
        except ValueError:
            continue
        src, dest = d.get("from") or "", d.get("to") or ""
        if not src or not dest or "/" not in src or "/" not in dest:
            continue
        src_folder, src_name = src.rsplit("/", 1)
        dest_folder = dest.rsplit("/", 1)[0]
        if dest_folder == src_folder:
            continue
        out.append((filing_rules.name_tokens(src_name),
                    filing_rules.context_key(src_folder), dest_folder))
    return out


# The history only grows when someone files, and a walk calls /scan many
# times a minute - one read a minute is plenty, and a minute-old memory of
# where things went suggests just as well.
_HISTORY_TTL_SEC = 60
_history_cache: dict = {"at": 0.0, "rows": None}


def _filing_history_cached(db: Session) -> list[tuple[set, str, str]]:
    if _history_cache["rows"] is not None and time.monotonic() - _history_cache["at"] < _HISTORY_TTL_SEC:
        return _history_cache["rows"]
    rows = _filing_history(db)
    _history_cache["at"], _history_cache["rows"] = time.monotonic(), rows
    return rows


@router.post("/scan")
def scan(body: ScanBody | None = None, user: dict = Depends(require_writer),
         db: Session = Depends(get_db)):
    started = time.monotonic()
    _meter_reset()
    token = _browse_token(user, db)
    cfg = _load_config(db)
    maps = _live_maps(token, db)
    history = _filing_history_cached(db)

    picked = [svc.norm(p) for p in ((body.paths if body else None) or []) if (p or "").strip()]
    if len(picked) > MAX_SCAN_PATHS:
        raise HTTPException(400, f"At most {MAX_SCAN_PATHS} folders per scan call")
    for p in picked:
        if not p.startswith("/Shared"):
            raise HTTPException(400, "Folders to scan must be under /Shared")
    roots = picked or cfg["scanRoots"]

    proposals: list[dict] = []
    scanned, missing, subfolders, failed, deferred = [], [], [], [], []

    def listed_in_lanes():
        """(root, listing or HTTPException) in order, _LANES folders listed at
        once. Measured 11/04: with throttling gone a listing is ~0.85 s of
        pure Egnyte latency, so serial calls started only ~1.2 a second
        while the pacer allows 2 - two lanes close that gap, and the shared
        pacer still spaces every call's START at least _PACE_SEC apart."""
        i = 0
        while i < len(roots):
            # Out of time for this call: the rest go back to the caller's
            # queue. The first lane always runs, so a walk always progresses.
            if picked and i > 0 and time.monotonic() - started > SCAN_BUDGET_SEC:
                deferred.extend(roots[i:])
                return
            lane = roots[i:i + _LANES]
            i += len(lane)
            for root, outcome, calls, waited, throttled in _lane_pool.map(
                    lambda r: _list_lane(token, r), lane):
                _meter_add(calls, waited, throttled)
                yield root, outcome

    for root, outcome in listed_in_lanes():
        if isinstance(outcome, HTTPException):
            exc = outcome
            if exc.status_code in (403, 404):
                missing.append(root)
                continue
            if exc.status_code == 401:
                raise exc
            # One folder Egnyte would not list even after the retries must
            # not sink its siblings - it is answered as failed, by path, and
            # the caller offers to try just those again.
            failed.append(root)
            continue
        listing = outcome
        scanned.append(root)
        # The folder's own path says whose files these are (an entity's
        # subtree, a facility's, a project's) - never guessed from words.
        ctx = filing_rules.path_context(maps, root)
        for sub in listing["folders"]:
            if sub["name"].lower() in SKIP_SUBFOLDERS:
                proposals.append({
                    "sourcePath": sub["path"], "currentName": sub["name"],
                    "status": "skip", "docType": "", "destFolder": "", "newName": "",
                    "rule": "", "reasons": ["legacy dump - left alone"],
                    "canonicalName": "", "labeled": False})
            elif picked:
                subfolders.append(sub["path"])   # the caller's walk continues here
            else:
                proposals.append({
                    "sourcePath": sub["path"], "currentName": sub["name"],
                    "status": "skip", "docType": "", "destFolder": "", "newName": "",
                    "rule": "", "reasons": ["subfolder - tick it in the tree to scan inside"],
                    "canonicalName": "", "labeled": False})
        for f in listing["files"]:
            prop = filing_rules.propose(f["name"], root, ctx, maps, cfg["confirmed"])
            # A fast look at the file itself (Visesh, 11/04: "if somebody is
            # confused") - Egnyte's own full-screen viewer, keyed on group_id.
            prop["previewUrl"] = svc.file_web_url(f.get("groupId") or "")
            # Learned route: where similar files from this subtree were
            # actually filed before (pattern memory, not AI - see
            # filing_rules.suggest_learned).
            if prop["status"] == "review" and not prop["destFolder"] and history:
                hit = filing_rules.suggest_learned(f["name"], root, history)
                if hit:
                    prop["learnedDest"], prop["learnedCount"] = hit
            proposals.append(prop)
            if len(proposals) >= MAX_SCAN_FILES:
                break
        if len(proposals) >= MAX_SCAN_FILES:
            break

    counts = {"auto": 0, "review": 0, "skip": 0}
    # Labeled = the current name already is the one the rulebook would give it;
    # skipped rows (subfolders, placeholders) are not files to label.
    totals = {"files": 0, "labeled": 0, "unlabeled": 0}
    for p in proposals:
        counts[p["status"]] = counts.get(p["status"], 0) + 1
        if p["status"] != "skip":
            totals["files"] += 1
            totals["labeled" if p.get("labeled") else "unlabeled"] += 1
    return {"proposals": proposals, "counts": counts, "totals": totals,
            "scannedRoots": scanned, "missingRoots": missing,
            "subfolders": subfolders, "failedRoots": failed, "deferred": deferred,
            "egnyte": {"calls": getattr(_meter, "calls", 0),
                       "waitedSec": round(getattr(_meter, "waited", 0.0), 2),
                       "throttled": getattr(_meter, "throttled", 0),
                       "tookSec": round(time.monotonic() - started, 2)},
            "truncated": len(proposals) >= MAX_SCAN_FILES}


class MoveBody(BaseModel):
    sourcePath: str = Field(max_length=1024)
    destFolder: str = Field(max_length=1024)
    newName: str = Field(max_length=255)
    docType: str = Field(default="", max_length=64)
    rule: str = Field(default="", max_length=64)


class ApplyBody(BaseModel):
    moves: list[MoveBody]


@router.post("/apply")
def apply(body: ApplyBody, request: Request, user: dict = Depends(require_writer),
          db: Session = Depends(get_db)):
    if not body.moves:
        raise HTTPException(400, "Nothing to move")
    if len(body.moves) > MAX_APPLY:
        raise HTTPException(400, f"At most {MAX_APPLY} moves per batch")
    started = time.monotonic()
    _meter_reset()
    token = _browse_token(user, db)
    cfg = _load_config(db)

    results = []
    deferred: list[str] = []
    listed: dict[str, set[str]] = {}   # destFolder -> existing names (one list per folder)
    for i, mv in enumerate(body.moves):
        # Each move is a paced Egnyte call or two, so a long list would run
        # past the browser's 18 s limit: past the budget the rest go back
        # untouched as `deferred` and the caller sends them again. At least
        # one move is always made, so a batch always progresses.
        if i > 0 and time.monotonic() - started > SCAN_BUDGET_SEC:
            deferred.extend(svc.norm(m.sourcePath) for m in body.moves[i:])
            break
        src, dest = svc.norm(mv.sourcePath), svc.norm(mv.destFolder)
        name = mv.newName.strip()
        # Scans now reach any folder the person ticked, so the old staging-only
        # containment is gone. The real boundaries stay: supervisor+ in Nexus,
        # the caller's own Egnyte permissions on every move (per-user OAuth),
        # and /Shared only - never Private/ trees.
        if not src.startswith("/Shared/") or "/../" in src:
            results.append({"sourcePath": src, "ok": False,
                            "error": "source must be under /Shared"})
            continue
        if "/" in name or name.startswith("..") or not name:
            results.append({"sourcePath": src, "ok": False, "error": "bad file name"})
            continue
        if not dest.startswith("/Shared/"):
            results.append({"sourcePath": src, "ok": False,
                            "error": "destination must be under /Shared"})
            continue
        try:
            if dest not in listed:
                try:
                    existing = _egnyte(token, svc.list_folder, dest)
                    listed[dest] = {f["name"].lower() for f in existing["files"]}
                except HTTPException as exc:
                    if exc.status_code != 404:
                        raise
                    # Create the chain level by level - create_folder is
                    # idempotent per level (an existing folder answers 403/405,
                    # which the service reads as "it exists", not an error).
                    parts = [p for p in dest.split("/") if p]
                    for i in range(2, len(parts) + 1):
                        _egnyte(token, svc.create_folder, "/" + "/".join(parts[:i]))
                    listed[dest] = set()
            if name.lower() in listed[dest]:
                results.append({"sourcePath": src, "ok": False,
                                "error": "a file with that name is already there"})
                continue
            _egnyte(token, svc.move_item, src, f"{dest}/{name}")
            listed[dest].add(name.lower())
        except HTTPException as exc:
            results.append({"sourcePath": src, "ok": False, "error": str(exc.detail)})
            continue

        results.append({"sourcePath": src, "ok": True, "to": f"{dest}/{name}"})
        ctx = audit_capture.current()
        db.add(AuditLog(
            timestamp=datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
            user_email=(ctx.actor if ctx is not None and ctx.actor else user["email"]),
            user_role=user.get("role", "") or "",
            action="Filed a document from #Unsorted",
            resource_type="filing",
            resource_id="",
            details=json.dumps({"from": src, "to": f"{dest}/{name}",
                                "doc_type": mv.docType[:64], "rule": mv.rule[:64]}),
            ip_address=client_ip(request),
            module="documents",
            kind="update",
        ))
    db.commit()
    moved = sum(1 for r in results if r["ok"])
    return {"results": results, "moved": moved, "failed": len(results) - moved,
            "deferred": deferred,
            "egnyte": {"calls": getattr(_meter, "calls", 0),
                       "waitedSec": round(getattr(_meter, "waited", 0.0), 2),
                       "throttled": getattr(_meter, "throttled", 0),
                       "tookSec": round(time.monotonic() - started, 2)}}


@router.get("/activity")
def activity(user: dict = Depends(require_writer), db: Session = Depends(get_db)):
    """The last filings, from the same audit rows the Audit Log screen reads."""
    rows = (db.query(AuditLog).filter(AuditLog.resource_type == "filing")
            .order_by(AuditLog.id.desc()).limit(50).all())
    out = []
    for r in rows:
        try:
            details = json.loads(r.details or "{}")
        except ValueError:
            details = {}
        # Only rows apply() wrote carry from/to. Generic middleware rows for
        # /filing POSTs (from before /filing/apply joined audit.py's skip
        # list, or denied-request security rows) have neither - they are not
        # filings and must not render as empty "filed" lines.
        if not details.get("to"):
            continue
        out.append({"at": r.timestamp, "by": r.user_email,
                    "from": details.get("from", ""), "to": details.get("to", ""),
                    "docType": details.get("doc_type", "")})
    return {"rows": out}
