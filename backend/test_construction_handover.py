"""Construction phase 3 - extra work, change orders and closeout (Neil,
11/03/2026, plan https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr,
feat/construction-field).

Pins:
  * a field ticket written on the phone (offline: the signature with it,
    the phone-made id, the Idempotency-Key) lands once; labor from the day's
    punches is hours only (the crew gets one total line, a reviewer each
    person); quantities only - no money anywhere on it;
  * a signed field ticket becomes a Draft change order (priced by a job
    manager only; the crew never sees amounts); an internal approver gets it
    in their Approvals inbox and their Approve sends ONE Nexus Sign envelope
    (link_kind change_order); Send Back returns it to Draft with a note;
  * the esign hook: signed moves the job's contract value and target finish
    ONCE (before / after kept); declined / voided move nothing; a signed one
    cannot be voided;
  * closeout: records write back to Asset Management through its per-row API
    as the acting user - no edit grant = kept with the reason, never written;
    with it a row `cx-<id>` in the property's own collection plus an Activity
    Log entry; a second Close Out never writes twice and never overwrites a
    row already there; an equipment warranty lands on the item (Items API);
    nothing is deleted; the job becomes Complete;
  * the owner's sign-off goes through Nexus Sign (link_kind owner_signoff);
  * walls: another company's job is a 404.

Run: python -m pytest test_construction_handover.py -q
"""
import os
import tempfile
from unittest import mock

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("SUPABASE_URL", None)

import approvals_inbox      # noqa: E402
import models               # noqa: E402
from construction_jobs_testkit import (A, ADMIN, CREW, CREW2, MGR_A, MGR_A2, MGR_B, JobsBase, iso)  # noqa: E402
from routers import esign   # noqa: E402

PIC = "data:image/png;base64,iVBORw0KGgo="
DAY = "2026-11-02"


class Base(JobsBase):
    tmp_db = _tmp.name

    def setUp(self):
        super().setUp()
        self._p = [mock.patch.object(esign, "_storage_put", return_value=esign._StorageResult(True)),
                   mock.patch.object(esign, "_notify_party", return_value=None)]
        for p in self._p:
            p.start()

    def tearDown(self):
        for p in self._p:
            p.stop()
        super().tearDown()

    def _ticket(self, **kw):
        self.as_(CREW)
        body = {"id": "ft-phone-0001", "description": "Moved the gas line 6 ft north", "work_date": DAY,
                "materials": [{"description": "3/4 in black pipe", "quantity": 12, "unit": "ft"}],
                "photo_urls": [PIC], "customer_name": "Dana Owens", "customer_email": "dana@owner.com",
                "signature_url": PIC, "signed_name": "Dana Owens", **kw}
        return self.client.post("/construction/projects/pa/field-tickets", json=body,
                                headers={"Idempotency-Key": "ft-phone-0001"})

    def _co(self, **kw):
        self._ticket()
        self.as_(MGR_A)
        r = self.client.post("/construction/projects/pa/change-orders", json={
            "field_ticket_id": "ft-phone-0001", "amount": 4200, "schedule_impact_days": 2,
            "reason": "unforeseen", **kw})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()


