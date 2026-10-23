"""Hiring Setup (Pranshu, Oct 23 2026): what each hire gets, per company.

Reuse by default, customize where needed - every grid cell asks the same
resolve_setting a real offer uses; Use The Same archives a level's own row;
a role's duties have versions by Hired As, place and company; a hiring
packet places the job description where its "@jd" marker sits.

Runs on test_hr_packet_review's throwaway SQLite. Run ONE file per process:
    python -m pytest test_hiring_setup.py -q -p no:cacheprovider
"""
import unittest

import database
import hiring_setup as hs
import hr_life_events as hle
import hr_packet_docs as hpd
import models
from routers import hiring_setup as hs_router
from test_hr_packet_review import CAND, CO, HR, MGR, ReviewCase, _doc, _p, _sig

GGC, GS, NEW = "co-ggcon", "co-gs", "co-new"
LETTER = _doc(_p("Dear ", "{{full_name}}", ", we offer you ", "{{job_title}}", "."), _sig("employee"))
AGREE = _doc(_p("Agreement with ", "{{full_name}}", " at ", "{{company_legal}}", "."), _sig("employee"), _sig("company"))
I9 = _doc(_p("I-9 for ", "{{full_name}}", "."), _sig("employee"))
DUTY = _doc(_p("Your duties: ", "{{role_description}}"), _sig("employee"))
JD_ACCT = _doc(_p("Accountant job description."))
EMP_FLOW = [{"key": "employee", "role": "employee", "action": "sign"}]
HIRE_FLOW = EMP_FLOW + [{"key": "company", "role": "hr", "action": "sign"}]
SHARED_403 = "Only HR with access to every company can change the default packet."


def _tpl(db, tid, name, content, category="hr"):
    meta = {"fieldDefs": [], "signerRoles": [], "mergeOverrides": {}, "letterheadId": "", "requiresLetterhead": False}
    db.add(models.DocTemplate(id=tid, name=name, category=category, status="active", version=1, content=content,
                              department="", published_version=1, published_meta=meta))
    db.add(models.DocTemplateVersion(id=f"v-{tid}", template_id=tid, version_no=1, content=content))


def _setting(db, sid, event, docs, *, entity="", wt="any", country="", region="", flow=None, roles=None):
    db.add(models.HrPacketSetting(id=sid, entity_id=entity, event=event, worker_type=wt, country=country, region=region,
                                  engine="documents", template_id="", name=sid, doc_template_ids=docs,
                                  subject_role="employee", flow=flow or (EMP_FLOW if event == "offer" else HIRE_FLOW),
                                  verify_role="hr", role_ids=roles or [], updated_at="2026-10-23"))


class SetupCase(ReviewCase):
    def setUp(self):
        super().setUp()
        db = database.SessionLocal()
        db.query(models.HrPacketSetting).delete()
        db.query(models.HrEntity).filter_by(id=CO).update({"country": "US", "region": "CA", "signatory_email": HR,
                                                           "physical_address": "123 Main St, Fresno, CA 93721"})
        db.add(models.HrEntity(id=GGC, name="GGCon", country="IN"))
        db.add(models.HrEntity(id=GS, name="Greens Storage", country="US", region="TX", hr_contact_email=HR))
        db.add(models.HrEntity(id=NEW, name="New Company LLC"))
        for tid, name, content, cat in (("t-letter", "US Employee Offer Letter", LETTER, "offer_letter"),
                                        ("t-agree", "Employment Agreement", AGREE, "hr"), ("t-i9", "I-9 Acknowledgment", I9, "hr"),
                                        ("t-duty", "Duties Agreement", DUTY, "hr"),
                                        ("t-jd-acct", "Accountant JD", JD_ACCT, "job_description")):
            _tpl(db, tid, name, content, cat)
        _setting(db, "s-ca-offer", "offer", ["t-letter"], country="US", region="CA")
        _setting(db, "s-ca-hire", "hire", ["t-agree", "@jd", "t-i9"], country="US", region="CA")
        _setting(db, "s-in-offer", "offer", ["t-letter"], country="IN")
        _setting(db, "s-in-hire", "hire", ["t-i9"], country="IN", flow=EMP_FLOW)
        _setting(db, "s-tx-hire", "hire", ["t-duty"], country="US", region="TX", flow=EMP_FLOW)
        db.add(models.NexusGroup(id="jr-acct", name="Accountant", department="Accounting", is_job_role=1, tier="employee",
                                 job_description="Keep the books.",
                                 duty_versions=[{"id": "dv-con", "hiredAs": "contractor", "country": "", "region": "",
                                                 "entityId": "", "text": "Deliver the monthly close.",
                                                 "createdAt": "2026-10-01", "updatedAt": "2026-10-01", "archivedAt": ""}]))
        db.add(models.NexusGroup(id="jr-admin", name="Admin Associate", department="Admin", is_job_role=1,
                                 tier="employee", company_id=CO))
        db.add(models.NexusGroup(id="jr-clerk", name="Clerk", department="Admin", is_job_role=1, tier="employee"))
        db.commit()
        hs.ensure_builtin_jd(db)
        db.close()
        self._scope = hs_router.hr_scope

    def tearDown(self):
        hs_router.hr_scope = self._scope
        super().tearDown()

    def view(self, entity=CO, role=""):
        r = self.client.get("/hr/hiring-setup/company", params={"entity_id": entity, "role_id": role})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def row(self, view, key):
        return next(r for r in view["rows"] if r["key"] == key)

    def make_own(self, **kw):
        body = {"entity_id": CO, "event": "offer", "worker_type": "employee", "country": "US", "region": "CA",
                "start": "copy", **kw}
        return self.client.post("/hr/hiring-setup/make-own", json=body)

    def setting(self, sid):
        self.db.expire_all()
        return self.db.get(models.HrPacketSetting, sid)


