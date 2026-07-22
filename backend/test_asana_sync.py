"""
Unit tests for asana_sync.unlink_deleted_task.

Uses a throwaway sqlite file so it never touches the real dev DB
(greens_nexus.db) or Supabase. No network/Asana token needed.

Run with: python -m unittest test_asana_sync -v
"""
import os
import tempfile
import unittest

# Must happen before `import database` — DATABASE_URL is read at module import
# time to build the engine.
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database
import models
from routers.task_util import gen_id, now_iso
import asana_sync


class UnlinkDeletedTaskTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()

    def tearDown(self):
        self.db.close()

    def _make_linked_task(self, gid="asana-gid-123"):
        t = models.Task(id=gen_id(), title="Synced task", synced_with_asana=True)
        self.db.add(t)
        self.db.flush()
        link = models.AsanaTaskLink(id=gen_id(), nexus_task_id=t.id, asana_gid=gid,
                                     last_hash="x", last_synced_at=now_iso())
        self.db.add(link)
        self.db.commit()
        return t.id, gid

    def test_clears_the_link_and_flags_the_task_unsynced(self):
        task_id, gid = self._make_linked_task()

        result = asana_sync.unlink_deleted_task(self.db, gid)

        self.assertTrue(result)
        self.assertIsNone(
            self.db.query(models.AsanaTaskLink).filter_by(asana_gid=gid).first()
        )
        self.assertFalse(self.db.get(models.Task, task_id).synced_with_asana)

    def test_nexus_task_is_not_deleted_only_unlinked(self):
        task_id, gid = self._make_linked_task()

        asana_sync.unlink_deleted_task(self.db, gid)

        self.assertIsNotNone(self.db.get(models.Task, task_id))

    def test_unknown_gid_is_a_noop(self):
        result = asana_sync.unlink_deleted_task(self.db, "gid-never-linked")

        self.assertFalse(result)

    def test_ignores_other_links_for_a_different_gid(self):
        task_id, gid = self._make_linked_task("gid-a")
        other_id, other_gid = self._make_linked_task("gid-b")

        asana_sync.unlink_deleted_task(self.db, gid)

        self.assertIsNone(
            self.db.query(models.AsanaTaskLink).filter_by(asana_gid=gid).first()
        )
        self.assertIsNotNone(
            self.db.query(models.AsanaTaskLink).filter_by(asana_gid=other_gid).first()
        )
        self.assertTrue(self.db.get(models.Task, other_id).synced_with_asana)


if __name__ == "__main__":
    unittest.main()
