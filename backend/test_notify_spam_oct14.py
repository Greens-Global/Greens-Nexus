"""Less bell spam (Neil, Oct 14 2026: "it feels pretty spammy").

- One notice that grows instead of many that stack (notify_rollup).
- Timecard edits: one notice per person per day per recipient; Global Admins
  only for their own direct reports, or when no one else would hear.
- A report's Beginning and End of Day: ONE notice for the day, rewritten.
- Out-of-fence punches: one notice a day, the email with the first only.
- Tasks / Tickets: the main bell carries assignments, @mentions and
  approvals, plus every update to a ticket you raised.
- A forgotten clock-out: no 16-hour manager alert, the employee nudged once.

Run with: python -m pytest test_notify_spam_oct14.py
"""
import os
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import mock

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import database  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

from notify_rollup import upsert_rollup  # noqa: E402
from routers import timeclock  # noqa: E402
from routers import task_util  # noqa: E402
import timeclock_watch  # noqa: E402

EMP = "amy@example.com"
MGR = "visesh@example.com"
HR = "charmi@example.com"
OWNER = "neil@example.com"
OTHER = "dean@example.com"


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp.name)):
        raise RuntimeError(f"{__name__} is pointed at {actual!r}. Run it on its own.")


_assert_isolated()


class Base(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.NexusNotification, models.TaskNotification, models.NexusEmployee, models.NexusRole,
                  models.HrEntity, models.TimeBod, models.TimePunch, models.TaskTicket):
            self.db.query(m).execution_options(include_deleted=True).delete()
        self.db.add(models.HrEntity(id="co", name="Co", hr_contact_email=HR))
        self.db.add(models.NexusEmployee(id="e1", first_name="Amy", last_name="Lee", work_email=EMP,
                                         manager_email=MGR, company="co", status="active", deleted_at=""))
        self.db.add(models.NexusRole(email=OWNER, role="owner"))
        self.db.commit()

    def bells(self, who=None):
        q = self.db.query(models.NexusNotification)
        if who:
            q = q.filter(models.NexusNotification.recipient == who)
        return q.all()


class RollupTests(Base):
    def test_grows_in_place_newest_first_capped_and_unread_again(self):
        for i in range(8):
            upsert_rollup(self.db, recipient=MGR, key="k", title=f"T{i}", line=f"line {i}")
            self.db.commit()
            [row] = self.bells(MGR)
            row.read_by = MGR
            self.db.commit()
        [row] = self.bells(MGR)
        self.assertEqual(row.title, "T7")
        lines = row.body.split("\n")
        self.assertEqual(lines[0], "line 7")
        self.assertEqual(len(lines), 7)                   # six kept + the count
        self.assertEqual(lines[-1], "+ 2 earlier")
        upsert_rollup(self.db, recipient=MGR, key="k", title="T8", line="line 8")
        self.db.commit()
        self.assertEqual(self.bells(MGR)[0].read_by, "")
        self.assertEqual(self.bells(MGR)[0].body.split("\n")[-1], "+ 3 earlier")

    def test_twice_in_one_request_is_still_one_notice(self):
        self.assertTrue(upsert_rollup(self.db, recipient=MGR, key="k", title="A", line="1"))
        self.assertFalse(upsert_rollup(self.db, recipient=MGR, key="k", title="A", line="2"))
        self.db.commit()
        [row] = self.bells(MGR)
        self.assertEqual(row.body, "2\n1")


class TimecardEditTests(Base):
    def _edit(self, n, actor=OTHER, day="2026-10-13"):
        for i in range(n):
            timeclock._notify_timecard_change(self.db, employee_email=EMP, actor_email=actor,
                                              body=f"edit {i}", local_date=day)
        self.db.commit()

    def test_ten_edits_are_one_notice_each_for_the_manager_and_hr_and_none_for_global_admins(self):
        self._edit(10)
        self.assertEqual(sorted(b.recipient for b in self.bells()), [HR, MGR])
        for b in self.bells():
            self.assertEqual(b.title, "Timecard edited - Amy Lee")
            self.assertTrue(b.body.startswith("edit 9"))

    def test_another_day_is_another_notice(self):
        self._edit(2, day="2026-10-13")
        self._edit(1, day="2026-10-14")
        self.assertEqual(len(self.bells(MGR)), 2)

    def test_a_global_admin_hears_about_their_own_direct_report(self):
        e = self.db.query(models.NexusEmployee).first()
        e.manager_email = OWNER
        self.db.commit()
        self._edit(1)
        self.assertEqual(sorted(b.recipient for b in self.bells()), [HR, OWNER])

    def test_global_admins_are_the_last_resort_when_no_one_else_would_hear(self):
        self.db.query(models.HrEntity).delete()
        self.db.commit()
        self._edit(1, actor=MGR)          # the manager edited, no HR contact on file
        self.assertEqual([b.recipient for b in self.bells()], [OWNER])

    def test_the_employee_gets_one_notice_a_day_too(self):
        for i in range(3):
            timeclock._tell_employee_timecard(self.db, EMP, "2026-10-13", f"change {i}")
        self.db.commit()
        [b] = self.bells(EMP)
        self.assertEqual(b.title, "Your timecard was changed")
        self.assertEqual(b.body, "change 2\nchange 1\nchange 0")


