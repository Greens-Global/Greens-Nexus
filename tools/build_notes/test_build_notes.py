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

from tools.build_notes import cli, common, watch

GOOD_TOKEN = "nxbn_" + "a" * 43
REVOKED_TOKEN = "nxbn_" + "r" * 43
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
WEBM = b"\x1aE\xdf\xa3" + b"\x01" * 128

NOTE_ID = "6d2d1c1e-0001-4a4a-9b9b-000000000001"
NOTE_ID_2 = "6d2d1c1e-0002-4a4a-9b9b-000000000002"
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
        },
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
        "networkLog": [{"method": "GET", "path": "/tasks/home", "status": 200, "ms": 134, "at": "2026-10-24T16:04:57Z"}],
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

    def test_claude_command_shape(self):
        cmd = watch.claude_command(["a", "b"], '--model opus --permission-mode "accept edits"')
        self.assertEqual(cmd, ["claude", "--model", "opus", "--permission-mode", "accept edits", "/build-notes a b"])
        self.assertTrue((common.repo_root() / "CLAUDE.md").exists())

    # -- claim ------------------------------------------------------------------------

    def test_claim_downloads_media_and_prints_brief(self):
        out_dir = Path(self.tmp.name) / "claims"
        code, out, err = run_cli(["--api", self.server.base, "claim", NOTE_ID, NOTE_ID_2, "--out", str(out_dir)])
        self.assertEqual(code, 0, err)
        claim = self.server.posts("/dev-notes/cli/claim")[0]
        self.assertEqual(claim[2], {"noteIds": [NOTE_ID, NOTE_ID_2]})

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
                       "## Where", "- Route: tasks", "- Sub: home", "- Build: abc1234", "1440x900, @2x, desktop, light theme",
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
                       "## Network (last 1)", "GET /tasks/home -> 200 134ms",
                       "## Files", "- Screenshot: " + str(folder / "screenshot.png"), "- Page shot: " + str(folder / "page.png"),
                       "- Contact sheet: " + str(folder / "sheet.png"), "- Video: " + str(folder / "video.webm"),
                       "- Attachment 1: " + str(folder / "attachment-1.png")):
            self.assertIn(marker, out, marker)
        order = [out.index(h) for h in ("## Where", "## Comment", "## Thread", "## Target", "## Markup", "## Edit In Place",
                                        "## Transcript", "## Console", "## Network", "## Files")]
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
        code, out, err = run_cli(["--api", self.server.base, "claim", NOTE_ID, "not-a-real-id", "--out", str(out_dir), "--no-download"])
        self.assertEqual(code, 0)
        self.assertIn("Not claimed", err)
        self.assertIn("not-a-real-id", err)
        self.assertIn("- Screenshot: " + self.server.base + "/media/screenshot.png", out)

    def test_claim_nothing_returned(self):
        code, out, err = run_cli(["--api", self.server.base, "claim", "zzz", "--out", self.tmp.name])
        self.assertEqual(code, 1)
        self.assertIn("Nothing claimed", out)

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

    def test_no_em_dashes_in_tool_output(self):
        here = Path(__file__).resolve().parent
        for name in ("common.py", "cli.py", "watch.py", "watch.sh", "README.md"):
            text = (here / name).read_text(encoding="utf-8")
            self.assertNotIn(chr(0x2014), text, name + " contains an em dash")
        skill = here.parents[1] / ".claude" / "skills" / "build-notes" / "SKILL.md"
        self.assertTrue(skill.is_file(), str(skill))
        self.assertNotIn(chr(0x2014), skill.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
