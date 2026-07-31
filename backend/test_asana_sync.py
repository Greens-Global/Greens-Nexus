"""
Unit tests for asana_sync.unlink_deleted_task.

Uses a throwaway sqlite file so it never touches the real dev DB
(greens_nexus.db) or Supabase. No network/Asana token needed.

Run with: python -m unittest test_asana_sync -v
"""
import os
import re
import tempfile
import time
import unittest

from sqlalchemy import text

# Must happen before `import database` - DATABASE_URL is read at module import
# time to build the engine.
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database
import models
from routers.task_util import gen_id, now_iso
import asana_sync


class UnlinkDeletedTaskTests(unittest.TestCase):
    """unlink_deleted_task with delete_sync OFF - the opt-out path, where an
    Asana deletion only severs the link and leaves the Nexus task in place.
    The delete_sync=ON behaviour lives in DeletePropagationTests."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.AsanaSyncConfig).delete()
        self.db.add(models.AsanaSyncConfig(id="singleton", enabled=True, token="tok", delete_sync=False))
        self.db.commit()

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


class InboundDedupeTests(unittest.TestCase):
    """The duplicate-import bug: one Asana task arriving twice in a pull, or a
    Nexus task that already exists, must never become a second Nexus task."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        # Duplicate links are by definition pre-index legacy data - dedupe_tasks
        # creates ux_asana_task_link_gid once it has cleaned them up, so a test
        # that seeds duplicates has to start from before that point.
        self.db.execute(text("DROP INDEX IF EXISTS ux_asana_task_link_gid"))
        self.db.query(models.AsanaTaskLink).delete()
        self.db.query(models.Task).delete()
        self.db.commit()
        self.counts = {"created": 0, "updated": 0, "comments": 0}

    def tearDown(self):
        self.db.close()

    def _asana_task(self, gid, name):
        return {"gid": gid, "name": name, "notes": "", "due_on": "", "completed": False}

    def _titled(self, title, **kw):
        kw.setdefault("created_at", now_iso())
        t = models.Task(id=gen_id(), title=title, **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def test_same_gid_twice_in_one_pull_makes_one_task(self):
        # Asana hands the same task back in the project list AND as a subtask;
        # the link written by the first visit is unflushed until _apply_inbound
        # flushes it, and autoflush=False means the second visit can't see it.
        at = self._asana_task("gid-dup", "Task from Asana")
        asana_sync._apply_inbound(self.db, at, "proj-1", self.counts)
        asana_sync._apply_inbound(self.db, at, "proj-1", self.counts)

        self.assertEqual(self.db.query(models.Task).filter_by(title="Task from Asana").count(), 1)
        self.assertEqual(self.db.query(models.AsanaTaskLink).filter_by(asana_gid="gid-dup").count(), 1)

    def test_adopts_an_existing_subtask_instead_of_duplicating_it(self):
        # A subtask is stored with project_id="" - scoping adoption by the
        # project (as the old query did) never matched one.
        parent = self._titled("Parent", project_id="proj-1")
        existing = self._titled("Sync Field Test Subtask", project_id="", parent_task_id=parent.id)

        tid = asana_sync._apply_inbound(self.db, self._asana_task("gid-sub", "Sync Field Test Subtask"),
                                        "proj-1", self.counts, parent_task_id=parent.id)

        self.assertEqual(tid, existing.id)
        self.assertEqual(self.db.query(models.Task).filter_by(title="Sync Field Test Subtask").count(), 1)

    def test_adoption_skips_past_an_already_linked_match(self):
        # Two same-titled tasks, the first already linked to another gid.
        # Taking .first() and giving up there is what created duplicates.
        linked = self._titled("Test 2 from Asana", project_id="proj-1")
        self.db.add(models.AsanaTaskLink(id=gen_id(), nexus_task_id=linked.id, asana_gid="gid-other"))
        free = self._titled("Test 2 from Asana", project_id="proj-1")
        self.db.commit()

        tid = asana_sync._apply_inbound(self.db, self._asana_task("gid-new", "Test 2 from Asana"),
                                        "proj-1", self.counts)

        self.assertEqual(tid, free.id)
        self.assertEqual(self.db.query(models.Task).filter_by(title="Test 2 from Asana").count(), 2)

    def test_dedupe_keeps_the_filed_task_not_an_older_orphan(self):
        # An orphan (no project, no parent) is invisible in every view. Plain
        # oldest-wins handed it the win and deleted the correctly filed row a
        # fresh import had just created - a re-imported project lost half its
        # tasks that way.
        orphan = self._titled("Task from Asana", project_id="", parent_task_id="",
                              created_at="2026-07-01T00:00:00+00:00")
        filed = self._titled("Task from Asana", project_id="proj-1",
                             created_at="2026-07-24T00:00:00+00:00")
        for t in (orphan, filed):
            self.db.add(models.AsanaTaskLink(id=gen_id(), nexus_task_id=t.id, asana_gid="gid-o"))
        self.db.commit()

        asana_sync.dedupe_tasks(self.db, apply=True)

        self.assertIsNotNone(self.db.get(models.Task, filed.id))
        self.assertIsNone(self.db.get(models.Task, orphan.id))

    def test_dedupe_merges_onto_the_oldest_and_moves_its_content(self):
        keep = self._titled("Dup", project_id="proj-1", created_at="2026-07-01T00:00:00+00:00")
        dup = self._titled("Dup", project_id="proj-1", created_at="2026-07-09T00:00:00+00:00")
        sub = self._titled("Child", project_id="", parent_task_id=dup.id)
        self.db.add(models.TaskComment(id=gen_id(), task_id=dup.id, body="from the duplicate",
                                       created_at=now_iso()))
        for t in (keep, dup):
            self.db.add(models.AsanaTaskLink(id=gen_id(), nexus_task_id=t.id, asana_gid="gid-merge"))
        self.db.commit()

        dry = asana_sync.dedupe_tasks(self.db, apply=False)
        self.assertEqual((dry["gids"], dry["merged"]), (1, 1))
        self.assertEqual(self.db.query(models.Task).filter_by(title="Dup").count(), 2)   # untouched

        asana_sync.dedupe_tasks(self.db, apply=True)

        self.assertIsNotNone(self.db.get(models.Task, keep.id))
        self.assertIsNone(self.db.get(models.Task, dup.id))
        self.assertEqual(self.db.get(models.Task, sub.id).parent_task_id, keep.id)
        self.assertEqual(self.db.query(models.TaskComment).filter_by(task_id=keep.id).count(), 1)
        self.assertEqual(self.db.query(models.AsanaTaskLink).filter_by(asana_gid="gid-merge").count(), 1)
        self.assertEqual(asana_sync.dedupe_tasks(self.db, apply=False)["merged"], 0)   # idempotent


class DeletePropagationTests(unittest.TestCase):
    """Deleting on either side deletes on the other (AsanaSyncConfig.delete_sync)."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for table in (models.AsanaTaskLink, models.Task, models.AsanaProjectMap, models.AsanaSyncConfig):
            self.db.query(table).delete()
        self.db.add(models.AsanaSyncConfig(id="singleton", enabled=True, token="tok", delete_sync=True))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _linked(self, title, gid, **kw):
        t = models.Task(id=gen_id(), title=title, created_at=now_iso(), **kw)
        self.db.add(t)
        self.db.flush()
        self.db.add(models.AsanaTaskLink(id=gen_id(), nexus_task_id=t.id, asana_gid=gid))
        self.db.commit()
        return t

    def test_asana_delete_removes_the_nexus_task_and_its_subtasks(self):
        parent = self._linked("Parent", "gid-p", project_id="proj-1")
        child = self._linked("Child", "gid-c", project_id="", parent_task_id=parent.id)

        self.assertTrue(asana_sync.unlink_deleted_task(self.db, "gid-p"))

        self.assertIsNone(self.db.get(models.Task, parent.id))
        self.assertIsNone(self.db.get(models.Task, child.id))
        self.assertEqual(self.db.query(models.AsanaTaskLink).count(), 0)

    def test_delete_sync_off_only_unlinks(self):
        cfg = asana_sync.get_config(self.db)
        cfg.delete_sync = False
        self.db.commit()
        t = self._linked("Keep me", "gid-k", project_id="proj-1")

        asana_sync.unlink_deleted_task(self.db, "gid-k")

        kept = self.db.get(models.Task, t.id)
        self.assertIsNotNone(kept)
        self.assertFalse(kept.synced_with_asana)
        self.assertEqual(self.db.query(models.AsanaTaskLink).count(), 0)

    def test_pull_reaper_deletes_only_gids_asana_confirms_are_gone(self):
        alive = self._linked("Still there", "gid-alive", project_id="proj-1")
        gone = self._linked("Deleted in Asana", "gid-gone", project_id="proj-1")
        moved = self._linked("Moved elsewhere", "gid-moved", project_id="proj-1")
        counts = {"deleted": 0}
        # Only gid-gone 404s. gid-moved wasn't in the walk either, but Asana
        # still has it - removed from the board is not deleted.
        original = asana_sync._asana_task_gone
        asana_sync._asana_task_gone = lambda cfg, gid: gid == "gid-gone"
        try:
            asana_sync._reap_deleted(self.db, asana_sync.get_config(self.db), "proj-1",
                                     {"gid-alive"}, counts)
        finally:
            asana_sync._asana_task_gone = original
        self.db.commit()

        self.assertEqual(counts["deleted"], 1)
        self.assertIsNone(self.db.get(models.Task, gone.id))
        self.assertIsNotNone(self.db.get(models.Task, alive.id))
        self.assertIsNotNone(self.db.get(models.Task, moved.id))

    def test_linked_gids_reads_the_rows_before_they_are_deleted(self):
        parent = self._linked("Parent", "gid-p", project_id="proj-1")
        child = self._linked("Child", "gid-c", project_id="", parent_task_id=parent.id)

        gids = asana_sync.linked_gids(self.db, [parent.id, child.id])

        self.assertEqual(sorted(gids), ["gid-c", "gid-p"])

    def test_outbound_delete_is_skipped_when_delete_sync_is_off(self):
        cfg = asana_sync.get_config(self.db)
        cfg.delete_sync = False
        self.db.commit()

        # Would raise on a real HTTP call - a False `done` proves it never got there.
        done, _err = asana_sync.push_task_deleted(self.db, "gid-x")
        self.assertFalse(done)

    def test_queued_deletion_survives_until_it_reaches_asana(self):
        # The whole point: on a laptop the fire-and-forget push never runs, and
        # by then the task and its link are gone, so without a tombstone the
        # deletion is unrecoverable.
        self.db.query(models.AsanaPendingDelete).delete()
        asana_sync.queue_task_delete(self.db, ["gid-1", "gid-2"], "Gone task", "T-9", "me@x.com")
        self.db.commit()
        self.assertEqual(self.db.query(models.AsanaPendingDelete).count(), 2)

        calls = []
        original = asana_sync.push_task_deleted
        asana_sync.push_task_deleted = lambda db, gid: (calls.append(gid), (False, "boom"))[1]
        try:
            out = asana_sync.drain_pending_deletes(self.db)
        finally:
            asana_sync.push_task_deleted = original

        # Asana refused; the rows must still be there for the next attempt.
        self.assertEqual(sorted(calls), ["gid-1", "gid-2"])
        self.assertEqual(out["deleted"], 0)
        self.assertEqual(self.db.query(models.AsanaPendingDelete).count(), 2)
        self.assertEqual({r.attempts for r in self.db.query(models.AsanaPendingDelete).all()}, {1})

    def test_drained_rows_are_removed_once_asana_confirms(self):
        self.db.query(models.AsanaPendingDelete).delete()
        asana_sync.queue_task_delete(self.db, ["gid-ok"], "T", "T-1", "me@x.com")
        self.db.commit()

        original = asana_sync.push_task_deleted
        asana_sync.push_task_deleted = lambda db, gid: (True, "")
        try:
            out = asana_sync.drain_pending_deletes(self.db)
        finally:
            asana_sync.push_task_deleted = original

        self.assertEqual((out["deleted"], out["pending"]), (1, 0))
        self.assertEqual(self.db.query(models.AsanaPendingDelete).count(), 0)

    def test_a_hopeless_row_is_dropped_instead_of_retrying_forever(self):
        self.db.query(models.AsanaPendingDelete).delete()
        asana_sync.queue_task_delete(self.db, ["gid-bad"], "T", "T-1", "me@x.com")
        self.db.commit()

        original = asana_sync.push_task_deleted
        asana_sync.push_task_deleted = lambda db, gid: (False, "permission denied")
        try:
            for _ in range(asana_sync._MAX_DELETE_ATTEMPTS):
                asana_sync.drain_pending_deletes(self.db)
        finally:
            asana_sync.push_task_deleted = original

        self.assertEqual(self.db.query(models.AsanaPendingDelete).count(), 0)

    def test_queue_is_dropped_when_delete_sync_is_turned_off(self):
        self.db.query(models.AsanaPendingDelete).delete()
        asana_sync.queue_task_delete(self.db, ["gid-z"], "T", "T-1", "me@x.com")
        cfg = asana_sync.get_config(self.db)
        cfg.delete_sync = False
        self.db.commit()

        asana_sync.drain_pending_deletes(self.db)

        # Holding tombstones would fire them if someone re-enabled the toggle.
        self.assertEqual(self.db.query(models.AsanaPendingDelete).count(), 0)


class PeopleResolutionTests(unittest.TestCase):
    """An Asana guest account is an M365 relay address
    (sagar.shoundik@greensg.onmicrosoft.com) that matches nobody in the People
    directory, so imported tasks showed a blank avatar. The local part has to
    resolve to the real Nexus person."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.NexusEmployee).delete()
        self.db.query(models.Task).delete()
        self.db.query(models.AsanaTaskLink).delete()
        self.db.add(models.NexusEmployee(id=gen_id(), first_name="Sagar", last_name="Shoundik",
                                         work_email="sagar.shoundik@greensglobal.com"))
        self.db.add(models.NexusEmployee(id=gen_id(), first_name="Neil", last_name="K",
                                         work_email="neil@greensglobal.com",
                                         personal_email="neil.personal@gmail.com"))
        self.db.commit()
        asana_sync.refresh_directory_cache()
        self.counts = {"created": 0, "updated": 0, "comments": 0, "activities": 0}

    def tearDown(self):
        # Leaving employees behind would silently change how OTHER test classes
        # resolve their fixture emails - the directory is global.
        self.db.query(models.NexusEmployee).delete()
        self.db.commit()
        asana_sync.refresh_directory_cache()
        self.db.close()

    def test_company_address_is_used_as_is(self):
        self.assertEqual(asana_sync._map_email("sagar.shoundik@greensglobal.com", None, self.db),
                         "sagar.shoundik@greensglobal.com")

    def test_onmicrosoft_relay_resolves_to_the_work_email(self):
        self.assertEqual(asana_sync._map_email("sagar.shoundik@greensg.onmicrosoft.com", None, self.db),
                         "sagar.shoundik@greensglobal.com")

    def test_personal_account_address_resolves_too(self):
        self.assertEqual(asana_sync._map_email("neil.personal@gmail.com", None, self.db),
                         "neil@greensglobal.com")

    def test_an_outsider_keeps_their_own_address(self):
        # Nobody in the directory - a real external collaborator must not be
        # silently rewritten onto some unrelated employee.
        self.assertEqual(asana_sync._map_email("someone@partner.com", None, self.db),
                         "someone@partner.com")

    def test_ambiguous_local_part_is_not_guessed(self):
        self.db.add(models.NexusEmployee(id=gen_id(), first_name="Sagar", last_name="Other",
                                         work_email="sagar.shoundik@greensstorage.com"))
        self.db.commit()
        asana_sync.refresh_directory_cache()

        self.assertEqual(asana_sync._map_email("sagar.shoundik@greensg.onmicrosoft.com", None, self.db),
                         "sagar.shoundik@greensg.onmicrosoft.com")

    def test_operator_map_still_wins(self):
        self.assertEqual(
            asana_sync._map_email("sagar.shoundik@greensg.onmicrosoft.com",
                                  {"sagar.shoundik@greensg.onmicrosoft.com": "override@greensglobal.com"},
                                  self.db),
            "override@greensglobal.com")

    def test_inbound_task_lands_on_the_real_person(self):
        at = {"gid": "g1", "name": "Guest assigned", "notes": "", "completed": False,
              "assignee": {"email": "sagar.shoundik@greensg.onmicrosoft.com"},
              "followers": [{"email": "sagar.shoundik@greensg.onmicrosoft.com"},
                            {"email": "neil@greensglobal.com"}],
              "memberships": [], "dependencies": [], "dependents": [], "tags": [], "custom_fields": []}

        tid = asana_sync._apply_inbound(self.db, at, "proj-1", self.counts)

        t = self.db.get(models.Task, tid)
        self.assertEqual(t.assignee_email, "sagar.shoundik@greensglobal.com")
        self.assertEqual(t.follower_emails,
                         ["neil@greensglobal.com", "sagar.shoundik@greensglobal.com"])

    def test_normalize_people_backfills_rows_written_earlier(self):
        t = models.Task(id=gen_id(), title="Old row", created_at=now_iso(),
                        assignee_email="sagar.shoundik@greensg.onmicrosoft.com",
                        follower_emails=["sagar.shoundik@greensg.onmicrosoft.com",
                                         "outsider@partner.com"])
        self.db.add(t)
        self.db.commit()

        self.assertGreater(asana_sync.normalize_people(self.db, apply=False), 0)
        self.db.refresh(t)
        self.assertEqual(t.assignee_email, "sagar.shoundik@greensg.onmicrosoft.com")   # dry run

        asana_sync.normalize_people(self.db, apply=True)
        self.db.commit()

        self.assertEqual(t.assignee_email, "sagar.shoundik@greensglobal.com")
        self.assertEqual(t.follower_emails,
                         ["outsider@partner.com", "sagar.shoundik@greensglobal.com"])


class _FakeAsana:
    """Minimal stand-in for the Asana read API - enough for the inbound engine.
    Populated per-test via the class attributes."""
    tasks, subtasks, stories, attachments = {}, {}, {}, {}

    def __init__(self, token=None):
        pass

    def get(self, path, **params):
        p = path.strip("/").split("/")
        if path.endswith("/subtasks"):
            return [self.tasks[g] for g in self.subtasks.get(p[1], []) if g in self.tasks]
        if path.endswith("/stories"):
            return list(self.stories.get(p[1], []))
        if path.endswith("/attachments"):
            return list(self.attachments.get(p[1], []))
        return []

    @classmethod
    def reset(cls):
        cls.tasks, cls.subtasks, cls.stories, cls.attachments = {}, {}, {}, {}


class FullFidelityInboundTests(unittest.TestCase):
    """Everything an Asana task carries has to land in Nexus, and a pull that
    changes nothing must converge instead of re-applying forever."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for table in (models.AsanaTaskLink, models.AsanaCommentLink, models.AsanaActivityLink,
                      models.AsanaAttachmentLink, models.TaskComment, models.TaskActivity,
                      models.TaskAttachment, models.TaskSection, models.Task,
                      models.AsanaSyncConfig):
            self.db.query(table).delete()
        self.db.add(models.AsanaSyncConfig(id="singleton", enabled=True, token="tok"))
        self.db.commit()
        self.counts = {"created": 0, "updated": 0, "comments": 0, "activities": 0,
                       "attachments": 0, "deleted": 0}
        _FakeAsana.reset()

    def tearDown(self):
        self.db.close()

    def _task(self, gid, name, **kw):
        base = {"gid": gid, "name": name, "notes": "", "completed": False,
                "memberships": [], "dependencies": [], "dependents": [],
                "tags": [], "followers": [], "custom_fields": []}
        base.update(kw)
        return base

    def test_section_priority_status_and_milestone_all_land(self):
        at = self._task("g1", "Rich task", notes="body", start_on="2026-08-01", due_on="2026-08-08",
                        assignee={"email": "a@b.com"},
                        custom_fields=[{"name": "Task Progress", "enum_value": {"name": "In progress"}},
                                       {"name": "Priority", "enum_value": {"name": "High"}}],
                        tags=[{"name": "backend"}], followers=[{"email": "n@b.com"}],
                        memberships=[{"section": {"name": "Doing"}}])

        tid = asana_sync._apply_inbound(self.db, at, "proj-1", self.counts)

        t = self.db.get(models.Task, tid)
        sec = self.db.query(models.TaskSection).filter_by(id=t.section_id).first()
        self.assertEqual((t.status, t.priority), ("in_progress", "high"))
        self.assertEqual((t.start_on, t.due_on), ("2026-08-01", "2026-08-08"))
        self.assertEqual(t.assignee_email, "a@b.com")
        self.assertEqual(t.tags, ["backend"])
        self.assertEqual(t.follower_emails, ["n@b.com"])
        self.assertEqual(sec.name, "Doing")

    def test_unchanged_task_is_not_reapplied_on_every_pull(self):
        at = self._task("g1", "Stable", custom_fields=[])
        asana_sync._apply_inbound(self.db, at, "proj-1", self.counts)
        self.counts["updated"] = 0

        for _ in range(3):
            asana_sync._apply_inbound(self.db, at, "proj-1", self.counts)

        # Nothing changed in Asana, so nothing should be re-applied - otherwise
        # the 5-minute poll logs an activity per task per poll, forever.
        self.assertEqual(self.counts["updated"], 0)

    def test_a_real_asana_change_is_still_applied(self):
        at = self._task("g1", "Before")
        tid = asana_sync._apply_inbound(self.db, at, "proj-1", self.counts)
        asana_sync._apply_inbound(self.db, at, "proj-1", self.counts)

        asana_sync._apply_inbound(self.db, self._task("g1", "After"), "proj-1", self.counts)

        self.assertEqual(self.db.get(models.Task, tid).title, "After")

    def test_system_stories_become_activity_and_comments_become_comments(self):
        tid = asana_sync._apply_inbound(self.db, self._task("g1", "T"), "proj-1", self.counts)
        _FakeAsana.stories["g1"] = [
            {"gid": "s1", "type": "comment", "text": "hello", "created_at": "2026-07-02T10:00:00Z",
             "created_by": {"name": "Sagar", "email": "s@b.com"}},
            {"gid": "s2", "type": "system", "resource_subtype": "due_date_changed",
             "text": "changed the due date", "created_at": "2026-07-03T10:00:00Z",
             "created_by": {"name": "Sagar", "email": "s@b.com"}},
        ]

        asana_sync._pull_stories(self.db, _FakeAsana(), "g1", tid, self.counts)
        asana_sync._pull_stories(self.db, _FakeAsana(), "g1", tid, self.counts)   # replay is free

        self.assertEqual(self.db.query(models.TaskComment).filter_by(task_id=tid).count(), 1)
        act = self.db.query(models.TaskActivity).filter_by(type="asana_due_date_changed").all()
        self.assertEqual(len(act), 1)
        self.assertEqual(act[0].at, "2026-07-03T10:00:00Z")   # Asana's timestamp, not now()
        self.assertEqual(self.counts["comments"], 1)
        self.assertEqual(self.counts["activities"], 1)

    def test_dependencies_resolve_regardless_of_walk_order(self):
        # The blocker is visited AFTER the task it blocks - inline resolution
        # can't see it, so only the deferred pass can wire this up.
        blocked = self._task("g1", "Blocked", dependencies=[{"gid": "g2"}])
        blocker = self._task("g2", "Blocker", dependents=[{"gid": "g1"}])
        deferred = []
        a = _FakeAsana()
        asana_sync._pull_task_tree(self.db, a, blocked, "proj-1", "", self.counts, set(), None, deferred)
        asana_sync._pull_task_tree(self.db, a, blocker, "proj-1", "", self.counts, set(), None, deferred)
        self.assertEqual(self.db.query(models.Task).filter_by(title="Blocked").first().blocked_by_ids, [])

        asana_sync.resolve_dependencies(self.db, deferred)

        blocked_row = self.db.query(models.Task).filter_by(title="Blocked").first()
        blocker_row = self.db.query(models.Task).filter_by(title="Blocker").first()
        self.assertEqual(blocked_row.blocked_by_ids, [blocker_row.id])
        self.assertEqual(blocked_row.dependency_types, {blocker_row.id: "FS"})

    def test_email_map_rewrites_assignee_and_followers(self):
        at = self._task("g1", "Guest task", assignee={"email": "guest@x.onmicrosoft.com"},
                        followers=[{"email": "guest@x.onmicrosoft.com"}])

        tid = asana_sync._apply_inbound(self.db, at, "proj-1", self.counts,
                                        email_map={"guest@x.onmicrosoft.com": "real@greensglobal.com"})

        t = self.db.get(models.Task, tid)
        self.assertEqual(t.assignee_email, "real@greensglobal.com")
        self.assertEqual(t.follower_emails, ["real@greensglobal.com"])


class PurgeProjectSyncTests(unittest.TestCase):
    """purge_project_sync + sweep_orphans - the "delete it and import it again"
    path. The property that matters most is the one that isn't obvious: purging
    must leave Asana completely alone, because the whole point is to re-import
    from a project that has to survive."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.AsanaTaskLink, models.AsanaProjectMap, models.AsanaPendingDelete,
                  models.Task, models.TaskProject, models.AsanaSyncConfig):
            self.db.query(m).delete()
        self.db.add(models.AsanaSyncConfig(id="singleton", enabled=True, token="tok",
                                           delete_sync=True))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _project(self, pid="proj-1", gid="A-1", with_map=True):
        self.db.add(models.TaskProject(id=pid, name=f"Project {pid}"))
        if with_map:
            self.db.add(models.AsanaProjectMap(id=gen_id(), nexus_project_id=pid,
                                               asana_project_gid=gid, created_at=now_iso()))
        self.db.commit()
        return pid

    def _task(self, pid, gid, parent=""):
        t = models.Task(id=gen_id(), title=f"Task {gid}", project_id=pid, parent_task_id=parent)
        self.db.add(t)
        self.db.flush()
        self.db.add(models.AsanaTaskLink(id=gen_id(), nexus_task_id=t.id, asana_gid=gid,
                                         last_hash="x", last_synced_at=now_iso()))
        self.db.commit()
        return t.id

    def test_purge_removes_tasks_links_and_the_mapping(self):
        pid = self._project()
        tid = self._task(pid, "g1")

        out = asana_sync.purge_project_sync(self.db, pid, actor="me@x.com")
        self.db.commit()

        self.assertEqual(out["tasks"], 1)
        self.assertEqual(out["maps"], 1)
        self.assertIsNone(self.db.get(models.Task, tid))
        self.assertIsNone(self.db.query(models.AsanaTaskLink).filter_by(asana_gid="g1").first())
        self.assertIsNone(self.db.query(models.AsanaProjectMap)
                          .filter_by(nexus_project_id=pid).first())

    def test_purge_takes_subtasks_with_their_parent(self):
        pid = self._project()
        parent = self._task(pid, "g1")
        self._task("", "g2", parent=parent)          # subtask: no project of its own

        asana_sync.purge_project_sync(self.db, pid)
        self.db.commit()

        self.assertEqual(self.db.query(models.Task).count(), 0)
        self.assertEqual(self.db.query(models.AsanaTaskLink).count(), 0)

    def test_purge_never_queues_an_asana_deletion(self):
        """The safety property: delete_sync is ON here, and purging still must
        not owe Asana a single deletion - the Asana project has to survive to be
        re-imported."""
        pid = self._project()
        self._task(pid, "g1")

        asana_sync.purge_project_sync(self.db, pid)
        self.db.commit()

        self.assertEqual(self.db.query(models.AsanaPendingDelete).count(), 0)

    def test_purge_leaves_other_projects_alone(self):
        keep = self._project("proj-keep", "A-keep")
        keep_task = self._task(keep, "g-keep")
        drop = self._project("proj-drop", "A-drop")
        self._task(drop, "g-drop")

        asana_sync.purge_project_sync(self.db, drop)
        self.db.commit()

        self.assertIsNotNone(self.db.get(models.Task, keep_task))
        self.assertIsNotNone(self.db.query(models.AsanaProjectMap)
                             .filter_by(nexus_project_id=keep).first())

    def test_purged_project_can_be_imported_again(self):
        """The regression this whole change exists for: after a purge, the same
        Asana gid must create a NEW task in a NEW project - before, the surviving
        link made _apply_inbound update the old orphan and leave the new project
        empty."""
        pid = self._project()
        self._task(pid, "g1")
        asana_sync.purge_project_sync(self.db, pid)
        self.db.commit()

        counts = {"created": 0, "updated": 0, "comments": 0, "activities": 0,
                  "attachments": 0, "deleted": 0}
        new_id = asana_sync._apply_inbound(
            self.db, {"gid": "g1", "name": "Task g1", "notes": ""}, "proj-2", counts)

        self.assertIsNotNone(new_id)
        self.assertEqual(counts["created"], 1)
        self.assertEqual(self.db.get(models.Task, new_id).project_id, "proj-2")

    def test_sweep_reports_then_clears_stranded_rows(self):
        # dead link: task row gone, link left behind
        self.db.add(models.AsanaTaskLink(id=gen_id(), nexus_task_id="ghost", asana_gid="g-dead",
                                         last_hash="x", last_synced_at=now_iso()))
        # orphan task: top-level, no project, still linked (old delete_project)
        self._task("", "g-orphan")
        # dangling map: no such project
        self.db.add(models.AsanaProjectMap(id=gen_id(), nexus_project_id="gone",
                                           asana_project_gid="A-gone", created_at=now_iso()))
        self.db.commit()

        dry = asana_sync.sweep_orphans(self.db, apply=False)
        self.assertEqual((dry["deadLinks"], dry["orphanTasks"], dry["danglingMaps"]), (1, 1, 1))
        self.assertEqual(self.db.query(models.AsanaTaskLink).count(), 2)   # dry run changed nothing

        asana_sync.sweep_orphans(self.db, apply=True)

        self.assertEqual(self.db.query(models.AsanaTaskLink).count(), 0)
        self.assertEqual(self.db.query(models.AsanaProjectMap).count(), 0)
        self.assertEqual(self.db.query(models.Task).count(), 0)

    def test_sweep_spares_a_project_less_task_that_was_never_synced(self):
        """A hand-made personal task has no Asana link, so it must never be read
        as the wreckage of a deleted project."""
        self.db.add(models.Task(id="mine", title="Personal", project_id="", parent_task_id=""))
        self.db.commit()

        out = asana_sync.sweep_orphans(self.db, apply=True)

        self.assertEqual(out["orphanTasks"], 0)
        self.assertIsNotNone(self.db.get(models.Task, "mine"))

    def test_sweep_spares_live_links_and_maps(self):
        pid = self._project()
        tid = self._task(pid, "g1")

        out = asana_sync.sweep_orphans(self.db, apply=True)

        self.assertEqual((out["deadLinks"], out["orphanTasks"], out["danglingMaps"]), (0, 0, 0))
        self.assertIsNotNone(self.db.get(models.Task, tid))
        self.assertEqual(self.db.query(models.AsanaProjectMap).count(), 1)


