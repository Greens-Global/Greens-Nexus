"""Site Models router - the customer view must never leak occupancy, the model
directory must list every property, and the live Cubby merge must keep the
model's geometry while taking occupancy from Cubby. Pure functions, no database."""
import os
import unittest
from unittest import mock

import cubby_client
from routers import site_models

PROPERTIES = ("greens-storage-escondido", "greens-storage-valley-center", "greens-storage-temecula",
              "greens-storage-murrieta", "greens-storage-fairfield")


class SiteModelTests(unittest.TestCase):
    def test_escondido_model_lists_and_loads(self):
        ids = [m["id"] for m in site_models.list_models()]
        self.assertIn("greens-storage-escondido", ids)
        model = site_models.load_model("greens-storage-escondido")
        self.assertEqual(len(model["units"]), 884)
        self.assertTrue(all("u" in u and "v" in u and "f" in u for u in model["units"]))
        names = {u["n"] for u in model["units"]}
        self.assertIn("C214", names)
        self.assertIn("G012", names)

    def test_public_view_strips_occupancy(self):
        pub = site_models.public_view(site_models.load_model("greens-storage-escondido"))
        for u in pub["units"]:
            for secret in ("l", "r", "why", "note", "dvac"):
                self.assertNotIn(secret, u)
        self.assertNotIn("flags", pub["layout"])
        self.assertNotIn("cubbyFacilityId", pub["property"])
        self.assertNotIn("apn", pub["property"])
        for b in pub["buildings"]:
            self.assertNotIn("note", b)
            self.assertNotIn("inferred", b)
            self.assertNotIn("ll", b)
        self.assertEqual(len(pub["units"]), 884)
        self.assertTrue(pub["buildings"] and pub["parcel"] and pub["gates"])

    def test_every_property_has_a_model_with_every_unit_placed(self):
        ids = [m["id"] for m in site_models.list_models()]
        for pid in PROPERTIES:
            self.assertIn(pid, ids)
            model = site_models.load_model(pid)
            self.assertTrue(model["units"], pid)
            self.assertTrue(model["property"]["cubbyFacilityId"].startswith("fac_"), pid)
            self.assertTrue(model["parcels"] and model["gates"], pid)
            for u in model["units"]:
                self.assertTrue(u["wu"] > 0 and u["dv"] > 0, (pid, u["n"]))
                self.assertIn(u["door"], ("sw", "ne", "both", "w", "e"))

    def test_without_a_cubby_key_the_model_is_a_snapshot(self):
        with mock.patch.dict(os.environ, {"CUBBY_API_KEY": ""}):
            m = site_models.with_live(site_models.load_model("greens-storage-murrieta"))
        self.assertEqual(m["live"]["source"], "snapshot")
        self.assertFalse(m["live"]["enabled"])
        self.assertEqual(len(m["units"]), 175)

    def test_live_merge_takes_occupancy_from_cubby_and_lists_new_units(self):
        model = site_models.load_model("greens-storage-escondido")
        snap = next(u for u in model["units"] if u["n"] == "C214")
        live = [{"n": "C214", "w": 5, "d": 10, "t": "S", "l": 0 if snap["l"] else 1, "r": 0, "why": "REPAIRS_REQUIRED", "note": "door", "floor": 1, "pw": 0, "cc": 1, "du": 0, "group": "5x10 CC"},
                {"n": "Q001", "w": 10, "d": 20, "t": "P", "l": 1, "r": 1, "why": "", "note": "", "floor": 1, "pw": 0, "cc": 0, "du": 0, "group": "Parking"}]
        with mock.patch.dict(os.environ, {"CUBBY_API_KEY": "test"}), \
             mock.patch.object(cubby_client, "units_for", return_value=(live, "2026-10-11T20:00:00+00:00", "")):
            m = site_models.with_live(model)
        u = next(x for x in m["units"] if x["n"] == "C214")
        self.assertEqual((u["l"], u["r"], u["why"]), (0 if snap["l"] else 1, 0, "REPAIRS_REQUIRED"))
        self.assertEqual((u["u"], u["v"], u["b"]), (snap["u"], snap["v"], snap["b"]))   # geometry is the model's
        self.assertEqual(m["live"]["source"], "cubby")
        self.assertEqual([x["n"] for x in m["live"]["unplaced"]], ["Q001"])
        self.assertEqual(m["live"]["unplaced"][0]["k"], "park")
        self.assertEqual(m["live"]["matched"], 1)
        self.assertTrue(all(x.get("gone") for x in m["units"] if x["n"] != "C214"))
        pub = site_models.public_view(m)
        self.assertEqual([x["n"] for x in pub["units"]], ["C214"])            # gone units leave the customer map
        self.assertEqual(pub["live"]["unplaced"], [{"n": "Q001", "w": 10, "d": 20, "k": "park"}])
        self.assertNotIn("l", pub["live"]["unplaced"][0])

    def test_cubby_blip_serves_the_snapshot_with_the_error(self):
        model = site_models.load_model("greens-storage-fairfield")
        with mock.patch.dict(os.environ, {"CUBBY_API_KEY": "test"}), \
             mock.patch.object(cubby_client, "units_for", return_value=(None, "", "Cubby answered 503")):
            m = site_models.with_live(model)
        self.assertEqual(m["live"]["source"], "snapshot")
        self.assertEqual(m["live"]["error"], "Cubby answered 503")
        self.assertEqual(len(m["units"]), 307)

    def test_normalize_reads_the_documented_units_search_shape(self):
        data = {"units": [{"unitId": "unit_1", "name": "b012", "width": 10, "depth": 20, "floorName": "2", "leaseId": "lease_1",
                           "rentability": {"rentable": False, "unrentableReason": "USED_BY_FACILITY", "unrentableReasonNote": "shop"}, "pricingGroupId": "pg_1"},
                          {"unitId": "unit_2", "name": "A001", "width": 11, "depth": 35, "floorName": "1", "leaseId": None,
                           "rentability": {"rentable": True}, "pricingGroupId": "pg_2"}],
                "pricingGroups": [{"pricingGroupId": "pg_1", "name": "10x20 CC", "features": ["Climate controlled", "Drive-up", "Power outlet"]},
                                  {"pricingGroupId": "pg_2", "name": "RV 11x35", "parking": True, "features": ["Uncovered"]}]}
        rows = {r["n"]: r for r in cubby_client.normalize(data)}
        self.assertEqual(rows["B012"]["floor"], 2)
        self.assertEqual((rows["B012"]["l"], rows["B012"]["r"], rows["B012"]["why"], rows["B012"]["note"]), (1, 0, "USED_BY_FACILITY", "shop"))
        self.assertEqual((rows["B012"]["cc"], rows["B012"]["du"], rows["B012"]["pw"], rows["B012"]["t"]), (1, 1, 1, "S"))
        self.assertEqual((rows["A001"]["l"], rows["A001"]["r"], rows["A001"]["t"]), (0, 1, "P"))

    def test_bad_ids_are_404(self):
        from fastapi import HTTPException
        for bad in ("../main", "GREENS", "", "nope-nope"):
            with self.assertRaises(HTTPException):
                site_models.load_model(bad)


if __name__ == "__main__":
    unittest.main()
