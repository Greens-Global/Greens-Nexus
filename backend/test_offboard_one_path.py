"""One way to leave (Neil, 11/03/2026).

Offboard is the ONLY path that makes someone Left. The status route refuses
'offboarded' and points to Offboard; Offboard records the termination date
(the last day) on the status log and runs every leaver step - items
returned, future shifts removed, tasks handed over, the vault handed over,
Microsoft 365 sign-in blocked / license freed, Nexus sessions ended - exactly
once, whether the last day is today or the job applies it on the day.

Graph and the leaver-step helpers are replaced by recorders - nothing leaves
the machine. Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_offboard_one_path.py -q
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

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
CO = "co-one-path"
HR = "hr.onepath" + D
BOSS = "boss.onepath" + D
LEAVER = "leaver.onepath" + D


class OffboardIsTheOnlyPath(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = HR
        db = database.SessionLocal()
        try:
            for m in (models.HrLifeEvent, models.ServerSession, models.NexusGroupMember, models.NexusGroup,
                      models.NexusRole, models.HrEntity, models.HrChecklist, models.HrChecklistItem):
                db.query(m).delete(synchronize_session=False)
            db.query(models.NexusEmployee).execution_options(include_deleted=True).delete(synchronize_session=False)
            db.add(models.HrEntity(id=CO, name="One Path Co", hr_contact_email=HR))
            db.add(models.NexusRole(email=HR, role="owner"))
            db.add(models.NexusEmployee(id="e-boss", first_name="Bo", last_name="Ss", work_email=BOSS,
                                        company=CO, status="active", deleted_at=""))
            db.add(models.NexusEmployee(id="e-leaver", first_name="Lee", last_name="Ver", work_email=LEAVER,
                                        personal_email="lee@home.example", manager_email=BOSS,
                                        company=CO, status="active", m365_id="m365-leaver", deleted_at=""))
            db.add(models.ServerSession(id="s-leaver", user_email=LEAVER))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        auth._role_cache.clear()
        self.calls = []
        import routers.items as items
        import routers.task_projects as tp
        import routers.credvault as cv
        import shift_offboard
        self._saved = [(hr, n, getattr(hr, n)) for n in
                       ("_graph_token", "_graph_set_signin", "_graph_revoke_sessions", "_graph_remove_all_licenses")]
        self._saved += [(items, "force_return_person", items.force_return_person),
                        (tp, "handover_person", tp.handover_person),
                        (cv, "handover_person", cv.handover_person),
                        (shift_offboard, "remove_future_shifts", shift_offboard.remove_future_shifts)]
        hr._graph_token = lambda: "tok"
        hr._graph_set_signin = lambda t, uid, en: self.calls.append(("signin", uid, en))
        hr._graph_revoke_sessions = lambda t, uid: self.calls.append(("revoke", uid))
        hr._graph_remove_all_licenses = lambda t, uid: (self.calls.append(("licenses", uid)), "1 released")[1]
        items.force_return_person = lambda db, email, actor: (self.calls.append(("items", email)),
                                                              {"checkouts": 0, "assignments": 1})[1]
        tp.handover_person = lambda db, frm, to, include_completed=False, actor="": (
            self.calls.append(("tasks", frm, to, include_completed)),
            {"reassigned": 2, "projectsTransferred": 0, "toEmail": to})[1]
        cv.handover_person = lambda db, frm, to, actor="": (self.calls.append(("vault", frm)),
                                                           {"credentials": 0, "backups": 0, "grants": 0, "requests": 0})[1]
        shift_offboard.remove_future_shifts = lambda db, email, actor, **k: (self.calls.append(("shifts", email)),
                                                                            {"pendingDelete": 1, "deleted": 0})[1]

    def tearDown(self):
        for obj, name, real in self._saved:
            setattr(obj, name, real)
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()

    def _row(self):
        db = database.SessionLocal()
        try:
            return db.query(models.NexusEmployee).filter(models.NexusEmployee.id == "e-leaver").first()
        finally:
            db.close()

    def _kinds(self):
        return sorted(c[0] for c in self.calls)

    def _offboard(self, last_day, **extra):
        inputs = {"last_day": last_day, "exit_type": "resignation", "reason": "Moving away", "send_package": False,
                  "start_checklist": False, "offboarding": {"mailboxAction": "remove", "handoverTo": "",
                                                           "handoverIncludeCompleted": True}, **extra}
        return self.client.post("/hr/employees/e-leaver/offboard", json={"inputs": inputs})

    def test_the_status_route_refuses_left_and_points_to_offboard(self):
        r = self.client.post("/hr/employees/e-leaver/status",
                             json={"status": "offboarded", "reason": "x", "effectiveDate": "2026-10-20"})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("Offboard", r.json()["detail"])
        self.assertEqual(self._row().status, "active")
        self.assertEqual(self.calls, [])                     # no leaver step ran
        # The profile save cannot slip past it either.
        r = self.client.patch("/hr/employees/e-leaver", json={"status": "offboarded"})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("Offboard", r.json()["detail"])
        # The other statuses still change there.
        r = self.client.post("/hr/employees/e-leaver/status", json={"status": "inactive", "reason": "Leave"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._row().status, "inactive")

    def test_offboard_today_records_the_termination_date_and_runs_each_step_once(self):
        today = hle._today()
        r = self._offboard(today)
        self.assertEqual(r.status_code, 200, r.text)
        row = self._row()
        self.assertEqual(row.status, "offboarded")
        entry = row.status_log[0]
        self.assertEqual((entry["from"], entry["to"], entry["effectiveDate"]), ("active", "offboarded", today))
        self.assertTrue(entry["reason"].startswith("Voluntary Resignation"))
        self.assertEqual(entry["offboarding"]["mailboxAction"], "remove")
        self.assertTrue(entry["offboarding"]["handoverIncludeCompleted"])
        self.assertEqual(self._kinds(), ["items", "licenses", "revoke", "shifts", "signin", "tasks", "vault"])
        self.assertIn(("tasks", LEAVER, BOSS, True), self.calls)     # blank = their supervisor
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.ServerSession).filter(models.ServerSession.user_email == LEAVER).count(), 0)
        finally:
            db.close()
        # A second Offboard is refused - nothing runs twice.
        self.calls.clear()
        r = self._offboard(today)
        self.assertEqual(r.status_code, 409, r.text)
        self.assertEqual(self.calls, [])

    def test_a_termination_date_is_required(self):
        r = self._offboard("")
        self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(self._row().status, "active")
        self.assertEqual(self.calls, [])

    def test_a_future_last_day_waits_then_the_job_applies_it_once(self):
        later = (datetime.strptime(hle._today(), "%Y-%m-%d") + timedelta(days=5)).strftime("%Y-%m-%d")
        r = self._offboard(later)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["applyStatus"], "scheduled")
        self.assertEqual(self._row().status, "active")
        self.assertEqual(self.calls, [])
        db = database.SessionLocal()
        try:
            ev = db.query(models.HrLifeEvent).filter(models.HrLifeEvent.employee_id == "e-leaver").first()
            hle.apply_separation_now(db, ev)
            self.assertEqual(self._kinds(), ["items", "licenses", "revoke", "shifts", "signin", "tasks", "vault"])
            self.calls.clear()
            hle.apply_separation_now(db, ev)                 # applied again: already Left, nothing reruns
            self.assertEqual(self.calls, [])
        finally:
            db.close()
        row = self._row()
        self.assertEqual((row.status, row.status_log[0]["effectiveDate"]), ("offboarded", later))


if __name__ == "__main__":
    unittest.main()
