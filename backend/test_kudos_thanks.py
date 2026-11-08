"""Kudos thanks, the value tag, the recipient's moment and the Teams post
(Neil, 11/08/2026) - perf_feedback.py's kudos rules through their routes, on
a throwaway database (one file per process, CLAUDE.md).

  * one thanks per person, never on your own kudos as the sender;
  * the recipient's one "Kudos For You" bell is rewritten in place with the
    count - never a bell per thanks - unread only when the count grows, and
    taking yours back recounts it quietly;
  * unseen lists the received kudos not looked at yet; seen clears one;
  * Say Thanks (the recipient's thanks) bells the sender once, marks seen
    and is never taken back;
  * the value is saved only when the recipient's company lists it, spelled
    as the list spells it; a company's list layers over the organization's;
  * the Teams queue row is written only with the recipient's company's chat
    set and the switch on; a hidden kudos never posts.
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402,F401
import models  # noqa: E402
import perf_feedback as pf  # noqa: E402
from routers import perf_feedback as api  # noqa: E402
from routers import performance as papi  # noqa: E402

CO, CO2 = "co-kt", "co-kt-2"
SENDER, EMP, PEER, OTHER, HR, BOSS, FAR = (
    "sender.kt@greensglobal.com", "emp.kt@greensglobal.com", "peer.kt@greensglobal.com", "other.kt@greensglobal.com",
    "hr.kt@greensglobal.com", "boss.kt@greensglobal.com", "far.kt@greensglobal.com")


def U(email, level=1):
    return {"email": email, "role": "employee", "level": level}


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
        self.db = database.SessionLocal()
        for m in (models.PerfKudos, models.PerfKudosThanks, models.NexusEmployee, models.HrEntity, models.NexusNotification,
                  models.TicketTeamsMessage, models.NexusSetting):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO, name="Kudos Co", hr_contact_email=HR))
        self.db.add(models.HrEntity(id=CO2, name="Far Co", hr_contact_email=HR))
        for email, first, co in ((SENDER, "Priya", CO), (EMP, "Sam", CO), (PEER, "Marco", CO), (OTHER, "Ana", CO),
                                 (HR, "Hana", CO), (BOSS, "Bea", CO), (FAR, "Fay", CO2)):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=email, first_name=first, last_name="Lee",
                                             company=co, manager_email="" if email == BOSS else BOSS, department="Ops",
                                             status="active", employment_type="full_time", start_date="2021-01-01"))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def refused(self, fn, code):
        with self.assertRaises(HTTPException) as e:
            fn()
        self.assertEqual(e.exception.status_code, code)
        return e.exception

    def bells(self, who, title):
        return self.db.query(models.NexusNotification).filter_by(recipient=who, title=title).all()

    def give(self, to=EMP, by=SENDER, **kw):
        return api.give_kudos(api.KudosIn(to=to, message="Saved the Friday close", **kw), U(by), self.db)

    def settings(self, company, **settings):
        papi.save_settings(papi.SettingsIn(company=company, settings=settings), U(BOSS, 5), self.db)


class ThanksTests(Case):
    def test_thanks_once_per_person_never_the_sender(self):
        k = self.give()
        out = api.thank_kudos(k["id"], api.ThanksIn(note="Well earned"), U(PEER), self.db)
        self.assertEqual(out["thanksCount"], 1)
        self.assertEqual(out["thanks"][0]["name"], "Marco Lee")
        self.assertEqual(out["thanks"][0]["note"], "Well earned")
        self.assertEqual(out["myThanks"], {"note": "Well earned"})
        self.assertFalse(out["can"]["thank"])
        self.assertTrue(out["can"]["takeBack"])
        self.refused(lambda: api.thank_kudos(k["id"], api.ThanksIn(), U(PEER), self.db), 409)
        self.refused(lambda: api.thank_kudos(k["id"], api.ThanksIn(), U(SENDER), self.db), 400)
        # The unique key answers the race the SELECT missed with the same 409.
        self.db.add(models.PerfKudosThanks(id="dup", kudos_id=k["id"], from_email=OTHER, note="", created_at="2026-11-08T00:00:00+00:00"))
        self.db.commit()
        real = pf.models.PerfKudosThanks
        q = self.db.query(real).filter(real.kudos_id == k["id"], real.from_email == OTHER)
        self.assertEqual(q.count(), 1)
        self.refused(lambda: pf.add_thanks(self.db, U(OTHER), self.db.get(models.PerfKudos, k["id"]), ""), 409)
        # The list rows carry the thanks too, limited when asked.
        row = api.list_kudos("company", "", "", U(BOSS), self.db)["items"][0]
        self.assertEqual(sorted(t["name"] for t in row["thanks"]), ["Ana Lee", "Marco Lee"])
        self.assertTrue(row["can"]["thank"])
        self.give(by=PEER)
        self.assertEqual(len(api.list_kudos("company", "", "", U(BOSS), self.db, limit=1)["items"]), 1)
        self.assertNotIn("values", api.list_kudos("company", "", "", U(BOSS), self.db))

    def test_bell_updated_in_place_not_duplicated(self):
        k = self.give()
        self.assertEqual(len(self.bells(EMP, "Kudos For You")), 1)
        api.thank_kudos(k["id"], api.ThanksIn(), U(PEER), self.db)
        api.thank_kudos(k["id"], api.ThanksIn(), U(OTHER), self.db)
        bells = self.bells(EMP, "Kudos For You")
        self.assertEqual(len(bells), 1)
        self.assertIn("Priya Lee sent you kudos · 2 people added their thanks", bells[0].body)
        self.assertIn("Saved the Friday close", bells[0].body)
        self.assertEqual(bells[0].read_by, "")   # a new thanks: unread again
        # Read it; a Take Back recounts QUIETLY - the count changes, read stays read.
        bells[0].read_by = EMP
        self.db.commit()
        api.unthank_kudos(k["id"], U(OTHER), self.db)
        bells = self.bells(EMP, "Kudos For You")
        self.assertEqual(len(bells), 1)
        self.assertIn("1 person added their thanks", bells[0].body)
        self.assertEqual(bells[0].read_by, EMP)
        self.refused(lambda: api.unthank_kudos(k["id"], U(OTHER), self.db), 404)
        # A second kudos is its own bell (one per kudos).
        api.give_kudos(api.KudosIn(to=EMP, message="And the Monday open"), U(PEER), self.db)
        self.assertEqual(len(self.bells(EMP, "Kudos For You")), 2)

    def test_unseen_seen_and_say_thanks(self):
        k = self.give()
        k2 = api.give_kudos(api.KudosIn(to=EMP, message="Great walkthrough"), U(PEER), self.db)
        self.assertEqual([x["id"] for x in api.unseen_kudos(U(EMP), self.db)], [k2["id"], k["id"]])
        self.assertEqual(api.unseen_kudos(U(PEER), self.db), [])
        api.seen_kudos(k2["id"], U(EMP), self.db)
        self.assertEqual([x["id"] for x in api.unseen_kudos(U(EMP), self.db)], [k["id"]])
        self.refused(lambda: api.seen_kudos(k["id"], U(PEER), self.db), 404)
        # Say Thanks = the recipient's thanks: the sender is belled once, the kudos is seen.
        out = api.thank_kudos(k["id"], api.ThanksIn(note="Means a lot"), U(EMP), self.db)
        self.assertFalse(out["can"]["takeBack"])
        self.assertEqual(api.unseen_kudos(U(EMP), self.db), [])
        bells = self.bells(SENDER, "They Said Thanks")
        self.assertEqual(len(bells), 1)
        self.assertIn("Sam Lee said thanks for your kudos", bells[0].body)
        self.assertIn("Means a lot", bells[0].body)
        self.refused(lambda: api.thank_kudos(k["id"], api.ThanksIn(), U(EMP), self.db), 409)
        self.assertEqual(len(self.bells(SENDER, "They Said Thanks")), 1)
        # The reply stays: no Take Back for the recipient.
        e = self.refused(lambda: api.unthank_kudos(k["id"], U(EMP), self.db), 403)
        self.assertIn("reply", e.detail)
        self.assertEqual(self.db.query(models.PerfKudosThanks).filter_by(kudos_id=k["id"]).count(), 1)
        # The recipient's own thanks never counts on their own bell.
        self.assertEqual(len(self.bells(EMP, "Kudos For You")), 2)
        self.assertEqual(api.kudos_summary(U(EMP), self.db), {"thisYear": 2, "latestFrom": "Marco Lee"})

    def test_value_from_the_recipient_company_list_as_it_spells_it(self):
        self.refused(lambda: self.give(value="Ownership"), 400)
        self.settings("", kudosValues=["Ownership", "Safety First"])
        self.assertEqual(api.kudos_options(EMP, U(SENDER), self.db), {"values": ["Ownership", "Safety First"], "teamsChat": False})
        k = self.give(value="ownership")
        self.assertEqual(k["value"], "Ownership")   # the list's spelling, not the typed one
        self.assertEqual(api.unseen_kudos(U(EMP), self.db)[0]["value"], "Ownership")
        # A company's own list layers over the organization's: Far Co's kudos take
        # Far Co's values, and the form for a Far Co recipient shows that list.
        self.settings(CO2, kudosValues=["Hustle"])
        self.assertEqual(api.kudos_options(FAR, U(SENDER), self.db)["values"], ["Hustle"])
        self.assertEqual(self.give(to=FAR, value="hustle")["value"], "Hustle")
        self.refused(lambda: self.give(to=FAR, value="Ownership"), 400)
        self.assertEqual(api.kudos_options(EMP, U(SENDER), self.db)["values"], ["Ownership", "Safety First"])

    def test_teams_row_only_with_the_company_chat_and_the_switch(self):
        T = models.TicketTeamsMessage
        self.give()
        self.assertEqual(self.db.query(T).count(), 0)
        # Only a Super Administrator sets the chat, per company over an organization default.
        self.refused(lambda: papi.save_settings(papi.SettingsIn(company="", settings={"kudosTeamsChatId": "19:x"}), U(HR), self.db), 403)
        self.settings("", kudosTeamsChatId="19:org@thread.v2")
        self.settings(CO2, kudosTeamsChatId="19:far@thread.v2")
        self.assertTrue(api.kudos_options(EMP, U(SENDER), self.db)["teamsChat"])
        self.give(post_teams=False)
        self.assertEqual(self.db.query(T).count(), 0)
        self.settings("", kudosValues=["Ownership"])
        self.give(value="Ownership")
        rows = self.db.query(T).all()
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0].kind, rows[0].chat_id, rows[0].agent_email, rows[0].sent), ("kudos", "19:org@thread.v2", SENDER, 0))
        self.assertIn("Kudos: Priya Lee to Sam Lee - Ownership - Saved the Friday close", rows[0].html)
        # The RECIPIENT's company's chat.
        far = self.give(to=FAR)
        self.assertEqual(self.db.query(T).filter(T.ticket_id == far["id"]).one().chat_id, "19:far@thread.v2")
        # Nobody with a Teams session: the row keeps the reason, never dropped.
        self.assertFalse(pf.deliver_teams(self.db, rows[0]))
        self.assertIn("no Teams session", rows[0].send_error)
        # A hidden kudos never posts: the waiting row is marked at hide time, and
        # the sweep skips one it meets later.
        api.hide_kudos(far["id"], U(SENDER), self.db)
        row = self.db.query(T).filter(T.ticket_id == far["id"]).one()
        self.assertEqual((row.sent, row.send_error), (1, pf.SKIPPED_HIDDEN))
        k3 = self.give(by=PEER)
        row3 = self.db.query(T).filter(T.ticket_id == k3["id"]).one()
        self.db.get(models.PerfKudos, k3["id"]).hidden_at = "2026-11-08T00:00:00+00:00"
        self.db.commit()
        self.assertFalse(pf.deliver_teams(self.db, row3))
        self.assertEqual((row3.sent, row3.send_error), (1, pf.SKIPPED_HIDDEN))
        # No chat for a company = no row at all, whatever the switch says.
        self.settings("", kudosTeamsChatId="")
        self.settings(CO2, kudosTeamsChatId="")
        self.assertFalse(api.kudos_options(EMP, U(SENDER), self.db)["teamsChat"])
        before = self.db.query(T).count()
        self.give(post_teams=True)
        self.assertEqual(self.db.query(T).count(), before)


if __name__ == "__main__":
    unittest.main()
