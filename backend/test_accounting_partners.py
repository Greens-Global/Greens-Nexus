"""Accounting > Vendors & Customers change requests (Charmi and Neil, 10/01).

An edit becomes a pending request holding only the fields that differ; a
manager with the Accounting grant (or the Full level on it) approves or
declines it and the requester gets a bell; an approved request shows on
the record as its current values with the Awaiting Intacct flag; the CSV
of approved changes is one row per field. The accounting service is
replaced by a recorder - nothing leaves the machine.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_accounting_partners.py -q
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import accounting, accounting_partners  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

REQUESTER = "req.partners.test@greensglobal.com"     # accounting:viewer
MANAGER = "mgr.partners.test@greensglobal.com"       # accounting:full
LIMITED = "lim.partners.test@greensglobal.com"       # accounting:viewer, entity 15000 only
GROUP_V, GROUP_F = "grp-partners-test-viewer", "grp-partners-test-full"
EVERYONE = (REQUESTER, MANAGER, LIMITED)

VENDORS = [
    {"id": "V00012", "kind": "vendor", "name": "Acme Plumbing", "displayName": "Acme Plumbing", "taxId": "1234", "email": "ap@acme.com", "phone": "760-555-0100",
     "address": {"line1": "1 Main St", "line2": "", "city": "Escondido", "state": "CA", "zip": "92025", "country": "US"}, "terms": "Net 30", "status": "active", "entity": "15000", "updatedAt": ""},
    {"id": "V00013", "kind": "vendor", "name": "Bay Electric", "display_name": "Bay Electric", "email": "old@bay.com", "entity": "90000"},
    {"id": "V00014", "kind": "vendor", "name": "No Entity Supply", "entity": ""},
]
ENTITIES = [{"code": "15000", "name": "Greens Escondido", "parent_code": None}, {"code": "90000", "name": "Family Trust", "parent_code": None}]


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


class PartnerChangeTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP_V, name="Partners Test Viewers", allowed_modules="accounting:viewer"))
            db.add(models.NexusGroup(id=GROUP_F, name="Partners Test Managers", allowed_modules="accounting:full"))
            for em in (REQUESTER, LIMITED):
                db.add(models.NexusGroupMember(group_id=GROUP_V, email=em))
            db.add(models.NexusGroupMember(group_id=GROUP_F, email=MANAGER))
            db.add(models.NexusAccessScope(id="scope-partners-test", email=LIMITED, module_id="accounting", scope_type="ledger", scope_id="15000"))
            db.add(models.NexusEmployee(id="emp-partners-req", first_name="Amy", last_name="Bolanos", work_email=REQUESTER, status="active", deleted_at=""))
            db.add(models.NexusEmployee(id="emp-partners-mgr", first_name="Charmi", last_name="Desai", work_email=MANAGER, status="active", deleted_at=""))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        self.calls = []

        async def fake_partners(params):
            self.calls.append(params)
            return [dict(v) for v in VENDORS]

        async def fake_acct(path, params):
            return {"ok": True, "entities": ENTITIES}
        self._get, accounting_partners._get = accounting_partners._get, fake_partners
        self._acct, accounting._acct_get = accounting._acct_get, fake_acct

    def tearDown(self):
        accounting_partners._get = self._get
        accounting._acct_get = self._acct
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
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_((GROUP_V, GROUP_F))).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id.in_((GROUP_V, GROUP_F))).delete(synchronize_session=False)
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email.in_(EVERYONE)).delete(synchronize_session=False)
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email.in_(EVERYONE)).delete(synchronize_session=False))
            db.query(models.AccountingPartnerChange).delete(synchronize_session=False)
            db.query(models.NexusNotification).filter(models.NexusNotification.type.like("acct_partner_%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _bells(self, recipient):
        db = database.SessionLocal()
        try:
            return [(n.type, n.title, n.body) for n in db.query(models.NexusNotification)
                    .filter(models.NexusNotification.recipient == recipient, models.NexusNotification.type.like("acct_partner_%")).all()]
        finally:
            db.close()

    def _ask(self, changes=None, pid="V00012"):
        _as(REQUESTER)
        body = {"kind": "vendor", "partnerId": pid, "partnerName": "Acme Plumbing", "note": "Vendor called with the new number",
                "changes": changes or {"phone": {"from": "760-555-0100", "to": "760-555-0199"}, "address.city": {"from": "Escondido", "to": "San Marcos"},
                                       "email": {"from": "ap@acme.com", "to": "ap@acme.com"}, "nonsense": {"from": "", "to": "x"}}}
        return self.client.post("/accounting/partners/changes", json=body)

    # ── records ─────────────────────────────────────────────────────────────
    def test_records_come_through_with_entity_limit(self):
        _as(REQUESTER)
        r = self.client.get("/accounting/partners?kind=vendor&q=ac")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.calls[-1], {"kind": "vendor", "q": "ac"})
        ids = [p["id"] for p in r.json()["partners"]]
        self.assertEqual(ids, ["V00012", "V00013", "V00014"])
        self.assertEqual(r.json()["partners"][1]["displayName"], "Bay Electric")   # snake_case mapped
        _as(LIMITED)
        ids = [p["id"] for p in self.client.get("/accounting/partners?kind=vendor").json()["partners"]]
        self.assertEqual(ids, ["V00012", "V00014"], "another entity's vendor is out; one with no entity stays")
        self.assertEqual(self.client.get("/accounting/partners?kind=supplier").status_code, 400)

    def test_not_available_until_the_accounting_app_ships_it(self):
        from fastapi import HTTPException

        async def missing(params):
            raise HTTPException(status_code=501, detail=accounting_partners._NOT_READY)
        accounting_partners._get = missing
        _as(REQUESTER)
        r = self.client.get("/accounting/partners?kind=customer")
        self.assertEqual(r.status_code, 501)
        self.assertIn("accounting app needs its update", r.json()["detail"])

    # ── the request ─────────────────────────────────────────────────────────
    def test_create_keeps_only_real_changes_and_bells_the_deciders(self):
        r = self._ask()
        self.assertEqual(r.status_code, 201, r.text)
        out = r.json()
        self.assertEqual(out["status"], "pending")
        self.assertEqual(out["requestedByName"], "Amy Bolanos")
        self.assertEqual(sorted(out["changes"]), ["address.city", "phone"], "unchanged and unknown fields are dropped")
        bells = self._bells(MANAGER)
        self.assertEqual(len(bells), 1)
        self.assertEqual(bells[0][0], "acct_partner_change")
        self.assertIn("Acme Plumbing", bells[0][1])
        self.assertIn("Amy Bolanos", bells[0][2])
        self.assertEqual(self._bells(REQUESTER), [], "the requester is not told about their own ask")
        # The record now shows the pending flag; a second ask is refused.
        rec = next(p for p in self.client.get("/accounting/partners?kind=vendor").json()["partners"] if p["id"] == "V00012")
        self.assertTrue(rec["pendingChange"])
        self.assertFalse(rec["awaitingIntacct"])
        self.assertEqual(self._ask().status_code, 409)
        self.assertEqual(self._ask(changes={"email": {"from": "a", "to": "a"}}, pid="V00013").status_code, 400)

    def test_approve_overlays_the_record_and_bells_the_requester(self):
        cid = self._ask().json()["id"]
        _as(REQUESTER)
        self.assertEqual(self.client.post(f"/accounting/partners/changes/{cid}/approve", json={"note": ""}).status_code, 403, "a viewer cannot decide")
        _as(MANAGER)
        r = self.client.post(f"/accounting/partners/changes/{cid}/approve", json={"note": "ok"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "approved")
        self.assertEqual(r.json()["decidedByName"], "Charmi Desai")
        self.assertIn("Decision: ok", r.json()["note"])
        bells = self._bells(REQUESTER)
        self.assertEqual(len(bells), 1)
        self.assertEqual(bells[0][0], "acct_partner_decision")
        self.assertIn("approved", bells[0][1])
        # Approved = the record's current values, flagged Awaiting Intacct.
        rec = next(p for p in self.client.get("/accounting/partners?kind=vendor").json()["partners"] if p["id"] == "V00012")
        self.assertTrue(rec["awaitingIntacct"])
        self.assertFalse(rec["pendingChange"])
        self.assertEqual(rec["phone"], "760-555-0199")
        self.assertEqual(rec["address"]["city"], "San Marcos")
        self.assertEqual(rec["intacctValues"], {"phone": "760-555-0100", "address.city": "Escondido"})
        # Deciding twice is refused.
        self.assertEqual(self.client.post(f"/accounting/partners/changes/{cid}/decline", json={"note": ""}).status_code, 409)

    def test_decline_bells_the_requester_with_the_reason(self):
        cid = self._ask().json()["id"]
        _as(MANAGER)
        r = self.client.post(f"/accounting/partners/changes/{cid}/decline", json={"note": "Call the vendor first"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "declined")
        bells = self._bells(REQUESTER)
        self.assertEqual(len(bells), 1)
        self.assertIn("declined", bells[0][1])
        self.assertIn("Call the vendor first", bells[0][2])
        rec = next(p for p in self.client.get("/accounting/partners?kind=vendor").json()["partners"] if p["id"] == "V00012")
        self.assertFalse(rec["awaitingIntacct"])
        self.assertEqual(rec["phone"], "760-555-0100")
        _as(REQUESTER)
        statuses = {c["id"]: c["status"] for c in self.client.get("/accounting/partners/changes?kind=vendor").json()["changes"]}
        self.assertEqual(statuses[cid], "declined")
        self.assertEqual(self.client.get("/accounting/partners/changes?status=pending").json()["changes"], [])

    def test_export_lists_one_row_per_approved_field(self):
        cid = self._ask().json()["id"]
        _as(MANAGER)
        self.client.post(f"/accounting/partners/changes/{cid}/approve", json={"note": ""})
        r = self.client.get("/accounting/partners/changes/export.csv?status=approved&kind=vendor")
        self.assertEqual(r.status_code, 200)
        self.assertIn("attachment; filename=partner-changes-approved-vendor-", r.headers["content-disposition"])
        lines = r.text.strip().split("\r\n")
        self.assertEqual(lines[0], "Kind,Intacct ID,Name,Field,Intacct Value,New Value,Requested By,Requested On,Decided By,Decided On,Status,Note")
        self.assertEqual(len(lines), 3)
        self.assertTrue(lines[1].startswith("vendor,V00012,Acme Plumbing,phone,760-555-0100,760-555-0199,Amy Bolanos,"))
        self.assertIn(",Charmi Desai,", lines[1])
        self.assertIn(",approved,", lines[1])
        self.assertTrue(lines[2].startswith("vendor,V00012,Acme Plumbing,address.city,Escondido,San Marcos,"))
        self.assertEqual(self.client.get("/accounting/partners/changes/export.csv?status=pending").text.strip().count("\r\n"), 0, "nothing pending now")


if __name__ == "__main__":
    unittest.main()
