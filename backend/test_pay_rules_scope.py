"""Pay rules and time-off reasons per company (Settings redesign phase 4,
Oct 23 2026) - routers/timeclock.py over scoped_settings.py.

A company with no override reads the tenant row exactly as before; a saved
override wins for that company's people only; reset drops it; the routes
take ?company= and say whose rule they answer with.

    python -m pytest -q test_pay_rules_scope.py
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
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import scoped_settings  # noqa: E402
from routers import timeclock  # noqa: E402

ADMIN, US_EMP, IN_EMP, LOOSE = ("ada.pr@greensglobal.com", "uma.pr@greensglobal.com",
                                "indira.pr@greensglobal.com", "lou.pr@greensglobal.com")
US, IN = "co-us", "co-in"


class _ScopeHarness(unittest.TestCase):
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
        for m in (models.NexusEmployee, models.NexusRole, models.HrEntity):
            self.db.query(m).delete()
        self.db.query(models.NexusSetting).filter(models.NexusSetting.key.like("timeclock_%")).delete(synchronize_session=False)
        self.db.query(models.NexusSetting).filter(models.NexusSetting.key.like("timeoff_custom_reasons%")).delete(synchronize_session=False)
        self.db.add(models.HrEntity(id=US, name="Greens", country="US"))
        self.db.add(models.HrEntity(id=IN, name="Greens India", country="IN"))
        for em, first, co in ((ADMIN, "Ada", US), (US_EMP, "Uma", US), (IN_EMP, "Indira", IN), (LOOSE, "Lou", "")):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=em, first_name=first, last_name="Test",
                                             company=co, status="active"))
        self.db.add(models.NexusRole(email=ADMIN, role="administrator", assigned_by="test"))
        self.db.commit()
        auth._role_cache.clear()
        os.environ["NEXUS_DEV_EMAIL"] = ADMIN

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        auth._role_cache.clear()
        auth.SKIP_AUTH = self._skip
        self.db.close()


class PayRulesScopeCase(_ScopeHarness):
    # ── the layering itself ───────────────────────────────────────────────
    def test_a_company_with_no_override_reads_the_tenant_rule(self):
        scoped_settings.save(self.db, timeclock._ROUNDING_KEY, "", {"enabled": True, "nearestMin": 15}, "t")
        self.db.commit()
        self.assertEqual(timeclock._rounding_cfg(self.db)["nearestMin"], 15)
        self.assertEqual(timeclock._rounding_cfg(self.db, US)["nearestMin"], 15)
        self.assertEqual(timeclock._round_min(self.db, US_EMP), 15)
        self.assertEqual(timeclock._round_min(self.db, LOOSE), 15)   # untagged: the tenant's
        self.assertFalse(scoped_settings.has_override(self.db, timeclock._ROUNDING_KEY, US))

    def test_an_override_wins_for_that_company_only_and_reset_drops_it(self):
        scoped_settings.save(self.db, timeclock._ROUNDING_KEY, "", {"enabled": True, "nearestMin": 5}, "t")
        scoped_settings.save(self.db, timeclock._ROUNDING_KEY, IN, {"enabled": False, "nearestMin": 5}, "t")
        self.db.commit()
        self.assertEqual(timeclock._round_min(self.db, US_EMP), 5)
        self.assertEqual(timeclock._round_min(self.db, IN_EMP), 0)
        self.assertTrue(scoped_settings.has_override(self.db, timeclock._ROUNDING_KEY, IN))
        self.assertTrue(scoped_settings.reset(self.db, timeclock._ROUNDING_KEY, IN))
        self.db.commit()
        self.assertEqual(timeclock._round_min(self.db, IN_EMP), 5)
        self.assertFalse(scoped_settings.reset(self.db, timeclock._ROUNDING_KEY, IN))

    def test_the_break_policy_follows_the_employee_s_company(self):
        scoped_settings.save(self.db, timeclock._BREAKPOLICY_KEY, "", {"enabled": True, "paidBreakMin": 10, "restMaxMin": 20, "longBreakMin": 75}, "t")
        scoped_settings.save(self.db, timeclock._BREAKPOLICY_KEY, IN, {"enabled": True, "paidBreakMin": 15, "restMaxMin": 20, "longBreakMin": 90}, "t")
        self.db.commit()
        self.assertEqual(timeclock._break_cfg_for(self.db, US_EMP)["paidBreakMin"], 10)
        self.assertEqual(timeclock._break_cfg_for(self.db, IN_EMP)["paidBreakMin"], 15)
        self.assertEqual(timeclock._break_cfg_for(self.db, IN_EMP)["longBreakMin"], 90)

    # ── the routes ────────────────────────────────────────────────────────
    def test_the_routes_read_and_save_a_company_s_own(self):
        r = self.client.put("/timeclock/payroll/autolunch", json={"enabled": True, "afterMin": 360, "deductMin": 30})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["company"], "")
        self.assertFalse(r.json()["hasOverride"])
        self.assertEqual({c["id"] for c in r.json()["companies"]}, {US, IN})

        r = self.client.get(f"/timeclock/payroll/autolunch?company={IN}")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["enabled"])            # inherited
        self.assertFalse(r.json()["hasOverride"])

        r = self.client.put(f"/timeclock/payroll/autolunch?company={IN}", json={"enabled": False, "afterMin": 360, "deductMin": 30})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["hasOverride"])
        self.assertFalse(timeclock._autolunch_cfg(self.db, IN)["enabled"])
        self.assertTrue(timeclock._autolunch_cfg(self.db, US)["enabled"])

        r = self.client.put(f"/timeclock/payroll/autolunch?company={IN}", json={"reset": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["hasOverride"])
        self.assertTrue(r.json()["enabled"])

        self.assertEqual(self.client.get("/timeclock/payroll/rounding?company=nope").status_code, 404)

    def test_time_off_reasons_per_company(self):
        r = self.client.put("/timeclock/timeoff/types?company=default", json={"custom": ["Jury Duty"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["custom"], ["Jury Duty"])
        self.assertFalse(r.json()["hasOverride"])
        # India gets its own; Greens keeps the default.
        r = self.client.put(f"/timeclock/timeoff/types?company={IN}", json={"custom": ["Diwali"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["hasOverride"])
        self.assertEqual(timeclock._custom_timeoff_types(self.db, IN), ["Diwali"])
        self.assertEqual(timeclock._custom_timeoff_types(self.db, US), ["Jury Duty"])
        self.assertEqual(timeclock._custom_timeoff_types(self.db), ["Jury Duty"])
        # The request form answers with the caller's own company's.
        os.environ["NEXUS_DEV_EMAIL"] = IN_EMP
        auth._role_cache.clear()
        self.assertEqual(self.client.get("/timeclock/timeoff/types").json()["custom"], ["Diwali"])
        os.environ["NEXUS_DEV_EMAIL"] = ADMIN
        auth._role_cache.clear()
        self.assertEqual(self.client.get("/timeclock/timeoff/types?company=default").json()["custom"], ["Jury Duty"])
        # Reset: India follows the default again.
        r = self.client.put(f"/timeclock/timeoff/types?company={IN}", json={"custom": [], "reset": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["custom"], ["Jury Duty"])
        self.assertFalse(r.json()["hasOverride"])


class EmailLogoChainCase(_ScopeHarness):
    def test_the_recipient_s_company_logo_wins_then_the_module_s(self):
        import email_theme
        ent = self.db.get(models.HrEntity, IN)
        ent.logo_url = "https://x/india.png"
        self.db.commit()
        self.assertEqual(email_theme.logo_for(self.db, "https://x/module.png", IN_EMP), "https://x/india.png")
        self.assertEqual(email_theme.logo_for(self.db, "https://x/module.png", US_EMP), "https://x/module.png")
        self.assertEqual(email_theme.logo_for(self.db, "", LOOSE), "")
        self.assertEqual(email_theme.logo_for(None, "https://x/module.png", IN_EMP), "https://x/module.png")


class LeaveCutoverScopeCase(_ScopeHarness):
    def test_a_company_s_own_start_date_wins(self):
        import leave_balances as lb
        lb.set_cutover(self.db, "2026-01-01", "t")
        lb.set_cutover(self.db, "2026-04-01", "t", IN)
        self.db.commit()
        self.assertEqual(lb.cutover(self.db), "2026-01-01")
        self.assertEqual(lb.cutover(self.db, US), "2026-01-01")
        self.assertEqual(lb.cutover(self.db, IN), "2026-04-01")
        self.assertEqual(lb.cutover_for(self.db, IN_EMP), "2026-04-01")
        self.assertEqual(lb.cutover_for(self.db, LOOSE), "2026-01-01")
        self.assertEqual(lb.company_cutovers(self.db), {IN: "2026-04-01"})
        r = self.client.put("/leave-balances/cutover", json={"company": IN, "reset": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(lb.cutover(self.db, IN), "2026-01-01")
        self.assertEqual([c["own"] for c in r.json()["companies"]], [False, False])
        r = self.client.put("/leave-balances/cutover", json={"company": "nope", "date": "2026-02-01"})
        self.assertEqual(r.status_code, 404)


if __name__ == "__main__":
    unittest.main()
