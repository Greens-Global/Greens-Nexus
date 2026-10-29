"""Performance reviews, made simple (Neil, Oct 29 2026) - perf_reviews.py
and routers/perf_reviews.py end to end, on a throwaway database with the
REAL Nexus Sign engine (consent, one-time code, sealing).

  * a cycle is three fields and starts at once; everyone past probation and
    not a contractor is in it; a late joiner is added; removed stays removed;
  * the stages: Self Review (optional once its due day passes) -> Manager
    Review -> Ready to Share (return to the manager) -> Shared -> the
    employee acknowledges with their comments -> Acknowledged; Share All
    Ready; a safe Close; a decline stays shared and tells HR;
  * the acknowledgement envelope has ONE signer - the employee;
  * permissions: outsiders 404, the employee sees nothing of the manager's
    part before it is shared, the private note is HR's (and its writer's),
    never in the PDF; the goals sit beside the form and are scored;
  * automatic reminders go out once each; the Approvals inbox rows.

Run with: python -m pytest test_perf_reviews.py -q
"""
import os
import tempfile
import unittest
from datetime import date, timedelta
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import perf_reviews as pr  # noqa: E402
from routers import esign  # noqa: E402
from routers import perf_reviews as api  # noqa: E402

CO, CO2 = "co-rev", "co-rev-2"
BOSS, MGR, EMP, PEER, OMGR, HR, FARHR, NEW, CONTRACTOR = (
    "boss.rv@greensglobal.com", "mgr.rv@greensglobal.com", "emp.rv@greensglobal.com", "peer.rv@greensglobal.com",
    "omgr.rv@greensglobal.com", "hr.rv@greensglobal.com", "farhr.rv@greensglobal.com", "new.rv@greensglobal.com",
    "con.rv@greensglobal.com")


def U(email, level=1):
    return {"email": email, "role": "employee", "level": level}


class _Req:
    """Enough of a Request for esign._client_meta."""
    headers = {}
    client = None