class FieldTickets(Base):
    def test_written_offline_with_the_signature_it_lands_once(self):
        a = self._ticket()
        self.assertEqual(a.status_code, 201, a.text)
        t = a.json()
        self.assertEqual((t["id"], t["number"], t["status"], t["signedName"]), ("ft-phone-0001", "FT-001", "signed", "Dana Owens"))
        b = self._ticket()
        self.assertEqual(b.headers.get("Idempotent-Replay"), "true")
        self.assertEqual(self.db.query(models.ConstructionFieldTicket).count(), 1)
        for word in ("amount", "price", "cost"):
            self.assertNotIn(word, " ".join(t.keys()).lower())

    def test_labor_from_punches_is_hours_only_crew_get_one_total(self):
        self.db.add(models.ScheduledShift(id="s1", employee_email=CREW, work_date=DAY, start_hhmm="07:00", end_hhmm="15:00",
                                          published=1, pending_delete=0, jobsite="project-pa", break_min=0, created_at=iso()))
        self.db.commit()
        for pid, kind, at in (("i1", "in", "2026-11-02T15:00:00+00:00"), ("o1", "out", "2026-11-02T21:00:00+00:00")):
            self.db.add(models.TimePunch(id=pid, employee_email=CREW, kind=kind, at=at, local_date=DAY,
                                         tz_offset_min=480, voided=0, created_at=iso()))
        self.db.commit()
        self.as_(CREW2)
        lab = self.client.get(f"/construction/projects/pa/field-tickets/labor?date={DAY}").json()
        self.assertEqual(lab["lines"], [{"email": "", "name": "Crew (1 person)", "hours": 6.0}])
        self.as_(MGR_A)
        lab = self.client.get(f"/construction/projects/pa/field-tickets/labor?date={DAY}").json()
        self.assertEqual(lab["lines"][0]["email"], CREW)
        r = self.client.post("/construction/projects/pa/field-tickets", json={"description": "Extra trench", "work_date": DAY,
                                                                            "labor_from_punches": True})
        self.assertEqual(r.json()["laborHours"], 6.0)

    def test_a_signed_ticket_cannot_change_and_walls_hold(self):
        self._ticket()
        self.assertEqual(self.client.patch("/construction/field-tickets/ft-phone-0001",
                                           json={"description": "x"}).status_code, 409)
        self.as_(MGR_B)
        self.assertEqual(self.client.get("/construction/projects/pa/changes").status_code, 404)
        self.assertEqual(self.client.post("/construction/field-tickets/ft-phone-0001/void").status_code, 404)


class ChangeOrders(Base):
    def test_priced_by_a_manager_only_the_crew_never_sees_money(self):
        self._ticket()
        self.as_(CREW)
        self.assertEqual(self.client.post("/construction/projects/pa/change-orders",
                                          json={"field_ticket_id": "ft-phone-0001", "amount": 1}).status_code, 403)
        ch = self.client.get("/construction/projects/pa/changes").json()
        self.assertEqual((ch["changeOrders"], ch["totals"], ch["contractValue"]), ([], None, None))
        co = self._co_from_existing()
        self.assertEqual((co["number"], co["status"], co["signerEmail"]), ("CO-001", "draft", "dana@owner.com"))
        self.assertEqual(self.fresh(models.ConstructionFieldTicket, "ft-phone-0001").status, "priced")

    def _co_from_existing(self):
        self.as_(MGR_A)
        return self.client.post("/construction/projects/pa/change-orders", json={
            "field_ticket_id": "ft-phone-0001", "amount": 4200, "schedule_impact_days": 2}).json()

    def test_internal_approval_then_one_envelope_then_signing_moves_the_job_once(self):
        job = self.fresh(models.ConstructionProject, "pa")
        job.contract_value, job.target_finish_on = 100000, "2026-12-01"
        self.db.commit()
        co = self._co(approver_email=MGR_A2)
        r = self.client.post(f"/construction/change-orders/{co['id']}/send", json={})
        self.assertEqual(r.json()["status"], "awaiting_approval")
        self.assertEqual(self.db.query(models.HrSignRequest).count(), 0)
        rows = approvals_inbox.collect(self.db, {"email": MGR_A2, "level": 3})["rows"]
        self.assertIn(f"construction_change_order:{co['id']}", [x["key"] for x in rows])
        self.as_(MGR_A2)
        r = self.client.post(f"/construction/change-orders/{co['id']}/approve")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "sent")
        req = self.db.query(models.HrSignRequest).one()
        self.assertEqual((req.link_kind, req.link_id, req.document_class), ("change_order", co["id"], "purchase_order"))
        party = self.db.query(models.HrSignParty).filter_by(request_id=req.id).one()
        self.assertEqual((party.email, party.kind), ("dana@owner.com", "external"))
        esign._link_hook("completed", self.db, req)
        esign._link_hook("completed", self.db, req)          # twice: moved once
        self.db.commit()
        job = self.fresh(models.ConstructionProject, "pa")
        self.assertEqual((job.contract_value, job.target_finish_on), (104200.0, "2026-12-03"))
        c = self.fresh(models.ConstructionChangeOrder, co["id"])
        self.assertEqual((c.status, c.contract_before, c.contract_after, c.finish_before),
                         ("signed", 100000.0, 104200.0, "2026-12-01"))
        self.as_(MGR_A)
        self.assertEqual(self.client.post(f"/construction/change-orders/{co['id']}/void", json={"note": "x"}).status_code, 409)
        tot = self.client.get("/construction/projects/pa/changes").json()["totals"]
        self.assertEqual((tot["signed"], tot["signedDays"]), (4200.0, 2))

    def test_send_back_declined_and_void_move_nothing(self):
        job = self.fresh(models.ConstructionProject, "pa")
        job.contract_value = 5000
        self.db.commit()
        co = self._co(approver_email=MGR_A2)
        self.client.post(f"/construction/change-orders/{co['id']}/send", json={})
        self.as_(MGR_A2)
        self.assertEqual(self.client.post(f"/construction/change-orders/{co['id']}/send-back", json={"note": ""}).status_code, 422)
        r = self.client.post(f"/construction/change-orders/{co['id']}/send-back", json={"note": "Price the labor"})
        self.assertEqual(r.json()["status"], "draft")
        self.as_(MGR_A)
        # Review M3: once asked, the approver cannot be taken off; a send asks again.
        self.assertEqual(self.client.patch(f"/construction/change-orders/{co['id']}", json={"approver_email": ""}).status_code, 409)
        self.assertEqual(self.client.post(f"/construction/change-orders/{co['id']}/send", json={}).json()["status"], "awaiting_approval")
        self.as_(MGR_A2)
        self.assertEqual(self.client.post(f"/construction/change-orders/{co['id']}/approve").json()["status"], "sent")
        req = self.db.query(models.HrSignRequest).one()
        esign._link_hook("declined", self.db, req, None, "Too high")
        self.db.commit()
        c = self.fresh(models.ConstructionChangeOrder, co["id"])
        self.assertEqual((c.status, c.decline_reason), ("declined", "Too high"))
        self.assertEqual(self.fresh(models.ConstructionProject, "pa").contract_value, 5000)

    def test_void_voids_the_open_envelope_and_frees_the_ticket(self):
        co = self._co()
        self.client.post(f"/construction/change-orders/{co['id']}/send", json={})
        r = self.client.post(f"/construction/change-orders/{co['id']}/void", json={"note": "Wrong job"})
        self.assertEqual(r.json()["status"], "void")
        self.assertEqual(self.db.query(models.HrSignRequest).one().status, "voided")
        self.assertEqual(self.fresh(models.ConstructionFieldTicket, "ft-phone-0001").status, "signed")


