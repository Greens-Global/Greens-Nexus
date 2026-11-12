"""Tickets into Build Mode (Neil, 11/12/2026: "3. Yes" - everyone outside the
IT development team comes in through a TICKET, never straight to Claude Code).

Two halves:

- **Point At It** (frontend, `tickets/pointAtIt.js`): anyone filing a ticket
  clicks the thing that is wrong. The picture is attached to the ticket like
  any other file and ONE line is added to its description:

      Where: Tasks > Home (/tasks/home) - button "Add Task" [src/tasks/Home.jsx:120]

  The bracket is there only where the build carries source marks. Nothing
  about it is Build Mode's: it is a ticket with a good picture.

- **Send To Claude Code** (`POST /dev-notes/from-ticket/{id}`, a Build Mode
  grant holder who can open the ticket): the ticket becomes ONE pin in that
  person's Build Session - the words, the place parsed from the Where line,
  and COPIES of the ticket's pictures in the pin's own folder. The pin never
  points at the ticket's files, so Build Mode's 30-day purge can never take
  ticket evidence. The ticket gets an activity line, never a comment: nothing
  is mailed or belled to the requester by this, and the desk still resolves
  the ticket itself.

A confidential (Ask HR) ticket is never sent: it is invisible to this
module's query (database.py's hook) and reads as not found.
"""
from __future__ import annotations

import html as _html
import re

MAX_PICTURES = 4
COMMENT_MAX = 4000

# Where: <label> (<path>) - <what> [<file>:<line>]      (the bracket is optional)
WHERE_RE = re.compile(r"Where:\s*(?P<label>[^\n(]*?)\s*\((?P<path>/[^\s)]*)\)"
                      r"(?:\s*-\s*(?P<what>[^\n\[]*?))?\s*(?:\[(?P<file>[\w./@-]+):(?P<line>\d+)\])?\s*(?:\n|$)")
_TAG = re.compile(r"<[^>]+>")
_BLOCK_END = re.compile(r"</(p|div|li|h[1-6]|tr|blockquote)>|<br\s*/?>", re.I)


def plain(html: str) -> str:
    """The description as plain words: block ends become line breaks, tags go,
    entities are decoded, runs of blank lines collapse."""
    text = _BLOCK_END.sub("\n", html or "")
    text = _html.unescape(_TAG.sub("", text))
    lines = [ln.strip() for ln in text.replace("\r", "").split("\n")]
    out: list[str] = []
    for ln in lines:
        if ln or (out and out[-1]):
            out.append(ln)
    return "\n".join(out).strip()


def parse_where(text: str) -> dict:
    """The Where line Point At It wrote, or {}. `route` and `sub` are the
    first two path segments (the app's /<view>/<sub> addresses)."""
    m = WHERE_RE.search(text or "")
    if not m:
        return {}
    path = m.group("path") or ""
    parts = [p for p in path.split("?")[0].split("/") if p]
    file = (m.group("file") or "").strip()
    # A source path is a repo path, never an escape or an absolute one.
    if file.startswith("/") or ".." in file.split("/"):
        file = ""
    return {"label": (m.group("label") or "").strip()[:200], "path": path[:300],
            "route": (parts[0] if parts else "")[:80], "sub": (parts[1] if len(parts) > 1 else "")[:200],
            "what": (m.group("what") or "").strip()[:300],
            "file": file[:300], "line": int(m.group("line")) if file and m.group("line") else 0}


def note_fields(ticket) -> dict:
    """What the pin says, from the ticket alone. No pictures here - the caller
    copies those."""
    body = plain(getattr(ticket, "description", "") or "")
    where = parse_where(body)
    code = (getattr(ticket, "code", "") or "").strip()
    subject = (getattr(ticket, "subject", "") or "").strip()
    head = f"Ticket {code}: {subject}" if code else subject
    comment = (head + ("\n\n" + body if body else ""))[:COMMENT_MAX]
    kind = "change" if (getattr(ticket, "type", "") or "") == "feature_request" else "bug"
    priority = "blocking" if (getattr(ticket, "priority", "") or "").lower() in ("urgent", "critical") else "normal"
    target = {}
    if where:
        target = {"mode": "element", "text": where["what"], "breadcrumb": where["label"]}
        if where["file"]:
            target["source"] = {"file": where["file"], "line": where["line"]}
    return {"comment": comment, "kind": kind, "priority": priority,
            "route": where.get("route", ""), "sub": where.get("sub", ""), "target": target}


def picture_urls(attachments) -> list:
    """The ticket's pictures, oldest first, at most MAX_PICTURES."""
    rows = sorted([a for a in attachments or [] if (getattr(a, "kind", "") or "") == "image" and getattr(a, "url", "")],
                  key=lambda a: getattr(a, "added_at", "") or "")
    return [a.url for a in rows[:MAX_PICTURES]]