class ReviewCase(unittest.TestCase):
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
        auth._role_cache.clear()
        self.db = database.SessionLocal()
        for m in (models.PerfReview, models.PerfReviewCycle, models.PerfGoal, models.HrSignParty, models.HrSignRequest,
                  models.HrSignConsent, models.HrSignDocument, models.HrSignSeal, models.HrSignOtpChallenge,
                  models.NexusEmployee, models.HrEntity, models.NexusNotification, models.NexusSetting):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO, name="Review Co", hr_contact_email=HR))
        self.db.add(models.HrEntity(id=CO2, name="Other Co", hr_contact_email=FARHR))
        for email, first, mgr, dept, co, kind, start in (
                (BOSS, "Bea", "", "Ops", CO, "full_time", "2020-01-01"),
                (MGR, "Max", BOSS, "Ops", CO, "full_time", "2021-01-01"),
                (EMP, "Erin", MGR, "Ops", CO, "full_time", "2022-01-01"),
                (PEER, "Pat", MGR, "Ops", CO, "full_time", "2022-02-01"),
                (OMGR, "Olga", BOSS, "Sales", CO, "full_time", "2021-03-01"),
                (HR, "Hana", BOSS, "HR", CO, "full_time", "2020-05-01"),
                (NEW, "Ned", MGR, "Ops", CO, "full_time", "2026-10-01"),
                (CONTRACTOR, "Cal", MGR, "Ops", CO, "contractor", "2022-01-01"),
                (FARHR, "Fay", "", "HR", CO2, "full_time", "2020-01-01")):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=email, first_name=first, last_name="Test",
                                             company=co, manager_email=mgr, department=dept, status="active",
                                             employment_type=kind, start_date=start))
        self.db.commit()
        esign._ensure_document_classes(self.db)
        self.codes = {}
        self._patched = [(esign.sign_otp, "_send_email", esign.sign_otp._send_email),
                         (esign, "_send_sign_email", esign._send_sign_email),
                         (esign, "_send_sealed_email", esign._send_sealed_email),
                         (esign, "_egnyte_push", esign._egnyte_push)]
        esign.sign_otp._send_email = lambda to, code, title, sender: self.codes.__setitem__(to, code) or ""
        esign._send_sign_email = lambda *a, **k: (True, "")
        esign._send_sealed_email = lambda *a, **k: (True, "")
        esign._egnyte_push = lambda *a, **k: (False, "")

    def tearDown(self):
        for obj, name, real in self._patched:
            setattr(obj, name, real)
        self.db.close()

    # helpers
    def due(self, days=30):
        return (date.fromisoformat(pr.today()) + timedelta(days=days)).isoformat()

    def cycle(self, **kw):
        body = api.CycleIn(**{"company_id": CO, "name": "2026 Year-End Review", "due": self.due(), **kw})
        return api.create_cycle(body, U(HR), self.db)

    def launched(self):
        c = self.cycle()
        self.db.expire_all()
        r = self.db.query(models.PerfReview).filter_by(cycle_id=c["id"], employee_email=EMP).one()
        return c, r.id

    def answers(self, text="Did well"):
        return {"well": {"text": text}, "better": {"text": "More examples"}, "next": {"text": "Lead the Q1 launch"}}

    def to_ready(self):
        c, rid = self.launched()
        api.save_self(rid, api.SelfIn(answers=self.answers("Shipped the new desk"), submit=True), U(EMP), self.db)
        api.save_manager(rid, api.ManagerIn(answers=self.answers("Solid year"), rating="meets", promotion_ready=True,
                                            private_note="Watch the deadlines - not for Erin.", submit=True),
                         U(MGR), self.db)
        return c, rid

    def acknowledged(self, comment="Thanks - I agree on the launch."):
        c, rid = self.to_ready()
        api.share_review(rid, U(HR), self.db)
        out = api.acknowledge_review(rid, api.AckIn(comment=comment), _Req(), U(EMP), self.db)
        self.db.expire_all()
        r = self.db.get(models.PerfReview, rid)
        return c, rid, r, out

    def get(self, rid, who, level=1):
        return api.get_review(rid, U(who, level), self.db)

    def bells(self, who, title=None):
        q = self.db.query(models.NexusNotification).filter_by(recipient=who)
        return [n for n in q.all() if title is None or n.title == title]

    def refused(self, fn, code=404):
        with self.assertRaises(HTTPException) as e:
            fn()
        self.assertEqual(e.exception.status_code, code)

    def sign(self, party):
        c = self.client
        self.assertEqual(c.post(f"/esign/public/{party.token}/consent", json={"agreed": True}).status_code, 200)
        self.assertEqual(c.post(f"/esign/public/{party.token}/otp/request", json={"channel": "email"}).status_code, 200)
        r = c.post(f"/esign/public/{party.token}/otp/verify", json={"code": self.codes[party.email]})
        self.assertEqual(r.status_code, 200, r.text)
        r = c.post(f"/esign/public/{party.token}/sign", json={
            "consent": True, "signature_kind": "typed", "signature_data": party.name,
            "format_demonstrated": "pdf_rendered_in_session", "pages_viewed": 9, "pages_total": 9})
        self.assertEqual(r.status_code, 200, r.text)


