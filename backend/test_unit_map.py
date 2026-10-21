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


# â”€â”€ The unit card: tenant, lease and tickets (Oct 20 2026) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

FAC = "fac_ESC"
ADMIN = {"email": "neil@greensglobal.com", "role": "administrator", "level": 4}
PLAIN = {"email": "darshana@greensglobal.com", "role": "employee", "level": 1}
OPS = {"email": "ops@greensglobal.com", "role": "employee", "level": 1}
PII = ("555-0100", "pat@example.com", "12 Elm St", "phone", "email", "address", "Elm")
TODAY = date(2026, 10, 20)


def _raw():
    rr = [
        {"unitId": "u1", "unitName": "E347", "status": "RENTED", "customerId": "cust_9", "customerName": "Pat Example",
         "customerPhone": "555-0100", "customerEmail": "pat@example.com", "customerAddress": "12 Elm St",
         "monthlyRentalAmount": 18000, "standardRate": 19400, "moveInDate": "2024-07-01", "paidThroughDate": "2026-09-15",
         "autoPayEnabled": False, "overlockApplied": False, "pricingGroupName": "11x35 Parking"},
        {"unitId": "u2", "unitName": "E465", "status": "VACANT", "standardRate": 19400, "pricingGroupName": "11x40 Parking"},
    ]
    recs = [{"unitId": "u1", "customerId": "cust_9", "customerName": "Pat Example", "totalAmount": 14450,
             "ranges": [{"range": "RANGE_30_60", "amount": 14450}]}]
    leases = [{"unitId": "u1", "customerId": "cust_9", "moveInDate": "2024-07-01", "rentChangeScheduledDate": "2026-12-01",
               "rentChangeNewRentAmount": 19000},
              {"unitId": "u2", "moveInDate": "2025-01-01", "moveOutDate": "2026-09-15"}]
    return {"rent_roll": rr, "receivables": recs, "leases": leases, "today": TODAY}


def _all_rows():
    raw = _raw()
    raw["rent_roll"].append({"unitId": "u3", "unitName": "E100", "status": "RENTED", "customerId": "cust_9", "customerName": "Pat Example",
                             "monthlyRentalAmount": 9000, "customerPhone": "555-0100"})
    raw["leases"][0].update({"leaseId": "lease_1", "privatePolicyNumber": "POL-778", "privatePolicyExpirationDate": "2027-01-31",
                             "coverage": {"coverageType": "PRIVATE_POLICY"}})
    raw["payments"] = [
        {"customerId": "cust_9", "createdAt": "2026-08-02T10:00:00", "amount": 18000, "methodType": "CREDIT_CARD", "status": "SUCCEEDED", "reason": "Card 4242"},
        {"customerId": "cust_9", "createdAt": "2026-10-02T10:00:00", "amount": 18000, "methodType": "CREDIT_CARD", "status": "DECLINED", "reason": "Insufficient funds"},
        {"customerId": "cust_9", "createdAt": "2026-09-02T10:00:00", "amount": 18000, "methodType": "CREDIT_CARD", "status": "SUCCEEDED"},
        {"customerId": "cust_9", "createdAt": "2026-07-02T10:00:00", "amount": 18000, "methodType": "CASH", "status": "SUCCEEDED"},
        {"customerId": "cust_other", "createdAt": "2026-10-10T10:00:00", "amount": 500, "methodType": "CASH", "status": "SUCCEEDED"},
    ]
    elsewhere = {"rent_roll": [{"unitId": "x1", "unitName": "A001", "status": "RENTED", "customerId": "cust_9", "customerEmail": "pat@example.com"}],
                 "payments": [], "leases": [], "receivables": []}
    return [({"facilityId": FAC, "name": "Greens Storage"}, raw), ({"facilityId": "fac_FF", "name": "Greens Storage Fairfield"}, elsewhere)]


