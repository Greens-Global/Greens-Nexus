"""
People > Time Action Log (Neil, Oct 6).

Punch requests and missing punches are one list, filterable by department, so
both lists carry each person's name and department. A shift that is still
running has no clock-out because it has not ended - the list must not call it
a missing punch ("she's working today, this should not pop up"). A shift left
open past the 16-hour guard still is one.

Uses a throwaway sqlite file.

    python -m unittest test_action_log
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database  # noqa: E402
import models  # noqa: E402
from routers.timeclock import list_exceptions, list_punch_requests  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

ADMIN = {"email": "log.admin@greensglobal.com", "level": 4}
WORKING = "log.working@greensglobal.com"
FORGOT = "log.forgot@greensglobal.com"


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


class ActionLogTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TimePunch, models.PunchRequest, models.NexusEmployee):
            self.db.query(m).delete()
        for i, (em, fn, dept) in enumerate(((WORKING, "Amy", "Operations"), (FORGOT, "Nick", "Construction"))):
            self.db.add(models.NexusEmployee(id=f"e{i}", first_name=fn, last_name="Test", work_email=em,
                                             department=dept, status="active", deleted_at=""))
        now = datetime.now(timezone.utc)
        # Amy clocked in two hours ago and is still working.
        self._punch("p1", WORKING, "in", now - timedelta(hours=2))
        # Nick clocked in 30 hours ago and never clocked out.
        self._punch("p2", FORGOT, "in", now - timedelta(hours=30))
        self.db.add(models.PunchRequest(id="r1", employee_email=FORGOT, employee_name="Nick Test", action="add",
                                        punch_kind="out", at=_iso(now - timedelta(hours=22)),
                                        local_date=_iso(now - timedelta(hours=22))[:10], reason="forgot",
                                        status="pending", created_at=_iso(now)))
        self.db.commit()
        self.start = (now - timedelta(days=3)).date().isoformat()
        self.end = (now + timedelta(days=1)).date().isoformat()

    def tearDown(self):
        self.db.close()

    def _punch(self, pid, em, kind, dt):
        self.db.add(models.TimePunch(id=pid, employee_email=em, kind=kind, at=_iso(dt), local_date=_iso(dt)[:10],
                                     tz_offset_min=0, voided=0, created_at=_iso(dt)))

    def test_running_shift_is_not_missing(self):
        out = list_exceptions(self.start, self.end, user=ADMIN, db=self.db)
        emails = [r["email"] for r in out]
        self.assertNotIn(WORKING, emails)
        self.assertIn(FORGOT, emails)

    def test_rows_carry_name_and_department(self):
        row = next(r for r in list_exceptions(self.start, self.end, user=ADMIN, db=self.db) if r["email"] == FORGOT)
        self.assertEqual(row["name"], "Nick Test")
        self.assertEqual(row["department"], "Construction")
        self.assertEqual(row["exceptions"][0]["type"], "missing_out")
        reqs = list_punch_requests("pending", user=ADMIN, db=self.db)
        self.assertEqual([(r["id"], r["department"]) for r in reqs], [("r1", "Construction")])


if __name__ == "__main__":
    unittest.main()
