"""
Every property-related ticket lands on the property and its unit (Neil, Ops
review Oct 20 2026) - ticket_property_link.py, routers/ticket_property.py,
routers/facility_maintenance_map.py.

  * the requirement rule: a requester's Buildings & Maintenance ticket must
    name its property (config list; the desk may file without);
  * the unit: checked against the facility's synced Cubby units, Common Area
    always allowed, cleared with the property;
  * the property's Maintenance list carries the linked ticket and its unit;
  * the suggestion matcher ("26382 palisades" -> the property);
  * Suggest Property Links proposes, a manager approves, nothing auto-links;
  * GET /facility-ops/maintenance-map: shape, open-only, permissions.

Throwaway sqlite file, no network. Run: python -m pytest test_ticket_property_link.py -q
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, FastAPI, HTTPException   # noqa: E402
from fastapi.testclient import TestClient                      # noqa: E402

import cache                                      # noqa: E402
import database                                   # noqa: E402
import models                                     # noqa: E402
import ticket_property_link as L                  # noqa: E402
from auth import get_current_user                 # noqa: E402
from routers.task_util import gen_id              # noqa: E402
from routers import tickets as T                  # noqa: E402
from routers import property_tickets as P         # noqa: E402
from routers import ticket_property as TP         # noqa: E402
from routers import facility_maintenance_map as M  # noqa: E402

ADMIN = {"email": "neil@greensglobal.com", "role": "administrator", "level": 4}
PLAIN = {"email": "darshana@greensglobal.com", "role": "employee", "level": 1}
SUPER = {"email": "sup@greensglobal.com", "role": "supervisor", "level": 2}
OPS = {"email": "ops@greensglobal.com", "role": "employee", "level": 1}
FAC = "fac_PAL"


class TicketPropertyLinkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except OSError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.TaskActivity, models.TaskNotification, models.NexusNotification,
                  models.NexusEmployee, models.NexusRole, models.NexusGroup, models.NexusGroupMember,
                  models.PropertyAsset, models.PropertyRecord, models.HrDepartment, models.NexusSetting,
                  models.CubbyFacility, models.CubbyUnit, models.SiteModelMarkup, models.NexusCounter):
            self.db.query(m).execution_options(include_deleted=True).delete()
        for u in (ADMIN, PLAIN, SUPER, OPS):
            self.db.add(models.NexusEmployee(id=gen_id(), first_name=u["email"].split("@")[0], work_email=u["email"],
                                             status="active", identity_type="internal"))
        self.db.add(models.NexusRole(email=ADMIN["email"], role="administrator"))
        self.db.add(models.NexusGroup(id="g-ops", name="Ops", allowed_modules="operations:viewer"))
        self.db.add(models.NexusGroupMember(group_id="g-ops", email=OPS["email"]))
        self.db.add(models.HrDepartment(id="d-fac", company_id="c1", name="Construction"))
        self.db.add(models.HrDepartment(id="d-hr", company_id="c1", name="Human Resources"))
        self.db.add(models.PropertyAsset(
            id="pal", name="Palisades Self Storage", asset_type="Self-Storage",
            payload={"kind": "property", "address": "26382 Palisades Dr", "city": "Dana Point", "state": "CA"}))
        self.db.add(models.PropertyAsset(
            id="esc", name="Greens Storage Escondido", asset_type="Self-Storage",
            payload={"kind": "property", "address": "25260 N Centre City Pkwy", "city": "Escondido",
                     "tenantUnits": [{"label": "Office"}]}))
        self.db.add(models.PropertyAsset(id="vault", name="Private Palisades Deal",
                                         payload={"kind": "property", "private": True, "address": "26382 Palisades Dr"}))
        self.db.add(models.CubbyFacility(facility_id=FAC, name="Palisades Self Storage", data={}))
        for n in ("A101", "A102", "B7"):
            self.db.add(models.CubbyUnit(id=f"{FAC}:{n}", facility_id=FAC, unit_id=n, unit_name=n, status="RENTED"))
        self.db.commit()
        cache.module_grants.invalidate()
        self._models = L._site_models
        L._site_models = lambda: []          # no site model files in these tests unless a test sets one

    def tearDown(self):
        L._site_models = self._models
        self.db.close()

    def _new(self, user=PLAIN, app="Heating or Cooling (HVAC)", dept="d-fac", **kw):
        body = T.TicketBody(subject=kw.pop("subject", "AC not working"),
                            description=kw.pop("description", "26382 palisades cabana tenant"),
                            application=app, hr_department_id=dept, **kw)
        return T.create_ticket(body, BackgroundTasks(), user=user, db=self.db)

    # ── The requirement rule ──
    def test_a_requesters_maintenance_ticket_must_name_its_property(self):
        with self.assertRaises(HTTPException) as cm:
            self._new()
        self.assertEqual(cm.exception.status_code, 400)
        self.assertIn("Pick the property", cm.exception.detail)

    def test_none_or_other_is_an_answer(self):
        # Neil, Oct 28 2026: the form offers "None / Other" - picked, it files.
        self.assertIsNone(self._new(property_none=True)["propertyAssetId"])

    def test_the_desk_may_file_without_and_other_topics_never_need_one(self):
        self.assertIsNone(self._new(user=ADMIN)["propertyAssetId"])
        out = self._new(app="Payroll Question", dept="d-hr", subject="Pay stub")
        self.assertIsNone(out["propertyAssetId"])

    def test_the_rule_is_config(self):
        self.assertTrue(L.property_required(self.db, "facilities", "x"))
        self.assertFalse(L.property_required(self.db, "general", "Signs"))
        L.save_rules(self.db, {"requiredServiceAreas": [], "requiredTopics": ["signs"]}, ADMIN["email"])
        self.assertFalse(L.property_required(self.db, "facilities", "Plumbing"))
        self.assertTrue(L.property_required(self.db, "general", "Signs"))
        self.assertEqual(TP.get_rules(db=self.db), {"requiredServiceAreas": [], "requiredTopics": ["signs"]})
        with self.assertRaises(HTTPException):
            TP.put_rules({"requiredServiceAreas": ["facilities"]}, user=PLAIN, db=self.db)

    # ── Linking + unit ──
    def test_a_cubby_store_ticket_names_a_real_unit_or_common_area(self):
        with self.assertRaises(HTTPException) as cm:        # Cubby store: the unit is required
            self._new(property_asset_id="pal")
        self.assertIn("Pick the unit", cm.exception.detail)
        with self.assertRaises(HTTPException) as cm:
            self._new(property_asset_id="pal", property_unit="Z999")
        self.assertIn("isn't one of", cm.exception.detail)
        out = self._new(property_asset_id="pal", property_unit="a101")
        self.assertEqual((out["propertyAssetId"], out["propertyName"], out["propertyUnit"]),
                         ("pal", "Palisades Self Storage", "A101"))
        self.assertEqual(out["requesterId"], PLAIN["email"])     # still the requester's ticket too
        self.assertEqual(self._new(property_asset_id="pal", property_unit="common area")["propertyUnit"], "Common Area")

    def test_a_non_cubby_property_takes_any_unit_and_does_not_demand_one(self):
        self.assertIsNone(self._new(property_asset_id="esc")["propertyUnit"])
        self.assertEqual(self._new(property_asset_id="esc", property_unit="office")["propertyUnit"], "Office")
        self.assertEqual(self._new(property_asset_id="esc", property_unit="Bay 3")["propertyUnit"], "Bay 3")

    def test_the_unit_follows_its_property_on_update(self):
        t = self._new(property_asset_id="pal", property_unit="B7")
        T.update_ticket(t["id"], T.TicketUpdate(property_unit="A102"), BackgroundTasks(), user=ADMIN, db=self.db)
        self.assertEqual(self.db.get(models.TaskTicket, t["id"]).property_unit, "A102")
        with self.assertRaises(HTTPException):
            T.update_ticket(t["id"], T.TicketUpdate(property_unit="nope"), BackgroundTasks(), user=ADMIN, db=self.db)
        T.update_ticket(t["id"], T.TicketUpdate(property_asset_id=""), BackgroundTasks(), user=ADMIN, db=self.db)
        row = self.db.get(models.TaskTicket, t["id"])
        self.assertEqual((row.property_asset_id, row.property_unit), ("", ""))

    def test_the_property_maintenance_tab_lists_the_linked_ticket_with_its_unit(self):
        t = self._new(property_asset_id="pal", property_unit="A101")
        out = P.property_tickets("pal", user=ADMIN, db=self.db)
        row = next(s for s in out["open"] if s["id"] == t["id"])
        self.assertEqual((row["unit"], row["subject"]), ("A101", "AC not working"))

    # ── Suggest ──
    def test_the_matcher_finds_the_property_from_the_ticket_words(self):
        got = L.suggest(self.db, "AC not working - 26382 palisades cabana tenant", PLAIN)
        self.assertEqual(got[0]["id"], "pal")
        self.assertIn("26382", got[0]["reason"])
        self.assertNotIn("vault", [g["id"] for g in got])        # private: not for a plain viewer
        self.assertEqual(L.suggest(self.db, "printer jammed again", PLAIN), [])
        # "greens storage" alone says nothing - every property is one.
        self.assertEqual(L.suggest(self.db, "greens storage gate", PLAIN), [])
        self.assertEqual(TP.suggest(text="Leak in unit b7 at Palisades", user=PLAIN, db=self.db)["suggestions"][0]["unit"], "B7")

    def test_suggest_property_links_proposes_and_a_manager_approves_one(self):
        t = self._new(user=ADMIN)                                 # the desk filed it with no property
        with self.assertRaises(HTTPException) as cm:
            TP.link_suggestions(user=PLAIN, db=self.db)
        self.assertEqual(cm.exception.status_code, 403)
        items = TP.link_suggestions(user=ADMIN, db=self.db)["items"]
        self.assertEqual([(i["ticket"]["id"], i["suggestions"][0]["id"]) for i in items], [(t["id"], "pal")])
        self.assertEqual(self.db.get(models.TaskTicket, t["id"]).property_asset_id, "")   # proposing links nothing
        out = TP.apply_link(t["id"], TP.LinkBody(property_asset_id="pal", property_unit="A101"),
                            BackgroundTasks(), user=ADMIN, db=self.db)
        self.assertEqual((out["propertyAssetId"], out["propertyUnit"]), ("pal", "A101"))
        self.assertEqual(TP.link_suggestions(user=ADMIN, db=self.db)["items"], [])
        with self.assertRaises(HTTPException) as cm:               # never re-points a linked one
            TP.apply_link(t["id"], TP.LinkBody(property_asset_id="esc"), BackgroundTasks(), user=ADMIN, db=self.db)
        self.assertEqual(cm.exception.status_code, 409)

    def test_a_dismissed_ticket_is_not_proposed_again(self):
        t = self._new(user=ADMIN)
        TP.dismiss_link(t["id"], user=ADMIN, db=self.db)
        self.assertEqual(TP.link_suggestions(user=ADMIN, db=self.db)["items"], [])

    # ── Facility <-> property ──
    def test_facility_maps_by_site_model_then_name_and_the_override_wins(self):
        self.assertEqual(L.property_for_facility(self.db, FAC).id, "pal")             # Cubby name
        self.assertEqual(L.facility_for_property(self.db, self.db.get(models.PropertyAsset, "pal")), FAC)
        L._site_models = lambda: [{"id": "greens-storage-escondido", "name": "Greens Storage Escondido",
                                   "apn": "", "cubbyFacilityId": "fac_ESC"}]
        self.assertEqual(L.property_for_facility(self.db, "fac_ESC").id, "esc")       # site model
        L.save_rules(self.db, {"facilityPropertyMap": {"fac_ESC": "pal"}}, ADMIN["email"])
        self.assertEqual(L.property_for_facility(self.db, "fac_ESC").id, "pal")       # override
        self.assertIsNone(L.property_for_facility(self.db, "fac_unknown"))

    # ── Maintenance map ──
    def _client(self, user):
        app = FastAPI()
        app.include_router(M.router)
        app.dependency_overrides[get_current_user] = lambda: dict(user)
        return TestClient(app)

    def test_the_maintenance_map_shape_and_open_items_only(self):
        a = self._new(property_asset_id="pal", property_unit="A101")
        c = self._new(property_asset_id="pal", property_unit="Common Area", subject="Gate sticks")
        done = self._new(property_asset_id="pal", property_unit="B7", subject="Fixed already")
        T.update_ticket(done["id"], T.TicketUpdate(status="resolved", resolution_note="Done"),
                        BackgroundTasks(), user=ADMIN, db=self.db)
        self.db.add(models.PropertyRecord(id="r1", property_id="pal", collection="maintenance",
                                          payload={"description": "Repaint door", "status": "Scheduled",
                                                   "unit": "a102", "date": "2026-10-25"}))
        self.db.add(models.PropertyRecord(id="r2", property_id="pal", collection="maintenance",
                                          payload={"description": "Old job", "status": "Completed", "unit": "A102"}))
        self.db.commit()
        r = self._client(ADMIN).get(f"/facility-ops/maintenance-map?facility_id={FAC}")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(set(body), {"units", "property"})
        self.assertEqual(sorted(body["units"]), ["A101", "A102"])
        item = body["units"]["A101"][0]
        self.assertEqual(set(item), {"id", "title", "status", "priority", "kind", "opened_at"})
        self.assertEqual((item["id"], item["kind"], item["status"]), (a["id"], "ticket", "open"))
        self.assertEqual(body["units"]["A102"][0]["kind"], "maintenance")
        self.assertEqual([i["id"] for i in body["property"]], [c["id"]])
        self.assertNotIn(done["id"], str(body))
        self.assertEqual(self._client(ADMIN).get("/facility-ops/maintenance-map?facility_id=fac_none").json(),
                         {"units": {}, "property": []})

    def test_the_maintenance_map_is_operations_read(self):
        self.assertEqual(self._client(OPS).get(f"/facility-ops/maintenance-map?facility_id={FAC}").status_code, 200)
        self.assertEqual(self._client(SUPER).get(f"/facility-ops/maintenance-map?facility_id={FAC}").status_code, 200)
        self.assertEqual(self._client(PLAIN).get(f"/facility-ops/maintenance-map?facility_id={FAC}").status_code, 401)


if __name__ == "__main__":
    unittest.main()
