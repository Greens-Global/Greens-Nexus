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
from unittest import mock
from datetime import datetime, timedelta, timezone

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import httpx

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


class _FakeClient:
    """Stands in for httpx.Client in _cluster_commits: answers every post with
    the response the test chose (or raises it)."""
    answer = None

    def __init__(self, *a, **k):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def post(self, url, **kw):
        if isinstance(_FakeClient.answer, Exception):
            raise _FakeClient.answer
        return _FakeClient.answer


def _claude(text="", status=200, stop="end_turn", body=None):
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    if body is None:
        body = {"content": [{"type": "thinking", "thinking": "..."}, {"type": "text", "text": text}],
                "stop_reason": stop}
    return httpx.Response(status, json=body, request=req)


class DraftingFailureTests(unittest.TestCase):
    """A failed Claude call must be an ERROR the sweep records and retries - it
    used to come back as an empty list, so a model Anthropic stopped serving
    (claude-opus-4-8, Oct 2026) looked like weeks of "nothing to draft"."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        db = database.SessionLocal()
        db.query(models.NexusSetting).filter(models.NexusSetting.key == changelog_auto._STATE_KEY).delete()
        db.query(models.TaskChangelogEntry).delete()
        db.commit()
        db.close()
        commits = [{"sha": "abcdef1234567890", "author": "Sagar", "date": "2026-10-06T10:00:00Z",
                    "subject": "Marketing: Google Business Profile", "body": ""}]
        for target, value in ((task_config, {"_ANTHROPIC_API_KEY": "test-key",
                                             "_recent_commits": lambda limit=80: (list(commits), "github")}),
                              (task_config.httpx, {"Client": _FakeClient})):
            for name, v in value.items():
                p = mock.patch.object(target, name, v)
                p.start()
                self.addCleanup(p.stop)

    def _entries(self):
        db = database.SessionLocal()
        try:
            return db.query(models.TaskChangelogEntry).all()
        finally:
            db.close()

    def _generate(self):
        db = database.SessionLocal()
        try:
            return task_config.generate_changelog_from_commits(db, "admin@greensglobal.com")
        finally:
            db.close()

    def test_default_model_is_a_current_one(self):
        self.assertEqual(task_config._AI_MODEL, os.getenv("NEXUS_CHANGELOG_MODEL") or "claude-opus-5")

    def test_a_refused_model_is_an_error_and_drafts_nothing(self):
        _FakeClient.answer = _claude(status=404, body={"type": "error", "error": {
            "type": "not_found_error", "message": "model: claude-opus-4-8"}})
        out = self._generate()
        self.assertIn("HTTP 404", out["error"])
        self.assertIn("claude-opus-4-8", out["error"])
        self.assertEqual(self._entries(), [])

    def test_the_sweep_records_it_and_retries_within_the_hour(self):
        _FakeClient.answer = _claude(status=500, body={"error": {"message": "overloaded"}})
        result = changelog_auto._sweep()
        self.assertIn("overloaded", result["error"])
        db = database.SessionLocal()
        try:
            st = changelog_auto.status(db)
        finally:
            db.close()
        self.assertIn("overloaded", st["lastError"])
        self.assertEqual(st["lastRunAt"], "")                  # not counted as a successful run
        nxt = datetime.fromisoformat(st["nextRunAt"])
        self.assertLess(nxt, datetime.now(timezone.utc) + timedelta(hours=1, minutes=5))

    def test_unreachable_cut_off_and_unreadable_answers_are_errors(self):
        for answer, words in ((httpx.ConnectTimeout("slow"), "Could not reach Claude"),
                              (_claude("[{\"title\": \"A", stop="max_tokens"), "cut off"),
                              (_claude("Sorry, I can't help with that."), "no list"),
                              (_claude("[{not json}]"), "could not be read")):
            _FakeClient.answer = answer
            self.assertIn(words, self._generate()["error"])

    def test_an_empty_list_is_a_quiet_week_not_an_error(self):
        _FakeClient.answer = _claude("[]")
        out = self._generate()
        self.assertNotIn("error", out)
        self.assertEqual(out["created"], 0)

    def test_a_good_answer_files_pending_review_drafts(self):
        _FakeClient.answer = _claude('```json\n[{"title": "Google reviews in Nexus", "description": "Reply to '
                                     'Google reviews from Nexus.", "type": "New Feature", "module": "Marketing", '
                                     '"whatsChanged": ["Replied / Unreplied"], "commitShas": ["abcdef12"]}]\n```')
        out = self._generate()
        self.assertEqual(out["created"], 1)
        (e,) = self._entries()
        self.assertEqual((e.payload["status"], e.payload["commitShas"]), ("Pending Review", ["abcdef12"]))


if __name__ == "__main__":
    unittest.main()
