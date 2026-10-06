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

    # ── a topic's extra questions (Oct 1) ───────────────────────────────────
    def _save_questions(self, questions):
        ticket_taxonomy.save_config(self.db, {"helpTopics": [
            {"label": "IT", "departments": ["it"], "topics": [
                {"name": "Cameras", "area": "security", "questions": questions},
                {"name": "Egnyte", "area": "files"}]},
        ]}, MANAGER["email"])
        return self._it_topics()

    def test_topic_questions_are_saved_cleaned_with_keys(self):
        it = self._save_questions([
            {"key": "svc_facility", "label": " Which facility? ", "type": "site", "req": True, "types": ["incident"]},
            {"label": "Which camera?", "type": "select", "options": ["Front Gate", " front gate ", "Office"]},
            {"label": "", "type": "text"},
        ])
        qs = it["Cameras"]["questions"]
        self.assertEqual([q["label"] for q in qs], ["Which facility?", "Which camera?"])
        self.assertEqual(qs[0], {"key": "svc_facility", "label": "Which facility?", "type": "site", "req": True, "types": ["incident"]})
        self.assertEqual(qs[1]["key"], "svc_whichCamera")
        self.assertEqual(qs[1]["options"], ["Front Gate", "Office"])
        self.assertFalse(qs[1]["req"])
        # A topic nobody edited carries no list - it keeps asking its area's.
        self.assertNotIn("questions", it["Egnyte"])

    def test_an_empty_question_list_is_kept_meaning_ask_nothing(self):
        self.assertEqual(self._save_questions([])["Cameras"]["questions"], [])

    def test_keys_never_collide_or_take_the_which_one_key(self):
        qs = self._save_questions([
            {"key": "svc_helpSubtopic", "label": "Door", "type": "text"},
            {"key": "svc_x", "label": "One", "type": "text"},
            {"key": "svc_x", "label": "Two", "type": "text"},
            {"key": "not a key", "label": "Three", "type": "text"},
        ])["Cameras"]["questions"]
        keys = [q["key"] for q in qs]
        self.assertEqual(len(set(keys)), 4)
        self.assertNotIn("svc_helpSubtopic", keys)
        self.assertTrue(all(k.startswith("svc_") for k in keys))

    def test_bad_questions_are_refused(self):
        for questions in (
            "Which door?",
            [{"label": "Which door?", "type": "person"}],
            [{"label": "Which door?", "type": "select", "options": []}],
            [{"label": "x" * 121, "type": "text"}],
            [{"label": f"Q{n}", "type": "text"} for n in range(ticket_taxonomy.QUESTIONS_MAX + 1)],
        ):
            with self.assertRaises(ticket_taxonomy.TaxonomyError):
                self._save_questions(questions)

    def test_the_activity_feed_reads_a_question_by_its_label(self):
        self._save_questions([{"key": "svc_whichDoor", "label": "Which door?", "type": "text"}])
        self.assertEqual(ticket_taxonomy.question_label(self.db, "svc_whichDoor"), "Which door?")
        self.assertEqual(ticket_taxonomy.question_label(self.db, "svc_nope"), "")

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

    def test_a_saved_v2_list_gains_only_the_v3_maintenance_topics(self):
        """Property Walkthrough (Oct 2026): a v2 config gets Painting, Flooring
        or Tile, Appliances and Railings or Stairs on its building group - and
        nothing else is re-applied (an IT topic's removed options stay removed)."""
        import json
        self.db.add(models.NexusSetting(key="ticket_taxonomy_config", value=json.dumps({
            "helpTopicsVersion": 2, "helpTopics": [
                {"label": "IT", "departments": ["it"], "topics": [{"name": "Sage Intacct", "area": "finance"}]},
                {"label": "Maintenance", "departments": ["maintenance"],
                 "topics": [{"name": "Signs", "area": "facilities"}, {"name": "Painting", "area": "facilities"}]}]})))
        self.db.commit()
        groups = ticket_taxonomy.get_config(self.db)["helpTopics"]
        self.assertEqual(groups[0]["topics"], [{"name": "Sage Intacct", "area": "finance"}])
        self.assertEqual([tp["name"] for tp in groups[1]["topics"]],
                         ["Signs", "Painting", "Flooring or Tile", "Appliances", "Railings or Stairs"])

    def test_tickets_under_a_renamed_topic_keep_their_area(self):
        self.assertEqual(ticket_taxonomy.topic_area(self.db, "Cameras or Gate Access"), "security")
        self.assertEqual(ticket_taxonomy.topic_area(self.db, "Microsoft 365 (Outlook, Teams, OneDrive)"), "email")

    def test_a_topic_over_fifty_characters_is_refused(self):
        with self.assertRaises(ticket_taxonomy.TaxonomyError):
            ticket_taxonomy.save_config(self.db, {"helpTopics": [
                {"departments": ["it"], "topics": [{"name": "x" * 51, "area": "general"}]}]}, MANAGER["email"])


if __name__ == "__main__":
    unittest.main()
