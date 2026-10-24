"""Tests for the Build Mode tools against a fake `/dev-notes/cli/*` server.

Run from the repository root:

    backend/.venv/bin/python -m unittest tools/build_notes/test_build_notes.py

Standard library only; no network beyond 127.0.0.1.
"""

import contextlib
import io
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from tools.build_notes import cli, common, preview, repro_template, run_e2e, watch

GOOD_TOKEN = "nxbn_" + "a" * 43
REVOKED_TOKEN = "nxbn_" + "r" * 43
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
WEBM = b"\x1aE\xdf\xa3" + b"\x01" * 128

NOTE_ID = "6d2d1c1e-0001-4a4a-9b9b-000000000001"
NOTE_ID_2 = "6d2d1c1e-0002-4a4a-9b9b-000000000002"
NOTE_ID_3 = "6d2d1c1e-0003-4a4a-9b9b-000000000003"   # exists but cannot be claimed (409)
SESSION_ID = "9f00aa00-1111-4bbb-8ccc-000000000009"


def sample_note(base, note_id=NOTE_ID, number=3, with_media=True):
    note = {
        "id": note_id,
        "sessionId": SESSION_ID,
        "number": number,
        "kind": "bug",
        "priority": "blocking",
        "status": "dispatched",
        "comment": "The Mark All Read button is lowercase and too small.",
        "thread": [
            {"id": "t1", "by": "neil@greensglobal.com", "at": "2026-10-24T16:05:00Z", "kind": "comment", "text": "Also check the hover color.", "image_url": ""},
        ],
        "route": "tasks",
        "sub": "home",
        "url": "https://dev.nexus.greensglobal.com/tasks/home",
        "buildId": "abc1234",
        "viewport": {"w": 1440, "h": 900, "dpr": 2, "ua": "Mozilla/5.0 Test", "phone": False, "theme": "light"},
        "target": {
            "selector": "main > div.tasks-home > section:nth-of-type(2) > button.secondary-btn",
            "tag": "button", "id": "", "classes": ["secondary-btn"],
            "attrs": {"aria-label": "Mark all read", "type": "button"},
            "text": "Mark all read",
            "rect": {"x": 812, "y": 240, "w": 120, "h": 32, "pageX": 812, "pageY": 1040},
            "mode": "element",
            "headings": ["Tasks", "Home", "Updates"],
            "breadcrumb": "Tasks > Home",
            "html": "<button class=\"secondary-btn\">Mark all read</button>",
            "components": ["TasksHome", "UpdatesCard", "UpdateRow"],
            "record": {"ids": ["t_8f21"], "keys": ["data-task-id"], "queryKeys": [["tasks", "home"]]},
            "source": {"file": "tasks/home/UpdatesCard.jsx", "line": 142, "col": 7},
        },
        "actions": [
            {"t": "2026-10-24T16:03:50Z", "type": "nav", "label": "Tasks", "selector": "", "value": "", "view": "tasks", "sub": "home"},
            {"t": "2026-10-24T16:03:55Z", "type": "input", "label": "Search tasks", "selector": "input.search", "value": "***", "view": "tasks", "sub": "home"},
            {"t": "2026-10-24T16:03:58Z", "type": "click", "label": "Mark all read", "selector": "button.secondary-btn", "value": "", "view": "tasks", "sub": "home"},
            {"t": "2026-10-24T16:03:59Z", "type": "key", "label": "", "selector": "", "value": "Escape", "view": "tasks", "sub": "home"},
        ],
        "state": {"props": {"unread": 3, "label": "Mark all read"}, "state": {"busy": False}},
        "markup": {
            "base": "page",
            "items": [
                {"type": "rect", "x": 800, "y": 230, "w": 140, "h": 50, "color": "#ef4444", "width": 3},
                {"type": "arrow", "x1": 700, "y1": 300, "x2": 810, "y2": 250, "color": "#ef4444", "width": 3},
                {"type": "text", "x": 650, "y": 310, "text": "move this up", "color": "#111827", "size": 16},
                {"type": "redact", "x": 10, "y": 10, "w": 100, "h": 20},
            ],
            "rel": {"ox": 812, "oy": 240},
        },
        "edit": {
            "text": {"before": "Mark all read", "after": "Mark All Read"},
            "styles": [{"prop": "padding", "before": "8px 12px", "after": "12px 16px"}],
            "note": "Change the text from 'Mark all read' to 'Mark All Read'; padding 8px 12px -> 12px 16px.",
        },
        "transcript": "So this button here should be title case.",
        "attachments": [],
        "consoleLog": [{"level": "error", "text": "Warning: Each child in a list should have a key", "at": "2026-10-24T16:04:58Z"}],
        "networkLog": [
            {"method": "GET", "path": "/tasks/home", "status": 200, "ms": 134, "at": "2026-10-24T16:04:57Z"},
            {"method": "POST", "path": "/tasks/mark-read", "status": 500, "ms": 88, "at": "2026-10-24T16:04:59Z",
             "requestBody": {"ids": ["t_8f21"]}, "responseBody": "Internal Server Error\nat mark_read"},
        ],
        "dispatchTarget": "local",
        "dispatchedAt": "2026-10-24T16:06:00Z",
        "progress": "",
        "progressAt": "",
        "branch": "",
        "prUrl": "",
        "prNumber": 0,
        "createdBy": "neil@greensglobal.com",
        "createdAt": "2026-10-24T16:04:00Z",
        "updatedAt": "2026-10-24T16:06:00Z",
    }
    if with_media:
        note["media"] = {
            "screenshot": base + "/media/screenshot.png?token=signed1",
            "pageShot": base + "/media/page.png?token=signed2",
            "video": base + "/media/video.webm?token=signed3",
            "contactSheet": base + "/media/sheet.png?token=signed4",
            "attachments": [base + "/media/paste.png?token=signed5"],
            "afterShots": [],
        }
    return note


def sample_session():
    return {"id": SESSION_ID, "title": "Tasks Home polish 10/24", "status": "sent",
            "createdBy": "neil@greensglobal.com", "noteCount": 2}


class FakeApi(BaseHTTPRequestHandler):
    """The contract's CLI endpoints, with a recorder for the test to inspect."""

    state = None  # set per server: {"calls": [], "wait_batches": [...]} etc.

    def log_message(self, *args):  # quiet
        pass

    # -- helpers -----------------------------------------------------------
    def _json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, code, payload, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _auth(self):
        auth = self.headers.get("Authorization") or ""
        token = auth[7:] if auth.startswith("Bearer ") else ""
        if token == GOOD_TOKEN:
            return True
        if token == REVOKED_TOKEN:
            self._json(401, {"detail": "token revoked"})
        elif token.startswith("nxbn_noaccess"):
            self._json(403, {"detail": "Build Mode is not enabled for you"})
        else:
            self._json(401, {"detail": "missing token"})
        return False

    def _base(self):
        return "http://127.0.0.1:" + str(self.server.server_address[1])

    # -- routes --------------------------------------------------------------
    def do_GET(self):
        st = self.__class__.state
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/media/"):
            name = path.split("/")[-1]
            st["calls"].append(("GET", path, None))
            if name.endswith(".webm"):
                return self._bytes(200, WEBM, "video/webm")
            if name == "missing.png":
                return self._bytes(404, b"gone", "text/plain")
            return self._bytes(200, PNG, "image/png")
        if not self._auth():
            return
        q = parse_qs(parsed.query)
        st["calls"].append(("GET", path, q))
        if path == "/dev-notes/cli/whoami":
            return self._json(200, {"email": "neil@greensglobal.com", "tokenLabel": "Neil's MacBook"})
        if path == "/dev-notes/cli/wait":
            batches = st.get("wait_batches") or []
            if batches:
                return self._json(200, batches.pop(0))
            return self._json(200, {"notes": [], "sessions": []})
        if path == "/dev-notes/owners":
            return self._json(200, {"owners": st.get("owners") or []})
        m = re.match(r"^/dev-notes/([^/]+)$", path)
        if m and m.group(1) != "cli":
            # GET /dev-notes/{id}: the pin, with the status the test set up (default building).
            if m.group(1) not in (NOTE_ID, NOTE_ID_2, NOTE_ID_3):
                return self._json(404, {"detail": "Pin not found"})
            n = sample_note(self._base(), m.group(1), with_media=False)
            n["status"] = (st.get("statuses") or {}).get(m.group(1), "building")
            return self._json(200, n)
        if path in ("/dev-notes", "/dev-notes/"):
            if st.get("list_needs_session"):
                return self._json(401, {"detail": "Not authenticated"})
            notes = [sample_note(self._base(), with_media=False)]
            status = (q.get("status") or [None])[0]
            if status:
                notes = [n for n in notes if n["status"] == status]
            return self._json(200, notes)
        return self._json(404, {"detail": "no such route " + path})

    def do_POST(self):
        st = self.__class__.state
        if not self._auth():
            return
        parsed = urlparse(self.path)
        path = parsed.path
        raw = self._body()
        ctype = self.headers.get("Content-Type") or ""
        if ctype.startswith("multipart/form-data"):
            body = {"_multipart": raw, "_ctype": ctype}
        else:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        st["calls"].append(("POST", path, body))
        base = self._base()
        if path == "/dev-notes/cli/claim":
            ids = body.get("noteIds") or []
            # All-or-nothing per call, like the real server.
            if any(i not in (NOTE_ID, NOTE_ID_2, NOTE_ID_3) for i in ids):
                return self._json(404, {"detail": "Pin not found"})
            if NOTE_ID_3 in ids:
                return self._json(409, {"detail": "Pin is done and cannot be claimed"})
            notes = []
            if NOTE_ID in ids:
                n = sample_note(base)
                n["status"] = "building"
                notes.append(n)
            if NOTE_ID_2 in ids:
                n = sample_note(base, NOTE_ID_2, 4, with_media=False)
                n["kind"] = "question"
                n["priority"] = "nice"
                n["status"] = "building"
                n["media"] = {"screenshot": "", "pageShot": "", "video": "", "contactSheet": "", "attachments": [], "afterShots": []}
                notes.append(n)
            resp = {"notes": notes, "sessions": [sample_session()]}
            if st.get("claim_skipped"):
                resp["skipped"] = st["claim_skipped"]
            return self._json(200, resp)
        m = re.match(r"^/dev-notes/cli/progress/([^/]+)$", path)
        if m:
            n = sample_note(base, m.group(1), with_media=False)
            n["progress"] = body.get("text", "")
            return self._json(200, n)
        m = re.match(r"^/dev-notes/cli/reply/([^/]+)$", path)
        if m:
            n = sample_note(base, m.group(1), with_media=False)
            n["status"] = "needs_input" if body.get("needsInput") else ("done" if body.get("answered") else "building")
            return self._json(200, n)
        m = re.match(r"^/dev-notes/cli/attach/([^/]+)$", path)
        if m:
            return self._json(200, {"url": "https://x.supabase.co/storage/v1/object/public/qa-evidence/dev-notes/" + m.group(1) + "/after-1.png"})
        m = re.match(r"^/dev-notes/cli/verify/([^/]+)$", path)
        if m:
            n = sample_note(base, m.group(1), with_media=False)
            n["evidence"] = body
            return self._json(200, n)
        m = re.match(r"^/dev-notes/cli/preview/([^/]+)$", path)
        if m:
            if m.group(1) == NOTE_ID_3:
                return self._json(409, {"detail": "Pin is not PR Open"})
            n = sample_note(base, m.group(1), with_media=False)
            n.update(status="pr_open", preview=dict(body, startedAt="2026-10-24T17:00:00Z"), readyToCheck=True)
            return self._json(200, n)
        if path == "/dev-notes/cli/complete":
            ids = body.get("noteIds") or []
            notes = [dict(sample_note(base, i, with_media=False), status="pr_open", prUrl=body.get("prUrl"), prNumber=body.get("prNumber")) for i in ids]
            sess = dict(sample_session(), status="pr_open", prUrl=body.get("prUrl"), prNumber=body.get("prNumber"))
            return self._json(200, {"notes": notes, "session": sess})
        return self._json(404, {"detail": "no such route " + path})


