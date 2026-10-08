"""Hiring pipeline (Neil/Pranshu call, Oct 8) - intake, stage actions,
scheduling and the interview follow-up.

Intake: the role comes from the company's job roles and decides the title and
department; "Other" keeps a typed title + department; a role of another
company is refused; email is checked; a candidate can be edited.

Run with: python -m unittest test_hiring_pipeline -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
from routers import hr  # noqa: E402

ENT, OTHER_ENT = "ent-pipe", "ent-other"
HR_USER = {"email": "hana.hr@greensglobal.com", "level": 5, "role": "admin"}


class PipelineCase(unittest.TestCase):
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
        self.db = database.SessionLocal()
        for m in (models.HrCandidate, models.HrStageEvent, models.NexusGroup, models.HrEntity,
                  models.HrDepartment, models.NexusEmployee):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=ENT, name="Pipe Co"))
        self.db.add(models.HrEntity(id=OTHER_ENT, name="Other Co"))
        self.db.add(models.NexusGroup(id="role-analyst", name="Senior Analyst", department="Accounting",
                                      is_job_role=1, company_id=ENT))
        self.db.add(models.NexusGroup(id="role-shared", name="IT Support Associate", department="IT",
                                      is_job_role=1, company_id=""))
        self.db.add(models.NexusGroup(id="role-elsewhere", name="Chef", department="Kitchen",
                                      is_job_role=1, company_id=OTHER_ENT))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _add(self, **kw):
        body = {"first_name": "Jane", "last_name": "Doe", "email": "jane@gmail.com", "company": ENT}
        body.update(kw)
        return hr.create_candidate(hr.CandidateIn(**body), user=HR_USER, db=self.db)


class IntakeTests(PipelineCase):
    def test_options_offer_the_company_roles_and_shared_ones_with_departments(self):
        out = hr.hiring_options(company_id=ENT, user=HR_USER, db=self.db)
        names = {r["name"]: r["department"] for r in out["roles"]}
        self.assertEqual(names, {"Senior Analyst": "Accounting", "IT Support Associate": "IT"})
        self.assertIn("Accounting", out["departments"])
        self.assertIn("LinkedIn", out["sources"])

    def test_role_decides_title_and_department(self):
        c = self._add(role_id="role-analyst", role_title="typed by hand", department="Wrong")
        self.assertEqual((c["roleId"], c["roleTitle"], c["department"]), ("role-analyst", "Senior Analyst", "Accounting"))

    def test_other_keeps_the_typed_title_and_department(self):
        c = self._add(role_title="Leasing Coordinator", department="Operations")
        self.assertEqual((c["roleId"], c["roleTitle"], c["department"]), ("", "Leasing Coordinator", "Operations"))

    def test_role_of_another_company_is_refused(self):
        with self.assertRaises(HTTPException) as e:
            self._add(role_id="role-elsewhere")
        self.assertIn("different company", e.exception.detail)

    def test_bad_email_is_refused(self):
        with self.assertRaises(HTTPException):
            self._add(email="not-an-email")

    def test_edit_fixes_the_email_and_changes_the_role(self):
        c = self._add(email="")
        out = hr.update_candidate(c["id"], hr.CandidateUpdate(email="Jane.Doe@Gmail.com", role_id="role-shared"),
                                  user=HR_USER, db=self.db)
        self.assertEqual((out["email"], out["roleTitle"], out["department"]), ("jane.doe@gmail.com", "IT Support Associate", "IT"))


if __name__ == "__main__":
    unittest.main()
