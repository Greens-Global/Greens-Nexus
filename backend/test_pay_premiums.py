"""Shift differentials + call-back pay (Neil, Oct 17 2026) - pay_premiums.py
and its hooks in routers/timeclock.py.

OFF BY DEFAULT, and off must change nothing: the golden file
(test_pay_premiums_golden.json) holds the time sheets, summary CSV,
QuickBooks IIF, Intacct GL, Import Hub hours, finalize snapshot and Retro Pay
parts of a mixed fixture as produced by the code BEFORE this feature
(origin/dev at c3a83873). Off - no setting, a saved-but-off setting, or the
feature on for a different company - must reproduce it byte for byte.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_pay_premiums.py -q
Regenerate the golden file (only from the pre-feature code):
    PAY_PREMIUMS_WRITE_GOLDEN=1 python -m pytest test_pay_premiums.py -q -k golden
"""
import asyncio
import json
import os
import tempfile
import unittest
from unittest import mock
from datetime import datetime

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database  # noqa: E402
import main  # noqa: E402,F401 - app import wires the DB
import models  # noqa: E402
from routers import timeclock as tc  # noqa: E402
from routers import retro_pay as rp  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test_pay_premiums_golden.json")
CO1, CO2 = "pp-co-one", "pp-co-two"
A = "pp.alice@greensglobal.com"     # hourly, CA rule, $20, company one
B = "pp.bob@greensglobal.com"       # hourly, federal rule, $30, company two
F = "pp.fred@greensglobal.com"      # fixed salary, company one
HR = {"email": "pp.hr@greensglobal.com", "level": 5, "role": "administrator"}
PS, PE = "2026-09-13", "2026-09-26"   # Sunday to Saturday x2
PDT = 420                            # getTimezoneOffset for Pacific daylight time: local = UTC - 7h
SETTING = "timeclock_pay_premiums"


def _utc(local: str, off: int = PDT) -> str:
    from datetime import timedelta
    t = datetime.strptime(local, "%Y-%m-%dT%H:%M") + timedelta(minutes=off)
    return t.strftime("%Y-%m-%dT%H:%M:%S")


_SEQ = [0]


def _p(db, em, kind, local, day, site="", cat=""):
    _SEQ[0] += 1
    n = _SEQ
    at = _utc(local)
    db.add(models.TimePunch(id=f"pp-{n[0]:04d}", employee_email=em, kind=kind, at=at, local_date=day,
                            tz_offset_min=PDT, voided=0, created_at=at, source="web",
                            geo_status="in_fence" if site else "", work_site_id=site,
                            work_site_name={"site-a": "Alpha Yard", "site-b": "Bravo Yard"}.get(site, ""),
                            category=cat))


def _shift(db, em, day, t_in, t_out, site="", out_day=None, cat="", brk=None):
    _p(db, em, "in", f"{day}T{t_in}", day, site, cat)
    if brk:
        _p(db, em, "break_start", f"{day}T{brk[0]}", day, site)
        _p(db, em, "break_end", f"{day}T{brk[1]}", day, site)
    _p(db, em, "out", f"{out_day or day}T{t_out}", out_day or day, site, cat)


def _wipe(db):
    for m in (models.TimePunch, models.PayrollRate, models.PayrollRateHistory, models.TimeApproval,
              models.TimeBreakPremium):
        db.query(m).filter(m.employee_email.in_([A, B, F])).delete(synchronize_session=False)
    (db.query(models.NexusEmployee).execution_options(include_deleted=True)
       .filter(models.NexusEmployee.work_email.in_([A, B, F])).delete(synchronize_session=False))
    db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTING).delete(synchronize_session=False)
    db.query(models.HrEntity).filter(models.HrEntity.id.in_([CO1, CO2])).delete(synchronize_session=False)
    db.query(models.HrWorkSite).filter(models.HrWorkSite.id.in_(["site-a", "site-b"])).delete(synchronize_session=False)
    db.commit()


