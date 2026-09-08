"""GitHub webhook -> admin notification + "What's New" drafts just after a merge.

The endpoint is public, so the tests that matter are the ones about what it
REFUSES: an unsigned or wrongly-signed body, and any branch but the one this
deployment tracks (prod must not redraft on every dev merge). The rest is the
coalescing rule - a burst of merges, including the duplicate push a merged PR
also fires, has to become one draft, with a ceiling so a busy afternoon cannot
postpone the run forever.

Run with: python -m unittest test_changelog_webhook -v
"""
import hashlib
import hmac
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["GITHUB_WEBHOOK_SECRET"] = "s3cret"

import database
import models
import changelog_auto
from fastapi import FastAPI
from fastapi.testclient import TestClient
from routers import github_webhook

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

_app = FastAPI()
_app.include_router(github_webhook.router)
_URL = "/webhooks/github"


def _push(branch="dev", commits=1, deleted=False) -> bytes:
    return json.dumps({
        "ref": f"refs/heads/{branch}",
        "deleted": deleted,
        "commits": [{"id": f"abc{i}"} for i in range(commits)],
    }).encode()


def _pr_merged(branch="dev", merged=True, action="closed") -> bytes:
    return json.dumps({
        "action": action,
        "pull_request": {"number": 42, "title": "Ship it", "merged": merged,
                         "base": {"ref": branch}, "user": {"login": "someone"},
                         "html_url": "https://github.com/x/y/pull/42"},
    }).encode()


def _sign(body: bytes, secret="s3cret") -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


class WebhookTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(_app)

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

    def _post(self, body: bytes, sig=None, event="push"):
        return self.client.post(_URL, content=body, headers={
            "X-Hub-Signature-256": _sign(body) if sig is None else sig,
            "X-GitHub-Event": event,
            "Content-Type": "application/json",
        })

    def _state(self) -> dict:
        db = database.SessionLocal()
        try:
            return changelog_auto._read_state(db)
        finally:
            db.close()

    def _due_in_minutes(self) -> float:
        nxt = datetime.fromisoformat(self._state()["next_run_at"])
        return (nxt - datetime.now(timezone.utc)).total_seconds() / 60

    # ── What it accepts ───────────────────────────────────────────────────
    def test_push_to_the_tracked_branch_schedules_a_draft(self):
        r = self._post(_push())
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["branch"], "dev")
        # Default 5-minute delay: long enough for a backend merge's redeploy.
        self.assertGreater(self._due_in_minutes(), 3)
        self.assertLess(self._due_in_minutes(), 6)

    def test_ping_is_answered_so_github_activates_the_hook(self):
        # GitHub sends this once when the hook is created; a clean 2xx is what
        # turns the delivery green, and nothing should be scheduled off it.
        r = self._post(b"{}", event="ping")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json().get("ok"))
        self.assertEqual(self._state(), {})

    # ── What it refuses ───────────────────────────────────────────────────
    def test_unsigned_and_missigned_bodies_are_rejected(self):
        body = _push()
        self.assertEqual(self._post(body, sig="").status_code, 401)
        self.assertEqual(self._post(body, sig=_sign(body, "wrong")).status_code, 401)
        # A tampered body under a signature of the original must not pass.
        self.assertEqual(
            self.client.post(_URL, content=_push(commits=9), headers={
                "X-Hub-Signature-256": _sign(body), "X-GitHub-Event": "push"}).status_code, 401)
        self.assertEqual(self._state(), {})

    def test_other_branches_are_ignored(self):
        # prod tracks main; a dev merge must not make it redraft (and vice versa).
        for body in (_push(branch="main"), _push(branch="feature/nexus-sagar"),
                     _push(deleted=True, commits=0)):
            r = self._post(body)
            self.assertEqual(r.status_code, 200)
            self.assertIn("ignored", r.json())
        self.assertEqual(self._state(), {})

    # ── Merged pull requests ──────────────────────────────────────────────
    def test_a_merged_pr_schedules_a_draft(self):
        r = self._post(_pr_merged(), event="pull_request")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["branch"], "dev")
        self.assertLess(self._due_in_minutes(), 6)

    def test_an_unmerged_or_still_open_pr_does_nothing(self):
        for body in (_pr_merged(merged=False), _pr_merged(action="opened"),
                     _pr_merged(branch="feature/x")):
            self.assertEqual(self._post(body, event="pull_request").status_code, 200)
        self.assertEqual(self._state(), {})

    def test_a_merged_pr_and_its_push_event_produce_one_draft(self):
        # GitHub fires both for the same merge; coalescing has to absorb that.
        self._post(_pr_merged(), event="pull_request")
        first = self._state()["pending_since"]
        self._post(_push())
        self.assertEqual(self._state()["pending_since"], first)
        self.assertLess(self._due_in_minutes(), 6)

    def test_without_a_secret_the_endpoint_is_off_rather_than_open(self):
        os.environ.pop("GITHUB_WEBHOOK_SECRET")
        try:
            r = self._post(_push())
            self.assertEqual(r.status_code, 503)
            self.assertIn("GITHUB_WEBHOOK_SECRET", r.json()["detail"])
            self.assertEqual(self._state(), {})
        finally:
            os.environ["GITHUB_WEBHOOK_SECRET"] = "s3cret"

    # ── Coalescing ────────────────────────────────────────────────────────
    def test_a_burst_of_merges_becomes_one_draft(self):
        self._post(_push())
        first = self._state()["pending_since"]
        self._post(_push())
        self._post(_push())
        # Still one pending sweep, still anchored to the first merge of the burst.
        self.assertEqual(self._state()["pending_since"], first)
        self.assertLess(self._due_in_minutes(), 6)

    def test_a_long_burst_cannot_postpone_the_run_forever(self):
        self._post(_push())
        # Pretend the burst started 29 minutes ago (ceiling is 30).
        db = database.SessionLocal()
        changelog_auto._write_state(db, {
            "pending_since": (datetime.now(timezone.utc) - timedelta(minutes=29)).isoformat()})
        db.close()
        self._post(_push())
        # The 5-minute delay would push it to +5; the ceiling holds it at +1.
        self.assertLess(self._due_in_minutes(), 2)

    def test_an_earlier_pending_sweep_is_never_pushed_later(self):
        db = database.SessionLocal()
        changelog_auto._write_state(db, {
            "next_run_at": (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat()})
        db.close()
        self._post(_push())
        self.assertLess(self._due_in_minutes(), 2)


if __name__ == "__main__":
    unittest.main()
