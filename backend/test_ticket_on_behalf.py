"""
Raising a ticket on someone else's behalf (Neil, Oct 1 2026).

The intake form's Requester field ("who is this for") defaults to the person
filling it in and can be anyone on the curated People list. The requester is
who the ticket is FOR: they are notified, see it as theirs on Support, and
rate/reopen it. The person who filed it is recorded (created_by_email), kept
on as a watcher, and can still find it in their own Support list - but the
confirm/reopen moves stay with the requester.

It used to be a desk-only move (everyone else had the requester silently
forced to themselves); now it is open to all, so the address is checked
against the People list instead.

Uses a throwaway sqlite file. No network: BackgroundTasks are never run.

Run with: python -m pytest test_ticket_on_behalf.py
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException

import database
import models
from routers.task_util import gen_id
from routers import tickets as T

ME = {"email": "filer@greensglobal.com", "level": 1}             # plain employee, no desk grant
COLLEAGUE = "colleague@greensglobal.com"
GONE = "gone@greensglobal.com"
GUEST = "partner@example.com"
AGENT = {"email": "agent@greensglobal.com", "level": 1}          # desk grant via group


class OnBehalfTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except OSError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.TaskActivity, models.NexusEmployee,
                  models.NexusNotification, models.TaskNotification,
                  models.NexusGroup, models.NexusGroupMember):
            self.db.query(m).delete()
        self.db.add(models.NexusGroup(id="g-desk", name="Service Desk", allowed_modules="tickets:editor"))
        self.db.add(models.NexusGroupMember(group_id="g-desk", email=AGENT["email"]))
        for email, status, identity in ((ME["email"], "active", "internal"),
                                        (COLLEAGUE, "active", "internal"),
                                        (GONE, "offboarded", "internal"),
                                        (GUEST, "active", "guest")):
            self.db.add(models.NexusEmployee(id=gen_id(), first_name=email.split("@")[0],
                                             work_email=email, status=status, identity_type=identity))
        self.db.commit()
        import cache
        cache.module_grants.invalidate()

    def tearDown(self):
        self.db.close()

    def _create(self, user, requester="", **kw):
        body = T.TicketBody(subject=kw.pop("subject", "Laptop will not boot"), requester_email=requester, **kw)
        return T.create_ticket(body, BackgroundTasks(), user=user, db=self.db)

    # ── who it is for ────────────────────────────────────────────────────────
    def test_blank_requester_means_me(self):
        out = self._create(ME)
        self.assertEqual(out["requesterId"], ME["email"])
        self.assertEqual(out["createdById"], ME["email"])
        self.assertEqual(out["watcherIds"], [])            # filing your own adds nobody

    def test_any_employee_may_raise_one_for_a_colleague(self):
        out = self._create(ME, requester=COLLEAGUE.upper())
        self.assertEqual(out["requesterId"], COLLEAGUE)
        self.assertEqual(out["createdById"], ME["email"])
        # The filer stays on it as a watcher - a participant, so they can read it.
        self.assertIn(ME["email"], out["watcherIds"])
        t = self.db.get(models.TaskTicket, out["id"])
        T._require_ticket_participant(self.db, ME, t)     # must not raise

    def test_the_requester_is_told_it_landed(self):
        self._create(ME, requester=COLLEAGUE)
        bells = (self.db.query(models.NexusNotification)
                 .filter(models.NexusNotification.recipient == COLLEAGUE).all())
        self.assertTrue(any("received" in (b.title or "").lower() for b in bells),
                        [b.title for b in bells])

    # ── who it may be for ────────────────────────────────────────────────────
    def _refused(self, user, requester):
        with self.assertRaises(HTTPException) as ctx:
            self._create(user, requester=requester)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_someone_off_the_people_list_is_refused_not_swapped_for_me(self):
        self._refused(ME, "nobody@greensglobal.com")
        self.assertEqual(self.db.query(models.TaskTicket).count(), 0)

    def test_an_offboarded_person_is_refused(self):
        self._refused(ME, GONE)

    def test_a_guest_is_refused_for_an_employee_but_allowed_for_the_desk(self):
        self._refused(ME, GUEST)
        out = self._create(AGENT, requester=GUEST)
        self.assertEqual(out["requesterId"], GUEST)

    # ── "mine" on Support ────────────────────────────────────────────────────
    def test_the_filer_and_the_requester_both_see_it_as_theirs(self):
        out = self._create(ME, requester=COLLEAGUE)
        mine = [r["id"] for r in T.list_tickets(mine=True, user=ME, db=self.db)]
        theirs = [r["id"] for r in T.list_tickets(mine=True, user={"email": COLLEAGUE, "level": 1}, db=self.db)]
        self.assertIn(out["id"], mine)
        self.assertIn(out["id"], theirs)

    def test_only_the_requester_may_confirm_or_reopen(self):
        out = self._create(ME, requester=COLLEAGUE)
        t = self.db.get(models.TaskTicket, out["id"])
        self.assertTrue(T._may_patch_ticket(self.db, t, {"email": COLLEAGUE, "level": 1}))
        self.assertFalse(T._may_patch_ticket(self.db, t, ME))


if __name__ == "__main__":
    unittest.main()