def _seed(db):
    _wipe(db)
    _SEQ[0] = 0     # the same punch ids every time - they key the time sheet's punchMeta
    db.add(models.HrEntity(id=CO1, name="Premium Co One"))
    db.add(models.HrEntity(id=CO2, name="Premium Co Two"))
    db.add(models.HrWorkSite(id="site-a", name="Alpha Yard"))
    db.add(models.HrWorkSite(id="site-b", name="Bravo Yard"))
    for em, first, co in ((A, "Alice", CO1), (B, "Bob", CO2), (F, "Fred", CO1)):
        db.add(models.NexusEmployee(id=f"emp-{em}", first_name=first, last_name="Premium", work_email=em,
                                    company=co, status="active", deleted_at="", employee_code=first[:3].upper()))
    db.add(models.PayrollRate(employee_email=A, pay_type="hourly", hourly_rate=20.0, overtime_rule="ca", currency="USD"))
    db.add(models.PayrollRate(employee_email=B, pay_type="hourly", hourly_rate=30.0, overtime_rule="federal", currency="USD"))
    db.add(models.PayrollRate(employee_email=F, pay_type="fixed", hourly_rate=0.0, monthly_salary=6000.0,
                              overtime_rule="none", currency="USD"))
    # Alice (CA): a day shift with lunch, an overnight shift across midnight,
    # a split day (a call-back), sick leave, a 12h day, a weekend day.
    _shift(db, A, "2026-09-14", "08:00", "17:00", "site-a", brk=("12:00", "12:30"))
    _shift(db, A, "2026-09-15", "22:00", "06:30", "site-b", out_day="2026-09-16")
    _shift(db, A, "2026-09-16", "09:00", "12:00", "site-a")
    _shift(db, A, "2026-09-16", "15:00", "16:00", "site-a")
    _shift(db, A, "2026-09-17", "08:00", "16:00", cat="Sick Day")
    _shift(db, A, "2026-09-18", "08:00", "20:00", "site-a")
    _shift(db, A, "2026-09-19", "10:00", "14:00", "site-b")
    _shift(db, A, "2026-09-21", "18:00", "23:15", "site-a", brk=("20:00", "20:10"))
    # Bob (federal): five 9h days -> weekly overtime, one evening stint.
    for d in ("2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"):
        _shift(db, B, d, "13:00", "22:00", "site-b")
    _shift(db, B, "2026-09-22", "07:00", "11:00")
    # Fred (fixed): a normal day and a late one.
    _shift(db, F, "2026-09-14", "09:00", "18:00", "site-a")
    _shift(db, F, "2026-09-15", "20:00", "23:30", "site-a")
    db.commit()


def _stream(resp) -> str:
    async def read():
        parts = []
        async for c in resp.body_iterator:
            parts.append(c if isinstance(c, str) else c.decode())
        return "".join(parts)
    return asyncio.run(read())


def _without_meal_flags(out: dict) -> dict:
    """The CA meal check (ca_breaks.py, Oct 17 2026) flags this fixture's
    CA-rule days that have no meal break - a day["meal"] note that adds no
    pay and is not part of this feature. Everything else must still match the
    golden file byte for byte; test_ca_breaks covers the meal flags."""
    for k, v in list(out.items()):
        if not k.startswith("card"):
            continue
        c = json.loads(v)
        if "caBreaks" not in c and not any("meal" in d for d in c.get("days") or []):
            continue
        c.pop("caBreaks", None)        # the non-pay "CA tools apply" marker
        for d in c.get("days") or []:
            d.pop("meal", None)
        out[k] = json.dumps(c, sort_keys=True)
    return out


def _without_color_flags(out: dict) -> dict:
    """The payroll grid's color banding (Oct 19 2026) adds "clock" / "byHr" to
    each punchMeta entry - display only, no pay; not part of this feature."""
    for k, v in list(out.items()):
        if not k.startswith(("card", "fixed")):
            continue
        c = json.loads(v)
        meta = c.get("punchMeta") or {}
        if not any("clock" in m or "byHr" in m for m in meta.values()):
            continue
        for m in meta.values():
            m.pop("clock", None)
            m.pop("byHr", None)
        out[k] = json.dumps(c, sort_keys=True)
    return out


