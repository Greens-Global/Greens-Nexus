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

        self.assertEqual(out["status"], "stalled")
        self.assertIn("stopped responding", out["error"])
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
        self.assertEqual(self.db.get(models.AsanaImportJob, dead.id).status, "stalled")
        self.assertEqual(len(self.started), 1)   # the worker was actually dispatched


class CancelTests(unittest.TestCase):
    """Cancel is a request the worker honors at the next project boundary, not
    a kill - stopping mid-project would leave that project half-imported."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.AsanaImportJob).delete()
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _running(self, **kw):
        kw.setdefault("heartbeat_at", now_iso())
        j = models.AsanaImportJob(id=gen_id(), status="running", started_at=now_iso(),
                                  total=10, done=3, **kw)
        self.db.add(j)
        self.db.commit()
        return j

    def test_cancel_flags_the_job_and_leaves_it_running(self):
        """It keeps running until the worker reaches a boundary; reporting it as
        stopped straight away would be a lie while a project is still importing."""
        job = self._running()

        out = task_config.asana_sync_import_all_cancel(db=self.db)

        self.assertEqual(out["status"], "running")
        self.assertTrue(out["cancelling"])
        self.assertTrue(self.db.get(models.AsanaImportJob, job.id).cancel_requested)

    def test_cancelling_a_job_whose_worker_is_gone_retires_it(self):
        """Nothing is left to notice the flag, so waiting for a clean stop would
        hang the UI forever."""
        self._running(heartbeat_at=_ago(task_config._IMPORT_JOB_STALE_SECONDS + 60))

        out = task_config.asana_sync_import_all_cancel(db=self.db)

        self.assertEqual(out["status"], "cancelled")

    def test_cancel_with_nothing_running_is_a_noop(self):
        self.assertEqual(task_config.asana_sync_import_all_cancel(db=self.db)["status"], "idle")

    def test_the_loop_stops_at_the_next_project(self):
        """And reports what it did import - the run is additive, so the finished
        projects stay and a later run picks up the rest."""
        self.db.query(models.TaskProject).delete()
        for name in ("Alpha", "Beta"):
            self.db.add(models.TaskProject(id=f"c-{name}", name=name, created_at=now_iso()))
        self.db.commit()
        real = (asana_sync.import_project, asana_sync.ensure_project_map, asana_sync.resolve_dependencies)
        asana_sync.import_project = lambda *a, **kw: None
        asana_sync.ensure_project_map = lambda *a, **kw: None
        asana_sync.resolve_dependencies = lambda *a, **kw: None
        try:
            seen = []
            counts = task_config._import_asana_projects(
                self.db, object(), ProgressReportingTests._FakeAsana(), ["gid-1", "gid-2"],
                {"email": "s@x.com"},
                on_progress=lambda d, t, n, g=None: seen.append(n),
                # Stop before the second project.
                should_stop=lambda: len(seen) >= 2)
        finally:
            asana_sync.import_project, asana_sync.ensure_project_map, asana_sync.resolve_dependencies = real

        self.assertTrue(counts["cancelled"])
        self.assertEqual(counts["projects"], 1)          # Alpha finished, Beta never started
        self.assertNotIn("Beta", seen)


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

    def test_a_beat_survives_a_transient_failure(self):
        """A skipped beat is what made a live import look dead on dev: the
        worker pool was busy, the beat could not get a connection, and after a
        few silent misses the status endpoint retired a job that was still
        importing. It retries instead of giving up on that cycle."""
        job = models.AsanaImportJob(id=gen_id(), status="running", started_at=now_iso(),
                                    heartbeat_at=_ago(300), total=5, done=0)
        self.db.add(job)
        self.db.commit()

        import database
        real_begin, calls = database.engine.begin, {"n": 0}

        def flaky():
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("QueuePool limit reached")
            return real_begin()

        stop = threading.Event()
        database.engine.begin = flaky
        try:
            t = threading.Thread(target=task_config._beat_while_running, args=(job.id, stop), daemon=True)
            t.start()
            time.sleep(2.6)          # first beat fails, retry (2s backoff) succeeds
            stop.set()
            t.join(timeout=3)
        finally:
            database.engine.begin = real_begin

        self.db.refresh(job)
        self.assertGreater(calls["n"], 1)                  # it retried
        self.assertTrue(task_config._job_is_alive(job))    # and the job stayed alive

    def test_the_stalled_message_says_how_far_it_got(self):
        """Rather than asserting a cause we cannot know."""
        job = models.AsanaImportJob(id=gen_id(), status="running", started_at=now_iso(),
                                    heartbeat_at=_ago(99999), total=109, done=12, current="GS Mammoth")

        msg = task_config._stalled_message(job)

        self.assertIn("12 of 109", msg)
        self.assertIn("GS Mammoth", msg)
        self.assertNotIn("restarted", msg)       # no invented cause
        self.assertIn("kept", msg)               # says the work survives

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
            {"email": "s@x.com"}, on_progress=lambda d, t, n, g=None: seen.append((d, t, n)))

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
            {"email": "s@x.com"}, on_progress=lambda d, t, n, g=None: seen.append((d, t, n)))

        self.assertEqual(seen[-1], (1, 1, "Alpha"))
        self.assertEqual(len(counts["errors"]), 1)

    def test_a_broken_progress_callback_cannot_kill_the_import(self):
        def bad(*a, **kw):
            raise RuntimeError("UI blew up")

        counts = task_config._import_asana_projects(
            self.db, object(), self._FakeAsana(), ["gid-1"],
            {"email": "s@x.com"}, on_progress=bad)

        self.assertEqual(counts["errors"], [])


class ResumeTests(unittest.TestCase):
    """A stopped run continues from where it got to, rather than re-walking a
    hundred projects to reach the handful it never reached.

    This matters more than it looks: the import is the only thing that MAPS a
    project, and the pull only touches mapped projects - so projects an
    interrupted run never reached stay invisible until someone finishes it."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.AsanaImportJob).delete()
        self.db.query(models.AsanaSyncConfig).delete()
        self.db.add(models.AsanaSyncConfig(id="singleton", enabled=True, token="tok"))
        self.db.commit()
        self.started = []
        self._real = task_config._run_import_all
        task_config._run_import_all = lambda *a, **kw: self.started.append(a)

    def tearDown(self):
        task_config._run_import_all = self._real
        self.db.close()

    def _stopped(self, done_gids, finished_at=None, status="error", **kw):
        j = models.AsanaImportJob(id=gen_id(), status=status, started_at=_ago(600),
                                  heartbeat_at=_ago(600), finished_at=finished_at or now_iso(),
                                  total=5, done=len(done_gids), done_gids=done_gids, **kw)
        self.db.add(j)
        self.db.commit()
        return j

    def test_a_new_import_carries_over_finished_projects(self):
        self._stopped(["g1", "g2"])

        out = task_config.asana_sync_import_all({"email": "s@x.com"}, self.db)

        self.assertEqual(self.db.get(models.AsanaImportJob, out["id"]).done_gids, ["g1", "g2"])

    def test_an_old_stopped_run_does_not_carry_over(self):
        """After a day the workspace has moved on; a full pass is safer."""
        self._stopped(["g1"], finished_at=_ago(60 * 60 * 30))

        out = task_config.asana_sync_import_all({"email": "s@x.com"}, self.db)

        self.assertEqual(self.db.get(models.AsanaImportJob, out["id"]).done_gids, [])

    def test_a_completed_run_does_not_carry_over(self):
        """Re-importing after a clean run must top up every project again."""
        self._stopped(["g1", "g2"], status="done")

        out = task_config.asana_sync_import_all({"email": "s@x.com"}, self.db)

        self.assertEqual(self.db.get(models.AsanaImportJob, out["id"]).done_gids, [])


