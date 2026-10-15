"""Shifts Phase 3b - dated availability and hours preferences (Neil, Oct 14
2026): routers/timeclock availability routes, _availability /
_shift_conflicts, shift_rules' personal week cap.

  - GET/PUT /timeclock/availability/mine round-trips {days, dates, prefs};
    a part not sent is untouched; past dated rows are kept.
  - A dated row wins over the weekday rule in the conflict check, on the
    grid and in the Add/Edit check.
  - A person's own max hours a week warns like the company cap - the
    tighter one applies - and the preferences ride in the grid's
    availability payload.

Throwaway sqlite. Run with: python -m unittest test_shift_availability_dates -v
"""
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

from fastapi.testclient import TestClient   # noqa: E402

import auth               # noqa: E402
import cache              # noqa: E402
import database           # noqa: E402
import main               # noqa: E402
import models             # noqa: E402
import shift_rules        # noqa: E402
from routers.timeclock import _shift_conflicts, _availability   # noqa: E402

ENT, GROUP = "ent-avd", "grp-avd"
ADMIN = "avd.admin@greensglobal.com"
A = "avd.a@greensglobal.com"
_today = datetime.now(timezone.utc).date()
# The Monday at least a week out, and the one after: dated rows are only
# written from today on, and the weekday rule is "Mondays".
MON1 = _today + timedelta(days=(7 - _today.weekday()) % 7 + 7)
MON2 = MON1 + timedelta(days=7)
TUE1 = MON1 + timedelta(days=1)
WED1 = MON1 + timedelta(days=2)
PAST = _today - timedelta(days=10)


def _iso(d):
    return d.isoformat()


def _us(d):
    return d.strftime("%m/%d/%Y")


def _s(date, start, end, id_="x", **kw):
    return {"id": id_, "date": date, "start": start, "end": end, **kw}


def _rs(sid, date, start, end):
    s0, e0 = int(start[:2]) * 60 + int(start[3:]), int(end[:2]) * 60 + int(end[3:])
    return {"id": sid, "date": date, "start": start, "end": end, "paidMin": e0 - s0 if e0 > s0 else e0 + 1440 - s0}


class ConflictRuleTests(unittest.TestCase):
    """_shift_conflicts on its own - no database."""

    def test_a_dated_row_wins_over_the_weekday_rule(self):
        day = _iso(MON1)
        weekly = [{"weekday": 0, "kind": "available", "start": "08:00", "end": "12:00", "note": ""}]
        shift = _s(day, "09:00", "17:00")
        self.assertEqual(_shift_conflicts(shift, [], [], {}, weekly),
                         ["Outside their availability on Mondays (8:00 AM - 12:00 PM)."])
        dated_off = weekly + [{"id": "d1", "date": day, "kind": "unavailable", "start": "", "end": "", "note": "dentist"}]
        self.assertEqual(_shift_conflicts(shift, [], [], {}, dated_off), [f"Marked unavailable on {_us(MON1)} (dentist)."])
        dated_window = weekly + [{"id": "d2", "date": day, "kind": "available", "start": "09:00", "end": "13:00", "note": ""}]
        self.assertEqual(_shift_conflicts(shift, [], [], {}, dated_window),
                         [f"Outside their availability on {_us(MON1)} (9:00 AM - 1:00 PM)."])
        # A date that opens the whole day silences the weekday rule.
        dated_open = weekly + [{"id": "d3", "date": day, "kind": "available", "start": "08:00", "end": "18:00", "note": ""}]
        self.assertEqual(_shift_conflicts(shift, [], [], {}, dated_open), [])
        # Another date's row does not touch this day; a prefs row is ignored.
        other = weekly + [{"id": "d4", "date": _iso(MON2), "kind": "unavailable", "start": "", "end": "", "note": ""},
                          {"kind": "prefs", "preferredHoursWeek": 24, "maxHoursWeek": 30}]
        self.assertEqual(_shift_conflicts(shift, [], [], {}, other),
                         ["Outside their availability on Mondays (8:00 AM - 12:00 PM)."])


