"""Traced runs in the site-model build (Oct 14 2026): units placed exactly
from the as-built plans, ahead of the schematic layout.

Run with: python -m pytest test_site_model_runs.py
"""
import importlib.util
import os
import unittest

_spec = importlib.util.spec_from_file_location(
    "bsm", os.path.join(os.path.dirname(__file__), "site_models", "build", "build_site_model.py"))
bsm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bsm)

PARCEL = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"apn": "1"},
          "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]]}}]}


def cfg(runs):
    return {"id": "t", "name": "T", "frame": {"lat0": 0, "lon0": 0, "bearingDeg": 90, "mPerDegLon": 111320, "mPerDegLat": 110900},
            "image": {"bbox": [0, 0, 0.001, 0.001], "px": [100, 100], "attribution": ""}, "classify": [],
            "buildings": [{"id": "A", "letters": ["A"], "name": "A", "kind": "storage", "u": [0, 30], "v": [0, 10],
                           "height": 3, "floors": 1}],
            "zones": [], "gates": [], "runs": runs}


def units(*names, w=10, d=10):
    return [{"n": n, "w": w, "d": d, "t": "S", "du": 1} for n in names]


class RunTests(unittest.TestCase):
    def build(self, runs, us):
        return bsm.Builder(cfg(runs), PARCEL, us).build()

    def test_a_run_places_units_in_order_from_its_start_with_their_own_widths(self):
        site = self.build([{"building": "A", "at": [2, 0], "dir": "+u", "depth": "+v",
                            "units": ["A1-A2", {"gap": 1.5}, "A3"]}], units("A1", "A2", "A3"))
        p = {x["n"]: x for x in site["units"]}
        w = round(10 * 0.3048, 2)
        self.assertEqual((p["A1"]["u"], p["A1"]["v"]), (2.0, 0.0))
        self.assertEqual(p["A2"]["u"], round(2 + w, 2))
        self.assertEqual(p["A3"]["u"], round(2 + 2 * w + 1.5, 2))
        self.assertEqual(p["A1"]["door"], "sw")          # depth +v, so the door faces -v
        self.assertTrue(all(x.get("tr") == 1 for x in p.values()))
        self.assertFalse(site["layout"]["schematic"])
        self.assertEqual(site["layout"]["traced"], 3)

    def test_a_run_going_minus_v_turns_its_units(self):
        site = self.build([{"building": "A", "at": [0, 10], "dir": "-v", "depth": "+u", "units": ["A1"]}], units("A1", w=5, d=10))
        [p] = site["units"]
        self.assertEqual((p["u"], p["v"], p["wu"], p["dv"]), (0.0, round(10 - 5 * 0.3048, 2), round(10 * 0.3048, 2), round(5 * 0.3048, 2)))
        self.assertEqual(p["door"], "w")

    def test_untraced_units_fall_back_to_the_schematic_layout(self):
        site = self.build([{"building": "A", "at": [0, 0], "dir": "+u", "depth": "+v", "units": ["A1"]}], units("A1", "A2"))
        self.assertTrue(site["layout"]["schematic"])
        self.assertEqual(site["layout"]["traced"], 1)
        self.assertEqual(sorted(x["n"] for x in site["units"]), ["A1", "A2"])

    def test_bad_runs_are_flagged_not_crashed(self):
        site = self.build([{"building": "A", "at": [0, 0], "dir": "+u", "depth": "+u", "units": ["A1"]},
                           {"building": "A", "at": [0, 0], "dir": "+u", "depth": "+v", "units": ["A9", "A1", "A1"]}],
                          units("A1"))
        flags = " | ".join(site["layout"]["flags"])
        self.assertIn("right angles", flags)
        self.assertIn("A9 is on the plan but not in the unit list", flags)
        self.assertIn("A1 is in two runs", flags)

    def test_a_combined_unit_named_like_a_range_is_that_unit(self):
        site = self.build([{"building": "A", "at": [0, 0], "dir": "+u", "depth": "+v", "units": ["1003-1004"]}],
                          [{"n": "1003-1004", "w": 10, "d": 10, "t": "S"}])
        self.assertEqual([x["n"] for x in site["units"]], ["1003-1004"])
        self.assertEqual(site["layout"]["traced"], 1)

    def test_angled_stalls_keep_their_size_turn_and_space_at_the_painted_pitch(self):
        import math
        site = self.build([{"at": [0, 0], "dir": "+u", "depth": "+v", "angle": 60, "units": ["A1-A2"]}],
                          units("A1", "A2", w=10, d=40))
        a, b = sorted(site["units"], key=lambda x: x["n"])
        w, d = round(10 * 0.3048, 2), round(40 * 0.3048, 2)
        self.assertEqual((a["wu"], a["dv"]), (w, d))                     # real size, not a bounding box
        self.assertEqual(a["rot"], -30.0)                                 # turned 30 degrees clockwise, toward +u
        pitch = w / math.sin(math.radians(60))
        self.assertAlmostEqual((b["u"] + b["wu"] / 2) - (a["u"] + a["wu"] / 2), pitch, places=1)
        self.assertAlmostEqual(a["v"] + a["dv"] / 2, math.sin(math.radians(60)) * d / 2, places=1)

    def test_square_stalls_carry_no_rotation(self):
        site = self.build([{"at": [0, 0], "dir": "+u", "depth": "+v", "units": ["A1"]}], units("A1"))
        self.assertNotIn("rot", site["units"][0])

    def test_inferred_numbering_is_marked_apart_from_a_trace(self):
        site = self.build([{"building": "A", "at": [0, 0], "dir": "+u", "depth": "+v", "numbering": "inferred", "units": ["A1"]}], units("A1"))
        self.assertEqual(site["units"][0]["tr"], 2)
        self.assertEqual((site["layout"]["traced"], site["layout"]["numbersInferred"]), (0, 1))

    def test_a_fixed_width_sets_the_stall_pitch(self):
        site = self.build([{"at": [0, 0], "dir": "+u", "depth": "+v", "width": 3.0, "units": ["A1-A3"]}], units("A1", "A2", "A3"))
        self.assertEqual([x["u"] for x in sorted(site["units"], key=lambda x: x["n"])], [0.0, 3.0, 6.0])


