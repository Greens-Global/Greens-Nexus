"""Live team strip (Homebase lifts, Neil 11/02/2026): GET /timeclock/my-schedule/live
also says who is LATE - expected to have started (shift_expect.expected_starts
+ late_now, the ONE expected-start rule) and not clocked in yet - and counts
In / On Break / Late / Off over the people the caller sees. A Sick / PTO
leave punch is not a clock-in (the person is on leave, never In or Late),
a weather-cancelled day is never late, and the `people` map keeps its shape.

    python -m pytest test_schedule_live.py
"""
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

# A throwaway sqlite of its own, so `python -m unittest test_schedule_live`
# never ALTERs or clears a local greens_nexus.db (CLAUDE.md: one file per process).
_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
from fastapi.testclient import TestClient  # noqa: E402
import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
models.Base.metadata.create_all(bind=database.engine)

ME = "slive.me@greensglobal.com"            # staff, clocked in
BRK = "slive.brk@greensglobal.com"          # on a break
LATE = "slive.late@greensglobal.com"        # shift started 90 min ago, no punch
PRESET_LATE = "slive.plate@greensglobal.com"  # no placement; usual-hours preset started 90 min ago
ONTIME = "slive.ontime@greensglobal.com"    # shift starts in 90 min, no punch
NOSHIFT = "slive.noshift@greensglobal.com"  # nothing expected
SICK = "slive.sick@greensglobal.com"        # shift started 90 min ago, a Sick Day punch
OUTDONE = "slive.out@greensglobal.com"      # shift started 90 min ago, in and out today
WEATHER = "slive.wx@greensglobal.com"       # shift started 90 min ago, day called off
EXEMPT = "slive.exempt@greensglobal.com"    # exempt from time tracking, would be late
GROUP = "grp-slive"
NOW = datetime.now(timezone.utc).replace(microsecond=0)


def _pick_tz() -> str:
    """A fixed-offset zone where it is mid-day right now, so a shift 90 minutes
    either side of now stays on today's date (deterministic at any hour)."""
    for off in range(-12, 13):
        name = f"Etc/GMT{'+' if off < 0 else '-'}{abs(off)}" if off else "Etc/GMT"
        if 5 <= NOW.astimezone(ZoneInfo(name)).hour <= 18:
            return name
    return "UTC"


TZ = _pick_tz()
LOCAL_NOW = NOW.astimezone(ZoneInfo(TZ))
TODAY = LOCAL_NOW.strftime("%Y-%m-%d")
STARTED = (LOCAL_NOW - timedelta(minutes=90)).strftime("%H:%M")
LATER = (LOCAL_NOW + timedelta(minutes=90)).strftime("%H:%M")


def _at(**ago):
    return (NOW - timedelta(**ago)).strftime("%Y-%m-%dT%H:%M:%S")


class ScheduleLiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")
        self.db = database.SessionLocal()
        for m in (models.TimePunch, models.NexusEmployee, models.NexusRole, models.NexusSetting, models.ShiftGroup,
                  models.ShiftGroupMember, models.NexusGroup, models.NexusGroupMember, models.Shift,
                  models.ShiftAssignment, models.ScheduledShift):
            self.db.query(m).delete()
        everyone = (ME, BRK, LATE, PRESET_LATE, ONTIME, NOSHIFT, SICK, OUTDONE, WEATHER, EXEMPT)
        for i, em in enumerate(everyone):
            self.db.add(models.NexusEmployee(id=f"emp-slive-{i}", work_email=em, first_name=em.split(".")[1].title(),
                                             last_name="X", status="active", deleted_at=""))
            self.db.add(models.ShiftGroupMember(id=f"sgm-slive-{i}", group_id=GROUP, employee_email=em))
        self.db.add(models.ShiftGroup(id=GROUP, name="Crew"))
        self.db.add(models.NexusSetting(key="shift_requests_config",
                                        value=json.dumps({"timeZone": TZ, "defaultGraceMin": 10})))
        self.db.add(models.NexusGroup(id="grp-slive-exempt", name="Exempt", time_tracking_exempt=1))
        self.db.add(models.NexusGroupMember(group_id="grp-slive-exempt", email=EXEMPT))
        self.db.add(models.Shift(id="preset-slive", name="Usual", code="U", start_hhmm=STARTED, end_hhmm="23:59",
                                 days="1,2,3,4,5,6,7", grace_min=10, timezone=TZ))
        self.db.add(models.ShiftAssignment(id="as-slive", employee_email=PRESET_LATE, shift_id="preset-slive",
                                           assigned_at="2026-01-01T00:00:00"))
        for i, (em, start) in enumerate(((LATE, STARTED), (ONTIME, LATER), (SICK, STARTED), (OUTDONE, STARTED),
                                         (WEATHER, STARTED), (EXEMPT, STARTED), (ME, STARTED))):
            self.db.add(models.ScheduledShift(id=f"ss-slive-{i}", employee_email=em, work_date=TODAY, start_hhmm=start,
                                              end_hhmm="23:59", published=1, timezone=TZ,
                                              weather_status="cancelled" if em == WEATHER else ""))
        for em, punches in {
            ME: [("in", _at(hours=1), "")],
            BRK: [("in", _at(hours=2), ""), ("break_start", _at(minutes=10), "")],
            SICK: [("in", _at(hours=1), "Sick Day")],
            OUTDONE: [("in", _at(minutes=80), ""), ("out", _at(minutes=5), "")],
        }.items():
            for k, (kind, at, cat) in enumerate(punches):
                self.db.add(models.TimePunch(id=f"tp-slive-{em}-{k}", employee_email=em, kind=kind, at=at,
                                             local_date=at[:10], tz_offset_min=0, category=cat))
        self.db.commit()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()
        os.environ["NEXUS_DEV_EMAIL"] = ME

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        auth.SKIP_AUTH = self._skip
        self.db.close()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def _live(self):
        r = self.client.get("/timeclock/my-schedule/live")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_late_comes_from_the_expected_start(self):
        body = self._live()
        # Past start + grace with no clock-in: a placement or the usual-hours
        # preset. Not yet started, nothing expected, called off by weather,
        # already in and out, on leave, or exempt: never late.
        self.assertEqual(body["late"], sorted([LATE, PRESET_LATE]))
        for em in (ONTIME, NOSHIFT, WEATHER, OUTDONE, SICK, EXEMPT, ME, BRK):
            self.assertNotIn(em, body["late"])

    def test_a_leave_punch_is_not_a_clock_in(self):
        body = self._live()
        self.assertNotIn(SICK, body["people"])
        self.assertNotIn(SICK, body["late"])

    def test_counts_over_the_people_i_see(self):
        body = self._live()
        # 9 non-exempt members: In 1 (me), On Break 1, Late 2, Off 5 (on
        # time, no shift, sick, clocked out, weather).
        self.assertEqual(body["counts"], {"in": 1, "break": 1, "late": 2, "off": 5})

    def test_people_keeps_its_shape(self):
        body = self._live()
        self.assertEqual(body["people"][ME], {"state": "working", "label": "Working", "since": _at(hours=1) + "Z"})
        self.assertEqual(body["people"][BRK]["state"], "break")
        self.assertEqual(body["people"][OUTDONE]["state"], "out")
        self.assertIn("asOf", body)

    def test_once_clocked_in_no_longer_late(self):
        self.db.add(models.TimePunch(id="tp-slive-late-in", employee_email=LATE, kind="in", at=_at(minutes=2),
                                     local_date=_at(minutes=2)[:10], tz_offset_min=0, category=""))
        self.db.commit()
        body = self._live()
        self.assertEqual(body["late"], [PRESET_LATE])
        self.assertEqual(body["people"][LATE]["state"], "working")
        self.assertEqual(body["counts"], {"in": 2, "break": 1, "late": 1, "off": 5})

    def test_no_groups_means_empty_counts(self):
        self.db.query(models.ShiftGroupMember).delete()
        self.db.commit()
        body = self._live()
        self.assertEqual(body["people"], {})
        self.assertEqual(body["late"], [])
        self.assertEqual(body["counts"], {"in": 0, "break": 0, "late": 0, "off": 0})


if __name__ == "__main__":
    unittest.main()
