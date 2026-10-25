"""
The Act As people list carries what the header's finder searches (Neil, Oct
25 2026: with 100+ people a name-only list is a long scroll) - job title,
department, company name, site and role - and still lists only people
strictly below the caller's role, never the caller, never an offboarded one.

Throwaway sqlite. No network.

Run with: python -m unittest test_act_as_targets -v
"""
import os
import tempfile
import unittest

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import atexit

import database
import models

models.Base.metadata.create_all(bind=database.engine)

import act_as  # noqa: E402


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


MGR = "maya.mgr@example.com"
EMP = "eli.emp@example.com"
PEER = "pat.peer@example.com"
GONE = "gus.gone@example.com"
CO = "co-act-as-test"


class EligibleTargetsTests(unittest.TestCase):
    def setUp(self):
        bound = os.path.normcase(os.path.abspath(database.engine.url.database or ""))
        if bound != os.path.normcase(os.path.abspath(_tmp.name)):
            self.skipTest("database is bound to another file's DB")
        self.db = database.SessionLocal()
        for m in (models.NexusEmployee, models.NexusRole, models.HrEntity):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO, name="Greens India"))
        people = [
            ("p1", "Maya", MGR, "manager", "active", "Operations Manager", "", ""),
            ("p2", "Eli", EMP, "employee", "active", "HR Coordinator", "People", "Austin"),
            ("p3", "Pat", PEER, "manager", "active", "Site Lead", "", ""),
            ("p4", "Gus", GONE, "employee", "offboarded", "Technician", "", ""),
        ]
        for pid, first, email, role, status, title, dept, site in people:
            self.db.add(models.NexusEmployee(id=pid, first_name=first, last_name="Test", work_email=email,
                                             status=status, job_title=title, department=dept,
                                             location=site, company=CO))
            self.db.add(models.NexusRole(email=email, role=role, assigned_by="test"))
        self.db.commit()

    def tearDown(self):
        if hasattr(self, "db"):
            self.db.close()

    def test_lists_only_lower_roles_with_search_fields(self):
        out = act_as.eligible_targets(user={"email": MGR, "level": 3}, db=self.db)
        self.assertEqual([p["email"] for p in out], [EMP])
        eli = out[0]
        self.assertEqual(eli["title"], "HR Coordinator")
        self.assertEqual(eli["department"], "People")
        self.assertEqual(eli["company"], "Greens India")
        self.assertEqual(eli["site"], "Austin")
        self.assertEqual(eli["role"], "employee")


if __name__ == "__main__":
    unittest.main()
