"""Punch locations, judged punch by punch by WHERE the punch was (Sep 30).

Every punch is judged on its own coordinates against every mapped site on the
person's company list (plus any site HR picked for them):
  - inside a site's fence -> that site (in_fence), even one not picked for
    them (Jeremy at PBK Residence read "Out of Location - nearest RJK DRK
    73 km" because PBK was not on his list); overlaps prefer their own site
  - inside none -> out_of_fence ("Out of Location"), never billed to the
    nearest site
  - a rough fix whose whole error circle misses every fence -> out_of_fence
  - coordinates but no mapped site -> no_site, not "Location off"
Another company's site never counts. The timecard re-judges from the
coordinates, so a week punched before a site was mapped stops reading the
wrong site. A site a manager set by hand is kept.

    python -m unittest test_geofence_assigned_site
"""
import json
import os
import tempfile
import unittest
import uuid

# Its own throwaway database (CLAUDE.md): the new columns exist from the start.
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database                                                                  # noqa: E402
import models                                                                    # noqa: E402
from models import HrCompanyWorkSite, HrWorkSite, NexusEmployee, TimePunch       # noqa: E402
from routers.timeclock import _compute_timecard, _geofence                       # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

DAY = "2026-09-21"
# Far from anything else a shared test DB might hold; ~5.5 km apart.
A = ("-41.0000", "-150.0000")   # "Menifee"
B = ("-41.0500", "-150.0000")   # "Temecula"
C = ("-41.1000", "-150.0000")   # a company site this person is NOT allowed at
E = ("-41.2000", "-150.0000")   # another company's site
FAR = ("-41.5000", "-150.0000")


def near(pt):
    return f"{float(pt[0]) - 0.0001:.4f}", f"{float(pt[1]) + 0.0001:.4f}"


