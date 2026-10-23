"""HR packets built from the Documents module (Neil, Oct 14) - configuration
and preview. A packet is Documents templates (read at their PUBLISHED
version) plus a signing order by ROLE; these pin the rules that keep it from
going out wrong:

  - every packet problem HR must fix, including the signatory rule (the name
    printed over a signature is the person who signs it);
  - every role resolves through the checklists' own resolver;
  - pay is detected fail-closed, whatever the variable is called;
  - previews resolve the CANDIDATE (a hire has no employee yet) and write
    nothing;
  - a documents packet never goes out through the old one-click send.

    python -m pytest test_hr_packet_docs.py
"""
import io
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402
from pypdf import PdfReader  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import hr_checklists as hc  # noqa: E402
import hr_packet_docs as hpd  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
CO = "co-packet"
HR = "charmi.hr" + D          # the company's HR contact, Pay & Benefits
NEIL = "neil.owner" + D       # owner, the authorized signatory
MGR = "max.mgr" + D           # a manager, no pay access
PLAIN = "pat.people" + D      # People editor without Pay & Benefits
GONE = "gary.gone" + D        # offboarded


def _doc(*nodes):
    return {"pages": [{"id": "p1", "json": {"type": "doc", "content": list(nodes)}}]}


def _p(*parts):
    return {"type": "paragraph", "content": [
        {"type": "mergeField", "attrs": {"token": x[2:-2]}} if x.startswith("{{") else {"type": "text", "text": x}
        for x in parts]}


def _sig(role, label=""):
    return {"type": "signatureBlock", "attrs": {"role": role, "label": label}}


OFFER = _doc(_p("Dear ", "{{first_name}}", " ", "{{last_name}}", ","),
             _p("We offer you ", "{{job_title}}", " at ", "{{salary}}", ", starting ", "{{start_date}}", "."),
             _p("Sincerely, ", "{{signer.company}}"), _sig("company", "For {{company_legal}}"), _sig("employee"))
OFFER_SIGNATORY = _doc(_p("Dear ", "{{first_name}}", ","), _p("Sincerely, ", "{{signatory}}"),
                       _sig("company"), _sig("employee"))
NDA = _doc(_p("Confidentiality for ", "{{full_name}}", "."), _sig("employee"))


class PacketDocsTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        db = database.SessionLocal()
        for m in (models.HrPacketSetting, models.DocTemplate, models.DocTemplateVersion, models.Document,
                  models.HrCandidate, models.NexusEmployee, models.HrEntity, models.NexusRole, models.NexusGroup,
                  models.NexusGroupMember, models.NexusSetting, models.HrLifeEvent, models.HrSignRequest,
                  models.HrDepartment):
            db.query(m).delete()
        db.add(models.HrEntity(id=CO, name="Greens Test", legal_name="Greens Test, LLC", hr_contact_email=HR, country="US",
                               signatory="Neil Owner, CEO", signatory_email=NEIL))
        for email, first, last, status in ((HR, "Charmi", "Shah", "active"), (NEIL, "Neil", "Owner", "active"),
                                           (MGR, "Max", "Mgr", "active"), (PLAIN, "Pat", "People", "active"),
                                           (GONE, "Gary", "Gone", "offboarded")):
            db.add(models.NexusEmployee(id=f"e-{first}", work_email=email, first_name=first, last_name=last,
                                        company=CO, status=status, job_title=f"{first} Title"))
        db.add(models.NexusRole(email=NEIL, role="owner"))
        db.add(models.NexusGroup(id="g-comp", name="People + Pay", allowed_modules="hr:editor,hr_comp:viewer"))
        db.add(models.NexusGroup(id="g-hr", name="People", allowed_modules="hr:editor"))
        db.add(models.NexusGroupMember(group_id="g-comp", email=HR))
        db.add(models.NexusGroupMember(group_id="g-hr", email=PLAIN))
        db.add(models.NexusGroupMember(group_id="g-hr", email=MGR))
        for tid, name, content in (("t-offer", "Offer Letter", OFFER), ("t-sig", "Signatory Offer", OFFER_SIGNATORY),
                                   ("t-nda", "NDA", NDA)):
            db.add(models.DocTemplate(id=tid, name=name, category="hr", status="active", version=1, content=content,
                                      department="", published_version=1,
                                      published_meta={"fieldDefs": [], "signerRoles": [], "mergeOverrides": {},
                                                      "letterheadId": "", "requiresLetterhead": False}))
            db.add(models.DocTemplateVersion(id=f"v-{tid}", template_id=tid, version_no=1, content=content))
        db.add(models.HrCandidate(id="cand-1", first_name="Jane", last_name="Doe", email="jane.doe@gmail.com",
                                  role_title="Analyst", department="Accounting", stage="offer", company=CO,
                                  created_by=HR, created_at="2026-10-01T00:00:00"))
        db.commit()
        db.close()
        cache.module_grants.invalidate()
        auth._role_cache.clear()
        os.environ["NEXUS_DEV_EMAIL"] = HR

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    # ── helpers ────────────────────────────────────────────────────────────
    def _setting(self, **kw):
        base = dict(id="s-hire", entity_id=CO, event="hire", worker_type="any", engine="documents",
                    name="IT Dev Associate", doc_template_ids=["t-offer", "t-nda"], template_id="",
                    flow=[{"key": "company", "role": "hr", "action": "sign"},
                          {"key": "employee", "role": "employee", "action": "sign"}],
                    verify_role="hr", pay_mode="")
        base.update(kw)
        return models.HrPacketSetting(**base)

    def _problems(self, **kw):
        db = database.SessionLocal()
        try:
            return hpd.config_problems(db, self._setting(**kw))
        finally:
            db.close()

    def _ctx(self, db, **kw):
        ent = db.query(models.HrEntity).filter_by(id=CO).first()
        ctx = {"entity": ent, "owners": hc.role_owners(db, CO), "sender": HR, "subject_email": "jane.doe@gmail.com",
               "subject_name": "Jane Doe", "subject_kind": "external", "manager_email": MGR}
        ctx.update(kw)
        return ctx

    def _save(self, **kw):
        body = dict(entity_id=CO, event="hire", name="IT Dev Associate", doc_template_ids=["t-offer", "t-nda"], country="US",
                    flow=[{"key": "company", "role": "hr", "action": "sign"},
                          {"key": "employee", "role": "employee", "action": "sign"}])
        body.update(kw)
        return self.client.put("/hr/packets/documents", json=body)

    def test_a_copied_role_packet_may_change_who_it_is_for_but_not_clash(self):
        """Copy From (Neil, Oct 22): the same role as employee and as contractor,
        or in another country, are two packets; the same hires twice is refused."""
        db = database.SessionLocal()
        db.add(models.NexusGroup(id="jr-acct", name="Accounting Associate", is_job_role=1, tier="employee", company_id=CO))
        db.commit()
        db.close()
        r = self._save(name="Acct - Employee", role_ids=["jr-acct"], worker_type="employee", country="US")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._save(name="Acct - Contractor", role_ids=["jr-acct"], worker_type="contractor",
                                    country="US").status_code, 200)
        self.assertEqual(self._save(name="Acct - India", role_ids=["jr-acct"], worker_type="employee",
                                    country="IN").status_code, 200)
        # A hiring packet always names its place now (Neil, Oct 22) - the clash is the same role, place and hire.
        r = self._save(name="Acct - Employee (Copy)", role_ids=["jr-acct"], worker_type="employee", country="US")
        self.assertEqual(r.status_code, 400)
        self.assertRegex(r.json()["detail"], r"^Accounting Associate already has a packet \(Acct - Employee\) for the same hires")

    # ── configuration problems ─────────────────────────────────────────────
    def test_a_good_packet_has_no_problems(self):
        self.assertEqual(self._problems(), [])

    def test_the_signatory_rule(self):
        p = self._problems(doc_template_ids=["t-sig"])
        self.assertTrue(any("authorized signatory" in x for x in p), p)
        ok = self._problems(doc_template_ids=["t-sig"],
                            flow=[{"key": "company", "role": "signatory", "action": "sign"},
                                  {"key": "employee", "role": "employee", "action": "sign"}])
        self.assertEqual(ok, [])

    def test_the_person_signs_exactly_once_in_either_saved_order(self):
        # Neil, Oct 22 2026: the person signs first. An order saved either way
        # is fine - signing_flow reorders it, it is never refused.
        self.assertEqual(self._problems(flow=[{"key": "employee", "role": "employee", "action": "sign"},
                                              {"key": "company", "role": "hr", "action": "sign"}]), [])
        self.assertEqual(self._problems(), [])        # company first, as saved before Oct 22
        p = self._problems(flow=[{"key": "company", "role": "hr", "action": "sign"}])
        self.assertTrue(any("Exactly one step must be The Person" in x for x in p), p)

    def test_the_company_never_signs_before_the_person(self):
        """Neil, Oct 22 2026: "The company never signs prior to the employee,
        ever." An old company-first config - Signs Once included - comes out
        person first, the company countersigning after."""
        db = database.SessionLocal()
        try:
            for event in ("hire", "separation", "promotion"):
                s = self._setting(event=event, flow=[{"key": "company", "role": "hr", "action": "sign", "once": True},
                                                     {"key": "employee", "role": "employee", "action": "sign"}])
                self.assertEqual([x["key"] for x in hpd.signing_flow(s)], ["employee", "company"], event)
                parties, _remap, problems = hpd.build_parties(db, s, self._ctx(db))
                self.assertEqual(problems, [])
                self.assertEqual([(x["key"], x["ordinal"]) for x in parties], [("employee", 1), ("company", 2)])
                self.assertEqual([x["key"] for x in hpd.ser_flow(db, s)], ["employee", "company"])
        finally:
            db.close()

    def test_a_promotion_letter_is_countersigned(self):
        """Pranshu, Oct 23 2026: someone signs after the person on a promotion
        letter - a person-only flow is a problem, a company step clears it."""
        p = self._problems(event="promotion", flow=[{"key": "employee", "role": "employee", "action": "sign"},
                                                    {"key": "company", "role": "hr", "action": "copy"}])
        self.assertTrue(any("promotion letter is countersigned" in x for x in p), p)
        self.assertFalse(any("countersigned" in x for x in self._problems(event="promotion")))
        self.assertFalse(any("countersigned" in x for x in self._problems(
            event="hire", flow=[{"key": "employee", "role": "employee", "action": "sign"}])))

    def test_an_offer_has_one_signer_the_person(self):
        """"Offer is just saying, do you accept?" - no company signer, no
        Signs Once, and the template's company block prints nothing rather
        than blocking the offer."""
        db = database.SessionLocal()
        try:
            s = self._setting(event="offer", doc_template_ids=["t-offer"],
                              flow=[{"key": "company", "role": "hr", "action": "sign", "once": True},
                                    {"key": "employee", "role": "employee", "action": "sign"},
                                    {"key": "boss", "role": "hr", "action": "copy"}])
            self.assertEqual([x["key"] for x in hpd.signing_flow(s)], ["employee", "boss"])
            self.assertEqual(hpd.config_problems(db, s), [])
            out = hpd.plan(db, s, ctx=self._ctx(db), overrides={"job_title": "Analyst", "start_date": "2026-11-02"},
                           pay={"base": 85000, "payBasis": "salary", "frequency": "annual", "currency": "USD"},
                           can_see_pay=True, candidate_id="cand-1", entity_id=CO)
            self.assertEqual(out["problems"], [])
            signers = [x for x in out["parties"] if x["partyRole"] != "cc"]
            self.assertEqual([x["email"] for x in signers], ["jane.doe@gmail.com"])
            self.assertEqual(out["signOnce"], [])                     # nothing saved to apply
            self.assertFalse(any(x.get("saved") for x in out["parties"]))
            snap = out["snaps"][0]
            self.assertEqual(snap.signature_roles, {"employee"})
            merge = hpd.full_merge(db, snap, candidate_id="cand-1", entity_id=CO, overrides=out["values"],
                                   pay=hpd.pay_merge({"base": 85000, "payBasis": "salary", "frequency": "annual",
                                                      "currency": "USD"}, {}))
            anchors = []
            pdf = hpd.render(db, snap, title="Offer", merge=merge, entity_id=CO, letterhead_id="", anchors=anchors)
            text = PdfReader(io.BytesIO(pdf)).pages[0].extract_text()
            self.assertIn("Sincerely, Charmi Shah", text)             # the name prints - as text
            self.assertNotIn("For Greens Test, LLC", text)           # the company block prints nothing
            self.assertEqual({a["role"] for a in anchors}, {"employee"})
        finally:
            db.close()

    def test_blocks_and_steps_must_match(self):
        p = self._problems(flow=[{"key": "employee", "role": "employee", "action": "sign"}])
        self.assertTrue(any('signature block for "company"' in x for x in p), p)
        p = self._problems(flow=[{"key": "company", "role": "hr", "action": "sign"},
                                 {"key": "witness", "role": "it", "action": "sign"},
                                 {"key": "employee", "role": "employee", "action": "sign"}])
        self.assertTrue(any('no document has a signature block for "witness"' in x for x in p), p)
        p = self._problems(flow=[{"key": "company", "role": "hr", "action": "copy"},
                                 {"key": "employee", "role": "employee", "action": "sign"}])
        self.assertTrue(any("make it Signs" in x for x in p), p)

    def test_an_unpublished_or_draft_template_is_a_problem_never_empty_output(self):
        db = database.SessionLocal()
        db.query(models.DocTemplate).filter_by(id="t-nda").update({"published_version": 0})
        db.query(models.DocTemplate).filter_by(id="t-sig").update({"status": "draft"})
        db.commit()
        db.close()
        p = self._problems(doc_template_ids=["t-offer", "t-nda"])
        self.assertTrue(any('"NDA" has not been published yet' in x for x in p), p)
        p = self._problems(doc_template_ids=["t-sig"])
        self.assertTrue(any("is draft in Documents" in x for x in p), p)

    def test_an_every_company_packet_cannot_print_a_fixed_letterhead(self):
        db = database.SessionLocal()
        tpl = db.query(models.DocTemplate).filter_by(id="t-offer").first()
        tpl.published_meta = {**tpl.published_meta, "requiresLetterhead": True}
        db.commit()
        db.close()
        self.assertTrue(any("fixed letterhead" in x for x in self._problems(entity_id="")))
        self.assertEqual(self._problems(), [])

    # ── roles ──────────────────────────────────────────────────────────────
    def test_roles_resolve_like_the_checklists(self):
        db = database.SessionLocal()
        try:
            db.add(models.HrDepartment(id="d-acct", company_id=CO, name="Accounting", lead_email=PLAIN))
            db.commit()
            emp = db.query(models.NexusEmployee).filter_by(work_email=MGR).first()
            emp.manager_email = HR
            ent = db.query(models.HrEntity).filter_by(id=CO).first()
            owners = hc.role_owners(db, CO)
            ctx = {"entity": ent, "owners": owners, "subject_email": MGR, "manager_email": HR}
            for role in hc.ROLES:
                self.assertEqual(hpd.resolve_role(db, role, ctx), hc.resolve_owner(db, role, emp, owners, ent), role)
            self.assertEqual(hpd.resolve_role(db, "signatory", ctx), NEIL)
            self.assertEqual(hpd.resolve_role(db, "payroll", ctx), PLAIN)
        finally:
            db.close()

    def test_role_failures_are_plain_problems(self):
        db = database.SessionLocal()
        try:
            ent = db.query(models.HrEntity).filter_by(id=CO).first()
            ent.hr_contact_email = ""
            s = self._setting()
            _parties, _remap, problems = hpd.build_parties(db, s, self._ctx(db))
            self.assertTrue(any("no HR contact" in x for x in problems), problems)
            ent.hr_contact_email = GONE
            _parties, _remap, problems = hpd.build_parties(db, s, self._ctx(db))
            self.assertTrue(any("not an active person" in x for x in problems), problems)
            ent.hr_contact_email = HR
            s.flow = [{"key": "company", "role": "payroll", "action": "sign"},
                      {"key": "employee", "role": "employee", "action": "sign"}]
            _parties, _remap, problems = hpd.build_parties(db, s, self._ctx(db))
            self.assertTrue(any("No Accounting owner" in x for x in problems), problems)    # Payroll became Accounting (Oct 19)
            s.flow = [{"key": "company", "role": "signatory", "action": "sign"},
                      {"key": "employee", "role": "employee", "action": "sign"}]
            ent.signatory_email = ""
            _parties, _remap, problems = hpd.build_parties(db, s, self._ctx(db))
            self.assertTrue(any("no Authorized Signatory" in x for x in problems), problems)
        finally:
            db.rollback()
            db.close()

    def test_the_person_never_signs_for_the_company(self):
        db = database.SessionLocal()
        try:
            s = self._setting(event="promotion",
                              flow=[{"key": "employee", "role": "employee", "action": "sign"},
                                    {"key": "company", "role": "hr", "action": "sign"}])
            _p, _r, problems = hpd.build_parties(db, s, self._ctx(db, subject_email=HR, subject_name="Charmi Shah"))
            self.assertTrue(any("cannot also act for the company" in x for x in problems), problems)
        finally:
            db.close()

    def test_consecutive_steps_for_one_person_collapse_others_keep_their_turn(self):
        db = database.SessionLocal()
        try:
            s = self._setting(flow=[{"key": "company", "role": "hr", "action": "sign"},
                                    {"key": "witness", "role": "hr", "action": "sign"},
                                    {"key": "employee", "role": "employee", "action": "sign"}])
            parties, remap, _ = hpd.build_parties(db, s, self._ctx(db))
            self.assertEqual([p["key"] for p in parties], ["employee", "company"])     # the person first
            self.assertEqual(remap, {"witness": "company"})
            s.flow = [{"key": "company", "role": "hr", "action": "sign"},
                      {"key": "late", "role": "signatory", "action": "sign"},
                      {"key": "employee", "role": "employee", "action": "sign"},
                      {"key": "again", "role": "hr", "action": "sign"}]
            parties, remap, _ = hpd.build_parties(db, s, self._ctx(db))
            self.assertEqual([p["key"] for p in parties], ["employee", "company", "late", "again"])
            self.assertEqual(remap, {})
        finally:
            db.close()

    # ── pay ────────────────────────────────────────────────────────────────
    def test_pay_is_detected_fail_closed(self):
        for t in ("salary", "hourly_rate", "signing_bonus", "new_salary", "pay.amount", "annual_ctc"):
            self.assertTrue(hpd.is_pay_token(t, {}), t)
        self.assertTrue(hpd.is_pay_token("package", {"package": {"pay": True}}))
        self.assertTrue(hpd.is_pay_token("offer_total", {"offer_total": {"type": "currency"}}))
        for t in ("first_name", "company", "start_date", "payroll_contact", "department"):
            self.assertFalse(hpd.is_pay_token(t, {}), t)

    def test_hire_packets_print_pay_by_default(self):
        db = database.SessionLocal()
        try:
            snaps, _ = hpd.load_snaps(db, ["t-nda"])
            self.assertTrue(hpd.packet_prints_pay(self._setting(), snaps))            # hire = always
            self.assertFalse(hpd.packet_prints_pay(self._setting(pay_mode="auto"), snaps))
            snaps, _ = hpd.load_snaps(db, ["t-offer"])
            self.assertTrue(hpd.packet_prints_pay(self._setting(event="separation"), snaps))
        finally:
            db.close()

    def test_has_comp_for_matches_a_signed_in_check(self):
        db = database.SessionLocal()
        try:
            self.assertTrue(hpd.has_comp_for(db, HR))      # grant
            self.assertTrue(hpd.has_comp_for(db, NEIL))    # owner
            self.assertFalse(hpd.has_comp_for(db, PLAIN))  # People editor, no grant
            self.assertFalse(hpd.has_comp_for(db, "jane.doe@gmail.com"))
        finally:
            db.close()

    def test_a_verifier_or_party_without_pay_access_blocks_a_pay_packet(self):
        db = database.SessionLocal()
        try:
            ent = db.query(models.HrEntity).filter_by(id=CO).first()
            ent.hr_contact_email = PLAIN
            out = hpd.plan(db, self._setting(), ctx=self._ctx(db), overrides={}, pay=None, can_see_pay=False,
                           candidate_id="cand-1", entity_id=CO)
            self.assertTrue(any("cannot see pay" in x for x in out["problems"]), out["problems"])
            self.assertTrue(any("no Pay & Benefits access" in x for x in out["problems"]), out["problems"])
        finally:
            db.rollback()
            db.close()

    # ── preview ────────────────────────────────────────────────────────────
    def test_preview_prints_the_candidate_and_writes_nothing(self):
        db = database.SessionLocal()
        try:
            s = self._setting()
            out = hpd.plan(db, s, ctx=self._ctx(db), overrides={"job_title": "Analyst", "start_date": "2026-11-02"},
                           pay={"base": 85000, "payBasis": "salary", "frequency": "annual", "currency": "USD"},
                           can_see_pay=True, candidate_id="cand-1", entity_id=CO)
            self.assertEqual(out["problems"], [])
            offer = out["documents"][0]
            self.assertEqual(offer["unresolved"], [])
            self.assertEqual([r["name"] for r in out["recipients"]], ["Jane Doe", "Charmi Shah"])
            self.assertEqual(out["verifier"]["email"], HR)
            snap = out["snaps"][0]
            merge = hpd.full_merge(db, snap, candidate_id="cand-1", entity_id=CO, overrides=out["values"],
                                   pay=hpd.pay_merge({"base": 85000, "payBasis": "salary", "frequency": "annual",
                                                      "currency": "USD"}, {}))
            anchors = []
            pdf = hpd.render(db, snap, title="Offer", merge=merge, entity_id=CO, letterhead_id="", anchors=anchors)
            text = PdfReader(io.BytesIO(pdf)).pages[0].extract_text()
            self.assertIn("Dear Jane Doe", text)
            self.assertIn("$85,000.00 per year", text)
            self.assertIn("11/02/2026", text)
            self.assertIn("Sincerely, Charmi Shah", text)                 # {{signer.company}}
            self.assertIn("For Greens Test, LLC", text)
            self.assertEqual({a["role"] for a in anchors}, {"company", "employee"})
            self.assertEqual(db.query(models.Document).count(), 0)
        finally:
            db.close()

    def test_without_pay_access_the_preview_prints_a_placeholder(self):
        db = database.SessionLocal()
        try:
            out = hpd.plan(db, self._setting(), ctx=self._ctx(db), overrides={}, pay=None, can_see_pay=False,
                           candidate_id="cand-1", entity_id=CO)
            self.assertNotIn("salary", out["documents"][0]["unresolved"])
        finally:
            db.close()

    # ── API ────────────────────────────────────────────────────────────────
    def test_save_checks_problems_and_returns_the_packet(self):
        r = self._save(flow=[{"key": "employee", "role": "employee", "action": "sign"}])
        self.assertEqual(r.status_code, 400, r.text)
        r = self._save()
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual(out["engine"], "documents")
        self.assertEqual([d["name"] for d in out["docTemplates"]], ["Offer Letter", "NDA"])
        self.assertEqual(out["problems"], [])
        listed = self.client.get("/hr/packets").json()
        self.assertTrue(any(t["id"] == "t-offer" and t["signs"] == ["company", "employee"]
                            for t in listed["docTemplates"]))

    def test_changing_pay_handling_needs_pay_access(self):
        os.environ["NEXUS_DEV_EMAIL"] = PLAIN
        self.assertEqual(self._save(pay_mode="auto").status_code, 403)

    def test_role_holders_name_who_holds_each_role_today(self):
        out = self.client.get(f"/hr/packets/role-holders?entity_id={CO}").json()
        self.assertEqual(out["hr"]["name"], "Charmi Shah")
        self.assertEqual(out["signatory"]["email"], NEIL)

    def test_render_preview_is_a_sample_pdf_and_saves_nothing(self):
        r = self.client.post("/hr/packets/render-preview", json={"template_id": "t-offer", "entity_id": CO,
                                                                   "flow": [{"key": "company", "role": "hr", "action": "sign"},
                                                                            {"key": "employee", "role": "employee", "action": "sign"}]})
        self.assertEqual(r.status_code, 200, r.text)
        text = PdfReader(io.BytesIO(r.content)).pages[0].extract_text()
        self.assertIn("Dear Jane Doe", text)
        db = database.SessionLocal()
        self.assertEqual(db.query(models.Document).count(), 0)
        db.close()

    def test_a_documents_packet_never_goes_out_through_the_old_send(self):
        self.assertEqual(self._save().status_code, 200)
        body = {"inputs": {"job_title": "Analyst", "start_date": "2030-11-02", "offer_expires": "2030-10-28"},
                "excluded_ack": True}
        r = self.client.post("/hr/candidates/cand-1/hiring-packet/preview", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["engine"], "documents")
        r = self.client.post("/hr/candidates/cand-1/hiring-packet", json=body)
        self.assertEqual(r.status_code, 409, r.text)
        db = database.SessionLocal()
        self.assertEqual(db.query(models.HrSignRequest).count(), 0)
        db.close()

    def test_the_company_signatory_must_be_a_nexus_person(self):
        r = self.client.patch(f"/hr/entities/{CO}", json={"signatory_email": "stranger@elsewhere.com"})
        self.assertEqual(r.status_code, 400, r.text)
        r = self.client.patch(f"/hr/entities/{CO}", json={"signatory_email": NEIL.upper()})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["signatoryEmail"], NEIL)



