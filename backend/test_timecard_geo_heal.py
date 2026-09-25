"""Timecard "Location off" self-heal (Charmi, Sep 26).

A punch made before any geofenced work site existed was stamped no_location
even when the browser shared coordinates. The timecard re-checks those rows
against today's sites at read time; a punch with no coordinates stays
"Location off", and the stored row is never rewritten.

    python -m unittest test_timecard_geo_heal
"""
import os
import unittest
import uuid

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database
import models
from models import HrWorkSite, TimePunch
from routers.timeclock import _compute_timecard

models.Base.metadata.create_all(bind=database.engine)

EMAIL = "geo.heal.test@greensglobal.com"
DAY = "2026-09-21"


class TimecardGeoHealTest(unittest.TestCase):
    def setUp(self):
        self.site_id = "site-" + uuid.uuid4().hex[:8]
        self.ids = [str(uuid.uuid4()) for _ in range(4)]
        db = database.SessionLocal()
        try:
            db.add(HrWorkSite(id=self.site_id, name="Geo heal test site", latitude="-33.0000",
                              longitude="170.0000", radius_m=150))
            common = dict(employee_email=EMAIL, local_date=DAY, tz_offset_min=0,
                          geo_status="no_location", source="web", voided=0,
                          created_by=EMAIL, created_at="2026-09-21T00:00:00")
            # segment 1: coordinates at the site, stamped no_location (no site existed yet)
            db.add(TimePunch(id=self.ids[0], kind="in", at=f"{DAY}T15:00:00",
                             lat="-33.0001", lng="170.0001", accuracy_m=10, **common))
            db.add(TimePunch(id=self.ids[1], kind="out", at=f"{DAY}T17:00:00",
                             lat="-33.0001", lng="170.0001", accuracy_m=10, **common))
            # segment 2: location genuinely off - nothing to re-check
            db.add(TimePunch(id=self.ids[2], kind="in", at=f"{DAY}T18:00:00", lat="", lng="", **common))
            db.add(TimePunch(id=self.ids[3], kind="out", at=f"{DAY}T19:00:00", lat="", lng="", **common))
            db.commit()
        finally:
            db.close()

    def tearDown(self):
        db = database.SessionLocal()
        try:
            db.query(TimePunch).filter(TimePunch.id.in_(self.ids)).delete(synchronize_session=False)
            db.query(HrWorkSite).filter(HrWorkSite.id == self.site_id).delete()
            db.commit()
        finally:
            db.close()

    def test_heals_punches_with_coordinates_only(self):
        db = database.SessionLocal()
        try:
            card = _compute_timecard(db, EMAIL, DAY, DAY)
            segs = [s for d in card["days"] for s in d.get("segments", [])]
            self.assertEqual(len(segs), 2)
            healed, off = segs
            self.assertEqual(healed["geo"], "in_fence")
            self.assertEqual(healed["workSiteId"], self.site_id)
            self.assertEqual(healed["geoOut"], "in_fence")
            self.assertEqual(off["geo"], "no_location")
            self.assertEqual(off["geoOut"], "no_location")
            # read-only: the stored rows keep their original stamp
            db.expire_all()
            row = db.query(TimePunch).filter(TimePunch.id == self.ids[0]).first()
            self.assertEqual(row.geo_status, "no_location")
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
