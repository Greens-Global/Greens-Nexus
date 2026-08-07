"""
Ticket numbers: a 6-digit sequence, shown as "Ticket #000001" (Aug 2026).

They used to be "TKT-001". The prefix lived inside the stored value, so every
consumer carried it whether it wanted to or not, and three digits gave out at a
thousand tickets - after which the number changes width and stops sorting.

The generator was `count() + 1`, which is only correct while nothing is ever
deleted: delete a ticket and the next one issued reuses a live number, so two
tickets share a code and every reference to one becomes ambiguous. Counting what
exists answers "how many", not "what comes next".

Throwaway sqlite. No network.

Run with: python -m unittest test_ticket_code -v
"""
import os
import tempfile
import unittest
import uuid

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import atexit

import database
import models
import ticket_code
from routers import tickets

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


class FormattingTests(unittest.TestCase):
    def test_a_number_is_six_digits(self):
        self.assertEqual(ticket_code.normalize("1"), "000001")
        self.assertEqual(ticket_code.normalize("000123"), "000123")

    def test_it_is_shown_with_a_hash(self):
        self.assertEqual(ticket_code.ticket_no("000123"), "Ticket #000123")

    def test_legacy_codes_read_as_the_same_number(self):
        """A row written before the change must format identically to one
        written after it, without waiting on the data migration."""
        self.assertEqual(ticket_code.normalize("TKT-012"), "000012")
        self.assertEqual(ticket_code.ticket_no("TKT-012"), "Ticket #000012")

    def test_blank_stays_blank(self):
        """Not "Ticket #" - a ticket with no number should look like it has
        none, not like it has an empty one."""
        for empty in ("", None, "   "):
            self.assertEqual(ticket_code.ticket_no(empty), "")

    def test_a_number_wider_than_six_digits_is_not_truncated(self):
        """Padding is a minimum, never a cap - silently dropping a digit would
        map two different tickets onto one number."""
        self.assertEqual(ticket_code.normalize("1234567"), "1234567")


class SequenceTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        self.db.query(models.TaskTicket).delete()
        self.db.commit()

    def _add(self, code):
        self.db.add(models.TaskTicket(id=str(uuid.uuid4()), code=code, subject="S",
                                      type="bug", status="new", created_at="", modified_at=""))
        self.db.commit()

    def test_the_first_ticket_is_000001(self):
        self.assertEqual(tickets._next_ticket_code(self.db), "000001")

    def test_it_counts_on_from_the_highest_issued(self):
        for c in ("000001", "000002", "000003"):
            self._add(c)
        self.assertEqual(tickets._next_ticket_code(self.db), "000004")

    def test_deleting_a_ticket_does_not_reissue_a_live_number(self):
        """The bug in `count() + 1`: with 3 tickets, deleting the middle one
        left 2, so the next issued was 000003 - a number already in use."""
        for c in ("000001", "000002", "000003"):
            self._add(c)
        (self.db.query(models.TaskTicket)
            .filter(models.TaskTicket.code == "000002").delete())
        self.db.commit()
        issued = tickets._next_ticket_code(self.db)
        self.assertEqual(issued, "000004")
        live = {t.code for t in self.db.query(models.TaskTicket).all()}
        self.assertNotIn(issued, live, "reissued a number that is still in use")

    def test_the_sequence_continues_past_legacy_codes(self):
        """Restarting at 000001 alongside TKT-005 would collide on display -
        both render as Ticket #000001..#000005."""
        for c in ("TKT-004", "TKT-005"):
            self._add(c)
        self.assertEqual(tickets._next_ticket_code(self.db), "000006")

    def test_a_mixed_board_still_yields_one_sequence(self):
        self._add("TKT-007")
        self._add("000009")
        self.assertEqual(tickets._next_ticket_code(self.db), "000010")

    def test_issued_numbers_are_unique_across_a_run(self):
        seen = set()
        for _ in range(12):
            code = tickets._next_ticket_code(self.db)
            self.assertNotIn(code, seen)
            seen.add(code)
            self._add(code)
        self.assertEqual(len(seen), 12)
        self.assertEqual(sorted(seen)[-1], "000012")


class EmailTests(unittest.TestCase):
    """The number a person reads in their inbox."""

    def test_the_subject_carries_the_formatted_number(self):
        import ticket_mail_templates as tmpl
        subject = tmpl._ticket_subject({"code": "000042", "subject": "VPN access",
                                        "status": "new", "companyName": "Greens"})
        self.assertTrue(subject.startswith("Ticket #000042 - "), subject)

    def test_a_legacy_coded_ticket_still_emails_correctly(self):
        import ticket_mail_templates as tmpl
        subject = tmpl._ticket_subject({"code": "TKT-042", "subject": "VPN access",
                                        "status": "new", "companyName": "Greens"})
        self.assertTrue(subject.startswith("Ticket #000042 - "), subject)


if __name__ == "__main__":
    unittest.main()
