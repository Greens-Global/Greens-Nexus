"""HR life events - the hiring packet end to end (Neil/Pranshu call, Oct 8).

Candidate at Offer -> HR sends the company's packet -> HR signs at send ->
the candidate (external, personal email) signs LAST -> the candidate is hired
by the same function Mark Hired uses -> the sealed packet is filed into the
new employee's Egnyte folder by the filing pass. Plus the ways it must refuse
or recover: no packet set up, wrong stage, the person not signing last, a
second packet, a decline, a void, Egnyte down, and a hook bug that must never
cost the signer their signature.

Runs the REAL Nexus Sign engine (consent, one-time code, sealing) against its
own temporary database; Egnyte, mail and storage are local stand-ins.

Run with: python -m unittest test_hr_life_events -v
"""
import os
import tempfile
import unittest
from datetime import datetime, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import egnyte_wiring  # noqa: E402
import hr_life_events as hle  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import services.egnyte as svc  # noqa: E402
from routers import esign  # noqa: E402
from routers import hr as hr_router  # noqa: E402

ENTITY = "ent-hle"
HR = "hana.hr@greensglobal.com"
MGR = "max.mgr@greensglobal.com"
CAND_EMAIL = "jane.doe@gmail.com"
HR_USER = {"email": HR, "level": 5, "role": "admin"}

BODY = [
    "{{today}}",
    "Dear {{first_name}}, we offer you {{job_title}} at {{company}} starting {{start_date}} at {{salary}}.",
    "For {{company}}:", "[[sign:company]]",
    "Accepted:", "[[sign:employee]]", "[[date:employee]]",
]


class LifeEventCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        actual = database.engine.url.database or ""
        assert os.path.abspath(actual) == os.path.abspath(_tmp_db.name), actual
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self.db = database.SessionLocal()
        for m in (models.HrLifeEvent, models.HrPacketSetting, models.HrSignTemplate, models.HrSignParty,
                  models.HrSignRequest, models.HrSignConsent, models.HrSignDocument, models.HrSignSeal,
                  models.HrSignOtpChallenge, models.HrSignEvent, models.HrCandidate, models.HrStageEvent,
                  models.NexusEmployee, models.HrEntity, models.HrDocument, models.NexusNotification,
                  models.PayrollRate, models.PayrollRateHistory):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=ENTITY, name="Greens Test Co", legal_name="Greens Test Co, LLC"))
        for email, first in ((HR, "Hana"), (MGR, "Max")):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=email, first_name=first,
                                             last_name="Test", company=ENTITY, status="active"))
        self.db.add(models.HrSignTemplate(id="tpl-offer", name="Offer Packet", kind="offer", entity_id=ENTITY,
                                          body=BODY, status="active",
                                          roles=[{"key": "company", "label": "Company", "order": 1},
                                                 {"key": "employee", "label": "Employee", "order": 2}]))
        self.db.add(models.HrPacketSetting(id="set-hire", entity_id=ENTITY, event="hire", worker_type="any",
                                           template_id="tpl-offer", subject_role="employee",
                                           email_message="Welcome to Greens!"))
        self.db.add(models.HrCandidate(id="cand-1", first_name="Jane", last_name="Doe", email=CAND_EMAIL,
                                       role_title="Analyst", department="Accounting", stage="offer",
                                       company=ENTITY, created_by=HR, created_at="2026-10-01T00:00:00"))
        self.db.commit()
        esign._ensure_document_classes(self.db)
        self.codes, self.uploads, self.folders = {}, [], []
        self.egnyte_down = False

        def upload(path, content, token=None):
            if self.egnyte_down:
                raise svc.EgnyteError("Egnyte is down")
            self.uploads.append((path, len(content)))
            return {}

        self._patched = [(esign.sign_otp, "_send_email", esign.sign_otp._send_email),
                         (esign, "_send_sign_email", esign._send_sign_email),
                         (esign, "_send_sealed_email", esign._send_sealed_email),
                         (esign, "_storage_configured", esign._storage_configured),
                         (egnyte_wiring, "provision_person_folder", egnyte_wiring.provision_person_folder),
                         (svc, "configured", svc.configured), (svc, "create_folder", svc.create_folder),
                         (svc, "upload_file", svc.upload_file)]
        esign.sign_otp._send_email = lambda to, code, title, sender: self.codes.__setitem__(to, code) or ""
        self.invited = []
        self.mails = {}         # email -> (subject, html) of a life event's own invite

        def send_sign(party, req, sender, custom=None):
            self.invited.append(party.email)
            if custom:
                self.mails[party.email] = custom
            return True, ""
        esign._send_sign_email = send_sign
        self.sealed = {}       # email -> (subject, html) of a life event's "it's official" email

        def send_sealed(to_name, to_email, *a, **k):
            if k.get("custom"):
                self.sealed[to_email] = k["custom"]
            return True, ""
        esign._send_sealed_email = send_sealed
        esign._storage_configured = lambda: False          # local files only - never the shared buckets
        egnyte_wiring.provision_person_folder = (
            lambda emp, db: f"/Shared/#Entities/Greens Test Co/Human Resources/Employees/{emp.first_name} {emp.last_name}")
        svc.configured = lambda: True
        svc.create_folder = lambda path, token=None: self.folders.append(path) or {}
        svc.upload_file = upload

    def tearDown(self):
        for obj, name, real in self._patched:
            setattr(obj, name, real)
        auth.SKIP_AUTH = self._skip
        self.db.close()

    # ── helpers ──
    def _inputs(self, **kw):
        base = {"job_title": "Senior Analyst", "start_date": "2026-11-02", "manager_email": MGR,
                "employment_type": "full_time"}
        base.update(kw)
        return base

    def _send(self, **kw):
        pay = kw.pop("pay", {"base": 96000, "payBasis": "salary", "frequency": "annual", "currency": "USD"})
        return hle.send_hire(self.db, HR_USER, "cand-1", self._inputs(**kw), pay, None, excluded_ack=True)

    def _party(self, rid, email):
        self.db.expire_all()
        return (self.db.query(models.HrSignParty)
                .filter(models.HrSignParty.request_id == rid, models.HrSignParty.email == email).first())

    def _sign(self, party):
        c = self.client
        self.assertEqual(c.post(f"/esign/public/{party.token}/consent", json={"agreed": True}).status_code, 200)
        self.assertEqual(c.post(f"/esign/public/{party.token}/otp/request", json={"channel": "email"}).status_code, 200)
        r = c.post(f"/esign/public/{party.token}/otp/verify", json={"code": self.codes[party.email]})
        self.assertEqual(r.status_code, 200, r.text)
        r = c.post(f"/esign/public/{party.token}/sign", json={
            "consent": True, "signature_kind": "typed", "signature_data": party.name,
            "format_demonstrated": "pdf_rendered_in_session", "pages_viewed": 1, "pages_total": 1})
        self.assertEqual(r.status_code, 200, r.text)

    def _ev(self, eid):
        self.db.expire_all()
        return self.db.query(models.HrLifeEvent).filter_by(id=eid).first()

    def _run_filing_now(self):
        self.db.query(models.HrLifeEvent).update({"filing_next_at": "2000-01-01T00:00:00"})
        self.db.commit()
        return hle.process_due()