class DayReportTests(Base):
    def _send(self, kind, msg, at):
        with mock.patch.object(timeclock, "_now_iso", return_value=at), \
             mock.patch.object(timeclock, "_shift_day", return_value="2026-10-14"), \
             mock.patch.object(timeclock, "_resolve_group_target", return_value={}):
            timeclock.record_bod(timeclock.BodIn(kind=kind, message=msg, tz_offset_min=420, sent=True),
                                 user={"email": EMP}, db=self.db)

    def test_beginning_then_end_of_day_is_one_notice_rewritten(self):
        self._send("bod", "Starting on the Georgetown signage.", "2026-10-14T15:02:00")
        [b] = self.bells(MGR)
        self.assertEqual(b.title, "Beginning of Day - Amy Lee")
        self.assertEqual(b.body, "Beginning of Day, 8:02 AM: Starting on the Georgetown signage.")
        b.read_by = MGR
        self.db.commit()
        self._send("eod", "Signage installed.", "2026-10-15T00:31:00")
        [b] = self.bells(MGR)
        self.assertEqual(b.title, "End of Day - Amy Lee")
        self.assertEqual(b.body, "Beginning of Day, 8:02 AM: Starting on the Georgetown signage.\n"
                                 "End of Day, 5:31 PM: Signage installed.")
        self.assertEqual(b.read_by, "")


class OutOfFenceTests(Base):
    def test_one_notice_a_day_and_the_email_only_with_the_first(self):
        emp = self.db.query(models.NexusEmployee).first()
        geo = {"work_site_name": "Georgetown", "distance_m": 900}
        # The email step starts by asking whether mail is set up - reached for
        # the first punch of the day only.
        with mock.patch("graph_mail.graph_configured", return_value=False) as mail:
            for kind, at in (("in", "2026-10-14T15:00:00"), ("out", "2026-10-14T19:00:00"), ("in", "2026-10-14T20:00:00")):
                row = SimpleNamespace(id=str(uuid.uuid4()), kind=kind, at=at, tz_offset_min=420, local_date="2026-10-14")
                timeclock._notify_out_of_fence(self.db, emp, row, geo)
                self.db.commit()
        [b] = self.bells(MGR)
        self.assertEqual(b.title, "Out-of-fence punches - Amy Lee")
        self.assertEqual(len(b.body.split("\n")), 3)
        self.assertEqual(mail.call_count, 1)


class TaskBellTests(Base):
    def _tn(self, kind, to=OTHER, **kw):
        task_util.task_notify(self.db, kind=kind, for_email=to, title=kind, **kw)
        self.db.commit()

    def test_only_what_needs_you_reaches_the_main_bell(self):
        for k in ("task_activity", "ticket_comment", "task_due_changed", "ticket_status"):
            self._tn(k)
        self.assertEqual(self.bells(), [])
        self.assertEqual(self.db.query(models.TaskNotification).count(), 4)   # the module bell has them all
        for k in ("task_assigned", "ticket_needs_approval"):
            self._tn(k)
        self._tn("task_activity", main_bell=True)                             # an @mention
        self.assertEqual(sorted(b.type for b in self.bells()), ["task_task_activity", "task_task_assigned", "task_ticket_needs_approval"])

    def test_the_person_who_raised_a_ticket_hears_every_update(self):
        self.db.add(models.TaskTicket(id="t1", code="27", subject="Printer", requester_email=OTHER))
        self.db.commit()
        self._tn("ticket_updated", ticket_id="t1")
        self._tn("ticket_updated", to=MGR, ticket_id="t1")                     # not the requester
        self.assertEqual([b.recipient for b in self.bells()], [OTHER])


class ForgottenClockOutTests(Base):
    def test_no_manager_alert_and_the_employee_is_nudged_once(self):
        t0 = (datetime.now(timezone.utc) - timedelta(hours=17)).strftime("%Y-%m-%dT%H:%M:%S")
        self.db.add(models.TimePunch(id="p1", employee_email=EMP, kind="in", at=t0, local_date=t0[:10],
                                     tz_offset_min=0, voided=0, created_at=t0))
        self.db.commit()
        with mock.patch.object(timeclock_watch, "_email"):
            timeclock_watch._scan_once()
            timeclock_watch._scan_once()
        self.db.expire_all()
        self.assertEqual([b.recipient for b in self.bells()], [EMP])


if __name__ == "__main__":
    unittest.main()
