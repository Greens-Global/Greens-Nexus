"""Clocked hours per store (Neil, 11/21/2026) - as tests.

Which work site is which store (the store's coordinates inside the site's own
geofence; several sites add up; no coordinates = no tie), the window (complete
days, ending yesterday), what counts (worked minutes to the site of the day's
first clock-in; voided and paid-leave punches left out; a shift still open
counts nothing), and that only hours and a head count come back. Its own
throwaway database.

    python -m pytest test_ops_store_hours.py -q
"""
import os
import tempfile
import unittest
from datetime import date

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

import database                # noqa: E402
import models                  # noqa: E402
import ops_store_hours as osh  # noqa: E402

TODAY = date(2026, 11, 21)     # the window is 11/14 - 11/20


def _punch(pid, who, kind, day, hhmm, site="", category="", voided=0):
    return models.TimePunch(id=pid, employee_email=who, kind=kind, at=f"{day}T{hhmm}:00", local_date=day,
                            work_site_id=site, category=category, voided=voided)


class Rules(unittest.TestCase):
    def test_a_site_is_a_stores_when_the_store_sits_inside_its_geofence(self):
        stores = [{"id": "oak", "lat": "33.1000", "lng": "-117.1000"}, {"id": "far", "lat": 34.0, "lng": -118.0},
                  {"id": "nowhere", "lat": "", "lng": None}]
        sites = [{"id": "s-oak", "lat": "33.1005", "lng": "-117.1005", "radius": 150},      # about 73 m away
                 {"id": "s-oak-east", "lat": 33.1010, "lng": -117.1000, "radius": 250},     # about 111 m away
                 {"id": "s-tight", "lat": 33.1010, "lng": -117.1000, "radius": 50},         # the same spot, too tight
                 {"id": "s-no-fence", "lat": 33.1000, "lng": -117.1000, "radius": 0},
                 {"id": "s-blank", "lat": "", "lng": "", "radius": 500}]
        self.assertEqual(osh.sites_by_store(stores, sites), {"oak": ["s-oak", "s-oak-east"]})

    def test_distance_is_ground_distance(self):
        self.assertAlmostEqual(osh.meters_between(33.1, -117.1, 33.101, -117.1), 111.2, delta=0.5)
        self.assertEqual(osh.meters_between(33.1, -117.1, 33.1, -117.1), 0)

    def test_the_window_is_complete_days_ending_yesterday(self):
        self.assertEqual(osh.window(TODAY), ("2026-11-14", "2026-11-20"))
        self.assertEqual(osh.window(TODAY, 1), ("2026-11-20", "2026-11-20"))
        self.assertEqual(osh.window(TODAY, 0), ("2026-11-14", "2026-11-20"))        # nonsense reads as the default
        self.assertEqual(osh.window(TODAY, 999)[0], "2026-10-21")                   # never more than 31 days