class HiringPacketTests(LifeEventCase):
    def test_full_journey_company_signs_then_candidate_then_hired_and_filed(self):
        ev = self._send()
        self.assertEqual(ev.status, "awaiting_sender")
        req = self.db.query(models.HrSignRequest).filter_by(id=ev.sign_request_id).first()
        self.assertEqual((req.link_kind, req.link_id), ("life_event", ev.id))
        self.assertIn("$96,000.00 per year", " ".join(req.body_snapshot))
        self.assertIn("November 2, 2026", " ".join(req.body_snapshot))
        # HR signs at send - no self-invite, and the candidate is not invited yet.
        self.assertEqual(self.invited, [])
        self.assertEqual(hle.sender_party_id(self.db, ev, HR), self._party(req.id, HR).id)

        self._sign(self._party(req.id, HR))
        self.assertEqual(self._ev(ev.id).status, "sent")
        self.assertEqual(self.invited, [CAND_EMAIL])          # invited only once HR signed
        cand_party = self._party(req.id, CAND_EMAIL)
        self.assertEqual(cand_party.kind, "external")

        self._sign(cand_party)
        ev = self._ev(ev.id)
        self.assertEqual(ev.status, "completed")
        cand = self.db.query(models.HrCandidate).filter_by(id="cand-1").first()
        self.assertEqual(cand.stage, "hired")
        emp = self.db.query(models.NexusEmployee).filter_by(id=cand.employee_id).first()
        self.assertEqual((emp.job_title, emp.start_date, emp.manager_email, emp.status, emp.personal_email),
                         ("Senior Analyst", "2026-11-02", MGR, "onboarding", CAND_EMAIL))
        self.assertEqual(emp.compensation["base"], 8000.0)      # annual stored monthly
        self.assertEqual(emp.compensation["effectiveDate"], "2026-11-02")
        self.assertEqual(ev.employee_id, emp.id)
        # The sealed packet is on the new employee's Documents tab.
        self.assertEqual(self.db.query(models.HrDocument).filter_by(employee_id=emp.id).count(), 1)
        # Nothing was filed into HR's own folder at sealing; the filing pass files it.
        self.assertEqual(self.uploads, [])
        self.assertEqual(ev.filing_status, "pending")
        self.assertEqual(self._run_filing_now(), 1)
        ev = self._ev(ev.id)
        self.assertEqual(ev.filing_status, "filed", ev.filing_error)
        path, size = self.uploads[0]
        self.assertTrue(path.startswith("/Shared/#Entities/Greens Test Co/Human Resources/Employees/Jane Doe/Hiring Documents/"))
        self.assertIn("Hiring Packet - Jane Doe (signed).pdf", path)
        self.assertGreater(size, 0)
        notes = [n.recipient for n in self.db.query(models.NexusNotification).all()]
        self.assertIn(MGR, notes)

    def test_life_event_envelope_never_falls_back_to_the_senders_folder(self):
        ev = self._send()
        req = self.db.query(models.HrSignRequest).filter_by(id=ev.sign_request_id).first()
        self.assertEqual(esign._signed_folder(self.db, req), "")

    def test_must_be_at_offer(self):
        self.db.query(models.HrCandidate).update({"stage": "interview"})
        self.db.commit()
        with self.assertRaises(hle.PacketError) as e:
            self._send()
        self.assertEqual(e.exception.status, 409)

    def test_no_packet_for_the_company_says_where_to_set_it_up(self):
        self.db.query(models.HrPacketSetting).delete()
        self.db.commit()
        with self.assertRaises(hle.PacketError) as e:
            self._send()
        self.assertIn("No hiring packet is set up for Greens Test Co", str(e.exception))

    def test_default_packet_covers_a_company_without_its_own(self):
        self.db.query(models.HrPacketSetting).update({"entity_id": ""})
        self.db.query(models.HrSignTemplate).update({"entity_id": ""})
        self.db.commit()
        self.assertEqual(self._send().status, "awaiting_sender")

    def test_the_person_must_sign_last(self):
        self.db.query(models.HrSignTemplate).update({"roles": [{"key": "employee", "order": 1},
                                                               {"key": "company", "order": 2}]})
        self.db.commit()
        s = self.db.query(models.HrPacketSetting).first()
        self.assertTrue(any("must sign last" in p for p in hle.setting_problems(self.db, s)))
        with self.assertRaises(hle.PacketError):
            self._send()

    def test_one_packet_at_a_time(self):
        self._send()
        with self.assertRaises(hle.PacketError) as e:
            self._send()
        self.assertEqual(e.exception.status, 409)

    def test_missing_merge_field_is_named_before_sending(self):
        self.db.query(models.HrSignTemplate).update({"body": BODY + ["Bonus: {{signing_bonus}}"]})
        self.db.commit()
        plan = hle.plan_hire(self.db, HR_USER, "cand-1", self._inputs(), None, None)
        self.assertEqual(plan["unresolved"], ["salary", "signing_bonus"])   # no pay given either
        plan = hle.plan_hire(self.db, HR_USER, "cand-1", self._inputs(salary_text="$40 per hour"), None, None)
        self.assertEqual(plan["unresolved"], ["signing_bonus"])
        with self.assertRaises(hle.PacketError) as e:
            self._send()
        self.assertIn("signing_bonus", str(e.exception))
        ok = self._send(merge={"signing_bonus": "$2,000"})
        self.assertEqual(ok.status, "awaiting_sender")

    def test_supervisor_must_be_in_nexus_people(self):
        with self.assertRaises(hle.PacketError):
            self._send(manager_email="stranger@example.com")

    def test_bad_pay_is_refused(self):
        with self.assertRaises(hle.PacketError):
            self._send(pay={"base": -5, "payBasis": "salary", "frequency": "annual"})

    def test_decline_returns_it_to_hr_and_the_candidate_stays_at_offer(self):
        ev = self._send()
        self._sign(self._party(ev.sign_request_id, HR))
        p = self._party(ev.sign_request_id, CAND_EMAIL)
        self.client.post(f"/esign/public/{p.token}/consent", json={"agreed": True})
        r = self.client.post(f"/esign/public/{p.token}/decline", json={"reason": "Start date too soon"})
        self.assertEqual(r.status_code, 200, r.text)
        ev = self._ev(ev.id)
        self.assertEqual((ev.status, ev.decline_reason), ("declined", "Start date too soon"))
        self.assertEqual(self.db.query(models.HrCandidate).filter_by(id="cand-1").first().stage, "offer")
        self.assertTrue(self.db.query(models.NexusNotification).filter_by(recipient=HR).count())
        # A new packet can go out after a decline.
        self.assertEqual(self._send().status, "awaiting_sender")

    def test_void(self):
        ev = self._send()
        esign.void_request(ev.sign_request_id, user=HR_USER, db=self.db)
        self.assertEqual(self._ev(ev.id).status, "voided")

    def test_egnyte_down_retries_then_tells_hr(self):
        ev = self._send()
        self._sign(self._party(ev.sign_request_id, HR))
        self._sign(self._party(ev.sign_request_id, CAND_EMAIL))
        self.egnyte_down = True
        self._run_filing_now()
        ev = self._ev(ev.id)
        self.assertEqual((ev.filing_status, ev.filing_attempts), ("pending", 1))
        self.assertGreater(ev.filing_next_at, datetime.now(timezone.utc).isoformat())
        for _ in range(len(hle.FILING_BACKOFF_MIN)):
            self._run_filing_now()
        ev = self._ev(ev.id)
        self.assertEqual(ev.filing_status, "failed")
        self.assertTrue(any("Not filed in Egnyte" in n.title for n in
                            self.db.query(models.NexusNotification).filter_by(recipient=HR).all()))
        # HR retries once Egnyte is back.
        self.egnyte_down = False
        ev.filing_attempts = 0
        hle.run_filing(self.db, ev)
        self.assertEqual(self._ev(ev.id).filing_status, "filed")

    def test_a_hook_bug_never_costs_the_signer_their_signature(self):
        ev = self._send()
        self._sign(self._party(ev.sign_request_id, HR))
        real = hle._APPLY["hire"]
        hle._APPLY["hire"] = lambda *a: (_ for _ in ()).throw(RuntimeError("boom"))
        try:
            self._sign(self._party(ev.sign_request_id, CAND_EMAIL))
        finally:
            hle._APPLY["hire"] = real
        self.db.expire_all()
        req = self.db.query(models.HrSignRequest).filter_by(id=ev.sign_request_id).first()
        self.assertEqual(req.status, "completed")
        self.assertEqual(self._ev(ev.id).status, "sent")      # the hook's writes rolled back alone


