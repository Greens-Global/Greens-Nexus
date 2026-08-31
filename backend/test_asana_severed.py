"""Asana is severed (Aug 27): the integration is inert unless deliberately
re-enabled, while all of its code and data are kept so restoring the link needs
no migration and no re-import.

Run with: python -m unittest test_asana_severed
"""
import os
import tempfile
import unittest

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import database
import models
models.Base.metadata.create_all(bind=database.engine)
import asana_sync


class SeveredTests(unittest.TestCase):
    def setUp(self):
        for k in ("NEXUS_ASANA_ENABLED", "NEXUS_ASANA_SYNC_WORKER", "WEBSITE_SITE_NAME"):
            os.environ.pop(k, None)

    tearDown = setUp

    def test_disabled_by_default(self):
        self.assertFalse(asana_sync.is_asana_enabled())

    def test_no_background_sync_while_severed(self):
        self.assertFalse(asana_sync.is_sync_worker())

    def test_the_deployed_api_does_not_resume_sync_on_its_own(self):
        # WEBSITE_SITE_NAME is set by Azure App Service and used to be the whole
        # test for "this process may sync" - it must not re-open the link.
        os.environ["WEBSITE_SITE_NAME"] = "greens-nexus-dev"
        self.assertFalse(asana_sync.is_sync_worker())

    def test_the_worker_opt_in_alone_does_not_resume_sync(self):
        os.environ["NEXUS_ASANA_SYNC_WORKER"] = "true"
        self.assertFalse(asana_sync.is_sync_worker())

    def test_re_enabling_restores_the_previous_behavior(self):
        os.environ["NEXUS_ASANA_ENABLED"] = "true"
        self.assertTrue(asana_sync.is_asana_enabled())
        # Still gated the way it always was: neither marker set means no sync.
        self.assertFalse(asana_sync.is_sync_worker())
        os.environ["NEXUS_ASANA_SYNC_WORKER"] = "true"
        self.assertTrue(asana_sync.is_sync_worker())

    # ── The network doors ────────────────────────────────────────────────────
    # Endpoint gates stop the callers that exist today. These cover the callers
    # that don't exist yet: every function that can open a socket to Asana
    # refuses on its own, so a new call site cannot reopen the link by
    # forgetting a dependency.
    def test_the_api_primitive_refuses(self):
        # asana_import._request is the single funnel for every Asana API call.
        import asana_import
        with self.assertRaises(asana_import.ImportError_):
            asana_import._request("GET", "https://app.asana.com/api/1.0/users/me", {})

    def test_the_oauth_token_call_refuses(self):
        # Reachable from a stored grant's refresh, not only from a request.
        import asana_oauth
        with self.assertRaises(ValueError):
            asana_oauth._post_form({"grant_type": "refresh_token"})

    def test_the_rescue_worker_makes_no_calls(self):
        import asana_rescue
        self.assertEqual(asana_rescue._get_json("/users/me", "tok"), (None, -1))
        self.assertEqual(asana_rescue._download_to_temp("https://example.invalid/x"), (None, 0, ""))
        # And it never starts: no thread pool, no DB session.
        counts = asana_rescue.run_rescue(lambda: (_ for _ in ()).throw(
            AssertionError("run_rescue opened a database session while severed")))
        self.assertEqual(counts["scanned"], 0)

    def test_no_deletion_is_banked_for_asana(self):
        # The one write that survived the first sever: a local tombstone per
        # deleted linked task, draining only if the switch is ever flipped back.
        import database
        import models
        db = database.SessionLocal()
        try:
            before = db.query(models.AsanaPendingDelete).count()
            asana_sync.queue_task_delete(db, ["gid-1", "gid-2"], "T", "0001", "me@x")
            db.commit()
            self.assertEqual(db.query(models.AsanaPendingDelete).count(), before)
            self.assertEqual(asana_sync.drain_pending_deletes(db),
                             {"deleted": 0, "pending": 0})
        finally:
            db.close()

    def test_re_enabling_restores_the_queue(self):
        import database
        import models
        os.environ["NEXUS_ASANA_ENABLED"] = "true"
        db = database.SessionLocal()
        try:
            before = db.query(models.AsanaPendingDelete).count()
            asana_sync.queue_task_delete(db, ["gid-3"], "T", "0002", "me@x")
            db.commit()
            self.assertEqual(db.query(models.AsanaPendingDelete).count(), before + 1)
        finally:
            db.close()

    def test_the_models_and_link_rows_are_kept(self):
        # "Sever the link, keep the backend": a restore must not need a
        # migration or a re-import.
        import models
        for name in ("AsanaTaskLink", "AsanaProjectMap", "AsanaSyncConfig",
                     "AsanaCommentLink", "AsanaPendingDelete", "AsanaWebhook"):
            self.assertTrue(hasattr(models, name), name)


if __name__ == "__main__":
    unittest.main(verbosity=2)
