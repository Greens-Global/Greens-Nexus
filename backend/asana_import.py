#!/usr/bin/env python
"""
Asana → Nexus task importer (one-off migration tool).

Reads projects / tasks / subtasks / comments / attachments from the Asana REST
API and recreates them in the Nexus Task module *through the Nexus REST API* (so
task codes, validation and notifications behave normally — no raw DB writes).

  - Comments  : Asana "stories" of type comment → Nexus task comments, with the
                original author (by email) and date preserved. Use
                --silent-comments to backfill without firing notifications.
  - Attachments: Asana-hosted files under --attach-max-mb are downloaded and
                inlined (self-contained, no expiring links); larger/external
                files keep a permanent link.

------------------------------------------------------------------------------
QUICK START (local dev — the backend on :8000 runs with NEXUS_SKIP_AUTH, so no
Nexus token is needed):

    cd backend
    export ASANA_TOKEN='1/your-asana-personal-access-token'
    # dry run first — see what WOULD be imported, write nothing:
    .venv/Scripts/python.exe asana_import.py --projects 12345 67890 --dry-run
    # then for real:
    .venv/Scripts/python.exe asana_import.py --projects 12345 67890

  Find a project's GID: open the project in Asana; the URL is
  https://app.asana.com/0/<PROJECT_GID>/list  → the middle number is the GID.
  Or pass --workspace <WORKSPACE_GID> to import EVERY project in a workspace.

LATER (shared dev — needs a real bearer token for the deployed API):

    export NEXUS_TOKEN='<azure-id-token>'
    .venv/Scripts/python.exe asana_import.py --projects 12345 \
        --nexus https://YOUR-DEV-API-HOST

------------------------------------------------------------------------------
Idempotent: writes `asana_import_state.json` mapping Asana GID → Nexus id, so
re-running skips anything already imported (safe to resume after an error).

Assignee mapping: Asana identifies people by account; Nexus by work email. The
script uses the Asana assignee's email when present. Override/patch with a JSON
map file:  --email-map map.json   e.g.  {"jo@asana-personal.com": "jo@greensglobal.com"}
Keys may be Asana emails OR Asana display names. Unmatched → left unassigned.
"""
import argparse
import base64
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ASANA_BASE = "https://app.asana.com/api/1.0"
STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "asana_import_state.json")

TASK_OPT_FIELDS = (
    "name,notes,completed,due_on,due_at,assignee.email,assignee.name,"
    "parent,tags.name,memberships.section.name,custom_fields.name,"
    "custom_fields.display_value,custom_fields.enum_value.name"
)


class ImportError_(RuntimeError):
    """Raised on an API/network failure. A plain Exception (not SystemExit) so it
    can be caught when this module is used in-process (e.g. the Manage import
    endpoint); the CLI catches it in main() and exits cleanly."""


# ── tiny HTTP helpers (stdlib only) ──────────────────────────────────────────
def _request(method, url, headers, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            # Asana rate-limits with 429 + Retry-After.
            if e.code == 429 and attempt < 3:
                wait = int(e.headers.get("Retry-After", "5"))
                time.sleep(wait)
                continue
            detail = e.read().decode(errors="ignore")[:300]
            raise ImportError_(f"HTTP {e.code} {method} {url} — {detail}")
        except urllib.error.URLError as e:
            if attempt < 3:
                time.sleep(2 * (attempt + 1))
                continue
            raise ImportError_(f"Network error {method} {url}: {e}")


class Asana:
    def __init__(self, token):
        self.h = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

    def get(self, path, **params):
        """GET with automatic pagination — returns the concatenated `data` list
        (or the single object for detail endpoints)."""
        params.setdefault("limit", 100)
        out, offset = [], None
        while True:
            q = dict(params)
            if offset:
                q["offset"] = offset
            url = f"{ASANA_BASE}{path}?{urllib.parse.urlencode(q)}"
            payload = _request("GET", url, self.h)
            data = payload.get("data")
            if isinstance(data, list):
                out.extend(data)
                offset = (payload.get("next_page") or {}).get("offset")
                if not offset:
                    return out
            else:
                return data  # detail object


class Nexus:
    def __init__(self, base, token=None):
        self.base = base.rstrip("/")
        self.h = {"Content-Type": "application/json"}
        if token:
            self.h["Authorization"] = f"Bearer {token}"

    def post(self, path, body):
        return _request("POST", self.base + path, self.h, body)

    def patch(self, path, body):
        return _request("PATCH", self.base + path, self.h, body)


# ── state (idempotency) ──────────────────────────────────────────────────────
def load_state():
    state = {"projects": {}, "sections": {}, "tasks": {}, "comments": {}, "attachments": {}}
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH, encoding="utf-8") as f:
            state.update(json.load(f))
    for k in ("projects", "sections", "tasks", "comments", "attachments"):
        state.setdefault(k, {})
    return state


