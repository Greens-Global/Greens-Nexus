"""Managers review their reports' timesheets WITHOUT the People module
(Pranshu, 10/06).

Access follows the reporting line: the manager a timesheet was submitted to
may open that employee's timecard for that period, Agree / Send Back, and
change the hours while it is with them - and sees hours only, never pay.
Other managers, the employee, and strangers get nothing; HR and admins keep
their access and see pay.

Run with: python -m unittest test_timesheet_manager_review -v
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException  # noqa: E402

import cache  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
import timesheet_review as tsr  # noqa: E402
from routers import timeclock  # noqa: E402
from routers import timesheet_reviews as TR  # noqa: E402

EMP, MGR, OTHER, HR = "erin@greensglobal.com", "sam@greensglobal.com", "olga@greensglobal.com", "hana@greensglobal.com"
# The manager is a SUPERVISOR - below manager level, no People grant.
MGR_USER = {"email": MGR, "role": "supervisor", "level": 2}
OTHER_USER = {"email": OTHER, "role": "manager", "level": 3}
HR_USER = {"email": HR, "role": "administrator", "level": 4}
EMP_USER = {"email": EMP, "role": "employee", "level": 1}
ANCHOR = (datetime.now(timezone.utc) - timedelta(days=40)).strftime("%Y-%m-%d")


def _keys(o):
    if isinstance(o, dict):
        return set(o) | set().union(*(_keys(v) for v in o.values())) if o else set()
    if isinstance(o, list):
        return set().union(*(_keys(v) for v in o)) if o else set()
    return set()


class ManagerReviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TimesheetReview, models.TimePunch, models.TimeApproval, models.NexusEmployee,
                  models.PayrollRate, models.AuditLog, models.NexusNotification, models.PunchRequest):
            self.db.query(m).delete()
        for email, first, mgr in ((EMP, "Erin", MGR), (MGR, "Sam", ""), (OTHER, "Olga", ""), (HR, "Hana", "")):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=email, first_name=first, last_name="Test",
                                             manager_email=mgr, status="active"))
        self.db.add(models.PayrollRate(employee_email=EMP, pay_type="hourly", currency="USD", hourly_rate=25,
                                       full_day_hours=8, overtime_rule="federal"))
        self.start, self.end = timeclock._pay_period(ANCHOR)
        for kind, hhmm in (("in", "16:00:00"), ("out", "23:00:00")):
            self.db.add(models.TimePunch(id=f"p-{kind}", employee_email=EMP, kind=kind, at=f"{self.start}T{hhmm}",
                                         local_date=self.start, tz_offset_min=0, created_at=f"{self.start}T{hhmm}"))
        self.db.commit()
        cache.module_grants.invalidate()
        self.r = tsr.submit(self.db, EMP, ANCHOR, "All in")

    def tearDown(self):
        self.db.close()

    def test_the_manager_sees_the_hours_but_never_the_pay(self):
        card = TR.review_timecard(self.r.id, user=MGR_USER, db=self.db)
        self.assertTrue(card["payHidden"])
        self.assertEqual(card["employeeName"], "Erin Test")
        self.assertEqual(card["totals"]["workedMin"], 420)                 # 7h worked
        self.assertTrue(card["canEdit"])
        self.assertTrue(card["review"]["canAgree"])
        leaked = _keys(card) & TR.PAY_KEYS
        self.assertEqual(leaked, set(), f"pay fields reached the manager: {leaked}")
        audit = self.db.query(models.AuditLog).filter_by(action="timesheet_review_viewed").one()
        self.assertEqual((audit.user_email, audit.resource_id), (MGR, self.r.id))

    def test_a_salaried_employees_card_hides_salary_deductions_and_bonuses(self):
        self.db.query(models.PayrollRate).delete()
        self.db.add(models.PayrollRate(employee_email=EMP, pay_type="fixed", currency="INR", monthly_salary=90000,
                                       full_day_hours=9))
        self.db.query(models.TimesheetReview).delete()
        self.db.commit()
        r = tsr.submit(self.db, EMP, ANCHOR, "Month done")
        card = TR.review_timecard(r.id, user=MGR_USER, db=self.db)
        self.assertEqual(card["payType"], "fixed")
        self.assertEqual(_keys(card) & TR.PAY_KEYS, set())
        self.assertIn("workedMin", _keys(card))

    def test_hr_and_admins_still_see_pay(self):
        card = TR.review_timecard(self.r.id, user=HR_USER, db=self.db)
        self.assertNotIn("payHidden", card)
        self.assertGreater(card["totals"]["totalPay"], 0)

    def test_a_manager_level_role_without_the_people_grant_sees_no_pay(self):
        # Olga manages Erin now (People record) - still hours only.
        self.db.query(models.NexusEmployee).filter_by(work_email=EMP).update({"manager_email": OTHER})
        self.db.commit()
        card = TR.review_timecard(self.r.id, user=OTHER_USER, db=self.db)
        self.assertTrue(card["payHidden"])

    def test_strangers_the_employee_and_other_managers_get_nothing(self):
        for who in (OTHER_USER, EMP_USER, {"email": "x@greensglobal.com", "role": "employee", "level": 1}):
            with self.assertRaises(HTTPException) as cm:
                TR.review_timecard(self.r.id, user=who, db=self.db)
            self.assertEqual(cm.exception.status_code, 404, who["email"])

    def test_the_manager_agrees_and_sends_back_without_a_manager_role(self):
        TR.send_back(self.r.id, TR.NoteIn(note="Tuesday lunch is missing"), user=MGR_USER, db=self.db)
        self.db.expire_all()
        self.assertEqual(tsr.active_review(self.db, EMP, self.start).status, "with_employee")
        with self.assertRaises(HTTPException) as cm:                       # someone else's report
            TR.send_back(self.r.id, TR.NoteIn(note="x"), user=OTHER_USER, db=self.db)
        self.assertEqual(cm.exception.status_code, 404)

    def test_the_manager_edits_hours_only_while_it_is_with_them(self):
        user = timeclock.require_team_write_or_reviewer(user=MGR_USER, db=self.db)
        self.assertTrue(user["_review_only"])
        timeclock.adjust_punch("p-out", timeclock.PunchAdjust(at=f"{self.start}T23:30:00", adjust_note="left late"),
                               user=user, db=self.db)
        self.db.expire_all()
        self.assertEqual(self.db.get(models.TimePunch, "p-out").at, f"{self.start}T23:30:00")
        timeclock.manager_add_punch(timeclock.ManagerPunchIn(employee_email=EMP, kind="break_start",
                                                             at=f"{self.start}T19:00:00", note="lunch"),
                                    user=user, db=self.db)
        timeclock.set_timecard_note(timeclock.TimecardNoteIn(email=EMP, date=self.start, note="Lunch added"),
                                    user=user, db=self.db)
        # Outside the reviewed period: refused.
        with self.assertRaises(HTTPException) as cm:
            timeclock.manager_add_punch(timeclock.ManagerPunchIn(employee_email=EMP, kind="in",
                                                                 at="2020-01-02T09:00:00"),
                                        user=user, db=self.db)
        self.assertEqual(cm.exception.status_code, 403)
        # Sent back to the employee: the manager can no longer change it.
        TR.send_back(self.r.id, TR.NoteIn(note="check Tuesday"), user=MGR_USER, db=self.db)
        with self.assertRaises(HTTPException):
            timeclock.require_team_write_or_reviewer(user=MGR_USER, db=self.db)

    def test_a_supervisor_with_nothing_to_review_cannot_edit_anyone(self):
        TR.send_back(self.r.id, TR.NoteIn(note="check"), user=MGR_USER, db=self.db)
        with self.assertRaises(HTTPException) as cm:
            timeclock.require_team_write_or_reviewer(user=MGR_USER, db=self.db)
        self.assertEqual(cm.exception.status_code, 401)

    def test_my_teams_timesheets_lists_history_and_who_has_not_submitted(self):
        out = TR.my_team(user=MGR_USER, db=self.db)
        self.assertEqual([(r["name"], r["status"]) for r in out["reviews"]], [("Erin Test", "with_manager")])
        self.assertNotIn("totalPay", _keys(out))
        cur_start, _e, _pt = tsr.period_for(self.db, EMP, "")
        self.assertEqual([(p["employeeEmail"], p["periodStart"]) for p in out["notSubmitted"]], [(EMP, cur_start)])
        self.assertEqual(TR.my_team(user=OTHER_USER, db=self.db), {"reviews": [], "notSubmitted": []})

    def test_the_managers_bell_opens_the_review_in_workday(self):
        n = (self.db.query(models.NexusNotification)
             .filter(models.NexusNotification.recipient == MGR).order_by(models.NexusNotification.created_at.desc()).first())
        self.assertIsNotNone(n)
        self.assertIn(f'"review": "{self.r.id}"', n.action or "")
        self.assertIn('"view": "timeclock"', n.action or "")


if __name__ == "__main__":
    unittest.main()
