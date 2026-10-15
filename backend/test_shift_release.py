"""Shifts Phase 3b - staff move their own work (Neil, Oct 14 2026):
releasing a shift to the open pool, and open shifts across teams.

  - releaseShifts is OFF by default (403); only the requester's own shared,
    upcoming shift on a team can be released.
  - Approval converts the SAME row into an open slot of its team, logs
    'released', queues the Outlook event's removal and cancels the other
    pending requests on that shift.
  - With releaseNeedsApproval off it happens at once, decided by the
    requester, with one FYI bell to the approvers.
  - A decline tells the requester and moves nothing.
  - openShiftsAcrossTeams off: another team's slot is invisible and refused;
    on: visible with the team's name, decided by the slot's own team (its
    schedulers, else its company's managers) - never the requester's scoped
    manager; a slot of another company never shows.

Throwaway sqlite. Run with: python -m unittest test_shift_release -v
"""
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

from fastapi.testclient import TestClient   # noqa: E402

import auth               # noqa: E402
import cache              # noqa: E402
import database           # noqa: E402
import main               # noqa: E402
import models             # noqa: E402
from routers import shift_requests   # noqa: E402

ENT, ENT2 = "ent-rel", "ent-rel-2"
GROUP, OTHER, NOBODY, FAR = "grp-rel", "grp-rel-other", "grp-rel-nobody", "grp-rel-far"
ADMIN = "rel.admin@greensglobal.com"    # administrator: company-wide
MGR = "rel.mgr@greensglobal.com"        # manager of A and B
SCHED = "rel.sched@greensglobal.com"    # a manager who schedules OTHER (nobody reports to them)
CMGR = "rel.cmgr@greensglobal.com"      # one of ENT's company managers
A = "rel.a@greensglobal.com"            # on GROUP
B = "rel.b@greensglobal.com"            # on GROUP
C = "rel.c@greensglobal.com"            # on OTHER
D = "rel.d@greensglobal.com"            # on FAR (company ENT2)
_today = datetime.now(timezone.utc).date()
DAY = (_today + timedelta(days=10)).isoformat()
DAY2 = (_today + timedelta(days=11)).isoformat()
PAST = (_today - timedelta(days=3)).isoformat()


class _Case(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.NexusRole, models.NexusEmployee, models.ShiftGroup, models.ShiftGroupMember, models.HrEntity,
                  models.Shift, models.ScheduledShift, models.NexusNotification, models.NexusSetting,
                  models.ShiftChangeLog, models.ShiftRequest, models.ShiftCalendarEvent):
            self.db.query(m).delete()
        for em, first, mgr, role, company in (
                (ADMIN, "Ada", "", "administrator", ENT), (MGR, "Mia", "", "manager", ENT),
                (SCHED, "Sam", "", "manager", ENT), (CMGR, "Cal", "", "manager", ENT),
                (A, "Amy", MGR, "", ENT), (B, "Bob", MGR, "", ENT), (C, "Cid", SCHED, "", ENT), (D, "Dee", "", "", ENT2)):
            self.db.add(models.NexusEmployee(id=f"emp-{em}", first_name=first, last_name="Lee", work_email=em,
                                             manager_email=mgr, status="active", deleted_at="", company=company))
            if role:
                self.db.add(models.NexusRole(email=em, role=role, assigned_by="test"))
        self.db.add(models.HrEntity(id=ENT, name="Greens", manager_emails=[CMGR], manager_email=CMGR))
        self.db.add(models.HrEntity(id=ENT2, name="Elsewhere"))
        self.db.add(models.ShiftGroup(id=GROUP, name="Crew", company_id=ENT, created_by=MGR))
        self.db.add(models.ShiftGroup(id=OTHER, name="Other Crew", company_id=ENT, created_by=SCHED,
                                      scheduler_emails=json.dumps([SCHED])))
        self.db.add(models.ShiftGroup(id=NOBODY, name="Quiet Crew", company_id=ENT, created_by=ADMIN))
        self.db.add(models.ShiftGroup(id=FAR, name="Far Crew", company_id=ENT2, created_by=ADMIN))
        for gid, em in ((GROUP, A), (GROUP, B), (OTHER, C), (FAR, D)):
            self.db.add(models.ShiftGroupMember(id=f"m-{gid}-{em}", group_id=gid, employee_email=em))
        # Trading is off by default (Phase 0); open shifts on, release and
        # cross-team as each test sets them.
        self.db.add(models.NexusSetting(key="shift_requests_config",
                                        value=json.dumps({"openShifts": True, "swaps": True, "offers": True})))
        self.db.commit()
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._as(A)

    def tearDown(self):
        self.db.rollback()
        self.db.close()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def _settings(self, **cfg):
        row = self.db.query(models.NexusSetting).filter(models.NexusSetting.key == "shift_requests_config").first()
        saved = json.loads(row.value)
        saved.update(cfg)
        row.value = json.dumps(saved)
        self.db.commit()

    def _shift(self, email, day=DAY, start="09:00", end="17:00", published=1, slots=0, group=GROUP, **kw):
        sid = kw.pop("id", "") or f"s-{email or 'open'}-{day}-{start}-{group}-{published}"
        self.db.add(models.ScheduledShift(id=sid, employee_email=email, work_date=day, start_hhmm=start, end_hhmm=end,
                                          published=published, open_slots=slots, group_id=group, created_by=MGR,
                                          created_at="2026-10-14T00:00:00", **kw))
        self.db.commit()
        return sid

    def _row(self, sid):
        self.db.expire_all()
        return self.db.query(models.ScheduledShift).filter(models.ScheduledShift.id == sid).first()

    def _ask(self, who, **body):
        self._as(who)
        return self.client.post("/timeclock/shift-requests", json=body)

    def _decide(self, who, rid, approve=True, note="", force=False):
        self._as(who)
        return self.client.post(f"/timeclock/shift-requests/{rid}/decide",
                                json={"approve": approve, "note": note, "force": force})

    def _bells(self, email):
        self.db.expire_all()
        return [(n.title, n.body) for n in self.db.query(models.NexusNotification)
                .filter(models.NexusNotification.recipient == email).order_by(models.NexusNotification.created_at).all()]

    def _titles(self, email):
        return [t for t, _ in self._bells(email)]

    def _log(self, sid):
        self.db.expire_all()
        return (self.db.query(models.ShiftChangeLog).filter(models.ShiftChangeLog.shift_id == sid)
                .order_by(models.ShiftChangeLog.at).all())

    def _open_for(self, who, start=DAY, end=DAY2):
        self._as(who)
        r = self.client.get(f"/timeclock/shift-requests/mine?start={start}&end={end}")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["openShifts"]


