"""Performance: peer feedback, kudos, improvement plans and calibration
(Neil, Oct 29 2026) - perf_feedback.py, perf_plans.py, perf_reviews.calibrate
and their routes, on a throwaway database.

  * feedback asked about yourself is yours; asked by a manager it is the
    chain's and HR's - never the person's; only the giver answers; a
    review's form shows the private answers to its writer, never to the
    employee;
  * kudos are seen across the recipient's company, never sent to yourself,
    hidden (not deleted) by the sender or HR;
  * a plan: the manager drafts and sends it, HR starts it, the employee
    never sees a draft, acknowledges once, HR extends and closes it; one
    open plan per person; peers 404;
  * calibration moves a Ready to Share rating with a reason, keeps the
    manager's own, tells the manager, and hides it from the employee;
  * the Approvals rows.

Run with: python -m pytest test_perf_feedback.py -q
"""
import os
import tempfile
import unittest
from datetime import date, timedelta

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException  # noqa: E402

import approvals_inbox  # noqa: E402
import auth  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402,F401
import models  # noqa: E402
import perf_reviews as pr  # noqa: E402
from routers import perf_feedback as api  # noqa: E402
from routers import perf_reviews as rapi  # noqa: E402

CO, CO2 = "co-fb", "co-fb-2"
BOSS, MGR, EMP, PEER, OTHER, HR, FAR = (
    "boss.fb@greensglobal.com", "mgr.fb@greensglobal.com", "emp.fb@greensglobal.com", "peer.fb@greensglobal.com",
    "other.fb@greensglobal.com", "hr.fb@greensglobal.com", "far.fb@greensglobal.com")


def U(email, level=1):
    return {"email": email, "role": "employee", "level": level}


class Case(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        actual = database.engine.url.database or ""
        assert os.path.abspath(actual) == os.path.abspath(_tmp_db.name), actual
        models.Base.metadata.create_all(bind=database.engine)

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
        for m in (models.PerfFeedback, models.PerfKudos, models.PerfPlan, models.PerfReview, models.PerfReviewCycle,
                  models.PerfGoal, models.NexusEmployee, models.HrEntity, models.NexusNotification):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO, name="Feedback Co", hr_contact_email=HR))
        self.db.add(models.HrEntity(id=CO2, name="Far Co", hr_contact_email=""))
        for email, first, mgr, co in ((BOSS, "Bea", "", CO), (MGR, "Max", BOSS, CO), (EMP, "Erin", MGR, CO),
                                      (PEER, "Pat", MGR, CO), (OTHER, "Oz", BOSS, CO), (HR, "Hana", BOSS, CO),
                                      (FAR, "Fay", "", CO2)):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=email, first_name=first, last_name="Test",
                                             company=co, manager_email=mgr, department="Ops", status="active",
                                             employment_type="full_time", start_date="2021-01-01"))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def refused(self, fn, code=404):
        with self.assertRaises(HTTPException) as e:
            fn()
        self.assertEqual(e.exception.status_code, code)

    def bells(self, who, title=None):
        return [n for n in self.db.query(models.NexusNotification).filter_by(recipient=who).all()
                if title is None or n.title == title]

    def inbox(self, who, kind):
        out = approvals_inbox.collect(self.db, U(who))
        return [r for r in out["rows"] if r["kind"] == kind]


