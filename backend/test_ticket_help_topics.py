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

    # ── Sub-options (Neil, Oct 1 2026) ────────────────────────────────────
    def _it_topics(self):
        groups = ticket_taxonomy.get_config(self.db)["helpTopics"]
        return {tp["name"]: tp for tp in next(g for g in groups if "it" in g["departments"])["topics"]}

    def test_default_topics_use_end_user_names_and_carry_sub_options(self):
        it = self._it_topics()
        self.assertIn("Outlook", it["Microsoft (Outlook, Teams, OneDrive)"]["options"])
        self.assertIn("Accounts Payable", it["Sage Intacct"]["options"])
        self.assertIn("Tasks", it["Nexus"]["options"])
        self.assertIn("Cameras", it)
        self.assertIn("Gate Access", it)
        self.assertNotIn("Cameras or Gate Access", it)
        self.assertNotIn("options", it["Egnyte"])   # sub-options are optional

    def test_sub_options_are_saved_trimmed_and_deduped(self):
        ticket_taxonomy.save_config(self.db, {"helpTopics": [
            {"label": "IT", "departments": ["it"], "topics": [
                {"name": "Microsoft", "area": "email", "options": [" Outlook ", "outlook", "", "Teams"]},
                {"name": "Egnyte", "area": "files", "options": []}]},
        ]}, MANAGER["email"])
        it = self._it_topics()
        self.assertEqual(it["Microsoft"]["options"], ["Outlook", "Teams"])
        self.assertNotIn("options", it["Egnyte"])

    def test_too_many_or_too_long_sub_options_are_refused(self):
        for options in (["x" * 51], [f"o{n}" for n in range(ticket_taxonomy.OPTIONS_MAX + 1)], "Outlook"):
            with self.assertRaises(ticket_taxonomy.TaxonomyError):
                ticket_taxonomy.save_config(self.db, {"helpTopics": [
                    {"departments": ["it"], "topics": [{"name": "Microsoft", "area": "email", "options": options}]}]},
                    MANAGER["email"])

    def _save_v1(self, groups):
        """A config saved before sub-options existed (no helpTopicsVersion)."""
        import json
        self.db.add(models.NexusSetting(key="ticket_taxonomy_config", value=json.dumps({"helpTopics": groups})))
        self.db.commit()

    def test_a_v1_saved_list_is_upgraded_without_clobbering_admin_choices(self):
        self._save_v1([
            {"label": "IT Support", "departments": ["it"], "topics": [
                {"name": "Printer or Scanner", "area": "hardware"},
                {"name": "Microsoft 365 (Outlook, Teams, OneDrive)", "area": "email"},
                {"name": "Badge Printer", "area": "hardware"},
                {"name": "Cameras or Gate Access", "area": "security"},
                {"name": "Sage Intacct", "area": "finance"}]},
            {"label": "HR", "departments": ["hr"], "topics": [{"name": "Payroll", "area": "hr"}]},
        ])
        groups = ticket_taxonomy.get_config(self.db)["helpTopics"]
        it = [tp["name"] for tp in groups[0]["topics"]]
        # Admin's order and custom topic kept; the two Neil changes applied;
        # the topic added in v2 appended at the end.
        self.assertEqual(it, ["Printer or Scanner", "Microsoft (Outlook, Teams, OneDrive)", "Badge Printer",
                              "Cameras", "Gate Access", "Sage Intacct", "Access to a Nexus Module"])
        topics = {tp["name"]: tp for tp in groups[0]["topics"]}
        self.assertIn("Teams", topics["Microsoft (Outlook, Teams, OneDrive)"]["options"])
        self.assertIn("General Ledger", topics["Sage Intacct"]["options"])
        self.assertNotIn("options", topics["Badge Printer"])
        self.assertEqual(groups[1], {"label": "HR", "departments": ["hr"], "topics": [{"name": "Payroll", "area": "hr"}]})

    def test_a_saved_v2_list_is_never_upgraded_again(self):
        """Once saved with sub-options, an admin who removed a topic's options
        or the new topic keeps that choice."""
        ticket_taxonomy.save_config(self.db, {"helpTopics": [
            {"label": "IT", "departments": ["it"], "topics": [{"name": "Sage Intacct", "area": "finance"}]}]},
            MANAGER["email"])
        self.assertEqual(list(self._it_topics()), ["Sage Intacct"])
        self.assertNotIn("options", self._it_topics()["Sage Intacct"])

    def test_tickets_under_a_renamed_topic_keep_their_area(self):
        self.assertEqual(ticket_taxonomy.topic_area(self.db, "Cameras or Gate Access"), "security")
        self.assertEqual(ticket_taxonomy.topic_area(self.db, "Microsoft 365 (Outlook, Teams, OneDrive)"), "email")

    def test_a_topic_over_fifty_characters_is_refused(self):
        with self.assertRaises(ticket_taxonomy.TaxonomyError):
            ticket_taxonomy.save_config(self.db, {"helpTopics": [
                {"departments": ["it"], "topics": [{"name": "x" * 51, "area": "general"}]}]}, MANAGER["email"])


if __name__ == "__main__":
    unittest.main()
