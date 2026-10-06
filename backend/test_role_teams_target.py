"""
BOD / EOD / break messages route by job role (Neil, Oct 7).

"It isn't even based on the person, it's based on a role": the Teams chat or
channel set on a person's job role is where their messages post, ahead of the
shift group's binding (kept as the fallback). A channel needs its team.

Uses a throwaway sqlite file.

    python -m unittest test_role_teams_target
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
from routers.jobroles import TeamsTarget, _apply_teams, _serialize  # noqa: E402
from routers.timeclock import _resolve_group_target  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

EMP = "routing.emp@greensglobal.com"


class RoleTeamsTargetTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.NexusGroup, models.NexusGroupMember, models.ShiftGroup, models.ShiftGroupMember):
            self.db.query(m).delete()
        self.db.add(models.ShiftGroup(id="sg1", name="IT Dev", teams_chat_id="chat-old", teams_chat_name="Old Chat"))
        self.db.add(models.ShiftGroupMember(id="sgm1", group_id="sg1", employee_email=EMP))
        self.role = models.NexusGroup(id="jr1", name="IT Developer", is_job_role=1, tier="employee")
        self.db.add(self.role)
        self.db.add(models.NexusGroupMember(group_id="jr1", email=EMP))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_shift_group_is_the_fallback(self):
        t = _resolve_group_target(self.db, EMP)
        self.assertEqual((t["id"], t["source"]), ("chat-old", "shift_group"))

    def test_role_channel_wins(self):
        _apply_teams(self.role, TeamsTarget(type="channel", id="chan-1", name="IT Support", teamId="team-1", teamName="IT"))
        self.db.commit()
        t = _resolve_group_target(self.db, EMP)
        self.assertEqual((t["type"], t["id"], t["teamId"], t["source"]), ("channel", "chan-1", "team-1", "role"))
        self.assertEqual(_serialize(self.role, self.db)["teams"]["name"], "IT Support")

    def test_channel_needs_its_team_and_empty_id_clears(self):
        with self.assertRaises(HTTPException):
            _apply_teams(self.role, TeamsTarget(type="channel", id="chan-1"))
        _apply_teams(self.role, TeamsTarget(type="chat", id="chat-new", name="Dev Chat"))
        _apply_teams(self.role, TeamsTarget(id=""))
        self.db.commit()
        self.assertEqual(_serialize(self.role, self.db)["teams"], {})
        self.assertEqual(_resolve_group_target(self.db, EMP)["source"], "shift_group")


if __name__ == "__main__":
    unittest.main()
