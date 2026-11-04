"""Shift types belong to teams (Neil, 11/04/2026): the one-time fill links
each old type to the teams that use it, and the save keeps known teams only.

    python -m unittest test_shift_type_teams
"""
import json
import unittest
from datetime import date, timedelta

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models
import shift_type_teams

TABLES = [models.NexusSetting.__table__, models.Shift.__table__, models.ShiftAssignment.__table__,
          models.ShiftGroup.__table__, models.ShiftGroupMember.__table__, models.ScheduledShift.__table__]


class ShiftTypeTeamsTests(unittest.TestCase):
    def setUp(self):
        eng = create_engine("sqlite://")
        models.Base.metadata.create_all(bind=eng, tables=TABLES)
        self.db = sessionmaker(bind=eng, autoflush=False)()
        db = self.db
        recent = (date.today() - timedelta(days=5)).isoformat()
        stale = (date.today() - timedelta(days=400)).isoformat()
        db.add_all([
            models.ShiftGroup(id="ops", name="Operations Team"),
            models.ShiftGroup(id="it", name="IT Support Team"),
            models.ShiftGroup(id="gone", name="Old Team", archived=1),
            models.ShiftGroupMember(id="m1", group_id="ops", employee_email="amy@x.com"),
            models.ShiftGroupMember(id="m2", group_id="it", employee_email="ian@x.com"),
            models.Shift(id="gsv", name="GSV", start_hhmm="09:00", end_hhmm="17:00"),
            models.Shift(id="its", name="IT Support", start_hhmm="08:00", end_hhmm="16:00"),
            models.Shift(id="both", name="Inventory Day", start_hhmm="07:00", end_hhmm="15:00"),
            models.Shift(id="idle", name="Never Used", start_hhmm="10:00", end_hhmm="18:00"),
            models.Shift(id="old", name="Last Year", start_hhmm="10:00", end_hhmm="18:00"),
            models.Shift(id="hand", name="Set By Hand", start_hhmm="10:00", end_hhmm="18:00", group_ids='["it"]'),
            # usual hours
            models.ShiftAssignment(id="a1", employee_email="ian@x.com", shift_id="its"),
            # placements: under a team, and by the person's team
            models.ScheduledShift(id="p1", employee_email="amy@x.com", work_date=recent, shift_id="gsv", group_id="ops"),
            models.ScheduledShift(id="p2", employee_email="amy@x.com", work_date=recent, shift_id="both"),
            models.ScheduledShift(id="p3", employee_email="ian@x.com", work_date=recent, shift_id="both"),
            models.ScheduledShift(id="p4", employee_email="amy@x.com", work_date=stale, shift_id="old"),
            models.ScheduledShift(id="p5", employee_email="amy@x.com", work_date=recent, shift_id="hand"),
        ])
        db.commit()

    def tearDown(self):
        self.db.close()

    def teams(self, sid):
        return json.loads(self.db.get(models.Shift, sid).group_ids or "[]")

    def test_each_type_goes_to_the_teams_that_use_it(self):
        linked = shift_type_teams.apply_once(self.db)
        self.assertEqual(self.teams("gsv"), ["ops"])
        self.assertEqual(self.teams("its"), ["it"])            # from usual hours
        self.assertEqual(self.teams("both"), [])               # every live team uses it: stays shared
        self.assertEqual(self.teams("idle"), [])               # nobody uses it: stays shared
        self.assertEqual(self.teams("old"), [])                # only used long ago
        self.assertEqual(self.teams("hand"), ["it"])           # set by hand: untouched
        self.assertEqual(linked, {"GSV": ["Operations Team"], "IT Support": ["IT Support Team"]})

    def test_it_runs_once(self):
        shift_type_teams.apply_once(self.db)
        s = self.db.get(models.Shift, "gsv")
        s.group_ids = ""
        self.db.commit()
        self.assertIsNone(shift_type_teams.apply_once(self.db))
        self.assertEqual(self.teams("gsv"), [])

    def test_a_save_keeps_known_teams_in_order(self):
        from routers.timeclock import _clean_shift_groups, _shift_group_ids
        self.assertEqual(json.loads(_clean_shift_groups(self.db, ["it", "ops", "it"])), ["it", "ops"])
        self.assertEqual(_clean_shift_groups(self.db, []), "")
        with self.assertRaises(HTTPException):
            _clean_shift_groups(self.db, ["nope"])
        self.assertEqual(_shift_group_ids(self.db.get(models.Shift, "hand")), ["it"])


if __name__ == "__main__":
    unittest.main()
