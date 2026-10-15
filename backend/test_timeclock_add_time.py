"""Add Time (Neil, Oct 14 2026): a manager adds a shift, or a run of them, for
someone who did not clock in right. /timeclock/add-time/days tells the picker
what each day holds; POST /timeclock/add-time judges every day with the single
manager-punch guards and writes the ones it admits under one batch id; the
undo voids that batch.

Run with: python -m pytest test_timeclock_add_time.py
"""
import os
import tempfile
import unittest
import uuid

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException

import database
import models
from routers import timeclock as T


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}. Run it on its own.")


_assert_isolated()

ADMIN = {"email": "neil@greensglobal.com", "level": 4}
EMP = "dean@greensglobal.com"
WEEK = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]   # Mon-Fri, all past


def day(date, in_h="15:30", out_h="00:30", **kw):
    """A Pacific 8:30a-5:30p shift typed as UTC (offset 420): in 15:30Z, out 00:30Z next day."""
    nxt = date if out_h >= in_h else T.date.fromisoformat(date) + T.timedelta(days=1)
    return T.AddTimeDay(date=date, in_at=f"{date}T{in_h}:00", out_at=f"{nxt}T{out_h}:00", **kw)


class AddTimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except FileNotFoundError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TimePunch, models.TimeApproval, models.TimeOffRequest, models.HrCompanyHoliday,
                  models.ScheduledShift, models.ShiftAssignment, models.Shift):
            self.db.query(m).delete()
        self.db.query(models.NexusEmployee).execution_options(include_deleted=True).delete()
        self.db.add(models.NexusEmployee(id="e-dean", first_name="Dean", last_name="Test", work_email=EMP,
                                         company="co-1", country="US", status="active", deleted_at=""))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _punch(self, date, kind, at, **kw):
        self.db.add(models.TimePunch(id=str(uuid.uuid4()), employee_email=EMP, kind=kind, at=at, local_date=date,
                                     tz_offset_min=420, voided=0, created_at=at, **kw))

    def _add(self, days, reason="Forgot to clock in - no signal at the site", **kw):
        return T.add_time(T.AddTimeIn(employee_email=EMP, reason=reason, days=days, tz_offset_min=420, **kw),
                          user=ADMIN, db=self.db)

    def _punches(self):
        return self.db.query(models.TimePunch).filter(models.TimePunch.employee_email == EMP).order_by(models.TimePunch.at).all()

    # -- the picker ------------------------------------------------------------
    def test_days_says_what_each_day_holds(self):
        self._punch(WEEK[0], "in", f"{WEEK[0]}T15:30:00")                       # open shift
        self._punch(WEEK[1], "in", f"{WEEK[1]}T15:30:00")
        self._punch(WEEK[1], "out", f"{WEEK[1]}T23:30:00")                      # closed 8h
        self.db.add(models.TimeOffRequest(id="to1", employee_email=EMP, type="vacation", status="approved",
                                          start_date=WEEK[2], end_date=WEEK[2]))
        self.db.add(models.HrCompanyHoliday(id="h1", company_id="co-1", date=WEEK[3], name="Founders Day"))
        self.db.add(models.Shift(id="s1", name="Day", start_hhmm="08:30", end_hhmm="17:30", days="1,2,3,4,5", break_min=30))
        self.db.add(models.ShiftAssignment(id="a1", employee_email=EMP, shift_id="s1"))
        self.db.add(models.ScheduledShift(id="ss1", employee_email=EMP, work_date=WEEK[4], start_hhmm="07:00",
                                          end_hhmm="15:00", published=1, label="Early"))
        self.db.add(models.TimeApproval(id="f1", employee_email=EMP, kind="final", period_start=WEEK[4],
                                        period_end=WEEK[4], revoked=0))
        self.db.commit()
        res = T.add_time_days(email=EMP, start=WEEK[0], end="2026-10-10", user=ADMIN, db=self.db)
        by = {d["date"]: d for d in res["days"]}
        self.assertEqual(by[WEEK[0]]["state"], "needs_out")
        self.assertEqual(by[WEEK[0]]["openIn"], f"{WEEK[0]}T15:30:00")
        self.assertEqual((by[WEEK[1]]["state"], by[WEEK[1]]["workedMin"]), ("has_time", 480))
        self.assertEqual(by[WEEK[2]]["timeOff"], "vacation")
        self.assertEqual(by[WEEK[3]]["holiday"], "Founders Day")
        self.assertEqual(by[WEEK[4]]["shift"]["start"], "07:00")
        self.assertIn("finalized", by[WEEK[4]]["locked"].lower())
        self.assertEqual(by[WEEK[2]]["usual"], {"start": "08:30", "end": "17:30", "breakMin": 30})
        self.assertIsNone(by["2026-10-10"]["usual"])                                  # Saturday: no usual hours
        self.assertEqual(by["2026-10-10"]["state"], "empty")

    def test_someone_outside_the_scope_is_refused(self):
        manager = {"email": "someone@greensglobal.com", "level": 3}
        with self.assertRaises(HTTPException) as e:
            T.add_time_days(email=EMP, start=WEEK[0], end=WEEK[1], user=manager, db=self.db)
        self.assertEqual(e.exception.status_code, 403)

    # -- the write -------------------------------------------------------------
    def test_a_dry_run_plans_without_writing_and_the_write_matches_it(self):
        plan = self._add([day(WEEK[0]), day(WEEK[1], break_min=30)], dry_run=True)
        self.assertTrue(plan["dryRun"])
        self.assertEqual([(d["date"], d["action"], d["minutes"]) for d in plan["days"]],
                         [(WEEK[0], "add", 540), (WEEK[1], "add", 510)])
        self.assertEqual(plan["totalMin"], 1050)
        self.assertEqual(self._punches(), [])
        res = self._add([day(WEEK[0]), day(WEEK[1], break_min=30)], category="Operations")
        self.assertEqual((res["added"], res["totalMin"]), (2, 1050))
        rows = self._punches()
        self.assertEqual([(p.local_date, p.kind) for p in rows],
                         [(WEEK[0], "in"), (WEEK[0], "out"), (WEEK[1], "in"), (WEEK[1], "break_start"), (WEEK[1], "break_end"), (WEEK[1], "out")])
        self.assertTrue(all(p.batch_id == res["batchId"] and p.source == "manual" and p.created_by == ADMIN["email"]
                            and p.note.startswith("Forgot") and p.tz_offset_min == 420 for p in rows))
        self.assertEqual([p.category for p in rows if p.kind == "in"], ["Operations", "Operations"])
        self.assertEqual([p.category for p in rows if p.kind != "in"], ["", "", "", ""])
        # the break sits in the middle of the shift
        b = [p for p in rows if p.kind.startswith("break")]
        self.assertEqual((b[0].at, b[1].at), (f"{WEEK[1]}T19:45:00", f"{WEEK[1]}T20:15:00"))

    def test_a_day_with_an_open_shift_gets_only_its_clock_out(self):
        self._punch(WEEK[0], "in", f"{WEEK[0]}T15:30:00")
        self.db.commit()
        res = self._add([day(WEEK[0])])
        self.assertEqual(res["days"][0]["action"], "fill_out")
        self.assertEqual(res["days"][0]["minutes"], 540)
        self.assertEqual([p.kind for p in self._punches()], ["in", "out"])
        self.assertEqual([p.source for p in self._punches()], ["web", "manual"])

    def test_a_clock_out_before_the_open_clock_in_is_refused_for_that_day_only(self):
        self._punch(WEEK[0], "in", f"{WEEK[0]}T15:30:00")
        self.db.commit()
        res = self._add([T.AddTimeDay(date=WEEK[0], out_at=f"{WEEK[0]}T15:00:00"), day(WEEK[1])])
        self.assertEqual([d["action"] for d in res["days"]], ["skip", "add"])
        self.assertIn("after the open clock-in", res["days"][0]["reason"])
        self.assertEqual(res["added"], 1)

    def test_a_day_that_already_has_time_is_skipped_unless_forced(self):
        self._punch(WEEK[0], "in", f"{WEEK[0]}T15:30:00")
        self._punch(WEEK[0], "out", f"{WEEK[0]}T19:30:00")
        self.db.commit()
        res = self._add([day(WEEK[0])])
        self.assertEqual(res["days"][0]["action"], "skip")
        self.assertIn("Already has 4h 00m", res["days"][0]["reason"])
        self.assertEqual(res["added"], 0)
        self.assertEqual(res["batchId"], "")
        res = self._add([day(WEEK[0], in_h="20:00", out_h="23:00", force=True)])
        self.assertEqual(res["days"][0]["action"], "add")
        self.assertEqual(len(self._punches()), 4)

    def test_locked_days_are_skipped_with_the_reason_and_the_rest_written(self):
        self.db.add(models.TimeApproval(id="f1", employee_email=EMP, kind="final", period_start=WEEK[0],
                                        period_end=WEEK[0], revoked=0))
        self.db.commit()
        res = self._add([day(WEEK[0]), day(WEEK[1])])
        self.assertEqual([d["action"] for d in res["days"]], ["skip", "add"])
        self.assertIn("finalized", res["days"][0]["reason"].lower())
        self.assertEqual({p.local_date for p in self._punches()}, {WEEK[1]})

    def test_bad_input_is_refused_up_front(self):
        with self.assertRaises(HTTPException) as e:
            self._add([day(WEEK[0])], reason="x")
        self.assertEqual(e.exception.status_code, 400)
        with self.assertRaises(HTTPException):
            self._add([])
        res = self._add([T.AddTimeDay(date=WEEK[0], in_at=f"{WEEK[0]}T20:00:00", out_at=f"{WEEK[0]}T19:00:00")])   # out before in
        self.assertEqual(res["days"][0]["action"], "skip")
        self.assertIn("after the clock-in", res["days"][0]["reason"])
        res = self._add([T.AddTimeDay(date=WEEK[0], in_at=f"{WEEK[0]}T02:00:00", out_at=f"{WEEK[0]}T10:00:00")])
        self.assertIn("time zone", res["days"][0]["reason"])                   # 02:00Z is the day before in Pacific

    # -- undo ------------------------------------------------------------------
    def test_undo_voids_the_whole_batch_once(self):
        res = self._add([day(WEEK[0]), day(WEEK[1], break_min=30)])
        out = T.add_time_undo(res["batchId"], user=ADMIN, db=self.db)
        self.assertEqual(out["voided"], 6)
        rows = self._punches()
        self.assertTrue(all(p.voided == 1 and p.adjust_note == "Undo of Add Time" for p in rows))
        with self.assertRaises(HTTPException) as e:
            T.add_time_undo(res["batchId"], user=ADMIN, db=self.db)
        self.assertEqual(e.exception.status_code, 404)

    def test_undo_is_refused_once_a_day_is_finalized(self):
        res = self._add([day(WEEK[0])])
        self.db.add(models.TimeApproval(id="f1", employee_email=EMP, kind="final", period_start=WEEK[0],
                                        period_end=WEEK[0], revoked=0))
        self.db.commit()
        with self.assertRaises(HTTPException) as e:
            T.add_time_undo(res["batchId"], user=ADMIN, db=self.db)
        self.assertEqual(e.exception.status_code, 403)
        self.assertTrue(all(p.voided == 0 for p in self._punches()))

    # -- review pass ------------------------------------------------------------
    def test_a_normal_overnight_shift_reads_as_time_not_two_missing_punches(self):
        self._punch("2026-10-04", "in", "2026-10-05T04:00:00")            # Sun 9pm Pacific
        self._punch(WEEK[0], "out", "2026-10-05T13:00:00")                # Mon 6am Pacific, dated Mon
        self.db.commit()
        by = {d["date"]: d for d in T.add_time_days(email=EMP, start="2026-10-04", end=WEEK[0], user=ADMIN, db=self.db)["days"]}
        self.assertEqual((by["2026-10-04"]["state"], by["2026-10-04"]["workedMin"]), ("has_time", 540))
        self.assertEqual(by[WEEK[0]]["state"], "empty")

    def test_an_overnight_add_dates_its_clock_out_on_the_next_day(self):
        # Mon 9pm - Tue 6am Pacific: 04:00Z and 13:00Z on Tuesday's UTC date
        res = self._add([T.AddTimeDay(date=WEEK[0], in_at=f"{WEEK[1]}T04:00:00", out_at=f"{WEEK[1]}T13:00:00")])
        self.assertEqual(res["days"][0]["action"], "add", res["days"][0]["reason"])
        self.assertEqual([(p.kind, p.local_date) for p in self._punches()], [("in", WEEK[0]), ("out", WEEK[1])])

    def test_a_second_shift_before_the_existing_one_is_allowed(self):
        self._punch(WEEK[0], "in", f"{WEEK[0]}T15:30:00")
        self._punch(WEEK[0], "out", f"{WEEK[0]}T23:30:00")
        self.db.commit()
        res = self._add([day(WEEK[0], in_h="13:00", out_h="15:00", force=True)])
        self.assertEqual(res["days"][0]["action"], "add", res["days"][0]["reason"])

    def test_a_second_shift_that_overlaps_the_existing_one_is_skipped(self):
        self._punch(WEEK[0], "in", f"{WEEK[0]}T15:30:00")
        self._punch(WEEK[0], "out", f"{WEEK[0]}T23:30:00")
        self.db.commit()
        res = self._add([day(WEEK[0], in_h="17:00", out_h="19:00", force=True)])
        self.assertEqual(res["days"][0]["action"], "skip")
        self.assertIn("overlaps", res["days"][0]["reason"])

    def test_a_shift_carried_over_from_the_night_before_blocks_an_overlapping_add(self):
        self._punch("2026-10-04", "in", "2026-10-05T05:00:00")            # Sun 10pm Pacific
        self._punch(WEEK[0], "out", "2026-10-05T14:00:00")                # Mon 7am Pacific
        self.db.commit()
        res = self._add([T.AddTimeDay(date=WEEK[0], in_at="2026-10-05T12:00:00", out_at="2026-10-05T16:00:00")])
        self.assertEqual(res["days"][0]["action"], "skip")
        self.assertIn("overlaps", res["days"][0]["reason"])

    def test_an_overnight_add_into_a_finalized_next_day_is_skipped(self):
        self.db.add(models.TimeApproval(id="f2", employee_email=EMP, kind="final", period_start=WEEK[1],
                                        period_end=WEEK[1], revoked=0))
        self.db.commit()
        res = self._add([T.AddTimeDay(date=WEEK[0], in_at=f"{WEEK[1]}T04:00:00", out_at=f"{WEEK[1]}T13:00:00")])
        self.assertEqual(res["days"][0]["action"], "skip")
        self.assertIn("finalized", res["days"][0]["reason"].lower())

    def test_closing_an_open_shift_is_capped_at_16_hours(self):
        self._punch(WEEK[0], "in", f"{WEEK[0]}T15:30:00")
        self.db.commit()
        res = self._add([T.AddTimeDay(date=WEEK[0], out_at=f"{WEEK[1]}T10:00:00")])
        self.assertIn("16 hours", res["days"][0]["reason"])

    def test_a_manager_cannot_undo_someone_elses_batch_outside_their_team(self):
        res = self._add([day(WEEK[0])])
        with self.assertRaises(HTTPException) as e:
            T.add_time_undo(res["batchId"], user={"email": "someone@greensglobal.com", "level": 3}, db=self.db)
        self.assertEqual(e.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