class CycleTests(ReviewCase):
    def test_three_fields_and_it_starts_at_once(self):
        c = self.cycle()
        self.assertEqual(c["status"], "active")
        self.assertEqual(c["selfDue"], (date.fromisoformat(c["due"]) - timedelta(days=pr.SELF_LEAD_DAYS)).isoformat())
        self.assertEqual(c["periodEnd"], pr.today())                     # the six months ending today
        who = {r["employeeEmail"] for r in c["reviews"]}
        # Everyone at the company - never the contractor, never another company.
        self.assertEqual(who, {BOSS, MGR, EMP, PEER, OMGR, HR, NEW})
        self.assertEqual([n.title for n in self.bells(EMP)], ["Your Review Has Started"])
        self.assertIn("Reviews to Write", [n.title for n in self.bells(MGR)])
        self.refused(lambda: api.create_cycle(api.CycleIn(company_id=CO, name="x", due=self.due()), U(EMP), self.db), 403)
        self.refused(lambda: api.create_cycle(api.CycleIn(company_id=CO, name="x", due=self.due()), U(FARHR), self.db), 403)
        self.refused(lambda: api.create_cycle(api.CycleIn(company_id=CO, name="x", due="2020-01-01"), U(HR), self.db), 400)

    def test_probation_and_late_joiners(self):
        emp = self.db.query(models.NexusEmployee).filter_by(work_email=PEER).one()
        emp.probation = {"status": "in_probation", "endDate": "2027-01-01"}
        self.db.commit()
        c = self.cycle()
        self.assertNotIn(PEER, {r["employeeEmail"] for r in c["reviews"]})
        # Someone who joins the company while the cycle runs is added by the loop.
        self.db.add(models.NexusEmployee(id="id-late", work_email="late.rv@greensglobal.com", first_name="Lee",
                                         last_name="Test", company=CO, manager_email=MGR, department="Ops",
                                         status="active", employment_type="full_time", start_date=pr.today()))
        self.db.commit()
        self.assertEqual(pr.loop_pass(self.db)["added"], 1)
        self.db.commit()
        self.assertIn("late.rv@greensglobal.com", {r["employeeEmail"] for r in api.cycle_dashboard(c["id"], U(HR), self.db)["reviews"]})
        # Removed stays removed.
        rid = self.db.query(models.PerfReview).filter_by(cycle_id=c["id"], employee_email=EMP).one().id
        api.remove_review(rid, U(HR), self.db)
        self.assertEqual(pr.loop_pass(self.db)["added"], 0)
        self.refused(lambda: self.get(rid, EMP))
        self.assertEqual(api.my_reviews(U(EMP), self.db)["mine"], [])
        self.refused(lambda: api.remove_review(rid, U(MGR), self.db), 404)

    def test_share_all_and_a_safe_close(self):
        c, rid = self.to_ready()
        peer = self.db.query(models.PerfReview).filter_by(cycle_id=c["id"], employee_email=PEER).one().id
        api.save_self(peer, api.SelfIn(answers=self.answers(), submit=True), U(PEER), self.db)
        api.save_manager(peer, api.ManagerIn(answers=self.answers(), rating="exceeds", submit=True), U(MGR), self.db)
        dash = api.cycle_dashboard(c["id"], U(HR), self.db)
        self.assertEqual(dash["counts"]["ratings"], {"exceeds": 1, "meets": 1, "partly": 0, "below": 0})
        self.assertEqual(api.share_all(c["id"], U(HR), self.db)["shared"], 2)
        self.assertEqual([n.title for n in self.bells(EMP, "Your Review Is Ready")], ["Your Review Is Ready"])
        self.refused(lambda: api.close_cycle(c["id"], api.CloseIn(), U(HR), self.db), 409)   # five still mid-way
        out = api.close_cycle(c["id"], api.CloseIn(force=True), U(HR), self.db)
        self.assertEqual(out["status"], "closed")
        self.refused(lambda: api.share_all(c["id"], U(MGR), self.db), 404)


