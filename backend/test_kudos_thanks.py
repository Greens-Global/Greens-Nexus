"""Kudos thanks, the value tag, the recipient's moment and the Teams post
(Neil, 11/08/2026) - perf_feedback.py's kudos rules through their routes, on
a throwaway database (one file per process, CLAUDE.md).

  * one thanks per person, never on your own kudos as the sender;
  * the recipient's one "Kudos For You" bell is rewritten in place with the
    count - never a bell per thanks - and taking yours back recounts it;
  * unseen lists the received kudos not looked at yet; seen clears one;
  * Say Thanks (the recipient's thanks) bells the sender once and marks seen;
  * the value is saved only when the company lists it;
  * the Teams queue row is written only with a chat id set and the switch on.
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
import scoped_settings  # noqa: E402
from routers import perf_feedback as api  # noqa: E402
from routers import performance as papi  # noqa: E402

CO = "co-kt"
SENDER, EMP, PEER, OTHER, HR, BOSS = ("sender.kt@greensglobal.com", "emp.kt@greensglobal.com", "peer.kt@greensglobal.com",
                                      "other.kt@greensglobal.com", "hr.kt@greensglobal.com", "boss.kt@greensglobal.com")


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
        for email, first in ((SENDER, "Priya"), (EMP, "Sam"), (PEER, "Marco"), (OTHER, "Ana"), (HR, "Hana"), (BOSS, "Bea")):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=email, first_name=first, last_name="Lee",
                                             company=CO, manager_email="" if email == BOSS else BOSS, department="Ops",
                                             status="active", employment_type="full_time", start_date="2021-01-01"))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def refused(self, fn, code):
        with self.assertRaises(HTTPException) as e:
            fn()
        self.assertEqual(e.exception.status_code, code)

    def bells(self, who, title):
        return self.db.query(models.NexusNotification).filter_by(recipient=who, title=title).all()

    def give(self, **kw):
        return api.give_kudos(api.KudosIn(to=EMP, message="Saved the Friday close", **kw), U(SENDER), self.db)


class ThanksTests(Case):
    def test_thanks_once_per_person_never_the_sender(self):
        k = self.give()
        out = api.thank_kudos(k["id"], api.ThanksIn(note="Well earned"), U(PEER), self.db)
        self.assertEqual(out["thanksCount"], 1)
        self.assertEqual(out["thanks"][0]["name"], "Marco Lee")
        self.assertEqual(out["thanks"][0]["note"], "Well earned")
        self.assertEqual(out["myThanks"], {"note": "Well earned"})
        self.assertFalse(out["can"]["thank"])
        self.refused(lambda: api.thank_kudos(k["id"], api.ThanksIn(), U(PEER), self.db), 409)
        self.refused(lambda: api.thank_kudos(k["id"], api.ThanksIn(), U(SENDER), self.db), 400)
        # The list rows carry the thanks too.
        row = api.list_kudos("company", "", "", U(OTHER), self.db)["items"][0]
        self.assertEqual([t["name"] for t in row["thanks"]], ["Marco Lee"])
        self.assertTrue(row["can"]["thank"])

    def test_bell_updated_in_place_not_duplicated(self):
        k = self.give()
        self.assertEqual(len(self.bells(EMP, "Kudos For You")), 1)
        api.thank_kudos(k["id"], api.ThanksIn(), U(PEER), self.db)
        api.thank_kudos(k["id"], api.ThanksIn(), U(OTHER), self.db)
        bells = self.bells(EMP, "Kudos For You")
        self.assertEqual(len(bells), 1)
        self.assertIn("Priya Lee sent you kudos · 2 people added their thanks", bells[0].body)
        self.assertIn("Saved the Friday close", bells[0].body)
        # Taking yours back recounts; a thanks you never gave is a 404.
        api.unthank_kudos(k["id"], U(OTHER), self.db)
        bells = self.bells(EMP, "Kudos For You")
        self.assertEqual(len(bells), 1)
        self.assertIn("1 person added their thanks", bells[0].body)
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
        api.thank_kudos(k["id"], api.ThanksIn(note="Means a lot"), U(EMP), self.db)
        self.assertEqual(api.unseen_kudos(U(EMP), self.db), [])
        bells = self.bells(SENDER, "They Said Thanks")
        self.assertEqual(len(bells), 1)
        self.assertIn("Sam Lee said thanks for your kudos", bells[0].body)
        self.assertIn("Means a lot", bells[0].body)
        self.refused(lambda: api.thank_kudos(k["id"], api.ThanksIn(), U(EMP), self.db), 409)
        self.assertEqual(len(self.bells(SENDER, "They Said Thanks")), 1)
        # The recipient's own thanks never counts on their own bell.
        self.assertEqual(len(self.bells(EMP, "Kudos For You")), 2)
        self.assertEqual(api.kudos_summary(U(EMP), self.db), {"thisYear": 2, "latestFrom": "Marco Lee"})

    def test_value_saved_only_from_the_company_list(self):
        self.refused(lambda: self.give(value="Ownership"), 400)
        papi.save_settings(papi.SettingsIn(company="", settings={"kudosValues": ["Ownership", "Safety First"]}), U(HR, 5), self.db)
        self.assertEqual(api.list_kudos("company", "", "", U(SENDER), self.db)["values"], ["Ownership", "Safety First"])
        k = self.give(value="ownership")
        self.assertEqual(k["value"], "ownership")
        self.assertEqual(api.unseen_kudos(U(EMP), self.db)[0]["value"], "ownership")
        # A company's own list layers over the organization's.
        scoped_settings.get(self.db, "performance", {"kudosValues": []}, CO)

    def test_teams_row_only_with_a_chat_and_the_switch(self):
        T = models.TicketTeamsMessage
        self.give()
        self.assertEqual(self.db.query(T).count(), 0)
        self.assertFalse(api.list_kudos("company", "", "", U(SENDER), self.db)["teamsChat"])
        self.refused(lambda: api.save_kudos_chat(api.KudosChatIn(chat_id="19:abc@thread.v2"), U(HR), self.db), 403)
        api.save_kudos_chat(api.KudosChatIn(chat_id="19:abc@thread.v2"), U(BOSS, 5), self.db)
        self.assertTrue(api.list_kudos("company", "", "", U(SENDER), self.db)["teamsChat"])
        self.give(post_teams=False)
        self.assertEqual(self.db.query(T).count(), 0)
        papi.save_settings(papi.SettingsIn(company="", settings={"kudosValues": ["Ownership"]}), U(HR, 5), self.db)
        self.give(value="Ownership")
        rows = self.db.query(T).all()
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0].kind, rows[0].chat_id, rows[0].agent_email, rows[0].sent), ("kudos", "19:abc@thread.v2", SENDER, 0))
        self.assertIn("Kudos: Priya Lee to Sam Lee - Ownership - Saved the Friday close", rows[0].html)
        # Nobody with a Teams session: the row keeps the reason, never dropped.
        self.assertFalse(pf.deliver_teams(self.db, rows[0]))
        self.assertIn("no Teams session", rows[0].send_error)


if __name__ == "__main__":
    unittest.main()
