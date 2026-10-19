"""Customer unit map + Ops Site Map (routers/unit_map.py, Oct 20 2026).

The customer link must not be editable into another unit, the public payload
must carry one unit and no occupancy or tenant data, both public routes must
sit behind the per-IP rate limit, and the layer facts must be right.

Run alone: python -m pytest test_unit_map.py -q
"""
import _testdb  # noqa: F401 - FIRST import: throwaway DATABASE_URL

import json
import unittest
from datetime import date

from fastapi import FastAPI
from fastapi.testclient import TestClient

import database
import models
from middleware_hardening import RequestRateLimit
from routers import unit_map

PID = "greens-storage-escondido"


def _client():
    models.Base.metadata.create_all(bind=database.engine)
    app = FastAPI()
    app.include_router(unit_map.public_router)
    return TestClient(app)


class TokenTests(unittest.TestCase):
    def test_round_trip(self):
        t = unit_map.make_token(PID, "C214")
        self.assertEqual(unit_map.parse_token(t), {"pid": PID, "unit": "C214"})

    def test_tampered_payload_is_refused(self):
        t = unit_map.make_token(PID, "C214")
        raw = unit_map._unb64(t)
        forged = raw.replace(b"C214", b"C215")
        self.assertNotEqual(raw, forged)
        self.assertIsNone(unit_map.parse_token(unit_map._b64(forged)))
        # and a payload re-signed with a guessed key
        payload = json.dumps({"p": PID, "u": "C215"}, separators=(",", ":")).encode()
        self.assertIsNone(unit_map.parse_token(unit_map._b64(payload + b"0" * 16)))

    def test_junk_is_refused(self):
        for junk in ("", "x", "!!!", "a" * 400, unit_map.make_token(PID, "C214")[:-2]):
            self.assertIsNone(unit_map.parse_token(junk))

    def test_facility_key_is_per_facility(self):
        k = unit_map.facility_key(PID)
        self.assertTrue(unit_map.check_facility_key(PID, k))
        self.assertFalse(unit_map.check_facility_key("greens-storage-fairfield", k))
        self.assertFalse(unit_map.check_facility_key(PID, ""))
        self.assertIn("${unit.name}", unit_map.template_url(PID))

    def test_unit_short_forms(self):
        self.assertEqual(unit_map.clean_unit("c14"), "C014")
        self.assertEqual(unit_map.clean_unit(" C 214 "), "C214")
        self.assertEqual(unit_map.clean_unit("A1B"), "A001B")
        self.assertEqual(unit_map.clean_unit("<script>"), "")


class PublicEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = _client()

    def test_customer_view_carries_one_unit_and_no_occupancy(self):
        r = self.c.get(f"/unit-map/t/{unit_map.make_token(PID, 'C214')}")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual([u["n"] for u in body["units"]], ["C214"])
        self.assertEqual(body["unit"]["n"], "C214")
        self.assertEqual(body["live"]["unplaced"], [])
        self.assertEqual(body["sources"], [])
        text = json.dumps(body)
        for secret in ('"l":', '"r":', '"why"', '"dvac"', '"tenant"', '"customer', "cubbyFacilityId", '"apn"', '"flags"', '"note": "Five'):
            self.assertNotIn(secret, text, secret)
        # no other unit number anywhere in the payload
        import re
        others = set(re.findall(r'"([A-Z]\d{3}[A-Z]?)"', text)) - {"C214"}
        self.assertEqual(others, set())
        self.assertIsNotNone(body["entrance"]["lat"])
        self.assertTrue(body["entrance"]["mapsUrl"].startswith("https://www.google.com/maps/dir/?api=1&destination="))

    def test_bad_token_is_404(self):
        self.assertEqual(self.c.get("/unit-map/t/nope").status_code, 404)

    def test_template_link_resolves_to_a_token(self):
        k = unit_map.facility_key(PID)
        r = self.c.get("/unit-map/u", params={"f": PID, "k": k, "unit": "c214"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(unit_map.parse_token(r.json()["token"]), {"pid": PID, "unit": "C214"})
        self.assertEqual(self.c.get("/unit-map/u", params={"f": PID, "k": "wrong", "unit": "C214"}).status_code, 404)
        self.assertEqual(self.c.get("/unit-map/u", params={"f": "greens-storage-fairfield", "k": k, "unit": "C214"}).status_code, 404)
        self.assertEqual(self.c.get("/unit-map/u", params={"f": PID, "k": k, "unit": "ZZ999"}).status_code, 404)

    def test_entrance_setting_wins_over_the_gate(self):
        db = database.SessionLocal()
        try:
            db.merge(models.NexusSetting(key=unit_map.SETTING_PREFIX + PID, value=json.dumps({"lat": 33.17, "lng": -117.1, "note": "Turn at the blue sign"})))
            db.commit()
            r = self.c.get(f"/unit-map/t/{unit_map.make_token(PID, 'C214')}").json()
            self.assertEqual((r["entrance"]["lat"], r["entrance"]["note"], r["entrance"]["source"]), (33.17, "Turn at the blue sign", "setting"))
            self.assertNotIn("updatedBy", r["entrance"])
        finally:
            db.query(models.NexusSetting).filter(models.NexusSetting.key == unit_map.SETTING_PREFIX + PID).delete()
            db.commit()
            db.close()


class RateLimitTests(unittest.TestCase):
    def test_public_routes_are_per_ip_and_never_logged_with_the_token(self):
        self.assertTrue("/unit-map/t/abc".startswith(RequestRateLimit.SENSITIVE_PREFIXES))
        self.assertTrue("/unit-map/u".startswith(RequestRateLimit.SENSITIVE_PREFIXES))
        self.assertEqual(RequestRateLimit._log_path("/unit-map/t/secret"), "/unit-map/<token>")


class LayerFactTests(unittest.TestCase):
    def test_gate_latlng_matches_the_traced_corner(self):
        m = {"frame": {"lat0": 33.171, "lon0": -117.1075, "mPerDegLon": 93200, "mPerDegLat": 110900, "north": [-0.7705, 0.6374]}}
        at = unit_map.gate_latlng(m, [127.05, -14.39])
        self.assertAlmostEqual(at["lat"], 33.170035, places=4)
        self.assertAlmostEqual(at["lng"], -117.10675, places=4)

    def test_unit_facts(self):
        today = date(2026, 10, 20)
        rr = [
            {"unitId": "u1", "unitName": "c214", "status": "VACANT", "standardRate": 9000, "width": 10, "depth": 10, "pricingGroupName": "10x10 CC"},
            {"unitId": "u2", "unitName": "C215", "status": "RENTED", "monthlyRentalAmount": 12000, "standardRate": 10000, "width": 10, "depth": 10, "pricingGroupName": "10x10 CC"},
            {"unitId": "u3", "unitName": "C216", "status": "RENTED", "monthlyRentalAmount": 10200, "standardRate": 10000, "width": 10, "depth": 10, "pricingGroupName": "10x10 CC"},
            {"unitId": "u4", "unitName": "C217", "status": "UNAVAILABLE", "standardRate": 10000, "width": 5, "depth": 5},
        ]
        leases = [{"unitId": "u1", "moveOutDate": "2026-05-13"}, {"unitId": "u1", "moveOutDate": "2026-01-01"}, {"unitId": "u1", "moveOutDate": "2027-01-01"}]
        market = {"S:10x10": {"a": {"rate_cents": 10000}, "b": {"rate_cents": 10000}}}
        f = unit_map.unit_facts(rr, leases, market, today)
        self.assertEqual(f["C214"]["daysVacant"], 160)
        self.assertEqual(f["C214"]["market"], "under")
        self.assertEqual(f["C215"]["market"], "over")
        self.assertEqual(f["C215"]["marketPct"], 20)
        self.assertEqual(f["C216"]["market"], "at")
        self.assertIsNone(f["C215"]["daysVacant"])
        self.assertEqual(f["C217"]["status"], "off-market")
        self.assertIsNone(f["C217"]["market"])   # no competitor rate for 5x5
        self.assertNotIn("tenant", json.dumps(f))

    def test_one_competitor_is_not_a_market(self):
        f = unit_map.unit_facts([{"unitId": "u", "unitName": "A001", "status": "VACANT", "standardRate": 5000, "width": 10, "depth": 10}],
                                [], {"S:10x10": {"a": {"rate_cents": 9000}}}, date(2026, 10, 20))
        self.assertIsNone(f["A001"]["market"])


if __name__ == "__main__":
    unittest.main()