def save_state(state):
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)


# ── mapping ──────────────────────────────────────────────────────────────────
def resolve_assignee(task, email_map):
    a = task.get("assignee") or {}
    email = (a.get("email") or "").lower()
    name = a.get("name") or ""
    if email in email_map:
        return email_map[email]
    if name in email_map:
        return email_map[name]
    return email  # may be "" → unassigned


def priority_from_custom(task):
    """If Asana has a 'Priority' enum custom field, map it to Nexus buckets."""
    for cf in task.get("custom_fields") or []:
        if (cf.get("name") or "").lower() == "priority":
            val = ((cf.get("enum_value") or {}).get("name") or cf.get("display_value") or "").lower()
            if "urgent" in val or "critical" in val or "highest" in val:
                return "urgent"
            if "high" in val:
                return "high"
            if "low" in val:
                return "low"
            if "med" in val or "normal" in val:
                return "medium"
    return "medium"


def section_name(task):
    for m in task.get("memberships") or []:
        sec = (m.get("section") or {}).get("name")
        if sec and sec.lower() != "untitled section":
            return sec
    return ""


# ── import ───────────────────────────────────────────────────────────────────
def import_project(asana, nexus, project_gid, state, email_map, args):
    proj = asana.get(f"/projects/{project_gid}", opt_fields="name,notes")
    pname = proj.get("name") or f"Asana {project_gid}"
    print(f"\n=== Project: {pname}  ({project_gid}) ===")

    # 1) project
    if project_gid in state["projects"]:
        nexus_pid = state["projects"][project_gid]
        print(f"  project already imported → {nexus_pid}")
    elif args.dry_run:
        nexus_pid = f"DRY-{project_gid}"
        print(f"  [dry-run] would create project '{pname}'")
    else:
        created = nexus.post("/task-projects", {"name": pname, "description": proj.get("notes") or ""})
        nexus_pid = created["id"]
        state["projects"][project_gid] = nexus_pid
        save_state(state)
        print(f"  created project → {nexus_pid}")

    # 2) top-level tasks (subtasks fetched per-task below)
    tasks = asana.get(f"/projects/{project_gid}/tasks", opt_fields=TASK_OPT_FIELDS)
    print(f"  {len(tasks)} top-level tasks")
    counts = {"created": 0, "skipped": 0, "subtasks": 0, "comments": 0, "attachments": 0}
    for t in tasks:
        _import_task(asana, nexus, t, nexus_pid, "", state, email_map, args, counts)
    print(f"  done: +{counts['created']} tasks, +{counts['subtasks']} subtasks, "
          f"+{counts['comments']} comments, +{counts['attachments']} attachments, "
          f"{counts['skipped']} tasks already present")


def _ensure_section(nexus, nexus_pid, name, state, args):
    if not name:
        return ""
    key = f"{nexus_pid}:{name}"
    if key in state["sections"]:
        return state["sections"][key]
    if args.dry_run:
        return ""
    sec = nexus.post("/tasks/meta/sections", {"project_id": nexus_pid, "name": name})
    state["sections"][key] = sec["id"]
    save_state(state)
    return sec["id"]


