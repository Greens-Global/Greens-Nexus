"""Probation tracking (Neil, Oct 27 2026) - hr_probation.py.

The date math (month ends, a company's length, a person's own), new hires
tracked by themselves while existing people stay Not Tracked, the reminder
firing once per end date, who may recommend and who finalizes, Confirm /
Extend / End, the letter going out through the REAL Nexus Sign engine with
the employee its only signer, and ON-33 ticking itself.

    python -m pytest test_hr_probation.py
"""
import os
import tempfile
import unittest
from datetime import date

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import hr_checklists as hc  # noqa: E402
import hr_probation as hp  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import esign  # noqa: E402

D = "@greensglobal.com"
CO = "co-prob"
HR = "hana.hr" + D            # the company HR contact - finalizes
HRED = "pat.people" + D       # People editor, not Full, not the contact - reads only
MGR = "max.mgr" + D           # Jane's manager (manager tier: People = own team)
EMP = "jane.doe" + D
OTHER = "omar.other" + D      # a plain employee
TODAY = date(2030, 3, 10)


class ProbationCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
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
        db = self.db = database.SessionLocal()
        for m in (models.HrLifeEvent, models.DocTemplate, models.DocTemplateVersion, models.DocLetterhead,
                  models.HrSignParty, models.HrSignRequest, models.HrSignConsent, models.HrSignDocument,
                  models.HrSignSeal, models.HrSignOtpChallenge, models.HrSignEvent, models.NexusEmployee,
                  models.HrEntity, models.HrDocument, models.NexusNotification, models.NexusRole, models.NexusGroup,
                  models.NexusGroupMember, models.HrChecklist, models.HrChecklistItem, models.HrChecklistTemplate,
                  models.NexusSetting, models.Task):
            db.query(m).delete()
        db.add(models.HrEntity(id=CO, name="Greens Test", legal_name="Greens Test, LLC", hr_contact_email=HR,
                               signatory="Dana Lee, Chief Executive Officer"))
        for email, first, last in ((HR, "Hana", "Hr"), (HRED, "Pat", "People"), (MGR, "Max", "Mgr"),
                                   (OTHER, "Omar", "Other")):
            db.add(models.NexusEmployee(id=f"e-{first}", work_email=email, first_name=first, last_name=last,
                                        company=CO, status="active", employee_code=f"GG-{first}"))
        db.add(models.NexusEmployee(id="e-jane", work_email=EMP, first_name="Jane", last_name="Doe", company=CO,
                                    status="active", job_title="Analyst", department="Accounting",
                                    employment_type="full_time", start_date="2029-12-31", manager_email=MGR,
                                    employee_code="GG-100"))
        db.add(models.NexusRole(email=MGR, role="manager"))
        db.add(models.NexusGroup(id="g-hr", name="People", allowed_modules="hr:editor"))
        for em in (HR, HRED):
            db.add(models.NexusGroupMember(group_id="g-hr", email=em))
        db.commit()
        hp.seed_templates(db)
        esign._ensure_document_classes(db)
        cache.module_grants.invalidate()
        auth._role_cache.clear()
        self._as(HR)
        self.codes, self.mails = {}, []
        self._patched = [(esign.sign_otp, "_send_email", esign.sign_otp._send_email),
                         (esign, "_send_sign_email", esign._send_sign_email),
                         (esign, "_send_sealed_email", esign._send_sealed_email),
                         (esign, "_storage_configured", esign._storage_configured),
                         (hp, "_today", hp._today), (hp, "send_emails", hp.send_emails)]
        esign.sign_otp._send_email = lambda to, code, title, sender: self.codes.__setitem__(to, code) or ""
        esign._send_sign_email = lambda party, req, sender, custom=None: (True, "")
        esign._send_sealed_email = lambda *a, **k: (True, "")
        esign._storage_configured = lambda: False
        hp._today = lambda: TODAY
        hp.send_emails = lambda batch: self.mails.extend(batch)

    def tearDown(self):
        for obj, name, real in self._patched:
            setattr(obj, name, real)
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)
        self.db.close()

    # ── helpers ────────────────────────────────────────────────────────────
    def _as(self, who):
        os.environ["NEXUS_DEV_EMAIL"] = who

    def _emp(self, eid="e-jane"):
        self.db.expire_all()
        return self.db.query(models.NexusEmployee).filter_by(id=eid).first()

    def _track(self, end=None, eid="e-jane"):
        """Jane on probation from 12/31/2029 (3 months -> 03/31/2030)."""
        self._as(HR)
        r = self.client.post(f"/hr/employees/{eid}/probation/start", json={})
        self.assertEqual(r.status_code, 200, r.text)
        if end:
            r = self.client.patch(f"/hr/employees/{eid}/probation", json={"end_date": end})
            self.assertEqual(r.status_code, 200, r.text)
        return r.json()["probation"]

    def _decide(self, who, decision, expect=200, **kw):
        self._as(who)
        r = self.client.post("/hr/employees/e-jane/probation/decision", json={"decision": decision, **kw})
        self.assertEqual(r.status_code, expect, r.text)
        return r.json()

    def _sign_as_employee(self, rid):
        self.db.expire_all()
        party = self.db.query(models.HrSignParty).filter_by(request_id=rid, email=EMP).first()
        c = self.client
        self.assertEqual(c.post(f"/esign/public/{party.token}/consent", json={"agreed": True}).status_code, 200)
        self.assertEqual(c.post(f"/esign/public/{party.token}/otp/request", json={"channel": "email"}).status_code, 200)
        r = c.post(f"/esign/public/{party.token}/otp/verify", json={"code": self.codes[EMP]})
        self.assertEqual(r.status_code, 200, r.text)
        r = c.post(f"/esign/public/{party.token}/sign", json={
            "consent": True, "signature_kind": "typed", "signature_data": party.name,
            "format_demonstrated": "pdf_rendered_in_session", "pages_viewed": 1, "pages_total": 1})
        self.assertEqual(r.status_code, 200, r.text)


