"""Live clock status on the Group Shifts table (Miranda, Oct 21 2026: see at a
glance who on the team is on a break).

GET /timeclock/my-schedule/live lists the same people /my-schedule shows,
with Working / On Break / Clocked Out from their latest punch on their
current workday. No punch, a stale clock-in (over 16 hours), or yesterday's
clock-out = absent; time-tracking-exempt people are never listed.

Run with: python -m pytest test_team_live_status.py
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
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

ME = "live.me@greensglobal.com"          # staff, member of the Store group
WORK = "live.work@greensglobal.com"      # clocked in
BRK = "live.brk@greensglobal.com"        # on a break
BACK = "live.back@greensglobal.com"      # back from a break
OUT = "live.out@greensglobal.com"        # clocked out today
NONE = "live.none@greensglobal.com"      # never punched
STALE = "live.stale@greensglobal.com"    # clock-in 17 hours ago
YOUT = "live.yout@greensglobal.com"      # clocked out yesterday
EXEMPT = "live.exempt@greensglobal.com"  # exempt from time tracking
OTHER = "live.other@greensglobal.com"    # only in the Office group
MGR = "live.mgr@greensglobal.com"        # manager of OTHER, in no group
STORE, OFFICE = "grp-live-store", "grp-live-office"
NOW = datetime.now(timezone.utc).replace(microsecond=0)


def _at(**ago):
    return (NOW - timedelta(**ago)).strftime("%Y-%m-%dT%H:%M:%S")


class TeamLiveStatus(unittest.TestCase):
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
        self.db = database.SessionLocal()
        for m in (models.TimePunch, models.NexusEmployee, models.NexusRole, models.NexusSetting,
                  models.ShiftGroup, models.ShiftGroupMember, models.NexusGroup, models.NexusGroupMember):
            self.db.query(m).delete()
        everyone = (ME, WORK, BRK, BACK, OUT, NONE, STALE, YOUT, EXEMPT, OTHER, MGR)
        for i, em in enumerate(everyone):
            self.db.add(models.NexusEmployee(id=f"emp-live-{i}", work_email=em, first_name=em.split(".")[1].title(),
                                             last_name="X", status="active", deleted_at="",
                                             manager_email=MGR if em == OTHER else ""))
        self.db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
        self.db.add(models.ShiftGroup(id=STORE, name="Store"))
        self.db.add(models.ShiftGroup(id=OFFICE, name="Office"))
        for i, em in enumerate((ME, WORK, BRK, BACK, OUT, NONE, STALE, YOUT, EXEMPT)):
            self.db.add(models.ShiftGroupMember(id=f"sgm-live-{i}", group_id=STORE, employee_email=em))
        self.db.add(models.ShiftGroupMember(id="sgm-live-o", group_id=OFFICE, employee_email=OTHER))
        self.db.add(models.NexusGroup(id="grp-live-exempt", name="Exempt", time_tracking_exempt=1))
        self.db.add(models.NexusGroupMember(group_id="grp-live-exempt", email=EXEMPT))
        for em, punches in {
            ME: [("in", _at(hours=1))],
            WORK: [("in", _at(hours=2))],
            BRK: [("in", _at(hours=2)), ("break_start", _at(minutes=10))],
            BACK: [("in", _at(hours=3)), ("break_start", _at(hours=2)), ("break_end", _at(hours=1))],
            OUT: [("in", _at(hours=1)), ("out", _at())],
            STALE: [("in", _at(hours=17))],
            YOUT: [("in", _at(hours=33)), ("out", _at(hours=25))],
            EXEMPT: [("in", _at(hours=1))],
            OTHER: [("break_start", _at(minutes=5))],
        }.items():
            for k, (kind, at) in enumerate(punches):
                self.db.add(models.TimePunch(id=f"tp-live-{em}-{k}", employee_email=em, kind=kind, at=at,
                                             local_date=at[:10], tz_offset_min=0, note="secret", lat="33.1", lng="-117.1"))
        self.db.commit()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()
        self._as(ME)

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        auth.SKIP_AUTH = self._skip
        self.db.close()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _live(self):
        r = self.client.get("/timeclock/my-schedule/live")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _schedule(self):
        day = NOW.date().isoformat()
        r = self.client.get(f"/timeclock/my-schedule?start={day}&end={day}")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_states_for_my_team(self):
        body = self._live()
        self.assertIn("asOf", body)
        people = body["people"]
        self.assertEqual({em: p["state"] for em, p in people.items()},
                         {ME: "working", WORK: "working", BRK: "break", BACK: "working", OUT: "out"})
        self.assertEqual(people[BRK], {"state": "break", "label": "On Break", "since": _at(minutes=10) + "Z"})
        self.assertEqual(people[WORK]["label"], "Working")
        self.assertEqual(people[BACK]["since"], _at(hours=1) + "Z")
        self.assertEqual(people[OUT]["label"], "Clocked Out")
        # No punch, a stale clock-in, yesterday's clock-out, an exempt member,
        # someone from another group: none of them listed.
        for em in (NONE, STALE, YOUT, EXEMPT, OTHER):
            self.assertNotIn(em, people)
        # Status words and time only.
        self.assertNotIn("secret", json.dumps(body))
        self.assertNotIn("33.1", json.dumps(body))

    def test_voided_punch_is_ignored(self):
        p = self.db.query(models.TimePunch).filter(models.TimePunch.id == f"tp-live-{BRK}-1").first()
        p.voided = 1
        self.db.commit()
        self.assertEqual(self._live()["people"][BRK]["state"], "working")

    def test_team_schedules_off_hides_teammates_from_staff(self):
        self.db.add(models.NexusSetting(key="shift_requests_config", value=json.dumps({"teamSchedules": False})))
        self.db.commit()
        self.assertEqual(self._live()["people"], {})
        self.assertEqual(self._schedule()["teams"], [])

    def test_manager_sees_the_group_they_run(self):
        self._as(MGR)
        self.assertEqual(self._live()["people"], {OTHER: {"state": "break", "label": "On Break",
                                                          "since": _at(minutes=5) + "Z"}})
        self.assertEqual([(t["id"], t["isMember"]) for t in self._schedule()["teams"]], [(OFFICE, False)])

    def test_my_schedule_lists_the_same_people_as_before(self):
        teams = self._schedule()["teams"]
        self.assertEqual([(t["id"], t["isMember"]) for t in teams], [(STORE, True)])
        members = [m["email"] for m in teams[0]["members"]]
        self.assertEqual(members[0], ME)          # themself first
        self.assertEqual(set(members), {ME, WORK, BRK, BACK, OUT, NONE, STALE, YOUT, EXEMPT})
        self.assertTrue(set(self._live()["people"]) <= set(members))


if __name__ == "__main__":
    unittest.main()
