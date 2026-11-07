"""Construction Round Two item 8 - commitments and lien waivers (Neil,
11/06/2026, plan https://claude.ai/artifact/EpG2gQr8KVi1ZZRaM6zVBE).

Pins:
  * a commitment (subcontract / purchase order) is kept by the job's
    managers who may see its money; the vendor must be on Intacct's list;
    numbers run per job and kind (SC-001, PO-001);
  * Billed to Date is read from the books - the job's Project-Job lines by
    vendor, cost accounts only - never typed;
  * open = live commitments less what the vendor billed (never below zero,
    nothing for a vendor whose commitments are all closed); the forecast is
    max(budget + pending, actual + open + requested-not-billed);
  * a new amount needs a reason, kept with before and after; Void takes it
    out of every figure; nothing is deleted;
  * a lien waiver received is kept on the commitment, a removed one stays
    as a row; a vendor that billed with no waiver is flagged.

Run: python -m pytest test_construction_commitments.py -q
"""
import os
import tempfile

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ.pop("ANTHROPIC_API_KEY", None)

import cache                 # noqa: E402
import construction_money    # noqa: E402
import models                # noqa: E402
from construction_jobs_testkit import CREW, MGR_A, MGR_B, JobsBase  # noqa: E402
from routers import accounting, accounting_partners  # noqa: E402

GROUP = "grp-commit-acct"
VENDORS = [{"id": "V-100", "name": "Acme Plumbing", "status": "active"},
           {"id": "V-200", "name": "Bolt Electric", "status": "active"}]
ITEM_ROWS = [
    {"account_no": "17100", "title": "Construction in Progress", "section": "asset", "bucket": "CC-100", "debit": 50000, "credit": 0},
]
# /reports/buckets?by=vendor on the job's Project-Job.
VENDOR_ROWS = [
    {"account_no": "17100", "title": "Construction in Progress", "section": "asset", "bucket": "V-100", "debit": 30000, "credit": 0},
    {"account_no": "20000", "title": "Accounts Payable", "section": "liability", "bucket": "V-100", "debit": 0, "credit": 30000},
    {"account_no": "17100", "title": "Construction in Progress", "section": "asset", "bucket": "V-200", "debit": 20000, "credit": 0},
]


async def fake_vendors(params):
    q = (params.get("q") or "").lower()
    return [v for v in VENDORS if q in v["id"].lower() or q in v["name"].lower()]


