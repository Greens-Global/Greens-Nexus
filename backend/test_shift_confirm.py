"""
Shifts Phase 3a - confirm my schedule (shift_confirm.py + the routes in
routers/timeclock.py), through a real publish.

Run with: python -m unittest test_shift_confirm -v
"""
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

from fastapi.testclient import TestClient   # noqa: E402

import auth           # noqa: E402
import cache          # noqa: E402
import database       # noqa: E402
import main           # noqa: E402
import models         # noqa: E402
import shift_notify   # noqa: E402

ADMIN = "cf.admin@greensglobal.com"   # administrator: publishes, sees everyone
MGR = "cf.mgr@greensglobal.com"       # a plain manager: BOB reports to them
AMY, BOB = "cf.amy@greensglobal.com", "cf.bob@greensglobal.com"       # company A (asks for confirmations)
CAL = "cf.cal@greensglobal.com"                                       # company B (does not)
ENT_A, ENT_B = "ent-cf-a", "ent-cf-b"
DAY = (datetime.now(timezone.utc).date() + timedelta(days=7)).isoformat()


class ConfirmTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self.db = database.SessionLocal()
        for m in (models.NexusRole, models.NexusEmployee, models.HrEntity, models.ScheduledShift, models.Shift,
                  models.NexusNotification, models.NexusSetting, models.ShiftPublish, models.ShiftPublishConfirm,
                  models.ShiftChangeLog, models.ShiftCalendarEvent, models.ShiftGroup, models.ShiftGroupMember):
            self.db.query(m).delete()
        for em, first, company, manager in ((ADMIN, "Ada", ENT_A, ""), (MGR, "Mia", ENT_A, ""), (AMY, "Amy", ENT_A, ADMIN),
                                            (BOB, "Bob", ENT_A, MGR), (CAL, "Cal", ENT_B, ADMIN)):
            self.db.add(models.NexusEmployee(id=f"emp-{em}", first_name=first, last_name="Lee", work_email=em,
                                             status="active", deleted_at="", company=company, manager_email=manager))
        self.db.add(models.NexusRole(email=ADMIN, role="administrator", assigned_by="test"))
        self.db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
        self.db.add(models.HrEntity(id=ENT_A, name="Greens A", manager_email=ADMIN, manager_emails=[ADMIN]))
        self.db.add(models.HrEntity(id=ENT_B, name="Greens B", manager_email=ADMIN, manager_emails=[ADMIN]))
        self.db.add(models.NexusSetting(key=f"shift_requests_config:{ENT_B}", value=json.dumps({"confirmRequests": False})))
        self.db.add(models.Shift(id="gsv", code="GSV", name="Store", start_hhmm="09:00", end_hhmm="17:00"))
        for em in (AMY, BOB, CAL):
            self.db.add(models.ScheduledShift(id=f"s-{em}", employee_email=em, work_date=DAY, shift_id="gsv",
                                              start_hhmm="09:00", end_hhmm="17:00", published=0, created_by=ADMIN))
        self.db.commit()
        self.sent = []
        p = mock.patch.object(shift_notify, "_send_emails", lambda batch: self.sent.extend(batch))
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch("graph_mail.graph_configured", lambda: True)
        p.start()
        self.addCleanup(p.stop)
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def tearDown(self):
        self.db.rollback()
        self.db.close()
        auth.SKIP_AUTH = self._skip
        auth.invalidate_role_cache()
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _publish(self):
        self._as(ADMIN)
        r = self.client.post("/timeclock/schedule/publish", json={"start_date": DAY, "end_date": DAY})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["published"], 3)
        return r.json()["publishId"]

    def _bell(self, em):
        self.db.expire_all()
        rows = self.db.query(models.NexusNotification).filter(models.NexusNotification.recipient == em).all()
        self.assertEqual(len(rows), 1, [r.title for r in rows])
        return rows[0]

    def _mail(self, em):
        return [(to, subject, html) for to, subject, html in self.sent if to == em]

    # ── The ask ───────────────────────────────────────────────────────────

    def test_publish_asks_people_whose_company_wants_confirmations(self):
        pid = self._publish()
        self.assertTrue(pid)
        # Company A: the bell says so and opens My Shifts on this publish; the email has the button.
        for em in (AMY, BOB):
            bell = self._bell(em)
            self.assertIn("Confirm you have seen it.", bell.body)
            self.assertEqual(json.loads(bell.action), {"view": "shifts", "sub": "mine", "confirm": pid})
            (to, subject, html), = self._mail(em)
            self.assertIn("Confirm You Have Seen It", html)
            self.assertIn(f"/shifts/mine?confirm={pid}", html)
            self.assertIn("Open My Shifts", html)
        # Company B: told, not asked.
        bell = self._bell(CAL)
        self.assertNotIn("Confirm", bell.body)
        self.assertEqual(json.loads(bell.action), {"view": "shifts", "sub": "mine"})
        (to, subject, html), = self._mail(CAL)
        self.assertNotIn("Confirm You Have Seen It", html)
        self.assertNotIn("?confirm=", html)
        # The records: one publish, one ask per company-A person.
        self.db.expire_all()
        pub = self.db.get(models.ShiftPublish, pid)
        self.assertEqual((pub.by, pub.start_date, pub.end_date, pub.changes), (ADMIN, DAY, DAY, 3))
        asks = {a.employee_email: a for a in self.db.query(models.ShiftPublishConfirm).all()}
        self.assertEqual(set(asks), {AMY, BOB})
        self.assertEqual([a.confirmed_at for a in asks.values()], ["", ""])
        # ...and the Outlook queue has a row per shared shift (worked by the loop, not here).
        self.assertEqual({e.shift_id for e in self.db.query(models.ShiftCalendarEvent).all()},
                         {f"s-{AMY}", f"s-{BOB}", f"s-{CAL}"})

    # ── Confirming ────────────────────────────────────────────────────────

    def test_the_person_sees_the_ask_and_confirms_once(self):
        pid = self._publish()
        self._as(AMY)
        r = self.client.get("/timeclock/my-schedule/confirmations")
        self.assertEqual(r.status_code, 200, r.text)
        pending = r.json()["pending"]
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["publishId"], pid)
        self.assertEqual((pending[0]["by"], pending[0]["byName"], pending[0]["start"], pending[0]["end"]),
                         (ADMIN, "Ada Lee", DAY, DAY))
        self.assertEqual(pending[0]["changes"], 1)   # HER one shift, not the publish's three
        self.assertTrue(pending[0]["at"])
        r = self.client.post(f"/timeclock/schedule/confirm/{pid}")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["confirmedAt"])
        self.assertEqual(r.json()["remaining"], 0)
        first = r.json()["confirmedAt"]
        self.assertEqual(self.client.get("/timeclock/my-schedule/confirmations").json()["pending"], [])
        # Confirming again keeps the first time.
        self.assertEqual(self.client.post(f"/timeclock/schedule/confirm/{pid}").json()["confirmedAt"], first)
        # Someone never asked (company B) gets a 404, as does a made-up publish.
        self._as(CAL)
        self.assertEqual(self.client.post(f"/timeclock/schedule/confirm/{pid}").status_code, 404)
        self._as(AMY)
        self.assertEqual(self.client.post("/timeclock/schedule/confirm/nope").status_code, 404)

    # ── The manager's list ────────────────────────────────────────────────

    def test_the_manager_list_shows_who_confirmed_within_scope(self):
        pid = self._publish()
        self._as(AMY)
        self.client.post(f"/timeclock/schedule/confirm/{pid}")
        self._as(ADMIN)
        r = self.client.get("/timeclock/schedule/confirmations", params={"start": DAY, "end": DAY})
        self.assertEqual(r.status_code, 200, r.text)
        people = {p["email"]: p for p in r.json()["people"]}
        self.assertEqual(set(people), {AMY, BOB})          # CAL was never asked
        self.assertEqual(r.json()["unconfirmed"], 1)
        self.assertTrue(people[AMY]["publishes"][0]["confirmedAt"])
        self.assertIsNone(people[BOB]["publishes"][0]["confirmedAt"])
        self.assertIsNone(people[BOB]["publishes"][0]["nudgedAt"])
        self.assertEqual(people[BOB]["publishes"][0]["publishId"], pid)
        self.assertEqual(people[BOB]["name"], "Bob Lee")
        # A range the publish did not touch is empty.
        later = (datetime.now(timezone.utc).date() + timedelta(days=30)).isoformat()
        self.assertEqual(self.client.get("/timeclock/schedule/confirmations", params={"start": later, "end": later}).json()["people"], [])
        # A plain manager sees only their direct reports.
        self._as(MGR)
        r = self.client.get("/timeclock/schedule/confirmations", params={"start": DAY, "end": DAY})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([p["email"] for p in r.json()["people"]], [BOB])
        # Staff cannot read it at all.
        self._as(AMY)
        self.assertEqual(self.client.get("/timeclock/schedule/confirmations", params={"start": DAY, "end": DAY}).status_code, 403)

    # ── The nudge ─────────────────────────────────────────────────────────

    def test_nudge_goes_once_per_publish_and_never_to_someone_who_confirmed(self):
        pid = self._publish()
        self._as(AMY)
        self.client.post(f"/timeclock/schedule/confirm/{pid}")
        self.sent.clear()
        self._as(ADMIN)
        r = self.client.post("/timeclock/schedule/nudge", json={"publish_id": pid})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["nudged"], 1)
        self.assertEqual(r.json()["emails"], [BOB])
        self.assertEqual(r.json()["skipped"]["confirmed"], 1)
        # Bob: one bell + one email; Amy (confirmed): nothing new.
        self.db.expire_all()
        bobs = self.db.query(models.NexusNotification).filter(models.NexusNotification.recipient == BOB).all()
        nudge = [n for n in bobs if n.title == "Please confirm your schedule"]
        self.assertEqual(len(nudge), 1)
        self.assertEqual(json.loads(nudge[0].action), {"view": "shifts", "sub": "mine", "confirm": pid})
        (to, subject, html), = self.sent
        self.assertEqual((to, subject), (BOB, "Please confirm your schedule"))
        self.assertIn("Confirm My Schedule", html)
        self.assertIn(f"/shifts/mine?confirm={pid}", html)
        self.assertIn("Ada Lee", html)
        # Once per publish: a second nudge sends nothing.
        r = self.client.post("/timeclock/schedule/nudge", json={"publish_id": pid})
        self.assertEqual((r.json()["nudged"], r.json()["skipped"]["alreadyNudged"]), (0, 1))
        self.assertEqual(len(self.sent), 1)
        # The list shows the nudge.
        r = self.client.get("/timeclock/schedule/confirmations", params={"start": DAY, "end": DAY})
        bob = next(p for p in r.json()["people"] if p["email"] == BOB)
        self.assertTrue(bob["publishes"][0]["nudgedAt"])
        # Bob confirms: the nudge bell is done with.
        self._as(BOB)
        self.client.post(f"/timeclock/schedule/confirm/{pid}")
        self.db.expire_all()
        self.assertTrue(all(n.actioned for n in self.db.query(models.NexusNotification)
                            .filter(models.NexusNotification.recipient == BOB,
                                    models.NexusNotification.title == "Please confirm your schedule").all()))

    def test_nudge_respects_scope_and_the_emails_filter(self):
        pid = self._publish()
        self.sent.clear()
        # A plain manager can only nudge their own people: Amy is out of scope.
        self._as(MGR)
        r = self.client.post("/timeclock/schedule/nudge", json={"publish_id": pid})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["nudged"], r.json()["emails"], r.json()["skipped"]["outOfScope"]), (1, [BOB], 1))
        # The administrator, narrowed to Amy.
        self._as(ADMIN)
        r = self.client.post("/timeclock/schedule/nudge", json={"publish_id": pid, "emails": [AMY]})
        self.assertEqual((r.json()["nudged"], r.json()["emails"]), (1, [AMY]))
        self.assertEqual(sorted(to for to, _, _ in self.sent), [AMY, BOB])
        # An unknown publish is a 404; staff get a 403.
        self.assertEqual(self.client.post("/timeclock/schedule/nudge", json={"publish_id": "nope"}).status_code, 404)
        self._as(AMY)
        self.assertEqual(self.client.post("/timeclock/schedule/nudge", json={"publish_id": pid}).status_code, 403)

    # ── My prefs + the sync status ────────────────────────────────────────

    def test_my_prefs_and_the_admin_status_route(self):
        self._as(AMY)
        r = self.client.get("/timeclock/my-prefs")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["shiftCalendar"], r.json()["companyOutlookCalendar"], r.json()["hasMailbox"]),
                         (True, True, False))
        r = self.client.put("/timeclock/my-prefs", json={"shiftCalendar": False})
        self.assertFalse(r.json()["shiftCalendar"])
        self.assertFalse(self.client.get("/timeclock/my-prefs").json()["shiftCalendar"])
        self.assertIn(self.client.get("/timeclock/calendar-sync/status").status_code, (401, 403))   # administrators only
        self._as(ADMIN)
        r = self.client.get("/timeclock/calendar-sync/status")
        self.assertEqual(r.status_code, 200, r.text)
        for k in ("enabled", "reason", "pending", "ok", "errors", "skipped"):
            self.assertIn(k, r.json())


if __name__ == "__main__":
    unittest.main()