class PersonalCapTests(unittest.TestCase):
    """shift_rules.evaluate with a person's own week cap - no database."""
    WEEK = [_rs("a", "2026-10-12", "07:00", "17:00"), _rs("b", "2026-10-13", "07:00", "17:00"),
            _rs("c", "2026-10-14", "07:00", "17:00")]     # 30h, Mon-Wed
    CFG = {"ruleMinRestHours": 0, "ruleMaxDaysInRow": 0, "ruleDailyOtHours": 0, "ruleWeeklyOtHours": 0}

    def test_the_own_cap_warns_when_the_company_has_none(self):
        out = shift_rules.evaluate(self.WEEK, {**self.CFG, "ruleMaxWeekHours": 0}, max_hours_week=25)
        self.assertEqual(out, {"c": ["30h 00m scheduled this week (they asked for at most 25h)."]})

    def test_the_tighter_cap_applies(self):
        own = shift_rules.evaluate(self.WEEK, {**self.CFG, "ruleMaxWeekHours": 40}, max_hours_week=25)
        self.assertEqual(own, {"c": ["30h 00m scheduled this week (they asked for at most 25h)."]})
        company = shift_rules.evaluate(self.WEEK, {**self.CFG, "ruleMaxWeekHours": 20}, max_hours_week=25)
        self.assertEqual(company, {"c": ["30h 00m scheduled this week (20h is the most)."]})   # b ends AT 20h

    def test_no_cap_at_zero(self):
        self.assertEqual(shift_rules.evaluate(self.WEEK, {**self.CFG, "ruleMaxWeekHours": 0}, max_hours_week=0), {})
        self.assertEqual(shift_rules.evaluate(self.WEEK, {**self.CFG, "ruleMaxWeekHours": 0}, max_hours_week=30), {})


class _Case(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.NexusRole, models.NexusEmployee, models.ShiftGroup, models.ShiftGroupMember, models.HrEntity,
                  models.ScheduledShift, models.NexusSetting, models.ShiftAvailability, models.ShiftAvailabilityDate,
                  models.ShiftAvailabilityPref, models.ShiftChangeLog):
            self.db.query(m).delete()
        for em, first, role in ((ADMIN, "Ada", "administrator"), (A, "Amy", "")):
            self.db.add(models.NexusEmployee(id=f"emp-{em}", first_name=first, last_name="Lee", work_email=em,
                                             status="active", deleted_at="", company=ENT, country="US"))
            if role:
                self.db.add(models.NexusRole(email=em, role=role, assigned_by="test"))
        self.db.add(models.HrEntity(id=ENT, name="Greens"))
        self.db.add(models.ShiftGroup(id=GROUP, name="Crew", company_id=ENT, created_by=ADMIN))
        self.db.add(models.ShiftGroupMember(id=f"m-{A}", group_id=GROUP, employee_email=A))
        self.db.commit()
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._as(A)

    def tearDown(self):
        self.db.rollback()
        self.db.close()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def _save(self, expect=200, **body):
        self._as(A)
        r = self.client.put("/timeclock/availability/mine", json=body)
        self.assertEqual(r.status_code, expect, r.text)
        return r.json()

    def _mine(self):
        self._as(A)
        return self.client.get("/timeclock/availability/mine").json()

    def _shift(self, day, start="09:00", end="17:00", email=A):
        sid = f"s-{day}-{start}"
        self.db.add(models.ScheduledShift(id=sid, employee_email=email, work_date=day, start_hhmm=start, end_hhmm=end,
                                          published=1, group_id=GROUP, created_by=ADMIN))
        self.db.commit()
        return sid

    def _grid(self, start, end):
        self._as(ADMIN)
        r = self.client.get(f"/timeclock/schedule?start={start}&end={end}")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()


