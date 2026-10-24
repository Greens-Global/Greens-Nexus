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
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from tools.build_notes import cli, common, repro_template, watch

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
            return self._json(200, {"notes": notes, "sessions": [sample_session()]})
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
        self.assertEqual(body, {"repro": {"script": "print('hi')\n", "before": "failing", "after": "passing"}})
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
                code = repro_template.main([str(src)])
            self.assertEqual(code, 0)
            written = common.CACHE_DIR / NOTE_ID / "repro_pin_3.py"
            self.assertTrue(written.is_file())
            self.assertIn("Wrote " + str(written), out.getvalue())
            self.assertFalse((Path.cwd() / "repro_pin_3.py").exists())
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = repro_template.main([str(src), "--stdout"])
            self.assertEqual(code, 0)
            self.assertIn("def run(page):", out.getvalue())
        finally:
            common.CACHE_DIR = real_cache
        self.assertEqual(repro_template.route_path("dashboard"), "/")
        self.assertEqual(repro_template.route_path("dashboard", "links"), "/links")
        self.assertEqual(repro_template.route_path("inventory", "items"), "/itemmanagement/items")

    def test_no_em_dashes_in_tool_output(self):
        here = Path(__file__).resolve().parent
        for name in ("common.py", "cli.py", "watch.py", "watch.sh", "README.md", "repro_template.py"):
            text = (here / name).read_text(encoding="utf-8")
            self.assertNotIn(chr(0x2014), text, name + " contains an em dash")
        skill = here.parents[1] / ".claude" / "skills" / "build-notes" / "SKILL.md"
        self.assertTrue(skill.is_file(), str(skill))
        self.assertNotIn(chr(0x2014), skill.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
