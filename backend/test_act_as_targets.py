"""
The Act As people list carries what the header's finder searches (Neil, Oct
25 2026: with 100+ people a name-only list is a long scroll) - job title,
department, company name, site and role - and still lists only people
strictly below the caller's role, never the caller, never an offboarded one.
Manager tier and below reach only their own reporting line (direct and
indirect reports); an Administrator keeps the whole company (Pranshu,
11/12/2026) - the picker and /start agree.

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
LEAD = "lee.lead@example.com"        # supervisor, reports to MGR
EMP = "eli.emp@example.com"          # reports to LEAD
PEER = "pat.peer@example.com"
PEER_EMP = "pia.peeremp@example.com"  # reports to PEER
ADMIN = "ada.admin@example.com"
GONE = "gus.gone@example.com"
CO = "co-act-as-test"


class _Req:
    headers: dict = {}
    client = None


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
            ("p1", "Maya", MGR, "manager", "active", "Operations Manager", "", "", ""),
            ("p2", "Eli", EMP, "employee", "active", "HR Coordinator", "People", "Austin", LEAD),
            ("p3", "Pat", PEER, "manager", "active", "Site Lead", "", "", ""),
            ("p4", "Gus", GONE, "employee", "offboarded", "Technician", "", "", MGR),
            ("p5", "Lee", LEAD, "supervisor", "active", "Team Lead", "People", "", MGR),
            ("p6", "Pia", PEER_EMP, "employee", "active", "Technician", "", "", PEER),
            ("p7", "Ada", ADMIN, "administrator", "active", "IT", "", "", ""),
        ]
        for pid, first, email, role, status, title, dept, site, mgr in people:
            self.db.add(models.NexusEmployee(id=pid, first_name=first, last_name="Test", work_email=email,
                                             status=status, job_title=title, department=dept,
                                             location=site, company=CO, manager_email=mgr))
            self.db.add(models.NexusRole(email=email, role=role, assigned_by="test"))
        self.db.commit()

    def tearDown(self):
        if hasattr(self, "db"):
            self.db.close()

    def test_lists_only_lower_roles_with_search_fields(self):
        out = act_as.eligible_targets(user={"email": MGR, "level": 3}, db=self.db)
        # Eli (indirect) and Lee (direct) - not Pia, who reports to a peer.
        self.assertEqual([p["email"] for p in out], [EMP, LEAD])
        eli = out[0]
        self.assertEqual(eli["title"], "HR Coordinator")
        self.assertEqual(eli["department"], "People")
        self.assertEqual(eli["company"], "Greens India")
        self.assertEqual(eli["site"], "Austin")
        self.assertEqual(eli["role"], "employee")


    def test_manager_starts_only_within_reporting_line(self):
        mgr = {"email": MGR, "level": 3}
        out = act_as.start_session(act_as.StartIn(target_email=EMP), _Req(), user=mgr, db=self.db)
        self.assertEqual(out["target_email"], EMP)
        with self.assertRaises(act_as.HTTPException) as cm:
            act_as.start_session(act_as.StartIn(target_email=PEER_EMP), _Req(), user=mgr, db=self.db)
        self.assertEqual(cm.exception.status_code, 404)

    def test_administrator_keeps_the_whole_company(self):
        admin = {"email": ADMIN, "level": 4}
        out = act_as.eligible_targets(user=admin, db=self.db)
        self.assertEqual(sorted(p["email"] for p in out), sorted([EMP, LEAD, MGR, PEER, PEER_EMP]))
        out = act_as.start_session(act_as.StartIn(target_email=PEER_EMP), _Req(), user=admin, db=self.db)
        self.assertEqual(out["target_email"], PEER_EMP)


if __name__ == "__main__":
    unittest.main()
