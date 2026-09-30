"""Work site placed from a Google Maps link (Pranshu, Sep 30).

The parser must take the PLACE's own point from a link (the `!3d!4d` pair),
not the map view's centre (`@lat,lng`), which can sit hundreds of metres off;
short share links are opened on the server hop by hop and ONLY to Google
hosts; the site keeps the link as the record of its point; and the fence
check counts recent punches inside a proposed fence the same way the time
clock judges them.

    python -m unittest test_worksite_map_link
"""
import os
import tempfile
import unittest
import uuid
from datetime import datetime, timezone

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
from maps_link import (MapLinkError, PRECISION_COORDS, PRECISION_PIN, PRECISION_PLACE,  # noqa: E402
                       PRECISION_VIEW, is_google_host, parse_point, resolve_link)

models.Base.metadata.create_all(bind=database.engine)

PLACE = ("https://www.google.com/maps/place/469+Bohemian+Hwy,+Sebastopol,+CA+95472/"
         "@38.3740214,-122.9195433,17z/data=!3m1!4b1!4m6!3m5!1s0x8084b8f!8m2!3d38.3733338!4d-122.916713!16s%2Fg%2F11c")
PIN_DMS = ("https://www.google.com/maps/place/38%C2%B022'24.0%22N+122%C2%B055'00.2%22W/"
           "@38.373,-122.9189,17z/data=!3m1!4b1!4m4!3m3!8m2!3d38.3733333!4d-122.9167222")


class ParseTest(unittest.TestCase):
    def test_place_link_uses_the_place_not_the_map_view(self):
        r = parse_point(PLACE)
        self.assertEqual(r["precision"], PRECISION_PLACE)
        self.assertEqual((r["lat"], r["lng"]), (38.3733338, -122.916713))   # not @38.3740214
        self.assertEqual(r["label"], "469 Bohemian Hwy, Sebastopol, CA 95472")

    def test_dropped_pin_link(self):
        r = parse_point(PIN_DMS)
        self.assertEqual((r["precision"], r["lat"], r["lng"]), (PRECISION_PLACE, 38.3733333, -122.9167222))
        r = parse_point("https://www.google.com/maps/place/38%C2%B022'24.0%22N+122%C2%B055'00.2%22W/@38.373,-122.9189,17z")
        self.assertEqual((r["precision"], r["lat"]), (PRECISION_PIN, 38.3733333))

    def test_query_links(self):
        for url in ("https://www.google.com/maps?q=38.37333,-122.91671",
                    "https://www.google.com/maps/search/?api=1&query=38.37333%2C-122.91671",
                    "https://maps.google.com/?q=38.37333,+-122.91671",
                    "https://www.google.com/maps/search/38.37333,+-122.91671"):
            r = parse_point(url)
            self.assertEqual((r["precision"], r["lat"], r["lng"]), (PRECISION_PIN, 38.37333, -122.91671), url)

    def test_plain_coordinates(self):
        for text in ("38.37333, -122.91671", "38.37333,-122.91671", "(38.37333, -122.91671)",
                     "38.37333 -122.91671", "38°22'24.0\"N 122°55'00.2\"W", "38°22′24.0″N 122°55′00.2″W"):
            r = parse_point(text)
            self.assertEqual(r["precision"], PRECISION_COORDS, text)
            self.assertAlmostEqual(r["lat"], 38.37333, places=4)
            self.assertAlmostEqual(r["lng"], -122.91671, places=4)

    def test_map_view_only_is_flagged(self):
        for url in ("https://www.google.com/maps/@38.3740214,-122.9195433,17z",
                    "https://maps.google.co.in/maps?ll=38.37,-122.91&z=15"):
            self.assertEqual(parse_point(url)["precision"], PRECISION_VIEW, url)

    def test_refuses_what_is_not_a_point(self):
        for text in ("", "hello", "0,0", "95.0, 10.0", "38.3, -222.9",
                     "https://www.google.com/maps/search/469+bohemian+hwy",
                     "https://evil.example.com/maps/@38.3,-122.9,17z",
                     "https://google.com.evil.com/maps/@38.3,-122.9,17z",
                     "https://maps.app.goo.gl/abc123"):   # short link: must be resolved
            with self.assertRaises(MapLinkError, msg=text):
                parse_point(text)

    def test_google_hosts(self):
        for h in ("www.google.com", "google.com", "maps.google.com", "maps.google.co.in",
                  "www.google.com.au", "maps.app.goo.gl", "goo.gl", "share.google", "consent.google.com"):
            self.assertTrue(is_google_host(h), h)
        for h in ("google.com.evil.com", "evilgoogle.com", "maps.app.goo.gl.evil.io", "localhost", "169.254.169.254", ""):
            self.assertFalse(is_google_host(h), h)


