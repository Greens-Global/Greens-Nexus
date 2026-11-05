"""Construction phase 3 - the self-drafting daily log (Neil, 11/03/2026,
plan https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr, feat/construction-field).

Pins:
  * prefill: weather from the jobsite's forecast (with the reading now), crew
    and hours from the day's punches at the jobsite (totals for the crew,
    names and hours for a reviewer - never pay), the day's photos (the logs'
    privacy), punch items Done / Verified that day, form entries filed to the
    job that day, a Weather Call delay line suggested;
  * a new log is drafted from it (never over what the person sent) and keeps
    `prefill` as the record; a log started offline keeps the phone's;
  * delay lines: cleaned, a delay puts the Delay (and Weather) tag on;
  * Submit carries the typed-name signature; a resend with the same
    Idempotency-Key answers once; a phone-made log id is the log's id;
  * the morning reminder: one bell to the superintendent (else the managers)
    when yesterday was worked and has no log, updated in place day to day,
    none for a weather-cancelled day or a day with a log, closed when the log
    is filed;
  * walls: another company's job is a 404.

Run: python -m pytest test_construction_field_log.py -q
"""
import os
import tempfile
from datetime import datetime, timezone
from unittest import mock

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("SUPABASE_URL", None)

import construction_field   # noqa: E402
import models               # noqa: E402
from construction_jobs_testkit import (CREW, CREW2, MGR_A, MGR_A2, MGR_B, JobsBase, iso)  # noqa: E402

DAY = "2026-11-02"   # a Monday; PST is UTC-8
PIC = "data:image/png;base64,iVBORw0KGgo="
FC = {"timezone": "America/Los_Angeles", "units": {"temp": "°F", "wind": "mph"},
      "current": {"temp": 64.0},
      "daily": [{"date": DAY, "code": 2, "high": 71.2, "low": 52.0, "precipChance": 30, "precipSum": 0.0,
                 "windMax": 9}],
      "hourly": []}


class Base(JobsBase):
    tmp_db = _tmp.name

    def _shift(self, sid, email, day=DAY, **kw):
        self.db.add(models.ScheduledShift(id=sid, employee_email=email, work_date=day, start_hhmm=kw.pop("start", "07:00"),
                                          end_hhmm=kw.pop("end", "15:00"), published=1, pending_delete=0,
                                          jobsite="project-pa", break_min=0, created_at=iso(), **kw))

    def _punch(self, pid, email, kind, at, day=DAY):
        self.db.add(models.TimePunch(id=pid, employee_email=email, kind=kind, at=at, local_date=day,
                                     tz_offset_min=480, category="", voided=0, created_at=iso()))

    def _worked_day(self):
        self._shift("s1", CREW)
        self._shift("s2", CREW2)
        self.db.commit()
        self._punch("i1", CREW, "in", "2026-11-02T15:00:00+00:00")
        self._punch("o1", CREW, "out", "2026-11-02T23:00:00+00:00")
        self._punch("i2", CREW2, "in", "2026-11-02T15:00:00+00:00")
        self._punch("o2", CREW2, "out", "2026-11-02T19:00:00+00:00")
        self.db.commit()


