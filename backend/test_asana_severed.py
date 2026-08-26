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

    def test_the_models_and_link_rows_are_kept(self):
        # "Sever the link, keep the backend": a restore must not need a
        # migration or a re-import.
        import models
        for name in ("AsanaTaskLink", "AsanaProjectMap", "AsanaSyncConfig",
                     "AsanaCommentLink", "AsanaPendingDelete", "AsanaWebhook"):
            self.assertTrue(hasattr(models, name), name)


if __name__ == "__main__":
    unittest.main(verbosity=2)