class AvailabilityRouteTests(_Case):
    def test_round_trip(self):
        saved = self._save(days=[{"weekday": 0, "kind": "available", "start": "08:00", "end": "12:00"}],
                           dates=[{"date": _iso(MON2), "kind": "available", "start": "09:00", "end": "13:00", "note": "Late"},
                                  {"date": _iso(MON1), "kind": "unavailable", "note": "dentist"},
                                  {"date": _iso(TUE1), "kind": "any"}],
                           prefs={"preferredHoursWeek": 24, "maxHoursWeek": 30})
        self.assertEqual(saved["days"], [{"weekday": 0, "kind": "available", "start": "08:00", "end": "12:00", "note": ""}])
        self.assertEqual([(d["date"], d["kind"], d["start"], d["end"], d["note"]) for d in saved["dates"]],
                         [(_iso(MON1), "unavailable", "", "", "dentist"), (_iso(MON2), "available", "09:00", "13:00", "Late")])
        self.assertTrue(all(d["id"] for d in saved["dates"]))
        self.assertEqual(saved["prefs"], {"preferredHoursWeek": 24, "maxHoursWeek": 30})
        self.assertEqual(self._mine(), saved)
        # A part left out is untouched; one sent replaces its own part only.
        again = self._save(prefs={"maxHoursWeek": 20})
        self.assertEqual(again["prefs"], {"preferredHoursWeek": 24, "maxHoursWeek": 20})
        self.assertEqual((len(again["days"]), len(again["dates"])), (1, 2))
        cleared = self._save(dates=[])
        self.assertEqual((cleared["dates"], len(cleared["days"])), ([], 1))
        # Bad input.
        self._save(400, dates=[{"date": "next monday", "kind": "unavailable"}])
        self._save(400, dates=[{"date": _iso(MON1), "kind": "available", "start": "", "end": ""}])
        self._save(400, dates=[{"date": _iso(MON1), "kind": "sometimes"}])
        self._save(400, prefs={"maxHoursWeek": 200})
        self._save(400, prefs={"preferredHoursWeek": -1})
        # Nothing set reads as zeros.
        self._save(prefs={"preferredHoursWeek": 0, "maxHoursWeek": 0})
        self.assertEqual(self._mine()["prefs"], {"preferredHoursWeek": 0, "maxHoursWeek": 0})

    def test_the_payload_says_which_day_is_today(self):
        """`today` is the server's line between dated rows that can still
        change and the past - in the company's shift zone, the one the save
        keys on - so the screen never files today's row as past."""
        from routers.timeclock import _shift_local_now, _DEFAULT_TEAM_TZ
        today = _shift_local_now(_DEFAULT_TEAM_TZ).date().isoformat()
        self.assertEqual(self._mine()["today"], today)
        saved = self._save(dates=[{"date": today, "kind": "unavailable", "note": "Today still counts"}])
        self.assertEqual((saved["today"], [d["date"] for d in saved["dates"]]), (today, [today]))

    def test_past_dates_are_kept(self):
        self.db.add(models.ShiftAvailabilityDate(id="old", employee_email=A, date=_iso(PAST), kind="unavailable",
                                                 note="Was away", created_at="2026-01-01T00:00:00"))
        self.db.commit()
        saved = self._save(dates=[{"date": _iso(MON1), "kind": "unavailable"},
                                  {"date": _iso(PAST - timedelta(days=1)), "kind": "unavailable"}])   # a past date sent is ignored
        self.assertEqual([(d["id"], d["date"]) for d in saved["dates"]][0], ("old", _iso(PAST)))
        self.assertEqual([d["date"] for d in saved["dates"]], [_iso(PAST), _iso(MON1)])
        self.assertEqual([d["date"] for d in self._save(dates=[])["dates"]], [_iso(PAST)])

    def test_availability_carries_weekly_dated_and_prefs_rows(self):
        self._save(days=[{"weekday": 1, "kind": "unavailable", "note": "Class"}],
                   dates=[{"date": _iso(MON1), "kind": "unavailable", "note": "dentist"}],
                   prefs={"preferredHoursWeek": 24, "maxHoursWeek": 0})
        rows = _availability(self.db, [A])[A]
        self.assertEqual(rows[0]["weekday"], 1)
        self.assertEqual((rows[1]["date"], rows[1]["note"]), (_iso(MON1), "dentist"))
        self.assertEqual(rows[2], {"kind": "prefs", "preferredHoursWeek": 24, "maxHoursWeek": 0})
        # No prefs row when nothing is set.
        self._save(prefs={"preferredHoursWeek": 0})
        self.assertEqual(len(_availability(self.db, [A])[A]), 2)


