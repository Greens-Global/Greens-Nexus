#!/usr/bin/env python3
"""Connect this computer's Claude Code to your Nexus Build Mode - once.

Nexus > Build Mode > Connect My Claude Code shows this command with your
token and your Nexus's API in it. Paste it into a terminal in VS Code, at the
repository root:

    python tools/build_notes/connect.py nxbn_... --api https://...

It
  1. saves the token (~/.config/nexus/build-notes.token) and the API
     (~/.config/nexus/build-notes.api) for every Build Mode tool,
  2. checks them with Nexus (whoami),
  3. adds the "Nexus: Build Notes Watcher" task to .vscode/tasks.json so the
     watcher starts in its own VS Code terminal whenever this folder opens
     (VS Code asks once to allow automatic tasks),
  4. starts the watcher in this terminal - from now on Send To Claude Code
     starts Claude Code right here, for the pins YOU send.

Standard library only. Run it again any time (a new token, another Nexus).
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

try:  # run as a module (tests) or as a script
    from . import common
except ImportError:  # pragma: no cover - script mode
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import common

TASK_LABEL = "Nexus: Build Notes Watcher"


def watcher_task(python=None):
    """The VS Code task: the watcher in a dedicated terminal, started when the folder opens."""
    return {
        "label": TASK_LABEL,
        "type": "process",
        "command": python or sys.executable,
        "args": ["${workspaceFolder}/tools/build_notes/watch.py"],
        "options": {"cwd": "${workspaceFolder}"},
        "isBackground": False,
        "presentation": {"reveal": "always", "panel": "dedicated", "focus": False, "clear": True},
        "runOptions": {"runOn": "folderOpen"},
        "problemMatcher": [],
    }


def upsert_task(tasks_file, task):
    """Add or replace the watcher task in tasks.json. Returns 'added',
    'updated', or 'skipped' when the file is not plain JSON (comments) -
    never overwrites a file it cannot read."""
    data = {"version": "2.0.0", "tasks": []}
    if tasks_file.exists():
        try:
            data = json.loads(tasks_file.read_text(encoding="utf-8") or "{}")
        except ValueError:
            return "skipped"
        if not isinstance(data, dict):
            return "skipped"
        data.setdefault("version", "2.0.0")
        data.setdefault("tasks", [])
    tasks = [t for t in data["tasks"] if not (isinstance(t, dict) and t.get("label") == TASK_LABEL)]
    state = "updated" if len(tasks) != len(data["tasks"]) else "added"
    data["tasks"] = tasks + [task]
    tasks_file.parent.mkdir(parents=True, exist_ok=True)
    tasks_file.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return state


def save(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass  # Windows: the file sits in the user's own profile


def main(argv=None):
    parser = argparse.ArgumentParser(description="Connect this computer's Claude Code to your Nexus Build Mode.")
    parser.add_argument("token", help="the Build Token Nexus showed you (nxbn_...)")
    parser.add_argument("--api", help="your Nexus API address (Nexus puts it in the command)")
    parser.add_argument("--no-watch", action="store_true", help="connect only - do not start the watcher here")
    parser.add_argument("--repo", help="repository root (default: two levels up from this script)")
    args = parser.parse_args(argv)

    token = (args.token or "").strip()
    if not token.startswith(common.TOKEN_PREFIX):
        print("That is not a Build Token - copy the whole command from Nexus > Build Mode > Connect My Claude Code.", file=sys.stderr)
        return 2
    api = common.resolve_api_base(args.api)

    try:
        me = common.Client(api, token).get("/cli/whoami")
    except common.ApiError as exc:
        print("Nexus did not accept the token: " + str(exc), file=sys.stderr)
        return 1

    save(common.TOKEN_FILE, token)
    save(common.API_FILE, api)
    print("Connected as " + str(me.get("email", "")) + " to " + api)

    repo = Path(args.repo).resolve() if args.repo else common.repo_root()
    state = upsert_task(repo / ".vscode" / "tasks.json", watcher_task())
    if state == "skipped":
        print("Note: .vscode/tasks.json has comments, so it was left alone. To start the watcher with VS Code,")
        print('add this task to it:\n' + json.dumps(watcher_task(), indent=2))
    else:
        print("VS Code will start the watcher whenever this folder opens (it asks once to allow automatic tasks).")

    if args.no_watch:
        return 0
    print("Starting the watcher here - leave this terminal open. Send To Claude Code in Nexus starts Claude Code in it.")
    return subprocess.call([sys.executable, str(Path(__file__).resolve().parent / "watch.py")], cwd=str(repo))


if __name__ == "__main__":
    sys.exit(main())
