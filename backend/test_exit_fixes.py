"""Exit fixes (Neil, 11/14/2026) - pinned.

  * the offboarding checklist starts when the exit is SCHEDULED (its
    notice-period steps are due before the last day), once - the apply never
    starts a second one - and Cancel Offboarding cancels it;
  * a second Offboard is refused while an exit is scheduled; Change Last Day
    moves the exit and the checklist's dates, and a day of today applies now;
  * direct reports need a new manager before Offboard, and move to them when
    the person becomes Left (a Backup Manager they were goes back to default);
  * an immediate exit whose leaver steps fail is said clearly (never a bare
    500) and the next pass ends their access;
  * with a mailbox export asked for, the license is released only once the
    export finished - a failed export keeps it and says so on the exit;
  * shifts after the LAST DAY leave the schedule (not after the server's
    date), and the leaver's push subscriptions go.

Graph and the slow leaver steps are replaced by recorders - nothing leaves
the machine. Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_exit_fixes.py -q
"""
import os
import tempfile
import unittest
from datetime import date, timedelta
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_RATE_LIMIT", "off")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import hr_life_events as hle  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import hr  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
CO = "co-exit-fixes"
HR = "hr.exitfix" + D
BOSS = "boss.exitfix" + D
LEAVER = "leaver.exitfix" + D
REPORT = "report.exitfix" + D
COVERED = "covered.exitfix" + D
NEXT = "next.exitfix" + D
FUTURE = (date.today() + timedelta(days=30)).isoformat()


class ExitFixTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = HR
        db = database.SessionLocal()
        try:
            for m in (models.HrLifeEvent, models.ServerSession, models.NexusGroupMember, models.NexusGroup,
                      models.NexusRole, models.HrEntity, models.HrChecklist, models.HrChecklistItem,
                      models.ExitStatement, models.HrMailboxExport, models.ScheduledShift,
                      models.NexusPushSubscription, models.NexusNotification):
                db.query(m).delete(synchronize_session=False)
            db.query(models.NexusEmployee).execution_options(include_deleted=True).delete(synchronize_session=False)
            db.add(models.HrEntity(id=CO, name="Exit Fix Co", hr_contact_email=HR))
            db.add(models.NexusRole(email=HR, role="owner"))
            for eid, em, extra in (("e-boss", BOSS, {}), ("e-next", NEXT, {}),
                                   ("e-leaver", LEAVER, {"personal_email": "lee@home.example", "manager_email": BOSS,
                                                         "m365_id": "m365-leaver"})):
                db.add(models.NexusEmployee(id=eid, first_name=eid[2:].title(), last_name="Fix", work_email=em,
                                            company=CO, status="active", deleted_at="", **extra))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        auth._role_cache.clear()
        self.calls = []
        self._saved = [(hr, n, getattr(hr, n)) for n in
                       ("_graph_token", "_graph_set_signin", "_graph_revoke_sessions", "_graph_remove_all_licenses",
                        "_run_mailbox_export")]
        hr._graph_token = lambda: "tok"
        hr._graph_set_signin = lambda t, uid, en: self.calls.append(("signin", uid, en))
        hr._graph_revoke_sessions = lambda t, uid: self.calls.append(("revoke", uid))
        hr._graph_remove_all_licenses = lambda t, uid: (self.calls.append(("licenses", uid)), "1 released")[1]

    def tearDown(self):
        for obj, name, real in self._saved:
            setattr(obj, name, real)
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()

    # ── helpers ──
    def _db(self):
        return database.SessionLocal()

    def _get(self, model, **by):
        db = self._db()
        try:
            return db.query(model).filter_by(**by).all()
        finally:
            db.close()

    def _offboard(self, last_day, offboarding=None, **extra):
        inputs = {"last_day": last_day, "exit_type": "resignation", "reason": "Moving away", "send_package": False,
                  "start_checklist": True,
                  "offboarding": {"mailboxAction": "remove", **(offboarding or {})}, **extra}
        return self.client.post("/hr/employees/e-leaver/offboard", json={"inputs": inputs})

    def _make_due(self, day="2026-01-01"):
        db = self._db()
        db.query(models.HrLifeEvent).filter_by(apply_status="scheduled").update({"effective_date": day})
        db.commit()
        db.close()

    # ── the checklist ──
    def test_the_checklist_starts_when_the_exit_is_scheduled_and_only_once(self):
        r = self._offboard(FUTURE)
        self.assertEqual(r.status_code, 200, r.text)
        cls = self._get(models.HrChecklist, employee_id="e-leaver", kind="offboarding")
        self.assertEqual([(c.status, c.anchor_date) for c in cls], [("open", FUTURE)])
        ev = self._get(models.HrLifeEvent, id=r.json()["id"])[0]
        self.assertEqual(ev.inputs["checklist_id"], cls[0].id)
        # Due dates count back from the last day - the notice-period steps
        # land before it, not "born overdue" on the morning after.
        items = self._get(models.HrChecklistItem, checklist_id=cls[0].id)
        self.assertTrue(any(i.due_date and i.due_date < FUTURE for i in items))
        self._make_due()
        self.assertEqual(hle.apply_due_separations(), 1)
        self.assertEqual(len(self._get(models.HrChecklist, employee_id="e-leaver", kind="offboarding")), 1)

    def test_cancel_offboarding_cancels_its_checklist(self):
        r = self._offboard(FUTURE)
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.post(f"/hr/life-events/{r.json()['id']}/cancel-offboarding")
        self.assertEqual(r.status_code, 200, r.text)
        cls = self._get(models.HrChecklist, employee_id="e-leaver", kind="offboarding")
        self.assertEqual([c.status for c in cls], ["cancelled"])

    # ── one exit at a time; Change Last Day ──
    def test_a_second_offboard_is_refused_and_change_last_day_moves_it(self):
        first = self._offboard(FUTURE)
        self.assertEqual(first.status_code, 200, first.text)
        again = self._offboard((date.today() + timedelta(days=40)).isoformat())
        self.assertEqual(again.status_code, 409, again.text)
        self.assertIn("Change Last Day", again.json()["detail"])
        later = (date.today() + timedelta(days=45)).isoformat()
        r = self.client.post("/hr/employees/e-leaver/offboard/last-day", json={"last_day": later})
        self.assertEqual(r.status_code, 200, r.text)
        ev = self._get(models.HrLifeEvent, id=first.json()["id"])[0]
        self.assertEqual((ev.effective_date, ev.inputs["last_day"], ev.apply_status), (later, later, "scheduled"))
        cl = self._get(models.HrChecklist, employee_id="e-leaver", kind="offboarding")[0]
        self.assertEqual(cl.anchor_date, later)
        hist = self._get(models.ExitStatement, employee_id="e-leaver")
        self.assertTrue(any(h["action"] == "last_day_moved" for row in hist for h in row.history))
        self.assertEqual(self._get(models.NexusEmployee, id="e-leaver")[0].status, "active")
        # A last day of today = their access ends now.
        r = self.client.post("/hr/employees/e-leaver/offboard/last-day", json={"last_day": hle._today()})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["applyStatus"], "applied")
        self.assertEqual(self._get(models.NexusEmployee, id="e-leaver")[0].status, "offboarded")
        self.assertEqual(len(self._get(models.HrChecklist, employee_id="e-leaver", kind="offboarding")), 1)

    # ── direct reports ──
    def test_direct_reports_need_a_new_manager_and_move_when_they_leave(self):
        db = self._db()
        db.add(models.NexusEmployee(id="e-rep", first_name="Rae", last_name="Port", work_email=REPORT, company=CO,
                                    status="active", deleted_at="", manager_email=LEAVER))
        db.add(models.NexusEmployee(id="e-cov", first_name="Cova", last_name="Red", work_email=COVERED, company=CO,
                                    status="active", deleted_at="", manager_email=BOSS, backup_manager_email=LEAVER))
        db.commit()
        db.close()
        ctx = self.client.get("/hr/employees/e-leaver/offboard/context").json()
        self.assertEqual([(x["email"], x["kind"]) for x in ctx["reports"]], [(REPORT, "manager"), (COVERED, "backup")])
        r = self._offboard(FUTURE)
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("direct report", r.json()["detail"])
        r = self._offboard(FUTURE, {"reportsTo": NEXT})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._get(models.NexusEmployee, id="e-rep")[0].manager_email, LEAVER)   # not before they leave
        self._make_due()
        self.assertEqual(hle.apply_due_separations(), 1)
        self.assertEqual(self._get(models.NexusEmployee, id="e-rep")[0].manager_email, NEXT)
        self.assertEqual(self._get(models.NexusEmployee, id="e-cov")[0].backup_manager_email, "")
        notes = [h["action"] for row in self._get(models.ExitStatement, employee_id="e-leaver") for h in row.history]
        self.assertIn("reports_moved", notes)
        self.assertIn("backups_cleared", notes)

    def test_the_roles_they_hold_are_listed(self):
        db = self._db()
        db.query(models.HrEntity).filter_by(id=CO).update({"it_contact_email": LEAVER})
        db.add(models.HrDepartment(id="d-1", company_id=CO, name="Ops", lead_email=LEAVER))
        db.commit()
        db.close()
        ctx = self.client.get("/hr/employees/e-leaver/offboard/context").json()
        self.assertEqual(sorted(x["label"] for x in ctx["rolesHeld"]), ["Department Lead", "IT Support Contact"])
        self.assertTrue(all(x["link"]["view"] for x in ctx["rolesHeld"]))

    # ── a failed immediate apply ──
    def test_a_failed_immediate_offboarding_is_said_clearly_and_the_next_pass_ends_access(self):
        real = hr.apply_status_change

        def boom(*a, **k):
            raise RuntimeError("Graph timed out")
        hr.apply_status_change = boom
        try:
            r = self._offboard(hle._today())
        finally:
            hr.apply_status_change = real
        self.assertEqual(r.status_code, 502, r.text)
        self.assertIn("next pass", r.json()["detail"])
        ev = self._get(models.HrLifeEvent, employee_id="e-leaver")[0]
        self.assertEqual((ev.apply_status, ev.inputs.get("immediate")), ("scheduled", True))
        self.assertEqual(self._get(models.NexusEmployee, id="e-leaver")[0].status, "active")
        self.assertEqual(hle.apply_due_separations(), 1)          # effective today, still scheduled
        self.assertEqual(self._get(models.NexusEmployee, id="e-leaver")[0].status, "offboarded")

    def test_a_last_day_of_today_on_a_scheduled_exit_is_not_applied_early(self):
        r = self._offboard(FUTURE)
        self.assertEqual(r.status_code, 200, r.text)
        self._make_due(hle._today())
        self.assertEqual(hle.apply_due_separations(), 0)          # they work their last day

    # ── the mailbox order ──
    def test_the_license_waits_for_the_mailbox_export(self):
        started = []
        hr._run_mailbox_export = lambda job_id, m365_id, release_license=False: started.append(
            (job_id, m365_id, release_license))
        r = self._offboard(hle._today(), {"exportRequested": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("licenses", [c[0] for c in self.calls])  # not released before the export
        self.assertEqual([(s[1], s[2]) for s in started], [("m365-leaver", True)])
        self.assertIn("export", r.json()["result"]["m365"]["licenses"])
        job_id = started[0][0]
        hr._run_mailbox_export = self._saved[-1][2]
        # The export fails: the license is kept and the exit says so.
        with mock.patch.object(hr, "_export_mailbox", return_value=(False, "Mail.Read not consented")):
            hr._run_mailbox_export(job_id, "m365-leaver", release_license=True)
        self.assertNotIn("licenses", [c[0] for c in self.calls])
        ev = self._get(models.HrLifeEvent, employee_id="e-leaver")[0]
        self.assertIn("mailbox_export_failed", [f["code"] for f in ev.flags])
        self.assertIn("license kept", [f["message"] for f in ev.flags if f["code"] == "mailbox_export_failed"][0])
        # Done: released after it.
        with mock.patch.object(hr, "_export_mailbox", return_value=(True, "")):
            hr._run_mailbox_export(job_id, "m365-leaver", release_license=True)
        self.assertIn(("licenses", "m365-leaver"), self.calls)

    def test_no_export_releases_the_license_at_once(self):
        r = self._offboard(hle._today())
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn(("licenses", "m365-leaver"), self.calls)

    # ── shifts and the bell's devices ──
    def test_shifts_after_the_last_day_go_and_push_subscriptions_with_them(self):
        last = (date.today() - timedelta(days=2)).isoformat()
        after = (date.today() - timedelta(days=1)).isoformat()
        db = self._db()
        for sid, day in (("sh-last", last), ("sh-after", after)):
            db.add(models.ScheduledShift(id=sid, employee_email=LEAVER, work_date=day, published=0))
        db.add(models.NexusPushSubscription(id="ps_1", email=LEAVER, endpoint="https://push.test/1"))
        db.commit()
        db.close()
        r = self._offboard(last)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([s.id for s in self._get(models.ScheduledShift, employee_email=LEAVER)], ["sh-last"])
        self.assertEqual(self._get(models.NexusPushSubscription, email=LEAVER), [])


if __name__ == "__main__":
    unittest.main()
