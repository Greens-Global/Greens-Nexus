"""The Shift Planner grant (Pranshu, 11/10/2026): an Access Group grant on
module "shifts" lets someone below Manager run the planner for the teams
they are named Scheduler on. Viewer reads, Editor builds and shares, Full
also clears / imports / changes members and acts as a manager inside
Shifts for their company's people (the top grant; Owner retired 11/12/2026). Never Time Sheets, labor, shift types
or Settings. Throwaway sqlite.

    python -m unittest test_shift_planner_grant -v
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

import auth       # noqa: E402
import cache      # noqa: E402
import database   # noqa: E402
import main       # noqa: E402
import models     # noqa: E402

ENT, ENT2 = "ent-spg", "ent-spg2"
CONSTR, OTHERG, GRANT = "grp-spg-constr", "grp-spg-other", "grant-spg"
BOSS = "spg.boss@greensglobal.com"     # Super Administrator
SEJ = "spg.sej@greensglobal.com"       # employee, Construction's Scheduler
C1 = "spg.c1@greensglobal.com"         # Construction members
C2 = "spg.c2@greensglobal.com"
OTH = "spg.oth@greensglobal.com"       # same company, another team
OUT = "spg.out@greensglobal.com"       # another company
DAY = (datetime.now(timezone.utc).date() + timedelta(days=10)).isoformat()
DENIED = "Only managers and above can change shifts."


class ShiftPlannerGrantTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)

    def setUp(self):
        db = database.SessionLocal()
        try:
            for t in (models.ScheduledShift, models.ShiftRequest, models.ShiftGroupMember, models.ShiftGroup,
                      models.NexusGroupMember, models.NexusGroup, models.NexusRole, models.NexusEmployee,
                      models.NexusSetting, models.NexusNotification, models.Shift):
                db.query(t).delete(synchronize_session=False)
            for em, co in ((BOSS, ENT), (SEJ, ENT), (C1, ENT), (C2, ENT), (OTH, ENT), (OUT, ENT2)):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=em.split(".")[1].upper(), last_name="X",
                                            work_email=em, status="active", deleted_at="", company=co))
            db.add(models.NexusRole(email=BOSS, role="owner", assigned_by="test"))
            db.add(models.ShiftGroup(id=CONSTR, name="Construction", scheduler_emails=json.dumps([SEJ])))
            db.add(models.ShiftGroup(id=OTHERG, name="Other"))
            for i, (g, em) in enumerate(((CONSTR, C1), (CONSTR, C2), (OTHERG, OTH), (OTHERG, OUT))):
                db.add(models.ShiftGroupMember(id=f"sgm-spg-{i}", group_id=g, employee_email=em))
            db.add(models.NexusSetting(key="shift_requests_config",
                                       value=json.dumps({"openShifts": True, "swaps": True, "offers": True})))
            db.commit()
        finally:
            db.close()
        self._refresh()

    def _refresh(self):
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def _grant(self, level):
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GRANT, name="Shift Planner", allowed_modules=f"shifts:{level}"))
            db.add(models.NexusGroupMember(group_id=GRANT, email=SEJ))
            db.commit()
        finally:
            db.close()
        self._refresh()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _add(self, who, start="09:00"):
        return self.client.post("/timeclock/schedule", json={"employee_email": who, "work_date": DAY,
                                                             "start_hhmm": start, "end_hhmm": "17:00"})

    def _grid(self):
        r = self.client.get(f"/timeclock/schedule?start={DAY}&end={DAY}")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _members(self, group, add):
        return self.client.post(f"/timeclock/shift-groups/{group}/members", json={"add": [add]})

    def test_a_scheduler_without_the_grant_stays_read_only(self):
        self._as(SEJ)
        self.assertEqual(self._add(C1).status_code, 403)
        grid = self._grid()
        self.assertFalse(grid["canManage"])
        self.assertEqual(grid["shiftGrant"], 0)

    def test_viewer_reads_the_planner_and_changes_nothing(self):
        self._grant("viewer")
        self._as(SEJ)
        grid = self._grid()
        self.assertFalse(grid["canManage"])
        self.assertEqual(grid["shiftGrant"], 1)
        r = self._add(C1)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["detail"], DENIED)

    def test_editor_builds_and_shares_their_teams_only(self):
        self._grant("editor")
        self._as(SEJ)
        r = self._add(C1)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._add(OTH).status_code, 403)          # not their team
        self.assertEqual(self.client.post("/timeclock/schedule/publish",
                                          json={"start_date": DAY, "end_date": DAY}).status_code, 200)
        grid = self._grid()
        self.assertTrue(grid["canManage"])
        self.assertEqual(grid["shiftGrant"], 2)
        self.assertFalse({g["id"]: g["canEdit"] for g in grid["groups"]}.get(CONSTR, False))
        # Full-only, manager-only and never-the-grant actions.
        self.assertEqual(self.client.post("/timeclock/schedule/clear",
                                          json={"start_date": DAY, "end_date": DAY}).status_code, 403)
        self.assertEqual(self.client.post("/timeclock/schedule/import", json={"rows": [{"email": C1, "date": DAY,
                                          "start": "09:00", "end": "10:00"}]}).status_code, 403)
        self.assertEqual(self._members(CONSTR, OTH).status_code, 403)
        self.assertEqual(self.client.get(f"/timeclock/schedule/labor?start={DAY}&end={DAY}").status_code, 403)
        self.assertEqual(self.client.get("/timeclock/shift-requests").json()["pending"], [])
        # Team-wide things only on their own team; no new Construction projects.
        note = lambda gid: self.client.put("/timeclock/schedule/day-note", json={"work_date": DAY, "group_id": gid, "note": "x"})  # noqa: E731
        self.assertEqual(note(CONSTR).status_code, 200)
        self.assertEqual(note(OTHERG).status_code, 403)
        self.assertEqual(note("").status_code, 403)
        self.assertEqual(self.client.post("/timeclock/jobsites", json={"name": "Spg Site", "address": "1 Main St"}).status_code, 403)

    def test_an_hr_grant_never_widens_a_shift_planner_editor(self):
        self._grant("editor")
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id="grant-spg-hr", name="HR", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id="grant-spg-hr", email=SEJ))
            db.commit()
        finally:
            db.close()
        self._refresh()
        self._as(SEJ)
        self.assertEqual(self._add(C1).status_code, 200)
        self.assertEqual(self._add(OTH).status_code, 403)

    def test_full_clears_imports_and_changes_their_teams(self):
        self._grant("full")
        self._as(SEJ)
        self.assertEqual(self._add(C1).status_code, 200)
        self.assertEqual(self.client.post("/timeclock/schedule/clear",
                                          json={"start_date": DAY, "end_date": DAY}).status_code, 200)
        imp = self.client.post("/timeclock/schedule/import", json={"rows": [{"row": 2, "email": C2, "date": DAY,
                                                                             "start": "09:00", "end": "10:00"}]})
        self.assertEqual(imp.status_code, 200, imp.text)
        self.assertEqual(imp.json()["created"], 1)
        self.assertTrue({g["id"]: g["canEdit"] for g in self._grid()["groups"]}[CONSTR])
        self.assertEqual(self._members(CONSTR, OTH).status_code, 200)
        self.assertEqual(self._members(OTHERG, C1).status_code, 403)   # not their team
        self.assertEqual(self._members(CONSTR, OUT).status_code, 403)  # another company
        self.assertEqual(self.client.patch(f"/timeclock/shift-groups/{CONSTR}/meta",
                                           json={"name": "Renamed"}).status_code, 200)   # Full is the top grant (Owner retired 11/12/2026)

    def test_full_acts_as_a_manager_inside_shifts_for_their_company(self):
        self._grant("full")
        self._as(SEJ)
        self.assertEqual(self._add(OTH).status_code, 200)        # their company, another team
        self.assertEqual(self._add(OUT).status_code, 403)        # another company
        self.assertEqual(self.client.patch(f"/timeclock/shift-groups/{CONSTR}/meta",
                                           json={"name": "Construction Crew"}).status_code, 200)
        # Still never shift types, Settings, labor or Time Sheets.
        self.assertEqual(self.client.post("/timeclock/shifts", json={"name": "Spg Type", "start_hhmm": "09:00",
                                                                     "end_hhmm": "17:00"}).status_code, 403)
        self.assertEqual(self.client.put("/timeclock/shift-requests/settings", json={"swaps": False}).status_code, 403)
        self.assertEqual(self.client.get(f"/timeclock/schedule/labor?start={DAY}&end={DAY}").status_code, 403)
        self.assertIn(self.client.get("/timeclock/team").status_code, (401, 403))

    def test_only_a_full_grant_decides_a_swap(self):
        self._as(BOSS)
        sid = self._add(C1).json()["id"]
        self.client.post("/timeclock/schedule/publish", json={"start_date": DAY, "end_date": DAY})
        self._as(C1)
        ask = self.client.post("/timeclock/shift-requests", json={"kind": "offer", "shift_id": sid, "target_email": C2})
        self.assertEqual(ask.status_code, 200, ask.text)
        rid = ask.json()["id"]
        self._as(C2)
        self.assertEqual(self.client.post(f"/timeclock/shift-requests/{rid}/respond", json={"accept": True}).status_code, 200)
        self._grant("editor")
        self._as(SEJ)
        self.assertEqual(self.client.post(f"/timeclock/shift-requests/{rid}/decide", json={"approve": True}).status_code, 403)
        db = database.SessionLocal()
        try:
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GRANT).update({"allowed_modules": "shifts:full"})
            db.commit()
        finally:
            db.close()
        self._refresh()
        self.assertIn(rid, [r["id"] for r in self.client.get("/timeclock/shift-requests").json()["pending"]])
        self.assertEqual(self.client.post(f"/timeclock/shift-requests/{rid}/decide", json={"approve": True}).status_code, 200)


if __name__ == "__main__":
    unittest.main()