class Closeout(Base):
    def setUp(self):
        super().setUp()
        self.db.add(models.PropertyAsset(id="prop1", name="Escondido", payload={"name": "Escondido"}, updated_at=""))
        job = self.db.get(models.ConstructionProject, "pa")
        job.property_id = "prop1"
        self.db.add(models.Item(id="item1", name="Gate Motor", company_id=A, deleted_at="", custom_fields={}))
        self.db.commit()

    def _records(self):
        self.as_(CREW)
        w = self.client.post("/construction/projects/pa/closeout/records", json={
            "id": "rec-warranty-1", "kind": "warranty", "title": "Gate motor", "item_id": "item1", "serial": "LM-77",
            "vendor": "LiftMaster", "start_on": "2026-11-01", "end_on": "2028-11-01"}, headers={"Idempotency-Key": "rec-warranty-1"})
        self.assertEqual(w.status_code, 201, w.text)
        p = self.client.post("/construction/projects/pa/closeout/records", json={
            "kind": "permit", "number": "B-2026-114", "ahj": "City of Escondido", "result": "passed", "date_on": "2026-10-30"})
        self.assertEqual(p.status_code, 201, p.text)
        return w.json(), p.json()

    def test_no_asset_grant_keeps_the_reason_and_writes_nothing(self):
        self._records()
        self.as_(MGR_A)
        r = self.client.post("/construction/projects/pa/closeout", json={})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "complete")
        self.assertEqual(self.db.query(models.PropertyRecord).count(), 0)
        rec = self.fresh(models.ConstructionCloseoutRecord, "rec-warranty-1")
        self.assertIn("Asset Management", rec.written["error"])
        self.assertTrue(rec.written.get("item"))           # a manager may edit Items
        item = self.fresh(models.Item, "item1")
        self.assertEqual((item.custom_fields["warranty_end"], item.custom_fields["manufacturer_serial"]),
                         ("2028-11-01", "LM-77"))

    def test_with_the_grant_rows_land_once_and_nothing_is_overwritten(self):
        _, permit = self._records()
        # A row the module already holds under that id is never overwritten.
        self.db.add(models.PropertyRecord(id=f"cx-{permit['id']}", property_id="prop1", collection="documents",
                                          payload={"title": "Edited in Asset Management"}, updated_at="2026-11-01T00:00:00+00:00"))
        self.db.commit()
        self.as_(ADMIN)
        self.client.post("/construction/projects/pa/closeout", json={})
        self.client.post("/construction/projects/pa/closeout", json={})      # again: nothing twice
        rows = {r.id: r for r in self.db.query(models.PropertyRecord).all()}
        self.assertEqual(set(rows), {"cx-rec-warranty-1", f"cx-{permit['id']}"})
        w = rows["cx-rec-warranty-1"]
        self.assertEqual((w.collection, w.payload["scope"], w.payload["expiration"], w.payload["party"]),
                         ("warranties", "Gate motor", "2028-11-01", "LiftMaster"))
        self.assertEqual(rows[f"cx-{permit['id']}"].payload["title"], "Edited in Asset Management")
        logs = self.db.query(models.PropertyActivityLog).all()
        self.assertEqual(len(logs), 1)
        self.assertIn("Construction closeout", logs[0].payload["reason"])
        state = self.fresh(models.ConstructionProject, "pa").closeout
        self.assertEqual(state["closedOutBy"], ADMIN)
        # A record in Asset Management stays there.
        self.as_(CREW)
        self.assertEqual(self.client.delete("/construction/closeout/records/rec-warranty-1").status_code, 409)

    def test_the_owner_signoff_goes_through_nexus_sign(self):
        self.as_(MGR_A)
        r = self.client.post("/construction/projects/pa/closeout/signoff",
                             json={"signer_name": "Dana Owens", "signer_email": "dana@owner.com"})
        self.assertEqual(r.status_code, 200, r.text)
        req = self.db.query(models.HrSignRequest).one()
        self.assertEqual((req.link_kind, req.link_id), ("owner_signoff", "pa"))
        self.assertEqual(self.client.post("/construction/projects/pa/closeout/signoff",
                                          json={"signer_name": "D", "signer_email": "d@o.com"}).status_code, 409)
        esign._link_hook("completed", self.db, req)
        self.db.commit()
        self.assertEqual(self.fresh(models.ConstructionProject, "pa").closeout["signoff"]["status"], "signed")

    def test_walls(self):
        self.as_(MGR_B)
        self.assertEqual(self.client.get("/construction/projects/pa/closeout").status_code, 404)
        self.assertEqual(self.client.post("/construction/projects/pa/closeout", json={}).status_code, 404)



