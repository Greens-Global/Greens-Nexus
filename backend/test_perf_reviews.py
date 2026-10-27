"""Performance review cycles (Neil, Oct 27 2026) - perf_reviews.py and
routers/perf_reviews.py end to end, on a throwaway database with the REAL
Nexus Sign engine (consent, one-time code, sealing).

  * the stages: Self Review -> Manager Review -> HR Finalize (return to the
    manager, edit) -> Shared With Employee -> the employee signs -> Complete;
    a decline brings it back to HR;
  * the acknowledgement envelope has ONE signer - the employee;
  * permissions: a manager of a different team and a peer get 404, the
    employee sees nothing of the manager's part before it is shared and never
    the private note (not in the response, not in the PDF), a skip-level
    manager reads but does not write, HR of another company sees no cycle;
  * the cycle dashboard counts and the nudge (overdue only, once a day);
  * participants filters; the rating scale settings.

Run with: python -m pytest test_perf_reviews.py -q
"""
import os
import tempfile
import unittest
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
    def cycle(self, **kw):
        body = api.CycleIn(**{"company_id": CO, "name": "2026 Annual", "period_start": "2026-01-01",
                              "period_end": "2026-12-31", "self_due": "2026-11-15", "manager_due": "2026-11-30",
                              "filters": {"departments": ["Ops"], "startedBy": "2026-06-30"}, **kw})
        return api.create_cycle(body, U(HR), self.db)

    def launched(self):
        c = self.cycle()
        api.launch_cycle(c["id"], U(HR), self.db)
        self.db.expire_all()
        r = self.db.query(models.PerfReview).filter_by(cycle_id=c["id"], employee_email=EMP).one()
        return c, r.id

    def q(self, c):
        return {q["id"]: q for q in c["questions"]}

    def answers(self, c, rating=4, text="Did well"):
        return {qid: {"rating": rating if q["kind"] == "rating" else None, "text": text} for qid, q in self.q(c).items()}

    def to_hr(self):
        c, rid = self.launched()
        api.save_self(rid, api.SelfIn(answers=self.answers(c, 4, "Shipped the new desk"), submit=True), U(EMP), self.db)
        api.save_manager(rid, api.ManagerIn(answers=self.answers(c, 3, "Solid year"), overall_rating=3,
                                            summary="A solid year with room to grow.",
                                            private_note="Watch the deadlines - not for Erin.", submit=True),
                         U(MGR), self.db)
        return c, rid

    def get(self, rid, who, level=1):
        return api.get_review(rid, U(who, level), self.db)

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


