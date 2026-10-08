"""Locations (Neil, Oct 1): the address comes from the pasted Google Maps link,
written the US way, and the companies using a location are picked right in
its form (All, or some).

    python -m unittest test_location_address
"""
import os
import tempfile
import unittest

# Its own throwaway database (CLAUDE.md): every column exists from the start.
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from site_address import address_for, address_from_label, format_address, reverse_address  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

PLACE = ("https://www.google.com/maps/place/25260+N+Centre+City+Pkwy,+Escondido,+CA+92026/"
         "@33.15,-117.12,17z/data=!3m1!4b1!4m6!3m5!1s0x0!8m2!3d33.1512!4d-117.1189!16s%2Fg%2F11c")
# Nominatim's parts for the same building - its display string is the "goofy"
# form Neil saw: "25260, North Centre City Parkway, Escondido, San Diego
# County, California, 92026, United States".
OSM_PARTS = {"house_number": "25260", "road": "North Centre City Parkway", "city": "Escondido",
             "county": "San Diego County", "state": "California", "postcode": "92026",
             "country": "United States", "country_code": "us"}


class AddressTest(unittest.TestCase):
    def test_an_address_label_is_used_as_google_wrote_it(self):
        self.assertEqual(address_from_label("25260 N Centre City Pkwy, Escondido, CA 92026"),
                         ("25260 N Centre City Pkwy, Escondido, CA 92026", ""))

    def test_a_business_label_gives_its_name_and_address(self):
        self.assertEqual(
            address_from_label("Greens Storage, 25260 N Centre City Pkwy, Escondido, California 92026, United States"),
            ("25260 N Centre City Pkwy, Escondido, CA 92026", "Greens Storage"))
        self.assertEqual(address_from_label("Greens Storage"), ("", "Greens Storage"))

    def test_a_coordinate_label_is_neither(self):
        for label in ("38°22'24.0\"N 122°55'00.2\"W", "38.37, -122.91", "", "   "):
            self.assertEqual(address_from_label(label), ("", ""))

    def test_a_street_without_a_city_is_not_an_address(self):
        self.assertEqual(address_from_label("12 Main St")[0], "")

    def test_lookup_parts_are_written_the_us_way(self):
        self.assertEqual(format_address(OSM_PARTS), "25260 North Centre City Parkway, Escondido, CA 92026")
        self.assertEqual(format_address({**OSM_PARTS, "city": "", "town": "Sebastopol", "house_number": ""}),
                         "North Centre City Parkway, Sebastopol, CA 92026")

    def test_lookup_outside_the_us_keeps_the_country(self):
        self.assertEqual(format_address({"house_number": "5", "road": "MG Road", "city": "Pune", "state": "Maharashtra",
                                         "postcode": "411001", "country": "India", "country_code": "in"}),
                         "5 MG Road, Pune, Maharashtra 411001, India")

    def test_no_street_no_address(self):
        self.assertEqual(format_address({"city": "Escondido", "country_code": "us"}), "")

    def test_reverse_lookup_never_raises(self):
        self.assertEqual(reverse_address(33.1, -117.1, fetch=lambda la, ln: {"address": OSM_PARTS}),
                         "25260 North Centre City Parkway, Escondido, CA 92026")

        def boom(la, ln):
            raise OSError("offline")
        self.assertEqual(reverse_address(33.1, -117.1, fetch=boom), "")
        self.assertEqual(reverse_address(33.1, -117.1, fetch=lambda la, ln: None), "")

    def test_address_for_prefers_the_link_then_the_lookup(self):
        calls = []

        def fetch(la, ln):
            calls.append((la, ln))
            return {"address": OSM_PARTS}
        out = address_for({"lat": 33.15, "lng": -117.12, "label": "25260 N Centre City Pkwy, Escondido, CA 92026"}, fetch=fetch)
        self.assertEqual(out, {"address": "25260 N Centre City Pkwy, Escondido, CA 92026", "placeName": ""})
        self.assertEqual(calls, [])   # the link had it - no lookup
        out = address_for({"lat": 33.15, "lng": -117.12, "label": "Greens Storage"}, fetch=fetch)
        self.assertEqual(out, {"address": "25260 North Centre City Parkway, Escondido, CA 92026", "placeName": "Greens Storage"})


ADMIN = "locations.admin@greensglobal.com"
GROUP = "grp-locations-test"
COS = ("co-loc-a", "co-loc-b", "co-loc-c")


class EndpointTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = ADMIN
        self.site_ids = []
        db = database.SessionLocal()
        try:
            if not db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).first():
                db.add(models.NexusGroup(id=GROUP, name="Locations test", allowed_modules="hr:editor"))
                db.add(models.NexusGroupMember(group_id=GROUP, email=ADMIN))
            for cid in COS:
                if not db.query(models.HrEntity).filter(models.HrEntity.id == cid).first():
                    db.add(models.HrEntity(id=cid, name=f"Company {cid[-1].upper()}"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()

    def tearDown(self):
        db = database.SessionLocal()
        try:
            db.query(models.HrCompanyWorkSite).filter(models.HrCompanyWorkSite.site_id.in_(self.site_ids)).delete(synchronize_session=False)
            db.query(models.HrWorkSite).filter(models.HrWorkSite.id.in_(self.site_ids)).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email

    def create(self, **body):
        r = self.client.post("/hr/work-sites", json={"name": "Escondido", "radius_m": 150, **body})
        if r.status_code == 200:
            self.site_ids.append(r.json()["id"])
        return r

    def test_resolve_returns_the_address_from_the_link(self):
        r = self.client.post("/hr/work-sites/resolve-link", json={"link": PLACE})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["precision"], "place")
        self.assertEqual(body["address"], "25260 N Centre City Pkwy, Escondido, CA 92026")
        self.assertEqual(body["placeName"], "")

    def test_companies_are_set_on_create_and_replaced_on_edit(self):
        r = self.create(company_ids=["co-loc-a", "co-loc-b"])
        self.assertEqual(r.status_code, 200, r.text)
        sid = r.json()["id"]
        self.assertEqual(r.json()["companies"], ["co-loc-a", "co-loc-b"])
        r = self.client.patch(f"/hr/work-sites/{sid}", json={"company_ids": list(COS)})
        self.assertEqual(r.json()["companies"], list(COS))
        r = self.client.patch(f"/hr/work-sites/{sid}", json={"company_ids": ["co-loc-c"]})
        self.assertEqual(r.json()["companies"], ["co-loc-c"])
        # Leaving company_ids out keeps the links.
        r = self.client.patch(f"/hr/work-sites/{sid}", json={"notes": "Gate on the left"})
        self.assertEqual(r.json()["companies"], ["co-loc-c"])

    def test_an_unknown_company_is_refused(self):
        self.assertEqual(self.create(company_ids=["no-such-company"]).status_code, 404)

    def test_none_picked_means_library_only(self):
        r = self.create(company_ids=[])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["companies"], [])


if __name__ == "__main__":
    unittest.main()
