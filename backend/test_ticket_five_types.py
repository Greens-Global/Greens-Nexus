"""
Only five ticket types exist (Oct 1 2026): Incident, Bug Report, Feature
Request, Access Request, Other. The intake order an admin saves can switch on
only those - a retired type (service_request, change_request...) is dropped on
save AND on read, so an order saved before then stops offering it.

Uses a throwaway sqlite file. No network.
"""
import json
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database
import models
import ticket_taxonomy

WHO = "manager@greensglobal.com"


class FiveTypesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.NexusSetting).delete()
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_the_five(self):
        self.assertEqual(ticket_taxonomy.TICKET_TYPES,
                         ("incident", "bug", "feature_request", "access_request", "other"))

    def test_saving_keeps_only_the_five_once_each_in_order(self):
        ticket_taxonomy.save_config(self.db, {"typeOrder": [
            "bug", "service_request", "incident", "change_request", "bug", " other "]}, WHO)
        self.assertEqual(ticket_taxonomy.get_config(self.db)["typeOrder"], ["bug", "incident", "other"])

    def test_turning_every_type_off_is_refused(self):
        for order in ([], ["service_request", "change_request"], "incident"):
            with self.assertRaises(ticket_taxonomy.TaxonomyError):
                ticket_taxonomy.save_config(self.db, {"typeOrder": order}, WHO)

    def test_no_saved_order_means_the_default(self):
        ticket_taxonomy.save_config(self.db, {"typeOrder": None}, WHO)
        self.assertIsNone(ticket_taxonomy.get_config(self.db)["typeOrder"])

    def test_an_order_saved_before_drops_retired_types_on_read(self):
        # What dev holds today: Incident, Bug, Service Request, Change on.
        self.db.add(models.NexusSetting(key="ticket_taxonomy_config", value=json.dumps(
            {"typeOrder": ["incident", "bug", "service_request", "change_request"]})))
        self.db.commit()
        self.assertEqual(ticket_taxonomy.get_config(self.db)["typeOrder"], ["incident", "bug"])

    def test_an_old_order_with_none_of_the_five_reads_as_default(self):
        self.db.add(models.NexusSetting(key="ticket_taxonomy_config", value=json.dumps(
            {"typeOrder": ["service_request"]})))
        self.db.commit()
        self.assertIsNone(ticket_taxonomy.get_config(self.db)["typeOrder"])


if __name__ == "__main__":
    unittest.main()