PROMO_BODY = [
    "Dear {{first_name}}, your role changes from {{old_title}} to {{new_title}} effective {{effective_date}}.",
    "Your new responsibilities: {{responsibilities}}. New pay: {{salary}}.",
    "[[sign:employee]]", "Approved by {{manager}}:", "[[sign:manager]]",
]
ERIN = "erin.emp@greensglobal.com"
HR_ONLY = {"email": HR, "level": 2, "role": "employee"}    # a People editor who is not an IT/Global Admin


class PromotionTests(LifeEventCase):
    """Neil: the letter goes to the employee, then the manager, then it is
    filed; HR enters the new pay and a date that can be in the past."""

    def setUp(self):
        super().setUp()
        for m in (models.NexusGroup, models.NexusGroupMember, models.NexusRole, models.TimeApproval):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id="ent-x", name="Elsewhere"))
        self.db.query(models.HrEntity).filter_by(id=ENTITY).update({"hr_contact_email": HR})
        self.db.add(models.NexusEmployee(id="id-erin", work_email=ERIN, first_name="Erin", last_name="Lee",
                                         company=ENTITY, status="active", manager_email=MGR, job_title="IT Dev Associate I"))
        self.db.add(models.NexusGroup(id="jr-1", name="IT Dev Associate I", department="IT", is_job_role=1,
                                      tier="employee", company_id=ENTITY))
        self.db.add(models.NexusGroup(id="jr-2", name="IT Dev Associate II", department="IT", is_job_role=1,
                                      tier="employee", company_id=ENTITY))
        self.db.add(models.NexusGroup(id="jr-admin", name="IT Administrator", department="IT", is_job_role=1,
                                      tier="administrator", company_id=ENTITY))
        self.db.add(models.NexusGroupMember(group_id="jr-1", email=ERIN))
        self.db.add(models.HrSignTemplate(id="tpl-promo", name="Promotion Letter", kind="custom", entity_id=ENTITY,
                                          body=PROMO_BODY, status="active",
                                          roles=[{"key": "employee", "label": "Employee", "order": 1},
                                                 {"key": "manager", "label": "Manager", "order": 2}]))
        self.db.add(models.HrPacketSetting(id="set-promo", entity_id=ENTITY, event="promotion", worker_type="any",
                                           template_id="tpl-promo", subject_role="employee"))
        # Erin already signed the timesheet for 09/06 - 09/19.
        self.db.add(models.TimeApproval(id="ta-1", employee_email=ERIN, period_start="2026-09-06",
                                        period_end="2026-09-19", kind="employee_sign", approved_by=ERIN,
                                        approved_at="2026-09-20T00:00:00", revoked=0, worked_min=4800))
        self.db.commit()

    def _promote(self, user=HR_ONLY, **kw):
        inputs = {"change_type": "promotion", "role_id": "jr-2", "effective_date": "2026-09-01",
                  "responsibilities": "Own the release pipeline"}
        inputs.update(kw.pop("inputs", {}))
        pay = kw.pop("pay", {"base": 40, "payBasis": "hourly", "currency": "USD"})
        return hle.send_promotion(self.db, user, "id-erin", inputs, pay, None, excluded_ack=True)

    def test_employee_then_manager_sign_then_role_pay_and_flags_apply(self):
        plan = hle.plan_promotion(self.db, HR_ONLY, "id-erin",
                                  {"role_id": "jr-2", "effective_date": "2026-09-01"},
                                  {"base": 40, "payBasis": "hourly"}, None)
        self.assertEqual([p.email for p in plan["parties"]], [ERIN, MGR])
        self.assertEqual(plan["flags"][0]["label"], "09/06/2026 - 09/19/2026")      # previewed before sending
        ev = self._promote()
        self.assertEqual(ev.status, "sent")                                         # employee is first - no HR signature
        req = self.db.query(models.HrSignRequest).filter_by(id=ev.sign_request_id).first()
        self.assertIn("from IT Dev Associate I to IT Dev Associate II", " ".join(req.body_snapshot))
        self.assertIn("$40.00 per hour", " ".join(req.body_snapshot))
        self._sign(self._party(req.id, ERIN))
        self.assertEqual(self._ev(ev.id).status, "sent")
        self._sign(self._party(req.id, MGR))
        ev = self._ev(ev.id)
        self.assertEqual(ev.status, "completed")
        member = self.db.query(models.NexusGroupMember).filter_by(email=ERIN).all()
        self.assertEqual([m.group_id for m in member], ["jr-2"])                     # one job role: the new one
        emp = self.db.query(models.NexusEmployee).filter_by(id="id-erin").first()
        self.assertEqual(emp.job_title, "IT Dev Associate II")
        self.assertEqual((emp.compensation["base"], emp.compensation["effectiveDate"]), (40.0, "2026-09-01"))
        hist = self.db.query(models.PayrollRateHistory).filter_by(employee_email=ERIN).all()
        self.assertEqual([h.effective_date for h in hist], ["2026-09-01"])
        self.assertEqual(ev.flags[0]["periods"][0]["start"], "2026-09-06")           # signed period flagged
        bells = {(n.recipient, n.title) for n in self.db.query(models.NexusNotification).all()}
        self.assertIn((HR, "Review signed timesheets - Erin Lee"), bells)
        self.assertIn((ERIN, "Your promotion is official"), bells)
        self.assertIn((MGR, "Promotion signed - Erin Lee"), bells)
        # Filed in Erin's folder under Promotion Documents
        self._run_filing_now()
        self.assertIn("/Promotion Documents/", self.uploads[0][0])

    def test_hr_cannot_hand_out_an_administrator_role(self):
        with self.assertRaises(hle.PacketError) as e:
            self._promote(inputs={"role_id": "jr-admin"})
        self.assertEqual(e.exception.status, 403)

    def test_a_manager_is_needed_when_the_letter_has_a_manager_signature(self):
        self.db.query(models.NexusEmployee).filter_by(id="id-erin").update({"manager_email": ""})
        self.db.commit()
        with self.assertRaises(hle.PacketError) as e:
            self._promote()
        self.assertIn("manager", str(e.exception))

    def test_nothing_changing_is_refused(self):
        with self.assertRaises(hle.PacketError):
            self._promote(inputs={"role_id": "jr-1", "job_title": "IT Dev Associate I"}, pay=None)

    def test_no_promotion_letter_set_up(self):
        self.db.query(models.HrPacketSetting).filter_by(event="promotion").delete()
        self.db.commit()
        with self.assertRaises(hle.PacketError) as e:
            self._promote()
        self.assertIn("No promotion letter", str(e.exception))

    def test_role_change_without_pay_flags_nothing(self):
        ev = self._promote(inputs={"change_type": "role_change", "salary_text": "unchanged"}, pay=None)
        self.assertEqual(ev.flags, [])


