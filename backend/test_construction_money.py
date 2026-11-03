"""Construction phase 4 - a job's money (Neil, 11/03/2026, plan
https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr).

Pins:
  * who sees Money: managers and above who may read the job AND hold the
    Accounting grant AND whose entity access includes the entity the job
    books to - anyone else gets {allowed: false} and not one figure; another
    company's job is a 404;
  * the books are read through the accounting proxy only, with `project=`
    and the entity as `location` (one entity), by item (the cost code);
  * actual = cost accounts only (expenses and capitalized non-cash assets),
    by cost code when the lines carry one, else by GL account;
  * budget = contract value + approved changes; requested-not-billed = open
    tagged reimbursements; forecast worked out; Over Budget on the cards;
  * mapping: Edit Job permission + Accounting access + the entity in reach;
    the code checked against the ledger-wide list (company-wide access) or
    the entity's own lines (limited access);
  * purchase requests and reimbursements take an optional job the requester
    may read - another company's job is refused;
  * change orders read through job_changes(): [] with no table.

The accounting app is replaced by a recorder - nothing leaves the machine.

Run: python -m pytest test_construction_money.py -q
"""
import os
import tempfile
import uuid

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ.pop("ANTHROPIC_API_KEY", None)

import cache                 # noqa: E402
import construction_money    # noqa: E402
import models                # noqa: E402
from construction_jobs_testkit import (ADMIN, CREW, MGR_A, MGR_A2, MGR_B, JobsBase)  # noqa: E402
from routers import accounting  # noqa: E402

GROUP = "grp-money-acct"
ENTITIES = [{"code": "15000", "name": "Greens Escondido, LLC.", "parent_code": None},
            {"code": "56000", "name": "MCD Services, Inc.", "parent_code": None}]
# One row per (account, item) as /reports/buckets?by=item answers.
ROWS = [
    {"account_no": "17100", "title": "Construction in Progress", "section": "asset", "bucket": "CC-100", "debit": 50000, "credit": 0},
    {"account_no": "61000", "title": "Repairs and Maintenance", "section": "expense", "bucket": "CC-200", "debit": 1200, "credit": 200},
    {"account_no": "61000", "title": "Repairs and Maintenance", "section": "expense", "bucket": "", "debit": 300, "credit": 0},
    {"account_no": "20000", "title": "Accounts Payable", "section": "liability", "bucket": "", "debit": 0, "credit": 51300},
    {"account_no": "10100", "title": "Operating Bank - Chase Checking", "section": "asset", "bucket": "", "debit": 0, "credit": 20000},
    {"account_no": "40000", "title": "Rental Income", "section": "revenue", "bucket": "", "debit": 0, "credit": 900},
]


