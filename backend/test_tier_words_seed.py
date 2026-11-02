"""The old tier words out of the data (Neil, 11/02/2026, super_admins_seed).

On dev an owner-tier job role was named "Global Admin" and
routers/jobroles.py apply_job_role copies a job role's name into
nexus_employees.job_title, so Neil, Visesh, Charmi and Sagar read
"Global Admin" under their names. `clear_tier_words_once` renames the two
tier-word job roles, clears every tier-word job title, gives Neil his job
title, and runs once (its own mark, independent of the Super Administrators
mark). `apply_once` makes no owner row for one of the five who has no
People record (a fresh database).

    python -m pytest test_tier_words_seed.py
"""
import os
import tempfile
import unittest

# A throwaway sqlite of its own (CLAUDE.md: one file per process).
_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

import database  # noqa: E402
import models  # noqa: E402
import super_admins_seed as seed  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

NEIL = "neil@greensglobal.com"
VISESH = "visesh.lodha@greensglobal.com"
CHARMI = "charmi@greensglobal.com"
SAGAR = "sagar.shoundik@greensglobal.com"
VIRAL = "viral@greensglobal.com"
PLAIN = "plain.person@greensglobal.com"
GA_ROLE, IT_ROLE, OTHER_ROLE = "jr-global-admin", "jr-it-admin", "jr-marketing"

TABLES = (models.NexusEmployee, models.NexusGroup, models.NexusGroupMember, models.NexusRole,
          models.NexusSetting)


def _emp(email, title):
    return models.NexusEmployee(id=f"e-{email}", first_name=email.split("@")[0].title(),
                                work_email=email, status="active", job_title=title)


class TierWordsSeedTests(unittest.TestCase):
    def setUp(self):
        db = database.SessionLocal()
        try:
            for m in TABLES:
                db.query(m).execution_options(include_deleted=True).delete(synchronize_session=False)
            db.add(models.NexusGroup(id=GA_ROLE, name="Global Admin", is_job_role=1, tier="owner"))
            db.add(models.NexusGroup(id=IT_ROLE, name="IT Admin", is_job_role=1, tier="administrator"))
            db.add(models.NexusGroup(id=OTHER_ROLE, name="Marketing Lead", is_job_role=1, tier="employee"))
            # A plain Access Group with the old word is not a job role: left alone.
            db.add(models.NexusGroup(id="grp-plain", name="Global Admin", is_job_role=0))
            db.add(_emp(NEIL, "Global Admin"))
            db.add(_emp(VISESH, "global admin"))
            db.add(_emp(CHARMI, " Global Admin "))
            db.add(_emp(SAGAR, "Global Admin"))
            db.add(_emp(VIRAL, "IT Admin"))
            db.add(_emp("sa.title@greensglobal.com", "Super Administrators"))
            db.add(_emp("a.title@greensglobal.com", "Administrator"))
            db.add(_emp(PLAIN, "Construction Associate"))
            db.add(_emp("admin.asst@greensglobal.com", "Administrative Assistant"))
            db.commit()
        finally:
            db.close()

    def _titles(self):
        db = database.SessionLocal()
        try:
            return {e.work_email: e.job_title for e in db.query(models.NexusEmployee).all()}
        finally:
            db.close()

    def _names(self):
        db = database.SessionLocal()
        try:
            return {g.id: g.name for g in db.query(models.NexusGroup).all()}
        finally:
            db.close()

    def _run(self, fn):
        db = database.SessionLocal()
        try:
            return fn(db)
        finally:
            db.close()

    def test_clears_the_tier_titles_sets_neils_and_renames_the_roles(self):
        res = self._run(seed.clear_tier_words_once)
        titles = self._titles()
        self.assertEqual(titles[NEIL], "Managing Principal")
        for em in (VISESH, CHARMI, SAGAR, VIRAL, "sa.title@greensglobal.com", "a.title@greensglobal.com"):
            self.assertEqual(titles[em], "", em)
        self.assertEqual(titles[PLAIN], "Construction Associate")
        self.assertEqual(titles["admin.asst@greensglobal.com"], "Administrative Assistant")
        names = self._names()
        self.assertEqual(names[GA_ROLE], "Super Administrators")
        self.assertEqual(names[IT_ROLE], "Administrators")
        self.assertEqual(names[OTHER_ROLE], "Marketing Lead")
        self.assertEqual(names["grp-plain"], "Global Admin")
        # It says exactly which emails changed.
        self.assertEqual(sorted(res["cleared"]), sorted(
            [NEIL, VISESH, CHARMI, SAGAR, VIRAL, "sa.title@greensglobal.com", "a.title@greensglobal.com"]))
        self.assertEqual(res["titled"], [NEIL])
        self.assertEqual(sorted(res["renamed"]),
                         ["Global Admin -> Super Administrators", "IT Admin -> Administrators"])

    def test_neil_keeps_a_real_title(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == NEIL).update(
                {"job_title": "Founder"})
            db.commit()
        finally:
            db.close()
        res = self._run(seed.clear_tier_words_once)
        self.assertEqual(self._titles()[NEIL], "Founder")
        self.assertEqual(res["titled"], [])

    def test_runs_once_even_where_the_first_mark_exists(self):
        self.assertIsNone(self._run(lambda db: db.get(models.NexusSetting, seed.TIER_WORDS_MARK)))
        # The Super Administrators pass already ran on this database.
        self._run(seed.apply_once)
        self.assertIsNotNone(self._run(seed.clear_tier_words_once))
        self.assertIsNotNone(self._run(lambda db: db.get(models.NexusSetting, seed.TIER_WORDS_MARK)))
        # A later restamp (jobroles apply copies the role name) and a later
        # Neil title change both stand: the pass never runs again.
        db = database.SessionLocal()
        try:
            db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == VISESH).update(
                {"job_title": "Global Admin"})
            db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == NEIL).update(
                {"job_title": ""})
            db.commit()
        finally:
            db.close()
        self.assertIsNone(self._run(seed.clear_tier_words_once))
        titles = self._titles()
        self.assertEqual(titles[VISESH], "Global Admin")
        self.assertEqual(titles[NEIL], "")

    def test_job_role_stamping_risk_is_documented(self):
        """routers/jobroles.py apply_job_role still copies the job role's name
        into job_title (`emp.job_title = jr.name.strip()`), so assigning an
        owner/administrator-tier job role ("Super Administrators") would
        stamp a tier word under the person's name again. apply_job_role
        should skip stamping job_title for administrator / owner-tier job
        roles - owned by another pass; this test pins the risk so the fix is
        visible when it lands (flip the assertion then)."""
        import inspect
        from routers import jobroles
        src = inspect.getsource(jobroles.apply_job_role)
        self.assertIn("emp.job_title = jr.name.strip()", src)
        # Whatever the stamp writes, this pass never re-runs to clean it.
        self._run(seed.clear_tier_words_once)
        self.assertIsNone(self._run(seed.clear_tier_words_once))