class ReleaseTests(_Case):
    def test_release_is_off_by_default(self):
        x = self._shift(A)
        r = self._ask(A, kind="release", shift_id=x)
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(r.json()["detail"], "Release requests are turned off.")
        self.assertFalse(shift_requests.get_settings(self.db)["releaseShifts"])
        self.assertTrue(shift_requests.get_settings(self.db)["releaseNeedsApproval"])
        self.assertFalse(shift_requests.get_settings(self.db)["openShiftsAcrossTeams"])

    def test_only_my_own_shared_upcoming_shift_on_a_team(self):
        self._settings(releaseShifts=True)
        self.assertEqual(self._ask(A, kind="release", shift_id=self._shift(B)).status_code, 403)        # not mine
        self.assertEqual(self._ask(A, kind="release", shift_id=self._shift(A, published=0)).status_code, 409)   # a draft
        self.assertEqual(self._ask(A, kind="release", shift_id=self._shift(A, day=PAST)).status_code, 409)      # passed
        r = self._ask(A, kind="release", shift_id=self._shift(A, start="18:00", end="22:00", group=""))
        self.assertEqual(r.status_code, 409, r.text)
        self.assertEqual(r.json()["detail"], "This shift is not on a team, so it cannot go to the open pool.")
        ok = self._ask(A, kind="release", shift_id=self._shift(A), note="Family trip")
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual((ok.json()["kind"], ok.json()["status"], ok.json()["target"], ok.json()["team"]),
                         ("release", "pending_manager", None, "Crew"))
        self.assertEqual(ok.json()["summary"], f"Amy Lee asked to release {shift_requests._when(DAY, '09:00', '17:00')} to the open pool")
        # Asking twice is refused; My Shifts lists it.
        self.assertEqual(self._ask(A, kind="release", shift_id=ok.json()["asked"]["id"]).status_code, 409)
        self._as(A)
        mine = self.client.get("/timeclock/shift-requests/mine").json()["mine"]
        self.assertEqual([(m["kind"], m["status"]) for m in mine], [("release", "pending_manager")])
        self.assertIn("Shift request to approve", self._titles(MGR))

    def test_approval_converts_the_row_into_an_open_slot(self):
        self._settings(releaseShifts=True)
        x = self._shift(A, pending_json=json.dumps({"shiftId": "", "start": "08:00", "end": "16:00", "label": "", "note": "",
                                                    "openSlots": 0}))
        y = self._shift(B, day=DAY2)
        # The Outlook event A has for it, and B's swap that targets it.
        self.db.add(models.ShiftCalendarEvent(id="cal-x", shift_id=x, employee_email=A, event_id="evt-1", state="ok"))
        self.db.commit()
        swap = self._ask(B, kind="swap", shift_id=y, target_email=A, target_shift_id=x).json()
        rel = self._ask(A, kind="release", shift_id=x).json()
        self._as(MGR)
        box = self.client.get("/timeclock/shift-requests").json()
        self.assertEqual([(p["id"], p["kind"], p["team"]) for p in box["pending"]], [(rel["id"], "release", "Crew")])
        d = self._decide(MGR, rel["id"], note="Fine")
        self.assertEqual(d.status_code, 200, d.text)
        self.assertEqual((d.json()["status"], d.json()["decidedBy"]), ("approved", MGR))
        row = self._row(x)
        self.assertEqual((row.employee_email, row.open_slots, row.published, row.group_id, row.pending_json),
                         ("", 1, 1, GROUP, ""))
        self.assertEqual((row.start_hhmm, row.end_hhmm, row.work_date), ("09:00", "17:00", DAY))   # the shared times
        # The change log stays on the person who released it.
        log = self._log(x)
        self.assertEqual([(e.action, e.employee_email, e.actor) for e in log], [("released", A, MGR)])
        self.assertEqual((json.loads(log[0].before_json)["email"], json.loads(log[0].after_json)["openSlots"]), (A, 1))
        self.assertEqual(log[0].reason, f"Released by {A}")
        # The Outlook event is queued for removal; B's swap is cancelled with the reason.
        self.db.expire_all()
        self.assertEqual(self.db.query(models.ShiftCalendarEvent).filter(models.ShiftCalendarEvent.id == "cal-x").first().state,
                         "delete")
        s = self.db.query(models.ShiftRequest).filter(models.ShiftRequest.id == swap["id"]).first()
        self.assertEqual((s.status, s.decision_note), ("cancelled", "Shift released to the open pool"))
        self.assertIn("Shift request cancelled", self._titles(B))
        self.assertIn("Shift request approved", self._titles(A))
        # Teammates can now ask for it; the open slot is in the pool.
        self.assertEqual([(o["id"], o["openSlots"], o["crossTeam"]) for o in self._open_for(B)], [(x, 1, False)])
        self.assertEqual(self._ask(B, kind="open", shift_id=x).status_code, 200)

    def test_without_approval_it_goes_to_the_pool_at_once(self):
        self._settings(releaseShifts=True, releaseNeedsApproval=False)
        x = self._shift(A)
        r = self._ask(A, kind="release", shift_id=x, note="Can't make it")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["status"], r.json()["decidedBy"]), ("approved", A))
        row = self._row(x)
        self.assertEqual((row.employee_email, row.open_slots, row.published), ("", 1, 1))
        self.assertEqual([e.action for e in self._log(x)], ["released"])
        bells = self._bells(MGR)
        self.assertEqual([t for t, _ in bells], ["Shift released to the open pool"])
        self.assertIn("Amy Lee released", bells[0][1])
        self.assertIn("Can't make it", bells[0][1])
        self.assertIn("No approval was needed.", bells[0][1])
        self.assertEqual(self._titles(A), [])            # nothing to approve, nothing to tell A
        # Nothing waits in the inbox.
        self._as(MGR)
        self.assertEqual(self.client.get("/timeclock/shift-requests").json()["pending"], [])

    def test_a_decline_tells_the_requester_and_moves_nothing(self):
        self._settings(releaseShifts=True)
        x = self._shift(A)
        rel = self._ask(A, kind="release", shift_id=x).json()
        d = self._decide(MGR, rel["id"], approve=False, note="We need you")
        self.assertEqual(d.json()["status"], "declined")
        row = self._row(x)
        self.assertEqual((row.employee_email, row.open_slots), (A, 0))
        self.assertEqual(self._log(x), [])
        bells = dict(self._bells(A))
        self.assertIn("Shift request declined", bells)
        self.assertIn("We need you", bells["Shift request declined"])

    def test_the_schedule_moving_on_refuses_the_approval(self):
        self._settings(releaseShifts=True)
        x = self._shift(A)
        rel = self._ask(A, kind="release", shift_id=x).json()
        self.db.query(models.ScheduledShift).filter(models.ScheduledShift.id == x).update({"employee_email": B})
        self.db.commit()
        self.assertEqual(self._decide(MGR, rel["id"]).status_code, 409)
        self.assertEqual(self._row(x).employee_email, B)


