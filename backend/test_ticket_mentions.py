"""
@mentions in a ticket's Conversation.

The thread was a plain textarea, so there was no way to @ anyone on a ticket -
the task module had it and tickets did not (Sagar, Sept 2 2026). The editor is
now the same one the task comments use, which writes a mention as a mailto
link, so routers.task_util.extract_mentions reads both threads.

What these pin is the half that is easy to get wrong: a mention has to also put
the person ON the ticket. A ticket is readable by its participants
(_require_ticket_participant); mention someone who is not one and the bell they
get opens a 403.

Uses a throwaway sqlite file. No network.
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks

import database
import models
from routers.task_util import gen_id, now_iso
from routers import tickets as T

AGENT = {"email": "agent@greensglobal.com", "level": 1}
REQUESTER = "requester@greensglobal.com"
SAGAR = "sagar.shoundik@greensglobal.com"
NEIL = "neil@greensglobal.com"


def mention(email, name):
    """What the editor writes for an @mention - see RichDescription.jsx."""
    return f'<p>over to <a href="mailto:{email}">@{name}</a> please</p>'


class TicketMentionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.TaskComment, models.TaskActivity,
                  models.TaskNotification, models.NexusGroup, models.NexusGroupMember):
            self.db.query(m).delete()
        g = models.NexusGroup(id="g1", name="Service Desk", allowed_modules="tickets:editor")
        self.db.add(g)
        self.db.add(models.NexusGroupMember(group_id="g1", email=AGENT["email"]))
        self.t = models.TaskTicket(id=gen_id(), code="000001", subject="Printer is on fire",
                                   status="new", priority="medium", requester_email=REQUESTER,
                                   watcher_emails=[], created_at=now_iso(), modified_at=now_iso())
        self.db.add(self.t)
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _comment(self, body, internal=False, user=AGENT):
        return T.add_ticket_comment(self.t.id, T.TicketCommentBody(body=body, internal=internal),
                                    BackgroundTasks(), user=user, db=self.db)

    def _bells(self, email):
        return [n for n in self.db.query(models.TaskNotification).all()
                if (n.for_email or "").lower() == email]

    # ── the mention itself ───────────────────────────────────────────────────
    def test_a_mentioned_person_is_told_by_name(self):
        self._comment(mention(SAGAR, "Sagar"))

        titles = [n.title for n in self._bells(SAGAR)]
        self.assertIn("You were mentioned in a ticket comment", titles)

    def test_a_mentioned_person_becomes_a_participant(self):
        """Without this the bell opens a 403 - a ticket is readable by the people
        on it, and being @'d into one is how you get on it."""
        self._comment(mention(SAGAR, "Sagar"))
        self.db.refresh(self.t)

        self.assertIn(SAGAR, [w.lower() for w in (self.t.watcher_emails or [])])
        T.list_ticket_comments(self.t.id, user={"email": SAGAR, "level": 1}, db=self.db)  # must not raise

    def test_two_people_in_one_comment_both_land(self):
        self._comment(f'<p>{mention(SAGAR, "Sagar")} and {mention(NEIL, "Neil")}</p>')
        self.db.refresh(self.t)

        watchers = [w.lower() for w in (self.t.watcher_emails or [])]
        self.assertIn(SAGAR, watchers)
        self.assertIn(NEIL, watchers)

    def test_mentioning_yourself_does_nothing(self):
        self._comment(mention(AGENT["email"], "Agent"))
        self.db.refresh(self.t)

        self.assertEqual(self.t.watcher_emails or [], [])
        self.assertEqual(self._bells(AGENT["email"]), [])

    def test_a_mention_is_one_bell_not_two(self):
        """A participant who is also mentioned used to be in line for both the
        generic "new comment" bell and the mention one."""
        self.t.watcher_emails = [SAGAR]
        self.db.commit()

        self._comment(mention(SAGAR, "Sagar"))

        bells = self._bells(SAGAR)
        self.assertEqual(len(bells), 1)
        self.assertEqual(bells[0].title, "You were mentioned in a ticket comment")

    def test_everyone_else_still_gets_the_ordinary_comment_bell(self):
        self._comment(mention(SAGAR, "Sagar"))

        titles = [n.title for n in self._bells(REQUESTER)]
        self.assertEqual(titles, ["New comment on a ticket"])

    # ── the plain case still works ───────────────────────────────────────────
    def test_a_comment_with_no_mention_changes_nothing_about_the_ticket(self):
        self._comment("<p>Looking into it now.</p>")
        self.db.refresh(self.t)

        self.assertEqual(self.t.watcher_emails or [], [])
        self.assertEqual([n.title for n in self._bells(REQUESTER)], ["New comment on a ticket"])


if __name__ == "__main__":
    unittest.main()
