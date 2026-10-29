"""Knowledge Base training: assignment rules, training plans and assigning by
name stay inside the company wall (kb_access.scope_of_email / in_scope,
routers/kb_training.py, kb_daily.run_rules). ONE FILE PER PROCESS."""
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
import kb_daily  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

COA, COB = "ent-kbw-a", "ent-kbw-b"
AAUTH, BAUTH = "kbw.a.author@example.com", "kbw.b.author@example.com"
ALRN, BLRN, NOCO = "kbw.a.learner@example.com", "kbw.b.learner@example.com", "kbw.shared@example.com"
COURSE = "course-kbw-a"


class KbRuleWallsCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)
        db = database.SessionLocal()
        try:
            db.add(models.HrEntity(id=COA, name="Alpha Co"))
            db.add(models.HrEntity(id=COB, name="Beta Co"))
            for i, (email, co, role) in enumerate([(AAUTH, COA, "manager"), (BAUTH, COB, "manager"),
                                                   (ALRN, COA, "employee"), (BLRN, COB, "employee"), (NOCO, "", "employee")]):
                db.add(models.NexusEmployee(id=f"e-kbw-{i}", first_name="P", last_name=str(i), work_email=email,
                                            status="active", deleted_at="", company=co))
                db.add(models.NexusRole(email=email, role=role))
            db.add(models.KbCourse(id=COURSE, title="Alpha Ladder Safety", status="published", owner_email=AAUTH))
            db.add(models.NexusSetting(key="company_walls", value="on"))
            db.commit()
        finally:
            db.close()
        cache.settings_config.invalidate()
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

    def _assigned(self, course_id=COURSE):
        db = database.SessionLocal()
        try:
            return {a.user_email for a in db.query(models.KbCourseAssignment).filter(models.KbCourseAssignment.course_id == course_id).all()}
        finally:
            db.close()

    def test_a_rule_reaches_only_its_makers_company(self):
        self._as(AAUTH)
        r = self.client.post("/kb/rules", json={"kind": "course", "target_id": COURSE, "audience": {}, "due_days": 14})
        self.assertEqual(r.status_code, 201, r.text)
        rid = r.json()["id"]
        db = database.SessionLocal()
        try:
            kb_daily.run_rules(db)
        finally:
            db.close()
        got = self._assigned()
        self.assertIn(ALRN, got)
        self.assertIn(NOCO, got)            # no company = shared, as everywhere in the Knowledge Base
        self.assertNotIn(BLRN, got)
        self.assertNotIn(BAUTH, got)

        # Company B's author neither sees nor touches it.
        self._as(BAUTH)
        self.assertNotIn(rid, {x["id"] for x in self.client.get("/kb/rules").json()})
        self.assertEqual(self.client.patch(f"/kb/rules/{rid}", json={"due_days": 1}).status_code, 404)
        self.assertEqual(self.client.delete(f"/kb/rules/{rid}").status_code, 404)
        self.assertEqual(self.client.post("/kb/rules", json={"kind": "course", "target_id": COURSE, "audience": {}}).status_code, 404)
        self._as(AAUTH)
        self.assertIn(rid, {x["id"] for x in self.client.get("/kb/rules").json()})

    def test_plans_are_walled(self):
        self._as(AAUTH)
        r = self.client.post("/kb/plans", json={"name": "Alpha New Hire", "items": [{"kind": "course", "id": COURSE}]})
        self.assertEqual(r.status_code, 201, r.text)
        pid = r.json()["id"]
        self._as(BAUTH)
        self.assertNotIn(pid, {x["id"] for x in self.client.get("/kb/plans").json()})
        self.assertEqual(self.client.patch(f"/kb/plans/{pid}", json={"name": "Taken"}).status_code, 404)
        self.assertEqual(self.client.post(f"/kb/plans/{pid}/assign", json={"emails": [BLRN]}).status_code, 404)
        self._as(AAUTH)
        r = self.client.post(f"/kb/plans/{pid}/assign", json={"emails": [ALRN, BLRN]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["assigned"], 1)   # Beta's learner is skipped

    def test_assigning_by_name_never_crosses_the_wall(self):
        self._as(AAUTH)
        r = self.client.post(f"/kb/courses/{COURSE}/assign", json={"emails": [BLRN, NOCO]})
        self.assertEqual(r.status_code, 200, r.text)
        got = self._assigned()
        self.assertNotIn(BLRN, got)
        self.assertIn(NOCO, got)

    def test_audience_preview_counts_only_the_callers_company(self):
        self._as(BAUTH)
        r = self.client.post("/kb/audience/preview", json={"audience": {}})
        self.assertEqual(r.status_code, 200, r.text)
        emails = {p["email"] for p in r.json()["sample"]}
        self.assertEqual(emails, {BAUTH, BLRN, NOCO})


if __name__ == "__main__":
    unittest.main()