class Prefill(Base):
    def test_crew_and_hours_from_the_punches_totals_for_crew_names_for_a_reviewer(self):
        self._worked_day()
        self.as_(CREW)
        r = self.client.get(f"/construction/projects/pa/logs/prefill?date={DAY}")
        self.assertEqual(r.status_code, 200, r.text)
        crew = r.json()["crew"]
        self.assertEqual((crew["count"], crew["hours"]), (2, 12.0))
        self.assertNotIn("people", crew)            # a crew member sees totals only
        self.as_(MGR_A)
        crew = self.client.get(f"/construction/projects/pa/logs/prefill?date={DAY}").json()["crew"]
        self.assertEqual({p["email"]: p["hours"] for p in crew["people"]}, {CREW: 8.0, CREW2: 4.0})
        text = str(crew).lower()
        for w in ("rate", "pay", "wage", "cost"):
            self.assertNotIn(w, text)

    def test_weather_from_the_jobsite_forecast_with_the_reading_now(self):
        job = self.fresh(models.ConstructionProject, "pa")
        job.latitude, job.longitude = 33.5, -117.1
        self.db.commit()
        self.as_(CREW)
        with mock.patch("routers.weather.forecast_for", return_value=FC), \
                mock.patch("construction_company.local_today", return_value=datetime(2026, 11, 2).date()):
            w = self.client.get(f"/construction/projects/pa/logs/prefill?date={DAY}").json()["weather"]
        self.assertIn("Partly Cloudy", w["text"])
        self.assertIn("high 71°F / low 52°F", w["text"])
        self.assertIn("30% chance of rain", w["text"])
        self.assertEqual(w["temperatureF"], 64.0)
        self.assertEqual(w["source"], "forecast")

    def test_photos_punch_and_forms_of_the_day(self):
        L, M = models.ConstructionDailyLog, models.ConstructionMedia
        self.db.add(L(id="l1", project_id="pa", log_date=DAY, author_email=CREW2, status="submitted", deleted_at=""))
        self.db.add(L(id="l2", project_id="pa", log_date=DAY, author_email=CREW2, status="draft", deleted_at=""))
        self.db.add(M(id="m1", project_id="pa", daily_log_id="l1", kind="photo", url=PIC, uploaded_by=CREW2,
                      taken_at="2026-11-02T18:00:00+00:00", deleted_at=""))
        self.db.add(M(id="m2", project_id="pa", daily_log_id="l2", kind="photo", url=PIC, uploaded_by=CREW2,
                      taken_at="2026-11-02T18:00:00+00:00", deleted_at=""))       # someone else's draft
        self.db.add(M(id="m3", project_id="pa", daily_log_id="", kind="photo", url=PIC, uploaded_by=CREW2,
                      taken_at="2026-11-03T07:30:00+00:00", deleted_at=""))       # 11/02 11:30 PM local
        self.db.add(M(id="m4", project_id="pa", daily_log_id="", kind="photo", url=PIC, uploaded_by=CREW2,
                      taken_at="2026-11-03T09:00:00+00:00", deleted_at=""))       # 11/03 local - not today
        self.db.add(models.DocFormEntry(id="f1", template_id="t", title="Toolbox Talk", entry_key="k1",
                                        submitted_by=CREW, submitted_at="2026-11-02T16:00:00+00:00",
                                        linked_project_id="pa", deleted_at=""))
        self.db.commit()
        self.as_(MGR_A)
        self.client.post("/construction/projects/pa/punch", json={"id": "punch-01", "title": "Patch drywall",
                                                                  "location_text": "Unit 4 hallway"})
        r = self.client.post("/construction/punch/punch-01/done", json={"done": True, "photo": {
            "url": PIC, "mime_type": "image/png", "size_bytes": 8}})
        self.assertEqual(r.status_code, 200, r.text)
        self.as_(CREW)
        meta = self.fresh(models.ConstructionPunchMeta, "punch-01")
        day = construction_field.local_day_of(meta.done_at, construction_field._zone(self.db, self.fresh(models.ConstructionProject, "pa")))
        pre = self.client.get(f"/construction/projects/pa/logs/prefill?date={DAY}").json()
        self.assertEqual(sorted(p["id"] for p in pre["photos"]), ["m1", "m3"])
        self.assertEqual([f["title"] for f in pre["forms"]], ["Toolbox Talk"])
        # Review M5: the Forms reach rule - another crew member's entry is not theirs to see.
        self.as_(CREW2)
        self.assertEqual(self.client.get(f"/construction/projects/pa/logs/prefill?date={DAY}").json()["forms"], [])
        self.as_(CREW)
        pre_done = self.client.get(f"/construction/projects/pa/logs/prefill?date={day}").json()
        self.assertEqual([x["id"] for x in pre_done["punch"]["done"]], ["punch-01"])
        self.assertEqual(pre_done["punch"]["done"][0]["location"], "Unit 4 hallway")

    def test_a_weather_call_suggests_a_delay_line(self):
        self._shift("s1", CREW, original_start_hhmm="07:00", original_end_hhmm="15:00", weather_status="delayed",
                    start="10:00")
        self.db.commit()
        self.as_(CREW)
        pre = self.client.get(f"/construction/projects/pa/logs/prefill?date={DAY}").json()
        self.assertEqual(pre["suggestedDelays"], [{"cause": "weather", "hours": 3.0,
                                                   "note": "Weather Call: shifts delayed."}])

    def test_another_company_never_reads_it(self):
        self.as_(MGR_B)
        self.assertEqual(self.client.get(f"/construction/projects/pa/logs/prefill?date={DAY}").status_code, 404)


