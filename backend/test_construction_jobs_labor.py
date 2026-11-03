"""Construction phase 2 - crews and labor (Neil, 11/03/2026, plan
https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr).

Pins:
  * an IN punch written by any path is stamped with the jobsite of that
    person-day's live placement (one placement; several - the one holding
    the punch time; a cancelled or removed one never; none = ''), and
    `category` is never touched (the leave rule reads it);
  * hours per day and person from the stamped pairs, less breaks; voided
    punches and leave pairs left out;
  * a job reviewer sees everyone's hours, the crew only their own; the
    answer never carries pay (no rate, cost or pay key);
  * This Week's Crew from the planner (published, live placements only);
  * walls: another company's job is a 404.

Run: python -m pytest test_construction_jobs_labor.py -q
"""
import os
import tempfile

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ.pop("ANTHROPIC_API_KEY", None)

import construction_labor   # noqa: E402
import models               # noqa: E402
from construction_jobs_testkit import (CREW, CREW2, MGR_A, MGR_B, JobsBase, iso)  # noqa: E402

DAY = "2026-11-02"   # a Monday
PAY_WORDS = ("rate", "cost", "pay", "wage", "amount")


class Labor(JobsBase):
    tmp_db = _tmp.name

    def _shift(self, sid, email, jobsite, start="07:00", end="15:30", day=DAY, **kw):
        self.db.add(models.ScheduledShift(id=sid, employee_email=email, work_date=day, start_hhmm=start,
                                          end_hhmm=end, published=kw.pop("published", 1), pending_delete=0, jobsite=jobsite,
                                          weather_status=kw.pop("weather_status", ""), break_min=30,
                                          created_at=iso(), **kw))

    def _punch(self, pid, email, kind, at, day=DAY, category="", voided=0):
        # PST is UTC-8 in November: tz_offset_min = 480.
        p = models.TimePunch(id=pid, employee_email=email, kind=kind, at=at, local_date=day, tz_offset_min=480,
                             category=category, voided=voided, created_at=iso())
        self.db.add(p)
        return p

    def test_an_in_punch_is_stamped_from_the_days_placement_and_category_is_untouched(self):
        self._shift("s1", CREW, "project-pa")
        self.db.commit()
        self._punch("in1", CREW, "in", "2026-11-02T15:02:00+00:00", category="Framing")
        self._punch("out1", CREW, "out", "2026-11-02T23:30:00+00:00")
        self.db.commit()
        p = self.fresh(models.TimePunch, "in1")
        self.assertEqual(p.jobsite, "project-pa")
        self.assertEqual(p.category, "Framing")
        self.assertEqual(self.fresh(models.TimePunch, "out1").jobsite, "")   # only the IN punch carries it

    def test_several_placements_pick_the_one_holding_the_punch_time(self):
        self._shift("s1", CREW, "project-pa", start="06:00", end="10:00")
        self._shift("s2", CREW, "project-pb", start="12:00", end="16:00")
        self.db.commit()
        self._punch("in-am", CREW, "in", "2026-11-02T14:05:00+00:00")   # 06:05 local
        self._punch("in-pm", CREW, "in", "2026-11-02T20:10:00+00:00")   # 12:10 local
        self.db.commit()
        self.assertEqual(self.fresh(models.TimePunch, "in-am").jobsite, "project-pa")
        self.assertEqual(self.fresh(models.TimePunch, "in-pm").jobsite, "project-pb")

    def test_a_cancelled_or_unpublished_placement_never_stamps(self):
        self._shift("s1", CREW, "project-pa", weather_status="cancelled")
        self._shift("s2", CREW2, "project-pa", published=0)
        self.db.commit()
        self._punch("a", CREW, "in", "2026-11-02T15:00:00+00:00")
        self._punch("b", CREW2, "in", "2026-11-02T15:00:00+00:00")
        self.db.commit()
        self.assertEqual(self.fresh(models.TimePunch, "a").jobsite, "")
        self.assertEqual(self.fresh(models.TimePunch, "b").jobsite, "")

    def _day_of_work(self):
        self._shift("s1", CREW, "project-pa")
        self._shift("s2", CREW2, "project-pa")
        self.db.commit()
        # CREW: 07:00 - 15:30 with a 30 minute break = 8 h.
        self._punch("c-in", CREW, "in", "2026-11-02T15:00:00+00:00")
        self._punch("c-bs", CREW, "break_start", "2026-11-02T19:00:00+00:00")
        self._punch("c-be", CREW, "break_end", "2026-11-02T19:30:00+00:00")
        self._punch("c-out", CREW, "out", "2026-11-02T23:30:00+00:00")
        # CREW2: 4 h, plus a voided pair and a sick pair that never count.
        self._punch("d-in", CREW2, "in", "2026-11-02T15:00:00+00:00")
        self._punch("d-out", CREW2, "out", "2026-11-02T19:00:00+00:00")
        self._punch("v-in", CREW2, "in", "2026-11-02T20:00:00+00:00", voided=1)
        self._punch("v-out", CREW2, "out", "2026-11-02T22:00:00+00:00", voided=1)
        self.db.commit()
        sick = self._punch("k-in", CREW2, "in", "2026-11-03T16:00:00+00:00", day="2026-11-03", category="Sick Day")
        sick.jobsite = "project-pa"
        self._punch("k-out", CREW2, "out", "2026-11-03T20:00:00+00:00", day="2026-11-03")
        self.db.commit()

    def test_hours_by_day_and_person_for_a_reviewer_and_never_pay(self):
        self._day_of_work()
        self.as_(MGR_A)
        r = self.client.get("/construction/projects/pa/labor")
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual(out["byPerson"], {CREW: 8.0, CREW2: 4.0})
        self.assertEqual(out["byDay"], {DAY: 12.0})
        self.assertEqual(out["total"], 12.0)
        self.assertFalse(out["ownOnly"])
        flat = repr(out).lower()
        for w in PAY_WORDS:
            self.assertNotIn(f"'{w}", flat)

    def test_the_crew_sees_only_their_own_hours(self):
        self._day_of_work()
        self.as_(CREW2)
        out = self.client.get("/construction/projects/pa/labor").json()
        self.assertEqual(out["byPerson"], {CREW2: 4.0})
        self.assertTrue(out["ownOnly"])

    def test_this_weeks_crew_comes_from_the_planner(self):
        self._shift("s1", CREW, "project-pa")
        self._shift("s2", CREW, "project-pa", day="2026-11-03")
        self._shift("s3", CREW2, "project-pa", weather_status="cancelled")
        self._shift("s4", MGR_A, "project-pa", day="2026-11-12")       # next week
        self.db.commit()
        from datetime import date
        crew = construction_labor.crew_this_week(self.db, self.fresh(models.ConstructionProject, "pa"), date(2026, 11, 4))
        self.assertEqual((crew["weekStart"], crew["weekEnd"]), ("2026-11-02", "2026-11-08"))
        self.assertEqual([(c["email"], c["days"], c["plannedHours"]) for c in crew["people"]],
                         [(CREW, ["2026-11-02", "2026-11-03"], 16.0)])

    def test_another_company_never_sees_the_hours(self):
        self._day_of_work()
        self.as_(MGR_B)
        self.assertEqual(self.client.get("/construction/projects/pa/labor").status_code, 404)
        self.assertEqual(self.client.get("/construction/projects/pa/crew").status_code, 404)


if __name__ == "__main__":
    import unittest
    unittest.main()
