#!/usr/bin/env python3
"""Build Mode command line: the subcommands Claude Code (and a developer) use
to work a Build Session's pins.

    python3 tools/build_notes/cli.py whoami
    python3 tools/build_notes/cli.py list [--status dispatched] [--limit 50]
    python3 tools/build_notes/cli.py claim <id> [<id> ...] [--out DIR] [--no-download]
    python3 tools/build_notes/cli.py progress <id> "Reading pins"
    python3 tools/build_notes/cli.py reply <id> "text" [--needs-input] [--answered] [--image PATH]
    python3 tools/build_notes/cli.py after <id> --image PATH
    python3 tools/build_notes/cli.py complete <id> [<id> ...] --pr URL --branch NAME [--summary "..."]
    python3 tools/build_notes/cli.py verify <id> [--repro-script PATH --before failing --after passing]
                                               [--style-json PATH] [--before-image PATH --after-image PATH]

Global flags (before the subcommand): --api URL, --token TOKEN.
`claim` downloads every media file into ~/.cache/nexus-build-notes/<id>/ and
prints one markdown brief per pin (also saved as brief.md in that folder).

Standard library only.
"""

import argparse
import json
import os
import re
import sys
import urllib.parse
from pathlib import Path

try:
    from . import common
except ImportError:  # run as a plain script: python3 tools/build_notes/cli.py
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import common

KIND_LABELS = {"bug": "Bug", "change": "Change", "question": "Question", "edit": "Edit"}
PRIORITY_LABELS = {"blocking": "Blocking", "normal": "Normal", "nice": "Nice To Have"}
STATUS_LABELS = {
    "open": "Open", "dispatched": "Dispatched", "building": "Building",
    "needs_input": "Needs Input", "pr_open": "PR Open", "fixed": "Fixed - Verify",
    "done": "Done", "dismissed": "Dismissed",
}
COLOR_NAMES = {
    "#ef4444": "red", "#dc2626": "red", "#f87171": "red",
    "#3b82f6": "blue", "#2563eb": "blue", "#60a5fa": "blue",
    "#facc15": "yellow", "#fde047": "yellow", "#eab308": "yellow",
    "#22c55e": "green", "#16a34a": "green", "#10b981": "green",
    "#f97316": "orange", "#fb923c": "orange",
    "#a855f7": "purple", "#8b5cf6": "violet", "#ec4899": "pink",
    "#111827": "black", "#000000": "black", "#1f2937": "dark gray",
    "#6b7280": "gray", "#ffffff": "white",
}
MEDIA_FILES = (
    # (media key, label, default file name)
    ("screenshot", "Screenshot", "screenshot.png"),
    ("pageShot", "Page shot", "page.png"),
    ("contactSheet", "Contact sheet", "sheet.png"),
    ("video", "Video", "video.webm"),
)
CONSOLE_LIMIT = 50
NETWORK_LIMIT = 30
ACTIONS_LIMIT = 30
PROGRESS_LIMIT = 300   # the server keeps one line of this many chars
BODY_LIMIT = 1200      # chars of a request / response body shown per network entry
STATE_LIMIT = 8000     # chars of the React state snapshot shown


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------

def _g(d, *keys, default=None):
    """First present key from a camelCase / snake_case pair."""
    if not isinstance(d, dict):
        return default
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return default


def kind_label(value):
    return KIND_LABELS.get(str(value or "").lower(), str(value or "Bug").capitalize())


def priority_label(value):
    return PRIORITY_LABELS.get(str(value or "").lower(), str(value or "Normal").capitalize())


def status_label(value):
    return STATUS_LABELS.get(str(value or "").lower(), str(value or "").replace("_", " ").title())


def color_name(value):
    if not value:
        return ""
    v = str(value).strip().lower()
    if v in COLOR_NAMES:
        return COLOR_NAMES[v]
    if len(v) == 4 and v.startswith("#"):  # #f00 -> #ff0000
        expanded = "#" + "".join(ch * 2 for ch in v[1:])
        if expanded in COLOR_NAMES:
            return COLOR_NAMES[expanded]
    return v


