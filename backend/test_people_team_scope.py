"""Managers see their own team in People (Pranshu, 10/06).

The MANAGER tier holding the People grant sees only the people below them in
the reporting line - direct reports, their reports, all the way
down - in People (list + Overview / Assets / Work Mode / Access / Work Logs,
read only) and Time. Never pay, not even with the Compensation grant. Every
other /hr route answers 403 (an allowlist, so a People route added later is
closed until someone lists it); someone outside the team answers 404.

    python -m unittest test_people_team_scope -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import timeclock  # noqa: E402
from routers import hr as HR  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
VAL = "valinda" + D            # manager tier + People grant
MID = "mia.mid" + D            # reports to Valinda
LOW = "leo.low" + D            # reports to Mia - two levels down
OUT = "olga.out" + D           # reports to someone else
PEER = "pat.peer" + D          # supervisor tier + People grant: unchanged
CO = "co-team-test"


def _keys(o):
    if isinstance(o, dict):
        return set(o) | set().union(*(_keys(v) for v in o.values())) if o else set()
    if isinstance(o, list):
        return set().union(*(_keys(v) for v in o)) if o else set()
    return set()


class TeamScopeTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        db = database.SessionLocal()
        for m in (models.NexusEmployee, models.NexusGroup, models.NexusGroupMember, models.NexusAccessScope,
                  models.NexusRole, models.HrEntity, models.PayrollRate, models.TimePunch):
            db.query(m).execution_options(include_deleted=True).delete()
        db.add(models.HrEntity(id=CO, name="Team Test Co"))
        for i, (em, mgr) in enumerate(((VAL, ""), (MID, VAL), (LOW, MID), (OUT, PEER), (PEER, ""))):
            db.add(models.NexusEmployee(
                id=f"e{i}", first_name=em.split("@")[0], last_name="T", work_email=em, manager_email=mgr,
                company=CO, status="active", deleted_at="",
                contractor={"rate": 55, "rate_type": "hourly", "currency": "USD", "contract_end": "2027-01-01"},
                compliance={"visa": "H1B", "expiryDate": "2027-01-01"}, personal={"dob": "1990-01-01"}))
        db.add(models.NexusRole(email=VAL, role="manager", display_name="Valinda"))
        db.add(models.NexusRole(email=PEER, role="supervisor", display_name="Pat"))
        db.add(models.NexusGroup(id="g-hr", name="People Editors", allowed_modules="hr:editor,hr_comp:editor"))
        for em in (VAL, PEER):
            db.add(models.NexusGroupMember(group_id="g-hr", email=em))
        for em in (MID, LOW, OUT):
            db.add(models.PayrollRate(employee_email=em, pay_type="hourly", currency="USD", hourly_rate=30,
                                      full_day_hours=8, overtime_rule="federal"))
        db.commit()
        db.close()
        cache.module_grants.invalidate()
        auth._role_cache.clear()   # tiers are cached per email
        self.ids = {em: f"e{i}" for i, em in enumerate((VAL, MID, LOW, OUT, PEER))}

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    def _get(self, path, who=VAL):
        os.environ["NEXUS_DEV_EMAIL"] = who
        return self.client.get(path)

    # ── who is on the team ─────────────────────────────────────────────────
    def test_the_team_is_the_whole_chain_below_and_nobody_else(self):
        db = database.SessionLocal()
        try:
            scope = auth.hr_scope({"email": VAL, "level": 3}, db)
        finally:
            db.close()
        self.assertTrue(auth.is_team_scope(scope))
        self.assertEqual(set(scope.emails), {MID, LOW})       # Leo is two levels down
        self.assertEqual(len(scope), 0)                        # no companies: company checks fail closed

    def test_a_loop_in_the_reporting_line_does_not_hang(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusEmployee).filter_by(work_email=VAL).update({"manager_email": LOW})
            db.commit()
            self.assertEqual(auth.team_emails(db, VAL), {MID, LOW})
        finally:
            db.close()

    # ── People ─────────────────────────────────────────────────────────────
    def test_the_people_list_is_the_team_with_no_pay_or_compliance(self):
        r = self._get("/hr/employees")
        self.assertEqual(r.status_code, 200, r.text)
        rows = r.json()
        self.assertEqual({x["workEmail"] for x in rows}, {MID, LOW})
        for x in rows:
            self.assertEqual(x["compliance"], {})
            self.assertNotIn("rate", x["contractor"])
            self.assertEqual(x["contractor"]["contract_end"], "2027-01-01")
            self.assertEqual(x["personal"]["dob"], "1990-01-01")   # Overview stays whole

    def test_the_five_profile_tabs_open_for_the_team(self):
        eid = self.ids[LOW]
        for path in (f"/hr/employees/{eid}/assets", f"/hr/employees/{eid}/geofence",
                     f"/hr/employees/{eid}/bod", f"/hr/employees/{eid}/access"):
            self.assertEqual(self._get(path).status_code, 200, path)

    def test_someone_outside_the_team_is_not_found(self):
        eid = self.ids[OUT]
        for path in (f"/hr/employees/{eid}/assets", f"/hr/employees/{eid}/geofence",
                     f"/hr/employees/{eid}/bod", f"/hr/employees/{eid}/access"):
            self.assertEqual(self._get(path).status_code, 404, path)

    def test_everything_else_in_people_is_closed(self):
        eid = self.ids[MID]
        for method, path in (("GET", f"/hr/employees/{eid}/compensation"), ("GET", f"/hr/employees/{eid}/documents"),
                             ("GET", f"/hr/employees/{eid}/paystubs"), ("GET", "/hr/candidates"),
                             ("GET", "/hr/leave"), ("GET", "/hr/requests"), ("GET", "/hr/checklists/board"),
                             ("GET", "/hr/holiday-policies"),
                             ("PATCH", f"/hr/employees/{eid}"), ("POST", "/hr/employees"),
                             ("PUT", f"/hr/employees/{eid}/geofence"), ("POST", "/hr/employees/sync-m365")):
            os.environ["NEXUS_DEV_EMAIL"] = VAL
            r = self.client.request(method, path, json={})
            self.assertEqual(r.status_code, 403, f"{method} {path}: {r.status_code}")

    def test_every_allowlisted_route_exists(self):
        real = {(m, r.path) for r in main.app.routes for m in (getattr(r, "methods", None) or ())}
        self.assertEqual(set(auth.TEAM_ALLOWED_HR_ROUTES) - real, set())

    def test_only_their_teams_companies_are_listed(self):
        self.assertEqual([e["id"] for e in self._get("/hr/entities").json()], [CO])

    def test_a_supervisor_with_people_is_unchanged(self):
        r = self._get("/hr/employees", who=PEER)
        self.assertEqual(len(r.json()), 5)
        self.assertEqual(self._get(f"/hr/employees/{self.ids[OUT]}/compensation", who=PEER).status_code, 200)

    def test_administrators_are_never_limited(self):
        db = database.SessionLocal()
        try:
            self.assertIsNone(auth.hr_scope({"email": VAL, "level": 4}, db))
        finally:
            db.close()

    def test_a_manager_without_people_still_cannot_open_it(self):
        db = database.SessionLocal()
        db.query(models.NexusGroupMember).filter_by(email=VAL).delete()
        db.commit()
        db.close()
        cache.module_grants.invalidate()
        self.assertEqual(self._get("/hr/employees").status_code, 403)

    def test_a_manager_can_still_open_their_own_checklist_steps(self):
        self.assertEqual(self._get("/hr/checklists/mine").status_code, 200)
        self.assertEqual(self._get("/hr/checklists/meta").status_code, 200)

    # ── Time ───────────────────────────────────────────────────────────────
    def test_time_covers_the_team(self):
        db = database.SessionLocal()
        try:
            vis = timeclock._visible_emails(db, {"email": VAL, "level": 3})
        finally:
            db.close()
        self.assertEqual(vis, {VAL, MID, LOW})

    def test_payroll_timecards_show_hours_but_never_pay(self):
        r = self._get(f"/timeclock/payroll?email={LOW}&start=2026-09-20&end=2026-10-03")
        self.assertEqual(r.status_code, 200, r.text)
        card = r.json()
        self.assertTrue(card["payHidden"])
        self.assertEqual(_keys(card) & timeclock.PAY_KEYS, set())
        self.assertIn("workedMin", _keys(card))
        self.assertEqual(self._get(f"/timeclock/payroll?email={OUT}&start=2026-09-20&end=2026-10-03").status_code, 403)

    def test_team_hours_and_by_location_carry_no_pay(self):
        for path in ("/timeclock/team?start=2026-09-20&end=2026-10-03",
                     "/timeclock/billable-by-location?start=2026-09-20&end=2026-10-03"):
            r = self._get(path)
            self.assertEqual(r.status_code, 200, path)
            self.assertEqual(_keys(r.json()) & timeclock.PAY_KEYS, set(), path)

    def test_payroll_files_and_rates_are_refused(self):
        for path in ("/timeclock/export.csv?start=2026-09-20&end=2026-10-03",
                     "/timeclock/export.iif?start=2026-09-20&end=2026-10-03",
                     "/timeclock/export-intacct.csv?start=2026-09-20&end=2026-10-03",
                     f"/timeclock/payroll/rate?email={MID}"):
            self.assertEqual(self._get(path).status_code, 403, path)

    def test_the_compensation_grant_never_opens_pay(self):
        db = database.SessionLocal()
        try:
            # Both hold People + Compensation (hr_comp) - only the supervisor gets pay.
            self.assertFalse(HR._has_comp({"email": VAL, "level": 3}, db))
            self.assertTrue(HR._has_comp({"email": PEER, "level": 2}, db))
        finally:
            db.close()

if __name__ == "__main__":
    unittest.main()