class PublicViewTests(unittest.TestCase):
    def test_the_customer_view_keeps_the_angle_and_the_trace(self):
        from routers import site_models
        pub = site_models.public_view(site_models.load_model("greens-storage-fairfield"))
        angled = [u for u in pub["units"] if u.get("rot")]
        self.assertTrue(angled, "Fairfield's angled stalls lost their rotation in the public view")
        self.assertTrue(all("l" not in u for u in pub["units"]))      # occupancy still stripped


class ValleyCenterParkingTests(unittest.TestCase):
    """P001 and P002 sit at the west end of Building C2, right after C071 -
    not in the Vehicle Parking lot (Miranda Negrete, Oct 21 2026)."""

    def test_p001_and_p002_continue_building_c_after_c071(self):
        from routers import site_models
        m = site_models.load_model("greens-storage-valley-center")
        p = {u["n"]: u for u in m["units"]}
        c070, c071 = p["C070"], p["C071"]
        pitch = round(c071["v"] - c070["v"], 2)             # the row runs along +v
        self.assertGreater(pitch, 0)
        prev = c071
        for n in ("P001", "P002"):
            u = p[n]
            self.assertEqual(u["b"], "C2", f"{n} is not on Building C2")
            self.assertEqual(u.get("tr"), 1, f"{n} is not traced")
            self.assertAlmostEqual(u["v"], prev["v"] + pitch, places=2)       # next slot along the row
            self.assertEqual(u["dv"], c071["dv"])                             # same 12 ft width
            self.assertAlmostEqual(u["u"] + u["wu"], c071["u"] + c071["wu"], places=2)   # same door line
            self.assertEqual(u["door"], c071["door"])
            self.assertFalse(u.get("rot"))
            prev = u
        self.assertFalse([u["n"] for u in m["units"] if u["b"] == "P" and u["n"].startswith("P")],
                         "P units are still in the Vehicle Parking lot")


if __name__ == "__main__":
    unittest.main()