class GridTests(SetupCase):
    def test_ggcon_india_has_two_independent_rows(self):
        v = self.view(GGC)
        self.assertEqual([r["key"] for r in v["rows"]], ["employee:IN:", "contractor:IN:"])
        for ev in ("offer", "hire"):
            r = self.make_own(entity_id=GGC, event=ev, worker_type="contractor", country="IN", region="")
            self.assertEqual(r.status_code, 200, r.text)
        v = self.view(GGC)
        con, emp = self.row(v, "contractor:IN:"), self.row(v, "employee:IN:")
        self.assertEqual((con["offer"]["sourceLabel"], con["packet"]["sourceLabel"]), ("Only Here", "Only Here"))
        self.assertEqual(con["offer"]["name"], "GGCon - Contractors In India Offer Letter")
        self.assertEqual((emp["offer"]["settingId"], emp["offer"]["sourceLabel"]), ("s-in-offer", "Same As All Companies - India"))
        self.assertEqual(emp["packet"]["settingId"], "s-in-hire")
        r = self.make_own(entity_id=GGC, worker_type="employee", country="IN", region="")
        own_emp = r.json()["settingIds"][0]
        self.assertNotEqual(own_emp, con["offer"]["settingId"])
        # Archiving the contractor's own letter leaves the employee row alone.
        r = self.client.post("/hr/hiring-setup/use-same", json={"setting_id": con["offer"]["settingId"]})
        self.assertEqual(r.status_code, 200, r.text)
        v = self.view(GGC)
        self.assertEqual(self.row(v, "contractor:IN:")["offer"]["settingId"], "s-in-offer")
        self.assertEqual(self.row(v, "contractor:IN:")["offer"]["archivedOwnId"], con["offer"]["settingId"])
        self.assertEqual(self.row(v, "employee:IN:")["offer"]["settingId"], own_emp)

    def test_greens_global_california_shares_the_letters_not_the_duties(self):
        v = self.view()
        emp, con = self.row(v, "employee:US:CA"), self.row(v, "contractor:US:CA")
        self.assertTrue(emp["home"])
        for col, sid in (("offer", "s-ca-offer"), ("packet", "s-ca-hire")):
            self.assertEqual((emp[col]["settingId"], con[col]["settingId"]), (sid, sid))
            self.assertEqual(emp[col]["sourceLabel"], "Same As All Companies - California")
        self.assertEqual(emp["offer"]["fallback"]["usedByText"], "used by 1 company")
        self.assertEqual(emp["packet"]["placement"], "page")
        self.assertEqual(emp["packet"]["placementLabel"], "Its Own Page, After Employment Agreement")
        self.assertEqual([d["name"] for d in emp["packet"]["documents"]],
                         ["Employment Agreement", "Job Description - Goes Here", "I-9 Acknowledgment"])
        self.assertEqual(emp["packet"]["documents"][0]["signedBy"], "The New Hire, then Charmi Shah")
        v = self.view(role="jr-acct")
        self.assertEqual(self.row(v, "employee:US:CA")["jd"]["name"], "Accountant - Standard")
        jd = self.row(v, "contractor:US:CA")["jd"]
        self.assertEqual((jd["name"], jd["sourceLabel"], jd["tone"]),
                         ("Accountant - Contractors Version", "Only For Contractors", "own"))
        self.assertIn({"id": hpd.BUILTIN_JD_ID, "name": "Job Description - Accountant", "jd": True, "marker": False,
                       "signedBy": ""}, self.row(v, "employee:US:CA")["packet"]["documents"])
        table = {r["roleId"]: r for r in v["jobDescriptions"]["rows"]}
        self.assertEqual(table["jr-acct"]["cells"]["contractor:US:CA"]["label"], "Own Version")
        self.assertEqual(table["jr-acct"]["cells"]["employee:US:CA"]["label"], "Standard")
        self.assertEqual(table["jr-admin"]["cells"]["employee:US:CA"]["label"], "Not Written Yet")
        self.assertEqual(v["uploadContext"]["companyLegal"], "Greens Test, LLC")
        self.assertIn("legalAndAddress", [a["key"] for a in self.view()["about"]])

    def test_the_shared_screen(self):
        v = self.view("")
        self.assertEqual((v["entity"]["name"], v["entity"]["shared"], v["about"]), ("All Companies", True, []))
        keys = [r["key"] for r in v["rows"]]
        self.assertTrue({"employee:US:CA", "contractor:US:CA", "contractor:IN:", "employee:US:TX"} <= set(keys))
        self.assertEqual({r["id"] for r in v["roles"]}, {"jr-acct", "jr-clerk"})        # shared roles only
        self.assertFalse([i for i in v["items"] if i["action"] == "addDuties"])
        tx = self.row(v, "employee:US:TX")["packet"]
        self.assertEqual((tx["settingId"], tx["sourceLabel"]), ("s-tx-hire", "Same As All Companies - Texas"))

    def _offer(self, **inputs):
        body = {"inputs": {"role_id": "jr-acct", "start_date": "2030-11-02", "offer_expires": "2030-10-28", **inputs}}
        return self.client.post("/hr/candidates/cand-1/offer/start", json=body)

    def test_the_offer_freezes_the_duties_for_how_they_are_hired(self):
        db = database.SessionLocal()
        db.query(models.HrCandidate).filter_by(id="cand-1").update({"stage": "interview"})
        db.commit()
        db.close()
        got = {}
        for ha in ("full_time", "contractor"):
            r = self._offer(hired_as=ha)
            self.assertEqual(r.status_code, 200, r.text)
            ev = self.db.get(models.HrLifeEvent, r.json()["id"])
            got[ha] = (ev.setting_id, ev.inputs["role_description"], ev.inputs["duty_version_id"], ev.inputs["hired_as"])
            self.db.query(models.HrLifeEvent).filter_by(id=ev.id).update({"status": "voided"})
            self.db.commit()
        self.assertEqual(got["full_time"], ("s-ca-offer", "Keep the books.", "", "full_time"))
        self.assertEqual(got["contractor"], ("s-ca-offer", "Deliver the monthly close.", "dv-con", "contractor"))
        r = self._offer(hired_as="temp")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["detail"], "Choose how they are hired - Full-Time Employee, Part-Time Employee, "
                                             "Intern or Contractor.")
        # Old clients: worker_type / employment_type / a picked Job Description still work.
        r = self._offer(worker_type="employee", employment_type="part_time", jd_template_id="t-jd-acct")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["inputs"]["jd_template_id"], "t-jd-acct")

    def test_what_they_get_on_the_offer(self):
        base = "/hr/candidates/cand-1/offer/options"
        con = self.client.get(base, params={"hired_as": "contractor", "role_id": "jr-acct"}).json()
        self.assertEqual(con["hiredAs"], "contractor")
        lines = {x["key"]: x for x in con["whatTheyGet"]}
        self.assertEqual(lines["offer"]["name"], "s-ca-offer")
        self.assertEqual(lines["packet"]["sourceLabel"], "Starts by itself once Jen signs the offer")
        self.assertEqual((lines["jd"]["name"], lines["jd"]["sourceLabel"]), ("Accountant - Contractors Version", "Only For Contractors"))
        self.assertEqual(lines["signs"]["name"], "Offer: New Hire - Packet: New Hire, then Charmi Shah")
        self.assertEqual(con["blocked"], "")
        ft = self.client.get(base, params={"hired_as": "full_time", "role_id": "jr-acct"}).json()
        self.assertEqual({x["key"]: x for x in ft["whatTheyGet"]}["jd"]["name"], "Accountant - Standard")
        # Texas has no offer letter; an Admin Associate has no duties and the packet prints them.
        tx = self.client.get(base, params={"hired_as": "full_time", "role_id": "jr-admin", "country": "US", "region": "TX"}).json()
        lines = {x["key"]: x for x in tx["whatTheyGet"]}
        self.assertEqual((lines["offer"]["tone"], lines["offer"]["blocks"]), ("missing", True))
        self.assertEqual(lines["offer"]["fix"], {"action": "setUp", "target": {"entityId": CO, "rowKey": "employee:US:TX",
                                                                               "column": "offer"}})
        self.assertEqual(lines["jd"]["name"], "Admin Associate - no duties written")
        self.assertEqual(lines["jd"]["fix"]["action"], "addDuties")
        self.assertEqual(tx["blocked"], "Fix the amber item before sending.")