class GridTests(_Case):
    def test_the_grid_and_the_check_use_the_dated_row(self):
        self._save(days=[{"weekday": 0, "kind": "available", "start": "08:00", "end": "12:00"}],
                   dates=[{"date": _iso(MON1), "kind": "unavailable", "note": "dentist"},
                          {"date": _iso(MON2), "kind": "available", "start": "09:00", "end": "13:00"}],
                   prefs={"preferredHoursWeek": 24, "maxHoursWeek": 0})
        self._shift(_iso(MON1))
        self._shift(_iso(MON2))
        self._shift(_iso(MON2 + timedelta(days=7)))      # a plain Monday: the weekday rule
        grid = self._grid(_iso(MON1), _iso(MON2 + timedelta(days=7)))
        by_day = {s["date"]: s["conflicts"] for s in grid["scheduled"] if s["email"] == A}
        self.assertEqual(by_day[_iso(MON1)], [f"Marked unavailable on {_us(MON1)} (dentist)."])
        self.assertEqual(by_day[_iso(MON2)], [f"Outside their availability on {_us(MON2)} (9:00 AM - 1:00 PM)."])
        self.assertEqual(by_day[_iso(MON2 + timedelta(days=7))], ["Outside their availability on Mondays (8:00 AM - 12:00 PM)."])
        # The prefs ride in the availability payload, after the weekly and dated rows.
        av = grid["availability"][A]
        self.assertEqual(av[0]["weekday"], 0)
        self.assertEqual(av[-1], {"kind": "prefs", "preferredHoursWeek": 24, "maxHoursWeek": 0})
        self.assertEqual([a["date"] for a in av if a.get("date")], [_iso(MON1), _iso(MON2)])
        self._as(ADMIN)
        chk = self.client.get(f"/timeclock/schedule/check?email={A}&date={_iso(MON2)}&start=09:30&end=12:30"
                              f"&exclude_id=s-{_iso(MON2)}-09:00").json()
        self.assertEqual(chk["conflicts"], [])
        chk = self.client.get(f"/timeclock/schedule/check?email={A}&date={_iso(MON1)}&start=09:30&end=12:30"
                              f"&exclude_id=s-{_iso(MON1)}-09:00").json()
        self.assertEqual(chk["conflicts"], [f"Marked unavailable on {_us(MON1)} (dentist)."])

    def _company(self, **cfg):
        self.db.query(models.NexusSetting).filter(models.NexusSetting.key == f"shift_requests_config:{ENT}").delete()
        self.db.add(models.NexusSetting(key=f"shift_requests_config:{ENT}", value=json.dumps(cfg)))
        self.db.commit()

    def test_the_personal_cap_warns_on_the_grid_and_the_tighter_cap_wins(self):
        self._company(ruleDailyOtHours=0, ruleWeeklyOtHours=0)   # 10h days without the overtime rules in the way
        self._save(prefs={"maxHoursWeek": 25})
        for d in (MON1, TUE1, WED1):
            self._shift(_iso(d), "07:00", "17:00")       # 30h
        own = "30h 00m scheduled this week (they asked for at most 25h)."
        self.assertEqual(shift_rules.rule_warnings(self.db, [A], _iso(MON1), _iso(WED1)), {f"s-{_iso(WED1)}-07:00": [own]})
        grid = self._grid(_iso(MON1), _iso(WED1))
        by_day = {s["date"]: s for s in grid["scheduled"] if s["email"] == A}
        self.assertEqual(by_day[_iso(WED1)]["ruleWarnings"], [own])
        self.assertIn(own, by_day[_iso(WED1)]["conflicts"])
        self.assertEqual(by_day[_iso(TUE1)]["ruleWarnings"], [])
        # The company's cap, when tighter, is the one that warns.
        self._company(ruleDailyOtHours=0, ruleWeeklyOtHours=0, ruleMaxWeekHours=20)
        out = shift_rules.rule_warnings(self.db, [A], _iso(MON1), _iso(WED1))
        self.assertEqual(out, {f"s-{_iso(WED1)}-07:00": ["30h 00m scheduled this week (20h is the most)."]})
        # Without a personal cap and the company at 40, nothing warns.
        self._save(prefs={"maxHoursWeek": 0})
        self._company(ruleDailyOtHours=0, ruleWeeklyOtHours=0, ruleMaxWeekHours=40)
        self.assertEqual(shift_rules.rule_warnings(self.db, [A], _iso(MON1), _iso(WED1)), {})


if __name__ == "__main__":
    unittest.main()
