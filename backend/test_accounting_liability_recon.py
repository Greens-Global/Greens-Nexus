"""Accounting -> Account Reconciliations: mortgages, loans and credit lines
reconciled in Nexus (Charmi + Neil, 10/25-10/26, item 09) - as tests. The
statement's ending balance is saved against the ledger balance read on the
statement date; Mark Reconciled is refused unless the difference is 0.00; a
reconciled month is locked; only an Accounting admin reopens it, with a
reason, and the reopen is logged and audited; viewers read, editors save; a
person limited to certain entities reaches only theirs. The loans and the
ledger come from a stand-in for the accounting app - nothing leaves the
machine, nothing is sent to Intacct.

    python -m pytest test_accounting_liability_recon.py -q      (one file per process)
"""
import os
import unittest
import uuid

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException
from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models
from routers import accounting, accounting_liability_recon as lr, accounting_loan_plans, accounting_loans

models.Base.metadata.create_all(bind=database.engine)

ADMIN = "admin.liabrecon.test@greensglobal.com"       # accounting:full
EDITOR = "editor.liabrecon.test@greensglobal.com"
VIEWER = "viewer.liabrecon.test@greensglobal.com"
LIMITED = "limited.liabrecon.test@greensglobal.com"   # editor, entity 15000 only
EVERYONE = (ADMIN, EDITOR, VIEWER, LIMITED)
GROUPS = {
    "grp-liabrecon-test-a": ("accounting:full", (ADMIN,)),
    "grp-liabrecon-test-e": ("accounting:editor", (EDITOR, LIMITED)),
    "grp-liabrecon-test-v": ("accounting:viewer", (VIEWER,)),
}
LOANS = [
    {"id": "LR-T1", "lender": "F&M Bank Mortgage", "entity_code": "15000", "gl_account": "25100", "is_active": True},
    {"id": "LR-T2", "lender": "Golden 1 Line of Credit", "entity_code": "12000", "gl_account": "25200", "is_active": True},
    {"id": "LR-T3", "lender": "No GL Loan", "entity_code": "15000", "gl_account": "", "is_active": True},
]
# What the ledger owes per GL on a date (positive = owed).
LEDGER = {("15000", "2026-09-30"): {"25100": 412_345.67}, ("15000", "2026-09-25"): {"25100": 413_000.00}, ("12000", "2026-09-30"): {"25200": 50_000.00}}


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


