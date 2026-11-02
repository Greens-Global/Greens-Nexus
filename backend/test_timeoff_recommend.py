"""Time-off approval recommendation (Neil, 11/02/2026, Homebase lift 3):
timeoff_recommend.recommend says "Recommended: Approve" or "Check First"
with plain reasons - for the people who DECIDE a request only. Nothing is
approved or rejected by code; the manager's buttons are unchanged.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_timeoff_recommend.py -q
"""
import os
import tempfile
import unittest
from datetime import date, timedelta
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import leave_balances as lb  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import timeoff_recommend as tr  # noqa: E402
from routers import shift_requests as sr  # noqa: E402
from routers import timeclock as tc  # noqa: E402

MGR = "rec.max@greensglobal.com"       # the manager who decides
EMP = "rec.erin@greensglobal.com"      # asks for time off
MATE = "rec.mia@greensglobal.com"      # Erin's teammate (same manager)
OTHER = "rec.omar@greensglobal.com"    # another team entirely
ENTITY = "ent-rec"
CUT = "2026-01-01"


def _next_monday(min_days_ahead: int) -> date:
    d = date.today() + timedelta(days=min_days_ahead)
    return d + timedelta(days=(7 - d.weekday()) % 7)


def _iso(d: date) -> str:
    return d.isoformat()


def _us(d: date) -> str:
    return d.strftime("%m/%d/%Y")


class RecommendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)
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
        # The recommendation reads the PERSON's today (timeclock._employee_today:
        # UTC for someone who has never punched) while these tests count from the
        # machine's date.today(); from about 4 PM Pacific the two days differ, so
        # the person's today is pinned to the machine's for the test.
        self._today = mock.patch.object(tc, "_employee_today", return_value=date.today().isoformat())
        self._today.start()
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = MGR
        self.db = database.SessionLocal()
        db = self.db
        for m in (models.TimeOffRequest, models.LeaveLedgerEntry, models.NexusSetting, models.PayrollRate,
                  models.HrCompanyHoliday, models.HrEntity, models.NexusRole, models.NexusNotification,
                  models.TimePunch):
            db.query(m).delete(synchronize_session=False)
        db.query(models.NexusEmployee).execution_options(include_deleted=True).delete(synchronize_session=False)
        db.add(models.HrEntity(id=ENTITY, name="Greens Test", country="US"))
        for em, first, mgr in ((MGR, "Max", ""), (EMP, "Erin", MGR), (MATE, "Mia", MGR), (OTHER, "Omar", "")):
            db.add(models.NexusEmployee(id=f"emp-{first}", work_email=em, first_name=first, last_name="Test",
                                        manager_email=mgr, status="active", deleted_at="", company=ENTITY,
                                        country="US", start_date="2024-01-01", employment_type="full_time"))
        for em in (EMP, MATE, OTHER):
            db.add(models.PayrollRate(employee_email=em, pay_type="hourly", hourly_rate=20.0,
                                      overtime_rule="ca", currency="USD"))
        db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
        db.commit()
        lb.set_cutover(db, CUT, MGR)
        db.commit()
        auth._role_cache.clear()
        cache.module_grants.invalidate()

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        auth._role_cache.clear()
        auth.SKIP_AUTH = self._skip
        self._today.stop()
        self.db.close()

    # -- helpers --
    def _request(self, rid, who, start: date, end: date, status="pending", type_="vacation"):
        r = models.TimeOffRequest(id=rid, employee_email=who, type=type_, start_date=_iso(start), end_date=_iso(end),
                                  status=status, created_at="2026-10-10T08:00:00")
        self.db.add(r)
        self.db.commit()
        return r

    def _opening(self, who, vacation):
        lb.set_opening(self.db, who, vacation=vacation, sick=0, by=MGR)
        self.db.commit()

    # -- the four cases --
    def test_all_good(self):
        self._opening(EMP, 40)
        mon = _next_monday(14)
        r = self._request("to-good", EMP, mon, mon + timedelta(days=1))      # Mon-Tue, 16 h
        out = tr.recommend(self.db, r)
        self.assertEqual((out["tone"], out["label"]), ("good", "Recommended: Approve"))
        ahead = (mon - date.today()).days
        self.assertEqual(out["reasons"], ["Balance covers it (24 h left after).",
                                          "Nobody else on the team is off those days.",
                                          f"Requested {ahead} days ahead."])

    def test_short_balance(self):
        self._opening(EMP, 8)
        mon = _next_monday(14)
        r = self._request("to-short", EMP, mon, mon + timedelta(days=1))     # needs 16 h, has 8
        out = tr.recommend(self.db, r)
        self.assertEqual((out["tone"], out["label"]), ("check", "Check First"))
        self.assertIn("Balance is 8 h short.", out["reasons"])
        self.assertNotIn("Balance covers it (24 h left after).", out["reasons"])

    def test_teammate_overlap(self):
        self._opening(EMP, 40)
        mon = _next_monday(14)
        tue = mon + timedelta(days=1)
        self._request("to-mia", MATE, tue, tue, status="approved")           # Mia is off the Tuesday
        self._request("to-omar", OTHER, mon, tue, status="approved")        # another team: not a reason
        r = self._request("to-ovl", EMP, mon, tue)
        out = tr.recommend(self.db, r)
        self.assertEqual(out["tone"], "check")
        self.assertIn(f"Mia Test is also off {_us(tue)}.", out["reasons"])
        self.assertFalse(any("Omar" in x for x in out["reasons"]))
        self.assertNotIn("Nobody else on the team is off those days.", out["reasons"])

    def test_short_notice(self):
        self._opening(EMP, 40)
        soon = date.today() + timedelta(days=2)
        r = self._request("to-soon", EMP, soon, soon)
        out = tr.recommend(self.db, r)
        self.assertEqual(out["tone"], "check")
        self.assertIn("Starts in 2 days.", out["reasons"])
        # The company may ask for less notice: 1 day makes the same request fine.
        sr._store_settings(self.db, {"email": MGR}, sr._settings_key(""), {"timeOffNoticeDays": 1})
        self.db.commit()
        out = tr.recommend(self.db, r)
        self.assertEqual(out["tone"], "good")
        self.assertIn("Requested 2 days ahead.", out["reasons"])

    def test_long_span_is_a_check(self):
        self._opening(EMP, 80)
        mon = _next_monday(14)
        r = self._request("to-week", EMP, mon, mon + timedelta(days=4))     # Mon-Fri
        out = tr.recommend(self.db, r)
        self.assertEqual(out["tone"], "check")
        self.assertIn("5 working days - longer than the usual 3.", out["reasons"])
        # The company's own short-request length is what the sentence names.
        sr._store_settings(self.db, {"email": MGR}, sr._settings_key(""), {"timeOffShortDays": 2})
        self.db.commit()
        self.assertIn("5 working days - longer than the usual 2.", tr.recommend(self.db, r)["reasons"])

    def test_no_manager_means_no_team_sentence(self):
        # Omar has no manager, so there is no team to have checked: the
        # "nobody else is off" line would claim a check never made.
        self._opening(OTHER, 40)
        mon = _next_monday(14)
        r = self._request("to-omar-solo", OTHER, mon, mon)
        out = tr.recommend(self.db, r)
        self.assertEqual(out["tone"], "good")
        self.assertNotIn("Nobody else on the team is off those days.", out["reasons"])
        self.assertTrue(any("ahead" in x for x in out["reasons"]))

    # -- Review Focus 2: holidays and weekends are not working days --
    def test_holiday_and_weekend_in_the_span_count_only_working_days(self):
        self._opening(EMP, 16)
        mon = _next_monday(14)
        self.db.add(models.HrCompanyHoliday(id="hol-rec", company_id=ENTITY, date=_iso(mon), name="Founders Day",
                                            source="manual", country_code="US", type="mandatory", actual_date="",
                                            policy_id="", policy_key="", overridden=0,
                                            created_at="2026-01-01T00:00:00+00:00"))
        self.db.commit()
        # Mon (holiday) - Wed: two working days, 16 h - the balance covers it exactly.
        r = self._request("to-hol", EMP, mon, mon + timedelta(days=2))
        self.assertEqual(tr.working_days(self.db, r), [_iso(mon + timedelta(days=1)), _iso(mon + timedelta(days=2))])
        out = tr.recommend(self.db, r)
        self.assertEqual(out["tone"], "good", out)
        self.assertIn("Balance covers it (0 h left after).", out["reasons"])
        self.assertFalse(any("working days" in x for x in out["reasons"]))
        # Fri - the next Mon: the weekend is not counted either (2 working days).
        fri = mon + timedelta(days=4)
        r2 = self._request("to-wknd", EMP, fri, fri + timedelta(days=3))
        self.assertEqual(len(tr.working_days(self.db, r2)), 2)
        out2 = tr.recommend(self.db, r2)
        self.assertIn("Balance covers it (0 h left after).", out2["reasons"])

    def test_no_balance_set_up_skips_the_balance_check(self):
        """Unpaid leave (no bucket) and a person with no live balance get no balance reason, good or bad."""
        mon = _next_monday(14)
        r = self._request("to-unpaid", EMP, mon, mon, type_="unpaid")
        out = tr.recommend(self.db, r)
        self.assertEqual(out["tone"], "good")
        self.assertFalse(any("Balance" in x for x in out["reasons"]))

    # -- the settings --
    def test_settings_defaults_and_clamps(self):
        cfg = sr.get_settings(self.db)
        self.assertEqual((cfg["timeOffNoticeDays"], cfg["timeOffShortDays"]), (7, 3))
        self.assertEqual(sr._clean_value("timeOffNoticeDays", 200), 90)
        self.assertEqual(sr._clean_value("timeOffNoticeDays", -4), 0)
        self.assertEqual(sr._clean_value("timeOffShortDays", 0), 1)
        self.assertEqual(sr._clean_value("timeOffShortDays", 99), 30)
        self.assertIn("timeOffNoticeDays", sr.SettingsIn.model_fields)
        self.assertIn("timeOffShortDays", sr.SettingsIn.model_fields)

    # -- who sees it: deciders only, and it never decides --
    def test_serializer_adds_it_for_deciders_only_and_the_inbox_carries_a_hint(self):
        self._opening(EMP, 40)
        mon = _next_monday(14)
        r = self._request("to-ser", EMP, mon, mon + timedelta(days=1))
        as_mgr = tc._ser_timeoff(r, priv=tc._TimeoffPrivacy(self.db, MGR))
        self.assertTrue(as_mgr["canDecide"])
        self.assertEqual(as_mgr["recommendation"]["label"], "Recommended: Approve")
        self.assertEqual(as_mgr["status"], "pending")         # nothing was decided by code
        as_erin = tc._ser_timeoff(r, priv=tc._TimeoffPrivacy(self.db, EMP))
        self.assertFalse(as_erin["canDecide"])
        self.assertNotIn("recommendation", as_erin)
        self.assertNotIn("recommendation", tc._ser_timeoff(r))   # no viewer, no hint
        done = self._request("to-done", EMP, mon, mon, status="approved")
        self.assertNotIn("recommendation", tc._ser_timeoff(done, priv=tc._TimeoffPrivacy(self.db, MGR)))

        res = self.client.get("/approvals/inbox")
        self.assertEqual(res.status_code, 200, res.text)
        row = next(x for x in res.json()["rows"] if x["key"] == "time_off:to-ser")
        self.assertEqual(row["hint"]["tone"], "good")
        self.assertEqual(row["hint"]["text"], "Recommended: Approve")
        # The approved Monday above (8 h) is spoken for: 40 - 8 - 16 = 16 h left.
        self.assertEqual(row["hint"]["reasons"][0], "Balance covers it (16 h left after).")
        # The manager's buttons are exactly what they were.
        self.assertEqual([a["key"] for a in row["actions"]], ["approve", "reject"])
        self.assertEqual(self.db.get(models.TimeOffRequest, "to-ser").status, "pending")


    def test_a_list_shares_one_memo_so_settings_policies_and_balances_are_read_once(self):
        """40 pending rows used to cost 40 settings reads, 40 policy loads and
        a balance pass each (11/02/2026): `_TimeoffPrivacy` now hands one
        timeoff_recommend.Memo to every row it serializes."""
        from sqlalchemy import event
        extra = ("rec.pat@greensglobal.com", "rec.quin@greensglobal.com")
        for em, first in zip(extra, ("Pat", "Quin")):
            self.db.add(models.NexusEmployee(id=f"emp-{first}", work_email=em, first_name=first, last_name="Test",
                                             manager_email=MGR, status="active", deleted_at="", company=ENTITY,
                                             country="US", start_date="2024-01-01", employment_type="full_time"))
            self.db.add(models.PayrollRate(employee_email=em, pay_type="hourly", hourly_rate=20.0,
                                           overtime_rule="ca", currency="USD"))
        self.db.commit()
        people = (EMP, MATE) + extra + (EMP,)          # five pending rows, one person twice
        for who in set(people):
            self._opening(who, 40)
        mon = _next_monday(14)
        rows = [self._request(f"to-memo-{i}", who, mon + timedelta(days=i), mon + timedelta(days=i))
                for i, who in enumerate(people)]
        self.db.expire_all()

        statements = []

        def count(*_a, **_k):
            statements.append(1)

        def run(shared: bool):
            statements.clear()
            event.listen(database.engine, "before_cursor_execute", count)
            try:
                if shared:
                    priv = tc._TimeoffPrivacy(self.db, MGR)
                    out = [tc._ser_timeoff(r, priv=priv) for r in rows]
                    return out, len(statements), priv
                out = [tc._ser_timeoff(r, priv=tc._TimeoffPrivacy(self.db, MGR)) for r in rows]
                return out, len(statements), None
            finally:
                event.remove(database.engine, "before_cursor_execute", count)

        alone, n_alone, _ = run(shared=False)
        shared, n_shared, priv = run(shared=True)
        self.assertTrue(all(o["canDecide"] and "recommendation" in o for o in shared))
        self.assertEqual([o["recommendation"] for o in shared], [o["recommendation"] for o in alone])
        self.assertLess(n_shared, n_alone, (n_shared, n_alone))
        memo = priv.recommend_memo()
        self.assertEqual(list(memo._settings), [ENTITY])           # one settings read for the company
        self.assertIsNotNone(memo._pols)                            # the policies once
        self.assertEqual(set(memo._balances), set(people))         # one balance pass per person, not per row
        self.assertEqual(set(memo._today), set(people))
        self.assertEqual(list(memo._mates), [MGR])                  # the team once


if __name__ == "__main__":
    unittest.main()
