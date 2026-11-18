"""The header search finds what you can open, and nothing else (11/13/2026).

Three server sources behind components/search/useNexusSearch.js, each reusing
the rule its own list applies:

  - GET /task-tickets/search?header=true - ListScope, as GET /task-tickets:
    the desk finds the queue inside its company wall, everyone else only the
    tickets they are part of; an Ask HR ticket is found by the person who
    raised it and by nobody else - not the desk, not HR by role; a typed
    number finds the ticket and leads. Without `header` (the [[ picker) an
    Ask HR ticket is never found, as before.
  - GET /notes/search - the caller's live notes and boards and the ones
    shared with them (_access); a stranger's note, a trashed note and a note
    whose share was taken back are not found.
  - GET /documents/library?q= - the library's own rows narrowed by title;
    an envelope the caller is not on is not found, and a packet envelope is
    never a search result.

Uses a throwaway sqlite file. No network.
Run with: python -m pytest test_header_search.py   (one file per process - CLAUDE.md)
"""
import json
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database                                           # noqa: E402
import models                                             # noqa: E402
import ticket_roles                                       # noqa: E402
from routers import documents as D                        # noqa: E402
from routers import notes as N                            # noqa: E402
from routers import tickets as T                          # noqa: E402
from routers.task_util import gen_id, now_iso             # noqa: E402

CO, OTHER_CO = "co-greens", "co-india"
AGENT = {"email": "agent@greensglobal.com", "level": 1}          # service desk agent (tickets grant)
REQUESTER = {"email": "requester@greensglobal.com", "level": 1}
STRANGER = {"email": "stranger@greensglobal.com", "level": 1}
HR = {"email": "hr@greensglobal.com", "level": 1}                # the company's HR contact: reads Ask HR by role
ADMIN = {"email": "admin@greensglobal.com", "level": 5}


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.NexusGroup, models.NexusGroupMember, models.NexusNote, models.HrEntity,
                  models.Document, models.HrSignRequest, models.HrSignParty, models.NexusEmployee, models.DocFolder):
            self.db.query(m).execution_options(include_confidential=True, include_deleted=True).delete()
        self.db.add(models.HrEntity(id=CO, name="Greens", hr_contact_email=HR["email"]))
        self.db.add(models.NexusGroup(id="g1", name="Service Desk", allowed_modules="tickets:editor"))
        self.db.add(models.NexusGroupMember(group_id="g1", email=AGENT["email"]))
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()


