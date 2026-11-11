"""Construction Round Three item 2 - the client and cost codes, read from
Intacct (Neil, 11/11/2026, plan https://claude.ai/artifact/VqZSQRz41ffF1VGouJUKLJ).

Pins:
  * the client is one of Intacct's customers, set by the job's managers
    only; an unknown id is refused; Intacct's contact is copied as who
    signs unless one is typed; clearing it clears all four; each change is
    on the job's activity with before / after;
  * every reader of the job sees the client (no money in it);
  * a new change order's signer defaults to the client contact;
  * Money reads billed (revenue lines) and received (receivable credits)
    from the same Project-Job read as Actual - no extra call - and the
    open balance is worked out;
  * a commitment carries a cost code; Committed per code sits beside the
    actual; the cost code picker lists the job's own codes first.

Run: python -m pytest test_construction_client.py -q
"""
import os
import tempfile
import unittest

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ.pop("ANTHROPIC_API_KEY", None)

import cache                 # noqa: E402
import construction_money    # noqa: E402
import models                # noqa: E402
from construction_jobs_testkit import CREW, MGR_A, MGR_A2, MGR_B, JobsBase  # noqa: E402
from routers import accounting, accounting_partners  # noqa: E402

GROUP = "grp-client-acct"
PARTNERS = {
    "customer": [{"id": "C-GE", "name": "Greens Escondido, LLC.", "status": "active",
                  "contactName": "Dana Owens", "email": "Dana@GreensEscondido.com"}],
    "vendor": [{"id": "V-100", "name": "Acme Plumbing", "status": "active"}],
}
# /reports/buckets?by=item on the job's Project-Job: cost, revenue, receivable.
ITEM_ROWS = [
    {"account_no": "17100", "title": "Construction in Progress", "section": "asset", "bucket": "CC-100", "debit": 50000, "credit": 0},
    {"account_no": "17100", "title": "Construction in Progress", "section": "asset", "bucket": "CC-200", "debit": 8000, "credit": 0},
    {"account_no": "40100", "title": "Construction Revenue", "section": "revenue", "bucket": "", "debit": 0, "credit": 90000},
    {"account_no": "12000", "title": "Accounts Receivable", "section": "asset", "bucket": "", "debit": 90000, "credit": 60000},
]
LABELS = {"CC-100": "Sitework", "CC-200": "Concrete"}


async def fake_partners(params):
    q = (params.get("q") or "").lower()
    return [p for p in PARTNERS[params.get("kind") or "vendor"] if q in p["id"].lower() or q in p["name"].lower()]


