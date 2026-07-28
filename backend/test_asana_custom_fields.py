"""
Unit tests for phase 3 — generic Nexus custom fields <-> Asana custom_fields.

The property that matters most here is loop prevention. CLAUDE.md records that
using the wrong digest for inbound comparison made every pull re-apply every
task forever; adding a whole new class of synced field is exactly where that
class of bug comes back, so several tests below assert digest STABILITY rather
than any visible behavior.

Uses a throwaway sqlite file. No network.

Run with: python -m unittest test_asana_custom_fields -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database
import models
import asana_sync
from routers.task_util import gen_id, now_iso

PROJ = "proj-1"


def enum_cf(name, value, options=None):
    return {"name": name, "resource_subtype": "enum",
            "enum_value": {"name": value} if value else None,
            "enum_options": [{"name": o} for o in (options or [])]}


class AsanaCustomFieldTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskCustomField, models.Task, models.AsanaTaskLink):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _field(self, name):
        return next((f for f in self.db.query(models.TaskCustomField).all()
                     if f.name == name), None)

    # ── inbound ─────────────────────────────────────────────────────────
    def test_an_asana_enum_field_creates_a_scoped_nexus_field(self):
        at = {"gid": "g1", "custom_fields": [enum_cf("Stage", "Build", ["Design", "Build"])]}

        got = asana_sync._inbound_custom_fields(self.db, at, PROJ)

        f = self._field("Stage")
        self.assertIsNotNone(f)
        self.assertEqual(f.type, "select")
        self.assertEqual(f.project_ids, [PROJ])   # scoped, not global
        self.assertEqual(got, {f.id: "Build"})

    def test_an_existing_nexus_field_is_adopted_not_duplicated(self):
        self.db.add(models.TaskCustomField(id="mine", name="Stage", type="select",
                                           options=[{"id": "Design", "label": "Design", "color": "#111"}],
                                           project_ids=["other-proj"]))
        self.db.commit()

        got = asana_sync._inbound_custom_fields(
            self.db, {"custom_fields": [enum_cf("Stage", "Design", ["Design"])]}, PROJ)

        self.assertEqual(len(self.db.query(models.TaskCustomField).all()), 1)
        self.assertEqual(got, {"mine": "Design"})
        # scope widened to cover the project it just arrived from
        self.assertIn(PROJ, self._field("Stage").project_ids)

    def test_a_new_asana_option_is_absorbed_into_an_existing_field(self):
        self.db.add(models.TaskCustomField(id="mine", name="Stage", type="select",
                                           options=[{"id": "Design", "label": "Design", "color": "#111"}],
                                           project_ids=[PROJ]))
        self.db.commit()

        asana_sync._inbound_custom_fields(
            self.db, {"custom_fields": [enum_cf("Stage", "Ship", ["Design", "Ship"])]}, PROJ)

        labels = [o["label"] for o in self._field("Stage").options]
        self.assertEqual(labels, ["Design", "Ship"])

    def test_reserved_fields_never_become_custom_fields(self):
        """Task Progress and Priority already drive native status/priority —
        mapping them again would store each value twice and let the two fight."""
        at = {"custom_fields": [enum_cf("Task Progress", "In Progress"),
                                enum_cf("Priority", "High"),
                                enum_cf("Stage", "Build")]}

        got = asana_sync._inbound_custom_fields(self.db, at, PROJ)

        names = [f.name for f in self.db.query(models.TaskCustomField).all()]
        self.assertEqual(names, ["Stage"])
        self.assertEqual(len(got), 1)

    def test_unsupported_asana_types_are_skipped_not_flattened(self):
        at = {"custom_fields": [
            {"name": "Teams", "resource_subtype": "multi_enum", "enum_value": None},
            {"name": "Owner", "resource_subtype": "people"},
        ]}

        self.assertEqual(asana_sync._inbound_custom_fields(self.db, at, PROJ), {})
        self.assertEqual(self.db.query(models.TaskCustomField).count(), 0)

    def test_empty_values_create_nothing(self):
        at = {"custom_fields": [enum_cf("Stage", None), {"name": "Notes", "resource_subtype": "text", "text_value": ""}]}

        self.assertEqual(asana_sync._inbound_custom_fields(self.db, at, PROJ), {})
        self.assertEqual(self.db.query(models.TaskCustomField).count(), 0)

    def test_number_and_date_values_are_typed(self):
        at = {"custom_fields": [
            {"name": "Points", "resource_subtype": "number", "number_value": 5.0},
            {"name": "Ship", "resource_subtype": "date", "date_value": {"date": "2026-09-01"}},
        ]}

        got = asana_sync._inbound_custom_fields(self.db, at, PROJ)

        self.assertEqual(got[self._field("Points").id], 5)
        self.assertIsInstance(got[self._field("Points").id], int)
        self.assertEqual(got[self._field("Ship").id], "2026-09-01")

    # ── loop prevention ─────────────────────────────────────────────────
    def test_the_same_payload_twice_produces_the_same_digest(self):
        """If this drifts, every pull re-applies every task forever — the exact
        failure CLAUDE.md records for the Task Progress field."""
        at = {"name": "T", "custom_fields": [enum_cf("Stage", "Build", ["Design", "Build"])]}

        first = asana_sync._inbound_custom_fields(self.db, at, PROJ)
        second = asana_sync._inbound_custom_fields(self.db, at, PROJ)

        self.assertEqual(first, second)
        self.assertEqual(asana_sync._fields_digest(first), asana_sync._fields_digest(second))

    def test_digest_is_order_independent(self):
        a = asana_sync._fields_digest({"f1": "x", "f2": "y"})
        b = asana_sync._fields_digest({"f2": "y", "f1": "x"})
        self.assertEqual(a, b)

    def test_digest_ignores_empty_values(self):
        self.assertEqual(asana_sync._fields_digest({"f1": "x", "f2": "", "f3": None}),
                         asana_sync._fields_digest({"f1": "x"}))

    def test_a_value_change_does_change_the_digest(self):
        self.assertNotEqual(asana_sync._fields_digest({"f1": "x"}),
                            asana_sync._fields_digest({"f1": "y"}))

    def test_inbound_is_additive_and_keeps_nexus_only_values(self):
        """A field Asana doesn't carry must survive the pull — otherwise every
        pull wipes any field that only exists in Nexus."""
        self.db.add(models.TaskCustomField(id="nx", name="Nexus Only", type="text", project_ids=[]))
        self.db.commit()
        t = models.Task(id=gen_id(), title="T", project_id=PROJ,
                        custom_field_values={"nx": "keep me"}, created_at=now_iso())
        self.db.add(t)
        self.db.add(models.AsanaTaskLink(id=gen_id(), nexus_task_id=t.id, asana_gid="g9",
                                         last_inbound_hash="stale"))
        self.db.commit()

        counts = {"created": 0, "updated": 0, "comments": 0, "activities": 0,
                  "attachments": 0, "deleted": 0}
        asana_sync._apply_inbound(self.db, {"gid": "g9", "name": "T",
                                            "custom_fields": [enum_cf("Stage", "Build")]},
                                  PROJ, counts)

        vals = self.db.get(models.Task, t.id).custom_field_values
        self.assertEqual(vals.get("nx"), "keep me")
        self.assertEqual(vals.get(self._field("Stage").id), "Build")

    def test_repeated_pulls_are_a_no_op_and_do_not_bounce_back_out(self):
        """The end-to-end version of the loop guarantee, and the one that would
        actually have caught the historical bug: pull the same payload three
        times and nothing re-applies, both hashes stay put, and a push straight
        afterwards sees no change — so inbound can't ping-pong into outbound."""
        at = {"gid": "g1", "name": "Task",
              "custom_fields": [enum_cf("Stage", "Build", ["Design", "Build"]),
                                {"name": "Points", "resource_subtype": "number", "number_value": 3.0}]}
        counts = {"created": 0, "updated": 0, "comments": 0, "activities": 0,
                  "attachments": 0, "deleted": 0}

        tid = asana_sync._apply_inbound(self.db, at, PROJ, counts)
        self.db.commit()
        link = asana_sync._link_by_asana(self.db, "g1")
        first_hash, first_inbound = link.last_hash, link.last_inbound_hash

        for _ in range(2):
            asana_sync._apply_inbound(self.db, at, PROJ, counts)
            self.db.commit()

        link = asana_sync._link_by_asana(self.db, "g1")
        self.assertEqual(counts["updated"], 0)
        self.assertEqual(link.last_inbound_hash, first_inbound)
        self.assertEqual(link.last_hash, first_hash)
        # An outbound push right now must find nothing to send.
        self.assertEqual(asana_sync._task_digest(self.db, self.db.get(models.Task, tid)),
                         link.last_hash)

    # ── outbound ────────────────────────────────────────────────────────
    def _cfg_and_settings(self, settings):
        class Cfg:
            token, workspace_gid, enabled, delete_sync, default_project_gid = "t", "", True, False, ""
        asana_sync._PROGRESS_FIELD_CACHE[("t", "A1")] = (asana_sync.time.time(), settings)
        return Cfg()

    def test_outbound_maps_a_select_to_the_asana_option_gid(self):
        f = models.TaskCustomField(id="f1", name="Stage", type="select",
                                   options=[{"id": "Build", "label": "Build", "color": "#111"}],
                                   project_ids=[PROJ])
        self.db.add(f)
        t = models.Task(id="t1", title="T", project_id=PROJ, custom_field_values={"f1": "Build"})
        self.db.add(t)
        self.db.commit()
        cfg = self._cfg_and_settings([{"custom_field": {
            "gid": "CF1", "name": "Stage", "resource_subtype": "enum",
            "enum_options": [{"gid": "OPT_BUILD", "name": "Build"}]}}])

        self.assertEqual(asana_sync._outbound_custom_fields(self.db, cfg, t, "A1"),
                         {"CF1": "OPT_BUILD"})

    def test_outbound_skips_a_field_asana_does_not_have(self):
        """Never invent fields in a shared Asana workspace — a Nexus-only field
        simply doesn't travel."""
        self.db.add(models.TaskCustomField(id="f1", name="Nexus Only", type="text", project_ids=[PROJ]))
        t = models.Task(id="t1", title="T", project_id=PROJ, custom_field_values={"f1": "x"})
        self.db.add(t)
        self.db.commit()
        cfg = self._cfg_and_settings([])

        self.assertEqual(asana_sync._outbound_custom_fields(self.db, cfg, t, "A1"), {})

    def test_outbound_never_touches_the_reserved_fields(self):
        self.db.add(models.TaskCustomField(id="f1", name="Priority", type="select",
                                           options=[{"id": "High", "label": "High", "color": "#111"}],
                                           project_ids=[PROJ]))
        t = models.Task(id="t1", title="T", project_id=PROJ, custom_field_values={"f1": "High"})
        self.db.add(t)
        self.db.commit()
        cfg = self._cfg_and_settings([{"custom_field": {
            "gid": "CFP", "name": "Priority", "resource_subtype": "enum",
            "enum_options": [{"gid": "OPT_HIGH", "name": "High"}]}}])

        self.assertEqual(asana_sync._outbound_custom_fields(self.db, cfg, t, "A1"), {})

    def test_outbound_types_number_and_date_the_way_asana_expects(self):
        self.db.add_all([
            models.TaskCustomField(id="fn", name="Points", type="number", project_ids=[PROJ]),
            models.TaskCustomField(id="fd", name="Ship", type="date", project_ids=[PROJ]),
        ])
        t = models.Task(id="t1", title="T", project_id=PROJ,
                        custom_field_values={"fn": 5, "fd": "2026-09-01"})
        self.db.add(t)
        self.db.commit()
        cfg = self._cfg_and_settings([
            {"custom_field": {"gid": "CFN", "name": "Points", "resource_subtype": "number"}},
            {"custom_field": {"gid": "CFD", "name": "Ship", "resource_subtype": "date"}},
        ])

        self.assertEqual(asana_sync._outbound_custom_fields(self.db, cfg, t, "A1"),
                         {"CFN": 5, "CFD": {"date": "2026-09-01"}})

    def test_outbound_is_empty_without_a_project_gid(self):
        t = models.Task(id="t1", title="T", custom_field_values={"f1": "x"})
        self.db.add(t)
        self.db.commit()

        class Cfg:
            token = "t"
        self.assertEqual(asana_sync._outbound_custom_fields(self.db, Cfg(), t, ""), {})


if __name__ == "__main__":
    unittest.main()
