"""
BOD/EOD to a Teams channel (Pranshu, 10/06).

A shift group binds its BOD/EOD/Break messages to a Teams group chat (as
before) OR to a channel in a team, for an organization that runs a channel
per department. The binding resolves server-side to a target type; each
queued post records it; delivery posts to /chats/{id} or
/teams/{team}/channels/{id} accordingly, with a SEPARATE channel token so a
missing channel consent can never break group-chat posting.

Uses a throwaway sqlite file. No network: Graph calls are mocked.

    python -m unittest test_bod_teams_channel
"""
import os
import tempfile
import unittest
import uuid
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException  # noqa: E402

import bff_session  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
import teams_post  # noqa: E402
from routers import timeclock  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

OPS = "amy@greensglobal.com"
DEV = "bob@greensglobal.com"


class ChannelBindingTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TimeBod, models.ShiftGroup, models.ShiftGroupMember, models.NexusEmployee):
            self.db.query(m).delete()
        self.db.add(models.ShiftGroup(id="g-ops", name="Operations", teams_target="channel",
                                      teams_chat_id="19:ops-channel@thread.tacv2", teams_chat_name="BOD-EOD",
                                      teams_team_id="team-ops", teams_team_name="Operations"))
        self.db.add(models.ShiftGroup(id="g-dev", name="IT Development", teams_chat_id="19:dev-chat@thread.v2",
                                      teams_chat_name="IT Development Team"))
        for gid, email in (("g-ops", OPS), ("g-dev", DEV)):
            self.db.add(models.ShiftGroupMember(id=str(uuid.uuid4()), group_id=gid, employee_email=email))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _post(self, email, **kw):
        body = timeclock.BodIn(kind="bod", message="Starting the day", html="<b>Beginning of Day</b>", **kw)
        with mock.patch("teams_post.deliver_row"):             # the inline attempt - tested below
            r = timeclock.record_bod(body, user={"email": email}, db=self.db)
        return self.db.get(models.TimeBod, r["id"])

    def test_my_chat_reports_a_channel_binding(self):
        out = timeclock.my_group_chat(user={"email": OPS}, db=self.db)
        self.assertEqual((out["targetType"], out["chatId"], out["teamId"], out["teamName"]),
                         ("channel", "19:ops-channel@thread.tacv2", "team-ops", "Operations"))
        self.assertEqual(timeclock.my_group_chat(user={"email": DEV}, db=self.db)["targetType"], "chat")

    def test_the_server_routes_a_post_to_the_bound_channel(self):
        row = self._post(OPS)                                    # client sent no target: server resolves it
        self.assertEqual((row.target_type, row.channel_id, row.team_id), ("channel", "19:ops-channel@thread.tacv2", "team-ops"))
        chat = self._post(DEV)
        self.assertEqual((chat.target_type, chat.channel_id, chat.team_id), ("chat", "19:dev-chat@thread.v2", ""))

    def test_a_channel_without_its_team_is_re_resolved(self):
        row = self._post(OPS, channel_id="19:other@thread.tacv2", target_type="channel")   # no team_id
        self.assertEqual((row.channel_id, row.team_id), ("19:ops-channel@thread.tacv2", "team-ops"))

    def test_delivery_posts_to_the_channel_with_the_channel_token(self):
        row = self._post(OPS)
        with mock.patch("bff_session.graph_token_for_email", return_value="tok") as mint, \
             mock.patch("teams_post.send_channel_message") as chan, mock.patch("teams_post.send_chat_message") as chat:
            self.assertTrue(teams_post.deliver_row(self.db, row))
        self.assertEqual(mint.call_args.args[2], bff_session.GRAPH_CHANNEL_SCOPES)
        chan.assert_called_once_with("tok", "team-ops", "19:ops-channel@thread.tacv2", "<b>Beginning of Day</b>")
        chat.assert_not_called()
        self.assertEqual(self.db.get(models.TimeBod, row.id).sent, 1)

    def test_group_chat_delivery_keeps_the_chat_token(self):
        row = self._post(DEV)
        with mock.patch("bff_session.graph_token_for_email", return_value="tok") as mint, \
             mock.patch("teams_post.send_chat_message") as chat, mock.patch("teams_post.send_channel_message") as chan:
            self.assertTrue(teams_post.deliver_row(self.db, row))
        self.assertEqual(mint.call_args.args[2], bff_session.GRAPH_CHAT_SCOPES)
        chat.assert_called_once_with("tok", "19:dev-chat@thread.v2", "<b>Beginning of Day</b>")
        chan.assert_not_called()
        self.assertNotIn("Channel", bff_session.GRAPH_CHAT_SCOPES)   # a missing channel consent can't break chats

    def test_no_channel_consent_is_recorded_and_retried(self):
        row = self._post(OPS)
        with mock.patch("bff_session.graph_token_for_email", return_value=""):
            self.assertFalse(teams_post.deliver_row(self.db, row))
        row = self.db.get(models.TimeBod, row.id)
        self.assertEqual(row.sent, 0)
        self.assertIn("channel consent", row.send_error)

    def test_binding_a_group_to_a_channel_and_back(self):
        g = self.db.get(models.ShiftGroup, "g-dev")
        timeclock._apply_teams_binding(g, timeclock.GroupIn(
            name="x", teams_target="channel", teams_chat_id="19:c@thread.tacv2", teams_chat_name="Daily",
            teams_team_id="team-dev", teams_team_name="IT"))
        self.assertEqual((g.teams_target, g.teams_team_id), ("channel", "team-dev"))
        with self.assertRaises(HTTPException):                   # a channel needs its team
            timeclock._apply_teams_binding(g, timeclock.GroupIn(name="x", teams_target="channel", teams_chat_id="19:c"))
        timeclock._apply_teams_binding(g, timeclock.GroupIn(name="x", teams_target="chat", teams_chat_id="19:chat", teams_chat_name="Chat"))
        self.assertEqual((g.teams_target, g.teams_team_id, g.teams_team_name), ("chat", "", ""))
        timeclock._apply_teams_binding(g, timeclock.GroupIn(name="x", teams_chat_id=""))   # cleared
        self.assertEqual((g.teams_chat_id, g.teams_target), ("", "chat"))

    def test_listing_channels_says_why_when_consent_is_missing(self):
        with mock.patch("bff_session.graph_token_for_email", return_value=""):
            out = timeclock.my_channels(user={"email": OPS}, db=self.db)
        self.assertEqual(out["channels"], [])
        self.assertIn("ChannelMessage.Send", out["reason"])

    def test_listing_channels_groups_them_by_team_general_first(self):
        def fake_get(url, headers=None, timeout=None):
            r = mock.Mock(status_code=200)
            if "joinedTeams" in url:
                r.json.return_value = {"value": [{"id": "t2", "displayName": "Operations"}, {"id": "t1", "displayName": "Admin"}]}
            elif "/teams/t2/" in url:
                r.json.return_value = {"value": [{"id": "c3", "displayName": "BOD-EOD", "membershipType": "standard"},
                                                 {"id": "c4", "displayName": "General", "membershipType": "standard"}]}
            else:
                r.json.return_value = {"value": [{"id": "c1", "displayName": "General"}]}
            return r
        with mock.patch("bff_session.graph_token_for_email", return_value="tok"), \
             mock.patch.object(timeclock.httpx, "get", side_effect=fake_get):
            out = timeclock.my_channels(user={"email": OPS}, db=self.db)
        self.assertEqual([(c["teamName"], c["channelName"]) for c in out["channels"]],
                         [("Admin", "General"), ("Operations", "General"), ("Operations", "BOD-EOD")])


if __name__ == "__main__":
    unittest.main()