class FillInBlankTests(unittest.TestCase):
    """The Word import's blank patterns, run over a published template, so the
    packet says what still prints empty (Neil, 10/22 56:42)."""

    def test_lines_brackets_and_empty_labels_are_found(self):
        c = _doc(_p("Name: ", "{{full_name}}"),                    # a chip fills it
                 _p("Emergency Contact:"), _p("PAN Number: [      ]"),
                 _p("Paid Rs. ______ per month."), _p("______"),     # a bare pen line is left alone
                 _p("Witness: __________"))                          # notary / witness: filled on paper
        self.assertEqual(hpd.fill_in_blanks(c), ["Emergency Contact", "PAN Number:", "Paid Rs."])

    def test_lead_ins_headings_signatures_tables_and_headers(self):
        lst = {"type": "bulletList", "content": [{"type": "listItem", "content": [_p("Duty one")]}]}
        table = {"type": "table", "content": [{"type": "tableRow", "content": [
            {"type": "tableCell", "content": [_p("Phone:")]}, {"type": "tableCell", "content": [_p("{{phone}}")]}]}]}
        c = _doc(_p("Responsibilities:"), lst, _p("Benefits:"), _p("1. Health"), _p("COMPANY:"),
                 _p("Employee Signature:"), _sig("employee"), _p("Date:"), table)
        self.assertEqual(hpd.fill_in_blanks(c), [])
        c["footer"] = {"type": "doc", "content": [_p("Initials: ____")]}
        self.assertEqual(hpd.fill_in_blanks(c), ["Initials:"])


if __name__ == "__main__":
    unittest.main()
