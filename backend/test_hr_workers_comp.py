"""Workers' comp rate on a person's pay setup (Charmi, 10/27 call, item 14:
"it changes every year ... I would enter here in the HR module, in the
people's module when I'm setting that up"): a percent of gross wages per
year, append-only so the history stays, read with the pay record's hr_comp
grant and added only by an hr_comp editor (HR and payroll).

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_hr_workers_comp.py -q
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

models.Base.metadata.create_all(bind=database.engine)

OWNER = "owner.wc.test@greensglobal.com"     # owner role - bypasses hr_comp
EDITOR = "editor.wc.test@greensglobal.com"   # hr_comp:editor - HR / payroll
VIEWER = "viewer.wc.test@greensglobal.com"   # hr_comp:viewer - reads only
NOBODY = "nobody.wc.test@greensglobal.com"
GROUP_E, GROUP_V = "grp-wc-test-editor", "grp-wc-test-viewer"
EMP = "emp-wc-test"
URL = f"/hr/employees/{EMP}/workers-comp"


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email
    auth._role_cache.clear()


class WorkersCompTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusRole(email=OWNER, role="owner"))
            db.add(models.NexusGroup(id=GROUP_E, name="WC Test Editors", allowed_modules="hr_comp:editor"))
            db.add(models.NexusGroup(id=GROUP_V, name="WC Test Viewers", allowed_modules="hr_comp:viewer"))
            db.add(models.NexusGroupMember(group_id=GROUP_E, email=EDITOR))
            db.add(models.NexusGroupMember(group_id=GROUP_V, email=VIEWER))
            db.add(models.NexusEmployee(id=EMP, employee_code="E-0084", first_name="Valinda", last_name="Cranfill", work_email="valinda.wc@x.com", status="active"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()

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
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_((GROUP_E, GROUP_V))).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id.in_((GROUP_E, GROUP_V))).delete(synchronize_session=False)
            db.query(models.NexusRole).filter(models.NexusRole.email == OWNER).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def test_rates_by_year_with_the_history_kept(self):
        _as(EDITOR)
        self.assertEqual(self.client.get(URL).json(), {"rates": [], "history": []})
        self.assertEqual(self.client.post(URL, json={"year": 2025, "ratePct": 3.0}).status_code, 200)
        self.assertEqual(self.client.post(URL, json={"year": 2026, "ratePct": 4.0}).status_code, 200)
        r = self.client.post(URL, json={"year": 2026, "ratePct": 3.5, "note": "  corrected  "})
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        # The rate in force per year, newest year first; a changed rate is a new entry and the old one stays.
        self.assertEqual([(x["year"], x["ratePct"], x["note"]) for x in d["rates"]], [(2026, 3.5, "corrected"), (2025, 3.0, "")])
        self.assertEqual([(x["year"], x["ratePct"]) for x in d["history"]], [(2026, 3.5), (2026, 4.0), (2025, 3.0)])
        self.assertEqual(d["rates"][0]["setBy"], EDITOR)
        self.assertEqual(self.client.get(URL).json(), d)

    def test_only_hr_comp_editors_add_a_rate(self):
        _as(OWNER)
        self.assertEqual(self.client.post(URL, json={"year": 2026, "ratePct": 2.0}).status_code, 200)
        _as(VIEWER)
        self.assertEqual(self.client.get(URL).status_code, 200, "the pay record's readers see it")
        self.assertEqual(self.client.post(URL, json={"year": 2026, "ratePct": 9.0}).status_code, 403)
        _as(NOBODY)
        self.assertEqual(self.client.get(URL).status_code, 403)
        self.assertEqual(self.client.post(URL, json={"year": 2026, "ratePct": 9.0}).status_code, 403)
        _as(OWNER)
        self.assertEqual([x["ratePct"] for x in self.client.get(URL).json()["history"]], [2.0])

    def test_checks_the_year_and_the_percent(self):
        _as(EDITOR)
        for body in ({"year": 1999, "ratePct": 3}, {"year": 2200, "ratePct": 3}, {"year": 2026, "ratePct": -1}, {"year": 2026, "ratePct": 101}):
            self.assertEqual(self.client.post(URL, json=body).status_code, 400, body)
        self.assertEqual(self.client.post("/hr/employees/no-such-person/workers-comp", json={"year": 2026, "ratePct": 3}).status_code, 404)
        self.assertEqual(self.client.get(URL).json()["history"], [])


if __name__ == "__main__":
    unittest.main()
