"""
Outbound assignee sync (field-report, Aug 2026).

Symptom: an assignee set in Nexus never reached Asana, while comments, dates
and custom fields on the same task all synced. Cause: _user_map returns {}
without a Workspace GID, so _asana_user_gid can never resolve anyone, and
push_task dropped the field silently.

The damaging part was the SECOND half: _task_digest includes assignee_email, so
after pushing everything else the link recorded a digest claiming the assignee
was synced. Every later push then short-circuited on `last_hash == digest` and
the assignee was never retried - permanently, invisibly, even once the
Workspace GID was set.

These tests pin the invariant that prevents that: last_hash records what Asana
ACTUALLY holds, so an unsent field stays pending and self-heals.

Uses a throwaway sqlite file. No network - the Asana writes are stubbed.

Run with: python -m unittest test_asana_assignee -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database
import models
import asana_sync
from routers.task_util import gen_id, now_iso

ASSIGNEE = "ankush.narkhede@greensglobal.com"
WORKSPACE = "413144745704203"


class AssigneePushTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.AsanaTaskLink, models.AsanaSyncConfig,
                  models.AsanaProjectMap, models.TaskProject):
            self.db.query(m).delete()
        self.db.commit()
        asana_sync._USER_CACHE.clear()
        self.writes = []
        self._real_write = asana_sync._task_write
        self._real_extras = asana_sync._push_extras
        asana_sync._task_write = lambda tok, method, path, fields=None: (
            self.writes.append({"method": method, "path": path, "fields": fields or {}})
            or {"gid": "A1"})
        asana_sync._push_extras = lambda *a, **k: None

    def tearDown(self):
        asana_sync._task_write = self._real_write
        asana_sync._push_extras = self._real_extras
        self.db.close()

    def _config(self, workspace_gid=""):
        cfg = models.AsanaSyncConfig(id="singleton", enabled=True, token="tok",
                                     workspace_gid=workspace_gid)
        self.db.add(cfg)
        self.db.commit()
        return cfg

    def _linked_task(self, assignee=""):
        p = models.TaskProject(id=gen_id(), name="P", created_at=now_iso())
        self.db.add(p)
        t = models.Task(id=gen_id(), title="T", code="TASK-1", project_id=p.id,
                        assignee_email=assignee, created_at=now_iso(), modified_at=now_iso())
        self.db.add(t)
        self.db.add(models.AsanaProjectMap(id=gen_id(), nexus_project_id=p.id,
                                           asana_project_gid="P1", created_at=now_iso()))
        self.db.add(models.AsanaTaskLink(id=gen_id(), nexus_task_id=t.id, asana_gid="A1"))
        self.db.commit()
        return t

    def _seed_roster(self, cfg):
        """Pretend the workspace roster resolved, without any HTTP."""
        asana_sync._USER_CACHE[(cfg.token, cfg.workspace_gid)] = (
            asana_sync.time.time(), {ASSIGNEE: "USER-GID-9"})

    def _last_fields(self):
        return self.writes[-1]["fields"] if self.writes else {}

    # ── the reported symptom ─────────────────────────────────────────────
    def test_without_a_workspace_gid_the_assignee_is_not_sent(self):
        cfg = self._config(workspace_gid="")
        t = self._linked_task(assignee=ASSIGNEE)

        asana_sync.push_task(self.db, t)

        self.assertTrue(self.writes, "the task itself must still push")
        self.assertNotIn("assignee", self._last_fields(),
                         "no workspace means no user lookup, so nothing to send")

    def test_the_other_fields_still_sync_without_a_workspace_gid(self):
        """Which is exactly why this reads as 'only assignee is broken'."""
        cfg = self._config(workspace_gid="")
        t = self._linked_task(assignee=ASSIGNEE)
        t.title = "Renamed"
        self.db.commit()

        asana_sync.push_task(self.db, t)

        self.assertEqual(self._last_fields().get("name"), "Renamed")

    # ── the invariant that makes it recoverable ──────────────────────────
    def test_an_unsent_assignee_is_not_recorded_as_synced(self):
        """The core defect: last_hash claimed the assignee was pushed, so every
        later push short-circuited and it was never retried."""
        cfg = self._config(workspace_gid="")
        t = self._linked_task(assignee=ASSIGNEE)

        asana_sync.push_task(self.db, t)

        link = asana_sync._link_by_nexus(self.db, t.id)
        claimed = asana_sync._task_digest(self.db, t)                  # with the assignee
        honest = asana_sync._task_digest(self.db, t, assignee="")      # what actually went
        self.assertNotEqual(link.last_hash, claimed,
                            "recording the intended assignee makes the failure permanent")
        self.assertEqual(link.last_hash, honest)

    def test_setting_the_workspace_gid_makes_the_next_push_send_it(self):
        """Self-healing: the whole point of the invariant above."""
        cfg = self._config(workspace_gid="")
        t = self._linked_task(assignee=ASSIGNEE)
        asana_sync.push_task(self.db, t)
        self.assertNotIn("assignee", self._last_fields())

        # The operator fills in the Workspace GID.
        cfg.workspace_gid = WORKSPACE
        self.db.commit()
        self._seed_roster(cfg)
        self.writes.clear()

        asana_sync.push_task(self.db, t)

        self.assertEqual(self._last_fields().get("assignee"), "USER-GID-9",
                         "the previously-skipped assignee must be retried, not short-circuited")

    def test_a_resolvable_assignee_is_sent_and_recorded(self):
        cfg = self._config(workspace_gid=WORKSPACE)
        self._seed_roster(cfg)
        t = self._linked_task(assignee=ASSIGNEE)

        asana_sync.push_task(self.db, t)

        self.assertEqual(self._last_fields().get("assignee"), "USER-GID-9")
        link = asana_sync._link_by_nexus(self.db, t.id)
        self.assertEqual(link.last_hash, asana_sync._task_digest(self.db, t))

    def test_unassigning_in_nexus_clears_it_in_asana(self):
        cfg = self._config(workspace_gid=WORKSPACE)
        self._seed_roster(cfg)
        t = self._linked_task(assignee="")

        asana_sync.push_task(self.db, t)

        self.assertIsNone(self._last_fields().get("assignee", "missing"),
                          "an empty Nexus assignee explicitly unassigns in Asana")

    def test_an_unchanged_task_still_short_circuits(self):
        """The fix must not make every sweep re-push an untouched task."""
        cfg = self._config(workspace_gid="")
        t = self._linked_task(assignee=ASSIGNEE)
        asana_sync.push_task(self.db, t)
        self.writes.clear()

        asana_sync.push_task(self.db, t)

        self.assertEqual(self.writes, [], "nothing changed, so nothing should be sent")

    def test_rows_mismarked_by_the_old_code_heal_with_no_backfill(self):
        """Deploy order matters, and this is why it's code first, config second.

        A link written by the old code holds a digest computed WITH the assignee
        it silently dropped. Deploy the fix while the Workspace GID is still
        blank - the state that caused the bug - and the assignee is still
        unresolvable, so the new digest omits it, mismatches the stale hash, and
        the task re-pushes onto an honest hash. Filling in the workspace after
        that mismatches again and sends the assignee for real.

        So that path needs no migration. See the next test for the one that
        does need care."""
        cfg = self._config(workspace_gid="")
        t = self._linked_task(assignee=ASSIGNEE)
        link = asana_sync._link_by_nexus(self.db, t.id)
        link.last_hash = asana_sync._task_digest(self.db, t)   # what the old code stored
        self.db.commit()

        asana_sync.push_task(self.db, t)
        self.assertTrue(self.writes, "the stale optimistic hash must no longer match")
        self.assertEqual(link.last_hash, asana_sync._task_digest(self.db, t, assignee=""))

        cfg.workspace_gid = WORKSPACE          # operator fills it in afterwards
        self.db.commit()
        self._seed_roster(cfg)
        self.writes.clear()

        asana_sync.push_task(self.db, t)
        self.assertEqual(self._last_fields().get("assignee"), "USER-GID-9")

    def test_config_before_code_leaves_a_legacy_row_stuck(self):
        """The one remaining gap, recorded rather than papered over.

        Set the Workspace GID BEFORE the fixed code has pushed even once, and
        the legacy hash (assignee included) equals what the fixed code now
        computes (assignee resolvable, so also included). They match, it
        short-circuits, and the assignee never goes out.

        Not fixable in code: a legacy row that dropped its assignee and a row
        whose assignee genuinely reached Asana are indistinguishable - same
        hash, nothing recording which wrote it. The workaround is to deploy the
        code first, or edit the task once to force a re-push."""
        cfg = self._config(workspace_gid=WORKSPACE)
        self._seed_roster(cfg)
        t = self._linked_task(assignee=ASSIGNEE)
        link = asana_sync._link_by_nexus(self.db, t.id)
        link.last_hash = asana_sync._task_digest(self.db, t)
        self.db.commit()

        asana_sync.push_task(self.db, t)

        self.assertEqual(self.writes, [],
                         "known gap - if this starts failing the gap closed, update the docs")

    def test_an_assignee_with_no_asana_account_behaves_the_same_way(self):
        """Not only the missing-workspace case - anyone absent from the roster."""
        cfg = self._config(workspace_gid=WORKSPACE)
        asana_sync._USER_CACHE[(cfg.token, cfg.workspace_gid)] = (
            asana_sync.time.time(), {"someone.else@greensglobal.com": "OTHER"})
        t = self._linked_task(assignee=ASSIGNEE)

        asana_sync.push_task(self.db, t)

        self.assertNotIn("assignee", self._last_fields())
        link = asana_sync._link_by_nexus(self.db, t.id)
        self.assertEqual(link.last_hash, asana_sync._task_digest(self.db, t, assignee=""))


if __name__ == "__main__":
    unittest.main()