class DateMathTests(unittest.TestCase):
    def test_calendar_months_and_month_ends(self):
        self.assertEqual(hp.add_months(date(2026, 1, 31), 1), date(2026, 2, 28))
        self.assertEqual(hp.add_months(date(2028, 1, 31), 1), date(2028, 2, 29))      # leap year
        self.assertEqual(hp.add_months(date(2026, 11, 30), 3), date(2027, 2, 28))     # across the year end
        self.assertEqual(hp.add_months(date(2026, 8, 31), 3), date(2026, 11, 30))
        self.assertEqual(hp.add_months(date(2026, 10, 15), 3), date(2027, 1, 15))
        self.assertEqual(hp.add_months(date(2026, 12, 1), 12), date(2027, 12, 1))
        self.assertEqual(hp.end_for("2026-05-31", 6), "2026-11-30")
        self.assertEqual(hp.end_for("", 3), "")

    def test_summary_window(self):
        e = models.NexusEmployee(id="x", first_name="X", probation={"status": "in_probation", "endDate": "2030-03-20"})
        s = hp.summary(e, 14, TODAY)
        self.assertEqual((s["label"], s["daysLeft"], s["ending"]), ("In Probation", 10, True))
        self.assertFalse(hp.summary(e, 5, TODAY)["ending"])
        self.assertEqual(hp.summary(models.NexusEmployee(id="y", first_name="Y"), 14, TODAY)["label"], "Not Tracked")


