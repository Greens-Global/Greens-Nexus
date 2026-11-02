"""Every people payload carries `tier` (Neil, 11/02/2026): 'super' for a
Super Administrator (level 5), 'admin' for an Administrator (level 4),
'manager' for a Manager (level 3), '' for everyone else - so every name on a
screen can carry its mark. One rule, auth.tier_of; five payloads:
/myhr/person, /myhr/directory, the Contact Directory roster, hr._serialize
and the Act As eligible targets.
    python -m pytest test_people_tiers.py
"""
import os
import tempfile
import unittest

# A throwaway sqlite of its own (CLAUDE.md: one file per process).
_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import atexit  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

import act_as  # noqa: E402
from routers import directory as directory_router  # noqa: E402
from routers import hr as hr_router  # noqa: E402
from routers import myhr  # noqa: E402


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


CO = "co-tiers-test"
PEOPLE = [
    # id, first, last, email, role row (None = no nexus_roles row), expected tier
    ("t1", "Sue", "Super", "sue.super@example.com", "owner", "super"),
    ("t2", "Adam", "Admin", "adam.admin@example.com", "administrator", "admin"),
    ("t3", "Maya", "Manager", "maya.manager@example.com", "manager", "manager"),
    ("t4", "Vic", "Visor", "vic.visor@example.com", "supervisor", ""),
    ("t5", "Eli", "Employee", "eli.employee@example.com", "employee", ""),
    ("t6", "Nora", "Norow", "nora.norow@example.com", None, ""),
]
EXPECTED = {email: tier for _, _, _, email, _, tier in PEOPLE}
SUPER = {"email": "sue.super@example.com", "level": 5, "role": "owner"}


class TierOfTests(unittest.TestCase):
    def test_tier_of_maps_levels(self):
        self.assertEqual([auth.tier_of(n) for n in (5, 4, 3, 2, 1, 0, 9)],
                         ["super", "admin", "manager", "", "", "", "super"])


class PeoplePayloadTests(unittest.TestCase):
    def setUp(self):
        bound = os.path.normcase(os.path.abspath(database.engine.url.database or ""))
        if bound != os.path.normcase(os.path.abspath(_tmp.name)):
            self.skipTest("database is bound to another file's DB")
        self.db = database.SessionLocal()
        for m in (models.NexusEmployee, models.NexusRole, models.HrEntity, models.HrDepartment):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO, name="Greens Tiers"))
        for pid, first, last, email, role, _ in PEOPLE:
            self.db.add(models.NexusEmployee(id=pid, employee_code=pid.upper(), first_name=first, last_name=last,
                                             work_email=email, status="active", job_title="Person",
                                             department="Ops", company=CO, employment_type="full_time"))
            if role:
                self.db.add(models.NexusRole(email=email, role=role))
        self.db.commit()
        auth.invalidate_role_cache()
        cache.people_directory.invalidate()
        cache.contact_directory.invalidate()

    def tearDown(self):
        self.db.close()

    def _check(self, rows, key="email"):
        seen = {}
        for r in rows:
            email = (r.get(key) or "").lower()
            if email in EXPECTED:
                seen[email] = r.get("tier")
        self.assertEqual(seen, EXPECTED)

    def test_myhr_directory_carries_tier(self):
        rows = myhr.people_directory(include_external=False, user=SUPER, db=self.db)
        self._check(rows)

    def test_myhr_person_card_carries_tier(self):
        for email, tier in EXPECTED.items():
            card = myhr.person_card(q=email, user=SUPER, db=self.db)
            self.assertEqual(card.get("tier"), tier, email)

    def test_contact_directory_roster_carries_tier(self):
        roster = directory_router._roster(self.db, None)
        self._check(roster["people"])

    def test_hr_serialize_carries_tier(self):
        rows = self.db.query(models.NexusEmployee).all()
        # One row at a time, through the role cache ...
        self._check([hr_router._serialize(e, db=self.db) for e in rows], key="workEmail")
        # ... and a whole list with one roles query.
        tiers = auth.tiers_by_email(self.db)
        self._check([hr_router._serialize(e, tiers=tiers) for e in rows], key="workEmail")
        # With neither, the field is still there - blank, never missing.
        self.assertEqual(hr_router._serialize(rows[0]).get("tier"), "")

    def test_act_as_targets_carry_tier(self):
        rows = act_as.eligible_targets(user=SUPER, db=self.db)
        expected = {e: t for e, t in EXPECTED.items() if e != SUPER["email"]}
        seen = {r["email"]: r.get("tier") for r in rows if r["email"] in expected}
        self.assertEqual(seen, expected)


if __name__ == "__main__":
    unittest.main()
