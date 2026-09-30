"""
Ticket Manager settings (Sep 30): departments are reordered by dragging
(one "save this order" call), and each department's "What do you need help
with?" topics are saved in the ticket taxonomy config, where the server reads
a picked topic's service area from.

Uses a throwaway sqlite file. No network.
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database
import models
import ticket_taxonomy
from routers import tickets as T

MANAGER = {"email": "manager@greensglobal.com", "level": 3}


class HelpTopicsAndOrderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TicketDepartment, models.NexusSetting):
            self.db.query(m).delete()
        for n, (dept_id, name) in enumerate([("d1", "Operations"), ("d2", "IT"), ("d3", "Accounts"), ("d4", "Construction")]):
            self.db.add(models.TicketDepartment(id=dept_id, company_id="c1", name=name, sort_order=0 if n < 2 else n))
        self.db.add(models.TicketDepartment(id="x1", company_id="c2", name="IT", sort_order=0))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _order(self, ids):
        return [d["id"] for d in T.reorder_ticket_departments(
            T.TicketDepartmentOrder(company_id="c1", ids=ids), user=MANAGER, db=self.db)]

    def test_saves_the_dragged_order(self):
        self.assertEqual(self._order(["d2", "d4", "d1", "d3"]), ["d2", "d4", "d1", "d3"])

    def test_a_department_left_out_keeps_its_place_after_the_rest(self):
        self.assertEqual(self._order(["d4", "d2"]), ["d4", "d2", "d1", "d3"])

    def test_another_companys_id_is_ignored(self):
        self.assertEqual(self._order(["x1", "d3", "d2", "d1", "d4"]), ["d3", "d2", "d1", "d4"])
        other = self.db.query(models.TicketDepartment).filter_by(id="x1").one()
        self.assertEqual(other.sort_order, 0)

    def test_default_topics_carry_their_area(self):
        self.assertEqual(ticket_taxonomy.topic_area(self.db, "plumbing or water leak"), "facilities")
        self.assertEqual(T.service_area_for(self.db, "Plumbing or Water Leak"), "facilities")
        self.assertEqual(ticket_taxonomy.topic_area(self.db, "Front gate keypad"), "")

    def test_saved_topics_replace_the_defaults(self):
        ticket_taxonomy.save_config(self.db, {"helpTopics": [
            {"label": "HR", "departments": ["HR"], "topics": [{"name": " Payroll ", "area": "HR"}, {"name": ""}]},
        ]}, MANAGER["email"])
        groups = ticket_taxonomy.get_config(self.db)["helpTopics"]
        self.assertEqual(groups, [{"label": "HR", "departments": ["hr"], "topics": [{"name": "Payroll", "area": "hr"}]}])
        self.assertEqual(T.service_area_for(self.db, "payroll"), "hr")
        # Plumbing is no longer a curated topic - it reads as a typed answer.
        self.assertEqual(ticket_taxonomy.topic_area(self.db, "Plumbing or Water Leak"), "")

    def test_a_topic_over_fifty_characters_is_refused(self):
        with self.assertRaises(ticket_taxonomy.TaxonomyError):
            ticket_taxonomy.save_config(self.db, {"helpTopics": [
                {"departments": ["it"], "topics": [{"name": "x" * 51, "area": "general"}]}]}, MANAGER["email"])


if __name__ == "__main__":
    unittest.main()