class CommitmentTests(JobsBase):
    tmp_db = _tmp.name

    def setUp(self):
        super().setUp()
        for m in (models.NexusGroup, models.NexusGroupMember, models.NexusAccessScope, models.ConstructionCommitment,
                  models.Requisition, models.ExpenseReimbursement):
            self.db.query(m).delete(synchronize_session=False)
        self.db.add(models.NexusGroup(id=GROUP, name="Commit Test Accounting", allowed_modules="accounting:viewer"))
        for em in (MGR_A, MGR_B):
            self.db.add(models.NexusGroupMember(group_id=GROUP, email=em))
        job = self.db.get(models.ConstructionProject, "pa")
        job.contract_value = 60000.0
        job.intacct_project_id = "PJ-104"
        job.intacct_entity = "15000"
        job.manager_emails = [MGR_A]
        self.db.commit()
        cache.module_grants.invalidate()
        self.calls = []

        async def fake_get(path, params):
            clean = {k: v for k, v in params.items() if v is not None}
            self.calls.append((path, clean))
            if path.endswith("/reports/locations"):
                return {"ok": True, "entities": [{"code": "15000", "name": "Greens Escondido, LLC.", "parent_code": None}]}
            if path.endswith("/api/internal/accounts"):
                raise accounting.UpstreamError(404, "no chart")
            if path.endswith("/reports/buckets"):
                if clean.get("by") == "vendor":
                    return {"ok": True, "rows": VENDOR_ROWS, "labels": {}}
                if clean.get("by") == "project":
                    return {"ok": True, "rows": [{**r, "bucket": "PJ-104"} for r in ITEM_ROWS], "labels": {}}
                return {"ok": True, "rows": ITEM_ROWS, "labels": {}}
            raise AssertionError(f"unexpected accounting call {path}")

        self._real_get, accounting._acct_get = accounting._acct_get, fake_get
        self._real_vendors, accounting_partners._get = accounting_partners._get, fake_vendors

    def tearDown(self):
        accounting._acct_get = self._real_get
        accounting_partners._get = self._real_vendors
        super().tearDown()

    def add(self, vendor="V-100", amount=40000, kind="subcontract", **kw):
        return self.client.post("/construction/projects/pa/commitments",
                                json={"vendor_id": vendor, "amount": amount, "kind": kind, "title": "Plumbing", **kw})

    def money(self):
        return self.client.get("/construction/projects/pa/money").json()

    def test_only_job_managers_with_money_keep_commitments(self):
        self.as_(CREW)
        self.assertEqual(self.add().status_code, 403)
        self.as_(MGR_B)
        self.assertEqual(self.add().status_code, 404)          # another company's job
        self.as_(MGR_A)
        self.assertEqual(self.add(vendor="V-999").status_code, 422)   # not an Intacct vendor
        self.assertEqual(self.add(retainage_pct=25).status_code, 422)
        self.assertEqual(self.add(kind="lease").status_code, 422)
        self.assertEqual(self.add(amount=0).status_code, 422)

    def test_numbers_run_per_kind(self):
        self.as_(MGR_A)
        self.assertEqual(self.add().json()["number"], "SC-001")
        self.assertEqual(self.add(vendor="V-200", kind="purchase_order").json()["number"], "PO-001")
        self.assertEqual(self.add(vendor="V-200").json()["number"], "SC-002")
        row = self.db.query(models.ConstructionCommitment).filter_by(number="SC-001").one()
        self.assertEqual((row.vendor_name, row.amount, row.original_amount), ("Acme Plumbing", 40000.0, 40000.0))

    def test_billed_is_read_from_the_books_and_feeds_the_forecast(self):
        self.as_(MGR_A)
        self.add(retainage_pct=10)                     # Acme 40,000, billed 30,000 (AP line not counted)
        self.add(vendor="V-200", amount=15000)         # Bolt 15,000, billed 20,000 - over, open 0
        body = self.money()
        _, params = next(c for c in self.calls if c[1].get("by") == "vendor")
        self.assertEqual((params["project"], params["location"]), ("PJ-104", "15000"))
        cm = body["commitments"]
        rows = {r["vendorId"]: r for r in cm["rows"]}
        self.assertEqual(rows["V-100"]["billed"], 30000.0)
        self.assertEqual(rows["V-100"]["remaining"], 10000.0)
        self.assertEqual(rows["V-100"]["retainageHeld"], 3000.0)
        self.assertEqual([a["account_no"] for a in rows["V-100"]["billedAccounts"]], ["17100"])
        self.assertTrue(rows["V-100"]["waiverMissing"])
        self.assertEqual(rows["V-200"]["remaining"], 0.0)
        self.assertEqual((cm["total"], cm["open"]), (55000.0, 10000.0))
        # max(60,000 + 0, 50,000 actual + 10,000 open + 0 requested)
        self.assertEqual(body["forecast"], 60000.0)
        self.assertFalse(body["overBudget"])

    def test_unmapped_job_counts_the_whole_commitment_open(self):
        job = self.db.get(models.ConstructionProject, "pa")
        job.intacct_project_id = ""
        job.intacct_entity = ""
        self.db.commit()
        self.as_(MGR_A)
        self.add()
        cm = self.money()["commitments"]
        self.assertEqual((cm["open"], cm["billedKnown"]), (40000.0, False))
        self.assertIsNone(cm["rows"][0]["billed"])

    def test_amount_change_needs_a_reason_and_void_leaves_the_figures(self):
        self.as_(MGR_A)
        cid = self.add().json()["id"]
        self.assertEqual(self.client.patch(f"/construction/commitments/{cid}", json={"amount": 45000}).status_code, 422)
        r = self.client.patch(f"/construction/commitments/{cid}", json={"amount": 45000, "reason": "Added a hose bib"})
        self.assertEqual(r.status_code, 200)
        act = (self.db.query(models.ConstructionActivity)
               .filter_by(entity_id=cid, type="commitment_changed").one())
        self.assertEqual((act.before, act.after["amount"]), ({"amount": 40000.0}, 45000.0))
        self.assertEqual(self.money()["commitments"]["open"], 15000.0)
        self.client.patch(f"/construction/commitments/{cid}", json={"status": "void"})
        self.assertEqual(self.money()["commitments"]["rows"], [])
        self.assertIsNotNone(self.fresh(models.ConstructionCommitment, cid))
        self.assertEqual(self.client.patch(f"/construction/commitments/{cid}", json={"title": "x"}).status_code, 409)

    def test_closed_commitment_owes_nothing_more(self):
        self.as_(MGR_A)
        cid = self.add(amount=50000).json()["id"]
        self.assertEqual(self.money()["commitments"]["open"], 20000.0)
        self.client.patch(f"/construction/commitments/{cid}", json={"status": "closed"})
        self.assertEqual(self.money()["commitments"]["open"], 0.0)

    def test_waivers_are_kept_and_removed_ones_stay(self):
        self.as_(MGR_A)
        cid = self.add().json()["id"]
        url = f"/construction/commitments/{cid}/waivers"
        self.assertEqual(self.client.post(url, json={"kind": "maybe", "through_on": "2026-10-31"}).status_code, 422)
        self.assertEqual(self.client.post(url, json={"kind": "conditional_progress", "through_on": "10/31"}).status_code, 422)
        w1 = self.client.post(url, json={"kind": "unconditional_progress", "through_on": "2026-09-30", "amount": 20000}).json()["id"]
        self.client.post(url, json={"kind": "conditional_progress", "through_on": "2026-10-31", "amount": 30000})
        row = self.money()["commitments"]["rows"][0]
        self.assertEqual(row["lastWaiver"]["throughOn"], "2026-10-31")
        self.assertFalse(row["waiverMissing"])
        self.assertEqual(self.client.post(f"{url}/{w1}/remove").status_code, 200)
        self.assertEqual(self.client.post(f"{url}/{w1}/remove").status_code, 404)
        c = self.fresh(models.ConstructionCommitment, cid)
        self.assertEqual(len(c.waivers), 2)
        self.assertEqual(len(construction_money.live_waivers(c)), 1)
        self.as_(CREW)
        self.assertEqual(self.client.post(url, json={"kind": "conditional_progress", "through_on": "2026-10-31"}).status_code, 403)

    def test_flags_count_open_commitments(self):
        self.as_(MGR_A)
        self.add(amount=45000)                         # open 15,000 -> 50,000 + 15,000 > 60,000
        flags = self.client.get("/construction/money/flags").json()["flags"]
        self.assertTrue(flags["pa"]["overBudget"])
        self.assertEqual(flags["pa"]["forecast"], 65000.0)


if __name__ == "__main__":
    import unittest
    unittest.main()
