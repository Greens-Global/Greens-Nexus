"""Two reads that answered for everyone (code review, Oct 13) - as tests.

  * GET /dashboards/birthdays returned every active employee of every company
    and kept the answer under one cache key, so with the company walls armed
    one company's roster was served to another.
  * GET /timeclock/screenshots filtered by date only: a person holding the
    Employee Tracking grant saw every frame of everyone, while its sibling
    /team-screenshots held a manager to their own team.

Uses a throwaway sqlite file, the handlers called directly. No network.

    python -m unittest test_scope_gaps_oct13
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException  # noqa: E402

import cache  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
from routers import dashboards, timeclock  # noqa: E402


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(
            f"{__name__} is pointed at {actual!r}, not its own temp database. "
            f"Another test module imported `database` first. "
            f"Run it on its own: python -m unittest {__name__}"
        )


_assert_isolated()

COA, COB = "ent-a", "ent-b"
ADMIN = {"email": "gwen@greensglobal.com", "level": 4}
A_EMP = {"email": "amy@greensglobal.com", "level": 1}
B_EMP = {"email": "beth@greensglobal.com", "level": 1}
LEAD = {"email": "lena@greensglobal.com", "level": 1}      # holds the tracking grant, manages Ravi only
NOBODY = {"email": "nora@greensglobal.com", "level": 1}    # walls on, no company
DAY = "2026-10-12"

PEOPLE = [   # email, first name, company, manager, date of birth
    (ADMIN["email"], "Gwen", COA, "", "1980-01-05"),
    (A_EMP["email"], "Amy", COA, "", "1991-03-14"),
    (B_EMP["email"], "Beth", COB, "", "1992-07-21"),
    (LEAD["email"], "Lena", COA, "", ""),
    ("ravi@greensglobal.com", "Ravi", COA, LEAD["email"], "1993-11-02"),
    (NOBODY["email"], "Nora", "", "", ""),
]


class ScopeGapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        with database.SessionLocal() as db:
            for email, first, company, manager, dob in PEOPLE:
                db.add(models.NexusEmployee(id=f"e-{first}", first_name=first, last_name="Test", work_email=email, status="active",
                                            deleted_at="", company=company, manager_email=manager, personal={"dob": dob} if dob else {}))
            for i, email in enumerate(("ravi@greensglobal.com", "ravi@greensglobal.com", B_EMP["email"], LEAD["email"])):
                db.add(models.TimeScreenshot(id=f"shot-{i}", employee_email=email, at=f"{DAY}T10:0{i}:00", local_date=DAY))
            db.commit()

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.unlink(_tmp_db.name)
        except OSError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        self._walls("")

    def tearDown(self):
        self.db.close()

    def _walls(self, value):
        row = self.db.query(models.NexusSetting).filter(models.NexusSetting.key == "company_walls").first()
        if row:
            row.value = value
        else:
            self.db.add(models.NexusSetting(key="company_walls", value=value))
        self.db.commit()
        cache.settings_config.invalidate()
        cache.dashboard_birthdays.invalidate()

    # ── birthdays ────────────────────────────────────────────────────────────
    def _names(self, user):
        return sorted(b["name"].split()[0] for b in dashboards.birthdays(user=user, db=self.db)["birthdays"])

    def test_walls_off_everyone_reads_the_whole_roster(self):
        self.assertEqual(self._names(A_EMP), ["Amy", "Beth", "Gwen", "Ravi"])
        self.assertEqual(self._names(B_EMP), ["Amy", "Beth", "Gwen", "Ravi"])

    def test_walls_on_a_person_reads_their_own_company(self):
        self._walls("on")
        self.assertEqual(self._names(A_EMP), ["Amy", "Gwen", "Ravi"])
        # Asked straight after, inside the cache's lifetime: company B gets
        # company B, not the roster just built for company A.
        self.assertEqual(self._names(B_EMP), ["Beth"])
        self.assertEqual(self._names(A_EMP), ["Amy", "Gwen", "Ravi"])
        self.assertEqual(self._names(ADMIN), ["Amy", "Beth", "Gwen", "Ravi"])     # a Global Admin sees across
        self.assertEqual(self._names(NOBODY), [])                                # no company: nothing

    def test_birthdays_carry_no_year(self):
        out = dashboards.birthdays(user=A_EMP, db=self.db)["birthdays"]
        self.assertEqual(sorted(out[0]), ["day", "month", "name"])

    # ── screenshots ──────────────────────────────────────────────────────────
    def _people(self, user):
        return {p["email"]: p["count"] for p in timeclock.list_screenshots(date=DAY, email="", user=user, db=self.db)["people"]}

    def test_an_administrator_sees_every_frame(self):
        self.assertEqual(self._people(ADMIN), {"ravi@greensglobal.com": 2, B_EMP["email"]: 1, LEAD["email"]: 1})

    def test_a_grant_holder_sees_their_own_team(self):
        self.assertEqual(self._people(LEAD), {"ravi@greensglobal.com": 2, LEAD["email"]: 1})
        self.assertEqual(self._people(LEAD), {p["email"]: p["count"] for p in
                                              timeclock.team_screenshots(date=DAY, email="", user=LEAD, db=self.db)["people"]})

    def test_screenshot_galleries_need_the_tracking_grant(self):
        # Neil, 10/29/2026: screenshots are Workforce Analytics' alone. Both
        # galleries take the Employee Tracking grant - never a plain manager
        # or an HR-viewer grant (/team-screenshots used to admit both, and an
        # unrestricted HR grant reached the whole company's frames).
        for path in ("/screenshots", "/team-screenshots"):
            route = next(r for r in timeclock.router.routes if getattr(r, "path", "").endswith(path))
            self.assertIn(timeclock.require_tracking, [d.call for d in route.dependant.dependencies], path)

    def test_frames_of_someone_outside_the_team_are_refused(self):
        with self.assertRaises(HTTPException) as cm:
            timeclock.list_screenshots(date=DAY, email=B_EMP["email"], user=LEAD, db=self.db)
        self.assertEqual(cm.exception.status_code, 403)
        signed = timeclock._sign_shot_rows
        timeclock._sign_shot_rows = lambda rows: {}          # no storage in a test
        try:
            mine = timeclock.list_screenshots(date=DAY, email="Ravi@greensglobal.com", user=LEAD, db=self.db)
            theirs = timeclock.list_screenshots(date=DAY, email=B_EMP["email"], user=ADMIN, db=self.db)
        finally:
            timeclock._sign_shot_rows = signed
        self.assertEqual([s["id"] for s in mine["shots"]], ["shot-0", "shot-1"])
        self.assertEqual([s["id"] for s in theirs["shots"]], ["shot-2"])


if __name__ == "__main__":
    unittest.main()