class DraftAndSubmit(Base):
    def test_a_new_log_drafts_itself_and_keeps_where_it_came_from(self):
        self._worked_day()
        self.as_(CREW)
        r = self.client.post("/construction/projects/pa/logs", json={"log_date": DAY})
        self.assertEqual(r.status_code, 201, r.text)
        lg = r.json()
        self.assertEqual((lg["crewSize"], lg["hoursWorked"]), (2, 12.0))
        self.assertEqual(lg["prefill"]["crew"], {"count": 2, "hours": 12.0})

    def test_what_the_person_sent_wins_and_an_offline_start_keeps_the_phones_draft(self):
        self._worked_day()
        self.as_(CREW)
        r = self.client.post("/construction/projects/pa/logs", json={
            "id": "log-phone-0001", "log_date": DAY, "crew_size": 5, "hours_worked": 30,
            "prefill": {"crew": {"count": 2, "hours": 12}}}, headers={"Idempotency-Key": "log-phone-0001"})
        self.assertEqual(r.status_code, 201, r.text)
        lg = r.json()
        self.assertEqual((lg["id"], lg["crewSize"], lg["hoursWorked"]), ("log-phone-0001", 5, 30.0))
        self.assertEqual(lg["prefill"]["from"], "phone")
        again = self.client.post("/construction/projects/pa/logs", json={"id": "log-phone-0001", "log_date": DAY})
        self.assertEqual(again.json()["id"], "log-phone-0001")      # the key expired: the id answers
        self.as_(CREW2)
        taken = self.client.post("/construction/projects/pa/logs", json={"id": "log-phone-0001", "log_date": DAY})
        self.assertEqual(taken.status_code, 409)

    def test_subs_on_site_are_kept_and_summed_and_bad_lines_refused(self):
        """Round Two (11/05/2026): one line per subcontractor on site."""
        import construction_field
        self.as_(CREW)
        lg = self.client.post("/construction/projects/pa/logs", json={"log_date": DAY}).json()
        self.assertEqual(self.client.patch(f"/construction/logs/{lg['id']}", json={"subs": [{"name": "", "headcount": 3}]}).status_code, 422)
        ok = self.client.patch(f"/construction/logs/{lg['id']}", json={"subs": [
            {"name": "Acme Electric", "headcount": 3, "hours": 24}, {"name": " Valley Plumbing ", "headcount": "2", "hours": "15.5"}]})
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(ok.json()["subs"], [{"name": "Acme Electric", "headcount": 3, "hours": 24.0},
                                             {"name": "Valley Plumbing", "headcount": 2, "hours": 15.5}])
        self.assertEqual(construction_field.sub_summary([self.fresh(models.ConstructionDailyLog, lg["id"])]),
                         {"crewDays": 5, "hours": 39.5, "byName": {"Acme Electric": 24.0, "Valley Plumbing": 15.5}})

    def test_delay_lines_tag_the_day_and_bad_ones_are_refused(self):
        self.as_(CREW)
        lg = self.client.post("/construction/projects/pa/logs", json={"log_date": DAY}).json()
        bad = self.client.patch(f"/construction/logs/{lg['id']}", json={"delays": [{"cause": "aliens", "hours": 2}]})
        self.assertEqual(bad.status_code, 422)
        too = self.client.patch(f"/construction/logs/{lg['id']}", json={"delays": [{"cause": "weather", "hours": 30}]})
        self.assertEqual(too.status_code, 422)
        ok = self.client.patch(f"/construction/logs/{lg['id']}", json={
            "delays": [{"cause": "weather", "hours": 2.5, "note": "Rain at 10 AM"}, {"cause": "inspection", "hours": 1}],
            "tags": ["safety"]})
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(ok.json()["tags"], ["delay", "safety", "weather"])
        self.assertEqual(len(ok.json()["delays"]), 2)
        s = construction_field.delay_summary([self.fresh(models.ConstructionDailyLog, lg["id"])])
        self.assertEqual((s["total"], s["weather"]), (3.5, 2.5))

    def test_submit_carries_the_typed_signature_and_answers_a_resend_once(self):
        self.as_(CREW)
        lg = self.client.post("/construction/projects/pa/logs", json={"log_date": DAY, "notes_raw": "Framed east wall"}).json()
        h = {"Idempotency-Key": "submit-key-0001"}
        a = self.client.post(f"/construction/logs/{lg['id']}/submit", json={"signed_name": "Crew  Person"}, headers=h)
        self.assertEqual(a.status_code, 200, a.text)
        self.assertEqual(a.json()["signedName"], "Crew Person")
        self.assertTrue(a.json()["signedAt"])
        b = self.client.post(f"/construction/logs/{lg['id']}/submit", json={"signed_name": "Crew  Person"}, headers=h)
        self.assertEqual(b.status_code, 200)
        self.assertEqual(b.headers.get("Idempotent-Replay"), "true")
        c = self.client.post(f"/construction/logs/{lg['id']}/submit", json={"signed_name": "Crew Person"})
        self.assertEqual(c.status_code, 409)       # no key: judged again - already submitted