class FakeServer:
    def __init__(self):
        self.state = {"calls": [], "wait_batches": []}
        handler = type("Handler", (FakeApi,), {"state": self.state})
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def start(self):
        self.thread.start()
        return self

    @property
    def base(self):
        return "http://127.0.0.1:" + str(self.httpd.server_address[1])

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def posts(self, path_prefix):
        return [c for c in self.state["calls"] if c[0] == "POST" and c[1].startswith(path_prefix)]


def run_cli(argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = cli.main(argv)
    return code, out.getvalue(), err.getvalue()


class BuildNotesToolsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = FakeServer().start()
        cls.tmp = tempfile.TemporaryDirectory()
        cls._old_env = {k: os.environ.get(k) for k in (common.TOKEN_ENV, common.API_ENV)}
        os.environ[common.TOKEN_ENV] = GOOD_TOKEN
        os.environ.pop(common.API_ENV, None)

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()
        cls.tmp.cleanup()
        for k, v in cls._old_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def setUp(self):
        self.server.state["calls"].clear()
        self.server.state["wait_batches"].clear()
        self.server.state.pop("list_needs_session", None)

    # -- resolution ------------------------------------------------------------

    def test_resolution_order(self):
        self.assertEqual(common.resolve_api_base("http://x:1/"), "http://x:1")
        os.environ[common.API_ENV] = "http://env:2"
        try:
            self.assertEqual(common.resolve_api_base(None), "http://env:2")
        finally:
            os.environ.pop(common.API_ENV, None)
        self.assertEqual(common.resolve_api_base(None), common.DEFAULT_API_BASE)
        self.assertTrue(common.DEFAULT_API_BASE.startswith("https://"))
        self.assertEqual(common.resolve_token("nxbn_explicit"), "nxbn_explicit")
        self.assertEqual(common.resolve_token(None), GOOD_TOKEN)

    def test_token_file_is_read_when_env_missing(self):
        saved = os.environ.pop(common.TOKEN_ENV)
        real = common.TOKEN_FILE
        try:
            common.TOKEN_FILE = Path(self.tmp.name) / "build-notes.token"
            with self.assertRaises(common.ConfigError) as ctx:
                common.resolve_token(None)
            self.assertIn("Build Mode > Settings", str(ctx.exception))
            common.TOKEN_FILE.write_text("NEXUS_BUILD_TOKEN=" + GOOD_TOKEN + "\n")
            self.assertEqual(common.resolve_token(None), GOOD_TOKEN)
            common.TOKEN_FILE.write_text(GOOD_TOKEN + "\n")
            self.assertEqual(common.resolve_token(None), GOOD_TOKEN)
        finally:
            common.TOKEN_FILE = real
            os.environ[common.TOKEN_ENV] = saved

    def test_us_datetime(self):
        # Rendered in local time; check the shape and the AM/PM rule rather than the zone.
        text = common.us_datetime("2026-10-24T16:05:00Z")
        self.assertRegex(text, r"^\d{2}/\d{2}/\d{4} \d{1,2}:\d{2} (AM|PM)$")
        self.assertEqual(common.us_datetime("2026-10-24T00:07:00+00:00", local=False), "10/24/2026 12:07 AM")
        self.assertEqual(common.us_datetime("2026-01-05T13:00:00.1234567Z", local=False), "01/05/2026 1:00 PM")
        self.assertEqual(common.us_datetime(""), "")
        self.assertEqual(common.pin_link("abc"), common.NEXUS_URL + "/dev-notes?pin=abc")

    # -- errors --------------------------------------------------------------------

    def test_401_is_friendly(self):
        code, out, err = run_cli(["--api", self.server.base, "--token", REVOKED_TOKEN, "whoami"])
        self.assertEqual(code, 1)
        self.assertIn("Your Build Token was revoked or expired", err)
        self.assertIn("Nexus > Build Mode > Settings", err)

    def test_403_is_friendly(self):
        code, out, err = run_cli(["--api", self.server.base, "--token", "nxbn_noaccess" + "x" * 30, "whoami"])
        self.assertEqual(code, 1)
        self.assertIn("Build Mode is not enabled for you", err.strip())

    def test_unreachable_api_message(self):
        code, out, err = run_cli(["--api", "http://127.0.0.1:9", "whoami"])
        self.assertEqual(code, 1)
        self.assertIn("Cannot reach http://127.0.0.1:9", err)

    # -- whoami / list -------------------------------------------------------------------

    def test_whoami(self):
        code, out, err = run_cli(["--api", self.server.base, "whoami"])
        self.assertEqual(code, 0)
        self.assertIn("neil@greensglobal.com (Neil's MacBook)", out)

    def test_list_filters_by_status(self):
        code, out, _ = run_cli(["--api", self.server.base, "list", "--status", "dispatched"])
        self.assertEqual(code, 0)
        self.assertIn("#3", out)
        self.assertIn("Dispatched", out)
        self.assertIn("Blocking", out)
        self.assertIn("tasks/home", out)
        call = [c for c in self.server.state["calls"] if c[1] in ("/dev-notes", "/dev-notes/")][0]
        self.assertEqual(call[2].get("status"), ["dispatched"])
        code, out, _ = run_cli(["--api", self.server.base, "list", "--status", "done"])
        self.assertEqual(code, 0)
        self.assertIn("No pins.", out)

    def test_list_falls_back_to_wait_when_list_route_needs_a_session(self):
        self.server.state["list_needs_session"] = True
        self.server.state["wait_batches"].append({"notes": [sample_note(self.server.base, with_media=False)], "sessions": [sample_session()]})
        code, out, _ = run_cli(["--api", self.server.base, "list", "--status", "dispatched"])
        self.assertEqual(code, 0)
        self.assertIn("#3", out)
        self.assertIn("Tasks Home polish 10/24", out)

    # -- watcher ----------------------------------------------------------------------

    def test_watch_once_no_claude_prints_ids(self):
        self.server.state["wait_batches"].append({
            "notes": [sample_note(self.server.base, with_media=False), sample_note(self.server.base, NOTE_ID_2, 4, with_media=False)],
            "sessions": [sample_session()],
        })
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = watch.main(["--once", "--no-claude", "--api", self.server.base, "--timeout", "1"])
        text = out.getvalue()
        self.assertEqual(code, 0)
        self.assertIn(watch.BANNER, text)
        self.assertIn("Signed in as neil@greensglobal.com", text)
        self.assertIn("2 pins arrived", text)
        self.assertIn("Pin ids: " + NOTE_ID + " " + NOTE_ID_2, text)
        self.assertIn("Build Session: Tasks Home polish 10/24", text)
        self.assertIn("Pin #3 - Bug - Blocking - tasks/home", text)
        waits = [c for c in self.server.state["calls"] if c[1] == "/dev-notes/cli/wait"]
        self.assertEqual(len(waits), 1)
        self.assertEqual(waits[0][2].get("timeout"), ["1"])

    def test_watch_heartbeat_then_batch(self):
        # First poll empty (a dot), second poll has a pin.
        self.server.state["wait_batches"].append({"notes": [], "sessions": []})
        self.server.state["wait_batches"].append({"notes": [sample_note(self.server.base, with_media=False)], "sessions": []})
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = watch.main(["--once", "--no-claude", "--api", self.server.base, "--timeout", "1"])
        self.assertEqual(code, 0)
        self.assertIn(watch.BANNER + "\n.", out.getvalue())
        self.assertIn("1 pin arrived", out.getvalue())

    def test_watch_revoked_token_exits(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = watch.main(["--once", "--no-claude", "--api", self.server.base, "--token", REVOKED_TOKEN])
        self.assertEqual(code, 1)
        self.assertIn("Your Build Token was revoked or expired", out.getvalue())

    def _patched_watch(self, run_results):
        """Run the watcher with run_claude and sleep stubbed; returns (code, output, launches, sleeps)."""
        launches, sleeps = [], []
        results = list(run_results)

        def fake_run(ids, claude_args, cwd):
            launches.append(list(ids))
            result = results.pop(0)
            if isinstance(result, BaseException):
                raise result
            return result

        real_run, real_sleep = watch.run_claude, watch._sleep
        watch.run_claude, watch._sleep = fake_run, sleeps.append
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                code = watch.main(["--api", self.server.base, "--timeout", "1"])
        finally:
            watch.run_claude, watch._sleep = real_run, real_sleep
        return code, out.getvalue(), launches, sleeps

    def test_watch_backs_off_when_the_same_pins_come_straight_back(self):
        batch = {"notes": [sample_note(self.server.base, with_media=False)], "sessions": []}
        other = {"notes": [sample_note(self.server.base, NOTE_ID_2, 4, with_media=False)], "sessions": []}
        self.server.state["wait_batches"].extend([dict(batch), dict(batch), dict(batch), dict(other)])
        # Claude exits 0 three times without claiming (same ids return), then a new id arrives, then Ctrl+C.
        code, text, launches, sleeps = self._patched_watch([0, 0, 0, KeyboardInterrupt()])
        self.assertEqual(code, 0)
        self.assertEqual([set(ids) for ids in launches], [{NOTE_ID}, {NOTE_ID}, {NOTE_ID}, {NOTE_ID_2}])
        # 2 s settle after each clean exit; 30 then 60 before relaunching the same set; reset for the new id.
        self.assertEqual(sleeps, [2, 30, 2, 60, 2])
        self.assertIn("The same pins came back unclaimed - waiting 30s", text)
        self.assertIn("waiting 60s", text)
        self.assertIn("Stopped.", text)

    def test_watch_backs_off_after_a_failed_claude_exit(self):
        batch = {"notes": [sample_note(self.server.base, with_media=False)], "sessions": []}
        self.server.state["wait_batches"].extend([dict(batch), dict(batch)])
        code, text, launches, sleeps = self._patched_watch([1, KeyboardInterrupt()])
        self.assertEqual(code, 0)
        self.assertEqual(len(launches), 2)
        # 30 s after the non-zero exit, then 60 s because the same ids came back.
        self.assertEqual(sleeps, [30, 60])
        self.assertIn("Claude Code did not exit cleanly - waiting 30s", text)
        self.assertEqual(watch.RELAUNCH_BACKOFF[-1], 300)

    def test_watch_exits_when_claude_is_missing(self):
        self.server.state["wait_batches"].append({"notes": [sample_note(self.server.base, with_media=False)], "sessions": []})
        code, text, launches, sleeps = self._patched_watch([127])
        self.assertEqual(code, 127)
        self.assertEqual(len(launches), 1)
        self.assertEqual(sleeps, [])
        self.assertIn("Install Claude Code", text)
        # And the real run_claude answers 127 when `claude` is not on PATH.
        real_which = watch.shutil.which
        watch.shutil.which = lambda name: None
        try:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(watch.run_claude(["x"], "", self.tmp.name), 127)
        finally:
            watch.shutil.which = real_which

    def test_watch_uses_the_cli_labels(self):
        self.assertFalse(hasattr(watch, "PRIORITY_LABELS"))
        line = watch.describe_batch([dict(sample_note("http://x", with_media=False), kind="change", priority="nice")], [])[0]
        self.assertIn("Pin #3 - Change - Nice To Have", line)

    def test_claude_command_shape(self):
        cmd = watch.claude_command(["a", "b"], '--model opus --permission-mode "accept edits"')
        self.assertEqual(cmd, ["claude", "--model", "opus", "--permission-mode", "accept edits", "/build-notes a b"])
        self.assertTrue((common.repo_root() / "CLAUDE.md").exists())

    # -- claim ------------------------------------------------------------------------

    def test_claim_downloads_media_and_prints_brief(self):
        out_dir = Path(self.tmp.name) / "claims"
        code, out, err = run_cli(["--api", self.server.base, "claim", NOTE_ID, NOTE_ID_2, "--out", str(out_dir)])
        self.assertEqual(code, 0, err)
        # One claim call per id - the server is all-or-nothing per call.
        self.assertEqual([c[2] for c in self.server.posts("/dev-notes/cli/claim")],
                         [{"noteIds": [NOTE_ID]}, {"noteIds": [NOTE_ID_2]}])

        folder = out_dir / NOTE_ID
        for name, payload in (("screenshot.png", PNG), ("page.png", PNG), ("sheet.png", PNG), ("video.webm", WEBM), ("attachment-1.png", PNG)):
            self.assertTrue((folder / name).is_file(), name)
            self.assertEqual((folder / name).read_bytes(), payload, name)
        self.assertFalse(list(folder.glob("*.part")))
        self.assertTrue((folder / "brief.md").is_file())
        self.assertTrue((folder / "pin.json").is_file())

        # Brief sections, in order.
        for marker in ("# Pin #3 - Bug - Blocking", "By neil@greensglobal.com on ", "Build Session: Tasks Home polish 10/24",
                       common.NEXUS_URL + "/dev-notes?pin=" + NOTE_ID,
                       "Where: frontend/src/tasks/home/UpdatesCard.jsx:142:7",
                       "## Where", "- Route: tasks", "- Sub: home", "- Build: abc1234", "1440x900, @2x, desktop, light theme",
                       "## Actions (last 4)", "1. ", "nav \"Tasks\" on tasks/home", "2. ", "input \"Search tasks\" (input.search) = \"***\"",
                       "3. ", "click \"Mark all read\" (button.secondary-btn) on tasks/home", "4. ", "key = \"Escape\"",
                       "## State", "```json", "\"unread\": 3",
                       "POST /tasks/mark-read -> 500 88ms", "  request: {\"ids\": [\"t_8f21\"]}", "  response: Internal Server Error at mark_read",
                       "## Comment", "The Mark All Read button is lowercase",
                       "## Thread", "neil@greensglobal.com (comment): Also check the hover color.",
                       "## Target", "- Selector: `main > div.tasks-home", "- Tag: button.secondary-btn",
                       "- Headings: Tasks > Home > Updates", "- Breadcrumb: Tasks > Home",
                       "- Components: TasksHome > UpdatesCard > UpdateRow", "- Record: ids t_8f21; keys data-task-id",
                       "```html", "<button class=\"secondary-btn\">Mark all read</button>",
                       "## Markup", "- red rectangle around the target", "- red arrow from (700, 300) to the target",
                       "- text label: 'move this up'", "- redacted area at (10, 10) 100x20",
                       "## Edit In Place", "Change the text from 'Mark all read' to 'Mark All Read'",
                       "Text before: \"Mark all read\"", "Text after:  \"Mark All Read\"", "- padding: 8px 12px -> 12px 16px",
                       "## Transcript", "title case",
                       "## Console (last 1)", "[error]", "Each child in a list",
                       "## Network (last 2)", "GET /tasks/home -> 200 134ms",
                       "## Files", "- Screenshot: " + str(folder / "screenshot.png"), "- Page shot: " + str(folder / "page.png"),
                       "- Contact sheet: " + str(folder / "sheet.png"), "- Video: " + str(folder / "video.webm"),
                       "- Attachment 1: " + str(folder / "attachment-1.png")):
            self.assertIn(marker, out, marker)
        order = [out.index(h) for h in ("Where: frontend/src/", "## Where", "## Comment", "## Thread", "## Target", "## Markup", "## Edit In Place",
                                        "## Actions", "## State", "## Transcript", "## Console", "## Network", "## Files")]
        self.assertEqual(order, sorted(order))
        # Dates are US format, never ISO.
        self.assertNotIn("2026-10-24T", out.split("```html")[0])
        self.assertRegex(out, r"By neil@greensglobal.com on \d{2}/\d{2}/\d{4} \d{1,2}:\d{2} (AM|PM)")
        # Second pin: a Question with no media.
        self.assertIn("# Pin #4 - Question - Nice To Have", out)
        self.assertIn("(no media on this pin)", out)
        self.assertTrue((out_dir / NOTE_ID_2 / "brief.md").is_file())
        self.assertFalse(list((out_dir / NOTE_ID_2).glob("*.png")))

    def test_claim_reports_unclaimed_ids(self):
        out_dir = Path(self.tmp.name) / "claims2"
        code, out, err = run_cli(["--api", self.server.base, "claim", NOTE_ID, "not-a-real-id", NOTE_ID_3, "--out", str(out_dir), "--no-download"])
        self.assertEqual(code, 0)   # at least one succeeded
        self.assertIn("Not claimed: Pin not-a-real-id - Pin not found", err)
        self.assertIn("Not claimed: Pin " + NOTE_ID_3 + " - Pin is done and cannot be claimed", err)
        self.assertIn("# Pin #3 - Bug - Blocking", out)
        self.assertIn("- Screenshot: " + self.server.base + "/media/screenshot.png", out)
        self.assertEqual(len(self.server.posts("/dev-notes/cli/claim")), 3)

    def test_claim_nothing_returned(self):
        code, out, err = run_cli(["--api", self.server.base, "claim", "zzz", NOTE_ID_3, "--out", self.tmp.name])
        self.assertEqual(code, 1)
        self.assertIn("Not claimed: Pin zzz - Pin not found", err)
        self.assertIn("Nothing claimed.", err)
        self.assertEqual(out, "")

    def test_claim_token_error_stops_the_batch(self):
        code, out, err = run_cli(["--api", self.server.base, "--token", REVOKED_TOKEN, "claim", NOTE_ID, NOTE_ID_2, "--out", self.tmp.name])
        self.assertEqual(code, 1)
        self.assertIn("Your Build Token was revoked or expired", err)
        self.assertNotIn("Not claimed", err)

    def test_describe_markup_words(self):
        rect = {"x": 100, "y": 100, "w": 50, "h": 20}
        words = cli.describe_markup({"items": [
            {"type": "rect", "x": 400, "y": 400, "w": 10, "h": 10, "color": "#3b82f6"},
            {"type": "highlight", "x": 90, "y": 95, "w": 80, "h": 30, "color": "#facc15"},
            {"type": "path", "points": [[1, 1], [105, 105]], "color": "#22c55e"},
            {"type": "arrow", "x1": 0, "y1": 0, "x2": 500, "y2": 500, "color": "#abcdef"},
        ]}, rect)
        self.assertEqual(words, [
            "blue rectangle at (400, 400) 10x10",
            "yellow highlight over the target",
            "green freehand stroke with 2 points over the target",
            "#abcdef arrow from (0, 0) to (500, 500)",
        ])
        self.assertEqual(cli.describe_markup({}, rect), [])

    # -- progress / reply / after / complete ----------------------------------------------

    def test_progress_posts_one_line(self):
        code, out, _ = run_cli(["--api", self.server.base, "progress", NOTE_ID, "Reading", "pins"])
        self.assertEqual(code, 0)
        self.assertEqual(self.server.posts("/dev-notes/cli/progress/" + NOTE_ID)[0][2], {"text": "Reading pins"})
        self.assertIn("Pin #3 progress: Reading pins", out)
        # Collapsed to one line of 300 chars, as the server keeps it.
        long = "Found frontend/src/x.jsx\nand then " + "y" * 400
        code, out, _ = run_cli(["--api", self.server.base, "progress", NOTE_ID, long])
        sent = self.server.posts("/dev-notes/cli/progress/" + NOTE_ID)[1][2]["text"]
        self.assertEqual(len(sent), 300)
        self.assertNotIn("\n", sent)
        self.assertTrue(sent.startswith("Found frontend/src/x.jsx and then yyy"))

    def test_answered_pin_shows_the_answer_and_marker(self):
        answered = sample_note(self.server.base, with_media=False)
        answered["status"] = "needs_input"
        answered["thread"] = [
            {"id": "t1", "by": "claude", "at": "2026-10-24T16:10:00Z", "kind": "claude", "text": "Which button?"},
            {"id": "t2", "by": "neil@greensglobal.com", "at": "2026-10-24T16:12:00Z", "kind": "comment", "text": "The one in the Updates card."},
        ]
        self.assertEqual(cli.latest_human_answer(answered["thread"])[2], "The one in the Updates card.")
        self.assertIsNone(cli.latest_human_answer(answered["thread"][:1]))
        self.assertIsNone(cli.latest_human_answer([{"by": "neil@greensglobal.com", "kind": "progress", "text": "x"}]))
        # A comment with no question from Claude before it is just a thread comment, not an answer.
        self.assertIsNone(cli.latest_human_answer([{"by": "neil@greensglobal.com", "kind": "comment", "text": "Also the hover color."}]))
        self.assertIsNone(cli.latest_human_answer([
            {"by": "neil@greensglobal.com", "kind": "comment", "text": "First thought."},
            {"by": "claude", "kind": "progress", "text": "Reading pins"},
        ]))
        # The claim's own progress entry after the answer does not hide it.
        self.assertEqual(cli.latest_human_answer(answered["thread"] + [
            {"by": "claude", "kind": "progress", "text": "Picked up by Claude Code"},
        ])[2], "The one in the Updates card.")
        # A newer question resets - only what follows it counts.
        self.assertIsNone(cli.latest_human_answer(answered["thread"] + [{"by": "claude", "kind": "claude", "text": "And which card?"}]))
        plain = sample_note(self.server.base, with_media=False)
        plain["status"] = "building"
        self.assertNotIn("Author's latest answer", cli.render_brief(plain, []))
        # The claim appends its own progress entry AFTER the answer - the answer must still be found.
        picked = answered["thread"] + [{"by": "claude", "kind": "progress", "text": "Picked up by Claude Code"}]
        self.assertEqual(cli.latest_human_answer(picked)[2], "The one in the Updates card.")
        # A newer question from Claude resets it: only comments after the last question count.
        asked_again = picked + [{"by": "claude", "kind": "claude", "text": "And the color?"}]
        self.assertIsNone(cli.latest_human_answer(asked_again))
        brief = cli.render_brief(answered, [])
        self.assertIn("Author's latest answer (neil@greensglobal.com, ", brief)
        self.assertIn("): The one in the Updates card.", brief)
        self.assertLess(brief.index("Author's latest answer"), brief.index("## Where"))
        self.assertNotIn("Author's latest answer", cli.render_brief(sample_note(self.server.base, with_media=False), []))
        lines = watch.describe_batch([answered, sample_note(self.server.base, NOTE_ID_2, 4, with_media=False)], [])
        self.assertIn("Pin #3 - Bug - Blocking (answered) - tasks/home", lines[0])
        self.assertNotIn("(answered)", lines[1])

    def test_error_hints(self):
        hint = common._friendly(409, "not building", "POST", "/cli/claim")
        self.assertIn("status does not allow this", hint)
        self.assertNotIn("claim it first", hint)   # a 409 on a claim must not say "claim it first"
        self.assertIn("over 8 MB", common._friendly(413, None, "POST", "/cli/attach/x"))
        self.assertIn("storage is not configured", common._friendly(503, None, "POST", "/cli/attach/x"))
        self.assertEqual(common._friendly(400, "prUrl missing", "POST", "/cli/complete"), "API error 400 on POST /cli/complete: prUrl missing")

    def test_reply_needs_input(self):
        code, out, _ = run_cli(["--api", self.server.base, "reply", NOTE_ID, "Which button do you mean?", "--needs-input"])
        self.assertEqual(code, 0)
        body = self.server.posts("/dev-notes/cli/reply/" + NOTE_ID)[0][2]
        self.assertEqual(body, {"text": "Which button do you mean?", "needsInput": True})
        self.assertIn("now Needs Input", out)

    def test_reply_answered_and_image(self):
        img = Path(self.tmp.name) / "shot.png"
        img.write_bytes(PNG)
        code, out, err = run_cli(["--api", self.server.base, "reply", NOTE_ID_2, "It is by design.", "--answered", "--image", str(img)])
        self.assertEqual(code, 0, err)
        attach = self.server.posts("/dev-notes/cli/attach/" + NOTE_ID_2)[0][2]
        self.assertIn("multipart/form-data; boundary=", attach["_ctype"])
        raw = attach["_multipart"]
        self.assertIn(b'name="kind"\r\n\r\npaste\r\n', raw)
        self.assertIn(b'name="file"; filename="shot.png"', raw)
        self.assertIn(b"Content-Type: image/png", raw)
        self.assertIn(PNG, raw)
        reply = self.server.posts("/dev-notes/cli/reply/" + NOTE_ID_2)[0][2]
        self.assertEqual(reply["answered"], True)
        self.assertTrue(reply["imageUrl"].endswith("/after-1.png"))
        self.assertIn("now Done", out)

    def test_reply_rejects_both_flags(self):
        code, out, err = run_cli(["--api", self.server.base, "reply", NOTE_ID, "x", "--answered", "--needs-input"])
        self.assertEqual(code, 2)
        self.assertEqual(self.server.posts("/dev-notes/cli/reply/"), [])

    def test_after_uploads_kind_after(self):
        img = Path(self.tmp.name) / "after.webp"
        img.write_bytes(b"RIFF" + b"\x00" * 32)
        code, out, err = run_cli(["--api", self.server.base, "after", NOTE_ID, "--image", str(img)])
        self.assertEqual(code, 0, err)
        attach = self.server.posts("/dev-notes/cli/attach/" + NOTE_ID)[0][2]
        self.assertIn(b'name="kind"\r\n\r\nafter\r\n', attach["_multipart"])
        self.assertIn(b"Content-Type: image/webp", attach["_multipart"])
        self.assertIn("After shot attached", out)

    def test_after_rejects_missing_or_wrong_file(self):
        code, out, err = run_cli(["--api", self.server.base, "after", NOTE_ID, "--image", str(Path(self.tmp.name) / "nope.png")])
        self.assertEqual(code, 2)
        self.assertIn("Image not found", err)
        bad = Path(self.tmp.name) / "notes.txt"
        bad.write_text("x")
        code, out, err = run_cli(["--api", self.server.base, "after", NOTE_ID, "--image", str(bad)])
        self.assertEqual(code, 2)
        self.assertIn("png, jpg or webp", err)

    def test_complete_posts_pr_fields(self):
        code, out, err = run_cli(["--api", self.server.base, "complete", NOTE_ID, NOTE_ID_2,
                                  "--pr", "https://github.com/Greens-Global/Greens-Nexus/pull/812",
                                  "--branch", "build/tasks-home-polish-1024", "--summary", "Title Case on the Updates card"])
        self.assertEqual(code, 0, err)
        body = self.server.posts("/dev-notes/cli/complete")[0][2]
        self.assertEqual(body, {
            "noteIds": [NOTE_ID, NOTE_ID_2],
            "prUrl": "https://github.com/Greens-Global/Greens-Nexus/pull/812",
            "prNumber": 812,
            "branch": "build/tasks-home-polish-1024",
            "summary": "Title Case on the Updates card",
        })
        self.assertIn("PR #812 recorded on 2 pins", out)
        self.assertIn("Build Session 'Tasks Home polish 10/24' is PR Open", out)

    def test_complete_needs_a_pr_number(self):
        code, out, err = run_cli(["--api", self.server.base, "complete", NOTE_ID, "--pr", "https://example.com/x", "--branch", "b"])
        self.assertEqual(code, 2)
        self.assertIn("--pr-number", err)
        self.assertEqual(cli.pr_number_from_url("https://github.com/o/r/pull/77/files"), 77)

    # -- evidence: verify / repro template ----------------------------------------------------

    def test_list_prints_where_line(self):
        code, out, _ = run_cli(["--api", self.server.base, "list"])
        self.assertEqual(code, 0)
        self.assertIn("      Where: frontend/src/tasks/home/UpdatesCard.jsx:142", out)

    def test_source_location_normalizes_paths(self):
        self.assertEqual(cli.source_location({"source": {"file": "tasks/Tasks.jsx", "line": 10, "col": 3}}), "frontend/src/tasks/Tasks.jsx:10")
        self.assertEqual(cli.source_location({"source": {"file": "./src/views/HR.jsx", "line": 5, "col": 2}}, with_col=True), "frontend/src/views/HR.jsx:5:2")
        self.assertEqual(cli.source_location({"source": {"file": "frontend/src/App.jsx"}}), "frontend/src/App.jsx")
        self.assertEqual(cli.source_location({"source": {}}), "")
        self.assertEqual(cli.source_location({}), "")

    def test_verify_repro_posts_script_and_results(self):
        script = Path(self.tmp.name) / "repro.py"
        script.write_text("print('hi')\n")
        code, out, err = run_cli(["--api", self.server.base, "verify", NOTE_ID, "--repro-script", str(script),
                                  "--before", "failing", "--after", "passing"])
        self.assertEqual(code, 0, err)
        body = self.server.posts("/dev-notes/cli/verify/" + NOTE_ID)[0][2]
        # `kind` says which form the repro is (v2): a plain script is the Python form.
        self.assertEqual(body, {"repro": {"script": "print('hi')\n", "before": "failing", "after": "passing", "kind": "python"}})
        self.assertIn("evidence recorded: repro failing -> passing", out)

    def test_verify_style_json_and_images(self):
        style = Path(self.tmp.name) / "style.json"
        style.write_text(json.dumps({"checks": [
            {"prop": "padding", "expected": "12px 16px", "actual": "12px 16px", "ok": True},
            {"prop": "color", "expected": "rgb(17, 24, 39)", "actual": "rgb(107, 114, 128)", "ok": False},
        ]}))
        before = Path(self.tmp.name) / "before.png"
        after = Path(self.tmp.name) / "after.png"
        before.write_bytes(PNG)
        after.write_bytes(PNG)
        code, out, err = run_cli(["--api", self.server.base, "verify", NOTE_ID, "--style-json", str(style),
                                  "--before-image", str(before), "--after-image", str(after), "--before", "skipped", "--after", "skipped"])
        self.assertEqual(code, 0, err)
        attaches = self.server.posts("/dev-notes/cli/attach/" + NOTE_ID)
        self.assertEqual(len(attaches), 2)
        # The pre-fix picture is a `before` shot, the post-fix one an `after` shot.
        self.assertIn(b'name="kind"\r\n\r\nbefore\r\n', attaches[0][2]["_multipart"])
        self.assertIn(b'name="kind"\r\n\r\nafter\r\n', attaches[1][2]["_multipart"])
        # The status was checked BEFORE anything was uploaded.
        calls = self.server.state["calls"]
        get_idx = next(i for i, c in enumerate(calls) if c[0] == "GET" and c[1] == "/dev-notes/" + NOTE_ID)
        first_attach = next(i for i, c in enumerate(calls) if c[0] == "POST" and c[1].startswith("/dev-notes/cli/attach/"))
        self.assertLess(get_idx, first_attach)
        body = self.server.posts("/dev-notes/cli/verify/" + NOTE_ID)[0][2]
        self.assertEqual(body["repro"], {"script": "", "before": "skipped", "after": "skipped"})
        self.assertEqual(body["styleCheck"]["passed"], False)   # what the checks say, derived when the file leaves it out
        self.assertEqual(len(body["styleCheck"]["checks"]), 2)
        self.assertTrue(body["visual"]["beforeUrl"].endswith("/after-1.png"))
        self.assertTrue(body["visual"]["afterUrl"].endswith("/after-1.png"))
        self.assertIn("style check 1/2", out)
        self.assertIn("before/after attached", out)

    def test_verify_argument_rules(self):
        code, out, err = run_cli(["--api", self.server.base, "verify", NOTE_ID])
        self.assertEqual(code, 2)
        self.assertIn("at least one of", err)
        script = Path(self.tmp.name) / "r.py"
        script.write_text("x = 1\n")
        code, out, err = run_cli(["--api", self.server.base, "verify", NOTE_ID, "--repro-script", str(script), "--before", "failing"])
        self.assertEqual(code, 2)
        self.assertIn("--before AND --after", err)
        code, out, err = run_cli(["--api", self.server.base, "verify", NOTE_ID, "--repro-script", str(script)])
        self.assertEqual(code, 2)
        self.assertIn("--repro-script needs --before and --after", err)
        code, out, err = run_cli(["--api", self.server.base, "verify", NOTE_ID, "--before-image", str(script)])
        self.assertEqual(code, 2)
        self.assertIn("both --before-image and --after-image", err)
        bad = Path(self.tmp.name) / "bad.json"
        bad.write_text("[1, 2]")
        code, out, err = run_cli(["--api", self.server.base, "verify", NOTE_ID, "--style-json", str(bad)])
        self.assertEqual(code, 2)
        self.assertIn("checks", err)
        # --before / --after come together, with or without a script.
        code, out, err = run_cli(["--api", self.server.base, "verify", NOTE_ID, "--before", "failing"])
        self.assertEqual(code, 2)
        self.assertIn("--before AND --after", err)
        code, out, err = run_cli(["--api", self.server.base, "verify", NOTE_ID, "--after", "passing", "--style-json", str(bad)])
        self.assertEqual(code, 2)
        # A style check with no checks proves nothing - never sent, never passed=true.
        empty = Path(self.tmp.name) / "empty.json"
        empty.write_text(json.dumps({"checks": []}))
        code, out, err = run_cli(["--api", self.server.base, "verify", NOTE_ID, "--style-json", str(empty)])
        self.assertEqual(code, 2)
        self.assertIn("no checks", err)
        claimed = Path(self.tmp.name) / "claimed.json"
        claimed.write_text(json.dumps({"passed": True, "checks": []}))
        code, out, err = run_cli(["--api", self.server.base, "verify", NOTE_ID, "--style-json", str(claimed)])
        self.assertEqual(code, 2)
        # `passed` is recomputed from the checks, never taken from the file.
        lying = Path(self.tmp.name) / "lying.json"
        lying.write_text(json.dumps({"passed": True, "checks": [{"prop": "color", "expected": "a", "actual": "b", "ok": False}]}))
        code, out, err = run_cli(["--api", self.server.base, "verify", NOTE_ID, "--style-json", str(lying)])
        self.assertEqual(code, 0, err)
        self.assertEqual(self.server.posts("/dev-notes/cli/verify/" + NOTE_ID)[-1][2]["styleCheck"]["passed"], False)
        self.assertEqual(len(self.server.posts("/dev-notes/cli/verify/")), 1)
        self.assertEqual(self.server.posts("/dev-notes/cli/attach/"), [])

    def test_verify_refuses_before_uploading_when_status_is_wrong(self):
        self.server.state["statuses"] = {NOTE_ID: "done"}
        try:
            before = Path(self.tmp.name) / "b.png"
            after = Path(self.tmp.name) / "a.png"
            before.write_bytes(PNG)
            after.write_bytes(PNG)
            code, out, err = run_cli(["--api", self.server.base, "verify", NOTE_ID, "--before-image", str(before), "--after-image", str(after)])
            self.assertEqual(code, 1)
            self.assertIn("Pin #3 is Done", err)
            self.assertIn("Building, Needs Input or PR Open", err)
            self.assertEqual(self.server.posts("/dev-notes/cli/attach/"), [])
            self.assertEqual(self.server.posts("/dev-notes/cli/verify/"), [])
            self.server.state["statuses"] = {NOTE_ID: "pr_open"}
            code, out, err = run_cli(["--api", self.server.base, "verify", NOTE_ID, "--before", "skipped", "--after", "skipped"])
            self.assertEqual(code, 0, err)
        finally:
            self.server.state.pop("statuses", None)

    def test_reply_flags_refused_before_uploading_when_status_is_wrong(self):
        self.server.state["statuses"] = {NOTE_ID: "dispatched"}
        try:
            img = Path(self.tmp.name) / "r.png"
            img.write_bytes(PNG)
            code, out, err = run_cli(["--api", self.server.base, "reply", NOTE_ID, "Which one?", "--needs-input", "--image", str(img)])
            self.assertEqual(code, 1)
            self.assertIn("Pin #3 is Dispatched", err)
            self.assertIn("Building or Needs Input", err)
            self.assertEqual(self.server.posts("/dev-notes/cli/attach/"), [])
            self.assertEqual(self.server.posts("/dev-notes/cli/reply/"), [])
            # A plain comment with no flags and no image needs no status check.
            gets_before = len([c for c in self.server.state["calls"] if c[0] == "GET" and c[1] == "/dev-notes/" + NOTE_ID])
            self.assertEqual(gets_before, 1)   # the refused call above looked once
            code, out, err = run_cli(["--api", self.server.base, "reply", NOTE_ID, "Noted."])
            self.assertEqual(code, 0, err)
            self.assertEqual(self.server.posts("/dev-notes/cli/reply/" + NOTE_ID)[0][2], {"text": "Noted."})
            gets_after = len([c for c in self.server.state["calls"] if c[0] == "GET" and c[1] == "/dev-notes/" + NOTE_ID])
            self.assertEqual(gets_after, gets_before)
        finally:
            self.server.state.pop("statuses", None)

    def test_repro_template_builds_a_runnable_skeleton(self):
        pin = sample_note("http://x", with_media=False)
        script = repro_template.script_from_pin(pin, base="http://localhost:5173")
        compile(script, "repro.py", "exec")   # valid Python
        self.assertIn('BASE = "http://localhost:5173"', script)
        self.assertIn('ROUTE = "/tasks/home"', script)
        self.assertIn('VIEWPORT = {"width": 1440, "height": 900}', script)
        self.assertIn('"""Repro for Pin #3.', script)
        self.assertIn("# Pin comment: The Mark All Read button is lowercase and too small.", script)
        self.assertIn("# Source stamp: tasks/home/UpdatesCard.jsx:142", script)
        # Pin text never lands inside the docstring or code: a hostile comment still compiles.
        hostile = dict(pin, comment='Breaks """ the docstring \\\nimport os; os.system("x")\n', target=dict(pin["target"], source={"file": 'a"""b\\', "line": 1}))
        hostile_script = repro_template.script_from_pin(hostile)
        compile(hostile_script, "hostile.py", "exec")
        self.assertNotIn("os.system", [ln for ln in hostile_script.splitlines() if not ln.startswith("#")].__str__())
        self.assertIn('# Pin comment: Breaks """ the docstring \\ import os; os.system("x")', hostile_script)
        # nav -> goto with the alias-aware path; masked input -> TODO; click by label with the selector as a comment; key press.
        self.assertIn('page.goto(BASE + "/tasks/home")', script)
        self.assertIn("(value was masked at capture)", script)
        self.assertIn('page.get_by_label("Search tasks").or_(page.get_by_placeholder("Search tasks")).first.fill("TODO: the value typed here")', script)
        self.assertIn('# or: page.locator("input.search").first', script)
        self.assertIn('page.get_by_text("Mark all read", exact=True).first.click()', script)
        self.assertIn('# or: page.locator("button.secondary-btn").first', script)
        # The generated script's non-comment lines must not hide a call behind a comment.
        self.assertFalse([ln for ln in script.splitlines() if "  # or" in ln and not ln.strip().startswith("#")])
        self.assertIn('page.keyboard.press("Escape")', script)
        self.assertIn('target = page.locator("main > div.tasks-home > section:nth-of-type(2) > button.secondary-btn").first', script)
        self.assertIn("TODO: assert the pin's complaint", script)
        self.assertIn('print("FAILING: "', script)
        self.assertIn('print("PASSING")', script)
        # A bare actions list works too, and the CLI writes a file.
        bare = repro_template.script_from_pin([{"type": "click", "selector": "#go"}, {"type": "scroll", "value": 250}, {"type": "nav", "view": "myhr", "sub": "timesheet"}])
        compile(bare, "bare.py", "exec")
        self.assertIn('page.locator("#go").first.click()', bare)
        self.assertIn("page.mouse.wheel(0, 250)", bare)
        self.assertIn('page.goto(BASE + "/workday/timesheet")', bare)
        src = Path(self.tmp.name) / "pin.json"
        src.write_text(json.dumps(pin))
        dest = Path(self.tmp.name) / "repro_pin_3.py"
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = repro_template.main([str(src), "--out", str(dest), "--base", "http://localhost:4173"])
        self.assertEqual(code, 0)
        self.assertIn('BASE = "http://localhost:4173"', dest.read_text())
        # Default destination: next to pin.json in the cache folder, never the repo root.
        real_cache = common.CACHE_DIR
        common.CACHE_DIR = Path(self.tmp.name) / "cache"
        try:
            self.assertEqual(repro_template.default_out_path(pin), common.CACHE_DIR / NOTE_ID / "repro_pin_3.py")
            self.assertIsNone(repro_template.default_out_path([{"type": "click"}]))
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = repro_template.main([str(src), "--python"])   # v2: the e2e spec is the default for a pin with actions
            self.assertEqual(code, 0)
            written = common.CACHE_DIR / NOTE_ID / "repro_pin_3.py"
            self.assertTrue(written.is_file())
            self.assertIn("Wrote " + str(written), out.getvalue())
            self.assertFalse((Path.cwd() / "repro_pin_3.py").exists())
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = repro_template.main([str(src), "--stdout", "--python"])
            self.assertEqual(code, 0)
            self.assertIn("def run(page):", out.getvalue())
        finally:
            common.CACHE_DIR = real_cache
        self.assertEqual(repro_template.route_path("dashboard"), "/")
        self.assertEqual(repro_template.route_path("dashboard", "links"), "/links")
        self.assertEqual(repro_template.route_path("inventory", "items"), "/itemmanagement/items")

    def test_no_em_dashes_in_tool_output(self):
        here = Path(__file__).resolve().parent
        for name in ("common.py", "cli.py", "watch.py", "watch.sh", "README.md", "repro_template.py",
                     "preview.py", "run_e2e.py", "stack.py"):
            text = (here / name).read_text(encoding="utf-8")
            self.assertNotIn(chr(0x2014), text, name + " contains an em dash")
        skill = here.parents[1] / ".claude" / "skills" / "build-notes" / "SKILL.md"
        self.assertTrue(skill.is_file(), str(skill))
        self.assertNotIn(chr(0x2014), skill.read_text(encoding="utf-8"))


# ==========================================================================
# Build Mode v2: ownership, Ready To Check, regression specs
# ==========================================================================

CONTRACT_OWNERS = [
    {"name": "Visesh", "email": "visesh.lodha@greensglobal.com", "paths": [
        "frontend/src/views/InventoryManagement.jsx",
        "frontend/src/components/Assignments.jsx",
        "frontend/src/components/NotificationBell.jsx",
        "frontend/src/components/NotificationToasts.jsx",
        "backend/routers/items.py"]},
    {"name": "Neil", "email": "neil@greensglobal.com", "paths": [
        "frontend/src/views/PropertyAsset.jsx",
        "frontend/src/views/AssetModule.jsx",
        "frontend/src/asset/",
        "backend/routers/assets.py",
        "backend/routers/property_assets.py"]},
]

# A stand-in for backend/code_owners.py as the contract describes it (the real
# file comes from the backend branch). `owner_of` tags its answers so the test
# can tell the module was used rather than the API fallback.
CODE_OWNERS_PY = '''
OWNERS = %r


def normalize(path):
    p = str(path or "").strip().replace("\\\\", "/")
    while p.startswith("./"):
        p = p[2:]
    p = p.lstrip("/")
    if p.startswith("src/"):
        p = "frontend/" + p
    return p


def owner_of(path):
    p = normalize(path)
    for o in OWNERS:
        for rule in o["paths"]:
            if (rule.endswith("/") and p.startswith(rule)) or p == rule:
                return {"name": o["name"] + " (file)", "email": o["email"]}
    return None


def foreign_files(paths, me_email):
    out = []
    for path in paths:
        o = owner_of(path)
        if o and o["email"].lower() != str(me_email or "").lower():
            out.append({"path": normalize(path), "name": o["name"], "email": o["email"]})
    return out
''' % (CONTRACT_OWNERS,)


class _ServerTestBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = FakeServer().start()
        cls.tmp = tempfile.TemporaryDirectory()
        cls._old_env = {k: os.environ.get(k) for k in (common.TOKEN_ENV, common.API_ENV)}
        os.environ[common.TOKEN_ENV] = GOOD_TOKEN
        os.environ.pop(common.API_ENV, None)

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()
        cls.tmp.cleanup()
        for k, v in cls._old_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def setUp(self):
        self.server.state["calls"].clear()
        self.server.state["wait_batches"].clear()
        self.server.state["owners"] = CONTRACT_OWNERS
        self.server.state.pop("claim_skipped", None)
        self.server.state.pop("statuses", None)
        self._real_owners_file = cli.OWNERS_FILE
        self._real_git = cli.GIT_LINES
        self._real_cache = common.CACHE_DIR

    def tearDown(self):
        cli.OWNERS_FILE = self._real_owners_file
        cli.GIT_LINES = self._real_git
        common.CACHE_DIR = self._real_cache

    def gets(self, path):
        return [c for c in self.server.state["calls"] if c[0] == "GET" and c[1] == path]


class OwnershipTest(_ServerTestBase):
    def test_normalize(self):
        self.assertEqual(cli.normalize_path("src/tasks/X.jsx"), "frontend/src/tasks/X.jsx")
        self.assertEqual(cli.normalize_path("./src/views/HR.jsx"), "frontend/src/views/HR.jsx")
        self.assertEqual(cli.normalize_path("frontend/src/App.jsx"), "frontend/src/App.jsx")
        self.assertEqual(cli.normalize_path("backend/routers/items.py"), "backend/routers/items.py")

    def test_owners_falls_back_to_the_api_when_the_file_is_missing(self):
        cli.OWNERS_FILE = str(Path(self.tmp.name) / "no-such" / "code_owners.py")
        code, out, err = run_cli(["--api", self.server.base, "owners", "--me", "neil@greensglobal.com",
                                  "src/views/InventoryManagement.jsx", "frontend/src/asset/AssetHome.jsx",
                                  "backend/routers/tasks.py"])
        self.assertEqual(code, 3, err)
        self.assertEqual(len(self.gets("/dev-notes/owners")), 1)
        self.assertIn("GET /dev-notes/owners", err)
        self.assertRegex(out, r"frontend/src/views/InventoryManagement\.jsx +Visesh \(visesh\.lodha@greensglobal\.com\)")
        self.assertRegex(out, r"frontend/src/asset/AssetHome\.jsx +Neil \(neil@greensglobal\.com\)")
        self.assertRegex(out, r"backend/routers/tasks\.py +no owner")
        self.assertIn("Owned by another developer", err)
        self.assertIn("frontend/src/views/InventoryManagement.jsx - Visesh's area", err)
        self.assertNotIn("AssetHome.jsx - ", err)
        self.assertIn("git checkout origin/dev -- <file>", err)

    def test_owners_own_area_is_not_foreign(self):
        cli.OWNERS_FILE = str(Path(self.tmp.name) / "no-such" / "code_owners.py")
        code, out, err = run_cli(["--api", self.server.base, "owners", "--me", "NEIL@greensglobal.com",
                                  "frontend/src/asset/lib/sync.js", "backend/routers/property_assets.py"])
        self.assertEqual(code, 0, err)
        self.assertIn("No files in another developer's area.", out)

    def test_owners_loads_the_module_by_path_without_a_token(self):
        root = Path(self.tmp.name) / "repo" / "backend"
        root.mkdir(parents=True, exist_ok=True)
        (root / "code_owners.py").write_text(CODE_OWNERS_PY, encoding="utf-8")
        cli.OWNERS_FILE = str(root / "code_owners.py")
        saved = os.environ.pop(common.TOKEN_ENV)
        real_token_file = common.TOKEN_FILE
        common.TOKEN_FILE = Path(self.tmp.name) / "missing.token"
        try:
            code, out, err = run_cli(["--api", self.server.base, "owners", "--check", "--me", "neil@greensglobal.com",
                                      "backend/routers/items.py", "src/asset/AssetHome.jsx"])
        finally:
            os.environ[common.TOKEN_ENV] = saved
            common.TOKEN_FILE = real_token_file
        self.assertEqual(code, 3, err)
        self.assertIn("Visesh (file)", out)           # the module's own owner_of answered
        self.assertEqual(self.gets("/dev-notes/owners"), [])
        self.assertIn("backend/routers/items.py - Visesh (file)'s area", err)
        # Without a token or --me, --check cannot know who you are.
        os.environ.pop(common.TOKEN_ENV)
        common.TOKEN_FILE = Path(self.tmp.name) / "missing.token"
        try:
            code, out, err = run_cli(["--api", self.server.base, "owners", "--check", "backend/routers/items.py"])
        finally:
            os.environ[common.TOKEN_ENV] = saved
            common.TOKEN_FILE = real_token_file
        self.assertEqual(code, 2)
        self.assertIn("--me", err)

    def test_owners_check_reads_the_branch_changes_and_whoami(self):
        cli.OWNERS_FILE = str(Path(self.tmp.name) / "no-such" / "code_owners.py")
        asked = []

        def fake_git(args):
            asked.append(list(args))
            if args[-1] == "origin/dev...HEAD":
                return ["frontend/src/tasks/TasksHome.jsx", "backend/routers/items.py"]
            if args[0] == "ls-files":
                return ["frontend/src/components/NotificationBell.jsx"]
            return ["frontend/src/tasks/TasksHome.jsx"]

        cli.GIT_LINES = fake_git
        code, out, err = run_cli(["--api", self.server.base, "owners", "--check"])
        self.assertEqual(code, 3, err)
        self.assertEqual(len(asked), 4)
        self.assertIn(["diff", "--name-only", "--no-renames", "origin/dev...HEAD"], asked)
        self.assertIn(["diff", "--name-only", "--no-renames", "--cached"], asked)
        self.assertIn(["ls-files", "--others", "--exclude-standard"], asked)
        self.assertEqual(len(self.gets("/dev-notes/cli/whoami")), 1)   # me = whoami's email
        self.assertIn("backend/routers/items.py - Visesh's area", err)
        self.assertIn("frontend/src/components/NotificationBell.jsx - Visesh's area", err)
        self.assertEqual(out.count("frontend/src/tasks/TasksHome.jsx"), 1)   # de-duplicated
        cli.GIT_LINES = lambda args: []
        code, out, err = run_cli(["--api", self.server.base, "owners", "--check"])
        self.assertEqual(code, 0)
        self.assertIn("No changed files.", out)


class BriefV2Test(_ServerTestBase):
    def test_reopened_on_the_preview_is_under_the_header(self):
        note = sample_note(self.server.base, with_media=False)
        note.update(status="building", previewVerdict="reopened", branch="build/tasks-home-polish-1024", prNumber=812)
        note["thread"] = [
            {"by": "claude", "kind": "claude", "text": "Which button?"},
            {"by": "neil@greensglobal.com", "kind": "comment", "text": "The Updates one."},
            {"by": "system", "kind": "system", "text": "PR #812 Open"},
            {"by": "neil@greensglobal.com", "kind": "comment", "text": "Still overlaps on phones."},
            {"by": "claude", "kind": "progress", "text": "Picked up by Claude Code"},
        ]
        brief = cli.render_brief(note, [])
        lines = brief.splitlines()
        self.assertEqual(lines[1], "Reopened on the preview: Still overlaps on phones.")
        self.assertIn("SAME branch build/tasks-home-polish-1024 (PR #812)", lines[2])
        self.assertNotIn("Author's latest answer", brief)
        self.assertIn("(reopened on the preview)", watch.describe_batch([note], [])[0])

    def test_pr_merged_while_reworking_means_a_new_branch(self):
        note = sample_note(self.server.base, with_media=False)
        note.update(status="building", previewVerdict="reopened", branch="", prNumber=0, prUrl="")
        note["thread"] = [
            {"by": "system", "kind": "system", "text": "Reopened On The Preview"},
            {"by": "system", "kind": "system", "text": "PR #812 merged while this pin was being reworked - the rework comes in a new PR"},
            {"by": "neil@greensglobal.com", "kind": "comment", "text": "Still overlaps on phones."},
        ]
        lines = cli.render_brief(note, []).splitlines()
        self.assertEqual(lines[1], "Reopened on the preview: Still overlaps on phones.")
        self.assertIn("NEW branch from fresh origin/dev (the usual name plus -r2)", lines[2])
        self.assertNotIn("SAME branch", "\n".join(lines))
        # An answered pin whose PR merged meanwhile gets the same line.
        answered = dict(note, previewVerdict="", status="needs_input")
        self.assertIn("NEW branch", cli.render_brief(answered, []))
        # Once the -r2 PR is recorded the old entry no longer counts.
        r2 = dict(note, branch="build/x-1024-r2", prNumber=820)
        self.assertNotIn("NEW branch", cli.render_brief(r2, []))
        self.assertIn("SAME branch build/x-1024-r2 (PR #820)", cli.render_brief(r2, []))
        # A plain answered pin that never had a PR says nothing about branches.
        plain = sample_note(self.server.base, with_media=False)
        plain["status"] = "needs_input"
        self.assertNotIn("branch", cli.render_brief(plain, []).split("## Where")[0].lower())

    def test_held_pin_and_ready_to_check_labels(self):
        note = sample_note(self.server.base, with_media=False)
        note.update(ownerName="Visesh", ownerEmail="visesh.lodha@greensglobal.com", held=True)
        self.assertIn("Waits for Visesh", cli.render_brief(note, []))
        note.update(held=False, ownerReleasedBy="visesh.lodha@greensglobal.com")
        self.assertIn("Owner: Visesh - released to Claude Code by visesh.lodha@greensglobal.com", cli.render_brief(note, []))
        # `held` computed when the server leaves it out.
        self.assertTrue(cli.is_held({"ownerEmail": "visesh.lodha@greensglobal.com", "createdBy": "neil@greensglobal.com"}))
        self.assertFalse(cli.is_held({"ownerEmail": "neil@greensglobal.com", "createdBy": "neil@greensglobal.com"}))
        ready = dict(sample_note(self.server.base, with_media=False), status="pr_open", preview={"url": "http://localhost:5180/tasks/home"})
        self.assertEqual(cli.display_status(ready), "Ready To Check")
        self.assertEqual(cli.display_status(dict(ready, previewVerdict="accepted")), "PR Open")
        self.assertIn("Status: Ready To Check", cli.render_brief(ready, []))

    def test_claim_prints_skipped_reasons(self):
        self.server.state["claim_skipped"] = [{"id": NOTE_ID_2, "number": 2, "status": "open",
                                               "reason": "Pin #2 waits for Visesh - it is in their area"}]
        code, out, err = run_cli(["--api", self.server.base, "claim", NOTE_ID, "--out", self.tmp.name, "--no-download"])
        self.assertEqual(code, 0, err)
        self.assertIn("Not claimed: Pin #2 - Pin #2 waits for Visesh - it is in their area", err)


class E2ESpecTest(_ServerTestBase):
    def test_spec_shape(self):
        pin = sample_note("http://x", with_media=False)
        spec = repro_template.spec_from_pin(pin)
        lines = spec.splitlines()
        imports = [ln for ln in lines if ln.startswith("import ")]
        self.assertEqual(imports, [
            "import { test, expect } from '@playwright/test';",
            "import { openApp, go, clickByText, fillByLabel, selectByLabel, expectVisible } from '../helpers.mjs';",
        ])
        tests = [ln for ln in lines if ln.startswith("test(")]
        self.assertEqual(len(tests), 1)
        self.assertTrue(tests[0].startswith("test('[" + NOTE_ID + "] Pin #3 - The Mark All Read button is lowercase"), tests[0])
        self.assertTrue(tests[0].endswith("', async ({ page }) => {"))
        # post-results.mjs reads the case id with this pattern; run_e2e reads it back too.
        title = re.search(r"test\('(.*?)', async", tests[0]).group(1)
        self.assertRegex(title, r"^\[([0-9a-f-]{36})\]")
        self.assertEqual(run_e2e.pin_id_from_spec(spec), NOTE_ID)
        # Helpers first, a failing TODO, the empty-database reminder.
        self.assertIn("  await openApp(page);", spec)
        self.assertIn("  await go(page, 'tasks/home');", spec)
        self.assertIn("  await fillByLabel(page, 'Search tasks', 'TODO: the value typed here');", spec)
        self.assertIn("  await clickByText(page, 'Mark all read');", spec)
        self.assertIn("  // or: await page.locator('button.secondary-btn').first().click();", spec)
        self.assertIn("  await page.keyboard.press('Escape');", spec)
        self.assertIn("  expect(false, 'TODO: assert the pin complaint').toBe(true);", spec)
        self.assertIn("EMPTY database", spec)
        self.assertIn("must create every record it needs itself", spec)
        self.assertTrue(spec.rstrip().endswith("});"))
        self.assertEqual(cli.repro_kind(spec, "repro_pin_3.spec.mjs"), "e2e")
        self.assertEqual(cli.repro_kind(repro_template.script_from_pin(pin), "repro_pin_3.py"), "python")
        # A hostile comment stays inside the escaped title and a comment line.
        hostile = dict(pin, comment="It's \"broken\" '); require('child_process').exec('x'); //\nline two")
        hspec = repro_template.spec_from_pin(hostile)
        htests = [ln for ln in hspec.splitlines() if ln.startswith("test(")]
        self.assertEqual(len(htests), 1)
        self.assertIn("It\\'s \"broken\" \\'); require(\\'child_process\\')", htests[0])
        self.assertTrue(htests[0].endswith("', async ({ page }) => {"))
        code_lines = [ln for ln in hspec.splitlines() if not ln.strip().startswith("//") and not ln.startswith("test(")]
        self.assertFalse([ln for ln in code_lines if "child_process" in ln])
        node = shutil.which("node")
        if node:
            for name, text in (("ok.spec.mjs", spec), ("hostile.spec.mjs", hspec)):
                path = Path(self.tmp.name) / name
                path.write_text(text, encoding="utf-8")
                res = subprocess.run([node, "--check", str(path)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
                self.assertEqual(res.returncode, 0, res.stdout)

    def test_default_form_and_paths(self):
        pin = sample_note("http://x", with_media=False)
        src = Path(self.tmp.name) / "pin-e2e.json"
        src.write_text(json.dumps(pin))
        common.CACHE_DIR = Path(self.tmp.name) / "cache-e2e"
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(repro_template.main([str(src)]), 0)
        written = common.CACHE_DIR / NOTE_ID / "repro_pin_3.spec.mjs"
        self.assertTrue(written.is_file())
        self.assertIn("from '../helpers.mjs'", written.read_text())
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(repro_template.main([str(src), "--python"]), 0)
        self.assertTrue((common.CACHE_DIR / NOTE_ID / "repro_pin_3.py").is_file())
        dest = Path(self.tmp.name) / "x.py"
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(repro_template.main([str(src), "--out", str(dest)]), 0)
        self.assertIn("def run(page):", dest.read_text())
        self.assertEqual(repro_template.default_kind({"id": "a", "actions": [], "kind": "change"}), "python")
        self.assertEqual(repro_template.default_kind({"id": "a", "actions": [], "kind": "bug"}), "e2e")
        self.assertEqual(repro_template.default_kind([{"type": "click"}]), "python")

    def test_verify_sends_repro_kind(self):
        pin = sample_note("http://x", with_media=False)
        spec = Path(self.tmp.name) / "repro_pin_3.spec.mjs"
        spec.write_text(repro_template.spec_from_pin(pin))
        code, out, err = run_cli(["--api", self.server.base, "verify", NOTE_ID, "--repro-script", str(spec),
                                  "--before", "failing", "--after", "passing"])
        self.assertEqual(code, 0, err)
        body = self.server.posts("/dev-notes/cli/verify/" + NOTE_ID)[0][2]
        self.assertEqual(body["repro"]["kind"], "e2e")
        self.assertEqual(body["repro"]["before"], "failing")
        self.assertIn("[" + NOTE_ID + "]", body["repro"]["script"])
        self.assertNotIn("Warning", err)
        # A spec whose title lacks the pin id is still recorded, with a warning.
        other = Path(self.tmp.name) / "other.spec.mjs"
        other.write_text(repro_template.spec_from_pin(dict(pin, id=NOTE_ID_2)))
        code, out, err = run_cli(["--api", self.server.base, "verify", NOTE_ID, "--repro-script", str(other),
                                  "--before", "failing", "--after", "passing"])
        self.assertEqual(code, 0, err)
        self.assertIn("does not start with [" + NOTE_ID + "]", err)
        # Over the server's 20 KB cap: refused before anything is sent.
        big = Path(self.tmp.name) / "big.spec.mjs"
        big.write_text(repro_template.spec_from_pin(pin) + "// " + "x" * (20 * 1024) + "\n")
        sent = len(self.server.posts("/dev-notes/cli/verify/"))
        code, out, err = run_cli(["--api", self.server.base, "verify", NOTE_ID, "--repro-script", str(big),
                                  "--before", "failing", "--after", "passing"])
        self.assertEqual(code, 2)
        self.assertIn("over 20 KB", err)
        self.assertEqual(len(self.server.posts("/dev-notes/cli/verify/")), sent)

    def test_fallback_foreign_files_matches_the_module_contract(self):
        owners = cli.OwnersMap(owners=CONTRACT_OWNERS)
        self.assertEqual(owners.foreign_files(["src/views/InventoryManagement.jsx", "frontend/src/views/InventoryManagement.jsx",
                                               "backend/routers/items.py", "src/asset/x.js"], "neil@greensglobal.com"), [
            {"path": "frontend/src/views/InventoryManagement.jsx", "name": "Visesh", "email": "visesh.lodha@greensglobal.com"},
            {"path": "backend/routers/items.py", "name": "Visesh", "email": "visesh.lodha@greensglobal.com"},
        ])


class FakeSystem:
    """Records what preview.py / run_e2e.py would run; fakes the effects they rely on."""

    def __init__(self, main_root, cors_ports=(5173, 5174)):
        self.main_root = Path(main_root)
        self.cors_ports = cors_ports
        self.events = []
        self.spawns = []
        self.alive_pids = set()
        self.commands = {}
        self.busy = set()
        self.next_pid = 5000
        self.http_up = True
        self.live_code = 0
        self.live_seen = {}
        self.clock = 0

    def run(self, cmd, cwd=None, env=None, check=True, timeout=None):
        cmd = [str(c) for c in cmd]
        self.events.append(("run", cmd, str(cwd) if cwd else None, env))
        if cmd[:3] == ["git", "rev-parse", "--git-common-dir"]:
            return 0, str(self.main_root / ".git") + "\n"
        if cmd == ["git", "rev-parse", "HEAD"]:
            return 0, PREVIEW_SHA + "\n"
        if cmd[:3] == ["git", "worktree", "add"]:
            wt = Path(cmd[4])
            for sub in ("backend", "frontend", "e2e"):
                (wt / sub).mkdir(parents=True, exist_ok=True)
            (wt / ".git").write_text("gitdir: fake\n")
            (wt / "backend" / "main.py").write_text("_CORS_ORIGINS = [\n" + "".join(
                '    "http://localhost:%d",\n    "http://127.0.0.1:%d",\n' % (p, p) for p in self.cors_ports) + "]\n")
        return 0, ""

    def run_live(self, cmd, cwd=None, env=None, timeout=None):
        cmd = [str(c) for c in cmd]
        self.events.append(("live", cmd, str(cwd), env))
        spec = Path(cwd) / cmd[-1]
        self.live_seen = {"spec": spec.read_text() if spec.is_file() else None, "env": env}
        return self.live_code

    def spawn(self, cmd, cwd, env, log_path):
        pid = self.next_pid
        self.next_pid += 1
        cmd = [str(c) for c in cmd]
        self.alive_pids.add(pid)
        self.commands[pid] = " ".join(cmd)
        self.spawns.append({"pid": pid, "cmd": cmd, "cwd": str(cwd), "env": env, "log": str(log_path)})
        self.events.append(("spawn", pid, cmd))
        return pid

    def alive(self, pid):
        return pid in self.alive_pids

    def command_of(self, pid):
        return self.commands.get(pid, "")

    def terminate(self, pid, timeout=10):
        self.events.append(("terminate", pid))
        self.alive_pids.discard(pid)

    def http_ok(self, url, timeout=3):
        self.events.append(("http", url))
        return self.http_up

    def port_busy(self, port):
        return port in self.busy

    def free_port(self):
        return 18123

    def hostname(self):
        return "neils-mbp"

    def sleep(self, seconds):
        self.clock += seconds

    def now(self):
        self.clock += 1
        return self.clock

    def runs(self, prefix):
        return [e for e in self.events if e[0] == "run" and e[1][:len(prefix)] == prefix]


def make_main_checkout(root, with_db=True):
    root = Path(root)
    (root / "backend" / ".venv" / "bin").mkdir(parents=True, exist_ok=True)
    (root / "backend" / ".venv" / "bin" / "python").write_text("#!/bin/sh\n")
    (root / "frontend" / "node_modules" / ".bin").mkdir(parents=True, exist_ok=True)
    (root / "backend" / ".env").write_text("# local\nNEXUS_SKIP_AUTH=true\nNEXUS_DEV_EMAIL=dev.person@greensglobal.com\n")
    db = root / "backend" / "greens_nexus.db"
    if with_db:
        conn = sqlite3.connect(str(db))
        conn.execute("create table people (name text)")
        conn.execute("insert into people values ('Local Row')")
        conn.commit()
        conn.close()
    return root


PREVIEW_SHA = "4c66997f" + "0" * 32
SHARED_DB_URL = "postgresql://user:pw@shared-dev.example:6543/postgres"


class PreviewTest(_ServerTestBase):
    BRANCH = "build/tasks-home-polish-1024"

    def setUp(self):
        super().setUp()
        self.root = Path(tempfile.mkdtemp(dir=self.tmp.name))
        common.CACHE_DIR = self.root / "cache"
        self.main = make_main_checkout(self.root / "main")
        self.fs = FakeSystem(self.main)
        self.lines = []

    def make(self, base_env=None):
        env = {"DATABASE_URL": SHARED_DB_URL, "PATH": "/usr/bin"} if base_env is None else base_env
        return preview.Preview(system=self.fs, client_factory=lambda: common.Client(self.server.base, GOOD_TOKEN),
                               out=self.lines.append, err=self.lines.append, cwd=self.main, base_env=env)

    def test_start_builds_the_env_copies_the_db_and_posts_the_pins(self):
        original = self.main / "backend" / "greens_nexus.db"
        before = original.read_bytes()
        code = self.make().start(self.BRANCH, [NOTE_ID, NOTE_ID_2], pr=812)
        self.assertEqual(code, 0, "\n".join(self.lines))
        wt = common.CACHE_DIR / "preview" / "build-tasks-home-polish-1024"
        # git: fetch, then a detached worktree at origin/<branch>.
        self.assertTrue(self.fs.runs(["git", "fetch", "origin", self.BRANCH]))
        self.assertEqual(self.fs.runs(["git", "worktree", "add"])[0][1],
                         ["git", "worktree", "add", "--detach", str(wt), "origin/" + self.BRANCH])
        self.assertEqual(os.readlink(str(wt / "frontend" / "node_modules")), str(self.main / "frontend" / "node_modules"))
        backend, frontend = self.fs.spawns
        # Backend: the worktree's preview.db copy, never the shared DATABASE_URL, never the original file.
        self.assertEqual(backend["cwd"], str(wt / "backend"))
        self.assertEqual(backend["env"]["DATABASE_URL"], "sqlite:///./preview.db")
        self.assertEqual(backend["env"]["NEXUS_SKIP_AUTH"], "true")
        self.assertEqual(backend["env"]["NEXUS_DEV_EMAIL"], "dev.person@greensglobal.com")
        self.assertNotIn(SHARED_DB_URL, backend["env"].values())
        self.assertFalse([v for v in backend["env"].values() if str(original) in str(v) or "greens_nexus.db" in str(v)])
        self.assertEqual(backend["cmd"][:4], [str(self.main / "backend" / ".venv" / "bin" / "python"), "-m", "uvicorn", "main:app"])
        self.assertIn("8090", backend["cmd"])
        copy = wt / "backend" / "preview.db"
        conn = sqlite3.connect(str(copy))
        self.assertEqual(conn.execute("select name from people").fetchall(), [("Local Row",)])
        conn.close()
        self.assertEqual(original.read_bytes(), before)
        # Frontend: vite on 5180 --strictPort against the preview backend, dev sign-in as the same person.
        self.assertEqual(frontend["cwd"], str(wt / "frontend"))
        self.assertEqual(frontend["cmd"][1:], ["--port", "5180", "--strictPort"])
        self.assertTrue(frontend["cmd"][0].endswith("node_modules/.bin/vite"))
        self.assertEqual(frontend["env"]["VITE_API_BASE"], "http://localhost:8090")
        self.assertEqual(frontend["env"]["VITE_DEV_SKIP_AUTH"], "true")
        self.assertEqual(frontend["env"]["VITE_DEV_USER_EMAIL"], "dev.person@greensglobal.com")
        # Waited for both, then posted each pin with its own path on the preview.
        self.assertIn(("http", "http://localhost:8090/health"), self.fs.events)
        self.assertIn(("http", "http://localhost:5180/"), self.fs.events)
        body = self.server.posts("/dev-notes/cli/preview/" + NOTE_ID)[0][2]
        self.assertEqual(body, {"url": "http://localhost:5180/tasks/home", "branch": self.BRANCH, "prNumber": 812,
                                "host": "neils-mbp", "commit": PREVIEW_SHA})
        rev = self.fs.runs(["git", "rev-parse", "HEAD"])[0]
        self.assertEqual(rev[2], str(wt))   # the sha of the preview worktree, not of this checkout
        self.assertEqual(len(self.server.posts("/dev-notes/cli/preview/" + NOTE_ID_2)), 1)
        self.assertIn("Ready To Check on http://localhost:5180 - open it on this computer", self.lines)
        pid_dir = common.CACHE_DIR / "preview"
        self.assertEqual((pid_dir / "backend.pid").read_text(), str(backend["pid"]))
        self.assertEqual((pid_dir / "frontend.pid").read_text(), str(frontend["pid"]))
        state = json.loads((pid_dir / "current.json").read_text())
        self.assertEqual(state["pins"][0]["url"], "http://localhost:5180/tasks/home")

    def test_start_stops_the_running_preview_first(self):
        pid_dir = common.CACHE_DIR / "preview"
        pid_dir.mkdir(parents=True)
        (pid_dir / "backend.pid").write_text("111")
        (pid_dir / "frontend.pid").write_text("222")
        self.fs.alive_pids.update({111, 222})
        self.fs.commands.update({111: "python -m uvicorn main:app --port 8090", 222: "node vite --port 5180 --strictPort"})
        self.assertEqual(self.make().start(self.BRANCH, [], post=False), 0)
        kinds = [e[0] for e in self.fs.events]
        first_spawn = kinds.index("spawn")
        terminated = [e[1] for e in self.fs.events[:first_spawn] if e[0] == "terminate"]
        self.assertEqual(sorted(terminated), [111, 222])
        self.assertEqual(self.server.posts("/dev-notes/cli/preview/"), [])

    def test_stop_never_kills_a_pid_that_is_not_the_preview(self):
        pid_dir = common.CACHE_DIR / "preview"
        pid_dir.mkdir(parents=True)
        (pid_dir / "backend.pid").write_text("333")
        self.fs.alive_pids.add(333)
        self.fs.commands[333] = "/Applications/Safari.app/Contents/MacOS/Safari"
        self.assertEqual(self.make().stop(), 0)
        self.assertNotIn(("terminate", 333), self.fs.events)
        self.assertFalse((pid_dir / "backend.pid").exists())

    def test_reuses_and_resets_an_existing_worktree(self):
        wt = common.CACHE_DIR / "preview" / "build-tasks-home-polish-1024"
        (wt / "backend").mkdir(parents=True)
        (wt / "frontend").mkdir(parents=True)
        (wt / ".git").write_text("gitdir: x\n")
        self.assertEqual(self.make().start(self.BRANCH, [], post=False), 0)
        resets = self.fs.runs(["git", "reset", "--hard"])
        self.assertEqual(resets[0][1], ["git", "reset", "--hard", "origin/" + self.BRANCH])
        self.assertEqual(resets[0][2], str(wt))
        self.assertEqual(self.fs.runs(["git", "worktree", "add"]), [])

    def test_no_local_db_starts_fresh_and_says_so(self):
        (self.main / "backend" / "greens_nexus.db").unlink()
        wt = common.CACHE_DIR / "preview" / "build-tasks-home-polish-1024"
        (wt / "backend").mkdir(parents=True)
        (wt / ".git").write_text("gitdir: x\n")
        (wt / "backend" / "preview.db").write_text("stale")
        self.assertEqual(self.make(base_env={"DATABASE_URL": SHARED_DB_URL}).start(self.BRANCH, [], post=False), 0)
        self.assertFalse((wt / "backend" / "preview.db").exists())
        self.assertTrue([ln for ln in self.lines if "fresh, empty SQLite" in ln])
        self.assertEqual(self.fs.spawns[0]["env"]["DATABASE_URL"], "sqlite:///./preview.db")

    def test_health_timeout_stops_what_it_started(self):
        self.fs.http_up = False
        with self.assertRaises(preview.stack.StackError) as ctx:
            self.make().start(self.BRANCH, [NOTE_ID])
        self.assertIn("did not answer within 90s", str(ctx.exception))
        for s in self.fs.spawns:
            self.assertIn(("terminate", s["pid"]), self.fs.events)
        self.assertEqual(self.server.posts("/dev-notes/cli/preview/"), [])

    def test_a_busy_port_is_refused_before_anything_starts(self):
        self.fs.busy.add(5180)
        with self.assertRaises(preview.PreviewError) as ctx:
            self.make().start(self.BRANCH, [], post=False)
        self.assertIn("Port 5180", str(ctx.exception))
        self.assertEqual(self.fs.spawns, [])

    def test_preview_url_and_local_only(self):
        self.assertEqual(cli.preview_url("http://localhost:5180/", {"url": "https://dev.nexus.greensglobal.com/tasks/home?x=1"}),
                         "http://localhost:5180/tasks/home")
        self.assertEqual(cli.preview_url(None, {"route": "myhr", "sub": "timesheet"}), "http://localhost:5180/workday/timesheet")
        with self.assertRaises(common.ConfigError):
            cli.post_preview(None, NOTE_ID, base="https://example.com")
        self.assertEqual(cli.pr_arg("https://github.com/o/r/pull/812"), 812)
        self.assertEqual(cli.pr_arg("#77"), 77)

    def test_cli_preview_command(self):
        asked = []

        def fake_git(args):
            asked.append(list(args))
            return ["abc123" + "0" * 34] if args[-1] == "origin/b^{commit}" else None

        cli.GIT_LINES = fake_git
        code, out, err = run_cli(["--api", self.server.base, "preview", NOTE_ID, NOTE_ID_3, "--branch", "b",
                                  "--pr", "https://github.com/o/r/pull/812", "--host", "studio"])
        self.assertEqual(code, 1)   # NOTE_ID_3 is not PR Open (409)
        self.assertEqual(self.server.posts("/dev-notes/cli/preview/" + NOTE_ID)[0][2],
                         {"url": "http://localhost:5180/tasks/home", "branch": "b", "prNumber": 812, "host": "studio",
                          "commit": "abc123" + "0" * 34})
        self.assertEqual(asked[0], ["rev-parse", "--verify", "--quiet", "origin/b^{commit}"])
        self.assertIn("Pin #3 Ready To Check: http://localhost:5180/tasks/home", out)
        self.assertIn("Preview not recorded on pin " + NOTE_ID_3 + " - Pin is not PR Open", err)
        # --commit wins; an unresolvable branch with no --commit warns and sends none.
        code, out, err = run_cli(["--api", self.server.base, "preview", NOTE_ID, "--branch", "b", "--commit", "deadbeef"])
        self.assertEqual(self.server.posts("/dev-notes/cli/preview/" + NOTE_ID)[-1][2]["commit"], "deadbeef")
        cli.GIT_LINES = lambda args: None
        code, out, err = run_cli(["--api", self.server.base, "preview", NOTE_ID, "--branch", "gone"])
        self.assertEqual(code, 0, err)
        self.assertNotIn("commit", self.server.posts("/dev-notes/cli/preview/" + NOTE_ID)[-1][2])
        self.assertIn("pass --commit", err)


class RunE2ETest(_ServerTestBase):
    def setUp(self):
        super().setUp()
        self.root = Path(tempfile.mkdtemp(dir=self.tmp.name))
        common.CACHE_DIR = self.root / "cache"
        self.main = make_main_checkout(self.root / "main", with_db=False)
        self.fs = FakeSystem(self.main)
        self.lines = []
        self.spec = self.root / "repro_pin_3.spec.mjs"
        self.spec.write_text(repro_template.spec_from_pin(sample_note("http://x", with_media=False)))

    def make(self):
        return run_e2e.E2ERun(system=self.fs, out=self.lines.append, err=self.lines.append, cwd=self.main,
                              base_env={"DATABASE_URL": SHARED_DB_URL, "PATH": "/usr/bin"})

    def test_runs_like_ci_and_reports_failing(self):
        self.fs.busy.add(5173)
        self.fs.live_code = 1
        self.assertEqual(self.make().run(str(self.spec), "origin/dev"), 1)
        self.assertEqual(self.lines.count("FAILING"), 1)
        self.assertTrue(self.fs.runs(["git", "fetch", "origin", "dev"]))
        add = self.fs.runs(["git", "worktree", "add"])[0][1]
        self.assertEqual(add[:4], ["git", "worktree", "add", "--detach"])
        self.assertEqual(add[5], "origin/dev")
        wt = Path(add[4])
        self.assertTrue(str(wt).startswith(str(common.CACHE_DIR / "e2e")))
        # Backend twice (primed, restarted), fresh SQLite, auth skipped, QA module on.
        backends = [s for s in self.fs.spawns if "uvicorn" in s["cmd"]]
        self.assertEqual(len(backends), 2)
        for b in backends:
            self.assertEqual(b["env"]["DATABASE_URL"], "sqlite:///./e2e.db")
            self.assertEqual(b["env"]["NEXUS_SKIP_AUTH"], "true")
            self.assertEqual(b["env"]["NEXUS_QA_MODULE"], "true")
            self.assertEqual(b["env"]["NEXUS_DEV_EMAIL"], "ci@greensglobal.com")
            self.assertIn("18123", b["cmd"])
        self.assertIn(("terminate", backends[0]["pid"]), self.fs.events)
        # The frontend is the VITE_E2E build pointed at that backend, served on a CORS-allowed port.
        build = [e for e in self.fs.events if e[0] == "run" and e[1][-1] == "build"][0]
        self.assertEqual(build[3]["VITE_E2E"], "true")
        self.assertEqual(build[3]["VITE_API_BASE"], "http://localhost:18123")
        served = [s for s in self.fs.spawns if "preview" in s["cmd"]][0]
        self.assertEqual(served["cmd"][-3:], ["--port", "5174", "--strictPort"])
        # e2e deps installed (the main checkout has none), spec placed and run like CI.
        self.assertTrue(self.fs.runs(["npm", "ci"]))
        # The browser is installed (as CI does) before the test runs, so a missing one is never a verdict.
        install_at = next(i for i, e in enumerate(self.fs.events) if e[0] == "run" and e[1] == ["npx", "playwright", "install", "chromium"])
        live_at = next(i for i, e in enumerate(self.fs.events) if e[0] == "live")
        self.assertLess(install_at, live_at)
        live = [e for e in self.fs.events if e[0] == "live"][0]
        self.assertEqual(live[1], ["npx", "playwright", "test", "tests/generated/" + NOTE_ID + ".spec.mjs"])
        self.assertEqual(live[2], str(wt / "e2e"))
        self.assertEqual(self.fs.live_seen["env"]["NEXUS_E2E_URL"], "http://localhost:5174")
        self.assertIn("from '../../helpers.mjs'", self.fs.live_seen["spec"])
        self.assertNotIn("from '../helpers.mjs'", self.fs.live_seen["spec"])
        # Cleaned up: every process stopped, the scratch worktree removed.
        self.assertEqual(self.fs.alive_pids, set())
        self.assertEqual(self.fs.runs(["git", "worktree", "remove"])[0][1], ["git", "worktree", "remove", "--force", str(wt)])

    def test_passing_and_the_branch_ref(self):
        self.fs.live_code = 0
        self.assertEqual(self.make().run(str(self.spec), "build/tasks-home-polish-1024"), 0)
        self.assertIn("PASSING", self.lines)
        self.assertEqual(self.fs.runs(["git", "fetch"]), [])   # a local branch is used as it is
        self.assertEqual(self.fs.runs(["git", "worktree", "add"])[0][1][5], "build/tasks-home-polish-1024")

    def test_no_pin_id_or_no_free_cors_port_is_no_verdict(self):
        bare = self.root / "bare.spec.mjs"
        bare.write_text("import { test } from '@playwright/test';\ntest('no id', async () => {});\n")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(run_e2e.main([str(bare), "--ref", "origin/dev"], runner=self.make()), 2)
        self.assertIn("[<pin id>]", err.getvalue())
        self.fs.busy.update({5173, 5174})
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(run_e2e.main([str(self.spec), "--ref", "origin/dev"], runner=self.make()), 2)
        self.assertIn("CORS", err.getvalue())
        self.assertEqual(self.fs.alive_pids, set())
        self.assertTrue(self.fs.runs(["git", "worktree", "remove"]))

    def test_cors_ports_and_import_rewrite(self):
        self.assertEqual(run_e2e.cors_ports('["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5180"]'), [5173, 5180])
        self.assertEqual(run_e2e.generated_spec("import { go } from '../helpers.mjs';"), "import { go } from '../../helpers.mjs';")


if __name__ == "__main__":
    unittest.main()
