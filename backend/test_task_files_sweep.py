"""The task-files orphan sweep runs on the deployed API only (Neil,
11/02/2026): a laptop with the service key never deletes a storage object;
the deployed worker still sweeps objects no task_attachments row references.

Run on its own: `python -m pytest test_task_files_sweep.py` (one file per
process - see CLAUDE.md)."""
import os
import unittest

import _testdb  # noqa: F401  - a throwaway database whatever runner imports this file

import database  # noqa: E402
import leader  # noqa: E402
import models  # noqa: E402
import task_files  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)


class Resp:
    def __init__(self, code=200, data=None):
        self.status_code = code
        self.is_success = 200 <= code < 300
        self._data = data

    def json(self):
        return self._data


class SweepGateTests(unittest.TestCase):
    def setUp(self):
        self._env = {k: os.environ.get(k) for k in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY")}
        os.environ["SUPABASE_URL"] = "https://proj.supabase.co"
        os.environ["SUPABASE_SERVICE_KEY"] = "svc"
        self.calls = []
        self._orig = (task_files.httpx.post, task_files.httpx.request, leader.is_deployed_worker)

        def fake_post(url, json=None, **k):
            self.calls.append(("list", url))
            return Resp(200, [{"name": "old.png", "created_at": "2020-01-01T00:00:00Z"}])

        def fake_request(method, url, json=None, **k):
            self.calls.append((method, tuple(json["prefixes"])))
            return Resp(200)
        task_files.httpx.post = fake_post
        task_files.httpx.request = fake_request

    def tearDown(self):
        task_files.httpx.post, task_files.httpx.request, leader.is_deployed_worker = self._orig
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_a_laptop_never_sweeps(self):
        leader.is_deployed_worker = lambda: False
        db = database.SessionLocal()
        try:
            self.assertEqual(task_files.sweep_orphaned_objects(db), 0)
        finally:
            db.close()
        self.assertEqual(self.calls, [])

    def test_the_deployed_worker_sweeps_orphans(self):
        leader.is_deployed_worker = lambda: True
        db = database.SessionLocal()
        try:
            self.assertEqual(task_files.sweep_orphaned_objects(db), 1)
        finally:
            db.close()
        self.assertIn(("DELETE", ("tasks/old.png",)), self.calls)


if __name__ == "__main__":
    unittest.main()