def _import_comments(asana, nexus, task_gid, nexus_task_id, state, email_map, args, counts):
    """Asana stories of type 'comment' → Nexus task comments. Original author +
    date are preserved (author_email is honoured by the API; the date is prefixed
    into the body because Nexus stamps its own created_at)."""
    if args.no_comments:
        return
    stories = asana.get(f"/tasks/{task_gid}/stories",
                        opt_fields="type,resource_subtype,text,created_at,created_by.name,created_by.email")
    for s in stories:
        if s.get("type") != "comment" and s.get("resource_subtype") != "comment_added":
            continue
        sgid = s["gid"]
        if sgid in state["comments"]:
            continue
        text = (s.get("text") or "").strip()
        if not text:
            continue
        cb = s.get("created_by") or {}
        author = (cb.get("email") or "").lower()
        author = email_map.get(author) or email_map.get((cb.get("name") or "").lower()) or author
        prov = " · ".join([p for p in (cb.get("name"), (s.get("created_at") or "")[:10]) if p])
        body = f"[Asana · {prov}]\n{text}" if prov else text
        if args.dry_run:
            counts["comments"] += 1
            continue
        payload = {"body": body}
        if author:
            payload["author_email"] = author
        path = f"/tasks/{nexus_task_id}/comments" + ("?notify=false" if args.silent_comments else "")
        c = nexus.post(path, payload)
        state["comments"][sgid] = c["id"]
        save_state(state)
        counts["comments"] += 1


def _import_attachments(asana, nexus, task_gid, nexus_task_id, state, args, counts):
    """Asana attachments → Nexus task attachments. Asana-hosted files under the
    size cap are downloaded and inlined as a data URL (self-contained, no expiry);
    larger or external files keep a permanent link."""
    if args.no_attachments:
        return
    atts = asana.get(f"/tasks/{task_gid}/attachments",
                     opt_fields="name,download_url,permanent_url,view_url,size,resource_subtype,host")
    cap = args.attach_max_mb * 1024 * 1024
    for a in atts:
        agid = a["gid"]
        if agid in state["attachments"]:
            continue
        name = a.get("name") or "attachment"
        size_bytes = a.get("size") or 0
        kind = "image" if (mimetypes.guess_type(name)[0] or "").startswith("image/") else "doc"
        host = a.get("host") or ""
        url = ""
        if host and host != "asana":
            # external service (Drive/Dropbox/link) — keep the permanent link
            url = a.get("permanent_url") or a.get("view_url") or a.get("download_url") or ""
        else:
            dl = a.get("download_url")
            if dl and 0 < (size_bytes or 0) <= cap:
                try:
                    with urllib.request.urlopen(dl, timeout=90) as r:
                        raw = r.read()
                    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
                    url = f"data:{mime};base64,{base64.b64encode(raw).decode()}"
                except Exception:
                    url = a.get("view_url") or dl or ""     # fall back to a link
            else:
                url = a.get("view_url") or dl or ""          # too big / no size → link
        if args.dry_run:
            counts["attachments"] += 1
            continue
        na = nexus.post(f"/tasks/{nexus_task_id}/attachments",
                        {"name": name, "size": f"{max(1, round((size_bytes or 0) / 1024))} KB", "kind": kind, "url": url})
        state["attachments"][agid] = na["id"]
        counts["attachments"] += 1
        save_state(state)


