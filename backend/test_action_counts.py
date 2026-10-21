"""What is waiting on me (Oct 18 2026) - routers/action_counts.py.

The counts follow the screens' own rules: a manager's time off to decide, a
teammate's swap waiting on me, my checklist steps, KB sign-offs, a ticket
waiting on me - and a plain employee gets no approver counts.

    python -m pytest -q test_action_counts.py
"""
import os
import tempfile
import unittest
from datetime import date, timedelta

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

EMP, MGR, MATE = "erin.ac@greensglobal.com", "max.ac@greensglobal.com", "mia.ac@greensglobal.com"
SOON = (date.today() + timedelta(days=3)).isoformat()


class ActionCountsCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")
        self.db = database.SessionLocal()
        for m in (models.NexusEmployee, models.NexusRole, models.TimeOffRequest, models.ShiftRequest,
                  models.HrChecklist, models.HrChecklistItem, models.KbDocument, models.KbAcknowledgement,
                  models.TaskTicket):
            self.db.query(m).delete()
        for em, first, mgr in ((EMP, "Erin", MGR), (MGR, "Max", ""), (MATE, "Mia", MGR)):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=em, first_name=first, last_name="Test",
                                             manager_email=mgr, status="active"))
        self.db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
        self.db.commit()
        auth._role_cache.clear()

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        auth._role_cache.clear()
        auth.SKIP_AUTH = self._skip
        self.db.close()

    def _counts(self, who):
        os.environ["NEXUS_DEV_EMAIL"] = who
        auth._role_cache.clear()
        res = self.client.get("/me/action-counts")
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()["counts"]

    def test_an_exempt_persons_stale_sent_back_sheet_is_not_a_count(self):
        # A review row of the person's OWN sheet left in "with_employee" from
        # before they became time-tracking exempt counted as a "1" on a Time
        # Sheet tab that lists nothing (Neil, Oct 21 2026).
        for m in (models.TimesheetReview, models.NexusGroupMember, models.NexusGroup):
            self.db.query(m).delete()
        self.db.add(models.TimesheetReview(id="r1", employee_email=MGR, period_start="2026-09-20", period_end="2026-10-03",
                                           status="with_employee", manager_email=""))
        self.db.commit()
        self.assertEqual(self._counts(MGR).get("myhr", {}).get("timesheet", 0), 1)   # tracked: it is theirs to fix
        self.db.add(models.NexusGroup(id="g-exec", name="Executives", time_tracking_exempt=1))
        self.db.add(models.NexusGroupMember(group_id="g-exec", email=MGR))
        self.db.commit()
        self.assertEqual(self._counts(MGR).get("myhr", {}).get("timesheet", 0), 0)   # exempt: no sheet, no count
        for m in (models.TimesheetReview, models.NexusGroupMember, models.NexusGroup):
            self.db.query(m).delete()
        self.db.commit()

    def test_nothing_waiting_is_an_empty_map(self):
        self.assertEqual(self._counts(EMP), {})

    def test_time_off_waits_on_the_manager_not_the_employee(self):
        self.db.add(models.TimeOffRequest(id="t1", employee_email=EMP, type="vacation", start_date=SOON,
                                          end_date=SOON, status="pending", created_at="2026-10-18T00:00:00"))
        self.db.commit()
        mgr = self._counts(MGR)
        self.assertEqual(mgr["shifts"]["requests"], 1)
        self.assertEqual(mgr["hr"]["hr-time"], 1)
        # The requester has nothing to do; nor does a teammate.
        self.assertNotIn("shifts", self._counts(EMP))
        self.assertNotIn("shifts", self._counts(MATE))

    def test_what_waits_on_an_employee(self):
        # A teammate's swap waiting for my yes (a past one no longer counts).
        self.db.add(models.ShiftRequest(id="s1", kind="swap", requester_email=MATE, target_email=EMP,
                                        status="pending_peer", shift_date=SOON))
        self.db.add(models.ShiftRequest(id="s2", kind="swap", requester_email=MATE, target_email=EMP,
                                        status="pending_peer", shift_date="2020-01-01"))
        # My checklist step, on an open checklist.
        self.db.add(models.HrChecklist(id="c1", employee_id="id-Mia", status="open"))
        self.db.add(models.HrChecklistItem(id="ci1", checklist_id="c1", owner_email=EMP, status="open"))
        # ...and one not due for weeks: on the card, not waiting on me yet.
        self.db.add(models.HrChecklistItem(id="ci2", checklist_id="c1", owner_email=EMP, status="open",
                                           due_date=(date.today() + timedelta(days=21)).isoformat()))
        # A KB document to sign off, and one I already signed.
        self.db.add(models.KbDocument(id="k1", title="Safety", status="approved", require_ack=True, version="1.0"))
        self.db.add(models.KbDocument(id="k2", title="Handbook", status="approved", require_ack=True, version="1.0"))
        self.db.add(models.KbAcknowledgement(id="a1", doc_id="k2", user_email=EMP, version="1.0"))
        # The desk asked me something on my ticket.
        self.db.add(models.TaskTicket(id="tk1", requester_email=EMP, status="waiting_user", subject="Laptop"))
        self.db.commit()
        c = self._counts(EMP)
        self.assertEqual(c["myhr"], {"timeoff": 1, "overview": 1})
        self.assertEqual(c["support"], {"kb": 1, "open": 1})
        # The teammate who asked has nothing waiting from it.
        self.assertNotIn("myhr", self._counts(MATE))


if __name__ == "__main__":
    unittest.main()