class MarkerTests(SetupCase):
    def test_a_packet_that_prints_the_duties_inside(self):
        v = self.view(GS)
        pk = self.row(v, "employee:US:TX")["packet"]
        self.assertEqual((pk["placement"], pk["placementLabel"]), ("inside", "Printed Inside Duties Agreement"))
        s = self.setting("s-tx-hire")
        ids = hpd.template_ids_for(s, {"role_description": "Count boxes."}, "hire")
        self.assertEqual(ids, ["t-duty"])
        p = hpd.plan(self.db, s, ctx={"subject_email": CAND, "subject_name": "Jen Doe", "entity": None, "owners": {}},
                     overrides={}, pay=None, can_see_pay=False, extra_template_ids=ids)
        self.assertEqual(len(p["documents"]), 1)

    def test_the_job_description_goes_where_the_marker_is(self):
        s = self.setting("s-ca-hire")
        self.assertEqual(hpd.template_ids_for(s, {"role_description": "Keep the books."}, "hire"),
                         ["t-agree", hpd.BUILTIN_JD_ID, "t-i9"])
        self.assertEqual(hpd.template_ids_for(s, {"role_description": "x", "role_docs": [
            {"templateId": "t-jd-acct", "replaces": "@jd"}]}, "hire"), ["t-agree", "t-jd-acct", "t-i9"])
        self.assertEqual(hpd.template_ids_for(s, {"role_description": ""}, "hire"), ["t-agree", "t-i9"])
        self.assertEqual(hpd.template_ids_for(s, {"role_description": "x"}, "offer"), ["t-agree", "t-i9"])
        self.assertFalse([x for x in hpd.config_problems(self.db, s) if "no longer exists" in x])
        ids = hpd.template_ids_for(s, {"role_description": "Keep the books."}, "hire")
        p = hpd.plan(self.db, s, ctx={"subject_email": CAND, "subject_name": "Jen Doe", "entity": None, "owners": {}},
                     overrides={"role_description": "Keep the books."}, pay=None, can_see_pay=False, extra_template_ids=ids)
        self.assertEqual([d["name"] for d in p["documents"]], ["Employment Agreement", "Job Description", "I-9 Acknowledgment"])
        self.assertEqual(hpd.ser_documents(self.db, s)[1]["name"], "Job Description - Goes Here")
        offer = self.setting("s-ca-offer")
        offer.doc_template_ids = ["t-letter", "@jd"]
        self.assertIn("An offer letter never carries the job description - it goes in the hiring packet.",
                      hpd.config_problems(self.db, offer))
        self.db.rollback()
        # A document that prints the duties itself takes the marker out.
        r = self.make_own(event="hire", start="templates", doc_template_ids=["t-duty", "@jd"])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["settings"][0]["docTemplateIds"], ["t-duty"])

    def test_old_packets_keep_the_job_description_at_the_end(self):
        s = self.setting("s-in-hire")
        self.assertEqual(hpd.template_ids_for(s, {"jd_template_id": "t-jd-acct", "role_description": "x"}, "hire"),
                         ["t-i9", "t-jd-acct"])
        s = self.setting("s-ca-hire")
        self.assertEqual(hpd.template_ids_for(s, {"jd_template_id": "t-jd-acct", "role_description": "x"}, "hire"),
                         ["t-agree", "t-jd-acct", "t-i9"])

    def test_documents_order_and_the_offer_rule(self):
        own = self.make_own(event="hire", start="templates", doc_template_ids=["t-agree", "t-i9"]).json()["settingIds"][0]
        flow = self.setting(own).flow
        self.assertEqual([(x["key"], x["role"]) for x in flow], [("employee", "employee"), ("company", "hr")])
        r = self.client.put(f"/hr/hiring-setup/settings/{own}/documents", json={"doc_template_ids": ["t-agree", "@jd", "t-i9"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["docTemplateIds"], ["t-agree", "@jd", "t-i9"])
        r = self.client.put(f"/hr/hiring-setup/settings/{own}/documents", json={"doc_template_ids": ["t-i9"]})
        self.assertEqual([x["key"] for x in self.setting(own).flow], ["employee"])     # the company line is gone
        offer = self.make_own().json()["settingIds"][0]
        r = self.client.put(f"/hr/hiring-setup/settings/{offer}/documents", json={"doc_template_ids": ["t-letter", "@jd"]})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["detail"], "An offer letter never carries the job description - it goes in the hiring packet.")

    def test_edit_wording_copies_a_shared_document_for_the_company(self):
        own = self.make_own(event="hire").json()["settingIds"][0]
        r = self.client.post(f"/hr/hiring-setup/settings/{own}/documents/t-agree/own-copy")
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual((out["name"], out["copied"]), ("Employment Agreement - Greens Test", True))
        self.assertEqual(self.setting(own).doc_template_ids, ["t-agree".replace("t-agree", out["templateId"]), "@jd", "t-i9"])
        self.assertEqual(self.setting("s-ca-hire").doc_template_ids, ["t-agree", "@jd", "t-i9"])
        r = self.client.post(f"/hr/hiring-setup/settings/{own}/documents/{out['templateId']}/own-copy")
        self.assertFalse(r.json()["copied"])                   # only this company uses it now
        r = self.client.post("/hr/hiring-setup/settings/s-ca-hire/documents/t-agree/own-copy")
        self.assertFalse(r.json()["copied"])                   # the shared row is edited as itself
        r = self.client.post(f"/hr/hiring-setup/settings/{own}/documents/t-letter/own-copy")
        self.assertEqual(r.status_code, 404)


class UseTheSameTests(SetupCase):
    def _event(self, eid, **kw):
        self.db.add(models.HrLifeEvent(id=eid, kind=kw.pop("kind", "offer"), status=kw.pop("status", "review"),
                                       entity_id=CO, created_at="2026-10-23", **kw))
        self.db.commit()

    def test_refused_while_a_hire_uses_it_then_falls_back(self):
        own = self.make_own().json()["settingIds"][0]
        self._event("ev-1", setting_id=own)
        r = self.client.post("/hr/hiring-setup/use-same", json={"setting_id": own})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["detail"], "1 hire is using this one right now. Try again once they finish.")
        pk = self.make_own(event="hire").json()["settingIds"][0]
        self._event("ev-2", setting_id="other", inputs={"hire_packet_id": pk})
        self._event("ev-3", setting_id=pk, kind="hire")
        r = self.client.post("/hr/hiring-setup/use-same", json={"setting_id": pk})
        self.assertEqual(r.json()["detail"], "2 hires are using this one right now. Try again once they finish.")
        self.db.query(models.HrLifeEvent).update({"status": "completed"})
        self.db.commit()
        cell = self.row(self.view(), "employee:US:CA")["offer"]
        self.assertEqual((cell["settingId"], cell["fallback"]["settingId"]), (own, "s-ca-offer"))
        r = self.client.post("/hr/hiring-setup/use-same", json={"setting_id": own})
        self.assertEqual(r.json(), {"ok": True, "archivedId": own})
        self.assertEqual(self.client.post("/hr/hiring-setup/use-same", json={"setting_id": own}).status_code, 200)
        cell = self.row(self.view(), "employee:US:CA")["offer"]
        self.assertEqual((cell["settingId"], cell["archivedOwnId"]), ("s-ca-offer", own))
        r = self.client.post("/hr/hiring-setup/restore", json={"setting_id": own})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.row(self.view(), "employee:US:CA")["offer"]["sourceLabel"], "Only Here")
        # A new own row while the old one is archived is allowed; the old one then can't come back.
        self.client.post("/hr/hiring-setup/use-same", json={"setting_id": own})
        new = self.make_own().json()["settingIds"][0]
        self.assertNotEqual(new, own)
        r = self.client.post("/hr/hiring-setup/restore", json={"setting_id": own})
        self.assertEqual(r.status_code, 400)
        self.assertIn("already covers Employees in California", r.json()["detail"])
        self.assertEqual(self.client.post("/hr/hiring-setup/use-same", json={"setting_id": "nope"}).status_code, 404)

    def test_an_archived_row_is_never_sent_or_listed(self):
        own = self.make_own().json()["settingIds"][0]
        self.client.post("/hr/hiring-setup/use-same", json={"setting_id": own})
        self.assertNotIn(own, [s["id"] for s in self.client.get("/hr/packets").json()["settings"]])
        self.assertEqual(hle.resolve_setting(self.db, CO, "offer", "employee", country="US", region="CA").id, "s-ca-offer")
        self.assertNotIn(own, [s.id for s in hle.packet_choices(self.db, CO, "offer")])

    def test_also_use_it_for_and_nothing_to_copy(self):
        r = self.make_own(also=[{"worker_type": "contractor", "country": "US", "region": "CA"}])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(r.json()["settingIds"]), 2)
        self.assertEqual(self.make_own().json()["settingIds"][0], r.json()["settingIds"][0])     # copy again = no-op
        r = self.make_own(country="US", region="NV")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["detail"], "There is nothing to copy for Employees In Nevada yet - upload a Word file "
                                             "or pick one you already have.")
        r = self.make_own(event="hire", country="")
        self.assertIn("Works In", r.json()["detail"])
        self.assertEqual(self.make_own(worker_type="any").json()["detail"], "Pick Employees or Contractors.")
        self.assertEqual(self.make_own(event="promotion").json()["detail"], "Unknown event")