class MoneyTests(JobsBase):
    tmp_db = _tmp.name

    def setUp(self):
        super().setUp()
        for m in (models.NexusGroup, models.NexusGroupMember, models.NexusAccessScope, models.Requisition,
                  models.ExpenseReimbursement):
            self.db.query(m).delete(synchronize_session=False)
        self.db.add(models.NexusGroup(id=GROUP, name="Money Test Accounting", allowed_modules="accounting:viewer"))
        for em in (MGR_A, MGR_A2, MGR_B):
            self.db.add(models.NexusGroupMember(group_id=GROUP, email=em))
        # MGR_A2 reads entity 15000 only.
        self.db.add(models.NexusAccessScope(id=str(uuid.uuid4()), email=MGR_A2, module_id="accounting",
                                            scope_type="ledger", scope_id="15000"))
        job = self.db.get(models.ConstructionProject, "pa")
        job.contract_value = 60000.0
        job.intacct_project_id = "PJ-104"
        job.intacct_entity = "15000"
        job.manager_emails = [MGR_A, MGR_A2]
        self.db.commit()
        cache.module_grants.invalidate()

        self.calls = []
        self.rows = list(ROWS)

        async def fake_get(path, params):
            clean = {k: v for k, v in params.items() if v is not None}
            self.calls.append((path, clean))
            if path.endswith("/reports/locations"):
                return {"ok": True, "entities": ENTITIES}
            if path.endswith("/reports/dimensions"):
                return {"ok": True, "kind": "project", "values": [{"code": "PJ-104", "name": "Escondido Phase 2", "lines": 40},
                                                                 {"code": "PJ-200", "name": "MCD Office", "lines": 3}]}
            if path.endswith("/reports/buckets"):
                if clean.get("by") == "project":
                    return {"ok": True, "rows": [{**r, "bucket": "PJ-104"} for r in self.rows] if clean.get("location") == "15000" else [],
                            "labels": {"PJ-104": "Escondido Phase 2"}}
                return {"ok": True, "rows": self.rows, "labels": {"CC-100": "Site Work", "CC-200": "Gate and Fence"}}
            raise AssertionError(f"unexpected accounting call {path}")

        self._real_get = accounting._acct_get
        accounting._acct_get = fake_get

    def tearDown(self):
        accounting._acct_get = self._real_get
        super().tearDown()

    def money(self, job="pa"):
        r = self.client.get(f"/construction/projects/{job}/money")
        return r

    # ── Who sees it ──────────────────────────────────────────────────────
    def test_crew_and_managers_without_accounting_see_no_figure(self):
        self.as_(CREW)
        body = self.money().json()
        self.assertEqual(body, {"allowed": False, "reason": "Money is for managers and above."})
        self.db.query(models.NexusGroupMember).filter(models.NexusGroupMember.email == MGR_A).delete()
        self.db.commit()
        cache.module_grants.invalidate()
        self.as_(MGR_A)
        body = self.money().json()
        self.assertFalse(body["allowed"])
        self.assertEqual(body["reason"], "Money needs Accounting access.")
        self.assertEqual(self.calls, [], "no figure is read for someone who may not see it")

    def test_another_companys_job_is_a_404(self):
        self.as_(MGR_B)
        self.assertEqual(self.money("pa").status_code, 404)

    def test_entity_outside_access_hides_the_money(self):
        job = self.db.get(models.ConstructionProject, "pa")
        job.intacct_entity = "56000"
        self.db.commit()
        self.as_(MGR_A2)
        body = self.money().json()
        self.assertFalse(body["allowed"])
        self.assertNotIn("actual", body)
        self.assertFalse(any(p.endswith("/buckets") for p, _ in self.calls))

    # ── The figures ──────────────────────────────────────────────────────
    def test_actual_reads_the_books_by_project_and_entity(self):
        self.as_(MGR_A)
        body = self.money().json()
        self.assertTrue(body["allowed"] and body["mapped"])
        path, params = next(c for c in self.calls if c[0].endswith("/buckets"))
        self.assertEqual(params["project"], "PJ-104")
        self.assertEqual(params["location"], "15000")
        self.assertEqual(params["by"], "item")
        self.assertNotIn("locations", params)
        actual = body["actual"]
        # 50,000 CIP + 1,000 + 300 repairs; AP, the bank and revenue left out.
        self.assertEqual(actual["amount"], 51300.0)
        self.assertEqual(actual["by"], "item")
        self.assertEqual([r["label"] for r in actual["rows"]], ["Site Work", "Gate and Fence", "No Cost Code"])
        self.assertEqual({a["account_no"] for a in actual["left"]}, {"20000", "10100", "40000"})
        self.assertEqual(body["link"]["entityName"], "Greens Escondido, LLC.")
        self.assertEqual(body["budget"], {"amount": 60000.0, "contractValue": 60000.0, "approvedChanges": 0.0, "source": "contract"})
        self.assertEqual(body["forecast"], 51300.0)
        self.assertEqual(body["percentSpent"], round(51300 / 60000, 4))
        self.assertFalse(body["overBudget"])

    def test_by_gl_account_when_no_cost_code(self):
        self.rows = [{**r, "bucket": ""} for r in ROWS]
        self.as_(MGR_A)
        actual = self.money().json()["actual"]
        self.assertEqual(actual["by"], "account")
        self.assertEqual([r["code"] for r in actual["rows"]], ["17100", "61000"])

    def test_limited_caller_reads_their_entity(self):
        self.as_(MGR_A2)
        body = self.money().json()
        self.assertTrue(body["allowed"])
        self.assertEqual(body["actual"]["amount"], 51300.0)

    def test_unmapped_job_shows_nexus_figures_only(self):
        job = self.db.get(models.ConstructionProject, "pa")
        job.intacct_project_id = ""
        self.db.commit()
        self.as_(MGR_A)
        body = self.money().json()
        self.assertTrue(body["allowed"])
        self.assertFalse(body["mapped"])
        self.assertIsNone(body["actual"])
        self.assertIsNone(body["percentSpent"])
        self.assertFalse(any(p.endswith("/buckets") for p, _ in self.calls))

    def test_tagged_requests_are_requested_not_billed_and_flag_over_budget(self):
        self.as_(CREW)
        r = self.client.post("/requisitions", json={"employee_name": "Crew", "employee_dept": "Construction", "item": "Rebar",
                                                    "quantity": 40, "reason": "Footings", "job_id": "pa"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["job_id"], "pa")
        r = self.client.post("/reimbursements", json={"item": "Concrete bags", "amount": 9000, "category": "supplies",
                                                      "details": "Footings", "approver_email": MGR_A, "job_id": "pa"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["jobId"], "pa")
        self.assertEqual(r.json()["jobName"], "Job A")
        self.as_(MGR_A)
        body = self.money().json()
        self.assertEqual(body["committed"], {"amount": 9000.0, "reimbursements": 1, "otherCurrency": 0, "purchaseRequests": 1})
        self.assertEqual(body["spend"]["purchaseRequests"][0]["item"], "Rebar")
        self.assertEqual(body["forecast"], 60300.0)
        self.assertTrue(body["overBudget"])
        flags = self.client.get("/construction/money/flags").json()["flags"]
        self.assertEqual(flags, {"pa": {"overBudget": True}})
        path, params = next(c for c in self.calls if c[1].get("by") == "project")
        self.assertEqual((params["project"], params["location"]), ("PJ-104", "15000"))

    def test_flags_are_empty_for_crew(self):
        self.as_(CREW)
        self.assertEqual(self.client.get("/construction/money/flags").json(), {"flags": {}})

    # ── Mapping ──────────────────────────────────────────────────────────
    def test_mapping_checks_permission_entity_and_code(self):
        self.as_(CREW)
        self.assertEqual(self.client.put("/construction/projects/pa/books", json={"intacctProjectId": "PJ-200", "intacctEntity": "15000"}).status_code, 403)
        self.as_(MGR_A)
        r = self.client.put("/construction/projects/pa/books", json={"intacctProjectId": "PJ-999", "intacctEntity": "15000"})
        self.assertEqual(r.status_code, 422)
        r = self.client.put("/construction/projects/pa/books", json={"intacctProjectId": "PJ-200", "intacctEntity": ""})
        self.assertEqual(r.status_code, 422)
        r = self.client.put("/construction/projects/pa/books", json={"intacctProjectId": "PJ-200", "intacctEntity": "56000"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["link"], {"project": "PJ-200", "entity": "56000"})
        job = self.fresh(models.ConstructionProject, "pa")
        self.assertEqual((job.intacct_project_id, job.intacct_entity), ("PJ-200", "56000"))
        # The limited manager may not touch a job booked to an entity they cannot read.
        self.as_(MGR_A2)
        r = self.client.put("/construction/projects/pa/books", json={"intacctProjectId": "PJ-104", "intacctEntity": "15000"})
        self.assertEqual(r.status_code, 403)

    def test_limited_mapping_uses_the_entitys_own_lines(self):
        self.as_(MGR_A2)
        r = self.client.put("/construction/projects/pa/books", json={"intacctProjectId": "PJ-104", "intacctEntity": "56000"})
        self.assertEqual(r.status_code, 403)
        r = self.client.put("/construction/projects/pa/books", json={"intacctProjectId": "PJ-104", "intacctEntity": "15000"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(any(p.endswith("/dimensions") for p, _ in self.calls), "a limited caller never reads the ledger-wide list")
        picker = self.client.get("/construction/books/projects?entity=15000").json()
        self.assertTrue(picker["limited"])
        self.assertEqual([e["code"] for e in picker["entities"]], ["15000"])
        self.assertEqual(picker["codes"], [{"code": "PJ-104", "name": "Escondido Phase 2"}])
        self.assertEqual(self.client.get("/construction/books/projects?entity=56000").status_code, 403)

    def test_picker_lists_every_code_for_company_wide_access(self):
        self.as_(MGR_A)
        picker = self.client.get("/construction/books/projects?entity=56000").json()
        self.assertFalse(picker["limited"])
        self.assertEqual([c["code"] for c in picker["codes"]], ["PJ-104", "PJ-200"])
        self.as_(CREW)
        self.assertEqual(self.client.get("/construction/books/projects").status_code, 403)

    # ── Tagging at the source ────────────────────────────────────────────
    def test_tags_are_walled(self):
        self.as_(CREW)
        r = self.client.post("/requisitions", json={"employee_name": "Crew", "employee_dept": "Construction", "item": "Saw",
                                                    "quantity": 1, "reason": "x", "job_id": "pb"})
        self.assertEqual(r.status_code, 422)
        r = self.client.post("/reimbursements", json={"item": "Gloves", "amount": 20, "category": "supplies",
                                                      "details": "x", "approver_email": MGR_A, "job_id": "pb"})
        self.assertEqual(r.status_code, 422)
        r = self.client.post("/requisitions", json={"employee_name": "Crew", "employee_dept": "Construction", "item": "Saw",
                                                    "quantity": 1, "reason": "x"})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["job_id"], "")
        jobs = self.client.get("/construction/spend-jobs").json()["jobs"]
        self.assertEqual([j["id"] for j in jobs], ["pa"])
        self.as_(ADMIN)
        self.assertEqual({j["id"] for j in self.client.get("/construction/spend-jobs").json()["jobs"]}, {"pa", "pb"})

    # ── Changes ──────────────────────────────────────────────────────────
    def test_changes_are_empty_without_the_table(self):
        real = getattr(models, "ConstructionChangeOrder", None)
        models.ConstructionChangeOrder = None
        try:
            self.assertEqual(construction_money.job_changes(self.db, "pa"), [])
            models.ConstructionChangeOrder = _ChangeOrderNoTable
            self.assertEqual(construction_money.job_changes(self.db, "pa"), [])
        finally:
            models.ConstructionChangeOrder = real

    def test_changes_feed_budget_and_forecast_when_present(self):
        real = getattr(models, "ConstructionChangeOrder", None)
        _ChangeOrder.__table__.create(bind=self.db.get_bind(), checkfirst=True)
        self.db.query(_ChangeOrder).delete()
        for status, amount in (("approved", 5000), ("pending", 1200), ("rejected", 999), ("draft", 50)):
            self.db.add(_ChangeOrder(id=str(uuid.uuid4()), project_id="pa", status=status, amount=amount, title="CO"))
        self.db.add(_ChangeOrder(id=str(uuid.uuid4()), project_id="pb", status="approved", amount=7, title="Other job"))
        self.db.commit()
        models.ConstructionChangeOrder = _ChangeOrder
        try:
            self.as_(MGR_A)
            body = self.money().json()
        finally:
            models.ConstructionChangeOrder = real
        self.assertEqual(body["budget"]["amount"], 65000.0)
        self.assertEqual((body["changes"]["approved"], body["changes"]["pending"]), (5000.0, 1200.0))
        self.assertEqual(len(body["changes"]["rows"]), 2)
        self.assertEqual(body["forecast"], 52500.0)


# A stand-in for phase 3's change orders: job_changes reads whatever model
# models.ConstructionChangeOrder names, by project_id, status and amount.
from sqlalchemy import Column, Float, MetaData, String  # noqa: E402
from sqlalchemy.orm import declarative_base  # noqa: E402

_TestBase = declarative_base(metadata=MetaData())


class _ChangeOrder(_TestBase):
    __tablename__ = "test_money_change_orders"
    id = Column(String, primary_key=True)
    project_id = Column(String)
    status = Column(String)
    amount = Column(Float)
    title = Column(String)


class _ChangeOrderNoTable(_TestBase):
    __tablename__ = "test_money_change_orders_absent"
    id = Column(String, primary_key=True)
    project_id = Column(String)


if __name__ == "__main__":
    import unittest
    unittest.main()
