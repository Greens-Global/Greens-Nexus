"""The person picked to purchase a requisition can see it.

approve_requisition assigns an allocator (anyone at supervisor level or above,
items.list_allocators) and _require_fulfiller lets them mark it ordered and
fulfill it - but list_requisitions only returned a below-manager caller's OWN
rows, so a supervisor allocator never saw the purchase they were given.
Workday > Purchase Requests (Oct 22 2026) lists it for them under "Assigned to
You to Purchase"; everyone else's requisitions stay hidden.

Run with: python -m unittest test_requisition_allocator_visibility -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database
import models
from routers.requisitions import list_requisitions


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(
            f"{__name__} deletes rows and is pointed at {actual!r}, not its own "
            f"temp database. Another test module imported `database` first. "
            f"Run it on its own: python -m unittest {__name__}"
        )


_assert_isolated()

SUPERVISOR = {"email": "sam@greensglobal.com", "level": 2}
MANAGER = {"email": "mia@greensglobal.com", "level": 3}


def _req(id_, employee_email, allocator_email="", status="manager_approved"):
    return models.Requisition(id=id_, employee_name=id_, employee_dept="IT", item="Monitor",
                              employee_email=employee_email, allocator_email=allocator_email,
                              status=status, created_at=f"2026-10-0{len(id_)}T10:00:00",
                              updated_at="2026-10-01T10:00:00")


class RequisitionAllocatorVisibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
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
        for m in (models.ApprovalHistory, models.Requisition):
            self.db.query(m).delete()
        self.db.add_all([
            _req("assigned", "erin@greensglobal.com", allocator_email="sam@greensglobal.com"),
            _req("mine", "sam@greensglobal.com", status="pending_manager"),
            _req("other", "erin@greensglobal.com", allocator_email="mia@greensglobal.com"),
        ])
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _ids(self, user):
        return sorted(r["id"] for r in list_requisitions(user=user, db=self.db))

    def test_a_supervisor_sees_their_own_and_the_ones_they_purchase(self):
        self.assertEqual(self._ids(SUPERVISOR), ["assigned", "mine"])

    def test_a_manager_still_sees_everything(self):
        self.assertEqual(self._ids(MANAGER), ["assigned", "mine", "other"])


if __name__ == "__main__":
    unittest.main()
