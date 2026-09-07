"""GitHub push webhook -> "What's New" drafts just after a merge.

The endpoint is public, so the tests that matter are the ones about what it
REFUSES: an unsigned or wrongly-signed body, another repo, and any branch but
the one this deployment tracks (prod must not redraft on every dev merge). The
rest is the coalescing rule - a burst of merges has to become one draft, with a
ceiling so a busy afternoon cannot postpone the run forever.

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

_app = FastAPI()
_app.include_router(github_webhook.router)
_URL = "/task-changelog/github-webhook"


def _push(branch="dev", repo="Greens-Global/Greens-Nexus", commits=1, deleted=False) -> bytes:
    return json.dumps({
        "ref": f"refs/heads/{branch}",
        "deleted": deleted,
        "repository": {"full_name": repo},
        "commits": [{"id": f"abc{i}"} for i in range(commits)],
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
        r = self._post(b"{}", event="ping")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json().get("pong"))
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

    def test_other_branches_and_repos_are_ignored(self):
        # prod tracks main; a dev merge must not make it redraft (and vice versa).
        for body in (_push(branch="main"), _push(branch="feature/nexus-sagar"),
                     _push(repo="someone-else/fork"), _push(deleted=True, commits=0)):
            r = self._post(body)
            self.assertEqual(r.status_code, 200)
            self.assertIn("ignored", r.json())
        self.assertEqual(self._state(), {})

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