class FlowTests(ReviewCase):
    def test_the_whole_way_and_the_one_signer(self):
        c, rid = self.launched()
        self.refused(lambda: api.save_self(rid, api.SelfIn(answers={}, submit=True), U(EMP), self.db), 400)
        api.save_self(rid, api.SelfIn(answers=self.answers("Shipped the new desk")), U(EMP), self.db)
        # Before it is submitted (and before its due day) the manager waits.
        self.assertEqual(self.get(rid, MGR)["selfAnswers"], {})
        self.assertTrue(self.get(rid, MGR)["can"]["waitForSelf"])
        self.refused(lambda: api.save_manager(rid, api.ManagerIn(rating="meets"), U(MGR), self.db), 409)
        out = api.save_self(rid, api.SelfIn(answers=self.answers("Shipped the new desk"), submit=True), U(EMP), self.db)
        self.assertEqual(out["stage"], "manager_review")
        self.assertIn("Shipped the new desk", repr(self.get(rid, MGR)["selfAnswers"]))
        self.refused(lambda: api.save_self(rid, api.SelfIn(answers={}), U(EMP), self.db), 409)
        # The manager needs the Overall Rating, one of four words.
        self.refused(lambda: api.save_manager(rid, api.ManagerIn(answers=self.answers(), submit=True), U(MGR), self.db), 400)
        self.refused(lambda: api.save_manager(rid, api.ManagerIn(rating="5"), U(MGR), self.db), 400)
        api.save_manager(rid, api.ManagerIn(answers=self.answers("Solid year"), rating="meets",
                                            private_note="Not for Erin.", submit=True), U(MGR), self.db)
        self.assertEqual(self.get(rid, HR)["stage"], "ready")
        self.assertIn("Reviews Ready to Share", [n.title for n in self.bells(HR)])
        # HR sends it back to the manager, who resubmits.
        self.refused(lambda: api.return_review(rid, api.NoteIn(note=""), U(HR), self.db), 400)
        self.assertEqual(api.return_review(rid, api.NoteIn(note="Add an example"), U(HR), self.db)["stage"], "manager_review")
        api.save_manager(rid, api.ManagerIn(answers=self.answers("Solid year - the desk launch"), rating="exceeds",
                                            private_note="Not for Erin.", submit=True), U(MGR), self.db)
        # HR changes only the rating: nothing it did not send is blanked.
        api.save_manager(rid, api.ManagerIn(rating="meets"), U(HR), self.db)
        self.db.expire_all()
        r = self.db.get(models.PerfReview, rid)
        self.assertEqual((r.rating, r.manager_private_note), ("meets", "Not for Erin."))
        self.assertIn("the desk launch", repr(r.manager_answers))
        out = api.share_review(rid, U(HR), self.db)
        self.assertEqual(out["stage"], "shared")
        self.refused(lambda: api.share_review(rid, U(HR), self.db), 409)         # a double click
        mine = self.get(rid, EMP)
        self.assertEqual((mine["ratingLabel"], mine["can"]["acknowledge"]), ("Meets", True))
        self.assertNotIn("privateNote", mine)
        self.assertNotIn("promotionReady", mine)
        # Acknowledge: the comments are saved, ONE signer - the employee.
        ack = api.acknowledge_review(rid, api.AckIn(comment="I would add the Q3 audit."), _Req(), U(EMP), self.db)
        self.assertTrue(ack["signPartyId"])
        self.db.expire_all()
        r = self.db.get(models.PerfReview, rid)
        parties = self.db.query(models.HrSignParty).filter_by(request_id=r.sign_request_id).all()
        self.assertEqual([(p.email, p.role_key, p.party_role) for p in parties], [(EMP, "employee", "signer")])
        self.assertEqual(r.employee_comment, "I would add the Q3 audit.")
        again = api.acknowledge_review(rid, api.AckIn(comment="changed"), _Req(), U(EMP), self.db)
        self.assertEqual(again["signPartyId"], ack["signPartyId"])               # the same envelope
        self.refused(lambda: api.acknowledge_review(rid, api.AckIn(), _Req(), U(MGR), self.db), 403)
        self.sign(parties[0])
        self.db.expire_all()
        self.assertEqual(self.db.query(models.HrDocument).filter(models.HrDocument.storage_path.like("%Performance%")).count(), 0)
        self.refused(lambda: esign.download_final(r.sign_request_id, U(PEER), self.db))
        self.assertEqual(self.get(rid, HR)["stage"], "complete")
        self.assertEqual(self.get(rid, HR)["stageLabel"], "Acknowledged")

    def test_the_self_review_is_optional_after_its_due_day(self):
        c, rid = self.launched()
        late = (date.fromisoformat(c["selfDue"]) + timedelta(days=1)).isoformat()
        with mock.patch.object(pr, "today", return_value=late):
            api.save_manager(rid, api.ManagerIn(answers=self.answers("Steady"), rating="partly", submit=True), U(MGR), self.db)
        self.assertEqual(self.get(rid, HR)["stage"], "ready")
        self.refused(lambda: api.save_self(rid, api.SelfIn(answers=self.answers(), submit=True), U(EMP), self.db), 409)

    def test_goals_sit_beside_the_form_and_are_scored(self):
        from routers import performance as papi
        g = papi.create_goal(papi.GoalIn(title="Close 40 tickets", measure="number", target_value=40,
                                         owner_email=EMP, start_on=pr.today()), U(MGR), self.db)
        c, rid = self.launched()
        self.assertEqual([x["title"] for x in self.get(rid, MGR)["goals"]], ["Close 40 tickets"])
        api.save_self(rid, api.SelfIn(answers=self.answers(), submit=True), U(EMP), self.db)
        api.save_manager(rid, api.ManagerIn(answers=self.answers(), rating="meets", goal_scores={g["id"]: "partly", "nope": "met"},
                                            submit=True), U(MGR), self.db)
        self.db.expire_all()
        r = self.db.get(models.PerfReview, rid)
        self.assertEqual(r.goal_scores, {g["id"]: "partly"})
        self.assertEqual(r.goals_snapshot[0]["score"], "partly")

    def test_a_decline_stays_shared_and_tells_hr(self):
        c, rid, r, _ = self.acknowledged()
        party = self.db.query(models.HrSignParty).filter_by(request_id=r.sign_request_id).one()
        self.client.post(f"/esign/public/{party.token}/consent", json={"agreed": True})
        resp = self.client.post(f"/esign/public/{party.token}/decline", json={"reason": "The rating is wrong"})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.db.expire_all()
        back = self.get(rid, HR)
        self.assertEqual(back["stage"], "shared")
        self.assertIn("The rating is wrong", repr(back["history"]))
        self.assertTrue(self.bells(HR, "Review Not Signed"))
        self.assertTrue(api.acknowledge_review(rid, api.AckIn(), _Req(), U(EMP), self.db)["signPartyId"])

    def test_recall_voids_the_envelope(self):
        c, rid, r, _ = self.acknowledged()
        req_id = r.sign_request_id
        self.assertEqual(api.recall_review(rid, api.NoteIn(note="Fix a typo"), U(HR), self.db)["stage"], "ready")
        self.assertEqual(self.db.get(models.HrSignRequest, req_id).status, "voided")

    def test_a_new_reviewer_hears_and_sees_it(self):
        c, rid = self.launched()
        api.set_reviewer(rid, api.ReviewerIn(email=OMGR), U(HR), self.db)
        self.assertIn("Reviews to Write", [n.title for n in self.bells(OMGR)])
        self.assertIn(rid, {x["id"] for x in api.my_reviews(U(OMGR), self.db)["team"]})


