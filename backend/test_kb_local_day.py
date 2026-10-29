"""Knowledge Base due dates follow the person's own calendar day (WP 1.5,
Oct 29 2026): a Pacific employee is not a day overdue after 5 PM because the
UTC day flipped. Zone = their task email settings, else their company's (an
India company is on India time), else Pacific. ONE FILE PER PROCESS."""
import os
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_RATE_LIMIT", "off")

import database  # noqa: E402
import kb_core  # noqa: E402
import main  # noqa: E402, F401 - registers every model
import models  # noqa: E402

PAC = "pat.pacific@example.com"     # no settings, no company: Pacific
OWN = "ina.own@example.com"         # chose Asia/Kolkata in task email settings
IND = "ravi.india@example.com"      # works for the India company

# 10/29/2026 01:30 UTC = 10/28 6:30 PM in California = 10/29 7:00 AM in India
LATE_PACIFIC = datetime(2026, 10, 29, 1, 30, tzinfo=timezone.utc)


class _Frozen(datetime):
    at = LATE_PACIFIC

    @classmethod
    def now(cls, tz=None):
        return cls.at if tz is None else cls.at.astimezone(tz)


class KbLocalDayCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)
        db = database.SessionLocal()
        try:
            db.add(models.HrEntity(id="co-in", name="Greens India", country="IN"))
            for e, first, company in ((PAC, "Pat", ""), (OWN, "Ina", ""), (IND, "Ravi", "co-in")):
                db.add(models.NexusEmployee(id=f"e-{e}", first_name=first, last_name="Test", work_email=e, status="active",
                                            deleted_at="", company=company))
            db.add(models.TaskNotifyPref(email=OWN, prefs={"timezone": "Asia/Kolkata"}))
            db.add(models.KbCourse(id="c-1", title="Ladder Safety", status="published"))
            db.commit()
        finally:
            db.close()

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        kb_core._zones.clear()
        self.db = database.SessionLocal()
        self._clock = mock.patch.object(kb_core, "datetime", _Frozen)
        self._clock.start()

    def tearDown(self):
        self._clock.stop()
        self.db.close()

    def test_each_person_reads_their_own_day(self):
        self.assertEqual(kb_core.utc_day(), "2026-10-29")
        self.assertEqual(kb_core.today(), "2026-10-28")                  # the organization's day is Pacific
        self.assertEqual(kb_core.today_for(self.db, PAC), "2026-10-28")
        self.assertEqual(kb_core.today_for(self.db, OWN), "2026-10-29")  # their own setting
        self.assertEqual(kb_core.today_for(self.db, IND), "2026-10-29")  # their company is in India
        self.assertEqual(kb_core.today_for(self.db, ""), "2026-10-28")

    def test_due_today_is_not_overdue_in_the_evening(self):
        c = self.db.query(models.KbCourse).filter(models.KbCourse.id == "c-1").first()
        st = kb_core.training_status(self.db, c, None, "2026-10-28", PAC)
        self.assertEqual(st["status"], "Not Started")      # UTC already says 10/29: it used to read 1 day overdue
        self.assertEqual(st["days_overdue"], 0)
        st = kb_core.training_status(self.db, c, None, "2026-10-28", IND)
        self.assertEqual((st["status"], st["days_overdue"]), ("Overdue", 1))

    def test_reminder_cadence_and_new_due_dates_use_the_persons_day(self):
        import kb_daily
        self.assertTrue(kb_daily._cadence_hit("2026-10-28", kb_core.today_for(self.db, PAC)))    # due day
        self.assertFalse(kb_daily._cadence_hit("2026-10-28", kb_core.today_for(self.db, IND)))   # a day late, not a week
        emp = self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == PAC).first()
        self.assertEqual(kb_daily._due_for(self.db, emp, 14), "2026-11-11")

    def test_a_bad_saved_zone_reads_as_pacific(self):
        row = self.db.query(models.TaskNotifyPref).filter(models.TaskNotifyPref.email == OWN).first()
        row.prefs = {"timezone": "Mars/Olympus"}
        self.db.commit()
        kb_core._zones.clear()
        self.assertEqual(kb_core.today_for(self.db, OWN), "2026-10-28")
        row.prefs = {"timezone": "Asia/Kolkata"}
        self.db.commit()


if __name__ == "__main__":
    unittest.main()
