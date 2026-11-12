"""The Nexus connector for Claude - Build Mode only (Neil, 11/12/2026:
"6. Build mode only.").

One MCP endpoint (`POST /build-connector/mcp`, the Streamable HTTP transport's
plain-JSON form) that lets a developer's own Claude read and work THEIR
Build Mode pins: list them, read one, claim, report progress, ask a
question, record the pull request. Nothing else in Nexus is reachable
through it - every tool below calls a Build Mode `/cli/*` function and
nothing in this file queries any other table.

Rules:

- OFF until the server carries `NEXUS_BUILD_CONNECTOR=true` (an Azure app
  setting, Neil's or Visesh's). Off = 404, as if it were not there.
- The caller is a Build Token (`Authorization: Bearer nxbn_...`): the same
  token, owner, expiry and revocation as the terminal watcher. No browser
  session opens it, and there is no anonymous tool.
- A token reaches only the pins its owner sent (`_batch(..., sent_to=)`,
  the watcher's rule). Pictures stay with the CLI (`cli.py attach / clip`).
- This is NOT a Nexus AI feature and spends nothing: no `ANTHROPIC_API_KEY`,
  no call to Anthropic from here. Claude calls US, on the developer's own
  subscription. The AI switch is untouched.
- Stateless: no session id, no server-sent stream (GET answers 405, which
  the transport allows). One JSON-RPC message per POST.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Response
from sqlalchemy.orm import Session

from database import get_db
from models import DevNote
from routers import dev_notes as D

# Its own prefix: under /dev-notes a GET would be read as a pin id.
router = APIRouter(prefix="/build-connector", tags=["Build Mode"])

SWITCH_ENV = "NEXUS_BUILD_CONNECTOR"
PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")       # newest first
SERVER = {"name": "nexus-build-mode", "version": "1.0.0"}
LIVE = ("dispatched", "building", "needs_input", "pr_open")
TEXT_MAX = 12000


def enabled() -> bool:
    return (os.getenv(SWITCH_ENV) or "").strip().lower() == "true"


def _str(desc: str) -> dict:
    return {"type": "string", "description": desc}


_IDS = {"type": "array", "items": {"type": "string"}, "minItems": 1, "description": "Pin ids (UUIDs)."}

TOOLS = [
    {"name": "my_pins",
     "description": "The Build Mode pins you sent that are with Claude Code: sent and not picked up, building, waiting on an answer, or with an open pull request.",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "get_pin",
     "description": "One pin in full: what was asked, where on the screen (route, element, source file and line), the thread, and one-hour links to its pictures.",
     "inputSchema": {"type": "object", "properties": {"id": _str("The pin id.")}, "required": ["id"], "additionalProperties": False}},
    {"name": "claim_pins",
     "description": "Take pins to work on (Sent, Building or Needs Input become Building). Only pins you sent.",
     "inputSchema": {"type": "object", "properties": {"ids": _IDS}, "required": ["ids"], "additionalProperties": False}},
    {"name": "post_progress",
     "description": "One line saying what you are doing on a pin right now.",
     "inputSchema": {"type": "object", "properties": {"id": _str("The pin id."), "text": _str("One line.")},
                     "required": ["id", "text"], "additionalProperties": False}},
    {"name": "reply",
     "description": "Write on a pin's thread. With needs_input true the pin waits for its author's answer and you stop working on it.",
     "inputSchema": {"type": "object",
                     "properties": {"id": _str("The pin id."), "text": _str("What to say."),
                                    "needs_input": {"type": "boolean", "description": "True when this is a question the author must answer."}},
                     "required": ["id", "text"], "additionalProperties": False}},
    {"name": "complete",
     "description": "Record the pull request that fixes these pins (they become PR Open). Never merges anything.",
     "inputSchema": {"type": "object",
                     "properties": {"ids": _IDS, "pr_url": _str("The pull request's GitHub URL."), "branch": _str("Its branch."),
                                    "summary": _str("One or two lines on what changed.")},
                     "required": ["ids", "pr_url", "branch"], "additionalProperties": False}},
]


def _row(n: DevNote) -> dict:
    return {"id": n.id, "number": n.number or 0, "status": D.STATUS_LABELS.get(n.status, n.status), "kind": n.kind or "",
            "priority": n.priority or "", "route": n.route or "", "comment": (n.comment or "")[:300],
            "prUrl": n.pr_url or "", "branch": n.branch or ""}


def _mine(db: Session, email: str):
    sender = D.func.coalesce(D.func.nullif(DevNote.dispatched_by, ""), DevNote.created_by)
    return db.query(DevNote).filter(sender == email)


def _pin(db: Session, email: str, note_id: str) -> DevNote:
    n = _mine(db, email).filter(DevNote.id == str(note_id or "")).first()
    if not n:
        raise HTTPException(404, "Pin not found among the pins you sent")
    return n


def _full(n: DevNote) -> dict:
    target = dict(n.target or {})
    thread = [{"by": e.get("by") or "", "kind": e.get("kind") or "comment", "at": e.get("at") or "", "text": e.get("text") or ""}
              for e in (n.thread or []) if isinstance(e, dict)]
    pictures = {k: D._signed(u) for k, u in (("screenshot", n.screenshot_url), ("page", n.page_shot_url)) if u}
    return {**_row(n), "comment": n.comment or "", "sub": n.sub or "", "url": n.url or "", "viewport": dict(n.viewport or {}),
            "target": {k: target.get(k) for k in ("selector", "tag", "text", "breadcrumb", "source", "html") if target.get(k)},
            "edit": dict(n.edit or {}), "transcript": n.transcript or "", "thread": thread,
            "pictures": pictures, "attachments": [s for s in (D._signed(u) for u in (n.attachments or [])) if s],
            "ticket": n.ticket_code or "", "reopenCount": n.reopen_count or 0}


def _call(name: str, args: dict, user: dict, db: Session):
    email = (user.get("email") or "").lower()
    if name == "my_pins":
        rows = _mine(db, email).filter(DevNote.status.in_(LIVE)).order_by(DevNote.created_at.asc()).limit(200).all()
        return [_row(n) for n in rows]
    if name == "get_pin":
        return _full(_pin(db, email, args.get("id")))
    if name == "claim_pins":
        return D.cli_claim({"noteIds": list(args.get("ids") or [])}, user, db)
    if name == "post_progress":
        _pin(db, email, args.get("id"))
        return _row_of(D.cli_progress(str(args.get("id")), {"text": str(args.get("text") or "")}, user, db))
    if name == "reply":
        _pin(db, email, args.get("id"))
        body = {"text": str(args.get("text") or "")}
        if args.get("needs_input"):
            body["needsInput"] = True
        return _row_of(D.cli_reply(str(args.get("id")), body, user, db))
    if name == "complete":
        ids = [str(i) for i in (args.get("ids") or [])]
        for note_id in ids:
            _pin(db, email, note_id)            # every one of them yours, or none is recorded
        pr_url = str(args.get("pr_url") or "").strip()
        m = re.search(r"/pull/(\d+)", pr_url)
        if not m:
            raise HTTPException(400, "pr_url must be a pull request's URL (.../pull/<number>)")
        body = {"noteIds": ids, "prUrl": pr_url, "prNumber": int(m.group(1)),
                "branch": str(args.get("branch") or ""), "summary": str(args.get("summary") or "")}
        return D.cli_complete(body, user, db)
    raise HTTPException(404, f"Unknown tool: {name}")


def _row_of(note) -> dict:
    """A serialized pin (what the /cli routes return) cut down to a row."""
    if not isinstance(note, dict):
        return {"ok": True}
    return {"id": note.get("id"), "number": note.get("number"), "status": D.STATUS_LABELS.get(note.get("status"), note.get("status"))}


def _result(msg_id, result: dict) -> dict:
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def _error(msg_id, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


def handle(msg: dict, user: dict, db: Session) -> Optional[dict]:
    """One JSON-RPC message in, its answer out (None for a notification)."""
    method = msg.get("method")
    msg_id = msg.get("id")
    if "id" not in msg:
        return None                       # notifications/initialized, cancelled, ...: nothing to say
    if method == "initialize":
        asked = str((msg.get("params") or {}).get("protocolVersion") or "")
        return _result(msg_id, {"protocolVersion": asked if asked in PROTOCOLS else PROTOCOLS[0],
                                "capabilities": {"tools": {}}, "serverInfo": SERVER,
                                "instructions": "Build Mode pins only. Work a pin with the repo's build-notes skill; "
                                                "pictures and evidence go through tools/build_notes/cli.py."})
    if method == "ping":
        return _result(msg_id, {})
    if method == "tools/list":
        return _result(msg_id, {"tools": TOOLS})
    if method == "tools/call":
        params = msg.get("params") or {}
        name, args = str(params.get("name") or ""), params.get("arguments") or {}
        if name not in {t["name"] for t in TOOLS} or not isinstance(args, dict):
            return _error(msg_id, -32602, f"Unknown tool: {name}")
        try:
            out = _call(name, args, user, db)
            text, failed = json.dumps(out, default=str)[:TEXT_MAX], False
        except HTTPException as exc:
            db.rollback()
            text, failed = str(exc.detail), True       # the tool ran and refused: Claude should read why
        return _result(msg_id, {"content": [{"type": "text", "text": text}], "isError": failed})
    return _error(msg_id, -32601, f"Method not found: {method}")


def require_build_token(authorization: str = Header(default=None), db: Session = Depends(get_db)) -> dict:
    """The connector's one door: the switch is on and the caller holds a live
    Build Token whose owner still has the Build Mode grant. (Named `require*`
    so the route sweep in test_auth_access.py sees these routes as authed -
    they are, by token; they are not on the public allowlist.)"""
    if not enabled():
        raise HTTPException(404, "Not Found")
    if not D._is_build_token(authorization):
        raise HTTPException(401, "A Build Token is required", headers={"WWW-Authenticate": "Bearer"})
    return D._resolve_token(authorization or "", db)


@router.post("/mcp")
def mcp(msg: Any = Body(default=None), user: dict = Depends(require_build_token), db: Session = Depends(get_db)):
    # A plain `def`: FastAPI runs it in a worker thread, so the token lookup
    # and the tools' database work never sit on the event loop.
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
        return _error(msg.get("id") if isinstance(msg, dict) else None, -32600, "One JSON-RPC 2.0 message per request")
    answer = handle(msg, user, db)
    if answer is None:
        return Response(status_code=202)
    return answer


@router.get("/mcp")
def mcp_stream(user: dict = Depends(require_build_token)):
    """No server-sent stream is offered; the transport says to answer 405."""
    return Response(status_code=405, headers={"Allow": "POST"})