class AutoResumeTests(unittest.TestCase):
    """Startup rescue: a deploy restarts the API, which is exactly when a long
    import is most likely to be in flight."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.AsanaImportJob).delete()
        self.db.query(models.AsanaSyncConfig).delete()
        self.db.add(models.AsanaSyncConfig(id="singleton", enabled=True, token="tok"))
        self.db.commit()
        self.started = []
        self._real = task_config._run_import_all
        task_config._run_import_all = lambda *a, **kw: self.started.append(a)

    def tearDown(self):
        task_config._run_import_all = self._real
        self.db.close()

    def _running(self, **kw):
        kw.setdefault("heartbeat_at", _ago(task_config._IMPORT_JOB_STALE_SECONDS + 60))
        kw.setdefault("status", "running")
        j = models.AsanaImportJob(id=gen_id(), started_at=_ago(9000),
                                  started_by="s@x.com", total=109, done=12, **kw)
        self.db.add(j)
        self.db.commit()
        return j

    def test_a_stalled_run_is_picked_up(self):
        job = self._running(done_gids=["g1", "g2"])

        outcome = task_config.resume_stalled_import()

        self.assertIn("resumed", outcome)
        self.assertEqual(len(self.started), 1)
        self.assertEqual(self.db.get(models.AsanaImportJob, job.id).attempts, 2)

    def test_a_live_run_is_left_alone(self):
        """Another worker in this instance is still on it - starting a second
        would put two imports on the same projects."""
        self._running(heartbeat_at=now_iso())

        self.assertEqual(task_config.resume_stalled_import(), "")
        self.assertEqual(self.started, [])

    def test_a_cancelled_run_is_not_resurrected(self):
        """Someone asked it to stop; a restart must not override that."""
        job = self._running(cancel_requested=True)

        outcome = task_config.resume_stalled_import()

        self.assertEqual(outcome, "cancelled")
        self.assertEqual(self.started, [])
        self.assertEqual(self.db.get(models.AsanaImportJob, job.id).status, "cancelled")

    def test_it_gives_up_after_repeated_attempts(self):
        """A project that reliably kills its worker would otherwise restart the
        same import on every deploy forever."""
        job = self._running(attempts=task_config._IMPORT_MAX_ATTEMPTS)

        outcome = task_config.resume_stalled_import()

        self.assertEqual(outcome, "gave up")
        self.assertEqual(self.started, [])
        self.assertEqual(self.db.get(models.AsanaImportJob, job.id).status, "error")


    def test_a_run_already_retired_by_a_status_poll_still_resumes(self):
        """The real sequence: the worker dies, someone opens the page, the poll
        marks it stalled - and only later does the app restart. Looking only for
        "running" would find nothing and never resume."""
        job = self._running(status="stalled", finished_at=now_iso(), done_gids=["g1"])

        outcome = task_config.resume_stalled_import()

        self.assertIn("resumed", outcome)
        self.assertEqual(len(self.started), 1)
        row = self.db.get(models.AsanaImportJob, job.id)
        self.assertEqual(row.status, "running")   # back in flight
        self.assertEqual(row.finished_at, "")

    def test_a_genuine_failure_is_not_retried(self):
        """A bad token fails identically on every boot; retrying it forever just
        buries the real message."""
        self._running(status="error", error="Asana request failed - check the token.",
                      finished_at=now_iso())

        self.assertEqual(task_config.resume_stalled_import(), "")
        self.assertEqual(self.started, [])

    def test_nothing_to_resume_is_a_noop(self):
        self.assertEqual(task_config.resume_stalled_import(), "")

    def test_it_needs_a_token(self):
        self.db.query(models.AsanaSyncConfig).delete()
        self.db.add(models.AsanaSyncConfig(id="singleton", enabled=True, token=""))
        self.db.commit()
        self._running()

        self.assertEqual(task_config.resume_stalled_import(), "no token")
        self.assertEqual(self.started, [])


if __name__ == "__main__":
    unittest.main()