class FeedbackTests(Case):
    def ask(self, who, subject, givers):
        return api.ask_feedback(api.FeedbackAskIn(subject=subject, givers=givers, note="For my growth"), U(who), self.db)

    def test_asked_about_yourself_is_yours(self):
        fid = self.ask(EMP, "", [PEER, OTHER])["items"][0]["id"]
        self.assertEqual(len(self.bells(PEER, "Feedback Requested")), 1)
        self.assertEqual([r["id"] for r in self.inbox(PEER, "perf_feedback")], [fid])
        api.answer_feedback(fid, api.FeedbackAnswerIn(answers={"well": "Calm under pressure"}, submit=True), U(PEER), self.db)
        self.assertEqual(self.inbox(PEER, "perf_feedback"), [])
        self.assertEqual(len(self.bells(EMP, "Feedback Received")), 1)
        mine = api.list_feedback("", U(EMP), self.db)["aboutMe"]
        self.assertEqual({f["status"] for f in mine}, {"submitted", "requested"})
        self.assertEqual([f["answers"] for f in mine if f["status"] == "submitted"], [{"well": "Calm under pressure"}])
        # Not the manager's or HR's to read.
        self.refused(lambda: api.get_feedback(fid, U(MGR), self.db))
        self.refused(lambda: api.get_feedback(fid, U(HR), self.db))

    def test_asked_by_a_manager_is_never_the_persons(self):
        fid = self.ask(MGR, EMP, [PEER])["items"][0]["id"]
        api.answer_feedback(fid, api.FeedbackAnswerIn(answers={"better": "Speak up in standups"}, submit=True), U(PEER), self.db)
        self.refused(lambda: api.get_feedback(fid, U(EMP), self.db))
        self.assertEqual(api.list_feedback("", U(EMP), self.db)["aboutMe"], [])
        self.assertEqual(api.get_feedback(fid, U(BOSS), self.db)["answers"], {"better": "Speak up in standups"})
        self.assertEqual(api.get_feedback(fid, U(HR), self.db)["status"], "submitted")
        self.refused(lambda: api.get_feedback(fid, U(OTHER), self.db))
        self.assertEqual(len(api.list_feedback(EMP, U(MGR), self.db)["about"]), 1)

    def test_who_may_ask_and_who_answers(self):
        self.refused(lambda: self.ask(PEER, EMP, [OTHER]), 403)            # a peer asks about a peer
        self.refused(lambda: self.ask(EMP, "", [EMP]), 400)                # nobody but yourself
        fid = self.ask(EMP, "", [PEER])["items"][0]["id"]
        self.assertEqual(self.ask(EMP, "", [PEER])["asked"], 0)            # one open ask per giver
        self.refused(lambda: api.answer_feedback(fid, api.FeedbackAnswerIn(answers={"well": "x"}), U(EMP), self.db), 403)
        self.refused(lambda: api.answer_feedback(fid, api.FeedbackAnswerIn(answers={}, submit=True), U(PEER), self.db), 400)
        api.decline_feedback(fid, api.NoteIn(note="Have not worked together"), U(PEER), self.db)
        self.refused(lambda: api.cancel_feedback(fid, U(EMP), self.db), 409)

    def test_a_review_shows_the_private_answers_to_its_writer_only(self):
        c = rapi.create_cycle(rapi.CycleIn(company_id=CO, name="Year-End",
                                           due=(date.today() + timedelta(days=30)).isoformat()), U(HR), self.db)
        rid = self.db.query(models.PerfReview).filter_by(cycle_id=c["id"], employee_email=EMP).one().id
        self.assertTrue(rapi.get_review(rid, U(MGR), self.db)["can"]["askFeedback"])
        fid = api.ask_feedback(api.FeedbackAskIn(subject=EMP, givers=[PEER], review_id=rid), U(MGR), self.db)["items"][0]["id"]
        api.answer_feedback(fid, api.FeedbackAnswerIn(answers={"well": "Owns the desk"}, submit=True), U(PEER), self.db)
        self.assertEqual([f["answers"] for f in rapi.get_review(rid, U(MGR), self.db)["peerFeedback"]], [{"well": "Owns the desk"}])
        self.assertNotIn("peerFeedback", rapi.get_review(rid, U(EMP), self.db))