class SharedTeamTests(unittest.TestCase):
    """_ensure_team with a team shared across projects. One Asana team = ONE
    Nexus team, however many projects it works on - the duplicate "Development"
    and "IT" cards came from creating a fresh row per project."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.TaskTeam).delete()
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_same_team_on_a_second_project_extends_the_existing_row(self):
        first = asana_sync._ensure_team(self.db, "proj-1", "Development")
        second = asana_sync._ensure_team(self.db, "proj-2", "Development")

        self.assertEqual(first.id, second.id)
        self.assertEqual(self.db.query(models.TaskTeam).count(), 1)
        self.assertEqual(second.project_ids, ["proj-1", "proj-2"])

    def test_repeat_pull_of_the_same_project_does_not_duplicate_the_project(self):
        asana_sync._ensure_team(self.db, "proj-1", "IT")
        team = asana_sync._ensure_team(self.db, "proj-1", "IT")

        self.assertEqual(team.project_ids, ["proj-1"])

    def test_matching_ignores_case_and_padding(self):
        first = asana_sync._ensure_team(self.db, "proj-1", "IT")
        second = asana_sync._ensure_team(self.db, "proj-2", "  it  ")

        self.assertEqual(first.id, second.id)

    def test_adopts_a_hand_made_team_of_the_same_name(self):
        """A team someone created in Nexus before running sync is extended, not
        shadowed by a second card with the same name."""
        mine = models.TaskTeam(id="mine", name="IT", project_ids=["proj-9"],
                               project_id="proj-9", member_emails=["a@x.com"])
        self.db.add(mine)
        self.db.commit()

        got = asana_sync._ensure_team(self.db, "proj-1", "IT")

        self.assertEqual(got.id, "mine")
        self.assertEqual(got.project_ids, ["proj-9", "proj-1"])
        self.assertEqual(got.member_emails, ["a@x.com"])   # roster untouched

    def test_legacy_row_with_only_the_old_column_is_extended_not_duplicated(self):
        """A row written before project_ids existed carries only project_id;
        team_project_ids falls back to it so the pull extends that row."""
        legacy = models.TaskTeam(id="legacy", name="Development", project_id="proj-old",
                                 project_ids=[], member_emails=[])
        self.db.add(legacy)
        self.db.commit()

        got = asana_sync._ensure_team(self.db, "proj-new", "Development")

        self.assertEqual(got.id, "legacy")
        self.assertEqual(got.project_ids, ["proj-old", "proj-new"])

    def test_legacy_mirror_tracks_the_first_project(self):
        team = asana_sync._ensure_team(self.db, "proj-1", "QA")
        asana_sync._ensure_team(self.db, "proj-2", "QA")

        self.assertEqual(team.project_id, "proj-1")


class ProjectAccessTests(unittest.TestCase):
    """_sync_project_access reading GET /memberships?parent={project}.

    The shape here is the real one, captured live: `member` is a union tagged by
    resource_type, so a team shared into a project arrives alongside the users.
    A previous note in the module asserted no such route existed and shipped a
    manual "name the team yourself" field instead - these tests pin the shape
    that disproved it, so a refactor can't quietly fall back to
    /projects/{gid}/project_memberships, which returns users only."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskTeam, models.TaskProject, models.AsanaSyncConfig):
            self.db.query(m).delete()
        self.db.add(models.AsanaSyncConfig(id="singleton", enabled=True, token="tok",
                                           workspace_gid=""))
        self.db.add(models.TaskProject(id="p1", name="Shared Project", member_emails=[]))
        self.db.commit()
        self.cfg = asana_sync.get_config(self.db)

    def tearDown(self):
        self.db.close()

    def _asana(self, memberships, team_users=("dev@greensglobal.com",)):
        outer = self

        class FakeAsana:
            def get(self, path, **kw):
                if path == "/memberships":
                    return memberships
                if path.startswith("/teams/") and path.endswith("/users"):
                    return [{"email": e} for e in team_users]
                if path.startswith("/projects/"):
                    return {"name": "Shared Project", "notes": "", "team": None}
                return []
        del outer
        return FakeAsana()

    TEAM_ROW = {"access_level": "editor",
                "member": {"gid": "T1", "resource_type": "team", "name": "IT"}}
    USER_ROW = {"access_level": "admin",
                "member": {"gid": "U1", "resource_type": "user",
                           "name": "Sagar", "email": "sagar@greensglobal.com"}}

    def test_ad_hoc_shared_team_is_detected_without_any_manual_config(self):
        rep = []
        asana_sync._sync_project_access(self.db, self._asana([self.TEAM_ROW]), self.cfg,
                                        "A1", "p1", extra_team_names=[], report=rep)

        team = self.db.query(models.TaskTeam).filter_by(name="IT").first()
        self.assertIsNotNone(team, "team shared via Asana's Share dialog must sync on its own")
        self.assertEqual(team.member_emails, ["dev@greensglobal.com"])
        self.assertIn("p1", team.project_ids)
        self.assertTrue(any("granted from Asana's sharing list" in l for l in rep))

    def test_asana_access_level_becomes_the_nexus_role(self):
        asana_sync._sync_project_access(self.db, self._asana([self.TEAM_ROW]), self.cfg,
                                        "A1", "p1", report=[])
        self.assertEqual(self.db.query(models.TaskTeam).filter_by(name="IT").first().access_role, "editor")

        admin_row = {**self.TEAM_ROW, "access_level": "admin"}
        asana_sync._sync_project_access(self.db, self._asana([admin_row]), self.cfg,
                                        "A1", "p1", report=[])
        self.assertEqual(self.db.query(models.TaskTeam).filter_by(name="IT").first().access_role, "owner")

    def test_users_in_the_same_response_still_reach_project_members(self):
        asana_sync._sync_project_access(self.db, self._asana([self.USER_ROW, self.TEAM_ROW]),
                                        self.cfg, "A1", "p1", report=[])

        project = self.db.get(models.TaskProject, "p1")
        self.assertIn("sagar@greensglobal.com", project.member_emails or [])

    def test_a_team_with_no_resolvable_members_is_reported_not_silently_skipped(self):
        rep = []
        asana_sync._sync_project_access(self.db, self._asana([self.TEAM_ROW], team_users=()),
                                        self.cfg, "A1", "p1", report=rep)

        self.assertIsNone(self.db.query(models.TaskTeam).filter_by(name="IT").first())
        self.assertTrue(any("returned no members" in l for l in rep))

    def test_same_team_shared_into_two_projects_stays_one_team(self):
        self.db.add(models.TaskProject(id="p2", name="Second", member_emails=[]))
        self.db.commit()
        asana_sync._sync_project_access(self.db, self._asana([self.TEAM_ROW]), self.cfg,
                                        "A1", "p1", report=[])
        asana_sync._sync_project_access(self.db, self._asana([self.TEAM_ROW]), self.cfg,
                                        "A2", "p2", report=[])

        teams = self.db.query(models.TaskTeam).filter_by(name="IT").all()
        self.assertEqual(len(teams), 1)
        self.assertEqual(teams[0].project_ids, ["p1", "p2"])


