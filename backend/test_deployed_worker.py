"""The deployed-worker gate is independent of any integration's kill switch.

Six background jobs - the task reply-email drain, both screenshot sweeps, the
construction sweep, the nightly M365 writeback and the task trash purge - only
run on the deployed API. They asked asana_sync.is_sync_worker() until Sept 1
2026, which answered that by accident because it read WEBSITE_SITE_NAME.
Severing Asana (Aug 27) put "is Asana enabled?" in front of that check, so all
six silently stopped on dev and prod. Nothing failed loudly; they just never
started.

These pin the split, because the failure mode is silence.

Run with: python -m unittest test_deployed_worker
"""
import os
import tempfile
import unittest

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import asana_sync
from leader import is_deployed_worker

_VARS = ("NEXUS_ASANA_ENABLED", "NEXUS_ASANA_SYNC_WORKER",
         "NEXUS_BACKGROUND_WORKER", "WEBSITE_SITE_NAME")


class DeployedWorkerTests(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in _VARS}
        for k in _VARS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_a_laptop_is_not_the_deployed_worker(self):
        self.assertFalse(is_deployed_worker())

    def test_the_deployed_api_is(self):
        os.environ["WEBSITE_SITE_NAME"] = "greens-nexus-api"
        self.assertTrue(is_deployed_worker())

    # The regression itself: Asana severed, but these jobs must still run.
    def test_severing_asana_does_not_switch_the_jobs_off(self):
        os.environ["WEBSITE_SITE_NAME"] = "greens-nexus-api"
        self.assertFalse(asana_sync.is_asana_enabled())   # severed
        self.assertFalse(asana_sync.is_sync_worker())     # so no Asana traffic
        self.assertTrue(is_deployed_worker())             # but the jobs still run

    def test_enabling_asana_does_not_switch_them_on_locally(self):
        # The reverse mistake: a laptop must not start draining the shared
        # mailbox just because someone re-enabled the integration.
        os.environ["NEXUS_ASANA_ENABLED"] = "true"
        self.assertFalse(is_deployed_worker())

    def test_a_laptop_can_still_opt_in_deliberately(self):
        os.environ["NEXUS_BACKGROUND_WORKER"] = "true"
        self.assertTrue(is_deployed_worker())

    def test_the_old_opt_in_still_works(self):
        # Anyone who set this before the split keeps the behavior they chose.
        os.environ["NEXUS_ASANA_SYNC_WORKER"] = "true"
        self.assertTrue(is_deployed_worker())

    def test_the_two_gates_are_not_the_same_function(self):
        # Guards against someone "simplifying" one back into the other.
        self.assertIsNot(is_deployed_worker, asana_sync.is_sync_worker)


# The six jobs that must run on the deployed API and have nothing to do with
# Asana. Named once so both wiring checks below stay in step.
SIX_DEPLOYED_JOBS = ("task_inbound_loop", "screenshot_migration_loop",
                     "screenshot_retention_loop", "construction_sweep_loop",
                     "m365_pushback_loop", "trash_purge_loop")


class WiringTests(unittest.TestCase):
    """main.py must not gate a non-Asana job on the Asana switch again."""

    def test_only_asana_jobs_ask_the_asana_gate(self):
        import pathlib
        main = pathlib.Path(__file__).with_name("main.py").read_text(encoding="utf-8")
        # Named jobs, not keywords: every use of the Asana gate necessarily sits
        # under `from asana_sync import ...`, so looking for the word "asana"
        # nearby passes even on the exact regression this guards - checked by
        # reverting one site and watching it stay green. What actually matters
        # is which JOB the gate starts.
        lines = main.splitlines()
        for i, ln in enumerate(lines):
            if "is_sync_worker" not in ln or ln.strip().startswith("#"):
                continue
            block = "\n".join(lines[i:i + 6])
            for job in SIX_DEPLOYED_JOBS:
                self.assertNotIn(job, block,
                                 f"{job} is gated on the Asana switch again (line {i + 1})")

    def test_the_six_jobs_are_gated_on_the_deployed_worker(self):
        import pathlib
        main = pathlib.Path(__file__).with_name("main.py").read_text(encoding="utf-8")
        for job in SIX_DEPLOYED_JOBS:
            before = main.split(job)[0]
            self.assertIn("is_deployed_worker", before.rsplit("try:", 1)[-1],
                          f"{job} is not behind is_deployed_worker()")


if __name__ == "__main__":
    unittest.main(verbosity=2)