class ResolveTest(unittest.TestCase):
    def fake(self, hops):
        seen = []

        def fetch(url):
            seen.append(url)
            return hops[len(seen) - 1]
        return fetch, seen

    def test_short_link_is_followed_to_the_place(self):
        fetch, seen = self.fake([(302, PLACE)])
        r = resolve_link("https://maps.app.goo.gl/AbC123", fetch=fetch)
        self.assertEqual((r["precision"], r["lat"]), (PRECISION_PLACE, 38.3733338))
        self.assertEqual(r["shortUrl"], "https://maps.app.goo.gl/AbC123")
        self.assertEqual(seen, ["https://maps.app.goo.gl/AbC123"])   # the Google page itself is never fetched

    def test_short_link_without_scheme_and_chained_hops(self):
        fetch, _ = self.fake([(301, "https://goo.gl/maps/xyz"), (302, PLACE)])
        self.assertEqual(resolve_link("maps.app.goo.gl/AbC123", fetch=fetch)["lat"], 38.3733338)

    def test_never_follows_a_redirect_off_google(self):
        for target in ("http://169.254.169.254/latest/meta-data", "https://evil.example.com/x",
                       "file:///etc/passwd", "http://localhost:8000/admin"):
            fetch, seen = self.fake([(302, target), (302, PLACE)])
            with self.assertRaises(MapLinkError):
                resolve_link("https://maps.app.goo.gl/AbC123", fetch=fetch)
            self.assertEqual(len(seen), 1, target)   # the off-Google hop was never opened

    def test_expired_and_broken_links(self):
        for hops in ([(404, "")], [(200, "")]):
            fetch, _ = self.fake(hops)
            with self.assertRaises(MapLinkError):
                resolve_link("https://maps.app.goo.gl/gone", fetch=fetch)

        def boom(url):
            raise OSError("network down")
        with self.assertRaises(MapLinkError):
            resolve_link("https://maps.app.goo.gl/AbC123", fetch=boom)

    def test_redirect_loop_stops(self):
        fetch, seen = self.fake([(302, "https://maps.app.goo.gl/loop")] * 10)
        with self.assertRaises(MapLinkError):
            resolve_link("https://maps.app.goo.gl/loop", fetch=fetch)
        self.assertLessEqual(len(seen), 6)

    def test_full_link_needs_no_network(self):
        def fail(url):
            raise AssertionError("fetched a full link")
        self.assertEqual(resolve_link(PLACE, fetch=fail)["precision"], PRECISION_PLACE)


ADMIN = "maplink.admin@greensglobal.com"
GROUP = "grp-maplink-test"


class EndpointTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = ADMIN
        self.site_ids, self.punch_ids = [], []
        db = database.SessionLocal()
        try:
            if not db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).first():
                db.add(models.NexusGroup(id=GROUP, name="Map link test", allowed_modules="hr:editor"))
                db.add(models.NexusGroupMember(group_id=GROUP, email=ADMIN))
                db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()

    def tearDown(self):
        db = database.SessionLocal()
        try:
            db.query(models.HrWorkSite).filter(models.HrWorkSite.id.in_(self.site_ids)).delete(synchronize_session=False)
            db.query(models.TimePunch).filter(models.TimePunch.id.in_(self.punch_ids)).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email

    def create(self, **body):
        r = self.client.post("/hr/work-sites", json={"name": "Link Test", "radius_m": 150, **body})
        if r.status_code == 200:
            self.site_ids.append(r.json()["id"])
        return r

    def test_resolve_endpoint(self):
        r = self.client.post("/hr/work-sites/resolve-link", json={"link": PLACE})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["precision"], "place")
        bad = self.client.post("/hr/work-sites/resolve-link", json={"link": "https://evil.example.com/x"})
        self.assertEqual(bad.status_code, 422)
        self.assertIn("Google Maps", bad.json()["detail"])

    def test_site_keeps_its_link_and_is_verified(self):
        r = self.create(address="469 Bohemian Hwy, Sebastopol, CA 95472", latitude="38.373334",
                        longitude="-122.916713", location_source="google_link", map_link=PLACE)
        self.assertEqual(r.status_code, 200, r.text)
        s = r.json()
        self.assertEqual((s["locationSource"], s["mapLink"]), ("google_link", PLACE))
        self.assertTrue(s["addressVerifiedAt"])
        self.assertEqual(s["addressVerifiedBy"], ADMIN)

    def test_google_link_site_must_carry_a_valid_link_and_point(self):
        self.assertEqual(self.create(latitude="38.37", longitude="-122.91", location_source="google_link").status_code, 400)
        self.assertEqual(self.create(location_source="google_link", map_link=PLACE).status_code, 400)
        self.assertEqual(self.create(latitude="38.37", longitude="-122.91", location_source="google_link",
                                     map_link="https://evil.example.com/x").status_code, 400)
        self.assertEqual(self.create(latitude="38.37", longitude="-122.91", location_source="bogus").status_code, 400)

    def test_moving_the_point_without_a_source_drops_the_link(self):
        sid = self.create(latitude="38.373334", longitude="-122.916713",
                          location_source="google_link", map_link=PLACE).json()["id"]
        # a new link re-stamps it
        r = self.client.patch(f"/hr/work-sites/{sid}", json={"latitude": "38.3734", "longitude": "-122.9168",
                                                            "location_source": "google_link", "map_link": PIN_DMS})
        self.assertEqual((r.json()["locationSource"], r.json()["mapLink"]), ("google_link", PIN_DMS))
        # a radius-only edit keeps it
        r = self.client.patch(f"/hr/work-sites/{sid}", json={"radius_m": 200})
        self.assertEqual((r.json()["locationSource"], r.json()["radiusM"]), ("google_link", 200))
        # coordinates changed by an older client: nothing vouches for them now
        r = self.client.patch(f"/hr/work-sites/{sid}", json={"latitude": "38.5", "longitude": "-122.5"})
        self.assertEqual((r.json()["locationSource"], r.json()["mapLink"], r.json()["addressVerifiedAt"]), ("", "", ""))

    def test_fence_check_counts_like_the_time_clock(self):
        # A site placed 3 km away; the crew actually punches at the new point.
        sid = self.create(latitude="38.4000", longitude="-122.9167").json()["id"]
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        db = database.SessionLocal()
        try:
            def punch(lat, lng, acc=10):
                pid = str(uuid.uuid4())
                self.punch_ids.append(pid)
                db.add(models.TimePunch(id=pid, employee_email="crew@greensglobal.com", kind="in",
                                        at=f"{today}T15:00:00", local_date=today, lat=str(lat), lng=str(lng),
                                        accuracy_m=acc, voided=0, source="web"))
            punch(38.37335, -122.91672)            # at the building
            punch(38.3740, -122.9167)              # ~74 m away
            punch(38.3760, -122.9167, acc=100)     # ~296 m, but +/-100 m credit -> inside a 200 m fence
            punch(38.3760, -122.9167, acc=900)     # rough fix: never inside
            punch(38.3823, -122.9167)              # ~1 km: outside, but still "near"
            punch(38.4000, -122.9167)              # at the saved (wrong) point
            db.commit()
        finally:
            db.close()
        r = self.client.get("/hr/work-sites/fence-check",
                            params={"lat": 38.37333, "lng": -122.91671, "radius_m": 200, "site_id": sid})
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual((d["inside"], d["people"], d["savedInside"]), (3, 1, 1), d)
        self.assertEqual(d["near"], 5, d)   # the saved-point punch is 3 km away: not near the new fence
        self.assertEqual(sum(1 for p in d["points"] if p["inside"]), 3)
        self.assertNotIn("email", d["points"][0])


if __name__ == "__main__":
    unittest.main()