class Reminder(Base):
    NOW = datetime(2026, 11, 3, 16, 0, tzinfo=timezone.utc)     # 8 AM jobsite time, the day after

    def _bells(self):
        self.db.expire_all()
        return self.db.query(models.NexusNotification).filter(models.NexusNotification.type == "construction_log_missing").all()

    def test_one_bell_to_the_superintendent_when_yesterday_has_no_log(self):
        job = self.fresh(models.ConstructionProject, "pa")
        job.superintendent_email = MGR_A2
        self.db.commit()
        self._worked_day()
        self.assertEqual(construction_field.reminder_tick(self.db, now=self.NOW), 1)
        self.assertEqual(construction_field.reminder_tick(self.db, now=self.NOW), 0)      # once a day
        bells = self._bells()
        self.assertEqual([b.recipient for b in bells], [MGR_A2])
        self.assertIn("11/02/2026", bells[0].body)

    def test_too_early_no_worked_day_or_a_log_means_no_bell(self):
        early = datetime(2026, 11, 3, 13, 0, tzinfo=timezone.utc)   # 5 AM local
        self._worked_day()
        self.assertEqual(construction_field.reminder_tick(self.db, now=early), 0)
        self.db.add(models.ConstructionDailyLog(id="l1", project_id="pa", log_date=DAY, author_email=CREW,
                                                status="submitted", deleted_at=""))
        self.db.commit()
        self.assertEqual(construction_field.reminder_tick(self.db, now=self.NOW), 0)

    def test_a_weather_cancelled_day_is_never_asked_for(self):
        self._shift("s1", CREW, weather_status="cancelled")
        self.db.commit()
        self._punch("i1", CREW, "in", "2026-11-02T15:00:00+00:00")     # came in, sent home
        self.db.commit()
        self.assertEqual(construction_field.reminder_tick(self.db, now=self.NOW), 0)
        self.assertEqual(self._bells(), [])

    def test_the_bell_goes_to_the_managers_is_updated_in_place_and_closes_when_filed(self):
        self._worked_day()
        self._shift("s3", CREW, day="2026-11-03")
        self.db.commit()
        construction_field.reminder_tick(self.db, now=self.NOW)
        construction_field.reminder_tick(self.db, now=datetime(2026, 11, 4, 16, 0, tzinfo=timezone.utc))
        bells = self._bells()
        self.assertEqual(len(bells), 1)                       # one bell, rewritten for 11/03
        self.assertEqual(bells[0].recipient, MGR_A)
        self.assertIn("11/03/2026", bells[0].body)
        self.as_(CREW)
        lg = self.client.post("/construction/projects/pa/logs", json={"log_date": "2026-11-03", "notes_raw": "x"}).json()
        self.assertEqual(self.client.post(f"/construction/logs/{lg['id']}/submit", json={"signed_name": "C"}).status_code, 200)
        bells = self._bells()
        self.assertTrue(bells[0].actioned)
        self.assertEqual(bells[0].title, "Daily Log Filed")



class ReviewFixes(Base):
    def test_l9_one_job_failing_never_takes_another_jobs_bell(self):
        self._worked_day()
        real = construction_field.remind_one

        def flaky(db, p, now=None, marks=None):
            if p.id == "pb":
                raise RuntimeError("boom")
            return real(db, p, now=now, marks=marks)
        with mock.patch.object(construction_field, "remind_one", side_effect=flaky):
            self.assertEqual(construction_field.reminder_tick(self.db, now=Reminder.NOW), 1)
        self.db.expire_all()
        self.assertEqual(self.db.query(models.NexusNotification).filter_by(type="construction_log_missing").count(), 1)

    def test_m7_done_is_one_transaction_and_a_photo_id_is_used_once(self):
        self.as_(MGR_A)
        self.client.post("/construction/projects/pa/punch", json={"id": "punch-m7-01", "title": "Patch"})
        photo = {"id": "photo-m7-0001", "url": PIC, "mime_type": "image/png", "size_bytes": 8}
        self.assertEqual(self.client.post("/construction/punch/punch-m7-01/done",
                                          json={"done": True, "photo": {**photo, "id": "bad id!"}}).status_code, 422)
        from routers import tasks as tasks_router
        with mock.patch.object(tasks_router, "update_task", side_effect=RuntimeError("tasks down")):
            with self.assertRaises(RuntimeError):
                self.client.post("/construction/punch/punch-m7-01/done", json={"done": True, "photo": photo})
        self.db.expire_all()
        self.assertIsNone(self.db.get(models.ConstructionMedia, "photo-m7-0001"))     # nothing half-landed
        self.assertIsNone(self.db.get(models.ConstructionPunchMeta, "punch-m7-01"))
        self.assertEqual(self.client.post("/construction/punch/punch-m7-01/done", json={"done": True, "photo": photo}).status_code, 200)
        self.client.post("/construction/punch/punch-m7-01/done", json={"done": False})
        self.assertEqual(self.client.post("/construction/punch/punch-m7-01/done", json={"done": True, "photo": photo}).status_code, 200)
        self.db.expire_all()
        self.assertEqual(self.db.query(models.ConstructionMedia).filter_by(id="photo-m7-0001").count(), 1)
        self.assertEqual(self.db.get(models.ConstructionPunchMeta, "punch-m7-01").done_media_id, "photo-m7-0001")

if __name__ == "__main__":
    import unittest
    unittest.main()