class CrossTeamTests(_Case):
    def test_off_another_teams_slot_is_invisible_and_refused(self):
        ours = self._shift("", slots=1)
        theirs = self._shift("", slots=1, group=OTHER, start="10:00")
        self.assertEqual([(o["id"], o["team"], o["crossTeam"]) for o in self._open_for(A)], [(ours, "Crew", False)])
        r = self._ask(A, kind="open", shift_id=theirs)
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(r.json()["detail"], "That open shift belongs to another team.")

    def test_on_the_slot_shows_with_its_team_and_its_team_decides(self):
        self._settings(openShiftsAcrossTeams=True)
        ours = self._shift("", slots=1)
        theirs = self._shift("", slots=1, group=OTHER, start="10:00")
        self.assertEqual([(o["id"], o["team"], o["crossTeam"]) for o in self._open_for(A)],
                         [(ours, "Crew", False), (theirs, "Other Crew", True)])
        r = self._ask(A, kind="open", shift_id=theirs, note="Happy to help")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["team"], "Other Crew")
        # The slot's team scheduler is asked, not A's manager.
        self.assertEqual(self._titles(SCHED), ["Shift request to approve"])
        self.assertEqual(self._titles(MGR), [])
        # A's own (scoped) manager cannot decide it and does not see it; the
        # scheduler and an administrator can.
        self._as(MGR)
        self.assertEqual(self.client.get("/timeclock/shift-requests").json()["pending"], [])
        self.assertEqual(self._decide(MGR, r.json()["id"]).status_code, 403)
        self._as(SCHED)
        self.assertEqual([p["id"] for p in self.client.get("/timeclock/shift-requests").json()["pending"]], [r.json()["id"]])
        d = self._decide(SCHED, r.json()["id"])
        self.assertEqual(d.status_code, 200, d.text)
        self.assertEqual(d.json()["status"], "approved")
        self.assertIsNone(self._row(theirs))     # the last slot: the open row is gone
        self.db.expire_all()
        got = self.db.query(models.ScheduledShift).filter(models.ScheduledShift.employee_email == A).all()
        self.assertEqual([(g.work_date, g.start_hhmm, g.group_id, g.published) for g in got], [(DAY, "10:00", OTHER, 1)])
        self.assertIn("Shift request approved", self._titles(A))

    def test_a_team_with_no_scheduler_falls_to_its_company_managers(self):
        self._settings(openShiftsAcrossTeams=True)
        quiet = self._shift("", slots=1, group=NOBODY)
        r = self._ask(A, kind="open", shift_id=quiet)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._titles(CMGR), ["Shift request to approve"])
        self.assertEqual(self._titles(MGR), [])
        self.assertEqual(self._decide(MGR, r.json()["id"]).status_code, 403)
        self.assertEqual(self._decide(CMGR, r.json()["id"]).json()["status"], "approved")

    def test_a_team_with_nobody_to_decide_keeps_the_usual_approvers(self):
        self._settings(openShiftsAcrossTeams=True)
        self.db.query(models.HrEntity).filter(models.HrEntity.id == ENT).update({"manager_emails": [], "manager_email": ""})
        self.db.commit()
        quiet = self._shift("", slots=1, group=NOBODY)
        r = self._ask(A, kind="open", shift_id=quiet)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._titles(MGR), ["Shift request to approve"])
        self.assertEqual(self._decide(MGR, r.json()["id"]).json()["status"], "approved")

    def test_a_slot_of_another_company_never_shows(self):
        self._settings(openShiftsAcrossTeams=True)
        far = self._shift("", slots=1, group=FAR)
        self.assertEqual(self._open_for(A), [])
        self.assertEqual(self._ask(A, kind="open", shift_id=far).status_code, 403)
        # Its own member still sees it (their company has the switch off,
        # and it is their team either way).
        self.assertEqual([(o["id"], o["crossTeam"]) for o in self._open_for(D)], [(far, False)])

    def test_an_administrator_decides_any_cross_team_claim(self):
        self._settings(openShiftsAcrossTeams=True)
        theirs = self._shift("", slots=1, group=OTHER)
        r = self._ask(A, kind="open", shift_id=theirs).json()
        self._as(ADMIN)
        self.assertEqual([p["id"] for p in self.client.get("/timeclock/shift-requests").json()["pending"]], [r["id"]])
        self.assertEqual(self._decide(ADMIN, r["id"]).json()["status"], "approved")


if __name__ == "__main__":
    unittest.main()
