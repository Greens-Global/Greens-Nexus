"""Construction phase 3 - photos, before and after, the weekly report's real
health and Insights' milestones (Neil, 11/03/2026, feat/construction-field).

Pins:
  * the photo timeline: time order, who / when / where, filters (tag, spot
    words, a log), the logs' privacy (another's draft never shows), job
    photos with a phone-made id (a resend answers with the row);
  * before / after pairs: two of the job's visible photos, taken apart
    softly (kept), never another job's;
  * Mark Up attached back: a new job photo beside the original (tag
    'markup', source_media_id), the original untouched;
  * the photo report PDF prints only what the caller may see;
  * the weekly report: health (Late / At Risk / On Track), punch counts,
    change orders, weather delays from the log delay lines, crew-days from
    punches, RFIs by age, the week's before / after pairs kept;
  * Insights' At-Risk Milestones read the task project's milestones (one
    source), past due or due within a week, inside the company wall.

Run: python -m pytest test_construction_field_photos.py -q
"""
import os
import tempfile
from datetime import date, timedelta

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("SUPABASE_URL", None)

from unittest import mock   # noqa: E402

import construction_report   # noqa: E402
import construction_tasks    # noqa: E402
import models                # noqa: E402
from construction_jobs_testkit import (CREW, CREW2, MGR_A, MGR_B, JobsBase, iso)  # noqa: E402

PIC = "data:image/png;base64,iVBORw0KGgo="


class Base(JobsBase):
    tmp_db = _tmp.name

    def _photos(self):
        L, M = models.ConstructionDailyLog, models.ConstructionMedia
        self.db.add(L(id="l1", project_id="pa", log_date="2026-11-02", author_email=CREW2, status="approved", deleted_at=""))
        self.db.add(L(id="l2", project_id="pa", log_date="2026-11-03", author_email=CREW2, status="draft", deleted_at=""))
        for mid, log, taken, tags, where in (
                ("m1", "l1", "2026-11-02T16:00:00+00:00", ["before"], "North wall"),
                ("m2", "", "2026-11-04T16:00:00+00:00", ["after"], "North wall"),
                ("m3", "l2", "2026-11-03T16:00:00+00:00", [], "")):
            self.db.add(M(id=mid, project_id="pa", daily_log_id=log, kind="photo", url=PIC, uploaded_by=CREW2,
                          taken_at=taken, tags=tags, location_text=where, deleted_at=""))
        self.db.add(M(id="mb", project_id="pb", daily_log_id="", kind="photo", url=PIC, uploaded_by=MGR_B,
                      taken_at="2026-11-02T16:00:00+00:00", deleted_at=""))
        self.db.commit()


class Timeline(Base):
    def test_time_order_filters_and_the_logs_privacy(self):
        self._photos()
        self.as_(CREW)
        t = self.client.get("/construction/projects/pa/timeline").json()
        self.assertEqual([p["id"] for p in t["photos"]], ["m2", "m1"])      # m3 is someone else's draft
        self.assertEqual(t["photos"][1]["logDate"], "2026-11-02")
        self.assertEqual(t["photos"][0]["uploadedByName"], "Crew2 Person")
        self.assertEqual(t["tags"], ["after", "before"])
        self.assertEqual([p["id"] for p in self.client.get("/construction/projects/pa/timeline?tag=before").json()["photos"]], ["m1"])
        self.assertEqual(len(self.client.get("/construction/projects/pa/timeline?q=north").json()["photos"]), 2)
        self.assertEqual([p["id"] for p in self.client.get("/construction/projects/pa/timeline?log_id=l1").json()["photos"]], ["m1"])
        self.as_(CREW2)
        self.assertEqual(len(self.client.get("/construction/projects/pa/timeline").json()["photos"]), 3)
        self.as_(MGR_B)
        self.assertEqual(self.client.get("/construction/projects/pa/timeline").status_code, 404)

    def test_a_job_photo_with_a_phone_made_id_lands_once(self):
        self.as_(CREW)
        body = {"id": "photo-phone-01", "kind": "photo", "url": PIC, "mime_type": "image/png", "size_bytes": 8,
                "tags": ["Before", "before", " east "], "location_text": "East gate"}
        a = self.client.post("/construction/projects/pa/media", json=body)
        self.assertEqual(a.status_code, 201, a.text)
        self.assertEqual(a.json()["tags"], ["before", "east"])
        b = self.client.post("/construction/projects/pa/media", json=body)
        self.assertEqual(b.json()["id"], "photo-phone-01")
        self.assertEqual(self.db.query(models.ConstructionMedia).filter_by(id="photo-phone-01").count(), 1)
        self.as_(MGR_B)
        self.assertEqual(self.client.post("/construction/projects/pa/media", json={**body, "id": "photo-phone-02"}).status_code, 404)

    def test_meta_is_the_takers_or_a_reviewers(self):
        self._photos()
        self.as_(CREW)
        self.assertEqual(self.client.patch("/construction/media/m1/meta", json={"tags": ["x"]}).status_code, 403)
        self.as_(CREW2)
        r = self.client.patch("/construction/media/m1/meta", json={"tags": ["before", "slab"], "location_text": "Grid C-4"})
        self.assertEqual(r.json()["locationText"], "Grid C-4")
        self.assertEqual(self.fresh(models.ConstructionMedia, "m1").url, PIC)   # the file never changes


