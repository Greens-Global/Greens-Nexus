"""Workers' comp class code, state and description (Charmi / Neil, 11/05/2026,
Teams Nexus - Accounting): each rate entry is a line of the insurer's sheet -
State | Class Code | Description | Rate Per $100 of Remuneration (e.g. CA 8810
"CLERICAL OFFICE EMPLOYEES-NOC" 0.84). The rate per $100 is the same number
as the percent of wages already stored in rate_pct, so Accounting >
Compensation still charges wages x rate / 100, and the class code rides along
to its person panel.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_workers_comp_class_code.py -q
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers.accounting_compensation import rate_in_force  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

EDITOR = "editor.wcclass.test@greensglobal.com"   # hr_comp:editor - HR / payroll
GROUP_E = "grp-wcclass-test-editor"
EMP = "emp-wcclass-test"
URL = f"/hr/employees/{EMP}/workers-comp"


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email
    auth._role_cache.clear()


class WorkersCompClassCodeTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP_E, name="WC Class Test Editors", allowed_modules="hr_comp:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP_E, email=EDITOR))
            db.add(models.NexusEmployee(id=EMP, employee_code="E-0099", first_name="Casey", last_name="Clerk", work_email="casey.wcclass@x.com", status="active"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        _as(EDITOR)

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.WorkersCompRate).filter(models.WorkersCompRate.employee_id == EMP).delete(synchronize_session=False)
            db.query(models.NexusEmployee).filter(models.NexusEmployee.id == EMP).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GROUP_E).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP_E).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def test_saves_and_reads_the_insurer_line(self):
        r = self.client.post(URL, json={"year": 2026, "ratePct": 0.84, "classCode": " 8810 ", "state": "ca",
                                        "description": "  State Act - CLERICAL OFFICE EMPLOYEES-NOC  "})
        self.assertEqual(r.status_code, 200, r.text)
        now = r.json()["rates"][0]
        self.assertEqual((now["year"], now["ratePct"], now["classCode"], now["state"], now["description"]),
                         (2026, 0.84, "8810", "CA", "State Act - CLERICAL OFFICE EMPLOYEES-NOC"))
        self.assertEqual(self.client.get(URL).json()["rates"][0]["classCode"], "8810")
        db = database.SessionLocal()
        try:
            row = db.query(models.WorkersCompRate).filter(models.WorkersCompRate.employee_id == EMP).one()
            self.assertEqual((row.class_code, row.state, row.rate_pct), ("8810", "CA", 0.84))
        finally:
            db.close()

    def test_hyphenated_class_and_a_new_class_keeps_the_history(self):
        self.client.post(URL, json={"year": 2026, "ratePct": 0.84, "classCode": "8810", "state": "CA"})
        r = self.client.post(URL, json={"year": 2026, "ratePct": 8.52, "classCode": "9015-1", "state": "CA",
                                        "description": "State Act - BUILDING OPERATION-NOC-all other employees"})
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual([(x["classCode"], x["ratePct"]) for x in d["history"]], [("9015-1", 8.52), ("8810", 0.84)])
        self.assertEqual(d["rates"][0]["classCode"], "9015-1")

    def test_old_clients_without_the_class_still_work(self):
        r = self.client.post(URL, json={"year": 2026, "ratePct": 3.5})
        self.assertEqual(r.status_code, 200, r.text)
        now = r.json()["rates"][0]
        self.assertEqual((now["ratePct"], now["classCode"], now["state"], now["description"]), (3.5, "", "", ""))

    def test_checks_the_state_and_the_class_code(self):
        for body in ({"year": 2026, "ratePct": 1, "state": "Calif"}, {"year": 2026, "ratePct": 1, "state": "C1"},
                     {"year": 2026, "ratePct": 1, "classCode": "88 10"}, {"year": 2026, "ratePct": 1, "classCode": "-8810"},
                     {"year": 2026, "ratePct": 1, "classCode": "1" * 21}):
            self.assertEqual(self.client.post(URL, json=body).status_code, 400, body)
        self.assertEqual(self.client.get(URL).json()["history"], [])

    def test_compensation_carries_the_class_code_and_still_charges_per_100(self):
        # (effective_year, rate per $100, set_at, class_code) - the old 3-item entries still work.
        self.assertEqual(rate_in_force([(2025, 3.0, "a")], 2026), (3.0, 2025))
        self.assertEqual(rate_in_force([(2025, 0.84, "a", "8810"), (2026, 8.52, "b", "9015-1")], 2026), (8.52, 2026, "9015-1"))
        self.assertEqual(rate_in_force([(2025, 0.84, "a", "8810"), (2026, 8.52, "b", "9015-1")], 2025), (0.84, 2025, "8810"))
        self.assertIsNone(rate_in_force([(2027, 1.0, "a", "8810")], 2026))


if __name__ == "__main__":
    unittest.main()
