"""Shared fixture for the construction phase 2 tests (Neil, 11/03/2026 - the
Job, connected). NOT a test file: each test_construction_jobs_*.py binds its
own throwaway SQLite (DATABASE_URL) BEFORE importing this, and runs in its
own process (CLAUDE.md: one file per process).

Two companies (A, B) with walls on; managers, crew and a desk agent in A;
a manager in B; job "pa" in A (crew CREW, CREW2) and "pb" in B.
"""
import os
import unittest
from datetime import datetime, timezone

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models

A, B = "co-a", "co-b"
MGR_A = "mgr.a@greensglobal.com"
MGR_A2 = "mgr.a2@greensglobal.com"
MGR_B = "mgr.b@greensglobal.com"
CREW = "crew@greensglobal.com"
CREW2 = "crew2@greensglobal.com"
OUTSIDER = "other@greensglobal.com"     # employee in A, on no job
ADMIN = "admin@greensglobal.com"        # Super Administrator (unwalled)

TABLES = (
    "NexusRole", "NexusEmployee", "HrEntity", "NexusSetting", "ConstructionProject", "ConstructionDailyLog",
    "ConstructionMedia", "ConstructionAIJob", "ConstructionWeeklyReport", "ConstructionActivity",
    "ConstructionRfi", "ConstructionMilestone", "ConstructionSubmittal", "ConstructionJobLink",
    "NexusNotification", "PropertyAsset", "Task", "TaskProject", "TaskSection", "TaskCustomStatus",
    "TaskProjectTemplate", "TaskPortfolio", "TaskActivity", "TaskChecklistItem", "TaskTicket",
    "TaskAttachment", "TaskComment", "TimePunch", "ScheduledShift", "DocFormEntry", "DocTemplate",
    "ItemCheckout", "WorkflowEvent",
)


def iso():
    return datetime.now(timezone.utc).isoformat()


class JobsBase(unittest.TestCase):
    tmp_db = ""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            if cls.tmp_db:
                os.remove(cls.tmp_db)
        except OSError:
            pass

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self.db = database.SessionLocal()
        for name in TABLES:
            m = getattr(models, name, None)
            if m is not None:
                self.db.query(m).execution_options(include_deleted=True, include_confidential=True).delete(
                    synchronize_session=False)
        for em, co in ((MGR_A, A), (MGR_A2, A), (MGR_B, B), (CREW, A), (CREW2, A), (OUTSIDER, A), (ADMIN, A)):
            self.db.add(models.NexusEmployee(id=f"e-{em}", first_name=em.split("@")[0].split(".")[0].title(),
                                             last_name="Person", work_email=em, status="active", deleted_at="",
                                             company=co))
        for em in (MGR_A, MGR_A2, MGR_B):
            self.db.add(models.NexusRole(email=em, role="manager", assigned_by="test"))
        self.db.add(models.NexusRole(email=ADMIN, role="owner", assigned_by="test"))
        self.db.add(models.HrEntity(id=A, name="Greens Build"))
        self.db.add(models.HrEntity(id=B, name="Greens Books"))
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.add(self.job("pa", "Job A", A, managers=[MGR_A], workers=[CREW, CREW2]))
        self.db.add(self.job("pb", "Job B", B, managers=[MGR_B]))
        self.db.commit()
        cache.settings_config.invalidate()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def tearDown(self):
        self.db.rollback()
        self.db.close()
        auth.SKIP_AUTH = self._skip
        auth.invalidate_role_cache()
        cache.settings_config.invalidate()

    @staticmethod
    def job(pid, name, company, managers=(), workers=(), **kw):
        base = dict(id=pid, name=name, company_id=company, status="active", archived=False, deleted_at="",
                    manager_emails=list(managers), worker_emails=list(workers), executive_emails=[],
                    week_starts_on=1, report_day=5, created_at=iso(), modified_at=iso(),
                    time_zone="America/Los_Angeles", job_type="project", task_project_id="",
                    created_by=(list(managers) or [""])[0])
        base.update(kw)
        return models.ConstructionProject(**base)

    def as_(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache()

    def fresh(self, model, rid):
        self.db.expire_all()
        return self.db.get(model, rid)
