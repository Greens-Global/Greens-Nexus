"""Accounting dashboard proxy (Oct 7) - as tests.

- Refresh (Priyanka: "does nothing"): reads are cached briefly; fresh=1 skips
  and replaces the cached answer, and one caller's repeated fresh reads of the
  same query within 10 seconds are served from the cache.
- Account Reconciliations (Neil, comment 5): reconciling is an Intacct
  function only, so the "recon-mark" write is refused by Nexus.
- Role views (Priyanka): the four Overview role views can be reset, never
  deleted.

The accounting service is replaced by a recorder - nothing leaves the machine.

    python -m pytest test_accounting_dashboard_fresh.py -q
"""
import os
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import database
import main
import models
from routers import accounting, accounting_dashboard as dash

models.Base.metadata.create_all(bind=database.engine)

ME = "fresh.dash.test@greensglobal.com"
OTHER = "other.dash.test@greensglobal.com"


class DashboardProxyTests(unittest.TestCase):
    def setUp(self):
        self.who = {"email": ME}
        self.gets = []
        self.posts = []

        def fake_get_sync(params):
            self.gets.append(dict(params))
            return {"ok": True, "n": len(self.gets)}

        def fake_post_sync(body):
            self.posts.append(dict(body))
            return {"ok": True}

        self._saved = (dash._get_sync, dash._post_sync, dash._BASE, dash._KEY)
        dash._get_sync, dash._post_sync = fake_get_sync, fake_post_sync
        dash._BASE, dash._KEY = "http://accounting.invalid", "test-key"
        dash._CACHE.clear()
        dash._FRESH_SEEN.clear()

        app = main.app
        self._overrides = dict(app.dependency_overrides)
        app.dependency_overrides[auth.get_current_user] = lambda: {"email": self.who["email"], "role": "admin", "level": 999}
        app.dependency_overrides[accounting.require_unlimited] = lambda: {"allowed": None}
        self.client = TestClient(app)

    def tearDown(self):
        dash._get_sync, dash._post_sync, dash._BASE, dash._KEY = self._saved
        dash._CACHE.clear()
        dash._FRESH_SEEN.clear()
        main.app.dependency_overrides.clear()
        main.app.dependency_overrides.update(self._overrides)

    def _tables(self, fresh=False):
        r = self.client.get("/accounting/dashboard/tables", params={"period": "2026-09", **({"fresh": 1} if fresh else {})})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    # ── Refresh ─────────────────────────────────────────────────────────────
    def test_normal_reads_use_the_cache(self):
        a = self._tables()
        b = self._tables()
        self.assertEqual(a, b)
        self.assertEqual(len(self.gets), 1)
        # fresh is never forwarded to the accounting app, nor part of the cache key.
        self.assertNotIn("fresh", self.gets[0])

    def test_fresh_bypasses_and_replaces_the_cache(self):
        self._tables()
        f = self._tables(fresh=True)
        self.assertEqual(len(self.gets), 2)
        self.assertEqual(f["n"], 2)
        self.assertNotIn("fresh", self.gets[1])
        # The next normal read sees the replaced entry, not the old one.
        self.assertEqual(self._tables()["n"], 2)
        self.assertEqual(len(self.gets), 2)

    def test_repeated_fresh_within_ten_seconds_is_served_from_cache(self):
        self._tables()
        self._tables(fresh=True)
        self._tables(fresh=True)
        self.assertEqual(len(self.gets), 2)
        # Another person's Refresh is their own.
        self.who["email"] = OTHER
        self._tables(fresh=True)
        self.assertEqual(len(self.gets), 3)
        # Once the window has passed, the same caller may refresh again.
        for k in list(dash._FRESH_SEEN):
            dash._FRESH_SEEN[k] -= dash._FRESH_MIN_GAP + 1
        self.who["email"] = ME
        self._tables(fresh=True)
        self.assertEqual(len(self.gets), 4)

    def test_fresh_on_every_read_endpoint(self):
        reads = [
            ("/accounting/dashboard/ledger", {"scope": "NC", "from": "2025-01-01", "to": "2026-09-30"}),
            ("/accounting/dashboard/cash-entities", {"scope": "NC", "asof": "2026-09-30"}),
            ("/accounting/dashboard/recon-accounts", {"asof": "2026-09-30"}),
            ("/accounting/dashboard/budget", {"from": "2026-01-01", "to": "2026-09-30"}),
            ("/accounting/dashboard/noi", {"from": "2026-09-01", "to": "2026-09-30"}),
            ("/accounting/dashboard/entities", {}),
        ]
        for path, params in reads:
            self.client.get(path, params=params)
            self.client.get(path, params=params)
        self.assertEqual(len(self.gets), len(reads))
        for path, params in reads:
            self.assertEqual(self.client.get(path, params={**params, "fresh": 1}).status_code, 200)
        self.assertEqual(len(self.gets), 2 * len(reads))

    # ── Writes ──────────────────────────────────────────────────────────────
    def test_recon_mark_is_refused(self):
        r = self.client.post("/accounting/dashboard/action", json={"op": "recon-mark", "payload": {"period": "2026-09", "key": "gl:1@12000"}})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.posts, [])

    def test_close_task_still_passes(self):
        r = self.client.post("/accounting/dashboard/action", json={"op": "close-task", "payload": {"period": "2026-09", "task_id": 1, "done": True}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.posts[0]["op"], "close-task")

    def test_role_views_cannot_be_deleted(self):
        for vid in ("principal", "cfo", "controller", "bookkeeper"):
            r = self.client.post("/accounting/dashboard/action", json={"op": "view-delete", "payload": {"id": vid}})
            self.assertEqual(r.status_code, 400, vid)
        self.assertEqual(self.posts, [])
        r = self.client.post("/accounting/dashboard/action", json={"op": "view-delete", "payload": {"id": "my-view-abc"}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.posts[0]["op"], "view-delete")


if __name__ == "__main__":
    unittest.main()
