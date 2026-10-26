"""Process, git and HTTP plumbing shared by `preview.py` (Ready To Check) and
`run_e2e.py` (regression specs run the way CI runs them).

Everything that touches the outside world goes through one `System` object so
the tests can swap in a fake that records what would have run. Standard
library only, Python 3.9 compatible.
"""

import os
import re
import signal
import socket
import sqlite3
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class StackError(Exception):
    """A step of starting a local stack failed - the message says which."""


def _tail_text(text, lines=20):
    rows = [r for r in str(text or "").splitlines() if r.strip()]
    return "\n".join(rows[-lines:])


class System:
    """The real thing: subprocesses, signals, sockets, urllib, the clock."""

    def run(self, cmd, cwd=None, env=None, check=True, timeout=None):
        """Run a command to completion; returns (exit code, combined output)."""
        try:
            res = subprocess.run(
                [str(c) for c in cmd], cwd=str(cwd) if cwd else None, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                universal_newlines=True, timeout=timeout, check=False,
            )
        except FileNotFoundError:
            raise StackError("Command not found: " + str(cmd[0]))
        except subprocess.TimeoutExpired:
            raise StackError(" ".join(str(c) for c in cmd[:3]) + " did not finish in " + str(timeout) + "s")
        if check and res.returncode != 0:
            raise StackError(" ".join(str(c) for c in cmd[:4]) + " failed (exit " + str(res.returncode) + "):\n"
                             + _tail_text(res.stdout))
        return res.returncode, res.stdout or ""

    def run_live(self, cmd, cwd=None, env=None, timeout=None):
        """Run a command with its output streaming to this terminal; returns the exit code."""
        try:
            return subprocess.run([str(c) for c in cmd], cwd=str(cwd) if cwd else None, env=env,
                                  stdin=subprocess.DEVNULL, timeout=timeout, check=False).returncode
        except FileNotFoundError:
            raise StackError("Command not found: " + str(cmd[0]))
        except subprocess.TimeoutExpired:
            raise StackError(" ".join(str(c) for c in cmd[:3]) + " did not finish in " + str(timeout) + "s")

    def spawn(self, cmd, cwd, env, log_path):
        """Start a detached process (its own session, so it outlives this
        script and a group kill takes its children too); returns the pid."""
        log_path = Path(log_path)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(str(log_path), "ab") as log:
            try:
                proc = subprocess.Popen([str(c) for c in cmd], cwd=str(cwd), env=env, stdout=log,
                                        stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                        start_new_session=True)
            except FileNotFoundError:
                raise StackError("Command not found: " + str(cmd[0]))
        return proc.pid

    def alive(self, pid):
        if not pid:
            return False
        try:
            # Our own child that already exited is a zombie until reaped -
            # kill(pid, 0) would still say it is there.
            done, _ = os.waitpid(pid, os.WNOHANG)
            if done == pid:
                return False
        except ChildProcessError:
            pass
        except OSError:
            pass
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    def command_of(self, pid):
        """The command line of a running pid ('' when it is gone)."""
        try:
            code, out = self.run(["ps", "-p", str(int(pid)), "-o", "command="], check=False, timeout=10)
        except StackError:
            return ""
        return out.strip() if code == 0 else ""

    def terminate(self, pid, timeout=10):
        """SIGTERM the process group, then SIGKILL whatever is left."""
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(pid, sig)
            except (ProcessLookupError, PermissionError, OSError):
                try:
                    os.kill(pid, sig)
                except (ProcessLookupError, PermissionError, OSError):
                    return
            deadline = time.time() + (timeout if sig == signal.SIGTERM else 3)
            while time.time() < deadline:
                if not self.alive(pid):
                    return
                time.sleep(0.2)

    def http_ok(self, url, timeout=3):
        """Does the URL answer with anything below 500?"""
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "nexus-build-notes"}),
                                        timeout=timeout) as resp:
                return resp.status < 500
        except urllib.error.HTTPError as exc:
            return exc.code < 500
        except (urllib.error.URLError, OSError, ValueError):
            return False

    def port_busy(self, port):
        for host in ("127.0.0.1", "::1"):
            try:
                with socket.create_connection((host, int(port)), timeout=0.5):
                    return True
            except OSError:
                continue
        return False

    def free_port(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    def hostname(self):
        return socket.gethostname()

    def sleep(self, seconds):
        time.sleep(seconds)

    def now(self):
        return time.time()


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def slug(text):
    """'build/tasks-home-1024' -> 'build-tasks-home-1024' (a safe folder name)."""
    s = re.sub(r"[^a-z0-9._-]+", "-", str(text or "").strip().lower()).strip("-.")
    return s or "preview"


def main_checkout(system, cwd=None):
    """The main checkout of this repository (where node_modules, the backend
    virtualenv, backend/.env and the local database live), also when the
    current directory is a linked worktree."""
    cwd = Path(cwd or os.getcwd())
    _, out = system.run(["git", "rev-parse", "--git-common-dir"], cwd=cwd, timeout=30)
    common_dir = Path(out.strip().splitlines()[-1] if out.strip() else ".git")
    if not common_dir.is_absolute():
        common_dir = (cwd / common_dir)
    return Path(os.path.abspath(str(common_dir))).parent


def read_env_file(path):
    """KEY=VALUE pairs from a .env file. Never printed - callers take only the
    keys they need."""
    values = {}
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return values
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].strip()
        values[key.strip()] = value
    return values


def log_tail(path, lines=20):
    try:
        return _tail_text(Path(path).read_text(encoding="utf-8", errors="replace"), lines)
    except OSError:
        return ""


def copy_sqlite(src, dest):
    """A consistent copy of a SQLite database (the backup API, so a dev server
    writing to it at the same time cannot leave a torn copy). The source is
    opened read-only."""
    src = Path(src).resolve()
    dest = Path(dest)
    if dest.resolve() == src:
        raise StackError("Refusing to copy " + str(src) + " onto itself")
    dest.parent.mkdir(parents=True, exist_ok=True)
    for suffix in ("", "-wal", "-shm", "-journal"):
        try:
            Path(str(dest) + suffix).unlink()
        except OSError:
            pass
    source = sqlite3.connect("file:" + urllib.parse.quote(str(src)) + "?mode=ro", uri=True)
    try:
        target = sqlite3.connect(str(dest))
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()
    return dest


def wait_until_up(system, urls, procs, timeout, label="the stack"):
    """Wait until every URL answers. `procs` maps a name to (pid, log path);
    a process that exits stops the wait at once with its log tail."""
    deadline = system.now() + timeout
    pending = list(urls)
    while True:
        for name, (pid, log) in procs.items():
            if not system.alive(pid):
                tail = log_tail(log)
                raise StackError("The " + name + " exited while starting" + (":\n" + tail if tail else "")
                                 + "\n(full log: " + str(log) + ")")
        pending = [u for u in pending if not system.http_ok(u)]
        if not pending:
            return
        if system.now() >= deadline:
            raise StackError(label + " did not answer within " + str(int(timeout)) + "s: " + ", ".join(pending))
        system.sleep(1)


def link_node_modules(main_root, worktree, sub):
    """Symlink <worktree>/<sub>/node_modules to the main checkout's copy.
    Returns False when the main checkout has none."""
    src = Path(main_root) / sub / "node_modules"
    dest = Path(worktree) / sub / "node_modules"
    if not src.is_dir():
        return False
    if dest.is_symlink() or dest.exists():
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(str(src), str(dest))
    return True
