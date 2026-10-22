"""Accounting -> Reporting -> AMA, Asset Management Agreements (Oct 7) - as tests.

The arithmetic (billing dates kept on the start's day, periods elapsed in the
year, the next billing date, expected for a percent of revenue and for a flat
fee), the CRUD with its validation, editor / viewer levels, entity scope on
every read and write, and the summary read from the ledger - Billed YTD the
net credits on the fee GL in the manager entity (or the managed one),
Expected from the managed entity's P&L income - with a failed read answered
per agreement, never a 500. The accounting service is replaced by a recorder.

    python -m pytest test_accounting_ama.py -q
"""
import os
import unittest
import uuid
from datetime import date

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException
from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models
from routers import accounting, accounting_ama as ama

models.Base.metadata.create_all(bind=database.engine)

EDITOR = "editor.ama.test@greensglobal.com"      # accounting:editor, no limit
VIEWER = "viewer.ama.test@greensglobal.com"      # accounting:viewer
LIMITED = "limited.ama.test@greensglobal.com"    # accounting:editor, entity 56000 only
EVERYONE = (EDITOR, VIEWER, LIMITED)
GROUPS = {"grp-ama-test-e": ("accounting:editor", (EDITOR, LIMITED)), "grp-ama-test-v": ("accounting:viewer", (VIEWER,))}
ENTITIES = [
    {"code": "15000", "name": "Greens Escondido, LLC.", "parent_code": None},
    {"code": "56000", "name": "MCD Services, Inc.", "parent_code": None},
    {"code": "56000-1", "name": "MCD Services Sub", "parent_code": "56000"},
    {"code": "90000", "name": "Greens Asset Management", "parent_code": None},
]
YEAR = date.today().year
URL = "/accounting/ama/agreements"


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


def agreement(**kw):
    a = {"entityCode": "15000", "managerEntityCode": "", "status": "Active", "feeBasis": "flat", "feeRate": None, "flatAmount": 2500.0,
         "billingFrequency": "Monthly", "startDate": "2026-01-01", "endDate": "", "feeGlAccount": "", "agreementUrl": "", "notes": ""}
    a.update(kw)
    return a


class ArithmeticTests(unittest.TestCase):
    def test_add_months_clamps_to_month_end(self):
        self.assertEqual(ama.add_months(date(2026, 1, 31), 1), date(2026, 2, 28))
        self.assertEqual(ama.add_months(date(2026, 1, 31), 2), date(2026, 3, 31))
        self.assertEqual(ama.add_months(date(2026, 11, 15), 3), date(2027, 2, 15))

    def test_billing_dates_keep_the_start_day(self):
        got = list(ama.billing_dates(date(2026, 1, 31), "Monthly", date(2026, 4, 30)))
        self.assertEqual(got, [date(2026, 1, 31), date(2026, 2, 28), date(2026, 3, 31), date(2026, 4, 30)])

    def test_next_billing(self):
        nb = ama.next_billing
        self.assertEqual(nb(agreement(startDate="2026-01-01"), date(2026, 10, 7)), "2026-11-01")
        self.assertEqual(nb(agreement(startDate="2026-01-01"), date(2026, 11, 1)), "2026-12-01")    # after today, not today
        self.assertEqual(nb(agreement(startDate="2026-02-15", billingFrequency="Quarterly"), date(2026, 10, 7)), "2026-11-15")
        self.assertEqual(nb(agreement(startDate="2020-03-01", billingFrequency="Annually"), date(2026, 10, 7)), "2027-03-01")
        self.assertEqual(nb(agreement(startDate="2027-01-15"), date(2026, 10, 7)), "2027-01-15")     # not started yet
        self.assertEqual(nb(agreement(startDate="1990-01-31"), date(2026, 10, 7)), "2026-10-31")
        self.assertIsNone(nb(agreement(status="Ended", endDate="2026-12-31"), date(2026, 10, 7)))
        self.assertIsNone(nb(agreement(startDate="2026-01-01", endDate="2026-10-15"), date(2026, 10, 7)))  # next is past the end

    def test_periods_elapsed(self):
        pe = ama.periods_elapsed
        today = date(2026, 10, 7)
        self.assertEqual(pe(agreement(startDate="2026-01-01"), 2026, today), 10)                   # Jan 1 ... Oct 1
        self.assertEqual(pe(agreement(startDate="2024-05-20"), 2026, today), 9)                    # Jan 20 ... Sep 20
        self.assertEqual(pe(agreement(startDate="2025-02-01", billingFrequency="Quarterly"), 2026, today), 3)   # Feb, May, Aug
        self.assertEqual(pe(agreement(startDate="2026-04-01", endDate="2026-06-30"), 2026, today), 3)
        self.assertEqual(pe(agreement(startDate="2026-01-01"), 2025, today), 0)
        self.assertEqual(pe(agreement(startDate="2025-01-01"), 2025, today), 12)                   # a past year counts it all
        self.assertEqual(pe(agreement(startDate="2026-01-01", status="Ended"), 2026, today), 0)     # ended, no end date: nothing expected

    def test_expected(self):
        today = date(2026, 10, 7)
        self.assertEqual(ama.expected_flat(agreement(flatAmount=2500), 2026, today), 25000.0)
        self.assertEqual(ama.expected_percent(agreement(feeBasis="percent_revenue", feeRate=3.5), 100000), 3500.0)
        pnl = {"sections": [{"key": "revenue", "accounts": [{"amount": 80000}, {"amount": 15000}]}, {"key": "other_income", "accounts": [{"amount": 5000}]},
                            {"key": "expense", "accounts": [{"amount": 40000}]}]}
        self.assertEqual(ama.income_of(pnl), 100000.0)
        buckets = {"rows": [{"account_no": "40500", "credit": 3000, "debit": 0}, {"account_no": "40500", "credit": 0, "debit": 500}, {"account_no": "41000", "credit": 99, "debit": 0}]}
        self.assertEqual(ama.billed_of(buckets, "40500"), 2500.0)


class EndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(main.app)
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            for gid, (mods, members) in GROUPS.items():
                db.add(models.NexusGroup(id=gid, name=gid, allowed_modules=mods))
                for em in members:
                    db.add(models.NexusGroupMember(group_id=gid, email=em))
            db.add(models.NexusAccessScope(id=str(uuid.uuid4()), email=LIMITED, module_id="accounting", scope_type="ledger", scope_id="56000"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        accounting._ACCT_CACHE.clear()
        self.calls = []
        self.fail = set()
        self.income = {"15000": 100000.0, "56000-1": 20000.0}
        self.income_fn = None
        self.fees = {"90000": [("40500", 3000.0, 0.0)], "15000": [("40500", 1200.0, 200.0)], "56000-1": [("40500", 500.0, 0.0)]}

        async def fake_get(path, params):
            clean = {k: v for k, v in params.items() if v is not None}
            self.calls.append((path, clean))
            if path.endswith("/reports/locations"):
                return {"ok": True, "entities": ENTITIES}
            loc = clean.get("location")
            if loc in self.fail:
                raise HTTPException(status_code=424, detail="The accounting app did not answer.")
            if path.endswith("/reports/pnl"):
                amount = self.income_fn(loc, clean["from"], clean["to"]) if self.income_fn else self.income.get(loc, 0)
                return {"ok": True, "sections": [{"key": "revenue", "accounts": [{"account_no": "41000", "amount": amount}]}]}
            if path.endswith("/reports/buckets"):
                return {"ok": True, "rows": [{"bucket": "total", "account_no": gl, "credit": c, "debit": d} for gl, c, d in self.fees.get(loc, [])]}
            return {"ok": True}

        self._get, accounting._acct_get = accounting._acct_get, fake_get
        self._base, self._key = accounting._ACCT_BASE, accounting._ACCT_KEY
        accounting._ACCT_BASE, accounting._ACCT_KEY = "http://accounting.invalid", "test-key"

    def tearDown(self):
        accounting._acct_get = self._get
        accounting._ACCT_BASE, accounting._ACCT_KEY = self._base, self._key
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.AccountingAmaAgreement).filter(models.AccountingAmaAgreement.created_by.in_(EVERYONE)).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_(tuple(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id.in_(tuple(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email.in_(EVERYONE)).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _add(self, **kw):
        return self.client.post(URL, json=agreement(**kw))

    def test_crud_records_the_caller(self):
        _as(EDITOR)
        r = self._add(feeBasis="percent_revenue", feeRate=3.5, flatAmount=None, feeGlAccount="40500", agreementUrl="https://greens.egnyte.com/fl/abc", notes="Signed 01/01")
        self.assertEqual(r.status_code, 201, r.text)
        a = r.json()
        self.assertEqual((a["entityCode"], a["feeBasis"], a["feeRate"], a["flatAmount"], a["createdBy"], a["updatedBy"]), ("15000", "percent_revenue", 3.5, None, EDITOR, EDITOR))
        r = self.client.put(f"{URL}/{a['id']}", json=agreement(status="Pending Review", flatAmount=1000, managerEntityCode="90000"))
        self.assertEqual(r.status_code, 200, r.text)
        b = r.json()
        self.assertEqual((b["status"], b["feeBasis"], b["feeRate"], b["flatAmount"], b["managerEntityCode"]), ("Pending Review", "flat", None, 1000.0, "90000"))
        self.assertEqual([x["id"] for x in self.client.get(URL).json()["agreements"]], [a["id"]])
        self.assertEqual(self.client.delete(f"{URL}/{a['id']}").status_code, 204)
        self.assertEqual(self.client.get(URL).json()["agreements"], [])
        self.assertEqual(self.client.delete(f"{URL}/{a['id']}").status_code, 404)

    def test_validation(self):
        _as(EDITOR)
        cases = [
            (agreement(entityCode=""), "managed entity"),
            (agreement(managerEntityCode="15000"), "cannot be the managed"),
            (agreement(status="Paused"), "Status"),
            (agreement(feeBasis="percent_revenue", feeRate=None), "fee rate"),
            (agreement(feeBasis="percent_revenue", feeRate=120), "fee rate"),
            (agreement(flatAmount=0), "flat fee"),
            (agreement(billingFrequency="Weekly"), "Billing"),
            (agreement(startDate=""), "start date"),
            (agreement(startDate="2026-13-45"), "start date"),
            (agreement(endDate="2025-01-01"), "ends before"),
            (agreement(agreementUrl="javascript:alert(1)"), "http"),
            (agreement(agreementUrl="ftp://x.example/a"), "http"),
        ]
        for body, words in cases:
            r = self.client.post(URL, json=body)
            self.assertEqual(r.status_code, 400, (body, r.text))
            self.assertIn(words, r.json()["detail"])

    def test_viewer_reads_but_cannot_write(self):
        _as(EDITOR)
        a = self._add().json()
        _as(VIEWER)
        self.assertEqual(self.client.get(URL).status_code, 200)
        self.assertEqual(self.client.get("/accounting/ama/summary").status_code, 200)
        self.assertEqual(self._add().status_code, 403)
        self.assertEqual(self.client.put(f"{URL}/{a['id']}", json=agreement()).status_code, 403)
        self.assertEqual(self.client.delete(f"{URL}/{a['id']}").status_code, 403)

    def test_entity_scope(self):
        _as(EDITOR)
        mine = self._add(entityCode="56000-1").json()       # a child of the limited person's 56000
        theirs = self._add(entityCode="15000").json()
        _as(LIMITED)
        self.assertEqual([x["id"] for x in self.client.get(URL).json()["agreements"]], [mine["id"]])
        self.assertEqual([x["id"] for x in self.client.get("/accounting/ama/summary").json()["rows"]], [mine["id"]])
        self.assertEqual(self._add(entityCode="15000").status_code, 403)
        self.assertEqual(self._add(entityCode="56000", managerEntityCode="90000").status_code, 403)     # the manager is outside too
        self.assertEqual(self._add(entityCode="56000").status_code, 201)
        self.assertEqual(self.client.put(f"{URL}/{theirs['id']}", json=agreement(entityCode="56000")).status_code, 403)
        self.assertEqual(self.client.put(f"{URL}/{mine['id']}", json=agreement(entityCode="15000")).status_code, 403)
        self.assertEqual(self.client.delete(f"{URL}/{theirs['id']}").status_code, 403)
        self.assertEqual(self.client.delete(f"{URL}/{mine['id']}").status_code, 204)

    def test_summary_reads_the_ledger(self):
        _as(EDITOR)
        start = f"{YEAR}-01-01"
        pct = self._add(feeBasis="percent_revenue", feeRate=3.5, flatAmount=None, feeGlAccount="40500", startDate=start).json()
        flat = self._add(feeGlAccount="40500", managerEntityCode="90000", flatAmount=250, startDate=start).json()
        bare = self._add(entityCode="56000-1", flatAmount=100, startDate=start).json()       # no fee GL: nothing billed is read
        r = self.client.get(f"/accounting/ama/summary?year={YEAR}")
        self.assertEqual(r.status_code, 200, r.text)
        rows = {x["id"]: x for x in r.json()["rows"]}
        today = date.today()
        p = rows[pct["id"]]
        self.assertEqual((p["billingEntityCode"], p["billedYtd"], p["revenueYtd"], p["expectedYtd"], p["difference"], p["error"]),
                         ("15000", 1000.0, 100000.0, 3500.0, -2500.0, None))
        self.assertEqual(p["nextBilling"], ama.next_billing(pct, today))
        f = rows[flat["id"]]
        periods = today.month
        self.assertEqual((f["billingEntityCode"], f["billedYtd"], f["periodsElapsed"], f["expectedYtd"]), ("90000", 3000.0, periods, 250.0 * periods))
        self.assertEqual(f["difference"], round(3000.0 - 250.0 * periods, 2))
        b = rows[bare["id"]]
        self.assertEqual((b["billedYtd"], b["expectedYtd"], b["difference"]), (None, 100.0 * periods, None))
        # The fee is read in the manager entity, the income in the managed one, from Jan 1 through today.
        buckets = sorted(c[1]["location"] for c in self.calls if c[0].endswith("/reports/buckets"))
        self.assertEqual(buckets, ["15000", "90000"])
        # One P&L read per agreement (CR-03: every row shows the managed entity's gross).
        pnl = sorted((c[1]["location"], c[1]["from"], c[1]["to"]) for c in self.calls if c[0].endswith("/reports/pnl"))
        self.assertEqual(pnl, [("15000", start, today.isoformat())] * 2 + [("56000-1", start, today.isoformat())])
        self.assertEqual((p["grossRevenue"], p["calculatedFee"], p["feeTier"]), (100000.0, 3500.0, "percent"))
        self.assertEqual((f["grossRevenue"], f["calculatedFee"], f["feeTier"]), (100000.0, 250.0 * periods, "flat"))
        self.assertEqual((b["grossRevenue"], b["period"], b["periodFrom"], b["periodTo"]), (20000.0, "ytd", start, today.isoformat()))

    def test_a_failed_read_is_answered_per_agreement(self):
        _as(EDITOR)
        start = f"{YEAR}-01-01"
        ok = self._add(feeGlAccount="40500", managerEntityCode="90000", startDate=start).json()
        down = self._add(feeBasis="percent_revenue", feeRate=2, flatAmount=None, feeGlAccount="40500", startDate=start).json()
        self.fail = {"15000"}
        r = self.client.get("/accounting/ama/summary")
        self.assertEqual(r.status_code, 200, r.text)
        rows = {x["id"]: x for x in r.json()["rows"]}
        self.assertIsNone(rows[ok["id"]]["error"])
        self.assertEqual(rows[ok["id"]]["billedYtd"], 3000.0)
        # A flat fee does not need the gross: its failed read only blanks the gross.
        self.assertEqual((rows[ok["id"]]["grossRevenue"], rows[ok["id"]]["expectedYtd"] is not None), (None, True))
        self.assertIn("did not answer", rows[ok["id"]]["grossError"])
        d = rows[down["id"]]
        self.assertEqual((d["billedYtd"], d["expectedYtd"], d["difference"]), (None, None, None))
        self.assertIn("did not answer", d["error"])
        self.assertIsNotNone(d["nextBilling"])

    def test_summary_year_bounds(self):
        _as(EDITOR)
        self.assertEqual(self.client.get(f"/accounting/ama/summary?year={YEAR + 1}").status_code, 400)
        self.assertEqual(self.client.get("/accounting/ama/summary?year=1999").status_code, 400)
        self.assertEqual(self.client.get(f"/accounting/ama/summary?year={YEAR}&period=week1").status_code, 400)
        self.assertEqual(self.client.get(f"/accounting/ama/summary?year={YEAR - 1}&period=q4").status_code, 200)

    # ── CR-03: percent of gross above a threshold, else a flat fee ──────────
    def _tiered(self, **kw):
        base = dict(feeBasis="percent_or_flat", feeRate=3, flatAmount=3000, thresholdAmount=100000, thresholdBasis="")
        base.update(kw)
        return self._add(**base)

    def test_tiered_crud_and_validation(self):
        _as(EDITOR)
        r = self._tiered(thresholdBasis="period")
        self.assertEqual(r.status_code, 201, r.text)
        a = r.json()
        self.assertEqual((a["feeBasis"], a["feeRate"], a["flatAmount"], a["thresholdAmount"], a["thresholdBasis"]),
                         ("percent_or_flat", 3.0, 3000.0, 100000.0, "period"))
        # Back to a plain flat fee: the threshold is dropped, nothing else moves.
        b = self.client.put(f"{URL}/{a['id']}", json=agreement(flatAmount=500)).json()
        self.assertEqual((b["feeBasis"], b["flatAmount"], b["thresholdAmount"], b["thresholdBasis"]), ("flat", 500.0, None, ""))
        cases = [
            (dict(thresholdAmount=None), "threshold"),
            (dict(thresholdAmount=-1), "threshold"),
            (dict(thresholdBasis="weekly"), "annual or the period"),
            (dict(flatAmount=None), "flat fee"),
            (dict(feeRate=None), "fee rate"),
        ]
        for kw, words in cases:
            r = self._tiered(**kw)
            self.assertEqual(r.status_code, 400, (kw, r.text))
            self.assertIn(words, r.json()["detail"])

    def test_an_agreement_saved_before_cr03_reads_as_before(self):
        _as(EDITOR)
        a = self._add(feeBasis="percent_revenue", feeRate=3.5, flatAmount=None).json()
        db = database.SessionLocal()
        try:      # a row from before the columns existed
            row = db.query(models.AccountingAmaAgreement).filter(models.AccountingAmaAgreement.id == a["id"]).first()
            row.threshold_amount, row.threshold_basis = None, None
            db.commit()
        finally:
            db.close()
        got = self.client.get(URL).json()["agreements"][0]
        self.assertEqual((got["feeBasis"], got["feeRate"], got["thresholdAmount"], got["thresholdBasis"]), ("percent_revenue", 3.5, None, ""))
        self.assertEqual(self.client.get("/accounting/ama/summary").status_code, 200)

    def _ten_k_a_month(self, loc, from_, to):
        f, t = date.fromisoformat(from_), date.fromisoformat(to)
        return 10000.0 * ((t.year * 12 + t.month) - (f.year * 12 + f.month) + 1)

    def test_tiered_summary_annual_threshold(self):
        _as(EDITOR)
        y = YEAR - 1
        self.income_fn = self._ten_k_a_month
        a = self._tiered(startDate=f"{y}-01-01").json()
        get = lambda p: self.client.get(f"/accounting/ama/summary?year={y}&period={p}").json()["rows"][0]    # noqa: E731
        q1 = get("q1")       # Jan-Mar gross 30,000: the year so far is under 100,000 -> flat, 3 of 12 months of 3,000
        self.assertEqual((q1["periodFrom"], q1["periodTo"], q1["grossRevenue"], q1["testGross"], q1["feeTier"], q1["calculatedFee"]),
                         (f"{y}-01-01", f"{y}-03-31", 30000.0, 30000.0, "flat", 750.0))
        self.assertEqual((q1["thresholdUsed"], q1["thresholdBasisUsed"]), (100000.0, "annual"))
        q4 = get("q4")       # Jan-Dec gross 120,000 is over 100,000 -> 3% of the quarter's 30,000
        self.assertEqual((q4["grossRevenue"], q4["testGross"], q4["feeTier"], q4["calculatedFee"]), (30000.0, 120000.0, "percent", 900.0))
        self.assertEqual((q4["revenueYtd"], q4["expectedYtd"], q4["expectedTier"], q4["asOf"]), (120000.0, 3600.0, "percent", f"{y}-12-31"))
        m02 = get("m02")
        self.assertEqual((m02["periodFrom"], m02["periodTo"], m02["calculatedFee"], m02["expectedYtd"]), (f"{y}-02-01", f"{y}-02-28" if y % 4 else f"{y}-02-29", 250.0, 500.0))
        self.assertEqual(a["thresholdBasis"], "")

    def test_tiered_summary_period_threshold(self):
        _as(EDITOR)
        y = YEAR - 1
        self.income_fn = self._ten_k_a_month
        self._tiered(startDate=f"{y}-01-01", thresholdAmount=25000, thresholdBasis="period")
        r = self.client.get(f"/accounting/ama/summary?year={y}&period=q1").json()["rows"][0]
        self.assertEqual((r["testGross"], r["feeTier"], r["calculatedFee"]), (30000.0, "percent", 900.0))
        r = self.client.get(f"/accounting/ama/summary?year={y}&period=m01").json()["rows"][0]
        self.assertEqual((r["testGross"], r["feeTier"], r["calculatedFee"]), (10000.0, "flat", 250.0))

    def test_gl_accounts_for_the_picker(self):
        self.fees[None] = [("40500", 1.0, 0.0), ("41000", 2.0, 0.0), ("40500", 0.0, 1.0)]
        _as(EDITOR)
        r = self.client.get("/accounting/ama/accounts")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([a["code"] for a in r.json()["accounts"]], ["40500", "41000"])
        _as(LIMITED)      # read through the caller's entities
        self.client.get("/accounting/ama/accounts")
        self.assertEqual(self.calls[-1][1].get("location"), "56000")
        _as(VIEWER)
        self.assertEqual(self.client.get("/accounting/ama/accounts").status_code, 403)


class ThresholdArithmeticTests(unittest.TestCase):
    def tiered(self, **kw):
        return agreement(**{"feeBasis": "percent_or_flat", "feeRate": 3, "flatAmount": 3000, "thresholdAmount": 100000, **kw})

    def test_fee_for(self):
        a = self.tiered()
        self.assertEqual(ama.fee_for(a, 50000, 150000, 3), (1500.0, "percent"))
        self.assertEqual(ama.fee_for(a, 50000, 90000, 3), (750.0, "flat"))         # 3 of 12 months of a yearly 3,000
        self.assertEqual(ama.fee_for(a, 50000, 100000, 3), (750.0, "flat"))        # exactly at the threshold is not above it
        self.assertEqual(ama.fee_for(self.tiered(billingFrequency="Quarterly"), 0, 0, 1), (750.0, "flat"))
        self.assertEqual(ama.fee_for(self.tiered(billingFrequency="Annually"), 0, 0, 1), (3000.0, "flat"))
        # The older bases ignore any threshold.
        self.assertEqual(ama.fee_for(agreement(flatAmount=250, thresholdAmount=1), 9e9, 9e9, 4), (1000.0, "flat"))
        self.assertEqual(ama.fee_for(agreement(feeBasis="percent_revenue", feeRate=2, thresholdAmount=1e9), 1000, 0, 4), (20.0, "percent"))

    def test_defaults_fill_what_an_agreement_leaves_blank(self):
        from accounting_assumptions import MGMT_FEE_DEFAULT_THRESHOLD, MGMT_FEE_DEFAULT_THRESHOLD_BASIS
        self.assertEqual(ama.threshold_of(self.tiered(thresholdAmount=None)), MGMT_FEE_DEFAULT_THRESHOLD)
        self.assertEqual(ama.threshold_basis(self.tiered()), MGMT_FEE_DEFAULT_THRESHOLD_BASIS)
        self.assertEqual(ama.threshold_basis(self.tiered(thresholdBasis="period")), "period")

    def test_period_window(self):
        pw = ama.period_window
        today = date(2026, 10, 23)
        self.assertEqual(pw(2026, "ytd", today), (date(2026, 1, 1), today))
        self.assertEqual(pw(2026, "q2", today), (date(2026, 4, 1), date(2026, 6, 30)))
        self.assertEqual(pw(2026, "q4", today), (date(2026, 10, 1), today))          # cut at today
        self.assertEqual(pw(2024, "m02", date(2024, 12, 31)), (date(2024, 2, 1), date(2024, 2, 29)))
        for bad in ("m11", "q5", "m13", "", "year"):
            with self.assertRaises(HTTPException):
                pw(2026, bad, today)

    def test_gross_accounts(self):
        spec = ama._account_spec("40000-49999, 70100")
        self.assertEqual(spec, [("40000", "49999"), ("70100", "70100")])
        self.assertTrue(ama.counts_as_gross("40500", spec))
        self.assertTrue(ama.counts_as_gross("70100", spec))
        self.assertFalse(ama.counts_as_gross("70200", spec))
        self.assertFalse(ama.counts_as_gross("5000", spec))
        self.assertTrue(ama.counts_as_gross("anything", []))
        pnl = {"sections": [{"key": "revenue", "accounts": [{"account_no": "40500", "amount": 100}, {"account_no": "70200", "amount": 7}]}]}
        old, ama.assume.MGMT_FEE_GROSS_ACCOUNTS = ama.assume.MGMT_FEE_GROSS_ACCOUNTS, "40000-49999"
        try:
            self.assertEqual(ama.income_of(pnl), 100.0)
        finally:
            ama.assume.MGMT_FEE_GROSS_ACCOUNTS = old
        self.assertEqual(ama.income_of(pnl), 107.0)


if __name__ == "__main__":
    unittest.main()
