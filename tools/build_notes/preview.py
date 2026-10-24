#!/usr/bin/env python3
"""Ready To Check: run a Build Session's branch on this computer so the pin's
author can try the fix before the PR merges.

    python3 tools/build_notes/preview.py start --branch NAME --pins <id> [<id> ...]
                                               [--pr N] [--db PATH] [--no-post]
    python3 tools/build_notes/preview.py stop
    python3 tools/build_notes/preview.py status

`start` checks the branch out in its own worktree under
~/.cache/nexus-build-notes/preview/<branch-slug> (reused and hard reset to
origin/<branch> when it is there), links the main checkout's
frontend/node_modules, and starts:

  - the backend on http://localhost:8090 with the main checkout's
    backend/.venv python, NEXUS_SKIP_AUTH=true, NEXUS_DEV_EMAIL from the main
    checkout's backend/.env, and ALWAYS DATABASE_URL=sqlite:///./preview.db -
    a COPY of your local backend/greens_nexus.db (never the original, never an
    inherited DATABASE_URL: the branch's migrations must never run against the
    shared dev database). No local database: a fresh, empty SQLite.
  - the frontend (vite) on http://localhost:5180 --strictPort with
    VITE_API_BASE=http://localhost:8090, VITE_DEV_SKIP_AUTH=true and
    VITE_DEV_USER_EMAIL=<the same email>.

Both run detached (pid files and logs in ~/.cache/nexus-build-notes/preview/),
`start` waits up to 90 s for /health and the vite root, then records the
preview on each pin (POST /dev-notes/cli/preview/{id} with the pin's own path
on http://localhost:5180 and the commit the worktree runs - the server drops
an Accept given on an older commit). One preview per computer: `start` stops the one
that was running. `stop` ends it and keeps the worktree.

Standard library only.
"""

import argparse
import datetime as _dt
import json
import os
import sys
from pathlib import Path

try:
    from . import cli, common, stack
except ImportError:  # run as a plain script: python3 tools/build_notes/preview.py
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import cli
    import common
    import stack

BACKEND_PORT = 8090
FRONTEND_PORT = 5180
API_URL = "http://localhost:" + str(BACKEND_PORT)
PREVIEW_URL = "http://localhost:" + str(FRONTEND_PORT)
PREVIEW_DB = "preview.db"
PREVIEW_DB_URL = "sqlite:///./" + PREVIEW_DB
HEALTH_TIMEOUT = 90
# Words that must appear in a pid's command line before `stop` signals it, so
# a stale pid file (after a reboot) never kills an unrelated process.
MARKERS = {"backend": "uvicorn", "frontend": "vite"}


def preview_dir():
    return common.CACHE_DIR / "preview"


def backend_env(base_env, email):
    """The backend's environment: everything inherited EXCEPT the database -
    DATABASE_URL is always the worktree's preview.db copy."""
    env = dict(base_env)
    env["DATABASE_URL"] = PREVIEW_DB_URL
    env["NEXUS_SKIP_AUTH"] = "true"
    env["NEXUS_DEV_EMAIL"] = email
    env["PYTHONUNBUFFERED"] = "1"
    return env


def frontend_env(base_env, email):
    env = dict(base_env)
    env.pop("VITE_E2E", None)
    env["VITE_API_BASE"] = API_URL
    env["VITE_DEV_SKIP_AUTH"] = "true"
    env["VITE_DEV_USER_EMAIL"] = email
    return env


