"""
Why a comment posted as the service account instead of its author (Aug 2026).

Asana attributes every write to whoever owns the token and has no impersonation
parameter, so a comment only carries its real author when Nexus holds that
person's own OAuth grant. When it doesn't, push_comment falls back to the shared
PAT - deliberately, because losing a comment is worse than posting it under the
wrong name.

That fallback used to be *silent*, and several of its branches were
indistinguishable from "never connected". Account Settings kept promising
"comments appear in Asana as <you>" while every comment went out as somebody
else, and nothing anywhere recorded why. token_reason returns the reason so the
app can show it and the push can log it.

These pin the reason for each way a grant can be unusable. Throwaway sqlite; the
one branch that would hit the network is stubbed.

Run with: python -m unittest test_asana_oauth_reason -v
"""
import os
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import atexit

from cryptography.fernet import Fernet

import asana_oauth
import database
import models
import secret_box

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


ME = "sagar.shoundik@greensglobal.com"


class TokenReasonTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        self.db.query(models.AsanaUserToken).delete()
        self.db.commit()
        # oauth_configured() gates everything below it. All three are read
        # lazily, so setting them here is enough - and setting them at all is
        # what lets these tests reach the branches that matter instead of
        # stopping at "not configured".
        for key, val in (("ASANA_OAUTH_CLIENT_ID", "cid"),
                         ("ASANA_OAUTH_CLIENT_SECRET", "secret"),
                         ("NEXUS_API_BASE", "https://dev.example.com")):
            os.environ[key] = val
            self.addCleanup(os.environ.pop, key, None)

    def _grant(self, *, access="live-access-token", refresh="live-refresh-token",
               expires_in=3600, access_enc=None, refresh_enc=None):
        row = models.AsanaUserToken(
            id=str(uuid.uuid4()), email=ME,
            access_token_enc=access_enc if access_enc is not None else secret_box.encrypt(access),
            refresh_token_enc=refresh_enc if refresh_enc is not None else secret_box.encrypt(refresh),
            expires_at=(datetime.now(timezone.utc) + timedelta(seconds=expires_in)).isoformat(),
            asana_name="Sagar Kumar Shoundik", created_at="")
        self.db.add(row)
        self.db.commit()
        return row

    # ── the working case ─────────────────────────────────────────────────
    def test_a_fresh_grant_returns_its_token_and_no_reason(self):
        self._grant()
        token, why = asana_oauth.token_reason(self.db, ME)
        self.assertEqual(token, "live-access-token")
        self.assertEqual(why, "")

    def test_token_for_still_agrees_with_token_reason(self):
        """token_for is the thin wrapper the push path calls. If the two ever
        disagree, the reason shown would describe a decision that was not the
        one actually taken."""
        self._grant()
        self.assertEqual(asana_oauth.token_for(self.db, ME),
                         asana_oauth.token_reason(self.db, ME)[0])

    # ── every way it can be unusable ─────────────────────────────────────
    def test_never_connected(self):
        token, why = asana_oauth.token_reason(self.db, ME)
        self.assertIsNone(token)
        self.assertIn("has not connected", why)

    def test_no_author_at_all(self):
        """The 'asana-sync' stamp and system-written comments have no person
        behind them - not a failure, just nobody to attribute to."""
        token, why = asana_oauth.token_reason(self.db, "")
        self.assertIsNone(token)
        self.assertIn("no author", why)

    def test_oauth_not_configured_says_which_setting(self):
        os.environ.pop("ASANA_OAUTH_CLIENT_ID", None)
        self._grant()
        token, why = asana_oauth.token_reason(self.db, ME)
        self.assertIsNone(token)
        self.assertIn("ASANA_OAUTH_CLIENT_ID", why)

    def test_a_grant_with_no_refresh_token(self):
        self._grant(refresh_enc="")
        token, why = asana_oauth.token_reason(self.db, ME)
        self.assertIsNone(token)
        self.assertIn("refresh token", why)

    def test_a_grant_encrypted_under_a_different_vault_key(self):
        """NEXUS_VAULT_KEY changed since the grant was stored, so the ciphertext
        is unrecoverable. This was the branch most easily mistaken for 'never
        connected' - the row is right there, and every comment silently posts as
        the service account."""
        foreign = Fernet(Fernet.generate_key()).encrypt(b"not-ours").decode()
        self._grant(access_enc=foreign)
        token, why = asana_oauth.token_reason(self.db, ME)
        self.assertIsNone(token)
        self.assertIn("cannot be decrypted", why)
        self.assertIn("reconnect", why.lower())

    def test_an_expired_grant_whose_refresh_is_refused(self):
        """Asana answers the refresh but returns no token - a revoked grant.
        Silent before this, and indistinguishable from never having connected."""
        self._grant(expires_in=-60)
        original = asana_oauth.refresh
        asana_oauth.refresh = lambda _tok: {}
        self.addCleanup(setattr, asana_oauth, "refresh", original)

        token, why = asana_oauth.token_reason(self.db, ME)
        self.assertIsNone(token)
        self.assertIn("refused to refresh", why)

    def test_an_expired_grant_that_refreshes_successfully(self):
        """The ordinary hourly case: the stored access token has aged out and is
        renewed in place, so the comment still posts as its author."""
        self._grant(expires_in=-60)
        original = asana_oauth.refresh
        asana_oauth.refresh = lambda _tok: {"access_token": "renewed", "expires_in": 3600}
        self.addCleanup(setattr, asana_oauth, "refresh", original)

        token, why = asana_oauth.token_reason(self.db, ME)
        self.assertEqual(token, "renewed")
        self.assertEqual(why, "")
        # Persisted, so the next comment does not refresh again.
        self.assertEqual(secret_box.decrypt(
            asana_oauth.get_row(self.db, ME).access_token_enc), "renewed")

    def test_a_network_failure_reports_itself_rather_than_raising(self):
        """This runs on the fire-and-forget comment push thread, where an
        exception would drop the comment entirely."""
        self._grant(expires_in=-60)
        original = asana_oauth.refresh

        def _boom(_tok):
            raise OSError("connection reset")
        asana_oauth.refresh = _boom
        self.addCleanup(setattr, asana_oauth, "refresh", original)

        token, why = asana_oauth.token_reason(self.db, ME)
        self.assertIsNone(token)
        self.assertIn("connection reset", why)

    def test_every_failure_gives_a_non_empty_reason(self):
        """The whole point - a reason that is blank leaves the user exactly
        where they were before this existed."""
        for setup in (lambda: None,
                      lambda: self._grant(refresh_enc=""),
                      lambda: self._grant(access_enc=Fernet(Fernet.generate_key()).encrypt(b"x").decode())):
            self.db.query(models.AsanaUserToken).delete()
            self.db.commit()
            setup()
            token, why = asana_oauth.token_reason(self.db, ME)
            self.assertIsNone(token)
            self.assertTrue(why.strip(), "a failure produced an empty reason")


if __name__ == "__main__":
    unittest.main()
