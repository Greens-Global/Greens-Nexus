"""Training due modes and escalation (Sagar, 11/03/2026): a rule due within N
days of the start date, or by ONE date for everyone with N days of grace for
a late joiner; an onboarding rule that covers new hires only; a course still
not done `escalate_days` after its due date is raised to the supervisor once,
then weekly. ONE FILE PER PROCESS."""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_RATE_LIMIT", "off")

import database  # noqa: E402
import kb_core  # noqa: E402
import kb_daily  # noqa: E402
import models  # noqa: E402

MGR = "due.manager@example.com"
OLD = "due.old@example.com"        # started long ago
NEW = "due.new@example.com"        # starts after the rule
HR = "due.hr@example.com"


def _emp(email, first, start, manager=MGR, company="co-1"):
    return models.NexusEmployee(id=f"e-{email}", first_name=first, last_name="Test", work_email=email, status="active", deleted_at="",
                                department="Operations", job_title="Site Manager", manager_email=manager, start_date=start, company=company)


class KbTrainingDueCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)
        db = database.SessionLocal()
        try:
            db.add(models.HrEntity(id="co-1", name="Co One", hr_contact_email=HR))
            db.add(_emp(MGR, "Mary", "2020-01-01", manager=""))
            db.add(_emp(OLD, "Olive", "2024-03-01"))
            db.add(models.KbCourse(id="crs-1", course_code="LRN-001", title="Gate Safety", description="", overview="[]", recert_months=0, departments="",
                                   status="published", owner_email=MGR, owner_name="Mary Test", est_minutes=10, lessons="[]",
                                   quiz='{"passPct":80,"drawCount":0,"maxTries":3,"shuffle":true,"questions":[]}', created_at=kb_core.now(), updated_at=kb_core.now(),
                                   major=1, draft="", published_at=kb_core.now(), published_by=MGR))
            db.commit()
        finally:
            db.close()

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()

    def tearDown(self):
        self.db.close()

    def _course(self):
        return self.db.query(models.KbCourse).filter(models.KbCourse.id == "crs-1").first()

    # ── due modes ────────────────────────────────────────────────────────────
    def test_by_one_date_for_everyone_with_grace_for_a_late_joiner(self):
        db = self.db
        today = kb_core.today()
        date = kb_core.add_days(today, 20)
        old = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == OLD).first()
        self.assertEqual(kb_daily._due_for(db, old, 10, date), date)              # already here: the shared date
        late = _emp("due.late@example.com", "Lee", kb_core.add_days(today, 30))  # starts after the date
        self.assertEqual(kb_daily._due_for(db, late, 10, date), kb_core.add_days(today, 40))   # start + grace
        self.assertEqual(kb_daily._due_for(db, late, 0, date), kb_core.add_days(today, 44))    # no grace set: 14 days
        past = kb_core.add_days(today, -5)
        self.assertEqual(kb_daily._due_for(db, old, 7, past), kb_core.add_days(today, 7))     # the date is gone: today + grace, never overdue on arrival
        self.assertEqual(kb_daily._due_for(db, old, 7), kb_core.add_days(today, 7))           # within-days mode unchanged

    def test_an_onboarding_rule_covers_new_hires_only(self):
        db = self.db
        today = kb_core.today()
        rule = models.KbAssignmentRule(id="rule-onb", kind="course", target_id="crs-1", audience="", due_days=14, renew_months=0, active=True,
                                       new_hires_only=True, escalate_days=0, created_by=MGR, created_at=kb_core.now(), updated_at=kb_core.now())
        db.add(rule)
        db.add(_emp(NEW, "Nina", kb_core.add_days(today, 3)))
        db.commit()
        kb_daily.run_rules(db)
        got = {a.user_email: a for a in db.query(models.KbCourseAssignment).filter(models.KbCourseAssignment.rule_id == "rule-onb").all()}
        self.assertIn(NEW, got)
        self.assertEqual(got[NEW].due_date, kb_core.add_days(today, 17))   # start + 14
        self.assertNotIn(OLD, got)                                          # already here: not onboarding
        self.assertNotIn(MGR, got)

    # ── escalation ───────────────────────────────────────────────────────────
    def test_overdue_past_the_limit_escalates_to_the_manager_once_then_weekly(self):
        db = self.db
        today = kb_core.today()
        rule = models.KbAssignmentRule(id="rule-esc", kind="course", target_id="crs-1", audience="", due_days=1, renew_months=0, active=True,
                                       new_hires_only=False, escalate_days=3, created_by=MGR, created_at=kb_core.now(), updated_at=kb_core.now())
        db.add(rule)
        # Olive: 5 days overdue - past the 3-day limit. Mary (no manager): 1 day overdue - not yet.
        db.add(models.KbCourseAssignment(id="asn-old", course_id="crs-1", user_email=OLD, user_name="Olive Test", due_date=kb_core.add_days(today, -5),
                                         assigned_by="rule", created_at=kb_core.now(), source="rule", rule_id="rule-esc"))
        db.add(models.KbCourseAssignment(id="asn-mgr", course_id="crs-1", user_email=MGR, user_name="Mary Test", due_date=kb_core.add_days(today, -1),
                                         assigned_by="rule", created_at=kb_core.now(), source="rule", rule_id="rule-esc"))
        db.commit()
        self.assertEqual(kb_daily.run_escalations(db), 1)
        bells = db.query(models.NexusNotification).filter(models.NexusNotification.title == "Training Escalated to You").all()
        self.assertEqual([b.recipient for b in bells], [MGR])
        self.assertIn("Olive Test: Gate Safety was due", bells[0].body)
        self.assertTrue(db.query(models.KbCourseAssignment).filter(models.KbCourseAssignment.id == "asn-old").first().escalated_at)
        self.assertEqual(kb_daily.run_escalations(db), 0)   # same week: nothing more
        # Mary slips past the limit with no manager: it goes to the company's HR contact
        a = db.query(models.KbCourseAssignment).filter(models.KbCourseAssignment.id == "asn-mgr").first()
        a.due_date = kb_core.add_days(today, -4)
        db.commit()
        self.assertEqual(kb_daily.run_escalations(db), 1)
        self.assertEqual(db.query(models.NexusNotification).filter(models.NexusNotification.title == "Training Escalated to You",
                                                                    models.NexusNotification.recipient == HR).count(), 1)
        # the escalation pass is listed for Workflows > Automations
        self.assertIn("escalations", kb_daily.PASS_LABELS)


if __name__ == "__main__":
    unittest.main()