class PrivacyTests(ReviewCase):
    def test_outsiders_get_404(self):
        c, rid = self.to_ready()
        for who in (PEER, OMGR, FARHR):
            self.refused(lambda w=who: self.get(rid, w))
        self.refused(lambda: self.get(rid, OMGR, level=3))
        self.refused(lambda: api.cycle_dashboard(c["id"], U(FARHR), self.db))
        self.refused(lambda: api.cycle_dashboard(c["id"], U(MGR), self.db))
        self.assertEqual([r for r in api.my_reviews(U(PEER), self.db)["team"] if r["employeeEmail"] == EMP], [])

    def test_the_employee_sees_nothing_of_the_manager_part_before_shared(self):
        c, rid = self.to_ready()
        mine = self.get(rid, EMP)
        for key in ("managerAnswers", "rating", "privateNote", "history", "promotionReady"):
            self.assertNotIn(key, mine)
        self.assertNotIn("Solid year", repr(mine))
        self.assertIn("Shipped the new desk", repr(mine["selfAnswers"]))

    def test_the_private_note_is_hr_only(self):
        c, rid = self.to_ready()
        self.assertEqual(self.get(rid, HR)["privateNote"], "Watch the deadlines - not for Erin.")
        self.assertEqual(self.get(rid, MGR)["privateNote"], "Watch the deadlines - not for Erin.")   # its writer
        boss = self.get(rid, BOSS)                       # the manager's manager: never
        self.assertNotIn("privateNote", boss)
        self.assertNotIn("Watch the deadlines", repr(boss))
        self.assertEqual(boss["rating"], "meets")        # reads the finished review
        self.assertEqual(boss["selfAnswers"], {})        # the self review only once shared

    def test_the_pdf_has_the_comments_never_the_note(self):
        drawn = []
        from reportlab.pdfgen import canvas
        real = canvas.Canvas.drawString
        with mock.patch.object(canvas.Canvas, "drawString", autospec=True,
                               side_effect=lambda self_, x, y, t, *a, **k: drawn.append(t) or real(self_, x, y, t, *a, **k)):
            self.acknowledged(comment="Thanks - I agree on the launch.")
        text = " ".join(drawn)
        self.assertIn("Solid year", text)
        self.assertIn("Thanks - I agree on the launch.", text)
        self.assertIn("Overall rating: Meets", text)
        self.assertNotIn("Watch the deadlines", text)
        self.assertNotIn("Promotion", text)
        self.assertIn("does not mean", text)

    def test_a_persons_reviews_on_their_profile(self):
        c, rid = self.to_ready()
        self.assertEqual([x["id"] for x in api.my_reviews(U(HR), self.db, person=EMP)["team"]], [rid])
        self.assertEqual(api.my_reviews(U(BOSS), self.db, person=EMP)["team"][0]["rating"], "meets")
        for who in (PEER, OMGR, FARHR):
            self.refused(lambda w=who: api.my_reviews(U(w), self.db, person=EMP))

    def test_who_writes_what(self):
        c, rid = self.launched()
        self.refused(lambda: api.save_self(rid, api.SelfIn(answers={}), U(MGR), self.db), 403)
        api.save_self(rid, api.SelfIn(answers=self.answers(), submit=True), U(EMP), self.db)
        self.refused(lambda: api.save_manager(rid, api.ManagerIn(answers={}), U(EMP), self.db), 403)
        self.refused(lambda: api.save_manager(rid, api.ManagerIn(answers={}), U(BOSS), self.db), 403)
        self.refused(lambda: api.share_review(rid, U(MGR), self.db), 403)

    def test_envelope_screens_follow_the_review(self):
        c, rid, r, _ = self.acknowledged()
        req = self.db.get(models.HrSignRequest, r.sign_request_id)
        self.assertTrue(pr.can_view_envelope(self.db, req, U(EMP)))
        self.assertTrue(pr.can_view_envelope(self.db, req, U(HR)))
        self.assertFalse(pr.can_view_envelope(self.db, req, U(PEER)))


