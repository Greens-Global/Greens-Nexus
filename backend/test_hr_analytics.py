"""People Analytics (Neil, Oct 27 2026) - hr_analytics.py and
routers/hr_analytics.py. One small fixture drives every metric: a mid-month
joiner and leaver, a rehire, a leaver with no reason, a leaver whose UTC
change time falls in the next month on India time, a contractor, a person
with no start date, a Left person with no change entry, a future starter, a
guest, and leave balances in two currencies.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_hr_analytics.py -q
"""
import os
import tempfile
import unittest
from datetime import date

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import hr_analytics as ha  # noqa: E402
import leave_balances as lb  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
COA, COB = "ha-co-us", "ha-co-in"
TODAY = date(2026, 10, 27)
HR = "ha.hr" + D           # People grant, no hr_comp
PAY = "ha.pay" + D         # People + Compensation
SCOPED = "ha.scoped" + D   # People, limited to company A
MGR = "ha.mgr" + D         # manager tier: team-limited People


def _log(frm, to, at, eff="", reason=""):
    return {"from": frm, "to": to, "reason": reason, "effectiveDate": eff, "by": HR, "at": at}


def _emp(db, key, first, *, company=COA, etype="full_time", status="active", start="", log=None,
         created="2024-01-01T00:00:00+00:00", identity="internal", country="US", dept="Ops"):
    db.add(models.NexusEmployee(
        id=f"ha-{key}", first_name=first, last_name="Test", work_email=f"ha.{key}{D}", company=company,
        employment_type=etype, status=status, start_date=start, status_log=log or [], created_at=created,
        identity_type=identity, country=country, department=dept, deleted_at=""))


def _off(db, key, typ, start, end, created, status="approved", confidential=0, st="", et=""):
    db.add(models.TimeOffRequest(id=f"to-{key}", employee_email=f"ha.ann{D}", type=typ, start_date=start,
                                 end_date=end, status=status, created_at=created, confidential=confidential,
                                 start_time=st, end_time=et))


_SEQ = [0]


def _punch(db, kind, local_iso, cat=""):
    # Ann is on Pacific Daylight Time in September (UTC-7, JS offset 420).
    from datetime import datetime, timedelta
    _SEQ[0] += 1
    at = (datetime.strptime(local_iso, "%Y-%m-%dT%H:%M") + timedelta(hours=7)).strftime("%Y-%m-%dT%H:%M:%S")
    db.add(models.TimePunch(id=f"ha-p{_SEQ[0]:03d}", employee_email=f"ha.ann{D}", kind=kind, at=at,
                            local_date=local_iso[:10], tz_offset_min=420, voided=0, category=cat,
                            created_at=at, source="web", geo_status=""))


