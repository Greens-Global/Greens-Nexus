"""
Ticket intake: company resolved, not asked (Aug 2026).

Step 1 used to open with a Company picker. A requester works for exactly one
company, the server already knows which, and making them choose was a question
with a single right answer they could still get wrong - and getting it wrong
routes the ticket to another company's departments.

Company now comes from the requester's People record, and the departments on
offer are that company's. Both go through company_for(), so the departments
someone is shown can never belong to a different company than the one their
ticket is filed under.

Throwaway sqlite. No network.

Run with: python -m unittest test_ticket_intake -v
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
from routers import tickets

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


GREENS, OTHER = "co-greens", "co-other"
ME = "sagar.shoundik@greensglobal.com"
STRANGER = "nobody@greensglobal.com"


class IntakeCompanyTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.NexusEmployee, models.HrDepartment, models.TaskTicket):
            self.db.query(m).delete()
        self.db.commit()
        self.db.add(models.NexusEmployee(id=str(uuid.uuid4()), first_name="Sagar",
                                         work_email=ME, company=GREENS, status="active"))
        for name, co in (("Estimating", GREENS), ("Operations", GREENS), ("Payroll", OTHER)):
            self.db.add(models.HrDepartment(id=str(uuid.uuid4()), company_id=co, name=name))
        self.db.commit()

    # ── company_for ──────────────────────────────────────────────────────
    def test_it_resolves_the_company_from_the_people_record(self):
        self.assertEqual(tickets.company_for(self.db, ME), GREENS)

    def test_someone_with_no_people_record_resolves_to_nothing(self):
        """Not an error: a ticket without a company is still valid and triage
        routes it. Refusing to file it would be the worse failure."""
        self.assertEqual(tickets.company_for(self.db, STRANGER), "")

    def test_it_is_case_insensitive_on_the_address(self):
        self.assertEqual(tickets.company_for(self.db, ME.upper()), GREENS)

    # ── the department list intake offers ────────────────────────────────
    def test_mine_returns_only_this_persons_company(self):
        rows = tickets.list_ticket_departments(mine=True, user={"email": ME}, db=self.db)
        self.assertEqual(sorted(r["name"] for r in rows), ["Estimating", "Operations"])

    def test_another_companys_department_is_never_offered(self):
        rows = tickets.list_ticket_departments(mine=True, user={"email": ME}, db=self.db)
        self.assertNotIn("Payroll", [r["name"] for r in rows])

    def test_the_unscoped_list_is_unchanged_for_the_agent_queue(self):
        rows = tickets.list_ticket_departments(user={"email": ME}, db=self.db)
        self.assertEqual(len(rows), 3)

    def test_someone_with_no_company_is_offered_nothing_rather_than_everything(self):
        """Falling back to every department would let a ticket be routed into a
        company the requester has nothing to do with."""
        rows = tickets.list_ticket_departments(mine=True, user={"email": STRANGER}, db=self.db)
        self.assertEqual(rows, [])


if __name__ == "__main__":
    unittest.main()
