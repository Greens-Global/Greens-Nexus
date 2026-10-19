"""Require Location to Punch (Neil's checklist, Oct 19 2026).

A per-company switch in the shift settings (requireLocationToPunch, OFF by
default). With it on, a live clock in / out / break punch that carries no
coordinates is refused with code location_required and the next step
("Turn on location for this site in your browser, then try again."). With it
off the punch lands as before and is marked no_location ("No Location" on the
Time Sheet). Backfills (/punch/manual) are corrections, not live punches, and
stay exempt.

Run with: python -m pytest test_punch_location_required.py
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


class PunchLocationRequired(unittest.TestCase):
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

    # ── the setting ─────────────────────────────────────────────────────────

    def test_off_by_default(self):
        self.assertFalse(shift_requests.get_settings(self.db)["requireLocationToPunch"])
        self.assertFalse(shift_requests.get_settings(self.db, CO_ON)["requireLocationToPunch"])
        self.assertFalse(self.client.get("/timeclock/status").json()["locationRequired"])

    def test_company_override_round_trip(self):
        self._as(ADMIN)
        r = self.client.put(f"/timeclock/shift-requests/settings?company={CO_ON}",
                            json={"requireLocationToPunch": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["requireLocationToPunch"])
        self.db.expire_all()
        self.assertTrue(shift_requests.get_settings(self.db, CO_ON)["requireLocationToPunch"])
        self.assertFalse(shift_requests.get_settings(self.db, CO_OFF)["requireLocationToPunch"])
        self.assertFalse(shift_requests.get_settings(self.db)["requireLocationToPunch"])
        self._as(EMP)
        self.assertTrue(self.client.get("/timeclock/status").json()["locationRequired"])

    # ── off: punches land, marked no_location ───────────────────────────────

    def test_off_punch_without_location_lands_as_no_location(self):
        r = self._punch("in")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["punch"]["geoStatus"], "no_location")
        self.assertEqual(self._last().geo_status, "no_location")

    # ── on: refused without coordinates, every live kind ───────────────────

    def test_on_refuses_clock_in_without_location(self):
        self._require()
        r = self._punch("in")
        self.assertEqual(r.status_code, 400, r.text)
        d = r.json()["detail"]
        self.assertEqual(d["code"], "location_required")
        self.assertIn("Turn on location for this site in your browser, then try again.", d["message"])
        self.assertIsNone(self._last())

    def test_on_refuses_blank_or_garbage_coordinates(self):
        self._require()
        for lat, lng in (("", ""), ("33.1", ""), ("", "-117.1"), ("abc", "def"), ("nan", "1")):
            r = self._punch("in", lat=lat, lng=lng)
            self.assertEqual(r.status_code, 400, (lat, lng, r.text))
        self.assertIsNone(self._last())

    def test_on_accepts_a_punch_with_coordinates(self):
        self._require()
        r = self._punch("in", **HERE)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._last().lat, HERE["lat"])

    def test_on_refuses_break_and_clock_out_without_location(self):
        self._require()
        self.assertEqual(self._punch("in", **HERE).status_code, 200)
        r = self._punch("break_start")
        self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(r.json()["detail"]["code"], "location_required")
        self.assertEqual(self._punch("break_start", **HERE).status_code, 200)
        r = self._punch("break_end")
        self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(self._punch("break_end", **HERE).status_code, 200)
        r = self._punch("out")
        self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(self._last().kind, "break_end")
        self.assertEqual(self._punch("out", **HERE).status_code, 200)
        self.assertEqual(self._last().kind, "out")

    def test_state_machine_refusal_still_wins(self):
        """A punch the state machine refuses keeps its 409 - location is not
        the problem then and the offline queue keys off that 409."""
        self._require()
        r = self._punch("out")
        self.assertEqual(r.status_code, 409, r.text)

    def test_only_the_company_with_the_switch_is_gated(self):
        self._require(CO_ON)
        self._as(OTHER)
        r = self._punch("in")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._last(OTHER).geo_status, "no_location")

    def test_tenant_switch_reaches_every_company(self):
        self._require("")
        self._as(OTHER)
        self.assertEqual(self._punch("in").status_code, 400)
        self.assertTrue(self.client.get("/timeclock/status").json()["locationRequired"])

    # ── exempt ─────────────────────────────────────────────────────────────

    def test_missed_punch_backfill_is_exempt(self):
        """/punch/manual is a correction flagged for review, not a live punch:
        there is no 'now' location to give for a time that already passed."""
        self._require()
        at = datetime.now(timezone.utc).replace(microsecond=0)
        at = (at - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")
        r = self.client.post("/timeclock/punch/manual",
                             json={"kind": "in", "at": at, "tz_offset_min": 0, "note": "forgot"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["geoStatus"], "no_location")


class HasCoords(unittest.TestCase):
    def test_has_coords(self):
        self.assertTrue(timeclock._has_coords("33.5", "-117.1"))
        self.assertTrue(timeclock._has_coords("0", "0"))
        for lat, lng in (("", ""), (None, None), ("33.5", ""), ("x", "1"), ("inf", "1"), ("nan", "nan")):
            self.assertFalse(timeclock._has_coords(lat, lng), (lat, lng))


if __name__ == "__main__":
    unittest.main()
