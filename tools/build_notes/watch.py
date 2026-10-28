#!/usr/bin/env python3
"""Build Mode watcher: waits for pins sent from Nexus and hands them to Claude
Code in this terminal.

    python3 tools/build_notes/watch.py [--once] [--api URL] [--no-claude]
                                       [--claude-args "..."] [--timeout 25]

Long-polls GET /dev-notes/cli/wait. When pins arrive it runs
`claude "/build-notes <id> <id> ..."` with the repository root as the working
directory, so this terminal becomes the Claude Code session, then goes back to
waiting when Claude exits. Ctrl+C stops the watcher; while Claude is running,
Ctrl+C belongs to Claude.

Standard library only.
"""

import argparse
import os
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time

try:
    from . import cli, common
except ImportError:  # run as a plain script: python3 tools/build_notes/watch.py
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import cli
    import common

BANNER = "Build Mode - waiting for pins (Ctrl+C to stop)"
MAX_BACKOFF = 60                        # network trouble: 2 s doubling up to this
RELAUNCH_BACKOFF = (30, 60, 120, 300)   # Claude exited without claiming: wait this long before the next launch
DEFAULT_TIMEOUT = 25
SERVER_MAX_TIMEOUT = 50
CLAUDE_MISSING = 127
RESTART = 75           # main() asks the script entry to start the updated watcher

_sleep = time.sleep   # swapped out by the tests


def _say(text=""):
    print(text, flush=True)


def _dot():
    print(".", end="", flush=True)


def describe_batch(notes, sessions):
    """One line per session, then the pins, for the terminal."""
    titles = {s.get("id"): s.get("title") or "" for s in sessions or []}
    lines = []
    for s in sessions or []:
        title = s.get("title") or "Build Session"
        lines.append("Build Session: " + title + " (" + str(s.get("status") or "") + ")")
    for n in notes:
        kind = cli.kind_label(n.get("kind"))
        prio = cli.priority_label(n.get("priority"))
        who = n.get("createdBy") or n.get("created_by") or ""
        route = n.get("route") or ""
        sub = n.get("sub") or ""
        where = route + ("/" + sub if sub else "")
        sess = titles.get(n.get("sessionId") or n.get("session_id"))
        line = "  Pin #" + str(n.get("number") or "?") + " - " + kind + " - " + prio
        # A pin that is not freshly dispatched came back because the author
        # answered a question on it (needs_input / building with a new comment).
        # A pin the author reopened on the preview is back in Building with the
        # "Reopened On The Preview" entry and their note last (the same rule
        # as the brief); a later answer to a question is "(answered)".
        if cli.reopen_comment(n.get("thread") or []):
            line += " (reopened on the preview)"
        elif str(n.get("status") or "dispatched") != "dispatched":
            line += " (answered)"
        if where:
            line += " - " + where
        if who:
            line += " - " + who
        if sess:
            line += " [" + sess + "]"
        lines.append(line)
    return lines


def claude_command(ids, claude_args="", exe="claude"):
    cmd = [exe]
    args = shlex.split(claude_args) if claude_args else []
    if "--permission-mode" not in args:
        # Edits inside the repo go through without a prompt per file; shell
        # commands outside the skill's allowed-tools still ask.
        cmd.extend(["--permission-mode", "acceptEdits"])
    cmd.extend(args)
    cmd.append("/build-notes " + " ".join(ids))
    return cmd


def run_claude(ids, claude_args, cwd):
    """Run Claude Code in this terminal and return its exit code."""
    # The path `which` found, not the bare name: on Windows npm installs
    # claude.cmd / claude.ps1, and CreateProcess cannot start "claude" by name
    # (FileNotFoundError, Pranshu Oct 27) - the .cmd's full path it can.
    exe = shutil.which("claude")
    if exe is None:
        _say("The `claude` command is not on PATH.")
        return CLAUDE_MISSING
    cmd = claude_command(ids, claude_args, exe)
    _say("Starting Claude Code: " + " ".join(shlex.quote(c) for c in cmd))
    _say("(working directory: " + str(cwd) + ")")
    _say("")
    # Ctrl+C now belongs to Claude: the watcher ignores SIGINT while the child
    # runs and the child starts with the default handler again.
    previous = signal.getsignal(signal.SIGINT)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    kwargs = {}
    if os.name != "nt":
        kwargs["preexec_fn"] = lambda: signal.signal(signal.SIGINT, signal.SIG_DFL)
    try:
        completed = subprocess.run(cmd, check=False, cwd=str(cwd), **kwargs)
        return completed.returncode
    finally:
        signal.signal(signal.SIGINT, previous)


HEARTBEAT_SEC = 60   # well under the server's CONNECTED_SEC (150 s)


def _heartbeat(client, stop, every=HEARTBEAT_SEC):
    """While Claude Code runs the watcher is not long-polling, so its token
    goes quiet and Nexus said "Connect Claude Code First" after every pin
    (Pranshu, Oct 27). Use the token once a minute until Claude exits."""
    while not stop.wait(every):
        try:
            client.get("/cli/whoami", timeout=30)
        except Exception:  # noqa: BLE001 - the next beat or the next poll tries again
            pass


def _code_stamp():
    """When the watcher's own files last changed - a `git pull` that updates
    them changes this, and the idle watcher restarts itself (Pranshu, Oct 27:
    no restarting it by hand after every update)."""
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        return tuple(os.path.getmtime(os.path.join(here, f)) for f in ("watch.py", "common.py"))
    except OSError:   # mid-checkout: a file is briefly missing - no change yet
        return None