SEP_BODY = ["{{full_name}}: your last day is {{last_day}} ({{separation_type}}).",
            "For the company:", "[[sign:company]]", "Acknowledged:", "[[sign:employee]]"]


class OffboardTests(LifeEventCase):
    """Neil: an Offboard option per employee, the company's package through
    Nexus Sign; immediate -> personal email, still active -> company email.
    Pranshu: a future last day switches them to Left on that day."""

    def setUp(self):
        super().setUp()
        self.db.add(models.NexusEmployee(id="id-erin", work_email=ERIN, personal_email="erin@gmail.com",
                                         first_name="Erin", last_name="Lee", company=ENTITY, status="active",
                                         manager_email=MGR, job_title="Analyst"))
        self.db.add(models.HrSignTemplate(id="tpl-sep", name="Separation Package", kind="custom", entity_id=ENTITY,
                                          body=SEP_BODY, status="active",
                                          roles=[{"key": "company", "label": "Company", "order": 1},
                                                 {"key": "employee", "label": "Employee", "order": 2}]))
        self.db.add(models.HrPacketSetting(id="set-sep", entity_id=ENTITY, event="separation", worker_type="any",
                                           template_id="tpl-sep", subject_role="employee"))
        self.db.commit()

    def _off(self, last_day, **kw):
        inputs = {"last_day": last_day, "exit_type": "resignation", "reason": "Moving cities",
                  "offboarding": {"mailboxAction": "remove"}}
        inputs.update(kw)
        return hle.send_separation(self.db, HR_USER, "id-erin", inputs, None, excluded_ack=True)

    def _emp(self):
        self.db.expire_all()
        return self.db.query(models.NexusEmployee).filter_by(id="id-erin").first()

    def test_immediate_goes_to_the_personal_email_and_applies_now(self):
        ev, _result = self._off(hle._today())
        self.assertEqual(ev.subject_email, "erin@gmail.com")
        self.assertEqual(self._emp().status, "offboarded")
        ev = self._ev(ev.id)
        self.assertEqual(ev.apply_status, "applied")
        self.assertIn("Marked Left", ev.apply_note)
        party = self._party(ev.sign_request_id, "erin@gmail.com")
        self.assertEqual(party.kind, "external")              # no login needed - their account is closed
        self._sign(self._party(ev.sign_request_id, HR))
        self._sign(party)
        ev = self._ev(ev.id)
        self.assertEqual((ev.status, ev.apply_status), ("completed", "applied"))
        self._run_filing_now()
        self.assertIn("/Separation Documents/", self.uploads[0][0])

    def test_future_last_day_goes_to_work_email_and_applies_on_the_day(self):
        ev, _r = self._off("2099-01-31")
        self.assertEqual(ev.subject_email, ERIN)
        self.assertEqual(self._party(ev.sign_request_id, ERIN).kind, "internal")
        self.assertEqual(self._emp().status, "active")
        self.assertEqual(hle.apply_due_separations(), 0)       # not yet
        self.db.query(models.HrLifeEvent).filter_by(id=ev.id).update({"effective_date": "2026-01-01"})
        self.db.commit()
        self.assertEqual(hle.apply_due_separations(), 1)
        self.assertEqual(self._emp().status, "offboarded")
        self.assertEqual(self._ev(ev.id).apply_status, "applied")
        self.assertTrue(any("is now Left" in n.title for n in self.db.query(models.NexusNotification).all()))

    def test_cancel_stops_a_scheduled_offboarding(self):
        ev, _r = self._off("2099-01-31")
        hle.cancel_separation(self.db, self._ev(ev.id), HR)
        ev = self._ev(ev.id)
        self.assertEqual((ev.apply_status, ev.status), ("canceled", "voided"))
        self.db.query(models.HrLifeEvent).filter_by(id=ev.id).update({"effective_date": "2026-01-01"})
        self.db.commit()
        self.assertEqual(hle.apply_due_separations(), 0)
        self.assertEqual(self._emp().status, "active")

    def test_offboard_without_documents(self):
        self.db.query(models.HrPacketSetting).filter_by(event="separation").delete()
        self.db.commit()
        with self.assertRaises(hle.PacketError) as e:
            self._off(hle._today())
        self.assertIn("No separation package", str(e.exception))
        ev, _r = self._off(hle._today(), send_package=False)
        self.assertEqual((ev.sign_request_id, self._emp().status), ("", "offboarded"))

    def test_immediate_needs_a_personal_email(self):
        self.db.query(models.NexusEmployee).filter_by(id="id-erin").update({"personal_email": ""})
        self.db.commit()
        with self.assertRaises(hle.PacketError) as e:
            self._off(hle._today())
        self.assertIn("personal email", str(e.exception))

    def test_one_scheduled_offboarding_at_a_time(self):
        self._off("2099-01-31")
        with self.assertRaises(hle.PacketError):
            self._off("2099-02-28")


