"""Exempt from time tracking is a ROLE setting (Visesh, Oct 2).

The switch moved from People > Pay & Benefits (payroll_rates.time_tracking_exempt,
kept as a record but no longer read) to Settings > Access, beside the
screen-share exemption: nexus_groups.time_tracking_exempt. Exempt = no time
clock and no timesheet; everyone else keeps the normal clock.

Runs against its own throwaway SQLite database:
    python -m pytest test_time_tracking_exempt_role.py -q
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

import database  # noqa: E402
import models  # noqa: E402
import reminders  # noqa: E402
import timesheet_review as tsr  # noqa: E402
from routers import groups, hr, jobroles, timeclock  # noqa: E402

LEAD = "lead.tte@greensglobal.com"      # in a role flagged exempt
CREW = "crew.tte@greensglobal.com"      # in an unflagged role -> tracked
LEGACY = "legacy.tte@greensglobal.com"  # only the old pay-record flag -> tracked
GRP = "grp.tte@greensglobal.com"        # in a flagged plain access group
BOSS = "boss.tte@greensglobal.com"
ADMIN = {"email": "admin.tte@greensglobal.com", "role": "owner", "level": 5}
ROLE_MP, ROLE_CREW, GROUP_X = "jr-tte-mp", "jr-tte-crew", "grp-tte-x"
ANCHOR = (datetime.now(timezone.utc) - timedelta(days=40)).strftime("%Y-%m-%d")


class TimeTrackingExemptRole(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        actual = database.engine.url.database or ""
        assert os.path.abspath(actual) == os.path.abspath(_tmp_db.name), actual
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
        for m in (models.NexusGroupMember, models.NexusGroup, models.NexusEmployee, models.PayrollRate,
                  models.NexusNotification, models.TimesheetReview, models.HrEntity):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id="ent-tte", name="TTE Co", hr_contact_email="hr.tte@greensglobal.com"))
        for i, em in enumerate((LEAD, CREW, LEGACY, GRP, BOSS)):
            self.db.add(models.NexusEmployee(id=f"tte-{i}", work_email=em, first_name=f"P{i}", last_name="Test",
                                             company="ent-tte", status="active",
                                             manager_email="" if em == BOSS else BOSS))
            self.db.add(models.PayrollRate(employee_email=em, pay_type="hourly", hourly_rate=20,
                                           overtime_rule="ca", full_day_hours=8,
                                           time_tracking_exempt=1 if em == LEGACY else 0))
        self.db.add(models.NexusGroup(id=ROLE_MP, name="Managing Principal", is_job_role=1, tier="owner"))
        self.db.add(models.NexusGroup(id=ROLE_CREW, name="Crew", is_job_role=1, tier="employee"))
        self.db.add(models.NexusGroup(id=GROUP_X, name="Leadership Group", is_job_role=0))
        for gid, em in ((ROLE_MP, LEAD), (ROLE_CREW, CREW), (ROLE_CREW, LEGACY), (GROUP_X, GRP)):
            self.db.add(models.NexusGroupMember(group_id=gid, email=em))
        self.db.commit()
        # The flags are set the way Settings > Access sets them.
        out = jobroles.update_job_role(ROLE_MP, jobroles.JobRoleUpdate(time_tracking_exempt=True), user=ADMIN, db=self.db)
        self.assertTrue(out["time_tracking_exempt"])
        out = groups.update_group(GROUP_X, groups.GroupUpdate(time_tracking_exempt=True), user=ADMIN, db=self.db)
        self.assertTrue(out["time_tracking_exempt"])

    def tearDown(self):
        self.db.close()

    def test_resolver_follows_the_role_not_the_pay_record(self):
        self.assertTrue(timeclock.is_time_tracking_exempt(self.db, LEAD))
        self.assertTrue(timeclock.is_time_tracking_exempt(self.db, GRP))
        self.assertFalse(timeclock.is_time_tracking_exempt(self.db, CREW))
        self.assertFalse(timeclock.is_time_tracking_exempt(self.db, LEGACY))   # old flag ignored
        self.assertEqual(timeclock.time_tracking_exempt_via(self.db, LEAD), "Managing Principal")
        self.assertEqual(timeclock.time_tracking_exempt_emails(self.db), {LEAD, GRP})
        # Turning the role off makes its members tracked again.
        jobroles.update_job_role(ROLE_MP, jobroles.JobRoleUpdate(time_tracking_exempt=False), user=ADMIN, db=self.db)
        self.assertFalse(timeclock.is_time_tracking_exempt(self.db, LEAD))

    def test_status_and_my_timesheet_payloads(self):
        for em, want in ((LEAD, True), (CREW, False), (LEGACY, False)):
            st = timeclock.my_status(tz_offset_min=0, user={"email": em}, db=self.db)
            self.assertEqual(st["timeTrackingExempt"], want, em)
            me = timeclock.my_timesheet(start="", end="", user={"email": em}, db=self.db)
            self.assertEqual(me["timeTrackingExempt"], want, em)

    def test_payroll_team_rows_exclude_role_exempt(self):
        start, end = timeclock._pay_period(ANCHOR)
        for include_fixed in (False, True):
            rows = {r["email"] for r in timeclock._team_rows(self.db, start, end, include_fixed=include_fixed)}
            self.assertNotIn(LEAD, rows)
            self.assertNotIn(GRP, rows)
            self.assertIn(CREW, rows)
            self.assertIn(LEGACY, rows)

    def test_timesheet_submit_refused_for_exempt(self):
        with self.assertRaises(HTTPException) as e:
            tsr.submit(self.db, LEAD, ANCHOR)
        self.assertEqual(e.exception.status_code, 400)
        r = tsr.submit(self.db, LEGACY, ANCHOR)   # old flag alone does not exempt
        self.assertEqual(r.status, "with_manager")

    def test_sign_reminder_skips_role_exempt(self):
        # Freeze "today" at the day before a period ends so the nudge is due.
        _, pend = timeclock._pay_period(ANCHOR)
        frozen = datetime.strptime(pend, "%Y-%m-%d").replace(tzinfo=timezone.utc) - timedelta(days=1)

        class _Frozen(datetime):
            @classmethod
            def now(cls, tz=None):
                return frozen if tz else frozen.replace(tzinfo=None)

        real = reminders.datetime
        reminders.datetime = _Frozen
        try:
            reminders.run_daily_scan()
        finally:
            reminders.datetime = real
        self.db.expire_all()
        nudged = {n.recipient for n in self.db.query(models.NexusNotification)
                  .filter(models.NexusNotification.type == "timecard_sign").all()}
        self.assertIn(CREW, nudged)
        self.assertIn(LEGACY, nudged)
        self.assertNotIn(LEAD, nudged)
        self.assertNotIn(GRP, nudged)

    def test_profile_shows_the_role_and_pay_screens_no_longer_write_it(self):
        lead = self.db.query(models.NexusEmployee).filter_by(work_email=LEAD).first()
        f = hr.payroll_fields(self.db, lead)
        self.assertEqual((f["timeTrackingExempt"], f["timeTrackingExemptVia"]), (True, "Managing Principal"))
        crew = self.db.query(models.NexusEmployee).filter_by(work_email=CREW).first()
        f = hr.payroll_fields(self.db, crew)
        self.assertEqual((f["timeTrackingExempt"], f["timeTrackingExemptVia"]), (False, ""))
        # Pay & Benefits save with a stale timeTrackingExempt: ignored.
        crew.compensation = {"base": 20, "payBasis": "hourly", "currency": "USD", "timeTrackingExempt": True}
        hr.sync_rate_from_comp(self.db, crew)
        self.db.commit()
        row = self.db.query(models.PayrollRate).filter_by(employee_email=CREW).first()
        self.assertEqual(row.time_tracking_exempt or 0, 0)
        self.assertFalse(timeclock.is_time_tracking_exempt(self.db, CREW))
        # The wage editor still accepts the field from an old client, and drops it.
        self.assertTrue(timeclock.RateIn(email=CREW, time_tracking_exempt=True).time_tracking_exempt)
        with open(timeclock.__file__, encoding="utf-8") as fh:
            self.assertNotIn("row.time_tracking_exempt =", fh.read())


if __name__ == "__main__":
    unittest.main()
