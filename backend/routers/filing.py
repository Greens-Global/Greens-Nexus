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


def _live_maps(token: str | None) -> filing_rules.Maps:
    """The entity / facility / project maps, read from the live tree at scan
    time - never hardcoded, so an Egnyte re-org does not need a deploy."""
    maps = filing_rules.Maps()
    try:
        folders = _call(svc.list_folder, maps.entities_root, token)["folders"]
        maps.entities = [f["name"] for f in folders if not f["name"].startswith("#")]
    except HTTPException:
        pass  # a root the caller cannot see narrows matching, never breaks the scan
    try:
        for f in _call(svc.list_folder, "/Shared/--Operations", token)["folders"]:
            m = _OPS_FACILITY.match(f["name"])
            if m:
                maps.facilities[m.group(1)] = f["path"]
    except HTTPException:
        pass
    try:
        for f in _call(svc.list_folder, "/Shared/--Development/Projects", token)["folders"]:
            maps.projects[f["name"]] = f["path"]
    except HTTPException:
        pass
    return maps


def _root_context(root: str, maps: filing_rules.Maps) -> dict:
    """An entity's own #Unsorted already says whose files these are."""
    prefix = maps.entities_root + "/"
    if root.startswith(prefix):
        head = root[len(prefix):].split("/", 1)[0]
        if head in maps.entities:
            return {"entity": head}
    return {}


@router.post("/scan")
def scan(user: dict = Depends(require_writer), db: Session = Depends(get_db)):
    token = _browse_token(user, db)
    cfg = _load_config(db)
    maps = _live_maps(token)

    proposals: list[dict] = []
    scanned, missing = [], []
    for root in cfg["scanRoots"]:
        try:
            listing = _call(svc.list_folder, root, token)
        except HTTPException as exc:
            if exc.status_code in (403, 404):
                missing.append(root)
                continue
            raise
        scanned.append(root)
        ctx = _root_context(root, maps)
        for sub in listing["folders"]:
            skippable = sub["name"].lower() in SKIP_SUBFOLDERS
            proposals.append({
                "sourcePath": sub["path"], "currentName": sub["name"],
                "status": "skip", "docType": "", "destFolder": "", "newName": "",
                "rule": "", "reasons": ["legacy dump - left alone" if skippable
                                        else "subfolder - files inside are not scanned yet"]})
        for f in listing["files"]:
            proposals.append(filing_rules.propose(
                f["name"], root, ctx, maps, cfg["confirmed"]))
            if len(proposals) >= MAX_SCAN_FILES:
                break
        if len(proposals) >= MAX_SCAN_FILES:
            break

    counts = {"auto": 0, "review": 0, "skip": 0}
    for p in proposals:
        counts[p["status"]] = counts.get(p["status"], 0) + 1
    return {"proposals": proposals, "counts": counts,
            "scannedRoots": scanned, "missingRoots": missing,
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
    token = _browse_token(user, db)
    cfg = _load_config(db)

    results = []
    listed: dict[str, set[str]] = {}   # destFolder -> existing names (one list per folder)
    for mv in body.moves:
        src, dest = svc.norm(mv.sourcePath), svc.norm(mv.destFolder)
        name = mv.newName.strip()
        # This endpoint files FROM staging only - it is not a general mover.
        if not any(src.startswith(root.rstrip("/") + "/") for root in cfg["scanRoots"]):
            results.append({"sourcePath": src, "ok": False,
                            "error": "not inside a configured scan folder"})
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
                    existing = _call(svc.list_folder, dest, token)
                    listed[dest] = {f["name"].lower() for f in existing["files"]}
                except HTTPException as exc:
                    if exc.status_code != 404:
                        raise
                    # Create the chain level by level - create_folder is
                    # idempotent per level (an existing folder answers 403/405,
                    # which the service reads as "it exists", not an error).
                    parts = [p for p in dest.split("/") if p]
                    for i in range(2, len(parts) + 1):
                        _call(svc.create_folder, "/" + "/".join(parts[:i]), token)
                    listed[dest] = set()
            if name.lower() in listed[dest]:
                results.append({"sourcePath": src, "ok": False,
                                "error": "a file with that name is already there"})
                continue
            _call(svc.move_item, src, f"{dest}/{name}", token)
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
    return {"results": results, "moved": moved, "failed": len(results) - moved}


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
        out.append({"at": r.timestamp, "by": r.user_email,
                    "from": details.get("from", ""), "to": details.get("to", ""),
                    "docType": details.get("doc_type", "")})
    return {"rows": out}