class ClientTests(JobsBase):
    tmp_db = _tmp.name

    def setUp(self):
        super().setUp()
        for m in (models.NexusGroup, models.NexusGroupMember, models.NexusAccessScope, models.ConstructionCommitment,
                  models.Requisition, models.ExpenseReimbursement):
            self.db.query(m).delete(synchronize_session=False)
        self.db.add(models.NexusGroup(id=GROUP, name="Client Test Accounting", allowed_modules="accounting:viewer"))
        self.db.add(models.NexusGroupMember(group_id=GROUP, email=MGR_A))
        job = self.db.get(models.ConstructionProject, "pa")
        job.contract_value = 120000.0
        job.intacct_project_id = "PJ-104"
        job.intacct_entity = "15000"
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
            if path.endswith("/reports/dimensions"):
                return {"ok": True, "values": [{"code": "CC-100", "name": "Sitework"}, {"code": "CC-900", "name": "Landscaping"}]}
            if path.endswith("/reports/buckets"):
                if clean.get("by") == "vendor":
                    return {"ok": True, "rows": [], "labels": {}}
                return {"ok": True, "rows": ITEM_ROWS, "labels": LABELS}
            raise AssertionError(f"unexpected accounting call {path}")

        self._real_get, accounting._acct_get = accounting._acct_get, fake_get
        self._real_partners, accounting_partners._get = accounting_partners._get, fake_partners

    def tearDown(self):
        accounting._acct_get = self._real_get
        accounting_partners._get = self._real_partners
        super().tearDown()

    def set_client(self, **body):
        return self.client.put("/construction/projects/pa/client", json=body)

    # ── the client ──────────────────────────────────────────────────────────
    def test_the_client_is_an_intacct_customer_set_by_the_jobs_managers(self):
        self.as_(CREW)
        self.assertEqual(self.set_client(client_id="C-GE").status_code, 403)
        self.as_(MGR_B)
        self.assertEqual(self.set_client(client_id="C-GE").status_code, 404)
        # Review (11/11/2026): Intacct's customers carry contacts - a manager
        # without Accounting access neither searches nor sets them.
        job = self.db.get(models.ConstructionProject, "pa")
        job.manager_emails = [MGR_A, MGR_A2]
        self.db.commit()
        self.as_(MGR_A2)
        self.assertEqual(self.client.get("/construction/projects/pa/customers?q=a").status_code, 403)
        self.assertEqual(self.set_client(client_id="C-GE").status_code, 403)
        self.as_(MGR_A)
        self.assertEqual(self.set_client(client_id="C-NOPE").status_code, 422)
        found = self.client.get("/construction/projects/pa/customers?q=escondido").json()["customers"]
        self.assertEqual(found[0]["id"], "C-GE")
        r = self.set_client(client_id="C-GE")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["clientName"], r.json()["contactName"], r.json()["contactEmail"]),
                         ("Greens Escondido, LLC.", "Dana Owens", "dana@greensescondido.com"))
        typed = self.set_client(client_id="C-GE", contact_name="Sam Lee", contact_email="sam@x.com").json()
        self.assertEqual((typed["contactName"], typed["contactEmail"]), ("Sam Lee", "sam@x.com"))
        self.assertEqual(self.set_client(client_id="C-GE", contact_email="not an email").status_code, 422)
        acts = self.db.query(models.ConstructionActivity).filter_by(project_id="pa", type="client_set").all()
        self.assertEqual(len(acts), 2)
        self.assertEqual(acts[0].before["clientId"], "")
        self.as_(CREW)
        p = self.client.get("/construction/projects/pa").json()
        self.assertEqual((p["clientId"], p["clientName"], p["clientContactName"]), ("C-GE", "Greens Escondido, LLC.", "Sam Lee"))
        self.as_(MGR_A)
        cleared = self.set_client(client_id="").json()
        self.assertEqual((cleared["clientId"], cleared["contactName"]), ("", ""))

    def test_a_new_change_order_is_signed_by_the_client_contact(self):
        self.as_(MGR_A)
        self.set_client(client_id="C-GE")
        co = self.client.post("/construction/projects/pa/change-orders", json={"title": "Move the gas line"}).json()
        self.assertEqual((co["signerName"], co["signerEmail"]), ("Dana Owens", "dana@greensescondido.com"))
        typed = self.client.post("/construction/projects/pa/change-orders",
                                 json={"title": "Extra gate", "signer_name": "Pat Kim", "signer_email": "pat@x.com"}).json()
        self.assertEqual(typed["signerName"], "Pat Kim")

    # ── money ───────────────────────────────────────────────────────────────
    def test_billed_and_received_come_from_the_same_read(self):
        self.as_(MGR_A)
        m = self.client.get("/construction/projects/pa/money").json()
        self.assertEqual(m["actual"]["amount"], 58000)
        self.assertEqual(m["client"]["billed"]["amount"], 90000)
        self.assertEqual(m["client"]["received"]["amount"], 60000)
        self.assertEqual(m["client"]["open"], 30000)
        self.assertEqual([a["account_no"] for a in m["client"]["billed"]["accounts"]], ["40100"])
        reads = [c for c in self.calls if c[0].endswith("/reports/buckets")]
        self.assertEqual(len(reads), 1)
        self.as_(CREW)
        self.assertFalse(self.client.get("/construction/projects/pa/money").json()["allowed"])

    def test_commitments_carry_a_cost_code_and_committed_sits_by_code(self):
        self.as_(MGR_A)
        add = lambda code, amt: self.client.post("/construction/projects/pa/commitments",  # noqa: E731
                                                 json={"vendor_id": "V-100", "amount": amt, "cost_code": code, "title": "x"})
        self.assertEqual(add("CC-100", 40000).status_code, 201)
        self.assertEqual(add("", 5000).status_code, 201)
        self.assertEqual(add("bad code!!", 5000).status_code, 422)
        m = self.client.get("/construction/projects/pa/money").json()
        self.assertEqual(m["committedByCode"], {"CC-100": 40000, "": 5000})
        self.assertEqual(sorted(r["costCode"] for r in m["commitments"]["rows"]), ["", "CC-100"])
        cid = m["commitments"]["rows"][0]["id"]
        self.assertEqual(self.client.patch(f"/construction/commitments/{cid}", json={"cost_code": "CC-200"}).status_code, 200)
        self.assertEqual(self.db.get(models.ConstructionCommitment, cid).cost_code, "CC-200")

    def test_the_cost_code_picker_lists_the_jobs_codes_first(self):
        self.as_(MGR_A)
        codes = self.client.get("/construction/projects/pa/cost-codes").json()["codes"]
        self.assertEqual([c["code"] for c in codes], ["CC-100", "CC-200", "CC-900"])
        self.assertEqual([c["onJob"] for c in codes], [True, True, False])
        self.as_(CREW)
        self.assertEqual(self.client.get("/construction/projects/pa/cost-codes").status_code, 403)


class ClientSideRules(unittest.TestCase):
    def test_a_job_with_no_receivable_lines_has_no_open_balance(self):
        out = construction_money.client_side([ITEM_ROWS[2]])
        self.assertEqual((out["billed"]["amount"], out["received"]["amount"], out["open"]), (90000, 0, None))
