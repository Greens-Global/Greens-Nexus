"""
Shifts Phase 0 - the company dimension (Neil, Oct 14 2026).

  - Shift types (presets) and shift groups carry an HrEntity company_id;
    '' = shared with every company. Changing one needs company-wide access,
    or access limited to exactly that company (timeclock._require_company_manage)
    - a plain manager can no longer edit or delete a preset every company's
    shifts point at. An EXISTING shared one is owned by use: a company-limited
    administrator may change it when everyone on it is in their company (or
    nobody is); creating a shared one, and the tenant settings, stay
    company-wide only. A company-limited caller's '' company is their own.
  - GET /timeclock/shifts says whether the caller may manage types at all
    (canManage) so the screen can hide New / Edit / Delete.
  - Usual hours skip out-of-scope people quietly, then refuse a company's
    shift type on another company's person (or an untagged one, saying so).
  - A company's settings override stores only what differs from the tenant.
  - The shift-type list is cut to the shared ones plus the caller's companies,
    and says which companies the caller may pick from.
  - Usual hours refuse a company's shift type on another company's person.
  - Shift settings layer defaults <- tenant row <- a per-company override
    (shift_requests.get_settings / settings_for); trading (open shifts,
    swaps, offers) is OFF by default; defaultGraceMin round-trips, clamped.

A "company-scoped admin" here is an administrator who is NOT a Global Admin
while the company walls are on (auth.company_scope) - the one way the auth
model yields a plain company set to a caller who may manage shifts (a
manager with a People grant is always team-limited, Oct 6 / Oct 12).

Throwaway sqlite. Run with: python -m unittest test_shift_company -v
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

import auth           # noqa: E402
import cache          # noqa: E402
import database       # noqa: E402
import main           # noqa: E402
import models         # noqa: E402
from routers import shift_requests   # noqa: E402

BOSS = "sco.boss@greensglobal.com"      # administrator, Global Admin: company-wide
ADMIN_A = "sco.admina@greensglobal.com"  # administrator of company A only (walls on)
MGR = "sco.mgr@greensglobal.com"        # a plain manager in company A
A = "sco.a@greensglobal.com"            # company A, reports to MGR
B = "sco.b@greensglobal.com"            # company B
CO_A, CO_B = "co-sco-a", "co-sco-b"
P_SHARED, P_A, P_B = "preset-sco-shared", "preset-sco-a", "preset-sco-b"
GROUP, GA_GROUP = "group-sco", "group-sco-ga"
DAY = (datetime.now(timezone.utc).date() + timedelta(days=10)).isoformat()
SETTINGS = "/timeclock/shift-requests/settings"


class ShiftCompanyTests(unittest.TestCase):
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
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        db = database.SessionLocal()
        try:
            for m in (models.NexusRole, models.NexusEmployee, models.NexusGroup, models.NexusGroupMember,
                      models.HrEntity, models.Shift, models.ShiftGroup, models.ShiftGroupMember,
                      models.ShiftAssignment, models.ScheduledShift, models.ShiftRequest,
                      models.NexusNotification, models.NexusSetting):
                db.query(m).delete()
            company = {BOSS: "", ADMIN_A: CO_A, MGR: CO_A, A: CO_A, B: CO_B}
            for em in (BOSS, ADMIN_A, MGR, A, B):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=em.split(".")[1].upper(), last_name="X",
                                            work_email=em, status="active", deleted_at="", company=company[em],
                                            manager_email=MGR if em == A else ""))
            for em in (BOSS, ADMIN_A):
                db.add(models.NexusRole(email=em, role="administrator", assigned_by="test"))
            db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
            db.add(models.HrEntity(id=CO_A, name="Alpha Co"))
            db.add(models.HrEntity(id=CO_B, name="Beta Co"))
            for pid, cid in ((P_SHARED, ""), (P_A, CO_A), (P_B, CO_B)):
                db.add(models.Shift(id=pid, name=f"Type {pid[-1].upper()}", code=pid[-1].upper(), start_hhmm="09:00",
                                    end_hhmm="17:00", days="1,2,3,4,5", color="#2563eb",
                                    timezone="America/Los_Angeles", company_id=cid))
            db.add(models.ShiftGroup(id=GROUP, name="Store"))
            for i, em in enumerate((A, B)):
                db.add(models.ShiftGroupMember(id=f"sgm-sco-{i}", group_id=GROUP, employee_email=em))
            db.commit()
        finally:
            db.close()
        self._flush()
        self._as(BOSS)

    def tearDown(self):
        self._walls(False)
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        self._flush()

    # ── helpers ───────────────────────────────────────────────────────────
    def _flush(self):
        cache.module_grants.invalidate()
        cache.settings_config.invalidate()
        auth.invalidate_role_cache()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _walls(self, on=True):
        """Arm the company walls with BOSS as the one Global Admin, so ADMIN_A
        becomes an administrator confined to company A."""
        db = database.SessionLocal()
        try:
            row = db.query(models.NexusSetting).filter(models.NexusSetting.key == "company_walls").first()
            if not row:
                row = models.NexusSetting(key="company_walls")
                db.add(row)
            row.value = "on" if on else ""
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GA_GROUP).delete()
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GA_GROUP).delete()
            if on:
                db.add(models.NexusGroup(id=GA_GROUP, name="Global Admins", is_global_admin=1))
                db.add(models.NexusGroupMember(group_id=GA_GROUP, email=BOSS))
            db.commit()
        finally:
            db.close()
        self._flush()

    def _preset_body(self, **extra):
        return {"name": "Changed", "start_hhmm": "08:00", "end_hhmm": "16:00", **extra}

    def _ids(self, company=""):
        r = self.client.get(f"/timeclock/shifts{'?company=' + company if company else ''}")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _published(self, email, sid, shift_id="", group_id=GROUP):
        db = database.SessionLocal()
        try:
            db.add(models.ScheduledShift(id=sid, employee_email=email, work_date=DAY, start_hhmm="09:00",
                                         end_hhmm="17:00", published=1, created_by=BOSS, group_id=group_id,
                                         shift_id=shift_id, created_at="2026-10-14T00:00:00"))
            db.commit()
        finally:
            db.close()

    def _assigned(self, email, shift_id):
        db = database.SessionLocal()
        try:
            db.query(models.ShiftAssignment).filter(models.ShiftAssignment.employee_email == email).delete()
            db.add(models.ShiftAssignment(id=f"sa-sco-{email}", employee_email=email, shift_id=shift_id,
                                          assigned_by=BOSS, assigned_at="2026-10-14T00:00:00"))
            db.commit()
        finally:
            db.close()

    def _saved_override(self, company):
        db = database.SessionLocal()
        try:
            return shift_requests._saved_settings(db, company)
        finally:
            db.close()

    # ── Presets: who may change what ──────────────────────────────────────
    def test_a_plain_manager_cannot_add_edit_or_delete_shift_types(self):
        self._as(MGR)
        created = self.client.post("/timeclock/shifts", json=self._preset_body(name="Mgr Type"))
        self.assertEqual(created.status_code, 403, created.text)
        self.assertEqual(created.json()["detail"], "Adding a shift type needs company-wide access")
        for pid in (P_SHARED, P_A, P_B):
            self.assertEqual(self.client.patch(f"/timeclock/shifts/{pid}", json=self._preset_body()).status_code, 403, pid)
            self.assertEqual(self.client.delete(f"/timeclock/shifts/{pid}").status_code, 403, pid)
        # Nothing moved.
        self.assertEqual({s["id"]: s["name"] for s in self._ids()["shifts"]},
                         {P_SHARED: "Type D", P_A: "Type A"})

    def test_a_company_admin_edits_their_own_companys_types_only(self):
        self._assigned(B, P_SHARED)   # the shared type is in use by company B: not Alpha's to change
        self._walls(True)
        self._as(ADMIN_A)
        ok = self.client.patch(f"/timeclock/shifts/{P_A}", json=self._preset_body(name="Alpha Day"))
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual((ok.json()["name"], ok.json()["companyId"]), ("Alpha Day", CO_A))
        shared = self.client.patch(f"/timeclock/shifts/{P_SHARED}", json=self._preset_body())
        self.assertEqual(shared.status_code, 403)
        self.assertEqual(shared.json()["detail"], "Editing this shift type needs company-wide access")
        self.assertEqual(self.client.patch(f"/timeclock/shifts/{P_B}", json=self._preset_body()).status_code, 403)
        self.assertEqual(self.client.delete(f"/timeclock/shifts/{P_SHARED}").status_code, 403)
        self.assertEqual(self.client.delete(f"/timeclock/shifts/{P_B}").status_code, 403)
        # A new type lands on their company by default - also when the client
        # sends '' (an older screen always does); another company's is refused.
        new = self.client.post("/timeclock/shifts", json=self._preset_body(name="Alpha Night"))
        self.assertEqual(new.status_code, 200, new.text)
        self.assertEqual(new.json()["companyId"], CO_A)
        blank = self.client.post("/timeclock/shifts", json=self._preset_body(name="S", company_id=""))
        self.assertEqual(blank.status_code, 200, blank.text)
        self.assertEqual(blank.json()["companyId"], CO_A)
        self.assertEqual(self.client.post("/timeclock/shifts", json=self._preset_body(name="S", company_id=CO_B)).status_code, 403)
        # '' on an edit of their own type is their own company too: it stays put.
        kept = self.client.patch(f"/timeclock/shifts/{P_A}", json=self._preset_body(company_id=""))
        self.assertEqual(kept.status_code, 200, kept.text)
        self.assertEqual(kept.json()["companyId"], CO_A)
        self.assertEqual(self.client.patch(f"/timeclock/shifts/{P_A}", json=self._preset_body(company_id=CO_B)).status_code, 403)
        self.assertEqual(self.client.delete(f"/timeclock/shifts/{P_A}").status_code, 200)
        # The tenant settings stay company-wide only.
        tenant = self.client.put(SETTINGS, json={"swaps": True})
        self.assertEqual(tenant.status_code, 403)
        self.assertEqual(tenant.json()["detail"], "Changing shift settings needs company-wide access")
        # The Global Admin still changes a shared type, and may tag one to a company.
        self._as(BOSS)
        r = self.client.patch(f"/timeclock/shifts/{P_SHARED}", json=self._preset_body(name="Everyone", company_id=CO_B))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["companyId"], CO_B)
        self.assertEqual(self.client.post("/timeclock/shifts", json=self._preset_body(name="X", company_id="nope")).status_code, 400)

    def test_a_shared_type_or_group_is_owned_by_the_people_on_it(self):
        """The migration left every preset shared ('') - a company
        administrator must still be able to change the ones only their
        people use, or nobody uses."""
        self._walls(True)
        self._as(ADMIN_A)
        # Nobody on it: theirs to change.
        ok = self.client.patch(f"/timeclock/shifts/{P_SHARED}", json=self._preset_body(name="Everyone"))
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(ok.json()["companyId"], "")   # still shared - editing does not claim it
        # Only company A's people on it (usual hours and a placement): still theirs.
        self._assigned(A, P_SHARED)
        self._published(A, "ss-sco-a-shared", shift_id=P_SHARED)
        self.assertEqual(self.client.patch(f"/timeclock/shifts/{P_SHARED}", json=self._preset_body(name="Alpha Uses")).status_code, 200)
        # Someone from company B placed on it: no longer theirs.
        self._published(B, "ss-sco-b-shared", shift_id=P_SHARED)
        refused = self.client.patch(f"/timeclock/shifts/{P_SHARED}", json=self._preset_body(name="Nope"))
        self.assertEqual(refused.status_code, 403)
        self.assertEqual(refused.json()["detail"], "Editing this shift type needs company-wide access")
        self.assertEqual(self.client.delete(f"/timeclock/shifts/{P_SHARED}").status_code, 403)
        db = database.SessionLocal()
        try:
            db.query(models.ScheduledShift).filter(models.ScheduledShift.id == "ss-sco-b-shared").delete()
            db.commit()
        finally:
            db.close()
        self.assertEqual(self.client.delete(f"/timeclock/shifts/{P_SHARED}").status_code, 200)
        # A plain manager has no company to own anything by: still refused.
        self._walls(False)
        self._as(MGR)
        self.assertEqual(self.client.patch(f"/timeclock/shifts/{P_A}", json=self._preset_body()).status_code, 403)
        # Groups follow the same rule: the Store group holds A and B (403);
        # a shared group with only A, or nobody, is Alpha's to change.
        self._as(BOSS)
        mine = self.client.post("/timeclock/shift-groups", json={"name": "Alpha Only", "members": [A], "company_id": ""}).json()["id"]
        empty = self.client.post("/timeclock/shift-groups", json={"name": "Nobody Yet", "members": [], "company_id": ""}).json()["id"]
        self._walls(True)
        self._as(ADMIN_A)
        self.assertEqual(self.client.patch(f"/timeclock/shift-groups/{GROUP}", json={"name": "Store 2", "members": [A]}).status_code, 403)
        self.assertEqual(self.client.delete(f"/timeclock/shift-groups/{GROUP}").status_code, 403)
        self.assertEqual(self.client.patch(f"/timeclock/shift-groups/{mine}", json={"name": "Alpha Only 2", "members": [A]}).status_code, 200)
        self.assertEqual(self.client.delete(f"/timeclock/shift-groups/{empty}").status_code, 200)
        # A company B placement under the group makes it B's too.
        self._published(B, "ss-sco-b-grouped", group_id=mine)
        self.assertEqual(self.client.delete(f"/timeclock/shift-groups/{mine}").status_code, 403)

    # ── Lists ─────────────────────────────────────────────────────────────
    def test_the_shift_type_list_says_who_may_manage(self):
        self.assertTrue(self._ids()["canManage"])            # Global Admin: company-wide
        self._as(MGR)
        self.assertFalse(self._ids()["canManage"])           # a plain manager: nothing to manage
        self._walls(True)
        self._as(ADMIN_A)
        self.assertTrue(self._ids()["canManage"])            # one company is enough

    def test_the_shift_type_list_is_cut_to_the_callers_companies(self):
        boss = self._ids()
        self.assertEqual(sorted(s["id"] for s in boss["shifts"]), sorted([P_SHARED, P_A, P_B]))
        self.assertEqual([c["id"] for c in boss["companies"]], [CO_A, CO_B])
        self.assertTrue(boss["canPickCompany"])
        self.assertEqual([s["id"] for s in self._ids(CO_B)["shifts"]], [P_B, P_SHARED])   # that company's plus shared
        # A plain manager sees the shared types and those of the people on
        # their team (A, in company A) - never company B's.
        self._as(MGR)
        mgr = self._ids()
        self.assertEqual(sorted(s["id"] for s in mgr["shifts"]), sorted([P_SHARED, P_A]))
        self.assertEqual(([c["id"] for c in mgr["companies"]], mgr["canPickCompany"]), ([CO_A], False))
        self.assertEqual(self.client.get(f"/timeclock/shifts?company={CO_B}").status_code, 403)
        # A company admin (walls on) sees exactly their company plus shared.
        self._walls(True)
        self._as(ADMIN_A)
        adm = self._ids()
        self.assertEqual(sorted(s["id"] for s in adm["shifts"]), sorted([P_SHARED, P_A]))
        self.assertEqual([c["id"] for c in adm["companies"]], [CO_A])
        self.assertFalse(adm["canPickCompany"])

    # ── Groups ────────────────────────────────────────────────────────────
    def test_the_group_list_is_cut_to_the_callers_companies(self):
        """Like the shift types: shared groups and the caller's companies'
        only - a company-limited caller never learns another company's
        team by name (QA, Oct 15)."""
        for name, cid in (("Alpha Crew", CO_A), ("Beta Crew", CO_B)):
            self.assertEqual(self.client.post("/timeclock/shift-groups", json={"name": name, "members": [], "company_id": cid}).status_code, 200)
        names = lambda: sorted(g["name"] for g in self.client.get("/timeclock/shift-groups").json()["groups"])   # noqa: E731
        self.assertEqual(names(), ["Alpha Crew", "Beta Crew", "Store"])
        self._as(MGR)
        self.assertEqual(names(), ["Alpha Crew", "Store"], "a manager: the shared ones and their team's company")
        self._walls(True)
        self._as(ADMIN_A)
        self.assertEqual(names(), ["Alpha Crew", "Store"])
        self._as(BOSS)
        self.assertEqual(names(), ["Alpha Crew", "Beta Crew", "Store"])

    def test_groups_carry_a_company_and_follow_the_same_guard(self):
        made = self.client.post("/timeclock/shift-groups", json={"name": "Alpha Crew", "members": [A], "company_id": CO_A})
        self.assertEqual(made.status_code, 200, made.text)
        self.assertEqual(made.json()["companyId"], CO_A)
        listed = self.client.get("/timeclock/shift-groups").json()
        self.assertEqual({g["id"]: g["companyId"] for g in listed["groups"]}, {GROUP: "", made.json()["id"]: CO_A})
        self.assertEqual([c["id"] for c in listed["companies"]], [CO_A, CO_B])
        self.assertTrue(listed["canManageGroups"])
        self._as(MGR)
        self.assertEqual(self.client.post("/timeclock/shift-groups", json={"name": "Mine", "members": [A]}).status_code, 403)
        self.assertEqual(self.client.patch(f"/timeclock/shift-groups/{GROUP}", json={"name": "Store 2", "members": [A]}).status_code, 403)
        self._walls(True)
        self._as(ADMIN_A)
        gid = made.json()["id"]
        self.assertEqual(self.client.patch(f"/timeclock/shift-groups/{gid}", json={"name": "Alpha Crew 2", "members": [A]}).status_code, 200)
        shared = self.client.patch(f"/timeclock/shift-groups/{GROUP}", json={"name": "Store 2", "members": [A]})
        self.assertEqual(shared.status_code, 403)
        self.assertEqual(shared.json()["detail"], "Managing shift groups needs company-wide access")
        self.assertEqual(self.client.delete(f"/timeclock/shift-groups/{GROUP}").status_code, 403)
        self.assertEqual(self.client.delete(f"/timeclock/shift-groups/{gid}").status_code, 200)
        new = self.client.post("/timeclock/shift-groups", json={"name": "Alpha Crew 3", "members": [A]})
        self.assertEqual(new.status_code, 200, new.text)
        self.assertEqual(new.json()["companyId"], CO_A)   # a company admin's new group is their company's

    # ── Usual hours ───────────────────────────────────────────────────────
    def test_usual_hours_refuse_another_companys_shift_type(self):
        bad = self.client.post("/timeclock/shift-assign", json={"shift_id": P_B, "emails": [A]})
        self.assertEqual(bad.status_code, 400)
        # Named by their People name, never the raw email.
        self.assertEqual(bad.json()["detail"], "A@GREENSGLOBAL X is not in the company this shift type belongs to.")
        # An untagged person is told what to do, not just refused.
        untagged = self.client.post("/timeclock/shift-assign", json={"shift_id": P_A, "emails": [BOSS]})
        self.assertEqual(untagged.status_code, 400)
        self.assertEqual(untagged.json()["detail"], "BOSS@GREENSGLOBAL X is not in a company yet - set it in People first.")
        self.assertEqual(self.client.post("/timeclock/shift-assign", json={"shift_id": P_A, "emails": [A]}).json()["assigned"], 1)
        self.assertEqual(self.client.post("/timeclock/shift-assign", json={"shift_id": P_SHARED, "emails": [A, B]}).json()["assigned"], 2)
        self.assertEqual(self.client.post("/timeclock/shift-assign", json={"shift_id": "", "emails": [A, B]}).json()["assigned"], 2)
        # Someone outside the caller's scope (B is not on MGR's team) is
        # skipped quietly, as always - never a 400 about their company.
        self._as(MGR)
        r = self.client.post("/timeclock/shift-assign", json={"shift_id": P_A, "emails": [A, B]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["assigned"], 1)

    # ── Settings ──────────────────────────────────────────────────────────
    def test_company_settings_override_the_tenant_row_and_delete_restores_it(self):
        tenant = self.client.put(SETTINGS, json={"swaps": True, "timeZone": "Asia/Kolkata"})
        self.assertEqual(tenant.status_code, 200, tenant.text)
        self.assertEqual((tenant.json()["swaps"], tenant.json()["companyId"], tenant.json()["hasOverride"]), (True, "", False))
        before = self.client.get(f"{SETTINGS}?company={CO_A}").json()
        self.assertEqual((before["swaps"], before["timeZone"], before["companyId"], before["hasOverride"]),
                         (True, "Asia/Kolkata", CO_A, False))
        self.assertEqual([c["id"] for c in before["companies"]], [CO_A, CO_B])
        self.assertTrue(before["canPickCompany"])
        over = self.client.put(f"{SETTINGS}?company={CO_A}", json={"swaps": False, "weekStart": "Sunday"})
        self.assertEqual(over.status_code, 200, over.text)
        self.assertEqual((over.json()["swaps"], over.json()["weekStart"], over.json()["timeZone"], over.json()["hasOverride"]),
                         (False, "sunday", "Asia/Kolkata", True))
        self.assertTrue(self.client.get(SETTINGS).json()["swaps"])          # the tenant row is untouched
        db = database.SessionLocal()
        try:
            self.assertFalse(shift_requests.settings_for(db, A)["swaps"])    # company A's person
            self.assertTrue(shift_requests.settings_for(db, B)["swaps"])     # company B follows the tenant
            self.assertTrue(shift_requests.settings_for(db, BOSS)["swaps"])  # untagged follows the tenant
            # The override keeps only the keys it set: a later tenant change flows through.
            self.client.put(SETTINGS, json={"timeZone": "America/New_York"})
            self.assertEqual(shift_requests.get_settings(db, CO_A)["timeZone"], "America/New_York")
            self.assertEqual(shift_requests.get_settings(db, CO_A)["weekStart"], "sunday")
        finally:
            db.close()
        self.assertEqual(self.client.delete(SETTINGS).status_code, 400)       # the tenant row cannot be removed
        self.assertEqual(self.client.get(f"{SETTINGS}?company=nope").status_code, 404)
        gone = self.client.delete(f"{SETTINGS}?company={CO_A}")
        self.assertEqual(gone.status_code, 200, gone.text)
        self.assertEqual((gone.json()["swaps"], gone.json()["weekStart"], gone.json()["hasOverride"]), (True, "monday", False))
        # A plain manager changes no company's settings; a company admin only their own.
        self._as(MGR)
        self.assertEqual(self.client.put(f"{SETTINGS}?company={CO_A}", json={"swaps": True}).status_code, 403)
        self._walls(True)
        self._as(ADMIN_A)
        self.assertEqual(self.client.put(f"{SETTINGS}?company={CO_A}", json={"swaps": True}).status_code, 200)
        refused = self.client.put(f"{SETTINGS}?company={CO_B}", json={"swaps": True})
        self.assertEqual(refused.status_code, 403)
        self.assertEqual(refused.json()["detail"], "Changing this company's shift settings needs company-wide access")
        self.assertEqual(self.client.delete(f"{SETTINGS}?company={CO_B}").status_code, 403)
        mine = self.client.get(f"{SETTINGS}?company={CO_A}").json()
        self.assertEqual(([c["id"] for c in mine["companies"]], mine["canPickCompany"]), ([CO_A], False))
        # Another company's settings are not theirs to READ either: across the
        # wall a company does not exist (QA, Oct 15 - the read used to answer).
        self.assertEqual(self.client.get(f"{SETTINGS}?company={CO_B}").status_code, 404)
        self.assertEqual(self.client.get(SETTINGS).status_code, 200, "the tenant row still reads (it is their fallback)")
        self._as(BOSS)
        self.assertEqual(self.client.get(f"{SETTINGS}?company={CO_B}").status_code, 200, "a Global Admin reads every company")

    def test_a_company_override_keeps_only_what_differs_from_the_tenant(self):
        self.client.put(SETTINGS, json={"swaps": True, "timeZone": "Asia/Kolkata"})
        # The whole form sent for a company (what the first screen did) pins
        # only the key that differs.
        over = self.client.put(f"{SETTINGS}?company={CO_A}",
                               json={"swaps": False, "openShifts": False, "timeZone": "Asia/Kolkata", "weekStart": "monday",
                                     "defaultGraceMin": 10})
        self.assertEqual(over.status_code, 200, over.text)
        self.assertTrue(over.json()["hasOverride"])
        self.assertEqual(self._saved_override(CO_A), {"swaps": False})
        # A different key changed on the tenant flows through to the company.
        self.client.put(SETTINGS, json={"timeZone": "America/New_York", "weekStart": "sunday", "defaultGraceMin": 25})
        mine = self.client.get(f"{SETTINGS}?company={CO_A}").json()
        self.assertEqual((mine["swaps"], mine["timeZone"], mine["weekStart"], mine["defaultGraceMin"]),
                         (False, "America/New_York", "sunday", 25))
        # Setting the one key back to the tenant's value shrinks the override away.
        back = self.client.put(f"{SETTINGS}?company={CO_A}", json={"swaps": True})
        self.assertEqual((back.json()["swaps"], back.json()["hasOverride"]), (True, False))
        self.assertEqual(self._saved_override(CO_A), {})
        # A stored key that the tenant later catches up with is dropped on the next save.
        self.client.put(f"{SETTINGS}?company={CO_A}", json={"weekStart": "monday"})
        self.assertEqual(self._saved_override(CO_A), {"weekStart": "monday"})
        self.client.put(SETTINGS, json={"weekStart": "monday"})
        self.client.put(f"{SETTINGS}?company={CO_A}", json={"offers": True})
        self.assertEqual(self._saved_override(CO_A), {"offers": True})

    def test_trading_is_off_until_the_switch_is_on(self):
        cfg = self.client.get(SETTINGS).json()
        self.assertEqual((cfg["openShifts"], cfg["swaps"], cfg["offers"]), (False, False, False))
        self._published(A, "ss-sco-a")
        self._published(B, "ss-sco-b")
        self._as(A)
        ask = {"kind": "swap", "shift_id": "ss-sco-a", "target_email": B, "target_shift_id": "ss-sco-b"}
        refused = self.client.post("/timeclock/shift-requests", json=ask)
        self.assertEqual(refused.status_code, 403, refused.text)
        self.assertEqual(refused.json()["detail"], "Swap requests are turned off.")
        self.assertEqual(self.client.get(f"/timeclock/shift-requests/mine?start={DAY}&end={DAY}").json()["openShifts"], [])
        self._as(BOSS)
        self.assertTrue(self.client.put(SETTINGS, json={"swaps": True}).json()["swaps"])
        self._as(A)
        self.assertEqual(self.client.post("/timeclock/shift-requests", json=ask).status_code, 200)
        # Company B can have it off again while the tenant keeps it on.
        self._as(BOSS)
        self.client.put(f"{SETTINGS}?company={CO_B}", json={"swaps": False})
        self._as(B)
        self.assertEqual(self.client.post("/timeclock/shift-requests", json={"kind": "swap", "shift_id": "ss-sco-b",
                                                                              "target_email": A, "target_shift_id": "ss-sco-a"}).status_code, 403)

    def test_default_grace_round_trips_and_clamps(self):
        self.assertEqual(self.client.get(SETTINGS).json()["defaultGraceMin"], 10)
        self.assertEqual(self.client.put(SETTINGS, json={"defaultGraceMin": 25}).json()["defaultGraceMin"], 25)
        self.assertEqual(self.client.get(SETTINGS).json()["defaultGraceMin"], 25)
        self.assertEqual(self.client.put(SETTINGS, json={"defaultGraceMin": 500}).json()["defaultGraceMin"], 120)
        self.assertEqual(self.client.put(SETTINGS, json={"defaultGraceMin": -3}).json()["defaultGraceMin"], 0)
        self.assertEqual(self.client.put(f"{SETTINGS}?company={CO_A}", json={"defaultGraceMin": 15}).json()["defaultGraceMin"], 15)
        db = database.SessionLocal()
        try:
            self.assertEqual(shift_requests.get_settings(db)["defaultGraceMin"], 0)
            self.assertEqual(shift_requests.get_settings(db, CO_A)["defaultGraceMin"], 15)
            self.assertEqual(shift_requests.settings_for(db, A)["defaultGraceMin"], 15)
            # A broken stored value falls back rather than breaking the read.
            row = db.query(models.NexusSetting).filter(models.NexusSetting.key == "shift_requests_config").first()
            row.value = json.dumps({"defaultGraceMin": "lots", "swaps": True})
            db.commit()
            self.assertEqual((shift_requests.get_settings(db)["defaultGraceMin"], shift_requests.get_settings(db)["swaps"]), (10, True))
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
