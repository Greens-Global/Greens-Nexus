"""Training Reminders settings (kb_reminder_config.py, routers/kb_reminder_settings.py)
and the Knowledge Base reminder email link (kb_daily._mail). ONE FILE PER PROCESS."""
import os
import tempfile
import unittest
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_RATE_LIMIT", "off")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import graph_mail  # noqa: E402
import kb_core  # noqa: E402
import kb_daily  # noqa: E402
import kb_reminder_config as krc  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from hr_reminder_config import ReminderConfigError  # noqa: E402

ADMIN = "kbrs.admin@example.com"
MGR = "kbrs.manager@example.com"
LRN = "kbrs.learner@example.com"


class KbReminderSettingsCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)
        db = database.SessionLocal()
        try:
            db.add(models.NexusRole(email=ADMIN, role="administrator", display_name="Ada Admin"))
            db.add(models.NexusRole(email=MGR, role="manager", display_name="Mary Manager"))
            db.add(models.NexusRole(email=LRN, role="employee", display_name="Lee Learner"))
            db.add(models.NexusEmployee(id="e-adm", first_name="Ada", last_name="Admin", work_email=ADMIN, status="active", deleted_at=""))
            db.add(models.NexusEmployee(id="e-mgr", first_name="Mary", last_name="Manager", work_email=MGR, status="active", deleted_at=""))
            db.add(models.NexusEmployee(id="e-lrn", first_name="Lee", last_name="Learner", work_email=LRN,
                                        status="active", deleted_at="", manager_email=MGR))
            db.add(models.KbCourse(id="c-1", title="Ladder Safety", status="published"))
            db.add(models.KbCourseAssignment(id="a-1", course_id="c-1", user_email=LRN, due_date=kb_core.today()))
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
        db = database.SessionLocal()
        try:
            db.query(models.NexusSetting).filter(models.NexusSetting.key == "kb_reminder_config").delete()
            db.query(models.KbReminderLog).delete()
            db.commit()
        finally:
            db.close()
        cache.settings_config.invalidate("kb_reminder_config")

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache()

    def _run_learners(self):
        sent = []
        with mock.patch.object(graph_mail, "DEFAULT_FROM_EMAIL", "nexus@example.com"), \
             mock.patch.object(graph_mail, "send_mail", side_effect=lambda **kw: sent.append(kw) or {}):
            db = database.SessionLocal()
            try:
                n = kb_daily.run_learner_reminders(db)
                bells = db.query(models.NexusNotification).filter(models.NexusNotification.recipient == LRN).count()
            finally:
                db.close()
        return n, sent, bells

    def test_validation(self):
        self.assertEqual(krc.validate({}), krc.defaults())
        self.assertFalse(krc.validate({"learners": {"email": False}})["learners"]["email"])
        for bad in ({"nope": {}}, {"learners": {"often": True}}, {"learners": {"enabled": "no"}}, []):
            with self.assertRaises(ReminderConfigError):
                krc.validate(bad)

    def test_manager_sees_admin_saves(self):
        self._as(MGR)
        r = self.client.get("/kb-reminder-settings")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["canEdit"])
        self.assertEqual(r.json()["config"], krc.defaults())
        self.assertNotEqual(self.client.put("/kb-reminder-settings", json={"config": {"learners": {"enabled": False}}}).status_code, 200)
        self._as(LRN)
        self.assertNotEqual(self.client.get("/kb-reminder-settings").status_code, 200)
        self._as(ADMIN)
        r = self.client.put("/kb-reminder-settings", json={"config": {"learners": {"email": False}}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["config"]["learners"], {"enabled": True, "email": False})
        self.assertEqual(r.json()["updatedBy"], ADMIN)
        self.assertEqual(self.client.put("/kb-reminder-settings", json={"learners": {"enabled": 1}}).status_code, 422)

    def test_reminder_email_opens_the_website_not_the_api(self):
        with mock.patch.dict(os.environ, {"NEXUS_APP_URL": "https://nexus.example.com",
                                          "NEXUS_API_BASE": "https://api.example.com"}):
            n, sent, bells = self._run_learners()
        self.assertEqual((n, len(sent), bells), (1, 1, 1))
        self.assertIn("href='https://nexus.example.com/sop/training'", sent[0]["html"])
        self.assertNotIn("api.example.com", sent[0]["html"])

    def test_email_off_keeps_the_bell(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusNotification).delete()
            krc.save_config(db, {"learners": {"email": False}}, {"email": ADMIN})
        finally:
            db.close()
        n, sent, bells = self._run_learners()
        self.assertEqual((n, len(sent), bells), (1, 0, 1))

    def test_off_sends_nothing(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusNotification).delete()
            db.commit()
            krc.save_config(db, {"learners": {"enabled": False}}, {"email": ADMIN})
        finally:
            db.close()
        n, sent, bells = self._run_learners()
        self.assertEqual((n, len(sent), bells), (0, 0, 0))


if __name__ == "__main__":
    unittest.main()
