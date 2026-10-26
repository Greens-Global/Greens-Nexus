"""GET /health/components (routers/health_components.py) - each part of Nexus
for the outside status page (status/, Oct 27 2026).

Run with: python -m unittest test_health_components -v
"""
import os
import tempfile
import unittest
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import graph_mail  # noqa: E402
from routers import health_components as hc  # noqa: E402


def _client():
    app = FastAPI()
    app.include_router(hc.router)
    return TestClient(app)


class HealthComponentsTests(unittest.TestCase):
    def setUp(self):
        hc._cache.update({"at": 0.0, "body": None})
        hc._slow.clear()

    def test_shape_and_overall_is_the_worst_part(self):
        with mock.patch.dict(os.environ, {"SUPABASE_URL": "", "SUPABASE_SERVICE_KEY": ""}), \
                mock.patch.object(graph_mail, "graph_configured", return_value=False):
            body = _client().get("/health/components").json()
        self.assertEqual(set(body["components"]),
                         {"database", "backgroundJobs", "schema", "storage", "microsoft365"})
        self.assertEqual(body["components"]["database"]["status"], "operational")
        self.assertEqual(body["components"]["storage"], {"status": "unknown", "note": "Not configured"})
        self.assertEqual(body["overall"], "unknown")   # nothing down, two parts unknown

    def test_storage_answers_map_to_status_and_never_leak_detail(self):
        env = {"SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SERVICE_KEY": "secret-key"}
        with mock.patch.dict(os.environ, env):
            with mock.patch.object(hc.httpx, "get", return_value=httpx.Response(200)):
                self.assertEqual(hc._check_storage()["status"], "operational")
            with mock.patch.object(hc.httpx, "get", return_value=httpx.Response(503)):
                self.assertEqual(hc._check_storage()["status"], "down")
            with mock.patch.object(hc.httpx, "get", side_effect=httpx.ConnectError("x.supabase.co refused")):
                res = hc._check_storage()
        self.assertEqual(res, {"status": "down", "note": "Not reachable"})
        self.assertNotIn("supabase", str(res))

    def test_microsoft_rejected_credentials_are_degraded_an_outage_is_down(self):
        def failing(code):
            req = httpx.Request("POST", "https://login.microsoftonline.com/t/oauth2/v2.0/token")
            return httpx.HTTPStatusError("boom", request=req, response=httpx.Response(code, request=req))
        with mock.patch.object(graph_mail, "graph_configured", return_value=True):
            with mock.patch.object(graph_mail, "_graph_token", side_effect=failing(401)):
                self.assertEqual(hc._check_microsoft(), {"status": "degraded", "note": "Credentials rejected"})
            with mock.patch.object(graph_mail, "_graph_token", side_effect=failing(503)):
                self.assertEqual(hc._check_microsoft(), {"status": "down", "note": "Microsoft unavailable"})
            with mock.patch.object(graph_mail, "_graph_token", return_value="tok"):
                self.assertEqual(hc._check_microsoft()["status"], "operational")

    def test_answer_is_cached_so_a_flood_does_not_reach_the_database(self):
        calls = []
        real = hc.build
        with mock.patch.object(hc, "build", side_effect=lambda: calls.append(1) or real()), \
                mock.patch.object(graph_mail, "graph_configured", return_value=False):
            client = _client()
            for _ in range(5):
                self.assertEqual(client.get("/health/components").status_code, 200)
        self.assertEqual(len(calls), 1)

    def test_slow_checks_run_at_most_every_few_minutes(self):
        calls = []
        def check():
            calls.append(1)
            return hc._result("operational")
        hc._slow_cached("x", check)
        hc._slow_cached("x", check)
        self.assertEqual(len(calls), 1)

    def test_schema_gaps_are_degraded_not_down(self):
        fake_main = mock.Mock(SCHEMA_GAPS=["tasks.new_col"])
        with mock.patch.dict("sys.modules", {"main": fake_main}):
            self.assertEqual(hc._check_schema()["status"], "degraded")
        with mock.patch.dict("sys.modules", {"main": mock.Mock(SCHEMA_GAPS=[])}):
            self.assertEqual(hc._check_schema()["status"], "operational")


if __name__ == "__main__":
    unittest.main()