class KudosTests(Case):
    def test_seen_across_the_company_and_hidden_not_deleted(self):
        k = api.give_kudos(api.KudosIn(to=EMP, message="Saved the Friday close"), U(PEER), self.db)
        self.assertEqual(len(self.bells(EMP, "Kudos For You")), 1)
        self.assertEqual(len(self.bells(MGR, "Kudos For Your Team")), 1)
        self.assertEqual([x["id"] for x in api.list_kudos("company", "", "", U(OTHER), self.db)["items"]], [k["id"]])
        self.assertEqual(api.list_kudos("company", "", "", U(FAR), self.db)["items"], [])
        self.assertEqual(api.list_kudos("company", "", "", U(EMP), self.db)["receivedLast90"], 1)
        self.refused(lambda: api.hide_kudos(k["id"], U(OTHER), self.db), 403)
        api.hide_kudos(k["id"], U(HR), self.db)
        self.assertEqual(api.list_kudos("company", "", "", U(OTHER), self.db)["items"], [])
        self.assertIsNotNone(self.db.get(models.PerfKudos, k["id"]))

    def test_never_to_yourself_and_never_empty(self):
        self.refused(lambda: api.give_kudos(api.KudosIn(to=EMP, message="Me again"), U(EMP), self.db), 400)
        self.refused(lambda: api.give_kudos(api.KudosIn(to=EMP, message="ok"), U(PEER), self.db), 400)
        self.refused(lambda: api.give_kudos(api.KudosIn(to="nobody@x.com", message="Thanks a lot"), U(PEER), self.db), 400)


class PlanTests(Case):
    def draft(self, who=MGR):
        start = date.today().isoformat()
        end = (date.today() + timedelta(days=60)).isoformat()
        return api.create_plan(api.PlanIn(employee=EMP, reason="Missed three close deadlines",
                                          expectations=[{"text": "Close on time", "measure": "Every month-end by day 5"}],
                                          support="Weekly 1:1 and a checklist", start_on=start, end_on=end), U(who), self.db)

    def test_the_whole_way(self):
        p = self.draft()
        self.refused(lambda: api.get_plan(p["id"], U(EMP), self.db))          # never a draft
        self.refused(lambda: api.get_plan(p["id"], U(BOSS), self.db))         # not the rest of the chain
        self.refused(lambda: api.start_plan(p["id"], U(MGR), self.db), 403)   # HR starts it
        api.send_plan(p["id"], U(MGR), self.db)
        self.assertEqual(len(self.bells(HR, "Improvement Plans to Start")), 1)
        self.assertEqual([r["id"] for r in self.inbox(HR, "perf_plan")], [f"{p['id']}:start"])
        api.start_plan(p["id"], U(HR), self.db)
        self.assertEqual(len(self.bells(EMP, "Your Improvement Plan")), 1)
        mine = api.get_plan(p["id"], U(EMP), self.db)
        self.assertTrue(mine["can"]["acknowledge"])
        self.assertNotIn("history", mine)
        self.assertEqual([r["id"] for r in self.inbox(EMP, "perf_plan")], [f"{p['id']}:acknowledge"])
        api.acknowledge_plan(p["id"], api.AckIn(comment="Understood"), U(EMP), self.db)
        self.refused(lambda: api.acknowledge_plan(p["id"], api.AckIn(), U(EMP), self.db), 409)
        api.plan_checkin(p["id"], api.CheckinIn(note="October closed on day 4"), U(MGR), self.db)
        self.refused(lambda: api.update_plan(p["id"], api.PlanIn(reason="Changed"), U(MGR), self.db), 409)
        self.refused(lambda: api.extend_plan(p["id"], api.ExtendIn(end_on=p["endOn"], note="More time"), U(HR), self.db), 400)
        later = (date.fromisoformat(p["endOn"]) + timedelta(days=30)).isoformat()
        self.assertEqual(api.extend_plan(p["id"], api.ExtendIn(end_on=later, note="One more close"), U(HR), self.db)["endOn"], later)
        self.refused(lambda: api.close_plan(p["id"], api.CloseIn(outcome="met", note="Done"), U(MGR), self.db), 403)
        exp = mine["expectations"][0]["id"]
        out = api.close_plan(p["id"], api.CloseIn(outcome="met", note="Every close on time", results={exp: "met"}), U(HR), self.db)
        self.assertEqual((out["status"], out["outcome"], out["expectations"][0]["result"]), ("closed", "met", "met"))

    def test_one_open_plan_and_only_their_manager_or_hr(self):
        self.refused(lambda: self.draft(PEER), 403)
        self.refused(lambda: self.draft(BOSS), 403)                            # skip-level drafts nothing
        self.draft()
        self.refused(lambda: self.draft(HR), 409)

    def test_a_dropped_draft_is_kept(self):
        p = self.draft()
        api.close_plan(p["id"], api.CloseIn(outcome="canceled"), U(MGR), self.db)
        self.assertEqual(self.db.get(models.PerfPlan, p["id"]).status, "closed")
        self.draft()                                                           # a new one may start


