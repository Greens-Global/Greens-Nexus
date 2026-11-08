"""Record links everywhere (Neil, 11/07/2026) - record_links.py.

  - A [[ link written in a task description, a ticket description or a task /
    ticket comment is recorded by the before_flush hook, whatever path saved
    the row; an edit rewrites it, a delete removes it, a record never lists
    itself.
  - GET /notes/mentions (record_links.mentions) lists only places the caller
    may open: the ticket's own people and the desk see a ticket, a stranger
    does not; a link written only in an internal ticket note is the desk's.
  - GET /task-tickets/search names only tickets the caller may open.

Uses a throwaway sqlite file. No network.
Run with: python -m pytest test_record_links.py   (one file per process - CLAUDE.md)
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks                       # noqa: E402

import database                                           # noqa: E402
import models                                             # noqa: E402
import record_links                                       # noqa: E402
from routers import tickets as T                          # noqa: E402
from routers.task_util import gen_id, now_iso             # noqa: E402

AGENT = {"email": "agent@greensglobal.com", "level": 1}
REQUESTER = {"email": "requester@greensglobal.com", "level": 1}
STRANGER = {"email": "stranger@greensglobal.com", "level": 1}
TARGET = "task:target1"


def link(ref, title="Fix the gate"):
    return f'<a data-type="recordLink" data-ref="{ref}" title="{title}">{title}</a>'


class RecordLinkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.TaskComment, models.TaskActivity, models.TaskNotification,
                  models.NexusGroup, models.NexusGroupMember, models.NexusRecordLink, models.NexusSetting,
                  models.NexusNote):
            self.db.query(m).delete()
        self.db.add(models.NexusGroup(id="g1", name="Service Desk", allowed_modules="tickets:editor"))
        self.db.add(models.NexusGroupMember(group_id="g1", email=AGENT["email"]))
        self.t = models.TaskTicket(id=gen_id(), code="000001", subject="Printer is on fire", status="new",
                                   priority="medium", requester_email=REQUESTER["email"], watcher_emails=[],
                                   created_at=now_iso(), modified_at=now_iso())
        self.db.add(self.t)
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def links(self):
        return sorted((r.src_ref.split(":")[0], r.parent_ref, r.dst_ref, bool(r.internal))
                      for r in self.db.query(models.NexusRecordLink).all())

    def comment(self, body, internal=False, user=AGENT):
        return T.add_ticket_comment(self.t.id, T.TicketCommentBody(body=body, internal=internal),
                                    BackgroundTasks(), user=user, db=self.db)

    def test_refs_in_reads_each_link_once_and_nothing_else(self):
        html = f"<p>{link('task:a')} {link('ticket:b')} {link('task:a')}</p><a data-ref=\"payroll:1\">x</a>"
        self.assertEqual(record_links.refs_in(html), ["task:a", "ticket:b"])
        self.assertEqual(record_links.refs_in("<p>plain</p>"), [])

    def test_a_ticket_description_is_recorded_rewritten_and_never_lists_itself(self):
        self.t.description = f"<p>{link(TARGET)} {link('ticket:' + self.t.id)}</p>"
        self.db.commit()
        self.assertEqual(self.links(), [("ticket", f"ticket:{self.t.id}", TARGET, False)])
        self.t.description = f"<p>{link('kb:page1')}</p>"
        self.db.commit()
        self.assertEqual(self.links(), [("ticket", f"ticket:{self.t.id}", "kb:page1", False)])
        self.t.description = "<p>nothing</p>"
        self.db.commit()
        self.assertEqual(self.links(), [])

    def test_a_ticket_comment_counts_for_its_ticket_and_goes_when_deleted(self):
        self.comment(f"<p>see {link(TARGET)}</p>", internal=True)
        self.assertEqual(self.links(), [("comment", f"ticket:{self.t.id}", TARGET, True)])
        c = self.db.query(models.TaskComment).one()
        self.db.delete(c)
        self.db.commit()
        self.assertEqual(self.links(), [])

    def test_who_sees_a_ticket_that_links_here(self):
        self.t.description = f"<p>see {link(TARGET)}</p>"
        self.db.commit()
        for user, n in ((AGENT, 1), (REQUESTER, 1), (STRANGER, 0)):
            out = record_links.mentions(self.db, user, TARGET)
            self.assertEqual(out["total"], n, user["email"])
        row = record_links.mentions(self.db, AGENT, TARGET)["items"][0]
        self.assertEqual((row["kind"], row["id"], row["title"], row["via"]), ("ticket", self.t.id, "Printer is on fire", ""))

    def test_an_internal_note_link_is_the_desks_only(self):
        self.comment(f"<p>internal {link(TARGET)}</p>", internal=True)
        self.assertEqual(self.links(), [("comment", f"ticket:{self.t.id}", TARGET, True)])
        self.assertEqual(record_links.mentions(self.db, AGENT, TARGET)["total"], 1)
        self.assertEqual(record_links.mentions(self.db, REQUESTER, TARGET)["total"], 0)

    def test_a_task_the_caller_cannot_open_is_never_named(self):
        task = models.Task(id=gen_id(), title="Secret plan", description=f"<p>{link(TARGET)}</p>",
                           assignee_emails=[AGENT["email"]], access_level="private",
                           created_at=now_iso(), modified_at=now_iso())
        self.db.add(task)
        self.db.commit()
        self.assertIn(("task", f"task:{task.id}", TARGET, False), self.links())
        self.assertEqual(record_links.mentions(self.db, STRANGER, TARGET)["total"], 0)

    def test_task_states_leave_out_what_the_caller_cannot_open(self):
        from routers import tasks as TK
        open_t = models.Task(id=gen_id(), title="Open one", completed=True, created_at=now_iso(), modified_at=now_iso())
        hidden = models.Task(id=gen_id(), title="Hidden", access_level="private", assignee_emails=[AGENT["email"]],
                             created_at=now_iso(), modified_at=now_iso())
        self.db.add_all([open_t, hidden])
        self.db.commit()
        out = TK.task_states(ids=f"{open_t.id},{hidden.id},nope", user=STRANGER, db=self.db)["tasks"]
        self.assertEqual(list(out), [open_t.id])
        self.assertTrue(out[open_t.id]["done"])

    def test_a_live_list_reads_only_what_the_reader_may_open(self):
        from fastapi import HTTPException
        from routers import tasks as TK
        for m in (models.Task, models.TaskProject):
            self.db.query(m).delete()
        self.db.add_all([
            models.TaskProject(id="p_org", name="Gate Repairs", access_level="org", owner_email=AGENT["email"]),
            models.TaskProject(id="p_priv", name="Secret", access_level="restricted", owner_email=AGENT["email"]),
            models.Task(id="t1", title="Order the motor", project_id="p_org", assignee_emails=[STRANGER["email"]],
                        due_on="2026-11-10", created_at=now_iso(), modified_at=now_iso()),
            models.Task(id="t2", title="Done already", project_id="p_org", completed=True, created_at=now_iso(), modified_at=now_iso()),
            models.Task(id="t3", title="Hidden plan", project_id="p_priv", created_at=now_iso(), modified_at=now_iso()),
        ])
        self.db.commit()
        ids = lambda r: [t["id"] for t in r["tasks"]]  # noqa: E731
        out = TK.task_list_embed(source="project:p_org", show="open", user=STRANGER, db=self.db)
        self.assertEqual((ids(out), out["projectName"]), (["t1"], "Gate Repairs"))
        self.assertEqual(ids(TK.task_list_embed(source="project:p_org", show="all", user=STRANGER, db=self.db)), ["t1", "t2"])
        hidden = TK.task_list_embed(source="project:p_priv", show="all", user=STRANGER, db=self.db)
        self.assertEqual((hidden["tasks"], hidden["projectName"], hidden["visible"]), ([], "", False))
        self.assertEqual(ids(TK.task_list_embed(source="mine", show="open", user=STRANGER, db=self.db)), ["t1"])
        with self.assertRaises(HTTPException):
            TK.task_list_embed(source="payroll", show="open", user=STRANGER, db=self.db)

    def test_a_boards_record_cards_count_and_a_deleted_card_does_not(self):
        import json
        card = lambda ref, gone=False: {"id": ref, "type": "rectangle", "isDeleted": gone, "customData": {"nexusRecord": {"ref": ref}}}  # noqa: E731
        scene = {"type": "nexus-board", "elements": [card(TARGET), card("ticket:k9", gone=True), card("payroll:1")]}
        b = models.NexusNote(id="note_brd1", kind="board", owner_email=AGENT["email"], title="Plan", body="", scene=json.dumps(scene))
        self.db.add(b)
        self.db.commit()
        self.assertEqual(self.links(), [("note", "note:note_brd1", TARGET, False)])
        scene["elements"][0]["isDeleted"] = True
        b.scene = json.dumps(scene)
        self.db.commit()
        self.assertEqual(self.links(), [])

    def test_a_public_reply_never_carries_a_chip(self):
        self.comment(f"<p>see {link(TARGET)} now</p>")
        self.comment(f"<p>note {link(TARGET)}</p>", internal=True)
        bodies = {bool(c.internal): c.body for c in self.db.query(models.TaskComment).all()}
        self.assertEqual(bodies[False], "<p>see Fix the gate now</p>")
        self.assertIn('data-ref="task:target1"', bodies[True])
        self.assertEqual(self.links(), [("comment", f"ticket:{self.t.id}", TARGET, True)])

    def test_a_comment_on_a_ticket_made_in_the_same_flush_counts_for_the_ticket(self):
        k = models.TaskTicket(id=gen_id(), code="000002", subject="New one", status="new", priority="medium",
                              requester_email=REQUESTER["email"], watcher_emails=[], created_at=now_iso(), modified_at=now_iso())
        self.db.add(k)
        self.db.add(models.TaskComment(id=gen_id(), task_id=k.id, author_email=AGENT["email"], body=f"<p>{link(TARGET)}</p>",
                                       created_at=now_iso()))
        self.db.commit()
        self.assertEqual(self.links(), [("comment", f"ticket:{k.id}", TARGET, False)])

    def test_ticket_search_never_offers_a_confidential_ticket(self):
        self.db.add(models.TaskTicket(id=gen_id(), code="000003", subject="Printer complaint", status="new", priority="medium",
                                      requester_email=REQUESTER["email"], watcher_emails=[], confidential_desk="hr",
                                      created_at=now_iso(), modified_at=now_iso()))
        self.db.commit()
        self.assertEqual([x["id"] for x in T.search_tickets(q="printer", user=AGENT, db=self.db)["tickets"]], [self.t.id])

    def test_the_backfill_writes_old_notes_once(self):
        n = models.NexusNote(id="note_old1", owner_email=AGENT["email"], title="Old", body=f"<p>{link(TARGET)}</p>")
        self.db.add(n)
        self.db.commit()
        self.db.query(models.NexusRecordLink).delete()       # as if saved before the table existed
        self.db.commit()
        self.assertEqual(record_links.backfill_once(self.db), 1)
        self.assertEqual(self.links(), [("note", "note:note_old1", TARGET, False)])
        self.assertIsNone(record_links.backfill_once(self.db))

    def test_ticket_search_names_only_tickets_the_caller_may_open(self):
        found = lambda u: [x["id"] for x in T.search_tickets(q="printer", user=u, db=self.db)["tickets"]]  # noqa: E731
        self.assertEqual(found(AGENT), [self.t.id])
        self.assertEqual(found(REQUESTER), [self.t.id])
        self.assertEqual(found(STRANGER), [])
        self.assertEqual(T.search_tickets(q="p", user=AGENT, db=self.db)["tickets"], [])


if __name__ == "__main__":
    unittest.main()
