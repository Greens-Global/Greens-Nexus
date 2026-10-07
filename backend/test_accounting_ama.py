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
                return {"ok": True, "sections": [{"key": "revenue", "accounts": [{"account_no": "41000", "amount": self.income.get(loc, 0)}]}]}
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
        pnl = [c[1] for c in self.calls if c[0].endswith("/reports/pnl")]
        self.assertEqual([(c["location"], c["from"], c["to"]) for c in pnl], [("15000", start, today.isoformat())])

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
        d = rows[down["id"]]
        self.assertEqual((d["billedYtd"], d["expectedYtd"], d["difference"]), (None, None, None))
        self.assertIn("did not answer", d["error"])
        self.assertIsNotNone(d["nextBilling"])

    def test_summary_year_bounds(self):
        _as(EDITOR)
        self.assertEqual(self.client.get(f"/accounting/ama/summary?year={YEAR + 1}").status_code, 400)
        self.assertEqual(self.client.get("/accounting/ama/summary?year=1999").status_code, 400)


if __name__ == "__main__":
    unittest.main()