class KpiTests(unittest.TestCase):
    def test_money_line(self):
        raw = _raw()
        raw["leases"].append({"unitId": "u9", "moveInDate": "2026-10-05"})
        raw["leases"].append({"unitId": "u8", "moveInDate": "2026-10-25"})      # not yet
        k = unit_map.facility_kpis(raw["rent_roll"], raw["receivables"] + [{"unitId": "u7", "totalAmount": 0}], raw["leases"], TODAY)
        self.assertEqual((k["rentRoll"], k["potential"], k["economicPct"]), (18000, 38800, 46.4))
        self.assertEqual((k["pastDue"], k["pastDueTenants"]), (14450, 1))
        self.assertEqual((k["moveIns"], k["moveOuts"]), (1, 0))

    def test_coverage_kinds(self):
        x = unit_map.tenant_extras("c", FAC, "A1", {"coverage": {"coverageType": "ORGANISATION", "coverageAmount": 500000}}, [])
        self.assertEqual((x["coverage"]["kind"], x["coverage"]["amount"]), ("facility", 500000))
        self.assertEqual(unit_map.tenant_extras("c", FAC, "A1", {}, [])["coverage"]["kind"], "none")


class UnitDetailTests(unittest.TestCase):
    def test_a_leased_unit_carries_the_name_and_the_lease_facts_only(self):
        raw = _raw()
        d = unit_map.unit_detail(raw["rent_roll"][0], raw["receivables"][0], raw["leases"], TODAY)
        t = d["tenant"]
        self.assertEqual(d["status"], "rented")
        self.assertEqual(t["name"], "Pat Example")
        self.assertEqual((t["moveIn"], t["daysInUnit"]), ("2024-07-01", 841))
        self.assertEqual((t["rent"], d["street"]), (18000, 19400))
        self.assertEqual((t["balance"], t["daysPastDue"], t["leaseStatus"]), (14450, 35, "past-due"))
        self.assertFalse(t["autoPay"])
        self.assertEqual(t["rentChange"], {"date": "2026-12-01", "rent": 19000})
        self.assertEqual(t["cubbyUrl"], "https://app.cubbystorage.com/tenants/cust_9")
        text = json.dumps(d)
        for secret in PII:
            self.assertNotIn(secret, text, secret)

    def test_a_vacant_unit_says_how_long(self):
        raw = _raw()
        d = unit_map.unit_detail(raw["rent_roll"][1], None, raw["leases"], TODAY)
        self.assertEqual((d["status"], d["tenant"], d["daysVacant"], d["vacantSince"]), ("vacant", None, 35, "2026-09-15"))


class UnitCardEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        import cache
        import ticket_property_link as L
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.PropertyAsset, models.NexusEmployee, models.NexusRole, models.NexusGroup,
                  models.NexusGroupMember, models.CubbyFacility, models.NexusSetting, models.OpsReportCache):
            self.db.query(m).execution_options(include_deleted=True).delete()
        for u in (ADMIN, PLAIN, OPS):
            self.db.add(models.NexusEmployee(id=u["email"], first_name=u["email"].split("@")[0], work_email=u["email"],
                                             status="active", identity_type="internal"))
        self.db.add(models.NexusRole(email=ADMIN["email"], role="administrator"))
        self.db.add(models.NexusGroup(id="g-ops", name="Ops", allowed_modules="operations:viewer"))
        self.db.add(models.NexusGroupMember(group_id="g-ops", email=OPS["email"]))
        self.db.add(models.PropertyAsset(id="esc", name="Greens Storage Escondido", asset_type="Self-Storage", payload={"kind": "property"}))
        self.db.add(models.CubbyFacility(facility_id=FAC, name="Greens Storage Escondido", data={}))
        now = "2026-10-01T10:00:00+00:00"
        self.db.add(models.TaskTicket(id="t-open", code="TKT-1", subject="Gate code not working", status="open", priority="high",
                                      property_asset_id="esc", property_unit="e347", created_at=now))
        self.db.add(models.TaskTicket(id="t-done", code="TKT-2", subject="Light out", status="resolved", priority="low",
                                      property_asset_id="esc", property_unit="E347", created_at="2026-09-01T10:00:00+00:00",
                                      resolved_at="2026-09-02T10:00:00+00:00"))
        self.db.add(models.TaskTicket(id="t-other", code="TKT-3", subject="Other unit", status="open",
                                      property_asset_id="esc", property_unit="E465", created_at=now))
        self.db.commit()
        cache.module_grants.invalidate()
        self._rows, self._models, self._all = unit_map._cubby_rows, L._site_models, unit_map._all_rows
        unit_map._cubby_rows = lambda fid: ({"facilityId": FAC}, _raw()) if fid == FAC else (None, None)
        unit_map._all_rows = _all_rows
        L._site_models = lambda: []

    def tearDown(self):
        import ticket_property_link as L
        unit_map._cubby_rows, L._site_models, unit_map._all_rows = self._rows, self._models, self._all
        self.db.close()

    def _client(self, user):
        from auth import get_current_user
        app = FastAPI()
        app.include_router(unit_map.ops_router)
        app.include_router(unit_map.public_router)
        app.dependency_overrides[get_current_user] = lambda: dict(user)
        return TestClient(app)

    def test_the_unit_card_has_the_tenant_and_the_units_tickets(self):
        r = self._client(ADMIN).get("/facility-ops/site-map/unit", params={"facility_id": FAC, "unit": "e347"})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual((body["unit"], body["status"], body["tenant"]["name"]), ("E347", "rented", "Pat Example"))
        self.assertEqual([t["id"] for t in body["tickets"]["open"]], ["t-open"])
        self.assertEqual([t["id"] for t in body["tickets"]["recent"]], ["t-done"])
        self.assertEqual(body["tickets"]["property"], {"id": "esc", "name": "Greens Storage Escondido"})
        text = json.dumps(body)
        for secret in PII:
            self.assertNotIn(secret, text, secret)
        self.assertNotIn("t-other", text)

    def test_the_tenant_card_extras_and_nothing_private(self):
        self.db.add(models.OpsReportCache(id=f"compliance:{FAC}:current", kind="compliance", facility_id=FAC, period="current",
                                          payload={"compliances": [{"leaseId": "lease_1", "documents": [
                                              {"type": "LEASE_AGREEMENT", "status": "APPROVED"}, {"type": "IDENTITY", "status": "MISSING"}]}]}))
        self.db.commit()
        unit_map._cubby_rows = lambda fid: _all_rows()[0]
        body = self._client(ADMIN).get("/facility-ops/site-map/unit", params={"facility_id": FAC, "unit": "E347"}).json()
        t = body["tenant"]
        self.assertEqual(t["customerId"], "cust_9")
        self.assertEqual([(o["unit"], o["facility"], o["here"]) for o in t["otherUnits"]], [("E100", "Greens Storage", True), ("A001", "Fairfield", False)])
        self.assertEqual(t["coverage"]["kind"], "private")
        self.assertTrue(t["coverage"]["policyOnFile"])
        self.assertEqual(t["compliance"], ["Identity"])
        self.assertEqual([p["date"] for p in t["payments"]], ["2026-10-02", "2026-09-02", "2026-08-02"])
        self.assertTrue(t["payments"][0]["failed"])
        self.assertEqual(t["payments"][1]["method"], "Card")
        text = json.dumps(body)
        for secret in PII + ("POL-778", "4242", "Insufficient"):
            self.assertNotIn(secret, text, secret)

    def test_the_unit_card_is_operations_read(self):
        q = {"facility_id": FAC, "unit": "E347"}
        self.assertEqual(self._client(OPS).get("/facility-ops/site-map/unit", params=q).status_code, 200)
        self.assertEqual(self._client(PLAIN).get("/facility-ops/site-map/unit", params=q).status_code, 401)
        self.assertEqual(self._client(PLAIN).get("/facility-ops/site-map/tenant", params={"property_id": "esc", "unit": "E347"}).status_code, 401)

    def test_the_ticket_drawer_gets_the_tenant_name_only(self):
        c = self._client(ADMIN)
        self.assertEqual(c.get("/facility-ops/site-map/tenant", params={"property_id": "esc", "unit": "e347"}).json(), {"tenant": "Pat Example"})
        self.assertEqual(c.get("/facility-ops/site-map/tenant", params={"property_id": "esc", "unit": "E465"}).json(), {"tenant": ""})
        self.assertEqual(c.get("/facility-ops/site-map/tenant", params={"property_id": "esc", "unit": "Common Area"}).json(), {"tenant": ""})
        self.assertEqual(c.get("/facility-ops/site-map/tenant", params={"property_id": "nope", "unit": "E347"}).json(), {"tenant": ""})

    def test_the_public_customer_map_never_carries_tenant_or_tickets(self):
        r = self._client(PLAIN).get(f"/unit-map/t/{unit_map.make_token(PID, 'C214')}")
        self.assertEqual(r.status_code, 200, r.text)
        text = json.dumps(r.json())
        for secret in ("Pat Example", '"tenant', '"ticket', '"balance"', "autoPay", "cubbystorage", '"customer', '"rent"', "555-0100", "pat@example.com", "12 Elm St"):
            self.assertNotIn(secret, text, secret)


if __name__ == "__main__":
    unittest.main()