class PureTests(unittest.TestCase):
    def test_period_and_dates(self):
        self.assertEqual(lr.check_period("2026-09"), "2026-09")
        for bad in ("2026-9", "09/2026", "2026-13", "", "2999-01"):
            with self.assertRaises(HTTPException):
                lr.check_period(bad)
        self.assertEqual(lr.month_end("2026-02"), "2026-02-28")
        self.assertEqual(lr.check_statement_date("2026-09", None), "2026-09-30")
        self.assertEqual(lr.check_statement_date("2026-09", "2026-09-25"), "2026-09-25")
        for bad in ("2026-10-01", "2026-09-31", "09/25/2026"):
            with self.assertRaises(HTTPException):
                lr.check_statement_date("2026-09", bad)

    def test_difference_and_balance(self):
        self.assertEqual(lr.difference(100.0, 99.5), 0.5)
        self.assertIsNone(lr.difference(None, 1.0))
        self.assertTrue(lr.balanced(lr.difference(412_345.67, 412_345.67)))
        self.assertTrue(lr.balanced(0.004))
        self.assertFalse(lr.balanced(0.01))
        self.assertFalse(lr.balanced(None))


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            for gid, (mods, members) in GROUPS.items():
                db.add(models.NexusGroup(id=gid, name=gid, allowed_modules=mods))
                for em in members:
                    db.add(models.NexusGroupMember(group_id=gid, email=em))
            db.add(models.NexusAccessScope(id=str(uuid.uuid4()), email=LIMITED, module_id="accounting", scope_type="ledger", scope_id="15000"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        self.sheet_calls = []

        async def fake_rows(scope, month):
            if scope["allowed"] is None:
                return list(LOANS)
            return [r for r in LOANS if r["entity_code"] in scope["allowed"]]

        async def fake_children(codes):
            return set(codes)

        async def fake_sheet(scope, entity, asof):
            self.sheet_calls.append((entity, asof))
            return {gl: {"title": "", "section": "liability", "amount": -v, "owed": v, "accountType": ""} for gl, v in LEDGER.get((entity, asof), {}).items()}

        self._rows, accounting_loans._loan_rows = accounting_loans._loan_rows, fake_rows
        self._kids, accounting._with_children = accounting._with_children, fake_children
        self._sheet, accounting_loans._balance_sheet = accounting_loans._balance_sheet, fake_sheet
        self._url, accounting_loan_plans._SUPABASE_URL = accounting_loan_plans._SUPABASE_URL, "https://abc.supabase.co"

    def tearDown(self):
        accounting_loans._loan_rows, accounting._with_children = self._rows, self._kids
        accounting_loans._balance_sheet = self._sheet
        accounting_loan_plans._SUPABASE_URL = self._url
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
            ids = tuple(r["id"] for r in LOANS)
            db.query(models.AccountingLiabilityRecon).filter(models.AccountingLiabilityRecon.loan_id.in_(ids)).delete(synchronize_session=False)
            db.query(models.AccountingLiabilityReconLog).filter(models.AccountingLiabilityReconLog.loan_id.in_(ids)).delete(synchronize_session=False)
            db.query(models.AuditLog).filter(models.AuditLog.user_email.in_(EVERYONE)).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_(tuple(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id.in_(tuple(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email.in_(EVERYONE)).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _logs(self, loan_id):
        db = database.SessionLocal()
        try:
            return [x.action for x in db.query(models.AccountingLiabilityReconLog).filter(models.AccountingLiabilityReconLog.loan_id == loan_id).order_by(models.AccountingLiabilityReconLog.at).all()]
        finally:
            db.close()

    def test_save_then_reconcile_only_at_zero_difference(self):
        _as(EDITOR)
        d = self.client.get("/accounting/liability-recons/LR-T1/2026-09").json()
        self.assertEqual((d["asOf"], d["ledgerBalance"], d["record"], d["difference"]), ("2026-09-30", 412_345.67, None, None))
        # A statement 100.00 off is saved, but cannot be marked Reconciled.
        r = self.client.put("/accounting/liability-recons/LR-T1/2026-09", json={"statementBalance": 412_445.67})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["record"]["difference"], r.json()["record"]["status"]), (100.0, "open"))
        r = self.client.put("/accounting/liability-recons/LR-T1/2026-09", json={"statementBalance": 412_445.67, "reconcile": True})
        self.assertEqual(r.status_code, 400)
        self.assertIn("0.00", r.json()["detail"])
        # At 0.00 it reconciles, with who and when.
        url = "https://abc.supabase.co/storage/v1/object/public/task-files/accounting/liability-recons/LR-T1/sep.pdf"
        r = self.client.put("/accounting/liability-recons/LR-T1/2026-09", json={"statementBalance": 412_345.67, "statementUrl": url, "statementName": "sep.pdf", "note": "Lender statement", "reconcile": True})
        self.assertEqual(r.status_code, 200, r.text)
        rec = r.json()["record"]
        self.assertEqual((rec["status"], rec["difference"], rec["statementDate"], rec["statementUrl"], rec["glAccount"], rec["entityCode"]), ("reconciled", 0.0, "2026-09-30", url, "25100", "15000"))
        self.assertTrue(rec["reconciledBy"] and rec["reconciledAt"])
        # Locked: another save is refused.
        self.assertEqual(self.client.put("/accounting/liability-recons/LR-T1/2026-09", json={"statementBalance": 1}).status_code, 409)
        self.assertEqual(self._logs("LR-T1"), ["saved", "reconciled"])

    def test_ledger_read_on_the_statement_date(self):
        _as(EDITOR)
        r = self.client.put("/accounting/liability-recons/LR-T1/2026-09", json={"statementBalance": 413_000, "statementDate": "2026-09-25", "reconcile": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn(("15000", "2026-09-25"), self.sheet_calls)
        self.assertEqual(self.client.put("/accounting/liability-recons/LR-T2/2026-09", json={"statementBalance": 1, "statementDate": "2026-10-01"}).status_code, 400)

    def test_list_shows_last_reconciled_and_this_month(self):
        _as(EDITOR)
        self.client.put("/accounting/liability-recons/LR-T1/2026-08", json={"statementBalance": 0, "statementDate": "2026-08-31", "reconcile": True})
        self.client.put("/accounting/liability-recons/LR-T1/2026-09", json={"statementBalance": 5})
        got = self.client.get("/accounting/liability-recons?upto=2026-09").json()["loans"]["LR-T1"]
        self.assertEqual((got["last"]["period"], got["month"]["period"], got["month"]["status"]), ("2026-08", "2026-09", "open"))
        self.assertEqual(self.client.get("/accounting/liability-recons?upto=2026-07").json()["loans"], {})

    def test_reopen_is_admin_only_needs_a_reason_and_is_logged(self):
        _as(EDITOR)
        self.client.put("/accounting/liability-recons/LR-T2/2026-09", json={"statementBalance": 50_000, "reconcile": True})
        self.assertEqual(self.client.post("/accounting/liability-recons/LR-T2/2026-09/reopen", json={"reason": "typo"}).status_code, 403)
        _as(ADMIN)
        self.assertEqual(self.client.post("/accounting/liability-recons/LR-T2/2026-09/reopen", json={"reason": "  "}).status_code, 400)
        r = self.client.post("/accounting/liability-recons/LR-T2/2026-09/reopen", json={"reason": "Lender corrected the statement"})
        self.assertEqual(r.status_code, 200, r.text)
        rec = r.json()["record"]
        self.assertEqual((rec["status"], rec["reopenReason"]), ("open", "Lender corrected the statement"))
        self.assertEqual(self.client.post("/accounting/liability-recons/LR-T2/2026-09/reopen", json={"reason": "again"}).status_code, 409)
        self.assertEqual(self._logs("LR-T2"), ["reconciled", "reopened"])
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.AuditLog).filter(models.AuditLog.user_email == ADMIN, models.AuditLog.action == "liability_recon_reopened").count(), 1)
        finally:
            db.close()
        # Open again: the month can be saved.
        self.assertEqual(self.client.put("/accounting/liability-recons/LR-T2/2026-09", json={"statementBalance": 50_000}).status_code, 200)
        log = self.client.get("/accounting/liability-recons/LR-T2/2026-09").json()["log"]
        self.assertEqual([x["action"] for x in log][:2], ["saved", "reopened"])

    def test_viewer_reads_but_cannot_save(self):
        _as(VIEWER)
        self.assertEqual(self.client.get("/accounting/liability-recons/LR-T1/2026-09").status_code, 200)
        self.assertEqual(self.client.put("/accounting/liability-recons/LR-T1/2026-09", json={"statementBalance": 1}).status_code, 403)

    def test_limited_person_and_unknown_loans(self):
        _as(LIMITED)
        self.assertEqual(self.client.get("/accounting/liability-recons/LR-T2/2026-09").status_code, 404)
        self.assertEqual(self.client.put("/accounting/liability-recons/LR-T2/2026-09", json={"statementBalance": 1}).status_code, 404)
        self.assertEqual(self.client.get("/accounting/liability-recons/NOPE/2026-09").status_code, 404)
        _as(EDITOR)
        self.client.put("/accounting/liability-recons/LR-T2/2026-09", json={"statementBalance": 1})
        _as(LIMITED)
        self.assertNotIn("LR-T2", self.client.get("/accounting/liability-recons?upto=2026-09").json()["loans"])

    def test_loan_without_gl_and_bad_file(self):
        _as(EDITOR)
        r = self.client.put("/accounting/liability-recons/LR-T3/2026-09", json={"statementBalance": 1})
        self.assertEqual(r.status_code, 400)
        self.assertIn("GL account", r.json()["detail"])
        self.assertIsNone(self.client.get("/accounting/liability-recons/LR-T3/2026-09").json()["ledgerBalance"])
        self.assertEqual(self.client.put("/accounting/liability-recons/LR-T1/2026-09", json={"statementBalance": 1, "statementUrl": "https://evil.example/x.pdf"}).status_code, 400)
        self.assertEqual(self.client.put("/accounting/liability-recons/LR-T1/2026-09", json={"statementBalance": 1, "reconcile": False}).json()["record"]["statementUrl"], "")


if __name__ == "__main__":
    unittest.main()
