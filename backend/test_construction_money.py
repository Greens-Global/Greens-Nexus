"""Construction phase 4 - a job's money (Neil, 11/03/2026, plan
https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr).

Pins:
  * who sees Money: managers and above who may read the job and see its
    contract value (its own managers, or a manager by role in its company)
    AND hold the Accounting grant AND whose entity access includes the
    entity the job books to - anyone else gets {allowed: false} and not one
    figure; another company's job is a 404;
  * the books are read through the accounting proxy only, with `project=`
    and the entity as `location` (one entity), by item (the cost code), up
    to the jobsite's today;
  * actual = cost accounts only - expenses, and assets the chart of accounts
    does not mark as a bank, receivable, deposit, due-from, escrow, loan to,
    accumulated depreciation or prepaid ("Wells Fargo 4521" is a bank by its
    bank_kind, "Construction in Progress" is cost); titles only when the
    chart is unavailable; by cost code, else GL account;
  * budget = contract value + approved changes; requested-not-billed =
    approver-approved reimbursements (HR-approved and paid are listed, never
    summed; one still with its approver never shows); the filer's name only
    for their approver and HR; forecast = max(budget + pending, actual +
    requested); Over Budget on the cards, for a limited caller only their
    entity's jobs, for an administrator with no entity rows none;
  * mapping: Edit Job permission + Accounting access + the entity in reach;
    the code checked against the ledger-wide list (company-wide access); a
    code with no lines on the entity saves with a warning;
  * purchase requests and reimbursements take an optional job the requester
    may read - another company's job and an archived job are refused;
  * change orders read through job_changes() from construction_change_orders.

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
from construction_jobs_testkit import (A, ADMIN, CREW, MGR_A, MGR_A2, MGR_B, JobsBase)  # noqa: E402
from routers import accounting  # noqa: E402

GROUP = "grp-money-acct"
ADMIN4 = "adm4@greensglobal.com"     # an Administrator (level 4) with no entity rows
ENTITIES = [{"code": "15000", "name": "Greens Escondido, LLC.", "parent_code": None},
            {"code": "56000", "name": "MCD Services, Inc.", "parent_code": None}]
# One row per (account, item) as /reports/buckets?by=item answers.
ROWS = [
    {"account_no": "17100", "title": "Construction in Progress", "section": "asset", "bucket": "CC-100", "debit": 50000, "credit": 0},
    {"account_no": "61000", "title": "Repairs and Maintenance", "section": "expense", "bucket": "CC-200", "debit": 1200, "credit": 200},
    {"account_no": "61000", "title": "Repairs and Maintenance", "section": "expense", "bucket": "", "debit": 300, "credit": 0},
    {"account_no": "20000", "title": "Accounts Payable", "section": "liability", "bucket": "", "debit": 0, "credit": 51300},
    {"account_no": "10100", "title": "Operating Bank - Chase Checking", "section": "asset", "bucket": "", "debit": 0, "credit": 20000},
    {"account_no": "10200", "title": "Wells Fargo 4521", "section": "asset", "bucket": "", "debit": 7000, "credit": 0},
    {"account_no": "14000", "title": "Paid Ahead - Insurance", "section": "asset", "bucket": "", "debit": 800, "credit": 0},
    {"account_no": "40000", "title": "Rental Income", "section": "revenue", "bucket": "", "debit": 0, "credit": 900},
]
# The chart of accounts as /api/internal/accounts answers it.
CHART = [
    {"account_no": "17100", "title": "Construction in Progress", "section": "asset", "category": "Fixed Assets", "bank_kind": None},
    {"account_no": "10100", "title": "Operating Bank - Chase Checking", "section": "asset", "category": "Cash", "bank_kind": "checking"},
    {"account_no": "10200", "title": "Wells Fargo 4521", "section": "asset", "category": "Current Assets", "bank_kind": "checking"},
    {"account_no": "14000", "title": "Paid Ahead - Insurance", "section": "asset", "category": "Prepaid Expenses", "bank_kind": None},
    {"account_no": "61000", "title": "Repairs and Maintenance", "section": "expense", "category": "Operating Expenses"},
    {"account_no": "20000", "title": "Accounts Payable", "section": "liability"},
    {"account_no": "40000", "title": "Rental Income", "section": "revenue"},
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
        self.db.add(models.NexusEmployee(id=f"e-{ADMIN4}", first_name="Adm", last_name="Four", work_email=ADMIN4,
                                         status="active", deleted_at="", company=A))
        self.db.add(models.NexusRole(email=ADMIN4, role="administrator", assigned_by="test"))
        job = self.db.get(models.ConstructionProject, "pa")
        job.contract_value = 60000.0
        job.intacct_project_id = "PJ-104"
        job.intacct_entity = "15000"
        job.manager_emails = [MGR_A, MGR_A2]
        self.db.commit()
        cache.module_grants.invalidate()

        self.calls = []
        self.rows = list(ROWS)
        self.chart = list(CHART)

        async def fake_get(path, params):
            clean = {k: v for k, v in params.items() if v is not None}
            self.calls.append((path, clean))
            if path.endswith("/reports/locations"):
                return {"ok": True, "entities": ENTITIES}
            if path.endswith("/api/internal/accounts"):
                if self.chart is None:
                    raise accounting.UpstreamError(404, "Accounting service returned 404")
                return {"ok": True, "accounts": self.chart}
            if path.endswith("/reports/dimensions"):
                return {"ok": True, "kind": "project", "values": [{"code": "PJ-104", "name": "Escondido Phase 2", "lines": 40},
                                                                 {"code": "PJ-200", "name": "MCD Office", "lines": 3}]}
            if path.endswith("/reports/buckets"):
                if clean.get("by") == "project":
                    if clean.get("location") != "15000" or (clean.get("project") and "PJ-104" not in clean["project"].split(",")):
                        return {"ok": True, "rows": [], "labels": {}}
                    return {"ok": True, "rows": [{**r, "bucket": "PJ-104"} for r in self.rows], "labels": {"PJ-104": "Escondido Phase 2"}}
                return {"ok": True, "rows": self.rows, "labels": {"CC-100": "Site Work", "CC-200": "Gate and Fence"}}
            raise AssertionError(f"unexpected accounting call {path}")

        self._real_get = accounting._acct_get
        accounting._acct_get = fake_get

    def tearDown(self):
        accounting._acct_get = self._real_get
        super().tearDown()

    def money(self, job="pa"):
        return self.client.get(f"/construction/projects/{job}/money")

    def claim(self, status, amount, approver=MGR_A, employee=CREW, job="pa", vendor="Supply Co"):
        r = models.ExpenseReimbursement(id=str(uuid.uuid4()), employee_email=employee, employee_name="Crew Person",
                                        company=A, item=f"Claim {status}", category="supplies", details="x", vendor=vendor,
                                        amount=amount, currency="USD", approver_email=approver, receipts=[], status=status,
                                        history=[], created_at=f"2026-11-0{len(status) % 9 + 1}", updated_at="", job_id=job)
        self.db.add(r)
        self.db.commit()
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

    def test_money_follows_the_contract_value_rule(self):
        # Another company's manager put on the crew may read the job, never its money.
        job = self.db.get(models.ConstructionProject, "pa")
        job.worker_emails = [CREW, MGR_B]
        self.db.commit()
        self.as_(MGR_B)
        body = self.money().json()
        self.assertFalse(body["allowed"])
        self.assertEqual(body["reason"], "You do not have access to this job's money.")
        self.assertEqual(self.client.get("/construction/money/flags").json(), {"flags": {}})

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
        self.assertEqual(params["to"], body["asOf"])
        self.assertNotIn("locations", params)
        self.assertEqual(body["book"], "accrual")
        actual = body["actual"]
        # 50,000 CIP + 1,000 + 300 repairs; AP, both banks (the chart's
        # bank_kind - "Wells Fargo 4521" says nothing in its title), the
        # prepaid (the chart's category) and revenue left out.
        self.assertEqual(actual["amount"], 51300.0)
        self.assertEqual(actual["by"], "item")
        self.assertEqual([r["label"] for r in actual["rows"]], ["Site Work", "Gate and Fence", "No Cost Code"])
        self.assertEqual({a["account_no"] for a in actual["left"]}, {"20000", "10100", "10200", "14000", "40000"})
        self.assertEqual(body["link"]["entityName"], "Greens Escondido, LLC.")
        self.assertEqual(body["budget"], {"amount": 60000.0, "contractValue": 60000.0, "approvedChanges": 0.0, "source": "contract"})
        # The standard forecast: the larger of budget + pending and actual + requested.
        self.assertEqual(body["forecast"], 60000.0)
        self.assertEqual(body["variance"], 0.0)
        self.assertEqual(body["percentSpent"], round(51300 / 60000, 4))
        self.assertFalse(body["overBudget"])

    def test_cost_accounts_by_title_only_without_the_chart(self):
        self.assertTrue(construction_money.is_cost_account({"account_no": "17100", "title": "Construction in Progress", "section": "asset"},
                                                           construction_money.chart_index(CHART)))
        self.assertFalse(construction_money.is_cost_account({"account_no": "10200", "title": "Wells Fargo 4521", "section": "asset"},
                                                            construction_money.chart_index(CHART)))
        for title in ("Escrow Deposit - City", "Due From Greens Global", "Loan To Partner", "Accumulated Depreciation - Buildings",
                      "Prepaid Insurance", "Accounts Receivable"):
            self.assertFalse(construction_money.is_cost_account({"account_no": "x", "title": title, "section": "asset"}), title)
        self.chart = None
        self.as_(MGR_A)
        actual = self.money().json()["actual"]
        # No chart: titles decide - the two unnamed assets cannot be told apart from cost.
        self.assertEqual(actual["amount"], 51300.0 + 7000 + 800)

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
        self.assertIsNone(body["forecast"])
        self.assertIsNone(body["variance"])
        self.assertFalse(any(p.endswith("/buckets") for p, _ in self.calls))

    def test_tagged_requests_and_over_budget(self):
        self.as_(CREW)
        r = self.client.post("/requisitions", json={"employee_name": "Crew", "employee_dept": "Construction", "item": "Rebar",
                                                    "quantity": 40, "reason": "Footings", "job_id": "pa"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["job_id"], "pa")
        r = self.client.post("/reimbursements", json={"item": "Concrete bags", "amount": 9000, "category": "supplies",
                                                      "details": "Footings", "approver_email": MGR_A, "job_id": "pa"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual((r.json()["jobId"], r.json()["jobName"]), ("pa", "Job A"))
        self.as_(MGR_A)
        body = self.money().json()
        # Still with its approver: the employee's, not on the job's Money.
        self.assertEqual(body["spend"]["reimbursements"], [])
        self.assertEqual(body["committed"]["amount"], 0.0)
        rb = self.db.get(models.ExpenseReimbursement, r.json()["id"])
        rb.status = "approver_approved"
        self.db.commit()
        self.claim("hr_approved", 400)
        self.claim("paid", 300)
        self.claim("sent_back", 50)
        body = self.money().json()
        self.assertEqual(body["committed"], {"amount": 9000.0, "reimbursements": 1, "otherCurrency": 0, "purchaseRequests": 1})
        stages = sorted((x["stage"], x["amount"]) for x in body["spend"]["reimbursements"])
        self.assertEqual(stages, [("paid", 300.0), ("posting", 400.0), ("requested", 9000.0)])
        self.assertEqual({x["vendor"] for x in body["spend"]["reimbursements"]} - {"Supply Co"}, {""})
        # MGR_A approves these claims: the filer's name shows.
        self.assertTrue(all(x["requestedBy"] for x in body["spend"]["reimbursements"]))
        self.assertEqual(body["spend"]["purchaseRequests"][0]["item"], "Rebar")
        self.assertEqual(body["forecast"], 60300.0)
        self.assertTrue(body["overBudget"])
        flags = self.client.get("/construction/money/flags").json()["flags"]
        self.assertEqual(flags, {"pa": {"overBudget": True}})
        path, params = next(c for c in self.calls if c[1].get("by") == "project")
        self.assertEqual((params["project"], params["location"]), ("PJ-104", "15000"))
        # Another job manager who is neither the approver nor HR sees no names.
        self.as_(MGR_A2)
        body = self.money().json()
        self.assertTrue(body["spend"]["reimbursements"])
        self.assertEqual({x["requestedBy"] for x in body["spend"]["reimbursements"]}, {""})

    def test_flags_are_empty_for_crew(self):
        self.as_(CREW)
        self.assertEqual(self.client.get("/construction/money/flags").json(), {"flags": {}})

    def test_flags_for_a_limited_caller_and_an_administrator_with_no_entities(self):
        self.db.add(self.job("pc", "Job C", A, managers=[MGR_A, MGR_A2], contract_value=100.0,
                             intacct_project_id="PJ-200", intacct_entity="56000"))
        self.db.commit()
        self.as_(MGR_A)
        self.assertEqual(set(self.client.get("/construction/money/flags").json()["flags"]), {"pa", "pc"})
        self.as_(MGR_A2)
        self.assertEqual(set(self.client.get("/construction/money/flags").json()["flags"]), {"pa"})
        self.assertFalse(self.client.get("/construction/projects/pc/money").json()["allowed"])
        self.as_(ADMIN4)
        self.assertEqual(self.client.get("/construction/money/flags").json(), {"flags": {}})
        body = self.money().json()
        self.assertFalse(body["allowed"])

    # ── Mapping ──────────────────────────────────────────────────────────
    def test_mapping_checks_permission_entity_and_code(self):
        self.as_(CREW)
        self.assertEqual(self.client.put("/construction/projects/pa/books", json={"intacctProjectId": "PJ-200", "intacctEntity": "15000"}).status_code, 403)
        self.as_(MGR_A)
        r = self.client.put("/construction/projects/pa/books", json={"intacctProjectId": "PJ-999", "intacctEntity": "15000"})
        self.assertEqual(r.status_code, 422)
        r = self.client.put("/construction/projects/pa/books", json={"intacctProjectId": "PJ-200", "intacctEntity": ""})
        self.assertEqual(r.status_code, 422)
        # On the books, but no lines on this entity: saved, with a warning.
        r = self.client.put("/construction/projects/pa/books", json={"intacctProjectId": "PJ-200", "intacctEntity": "56000"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["link"], {"project": "PJ-200", "entity": "56000"})
        self.assertIn("no lines on entity 56000", r.json()["warning"])
        job = self.fresh(models.ConstructionProject, "pa")
        self.assertEqual((job.intacct_project_id, job.intacct_entity), ("PJ-200", "56000"))
        r = self.client.put("/construction/projects/pa/books", json={"intacctProjectId": "PJ-104", "intacctEntity": "15000"})
        self.assertEqual(r.json()["warning"], "")
        r = self.client.put("/construction/projects/pa/books", json={"intacctProjectId": "PJ-200", "intacctEntity": "56000"})
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
        self.assertEqual(r.json()["warning"], "")
        r = self.client.put("/construction/projects/pa/books", json={"intacctProjectId": "PJ-777", "intacctEntity": "15000"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("cannot check it against the other entities", r.json()["warning"])
        self.assertFalse(any(p.endswith("/dimensions") for p, _ in self.calls), "a limited caller never reads the ledger-wide list")
        picker = self.client.get("/construction/books/projects?entity=15000").json()
        self.assertTrue(picker["limited"])
        self.assertEqual([e["code"] for e in picker["entities"]], ["15000"])
        self.assertEqual(picker["codes"], [{"code": "PJ-104", "name": "Escondido Phase 2", "onEntity": True}])
        self.assertEqual(self.client.get("/construction/books/projects?entity=56000").status_code, 403)

    def test_picker_lists_every_code_for_company_wide_access(self):
        self.as_(MGR_A)
        picker = self.client.get("/construction/books/projects?entity=15000").json()
        self.assertFalse(picker["limited"])
        self.assertEqual([(c["code"], c["onEntity"]) for c in picker["codes"]], [("PJ-104", True), ("PJ-200", False)])
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

    def test_archived_jobs_take_no_spend_completed_ones_do(self):
        job = self.db.get(models.ConstructionProject, "pa")
        job.status = "complete"
        self.db.commit()
        self.as_(CREW)
        body = {"employee_name": "Crew", "employee_dept": "Construction", "item": "Saw", "quantity": 1, "reason": "x", "job_id": "pa"}
        self.assertEqual(self.client.post("/requisitions", json=body).status_code, 201)
        self.assertEqual([j["id"] for j in self.client.get("/construction/spend-jobs").json()["jobs"]], ["pa"])
        job = self.fresh(models.ConstructionProject, "pa")
        job.status, job.archived = "archived", True
        self.db.commit()
        r = self.client.post("/requisitions", json=body)
        self.assertEqual(r.status_code, 422)
        self.assertIn("archived", r.json()["detail"])
        self.assertEqual(self.client.get("/construction/spend-jobs").json()["jobs"], [])

    # ── Changes ──────────────────────────────────────────────────────────
    def test_changes_are_empty_with_no_change_orders(self):
        self.db.query(models.ConstructionChangeOrder).filter_by(project_id="pa").delete()
        self.db.commit()
        self.assertEqual(construction_money.job_changes(self.db, "pa"), [])

    def test_changes_feed_budget_and_forecast_from_change_orders(self):
        """Phase 3's construction_change_orders: Signed = approved, Awaiting
        Approval and Sent = pending; draft, declined, void and deleted ones
        and another job's never count."""
        CO = models.ConstructionChangeOrder
        self.db.query(CO).filter(CO.project_id.in_(["pa", "pb"])).delete(synchronize_session=False)
        rows = (("signed", 5000, ""), ("awaiting_approval", 700, ""), ("sent", 500, ""),
                ("draft", 50, ""), ("declined", 999, ""), ("void", 3000, ""),
                ("signed", 4444, "2026-11-01T00:00:00"))
        for i, (status, amount, deleted) in enumerate(rows):
            self.db.add(CO(id=str(uuid.uuid4()), project_id="pa", number=f"CO-{i + 1:03d}", title="CO",
                           status=status, amount=amount, deleted_at=deleted))
        self.db.add(CO(id=str(uuid.uuid4()), project_id="pb", number="CO-001", status="signed", amount=7,
                       title="Other job", deleted_at=""))
        self.db.commit()
        got = construction_money.job_changes(self.db, "pa")
        self.assertEqual([(c["number"], c["status"], c["state"], c["amount"]) for c in got],
                         [("CO-001", "signed", "approved", 5000.0), ("CO-002", "awaiting_approval", "pending", 700.0),
                          ("CO-003", "sent", "pending", 500.0)])
        self.as_(MGR_A)
        body = self.money().json()
        self.assertEqual(body["budget"]["amount"], 65000.0)
        self.assertEqual((body["changes"]["approved"], body["changes"]["pending"]), (5000.0, 1200.0))
        self.assertEqual(len(body["changes"]["rows"]), 3)
        # max(65,000 + 1,200, 51,300 + 0)
        self.assertEqual(body["forecast"], 66200.0)
        self.assertEqual(body["variance"], -1200.0)
        self.db.query(CO).filter(CO.project_id.in_(["pa", "pb"])).delete(synchronize_session=False)
        self.db.commit()


if __name__ == "__main__":
    import unittest
    unittest.main()
