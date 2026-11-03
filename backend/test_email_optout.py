"""One-click stop for digest emails (email_optout.py, 11/02/2026): every
digest carries a Stop These Emails link, stopping is one PUT for your own
switch only, a stopped Daily Briefing / Weekly Digest sends nothing in live
mode, and What's New and the Weekly Ticket Report reuse their existing
switches.

Run on its own: `python -m pytest test_email_optout.py` (one file per
process - see CLAUDE.md)."""
import os
import unittest
from datetime import date

import _testdb  # noqa: F401  - a throwaway database whatever runner imports this file

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import daily_briefing  # noqa: E402
import database  # noqa: E402
import email_optout  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import ticket_reports  # noqa: E402
import weekly_digest  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

ME = "optout.me@greensglobal.com"


class OptoutTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = ME
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusRole(email=ME, role="employee"))
            db.commit()
        finally:
            db.close()
        auth.invalidate_role_cache(ME)

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            for m, col in ((models.NexusPersonPref, models.NexusPersonPref.email),
                           (models.ChangelogSubscription, models.ChangelogSubscription.email),
                           (models.NexusRole, models.NexusRole.email)):
                db.query(m).filter(col.like("optout.%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def test_everything_on_until_stopped_then_one_put_each_way(self):
        p = self.client.get("/roles/me/email-optouts").json()
        self.assertTrue(p["daily_briefing"]["on"])
        self.assertTrue(p["weekly_digest"]["on"])
        self.assertFalse(p["whats_new_digest"]["on"])   # opt-in, never turned on
        r = self.client.put("/roles/me/email-optouts", json={"kind": "daily_briefing", "on": False})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["daily_briefing"]["on"])
        self.assertTrue(r.json()["weekly_digest"]["on"])
        db = database.SessionLocal()
        try:
            self.assertTrue(email_optout.is_out(db, ME, "daily_briefing"))
            self.assertFalse(email_optout.is_out(db, ME, "weekly_digest"))
        finally:
            db.close()
        r = self.client.put("/roles/me/email-optouts", json={"kind": "daily_briefing", "on": True})
        self.assertTrue(r.json()["daily_briefing"]["on"])

    def test_existing_switches_are_reused(self):
        self.client.put("/roles/me/email-optouts", json={"kind": "whats_new_digest", "on": True})
        self.client.put("/roles/me/email-optouts", json={"kind": "ticket_weekly_report", "on": False})
        db = database.SessionLocal()
        try:
            self.assertTrue(db.get(models.ChangelogSubscription, ME).digest)
            self.assertIs(ticket_reports.weekly_choice(db, ME), False)
        finally:
            db.close()
        self.client.put("/roles/me/email-optouts", json={"kind": "whats_new_digest", "on": False})
        db = database.SessionLocal()
        try:
            self.assertFalse(db.get(models.ChangelogSubscription, ME).digest)
        finally:
            db.close()

    def test_unknown_kind_is_refused(self):
        self.assertEqual(self.client.put("/roles/me/email-optouts", json={"kind": "payroll", "on": False}).status_code, 422)

    def test_every_digest_carries_the_stop_link(self):
        _, html = daily_briefing.render_email("Ann", "2026-11-02", {})
        self.assertIn("?stopEmail=daily_briefing", html)
        self.assertIn("Stop These Emails", html)
        _, html = weekly_digest.render("Ann", date(2026, 11, 2), {}, "Hello", "", {})
        self.assertIn("?stopEmail=weekly_digest", html)
        self.assertIn("?stopEmail=ticket_weekly_report", ticket_reports._stop_url())

    def test_a_stopped_daily_briefing_sends_nothing_live(self):
        db = database.SessionLocal()
        sent = []
        orig = (daily_briefing.graph_mail.send_mail, daily_briefing.build_sections)
        try:
            email_optout.set_on(db, ME, "daily_briefing", False)
            emp = models.NexusEmployee(id="optout-emp", work_email=ME, first_name="Ann")
            daily_briefing.graph_mail.send_mail = lambda **k: sent.append(k)
            daily_briefing.build_sections = lambda *a, **k: {"action_required": [{"title": "x"}]}
            daily_briefing._send_one(db, emp, {"mode": "live"}, "2026-11-02")
            self.assertEqual(sent, [])
            # Control: the same send with the switch back on does mail.
            email_optout.set_on(db, ME, "daily_briefing", True)
            daily_briefing._send_one(db, emp, {"mode": "live"}, "2026-11-02")
            self.assertEqual(len(sent), 1)
        finally:
            daily_briefing.graph_mail.send_mail, daily_briefing.build_sections = orig
            db.query(models.NexusDailyBriefingLog).filter(models.NexusDailyBriefingLog.employee_email == ME).delete()
            db.commit()
            db.close()


if __name__ == "__main__":
    unittest.main()