def _outputs(db) -> dict:
    """Every pay surface of the fixture, as text."""
    out = {}
    cards = {em: tc._compute_timecard(db, em, PS, PE) for em in (A, B)}
    for em, c in cards.items():
        out[f"card:{em}"] = json.dumps(c, sort_keys=True)
    out["fixed:" + F] = json.dumps(tc._fixed_card(db, F, PS), sort_keys=True)
    out["csv"] = _stream(tc.export_csv(start=PS, end=PE, mode="summary", user=HR, _su={}, db=db))
    out["iif"] = tc.export_iif(start=PS, end=PE, finalized_only=False, user=HR, _su={}, db=db).body.decode()
    out["hours"] = json.dumps(tc.export_hours(start=PS, end=PE, user=HR, _su={}, db=db), sort_keys=True)
    out["intacct"] = tc.export_intacct(start="2026-09-01", end="2026-09-30", expense="6000", clearing="2100",
                                       location="L1", user=HR, _su={}, db=db).body.decode()
    out["retroParts"] = json.dumps({em: rp._pay_parts(c["totals"]) for em, c in cards.items()}, sort_keys=True)
    tc.finalize_timecard(tc.FinalizeIn(email=A, start=PS, end=PE, allow_exceptions=True), user=HR, db=db)
    row = (db.query(models.TimeApproval).filter(models.TimeApproval.employee_email == A,
                                                models.TimeApproval.kind == "final").first())
    out["finalSnapshot"] = row.note
    out["cardFinal:" + A] = json.dumps(tc._compute_timecard(db, A, PS, PE), sort_keys=True)
    out["cardReprice:" + A] = json.dumps(tc._compute_timecard(db, A, PS, PE, reprice=True), sort_keys=True)
    return out


def _save(db, company, cfg):
    import pay_premiums
    return pay_premiums.save(db, company, cfg, "test")


NIGHT = {"id": "night", "name": "Night Differential", "kind": "flat", "amount": 2.0,
         "start": "22:00", "end": "06:00", "days": [], "sites": []}
WEEKEND = {"id": "wkend", "name": "Weekend Differential", "kind": "percent", "amount": 10,
           "start": "", "end": "", "days": [0, 6], "sites": []}
CALLBACK = {"enabled": True, "minimumMin": 120, "gapMin": 60}


