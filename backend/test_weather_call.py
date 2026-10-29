"""
The weather call (Weather Call, Phase 2 - Oct 10 2026): weather_call.py +
routers/weather_call.py.

  - The decider picks who the call applies to; the picked people's shifts
    change in place (cancelled = kept on the grid, unpaid; delayed /
    shortened keep their original times) and open slots follow; everyone
    unchecked keeps their shift and is told so quietly.
  - The picked people hear on every channel at once - bell, email, text
    (unless opted out or no phone, which the record says), an urgent Teams
    message - and acknowledge by a signed link or in the app.
  - Silence is followed up: a second text at 30 minutes, the decider told
    at 60. Reinstate puts everything back and tells the same people.
  - Only a decider, a scheduler, a company manager or an administrator -
    each a shift manager - may call it.

Senders are stood in; the clock is passed to the follow-up. Throwaway
sqlite. Run with: python -m unittest test_weather_call -v
"""
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

from fastapi.testclient import TestClient   # noqa: E402

import auth           # noqa: E402
import cache          # noqa: E402
import database       # noqa: E402
import main           # noqa: E402
import models         # noqa: E402
import weather_call   # noqa: E402
import weather_watch  # noqa: E402

BOSS = "wc.boss@greensglobal.com"    # administrator + company manager
MGR = "wc.mgr@greensglobal.com"      # the group's weather decider
OTHER = "wc.other@greensglobal.com"  # a manager with nothing to do with the group
ANN = "wc.ann@greensglobal.com"      # phone, texts on
BOB = "wc.bob@greensglobal.com"      # phone, texts OFF
CAL = "wc.cal@greensglobal.com"      # no phone
ENT, GROUP, SITE = "ent-wc", "grp-wc", "site-wc"
DAY = (datetime.now(timezone.utc).date() + timedelta(days=3)).isoformat()


class CallTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self.db = database.SessionLocal()
        for m in (models.NexusRole, models.NexusEmployee, models.ShiftGroup, models.ShiftGroupMember, models.HrWorkSite,
                  models.HrEntity, models.ScheduledShift, models.NexusNotification, models.ScheduleDayNote,
                  models.WeatherOutlook, models.WeatherAdvisory, models.WeatherDecision, models.NexusPersonPref,
                  models.NexusSetting, models.ShiftRequest, models.Shift, models.ShiftAssignment, models.HrDepartment):
            self.db.query(m).delete()
        for em, first, phone in ((BOSS, "Boss", ""), (MGR, "Mia", ""), (OTHER, "Otto", ""), (ANN, "Ann", "(949) 555-0101"),
                                 (BOB, "Bob", "(949) 555-0102"), (CAL, "Cal", "")):
            # The crew is in Construction: weather calls are for weather departments only (10/29/2026).
            self.db.add(models.NexusEmployee(id=f"emp-{em}", first_name=first, last_name="X", work_email=em, phone=phone,
                                             status="active", deleted_at="", company=ENT,
                                             department="Construction" if em in (ANN, BOB, CAL) else ""))
        self.db.add(models.HrDepartment(id="d-wc-con", company_id=ENT, name="Construction"))   # starts on
        self.db.add(models.NexusRole(email=BOSS, role="administrator", assigned_by="test"))
        for em in (MGR, OTHER):
            self.db.add(models.NexusRole(email=em, role="manager", assigned_by="test"))
        self.db.add(models.HrEntity(id=ENT, name="Greens", manager_email=BOSS, manager_emails=[BOSS]))
        self.db.add(models.HrWorkSite(id=SITE, name="Harbor View", latitude="33.12", longitude="-117.32"))
        self.db.add(models.ShiftGroup(id=GROUP, name="Yard Crew", work_site_id=SITE, weather_alerts=1,
                                      weather_decider_emails=json.dumps([MGR]), teams_chat_id="chat-1", created_by=BOSS))
        for i, em in enumerate((ANN, BOB, CAL)):
            self.db.add(models.ShiftGroupMember(id=f"m{i}", group_id=GROUP, employee_email=em))
            self.db.add(models.ScheduledShift(id=f"s-{em}", employee_email=em, work_date=DAY, start_hhmm="07:00", end_hhmm="15:30",
                                              label="Harbor", published=1, group_id=GROUP, created_by=BOSS))
        self.db.add(models.ScheduledShift(id="s-open", employee_email="", work_date=DAY, start_hhmm="07:00", end_hhmm="15:30",
                                          published=1, open_slots=2, group_id=GROUP, created_by=BOSS))
        self.db.add(models.NexusPersonPref(email=BOB, weather_sms=0))
        self.db.add(models.WeatherOutlook(id=f"{GROUP}:{DAY}", group_id=GROUP, work_date=DAY, band="major", chance=85, inches=0.9,
                                          window_start="7:00 AM", window_end="3:30 PM", hourly_json="[]", shifts=4, people=3))
        self.db.commit()
        weather_watch.save_config(self.db, {"companies": {ENT: True}}, BOSS)
        self.sms = mock.patch.object(weather_call, "_send_sms", return_value=(True, ""))
        self.mail = mock.patch.object(weather_call, "_send_email", return_value="ok")
        self.dm = mock.patch.object(weather_call, "_teams_dm", return_value="ok")
        self.grp = mock.patch.object(weather_call, "_teams_group", return_value="ok")
        for p in (self.sms, self.mail, self.dm, self.grp):
            p.start()
            self.addCleanup(p.stop)
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()
        self._as(MGR)

    def tearDown(self):
        self.db.rollback()
        self.db.close()
        auth.SKIP_AUTH = self._skip
        auth.invalidate_role_cache()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _shift(self, sid):
        self.db.expire_all()
        return self.db.query(models.ScheduledShift).filter(models.ScheduledShift.id == sid).first()

    def _bells(self, em):
        self.db.expire_all()
        return self.db.query(models.NexusNotification).filter(models.NexusNotification.recipient == em).all()

    def _decision(self):
        self.db.expire_all()
        return self.db.query(models.WeatherDecision).order_by(models.WeatherDecision.decided_at.desc()).first()

    def _call(self, body, who=MGR):
        self._as(who)
        return self.client.post(f"/weather-call/{GROUP}/{DAY}", json=body)

    def _cancel(self, emails=(ANN, CAL), **extra):
        r = self._call({"kind": "cancel", "emails": list(emails), "reason": "Flooded access road", **extra})
        self.assertEqual(r.status_code, 200, r.text)
        return self._fresh(r.json())

    def _fresh(self, j):
        """The response says what was QUEUED (Oct 12: the texts, email and
        Teams go in a background task after it); TestClient has run that
        task by the time it returns, so the roster's results are read back."""
        self.db.expire_all()
        d = self.db.query(models.WeatherDecision).filter(models.WeatherDecision.id == j["id"]).first()
        return {**weather_call.decision_dict(self.db, d), "queued": j.get("queued")}

    def test_the_screen(self):
        r = self.client.get(f"/weather-call/{GROUP}/{DAY}")
        self.assertEqual(r.status_code, 200, r.text)
        j = r.json()
        self.assertEqual((j["group"]["name"], j["group"]["workSiteName"], j["outlook"]["band"], j["canDecide"], j["smsDefault"]),
                         ("Yard Crew", "Harbor View", "major", True, True))
        names = [p["name"] for p in j["roster"]]
        self.assertEqual(names, ["Ann X", "Bob X", "Cal X", "Open shifts"])
        by = {p["email"]: p for p in j["roster"]}
        self.assertEqual((by[ANN]["phone"], by[ANN]["smsOn"], by[ANN]["phoneNumber"]), (True, True, "(949) 555-0101"))
        self.assertEqual((by[BOB]["phone"], by[BOB]["smsOn"]), (True, False))
        self.assertEqual((by[CAL]["phone"], by[CAL]["smsOn"]), (False, True))
        self.assertIsNone(j["decision"])
        self.assertEqual(by[ANN]["phoneNumber"], "(949) 555-0101", "the decider sees the numbers")
        self._as(OTHER)
        j = self.client.get(f"/weather-call/{GROUP}/{DAY}").json()
        self.assertFalse(j["canDecide"])
        self.assertEqual((j["roster"], j["decision"], j["group"]["deciders"][0]["name"]), ([], None, "Mia X"), "no roster, no numbers")

    def test_cancel_for_some_tells_everyone_the_right_thing(self):
        j = self._cancel()
        self.assertEqual((j["kind"], j["outcome"], j["unpaid"], j["selectedCount"], j["pendingCount"]), ("cancel", "cancelled", True, 2, 2))
        # The picked people's shifts are cancelled in place with their originals kept; Bob's is untouched; the open slot follows.
        for em in (ANN, CAL):
            s = self._shift(f"s-{em}")
            self.assertEqual((s.weather_status, s.original_start_hhmm, s.original_end_hhmm, s.weather_decision_id), ("cancelled", "07:00", "15:30", j["id"]))
        self.assertEqual(self._shift(f"s-{BOB}").weather_status, "")
        self.assertEqual(self._shift("s-open").weather_status, "cancelled")
        by = {p["email"]: p for p in j["people"]}
        self.assertEqual((by[ANN]["selected"], by[ANN]["outcome"]), (True, "cancelled"))
        self.assertEqual((by[BOB]["selected"], by[BOB]["outcome"]), (False, "kept"))
        self.assertEqual(by[ANN]["channels"], {"bell": "ok", "sms": "ok", "email": "ok", "teams": "ok", "groupChat": "ok"})
        self.assertEqual(by[CAL]["channels"]["sms"], "no phone on file")
        self.assertEqual(by[BOB]["channels"], {"bell": "ok", "groupChat": "ok"})
        # Bells: priority for the affected, quiet for the kept, nothing for the decider.
        self.assertEqual([(b.priority, b.title) for b in self._bells(ANN)], [(1, "Weather Call: Day Canceled for Weather (Unpaid)")])
        self.assertEqual([(b.priority, b.title) for b in self._bells(BOB)], [(0, "Weather Call: Your Shift Stands")])
        self.assertEqual(self._bells(MGR), [])
        # Texts: Ann only (Cal has no phone, Bob was not picked); the text names the shift and carries the link.
        self.assertEqual(weather_call._send_sms.call_count, 1)
        text = weather_call._send_sms.call_args[0][1]
        self.assertIn("Greens: Yard Crew -", text)
        self.assertIn("at Harbor View. Your shift (7:00 AM) is CANCELED for weather (unpaid). Reason: Flooded access road. Acknowledge: http", text)
        self.assertEqual(weather_call._send_email.call_count, 2)
        self.assertEqual(weather_call._teams_dm.call_count, 2)
        self.assertEqual(weather_call._teams_group.call_count, 1)
        self.assertIn("for 2 people", weather_call._teams_group.call_args[0][3])
        # The day note is the call, and the schedule shows the cancelled shift with no paid time.
        note = self.db.query(models.ScheduleDayNote).filter(models.ScheduleDayNote.group_id == GROUP).first()
        self.assertTrue(note.note.startswith("Weather call: Day Canceled for Weather (Unpaid) for 2 of 3 - Mia X. Flooded access road"), note.note)
        self._as(BOSS)
        r = self.client.get("/timeclock/schedule", params={"start": DAY, "end": DAY})
        sched = {s["id"]: s for s in r.json()["scheduled"]}
        self.assertEqual((sched[f"s-{ANN}"]["weatherStatus"], sched[f"s-{ANN}"]["paidMin"]), ("cancelled", 0))
        self.assertEqual((sched[f"s-{BOB}"]["weatherStatus"], sched[f"s-{BOB}"]["paidMin"]), ("", 510))
        # The screen now shows the decision.
        self._as(MGR)
        self.assertEqual(self.client.get(f"/weather-call/{GROUP}/{DAY}").json()["decision"]["id"], j["id"])

    def test_texts_respect_the_persons_switch(self):
        j = self._cancel(emails=(BOB,))
        self.assertEqual({p["email"]: p for p in j["people"]}[BOB]["channels"]["sms"], "turned off by the person")
        weather_call._send_sms.assert_not_called()
        # ...and the call's own switch.
        self.db.query(models.WeatherDecision).delete()
        self.db.commit()
        j = self._cancel(emails=(ANN,), sms=False)
        self.assertEqual({p["email"]: p for p in j["people"]}[ANN]["channels"]["sms"], "off for this call")

    def test_delay_and_end_early_keep_the_original_times(self):
        r = self._call({"kind": "delay", "emails": [ANN], "new_start": "10:00", "reason": "Rain until mid-morning"})
        self.assertEqual(r.status_code, 200, r.text)
        s = self._shift(f"s-{ANN}")
        self.assertEqual((s.start_hhmm, s.end_hhmm, s.original_start_hhmm, s.weather_status), ("10:00", "15:30", "07:00", "delayed"))
        self.assertIn("starts at 10:00 AM instead of 7:00 AM", weather_call._send_sms.call_args[0][1])
        # A delay past the end of the shift is a cancellation, and says so.
        # The earlier call is superseded, and Ann - not picked this time -
        # gets her 7:00 AM back rather than staying delayed under a call
        # nobody can reinstate.
        r = self._call({"kind": "delay", "emails": [CAL], "new_start": "16:00", "reason": "All day"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._shift(f"s-{CAL}").weather_status, "cancelled")
        s = self._shift(f"s-{ANN}")
        self.assertEqual((s.start_hhmm, s.weather_status, s.weather_decision_id), ("07:00", "", ""))
        self.assertEqual({p["email"]: p for p in r.json()["people"]}[CAL]["outcome"], "cancelled")
        self.assertIn("Weather Call: Your Shift Is Canceled (Unpaid)", [b.title for b in self._bells(CAL)])
        r = self._call({"kind": "end_early", "emails": [BOB], "new_end": "12:00", "reason": "Storm cell at noon", "sms": False})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((self._shift(f"s-{BOB}").end_hhmm, self._shift(f"s-{BOB}").weather_status), ("12:00", "shortened"))
        # An overnight shift ends early on the far side of midnight (a fresh
        # shift, not one an earlier call touched).
        row = self._shift(f"s-{BOB}")
        row.start_hhmm, row.end_hhmm = "22:00", "04:00"
        row.weather_status = row.weather_decision_id = row.original_start_hhmm = row.original_end_hhmm = ""
        self.db.commit()
        r = self._call({"kind": "end_early", "emails": [BOB], "new_end": "02:00", "reason": "Lightning after 2", "sms": False})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((self._shift(f"s-{BOB}").end_hhmm, self._shift(f"s-{BOB}").weather_status), ("02:00", "shortened"))
        r = self._call({"kind": "move", "emails": [ANN], "move_to": "Shop - indoor prep", "reason": "Yard is under water"})
        self.assertEqual(r.status_code, 200, r.text)
        s = self._shift(f"s-{ANN}")
        self.assertEqual((s.label, s.original_label, s.weather_status, s.original_start_hhmm), ("Shop - indoor prep", "Harbor", "moved", "07:00"))
        # Five calls on the day: the last is active, the rest superseded.
        rows = self.db.query(models.WeatherDecision).all()
        self.assertEqual(sorted(d.status for d in rows), ["active", "superseded", "superseded", "superseded", "superseded"])
        # A manager who edits and shares a weather-touched shift by hand has
        # set it: the weather status goes with the publish.
        self._as(BOSS)
        r = self.client.patch(f"/timeclock/schedule/s-{ANN}", json={"employee_email": ANN, "work_date": DAY, "start_hhmm": "08:00", "end_hhmm": "15:30", "label": "Harbor"})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.post("/timeclock/schedule/publish", json={"start_date": DAY, "end_date": DAY})
        self.assertEqual(r.status_code, 200, r.text)
        s = self._shift(f"s-{ANN}")
        self.assertEqual((s.start_hhmm, s.weather_status, s.original_start_hhmm), ("08:00", "", ""))

    def test_acknowledging_by_link_and_in_the_app(self):
        j = self._cancel()
        url = weather_call.ack_url(j["id"], ANN)
        token = url.split("t=", 1)[1]
        # The link (GET) only SHOWS the call - a mail scanner prefetching it
        # must not acknowledge for Ann - and offers the button.
        r = self.client.get("/weather-call/ack", params={"t": token})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("Your 7:00 AM shift is canceled (unpaid). Tap Acknowledge", r.text)
        self.assertIn('<form method="post" action="/weather-call/ack">', r.text)
        self.assertNotIn("Thanks", r.text)
        self.assertEqual(weather_call.decision_dict(self.db, self._decision())["ackedCount"], 0)
        # The button (POST) acknowledges.
        r = self.client.post("/weather-call/ack", data={"t": token})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("Thanks, Ann", r.text)
        self.assertIn("your 7:00 AM shift is canceled (unpaid)", r.text)
        d = weather_call.decision_dict(self.db, self._decision())
        ann = {p["email"]: p for p in d["people"]}[ANN]
        self.assertTrue(ann["ackAt"])
        self.assertEqual((ann["ackVia"], d["ackedCount"], d["pendingCount"]), ("link", 1, 1))
        self.assertTrue(all(b.actioned for b in self._bells(ANN)))
        r = self.client.get("/weather-call/ack", params={"t": token[:-3] + "xyz"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("This link has expired", r.text)
        self.assertNotIn("<form", r.text)
        self.assertEqual(self.client.post("/weather-call/ack", data={"t": "nope"}).status_code, 400)
        # Cal acknowledges in the app; Bob was not picked and has nothing to acknowledge.
        self._as(CAL)
        self.assertEqual(self.client.post(f"/weather-call/{j['id']}/ack").status_code, 200)
        mine = self.client.get("/weather-call/mine").json()["calls"]
        self.assertEqual((mine[0]["outcome"], mine[0]["headline"], bool(mine[0]["ackAt"])), ("cancelled", "Day Canceled for Weather (Unpaid)", True))
        self._as(BOB)
        self.assertEqual(self.client.get("/weather-call/mine").json()["calls"], [])
        self.assertEqual(weather_call.decision_dict(self.db, self._decision())["pendingCount"], 0)

    def test_silence_is_reminded_then_escalated(self):
        j = self._cancel()
        decided = datetime.fromisoformat(self._decision().decided_at)
        weather_call.acknowledge(self.db, j["id"], ANN, "app")
        # 10 minutes in: nothing yet.
        self.assertEqual(weather_call.follow_up_once(self.db, decided + timedelta(minutes=10)), {"reminded": 0, "escalated": 0})
        # 31 minutes: Cal (silent) is reminded - but has no phone, so only the bell refreshes; Ann (acknowledged) is left alone.
        weather_call._send_sms.reset_mock()
        out = weather_call.follow_up_once(self.db, decided + timedelta(minutes=31))
        self.assertEqual(out, {"reminded": 1, "escalated": 0})
        weather_call._send_sms.assert_not_called()
        cal = {p["email"]: p for p in weather_call.decision_dict(self.db, self._decision())["people"]}[CAL]
        self.assertTrue(cal["remindedAt"])
        self.assertEqual(cal["channels"]["reminder"], "no phone on file")
        self.assertEqual(weather_call.follow_up_once(self.db, decided + timedelta(minutes=40)), {"reminded": 0, "escalated": 0}, "once")
        # 61 minutes: the decider and the company manager are told who is silent, once.
        out = weather_call.follow_up_once(self.db, decided + timedelta(minutes=61))
        self.assertEqual(out, {"reminded": 0, "escalated": 1})
        for em in (MGR, BOSS):
            bells = [b for b in self._bells(em) if b.ref_id == f"weather-call-silent:{j['id']}"]
            self.assertEqual(len(bells), 1, em)
            self.assertEqual((bells[0].priority, bells[0].title), (1, "1 Person Has Not Acknowledged the Weather Call"))
            self.assertIn("Cal X", bells[0].body)
            self.assertEqual(json.loads(bells[0].action)["sub"], f"schedule:{DAY}:{GROUP}")
        self.assertEqual(weather_call.follow_up_once(self.db, decided + timedelta(minutes=90)), {"reminded": 0, "escalated": 0})
        # The manual nudge texts the silent again (Cal still has no phone).
        r = self.client.post(f"/weather-call/{j['id']}/remind")
        self.assertEqual((r.status_code, r.json()["reminded"]), (200, 1))

    def test_reinstate_puts_everything_back_and_tells_the_same_people(self):
        r = self._call({"kind": "delay", "emails": [ANN, CAL], "new_start": "10:00", "reason": "Morning rain"})
        did = r.json()["id"]
        weather_call._send_sms.reset_mock()
        r = self.client.post(f"/weather-call/{did}/reinstate")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "reinstated")
        for em in (ANN, CAL):
            s = self._shift(f"s-{em}")
            self.assertEqual((s.start_hhmm, s.weather_status, s.weather_decision_id, s.original_start_hhmm), ("07:00", "", "", ""))
        self.assertEqual(weather_call._send_sms.call_count, 1, "Ann is texted; Cal has no phone")
        self.assertIn("REVERSED", weather_call._send_sms.call_args[0][1])
        titles = [b.title for b in self._bells(ANN)]
        self.assertIn("Weather Call Reversed: Your Shift Is Back On", titles)
        note = self.db.query(models.ScheduleDayNote).filter(models.ScheduleDayNote.group_id == GROUP).first()
        self.assertTrue(note.note.startswith("Weather call reversed by Mia X"))
        self.assertEqual(self.client.post(f"/weather-call/{did}/reinstate").status_code, 409)
        self._as(ANN)
        self.assertEqual(self.client.get("/weather-call/mine").json()["calls"][0]["headline"], "Weather Call Reversed: Your Shift Is Back On")

    def test_who_may_call_it(self):
        r = self._call({"kind": "cancel", "emails": [ANN], "reason": "x"}, who=OTHER)   # a manager, but not of this group
        self.assertEqual(r.status_code, 403, r.text)
        self.assertIn("weather deciders", r.json()["detail"])
        r = self._call({"kind": "cancel", "emails": [ANN], "reason": "x"}, who=ANN)     # an employee: not a shift manager at all
        self.assertEqual(r.status_code, 403)
        r = self._call({"kind": "cancel", "emails": [ANN], "reason": "x"}, who=BOSS)    # an administrator / company manager
        self.assertEqual(r.status_code, 200, r.text)

    def test_the_call_is_checked(self):
        self.assertIn("reason", self._call({"kind": "cancel", "emails": [ANN]}).json()["detail"])
        self.assertIn("Not on this day's roster", self._call({"kind": "cancel", "emails": [MGR], "reason": "x"}).json()["detail"])
        self.assertIn("at least one person", self._call({"kind": "cancel", "emails": [], "reason": "x"}).json()["detail"])
        self.assertIn("where", self._call({"kind": "move", "emails": [ANN], "reason": "x"}).json()["detail"])
        self.assertIn("time like", self._call({"kind": "delay", "emails": [ANN], "new_start": "ten", "reason": "x"}).json()["detail"])
        self.assertEqual(self._call({"kind": "nap", "emails": [ANN], "reason": "x"}).status_code, 400)
        self.assertEqual(self.db.query(models.WeatherDecision).count(), 0, "nothing was recorded")
        # Proceed with nobody picked tells EVERYONE the plan stands.
        r = self._call({"kind": "proceed", "emails": [], "reason": "Showers clear by 6 AM"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["selectedCount"], 3)
        for em in (ANN, BOB, CAL):
            self.assertEqual(self._shift(f"s-{em}").weather_status, "kept")
            self.assertEqual(self._bells(em)[0].title, "Weather Call: Your Shift Goes Ahead")

    def test_an_acknowledgment_that_lands_while_the_crew_is_being_told_is_kept(self):
        # Sending takes seconds per person. Ann taps the link in her text
        # while Cal's email is still going out: her acknowledgment must not be
        # written over by the roster the sender started from.
        decision_id = {}

        def email_then_ack(to, subject, html):
            if to == CAL and decision_id:
                weather_call.acknowledge(self.db, decision_id["id"], ANN, "link")
            return "ok"
        weather_call._send_email.side_effect = email_then_ack
        self.db.flush()
        # The id is only known once the row exists: read it from the first text.
        def sms_capture(phone, text):
            did = self.db.query(models.WeatherDecision).order_by(models.WeatherDecision.decided_at.desc()).first()
            decision_id["id"] = did.id
            return True, ""
        weather_call._send_sms.side_effect = sms_capture
        j = self._cancel(emails=(ANN, CAL))
        ann = {p["email"]: p for p in j["people"]}[ANN]
        self.assertTrue(ann["ackAt"], "Ann's acknowledgment survived the send")
        self.assertEqual(ann["channels"]["sms"], "ok", "...and her channel results were still recorded")
        self.assertEqual((j["ackedCount"], j["pendingCount"]), (1, 1))

    def test_the_sends_leave_the_request(self):
        # Oct 12: the request changes the shifts, records the call and rings
        # the bells, and answers with what was QUEUED; texts, email and Teams
        # go in a background task after the response.
        r = self._call({"kind": "cancel", "emails": [ANN, CAL], "reason": "Flooded access road"})
        self.assertEqual(r.status_code, 200, r.text)
        j = r.json()
        self.assertEqual(j["queued"], {"people": 2, "texts": 1, "emails": 2, "teams": 2})
        by = {p["email"]: p for p in j["people"]}
        self.assertEqual(by[ANN]["channels"], {"bell": "ok"}, "the response did not wait for the sends")
        # ...which then landed in the roster.
        by = {p["email"]: p for p in self._fresh(j)["people"]}
        self.assertEqual(by[ANN]["channels"], {"bell": "ok", "sms": "ok", "email": "ok", "teams": "ok", "groupChat": "ok"})
        self.assertEqual(weather_call._send_sms.call_count, 1)
        # Remind and Reinstate answer the same way.
        r = self.client.post(f"/weather-call/{j['id']}/remind")
        self.assertEqual((r.status_code, r.json()["reminded"]), (200, 2))
        cal = {p["email"]: p for p in self._fresh(j)["people"]}[CAL]
        self.assertEqual(cal["channels"]["reminder"], "no phone on file")
        r = self.client.post(f"/weather-call/{j['id']}/reinstate")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["queued"]["people"], 2)
        ann = {p["email"]: p for p in self._fresh(j)["people"]}[ANN]
        self.assertEqual(ann["reinstateChannels"], {"bell": "ok", "sms": "ok", "email": "ok"})

    def test_a_delay_never_moves_a_later_start_earlier(self):
        # Staggered starts: Cal starts at 11:00. "Delay to 10:00" delays Ann
        # (7:00) and leaves Cal alone - it must not move her EARLIER.
        row = self._shift(f"s-{CAL}")
        row.start_hhmm = "11:00"
        self.db.commit()
        j = self._fresh(self._call({"kind": "delay", "emails": [ANN, CAL], "new_start": "10:00", "reason": "Morning rain"}).json())
        self.assertEqual((self._shift(f"s-{ANN}").start_hhmm, self._shift(f"s-{ANN}").weather_status), ("10:00", "delayed"))
        self.assertEqual((self._shift(f"s-{CAL}").start_hhmm, self._shift(f"s-{CAL}").weather_status), ("11:00", "kept"))
        by = {p["email"]: p for p in j["people"]}
        self.assertEqual((by[ANN]["outcome"], by[CAL]["outcome"]), ("delayed", "kept"))
        self.assertEqual([b.title for b in self._bells(CAL)], ["Weather Call: Your Shift Goes Ahead"])
        # End early after a shift's own end leaves it alone too.
        row = self._shift(f"s-{BOB}")
        row.end_hhmm = "11:30"
        self.db.commit()
        self._call({"kind": "end_early", "emails": [BOB, ANN], "new_end": "12:00", "reason": "Storm at noon"})
        self.assertEqual((self._shift(f"s-{BOB}").end_hhmm, self._shift(f"s-{BOB}").weather_status), ("11:30", "kept"))
        self.assertEqual((self._shift(f"s-{ANN}").end_hhmm, self._shift(f"s-{ANN}").weather_status), ("12:00", "shortened"))

    def test_an_overnight_shift_delayed_past_midnight_moves_to_the_next_day(self):
        nxt = (datetime.strptime(DAY, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
        row = self._shift(f"s-{ANN}")
        row.start_hhmm, row.end_hhmm = "22:00", "04:00"
        self.db.commit()
        j = self._fresh(self._call({"kind": "delay", "emails": [ANN], "new_start": "01:00", "reason": "Storm until 1"}).json())
        s = self._shift(f"s-{ANN}")
        self.assertEqual((s.work_date, s.start_hhmm, s.end_hhmm, s.weather_status, s.original_work_date, s.original_start_hhmm),
                         (nxt, "01:00", "04:00", "delayed", DAY, "22:00"))
        self.assertIn("starts at 1:00 AM on", weather_call._send_sms.call_args[0][1])
        self.assertEqual({p["email"]: p for p in j["people"]}[ANN]["outcome"], "delayed")
        # A later call on the day still finds her shift, and starts from the original.
        self._call({"kind": "delay", "emails": [ANN], "new_start": "23:00", "reason": "Storm until 11"})
        s = self._shift(f"s-{ANN}")
        self.assertEqual((s.work_date, s.start_hhmm, s.original_work_date), (DAY, "23:00", ""))
        # Reinstate puts it back on its own day.
        self._call({"kind": "delay", "emails": [ANN], "new_start": "02:00", "reason": "Later still"})
        self.assertEqual(self._shift(f"s-{ANN}").work_date, nxt)
        self.client.post(f"/weather-call/{self._decision().id}/reinstate")
        s = self._shift(f"s-{ANN}")
        self.assertEqual((s.work_date, s.start_hhmm, s.end_hhmm, s.weather_status, s.original_work_date), (DAY, "22:00", "04:00", "", ""))

    def test_overnight_times_count_toward_the_nearer_edge(self):
        def outcome(kind, field, value):
            row = self._shift(f"s-{ANN}")
            row.work_date, row.start_hhmm, row.end_hhmm = DAY, "22:00", "04:00"
            row.weather_status = row.weather_decision_id = row.original_start_hhmm = row.original_end_hhmm = row.original_work_date = ""
            self.db.query(models.WeatherDecision).delete()
            self.db.commit()
            r = self._call({"kind": kind, "emails": [ANN], field: value, "reason": "x", "sms": False})
            self.assertEqual(r.status_code, 200, r.text)
            s = self._shift(f"s-{ANN}")
            return s.weather_status, s.start_hhmm, s.end_hhmm
        self.assertEqual(outcome("delay", "new_start", "21:00"), ("kept", "22:00", "04:00"))       # before the start
        self.assertEqual(outcome("delay", "new_start", "05:00"), ("cancelled", "22:00", "04:00"))  # past the end
        self.assertEqual(outcome("delay", "new_start", "23:30"), ("delayed", "23:30", "04:00"))
        self.assertEqual(outcome("end_early", "new_end", "05:00"), ("kept", "22:00", "04:00"))     # after the end
        self.assertEqual(outcome("end_early", "new_end", "21:00"), ("cancelled", "22:00", "04:00"))  # before the start
        self.assertEqual(outcome("end_early", "new_end", "23:00"), ("shortened", "22:00", "23:00"))
        self.assertEqual(outcome("end_early", "new_end", "02:00"), ("shortened", "22:00", "02:00"))

    def test_a_replaced_calls_link_says_so(self):
        j = self._cancel(emails=(ANN,))
        token = weather_call.ack_url(j["id"], ANN).split("t=", 1)[1]
        self._call({"kind": "delay", "emails": [ANN], "new_start": "10:00", "reason": "Only the morning"})
        r = self.client.get("/weather-call/ack", params={"t": token})
        self.assertEqual(r.status_code, 410)
        self.assertIn("A later weather call replaced this one", r.text)
        self.assertNotIn("<form", r.text)
        self.assertEqual(self.client.post("/weather-call/ack", data={"t": token}).status_code, 410)

    def test_a_cancelled_day_is_never_late(self):
        from routers import timeclock
        day = datetime.strptime(DAY, "%Y-%m-%d").date()
        # A preset that works that weekday too - it must not stand in.
        self.db.add(models.Shift(id="p-day", name="Day", start_hhmm="07:00", end_hhmm="15:30", days=str(day.isoweekday())))
        self.db.add(models.ShiftAssignment(id="a-ann", employee_email=ANN, shift_id="p-day"))
        self.db.commit()
        self.assertIsNotNone(timeclock._shift_start_for(self.db, ANN, day))
        self._cancel(emails=(ANN,))
        self.db.expire_all()
        self.assertIsNone(timeclock._shift_start_for(self.db, ANN, day))
        self.assertIsNotNone(timeclock._shift_start_for(self.db, BOB, day), "Bob still works")
        import shift_expect
        starts = shift_expect.expected_starts(self.db, [ANN, BOB], day)
        self.assertIsNone(starts[ANN])
        self.assertIsNotNone(starts[BOB])

    def test_my_prefs(self):
        self._as(ANN)
        self.assertEqual(self.client.get("/weather-call/my-prefs").json(), {"weatherSms": True, "phone": True, "weatherOn": True})
        r = self.client.put("/weather-call/my-prefs", json={"weatherSms": False})
        self.assertEqual(r.json()["weatherSms"], False)
        self._as(CAL)
        self.assertEqual(self.client.get("/weather-call/my-prefs").json(), {"weatherSms": True, "phone": False, "weatherOn": True})
        self._as(OTHER)   # not in a weather department: My Schedule shows no texts switch
        self.assertFalse(self.client.get("/weather-call/my-prefs").json()["weatherOn"])


if __name__ == "__main__":
    unittest.main()
