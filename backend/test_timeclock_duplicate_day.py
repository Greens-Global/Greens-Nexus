"""Duplicate Day (Neil, Oct 27 2026): HR enters one day - or picks one already
on the card - and lays it onto other days: picked ones, All Working Days or
All Days of the period. HR only (timesheet_review.is_hr), a dry run that is
the preview, days with punches skipped unless Replace Existing, one undo
that also brings back what was replaced.

Run with: python -m pytest test_timeclock_duplicate_day.py
"""
import os
import tempfile
import unittest
import uuid

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
from routers import timeclock as T  # noqa: E402


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}. Run it on its own.")


_assert_isolated()

HR = "hr.dup@greensglobal.com"            # the company's HR contact
HR_USER = {"email": HR, "level": 4}
MGR = "mgr.dup@greensglobal.com"          # Dean's manager - not HR
MGR_USER = {"email": MGR, "level": 3}
EMP = "dean.dup@greensglobal.com"
WEEK = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]   # Mon-Fri, all past
REASON = "Paper time sheet - entered by HR"


class DuplicateDayTests(unittest.TestCase):
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
        auth.invalidate_role_cache()
        self.db = database.SessionLocal()
        for m in (models.TimePunch, models.TimeApproval, models.TimeOffRequest, models.HrCompanyHoliday,
                  models.ScheduledShift, models.ShiftAssignment, models.Shift, models.HrEntity, models.NexusRole,
                  models.PunchRequest):
            self.db.query(m).delete()
        self.db.query(models.NexusEmployee).execution_options(include_deleted=True).delete()
        self.db.add(models.HrEntity(id="co-dup", name="Greens Dup", country="US", hr_contact_email=HR))
        self.db.add(models.NexusEmployee(id="e-dean", first_name="Dean", last_name="Test", work_email=EMP,
                                         company="co-dup", country="US", status="active", deleted_at="",
                                         manager_email=MGR))
        self.db.add(models.NexusEmployee(id="e-hr", first_name="Hana", last_name="Hr", work_email=HR,
                                         company="co-dup", country="US", status="active", deleted_at=""))
        self.db.commit()
        # Monday: 8:30a-5:30p Pacific with a 30 min lunch, as Sick Day.
        self._shift(WEEK[0], "15:30", "00:30", brk=("19:00", "19:30"), category="Operations")

    def tearDown(self):
        self.db.close()

    def _punch(self, date, kind, at, tz=420, **kw):
        self.db.add(models.TimePunch(id=str(uuid.uuid4()), employee_email=EMP, kind=kind, at=at, local_date=date,
                                     tz_offset_min=tz, voided=0, created_at=at, **kw))

    def _shift(self, date, in_h, out_h, brk=None, category=""):
        """A shift typed as UTC; an out before the in is the next UTC day (same Pacific day)."""
        nxt = date if out_h >= in_h else (T.date.fromisoformat(date) + T.timedelta(days=1)).isoformat()
        self._punch(date, "in", f"{date}T{in_h}:00", category=category)
        if brk:
            self._punch(date, "break_start", f"{date}T{brk[0]}:00")
            self._punch(date, "break_end", f"{date}T{brk[1]}:00")
        self._punch(date, "out", f"{nxt}T{out_h}:00")
        self.db.commit()

    def _dup(self, user=HR_USER, **kw):
        kw.setdefault("employee_email", EMP)
        kw.setdefault("reason", REASON)
        kw.setdefault("tz_offset_min", 420)
        return T.duplicate_day(T.DuplicateDayIn(**kw), user=user, db=self.db)

    def _live(self, date=None):
        q = self.db.query(models.TimePunch).filter(models.TimePunch.employee_email == EMP, models.TimePunch.voided == 0)
        if date:
            q = q.filter(models.TimePunch.local_date == date)
        return q.order_by(models.TimePunch.at).all()

    # -- who may ---------------------------------------------------------------
    def test_a_manager_is_refused_on_the_server(self):
        for dry in (True, False):
            with self.assertRaises(HTTPException) as e:
                self._dup(user=MGR_USER, source_date=WEEK[0], targets=[WEEK[1]], dry_run=dry)
            self.assertEqual(e.exception.status_code, 403)
        self.assertEqual(self._live(WEEK[1]), [])
        # ...and keeps Add Time exactly as it was.
        res = T.add_time(T.AddTimeIn(employee_email=EMP, reason="Forgot to clock in", tz_offset_min=420,
                                     days=[T.AddTimeDay(date=WEEK[1], in_at=f"{WEEK[1]}T15:30:00",
                                                        out_at=f"{WEEK[1]}T23:30:00")]), user=MGR_USER, db=self.db)
        self.assertEqual(res["added"], 1)

    def test_hr_on_their_own_card_is_refused(self):
        with self.assertRaises(HTTPException) as e:
            self._dup(employee_email=HR, source_date=WEEK[0], targets=[WEEK[1]], dry_run=True)
        self.assertEqual(e.exception.status_code, 403)

    def test_an_administrator_counts_as_hr(self):
        self.db.add(models.NexusRole(email="admin.dup@greensglobal.com", role="administrator"))
        self.db.commit()
        auth.invalidate_role_cache()
        res = self._dup(user={"email": "admin.dup@greensglobal.com", "level": 4},
                        source_date=WEEK[0], targets=[WEEK[1]], dry_run=True)
        self.assertEqual(res["added"], 1)

    def test_a_reason_is_required(self):
        with self.assertRaises(HTTPException) as e:
            self._dup(source_date=WEEK[0], targets=[WEEK[1]], reason=" ", dry_run=True)
        self.assertEqual(e.exception.status_code, 400)

    # -- copy, preview, write --------------------------------------------------
    def test_copy_a_day_preview_matches_the_write(self):
        plan = self._dup(source_date=WEEK[0], targets=[WEEK[1], WEEK[2]], dry_run=True)
        self.assertTrue(plan["dryRun"])
        self.assertEqual(plan["template"], [{"in": "08:30", "out": "17:30", "breaks": [["12:00", "12:30"]],
                                             "category": "Operations", "minutes": 510}])
        self.assertEqual([(d["date"], d["action"], d["minutes"]) for d in plan["days"]],
                         [(WEEK[1], "add", 510), (WEEK[2], "add", 510)])
        self.assertEqual(self._live(WEEK[1]), [])
        res = self._dup(source_date=WEEK[0], targets=[WEEK[1], WEEK[2]])
        self.assertTrue(res["batchId"].startswith("dup-"))
        self.assertEqual((res["added"], res["totalMin"]), (2, 1020))
        rows = self._live(WEEK[1])
        self.assertEqual([(p.kind, p.at) for p in rows],
                         [("in", f"{WEEK[1]}T15:30:00"), ("break_start", f"{WEEK[1]}T19:00:00"),
                          ("break_end", f"{WEEK[1]}T19:30:00"), ("out", f"{WEEK[2]}T00:30:00")])
        self.assertTrue(all(p.batch_id == res["batchId"] and p.source == "manual" and p.created_by == HR
                            and p.note == REASON and p.local_date == WEEK[1] for p in rows))
        self.assertEqual([p.category for p in rows], ["Operations", "", "", ""])
        # The card reads it: 8h 30m on each day.
        days = T._day_summaries(self._live(), 0)
        self.assertEqual((days[WEEK[1]]["workedMin"], days[WEEK[2]]["workedMin"]), (510, 510))

    def test_fill_a_day_with_typed_times(self):
        res = self._dup(fill_date=WEEK[1], in_at=f"{WEEK[1]}T16:00:00", out_at=f"{WEEK[1]}T20:00:00",
                        category="Vacation", targets=[WEEK[3]])
        self.assertEqual(res["template"][0]["category"], "Vacation")
        self.assertEqual([(p.kind, p.at, p.category) for p in self._live(WEEK[3])],
                         [("in", f"{WEEK[3]}T16:00:00", "Vacation"), ("out", f"{WEEK[3]}T20:00:00", "")])

    def test_a_day_with_punches_is_skipped_unless_replace(self):
        self._shift(WEEK[2], "16:00", "20:00")
        old_ids = {p.id for p in self._live(WEEK[2])}
        plan = self._dup(source_date=WEEK[0], targets=[WEEK[2]], dry_run=True)
        self.assertEqual(plan["days"][0]["action"], "skip")
        self.assertIn("Replace Existing", plan["days"][0]["reason"])
        self.assertEqual(plan["days"][0]["existingMin"], 240)
        res = self._dup(source_date=WEEK[0], targets=[WEEK[2]], replace=True)
        self.assertEqual((res["days"][0]["action"], res["days"][0]["replaces"], res["replaced"]), ("replace", 2, 1))
        self.assertEqual({p.at for p in self._live(WEEK[2])},
                         {f"{WEEK[2]}T15:30:00", f"{WEEK[2]}T19:00:00", f"{WEEK[2]}T19:30:00", f"{WEEK[3]}T00:30:00"})
        old = self.db.query(models.TimePunch).filter(models.TimePunch.id.in_(old_ids)).all()
        self.assertTrue(all(p.voided == 1 and p.replaced_by_batch == res["batchId"] and p.adjusted_by == HR
                            and p.adjust_note.startswith("Replaced by Add Time From Record") for p in old))
        # One undo takes the copy back and brings the replaced punches back.
        out = T.duplicate_day_undo(res["batchId"], user=HR_USER, db=self.db)
        self.assertEqual((out["voided"], out["restored"]), (4, 2))
        self.assertEqual({p.id for p in self._live(WEEK[2])}, old_ids)
        self.assertTrue(all(p.replaced_by_batch == "" for p in self._live(WEEK[2])))

    def test_undo_refuses_a_day_a_later_copy_replaced(self):
        # Release review, Oct 27 2026: A, then B over the same day (Replace
        # Existing), then undo A - must not restore A's replaced punches
        # under B's (a doubled day). Refused; B's day stays as it is.
        self._shift(WEEK[2], "16:00", "20:00")
        orig = {p.id for p in self._live(WEEK[2])}
        a = self._dup(source_date=WEEK[0], targets=[WEEK[2]], replace=True)
        b = self._dup(fill_date=WEEK[1], in_at=f"{WEEK[1]}T16:00:00", out_at=f"{WEEK[1]}T20:00:00",
                      targets=[WEEK[2]], replace=True)
        self.assertEqual(b["added"], 1, b["days"])
        b_ids = {p.id for p in self._live(WEEK[2])}
        self.assertTrue(b_ids and not (b_ids & orig))
        with self.assertRaises(HTTPException) as e:
            T.duplicate_day_undo(a["batchId"], user=HR_USER, db=self.db)
        self.assertEqual(e.exception.status_code, 409)
        self.assertIn("changed after it", e.exception.detail)
        self.db.expire_all()
        self.assertEqual({p.id for p in self._live(WEEK[2])}, b_ids)
        # Undo B first (brings A's punches back), then A undoes cleanly.
        T.duplicate_day_undo(b["batchId"], user=HR_USER, db=self.db)
        T.duplicate_day_undo(a["batchId"], user=HR_USER, db=self.db)
        self.db.expire_all()
        self.assertEqual({p.id for p in self._live(WEEK[2])}, orig)

    def test_undo_refuses_a_day_with_punches_added_after_it(self):
        a = self._dup(source_date=WEEK[0], targets=[WEEK[1]])
        for kind, at in (("in", f"{WEEK[2]}T02:00:00"), ("out", f"{WEEK[2]}T03:00:00")):
            self.db.add(models.TimePunch(id=str(uuid.uuid4()), employee_email=EMP, kind=kind, at=at,
                                         local_date=WEEK[1], tz_offset_min=420, voided=0, created_at=T._now_iso()))
        self.db.commit()
        with self.assertRaises(HTTPException) as e:
            T.duplicate_day_undo(a["batchId"], user=HR_USER, db=self.db)
        self.assertEqual(e.exception.status_code, 409)
        self.assertEqual(len(self._live(WEEK[1])), 6)

    def test_undo_is_hr_only_and_add_time_undo_refuses_it(self):
        res = self._dup(source_date=WEEK[0], targets=[WEEK[1]])
        with self.assertRaises(HTTPException) as e:
            T.duplicate_day_undo(res["batchId"], user=MGR_USER, db=self.db)
        self.assertEqual(e.exception.status_code, 403)
        with self.assertRaises(HTTPException) as e:
            T.add_time_undo(res["batchId"], user=HR_USER, db=self.db)
        self.assertEqual(e.exception.status_code, 403)
        self.assertEqual(len(self._live(WEEK[1])), 4)
        T.duplicate_day_undo(res["batchId"], user=HR_USER, db=self.db)
        self.assertEqual(self._live(WEEK[1]), [])
        with self.assertRaises(HTTPException) as e:
            T.duplicate_day_undo(res["batchId"], user=HR_USER, db=self.db)
        self.assertEqual(e.exception.status_code, 404)

    # -- which days ------------------------------------------------------------
    def test_all_working_days_skips_weekends_holidays_and_time_off(self):
        self.db.add(models.HrCompanyHoliday(id="h-dup", company_id="co-dup", date=WEEK[3], name="Founders Day"))
        self.db.add(models.TimeOffRequest(id="to-dup", employee_email=EMP, type="vacation", status="approved",
                                          start_date=WEEK[4], end_date=WEEK[4]))
        self.db.commit()
        plan = self._dup(source_date=WEEK[0], mode="working", start=WEEK[0], end="2026-10-11", dry_run=True)
        acts = {d["date"]: d["action"] for d in plan["days"]}
        self.assertEqual(acts, {WEEK[1]: "add", WEEK[2]: "add", WEEK[3]: "skip", WEEK[4]: "skip"})
        why = {d["date"]: d["reason"] for d in plan["days"]}
        self.assertIn("Founders Day", why[WEEK[3]])
        self.assertIn("time off", why[WEEK[4]].lower())
        # All Days takes the weekend (and the holiday) too, never the source day.
        every = self._dup(source_date=WEEK[0], mode="all", start=WEEK[0], end="2026-10-11", dry_run=True)
        self.assertEqual([d["date"] for d in every["days"] if d["action"] == "add"],
                         [WEEK[1], WEEK[2], WEEK[3], WEEK[4], "2026-10-10", "2026-10-11"])

    def test_working_days_follow_the_persons_shift(self):
        self.db.add(models.Shift(id="s-dup", name="Tue-Thu", start_hhmm="08:30", end_hhmm="17:30", days="2,3,4"))
        self.db.add(models.ShiftAssignment(id="a-dup", employee_email=EMP, shift_id="s-dup"))
        self.db.add(models.ScheduledShift(id="ss-dup", employee_email=EMP, work_date="2026-10-10", start_hhmm="09:00",
                                          end_hhmm="13:00", published=1))   # a Saturday on the schedule
        self.db.commit()
        plan = self._dup(source_date=WEEK[0], mode="working", start=WEEK[0], end="2026-10-11", dry_run=True)
        self.assertEqual([d["date"] for d in plan["days"] if d["action"] == "add"],
                         [WEEK[1], WEEK[2], WEEK[3], "2026-10-10"])

    def test_locked_and_future_days_are_skipped(self):
        self.db.add(models.TimeApproval(id="f-dup", employee_email=EMP, kind="final", period_start=WEEK[4],
                                        period_end=WEEK[4], revoked=0))
        self.db.commit()
        plan = self._dup(source_date=WEEK[0], targets=[WEEK[4], "2026-12-01", WEEK[0]], dry_run=True)
        why = {d["date"]: (d["action"], d["reason"]) for d in plan["days"]}
        self.assertEqual(why[WEEK[4]][0], "skip")
        self.assertIn("finalized", why[WEEK[4]][1].lower())
        self.assertEqual(why["2026-12-01"], ("skip", "This day has not happened yet."))
        self.assertEqual(why[WEEK[0]], ("skip", "This is the day being copied."))

    def test_a_source_day_with_an_open_shift_is_refused(self):
        self._punch(WEEK[1], "in", f"{WEEK[1]}T15:30:00")
        self.db.commit()
        with self.assertRaises(HTTPException) as e:
            self._dup(source_date=WEEK[1], targets=[WEEK[2]], dry_run=True)
        self.assertEqual(e.exception.status_code, 400)

    def test_review_lock_is_respected_and_hr_edit_is_logged(self):
        self.db.add(models.TimesheetReview(id="r-dup", employee_email=EMP, period_start="2026-10-04",
                                           period_end="2026-10-17", pay_type="hourly", status="approved",
                                           rounds=[]))
        self.db.commit()
        self._dup(source_date=WEEK[0], targets=[WEEK[1], WEEK[2]])
        r = self.db.query(models.TimesheetReview).filter(models.TimesheetReview.id == "r-dup").one()
        self.assertEqual(r.status, "approved")   # HR edits at any point; the review keeps its place
        self.assertEqual([x.get("action") for x in r.rounds].count("hr_edited"), 1)   # one line per HR pass


if __name__ == "__main__":
    unittest.main()
