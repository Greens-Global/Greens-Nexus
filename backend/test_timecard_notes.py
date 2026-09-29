"""Timecard Notes column (Charmi, Sep 29).

A manager/HR note per person per day: written through PUT
/timeclock/timecard-notes, read back on the team timecard only, cleared by an
empty note, and refused outside the writer's team.

    python -m unittest test_timecard_notes
"""
import os
import tempfile
import unittest
import uuid

# Its own throwaway database (CLAUDE.md).
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException                                               # noqa: E402

import database                                                                  # noqa: E402
import models                                                                    # noqa: E402
from models import NexusEmployee, TimecardNote                                   # noqa: E402
from routers.timeclock import TimecardNoteIn, _timecard_notes, set_timecard_note  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

ADMIN = {"email": "hr.admin@greensglobal.com", "level": 4}
MANAGER = {"email": "mgr@greensglobal.com", "level": 3}


class TimecardNotesTest(unittest.TestCase):
    def setUp(self):
        self.emp = f"notes.{uuid.uuid4().hex[:8]}@greensglobal.com"
        self.other = f"other.{uuid.uuid4().hex[:8]}@greensglobal.com"
        db = database.SessionLocal()
        try:
            db.add(NexusEmployee(id=str(uuid.uuid4()), work_email=self.emp, first_name="Ashley", last_name="Test",
                                 manager_email=MANAGER["email"]))
            db.add(NexusEmployee(id=str(uuid.uuid4()), work_email=self.other, first_name="Not", last_name="Mine"))
            db.commit()
        finally:
            db.close()

    def put(self, user, email, date, note):
        db = database.SessionLocal()
        try:
            return set_timecard_note(TimecardNoteIn(email=email, date=date, note=note), user=user, db=db)
        finally:
            db.close()

    def read(self, email, start="2026-09-20", end="2026-10-03"):
        db = database.SessionLocal()
        try:
            return _timecard_notes(db, email, start, end)
        finally:
            db.close()

    def test_write_read_update_clear(self):
        r = self.put(ADMIN, self.emp, "2026-09-25", "  Worked Temecula in the afternoon  ")
        self.assertEqual(r["note"], "Worked Temecula in the afternoon")
        self.assertEqual(self.read(self.emp)["2026-09-25"]["by"], ADMIN["email"])
        self.put(ADMIN, self.emp, "2026-09-25", "Updated")
        self.assertEqual(self.read(self.emp)["2026-09-25"]["note"], "Updated")
        self.put(ADMIN, self.emp, "2026-09-25", "")
        self.assertNotIn("2026-09-25", self.read(self.emp))

    def test_only_the_period_comes_back(self):
        self.put(ADMIN, self.emp, "2026-09-21", "in")
        self.put(ADMIN, self.emp, "2026-10-10", "out of the period")
        self.assertEqual(list(self.read(self.emp)), ["2026-09-21"])

    def test_one_note_per_day(self):
        self.put(ADMIN, self.emp, "2026-09-22", "first")
        self.put(ADMIN, self.emp, "2026-09-22", "second")
        db = database.SessionLocal()
        try:
            n = db.query(TimecardNote).filter(TimecardNote.employee_email == self.emp,
                                              TimecardNote.date == "2026-09-22").count()
        finally:
            db.close()
        self.assertEqual(n, 1)

    def test_a_manager_writes_only_inside_their_team(self):
        self.assertEqual(self.put(MANAGER, self.emp, "2026-09-23", "ok")["note"], "ok")
        with self.assertRaises(HTTPException) as e:
            self.put(MANAGER, self.other, "2026-09-23", "not mine")
        self.assertEqual(e.exception.status_code, 403)

    def test_the_monthly_fixed_salary_card_carries_notes_too(self):
        # Aarav (fixed salary) had no Notes column: the monthly card returned
        # before the notes were attached (Sep 29).
        from models import PayrollRate
        from routers.timeclock import payroll_timecard
        db = database.SessionLocal()
        try:
            db.add(PayrollRate(employee_email=self.emp, pay_type="fixed", currency="INR", monthly_salary=30000))
            db.commit()
        finally:
            db.close()
        self.put(ADMIN, self.emp, "2026-09-02", "Was at the client site")
        db = database.SessionLocal()
        try:
            card = payroll_timecard(email=self.emp, start="2026-09-15", end="", user=ADMIN, _su={}, db=db)
        finally:
            db.close()
        self.assertEqual(card.get("payType"), "fixed")
        self.assertEqual(card["notes"]["2026-09-02"]["note"], "Was at the client site")

    def test_two_saves_of_a_new_note_racing_do_not_500(self):
        # Enter saved the note, then the box losing focus saved it again while
        # the first request was in flight: both found no row, both inserted,
        # and the second hit the primary key (500 on dev, Sep 29).
        self.put(ADMIN, self.emp, "2026-09-03", "first save")      # the request that won

        class MissFirstLookup:
            """A session whose first TimecardNote lookup still sees no row -
            the losing request's view before the winner committed."""
            def __init__(self, db):
                self.db, self.missed = db, False

            def query(self, model, *a):
                q = self.db.query(model, *a)
                if model is TimecardNote and not self.missed:
                    self.missed = True

                    class Empty:
                        def filter(self, *_):
                            return self

                        def first(self):
                            return None
                    return Empty()
                return q

            def __getattr__(self, name):
                return getattr(self.db, name)

        db = database.SessionLocal()
        try:
            r = set_timecard_note(TimecardNoteIn(email=self.emp, date="2026-09-03", note="second save"),
                                  user=ADMIN, db=MissFirstLookup(db))
        finally:
            db.close()
        self.assertEqual(r["note"], "second save")
        self.assertEqual(self.read(self.emp, "2026-09-01", "2026-09-30")["2026-09-03"]["note"], "second save")

    def test_a_bad_date_is_refused(self):
        with self.assertRaises(HTTPException) as e:
            self.put(ADMIN, self.emp, "09/23/2026", "x")
        self.assertEqual(e.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
