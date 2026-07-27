"""
Unit tests for asana_sync.unlink_deleted_task.

Uses a throwaway sqlite file so it never touches the real dev DB
(greens_nexus.db) or Supabase. No network/Asana token needed.

Run with: python -m unittest test_asana_sync -v
"""
import os
import tempfile
import unittest

from sqlalchemy import text

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
    """unlink_deleted_task with delete_sync OFF — the opt-out path, where an
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
        # Duplicate links are by definition pre-index legacy data — dedupe_tasks
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
        # A subtask is stored with project_id="" — scoping adoption by the
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
        # fresh import had just created — a re-imported project lost half its
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
        # still has it — removed from the board is not deleted.
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

        # Would raise on a real HTTP call — a False `done` proves it never got there.
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
        # resolve their fixture emails — the directory is global.
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
        # Nobody in the directory — a real external collaborator must not be
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
    """Minimal stand-in for the Asana read API — enough for the inbound engine.
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

        # Nothing changed in Asana, so nothing should be re-applied — otherwise
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
        # The blocker is visited AFTER the task it blocks — inline resolution
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


if __name__ == "__main__":
    unittest.main()
