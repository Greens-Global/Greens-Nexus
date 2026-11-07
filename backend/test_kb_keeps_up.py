"""Keeps Up and the Refresher (Neil, 11/07/2026). ONE FILE PER PROCESS."""
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
import kb_core  # noqa: E402
import kb_currency  # noqa: E402
import kb_refresher  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

MGR = "keep.manager@example.com"
LRN = "keep.learner@example.com"
QUIZ = {"passPct": 80, "drawCount": 0, "maxTries": 3, "shuffle": False, "questions": [
    {"_id": "q1", "type": "single", "q": "Which button pauses paid time?", "options": ["Punch Out", "Start Break", "End Break"], "answer": [1], "explanation": "Start Break pauses it."},
    {"_id": "q2", "type": "tf", "q": "Only you sign your Time Sheet.", "options": ["True", "False"], "answer": [0], "explanation": "Your manager approves it and never signs it."},
    {"_id": "q3", "type": "multi", "q": "Which open a Workday panel?", "options": ["Ask HR", "Reimbursements", "Punch In"], "answer": [0, 1], "explanation": "Punch In is the Time Clock."},
]}


class KeepsUpCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)
        db = database.SessionLocal()
        try:
            db.add(models.NexusRole(email=MGR, role="manager", display_name="Mary Manager"))
            db.add(models.NexusRole(email=LRN, role="employee", display_name="Lee Learner"))
            db.commit()
        finally:
            db.close()
        cache.clear_all() if hasattr(cache, "clear_all") else None
        auth._role_cache.clear() if hasattr(auth, "_role_cache") else None

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        if hasattr(auth, "_role_cache"):
            auth._role_cache.clear()

    def _course(self, title="Nexus Fundamentals", teaches="Workday, Time Clock"):
        self._as(MGR)
        r = self.client.post("/kb/courses", json={"title": title, "description": "d"})
        self.assertIn(r.status_code, (200, 201), r.text)
        cid = r.json()["course"]["id"]
        lessons = [{"type": "text", "title": "The Time Clock", "teaches": ["Time Clock"], "blocks": kb_core.doc_from_text("Punch In starts the day.") if hasattr(kb_core, "doc_from_text") else {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Punch In starts the day."}]}]}},
                   {"type": "text", "title": "Your Time Sheet", "blocks": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Hours and minutes."}]}]}}]
        r = self.client.patch(f"/kb/courses/{cid}", json={"lessons": lessons, "quiz": QUIZ, "teaches": teaches})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.post(f"/kb/courses/{cid}/publish", json={"change_note": "first"})
        self.assertEqual(r.status_code, 200, r.text)
        return cid

    def _release(self, title, module, at):
        db = database.SessionLocal()
        try:
            db.add(models.TaskChangelogEntry(id=f"chg_{abs(hash(title)) % 10**8}", payload={"title": title, "module": module, "status": "Released", "releasedAt": at},
                                             created_at=at, updated_at=at))
            db.commit()
        finally:
            db.close()

    def test_teaches_travels_and_learn_finds_the_course_and_its_lesson(self):
        cid = self._course()
        self._as(LRN)
        r = self.client.get("/kb/learn", params={"module": "Workday"})
        self.assertEqual(r.status_code, 200, r.text)
        courses = r.json()["courses"]   # the file's other tests also publish Workday courses: ours is among them
        mine = next(c for c in courses if c["id"] == cid)
        self.assertEqual([L["title"] for L in mine["lessons"]], ["The Time Clock"])   # Time Clock is a Workday screen (kb_currency aliases)
        r = self.client.get("/kb/learn", params={"module": "Time Clock"})
        mine = next(c for c in r.json()["courses"] if c["id"] == cid)
        self.assertEqual([L["title"] for L in mine["lessons"]], ["The Time Clock"])
        self.assertEqual(self.client.get("/kb/learn", params={"module": "Accounting"}).json()["courses"], [])
        card = self.client.get(f"/kb/courses/{cid}").json()
        self.assertEqual(card["teaches"], ["Workday", "Time Clock"])
        self.assertTrue(card["reviewed_at"])

    def test_a_release_about_a_taught_module_flags_the_course_until_reviewed(self):
        cid = self._course(title="Workday Course")
        db = database.SessionLocal()
        try:
            c = db.get(models.KbCourse, cid)
            c.reviewed_at = "2026-11-01T00:00:00+00:00"
            db.commit()
            self._release("Time Sheet shows breaks on their own row", "Workday", "2026-11-05T10:00:00+00:00")
            self._release("Tickets desk queues", "Tickets", "2026-11-06T10:00:00+00:00")
            self.assertEqual(kb_currency.run(db), 1)
            c = db.get(models.KbCourse, cid)
            flag = json.loads(c.review_flag)
            self.assertEqual([x["module"] for x in flag["changes"]], ["Workday"])   # Tickets is not taught here
            bells = db.query(models.NexusNotification).filter(models.NexusNotification.type == "kb_course_review", models.NexusNotification.recipient == MGR).all()
            self.assertEqual(len(bells), 1)
            self.assertIn("11/05/2026", bells[0].body)
            self.assertEqual(kb_currency.run(db), 1)   # the same set again: flagged, no second bell
            self.assertEqual(db.query(models.NexusNotification).filter(models.NexusNotification.type == "kb_course_review").count(), 1)
        finally:
            db.close()
        self._as(MGR)
        card = self.client.get("/kb/courses?all=true").json()
        mine = next(x for x in card if x["id"] == cid)
        self.assertEqual(len(mine["review_flag"]["changes"]), 1, mine)
        r = self.client.post(f"/kb/courses/{cid}/reviewed")
        self.assertEqual(r.status_code, 200, r.text)
        db = database.SessionLocal()
        try:
            c = db.get(models.KbCourse, cid)
            self.assertEqual(c.review_flag, "")
            self.assertEqual(kb_currency.run(db), 0)   # reviewed after the release: nothing to flag
        finally:
            db.close()
        self._as(LRN)
        self.assertEqual(self.client.post(f"/kb/courses/{cid}/reviewed").status_code, 403)

    def test_refresher_seeds_after_a_pass_and_spaces_the_questions(self):
        cid = self._course(title="Refresher Course")
        self._as(LRN)
        self.assertEqual(self.client.get("/kb/refresher/today").json()["items"], [])   # nothing passed yet
        db = database.SessionLocal()
        try:
            db.add(models.KbCourseProgress(id="prog1", course_id=cid, user_email=LRN, lessons_done="[]", quiz_score=100, passed=True,
                                           started_at=kb_core.now(), completed_at=kb_core.now(), course_major=1))
            db.commit()
            today = kb_core.today_for(db, LRN)
            out = kb_refresher.today(db, LRN)
            self.assertEqual(out["total"], 3)
            self.assertEqual(out["items"], [])   # new items land from tomorrow, spread over the week
            for r in db.query(models.KbRefresherItem).all():
                r.due_on = today
            db.commit()
            out = kb_refresher.today(db, LRN)
            self.assertEqual(len(out["items"]), 3)
            item = next(i for i in out["items"] if i["question"]["q"].startswith("Which button"))
            self.assertNotIn("answer", item["question"])
            shown = item["question"]["options"]
            pos = shown.index("Start Break")
            res = kb_refresher.answer(db, LRN, item["item_id"], {"answer": [pos], "order": item["order"]})
            self.assertTrue(res["correct"])
            self.assertEqual(res["next_in_days"], 2)
            self.assertEqual(res["answer"], ["Start Break"])
            self.assertEqual(res["streak"], 1)
            tf = next(i for i in out["items"] if i["question"]["type"] == "tf")
            res = kb_refresher.answer(db, LRN, tf["item_id"], {"answer": [1], "order": tf["order"]})   # False: wrong
            self.assertFalse(res["correct"])
            self.assertEqual(res["next_in_days"], 1)
            self.assertIn("never signs", res["explanation"])
            left = kb_refresher.today(db, LRN)
            self.assertEqual(len(left["items"]), 1)   # two answered today, one slot left
            self.assertEqual(left["answered_today"], 2)
            r = db.query(models.KbRefresherItem).filter(models.KbRefresherItem.question_id == "q1").one()
            self.assertEqual((r.interval_days, r.right_count, r.due_on), (2, 1, kb_core.add_days(today, 2)))
        finally:
            db.close()
        r = self.client.post("/kb/refresher/answer", json={"item_id": "nope", "answer": [0]})
        self.assertEqual(r.status_code, 404)


if __name__ == "__main__":
    unittest.main()