class FlowTests(ReviewCase):
    def test_participants_follow_the_filters(self):
        c = self.cycle()
        who = {p["email"] for p in api.cycle_participants(c["id"], U(HR), self.db)}
        # Ops only, employees (no contractor), started by the cutoff (not Ned).
        self.assertEqual(who, {BOSS, MGR, EMP, PEER})
        self.assertEqual(api.launch_cycle(c["id"], U(HR), self.db)["launched"], 4)
        bell = self.db.query(models.NexusNotification).filter_by(recipient=EMP).all()
        self.assertEqual([n.title for n in bell], ["Self Review Due"])
        self.refused(lambda: api.launch_cycle(c["id"], U(HR), self.db), 409)

    def test_the_whole_way_and_the_one_signer(self):
        c, rid = self.launched()
        # Every rating question must be rated to submit.
        self.refused(lambda: api.save_self(rid, api.SelfIn(answers={}, submit=True), U(EMP), self.db), 400)
        api.save_self(rid, api.SelfIn(answers=self.answers(c, 4, "Shipped the new desk")), U(EMP), self.db)
        # Before submit the manager sees no self answers.
        self.assertEqual(self.get(rid, MGR)["selfAnswers"], {})
        out = api.save_self(rid, api.SelfIn(answers=self.answers(c, 4, "Shipped the new desk"), submit=True), U(EMP), self.db)
        self.assertEqual(out["stage"], "manager_review")
        self.assertIn("Shipped the new desk", repr(self.get(rid, MGR)["selfAnswers"]))
        self.refused(lambda: api.save_self(rid, api.SelfIn(answers={}), U(EMP), self.db), 409)
        # The manager needs an overall rating.
        self.refused(lambda: api.save_manager(rid, api.ManagerIn(answers=self.answers(c, 3), submit=True), U(MGR), self.db), 400)
        api.save_manager(rid, api.ManagerIn(answers=self.answers(c, 3, "Solid year"), overall_rating=3,
                                            summary="A solid year.", private_note="Not for Erin.", submit=True),
                         U(MGR), self.db)
        self.assertEqual(self.get(rid, HR)["stage"], "hr_review")
        # HR sends it back to the manager, who resubmits.
        self.refused(lambda: api.return_review(rid, api.ReturnIn(to="manager", note=""), U(HR), self.db), 400)
        self.assertEqual(api.return_review(rid, api.ReturnIn(to="manager", note="Add an example"), U(HR), self.db)["stage"],
                         "manager_review")
        api.save_manager(rid, api.ManagerIn(answers=self.answers(c, 3, "Solid year - the desk launch"), overall_rating=4,
                                            summary="A solid year.", private_note="Not for Erin.", submit=True),
                         U(MGR), self.db)
        api.save_hr_note(rid, api.NoteIn(note="Congratulations on the launch."), U(HR), self.db)
        out = api.share_review(rid, _Req(), U(HR), self.db)
        self.assertEqual(out["stage"], "shared")
        self.db.expire_all()
        r = self.db.get(models.PerfReview, rid)
        parties = self.db.query(models.HrSignParty).filter_by(request_id=r.sign_request_id).all()
        # The acknowledgement envelope: ONE signer, the employee. The company never signs.
        self.assertEqual([(p.email, p.role_key, p.party_role) for p in parties], [(EMP, "employee", "signer")])
        req = self.db.get(models.HrSignRequest, r.sign_request_id)
        self.assertEqual((req.link_kind, req.link_id, req.status), ("perf_review", rid, "pending"))
        mine = self.get(rid, EMP)
        self.assertEqual((mine["overallRating"], mine["hrNote"]), (4, "Congratulations on the launch."))
        self.assertTrue(mine["signPartyId"])
        self.sign(parties[0])
        self.db.expire_all()
        done = self.get(rid, HR)
        self.assertEqual(done["stage"], "complete")
        self.assertTrue(done["can"]["startPromotion"])
        self.assertFalse(self.get(rid, MGR)["can"]["startPromotion"])

    def test_a_decline_comes_back_to_hr(self):
        c, rid = self.to_hr()
        api.share_review(rid, _Req(), U(HR), self.db)
        self.db.expire_all()
        r = self.db.get(models.PerfReview, rid)
        party = self.db.query(models.HrSignParty).filter_by(request_id=r.sign_request_id).one()
        self.client.post(f"/esign/public/{party.token}/consent", json={"agreed": True})
        resp = self.client.post(f"/esign/public/{party.token}/decline", json={"reason": "The rating is wrong"})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.db.expire_all()
        back = self.get(rid, HR)
        self.assertEqual(back["stage"], "hr_review")
        self.assertIn("The rating is wrong", repr(back["history"]))

    def test_recall_voids_the_envelope(self):
        c, rid = self.to_hr()
        api.share_review(rid, _Req(), U(HR), self.db)
        self.db.expire_all()
        req_id = self.db.get(models.PerfReview, rid).sign_request_id
        self.assertEqual(api.recall_review(rid, api.NoteIn(note="Fix a typo"), U(HR), self.db)["stage"], "hr_review")
        self.assertEqual(self.db.get(models.HrSignRequest, req_id).status, "voided")