class LengthTests(ProbationCase):
    def test_company_default_company_override_and_person(self):
        p = self._track()
        self.assertEqual((p["status"], p["startDate"], p["endDate"], p["months"]),
                         ("in_probation", "2029-12-31", "2030-03-31", 3))
        # The company keeps its own length: a new start counts with it.
        r = self.client.put("/hr/probation/settings", json={"company": CO, "settings": {"months": 6}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["override"])
        self.assertEqual(hp.settings(self.db, CO)["months"], 6)
        self.assertEqual(hp.settings(self.db, "")["months"], 3)        # the default is untouched
        self.client.post("/hr/employees/e-jane/probation/stop", json={"reason": "Restart"})
        self.assertEqual(self._track()["endDate"], "2030-06-30")
        # A person's own length, then back to the company's.
        r = self.client.patch("/hr/employees/e-jane/probation", json={"months": 2})
        self.assertEqual(r.json()["probation"]["endDate"], "2030-02-28")
        r = self.client.patch("/hr/employees/e-jane/probation", json={"use_company_length": True})
        self.assertEqual(r.json()["probation"]["endDate"], "2030-06-30")
        # HR types the end date; a start date change then leaves it alone.
        r = self.client.patch("/hr/employees/e-jane/probation", json={"end_date": "2030-05-15"})
        p = r.json()["probation"]
        self.assertEqual((p["endDate"], p["endManual"]), ("2030-05-15", True))
        self.client.patch("/hr/employees/e-jane", json={"start_date": "2030-01-15"})
        self.assertEqual(hp.record(self._emp())["endDate"], "2030-05-15")
        # Reset the company: the default again.
        self.client.put("/hr/probation/settings", json={"company": CO, "reset": True})
        self.assertFalse(hp.has_override(self.db, CO))

    def test_start_date_change_moves_a_computed_end(self):
        self._track()
        r = self.client.patch("/hr/employees/e-jane", json={"start_date": "2030-01-31"})
        self.assertEqual(r.status_code, 200, r.text)
        rec = hp.record(self._emp())
        self.assertEqual((rec["startDate"], rec["endDate"]), ("2030-01-31", "2030-04-30"))
        self.assertEqual(r.json()["probation"]["endDate"], "2030-04-30")

    def test_settings_validation_and_permissions(self):
        r = self.client.put("/hr/probation/settings", json={"settings": {"months": 0}})
        self.assertEqual(r.status_code, 400)
        r = self.client.put("/hr/probation/settings", json={"settings": {"confirmTemplateId": "nope"}})
        self.assertEqual(r.status_code, 400)
        self._as(OTHER)
        self.assertEqual(self.client.put("/hr/probation/settings", json={"settings": {"months": 4}}).status_code, 403)


class NewHireTests(ProbationCase):
    def _add(self, **kw):
        body = {"first_name": "Nia", "last_name": "New", "company": CO, "employment_type": "full_time", **kw}
        r = self.client.post("/hr/employees", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_added_with_a_start_date_is_tracked(self):
        out = self._add(start_date="2030-03-01", manager_email=MGR)
        self.assertEqual((out["probation"]["status"], out["probation"]["endDate"]), ("in_probation", "2030-06-01"))

    def test_added_without_a_start_date_waits_for_one(self):
        out = self._add()
        self.assertEqual(out["probation"]["status"], "")
        self.assertTrue(hp.record(self._emp(out["id"]))["awaitingStart"])
        r = self.client.patch(f"/hr/employees/{out['id']}", json={"start_date": "2030-04-01"})
        self.assertEqual(r.json()["probation"]["status"], "in_probation")
        self.assertEqual(hp.record(self._emp(out["id"]))["endDate"], "2030-07-01")

    def test_existing_people_and_contractors_are_not_tracked(self):
        long_ago = self._add(start_date="2027-01-04")             # already past any probation
        # Never tracked, and past the window: Past Probation (derived, never
        # stored), not "Not Tracked" (Neil, Oct 29 2026).
        self.assertEqual((long_ago["probation"]["status"], long_ago["probation"]["label"],
                          long_ago["probation"]["pastSince"]), ("past", "Past Probation", "2027-04-04"))
        self.assertEqual(hp.record(self._emp(long_ago["id"])).get("status", ""), "")
        contractor = self._add(start_date="2030-03-01", employment_type="contractor")
        self.assertEqual(contractor["probation"]["status"], "")
        # Existing people are only picked up by the one-time startup pass
        # (backfill_existing): until it runs Jane reads Not Tracked, and the
        # daily pass reminds nobody.
        rows = {e["id"]: e for e in self.client.get("/hr/employees").json()}
        self.assertEqual(rows["e-jane"]["probation"]["label"], "Not Tracked")
        self.assertEqual(hp.run_daily(), 0)

    def test_existing_people_inside_their_window_are_backfilled_once(self):
        # TODAY is 03/10/2030; the company default is 3 months, the reminder 14 days.
        for eid, kw in (
                ("e-soon", {"start_date": "2029-12-20"}),                       # ends 03/20/2030 - inside the reminder window
                ("e-own", {"start_date": "2029-08-01", "probation": {"months": 9}}),  # own length: ends 05/01/2030
                ("e-old", {"start_date": "2029-06-01"}),                        # ended 09/01/2029 - past
                ("e-nostart", {}),                                              # no start date
                ("e-con", {"start_date": "2030-02-01", "employment_type": "contractor"}),
                ("e-ext", {"start_date": "2030-02-01", "identity_type": "external"}),
                ("e-gone", {"start_date": "2030-02-01", "status": "offboarded"}),
                ("e-done", {"start_date": "2030-02-01", "probation": {"status": "confirmed", "endDate": "2030-05-01"}})):
            self.db.add(models.NexusEmployee(**{"id": eid, "work_email": f"{eid}{D}", "first_name": eid[2:].title(),
                                                "last_name": "Test", "company": CO, "status": "active",
                                                "employment_type": "full_time", "manager_email": MGR, **kw}))
        self.db.commit()
        self.assertEqual(hp.backfill_existing(self.db), 3)                  # Jane, e-soon, e-own
        self.assertEqual(hp.backfill_existing(self.db), 0)                  # once (the nexus_settings mark)
        recs = {e.id: hp.record(e) for e in self.db.query(models.NexusEmployee).all()}
        self.assertEqual({k for k, r in recs.items() if r.get("status") == "in_probation"},
                         {"e-jane", "e-soon", "e-own"})
        self.assertEqual(recs["e-jane"]["endDate"], "2030-03-31")
        self.assertEqual(recs["e-own"]["endDate"], "2030-05-01")
        self.assertEqual(recs["e-done"]["status"], "confirmed")             # an existing record is left alone
        for eid in ("e-old", "e-nostart", "e-con", "e-ext", "e-gone", "e-Hana"):
            self.assertEqual(recs[eid].get("status", ""), "", eid)
        # The backfill itself sends nothing; e-soon, already inside the
        # window, gets ONE normal reminder from the daily pass - never again.
        self.assertEqual(self.db.query(models.NexusNotification).count(), 0)
        self.assertEqual(hp.run_daily(), 1)
        self.assertEqual(hp.run_daily(), 0)
        bells = self.db.query(models.NexusNotification).all()
        self.assertEqual(sorted(n.recipient for n in bells), [HR, MGR])
        self.assertTrue(all(n.ref_id == "probation:e-soon" for n in bells))
        self.assertEqual(len(self.mails), 2)

    def test_hired_candidate_is_tracked(self):
        from routers.hr import create_employee_from_candidate
        cand = models.HrCandidate(id="cand-1", first_name="Cal", last_name="Cand", email="cal@gmail.com",
                                  company=CO, stage="offer", expected_start="2030-04-06", created_by=HR,
                                  created_at="2030-03-01T00:00:00")
        self.db.add(cand)
        self.db.commit()
        emp = create_employee_from_candidate(self.db, cand, HR, {"employment_type": "full_time"})
        self.db.commit()
        rec = hp.record(self._emp(emp.id))
        self.assertEqual((rec["status"], rec["endDate"]), ("in_probation", "2030-07-06"))
        self.assertEqual(rec["history"][0]["reason"], "Hired")


class ReminderTests(ProbationCase):
    def _notices(self, to=None):
        self.db.expire_all()
        q = self.db.query(models.NexusNotification).filter(models.NexusNotification.ref_id == "probation:e-jane")
        return q.filter(models.NexusNotification.recipient == to).all() if to else q.all()

    def test_fires_once_to_the_manager_and_hr_contact(self):
        self._track(end="2030-04-10")                             # 31 days out - not yet
        self.assertEqual(hp.run_daily(), 0)
        self.client.patch("/hr/employees/e-jane/probation", json={"end_date": "2030-03-24"})   # 14 days out
        self.assertEqual(hp.run_daily(), 1)
        self.assertEqual(hp.run_daily(), 0)                       # once per end date
        self.assertEqual(sorted(n.recipient for n in self._notices()), [HR, MGR])
        self.assertEqual(sorted(m[0] for m in self.mails), [HR, MGR])
        n = self._notices(MGR)[0]
        self.assertEqual(n.title, "Probation Ending - Jane Doe")
        self.assertIn("03/24/2030", n.body)
        self.assertIn("Probation Ending - Jane Doe (03/24/2030)", self.mails[0][1])
        # The People list says it is ending.
        rows = {e["id"]: e for e in self.client.get("/hr/employees").json()}
        self.assertTrue(rows["e-jane"]["probation"]["ending"])

    def test_an_extension_reminds_again_in_place(self):
        self._track(end="2030-03-20")
        self.assertEqual(hp.run_daily(), 1)
        self._decide(HR, "extend", new_end_date="2030-04-15", reason="More time on the close")
        hp._today = lambda: date(2030, 4, 5)
        self.mails.clear()
        self.assertEqual(hp.run_daily(), 1)
        self.assertEqual(len(self._notices(MGR)), 1)              # the same bell, rewritten
        self.assertIn("04/15/2030", self._notices(MGR)[0].body)
        self.assertFalse(self._notices(MGR)[0].actioned)

    def test_nobody_who_left_is_reminded(self):
        self._track(end="2030-03-24")
        self.db.query(models.NexusEmployee).filter_by(id="e-jane").update({"status": "offboarded"})
        self.db.commit()
        self.assertEqual(hp.run_daily(), 0)
        self.assertFalse(hp.summary(self._emp(), 14, TODAY)["ending"])

    def test_window_is_per_company_and_zero_is_off(self):
        self._track(end="2030-03-24")
        self.client.put("/hr/probation/settings", json={"company": CO, "settings": {"reminderDays": 0}})
        self.assertEqual(hp.run_daily(), 0)
        self.client.put("/hr/probation/settings", json={"company": CO, "settings": {"reminderDays": 30}})
        self.client.patch("/hr/employees/e-jane/probation", json={"end_date": "2030-04-05"})
        self.assertEqual(hp.run_daily(), 1)


class PermissionTests(ProbationCase):
    def test_who_reads_recommends_and_finalizes(self):
        self._track()
        self._as(MGR)                                             # manager tier: allowed through the team gate
        r = self.client.get("/hr/employees/e-jane/probation")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["role"], r.json()["canFinalize"]), ("manager", False))
        self.assertEqual(self.client.post("/hr/employees/e-jane/probation/approve", json={}).status_code, 403)
        self.assertEqual(self.client.post("/hr/employees/e-jane/probation/start", json={}).status_code, 403)
        self._as(OTHER)                                           # no People access, not the manager
        self.assertEqual(self.client.get("/hr/employees/e-jane/probation").status_code, 404)
        self._decide(OTHER, "confirm", expect=404)
        self._as(HRED)                                            # People editor: reads, cannot decide
        self.assertEqual(self.client.get("/hr/employees/e-jane/probation").json()["role"], "")
        self._decide(HRED, "confirm", expect=403)
        self._as(EMP)                                             # never on your own probation
        self.assertEqual(self.client.get("/hr/employees/e-jane/probation").status_code, 404)

    def test_a_people_reader_never_reads_their_own_probation(self):
        # Release review (Oct 27): the People-viewer branch of can_read is
        # never the caller's own record.
        import auth
        me = self.db.query(models.NexusEmployee).filter_by(work_email=HRED).first()
        jane = self.db.query(models.NexusEmployee).filter_by(work_email=EMP).first()
        user = {"email": HRED, "level": auth.level_for(HRED, self.db)}
        self.assertTrue(hp.can_read(self.db, user, jane))
        self.assertFalse(hp.can_read(self.db, user, me))

    def test_full_hr_grant_and_administrator_finalize(self):
        self._track()
        self.db.add(models.NexusGroup(id="g-full", name="HR Full", allowed_modules="hr:full"))
        self.db.add(models.NexusGroupMember(group_id="g-full", email=HRED))
        self.db.commit()
        cache.module_grants.invalidate()
        self._as(HRED)
        self.assertEqual(self.client.get("/hr/employees/e-jane/probation").json()["role"], "hr")


