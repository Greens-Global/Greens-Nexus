"""
Mark an Issue on the Map (Charmi, Oct 20 2026) - ticket_map_spot.py,
routers/ticket_map_spots.py, the map_spot on POST /task-tickets.

  * a ticket created with a spot is a normal ticket on its property, and the
    spot is stored (circle, outline, lat / lng from the model's geo frame);
  * the spot is checked: property required, the map must be that property's,
    finite coordinates inside the site, a sane radius and outline;
  * photo URLs on the ticket still pass _validate_photo_url;
  * the map read is staff only, the ticket read is the ticket's own check;
  * closed tickets leave the map; the customer views never carry a spot.

Uses the real Escondido site model file; throwaway sqlite, no network.
Run: python -m pytest test_ticket_map_spot.py -q
"""
import json
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
import ticket_map_spot as S                       # noqa: E402
from auth import get_current_user                 # noqa: E402
from database import get_db                       # noqa: E402
from routers.task_util import gen_id              # noqa: E402
from routers import items as I                    # noqa: E402
from routers import site_models as SM             # noqa: E402
from routers import tickets as T                  # noqa: E402
from routers import ticket_map_spots as R         # noqa: E402
from routers import unit_map as UM                # noqa: E402

ADMIN = {"email": "neil@greensglobal.com", "role": "administrator", "level": 4}
PLAIN = {"email": "darshana@greensglobal.com", "role": "employee", "level": 1}
OTHER = {"email": "someone@greensglobal.com", "role": "employee", "level": 1}
OPS = {"email": "ops@greensglobal.com", "role": "employee", "level": 1}
MODEL = "greens-storage-escondido"
STORE = "https://example.supabase.co/storage/v1/object/public/"