class EmailAndRoleTests(LifeEventCase):
    """Pranshu, Oct 8: the job title is one of the company's roles, "Other"
    adds a role (flagged for access); each life event has its own email with
    the link to sign."""

    def setUp(self):
        super().setUp()
        for m in (models.NexusGroup, models.NexusGroupMember, models.NexusRole):
            self.db.query(m).delete()
        self.db.add(models.NexusGroup(id="jr-an", name="Senior Analyst", department="Accounting", is_job_role=1,
                                      tier="employee", company_id=ENTITY))
        self.db.add(models.NexusRole(email="admin@greensglobal.com", role="owner"))
        self.db.commit()

    def test_the_new_hire_gets_a_welcome_email_with_the_link(self):
        ev = self._send(role_id="jr-an", job_title="")
        self._sign(self._party(ev.sign_request_id, HR))
        subject, html = self.mails[CAND_EMAIL]
        self.assertEqual(subject, "Welcome to Greens Test Co, LLC, Jane! Your offer is ready to sign 🎉")
        self.assertIn("Welcome to the team, Jane!", html)
        self.assertIn("Your offer at a glance", html)
        for fact in ("Senior Analyst", "Accounting", "Monday, November 2, 2026", "Max Test", "Full-Time",
                     "$96,000 per year"):
            self.assertIn(fact, html)
        self.assertIn("Welcome to Greens!", html)                  # the packet's welcome note
        token = self._party(ev.sign_request_id, CAND_EMAIL).token
        self.assertIn(f"/sign/{token}", html)                       # click and sign
        self.assertIn("Review &amp; Sign Your Offer", html)
        self.assertIn("What happens next", html)
        self.assertNotIn(HR, self.mails)                            # HR signing for the company: Nexus Sign's own email
        # Everyone signed -> "it's official", signed PDF attached by Nexus Sign
        self._sign(self._party(ev.sign_request_id, CAND_EMAIL))
        subject, html = self.sealed[CAND_EMAIL]
        self.assertEqual(subject, "You're officially part of Greens Test Co, LLC 🎉")
        self.assertIn("Before you start", html)
        self.assertNotIn(HR, self.sealed)

    def test_role_sets_title_and_department(self):
        plan = hle.plan_hire(self.db, HR_USER, "cand-1", {"role_id": "jr-an", "start_date": "2026-11-02"},
                             {"base": 1, "payBasis": "hourly"}, None)
        self.assertEqual((plan["details"]["job_title"], plan["details"]["department"]), ("Senior Analyst", "Accounting"))

    def test_other_adds_a_company_role_with_no_access_and_tells_the_admins(self):
        plan = hle.plan_hire(self.db, HR_USER, "cand-1",
                             {"new_role_name": "Leasing Coordinator", "department": "Operations", "start_date": "2026-11-02"},
                             {"base": 1, "payBasis": "hourly"}, None)
        self.assertEqual(hle.preview_out(plan)["newRole"], "Leasing Coordinator")
        self.assertEqual(self.db.query(models.NexusGroup).filter_by(name="Leasing Coordinator").count(), 0)  # not at preview
        ev = self._send(new_role_name="Leasing Coordinator", department="Operations", job_title="")
        role = self.db.query(models.NexusGroup).filter_by(name="Leasing Coordinator").first()
        self.assertEqual((role.company_id, role.allowed_modules, role.department), (ENTITY, "", "Operations"))
        self.assertEqual(ev.inputs["role_id"], role.id)
        bells = {(n.recipient, n.title) for n in self.db.query(models.NexusNotification).all()}
        self.assertIn(("admin@greensglobal.com", "New role needs access - Leasing Coordinator"), bells)

    def test_other_with_an_existing_name_reuses_the_role(self):
        ev = self._send(new_role_name="senior analyst", job_title="")
        self.assertEqual(ev.inputs["role_id"], "jr-an")
        self.assertEqual(self.db.query(models.NexusGroup).count(), 1)

    def test_the_role_lands_when_the_work_email_does(self):
        ev = self._send(role_id="jr-an", job_title="")
        self._sign(self._party(ev.sign_request_id, HR))
        self._sign(self._party(ev.sign_request_id, CAND_EMAIL))
        emp = self.db.query(models.NexusEmployee).filter_by(id=self._ev(ev.id).employee_id).first()
        emp.work_email = "jane.doe@greensglobal.com"
        hr_router.adopt_pending_pay(self.db, emp, HR)
        self.db.commit()
        self.assertEqual([m.group_id for m in self.db.query(models.NexusGroupMember)
                          .filter_by(email="jane.doe@greensglobal.com").all()], ["jr-an"])

    def test_promotion_email_says_what_the_pay_went_up_by(self):
        import hr_life_email
        # Same unit: the increase in that unit. Different units: no made-up figure.
        monthly = {"base": 7000, "payBasis": "salary", "frequency": "monthly", "currency": "USD"}
        change = hr_life_email.pay_change(monthly, {**monthly, "base": 8000})
        self.assertEqual((change["delta"], change["unit"]), (1000.0, "per month"))
        hourly = hr_life_email.pay_change({"base": 30, "payBasis": "hourly"}, {"base": 32.5, "payBasis": "hourly"})
        self.assertEqual((hourly["delta"], hourly["unit"]), (2.5, "per hour"))
        mixed = hr_life_email.pay_change(monthly, {"base": 96000, "payBasis": "salary", "frequency": "annual"})
        self.assertEqual((mixed["delta"], mixed["previous"]), (None, "$7,000 per month"))
        subject, html = hr_life_email.preview(self.db, HR_USER, "promotion", ENTITY, "Letter", "", [])
        self.assertTrue(subject.startswith("Congratulations, Jane! You've been promoted to Senior Analyst II"))
        for fact in ("Your new base pay", "$8,000 per month", "$7,000 per month", "Up $1,000 per month",
                     "Senior Analyst", "November 1, 2026", "month-end close"):
            self.assertIn(fact, html)
        for gone in ("%", "per year", "a year"):
            self.assertNotIn(gone, html.split("Your new base pay")[1].split("</table>")[0])

    def test_previews_render_for_every_event_and_stage(self):
        import hr_life_email
        for event in hle.EVENTS:
            subject, html = hr_life_email.preview(self.db, HR_USER, event, ENTITY, "Packet", "A note", ["NDA.pdf"])
            self.assertTrue(subject and "NDA.pdf" in html and "A note" in html, event)
            subject, html = hr_life_email.preview(self.db, HR_USER, event, ENTITY, "Packet", "", [], stage="completed")
            self.assertTrue(subject and "Warm regards" in html, event)
        self.assertNotIn("🎉", hr_life_email.preview(self.db, HR_USER, "separation", ENTITY, "P", "", [])[1])
        subject, _html = hr_life_email.preview(self.db, HR_USER, "promotion", ENTITY, "Letter", "", [], role="manager")
        self.assertTrue(subject.startswith("Approval needed"))


