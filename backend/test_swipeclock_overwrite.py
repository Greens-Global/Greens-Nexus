"""SwipeClock replaces the Nexus punches through 10/16/2026 and the periods
close out (tools/swipeclock_overwrite.py, Charmi 11/11/2026).

On test_timesheet_review's real-engine fixture (same throwaway database):
    python -m unittest test_swipeclock_overwrite
"""
import sys
import unittest
from pathlib import Path

from test_timesheet_review import ReviewCase, EMP, MGR, HR, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

sys.path.insert(0, str(Path(__file__).resolve().parent / "tools"))

import models  # noqa: E402
import timesheet_review as tsr  # noqa: E402
import swipeclock_overwrite as ow  # noqa: E402
from routers import timeclock  # noqa: E402

OLD = ("2026-09-20", "2026-10-03")
NEW = ("2026-10-04", "2026-10-17")


def _sw(day, hours, start="08:00:00"):
    h, m = int(start[:2]), int(start[3:5])
    in_at = f"{day}T{start}"
    end_min = h * 60 + m + int(hours * 60)
    out_at = f"{day}T{end_min // 60:02d}:{end_min % 60:02d}:00"
    return (in_at, out_at, day, 0, "", hours)


class OverwriteTests(ReviewCase):
    def setUp(self):
        super().setUp()
        self.db.query(models.TimeEntryBatch).delete()
        self.db.query(models.NexusRole).filter(models.NexusRole.email.in_([MGR, HR])).delete(synchronize_session=False)
        self.db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
        # Nexus: a short day in each period, a Nexus-only day, a day after --end.
        for day in ("2026-09-21", "2026-09-22", "2026-10-05", "2026-10-17"):
            self._punch(day, "in", "08:00:00")
            self._punch(day, "out", "10:00:00")
        self.db.commit()
        tsr.OUTSIDE_NEXUS_BEFORE = "2026-10-04"

    def tearDown(self):
        tsr.OUTSIDE_NEXUS_BEFORE = "2026-10-04"
        super().tearDown()

    def _live(self, day):
        self.db.expire_all()
        return self.db.query(models.TimePunch).filter(models.TimePunch.employee_email == EMP,
                                                      models.TimePunch.local_date == day,
                                                      models.TimePunch.voided == 0).all()

    def test_replaces_swipeclock_days_keeps_nexus_only_days_and_closes_out(self):
        timeclock.finalize_timecard(timeclock.FinalizeIn(email=EMP, start=NEW[0], end=NEW[1], allow_exceptions=True),
                                    user={"email": HR, "level": 4}, db=self.db)
        self.assertTrue(timeclock._finalized_row(self.db, EMP, *NEW))
        sw = {"2026-09-21": [_sw("2026-09-21", 8.0)], "2026-10-05": [_sw("2026-10-05", 7.5)],
              "2026-10-06": [_sw("2026-10-06", 6.0)], "2026-10-17": [_sw("2026-10-17", 9.0)]}

        info = ow.replace_person(self.db, EMP, sw, "2026-10-16", HR)
        self.db.commit()
        self.assertEqual(info["days"], ["2026-09-21", "2026-10-05", "2026-10-06"])
        self.assertIn("2026-09-22", info["nexusOnly"])          # Nexus only - kept
        self.assertNotIn("2026-10-17", info["days"])            # after --end - never touched
        self.assertEqual(info["unlocked"], [NEW])
        self.assertFalse(timeclock._finalized_row(self.db, EMP, *NEW))
        # SwipeClock's pair on the replaced days, Nexus kept elsewhere.
        self.assertEqual(sorted((p.kind, p.at) for p in self._live("2026-09-21")),
                         [("in", "2026-09-21T08:00:00"), ("out", "2026-09-21T16:00:00")])
        self.assertEqual(len(self._live("2026-09-22")), 2)
        self.assertEqual(sorted(p.at for p in self._live("2026-10-17")), ["2026-10-17T08:00:00", "2026-10-17T10:00:00"])
        gone = self.db.query(models.TimePunch).filter(models.TimePunch.replaced_by_batch == info["batch"]).all()
        self.assertEqual({p.local_date for p in gone}, {"2026-09-21", "2026-10-05"})
        self.assertTrue(all(p.voided == 1 for p in gone))
        # The batch is an ordinary Add Time From Record batch.
        b = self.db.query(models.TimeEntryBatch).filter(models.TimeEntryBatch.id == info["batch"]).first()
        self.assertEqual((b.kind, b.minutes), ("hr_record", int(21.5 * 60)))
        periods = {(s, e): (before, after) for s, e, before, after in info["periods"]}
        b_old, a_old = periods[OLD]
        self.assertEqual(a_old - b_old, 480 - 120)             # 09/21: 2h -> 8h
        b_new, a_new = periods[NEW]
        self.assertEqual(a_new - b_new, (450 - 120) + 360)     # 10/05: 2h -> 7.5h, 10/06: +6h

        todo = ow.close_out_list(self.db, {EMP: info})
        self.assertEqual({(em, s) for em, s, _e, _w in todo}, {(EMP, OLD[0]), (EMP, NEW[0])})
        tsr.OUTSIDE_NEXUS_BEFORE = "2026-10-18"
        for em, s, _e, _w in todo:
            tsr.close_out_outside_nexus(self.db, em, s, HR)
            self.db.commit()
        for s, e in (OLD, NEW):
            row = timeclock._finalized_row(self.db, EMP, s, e)
            self.assertTrue(row)
            self.assertEqual(row.worked_min, periods[(s, e)][1])
            self.assertEqual(tsr.active_review(self.db, EMP, s).rounds[-1]["note"], "Processed in SwipeClock before Nexus")

    def test_swipeclock_days_never_get_an_auto_lunch(self):
        # Ashley 09/14 (Charmi, 11/12/2026): 8:25-2:30 and 3:25-5:40 is 8h 20m in
        # SwipeClock; the 6h segment must not lose 30 minutes to the auto-lunch.
        import scoped_settings
        scoped_settings.save(self.db, timeclock._AUTOLUNCH_KEY, "",
                             {"enabled": True, "afterMin": 360, "deductMin": 30}, HR)
        self._punch("2026-09-23", "in", "08:00:00")
        self._punch("2026-09-23", "out", "15:00:00")       # a Nexus day: 7h, still deducted
        self.db.commit()
        sw = {"2026-09-21": [("2026-09-21T08:25:00", "2026-09-21T14:30:00", "2026-09-21", 0, "", 6.08),
                             ("2026-09-21T15:25:00", "2026-09-21T17:40:00", "2026-09-21", 0, "", 2.25)]}
        ow.replace_person(self.db, EMP, sw, "2026-10-16", HR)
        self.db.commit()
        card = timeclock._compute_timecard(self.db, EMP, *OLD)
        days = {d["date"]: d for d in card["days"]}
        self.assertEqual(days["2026-09-21"]["workedMin"], 365 + 135)
        self.assertEqual(days["2026-09-23"]["workedMin"], 420 - 30)

    def test_undo_restores_the_nexus_punches(self):
        sw = {"2026-09-21": [_sw("2026-09-21", 8.0)]}
        info = ow.replace_person(self.db, EMP, sw, "2026-10-16", HR)
        self.db.commit()
        timeclock.duplicate_day_undo(info["batch"], user={"email": HR, "level": 4, "role": "administrator"}, db=self.db)
        self.assertEqual(sorted(p.at for p in self._live("2026-09-21")), ["2026-09-21T08:00:00", "2026-09-21T10:00:00"])


if __name__ == "__main__":
    unittest.main()
