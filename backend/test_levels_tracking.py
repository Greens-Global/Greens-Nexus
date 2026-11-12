"""Workforce Analytics grant levels (11/12/2026, routers/timeclock.py
require_tracking / _tracking_reach / _visible_emails): on the monitoring
routes a Viewer sees their direct reports, an Editor their whole reporting
line, Full the company; the monitoring policy stays Full's.

    python -m pytest test_levels_tracking.py
"""
import unittest

import levels_testkit as kit

kit.bind_db()

from fastapi.testclient import TestClient  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import timeclock  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
VIEWER, EDITOR, FULL, NONE = "wa.viewer" + D, "wa.editor" + D, "wa.full" + D, "wa.none" + D
LEAD, CREW, DEEP = "wa.lead" + D, "wa.crew" + D, "wa.deep" + D   # LEAD reports to each manager in turn
# A manager also backs up their reports' reports by default (backup_manager),
# so a Viewer sees LEAD and CREW; only the line (Editor) reaches DEEP.


class TrackingLevelTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        db = database.SessionLocal()
        try:
            kit.reset(db)
            for em in (VIEWER, EDITOR, FULL, NONE):
                kit.person(db, em, role="manager")
            kit.person(db, LEAD, manager=VIEWER)
            kit.person(db, CREW, manager=LEAD)
            kit.person(db, DEEP, manager=CREW)
            kit.grant(db, VIEWER, "employee-tracking:viewer")
            kit.grant(db, EDITOR, "employee-tracking:editor")
            kit.grant(db, FULL, "employee-tracking:full")
            db.commit()
        finally:
            db.close()
        kit.refresh()

    def _reach(self, email: str, manager_of_lead: bool = True):
        db = database.SessionLocal()
        try:
            if manager_of_lead:
                db.get(models.NexusEmployee, f"e-{LEAD}").manager_email = email
                db.commit()
            user = timeclock._tracking_reach({"email": email, "level": 3}, db)
            return timeclock._visible_emails(db, user)
        finally:
            db.close()

    def test_viewer_sees_direct_reports(self):
        self.assertEqual(self._reach(VIEWER), {VIEWER, LEAD, CREW})

    def test_editor_sees_the_whole_line(self):
        self.assertEqual(self._reach(EDITOR), {EDITOR, LEAD, CREW, DEEP})

    def test_full_sees_the_company(self):
        self.assertIsNone(self._reach(FULL))   # walls off: everyone

    def test_routes_gate_by_grant_and_policy_stays_full(self):
        kit.as_(NONE)
        self.assertEqual(self.client.get("/timeclock/locations").status_code, 403)
        kit.as_(VIEWER)
        self.assertEqual(self.client.get("/timeclock/locations").status_code, 200)
        kit.as_(EDITOR)
        self.assertEqual(self.client.get("/timeclock/monitoring/companies").status_code, 403)
        kit.as_(FULL)
        self.assertEqual(self.client.get("/timeclock/monitoring/companies").status_code, 200)


if __name__ == "__main__":
    unittest.main()