class ReviewFixes(Base):
    """The 11/03/2026 code review: H1, M2-M7, L9-L12."""

    def test_h1_report_dollars_only_for_readers_who_may_see_money(self):
        import construction_notify
        import construction_report
        self._co()
        self.db.add(models.ConstructionChangeOrder(id="co-s", project_id="pa", number="CO-009", title="Signed one",
                                                   amount=900, status="signed", deleted_at=""))
        self.db.commit()
        r = construction_report.generate(self.db, self.fresh(models.ConstructionProject, "pa"), "2026-11-02", MGR_A,
                                         use_ai=False)
        r.status = "published"
        self.db.commit()
        stored = r.sections["change_orders"]["text"]
        self.assertNotIn("$", stored)
        self.assertIn("Approved changes: 1 signed; pending: 1", stored)
        self.as_(MGR_A)
        rep = self.client.get("/construction/projects/pa/reports").json()[0]
        self.assertIn("+$4,200.00", rep["sections"]["change_orders"]["text"])
        self.assertNotIn("cost_exposure", rep)
        self.as_(CREW)
        rep = self.client.get("/construction/projects/pa/reports").json()[0]
        self.assertNotIn("$", rep["sections"]["change_orders"]["text"])
        import construction_pdf
        seen = {}
        with mock.patch.object(construction_pdf, "build", side_effect=lambda *a, **kw: seen.update(kw) or b"%PDF"):
            self.assertEqual(self.client.get(f"/construction/reports/{r.id}/pdf").status_code, 200)
        self.assertFalse(seen["with_cost"])
        p = self.fresh(models.ConstructionProject, "pa")
        self.assertEqual(construction_notify.cost_readers(self.db, p, [MGR_A, CREW, "investor@fund.com"]), {MGR_A})

    def test_m2_the_approver_must_review_and_see_money(self):
        self._ticket()
        self.as_(MGR_A)
        r = self.client.post("/construction/projects/pa/change-orders", json={"field_ticket_id": "ft-phone-0001", "amount": 1,
                                                                              "approver_email": CREW})
        self.assertEqual(r.status_code, 422)

    def test_m3_a_draft_edit_clears_an_approval(self):
        co = self._co()
        c = self.fresh(models.ConstructionChangeOrder, co["id"])
        c.approved_by, c.approved_at = MGR_A2, iso()
        self.db.commit()
        self.client.patch(f"/construction/change-orders/{co['id']}", json={"amount": 5000})
        self.assertEqual(self.fresh(models.ConstructionChangeOrder, co["id"]).approved_at, "")

    def test_m4_the_crew_sees_the_labor_total_only(self):
        self._ticket(labor=[{"email": CREW, "name": "Crew Person", "hours": 5}, {"email": CREW2, "name": "Crew2", "hours": 3}])
        self.as_(CREW2)
        t = self.client.get("/construction/projects/pa/changes").json()["fieldTickets"][0]
        self.assertEqual(t["labor"], [{"email": "", "name": "Crew", "hours": 8.0}])
        self.as_(MGR_A)
        self.assertEqual(len(self.client.get("/construction/projects/pa/changes").json()["fieldTickets"][0]["labor"]), 2)

    def test_m6_one_envelope_however_many_sends(self):
        co = self._co()
        self.assertEqual(self.client.post(f"/construction/change-orders/{co['id']}/send", json={}).json()["status"], "sent")
        self.assertEqual(self.client.post(f"/construction/change-orders/{co['id']}/send", json={}).status_code, 409)
        self.assertEqual(self.db.query(models.HrSignRequest).count(), 1)
        from routers.construction_handover import _claim_co
        from fastapi import HTTPException
        c = self.fresh(models.ConstructionChangeOrder, co["id"])
        with self.assertRaises(HTTPException):
            _claim_co(self.db, c, "draft", "sending")       # a second tap that lost the race

    def test_l10_void_closes_the_approvers_bell(self):
        co = self._co(approver_email=MGR_A2)
        self.client.post(f"/construction/change-orders/{co['id']}/send", json={})
        self.client.post(f"/construction/change-orders/{co['id']}/void", json={"note": "Wrong job"})
        self.db.expire_all()
        b = self.db.query(models.NexusNotification).filter_by(recipient=MGR_A2, ref_id=f"co:{co['id']}").one()
        self.assertEqual((b.title, bool(b.actioned)), ("Change Order Voided", True))

    def test_l11_a_signed_ticket_is_voided_by_a_reviewer_only(self):
        self._ticket()
        self.as_(CREW)
        self.assertEqual(self.client.post("/construction/field-tickets/ft-phone-0001/void").status_code, 403)
        self.as_(MGR_A)
        self.assertEqual(self.client.post("/construction/field-tickets/ft-phone-0001/void").json()["status"], "void")

    def test_l12_signing_moves_nothing_unless_the_change_order_was_sent(self):
        job = self.fresh(models.ConstructionProject, "pa")
        job.contract_value = 1000
        self.db.commit()
        co = self._co()
        self.client.post(f"/construction/change-orders/{co['id']}/send", json={})
        req = self.db.query(models.HrSignRequest).one()
        c = self.fresh(models.ConstructionChangeOrder, co["id"])
        c.status = "void"
        self.db.commit()
        esign._link_hook("completed", self.db, req)
        self.db.commit()
        self.assertEqual(self.fresh(models.ConstructionProject, "pa").contract_value, 1000)

if __name__ == "__main__":
    import unittest
    unittest.main()