class LabelTests(SetupCase):
    def test_source_labels(self):
        db = self.db
        self.assertEqual(hs.source(db, None, CO, ("contractor", "US", "CA")),
                         ("A contractor hire here would be blocked", "missing"))
        self.assertEqual(hs.source(db, None, CO, ("employee", "US", "CA"))[0], "An employee hire here would be blocked")
        role_row = models.HrPacketSetting(id="x", entity_id="", country="US", region="CA", worker_type="any", role_ids=["jr-acct"])
        self.assertEqual(hs.source(db, role_row, CO, ("employee", "US", "CA")), ("Only For Accountant", "own"))
        own = models.HrPacketSetting(id="x", entity_id=CO, country="US", region="CA", worker_type="employee", role_ids=[])
        self.assertEqual(hs.source(db, own, CO, ("employee", "US", "CA")), ("Only Here", "own"))
        shared = models.HrPacketSetting(id="x", entity_id="", country="US", region="CA", worker_type="employee", role_ids=[])
        self.assertEqual(hs.source(db, shared, "", ("employee", "US", "CA")), ("Only Here", "own"))
        self.assertEqual(hs.source(db, shared, CO, ("employee", "US", "CA")), ("Same As All Companies - California", "same"))
        india = models.HrPacketSetting(id="x", entity_id="", country="IN", region="", worker_type="any", role_ids=[])
        self.assertEqual(hs.source(db, india, GGC, ("employee", "IN", "")), ("Same As All Companies - India", "same"))
        us = models.HrPacketSetting(id="x", entity_id="", country="US", region="", worker_type="any", role_ids=[])
        self.assertEqual(hs.source(db, us, CO, ("employee", "US", "CA"))[0], "Same As All Companies - United States")
        anywhere = models.HrPacketSetting(id="x", entity_id="", country="", region="", worker_type="any", role_ids=[])
        self.assertEqual(hs.source(db, anywhere, CO, ("employee", "US", "CA")), ("Same As All Companies", "same"))
        v = self.view()
        self.assertEqual(self.row(v, "employee:US:CA")["sub"], "Full-time and part-time")
        tx = self.row(self.view(GS), "contractor:US:TX")["offer"]
        self.assertEqual((tx["name"], tx["sourceLabel"]), ("Nothing Yet - Choose One", "A contractor hire here would be blocked"))


