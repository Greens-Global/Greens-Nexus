"""request_timing: Server-Timing carries the request's own SQL count and time,
including SQL run in a sync route's threadpool thread, and nothing from
outside a request.

Run with: python -m unittest test_request_timing -v
"""
import contextlib
import io
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402

import request_timing  # noqa: E402

engine = create_engine(f"sqlite:///{_tmp_db.name}")
request_timing.wire(engine)

app = FastAPI()
app.add_middleware(request_timing.RequestTiming)


@app.get("/two")
def two_queries():          # sync: runs in the threadpool, like every Nexus route
    with engine.connect() as c:
        c.execute(text("SELECT 1"))
        c.execute(text("SELECT 2"))
    return {"ok": True}


class RequestTimingTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        engine.dispose()
        os.remove(_tmp_db.name)

    def test_header_counts_the_routes_sql(self):
        r = TestClient(app).get("/two?secret=1")
        self.assertEqual(r.status_code, 200)
        st = r.headers["server-timing"]
        self.assertIn('desc="2 queries"', st)
        self.assertTrue(st.startswith("app;dur="))

    def test_sql_outside_a_request_is_not_counted_and_slow_requests_log_the_path_only(self):
        with engine.connect() as c:          # e.g. a background loop
            c.execute(text("SELECT 3"))
        saved, request_timing.SLOW_MS = request_timing.SLOW_MS, 0
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                r = TestClient(app).get("/two?secret=1")
        finally:
            request_timing.SLOW_MS = saved
        self.assertIn('desc="2 queries"', r.headers["server-timing"])
        self.assertIn("[slow] GET /two ", out.getvalue())
        self.assertNotIn("secret", out.getvalue())


if __name__ == "__main__":
    unittest.main()