class ReminderTests(ReviewCase):
    def test_each_reminder_goes_out_once(self):
        c, rid = self.launched()
        soon = (date.fromisoformat(c["selfDue"]) - timedelta(days=pr.SOON_DAYS)).isoformat()
        self.db.query(models.NexusNotification).delete()
        self.db.commit()
        with mock.patch.object(pr, "today", return_value=soon):
            pr.loop_pass(self.db)
            pr.loop_pass(self.db)
        self.db.commit()
        self.assertEqual(len(self.bells(EMP, "Self Review Due Soon")), 1)
        with mock.patch.object(pr, "today", return_value=c["selfDue"]):
            pr.loop_pass(self.db)
            pr.loop_pass(self.db)
        self.db.commit()
        self.assertEqual(len(self.bells(EMP, "Self Review Due Today")), 1)
        self.db.expire_all()
        r = self.db.get(models.PerfReview, rid)
        self.assertEqual(sorted(k for k in r.reminded if k != "launch"), ["dueSelf", "soonSelf"])
        mgr_soon = (date.fromisoformat(c["managerDue"]) - timedelta(days=pr.SOON_DAYS)).isoformat()
        with mock.patch.object(pr, "today", return_value=mgr_soon):
            pr.loop_pass(self.db)
            pr.loop_pass(self.db)
        self.db.commit()
        self.assertEqual(len(self.bells(MGR, "Reviews Due Soon")), 1)


class ApprovalsTests(ReviewCase):
    def test_what_waits_on_whom(self):
        import approvals_inbox as ai
        c, rid = self.launched()

        def kinds(who):
            return sorted(x["id"].split(":")[1] for x in ai._perf_reviews(self.db, U(who), {}) if x["id"].startswith(rid))
        self.assertEqual(kinds(EMP), ["self"])
        self.assertEqual(kinds(MGR), [])                     # waits for the self review
        api.save_self(rid, api.SelfIn(answers=self.answers(), submit=True), U(EMP), self.db)
        self.assertEqual((kinds(EMP), kinds(MGR)), ([], ["write"]))
        api.save_manager(rid, api.ManagerIn(answers=self.answers(), rating="meets", submit=True), U(MGR), self.db)
        self.assertEqual((kinds(MGR), kinds(HR)), ([], ["share"]))
        api.share_review(rid, U(HR), self.db)
        self.assertEqual(kinds(EMP), ["acknowledge"])

    def test_a_proposed_goal_waits_on_the_manager(self):
        import approvals_inbox as ai
        from routers import performance as papi
        g = papi.create_goal(papi.GoalIn(title="Learn the new POS"), U(EMP), self.db)
        rows = ai._perf_goals(self.db, U(MGR), {})
        self.assertEqual([x["id"] for x in rows], [g["id"]])
        self.assertEqual(ai._perf_goals(self.db, U(BOSS), {}), [])        # direct manager only
        papi.approve_goal(g["id"], U(MGR), self.db)
        self.assertEqual(ai._perf_goals(self.db, U(MGR), {}), [])


if __name__ == "__main__":
    unittest.main()
