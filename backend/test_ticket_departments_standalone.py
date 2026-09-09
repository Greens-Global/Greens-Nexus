"""
Ticket departments are their own table, not HrDepartment (Sep 10 2026,
Pranshu: "I don't want department connection between people department and
ticket department... i have the choice to delete and add the departments
for ticket and that shouldn't impact people department").

Two things pinned here:
  - add/rename/delete on a ticket department never touches HrDepartment,
    and vice versa - the two lists are fully independent.
  - deleting a ticket department clears hr_department_id off any ticket
    that was filed against it, rather than leaving a dangling reference.

Uses a throwaway sqlite file. No network.
"""
import os
import tempfile
import unittest
import uuid

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException

import database
import models
from routers.task_util import now_iso
from routers import tickets as T

MANAGER = {"email": "manager@greensglobal.com", "level": 3}


class TicketDepartmentsStandaloneTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.HrDepartment, models.TicketDepartment, models.TaskTicket, models.HrEntity):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id="co", name="Greens Global"))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_adding_a_ticket_department_does_not_create_an_hr_department(self):
        T.add_ticket_department(T.TicketDepartmentIn(company_id="co", name="IT"),
                                user=MANAGER, db=self.db)

        self.assertEqual(self.db.query(models.TicketDepartment).count(), 1)
        self.assertEqual(self.db.query(models.HrDepartment).count(), 0)

    def test_renaming_a_ticket_department_does_not_touch_hr_departments(self):
        rows = T.add_ticket_department(T.TicketDepartmentIn(company_id="co", name="IT"),
                                       user=MANAGER, db=self.db)
        dept_id = rows[0]["id"]
        self.db.add(models.HrDepartment(id=str(uuid.uuid4()), company_id="co", name="IT"))
        self.db.commit()

        T.update_ticket_department(dept_id, T.TicketDepartmentUpdateIn(name="IT Support"),
                                   user=MANAGER, db=self.db)

        hr = self.db.query(models.HrDepartment).filter_by(company_id="co").first()
        self.assertEqual(hr.name, "IT")   # untouched
        self.assertEqual(self.db.query(models.TicketDepartment).filter_by(id=dept_id).first().name, "IT Support")

    def test_deleting_a_ticket_department_does_not_touch_hr_departments(self):
        rows = T.add_ticket_department(T.TicketDepartmentIn(company_id="co", name="IT"),
                                       user=MANAGER, db=self.db)
        dept_id = rows[0]["id"]
        self.db.add(models.HrDepartment(id=str(uuid.uuid4()), company_id="co", name="IT"))
        self.db.commit()

        T.delete_ticket_department(dept_id, user=MANAGER, db=self.db)

        self.assertEqual(self.db.query(models.TicketDepartment).count(), 0)
        self.assertEqual(self.db.query(models.HrDepartment).count(), 1)   # still there

    def test_deleting_a_ticket_department_clears_it_off_tickets_filed_against_it(self):
        rows = T.add_ticket_department(T.TicketDepartmentIn(company_id="co", name="IT"),
                                       user=MANAGER, db=self.db)
        dept_id = rows[0]["id"]
        t = models.TaskTicket(id="t1", code="TIC-1", subject="s", status="open", priority="medium",
                              company_id="co", hr_department_id=dept_id,
                              created_at=now_iso(), modified_at=now_iso())
        self.db.add(t)
        self.db.commit()

        T.delete_ticket_department(dept_id, user=MANAGER, db=self.db)

        self.db.refresh(t)
        self.assertEqual(t.hr_department_id, "")

    def test_renaming_to_a_name_a_sibling_already_has_is_refused(self):
        T.add_ticket_department(T.TicketDepartmentIn(company_id="co", name="IT"), user=MANAGER, db=self.db)
        rows = T.add_ticket_department(T.TicketDepartmentIn(company_id="co", name="Accounting"), user=MANAGER, db=self.db)
        accounting_id = next(r["id"] for r in rows if r["name"] == "Accounting")

        with self.assertRaises(HTTPException) as ctx:
            T.update_ticket_department(accounting_id, T.TicketDepartmentUpdateIn(name="IT"), user=MANAGER, db=self.db)
        self.assertEqual(ctx.exception.status_code, 409)

    def test_the_list_endpoint_reads_ticket_departments_not_hr_departments(self):
        self.db.add(models.HrDepartment(id=str(uuid.uuid4()), company_id="co", name="From HR"))
        self.db.commit()
        T.add_ticket_department(T.TicketDepartmentIn(company_id="co", name="From Tickets"), user=MANAGER, db=self.db)

        rows = T.list_ticket_departments(user=MANAGER, db=self.db)

        self.assertEqual([r["name"] for r in rows], ["From Tickets"])


if __name__ == "__main__":
    unittest.main()