def backend_command(python):
    return [str(python), "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(BACKEND_PORT)]


def frontend_command(worktree):
    return [str(Path(worktree) / "frontend" / "node_modules" / ".bin" / "vite"),
            "--port", str(FRONTEND_PORT), "--strictPort"]


class PreviewError(Exception):
    pass


class Preview:
    """start / stop / status. `system` does the processes, git and HTTP (a fake
    in the tests); `client_factory` builds the API client when pins are posted."""

    def __init__(self, system=None, client_factory=None, out=None, err=None, cwd=None, base_env=None):
        self.system = system or stack.System()
        self.client_factory = client_factory or (lambda: common.make_client())
        self.out = out or (lambda text="": print(text, flush=True))
        self.err = err or common.eprint
        self.cwd = Path(cwd or os.getcwd())
        self.base_env = dict(os.environ if base_env is None else base_env)
        self.dir = preview_dir()

    # -- state ----------------------------------------------------------------

    def _pid_file(self, name):
        return self.dir / (name + ".pid")

    def _log(self, name):
        return self.dir / (name + ".log")

    def _state_file(self):
        return self.dir / "current.json"

    def _read_state(self):
        try:
            return json.loads(self._state_file().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _read_pid(self, name):
        try:
            return int(self._pid_file(name).read_text(encoding="utf-8").strip() or 0)
        except (OSError, ValueError):
            return 0

    # -- stop -----------------------------------------------------------------

    def stop(self, quiet=False):
        """Kill the running preview by its pid files; the worktree stays."""
        stopped = []
        for name in ("frontend", "backend"):
            pid = self._read_pid(name)
            if pid and self.system.alive(pid):
                command = self.system.command_of(pid)
                if MARKERS[name] in command:
                    self.system.terminate(pid)
                    stopped.append(name)
                else:
                    self.err("Not stopping pid " + str(pid) + " - it is no longer the preview " + name)
            try:
                self._pid_file(name).unlink()
            except OSError:
                pass
        state = self._read_state()
        if state:
            state["stoppedAt"] = _now_iso()
            self._write_state(state)
        if not quiet:
            self.out("Preview stopped (" + state.get("branch", "") + ")" if stopped and state.get("branch")
                     else ("Preview stopped" if stopped else "No preview running"))
        return 0

    # -- status ---------------------------------------------------------------

    def status(self):
        state = self._read_state()
        pids = {name: self._read_pid(name) for name in ("backend", "frontend")}
        up = {name: bool(pid) and self.system.alive(pid) for name, pid in pids.items()}
        if not state or not any(up.values()):
            self.out("No preview running" + (" (last: " + state.get("branch", "") + ", worktree " + state.get("worktree", "") + ")"
                                             if state.get("branch") else ""))
            return 1
        self.out("Preview of " + state.get("branch", "?") + (" (PR #" + str(state.get("prNumber")) + ")" if state.get("prNumber") else ""))
        self.out("  Worktree: " + state.get("worktree", "?"))
        self.out("  Data: " + state.get("db", "?"))
        self.out("  Frontend: " + PREVIEW_URL + " - pid " + str(pids["frontend"]) + (" (answering)" if self.system.http_ok(PREVIEW_URL + "/") else " (not answering)"))
        self.out("  Backend: " + API_URL + " - pid " + str(pids["backend"]) + (" (answering)" if self.system.http_ok(API_URL + "/health") else " (not answering)"))
        for pin in state.get("pins") or []:
            self.out("  Pin " + str(pin.get("id")) + ": " + str(pin.get("url") or ""))
        self.out("  Logs: " + str(self._log("backend")) + ", " + str(self._log("frontend")))
        return 0

    # -- start ----------------------------------------------------------------

    def _write_state(self, state):
        self.dir.mkdir(parents=True, exist_ok=True)
        self._state_file().write_text(json.dumps(state, indent=2), encoding="utf-8")

    def _email(self, main_root, explicit):
        if explicit:
            return explicit
        email = stack.read_env_file(main_root / "backend" / ".env").get("NEXUS_DEV_EMAIL", "").strip()
        if email:
            return email
        raise PreviewError("No NEXUS_DEV_EMAIL in " + str(main_root / "backend" / ".env")
                           + " - set it there (see CLAUDE.md, Run locally) or pass --email")

    def prepare_worktree(self, main_root, branch):
        """origin/<branch> checked out (detached - the branch itself is usually
        checked out in the main checkout) in the preview folder."""
        worktree = self.dir / stack.slug(branch)
        self.system.run(["git", "fetch", "origin", branch], cwd=main_root, timeout=300)
        ref = "origin/" + branch
        if (worktree / ".git").exists():
            self.system.run(["git", "reset", "--hard", ref], cwd=worktree, timeout=120)
        elif worktree.exists():
            raise PreviewError(str(worktree) + " exists but is not a git worktree - remove it and start again")
        else:
            self.dir.mkdir(parents=True, exist_ok=True)
            self.system.run(["git", "worktree", "prune"], cwd=main_root, timeout=60)
            self.system.run(["git", "worktree", "add", "--detach", str(worktree), ref], cwd=main_root, timeout=300)
        return worktree

    def prepare_db(self, main_root, worktree, db=None):
        """Copy the developer's local database into the worktree as
        backend/preview.db. Returns a one-line description of the data."""
        dest = worktree / "backend" / PREVIEW_DB
        src = Path(db).expanduser() if db else main_root / "backend" / "greens_nexus.db"
        if db and not src.is_file():
            raise PreviewError("--db " + str(src) + " is not a file")
        if src.is_file():
            if src.resolve() == dest.resolve():
                raise PreviewError("The preview database cannot be the source database itself")
            stack.copy_sqlite(src, dest)
            return "a copy of " + str(src)
        for suffix in ("", "-wal", "-shm", "-journal"):
            try:
                Path(str(dest) + suffix).unlink()
            except OSError:
                pass
        self.err("Warning: no local database at " + str(src) + " - the preview starts on a fresh, empty SQLite database")
        return "a fresh, empty SQLite database (no local greens_nexus.db)"

    def start(self, branch, pins, pr=0, db=None, post=True, email=None):
        branch = str(branch or "").strip()
        if not branch:
            raise PreviewError("start needs --branch")
        # One preview per computer: whatever was running goes first.
        self.stop(quiet=True)
        main_root = stack.main_checkout(self.system, self.cwd)
        python = main_root / "backend" / ".venv" / "bin" / "python"
        if not python.exists():
            raise PreviewError("No backend virtualenv at " + str(python) + " - create it in the main checkout first")
        if not (main_root / "frontend" / "node_modules").is_dir():
            raise PreviewError("No frontend/node_modules in " + str(main_root) + " - run npm install in frontend first")
        user = self._email(main_root, email)
        for port in (BACKEND_PORT, FRONTEND_PORT):
            if self.system.port_busy(port):
                raise PreviewError("Port " + str(port) + " is already in use by something that is not the preview - free it and start again")

        self.out("Preparing the preview of " + branch + "...")
        worktree = self.prepare_worktree(main_root, branch)
        _, head = self.system.run(["git", "rev-parse", "HEAD"], cwd=worktree, timeout=30)
        commit = head.strip().splitlines()[-1] if head.strip() else ""
        stack.link_node_modules(main_root, worktree, "frontend")
        data = self.prepare_db(main_root, worktree, db)

        self.dir.mkdir(parents=True, exist_ok=True)
        logs = {name: self._log(name) for name in ("backend", "frontend")}
        for log in logs.values():
            try:
                log.unlink()
            except OSError:
                pass
        backend_pid = self.system.spawn(backend_command(python), worktree / "backend",
                                        backend_env(self.base_env, user), logs["backend"])
        self._pid_file("backend").write_text(str(backend_pid), encoding="utf-8")
        frontend_pid = self.system.spawn(frontend_command(worktree), worktree / "frontend",
                                         frontend_env(self.base_env, user), logs["frontend"])
        self._pid_file("frontend").write_text(str(frontend_pid), encoding="utf-8")
        state = {
            "branch": branch, "commit": commit, "worktree": str(worktree), "prNumber": int(pr or 0), "db": data,
            "backend": {"pid": backend_pid, "url": API_URL, "log": str(logs["backend"])},
            "frontend": {"pid": frontend_pid, "url": PREVIEW_URL, "log": str(logs["frontend"])},
            "startedAt": _now_iso(), "pins": [{"id": p} for p in pins],
        }
        self._write_state(state)
        try:
            stack.wait_until_up(self.system, [API_URL + "/health", PREVIEW_URL + "/"],
                                {"backend": (backend_pid, logs["backend"]), "frontend": (frontend_pid, logs["frontend"])},
                                HEALTH_TIMEOUT, label="The preview")
        except stack.StackError:
            self.stop(quiet=True)
            raise
        self.out("Ready To Check on " + PREVIEW_URL + " - open it on this computer")
        self.out("  Branch: " + branch + (" at " + commit[:9] if commit else "") + "  Data: " + data)

        if not post or not pins:
            return 0
        client = self.client_factory()
        host = self.system.hostname()
        failed = 0
        for i, note_id in enumerate(pins):
            try:
                note, body = cli.post_preview(client, note_id, PREVIEW_URL, branch, pr, host, commit=commit)
            except common.ApiError as exc:
                if exc.status in (401, 403):
                    raise
                failed += 1
                self.err("Preview not recorded on pin " + note_id + " - " + str(exc.detail or exc.message))
                continue
            state["pins"][i]["url"] = body["url"]
            self.out("  Pin #" + str(note.get("number") or "?") + " Ready To Check: " + body["url"])
        self._write_state(state)
        return 1 if failed else 0


def _now_iso():
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def main(argv=None, preview=None):
    parser = argparse.ArgumentParser(prog="preview.py", description="Ready To Check: run a branch locally for the pin's author.")
    parser.add_argument("--api", help="API base URL (default: NEXUS_API_BASE or the dev API)")
    parser.add_argument("--token", help="Build Token (default: NEXUS_BUILD_TOKEN or ~/.config/nexus/build-notes.token)")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("start", help="start the branch's preview and record it on the pins")
    p.add_argument("--branch", required=True)
    p.add_argument("--pins", nargs="*", default=[], help="pin ids to mark Ready To Check")
    p.add_argument("--pr", help="PR number or URL (default: each pin's own)")
    p.add_argument("--db", help="SQLite file to copy (default: the main checkout's backend/greens_nexus.db)")
    p.add_argument("--email", help="who the preview signs in as (default: NEXUS_DEV_EMAIL from backend/.env)")
    p.add_argument("--no-post", action="store_true", help="start the preview without recording it on the pins")
    sub.add_parser("stop", help="stop the running preview (the worktree stays)")
    sub.add_parser("status", help="what is running")
    args = parser.parse_args(argv)

    if preview is None:
        preview = Preview(client_factory=lambda: common.make_client(args.api, args.token))
    try:
        if args.command == "stop":
            return preview.stop()
        if args.command == "status":
            return preview.status()
        pins = list(dict.fromkeys(args.pins or []))
        return preview.start(args.branch, pins, pr=cli.pr_arg(args.pr), db=args.db, post=not args.no_post, email=args.email)
    except (PreviewError, stack.StackError, common.ConfigError) as exc:
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
