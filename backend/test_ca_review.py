"""California Review (Neil, Oct 18 2026) - ca_review.py.

  * each rule fires, and does not fire, on its own facts (pure functions);
  * a non-CA employee produces nothing, whatever their time looks like;
  * resolve / reopen, and a resolved flag opening again when its facts change;
  * HR only: managers and employees are refused;
  * Payroll Readiness shows the open count as information, never blocking.

Runs on test_timesheet_review's throwaway database.
    python -m pytest test_ca_review.py -q
"""
import os
import unittest

from test_timesheet_review import ReviewCase, EMP, MGR, HR, ANCHOR, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import auth  # noqa: E402
import ca_review as cr  # noqa: E402
import models  # noqa: E402
import payroll_readiness as pr  # noqa: E402
from routers import timeclock  # noqa: E402

D = "2026-09-16"


def day(ds=D, reg=480, ot=0, dt=0, rate=20.0, segments=None, ws="2026-09-13", meal=None):
    d = {"date": ds, "weekStart": ws, "regMin": reg, "otMin": ot, "dtMin": dt, "workedMin": reg + ot + dt,
         "rate": rate, "segments": segments or []}
    if meal:
        d["meal"] = meal
    return d


def seg(a, b, ds=D):
    return {"in": f"{ds}T{a}:00", "out": f"{ds}T{b}:00", "flags": [], "payClass": "", "deductedMin": 0, "breaks": []}


class P:
    def __init__(self, **kw):
        self.id, self.source, self.note, self.adjust_note, self.edit_reason = "p1", "web", "", "", ""
        self.adjusted_by, self.edit_status, self.local_date = "", "", D
        self.__dict__.update(kw)


class RuleTests(unittest.TestCase):
    def test_meal_and_waiver(self):
        meal = {"chip": "Meal Missed", "label": "No 30-minute meal break", "issues": [{"meal": 1, "status": "missed"}],
                "workMin": 330}
        f = cr.meal_flags([day(segments=[seg("08:00", "13:30")], meal=meal)], [])
        self.assertEqual([x["rule"] for x in f], ["meal", "waiver"])      # a waiver would have covered 5.5 h
        f = cr.meal_flags([day(segments=[seg("08:00", "16:00")], meal=meal)], [])
        self.assertEqual([x["rule"] for x in f], ["meal"])                # 8 h: a waiver would not help
        self.assertEqual(cr.meal_flags([day(segments=[seg("08:00", "16:00")])], []), [])

    def test_seventh_day(self):
        week = [day(f"2026-09-{13 + i:02d}") for i in range(7)]
        f = cr.seventh_day_flags(week)
        self.assertEqual([(x["rule"], x["date"]) for x in f], [("seventh_day", "2026-09-19")])
        week[6] = day("2026-09-19", reg=0, ot=480, dt=60)
        self.assertEqual(cr.seventh_day_flags(week), [])
        self.assertEqual(cr.seventh_day_flags([day(f"2026-09-{13 + i:02d}") for i in range(6)]), [])

    def test_long_days(self):
        self.assertEqual([x["rule"] for x in cr.long_day_flags([day(reg=480, ot=240, dt=60)])], [])
        self.assertEqual([x["rule"] for x in cr.long_day_flags([day(reg=480, ot=300, dt=0)])], ["dt_missing"])
        self.assertEqual(sorted(x["rule"] for x in cr.long_day_flags([day(reg=480, ot=240, dt=300)])), ["over16"])
        self.assertEqual(cr.long_day_flags([day(reg=600)]), [])

    def test_split_shift(self):
        self.assertEqual([x["rule"] for x in cr.split_shift_flags([day(segments=[seg("08:00", "12:00"), seg("13:30", "17:00")])])],
                         ["split_shift"])
        self.assertEqual(cr.split_shift_flags([day(segments=[seg("08:00", "12:00"), seg("13:00", "17:00")])]), [])

    def test_reporting_time(self):
        self.assertEqual([x["rule"] for x in cr.reporting_flags([day(reg=180)], {D: 480})], ["reporting"])
        self.assertEqual(cr.reporting_flags([day(reg=240)], {D: 480}), [])
        self.assertEqual(cr.reporting_flags([], {D: 480}), [])           # did not report: not reporting time

    def test_min_wage(self):
        self.assertEqual([x["rule"] for x in cr.min_wage_flags([day(rate=15.0)], 16.90, D)], ["min_wage"])
        self.assertEqual(cr.min_wage_flags([day(rate=16.90)], 16.90, D), [])
        self.assertEqual(cr.min_wage_flags([day(rate=0)], 16.90, D), [])  # no rate is Readiness' job

    def test_manual_time(self):
        self.assertEqual([x["rule"] for x in cr.manual_time_flags([P(source="manual")])], ["manual_time"])
        self.assertEqual([x["rule"] for x in cr.manual_time_flags([P(source="self_manual", note="payroll edit")])],
                         ["manual_time"])
        self.assertEqual([x["rule"] for x in cr.manual_time_flags([P(adjusted_by="m@x")])], ["manual_time"])
        self.assertEqual(cr.manual_time_flags([P(source="manual", adjust_note="Forgot to punch")]), [])
        self.assertEqual(cr.manual_time_flags([P()]), [])

    def test_attestation(self):
        class R:
            period_start, status, sign_request_id, updated_at = D, "with_manager", "", ""
            rounds = [{"action": "reopened", "breakClaims": [{"date": D, "kind": "meal"}], "at": "x"}]
        self.assertEqual([x["rule"] for x in cr.attestation_flags(R())], ["attest_no"])
        R.rounds, R.status, R.sign_request_id = [], "signing", "env1"
        self.assertEqual([x["rule"] for x in cr.attestation_flags(R())], ["attest_pending"])
        R.rounds = [{"action": "break_attested", "envelope": "env1"}]
        self.assertEqual(cr.attestation_flags(R()), [])
        self.assertEqual(cr.attestation_flags(None), [])


