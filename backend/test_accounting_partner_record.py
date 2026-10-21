"""Accounting > Vendors & Customers: one record drilled into (Charmi, 10/16:
"drill down into a vendor - still can't").

GET /accounting/partners/record/{kind}/{id}: the record's fields (approved
changes overlaid), every change request filed on it, and its ledger activity
read through the accounting app's search with the caller's entities; held to
the same entity limit as the list. Read-only. The accounting service is
replaced by a recorder - nothing leaves the machine.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_accounting_partner_record.py -q
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import accounting, accounting_partners  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

VIEWER = "viewer.precord.test@greensglobal.com"     # accounting:viewer
LIMITED = "lim.precord.test@greensglobal.com"       # accounting:viewer, entity 15000 only
GROUP = "grp-precord-test-viewer"
EVERYONE = (VIEWER, LIMITED)
VENDORS = [
    {"id": "V00012", "kind": "vendor", "name": "Acme Plumbing", "displayName": "Acme Plumbing", "email": "ap@acme.com", "phone": "760-555-0100",
     "address": {"city": "Escondido"}, "terms": "Net 30", "status": "active", "entity": "15000"},
    {"id": "V00013", "kind": "vendor", "name": "Bay Electric", "entity": "90000", "status": "inactive"},
]
ENTITIES = [{"code": "15000", "name": "Greens Escondido", "parent_code": None}, {"code": "90000", "name": "Family Trust", "parent_code": None}]
SEARCH = {"ok": True, "total": 41, "debit": 5200.5, "credit": 1200.0,
          "rows": [{"line_id": "L1", "entry_id": "e1", "entry_no": "AP-9", "entry_date": "2026-09-30", "location": "15000", "location_name": "Greens Escondido",
                    "gl_code": "61000", "account_name": "Repairs", "description": "Batch", "memo": "Invoice 1182 - pipe", "debit": 400.0, "credit": 0}],
          "facets": {"entities": [{"code": "15000", "name": "Greens Escondido", "lines": 41, "net": 4000.5}],
                     "accounts": [{"code": "x", "name": "Repairs", "lines": 30, "net": 3000}]}}


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


class PartnerRecordTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP, name="Partner Record Test", allowed_modules="accounting:viewer"))
            for em in EVERYONE:
                db.add(models.NexusGroupMember(group_id=GROUP, email=em))
            db.add(models.NexusAccessScope(id="scope-precord-test", email=LIMITED, module_id="accounting", scope_type="ledger", scope_id="15000"))
            db.add(models.AccountingPartnerChange(id="chg-precord-1", kind="vendor", partner_id="V00012", partner_name="Acme Plumbing",
                                                  changes={"phone": {"from": "760-555-0100", "to": "760-555-0199"}}, status="approved",
                                                  requested_by=VIEWER, requested_at="2026-10-10T16:00:00+00:00", decided_by=VIEWER, decided_at="2026-10-11T16:00:00+00:00", note=""))
            db.add(models.AccountingPartnerChange(id="chg-precord-2", kind="vendor", partner_id="V00099", partner_name="Other",
                                                  changes={"phone": {"from": "", "to": "1"}}, status="pending", requested_by=VIEWER, requested_at="2026-10-12T16:00:00+00:00", note=""))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        accounting._ACCT_CACHE.clear()
        self.searches = []

        async def fake_partners(params):
            return [dict(v) for v in VENDORS]

        async def fake_acct(path, params):
            if path.endswith("/search"):
                self.searches.append({k: v for k, v in params.items() if v is not None})
                return SEARCH
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
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GROUP).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).delete(synchronize_session=False)
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email.in_(EVERYONE)).delete(synchronize_session=False)
            db.query(models.AccountingPartnerChange).filter(models.AccountingPartnerChange.id.like("chg-precord-%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def test_record_history_and_activity(self):
        _as(VIEWER)
        r = self.client.get("/accounting/partners/record/vendor/V00012")
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual((d["source"], d["record"]["id"], d["record"]["entity"], d["record"]["status"]), ("intacct", "V00012", "15000", "active"))
        self.assertEqual(d["record"]["phone"], "760-555-0199")                 # the approved change overlaid
        self.assertTrue(d["record"]["awaitingIntacct"])
        self.assertEqual([h["id"] for h in d["history"]], ["chg-precord-1"])    # only this record's requests
        a = d["activity"]
        self.assertEqual((a["total"], a["debit"], a["credit"]), (41, 5200.5, 1200.0))
        self.assertEqual(a["entities"][0]["code"], "15000")
        self.assertEqual(a["lines"][0]["memo"], "Invoice 1182 - pipe")
        self.assertEqual(self.searches[-1]["party_kind"], "vendor")
        self.assertEqual(self.searches[-1]["party"], "V00012")
        self.assertNotIn("location", self.searches[-1])                         # unlimited: every entity

    def test_entity_limit(self):
        _as(LIMITED)
        self.assertEqual(self.client.get("/accounting/partners/record/vendor/V00013").status_code, 404)   # another entity's vendor
        r = self.client.get("/accounting/partners/record/vendor/V00012")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.searches[-1]["location"], "15000")                # the ledger read is held to their entity
        self.assertEqual(self.client.get("/accounting/partners/record/vendor/V99999").status_code, 404)
        self.assertEqual(self.client.get("/accounting/partners/record/supplier/V00012").status_code, 400)

    def test_ledger_source_and_a_failed_ledger_read(self):
        async def missing(params):
            raise HTTPException(status_code=501, detail=accounting_partners._NOT_READY)

        async def acct(path, params):
            if path.endswith("/reports/dimensions"):
                return {"ok": True, "values": [{"code": "C00498", "name": "Zeta Tenant LLC", "lines": 12, "status": "inactive"}]}
            if path.endswith("/search"):
                raise HTTPException(status_code=424, detail="Accounting service: timeout")
            return {"ok": True, "entities": ENTITIES}
        accounting_partners._get = missing
        accounting._acct_get = acct
        _as(VIEWER)
        d = self.client.get("/accounting/partners/record/customer/C00498").json()
        self.assertEqual((d["source"], d["record"]["name"], d["record"]["status"], d["record"]["lines"]), ("ledger", "Zeta Tenant LLC", "inactive", 12))
        self.assertIsNone(d["activity"])
        self.assertEqual(d["activityError"], "Accounting service: timeout")
        self.assertEqual(d["history"], [])
        _as(LIMITED)
        self.assertEqual(self.client.get("/accounting/partners/record/customer/C00498").status_code, 403)

    def test_the_change_routes_still_win(self):
        """`/changes/export.csv` is two segments like nothing here - the
        record route has three, so it never shadows it."""
        _as(VIEWER)
        r = self.client.get("/accounting/partners/changes/export.csv?status=approved")
        # 200 (or 403 if the export is ever held to deciders) - never this route's 400 / 404.
        self.assertIn(r.status_code, (200, 403), r.text)
        if r.status_code == 200:
            self.assertIn("text/csv", r.headers["content-type"])


if __name__ == "__main__":
    unittest.main()
