"""Blocking work stays off the event loop (Oct 13 review, item 9).

A synchronous call inside an `async def` endpoint or middleware freezes the
whole worker for as long as it takes - every other request it is serving,
CORS preflights included (CLAUDE.md, the Aug 2 incident). These upload
endpoints and the audit / hardening middleware did exactly that: a 60 s
storage POST, database queries and commits, a workbook parse, Tesseract.

The first half reads the source (AST, so formatting does not matter): each
function listed here is either a plain `def` (FastAPI runs those in its
threadpool) or an `async def` whose OWN body makes no blocking call - what it
hands to asyncio.to_thread lives in a nested `def`, which is not looked into.
The second half runs the audit middleware and checks which thread wrote.

Importing audit binds `database`, so it gets a throwaway SQLite it never
writes to. Run with: python -m pytest test_event_loop_blocking.py
"""
import ast
import os
import tempfile
import threading
import unittest
from unittest import mock

os.environ["DATABASE_URL"] = f"sqlite:///{tempfile.mkdtemp()}/event_loop_test.db"

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import audit  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

# file -> the functions that must not block the loop. "Class.method" for a
# middleware's dispatch.
GUARDED = {
    "routers/hr.py": ["upload_resume", "upload_document", "upload_paystub", "upload_photo",
                      "upload_entity_logo", "upload_sender_override_logo"],
    "routers/myhr.py": ["upload_my_photo", "upload_my_signature_logo", "upload_request_attachment"],
    "routers/esign.py": ["save_draft"],
    "routers/qa.py": ["import_xlsx"],
    "routers/task_config.py": ["task_ocr"],
    "audit.py": ["AuditMiddleware.dispatch"],
    "middleware_hardening.py": ["AuthFailureThrottle.dispatch", "RequestRateLimit.dispatch"],
    "workflows/runner.py": ["workflows_loop"],
}

# Calls that block: anything on these objects...
BLOCKING_OWNERS = {"httpx", "db", "requests", "pytesseract"}
# ...and these by name, however they are reached (`_es._storage_put` counts).
BLOCKING_NAMES = {"SessionLocal", "security_log", "_extract_email", "_acting_as_target",
                  "_storage_put", "_storage_signed_url", "load_workbook", "image_to_string",
                  "video_to_gif"}


def _find(tree, dotted):
    scope = tree.body
    node = None
    for part in dotted.split("."):
        node = next((n for n in scope
                     if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                     and n.name == part), None)
        if node is None:
            return None
        scope = node.body
    return node


def _own_calls(fn):
    """Every call the function makes itself - nested defs and lambdas are
    someone else's body (that is where the to_thread work goes)."""
    stack = list(fn.body)
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            continue
        if isinstance(node, ast.Call):
            yield node
        stack.extend(ast.iter_child_nodes(node))


def _blocking(call):
    f = call.func
    if isinstance(f, ast.Name):
        return f.id if f.id in BLOCKING_NAMES else ""
    if isinstance(f, ast.Attribute):
        if f.attr in BLOCKING_NAMES:
            return f.attr
        if isinstance(f.value, ast.Name) and f.value.id in BLOCKING_OWNERS:
            return f"{f.value.id}.{f.attr}"
    return ""


def blocking_calls(source, dotted):
    """None if the function is missing, else the blocking calls an `async def`
    makes on the loop (always empty for a plain `def`)."""
    fn = _find(ast.parse(source), dotted)
    if fn is None:
        return None
    if not isinstance(fn, ast.AsyncFunctionDef):
        return []
    return sorted({f"{_blocking(c)} (line {c.lineno})" for c in _own_calls(fn) if _blocking(c)})


class NothingBlocksTheLoop(unittest.TestCase):
    def test_the_guarded_functions(self):
        for rel, names in GUARDED.items():
            with open(os.path.join(HERE, rel), encoding="utf-8") as fh:
                source = fh.read()
            for name in names:
                with self.subTest(file=rel, function=name):
                    found = blocking_calls(source, name)
                    self.assertIsNotNone(found, f"{name} is gone from {rel} - update GUARDED")
                    self.assertEqual(found, [], f"{rel}:{name} is async and blocks the event loop")

    def test_the_check_catches_the_old_shape(self):
        old = (
            "async def up(file, db):\n"
            "    data = await file.read()\n"
            "    resp = httpx.post('u', content=data, timeout=60)\n"
            "    db.commit()\n"
            "    return _es._storage_put('b', 'p', data, 't')\n"
        )
        found = " ".join(blocking_calls(old, "up"))
        for call in ("httpx.post", "db.commit", "_storage_put"):
            self.assertIn(call, found)

    def test_work_handed_to_a_thread_is_fine(self):
        threaded = (
            "async def up(file, db):\n"
            "    data = await file.read()\n"
            "    def _store():\n"
            "        httpx.post('u', content=data)\n"
            "        db.commit()\n"
            "    return await asyncio.to_thread(_store)\n"
        )
        self.assertEqual(blocking_calls(threaded, "up"), [])
        self.assertEqual(blocking_calls("def up(db):\n    db.commit()\n", "up"), [])


class _FakeSession:
    """Stands in for SessionLocal(): records what was written and from where."""
    writes = []

    def __init__(self):
        self.opened_on = threading.get_ident()
        self.row = None

    def add(self, row):
        self.row = row

    def commit(self):
        _FakeSession.writes.append((self.row, self.opened_on, threading.get_ident()))

    def close(self):
        pass


class AuditWritesOffTheLoop(unittest.TestCase):
    def setUp(self):
        _FakeSession.writes = []
        self.loop_thread = []
        app = FastAPI()

        @app.post("/things/{tid}")
        async def change(tid: str):
            self.loop_thread.append(threading.get_ident())
            return {"ok": True}

        @app.post("/denied")
        async def denied():
            from fastapi import HTTPException
            raise HTTPException(403, "no")

        app.add_middleware(audit.AuditMiddleware)
        self.client = TestClient(app)
        patch = mock.patch.object(audit, "SessionLocal", _FakeSession)
        patch.start()
        self.addCleanup(patch.stop)

    def test_a_change_is_logged_from_a_worker_thread(self):
        self.assertEqual(self.client.post("/things/7").status_code, 200)
        self.assertEqual(len(_FakeSession.writes), 1)
        row, opened_on, committed_on = _FakeSession.writes[0]
        self.assertEqual((row.resource_type, row.resource_id), ("things", "7"))
        self.assertNotEqual(committed_on, self.loop_thread[0])
        self.assertEqual(opened_on, committed_on)      # session opened inside the thread

    def test_a_denial_is_logged_from_a_worker_thread(self):
        self.assertEqual(self.client.post("/denied").status_code, 403)
        self.assertEqual(len(_FakeSession.writes), 1)
        row, _opened_on, _committed_on = _FakeSession.writes[0]
        self.assertEqual(row.action, "Authorization denied")

    def test_a_failed_write_never_breaks_the_response(self):
        with mock.patch.object(audit, "SessionLocal", side_effect=RuntimeError("database down")):
            self.assertEqual(self.client.post("/things/7").status_code, 200)
            self.assertEqual(self.client.post("/denied").status_code, 403)
        with mock.patch.object(audit.asyncio, "to_thread", side_effect=RuntimeError("no executor")):
            self.assertEqual(self.client.post("/things/7").status_code, 200)


if __name__ == "__main__":
    unittest.main()