class ReviewQueueTests(ReviewCase):
    def setUp(self):
        super().setUp()
        for mdl in (models.CaReviewResolution, models.TimeBreakPremium, models.CaMealWaiver):
            self.db.query(mdl).delete()
        self.db.query(models.NexusSetting).filter_by(key=cr.SETTINGS_KEY).delete()
        self.db.query(models.NexusRole).filter(models.NexusRole.email.in_([MGR, HR])).delete(synchronize_session=False)
        self.db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
        self.db.add(models.NexusRole(email=HR, role="administrator", assigned_by="test"))
        # The fixture day: 7 h with no break -> a missed meal.
        self.db.commit()
        auth.invalidate_role_cache()
        pr.clear_cache()
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        auth.invalidate_role_cache()
        super().tearDown()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _rate(self, rule, rate=20.0):
        self.db.query(models.PayrollRate).filter_by(employee_email=EMP).delete()
        self.db.add(models.PayrollRate(employee_email=EMP, pay_type="hourly", currency="USD", hourly_rate=rate,
                                       full_day_hours=8, overtime_rule=rule))
        self.db.commit()

    def _flags(self):
        self.db.expire_all()
        return cr.with_status(self.db, EMP, self.start, cr.flags_for(self.db, EMP, self.start, self.end))

    def test_non_ca_produces_nothing(self):
        for rule in ("federal", "none"):
            self._rate(rule, rate=10.0)        # below minimum wage, missed meal - still nothing
            self.assertEqual(self._flags(), [])
        self.db.query(models.PayrollRate).delete()
        self.db.commit()
        self.assertEqual(self._flags(), [])    # no rate on file: not classified

    def test_ca_flags_and_resolve_reopen_fingerprint(self):
        self._rate("ca", rate=15.0)
        f = {x["rule"]: x for x in self._flags()}
        self.assertEqual(set(f), {"meal", "min_wage"})
        self._as(HR)
        rep = self.client.get(f"/ca-review/report?start={self.start}")
        self.assertEqual(rep.status_code, 200, rep.text)
        self.assertEqual(rep.json()["openCount"], 2)
        r = self.client.post("/ca-review/resolve", json={"email": EMP, "periodStart": self.start,
                                                          "key": f["meal"]["key"], "note": ""})
        self.assertEqual(r.status_code, 422)
        r = self.client.post("/ca-review/resolve", json={"email": EMP, "periodStart": self.start,
                                                          "key": f["meal"]["key"], "note": "Paid the premium"})
        self.assertEqual(r.status_code, 200, r.text)
        st = {x["rule"]: x["status"] for x in self._flags()}
        self.assertEqual(st, {"meal": "resolved", "min_wage": "open"})
        # The facts change (a longer day): the flag opens again.
        self.db.query(models.TimePunch).filter(models.TimePunch.kind == "out").update({"at": f"{self.start}T23:30:00"})
        self.db.commit()
        g = {x["rule"]: x for x in self._flags()}
        self.assertEqual(g["meal"]["status"], "open")
        self.assertTrue(g["meal"]["changedSinceResolved"])
        # Resolve again, then Reopen.
        self.client.post("/ca-review/resolve", json={"email": EMP, "periodStart": self.start,
                                                      "key": g["meal"]["key"], "note": "Checked"})
        self.assertEqual({x["rule"]: x["status"] for x in self._flags()}["meal"], "resolved")
        r = self.client.post("/ca-review/reopen", json={"email": EMP, "periodStart": self.start, "key": g["meal"]["key"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual({x["rule"]: x["status"] for x in self._flags()}["meal"], "open")
        # A flag that is no longer raised cannot be resolved.
        r = self.client.post("/ca-review/resolve", json={"email": EMP, "periodStart": self.start,
                                                          "key": "over16:2000-01-01", "note": "x x x"})
        self.assertEqual(r.status_code, 404)

    def test_min_wage_setting(self):
        self._rate("ca", rate=17.0)
        self.assertNotIn("min_wage", {x["rule"] for x in self._flags()})
        self._as(HR)
        r = self.client.put("/ca-review/settings", json={"minWage": 18.0})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("min_wage", {x["rule"] for x in self._flags()})

    def test_hr_only(self):
        self._rate("ca")
        for who in (MGR, EMP):
            self._as(who)
            self.assertIn(self.client.get(f"/ca-review/report?start={self.start}").status_code, (401, 403), who)
            self.assertIn(self.client.post("/ca-review/resolve", json={"email": EMP, "periodStart": self.start,
                                                                        "key": "x", "note": "abc"}).status_code,
                          (401, 403), who)
            self.assertIn(self.client.put("/ca-review/settings", json={"minWage": 1}).status_code, (401, 403), who)

    def test_payroll_readiness_shows_the_count_as_info(self):
        self._rate("ca")
        rows = {r["email"]: r for r in pr.build(self.db, None, ANCHOR)["rows"]}
        exc = rows[EMP]["exceptions"]
        ca = [x for x in exc if x["type"].startswith("ca_")]
        self.assertEqual({x["type"] for x in ca}, {"ca_meal", "ca_review"})
        self.assertFalse(any(x["blocking"] for x in ca))
        # Same readiness verdict as without them.
        self.assertEqual(rows[EMP]["ready"], not any(x["blocking"] for x in exc if not x["type"].startswith("ca_")))
        # The manager tier's copy (hours only) never carries the review's count.
        hidden = pr.strip_pay(pr.build(self.db, None, ANCHOR))
        types = {x["type"] for r in hidden["rows"] for x in r["exceptions"]}
        self.assertNotIn("ca_review", types)
        self.assertIn("ca_meal", types)
        pr.clear_cache()
        self._rate("federal")
        rows = {r["email"]: r for r in pr.build(self.db, None, ANCHOR)["rows"]}
        self.assertFalse([x for x in rows[EMP]["exceptions"] if x["type"].startswith("ca_")])

    def test_card_based_rules_read_the_engine(self):
        # Seven days in a row, 9 h each, in one workweek: the engine applies
        # 7th-day overtime, so no seventh_day flag - and no dt_missing.
        self._rate("ca")
        self.db.query(models.TimePunch).delete()
        ws = timeclock._week_start_str(self.start)
        base = timeclock.datetime.strptime(ws, "%Y-%m-%d")
        for i in range(7):
            ds = (base + timeclock.timedelta(days=i)).strftime("%Y-%m-%d")
            self._punch(ds, "in", "14:00:00")
            self._punch(ds, "break_start", "17:00:00")
            self._punch(ds, "break_end", "17:30:00")
            self._punch(ds, "out", "23:30:00")
        self.db.commit()
        rules = {x["rule"] for x in self._flags()}
        self.assertNotIn("seventh_day", rules)
        self.assertNotIn("dt_missing", rules)


if __name__ == "__main__":
    unittest.main()