class CalibrationTests(Case):
    def ready(self):
        c = rapi.create_cycle(rapi.CycleIn(company_id=CO, name="Year-End",
                                           due=(date.today() + timedelta(days=30)).isoformat()), U(HR), self.db)
        rid = self.db.query(models.PerfReview).filter_by(cycle_id=c["id"], employee_email=EMP).one().id
        a = {"well": {"text": "Good"}, "better": {"text": "More"}, "next": {"text": "Lead"}}
        rapi.save_self(rid, rapi.SelfIn(answers=a, submit=True), U(EMP), self.db)
        rapi.save_manager(rid, rapi.ManagerIn(answers=a, rating="meets", submit=True), U(MGR), self.db)
        return c, rid

    def test_hr_moves_a_rating_with_a_reason(self):
        c, rid = self.ready()
        board = rapi.calibration(c["id"], U(HR), self.db)
        self.assertEqual([(p["employeeEmail"], p["rating"], p["canMove"]) for p in board["people"]], [(EMP, "meets", True)])
        self.refused(lambda: rapi.calibration(c["id"], U(MGR), self.db))
        self.refused(lambda: rapi.calibrate_review(rid, rapi.CalibrateIn(rating="exceeds"), U(HR), self.db), 400)
        self.refused(lambda: rapi.calibrate_review(rid, rapi.CalibrateIn(rating="exceeds", note="Led the launch"), U(MGR), self.db), 403)
        board = rapi.calibrate_review(rid, rapi.CalibrateIn(rating="exceeds", note="Led the launch"), U(HR), self.db)
        self.assertEqual((board["people"][0]["rating"], board["people"][0]["calibratedFrom"]), ("exceeds", "meets"))
        self.assertEqual(len(self.bells(MGR, "Ratings Calibrated")), 1)
        self.assertEqual(rapi.get_review(rid, U(MGR), self.db)["calibratedFromLabel"], "Meets")
        rapi.share_review(rid, U(HR), self.db)
        mine = rapi.get_review(rid, U(EMP), self.db)
        self.assertEqual(mine["rating"], "exceeds")
        self.assertNotIn("calibratedFrom", mine)
        self.refused(lambda: rapi.calibrate_review(rid, rapi.CalibrateIn(rating="meets", note="Back"), U(HR), self.db), 409)

    def test_moving_back_clears_the_mark(self):
        c, rid = self.ready()
        rapi.calibrate_review(rid, rapi.CalibrateIn(rating="below", note="Missed targets"), U(HR), self.db)
        board = rapi.calibrate_review(rid, rapi.CalibrateIn(rating="meets", note="Second look"), U(HR), self.db)
        self.assertEqual(board["people"][0]["calibratedFrom"], "")
        self.assertEqual(sum(1 for h in self.db.get(models.PerfReview, rid).history if h["action"] == "calibrated"), 2)


if __name__ == "__main__":
    unittest.main()