class Base(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        _seed(self.db)

    def tearDown(self):
        _wipe(self.db)
        self.db.close()


class OffIsIdenticalTests(Base):
    """Off - in every way it can be off - is the pre-feature output exactly."""

    def _golden(self):
        if os.environ.get("PAY_PREMIUMS_WRITE_GOLDEN"):
            with open(GOLDEN, "w") as fh:
                json.dump(_outputs(self.db), fh, indent=1, sort_keys=True)
            self.skipTest("golden file written")
        with open(GOLDEN) as fh:
            return json.load(fh)

    def _assert_same(self, golden):
        got = _without_color_flags(_without_meal_flags(_outputs(self.db)))
        self.assertEqual(sorted(got), sorted(golden))
        for k in golden:
            self.assertEqual(got[k], golden[k], f"{k} changed while the feature is off")

    def test_golden_no_setting(self):
        self._assert_same(self._golden())

    def test_golden_saved_but_off(self):
        golden = self._golden()
        _save(self.db, CO1, {"enabled": False, "differentials": [NIGHT, WEEKEND], "callBack": CALLBACK})
        _save(self.db, CO2, {"enabled": False, "differentials": [NIGHT], "callBack": CALLBACK})
        self._assert_same(golden)

    def test_golden_on_for_an_unrelated_company(self):
        golden = self._golden()
        _save(self.db, "pp-some-other-co", {"enabled": True, "differentials": [NIGHT, WEEKEND], "callBack": CALLBACK})
        self._assert_same(golden)

    def test_golden_on_but_no_rules(self):
        golden = self._golden()
        _save(self.db, CO1, {"enabled": True, "differentials": [], "callBack": {"enabled": False}})
        self._assert_same(golden)


class DifferentialTests(Base):
    def _card(self, em=A):
        return tc._compute_timecard(self.db, em, PS, PE)

    def _day(self, card, ds):
        return next(d for d in card["days"] if d["date"] == ds)

    def test_night_window_across_midnight(self):
        _save(self.db, CO1, {"enabled": True, "differentials": [NIGHT]})
        card = self._card()
        # Tue 22:00 -> Wed 06:30: 22:00-06:00 = 8h in the window, on Tuesday's row.
        tue = self._day(card, "2026-09-15")
        self.assertEqual(tue["differentials"], [{"name": "Night Differential", "min": 480, "pay": 16.0}])
        self.assertEqual((tue["diffMin"], tue["diffPay"]), (480, 16.0))
        # Day shifts never touch the window.
        self.assertNotIn("diffMin", self._day(card, "2026-09-14"))
        # Mon 9/21 18:00-23:15, break 20:00-20:10: 22:00-23:15 = 75 min.
        self.assertEqual(self._day(card, "2026-09-21")["diffMin"], 75)
        T = card["totals"]
        self.assertEqual((T["diffMin"], T["diffPay"]), (555, 18.5))
        self.assertEqual(T["differentials"], [{"name": "Night Differential", "min": 555, "pay": 18.5}])
        # Its own line: the hours, overtime and other pay are unchanged.
        tc_off = self._off_totals()
        for k in ("regMin", "otMin", "dtMin", "regPay", "otPay", "dtPay", "workedMin", "sickPay"):
            self.assertEqual(T[k], tc_off[k], k)
        self.assertEqual(T["totalPay"], round(tc_off["totalPay"] + 18.5, 2))

    def _off_totals(self):
        import pay_premiums
        real = pay_premiums.active
        pay_premiums.active = lambda cfg: False
        try:
            return self._card()["totals"]
        finally:
            pay_premiums.active = real

    def test_weekend_percent(self):
        _save(self.db, CO1, {"enabled": True, "differentials": [WEEKEND]})
        card = self._card()
        sat = self._day(card, "2026-09-19")
        # 4h on Saturday at 10% of $20 = $2/h -> $8.
        self.assertEqual(sat["differentials"], [{"name": "Weekend Differential", "min": 240, "pay": 8.0}])
        self.assertEqual(card["totals"]["diffPay"], 8.0)

    def test_percent_vs_flat_same_window(self):
        pct = {**NIGHT, "id": "n2", "name": "Night Percent", "kind": "percent", "amount": 15}
        _save(self.db, CO1, {"enabled": True, "differentials": [NIGHT, pct]})
        tue = self._day(self._card(), "2026-09-15")
        # 8h: flat $2/h = $16; 15% of $20 = $3/h = $24. They stack.
        self.assertEqual(tue["differentials"], [{"name": "Night Differential", "min": 480, "pay": 16.0},
                                                {"name": "Night Percent", "min": 480, "pay": 24.0}])
        self.assertEqual(tue["diffPay"], 40.0)

    def test_site_filter(self):
        _save(self.db, CO1, {"enabled": True, "differentials": [{**NIGHT, "sites": ["site-a"]}]})
        card = self._card()
        self.assertNotIn("diffMin", self._day(card, "2026-09-15"))      # Bravo Yard - not paid
        self.assertEqual(self._day(card, "2026-09-21")["diffMin"], 75)  # Alpha Yard
        _save(self.db, CO1, {"enabled": True, "differentials": [{**WEEKEND, "sites": ["site-a"]}]})
        self.assertNotIn("diffMin", self._day(self._card(), "2026-09-19"))   # Saturday at Bravo

    def test_unpaid_break_inside_window_is_not_paid(self):
        win = {**NIGHT, "id": "eve", "name": "Evening", "start": "19:00", "end": "23:00"}
        _save(self.db, CO1, {"enabled": True, "differentials": [win]})
        # 9/21 18:00-23:15 with a 10-min break at 20:00: 19:00-23:00 = 240 - 10.
        self.assertEqual(self._day(self._card(), "2026-09-21")["diffMin"], 230)

    def test_days_name_the_day_the_window_starts(self):
        tue_night = {**NIGHT, "id": "tn", "name": "Tuesday Night", "days": [2]}
        _save(self.db, CO1, {"enabled": True, "differentials": [tue_night]})
        card = self._card()
        self.assertEqual(self._day(card, "2026-09-15")["diffMin"], 480)   # Tue 22:00 -> Wed 06:00
        self.assertNotIn("diffMin", self._day(card, "2026-09-21"))        # a Monday

    def test_leave_and_fixed_and_other_company_untouched(self):
        _save(self.db, CO1, {"enabled": True, "differentials": [{**NIGHT, "start": "00:00", "end": "23:59"}],
                             "callBack": CALLBACK})
        card = self._card()
        self.assertNotIn("diffMin", self._day(card, "2026-09-17"))   # sick leave is not worked time
        self.assertNotIn("diffPay", self._card(B)["totals"])         # Bob's company has it off
        fixed = tc._fixed_card(self.db, F, PS)
        self.assertNotIn("diffPay", json.dumps(fixed))

    def test_exempt_untouched(self):
        g = models.NexusGroup(id="pp-exempt", name="Leadership", time_tracking_exempt=1)
        self.db.add(g)
        self.db.add(models.NexusGroupMember(group_id="pp-exempt", email=A))
        self.db.commit()
        try:
            _save(self.db, CO1, {"enabled": True, "differentials": [NIGHT], "callBack": CALLBACK})
            self.assertNotIn("diffPay", self._card()["totals"])
        finally:
            self.db.query(models.NexusGroupMember).filter_by(group_id="pp-exempt").delete()
            self.db.query(models.NexusGroup).filter_by(id="pp-exempt").delete()
            self.db.commit()


class CallBackTests(Base):
    def test_shortfall_paid_at_base_rate(self):
        _save(self.db, CO1, {"enabled": True, "callBack": CALLBACK})
        card = tc._compute_timecard(self.db, A, PS, PE)
        wed = next(d for d in card["days"] if d["date"] == "2026-09-16")
        # 09:00-12:00, back 15:00-16:00 after 3h out: a 1h call-back, 1h short of the 2h minimum.
        self.assertEqual((wed["callBackMin"], wed["callBackPay"]), (60, 20.0))
        T = card["totals"]
        self.assertEqual((T["callBackMin"], T["callBackPay"]), (60, 20.0))
        # Not hours worked, not overtime.
        self.assertEqual(wed["workedMin"], 240)
        self.assertEqual(T["diffPay"], 0.0)

    def test_no_shortfall_when_the_stint_meets_the_minimum_or_the_gap_is_short(self):
        _save(self.db, CO1, {"enabled": True, "callBack": {**CALLBACK, "minimumMin": 60}})
        T = tc._compute_timecard(self.db, A, PS, PE)["totals"]
        self.assertEqual(T["callBackMin"], 0)
        _save(self.db, CO1, {"enabled": True, "callBack": {**CALLBACK, "gapMin": 240}})
        self.assertEqual(tc._compute_timecard(self.db, A, PS, PE)["totals"]["callBackMin"], 0)

    def test_callback_off_inside_an_enabled_config(self):
        _save(self.db, CO1, {"enabled": True, "differentials": [NIGHT], "callBack": {**CALLBACK, "enabled": False}})
        T = tc._compute_timecard(self.db, A, PS, PE)["totals"]
        self.assertEqual(T["callBackMin"], 0)


class ExportAndFinalizeTests(Base):
    def setUp(self):
        super().setUp()
        _save(self.db, CO1, {"enabled": True, "differentials": [NIGHT], "callBack": CALLBACK})

    def test_exports_carry_the_new_classes(self):
        iif = tc.export_iif(start=PS, end=PE, finalized_only=False, user=HR, _su={}, db=self.db).body.decode()
        self.assertIn("\tShift Differential\t8.00\t", iif)
        self.assertIn("\tCall-Back Pay\t1.00\t", iif)
        bob_lines = [ln for ln in iif.splitlines() if "Bob Premium" in ln]
        self.assertFalse(any("Shift Differential" in ln or "Call-Back" in ln for ln in bob_lines))
        csv_text = _stream(tc.export_csv(start=PS, end=PE, mode="summary", user=HR, _su={}, db=self.db))
        head = csv_text.splitlines()[0]
        self.assertTrue(head.endswith("Approved,Shift Differential Hours,Shift Differential Pay,Call-Back Hours,Call-Back Pay"))
        total_a = next(ln for ln in csv_text.splitlines() if ln.startswith("Alice Premium") and ",TOTAL," in ln)
        self.assertTrue(total_a.endswith(",9.25,18.50,1.00,20.00"), total_a)
        hours = tc.export_hours(start=PS, end=PE, user=HR, _su={}, db=self.db)["rows"]
        ha = next(r for r in hours if r["email"] == A)["hours"]
        self.assertEqual((ha["shiftDifferential"], ha["callBack"]), (9.25, 1.0))
        hb = next(r for r in hours if r["email"] == B)["hours"]
        self.assertNotIn("shiftDifferential", hb)
        cards = [{**tc._compute_timecard(self.db, A, PS, PE), "name": "Alice", "payType": "hourly"}]
        lines = tc.payroll_intacct_entries(cards, start=PS, end=PE, journal="PYRJ", expense="6000",
                                           clearing="2100", location="L1")[0]["lines"]
        memos = [ln["memo"] for ln in lines]
        self.assertIn("Alice - Shift Differential - 9.25 h", memos)
        self.assertIn("Alice - Call-Back Pay - 1.00 h", memos)
        debits = round(sum(ln["debit"] or 0 for ln in lines), 2)
        self.assertEqual(debits, cards[0]["totals"]["totalPay"])

    def test_finalize_freezes_the_rules(self):
        before = tc._compute_timecard(self.db, A, PS, PE)["totals"]
        tc.finalize_timecard(tc.FinalizeIn(email=A, start=PS, end=PE, allow_exceptions=True), user=HR, db=self.db)
        snap = json.loads(self.db.query(models.TimeApproval).filter_by(employee_email=A, kind="final").first().note)
        self.assertEqual(snap["premiums"]["differentials"][0]["name"], "Night Differential")
        # Rules changed, or switched off, after the finalize: the period keeps its pay.
        _save(self.db, CO1, {"enabled": True, "differentials": [{**NIGHT, "amount": 9.0}], "callBack": {"enabled": False}})
        after = tc._compute_timecard(self.db, A, PS, PE)["totals"]
        self.assertEqual((after["diffPay"], after["callBackPay"], after["totalPay"]),
                         (before["diffPay"], before["callBackPay"], before["totalPay"]))
        _save(self.db, CO1, {"enabled": False})
        self.assertEqual(tc._compute_timecard(self.db, A, PS, PE)["totals"]["totalPay"], before["totalPay"])
        # Retro Pay prices the frozen rules at today's rate - same on both sides.
        parts = rp._pay_parts(after)
        self.assertEqual(parts["premium"], round(before["diffPay"] + before["callBackPay"], 2))

    def test_finalized_while_off_stays_off_after_turning_on(self):
        _save(self.db, CO1, {"enabled": False})
        before = tc._compute_timecard(self.db, A, PS, PE)["totals"]
        tc.finalize_timecard(tc.FinalizeIn(email=A, start=PS, end=PE, allow_exceptions=True), user=HR, db=self.db)
        _save(self.db, CO1, {"enabled": True, "differentials": [NIGHT], "callBack": CALLBACK})
        after = tc._compute_timecard(self.db, A, PS, PE)["totals"]
        self.assertEqual(after, before)

    def test_legacy_finalized_period_without_a_rate_snapshot_stays_off(self):
        # Finalized before rates were stored with the period: no readable
        # snapshot at all - the live rules must not price it either.
        self.db.add(models.TimeApproval(id="pp-legacy-final", employee_email=A, period_start=PS, period_end=PE,
                                        worked_min=0, approved_by=HR["email"], approved_at="2026-09-28T12:00:00",
                                        kind="final", note="", revoked=0))
        self.db.commit()
        self.assertNotIn("diffPay", tc._compute_timecard(self.db, A, PS, PE)["totals"])

    def test_finalize_keeps_the_per_day_rate_snapshot(self):
        tc.finalize_timecard(tc.FinalizeIn(email=A, start=PS, end=PE, allow_exceptions=True), user=HR, db=self.db)
        row = self.db.query(models.TimeApproval).filter_by(employee_email=A, kind="final").first()
        snap = json.loads(row.note)
        snap["rates"] = {"2026-09-15": 40.0}     # as if Tuesday had been priced at $40
        snap["premiums"]["differentials"] = [{**NIGHT, "kind": "percent", "amount": 10}]
        row.note = json.dumps(snap)
        self.db.commit()
        tue = next(d for d in tc._compute_timecard(self.db, A, PS, PE)["days"] if d["date"] == "2026-09-15")
        self.assertEqual(tue["diffPay"], 32.0)   # 8h x 10% of the frozen $40


class SettingsTests(Base):
    def test_validation(self):
        import pay_premiums
        bad = [
            {"differentials": [{**NIGHT, "name": ""}]},
            {"differentials": [NIGHT, {**NIGHT, "id": "x"}]},
            {"differentials": [{**NIGHT, "kind": "weird"}]},
            {"differentials": [{**NIGHT, "amount": 0}]},
            {"differentials": [{**NIGHT, "kind": "percent", "amount": 500}]},
            {"differentials": [{**NIGHT, "end": ""}]},
            {"differentials": [{**NIGHT, "end": "22:00"}]},
            {"differentials": [{**NIGHT, "start": "25:00"}]},
        ]
        for cfg in bad:
            with self.assertRaises(ValueError, msg=cfg):
                pay_premiums.save(self.db, CO1, {"enabled": True, **cfg}, "test")
        c = pay_premiums.clean({"enabled": True, "callBack": {"enabled": True, "minimumMin": 99999, "gapMin": -5}})
        self.assertEqual(c["callBack"], {"enabled": True, "minimumMin": 720, "gapMin": 0})

    def test_endpoints(self):
        from fastapi import HTTPException
        out = tc.get_pay_premiums(company=CO1, user=HR, db=self.db)
        self.assertFalse(out["enabled"])
        self.assertEqual(out["callBack"], {"enabled": False, "minimumMin": 120, "gapMin": 60})
        saved = tc.set_pay_premiums(tc.PayPremiumsIn(company=CO1, enabled=True, differentials=[NIGHT],
                                                     callBack=CALLBACK), user=HR, db=self.db)
        self.assertTrue(saved["enabled"])
        self.assertEqual(saved["differentials"][0]["start"], "22:00")
        self.assertFalse(tc.get_pay_premiums(company=CO2, user=HR, db=self.db)["enabled"])
        with self.assertRaises(HTTPException) as e:
            tc.set_pay_premiums(tc.PayPremiumsIn(company=CO1, enabled=True, differentials=[{**NIGHT, "amount": -1}]),
                                user=HR, db=self.db)
        self.assertEqual(e.exception.status_code, 400)
        with self.assertRaises(HTTPException) as e:
            tc.get_pay_premiums(company="no-such-company", user=HR, db=self.db)
        self.assertEqual(e.exception.status_code, 404)

    def test_pay_hidden_strips_the_new_amounts(self):
        _save(self.db, CO1, {"enabled": True, "differentials": [NIGHT], "callBack": CALLBACK})
        stripped = json.dumps(tc.strip_pay(tc._compute_timecard(self.db, A, PS, PE)))
        for k in ('"diffPay"', '"callBackPay"', '"pay"'):
            self.assertNotIn(k, stripped)
        self.assertIn('"diffMin"', stripped)


class PureMathTests(unittest.TestCase):
    def test_window_edges(self):
        import pay_premiums as pp
        r = {"start": "22:00", "end": "06:00", "days": [], "sites": []}
        t = lambda s: datetime.strptime(s, "%Y-%m-%d %H:%M")  # noqa: E731
        self.assertEqual(pp.qualifying_minutes(r, t("2026-09-14 21:00"), t("2026-09-14 23:00"), worked_min=120), 60)
        self.assertEqual(pp.qualifying_minutes(r, t("2026-09-15 05:00"), t("2026-09-15 07:00"), worked_min=120), 60)
        self.assertEqual(pp.qualifying_minutes(r, t("2026-09-14 06:00"), t("2026-09-14 22:00"), worked_min=960), 0)
        # A 24h-plus span would see two windows; the cap is the paid minutes.
        self.assertEqual(pp.qualifying_minutes(r, t("2026-09-14 20:00"), t("2026-09-15 08:00"), worked_min=600), 480)
        self.assertEqual(pp.qualifying_minutes(r, t("2026-09-14 20:00"), t("2026-09-15 08:00"), worked_min=300), 300)

    def test_rounding_of_money(self):
        import pay_premiums as pp
        self.assertEqual(pp.rule_pay({"kind": "flat", "amount": 1.25}, 7, 0), 0.15)      # 0.14583
        self.assertEqual(pp.rule_pay({"kind": "percent", "amount": 7.5}, 50, 19.99), 1.25)  # 1.2494


class WithCaBreakPremiumsTests(Base):
    """A CA employee with BOTH a night differential and a meal premium on one
    card (Oct 18 2026): two pay-class families side by side - each its own
    line in the totals, both in totalPay, both in the IIF / CSV, both frozen
    by finalize, both in Retro Pay's parts."""

    def setUp(self):
        super().setUp()
        _save(self.db, CO1, {"enabled": True, "differentials": [NIGHT]})
        import ca_breaks
        ca_breaks.add_premium(self.db, A, "2026-09-15", "meal", "mgr@greensglobal.com")
        self.db.commit()

    def test_both_families_compose(self):
        import ca_breaks
        card = tc._compute_timecard(self.db, A, PS, PE)
        T = card["totals"]
        self.assertEqual((T["diffMin"], T["diffPay"]), (555, 18.5))
        self.assertEqual((T["mealPremiumMin"], T["mealPremiumPay"]), (60, 20.0))
        with mock.patch.object(ca_breaks, "is_ca_rate", return_value=False):
            no_meal = tc._compute_timecard(self.db, A, PS, PE)["totals"]
        self.assertEqual(T["totalPay"], round(no_meal["totalPay"] + 20.0, 2))
        self.assertEqual(no_meal["diffPay"], 18.5)
        for k in ("regMin", "otMin", "dtMin", "workedMin", "regPay", "otPay", "dtPay"):
            self.assertEqual(T[k], no_meal[k], k)
        tue = next(d for d in card["days"] if d["date"] == "2026-09-15")
        self.assertEqual((tue["diffMin"], tue["mealPremiumMin"], tue["mealPremiumPay"]), (480, 60, 20.0))
        # IIF: both items on Tuesday, differentials first (their classes come first).
        iif = tc.export_iif(start=PS, end=PE, finalized_only=False, user=HR, _su={}, db=self.db).body.decode()
        tue_rows = [ln.split("\t")[5] for ln in iif.splitlines() if ln.startswith("TIMEACT\t9/15/2026\t") and "Alice" in ln]
        self.assertEqual(tue_rows[-2:], ["Shift Differential", "Meal Premium"])
        # CSV: both column sets, each only because it is present.
        head = _stream(tc.export_csv(start=PS, end=PE, mode="summary", user=HR, _su={}, db=self.db)).splitlines()[0]
        self.assertTrue(head.endswith("Approved,Shift Differential Hours,Shift Differential Pay,Call-Back Hours,"
                                      "Call-Back Pay,Meal Premium Hours,Meal Premium Pay,Rest Premium Hours,Rest Premium Pay"),
                        head)
        parts = rp._pay_parts(T)
        self.assertEqual((parts["premium"], parts["breakPremium"]), (round(T["diffPay"] + T["callBackPay"], 2), 20.0))

    def test_readiness_gross_matches_the_card(self):
        import payroll_readiness as pr
        card = tc._compute_timecard(self.db, A, PS, PE)
        self.assertEqual(pr.split_figures(card, PS, PE)["pay"], card["totals"]["totalPay"])
        self.assertGreater(card["totals"]["diffPay"], 0)

    def test_finalize_freezes_both(self):
        before = tc._compute_timecard(self.db, A, PS, PE)["totals"]
        tc.finalize_timecard(tc.FinalizeIn(email=A, start=PS, end=PE, allow_exceptions=True), user=HR, db=self.db)
        snap = json.loads(self.db.query(models.TimeApproval).filter_by(employee_email=A, kind="final").first().note)
        self.assertEqual(snap["premiums"]["differentials"][0]["name"], "Night Differential")
        self.assertEqual(snap["breakPremiums"], [{"date": "2026-09-15", "kind": "meal"}])
        # Rules off and the premium row removed after finalize: the paid card is unchanged.
        _save(self.db, CO1, {"enabled": False})
        self.db.query(models.TimeBreakPremium).filter_by(employee_email=A).update({"status": "removed"})
        self.db.commit()
        after = tc._compute_timecard(self.db, A, PS, PE)["totals"]
        for k in ("diffPay", "mealPremiumPay", "totalPay"):
            self.assertEqual(after[k], before[k], k)


if __name__ == "__main__":
    unittest.main()
