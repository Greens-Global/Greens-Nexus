"""Accounting -> Loans: amortization schedules and stress scenarios per loan
(Charmi and Neil, 10/06) - as tests. A schedule is kept per loan, built or
uploaded; rows are dated, sorted and rounded; the bank's file must sit in our
private task-files storage; the expected balance for a month is the one
after the last payment in it; a person limited to certain entities can
neither read nor write the schedule of a loan outside them (404, like no
loan); viewers read, editors write. The loans come from a stand-in for the
accounting app - nothing leaves the machine.

    python -m pytest test_accounting_loan_plans.py -q      (one file per process)
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
from routers import accounting, accounting_loan_plans, accounting_loans

models.Base.metadata.create_all(bind=database.engine)

EDITOR = "editor.loanplans.test@greensglobal.com"
VIEWER = "viewer.loanplans.test@greensglobal.com"
LIMITED = "limited.loanplans.test@greensglobal.com"     # editor, entity 15000 only
EVERYONE = (EDITOR, VIEWER, LIMITED)
GROUPS = {"grp-loanplans-test-e": ("accounting:editor", (EDITOR, LIMITED)), "grp-loanplans-test-v": ("accounting:viewer", (VIEWER,))}
LOANS = [
    {"id": "LP-T1", "lender": "F&M Bank", "entity_code": "15000", "is_active": True},
    {"id": "LP-T2", "lender": "Golden 1", "entity_code": "12000", "is_active": True},
]
ROWS = [
    {"date": "2026-11-01", "payment": 1000, "interest": 400, "principal": 600, "balance": 99400},
    {"date": "2026-10-01", "payment": 1000, "interest": 500.004, "principal": 499.996, "balance": 100000},
]


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


class PureTests(unittest.TestCase):
    def test_clean_rows_sorts_numbers_and_rounds(self):
        rows = accounting_loan_plans.clean_rows(ROWS)
        self.assertEqual([r["date"] for r in rows], ["2026-10-01", "2026-11-01"])
        self.assertEqual([r["n"] for r in rows], [1, 2])
        self.assertEqual(rows[0]["interest"], 500.0)
        self.assertEqual(rows[0]["balloon"], 0.0)

    def test_clean_rows_refuses_bad_input(self):
        for bad in ([], [{"date": "10/01/2026"}], [{"date": "2026-02-30"}], [{"date": "2026-10-01", "payment": "abc"}], "x"):
            with self.assertRaises(HTTPException):
                accounting_loan_plans.clean_rows(bad)
        with self.assertRaises(HTTPException):
            accounting_loan_plans.clean_rows([{"date": "2026-10-01"}] * (accounting_loan_plans.MAX_ROWS + 1))

    def test_expected_balance(self):
        rows = accounting_loan_plans.clean_rows(ROWS)
        self.assertEqual(accounting_loan_plans.expected_balance(rows, "2026-09"), {"balance": 100500.0, "asOf": None, "n": 0})   # before the first payment: its balance + principal
        self.assertEqual(accounting_loan_plans.expected_balance(rows, "2026-10")["balance"], 100000)
        self.assertEqual(accounting_loan_plans.expected_balance(rows, "2027-03"), {"balance": 99400, "asOf": "2026-11-01", "n": 2})
        self.assertIsNone(accounting_loan_plans.expected_balance([], "2026-10"))

    def test_file_url(self):
        old = accounting_loan_plans._SUPABASE_URL
        try:
            accounting_loan_plans._SUPABASE_URL = "https://abc.supabase.co"
            ok = "https://abc.supabase.co/storage/v1/object/public/task-files/accounting/loan-schedules/LP-T1/x.xlsx"
            self.assertEqual(accounting_loan_plans.check_file_url(ok), ok)
            self.assertEqual(accounting_loan_plans.check_file_url(""), "")
            for bad in ("https://evil.example/x.xlsx", "https://abc.supabase.co/storage/v1/object/public/document-images/x.pdf"):
                with self.assertRaises(HTTPException):
                    accounting_loan_plans.check_file_url(bad)
        finally:
            accounting_loan_plans._SUPABASE_URL = old


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

        async def fake_rows(scope, month):
            if scope["allowed"] is None:
                return list(LOANS)
            return [r for r in LOANS if r["entity_code"] in scope["allowed"]]

        async def fake_children(codes):
            return set(codes)

        self._rows, accounting_loans._loan_rows = accounting_loans._loan_rows, fake_rows
        self._kids, accounting._with_children = accounting._with_children, fake_children
        self._url, accounting_loan_plans._SUPABASE_URL = accounting_loan_plans._SUPABASE_URL, "https://abc.supabase.co"

    def tearDown(self):
        accounting_loans._loan_rows, accounting._with_children = self._rows, self._kids
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
            db.query(models.AccountingLoanSchedule).filter(models.AccountingLoanSchedule.loan_id.in_(ids)).delete(synchronize_session=False)
            db.query(models.AccountingLoanStressScenario).filter(models.AccountingLoanStressScenario.loan_id.in_(ids)).delete(synchronize_session=False)
            db.query(models.AccountingLoanSetting).filter(models.AccountingLoanSetting.loan_id.in_(ids)).delete(synchronize_session=False)
            db.query(models.AccountingLoanStressEntity).filter(models.AccountingLoanStressEntity.updated_by.in_(EVERYONE)).delete(synchronize_session=False)
            db.query(models.AuditLog).filter(models.AuditLog.user_email.in_(EVERYONE)).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_(tuple(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id.in_(tuple(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email.in_(EVERYONE)).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def test_build_save_read_replace_delete(self):
        _as(EDITOR)
        self.assertIsNone(self.client.get("/accounting/loan-plans/LP-T1/schedule").json()["schedule"])
        r = self.client.put("/accounting/loan-plans/LP-T1/schedule", json={"source": "build", "params": {"principal": 100500, "ratePct": 6}, "rows": ROWS})
        self.assertEqual(r.status_code, 200, r.text)
        s = r.json()["schedule"]
        self.assertEqual((s["entityCode"], s["source"], len(s["rows"]), s["by"]), ("15000", "build", 2, EDITOR))
        # Replace with an upload: one schedule per loan, the build's params gone.
        url = "https://abc.supabase.co/storage/v1/object/public/task-files/accounting/loan-schedules/LP-T1/bank.xlsx"
        r = self.client.put("/accounting/loan-plans/LP-T1/schedule", json={"source": "upload", "params": {"x": 1}, "rows": ROWS[:1], "fileUrl": url, "fileName": "bank.xlsx", "columnMap": {"date": 0}})
        self.assertEqual(r.status_code, 200, r.text)
        s = self.client.get("/accounting/loan-plans/LP-T1/schedule").json()["schedule"]
        self.assertEqual((s["source"], s["fileUrl"], s["fileName"], s["params"], len(s["rows"])), ("upload", url, "bank.xlsx", {}, 1))
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.AccountingLoanSchedule).filter(models.AccountingLoanSchedule.loan_id == "LP-T1").count(), 1)
        finally:
            db.close()
        bad = self.client.put("/accounting/loan-plans/LP-T1/schedule", json={"source": "upload", "rows": ROWS, "fileUrl": "https://evil.example/x.xlsx"})
        self.assertEqual(bad.status_code, 400)
        exp = self.client.get("/accounting/loan-plans/expected?month=2026-12").json()
        self.assertEqual(exp["loans"]["LP-T1"]["balance"], 99400)
        self.assertEqual(self.client.delete("/accounting/loan-plans/LP-T1/schedule").json(), {"deleted": 1})

    def test_unknown_loan_is_404(self):
        _as(EDITOR)
        self.assertEqual(self.client.get("/accounting/loan-plans/NOPE/schedule").status_code, 404)

    def test_viewer_reads_but_cannot_write(self):
        _as(EDITOR)
        self.client.put("/accounting/loan-plans/LP-T2/schedule", json={"source": "build", "rows": ROWS})
        _as(VIEWER)
        self.assertEqual(len(self.client.get("/accounting/loan-plans/LP-T2/schedule").json()["schedule"]["rows"]), 2)
        self.assertEqual(self.client.put("/accounting/loan-plans/LP-T2/schedule", json={"source": "build", "rows": ROWS}).status_code, 403)
        self.assertEqual(self.client.post("/accounting/loan-plans/LP-T2/scenarios", json={"name": "x"}).status_code, 403)

    def test_limited_person_stays_in_their_entities(self):
        _as(EDITOR)
        self.client.put("/accounting/loan-plans/LP-T2/schedule", json={"source": "build", "rows": ROWS})
        _as(LIMITED)
        self.assertEqual(self.client.get("/accounting/loan-plans/LP-T2/schedule").status_code, 404)
        self.assertEqual(self.client.put("/accounting/loan-plans/LP-T2/schedule", json={"source": "build", "rows": ROWS}).status_code, 404)
        self.assertEqual(self.client.put("/accounting/loan-plans/LP-T1/schedule", json={"source": "build", "rows": ROWS}).status_code, 200)
        self.assertEqual(set(self.client.get("/accounting/loan-plans/expected?month=2026-12").json()["loans"]), {"LP-T1"})

    def test_scenarios(self):
        _as(EDITOR)
        self.assertEqual(self.client.post("/accounting/loan-plans/LP-T1/scenarios", json={"name": "  "}).status_code, 400)
        r = self.client.post("/accounting/loan-plans/LP-T1/scenarios", json={"name": "+200 bps", "params": {"shockBps": 200, "noi": 300000}})
        self.assertEqual(r.status_code, 201, r.text)
        sid = r.json()["scenario"]["id"]
        got = self.client.get("/accounting/loan-plans/LP-T1/scenarios").json()["scenarios"]
        self.assertEqual([(s["name"], s["params"]["shockBps"]) for s in got], [("+200 bps", 200)])
        self.assertEqual(self.client.delete(f"/accounting/loan-plans/LP-T1/scenarios/{sid}").status_code, 200)
        self.assertEqual(self.client.delete(f"/accounting/loan-plans/LP-T1/scenarios/{sid}").status_code, 404)

    # ── Stress Test page (Charmi, Oct 7) ────────────────────────────────────
    def _audits(self, action):
        db = database.SessionLocal()
        try:
            return db.query(models.AuditLog).filter(models.AuditLog.action == action, models.AuditLog.user_email.in_(EVERYONE)).count()
        finally:
            db.close()

    def test_addback_and_noi_basis_are_kept_per_entity_and_audited(self):
        _as(EDITOR)
        r = self.client.put("/accounting/loan-plans/stress-settings/15000", json={"addback": 25000.456, "addbackNote": "  Depreciation add-back  ", "noiBasis": "ytd"})
        self.assertEqual(r.status_code, 200, r.text)
        e = r.json()["entity"]
        self.assertEqual((e["addback"], e["addbackNote"], e["noiBasis"], e["noiManual"], e["by"]), (25000.46, "Depreciation add-back", "ytd", None, EDITOR))
        # Only the fields sent change; null clears a figure.
        self.client.put("/accounting/loan-plans/stress-settings/15000", json={"noiBasis": "manual", "noiManual": 310000})
        got = self.client.get("/accounting/loan-plans/stress-settings").json()
        self.assertEqual({k: got["entities"]["15000"][k] for k in ("addback", "addbackNote", "noiBasis", "noiManual")},
                         {"addback": 25000.46, "addbackNote": "Depreciation add-back", "noiBasis": "manual", "noiManual": 310000.0})
        self.client.put("/accounting/loan-plans/stress-settings/15000", json={"addback": None})
        self.assertIsNone(self.client.get("/accounting/loan-plans/stress-settings").json()["entities"]["15000"]["addback"])
        self.assertEqual(self._audits("accounting_loan_stress_entity_saved"), 3)
        self.assertEqual(self.client.put("/accounting/loan-plans/stress-settings/15000", json={"noiBasis": "budget"}).status_code, 400)
        # Viewers read, never write; a limited person only their entities.
        _as(VIEWER)
        self.assertEqual(self.client.put("/accounting/loan-plans/stress-settings/15000", json={"addback": 1}).status_code, 403)
        self.assertIn("15000", self.client.get("/accounting/loan-plans/stress-settings").json()["entities"])
        _as(EDITOR)
        self.client.put("/accounting/loan-plans/stress-settings/12000", json={"addback": 5})
        _as(LIMITED)
        self.assertEqual(self.client.put("/accounting/loan-plans/stress-settings/12000", json={"addback": 1}).status_code, 403)
        self.assertEqual(set(self.client.get("/accounting/loan-plans/stress-settings").json()["entities"]), {"15000"})

    def test_a_loan_is_left_out_of_the_stress_run_and_restored(self):
        _as(EDITOR)
        r = self.client.put("/accounting/loan-plans/LP-T1/stress-excluded", json={"excluded": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.client.get("/accounting/loan-plans/stress-settings").json()["excluded"], ["LP-T1"])
        self.client.put("/accounting/loan-plans/LP-T1/stress-excluded", json={"excluded": False})
        self.assertEqual(self.client.get("/accounting/loan-plans/stress-settings").json()["excluded"], [])
        self.assertEqual((self._audits("accounting_loan_stress_excluded"), self._audits("accounting_loan_stress_restored")), (1, 1))
        self.assertEqual(self.client.put("/accounting/loan-plans/NOPE/stress-excluded", json={"excluded": True}).status_code, 404)
        _as(LIMITED)
        self.assertEqual(self.client.put("/accounting/loan-plans/LP-T2/stress-excluded", json={"excluded": True}).status_code, 404)


if __name__ == "__main__":
    unittest.main()
