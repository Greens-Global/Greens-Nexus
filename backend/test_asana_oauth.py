"""
Unit tests for per-user Asana OAuth (asana_oauth.py) and the comment-push
attribution that depends on it (asana_sync.push_comment).

The OAuth round trip itself cannot run here - it needs a public redirect URI
Asana can reach - so the network calls are stubbed and these cover the logic
around them: token selection, refresh-before-expiry, single-use state, the
fallback when someone's grant is rejected, and the absence of the old
"[Nexus - email]" body stamp in every payload branch.

Uses a throwaway sqlite file. No network.

Run with: python -m unittest test_asana_oauth -v
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database
import models
import asana_oauth
import asana_sync
import secret_box
from routers.task_util import gen_id, now_iso

AUTHOR = "ankush.narkhede@greensglobal.com"


def _iso(delta_seconds: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=delta_seconds)).isoformat()


class AsanaOAuthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.AsanaUserToken, models.AsanaOAuthState, models.Task,
                  models.TaskComment, models.AsanaTaskLink, models.AsanaCommentLink):
            self.db.query(m).delete()
        self.db.commit()
        # Pretend the deployment is configured; individual tests stub the calls.
        os.environ["ASANA_OAUTH_CLIENT_ID"] = "cid"
        os.environ["ASANA_OAUTH_CLIENT_SECRET"] = "csecret"
        os.environ["NEXUS_API_BASE"] = "https://nexus.example.com"
        self._refresh_calls = []

    def tearDown(self):
        self.db.close()
        for k in ("ASANA_OAUTH_CLIENT_ID", "ASANA_OAUTH_CLIENT_SECRET", "NEXUS_API_BASE"):
            os.environ.pop(k, None)

    def _grant(self, *, expires_in=3600, refresh_token="rt-1", access_token="at-1"):
        row = models.AsanaUserToken(
            id=gen_id(), email=AUTHOR,
            access_token_enc=secret_box.encrypt(access_token),
            refresh_token_enc=secret_box.encrypt(refresh_token),
            expires_at=_iso(expires_in), asana_user_gid="9", asana_name="Ankush Narkhede",
            asana_email=AUTHOR, created_at=now_iso(), updated_at=now_iso())
        self.db.add(row)
        self.db.commit()
        return row

    # ── configuration gate ───────────────────────────────────────────────
    def test_not_configured_without_a_public_redirect_uri(self):
        """A laptop has no host Asana can redirect back to - the feature must
        report itself unavailable rather than offering a broken Connect."""
        os.environ.pop("NEXUS_API_BASE")
        self.assertFalse(asana_oauth.oauth_configured())
        self.assertIn("public URL", asana_oauth.not_configured_reason())

    def test_not_configured_without_client_credentials(self):
        os.environ.pop("ASANA_OAUTH_CLIENT_ID")
        self.assertFalse(asana_oauth.oauth_configured())
        self.assertIn("ASANA_OAUTH_CLIENT_ID", asana_oauth.not_configured_reason())

    def test_authorize_url_carries_state_and_redirect(self):
        url = asana_oauth.authorize_url("st-123")
        self.assertIn("state=st-123", url)
        self.assertIn("response_type=code", url)
        self.assertIn("nexus.example.com%2Fasana-oauth%2Fcallback", url)

    # ── state rows ───────────────────────────────────────────────────────
    def test_state_is_single_use(self):
        state = asana_oauth.issue_state(self.db, AUTHOR)
        self.assertEqual(asana_oauth.consume_state(self.db, state), AUTHOR)
        # Replaying the same callback must not mint a second grant.
        self.assertEqual(asana_oauth.consume_state(self.db, state), "")

    def test_unknown_state_is_rejected(self):
        self.assertEqual(asana_oauth.consume_state(self.db, "never-issued"), "")

    def test_expired_state_is_rejected(self):
        state = asana_oauth.issue_state(self.db, AUTHOR)
        row = self.db.query(models.AsanaOAuthState).filter(models.AsanaOAuthState.id == state).first()
        row.created_at = _iso(-(asana_oauth.STATE_TTL_SECONDS + 60))
        self.db.commit()
        self.assertEqual(asana_oauth.consume_state(self.db, state), "")

    # ── token_for ────────────────────────────────────────────────────────
    def test_token_for_returns_none_when_not_connected(self):
        self.assertIsNone(asana_oauth.token_for(self.db, AUTHOR))

    def test_token_for_uses_the_stored_token_while_it_is_fresh(self):
        self._grant(expires_in=3600, access_token="fresh-token")
        asana_oauth.refresh = lambda rt: self.fail("must not refresh a fresh token")
        try:
            self.assertEqual(asana_oauth.token_for(self.db, AUTHOR), "fresh-token")
        finally:
            asana_oauth.refresh = _real_refresh

    def test_token_for_refreshes_just_before_expiry(self):
        """Refreshing only AT expiry leaves a window where the token dies
        between the check and the Asana call that uses it."""
        self._grant(expires_in=10, access_token="stale-token")
        asana_oauth.refresh = self._fake_refresh
        try:
            self.assertEqual(asana_oauth.token_for(self.db, AUTHOR), "refreshed-token")
        finally:
            asana_oauth.refresh = _real_refresh
        self.assertEqual(len(self._refresh_calls), 1)
        row = asana_oauth.get_row(self.db, AUTHOR)
        self.assertEqual(secret_box.decrypt(row.access_token_enc), "refreshed-token")

    def test_a_refresh_that_omits_a_new_refresh_token_keeps_the_old_one(self):
        """Asana's refresh response carries no refresh_token; blanking the
        stored one would silently disconnect the user on the next call."""
        self._grant(expires_in=10, refresh_token="rt-keep")
        asana_oauth.refresh = self._fake_refresh
        try:
            asana_oauth.token_for(self.db, AUTHOR)
        finally:
            asana_oauth.refresh = _real_refresh
        row = asana_oauth.get_row(self.db, AUTHOR)
        self.assertEqual(secret_box.decrypt(row.refresh_token_enc), "rt-keep")

    def test_token_for_never_raises_when_the_refresh_fails(self):
        """It runs on the fire-and-forget push thread - an exception there
        would drop the comment instead of falling back to the service token."""
        self._grant(expires_in=10)
        def boom(rt):
            raise ValueError("Asana said no")
        asana_oauth.refresh = boom
        try:
            self.assertIsNone(asana_oauth.token_for(self.db, AUTHOR))
        finally:
            asana_oauth.refresh = _real_refresh

    def test_disconnect_removes_the_grant(self):
        self._grant()
        self.assertTrue(asana_oauth.disconnect(self.db, AUTHOR))
        self.assertIsNone(asana_oauth.get_row(self.db, AUTHOR))

    def _fake_refresh(self, refresh_token):
        self._refresh_calls.append(refresh_token)
        return {"access_token": "refreshed-token", "expires_in": 3600}

    # ── push_comment attribution ─────────────────────────────────────────
    def _task_with_comment(self, author=AUTHOR, body="<p>hello</p>"):
        t = models.Task(id=gen_id(), title="T", code="TASK-1", created_at=now_iso(), modified_at=now_iso())
        self.db.add(t)
        c = models.TaskComment(id=gen_id(), task_id=t.id, author_email=author,
                               body=body, created_at=now_iso())
        self.db.add(c)
        self.db.add(models.AsanaTaskLink(id=gen_id(), nexus_task_id=t.id, asana_gid="A1"))
        self.db.commit()
        return c

    def _capture_posts(self, fail_first_with=None):
        posts = []
        def fake_post(token, path, body):
            posts.append({"token": token, "path": path, "body": body})
            if fail_first_with and len(posts) == 1:
                raise asana_sync.ImportError_(fail_first_with)
            return {"gid": f"story-{len(posts)}"}
        return posts, fake_post

    def _with_sync_on(self):
        cfg = asana_sync.get_config(self.db)
        cfg.enabled = True
        cfg.token = "SERVICE-TOKEN"
        self.db.commit()

    def test_comment_posts_under_the_authors_own_token(self):
        self._with_sync_on()
        self._grant(access_token="ANKUSH-TOKEN")
        c = self._task_with_comment()
        posts, fake_post = self._capture_posts()
        asana_sync._asana_post = fake_post
        try:
            asana_sync.push_comment(self.db, c)
        finally:
            asana_sync._asana_post = _real_asana_post
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0]["token"], "ANKUSH-TOKEN")

    def test_comment_falls_back_to_the_service_token_when_unconnected(self):
        self._with_sync_on()
        c = self._task_with_comment()
        posts, fake_post = self._capture_posts()
        asana_sync._asana_post = fake_post
        try:
            asana_sync.push_comment(self.db, c)
        finally:
            asana_sync._asana_post = _real_asana_post
        self.assertEqual(posts[0]["token"], "SERVICE-TOKEN")

    def test_a_rejected_user_grant_retries_on_the_service_token(self):
        """A revoked grant, or one with no access to that project, must not
        swallow the comment."""
        self._with_sync_on()
        self._grant(access_token="ANKUSH-TOKEN")
        c = self._task_with_comment()
        posts, fake_post = self._capture_posts(fail_first_with="HTTP 403 Forbidden")
        asana_sync._asana_post = fake_post
        try:
            asana_sync.push_comment(self.db, c)
        finally:
            asana_sync._asana_post = _real_asana_post
        self.assertEqual([p["token"] for p in posts], ["ANKUSH-TOKEN", "SERVICE-TOKEN"])
        # and it still linked, so the next pull won't re-import it
        self.assertIsNotNone(self.db.query(models.AsanaCommentLink).filter(
            models.AsanaCommentLink.nexus_comment_id == c.id).first())

    def test_no_nexus_stamp_in_the_html_payload(self):
        self._with_sync_on()
        c = self._task_with_comment(body="<p>plain body</p>")
        posts, fake_post = self._capture_posts()
        asana_sync._asana_post = fake_post
        try:
            asana_sync.push_comment(self.db, c)
        finally:
            asana_sync._asana_post = _real_asana_post
        sent = str(posts[0]["body"])
        self.assertNotIn("[Nexus", sent)
        self.assertNotIn(AUTHOR, sent)

    def test_no_nexus_stamp_in_the_plain_text_retry(self):
        """The html_text-rejected fallback path stamped the prefix too."""
        self._with_sync_on()
        c = self._task_with_comment(body="<p>plain body</p>")
        posts, fake_post = self._capture_posts(fail_first_with="html_text is not valid")
        asana_sync._asana_post = fake_post
        try:
            asana_sync.push_comment(self.db, c)
        finally:
            asana_sync._asana_post = _real_asana_post
        self.assertEqual(len(posts), 2)
        self.assertIn("text", posts[1]["body"]["data"])
        self.assertNotIn("[Nexus", str(posts[1]["body"]))


_real_refresh = asana_oauth.refresh
_real_asana_post = asana_sync._asana_post


if __name__ == "__main__":
    unittest.main()