class SuperAdminsFreshDatabaseTests(unittest.TestCase):
    def setUp(self):
        db = database.SessionLocal()
        try:
            for m in TABLES:
                db.query(m).execution_options(include_deleted=True).delete(synchronize_session=False)
            db.add(_emp(NEIL, ""))                                       # a People record, no role row
            db.add(models.NexusRole(email=CHARMI, role="owner"))        # already owner: not "changed"
            db.add(models.NexusRole(email=SAGAR, role="manager"))       # a role row, no People record
            db.add(models.NexusRole(email=VIRAL, role="owner"))
            db.commit()
        finally:
            db.close()

    def test_no_owner_row_without_a_people_record(self):
        db = database.SessionLocal()
        try:
            res = seed.apply_once(db)
            roles = {r.email: r.role for r in db.query(models.NexusRole).all()}
        finally:
            db.close()
        self.assertEqual(sorted(res["skipped"]), sorted([VISESH, "pranshu.pandey@greensglobal.com"]))
        self.assertNotIn(VISESH, roles)
        self.assertNotIn("pranshu.pandey@greensglobal.com", roles)
        self.assertEqual(roles[NEIL], "owner")
        self.assertEqual(roles[SAGAR], "owner")
        self.assertEqual(roles[CHARMI], "owner")
        self.assertEqual(roles[VIRAL], "administrator")
        # Only the ones that changed are reported.
        self.assertEqual(sorted(res["super_admins"]), sorted([NEIL, SAGAR]))
        self.assertEqual(res["demoted"], [VIRAL])


class EveryBootTests(unittest.TestCase):
    """main._tier_seeds runs on every boot, outside the once-per-deploy gate,
    and prints the emails that changed."""

    def setUp(self):
        SuperAdminsFreshDatabaseTests.setUp(self)
        db = database.SessionLocal()
        try:
            db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == NEIL).update(
                {"job_title": "Global Admin"})
            db.commit()
        finally:
            db.close()

    def test_startup_prepare_runs_the_tier_seeds_after_the_schema_gate(self):
        import io
        from contextlib import redirect_stdout
        from unittest import mock
        import main
        order = []
        with mock.patch.object(main, "_ensure_schema", side_effect=lambda: order.append("schema") or "skipped"), \
                mock.patch.object(main, "_tier_seeds", side_effect=lambda: order.append("tiers")), \
                mock.patch("auth._fetch_jwks", lambda: None):
            main._startup_prepare()
        self.assertEqual(order, ["schema", "tiers"])
        out = io.StringIO()
        with redirect_stdout(out):
            main._tier_seeds()
            main._tier_seeds()          # second boot: both marks there, nothing printed
        text = out.getvalue()
        self.assertIn(f"promoted: {NEIL}, {SAGAR}", text)
        self.assertIn(f"demoted to administrator: {VIRAL}", text)
        self.assertIn(VISESH, text)                      # skipped, and said so
        self.assertIn(f"job titles cleared: {NEIL}", text)
        self.assertIn(f"job title set: {NEIL}", text)
        self.assertEqual(text.count("super administrators set"), 1)
        self.assertEqual(text.count("tier words cleared"), 1)


if __name__ == "__main__":
    unittest.main()