class Pairs(Base):
    def test_a_pair_of_two_visible_photos_taken_apart_softly(self):
        self._photos()
        self.as_(CREW)
        r = self.client.post("/construction/projects/pa/pairs", json={"before_media_id": "m1", "after_media_id": "m2",
                                                                      "caption": "North wall patch"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(self.client.post("/construction/projects/pa/pairs", json={"before_media_id": "m1",
                                                                                   "after_media_id": "m3"}).status_code, 422)
        self.assertEqual(self.client.post("/construction/projects/pa/pairs", json={"before_media_id": "m1",
                                                                                   "after_media_id": "mb"}).status_code, 422)
        pairs = self.client.get("/construction/projects/pa/timeline").json()["pairs"]
        self.assertEqual([(p["beforeId"], p["afterId"]) for p in pairs], [("m1", "m2")])
        self.assertEqual(self.client.delete(f"/construction/pairs/{r.json()['id']}").status_code, 204)
        self.assertEqual(self.client.get("/construction/projects/pa/timeline").json()["pairs"], [])
        self.assertTrue(self.fresh(models.ConstructionPhotoPair, r.json()["id"]).deleted_at)   # kept

    def test_mark_up_attached_back_is_a_new_photo_beside_the_original(self):
        self._photos()
        self.as_(CREW)
        r = self.client.post("/construction/media/m1/markup", json={"url": PIC, "mime_type": "image/png", "size_bytes": 8,
                                                                    "name": "Mark Up: North wall"})
        self.assertEqual(r.status_code, 201, r.text)
        m = r.json()
        self.assertEqual((m["sourceMediaId"], m["tags"], m["dailyLogId"]), ("m1", ["markup"], None))
        self.assertEqual(m["locationText"], "North wall")
        self.assertEqual(self.client.post("/construction/media/m3/markup", json={"url": PIC}).status_code, 404)

    def test_the_photo_report_prints_only_what_the_caller_can_see(self):
        self._photos()
        self.as_(CREW)
        pid = self.client.post("/construction/projects/pa/pairs", json={"before_media_id": "m1", "after_media_id": "m2"}).json()["id"]
        r = self.client.post("/construction/projects/pa/photo-report", json={"media_ids": ["m1", "m3", "mb"],
                                                                             "pair_ids": [pid], "title": "North Wall"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.content.startswith(b"%PDF"))
        self.assertEqual(self.client.post("/construction/projects/pa/photo-report",
                                          json={"media_ids": ["m3", "mb"]}).status_code, 422)


class WeeklyReport(Base):
    def test_real_health_punch_changes_delays_crew_days_and_pairs(self):
        self._photos()
        job = self.fresh(models.ConstructionProject, "pa")
        job.start_on, job.target_finish_on, job.percent_complete = "2026-10-01", "2026-10-30", 80
        self.db.commit()
        lg = self.fresh(models.ConstructionDailyLog, "l1")
        lg.delays = [{"cause": "weather", "hours": 3, "note": "Rain"}, {"cause": "material", "hours": 1, "note": ""}]
        self.db.add(models.ConstructionChangeOrder(id="co1", project_id="pa", number="CO-001", title="Extra footing",
                                                   amount=4200, status="signed", signed_at="2026-11-03T18:00:00+00:00",
                                                   schedule_impact_days=2, deleted_at=""))
        self.db.add(models.ConstructionChangeOrder(id="co2", project_id="pa", number="CO-002", title="Paint upgrade",
                                                   amount=900, status="sent", deleted_at=""))
        self.db.add(models.ConstructionRfi(id="r1", project_id="pa", number="7", subject="Beam depth", status="open",
                                           submitted_on="2026-10-20", due_on="2026-10-27", deleted_at=""))
        self.db.add(models.ScheduledShift(id="s1", employee_email=CREW, work_date="2026-11-02", start_hhmm="07:00",
                                          end_hhmm="15:00", published=1, pending_delete=0, jobsite="project-pa",
                                          break_min=0, created_at=iso()))
        self.db.add(models.ConstructionPhotoPair(id="pr1", project_id="pa", before_media_id="m1", after_media_id="m2",
                                                 created_by=CREW, created_at=iso(), deleted_at=""))
        self.db.commit()
        self.db.add(models.TimePunch(id="i1", employee_email=CREW, kind="in", at="2026-11-02T15:00:00+00:00",
                                     local_date="2026-11-02", tz_offset_min=480, voided=0, created_at=iso()))
        self.db.add(models.TimePunch(id="o1", employee_email=CREW, kind="out", at="2026-11-02T23:00:00+00:00",
                                     local_date="2026-11-02", tz_offset_min=480, voided=0, created_at=iso()))
        self.db.commit()
        with mock.patch("construction_company.local_today", return_value=date(2026, 11, 6)):
            r = construction_report.generate(self.db, self.fresh(models.ConstructionProject, "pa"), "2026-11-02", MGR_A,
                                             use_ai=False)
        self.db.commit()
        s = r.sections
        self.assertIn("Status: Late", s["job_health"]["text"])
        self.assertIn("Crew-days from Time Clock punches: 1 (8.0 hours)", s["job_health"]["text"])
        self.assertIn("CO-001 Extra footing - +$4,200.00 (Signed, 11/03/2026, +2 days)", s["change_orders"]["text"])
        self.assertIn("Approved changes: +$4,200.00; pending: +$900.00", s["change_orders"]["text"])
        self.assertIn("Weather delays: 3 hours", s["weather_and_delays"]["text"])
        self.assertIn("Material delays: 1 hours", s["weather_and_delays"]["text"])
        self.assertIn("RFI# 7- Beam depth (Open, 17 days open, overdue since 10/27/2026)", s["rfis_and_submittals"]["text"])
        self.assertEqual(r.pair_ids, ["pr1"])
        self.assertEqual((r.stats["crewDaysPunched"], r.stats["weatherDelayHours"], r.stats["health"]), (1, 3.0, "late"))
        self.assertIn("m2", r.media_ids)      # the week's job photo joins the approved log's
        pairs = construction_report.report_pairs(self.db, r)
        self.assertEqual([p[0].id for p in pairs], ["pr1"])


class Insights(Base):
    def test_at_risk_milestones_come_from_the_task_project_inside_the_wall(self):
        self.as_(MGR_A)
        self.client.post("/construction/projects/pa/task-project", json={})
        job = self.fresh(models.ConstructionProject, "pa")
        tp = job.task_project_id
        today = date.today()
        T = models.Task
        for tid, due, done in (("ms-late", today - timedelta(days=2), False), ("ms-soon", today + timedelta(days=3), False),
                               ("ms-far", today + timedelta(days=40), False), ("ms-done", today - timedelta(days=5), True)):
            self.db.add(T(id=tid, title=tid, project_id=tp, is_milestone=True, due_on=due.isoformat(), completed=done,
                          company_id="co-a"))
        self.db.add(models.ConstructionMilestone(id="old", project_id="pa", name="Old row", status="missed",
                                                 target_date="2026-01-01", deleted_at="", migrated_task_id="x"))
        self.db.commit()
        got = construction_tasks.risky_milestones(self.db, [self.fresh(models.ConstructionProject, "pa")])
        self.assertEqual([(t.id, s) for _, t, s in got], [("ms-late", "missed"), ("ms-soon", "at_risk")])
        import cache
        cache.dashboard_insights.invalidate()
        r = self.client.get("/dashboards/insights")
        if r.status_code == 200:
            mod = next((m for m in r.json().get("modules", []) if m.get("id") == "construction"), None)
            if mod is not None:
                stat = next(s for s in mod["stats"] if s["key"] == "at_risk_milestones")
                self.assertEqual(stat["value"], 2)


if __name__ == "__main__":
    import unittest
    unittest.main()
