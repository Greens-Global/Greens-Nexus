"""timesheet_review.not_reviewed stays cheap for a Super Administrator (11/05/2026).

It walked every active person with no approver - ~20 queries each, 10 s on
dev and minutes on prod - even when nobody had hours to review. Two bulk
reads (punch days, existing reviews) now skip people with no punches before
any per-person lookup. This pins: the same rows come back, and people with no
punches cost no queries of their own.

Run alone: python -m pytest test_timesheet_not_reviewed_load.py
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from sqlalchemy import event  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
import timesheet_review as tsr  # noqa: E402

BOSS = "boss@greensglobal.com"
WORKER = "worker@greensglobal.com"


class NotReviewedLoadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self._launch, tsr.REVIEW_LAUNCH = tsr.REVIEW_LAUNCH, "2000-01-01"
        self.db = database.SessionLocal()
        db = self.db
        for m in (models.TimesheetReview, models.TimePunch, models.NexusEmployee, models.NexusRole, models.HrEntity):
            db.query(m).delete()
        db.add(models.HrEntity(id="co", name="Co"))
        db.add(models.NexusRole(email=BOSS, role="owner"))
        db.add(models.NexusEmployee(id="boss", work_email=BOSS, first_name="Boss", last_name="T",
                                    company="co", status="active"))
        db.add(models.NexusEmployee(id="w", work_email=WORKER, first_name="Will", last_name="T",
                                    company="co", status="active"))
        for i in range(30):   # nobody reviews them, and none of them punched
            db.add(models.NexusEmployee(id=f"e{i}", work_email=f"idle{i}@greensglobal.com", first_name=f"I{i}",
                                        last_name="T", company="co", status="active"))
        db.commit()
        start, _end, _pt = tsr.closed_periods(db, WORKER, 1)[0]
        for kind, hhmm in (("in", "16:00:00"), ("out", "23:00:00")):
            db.add(models.TimePunch(id=f"p-{kind}", employee_email=WORKER, kind=kind, at=f"{start}T{hhmm}",
                                    local_date=start, tz_offset_min=0, created_at=f"{start}T{hhmm}"))
        db.commit()
        self.start = start

    def tearDown(self):
        tsr.REVIEW_LAUNCH = self._launch
        self.db.close()

    def _run(self):
        n = [0]

        def count(*_a):
            n[0] += 1
        event.listen(database.engine, "before_cursor_execute", count)
        try:
            rows = tsr.not_reviewed(self.db, BOSS)
        finally:
            event.remove(database.engine, "before_cursor_execute", count)
        return rows, n[0]

    def test_only_the_person_with_hours_is_listed(self):
        rows, _ = self._run()
        self.assertEqual([(r["employeeEmail"], r["periodStart"], r["notSubmitted"]) for r in rows],
                         [(WORKER, self.start, True)])

    def test_people_without_punches_cost_no_queries_of_their_own(self):
        self._run()   # warm the settings / role caches the first call fills
        _, with_idle = self._run()
        self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email.like("idle%")).delete(
            synchronize_session=False)
        self.db.commit()
        _, without_idle = self._run()
        # Under one query per idle person (the old walk: ~20 each - 622 vs 57 here).
        self.assertLess(with_idle, without_idle + 30)

    def test_a_reviewed_period_is_not_listed(self):
        self.db.add(models.TimesheetReview(id="r1", employee_email=WORKER, period_start=self.start,
                                           period_end=self.start, status="completed"))
        self.db.commit()
        rows, _ = self._run()
        self.assertEqual(rows, [])


if __name__ == "__main__":
    unittest.main()
