"""Compensation report at a realistic size (CR-02, Oct 23 2026: Jan-Sep 2026
"never finished loading"). 60 people (45 hourly, 15 salaried) with nine
months of punches - breaks, overnight shifts, sick days, located punches, a
mid-year raise, a finalized period, a holiday, a pending punch fix, idle
frames, a leaver - priced the old way (the engine card by card, ~26 round
trips a person-month) and the new way (read_memo + the range preloads).

The figures must be IDENTICAL - the speed-up is only fewer reads, never a
second pay calculation - and the new pass must stay inside its round-trip
budget. Prints both so a regression shows its size.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_accounting_compensation_load.py -q -s
"""
import json
import os
import tempfile
import time
import unittest
import uuid
from datetime import date, timedelta

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from sqlalchemy import event  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
import read_memo  # noqa: E402
from routers import accounting_compensation as ac  # noqa: E402
from routers import timeclock  # noqa: E402
from routers.accounting_allocations import _people_and_cards  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

HOURLY, FIXED = 45, 15
MONTHS = [f"2026-{m:02d}" for m in range(1, 10)]
# The new pass may spend this many round trips per person-month (it measured
# ~1 when written; the old pass ~26).
BUDGET_PER_PERSON_MONTH = 2


def _seed():
    db = database.SessionLocal()
    try:
        db.add(models.HrEntity(id="c1", name="Greens Global", country="US"))
        db.add(models.HrEntity(id="c2", name="Greens India", country="IN"))
        db.add(models.HrCompanyHoliday(id=str(uuid.uuid4()), company_id="c1", date="2026-07-03", name="Independence Day"))
        db.add(models.HrCompanyHoliday(id=str(uuid.uuid4()), company_id="c2", date="2026-08-15", name="Independence Day"))
        punches = []
        for i in range(HOURLY + FIXED):
            em = f"load{i}.comp@greensglobal.com"
            fixed = i >= HOURLY
            status, log = ("active", [])
            if i == 3:   # left in April: on the roster through April only
                status, log = "offboarded", [{"to": "offboarded", "effectiveDate": "2026-04-20"}]
            db.add(models.NexusEmployee(id=str(uuid.uuid4()), first_name=f"Load{i}", last_name="Comp", work_email=em,
                                        company="c2" if fixed else "c1", department=("Accounts" if fixed else "Maintenance"),
                                        country="IN" if fixed else "US", start_date="2024-01-01", status=status, status_log=log,
                                        job_title="Technician"))
            db.add(models.PayrollRate(employee_email=em, hourly_rate=20 + i % 7, pay_type="fixed" if fixed else "hourly",
                                      currency="INR" if fixed else "USD", monthly_salary=90000 + 1000 * i if fixed else 0,
                                      overtime_rule="none" if fixed else ("federal" if i % 5 == 0 else "ca")))
            if i % 9 == 1:   # a raise effective 06/15
                for eff, rate in (("", 20 + i % 7), ("2026-06-15", 27 + i % 7)):
                    db.add(models.PayrollRateHistory(id=str(uuid.uuid4()), employee_email=em, effective_date=eff, pay_type="hourly",
                                                     hourly_rate=rate, currency="USD", overtime_rule="ca", created_at=f"2026-01-0{1 + bool(eff)}"))
            d = date(2026, 1, 1)
            while d <= date(2026, 9, 30):
                if i == 3 and d > date(2026, 4, 17):
                    break
                ds = d.isoformat()
                off = -330 if fixed else 420
                if d.weekday() < 5 and (d.day + i) % 23:
                    sick = (d.day + i) % 31 == 0
                    late = i % 4   # some 10-hour days: daily overtime under the CA rule
                    times = (("in", f"{ds}T16:0{i % 6}:00Z"), ("break_start", f"{ds}T20:00:00Z"), ("break_end", f"{ds}T20:3{i % 3}:00Z"),
                             ("out", f"{(d + timedelta(days=1)).isoformat()}T0{1 + late}:1{i % 5}:00Z"))
                    for k, at in times:
                        if sick and k.startswith("break"):
                            continue
                        punches.append(dict(id=str(uuid.uuid4()), employee_email=em, kind=k, at=at, local_date=ds,
                                            tz_offset_min=off, voided=0, source="web", category="Sick Day" if sick and k == "in" else "",
                                            lat="33.1" if i % 3 == 0 else "", lng="-117.1" if i % 3 == 0 else ""))
                elif d.weekday() == 5 and i % 6 == 0:   # a Saturday shift
                    punches.append(dict(id=str(uuid.uuid4()), employee_email=em, kind="in", at=f"{ds}T17:00:00Z", local_date=ds, tz_offset_min=off, voided=0, source="web"))
                    punches.append(dict(id=str(uuid.uuid4()), employee_email=em, kind="out", at=f"{ds}T22:00:00Z", local_date=ds, tz_offset_min=off, voided=0, source="web"))
                d += timedelta(days=1)
            if i % 10 == 2:   # February finalized at a pinned rate
                db.add(models.TimeApproval(id=str(uuid.uuid4()), employee_email=em, period_start="2026-02-01", period_end="2026-02-28",
                                           kind="final", revoked=0, approved_at="2026-03-02T00:00:00Z",
                                           note=json.dumps({"rate": 31.5, "rule": "federal"})))
            if i % 15 == 4:
                db.add(models.PunchRequest(id=str(uuid.uuid4()), employee_email=em, action="add", punch_kind="in",
                                           at="2026-05-04T16:00:00Z", local_date="2026-05-04", status="pending", reason="missed"))
                db.add(models.TimeScreenshot(id=str(uuid.uuid4()), employee_email=em, at="2026-05-05T17:00:00Z",
                                             local_date="2026-05-05", idle_sec=600))
        db.commit()
        db.bulk_insert_mappings(models.TimePunch, punches)
        db.commit()
        return len(punches)
    finally:
        db.close()


class LoadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.punches = _seed()

    def _counted(self, fn):
        n = [0]

        def tick(*_a, **_k):
            n[0] += 1
        db = database.SessionLocal()
        event.listen(database.engine, "before_cursor_execute", tick)
        try:
            t0 = time.monotonic()
            out = fn(db)
            return out, n[0], time.monotonic() - t0
        finally:
            event.remove(database.engine, "before_cursor_execute", tick)
            db.close()

    def test_nine_months_same_figures_far_fewer_round_trips(self):
        titles = lambda db: {(e.work_email or "").lower(): (e.job_title or "") for e in db.query(models.NexusEmployee).all()}  # noqa: E731
        old, old_q, old_s = self._counted(lambda db: ac.summarize([(m, *_people_and_cards(db, m)) for m in MONTHS], titles(db)))
        new, new_q, new_s = self._counted(lambda db: ac._people_sync(db, MONTHS))
        people = HOURLY + FIXED
        print(f"\n[compensation] {people} people x {len(MONTHS)} months, {self.punches} punches: "
              f"old {old_q} queries in {old_s:.1f}s, new {new_q} queries in {new_s:.1f}s")
        coverage = new.pop("coverage")
        self.assertEqual(new, old, "the same engine must give the same figures")
        self.assertEqual(len(new["people"]), people)
        self.assertGreater(sum(p["wages"] for p in new["people"]), 0)
        self.assertEqual(coverage["roster"], people)
        self.assertEqual(coverage["ratesSet"], people)
        self.assertLessEqual(new_q, people * len(MONTHS) * BUDGET_PER_PERSON_MONTH)
        self.assertLess(new_q * 10, old_q, "at least ten times fewer round trips")

    def test_a_commit_mid_pass_keeps_the_figures(self):
        """Time Clock creates a missing monitoring policy on first read and
        commits: the preloads are dropped and the readers go back to the
        database - same figures."""
        two = MONTHS[:2]
        db = database.SessionLocal()
        try:
            old = ac.summarize([(m, *_people_and_cards(db, m)) for m in two], {})
        finally:
            db.close()
        db = database.SessionLocal()
        try:
            db.query(models.MonitoringPolicy).delete()
            db.commit()
            new = ac._people_sync(db, two)
            self.assertGreater(db.query(models.MonitoringPolicy).count(), 0, "the pass did commit")
            self.assertNotIn(timeclock._RANGE_PRELOAD, db.info)
        finally:
            db.close()
        new.pop("coverage")
        for p in new["people"]:
            p["title"] = ""
        self.assertEqual(new, old)

    def test_deadline_stops_the_pass(self):
        db = database.SessionLocal()
        try:
            with self.assertRaises(ac.TooSlow):
                ac._people_sync(db, MONTHS, deadline=time.monotonic() - 1)
            self.assertNotIn(timeclock._RANGE_PRELOAD, db.info, "the preload is cleared on the way out")
        finally:
            db.close()

    def test_memo_is_dropped_on_commit(self):
        db = database.SessionLocal()
        try:
            em = "load0.comp@greensglobal.com"
            with read_memo.memoized(db) as stats:
                q = lambda: db.query(models.PayrollRate).filter(models.PayrollRate.employee_email == em).first().hourly_rate  # noqa: E731
                before = q()
                q()
                self.assertEqual(stats["hits"], 1)
                db.query(models.PayrollRate).filter(models.PayrollRate.employee_email == em).update({"hourly_rate": 99.0})
                db.commit()
                misses = stats["misses"]
                self.assertEqual(q(), 99.0, "a write inside the block is never answered from before it")
                self.assertEqual(stats["misses"], misses + 1, "the commit dropped the memo, so the read went to the database")
            db.query(models.PayrollRate).filter(models.PayrollRate.employee_email == em).update({"hourly_rate": before})
            db.commit()
        finally:
            db.close()

    def test_preloaded_readers_match_the_database(self):
        db = database.SessionLocal()
        try:
            em = "load2.comp@greensglobal.com"
            plain = ([p.id for p in timeclock._live_punches(db, em, "2026-02-01", "2026-03-01")],
                     getattr(timeclock._finalized_row(db, em, "2026-02-01", "2026-02-28"), "id", None),
                     getattr(timeclock._finalized_row(db, em, "2026-01-01", "2026-01-31"), "id", None))
            timeclock.preload_range(db, "2026-02-01", "2026-03-01")
            try:
                pre = ([p.id for p in timeclock._live_punches(db, em, "2026-02-01", "2026-03-01")],
                       getattr(timeclock._finalized_row(db, em, "2026-02-01", "2026-02-28"), "id", None),
                       getattr(timeclock._finalized_row(db, em, "2026-01-01", "2026-01-31"), "id", None))
            finally:
                timeclock.clear_range_preload(db)
            self.assertEqual(pre, plain)
            self.assertIsNotNone(plain[1])
            em4 = "load4.comp@greensglobal.com"
            timeclock.preload_range(db, "2026-05-01", "2026-06-01")
            try:
                self.assertEqual(timeclock._idle_frame_count(db, em4, "2026-05-01", "2026-05-31"), 1)
                self.assertEqual(len(timeclock._pending_punch_requests(db, em4, "2026-05-01", "2026-05-31")), 1)
            finally:
                timeclock.clear_range_preload(db)
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