def seed(db):
    for m in (models.NexusEmployee, models.HrEntity, models.HrLifeEvent, models.HrChecklist, models.TimeOffRequest,
              models.TimePunch, models.PayrollRate, models.PayrollRateHistory, models.LeaveLedgerEntry,
              models.NexusSetting, models.NexusGroup, models.NexusGroupMember, models.NexusRole,
              models.NexusAccessScope):
        db.query(m).execution_options(include_deleted=True).delete(synchronize_session=False)
    db.add(models.HrEntity(id=COA, name="Greens US", country="US"))
    db.add(models.HrEntity(id=COB, name="Greens India", country="IN"))
    _emp(db, "ann", "Ann", start="2024-01-15")
    _emp(db, "ben", "Ben", start="2026-03-10", status="offboarded",
         log=[_log("active", "offboarded", "2026-06-20T22:00:00+00:00", "2026-06-20", "Voluntary Resignation - moving")])
    _emp(db, "cal", "Cal", etype="part_time", start="2025-06-01", status="offboarded",
         log=[_log("active", "offboarded", "2026-08-15T18:00:00+00:00", "2026-08-15", "Performance concerns")])
    db.add(models.HrLifeEvent(id="le-cal", kind="separation", employee_id="ha-cal", effective_date="2026-08-15",
                              inputs={"exit_type": "termination", "last_day": "2026-08-15"}, apply_status="applied"))
    # Dee: left with no reason, then rehired - her old start date is gone.
    _emp(db, "dee", "Dee", start="2026-04-15", created="2025-01-05T18:00:00+00:00",
         log=[_log("offboarded", "onboarding", "2026-04-01T17:00:00+00:00", "", "Rehired"),
              _log("active", "offboarded", "2025-12-31T23:00:00+00:00", "2025-12-31", "")])
    _emp(db, "eve", "Eve", etype="contractor", start="2026-02-01")
    _emp(db, "fay", "Fay")                                                      # no start date
    _emp(db, "gus", "Gus", start="2022-01-01", status="offboarded")              # Left, no change entry
    # Hal (India): marked Left at 20:00 UTC on 9/30 - already 10/01 in India.
    _emp(db, "hal", "Hal", company=COB, country="IN", start="2026-01-01", status="offboarded",
         log=[_log("active", "offboarded", "2026-09-30T20:00:00+00:00", "", "Job Abandonment")])
    _emp(db, "ivy", "Ivy", identity="guest", start="2025-01-01")                  # guest: never counted
    _emp(db, "jon", "Jon", status="onboarding", start="2026-11-05")               # starts next month
    _emp(db, "kim", "Kim", company=COB, country="IN", start="2023-10-01", dept="Finance")

    # Absence (Ann): vacation week in July with a matching vacation punch.
    _off(db, "vac-jul", "vacation", "2026-07-06", "2026-07-10", "2026-06-01T16:00:00+00:00")
    _punch(db, "in", "2026-07-08T08:00", "Vacation")
    _punch(db, "out", "2026-07-08T16:00")
    # August: confidential sick (counts as Other), a two-hour personal, a
    # Fri-Mon vacation (the weekend is not leave), Work From Home and a
    # pending request (neither counts).
    _off(db, "conf", "sick", "2026-08-03", "2026-08-03", "2026-07-20T16:00:00+00:00", confidential=1)
    _off(db, "pers", "personal", "2026-08-05", "2026-08-05", "2026-07-20T16:00:00+00:00", st="09:00", et="11:00")
    _off(db, "fri-mon", "vacation", "2026-08-07", "2026-08-10", "2026-07-20T16:00:00+00:00")
    _off(db, "wfh", "Work From Home", "2026-08-12", "2026-08-12", "2026-07-20T16:00:00+00:00")
    _off(db, "pend", "vacation", "2026-08-13", "2026-08-13", "2026-07-20T16:00:00+00:00", status="pending")
    # September: same-day sick (unplanned), sick filed ahead (planned), and a
    # half day on a Sick punch with no request (unplanned).
    _off(db, "sick-same", "sick", "2026-09-14", "2026-09-14", "2026-09-14T15:00:00+00:00")
    _off(db, "sick-ahead", "sick", "2026-09-21", "2026-09-21", "2026-09-18T15:00:00+00:00")
    _punch(db, "in", "2026-09-28T08:00", "Sick Day")
    _punch(db, "out", "2026-09-28T12:00")

    # Pay and leave balances: Ann USD hourly, Kim INR fixed, Fay no rate.
    db.add(models.PayrollRate(employee_email=f"ha.ann{D}", pay_type="hourly", hourly_rate=20.0,
                              overtime_rule="ca", currency="USD"))
    db.add(models.PayrollRate(employee_email=f"ha.kim{D}", pay_type="fixed", monthly_salary=52000.0,
                              overtime_rule="none", currency="INR"))

    # Access.
    db.add(models.NexusGroup(id="g-ha-hr", name="HA People", allowed_modules="hr:editor"))
    db.add(models.NexusGroup(id="g-ha-pay", name="HA Pay", allowed_modules="hr:editor,hr_comp:viewer"))
    for em in (HR, SCOPED, MGR):
        db.add(models.NexusGroupMember(group_id="g-ha-hr", email=em))
    db.add(models.NexusGroupMember(group_id="g-ha-pay", email=PAY))
    for em in (HR, PAY, SCOPED):
        db.add(models.NexusRole(email=em, role="supervisor", display_name=em))
    db.add(models.NexusRole(email=MGR, role="manager", display_name="Mgr"))
    db.add(models.NexusAccessScope(id="sc-ha", email=SCOPED, module_id="hr", scope_type="company", scope_id=COA))
    db.commit()
    lb.set_cutover(db, "2026-09-01", HR)
    db.commit()
    lb.set_opening(db, f"ha.ann{D}", vacation=40, sick=0, by=HR)
    lb.set_opening(db, f"ha.kim{D}", vacation=16, sick=0, by=HR)
    lb.set_opening(db, f"ha.fay{D}", vacation=8, sick=0, by=HR)
    db.commit()


class HrAnalyticsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        actual = database.engine.url.database or ""
        assert os.path.abspath(actual) == os.path.abspath(_tmp_db.name), actual
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self.db = database.SessionLocal()
        seed(self.db)
        cache.module_grants.invalidate()
        auth._role_cache.clear()

    def tearDown(self):
        self.db.close()
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)
        cache.module_grants.invalidate()
        auth._role_cache.clear()

    def ds(self, money=False, **kw):
        return ha.build(self.db, None, money, today=TODAY, **kw)

    def names(self, rows):
        return sorted(r["name"].split()[0] for r in rows)

    # ── spells ──
    def test_spells_for_a_rehire(self):
        log = [_log("offboarded", "onboarding", "2026-04-01T17:00:00+00:00", "", "Rehired"),
               _log("active", "offboarded", "2025-12-31T23:00:00+00:00", "2025-12-31", "")]
        s = ha.build_spells("onboarding", "2026-04-15", "2025-01-05T18:00:00+00:00", log, "America/Los_Angeles")
        self.assertEqual([(x["start"], x["end"], x["rehire"]) for x in s],
                         [("2025-01-05", "2025-12-31", False), ("2026-04-15", "", True)])
        self.assertEqual(s[0]["category"], "not_recorded")
        self.assertTrue(s[0]["estimated"])          # the record's creation, never a joiner
        self.assertFalse(s[1]["estimated"])

    def test_rehire_that_kept_the_old_start_date(self):
        log = [_log("offboarded", "active", "2026-04-01T17:00:00+00:00", "", "Rehired"),
               _log("active", "offboarded", "2025-12-31T23:00:00+00:00", "2025-12-31", "Retirement")]
        s = ha.build_spells("active", "2020-02-01", "2024-06-01T00:00:00+00:00", log, "America/Los_Angeles")
        self.assertEqual([(x["start"], x["end"]) for x in s], [("2020-02-01", "2025-12-31"), ("2026-04-01", "")])
        self.assertEqual(s[0]["category"], "voluntary")

    def test_no_start_date_is_never_the_created_date(self):
        s = ha.build_spells("active", "", "2026-06-01T00:00:00+00:00", [], "America/Los_Angeles")
        self.assertEqual(s, [{"start": "", "end": "", "rehire": False, "reason": "", "category": "",
                              "leftUndated": False, "estimated": False}])

    def test_left_without_a_change_entry_has_no_leaving_date(self):
        s = ha.build_spells("offboarded", "2022-01-01", "", [], "America/Los_Angeles")
        self.assertTrue(s[-1]["leftUndated"])
        self.assertFalse(ha.covers(s[-1], "2023-01-01"))

    def test_reason_labels_never_guess(self):
        self.assertEqual(ha.reason_from_label("Voluntary Resignation - moving"), "resignation")
        self.assertEqual(ha.reason_from_label("Resignation Without Notice"), "resignation_no_notice")
        self.assertEqual(ha.reason_from_label("Resignation"), "resignation")
        self.assertEqual(ha.reason_from_label("Job Abandonment"), "resignation_no_notice")
        self.assertEqual(ha.reason_from_label("End Of Contract - project done"), "end_of_contract")
        self.assertEqual(ha.reason_from_label("he resigned"), "")
        self.assertEqual(ha.reason_from_label("Terminated for cause"), "")
        self.assertEqual(ha.category_of(""), "not_recorded")
        self.assertEqual(ha.category_of("death"), "other")

    def test_life_event_wins_and_checklist_is_last(self):
        hint = [{"date": "2026-08-14", "exit_type": "termination"}]
        far = [{"date": "2026-01-01", "exit_type": "termination"}]
        self.assertEqual(ha.separation_reason("2026-08-15", "Retirement", hint, []), "termination")
        self.assertEqual(ha.separation_reason("2026-08-15", "Retirement", far, hint), "retirement")
        self.assertEqual(ha.separation_reason("2026-08-15", "notes", far, hint), "termination")
        self.assertEqual(ha.separation_reason("2026-08-15", "notes", far, []), "")

    def test_company_local_day(self):
        self.assertEqual(ha.local_day("2026-09-30T20:00:00+00:00", "Asia/Kolkata"), "2026-10-01")
        self.assertEqual(ha.local_day("2026-09-30T20:00:00+00:00", "America/Los_Angeles"), "2026-09-30")
        self.assertEqual(ha.local_day("2026-10-01T03:00:00", "America/Los_Angeles"), "2026-09-30")   # no zone = UTC
        self.assertEqual(ha.company_tz(self.db, COB), "Asia/Kolkata")
        self.assertEqual(ha.company_tz(self.db, COA), "America/Los_Angeles")

    # ── headcount ──
    def test_headcount_month_ends(self):
        out = ha.headcount(self.ds())
        hc = {m["month"]: m["total"] for m in out["months"]}
        self.assertEqual(hc, {"2025-11": 5, "2025-12": 5, "2026-01": 5, "2026-02": 5, "2026-03": 6, "2026-04": 7,
                              "2026-05": 7, "2026-06": 6, "2026-07": 6, "2026-08": 5, "2026-09": 5, "2026-10": 4})
        self.assertEqual(out["now"], 4)
        oct_ = out["months"][-1]
        self.assertEqual(oct_["asOf"], "2026-10-27")
        self.assertEqual({r["label"]: r["n"] for r in oct_["byCompany"]}, {"Greens US": 3, "Greens India": 1})
        self.assertEqual({r["label"]: r["n"] for r in oct_["byDepartment"]}, {"Ops": 3, "Finance": 1})

    def test_type_filter(self):
        self.assertEqual(ha.headcount(self.ds(type_filter="contractors"))["now"], 1)
        self.assertEqual(ha.headcount(self.ds(type_filter="all"))["now"], 5)

    def test_company_filter_and_scope(self):
        self.assertEqual(ha.headcount(self.ds(company=COB))["now"], 1)
        scoped = ha.build(self.db, {COA}, False, today=TODAY)
        self.assertEqual(ha.headcount(scoped)["now"], 3)

    # ── joiners and leavers ──
    def test_joiners_and_leavers(self):
        out = ha.flow(self.ds())
        per = {m["month"]: (m["joiners"], m["leavers"]) for m in out["months"]}
        self.assertEqual(per["2026-01"], (1, 0))       # Hal
        self.assertEqual(per["2026-03"], (1, 0))       # Ben, mid-month
        self.assertEqual(per["2026-04"], (1, 0))       # Dee's rehire
        self.assertEqual(per["2025-12"], (0, 1))       # Dee's first spell
        self.assertEqual(per["2026-06"], (0, 1))       # Ben
        self.assertEqual(per["2026-08"], (0, 1))       # Cal
        self.assertEqual(per["2026-09"], (0, 0))       # Hal left on India's 10/01, not UTC's 9/30
        self.assertEqual(per["2026-10"], (0, 1))
        self.assertEqual((out["joiners"], out["leavers"], out["rehires"]), (3, 4, 1))
        # Dee's first spell starts at her record's creation (01/05/2025): not a joiner.
        early = ha.flow(self.ds(from_month="2025-01", to_month="2025-01"))
        self.assertEqual(early["joiners"], 0)

    # ── attrition ──
    def test_attrition_rates(self):
        out = ha.attrition(self.ds())
        m = {r["month"]: r for r in out["months"]}
        self.assertEqual(m["2026-06"]["avgHeadcount"], 6.5)
        self.assertEqual(m["2026-06"]["rate"], 15.4)                  # 1 / 6.5
        self.assertEqual(m["2026-06"]["voluntaryRate"], 15.4)
        self.assertEqual(m["2026-08"]["involuntaryRate"], 18.2)       # 1 / 5.5
        self.assertEqual(m["2026-07"]["rate"], 0.0)
        self.assertEqual(m["2026-10"]["trailing12"], 72.2)            # 4 / mean(avg) 5.5417
        self.assertEqual(m["2026-10"]["trailing12Voluntary"], 36.1)   # Ben + Hal
        self.assertEqual(m["2026-10"]["trailing12Involuntary"], 18.0)  # Cal
        cats = {c["key"]: c["n"] for c in out["byCategory"]}
        self.assertEqual(cats, {"voluntary": 2, "involuntary": 1, "other": 0, "not_recorded": 1})

    # ── tenure ──
    def test_tenure_bands(self):
        out = ha.tenure(self.ds())
        bands = {b["key"]: b["n"] for b in out["bands"]}
        self.assertEqual(bands["2to5y"], 2)        # Ann, Kim
        self.assertEqual(bands["6to12m"], 1)       # Dee, from her rehire
        self.assertEqual(bands["unknown"], 1)      # Fay
        self.assertEqual(bands["lt6m"], 0)         # Jon has not started
        self.assertEqual(out["total"], 4)
        self.assertEqual(ha.tenure_band("2026-04-28", TODAY), "lt6m")
        self.assertEqual(ha.tenure_band("2025-10-27", TODAY), "1to2y")
        self.assertEqual(ha.tenure_band("2021-10-27", TODAY), "5yplus")

    # ── absence ──
    def test_absence_by_reason(self):
        out = ha.absence(self.ds())
        m = {r["month"]: r for r in out["months"]}
        self.assertEqual(m["2026-07"]["byReason"]["vacation"], 5)     # the punch day counts once
        self.assertEqual(m["2026-08"]["byReason"], {"vacation": 2, "sick": 0, "personal": 0.25, "other": 1})
        self.assertEqual(m["2026-09"]["byReason"]["sick"], 2.5)
        self.assertEqual(m["2026-09"]["unplannedSick"], 1.5)          # same-day request + the punch
        self.assertEqual(out["days"], 10.75)
        rows = ha.drill(self.ds(), "absence", "2026-09", "unplanned")["rows"]
        self.assertEqual(len(rows), 1)
        self.assertIn("1.5 days", rows[0]["detail"])
        self.assertIn("09/14/2026 - 09/28/2026", rows[0]["detail"])
        conf = ha.drill(self.ds(), "absence", "2026-08", "sick")["rows"]
        self.assertEqual(conf, [])                                    # the confidential request is not shown as sick

    # ── leave liability ──
    def test_liability_per_currency(self):
        out = ha.liability(self.ds(money=True))
        self.assertEqual(out["hours"], 144)                           # 40 + (16 + 80 India anniversary) + 8
        cur = {c["currency"]: c for c in out["byCurrency"]}
        self.assertEqual(cur["USD"]["amount"], 800)                   # 40 h x $20
        self.assertEqual(cur["INR"]["amount"], 28800)                 # 96 h x 52000 x 12 / 260 / 8
        self.assertEqual(out["noRate"], 1)                            # Fay
        self.assertEqual(ha.hourly_equivalent({"payType": "fixed", "monthlySalary": 52000}, 8), 300)

    def test_liability_without_compensation_is_hours_only(self):
        ds = self.ds(money=False)
        out = ha.liability(ds)
        self.assertEqual(out["hours"], 144)
        self.assertNotIn("byCurrency", out)
        self.assertNotIn("noRate", out)
        for r in ha.drill(ds, "liability")["rows"]:
            for k in ("amount", "rate", "currency"):
                self.assertNotIn(k, r)

    # ── drill-downs match the cards ──
    def test_drill_matches_the_numbers(self):
        ds = self.ds()
        self.assertEqual(self.names(ha.drill(ds, "headcount", "2026-04")["rows"]),
                         ["Ann", "Ben", "Cal", "Dee", "Fay", "Hal", "Kim"])
        self.assertEqual(self.names(ha.drill(ds, "headcount", "2026-10", "company:Greens India")["rows"]), ["Kim"])
        self.assertEqual(self.names(ha.drill(ds, "leavers", "", "not_recorded")["rows"]), ["Dee"])
        lv = ha.drill(ds, "leavers", "2026-08")["rows"]
        self.assertEqual(lv[0]["detail"], "Left 08/15/2026 - Involuntary (Termination)")
        self.assertNotIn("Performance", str(lv))                      # free text is never shown
        jn = ha.drill(ds, "joiners", "2026-04")["rows"]
        self.assertEqual(jn[0]["detail"], "Started 04/15/2026 (Rehire)")
        self.assertEqual(self.names(ha.drill(ds, "tenure", "", "unknown")["rows"]), ["Fay"])
        with self.assertRaises(ValueError):
            ha.drill(ds, "salaries")

    def test_data_quality(self):
        self.assertEqual(ha.data_quality(self.ds()), {"noStartDate": 1, "leftUndated": 1})

    def test_range_is_clamped(self):
        ds = self.ds(from_month="2020-01", to_month="2027-05")
        self.assertEqual(ds.months[-1], "2026-10")
        self.assertEqual(len(ds.months), ha.MAX_MONTHS)

    # ── API ──
    def _get(self, path, who):
        os.environ["NEXUS_DEV_EMAIL"] = who
        return self.client.get(path)

    def test_api_money_needs_compensation(self):
        r = self._get("/hr/analytics/summary", HR)
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertFalse(body["canSeeMoney"])
        self.assertNotIn("byCurrency", body["liability"])
        self.assertEqual({c["id"] for c in body["companies"]}, {COA, COB})
        r = self._get("/hr/analytics/people?metric=liability", HR)
        self.assertNotIn("amount", str(r.json()))
        r = self._get("/hr/analytics/summary?parts=liability", PAY)
        self.assertTrue(r.json()["canSeeMoney"])
        self.assertIn("byCurrency", r.json()["liability"])
        self.assertNotIn("headcount", r.json())

    def test_api_company_scope(self):
        r = self._get("/hr/analytics/summary?parts=headcount", SCOPED)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([c["id"] for c in r.json()["companies"]], [COA])
        names = {x["label"] for m in r.json()["headcount"]["months"] for x in m["byCompany"]}
        self.assertEqual(names, {"Greens US"})
        self.assertEqual(self._get(f"/hr/analytics/summary?company={COB}", SCOPED).status_code, 404)
        self.assertEqual(self._get(f"/hr/analytics/people?metric=headcount&company={COB}", SCOPED).status_code, 404)

    def test_api_refuses_the_manager_tier_and_bad_input(self):
        self.assertEqual(self._get("/hr/analytics/summary", MGR).status_code, 403)
        self.assertEqual(self._get("/hr/analytics/summary?type=robots", HR).status_code, 400)
        self.assertEqual(self._get("/hr/analytics/people?metric=nope", HR).status_code, 400)
        self.assertEqual(self._get("/hr/analytics/summary", "ha.nobody" + D).status_code, 403)


if __name__ == "__main__":
    unittest.main()
