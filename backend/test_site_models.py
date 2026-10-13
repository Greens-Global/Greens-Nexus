"""Site Models router - the customer view must never leak occupancy, the model
directory must list every property, and the live Cubby merge must keep the
model's geometry while taking occupancy from Cubby. Pure functions, no database."""
import os
import unittest
from unittest import mock

import cubby_client
from routers import site_models

PROPERTIES = ("greens-storage-escondido", "greens-storage-valley-center", "greens-storage-temecula",
              "greens-storage-murrieta", "greens-storage-fairfield", "greens-storage-austin",
              "greens-storage-sachse", "greens-storage-georgetown")


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
            # Cubby sites carry their facility id; CubeSmart-run sites name their operator instead
            self.assertTrue(model["property"]["cubbyFacilityId"].startswith("fac_") or model["property"].get("operator") == "CubeSmart", pid)
            self.assertTrue(model["parcels"] and model["gates"], pid)
            for u in model["units"]:
                self.assertTrue(u["wu"] > 0 and u["dv"] > 0, (pid, u["n"]))
                self.assertIn(u["door"], ("sw", "ne", "both", "w", "e"))

    def test_austin_is_a_cubesmart_store_with_no_cubby_link(self):
        # Austin (8023 W Parmer Ln) runs on CubeSmart's system: units come from its rent roll
        model = site_models.load_model("greens-storage-austin")
        self.assertEqual(model["property"]["cubbyFacilityId"], "")
        self.assertEqual(model["property"]["operator"], "CubeSmart")
        self.assertEqual({b["floors"] for b in model["buildings"]}, {5})
        self.assertEqual({u["f"] for u in model["units"]}, {1, 2, 3, 4, 5})
        self.assertTrue(all(u["n"][0] == str(u["f"]) for u in model["units"]))   # 3xxx is on level 3
        m = site_models.with_live(model)
        self.assertEqual(m["live"]["source"], "file")
        self.assertIn("CubeSmart rent roll", m["live"]["system"])
        self.assertNotIn("l", site_models.public_view(m)["units"][0])

    def test_sachse_and_georgetown_are_cubesmart_stores_on_their_own_parcels(self):
        # Sachse (7970 Woodbridge Pkwy) and Georgetown (108 Boselli Way) run on CubeSmart's
        # system like Austin; every unit sits on its real floor and inside its one parcel
        for pid, apn, floors, count in (("greens-storage-sachse", "R-10561-00A-0040-1", {1, 2, 3}, 886),
                                         ("greens-storage-georgetown", "R606431", {1, 2, 3}, 964)):
            model = site_models.load_model(pid)
            self.assertEqual(model["property"]["operator"], "CubeSmart")
            self.assertEqual(model["property"]["cubbyFacilityId"], "")
            self.assertEqual([p["apn"] for p in model["parcels"]], [apn])
            self.assertEqual(len(model["units"]), count)
            self.assertEqual({u["f"] for u in model["units"]}, floors)
            self.assertEqual(model["layout"]["flags"], [])
            self.assertEqual(site_models.with_live(model)["live"]["source"], "file")
        gt = site_models.load_model("greens-storage-georgetown")
        rows = {u["b"] for u in gt["units"] if u["n"][0] in "456"}
        self.assertEqual(rows, {"N", "S", "W"})          # the 10x20 drive-up rows, not the main building

    def test_cubesmart_converter_reads_no_customer_fields_and_sizes_the_gaps(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("cs", os.path.join(os.path.dirname(__file__), "site_models", "build", "cubesmart_units.py"))
        cs = importlib.util.module_from_spec(spec); spec.loader.exec_module(cs)
        occ = [{"n": "1001", "size": "10X10", "attr": "CDE"}, {"n": "1003-1004", "size": "10X20", "attr": "CDN"},
               {"n": "1006", "size": "10X10", "attr": "CDE"}, {"n": "1008", "size": "05X05", "attr": "CDE"}]
        mix = [{"size": "10X10", "attr": "CDE", "total": 3, "occ": 2}, {"size": "05X05", "attr": "CDE", "total": 2, "occ": 1},
               {"size": "10X20", "attr": "CDN", "total": 1, "occ": 1}]
        units, stats = cs.build(occ, mix, "08/31/2026", {"1007": "05X05"}, "02/02/2021")
        by = {u["n"]: u for u in units}
        self.assertEqual(sorted(by), ["1001", "1002", "1003-1004", "1005", "1006", "1007", "1008"])
        self.assertEqual((by["1007"]["w"], by["1007"]["d"], by["1007"]["l"]), (5.0, 5.0, 0))
        self.assertIn("unit audit", by["1007"]["note"])
        self.assertIn("estimated", by["1002"]["note"])
        self.assertEqual(stats["gaps"], 3)
        self.assertEqual(set().union(*(u.keys() for u in units)), {"n", "w", "d", "t", "l", "r", "why", "note", "dv", "pw", "cc", "du", "cov"})

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

    def test_cubby_answer_in_an_unexpected_shape_is_a_cubby_error(self):
        resp = mock.Mock(status_code=200); resp.json.return_value = ["not", "an", "object"]
        with mock.patch.dict(os.environ, {"CUBBY_API_KEY": "test"}), mock.patch.object(cubby_client.httpx, "post", return_value=resp):
            with self.assertRaises(cubby_client.CubbyError):
                cubby_client.fetch_units("fac_1")
        resp.json.return_value = {"data": {"units": [{"name": "A1", "rentability": "yes"}], "pricingGroups": []}}
        with mock.patch.dict(os.environ, {"CUBBY_API_KEY": "test"}), mock.patch.object(cubby_client.httpx, "post", return_value=resp):
            with self.assertRaises(cubby_client.CubbyError):
                cubby_client.fetch_units("fac_1")

    def test_pin_inputs_are_checked(self):
        from fastapi import HTTPException
        for bad in (float("nan"), float("inf"), float("-inf")):
            with self.assertRaises(HTTPException):
                site_models._coord(bad)
        self.assertEqual(site_models._coord(1e9), 5000.0)
        self.assertEqual(site_models._coord(-12.5), -12.5)
        self.assertEqual(site_models._clean_ticket(" 3f2a-91 "), "3f2a-91")
        for bad in ("<script>", "a" * 41, "../x"):
            with self.assertRaises(HTTPException):
                site_models._clean_ticket(bad)

    def test_cubesmart_converter_refuses_a_reordered_rent_roll(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("cs", os.path.join(os.path.dirname(__file__), "site_models", "build", "cubesmart_units.py"))
        cubesmart_units = importlib.util.module_from_spec(spec); spec.loader.exec_module(cubesmart_units)
        cubesmart_units.check_shape([{"n": "1003-1004", "size": "10X15", "attr": "CD"}])
        with self.assertRaises(SystemExit) as cm:
            cubesmart_units.check_shape([{"n": "JANE DOE", "size": "10X15", "attr": "CD"}])
        self.assertNotIn("JANE", str(cm.exception))   # a count, never the cell

    def test_bad_ids_are_404(self):
        from fastapi import HTTPException
        for bad in ("../main", "GREENS", "", "nope-nope", "greens-storage-escondido\n"):
            with self.assertRaises(HTTPException):
                site_models.load_model(bad)


if __name__ == "__main__":
    unittest.main()
