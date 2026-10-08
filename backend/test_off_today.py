"""
"Out today" Teams post (Neil, 10/08): the first BOD of the day on a chat or
channel is followed by one post naming everyone bound to that destination who
is on approved time off that day. Once per destination per day; nothing when
nobody is off; confidential requests show as plain "Time off".

Uses a throwaway sqlite file.

    python -m unittest test_off_today
"""
import os
import tempfile
import unittest
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database  # noqa: E402
import models  # noqa: E402
import off_today  # noqa: E402
from routers import timeclock  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

CHAN, TEAM = "19:channel-ops@thread.tacv2", "team-ops"
DAY = "2026-10-08"
BETH, SAL, AMY, OUTSIDER = ("beth@greensglobal.com", "sal@greensglobal.com",
                            "amy@greensglobal.com", "outsider@greensglobal.com")


class OffTodayTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TimeBod, models.TimeOffRequest, models.NexusEmployee, models.NexusGroup,
                  models.NexusGroupMember, models.ShiftGroup, models.ShiftGroupMember):
            self.db.query(m).delete()
        for i, (em, first, last) in enumerate([(BETH, "Beth", "Takahana"), (SAL, "Sal", "Mallidi"),
                                               (AMY, "Amy", "Lee"), (OUTSIDER, "Out", "Sider")]):
            self.db.add(models.NexusEmployee(id=f"e{i}", first_name=first, last_name=last, work_email=em))
        # Ops is a job role whose BOD/EOD go to a channel; Beth, Sal and Amy hold it.
        self.db.add(models.NexusGroup(id="role-ops", name="Ops", is_job_role=1, bod_target="channel",
                                      bod_chat_id=CHAN, bod_chat_name="Ops", bod_team_id=TEAM, bod_team_name="Greens"))
        for em in (BETH, SAL, AMY):
            self.db.add(models.NexusGroupMember(group_id="role-ops", email=em))
        # The outsider is in a shift group bound to the same channel, but their
        # job role sends them elsewhere - so they are not "on" this channel.
        self.db.add(models.NexusGroup(id="role-other", name="Other", is_job_role=1, bod_target="chat",
                                      bod_chat_id="19:other-chat", bod_chat_name="Other"))
        self.db.add(models.NexusGroupMember(group_id="role-other", email=OUTSIDER))
        self.db.add(models.ShiftGroup(id="sg", name="Ops shift", teams_chat_id=CHAN, teams_target="channel", teams_team_id=TEAM))
        self.db.add(models.ShiftGroupMember(id="sgm1", group_id="sg", employee_email=OUTSIDER))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _off(self, em, start, end, status="approved", **kw):
        self.db.add(models.TimeOffRequest(id=f"to-{em}-{start}-{status}", employee_email=em, type=kw.pop("type", "vacation"),
                                          start_date=start, end_date=end, status=status, **kw))
        self.db.commit()

    def _bod(self, em, rid="bod-1"):
        row = models.TimeBod(id=rid, employee_email=em, kind="bod", local_date=DAY, message="Starting",
                             team_id=TEAM, team_name="Greens", channel_id=CHAN, channel_name="Ops",
                             target_type="channel", sent=1, created_at="2026-10-08T13:00:00")
        self.db.add(row)
        self.db.commit()
        return row

    def test_members_follow_the_resolved_destination(self):
        self.assertEqual(off_today.members_of_destination(self.db, CHAN), [AMY, BETH, SAL])

    def test_first_bod_posts_who_is_off_once(self):
        self._off(BETH, "2026-10-08", "2026-10-10")                                  # multi-day
        self._off(SAL, DAY, DAY, type="sick", confidential=1)                       # confidential
        self._off(AMY, DAY, DAY, status="pending")                                  # not approved
        self._off(OUTSIDER, DAY, DAY)                                               # not on this channel
        row = off_today.maybe_post(self.db, self._bod(AMY), deliver=False)
        self.assertIsNotNone(row)
        self.assertEqual(row.kind, "off_today")
        self.assertEqual((row.employee_email, row.channel_id, row.team_id, row.target_type, row.local_date),
                         (AMY, CHAN, TEAM, "channel", DAY))
        self.assertIn("Out today - Thursday, 10/08/2026", row.html)
        self.assertIn("<b>Beth Takahana</b> - Vacation, through 10/10/2026", row.html)
        self.assertIn("<b>Sal Mallidi</b> - Time off</li>", row.html)      # confidential: no type
        self.assertNotIn("Sick", row.html)
        self.assertNotIn("Amy", row.html.split("</p>", 1)[1])
        self.assertNotIn("Sider", row.html)
        self.assertEqual(row.sent, 0)                                       # queued for teams_post
        # The second BOD of the day on the same channel adds nothing.
        self.assertIsNone(off_today.maybe_post(self.db, self._bod(BETH, "bod-2"), deliver=False))
        self.assertEqual(self.db.query(models.TimeBod).filter(models.TimeBod.kind == "off_today").count(), 1)

    def test_partial_day_shows_its_hours(self):
        self._off(SAL, DAY, DAY, type="personal", start_time="11:00", end_time="13:00")
        row = off_today.maybe_post(self.db, self._bod(AMY), deliver=False)
        self.assertIn("<b>Sal Mallidi</b> - Personal, 11:00 AM - 1:00 PM", row.html)

    def test_nothing_to_say_posts_nothing(self):
        self.assertIsNone(off_today.maybe_post(self.db, self._bod(AMY), deliver=False))
        self.assertEqual(self.db.query(models.TimeBod).filter(models.TimeBod.kind == "off_today").count(), 0)
        # ...so a request approved later that morning still rides the next BOD.
        self._off(BETH, DAY, DAY)
        self.assertIsNotNone(off_today.maybe_post(self.db, self._bod(SAL, "bod-2"), deliver=False))

    def test_bod_endpoint_triggers_it(self):
        self._off(BETH, DAY, DAY)
        body = timeclock.BodIn(kind="bod", message="Morning", sent=True, tz_offset_min=-330,
                               channel_id=CHAN, channel_name="Ops", target_type="channel", team_id=TEAM, team_name="Greens")
        with mock.patch.object(timeclock, "_now_iso", return_value="2026-10-08T03:30:00"), \
             mock.patch("teams_post.deliver_row", return_value=False) as deliver:
            timeclock.record_bod(body, user={"email": AMY}, db=self.db)
        post = self.db.query(models.TimeBod).filter(models.TimeBod.kind == "off_today").one()
        self.assertIn("Beth Takahana", post.html)
        deliver.assert_called_once()
        self.assertEqual(deliver.call_args[0][1].id, post.id)


if __name__ == "__main__":
    unittest.main()
