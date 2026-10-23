"""
The dashboard's My Open Tasks number (Neil, Oct 23 2026).

Charmi's tile read about 200: every open task she was on, most of them
repeating or months out. The number is now the work that is live -
in progress, overdue, or due in the next 30 days, and a repeating task once
its date has come - and the tile names the rest under it ("+x with no due
date", "+y recurring"). The manager's team-wide Open Tasks is unchanged.

Drives GET /dashboards/kpis itself (not a copy of its query) and the pure
rule in my_work.task_focus_bucket.

Throwaway sqlite. No network. Run ALONE: python -m pytest test_dashboard_task_focus.py
"""
import os
import tempfile
import unittest
import uuid
from unittest import mock

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import atexit

import cache
import database
import models
from routers import dashboards as D
from routers import my_work as MW

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


ME = "charmi@greensglobal.com"
OTHER = "neil@greensglobal.com"
USER = {"email": ME, "level": 1}
TODAY = "2026-10-23"


def _t(**kw):
    base = {"id": str(uuid.uuid4()), "title": "T", "code": "T-1", "assignee_email": ME, "assignee_emails": [ME],
            "status": "not_started", "created_at": "", "modified_at": ""}
    return models.Task(**{**base, **kw})


class RuleTests(unittest.TestCase):
    def b(self, **kw):
        return MW.task_focus_bucket(_t(**kw), TODAY)

    def test_one_off_tasks_count_when_overdue_or_due_within_30_days(self):
        self.assertEqual(self.b(due_on="2026-09-01"), "focus")          # overdue
        self.assertEqual(self.b(due_on="2026-10-23"), "focus")          # today
        self.assertEqual(self.b(due_on="2026-11-22"), "focus")          # day 30
        self.assertEqual(self.b(due_on="2026-11-23"), "later")          # day 31
        self.assertEqual(self.b(due_on="2026-11-22T17:00:00"), "focus")  # a timestamp's date part

    def test_no_due_date_is_named_not_counted(self):
        self.assertEqual(self.b(due_on=""), "undated")
        self.assertEqual(self.b(due_on="someday"), "undated")
        self.assertEqual(self.b(due_on=None), "undated")

    def test_in_progress_always_counts(self):
        self.assertEqual(self.b(status="in_progress", due_on=""), "focus")
        self.assertEqual(self.b(status="in_progress", due_on="2027-06-01"), "focus")
        self.assertEqual(self.b(status="in_progress", due_on="2027-06-01", recurrence={"freq": "weekly"}), "focus")

    def test_a_repeating_task_counts_once_its_date_has_come(self):
        weekly = {"freq": "weekly", "interval": 1}
        self.assertEqual(self.b(recurrence=weekly, due_on="2026-10-23"), "focus")
        self.assertEqual(self.b(recurrence=weekly, due_on="2026-10-20"), "focus")
        self.assertEqual(self.b(recurrence=weekly, due_on="2026-10-24"), "recurring")
        self.assertEqual(self.b(recurrence=weekly, due_on=""), "recurring")
        # The next occurrence carries status "recurring" (routers/tasks.py).
        self.assertEqual(self.b(status="recurring", due_on="2026-11-01"), "recurring")
        self.assertEqual(self.b(recurrence={}, due_on="2026-11-01"), "focus")   # no freq = one-off


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        self.db.query(models.Task).execution_options(include_deleted=True).delete()
        self.db.commit()
        cache.dashboard_kpis.invalidate()
        import auth
        p = mock.patch.object(auth, "_grants_for", lambda email, db: {})
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch.object(MW, "local_today", return_value=TODAY)
        p.start()
        self.addCleanup(p.stop)

    def add(self, **kw):
        t = _t(**kw)
        self.db.add(t)
        self.db.commit()
        return t

    def kpis(self, **kw):
        cache.dashboard_kpis.invalidate()
        return D.kpis(user={**USER, **kw.pop("user", {})}, db=self.db, **kw)["kpis"]

    def test_the_headline_and_the_two_footnotes(self):
        self.add(due_on="2026-10-01")                                   # overdue
        self.add(due_on="2026-11-05")                                   # inside 30 days
        self.add(due_on="2027-03-01")                                   # months out: nowhere
        self.add(status="in_progress", due_on="")                       # in progress, undated
        self.add(due_on="")                                             # undated
        self.add(due_on="")                                             # undated
        self.add(recurrence={"freq": "monthly"}, due_on="2026-10-23")   # repeating, due today
        self.add(recurrence={"freq": "monthly"}, due_on="2026-11-23")   # repeating, ahead
        self.add(status="recurring", due_on="2026-12-01")               # next occurrence, ahead
        k = self.kpis()
        self.assertEqual(k["my_open_tasks"], 4)
        self.assertEqual(k["my_open_tasks_undated"], 2)
        self.assertEqual(k["my_open_tasks_recurring"], 2)

    def test_only_my_open_live_tasks(self):
        self.add(due_on="2026-10-23", assignee_email=OTHER, assignee_emails=[OTHER])
        self.add(due_on="2026-10-23", assignee_email=OTHER, assignee_emails=[OTHER, ME])  # second assignee
        self.add(due_on="2026-10-23", completed=True)
        self.add(due_on="2026-10-23", deleted_at="2026-10-01T00:00:00")
        self.add(due_on="2026-10-23", type="section")
        k = self.kpis()
        self.assertEqual(k["my_open_tasks"], 1)

    def test_the_callers_day_is_the_browsers(self):
        self.add(due_on="2026-10-23")
        self.kpis(tz_offset_min=300)
        MW.local_today.assert_called_with(300)

    def test_the_cache_is_per_day(self):
        self.add(recurrence={"freq": "weekly"}, due_on="2026-10-24")
        cache.dashboard_kpis.invalidate()
        self.assertEqual(D.kpis(user=USER, db=self.db)["kpis"]["my_open_tasks"], 0)
        MW.local_today.return_value = "2026-10-24"       # midnight passes inside the 20 s cache
        self.assertEqual(D.kpis(user=USER, db=self.db)["kpis"]["my_open_tasks"], 1)

    def test_the_team_figure_is_unchanged(self):
        self.add(due_on="")
        self.add(due_on="2027-06-01", assignee_email=OTHER, assignee_emails=[OTHER])
        self.add(due_on="2026-10-23", completed=True)
        k = self.kpis(scope="team", user={"level": 3})
        self.assertEqual(k["open_tasks"], 2)


if __name__ == "__main__":
    unittest.main()