class PunchLocationTest(unittest.TestCase):
    def setUp(self):
        tag = uuid.uuid4().hex[:8]
        self.email = f"geo.sites.{tag}@greensglobal.com"
        self.company = f"co-{tag}"
        self.a, self.b, self.c, self.d, self.e = (f"site-{k}-{tag}" for k in "abcde")
        self.emp_id = str(uuid.uuid4())
        self.punch_ids = []
        db = database.SessionLocal()
        try:
            for sid, name, pt in ((self.a, "Menifee", A), (self.b, "Temecula", B), (self.c, "Other", C)):
                db.add(HrWorkSite(id=sid, name=name, latitude=pt[0], longitude=pt[1], radius_m=150))
                db.add(HrCompanyWorkSite(id=f"{self.company}:{sid}", company_id=self.company, site_id=sid))
            db.add(HrWorkSite(id=self.d, name="Unmapped", latitude="", longitude=""))
            db.add(HrWorkSite(id=self.e, name="Elsewhere Co", latitude=E[0], longitude=E[1], radius_m=150))
            db.add(HrCompanyWorkSite(id=f"other-{tag}:{self.e}", company_id=f"other-{tag}", site_id=self.e))
            db.add(NexusEmployee(id=self.emp_id, work_email=self.email, first_name="Geo", last_name="Test",
                                 company=self.company, work_site_ids=json.dumps([self.a, self.b])))
            db.commit()
        finally:
            db.close()

    def tearDown(self):
        db = database.SessionLocal()
        try:
            db.query(TimePunch).filter(TimePunch.id.in_(self.punch_ids)).delete(synchronize_session=False)
            db.query(NexusEmployee).filter(NexusEmployee.id == self.emp_id).delete()
            db.query(HrCompanyWorkSite).filter(HrCompanyWorkSite.site_id.in_([self.a, self.b, self.c, self.e])).delete(synchronize_session=False)
            db.query(HrWorkSite).filter(HrWorkSite.id.in_([self.a, self.b, self.c, self.d, self.e])).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def judge(self, pt, acc=10, exact=False, **emp):
        db = database.SessionLocal()
        try:
            if emp:
                row = db.query(NexusEmployee).filter(NexusEmployee.id == self.emp_id).first()
                for k, v in emp.items():
                    setattr(row, k, v)
                db.commit()
            lat, lng = (pt if exact else near(pt)) if pt else ("", "")
            return _geofence(db, lat, lng, acc, email=self.email)
        finally:
            db.close()

    def test_each_allowed_site_shows_where_the_punch_was(self):
        self.assertEqual((self.judge(A)["geo_status"], self.judge(A)["work_site_id"]), ("in_fence", self.a))
        self.assertEqual((self.judge(B)["geo_status"], self.judge(B)["work_site_id"]), ("in_fence", self.b))

    def test_any_company_site_is_where_the_punch_was(self):
        # Charmi, Sep 30: PBK Residence was on the company list but not on
        # Jeremy's - his punches there must read PBK, not Out of Location.
        g = self.judge(C)
        self.assertEqual((g["geo_status"], g["work_site_id"]), ("in_fence", self.c))

    def test_another_companys_site_never_counts(self):
        g = self.judge(E)
        self.assertEqual(g["geo_status"], "out_of_fence")
        self.assertNotEqual(g["work_site_id"], self.e)

    def test_out_of_location_names_the_truly_nearest_site(self):
        # ~1.1 km past C: the hint is C (1.1 km), not an allowed site 6+ km away.
        g = self.judge(("-41.1100", "-150.0000"), exact=True)
        self.assertEqual((g["geo_status"], g["work_site_id"]), ("out_of_fence", self.c))
        self.assertTrue(1000 < g["distance_m"] < 1200, g)

    def test_overlapping_fences_prefer_their_own_site(self):
        db = database.SessionLocal()
        try:
            db.query(HrWorkSite).filter(HrWorkSite.id == self.c).first().latitude = "-41.0003"
            db.commit()
        finally:
            db.close()
        # ~11 m from A, ~22 m from C: A anyway; and C when C is theirs and A is not.
        self.assertEqual(self.judge(A)["work_site_id"], self.a)
        self.assertEqual(self.judge(A, work_site_ids=json.dumps([self.c]))["work_site_id"], self.c)

    def test_rough_fix_far_from_every_fence_is_out_of_location(self):
        self.assertEqual(self.judge(FAR, acc=2000)["geo_status"], "out_of_fence")

    def test_rough_fix_that_could_be_at_a_site_is_approximate(self):
        self.assertEqual(self.judge(A, acc=2000)["geo_status"], "low_accuracy")

    def test_far_away_is_out_of_location(self):
        self.assertEqual(self.judge(FAR)["geo_status"], "out_of_fence")

    def test_no_sites_picked_means_any_company_site(self):
        g = self.judge(C, work_site_ids="", work_site_id="")
        self.assertEqual((g["geo_status"], g["work_site_id"]), ("in_fence", self.c))

    def test_the_old_single_site_still_counts(self):
        g = self.judge(B, work_site_ids="", work_site_id=self.a)
        self.assertEqual((g["geo_status"], g["work_site_id"]), ("in_fence", self.b))
        self.assertEqual(self.judge(A)["work_site_id"], self.a)

    def test_a_picked_site_off_the_company_list_still_counts(self):
        g = self.judge(E, work_site_ids=json.dumps([self.e]))
        self.assertEqual((g["geo_status"], g["work_site_id"]), ("in_fence", self.e))

    def test_gps_with_no_mapped_site_is_not_location_off(self):
        db = database.SessionLocal()
        try:   # the company list holds only the unmapped site
            db.query(HrCompanyWorkSite).filter(HrCompanyWorkSite.company_id == self.company).delete()
            db.add(HrCompanyWorkSite(id=f"{self.company}:{self.d}", company_id=self.company, site_id=self.d))
            db.commit()
        finally:
            db.close()
        try:
            self.assertEqual(self.judge(A, work_site_ids=json.dumps([self.d]))["geo_status"], "no_site")
        finally:
            db = database.SessionLocal()
            try:
                db.query(HrCompanyWorkSite).filter(HrCompanyWorkSite.company_id == self.company).delete()
                db.commit()
            finally:
                db.close()

    def test_no_coordinates_is_still_location_off(self):
        self.assertEqual(self.judge(None)["geo_status"], "no_location")

    def test_remote_is_fine_anywhere_but_still_resolves_to_a_site(self):
        self.assertEqual(self.judge(FAR, work_remote=1)["geo_status"], "remote")
        self.assertEqual(self.judge(B)["work_site_id"], self.b)

    def test_timecard_rejudges_old_stamps_and_keeps_manager_sites(self):
        db = database.SessionLocal()
        try:
            common = dict(employee_email=self.email, local_date=DAY, tz_offset_min=0, source="web",
                          voided=0, created_by=self.email, created_at=f"{DAY}T00:00:00", accuracy_m=10)
            b_lat, b_lng = near(B)
            stale = [str(uuid.uuid4()) for _ in range(2)]   # punched at Temecula, stamped Menifee
            fixed = [str(uuid.uuid4()) for _ in range(2)]   # a manager put these at Menifee
            self.punch_ids += stale + fixed
            for pid, kind, hh in ((stale[0], "in", 15), (stale[1], "out", 16)):
                db.add(TimePunch(id=pid, kind=kind, at=f"{DAY}T{hh}:00:00", lat=b_lat, lng=b_lng,
                                 geo_status="out_of_fence", work_site_id=self.a, work_site_name="Menifee",
                                 distance_m=5500, **common))
            for pid, kind, hh in ((fixed[0], "in", 17), (fixed[1], "out", 18)):
                db.add(TimePunch(id=pid, kind=kind, at=f"{DAY}T{hh}:00:00", lat=b_lat, lng=b_lng,
                                 geo_status="in_fence", work_site_id=self.a, work_site_name="Menifee",
                                 distance_m=0, site_set_by="mgr@greensglobal.com", **common))
            db.commit()
            segs = [s for d in _compute_timecard(db, self.email, DAY, DAY)["days"] for s in d.get("segments", [])]
            self.assertEqual(len(segs), 2)
            self.assertEqual((segs[0]["geo"], segs[0]["workSiteId"]), ("in_fence", self.b))
            self.assertEqual(segs[0]["workSite"], "Temecula")
            self.assertEqual((segs[1]["geo"], segs[1]["workSiteId"]), ("in_fence", self.a))
            db.expire_all()   # read-only: the stored stamp is untouched
            self.assertEqual(db.query(TimePunch).filter(TimePunch.id == stale[0]).first().work_site_name, "Menifee")
        finally:
            db.close()


    def test_out_of_location_time_is_not_billed_to_the_nearest_site(self):
        db = database.SessionLocal()
        try:
            common = dict(employee_email=self.email, local_date=DAY, tz_offset_min=0, source="web",
                          voided=0, created_by=self.email, created_at=f"{DAY}T00:00:00", accuracy_m=10)
            far = ("-41.1100", "-150.0000")   # 1.1 km past C, inside no fence
            ids = [str(uuid.uuid4()) for _ in range(4)]
            self.punch_ids += ids
            for pid, kind, hh, pt in ((ids[0], "in", "09", far), (ids[1], "out", 10, far),
                                      (ids[2], "in", 11, A), (ids[3], "out", 12, A)):
                db.add(TimePunch(id=pid, kind=kind, at=f"{DAY}T{hh}:00:00", lat=pt[0], lng=pt[1], **common))
            db.commit()
            card = _compute_timecard(db, self.email, DAY, DAY)
            by_loc = {x["workSite"]: (x["workSiteId"], x["workedMin"]) for x in card["byLocation"]}
            self.assertEqual(by_loc.get("Out of Location"), ("", 60), by_loc)
            self.assertEqual(by_loc.get("Menifee"), (self.a, 60), by_loc)
            self.assertNotIn("Other", by_loc)
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