class Hours(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TimePunch, models.HrWorkSite, models.CubbyFacility):
            self.db.query(m).delete()
        db = self.db
        db.add(models.CubbyFacility(facility_id="f-oak", name="Oak Street", enabled=True, data={"latitude": 33.1, "longitude": -117.1}))
        db.add(models.CubbyFacility(facility_id="f-canyon", name="Canyon Road", enabled=True, data={"latitude": 33.5, "longitude": -117.5}))
        db.add(models.CubbyFacility(facility_id="f-unplaced", name="No Coordinates", enabled=True, data={}))
        db.add(models.CubbyFacility(facility_id="f-gone", name="Gone", enabled=False, data={"latitude": 33.1, "longitude": -117.1}))
        db.add(models.HrWorkSite(id="s-oak", name="Oak", latitude="33.1005", longitude="-117.1005", radius_m=150))
        db.add(models.HrWorkSite(id="s-oak-east", name="Oak East", latitude="33.1010", longitude="-117.1000", radius_m=250))
        db.add(models.HrWorkSite(id="s-canyon", name="Canyon", latitude="33.5", longitude="-117.5", radius_m=200))
        db.add(models.HrWorkSite(id="s-office", name="Office", latitude="40.0", longitude="-100.0", radius_m=200))
        # Ana: 8:00 - 12:00 and 13:00 - 17:00 at Oak on 11/16 (8 h), the clock-outs carry no site.
        db.add_all([_punch("a1", "ana@x.test", "in", "2026-11-16", "08:00", "s-oak"), _punch("a2", "ana@x.test", "out", "2026-11-16", "12:00"),
                    _punch("a3", "ana@x.test", "in", "2026-11-16", "13:00", "s-oak"), _punch("a4", "ana@x.test", "out", "2026-11-16", "17:00")])
        # Bo: 4 h at Oak East on 11/17, and 6 h at Canyon on 11/18.
        db.add_all([_punch("b1", "bo@x.test", "in", "2026-11-17", "09:00", "s-oak-east"), _punch("b2", "bo@x.test", "out", "2026-11-17", "13:00", "s-oak-east"),
                    _punch("b3", "bo@x.test", "in", "2026-11-18", "09:00", "s-canyon"), _punch("b4", "bo@x.test", "out", "2026-11-18", "15:00", "s-canyon")])
        # Not work at a store: a sick day, a voided pair, the office, today, the week before, a shift never closed.
        db.add_all([_punch("c1", "cy@x.test", "in", "2026-11-16", "08:00", "s-oak", category="Sick Day"), _punch("c2", "cy@x.test", "out", "2026-11-16", "16:00", "s-oak", category="Sick Day"),
                    _punch("d1", "di@x.test", "in", "2026-11-16", "08:00", "s-oak", voided=1), _punch("d2", "di@x.test", "out", "2026-11-16", "16:00", "s-oak", voided=1),
                    _punch("e1", "ed@x.test", "in", "2026-11-16", "08:00", "s-office"), _punch("e2", "ed@x.test", "out", "2026-11-16", "16:00", "s-office"),
                    _punch("f1", "ana@x.test", "in", "2026-11-21", "08:00", "s-oak"), _punch("f2", "ana@x.test", "out", "2026-11-21", "10:00", "s-oak"),
                    _punch("g1", "ana@x.test", "in", "2026-11-10", "08:00", "s-oak"), _punch("g2", "ana@x.test", "out", "2026-11-10", "16:00", "s-oak"),
                    _punch("h1", "hal@x.test", "in", "2026-11-19", "08:00", "s-canyon")])
        db.commit()

    def tearDown(self):
        self.db.close()

    def test_hours_and_head_count_per_store_and_nothing_else(self):
        got = osh.hours(self.db, None, TODAY)
        self.assertEqual((got["from"], got["to"], got["days"]), ("2026-11-14", "2026-11-20", 7))
        self.assertEqual(got["stores"], {
            "f-oak": {"minutes": 720, "people": 2, "sites": ["Oak", "Oak East"]},        # Ana 8 h + Bo 4 h
            "f-canyon": {"minutes": 360, "people": 1, "sites": ["Canyon"]},               # Bo 6 h; Hal never clocked out
        })
        flat = repr(got)
        for word in ("ana@", "bo@", "rate", "pay", "$"):
            self.assertNotIn(word, flat)

    def test_only_the_stores_asked_for(self):
        self.assertEqual(list(osh.hours(self.db, ["f-canyon"], TODAY)["stores"]), ["f-canyon"])
        self.assertEqual(osh.hours(self.db, [], TODAY)["stores"], {})

    def test_a_tied_store_with_nobody_clocked_in_reads_zero(self):
        self.db.query(models.TimePunch).delete()
        self.db.commit()
        self.assertEqual(osh.hours(self.db, None, TODAY)["stores"]["f-oak"], {"minutes": 0, "people": 0, "sites": ["Oak", "Oak East"]})


if __name__ == "__main__":
    unittest.main()