def wait_once(client, timeout):
    """One long-poll. Returns (notes, sessions)."""
    data = client.get("/cli/wait", query={"timeout": timeout}, timeout=timeout + 20) or {}
    notes = data.get("notes") or []
    sessions = data.get("sessions") or []
    return notes, sessions


def main(argv=None):
    parser = argparse.ArgumentParser(description="Wait for Build Mode pins and hand them to Claude Code.")
    parser.add_argument("--once", action="store_true", help="handle one batch of pins, then exit")
    parser.add_argument("--api", help="API base URL (default: the Nexus connect.py connected, else NEXUS_API_BASE, else the dev API)")
    parser.add_argument("--token", help="Build Token (default: NEXUS_BUILD_TOKEN or ~/.config/nexus/build-notes.token)")
    parser.add_argument("--no-claude", action="store_true", help="print the pin ids and exit instead of running Claude Code")
    parser.add_argument("--claude-args", default="", help='extra arguments for the claude command, e.g. "--model opus"')
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="long-poll seconds per request (max 50)")
    parser.add_argument("--repo", help="repository root to run Claude Code in (default: two levels up from this script)")
    args = parser.parse_args(argv)

    timeout = max(1, min(args.timeout, SERVER_MAX_TIMEOUT))
    try:
        client = common.make_client(args.api, args.token)
    except common.ConfigError as exc:
        _say(str(exc))
        return 2
    repo = os.path.abspath(args.repo) if args.repo else common.repo_root()

    # Health check: who does this token belong to?
    try:
        me = client.get("/cli/whoami", timeout=30) or {}
        label = me.get("tokenLabel") or me.get("token_label") or ""
        _say("Signed in as " + str(me.get("email") or "?") + (" (" + label + ")" if label else "")
             + " on " + client.api_base)
    except common.ApiError as exc:
        if exc.status in (401, 403):
            _say(str(exc))
            return 1
        _say("Warning: " + str(exc) + " - will keep trying.")

    _say(BANNER)
    stamp = _code_stamp()
    backoff = 2
    last_ids = None        # the ids handed to the previous Claude run
    relaunch_step = 0      # index into RELAUNCH_BACKOFF; reset when the id set changes
    try:
        while True:
            try:
                notes, sessions = wait_once(client, timeout)
                backoff = 2
            except common.ApiError as exc:
                if exc.status in (401, 403):
                    _say("")
                    _say(str(exc))
                    return 1
                _say("")
                _say("Could not reach the API (" + str(exc) + ") - retrying in " + str(backoff) + "s")
                _sleep(backoff)
                backoff = min(backoff * 2, MAX_BACKOFF)
                continue

            if not notes:
                now = _code_stamp()
                if stamp and now and now != stamp:
                    _say("")
                    _say("The watcher was updated - restarting it with the new code.")
                    return RESTART
                _dot()
                continue

            _say("")
            ids = [str(n.get("id")) for n in notes if n.get("id")]
            _say(str(len(ids)) + (" pin" if len(ids) == 1 else " pins") + " arrived at "
                 + time.strftime("%I:%M %p").lstrip("0"))
            for line in describe_batch(notes, sessions):
                _say(line)

            if args.no_claude:
                _say("Pin ids: " + " ".join(ids))
                _say("Run: claude \"/build-notes " + " ".join(ids) + "\"")
                if args.once:
                    return 0
                # Without Claude there is nothing to change the pins' status, so
                # the same batch would come straight back; pause before polling again.
                _sleep(timeout)
                continue

            if last_ids is not None and set(ids) == last_ids:
                # Claude exited without claiming these - the same pins came
                # straight back. Relaunching every poll would loop forever.
                wait = RELAUNCH_BACKOFF[min(relaunch_step, len(RELAUNCH_BACKOFF) - 1)]
                relaunch_step += 1
                _say("The same pins came back unclaimed - waiting " + str(wait) + "s before starting Claude Code again")
                _sleep(wait)
            else:
                relaunch_step = 0
            last_ids = set(ids)

            stop = threading.Event()
            threading.Thread(target=_heartbeat, args=(client, stop), daemon=True).start()
            try:
                code = run_claude(ids, args.claude_args, repo)
            finally:
                stop.set()
            _say("")
            _say("Claude Code exited (code " + str(code) + ").")
            if code == CLAUDE_MISSING:
                _say("Install Claude Code (https://claude.com/claude-code) so `claude` is on PATH, or run with --no-claude and paste the printed command into a Claude Code session.")
                return CLAUDE_MISSING
            if args.once:
                return 0 if code == 0 else code
            if code != 0:
                wait = RELAUNCH_BACKOFF[min(relaunch_step, len(RELAUNCH_BACKOFF) - 1)]
                relaunch_step += 1
                _say("Claude Code did not exit cleanly - waiting " + str(wait) + "s before the next batch")
                _sleep(wait)
            else:
                # Give the API a moment to see the status changes Claude made.
                _sleep(2)
            _say(BANNER)
    except KeyboardInterrupt:
        _say("")
        _say("Stopped.")
        return 0


if __name__ == "__main__":
    code = main()
    while code == RESTART:
        # The updated watcher, in a fresh process in this same terminal.
        try:
            code = subprocess.call([sys.executable, os.path.abspath(__file__)] + sys.argv[1:])
        except KeyboardInterrupt:
            code = 0
    sys.exit(code)