class TicketMapSpotTests(unittest.TestCase):
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
                  models.TaskAttachment, models.NexusEmployee, models.NexusRole, models.NexusGroup,
                  models.NexusGroupMember, models.PropertyAsset, models.HrDepartment, models.NexusSetting,
                  models.CubbyFacility, models.CubbyUnit, models.SiteModelMarkup, models.NexusCounter):
            self.db.query(m).execution_options(include_deleted=True).delete()
        for u in (ADMIN, PLAIN, OTHER, OPS):
            self.db.add(models.NexusEmployee(id=gen_id(), first_name=u["email"].split("@")[0], work_email=u["email"],
                                             status="active", identity_type="internal"))
        self.db.add(models.NexusRole(email=ADMIN["email"], role="administrator"))
        self.db.add(models.NexusGroup(id="g-ops", name="Ops", allowed_modules="operations:viewer"))
        self.db.add(models.NexusGroupMember(group_id="g-ops", email=OPS["email"]))
        self.db.add(models.HrDepartment(id="d-fac", company_id="c1", name="Construction"))
        self.db.add(models.PropertyAsset(id="esc", name="Greens Storage Escondido", asset_type="Self-Storage",
                                         payload={"kind": "property", "address": "25260 N Centre City Pkwy"}))
        self.db.add(models.PropertyAsset(id="pal", name="Palisades Self Storage", asset_type="Self-Storage",
                                         payload={"kind": "property", "address": "26382 Palisades Dr"}))
        self.db.commit()
        cache.module_grants.invalidate()
        self._prefix = I._STORAGE_PREFIX
        I._STORAGE_PREFIX = STORE

    def tearDown(self):
        I._STORAGE_PREFIX = self._prefix
        self.db.close()

    def _spot(self, **kw):
        return {"modelId": MODEL, "u": -26.8, "v": -43.9, "y": 0, "r": 6.5, "unit": "F001", "building": "F",
                "place": "Near F001, Building F", **kw}

    def _new(self, user=PLAIN, prop="esc", spot=None, **kw):
        body = T.TicketBody(subject=kw.pop("subject", "Light out by F001"), description="The pole light is out",
                            application="Electrical", hr_department_id="d-fac", property_asset_id=prop,
                            property_unit=kw.pop("unit", "Common Area"), map_spot=spot, **kw)
        return T.create_ticket(body, BackgroundTasks(), user=user, db=self.db)

    def _client(self, user):
        app = FastAPI()
        app.include_router(R.router)
        app.dependency_overrides[get_current_user] = lambda: user

        def _db():
            yield self.db
        app.dependency_overrides[get_db] = _db
        return TestClient(app)

    # ── Create ──
    def test_a_ticket_with_a_spot_is_a_normal_property_ticket_and_keeps_its_spot(self):
        out = self._new(spot=self._spot(outline=[[-30, -40], [-22, -40], [-22, -48], [-30, -48]]))
        self.assertEqual((out["propertyAssetId"], out["status"]), ("esc", "open"))
        row = self.db.query(models.SiteModelMarkup).filter_by(ticket_id=out["id"]).one()
        self.assertEqual((row.property_id, row.unit, row.radius, row.category), (MODEL, "F001", 6.5, "maintenance"))
        self.assertEqual(json.loads(row.outline)[0], [-30.0, -40.0])
        self.assertEqual(row.place, "Near F001, Building F")
        # lat / lng from the model's geo frame, worked out on the server
        self.assertAlmostEqual(row.lat, 33.171, delta=0.01)
        self.assertAlmostEqual(row.lng, -117.1075, delta=0.01)
        self.assertEqual(row.title, "Light out by F001")
        # ...and a ticket without one has none
        plain = self._new()
        self.assertEqual(self.db.query(models.SiteModelMarkup).filter_by(ticket_id=plain["id"]).count(), 0)

    def test_the_spot_is_checked_before_anything_is_written(self):
        before = self.db.query(models.TaskTicket).count()
        bad = [   # (property, spot, what the 400 says)
            ("", self._spot(), "Pick the property"),
            ("pal", self._spot(), "not Palisades"),
            ("esc", self._spot(modelId="no-such-site"), "not available"),
            ("esc", self._spot(modelId="../etc"), "Mark the spot"),
            ("esc", self._spot(u="nan"), "must be a number"),
            ("esc", self._spot(u=99999), "outside the site"),
            ("esc", self._spot(r=900), "smaller spot"),
            ("esc", self._spot(r=-1), "smaller spot"),
            ("esc", self._spot(outline=[[0, 0]] * 500), "too many points"),
            ("esc", self._spot(outline=[[0, "x"], [1, 1], [2, 2]]), "must be a number"),
            ("esc", self._spot(outline="a circle"), "wrong shape"),
        ]
        for prop, spot, words in bad:
            with self.subTest(words=words), self.assertRaises(HTTPException) as cm:
                self._new(prop=prop, spot=spot, unit="" if not prop else "Common Area", user=ADMIN if not prop else PLAIN)
            self.assertEqual(cm.exception.status_code, 400)
            self.assertIn(words, cm.exception.detail)
            self.db.rollback()
        self.assertEqual(self.db.query(models.TaskTicket).count(), before)
        self.assertEqual(self.db.query(models.SiteModelMarkup).count(), 0)

    def test_a_junk_unit_is_dropped_never_stored(self):
        out = self._new(spot=self._spot(unit="<script>", building="F'; drop"))
        row = self.db.query(models.SiteModelMarkup).filter_by(ticket_id=out["id"]).one()
        self.assertEqual((row.unit, row.building), ("", "F drop"))

    # ── Photos ──
    def test_photo_urls_must_be_our_storage_and_the_first_photo_rides_on_the_spot(self):
        out = self._new(spot=self._spot())
        att = T.TicketAttachmentBody
        with self.assertRaises(HTTPException) as cm:
            T.add_ticket_attachment(out["id"], att(name="x.png", kind="image", url="https://evil.example.com/x.png"),
                                    BackgroundTasks(), user=PLAIN, db=self.db)
        self.assertEqual(cm.exception.status_code, 400)
        T.add_ticket_attachment(out["id"], att(name="Map Location F001.jpg", kind="image", url=STORE + "ticket-evidence/map.jpg"),
                                BackgroundTasks(), user=PLAIN, db=self.db)
        T.add_ticket_attachment(out["id"], att(name="pole.jpg", kind="image", url=STORE + "ticket-evidence/pole.jpg"),
                                BackgroundTasks(), user=PLAIN, db=self.db)
        spot = S.spots_for_model(self.db, MODEL, ADMIN)["spots"][0]
        self.assertTrue(spot["photo"].endswith("pole.jpg"))
        self.assertTrue(spot["mapImage"].endswith("map.jpg"))

    # ── Reads + permissions ──
    def test_the_map_read_is_staff_only_and_open_tickets_only(self):
        out = self._new(spot=self._spot())
        self.assertEqual(self._client(PLAIN).get(f"/ticket-map-spots?model_id={MODEL}").status_code, 401)
        r = self._client(OPS).get(f"/ticket-map-spots?model_id={MODEL}")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["property"], {"id": "esc", "name": "Greens Storage Escondido"})
        self.assertEqual([s["ticketId"] for s in body["spots"]], [out["id"]])
        self.assertEqual(body["spots"][0]["r"], 6.5)
        t = self.db.get(models.TaskTicket, out["id"])
        t.status = "closed"
        self.db.commit()
        self.assertEqual(self._client(OPS).get(f"/ticket-map-spots?model_id={MODEL}").json()["spots"], [])

    def test_a_private_property_keeps_its_spots_private(self):
        self._new(spot=self._spot())
        p = self.db.get(models.PropertyAsset, "esc")
        p.payload = {**p.payload, "private": True}
        self.db.commit()
        self.assertEqual(S.spots_for_model(self.db, MODEL, OPS), {"property": None, "spots": []})

    def test_the_ticket_read_follows_the_ticket(self):
        out = self._new(spot=self._spot())
        r = self._client(PLAIN).get(f"/ticket-map-spots/ticket/{out['id']}")
        self.assertEqual(r.status_code, 200)
        spot = r.json()["spot"]
        self.assertEqual((spot["ticketId"], spot["modelId"], spot["facilityId"]), (out["id"], MODEL, "fac_UvKP7sgZpMz"))
        self.assertIn(self._client(OTHER).get(f"/ticket-map-spots/ticket/{out['id']}").status_code, (403, 404))
        none = self._new()
        self.assertIsNone(self._client(PLAIN).get(f"/ticket-map-spots/ticket/{none['id']}").json()["spot"])

    def test_customer_views_never_carry_a_spot(self):
        out = self._new(spot=self._spot(), subject="Secret pole light")
        model = SM.load_model(MODEL)
        public = json.dumps(SM.public_view(SM.with_live(model)))
        customer = json.dumps(UM.customer_view(self.db, MODEL, "F001"))
        for blob in (public, customer):
            self.assertNotIn("Secret pole light", blob)
            self.assertNotIn(out["id"], blob)
            self.assertNotIn("Near F001", blob)


if __name__ == "__main__":
    unittest.main()
