"""
Unit tests for custom fields phase 1 - routers.task_config option normalization,
typed value coercion, and per-project scoping.

Uses a throwaway sqlite file so it never touches the real dev DB
(greens_nexus.db) or Supabase. No network needed.

Run with: python -m unittest test_custom_fields -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database
import models
from routers.task_config import (
    normalize_field_options, coerce_custom_field_values, field_applies_to,
)


class NormalizeOptionsTests(unittest.TestCase):
    def test_plain_strings_still_read_back(self):
        """Rows written before options carried colors hold bare strings - if
        those stopped normalizing, every existing select would render empty."""
        out = normalize_field_options(["Low", "High"])

        self.assertEqual([o["label"] for o in out], ["Low", "High"])
        self.assertEqual([o["id"] for o in out], ["Low", "High"])
        self.assertTrue(all(o["color"] for o in out))

    def test_objects_keep_their_color(self):
        out = normalize_field_options([{"id": "a", "label": "Alpha", "color": "#ff0000"}])
        self.assertEqual(out, [{"id": "a", "label": "Alpha", "color": "#ff0000"}])

    def test_missing_color_is_assigned_from_the_palette(self):
        out = normalize_field_options([{"label": "One"}, {"label": "Two"}])
        self.assertTrue(all(o["color"].startswith("#") for o in out))
        self.assertNotEqual(out[0]["color"], out[1]["color"])

    def test_blank_options_are_dropped(self):
        self.assertEqual(normalize_field_options(["", "  ", {"label": ""}, None]), [])


class CoerceValuesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.TaskCustomField).delete()
        self.db.add_all([
            models.TaskCustomField(id="f-num", name="Points", type="number"),
            models.TaskCustomField(id="f-date", name="Ship", type="date"),
            models.TaskCustomField(id="f-check", name="Billable", type="checkbox"),
            models.TaskCustomField(id="f-sel", name="Stage", type="select",
                                   options=[{"id": "s1", "label": "Design", "color": "#2563eb"},
                                            {"id": "s2", "label": "Build", "color": "#16a34a"}]),
            models.TaskCustomField(id="f-text", name="Notes", type="text"),
        ])
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_numbers_stop_being_strings(self):
        got = coerce_custom_field_values(self.db, {"f-num": "8"})
        self.assertEqual(got, {"f-num": 8})
        self.assertIsInstance(got["f-num"], int)

    def test_decimal_numbers_keep_their_fraction(self):
        self.assertEqual(coerce_custom_field_values(self.db, {"f-num": "2.5"}), {"f-num": 2.5})

    def test_unparseable_number_is_dropped_not_stored_wrong(self):
        self.assertEqual(coerce_custom_field_values(self.db, {"f-num": "eight"}), {})

    def test_checkbox_accepts_the_shapes_widgets_send(self):
        for raw, want in ((True, True), ("true", True), ("on", True), (False, False), ("no", False)):
            self.assertEqual(coerce_custom_field_values(self.db, {"f-check": raw}),
                             {"f-check": want}, raw)

    def test_dates_are_truncated_to_a_plain_day(self):
        self.assertEqual(coerce_custom_field_values(self.db, {"f-date": "2026-08-01T00:00:00Z"}),
                         {"f-date": "2026-08-01"})

    def test_select_accepts_an_option_id(self):
        self.assertEqual(coerce_custom_field_values(self.db, {"f-sel": "s1"}), {"f-sel": "s1"})

    def test_select_accepts_a_label_and_stores_the_id(self):
        """The task editors have always sent plain labels - accepting them keeps
        existing clients working while normalizing what lands in the column."""
        self.assertEqual(coerce_custom_field_values(self.db, {"f-sel": "Build"}), {"f-sel": "s2"})

    def test_select_value_that_is_no_longer_an_option_is_dropped(self):
        """Editing a field used to leave tasks holding dead option labels that no
        grouping or rollup could make sense of."""
        self.assertEqual(coerce_custom_field_values(self.db, {"f-sel": "Retired"}), {})

    def test_unknown_field_ids_are_dropped(self):
        self.assertEqual(coerce_custom_field_values(self.db, {"f-deleted": "x"}), {})

    def test_empty_values_are_dropped_rather_than_stored_blank(self):
        self.assertEqual(coerce_custom_field_values(self.db, {"f-text": "", "f-num": None}), {})

    def test_non_dict_input_is_tolerated(self):
        """Inbound Asana tasks come through the same create path; this must never
        raise, whatever it's handed."""
        for bad in (None, [], "", 0):
            self.assertEqual(coerce_custom_field_values(self.db, bad), {})

    def test_a_full_mixed_payload_round_trips(self):
        got = coerce_custom_field_values(self.db, {
            "f-num": "3", "f-date": "2026-09-30", "f-check": "true",
            "f-sel": "Design", "f-text": 42,
        })
        self.assertEqual(got, {"f-num": 3, "f-date": "2026-09-30", "f-check": True,
                               "f-sel": "s1", "f-text": "42"})


class ScopingTests(unittest.TestCase):
    def test_empty_project_ids_means_every_project(self):
        """The pre-scoping behavior. Upgrading must not hide anyone's fields."""
        f = models.TaskCustomField(id="f", name="Global", type="text", project_ids=[])
        self.assertTrue(field_applies_to(f, "proj-1"))
        self.assertTrue(field_applies_to(f, ""))

    def test_a_scoped_field_only_applies_to_its_projects(self):
        f = models.TaskCustomField(id="f", name="Scoped", type="text", project_ids=["proj-1"])
        self.assertTrue(field_applies_to(f, "proj-1"))
        self.assertFalse(field_applies_to(f, "proj-2"))
        self.assertFalse(field_applies_to(f, ""))

    def test_blank_entries_do_not_make_a_field_look_scoped(self):
        f = models.TaskCustomField(id="f", name="Sloppy", type="text", project_ids=["", None])
        self.assertTrue(field_applies_to(f, "proj-9"))


if __name__ == "__main__":
    unittest.main()