class DutiesTests(SetupCase):
    def _role(self, versions):
        g = models.NexusGroup(id="jr-x", name="X", is_job_role=1, job_description="Standard.", duty_versions=versions)
        return g

    def _v(self, vid, **kw):
        return {"id": vid, "hiredAs": "", "country": "", "region": "", "entityId": "", "text": vid, "updatedAt": "1",
                "archivedAt": "", **kw}

    def test_the_most_specific_version_wins(self):
        g = self._role([self._v("us", country="US"), self._v("con", hiredAs="contractor")])
        self.assertEqual(hs.resolve_duties(g, hs.duty_ctx("", "contractor", "US", "CA"))[0], "us")
        g = self._role([self._v("emp", hiredAs="employee"), self._v("ft", hiredAs="full_time")])
        self.assertEqual(hs.resolve_duties(g, hs.duty_ctx("", "employee", "US", "", "full_time"))[0], "ft")
        self.assertEqual(hs.resolve_duties(g, hs.duty_ctx("", "employee", "US", "", "intern"))[0], "emp")
        g = self._role([self._v("co", entityId=CO), self._v("con", hiredAs="contractor")])
        self.assertEqual(hs.resolve_duties(g, hs.duty_ctx(CO, "contractor", "US", ""))[0], "con")
        g = self._role([self._v("old", hiredAs="contractor", archivedAt="2026")])
        self.assertEqual(hs.resolve_duties(g, hs.duty_ctx("", "contractor", "US", "")), ("Standard.", None))
        g = self._role([self._v("", hiredAs="contractor", text="")])
        self.assertEqual(hs.resolve_duties(g, hs.duty_ctx("", "contractor", "US", ""))[0], "")   # empty wins too

    def test_popup_b(self):
        r = self.client.get("/hr/hiring-setup/roles/jr-acct/duties", params={"entity_id": CO})
        self.assertEqual(r.status_code, 200, r.text)
        vs = r.json()["versions"]
        self.assertEqual([(v["label"], v["usedBy"]) for v in vs],
                         [("Standard - Everyone", ["Employees In California"]),
                          ("Contractors - Anywhere", ["Contractors In California"])])
        self.assertEqual(vs[1]["who"], "Only contractors")
        r = self.client.post("/hr/hiring-setup/roles/jr-acct/duties", json={"hired_as": "full_time", "entity_id": CO})
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        new = next(v for v in out["versions"] if v["id"] == out["versionId"])
        self.assertEqual((new["text"], new["label"]), ("Keep the books.", "Full-Time Employees - Anywhere - Greens Test Only"))
        self.assertEqual(new["usedBy"], ["Full-Time Employees In California"])
        self.assertEqual(out["versions"][0]["usedBy"], ["Part-Time Employees In California"])
        r = self.client.post("/hr/hiring-setup/roles/jr-acct/duties", json={"hired_as": "full_time", "entity_id": CO})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["detail"], "This role already has a version for Full-Time Employees - Anywhere - "
                                             "Greens Test Only - change that one.")
        self.assertEqual(self.client.post("/hr/hiring-setup/roles/jr-acct/duties", json={}).json()["detail"],
                         "Pick who this version is for.")
        r = self.client.patch(f"/hr/hiring-setup/roles/jr-acct/duties/{out['versionId']}", json={"text": "  Close the month.  "})
        self.assertEqual(r.json(), {"id": out["versionId"], "text": "Close the month."})
        r = self.client.delete(f"/hr/hiring-setup/roles/jr-acct/duties/{out['versionId']}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual([v["id"] for v in r.json()["versions"]], ["standard", "dv-con"])
        self.db.expire_all()
        kept = [v for v in self.db.get(models.NexusGroup, "jr-acct").duty_versions if v["id"] == out["versionId"]]
        self.assertTrue(kept[0]["archivedAt"])                       # archived, never removed
        self.assertEqual(self.client.delete("/hr/hiring-setup/roles/jr-acct/duties/standard").json()["detail"],
                         "The standard version stays - change its text instead.")
        r = self.client.put("/hr/hiring-setup/roles/jr-acct/documents", json={"hiring_docs": [
            {"templateId": "t-jd-acct", "replaces": "@jd"}, {"templateId": "t-i9", "replaces": "@jd"}]})
        self.assertEqual(r.json()["detail"], "Only one document can take the job description's place.")
        r = self.client.put("/hr/hiring-setup/roles/jr-acct/documents", json={"hiring_docs": [
            {"templateId": "t-jd-acct", "replaces": "@jd"}]})
        self.assertEqual(r.json()["hiringDocs"][0]["replacesName"], "Job Description")
        got = self.client.get("/hr/hiring-setup/roles/jr-acct/duties").json()
        self.assertEqual(got["formattedJd"], {"templateId": "t-jd-acct", "name": "Accountant JD"})


class ScopeTests(SetupCase):
    def test_company_scoped_hr(self):
        hs_router.hr_scope = lambda user, db: {CO}
        r = self.make_own(entity_id="", country="US", region="CA")
        self.assertEqual((r.status_code, r.json()["detail"]), (403, SHARED_403))
        self.assertEqual(self.client.get("/hr/hiring-setup/company", params={"entity_id": GGC}).status_code, 404)
        r = self.client.patch("/hr/hiring-setup/roles/jr-acct/duties/standard", json={"text": "x"})
        self.assertEqual((r.status_code, r.json()["detail"]), (403, hs.SHARED_DUTIES))
        self.assertEqual(self.client.post("/hr/hiring-setup/use-same", json={"setting_id": "s-ca-offer"}).json()["detail"],
                         SHARED_403)
        self.assertEqual(self.make_own().status_code, 200)              # their own company is theirs
        self.assertEqual([c["id"] for c in self.client.get("/hr/hiring-setup").json()["companies"]], [CO])


class ThingsToFinishTests(SetupCase):
    def test_items_and_chips(self):
        tx = self.view(GS)
        texts = [i["text"] for i in tx["items"]]
        self.assertIn("No offer letter for Employees In Texas yet.", texts)
        miss = next(i for i in tx["items"] if i["key"] == "missing:employee:US:TX")
        self.assertEqual((miss["button"], miss["action"], miss["target"]),
                         ("Set It Up", "setUp", {"rowKey": "employee:US:TX", "column": "offer"}))
        self.assertIn("Clerk has no duties written, and the hiring packet prints them.", texts)   # printed inside
        self.assertEqual(tx["status"], "left")
        # India's packet prints no duties - no duties item there.
        self.assertFalse([i for i in self.view(GGC)["items"] if i["action"] == "addDuties"])
        self.assertEqual(self.view(NEW)["status"], "notStarted")
        r = self.client.put("/hr/packets/coverage/hired", json={"entity_id": GS, "worker_type": "contractor", "hired": False})
        self.assertEqual(r.status_code, 200)
        self.assertFalse([i for i in self.view(GS)["items"] if "Contractors" in i["text"]])
        self.assertTrue(self.row(self.view(GS), "contractor:US:TX")["notHired"])
        listing = self.client.get("/hr/hiring-setup").json()
        by_id = {c["id"]: c for c in listing["companies"]}
        self.assertEqual(by_id[NEW]["chip"], "Not Started")
        self.assertEqual(by_id[NEW]["place"], "No place set")
        self.assertTrue(by_id[GS]["chip"].endswith("Left"))
        self.assertEqual(by_id[CO]["summary"].split(" - ")[0], "Uses the shared offer letter and hiring packet")
        self.assertTrue(listing["shared"]["summary"].startswith("What every company uses unless it has its own: 2 offer letters, 3 hiring packets"))

    def test_add_a_place(self):
        r = self.client.put("/hr/hiring-setup/places", json={"entity_id": CO, "country": "US", "region": "TX"})
        self.assertEqual(r.json(), {"places": [{"country": "US", "region": "TX"}]})
        row = self.row(self.view(), "employee:US:TX")
        self.assertTrue(row["removable"])
        self.client.put("/hr/hiring-setup/places", json={"entity_id": CO, "country": "US", "region": "TX", "remove": True})
        self.assertNotIn("employee:US:TX", [r["key"] for r in self.view()["rows"]])
        self.assertEqual(self.client.put("/hr/hiring-setup/places", json={"entity_id": CO}).json()["detail"], "Pick a country.")


class ReviewFixTests(SetupCase):
    """The review findings on the API branch (Oct 23)."""

    def test_a_role_jd_document_is_left_out_when_the_packet_prints_the_duties(self):
        self.db.query(models.NexusGroup).filter_by(id="jr-clerk").update(
            {"job_description": "Count boxes.", "hiring_docs": [{"templateId": "t-jd-acct", "replaces": "@jd"}]})
        self.db.commit()
        docs = [{"templateId": "t-jd-acct", "replaces": "@jd"}]
        s = self.setting("s-tx-hire")
        self.assertEqual(hpd.template_ids_for(s, {"role_description": "Count boxes.", "role_docs": docs}, "hire"),
                         ["t-duty"])
        self.assertEqual(hpd.template_ids_for(self.setting("s-in-hire"), {"role_docs": docs}, "hire"),
                         ["t-i9", "t-jd-acct"])               # no marker, not printed inside: at the end, as before
        pk = self.row(self.view(GS, role="jr-clerk"), "employee:US:TX")["packet"]
        self.assertEqual(pk["placement"], "inside")
        self.assertEqual([d["id"] for d in pk["documents"]], ["t-duty"])

    def test_edit_wording_never_hands_a_company_the_shared_document(self):
        r = self.client.post("/hr/hiring-setup/settings/s-ca-hire/documents/t-agree/own-copy", params={"entity_id": CO})
        self.assertEqual((r.status_code, r.json()["detail"]), (400, hs.OWN_FIRST))

    def test_also_use_it_for_copies_the_primary_cells_documents(self):
        _setting(self.db, "s-ca-con-offer", "offer", ["t-i9"], wt="contractor", country="US", region="CA")
        self.db.commit()
        r = self.make_own(also=[{"worker_type": "contractor", "country": "US", "region": "CA"},
                                {"worker_type": "employee", "country": "US", "region": "NV"}])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([s["docTemplateIds"] for s in r.json()["settings"]], [["t-letter"]] * 3)

    def test_a_shared_roles_documents_need_every_company(self):
        hs_router.hr_scope = lambda user, db: {CO}
        body = {"hiring_docs": [{"templateId": "t-jd-acct", "replaces": "@jd"}]}
        r = self.client.put("/hr/hiring-setup/roles/jr-acct/documents", json=body)
        self.assertEqual((r.status_code, r.json()["detail"]), (403, hs.SHARED_ROLE_DOCS))
        self.assertEqual(self.client.put("/hr/hiring-setup/roles/jr-admin/documents", json=body).status_code, 200)

    def test_a_us_place_needs_a_state_where_the_home_state_would_fill_it(self):
        r = self.client.put("/hr/hiring-setup/places", json={"entity_id": CO, "country": "US", "region": ""})
        self.assertEqual(r.status_code, 400)
        r = self.client.put("/hr/hiring-setup/places", json={"entity_id": GGC, "country": "US", "region": ""})
        self.assertEqual(r.status_code, 200)                  # an India company's US-wide row is its own place
        self.assertIn("employee:US:", [x["key"] for x in self.view(GGC)["rows"]])
        self.assertEqual(self.make_own(region="").status_code, 200)
        self.assertNotIn("employee:US:", [x["key"] for x in self.view()["rows"]])

    def test_part_time_duties_are_checked_too(self):
        g = self.db.get(models.NexusGroup, "jr-acct")
        g.duty_versions = list(g.duty_versions) + [{"id": "dv-pt", "hiredAs": "part_time", "country": "", "region": "",
                                                    "entityId": "", "text": "", "updatedAt": "2026-10-02", "archivedAt": ""}]
        self.db.commit()
        v = self.view(GS)
        self.assertIn("Accountant has no duties written, and the hiring packet prints them.", [i["text"] for i in v["items"]])
        self.assertEqual(self.row(self.view(GS, role="jr-acct"), "employee:US:TX")["jd"]["tone"], "missing")

    def test_a_formatted_jd_counts_as_written_in_the_table(self):
        self.db.query(models.NexusGroup).filter_by(id="jr-clerk").update(
            {"hiring_docs": [{"templateId": "t-jd-acct", "replaces": "@jd"}]})
        self.db.commit()
        table = {r["roleId"]: r for r in self.view()["jobDescriptions"]["rows"]}
        self.assertEqual(table["jr-clerk"]["cells"]["employee:US:CA"]["label"], "Standard")

    def test_handles_hiring_names_who_the_send_goes_to(self):
        self.db.add(models.HrDepartment(id="d-hr", company_id=CO, name="Human Resources", lead_email=MGR))
        self.db.commit()
        self.addCleanup(lambda: (self.db.query(models.HrDepartment).delete(), self.db.commit()))
        hh = next(a for a in self.view()["about"] if a["key"] == "handlesHiring")
        self.assertEqual((hh["email"], hh["value"]), (MGR, "Max Mgr (HR Head)"))

    def test_an_uploaded_pdf_offer_is_flagged_and_not_copied(self):
        _setting(self.db, "s-tx-pdf", "offer", [], country="US", region="TX")
        self.db.commit()
        self.db.query(models.HrPacketSetting).filter_by(id="s-tx-pdf").update({"engine": "pdf", "template_id": "x"})
        self.db.commit()
        it = next(i for i in self.view(GS)["items"] if i["key"] == "pdf:s-tx-pdf")
        self.assertEqual((it["button"], it["target"]["column"]), ("Rebuild From A Word File", "offer"))
        r = self.make_own(entity_id=GS, region="TX")
        self.assertEqual(r.status_code, 400)
        self.assertIn("old uploaded PDF", r.json()["detail"])

    def test_the_offer_jd_line_when_the_packet_prints_no_duties(self):
        got = self.client.get("/hr/candidates/cand-1/offer/options",
                              params={"hired_as": "full_time", "role_id": "jr-acct", "country": "IN"}).json()
        jd = {x["key"]: x for x in got["whatTheyGet"]}["jd"]
        self.assertEqual((jd["name"], jd["tone"], jd["blocks"]), ("Not In This Packet", "same", False))

    def test_company_signers_follow_document_order(self):
        from types import SimpleNamespace
        snap = SimpleNamespace(content=_doc(_sig("employee"), _sig("signatory"), _sig("hr")))
        self.assertEqual(hs._signature_keys([snap]), ["employee", "signatory", "hr"])


if __name__ == "__main__":
    unittest.main()
