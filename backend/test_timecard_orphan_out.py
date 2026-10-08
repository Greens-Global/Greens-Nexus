"""
A clock-out with no clock-in shows on the timecard (Oct 1).

The sign-off check (_period_exceptions -> out_without_in) blocked Agree with
"09/27/2026: a clock-out with no clock-in", but the timecard grid dropped that
punch, so the day looked empty - nothing on screen to add the in to or void.
Now the grid puts it on its day as "Missing -> out", flagged and counted, and
every day the check blocks has a flagged segment to fix. Pay is untouched: the
segment has no worked minutes and is not an open shift.

Uses a throwaway sqlite file.

    python -m unittest test_timecard_orphan_out
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database  # noqa: E402
import models  # noqa: E402
from routers.timeclock import _compute_timecard, _period_exceptions, _fixed_card  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

EMP = "orphan.out@greensglobal.com"
START, END = "2026-09-20", "2026-09-30"


def _punch(db, pid, kind, at):
    day = at[:10]
    db.add(models.TimePunch(id=pid, employee_email=EMP, kind=kind, at=at, local_date=day,
                            tz_offset_min=0, voided=0, created_at=at))


class OrphanOutTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TimePunch, models.PayrollRate, models.NexusEmployee):
            self.db.query(m).delete()
        self.db.add(models.NexusEmployee(id="e1", first_name="Orphan", last_name="Out", work_email=EMP,
                                         status="active", deleted_at=""))
        # The screenshot: Fri 09/25 two clock-ins (9:00, 9:23) then a 5:00 PM out;
        # Sun 09/27 a lone clock-out.
        _punch(self.db, "in-1", "in", "2026-09-25T09:00:00")
        _punch(self.db, "in-2", "in", "2026-09-25T09:23:00")
        _punch(self.db, "out-1", "out", "2026-09-25T17:00:00")
        _punch(self.db, "out-orphan", "out", "2026-09-27T17:05:00")
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _days(self, card):
        return {d["date"]: d for d in card["days"]}

    def test_the_lone_clock_out_shows_on_its_day(self):
        card = _compute_timecard(self.db, EMP, START, END)
        [seg] = self._days(card)["2026-09-27"]["segments"]
        self.assertEqual((seg["in"], seg["out"], seg["outId"], seg["workedMin"]),
                         ("", "2026-09-27T17:05:00", "out-orphan", 0))
        self.assertIn("out_without_in", seg["flags"])

    def test_every_day_that_blocks_agree_has_something_to_fix_on_the_card(self):
        card = _compute_timecard(self.db, EMP, START, END)
        days = self._days(card)
        blocking = {(e["date"], e["type"]) for e in _period_exceptions(self.db, EMP, START, END) if e["blocking"]}
        self.assertEqual(blocking, {("2026-09-25", "missing_out"), ("2026-09-27", "out_without_in")})
        for day, kind in blocking:
            flagged = [s for s in days[day]["segments"] if kind in (s.get("flags") or [])]
            self.assertTrue(flagged, f"{day} {kind} is not on the card")
        # Two missing punches - the 9:00 in that never closed, and the lone out.
        self.assertEqual(card["totals"]["missingPunches"], 2)

    def test_hours_and_pay_are_unchanged(self):
        with_orphan = _compute_timecard(self.db, EMP, START, END)["totals"]
        self.db.query(models.TimePunch).filter(models.TimePunch.id == "out-orphan").delete()
        self.db.commit()
        without = _compute_timecard(self.db, EMP, START, END)["totals"]
        for k in ("workedMin", "regMin", "otMin", "totalPay"):
            self.assertEqual(with_orphan[k], without[k], k)

    def test_a_clock_out_on_the_day_after_the_period_is_not_shown(self):
        _punch(self.db, "out-next", "out", "2026-10-01T08:00:00")
        self.db.commit()
        card = _compute_timecard(self.db, EMP, START, END)
        self.assertNotIn("2026-10-01", self._days(card))

    def test_a_fixed_salary_weekend_with_a_lone_out_earns_no_weekend_overtime(self):
        self.db.add(models.PayrollRate(employee_email=EMP, pay_type="fixed", monthly_salary=30000,
                                       weekend_ot_amount=1000))
        self.db.commit()
        card = _fixed_card(self.db, EMP, "2026-09-15")
        sun = next(d for d in card["fixedDays"] if d["date"] == "2026-09-27")
        self.assertEqual(sun["status"], "weekend")


if __name__ == "__main__":
    unittest.main()