class PrivacyTests(ReviewCase):
    def test_outsiders_get_404(self):
        c, rid = self.to_hr()
        for who in (PEER, OMGR, FARHR):
            self.refused(lambda w=who: self.get(rid, w))
        self.refused(lambda: self.get(rid, OMGR, level=3))           # a manager of another team, any role
        self.refused(lambda: api.cycle_dashboard(c["id"], U(FARHR), self.db))   # HR of another company
        self.refused(lambda: api.cycle_dashboard(c["id"], U(MGR), self.db))
        self.assertEqual(api.my_reviews(U(PEER), self.db)["team"], [])

    def test_employee_sees_nothing_of_the_manager_part_before_shared(self):
        c, rid = self.to_hr()
        mine = self.get(rid, EMP)
        for key in ("managerAnswers", "overallRating", "managerSummary", "privateNote", "history", "goals"):
            self.assertNotIn(key, mine)
        self.assertNotIn("Solid year", repr(mine))
        self.assertIn("Shipped the new desk", repr(mine["selfAnswers"]))

    def test_the_private_note_never_reaches_the_employee(self):
        c, rid = self.to_hr()
        drawn = []
        from reportlab.pdfgen import canvas
        real = canvas.Canvas.drawString
        with mock.patch.object(canvas.Canvas, "drawString", autospec=True,
                               side_effect=lambda self_, x, y, t, *a, **k: drawn.append(t) or real(self_, x, y, t, *a, **k)):
            api.share_review(rid, _Req(), U(HR), self.db)
        text = " ".join(drawn)
        self.assertIn("A solid year", text)
        self.assertNotIn("Watch the deadlines", text)
        self.assertIn("does not mean", text)        # signing acknowledges, it does not agree
        shared = self.get(rid, EMP)
        self.assertNotIn("privateNote", shared)
        self.assertNotIn("Watch the deadlines", repr(shared))
        self.assertEqual(self.get(rid, MGR)["privateNote"], "Watch the deadlines - not for Erin.")

    def test_who_writes_what(self):
        c, rid = self.launched()
        self.refused(lambda: api.save_self(rid, api.SelfIn(answers={}), U(MGR), self.db), 403)
        api.save_self(rid, api.SelfIn(answers=self.answers(c), submit=True), U(EMP), self.db)
        self.refused(lambda: api.save_manager(rid, api.ManagerIn(answers={}), U(EMP), self.db), 403)
        self.refused(lambda: api.save_manager(rid, api.ManagerIn(answers={}), U(BOSS), self.db), 403)   # reads, not writes
        self.assertEqual(self.get(rid, BOSS)["stage"], "manager_review")
        self.refused(lambda: api.share_review(rid, _Req(), U(MGR), self.db), 403)

    def test_envelope_screens_follow_the_review(self):
        c, rid = self.to_hr()
        api.share_review(rid, _Req(), U(HR), self.db)
        self.db.expire_all()
        req = self.db.get(models.HrSignRequest, self.db.get(models.PerfReview, rid).sign_request_id)
        self.assertTrue(pr.can_view_envelope(self.db, req, U(EMP)))
        self.assertTrue(pr.can_view_envelope(self.db, req, U(HR)))
        self.assertFalse(pr.can_view_envelope(self.db, req, U(PEER)))
        self.assertNotIn(req.id, {x["id"] for x in esign.list_requests("", U(HR, 4), self.db)})


class DashboardTests(ReviewCase):
    def test_counts_overdue_and_nudge_once(self):
        c, rid = self.launched()
        with mock.patch.object(pr, "today", return_value="2026-11-20"):
            dash = api.cycle_dashboard(c["id"], U(HR), self.db)
            self.assertEqual((dash["counts"]["self_review"], dash["counts"]["overdue"]), (4, 4))
            self.assertTrue(dash["reviews"][0]["overdue"])
            self.db.query(models.NexusNotification).delete()
            self.db.commit()
            self.assertEqual(api.nudge_cycle(c["id"], api.NudgeIn(), U(HR), self.db)["nudged"], 4)
            self.assertEqual(api.nudge_cycle(c["id"], api.NudgeIn(), U(HR), self.db)["nudged"], 0)   # not twice a day
        bell = self.db.query(models.NexusNotification).filter_by(recipient=EMP, title="Review Reminder").all()
        self.assertEqual(len(bell), 1)
        with mock.patch.object(pr, "today", return_value="2026-11-01"):     # nothing overdue yet
            self.db.query(models.PerfReview).update({"nudged_at": ""})
            self.db.commit()
            self.assertEqual(api.nudge_cycle(c["id"], api.NudgeIn(), U(HR), self.db)["nudged"], 0)

    def test_my_reviews_buckets(self):
        c, rid = self.to_hr()
        self.assertEqual([r["id"] for r in api.my_reviews(U(EMP), self.db)["mine"]], [rid])
        team = api.my_reviews(U(MGR), self.db)["team"]
        self.assertIn(rid, {r["id"] for r in team})
        self.assertTrue(next(r for r in team if r["id"] == rid)["yours"])


class SettingsTests(ReviewCase):
    def test_scale_and_values(self):
        self.refused(lambda: api.save_review_settings(api.ReviewSettingsIn(company=CO, rating_scale=[{"value": 1, "label": "Only"}]),
                                                      U(HR), self.db), 400)
        out = api.save_review_settings(api.ReviewSettingsIn(company=CO, rating_scale=[{"value": 1, "label": "Low"},
                                                                                      {"value": 2, "label": "Mid"},
                                                                                      {"value": 3, "label": "High"}],
                                                            values=[{"name": "Own It"}, {"name": "Own It"}]), U(HR), self.db)
        self.assertEqual([s["label"] for s in out["ratingScale"]], ["Low", "Mid", "High"])
        self.assertEqual([v["name"] for v in out["values"]], ["Own It"])
        c = self.cycle()
        self.assertEqual(len(c["ratingScale"]), 3)
        self.assertEqual(c["values"][0]["name"], "Own It")
        self.refused(lambda: api.save_review_settings(api.ReviewSettingsIn(company="", values=[]), U(HR), self.db), 403)
        self.refused(lambda: api.get_review_settings("", U(EMP), self.db), 403)


if __name__ == "__main__":
    unittest.main()
