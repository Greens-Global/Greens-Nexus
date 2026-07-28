"""Background "Import All Projects" job.

The import outlives Azure's ~230s request ceiling, so it runs on a thread and
reports progress through a DB row. These cover the parts that bite: a worker
recycled mid-run, and a second click while a run is already going.

Run with: python -m unittest test_asana_import_job -v
"""
import os
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database
import models
from routers.task_util import gen_id, now_iso
import asana_sync
from routers import task_config


def _ago(seconds):
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()


class ImportJobStateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.AsanaImportJob).delete()
        self.db.query(models.AsanaSyncConfig).delete()
        self.db.add(models.AsanaSyncConfig(id="singleton", enabled=True, token="tok"))
        self.db.commit()
        # The endpoint spawns the real worker, which would open its own session
        # and call Asana with this fake token. Stub it: these tests are about
        # the job bookkeeping, not the import.
        self.started = []
        self._real_worker = task_config._run_import_all
        task_config._run_import_all = lambda *a, **kw: self.started.append(a)

    def tearDown(self):
        task_config._run_import_all = self._real_worker
        self.db.close()

    def _job(self, **kw):
        kw.setdefault("id", gen_id())
        kw.setdefault("status", "running")
        kw.setdefault("started_at", now_iso())
        kw.setdefault("heartbeat_at", now_iso())
        j = models.AsanaImportJob(**kw)
        self.db.add(j)
        self.db.commit()
        return j

    def test_a_beating_job_is_alive(self):
        self.assertTrue(task_config._job_is_alive(self._job(heartbeat_at=_ago(30))))

    def test_a_job_whose_worker_died_is_not_alive(self):
        """No heartbeat for longer than the timeout means the process went away
        mid-import; nothing will ever finish that row."""
        stale = self._job(heartbeat_at=_ago(task_config._IMPORT_JOB_STALE_SECONDS + 60))

        self.assertFalse(task_config._job_is_alive(stale))

    def test_a_finished_job_is_not_alive(self):
        self.assertFalse(task_config._job_is_alive(self._job(status="done")))

    def test_a_job_with_no_parseable_timestamp_is_not_alive(self):
        """Rather than raising and taking the endpoint down with it."""
        self.assertFalse(task_config._job_is_alive(self._job(heartbeat_at="", started_at="")))

    def test_status_reports_idle_before_any_run(self):
        self.assertEqual(task_config.asana_sync_import_all_status(db=self.db)["status"], "idle")

    def test_status_reports_progress(self):
        self._job(total=10, done=3, current="Marketing")

        out = task_config.asana_sync_import_all_status(db=self.db)

        self.assertEqual((out["status"], out["done"], out["total"]), ("running", 3, 10))
        self.assertEqual(out["current"], "Marketing")

    def test_status_retires_a_job_whose_worker_died(self):
        """Otherwise the UI spins forever on a run that already stopped, and the
        next Import is refused because a job still looks in flight."""
        self._job(heartbeat_at=_ago(task_config._IMPORT_JOB_STALE_SECONDS + 60))

        out = task_config.asana_sync_import_all_status(db=self.db)

        self.assertEqual(out["status"], "error")
        self.assertIn("Interrupted", out["error"])
        self.assertEqual(
            self.db.query(models.AsanaImportJob).filter_by(status="running").count(), 0)

    def test_clicking_import_again_joins_the_run_in_progress(self):
        """Two full-workspace imports at once would fight over the same projects."""
        live = self._job(total=8, done=2)

        out = task_config.asana_sync_import_all({"email": "sagar@x.com"}, self.db)

        self.assertEqual(out["id"], live.id)
        self.assertEqual(self.db.query(models.AsanaImportJob).count(), 1)

    def test_import_requires_a_token(self):
        self.db.query(models.AsanaSyncConfig).delete()
        self.db.add(models.AsanaSyncConfig(id="singleton", enabled=True, token=""))
        self.db.commit()

        with self.assertRaises(Exception) as ctx:
            task_config.asana_sync_import_all({"email": "sagar@x.com"}, self.db)

        self.assertIn("token", str(ctx.exception).lower())

    def test_a_dead_job_does_not_block_a_new_one(self):
        dead = self._job(heartbeat_at=_ago(task_config._IMPORT_JOB_STALE_SECONDS + 60))

        out = task_config.asana_sync_import_all({"email": "sagar@x.com"}, self.db)

        self.assertNotEqual(out["id"], dead.id)
        self.assertEqual(out["status"], "running")
        self.assertEqual(self.db.get(models.AsanaImportJob, dead.id).status, "error")
        self.assertEqual(len(self.started), 1)   # the worker was actually dispatched