def _num(v, default=0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _fmt_xy(x, y):
    return "(" + str(int(_num(x))) + ", " + str(int(_num(y))) + ")"


def _fmt_box(x, y, w, h):
    return _fmt_xy(x, y) + " " + str(int(_num(w))) + "x" + str(int(_num(h)))


def _overlaps(item, rect):
    """Does a markup box overlap the target's rect (both viewport px)?"""
    if not rect:
        return False
    ax, ay, aw, ah = (_num(item.get(k)) for k in ("x", "y", "w", "h"))
    bx, by, bw, bh = (_num(rect.get(k)) for k in ("x", "y", "w", "h"))
    return ax < bx + bw and ax + aw > bx and ay < by + bh and ay + ah > by


def _inside(x, y, rect, slack=12):
    if not rect:
        return False
    bx, by, bw, bh = (_num(rect.get(k)) for k in ("x", "y", "w", "h"))
    return bx - slack <= _num(x) <= bx + bw + slack and by - slack <= _num(y) <= by + bh + slack


def describe_markup(markup, target_rect=None):
    """The markup items as sentences ('red rectangle around the target')."""
    items = (markup or {}).get("items") or []
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        t = str(item.get("type") or "").lower()
        color = color_name(item.get("color"))
        c = (color + " ") if color else ""
        if t == "rect":
            where = "around the target" if _overlaps(item, target_rect) else "at " + _fmt_box(item.get("x"), item.get("y"), item.get("w"), item.get("h"))
            out.append(c + "rectangle " + where)
        elif t == "arrow":
            start = _fmt_xy(item.get("x1"), item.get("y1"))
            end = "the target" if _inside(item.get("x2"), item.get("y2"), target_rect) else _fmt_xy(item.get("x2"), item.get("y2"))
            out.append(c + "arrow from " + start + " to " + end)
        elif t == "path":
            pts = item.get("points") or []
            n = len(pts)
            touches = any(isinstance(p, (list, tuple)) and len(p) >= 2 and _inside(p[0], p[1], target_rect, 0) for p in pts)
            out.append(c + "freehand stroke with " + str(n) + " points" + (" over the target" if touches else ""))
        elif t == "highlight":
            where = "over the target" if _overlaps(item, target_rect) else "over " + _fmt_box(item.get("x"), item.get("y"), item.get("w"), item.get("h"))
            out.append((color or "yellow") + " highlight " + where)
        elif t == "text":
            out.append("text label: '" + str(item.get("text") or "").strip() + "' at " + _fmt_xy(item.get("x"), item.get("y")))
        elif t == "redact":
            out.append("redacted area at " + _fmt_box(item.get("x"), item.get("y"), item.get("w"), item.get("h")) + " (blurred in the screenshots)")
        else:
            out.append(t + " " + json.dumps({k: v for k, v in item.items() if k != "type"}))
    return out


def describe_edit(edit):
    """The Edit In Place diff as lines: the auto sentence, text, styles."""
    if not edit:
        return []
    lines = []
    note = edit.get("note")
    if note:
        lines.append(str(note))
    text = edit.get("text") or {}
    if isinstance(text, dict) and (text.get("before") is not None or text.get("after") is not None):
        lines.append("Text before: " + json.dumps(text.get("before", "")))
        lines.append("Text after:  " + json.dumps(text.get("after", "")))
    for s in edit.get("styles") or []:
        if isinstance(s, dict):
            lines.append("- " + str(s.get("prop")) + ": " + str(s.get("before")) + " -> " + str(s.get("after")))
    return lines


def _ext_from_url(url, default):
    try:
        path = urllib.parse.urlparse(url).path
    except ValueError:
        return default
    ext = os.path.splitext(path)[1].lower()
    if ext and len(ext) <= 6 and re.match(r"^\.[a-z0-9]+$", ext):
        return ext
    return default


def _code_block(text, lang=""):
    fence = "```"
    while fence in text:
        fence += "`"
    return [fence + lang, text, fence]


def _trim(text, limit):
    text = str(text or "")
    return text if len(text) <= limit else text[:limit] + "..."


# --------------------------------------------------------------------------
# Brief
# --------------------------------------------------------------------------

def source_location(target, with_col=False):
    """'frontend/src/tasks/TasksHome.jsx:142' from target.source = {file, line, col}
    (the build-time stamp); '' when the pin has none."""
    src = (target or {}).get("source") if isinstance(target, dict) else None
    if not isinstance(src, dict) or not src.get("file"):
        return ""
    file = str(src.get("file")).replace("\\", "/")
    while file.startswith("./"):
        file = file[2:]
    file = file.lstrip("/")
    if file.startswith("frontend/"):
        pass
    elif file.startswith("src/"):
        file = "frontend/" + file
    else:
        file = "frontend/src/" + file
    loc = file
    if src.get("line") not in (None, "", 0):
        loc += ":" + str(src.get("line"))
        if with_col and src.get("col") not in (None, "", 0):
            loc += ":" + str(src.get("col"))
    return loc


def _body_text(value, limit=BODY_LIMIT):
    if value is None or value == "":
        return ""
    if isinstance(value, (dict, list)):
        text = json.dumps(value, separators=(", ", ": "))
    else:
        text = str(value)
    return _trim(text.replace("\n", " "), limit)


def describe_actions(actions):
    """The last user actions as a numbered trace."""
    out = []
    acts = [a for a in (actions or []) if isinstance(a, dict)][-ACTIONS_LIMIT:]
    for i, a in enumerate(acts, 1):
        t = str(a.get("type") or "action")
        label = a.get("label")
        selector = a.get("selector")
        where = ""
        if a.get("view"):
            where = str(a.get("view")) + ("/" + str(a.get("sub")) if a.get("sub") else "")
        line = str(i) + ". " + (common.us_time(a.get("t")) + " " if a.get("t") else "") + t
        if label:
            line += " " + json.dumps(str(label))
        if selector:
            line += " (" + str(selector) + ")"
        if a.get("value") not in (None, ""):
            line += " = " + json.dumps(str(a.get("value")))
        if where:
            line += " on " + where
        out.append(line)
    return out


def latest_human_answer(thread):
    """(by, at, text) when the thread's LAST entry is a person's comment - the
    author answered a question and the pin came back through the watcher."""
    entries = [e for e in (thread or []) if isinstance(e, dict)]
    if not entries:
        return None
    last = entries[-1]
    if str(last.get("kind") or "comment") != "comment" or str(last.get("by") or "").lower() == "claude":
        return None
    return (str(last.get("by") or "author"), str(last.get("at") or ""), str(last.get("text") or "").strip())


def render_brief(note, files, session_title=None):
    """One markdown brief for a pin. `files` maps label -> local path."""
    n = note
    number = _g(n, "number", default="?")
    lines = []
    lines.append("# Pin #" + str(number) + " - " + kind_label(_g(n, "kind")) + " - " + priority_label(_g(n, "priority")))
    author = _g(n, "createdBy", "created_by", default="")
    created = common.us_datetime(_g(n, "createdAt", "created_at", default=""))
    lines.append("By " + str(author or "unknown") + " on " + (created or "unknown date")
                 + " - Status: " + status_label(_g(n, "status")) + " - Id: " + str(_g(n, "id", default="")))
    sess = session_title or _g(n, "sessionTitle", "session_title")
    sess_id = _g(n, "sessionId", "session_id", default="")
    if sess or sess_id:
        lines.append("Build Session: " + str(sess or sess_id) + ((" (" + str(sess_id) + ")") if sess and sess_id else ""))
    lines.append("Nexus: " + common.pin_link(_g(n, "id", default="")))
    tgt = _g(n, "target", default={}) or {}
    where = source_location(tgt, with_col=True)
    if where:
        lines.append("Where: " + where + "  (build-time source stamp - open this file first)")
    else:
        lines.append("Where: no source stamp - locate by text, headings and components below")
    # Only a pin that came back through the watcher (needs_input / building
    # with a fresh human comment) carries an answer; a dispatched pin's own
    # comments are just its thread.
    answer = latest_human_answer(_g(n, "thread", default=[]) or []) if str(_g(n, "status", default="")) in ("needs_input", "building") else None
    if answer:
        lines.append("Author's latest answer (" + answer[0] + ", " + common.us_datetime(answer[1]) + "): " + answer[2])
    lines.append("")

    lines.append("## Where")
    lines.append("- Route: " + str(_g(n, "route", default="") or "-"))
    lines.append("- Sub: " + str(_g(n, "sub", default="") or "-"))
    lines.append("- URL: " + str(_g(n, "url", default="") or "-"))
    lines.append("- Build: " + str(_g(n, "buildId", "build_id", default="") or "-"))
    vp = _g(n, "viewport", default={}) or {}
    if vp:
        bits = []
        if vp.get("w") or vp.get("h"):
            bits.append(str(vp.get("w", "?")) + "x" + str(vp.get("h", "?")))
        if vp.get("dpr"):
            bits.append("@" + str(vp.get("dpr")) + "x")
        bits.append("phone" if vp.get("phone") else "desktop")
        if vp.get("theme"):
            bits.append(str(vp.get("theme")) + " theme")
        lines.append("- Viewport: " + ", ".join(bits))
        if vp.get("ua"):
            lines.append("- UA: " + _trim(vp.get("ua"), 200))
    else:
        lines.append("- Viewport: -")
    lines.append("")

    lines.append("## Comment")
    lines.append(str(_g(n, "comment", default="") or "(no comment)"))
    lines.append("")

    thread = _g(n, "thread", default=[]) or []
    if thread:
        lines.append("## Thread")
        for e in thread:
            if not isinstance(e, dict):
                continue
            who = str(e.get("by") or "?")
            when = common.us_datetime(e.get("at") or "")
            kind = str(e.get("kind") or "comment")
            text = str(e.get("text") or "")
            entry = "- " + when + " - " + who + " (" + kind + "): " + text
            if e.get("image_url") or e.get("imageUrl"):
                entry += " [image: " + str(e.get("image_url") or e.get("imageUrl")) + "]"
            lines.append(entry)
        lines.append("")

    lines.append("## Target")
    if tgt:
        if tgt.get("mode"):
            lines.append("- Mode: " + str(tgt.get("mode")))
        lines.append("- Selector: `" + str(tgt.get("selector") or "-") + "`")
        tag = str(tgt.get("tag") or "")
        if tgt.get("id"):
            tag += "#" + str(tgt.get("id"))
        classes = tgt.get("classes") or []
        if classes:
            tag += "." + ".".join(str(c) for c in classes)
        lines.append("- Tag: " + (tag or "-"))
        attrs = tgt.get("attrs") or {}
        attrs = {k: v for k, v in attrs.items() if v not in (None, "")} if isinstance(attrs, dict) else {}
        if attrs:
            lines.append("- Attributes: " + ", ".join(str(k) + "=" + json.dumps(v) for k, v in attrs.items()))
        lines.append("- Text: " + json.dumps(str(tgt.get("text") or "")))
        headings = tgt.get("headings") or []
        if headings:
            lines.append("- Headings: " + " > ".join(str(h) for h in headings))
        if tgt.get("breadcrumb"):
            lines.append("- Breadcrumb: " + str(tgt.get("breadcrumb")))
        comps = tgt.get("components") or []
        lines.append("- Components: " + (" > ".join(str(c) for c in comps) if comps else "(not captured - search by text and headings)"))
        rec = tgt.get("record") or {}
        if isinstance(rec, dict) and any(rec.get(k) for k in ("ids", "keys", "queryKeys")):
            parts = []
            if rec.get("ids"):
                parts.append("ids " + ", ".join(str(i) for i in rec["ids"]))
            if rec.get("keys"):
                parts.append("keys " + ", ".join(str(k) for k in rec["keys"]))
            if rec.get("queryKeys"):
                parts.append("query keys " + json.dumps(rec["queryKeys"]))
            lines.append("- Record: " + "; ".join(parts))
        rect = tgt.get("rect") or {}
        if rect:
            lines.append("- Rect: " + _fmt_box(rect.get("x"), rect.get("y"), rect.get("w"), rect.get("h"))
                         + (" (page " + _fmt_xy(rect.get("pageX"), rect.get("pageY")) + ")" if rect.get("pageX") is not None else ""))
        html = tgt.get("html")
        if html:
            lines.append("- HTML:")
            lines.extend(_code_block(str(html), "html"))
    else:
        lines.append("(no target captured)")
    lines.append("")

    markup_lines = describe_markup(_g(n, "markup", default={}) or {}, (tgt or {}).get("rect"))
    if markup_lines:
        lines.append("## Markup")
        for m in markup_lines:
            lines.append("- " + m)
        lines.append("")

    edit_lines = describe_edit(_g(n, "edit", default={}) or {})
    if edit_lines:
        lines.append("## Edit In Place")
        lines.extend(edit_lines)
        lines.append("")

    action_lines = describe_actions(_g(n, "actions", default=[]) or [])
    if action_lines:
        lines.append("## Actions (last " + str(len(action_lines)) + ")")
        lines.extend(action_lines)
        lines.append("")

    state = _g(n, "state", default=None)
    if state not in (None, "", {}, []):
        lines.append("## State")
        text = json.dumps(state, indent=2, sort_keys=True) if isinstance(state, (dict, list)) else str(state)
        if len(text) > STATE_LIMIT:
            text = text[:STATE_LIMIT] + "\n... (truncated, full snapshot in pin.json)"
        lines.extend(_code_block(text, "json"))
        lines.append("")

    transcript = _g(n, "transcript", default="")
    if transcript:
        lines.append("## Transcript")
        lines.append(str(transcript))
        lines.append("")

    console = _g(n, "consoleLog", "console_log", default=[]) or []
    if console:
        lines.append("## Console (last " + str(min(len(console), CONSOLE_LIMIT)) + ")")
        for e in console[-CONSOLE_LIMIT:]:
            if isinstance(e, dict):
                lines.append("- [" + str(e.get("level") or "log") + "] " + common.us_time(e.get("at") or "") + " " + _trim(e.get("text"), 500))
            else:
                lines.append("- " + _trim(e, 500))
        lines.append("")

    network = _g(n, "networkLog", "network_log", default=[]) or []
    if network:
        lines.append("## Network (last " + str(min(len(network), NETWORK_LIMIT)) + ")")
        for e in network[-NETWORK_LIMIT:]:
            if isinstance(e, dict):
                lines.append("- " + str(e.get("method") or "GET") + " " + str(e.get("path") or "") + " -> "
                             + str(e.get("status") if e.get("status") is not None else "?")
                             + (" " + str(int(_num(e.get("ms")))) + "ms" if e.get("ms") is not None else "")
                             + (" at " + common.us_time(e.get("at")) if e.get("at") else ""))
                req = _body_text(e.get("requestBody", e.get("request_body")))
                res = _body_text(e.get("responseBody", e.get("response_body")))
                if req:
                    lines.append("  request: " + req)
                if res:
                    lines.append("  response: " + res)
            else:
                lines.append("- " + _trim(e, 300))
        lines.append("")

    lines.append("## Files")
    if files:
        for label, path in files:
            lines.append("- " + label + ": " + str(path))
    else:
        lines.append("(no media on this pin)")
    lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# Subcommands
# --------------------------------------------------------------------------

def cmd_whoami(client, args):
    me = client.get("/cli/whoami", timeout=30) or {}
    label = _g(me, "tokenLabel", "token_label", default="")
    print(str(_g(me, "email", default="?")) + ((" (" + str(label) + ")") if label else "") + " on " + client.api_base)
    return 0


def _print_list(notes, sessions=None):
    titles = {s.get("id"): s.get("title") for s in sessions or [] if isinstance(s, dict)}
    if not notes:
        print("No pins.")
        return
    for n in notes:
        where = str(_g(n, "route", default="") or "")
        sub = _g(n, "sub", default="")
        if sub:
            where += "/" + str(sub)
        line = ("#" + str(_g(n, "number", default="?")).ljust(4) + " " + status_label(_g(n, "status")).ljust(14)
                + " " + kind_label(_g(n, "kind")).ljust(9) + " " + priority_label(_g(n, "priority")).ljust(13)
                + " " + where.ljust(22) + " " + str(_g(n, "createdBy", "created_by", default="")).ljust(28)
                + " " + str(_g(n, "id", default="")))
        title = titles.get(_g(n, "sessionId", "session_id"))
        if title:
            line += "  [" + str(title) + "]"
        print(line)
        comment = _trim(str(_g(n, "comment", default="") or "").replace("\n", " "), 120)
        if comment:
            print("      " + comment)
        where = source_location(_g(n, "target", default={}) or {})
        if where:
            print("      Where: " + where)


def cmd_list(client, args):
    query = {"status": args.status, "limit": args.limit}
    if args.route:
        query["route"] = args.route
    if args.mine:
        query["mine"] = 1
    try:
        notes = client.get("/", query=query) or []
        sessions = []
    except common.ApiError as exc:
        # The list route may only take a signed-in session; the CLI wait route
        # knows about dispatched / needs-input pins and takes the token.
        if exc.status == 401 and (args.status in (None, "", "dispatched", "needs_input")):
            data = client.get("/cli/wait", query={"timeout": 0}, timeout=30) or {}
            notes = data.get("notes") or []
            sessions = data.get("sessions") or []
            if args.status:
                notes = [n for n in notes if str(_g(n, "status", default="")) == args.status]
        else:
            raise
    if args.json:
        print(json.dumps(notes, indent=2))
    else:
        _print_list(notes, sessions)
    return 0


def _download_media(client, note, out_dir, skip=False):
    """Fetch every media file for a pin. Returns [(label, local path)]."""
    media = _g(note, "media", default={}) or {}
    note_id = str(_g(note, "id", default="pin"))
    folder = Path(out_dir) / note_id
    folder.mkdir(parents=True, exist_ok=True)
    files = []
    plan = []
    for key, label, default_name in MEDIA_FILES:
        url = media.get(key) or media.get(_snake(key))
        if url:
            stem, ext = os.path.splitext(default_name)
            plan.append((label, url, folder / (stem + _ext_from_url(url, ext))))
    for i, url in enumerate(media.get("attachments") or [], 1):
        if url:
            plan.append(("Attachment " + str(i), url, folder / ("attachment-" + str(i) + _ext_from_url(url, ".png"))))
    for i, url in enumerate(media.get("afterShots") or media.get("after_shots") or [], 1):
        if url:
            plan.append(("After shot " + str(i), url, folder / ("after-" + str(i) + _ext_from_url(url, ".png"))))
    for label, url, dest in plan:
        if skip:
            files.append((label, url))
            continue
        try:
            client.download(url, dest)
            files.append((label, dest))
        except common.ApiError as exc:
            common.eprint("Warning: " + label + " for pin " + note_id + " - " + str(exc))
            files.append((label, "(download failed) " + url))
    return folder, files


def _snake(camel):
    return re.sub(r"([A-Z])", lambda m: "_" + m.group(1).lower(), camel)


def cmd_claim(client, args):
    ids = list(dict.fromkeys(args.ids))
    data = client.post("/cli/claim", {"noteIds": ids}, timeout=120) or {}
    notes = data.get("notes") or []
    sessions = {s.get("id"): s.get("title") for s in (data.get("sessions") or []) if isinstance(s, dict)}
    if not notes:
        print("Nothing claimed - the pins may already be building or were dismissed.")
        return 1
    out_dir = Path(args.out).expanduser() if args.out else common.CACHE_DIR
    briefs = []
    for note in notes:
        folder, files = _download_media(client, note, out_dir, skip=args.no_download)
        brief = render_brief(note, files, sessions.get(_g(note, "sessionId", "session_id")))
        try:
            (folder / "brief.md").write_text(brief, encoding="utf-8")
            (folder / "pin.json").write_text(json.dumps(note, indent=2), encoding="utf-8")
        except OSError as exc:
            common.eprint("Warning: could not save the brief in " + str(folder) + ": " + str(exc))
        briefs.append(brief)
    print(("\n\n---\n\n").join(briefs))
    missing = [i for i in ids if i not in {str(_g(n, "id", default="")) for n in notes}]
    if missing:
        common.eprint("Not claimed (unknown, not dispatched, or not yours to claim): " + " ".join(missing))
    return 0


def cmd_progress(client, args):
    text = " ".join(args.text).strip()
    if not text:
        common.eprint("progress needs a one-line text")
        return 2
    # The server keeps one line of 300 chars; send exactly that.
    line = " ".join(text.split())[:PROGRESS_LIMIT]
    note = client.post("/cli/progress/" + args.id, {"text": line}) or {}
    print("Pin #" + str(_g(note, "number", default="?")) + " progress: " + line)
    return 0


def _attach(client, note_id, image_path, kind):
    path = Path(image_path).expanduser()
    if not path.is_file():
        raise common.ConfigError("Image not found: " + str(path))
    if path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
        raise common.ConfigError("Image must be png, jpg or webp: " + str(path))
    if path.stat().st_size > 8 * 1024 * 1024:
        raise common.ConfigError("Image is over 8 MB: " + str(path))
    data = client.upload("/cli/attach/" + note_id, path, fields={"kind": kind}) or {}
    return str(data.get("url") or "")


def cmd_reply(client, args):
    text = " ".join(args.text).strip()
    if not text and not args.image:
        common.eprint("reply needs a text or --image")
        return 2
    if args.needs_input and args.answered:
        common.eprint("reply takes --needs-input or --answered, not both")
        return 2
    body = {"text": text}
    if args.needs_input:
        body["needsInput"] = True
    if args.answered:
        body["answered"] = True
    if args.image:
        body["imageUrl"] = _attach(client, args.id, args.image, "paste")
    note = client.post("/cli/reply/" + args.id, body) or {}
    status = status_label(_g(note, "status", default=""))
    print("Pin #" + str(_g(note, "number", default="?")) + " replied" + (" - now " + status if status else ""))
    return 0


def cmd_after(client, args):
    url = _attach(client, args.id, args.image, "after")
    print("After shot attached to pin " + args.id + (": " + url if url else ""))
    return 0


def pr_number_from_url(url):
    m = re.search(r"/pull/(\d+)", str(url or ""))
    return int(m.group(1)) if m else 0


def cmd_complete(client, args):
    ids = list(dict.fromkeys(args.ids))
    pr_number = args.pr_number or pr_number_from_url(args.pr)
    if not pr_number:
        common.eprint("Could not read the PR number from " + str(args.pr) + " - pass --pr-number")
        return 2
    body = {"noteIds": ids, "prUrl": args.pr, "prNumber": pr_number, "branch": args.branch}
    if args.summary:
        body["summary"] = args.summary
    data = client.post("/cli/complete", body) or {}
    notes = data.get("notes") or []
    session = data.get("session") or {}
    print("PR #" + str(pr_number) + " recorded on " + str(len(notes)) + (" pin" if len(notes) == 1 else " pins")
          + (" - Build Session '" + str(session.get("title")) + "' is " + status_label(session.get("status")) if session else ""))
    return 0


VERIFY_STATES = ("failing", "passing", "skipped")


def cmd_verify(client, args):
    """Record the evidence that a fix is right: a repro script with its
    before/after result, a computed-style check, before/after screenshots."""
    body = {}
    if args.repro_script or args.before or args.after:
        if args.repro_script and not (args.before and args.after):
            common.eprint("verify --repro-script needs --before and --after (failing | passing | skipped)")
            return 2
        script = ""
        if args.repro_script:
            path = Path(args.repro_script).expanduser()
            if not path.is_file():
                raise common.ConfigError("Repro script not found: " + str(path))
            script = path.read_text(encoding="utf-8", errors="replace")
        body["repro"] = {"script": script, "before": args.before or "skipped", "after": args.after or "skipped"}
    if args.style_json:
        path = Path(args.style_json).expanduser()
        if not path.is_file():
            raise common.ConfigError("Style check JSON not found: " + str(path))
        try:
            style = json.loads(path.read_text(encoding="utf-8"))
        except ValueError as exc:
            raise common.ConfigError("Style check JSON does not parse (" + str(exc) + "): " + str(path))
        if not isinstance(style, dict) or "checks" not in style:
            raise common.ConfigError('Style check JSON must be {"passed": bool, "checks": [{prop, expected, actual, ok}]}')
        checks = style.get("checks") or []
        if "passed" not in style:
            style["passed"] = all(bool(c.get("ok")) for c in checks if isinstance(c, dict))
        body["styleCheck"] = style
    if args.before_image or args.after_image:
        if not (args.before_image and args.after_image):
            common.eprint("verify needs both --before-image and --after-image")
            return 2
        body["visual"] = {
            "beforeUrl": _attach(client, args.id, args.before_image, "after"),
            "afterUrl": _attach(client, args.id, args.after_image, "after"),
        }
    if not body:
        common.eprint("verify needs at least one of --repro-script/--before/--after, --style-json, --before-image/--after-image")
        return 2
    note = client.post("/cli/verify/" + args.id, body) or {}
    bits = []
    if "repro" in body:
        bits.append("repro " + body["repro"]["before"] + " -> " + body["repro"]["after"])
    if "styleCheck" in body:
        checks = body["styleCheck"].get("checks") or []
        ok = sum(1 for c in checks if isinstance(c, dict) and c.get("ok"))
        bits.append("style check " + str(ok) + "/" + str(len(checks)))
    if "visual" in body:
        bits.append("before/after attached")
    print("Pin #" + str(_g(note, "number", default="?")) + " evidence recorded: " + ", ".join(bits))
    return 0


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def build_parser():
    parser = argparse.ArgumentParser(prog="build_notes", description="Build Mode command line for Claude Code.")
    parser.add_argument("--api", help="API base URL (default: NEXUS_API_BASE or the dev API)")
    parser.add_argument("--token", help="Build Token (default: NEXUS_BUILD_TOKEN or ~/.config/nexus/build-notes.token)")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("whoami", help="who owns this token").set_defaults(func=cmd_whoami)

    p = sub.add_parser("list", help="list pins")
    p.add_argument("--status", help="open | dispatched | building | needs_input | pr_open | fixed | done | dismissed")
    p.add_argument("--route", help="only pins on this route (view id)")
    p.add_argument("--mine", action="store_true", help="only my pins")
    p.add_argument("--limit", type=int, default=100)
    p.add_argument("--json", action="store_true", help="raw JSON")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("claim", help="claim pins, download their media, print the briefs")
    p.add_argument("ids", nargs="+")
    p.add_argument("--out", help="download folder (default ~/.cache/nexus-build-notes)")
    p.add_argument("--no-download", action="store_true", help="print the briefs with the signed URLs instead of downloading")
    p.set_defaults(func=cmd_claim)

    p = sub.add_parser("progress", help="post a one-line progress note")
    p.add_argument("id")
    p.add_argument("text", nargs="+")
    p.set_defaults(func=cmd_progress)

    p = sub.add_parser("reply", help="reply on a pin's thread as Claude")
    p.add_argument("id")
    p.add_argument("text", nargs="*")
    p.add_argument("--needs-input", action="store_true", help="ask the author a question and wait")
    p.add_argument("--answered", action="store_true", help="a Question pin is answered - closes it")
    p.add_argument("--image", help="png/jpg/webp to attach with the reply")
    p.set_defaults(func=cmd_reply)

    p = sub.add_parser("after", help="attach an after screenshot")
    p.add_argument("id")
    p.add_argument("--image", required=True)
    p.set_defaults(func=cmd_after)

    p = sub.add_parser("complete", help="record the PR on the pins")
    p.add_argument("ids", nargs="+")
    p.add_argument("--pr", required=True, help="PR URL")
    p.add_argument("--branch", required=True)
    p.add_argument("--summary")
    p.add_argument("--pr-number", type=int, help="override the number read from the URL")
    p.set_defaults(func=cmd_complete)

    p = sub.add_parser("verify", help="record the evidence that the fix is right")
    p.add_argument("id")
    p.add_argument("--repro-script", help="the Playwright repro script file (its contents are stored)")
    p.add_argument("--before", choices=VERIFY_STATES, help="repro result on origin/dev code")
    p.add_argument("--after", choices=VERIFY_STATES, help="repro result on the branch")
    p.add_argument("--style-json", help='{"passed": bool, "checks": [{"prop", "expected", "actual", "ok"}]} file')
    p.add_argument("--before-image", help="screenshot before the fix (png/jpg/webp)")
    p.add_argument("--after-image", help="screenshot after the fix (png/jpg/webp)")
    p.set_defaults(func=cmd_verify)
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        client = common.make_client(args.api, args.token)
        return args.func(client, args)
    except common.ConfigError as exc:
        common.eprint(str(exc))
        return 2
    except common.ApiError as exc:
        common.eprint(str(exc))
        return 1
    except KeyboardInterrupt:
        common.eprint("Stopped.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
