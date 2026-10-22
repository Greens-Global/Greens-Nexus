"""Hiring documents by place (Neil, Oct 22 2026).

"There is a hiring packet that applies to California... an independent
contractor hiring packet that applies to India... When we open Texas, we'll add
a hiring packet for employees and one for contractors in Texas." And: "if
you've connected the India packet to the admin associate role, then it's an
issue." Several packets live side by side; each hire gets the one for where
they work and how they are hired, and a packet for another place never goes.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_hiring_docs_by_place.py -q
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import hr_life_events as hle  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

OSM, GS, GGC = "co-osm", "co-gs", "co-ggcon"      # California, Texas, India companies
HR = "hr.place.test@greensglobal.com"


def _packet(db, pid, *, entity="", country="", region="", wt="employee", roles=None, event="hire"):
    db.add(models.HrPacketSetting(id=pid, entity_id=entity, event=event, worker_type=wt, name=pid, engine="documents",
                                  doc_template_ids=["t"], flow=[], country=country, region=region,
                                  role_ids=roles or [], updated_at="2026-10-23"))


class PlaceFirstTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        os.environ["NEXUS_DEV_EMAIL"] = HR
        db = database.SessionLocal()
        for m in (models.HrPacketSetting, models.HrEntity, models.NexusRole, models.NexusGroup):
            db.query(m).delete()
        db.add(models.HrEntity(id=OSM, name="Oversite", country="US", region="CA"))
        db.add(models.HrEntity(id=GS, name="Greens Storage", country="US", region="TX"))
        db.add(models.HrEntity(id=GGC, name="GGCon", country="IN"))
        db.add(models.NexusRole(email=HR, role="owner"))
        _packet(db, "ca-employee", country="US", region="CA", wt="employee")
        _packet(db, "ca-contractor", country="US", region="CA", wt="contractor")
        _packet(db, "tx-employee", country="US", region="TX", wt="employee")
        _packet(db, "us-employee", country="US", wt="employee")
        _packet(db, "in-contractor", country="IN", wt="contractor")
        # The mistake Neil named: a role's packet with no place at all.
        _packet(db, "admin-assoc-anywhere", wt="any", roles=["jr-admin"])
        db.commit()
        db.close()
        self.db = database.SessionLocal()

    def tearDown(self):
        self.db.close()
        auth.SKIP_AUTH = self._skip

    def pick(self, entity, wt, role="", country="", region=""):
        s = hle.resolve_setting(self.db, entity, "hire", wt, role, country, region=region)
        return s.id if s else None

    def test_each_hire_gets_the_packet_for_where_they_work(self):
        self.assertEqual(self.pick(OSM, "employee"), "ca-employee")          # the company's state
        self.assertEqual(self.pick(OSM, "contractor"), "ca-contractor")
        self.assertEqual(self.pick(GS, "employee"), "tx-employee")
        self.assertEqual(self.pick(GGC, "contractor"), "in-contractor")
        # A Texas company's hire working in California gets California's paperwork.
        self.assertEqual(self.pick(GS, "employee", country="US", region="CA"), "ca-employee")
        # A state with no packet of its own falls back to the country-wide one.
        self.assertEqual(self.pick(OSM, "employee", country="US", region="NV"), "us-employee")

    def test_a_role_packet_never_takes_another_places_paperwork(self):
        # A California admin associate gets California's packet, not the role's place-less one.
        self.assertEqual(self.pick(OSM, "employee", role="jr-admin"), "ca-employee")
        self.assertEqual(self.pick(GGC, "contractor", role="jr-admin"), "in-contractor")
        # Where nothing fits the place, the role's place-less packet is the last resort.
        self.assertEqual(self.pick(GGC, "employee", role="jr-admin"), "admin-assoc-anywhere")
        # Among packets for the SAME place, the role's own wins.
        db = database.SessionLocal()
        _packet(db, "ca-admin-only", country="US", region="CA", wt="employee", roles=["jr-admin"])
        db.commit()
        db.close()
        self.assertEqual(self.pick(OSM, "employee", role="jr-admin"), "ca-admin-only")
        self.assertEqual(self.pick(OSM, "employee", role="jr-other"), "ca-employee")

    def test_a_packet_for_another_country_or_state_is_never_sent(self):
        self.assertIsNone(self.pick(GGC, "employee"))                      # nothing for Indian employees
        db = database.SessionLocal()
        db.query(models.HrPacketSetting).filter(models.HrPacketSetting.id.in_(["us-employee", "admin-assoc-anywhere"])).delete()
        db.commit()
        db.close()
        self.assertIsNone(self.pick(OSM, "employee", country="US", region="NV"))   # CA / TX packets never reach Nevada

    def test_a_company_packet_beats_the_one_for_every_company_at_the_same_place(self):
        db = database.SessionLocal()
        _packet(db, "osm-ca-employee", entity=OSM, country="US", region="CA", wt="employee")
        db.commit()
        db.close()
        self.assertEqual(self.pick(OSM, "employee"), "osm-ca-employee")
        self.assertEqual(self.pick(GS, "employee", country="US", region="CA"), "ca-employee")

    def _save(self, **kw):
        body = dict(entity_id="", event="hire", name="Packet", doc_template_ids=[], flow=[], worker_type="employee")
        body.update(kw)
        return self.client.put("/hr/packets/documents", json=body)

    def test_a_hiring_packet_must_say_where_it_applies_and_one_per_place(self):
        r = self._save(country="")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Works In", r.json()["detail"])
        r = self._save(name="Second CA", country="US", region="CA")
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn('"ca-employee" already covers Employees in California', r.json()["detail"])

    def test_a_company_carries_its_state(self):
        r = self.client.patch(f"/hr/entities/{OSM}", json={"region": " ca "})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["region"], "CA")
        self.assertEqual(hle.region_of(self.db, GS), "TX")
        self.assertEqual(hle.place_label("contractor", "IN"), "Contractors in India")
        self.assertEqual(hle.kind_of_hire("employee", "US", "TX"), "an Employee in Texas")


if __name__ == "__main__":
    unittest.main()


class CoverageTests(PlaceFirstTests):
    """What Each Hire Gets: the same picker a real hire uses, per company."""

    def test_coverage_shows_what_each_company_sends_and_the_gaps(self):
        r = self.client.get("/hr/packets/coverage")
        self.assertEqual(r.status_code, 200, r.text)
        by = {c["id"]: c for c in r.json()["companies"]}
        osm = {row["workerType"]: row for row in by[OSM]["rows"]}
        self.assertEqual(osm["employee"]["hire"]["id"], "ca-employee")
        self.assertEqual(osm["contractor"]["hire"]["id"], "ca-contractor")
        self.assertIsNone(osm["employee"]["offer"])                       # no offer letter set up yet
        gs = {row["workerType"]: row for row in by[GS]["rows"]}
        self.assertEqual(gs["employee"]["hire"]["id"], "tx-employee")
        ggc = {row["workerType"]: row for row in by[GGC]["rows"]}
        self.assertEqual(ggc["contractor"]["hire"]["id"], "in-contractor")
        # India employees: only the role-only place-less packet could fit, never for "any role".
        self.assertIsNone(ggc["employee"]["hire"])
        self.assertEqual(by[OSM]["region"], "CA")
        self.assertEqual([u["id"] for u in r.json()["unplaced"]], ["admin-assoc-anywhere"])