class RichDescriptionTests(unittest.TestCase):
    """Descriptions are HTML now (tasks/RichDescription.jsx). Asana carries them
    on html_notes, which only accepts a fixed tag subset inside <body> and
    rejects the WHOLE task update when it disagrees - so the sanitizer's job is
    to never emit anything outside that set."""

    def test_supported_formatting_survives_the_round_trip(self):
        html = ('<p>Fix the <strong>login</strong> bug</p>'
                '<ul><li>Check <code>auth.py</code></li>'
                '<li><a href="https://x.com">ticket</a></li></ul>')
        out = asana_sync._to_asana_html(html)

        self.assertTrue(out.startswith("<body>") and out.endswith("</body>"))
        for fragment in ("<strong>", "<code>", "<ul>", "<li>", '<a href="https://x.com">'):
            self.assertIn(fragment, out)
        # …and comes back as usable HTML on the next pull.
        self.assertEqual(asana_sync._from_asana_html({"html_notes": out}),
                         out[len("<body>"):-len("</body>")])

    def test_unsupported_tags_are_dropped_but_their_text_is_kept(self):
        # <mark> and <img> have no html_notes equivalent. Losing the highlight is
        # acceptable; losing the words would not be.
        out = asana_sync._to_asana_html('<p><mark>urgent</mark></p><p><img src="data:image/png;base64,AA"></p>')

        self.assertIn("urgent", out)
        self.assertNotIn("<mark", out)
        self.assertNotIn("<img", out)

    def test_script_and_style_contents_never_reach_asana(self):
        out = asana_sync._to_asana_html('<p>hi</p><script>evil()</script><style>b{}</style>')

        self.assertIn("hi", out)
        self.assertNotIn("evil()", out)
        self.assertNotIn("b{}", out)

    def test_only_whitelisted_tags_are_emitted(self):
        out = asana_sync._to_asana_html(
            '<p>a</p><table><tr><td>c</td></tr></table><h3>d</h3><span class="x">e</span>')

        emitted = {t.lower() for t in re.findall(r"</?([a-zA-Z0-9]+)", out)}
        self.assertTrue(emitted <= asana_sync._ASANA_HTML_TAGS | {"body"}, emitted)
        for text in ("a", "c", "d", "e"):
            self.assertIn(text, out)

    def test_paragraph_after_a_list_is_not_glued_to_it(self):
        out = asana_sync._to_asana_html('<ul><li>one</li></ul><p>after</p>')

        self.assertNotIn("</ul>after", out)

    def test_empty_description_produces_no_html_notes(self):
        for empty in ("", None, "<p></p>", "   "):
            self.assertEqual(asana_sync._to_asana_html(empty), "")

    def test_plain_asana_notes_are_escaped_not_rendered_as_markup(self):
        """A task written in Asana's plain editor must not turn into live markup
        in the Nexus editor - and must not lose its line breaks either."""
        got = asana_sync._from_asana_html({"notes": "1 < 2 & 3\nsecond line"})

        self.assertIn("&lt;", got)
        self.assertIn("&amp;", got)
        self.assertEqual(got.count("<p>"), 2)

    def test_html_notes_wins_over_notes_when_both_are_present(self):
        got = asana_sync._from_asana_html({"html_notes": "<body><b>rich</b></body>",
                                           "notes": "rich"})
        self.assertEqual(got, "<b>rich</b>")

    def test_html_to_text_is_the_plain_fallback(self):
        self.assertEqual(asana_sync._html_to_text("<p>a</p><ul><li>b</li></ul>"), "a\n\nb")
        self.assertEqual(asana_sync._html_to_text("<p>1 &lt; 2</p>"), "1 < 2")


