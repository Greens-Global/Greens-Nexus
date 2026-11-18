"""A person's own time zone and working hours (person_zone.py, 11/13/2026).

Kept on the person (nexus_employees.time_zone / work_start / work_end) and
set only by the person, through the My HR self-service save. A zone that is
set wins over every guess; one that is not leaves each reader inferring
exactly as before. The Contact Directory and the people pickers carry the
three fields.

    python -m pytest test_person_zone.py
"""
import json
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_RATE_LIMIT", "off")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import person_zone  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
PRIYA = "priya.patel" + D
SAM = "sam.staff" + D
NOWHERE = "nia.nowhere" + D


class PersonZoneTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        db = database.SessionLocal()
        for m in (models.NexusEmployee, models.AuditLog, models.TimePunch, models.NexusRole,
                  models.ShiftAssignment, models.TaskNotifyPref):
            db.query(m).execution_options(include_deleted=True).delete()
        db.add(models.NexusEmployee(id="e-priya", first_name="Priya", last_name="Patel", work_email=PRIYA,
                                    country="IN", status="active", identity_type="internal", deleted_at=""))
        db.add(models.NexusEmployee(id="e-sam", first_name="Sam", last_name="Staff", work_email=SAM,
                                    country="US", state="CA", status="active", identity_type="internal",
                                    deleted_at=""))
        db.add(models.NexusEmployee(id="e-nia", first_name="Nia", last_name="Nowhere", work_email=NOWHERE,
                                    status="active", identity_type="internal", deleted_at=""))
        db.commit()
        db.close()
        cache.contact_directory.invalidate()
        cache.people_directory.invalidate()
        auth._role_cache.clear()

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    def _as(self, who):
        os.environ["NEXUS_DEV_EMAIL"] = who

    def _row(self, email):
        db = database.SessionLocal()
        try:
            e = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == email).first()
            return e.time_zone or "", e.work_start or "", e.work_end or ""
        finally:
            db.close()

    # ── the save ────────────────────────────────────────────────────────────
    def test_a_person_saves_their_own_zone_and_hours(self):
        self._as(SAM)
        r = self.client.put("/myhr/profile", json={"time_zone": "America/New_York"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["timeZone"], "America/New_York")
        r = self.client.put("/myhr/profile", json={"work_start": "9:00", "work_end": "17:30"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["workStart"], r.json()["workEnd"]), ("09:00", "17:30"))   # zero padded
        self.assertEqual(self._row(SAM), ("America/New_York", "09:00", "17:30"))
        # ...and the profile reads them back, with what the directory would guess beside them.
        got = self.client.get("/myhr/profile").json()
        self.assertEqual((got["timeZone"], got["workStart"], got["workEnd"]), ("America/New_York", "09:00", "17:30"))
        self.assertEqual(got["detectedTimeZone"], "America/Los_Angeles")

    def test_a_bad_zone_or_bad_hours_are_refused_and_nothing_is_kept(self):
        self._as(SAM)
        for body in ({"time_zone": "Mars/Olympus_Mons"}, {"time_zone": "../etc/passwd"},
                     {"work_start": "25:00", "work_end": "17:00"}, {"work_start": "9am", "work_end": "17:00"},
                     {"work_start": "09:00"},                                   # half a pair
                     {"work_start": "09:00", "work_end": "09:00"},              # no working day at all
                     {"time_zone": "Asia/Kolkata", "work_start": "nope", "work_end": "17:00"}):
            r = self.client.put("/myhr/profile", json=body)
            self.assertEqual(r.status_code, 400, body)
        self.assertEqual(self._row(SAM), ("", "", ""))

    def test_a_night_shift_and_a_cleared_value_are_kept(self):
        self._as(SAM)
        r = self.client.put("/myhr/profile", json={"time_zone": "Asia/Kolkata", "work_start": "22:00", "work_end": "06:00"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._row(SAM), ("Asia/Kolkata", "22:00", "06:00"))
        r = self.client.put("/myhr/profile", json={"time_zone": "", "work_start": "", "work_end": ""})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._row(SAM), ("", "", ""))
        # A save of something else leaves them alone.
        self.client.put("/myhr/profile", json={"work_start": "08:00", "work_end": "16:00"})
        self.client.put("/myhr/profile", json={"phone": "555-0100"})
        self.assertEqual(self._row(SAM), ("", "08:00", "16:00"))

    def test_a_person_cannot_set_someone_elses(self):
        # The save has no target: it is always the caller's own row, whatever
        # else the body names.
        self._as(SAM)
        r = self.client.put("/myhr/profile", json={"time_zone": "Asia/Tokyo", "email": PRIYA, "work_email": PRIYA,
                                                   "employee_id": "e-priya"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._row(SAM)[0], "Asia/Tokyo")
        self.assertEqual(self._row(PRIYA), ("", "", ""))
        # Someone with no People record has nothing to save to.
        self._as("stranger" + D)
        self.assertEqual(self.client.put("/myhr/profile", json={"time_zone": "Asia/Tokyo"}).status_code, 404)

    def test_the_change_is_audited_once(self):
        self._as(SAM)
        self.client.put("/myhr/profile", json={"time_zone": "America/Chicago"})
        self.client.put("/myhr/profile", json={"time_zone": "America/Chicago"})   # no change, no row
        db = database.SessionLocal()
        rows = db.query(models.AuditLog).filter(models.AuditLog.action == "Changed employee fields").all()
        db.close()
        self.assertEqual(len(rows), 1)
        self.assertEqual(json.loads(rows[0].details)["changes"], {"time_zone": ["", "America/Chicago"]})

    # ── the readers ─────────────────────────────────────────────────────────
    def test_tz_name_prefers_the_stored_zone_and_infers_as_before_without_one(self):
        from routers.directory import _tz_name

        class _E:
            state, country, time_zone = "CA", "US", ""
        self.assertEqual(_tz_name(_E(), None), "America/Los_Angeles")
        self.assertEqual(_tz_name(_E(), -330, "2026-11-10T06:00:00+00:00"), "Asia/Kolkata")   # the punch offset
        _E.time_zone = "America/New_York"
        self.assertEqual(_tz_name(_E(), None), "America/New_York")
        self.assertEqual(_tz_name(_E(), -330, "2026-11-10T06:00:00+00:00"), "America/New_York")   # beats the punch
        _E.time_zone = "Not/AZone"                                                # unreadable = not set
        self.assertEqual(_tz_name(_E(), None), "America/Los_Angeles")

        class _Old:                                                               # a row shape with no column at all
            state, country = "", "IN"
        self.assertEqual(_tz_name(_Old(), None), "Asia/Kolkata")

    def test_the_contact_directory_carries_the_zone_and_hours(self):
        self._as(PRIYA)
        self.client.put("/myhr/profile", json={"time_zone": "Europe/London", "work_start": "10:00", "work_end": "19:00"})
        self._as(SAM)
        r = self.client.get("/directory")
        self.assertEqual(r.status_code, 200, r.text)
        by = {p["email"]: p for p in r.json()["people"]}
        self.assertEqual((by[PRIYA]["timeZone"], by[PRIYA]["workStart"], by[PRIYA]["workEnd"]),
                         ("Europe/London", "10:00", "19:00"))
        self.assertEqual((by[SAM]["timeZone"], by[SAM]["workStart"], by[SAM]["workEnd"]),
                         ("America/Los_Angeles", "", ""))                       # inferred, as before
        self.assertNotIn('"_tz"', r.text)

    def test_the_people_pickers_carry_them_too(self):
        self._as(PRIYA)
        self.client.put("/myhr/profile", json={"work_start": "09:30", "work_end": "18:30"})
        self._as(SAM)
        by = {p["email"]: p for p in self.client.get("/myhr/directory").json()}
        self.assertEqual((by[PRIYA]["timeZone"], by[PRIYA]["workStart"], by[PRIYA]["workEnd"]),
                         ("Asia/Kolkata", "09:30", "18:30"))                    # the country guess
        self.assertEqual(by[SAM]["timeZone"], "America/Los_Angeles")
        self.assertEqual(by[NOWHERE]["timeZone"], "")                           # nothing to guess from: nothing said
        # A save drops the cached list, so the next read has the new zone.
        self._as(NOWHERE)
        self.client.put("/myhr/profile", json={"time_zone": "Asia/Singapore"})
        self._as(SAM)
        by = {p["email"]: p for p in self.client.get("/myhr/directory").json()}
        self.assertEqual(by[NOWHERE]["timeZone"], "Asia/Singapore")

    def test_the_other_zone_readers_prefer_it_and_fall_back_as_before(self):
        import daily_briefing
        import item_due
        import kb_core
        import sign_in_watch
        db = database.SessionLocal()
        try:
            cfg = {"defaultTimeZone": "America/Denver"}
            self.assertEqual(daily_briefing._person_zone(db, SAM, cfg), "America/Denver")
            before_item = item_due.zone_for(db, SAM)
            kb_core._zones.clear()
            before_kb = kb_core.zone_for(db, SAM)
            e = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == SAM).first()
            e.time_zone = "Asia/Kolkata"
            db.commit()
            kb_core._zones.clear()
            self.assertEqual(person_zone.stored(db, SAM.upper()), "Asia/Kolkata")
            self.assertEqual(daily_briefing._person_zone(db, SAM, cfg), "Asia/Kolkata")
            self.assertEqual(item_due.zone_for(db, SAM), "Asia/Kolkata")
            self.assertEqual(kb_core.zone_for(db, SAM), "Asia/Kolkata")
            self.assertEqual(str(sign_in_watch.person_zone(db, SAM)), "Asia/Kolkata")
            self.assertNotEqual(before_item, "Asia/Kolkata")
            self.assertNotEqual(before_kb, "Asia/Kolkata")
            # Task reminder emails keep their own zone (task_notify_prefs).
            import task_notify_prefs
            self.assertEqual(task_notify_prefs.load(db, SAM)["timezone"], task_notify_prefs.DEFAULT_TZ)
        finally:
            kb_core._zones.clear()
            db.close()

    # ── the rules ───────────────────────────────────────────────────────────
    def test_the_validation_rules(self):
        self.assertTrue(person_zone.valid_zone("Asia/Kolkata"))
        for bad in ("", None, 5, "Nope/Nope", "x" * 200):
            self.assertFalse(person_zone.valid_zone(bad), bad)
        self.assertEqual(person_zone.clean_hhmm("7:05"), "07:05")
        self.assertEqual(person_zone.clean_hhmm(""), "")
        for bad in ("24:00", "7", "07:60", "7:5", "0700"):
            with self.assertRaises(ValueError):
                person_zone.clean_hhmm(bad)
        self.assertEqual(person_zone.clean_hours("", ""), ("", ""))
        self.assertEqual(person_zone.stored(None, ""), "")


if __name__ == "__main__":
    unittest.main()
