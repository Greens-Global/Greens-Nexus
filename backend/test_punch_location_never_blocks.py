"""A punch is never refused for want of a location (Visesh, Oct 20 2026 -
replaces the one-day "Require Location to Punch" switch).

Every live punch (clock in, break start / end, clock out) records with or
without coordinates. Without them it is marked "location_off" ("Location
Off" on the Time Sheet) when the browser had location blocked (the client
sends location_off), else "no_location" ("No Location"). A company whose
stored settings still carry the old requireLocationToPunch key is not gated.

Run with: python -m pytest test_punch_location_never_blocks.py
"""
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import shift_requests, timeclock  # noqa: E402

EMP = "emp.loc@greensglobal.com"
OTHER = "other.loc@greensglobal.com"
ADMIN = "admin.loc@greensglobal.com"
CO_ON, CO_OFF = "ent-loc-on", "ent-loc-off"
HERE = {"lat": "33.4936", "lng": "-117.1484", "accuracy_m": 20}


class PunchLocationNeverBlocks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        actual = database.engine.url.database or ""
        assert os.path.abspath(actual) == os.path.abspath(_tmp_db.name), actual
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")
        auth.invalidate_role_cache()
        self.db = database.SessionLocal()
        for m in (models.TimePunch, models.TimeBod, models.NexusEmployee, models.HrEntity,
                  models.NexusRole, models.NexusSetting):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO_ON, name="Location Co"))
        self.db.add(models.HrEntity(id=CO_OFF, name="Free Co"))
        for i, (email, co) in enumerate(((EMP, CO_ON), (OTHER, CO_OFF), (ADMIN, CO_ON))):
            self.db.add(models.NexusEmployee(id=f"id-loc-{i}", work_email=email, first_name="T",
                                             last_name=str(i), company=co, status="active"))
        self.db.add(models.NexusRole(email=ADMIN, role="administrator", assigned_by="test"))
        # Day messages on record so the BOD / EOD gates never stand in the way.
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        for em in (EMP, OTHER):
            for kind in ("bod", "eod"):
                self.db.add(models.TimeBod(id=f"{em}-{kind}", employee_email=em, kind=kind,
                                           local_date=today, message="ok"))
        self.db.commit()
        self._as(EMP)

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        auth.SKIP_AUTH = self._skip
        self.db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _require(self, company_id=CO_ON, on=True):
        self.db.add(models.NexusSetting(key=shift_requests._settings_key(company_id),
                                        value=json.dumps({"requireLocationToPunch": on})))
        self.db.commit()

    def _punch(self, kind, **extra):
        r = self.client.post("/timeclock/punch", json={"kind": kind, "tz_offset_min": 0, **extra})
        if r.status_code == 200:
            # Punches made in the same second would tie on `at`: age what is
            # on record so the next punch is strictly the latest.
            self.db.expire_all()
            for p in self.db.query(models.TimePunch).all():
                t = datetime.strptime(p.at[:19], "%Y-%m-%dT%H:%M:%S") - timedelta(minutes=2)
                p.at = t.strftime("%Y-%m-%dT%H:%M:%S")
            self.db.commit()
        return r

    def _last(self, email=EMP):
        self.db.expire_all()
        return (self.db.query(models.TimePunch).filter(models.TimePunch.employee_email == email)
                .order_by(models.TimePunch.at.desc()).first())

    # ── never refused ──────────────────────────────────────────────────────

    def test_every_punch_lands_without_a_location(self):
        for kind in ("in", "break_start", "break_end", "out"):
            r = self._punch(kind)
            self.assertEqual(r.status_code, 200, (kind, r.text))
            self.assertEqual(self._last().kind, kind)
            self.assertEqual(self._last().geo_status, "no_location")

    def test_old_require_switch_no_longer_gates(self):
        """A company that turned the old switch on during its one day is not gated."""
        self._require()
        for kind in ("in", "break_start", "break_end", "out"):
            self.assertEqual(self._punch(kind).status_code, 200, kind)
        self.assertNotIn("locationRequired", self.client.get("/timeclock/status").json())

    def test_location_off_is_recorded_as_location_off(self):
        for kind in ("in", "break_start", "break_end", "out"):
            r = self._punch(kind, location_off=True)
            self.assertEqual(r.status_code, 200, (kind, r.text))
            self.assertEqual(self._last().geo_status, "location_off", kind)
            self.assertEqual(r.json()["punch"]["geoStatus"], "location_off")

    def test_garbage_coordinates_read_as_no_location(self):
        r = self._punch("in", lat="abc", lng="")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._last().geo_status, "no_location")

    def test_coordinates_win_over_the_location_off_flag(self):
        r = self._punch("in", location_off=True, **HERE)
        self.assertEqual(r.status_code, 200, r.text)
        last = self._last()
        self.assertEqual(last.lat, HERE["lat"])
        self.assertNotIn(last.geo_status, ("no_location", "location_off"))

    def test_state_machine_refusal_still_wins(self):
        r = self._punch("out")
        self.assertEqual(r.status_code, 409, r.text)

    def test_offline_queue_replay_still_lands(self):
        at = datetime.now(timezone.utc).replace(microsecond=0)
        at = (at - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")
        r = self.client.post("/timeclock/punch/manual",
                             json={"kind": "in", "at": at, "tz_offset_min": 0, "note": "offline",
                                   "offline_queue": True, "queued_at": at})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["geoStatus"], "no_location")

    def test_location_off_label_on_the_card(self):
        self.assertEqual(timeclock._OFF_SITE_LABEL["location_off"], "Location Off")
        self.assertEqual(timeclock._OFF_SITE_LABEL["no_location"], "No Location")


class HasCoords(unittest.TestCase):
    def test_has_coords(self):
        self.assertTrue(timeclock._has_coords("33.5", "-117.1"))
        self.assertTrue(timeclock._has_coords("0", "0"))
        for lat, lng in (("", ""), (None, None), ("33.5", ""), ("x", "1"), ("inf", "1"), ("nan", "nan")):
            self.assertFalse(timeclock._has_coords(lat, lng), (lat, lng))


if __name__ == "__main__":
    unittest.main()