class DecisionTests(ProbationCase):
    def test_manager_recommends_hr_approves_and_the_letter_goes(self):
        self._track()
        out = self._decide(MGR, "confirm")
        self.assertEqual((out["applied"], out["pending"]), (False, True))
        p = out["probation"]
        self.assertEqual((p["status"], p["pending"]["decision"], p["canDecide"]), ("in_probation", "confirm", False))
        self._decide(MGR, "extend", expect=409, new_end_date="2030-05-01", reason="x")   # one at a time
        hr_bell = self.db.query(models.NexusNotification).filter_by(ref_id="probation:e-jane", recipient=HR).first()
        self.assertEqual((hr_bell.title, hr_bell.priority), ("Probation Recommendation - Jane Doe", 1))
        self._as(HR)
        r = self.client.post("/hr/employees/e-jane/probation/approve", json={})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["status"], "confirmed")
        self.assertTrue(body["letter"]["sent"], body["letter"])
        p = body["probation"]
        self.assertEqual((p["status"], p["label"], p["decision"]["recommendedBy"]), ("confirmed", "Confirmed", MGR))
        # The letter: a probation life event, ONE party - the employee.
        ev = self.db.query(models.HrLifeEvent).filter_by(employee_id="e-jane", kind="probation").one()
        self.assertEqual((ev.status, ev.inputs["outcome"]), ("sent", "confirm"))
        parties = self.db.query(models.HrSignParty).filter_by(request_id=ev.sign_request_id).all()
        self.assertEqual([(x.email, x.role_key, x.party_role) for x in parties], [(EMP, "employee", "signer")])
        req = self.db.query(models.HrSignRequest).filter_by(id=ev.sign_request_id).one()
        self.assertEqual((req.title, req.link_kind), ("Probation Confirmation Letter - Jane Doe", "life_event"))
        # HR's waiting bell is done; the manager hears the outcome.
        self.db.expire_all()
        self.assertTrue(self.db.query(models.NexusNotification).filter_by(ref_id="probation:e-jane", recipient=HR)
                        .first().actioned)
        mgr = self.db.query(models.NexusNotification).filter_by(ref_id="probation:e-jane", recipient=MGR).first()
        self.assertEqual(mgr.title, "Probation Confirmed - Jane Doe")
        # The employee signs: the event completes and is queued for Egnyte.
        self._sign_as_employee(ev.sign_request_id)
        self.db.expire_all()
        ev = self.db.query(models.HrLifeEvent).filter_by(id=ev.id).one()
        self.assertEqual((ev.status, ev.filing_status), ("completed", "pending"), ev.apply_note)
        rec = hp.record(self._emp())
        self.assertTrue(rec["letter"]["signedAt"])
        self.assertEqual(rec["history"][-1]["action"], "letter_signed")
        self.assertTrue(self.db.query(models.HrDocument).filter_by(employee_id="e-jane").first())

    def test_manager_recommendation_declined(self):
        self._track()
        self._decide(MGR, "end", reason="Missed targets")
        self._as(HR)
        self.assertEqual(self.client.post("/hr/employees/e-jane/probation/decline", json={}).status_code, 400)
        r = self.client.post("/hr/employees/e-jane/probation/decline", json={"note": "Give it the full period"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNone(r.json()["probation"]["pending"])
        self.assertEqual(r.json()["probation"]["status"], "in_probation")
        mgr = self.db.query(models.NexusNotification).filter_by(ref_id="probation:e-jane", recipient=MGR).first()
        self.assertIn("Give it the full period", mgr.body)

    def test_extend_rules_and_letter(self):
        self._track()
        self._decide(HR, "extend", expect=400, new_end_date="2030-05-01")                    # reason required
        self._decide(HR, "extend", expect=400, new_end_date="2030-03-15", reason="More time")  # before the end
        out = self._decide(HR, "extend", new_end_date="2030-05-31", reason="More time on the close")
        p = out["probation"]
        self.assertEqual((p["status"], p["endDate"], p["decision"]["previousEndDate"]),
                         ("extended", "2030-05-31", "2030-03-31"))
        self.assertTrue(out["letter"]["sent"], out["letter"])
        ev = self.db.query(models.HrLifeEvent).filter_by(employee_id="e-jane", kind="probation").one()
        self.assertEqual(ev.inputs["outcome"], "extend")
        # Still open: it can be confirmed later, which sends its own letter
        # only once the extension letter is no longer out.
        out = self._decide(HR, "confirm")
        self.assertEqual(out["status"], "confirmed")
        self.assertFalse(out["letter"]["sent"])
        self.assertIn("already out for signature", out["letter"]["error"])
        self.assertIn("already out for signature", out["probation"]["letter"]["error"])

    def test_letter_preview_prints_the_probation_and_signatory(self):
        self._track()
        r = self.client.post("/hr/employees/e-jane/probation/letter-preview",
                             json={"decision": "extend", "new_end_date": "2030-05-31", "reason": "More time"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.headers["content-type"], "application/pdf")
        from io import BytesIO

        from pypdf import PdfReader
        text = "".join(pg.extract_text() or "" for pg in PdfReader(BytesIO(r.content)).pages)
        for want in ("Extension Of Probation Period", "Jane", "December 31, 2029", "March 31, 2030", "May 31, 2030",
                     "More time", "Dana Lee, Chief Executive Officer", "Greens Test, LLC", "Max Mgr"):
            self.assertIn(want, text)
        self._as(MGR)
        self.assertEqual(self.client.post("/hr/employees/e-jane/probation/letter-preview",
                                          json={"decision": "confirm"}).status_code, 403)

    def test_letter_problem_never_undoes_the_decision(self):
        self._track()
        self.db.query(models.HrEntity).filter_by(id=CO).update({"signatory": ""})
        self.db.commit()
        out = self._decide(HR, "confirm")
        self.assertEqual(out["status"], "confirmed")
        self.assertFalse(out["letter"]["sent"])
        self.assertIn("company signatory", out["letter"]["error"])
        self.assertEqual(self.db.query(models.HrLifeEvent).count(), 0)
        # Fixed in Settings > Companies, HR sends it again.
        self.db.query(models.HrEntity).filter_by(id=CO).update({"signatory": "Dana Lee"})
        self.db.commit()
        r = self.client.post("/hr/employees/e-jane/probation/send-letter")
        self.assertTrue(r.json()["letter"]["sent"], r.text)
        self.assertEqual(r.json()["probation"]["letter"]["status"], "sent")

    def test_a_template_with_a_company_signature_is_refused(self):
        t = self.db.query(models.DocTemplate).filter_by(id=hp.CONFIRM_TEMPLATE_ID).one()
        v = self.db.query(models.DocTemplateVersion).filter_by(template_id=t.id).one()
        content = dict(v.content)
        page = dict(content["pages"][0])
        page["json"] = {**page["json"], "content": page["json"]["content"]
                        + [{"type": "signatureBlock", "attrs": {"role": "company"}}]}
        content["pages"] = [page]
        v.content = content
        self.db.commit()
        self._track()
        out = self._decide(HR, "confirm")
        self.assertIn("only the employee signs", out["letter"]["error"])

    def test_end_employment_leads_to_the_offboarding(self):
        self._track()
        self._decide(HR, "end", expect=400)                                                   # reason required
        out = self._decide(HR, "end", reason="Did not meet the standards")
        self.assertEqual((out["status"], out["startSeparation"]), ("ended", True))
        self.assertNotIn("letter", out)
        self.assertEqual(self.db.query(models.HrLifeEvent).count(), 0)                        # Offboard does the rest
        self._decide(HR, "confirm", expect=409)                                               # nothing open to decide
        self.assertEqual(self._emp().status, "active")                                         # never offboarded by itself


class ChecklistTests(ProbationCase):
    def test_confirming_ticks_on33(self):
        emp = self._emp()
        cl = hc.start(self.db, emp, "onboarding", by=HR, notify=False)
        self.db.commit()
        item = self.db.query(models.HrChecklistItem).filter_by(checklist_id=cl.id, key="ON-33").one()
        self.assertEqual((item.status, item.signal), ("open", "probation_confirmed"))
        self._track()
        self._decide(HR, "confirm")
        self.db.expire_all()
        item = self.db.query(models.HrChecklistItem).filter_by(checklist_id=cl.id, key="ON-33").one()
        self.assertEqual((item.status, item.done_by, item.done_reason),
                         ("done", "Nexus", "Probation is Confirmed or Passed on the profile"))

    def test_an_older_checklist_takes_the_condition_then_ticks(self):
        # A library seeded before Oct 27: ON-33 without a condition, and a
        # checklist started from it.
        emp = self._emp()
        tpl = hc.get_template(self.db, "onboarding", "")
        tpl.items = [{**r, "signal": ""} if r.get("key") == "ON-33" else r for r in tpl.items]
        self.db.commit()
        cl = hc.start(self.db, emp, "onboarding", by=HR, notify=False)
        self.db.commit()
        self.assertEqual(self.db.query(models.HrChecklistItem).filter_by(checklist_id=cl.id, key="ON-33").one().signal, "")
        self.db.query(models.NexusSetting).filter_by(key=hp.SIGNAL_MARK).delete()
        self.db.commit()
        self.assertEqual(hp.backfill_checklist_signal(self.db), 1)
        self.assertEqual(hp.backfill_checklist_signal(self.db), 0)          # once
        self._track()
        self._decide(HR, "confirm")
        self.db.expire_all()
        item = self.db.query(models.HrChecklistItem).filter_by(checklist_id=cl.id, key="ON-33").one()
        self.assertEqual(item.status, "done")


class PastWindowTests(ProbationCase):
    """Past the window = passed (Neil, Oct 29 2026): "The people that have
    been here for 3 months or longer are not on probation, they clearly made
    the cut ... Should be an option also to remove from probation."""

    def _person(self, eid, start, rec=None, **kw):
        self.db.add(models.NexusEmployee(**{
            "id": eid, "work_email": f"{eid}{D}", "first_name": eid[2:].title(), "last_name": "Test", "company": CO,
            "status": "active", "employment_type": "full_time", "manager_email": MGR, "start_date": start,
            "probation": rec or {}, **kw}))
        self.db.commit()

    def _events(self, eid):
        self.db.expire_all()
        return self.db.query(models.WorkflowEvent).filter_by(key="probation.decided", subject_id=eid).all()

    def _bells(self, eid="e-jane"):
        self.db.expire_all()
        return self.db.query(models.NexusNotification).filter_by(ref_id=f"probation:{eid}").all()

    def test_daily_pass_passes_an_open_probation_past_its_end(self):
        emp = self._emp()
        cl = hc.start(self.db, emp, "onboarding", by=HR, notify=False)
        self.db.commit()
        self._track(end="2030-03-20")                             # ends 03/20/2030
        self.assertEqual(hp.run_daily(), 1)                       # the reminder bell, 10 days out
        self.assertTrue(self._bells() and not any(n.actioned for n in self._bells()))
        self.db.query(models.WorkflowEvent).delete()
        self.db.commit()
        self.mails.clear()
        hp._today = lambda: date(2030, 3, 20)                     # the last day: still open
        hp.run_daily()
        self.assertEqual(hp.record(self._emp())["status"], "in_probation")
        hp._today = lambda: date(2030, 3, 21)                     # the day after: passed
        self.assertEqual(hp.run_daily(), 0)
        rec = hp.record(self._emp())
        self.assertEqual((rec["status"], rec["remindedFor"]), ("passed", ""))
        self.assertEqual(rec["decision"]["decision"], "passed")
        self.assertTrue(rec["decision"]["automatic"])
        h = rec["history"][-1]
        self.assertEqual((h["action"], h["by"], h["from"], h["to"], h["reason"]),
                         ("passed", "system", "in_probation", "passed", hp.AUTO_PASS_REASON))
        self.assertTrue(all(n.actioned for n in self._bells()))   # the bells are closed
        self.assertEqual(self.db.query(models.HrLifeEvent).count(), 0)   # no letter
        self.assertEqual(self.mails, [])
        item = self.db.query(models.HrChecklistItem).filter_by(checklist_id=cl.id, key="ON-33").one()
        self.assertEqual(item.status, "done")                     # ON-33 ticks like a confirm
        ev = self._events("e-jane")
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0].payload["changes"]["probation.status"], {"from": "in_probation", "to": "passed"})
        self.assertEqual(ev[0].payload["extra"], {"decision": "passed", "automatic": True})
        # The card and the list say so.
        self._as(HR)
        p = self.client.get("/hr/employees/e-jane/probation").json()
        self.assertEqual((p["status"], p["label"], p["canDecide"], p["canRemove"], p["canSendLetter"]),
                         ("passed", "Passed Probation", False, False, True))
        self.assertEqual(p["history"][0]["byName"], "Nexus")
        rows = {e["id"]: e for e in self.client.get("/hr/employees").json()}
        self.assertEqual((rows["e-jane"]["probation"]["label"], rows["e-jane"]["probation"]["ending"]),
                         ("Passed Probation", False))
        # Nothing more on the next day.
        hp._today = lambda: date(2030, 3, 22)
        hp.run_daily()
        self.assertEqual(len(self._events("e-jane")), 1)

    def test_a_pending_recommendation_or_a_future_end_stays_open(self):
        self._track(end="2030-03-20")
        self._decide(MGR, "extend", new_end_date="2030-05-01", reason="More time")   # waiting for HR
        self._person("e-later", "2030-01-15", {"status": "in_probation", "startDate": "2030-01-15",
                                               "endDate": "2030-04-15"})
        self._person("e-left", "2029-01-15", {"status": "in_probation", "startDate": "2029-01-15",
                                              "endDate": "2029-04-15"}, status="offboarded")
        hp._today = lambda: date(2030, 3, 25)
        hp.run_daily()
        self.db.expire_all()
        recs = {e.id: hp.record(e) for e in self.db.query(models.NexusEmployee).all()}
        self.assertEqual(recs["e-jane"]["status"], "in_probation")   # a real decision in flight - HR's
        self.assertEqual(recs["e-later"]["status"], "in_probation")  # not at its end yet
        self.assertEqual(recs["e-left"]["status"], "in_probation")   # left: nobody to pass
        # HR still sees the recommendation in Approvals, past the end.
        self._as(HR)
        keys = [r["key"] for r in self.client.get("/approvals/inbox").json()["rows"] if r["key"].startswith("probation")]
        self.assertEqual(keys, ["probation:e-jane"])

    def test_an_extended_probation_passes_after_its_new_end(self):
        self._track()
        self._decide(HR, "extend", new_end_date="2030-04-30", reason="More time on the close")
        hp._today = lambda: date(2030, 4, 15)                     # past the first end, before the new one
        hp.run_daily()
        self.assertEqual(hp.record(self._emp())["status"], "extended")
        hp._today = lambda: date(2030, 5, 1)
        hp.run_daily()
        rec = hp.record(self._emp())
        self.assertEqual((rec["status"], rec["history"][-1]["from"]), ("passed", "extended"))

    def test_the_startup_pass_runs_once(self):
        self._person("e-old", "2029-06-01", {"status": "in_probation", "startDate": "2029-06-01",
                                             "endDate": "2029-09-01"})
        self._person("e-ext", "2029-06-01", {"status": "extended", "startDate": "2029-06-01",
                                             "endDate": "2029-12-01"})
        self._person("e-wait", "2029-06-01", {"status": "in_probation", "startDate": "2029-06-01",
                                              "endDate": "2029-09-01",
                                              "pending": {"decision": "confirm", "by": MGR, "at": "2029-09-02"}})
        self._person("e-new", "2030-02-01", {"status": "in_probation", "startDate": "2030-02-01",
                                             "endDate": "2030-05-01"})
        self.assertEqual(hp.pass_past_window_once(self.db), (2, 1))
        self.assertIsNone(hp.pass_past_window_once(self.db))      # once (the nexus_settings mark)
        self.db.expire_all()
        recs = {e.id: hp.record(e) for e in self.db.query(models.NexusEmployee).all()}
        self.assertEqual({k for k, r in recs.items() if r.get("status") == "passed"}, {"e-old", "e-ext"})
        self.assertEqual(recs["e-wait"]["status"], "in_probation")
        self.assertEqual(recs["e-new"]["status"], "in_probation")
        self.assertEqual(len(recs["e-old"]["history"]), 1)        # appended, nothing deleted

    def test_never_tracked_and_past_the_window_is_past_probation(self):
        self._person("e-four", "2029-11-10")                      # 4 months in: ended 02/10/2030
        self._person("e-one", "2030-02-05")                       # 1 month in: not past
        self._person("e-none", "")                                # no start date: we cannot know
        self._person("e-own", "2029-11-10", {"months": 6})        # own length: ends 05/10/2030
        self._person("e-con", "2029-01-10", employment_type="contractor")
        emps = {e.id: e for e in self.db.query(models.NexusEmployee).all()}
        s = hp.summaries(self.db, list(emps.values()))
        self.assertEqual((s["e-four"]["status"], s["e-four"]["label"], s["e-four"]["pastSince"]),
                         ("past", "Past Probation", "2030-02-10"))
        self.assertFalse(s["e-four"]["ending"])
        for eid in ("e-one", "e-none", "e-own", "e-con"):
            self.assertEqual((s[eid]["status"], s[eid]["label"]), ("", "Not Tracked"), eid)
        # The company's own length counts: 1 month puts e-one past too.
        r = self.client.put("/hr/probation/settings", json={"company": CO, "settings": {"months": 1}})
        self.assertEqual(r.status_code, 200, r.text)
        self.db.commit()
        self.assertEqual(hp.summaries(self.db, [emps["e-one"]])["e-one"]["status"], "past")
        self.client.put("/hr/probation/settings", json={"company": CO, "reset": True})
        # The card: Past Probation, no reminder, HR may start a new one.
        p = self.client.get("/hr/employees/e-four/probation").json()
        self.assertEqual((p["status"], p["label"], p["pastSince"], p["canDecide"]),
                         ("past", "Past Probation", "2030-02-10", False))
        self.assertEqual(hp.run_daily(), 0)
        self.assertEqual(self._bells("e-four"), [])
        # Start A New Probation counts from a day HR picks; one already over is refused.
        r = self.client.post("/hr/employees/e-four/probation/start", json={})
        self.assertEqual(r.status_code, 409, r.text)
        self.assertIn("already have ended on 02/10/2030", r.json()["detail"])
        r = self.client.post("/hr/employees/e-four/probation/start", json={"start_date": "2030-03-01",
                                                                         "reason": "New role"})
        self.assertEqual(r.status_code, 200, r.text)
        p = r.json()["probation"]
        self.assertEqual((p["status"], p["startDate"], p["endDate"]), ("in_probation", "2030-03-01", "2030-06-01"))
        # A later edit of their start date leaves a picked start alone.
        self.client.patch("/hr/employees/e-four", json={"start_date": "2029-11-12"})
        self.assertEqual(hp.record(self._emp("e-four"))["startDate"], "2030-03-01")

    def test_remove_from_probation(self):
        self._track()
        self._decide(MGR, "confirm")                              # a recommendation is waiting
        # A manager cannot remove; the person never reaches their own.
        self._as(MGR)
        self.assertEqual(self.client.post("/hr/employees/e-jane/probation/remove",
                                          json={"reason": "x"}).status_code, 403)
        self._as(EMP)
        self.assertIn(self.client.post("/hr/employees/e-jane/probation/remove",
                                       json={"reason": "x"}).status_code, (403, 404))
        self._as(HR)
        r = self.client.post("/hr/employees/e-jane/probation/remove", json={"reason": "  "})
        self.assertEqual(r.status_code, 400)                      # a reason is required
        r = self.client.post("/hr/employees/e-jane/probation/remove", json={"reason": "Moved from a sister company"})
        self.assertEqual(r.status_code, 200, r.text)
        p = r.json()["probation"]
        self.assertEqual((p["status"], p["label"], p["pending"], p["canRemove"]),
                         ("removed", "Removed From Probation", None, False))
        self.assertEqual((p["decision"]["decision"], p["decision"]["reason"], p["decision"]["byName"]),
                         ("removed", "Moved from a sister company", "Hana Hr"))
        self.assertEqual(p["history"][0]["action"], "removed")
        bells = {n.recipient: n for n in self._bells()}
        self.assertTrue(bells[HR].actioned)                       # HR's waiting bell is closed
        self.assertIn("recommendation is closed", bells[MGR].body)   # the recommender hears it is moot
        self.assertEqual(self.db.query(models.HrLifeEvent).count(), 0)   # no letter
        self.assertEqual(self.client.post("/hr/employees/e-jane/probation/remove",
                                          json={"reason": "again"}).status_code, 409)
        # Nothing restarts it: not a start date change, the backfill, a hire or the daily pass.
        self.client.patch("/hr/employees/e-jane", json={"start_date": "2030-02-01"})
        self.assertEqual(hp.record(self._emp())["status"], "removed")
        self.db.query(models.NexusSetting).filter_by(key=hp.BACKFILL_MARK).delete()
        self.db.commit()
        self.assertEqual(hp.backfill_existing(self.db), 0)
        self.assertFalse(hp.start_for_new_hire(self.db, self._emp(), HR, "Hired"))
        hp._today = lambda: date(2030, 6, 1)
        hp.run_daily()
        self.assertEqual(hp.record(self._emp())["status"], "removed")
        # HR can still start a new one.
        hp._today = lambda: TODAY
        r = self.client.post("/hr/employees/e-jane/probation/start", json={})
        self.assertEqual(r.json()["probation"]["status"], "in_probation")

    def test_stop_is_an_alias_of_remove(self):
        self._track()
        r = self.client.post("/hr/employees/e-jane/probation/stop", json={"reason": "Started by mistake"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["probation"]["status"], "removed")
        self.client.patch("/hr/employees/e-jane", json={"start_date": "2030-01-05"})
        self.assertEqual(hp.record(self._emp())["status"], "removed")

    def test_send_letter_on_a_passed_record_sends_the_confirmation_letter(self):
        self._track()
        hp._today = lambda: date(2030, 4, 1)
        hp.run_daily()
        self.assertEqual(hp.record(self._emp())["status"], "passed")
        self._as(MGR)
        self.assertEqual(self.client.post("/hr/employees/e-jane/probation/send-letter").status_code, 403)
        self._as(HR)
        r = self.client.post("/hr/employees/e-jane/probation/send-letter")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["letter"]["sent"], r.json()["letter"])
        ev = self.db.query(models.HrLifeEvent).filter_by(employee_id="e-jane", kind="probation").one()
        self.assertEqual((ev.inputs["outcome"], ev.effective_date), ("confirm", "2030-03-31"))
        p = r.json()["probation"]
        self.assertEqual((p["status"], p["letter"]["title"], p["letter"]["status"], p["canSendLetter"]),
                         ("passed", "Probation Confirmation Letter", "sent", False))

    def test_approvals_no_longer_list_a_passed_person(self):
        self._track()
        hp._today = lambda: date(2030, 4, 1)                      # past the end, nothing pending
        self._as(HR)
        rows = [r["key"] for r in self.client.get("/approvals/inbox").json()["rows"]]
        self.assertFalse([k for k in rows if k.startswith("probation")])   # no "decide" row any more
        hp.run_daily()
        rows = [r["key"] for r in self.client.get("/approvals/inbox").json()["rows"]]
        self.assertFalse([k for k in rows if k.startswith("probation")])


class SeedTests(ProbationCase):
    def test_templates_are_seeded_once_and_published(self):
        rows = self.db.query(models.DocTemplate).filter(
            models.DocTemplate.id.in_([hp.CONFIRM_TEMPLATE_ID, hp.EXTEND_TEMPLATE_ID])).all()
        self.assertEqual(sorted(r.name for r in rows), ["Probation Confirmation Letter", "Probation Extension Letter"])
        self.assertTrue(all(r.published_version == 1 and r.requires_letterhead for r in rows))
        self.db.query(models.DocTemplate).filter_by(id=hp.EXTEND_TEMPLATE_ID).delete()
        self.db.commit()
        self.assertEqual(hp.seed_templates(self.db), 0)                    # a deleted template stays deleted


if __name__ == "__main__":
    unittest.main()
