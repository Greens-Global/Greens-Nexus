"""
Ticket departments come from the company's GLOBAL department list (Neil,
Oct 1 2026: "the departments should come from global... and then have the
option of turning it off. Like, I don't want a construction ticket.").

Replaces the Sept 13 behavior where ticket_departments was an independent
copy. Now:
  - the names/list come from HrDepartment (Settings > Company Settings);
  - ticket_departments keeps only the Tickets module's settings per global
    department (enabled, lead/backup, intake order), keyed by the same id;
  - adding/renaming/deleting from the ticket desk is refused (410);
  - departments created only in the ticket desk before the merge are promoted
    into the global list once, so nothing disappears.

Throwaway sqlite. No network.

Run with: python -m pytest test_ticket_departments_global.py
"""
import os
import tempfile
import unittest
import uuid

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import atexit

from fastapi import HTTPException

import database
import models
from routers import tickets as T

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


CO, OTHER = "co-greens", "co-other"
ME = "requester@greensglobal.com"
MANAGER = {"email": "manager@greensglobal.com", "level": 3}


class GlobalDepartmentTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.NexusEmployee, models.TicketDepartment, models.HrDepartment,
                  models.TaskTicket, models.NexusSetting):
            self.db.query(m).delete()
        self.db.commit()
        self.db.add(models.NexusEmployee(id=str(uuid.uuid4()), first_name="Req", work_email=ME,
                                         company=CO, status="active"))
        for n, name in enumerate(("IT", "Construction", "Admin")):
            self.db.add(models.HrDepartment(id=f"g{n}", company_id=CO, name=name, sort_order=n))
        self.db.add(models.HrDepartment(id="o1", company_id=OTHER, name="Payroll", sort_order=0))
        self.db.commit()

    def _intake(self):
        return [d["name"] for d in T.list_ticket_departments(mine=True, user={"email": ME}, db=self.db)]

    def _settings(self, company=CO):
        return T._dept_list(self.db, company)

    def _hr(self, dept_id):
        self.db.expire_all()
        return self.db.query(models.HrDepartment).filter_by(id=dept_id).first()

    # ── the list comes from global ────────────────────────────────────────
    def test_global_departments_are_offered_without_any_ticket_setup(self):
        self.assertEqual(self._intake(), ["IT", "Construction", "Admin"])

    def test_a_department_added_globally_appears_in_tickets(self):
        self._intake()
        self.db.add(models.HrDepartment(id="g9", company_id=CO, name="Marketing", sort_order=9))
        self.db.commit()
        self.assertIn("Marketing", self._intake())
        row = next(d for d in self._settings() if d["id"] == "g9")
        self.assertTrue(row["enabled"])

    def test_rename_in_global_shows_in_tickets(self):
        self._intake()
        g = self._hr("g0")
        g.name = "Information Technology"
        self.db.commit()
        self.assertEqual(self._intake()[0], "Information Technology")
        # The settings row mirrors it too, so older readers (ticket emails)
        # print the current name.
        self.db.expire_all()
        self.assertEqual(self.db.query(models.TicketDepartment).filter_by(id="g0").one().name,
                         "Information Technology")

    def test_global_name_wins_over_a_rename_made_in_the_ticket_copy(self):
        self.db.add(models.TicketDepartment(id="g1", company_id=CO, name="Build Team", sort_order=1))
        self.db.commit()
        names = [d["name"] for d in self._settings()]
        self.assertIn("Construction", names)
        self.assertNotIn("Build Team", names)

    def test_another_companys_departments_are_never_offered(self):
        self.assertNotIn("Payroll", self._intake())

    # ── the on/off switch ─────────────────────────────────────────────────
    def test_disable_hides_from_intake_but_not_from_settings(self):
        rows = T.update_ticket_department("g1", T.TicketDepartmentUpdate(enabled=False),
                                          user=MANAGER, db=self.db)
        self.assertFalse(next(d for d in rows if d["id"] == "g1")["enabled"])
        self.assertEqual(self._intake(), ["IT", "Admin"])
        self.assertIn("Construction", [d["name"] for d in self._settings()])
        # The global list itself is untouched.
        self.assertIsNotNone(self._hr("g1"))

    def test_a_disabled_department_still_names_existing_tickets(self):
        T.update_ticket_department("g1", T.TicketDepartmentUpdate(enabled=False), user=MANAGER, db=self.db)
        everything = T.list_ticket_departments(user={"email": ME}, db=self.db)
        self.assertEqual(next(d for d in everything if d["id"] == "g1")["name"], "Construction")
        self.assertEqual(T.dept_name(self.db, "g1"), "Construction")

    def test_turning_it_back_on_offers_it_again(self):
        T.update_ticket_department("g1", T.TicketDepartmentUpdate(enabled=False), user=MANAGER, db=self.db)
        T.update_ticket_department("g1", T.TicketDepartmentUpdate(enabled=True), user=MANAGER, db=self.db)
        self.assertIn("Construction", self._intake())

    def test_lead_email_is_still_a_ticket_setting(self):
        T.update_ticket_department("g0", T.TicketDepartmentUpdate(lead_email=" Lead@GreensGlobal.com "),
                                   user=MANAGER, db=self.db)
        self.assertEqual(self.db.query(models.TicketDepartment).filter_by(id="g0").one().lead_email,
                         "lead@greensglobal.com")

    def test_ticket_order_is_its_own(self):
        rows = T.reorder_ticket_departments(T.TicketDepartmentOrder(company_id=CO, ids=["g2", "g0", "g1"]),
                                            user=MANAGER, db=self.db)
        self.assertEqual([d["id"] for d in rows], ["g2", "g0", "g1"])
        self.assertEqual(self._hr("g0").sort_order, 0)   # global order untouched

    # ── the list is no longer edited from the ticket desk ─────────────────
    def test_add_rename_and_delete_are_refused(self):
        for call in (
            lambda: T.add_ticket_department(T.TicketDepartmentIn(company_id=CO, name="QA"), user=MANAGER, db=self.db),
            lambda: T.update_ticket_department("g0", T.TicketDepartmentUpdate(name="Tech"), user=MANAGER, db=self.db),
            lambda: T.delete_ticket_department("g0", user=MANAGER, db=self.db),
        ):
            with self.assertRaises(HTTPException) as e:
                call()
            self.assertEqual(e.exception.status_code, 410)
        self.assertEqual(self._hr("g0").name, "IT")

    def test_deleted_globally_leaves_intake_but_keeps_its_name_for_old_tickets(self):
        self._intake()
        self.db.delete(self._hr("g2"))
        self.db.commit()
        self.assertNotIn("Admin", self._intake())
        self.assertNotIn("g2", [d["id"] for d in self._settings()])
        everything = T.list_ticket_departments(user={"email": ME}, db=self.db)
        row = next(d for d in everything if d["id"] == "g2")
        self.assertTrue(row["removed"])
        self.assertEqual(row["name"], "Admin")

    # ── legacy ticket-only departments ────────────────────────────────────
    def test_ticket_only_legacy_departments_are_preserved(self):
        """Created in the ticket desk after the Sept 13 split: promoted into
        the global list with the same id, so the tickets filed against it
        still resolve and it stays pickable."""
        self.db.add(models.TicketDepartment(id="legacy1", company_id=CO, name="Security", sort_order=5,
                                            lead_email="sec@greensglobal.com"))
        self.db.add(models.TaskTicket(id="t1", code="1", subject="Gate", hr_department_id="legacy1"))
        self.db.commit()
        self.assertIn("Security", self._intake())
        g = self._hr("legacy1")
        self.assertIsNotNone(g)
        self.assertEqual((g.company_id, g.name), (CO, "Security"))
        self.assertEqual(self.db.query(models.TaskTicket).filter_by(id="t1").one().hr_department_id, "legacy1")
        self.assertEqual(self.db.query(models.TicketDepartment).filter_by(id="legacy1").one().lead_email,
                         "sec@greensglobal.com")

    def test_a_legacy_duplicate_of_a_global_department_is_merged(self):
        self.db.add(models.TicketDepartment(id="dup", company_id=CO, name="it ", sort_order=7,
                                            lead_email="it.lead@greensglobal.com"))
        self.db.add(models.TaskTicket(id="t2", code="2", subject="Laptop", hr_department_id="dup"))
        self.db.commit()
        self.assertEqual(self._intake().count("IT"), 1)
        self.db.expire_all()
        self.assertEqual(self.db.query(models.TaskTicket).filter_by(id="t2").one().hr_department_id, "g0")
        self.assertEqual(self.db.query(models.TicketDepartment).filter_by(id="g0").one().lead_email,
                         "it.lead@greensglobal.com")
        self.assertIsNone(self.db.query(models.TicketDepartment).filter_by(id="dup").first())

    def test_promotion_runs_once_so_a_later_global_delete_sticks(self):
        self._intake()   # the one-time promotion has run
        self.db.add(models.TicketDepartment(id="late", company_id=CO, name="Ghost", sort_order=9))
        self.db.commit()
        self.assertNotIn("Ghost", self._intake())
        self.assertIsNone(self._hr("late"))


if __name__ == "__main__":
    unittest.main()
