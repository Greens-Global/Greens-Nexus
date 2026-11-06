"""json_response.rendered_in_thread: big answers are turned into bytes in the
route's thread, not on the event loop (11/05/2026), with the same bytes and the
same dependencies as a plain route.

Run with: python -m unittest test_json_response -v
"""
import os
import tempfile
import unittest
from datetime import date

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import APIRouter, Depends, FastAPI  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from json_response import rendered_in_thread  # noqa: E402


def _who():
    return {"email": "a@greensglobal.com"}


def listing(since: str = "", user: dict = Depends(_who)) -> dict:
    return {"since": since, "who": user["email"], "on": date(2026, 11, 5), "rows": [1, 2]}


class RenderedInThreadTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        try:
            import database
            database.engine.dispose()
        except Exception:
            pass
        os.remove(_tmp_db.name)

    def test_same_answer_as_a_plain_route_and_the_function_still_returns_the_dict(self):
        plain, wrapped = APIRouter(), APIRouter()
        plain.get("/x")(listing)
        wrapped.get("/x")(rendered_in_thread(listing))
        a, b = FastAPI(), FastAPI()
        a.include_router(plain)
        b.include_router(wrapped)
        ra = TestClient(a).get("/x?since=2026-11-01")
        rb = TestClient(b).get("/x?since=2026-11-01")
        self.assertEqual(rb.status_code, 200)
        self.assertEqual(ra.content, rb.content)     # byte for byte, query + Depends resolved
        self.assertEqual(listing(since="s", user={"email": "e"})["who"], "e")
        self.assertIsInstance(rendered_in_thread(listing)(since="", user={"email": "e"}), JSONResponse)

    def test_the_task_routes_keep_their_paths(self):
        """The routes are still registered, and the plain functions stay
        importable for the tests and routes that call them."""
        from routers import tasks, task_config
        get_paths = [r.path for r in tasks.router.routes if "GET" in r.methods]
        self.assertIn("/tasks", get_paths)
        self.assertIn("/tasks/delta", get_paths)
        self.assertIn("/task-changelog", [r.path for r in task_config.view_router.routes])
        self.assertTrue(callable(tasks.list_tasks_delta) and callable(task_config.list_changelog))


if __name__ == "__main__":
    unittest.main()
