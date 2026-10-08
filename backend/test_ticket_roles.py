"""
Ticket desk roles: requester / agent / supervisor, under the company's
deskAccess rule (ticket_roles.py).

  legacy   - today's rule, unchanged: any tasks OR tickets grant is on the
             desk with every desk power it had (a tasks-only viewer is still
             an agent who can delete, read internal notes, run the desk).
  explicit - only the tickets grant counts: viewer/editor = agent (works the
             queue, internal notes - no delete, no desk settings),
             full/owner = supervisor; a tasks-only grant is a requester.

Also pins the default: unset reads as legacy; the startup seed writes
legacy for a database that already has data and explicit for an empty one.

Uses a throwaway sqlite file. No network: BackgroundTasks are never run.
Run on its own: python -m pytest test_ticket_roles.py
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException

import cache
import database
import models
import ticket_roles as R
from routers.task_util import now_iso
from routers import tickets as T

REQUESTER = {"email": "requester@example.com", "level": 1}       # no grant at all
TASKS_VIEWER = {"email": "tasksonly@example.com", "level": 1}    # tasks:viewer only
TK_VIEWER = {"email": "tkviewer@example.com", "level": 1}        # tickets:viewer
TK_EDITOR = {"email": "tkeditor@example.com", "level": 1}        # tickets:editor
TK_FULL = {"email": "tkfull@example.com", "level": 1}            # tickets:full
MANAGER = {"email": "manager@example.com", "level": 3}           # manager role, no grant
ADMIN = {"email": "admin@example.com", "level": 4}               # administrator, no grant
GUEST = {"email": "guest@example.com", "level": 1, "external": True}  # tickets:full, but a guest

GROUPS = {
    "g-tasks": ("tasks:viewer", [TASKS_VIEWER["email"]]),
    "g-tkv": ("tickets:viewer", [TK_VIEWER["email"]]),
    "g-tke": ("tickets:editor", [TK_EDITOR["email"]]),
    "g-tkf": ("tickets:full", [TK_FULL["email"], GUEST["email"]]),
}

SECRET = "<p>Internal: vendor quote is 4k, do not share</p>"
PUBLIC = "<p>We are looking into it.</p>"


class TicketRoleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.TaskComment, models.TaskActivity, models.TicketTeamsMessage,
                  models.NexusNotification, models.TaskNotification, models.NexusGroup,
                  models.NexusGroupMember, models.NexusSetting, models.Task, models.NexusEmployee):
            self.db.query(m).delete()
        for gid, (mods, members) in GROUPS.items():
            self.db.add(models.NexusGroup(id=gid, name=gid, allowed_modules=mods))
            for e in members:
                self.db.add(models.NexusGroupMember(group_id=gid, email=e))
        self.db.add(models.TaskTicket(id="t1", code="000041", subject="Printer jam", status="open",
                                      priority="medium", requester_email=REQUESTER["email"],
                                      watcher_emails=[], created_at=now_iso(), modified_at=now_iso()))
        self.db.commit()
        self._reset_caches()

    def tearDown(self):
        self.db.close()

    @staticmethod
    def _reset_caches():
        cache.module_grants.invalidate()
        cache.settings_config.invalidate()

    def _mode(self, mode):
        R.set_desk_access_mode(self.db, mode, "test@example.com")

    def _allowed(self, dep, user):
        try:
            dep(user=user, db=self.db)
            return True
        except HTTPException as e:
            self.assertEqual(e.status_code, 403)
            return False

    def _comment(self, body, internal, user):
        return T.add_ticket_comment("t1", T.TicketCommentBody(body=body, internal=internal),
                                    BackgroundTasks(), user=user, db=self.db)

    def _queue(self, user):
        return [t["id"] for t in T.list_tickets(user=user, db=self.db)]

    # ── the default ──────────────────────────────────────────────────────────
    def test_unset_reads_as_legacy(self):
        self.assertEqual(R.desk_access_mode(self.db), R.LEGACY)

    def test_seed_pins_legacy_for_a_database_with_data(self):
        self.assertEqual(R.seed_desk_access_mode(self.db), R.LEGACY)
        self.assertEqual(R.desk_access_mode(self.db), R.LEGACY)

    def test_seed_pins_explicit_for_an_empty_database(self):
        for m in (models.TaskTicket, models.Task, models.NexusGroup, models.NexusGroupMember):
            self.db.query(m).delete()
        self.db.commit()
        self._reset_caches()
        self.assertEqual(R.seed_desk_access_mode(self.db), R.EXPLICIT)
        # ...and it stays explicit once the first ticket arrives.
        self.db.add(models.TaskTicket(id="t2", code="000042", subject="First", status="open",
                                      priority="medium", requester_email=REQUESTER["email"],
                                      created_at=now_iso(), modified_at=now_iso()))
        self.db.commit()
        self.assertIsNone(R.seed_desk_access_mode(self.db))
        self.assertEqual(R.desk_access_mode(self.db), R.EXPLICIT)

    def test_seed_never_overwrites_a_choice(self):
        self._mode(R.EXPLICIT)
        self.assertIsNone(R.seed_desk_access_mode(self.db))
        self.assertEqual(R.desk_access_mode(self.db), R.EXPLICIT)

    # ── legacy = today's behavior ────────────────────────────────────────────
    def test_legacy_tasks_only_viewer_is_a_full_desk_member(self):
        self._mode(R.LEGACY)
        self.assertTrue(R.can_work_queue(TASKS_VIEWER, self.db))
        self.assertTrue(R.can_read_internal(TASKS_VIEWER, self.db))
        # Before roles there was no agent/supervisor split - keep every power.
        self.assertTrue(R.can_delete(TASKS_VIEWER, self.db))
        self.assertTrue(self._allowed(T.require_ticket_supervisor, TASKS_VIEWER))
        self.assertIn("t1", self._queue(TASKS_VIEWER))

    def test_legacy_any_tickets_level_is_on_the_desk(self):
        self._mode(R.LEGACY)
        for u in (TK_VIEWER, TK_EDITOR, TK_FULL):
            self.assertTrue(R.can_delete(u, self.db), u["email"])

    def test_legacy_tasks_only_viewer_reads_internal_notes(self):
        self._mode(R.LEGACY)
        self._comment(SECRET, True, TK_FULL)
        bodies = [c["body"] for c in T.list_ticket_comments("t1", user=TASKS_VIEWER, db=self.db)]
        self.assertIn(SECRET, bodies)

    def test_legacy_no_grant_is_a_requester(self):
        self._mode(R.LEGACY)
        self.assertEqual(R.ticket_role(MANAGER, self.db), R.REQUESTER)
        self.assertFalse(self._allowed(T.require_ticket_desk, MANAGER))

    # ── explicit ─────────────────────────────────────────────────────────────
    def test_explicit_tasks_only_viewer_is_a_requester(self):
        self._mode(R.EXPLICIT)
        self.assertEqual(R.ticket_role(TASKS_VIEWER, self.db), R.REQUESTER)
        self.assertFalse(self._allowed(T.require_ticket_desk, TASKS_VIEWER))
        self.assertNotIn("t1", self._queue(TASKS_VIEWER))
        with self.assertRaises(HTTPException) as ctx:
            T.list_ticket_comments("t1", user=TASKS_VIEWER, db=self.db)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_explicit_tickets_viewer_and_editor_are_agents(self):
        self._mode(R.EXPLICIT)
        for u in (TK_VIEWER, TK_EDITOR):
            self.assertEqual(R.ticket_role(u, self.db), R.AGENT, u["email"])
            self.assertTrue(self._allowed(T.require_ticket_desk, u))
            self.assertIn("t1", self._queue(u))
            # Works the queue, but may not delete or run the desk.
            self.assertFalse(R.can_delete(u, self.db))
            self.assertFalse(R.can_manage_desk(u, self.db))
            self.assertFalse(self._allowed(T.require_ticket_supervisor, u))

    def test_explicit_agent_may_edit_triage_fields_on_someone_elses_ticket(self):
        self._mode(R.EXPLICIT)
        out = T.update_ticket("t1", T.TicketUpdate(priority="high"), BackgroundTasks(), user=TK_VIEWER, db=self.db)
        self.assertEqual(out["priority"], "high")
        with self.assertRaises(HTTPException):
            T.update_ticket("t1", T.TicketUpdate(priority="low"), BackgroundTasks(), user=TASKS_VIEWER, db=self.db)

    def test_explicit_tickets_full_is_a_supervisor(self):
        self._mode(R.EXPLICIT)
        self.assertEqual(R.ticket_role(TK_FULL, self.db), R.SUPERVISOR)
        self.assertTrue(R.can_delete(TK_FULL, self.db))
        self.assertTrue(R.can_manage_desk(TK_FULL, self.db))
        self.assertTrue(self._allowed(T.require_ticket_supervisor, TK_FULL))

    def test_explicit_admin_supervises_and_guest_never_does(self):
        self._mode(R.EXPLICIT)
        self.assertEqual(R.ticket_role(ADMIN, self.db), R.SUPERVISOR)
        self.assertEqual(R.ticket_role(GUEST, self.db), R.REQUESTER)

    def test_explicit_internal_notes_are_for_agents_and_up(self):
        self._mode(R.EXPLICIT)
        self._comment(PUBLIC, False, TK_FULL)
        self._comment(SECRET, True, TK_FULL)
        agent_bodies = [c["body"] for c in T.list_ticket_comments("t1", user=TK_VIEWER, db=self.db)]
        self.assertIn(SECRET, agent_bodies)
        req_bodies = [c["body"] for c in T.list_ticket_comments("t1", user=REQUESTER, db=self.db)]
        self.assertIn(PUBLIC, req_bodies)
        self.assertNotIn(SECRET, req_bodies)

    def test_explicit_a_requester_cannot_write_an_internal_note(self):
        self._mode(R.EXPLICIT)
        c = self._comment("<p>let me mark this internal</p>", True, REQUESTER)
        self.assertFalse(c["internal"])

    def test_explicit_desk_settings_need_a_supervisor(self):
        self._mode(R.EXPLICIT)
        with self.assertRaises(HTTPException) as ctx:
            T.put_ticket_taxonomy_settings({"slaTargetHours": {"low": 100}}, user=MANAGER, db=self.db)
        self.assertEqual(ctx.exception.status_code, 403)
        self._mode(R.LEGACY)
        out = T.put_ticket_taxonomy_settings({"slaTargetHours": {"low": 100}}, user=MANAGER, db=self.db)
        self.assertEqual(out["slaTargetHours"]["low"], 100)

    # ── what the screens are told ────────────────────────────────────────────
    def test_my_access_carries_the_role_and_capabilities(self):
        self._mode(R.EXPLICIT)
        a = T.my_ticket_access(user=TK_VIEWER, db=self.db)
        self.assertEqual((a["role"], a["deskAccess"]), (R.AGENT, R.EXPLICIT))
        self.assertTrue(a["canWorkQueue"] and a["canReadInternal"])
        self.assertFalse(a["canDelete"] or a["canManageDesk"])
        self.assertEqual(T.my_ticket_access(user=TASKS_VIEWER, db=self.db)["role"], R.REQUESTER)

    # ── the admin switch ─────────────────────────────────────────────────────
    def test_only_an_administrator_reads_or_changes_the_rule(self):
        for call in (lambda: T.get_desk_access(user=MANAGER, db=self.db),
                     lambda: T.put_desk_access(T.DeskAccessBody(deskAccess="explicit"), user=MANAGER, db=self.db)):
            with self.assertRaises(HTTPException) as ctx:
                call()
            self.assertEqual(ctx.exception.status_code, 403)

    def test_switch_preview_lists_who_would_lose_access(self):
        self._mode(R.LEGACY)
        out = T.get_desk_access(user=ADMIN, db=self.db)
        changes = {c["email"]: (c["from"], c["to"]) for c in out["explicitChanges"]}
        self.assertEqual(changes.get(TASKS_VIEWER["email"]), (R.SUPERVISOR, R.REQUESTER))
        self.assertEqual(changes.get(TK_VIEWER["email"]), (R.SUPERVISOR, R.AGENT))
        self.assertNotIn(TK_FULL["email"], changes)   # supervisor either way

    def test_admin_switches_the_rule_and_bad_values_are_refused(self):
        out = T.put_desk_access(T.DeskAccessBody(deskAccess="explicit"), user=ADMIN, db=self.db)
        self.assertEqual(out["deskAccess"], R.EXPLICIT)
        self.assertEqual(out["explicitChanges"], [])
        with self.assertRaises(HTTPException) as ctx:
            T.put_desk_access(T.DeskAccessBody(deskAccess="everyone"), user=ADMIN, db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
