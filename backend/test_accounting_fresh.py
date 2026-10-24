"""Accounting per-table Sync (10/23 meeting, item 13; Neil in the chat: "sync
should be table level and not just overall") - as tests.

A table's own Sync button sends fresh=1 on its reads (api.js withFreshReads).
AccountingFreshReads marks the request and _acct_get asks the accounting app
again instead of answering from the 5-minute cache; an answer only seconds old
is still served, so a burst of clicks costs one upstream call. Any other read
keeps the cache.

    python -m pytest test_accounting_fresh.py -q      (one file per process)
"""
import asyncio
import os
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models
from routers import accounting

models.Base.metadata.create_all(bind=database.engine)

VIEWER = "viewer.fresh.test@greensglobal.com"   # accounting:viewer, no entity limit
GROUP = "grp-fresh-test-viewer"


def _scope(path, query=b"", method="GET"):
    return {"type": "http", "method": method, "path": path, "query_string": query}


class AsksFreshTests(unittest.TestCase):
    def test_only_accounting_gets_with_fresh_count(self):
        self.assertTrue(accounting._asks_fresh(_scope("/accounting/books", b"fresh=1")))
        self.assertTrue(accounting._asks_fresh(_scope("/leasing/rent-roll", b"year=2026&fresh=true")))
        self.assertTrue(accounting._asks_fresh(_scope("/accounting/mre/grid", b"fresh=1&year=2026")))
        self.assertFalse(accounting._asks_fresh(_scope("/accounting/books")))
        self.assertFalse(accounting._asks_fresh(_scope("/accounting/books", b"fresh=0")))
        self.assertFalse(accounting._asks_fresh(_scope("/accounting/books", b"fresh=1", method="POST")))
        self.assertFalse(accounting._asks_fresh(_scope("/tasks", b"fresh=1")))
        self.assertFalse(accounting._asks_fresh({"type": "websocket", "path": "/accounting/x", "query_string": b"fresh=1"}))

    def test_fresh_ttl_is_short_only_inside_a_fresh_request(self):
        self.assertEqual(accounting.fresh_ttl(300.0), 300.0)
        token = accounting._ACCT_FRESH.set(True)
        try:
            self.assertEqual(accounting.fresh_ttl(300.0), accounting._FRESH_MIN_AGE)
        finally:
            accounting._ACCT_FRESH.reset(token)
        self.assertEqual(accounting.fresh_ttl(300.0), 300.0)


class FreshReadTests(unittest.TestCase):
    """End to end: GET /accounting/books, the upstream call counted."""

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = VIEWER
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP, name="Fresh Test Viewers", allowed_modules="accounting:viewer"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=VIEWER))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        accounting._ACCT_CACHE.clear()
        self.calls = 0
        self._sync = accounting._acct_get_sync
        self._base, self._key = accounting._ACCT_BASE, accounting._ACCT_KEY
        accounting._ACCT_BASE, accounting._ACCT_KEY = "http://accounting.invalid", "test-key"

        def fake_sync(path, params):
            self.calls += 1
            return {"ok": True, "books": [{"id": "accrual", "code": "ACCRUAL", "title": f"Accrual {self.calls}", "kind": "standard", "journals": []}]}
        accounting._acct_get_sync = fake_sync

    def tearDown(self):
        accounting._acct_get_sync = self._sync
        accounting._ACCT_BASE, accounting._ACCT_KEY = self._base, self._key
        accounting._ACCT_CACHE.clear()
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GROUP).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _age_cache(self, seconds):
        for k, (t, v) in list(accounting._ACCT_CACHE.items()):
            accounting._ACCT_CACHE[k] = (t - seconds, v)

    def test_plain_reads_keep_the_cache(self):
        self.assertEqual(self.client.get("/accounting/books").status_code, 200)
        self._age_cache(60)
        self.assertEqual(self.client.get("/accounting/books").status_code, 200)
        self.assertEqual(self.calls, 1)

    def test_a_tables_sync_reads_the_accounting_app_again(self):
        self.client.get("/accounting/books")
        self._age_cache(60)
        r = self.client.get("/accounting/books?fresh=1")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.calls, 2)
        # The new answer is kept for everyone's next plain read.
        self.client.get("/accounting/books")
        self.assertEqual(self.calls, 2)

    def test_a_burst_of_syncs_costs_one_upstream_call(self):
        self.client.get("/accounting/books?fresh=1")
        self.client.get("/accounting/books?fresh=1")
        self.assertEqual(self.calls, 1)

    def test_the_flag_ends_with_the_request(self):
        self.client.get("/accounting/books?fresh=1")
        self.assertFalse(accounting._ACCT_FRESH.get())
        self._age_cache(60)
        asyncio.run(accounting._acct_get("/api/internal/books", {}))
        self.assertEqual(self.calls, 1)


if __name__ == "__main__":
    unittest.main()
