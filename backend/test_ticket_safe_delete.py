"""
Safe deletes for tickets (Oct 2026).

DELETE /task-tickets/{id} used to hard-delete the ticket together with its
conversation, attachment rows and its whole activity trail. It is now a soft
delete on the same pattern tasks use (deleted_at + the hook in database.py):
the ticket disappears from every list, its history stays, and it can be
restored. The comment / attachment / saved-view / component deletes, which
removed any row by id, now check who is asking.

Uses a throwaway sqlite file. No network. Run on its own:
    python -m pytest test_ticket_safe_delete.py
"""
import json
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException

import cache
import database
import models
from routers.task_util import gen_id, now_iso
from routers import tickets as T

CO_A, CO_B = "co-a", "co-b"
REQUESTER = {"email": "req@example.com", "level": 1}       # raised the ticket, no desk grant
AGENT     = {"email": "agent@example.com", "level": 1}     # company A desk agent
AGENT_2   = {"email": "agent2@example.com", "level": 1}    # another company A desk agent
OUTSIDER  = {"email": "agentb@example.com", "level": 1}    # company B desk agent
MANAGER   = {"email": "mgr@example.com", "level": 3}       # company A manager on the desk


class TicketSafeDeleteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.TaskComment, models.TaskAttachment, models.TaskActivity,
                  models.TaskSavedView, models.TaskTicketComponent, models.Task,
                  models.NexusGroup, models.NexusGroupMember, models.NexusEmployee, models.NexusSetting):
            self.db.query(m).execution_options(include_deleted=True).delete()
        self.db.add(models.NexusGroup(id="desk", name="Service Desk", allowed_modules="tickets:editor"))
        for who, co in ((REQUESTER, CO_A), (AGENT, CO_A), (AGENT_2, CO_A), (OUTSIDER, CO_B), (MANAGER, CO_A)):
            self.db.add(models.NexusEmployee(id=gen_id(), first_name="x", last_name="y",
                                             work_email=who["email"], status="active", company=co))
            if who in (AGENT, AGENT_2, OUTSIDER, MANAGER):
                self.db.add(models.NexusGroupMember(group_id="desk", email=who["email"]))
        # The company wall is armed, so another company's agent is walled off.
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()
        self.t = self._ticket("Printer is on fire")

    def tearDown(self):
        self.db.close()
        cache.settings_config.invalidate()

    # ── helpers ─────────────────────────────────────────────────────────────
    def _ticket(self, subject, company=CO_A):
        t = models.TaskTicket(id=gen_id(), code=T._next_ticket_code(self.db), subject=subject,
                              status="open", priority="medium", requester_email=REQUESTER["email"],
                              company_id=company, created_at=now_iso(), modified_at=now_iso())
        self.db.add(t)
        self.db.add(models.TaskActivity(id=gen_id(), entity_kind="ticket", entity_id=t.id,
                                        entity_code=t.code, entity_title=subject, type="created",
                                        actor_email=REQUESTER["email"], at=now_iso(), detail="{}"))
        self.db.commit()
        return t

    def _comment(self, author, internal=False, ticket=None):
        c = models.TaskComment(id=gen_id(), task_id=(ticket or self.t).id, author_email=author["email"],
                               body="the secret words", internal=internal, created_at=now_iso())
        self.db.add(c)
        self.db.commit()
        return c

    def _attachment(self, by):
        a = models.TaskAttachment(id=gen_id(), task_id=self.t.id, name="shot.png",
                                  url="https://x.supabase.co/storage/v1/object/public/ticket-evidence/a.png",
                                  added_at=now_iso(), added_by=by["email"])
        self.db.add(a)
        self.db.commit()
        return a

    def _activity_types(self, ticket_id):
        return [a.type for a in self.db.query(models.TaskActivity)
                .filter(models.TaskActivity.entity_kind == "ticket", models.TaskActivity.entity_id == ticket_id)]

    def _status(self, fn, *a, **kw):
        with self.assertRaises(HTTPException) as cm:
            fn(*a, **kw)
        return cm.exception.status_code

    # ── ticket soft delete ─────────────────────────────────────────────────
    def test_delete_keeps_conversation_files_and_activity_and_logs_it(self):
        self._comment(AGENT)
        self._attachment(AGENT)

        T.delete_ticket(self.t.id, user=MANAGER, db=self.db)

        self.assertEqual(self.db.query(models.TaskComment).filter_by(task_id=self.t.id).count(), 1)
        self.assertEqual(self.db.query(models.TaskAttachment).filter_by(task_id=self.t.id).count(), 1)
        self.assertEqual(self._activity_types(self.t.id), ["created", "deleted"])
        row = (self.db.query(models.TaskTicket).execution_options(include_deleted=True)
               .filter_by(id=self.t.id).one())
        self.assertTrue(row.deleted_at)
        self.assertEqual(row.deleted_by, MANAGER["email"])

    def test_deleted_ticket_is_hidden_from_lists_and_detail_for_everyone(self):
        keep = self._ticket("Still here")
        T.delete_ticket(self.t.id, user=MANAGER, db=self.db)

        for who, mine in ((REQUESTER, True), (REQUESTER, False), (AGENT, False), (MANAGER, False)):
            ids = [r["id"] for r in T.list_tickets(mine=mine, user=who, db=self.db)]
            self.assertNotIn(self.t.id, ids, who)
            self.assertIn(keep.id, ids, who)
        for who in (REQUESTER, AGENT, MANAGER):
            self.assertEqual(self._status(T.list_ticket_comments, self.t.id, user=who, db=self.db), 404)
            self.assertEqual(self._status(T.list_ticket_attachments, self.t.id, user=who, db=self.db), 404)
            self.assertEqual(self._status(T.list_ticket_activity, self.t.id, user=who, db=self.db), 404)
        # Any plain query - dashboards, briefings, notification scans - misses it.
        self.assertEqual(self.db.query(models.TaskTicket).filter_by(id=self.t.id).count(), 0)

    def test_a_deleted_tickets_number_is_never_issued_again(self):
        code = self.t.code
        T.delete_ticket(self.t.id, user=MANAGER, db=self.db)

        self.assertGreater(int(T._next_ticket_code(self.db)), int(code))

    def test_restore_brings_it_back_with_its_history(self):
        self._comment(AGENT)
        T.delete_ticket(self.t.id, user=MANAGER, db=self.db)
        self.assertEqual([r["id"] for r in T.list_deleted_tickets(user=MANAGER, db=self.db)], [self.t.id])

        out = T.restore_ticket(self.t.id, user=MANAGER, db=self.db)

        self.assertEqual(out["id"], self.t.id)
        self.assertIn(self.t.id, [r["id"] for r in T.list_tickets(mine=True, user=REQUESTER, db=self.db)])
        self.assertEqual(len(T.list_ticket_comments(self.t.id, user=AGENT, db=self.db)), 1)
        self.assertEqual(self._activity_types(self.t.id), ["created", "deleted", "restored"])
        self.assertEqual(T.list_deleted_tickets(user=MANAGER, db=self.db), [])

    def test_restore_follows_the_delete_permission(self):
        T.delete_ticket(self.t.id, user=MANAGER, db=self.db)

        # A desk agent who neither raised it nor manages the queue: no.
        self.assertEqual(self._status(T.restore_ticket, self.t.id, user=AGENT, db=self.db), 403)
        self.assertEqual(T.list_deleted_tickets(user=AGENT, db=self.db), [])
        # Another company: not found.
        self.assertEqual(self._status(T.restore_ticket, self.t.id, user=OUTSIDER, db=self.db), 404)
        # The requester may, as they may delete it.
        T.restore_ticket(self.t.id, user=REQUESTER, db=self.db)
        # A live ticket is not in the bin.
        self.assertEqual(self._status(T.restore_ticket, self.t.id, user=MANAGER, db=self.db), 404)

    def test_delete_is_refused_to_a_non_requester_agent_and_walled_from_other_companies(self):
        self.assertEqual(self._status(T.delete_ticket, self.t.id, user=AGENT, db=self.db), 403)
        self.assertEqual(self._status(T.delete_ticket, self.t.id, user=OUTSIDER, db=self.db), 404)
        self.assertEqual(self.db.query(models.TaskTicket).filter_by(id=self.t.id).count(), 1)

    # ── comments ────────────────────────────────────────────────────────────
    def test_comment_delete_other_company_agent_is_walled_off(self):
        c = self._comment(AGENT)
        # 404, not 403: the company wall never confirms a record exists.
        self.assertEqual(self._status(T.delete_ticket_comment, c.id, user=OUTSIDER, db=self.db), 404)
        self.assertEqual(self.db.query(models.TaskComment).filter_by(id=c.id).count(), 1)

    def test_comment_delete_non_author_agent_gets_403(self):
        c = self._comment(AGENT)
        self.assertEqual(self._status(T.delete_ticket_comment, c.id, user=AGENT_2, db=self.db), 403)
        self.assertEqual(self.db.query(models.TaskComment).filter_by(id=c.id).count(), 1)

    def test_comment_delete_by_author_or_manager_is_logged_without_the_text(self):
        own = self._comment(AGENT, internal=True)
        other = self._comment(AGENT)

        T.delete_ticket_comment(own.id, user=AGENT, db=self.db)
        T.delete_ticket_comment(other.id, user=MANAGER, db=self.db)

        self.assertEqual(self.db.query(models.TaskComment).filter_by(task_id=self.t.id).count(), 0)
        rows = (self.db.query(models.TaskActivity)
                .filter_by(entity_id=self.t.id, type="comment_deleted").order_by(models.TaskActivity.at).all())
        details = [json.loads(r.detail) for r in rows]
        self.assertEqual(sorted(d["internal"] for d in details), [False, True])
        self.assertTrue(all("secret" not in r.detail for r in rows))
        self.assertEqual({d["text"] for d in details}, {"deleted an internal note", "deleted a comment"})

    def test_a_task_comment_cannot_be_deleted_through_the_ticket_endpoint(self):
        task_comment = models.TaskComment(id=gen_id(), task_id="some-task-id", author_email=AGENT["email"],
                                          body="task words", created_at=now_iso())
        self.db.add(task_comment)
        self.db.commit()

        self.assertEqual(self._status(T.delete_ticket_comment, task_comment.id, user=MANAGER, db=self.db), 404)
        self.assertEqual(self.db.query(models.TaskComment).filter_by(id=task_comment.id).count(), 1)

    # ── attachments ────────────────────────────────────────────────────────
    def test_attachment_delete_other_company_agent_is_walled_off(self):
        a = self._attachment(AGENT)
        self.assertEqual(self._status(T.delete_ticket_attachment, a.id, user=OUTSIDER, db=self.db), 404)
        self.assertEqual(self.db.query(models.TaskAttachment).filter_by(id=a.id).count(), 1)

    def test_attachment_delete_non_uploader_agent_gets_403(self):
        a = self._attachment(AGENT)
        self.assertEqual(self._status(T.delete_ticket_attachment, a.id, user=AGENT_2, db=self.db), 403)
        self.assertEqual(self.db.query(models.TaskAttachment).filter_by(id=a.id).count(), 1)

    def test_attachment_delete_by_uploader_is_logged(self):
        a = self._attachment(AGENT)
        T.delete_ticket_attachment(a.id, user=AGENT, db=self.db)

        self.assertEqual(self.db.query(models.TaskAttachment).filter_by(id=a.id).count(), 0)
        self.assertIn("attachment_removed", self._activity_types(self.t.id))

    # ── saved views and components ──────────────────────────────────────────
    def test_another_users_saved_view_cannot_be_deleted(self):
        v = models.TaskSavedView(id=gen_id(), owner_email=AGENT_2["email"], name="Mine",
                                 scope="ticket", filters={}, created_at=now_iso())
        self.db.add(v)
        self.db.commit()

        self.assertEqual(self._status(T.delete_ticket_view, v.id, user=AGENT, db=self.db), 404)
        self.assertEqual(self.db.query(models.TaskSavedView).filter_by(id=v.id).count(), 1)
        T.delete_ticket_view(v.id, user=AGENT_2, db=self.db)
        self.assertEqual(self.db.query(models.TaskSavedView).filter_by(id=v.id).count(), 0)

    def test_a_task_saved_view_cannot_be_deleted_through_the_ticket_endpoint(self):
        v = models.TaskSavedView(id=gen_id(), owner_email=AGENT["email"], name="Task view",
                                 scope="task", filters={}, created_at=now_iso())
        self.db.add(v)
        self.db.commit()

        self.assertEqual(self._status(T.delete_ticket_view, v.id, user=AGENT, db=self.db), 404)

    def test_component_delete_takes_a_manager(self):
        c = models.TaskTicketComponent(id=gen_id(), name="Network", created_at=now_iso())
        self.db.add(c)
        self.db.commit()

        self.assertEqual(self._status(T.delete_ticket_component, c.id, user=AGENT, db=self.db), 403)
        T.delete_ticket_component(c.id, user=MANAGER, db=self.db)
        self.assertEqual(self.db.query(models.TaskTicketComponent).count(), 0)


if __name__ == "__main__":
    unittest.main()