class HeartbeatTests(unittest.TestCase):
    """The heartbeat says the WORKER is alive, which is not the same as saying
    progress was made - a single large project can take longer than the whole
    staleness window."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.AsanaImportJob).delete()
        self.db.commit()
        self._interval = task_config._IMPORT_HEARTBEAT_SECONDS
        task_config._IMPORT_HEARTBEAT_SECONDS = 0.05

    def tearDown(self):
        task_config._IMPORT_HEARTBEAT_SECONDS = self._interval
        self.db.close()

    def test_it_beats_without_any_progress(self):
        job = models.AsanaImportJob(id=gen_id(), status="running", started_at=now_iso(),
                                    heartbeat_at=_ago(300), total=5, done=0)
        self.db.add(job)
        self.db.commit()
        stop = threading.Event()

        t = threading.Thread(target=task_config._beat_while_running, args=(job.id, stop), daemon=True)
        t.start()
        time.sleep(0.3)
        stop.set()
        t.join(timeout=2)

        self.db.refresh(job)
        self.assertTrue(task_config._job_is_alive(job))   # would have been declared dead before
        self.assertFalse(t.is_alive())                    # and it stops when asked

    def test_it_stops_once_the_job_is_no_longer_running(self):
        """So a finished job leaves no thread beating against the DB forever."""
        job = models.AsanaImportJob(id=gen_id(), status="done", started_at=now_iso(),
                                    heartbeat_at=now_iso())
        self.db.add(job)
        self.db.commit()

        t = threading.Thread(target=task_config._beat_while_running,
                             args=(job.id, threading.Event()), daemon=True)
        t.start()
        t.join(timeout=2)

        self.assertFalse(t.is_alive())


class ProgressReportingTests(unittest.TestCase):
    """What the progress bar is driven by. A single Asana project can take
    minutes on its own, so the run has to say which project it is on BEFORE
    importing it - reporting only on completion leaves the bar empty and blank
    for that whole time, which reads as a hung import."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.TaskProject).delete()
        self.db.commit()
        # Adopt an existing project by name so create_project never runs.
        for name in ("Alpha", "Beta"):
            self.db.add(models.TaskProject(id=f"p-{name}", name=name, created_at=now_iso()))
        self.db.commit()
        self._import_project = asana_sync.import_project
        self._ensure_map = asana_sync.ensure_project_map
        self._resolve = asana_sync.resolve_dependencies
        asana_sync.import_project = lambda *a, **kw: None
        asana_sync.ensure_project_map = lambda *a, **kw: None
        asana_sync.resolve_dependencies = lambda *a, **kw: None

    def tearDown(self):
        asana_sync.import_project = self._import_project
        asana_sync.ensure_project_map = self._ensure_map
        asana_sync.resolve_dependencies = self._resolve
        self.db.close()

    class _FakeAsana:
        names = {"gid-1": "Alpha", "gid-2": "Beta"}

        def get(self, path, **kw):
            return {"name": self.names[path.rsplit("/", 1)[-1]], "notes": ""}

    def test_each_project_is_announced_before_it_is_imported(self):
        seen = []

        task_config._import_asana_projects(
            self.db, object(), self._FakeAsana(), ["gid-1", "gid-2"],
            {"email": "s@x.com"}, on_progress=lambda d, t, n: seen.append((d, t, n)))

        # done=0 while Alpha is in flight, done=1 once it is finished, and so on.
        self.assertEqual(seen, [(0, 2, "Alpha"), (1, 2, "Alpha"),
                                (1, 2, "Beta"), (2, 2, "Beta")])

    def test_a_failing_project_still_advances_the_count(self):
        """Otherwise one bad project makes the bar look stuck at that name."""
        def boom(*a, **kw):
            raise RuntimeError("Asana 500")
        asana_sync.import_project = boom
        seen = []

        counts = task_config._import_asana_projects(
            self.db, object(), self._FakeAsana(), ["gid-1"],
            {"email": "s@x.com"}, on_progress=lambda d, t, n: seen.append((d, t, n)))

        self.assertEqual(seen[-1], (1, 1, "Alpha"))
        self.assertEqual(len(counts["errors"]), 1)

    def test_a_broken_progress_callback_cannot_kill_the_import(self):
        def bad(*a):
            raise RuntimeError("UI blew up")

        counts = task_config._import_asana_projects(
            self.db, object(), self._FakeAsana(), ["gid-1"],
            {"email": "s@x.com"}, on_progress=bad)

        self.assertEqual(counts["errors"], [])


if __name__ == "__main__":
    unittest.main()