class SharedHireAndPayTests(LifeEventCase):
    def test_mark_hired_still_builds_the_employee(self):
        out = hr_router.update_candidate("cand-1", hr_router.CandidateUpdate(stage="hired"),
                                         user=HR_USER, db=self.db)
        emp = self.db.query(models.NexusEmployee).filter_by(id=out["employeeId"]).first()
        self.assertEqual((emp.job_title, emp.status, emp.employment_type), ("Analyst", "onboarding", "full_time"))

    def test_offer_pay_becomes_the_timecard_rate_when_the_work_email_lands(self):
        emp = models.NexusEmployee(id="id-new", first_name="Jane", last_name="Doe", company=ENTITY,
                                   status="onboarding",
                                   compensation=hle.compensation_from_pay(
                                       {"base": 30, "payBasis": "hourly", "currency": "USD"}, "2026-11-02"))
        self.db.add(emp)
        self.db.commit()
        emp.work_email = "jane.doe@greensglobal.com"
        hr_router.adopt_pending_pay(self.db, emp, HR)
        self.db.commit()
        rate = self.db.query(models.PayrollRate).filter_by(employee_email="jane.doe@greensglobal.com").first()
        self.assertEqual((rate.pay_type, rate.hourly_rate), ("hourly", 30.0))
        hist = self.db.query(models.PayrollRateHistory).filter_by(employee_email="jane.doe@greensglobal.com").all()
        self.assertEqual([h.effective_date for h in hist], ["2026-11-02"])

    def test_pay_text(self):
        self.assertEqual(hle.pay_text({"base": 32.5, "payBasis": "hourly", "currency": "USD"}), "$32.50 per hour")
        self.assertEqual(hle.pay_text({"base": 600000, "payBasis": "salary", "frequency": "annual",
                                       "currency": "INR"}), "₹600,000.00 per year")


if __name__ == "__main__":
    unittest.main()
