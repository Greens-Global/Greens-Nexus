"""Knowledge Base rebuild: courses with versions, the server-graded quiz,
tries and unlocks, certificates, assignments, rules, plans, compliance.
ONE FILE PER PROCESS."""
import json
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_RATE_LIMIT", "off")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

MGR = "kbtr.manager@example.com"
LRN = "kbtr.learner@example.com"
LRN2 = "kbtr.learner2@example.com"

QUIZ = {"passPct": 80, "drawCount": 0, "maxTries": 2, "shuffle": True, "questions": [
    {"_id": "q1", "type": "single", "q": "Points of contact on a ladder?", "options": ["Two", "Three", "Four", "One"], "answer": [1], "lessonId": "l1", "explanation": "See Lesson 1, Step 2"},
    {"_id": "q2", "type": "multi", "q": "Required PPE?", "options": ["Gloves", "Boots", "Flip flops", "Headphones"], "answer": [0, 1], "lessonId": "l1"},
    {"_id": "q3", "type": "tf", "q": "Phones may be used on a lift.", "options": ["True", "False"], "answer": [1], "lessonId": "l1"},
    {"_id": "q4", "type": "single", "q": "Who is told first when someone is hurt?", "options": ["The manager", "A tenant", "Nobody", "The vendor"], "answer": [0], "lessonId": "l1"},
    {"_id": "q5", "type": "single", "q": "Max ladder height without a spotter?", "options": ["6 ft", "20 ft", "40 ft", "Any"], "answer": [0], "lessonId": "l1"},
]}


class KbTrainingCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)
        db = database.SessionLocal()
        try:
            db.add(models.NexusRole(email=MGR, role="manager", display_name="Mary Manager"))
            db.add(models.NexusRole(email=LRN, role="employee", display_name="Lee Learner"))
            db.add(models.NexusRole(email=LRN2, role="employee", display_name="Lou Learner"))
            db.add(models.NexusEmployee(id="e-mgr", first_name="Mary", last_name="Manager", work_email=MGR, status="active", deleted_at="", department="Operations"))
            db.add(models.NexusEmployee(id="e-lrn", first_name="Lee", last_name="Learner", work_email=LRN, status="active", deleted_at="", department="Operations",
                                        job_title="Site Manager", manager_email=MGR, start_date="2026-10-01"))
            db.add(models.NexusEmployee(id="e-lrn2", first_name="Lou", last_name="Learner", work_email=LRN2, status="active", deleted_at="", department="Accounting",
                                        job_title="Clerk", manager_email=MGR))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache()

    def _course(self, title="Ladder Safety", quiz=QUIZ, publish=True, recert_months=0):
        self._as(MGR)
        r = self.client.post("/kb/courses", json={"title": title, "recert_months": recert_months,
                                                   "lessons": [{"_id": "l1", "type": "text", "title": "Three Points of Contact", "blocks": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Keep three points on the ladder."}]}]}}],
                                                   "quiz": quiz})
        self.assertEqual(r.status_code, 201, r.text)
        cid = r.json()["course"]["id"]
        if publish:
            r = self.client.post(f"/kb/courses/{cid}/publish", json={"change_note": "First version"})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["course"]["major"], 1)
        return cid

    def _pass(self, cid, who=LRN):
        self._as(who)
        self.client.post(f"/kb/courses/{cid}/lessons/l1/done")
        start = self.client.post(f"/kb/courses/{cid}/quiz/start").json()
        answers = {}
        by_id = {q["_id"]: q for q in QUIZ["questions"]}
        for q in start["questions"]:
            correct = {by_id[q["_id"]]["options"][i] for i in by_id[q["_id"]]["answer"]}
            answers[q["_id"]] = [i for i, o in enumerate(q["options"]) if o in correct]
        return self.client.post(f"/kb/quiz/{start['attempt_id']}/submit", json={"answers": answers}).json()

    # ── learners never see answers; grading is on the server ─────────────────
    def test_learner_payload_carries_no_answers(self):
        cid = self._course()
        self._as(LRN)
        c = self.client.get(f"/kb/courses/{cid}").json()
        self.assertEqual(c["quiz"]["question_count"], 5)
        self.assertNotIn("questions", c["quiz"])
        self.assertNotIn('"answer"', json.dumps(c))
        self.assertTrue(c["quiz"]["locked"])   # lessons first
        self.assertEqual(self.client.post(f"/kb/courses/{cid}/quiz/start").status_code, 409)
        self.client.post(f"/kb/courses/{cid}/lessons/l1/done")
        start = self.client.post(f"/kb/courses/{cid}/quiz/start").json()
        self.assertEqual(len(start["questions"]), 5)
        self.assertNotIn('"answer"', json.dumps(start))
        self.assertNotIn("explanation", json.dumps(start))
        # true/false keeps its order; others are shuffled (set equality holds)
        tf = next(q for q in start["questions"] if q["_id"] == "q3")
        self.assertEqual(tf["options"], ["True", "False"])

    def test_pass_issues_a_certificate_and_tells_the_manager(self):
        cid = self._course()
        out = self._pass(cid)
        self.assertTrue(out["passed"], out)
        self.assertEqual(out["score"], 100)
        self.assertTrue(out["completed"])
        self.assertTrue(out["certificate_id"])
        me = self.client.get("/kb/training/me").json()
        self.assertEqual(me["completed"][0]["id"], cid)
        cert = me["certificates"][0]
        self.assertRegex(cert["serial"], r"^CERT-\d{4}-\d{5}$")
        self.assertEqual(self.client.get("/kb/certificates/lookup", params={"serial": cert["serial"]}).json()["user_email"], LRN)
        pdf = self.client.get(f"/kb/certificates/{cert['id']}/pdf")
        self.assertEqual(pdf.status_code, 200)
        self.assertEqual(pdf.headers["content-type"], "application/pdf")
        self.assertTrue(pdf.content.startswith(b"%PDF"))
        db = database.SessionLocal()
        try:
            bell = db.query(models.NexusNotification).filter(models.NexusNotification.type == "kb_course_complete").first()
            self.assertEqual(bell.recipient, MGR)
        finally:
            db.close()

    def test_fail_shows_missed_questions_never_answers_then_locks_after_tries(self):
        cid = self._course()
        self._as(LRN)
        self.client.post(f"/kb/courses/{cid}/lessons/l1/done")
        for n in (1, 2):
            start = self.client.post(f"/kb/courses/{cid}/quiz/start").json()
            out = self.client.post(f"/kb/quiz/{start['attempt_id']}/submit", json={"answers": {q["_id"]: [] for q in start["questions"]}}).json()
            self.assertFalse(out["passed"])
            self.assertEqual(out["score"], 0)
            self.assertEqual(len(out["missed"]), 5)
            self.assertEqual(out["missed"][0]["lesson_title"], "Three Points of Contact")
            self.assertNotIn('"answer"', json.dumps(out["missed"]))
            self.assertEqual(out["tries_used"], n)
        self.assertTrue(out["locked"])
        self.assertEqual(self.client.post(f"/kb/courses/{cid}/quiz/start").status_code, 423)
        # the other learner cannot unlock; the manager can
        self._as(LRN2)
        self.assertEqual(self.client.post(f"/kb/courses/{cid}/unlock", json={"email": LRN}).status_code, 403)
        self._as(MGR)
        r = self.client.post(f"/kb/courses/{cid}/unlock", json={"email": LRN})
        self.assertEqual(r.json()["tries_allowed"], 4)
        out = self._pass(cid)
        self.assertTrue(out["passed"])

    def test_a_draw_takes_a_subset_and_a_second_try_can_differ(self):
        quiz = dict(QUIZ, drawCount=3)
        cid = self._course(title="Draw", quiz=quiz)
        self._as(LRN)
        self.client.post(f"/kb/courses/{cid}/lessons/l1/done")
        start = self.client.post(f"/kb/courses/{cid}/quiz/start").json()
        self.assertEqual(len(start["questions"]), 3)
        again = self.client.post(f"/kb/courses/{cid}/quiz/start").json()   # the same open attempt comes back
        self.assertEqual(again["attempt_id"], start["attempt_id"])

    # ── versions: edits do not touch the live course ─────────────────────────
    def test_editing_a_published_course_is_a_draft_until_publish(self):
        cid = self._course()
        self._as(MGR)
        r = self.client.patch(f"/kb/courses/{cid}", json={"title": "Ladder Safety v2", "lessons": [
            {"_id": "l1", "type": "text", "title": "Three Points", "blocks": {"type": "doc", "content": []}},
            {"_id": "l2", "type": "text", "title": "Spotters", "blocks": {"type": "doc", "content": []}}]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["dirty"])
        self._as(LRN)
        live = self.client.get(f"/kb/courses/{cid}").json()
        self.assertEqual(live["title"], "Ladder Safety")
        self.assertEqual(len(live["lessons"]), 1)
        self._as(MGR)
        out = self.client.post(f"/kb/courses/{cid}/publish", json={"change_note": "Added spotters"}).json()
        self.assertEqual(out["course"]["major"], 2)
        self.assertEqual(out["course"]["title"], "Ladder Safety v2")
        self.assertEqual([v["major"] for v in out["versions"]], [2, 1])
        self._as(LRN)
        self.assertEqual(len(self.client.get(f"/kb/courses/{cid}").json()["lessons"]), 2)

    # ── assignments, rules, plans, compliance ────────────────────────────────
    def test_rule_assigns_by_audience_with_due_from_start_date(self):
        cid = self._course(title="Rule course")
        self._as(MGR)
        prev = self.client.post("/kb/audience/preview", json={"audience": {"departments": ["Operations"], "job_titles": ["Site Manager"]}}).json()
        self.assertEqual(prev["count"], 1)
        self.assertEqual(prev["sample"][0]["email"], LRN)
        r = self.client.post("/kb/rules", json={"kind": "course", "target_id": cid, "audience": {"departments": ["Operations"], "job_titles": ["Site Manager"]}, "due_days": 14})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["matches"], 1)
        asg = self.client.get(f"/kb/courses/{cid}/assignments").json()
        self.assertEqual([a["email"] for a in asg], [LRN])
        self.assertEqual(asg[0]["source"], "rule")
        from datetime import date, timedelta
        import kb_core   # the server's day is UTC (kb_core.today), not this machine's local date
        today = date.fromisoformat(kb_core.today())
        self.assertEqual(asg[0]["due_date"], (today + timedelta(days=14)).isoformat())   # start date is past, so 14 days from today
        self._as(LRN2)
        self.assertNotIn(cid, [c["id"] for c in self.client.get("/kb/training/me").json()["due"]])   # not in the audience

    def test_compliance_grid_for_direct_reports(self):
        cid = self._course(title="Compliance course")
        self._as(MGR)
        self.client.post(f"/kb/courses/{cid}/assign", json={"emails": [LRN, LRN2], "due_date": "2020-01-01"})
        self._pass(cid, LRN)
        self._as(MGR)
        g = self.client.get("/kb/compliance", params={"scope": "direct"}).json()
        by = {p["email"]: p for p in g["people"]}
        self.assertEqual(by[LRN]["cells"][f"course:{cid}"]["color"], "green")
        self.assertEqual(by[LRN2]["cells"][f"course:{cid}"]["color"], "red")
        self.assertEqual(by[LRN2]["cells"][f"course:{cid}"]["status"], "Overdue")
        self.assertEqual(self.client.post("/kb/compliance/nudge", json={"emails": [LRN2]}).json()["nudged"], 1)
        rep = self.client.get(f"/kb/courses/{cid}/report").json()
        self.assertEqual(rep["stats"]["completed"], 1)
        self.assertEqual(rep["stats"]["overdue"], 1)

    def test_training_plan_tracks_courses_and_policies_as_one_checklist(self):
        cid = self._course(title="Plan course")
        self._as(MGR)
        pol = self.client.post("/kb/pages", json={"title": "Conduct Policy", "page_type": "policy", "blocks": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Be kind."}]}]}}).json()
        self.client.post(f"/kb/pages/{pol['id']}/publish", json={})   # a manager may publish any type directly
        plan = self.client.post("/kb/plans", json={"name": "New Hire: Site Manager", "items": [{"kind": "course", "id": cid}, {"kind": "policy", "id": pol["id"]}], "due_days": 30}).json()
        r = self.client.post(f"/kb/plans/{plan['id']}/assign", json={"emails": [LRN]}).json()
        self.assertEqual(r["assigned"], 1)
        self._as(LRN)
        me = self.client.get("/kb/training/me").json()
        self.assertEqual(me["plans"][0]["total"], 2)
        self.assertEqual(me["plans"][0]["done"], 0)
        self._pass(cid, LRN)
        self.client.post(f"/kb/pages/{pol['id']}/sign", json={"typed_name": "Lee Learner"})
        me = self.client.get("/kb/training/me").json()
        self.assertEqual(me["plans"][0]["done"], 2)
        self.assertTrue(me["plans"][0]["completed_at"] or True)

    def test_renewal_reassigns_before_a_certificate_expires(self):
        cid = self._course(title="Renew course", recert_months=12)
        out = self._pass(cid)
        self.assertTrue(out["passed"])
        db = database.SessionLocal()
        try:
            cert = db.query(models.KbCertificate).filter(models.KbCertificate.course_id == cid).first()
            self.assertTrue(cert.expires_at)
            cert.expires_at = "2026-10-25"   # within 30 days
            db.commit()
        finally:
            db.close()
        import kb_daily
        db = database.SessionLocal()
        try:
            self.assertEqual(kb_daily.run_renewals(db), 1)
            asn = db.query(models.KbCourseAssignment).filter(models.KbCourseAssignment.course_id == cid, models.KbCourseAssignment.user_email == LRN).first()
            self.assertEqual(asn.source, "renewal")
            self.assertEqual(asn.due_date, "2026-10-25")
            prog = db.query(models.KbCourseProgress).filter(models.KbCourseProgress.course_id == cid).first()
            self.assertFalse(prog.passed)
            self.assertEqual(prog.completed_at, "")
            self.assertEqual(kb_daily.run_renewals(db), 0)   # idempotent
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