class MentionSyncTests(unittest.TestCase):
    """@mentions cross the boundary as REAL mentions, so the person is notified
    in whichever tool they're reading.

    The address shapes differ on each side - an Asana guest account is
    person@greensg.onmicrosoft.com while Nexus stores person@greensglobal.com -
    so both directions have to resolve through the local part, the same rule
    _user_map / _map_email already use for assignees."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.NexusEmployee).delete()
        self.db.add(models.NexusEmployee(id="e1", first_name="Sagar", last_name="Shoundik",
                                         work_email="sagar.shoundik@greensglobal.com", status="active"))
        self.db.commit()
        self.cfg = type("Cfg", (), {"token": "t", "workspace_gid": "W1"})()
        asana_sync._USER_CACHE[("t", "W1")] = (time.time(), {
            "sagar.shoundik@greensg.onmicrosoft.com": "111", "sagar.shoundik": "111",
            "neil@greensglobal.com": "222", "neil": "222",
        })
        asana_sync._USER_GID_CACHE[("t", "W1")] = (time.time(), {
            "111": {"email": "sagar.shoundik@greensg.onmicrosoft.com", "name": "Sagar Shoundik"},
            "222": {"email": "neil@greensglobal.com", "name": "Neil"},
        })

    def tearDown(self):
        self.db.close()

    def test_outbound_guest_relay_address_resolves_to_a_real_mention(self):
        """Nexus knows them as @greensglobal.com; their Asana account is the
        @greensg.onmicrosoft.com relay. Matching on the local part is what makes
        the mention land."""
        out = asana_sync._to_asana_html(
            '<p><a href="mailto:sagar.shoundik@greensglobal.com">@Sagar</a></p>', self.cfg)

        self.assertIn('<a data-asana-gid="111"/>', out)
        self.assertNotIn("mailto:", out)

    def test_outbound_direct_address_also_resolves(self):
        out = asana_sync._to_asana_html('<p><a href="mailto:neil@greensglobal.com">@Neil</a></p>', self.cfg)
        self.assertIn('<a data-asana-gid="222"/>', out)

    def test_an_unresolvable_mention_stays_a_working_link(self):
        """Someone with no Asana account must not vanish from the text."""
        out = asana_sync._to_asana_html('<p><a href="mailto:ghost@x.com">@Ghost</a></p>', self.cfg)

        self.assertIn("mailto:ghost@x.com", out)
        self.assertIn("@Ghost", out)

    def test_ordinary_links_are_untouched(self):
        out = asana_sync._to_asana_html('<p><a href="https://ex.com">docs</a></p>', self.cfg)
        self.assertIn('<a href="https://ex.com">', out)
        self.assertNotIn("data-asana-gid", out)

    def test_without_cfg_mentions_stay_as_mailto(self):
        """Callers that have no config (tests, plain conversion) still get valid
        output rather than a crash."""
        out = asana_sync._to_asana_html('<p><a href="mailto:neil@greensglobal.com">@Neil</a></p>')
        self.assertIn("mailto:neil@greensglobal.com", out)

    def test_inbound_asana_mention_becomes_the_nexus_address(self):
        html = asana_sync._from_asana_html(
            {"html_notes": '<body><a data-asana-gid="111">@Sagar Shoundik</a></body>'})

        got = asana_sync._mentions_from_asana(html, self.cfg, self.db)

        # the relay address is resolved through the directory to the real person
        self.assertIn("mailto:sagar.shoundik@greensglobal.com", got)
        self.assertNotIn("onmicrosoft", got)

    # Captured verbatim from a live story's html_text - the shape the code has
    # to survive, not the shape we assumed it would be.
    REAL_MENTION = ('<body><a href="https://app.asana.com/1/413144745704203/profile/1216124019080922" '
                    'data-asana-gid="111" data-asana-accessible="true" data-asana-type="user" '
                    'data-asana-dynamic="true">@Sagar Shoundik</a> check this on Nexus</body>')
    REAL_ATTACHMENT = ('<body>see <a href="https://app.asana.com/app/asana/-/get_asset?asset_id=1209531256484731" '
                       'data-asana-gid="1209531256484731" data-asana-accessible="true" '
                       'data-asana-type="attachment" data-asana-dynamic="true">image.png</a></body>')

    def test_inbound_real_asana_mention_markup(self):
        got = asana_sync._mentions_from_asana(
            asana_sync._from_asana_html({"html_notes": self.REAL_MENTION}), self.cfg, self.db)

        self.assertIn('href="mailto:sagar.shoundik@greensglobal.com"', got)
        self.assertIn("check this on Nexus", got)
        self.assertNotIn("app.asana.com", got)

    def test_an_attachment_link_is_not_a_mention(self):
        """Attachments carry data-asana-gid in the same anchor shape. Matching
        on that attribute alone turned every inline image into a mention of a
        gid that isn't a user."""
        got = asana_sync._mentions_from_asana(
            asana_sync._from_asana_html({"html_notes": self.REAL_ATTACHMENT}), self.cfg, self.db)

        self.assertIn("get_asset?asset_id=1209531256484731", got)
        self.assertNotIn("mailto:", got)

    def test_outbound_does_not_turn_an_attachment_into_a_mention(self):
        """The mirror of the case above, on the way back out."""
        out = asana_sync._to_asana_html(self.REAL_ATTACHMENT, self.cfg)

        self.assertNotIn("data-asana-gid", out)
        self.assertIn("get_asset", out)

    def test_inbound_handles_asanas_self_closing_mention(self):
        """This is the shape Asana actually sends: no label, because it renders
        the name from the gid. Requiring a closing </a> matched only our own
        round-tripped form and let real mentions through untouched."""
        html = asana_sync._from_asana_html(
            {"html_notes": '<body>ping <a data-asana-gid="111"/> please</body>'})

        got = asana_sync._mentions_from_asana(html, self.cfg, self.db)

        self.assertIn("mailto:sagar.shoundik@greensglobal.com", got)
        self.assertIn("@Sagar Shoundik", got)   # name filled in from the gid
        self.assertNotIn("data-asana-gid", got)

    def test_inbound_unknown_gid_keeps_the_visible_name(self):
        html = asana_sync._from_asana_html({"html_notes": '<body>hi <a data-asana-gid="999">@Ghost</a></body>'})

        got = asana_sync._mentions_from_asana(html, self.cfg, self.db)

        self.assertIn("@Ghost", got)
        self.assertNotIn("data-asana-gid", got)

    def test_round_trip_is_stable(self):
        """Nexus -> Asana -> Nexus returns the same address, so a pull right
        after a push can't look like a change and start a re-apply loop."""
        original = '<p><a href="mailto:sagar.shoundik@greensglobal.com">@Sagar Shoundik</a></p>'
        to_asana = asana_sync._to_asana_html(original, self.cfg)
        back = asana_sync._mentions_from_asana(
            asana_sync._from_asana_html({"html_notes": to_asana}), self.cfg, self.db)

        self.assertIn("mailto:sagar.shoundik@greensglobal.com", back)


