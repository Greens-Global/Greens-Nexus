"""In-person training (WP 5.1, Oct 29 2026): an In Person course is completed
only when someone signs the person off - a trainer marking them Attended at a
session, or the course's editors / the person's own manager signing off a
hands-on check. Either way the certificate is issued like a passed quiz.
ONE FILE PER PROCESS."""
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

MGR = "kbs.manager@example.com"      # manager role: author; manager of LRN and LRN2
TRN = "kbs.trainer@example.com"      # employee with the sop:editor grant: runs sessions
LRN, LRN2, PEER = "kbs.lee@example.com", "kbs.lou@example.com", "kbs.peer@example.com"

LESSON = {"_id": "l1", "type": "text", "title": "Before You Drive",
          "blocks": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Walk around the forklift."}]}]}}


class KbSessionsCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)
        db = database.SessionLocal()
        try:
            for e, role, first, mgr in ((MGR, "manager", "Mary", ""), (TRN, "employee", "Tom", ""), (LRN, "employee", "Lee", MGR),
                                        (LRN2, "employee", "Lou", MGR), (PEER, "employee", "Pat", "")):
                db.add(models.NexusRole(email=e, role=role, display_name=f"{first} Test"))
                db.add(models.NexusEmployee(id=f"e-{first}", first_name=first, last_name="Test", work_email=e, status="active",
                                            deleted_at="", department="Operations", manager_email=mgr))
            db.add(models.NexusGroup(id="g-kbs", name="KB Authors", allowed_modules="sop:editor"))
            db.add(models.NexusGroupMember(group_id="g-kbs", email=TRN))
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

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache()

    def _course(self, title, delivery="in_person"):
        self._as(MGR)
        r = self.client.post("/kb/courses", json={"title": title, "lessons": [LESSON], "delivery": delivery})
        self.assertEqual(r.status_code, 201, r.text)
        cid = r.json()["course"]["id"]      # chosen at creation, no second step (QA, Oct 29 2026)
        r = self.client.post(f"/kb/courses/{cid}/publish", json={"change_note": "First"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["course"]["delivery"], delivery)
        return cid

    def _status(self, cid, who):
        self._as(who)
        return next(c for c in self.client.get("/kb/courses").json() if c["id"] == cid)["my_status"]

    def _bells(self, who, ntype):
        db = database.SessionLocal()
        try:
            return [n.title for n in db.query(models.NexusNotification).filter(models.NexusNotification.recipient == who,
                                                                               models.NexusNotification.type == ntype).all()]
        finally:
            db.close()

    def test_lessons_alone_never_complete_an_in_person_course(self):
        cid = self._course("Forklift Basics")
        self._as(LRN)
        self.client.post(f"/kb/courses/{cid}/lessons/l1/done")
        self.assertNotEqual(self._status(cid, LRN), "Completed")

    def test_a_session_invites_and_attended_signs_off(self):
        cid = self._course("Forklift Practical")
        self._as(MGR)
        self.assertEqual(self.client.post(f"/kb/courses/{cid}/sessions", json={"starts_at": "11/03/2026"}).status_code, 422)
        r = self.client.post(f"/kb/courses/{cid}/sessions", json={"starts_at": "2026-11-03T09:30", "ends_at": "2026-11-03T11:00",
                                                                   "location": "Temecula yard", "trainer_email": TRN, "emails": [LRN, LRN2]})
        self.assertEqual(r.status_code, 201, r.text)
        s = r.json()
        self.assertEqual(s["when"], "11/03/2026 9:30 AM")
        self.assertEqual(sorted(a["email"] for a in s["attendees"]), [LRN, LRN2])
        self.assertIn("Training Session Scheduled", self._bells(LRN, "kb_session_invite"))
        self.assertIn("You Are Training a Session", self._bells(TRN, "kb_session_invite"))
        self._as(LRN)
        mine = next(c for c in self.client.get("/kb/courses").json() if c["id"] == cid)["sessions"]
        self.assertEqual([x["location"] for x in mine], ["Temecula yard"])
        # only the trainer or the course's editors take attendance
        self.assertEqual(self.client.post(f"/kb/sessions/{s['id']}/attendance", json={"email": LRN, "status": "attended"}).status_code, 403)
        self._as(TRN)
        r = self.client.post(f"/kb/sessions/{s['id']}/attendance", json={"email": LRN, "status": "attended", "note": "Clean pre-check"})
        self.assertEqual(r.status_code, 200, r.text)
        self.client.post(f"/kb/sessions/{s['id']}/attendance", json={"email": LRN2, "status": "no_show"})
        self.assertEqual(self._status(cid, LRN), "Completed")
        self.assertNotEqual(self._status(cid, LRN2), "Completed")
        db = database.SessionLocal()
        try:
            cert = db.query(models.KbCertificate).filter(models.KbCertificate.user_email == LRN, models.KbCertificate.course_id == cid).one()
            self.assertTrue(cert.serial.startswith("CERT-"))
        finally:
            db.close()
        self.assertIn("Course Completed", self._bells(MGR, "kb_course_complete"))
        self._as(TRN)
        self.assertEqual(self.client.post(f"/kb/sessions/{s['id']}/attendance", json={"email": LRN, "status": "no_show"}).status_code, 409)

    def test_a_manager_signs_off_a_hands_on_check(self):
        cid = self._course("Ladder Check")
        self._as(PEER)       # not the course's editor, not Lee's manager
        self.assertEqual(self.client.post(f"/kb/courses/{cid}/sign-off", json={"email": LRN}).status_code, 403)
        self._as(LRN)
        self.assertEqual(self.client.post(f"/kb/courses/{cid}/sign-off", json={"email": LRN}).status_code, 403)
        self._as(MGR)
        r = self.client.post(f"/kb/courses/{cid}/sign-off", json={"email": LRN, "note": "Set up and climbed correctly"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._status(cid, LRN), "Completed")
        self._as(MGR)
        self.assertEqual(self.client.post(f"/kb/courses/{cid}/sign-off", json={"email": LRN}).status_code, 409)
        listed = self.client.get(f"/kb/courses/{cid}/sessions").json()["sign_offs"]
        self.assertEqual([(x["email"], x["note"]) for x in listed], [(LRN, "Set up and climbed correctly")])

    def test_online_courses_take_no_sessions_or_sign_offs(self):
        cid = self._course("Online Only", delivery="online")
        self._as(MGR)
        self.assertEqual(self.client.post(f"/kb/courses/{cid}/sessions", json={"starts_at": "2026-11-03T09:30"}).status_code, 409)
        self.assertEqual(self.client.post(f"/kb/courses/{cid}/sign-off", json={"email": LRN}).status_code, 409)

    def test_canceling_tells_the_invited(self):
        cid = self._course("Fire Drill")
        self._as(MGR)
        s = self.client.post(f"/kb/courses/{cid}/sessions", json={"starts_at": "2026-11-05T14:00", "emails": [LRN2], "capacity": 1}).json()
        self.assertEqual(self.client.patch(f"/kb/sessions/{s['id']}", json={"emails": [LRN]}).status_code, 409)   # full
        r = self.client.patch(f"/kb/sessions/{s['id']}", json={"status": "canceled"})
        self.assertEqual(r.json()["status"], "canceled")
        self.assertIn("Training Session Canceled", self._bells(LRN2, "kb_session_invite"))


if __name__ == "__main__":
    unittest.main()