def _import_task(asana, nexus, t, nexus_pid, parent_id, state, email_map, args, counts):
    gid = t["gid"]
    if gid in state["tasks"]:
        counts["skipped"] += 1
        nexus_id = state["tasks"][gid]
    else:
        body = {
            "title": t.get("name") or "(untitled)",
            "description": t.get("notes") or "",
            "priority": priority_from_custom(t),
            "assignee_email": resolve_assignee(t, email_map),
            "project_id": nexus_pid if not parent_id else "",
            "section_id": _ensure_section(nexus, nexus_pid, section_name(t), state, args) if not parent_id else "",
            "parent_task_id": parent_id,
            "tags": [tg.get("name") for tg in (t.get("tags") or []) if tg.get("name")],
            "due_on": t.get("due_on") or (t.get("due_at") or "")[:10],
            "status": "not_started",
        }
        label = "subtask" if parent_id else "task"
        if args.dry_run:
            print(f"    [dry-run] would create {label}: {body['title']}"
                  f"{'  → ' + body['assignee_email'] if body['assignee_email'] else ''}")
            nexus_id = f"DRY-{gid}"
        else:
            created = nexus.post("/tasks", body)
            nexus_id = created["id"]
            if t.get("completed"):
                nexus.patch(f"/tasks/{nexus_id}", {"completed": True})
            state["tasks"][gid] = nexus_id
            save_state(state)
        counts["subtasks" if parent_id else "created"] += 1

    # Comments + attachments — per-item state makes this safe to re-run, so even a
    # task that was created on a previous run gets its comments/attachments backfilled.
    if not str(nexus_id).startswith("DRY-") or args.dry_run:
        _import_comments(asana, nexus, gid, nexus_id, state, email_map, args, counts)
        _import_attachments(asana, nexus, gid, nexus_id, state, args, counts)

    # recurse into subtasks (Asana returns them only via this endpoint)
    if not args.no_subtasks:
        subs = asana.get(f"/tasks/{gid}/subtasks", opt_fields=TASK_OPT_FIELDS)
        for s in subs:
            _import_task(asana, nexus, s, nexus_pid, nexus_id, state, email_map, args, counts)


def main():
    # Windows consoles default to cp1252 and choke on the → / box characters in
    # help + progress output; force UTF-8 so the tool runs anywhere.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    ap = argparse.ArgumentParser(description="Import Asana tasks into Nexus via the REST API.")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--projects", nargs="+", metavar="GID", help="Asana project GIDs to import")
    src.add_argument("--workspace", metavar="GID", help="import every project in this workspace")
    ap.add_argument("--nexus", default="http://127.0.0.1:8000", help="Nexus API base URL (default: local dev)")
    ap.add_argument("--email-map", help="JSON file mapping Asana email/name → Nexus work email")
    ap.add_argument("--no-subtasks", action="store_true", help="skip subtask import (fewer API calls)")
    ap.add_argument("--no-comments", action="store_true", help="skip importing comments (Asana stories)")
    ap.add_argument("--silent-comments", action="store_true",
                    help="import comments without firing Nexus notifications (recommended for shared dev)")
    ap.add_argument("--no-attachments", action="store_true", help="skip importing attachments")
    ap.add_argument("--attach-max-mb", type=float, default=5.0,
                    help="max Asana-hosted attachment size to download+inline; larger files keep a link (default 5)")
    ap.add_argument("--dry-run", action="store_true", help="print what would happen, write nothing")
    args = ap.parse_args()

    token = os.getenv("ASANA_TOKEN")
    if not token:
        sys.exit("Set ASANA_TOKEN (an Asana Personal Access Token) in the environment.")
    email_map = {}
    if args.email_map:
        with open(args.email_map, encoding="utf-8") as f:
            email_map = {k.lower(): v for k, v in json.load(f).items()}

    asana = Asana(token)
    nexus = Nexus(args.nexus, os.getenv("NEXUS_TOKEN"))
    state = load_state()

    project_gids = args.projects
    if args.workspace:
        project_gids = [p["gid"] for p in asana.get("/projects", workspace=args.workspace, opt_fields="name")]
        print(f"Found {len(project_gids)} projects in workspace {args.workspace}")

    print(f"Target Nexus: {args.nexus}   {'(DRY RUN)' if args.dry_run else ''}")
    try:
        for gid in project_gids:
            import_project(asana, nexus, gid, state, email_map, args)
    except ImportError_ as e:
        sys.exit(f"\nImport failed: {e}")
    print("\nAll done." + ("  (dry run — nothing written)" if args.dry_run else f"  State: {STATE_PATH}"))


if __name__ == "__main__":
    main()
