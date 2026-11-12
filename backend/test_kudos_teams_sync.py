"""Kudos on Teams, both ways (Neil, 11/12/2026) - perf_kudos_teams.py with
Graph faked at the module edge, on a throwaway database (one file per
process, CLAUDE.md).

  * Settings: a channel per company from the picker, a Super Administrator's;
    the chat id typed before it still works; a company's own wins;
  * the post goes to the company's channel as the sender, @mentions the
    recipient and keeps its message id and polling time;
  * read back: a colleague's reaction is their thanks (the bell grows), the
    recipient's is their Say Thanks, the sender's is nothing, anyone else is
    only counted; a reaction taken off takes the thanks back, never the
    recipient's; a channel reply is a thanks with its words;
  * a Nexus thanks puts a clap (and the note as a reply) on the post as that
    person and reading it back changes nothing; a Take Back takes the clap
    off and what they did before is not read back in; a mirror written after
    a read began is left alone by that read;
  * the webhook echoes Graph's validation token and marks a post due only for
    our own subscription and clientState, in the right conversation;
  * subscriptions are made, renewed and dropped with the posts;
  * polling slows with age and stops at 30 days; a hidden kudos is not read.
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402,F401
import models  # noqa: E402
import perf_feedback as pf  # noqa: E402
import perf_kudos_teams as pkt  # noqa: E402
import teams_post  # noqa: E402
from routers import perf_feedback as api  # noqa: E402
from routers import performance as papi  # noqa: E402
from routers import teams_webhook  # noqa: E402

CO, CO2 = "co-kts", "co-kts-2"
SENDER, EMP, PEER, OTHER, HR, BOSS, FAR = (
    "sender.kts@greensglobal.com", "emp.kts@greensglobal.com", "peer.kts@greensglobal.com",
    "other.kts@greensglobal.com", "hr.kts@greensglobal.com", "boss.kts@greensglobal.com", "far.kts@greensglobal.com")
AAD = {SENDER: "aad-sender", EMP: "aad-emp", PEER: "aad-peer", OTHER: "aad-other", FAR: "aad-far", BOSS: "aad-boss"}
CHANNEL = {"type": "channel", "id": "19:kudos@thread.tacv2", "name": "Shout-Outs", "teamId": "team-1", "teamName": "Greens"}
CLAP = pkt.REACTION


def U(email, level=1):
    return {"email": email, "role": "employee", "level": level}


class FakeGraph:
    """The Graph a test sees: one message per id, its reactions and replies,
    the directory, and every write made."""
    def __init__(self):
        self.messages = {}      # message id -> {"reactions": [...], "replies": [...], "deleted": False}
        self.writes = []        # (what, args)
        self.next_id = 1000

    def message(self, mid):
        return self.messages.setdefault(mid, {"reactions": [], "replies": [], "deleted": False})

    def react(self, mid, email, kind, at=None):
        self.message(mid)["reactions"].append({"reactionType": kind, "createdDateTime": at or _ago(0),
                                               "user": {"user": {"id": AAD.get(email, "aad-" + email)}}})

    def unreact(self, mid, email):
        m = self.message(mid)
        m["reactions"] = [r for r in m["reactions"] if r["user"]["user"]["id"] != AAD.get(email, "aad-" + email)]

    def reply(self, mid, email, text, at=None):
        self.next_id += 1
        rid = f"r{self.next_id}"
        self.message(mid)["replies"].append({"id": rid, "createdDateTime": at or _ago(0),
                                             "from": {"user": {"id": AAD.get(email, "aad-" + email)}},
                                             "body": {"content": f"<p>{text}</p>"}})
        return rid

    # -- what perf_kudos_teams / teams_post call ----------------------------
    def get(self, tok, url, params=None):
        path = url.replace(pkt.GRAPH, "")
        if path.startswith("/users/"):
            who = path.split("/users/")[1]
            for email, aad in AAD.items():
                if who in (aad, email):
                    return {"id": aad, "mail": email, "displayName": email.split(".")[0].title()}
            raise pkt.GraphError(404, "no such user")
        if path.endswith("/replies"):
            mid = path.split("/messages/")[1].split("/")[0]
            return {"value": list(self.message(mid)["replies"])}
        mid = path.split("/messages/")[1]
        m = self.message(mid)
        if m["deleted"]:
            return {"id": mid, "deletedDateTime": _ago(0)}
        return {"id": mid, "reactions": list(m["reactions"])}

    def send_channel(self, tok, team, conv, html, mentions=None):
        self.next_id += 1
        mid = f"m{self.next_id}"
        self.writes.append(("post", (tok, team, conv, html, mentions)))
        self.message(mid)
        return {"id": mid, "webUrl": f"https://teams.example/{mid}"}

    def send_reply(self, tok, team, conv, mid, html):
        self.writes.append(("reply", (tok, mid, html)))
        return {"id": self.reply(mid, tok.removeprefix("tok:"), html.replace("<p>", "").replace("</p>", ""))}

    def set_reaction(self, tok, path, reaction, on=True):
        who = tok.removeprefix("tok:")
        mid = path.split("/messages/")[1]
        self.writes.append(("react" if on else "unreact", (who, mid, reaction)))
        if on:
            self.react(mid, who, reaction)
        else:
            self.unreact(mid, who)

    def graph_write(self, method, tok, url, body=None):
        self.writes.append((method, url, body))
        if method == "POST":
            self.next_id += 1
            return {"id": f"sub{self.next_id}", "expirationDateTime": body["expirationDateTime"]}
        return {}


def _ago(minutes):
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()


class Case(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        auth._role_cache.clear()
        pkt._tok_cache.clear()
        pkt._create_wait.clear()
        self.db = database.SessionLocal()
        for m in (models.PerfKudos, models.PerfKudosThanks, models.NexusEmployee, models.HrEntity, models.NexusNotification,
                  models.TicketTeamsMessage, models.NexusSetting, models.TeamsUserMap, models.TeamsSubscription):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO, name="Kudos Co", hr_contact_email=HR))
        self.db.add(models.HrEntity(id=CO2, name="Far Co", hr_contact_email=HR))
        for email, first, co in ((SENDER, "Priya", CO), (EMP, "Sam", CO), (PEER, "Marco", CO), (OTHER, "Ana", CO),
                                 (HR, "Hana", CO), (BOSS, "Bea", CO), (FAR, "Fay", CO2)):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=email, first_name=first, last_name="Lee",
                                             company=co, manager_email="" if email == BOSS else BOSS, department="Ops",
                                             status="active", employment_type="full_time", start_date="2021-01-01"))
        self.db.commit()
        self.g = FakeGraph()
        self.no_session = set()   # people with no Teams session
        self._patches = []
        self.patch(pkt, "token_for", lambda db, email, scopes: "" if email in self.no_session or not email else f"tok:{email}")
        self.patch(pkt, "_get", self.g.get)
        self.patch(pkt, "_graph_write", self.g.graph_write)
        self.patch(teams_post, "send_channel_message", self.g.send_channel)
        self.patch(teams_post, "send_channel_reply", self.g.send_reply)
        self.patch(teams_post, "set_reaction", self.g.set_reaction)
        self.patch(pkt, "_env_posters", lambda: [])

    def patch(self, obj, name, value):
        self._patches.append((obj, name, getattr(obj, name)))
        setattr(obj, name, value)

    def tearDown(self):
        for obj, name, value in reversed(self._patches):
            setattr(obj, name, value)
        self.db.close()

    def refused(self, fn, code):
        with self.assertRaises(HTTPException) as e:
            fn()
        self.assertEqual(e.exception.status_code, code)
        return e.exception

    def bells(self, who, title):
        return self.db.query(models.NexusNotification).filter_by(recipient=who, title=title).all()

    def settings(self, company, **settings):
        return papi.save_settings(papi.SettingsIn(company=company, settings=settings), U(BOSS, 5), self.db)

    def posted(self, to=EMP, by=SENDER, message="Saved the Friday close"):
        """A kudos given with the channel set, delivered; returns the fresh kudos row."""
        if not pf.teams_target(self.db, CO):
            self.settings("", kudosTeams=CHANNEL)
        out = api.give_kudos(api.KudosIn(to=to, message=message), U(by), self.db)
        row = self.db.query(models.TicketTeamsMessage).filter_by(ticket_id=out["id"], kind="kudos").one()
        self.assertTrue(pf.deliver_teams(self.db, row))
        return self.kudos(out["id"])

    def kudos(self, kid):
        self.db.expire_all()
        return self.db.get(models.PerfKudos, kid)

    def thanks(self, kid):
        self.db.expire_all()
        return {t.from_email: t for t in self.db.query(models.PerfKudosThanks).filter_by(kudos_id=kid).all()}

    def sync(self, k):
        out = pkt.sync_one(k.id)
        self.db.expire_all()
        return out

    def deliver_queued(self):
        M = models.TicketTeamsMessage
        self.db.expire_all()
        for row in self.db.query(M).filter(M.sent == 0, M.kind.in_(("kudos_react", "kudos_unreact"))).order_by(M.created_at).all():
            pkt.deliver_reaction(self.db, row)


class SettingsTests(Case):
    def test_channel_per_company_super_admin_only_and_the_old_chat_id(self):
        self.refused(lambda: papi.save_settings(papi.SettingsIn(company="", settings={"kudosTeams": CHANNEL}), U(HR), self.db), 403)
        # The chat id typed before the picker still posts there.
        self.settings("", kudosTeamsChatId="19:org@thread.v2")
        self.assertEqual(pf.teams_target(self.db, CO), {"type": "chat", "id": "19:org@thread.v2", "name": "", "teamId": "", "teamName": ""})
        # The picker replaces it at that layer.
        out = self.settings("", kudosTeams=CHANNEL)
        self.assertEqual(out["settings"]["kudosTeams"], CHANNEL)
        self.assertEqual(out["settings"]["kudosTeamsChatId"], "")
        self.assertEqual(pf.teams_target(self.db, CO), CHANNEL)
        # A company's own channel wins for its people; a company that says "nowhere" posts nowhere.
        far = {**CHANNEL, "id": "19:far@thread.tacv2", "name": "Far Shout-Outs"}
        self.settings(CO2, kudosTeams=far)
        self.assertEqual(pf.teams_target(self.db, CO2)["id"], "19:far@thread.tacv2")
        self.assertEqual(api.kudos_options(FAR, U(SENDER), self.db)["teamsPlace"], "Greens > Far Shout-Outs")
        self.settings(CO2, kudosTeams={})
        self.assertEqual(pf.teams_target(self.db, CO2), {})
        self.assertFalse(api.kudos_options(FAR, U(SENDER), self.db)["teamsChat"])
        self.assertEqual(pf.teams_target(self.db, CO), CHANNEL)
        # A channel needs its team.
        self.settings("", kudosTeams={"type": "channel", "id": "19:x"})
        self.assertEqual(pf.teams_target(self.db, CO), {})


class PostTests(Case):
    def test_posted_to_the_channel_as_the_sender_mentioning_the_recipient(self):
        k = self.posted()
        what, (tok, team, conv, html, mentions) = self.g.writes[0]
        self.assertEqual((what, tok, team, conv), ("post", f"tok:{SENDER}", "team-1", CHANNEL["id"]))
        self.assertIn('<at id="0">Sam Lee</at>', html)
        self.assertEqual(mentions[0]["mentioned"]["user"]["id"], "aad-emp")
        self.assertTrue(k.teams_message_id)
        tp = pkt.post_of(k)
        self.assertEqual((tp["type"], tp["teamId"], tp["convId"], tp["poster"]), ("channel", "team-1", CHANNEL["id"], SENDER))
        self.assertTrue(k.teams_sync_due_at)
        out = api.list_kudos("company", "", "", U(PEER), self.db)["items"][0]
        self.assertEqual(out["teams"], {"url": f"https://teams.example/{k.teams_message_id}", "others": 0, "type": "channel"})

    def test_the_m365_link_answers_without_asking_graph(self):
        emp = self.db.query(models.NexusEmployee).filter_by(work_email=EMP).one()
        emp.m365_id = "m365-emp"
        peer = self.db.query(models.NexusEmployee).filter_by(work_email=PEER).one()
        peer.m365_id = "m365-peer"
        self.db.commit()
        asked = []
        real_get = self.g.get
        self.patch(pkt, "_get", lambda tok, url, params=None: (asked.append(url), real_get(tok, url, params))[1])
        k = self.posted()
        self.assertEqual(self.g.writes[0][1][4][0]["mentioned"]["user"]["id"], "m365-emp")
        self.g.message(k.teams_message_id)["reactions"].append(
            {"reactionType": "like", "createdDateTime": _ago(0), "user": {"user": {"id": "m365-peer"}}})
        self.sync(k)
        self.assertEqual(set(self.thanks(k.id)), {PEER})
        self.assertFalse([u for u in asked if "/users/" in u])

    def test_no_mention_when_the_recipient_is_unknown_to_graph(self):
        self.patch(pkt, "id_for_email", lambda db, tok, email: "")
        self.posted()
        html, mentions = self.g.writes[0][1][3], self.g.writes[0][1][4]
        self.assertIn("<strong>Sam Lee</strong>", html)
        self.assertIsNone(mentions)


class ReadBackTests(Case):
    def test_reactions_become_thanks_and_go_away_with_them(self):
        k = self.posted()
        mid = k.teams_message_id
        self.g.react(mid, PEER, "heart")
        self.g.react(mid, SENDER, "like")             # the sender's own: not a thanks
        self.g.react(mid, FAR, "like")                # a colleague elsewhere: counted only
        self.g.react(mid, "guest@outside.com", "like")
        self.g.react(mid, EMP, CLAP)                  # the recipient: their Say Thanks
        out = self.sync(k)
        self.assertEqual(out["added"], 2)
        t = self.thanks(k.id)
        self.assertEqual(set(t), {PEER, EMP})
        self.assertEqual((t[PEER].via, t[PEER].teams_reaction), ("teams", "heart"))
        row = api.list_kudos("company", "", "", U(BOSS), self.db)["items"][0]
        self.assertEqual(row["teams"]["others"], 2)
        self.assertEqual({x["email"]: x["reaction"] for x in row["thanks"]}, {PEER: "❤️", EMP: CLAP})
        bell = self.bells(EMP, "Kudos For You")
        self.assertEqual(len(bell), 1)
        self.assertIn("1 person added their thanks", bell[0].body)
        self.assertEqual(len(self.bells(SENDER, "They Said Thanks")), 1)
        self.assertTrue(self.kudos(k.id).seen_at)
        # Read again: nothing new, nothing twice.
        self.assertEqual(self.sync(k), {"added": 0, "removed": 0, "updated": 0})
        self.assertEqual(len(self.bells(SENDER, "They Said Thanks")), 1)
        # A reaction taken off in Teams takes that thanks back - never the recipient's.
        self.g.unreact(mid, PEER)
        self.g.unreact(mid, EMP)
        out = self.sync(k)
        self.assertEqual(out["removed"], 1)
        self.assertEqual(set(self.thanks(k.id)), {EMP})
        self.assertNotIn("added their thanks", self.bells(EMP, "Kudos For You")[0].body)   # recounted in place

    def test_a_channel_reply_is_a_thanks_with_its_words(self):
        k = self.posted()
        self.g.reply(k.teams_message_id, OTHER, "Well deserved!")
        self.g.reply(k.teams_message_id, SENDER, "Thank you all")   # the sender: not a thanks
        self.sync(k)
        t = self.thanks(k.id)
        self.assertEqual(set(t), {OTHER})
        self.assertEqual((t[OTHER].note, t[OTHER].via, t[OTHER].teams_reaction), ("Well deserved!", "teams", ""))
        # A clap added later joins the same thanks.
        self.g.react(k.teams_message_id, OTHER, "like")
        self.sync(k)
        self.assertEqual(self.thanks(k.id)[OTHER].teams_reaction, "like")

    def test_a_deleted_post_changes_nothing_and_stops_reading(self):
        k = self.posted()
        self.g.react(k.teams_message_id, PEER, "heart")
        self.sync(k)
        self.g.message(k.teams_message_id)["deleted"] = True
        self.sync(k)
        self.assertEqual(set(self.thanks(k.id)), {PEER})
        self.assertEqual(self.kudos(k.id).teams_sync_due_at, "")

    def test_nobody_can_read_it_is_kept_and_tried_later(self):
        k = self.posted()
        self.no_session.update({SENDER, EMP})
        out = self.sync(k)
        self.assertIn("nobody with a Teams read session", out["error"])
        k = self.kudos(k.id)
        self.assertIn("nobody", pkt.post_of(k)["error"])
        self.assertGreater(k.teams_sync_due_at, datetime.now(timezone.utc).isoformat())

    def test_hidden_kudos_is_not_read(self):
        k = self.posted()
        api.hide_kudos(k.id, U(SENDER), self.db)
        self.g.react(k.teams_message_id, PEER, "heart")
        self.assertEqual(self.sync(self.kudos(k.id)), {"skipped": True})
        self.assertEqual(self.thanks(k.id), {})
        self.assertEqual(self.kudos(k.id).teams_sync_due_at, "")


class NexusToTeamsTests(Case):
    def test_a_nexus_thanks_claps_as_them_and_reads_back_as_the_same_thanks(self):
        k = self.posted()
        api.thank_kudos(k.id, api.ThanksIn(note="Great work"), U(PEER), self.db)
        self.deliver_queued()
        self.assertIn(("react", (PEER, k.teams_message_id, CLAP)), self.g.writes)
        self.assertEqual([w[0] for w in self.g.writes].count("reply"), 1)
        t = self.thanks(k.id)[PEER]
        self.assertEqual((t.via, t.teams_reaction), ("", CLAP))
        self.assertTrue(t.teams_reply_id)
        # Reading back their own clap and reply changes nothing.
        self.assertEqual(self.sync(self.kudos(k.id)), {"added": 0, "removed": 0, "updated": 0})
        self.assertEqual(set(self.thanks(k.id)), {PEER})

    def test_take_back_unclaps_and_what_they_did_before_is_not_read_back(self):
        k = self.posted()
        api.thank_kudos(k.id, api.ThanksIn(), U(PEER), self.db)
        self.deliver_queued()
        # Taken back in Nexus; the clap has not come off yet when the next read runs.
        api.unthank_kudos(k.id, U(PEER), self.db)
        self.assertEqual(self.sync(self.kudos(k.id))["added"], 0)
        self.assertEqual(self.thanks(k.id), {})
        self.deliver_queued()
        self.assertIn(("unreact", (PEER, k.teams_message_id, CLAP)), self.g.writes)
        # A new reaction after the Take Back is a thanks again.
        self.g.react(k.teams_message_id, PEER, "heart", at=_ago(-1))
        self.sync(self.kudos(k.id))
        self.assertEqual(self.thanks(k.id)[PEER].teams_reaction, "heart")

    def test_a_clap_still_waiting_is_never_sent_after_a_take_back(self):
        k = self.posted()
        api.thank_kudos(k.id, api.ThanksIn(), U(PEER), self.db)
        api.unthank_kudos(k.id, U(PEER), self.db)
        M = models.TicketTeamsMessage
        rows = self.db.query(M).filter(M.ticket_id == k.id, M.kind.in_(("kudos_react", "kudos_unreact"))).all()
        self.assertEqual([(r.kind, r.sent, r.send_error) for r in rows], [("kudos_react", 1, pkt.SKIPPED_TAKEN_BACK)])

    def test_a_read_that_began_before_a_mirror_leaves_it_alone(self):
        k = self.posted()
        api.thank_kudos(k.id, api.ThanksIn(), U(PEER), self.db)
        state = pkt.fetch(self.db, self.kudos(k.id))      # read before the clap goes on
        self.deliver_queued()
        k = self.kudos(k.id)
        self.assertEqual(pkt.apply(self.db, k, state)["removed"], 0)
        self.db.commit()
        self.assertEqual(self.thanks(k.id)[PEER].teams_reaction, CLAP)

    def test_no_post_no_mirror(self):
        out = api.give_kudos(api.KudosIn(to=EMP, message="Saved the Friday close"), U(SENDER), self.db)
        api.thank_kudos(out["id"], api.ThanksIn(), U(PEER), self.db)
        M = models.TicketTeamsMessage
        self.assertEqual(self.db.query(M).filter(M.kind == "kudos_react").count(), 0)


class WebhookAndSubscriptionTests(Case):
    def client(self):
        app = FastAPI()
        app.include_router(teams_webhook.router)
        return TestClient(app)

    def test_validation_token_is_echoed(self):
        r = self.client().post(pkt.WEBHOOK_PATH + "?validationToken=abc%20123")
        self.assertEqual((r.status_code, r.text, r.headers["content-type"].split(";")[0]), (200, "abc 123", "text/plain"))

    def test_subscriptions_made_renewed_dropped_and_notifications_checked(self):
        os.environ["NEXUS_API_BASE"] = "https://api.example.com"
        try:
            k = self.posted()
            out = pkt.ensure_subscriptions()
            self.assertEqual(out["made"], 1)
            method, url, body = self.g.writes[-1]
            self.assertEqual((method, url), ("POST", "/subscriptions"))
            self.assertEqual(body["resource"], f"/teams/team-1/channels/{CHANNEL['id']}/messages")
            self.assertEqual(body["notificationUrl"], "https://api.example.com/webhooks/teams/kudos")
            self.assertFalse(body["includeResourceData"])
            sub = self.db.query(models.TeamsSubscription).one()
            self.assertEqual((sub.target_key, sub.owner_email), (f"channel:team-1:{CHANNEL['id']}", SENDER))
            self.assertNotEqual(sub.client_state_hash, body["clientState"])   # only its hash is kept
            # Fresh: left alone. Near its end: renewed.
            self.assertEqual(pkt.ensure_subscriptions()["renewed"], 0)
            sub.expires_at = _ago(-10)
            self.db.commit()
            self.assertEqual(pkt.ensure_subscriptions()["renewed"], 1)
            self.assertEqual(self.g.writes[-1][0], "PATCH")
            # A notification: ours with the right clientState marks the post due now.
            self.db.expire_all()
            self.kudos(k.id).teams_sync_due_at = _ago(-60)
            self.db.commit()
            note = {"subscriptionId": sub.id, "clientState": body["clientState"], "changeType": "updated",
                    "resource": f"teams('team-1')/channels('{CHANNEL['id']}')/messages('{k.teams_message_id}')"}
            self.g.react(k.teams_message_id, PEER, "heart")
            bad = [{**note, "clientState": "forged"},
                   {**note, "resource": f"chats('19:else@thread.v2')/messages('{k.teams_message_id}')"},
                   {**note, "subscriptionId": "unknown"}]
            self.assertEqual(pkt.note_notifications(bad[:1] + bad[2:]), [])
            r = self.client().post(pkt.WEBHOOK_PATH, json={"value": bad + [note]})
            self.assertEqual(r.status_code, 202)
            self.assertEqual(set(self.thanks(k.id)), {PEER})    # read after the response
            # A reply notification names the post as the parent.
            self.g.reply(k.teams_message_id, OTHER, "Yes!")
            reply_note = {**note, "resource": note["resource"] + "/replies('r1')"}
            self.assertEqual(pkt.note_notifications([reply_note]), [k.id])
            # The post taken down: no live post in that channel, the subscription goes.
            api.hide_kudos(k.id, U(SENDER), self.db)
            self.assertEqual(pkt.ensure_subscriptions()["dropped"], 1)
            self.assertEqual(self.db.query(models.TeamsSubscription).count(), 0)
            self.assertEqual(self.g.writes[-1][0], "DELETE")
        finally:
            os.environ.pop("NEXUS_API_BASE", None)

    def test_no_public_address_no_subscription(self):
        os.environ.pop("NEXUS_API_BASE", None)
        os.environ.pop("WEBSITE_HOSTNAME", None)
        self.posted()
        self.assertEqual(pkt.ensure_subscriptions(), {"made": 0, "renewed": 0, "dropped": 0})

    def test_polling_slows_with_age_and_stops(self):
        now = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)
        mins = lambda age: (datetime.fromisoformat(pkt.due_after((now - age).isoformat(), now)) - now).total_seconds() / 60  # noqa: E731
        self.assertEqual(mins(timedelta(hours=2)), 5)
        self.assertEqual(mins(timedelta(days=3)), 30)
        self.assertEqual(mins(timedelta(days=20)), 180)
        self.assertEqual(pkt.due_after((now - timedelta(days=31)).isoformat(), now), "")

    def test_sync_due_reads_only_posts_whose_turn_came(self):
        k = self.posted()
        k2 = self.posted(to=OTHER, message="Opened early")
        self.g.react(k.teams_message_id, PEER, "heart")
        self.g.react(k2.teams_message_id, PEER, "heart")
        a, b = self.kudos(k.id), self.db.get(models.PerfKudos, k2.id)
        a.teams_sync_due_at, b.teams_sync_due_at = _ago(1), _ago(-30)
        self.db.commit()
        self.assertEqual(pkt.sync_due(), 1)
        self.assertEqual(set(self.thanks(k.id)), {PEER})
        self.assertEqual(self.thanks(k2.id), {})


if __name__ == "__main__":
    unittest.main()