class TicketSearchTests(_Base):
    def ticket(self, code, subject, requester=REQUESTER, **kw):
        t = models.TaskTicket(id=gen_id(), code=code, subject=subject, status=kw.pop("status", "new"), priority="medium",
                              requester_email=requester["email"], watcher_emails=kw.pop("watcher_emails", []),
                              company_id=kw.pop("company_id", CO),
                              created_at=now_iso(), modified_at=now_iso(), **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def find(self, q, user, **kw):
        return T.search_tickets(q=q, header=True, user=user, db=self.db, **kw)["tickets"]

    def ids(self, q, user, **kw):
        return [x["id"] for x in self.find(q, user, **kw)]

    def test_the_desk_finds_the_queue_and_everyone_else_only_their_own(self):
        mine = self.ticket("000001", "Printer is on fire")
        theirs = self.ticket("000002", "Printer out of toner", requester=STRANGER)
        self.assertEqual(sorted(self.ids("printer", AGENT)), sorted([mine.id, theirs.id]))
        self.assertEqual(self.ids("printer", REQUESTER), [mine.id])
        self.assertEqual(self.ids("printer", STRANGER), [theirs.id])
        self.assertEqual(self.ids("printer", HR), [])

    def test_where_a_result_opens(self):
        self.ticket("000001", "Printer is on fire")
        self.assertEqual(self.find("printer", AGENT)[0]["view"], "tickets")
        self.assertFalse(self.find("printer", AGENT)[0]["confidential"])
        self.assertEqual(self.find("printer", REQUESTER)[0]["view"], "support")

    def test_another_companys_ticket_is_behind_the_wall(self):
        here = self.ticket("000001", "Gate stuck open")
        self.ticket("000002", "Gate stuck shut", company_id=OTHER_CO)
        real = ticket_roles.company_scope
        ticket_roles.company_scope = lambda user, db: {CO}
        try:
            self.assertEqual(self.ids("gate", AGENT), [here.id])
        finally:
            ticket_roles.company_scope = real
        self.assertEqual(len(self.ids("gate", AGENT)), 2)

    def test_an_ask_hr_ticket_is_found_by_its_own_person_and_nobody_else(self):
        ask = self.ticket("000003", "Payroll question", confidential_desk="hr")
        self.assertEqual(self.ids("payroll", REQUESTER), [ask.id])
        self.assertEqual(self.find("payroll", REQUESTER)[0]["view"], "support")
        self.assertTrue(self.find("payroll", REQUESTER)[0]["confidential"])
        self.assertEqual(self.ids("payroll", AGENT), [])        # the desk grant does not open it
        self.assertEqual(self.ids("payroll", STRANGER), [])
        # HR reads it in the list by role; the search still names only your own.
        self.assertEqual(self.ids("payroll", HR), [])
        self.assertEqual(self.ids("payroll", ADMIN), [])
        self.assertEqual(self.ids("000003", AGENT), [])
        # The [[ picker (no `header`) never offers one, even to its requester.
        self.assertEqual(T.search_tickets(q="payroll", user=REQUESTER, db=self.db)["tickets"], [])

    def test_an_ask_hr_ticket_filed_for_someone_is_found_by_the_filer(self):
        ask = self.ticket("000004", "Leave paperwork", requester=STRANGER, confidential_desk="hr",
                          created_by_email=REQUESTER["email"])
        self.assertEqual(self.ids("leave", REQUESTER), [ask.id])
        self.assertEqual(self.ids("leave", STRANGER), [ask.id])

    def test_an_ask_hr_ticket_someone_only_watches_is_not_a_search_result(self):
        self.ticket("000005", "Visa letter", requester=STRANGER, confidential_desk="hr",
                    watcher_emails=[REQUESTER["email"]])
        self.assertEqual(self.ids("visa", REQUESTER), [])

    def test_a_number_finds_the_ticket_and_leads(self):
        a = self.ticket("000041", "Aardvark in the lobby")
        b = self.ticket("000410", "A second thing")
        c = self.ticket("000007", "Call 41 back")
        for typed in ("41", "#41"):
            out = self.find(typed, AGENT)
            self.assertEqual(out[0]["id"], a.id, typed)
            self.assertTrue(out[0]["exact"])
            self.assertIn(b.id, [x["id"] for x in out])
            self.assertFalse(any(x["exact"] for x in out[1:]))
        self.assertIn(c.id, self.ids("41", AGENT))
        self.assertNotIn(c.id, self.ids("#41", AGENT))

    def test_a_prefix_sorts_first_then_alphabetical_and_the_cap_holds(self):
        self.ticket("000001", "Zebra door is stuck")
        self.ticket("000002", "The door will not lock")
        self.ticket("000003", "Door alarm")
        self.ticket("000004", "Door badge reader")
        self.assertEqual([x["subject"] for x in self.find("door", AGENT)],
                         ["Door alarm", "Door badge reader", "The door will not lock", "Zebra door is stuck"])
        self.assertEqual(len(self.find("door", AGENT, limit=2)), 2)
        self.assertEqual(self.find("d", AGENT), [])            # two characters at least

    def test_a_deleted_ticket_is_not_found(self):
        t = self.ticket("000001", "Printer is on fire")
        t.deleted_at = now_iso()
        self.db.commit()
        self.assertEqual(self.ids("printer", AGENT), [])


class NoteSearchTests(_Base):
    def note(self, title, owner=REQUESTER, text="", **kw):
        n = models.NexusNote(id=f"note_{gen_id()}", owner_email=owner["email"], title=title, text=text, body="",
                             kind=kw.pop("kind", "note"), shared_with=json.dumps(kw.pop("shared", [])),
                             trashed_at=kw.pop("trashed_at", ""), created_at=now_iso(), updated_at=now_iso(), **kw)
        self.db.add(n)
        self.db.commit()
        return n

    def find(self, q, user, **kw):
        return N.search_notes(q=q, user=user, db=self.db, **kw)["notes"]

    def ids(self, q, user):
        return [x["id"] for x in self.find(q, user)]

    def test_my_notes_and_boards_by_title_and_by_their_words(self):
        a = self.note("Gate repair plan")
        b = self.note("Site Walk", text="the north gate hinge is loose")
        c = self.note("Yard Layout", kind="board", text="gate here", scene='{"type":"nexus-board","elements":[]}')
        self.note("Unrelated")
        out = self.find("gate", REQUESTER)
        self.assertEqual([x["id"] for x in out], [a.id, b.id, c.id])     # the title hit first, then alphabetical
        self.assertEqual([x["inTitle"] for x in out], [True, False, False])
        self.assertEqual(out[2]["kind"], "board")
        self.assertNotIn("scene", out[2])
        self.assertNotIn("body", out[0])

    def test_someone_elses_private_note_is_not_found(self):
        self.note("Gate codes", owner=STRANGER)
        self.assertEqual(self.ids("gate", REQUESTER), [])
        self.assertEqual(self.ids("gate", ADMIN), [])           # a tier opens nobody's notes

    def test_a_shared_note_is_found_until_the_share_is_taken_back(self):
        n = self.note("Gate codes", owner=STRANGER, shared=[{"email": REQUESTER["email"], "can": "read"}])
        out = self.find("gate", REQUESTER)
        self.assertEqual([(x["id"], x["mine"], x["owner"]) for x in out], [(n.id, False, STRANGER["email"])])
        n.shared_with = "[]"
        self.db.commit()
        self.assertEqual(self.ids("gate", REQUESTER), [])

    def test_a_name_inside_a_longer_address_is_not_a_share(self):
        self.note("Gate codes", owner=STRANGER, shared=[{"email": "x" + REQUESTER["email"], "can": "read"}])
        self.assertEqual(self.ids("gate", REQUESTER), [])

    def test_a_trashed_note_is_not_found_mine_or_shared(self):
        self.note("Gate one", trashed_at=now_iso())
        self.note("Gate two", owner=STRANGER, trashed_at=now_iso(), shared=[{"email": REQUESTER["email"], "can": "edit"}])
        self.assertEqual(self.ids("gate", REQUESTER), [])

    def test_a_percent_sign_is_a_character_not_a_wildcard(self):
        self.note("Budget review")
        hit = self.note("100% done")
        self.assertEqual(self.ids("0%", REQUESTER), [hit.id])
        self.assertEqual(self.ids("b%t", REQUESTER), [])
        self.assertEqual(self.find("b", REQUESTER), [])


class DocumentSearchTests(_Base):
    def doc(self, title, owner=REQUESTER, **kw):
        d = models.Document(id=gen_id(), title=title, owner_email=owner["email"], status=kw.pop("status", "draft"),
                            folder_id=kw.pop("folder_id", ""), source="",
                            created_at=now_iso(), updated_at=now_iso(), **kw)
        self.db.add(d)
        self.db.commit()
        return d

    def envelope(self, title, created_by, parties=(), **kw):
        r = models.HrSignRequest(id=f"req-{gen_id()}", title=title, status="pending", routing="sequential",
                                 current_order=1, source="pdf", created_by=created_by["email"],
                                 created_at=now_iso(), **kw)
        self.db.add(r)
        for i, who in enumerate(parties, 1):
            self.db.add(models.HrSignParty(id=f"p-{gen_id()}", request_id=r.id, name=who["email"], email=who["email"],
                                           ordinal=i, status="notified", party_role="signer", kind="internal"))
        self.db.commit()
        return r

    def find(self, q, user, **kw):
        return D.document_library(q=q, user=user, db=self.db, **kw)

    def ids(self, q, user):
        return [r["id"] for r in self.find(q, user)]

    def test_the_search_is_the_library_narrowed_by_title(self):
        a = self.doc("Lease Agreement")
        b = self.doc("Vendor Lease")
        self.doc("Unrelated")
        everything = {r["id"] for r in D.document_library(user=REQUESTER, db=self.db)}
        out = self.find("lease", REQUESTER)
        self.assertEqual([r["id"] for r in out], [a.id, b.id])           # the prefix first
        self.assertTrue({r["id"] for r in out} <= everything)
        self.assertNotIn("content", out[0])
        self.assertEqual(len(self.find("lease", REQUESTER, limit=1)), 1)
        self.assertEqual(self.find("l", REQUESTER), [])

    def test_a_document_in_someone_elses_personal_folder_is_not_found(self):
        self.db.add(models.DocFolder(id="f-theirs", name="Personal", key="personal", owner_email=STRANGER["email"],
                                     is_system=True, created_by=STRANGER["email"], created_at=now_iso()))
        self.doc("Lease notes", owner=STRANGER, folder_id="f-theirs")
        self.assertEqual(self.ids("lease", REQUESTER), [])
        self.assertEqual(len(self.ids("lease", STRANGER)), 1)

    def test_an_envelope_is_found_by_its_people_only(self):
        r = self.envelope("Lease Renewal", STRANGER, parties=[REQUESTER])
        self.assertEqual(self.ids("lease", REQUESTER), [f"sign:{r.id}"])
        self.assertEqual(self.ids("lease", STRANGER), [f"sign:{r.id}"])
        self.assertEqual(self.ids("lease", AGENT), [])

    def test_a_packet_envelope_is_never_a_search_result(self):
        r = self.envelope("Lease Of Laptop - Offer Packet", STRANGER, parties=[REQUESTER], link_kind="life_event")
        self.assertIn(f"sign:{r.id}", [x["id"] for x in D.document_library(user=REQUESTER, db=self.db)])
        self.assertEqual(self.ids("lease", REQUESTER), [])


if __name__ == "__main__":
    unittest.main()