if __name__ == "__main__":
    unittest.main()


class IncrementalPullWindowTests(unittest.TestCase):
    """Which projects get a cheap incremental fetch and which get a full listing.

    The stakes are lopsided: an unnecessary full listing costs a few API calls,
    while an incremental run wrongly treated as complete would let _reap_deleted
    delete every task that simply wasn't modified. So every uncertain case has
    to resolve to 'full'."""

    def _map(self, last_pull_at="", last_full_pull_at=""):
        return models.AsanaProjectMap(id=gen_id(), nexus_project_id="p1",
                                      asana_project_gid="g1", last_pull_at=last_pull_at,
                                      last_full_pull_at=last_full_pull_at)

    @staticmethod
    def _ago(seconds):
        from datetime import datetime, timedelta, timezone
        return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()

    @staticmethod
    def _now():
        from datetime import datetime, timezone
        return datetime.now(timezone.utc)

    def test_a_project_never_pulled_gets_a_full_listing(self):
        since, is_full = asana_sync._pull_window(self._map(), self._now())

        self.assertTrue(is_full)
        self.assertEqual(since, "")

    def test_a_recently_swept_project_goes_incremental(self):
        pm = self._map(last_pull_at=self._ago(120), last_full_pull_at=self._ago(300))

        since, is_full = asana_sync._pull_window(pm, self._now())

        self.assertFalse(is_full)
        self.assertTrue(since)

    def test_the_cursor_is_rewound_so_a_mid_pull_edit_is_not_missed(self):
        """Re-applying a task we already have is free - the digests skip it -
        but an edit that lands between fetch and stamp would be lost forever."""
        from datetime import datetime
        pm = self._map(last_pull_at=self._ago(120), last_full_pull_at=self._ago(300))

        since, _ = asana_sync._pull_window(pm, self._now())

        cursor = datetime.fromisoformat(pm.last_pull_at)
        self.assertLess(datetime.fromisoformat(since), cursor)

    def test_a_stale_full_sweep_forces_a_full_listing_again(self):
        """Deletions are invisible to an incremental fetch, so the complete
        listing has to come back around."""
        pm = self._map(last_pull_at=self._ago(60),
                       last_full_pull_at=self._ago(asana_sync._FULL_SWEEP_MIN * 60 + 60))

        _, is_full = asana_sync._pull_window(pm, self._now())

        self.assertTrue(is_full)

    def test_an_unreadable_cursor_falls_back_to_full(self):
        pm = self._map(last_pull_at="not-a-date", last_full_pull_at="also-not")

        since, is_full = asana_sync._pull_window(pm, self._now())

        self.assertTrue(is_full)
        self.assertEqual(since, "")

    def test_a_cursor_without_a_full_sweep_recorded_falls_back_to_full(self):
        """Rows written before these columns existed have one but not the other."""
        _, is_full = asana_sync._pull_window(self._map(last_pull_at=self._ago(60)), self._now())

        self.assertTrue(is_full)
