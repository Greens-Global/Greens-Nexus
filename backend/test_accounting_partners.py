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
        self.vendors = VENDORS

        async def fake_partners(params):
            self.calls.append(params)
            return [dict(v, address=dict(v.get("address") or {})) for v in self.vendors]

        async def fake_acct(path, params):
            return {"ok": True, "entities": ENTITIES}

        async def fake_as_of():
            return "2026-10-27T16:30:02Z"
        self._get, accounting_partners._get = accounting_partners._get, fake_partners
        self._acct, accounting._acct_get = accounting._acct_get, fake_acct
        self._as_of, accounting_partners._intacct_as_of = accounting_partners._intacct_as_of, fake_as_of

    def tearDown(self):
        accounting_partners._get = self._get
        accounting._acct_get = self._acct
        accounting_partners._intacct_as_of = self._as_of
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

    def test_ledger_list_until_the_accounting_app_ships_it(self):
        """Oct 14 (Neil: "not working at all"): with the partners route missing
        (501) the list is the ledger's vendor / customer codes - number, name,
        status - searched by number or name; a limited person is refused."""
        from fastapi import HTTPException

        async def missing(params):
            raise HTTPException(status_code=501, detail=accounting_partners._NOT_READY)

        asked = []

        async def dims(path, params):
            asked.append((path, params))
            return {"ok": True, "values": [{"code": "C00498", "name": "Zeta Tenant LLC", "lines": 12, "status": "active"},
                                           {"code": "C00012", "name": "Acme Leasing", "lines": 3}, {"code": "", "name": "blank"}]}
        accounting_partners._get = missing
        accounting._acct_get = dims
        _as(REQUESTER)
        r = self.client.get("/accounting/partners?kind=customer")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["source"], "ledger")
        self.assertEqual(asked[-1], ("/api/internal/reports/dimensions", {"kind": "customer"}))
        self.assertEqual([(p["id"], p["name"], p["status"], p["lines"]) for p in body["partners"]],
                         [("C00012", "Acme Leasing", "", 3), ("C00498", "Zeta Tenant LLC", "active", 12)])
        self.assertEqual([p["id"] for p in self.client.get("/accounting/partners?kind=customer&q=c00498").json()["partners"]], ["C00498"])
        self.assertEqual([p["id"] for p in self.client.get("/accounting/partners?kind=customer&q=acme").json()["partners"]], ["C00012"])
        _as(LIMITED)
        self.assertEqual(self.client.get("/accounting/partners?kind=customer").status_code, 403)

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
        self.assertIn("Approved", bells[0][1])
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
        self.assertIn("Declined", bells[0][1])
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

    # ── entity reach (Neil's review, Oct 20) ────────────────────────────────
    def test_requests_are_held_to_the_callers_entities(self):
        """A limited person sees and exports only the requests about partners
        of their entities (or with no entity), and cannot ask about another
        entity's partner; an unlimited person sees them all."""
        for pid, name in (("V00012", "Acme Plumbing"), ("V00013", "Bay Electric"), ("V00014", "No Entity Supply")):
            _as(REQUESTER)
            r = self.client.post("/accounting/partners/changes", json={"kind": "vendor", "partnerId": pid, "partnerName": name,
                                                                       "changes": {"taxId": {"from": "1", "to": "2"}}})
            self.assertEqual(r.status_code, 201, r.text)
        _as(REQUESTER)
        self.assertEqual(sorted(c["partnerId"] for c in self.client.get("/accounting/partners/changes").json()["changes"]),
                         ["V00012", "V00013", "V00014"])
        self.assertEqual(self.client.get("/accounting/partners/changes/export.csv?status=pending").text.count("V00013"), 1)
        _as(LIMITED)
        for q in ("", "?kind=vendor", "?status=pending"):
            ids = sorted(c["partnerId"] for c in self.client.get(f"/accounting/partners/changes{q}").json()["changes"])
            self.assertEqual(ids, ["V00012", "V00014"], q)
        csv_text = self.client.get("/accounting/partners/changes/export.csv?status=pending").text
        self.assertNotIn("V00013", csv_text, "another entity's tax ID change is not exported")
        self.assertIn("V00012", csv_text)
        self.assertIn("V00014", csv_text)
        body = {"kind": "vendor", "partnerId": "V00013", "changes": {"email": {"from": "old@bay.com", "to": "new@bay.com"}}}
        self.assertEqual(self.client.post("/accounting/partners/changes", json=body).status_code, 403)
        body["partnerId"] = "V99999"
        self.assertEqual(self.client.post("/accounting/partners/changes", json=body).status_code, 403, "an unknown record is outside reach")
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.AccountingPartnerChange).count(), 3, "the refused asks wrote nothing")
        finally:
            db.close()

    def test_limited_caller_sees_no_requests_while_records_are_unavailable(self):
        """With the partners route missing (501) nothing says which entity a
        record is in, so a limited caller sees no requests (the ledger list
        refuses them too); an unlimited caller still sees every request."""
        from fastapi import HTTPException
        self.assertEqual(self._ask().status_code, 201)

        async def missing(params):
            raise HTTPException(status_code=501, detail=accounting_partners._NOT_READY)
        accounting_partners._get = missing
        _as(REQUESTER)
        self.assertEqual(len(self.client.get("/accounting/partners/changes").json()["changes"]), 1)
        _as(LIMITED)
        self.assertEqual(self.client.get("/accounting/partners/changes").json()["changes"], [])
        self.assertEqual(self.client.post("/accounting/partners/changes", json={"kind": "vendor", "partnerId": "V00014",
                                          "changes": {"phone": {"from": "", "to": "1"}}}).status_code, 403)

    # ── Intacct catches up (chat triage 10/27/2026, item 15) ───────────────
    def _approved(self, pid, changes, requested_at, name="Aarav Desai", status="approved"):
        db = database.SessionLocal()
        try:
            row = models.AccountingPartnerChange(
                id=f"chg-{pid}-{requested_at[11:16]}", kind="vendor", partner_id=pid, partner_name=name, changes=changes, status=status,
                requested_by=REQUESTER, requested_at=requested_at, decided_by=MANAGER, decided_at=requested_at, note="")
            db.add(row)
            db.commit()
            return row.id
        finally:
            db.close()

    def _status(self, cid):
        db = database.SessionLocal()
        try:
            r = db.query(models.AccountingPartnerChange).filter(models.AccountingPartnerChange.id == cid).first()
            return r.status, r.intacct_seen_at, r.intacct_check
        finally:
            db.close()

    def test_approved_change_closes_once_intacct_holds_it(self):
        """V00045 (Charmi, 10/26): email and phone approved at 11:12, the phone
        restyled at 11:21, then keyed into Intacct. The next read sees Intacct
        holding them: both requests close as In Intacct, the badge goes and
        the record shows Intacct's own values."""
        first = self._approved("V00045", {"email": {"from": "", "to": "aaravsdesai@gmail.com"}, "phone": {"from": "", "to": "(949)745-3900"}},
                               "2026-10-26T18:12:00+00:00")
        second = self._approved("V00045", {"phone": {"from": "(949)745-3900", "to": "(949) 745-3900"}}, "2026-10-26T18:21:00+00:00")
        self.vendors = VENDORS + [{"id": "V00045", "kind": "vendor", "name": "Aarav Desai", "email": "AaravSDesai@gmail.com ", "phone": "949-745-3900", "entity": ""}]
        _as(REQUESTER)
        body = self.client.get("/accounting/partners?kind=vendor").json()
        self.assertEqual(body["intacctAsOf"], "2026-10-27T16:30:02Z")
        rec = next(p for p in body["partners"] if p["id"] == "V00045")
        self.assertFalse(rec["awaitingIntacct"])
        self.assertEqual(rec["intacctValues"], {})
        self.assertEqual(rec["intacctChanged"], {})
        self.assertEqual(rec["phone"], "949-745-3900", "Intacct's value, not Nexus's")
        for cid in (first, second):
            status, seen_at, check = self._status(cid)
            self.assertEqual(status, "in_intacct", cid)
            self.assertTrue(seen_at)
            self.assertEqual(check["phone"]["state"], "match")
        self.assertEqual(self._status(first)[2]["email"], {"state": "match", "intacct": "AaravSDesai@gmail.com "})
        # The requests list: nothing awaiting any more; the closed ones show under their own status.
        changes = self.client.get("/accounting/partners/changes?status=approved&kind=vendor").json()
        self.assertEqual(changes["changes"], [])
        self.assertEqual(changes["intacctAsOf"], "2026-10-27T16:30:02Z")
        seen = self.client.get("/accounting/partners/changes?status=in_intacct&kind=vendor").json()["changes"]
        self.assertEqual(sorted(c["id"] for c in seen), sorted((first, second)))
        self.assertTrue(all(c["intacctSeenAt"] and c["intacctCheck"] for c in seen))

    def test_a_change_still_waiting_stays_laid_over_the_record(self):
        """Intacct holds the approved email but still the old phone: only the
        phone is laid over, the request stays Approved - Awaiting Intacct."""
        cid = self._approved("V00012", {"email": {"from": "ap@acme.com", "to": "billing@acme.com"}, "phone": {"from": "760-555-0100", "to": "760-555-0199"}},
                             "2026-10-26T18:12:00+00:00", name="Acme Plumbing")
        self.vendors = [dict(VENDORS[0], email="billing@acme.com")] + VENDORS[1:]
        _as(REQUESTER)
        rec = next(p for p in self.client.get("/accounting/partners?kind=vendor").json()["partners"] if p["id"] == "V00012")
        self.assertTrue(rec["awaitingIntacct"])
        self.assertEqual(rec["intacctValues"], {"phone": "760-555-0100"})
        self.assertEqual(rec["phone"], "760-555-0199")
        self.assertEqual(rec["email"], "billing@acme.com")
        self.assertEqual(self._status(cid)[0], "approved")
        # The ledger's names-only list never closes anything (nothing to compare).
        from fastapi import HTTPException

        async def missing(params):
            raise HTTPException(status_code=501, detail=accounting_partners._NOT_READY)

        async def dims(path, params):
            return {"ok": True, "values": [{"code": "V00012", "name": "Acme Plumbing"}]}
        accounting_partners._get = missing
        accounting._acct_get = dims
        rec = self.client.get("/accounting/partners?kind=vendor").json()["partners"][0]
        self.assertTrue(rec["awaitingIntacct"])
        self.assertEqual(self._status(cid)[0], "approved")

    def test_a_value_changed_in_intacct_after_approval_shows_with_a_note(self):
        """Approved email, then someone keyed a different one in Intacct:
        Intacct's value shows, with the approved one in a note, and the
        request closes as Changed In Intacct (it is not exported again)."""
        cid = self._approved("V00012", {"email": {"from": "ap@acme.com", "to": "billing@acme.com"}}, "2026-10-26T18:12:00+00:00", name="Acme Plumbing")
        self.vendors = [dict(VENDORS[0], email="accounts@acme.com")] + VENDORS[1:]
        _as(REQUESTER)
        rec = self.client.get("/accounting/partners/record/vendor/V00012").json()["record"]
        self.assertEqual(rec["email"], "accounts@acme.com")
        self.assertFalse(rec["awaitingIntacct"])
        self.assertEqual(rec["intacctChanged"], {"email": {"intacct": "accounts@acme.com", "approved": "billing@acme.com", "approvedAt": "2026-10-26T18:12:00+00:00"}})
        status, _, check = self._status(cid)
        self.assertEqual(status, "intacct_changed")
        self.assertEqual(check, {"email": {"state": "changed", "intacct": "accounts@acme.com"}})
        # Still noted on the next read, while Intacct keeps that value.
        rec = next(p for p in self.client.get("/accounting/partners?kind=vendor").json()["partners"] if p["id"] == "V00012")
        self.assertIn("email", rec["intacctChanged"])

    def test_matching_ignores_spacing_case_and_phone_punctuation(self):
        state = accounting_partners._field_state
        self.assertEqual(state("phone", {"from": "", "to": "(949)745-3900"}, "949 745 3900"), "match")
        self.assertEqual(state("email", {"from": "", "to": "a@b.com"}, " A@B.com"), "match")
        self.assertEqual(state("address.line1", {"from": "1 Main St", "to": "2 Elm St"}, "1  main st"), "awaiting")
        self.assertEqual(state("address.line1", {"from": "1 Main St", "to": "2 Elm St"}, "3 Oak St"), "changed")
        self.assertEqual(state("email", {"from": "a@b.com", "to": "c@b.com"}, ""), "awaiting", "a blank in Intacct is not a change")
        self.assertEqual(state("taxId", {"from": "", "to": "95-1234567"}, "*****4567"), "match", "the masked tax ID by its last 4")
        self.assertEqual(state("taxId", {"from": "1111", "to": "95-1234567"}, "*****9999"), "awaiting", "never 'changed' on a masked value")

    # ── Intacct's vendor import file (item 15) ──────────────────────────────
    INTACCT_HEADER = "DONOTIMPORT,VENDOR_ID,NAME,TERM_NAME,ACTIVE,CONTACT_NAME,PRINT_AS,PHONE1,EMAIL1,ADDRESS1,ADDRESS2,CITY,STATE,ZIP,COUNTRY"

    def test_intacct_template_is_intacct_standard_vendor_template(self):
        t = accounting_partners.INTACCT_VENDOR_TEMPLATE
        self.assertEqual(len(t), 98)
        self.assertEqual(len(set(t)), 98)
        self.assertEqual(t[:5], ("DONOTIMPORT", "VENDOR_ID", "NAME", "PARENT_ID", "TERM_NAME"))
        self.assertEqual(t[48:50], ("R_CONTACT_NAME", "R_COMPANY_NAME"))
        self.assertEqual(t[71:73], ("P_CONTACT_NAME", "P_COMPANY_NAME"))
        self.assertEqual(t[-4:], ("APACCOUNT", "MERGE_PAYMENT_REQUESTS", "DEFAULT_LEAD_TIME", "BILLAPPROVERID"))
        self.assertEqual(",".join(accounting_partners.intacct_vendor_columns()), self.INTACCT_HEADER)
        self.assertNotIn("TAX_ID", accounting_partners.intacct_vendor_columns(), "Nexus holds the last 4 only - never blank or overwrite it")

    def test_export_is_intacct_vendor_import_file(self):
        """One row per vendor with Intacct's exact headers: the whole current
        record with the approved change laid on, so the import changes the
        phone and city and blanks nothing."""
        cid = self._ask().json()["id"]
        _as(MANAGER)
        self.client.post(f"/accounting/partners/changes/{cid}/approve", json={"note": ""})
        r = self.client.get("/accounting/partners/changes/export.csv?status=approved&kind=vendor&format=intacct")
        self.assertEqual(r.status_code, 409, "no contact name from Intacct yet: refused, never guessed")
        self.assertIn("V00012", r.json()["detail"])
        self.vendors = [dict(VENDORS[0], contactName="Acme Plumbing(V00012)")] + VENDORS[1:]
        r = self.client.get("/accounting/partners/changes/export.csv?status=approved&kind=vendor&format=intacct")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("attachment; filename=intacct-vendor-import-", r.headers["content-disposition"])
        lines = r.text.strip().split("\r\n")
        self.assertEqual(lines[0], self.INTACCT_HEADER)
        self.assertEqual(lines[1:], [",V00012,Acme Plumbing,Net 30,T,Acme Plumbing(V00012),Acme Plumbing,760-555-0199,ap@acme.com,1 Main St,,San Marcos,CA,92025,US"])
        self.assertEqual(self._status(cid)[0], "approved", "exporting does not close it; Intacct showing it does")
        # Once Intacct holds it, it is no longer in the file.
        self.vendors = [dict(VENDORS[0], contactName="Acme Plumbing(V00012)", phone="760-555-0199", address=dict(VENDORS[0]["address"], city="San Marcos"))] + VENDORS[1:]
        r = self.client.get("/accounting/partners/changes/export.csv?status=approved&kind=vendor&format=intacct")
        self.assertEqual(r.text.strip(), self.INTACCT_HEADER)
        self.assertEqual(self._status(cid)[0], "in_intacct")
        self.assertEqual(self.client.get("/accounting/partners/changes/export.csv?status=approved&kind=customer&format=intacct").status_code, 400)
        self.assertEqual(self.client.get("/accounting/partners/changes/export.csv?format=xml").status_code, 400)

    def test_sync_then_export_reads_each_vendor_fresh(self):
        """Backend test 10/27, problem 1: the export refused for up to 2
        minutes after Sync, because each vendor's one-record read sat in its
        own cache that the list's Sync did not refresh. Sync now drops those
        reads, so Sync then Export works right away."""
        cid = self._ask().json()["id"]
        _as(MANAGER)
        self.client.post(f"/accounting/partners/changes/{cid}/approve", json={"note": ""})
        fetched = []

        def fake_sync(params):
            fetched.append(params)
            return [dict(v, address=dict(v.get("address") or {})) for v in self.vendors]
        saved = (accounting_partners._get_sync, accounting._ACCT_BASE, accounting._ACCT_KEY)
        accounting_partners._get, accounting_partners._get_sync = self._get, fake_sync
        accounting._ACCT_BASE, accounting._ACCT_KEY = "http://acct.test", "test-key"
        accounting_partners._CACHE.clear()
        try:
            url = "/accounting/partners/changes/export.csv?status=approved&kind=vendor&format=intacct"
            self.assertEqual(self.client.get(url).status_code, 409, "no contact name from Intacct yet")
            self.vendors = [dict(VENDORS[0], contactName="Acme Plumbing(V00012)")] + VENDORS[1:]
            self.assertEqual(self.client.get(url).status_code, 409, "without Sync the 2-minute copy still answers")
            self.assertEqual(self.client.get("/accounting/partners?kind=vendor&fresh=1").status_code, 200)
            before = len(fetched)
            r = self.client.get(url)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertIn(",V00012,Acme Plumbing,", r.text)
            self.assertIn({"kind": "vendor", "q": "V00012"}, fetched[before:], "the vendor was read from the accounting app again")
            self.assertTrue(all(p.get("kind") == "vendor" for p in fetched), "read-only GETs of vendors, nothing else")
        finally:
            accounting_partners._get_sync, accounting._ACCT_BASE, accounting._ACCT_KEY = saved
            accounting_partners._CACHE.clear()

    def test_pending_check_takes_a_lock_on_postgres(self):
        """The one-pending-request check runs under a transaction-scoped
        advisory lock (Postgres) and a row lock, so two concurrent posts for
        one record cannot both pass it."""
        seen = []

        class FakeDialect:
            name = "postgresql"

        class FakeBind:
            dialect = FakeDialect()

        class FakeDb:
            bind = FakeBind()

            def execute(self, stmt, params):
                seen.append((str(stmt), params))
        accounting_partners._lock_partner(FakeDb(), "vendor", "V00012")
        self.assertEqual(len(seen), 1)
        self.assertIn("pg_advisory_xact_lock", seen[0][0])
        self.assertEqual(seen[0][1]["key"], "vendor:V00012")
        import inspect
        self.assertIn("with_for_update()", inspect.getsource(accounting_partners.create_change))


if __name__ == "__main__":
    unittest.main()
