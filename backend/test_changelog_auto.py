"""Automatic "What's New" drafting - the schedule that has to survive restarts.

The generation itself is the button's code path, already exercised by hand. What
is worth testing is the part that is new and invisible: the due time is PERSISTED,
because merging to dev restarts the dev API several times a day and a loop that
slept 24 hours from boot would be killed at hour 3 every time and never fire once.
So: a fresh install generates, a restart inside the interval does not, a failure
backs off instead of re-firing every poll, and the interval elapsing fires again.

Run with: python -m unittest test_changelog_auto -v
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import database
import models
import changelog_auto
from routers import task_config

# A test that DELETES rows must prove its own isolation before it deletes any.
#
# unittest runs every module named on one command line in ONE process, so
# `import database` happens once: whichever module is imported FIRST fixes
# DATABASE_URL for all of them, and the assignment above is a dead letter for
# the rest. Run after a module that does not set it (test_app_boot does not),
# and these setUp() deletes land in the developer's real local greens_nexus.db.
# That is not hypothetical - it happened on 2026-09-07 and took the local task,
# project and portfolio rows with it. So the binding is checked, not assumed.
def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp.name)):
        raise RuntimeError(
            f"{__name__} deletes rows and is pointed at {actual!r}, not its own "
            f"temp database. Another test module imported `database` first. "
            f"Run it on its own: python -m unittest {__name__}"
        )


_assert_isolated()


class ScheduleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp.name)

    def setUp(self):
        db = database.SessionLocal()
        db.query(models.NexusSetting).filter(
            models.NexusSetting.key == changelog_auto._STATE_KEY).delete()
        db.commit()
        db.close()
        self.calls = []
        self._real = task_config.generate_changelog_from_commits

    def tearDown(self):
        task_config.generate_changelog_from_commits = self._real

    def _stub(self, created=2, boom=None, error=None):
        def fake(db, author_email=""):
            self.calls.append(author_email)
            if boom:
                raise boom
            if error:
                return {"error": error}     # how the shared core reports a
                                            # missing key - it does not raise
            return {"created": created, "scanned": 7, "source": "github"}
        task_config.generate_changelog_from_commits = fake

    def _state(self) -> dict:
        db = database.SessionLocal()
        try:
            return changelog_auto._read_state(db)
        finally:
            db.close()

    def _set_next_run(self, when: datetime):
        db = database.SessionLocal()
        try:
            changelog_auto._write_state(db, {"next_run_at": when.isoformat()})
        finally:
            db.close()

    def test_first_sweep_generates_and_schedules_the_next(self):
        self._stub(created=2)
        result = changelog_auto._sweep()
        self.assertEqual(result["created"], 2)
        self.assertEqual(len(self.calls), 1)
        nxt = datetime.fromisoformat(self._state()["next_run_at"])
        # Default interval is 24h; allow slack for the clock between the two reads.
        self.assertGreater(nxt, datetime.now(timezone.utc) + timedelta(hours=23))
        self.assertLess(nxt, datetime.now(timezone.utc) + timedelta(hours=25))

    def test_restart_inside_the_interval_does_not_regenerate(self):
        self._stub()
        changelog_auto._sweep()
        self.assertEqual(len(self.calls), 1)
        # Every later poll (and every process restart - the state is in the DB,
        # not in memory) is a no-op until the due time passes.
        self.assertIsNone(changelog_auto._sweep())
        self.assertIsNone(changelog_auto._sweep())
        self.assertEqual(len(self.calls), 1)

    def test_due_time_elapsed_fires_again(self):
        self._stub()
        changelog_auto._sweep()
        self._set_next_run(datetime.now(timezone.utc) - timedelta(minutes=1))
        changelog_auto._sweep()
        self.assertEqual(len(self.calls), 2)

    def test_failure_backs_off_instead_of_retrying_every_poll(self):
        self._stub(error="AI is not configured (ANTHROPIC_API_KEY missing).")
        self.assertIn("error", changelog_auto._sweep())
        state = self._state()
        self.assertIn("ANTHROPIC_API_KEY", state["last_error"])
        nxt = datetime.fromisoformat(state["next_run_at"])
        self.assertGreater(nxt, datetime.now(timezone.utc) + timedelta(minutes=30))
        # The next poll must not re-spend the Anthropic call.
        self.assertIsNone(changelog_auto._sweep())
        self.assertEqual(len(self.calls), 1)

    def test_an_unexpected_exception_backs_off_rather_than_killing_the_loop(self):
        self._stub(boom=ValueError("kaboom"))
        result = changelog_auto._sweep()
        self.assertIn("kaboom", result["error"])
        nxt = datetime.fromisoformat(self._state()["next_run_at"])
        self.assertGreater(nxt, datetime.now(timezone.utc) + timedelta(minutes=30))

    def test_generated_drafts_are_stamped_with_the_configured_author(self):
        os.environ["NEXUS_CHANGELOG_AUTHOR"] = "Nexus@Greensglobal.com"
        try:
            self._stub()
            changelog_auto._sweep()
            self.assertEqual(self.calls, ["nexus@greensglobal.com"])
        finally:
            os.environ.pop("NEXUS_CHANGELOG_AUTHOR", None)


if __name__ == "__main__":
    unittest.main()
