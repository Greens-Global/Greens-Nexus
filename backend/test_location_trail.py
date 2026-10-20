"""Location Trail While Clocked In (Neil's checklist, Oct 20 2026).

routers/location_trail.py: the web app pings /timeclock/location-trail/ping
every ~5 minutes while the person is clocked in, only when their company has
`locationTrailOn` (Shifts settings, OFF by default). Pings are ignored when the
switch is off, on a break, off the clock, after a phone-app consent
revocation, or too soon after the last one. Managers read their team's live
positions and day trails; employees read none, their own included (Neil,
Oct 21 2026: Workforce Analytics only).

Run with: python -m pytest test_location_trail.py -q
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
from routers import location_trail, shift_requests  # noqa: E402

EMP = "emp.trail@greensglobal.com"        # reports to MGR
MGR = "mgr.trail@greensglobal.com"
OTHER = "other.trail@greensglobal.com"    # reports to MGR2 - another team
MGR2 = "mgr2.trail@greensglobal.com"
FREE = "free.trail@greensglobal.com"      # company without the switch
ADMIN = "admin.trail@greensglobal.com"
CO_ON, CO_OFF = "ent-trail-on", "ent-trail-off"
HERE = {"lat": "33.4936", "lng": "-117.1484", "accuracy_m": 20, "tz_offset_min": 0}


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


class LocationTrail(unittest.TestCase):
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
        for m in (models.TimePunch, models.NexusEmployee, models.HrEntity, models.NexusRole,
                  models.NexusSetting, models.TrackPing, models.TrackSession, models.TrackConsent):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO_ON, name="Trail Co"))
        self.db.add(models.HrEntity(id=CO_OFF, name="Free Co"))
        people = ((EMP, CO_ON, MGR), (MGR, CO_ON, ""), (OTHER, CO_ON, MGR2), (MGR2, CO_ON, ""),
                  (FREE, CO_OFF, ""), (ADMIN, CO_ON, ""))
        for i, (email, co, boss) in enumerate(people):
            self.db.add(models.NexusEmployee(id=f"id-trail-{i}", work_email=email, first_name="T",
                                             last_name=str(i), company=co, status="active",
                                             manager_email=boss))
        for email, role in ((MGR, "manager"), (MGR2, "manager"), (ADMIN, "administrator")):
            self.db.add(models.NexusRole(email=email, role=role, assigned_by="test"))
        self.db.commit()
        auth.invalidate_role_cache()
        self._as(EMP)

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        auth.SKIP_AUTH = self._skip
        self.db.close()

    # ── helpers ──────────────────────────────────────────────────────────────

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _switch(self, company_id=CO_ON, on=True):
        self.db.add(models.NexusSetting(key=shift_requests._settings_key(company_id),
                                        value=json.dumps({"locationTrailOn": on})))
        self.db.commit()

    def _punch(self, email, kind, minutes_ago=30):
        at = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
        self.db.add(models.TimePunch(id=f"p-{email}-{kind}-{minutes_ago}", employee_email=email, kind=kind,
                                     at=_iso(at), local_date=at.strftime("%Y-%m-%d"), tz_offset_min=0,
                                     voided=0, source="web", created_by=email, created_at=_iso(at)))
        self.db.commit()

    def _ping(self, **body):
        return self.client.post("/timeclock/location-trail/ping", json={**HERE, **body})

    def _pings(self, email=EMP):
        self.db.expire_all()
        return self.db.query(models.TrackPing).filter(models.TrackPing.employee_email == email).all()

    def _today(self):
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # ── the setting ──────────────────────────────────────────────────────────

    def test_off_by_default_and_on_status(self):
        self.assertFalse(shift_requests.get_settings(self.db)["locationTrailOn"])
        self.assertFalse(self.client.get("/timeclock/status").json()["locationTrail"])
        self._switch()
        self.assertTrue(self.client.get("/timeclock/status").json()["locationTrail"])
        self._as(FREE)
        self.assertFalse(self.client.get("/timeclock/status").json()["locationTrail"])

    def test_company_override_round_trip(self):
        self._as(ADMIN)
        r = self.client.put(f"/timeclock/shift-requests/settings?company={CO_ON}", json={"locationTrailOn": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.db.expire_all()
        self.assertTrue(shift_requests.get_settings(self.db, CO_ON)["locationTrailOn"])
        self.assertFalse(shift_requests.get_settings(self.db, CO_OFF)["locationTrailOn"])

    # ── pings ────────────────────────────────────────────────────────────────

    def test_switch_off_ignores_pings(self):
        self._punch(EMP, "in")
        r = self._ping()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"stored": 0, "skipped": "off"})
        self.assertEqual(self._pings(), [])

    def test_switch_on_other_company_still_ignored(self):
        self._switch(CO_ON)
        self._punch(FREE, "in")
        self._as(FREE)
        self.assertEqual(self._ping().json()["skipped"], "off")
        self.assertEqual(self._pings(FREE), [])

    def test_clocked_in_ping_is_stored_as_web(self):
        self._switch()
        self._punch(EMP, "in")
        r = self._ping()
        self.assertEqual(r.json()["stored"], 1, r.text)
        rows = self._pings()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].source, "web")
        self.assertEqual(rows[0].lat, "33.4936")
        sess = self.db.query(models.TrackSession).filter(models.TrackSession.id == rows[0].session_id).one()
        self.assertEqual(sess.device_id, "web")
        self.assertEqual(sess.ended_at, "")

    def test_not_clocked_in_is_ignored(self):
        self._switch()
        self.assertEqual(self._ping().json()["skipped"], "not_clocked_in")
        self._punch(EMP, "in", 60)
        self._punch(EMP, "out", 10)
        self.assertEqual(self._ping().json()["skipped"], "not_clocked_in")
        self.assertEqual(self._pings(), [])

    def test_on_break_is_paused(self):
        self._switch()
        self._punch(EMP, "in", 60)
        self._punch(EMP, "break_start", 10)
        self.assertEqual(self._ping().json()["skipped"], "on_break")
        self.assertEqual(self._pings(), [])
        self._punch(EMP, "break_end", 1)
        self.assertEqual(self._ping().json()["stored"], 1)

    def test_too_soon_is_ignored(self):
        self._switch()
        self._punch(EMP, "in")
        self.assertEqual(self._ping().json()["stored"], 1)
        self.assertEqual(self._ping().json()["skipped"], "too_soon")
        self.assertEqual(len(self._pings()), 1)

    def test_phone_consent_revocation_is_respected(self):
        self._switch()
        self._punch(EMP, "in")
        self.db.add(models.TrackConsent(id="c1", employee_email=EMP, granted=0, revoked_at=_iso(datetime.now(timezone.utc)),
                                        created_at=_iso(datetime.now(timezone.utc))))
        self.db.commit()
        self.assertEqual(self._ping().json()["skipped"], "consent_revoked")

    def test_bad_coordinates_refused(self):
        self._switch()
        self._punch(EMP, "in")
        for lat, lng in (("", ""), ("abc", "1"), ("91", "0"), ("0", "181"), ("nan", "0")):
            self.assertEqual(self._ping(lat=lat, lng=lng).status_code, 400, (lat, lng))

    def test_clock_out_closes_the_session(self):
        self._switch()
        self._punch(EMP, "in", 60)
        self._ping()
        self._punch(EMP, "out", 0)
        self._ping()
        self.db.expire_all()
        self.assertTrue(all(s.ended_at for s in self.db.query(models.TrackSession).all()))

    # ── reading: scope ───────────────────────────────────────────────────────

    def _seed_trail(self, email):
        self._punch(email, "in")
        now = datetime.now(timezone.utc)
        self.db.add(models.TrackPing(id=f"tp-{email}", session_id="s", employee_email=email, at=_iso(now),
                                     received_at=_iso(now), local_date=now.strftime("%Y-%m-%d"),
                                     lat="33.5", lng="-117.1", source="web"))
        self.db.commit()

    def test_employee_reads_no_trail_not_even_their_own(self):
        self._seed_trail(EMP)
        self._seed_trail(OTHER)
        for url in (f"/timeclock/location-trail/day?date={self._today()}",
                    f"/timeclock/location-trail/day?email={EMP}&date={self._today()}",
                    f"/timeclock/location-trail/day?email={OTHER}&date={self._today()}",
                    "/timeclock/location-trail/live"):
            self.assertEqual(self.client.get(url).status_code, 401, url)      # require_tracking_read

    def test_manager_reads_own_team_only(self):
        self._seed_trail(EMP)
        self._seed_trail(OTHER)
        self._as(MGR)
        r = self.client.get(f"/timeclock/location-trail/day?email={EMP}&date={self._today()}")
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual((d["email"], len(d["points"])), (EMP, 1))
        self.assertEqual([p["kind"] for p in d["punches"]], ["in"])
        r = self.client.get(f"/timeclock/location-trail/day?email={OTHER}&date={self._today()}")
        self.assertEqual(r.status_code, 403, r.text)
        live = self.client.get("/timeclock/location-trail/live").json()["crew"]
        self.assertEqual([c["email"] for c in live], [EMP])

    def test_admin_reads_everyone(self):
        self._seed_trail(EMP)
        self._seed_trail(OTHER)
        self._as(ADMIN)
        live = self.client.get("/timeclock/location-trail/live").json()["crew"]
        self.assertEqual(sorted(c["email"] for c in live), sorted([EMP, OTHER]))
        r = self.client.get(f"/timeclock/location-trail/day?email={OTHER}&date={self._today()}")
        self.assertEqual(r.status_code, 200)

    def test_live_drops_clocked_out_and_stale(self):
        self._seed_trail(EMP)
        self._punch(EMP, "out", 0)
        self._seed_trail(OTHER)
        old = datetime.now(timezone.utc) - timedelta(minutes=location_trail.LIVE_WINDOW_MIN + 5)
        row = self.db.query(models.TrackPing).filter(models.TrackPing.employee_email == OTHER).one()
        row.at = row.received_at = _iso(old)
        self.db.commit()
        self._as(ADMIN)
        self.assertEqual(self.client.get("/timeclock/location-trail/live").json()["crew"], [])

    def test_day_needs_a_date(self):
        self._as(MGR)
        self.assertEqual(self.client.get("/timeclock/location-trail/day?date=10/20/2026").status_code, 400)


if __name__ == "__main__":
    unittest.main()
